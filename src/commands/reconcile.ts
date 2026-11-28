import type { Command } from 'commander';
import { reconcile, type ReconcileResult } from '../engine/reconcile.js';
import { parseIssueNumber, runCommand, type ContextFactory } from './context.js';

/** One line per action, then a count: `#12 pr_merged: PR #50 merged (final) as abc…`. */
export function describeReconcile(result: ReconcileResult): string {
  const lines = result.actions.map(action => `#${action.issue} ${action.kind}: ${action.detail}`);
  lines.push(`${result.actions.length} action(s), ${result.errors} error(s)`);
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
