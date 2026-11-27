import { createHash } from 'node:crypto';
import { FILE_NAME_RULES, SECRET_RULES } from './rules.js';

/** A line with this text is never scanned. */
export const ALLOW_MARKER = 'sdlc:allow-secret';

export interface Finding {
  /** The path of the file (as git names it). */
  path: string;
  /** The line of an added line; a file-name finding has none. */
  line?: number;
  rule: string;
  /** The first 4 characters of the match, an ellipsis and the length: never more of the secret. */
  masked: string;
  /** What the owner puts into `secrets.allow` to accept the finding. */
  fingerprint: string;
}

/** The first 16 hex characters of sha256 of `<rule>:<match>`. */
export function fingerprintOf(rule: string, match: string): string {
  return createHash('sha256').update(`${rule}:${match}`).digest('hex').slice(0, 16);
}

/** `abcd…(10 chars)`: all that is ever shown of a match. */
export function maskOf(match: string): string {
  let head = '';
  let shown = 0;
  for (const char of match) {
    if (shown === 4) break;
    head += char;
    shown += 1;
  }
  return `${head}…(${match.length} chars)`;
}

interface CompiledRule {
  id: string;
  /** A global copy of the rule's pattern; `lastIndex` is reset before every use. */
  pattern: RegExp;
  ignore: ((match: RegExpMatchArray) => boolean) | undefined;
}

const COMPILED: readonly CompiledRule[] = SECRET_RULES.map(rule => ({
  id: rule.id,
  pattern: new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`),
  ignore: rule.ignore,
}));

/** True when `[start, end)` shares a character with one of the spans. */
const overlaps = (spans: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean =>
  spans.some(([from, to]) => start < to && from < end);

/**
 * The secrets in the added lines of one file. A line with `sdlc:allow-secret` is skipped, and a
 * finding whose fingerprint is in `allow` is dropped. A span of a line is reported once, by the
 * first rule that matches it (a span the owner allowed counts as reported, so allowing the
 * specific finding silences the generic rule on the same text).
 */
export function scanAddedLines(
  path: string,
  lines: ReadonlyArray<{ line: number; text: string }>,
  allow: readonly string[],
): Finding[] {
  const accepted = new Set(allow);
  const findings: Finding[] = [];
  for (const { line, text } of lines) {
    if (text.includes(ALLOW_MARKER)) continue;
    const spans: Array<readonly [number, number]> = [];
    for (const rule of COMPILED) {
      rule.pattern.lastIndex = 0;
      try {
        for (let match = rule.pattern.exec(text); match !== null; match = rule.pattern.exec(text)) {
          const matched = match[0];
          const start = match.index;
          const end = start + matched.length;
          if (matched.length === 0) {
            rule.pattern.lastIndex += 1;
            continue;
          }
          if (rule.ignore?.(match) || overlaps(spans, start, end)) continue;
          spans.push([start, end]);
          const fingerprint = fingerprintOf(rule.id, matched);
          if (accepted.has(fingerprint)) continue;
          findings.push({ path, line, rule: rule.id, masked: maskOf(matched), fingerprint });
        }
      } finally {
        rule.pattern.lastIndex = 0;
      }
    }
  }
  return findings;
}

/** The finding for a file whose name says it holds secrets (`.env`, `*.pem`, …), or `undefined`. */
export function scanFileName(path: string): Finding | undefined {
  const name = path.split('/').pop() ?? path;
  const lower = name.toLowerCase();
  const rule = FILE_NAME_RULES.find(candidate => candidate.matches(lower));
  if (rule === undefined) return undefined;
  return { path, rule: rule.id, masked: name, fingerprint: fingerprintOf(rule.id, path) };
}

/** What the guard looks at: the added lines of changed files, and the names of added or renamed files. */
export interface ChangeSet {
  files: ReadonlyArray<{ path: string; lines: ReadonlyArray<{ line: number; text: string }> }>;
  names: readonly string[];
}

/** Every finding of a change set (file names first-come, each finding once), minus the allowed fingerprints. */
export function scanChanges(changes: ChangeSet, allow: readonly string[]): Finding[] {
  const accepted = new Set(allow);
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const add = (finding: Finding): void => {
    const key = `${finding.path}\u0000${finding.line ?? ''}\u0000${finding.rule}\u0000${finding.fingerprint}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const file of changes.files) for (const finding of scanAddedLines(file.path, file.lines, allow)) add(finding);
  for (const name of changes.names) {
    const finding = scanFileName(name);
    if (finding !== undefined && !accepted.has(finding.fingerprint)) add(finding);
  }
  return findings;
}

/** Text for one terminal line: control characters cannot move the cursor or hide the rest. */
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

/** `<path>:<line> <rule> <masked> (fingerprint <fp>)`; a file-name finding has no `:<line>`. */
export function formatFinding(finding: Finding): string {
  const where = finding.line === undefined ? printable(finding.path) : `${printable(finding.path)}:${finding.line}`;
  return `${where} ${finding.rule} ${printable(finding.masked)} (fingerprint ${finding.fingerprint})`;
}
