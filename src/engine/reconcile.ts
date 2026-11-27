import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../commands/context.js';
import { fetchTask, trackerStep } from '../commands/context.js';
import { targetByName, typeRegistry } from '../config/schema.js';
import {
  approvalEvent,
  ApprovalRefusedError,
  finalMergeTime,
  normalizeCommentUrl,
  parseApprovalCommands,
  validateCommentApproval,
  type ApprovalCommand,
} from '../core/approvals.js';
import { parsePrBody } from '../core/prBody.js';
import { projectTask, type BoardFields } from '../core/projection.js';
import { applyEvent, TransitionError } from '../core/stateMachine.js';
import { DELIVERY_REPORT_HEADING, renderDeliveryReport } from '../core/summary.js';
import type { Approval, TaskEvent, TaskState, TaskTypeDef } from '../core/types.js';
import type { IssueComment, PrInfo, TrackedTask, Tracker } from '../tracker/types.js';
import { DEPLOYMENT_LOOKBACK, satisfiedTargets } from './deployments.js';

export interface ReconcileAction {
  /** The task issue; 0 for a failure that concerns no single task (listing the tasks). */
  issue: number;
  kind:
    | 'pr_merged'
    | 'targets_deployed'
    | 'approval'
    | 'ignored_approval'
    | 'issue_reopened'
    | 'issue_closed'
    | 'fields_synced'
    | 'delivery_report'
    | 'skipped_unknown_type'
    | 'error';
  detail: string;
}

export interface ReconcileOptions {
  /** Read everything and report the actions it would take, writing nothing. */
  dryRun?: boolean;
  /** `deployments`: only tasks awaiting deployment, only the deployment check and the projection. */
  only?: 'deployments' | 'all';
  /** Only this task; an error when it is not tracked. */
  issue?: number;
}

export interface ReconcileResult {
  actions: ReconcileAction[];
  /** How many of `actions` are `error`. */
  errors: number;
}

/** Later than any real timestamp: checks whether an approval fits the state whatever its time. */
const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const byTime = (a: string | undefined, b: string | undefined): number => Date.parse(a ?? '') - Date.parse(b ?? '');

/**
 * Wraps `inner` for one run: deployments, releases, ancestry and the login are read at most once
 * per argument set (a failed read is retried by the next caller). In a dry run every write rejects,
 * so a write that slipped through cannot reach the tracker.
 */
function runTracker(inner: Tracker, dryRun: boolean): Tracker {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const fresh = read();
    cache.set(key, fresh);
    fresh.catch(() => cache.delete(key));
    return fresh;
  };
  const write =
    <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      dryRun ? Promise.reject(new Error(`${name} is not allowed in a dry run`)) : call(...args);

  return {
    authenticatedLogin: () => once('login', () => inner.authenticatedLogin()),
    listSuccessfulDeployments: (environment, limit) =>
      once(`deployments:${environment}:${limit}`, () => inner.listSuccessfulDeployments(environment, limit)),
    listReleases: limit => once(`releases:${limit}`, () => inner.listReleases(limit)),
    isAncestor: (ancestor, descendant) =>
      once(`ancestor:${ancestor}>${descendant}`, () => inner.isAncestor(ancestor, descendant)),
    listTrackedTasks: () => inner.listTrackedTasks(),
    listUntracked: () => inner.listUntracked(),
    getTask: issue => inner.getTask(issue),
    listComments: (issue, sinceIso) => inner.listComments(issue, sinceIso),
    listTaskPrs: issue => inner.listTaskPrs(issue),
    isOnDefaultBranch: sha => inner.isOnDefaultBranch(sha),
    createIssue: write('createIssue', (title, body, labels) => inner.createIssue(title, body, labels)),
    addToBoard: write('addToBoard', issue => inner.addToBoard(issue)),
    writeState: write('writeState', (issue, state) => inner.writeState(issue, state)),
    postComment: write('postComment', (issue, body) => inner.postComment(issue, body)),
    setIssueOpen: write('setIssueOpen', (issue, open, reason) => inner.setIssueOpen(issue, open, reason)),
    setLabels: write('setLabels', (issue, add, remove) => inner.setLabels(issue, add, remove)),
    syncFields: write('syncFields', (issue, fields) => inner.syncFields(issue, fields)),
    createDeployment: write('createDeployment', input => inner.createDeployment(input)),
  };
}

/**
 * Brings the tracked tasks in line with what happened on GitHub, then the board and the issues in
 * line with the tasks. Per task, in order:
 * 1. a task whose type is not enabled is reported `skipped_unknown_type` and left alone;
 * 2. each PR merged into the default branch and not yet recorded with its merge commit becomes
 *    `pr_merged`, with the scope from its body (an unrecognised `Scope:` value is an `error` and
 *    the merge is not recorded, so it is picked up once the body is fixed);
 * 3. owner commands in comments on the issue and its PRs, oldest first, become `stage_approved`
 *    (for the phase the task is paused in, waiting on the owner), `accepted`, `confirmed_ran` or
 *    `cancelled`, checked by `validateCommentApproval` like `sdlc approve`. A comment already
 *    recorded as an approval is skipped silently; any other command that does not count is an
 *    `ignored_approval` saying why;
 * 4. a task awaiting deployment gets `targets_deployed` for the targets deployment evidence
 *    satisfies; when that completes it, the delivery report is posted (unless one already was
 *    since the last reopen) before the state is written;
 * 5. the state is written when it changed, the board fields are synced (every run; the tracker
 *    skips unchanged fields) and the issue is opened or closed to match the projection.
 * Done tasks get no events in steps 2-4. Events are timed with GitHub's clock: the merge time, the
 * comment time, the newest satisfying deployment or release.
 *
 * `fields_synced` is reported when the projected fields of the new state differ from those of the
 * stored state, dry run or not; a sync that repairs drift on the board alone is not reported.
 *
 * A failure on one task is recorded as an `error` action and the other tasks still run; a failed
 * read or write stops that task's remaining steps, except that failed field and issue syncs are
 * independent of each other. `errors` counts the `error` actions. In a full run (no `issue`, `only`
 * not `deployments`) each `sdlc:task` issue without readable state is also an `error`.
 */
export async function reconcile(ctx: CommandContext, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;
  const only = opts.only ?? 'all';
  const run: CommandContext = { ...ctx, tracker: runTracker(ctx.tracker, dryRun) };
  const actions: ReconcileAction[] = [];

  for (const task of await loadTasks(run, opts, only, actions)) {
    if (only === 'deployments' && task.state.status !== 'awaiting_deployment') continue;
    try {
      await reconcileTask(run, task, { dryRun, only }, actions);
    } catch (error) {
      actions.push({ issue: task.issue, kind: 'error', detail: reasonOf(error) });
    }
  }
  return { actions, errors: actions.filter(action => action.kind === 'error').length };
}

async function loadTasks(
  ctx: CommandContext,
  opts: ReconcileOptions,
  only: 'deployments' | 'all',
  actions: ReconcileAction[],
): Promise<TrackedTask[]> {
  if (opts.issue !== undefined) {
    try {
      return [await fetchTask(ctx, opts.issue)];
    } catch (error) {
      actions.push({ issue: opts.issue, kind: 'error', detail: reasonOf(error) });
      return [];
    }
  }

  let tasks: TrackedTask[] = [];
  try {
    tasks = await trackerStep('listTrackedTasks', undefined, () => ctx.tracker.listTrackedTasks());
  } catch (error) {
    actions.push({ issue: 0, kind: 'error', detail: reasonOf(error) });
  }
  if (only === 'all') {
    try {
      const untracked = await trackerStep('listUntracked', undefined, () => ctx.tracker.listUntracked());
      for (const issue of untracked) {
        actions.push({ issue: issue.issue, kind: 'error', detail: `untracked sdlc:task issue: ${issue.reason}` });
      }
    } catch (error) {
      actions.push({ issue: 0, kind: 'error', detail: reasonOf(error) });
    }
  }
  return tasks;
}

/** One task's run: `state` is the working copy that events are applied to. */
interface TaskRun {
  ctx: CommandContext;
  task: TrackedTask;
  type: TaskTypeDef;
  state: TaskState;
  dryRun: boolean;
  push: (kind: ReconcileAction['kind'], detail: string) => void;
}

async function reconcileTask(
  ctx: CommandContext,
  task: TrackedTask,
  opts: { dryRun: boolean; only: 'deployments' | 'all' },
  actions: ReconcileAction[],
): Promise<void> {
  const { issue } = task;
  const push = (kind: ReconcileAction['kind'], detail: string): void => void actions.push({ issue, kind, detail });
  const type = typeRegistry(ctx.cfg).get(task.state.type);
  if (!type) {
    push('skipped_unknown_type', `task type "${task.state.type}" is not enabled`);
    return;
  }

  const t: TaskRun = { ctx, task, type, state: task.state, dryRun: opts.dryRun, push };
  if (t.state.status !== 'done' && opts.only === 'all') {
    const prs = await trackerStep('listTaskPrs', issue, () => ctx.tracker.listTaskPrs(issue));
    applyMerges(t, prs);
    await applyApprovals(t, prs);
  }
  const reportPosted = await applyDeployments(t);
  await project(t, reportPosted);
}

/** Applies `event`; an invalid transition is an `error` action and leaves the state as it was. */
function applyOrReport(t: TaskRun, event: TaskEvent, at: string): boolean {
  try {
    t.state = applyEvent(t.state, event, t.type, at);
    return true;
  } catch (error) {
    if (!(error instanceof TransitionError)) throw error;
    t.push('error', `${event.kind}: ${error.message}`);
    return false;
  }
}

/** Step 2: merged PRs, in merge order. */
function applyMerges(t: TaskRun, prs: readonly PrInfo[]): void {
  const merged = prs
    .filter(pr => pr.merged && pr.mergeSha && pr.baseRef === t.ctx.cfg.github.defaultBranch)
    .sort((a, b) => byTime(a.mergedAt, b.mergedAt));
  for (const pr of merged) {
    if (t.state.status === 'done') return;
    if (t.state.prs.some(recorded => recorded.number === pr.number && recorded.mergeSha)) continue;
    const body = parsePrBody(pr.body);
    if (!body.scopeRecognized) {
      t.push('error', `unrecognised Scope value on PR #${pr.number}`);
      continue;
    }
    const event: TaskEvent = { kind: 'pr_merged', pr: pr.number, scope: body.scope, mergeSha: pr.mergeSha as string };
    if (applyOrReport(t, event, pr.mergedAt ?? t.ctx.now())) {
      t.push('pr_merged', `PR #${pr.number} merged (${body.scope}) as ${pr.mergeSha}`);
    }
  }
}

/** Comment URLs already recorded as approvals in `state`. */
function recordedRefs(state: TaskState): Set<string> {
  const approvals = [state.outcomeApproval, ...Object.values(state.stages).map(stage => stage?.approval)];
  return new Set(
    approvals.filter((a): a is Approval => a !== undefined && a.ref !== '').map(a => normalizeCommentUrl(a.ref)),
  );
}

function describeApproval(command: ApprovalCommand, approval: Approval, state: TaskState): string {
  const outcome = {
    approve: `stage "${state.phase}" approved`,
    accept: 'result accepted',
    ran: 'run confirmed',
    cancel: `cancelled: ${state.cancelReason ?? ''}`,
  }[command.action];
  const unverified = approval.source === 'unverified' ? ' (unverified: own login)' : '';
  return `/${command.action} by ${approval.by} (${approval.ref})${unverified}: ${outcome}`;
}

/** Step 3: owner commands on the issue and its PRs, oldest first. */
async function applyApprovals(t: TaskRun, prs: readonly PrInfo[]): Promise<void> {
  const { ctx, task } = t;
  const comments: IssueComment[] = [];
  for (const thread of [task.issue, ...prs.map(pr => pr.number)]) {
    comments.push(...(await trackerStep('listComments', task.issue, () => ctx.tracker.listComments(thread))));
  }
  comments.sort((a, b) => byTime(a.createdAt, b.createdAt));
  const parsed = parseApprovalCommands(comments, ctx.cfg.owners);
  const commands = [...parsed, ...parsed.ignored].sort((a, b) => byTime(a.comment.createdAt, b.comment.createdAt));
  const login = () => trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin());

  for (const command of commands) {
    const { comment, action } = command;
    if (recordedRefs(t.state).has(normalizeCommentUrl(comment.url))) continue;
    const ignore = (why: string): void => t.push('ignored_approval', `/${action} (${comment.url}): ${why}`);
    try {
      const state = t.state;
      if (state.status === 'done') throw new TransitionError('the task is already done');
      const pausedOnOwner = state.status === 'paused' && state.waitingOn === 'owner';
      const reason = command.reason ?? '';
      if (parsed.includes(command)) {
        // Whether the command fits the task at all, before its author, edits or timing are checked.
        if (action === 'approve' && !pausedOnOwner) throw new TransitionError('the task is not paused waiting on the owner');
        const probe: Approval = { source: 'unverified', ref: '', by: '', at: FAR_FUTURE };
        applyEvent(state, approvalEvent(action, state.phase, reason, probe), t.type, FAR_FUTURE);
      }
      const { approval } = await validateCommentApproval({
        comment,
        action,
        phase: state.phase,
        state,
        cfg: ctx.cfg,
        login,
        finalMergedAt: async () => finalMergeTime(state, prs),
      });
      t.state = applyEvent(state, approvalEvent(action, state.phase, reason, approval), t.type, comment.createdAt);
      t.push('approval', describeApproval(command, approval, t.state));
    } catch (error) {
      if (!(error instanceof ApprovalRefusedError || error instanceof TransitionError)) throw error;
      ignore(error.message);
    }
  }
}

/**
 * When the evidence behind `urls` was created: the newest of the satisfying deployments (or
 * releases) of `targets`, read from the run's cached lists; `undefined` when none is found.
 */
async function evidenceTime(t: TaskRun, targets: string[], urls: string[]): Promise<string | undefined> {
  const wanted = new Set(urls);
  const times: string[] = [];
  for (const name of targets) {
    const target = targetByName(t.ctx.cfg, name);
    const deployments = await t.ctx.tracker.listSuccessfulDeployments(target.environment, DEPLOYMENT_LOOKBACK);
    const deployment = deployments.find(d => wanted.has(d.url));
    if (deployment) {
      times.push(deployment.createdAt);
    } else if (target.deploy.via === 'release') {
      const release = (await t.ctx.tracker.listReleases(DEPLOYMENT_LOOKBACK)).find(r => wanted.has(r.url));
      if (release) times.push(release.publishedAt);
    }
  }
  return times.sort(byTime).at(-1);
}

/** Step 4: deployment evidence. Returns whether a delivery report was posted in this run. */
async function applyDeployments(t: TaskRun): Promise<boolean> {
  const { ctx, task } = t;
  if (t.state.status !== 'awaiting_deployment') return false;
  if (t.state.pendingTargets.length === 0) {
    t.push('error', 'no targets declared');
    return false;
  }
  const state = t.state;
  const found = await trackerStep('satisfiedTargets', task.issue, () => satisfiedTargets(ctx.tracker, ctx.cfg, state));
  if (found.targets.length === 0) return false;

  const at = (await evidenceTime(t, found.targets, found.urls)) ?? ctx.now();
  const event: TaskEvent = { kind: 'targets_deployed', targets: found.targets, deploymentUrls: found.urls };
  if (!applyOrReport(t, event, at)) return false;
  t.push('targets_deployed', `${found.targets.join(', ')} deployed (${found.urls.join(', ')})`);
  // `applyOrReport` replaced `t.state`, so the narrowing from the check above no longer holds.
  if ((t.state as TaskState).status !== 'done') return false;

  // A report posted by an earlier run whose state write failed must not be posted again.
  const since = task.state.reopenedAt;
  const comments = await trackerStep('listComments', task.issue, () => ctx.tracker.listComments(task.issue, since));
  if (comments.some(comment => comment.body.trimStart().startsWith(DELIVERY_REPORT_HEADING))) return false;
  const report = renderDeliveryReport(t.state);
  if (!t.dryRun) {
    await trackerStep('postComment', task.issue, () => ctx.tracker.postComment(task.issue, report), 'the state was not changed');
  }
  t.push('delivery_report', `delivery report posted (${(t.state.deliveredBy ?? []).join(', ')})`);
  return true;
}

const changedFields = (before: BoardFields, after: BoardFields): string[] =>
  (Object.keys(after) as (keyof BoardFields)[]).filter(key => before[key] !== after[key]);

/** Step 5: write the state if it changed, sync the board fields, open or close the issue. */
async function project(t: TaskRun, reportPosted: boolean): Promise<void> {
  const { ctx, task, state, dryRun } = t;
  const { issue } = task;
  if (!isDeepStrictEqual(task.state, state) && !dryRun) {
    const hint = reportPosted ? 'the delivery report was posted; the state was not changed' : 'the state was not changed';
    await trackerStep('writeState', issue, () => ctx.tracker.writeState(issue, state), hint);
  }

  const previous = projectTask(task.state, t.type);
  const projection = projectTask(state, t.type);
  try {
    if (!dryRun) await trackerStep('syncFields', issue, () => ctx.tracker.syncFields(issue, projection.fields));
    const changed = changedFields(previous.fields, projection.fields);
    if (changed.length > 0) t.push('fields_synced', changed.join(', '));
  } catch (error) {
    t.push('error', reasonOf(error));
  }

  if (projection.issueOpen === task.issueOpen) return;
  try {
    if (!dryRun) {
      await trackerStep('setIssueOpen', issue, () =>
        ctx.tracker.setIssueOpen(issue, projection.issueOpen, projection.closeReason),
      );
    }
    if (projection.issueOpen) t.push('issue_reopened', 'issue reopened: the task is not done');
    else t.push('issue_closed', `issue closed as ${projection.closeReason}`);
  } catch (error) {
    t.push('error', reasonOf(error));
  }
}
