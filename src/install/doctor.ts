import { loadConfigFromString, type Config } from '../config/schema.js';
import { ensureBoard } from '../github/board.js';
import { GhError, ghJson, type GhRunner } from '../github/gh.js';
import { WORKFLOW_PATH } from '../render/github.js';
import { mcpEnvVars } from '../render/mcp.js';
import { scanFileName } from '../secrets/scan.js';
import { MANIFEST_PATH, entryDiskHash, readManifest, type Manifest, type ManifestEntry } from './manifest.js';
import { HOOKS_PATH, ensureLabels, normalizeHooksPath, readHooksPath, readPushProtection, type GitRunner } from './provision.js';
import type { RepoFs } from './repoFs.js';

/**
 * `sdlc doctor`: read-only checks of the machine (the preflight, which needs no config) and of an
 * installed repository. Every check is isolated: one that throws becomes a failed check with a
 * one-line message and the others still run. No secret is ever read into a message: `mcp.token`
 * names variables only, `secrets.trackedFiles` prints file paths only.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

/** All the IO of the checks, injected. */
export interface DoctorEnv {
  run: GhRunner;
  git: GitRunner;
  fs: RepoFs;
  /** Whether `cmd` is an executable on the PATH. */
  which(cmd: string): Promise<boolean>;
  /** Runs a program with its stdin closed; a non-zero exit is returned, a program that cannot run rejects. */
  exec(cmd: string, args: string[]): Promise<{ stdout: string; code: number; stderr: string }>;
  /** Only the names of variables are ever reported, never their values. */
  env: NodeJS.ProcessEnv;
  /** `process.version`, e.g. `v22.3.0`. */
  nodeVersion: string;
  /** The config file: its name for messages, and its text (`undefined` when there is no such file; throws when it cannot be read). */
  config: { path: string; read(): string | undefined };
}

export interface PreflightOptions {
  /** Whether the GitHub Actions workflow will be used (`stack.actions`); decides if a missing `workflow` scope matters. Defaults to true. */
  actions?: boolean;
}

// --- helpers --------------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const MESSAGE_LIMIT = 300;

/** The text of an error as one printable line: no escape sequences or line breaks, at most 300 characters. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return 'unknown error';
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/** A name or path for a message: every control character shown as `?`. */
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

const ok = (id: string, message: string): Check => ({ id, status: 'ok', message });
const warn = (id: string, message: string, fix?: string): Check => ({ id, status: 'warn', message, ...(fix === undefined ? {} : { fix }) });
const fail = (id: string, message: string, fix?: string): Check => ({ id, status: 'fail', message, ...(fix === undefined ? {} : { fix }) });
const notChecked = (id: string, why: string): Check => warn(id, `not checked: ${why}`);

/** Runs one check; whatever it throws is that check failing, in one line. */
async function isolated(id: string, run: () => Check | Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (error) {
    return fail(id, describeError(error));
  }
}

/** The reason a failed `gh` call gives: the first line of its stderr without the `gh: ` prefix, else the error's own text. */
function ghReason(error: unknown): string {
  if (error instanceof GhError) {
    const first = error.stderr.trim().split('\n')[0]?.replace(/^gh:\s*/, '') ?? '';
    if (first.trim() !== '') return describeError(first);
  }
  return describeError(error);
}

/** `failed (exit N)` and, when the program said something on stderr, its first line as one printable line. Never stdout: it can hold other people's credentials. */
function failure(code: number, stderr: string): string {
  const first = stderr.split('\n').map(line => line.trim()).find(line => line !== '');
  return first === undefined ? `failed (exit ${code})` : `failed (exit ${code}): ${describeError(first)}`;
}

const list = (items: readonly string[], max = 8): string =>
  items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');

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

// --- install checks -------------------------------------------------------------------------------

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

/** How `sdlc` can be run the way the git hooks run it: from the PATH, else `npx --no-install`. */
async function checkSdlcOnPath(env: DoctorEnv): Promise<Check> {
  const id = 'sdlc.onPath';
  if (await env.which('sdlc')) return ok(id, 'sdlc is on the PATH');
  if (await env.which('npx')) {
    try {
      const probe = await env.exec('npx', ['--no-install', 'sdlc', '--version']);
      if (probe.code === 0) return ok(id, 'sdlc resolves through npx');
    } catch {
      // npx cannot run here: the same as not finding sdlc.
    }
  }
  return warn(id, 'sdlc is neither on the PATH nor installed for npx, so the git hooks skip', 'install sdlc globally or as a dev dependency (see INSTALL.md)');
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
    `${unset.map(name => `export ${name}=<token>`).join('; ')} before starting your agent`,
  );
}

async function checkMcpClaude(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'mcp.claude';
  if (!cfg.harnesses.includes('claude')) return ok(id, 'claude is not a configured harness; skipped');
  if (!(await env.which('claude'))) return ok(id, 'claude CLI not found; skipped');
  const wanted = cfg.mcp.servers;
  if (wanted.length === 0) return ok(id, 'no MCP servers are configured');

  let result: Awaited<ReturnType<DoctorEnv['exec']>>;
  try {
    result = await env.exec('claude', ['mcp', 'list']);
  } catch (error) {
    return warn(id, `could not run claude mcp list: ${describeError(error)}`);
  }
  if (result.code !== 0) {
    // Only the exit code and the first line of stderr: stdout can list other servers with their credentials.
    return warn(id, `claude mcp list ${failure(result.code, result.stderr)}`);
  }
  // `<id>: <command or url> - <status>` per server; an id counts only when it is the whole name.
  const listed = new Set(
    `${result.stdout}\n${result.stderr}`.split('\n').flatMap(line => {
      const at = line.indexOf(': ');
      return at > 0 ? [line.slice(0, at).trim()] : [];
    }),
  );
  const missing = wanted.filter(server => !listed.has(server));
  if (missing.length === 0) return ok(id, `claude mcp list shows ${wanted.join(', ')}`);
  return warn(
    id,
    `claude mcp list does not show: ${missing.join(', ')}`,
    'approve the server in Claude Code or run the printed claude mcp add command',
  );
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

/**
 * The preflight and every check of an installed repository, in this order: config, manifest and
 * managed files, git hooks, `sdlc` on the PATH, board, labels, the Actions workflow and secret (only
 * with `stack.actions`), MCP, the secret guard, push protection, tracked secret files and approval
 * trust. Only reads: the board is planned as a dry run and nothing is written to GitHub or to disk.
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
  await add(isolated('git.hooksPath', () => checkHooksPath(hooks)));
  const onPath = await add(isolated('sdlc.onPath', () => checkSdlcOnPath(env)));

  await add(viaGh('board.fields', () => checkBoard(env, cfg)));
  await add(viaGh('labels', () => checkLabels(env, cfg)));
  if (cfg.stack.actions) {
    await add(isolated('actions.workflow', () => checkWorkflow(env)));
    await add(viaGh('actions.secret', () => checkActionsSecret(env, cfg)));
  }

  await add(isolated('mcp.token', () => checkMcpToken(env, cfg)));
  await add(isolated('mcp.claude', () => checkMcpClaude(env, cfg)));
  await add(isolated('secrets.guard', () => checkSecretGuard(hooks, onPath.status === 'ok')));
  await add(viaGh('secrets.pushProtection', () => checkPushProtection(env, cfg)));
  await add(isolated('secrets.trackedFiles', () => checkTrackedFiles(env, cfg)));
  await add(isolated('approvals.trust', () => checkApprovalTrust(cfg)));
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
