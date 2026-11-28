import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../commands/context.js';
import { expectedOf, fetchTask, trackerStep } from '../commands/context.js';
import { targetByName, typeRegistry, type Config } from '../config/schema.js';
import {
  approvalEvent,
  ApprovalRefusedError,
  assertApprovalFits,
  finalMergeTime,
  normalizeCommentUrl,
  parseApprovalCommands,
  PR_BODY_EDITED_MESSAGE,
  prBodyEditedAfter,
  recordedRefs,
  validateCommentApproval,
  type ApprovalCommand,
} from '../core/approvals.js';
import { parsePrBody } from '../core/prBody.js';
import { cancelReasonOf, projectTask, type BoardFields } from '../core/projection.js';
import { applyEvent, TransitionError } from '../core/stateMachine.js';
import {
  CANCEL_REPORT_HEADING,
  DELIVERY_REPORT_HEADING,
  renderCancelReport,
  renderDeliveryReport,
} from '../core/summary.js';
import { trustedLogins } from '../core/trust.js';
import type { Approval, TaskEvent, TaskState, TaskTypeDef } from '../core/types.js';
import type { IssueComment, PrInfo, ScanOptions, TaskScan, TrackedTask, Tracker } from '../tracker/types.js';
import { DEPLOYMENT_LOOKBACK, firstContaining, mergeShasOf, satisfiedTargets } from './deployments.js';

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
    /** `sdlc:partial` added to or removed from a PR so that it matches its body's `Scope:`; the detail is `PR #<n>: +sdlc:partial` or `-sdlc:partial`. */
    | 'pr_label'
    | 'delivery_report'
    | 'cancel_report'
    | 'skipped_unknown_type'
    /** An `sdlc:task` issue without readable state: left alone, not an error (`sdlc task new --issue` adopts it). */
    | 'untracked'
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
  /**
   * Scan every `sdlc:task` issue, however long ago it was closed, instead of the open ones and
   * those closed within `reconcile.closedLookbackDays`. Does not apply to a given `scan`.
   */
  all?: boolean;
  /** A scan of the task issues already made by the caller, used instead of scanning again. */
  scan?: TaskScan;
}

export interface ReconcileResult {
  actions: ReconcileAction[];
  /** How many of `actions` are `error`. */
  errors: number;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The scan of a reconcile or status run that is not `--all`: the open `sdlc:task` issues and those
 * closed within `cfg.reconcile.closedLookbackDays` of `now`, i.e. updated on or after that date
 * (UTC; 30 days before 2026-11-27 is 2026-10-28). `--all` scans with `{}`: everything.
 */
export function lookbackScan(cfg: Config, now: string): ScanOptions {
  const since = new Date(Date.parse(now) - cfg.reconcile.closedLookbackDays * DAY_MS);
  return { closedSince: since.toISOString().slice(0, 10) };
}

/** Milliseconds of `iso`; a missing or unparseable time sorts last. */
const timeOf = (iso: string | undefined): number => {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? Infinity : ms;
};
/** Oldest first, missing times last; never NaN, so the sort is well defined. */
const byTime = (a: string | undefined, b: string | undefined): number => {
  const [x, y] = [timeOf(a), timeOf(b)];
  return x === y ? 0 : x < y ? -1 : 1;
};
/** `at`, unless the stored `updatedAt` is later: an event time from GitHub never moves it back. */
const laterOf = (stored: string, at: string): string => (byTime(stored, at) > 0 ? stored : at);

/**
 * Wraps `inner` for one run: the task scan, deployments, releases, ancestry and the login are read at most once
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
    scanTasks: opts => once(`scan:${opts?.closedSince ?? 'all'}`, () => inner.scanTasks(opts)),
    listTrackedTasks: () => once('scan:all', () => inner.scanTasks()).then(scan => scan.tracked),
    listUntracked: () => once('scan:all', () => inner.scanTasks()).then(scan => scan.untracked),
    getTask: issue => inner.getTask(issue),
    getIssue: issue => inner.getIssue(issue),
    listComments: (issue, sinceIso) => inner.listComments(issue, sinceIso),
    listTaskPrs: issue => inner.listTaskPrs(issue),
    getPr: pr => inner.getPr(pr),
    isOnDefaultBranch: sha => inner.isOnDefaultBranch(sha),
    createIssue: write('createIssue', (title, body, labels) => inner.createIssue(title, body, labels)),
    addToBoard: write('addToBoard', issue => inner.addToBoard(issue)),
    writeState: write('writeState', (issue, state, expected) => inner.writeState(issue, state, expected)),
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
 *    `pr_merged`, with the scope and (for a type that deploys) the targets from its body. An
 *    unrecognised `Scope:` value, an unknown target, or a final merge of a deploy task that still
 *    has no targets is an `error` and the merge is not recorded, so it is picked up once fixed;
 * 3. owner commands in comments on the issue and its PRs, oldest first, become `stage_approved`
 *    (for the phase the task is paused in, waiting on the owner), `accepted`, `confirmed_ran` or
 *    `cancelled`, checked by `validateCommentApproval` like `sdlc approve`. A comment already
 *    recorded as an approval is skipped silently; any other command that does not count (including
 *    one on a PR that links more than this task) is an `ignored_approval` saying why;
 * 3b. each PR linking the task gets the `sdlc:partial` label when its body says `Scope: partial`
 *    and loses it otherwise (`pr_label`; a PR that links several tasks is labelled once); a
 *    failed label write is an `error` and the other steps still run;
 * 4. a task awaiting deployment gets `targets_deployed` for the targets deployment evidence
 *    satisfies. When a cancellation or the deployments end the task in this run, the cancel or
 *    delivery report is posted before the state is written, unless a trusted author (tracker
 *    login, owner, Actions bot) already posted one since the last reopen; a failed post writes
 *    nothing;
 * 5. the state is written when it changed, the board fields are synced (the tracker skips
 *    unchanged fields) and the issue is opened or closed, with the right reason, to match the
 *    projection. A done task that did not change and whose issue is closed with the right reason
 *    is left alone.
 * Done tasks get no events in steps 2-4. Events are timed with GitHub's clock: the merge time, the
 * comment time, the newest satisfying deployment or release.
 *
 * `fields_synced` is reported when the projected fields of the new state differ from those of the
 * stored state, dry run or not; a sync that repairs drift on the board alone is not reported.
 *
 * A failure on one task is recorded as an `error` action and the other tasks still run; a failed
 * read or write stops that task's remaining steps, except that failed field and issue syncs are
 * independent of each other. `errors` counts the `error` actions. In a full run (no `issue`, `only`
 * not `deployments`) each `sdlc:task` issue without readable state is reported `untracked`, which
 * is not an error: reconcile leaves it alone.
 */
export async function reconcile(ctx: CommandContext, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;
  const only = opts.only ?? 'all';
  const run: CommandContext = { ...ctx, tracker: runTracker(ctx.tracker, dryRun) };
  const types = typeRegistry(ctx.cfg);
  const actions: ReconcileAction[] = [];

  // PRs already labelled (or reported) in this run: one PR can link several tasks.
  const labelled = new Set<number>();
  for (const task of await loadTasks(run, opts, only, actions)) {
    if (only === 'deployments' && task.state.status !== 'awaiting_deployment') continue;
    try {
      await reconcileTask(run, task, { dryRun, only, types, labelled }, actions);
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

  let scan: TaskScan;
  try {
    scan =
      opts.scan ??
      (await trackerStep('scanTasks', undefined, () =>
        ctx.tracker.scanTasks(opts.all ? {} : lookbackScan(ctx.cfg, ctx.now())),
      ));
  } catch (error) {
    actions.push({ issue: 0, kind: 'error', detail: reasonOf(error) });
    return [];
  }
  if (only === 'all') {
    for (const issue of scan.untracked) {
      actions.push({ issue: issue.issue, kind: 'untracked', detail: `untracked sdlc:task issue: ${issue.reason}` });
    }
  }
  return scan.tracked;
}

/** One task's run: `state` is the working copy that events are applied to. */
interface TaskRun {
  ctx: CommandContext;
  task: TrackedTask;
  type: TaskTypeDef;
  state: TaskState;
  dryRun: boolean;
  /** Numbers of the PRs whose `sdlc:partial` label this reconcile run has dealt with, shared by all tasks. */
  labelled: Set<number>;
  push: (kind: ReconcileAction['kind'], detail: string) => void;
}

async function reconcileTask(
  ctx: CommandContext,
  task: TrackedTask,
  opts: {
    dryRun: boolean;
    only: 'deployments' | 'all';
    types: ReadonlyMap<string, TaskTypeDef>;
    labelled: Set<number>;
  },
  actions: ReconcileAction[],
): Promise<void> {
  const { issue } = task;
  const push = (kind: ReconcileAction['kind'], detail: string): void => void actions.push({ issue, kind, detail });
  const type = opts.types.get(task.state.type);
  if (!type) {
    push('skipped_unknown_type', `task type "${task.state.type}" is not enabled`);
    return;
  }

  const t: TaskRun = { ctx, task, type, state: task.state, dryRun: opts.dryRun, labelled: opts.labelled, push };
  if (t.state.status !== 'done' && opts.only === 'all') {
    const prs = await trackerStep('listTaskPrs', issue, () => ctx.tracker.listTaskPrs(issue));
    applyMerges(t, prs);
    await applyApprovals(t, prs);
    await applyPartialLabels(t, prs);
  }
  const deliveredNow = await applyDeployments(t);
  const reportPosted = await postOutcomeReport(t, deliveredNow);
  await project(t, reportPosted);
}

/** Applies `event` at GitHub time `at`; the task's `updatedAt` never moves backwards. */
function applyAt(t: TaskRun, event: TaskEvent, at: string): void {
  const next = applyEvent(t.state, event, t.type, at);
  next.updatedAt = laterOf(t.state.updatedAt, at);
  t.state = next;
}

/** Applies `event`; an invalid transition is an `error` action and leaves the state as it was. */
function applyOrReport(t: TaskRun, event: TaskEvent, at: string): boolean {
  try {
    applyAt(t, event, at);
    return true;
  } catch (error) {
    if (!(error instanceof TransitionError)) throw error;
    t.push('error', `${event.kind}: ${error.message}`);
    return false;
  }
}

/** Whether the task type deploys to targets: its PRs' `Targets:` lines count. */
const usesTargets = (type: TaskTypeDef): boolean => type.endsOn === 'deploy' || type.targetsRequired;

/**
 * Step 2: merged PRs, in merge order. For a type that deploys to targets, the PR's `Targets:` are
 * added to the task's targets; an unknown target is an `error` and the merge is not recorded.
 */
function applyMerges(t: TaskRun, prs: readonly PrInfo[]): void {
  const merged = prs
    .filter(pr => pr.merged && pr.mergeSha && pr.baseRef === t.ctx.cfg.github.defaultBranch)
    .sort((a, b) => byTime(a.mergedAt, b.mergedAt) || a.number - b.number);
  for (const pr of merged) {
    if (t.state.status === 'done') return;
    if (t.state.prs.some(recorded => recorded.number === pr.number && recorded.mergeSha)) continue;
    const body = parsePrBody(pr.body);
    if (!body.scopeRecognized) {
      t.push('error', `unrecognised Scope value on PR #${pr.number}`);
      continue;
    }
    let targets: string[] = [];
    if (usesTargets(t.type)) {
      try {
        targets = body.targets.map(name => targetByName(t.ctx.cfg, name).name);
      } catch (error) {
        t.push('error', `PR #${pr.number}: ${reasonOf(error)}`);
        continue;
      }
    }
    const event: TaskEvent = {
      kind: 'pr_merged',
      pr: pr.number,
      scope: body.scope,
      mergeSha: pr.mergeSha as string,
      targets,
    };
    if (applyOrReport(t, event, pr.mergedAt ?? t.ctx.now())) {
      t.push('pr_merged', `PR #${pr.number} merged (${body.scope}) as ${pr.mergeSha}`);
    }
  }
}

function describeApproval(command: ApprovalCommand, approval: Approval, state: TaskState): string {
  const outcome = {
    approve: `stage "${state.phase}" approved`,
    accept: 'result accepted',
    ran: 'run confirmed',
    cancel: `cancelled: ${state.cancelReason ?? ''}`,
  }[command.action];
  const unverified = approval.source === 'unverified' ? ' (unverified: written by an agent login)' : '';
  return `/${command.action} by ${approval.by} (${approval.ref})${unverified}: ${outcome}`;
}

/**
 * Whether a comment made at `commentAt` on `pr` speaks for `issue`: the PR's body links exactly that
 * one issue, and was not edited after the comment (an edit may have re-pointed the PR to this task).
 */
const linksOnly = (pr: PrInfo, issue: number, commentAt: string): boolean => {
  if (prBodyEditedAfter(pr, commentAt)) return false;
  const linked = parsePrBody(pr.body).issues;
  return linked.length === 1 && linked[0] === issue;
};

/**
 * Step 3: owner commands on the issue and its PRs, oldest first. A command on a PR whose body links
 * more than this one task is ignored, and so is one the PR's body was edited after.
 */
async function applyApprovals(t: TaskRun, prs: readonly PrInfo[]): Promise<void> {
  const { ctx, task } = t;
  const comments: IssueComment[] = [];
  /**
   * Comments on a PR that cannot be told to be meant for this task, with why: its body links other
   * tasks too, or was edited after the comment.
   */
  const refusedPr = new Map<IssueComment, string>();
  for (const thread of [task.issue, ...prs.map(pr => pr.number)]) {
    const read = await trackerStep('listComments', task.issue, () => ctx.tracker.listComments(thread));
    const pr = prs.find(candidate => candidate.number === thread);
    if (pr) {
      for (const comment of read) {
        if (linksOnly(pr, task.issue, comment.createdAt)) continue;
        refusedPr.set(
          comment,
          prBodyEditedAfter(pr, comment.createdAt) ? PR_BODY_EDITED_MESSAGE : `PR #${pr.number} links several tasks`,
        );
      }
    }
    comments.push(...read);
  }
  // In observe mode an agent's command is recorded as unverified, so it is checked like an owner's.
  const deciders = ctx.cfg.mode === 'observe' ? [...ctx.cfg.owners, ...ctx.cfg.agents] : ctx.cfg.owners;
  const parsed = parseApprovalCommands(comments, deciders);
  const commands = [...parsed, ...parsed.ignored].sort((a, b) => byTime(a.comment.createdAt, b.comment.createdAt));
  const login = () => trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin());

  for (const command of commands) {
    const { comment, action } = command;
    if (recordedRefs(t.state).has(normalizeCommentUrl(comment.url))) continue;
    const ignore = (why: string): void => t.push('ignored_approval', `/${action} (${comment.url}): ${why}`);
    try {
      // Authorizes `task set-type` only; a recorded one was skipped above.
      if (command.typeId !== undefined) throw new ApprovalRefusedError('type-change approval');
      const refusal = refusedPr.get(comment);
      if (refusal !== undefined) throw new ApprovalRefusedError(refusal);
      const state = t.state;
      if (state.status === 'done') throw new TransitionError('the task is already done');
      const pausedOnOwner = state.status === 'paused' && state.waitingOn === 'owner';
      const reason = command.reason ?? '';
      if (parsed.includes(command)) {
        // Whether the command fits the task at all, before its author, edits or timing are checked.
        if (action === 'approve' && !pausedOnOwner) throw new TransitionError('the task is not paused waiting on the owner');
        assertApprovalFits(state, t.type, action, state.phase, reason);
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
      applyAt(t, approvalEvent(action, state.phase, reason, approval), comment.createdAt);
      t.push('approval', describeApproval(command, approval, t.state));
    } catch (error) {
      if (!(error instanceof ApprovalRefusedError || error instanceof TransitionError)) throw error;
      ignore(error.message);
    }
  }
}

/** The label a PR carries while its body says `Scope: partial` (spec section 8). */
const PARTIAL_LABEL = 'sdlc:partial';

/**
 * Step 3b: mirrors each PR's `Scope:` to the `sdlc:partial` label: added to a PR whose body says
 * `Scope: partial`, removed from any other (a missing or unrecognised scope counts as final, as
 * `parsePrBody` has it). The label is found without regard to case, as GitHub compares names, and
 * removed by the name the PR has. A PR in the right state costs no write. A failed write is an
 * `error` for that PR alone; the next run tries again.
 */
async function applyPartialLabels(t: TaskRun, prs: readonly PrInfo[]): Promise<void> {
  const { ctx, task } = t;
  for (const pr of prs) {
    if (t.labelled.has(pr.number)) continue;
    const present = pr.labels.find(label => label.toLowerCase() === PARTIAL_LABEL);
    const wanted = parsePrBody(pr.body).scope === 'partial';
    if (wanted === (present !== undefined)) continue;
    t.labelled.add(pr.number);
    try {
      if (!t.dryRun) {
        await trackerStep('setLabels', task.issue, () =>
          ctx.tracker.setLabels(pr.number, wanted ? [PARTIAL_LABEL] : [], wanted ? [] : [present ?? PARTIAL_LABEL]),
        );
      }
      t.push('pr_label', `PR #${pr.number}: ${wanted ? '+' : '-'}${PARTIAL_LABEL}`);
    } catch (error) {
      t.push('error', `PR #${pr.number}: ${reasonOf(error)}`);
    }
  }
}

/**
 * When the evidence for `targets` was created: per target, the newest deployment (or release)
 * that contains every merge commit, matched the same way `satisfiedTargets` found it (several
 * deployments may share one link), read from the run's cached lists; the newest of those, or
 * `undefined` when none is found.
 */
async function evidenceTime(t: TaskRun, targets: string[]): Promise<string | undefined> {
  const { tracker } = t.ctx;
  const shas = mergeShasOf(t.state);
  const times: string[] = [];
  for (const name of targets) {
    const target = targetByName(t.ctx.cfg, name);
    const deployments = await trackerStep('listSuccessfulDeployments', t.task.issue, () =>
      tracker.listSuccessfulDeployments(target.environment, DEPLOYMENT_LOOKBACK),
    );
    const deployment = await trackerStep('isAncestor', t.task.issue, () => firstContaining(tracker, shas, deployments));
    if (deployment) {
      times.push(deployment.createdAt);
    } else if (target.deploy.via === 'release') {
      const releases = await trackerStep('listReleases', t.task.issue, () => tracker.listReleases(DEPLOYMENT_LOOKBACK));
      const release = await trackerStep('isAncestor', t.task.issue, () => firstContaining(tracker, shas, releases));
      if (release) times.push(release.publishedAt);
    }
  }
  return times.sort(byTime).at(-1);
}

/** Step 4: deployment evidence. Returns whether the deployments completed the task in this run. */
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

  const at = (await evidenceTime(t, found.targets)) ?? ctx.now();
  const event: TaskEvent = { kind: 'targets_deployed', targets: found.targets, deploymentUrls: found.urls };
  if (!applyOrReport(t, event, at)) return false;
  t.push('targets_deployed', `${found.targets.join(', ')} deployed (${found.urls.join(', ')})`);
  // `applyOrReport` replaced `t.state`, so the narrowing from the check above no longer holds.
  return (t.state as TaskState).status === 'done';
}

/**
 * Whether a report starting with `heading` is already on the issue since the last reopen. Only
 * comments by trusted authors count (the tracker login, an owner, an agent, the Actions bot, any
 * letter case), so a forged heading from anyone else cannot suppress the real report.
 */
async function reportExists(t: TaskRun, heading: string): Promise<boolean> {
  const { ctx, task } = t;
  const login = await trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin());
  const trusted = trustedLogins(ctx.cfg, login);
  const since = task.state.reopenedAt;
  const comments = await trackerStep('listComments', task.issue, () => ctx.tracker.listComments(task.issue, since));
  return comments.some(
    comment => trusted.has(comment.author.toLowerCase()) && comment.body.trimStart().startsWith(heading),
  );
}

/**
 * Posts the report for an outcome reached in this run, before the state is written: the cancel
 * report for a cancellation, the delivery report when deployments completed the task. A report
 * already posted (by an earlier run whose state write failed) is not posted again. A failed post
 * rejects, so nothing is written. Returns whether a report was posted.
 */
async function postOutcomeReport(t: TaskRun, deliveredNow: boolean): Promise<boolean> {
  const { ctx, task } = t;
  if (task.state.status === 'done' || t.state.status !== 'done') return false;
  const cancelled = t.state.outcome === 'cancelled';
  if (!cancelled && !deliveredNow) return false;

  const heading = cancelled ? CANCEL_REPORT_HEADING : DELIVERY_REPORT_HEADING;
  if (await reportExists(t, heading)) return false;
  const report = cancelled ? renderCancelReport(t.state) : renderDeliveryReport(t.state);
  if (!t.dryRun) {
    await trackerStep('postComment', task.issue, () => ctx.tracker.postComment(task.issue, report), 'the state was not changed');
  }
  const posted = (what: string): string => (t.dryRun ? `would post ${what}` : `${what} posted`);
  if (cancelled) t.push('cancel_report', `${posted('cancel report')} (${cancelReasonOf(t.state)})`);
  else t.push('delivery_report', `${posted('delivery report')} (${(t.state.deliveredBy ?? []).join(', ')})`);
  return true;
}

const changedFields = (before: BoardFields, after: BoardFields): string[] =>
  (Object.keys(after) as (keyof BoardFields)[]).filter(key => before[key] !== after[key]);

/**
 * Step 5: write the state if it changed, sync the board fields, open or close the issue (or correct
 * the reason it was closed with). A done task that did not change, whose issue is closed with the
 * right reason, has nothing to converge and is left alone.
 */
async function project(t: TaskRun, reportPosted: boolean): Promise<void> {
  const { ctx, task, state, dryRun } = t;
  const { issue } = task;
  const unchanged = isDeepStrictEqual(task.state, state);
  const projection = projectTask(state, t.type);
  const closedRight = !task.issueOpen && task.closeReason === projection.closeReason;
  if (unchanged && state.status === 'done' && !projection.issueOpen && closedRight) return;

  if (!unchanged && !dryRun) {
    const hint = reportPosted ? 'the report was posted; the state was not changed' : 'the state was not changed';
    await trackerStep('writeState', issue, () => ctx.tracker.writeState(issue, state, expectedOf(task)), hint);
  }

  const previous = projectTask(task.state, t.type);
  try {
    if (!dryRun) await trackerStep('syncFields', issue, () => ctx.tracker.syncFields(issue, projection.fields));
    const changed = changedFields(previous.fields, projection.fields);
    if (changed.length > 0) t.push('fields_synced', changed.join(', '));
  } catch (error) {
    t.push('error', reasonOf(error));
  }

  const reasonOnly = !projection.issueOpen && !task.issueOpen;
  if (projection.issueOpen ? task.issueOpen : closedRight) return;
  try {
    if (!dryRun) {
      await trackerStep('setIssueOpen', issue, () =>
        ctx.tracker.setIssueOpen(issue, projection.issueOpen, projection.closeReason),
      );
    }
    if (projection.issueOpen) t.push('issue_reopened', 'issue reopened: the task is not done');
    else if (reasonOnly) t.push('issue_closed', `close reason corrected to ${projection.closeReason}`);
    else t.push('issue_closed', `issue closed as ${projection.closeReason}`);
  } catch (error) {
    t.push('error', reasonOf(error));
  }
}
