import type { Command } from 'commander';
import { newTask, TransitionError } from '../core/stateMachine.js';
import { typeRegistry } from '../config/schema.js';
import { normalizeCommentUrl, recordedRefs, validateOwnerComment } from '../core/approvals.js';
import type { Approval, EndsOn, TaskState, TypeChange, WaitingOn } from '../core/types.js';
import { StateCommentError } from '../core/stateComment.js';
import { NoStateCommentError } from '../tracker/types.js';
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
 * the initial state, at the first phase of the type. With `issue`, adopts that existing issue
 * instead (see `adoptIssue`).
 */
export async function taskNew(
  ctx: CommandContext,
  input: { title?: string; summary?: string; type: string; body?: string; issue?: number },
): Promise<{ issue: number; url: string }> {
  if (input.issue !== undefined) return adoptIssue(ctx, { ...input, issue: input.issue });
  const title = input.title?.trim() ?? '';
  const summary = input.summary?.trim() ?? '';
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

/**
 * Starts tracking an existing issue that has no state comment: adds the `sdlc:task` and `type:<id>`
 * labels, puts it on the board and writes the initial state. The issue keeps its title and body;
 * the summary defaults to the title. Refused when the issue is already tracked or its state comment
 * cannot be read.
 */
async function adoptIssue(
  ctx: CommandContext,
  input: { issue: number; type: string; title?: string; summary?: string; body?: string },
): Promise<{ issue: number; url: string }> {
  const { issue } = input;
  if (input.title !== undefined) throw new Error('--title cannot be used with --issue: the issue keeps its own title');
  if (input.body !== undefined) throw new Error('--body cannot be used with --issue: the issue keeps its own body');
  const type = resolveType(ctx.cfg, input.type);
  const found = await trackerStep('getIssue', issue, () => ctx.tracker.getIssue(issue));
  try {
    const tracked = await ctx.tracker.getTask(issue);
    throw new Error(
      `#${issue} is already tracked (type "${tracked.state.type}"); use "sdlc task set-type" to change its type`,
    );
  } catch (error) {
    if (error instanceof StateCommentError) {
      throw new Error(`#${issue} has a state comment that cannot be read (${error.message}); fix or delete it first`);
    }
    if (!(error instanceof NoStateCommentError)) throw error;
  }

  const summary = input.summary?.trim() || found.title.trim();
  if (!summary) throw new Error('A task needs a summary');
  const untracked = `issue #${issue} has no task state yet; "sdlc status" lists it as untracked`;
  await trackerStep('setLabels', issue, () => ctx.tracker.setLabels(issue, ['sdlc:task', `type:${type.id}`], []));
  await trackerStep('addToBoard', issue, () => ctx.tracker.addToBoard(issue), untracked);
  const state: TaskState = { ...newTask({ issue, type, summary, now: ctx.now() }), phase: type.phases[0] };
  await saveAndSync(ctx, issue, state, type, found.open, { writeHint: untracked });
  return { issue, url: found.url };
}

/** Ends that need the owner beyond the merge. */
const OWNER_ENDS: readonly EndsOn[] = ['owner_acceptance', 'owner_confirmation'];

/**
 * Whether moving from `from` to `to` lets the task end with less: no deployment; the owner's
 * acceptance or confirmation replaced by a merge (alone, or as an alternative); or a merge alone
 * instead of merge-or-acceptance.
 */
const weakensEnd = (from: EndsOn, to: EndsOn): boolean =>
  (from === 'deploy' && to !== 'deploy') ||
  (OWNER_ENDS.includes(from) && (to === 'merge' || to === 'merge_or_acceptance')) ||
  (from === 'merge_or_acceptance' && to === 'merge');

/**
 * Moves the task to another enabled type: swaps the `type:` label and updates the state, resetting
 * the phase to the new type's first when the new type has no such phase. Not for done tasks, nor
 * for one awaiting deployment. A change that weakens how the task ends (`weakensEnd`) needs, in
 * enforce mode, an owner's `/approve type <new-id>` comment newer than the task's last change and
 * not recorded before; observe mode allows it without one, with a warning. The approval used (or
 * `unverified`) is recorded in `typeChanges`, so the comment never counts again.
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

  const now = ctx.now();
  const from = typeRegistry(ctx.cfg).get(state.type);
  let typeChange: TypeChange | undefined;
  if (from && weakensEnd(from.endsOn, type.endsOn)) {
    const change =
      `changing #${issue} from "${from.id}" (ends on ${from.endsOn}) to "${type.id}" (ends on ${type.endsOn}) ` +
      'weakens how it ends';
    const record = (approval: Pick<Approval, 'ref' | 'source'>): TypeChange => ({
      from: from.id,
      to: type.id,
      at: now,
      ref: approval.ref,
      source: approval.source,
    });
    if (input.commentUrl !== undefined) {
      typeChange = record(await requireTypeApproval(ctx, issue, state, type.id, input.commentUrl));
    } else if (ctx.cfg.mode === 'enforce') {
      throw new Error(`${change}; pass --comment-url with an owner's "/approve type ${type.id}" comment`);
    } else {
      ctx.err?.(`warning: ${change}; recorded without owner approval (unverified, observe mode)`);
      typeChange = record({ ref: 'unverified', source: 'unverified' });
    }
  }

  // The label goes first: if the state write then fails, running the same command again converges.
  const remove = state.type === type.id ? [] : [`type:${state.type}`];
  await trackerStep('setLabels', issue, () => ctx.tracker.setLabels(issue, [`type:${type.id}`], remove));
  // A phase the new type does not have would strand the task; start it over at the new type's first.
  const phase = type.phases.includes(state.phase) ? state.phase : type.phases[0];
  const next: TaskState = {
    ...state,
    type: type.id,
    phase,
    updatedAt: now,
    ...(typeChange && { typeChanges: [...(state.typeChanges ?? []), typeChange] }),
  };
  return persist(ctx, { task, type }, next);
}

/**
 * Checks `url` is an owner's `/approve type <typeId>` on the task (or its PRs), not recorded as any
 * approval before, and newer than the task's last change. Returns the approval to record.
 */
async function requireTypeApproval(
  ctx: CommandContext,
  issue: number,
  state: TaskState,
  typeId: string,
  url: string,
): Promise<Approval> {
  if (recordedRefs(state).has(normalizeCommentUrl(url))) {
    throw new Error(`comment ${url} is already recorded as an approval of #${issue}`);
  }
  const comment = await findComment(ctx, issue, url, () =>
    trackerStep('listTaskPrs', issue, () => ctx.tracker.listTaskPrs(issue)),
  );
  const { approval } = await validateOwnerComment({
    comment,
    action: 'approve',
    typeId,
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
  return approval;
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
    .description('Create a tracked task: an issue on the board at its first phase (or adopt an existing issue)')
    .option('--title <text>', 'issue title')
    .option('--summary <text>', 'one-line summary shown on the board (with --issue: defaults to its title)')
    .requiredOption('--type <id>', 'task type id')
    .option('--body <text>', 'issue body (defaults to the summary)')
    .option('--issue <number>', 'adopt this existing issue, which has no task state yet, instead of creating one')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (options: { title?: string; summary?: string; type: string; body?: string; issue?: string; json?: boolean }) => {
        await runCommand(
          makeContext,
          options,
          async ctx => {
            if (options.issue !== undefined) {
              return taskNew(ctx, { ...options, issue: parseIssueNumber(options.issue) });
            }
            if (options.title === undefined) throw new Error('A new task needs --title (or --issue to adopt an existing issue)');
            if (options.summary === undefined) throw new Error('A new task needs --summary');
            return taskNew(ctx, { ...options, issue: undefined });
          },
          created => `${options.issue !== undefined ? 'Tracking' : 'Created'} #${created.issue}: ${created.url}`,
        );
      },
    );

  task
    .command('set-type')
    .description('Change the task type of a task that is not done')
    .argument('<issue>', 'issue number')
    .argument('<type>', 'task type id')
    .option('--comment-url <url>', 'an owner\'s "/approve type <type>" comment; needed in enforce mode when the change weakens how the task ends')
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
