import { dirname, relative, sep } from 'node:path';
import type { Command } from 'commander';
import { typeRegistry, type Config } from '../config/schema.js';
import { APPROVAL_ACTIONS, normalizeCommentUrl, recordedRefs, type ApprovalAction } from '../core/approvals.js';
import { editsAllowed } from '../core/edits.js';
import { parseOwnerCommand } from '../core/ownerCommand.js';
import type { TaskState, TaskTypeDef } from '../core/types.js';
import { reconcile } from '../engine/reconcile.js';
import { emptyOutput, renderOutput } from '../hooks/output.js';
import { HookPayloadError, normalizePayload } from '../hooks/payload.js';
import {
  appendJsonLine,
  GAPS_FILE,
  OUTBOX_FILE,
  PROMPTS_FILE,
  readJsonFile,
  readJsonLines,
  TASK_CACHE_FILE,
  writeJsonFile,
  type LoggedGap,
  type LoggedPrompt,
} from '../hooks/localLog.js';
import {
  decide,
  editViolations,
  needsTask,
  subagentViolation,
  type PathCheck,
  type Violation,
} from '../hooks/policy.js';
import { checkoutOf, mainRootOf, realPathOf, type Checkout } from '../hooks/resolve.js';
import {
  isBareCancel,
  pendingActions,
  promptApprover,
  promptRef,
  promptSha256,
  sessionContext,
} from '../hooks/session.js';
import { shellViolations } from '../hooks/shell.js';
import {
  HOOK_EVENTS,
  HOOK_HARNESSES,
  type HookEvent,
  type HookEventName,
  type HookHarness,
  type HookOutcome,
  type ToolCall,
} from '../hooks/types.js';
import type { GitRunner } from '../install/provision.js';
import type { TrackedTask, Tracker } from '../tracker/types.js';
import { applyApproval } from './approve.js';
import { CommandError, loadTask, trackerStep, type CommandContext, type LoadedTask } from './context.js';
import { DeadlineError, deadlineOf, isMissingTaskError, oneLine, type Deadline } from './githook.js';

/**
 * `sdlc hook <harness> <event>`: the entrypoint a harness runs for its hooks (through the launcher
 * `.sdlc/hooks/run.sh`). It reads the harness's payload on stdin, applies the rules by mode and
 * prints the harness's answer on stdout, and nothing else. It exits 0 in every case: a block is
 * protocol output, never an exit code.
 *
 * The hook never gets in the way of work because of a problem of its own. Anything that goes wrong
 * (stdin that is not a payload, no config, git that cannot run, an unexpected exception) prints one
 * stderr line `sdlc: hook skipped: <reason>` and allows. Reading the task of an edit is the one
 * thing that may fail while the hook goes on: that is handled degradation (a warning, the edit is
 * allowed), not a skipped hook, and so is a log file that cannot be written.
 *
 * `session-start` tells the agent which task its branch has, and starts `sdlc sync` when something
 * waits in the local queue. `prompt` records the prompt by its hash (never its text) and reads it for
 * an owner command: the owner's `/approve`, `/accept`, `/ran` or `/cancel <reason>` typed in a prompt
 * is recorded as an approval of source `prompt`. Only the prompt event does that, and never one from
 * a subagent. Every tracker call of these two events runs under the one shared deadline.
 */

/** Everything the hook touches outside its own process; the real one is built in `cli.ts`. */
export interface HookContext {
  /** The working directory of the hook process. Rules use the `cwd` of the payload instead. */
  cwd: string;
  /** The payload the harness writes on stdin. */
  readStdin(): Promise<string>;
  /** The config of the repository whose root is `root`: `undefined` when there is none, a throw when it is invalid. */
  loadConfig(root: string): Config | undefined;
  /** Called only when an event needs a task (an edit that is not cached, a session start or an approval prompt). */
  makeTracker(cfg: Config, root: string): Tracker;
  /** Git, run in `cwd`. */
  gitFor(cwd: string): GitRunner;
  /** The current time, ISO 8601. */
  now(): string;
  /** Writes protocol output to stdout (called at most once). */
  out(text: string): void;
  /** Writes one line to stderr. */
  err(text: string): void;
  /** Starts `sdlc sync` in the background for the repository at `root` (the session-start event uses it). */
  spawnSync?(root: string): void;
  /** How long all the task reads of one hook may take in total; defaults to `DEFAULT_DEADLINE_MS`. */
  deadlineMs?: number;
  /**
   * Ends the process with `code`. Called, after everything is printed, only when a task read was
   * abandoned on its deadline: that read is still running and would keep the process, and so the
   * harness, waiting. Without it the process ends by itself.
   */
  exit?(code: number): void;
}

/**
 * Longest the hook waits, in all, for GitHub. The rendered `pre-tool` timeout is 15 s, and the git
 * calls come first: the checkout of the cwd and the checkout of an edited file, two calls each, one
 * after the other (`4 * GIT_TIMEOUT_MS + DEFAULT_DEADLINE_MS` stays under it).
 */
export const DEFAULT_DEADLINE_MS = 6000;
/** Longest one git call of the hook may take; the real context kills a slower git (see `createGitRunner`). */
export const GIT_TIMEOUT_MS = 2000;
/** How long a cached task state, read while edits were allowed, is trusted. */
export const TASK_CACHE_TTL_MS = 10 * 60_000;

const NO_OUTCOME: HookOutcome = { context: [], warnings: [] };

/** One line for the stderr skip message: white space collapsed, and not unreasonably long. */
function reasonOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return text === '' ? 'unexpected error' : text.slice(0, 300);
}

/** A violation, and the task issue it was found for. */
type FoundViolation = Violation & { issue?: number };

/** What reading the task behind an edited file gave. */
type TaskRead = Pick<PathCheck, 'lookup' | 'state' | 'type'>;

/** The cache file: task states read while edits were allowed, by issue. */
type TaskCache = Record<string, { at: string; state: TaskState } | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The tasks the edit rule reads, from the cache or from the tracker, once per issue, under one deadline. */
class TaskReader {
  private readonly pending = new Map<number, Promise<TaskRead>>();
  /** States read from the tracker in which edits are allowed: the ones worth caching. */
  private readonly learned = new Map<number, TaskState>();
  private readonly types: Map<string, TaskTypeDef>;
  private tracker: Tracker | undefined;
  private cache: Promise<TaskCache> | undefined;
  /** Where the cache lives: the main checkout, shared by all its worktrees. */
  private readonly cacheRoot: string;

  constructor(
    private readonly ctx: HookContext,
    private readonly checkout: Checkout,
    private readonly cfg: Config,
    private readonly deadline: Deadline,
  ) {
    this.types = typeRegistry(cfg);
    this.cacheRoot = mainRootOf(checkout);
  }

  read(issue: number): Promise<TaskRead> {
    let read = this.pending.get(issue);
    if (read === undefined) {
      read = this.readOnce(issue);
      this.pending.set(issue, read);
    }
    return read;
  }

  /** Writes what was learned from the tracker (only allowed states) to the cache; never fails. */
  async remember(): Promise<void> {
    if (this.learned.size === 0) return;
    try {
      const at = this.ctx.now();
      const entries = { ...(await this.cached()) };
      for (const [issue, state] of this.learned) entries[String(issue)] = { at, state };
      await writeJsonFile(this.cacheRoot, TASK_CACHE_FILE, entries);
    } catch {
      // The cache only saves a GitHub read; a read-only checkout works without it.
    }
  }

  private async readOnce(issue: number): Promise<TaskRead> {
    let state = await this.fromCache(issue);
    const fresh = state === undefined;
    if (state === undefined) {
      try {
        const task = await this.deadline.run(() => this.trackerOf().getTask(issue));
        state = task.state;
      } catch (error) {
        // A state comment that cannot be read is no 'none': that would block the edit on a read problem.
        return { lookup: isMissingTaskError(error) ? 'none' : 'failed' };
      }
    }
    const type = this.types.get(state.type);
    // A task of a type this config does not define cannot be judged; that is a task that cannot be read.
    if (type === undefined) return { lookup: 'failed' };
    if (fresh && editsAllowed(state, type).allowed) this.learned.set(issue, state);
    return { lookup: 'ok', state, type };
  }

  private trackerOf(): Tracker {
    this.tracker ??= this.ctx.makeTracker(this.cfg, this.checkout.root);
    return this.tracker;
  }

  /** The cached state of `issue` when it is younger than the TTL (and not from the future). */
  private async fromCache(issue: number): Promise<TaskState | undefined> {
    const entry = (await this.cached())[String(issue)];
    if (!isRecord(entry) || typeof entry.at !== 'string' || !isRecord(entry.state)) return undefined;
    const age = Date.parse(this.ctx.now()) - Date.parse(entry.at);
    const state = entry.state as unknown as TaskState;
    return age >= 0 && age < TASK_CACHE_TTL_MS && state.issue === issue && typeof state.type === 'string'
      ? state
      : undefined;
  }

  private cached(): Promise<TaskCache> {
    this.cache ??= readJsonFile<unknown>(this.cacheRoot, TASK_CACHE_FILE).then(
      value => (isRecord(value) ? (value as TaskCache) : {}),
      () => ({}),
    );
    return this.cache;
  }
}

interface Judgement {
  violations: FoundViolation[];
  /** Notes that do not block (a task that could not be read). */
  warnings: string[];
}

interface HookEnv {
  ctx: HookContext;
  event: HookEvent;
  /** The checkout of the event's `cwd`: its root holds the config and the local files. */
  checkout: Checkout;
  cfg: Config;
  deadline: Deadline;
}

const posixPath = (path: string): string => path.split(sep).join('/');

/** Whether `path` is `dir` or lies below it (both absolute and normalized). */
const isInside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/**
 * The edit rule over every file of an edit. Each file is judged in the checkout that holds it, so
 * a file in another worktree than the `cwd` is judged by that worktree's branch and task, and its
 * path is relative to that worktree's root. A file in no checkout of this repository is no concern
 * of ours. A file in the git directory of the repository is a `.git/...` path, which the edit rule
 * protects. The task is read only for a file that needs one.
 */
async function judgeEdit(env: HookEnv, tool: Extract<ToolCall, { category: 'edit' }>): Promise<Judgement> {
  const { ctx, checkout: root, cfg } = env;
  const reader = new TaskReader(ctx, root, cfg, env.deadline);

  const checkouts = new Map<string, Promise<Checkout | undefined>>();
  const checkoutOfDir = (dir: string): Promise<Checkout | undefined> => {
    let found = checkouts.get(dir);
    if (found === undefined) {
      found = checkoutOf(dir, ctx.gitFor);
      checkouts.set(dir, found);
    }
    return found;
  };

  const checks = await Promise.all(
    tool.paths.map(async (path): Promise<PathCheck> => {
      const real = realPathOf(path);
      // The git directory is no work tree, so git cannot name a checkout for it; it is judged here,
      // under the task of the checkout the agent works in.
      if (isInside(real, root.commonDir)) {
        return {
          path,
          inProject: true,
          relPath: `.git/${posixPath(relative(root.commonDir, real))}`,
          lookup: 'none',
          ...(root.issue === undefined ? {} : { issue: root.issue }),
          ...(root.branch === undefined ? {} : { branch: root.branch }),
        };
      }
      const holder = await checkoutOfDir(dirname(real));
      if (holder === undefined || holder.commonDir !== root.commonDir) {
        return { path, inProject: false, lookup: 'none' };
      }
      const relPath = posixPath(relative(holder.root, real));
      const known = {
        path,
        inProject: true,
        relPath,
        ...(holder.issue === undefined ? {} : { issue: holder.issue }),
        ...(holder.branch === undefined ? {} : { branch: holder.branch }),
      };
      if (holder.issue === undefined || !needsTask(relPath)) return { ...known, lookup: 'none' };
      return { ...known, ...(await reader.read(holder.issue)) };
    }),
  );
  await reader.remember();

  // One file at a time, so each violation keeps the issue of its own file.
  const violations = new Map<string, FoundViolation>();
  const warnings = new Set<string>();
  for (const check of checks) {
    const found = editViolations([check], cfg.mode);
    for (const violation of found.violations) {
      const key = `${violation.rule}:${violation.text}`;
      if (!violations.has(key)) {
        violations.set(key, { ...violation, ...(check.issue === undefined ? {} : { issue: check.issue }) });
      }
    }
    for (const warning of found.warnings) warnings.add(warning);
  }
  return { violations: [...violations.values()], warnings: [...warnings] };
}

/** The violations of a shell command or a subagent dispatch carry the issue of the `cwd` checkout. */
function judgeOther(env: HookEnv, tool: Exclude<ToolCall, { category: 'edit' }>): Judgement {
  const found =
    tool.category === 'shell'
      ? shellViolations(tool.command)
      : tool.category === 'subagent'
        ? [subagentViolation(tool)].filter((violation): violation is Violation => violation !== undefined)
        : [];
  const { issue } = env.checkout;
  return {
    violations: found.map(violation => ({ ...violation, ...(issue === undefined ? {} : { issue }) })),
    warnings: [],
  };
}

async function preTool(env: HookEnv): Promise<{ outcome: HookOutcome; gaps: LoggedGap[] }> {
  const { tool } = env.event;
  if (tool === undefined) throw new HookPayloadError('pre-tool payload has no tool');
  const judgement = tool.category === 'edit' ? await judgeEdit(env, tool) : judgeOther(env, tool);

  const outcome = decide(judgement.violations, env.cfg.mode, judgement.warnings);
  const gaps = judgement.violations.map(
    (violation): LoggedGap => ({
      at: env.ctx.now(),
      rule: violation.rule,
      text: violation.text,
      harness: env.event.harness,
      blocked: outcome.block !== undefined,
      ...(violation.issue === undefined ? {} : { issue: violation.issue }),
    }),
  );
  return { outcome, gaps };
}

// -- session-start and prompt -------------------------------------------------------------------------

const asContext = (...context: string[]): HookOutcome => ({ context, warnings: [] });

/** `tracker` with every call run under the hook's shared deadline, so nothing asked of GitHub outlasts it. */
function boundedTracker(tracker: Tracker, deadline: Deadline): Tracker {
  return new Proxy(tracker, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => deadline.run(() => method.apply(target, args));
    },
  });
}

/** What the commands the hook borrows (`reconcile`, `applyApproval`) run on: the bounded tracker, and no output. */
function commandContextOf(env: HookEnv): CommandContext {
  return {
    tracker: boundedTracker(env.ctx.makeTracker(env.cfg, env.checkout.root), env.deadline),
    cfg: env.cfg,
    now: env.ctx.now,
    out: () => undefined,
    err: () => undefined,
  };
}

/** Whether `error`, or something it was caused by, is a call abandoned on the deadline. */
function timedOut(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (current instanceof DeadlineError) return true;
    current = current.cause;
  }
  return false;
}

/** How many lines wait in the local queues for `sdlc sync`; a file that cannot be read counts as empty. */
async function queuedWork(root: string): Promise<{ outbox: number; gaps: number }> {
  const count = async (file: string): Promise<number> => {
    try {
      return (await readJsonLines(root, file)).length;
    } catch {
      return 0;
    }
  };
  return { outbox: await count(OUTBOX_FILE), gaps: await count(GAPS_FILE) };
}

/**
 * The task of the branch and what a reconcile would do for it, as context for the agent. Starts
 * `sdlc sync` when something is queued. A task that cannot be read is said so; a reconcile that
 * cannot be asked is left out.
 */
async function sessionStart(env: HookEnv): Promise<HookOutcome> {
  const { ctx, checkout, cfg } = env;
  const mainRoot = mainRootOf(checkout);
  const queued = await queuedWork(mainRoot);
  // Only a sync that was started is said to be running; otherwise the agent is told to run it.
  let syncRunning = false;
  if (queued.outbox + queued.gaps > 0 && ctx.spawnSync !== undefined) {
    try {
      ctx.spawnSync(mainRoot);
      syncRunning = true;
    } catch (error) {
      ctx.err(`sdlc: warning: could not start sdlc sync in the background (${oneLine(reasonOf(error))})`);
    }
  }

  const { issue, branch } = checkout;
  if (issue === undefined) return asContext(...sessionContext({ cfg, branch, pending: 0, queued, syncRunning }));

  const commandCtx = commandContextOf(env);
  let task: TrackedTask | undefined;
  let unreadable: number | undefined;
  try {
    task = await commandCtx.tracker.getTask(issue);
  } catch (error) {
    if (!isMissingTaskError(error)) unreadable = issue;
  }

  let pending = 0;
  if (task !== undefined) {
    try {
      pending = pendingActions(await reconcile(commandCtx, { dryRun: true, issue })) ?? 0;
    } catch {
      // The count is a courtesy: without it the line is left out.
    }
  }
  return asContext(
    ...sessionContext({
      cfg,
      ...(branch === undefined ? {} : { branch }),
      ...(task === undefined ? {} : { task }),
      ...(unreadable === undefined ? {} : { unreadable }),
      pending,
      queued,
      syncRunning,
    }),
  );
}

/** Appends the prompt's hash, never its text, to the prompt record; a record that cannot be written is skipped. */
async function recordPrompt(env: HookEnv, prompt: string): Promise<void> {
  const { event, checkout } = env;
  const record: LoggedPrompt = {
    at: env.ctx.now(),
    harness: event.harness,
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.promptId === undefined ? {} : { promptId: event.promptId }),
    ...(checkout.issue === undefined ? {} : { issue: checkout.issue }),
    sha256: promptSha256(prompt),
  };
  try {
    await appendJsonLine(mainRootOf(checkout), PROMPTS_FILE, record);
  } catch {
    // The record is a trail, not a rule: a read-only checkout must not stop the prompt.
  }
}

const isApprovalAction = (action: string): action is ApprovalAction =>
  (APPROVAL_ACTIONS as readonly string[]).includes(action);

const NO_TASK_FOR_APPROVAL = 'sdlc: no task on this branch; the approval was not recorded.';
const BARE_CANCEL = 'sdlc: approval not recorded: /cancel needs a reason on the same line, as in "/cancel no longer needed".';
const GITHUB_UNREACHABLE = 'sdlc: could not reach GitHub; approval not recorded, ask again or approve by comment';

/**
 * The owner's command in the prompt of the human, recorded as the owner's decision. `undefined`
 * when the prompt is no approval command; otherwise the line to tell the agent. Only a prompt is
 * ever read for this: what an agent writes in a tool call is never an approval.
 */
async function promptApproval(env: HookEnv, prompt: string): Promise<string | undefined> {
  const command = parseOwnerCommand(prompt);
  if (command === null) return isBareCancel(prompt) ? BARE_CANCEL : undefined;
  // `/merge` is no approval, and `/approve type <id>` approves a type change, which only a comment can record.
  if (!isApprovalAction(command.action) || command.typeId !== undefined) return undefined;
  const { action } = command;
  const { issue } = env.checkout;
  if (issue === undefined) return NO_TASK_FOR_APPROVAL;

  try {
    const ctx = commandContextOf(env);
    let loaded: LoadedTask;
    try {
      loaded = await loadTask(ctx, issue);
    } catch (error) {
      if (error instanceof CommandError && isMissingTaskError(error.cause)) return NO_TASK_FOR_APPROVAL;
      throw error;
    }
    const { state } = loaded.task;

    // The same prompt of the same session is one decision, however often it is delivered. Only an
    // `approve` is about a stage (the current one); the other decisions are about the task.
    const stage = action === 'approve' ? state.phase : undefined;
    const ref = promptRef(
      env.event.harness,
      env.event.sessionId,
      env.event.promptId,
      stage === undefined ? action : `${action}-${stage}`,
      prompt,
    );
    const target = stage === undefined ? '' : ` (${stage})`;
    if (recordedRefs(state).has(normalizeCommentUrl(ref))) {
      return `sdlc: this approval was already recorded for #${issue}${target}.`;
    }

    // The prompt comes from the human at the keyboard: with one owner it is that owner, whatever login gh runs as.
    const login =
      env.cfg.owners.length === 1
        ? undefined
        : await trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin());
    const approver = promptApprover(env.cfg, login);
    if ('refused' in approver) return `sdlc: ${approver.refused}`;

    await applyApproval(
      ctx,
      issue,
      { action, ...(command.reason === undefined ? {} : { reason: command.reason }) },
      { source: 'prompt', ref, by: approver.by, at: env.ctx.now() },
      loaded,
    );
    return `sdlc: recorded the owner's ${action} for #${issue}${target} from this prompt.`;
  } catch (error) {
    if (timedOut(error)) return GITHUB_UNREACHABLE;
    return `sdlc: approval not recorded: ${oneLine(reasonOf(error))}`;
  }
}

/** Records the prompt, then reads it for an owner command. A prompt from a subagent is neither. */
async function promptEvent(env: HookEnv): Promise<HookOutcome> {
  const { event } = env;
  if (event.inSubagent || event.prompt === undefined) return NO_OUTCOME;
  await recordPrompt(env, event.prompt);
  const line = await promptApproval(env, event.prompt);
  return line === undefined ? NO_OUTCOME : asContext(line);
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HookPayloadError('stdin is not valid JSON');
  }
}

/** Every step that can throw; what it throws is the reason the hook is skipped. Gives the stdout text. */
async function answer(
  harness: HookHarness,
  eventName: HookEventName,
  ctx: HookContext,
  deadline: Deadline,
): Promise<string> {
  const event = normalizePayload(harness, eventName, parsePayload(await ctx.readStdin()));
  const checkout = await checkoutOf(event.cwd, ctx.gitFor);
  if (checkout === undefined) throw new Error(`${event.cwd} is not inside a git repository`);
  const cfg = ctx.loadConfig(checkout.root);
  if (cfg === undefined) throw new Error(`no sdlc.config.yaml in ${checkout.root}`);

  const env: HookEnv = { ctx, event, checkout, cfg, deadline };
  let outcome = NO_OUTCOME;
  let gaps: LoggedGap[] = [];
  if (event.event === 'pre-tool') ({ outcome, gaps } = await preTool(env));
  else if (event.event === 'session-start') outcome = await sessionStart(env);
  else outcome = await promptEvent(env);

  try {
    // In order, so a reader sees the lines as the rules found them.
    for (const gap of gaps) await appendJsonLine(mainRootOf(checkout), GAPS_FILE, gap);
  } catch {
    // A log that cannot be written must not turn a block into an allow.
  }
  return renderOutput(harness, eventName, outcome);
}

/** Prints the skip line and the harness's "nothing to say" answer. */
function skip(ctx: Pick<HookContext, 'out' | 'err'>, harness: HookHarness | undefined, reason: string): void {
  ctx.err(`sdlc: hook skipped: ${reason}`);
  const text = harness === undefined ? '' : emptyOutput(harness);
  if (text !== '') ctx.out(text);
}

/** Runs one hook event: reads the payload, applies the rules and prints the answer. Always resolves to 0. */
export async function runHook(harness: HookHarness, event: HookEventName, ctx: HookContext): Promise<0> {
  const deadline = deadlineOf(ctx.deadlineMs ?? DEFAULT_DEADLINE_MS);
  try {
    const text = await answer(harness, event, ctx, deadline);
    if (text !== '') ctx.out(text);
  } catch (error) {
    skip(ctx, harness, reasonOf(error));
  } finally {
    deadline.stop();
  }
  if (deadline.abandoned) ctx.exit?.(0);
  return 0;
}

const isOneOf = <T extends string>(values: readonly T[], value: string | undefined): value is T =>
  value !== undefined && (values as readonly string[]).includes(value);

/** `runHook` for the arguments of the command line: an unknown harness or event is skipped like any other problem. */
async function runHookCommand(
  harness: string | undefined,
  event: string | undefined,
  makeContext: () => HookContext | Promise<HookContext>,
): Promise<0> {
  const known = isOneOf(HOOK_HARNESSES, harness) ? harness : undefined;
  let ctx: HookContext;
  try {
    ctx = await makeContext();
  } catch (error) {
    skip(
      { out: text => void process.stdout.write(`${text}\n`), err: text => void process.stderr.write(`${text}\n`) },
      known,
      reasonOf(error),
    );
    return 0;
  }
  if (known === undefined) {
    skip(ctx, undefined, `unknown harness "${harness ?? ''}"`);
    return 0;
  }
  if (!isOneOf(HOOK_EVENTS, event)) {
    skip(ctx, known, `unknown event "${event ?? ''}"`);
    return 0;
  }
  return runHook(known, event, ctx);
}

/**
 * Registers `sdlc hook <harness> <event>`, which the hooks the kit renders into each harness's
 * settings run. The arguments are optional only so that a bad call is skipped with exit 0 rather
 * than rejected by the option parser.
 */
export function registerHookCommand(
  program: Command,
  makeContext: () => HookContext | Promise<HookContext>,
): void {
  program
    .command('hook')
    .description('Run a harness hook of the kit (called by the hooks in .claude, .codex and .gemini; not meant to be run by hand)')
    .argument('[harness]', `the harness: ${HOOK_HARNESSES.join(', ')}`)
    .argument('[event]', `the event: ${HOOK_EVENTS.join(', ')}`)
    .allowUnknownOption()
    .action(async (harness: string | undefined, event: string | undefined) => {
      process.exitCode = await runHookCommand(harness, event, makeContext);
    });
}
