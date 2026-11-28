import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import {
  describeSync,
  LOCK_STALE_MS,
  registerSyncCommand,
  spawnReplay,
  syncAll,
  type SyncContext,
  type SyncResult,
} from '../../src/commands/sync.js';
import { loadConfig, typeRegistry } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { GhError } from '../../src/github/gh.js';
import { GAPS_FILE, type LoggedGap } from '../../src/hooks/localLog.js';
import { OUTBOX_FAILED_FILE, OUTBOX_FILE, SYNC_LOCK, type OutboxEntry } from '../../src/outbox/outbox.js';
import { StateChangedError } from '../../src/tracker/types.js';
import { FakeTracker } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const types = typeRegistry(cfg);
const NOW = '2026-06-01T00:00:00.000Z';
const OLD = '2026-05-01T00:00:00.000Z';
const MINUTE = 60_000;

let root: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sdlc-sync-'));
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
  rmSync(root, { recursive: true, force: true });
});

const cachePath = (file: string): string => join(root, '.sdlc', 'cache', file);
const writeCache = (file: string, ...lines: string[]): void => {
  mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
  writeFileSync(cachePath(file), lines.map(line => `${line}\n`).join(''));
};
const readCache = (file: string): string => (existsSync(cachePath(file)) ? readFileSync(cachePath(file), 'utf8') : '');
const jsonLines = (file: string): Record<string, unknown>[] =>
  readCache(file)
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);

const entry = (id: string, ...argv: string[]): OutboxEntry => ({ id, at: NOW, argv: argv.length > 0 ? argv : ['approve', '5'] });
const queue = (...entries: OutboxEntry[]): void => writeCache(OUTBOX_FILE, ...entries.map(e => JSON.stringify(e)));

const gap = (issue: number | undefined, text = 'edit src/a.ts', overrides: Partial<LoggedGap> = {}): LoggedGap => ({
  at: NOW,
  rule: 'no-task',
  text,
  harness: 'claude',
  blocked: false,
  ...(issue === undefined ? {} : { issue }),
  ...overrides,
});
const logGaps = (...gaps: (LoggedGap | string)[]): void =>
  writeCache(GAPS_FILE, ...gaps.map(g => (typeof g === 'string' ? g : JSON.stringify(g))));

function task(issue: number, overrides: Partial<TaskState> = {}): TaskState {
  return { ...newTask({ issue, type: types.get('feature')!, summary: `Task ${issue}`, now: OLD }), ...overrides };
}

interface Reply {
  code: number;
  stderr?: string;
}

interface Setup {
  ctx: SyncContext;
  tracker: FakeTracker;
  out: string[];
  err: string[];
  replayed: string[][];
  commandContexts: () => number;
  clock: { now: string };
}

function setup(replies: Reply[] = [], onReplay?: (argv: string[]) => Promise<void> | void): Setup {
  const tracker = new FakeTracker();
  tracker.owners = [...cfg.owners];
  const out: string[] = [];
  const err: string[] = [];
  const replayed: string[][] = [];
  const queued = [...replies];
  const clock = { now: NOW };
  let contexts = 0;
  const ctx: SyncContext = {
    repoRoot: root,
    replay: async argv => {
      replayed.push(argv);
      await onReplay?.(argv);
      const reply = queued.shift() ?? { code: 0 };
      return { code: reply.code, stderr: reply.stderr ?? '' };
    },
    makeCommandContext: async () => {
      contexts += 1;
      const commandContext: CommandContext = { tracker, cfg, now: () => NOW, out: () => undefined, repoRoot: root };
      return commandContext;
    },
    now: () => clock.now,
    out: text => out.push(text),
    err: text => err.push(text),
  };
  return { ctx, tracker, out, err, replayed, commandContexts: () => contexts, clock };
}

const stateOf = async (tracker: FakeTracker, issue: number): Promise<TaskState> => (await tracker.getTask(issue)).state;

describe('syncAll: the outbox', () => {
  it('replays the queued commands in order, each with its own argv, and empties the outbox', async () => {
    const h = setup();
    queue(entry('a', 'approve', '5'), entry('b', 'stage', 'start', '--issue', '5'), entry('c', 'task', 'checkpoint', '5'));

    const result = await syncAll(h.ctx);

    expect(h.replayed).toEqual([['approve', '5'], ['stage', 'start', '--issue', '5'], ['task', 'checkpoint', '5']]);
    expect(result).toEqual({ replayed: 3, failed: [], remaining: 0, gapsFlushed: 0, gapsDropped: 0 });
    expect(readCache(OUTBOX_FILE)).toBe('');
    expect(existsSync(cachePath(OUTBOX_FAILED_FILE))).toBe(false);
  });

  it('stops at the first command that meets an unreachable GitHub and keeps it and the rest', async () => {
    const h = setup([{ code: 0 }, { code: 75 }]);
    queue(entry('a'), entry('b'), entry('c'));

    const result = await syncAll(h.ctx);

    expect(h.replayed).toHaveLength(2);
    expect(result).toMatchObject({ replayed: 1, failed: [], remaining: 2, stopped: 'unreachable' });
    expect(jsonLines(OUTBOX_FILE).map(line => line.id)).toEqual(['b', 'c']);
  });

  it('does not record gaps once GitHub turned out to be unreachable', async () => {
    const h = setup([{ code: 75 }]);
    queue(entry('a'));
    logGaps(gap(5));
    h.tracker.seedTask(task(5));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ stopped: 'unreachable', gapsFlushed: 0 });
    expect(h.commandContexts()).toBe(0);
    expect(readCache(GAPS_FILE)).not.toBe('');
  });

  it('moves a command that failed for good to the failed file with the last line of its stderr, and goes on', async () => {
    const h = setup([{ code: 0 }, { code: 1, stderr: 'warning: something\nError: stage "publish" is not allowed\n\n' }, { code: 0 }]);
    queue(entry('a'), entry('b', 'stage', 'publish'), entry('c'));

    const result = await syncAll(h.ctx);

    expect(h.replayed).toHaveLength(3);
    expect(result).toMatchObject({
      replayed: 2,
      failed: [{ argv: ['stage', 'publish'], error: 'Error: stage "publish" is not allowed' }],
      remaining: 0,
    });
    expect(readCache(OUTBOX_FILE)).toBe('');
    const failed = jsonLines(OUTBOX_FAILED_FILE);
    expect(failed).toEqual([
      { id: 'b', at: NOW, argv: ['stage', 'publish'], failedAt: NOW, error: 'Error: stage "publish" is not allowed' },
    ]);
  });

  it('names the exit code when a failed command said nothing', async () => {
    const h = setup([{ code: 2 }]);
    queue(entry('a'));

    const result = await syncAll(h.ctx);

    expect(result.failed).toEqual([{ argv: ['approve', '5'], error: 'exit code 2' }]);
  });

  it('moves a line that is no command to the failed file as malformed, without replaying it', async () => {
    const h = setup();
    writeCache(
      OUTBOX_FILE,
      '{not json',
      JSON.stringify(entry('a')),
      JSON.stringify({ argv: ['approve', '5', 'approve'] }),
      JSON.stringify({ id: 'x', at: NOW, argv: [] }),
    );

    const result = await syncAll(h.ctx);

    expect(h.replayed).toEqual([['approve', '5']]);
    expect(result.replayed).toBe(1);
    expect(result.failed).toHaveLength(3);
    expect(result.failed.every(f => f.error === 'malformed outbox line' && f.argv.length === 0)).toBe(true);
    expect(readCache(OUTBOX_FILE)).toBe('');
    const failed = jsonLines(OUTBOX_FAILED_FILE);
    expect(failed.map(line => line.error)).toEqual(['malformed outbox line', 'malformed outbox line', 'malformed outbox line']);
    expect(failed[0]).toMatchObject({ line: '{not json', failedAt: NOW });
  });

  it('keeps a command that was queued while it ran', async () => {
    const late = entry('late', 'approve', '9');
    const h = setup([], () => {
      if (!readCache(OUTBOX_FILE).includes('late')) {
        writeFileSync(cachePath(OUTBOX_FILE), `${readCache(OUTBOX_FILE)}${JSON.stringify(late)}\n`);
      }
    });
    queue(entry('a'));

    const result = await syncAll(h.ctx);

    expect(h.replayed).toEqual([['approve', '5']]);
    expect(result).toMatchObject({ replayed: 1, remaining: 1 });
    expect(jsonLines(OUTBOX_FILE)).toEqual([late]);
  });

  it('removes a command from the outbox as soon as it ran, so a sync killed later does not run it twice', async () => {
    let seen: string[] = [];
    const h = setup([], argv => {
      if (argv[1] === '6') seen = jsonLines(OUTBOX_FILE).map(line => String(line.id));
    });
    queue(entry('a', 'approve', '5'), entry('b', 'approve', '6'));

    await syncAll(h.ctx);

    expect(seen).toEqual(['b']);
  });

  it('does nothing and reports nothing queued for an empty cache', async () => {
    const h = setup();

    const result = await syncAll(h.ctx);

    expect(result).toEqual({ replayed: 0, failed: [], remaining: 0, gapsFlushed: 0, gapsDropped: 0 });
    expect(h.replayed).toEqual([]);
    expect(h.commandContexts()).toBe(0);
  });

  it('lets a replay that cannot be run end the sync, keeps the command and gives the lock back', async () => {
    const h = setup();
    h.ctx.replay = async () => {
      throw new Error('could not run sdlc: node is gone');
    };
    queue(entry('a'));

    await expect(syncAll(h.ctx)).rejects.toThrow('node is gone');

    expect(jsonLines(OUTBOX_FILE)).toHaveLength(1);
    expect(existsSync(join(root, SYNC_LOCK))).toBe(false);
  });
});

describe('syncAll: the gaps', () => {
  it('records the gaps of a task in one gap_recorded commit, drops those without a task and empties the file', async () => {
    const h = setup();
    h.tracker.seedTask(task(5, { status: 'in_progress', phase: 'implementation', updatedAt: OLD }));
    logGaps(gap(5, 'edit a'), gap(5, 'edit b'), gap(undefined, 'edit c'), gap(5, 'edit d'));
    const write = vi.spyOn(h.tracker, 'writeState');

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 3, gapsDropped: 1, remaining: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    const state = await stateOf(h.tracker, 5);
    expect(state.gaps?.map(g => g.text)).toEqual(['edit a', 'edit b', 'edit d']);
    expect(state.gaps?.[0]).toEqual({ at: NOW, rule: 'no-task', text: 'edit a', harness: 'claude', blocked: false });
    expect(readCache(GAPS_FILE)).toBe('');
  });

  it('leaves updatedAt alone, so old gaps do not make a stale task look fresh', async () => {
    const h = setup();
    h.tracker.seedTask(task(5, { updatedAt: OLD }));
    logGaps(gap(5));

    await syncAll(h.ctx);

    expect((await stateOf(h.tracker, 5)).updatedAt).toBe(OLD);
  });

  it('records blocked gaps too, and gaps of several tasks, lowest issue first', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    h.tracker.seedTask(task(3));
    logGaps(gap(5, 'edit a', { blocked: true }), gap(3, 'edit b'));
    const order: number[] = [];
    const write = h.tracker.writeState.bind(h.tracker);
    h.tracker.writeState = async (issue, state, expected) => {
      order.push(issue);
      return write(issue, state, expected);
    };

    const result = await syncAll(h.ctx);

    expect(result.gapsFlushed).toBe(2);
    expect(order).toEqual([3, 5]);
    expect((await stateOf(h.tracker, 5)).gaps).toEqual([
      { at: NOW, rule: 'no-task', text: 'edit a', harness: 'claude', blocked: true },
    ]);
  });

  it('keeps the newest MAX_GAPS of a long log', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    const many = Array.from({ length: 25 }, (_, i) =>
      gap(5, `edit file${i}`, { at: new Date(Date.parse(NOW) + i * 1000).toISOString() }),
    );
    logGaps(...many);

    const result = await syncAll(h.ctx);

    expect(result.gapsFlushed).toBe(25);
    const gaps = (await stateOf(h.tracker, 5)).gaps ?? [];
    expect(gaps).toHaveLength(20);
    expect(gaps[0]?.text).toBe('edit file5');
    expect(gaps.at(-1)?.text).toBe('edit file24');
    expect(readCache(GAPS_FILE)).toBe('');
  });

  it('accepts gaps on a done task and on one awaiting deployment', async () => {
    const h = setup();
    h.tracker.seedTask(
      task(1, { status: 'done', phase: 'delivery', outcome: 'completed', waitingOn: 'none', updatedAt: OLD }),
      { open: false },
    );
    h.tracker.seedTask(
      task(2, {
        phase: 'delivery',
        status: 'awaiting_deployment',
        waitingOn: 'external',
        targets: ['web'],
        pendingTargets: ['web'],
        updatedAt: OLD,
      }),
    );
    logGaps(gap(1, 'edit a'), gap(2, 'edit b'));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 2, gapsDropped: 0 });
    expect((await stateOf(h.tracker, 1)).gaps).toHaveLength(1);
    expect((await stateOf(h.tracker, 2)).gaps).toHaveLength(1);
  });

  it('reads the state again and tries once more when it changed meanwhile', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    h.tracker.concurrentWriteBeforeNextWriteState(5);
    logGaps(gap(5));
    const write = vi.spyOn(h.tracker, 'writeState');

    const result = await syncAll(h.ctx);

    expect(write).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ gapsFlushed: 1 });
    expect(readCache(GAPS_FILE)).toBe('');
  });

  it('keeps the gaps for the next sync when the state keeps changing', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    h.tracker.seedTask(task(6));
    h.tracker.writeState = async issue => {
      if (issue === 5) throw new StateChangedError(5);
    };
    logGaps(gap(5), gap(6, 'edit b'));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 1, gapsDropped: 0 });
    expect(jsonLines(GAPS_FILE)).toEqual([gap(5)]);
    expect(h.err.join('\n')).toMatch(/gaps of #5, kept for the next sync/);
  });

  it('stops when GitHub is unreachable and keeps the gaps of that task and the later ones', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    h.tracker.seedTask(task(6));
    h.tracker.seedTask(task(7));
    const getTask = h.tracker.getTask.bind(h.tracker);
    h.tracker.getTask = async issue => {
      if (issue === 6) throw new GhError(['api', 'graphql'], 'dial tcp: could not resolve host: api.github.com');
      return getTask(issue);
    };
    logGaps(gap(5, 'edit a'), gap(6, 'edit b'), gap(7, 'edit c'));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 1, gapsDropped: 0, stopped: 'unreachable' });
    expect(jsonLines(GAPS_FILE).map(line => line.issue)).toEqual([6, 7]);
    expect(h.err.join('\n')).toContain('GitHub is unreachable');
  });

  it('drops the gaps of an issue that has no task, a missing issue and a task whose type is gone', async () => {
    const h = setup();
    h.tracker.issues.push({ number: 4, title: 'Plain', body: '', labels: [], open: true, onBoard: false });
    h.tracker.seedTask(task(5, { type: 'no-such-type' }));
    const getTask = h.tracker.getTask.bind(h.tracker);
    h.tracker.getTask = async issue => {
      if (issue === 6) throw new GhError(['issue', 'view', '6'], 'GraphQL: Could not resolve to an Issue with the number of 6.');
      return getTask(issue);
    };
    logGaps(gap(4), gap(5, 'edit a'), gap(5, 'edit b'), gap(6));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 0, gapsDropped: 4, remaining: 0 });
    expect(readCache(GAPS_FILE)).toBe('');
    expect(h.err.join('\n')).toMatch(/dropped 2 gap\(s\) of #5/);
  });

  it('drops lines that are no gap, and counts them as dropped', async () => {
    const h = setup();
    logGaps('{not json', JSON.stringify({ rule: 'no-task' }), gap(undefined));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 0, gapsDropped: 3 });
    expect(readCache(GAPS_FILE)).toBe('');
    expect(h.commandContexts()).toBe(0);
  });

  it('needs the config only for gaps that name a task', async () => {
    const h = setup();
    logGaps(gap(undefined));

    await syncAll(h.ctx);

    expect(h.commandContexts()).toBe(0);
  });

  it('keeps the gaps and goes on when the context cannot be made', async () => {
    const h = setup();
    h.ctx.makeCommandContext = async () => {
      throw new Error('config is broken');
    };
    logGaps(gap(5), gap(undefined));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 0, gapsDropped: 1 });
    expect(jsonLines(GAPS_FILE)).toEqual([gap(5)]);
    expect(h.err.join('\n')).toContain('config is broken');
  });

  it('keeps a gap line that was logged while the sync ran', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    const write = h.tracker.writeState.bind(h.tracker);
    h.tracker.writeState = async (issue, state, expected) => {
      writeFileSync(cachePath(GAPS_FILE), `${readCache(GAPS_FILE)}${JSON.stringify(gap(5, 'late'))}\n`);
      return write(issue, state, expected);
    };
    logGaps(gap(5, 'early'));

    const result = await syncAll(h.ctx);

    expect(result.gapsFlushed).toBe(1);
    expect(jsonLines(GAPS_FILE)).toEqual([gap(5, 'late')]);
  });
});

describe('syncAll: the lock', () => {
  const lockPath = (): string => join(root, SYNC_LOCK);
  const writeLock = (ageMs: number): void => {
    mkdirSync(dirname(lockPath()), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: 999999, at: new Date(Date.parse(NOW) - ageMs).toISOString() }));
  };

  it('holds the lock while it runs and gives it back after', async () => {
    let held: unknown;
    const h = setup([], () => {
      held = JSON.parse(readFileSync(lockPath(), 'utf8'));
    });
    queue(entry('a'));

    await syncAll(h.ctx);

    expect(held).toEqual({ pid: process.pid, at: NOW });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('does nothing when a fresh lock is held, and leaves that lock alone', async () => {
    const h = setup();
    writeLock(MINUTE);
    queue(entry('a'));
    logGaps(gap(5));

    const result = await syncAll(h.ctx);

    expect(result).toEqual({
      replayed: 0,
      failed: [],
      remaining: 1,
      gapsFlushed: 0,
      gapsDropped: 0,
      stopped: 'already_running',
    });
    expect(h.replayed).toEqual([]);
    expect(h.commandContexts()).toBe(0);
    expect(existsSync(lockPath())).toBe(true);
    expect(jsonLines(OUTBOX_FILE)).toHaveLength(1);
  });

  it('takes over a lock older than ten minutes', async () => {
    const h = setup();
    writeLock(LOCK_STALE_MS + MINUTE);
    queue(entry('a'));

    const result = await syncAll(h.ctx);

    expect(LOCK_STALE_MS).toBe(10 * MINUTE);
    expect(result).toMatchObject({ replayed: 1 });
    expect(result.stopped).toBeUndefined();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('respects a lock just under ten minutes old', async () => {
    const h = setup();
    writeLock(LOCK_STALE_MS - MINUTE);

    const result = await syncAll(h.ctx);

    expect(result.stopped).toBe('already_running');
  });

  it('judges a lock it cannot read by its file time', async () => {
    const h = setup();
    h.clock.now = new Date().toISOString();
    mkdirSync(dirname(lockPath()), { recursive: true });
    writeFileSync(lockPath(), 'not json');
    expect((await syncAll(h.ctx)).stopped).toBe('already_running');

    const old = new Date(Date.now() - LOCK_STALE_MS - MINUTE);
    utimesSync(lockPath(), old, old);
    expect((await syncAll(h.ctx)).stopped).toBeUndefined();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('lets only one of two syncs started together run', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = setup([], () => gate);
    const second = setup();
    queue(entry('a'));

    const running = syncAll(first.ctx);
    await vi.waitFor(() => expect(first.replayed).toHaveLength(1));
    const other = await syncAll(second.ctx);
    release();
    const result = await running;

    expect(other.stopped).toBe('already_running');
    expect(second.replayed).toEqual([]);
    expect(result).toMatchObject({ replayed: 1 });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('writes the time into the lock again after each command, so a long sync is not taken over', async () => {
    const h = setup([], argv => {
      if (argv[1] === '6') h.clock.now = new Date(Date.parse(NOW) + 9 * MINUTE).toISOString();
    });
    let seen: unknown;
    const inner = h.ctx.replay;
    h.ctx.replay = async argv => {
      if (argv[1] === '7') seen = JSON.parse(readFileSync(lockPath(), 'utf8'));
      return inner(argv);
    };
    queue(entry('a', 'approve', '5'), entry('b', 'approve', '6'), entry('c', 'approve', '7'));

    await syncAll(h.ctx);

    expect(seen).toEqual({ pid: process.pid, at: new Date(Date.parse(NOW) + 9 * MINUTE).toISOString() });
  });
});

describe('syncAll: --dry-run', () => {
  it('lists what a real sync would do and changes nothing, not even the lock', async () => {
    const h = setup();
    queue(entry('a', 'approve', '5'), entry('b', 'stage', 'start'));
    logGaps(gap(5), gap(5, 'edit b'), gap(9, 'edit c'), gap(undefined), '{not json');
    const outbox = readCache(OUTBOX_FILE);
    const gaps = readCache(GAPS_FILE);

    const result = await syncAll(h.ctx, { dryRun: true });

    expect(result).toEqual({
      replayed: 0,
      failed: [],
      remaining: 2,
      gapsFlushed: 0,
      gapsDropped: 0,
      plan: {
        replay: [['approve', '5'], ['stage', 'start']],
        gaps: [
          { issue: 5, count: 2 },
          { issue: 9, count: 1 },
        ],
        dropped: 2,
      },
    });
    expect(h.replayed).toEqual([]);
    expect(h.commandContexts()).toBe(0);
    expect(readCache(OUTBOX_FILE)).toBe(outbox);
    expect(readCache(GAPS_FILE)).toBe(gaps);
    expect(existsSync(join(root, SYNC_LOCK))).toBe(false);
    expect(existsSync(cachePath(OUTBOX_FAILED_FILE))).toBe(false);
  });

  it('works for an empty cache', async () => {
    const h = setup();

    const result = await syncAll(h.ctx, { dryRun: true });

    expect(result.plan).toEqual({ replay: [], gaps: [], dropped: 0 });
  });

  it('does not count a malformed outbox line as something to replay', async () => {
    const h = setup();
    writeCache(OUTBOX_FILE, '{not json', JSON.stringify(entry('a')));

    const result = await syncAll(h.ctx, { dryRun: true });

    expect(result.plan?.replay).toEqual([['approve', '5']]);
  });
});

describe('describeSync', () => {
  const base: SyncResult = { replayed: 0, failed: [], remaining: 0, gapsFlushed: 0, gapsDropped: 0 };

  it('says there is nothing to sync', () => {
    expect(describeSync(base)).toBe('Nothing to sync.');
  });

  it('says a sync is already running', () => {
    expect(describeSync({ ...base, stopped: 'already_running', remaining: 3 })).toBe('sync already running');
  });

  it('summarizes a run: replayed commands, failures, gaps, drops and what remains', () => {
    const text = describeSync({
      replayed: 2,
      failed: [
        { argv: ['stage', 'publish'], error: 'Error: no summary' },
        { argv: [], error: 'malformed outbox line' },
      ],
      remaining: 0,
      gapsFlushed: 3,
      gapsDropped: 1,
    });

    expect(text.split('\n')).toEqual([
      'Replayed 2 queued command(s).',
      'Failed: sdlc stage publish: Error: no summary (moved to .sdlc/cache/outbox-failed.jsonl)',
      'Failed: malformed outbox line: malformed outbox line (moved to .sdlc/cache/outbox-failed.jsonl)',
      'Recorded 3 gap(s) on their tasks.',
      'Dropped 1 gap(s) that could not be recorded.',
    ]);
  });

  it('says when GitHub is unreachable and how many commands remain', () => {
    const text = describeSync({ ...base, replayed: 1, remaining: 2, stopped: 'unreachable' });

    expect(text.split('\n')).toEqual([
      'Replayed 1 queued command(s).',
      'GitHub is unreachable; what is left stays queued for the next sync.',
      '2 queued command(s) remain.',
    ]);
  });

  it('lists the plan of a dry run', () => {
    const text = describeSync({
      ...base,
      remaining: 2,
      plan: { replay: [['approve', '5'], ['stage', 'start']], gaps: [{ issue: 5, count: 2 }], dropped: 1 },
    });

    expect(text.split('\n')).toEqual([
      'Would replay 2 queued command(s):',
      '  sdlc approve 5',
      '  sdlc stage start',
      'Would record 2 gap(s) on #5',
      'Would drop 1 gap line(s) that name no task or are unreadable',
    ]);
    expect(describeSync({ ...base, plan: { replay: [], gaps: [], dropped: 0 } })).toBe('Nothing to sync.');
  });
});

describe('sdlc sync', () => {
  async function run(h: Setup, ...args: string[]): Promise<void> {
    const program = new Command().exitOverride();
    registerSyncCommand(program, () => h.ctx);
    await program.parseAsync(['node', 'sdlc', 'sync', ...args]);
  }

  it('prints a summary and exits 0 after a clean sync', async () => {
    const h = setup();
    queue(entry('a'));

    await run(h);

    expect(h.out).toEqual(['Replayed 1 queued command(s).']);
    expect(process.exitCode).toBe(exitCode);
  });

  it('prints "Nothing to sync." for an empty cache', async () => {
    const h = setup();

    await run(h);

    expect(h.out).toEqual(['Nothing to sync.']);
  });

  it('prints the result as JSON with --json', async () => {
    const h = setup();
    queue(entry('a'));
    logGaps(gap(undefined));

    await run(h, '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual({ replayed: 1, failed: [], remaining: 0, gapsFlushed: 0, gapsDropped: 1 });
  });

  it('lists the plan with --dry-run and changes nothing', async () => {
    const h = setup();
    queue(entry('a'));

    await run(h, '--dry-run');

    expect(h.out[0]).toBe('Would replay 1 queued command(s):\n  sdlc approve 5');
    expect(h.replayed).toEqual([]);
    expect(jsonLines(OUTBOX_FILE)).toHaveLength(1);
  });

  it('puts the plan in the JSON of a dry run', async () => {
    const h = setup();
    queue(entry('a'));

    await run(h, '--dry-run', '--json');

    expect(JSON.parse(h.out[0] as string)).toMatchObject({ remaining: 1, plan: { replay: [['approve', '5']] } });
  });

  it('says "sync already running" and exits 0 when another sync holds the lock', async () => {
    const h = setup();
    mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
    writeFileSync(join(root, SYNC_LOCK), JSON.stringify({ pid: 1, at: NOW }));
    queue(entry('a'));

    await run(h);

    expect(h.out).toEqual(['sync already running']);
    expect(h.replayed).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
  });

  it('exits 1 when a command failed for good', async () => {
    const h = setup([{ code: 1, stderr: 'Error: nope' }]);
    queue(entry('a'));

    await run(h);

    expect(h.out[0]).toContain('Failed: sdlc approve 5: Error: nope');
    expect(process.exitCode).toBe(1);
  });

  it('exits 75 when GitHub is unreachable', async () => {
    const h = setup([{ code: 75 }]);
    queue(entry('a'));

    await run(h);

    expect(h.out[0]).toContain('GitHub is unreachable');
    expect(process.exitCode).toBe(75);
  });

  describe('when the context cannot be made', () => {
    async function runBroken(...args: string[]): Promise<{ out: string[]; err: string[] }> {
      const out: string[] = [];
      const err: string[] = [];
      const capture = (into: string[]) => (chunk: string | Uint8Array): boolean => {
        into.push(String(chunk).replace(/\n$/, ''));
        return true;
      };
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture(out));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture(err));
      try {
        const program = new Command().exitOverride();
        registerSyncCommand(program, () => {
          throw new Error('not a git repository');
        });
        await program.parseAsync(['node', 'sdlc', 'sync', ...args]);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
      return { out, err };
    }

    it('prints the error to stderr and exits 1', async () => {
      const { out, err } = await runBroken();

      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('not a git repository');
      expect(process.exitCode).toBe(1);
    });

    it('prints the error as JSON to stdout with --json', async () => {
      const { out, err } = await runBroken('--json');

      expect(err).toEqual([]);
      expect(JSON.parse(out[0] as string)).toMatchObject({ error: expect.stringContaining('not a git repository') });
      expect(process.exitCode).toBe(1);
    });
  });
});

describe('spawnReplay', () => {
  const script = (name: string, body: string): string => {
    const path = join(root, name);
    writeFileSync(path, body);
    return path;
  };
  const echo = (): string =>
    script(
      'echo.mjs',
      [
        'process.stderr.write(`env=${process.env.SDLC_NO_QUEUE} cwd=${process.cwd()} args=${process.argv.slice(2).join(",")}\\n`);',
        'process.exit(Number(process.argv[2]));',
      ].join('\n'),
    );

  it('runs the program with the arguments, in the directory, with queueing turned off', async () => {
    const result = await spawnReplay(echo(), root)(['0', 'x']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`env=1 cwd=${realpathSync(root)} args=0,x\n`);
  });

  it('turns queueing off even when the environment turned it on or off', async () => {
    const before = process.env.SDLC_NO_QUEUE;
    process.env.SDLC_NO_QUEUE = '0';
    try {
      const result = await spawnReplay(echo(), root)(['0']);
      expect(result.stderr).toContain('env=1');
    } finally {
      if (before === undefined) delete process.env.SDLC_NO_QUEUE;
      else process.env.SDLC_NO_QUEUE = before;
    }
  });

  it.each([1, 3, 75])('hands the exit code %i back with the stderr', async code => {
    const result = await spawnReplay(echo(), root)([String(code)]);

    expect(result.code).toBe(code);
    expect(result.stderr).toContain(`args=${code}`);
  });

  it('treats a program that does not finish in time as GitHub being unreachable', async () => {
    const hang = script('hang.mjs', 'setTimeout(() => undefined, 60_000);\n');

    const result = await spawnReplay(hang, root, 200)([]);

    expect(result.code).toBe(75);
    expect(result.stderr).toContain('SIGTERM');
  });

  it('rejects when the process cannot be started at all', async () => {
    await expect(spawnReplay(echo(), join(root, 'missing'))(['0'])).rejects.toThrow(/could not run sdlc 0/);
  });

  it('gives a program that does not exist as exit code 1, as node does', async () => {
    const result = await spawnReplay(join(root, 'nope.mjs'), root)([]);

    expect(result.code).toBe(1);
  });
});
