import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Command } from 'commander';
import type { Status } from '../core/types.js';
import { isPathUnder, listWorktrees, taskSlug, WORKTREES_DIR, type Worktree } from '../git/worktrees.js';
import { realPathOf } from '../hooks/resolve.js';
import type { GitRunner } from '../install/provision.js';
import type { TrackedTask } from '../tracker/types.js';
import { fetchTask, parseIssueNumber, runCommand, type CommandContext } from './context.js';
import { taskIssueOf } from './githook.js';

/**
 * `sdlc worktree start|finish <issue>`: one git worktree per task, `.worktrees/<issue>-<slug>` on branch
 * `task/<issue>-<slug>`, made from the freshly fetched default branch and cleaned up after the merge
 * without any forced git command: nothing here passes `--force` or `-D`, or prunes.
 *
 * All git runs in the main checkout (`ctx.git`), so `.worktrees/` is under the main checkout whichever
 * worktree the command is started from.
 */

/** The remote the default branch is fetched from. */
const REMOTE = 'origin';

/** Longest one git call of these commands may take (a fetch over a slow network included). */
export const WORKTREE_GIT_TIMEOUT_MS = 120_000;

export interface WorktreeContext extends CommandContext {
  /** Runs git with the main checkout as its directory. */
  git: GitRunner;
  /** The root of the MAIN checkout, where `.worktrees/` is. */
  repoRoot: string;
  /** The directory the command was started from: `finish` never removes the worktree that holds it. */
  cwd: string;
}

type GitResult = Awaited<ReturnType<GitRunner>>;

/** What git said when a call failed: its error output, else its output, else its exit code. */
const reasonOf = (result: GitResult): string => (result.stderr || result.stdout).trim() || `exit code ${result.code}`;

const firstLine = (text: string): string => text.split(/\r?\n/).find(line => line.trim() !== '') ?? '';

const outputLines = (text: string): string[] => text.split(/\r?\n/).filter(line => line.trim() !== '');

const shown = (args: string[]): string => `git ${args.join(' ')}`;

// -- start -----------------------------------------------------------------------------------------

export interface WorktreeStartResult {
  issue: number;
  branch: string;
  /** Absolute path of the new worktree. */
  path: string;
  /** What the branch starts from: `origin/main`. */
  base: string;
  dryRun: boolean;
  /** A dry run only: the git commands a real run makes. */
  plan?: string[];
}

/** The local branches of `issue`: `task/<issue>-<anything>`, whatever the title was when they were made. */
async function taskBranches(git: GitRunner, issue: number): Promise<string[]> {
  const result = await git(['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${issue}-*`]);
  if (result.code !== 0) throw new Error(`git for-each-ref failed: ${reasonOf(result)}`);
  return outputLines(result.stdout);
}

/**
 * Creates `.worktrees/<issue>-<slug>` on the new branch `task/<issue>-<slug>` from `origin/<default branch>`,
 * fetched first. The slug comes from the title as it is now. Refuses when #issue already has a branch (also
 * one made under an earlier title) or the path is taken. With `dryRun` only the checks run.
 */
export async function worktreeStart(
  ctx: WorktreeContext,
  issue: number,
  options: { dryRun?: boolean } = {},
): Promise<WorktreeStartResult> {
  const task = await fetchTask(ctx, issue);
  const slug = taskSlug(task.title);
  const branch = `task/${issue}-${slug}`;
  const dir = `${WORKTREES_DIR}/${issue}-${slug}`;
  const path = join(ctx.repoRoot, dir);
  const defaultBranch = ctx.cfg.github.defaultBranch;
  const base = `${REMOTE}/${defaultBranch}`;

  const existing = await taskBranches(ctx.git, issue);
  if (existing.includes(branch)) throw new Error(`${branch} already exists`);
  if (existing[0] !== undefined) throw new Error(`${existing[0]} already exists: #${issue} has a task branch already`);
  if (existsSync(path)) throw new Error(`${branch} already exists: ${dir} is in the way`);

  const fetchArgs = ['fetch', REMOTE, defaultBranch];
  const addArgs = ['worktree', 'add', '-b', branch, dir, base];
  const dryRun = options.dryRun === true;
  const result: WorktreeStartResult = { issue, branch, path, base, dryRun };
  if (dryRun) return { ...result, plan: [shown(fetchArgs), shown(addArgs)] };

  const fetched = await ctx.git(fetchArgs);
  if (fetched.code !== 0) {
    throw new Error(`${shown(fetchArgs)} failed: ${reasonOf(fetched)} (not creating a worktree from a stale ${base})`);
  }
  const added = await ctx.git(addArgs);
  if (added.code !== 0) {
    // git makes the branch before the directory and leaves it behind when that fails, which would turn
    // the next start into "already exists"; `-d` removes it only while it is still where it started.
    await ctx.git(['branch', '-d', branch]);
    throw new Error(`git worktree add failed: ${reasonOf(added)}`);
  }
  return result;
}

export function describeWorktreeStart(result: WorktreeStartResult): string {
  const what = `${result.path} on branch ${result.branch} from ${result.base}`;
  if (!result.dryRun) return `Created worktree ${what}`;
  return [`Would create worktree ${what}:`, ...(result.plan ?? []).map(step => `  ${step}`)].join('\n');
}

// -- finish ----------------------------------------------------------------------------------------

export interface WorktreeFinishResult {
  issue: number;
  /** The task branch that was checked out in the worktree. */
  branch: string;
  /** Absolute path of the worktree, as git reports it. */
  path: string;
  dryRun: boolean;
  /** The main checkout was fast-forwarded to `origin/<default branch>`. */
  mainCheckoutUpdated: boolean;
  worktreeRemoved: boolean;
  /** False when git refused `branch -d` (the branch is kept for the owner to check). */
  branchDeleted: boolean;
  /** What happened, in order, in words; also what a person sees. */
  notes: string[];
  /** A dry run only: the git commands a real run makes. */
  plan?: string[];
}

interface TaskWorktree {
  worktree: Worktree;
  branch: string;
  /** `.worktrees/<name>`, for messages. */
  dir: string;
  /** The real path, for comparing with other real paths. */
  real: string;
}

/** The worktree of `issue` under `.worktrees/`, found by its branch `task/<issue>-*` (the title may have changed since). */
async function taskWorktreeOf(ctx: WorktreeContext, issue: number): Promise<TaskWorktree> {
  const base = realPathOf(join(ctx.repoRoot, WORKTREES_DIR));
  const found: TaskWorktree[] = [];
  for (const worktree of await listWorktrees(ctx.git)) {
    const { branch } = worktree;
    const real = realPathOf(worktree.path);
    if (worktree.bare || branch === undefined || taskIssueOf(branch) !== issue || !isPathUnder(base, real)) continue;
    found.push({ worktree, branch, dir: `${WORKTREES_DIR}/${relative(base, real)}`, real });
  }
  const [only, ...others] = found;
  if (only === undefined) {
    throw new Error(`no worktree for #${issue}: no branch task/${issue}-* is checked out under ${WORKTREES_DIR}/`);
  }
  if (others.length > 0) {
    const list = found.map(({ dir, branch }) => `${dir} (${branch})`).join(', ');
    throw new Error(`more than one worktree for #${issue}: ${list}; remove the ones you do not need yourself`);
  }
  return only;
}

/** The statuses of a task whose final PR has merged. */
const PAST_MERGE: readonly Status[] = ['awaiting_deployment', 'done'];

/** A PR of the task merged (the state comment records its `mergeSha`), or the task is already past its merge. */
const merged = (task: TrackedTask): boolean =>
  task.state.prs.some(pr => pr.mergeSha !== undefined) || PAST_MERGE.includes(task.state.status);

/**
 * Always asked for: with `status.showUntrackedFiles=no` in the user's config a plain `git status` hides
 * untracked files, which `git worktree remove` deletes all the same.
 */
const UNTRACKED_FILES = '--untracked-files=normal';

/**
 * Lists the ignored files, and not only their directory when that holds nothing else (`!! config/`
 * hides `config/.env.production`); a directory an ignore pattern names (`dist/`) stays one entry.
 */
const IGNORED_FILES = '--ignored=matching';

const IGNORED_ENTRY = '!! ';

/** A file that holds local settings: `.env`, `.env.local`, `.env.production`, ... */
const ENV_FILE = /^\.env(\..+)?$/;

/** The ignored `.env` files and directories among the lines of `git status --porcelain --ignored`, as git prints them (a directory ends with a slash). */
function ignoredEnvFiles(lines: string[]): string[] {
  return lines
    .filter(line => line.startsWith(IGNORED_ENTRY))
    .map(line => line.slice(IGNORED_ENTRY.length))
    .filter(path => {
      // git quotes a path with unusual characters, and ends a directory with a slash.
      const bare = path.replace(/^"(.*)"$/, '$1').replace(/\/$/, '');
      return ENV_FILE.test(bare.slice(bare.lastIndexOf('/') + 1));
    });
}

type MainCheckout = { update: true } | { update: false; reason: string };

/** Whether the main checkout may be fast-forwarded: on the default branch and without changes. */
async function mainCheckoutOf(ctx: WorktreeContext): Promise<MainCheckout> {
  const defaultBranch = ctx.cfg.github.defaultBranch;
  const head = await ctx.git(['symbolic-ref', '--short', '-q', 'HEAD']);
  // A detached HEAD is git's own answer: exit 1 and nothing said (`-q`).
  if (head.code === 1 && head.stderr.trim() === '') return { update: false, reason: 'HEAD is detached' };
  if (head.code !== 0) return { update: false, reason: `its branch could not be read: ${firstLine(reasonOf(head))}` };
  const branch = head.stdout.trim();
  if (branch !== defaultBranch) return { update: false, reason: `it is on ${branch}, not ${defaultBranch}` };
  const status = await ctx.git(['status', '--porcelain', UNTRACKED_FILES]);
  if (status.code !== 0) return { update: false, reason: `its changes could not be read: ${firstLine(reasonOf(status))}` };
  if (outputLines(status.stdout).length > 0) return { update: false, reason: 'it has changes' };
  return { update: true };
}

const notUpdated = (reason: string): string => `main checkout not updated: ${reason}`;

/** Fetches the default branch and fast-forwards the main checkout to it; any refusal is reported, never forced. */
async function updateMainCheckout(ctx: WorktreeContext): Promise<{ updated: boolean; note: string }> {
  const defaultBranch = ctx.cfg.github.defaultBranch;
  const main = await mainCheckoutOf(ctx);
  if (!main.update) return { updated: false, note: notUpdated(main.reason) };
  const fetchArgs = ['fetch', REMOTE, defaultBranch];
  const fetched = await ctx.git(fetchArgs);
  if (fetched.code !== 0) {
    return { updated: false, note: notUpdated(`${shown(fetchArgs)} failed: ${firstLine(reasonOf(fetched))}`) };
  }
  const mergeArgs = ['merge', '--ff-only', `${REMOTE}/${defaultBranch}`];
  const result = await ctx.git(mergeArgs);
  if (result.code !== 0) {
    return { updated: false, note: notUpdated(`${shown(mergeArgs)} was refused (${firstLine(reasonOf(result))})`) };
  }
  return { updated: true, note: `main checkout updated: ${shown(mergeArgs)}` };
}

/**
 * Cleans up after the merge of #issue: refuses while the worktree has changes (untracked files included,
 * whatever the user's git config hides), holds ignored `.env` files or directories, or no PR of the task has
 * merged (unless it is awaiting deployment or done), and when the command runs inside that worktree
 * (its directory would vanish under the caller: run it from the main checkout). Then it fast-forwards
 * the main checkout to the fetched default branch when that checkout is on it and clean (and only reports
 * when it is not), runs `git worktree remove` and `git branch -d`. A refused `branch -d` (a squash merge
 * leaves the commits unmerged) keeps the branch and is no failure. With `dryRun` only the checks run.
 */
export async function worktreeFinish(
  ctx: WorktreeContext,
  issue: number,
  options: { dryRun?: boolean } = {},
): Promise<WorktreeFinishResult> {
  const { worktree, branch, dir, real } = await taskWorktreeOf(ctx, issue);

  const here = realPathOf(ctx.cwd);
  if (here === real || isPathUnder(real, here)) {
    throw new Error(
      `you are inside ${dir}: run "sdlc worktree finish ${issue}" from the main checkout (${ctx.repoRoot}), so that your directory is not removed under you`,
    );
  }

  // Every reason to refuse is reported at once.
  const blockers: string[] = [];
  if (!merged(await fetchTask(ctx, issue))) blockers.push(`#${issue} has no merged PR yet`);
  // A worktree whose directory is gone has no changes to look at; `worktree remove` clears its record.
  if (!worktree.prunable) {
    const status = await ctx.git(['-C', worktree.path, 'status', '--porcelain', UNTRACKED_FILES, IGNORED_FILES]);
    if (status.code !== 0) blockers.push(`could not read the state of ${dir}: ${firstLine(reasonOf(status))}`);
    else {
      const lines = outputLines(status.stdout);
      const changes = lines.filter(line => !line.startsWith(IGNORED_ENTRY));
      if (changes.length > 0) blockers.push([`${dir} has changes:`, ...changes.map(line => `  ${line}`)].join('\n'));
      // Ignored files (build output, node_modules) go with the worktree, but local settings may exist nowhere else.
      const env = ignoredEnvFiles(lines);
      if (env.length > 0) {
        // A directory keeps its slash (`.env/`, a Python virtualenv), and the wording says there is one.
        const kind = env.some(path => path.endsWith('/')) ? 'files or directories' : 'files';
        blockers.push(
          `${dir} holds ignored local ${kind} (${env.join(', ')}); move them out, then run \`sdlc worktree finish ${issue}\` again`,
        );
      }
    }
  }
  if (blockers.length > 0) throw new Error(blockers.join('\n'));

  const defaultBranch = ctx.cfg.github.defaultBranch;
  const removeArgs = ['worktree', 'remove', worktree.path];
  const deleteArgs = ['branch', '-d', branch];
  const result: WorktreeFinishResult = {
    issue,
    branch,
    path: worktree.path,
    dryRun: options.dryRun === true,
    mainCheckoutUpdated: false,
    worktreeRemoved: false,
    branchDeleted: false,
    notes: [],
  };

  if (options.dryRun === true) {
    const main = await mainCheckoutOf(ctx);
    const update = main.update
      ? [shown(['fetch', REMOTE, defaultBranch]), shown(['merge', '--ff-only', `${REMOTE}/${defaultBranch}`])]
      : [];
    return {
      ...result,
      notes: main.update ? [] : [notUpdated(main.reason)],
      plan: [...update, shown(removeArgs), shown(deleteArgs)],
    };
  }

  const main = await updateMainCheckout(ctx);
  result.mainCheckoutUpdated = main.updated;
  result.notes.push(main.note);

  const removed = await ctx.git(removeArgs);
  if (removed.code !== 0) throw new Error([...result.notes, `git worktree remove failed: ${reasonOf(removed)}`].join('\n'));
  result.worktreeRemoved = true;
  result.notes.push(`removed worktree ${dir}`);

  const deleted = await ctx.git(deleteArgs);
  result.branchDeleted = deleted.code === 0;
  result.notes.push(
    result.branchDeleted
      ? `deleted branch ${branch}`
      : `branch ${branch} kept: git branch -d refused (squash merge?); check it and delete it yourself`,
  );
  return result;
}

export function describeWorktreeFinish(result: WorktreeFinishResult): string {
  if (!result.dryRun) return result.notes.join('\n');
  return [
    `Would finish #${result.issue} (worktree ${result.path}, branch ${result.branch}):`,
    ...(result.plan ?? []).map(step => `  ${step}`),
    ...result.notes.map(note => `  ${note}`),
  ].join('\n');
}

// -- command ---------------------------------------------------------------------------------------

export type WorktreeContextFactory = () => WorktreeContext | Promise<WorktreeContext>;

/** Registers `sdlc worktree start <issue> [--dry-run]` and `sdlc worktree finish <issue> [--dry-run]`. */
export function registerWorktreeCommand(program: Command, makeContext: WorktreeContextFactory): void {
  const worktree = program.command('worktree').description('Create and clean up the git worktree of a task');

  worktree
    .command('start')
    .description('Create .worktrees/<issue>-<slug> on branch task/<issue>-<slug> from the fetched default branch')
    .argument('<issue>', 'issue number')
    .option('--dry-run', 'show what would run without creating anything')
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, options: { dryRun?: boolean; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => worktreeStart(ctx, parseIssueNumber(issue), { dryRun: options.dryRun === true }),
        describeWorktreeStart,
      );
    });

  worktree
    .command('finish')
    .description('After the merge: update the main checkout, remove the task worktree and delete its branch, never forced')
    .addHelpText(
      'after',
      '\nIgnored files in the worktree (build output, node_modules) are removed together with it; an ignored .env file or directory makes finish refuse, so move it out first.',
    )
    .argument('<issue>', 'issue number')
    .option('--dry-run', 'show what would run without changing anything')
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, options: { dryRun?: boolean; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => worktreeFinish(ctx, parseIssueNumber(issue), { dryRun: options.dryRun === true }),
        describeWorktreeFinish,
      );
    });
}
