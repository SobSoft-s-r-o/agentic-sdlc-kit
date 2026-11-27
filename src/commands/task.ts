import type { Command } from 'commander';
import { newTask, TransitionError } from '../core/stateMachine.js';
import type { TaskState, WaitingOn } from '../core/types.js';
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

/**
 * Moves the task to another enabled type: swaps the `type:` label and updates the state, resetting
 * the phase to the new type's first when the new type has no such phase. Not for done tasks.
 */
export async function taskSetType(ctx: CommandContext, issue: number, typeId: string): Promise<TaskState> {
  const type = resolveType(ctx.cfg, typeId);
  const task = await fetchTask(ctx, issue);
  const { state } = task;
  if (state.status === 'done') throw new TransitionError(`cannot change the type of #${issue}: the task is done`);

  // The label goes first: if the state write then fails, running the same command again converges.
  const remove = state.type === type.id ? [] : [`type:${state.type}`];
  await trackerStep('setLabels', issue, () => ctx.tracker.setLabels(issue, [`type:${type.id}`], remove));
  // A phase the new type does not have would strand the task; start it over at the new type's first.
  const phase = type.phases.includes(state.phase) ? state.phase : type.phases[0];
  const next: TaskState = { ...state, type: type.id, phase, updatedAt: ctx.now() };
  return persist(ctx, { task, type }, next);
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
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, type: string, options: { json?: boolean }) => {
      await runCommand(makeContext, options, ctx => taskSetType(ctx, parseIssueNumber(issue), type), describeState);
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
