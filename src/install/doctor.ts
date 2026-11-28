import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deadlineOf, isNoTaskError, taskIssueOf } from '../commands/githook.js';
import { runHook, type HookContext } from '../commands/hook.js';
import { loadConfigFromString, type Config } from '../config/schema.js';
import type { Status } from '../core/types.js';
import { listWorktrees, orphanWorktrees, type OrphanWorktree, type Worktree } from '../git/worktrees.js';
import { ensureBoard } from '../github/board.js';
import { GhError, ghJson } from '../github/gh.js';
import { GitHubTracker } from '../github/githubTracker.js';
import { readJsonLines } from '../hooks/localLog.js';
import { EVENT_NAMES } from '../hooks/output.js';
import { HOOK_EVENTS, HOOK_HARNESSES, type HookHarness } from '../hooks/types.js';
import { OUTBOX_FAILED_FILE, queuedCounts } from '../outbox/outbox.js';
import { WORKFLOW_PATH } from '../render/github.js';
import { HOOK_LAUNCHER, isKitHookItem, NATIVE_EVENT, SETTINGS_FILE } from '../render/hooks.js';
import { KIT_GIT_URL } from '../render/instructions.js';
import { mcpEnvVars } from '../render/mcp.js';
import { envKey, pathDelimiter } from '../secrets/gitleaks.js';
import { scanFileName } from '../secrets/scan.js';
import type { Tracker } from '../tracker/types.js';
import { MANIFEST_PATH, entryDiskHash, readManifest, type Manifest, type ManifestEntry } from './manifest.js';
import { HOOKS_PATH, ensureLabels, findLegacyHooks, normalizeHooksPath, readHooksPath, readPushProtection, type GitRunner } from './provision.js';
import type { RepoFs } from './repoFs.js';
import { mcpListArgs, mcpNames, superpowersInstall, superpowersInstalled, superpowersListArgs, graphifyInstall } from './stack.js';
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
  type PreflightOptions,
} from './doctor/types.js';

/**
 * `sdlc doctor`: read-only checks of the machine (the preflight, which needs no config) and of an
 * installed repository. Every check is isolated: one that throws becomes a failed check with a
 * one-line message and the others still run. No secret is ever read into a message: `mcp.token`
 * names variables only, `secrets.trackedFiles` prints file paths only.
 */

export type { CheckStatus, Check, DoctorEnv, ExecOptions, PreflightOptions } from './doctor/types.js';
export { describeError } from './doctor/types.js';

// --- gh auth status -------------------------------------------------------------------------------

interface AccountBlock {
  host?: string;
  account?: string;
  active?: boolean;
  scopes?: string[];
}

/** The scopes of one `Token scopes:` value: quoted (`'repo', 'project'`) or bare (`repo, project`); `none` is empty. */
function scopeList(value: string): string[] {
  const text = value.trim();
  if (text.toLowerCase() === 'none') return [];
  return text
    .split(',')
    .map(scope => scope.trim().replace(/^['"`]|['"`]$/g, '').trim())
    .filter(scope => scope !== '');
}

/** One block per account `gh auth status` lists; lines before any `Logged in to` header belong to an anonymous block. */
function accountBlocks(output: string): AccountBlock[] {
  const blocks: AccountBlock[] = [];
  let current: AccountBlock | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const login = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line);
    if (login) {
      current = { host: login[1], account: login[2] };
      blocks.push(current);
      continue;
    }
    const active = /Active account:\s*(true|false)/i.exec(line);
    const scopes = /Token scopes:\s*(.*)$/i.exec(line);
    if (!active && !scopes) continue;
    if (!current) {
      current = {};
      blocks.push(current);
    }
    if (active) current.active = active[1]?.toLowerCase() === 'true';
    if (scopes) current.scopes = scopeList(scopes[1] ?? '');
  }
  return blocks;
}

/** The account `gh` acts as: the active one, else the first that is not marked inactive (older gh prints no marker). */
const activeAccount = (blocks: AccountBlock[]): AccountBlock | undefined =>
  blocks.find(block => block.active === true) ?? blocks.find(block => block.active !== false);

/**
 * The token scopes `gh auth status` prints for the active account (`  - Token scopes: 'gist', 'repo'`),
 * `undefined` when it prints none (a fine-grained token, or an output without the line); `none` is `[]`.
 */
export function parseTokenScopes(output: string): string[] | undefined {
  return activeAccount(accountBlocks(output))?.scopes;
}

// --- preflight ------------------------------------------------------------------------------------

async function checkGitRepo(env: DoctorEnv): Promise<Check> {
  const result = await env.git(['rev-parse', '--is-inside-work-tree']);
  if (result.code === 0 && result.stdout.trim() === 'true') return ok('git.repo', 'inside a git work tree');
  return fail('git.repo', 'not inside a git work tree', 'run sdlc from your repository, or create one with git init');
}

function checkNode(env: DoctorEnv): Check {
  const major = /^v?(\d+)\./.exec(env.nodeVersion.trim())?.[1];
  if (major !== undefined && Number(major) >= 20) return ok('node.version', `Node ${env.nodeVersion.trim()}`);
  const shown = env.nodeVersion.trim() === '' ? 'is unknown' : env.nodeVersion.trim();
  return fail('node.version', `Node ${shown}: sdlc needs Node 20 or newer`, 'install Node.js 20 or newer (https://nodejs.org)');
}

function checkScopes(output: string, actions: boolean): Check {
  const id = 'gh.scopes';
  const scopes = parseTokenScopes(output);
  if (scopes === undefined || scopes.length === 0) {
    return warn(id, 'the token scopes cannot be verified: gh does not list any (a fine-grained token?); sdlc needs repo and project');
  }
  const missing = ['repo', 'project'].filter(scope => !scopes.includes(scope));
  const workflowMissing = actions && !scopes.includes('workflow');
  if (missing.length > 0) {
    const refresh = [...missing, ...(workflowMissing ? ['workflow'] : [])].map(scope => `-s ${scope}`).join(' ');
    return fail(id, `the token lacks the ${missing.join(' and ')} scope${missing.length > 1 ? 's' : ''}`, `gh auth refresh ${refresh}`);
  }
  if (workflowMissing) {
    return warn(id, `the token lacks the workflow scope, which pushing ${WORKFLOW_PATH} needs`, 'gh auth refresh -s workflow');
  }
  return ok(id, `the token has the scopes repo and project${actions ? ' and workflow' : ''}`);
}

async function checkRemote(env: DoctorEnv): Promise<Check> {
  const id = 'repo.remote';
  try {
    const repo = await ghJson<{ nameWithOwner?: string; defaultBranchRef?: { name?: string } | null } | undefined>(env.run, [
      'repo', 'view', '--json', 'nameWithOwner,defaultBranchRef',
    ]);
    if (typeof repo?.nameWithOwner !== 'string' || repo.nameWithOwner === '') {
      return fail(id, 'gh repo view did not name a repository', 'add a GitHub remote (git remote add origin <url>) or create the repository with gh repo create');
    }
    const branch = repo.defaultBranchRef?.name;
    return ok(id, `${printable(repo.nameWithOwner)}${typeof branch === 'string' && branch !== '' ? `, default branch ${printable(branch)}` : ''}`);
  } catch (error) {
    return fail(id, `gh cannot see the repository: ${ghReason(error)}`, 'add a GitHub remote (git remote add origin <url>) or create the repository with gh repo create');
  }
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

function checkInstructionFiles(env: DoctorEnv): Check {
  const found = INSTRUCTION_FILES.filter(path => env.fs.read(path) !== undefined);
  return ok(
    'repo.instructionFiles',
    found.length > 0 ? `instruction files: ${found.join(', ')}` : `none of ${INSTRUCTION_FILES.join(', ')} exist yet`,
  );
}

function checkConfigPresent(env: DoctorEnv): Check {
  const id = 'config.present';
  if (env.config.read() !== undefined) return ok(id, `${printable(env.config.path)} found`);
  return warn(id, `${printable(env.config.path)} not found`, 'run sdlc config suggest');
}

/** The reason the checks that call `gh` cannot run, from the preflight's results; `undefined` when `gh` is usable. */
function ghBlocker(preflight: Check[]): string | undefined {
  if (preflight.find(check => check.id === 'gh.installed')?.status !== 'ok') return 'gh is not installed';
  if (preflight.find(check => check.id === 'gh.auth')?.status !== 'ok') return 'gh auth status did not succeed';
  return undefined;
}

/**
 * The checks that need no config: git, Node, `gh` (installed, logged in, scopes), the repository
 * `gh` sees, the agent instruction files and the config file. Nothing is written anywhere.
 */
export async function runPreflight(env: DoctorEnv, options: PreflightOptions = {}): Promise<Check[]> {
  const actions = options.actions ?? true;
  const checks: Check[] = [];

  checks.push(await isolated('git.repo', () => checkGitRepo(env)));
  checks.push(await isolated('node.version', () => checkNode(env)));

  checks.push(
    await isolated('gh.installed', async () =>
      (await env.which('gh')) ? ok('gh.installed', 'gh CLI found') : fail('gh.installed', 'gh CLI not found', 'install the GitHub CLI: https://cli.github.com'),
    ),
  );
  const installed = checks[checks.length - 1] as Check;

  let status = '';
  const auth =
    installed.status !== 'ok'
      ? notChecked('gh.auth', 'gh is not installed')
      : await isolated('gh.auth', async () => {
          const result = await env.run(['auth', 'status']);
          const output = `${result.stdout}\n${result.stderr}`;
          if (result.code !== 0) {
            return fail('gh.auth', `gh auth status ${failure(result.code, result.stderr)}`, 'gh auth login');
          }
          status = output;
          const account = activeAccount(accountBlocks(output));
          return ok(
            'gh.auth',
            account?.account === undefined ? 'gh is logged in' : `logged in to ${printable(account.host ?? 'GitHub')} as ${printable(account.account)}`,
          );
        });
  checks.push(auth);

  const blocker = ghBlocker(checks);
  checks.push(blocker !== undefined ? notChecked('gh.scopes', blocker) : await isolated('gh.scopes', () => checkScopes(status, actions)));
  checks.push(blocker !== undefined ? notChecked('repo.remote', blocker) : await isolated('repo.remote', () => checkRemote(env)));
  checks.push(await isolated('repo.instructionFiles', () => checkInstructionFiles(env)));
  checks.push(await isolated('config.present', () => checkConfigPresent(env)));
  return checks;
}

type Hooks = { value: string | undefined } | { error: unknown };

async function readHooks(git: GitRunner): Promise<Hooks> {
  try {
    return { value: await readHooksPath(git) };
  } catch (error) {
    return { error };
  }
}

const hooksActive = (hooks: Hooks): boolean => 'value' in hooks && hooks.value !== undefined && normalizeHooksPath(hooks.value) === HOOKS_PATH;

function checkManifest(manifest: Manifest | undefined, problem: string | undefined): Check {
  const id = 'manifest.present';
  if (problem !== undefined) return fail(id, problem, 'fix or remove the manifest, then run sdlc init');
  if (manifest === undefined) return fail(id, `${MANIFEST_PATH} not found: the kit is not installed here`, 'sdlc init');
  return ok(id, `${MANIFEST_PATH}: ${manifest.entries.length} managed entries, written by sdlc ${printable(manifest.kit)}`);
}

const entryLabel = (entry: ManifestEntry): string => printable(entry.key === undefined ? entry.path : `${entry.path} (${entry.key})`);

/** Every manifest entry present on disk and matching its hash; a region that cannot be read (damaged markers, invalid JSON) counts as modified. */
function checkManagedFiles(fs: RepoFs, manifest: Manifest | undefined): Check {
  const id = 'files.managed';
  if (manifest === undefined) return notChecked(id, `no ${MANIFEST_PATH}`);
  const missing: string[] = [];
  const modified: string[] = [];
  for (const entry of manifest.entries) {
    let current: string | undefined;
    try {
      current = entryDiskHash(entry, fs.read(entry.path));
    } catch {
      modified.push(entryLabel(entry));
      continue;
    }
    if (current === undefined) missing.push(entryLabel(entry));
    else if (current !== entry.hash) modified.push(entryLabel(entry));
  }
  if (missing.length === 0 && modified.length === 0) return ok(id, `${manifest.entries.length} managed entries match the manifest`);
  const parts = [...(missing.length > 0 ? [`missing: ${list(missing)}`] : []), ...(modified.length > 0 ? [`modified: ${list(modified)}`] : [])];
  if (missing.length > 0) return fail(id, parts.join('; '), 'sdlc init');
  return warn(id, parts.join('; '), 'keep your edits, or replace the entries with sdlc init --overwrite-modified');
}

/** `git worktree`, `rev-parse --path-format=absolute` (the hooks) and the launcher lookup need git 2.31. */
const MIN_GIT = { major: 2, minor: 31 };

async function checkGitVersion(env: DoctorEnv): Promise<Check> {
  const id = 'git.version';
  const result = await env.git(['--version']);
  if (result.code !== 0) return warn(id, `could not read the git version: git --version ${failure(result.code, result.stderr)}`);
  const match = /git version ((\d+)\.(\d+)[^\r\n]*)/.exec(result.stdout);
  if (match === null) return warn(id, `could not read the git version from "${describeError(result.stdout)}"`);
  const [, version = '', major = '0', minor = '0'] = match;
  const recent = Number(major) > MIN_GIT.major || (Number(major) === MIN_GIT.major && Number(minor) >= MIN_GIT.minor);
  const wanted = `${MIN_GIT.major}.${MIN_GIT.minor}`;
  return recent
    ? ok(id, `git ${printable(version)}`)
    : warn(id, `git ${printable(version)} is older than ${wanted}, which the sdlc hooks and worktrees need`, `upgrade git to ${wanted} or later`);
}

function checkHooksPath(hooks: Hooks): Check {
  const id = 'git.hooksPath';
  if ('error' in hooks) throw hooks.error;
  if (hooks.value === undefined) return fail(id, 'core.hooksPath is not set, so the sdlc git hooks do not run', 'sdlc init');
  if (hooksActive(hooks)) return ok(id, `core.hooksPath is ${HOOKS_PATH}`);
  return fail(
    id,
    `core.hooksPath is "${printable(hooks.value)}", not ${HOOKS_PATH}, so the sdlc git hooks do not run`,
    `git config core.hooksPath ${HOOKS_PATH} (or call the hooks in ${HOOKS_PATH} from your own)`,
  );
}

/** The PATH entries `npx`/`npm exec` put in front for the program it runs: its temporary package, and every `node_modules/.bin` up from the current directory. */
const NPX_PACKAGE_DIR = /[\\/]_npx[\\/]/;
const NPM_INJECTED_DIR = /[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/;

/** Whether this process runs under `npx` or `npm exec` (npm says so in the environment of what it runs). */
const underNpmExec = (env: NodeJS.ProcessEnv): boolean => env.npm_command === 'exec' || env.npm_lifecycle_event === 'npx';

/**
 * The environment a git hook sees, made from this process's: without the PATH entries of a
 * temporary `npx` package (any directory with an `_npx` part) and, under `npx`/`npm exec`,
 * without the `node_modules/.bin` directories npm added and npm's own `npm_*` variables. A
 * doctor run through `npx -y github:...` would otherwise find its own temporary `sdlc` and
 * report the hooks as able to run when they are not. `stripped` counts the PATH entries removed.
 */
export function hookEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { env: NodeJS.ProcessEnv; stripped: number } {
  const npm = underNpmExec(env);
  // On Windows the variable is often `Path`: strip it under the name it has, so the copy keeps that name.
  const pathKey = envKey(env, 'PATH', platform);
  const delimiter = pathDelimiter(platform);
  const result: NodeJS.ProcessEnv = {};
  let stripped = 0;
  for (const [key, value] of Object.entries(env)) {
    if (npm && /^npm_/i.test(key)) continue;
    if (key !== pathKey || value === undefined) {
      result[key] = value;
      continue;
    }
    const entries = value.split(delimiter);
    const kept = entries.filter(entry => !NPX_PACKAGE_DIR.test(entry) && !(npm && NPM_INJECTED_DIR.test(entry)));
    stripped += entries.length - kept.length;
    result[key] = kept.join(delimiter);
  }
  return { env: result, stripped };
}

/**
 * How `sdlc` can be run the way the git hooks run it: from the PATH, else `npx --no-install sdlc`
 * from the repository root, both with the environment a hook sees (`hookEnvironment`).
 */
async function checkSdlcOnPath(env: DoctorEnv): Promise<Check> {
  const id = 'sdlc.onPath';
  const hook = hookEnvironment(env.env);
  const note = hook.stripped > 0 ? ' (the PATH entries npx added for this run were left out, as a git hook does not see them)' : '';
  if (await env.which('sdlc', hook.env)) return ok(id, `sdlc is on the PATH${note}`);
  if (await env.which('npx', hook.env)) {
    try {
      const probe = await env.exec('npx', ['--no-install', 'sdlc', '--version'], { env: hook.env });
      if (probe.code === 0) return ok(id, `sdlc resolves through npx${note}`);
    } catch {
      // npx cannot run here: the same as not finding sdlc.
    }
  }
  return warn(
    id,
    `sdlc is neither on the PATH nor installed for npx, so the git hooks skip${note}`,
    'install sdlc globally or as a dev dependency (see INSTALL.md)',
  );
}

/**
 * The repository's own hooks in `.git/hooks`. Only while `core.hooksPath` is the kit's do the sdlc
 * hooks run them after their own step (one that is not executable is skipped: a warning). With
 * `core.hooksPath` unset git runs them itself, and with it pointing at another manager (husky, say)
 * git runs neither them nor the sdlc hooks; `git.hooksPath` reports that case.
 */
async function checkLegacyHooks(env: DoctorEnv, hooks: Hooks): Promise<Check> {
  const id = 'git.legacyHooks';
  if ('error' in hooks) return notChecked(id, 'core.hooksPath could not be read');
  let found: Awaited<ReturnType<typeof findLegacyHooks>>;
  try {
    found = await findLegacyHooks(env.git, env.fs.root, env.hookProbe);
  } catch (error) {
    return warn(id, `cannot check for hooks of your own: ${describeError(error)}`);
  }
  const dir = printable(found.dir);
  const own = [...found.chained, ...found.notExecutable];
  if (!hooksActive(hooks)) {
    const runnable = found.chained.length > 0 ? found.chained.join(', ') : 'none';
    const skipped = found.notExecutable.length > 0 ? `; not executable, so skipped: ${found.notExecutable.join(', ')}` : '';
    const names = `${runnable} in ${dir}${skipped}`;
    return hooks.value === undefined
      ? ok(id, `core.hooksPath is not set, so the sdlc hooks are not active and git runs your own hooks itself (${names}); once it is set, the sdlc hooks run them after their own step`)
      : ok(id, `core.hooksPath is ${printable(hooks.value)}, so git runs the hooks there: neither the sdlc hooks nor your hooks in ${dir} (${own.length > 0 ? own.join(', ') : 'none'}) run; see git.hooksPath`);
  }
  if (found.notExecutable.length > 0) {
    return warn(
      id,
      `not executable, so the sdlc hooks do not run them: ${found.notExecutable.join(', ')} in ${dir}` +
        (found.chained.length > 0 ? `; chained: ${found.chained.join(', ')}` : ''),
      found.notExecutable.map(name => `chmod +x ${dir}/${name}`).join('; '),
    );
  }
  if (found.chained.length > 0) {
    return ok(id, `the sdlc hooks run your hooks in ${dir} after the sdlc step: ${found.chained.join(', ')}`);
  }
  return ok(id, `no hooks of your own in ${dir} to chain`);
}

const KIT_REF_TIMEOUT_MS = 15_000;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/** `kit_ref` must exist in the kit's repository: every generated `npx -y github:...#<kit_ref>` command fails otherwise. Network trouble is "cannot verify". */
async function checkKitRef(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'kit.ref';
  const ref = cfg.kitRef;
  const fix = `set kit_ref in sdlc.config.yaml to a tag or branch of the kit that exists (main until a release tag exists, or the ref you installed from)`;
  if (COMMIT_SHA.test(ref)) return ok(id, `kit_ref ${ref} looks like a commit; not checked`);
  let result: Awaited<ReturnType<DoctorEnv['exec']>>;
  try {
    result = await env.exec('git', ['ls-remote', '--exit-code', KIT_GIT_URL, ref], {
      // No prompt for credentials, and no ssh passphrase or host-key prompt when a url.insteadOf rule turns the URL into ssh.
      env: { ...env.env, GIT_TERMINAL_PROMPT: '0', ...(env.env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}) },
      timeoutMs: KIT_REF_TIMEOUT_MS,
    });
  } catch (error) {
    return warn(id, `cannot verify kit_ref ${printable(ref)}: ${describeError(error)}`);
  }
  // `--exit-code`: 2 means the repository answered and has no such ref.
  if (result.code === 2) return warn(id, `kit_ref ${printable(ref)} does not exist in ${KIT_GIT_URL}, so the generated npx commands fail`, fix);
  if (result.code !== 0) return warn(id, `cannot verify kit_ref ${printable(ref)}: git ls-remote ${failure(result.code, result.stderr)}`);
  return ok(id, `kit_ref ${printable(ref)} exists in the kit's repository`);
}

async function checkBoard(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'board.fields';
  const result = await ensureBoard(env.run, cfg, { dryRun: true });
  if (result.wouldCreateProject) return fail(id, 'no board is configured: github.project.number is not set', 'sdlc board ensure');
  const structure = [
    ...(result.plan.createFields.length > 0 ? [`missing fields: ${list(result.plan.createFields.map(field => field.name))}`] : []),
    ...result.plan.addOptions.map(change => `missing options of ${change.fieldName}: ${list(change.missing)}`),
  ];
  const views = result.viewsPlanned.length > 0 ? `missing views: ${list(result.viewsPlanned)}` : undefined;
  if (structure.length > 0) {
    return fail(id, `board #${result.projectNumber}: ${[...structure, ...(views === undefined ? [] : [views])].join('; ')}`, 'sdlc board ensure');
  }
  // Views alone do not stop the workflow, and the API cannot create every kind of view.
  if (views !== undefined) {
    return warn(
      id,
      `board #${result.projectNumber}: ${views} (run sdlc board ensure; if the API cannot create them, create them manually)`,
      'sdlc board ensure',
    );
  }
  return ok(id, `board #${result.projectNumber} has every field, option and view`);
}

async function checkLabels(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'labels';
  const { created: missing, existing } = await ensureLabels(env.run, cfg, { dryRun: true });
  if (missing.length > 0) return fail(id, `missing labels: ${list(missing.map(printable))}`, 'sdlc init');
  return ok(id, `all ${existing.length} labels exist`);
}

function checkWorkflow(env: DoctorEnv): Check {
  const id = 'actions.workflow';
  if (env.fs.read(WORKFLOW_PATH) !== undefined) return ok(id, `${WORKFLOW_PATH} exists`);
  return fail(id, `${WORKFLOW_PATH} not found`, 'sdlc init');
}

const SECRET_NAME = 'SDLC_TOKEN';

async function checkActionsSecret(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'actions.secret';
  try {
    const secrets = await ghJson<Array<{ name?: string }> | undefined>(env.run, ['secret', 'list', '--repo', cfg.github.repo, '--json', 'name']);
    if ((secrets ?? []).some(secret => secret.name === SECRET_NAME)) return ok(id, `${SECRET_NAME} is set as a repository secret`);
    return fail(
      id,
      `${SECRET_NAME} is not set as a repository secret (organization-level secrets are not visible to this check)`,
      `gh secret set ${SECRET_NAME}`,
    );
  } catch (error) {
    // Listing secrets needs admin access: without it the secret cannot be told apart from a missing one.
    if (error instanceof GhError && /\bHTTP 403\b/.test(error.stderr)) {
      return warn(id, `cannot verify ${SECRET_NAME} (needs admin access to list secrets)`);
    }
    return fail(id, `cannot list the repository secrets: ${ghReason(error)}`);
  }
}

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
