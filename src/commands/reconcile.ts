import type { Command } from 'commander';
import { reconcile, type ReconcileAction, type ReconcileResult } from '../engine/reconcile.js';
import { QUIET_KINDS } from '../engine/status.js';
import { parseIssueNumber, runCommand, type ContextFactory } from './context.js';

/** How the summary line counts the quiet kinds; the first one is the case this line exists for. */
const QUIET_LABELS: readonly (readonly [ReconcileAction['kind'], string])[] = [
  ['ignored_approval', 'ignored owner command(s)'],
  ['untracked', 'untracked issue(s)'],
  ['skipped_unknown_type', 'skipped task(s)'],
];

/**
 * One line per action that did something or went wrong (`#12 pr_merged: PR #50 merged (final) as
 * abc…`), then, when there were any, one line counting the quiet ones (`3 ignored owner
 * command(s); --json lists them`), then a count of the first. An owner command that does not count
 * is re-reported on every run (a stale `/approve` never becomes valid), so it is summarized here;
 * `--json` lists every action.
 */
export function describeReconcile(result: ReconcileResult): string {
  const real = result.actions.filter(action => !QUIET_KINDS.has(action.kind));
  const lines = real.map(action => `#${action.issue} ${action.kind}: ${action.detail}`);
  const quiet = QUIET_LABELS.map(([kind, label]) => ({
    count: result.actions.filter(action => action.kind === kind).length,
    label,
  }))
    .filter(({ count }) => count > 0)
    .map(({ count, label }) => `${count} ${label}`);
  if (quiet.length > 0) lines.push(`${quiet.join(', ')}; --json lists them`);
  lines.push(`${real.length} action(s), ${result.errors} error(s)`);
  return lines.join('\n');
}

/** Registers `sdlc reconcile [--dry-run] [--issue N] [--all] [--json]`; exits 1 when any action is an error. */
export function registerReconcileCommand(program: Command, makeContext: ContextFactory): void {
  program
    .command('reconcile')
    .description('Bring tasks, the board and issues in line with merges, approvals and deployments')
    .option('--dry-run', 'report what would change without writing anything')
    .option('--issue <number>', 'only reconcile this task')
    .option('--all', 'also read tasks closed longer ago than reconcile.closed_lookback_days')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { dryRun?: boolean; issue?: string; all?: boolean; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        async ctx => {
          const result = await reconcile(ctx, {
            dryRun: options.dryRun === true,
            all: options.all === true,
            ...(options.issue !== undefined && { issue: parseIssueNumber(options.issue) }),
          });
          if (result.errors > 0) process.exitCode = 1;
          return result;
        },
        describeReconcile,
      );
    });
}
