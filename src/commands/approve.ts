import type { Command } from 'commander';
import { parseOwnerCommand } from '../core/ownerCommand.js';
import { applyEvent, TransitionError } from '../core/stateMachine.js';
import { renderCancelReport } from '../core/summary.js';
import type { Approval, Phase, TaskEvent, TaskState } from '../core/types.js';
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
} from './context.js';

export const APPROVAL_ACTIONS = ['approve', 'accept', 'ran', 'cancel'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

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

/** Later than any real timestamp, so only a transition that is impossible whatever the time fails. */
const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

/** `.../pull/3#issuecomment-9` and `.../issues/3#issuecomment-9` name the same comment. */
const normalizeUrl = (url: string): string => url.trim().replace(/\/pull\/(\d+)/, '/issues/$1').toLowerCase();

function eventFor(action: ApprovalAction, phase: Phase, reason: string, approval: Approval): TaskEvent {
  switch (action) {
    case 'approve':
      return { kind: 'stage_approved', phase, approval };
    case 'accept':
      return { kind: 'accepted', approval };
    case 'ran':
      return { kind: 'confirmed_ran', approval };
    case 'cancel':
      return { kind: 'cancelled', reason, approval };
  }
}

/** The comment `url` on the task issue or one of its PRs; the PRs are only listed when the issue does not hold it. */
async function findComment(
  ctx: CommandContext,
  issue: number,
  url: string,
  listPrs: () => Promise<PrInfo[]>,
): Promise<IssueComment> {
  const wanted = normalizeUrl(url);
  const onThread = async (thread: number): Promise<IssueComment | undefined> => {
    const comments = await trackerStep('listComments', issue, () => ctx.tracker.listComments(thread));
    return comments.find(comment => normalizeUrl(comment.url) === wanted);
  };

  const onIssue = await onThread(issue);
  if (onIssue) return onIssue;
  for (const pr of await listPrs()) {
    const onPr = await onThread(pr.number);
    if (onPr) return onPr;
  }
  throw new Error(`Comment ${url} was not found on #${issue} or its pull requests`);
}

/**
 * When the task's final PR merged: the latest `mergedAt` the tracker reports for its recorded final
 * PRs, else the time the merge was recorded (later than the real merge, so the stricter bound).
 */
function finalMergeTime(state: TaskState, prs: PrInfo[]): string | undefined {
  const finals = new Set(state.prs.filter(pr => pr.scope === 'final').map(pr => pr.number));
  const times = prs.filter(pr => finals.has(pr.number) && pr.merged && pr.mergedAt).map(pr => pr.mergedAt as string);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? state.finalMergedAt;
}

/**
 * Records an owner decision on the task: `approve` a published stage, `accept` the published result,
 * confirm the production-data run (`ran`) or `cancel`. The decision needs a source: an owner's
 * `commentUrl`, which must be that command (`/approve`, `/accept`, `/ran`, `/cancel <reason>`) and
 * newer than what it acts on, or `unverified` (observe mode only). `cancel` takes its reason from
 * `input.reason`, else from the comment, and posts the cancel report before the state is written.
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
  const eventWith = (approval: Approval): TaskEvent => eventFor(action, phase, reason, approval);

  // Fail on anything but timing (not published, wrong task type, done) before looking up comments.
  applyEvent(state, eventWith({ source: 'unverified', ref: '', by: '', at: FAR_FUTURE }), loaded.type, ctx.now());

  let prsRead: Promise<PrInfo[]> | undefined;
  const listPrs = (): Promise<PrInfo[]> =>
    (prsRead ??= trackerStep('listTaskPrs', issue, () => ctx.tracker.listTaskPrs(issue)));

  let approval: Approval;
  if (commentUrl === undefined) {
    const login = await trackerStep('authenticatedLogin', undefined, () => ctx.tracker.authenticatedLogin());
    approval = { source: 'unverified', ref: 'unverified', by: login ?? 'unknown', at: ctx.now() };
  } else {
    const comment = await findComment(ctx, issue, commentUrl, listPrs);
    if (!ctx.cfg.owners.some(owner => owner.toLowerCase() === comment.author.toLowerCase())) {
      throw new Error(`Comment ${comment.url} is by ${comment.author || 'an unknown author'}, who is not a configured owner`);
    }
    const command = parseOwnerCommand(comment.body);
    if (command?.action !== action) throw new Error(`Comment ${comment.url} is not a /${action} command`);
    if (!reason) reason = command.reason ?? '';
    approval = { source: 'comment', ref: comment.url, by: comment.author, at: comment.createdAt };

    // The state machine checks the comment against the publication and the reopen; it does not
    // know when the final PR really merged (its own record is later), so `ran` is checked here.
    if (action === 'ran') {
      const merged = finalMergeTime(state, await listPrs());
      if (merged !== undefined && !(Date.parse(comment.createdAt) > Date.parse(merged))) {
        throw new TransitionError(
          `confirmation at ${comment.createdAt} is not newer than the final PR merged at ${merged}`,
        );
      }
    }
  }

  return commitLoaded(ctx, loaded, eventWith(approval), {
    beforeWrite:
      action === 'cancel'
        ? async next => {
            const report = renderCancelReport(next);
            await trackerStep('postComment', issue, () => ctx.tracker.postComment(issue, report), 'the state was not changed');
          }
        : undefined,
  });
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
