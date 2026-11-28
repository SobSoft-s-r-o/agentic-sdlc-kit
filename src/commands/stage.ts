import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { renderStageSummary } from '../core/summary.js';
import { applyEvent } from '../core/stateMachine.js';
import type { Phase, TaskEvent, TaskState } from '../core/types.js';
import type { PostedComment } from '../tracker/types.js';
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
 * The comment an interrupted earlier run of this publish already posted, if any: the newest comment
 * by the tracker's own login, when its body equals `body` after trimming. A matching comment that
 * another comment by that login came after does not count, and neither does one by anybody else.
 * Without a known login nothing can be matched, so the comment is posted.
 */
async function alreadyPosted(
  ctx: CommandContext,
  issue: number,
  body: string,
): Promise<(PostedComment & { url: string }) | undefined> {
  const hint = 'the state was not changed';
  const login = await trackerStep('authenticatedLogin', issue, () => ctx.tracker.authenticatedLogin(), hint);
  if (login === undefined) return undefined;
  const comments = await trackerStep('listComments', issue, () => ctx.tracker.listComments(issue), hint);
  const newest = comments.filter(c => c.author.toLowerCase() === login.toLowerCase()).at(-1);
  return newest && newest.body.trim() === body.trim()
    ? { id: newest.id, createdAt: newest.createdAt, url: newest.url }
    : undefined;
}

/**
 * Publishes the stage result in `file` as a comment on the issue, then records the new revision,
 * published at the time GitHub created that comment (an owner's reply is then always newer).
 * With `needsApproval` the task pauses waiting on the owner. A failed comment leaves the state alone.
 * A re-run after a failure that came once the comment was posted (state still unchanged) finds that
 * comment, posts no second one and records the state against the first.
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
  const earlier = await alreadyPosted(ctx, issue, body);
  // The result is the plain task state, so the reuse is told on stderr: no second comment was posted.
  if (earlier) ctx.err?.(`stage publish: reused the stage summary already posted (${earlier.url})`);
  const posted =
    earlier ??
    (await trackerStep('postComment', issue, () => ctx.tracker.postComment(issue, body), 'the state was not changed'));
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
