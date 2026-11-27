import type { GitRunner } from '../install/provision.js';
import type { ChangeSet } from './scan.js';

export type { ChangeSet } from './scan.js';

export interface AddedLine {
  line: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  lines: AddedLine[];
}

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

/** Git's C-style quoting of a path with unusual characters: `"caf\303\251"`. */
function unquotePath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner.charAt(index);
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = inner.charAt(index + 1);
    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a `+++ ` line: unquoted, without git's trailing tab and its `b/` prefix. */
function targetPath(rest: string): string | undefined {
  const quoted = rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"');
  const path = quoted ? unquotePath(rest) : rest.replace(/\t$/, '');
  if (path === '/dev/null') return undefined;
  return path.startsWith('b/') ? path.slice(2) : path;
}

/** `@@ -a,b +c,d @@` (or `@@@ -a,b -c,d +e,f @@@` of a merge): the number of parents and the first result line. */
const HUNK = /^(@@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? \1/;

/**
 * The added lines of a unified diff, per file, with their line numbers in the new file. It reads
 * the `+++` header of a file, a hunk header and the lines of the hunk, and skips deleted files
 * (`/dev/null`) and binary files (which have no hunks).
 *
 * A hunk is everything after its header up to the next `diff` line: inside it every line is content
 * by its first character, so an added line whose text is `++ b/x` (`+++ b/x` in the diff) or
 * `+diff --git` can neither start a new file nor end the hunk. Counting on the header's line counts
 * would work as well; this cannot be fooled by a count that is wrong. In the diff of a merge
 * (`git log --cc`) a line counts as added only when it is new to every parent (`++`).
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let target: ChangedFile | undefined;
  let inHunk = false;
  let columns = 1;
  let line = 0;
  for (const raw of text.split('\n')) {
    if (inHunk && !raw.startsWith('diff ') && !raw.startsWith('@@')) {
      if (raw === '' || raw.startsWith('\\')) continue;
      const prefix = raw.slice(0, columns);
      if (!/^[ +-]+$/.test(prefix)) continue;
      if (prefix.includes('-')) continue;
      if (target !== undefined && !prefix.includes(' ')) target.lines.push({ line, text: raw.slice(columns) });
      line += 1;
      continue;
    }
    inHunk = false;
    if (raw.startsWith('diff ')) {
      target = undefined;
    } else if (raw.startsWith('+++ ')) {
      const path = targetPath(raw.slice(4));
      target = path === undefined ? undefined : { path, lines: [] };
      if (target !== undefined) files.push(target);
    } else if (raw.startsWith('@@')) {
      const header = HUNK.exec(raw);
      if (header === null) throw new Error(`unreadable hunk header: ${raw.slice(0, 60)}`);
      columns = (header[1] ?? '@@').length - 1;
      line = Number(header[2]);
      inHunk = true;
    }
  }
  return files.filter(file => file.lines.length > 0);
}

/** Runs git and gives its output; a git that fails is an error (the guard then blocks). */
async function run(git: GitRunner, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${firstLine(result.stderr) || `exit code ${result.code}`}`);
  }
  return result.stdout;
}

/** NUL-separated names (`-z`: git quotes nothing then, so a name is never changed on the way). */
const namesOf = (output: string): string[] => output.split('\0').filter(name => name !== '');

/** The added lines of the staged changes, and the staged names of added, copied and renamed files. */
export async function stagedChanges(git: GitRunner): Promise<ChangeSet> {
  const patch = await run(git, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR']);
  const names = await run(git, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACR']);
  return { files: parseUnifiedDiff(patch), names: [...new Set(namesOf(names))] };
}

/** What `pushedChanges` needs of a pushed ref (git's pre-push stdin). */
export interface PushedRef {
  localSha: string;
  remoteSha: string;
  deleting: boolean;
}

const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const isZeros = (sha: string): boolean => /^0+$/.test(sha);

const LOG_PATCH = ['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--cc', '--format='];
const LOG_NAMES = ['log', '--name-only', '-z', '--no-color', '--diff-filter=ACR', '--format='];

/**
 * The added lines and added file names of the commits being pushed: for each ref the commits the
 * remote does not have, `<remote sha>..<local sha>`. A new branch (remote sha all zeros), and a
 * remote sha this repository does not have, use `<local sha> --not --remotes`: everything no
 * remote-tracking branch has. A deletion pushes no commits and is skipped. `--cc` also shows what a
 * merge commit adds on its own, a conflict resolved by hand.
 */
export async function pushedChanges(git: GitRunner, updates: readonly PushedRef[]): Promise<ChangeSet> {
  const files: ChangedFile[] = [];
  const names = new Set<string>();
  for (const update of updates) {
    if (update.deleting) continue;
    if (!OBJECT_NAME.test(update.localSha) || (!isZeros(update.remoteSha) && !OBJECT_NAME.test(update.remoteSha))) {
      throw new Error('unexpected object name in the push update');
    }
    const fresh = [update.localSha, '--not', '--remotes'];
    const ranges = isZeros(update.remoteSha) ? [fresh] : [[`${update.remoteSha}..${update.localSha}`], fresh];
    let patch: string | undefined;
    let range: string[] = [];
    for (const [index, candidate] of ranges.entries()) {
      const result = await git([...LOG_PATCH, ...candidate]);
      if (result.code === 0) {
        patch = result.stdout;
        range = candidate;
        break;
      }
      if (index === ranges.length - 1) {
        throw new Error(`git log failed: ${firstLine(result.stderr) || `exit code ${result.code}`}`);
      }
    }
    files.push(...parseUnifiedDiff(patch ?? ''));
    for (const name of namesOf(await run(git, [...LOG_NAMES, ...range]))) names.add(name);
  }
  return { files, names: [...names] };
}
