import { GhError } from '../github/gh.js';

/** The first `GhError` in `error`'s cause chain (`error` itself included); a cycle ends the walk. */
function ghErrorIn(error: unknown): GhError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof GhError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The text a failed run prints: the message and, when a failed `gh` call is behind it (anywhere in
 * the cause chain), that call's arguments and stderr.
 */
export function formatCliError(error: unknown): string {
  const gh = ghErrorIn(error);
  if (!gh) return messageOf(error);
  return [
    messageOf(error),
    `  command: gh ${gh.args.join(' ')}`,
    `  stderr: ${gh.stderr.trim() || '(no error output)'}`,
  ].join('\n');
}

/** `formatCliError` as the `--json` error document: `{error}`, plus `args` and `stderr` of a failed `gh` call. */
export function errorAsJson(error: unknown): Record<string, unknown> {
  const gh = ghErrorIn(error);
  return gh ? { error: messageOf(error), args: gh.args, stderr: gh.stderr } : { error: messageOf(error) };
}
