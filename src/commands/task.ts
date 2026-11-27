import type { Command } from 'commander';
import { newTask, TransitionError } from '../core/stateMachine.js';
import { typeRegistry } from '../config/schema.js';
import { validateOwnerComment } from '../core/approvals.js';
import type { EndsOn, TaskState, WaitingOn } from '../core/types.js';
import { findComment } from './approve.js';
import {
  commit,
  describeState,
  fetchTask,
  parseCheckpointStatus,
  parseIssueNumber,
  parseWaitingOn,
  persist,
  resolveType,
  runCommand,
  saveAndSync,
  trackerStep,
  type CommandContext,
  type ContextFactory,
} from './context.js';

/**
 * Creates the tracked issue (labels `sdlc:task` and `type:<id>`), adds it to the board and writes
 * the initial state, at the first phase of the type.
 */
export async function taskNew(
  ctx: CommandContext,
  input: { title: string; summary: string; type: string; body?: string },
): Promise<{ issue: number; url: string }> {
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title) throw new Error('A task needs a title');
  if (!summary) throw new Error('A task needs a summary');
  const type = resolveType(ctx.cfg, input.type);

  const created = await trackerStep('createIssue', undefined, () =>
    ctx.tracker.createIssue(title, input.body ?? summary, ['sdlc:task', `type:${type.id}`]),
  );
  const issue = created.number;
  const untracked = `issue #${issue} was created but has no task state yet; "sdlc status" lists it as untracked`;
  await trackerStep('addToBoard', issue, () => ctx.tracker.addToBoard(issue), untracked);
  const state: TaskState = { ...newTask({ issue, type, summary, now: ctx.now() }), phase: type.phases[0] };
  await saveAndSync(ctx, issue, state, type, true, { writeHint: untracked });
  return { issue, url: created.url };
}

/** Ends that need an owner, or a deployment, beyond the merge. */
const OWNER_ENDS: readonly EndsOn[] = ['owner_acceptance', 'owner_confirmation', 'merge_or_acceptance'];

/** Whether moving from `from` to `to` lets the task end with less: no deployment, or a merge alone. */
const weakensEnd = (from: EndsOn, to: EndsOn): boolean =>
  (from === 'deploy' && to !== 'deploy') || (OWNER_ENDS.includes(from) && to === 'merge');

/**
 * Moves the task to another enabled type: swaps the `type:` label and updates the state, resetting
 * the phase to the new type's first when the new type has no such phase. Not for done tasks, nor
 * for one awaiting deployment. A change that weakens how the task ends (dropping the deployment,
 * or the owner's acceptance or confirmation, for a merge) needs an owner's `/approve` comment newer
 * than the task's last change in enforce mode; observe mode allows it with a warning.
 */
export async function taskSetType(
  ctx: CommandContext,
  issue: number,
  typeId: string,
  input: { commentUrl?: string } = {},
): Promise<TaskState> {
  const type = resolveType(ctx.cfg, typeId);
  const task = await fetchTask(ctx, issue);
  const { state } = task;
  if (state.status === 'done') throw new TransitionError(`cannot change the type of #${issue}: the task is done`);
  if (state.status === 'awaiting_deployment') {
    throw new TransitionError(`cannot change the type of #${issue} while it is awaiting deployment`);
  }

  const from = typeRegistry(ctx.cfg).get(state.type);
  if (from && weakensEnd(from.endsOn, type.endsOn)) {
    const change =
      `changing #${issue} from "${from.id}" (ends on ${from.endsOn}) to "${type.id}" (ends on ${type.endsOn}) ` +
      'weakens how it ends';
    if (input.commentUrl !== undefined) {
      await requireOwnerApproval(ctx, issue, state, input.commentUrl);
    } else if (ctx.cfg.mode === 'enforce') {
      throw new Error(`${change}; pass --comment-url with an owner's /approve comment`);
    } else {
      ctx.err?.(`warning: ${change}; recorded without owner approval (unverified, observe mode)`);
    }
  }

  // The label goes first: if the state write then fails, running the same command again converges.
  const remove = state.type === type.id ? [] : [`type:${state.type}`];
  await trackerStep('setLabels', issue, () => ctx.tracker.setLabels(issue, [`type:${type.id}`], remove));
  // A phase the new type does not have would strand the task; start it over at the new type's first.
  const phase = type.phases.includes(state.phase) ? state.phase : type.phases[0];
  const next: TaskState = { ...state, type: type.id, phase, updatedAt: ctx.now() };
  return persist(ctx, { task, type }, next);
}

/** Checks `url` is an owner's `/approve` on the task (or its PRs), newer than the task's last change. */
async function requireOwnerApproval(ctx: CommandContext, issue: number, state: TaskState, url: string): Promise<void> {
  const comment = await findComment(ctx, issue, url, () =>
    trackerStep('listTaskPrs', issue, () => ctx.tracker.listTaskPrs(issue)),
  );
  const { approval } = await validateOwnerComment({
    comment,
    action: 'approve',
    cfg: ctx.cfg,
    login: () => trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin()),
  });
  const at = Date.parse(approval.at);
  const last = Date.parse(state.updatedAt);
  if (Number.isNaN(at) || Number.isNaN(last) || at <= last) {
    throw new Error(`comment ${url} at ${approval.at} is not newer than the task's last change at ${state.updatedAt}`);
  }
  if (approval.source === 'unverified') {
    ctx.err?.(`warning: comment ${url} is recorded as unverified (observe mode)`);
  }
}

export function taskCheckpoint(
  ctx: CommandContext,
  issue: number,
  input: {
    current?: string;
    next?: string;
    agent?: string;
    waitingOn?: WaitingOn;
    status?: 'in_progress' | 'blocked';
  },
): Promise<TaskState> {
  return commit(ctx, issue, {
    kind: 'checkpoint',
    currentStep: input.current,
    nextStep: input.next,
    agent: input.agent,
    waitingOn: input.waitingOn,
    status: input.status,
  });
}

/** Reopens a done task: back to its first phase, issue open again. */
export function taskReopen(ctx: CommandContext, issue: number): Promise<TaskState> {
  return commit(ctx, issue, { kind: 'reopened' });
}

/** Registers `sdlc task new|set-type|checkpoint|reopen`. */
export function registerTaskCommand(program: Command, makeContext: ContextFactory): void {
  const task = program.command('task').description('Create and update tracked tasks');

  task
    .command('new')
    .description('Create a tracked task: an issue on the board at its first phase')
    .requiredOption('--title <text>', 'issue title')
    .requiredOption('--summary <text>', 'one-line summary shown on the board')
    .requiredOption('--type <id>', 'task type id')
    .option('--body <text>', 'issue body (defaults to the summary)')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { title: string; summary: string; type: string; body?: string; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => taskNew(ctx, options),
        created => `Created #${created.issue}: ${created.url}`,
      );
    });

  task
    .command('set-type')
    .description('Change the task type of a task that is not done')
    .argument('<issue>', 'issue number')
    .argument('<type>', 'task type id')
    .option('--comment-url <url>', "an owner's /approve comment; needed in enforce mode when the change weakens how the task ends")
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, type: string, options: { commentUrl?: string; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => taskSetType(ctx, parseIssueNumber(issue), type, { commentUrl: options.commentUrl }),
        describeState,
      );
    });

  task
    .command('checkpoint')
    .description('Record progress: current and next step, agent, who is waited on, status')
    .argument('<issue>', 'issue number')
    .option('--current <text>', 'current step')
    .option('--next <text>', 'next step')
    .option('--agent <text>', 'agent working on the task, e.g. claude/developer')
    .option('--waiting-on <who>', 'owner, agent, external or none')
    .option('--status <status>', 'in_progress or blocked')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (
        issue: string,
        options: { current?: string; next?: string; agent?: string; waitingOn?: string; status?: string; json?: boolean },
      ) => {
        await runCommand(
          makeContext,
          options,
          ctx =>
            taskCheckpoint(ctx, parseIssueNumber(issue), {
              current: options.current,
              next: options.next,
              agent: options.agent,
              waitingOn: options.waitingOn === undefined ? undefined : parseWaitingOn(options.waitingOn),
              status: options.status === undefined ? undefined : parseCheckpointStatus(options.status),
            }),
          describeState,
        );
      },
    );

  task
    .command('reopen')
    .description('Reopen a done task')
    .argument('<issue>', 'issue number')
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, options: { json?: boolean }) => {
      await runCommand(makeContext, options, ctx => taskReopen(ctx, parseIssueNumber(issue)), describeState);
    });
}
