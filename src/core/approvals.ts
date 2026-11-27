import type { Config } from '../config/schema.js';
import type { IssueComment, PrInfo } from '../tracker/types.js';
import { parseOwnerCommand, type OwnerCommand } from './ownerCommand.js';
import { applyEvent, assertApprovalTiming, TransitionError, type ApprovalEvent } from './stateMachine.js';
import type { Approval, Phase, TaskState, TaskTypeDef } from './types.js';

export const APPROVAL_ACTIONS = ['approve', 'accept', 'ran', 'cancel'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** The state-machine event that records `action`; `phase` is only used by `approve`, `reason` by `cancel`. */
export function approvalEvent(action: ApprovalAction, phase: Phase, reason: string, approval: Approval): ApprovalEvent {
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

/** Later than any real timestamp, so only a transition that is impossible whatever the time fails. */
export const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

/**
 * Throws `TransitionError` when `action` cannot apply to the task whatever its time: the stage is
 * not published, the task type does not end that way, the task is done or awaiting deployment.
 */
export function assertApprovalFits(
  state: TaskState,
  type: TaskTypeDef,
  action: ApprovalAction,
  phase: Phase,
  reason: string,
): void {
  const probe: Approval = { source: 'unverified', ref: '', by: '', at: FAR_FUTURE };
  applyEvent(state, approvalEvent(action, phase, reason, probe), type, FAR_FUTURE);
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

/** Whether `login` is one of `logins`, in any letter case. */
export const includesLogin = (logins: readonly string[], login: string): boolean =>
  logins.some(listed => listed.toLowerCase() === login.toLowerCase());

export const isOwner = includesLogin;

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

export interface CommentApprovalCheck {
  comment: IssueComment;
  action: ApprovalAction;
  /** `approve` only: the phase being approved. */
  phase: Phase;
  state: TaskState;
  cfg: Pick<Config, 'owners' | 'agents' | 'mode'>;
  /** The tool's own login, read only once the comment passes the cheaper checks; `undefined` when unknown. */
  login: () => Promise<string | undefined>;
  /** `ran` only: when the final PR merged (see `finalMergeTime`). */
  finalMergedAt: () => Promise<string | undefined>;
}

/** The identity part of `validateCommentApproval`: who wrote the comment, what it says, whether it was edited. */
export interface OwnerCommentCheck {
  comment: IssueComment;
  action: ApprovalAction;
  cfg: Pick<Config, 'owners' | 'agents' | 'mode'>;
  /** The tool's own login, read only once the comment passes the cheaper checks; `undefined` when unknown. */
  login: () => Promise<string | undefined>;
}

const AGENTS_HINT = 'list agent logins under `agents` in sdlc.config.yaml';

/**
 * Checks that `comment` is an owner's `/<action>` command and returns the approval to record with
 * the parsed command. In order:
 * - a comment by a login under `agents` (any letter case) is an agent's: refused in enforce mode,
 *   recorded with source `unverified` in observe mode, whoever runs `sdlc`;
 * - otherwise the author must be a configured owner (any letter case);
 * - the first non-empty line is the `/<action>` command (`parseOwnerCommand`);
 * - the comment was not edited after posting (anyone who can write to the repo can edit it); an
 *   unreadable timestamp counts as edited;
 * - it is not by the tool's own login: that is the agent approving itself, refused in enforce
 *   mode and recorded `unverified` in observe mode;
 * - in enforce mode, when the tool's login is unknown and no `agents` are listed, an owner's
 *   comment cannot be told from the agent's: refused.
 * Every refusal throws `ApprovalRefusedError`.
 */
export async function validateOwnerComment(check: OwnerCommentCheck): Promise<{
  approval: Approval;
  command: OwnerCommand;
}> {
  const { comment, action, cfg } = check;
  const byAgent = includesLogin(cfg.agents, comment.author);
  if (byAgent && cfg.mode === 'enforce') {
    throw new ApprovalRefusedError(
      `comment ${comment.url} is by ${comment.author}, an agent login (listed under \`agents\`); agents cannot approve`,
    );
  }
  if (!byAgent && !isOwner(cfg.owners, comment.author)) {
    throw new ApprovalRefusedError(
      `comment ${comment.url} is by ${comment.author || 'an unknown author'}, who is not a configured owner`,
    );
  }
  const command = parseOwnerCommand(comment.body);
  if (command?.action !== action) throw new ApprovalRefusedError(`comment ${comment.url} is not a /${action} command`);
  const created = Date.parse(comment.createdAt);
  const updated = Date.parse(comment.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated) || updated > created) {
    throw new ApprovalRefusedError(`comment ${comment.url} was edited after posting; post a new /${action} comment`);
  }

  let unverified = byAgent;
  if (!byAgent) {
    const login = await check.login();
    const ownComment = login !== undefined && login.toLowerCase() === comment.author.toLowerCase();
    if (ownComment && cfg.mode === 'enforce') {
      throw new ApprovalRefusedError(
        `comment ${comment.url} is authored by the agent's own login (${login}); approve via prompt, ` +
          'or run agents under separate logins listed under `agents` in sdlc.config.yaml',
      );
    }
    if (login === undefined && cfg.mode === 'enforce' && cfg.agents.length === 0) {
      throw new ApprovalRefusedError(
        `comment ${comment.url}: cannot tell owner from agent comments; ${AGENTS_HINT}`,
      );
    }
    unverified = ownComment;
  }

  const approval: Approval = {
    source: unverified ? 'unverified' : 'comment',
    ref: comment.url,
    by: comment.author,
    at: comment.createdAt,
  };
  return { approval, command };
}

/**
 * Checks that `comment` is the owner's approval for `action` on the task (`validateOwnerComment`),
 * then that it is newer than what it acts on: the published stage (`approve`), the published
 * result (`accept`), the reopen (`accept`, `ran`, `cancel`) and the final PR merge (`ran`). The
 * identity checks throw `ApprovalRefusedError`, the time checks `TransitionError`.
 */
export async function validateCommentApproval(check: CommentApprovalCheck): Promise<{
  approval: Approval;
  command: OwnerCommand;
}> {
  const { action, state } = check;
  const { approval, command } = await validateOwnerComment(check);
  const at = approval.at;
  // The state machine's own record of the merge is later than the real one, so `ran` is checked here
  // against the merge time GitHub reports; every other time check is the state machine's.
  if (action === 'ran') {
    const merged = await check.finalMergedAt();
    if (merged !== undefined && !(Date.parse(at) > Date.parse(merged))) {
      throw new TransitionError(`confirmation at ${at} is not newer than the final PR merged at ${merged}`);
    }
  }
  assertApprovalTiming(state, approvalEvent(action, check.phase, command.reason ?? '', approval));
  return { approval, command };
}
