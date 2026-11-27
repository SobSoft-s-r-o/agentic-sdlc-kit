import { targetByName, type Config } from '../config/schema.js';
import type { TaskState } from '../core/types.js';
import type { Tracker } from '../tracker/types.js';

/** How many of the newest successful deployments to an environment count as evidence. */
export const DEPLOYMENT_LOOKBACK = 50;

/**
 * The pending targets of `state` that deployment evidence satisfies. A target is satisfied when
 * every merged PR's merge commit is an ancestor of (or equal to) one of the last
 * `DEPLOYMENT_LOOKBACK` successful deployments to the target's environment. It need not be the
 * latest one: a rollback never takes back a target that a past deployment already satisfied.
 *
 * PRs without a merge commit do not count, and a task with no merged PR satisfies nothing. A
 * pending target missing from the config is an error naming it. `urls` lists, without
 * duplicates, the newest satisfying deployment of each satisfied target. A failed tracker call
 * rejects.
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

  const targets: string[] = [];
  const urls = new Set<string>();
  for (const target of pending) {
    const deployments = await tracker.listSuccessfulDeployments(target.environment, DEPLOYMENT_LOOKBACK);
    for (const deployment of deployments) {
      if (await containsAll(tracker, mergeShas, deployment.sha)) {
        targets.push(target.name);
        urls.add(deployment.url);
        break;
      }
    }
  }
  return { targets, urls: [...urls] };
}

async function containsAll(tracker: Tracker, shas: string[], deployedSha: string): Promise<boolean> {
  for (const sha of shas) {
    if (!(await tracker.isAncestor(sha, deployedSha))) return false;
  }
  return true;
}
