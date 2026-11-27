import type { TaskState } from './types.js';

/** First line of the hidden state comment; what `parseStateComment` looks for. */
export const STATE_MARKER = '<!-- sdlc:state -->';

const FOOTER = '_Managed by agentic-sdlc-kit. Do not edit._';

/** Matches the first ```json fence; GitHub may store edited comments with CRLF line endings. */
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

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
 * unusable: no JSON fence, malformed JSON, or an unsupported schema or issue.
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
  const candidate = parsed as { schema?: unknown; issue?: unknown };
  if (candidate.schema !== 1) {
    throw new StateCommentError(`unsupported state schema: ${JSON.stringify(candidate.schema)}`);
  }
  if (typeof candidate.issue !== 'number') {
    throw new StateCommentError('state comment has no numeric "issue"');
  }
  return parsed as TaskState;
}
