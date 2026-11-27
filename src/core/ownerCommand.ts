export type OwnerAction = 'approve' | 'accept' | 'ran' | 'merge' | 'cancel';

export interface OwnerCommand {
  action: OwnerAction;
  /** Only `/cancel`: the rest of its line. */
  reason?: string;
}

/** `/<action>` at the start of a line, then the end of the line or whitespace. */
const COMMAND = /^\/(approve|accept|ran|merge|cancel)(?=\s|$)(.*)$/i;

/**
 * Reads an owner command from a comment body: `/approve`, `/accept`, `/ran`, `/merge` or
 * `/cancel <reason>`. Only the first non-empty line counts, trimmed, and the command must start it
 * (a quoted `> /approve`, `/approved` or a command further down is not a command). The action is
 * matched case-insensitively. `/cancel` needs a reason on the same line, else it is not a command.
 */
export function parseOwnerCommand(body: string): OwnerCommand | null {
  const firstLine = body
    .split(/\r\n?|\n/)
    .map(line => line.trim())
    .find(line => line !== '');
  const match = firstLine === undefined ? null : COMMAND.exec(firstLine);
  if (!match) return null;

  const action = match[1].toLowerCase() as OwnerAction;
  if (action !== 'cancel') return { action };
  const reason = match[2].trim();
  return reason ? { action, reason } : null;
}
