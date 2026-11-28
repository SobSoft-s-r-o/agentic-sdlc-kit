import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { taskIssueOf } from '../commands/githook.js';
import type { GitRunner } from '../install/provision.js';

/** A git checkout: the main one, or one of its worktrees. */
export interface Checkout {
  /** Top-level directory of this checkout, as git reports it. */
  root: string;
  /** The git directory shared by the main checkout and all its worktrees. */
  commonDir: string;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  /** The task issue when the branch is `task/<issue>-<slug>`. */
  issue?: number;
}

/**
 * `path` with the symlinks of its existing part resolved (the temp directory of macOS is one), and
 * the part that does not exist yet kept as written. The edited file may not exist, nor its directory.
 */
export function realPathOf(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      return join(realpathSync(existing), ...missing.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** The nearest directory that exists, `path` itself or the closest ancestor (a file counts as missing). */
function nearestDirectory(path: string): string | undefined {
  let dir = path;
  for (;;) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Not there: try the parent.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The checkout that contains `dir`, which may not exist yet: git runs in its nearest existing
 * ancestor. `undefined` outside any git checkout (also inside a `.git` directory, which is no work
 * tree). Rejects only when git cannot run at all.
 */
export async function checkoutOf(dir: string, gitFor: (cwd: string) => GitRunner): Promise<Checkout | undefined> {
  const start = nearestDirectory(realPathOf(dir));
  if (start === undefined) return undefined;
  const git = gitFor(start);

  const top = await git(['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir']);
  if (top.code !== 0) return undefined;
  const [root, commonDir] = top.stdout.split(/\r?\n/);
  if (!root || !commonDir) return undefined;

  const head = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() : '';
  const issue = taskIssueOf(branch === '' ? undefined : branch);
  return {
    root,
    commonDir,
    ...(branch === '' ? {} : { branch }),
    ...(issue === undefined ? {} : { issue }),
  };
}
