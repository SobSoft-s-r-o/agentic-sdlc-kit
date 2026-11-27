import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { renderStageSummary } from '../core/summary.js';
import type { Phase, TaskState } from '../core/types.js';
import {
  commit,
  describeState,
  parseIssueNumber,
  parsePhase,
  runCommand,
  trackerStep,
  type CommandContext,
  type ContextFactory,
} from './context.js';

/** Starts `phase`: the task is in progress and waiting on the agent. */
export function stageStart(ctx: CommandContext, issue: number, phase: Phase): Promise<TaskState> {
  return commit(ctx, issue, { kind: 'phase_started', phase });
}

async function readSummary(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the stage summary ${file}: ${(error as Error).message}`);
  }
}

/**
 * Publishes the stage result in `file` as a comment on the issue, then records the new revision.
 * With `needsApproval` the task pauses waiting on the owner. A failed comment leaves the state alone.
 */
export async function stagePublish(
  ctx: CommandContext,
  issue: number,
  phase: Phase,
  input: { file: string; needsApproval: boolean },
): Promise<TaskState> {
  const markdown = await readSummary(input.file);
  return commit(
    ctx,
    issue,
    { kind: 'stage_published', phase, needsApproval: input.needsApproval },
    {
      beforeWrite: async next => {
        const body = renderStageSummary({
          phase,
          revision: next.stages[phase]?.revision ?? 1,
          markdown,
          needsApproval: input.needsApproval,
        });
        await trackerStep('postComment', issue, () => ctx.tracker.postComment(issue, body), 'the state was not changed');
      },
    },
  );
}

/** Registers `sdlc stage start|publish`. */
export function registerStageCommand(program: Command, makeContext: ContextFactory): void {
  const stage = program.command('stage').description('Start and publish task phases');

  stage
    .command('start')
    .description('Start a phase')
    .argument('<issue>', 'issue number')
    .argument('<phase>', 'phase to start')
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, phase: string, options: { json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => stageStart(ctx, parseIssueNumber(issue), parsePhase(phase)),
        describeState,
      );
    });

  stage
    .command('publish')
    .description('Post the result of a phase as an issue comment and record the revision')
    .argument('<issue>', 'issue number')
    .argument('<phase>', 'phase being published')
    .requiredOption('--file <path>', 'markdown file with the stage result')
    .option('--needs-approval', 'pause the task until the owner approves this result')
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, phase: string, options: { file: string; needsApproval?: boolean; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx =>
          stagePublish(ctx, parseIssueNumber(issue), parsePhase(phase), {
            file: options.file,
            needsApproval: options.needsApproval === true,
          }),
        describeState,
      );
    });
}
