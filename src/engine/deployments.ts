import { targetByName, type Config } from '../config/schema.js';
import type { TaskState } from '../core/types.js';
import type { ReleaseInfo, Tracker } from '../tracker/types.js';

/** How many of the newest successful deployments (or releases) count as evidence. */
export const DEPLOYMENT_LOOKBACK = 50;

/**
 * The pending targets of `state` that deployment evidence satisfies. A target is satisfied when
 * every merged PR's merge commit is an ancestor of (or equal to) one of the last
 * `DEPLOYMENT_LOOKBACK` successful deployments to the target's environment. It need not be the
 * latest one: a rollback never takes back a target that a past deployment already satisfied.
 *
 * A target configured with `deploy.via: release` is also satisfied by a release: one of the last
 * `DEPLOYMENT_LOOKBACK` published releases whose commit contains every merge commit. Deployments
 * are checked first and still count for such a target; releases are only looked up when no
 * deployment satisfies it.
 *
 * PRs without a merge commit do not count, and a task with no merged PR satisfies nothing. A
 * pending target missing from the config is an error naming it. `urls` lists, without
 * duplicates, the newest satisfying deployment (or, for a release, its page) of each satisfied
 * target. A failed tracker call rejects.
 */
export async function satisfiedTargets(
  tracker: Tracker,
  cfg: Config,
  state: TaskState,
): Promise<{ targets: string[]; urls: string[] }> {
  // Resolved up front so that an unknown target is reported whatever the task's PRs look like.
  const pending = state.pendingTargets.map(name => targetByName(cfg, name));
  const mergeShas = [...new Set(state.prs.flatMap(pr => (pr.mergeSha ? [pr.mergeSha] : [])))];
  if (mergeShas.length === 0) return { targets: [], urls: [] };

  // Read at most once, and only for a release target that no deployment satisfied.
  let releases: Promise<ReleaseInfo[]> | undefined;
  const publishedReleases = (): Promise<ReleaseInfo[]> => (releases ??= tracker.listReleases(DEPLOYMENT_LOOKBACK));

  const targets: string[] = [];
  const urls = new Set<string>();
  for (const target of pending) {
    const deployments = await tracker.listSuccessfulDeployments(target.environment, DEPLOYMENT_LOOKBACK);
    let evidence: { url: string } | undefined = await firstContaining(tracker, mergeShas, deployments);
    if (!evidence && target.deploy.via === 'release') {
      evidence = await firstContaining(tracker, mergeShas, await publishedReleases());
    }
    if (evidence) {
      targets.push(target.name);
      urls.add(evidence.url);
    }
  }
  return { targets, urls: [...urls] };
}

/** The first of `candidates` (the newest) whose commit contains every one of `shas`. */
async function firstContaining<T extends { sha: string }>(
  tracker: Tracker,
  shas: string[],
  candidates: readonly T[],
): Promise<T | undefined> {
  for (const candidate of candidates) {
    if (await containsAll(tracker, shas, candidate.sha)) return candidate;
  }
  return undefined;
}

async function containsAll(tracker: Tracker, shas: string[], deployedSha: string): Promise<boolean> {
  for (const sha of shas) {
    if (!(await tracker.isAncestor(sha, deployedSha))) return false;
  }
  return true;
}
