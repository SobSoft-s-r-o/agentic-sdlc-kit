import type { GapRule } from '../core/types.js';
import type { Violation } from './policy.js';
import { shellWords } from './shellWords.js';

export { shellWords };

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A word that starts with a redirection operator, such as `2>/dev/null` or `<x.json`. */
const REDIRECT = /^(?:\d*[<>]|&>)/;
/** A redirection operator alone, whose target is the next word. */
const BARE_REDIRECT = /^(?:\d*(?:<<<|<<|<>|>>|<&|>&|<|>)|&>>?)$/;

/** Shell keywords that are followed by a command: `then claude -p x`, `do rm -rf y`, `{ git push -f; }`. */
const COMMAND_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{']);

interface Wrapper {
  /** Options that take the next word as their value. */
  valueFlags: readonly string[];
  /** Plain arguments before the wrapped command (`timeout`'s duration). */
  positional?: number;
}

/** Commands that run the rest of the line as a command. */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  ['env', { valueFlags: ['-u', '-C'] }],
  ['sudo', { valueFlags: ['-u', '-g'] }],
  ['exec', { valueFlags: ['-a'] }],
  ['nohup', { valueFlags: [] }],
  ['time', { valueFlags: [] }],
  ['npx', { valueFlags: [] }],
  ['bunx', { valueFlags: [] }],
  ['timeout', { valueFlags: ['-s', '-k'], positional: 1 }],
  ['nice', { valueFlags: ['-n'] }],
  ['stdbuf', { valueFlags: ['-i', '-o', '-e'] }],
  ['xargs', { valueFlags: ['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a', '-l'] }],
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
      const wrapper = WRAPPERS.get(base);
      const subcommands = PACKAGE_RUNNERS.get(base);
      const next = words[i + 1];
      if (wrapper !== undefined) {
        i = skipFlags(words, i + 1, wrapper.valueFlags) + (wrapper.positional ?? 0);
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

/** A short-option cluster such as `-f` or `-nm`. Text with spaces (`-n flag docs`) is not one. */
const SHORT_CLUSTER = /^-[^-\s]\S*$/;

/** Options whose value is free text or a file name, never a flag: in `-m "--no-verify"` it is a message. */
const TEXT_OPTIONS: ReadonlySet<string> = new Set(['--message', '--file', '--body', '--body-file', '--title', '--template']);
/** Short options with such a value (`-m`, `-F`, `-b`, `-t`); the value follows a cluster that ends in one, as in `-am`. */
const TEXT_SHORT_LETTERS = 'mFbt';

/** `args` without the values of the text options, so a message cannot pass for a flag. */
function withoutTextValues(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    kept.push(arg);
    if (TEXT_OPTIONS.has(arg) || (SHORT_CLUSTER.test(arg) && TEXT_SHORT_LETTERS.includes(arg.slice(-1)))) i += 1;
  }
  return kept;
}

/**
 * Whether a short-option cluster among `args` (up to a lone `--`) holds `letter`. A letter in
 * `valueLetters` takes the rest of the cluster as its value, so the scan of that cluster stops
 * there: `-am` has no `n`, `-nm` has.
 */
function hasShortFlag(args: readonly string[], letter: string, valueLetters: string): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (!SHORT_CLUSTER.test(arg)) continue;
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
    else if (SHORT_CLUSTER.test(arg)) {
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
    case 'gh': {
      const args = withoutTextValues(call.args);
      if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--admin')) found.push(ADMIN_MERGE);
      break;
    }
    case 'git':
      found.push(...gitViolations(withoutTextValues(call.args)));
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

/** Embedded shell commands are followed this many levels deep (`bash -c 'bash -c "..."'`). */
const MAX_NESTING = 3;

/**
 * The command line a shell or `eval` is asked to run: `bash -c <string>` (also `-lc`, `-ec`, ...)
 * and `eval <args>`.
 */
function embeddedCommand(call: Invocation): string | undefined {
  if (call.name === 'eval') return call.args.join(' ');
  if (!SHELLS.has(call.name)) return undefined;
  let hasC = false;
  for (let i = 0; i < call.args.length; i += 1) {
    const arg = call.args[i] as string;
    if (arg === '--') return hasC ? call.args[i + 1] : undefined;
    if (!/^[-+]/.test(arg)) return hasC ? arg : undefined;
    if (/^-[^-]*c/.test(arg)) hasC = true;
    if (arg === '-o' || arg === '+o' || arg === '-O' || arg === '+O') i += 1;
  }
  return undefined;
}

function violationsIn(command: string, depth: number): Violation[] {
  const found = new Map<string, Violation>();
  for (const words of shellWords(command)) {
    const call = invocation(words);
    if (call === undefined) continue;
    const embedded = depth < MAX_NESTING ? embeddedCommand(call) : undefined;
    const violations = [...callViolations(call), ...(embedded === undefined ? [] : violationsIn(embedded, depth + 1))];
    for (const v of violations) found.set(`${v.rule}:${v.text}`, v);
  }
  return [...found.values()];
}

/**
 * The rules a shell command breaks. It is read as a sequence of simple commands (see `shellWords`);
 * for each, leading `VAR=value` words, shell keywords (`then`, `do`, ...), redirections and the
 * wrappers `env`, `sudo`, `exec`, `nohup`, `time`, `timeout`, `nice`, `stdbuf`, `xargs`, `npx`,
 * `bunx`, `pnpm|yarn dlx|exec` and `npm exec` are skipped, and what is left is matched by program
 * name. The text of `bash -c`, `sh -c` and `eval` is checked the same way, a few levels deep. Text
 * that merely mentions a command (an argument to `echo`, `grep` or a commit message) breaks
 * nothing, and neither does the value of a message option (`-m`, `--body`, ...). One violation per
 * distinct text, in the order found.
 *
 * Not handled: commands built at run time (`$CLI`, `$(which claude)`), `find -exec`, files written
 * and then run, and heredoc bodies fed to a shell (`cat <<EOF | sh`).
 */
export function shellViolations(command: string): Violation[] {
  return violationsIn(command, 0);
}
