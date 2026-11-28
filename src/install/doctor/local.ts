import { deadlineOf, isNoTaskError, taskIssueOf } from '../../commands/githook.js';
import type { Config } from '../../config/schema.js';
import type { Status } from '../../core/types.js';
import { listWorktrees, orphanWorktrees, type OrphanWorktree, type Worktree } from '../../git/worktrees.js';
import { GitHubTracker } from '../../github/githubTracker.js';
import { readJsonLines } from '../../hooks/localLog.js';
import { OUTBOX_FAILED_FILE, queuedCounts } from '../../outbox/outbox.js';
import type { Tracker } from '../../tracker/types.js';
import { describeError, printable, ok, warn, notChecked, ghReason, list, isRecord, type Check, type DoctorEnv } from './types.js';

/** The local queues and the task worktrees: what waits for `sdlc sync` and the worktrees no live task needs. */

export type WorktreeList = { worktrees: Worktree[]; mainRoot: string } | { error: unknown };

/** `git worktree list` once per run; the main checkout (first, not bare) is where the kit keeps its local files. */
export function worktreeLister(env: DoctorEnv): () => Promise<WorktreeList> {
  let known: Promise<WorktreeList> | undefined;
  return () =>
    (known ??= listWorktrees(env.git).then(
      (worktrees): WorktreeList => ({ worktrees, mainRoot: worktrees.find(worktree => !worktree.bare)?.path ?? env.fs.root }),
      (error: unknown): WorktreeList => ({ error }),
    ));
}

/** What waits for `sdlc sync` in the cache of the main checkout (also when doctor runs in a worktree). */
export async function checkOutbox(env: DoctorEnv, worktrees: () => Promise<WorktreeList>): Promise<Check> {
  const id = 'outbox.pending';
  const found = await worktrees();
  const root = 'error' in found ? env.fs.root : found.mainRoot;
  const { outbox, gaps } = await queuedCounts(root);
  let failed = 0;
  try {
    failed = (await readJsonLines<unknown>(root, OUTBOX_FAILED_FILE)).filter(isRecord).length;
  } catch {
    // A file that cannot be read counts as empty, as it does for the queue.
  }
  if (outbox + failed > 0) return warn(id, `${outbox} queued write(s), ${failed} failed; run sdlc sync`, 'sdlc sync');
  // A gap is a note for `sdlc sync` to pick up, not something to fix: it is no warning.
  return ok(id, gaps === 0 ? 'nothing is queued for sdlc sync' : `no queued writes; ${gaps} gap(s) waiting for sync`);
}

/** Longest the task lookups of `worktrees.orphans` may take in all. */
const TASK_LOOKUP_MS = 10_000;

const orphanLabel = (orphan: OrphanWorktree): string =>
  `${printable(orphan.path)}${orphan.branch === undefined ? '' : ` (${printable(orphan.branch)})`}: ${orphan.reason}`;

function orphanFix(orphans: readonly OrphanWorktree[]): string {
  const fixes = new Set<string>();
  for (const orphan of orphans) {
    const issue = taskIssueOf(orphan.branch);
    if (orphan.reason === 'prunable') fixes.add('git worktree prune');
    else if (orphan.reason === 'task-done' && issue !== undefined) fixes.add(`sdlc worktree finish ${issue}`);
    else fixes.add(`git worktree remove ${orphan.path}`);
  }
  return [...fixes].join('; ');
}

/**
 * Looks up each of `orphans` (task branches no task was found for) and records the status of the tasks that exist in `tasks`.
 * Returns why the tasks cannot be read, `undefined` when they could. Read only; the whole lookup has one deadline.
 */
async function lookUpTasks(
  tracker: Tracker,
  orphans: readonly OrphanWorktree[],
  tasks: Map<number, { status: Status }>,
): Promise<string | undefined> {
  const deadline = deadlineOf(TASK_LOOKUP_MS);
  try {
    for (const orphan of orphans) {
      const issue = taskIssueOf(orphan.branch);
      if (issue === undefined) continue;
      try {
        const task = await deadline.run(() => tracker.getTask(issue));
        tasks.set(issue, { status: task.state.status });
      } catch (error) {
        // An issue with no readable task is what makes a worktree an orphan; anything else is "cannot tell".
        if (!isNoTaskError(error)) return ghReason(error);
      }
    }
    return undefined;
  } finally {
    deadline.stop();
  }
}

/**
 * Worktrees under `.worktrees/` that no live task needs. Only a task branch with no task in hand
 * costs a GitHub read (`getTask`, read only); with GitHub unreachable or `gh` unusable the answer
 * is "not checked (tasks unavailable)", plus the orphans that need no task (detached, prunable).
 */
export async function checkWorktreeOrphans(
  env: DoctorEnv,
  cfg: Config,
  blocker: string | undefined,
  worktrees: () => Promise<WorktreeList>,
): Promise<Check> {
  const id = 'worktrees.orphans';
  const found = await worktrees();
  if ('error' in found) return notChecked(id, describeError(found.error));
  const { mainRoot } = found;

  const candidates = orphanWorktrees(found.worktrees, mainRoot, new Map()).filter(orphan => orphan.reason === 'no-task');
  const tasks = new Map<number, { status: Status }>();
  let unavailable: string | undefined;
  if (candidates.length > 0) {
    unavailable =
      blocker ?? (await lookUpTasks(env.makeTracker?.(cfg) ?? new GitHubTracker(env.run, cfg, { repoRoot: mainRoot }), candidates, tasks));
  }

  const orphans = orphanWorktrees(found.worktrees, mainRoot, tasks);
  if (unavailable !== undefined) {
    const known = orphans.filter(orphan => orphan.reason !== 'no-task');
    return warn(
      id,
      `not checked (tasks unavailable: ${unavailable})${known.length > 0 ? `; orphans that need no task: ${list(known.map(orphanLabel))}` : ''}`,
      known.length > 0 ? orphanFix(known) : undefined,
    );
  }
  if (orphans.length === 0) return ok(id, `no orphan worktrees under .worktrees (${found.worktrees.length} worktree(s) listed)`);
  return warn(id, `orphan worktrees: ${list(orphans.map(orphanLabel))}`, orphanFix(orphans));
}
