import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { describeStatus, registerStatusCommand } from '../../src/commands/status.js';
import { loadConfig, typeRegistry } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { statusReport, type StatusReport } from '../../src/engine/status.js';
import { GAPS_FILE, OUTBOX_FILE } from '../../src/hooks/localLog.js';
import { FakeTracker } from '../support/fakeTracker.js';
import { createTestRepo } from '../support/gitRepo.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const types = typeRegistry(cfg);
const NOW = '2026-06-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
});

function setup() {
  const tracker = new FakeTracker();
  tracker.owners = [...cfg.owners];
  const out: unknown[] = [];
  const err: string[] = [];
  const ctx: CommandContext = { tracker, cfg, now: () => NOW, out: data => out.push(data), err: text => err.push(text) };
  return { tracker, ctx, out, err };
}

type Harness = ReturnType<typeof setup>;

function task(issue: number, overrides: Partial<TaskState> = {}): TaskState {
  return { ...newTask({ issue, type: types.get('feature')!, summary: `Task ${issue}`, now: ago(30) }), ...overrides };
}

const awaiting = (issue: number, updatedAt: string): TaskState =>
  task(issue, {
    phase: 'delivery',
    status: 'awaiting_deployment',
    waitingOn: 'external',
    targets: ['web', 'api'],
    pendingTargets: ['web', 'api'],
    updatedAt,
  });

async function run(h: Harness, ...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerStatusCommand(program, () => h.ctx);
  await program.parseAsync(['node', 'sdlc', 'status', ...args]);
}

/**
 * Runs `sdlc status` with a context factory that fails as a broken config would, capturing what is
 * printed to stdout and stderr (with no context, errors go straight to the process streams).
 */
async function runWithoutContext(...args: string[]): Promise<{ out: string[]; err: string[]; contexts: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let contexts = 0;
  const capture = (into: string[]) => (chunk: string | Uint8Array): boolean => {
    into.push(String(chunk).replace(/\n$/, ''));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture(out));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture(err));
  try {
    const program = new Command().exitOverride();
    registerStatusCommand(program, () => {
      contexts += 1;
      throw new Error('config is broken');
    });
    await program.parseAsync(['node', 'sdlc', 'status', ...args]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return { out, err, contexts };
}

describe('sdlc status', () => {
  it('prints tasks grouped by status, then only the attention sections that have entries', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, { status: 'in_progress', phase: 'implementation', updatedAt: ago(2) }), {
      title: 'Add search',
    });
    h.tracker.seedTask(awaiting(2, ago(9)), { title: 'Ship export' });
    h.tracker.seedTask(task(3, { status: 'paused', waitingOn: 'owner', phase: 'brainstorming', updatedAt: ago(1) }), {
      title: 'Pick a design',
    });
    h.tracker.issues.push({ number: 9, title: 'Hand-made', body: '', labels: ['sdlc:task'], open: true, onBoard: false });

    await run(h);

    const text = h.out[0] as string;
    expect(text).toContain('In progress (1)');
    expect(text).toContain('Paused (1)');
    expect(text).toContain('Awaiting deployment (1)');
    expect(text).toContain('#1 Add search');
    expect(text).toContain('feature, Implementation, 2d');
    expect(text).toContain('#2 Ship export');
    expect(text).toContain('pending: api, web');
    expect(text).toContain('Waiting on the owner (1)');
    expect(text).toContain('Awaiting deployment for more than 7 days (1)');
    expect(text).toContain('Untracked sdlc:task issues (1)');
    expect(text).toContain('#9 Hand-made');
    // Listed once, under untracked issues, not again under pending reconcile.
    expect(text.match(/#9 /g)).toHaveLength(1);
    expect(text).not.toContain('Pending reconcile');
    expect(text).not.toContain('Paused on the agent');
    expect(text).not.toContain('Ready (');
    expect(text).not.toContain('\u001b[');
    expect(process.exitCode).toBe(exitCode);
  });

  it('prints a short line for an empty repository and leaves out every attention section', async () => {
    const h = setup();

    await run(h);

    expect(h.out[0]).toBe('No tracked tasks.');
  });

  it('lists the pending reconcile actions', async () => {
    const h = setup();
    h.tracker.seedTask({ ...awaiting(1, ago(1)), targets: [], pendingTargets: [] });

    await run(h);

    const text = h.out[0] as string;
    expect(text).toContain('Pending reconcile (1)');
    expect(text).toContain('#1 error: no targets declared');
  });

  it('prints the report as JSON with --json', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(9)));

    await run(h, '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual(JSON.parse(JSON.stringify(await statusReport(h.ctx, { staleDays: 7 }))));
  });

  it('scans the recently closed tasks, or every task with --all', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, { status: 'done', phase: 'delivery', outcome: 'completed', waitingOn: 'none' }), {
      open: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const scan = vi.spyOn(h.tracker, 'scanTasks');

    await run(h);
    expect(h.out[0]).toBe('No tracked tasks.');
    await run(h, '--all');
    expect(h.out[1]).toContain('Done (1)');

    expect(scan.mock.calls).toEqual([[{ closedSince: '2026-05-02' }], [{}]]);
  });

  it('uses --stale-days for the staleness cut-off', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(9)));

    await run(h, '--stale-days', '10', '--json');

    const report = JSON.parse(h.out[0] as string) as { staleAwaitingDeployment: unknown[] };
    expect(report.staleAwaitingDeployment).toEqual([]);
  });

  it.each(['0', '-3', '1.5', '7days', 'abc', '', '1e3', '0x10', ' '])(
    'rejects --stale-days %j with an error and exit code 1',
    async value => {
      const h = await runWithoutContext('--stale-days', value);

      expect(h.out).toEqual([]);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toMatch(/--stale-days/);
      expect(h.err[0]).toMatch(/positive integer/);
      expect(process.exitCode).toBe(1);
    },
  );

  it('checks --stale-days before building the context, so a bad value is named even with a broken config', async () => {
    const result = await runWithoutContext('--stale-days', 'abc');

    expect(result.contexts).toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([expect.stringMatching(/--stale-days "abc".*positive integer/)]);
    expect(process.exitCode).toBe(1);
  });

  it('still reports a broken config when --stale-days is valid', async () => {
    const result = await runWithoutContext('--stale-days', '3');

    expect(result.contexts).toBe(1);
    expect(result.err).toEqual(['config is broken']);
  });

  it('reports an invalid --stale-days as JSON with --json', async () => {
    const h = await runWithoutContext('--stale-days', '0', '--json');

    expect(h.contexts).toBe(0);
    expect(JSON.parse(h.out[0]!)).toEqual({ error: expect.stringContaining('positive integer') });
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when the tasks cannot be read', async () => {
    const h = setup();
    h.tracker.failNext('scanTasks');

    await run(h);

    expect(h.err[0]).toContain('scanTasks');
    expect(process.exitCode).toBe(1);
  });
});

describe('queued work', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sdlc-status-queued-'));
    mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cache = (file: string, ...lines: string[]): void =>
    writeFileSync(join(root, '.sdlc', 'cache', file), lines.map(line => `${line}\n`).join(''));
  const entry = (id: string): string => JSON.stringify({ id, at: NOW, argv: ['approve', '5'] });
  const gapLine = JSON.stringify({ at: NOW, rule: 'no-task', text: 'edit a.ts', harness: 'claude', blocked: false });

  function withRoot(h: Harness): Harness {
    h.ctx.repoRoot = root;
    return h;
  }

  it('shows how many writes and gaps wait for sdlc sync', async () => {
    const h = withRoot(setup());
    h.tracker.seedTask(task(1, { status: 'in_progress', phase: 'implementation', updatedAt: ago(1) }));
    cache(OUTBOX_FILE, entry('a'), entry('b'));
    cache(GAPS_FILE, gapLine);

    await run(h);

    const text = h.out[0] as string;
    expect(text).toContain('In progress (1)');
    expect(text.trimEnd().endsWith('Queued for sync: 2 write(s), 1 gap(s)')).toBe(true);
  });

  it('shows the line for an empty repository too', async () => {
    const h = withRoot(setup());
    cache(GAPS_FILE, gapLine, gapLine);

    await run(h);

    expect(h.out[0]).toBe('No tracked tasks.\n\nQueued for sync: 0 write(s), 2 gap(s)');
  });

  it('leaves the line out when nothing is queued, or the context has no repository root', async () => {
    const h = withRoot(setup());
    await run(h);
    expect(h.out[0]).toBe('No tracked tasks.');

    cache(OUTBOX_FILE, entry('a'));
    const noRoot = setup();
    await run(noRoot);
    expect(noRoot.out[0]).toBe('No tracked tasks.');
  });

  it('counts only the lines sync would act on', async () => {
    const h = withRoot(setup());
    cache(OUTBOX_FILE, entry('a'), '{not json', JSON.stringify({ argv: ['approve', '5', 'approve'] }));
    cache(GAPS_FILE, gapLine, JSON.stringify({ rule: 'no-task' }), '[]');

    await run(h);

    expect(h.out[0]).toBe('No tracked tasks.\n\nQueued for sync: 1 write(s), 1 gap(s)');
  });

  it('puts the counts in the JSON report', async () => {
    const h = withRoot(setup());
    cache(OUTBOX_FILE, entry('a'));
    cache(GAPS_FILE, gapLine, gapLine, gapLine);

    await run(h, '--json');

    expect(JSON.parse(h.out[0] as string)).toMatchObject({ queued: { outbox: 1, gaps: 3 } });
  });

  it('reports zero counts when the context has no repository root', async () => {
    const h = setup();

    await run(h, '--json');

    expect(JSON.parse(h.out[0] as string)).toMatchObject({ queued: { outbox: 0, gaps: 0 } });
  });
});

describe('describeStatus', () => {
  it('names the stale-days cut-off in the stale section', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(4)));

    const text = describeStatus(await statusReport(h.ctx, { staleDays: 3 }), 3);

    expect(text).toContain('Awaiting deployment for more than 3 days (1)');
  });

  it('lists paused-on-agent tasks that are stale', async () => {
    const h = setup();
    h.tracker.seedTask(task(4, { status: 'paused', waitingOn: 'agent', updatedAt: ago(12) }), { title: 'Stuck' });

    const text = describeStatus(await statusReport(h.ctx, { staleDays: 7 }), 7);

    expect(text).toContain('Paused on the agent for more than 7 days (1)');
    expect(text).toContain('#4 Stuck');
  });
});

describe('orphan worktrees', () => {
  const orphan = { path: '/repo/.worktrees/9-lost', branch: 'task/9-lost', reason: 'no-task' } as const;
  const report = async (orphans: StatusReport['orphanWorktrees']): Promise<StatusReport> => ({
    ...(await statusReport(setup().ctx, { staleDays: 7 })),
    orphanWorktrees: orphans,
  });

  it('prints each one with its path, its branch and why it is one', async () => {
    const text = describeStatus(
      await report([
        orphan,
        { path: '/repo/.worktrees/4-done', branch: 'task/4-done', reason: 'task-done' },
        { path: '/repo/.worktrees/old', reason: 'detached' },
        { path: '/repo/.worktrees/7-gone', branch: 'task/7-gone', reason: 'prunable' },
      ]),
      7,
    );

    const lines = text.split('\n');
    expect(lines).toContain('Orphan worktrees:');
    const block = lines.slice(lines.indexOf('Orphan worktrees:') + 1);
    expect(block).toHaveLength(4);
    expect(block[0]).toContain('/repo/.worktrees/9-lost (task/9-lost): no-task');
    expect(block[1]).toContain('/repo/.worktrees/4-done (task/4-done): task-done');
    expect(block[1]).toContain('sdlc worktree finish 4');
    expect(block[2]).toContain('/repo/.worktrees/old: detached');
    expect(block[2]).not.toContain('(');
    expect(block[3]).toContain('/repo/.worktrees/7-gone (task/7-gone): prunable');
  });

  it('comes after the queued line, and is the only thing printed for an empty repository', async () => {
    const queued = { ...(await report([orphan])), queued: { outbox: 1, gaps: 0 } };

    expect(describeStatus(queued, 7)).toBe(
      [
        'No tracked tasks.',
        '',
        'Queued for sync: 1 write(s), 0 gap(s)',
        '',
        'Orphan worktrees:',
        '  /repo/.worktrees/9-lost (task/9-lost): no-task - no open or recently closed task has this branch (check with `sdlc status --all`)',
      ].join('\n'),
    );
    expect(describeStatus(await report([orphan]), 7)).toBe(
      'No tracked tasks.\n\nOrphan worktrees:\n  /repo/.worktrees/9-lost (task/9-lost): no-task - no open or recently closed task has this branch (check with `sdlc status --all`)',
    );
  });

  it('leaves the section out when there are none', async () => {
    expect(describeStatus(await report([]), 7)).toBe('No tracked tasks.');
  });

  describe('of a real repository', () => {
    afterEach(() => vi.unstubAllEnvs());

    function repoWithWorktrees() {
      const repo = createTestRepo();
      repo.write('.gitignore', '.worktrees/\n');
      repo.write('README.md', 'x\n');
      repo.commit('init');
      repo.git('worktree', 'add', '-q', '-b', 'task/9-lost', '.worktrees/9-lost');
      repo.git('worktree', 'add', '-q', '-b', 'task/1-live', '.worktrees/1-live');
      repo.git('worktree', 'add', '-q', '--detach', '.worktrees/old');
      repo.git('worktree', 'add', '-q', '-b', 'feat/mine', '.worktrees/mine');
      const h = setup();
      h.tracker.seedTask(task(1, { status: 'in_progress', phase: 'implementation', updatedAt: ago(1) }), {
        title: 'Live',
      });
      // `repo.root` may be spelled through a symlink (the temp directory of macOS); the root of a context is not normalised.
      h.ctx.repoRoot = repo.root;
      return { repo, h, root: realpathSync(repo.root) };
    }

    it('lists the worktrees nobody needs, with the paths git reports', async () => {
      const { repo, h, root } = repoWithWorktrees();
      try {
        await run(h, '--json');

        const { orphanWorktrees } = JSON.parse(h.out[0] as string) as StatusReport;
        expect(orphanWorktrees).toEqual([
          { path: join(root, '.worktrees', '9-lost'), branch: 'task/9-lost', reason: 'no-task' },
          { path: join(root, '.worktrees', 'old'), reason: 'detached' },
        ]);
        expect(process.exitCode).toBe(exitCode);
      } finally {
        repo.cleanup();
      }
    });

    it('prints them as text', async () => {
      const { repo, h, root } = repoWithWorktrees();
      try {
        await run(h);

        const text = h.out[0] as string;
        expect(text).toContain('Orphan worktrees:');
        expect(text).toContain(`${join(root, '.worktrees', '9-lost')} (task/9-lost): no-task`);
        expect(text).toContain(`${join(root, '.worktrees', 'old')}: detached`);
        expect(text).not.toContain('1-live');
        expect(text).not.toContain('mine');
      } finally {
        repo.cleanup();
      }
    });
  });
});
