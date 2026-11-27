import type { Command } from 'commander';
import { displayPhase, STATUS_LABELS } from '../core/projection.js';
import type { ReconcileAction } from '../engine/reconcile.js';
import { statusReport, type StatusReport, type TaskSummary } from '../engine/status.js';
import { runCommand, type ContextFactory } from './context.js';

const DEFAULT_STALE_DAYS = '7';

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

function section(heading: string, lines: string[]): string {
  return [`${heading} (${lines.length})`, ...lines].join('\n');
}

/**
 * Plain-text radar: the tasks grouped by status, then each attention section that has entries
 * (waiting on the owner, stale ones past `staleDays`, untracked issues, pending reconcile actions).
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
  return blocks.join('\n\n');
}

/** Registers `sdlc status [--stale-days 7] [--json]`. */
export function registerStatusCommand(program: Command, makeContext: ContextFactory): void {
  program
    .command('status')
    .description('Show tasks by status, what waits on the owner, what is stale and what reconcile would change')
    .option(
      '--stale-days <days>',
      'flag tasks awaiting deployment or paused on the agent for longer than this many days',
      DEFAULT_STALE_DAYS,
    )
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { staleDays: string; json?: boolean }) => {
      let staleDays = 0;
      await runCommand(
        makeContext,
        options,
        ctx => {
          staleDays = parseStaleDays(options.staleDays);
          return statusReport(ctx, { staleDays });
        },
        report => describeStatus(report, staleDays),
      );
    });
}
