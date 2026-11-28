import type { GapRule } from '../core/types.js';
import type { Violation } from './policy.js';

/** Characters a backslash escapes inside double quotes; before any other it stays a backslash. */
const DOUBLE_QUOTE_ESCAPES = '$`"\\';

/** The text of a backtick substitution starting just past its opening backtick, and where it ends. */
function readBacktick(src: string, start: number): { inner: string; end: number } {
  let inner = '';
  let i = start;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '`') return { inner, end: i + 1 };
    if (c === '\\' && next !== undefined && '`\\$'.includes(next)) {
      inner += next;
      i += 2;
    } else {
      inner += c;
      i += 1;
    }
  }
  return { inner, end: i };
}

/**
 * Reads shell text from `start`, appending one word list per simple command to `out` in the order
 * the commands begin (so a command comes before the substitutions inside it; some lists stay
 * empty). Substitutions (`$( )`, backticks, `<( )`, `>( )`) are scanned recursively into `out`
 * too; a nested read ends at the `)` that closes it. Returns the index just past what it read.
 *
 * A quote that is never closed is read as a literal character, since the shell would refuse that
 * command anyway; this keeps an apostrophe in a heredoc body or a comment from hiding what follows.
 */
function scan(src: string, start: number, out: string[][], nested: boolean): number {
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let groups = 0;
  let i = start;

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    words = [];
    out.push(words);
  };
  const substitution = (inner: string): void => {
    scan(inner, 0, out, false);
  };

  /** Double-quoted text, from just past the opening quote to just past the closing one. */
  const doubleQuoted = (): void => {
    while (i < src.length) {
      const c = src[i] as string;
      const next = src[i + 1];
      if (c === '"') {
        i += 1;
        return;
      }
      if (c === '\\' && next !== undefined) {
        if (next === '\n') {
          i += 2;
        } else if (DOUBLE_QUOTE_ESCAPES.includes(next)) {
          word += next;
          i += 2;
        } else {
          word += c;
          i += 1;
        }
      } else if (c === '`') {
        const { inner, end } = readBacktick(src, i + 1);
        substitution(inner);
        i = end;
      } else if (c === '$' && next === '(') {
        i = scan(src, i + 2, out, true);
      } else {
        word += c;
        i += 1;
      }
    }
  };

  out.push(words);
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    switch (c) {
      case '\\':
        if (next === '\n') {
          i += 2;
        } else if (next === undefined) {
          word += c;
          inWord = true;
          i += 1;
        } else {
          word += next;
          inWord = true;
          i += 2;
        }
        break;
      case "'": {
        inWord = true;
        const close = src.indexOf("'", i + 1);
        if (close < 0) {
          word += c;
          i += 1;
        } else {
          word += src.slice(i + 1, close);
          i = close + 1;
        }
        break;
      }
      case '"':
        inWord = true;
        i += 1;
        doubleQuoted();
        break;
      case '`': {
        inWord = true;
        const { inner, end } = readBacktick(src, i + 1);
        substitution(inner);
        i = end;
        break;
      }
      case '$':
        inWord = true;
        if (next === '(') {
          i = scan(src, i + 2, out, true);
        } else {
          word += c;
          i += 1;
        }
        break;
      case '<':
      case '>':
        inWord = true;
        if (next === '(') {
          i = scan(src, i + 2, out, true);
        } else {
          word += c;
          i += 1;
        }
        break;
      case '&': {
        // `2>&1`, `>&2` and `&>file` are redirections, not command separators.
        const before = src[i - 1];
        if (before === '>' || before === '<' || next === '>') {
          word += c;
          inWord = true;
        } else {
          endCommand();
        }
        i += 1;
        break;
      }
      case ';':
      case '|':
      case '\n':
        endCommand();
        i += 1;
        break;
      case '(':
        endCommand();
        groups += 1;
        i += 1;
        break;
      case ')':
        endCommand();
        i += 1;
        if (groups > 0) groups -= 1;
        else if (nested) return i;
        break;
      case ' ':
      case '\t':
      case '\r':
        endWord();
        i += 1;
        break;
      case '#':
        if (inWord) {
          word += c;
          i += 1;
        } else {
          while (i < src.length && src[i] !== '\n') i += 1;
        }
        break;
      default:
        word += c;
        inWord = true;
        i += 1;
    }
  }
  endWord();
  return i;
}

/**
 * The simple commands of a shell command line, one word list each. Splits on `;`, `&&`, `||`, `|`,
 * `&`, newlines, subshell parentheses, and the insides of `$( )` and backticks, including inside
 * double quotes. Quotes and backslash escapes are honoured, so quoted text is one word and a
 * quoted `;` splits nothing. Heredoc bodies are not parsed as such: their lines are read as
 * commands, which can only over-report.
 */
export function shellWords(command: string): string[][] {
  const out: string[][] = [];
  scan(command, 0, out, false);
  return out.filter(words => words.length > 0);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A word that starts with a redirection operator, such as `2>/dev/null` or `<x.json`. */
const REDIRECT = /^(?:\d*[<>]|&>)/;
/** A redirection operator alone, whose target is the next word. */
const BARE_REDIRECT = /^(?:\d*(?:<<<|<<|<>|>>|<&|>&|<|>)|&>>?)$/;

/** Shell keywords that are followed by a command: `then claude -p x`, `do rm -rf y`, `{ git push -f; }`. */
const COMMAND_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{']);

/** Commands that run the rest of the line as a command, with the flags that take a value. */
const WRAPPERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['env', ['-u', '-C']],
  ['sudo', ['-u', '-g']],
  ['exec', ['-a']],
  ['nohup', []],
  ['time', []],
  ['npx', []],
  ['bunx', []],
]);

/** Package managers that run a package's binary through one of these subcommands. */
const PACKAGE_RUNNERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['pnpm', ['dlx', 'exec']],
  ['yarn', ['dlx', 'exec']],
  ['npm', ['exec']],
]);

const PACKAGE_CLIS: ReadonlyMap<string, string> = new Map([
  ['@anthropic-ai/claude-code', 'claude'],
  ['@openai/codex', 'codex'],
  ['@google/gemini-cli', 'gemini'],
]);

const AI_CLIS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
  'aider',
  'cursor',
  'cursor-agent',
  'ollama',
  'opencode',
  'goose',
  'llm',
  'sgpt',
]);

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Git subcommands that accept `--no-verify`. */
const NO_VERIFY_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit', 'push', 'merge', 'rebase', 'am']);

/** Lower-case file name of a command word, without a Windows `.exe`. */
function commandName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/** A package spec without its `@version`: `@openai/codex@latest` gives `@openai/codex`. */
function packageName(word: string): string {
  const at = word.indexOf('@', 1);
  return at < 0 ? word : word.slice(0, at);
}

/** Whether the word names this kit for `npx`: `github:<owner>/agentic-sdlc-kit#<ref>` or the bare package. */
function isSdlcPackage(word: string): boolean {
  const path = word.split('#')[0] as string;
  return (word.startsWith('github:') && path.includes('agentic-sdlc-kit')) || packageName(word) === 'agentic-sdlc-kit';
}

/** The program a command word runs: `sdlc`, a known AI CLI behind its package name, or its file name. */
function programName(word: string): string {
  if (isSdlcPackage(word)) return 'sdlc';
  return PACKAGE_CLIS.get(packageName(word)) ?? commandName(word);
}

/** The index after the leading flags of a wrapper, which come first and end at `--` or the first non-flag. */
function skipFlags(words: readonly string[], from: number, valueFlags: readonly string[]): number {
  let i = from;
  while (i < words.length) {
    const word = words[i] as string;
    if (word === '--') return i + 1;
    if (!word.startsWith('-')) break;
    i += valueFlags.includes(word) ? 2 : 1;
  }
  return i;
}

interface Invocation {
  /** The command word as written, for matching a path. */
  raw: string;
  /** What it runs, see `programName`. */
  name: string;
  args: string[];
}

/** What one simple command runs, after its `VAR=value` words, shell keywords, redirections and wrappers. */
function invocation(words: readonly string[]): Invocation | undefined {
  let i = 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (ENV_ASSIGNMENT.test(word) || COMMAND_KEYWORDS.has(word)) {
      i += 1;
    } else if (REDIRECT.test(word)) {
      i += BARE_REDIRECT.test(word) ? 2 : 1;
    } else {
      const base = commandName(word);
      const valueFlags = WRAPPERS.get(base);
      const subcommands = PACKAGE_RUNNERS.get(base);
      const next = words[i + 1];
      if (valueFlags !== undefined) {
        i = skipFlags(words, i + 1, valueFlags);
      } else if (subcommands !== undefined && next !== undefined && subcommands.includes(next)) {
        i = skipFlags(words, i + 2, []);
      } else {
        return { raw: word, name: programName(word), args: words.slice(i + 1) };
      }
    }
  }
  return undefined;
}

const violation = (rule: GapRule, text: string): Violation => ({ rule, text });

const ADMIN_MERGE = violation(
  'admin-merge',
  '`gh pr merge --admin` bypasses checks and reviews; merge through the normal PR flow',
);
const MODE_CHANGE = violation('mode-change', 'only the owner changes sdlc settings (`sdlc config set`); ask the owner');
const HOOK_SPOOF = violation('hook-spoof', 'sdlc hooks are run by the harness only');
const NO_VERIFY = violation('no-verify', '--no-verify skips the git hooks and the secret guard');
const FORCE_PUSH = violation('force-push', 'force-pushing is not allowed');
const WORKTREE_PRUNE = violation(
  'worktree-prune',
  '`git worktree prune` and forced removal are not allowed; use `sdlc worktree finish`',
);
const RM_RF = violation('rm-rf', '`rm -rf` is not allowed; delete specific files');

/**
 * Whether a short-option cluster among `args` (up to a lone `--`) holds `letter`. A letter in
 * `valueLetters` takes the rest of the cluster as its value, so the scan of that cluster stops
 * there: `-am` has no `n`, `-nm` has.
 */
function hasShortFlag(args: readonly string[], letter: string, valueLetters: string): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (!/^-[^-]/.test(arg)) continue;
    for (const ch of arg.slice(1)) {
      if (ch === letter) return true;
      if (valueLetters.includes(ch)) break;
    }
  }
  return false;
}

/** The git subcommand and its arguments, after git's own options (`-C <dir>`, `-c <k=v>`, ...). */
function gitCommand(args: readonly string[]): { sub: string | undefined; rest: string[] } {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) {
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i] as string) ? 2 : 1;
  }
  return { sub: args[i], rest: args.slice(i + 1) };
}

function gitViolations(args: readonly string[]): Violation[] {
  const { sub, rest } = gitCommand(args);
  const found: Violation[] = [];
  if (sub !== undefined && NO_VERIFY_SUBCOMMANDS.has(sub)) {
    // `-n` is `--no-verify` for commit only; for push it is `--dry-run`.
    if (rest.includes('--no-verify') || (sub === 'commit' && hasShortFlag(rest, 'n', 'mFCctuS'))) {
      found.push(NO_VERIFY);
    }
  }
  if (sub === 'push') {
    const forced = rest.some(
      arg =>
        arg === '--force' ||
        arg === '--force-with-lease' ||
        arg.startsWith('--force-with-lease=') ||
        (arg.length > 1 && arg.startsWith('+')),
    );
    if (forced || hasShortFlag(rest, 'f', 'o')) found.push(FORCE_PUSH);
  }
  if (sub === 'worktree') {
    const action = rest.find(arg => !arg.startsWith('-'));
    if (action === 'prune') found.push(WORKTREE_PRUNE);
    if (action === 'remove' && (rest.includes('--force') || hasShortFlag(rest, 'f', ''))) found.push(WORKTREE_PRUNE);
  }
  return found;
}

/** Whether `rm`'s arguments ask for both recursion and force, in any spelling and order. */
function isRmRf(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--recursive') recursive = true;
    else if (arg === '--force') force = true;
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === 'r' || ch === 'R') recursive = true;
        if (ch === 'f') force = true;
      }
    }
  }
  return recursive && force;
}

/** `sdlc`'s arguments after its global options (`--config <path>`, `--json`, ...). */
function sdlcArgs(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) i += args[i] === '--config' ? 2 : 1;
  return args.slice(i);
}

const isLauncherPath = (word: string): boolean => word === '.sdlc/hooks/run.sh' || word.endsWith('/.sdlc/hooks/run.sh');

/** Whether the command runs the rendered hook launcher, directly or through a shell. */
function runsLauncher(call: Invocation): boolean {
  if (isLauncherPath(call.raw)) return true;
  if (!SHELLS.has(call.name)) return false;
  const script = call.args.find(arg => !arg.startsWith('-'));
  return script !== undefined && isLauncherPath(script);
}

/** `<cli> --version` and `<cli> mcp|plugin|extensions list` only read. */
function isReadOnlyAiCall(args: readonly string[]): boolean {
  return args[0] === '--version' || (['mcp', 'plugin', 'extensions'].includes(args[0] as string) && args[1] === 'list');
}

function callViolations(call: Invocation): Violation[] {
  const found: Violation[] = [];
  if (runsLauncher(call)) found.push(HOOK_SPOOF);
  switch (call.name) {
    case 'gh':
      if (call.args[0] === 'pr' && call.args[1] === 'merge' && call.args.includes('--admin')) found.push(ADMIN_MERGE);
      break;
    case 'git':
      found.push(...gitViolations(call.args));
      break;
    case 'rm':
      if (isRmRf(call.args)) found.push(RM_RF);
      break;
    case 'sdlc': {
      const [sub, ...rest] = sdlcArgs(call.args);
      if (sub === 'hook') found.push(HOOK_SPOOF);
      if (sub === 'config' && rest.find(arg => !arg.startsWith('-')) === 'set') found.push(MODE_CHANGE);
      break;
    }
    default:
  }
  if (AI_CLIS.has(call.name) && !isReadOnlyAiCall(call.args)) {
    found.push(
      violation(
        'ai-cli',
        `launching another AI CLI (${call.name}) is not allowed; do the work yourself or dispatch an sdlc role subagent`,
      ),
    );
  }
  return found;
}

/**
 * The rules a shell command breaks. It is read as a sequence of simple commands (see `shellWords`);
 * for each, leading `VAR=value` words, shell keywords (`then`, `do`, ...), redirections and the
 * wrappers `env`, `sudo`, `exec`, `nohup`, `time`, `npx`, `bunx`, `pnpm|yarn dlx|exec` and
 * `npm exec` are skipped, and what is left is matched by program name. Text that merely mentions a command (an argument to `echo`, `grep` or a
 * commit message) breaks nothing. One violation per distinct text, in the order found.
 *
 * Not handled: commands built at run time (`sh -c`, `eval`, `$CLI`), files written and then run,
 * and heredoc bodies fed to a shell.
 */
export function shellViolations(command: string): Violation[] {
  const found = new Map<string, Violation>();
  for (const words of shellWords(command)) {
    const call = invocation(words);
    if (call === undefined) continue;
    for (const v of callViolations(call)) found.set(`${v.rule}:${v.text}`, v);
  }
  return [...found.values()];
}
