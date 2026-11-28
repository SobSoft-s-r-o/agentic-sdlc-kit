import { PHASES, typeRegistry, type Config } from '../config/schema.js';
import { displayPhase, projectTask, STATUS_LABELS, WAITING_ON_LABELS } from '../core/projection.js';
import { applyEvent } from '../core/stateMachine.js';
import { ConfigError } from '../core/taskTypes.js';
import type { EvidenceKind, Phase, TaskEvent, TaskState, TaskTypeDef, WaitingOn } from '../core/types.js';
import { enqueue, EXIT_TEMPFAIL, isTransportError, NO_QUEUE_ENV } from '../outbox/outbox.js';
import type { ExpectedStateComment, TrackedTask, Tracker } from '../tracker/types.js';
import { errorAsJson, formatCliError } from './errors.js';

export interface CommandContext {
  tracker: Tracker;
  cfg: Config;
  now: () => string;
  /**
   * Prints one result to stdout. The registered commander commands always pass a ready-to-print
   * string: human text, or the JSON document when `--json` is given.
   */
  out: (data: unknown) => void;
  /** Where error text goes without `--json`; defaults to stderr. */
  err?: (text: string) => void;
  /**
   * The root of the MAIN checkout, where `.sdlc/cache/` lives whichever worktree runs the command:
   * the outbox of a command that could not reach GitHub is queued there. Without it nothing is queued.
   */
  repoRoot?: string;
}

export type ContextFactory = () => CommandContext | Promise<CommandContext>;

/** A failed tracker call, naming the step that failed; `cause` is the tracker's own error. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly step: string,
    options?: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'CommandError';
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs one tracker call; a rejection is rethrown as a `CommandError` naming `step` and the issue,
 * with `hint` (what state things were left in) appended.
 */
export async function trackerStep<T>(
  step: string,
  issue: number | undefined,
  call: () => Promise<T>,
  hint?: string,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const where = issue === undefined ? '' : ` for #${issue}`;
    throw new CommandError(`${step} failed${where}: ${reasonOf(error)}${hint ? ` (${hint})` : ''}`, step, {
      cause: error,
    });
  }
}

export interface LoadedTask {
  task: TrackedTask;
  type: TaskTypeDef;
}

const enabledTypes = (cfg: Config): string => [...typeRegistry(cfg).keys()].join(', ');

/** The enabled task type `id`; a `ConfigError` listing the enabled types when it is unknown or disabled. */
export function resolveType(cfg: Config, id: string): TaskTypeDef {
  const type = typeRegistry(cfg).get(id);
  if (!type) throw new ConfigError(`Unknown or disabled task type "${id}" (enabled types: ${enabledTypes(cfg)})`);
  return type;
}

/** Reads the task and its state comment; does not need the task's type to be enabled. */
export function fetchTask(ctx: CommandContext, issue: number): Promise<TrackedTask> {
  return trackerStep('getTask', issue, () => ctx.tracker.getTask(issue));
}

/** Reads the task and resolves its type; a `ConfigError` when the type is no longer enabled. */
export async function loadTask(ctx: CommandContext, issue: number): Promise<LoadedTask> {
  const task = await fetchTask(ctx, issue);
  const type = typeRegistry(ctx.cfg).get(task.state.type);
  if (!type) {
    throw new ConfigError(
      `Task #${issue} has task type "${task.state.type}", which is not enabled (enabled types: ${enabledTypes(ctx.cfg)})`,
    );
  }
  return { task, type };
}

/**
 * Writes `state` (over the state comment `options.expected` when given, refusing if it changed since
 * it was read), then projects it: board fields, then the issue's open/closed state. The issue is
 * only touched when it is not already in the projected state. The first failing step is rethrown
 * by name; once the state comment is written, the message says reconcile can finish the rest.
 */
export async function saveAndSync(
  ctx: CommandContext,
  issue: number,
  state: TaskState,
  type: TaskTypeDef,
  issueOpen: boolean,
  options: { writeHint?: string; expected?: ExpectedStateComment } = {},
): Promise<void> {
  const projection = projectTask(state, type);
  const saved = `the state of #${issue} is saved; run "sdlc reconcile" to finish syncing`;
  await trackerStep(
    'writeState',
    issue,
    () => ctx.tracker.writeState(issue, state, options.expected),
    options.writeHint,
  );
  await trackerStep('syncFields', issue, () => ctx.tracker.syncFields(issue, projection.fields), saved);
  if (projection.issueOpen !== issueOpen) {
    await trackerStep(
      'setIssueOpen',
      issue,
      () => ctx.tracker.setIssueOpen(issue, projection.issueOpen, projection.closeReason),
      saved,
    );
  }
}

export interface CommitOptions {
  /**
   * Runs once the new state is known to be valid and before anything is written; a rejection
   * leaves the task untouched. Used to post the comment that must precede the state change.
   */
  beforeWrite?: (next: TaskState, previous: TaskState) => Promise<void>;
  /** Added to the error when the state write itself fails: what `beforeWrite` already did. */
  writeHint?: string;
}

/** The state comment of `task` as it was read, for `writeState` to check it is still the one. */
export const expectedOf = (task: TrackedTask): ExpectedStateComment => ({
  id: task.stateCommentId,
  updatedAt: task.stateCommentUpdatedAt,
});

/** Saves `next` for an already loaded task: `beforeWrite`, then `writeState` -> `syncFields` -> issue open/close. */
export async function persist(
  ctx: CommandContext,
  loaded: LoadedTask,
  next: TaskState,
  options: CommitOptions = {},
): Promise<TaskState> {
  await options.beforeWrite?.(next, loaded.task.state);
  await saveAndSync(ctx, loaded.task.issue, next, loaded.type, loaded.task.issueOpen, {
    writeHint: options.writeHint,
    expected: expectedOf(loaded.task),
  });
  return next;
}

/** Applies `event` to an already loaded task (throws `TransitionError` if it is not valid) and saves the result. */
export function commitLoaded(
  ctx: CommandContext,
  loaded: LoadedTask,
  event: TaskEvent,
  options: CommitOptions = {},
): Promise<TaskState> {
  return persist(ctx, loaded, applyEvent(loaded.task.state, event, loaded.type, ctx.now()), options);
}

/**
 * Loads the task, applies `event` and saves the new state: `writeState`, `syncFields`, then the
 * issue is opened or closed to match the projection. Rethrows the first failure with its step name.
 */
export async function commit(
  ctx: CommandContext,
  issue: number,
  event: TaskEvent,
  options: CommitOptions = {},
): Promise<TaskState> {
  return commitLoaded(ctx, await loadTask(ctx, issue), event, options);
}

export function parseIssueNumber(value: string, what = 'issue number'): number {
  const match = /^#?(\d+)$/.exec(value.trim());
  const number = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid ${what} "${value}" (expected a positive integer such as 12)`);
  }
  return number;
}

/** `value` as one of `choices`, ignoring case and treating `-` as `_` (`dry-run` for `dry_run`). */
export function parseChoice<T extends string>(value: string, choices: readonly T[], what: string): T {
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  const found = choices.find(choice => choice === normalized);
  if (!found) throw new Error(`Invalid ${what} "${value}" (expected one of: ${choices.join(', ')})`);
  return found;
}

export const parsePhase = (value: string): Phase => parseChoice(value, PHASES, 'phase');
export const parseEvidenceKind = (value: string): EvidenceKind =>
  parseChoice<EvidenceKind>(value, ['backup', 'dry_run'], 'evidence kind');
export const parseWaitingOn = (value: string): WaitingOn =>
  parseChoice<WaitingOn>(value, ['owner', 'agent', 'external', 'none'], 'waiting-on value');
export const parseCheckpointStatus = (value: string): 'in_progress' | 'blocked' =>
  parseChoice<'in_progress' | 'blocked'>(value, ['in_progress', 'blocked'], 'status');

/** A comma-separated target list as lowercase names without blanks or duplicates. */
export function parseTargetList(value: string): string[] {
  return [...new Set(value.split(',').map(part => part.trim().toLowerCase()).filter(Boolean))];
}

/** One line for human output: `#12: In progress, Planning, waiting on Agent`. */
export function describeState(state: TaskState): string {
  return `#${state.issue}: ${STATUS_LABELS[state.status]}, ${displayPhase(state.phase)}, waiting on ${WAITING_ON_LABELS[state.waitingOn]}`;
}

const printLine = (stream: NodeJS.WriteStream) => (text: string) => void stream.write(`${text}\n`);

export interface RunOptions {
  json?: boolean;
  /**
   * The command line (what follows `sdlc`) to queue for `sdlc sync` when GitHub cannot be reached.
   * Set only for the commands that are safe to run again later; see `QUEUEABLE` in `cli.ts`.
   */
  queueArgv?: string[];
}

const queueingOff = (): boolean => process.env[NO_QUEUE_ENV] === '1';

/** A queueable command that failed on an unreachable GitHub while queueing is off: try again later (exit 75). */
const tempFailure = (options: RunOptions, error: unknown): boolean =>
  options.queueArgv !== undefined && queueingOff() && isTransportError(error);

/**
 * Queues the command line when `error` is GitHub being unreachable and the command may queue
 * (`queueArgv`, a repository to queue in, queueing not turned off by `SDLC_NO_QUEUE=1`), and says so.
 * False when it did not queue: the failure is then reported as any other. A queue that cannot be
 * written is such a case; the error reported is the command's own.
 */
async function queueForSync(ctx: CommandContext, options: RunOptions, error: unknown): Promise<boolean> {
  const { queueArgv } = options;
  if (queueArgv === undefined || ctx.repoRoot === undefined || queueingOff()) return false;
  if (!isTransportError(error)) return false;
  let id: string;
  try {
    ({ id } = await enqueue(ctx.repoRoot, queueArgv, ctx.now()));
  } catch {
    return false;
  }
  ctx.out(
    options.json
      ? JSON.stringify({ queued: true, id }, null, 2)
      : `queued for \`sdlc sync\` (GitHub unreachable): sdlc ${queueArgv.join(' ')}`,
  );
  return true;
}

/**
 * Runs one CLI action: builds the context, runs `run` and prints its result (`describe` for human
 * output, the result as JSON with `--json`). Any failure is printed (to `err`, or as `{"error": ...}`
 * through `out` with `--json`), with the arguments and stderr of a failed `gh` call behind it, and
 * sets the exit code to 1; it never rejects.
 *
 * A command with `queueArgv` that fails because GitHub is unreachable is queued instead and exits 0
 * (`{"queued":true,"id":...}` with `--json`). With `SDLC_NO_QUEUE=1` (set by `sdlc sync` when it
 * replays) it is not queued and exits 75 (`EXIT_TEMPFAIL`).
 */
export async function runCommand<T, C extends CommandContext = CommandContext>(
  makeContext: () => C | Promise<C>,
  options: RunOptions,
  run: (ctx: C) => Promise<T>,
  describe: (result: T) => string,
): Promise<void> {
  let ctx: C | undefined;
  try {
    ctx = await makeContext();
    const result = await run(ctx);
    ctx.out(options.json ? JSON.stringify(result, null, 2) : describe(result));
  } catch (error) {
    if (ctx !== undefined && (await queueForSync(ctx, options, error))) return;
    process.exitCode = tempFailure(options, error) ? EXIT_TEMPFAIL : 1;
    if (options.json) (ctx?.out ?? printLine(process.stdout))(JSON.stringify(errorAsJson(error), null, 2));
    else (ctx?.err ?? printLine(process.stderr))(formatCliError(error));
  }
}
