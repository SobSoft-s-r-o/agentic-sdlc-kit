import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runHook, type HookContext } from '../../commands/hook.js';
import type { Config } from '../../config/schema.js';
import { EVENT_NAMES } from '../../hooks/output.js';
import { HOOK_EVENTS, type HookHarness } from '../../hooks/types.js';
import { HOOK_LAUNCHER, isKitHookItem, NATIVE_EVENT, SETTINGS_FILE } from '../../render/hooks.js';
import type { Tracker } from '../../tracker/types.js';
import type { GitRunner } from '../provision.js';
import { describeError, ok, warn, fail, isRecord, cliHarnesses, type Check, type DoctorEnv } from './types.js';

/** The harness hooks: each harness's settings and launcher, the switches that turn them off, and the pre-tool round trip. */

const CODEX_TRUST = ' (Codex runs it only after you trust the project and approve it in /hooks)';

/** What git says about the hook launcher: whether it is in `HEAD` and, if so, the mode it is recorded with. `undefined` where git cannot say. */
interface LauncherState {
  committed: boolean | undefined;
  mode: string | undefined;
}

/** The executable file mode: a launcher recorded as 100644 is not run by a clone or a new worktree (git on Windows records 100644 unless told). */
const EXECUTABLE_MODE = '100755';

/** The state of the launcher in git, asked at most once per run (two read-only commands). */
export function launcherState(git: GitRunner): () => Promise<LauncherState> {
  const probe = async (): Promise<LauncherState> => {
    try {
      const inHead = await git(['cat-file', '-e', `HEAD:${HOOK_LAUNCHER}`]);
      if (inHead.code !== 0) return { committed: false, mode: undefined };
      // The mode committed in HEAD, which a clone or a new worktree gets; the index may differ from it.
      const listed = await git(['ls-tree', 'HEAD', '--', HOOK_LAUNCHER]);
      return { committed: true, mode: listed.code === 0 ? /^(\d{6}) /.exec(listed.stdout)?.[1] : undefined };
    } catch {
      return { committed: undefined, mode: undefined };
    }
  };
  let known: Promise<LauncherState> | undefined;
  return () => (known ??= probe());
}

/** The native event names of `harness` that have no array element calling the launcher (the same test the merge applies: `isKitHookItem`). */
function eventsWithoutHook(settings: unknown, harness: HookHarness): string[] {
  const hooks = isRecord(settings) ? settings.hooks : undefined;
  return HOOK_EVENTS.map(event => NATIVE_EVENT[harness][event]).filter(native => {
    const items = isRecord(hooks) ? hooks[native] : undefined;
    return !(Array.isArray(items) && items.some(isKitHookItem));
  });
}

/**
 * The hooks one harness reads: its settings file has an element that calls the launcher for each of
 * session start, the prompt and the tool call; the launcher exists, and is committed, executable
 * (a worktree or a clone gets only what is committed, with the mode it is committed with).
 */
export async function checkHooksOf(env: DoctorEnv, cfg: Config, harness: HookHarness, launcher: () => Promise<LauncherState>): Promise<Check> {
  const id = `hooks.${harness}`;
  if (!cfg.harnesses.includes(harness)) return ok(id, `${harness} is not a configured harness; skipped`);
  if (harness === 'gemini' && (env.platform ?? process.platform) === 'win32') {
    return warn(id, 'Gemini CLI runs hooks through PowerShell on Windows; sdlc hooks need a POSIX shell');
  }

  const file = SETTINGS_FILE[harness];
  const problems: string[] = [];
  const fixes: string[] = [];
  const needsUpgrade = (problem: string): void => {
    problems.push(problem);
    if (!fixes.includes('sdlc upgrade')) fixes.push('sdlc upgrade');
  };

  const text = env.fs.read(file);
  if (text === undefined) {
    needsUpgrade(`${file} not found, so ${harness} runs no sdlc hooks`);
  } else {
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      return warn(id, `${file} is not valid JSON, so ${harness} cannot read its hooks`, `fix the syntax of ${file}, then run sdlc upgrade`);
    }
    const missing = eventsWithoutHook(settings, harness);
    if (missing.length > 0) needsUpgrade(`no sdlc hook in ${file} for ${missing.join(', ')}`);
  }

  if (env.fs.read(HOOK_LAUNCHER) === undefined) {
    needsUpgrade(`${HOOK_LAUNCHER} not found`);
  } else {
    const { committed, mode } = await launcher();
    if (committed === false) {
      problems.push(`${HOOK_LAUNCHER} is not committed; new worktrees and clones will not run the sdlc hooks`);
      fixes.push(`commit ${HOOK_LAUNCHER}`);
    } else if (mode !== undefined && mode !== EXECUTABLE_MODE) {
      problems.push(`${HOOK_LAUNCHER} is committed with mode ${mode}, not ${EXECUTABLE_MODE}; new worktrees and clones cannot run it`);
      fixes.push(`git update-index --chmod=+x ${HOOK_LAUNCHER}`);
    }
  }
  if (problems.length > 0) return warn(id, problems.join('; '), fixes.join('; '));

  const events = HOOK_EVENTS.map(event => NATIVE_EVENT[harness][event]).join(', ');
  return ok(id, `${file} runs ${HOOK_LAUNCHER} on ${events}${harness === 'codex' ? CODEX_TRUST : ''}`);
}

/** A shell command every rule of the hook turns down, in the tool name each harness calls its shell. */
const ROUNDTRIP_COMMAND = 'gh pr merge 1 --admin';
const SHELL_TOOL: Record<HookHarness, string> = { claude: 'Bash', codex: 'Bash', gemini: 'run_shell_command' };
const ROUNDTRIP_QUOTE = 120;

/** `text` for a message: one printable line, cut short. */
function quoted(text: string): string {
  const line = describeError(text);
  return line.length > ROUNDTRIP_QUOTE ? `${line.slice(0, ROUNDTRIP_QUOTE - 1)}…` : line;
}

/** A tracker that reads nothing: the round trip must not touch GitHub, and a pre-tool shell rule never needs a task. */
const NO_TRACKER = new Proxy({} as Tracker, {
  get: (_target, property) =>
    typeof property !== 'string' || property === 'then'
      ? undefined
      : async (): Promise<never> => {
          throw new Error('the hooks round trip does not read tasks');
        },
});

/** A git that knows one repository, `root`, on a branch of no task: what the hook asks (`checkoutOf`) and nothing else. */
function roundTripGit(root: string): GitRunner {
  return async args => {
    if (args[0] === 'rev-parse') return { stdout: `${root}\n${join(root, '.git')}\n`, code: 0, stderr: '' };
    if (args[0] === 'symbolic-ref') return { stdout: 'main\n', code: 0, stderr: '' };
    return { stdout: '', code: 128, stderr: 'the hooks round trip has no git' };
  };
}

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** What is missing from `answer` as the deny of `harness` (the contract of `renderOutput`), `undefined` when it is a whole one. */
function denyFault(harness: HookHarness, answer: unknown): string | undefined {
  if (!isRecord(answer)) return 'it is not an object';
  if (harness === 'gemini') {
    if (answer.decision !== 'deny') return 'decision is not "deny"';
    return nonEmpty(answer.reason) ? undefined : 'the reason is missing or empty';
  }
  const output = answer.hookSpecificOutput;
  if (!isRecord(output)) return 'hookSpecificOutput is missing';
  const event = EVENT_NAMES[harness]['pre-tool'];
  if (output.hookEventName !== event) return `hookEventName is ${JSON.stringify(output.hookEventName) ?? 'missing'}, not "${event}"`;
  if (output.permissionDecision !== 'deny') return 'permissionDecision is not "deny"';
  return nonEmpty(output.permissionDecisionReason) ? undefined : 'the reason (permissionDecisionReason) is missing or empty';
}

/** Whether `answer` decides to deny at all, whole or not. */
const decidesToDeny = (answer: Record<string, unknown>): boolean =>
  answer.decision === 'deny' || (isRecord(answer.hookSpecificOutput) && answer.hookSpecificOutput.permissionDecision === 'deny');

/**
 * What is missing from `answer` as the observe warning of `harness`, `undefined` when it is a whole
 * one: in `systemMessage` for all, and for Claude and Codex in `additionalContext` of the pre-tool
 * event too; never a deny.
 */
function warnFault(harness: HookHarness, answer: unknown): string | undefined {
  const observe = (value: unknown): boolean => typeof value === 'string' && value.includes('sdlc (observe)');
  if (!isRecord(answer)) return 'it is not an object';
  if (decidesToDeny(answer)) return 'it denies, and observe mode only warns';
  if (!observe(answer.systemMessage)) return 'systemMessage is not the observe warning';
  if (harness === 'gemini') return undefined;
  const output = answer.hookSpecificOutput;
  if (!isRecord(output)) return 'hookSpecificOutput is missing';
  const event = EVENT_NAMES[harness]['pre-tool'];
  if (output.hookEventName !== event) return `hookEventName is ${JSON.stringify(output.hookEventName) ?? 'missing'}, not "${event}"`;
  return observe(output.additionalContext) ? undefined : 'additionalContext is not the observe warning';
}

/** What is wrong with the answer of `harness`'s pre-tool hook, `undefined` when it is the one the mode calls for. */
function roundTripProblem(harness: HookHarness, mode: Config['mode'], output: string | undefined, stderr: string[]): string | undefined {
  const expected = mode === 'enforce' ? 'a deny' : 'the observe warning';
  if (output === undefined) {
    const why = stderr.find(line => line.trim() !== '');
    return `${harness}: expected ${expected}, got no output${why === undefined ? '' : ` (${quoted(why)})`}`;
  }
  let answer: unknown;
  try {
    answer = JSON.parse(output);
  } catch {
    return `${harness}: expected ${expected}, got output that is not JSON: ${quoted(output)}`;
  }
  const fault = mode === 'enforce' ? denyFault(harness, answer) : warnFault(harness, answer);
  return fault === undefined ? undefined : `${harness}: expected ${expected}, got ${quoted(output)} (${fault})`;
}

/** Reads a file of the real home directory; `undefined` when it is not there or cannot be read. */
function readHomeFile(path: string): string | undefined {
  try {
    return readFileSync(join(homedir(), path), 'utf8');
  } catch {
    return undefined;
  }
}

/** The JSON object in `text`, or `undefined` (no file, or a file that is not a JSON object: `hooks.<harness>` reports that). */
function jsonObjectOf(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code: `disableAllHooks: true` turns every hook off. */
function claudeSwitch(text: string | undefined): string | undefined {
  return jsonObjectOf(text)?.disableAllHooks === true ? 'disableAllHooks is true' : undefined;
}

/** Gemini CLI: `hooksConfig.enabled: false` turns every hook off; `hooksConfig.disabled` lists hooks turned off by name or command. */
function geminiSwitch(text: string | undefined): string | undefined {
  const hooksConfig = jsonObjectOf(text)?.hooksConfig;
  if (!isRecord(hooksConfig)) return undefined;
  if (hooksConfig.enabled === false) return 'hooksConfig.enabled is false';
  const disabled = Array.isArray(hooksConfig.disabled)
    ? hooksConfig.disabled.filter((name): name is string => typeof name === 'string' && (name.startsWith('sdlc-') || name.includes(HOOK_LAUNCHER)))
    : [];
  return disabled.length > 0 ? `hooksConfig.disabled lists ${disabled.join(', ')}` : undefined;
}

/** The characters of `text` outside quoted strings, with their index (`"..."` with backslash escapes, and `'...'` literal). */
function* unquoted(text: string): Generator<[number, string]> {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (quote === undefined) {
      if (char === '"' || char === "'") quote = char;
      else yield [index, char];
    } else if (quote === '"' && char === '\\') {
      index++;
    } else if (char === quote) {
      quote = undefined;
    }
  }
}

/** `text` without a trailing comment: a `#` outside a quoted string and everything after it. */
function withoutComment(text: string): string {
  for (const [index, char] of unquoted(text)) if (char === '#') return text.slice(0, index);
  return text;
}

/** `text` cut at its first `=` outside a quoted string: the key and the value, `undefined` when there is none. */
function splitPair(text: string): [key: string, value: string] | undefined {
  for (const [index, char] of unquoted(text)) if (char === '=') return [text.slice(0, index), text.slice(index + 1).trim()];
  return undefined;
}

/** The entries of an inline table body: `body` cut at the commas that are outside quoted strings and nested `{}`/`[]`. */
function inlineEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (const [index, char] of unquoted(body)) {
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(body.slice(start));
  return entries.filter(entry => entry.trim() !== '');
}

/** The names in a dotted key (`a . "b".'c'`: bare or quoted, blanks around the dots), `undefined` when `text` is not a key. Escapes in quoted names are not decoded. */
function keyNames(text: string): string[] | undefined {
  const names: string[] = [];
  let rest = text.trim();
  for (;;) {
    const name = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*/.exec(rest);
    if (name === null) return undefined;
    names.push(name[1] ?? name[2] ?? name[3] ?? '');
    rest = rest.slice(name[0].length);
    if (rest === '') return names;
    if (!rest.startsWith('.')) return undefined;
    rest = rest.slice(1).trimStart();
  }
}

/** The keys that turn every Codex hook off when they are `false`: the current name and the deprecated one. */
const CODEX_SWITCH_KEYS = ['features.hooks', 'features.codex_hooks'];

/**
 * The switch that `key = value` is, as `<key> is false`: the key reads `false` and is one of
 * `CODEX_SWITCH_KEYS`, or the value is an inline table (`{ a = 1, b = false }`) with such a key, at
 * any depth, so that `features = { hooks = false }` reads as `features.hooks = false`.
 */
function falseSwitch(key: string[], value: string): string | undefined {
  // No switch key has more than two names, so a deeper one cannot be one: this also bounds the recursion on a deeply nested inline table.
  if (key.length > 2) return undefined;
  if (value.startsWith('{') && value.endsWith('}')) {
    for (const entry of inlineEntries(value.slice(1, -1))) {
      const pair = splitPair(entry);
      const names = pair === undefined ? undefined : keyNames(pair[0]);
      const found = pair === undefined || names === undefined ? undefined : falseSwitch([...key, ...names], pair[1]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const name = key.join('.');
  return value === 'false' && key.length === 2 && CODEX_SWITCH_KEYS.includes(name) ? `${name} is false` : undefined;
}

/** The names of the table a `[table]` or `[[array.of.tables]]` header line opens, `undefined` when `line` is not one (sliced, not matched with a pattern, so no input makes it backtrack). */
function tableNames(line: string): string[] | undefined {
  if (line.startsWith('[[') && line.endsWith(']]')) return keyNames(line.slice(2, -2));
  if (line.startsWith('[') && line.endsWith(']')) return keyNames(line.slice(1, -1));
  return undefined;
}

/**
 * Codex: `hooks = false` (or the deprecated `codex_hooks`) in the `[features]` table, as
 * `features.hooks = false` at the top level, or as `features = { hooks = false }` (an inline table,
 * also under another table, where it is that table's own `features`), turns every hook off. A
 * line reading, not a TOML parser: enough for the forms Codex documents. Keys may be quoted, and
 * a trailing comment is ignored. Limits: it does not read a value that spans lines (a multi-line
 * string or an inline table broken over lines), and it does not decode escapes in quoted keys.
 */
function codexSwitch(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let table: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw).trim();
    const named = tableNames(line);
    if (named !== undefined) {
      table = named;
      continue;
    }
    const pair = splitPair(line);
    const names = pair === undefined ? undefined : keyNames(pair[0]);
    if (pair === undefined || names === undefined) continue;
    const found = falseSwitch([...table, ...names], pair[1]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Where each harness can be switched off: its project files and the user-level file, with the reader of the switch. */
const HOOK_SWITCHES: Record<HookHarness, { project: string[]; user: string[]; read: (text: string | undefined) => string | undefined }> = {
  claude: { project: ['.claude/settings.json', '.claude/settings.local.json'], user: ['.claude/settings.json', '.claude/settings.local.json'], read: claudeSwitch },
  codex: { project: ['.codex/config.toml'], user: ['.codex/config.toml'], read: codexSwitch },
  gemini: { project: ['.gemini/settings.json'], user: ['.gemini/settings.json'], read: geminiSwitch },
};

/**
 * The settings that switch the harness hooks off, for each configured harness. One in the project
 * fails in enforce (the hooks are the enforcement) and warns in observe; one in the user's own files
 * only warns, because it is the owner's to keep. Neither trust state nor managed policy can be read.
 */
export function checkHookSwitches(env: DoctorEnv, cfg: Config): Check {
  const id = 'hooks.switches';
  const harnesses = cliHarnesses(cfg);
  if (harnesses.length === 0) return ok(id, 'no configured harness has hooks; skipped');
  const userFile = env.userFile ?? readHomeFile;
  const project: string[] = [];
  const user: string[] = [];
  for (const harness of harnesses) {
    const { read, project: projectFiles, user: userFiles } = HOOK_SWITCHES[harness];
    for (const file of projectFiles) {
      const found = read(env.fs.read(file));
      if (found !== undefined) project.push(`${file}: ${found}`);
    }
    for (const file of userFiles) {
      const found = read(userFile(file));
      if (found !== undefined) user.push(`~/${file}: ${found}`);
    }
  }
  if (project.length === 0 && user.length === 0) return ok(id, `no setting switches the hooks of ${harnesses.join(', ')} off`);
  const message = `hooks are switched off: ${[...project, ...user].join('; ')}`;
  const fix = 'remove the setting, or set it back to its default, so the harness runs the sdlc hooks';
  return project.length > 0 && cfg.mode === 'enforce' ? fail(id, message, fix) : warn(id, message, fix);
}

/**
 * Runs `sdlc hook <harness> pre-tool` in process for every configured harness that has hooks, on a
 * command it must turn down (`gh pr merge --admin`): the answer must be the harness's deny in
 * enforce mode and the warning in observe mode. This checks the code between the payload and the
 * answer (the parsing, the rules, the shape of the output), not the launcher script.
 *
 * It leaves no trace: the hook runs read-only (it writes no gap, prompt record or task cache and
 * starts no sync), against a synthetic git and a tracker that rejects every call, so it reads no
 * task and neither reads nor writes GitHub, and the real logs of the repository stay as they were.
 */
export async function checkRoundTrip(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'hooks.roundtrip';
  const harnesses = cliHarnesses(cfg);
  if (harnesses.length === 0) return ok(id, 'no configured harness has hooks; skipped');

  const run = env.hookRunner ?? runHook;
  const root = env.fs.root;
  const problems: string[] = [];
  for (const harness of harnesses) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const payload = JSON.stringify({
      session_id: 'sdlc-doctor',
      cwd: root,
      tool_name: SHELL_TOOL[harness],
      tool_input: { command: ROUNDTRIP_COMMAND },
    });
    const ctx: HookContext = {
      cwd: root,
      readStdin: async () => payload,
      loadConfig: () => cfg,
      makeTracker: () => NO_TRACKER,
      gitFor: () => roundTripGit(root),
      now: () => new Date().toISOString(),
      out: text => void stdout.push(text),
      err: text => void stderr.push(text),
      readOnly: true,
    };
    try {
      await run(harness, 'pre-tool', ctx);
    } catch (error) {
      problems.push(`${harness}: the hook threw: ${quoted(describeError(error))}`);
      continue;
    }
    const problem = roundTripProblem(harness, cfg.mode, stdout.length === 0 ? undefined : stdout.join(''), stderr);
    if (problem !== undefined) problems.push(problem);
  }

  if (problems.length > 0) {
    return fail(
      id,
      `sdlc hook ${harnesses.join(', ')} pre-tool does not answer \`${ROUNDTRIP_COMMAND}\` as it should: ${problems.join('; ')}`,
      'sdlc upgrade, then reinstall sdlc if this persists (see INSTALL.md); the harness hooks cannot be trusted until it passes',
    );
  }
  return ok(id, `${harnesses.join(', ')}: pre-tool on \`${ROUNDTRIP_COMMAND}\` ${cfg.mode === 'enforce' ? 'denies it (enforce)' : 'warns about it (observe)'}`);
}
