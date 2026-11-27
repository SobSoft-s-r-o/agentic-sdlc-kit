import type { TaskState } from './types.js';

/** First line of the hidden state comment; what `parseStateComment` looks for. */
export const STATE_MARKER = '<!-- sdlc:state -->';

const FOOTER = '_Managed by agentic-sdlc-kit. Do not edit._';

/** Matches the first ```json fence; GitHub may store edited comments with CRLF line endings. */
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

/** Fields the rest of the tool reads without checking; a hand-edited comment must not break it later. */
const STRING_FIELDS = ['status', 'phase', 'type', 'updatedAt'] as const;
const ARRAY_FIELDS = ['targets', 'pendingTargets', 'prs', 'evidence'] as const;

export class StateCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateCommentError';
  }
}

/**
 * Renders the hidden state comment: the marker, the state as a fenced JSON block, and a human note.
 * `JSON.stringify` escapes newlines, so no line of the block can be mistaken for the closing fence.
 */
export function renderStateComment(state: TaskState): string {
  return `${STATE_MARKER}\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n${FOOTER}\n`;
}

/**
 * Reads the task state back from a comment body. Returns `null` when the body does not start with
 * the marker (an ordinary comment); throws `StateCommentError` when it does but the state is
 * unusable: no JSON fence, malformed JSON, an unsupported schema, or a missing or mistyped
 * `issue`, `status`, `phase`, `type`, `updatedAt`, `targets`, `pendingTargets`, `prs`,
 * `evidence` or `stages` (the error names the field).
 */
export function parseStateComment(body: string): TaskState | null {
  const start = body.trimStart();
  if (!start.startsWith(STATE_MARKER)) return null;

  const fence = JSON_FENCE.exec(start.slice(STATE_MARKER.length));
  if (!fence) throw new StateCommentError('state comment has no ```json block');

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (error) {
    throw new StateCommentError(`state comment has invalid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StateCommentError('state comment JSON is not an object');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schema !== 1) {
    throw new StateCommentError(`unsupported state schema: ${JSON.stringify(candidate.schema)}`);
  }
  if (typeof candidate.issue !== 'number') {
    throw new StateCommentError('state comment has no numeric "issue"');
  }
  for (const field of STRING_FIELDS) {
    if (typeof candidate[field] !== 'string') {
      throw new StateCommentError(`state comment has invalid "${field}": expected a string`);
    }
  }
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(candidate[field])) {
      throw new StateCommentError(`state comment has invalid "${field}": expected an array`);
    }
  }
  const stages = candidate.stages;
  if (typeof stages !== 'object' || stages === null || Array.isArray(stages)) {
    throw new StateCommentError('state comment has invalid "stages": expected an object');
  }
  if (candidate.typeChanges !== undefined && !Array.isArray(candidate.typeChanges)) {
    throw new StateCommentError('state comment has invalid "typeChanges": expected an array');
  }
  return parsed as TaskState;
}
