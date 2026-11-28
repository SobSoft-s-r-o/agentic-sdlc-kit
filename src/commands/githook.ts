import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { Config } from '../config/schema.js';
import { displayPhase, STATUS_LABELS } from '../core/projection.js';
import { StateCommentError } from '../core/stateComment.js';
import type { TaskState } from '../core/types.js';
import { GhError } from '../github/gh.js';
import type { GitRunner } from '../install/provision.js';
import { pushedChanges, stagedChanges, type ChangeSet } from '../secrets/gitDiff.js';
import { runGitleaks, type Exec, type Which } from '../secrets/gitleaks.js';
import { formatFinding, scanChanges } from '../secrets/scan.js';
import { NoStateCommentError, type Tracker } from '../tracker/types.js';

/**
 * The logic behind the four scripts in `.sdlc/githooks/` (`sdlc githook <name> [args…]`). The
 * decisions are pure functions over what git hands the hook; everything that touches the outside
 * (git, the config, the tracker, stdin, the background process, the output) comes in through
 * `GitHookContext`. A hook never blocks over a problem of its own: a config that cannot be read, an
 * unknown hook name or an unexpected failure warn and exit 0. The branch rules block only in
 * `enforce` mode. The one exception is the secret guard of pre-commit and pre-push: it blocks in
 * both modes, runs first, and fails closed (a guard that cannot scan blocks, whatever the reason).
 */

export const HOOK_NAMES = ['pre-commit', 'pre-push', 'post-merge', 'post-checkout'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Where post-merge's background reconcile writes, relative to the repository root. */
export const RECONCILE_LOG = '.sdlc/cache/reconcile.log';

export interface HookMessage {
  level: 'warn' | 'error';
  text: string;
}

/** What a rule decides: the messages to print, and the exit code (1 only when a message is an error). */
export interface HookDecision {
  exitCode: 0 | 1;
  messages: HookMessage[];
}

/** Whether the tracker knows a task for the issue; rejects when that could not be found out (offline). */
export type TaskLookup = (issue: number) => Promise<boolean>;

export interface GitHookContext {
  /** The repository root, which is where git runs the hooks. */
  repoRoot: string;
  git: GitRunner;
  /** Throws when the config cannot be read or is invalid. Called at most once per hook, and only if needed. */
  loadConfig(): Config;
  /** Called only when a hook needs the issue tracker. */
  makeTracker(cfg: Config): Tracker;
  /** The text git feeds the hook on stdin (pre-push). */
  readStdin(): Promise<string>;
  /** Starts `sdlc reconcile` detached, appending its output to `logPath`; must not wait for it. */
  spawnReconcile(logPath: string): void | Promise<void>;
  /** Prints one line to stdout. */
  out(text: string): void;
  /** Prints one line to stderr. */
  err(text: string): void;
  /** Runs a program (gitleaks, in pre-commit); without it, and without `which`, gitleaks is not used. */
  exec?: Exec;
  /** Finds a program on the PATH (gitleaks). */
  which?: Which;
  /** How long the hooks wait for the tracker; the defaults are `PRE_PUSH_LOOKUP_TIMEOUT_MS` and `POST_CHECKOUT_LOOKUP_TIMEOUT_MS`. */
  timeouts?: { prePushMs?: number; postCheckoutMs?: number };
  /**
   * Ends the process with `code`. Called, after everything is printed, only when a tracker call was
   * abandoned on its deadline: that call is still running and would keep the process, and so git,
   * waiting. Without it the process ends by itself.
   */
  exit?(code: number): void;
}

/** Longest pre-push waits, in all, for the tracker; past it the push is allowed with a warning. */
export const PRE_PUSH_LOOKUP_TIMEOUT_MS = 10_000;
/** Longest post-checkout waits for the tracker; past it the line is left out. */
export const POST_CHECKOUT_LOOKUP_TIMEOUT_MS = 5_000;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

const decisionOf = (messages: HookMessage[]): HookDecision => ({
  exitCode: messages.some(message => message.level === 'error') ? 1 : 0,
  messages,
});

/** `observe` warns about a rule, `enforce` makes it an error that blocks. */
const rule = (cfg: Config, text: string): HookMessage => ({
  level: cfg.mode === 'enforce' ? 'error' : 'warn',
  text,
});

const BRANCH_ADVICE = 'work on a task branch (task/<issue>-<slug>)';

/** `task/<issue>-<slug>`: the issue number of a task branch, or `undefined` for any other branch. */
export function taskIssueOf(branch: string | undefined): number | undefined {
  const match = branch === undefined ? null : /^task\/(\d+)-/.exec(branch);
  const issue = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(issue) && issue >= 1 ? issue : undefined;
}

// -- pre-commit ----------------------------------------------------------------------------------

/** A commit on the default branch; any other branch, and a detached HEAD (`undefined`), is fine. */
export function decidePreCommit(branch: string | undefined, cfg: Config): HookDecision {
  if (branch === undefined || branch !== cfg.github.defaultBranch) return decisionOf([]);
  return decisionOf([rule(cfg, `committing directly to ${branch}; ${BRANCH_ADVICE}`)]);
}

// -- pre-push --------------------------------------------------------------------------------------

export interface PushUpdate {
  remoteRef: string;
  /** What is pushed (all zeros for a deletion). */
  localSha: string;
  /** What the remote has (all zeros for a new ref). */
  remoteSha: string;
  /** The push deletes the remote ref (its local sha is all zeros). */
  deleting: boolean;
}

/** The updates on git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>`); other lines are skipped. */
export function parsePushUpdates(lines: readonly string[]): PushUpdate[] {
  const updates: PushUpdate[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const [, localSha, remoteRef, remoteSha] = fields;
    if (fields.length < 4 || localSha === undefined || remoteRef === undefined || remoteSha === undefined) continue;
    updates.push({ remoteRef, localSha, remoteSha, deleting: /^0+$/.test(localSha) });
  }
  return updates;
}

const HEADS = 'refs/heads/';

/**
 * Pushes to the default branch, and pushes of a `task/<n>-…` branch whose task `lookup` does not
 * know (the rule). A lookup that fails, offline for instance, only warns, in both modes: being
 * unable to check is not a reason to stop a push. Deleting a ref is never judged.
 */
export async function decidePrePush(
  lines: readonly string[],
  cfg: Config,
  lookup: TaskLookup,
): Promise<HookDecision> {
  const messages: HookMessage[] = [];
  const asked = new Map<number, Promise<boolean>>();
  for (const update of parsePushUpdates(lines)) {
    if (update.deleting || !update.remoteRef.startsWith(HEADS)) continue;
    const branch = update.remoteRef.slice(HEADS.length);
    if (branch === cfg.github.defaultBranch) {
      messages.push(rule(cfg, `pushing directly to ${branch}; ${BRANCH_ADVICE}`));
      continue;
    }
    const issue = taskIssueOf(branch);
    if (issue === undefined) continue;
    try {
      // Inside the try, and started from a promise, so a lookup that throws at once is a failed lookup too.
      let known = asked.get(issue);
      if (known === undefined) {
        known = Promise.resolve().then(() => lookup(issue));
        asked.set(issue, known);
      }
      if (!(await known)) {
        messages.push(
          rule(cfg, `branch ${branch} has no tracked task #${issue}; run sdlc task new or sdlc task new --issue ${issue}`),
        );
      }
    } catch (error) {
      messages.push({
        level: 'warn',
        text: `could not verify task #${issue} (${firstLine(reasonOf(error))}); push allowed`,
      });
    }
  }
  return decisionOf(messages);
}

/** GitHub's answer for an issue number that does not exist (`gh issue view`, which uses GraphQL). */
const NO_SUCH_ISSUE = /could not resolve to an? issue/i;

/**
 * Whether `error` from `Tracker.getTask` means the issue has no task to read: it has no state
 * comment, or does not exist. Any other failure (offline, no `gh`, rate limit, a state comment that
 * cannot be read) is not.
 */
export function isMissingTaskError(error: unknown): boolean {
  return (
    error instanceof NoStateCommentError || (error instanceof GhError && NO_SUCH_ISSUE.test(error.stderr))
  );
}

/**
 * Whether `error` from `Tracker.getTask` means there is no tracked task, for the git hooks: the
 * issue exists without readable task state, or does not exist. Any other failure (offline, no
 * `gh`, rate limit) is not.
 */
export function isNoTaskError(error: unknown): boolean {
  return isMissingTaskError(error) || error instanceof StateCommentError;
}

/**
 * `TaskLookup` over the tracker: true for a tracked task. An issue that exists without readable
 * task state, or does not exist, is false; any other failure (offline, no `gh`, rate limit) rejects.
 */
export function lookupTrackedTask(tracker: Pick<Tracker, 'getTask'>): TaskLookup {
  return async issue => {
    try {
      await tracker.getTask(issue);
      return true;
    } catch (error) {
      if (isNoTaskError(error)) return false;
      throw error;
    }
  };
}

// -- post-checkout -------------------------------------------------------------------------------------

/** Text for one terminal line: control characters and runs of white space become one space. */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();

/** `task #12: In progress · Planning · next: Write the plan`. */
export function describeCheckout(state: TaskState): string {
  const status = STATUS_LABELS[state.status] ?? state.status;
  return `task #${state.issue}: ${status} · ${displayPhase(state.phase)} · next: ${oneLine(state.nextStep) || '—'}`;
}

// -- the hooks -----------------------------------------------------------------------------------------

/** The checked-out branch; `undefined` on a detached HEAD. */
async function currentBranch(git: GitRunner): Promise<string | undefined> {
  const result = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = result.code === 0 ? result.stdout.trim() : '';
  return branch === '' ? undefined : branch;
}

const warning = (text: string): string => `sdlc: warning: ${text}`;

/** Prints a decision's messages to stderr and gives its exit code. */
function report(ctx: GitHookContext, decision: HookDecision): number {
  for (const { level, text } of decision.messages) ctx.err(level === 'error' ? `sdlc: error: ${text}` : warning(text));
  return decision.exitCode;
}

/** Each step returns an exit code; every step runs, and the hook exits with the highest one. */
type Step = () => Promise<number> | number;

/**
 * Runs every step and gives the highest exit code. It never throws: a step that fails warns and
 * counts as 0, so it can neither stop the steps after it nor erase a block an earlier step decided.
 */
export async function runSteps(ctx: GitHookContext, hook: HookName, steps: readonly Step[]): Promise<number> {
  let code = 0;
  for (const step of steps) {
    try {
      code = Math.max(code, await step());
    } catch (error) {
      ctx.err(warning(`git hook ${hook} failed (${firstLine(reasonOf(error))}); skipped`));
    }
  }
  return code;
}

/**
 * A deadline shared by all the tracker calls of one hook, started by the first of them. A call
 * that is still running when it passes is abandoned: `run` rejects and `abandoned` turns true.
 * Calls made after the deadline are refused without being started. `stop` must be called when the
 * hook is done.
 */
export interface Deadline {
  /** A tracker call was still running at the deadline; it keeps running in the background. */
  readonly abandoned: boolean;
  run<T>(work: () => Promise<T>): Promise<T>;
  stop(): void;
}

export function deadlineOf(totalMs: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: Promise<never> | undefined;
  let passed = false;
  let abandoned = false;
  let pending = 0;
  const timedOut = (): Error => new Error(`timed out after ${totalMs / 1000}s`);
  return {
    get abandoned() {
      return abandoned;
    },
    run: work => {
      if (passed) return Promise.reject(timedOut());
      expiry ??= new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          passed = true;
          abandoned = pending > 0;
          reject(timedOut());
        }, totalMs);
      });
      // Started from a promise, so work that throws at once is a rejected call like any other.
      const call = Promise.resolve().then(work);
      pending += 1;
      const settled = (): void => {
        pending -= 1;
      };
      call.then(settled, settled);
      return Promise.race([call, expiry]);
    },
    stop: () => clearTimeout(timer),
  };
}

/**
 * The config, loaded on first use. A config that cannot be loaded gives `undefined` (after one
 * warning, unless `quiet`): the rules that need it are skipped, so a config problem never blocks git
 * over a branch rule. The secret guard of pre-commit and pre-push still runs then, with no allowed
 * fingerprints, and the warning says so.
 */
function configReader(ctx: GitHookContext, hook: HookName, quiet = false): () => Config | undefined {
  let result: { cfg: Config | undefined } | undefined;
  return () => {
    if (result === undefined) {
      try {
        result = { cfg: ctx.loadConfig() };
      } catch (error) {
        result = { cfg: undefined };
        if (!quiet) {
          const reason = firstLine(reasonOf(error));
          ctx.err(
            warning(
              hook === 'pre-commit' || hook === 'pre-push'
                ? `sdlc.config.yaml could not be loaded (${reason}); branch rules skipped, secret guard still active`
                : `could not load the config (${reason}); git hook ${hook} skipped`,
            ),
          );
        }
      }
    }
    return result.cfg;
  };
}

type ConfigReader = () => Config | undefined;

// -- the secret guard -----------------------------------------------------------------------------------

const SECRET_ADVICE =
  'Move the secret to the keystore / production secret storage. False positive? add "sdlc:allow-secret" on the line, or add the fingerprint to secrets.allow in sdlc.config.yaml.';
/** More findings than this are counted, not listed. */
const MAX_LISTED_FINDINGS = 50;

/**
 * The secret guard: blocks (exit code 1) when what is about to be committed (`pre-commit`) or pushed
 * (`pre-push`) holds a secret, in `observe` and `enforce` mode alike. `collect` gives the changes to
 * scan; with `gitleaks`, gitleaks scans the staged changes too when it is on the PATH.
 *
 * It fails closed: if the changes cannot be collected or anything else goes wrong, it says that it
 * could not scan and blocks, because a pass without a scan would let a secret through. It therefore
 * handles all its own errors (the steps around it turn an error into a warning and exit 0). A config
 * that cannot be read only means that no fingerprint is allowed. Everything it prints is masked.
 */
async function secretGuard(
  ctx: GitHookContext,
  config: ConfigReader,
  what: 'commit' | 'push',
  collect: () => Promise<ChangeSet>,
  gitleaks: boolean,
): Promise<number> {
  try {
    const changes = await collect();
    let findings = scanChanges(changes, []);
    // The config only matters for the fingerprints the owner accepted, so it is read when there is something to accept.
    if (findings.length > 0) findings = scanChanges(changes, config()?.secrets.allow ?? []);
    const leaks = gitleaks && ctx.exec && ctx.which ? await runGitleaks(ctx.exec, ctx.which) : undefined;
    if (leaks?.warning !== undefined) ctx.err(warning(leaks.warning));
    if (findings.length === 0 && leaks?.blocked !== true) return 0;
    ctx.err(`sdlc secret guard: ${what} blocked`);
    for (const finding of findings.slice(0, MAX_LISTED_FINDINGS)) ctx.err(formatFinding(finding));
    if (findings.length > MAX_LISTED_FINDINGS) ctx.err(`… and ${findings.length - MAX_LISTED_FINDINGS} more`);
    if (leaks?.blocked) {
      ctx.err('gitleaks found secrets (its output is redacted):');
      for (const line of leaks.output) ctx.err(`  ${oneLine(line)}`);
      ctx.err('Run "gitleaks git --pre-commit --staged --redact -v" for the details.');
    }
    ctx.err(SECRET_ADVICE);
    return 1;
  } catch (error) {
    ctx.err(`sdlc secret guard: could not scan (${oneLine(firstLine(reasonOf(error)))}); ${what} blocked`);
    return 1;
  }
}

async function preCommit(ctx: GitHookContext, config: ConfigReader): Promise<number> {
  return runSteps(ctx, 'pre-commit', [
    // The guard goes first and needs no branch, so it also scans on a detached HEAD.
    () => secretGuard(ctx, config, 'commit', () => stagedChanges(ctx.git), true),
    async () => {
      const branch = await currentBranch(ctx.git);
      if (branch === undefined) return 0;
      const cfg = config();
      return cfg === undefined ? 0 : report(ctx, decidePreCommit(branch, cfg));
    },
  ]);
}

async function prePush(ctx: GitHookContext, config: ConfigReader, deadline: Deadline): Promise<number> {
  // Read once, inside the steps: a stdin that cannot be read must reach the guard, which blocks on it.
  let stdin: Promise<string> | undefined;
  const readStdin = (): Promise<string> => (stdin ??= Promise.resolve().then(() => ctx.readStdin()));
  return runSteps(ctx, 'pre-push', [
    () =>
      secretGuard(
        ctx,
        config,
        'push',
        async () => {
          let input: string;
          try {
            input = await readStdin();
          } catch (error) {
            throw new Error(`the push input could not be read: ${firstLine(reasonOf(error))}`);
          }
          const lines = input.split('\n');
          const updates = parsePushUpdates(lines);
          // Every non-blank line is an update; one that cannot be read is one that cannot be scanned.
          if (lines.filter(line => line.trim() !== '').length !== updates.length) {
            throw new Error('the push input has a line that cannot be read');
          }
          return pushedChanges(ctx.git, updates);
        },
        false,
      ),
    async () => {
      const lines = (await readStdin()).split('\n');
      if (!parsePushUpdates(lines).some(update => !update.deleting)) return 0;
      const cfg = config();
      if (cfg === undefined) return 0;
      let tracker: Tracker | undefined;
      const lookup: TaskLookup = issue =>
        deadline.run(() => lookupTrackedTask((tracker ??= ctx.makeTracker(cfg)))(issue));
      return report(ctx, await decidePrePush(lines, cfg, lookup));
    },
  ]);
}

/** After a merge on the default branch: reconcile in the background, so the merge itself stays fast. */
async function postMerge(ctx: GitHookContext, config: ConfigReader): Promise<number> {
  const branch = await currentBranch(ctx.git);
  if (branch === undefined) return 0;
  const cfg = config();
  if (cfg === undefined || branch !== cfg.github.defaultBranch) return 0;
  try {
    await ctx.spawnReconcile(join(ctx.repoRoot, ...RECONCILE_LOG.split('/')));
  } catch (error) {
    ctx.err(warning(`could not start reconcile in the background (${firstLine(reasonOf(error))})`));
    return 0;
  }
  ctx.out(`sdlc: reconcile started in the background (log: ${RECONCILE_LOG})`);
  return 0;
}

/** One status line when a task branch is checked out; says nothing when it cannot (it must never get in the way). */
async function postCheckout(
  ctx: GitHookContext,
  config: ConfigReader,
  deadline: Deadline,
  args: readonly string[],
): Promise<number> {
  // The third argument is 1 for a branch checkout and 0 for a file checkout.
  if (args[2] !== '1') return 0;
  const issue = taskIssueOf(await currentBranch(ctx.git));
  const cfg = issue === undefined ? undefined : config();
  if (issue === undefined || cfg === undefined) return 0;
  const task = await deadline.run(() => ctx.makeTracker(cfg).getTask(issue));
  ctx.out(describeCheckout(task.state));
  return 0;
}

const isHookName = (name: string): name is HookName => (HOOK_NAMES as readonly string[]).includes(name);

/**
 * Runs the hook `name` with the arguments git gave the script and returns the exit code for it. An
 * unknown name is ignored with a warning (a script of a newer kit must not block git), and so is
 * an unexpected failure; post-checkout stays silent about every failure.
 */
export async function runGitHook(name: string, args: readonly string[], ctx: GitHookContext): Promise<number> {
  if (!isHookName(name)) {
    ctx.err(warning(`unknown git hook "${name}"; ignored`));
    return 0;
  }
  const quiet = name === 'post-checkout';
  const config = configReader(ctx, name, quiet);
  const deadline = deadlineOf(
    quiet
      ? (ctx.timeouts?.postCheckoutMs ?? POST_CHECKOUT_LOOKUP_TIMEOUT_MS)
      : (ctx.timeouts?.prePushMs ?? PRE_PUSH_LOOKUP_TIMEOUT_MS),
  );
  let code = 0;
  try {
    switch (name) {
      case 'pre-commit':
        code = await preCommit(ctx, config);
        break;
      case 'pre-push':
        code = await prePush(ctx, config, deadline);
        break;
      case 'post-merge':
        code = await postMerge(ctx, config);
        break;
      case 'post-checkout':
        code = await postCheckout(ctx, config, deadline, args);
        break;
    }
  } catch (error) {
    // Only what happens outside the steps of pre-commit and pre-push gets here, before anything is decided.
    if (!quiet) ctx.err(warning(`git hook ${name} failed (${firstLine(reasonOf(error))}); skipped`));
    code = 0;
  } finally {
    deadline.stop();
  }
  if (deadline.abandoned) ctx.exit?.(code);
  return code;
}

// -- real I/O ------------------------------------------------------------------------------------------

/**
 * Starts `command` detached in `cwd`, with stdout and stderr appended to `logPath` (its directory is
 * created), and does not wait for it. A command that cannot start is written to the log.
 */
export function spawnDetachedLogged(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  logPath: string;
}): void {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const log = openSync(options.logPath, 'a');
  try {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', error => {
      try {
        appendFileSync(options.logPath, `could not start ${options.command}: ${error.message}\n`);
      } catch {
        // Nowhere left to report it.
      }
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** Everything on `stdin`, or nothing when it is a terminal (the command was run by hand). */
export async function readAllStdin(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Ends the process with `code` once what was written to `streams` has been flushed (a pipe may still
 * hold the last lines). For a hook that abandoned a hanging `gh` call, which would keep it alive.
 */
export function exitAfterFlush(
  code: number,
  exit: (code: number) => void = process.exit,
  streams: ReadonlyArray<Pick<NodeJS.WriteStream, 'write'>> = [process.stdout, process.stderr],
): void {
  const flush = (index: number): void => {
    const stream = streams[index];
    if (stream === undefined) exit(code);
    else stream.write('', () => flush(index + 1));
  };
  flush(0);
}

/**
 * Registers `sdlc githook <name> [args…]`, which the scripts in `.sdlc/githooks/` run. It sets the
 * exit code for git; the context is built when the hook runs, and the hook asks it for the config
 * and the tracker only if it needs them.
 */
export function registerGitHookCommand(
  program: Command,
  makeContext: () => GitHookContext | Promise<GitHookContext>,
): void {
  program
    .command('githook')
    .description('Run a git hook of the kit (called by the scripts in .sdlc/githooks; not meant to be run by hand)')
    .argument('<name>', `the hook: ${HOOK_NAMES.join(', ')}`)
    .argument('[args...]', 'the arguments git gives the hook')
    .allowUnknownOption()
    .action(async (name: string, args: string[]) => {
      process.exitCode = await runGitHook(name, args, await makeContext());
    });
}
