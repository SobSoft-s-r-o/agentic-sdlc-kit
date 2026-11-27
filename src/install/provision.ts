import { execFile, type ExecFileException } from 'node:child_process';
import { typeRegistry, type Config } from '../config/schema.js';
import { GhError, ghJson, type GhRunner } from '../github/gh.js';

/**
 * What `sdlc init` sets up on GitHub and in git config: labels, default-branch protection, push
 * protection and `core.hooksPath`. Every function is add-only: it never edits or removes what the
 * owner already has. With `dryRun` each one still reads, reports what a real run would report,
 * and writes nothing.
 */

export interface ProvisionOptions {
  dryRun: boolean;
}

/** Where `sdlc init` writes the git hooks, relative to the repository root. */
export const HOOKS_PATH = '.sdlc/githooks';

const DRY_RUN = 'dry run: ';

/** GitHub limits a label description to 100 characters. */
const DESCRIPTION_LIMIT = 100;

/** The error text of a failed `gh` call; `gh` writes it to stderr, sometimes with the body on stdout. */
const failureText = (result: { stdout: string; stderr: string }): string =>
  [result.stderr, result.stdout].map(text => text.trim()).filter(Boolean).join('\n');

/** The first line of `text` with `gh: ` and the `(HTTP nnn)` suffix removed, for a message. */
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.replace(/^gh:\s*/, '').replace(/\s*\(HTTP \d+\)\s*$/, '');
}

const isRateLimit = (text: string): boolean => /rate limit|abuse detection|secondary rate/i.test(text);

// -- labels ---------------------------------------------------------------------------------------

interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

function labelSpecs(cfg: Config): LabelSpec[] {
  const types = [...typeRegistry(cfg).values()].map(
    (def): LabelSpec => ({
      name: `type:${def.id}`,
      color: '1d76db',
      description: `Task type: ${def.label}`.slice(0, DESCRIPTION_LIMIT),
    }),
  );
  return [
    { name: 'sdlc:task', color: '0e8a16', description: 'Tracked by agentic-sdlc-kit' },
    { name: 'sdlc:partial', color: 'fbca04', description: 'A partial PR landed; the task stays open' },
    ...types,
  ];
}

/**
 * Creates the labels the tracker puts on issues and PRs: `sdlc:task`, `sdlc:partial` and
 * `type:<id>` for every enabled task type. A label that exists (GitHub compares names without
 * regard to case) is left exactly as it is. On a dry run `created` lists the labels a real run
 * would create.
 */
export async function ensureLabels(
  run: GhRunner,
  cfg: Config,
  opts: ProvisionOptions,
): Promise<{ created: string[]; existing: string[] }> {
  const repo = cfg.github.repo;
  const listed = await ghJson<Array<{ name: string }> | undefined>(run, [
    'label', 'list', '--repo', repo, '--json', 'name', '--limit', '500',
  ]);
  const have = new Set((listed ?? []).map(label => label.name.toLowerCase()));

  const created: string[] = [];
  const existing: string[] = [];
  for (const spec of labelSpecs(cfg)) {
    if (have.has(spec.name.toLowerCase())) {
      existing.push(spec.name);
      continue;
    }
    if (!opts.dryRun) {
      const args = [
        'label', 'create', spec.name, '--repo', repo, '--color', spec.color, '--description', spec.description,
      ];
      const result = await run(args);
      if (result.code !== 0) {
        // Past the 500 listed labels, or created by someone else meanwhile: it exists, which is the goal.
        if (/already exists/i.test(result.stderr)) {
          existing.push(spec.name);
          continue;
        }
        throw new GhError(args, result.stderr);
      }
    }
    created.push(spec.name);
  }
  return { created, existing };
}

// -- branch protection ----------------------------------------------------------------------------

export interface ProvisionResult<S extends string> {
  status: S;
  message: string;
}

/**
 * A 403 that says the plan or the caller's rights cannot have the feature: a private repository
 * on a free plan ("Upgrade to GitHub Pro ..."), or a token without admin rights. A rate limit is
 * also a 403, but a later run works, so it is an error.
 */
function isUnavailable(text: string): boolean {
  if (!/\bHTTP 403\b/.test(text) || isRateLimit(text)) return false;
  return /upgrade to|github (?:pro|team|enterprise)|make this repository public|enable this feature|not available|admin rights/i.test(
    text,
  );
}

/** The branch name for a URL path: slashes stay, every other special character is escaped. */
const branchPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

/**
 * Protects the default branch with the lightest rule that still forces changes through a pull
 * request: no approvals required, admins exempt, no force pushes or deletions. A branch that
 * already has protection of any kind is never touched. A plan or rights restriction is reported
 * as `unavailable`, not as an error.
 */
export async function ensureBranchProtection(
  run: GhRunner,
  cfg: Config,
  opts: ProvisionOptions,
): Promise<ProvisionResult<'created' | 'exists' | 'skipped' | 'unavailable'>> {
  if (!cfg.stack.branchProtection) {
    return { status: 'skipped', message: 'stack.branch_protection is false; branch protection left alone' };
  }
  const branch = cfg.github.defaultBranch;
  const url = `repos/${cfg.github.repo}/branches/${branchPath(branch)}/protection`;

  const readArgs = ['api', url];
  const read = await run(readArgs);
  if (read.code === 0) {
    return { status: 'exists', message: `${branch} already has branch protection; left unchanged` };
  }
  const readText = failureText(read);
  if (isUnavailable(readText)) return { status: 'unavailable', message: firstLine(readText) };
  if (!(/\bHTTP 404\b/.test(readText) && /branch not protected/i.test(readText))) {
    throw new GhError(readArgs, read.stderr || read.stdout);
  }

  if (opts.dryRun) {
    return { status: 'created', message: `${DRY_RUN}would protect ${branch}: pull request required, no force pushes or deletions` };
  }
  const body = {
    required_pull_request_reviews: { required_approving_review_count: 0 },
    enforce_admins: false,
    required_status_checks: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const putArgs = ['api', '-X', 'PUT', url, '--input', '-'];
  const put = await run(putArgs, JSON.stringify(body));
  if (put.code === 0) {
    return { status: 'created', message: `protected ${branch}: pull request required (0 approvals), no force pushes or deletions` };
  }
  const putText = failureText(put);
  if (isUnavailable(putText)) return { status: 'unavailable', message: firstLine(putText) };
  throw new GhError(putArgs, put.stderr || put.stdout);
}

// -- push protection ------------------------------------------------------------------------------

const PUSH_PROTECTION_UNAVAILABLE =
  'GitHub push protection unavailable for this repository; the local commit guard still blocks secrets';

interface SecurityAndAnalysis {
  secret_scanning?: { status?: string };
  secret_scanning_push_protection?: { status?: string };
}

/**
 * Turns on GitHub secret scanning and push protection. GitHub shows `security_and_analysis` to
 * repository admins only, so an empty answer is not "off": the PATCH decides. A plan without
 * secret protection, or a caller who is not an admin (403/422), is `unavailable`, not an error.
 */
export async function ensurePushProtection(
  run: GhRunner,
  cfg: Config,
  opts: ProvisionOptions,
): Promise<ProvisionResult<'enabled' | 'already' | 'unavailable'>> {
  const repoUrl = `repos/${cfg.github.repo}`;
  const current = await ghJson<SecurityAndAnalysis | null | undefined>(run, [
    'api', repoUrl, '--jq', '.security_and_analysis',
  ]);
  if (
    current?.secret_scanning?.status === 'enabled' &&
    current.secret_scanning_push_protection?.status === 'enabled'
  ) {
    return { status: 'already', message: 'secret scanning and push protection are already enabled' };
  }

  if (opts.dryRun) {
    return { status: 'enabled', message: `${DRY_RUN}would enable secret scanning and push protection` };
  }
  const body = {
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  };
  const args = ['api', '-X', 'PATCH', repoUrl, '--input', '-'];
  const patch = await run(args, JSON.stringify(body));
  if (patch.code === 0) {
    return { status: 'enabled', message: 'enabled secret scanning and push protection' };
  }
  const text = failureText(patch);
  if (/\bHTTP (?:403|422)\b/.test(text) && !isRateLimit(text)) {
    return { status: 'unavailable', message: PUSH_PROTECTION_UNAVAILABLE };
  }
  throw new GhError(args, patch.stderr || patch.stdout);
}

// -- git ------------------------------------------------------------------------------------------

/** Runs `git` with the given arguments. A non-zero exit is returned, not thrown. */
export type GitRunner = (args: string[]) => Promise<{ stdout: string; code: number; stderr: string }>;

const MAX_BUFFER = 16 * 1024 * 1024;

/** The real `git`, run in `cwd` (the current directory by default). It rejects only when `git` cannot run at all. */
export function createGitRunner(cwd?: string): GitRunner {
  return args =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, code: 0, stderr });
          return;
        }
        const failure = error as ExecFileException;
        if (failure.code === 'ENOENT') {
          reject(new Error('git not found; install https://git-scm.com'));
        } else if (typeof failure.code === 'number') {
          resolve({ stdout, code: failure.code, stderr });
        } else if (failure.signal) {
          resolve({ stdout, code: 1, stderr: stderr || `terminated by ${failure.signal}` });
        } else {
          reject(new Error(`could not run git ${args.join(' ')}: ${failure.message}`));
        }
      });
    });
}

export const defaultGitRunner: GitRunner = createGitRunner();

/** `./.sdlc/githooks/` and `.sdlc/githooks` name the same directory. */
const normalizeHooksPath = (value: string): string => value.trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

export interface HooksPathOptions extends ProvisionOptions {
  /** Called with the explanation when another `core.hooksPath` is already set. */
  notice?: (message: string) => void;
}

/**
 * Points `core.hooksPath` at `.sdlc/githooks`. An unset value becomes that path (`set`); the same
 * path is `already`. Any other value is left alone (`conflict`): the kit's hooks are then not
 * active, which `notice` explains with both paths.
 */
export async function setHooksPath(git: GitRunner, opts: HooksPathOptions): Promise<'set' | 'already' | 'conflict'> {
  const read = await git(['config', '--get', 'core.hooksPath']);
  // Exit 1 with no output is how `git config --get` says the key is unset.
  if (read.code !== 0 && !(read.code === 1 && read.stdout.trim() === '')) {
    throw new Error(`git config --get core.hooksPath failed: ${read.stderr.trim() || `exit code ${read.code}`}`);
  }
  const current = read.code === 0 ? read.stdout.trim() : '';
  if (current !== '') {
    if (normalizeHooksPath(current) === HOOKS_PATH) return 'already';
    opts.notice?.(
      `core.hooksPath is already set to "${current}", so the sdlc git hooks in ${HOOKS_PATH} are not active and nothing was changed. ` +
        `Run them from your own hooks, or point core.hooksPath at ${HOOKS_PATH}.`,
    );
    return 'conflict';
  }
  if (opts.dryRun) return 'set';
  const write = await git(['config', 'core.hooksPath', HOOKS_PATH]);
  if (write.code !== 0) {
    throw new Error(`git config core.hooksPath ${HOOKS_PATH} failed: ${write.stderr.trim() || `exit code ${write.code}`}`);
  }
  return 'set';
}
