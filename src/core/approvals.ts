import type { Config } from '../config/schema.js';
import type { IssueComment, PrInfo } from '../tracker/types.js';
import { parseOwnerCommand, type OwnerCommand } from './ownerCommand.js';
import { TransitionError } from './stateMachine.js';
import type { Approval, Phase, TaskEvent, TaskState } from './types.js';

export const APPROVAL_ACTIONS = ['approve', 'accept', 'ran', 'cancel'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** The state-machine event that records `action`; `phase` is only used by `approve`, `reason` by `cancel`. */
export function approvalEvent(action: ApprovalAction, phase: Phase, reason: string, approval: Approval): TaskEvent {
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

/** An owner command read from a comment. */
export interface ApprovalCommand {
  action: ApprovalAction;
  /** Only `cancel`: the rest of its line. */
  reason?: string;
  comment: IssueComment;
}

/** The commands by owners, in the order given; `ignored` holds the same commands by anyone else. */
export type ApprovalCommands = ApprovalCommand[] & { ignored: ApprovalCommand[] };

/** A comment that cannot count as the owner's approval: wrong author, wrong command, edited, self-authored. */
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRefusedError';
  }
}

export const isOwner = (owners: readonly string[], login: string): boolean =>
  owners.some(owner => owner.toLowerCase() === login.toLowerCase());

/** `.../pull/3#issuecomment-9` and `.../issues/3#issuecomment-9` name the same comment. */
export const normalizeCommentUrl = (url: string): string =>
  url.trim().replace(/\/pull\/(\d+)/, '/issues/$1').toLowerCase();

const isApprovalAction = (action: OwnerCommand['action']): action is ApprovalAction =>
  (APPROVAL_ACTIONS as readonly string[]).includes(action);

/**
 * The approval commands (`/approve`, `/accept`, `/ran`, `/cancel <reason>`, see `parseOwnerCommand`)
 * among `comments`, in their order. Commands by a login in `owners` (any letter case) are the
 * array; the same commands by anyone else are in `ignored`. `/merge` and non-commands are dropped.
 */
export function parseApprovalCommands(comments: readonly IssueComment[], owners: readonly string[]): ApprovalCommands {
  const commands: ApprovalCommand[] = [];
  const ignored: ApprovalCommand[] = [];
  for (const comment of comments) {
    const parsed = parseOwnerCommand(comment.body);
    if (!parsed || !isApprovalAction(parsed.action)) continue;
    const command: ApprovalCommand = {
      action: parsed.action,
      ...(parsed.reason !== undefined && { reason: parsed.reason }),
      comment,
    };
    (isOwner(owners, comment.author) ? commands : ignored).push(command);
  }
  return Object.assign(commands, { ignored });
}

/**
 * When the task's final PR merged: the latest `mergedAt` the tracker reports for its recorded final
 * PRs, else the time the merge was recorded (later than the real merge, so the stricter bound).
 */
export function finalMergeTime(state: TaskState, prs: readonly PrInfo[]): string | undefined {
  const finals = new Set(state.prs.filter(pr => pr.scope === 'final').map(pr => pr.number));
  const times = prs.filter(pr => finals.has(pr.number) && pr.merged && pr.mergedAt).map(pr => pr.mergedAt as string);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? state.finalMergedAt;
}

const isAfter = (later: string, earlier: string): boolean => Date.parse(later) > Date.parse(earlier);

export interface CommentApprovalCheck {
  comment: IssueComment;
  action: ApprovalAction;
  /** `approve` only: the phase being approved. */
  phase: Phase;
  state: TaskState;
  cfg: Pick<Config, 'owners' | 'mode'>;
  /** The tool's own login, read only once the comment passes the cheaper checks; `undefined` when unknown. */
  login: () => Promise<string | undefined>;
  /** `ran` only: when the final PR merged (see `finalMergeTime`). */
  finalMergedAt: () => Promise<string | undefined>;
}

/**
 * Checks that `comment` is the owner's approval for `action` on the task, and returns the approval
 * to record with the parsed command. In order:
 * - the author is a configured owner (any letter case);
 * - the first non-empty line is the `/<action>` command (`parseOwnerCommand`);
 * - the comment was not edited after posting (anyone who can write to the repo can edit it);
 * - it is not by the tool's own login: that is the agent approving itself, refused in enforce
 *   mode and recorded with source `unverified` in observe mode (skipped when the login is unknown);
 * - it is newer than what it acts on: the published stage (`approve`), the published result
 *   (`accept`), the reopen (`accept`, `ran`, `cancel`) and the final PR merge (`ran`).
 * The first four throw `ApprovalRefusedError`, the time checks `TransitionError`.
 */
export async function validateCommentApproval(check: CommentApprovalCheck): Promise<{
  approval: Approval;
  command: OwnerCommand;
}> {
  const { comment, action, state, cfg } = check;
  if (!isOwner(cfg.owners, comment.author)) {
    throw new ApprovalRefusedError(
      `comment ${comment.url} is by ${comment.author || 'an unknown author'}, who is not a configured owner`,
    );
  }
  const command = parseOwnerCommand(comment.body);
  if (command?.action !== action) throw new ApprovalRefusedError(`comment ${comment.url} is not a /${action} command`);
  if (Date.parse(comment.updatedAt) > Date.parse(comment.createdAt)) {
    throw new ApprovalRefusedError(`comment ${comment.url} was edited after posting; post a new /${action} comment`);
  }

  const login = await check.login();
  const ownComment = login !== undefined && login.toLowerCase() === comment.author.toLowerCase();
  if (ownComment && cfg.mode === 'enforce') {
    throw new ApprovalRefusedError(
      `comment ${comment.url} is authored by the agent's own login (${login}); ` +
        'approve via prompt or run agents under a separate account',
    );
  }

  const at = comment.createdAt;
  switch (action) {
    case 'approve': {
      const publishedAt = state.stages[check.phase]?.publishedAt;
      if (!publishedAt) throw new TransitionError(`stage "${check.phase}" has not been published, nothing to approve`);
      if (!isAfter(at, publishedAt)) {
        throw new TransitionError(
          `approval at ${at} is not newer than stage "${check.phase}" published at ${publishedAt}`,
        );
      }
      break;
    }
    case 'accept': {
      if (!state.resultPublishedAt) throw new TransitionError('cannot accept: no result has been published');
      if (!isAfter(at, state.resultPublishedAt)) {
        throw new TransitionError(`acceptance at ${at} is not newer than the result published at ${state.resultPublishedAt}`);
      }
      break;
    }
    case 'ran': {
      const merged = await check.finalMergedAt();
      if (merged !== undefined && !isAfter(at, merged)) {
        throw new TransitionError(`confirmation at ${at} is not newer than the final PR merged at ${merged}`);
      }
      break;
    }
    case 'cancel':
      break;
  }
  if (action !== 'approve' && state.reopenedAt && !isAfter(at, state.reopenedAt)) {
    const noun = { accept: 'acceptance', ran: 'confirmation', cancel: 'cancellation' }[action];
    throw new TransitionError(`${noun} at ${at} is not newer than the reopen at ${state.reopenedAt}`);
  }

  return {
    approval: { source: ownComment ? 'unverified' : 'comment', ref: comment.url, by: comment.author, at },
    command,
  };
}
