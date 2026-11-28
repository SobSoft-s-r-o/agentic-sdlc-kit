import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deadlineOf, isNoTaskError, taskIssueOf } from '../commands/githook.js';
import { runHook, type HookContext } from '../commands/hook.js';
import { loadConfigFromString, type Config } from '../config/schema.js';
import type { Status } from '../core/types.js';
import { listWorktrees, orphanWorktrees, type OrphanWorktree, type Worktree } from '../git/worktrees.js';
import { GhError } from '../github/gh.js';
import { GitHubTracker } from '../github/githubTracker.js';
import { readJsonLines } from '../hooks/localLog.js';
import { EVENT_NAMES } from '../hooks/output.js';
import { HOOK_EVENTS, HOOK_HARNESSES, type HookHarness } from '../hooks/types.js';
import { OUTBOX_FAILED_FILE, queuedCounts } from '../outbox/outbox.js';
import { HOOK_LAUNCHER, isKitHookItem, NATIVE_EVENT, SETTINGS_FILE } from '../render/hooks.js';
import { mcpEnvVars } from '../render/mcp.js';
import { scanFileName } from '../secrets/scan.js';
import type { Tracker } from '../tracker/types.js';
import { readManifest, type Manifest } from './manifest.js';
import { HOOKS_PATH, readPushProtection, type GitRunner } from './provision.js';
import { mcpListArgs, mcpNames, superpowersInstall, superpowersInstalled, superpowersListArgs, graphifyInstall } from './stack.js';
import {
  readHooks,
  hooksActive,
  checkManifest,
  checkManagedFiles,
  checkGitVersion,
  checkHooksPath,
  hookEnvironment,
  checkSdlcOnPath,
  checkLegacyHooks,
  type Hooks,
} from './doctor/files.js';
import { checkKitRef, checkBoard, checkLabels, checkWorkflow, checkActionsSecret } from './doctor/github.js';
import { ghBlocker, runPreflight } from './doctor/preflight.js';
import {
  describeError,
  printable,
  ok,
  warn,
  fail,
  notChecked,
  isolated,
  ghReason,
  failure,
  list,
  isRecord,
  cliHarnesses,
  type Check,
  type DoctorEnv,
} from './doctor/types.js';

/**
 * `sdlc doctor`: read-only checks of the machine (the preflight, which needs no config) and of an
 * installed repository. Every check is isolated: one that throws becomes a failed check with a
 * one-line message and the others still run. No secret is ever read into a message: `mcp.token`
 * names variables only, `secrets.trackedFiles` prints file paths only.
 */

export type { CheckStatus, Check, DoctorEnv, ExecOptions, PreflightOptions } from './doctor/types.js';
export { describeError } from './doctor/types.js';
export { parseTokenScopes, runPreflight } from './doctor/preflight.js';
export { hookEnvironment } from './doctor/files.js';

/** Names only: whether each variable the configured MCP servers read is set, never what it holds. */
function checkMcpToken(env: DoctorEnv, cfg: Config): Check {
  const id = 'mcp.token';
  const names = mcpEnvVars(cfg);
  if (names.length === 0) return ok(id, 'the configured MCP servers read no environment variable');
  const unset = names.filter(name => (env.env[name] ?? '') === '');
  if (unset.length === 0) return ok(id, `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} set`);
  return warn(
    id,
    `${unset.join(', ')} ${unset.length > 1 ? 'are' : 'is'} not set in the environment, so the MCP servers cannot authenticate`,
    `export ${unset.length > 1 ? 'them' : 'it'} from the OS keystore in your shell profile before starting your agent, never as a literal value, e.g. ` +
      `${unset.map(name => `export ${name}="$(security find-generic-password -s <service> -w)"`).join('; ')} (the command for each keystore is in INSTALL.md, Secrets)`,
  );
}

// --- the harness CLIs: MCP servers, Superpowers and graphify -------------------------------------

/** Longest the plugin lists and `graphify --version` may take: a hung CLI must not stall the whole run. */
const CLI_TIMEOUT_MS = 15_000;

/**
 * Longest an `mcp list` may take. It health-checks every configured server (Claude took 22 s on a
 * machine with a few; Gemini waits up to 10 s for each one that does not answer), so a slow list
 * is not a hung one.
 */
const MCP_LIST_TIMEOUT_MS = 60_000;

/** Runs `cmd` in the repository root, in the environment a hook sees, with a time limit. */
function runCli(env: DoctorEnv, cmd: string, args: string[], timeoutMs = CLI_TIMEOUT_MS): ReturnType<DoctorEnv['exec']> {
  return env.exec(cmd, args, { env: hookEnvironment(env.env).env, timeoutMs });
}

const MCP_FIX: Record<HookHarness, string> = {
  claude: 'approve the server in Claude Code or run the printed claude mcp add command',
  codex: 'trust the project in Codex (it loads .codex/config.toml only for trusted projects) or run the printed codex mcp add command',
  gemini: 'trust the folder in Gemini CLI (it loads project settings only for trusted folders) or run the printed gemini mcp add command',
};

/** Whether the MCP servers of the config show up in `<harness> mcp list`; the same contract for every harness. */
async function checkMcpHarness(env: DoctorEnv, cfg: Config, harness: HookHarness): Promise<Check> {
  const id = `mcp.${harness}`;
  if (!cfg.harnesses.includes(harness)) return ok(id, `${harness} is not a configured harness; skipped`);
  if (!(await env.which(harness))) return ok(id, `${harness} CLI not found; skipped`);
  const wanted = cfg.mcp.servers;
  if (wanted.length === 0) return ok(id, 'no MCP servers are configured');

  const shown = `${harness} mcp list`;
  let result: Awaited<ReturnType<DoctorEnv['exec']>>;
  try {
    result = await runCli(env, harness, mcpListArgs(harness), MCP_LIST_TIMEOUT_MS);
  } catch (error) {
    return warn(id, `could not run ${shown}: ${describeError(error)}`);
  }
  if (result.code !== 0) {
    // Only the exit code and the first line of stderr: stdout can list other servers with their credentials.
    return warn(id, `${shown} ${failure(result.code, result.stderr)}`);
  }
  let listed: Set<string>;
  try {
    // Codex answers in JSON on stdout; the others print a line per server, a name counting only as the whole word.
    listed = mcpNames(harness, harness === 'codex' ? result.stdout : `${result.stdout}\n${result.stderr}`);
  } catch (error) {
    return warn(id, `could not read ${shown}: ${describeError(error)}`);
  }
  const missing = wanted.filter(server => !listed.has(server));
  if (missing.length === 0) return ok(id, `${shown} shows ${wanted.join(', ')}`);
  return warn(id, `${shown} does not show: ${missing.join(', ')}`, MCP_FIX[harness]);
}

/** The root of this checkout and, in a linked worktree, that of the main checkout: where a project-scope plugin may have been installed. */
async function repositoryRoots(env: DoctorEnv, worktrees: () => Promise<WorktreeList>): Promise<string[]> {
  const found = await worktrees();
  return 'error' in found || found.mainRoot === env.fs.root ? [env.fs.root] : [env.fs.root, found.mainRoot];
}

/**
 * Superpowers, in use, in each configured harness, from its plugin list in JSON. A harness whose CLI is not
 * on the PATH is "not checked", never a warning; a list that cannot be read is a warning that does
 * not say how to install it, because it is not known to be missing.
 */
async function checkSuperpowers(env: DoctorEnv, cfg: Config, worktrees: () => Promise<WorktreeList>): Promise<Check> {
  const id = 'stack.superpowers';
  if (!cfg.stack.superpowers) return ok(id, 'stack.superpowers is off; skipped');
  const harnesses = cliHarnesses(cfg);
  if (harnesses.length === 0) return ok(id, 'no configured harness has plugins; skipped');

  const installed: HookHarness[] = [];
  const missing: HookHarness[] = [];
  const unreadable: string[] = [];
  const notes: string[] = [];
  for (const harness of harnesses) {
    if (!(await env.which(harness))) {
      notes.push(`${harness}: not checked (${harness} not on PATH)`);
      continue;
    }
    const shown = `${harness} plugin list`;
    try {
      const result = await runCli(env, harness, superpowersListArgs(harness));
      if (result.code !== 0) {
        unreadable.push(`could not read ${shown}: command ${failure(result.code, result.stderr)}`);
      } else {
        // A Claude plugin of project or local scope is for the repository it was installed in: this one, or its main checkout.
        const roots = harness === 'claude' ? await repositoryRoots(env, worktrees) : [];
        (superpowersInstalled(harness, result.stdout, roots) ? installed : missing).push(harness);
      }
    } catch (error) {
      unreadable.push(`could not read ${shown}: ${describeError(error)}`);
    }
  }

  const problems = [...(missing.length > 0 ? [`superpowers is not installed for ${missing.join(', ')}`] : []), ...unreadable];
  if (problems.length > 0) {
    return warn(id, [...problems, ...notes].join('; '), missing.length > 0 ? missing.map(harness => superpowersInstall(harness)).join(' && ') : undefined);
  }
  return ok(id, [...(installed.length > 0 ? [`superpowers is installed for ${installed.join(', ')}`] : []), ...notes].join('; '));
}

/** graphify on the PATH and answering `--version`; the fix is what `sdlc init` lists to install it. */
async function checkGraphify(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'stack.graphify';
  if (!cfg.stack.graphify) return ok(id, 'stack.graphify is off; skipped');
  const fix = graphifyInstall(cfg.harnesses).join(' && ');
  if (!(await env.which('graphify'))) return warn(id, 'graphify is not installed (not on the PATH)', fix);
  let result: Awaited<ReturnType<DoctorEnv['exec']>>;
  try {
    result = await runCli(env, 'graphify', ['--version']);
  } catch (error) {
    return warn(id, `could not run graphify --version: ${describeError(error)}`, fix);
  }
  if (result.code !== 0) return warn(id, `graphify --version ${failure(result.code, result.stderr)}`, fix);
  const version = /\d+\.\d+(?:\.\d+)*\S*/.exec(result.stdout)?.[0];
  return ok(id, version === undefined ? 'graphify is installed' : `graphify ${printable(version)}`);
}

/** Inactive when the hooks path is wrong or `sdlc` is missing; failing to read the hooks path is "cannot verify" (still a fail), not a wrong path. */
function checkSecretGuard(hooks: Hooks, sdlcResolvable: boolean): Check {
  const id = 'secrets.guard';
  const hooksOk = hooksActive(hooks);
  if (hooksOk && sdlcResolvable) return ok(id, `the pre-commit secret guard is active (core.hooksPath ${HOOKS_PATH}, sdlc resolvable)`);
  const unreadable = 'error' in hooks;
  const problems = [
    ...(hooksOk ? [] : [unreadable ? `could not read core.hooksPath (${describeError(hooks.error)})` : `core.hooksPath is not ${HOOKS_PATH}`]),
    ...(sdlcResolvable ? [] : ['sdlc cannot be found, so the hook skips']),
  ];
  const fixes = [
    ...(hooksOk ? [] : [unreadable ? 'make sure git works in this repository (git config --get core.hooksPath)' : 'sdlc init']),
    ...(sdlcResolvable ? [] : ['install sdlc (see INSTALL.md)']),
  ];
  const only = unreadable && sdlcResolvable;
  return fail(id, `secret guard ${only ? 'cannot be verified' : 'inactive'}: ${problems.join('; ')}`, fixes.join('; '));
}

/** The reason GitHub gives when it will not show the settings: a plan without them, or a token without admin rights. */
const isUnavailable = (error: unknown): boolean => error instanceof GhError && /\bHTTP (403|404)\b/.test(error.stderr);

async function checkPushProtection(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'secrets.pushProtection';
  let state: Awaited<ReturnType<typeof readPushProtection>>;
  try {
    state = await readPushProtection(env.run, cfg);
  } catch (error) {
    if (isUnavailable(error)) {
      return warn(id, `GitHub does not show the secret scanning settings: ${ghReason(error)}; the local commit guard still blocks secrets`);
    }
    throw error;
  }
  if (state.enabled) return ok(id, 'secret scanning and push protection are enabled');
  if (!state.visible) {
    return warn(
      id,
      'push protection cannot be verified: GitHub shows no security settings to this account (not an admin, or the plan has none); the local commit guard still blocks secrets',
      'ask a repository admin to enable secret scanning and push protection',
    );
  }
  return warn(id, `push protection: ${state.pushProtection}; secret scanning: ${state.secretScanning}`, 'sdlc init');
}

/** Tracked file names the commit guard would refuse (`.env`, `*.pem`, ...) minus the fingerprints accepted in `secrets.allow`. A warning (spec 14a). Paths only, never contents. */
async function checkTrackedFiles(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'secrets.trackedFiles';
  const result = await env.git(['ls-files', '-z']);
  if (result.code !== 0) return fail(id, `git ls-files failed: ${describeError(result.stderr.trim() || `exit code ${result.code}`)}`);
  const accepted = new Set(cfg.secrets.allow);
  const files = result.stdout.split('\0').filter(path => path !== '');
  const hits = files.filter(path => {
    const finding = scanFileName(path);
    return finding !== undefined && !accepted.has(finding.fingerprint);
  });
  if (hits.length === 0) return ok(id, `no tracked file name looks like it holds a secret (${files.length} files checked)`);
  return warn(
    id,
    `tracked files that look like they hold secrets: ${list(hits.map(printable), 10)}`,
    'git rm --cached <file>, rotate the secret, store it in the keystore',
  );
}

function checkApprovalTrust(cfg: Config): Check {
  const id = 'approvals.trust';
  if (cfg.mode === 'enforce' && cfg.stack.actions && cfg.agents.length === 0) {
    return warn(
      id,
      "comment approvals from the Actions token's login are ignored in enforce mode; run agents under a separate account listed in agents (see INSTALL.md)",
    );
  }
  return ok(id, 'the approval trust settings are consistent');
}

const CODEX_TRUST = ' (Codex runs it only after you trust the project and approve it in /hooks)';

/** What git says about the hook launcher: whether it is in `HEAD` and, if so, the mode it is recorded with. `undefined` where git cannot say. */
interface LauncherState {
  committed: boolean | undefined;
  mode: string | undefined;
}

/** The executable file mode: a launcher recorded as 100644 is not run by a clone or a new worktree (git on Windows records 100644 unless told). */
const EXECUTABLE_MODE = '100755';

/** The state of the launcher in git, asked at most once per run (two read-only commands). */
function launcherState(git: GitRunner): () => Promise<LauncherState> {
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
async function checkHooksOf(env: DoctorEnv, cfg: Config, harness: HookHarness, launcher: () => Promise<LauncherState>): Promise<Check> {
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

/**
 * Codex: `hooks = false` (or the deprecated `codex_hooks`) in the `[features]` table, or
 * `features.hooks = false` at the top level, turns every hook off. A line reading, not a TOML parser:
 * enough for the forms Codex documents.
 */
function codexSwitch(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header !== null) {
      table = header[1] as string;
      continue;
    }
    const setting = /^([A-Za-z0-9_.]+)\s*=\s*false$/.exec(line);
    if (setting === null) continue;
    const key = table === '' ? setting[1] : `${table}.${setting[1]}`;
    if (key === 'features.hooks' || key === 'features.codex_hooks') return `${key} is false`;
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
function checkHookSwitches(env: DoctorEnv, cfg: Config): Check {
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
async function checkRoundTrip(env: DoctorEnv, cfg: Config): Promise<Check> {
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

type WorktreeList = { worktrees: Worktree[]; mainRoot: string } | { error: unknown };

/** `git worktree list` once per run; the main checkout (first, not bare) is where the kit keeps its local files. */
function worktreeLister(env: DoctorEnv): () => Promise<WorktreeList> {
  let known: Promise<WorktreeList> | undefined;
  return () =>
    (known ??= listWorktrees(env.git).then(
      (worktrees): WorktreeList => ({ worktrees, mainRoot: worktrees.find(worktree => !worktree.bare)?.path ?? env.fs.root }),
      (error: unknown): WorktreeList => ({ error }),
    ));
}

/** What waits for `sdlc sync` in the cache of the main checkout (also when doctor runs in a worktree). */
async function checkOutbox(env: DoctorEnv, worktrees: () => Promise<WorktreeList>): Promise<Check> {
  const id = 'outbox.pending';
  const found = await worktrees();
  const root = 'error' in found ? env.fs.root : found.mainRoot;
  const { outbox, gaps } = await queuedCounts(root);
  let failed = 0;
  try {
    failed = (await readJsonLines<unknown>(root, OUTBOX_FAILED_FILE)).filter(isRecord).length;
  } catch {
    // A file that cannot be read counts as empty, as it does for the queue.
  }
  if (outbox + failed > 0) return warn(id, `${outbox} queued write(s), ${failed} failed; run sdlc sync`, 'sdlc sync');
  // A gap is a note for `sdlc sync` to pick up, not something to fix: it is no warning.
  return ok(id, gaps === 0 ? 'nothing is queued for sdlc sync' : `no queued writes; ${gaps} gap(s) waiting for sync`);
}

/** Longest the task lookups of `worktrees.orphans` may take in all. */
const TASK_LOOKUP_MS = 10_000;

const orphanLabel = (orphan: OrphanWorktree): string =>
  `${printable(orphan.path)}${orphan.branch === undefined ? '' : ` (${printable(orphan.branch)})`}: ${orphan.reason}`;

function orphanFix(orphans: readonly OrphanWorktree[]): string {
  const fixes = new Set<string>();
  for (const orphan of orphans) {
    const issue = taskIssueOf(orphan.branch);
    if (orphan.reason === 'prunable') fixes.add('git worktree prune');
    else if (orphan.reason === 'task-done' && issue !== undefined) fixes.add(`sdlc worktree finish ${issue}`);
    else fixes.add(`git worktree remove ${orphan.path}`);
  }
  return [...fixes].join('; ');
}

/**
 * Looks up each of `orphans` (task branches no task was found for) and records the status of the tasks that exist in `tasks`.
 * Returns why the tasks cannot be read, `undefined` when they could. Read only; the whole lookup has one deadline.
 */
async function lookUpTasks(
  tracker: Tracker,
  orphans: readonly OrphanWorktree[],
  tasks: Map<number, { status: Status }>,
): Promise<string | undefined> {
  const deadline = deadlineOf(TASK_LOOKUP_MS);
  try {
    for (const orphan of orphans) {
      const issue = taskIssueOf(orphan.branch);
      if (issue === undefined) continue;
      try {
        const task = await deadline.run(() => tracker.getTask(issue));
        tasks.set(issue, { status: task.state.status });
      } catch (error) {
        // An issue with no readable task is what makes a worktree an orphan; anything else is "cannot tell".
        if (!isNoTaskError(error)) return ghReason(error);
      }
    }
    return undefined;
  } finally {
    deadline.stop();
  }
}

/**
 * Worktrees under `.worktrees/` that no live task needs. Only a task branch with no task in hand
 * costs a GitHub read (`getTask`, read only); with GitHub unreachable or `gh` unusable the answer
 * is "not checked (tasks unavailable)", plus the orphans that need no task (detached, prunable).
 */
async function checkWorktreeOrphans(
  env: DoctorEnv,
  cfg: Config,
  blocker: string | undefined,
  worktrees: () => Promise<WorktreeList>,
): Promise<Check> {
  const id = 'worktrees.orphans';
  const found = await worktrees();
  if ('error' in found) return notChecked(id, describeError(found.error));
  const { mainRoot } = found;

  const candidates = orphanWorktrees(found.worktrees, mainRoot, new Map()).filter(orphan => orphan.reason === 'no-task');
  const tasks = new Map<number, { status: Status }>();
  let unavailable: string | undefined;
  if (candidates.length > 0) {
    unavailable =
      blocker ?? (await lookUpTasks(env.makeTracker?.(cfg) ?? new GitHubTracker(env.run, cfg, { repoRoot: mainRoot }), candidates, tasks));
  }

  const orphans = orphanWorktrees(found.worktrees, mainRoot, tasks);
  if (unavailable !== undefined) {
    const known = orphans.filter(orphan => orphan.reason !== 'no-task');
    return warn(
      id,
      `not checked (tasks unavailable: ${unavailable})${known.length > 0 ? `; orphans that need no task: ${list(known.map(orphanLabel))}` : ''}`,
      known.length > 0 ? orphanFix(known) : undefined,
    );
  }
  if (orphans.length === 0) return ok(id, `no orphan worktrees under .worktrees (${found.worktrees.length} worktree(s) listed)`);
  return warn(id, `orphan worktrees: ${list(orphans.map(orphanLabel))}`, orphanFix(orphans));
}

/**
 * The preflight and every check of an installed repository, in this order: config, manifest and
 * managed files, the git version, git hooks and the legacy hooks they chain, `sdlc` on the PATH,
 * `kit_ref`, board, labels, the Actions workflow and secret (only with `stack.actions`), the MCP
 * token and the MCP servers of each harness, Superpowers and graphify, the hooks of each harness
 * and their round trip, the secret guard, push protection, tracked secret files, approval trust,
 * what waits for `sdlc sync` and the orphan worktrees. Only reads: the board is planned as a dry
 * run, the round trip runs the hook without a trace, and nothing is written to GitHub or to disk.
 * The checks that call `gh` say `not checked` when `gh` is not installed or not logged in.
 */
export async function runDoctor(env: DoctorEnv, cfg: Config): Promise<Check[]> {
  const checks = await runPreflight(env, { actions: cfg.stack.actions });
  const blocker = ghBlocker(checks);
  const viaGh = (id: string, run: () => Promise<Check>): Promise<Check> =>
    blocker !== undefined ? Promise.resolve(notChecked(id, blocker)) : isolated(id, run);
  const add = async (check: Promise<Check>): Promise<Check> => {
    const result = await check;
    checks.push(result);
    return result;
  };

  await add(
    isolated('config.valid', () => ok('config.valid', `${printable(env.config.path)}: ${cfg.github.repo}, harnesses ${cfg.harnesses.join(', ')}, mode ${cfg.mode}`)),
  );

  let manifest: Manifest | undefined;
  let problem: string | undefined;
  try {
    manifest = readManifest(env.fs);
  } catch (error) {
    problem = describeError(error);
  }
  await add(isolated('manifest.present', () => checkManifest(manifest, problem)));
  await add(isolated('files.managed', () => checkManagedFiles(env.fs, manifest)));

  const hooks = await readHooks(env.git);
  await add(isolated('git.version', () => checkGitVersion(env)));
  await add(isolated('git.hooksPath', () => checkHooksPath(hooks)));
  await add(isolated('git.legacyHooks', () => checkLegacyHooks(env, hooks)));
  const onPath = await add(isolated('sdlc.onPath', () => checkSdlcOnPath(env)));
  await add(isolated('kit.ref', () => checkKitRef(env, cfg)));

  await add(viaGh('board.fields', () => checkBoard(env, cfg)));
  await add(viaGh('labels', () => checkLabels(env, cfg)));
  if (cfg.stack.actions) {
    await add(isolated('actions.workflow', () => checkWorkflow(env)));
    await add(viaGh('actions.secret', () => checkActionsSecret(env, cfg)));
  }

  await add(isolated('mcp.token', () => checkMcpToken(env, cfg)));
  // The three lists run together: each may take up to a minute.
  const lists = await Promise.all(HOOK_HARNESSES.map(harness => isolated(`mcp.${harness}`, () => checkMcpHarness(env, cfg, harness))));
  for (const list of lists) await add(Promise.resolve(list));
  const worktrees = worktreeLister(env);
  await add(isolated('stack.superpowers', () => checkSuperpowers(env, cfg, worktrees)));
  await add(isolated('stack.graphify', () => checkGraphify(env, cfg)));

  const launcher = launcherState(env.git);
  for (const harness of HOOK_HARNESSES) await add(isolated(`hooks.${harness}`, () => checkHooksOf(env, cfg, harness, launcher)));
  await add(isolated('hooks.switches', () => checkHookSwitches(env, cfg)));
  await add(isolated('hooks.roundtrip', () => checkRoundTrip(env, cfg)));

  await add(isolated('secrets.guard', () => checkSecretGuard(hooks, onPath.status === 'ok')));
  await add(viaGh('secrets.pushProtection', () => checkPushProtection(env, cfg)));
  await add(isolated('secrets.trackedFiles', () => checkTrackedFiles(env, cfg)));
  await add(isolated('approvals.trust', () => checkApprovalTrust(cfg)));

  await add(isolated('outbox.pending', () => checkOutbox(env, worktrees)));
  await add(isolated('worktrees.orphans', () => checkWorktreeOrphans(env, cfg, blocker, worktrees)));
  return checks;
}

// --- what `sdlc doctor` runs ----------------------------------------------------------------------

export interface DoctorRunOptions {
  /** Only the preflight, whatever the config says. */
  preflightOnly?: boolean;
}

/**
 * The checks `sdlc doctor` runs: all of them for a valid config; only the preflight (with
 * `config.present` warning) without a config file or with `preflightOnly`; and for a config that
 * cannot be read or does not validate, the preflight plus a failed `config.valid`, the rest being
 * skipped because it needs the config.
 */
export async function doctorChecks(env: DoctorEnv, options: DoctorRunOptions = {}): Promise<Check[]> {
  let cfg: Config | undefined;
  let invalid: Check | undefined;
  try {
    const text = env.config.read();
    if (text !== undefined) cfg = loadConfigFromString(text);
  } catch (error) {
    invalid = fail('config.valid', describeError(error), 'sdlc config validate');
  }
  if (cfg !== undefined && options.preflightOnly !== true) return runDoctor(env, cfg);
  const preflight = await runPreflight(env, cfg === undefined ? {} : { actions: cfg.stack.actions });
  return invalid !== undefined && options.preflightOnly !== true ? [...preflight, invalid] : preflight;
}
