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
const API_MERGE = violation(
  'api-merge',
  'merging through gh api bypasses the merge policy; ask the owner to merge',
);
const MODE_CHANGE = violation('mode-change', 'only the owner changes sdlc settings (`sdlc config set`); ask the owner');
const HOOK_SPOOF = violation('hook-spoof', 'sdlc hooks are run by the harness only');
const KIT_REMOVAL = violation('kit-removal', 'only the owner removes or overwrites the sdlc install');
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

/**
 * The git subcommand and its arguments, after git's own options (`-C <dir>`, `-c <k=v>`, ...), and
 * the settings those options give (`-c <k=v>`, `--config-env=<k>=<var>`).
 */
function gitCommand(args: readonly string[]): { sub: string | undefined; rest: string[]; settings: string[] } {
  const settings: string[] = [];
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const arg = args[i] as string;
    if (arg === '-c' || arg === '--config-env') {
      const value = args[i + 1];
      if (value !== undefined) settings.push(value);
      i += 2;
    } else if (arg.startsWith('--config-env=')) {
      settings.push(arg.slice('--config-env='.length));
      i += 1;
    } else {
      i += ['-C', '--git-dir', '--work-tree', '--namespace'].includes(arg) ? 2 : 1;
    }
  }
  return { sub: args[i], rest: args.slice(i + 1), settings };
}

/**
 * A configuration key that switches the git hooks off, or brings a setting that does in:
 * `core.hooksPath`, `include.path` and `includeIf.<condition>.path`. Any letter case.
 */
const isHookConfigKey = (key: string): boolean =>
  /^core\.hookspath$/i.test(key) || /^include\.path$/i.test(key) || /^includeif\..+\.path$/i.test(key);

/** The same keys as a `-c` setting: `core.hooksPath=x`, or the bare key. */
const isHookConfigSetting = (setting: string): boolean => isHookConfigKey(setting.split('=')[0] as string);

/** `git config` options that take their value as the next argument. */
const CONFIG_VALUE_OPTIONS: readonly string[] = ['-f', '--file', '--blob', '--default', '--type', '--comment'];
const CONFIG_READ_OPTIONS: readonly string[] = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list'];
const CONFIG_WRITE_OPTIONS: readonly string[] = ['--unset', '--unset-all', '--replace-all', '--add'];
/** `git config` subcommands (git 2.46 and later) that are not a read; `get` and `list` are. */
const CONFIG_SUBCOMMANDS: readonly string[] = ['set', 'unset', 'edit', 'remove-section', 'rename-section'];
/** Sections a rename may not touch: a section renamed into one of them, or out of `core`, changes the hooks. */
const HOOK_SECTIONS: readonly string[] = ['core', 'include', 'includeif'];

/**
 * Whether the arguments of `git config` (as written, so that the value of `--file` is skipped here
 * and nowhere else) change what switches the git hooks off, in any scope or file: set or unset
 * `core.hooksPath`, `include.path` or `includeIf.*.path` (the key with a value, `--unset`,
 * `--replace-all`, `--add`, the `set` and `unset` subcommands), remove the `core` section, rename a
 * section from or to `core`, `include` or `includeIf`, or open the file in an editor. Reading a
 * key (`--get`, the key alone, `get`, `--list`) is not.
 */
function changesHookConfig(args: readonly string[]): boolean {
  const named: string[] = [];
  let reads = false;
  let writes = false;
  let edit = false;
  let sectionOperation: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') {
      named.push(...args.slice(i + 1));
      break;
    }
    if (CONFIG_READ_OPTIONS.includes(arg)) reads = true;
    else if (CONFIG_WRITE_OPTIONS.includes(arg)) writes = true;
    else if (arg === '-e' || arg === '--edit') edit = true;
    else if (arg === '--remove-section' || arg === '--rename-section') sectionOperation = arg.slice(2);
    else if (CONFIG_VALUE_OPTIONS.includes(arg)) i += 1;
    else if (!arg.startsWith('-')) named.push(arg);
  }
  if (edit) return true;
  if (reads) return false;

  const first = named[0]?.toLowerCase() ?? '';
  const operation = sectionOperation ?? (CONFIG_SUBCOMMANDS.includes(first) ? first : undefined);
  const operands = CONFIG_SUBCOMMANDS.includes(first) ? named.slice(1) : named;
  const sectionOf = (name: string): string => (name.split('.')[0] as string).toLowerCase();
  switch (operation) {
    case 'edit':
      return true;
    case 'remove-section':
      return operands[0]?.toLowerCase() === 'core';
    case 'rename-section':
      return operands.slice(0, 2).some(name => HOOK_SECTIONS.includes(sectionOf(name)));
    case 'set':
    case 'unset':
      return operands[0] !== undefined && isHookConfigKey(operands[0]);
    default: {
      const [key, ...values] = operands;
      return key !== undefined && isHookConfigKey(key) && (writes || values.length > 0);
    }
  }
}

function gitViolations(args: readonly string[]): Violation[] {
  const { sub, rest: written, settings } = gitCommand(args);
  const rest = withoutTextValues(written);
  const found: Violation[] = [];
  // Turning the hooks off by configuration is --no-verify for every command at once.
  if (settings.some(isHookConfigSetting) || (sub === 'config' && changesHookConfig(written))) found.push(NO_VERIFY);
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

/** `gh api` options that take the next word as their value; every other word that is not a flag is the endpoint. */
const GH_API_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '--hostname',
  '--cache',
  '-p',
  '--preview',
]);

/** A REST endpoint that merges a pull request: `repos/<o>/<r>/pulls/<n>/merge`, with or without host, slash or query. */
const MERGE_ENDPOINT = /(?:^|\/)pulls\/[^/]+\/merge\/?(?:[?#].*)?$/;
const GRAPHQL_ENDPOINT = /(?:^|\/)graphql\/?$/;
/** The GraphQL mutations that merge a pull request now or queue it to merge; case-sensitive, as the API names them. */
const MERGE_MUTATIONS: readonly string[] = ['mergePullRequest', 'enablePullRequestAutoMerge'];

/** The value `arg` gives the method option of `gh api`: `-X M`, `-XM`, `-X=M`, `--method M`, `--method=M`; the last one wins. */
function methodOf(arg: string, next: string | undefined): string | undefined {
  if (arg === '-X' || arg === '--method') return next;
  if (arg.startsWith('--method=')) return arg.slice('--method='.length);
  if (arg.startsWith('-X')) return arg.slice(arg.startsWith('-X=') ? 3 : 2);
  return undefined;
}

/**
 * Whether the arguments of `gh api` (after `api`) merge a pull request: the REST endpoint
 * `.../pulls/<n>/merge`, or a GraphQL call that mentions `mergePullRequest` or
 * `enablePullRequestAutoMerge` in any word, the `query=` field included. A method that is
 * explicitly GET or HEAD only reads, so it is let through (`gh api` otherwise picks POST when it has
 * fields, and the merge endpoint is a PUT). The words are read as written, not through
 * `withoutTextValues`, which would drop the value of `-F query=...`. A query read from a file or
 * from stdin (`-f query=@file`, `--input`) is not seen.
 */
function mergesThroughApi(args: readonly string[]): boolean {
  let endpoint: string | undefined;
  let method: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') {
      endpoint ??= args[i + 1];
      break;
    }
    if (arg.startsWith('-')) {
      method = methodOf(arg, args[i + 1]) ?? method;
      i += GH_API_VALUE_OPTIONS.has(arg) ? 1 : 0;
    } else endpoint ??= arg;
  }
  if (endpoint === undefined) return false;
  if (method !== undefined && ['GET', 'HEAD'].includes(method.toUpperCase())) return false;
  if (MERGE_ENDPOINT.test(endpoint)) return true;
  return GRAPHQL_ENDPOINT.test(endpoint) && args.some(arg => MERGE_MUTATIONS.some(mutation => arg.includes(mutation)));
}

/** `sdlc`'s arguments after its global options (`--config <path>`, `--json`, ...). */
function sdlcArgs(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) i += args[i] === '--config' ? 2 : 1;
  return args.slice(i);
}

/** The rules the owner-only commands of `sdlc` break; `args` are the ones after the program, as written. */
function sdlcViolations(args: readonly string[]): Violation[] {
  const found: Violation[] = [];
  const [sub, ...rest] = sdlcArgs(args);
  if (sub === 'hook') found.push(HOOK_SPOOF);
  if (sub === 'config' && rest.find(arg => !arg.startsWith('-')) === 'set') found.push(MODE_CHANGE);
  // `sdlc upgrade` stays allowed: it reinstalls the hooks rather than removing them.
  if ((sub === 'uninstall' && !rest.includes('--dry-run')) || (sub === 'init' && rest.includes('--overwrite-modified'))) {
    found.push(KIT_REMOVAL);
  }
  return found;
}

/**
 * The kit's own entry file run through `node`: `cli.js` directly in a `dist` directory (`dist/cli.js`,
 * `.../agentic-sdlc-kit/dist/cli.js`, which is where the package's `bin` points). A `cli.js` nested
 * deeper (`dist/tools/cli.js`) is some other program's.
 */
const KIT_ENTRY = /(?:^|[/\\])dist[/\\]cli\.js$/;
/** The kit's launcher in `node_modules/.bin`, which `node` can run as a script too. */
const KIT_BIN = /(?:^|[/\\])node_modules[/\\]\.bin[/\\]sdlc$/;

/** `node` options that take the next word as their value (`-r`, `--import`, ...); the others stand alone or use `=`. */
const NODE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
  '--inspect-port',
  '--stack-trace-limit',
]);
/** `node` options that run text instead of a script file. */
const NODE_EVAL_OPTIONS: ReadonlySet<string> = new Set(['-e', '--eval', '-p', '--print', '-pe']);

/**
 * The arguments `sdlc` gets when `node` runs the kit's entry file (`dist/cli.js`, or
 * `node_modules/.bin/sdlc`) as its script; `undefined` for any other script. Options
 * of `node` come first (`--enable-source-maps`, `-r <module>`).
 */
function nodeKitArgs(args: readonly string[]): readonly string[] | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') {
      const script = args[i + 1];
      return script !== undefined && (KIT_ENTRY.test(script) || KIT_BIN.test(script)) ? args.slice(i + 2) : undefined;
    }
    if (NODE_EVAL_OPTIONS.has(arg)) return undefined;
    if (arg.startsWith('-')) {
      i += NODE_VALUE_OPTIONS.has(arg) ? 1 : 0;
    } else {
      return KIT_ENTRY.test(arg) || KIT_BIN.test(arg) ? args.slice(i + 1) : undefined;
    }
  }
  return undefined;
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
      if (args[0] === 'api' && mergesThroughApi(call.args.slice(1))) found.push(API_MERGE);
      break;
    }
    case 'git':
      found.push(...gitViolations(call.args));
      break;
    case 'rm':
      if (isRmRf(call.args)) found.push(RM_RF);
      break;
    case 'sdlc':
      found.push(...sdlcViolations(call.args));
      break;
    case 'node': {
      // The kit's own entry file is `sdlc` under another name: `node dist/cli.js config set ...`.
      const kitArgs = nodeKitArgs(call.args);
      if (kitArgs !== undefined) found.push(...sdlcViolations(kitArgs));
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
