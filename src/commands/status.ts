import type { Command } from 'commander';
import { displayPhase, STATUS_LABELS } from '../core/projection.js';
import type { ReconcileAction } from '../engine/reconcile.js';
import { statusReport, type StatusReport, type TaskSummary } from '../engine/status.js';
import type { OrphanWorktree } from '../git/worktrees.js';
import { createGitRunner } from '../install/provision.js';
import { runCommand, type ContextFactory } from './context.js';
import { taskIssueOf } from './githook.js';

const DEFAULT_STALE_DAYS = '7';

/** Listing worktrees reads local files only; a git that takes longer is not worth waiting for. */
const GIT_TIMEOUT_MS = 10_000;

/** `value` as a positive whole number of days; anything else (`0`, `-1`, `1.5`, `7d`, ...) is an error. */
export function parseStaleDays(value: string): number {
  const text = value.trim();
  const days = /^\d+$/.test(text) ? Number(text) : 0;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(`Invalid --stale-days "${value}" (expected a positive integer such as 7)`);
  }
  return days;
}

const days = (count: number): string => `${count} day${count === 1 ? '' : 's'}`;

function taskLine(task: TaskSummary): string {
  const details = [task.type, displayPhase(task.phase), `${task.ageDays}d`];
  if (task.pendingTargets.length > 0) details.push(`pending: ${[...task.pendingTargets].sort().join(', ')}`);
  return `  #${task.issue} ${task.title} (${details.join(', ')})`;
}

/** `#12 pr_merged: ...`; an action that concerns no single task (issue 0) has no issue part. */
function actionLine(action: ReconcileAction): string {
  return `  ${action.issue > 0 ? `#${action.issue} ` : ''}${action.kind}: ${action.detail}`;
}

/** `<path> (<branch>): <reason> - <what it means>`; a done task's line names the command that cleans up. */
function orphanLine(orphan: OrphanWorktree): string {
  const issue = taskIssueOf(orphan.branch);
  const meaning: Record<OrphanWorktree['reason'], string> = {
    'no-task': 'no tracked task has this branch',
    'task-done': `the task is done; run \`sdlc worktree finish ${issue ?? '<issue>'}\``,
    detached: 'HEAD is detached, so it is no task branch',
    prunable: 'its directory is gone',
  };
  const branch = orphan.branch === undefined ? '' : ` (${orphan.branch})`;
  return `  ${orphan.path}${branch}: ${orphan.reason} - ${meaning[orphan.reason]}`;
}

function section(heading: string, lines: string[]): string {
  return [`${heading} (${lines.length})`, ...lines].join('\n');
}

/**
 * Plain-text radar: the tasks grouped by status, then each attention section that has entries
 * (waiting on the owner, stale ones past `staleDays`, untracked issues, pending reconcile actions),
 * a line when something waits for `sdlc sync`, and the orphan worktrees last.
 */
export function describeStatus(report: StatusReport, staleDays: number): string {
  const groups = Object.entries(report.byStatus)
    .filter(([, tasks]) => tasks.length > 0)
    .map(([status, tasks]) =>
      section(STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status, tasks.map(taskLine)),
    );
  const blocks = groups.length > 0 ? [groups.join('\n')] : ['No tracked tasks.'];

  const attention: [string, string[]][] = [
    ['Waiting on the owner', report.waitingOnOwner.map(taskLine)],
    [`Awaiting deployment for more than ${days(staleDays)}`, report.staleAwaitingDeployment.map(taskLine)],
    [`Paused on the agent for more than ${days(staleDays)}`, report.stalePausedOnAgent.map(taskLine)],
    ['Untracked sdlc:task issues', report.untracked.map(task => `  #${task.issue} ${task.title}`)],
    ['Pending reconcile', report.pendingReconcile.map(actionLine)],
  ];
  for (const [heading, lines] of attention) {
    if (lines.length > 0) blocks.push(section(heading, lines));
  }
  const { outbox, gaps } = report.queued;
  if (outbox > 0 || gaps > 0) blocks.push(`Queued for sync: ${outbox} write(s), ${gaps} gap(s)`);
  if (report.orphanWorktrees.length > 0) blocks.push(['Orphan worktrees:', ...report.orphanWorktrees.map(orphanLine)].join('\n'));
  return blocks.join('\n\n');
}

/** Registers `sdlc status [--stale-days 7] [--all] [--json]`. */
export function registerStatusCommand(program: Command, makeContext: ContextFactory): void {
  program
    .command('status')
    .description('Show tasks by status, what waits on the owner, what is stale and what reconcile would change')
    .option(
      '--stale-days <days>',
      'flag tasks awaiting deployment or paused on the agent for longer than this many days',
      DEFAULT_STALE_DAYS,
    )
    .option('--all', 'also read tasks closed longer ago than reconcile.closed_lookback_days')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { staleDays: string; all?: boolean; json?: boolean }) => {
      let staleDays = 0;
      await runCommand(
        // A bad --stale-days is reported before the config is read or anything is asked of GitHub.
        () => {
          staleDays = parseStaleDays(options.staleDays);
          return makeContext();
        },
        options,
        ctx =>
          statusReport(ctx, {
            staleDays,
            all: options.all === true,
            // The main checkout's worktrees, listed by a git run there; a context without a root has none to list.
            ...(ctx.repoRoot === undefined ? {} : { git: createGitRunner(ctx.repoRoot, { timeoutMs: GIT_TIMEOUT_MS }) }),
          }),
        report => describeStatus(report, staleDays),
      );
    });
}
