import type { Command } from 'commander';
import {
  APPROVAL_ACTIONS,
  approvalEvent,
  assertApprovalFits,
  finalMergeTime,
  normalizeCommentUrl,
  recordedRefs,
  validateCommentApproval,
  type ApprovalAction,
} from '../core/approvals.js';
import { parsePrBody } from '../core/prBody.js';
import { renderCancelReport } from '../core/summary.js';
import type { Approval, Phase, TaskState } from '../core/types.js';
import type { IssueComment, PrInfo } from '../tracker/types.js';
import {
  commitLoaded,
  describeState,
  loadTask,
  parseChoice,
  parseIssueNumber,
  parsePhase,
  runCommand,
  trackerStep,
  type CommandContext,
  type ContextFactory,
  type LoadedTask,
} from './context.js';

export { APPROVAL_ACTIONS, type ApprovalAction };

export interface ApproveInput {
  action: ApprovalAction;
  /** `approve` only: the phase to approve; defaults to the task's current phase. */
  phase?: Phase;
  /** `cancel` only. */
  reason?: string;
  /** An owner's comment on the task issue or one of its PRs; mutually exclusive with `unverified`. */
  commentUrl?: string;
  /** Records the approval without proof; observe mode only. */
  unverified?: boolean;
}

/** The thread (issue or PR number) a comment URL points into, when the URL says. */
const threadOf = (url: string): number | undefined => {
  const match = /\/(?:issues|pull)\/(\d+)#issuecomment-/.exec(url);
  return match ? Number(match[1]) : undefined;
};

/**
 * Throws unless a comment on `pr` can speak for `issue`: the PR's body must link `issue` and no other
 * task, or the command cannot be told to be meant for this one.
 */
export function assertPrSpeaksFor(pr: PrInfo, issue: number, url: string): void {
  const linked = parsePrBody(pr.body).issues;
  if (!linked.includes(issue)) throw new Error(`comment ${url} is on PR #${pr.number}, which is not linked to #${issue}`);
  if (linked.length > 1) {
    throw new Error(
      `PR #${pr.number} links several tasks (${linked.map(n => `#${n}`).join(', ')}); post the command on the task issue`,
    );
  }
}

/**
 * The comment `url` on the task issue or one of its PRs. When the URL names a PR, that PR is read
 * directly (no search index) and must link this task only; otherwise the issue is searched, then the
 * task's PRs.
 */
export async function findComment(
  ctx: CommandContext,
  issue: number,
  url: string,
  listPrs: () => Promise<PrInfo[]>,
): Promise<IssueComment> {
  const wanted = normalizeCommentUrl(url);
  const onThread = async (thread: number): Promise<IssueComment | undefined> => {
    const comments = await trackerStep('listComments', issue, () => ctx.tracker.listComments(thread));
    return comments.find(comment => normalizeCommentUrl(comment.url) === wanted);
  };
  const notFound = (): Error => new Error(`comment ${url} was not found on #${issue} or its pull requests`);

  const thread = threadOf(url);
  if (thread !== undefined && thread !== issue) {
    const pr = await trackerStep('getPr', issue, () => ctx.tracker.getPr(thread));
    if (!pr) throw notFound();
    assertPrSpeaksFor(pr, issue, url);
    const found = await onThread(thread);
    if (found) return found;
    throw notFound();
  }

  const onIssue = await onThread(issue);
  if (onIssue) return onIssue;
  if (thread !== undefined) throw notFound();
  for (const pr of await listPrs()) {
    const onPr = await onThread(pr.number);
    if (onPr) {
      assertPrSpeaksFor(pr, issue, url);
      return onPr;
    }
  }
  throw notFound();
}

/**
 * Records `approval` as the owner's decision `input.action` on the task: the state-machine event,
 * written like any other (`commitLoaded`). The caller has already established where the approval
 * comes from and that it is genuine; this only applies it. The task is read here unless the caller
 * already has it (`loaded`, so a caller that looked at the state first does not read it twice).
 * `phase` defaults to the task's current phase and only matters for `approve`; `cancel` needs a
 * reason and posts the cancel report before the state is written.
 */
export async function applyApproval(
  ctx: CommandContext,
  issue: number,
  input: { action: ApprovalAction; phase?: Phase; reason?: string },
  approval: Approval,
  loaded?: LoadedTask,
): Promise<TaskState> {
  const { action } = input;
  const task = loaded ?? (await loadTask(ctx, issue));
  const phase = input.phase ?? task.task.state.phase;
  const reason = input.reason?.trim() ?? '';
  if (action === 'cancel' && !reason) throw new Error('cancel needs a reason (--reason <text>)');

  return commitLoaded(ctx, task, approvalEvent(action, phase, reason, approval), {
    beforeWrite:
      action === 'cancel'
        ? async next => {
            const report = renderCancelReport(next);
            await trackerStep('postComment', issue, () => ctx.tracker.postComment(issue, report), 'the state was not changed');
          }
        : undefined,
    writeHint: action === 'cancel' ? 'the cancel report was posted; the state was not changed' : undefined,
  });
}

/**
 * Records an owner decision on the task: `approve` a published stage, `accept` the published result,
 * confirm the production-data run (`ran`) or `cancel`. The decision needs a source: an owner's
 * `commentUrl`, or `unverified` (observe mode only). The comment must be that command (`/approve`,
 * `/accept`, `/ran`, `/cancel <reason>`), never edited after posting, and newer than what it acts
 * on. A comment by the tool's own login is the agent approving itself: refused in enforce mode,
 * recorded as unverified in observe mode. `cancel` needs a reason, from `input.reason` or else the
 * comment, and posts the cancel report before the state is written.
 */
export async function approve(ctx: CommandContext, issue: number, input: ApproveInput): Promise<TaskState> {
  const { action, commentUrl, unverified = false } = input;
  if (commentUrl !== undefined && unverified) throw new Error('Use either --comment-url or --unverified, not both');
  if (unverified && ctx.cfg.mode !== 'observe') {
    throw new Error('unverified approvals are not allowed in enforce mode');
  }
  if (commentUrl === undefined && !unverified) {
    throw new Error('An approval needs --comment-url <url>, or --unverified in observe mode');
  }

  const loaded = await loadTask(ctx, issue);
  const { state } = loaded.task;
  const phase = input.phase ?? state.phase;
  let reason = input.reason?.trim() ?? '';

  // Fail on anything but timing (not published, wrong task type, done) before looking up comments.
  assertApprovalFits(state, loaded.type, action, phase, reason);

  let prsRead: Promise<PrInfo[]> | undefined;
  const listPrs = (): Promise<PrInfo[]> =>
    (prsRead ??= trackerStep('listTaskPrs', issue, () => ctx.tracker.listTaskPrs(issue)));

  let approval: Approval;
  if (commentUrl === undefined) {
    const login = await trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin());
    approval = { source: 'unverified', ref: 'unverified', by: login ?? 'unknown', at: ctx.now() };
  } else {
    // One comment is one decision: reconcile skips a recorded comment, and so must this.
    if (recordedRefs(state).has(normalizeCommentUrl(commentUrl))) {
      throw new Error(`comment ${commentUrl} is already recorded as an approval of #${issue}`);
    }
    const comment = await findComment(ctx, issue, commentUrl, listPrs);
    const checked = await validateCommentApproval({
      comment,
      action,
      phase,
      state,
      cfg: ctx.cfg,
      login: () => trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin()),
      finalMergedAt: async () => finalMergeTime(state, await listPrs()),
    });
    approval = checked.approval;
    if (!reason) reason = checked.command.reason ?? '';
  }

  return applyApproval(ctx, issue, { action, phase, reason }, approval, loaded);
}

/** Registers `sdlc approve <issue> <action>`. */
export function registerApproveCommand(program: Command, makeContext: ContextFactory): void {
  program
    .command('approve')
    .description('Record an owner decision: approve a stage, accept a result, confirm a run or cancel')
    .argument('<issue>', 'issue number')
    .argument('<action>', `one of: ${APPROVAL_ACTIONS.join(', ')}`)
    .option('--phase <phase>', 'approve: the phase to approve (default: the current phase)')
    .option('--reason <text>', 'cancel: why the task is cancelled')
    .option('--comment-url <url>', "URL of the owner's comment on the issue or one of its PRs")
    .option('--unverified', 'record the approval without a source (observe mode only)')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (
        issue: string,
        action: string,
        options: { phase?: string; reason?: string; commentUrl?: string; unverified?: boolean; json?: boolean },
      ) => {
        await runCommand(
          makeContext,
          options,
          ctx =>
            approve(ctx, parseIssueNumber(issue), {
              action: parseChoice(action, APPROVAL_ACTIONS, 'action'),
              phase: options.phase === undefined ? undefined : parsePhase(options.phase),
              reason: options.reason,
              commentUrl: options.commentUrl,
              unverified: options.unverified === true,
            }),
          describeState,
        );
      },
    );
}
