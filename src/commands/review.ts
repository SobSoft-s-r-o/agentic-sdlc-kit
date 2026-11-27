import type { Command } from 'commander';
import { targetByName } from '../config/schema.js';
import { parsePrBody } from '../core/prBody.js';
import type { TaskState } from '../core/types.js';
import {
  commitLoaded,
  describeState,
  loadTask,
  parseIssueNumber,
  parseTargetList,
  runCommand,
  trackerStep,
  type CommandContext,
  type ContextFactory,
} from './context.js';

/**
 * Hands the task over for review with pull request `pr`. The PR must be linked to the task
 * (`Related to #<issue>`); its `Scope:` line decides partial or final. Targets come from
 * `input.targets`, else from the PR's `Targets:` line, and must be configured targets when the
 * task type requires targets.
 */
export async function reviewHandoff(
  ctx: CommandContext,
  issue: number,
  input: { pr: number; targets?: string[] },
): Promise<TaskState> {
  const loaded = await loadTask(ctx, issue);
  // Read directly: the PR search index can lag behind a PR opened moments ago.
  const pr = await trackerStep('getPr', issue, () => ctx.tracker.getPr(input.pr));
  if (!pr) throw new Error(`PR #${input.pr} was not found`);
  if (!parsePrBody(pr.body).issues.includes(issue)) {
    throw new Error(`PR #${input.pr} is not linked to #${issue} (add "Related to #${issue}" to its body)`);
  }

  const info = parsePrBody(pr.body);
  if (!info.scopeRecognized) {
    throw new Error(`PR #${pr.number} has a "Scope:" line with no recognised value (accepted: "Scope: partial", "Scope: final")`);
  }

  const targets = input.targets && input.targets.length > 0 ? input.targets : info.targets;
  if (loaded.type.targetsRequired) {
    for (const target of targets) targetByName(ctx.cfg, target);
  }

  return commitLoaded(ctx, loaded, { kind: 'review_handoff', pr: pr.number, scope: info.scope, targets });
}

/** Registers `sdlc review handoff`. */
export function registerReviewCommand(program: Command, makeContext: ContextFactory): void {
  const review = program.command('review').description('Hand tasks over for review');

  review
    .command('handoff')
    .description('Hand the task over for review with a linked pull request')
    .argument('<issue>', 'issue number')
    .requiredOption('--pr <number>', 'pull request number; its body must say "Related to #<issue>"')
    .option('--targets <list>', "comma-separated targets; defaults to the PR body's Targets line")
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, options: { pr: string; targets?: string; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx =>
          reviewHandoff(ctx, parseIssueNumber(issue), {
            pr: parseIssueNumber(options.pr, 'pull request number'),
            targets: options.targets === undefined ? undefined : parseTargetList(options.targets),
          }),
        describeState,
      );
    });
}
