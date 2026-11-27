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
import { NoStateCommentError, type Tracker } from '../tracker/types.js';

/**
 * The logic behind the four scripts in `.sdlc/githooks/` (`sdlc githook <name> [args…]`). The
 * decisions are pure functions over what git hands the hook; everything that touches the outside
 * (git, the config, the tracker, stdin, the background process, the output) comes in through
 * `GitHookContext`. A hook never blocks over a problem of its own: a config that cannot be read, an
 * unknown hook name or an unexpected failure warn and exit 0. Only the branch rules block, and only
 * in `enforce` mode.
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
}

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
  /** The push deletes the remote ref (its local sha is all zeros). */
  deleting: boolean;
}

/** The updates on git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>`); other lines are skipped. */
export function parsePushUpdates(lines: readonly string[]): PushUpdate[] {
  const updates: PushUpdate[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const [, localSha, remoteRef] = fields;
    if (fields.length < 4 || localSha === undefined || remoteRef === undefined) continue;
    updates.push({ remoteRef, deleting: /^0+$/.test(localSha) });
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
    let known = asked.get(issue);
    if (known === undefined) {
      known = lookup(issue);
      asked.set(issue, known);
    }
    try {
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
 * `TaskLookup` over the tracker: true for a tracked task. An issue that exists without readable
 * task state, or does not exist, is false; any other failure (offline, no `gh`, rate limit) rejects.
 */
export function lookupTrackedTask(tracker: Pick<Tracker, 'getTask'>): TaskLookup {
  return async issue => {
    try {
      await tracker.getTask(issue);
      return true;
    } catch (error) {
      if (error instanceof NoStateCommentError || error instanceof StateCommentError) return false;
      if (error instanceof GhError && NO_SUCH_ISSUE.test(error.stderr)) return false;
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

async function runSteps(steps: readonly Step[]): Promise<number> {
  let code = 0;
  for (const step of steps) code = Math.max(code, await step());
  return code;
}

/**
 * The config, loaded on first use. A config that cannot be loaded gives `undefined` (after one
 * warning, unless `quiet`): the rules that need it are skipped, so a config problem never blocks git.
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
          ctx.err(warning(`could not load the config (${firstLine(reasonOf(error))}); git hook ${hook} skipped`));
        }
      }
    }
    return result.cfg;
  };
}

type ConfigReader = () => Config | undefined;

async function preCommit(ctx: GitHookContext, config: ConfigReader): Promise<number> {
  return runSteps([
    // The secret guard is a step that goes first: it blocks in both modes and also when the config
    // could not be read (it must never fail open over config), so it handles its own errors.
    async () => {
      const branch = await currentBranch(ctx.git);
      if (branch === undefined) return 0;
      const cfg = config();
      return cfg === undefined ? 0 : report(ctx, decidePreCommit(branch, cfg));
    },
  ]);
}

async function prePush(ctx: GitHookContext, config: ConfigReader): Promise<number> {
  const lines = (await ctx.readStdin()).split('\n');
  return runSteps([
    // The secret guard step goes first here too; see `preCommit`.
    async () => {
      if (!parsePushUpdates(lines).some(update => !update.deleting)) return 0;
      const cfg = config();
      if (cfg === undefined) return 0;
      let tracker: Tracker | undefined;
      const lookup: TaskLookup = issue => lookupTrackedTask((tracker ??= ctx.makeTracker(cfg)))(issue);
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
async function postCheckout(ctx: GitHookContext, config: ConfigReader, args: readonly string[]): Promise<number> {
  // The third argument is 1 for a branch checkout and 0 for a file checkout.
  if (args[2] !== '1') return 0;
  const issue = taskIssueOf(await currentBranch(ctx.git));
  const cfg = issue === undefined ? undefined : config();
  if (issue === undefined || cfg === undefined) return 0;
  const task = await ctx.makeTracker(cfg).getTask(issue);
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
  try {
    switch (name) {
      case 'pre-commit':
        return await preCommit(ctx, config);
      case 'pre-push':
        return await prePush(ctx, config);
      case 'post-merge':
        return await postMerge(ctx, config);
      case 'post-checkout':
        return await postCheckout(ctx, config, args);
    }
  } catch (error) {
    if (!quiet) ctx.err(warning(`git hook ${name} failed (${firstLine(reasonOf(error))}); skipped`));
    return 0;
  }
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
