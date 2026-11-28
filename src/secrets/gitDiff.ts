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

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Git's C-style quoting of a path with unusual characters: `"caf\303\251"` is `café`. */
function unquotePath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  let index = 0;
  while (index < inner.length) {
    const char = String.fromCodePoint(inner.codePointAt(index) ?? 0);
    index += char.length;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    // A backslash is followed by three octal digits (one byte of the UTF-8 name) or by one character.
    const octal = /^[0-7]{3}/.exec(inner.slice(index))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += 3;
      continue;
    }
    const next = String.fromCodePoint(inner.codePointAt(index) ?? 0x5c);
    index += next.length;
    bytes.push(...(ESCAPES[next] === undefined ? Buffer.from(next, 'utf8') : [ESCAPES[next]]));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The path of a `+++ ` line: without git's trailing tab (it follows a name with a space, quoted or
 * not), unquoted, without its `b/` prefix (the commands below ask for that prefix whatever the
 * user's `diff.noprefix` and `diff.mnemonicPrefix` say), or `undefined` for `/dev/null`.
 */
function targetPath(rest: string): string | undefined {
  const name = rest.replace(/\t$/, '');
  const path = name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? unquotePath(name) : name;
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
  for (const [index, raw] of text.split('\n').entries()) {
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
      // Only where it is, never what it says: the line is diff text, and diff text can hold a secret.
      if (header === null) {
        throw new Error(`unreadable hunk header${target === undefined ? '' : ` in ${target.path}`} (line ${index + 1} of the diff)`);
      }
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

/**
 * What makes the patch the same whatever the user's git config and attributes say: no colour, no
 * external diff driver and no textconv driver (either would show something else than the file's
 * content, and a secret would not be in it), and the plain `a/` and `b/` prefixes (`diff.noprefix`
 * and `diff.mnemonicPrefix` would change the `+++` line that `parseUnifiedDiff` reads).
 */
const PATCH_OPTIONS = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

/**
 * The added lines of the staged changes, and the staged names of added, copied, renamed and
 * type-changed files (T: a symlink that became a file holds new content like an added file does).
 */
export async function stagedChanges(git: GitRunner): Promise<ChangeSet> {
  const patch = await run(git, ['diff', '--cached', ...PATCH_OPTIONS, '--diff-filter=ACMRT']);
  const names = await run(git, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACRT']);
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

// `--root`: the first commit of a history is shown as a creation event, whatever `log.showRoot` says.
const LOG_PATCH = ['log', '-p', ...PATCH_OPTIONS, '--root', '--cc', '--format='];
const LOG_NAMES = ['log', '--name-only', '-z', '--no-color', '--root', '--diff-filter=ACRT', '--format='];

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
