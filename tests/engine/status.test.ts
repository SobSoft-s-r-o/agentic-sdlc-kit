import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { statusReport } from '../../src/engine/status.js';
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
    expect(issues(Object.values(report.byStatus).flat())).toEqual([1]);
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
    });
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
    h.tracker.failNext('listTrackedTasks');

    await expect(statusReport(h.ctx, { staleDays: 7 })).rejects.toThrow(/listTrackedTasks/);
  });
});
