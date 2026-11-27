/** `Related to #1` or `Related to #1, #2`, optionally as a bullet; closing keywords never match. */
const RELATED_LINE = /^[ \t]*(?:[-*][ \t]+)?related[ \t]+to[ \t]+(#\d+(?:[ \t]*,[ \t]*#\d+)*)/gim;
/** Any `Scope:` line, optionally as a bullet, whatever follows the colon. */
const SCOPE_LINE = /^[ \t]*(?:[-*][ \t]+)?scope[ \t]*:(.*)$/gim;
const SCOPE_VALUE = /^[ \t]*(partial|final)\b/i;
const TARGETS_LINE = /^[ \t]*(?:[-*][ \t]+)?targets[ \t]*:(.*)$/gim;

export interface PrBodyInfo {
  issues: number[];
  scope: 'partial' | 'final';
  /** False when a `Scope:` line is present but none has a recognised value (scope then defaults to `final`). */
  scopeRecognized: boolean;
  targets: string[];
}

/**
 * Reads the PR body conventions: `Related to #<issue>` links, `Scope: partial|final` and an
 * optional `Targets: web, api` list. Keys are case-insensitive and must start a line (after an
 * optional `-`/`*` bullet for `Related to` and `Scope`); mentions inside a sentence are ignored.
 * A scope value only needs to start with `partial` or `final`, so `Scope: partial.` and
 * `Scope: partial (docs only)` count. The first recognised `Scope` line wins. Scope defaults to
 * `final` when absent or unrecognised; `scopeRecognized` tells the caller which of those it was.
 * `Targets` lines are merged.
 */
export function parsePrBody(body: string): PrBodyInfo {
  const text = body.replace(/\r\n?/g, '\n');

  const issues = new Set<number>();
  for (const [, list] of text.matchAll(RELATED_LINE)) {
    for (const [number] of list.matchAll(/\d+/g)) issues.add(Number(number));
  }

  const scopeValues = [...text.matchAll(SCOPE_LINE)].map(([, value]) => SCOPE_VALUE.exec(value)?.[1]);
  const recognized = scopeValues.find(value => value !== undefined);
  const scope = recognized?.toLowerCase() === 'partial' ? 'partial' : 'final';
  const scopeRecognized = scopeValues.length === 0 || recognized !== undefined;

  const targets = new Set<string>();
  for (const [, list] of text.matchAll(TARGETS_LINE)) {
    for (const part of list.split(',')) {
      const target = part.trim().toLowerCase();
      if (target) targets.add(target);
    }
  }

  return { issues: [...issues], scope, scopeRecognized, targets: [...targets] };
}
