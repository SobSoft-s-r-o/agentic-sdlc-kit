import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { statusReport } from '../../src/engine/status.js';
import type { GitRunner } from '../../src/install/provision.js';
import { FakeTracker } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const types = typeRegistry(cfg);
const NOW = '2026-06-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const A = 'a'.repeat(40);

/** An ISO time `days` days (and `hours` more hours) before NOW. */
const ago = (days: number, hours = 0): string => new Date(Date.parse(NOW) - days * DAY - hours * HOUR).toISOString();

function setup(config: Config = cfg) {
  const tracker = new FakeTracker();
  tracker.owners = [...config.owners];
  tracker.agents = [...config.agents];
  const ctx: CommandContext = { tracker, cfg: config, now: () => NOW, out: () => undefined };
  return { tracker, ctx };
}

function task(issue: number, type: string, overrides: Partial<TaskState> = {}): TaskState {
  return { ...newTask({ issue, type: types.get(type)!, summary: `Task ${issue}`, now: ago(30) }), ...overrides };
}

const awaiting = (issue: number, updatedAt: string, overrides: Partial<TaskState> = {}): TaskState =>
  task(issue, 'feature', {
    phase: 'delivery',
    status: 'awaiting_deployment',
    waitingOn: 'external',
    targets: ['web'],
    pendingTargets: ['web'],
    prs: [{ number: 50 + issue, scope: 'final', mergeSha: A }],
    finalMergedAt: ago(30),
    updatedAt,
    ...overrides,
  });

const paused = (issue: number, waitingOn: TaskState['waitingOn'], updatedAt: string): TaskState =>
  task(issue, 'feature', { phase: 'brainstorming', status: 'paused', waitingOn, updatedAt });

const issues = (summaries: { issue: number }[]): number[] => summaries.map(s => s.issue);

describe('statusReport', () => {
  it('groups tasks and flags stale awaiting deployment older than staleDays', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature', { status: 'in_progress', phase: 'implementation', updatedAt: ago(40) }));
    h.tracker.seedTask(awaiting(2, ago(10)));
    h.tracker.seedTask(awaiting(3, ago(7)));
    h.tracker.seedTask(awaiting(4, ago(7, 23)));
    h.tracker.seedTask(awaiting(5, ago(8)));
    h.tracker.seedTask(task(6, 'feature', { status: 'done', phase: 'delivery', outcome: 'completed' }));

    const report = await statusReport(h.ctx, { staleDays: 7 });

    expect(issues(report.byStatus.in_progress)).toEqual([1]);
    expect(issues(report.byStatus.awaiting_deployment)).toEqual([2, 3, 4, 5]);
    expect(issues(report.byStatus.done)).toEqual([6]);
    // Whole days, compared strictly: 7 days and 23 hours is 7 whole days, which is not older than 7.
    expect(issues(report.staleAwaitingDeployment)).toEqual([2, 5]);
    expect(report.stalePausedOnAgent).toEqual([]);
    expect(report.waitingOnOwner).toEqual([]);
  });

  it('summarises each task with its status, phase, type, pending targets and whole-day age', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(10, 5), { targets: ['web', 'api'], pendingTargets: ['web', 'api'] }), {
      title: 'Add search',
    });

    const report = await statusReport(h.ctx, { staleDays: 7 });

    expect(report.byStatus.awaiting_deployment).toEqual([
      {
        issue: 2,
        title: 'Add search',
        status: 'awaiting_deployment',
        phase: 'delivery',
        type: 'feature',
        pendingTargets: ['web', 'api'],
        updatedAt: ago(10, 5),
        ageDays: 10,
      },
    ]);
  });

  it('honours the staleDays it is given', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1, ago(3)));
    h.tracker.seedTask(awaiting(2, ago(2)));

    expect(issues((await statusReport(h.ctx, { staleDays: 2 })).staleAwaitingDeployment)).toEqual([1]);
    expect(issues((await statusReport(h.ctx, { staleDays: 1 })).staleAwaitingDeployment)).toEqual([1, 2]);
    expect(issues((await statusReport(h.ctx, { staleDays: 3 })).staleAwaitingDeployment)).toEqual([]);
  });

  it('lists tasks paused waiting on the owner regardless of age, and stale ones paused on the agent', async () => {
    const h = setup();
    h.tracker.seedTask(paused(1, 'owner', ago(0, 1)));
    h.tracker.seedTask(paused(2, 'owner', ago(30)));
    h.tracker.seedTask(paused(3, 'agent', ago(8)));
    h.tracker.seedTask(paused(4, 'agent', ago(7)));
    h.tracker.seedTask(paused(5, 'external', ago(30)));
    h.tracker.seedTask(task(6, 'feature', { status: 'in_progress', waitingOn: 'agent', updatedAt: ago(30) }));

    const report = await statusReport(h.ctx, { staleDays: 7 });

    expect(issues(report.waitingOnOwner)).toEqual([1, 2]);
    expect(issues(report.stalePausedOnAgent)).toEqual([3]);
    expect(report.staleAwaitingDeployment).toEqual([]);
  });

  it('counts a task updated in the future (clock skew) as zero days old', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1, new Date(Date.parse(NOW) + DAY).toISOString()));

    const report = await statusReport(h.ctx, { staleDays: 1 });

    expect(report.byStatus.awaiting_deployment[0].ageDays).toBe(0);
    expect(report.staleAwaitingDeployment).toEqual([]);
  });

  it('lists issues labelled sdlc:task without state as untracked', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature'));
    h.tracker.issues.push({
      number: 9,
      title: 'Hand-made task',
      body: '',
      labels: ['sdlc:task'],
      open: true,
      onBoard: false,
    });
    h.tracker.issues.push({ number: 10, title: 'Unrelated', body: '', labels: ['bug'], open: true, onBoard: false });

    const report = await statusReport(h.ctx, { staleDays: 7 });

    expect(report.untracked).toEqual([{ issue: 9, title: 'Hand-made task' }]);
    expect(report.pendingReconcile.filter(a => a.issue === 9)).toEqual([]);
    expect(issues(Object.values(report.byStatus).flat())).toEqual([1]);
  });

  describe('closed lookback', () => {
    /** The clock reads 2026-06-01, so the default 30 days reach back to 2026-05-02. */
    const OLD = '2026-04-01T00:00:00.000Z';
    const RECENT = '2026-05-20T00:00:00.000Z';
    const done = (issue: number): TaskState =>
      task(issue, 'feature', { status: 'done', phase: 'delivery', outcome: 'completed', waitingOn: 'none' });
    const handMade = (number: number, updatedAt: string) =>
      h.tracker.issues.push({ number, title: `Hand-made ${number}`, body: '', labels: ['sdlc:task'], open: false, onBoard: false, updatedAt });
    let h: ReturnType<typeof setup>;

    beforeEach(() => {
      h = setup();
      h.tracker.seedTask(task(1, 'feature', { status: 'in_progress', phase: 'implementation' }), { updatedAt: OLD });
      h.tracker.seedTask(done(2), { open: false, updatedAt: OLD });
      h.tracker.seedTask(done(3), { open: false, updatedAt: RECENT });
      handMade(8, OLD);
      handMade(9, RECENT);
    });

    it('scans open tasks and the tasks closed within closedLookbackDays of the clock', async () => {
      const scan = vi.spyOn(h.tracker, 'scanTasks');

      await statusReport(h.ctx, { staleDays: 7 });

      expect(scan).toHaveBeenCalledTimes(1);
      expect(scan).toHaveBeenCalledWith({ closedSince: '2026-05-02' });
    });

    it('leaves out tasks and untracked issues closed before the lookback, never an open task', async () => {
      const report = await statusReport(h.ctx, { staleDays: 7 });

      expect(issues(report.byStatus.in_progress)).toEqual([1]);
      expect(issues(report.byStatus.done)).toEqual([3]);
      expect(report.untracked).toEqual([{ issue: 9, title: 'Hand-made 9' }]);
    });

    it('lists everything with all', async () => {
      const scan = vi.spyOn(h.tracker, 'scanTasks');

      const report = await statusReport(h.ctx, { staleDays: 7, all: true });

      expect(scan).toHaveBeenCalledTimes(1);
      expect(scan).toHaveBeenCalledWith({});
      expect(issues(report.byStatus.done)).toEqual([2, 3]);
      expect(report.untracked.map(u => u.issue)).toEqual([8, 9]);
    });

    it('follows the configured lookback', async () => {
      h = setup({ ...cfg, reconcile: { closedLookbackDays: 7 } });
      const scan = vi.spyOn(h.tracker, 'scanTasks');

      await statusReport(h.ctx, { staleDays: 7 });

      expect(scan).toHaveBeenCalledWith({ closedSince: '2026-05-25' });
    });
  });

  it('is empty for a repository without tasks', async () => {
    const h = setup();

    const report = await statusReport(h.ctx, { staleDays: 7 });

    expect(Object.values(report.byStatus).flat()).toEqual([]);
    expect(report).toMatchObject({
      waitingOnOwner: [],
      staleAwaitingDeployment: [],
      stalePausedOnAgent: [],
      untracked: [],
      pendingReconcile: [],
      queued: { outbox: 0, gaps: 0 },
      orphanWorktrees: [],
    });
  });

  it('scans the task issues once, the dry-run reconcile included', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature', { status: 'in_progress' }));
    const scan = vi.spyOn(h.tracker, 'scanTasks');
    const tracked = vi.spyOn(h.tracker, 'listTrackedTasks');
    const untracked = vi.spyOn(h.tracker, 'listUntracked');

    await statusReport(h.ctx, { staleDays: 7 });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(tracked).not.toHaveBeenCalled();
    expect(untracked).not.toHaveBeenCalled();
  });

  describe('pendingReconcile', () => {
    it('shows what a dry-run reconcile would change and writes nothing', async () => {
      const h = setup();
      h.tracker.seedTask(
        task(1, 'tooling', {
          phase: 'review',
          status: 'in_review',
          waitingOn: 'owner',
          prs: [{ number: 51, scope: 'final' }],
        }),
      );
      h.tracker.prs.push({
        issue: 1,
        number: 51,
        url: 'https://github.test/pull/51',
        merged: true,
        mergeSha: A,
        mergedAt: ago(1),
        baseRef: 'main',
        body: 'Related to #1\nScope: final',
      });
      const writesBefore = h.tracker.writes;

      const report = await statusReport(h.ctx, { staleDays: 7 });

      expect(report.pendingReconcile.map(a => a.kind)).toEqual(['pr_merged', 'fields_synced', 'issue_closed']);
      expect(report.pendingReconcile[0]).toMatchObject({ issue: 1, kind: 'pr_merged' });
      expect(h.tracker.writes).toBe(writesBefore);
      expect((await h.tracker.getTask(1)).state.status).toBe('in_review');
    });

    it('keeps errors and leaves out ignored approvals and skipped task types', async () => {
      const h = setup();
      // An error: awaiting deployment with no targets declared.
      h.tracker.seedTask(awaiting(1, ago(1), { targets: [], pendingTargets: [] }));
      // Skipped: its type is not enabled.
      h.tracker.seedTask(task(2, 'feature', { type: 'retired-type' }));
      // Ignored: a stray command that does not fit the task.
      h.tracker.seedTask(task(3, 'feature', { status: 'in_progress' }));
      h.tracker.seedComment(3, { body: '/approve', author: 'shop-owner', createdAt: ago(1) });

      const report = await statusReport(h.ctx, { staleDays: 7 });

      expect(report.pendingReconcile.map(a => [a.issue, a.kind])).toEqual([[1, 'error']]);
    });

    it('surfaces a reconcile failure as a single error entry instead of failing', async () => {
      const h = setup({ ...cfg, taskTypes: { ...cfg.taskTypes, enabled: ['no-such-type'] } });
      h.tracker.seedTask(task(1, 'feature', { status: 'in_progress' }));

      const report = await statusReport(h.ctx, { staleDays: 7 });

      expect(report.pendingReconcile).toHaveLength(1);
      expect(report.pendingReconcile[0]).toMatchObject({ issue: 0, kind: 'error' });
      expect(report.pendingReconcile[0].detail).toContain('no-such-type');
      expect(issues(report.byStatus.in_progress)).toEqual([1]);
    });
  });

  it('fails when the tasks cannot be read', async () => {
    const h = setup();
    h.tracker.failNext('scanTasks');

    await expect(statusReport(h.ctx, { staleDays: 7 })).rejects.toThrow(/scanTasks/);
  });
});

describe('orphanWorktrees', () => {
  const PORCELAIN = [
    ['worktree /repo', 'HEAD 1111', 'branch refs/heads/main'],
    ['worktree /repo/.worktrees/1-live', 'HEAD 2222', 'branch refs/heads/task/1-live'],
    ['worktree /repo/.worktrees/2-finished', 'HEAD 3333', 'branch refs/heads/task/2-finished'],
    ['worktree /repo/.worktrees/9-lost', 'HEAD 4444', 'branch refs/heads/task/9-lost'],
    ['worktree /repo/.worktrees/old', 'HEAD 5555', 'detached'],
    ['worktree /elsewhere/9-lost', 'HEAD 6666', 'branch refs/heads/task/9-lost'],
  ]
    .map(lines => lines.join('\n'))
    .join('\n\n');

  const fakeGit = (stdout = PORCELAIN, code = 0): { git: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      git: async args => {
        calls.push(args);
        return { stdout, stderr: code === 0 ? '' : 'fatal: not a git repository', code };
      },
    };
  };

  function seeded() {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature', { status: 'in_progress', phase: 'implementation' }));
    h.tracker.seedTask(task(2, 'feature', { status: 'done', phase: 'delivery', outcome: 'completed' }));
    return h;
  }

  it('lists the worktrees under .worktrees/ whose task is untracked or done, or that are detached', async () => {
    const h = seeded();
    const { git, calls } = fakeGit();

    const report = await statusReport(h.ctx, { staleDays: 7, git, repoRoot: '/repo' });

    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
    expect(report.orphanWorktrees).toEqual([
      { path: '/repo/.worktrees/2-finished', branch: 'task/2-finished', reason: 'task-done' },
      { path: '/repo/.worktrees/9-lost', branch: 'task/9-lost', reason: 'no-task' },
      { path: '/repo/.worktrees/old', reason: 'detached' },
    ]);
  });

  describe('a worktree whose task is not in the scan', () => {
    /** #9 closed a year ago, long before the lookback: the scan does not hold it. */
    function closedLongAgo(h: ReturnType<typeof setup>, overrides: Partial<TaskState> = {}): void {
      h.tracker.seedTask(
        task(9, 'feature', { status: 'done', phase: 'delivery', outcome: 'completed', ...overrides }),
        { open: false, updatedAt: ago(400) },
      );
    }
    const lost = { path: '/repo/.worktrees/9-lost', branch: 'task/9-lost' };

    it('is task-done when its task closed before the lookback and is done', async () => {
      const h = seeded();
      closedLongAgo(h);
      const scanned = await h.tracker.scanTasks({ closedSince: ago(30) });
      expect(scanned.tracked.map(t => t.issue)).not.toContain(9);

      const report = await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git, repoRoot: '/repo' });

      expect(report.orphanWorktrees).toContainEqual({ ...lost, reason: 'task-done' });
    });

    it('stays no-task when the task is not done', async () => {
      const h = seeded();
      closedLongAgo(h, { status: 'in_progress', phase: 'implementation', outcome: 'cancelled' });

      const report = await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git, repoRoot: '/repo' });

      expect(report.orphanWorktrees).toContainEqual({ ...lost, reason: 'no-task' });
    });

    it('stays no-task when the lookup fails, and so does the rest of the report', async () => {
      const h = seeded();
      closedLongAgo(h);
      h.tracker.failNext('getTask');

      const report = await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git, repoRoot: '/repo' });

      expect(report.orphanWorktrees.map(orphan => orphan.reason)).toEqual(['task-done', 'no-task', 'detached']);
      expect(issues(report.byStatus.in_progress)).toEqual([1]);
    });

    it('stays no-task when no issue has that number', async () => {
      const h = seeded();

      const report = await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git, repoRoot: '/repo' });

      expect(report.orphanWorktrees).toContainEqual({ ...lost, reason: 'no-task' });
    });

    it('is looked up only for worktrees the scan does not know, and not at all with --all', async () => {
      const h = seeded();
      closedLongAgo(h);
      const lookups: string[] = [];
      const getTask = h.tracker.getTask.bind(h.tracker);
      h.tracker.getTask = async issue => {
        lookups.push(`#${issue}`);
        return getTask(issue);
      };

      await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git, repoRoot: '/repo' });
      expect(lookups).toEqual(['#9']);

      lookups.length = 0;
      const all = await statusReport(h.ctx, { staleDays: 7, all: true, git: fakeGit().git, repoRoot: '/repo' });
      expect(lookups).toEqual([]);
      expect(all.orphanWorktrees).toContainEqual({ ...lost, reason: 'task-done' });
    });
  });

  it('takes the repository root from the context when the options have none', async () => {
    const h = seeded();
    h.ctx.repoRoot = '/repo';

    const report = await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git });

    expect(report.orphanWorktrees.map(orphan => orphan.reason)).toEqual(['task-done', 'no-task', 'detached']);
  });

  it('judges worktrees by the tasks of the whole scan, an issue without a readable state included as untracked', async () => {
    const h = seeded();
    h.tracker.issues.push({ number: 9, title: 'Hand-made', body: '', labels: ['sdlc:task'], open: true, onBoard: false });

    const report = await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git, repoRoot: '/repo' });

    expect(report.orphanWorktrees.find(orphan => orphan.branch === 'task/9-lost')?.reason).toBe('no-task');
  });

  it('is empty without a git runner or a repository root', async () => {
    const h = seeded();

    expect((await statusReport(h.ctx, { staleDays: 7 })).orphanWorktrees).toEqual([]);
    expect((await statusReport(h.ctx, { staleDays: 7, git: fakeGit().git })).orphanWorktrees).toEqual([]);
    expect((await statusReport(h.ctx, { staleDays: 7, repoRoot: '/repo' })).orphanWorktrees).toEqual([]);
  });

  it('is empty, and the rest of the report is still there, when git fails or cannot run', async () => {
    const h = seeded();
    const failing = fakeGit('', 128).git;
    const missing: GitRunner = async () => {
      throw new Error('git not found; install https://git-scm.com');
    };

    for (const git of [failing, missing]) {
      const report = await statusReport(h.ctx, { staleDays: 7, git, repoRoot: '/repo' });
      expect(report.orphanWorktrees).toEqual([]);
      expect(issues(report.byStatus.in_progress)).toEqual([1]);
    }
  });

  it('writes nothing: git is only asked to list', async () => {
    const h = seeded();
    const { git, calls } = fakeGit();
    const writes = h.tracker.writes;

    await statusReport(h.ctx, { staleDays: 7, git, repoRoot: '/repo' });

    expect(calls.every(call => call[0] === 'worktree' && call[1] === 'list')).toBe(true);
    expect(h.tracker.writes).toBe(writes);
  });
});
