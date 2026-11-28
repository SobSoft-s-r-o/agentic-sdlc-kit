import type { Config } from '../../config/schema.js';
import { ensureBoard } from '../../github/board.js';
import { GhError, ghJson } from '../../github/gh.js';
import { WORKFLOW_PATH } from '../../render/github.js';
import { KIT_GIT_URL, KIT_PACKAGE, releaseVersion } from '../../render/instructions.js';
import { ensureLabels } from '../provision.js';
import { describeError, printable, ok, warn, fail, ghReason, failure, list, type Check, type DoctorEnv } from './types.js';

/** The GitHub side of an installed repository: `kit_ref`, board, labels, the Actions workflow and its secret. */

const KIT_REF_TIMEOUT_MS = 15_000;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/**
 * `kit_ref` must resolve, or every generated `npx -y ...` command fails: a release tag (`v0.3.0`) must be published on npm,
 * a branch must exist in the kit's repository, and a commit is not checked. Network trouble is "cannot verify".
 */
export async function checkKitRef(env: DoctorEnv, cfg: Config): Promise<Check> {
  const version = releaseVersion(cfg.kitRef);
  if (version !== undefined) return checkPublishedVersion(env, cfg.kitRef, version);
  return checkGitRef(env, cfg.kitRef);
}

type ExecAnswer = Awaited<ReturnType<DoctorEnv['exec']>>;

/** A release tag: `npm view agentic-sdlc-kit@<version> version --json`. The registry answers E404 for a version it does not have. */
async function checkPublishedVersion(env: DoctorEnv, ref: string, version: string): Promise<Check> {
  const id = 'kit.ref';
  let result: ExecAnswer;
  try {
    result = await env.exec('npm', ['view', `${KIT_PACKAGE}@${version}`, 'version', '--json'], { env: env.env, timeoutMs: KIT_REF_TIMEOUT_MS });
  } catch (error) {
    return warn(id, `cannot verify kit_ref ${printable(ref)}: ${describeError(error)}`);
  }
  if (result.code === 0) {
    // `"0.3.0"` for the one version asked for (a list of versions when more than one matched).
    return publishedVersions(result.stdout).includes(version)
      ? ok(id, `kit_ref ${printable(ref)} is published on npm`)
      : warn(id, `cannot verify kit_ref ${printable(ref)}: npm view did not answer with ${version}`);
  }
  // Matched only, never shown: the output can hold other people's credentials (a registry URL with a token).
  if (/\bE404\b/.test(`${result.stderr}\n${result.stdout}`)) {
    return fail(id, `kit_ref ${printable(ref)} is not published on npm`, 'set kit_ref to a published version (v0.3.0 or later) or main');
  }
  return warn(id, `cannot verify kit_ref ${printable(ref)}: npm view ${failure(result.code, result.stderr)}`);
}

/** The versions in the output of `npm view <name>@<version> version --json`. */
function publishedVersions(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** A branch (or any other ref that is not a release tag or a commit): `git ls-remote` of the kit's repository. */
async function checkGitRef(env: DoctorEnv, ref: string): Promise<Check> {
  const id = 'kit.ref';
  const fix = `set kit_ref in sdlc.config.yaml to a branch of the kit that exists (main), a commit, or a published version (v0.3.0 or later)`;
  if (COMMIT_SHA.test(ref)) return ok(id, `kit_ref ${ref} looks like a commit; not checked`);
  let result: ExecAnswer;
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

export async function checkBoard(env: DoctorEnv, cfg: Config): Promise<Check> {
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

export async function checkLabels(env: DoctorEnv, cfg: Config): Promise<Check> {
  const id = 'labels';
  const { created: missing, existing } = await ensureLabels(env.run, cfg, { dryRun: true });
  if (missing.length > 0) return fail(id, `missing labels: ${list(missing.map(printable))}`, 'sdlc init');
  return ok(id, `all ${existing.length} labels exist`);
}

export function checkWorkflow(env: DoctorEnv): Check {
  const id = 'actions.workflow';
  if (env.fs.read(WORKFLOW_PATH) !== undefined) return ok(id, `${WORKFLOW_PATH} exists`);
  return fail(id, `${WORKFLOW_PATH} not found`, 'sdlc init');
}

const SECRET_NAME = 'SDLC_TOKEN';

export async function checkActionsSecret(env: DoctorEnv, cfg: Config): Promise<Check> {
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
