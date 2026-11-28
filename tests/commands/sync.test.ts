import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import {
  acquireLock,
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
import { GAPS_SYNCING_FILE, OUTBOX_FAILED_FILE, OUTBOX_FILE, SYNC_LOCK, type OutboxEntry } from '../../src/outbox/outbox.js';
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

  it('removes a command from the outbox as soon as it ran, so a killed sync repeats at most the one that was running', async () => {
    let seen: string[] = [];
    const h = setup([], argv => {
      if (argv[1] === '6') seen = jsonLines(OUTBOX_FILE).map(line => String(line.id));
    });
    queue(entry('a', 'approve', '5'), entry('b', 'approve', '6'));

    await syncAll(h.ctx);

    expect(seen).toEqual(['b']);
  });

  it.each([
    [['config', 'set', 'mode', 'observe']],
    [['deploy', 'record', '--target', 'web', '--sha', 'abc1234', '--verify', 'touch pwned']],
    [['hook', 'claude', 'pre-tool']],
    [['task', 'new', '--title', 'T', '--summary', 'S', '--type', 'feature']],
    [['sync']],
    [['approve', '5', 'approve', '--config', 'other.yaml']],
    [['approve', '5', 'approve', '--config=other.yaml']],
    [['--config', 'other.yaml', 'approve', '5', 'approve']],
    [['stage', 'start', '5', 'planning', '--verify', 'touch pwned']],
    [['approve', '5', 'approve', '--json']],
    [['approve', '5', 'approve', '--dry-run']],
  ])('never runs the forged line %j: it moves to the failed file as not a queueable command', async argv => {
    const h = setup();
    queue(entry('forged', ...argv), entry('good', 'approve', '6'));

    const result = await syncAll(h.ctx);

    expect(h.replayed).toEqual([['approve', '6']]);
    expect(result).toMatchObject({ replayed: 1, failed: [{ argv, error: 'not a queueable command' }], remaining: 0 });
    expect(readCache(OUTBOX_FILE)).toBe('');
    expect(jsonLines(OUTBOX_FAILED_FILE)).toEqual([
      { id: 'forged', at: NOW, argv, failedAt: NOW, error: 'not a queueable command' },
    ]);
  });

  it('runs a queueable command whose --file is an absolute path', async () => {
    const h = setup();
    queue(entry('a', 'stage', 'publish', '5', 'planning', '--file', '/abs/summary.md'));

    const result = await syncAll(h.ctx);

    expect(h.replayed).toEqual([['stage', 'publish', '5', 'planning', '--file', '/abs/summary.md']]);
    expect(result.replayed).toBe(1);
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
});

describe('syncAll: taking the gaps', () => {
  const syncingFile = (): string => readCache(GAPS_SYNCING_FILE);
  const syncingLines = (): Record<string, unknown>[] =>
    syncingFile()
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>);

  it('renames gaps.jsonl away while it works, so the hooks append to a fresh file, and deletes the taken file after', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    let during: { gaps: string; syncing: Record<string, unknown>[] } | undefined;
    const write = h.tracker.writeState.bind(h.tracker);
    h.tracker.writeState = async (issue, state, expected) => {
      during = { gaps: readCache(GAPS_FILE), syncing: syncingLines() };
      return write(issue, state, expected);
    };
    logGaps(gap(5, 'edit a'));

    await syncAll(h.ctx);

    expect(during).toEqual({ gaps: '', syncing: [gap(5, 'edit a')] });
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(false);
    expect(readCache(GAPS_FILE)).toBe('');
  });

  it('keeps a gap logged while the sync works, in the new gaps.jsonl', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    const write = h.tracker.writeState.bind(h.tracker);
    h.tracker.writeState = async (issue, state, expected) => {
      mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
      writeFileSync(cachePath(GAPS_FILE), `${JSON.stringify(gap(5, 'late'))}\n`);
      return write(issue, state, expected);
    };
    logGaps(gap(5, 'early'));

    const result = await syncAll(h.ctx);

    expect(result.gapsFlushed).toBe(1);
    expect(jsonLines(GAPS_FILE)).toEqual([gap(5, 'late')]);
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(false);
  });

  it('gives what it could not record back to gaps.jsonl, behind what was logged meanwhile, and deletes the taken file', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    h.tracker.seedTask(task(6));
    h.tracker.writeState = async issue => {
      if (issue === 6) throw new StateChangedError(6);
      writeFileSync(cachePath(GAPS_FILE), `${JSON.stringify(gap(8, 'late'))}\n`);
    };
    logGaps(gap(5, 'edit a'), gap(6, 'edit b'));

    await syncAll(h.ctx);

    expect(jsonLines(GAPS_FILE)).toEqual([gap(8, 'late'), gap(6, 'edit b')]);
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(false);
  });

  it('processes a taken file a dead sync left behind first, then what the hooks logged since', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    const old = { at: '2026-05-31T00:00:00.000Z' };
    writeCache(GAPS_SYNCING_FILE, JSON.stringify(gap(5, 'old', old)));
    logGaps(gap(5, 'new'));
    const write = vi.spyOn(h.tracker, 'writeState');

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 2, gapsDropped: 0 });
    expect(write).toHaveBeenCalledTimes(2);
    expect((await stateOf(h.tracker, 5)).gaps?.map(g => g.text)).toEqual(['old', 'new']);
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(false);
    expect(readCache(GAPS_FILE)).toBe('');
  });

  it('leaves gaps.jsonl for the next sync when the leftover file could not be recorded', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    h.tracker.getTask = async () => {
      throw new GhError(['api', 'graphql'], 'could not resolve host: api.github.com');
    };
    writeCache(GAPS_SYNCING_FILE, JSON.stringify(gap(5, 'old')));
    logGaps(gap(5, 'new'));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ stopped: 'unreachable', gapsFlushed: 0 });
    expect(jsonLines(GAPS_FILE)).toEqual([gap(5, 'new'), gap(5, 'old')]);
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(false);
  });

  it('drops the unusable lines of a leftover file like those of gaps.jsonl', async () => {
    const h = setup();
    writeCache(GAPS_SYNCING_FILE, '{not json', JSON.stringify(gap(undefined)));

    const result = await syncAll(h.ctx);

    expect(result).toMatchObject({ gapsFlushed: 0, gapsDropped: 2 });
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(false);
    expect(readCache(GAPS_FILE)).toBe('');
  });

  it('loads the config once for both passes', async () => {
    const h = setup();
    h.tracker.seedTask(task(5));
    writeCache(GAPS_SYNCING_FILE, JSON.stringify(gap(5, 'old')));
    logGaps(gap(5, 'new'));

    await syncAll(h.ctx);

    expect(h.commandContexts()).toBe(1);
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

    expect(held).toEqual({ pid: process.pid, at: NOW, token: expect.any(String) });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('gives each sync its own token', async () => {
    const tokens: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const h = setup([], () => {
        tokens.push((JSON.parse(readFileSync(lockPath(), 'utf8')) as { token: string }).token);
      });
      queue(entry('a'));
      await syncAll(h.ctx);
    }

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('leaves a lock alone that another sync took over meanwhile: neither refreshed nor released', async () => {
    const other = JSON.stringify({ pid: 999999, at: NOW, token: 'someone-else' });
    const h = setup([], argv => {
      if (argv[1] === '5') writeFileSync(lockPath(), other);
    });
    queue(entry('a', 'approve', '5'), entry('b', 'approve', '6'));

    await syncAll(h.ctx);

    expect(h.replayed).toHaveLength(2);
    expect(readFileSync(lockPath(), 'utf8')).toBe(other);
  });

  it('does not recognise a lock without a token as its own', async () => {
    const legacy = JSON.stringify({ pid: 1, at: NOW });
    const h = setup([], () => {
      writeFileSync(lockPath(), legacy);
    });
    queue(entry('a'));

    await syncAll(h.ctx);

    expect(readFileSync(lockPath(), 'utf8')).toBe(legacy);
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

  describe('acquireLock', () => {
    const lockFiles = (): string[] => readdirSync(dirname(lockPath())).sort();
    const tokenOf = (path: string): string => (JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token;
    const freshLock = (token: string): string => JSON.stringify({ pid: 4242, at: NOW, token });

    it('lets exactly one of two syncs that judge the same lock stale at once take it over', async () => {
      // The second sync starts a few event-loop turns after the first, so the two interleave at every step.
      const later = async (turns: number): Promise<string | undefined> => {
        for (let turn = 0; turn < turns; turn += 1) await new Promise(resolve => setImmediate(resolve));
        return acquireLock(setup().ctx);
      };
      for (let turns = 0; turns < 20; turns += 1) {
        for (let round = 0; round < 3; round += 1) {
          writeLock(LOCK_STALE_MS + MINUTE);

          const tokens = await Promise.all([acquireLock(setup().ctx), later(turns)]);

          const label = `${turns} turns, round ${round}`;
          const winners = tokens.filter((token): token is string => token !== undefined);
          expect(winners, label).toHaveLength(1);
          expect(lockFiles(), label).toEqual(['sync.lock']);
          expect(tokenOf(lockPath()), label).toBe(winners[0]);
          unlinkSync(lockPath());
        }
      }
    });

    it('leaves a fresh lock alone that another sync created after this one judged the old lock stale', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const h = setup();
      let calls = 0;
      h.ctx.now = () => {
        calls += 1;
        // The first judgement is made; then another sync takes over the stale lock.
        if (calls === 1) writeFileSync(lockPath(), freshLock('someone-else'));
        return NOW;
      };

      expect(await acquireLock(h.ctx)).toBeUndefined();

      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe('someone-else');
    });

    it('gives back a fresh lock it renamed in the belief that it was the stale one', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const h = setup();
      let calls = 0;
      h.ctx.now = () => {
        calls += 1;
        // The second judgement, under the claim, is made; then the stale lock is replaced, just before the rename.
        if (calls === 2) writeFileSync(lockPath(), freshLock('someone-else'));
        return NOW;
      };

      expect(await acquireLock(h.ctx)).toBeUndefined();

      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe('someone-else');
    });

    it('does not put a fresh lock back over one created in the meantime', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const h = setup();
      let calls = 0;
      h.ctx.now = () => {
        calls += 1;
        if (calls === 2) writeFileSync(lockPath(), freshLock('first'));
        // The judgement of the renamed file: a third sync has created a lock in the gap.
        if (calls === 3) writeFileSync(lockPath(), freshLock('third'));
        return NOW;
      };

      expect(await acquireLock(h.ctx)).toBeUndefined();

      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe('third');
    });

    it('leaves the live lock untouched when giving the renamed one back fails because another sync created a lock meanwhile', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const h = setup();
      let calls = 0;
      let live: { ino: number; mtimeMs: number } | undefined;
      h.ctx.now = () => {
        calls += 1;
        // The second judgement, under the claim, is made; then the stale lock is replaced, just before the rename.
        if (calls === 2) writeFileSync(lockPath(), freshLock('first'));
        // The judgement of the renamed (fresh) file: the lock is gone from its path, and another sync creates its own there,
        // so the link back (which never overwrites) fails with EEXIST.
        if (calls === 3) {
          expect(lockFiles().some(name => name.includes('.stale-'))).toBe(true);
          writeFileSync(lockPath(), freshLock('live'), { flag: 'wx' });
          const { ino, mtimeMs } = statSync(lockPath());
          live = { ino, mtimeMs };
        }
        return NOW;
      };

      // Held: it is reported as such, never taken.
      expect(await acquireLock(h.ctx)).toBeUndefined();

      // The live lock is the very file its sync created, unchanged; only the file this sync renamed is gone.
      expect(lockFiles()).toEqual(['sync.lock']);
      expect(readFileSync(lockPath(), 'utf8')).toBe(freshLock('live'));
      const now = statSync(lockPath());
      expect({ ino: now.ino, mtimeMs: now.mtimeMs }).toEqual(live);
      // The sync that holds it can still refresh and release it.
      expect(tokenOf(lockPath())).toBe('live');
    });

    it('reports the lock as held while another sync is taking it over, and leaves both files alone', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const before = readFileSync(lockPath(), 'utf8');
      writeFileSync(`${lockPath()}.takeover`, '');

      expect(await acquireLock(setup().ctx)).toBeUndefined();

      expect(lockFiles()).toEqual(['sync.lock', 'sync.lock.takeover']);
      expect(readFileSync(lockPath(), 'utf8')).toBe(before);
    });

    it('breaks a takeover claim that a sync that died left behind', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const claim = `${lockPath()}.takeover`;
      writeFileSync(claim, '');
      // Ten minutes before the time of the sync's clock (`ctx.now()`, the one the lock's age is judged by).
      const old = new Date(Date.parse(NOW) - 10 * MINUTE);
      utimesSync(claim, old, old);

      const token = await acquireLock(setup().ctx);

      expect(token).toEqual(expect.any(String));
      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe(token);
    });

    it('judges the age of a takeover claim by the sync clock, as it does the lock, not by the wall clock', async () => {
      const claim = `${lockPath()}.takeover`;
      const stamp = (at: Date): void => utimesSync(claim, at, at);

      // Old by the wall clock, but the sync's clock (NOW, months back) says the claim is not yet written: held.
      writeLock(LOCK_STALE_MS + MINUTE);
      writeFileSync(claim, '');
      stamp(new Date(Date.now() - 10 * MINUTE));
      expect(await acquireLock(setup().ctx)).toBeUndefined();
      expect(lockFiles()).toEqual(['sync.lock', 'sync.lock.takeover']);

      // Fresh by the wall clock, but the sync's clock is ten minutes on: the claim is dead, and is broken.
      const h = setup();
      h.clock.now = new Date(Date.now() + 10 * MINUTE).toISOString();
      writeFileSync(lockPath(), JSON.stringify({ pid: 999999, at: new Date(Date.parse(h.clock.now) - LOCK_STALE_MS - MINUTE).toISOString() }));
      stamp(new Date());
      const token = await acquireLock(h.ctx);
      expect(token).toEqual(expect.any(String));
      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe(token);
    });

    // A dangling symlink is a claim that exists for `wx` (EEXIST) and cannot be read by `stat`: the state
    // of a claim that was released between the two calls. Its age is unknown, so it is not judged dead.
    it.skipIf(process.platform === 'win32')('does not break a takeover claim whose age cannot be read', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);
      const claim = `${lockPath()}.takeover`;
      symlinkSync(join(root, 'gone'), claim);

      expect(await acquireLock(setup().ctx)).toBeUndefined();

      expect(lstatSync(claim).isSymbolicLink()).toBe(true);
      expect(lockFiles()).toEqual(['sync.lock', 'sync.lock.takeover']);
    });

    it('leaves no .stale file after taking over', async () => {
      writeLock(LOCK_STALE_MS + MINUTE);

      const token = await acquireLock(setup().ctx);

      expect(token).toEqual(expect.any(String));
      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe(token);
    });

    it('removes the lock file it created when writing it failed', async () => {
      const h = setup();
      h.ctx.now = () => {
        throw new Error('clock failed');
      };

      await expect(acquireLock(h.ctx)).rejects.toThrow('clock failed');

      expect(lockFiles()).toEqual([]);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'releases an orphan lock: the read-back misses, so the file this call created is removed',
      async () => {
        const h = setup();
        // The file is made unreadable after it was created: the read-back cannot show the token.
        h.ctx.now = () => {
          chmodSync(lockPath(), 0o000);
          return NOW;
        };

        expect(await acquireLock(h.ctx)).toBeUndefined();

        expect(lockFiles()).toEqual([]);
      },
    );

    it('leaves the lock of another sync alone when the read-back shows its token', async () => {
      const h = setup();
      h.ctx.now = () => {
        // Another sync replaced the file this call created, before the read-back.
        const other = `${lockPath()}.other`;
        writeFileSync(other, freshLock('someone-else'));
        renameSync(other, lockPath());
        return NOW;
      };

      expect(await acquireLock(h.ctx)).toBeUndefined();

      expect(lockFiles()).toEqual(['sync.lock']);
      expect(tokenOf(lockPath())).toBe('someone-else');
    });
  });

  // Real processes: the in-process tests above interleave at every await, but only separate processes
  // race on the file system the way two `sdlc sync` runs do.
  describe.skipIf(process.platform === 'win32')('acquireLock across processes', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const PROCESSES = 8;
    let build: string;
    let script: string;

    beforeAll(() => {
      // A private build, inside node_modules so that the packages resolve, and not `dist`, which other tests rebuild.
      build = mkdtempSync(join(repo, 'node_modules', '.sdlc-sync-race-'));
      execFileSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', repo, '--outDir', build, '--noCheck'], {
        cwd: repo,
        stdio: 'pipe',
      });
      script = join(build, 'acquire.mjs');
      writeFileSync(
        script,
        [
          "import { acquireLock } from './commands/sync.js';",
          'const [root, startAt] = process.argv.slice(2);',
          'while (Date.now() < Number(startAt)) {}',
          'const token = await acquireLock({ repoRoot: root, now: () => new Date().toISOString() });',
          "process.stdout.write((token ?? 'none') + '\\n');",
        ].join('\n'),
      );
    }, 60_000);
    afterAll(() => {
      rmSync(build, { recursive: true, force: true });
    });

    const acquireInChild = (startAt: number): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, root, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => (stdout += chunk));
        child.stderr.on('data', chunk => (stderr += chunk));
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}: ${stderr}`))));
      });

    it('lets exactly one of several syncs take over a stale lock, and leaves no .stale or .takeover file', async () => {
      for (let round = 0; round < 3; round += 1) {
        writeLock(LOCK_STALE_MS + MINUTE);

        // All start at the same instant; one that starts late finds the winner's fresh lock, which is also right.
        const startAt = Date.now() + 500;
        const results = await Promise.all(Array.from({ length: PROCESSES }, () => acquireInChild(startAt)));

        const winners = results.filter(result => result !== 'none');
        expect(winners, `round ${round}: ${results.join(', ')}`).toHaveLength(1);
        expect(readdirSync(dirname(lockPath())).sort(), `round ${round}`).toEqual(['sync.lock']);
        expect((JSON.parse(readFileSync(lockPath(), 'utf8')) as { token: string }).token, `round ${round}`).toBe(winners[0]);
        unlinkSync(lockPath());
      }
    }, 30_000);
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

    expect(seen).toEqual({
      pid: process.pid,
      at: new Date(Date.parse(NOW) + 9 * MINUTE).toISOString(),
      token: expect.any(String),
    });
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

  it('counts the gaps of a leftover taken file with those of gaps.jsonl', async () => {
    const h = setup();
    writeCache(GAPS_SYNCING_FILE, JSON.stringify(gap(5, 'old')));
    logGaps(gap(5, 'new'), gap(undefined));

    const result = await syncAll(h.ctx, { dryRun: true });

    expect(result.plan).toEqual({ replay: [], gaps: [{ issue: 5, count: 2 }], dropped: 1 });
    expect(existsSync(cachePath(GAPS_SYNCING_FILE))).toBe(true);
    expect(jsonLines(GAPS_FILE)).toHaveLength(2);
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

  it('documents its exit codes in --help', async () => {
    const help: string[] = [];
    const program = new Command().exitOverride().configureOutput({ writeOut: text => help.push(text), writeErr: text => help.push(text) });
    registerSyncCommand(program, () => setup().ctx);

    await expect(program.parseAsync(['node', 'sdlc', 'sync', '--help'])).rejects.toMatchObject({ code: 'commander.helpDisplayed' });

    const text = help.join('');
    expect(text).toContain('Exit codes:');
    expect(text).toMatch(/\n\s+0\s+everything queued ran or nothing was queued/);
    expect(text).toMatch(/\n\s+1\s+a queued command failed for good or a queue line was malformed/);
    expect(text).toMatch(/\n\s+75\s+GitHub is still unreachable/);
  });

  it('exits 1 for a malformed outbox line, which is reported as failed', async () => {
    const h = setup();
    writeCache(OUTBOX_FILE, '{not json');

    await run(h);

    expect(h.out[0]).toContain('Failed: malformed outbox line');
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 for a forged line, which is reported as failed', async () => {
    const h = setup();
    queue(entry('forged', 'config', 'set', 'mode', 'observe'));

    await run(h);

    expect(h.out[0]).toContain('Failed: sdlc config set mode observe: not a queueable command');
    expect(h.replayed).toEqual([]);
    expect(process.exitCode).toBe(1);
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
