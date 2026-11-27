import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { renderStageSummary } from '../core/summary.js';
import { applyEvent } from '../core/stateMachine.js';
import type { Phase, TaskEvent, TaskState } from '../core/types.js';
import {
  commit,
  loadTask,
  persist,
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
 * Publishes the stage result in `file` as a comment on the issue, then records the new revision,
 * published at the time GitHub created that comment (an owner's reply is then always newer).
 * With `needsApproval` the task pauses waiting on the owner. A failed comment leaves the state alone.
 */
export async function stagePublish(
  ctx: CommandContext,
  issue: number,
  phase: Phase,
  input: { file: string; needsApproval: boolean },
): Promise<TaskState> {
  const markdown = await readSummary(input.file);
  const loaded = await loadTask(ctx, issue);
  const event: TaskEvent = { kind: 'stage_published', phase, needsApproval: input.needsApproval };
  // Checks the event before anything is posted, and gives the revision the comment names.
  const preview = applyEvent(loaded.task.state, event, loaded.type, ctx.now());
  const body = renderStageSummary({
    phase,
    revision: preview.stages[phase]?.revision ?? 1,
    markdown,
    needsApproval: input.needsApproval,
  });
  const posted = await trackerStep('postComment', issue, () => ctx.tracker.postComment(issue, body), 'the state was not changed');
  const next = applyEvent(loaded.task.state, event, loaded.type, posted.createdAt);
  return persist(ctx, loaded, next, { writeHint: 'the stage summary was posted; the state was not changed' });
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
