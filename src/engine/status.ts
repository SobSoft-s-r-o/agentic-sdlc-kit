import type { CommandContext } from '../commands/context.js';
import { taskIssueOf } from '../commands/githook.js';
import type { Phase, Status, TaskState } from '../core/types.js';
import { listWorktrees, orphanWorktrees, type OrphanWorktree } from '../git/worktrees.js';
import type { GitRunner } from '../install/provision.js';
import { queuedCounts } from '../outbox/outbox.js';
import type { TaskScan, TrackedTask } from '../tracker/types.js';
import { lookbackScan, reconcile, type ReconcileAction } from './reconcile.js';

export interface TaskSummary {
  issue: number;
  title: string;
  status: Status;
  phase: Phase;
  /** The task type id from the state, also when that type is no longer enabled. */
  type: string;
  pendingTargets: string[];
  updatedAt: string;
  /** Whole days between `updatedAt` and now; never negative. */
  ageDays: number;
}

export interface StatusReport {
  /** Every status is present, in lifecycle order; tasks in a group are ordered by issue number. */
  byStatus: Record<Status, TaskSummary[]>;
  /** Tasks paused waiting on the owner, whatever their age. */
  waitingOnOwner: TaskSummary[];
  /** Tasks awaiting deployment for more than `staleDays` whole days. */
  staleAwaitingDeployment: TaskSummary[];
  /** Tasks paused waiting on the agent for more than `staleDays` whole days. */
  stalePausedOnAgent: TaskSummary[];
  /** `sdlc:task` issues without a readable state comment. */
  untracked: { issue: number; title: string }[];
  /** What a dry-run reconcile would change, plus its errors; one `error` when the dry run itself failed. */
  pendingReconcile: ReconcileAction[];
  /** What waits in the local queues for `sdlc sync`: commands that could not reach GitHub, and gaps the hooks logged. */
  queued: { outbox: number; gaps: number };
  /** Worktrees under `.worktrees/` that no live task needs; empty when git or the repository root is not known. */
  orphanWorktrees: OrphanWorktree[];
}

const STATUS_ORDER: readonly Status[] = [
  'ready',
  'in_progress',
  'blocked',
  'paused',
  'in_review',
  'awaiting_deployment',
  'done',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reconcile actions that would write nothing (an owner command that does not count, a task type
 * that is not enabled, an untracked issue, which `untracked` already lists); every other kind is
 * drift a reconcile would fix, or a problem.
 */
const QUIET_KINDS: ReadonlySet<ReconcileAction['kind']> = new Set([
  'ignored_approval',
  'skipped_unknown_type',
  'untracked',
]);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whole days from `updatedAt` to `nowMs`; a time in the future or one that cannot be read counts as 0. */
function ageInDays(updatedAt: string, nowMs: number): number {
  const age = Math.floor((nowMs - Date.parse(updatedAt)) / DAY_MS);
  return Number.isFinite(age) && age > 0 ? age : 0;
}

function summarize(task: TrackedTask, nowMs: number): TaskSummary {
  const { state } = task;
  return {
    issue: task.issue,
    title: task.title,
    status: state.status,
    phase: state.phase,
    type: state.type,
    pendingTargets: [...state.pendingTargets],
    updatedAt: state.updatedAt,
    ageDays: ageInDays(state.updatedAt, nowMs),
  };
}

const pausedOn = (state: TaskState, who: TaskState['waitingOn']): boolean =>
  state.status === 'paused' && state.waitingOn === who;

/**
 * The radar over all tracked tasks: tasks by status, what needs the owner, what has gone stale
 * (strictly more than `staleDays` whole days since the last update), `sdlc:task` issues the tool
 * cannot read, and what a dry-run reconcile would change. Writes nothing. Failing to read the
 * tasks fails the report; a failing dry-run reconcile only becomes the single `pendingReconcile`
 * entry, so the rest of the picture is still shown.
 *
 * `queued` counts what waits for `sdlc sync` in the main checkout's cache (nothing when the context has no
 * repository root).
 *
 * `orphanWorktrees` needs `git` (run in the main checkout) and the main checkout's root, which defaults to
 * the context's: without either it is empty, and so it is when git cannot list the worktrees. A worktree is
 * judged against the tasks this report reads; one whose branch none of them has is looked up by its issue
 * number, so that a task closed before the lookback and done still counts as `task-done`.
 *
 * Like reconcile, it reads the open tasks and those closed within `reconcile.closedLookbackDays`;
 * `all` reads every task, however long ago it closed.
 */
export async function statusReport(
  ctx: CommandContext,
  options: { staleDays: number; all?: boolean; git?: GitRunner; repoRoot?: string },
): Promise<StatusReport> {
  const now = ctx.now();
  const nowMs = Date.parse(now);
  const scan = await ctx.tracker.scanTasks(options.all ? {} : lookbackScan(ctx.cfg, now));
  const { tracked: tasks, untracked } = scan;

  const byStatus = Object.fromEntries(STATUS_ORDER.map(status => [status, [] as TaskSummary[]])) as Record<
    Status,
    TaskSummary[]
  >;
  const waitingOnOwner: TaskSummary[] = [];
  const staleAwaitingDeployment: TaskSummary[] = [];
  const stalePausedOnAgent: TaskSummary[] = [];
  for (const task of tasks) {
    const summary = summarize(task, nowMs);
    const { state } = task;
    // A hand-edited state comment may hold a status this version does not know; it still gets a group.
    (byStatus[state.status] ??= []).push(summary);
    const stale = summary.ageDays > options.staleDays;
    if (pausedOn(state, 'owner')) waitingOnOwner.push(summary);
    if (stale && state.status === 'awaiting_deployment') staleAwaitingDeployment.push(summary);
    if (stale && pausedOn(state, 'agent')) stalePausedOnAgent.push(summary);
  }

  return {
    byStatus,
    waitingOnOwner,
    staleAwaitingDeployment,
    stalePausedOnAgent,
    untracked: untracked.map(({ issue, title }) => ({ issue, title })),
    pendingReconcile: await pendingReconcile(ctx, scan),
    queued: ctx.repoRoot === undefined ? { outbox: 0, gaps: 0 } : await queuedCounts(ctx.repoRoot),
    orphanWorktrees: await orphanRadar(ctx, { ...options, all: options.all === true }, tasks),
  };
}

/**
 * The orphan worktrees, or none when git or the root is missing or git cannot list: the radar never fails the report.
 *
 * The scan holds the open tasks and those closed lately, so a branch it does not know may belong to a task that
 * closed long ago. Such a candidate is looked up by its issue number: a task that is done makes it `task-done`
 * (due for `sdlc worktree finish`), anything else (no such task, a lookup that fails) leaves it `no-task`.
 * With `all` the scan holds every task, so there is nothing to look up.
 */
async function orphanRadar(
  ctx: CommandContext,
  options: { all: boolean; git?: GitRunner; repoRoot?: string },
  tasks: TrackedTask[],
): Promise<OrphanWorktree[]> {
  const repoRoot = options.repoRoot ?? ctx.repoRoot;
  if (options.git === undefined || repoRoot === undefined) return [];
  let orphans: OrphanWorktree[];
  try {
    const known = new Map(tasks.map(task => [task.issue, { status: task.state.status }]));
    orphans = orphanWorktrees(await listWorktrees(options.git), repoRoot, known);
  } catch {
    return [];
  }
  if (options.all) return orphans;
  const judged: OrphanWorktree[] = [];
  for (const orphan of orphans) {
    judged.push(orphan.reason === 'no-task' && (await closedDone(ctx, orphan)) ? { ...orphan, reason: 'task-done' } : orphan);
  }
  return judged;
}

/** Whether the task named by the branch of `orphan` exists and is done; false when it cannot be read. */
async function closedDone(ctx: CommandContext, orphan: OrphanWorktree): Promise<boolean> {
  const issue = taskIssueOf(orphan.branch);
  if (issue === undefined) return false;
  try {
    return (await ctx.tracker.getTask(issue)).state.status === 'done';
  } catch {
    return false;
  }
}

async function pendingReconcile(ctx: CommandContext, scan: TaskScan): Promise<ReconcileAction[]> {
  try {
    // The scan just made is reused: one scan of the task issues per status run.
    const { actions } = await reconcile(ctx, { dryRun: true, scan });
    return actions.filter(action => !QUIET_KINDS.has(action.kind));
  } catch (error) {
    return [{ issue: 0, kind: 'error', detail: reasonOf(error) }];
  }
}
