import { ghJson } from '../../github/gh.js';
import { WORKFLOW_PATH } from '../../render/github.js';
import { printable, ok, warn, fail, notChecked, isolated, ghReason, failure, type Check, type DoctorEnv, type PreflightOptions } from './types.js';

/** The checks that need no config: git, Node, `gh` (installed, logged in, scopes), the repository and the instruction files. */

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
export function ghBlocker(preflight: Check[]): string | undefined {
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
