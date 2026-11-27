import type { CommandContext } from '../commands/context.js';
import type { Phase, Status, TaskState } from '../core/types.js';
import type { TaskScan, TrackedTask } from '../tracker/types.js';
import { reconcile, type ReconcileAction } from './reconcile.js';

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
 */
export async function statusReport(ctx: CommandContext, options: { staleDays: number }): Promise<StatusReport> {
  const nowMs = Date.parse(ctx.now());
  const scan = await ctx.tracker.scanTasks();
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
  };
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
