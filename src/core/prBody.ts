/** `Related to #1` or `Related to #1, #2`; closing keywords (fixes, closes, resolves) never match. */
const RELATED_LINE = /^[ \t]*related[ \t]+to[ \t]+(#\d+(?:[ \t]*,[ \t]*#\d+)*)/gim;
const SCOPE_LINE = /^[ \t]*scope[ \t]*:[ \t]*(partial|final)[ \t]*$/im;
const TARGETS_LINE = /^[ \t]*targets[ \t]*:(.*)$/gim;

/**
 * Reads the PR body conventions: `Related to #<issue>` links, `Scope: partial|final` (default
 * `final`, also for an unrecognised value) and an optional `Targets: web, api` list. Keys are
 * case-insensitive and must start a line. The first `Scope` line wins; `Targets` lines are merged.
 */
export function parsePrBody(body: string): { issues: number[]; scope: 'partial' | 'final'; targets: string[] } {
  const text = body.replace(/\r\n?/g, '\n');

  const issues = new Set<number>();
  for (const [, list] of text.matchAll(RELATED_LINE)) {
    for (const [number] of list.matchAll(/\d+/g)) issues.add(Number(number));
  }

  const scope = SCOPE_LINE.exec(text)?.[1].toLowerCase() === 'partial' ? 'partial' : 'final';

  const targets = new Set<string>();
  for (const [, list] of text.matchAll(TARGETS_LINE)) {
    for (const part of list.split(',')) {
      const target = part.trim().toLowerCase();
      if (target) targets.add(target);
    }
  }

  return { issues: [...issues], scope, targets: [...targets] };
}
