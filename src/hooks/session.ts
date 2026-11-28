import { createHash } from 'node:crypto';
import type { Config } from '../config/schema.js';
import { describeCheckout, oneLine } from '../commands/githook.js';
import { isOwner } from '../core/approvals.js';
import type { ReconcileResult } from '../engine/reconcile.js';
import type { TrackedTask } from '../tracker/types.js';
import type { HookHarness } from './types.js';

/**
 * The pure parts of the `session-start` and `prompt` events: the context the agent is given when a
 * session starts, and how an owner's prompt is told apart and attributed. `hook.ts` does the I/O.
 */

export interface SessionContextInput {
  cfg: Pick<Config, 'mode'>;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  /** The task of the branch. */
  task?: TrackedTask;
  /** The branch names task `unreadable`, but GitHub could not be asked (offline, slow): there is no task to show. */
  unreadable?: number;
  /** What a dry-run reconcile of the task would do; 0 when nothing, or when that could not be found out. */
  pending: number;
  /** What waits in the local queue for `sdlc sync`. */
  queued: { outbox: number; gaps: number };
}

/**
 * The lines the session-start hook adds to the agent's context. Text that comes from GitHub (the
 * title, the next step) is put on one line, so it cannot pose as lines of ours.
 */
export function sessionContext(input: SessionContextInput): string[] {
  const { cfg, task, pending, queued } = input;
  const mode = `sdlc: mode ${cfg.mode}.`;
  if (task === undefined) {
    if (input.unreadable !== undefined) {
      return [`${mode} Task #${input.unreadable} could not be read from GitHub just now; its state is not shown.`];
    }
    return [
      `${mode} No task on branch ${input.branch ?? 'HEAD (detached)'}. New work starts with \`sdlc task new\`; status questions use \`sdlc status\`.`,
    ];
  }

  const { state } = task;
  const lines = [
    `${mode} Task #${task.issue} "${oneLine(task.title)}": ${describeCheckout(state)}. Next step: ${oneLine(state.nextStep) || '—'}.`,
  ];
  if (pending > 0) lines.push(`Pending reconcile for #${task.issue}: ${pending} action(s); run \`sdlc reconcile\`.`);
  if (queued.outbox > 0 || queued.gaps > 0) {
    lines.push(
      `Queued for sync: ${queued.outbox} write(s), ${queued.gaps} gap(s); \`sdlc sync\` is running in the background.`,
    );
  }
  return lines;
}

/** What a reconcile only reports: there is nothing in it for the owner or the agent to run reconcile for. */
const NOT_PENDING: ReadonlySet<string> = new Set(['error', 'ignored_approval', 'skipped_unknown_type', 'untracked']);

/**
 * How many actions the dry-run `result` says a reconcile would take. `undefined` when the dry run
 * had an error: it stops that task's steps, so the count would be a part and would mislead.
 */
export function pendingActions(result: ReconcileResult): number | undefined {
  if (result.errors > 0) return undefined;
  return result.actions.filter(action => !NOT_PENDING.has(action.kind)).length;
}

/** The full hex SHA-256 of a prompt: what the prompt record keeps instead of its text. */
export const promptSha256 = (prompt: string): string => createHash('sha256').update(prompt).digest('hex');

/**
 * The `ref` of an approval recorded from a prompt: it names the harness, the session and the first
 * 16 hex digits of the prompt's hash, so the same prompt in the same session is the same approval
 * (a resubmitted or replayed prompt is recorded once).
 */
export const promptRef = (harness: HookHarness, sessionId: string | undefined, prompt: string): string =>
  `prompt:${harness}:${sessionId ?? 'nosession'}:${promptSha256(prompt).slice(0, 16)}`;

/**
 * Who a prompt approval is recorded for. The prompt comes from the human at the keyboard, so with
 * one owner configured it is that owner, whatever login the tool runs as (an agent login included).
 * With several owners only a login that is one of them can say which; any other login is refused.
 */
export function promptApprover(
  cfg: Pick<Config, 'owners'>,
  login: string | undefined,
): { by: string } | { refused: string } {
  if (login !== undefined && isOwner(cfg.owners, login)) return { by: login };
  const [only, ...others] = cfg.owners;
  if (only !== undefined && others.length === 0) return { by: only };
  const who = login === undefined ? 'the GitHub login is unknown' : `${login} is not an owner`;
  return { refused: `prompt approval not recorded: ${who} and several owners are configured; approve by comment` };
}

/**
 * Whether the first non-empty line of the prompt is `/cancel` with no reason: not an owner command
 * (`parseOwnerCommand` needs the reason on the same line), but one the owner meant, who is told.
 */
export function isBareCancel(prompt: string): boolean {
  const first = prompt
    .split(/\r\n?|\n/)
    .map(line => line.trim())
    .find(line => line !== '');
  return first !== undefined && /^\/cancel$/i.test(first);
}
