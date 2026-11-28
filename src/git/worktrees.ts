import { isAbsolute, join, relative, sep } from 'node:path';
import { taskIssueOf } from '../commands/githook.js';
import type { Status } from '../core/types.js';
import { realPathOf } from '../hooks/resolve.js';
import type { GitRunner } from '../install/provision.js';

/** Where the task worktrees live, under the root of the main checkout. */
export const WORKTREES_DIR = '.worktrees';

/** One entry of `git worktree list --porcelain`. */
export interface Worktree {
  /** Absolute path, as git reports it. */
  path: string;
  /** The commit checked out; absent for a bare repository. */
  head?: string;
  /** The checked-out branch without `refs/heads/`; absent on a detached HEAD and for a bare repository. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** git would prune it: its directory is gone. */
  prunable: boolean;
}

const BRANCH_REF = 'refs/heads/';

/** Parses the output of `git worktree list --porcelain`: one record per `worktree <path>` line. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), detached: false, bare: false, locked: false, prunable: false };
      worktrees.push(current);
    } else if (current !== undefined) {
      if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        current.branch = ref.startsWith(BRANCH_REF) ? ref.slice(BRANCH_REF.length) : ref;
      } else if (line === 'detached') current.detached = true;
      else if (line === 'bare') current.bare = true;
      // `locked` and `prunable` may be followed by a reason.
      else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
    }
  }
  return worktrees;
}

/** The worktrees of the repository `git` runs in, the main checkout first. Rejects when git fails. */
export async function listWorktrees(git: GitRunner): Promise<Worktree[]> {
  const result = await git(['worktree', 'list', '--porcelain']);
  if (result.code !== 0) {
    throw new Error(`git worktree list failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`);
  }
  return parseWorktreeList(result.stdout);
}

const SLUG_MAX = 40;

/**
 * A few kebab-case words from a task title for its branch and directory: lowercase, every run of
 * characters other than `a-z0-9` one dash, no dash at either end, at most 40 characters (cut at a
 * dash when there is one to cut at), `task` when nothing is left.
 */
export function taskSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'task';
  if (slug.length <= SLUG_MAX) return slug;
  // A cut right before a dash keeps every word; else the word that does not fit is dropped.
  const end = slug[SLUG_MAX] === '-' ? SLUG_MAX : slug.lastIndexOf('-', SLUG_MAX);
  return slug.slice(0, end > 0 ? end : SLUG_MAX);
}

/** Whether `path` is inside `dir`; `dir` itself is not. Both must be spelled the same way (absolute, real). */
export function isPathUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface OrphanWorktree {
  path: string;
  /** Absent for a detached HEAD. */
  branch?: string;
  /**
   * `no-task`: the task branch names no tracked task; `task-done`: its task is done, so the worktree
   * is due for `sdlc worktree finish`; `detached`: no branch at all; `prunable`: its directory is gone.
   */
  reason: 'no-task' | 'task-done' | 'detached' | 'prunable';
}

function orphanReason(worktree: Worktree, tasks: Map<number, { status: Status }>): OrphanWorktree['reason'] | undefined {
  if (worktree.prunable) return 'prunable';
  if (worktree.detached) return 'detached';
  const issue = taskIssueOf(worktree.branch);
  // A branch that is not `task/<n>-...` is somebody's own worktree: not ours to judge.
  if (issue === undefined) return undefined;
  const task = tasks.get(issue);
  if (task === undefined) return 'no-task';
  return task.status === 'done' ? 'task-done' : undefined;
}

/**
 * The worktrees under `<repoRoot>/.worktrees/` that no live task needs, in the order git lists them.
 * Worktrees elsewhere (the main checkout, ones made by hand) are never reported. `repoRoot` may be
 * spelled through a symlink (the temp directory of macOS is one) or in another letter case: it and the
 * worktree paths are compared as real paths, like `sdlc worktree finish` compares them. The paths in
 * the result are the ones git reported.
 */
export function orphanWorktrees(
  worktrees: Worktree[],
  repoRoot: string,
  tasks: Map<number, { status: Status }>,
): OrphanWorktree[] {
  const base = realPathOf(join(repoRoot, WORKTREES_DIR));
  const orphans: OrphanWorktree[] = [];
  for (const worktree of worktrees) {
    if (worktree.bare || !isPathUnder(base, realPathOf(worktree.path))) continue;
    const reason = orphanReason(worktree, tasks);
    if (reason === undefined) continue;
    orphans.push({ path: worktree.path, ...(worktree.branch === undefined ? {} : { branch: worktree.branch }), reason });
  }
  return orphans;
}
