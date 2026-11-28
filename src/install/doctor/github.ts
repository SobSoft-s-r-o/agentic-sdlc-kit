import type { Config } from '../../config/schema.js';
import { ensureBoard } from '../../github/board.js';
import { GhError, ghJson } from '../../github/gh.js';
import { WORKFLOW_PATH } from '../../render/github.js';
import { KIT_GIT_URL } from '../../render/instructions.js';
import { ensureLabels } from '../provision.js';
import { describeError, printable, ok, warn, fail, ghReason, failure, list, type Check, type DoctorEnv } from './types.js';

/** The GitHub side of an installed repository: `kit_ref`, board, labels, the Actions workflow and its secret. */

const KIT_REF_TIMEOUT_MS = 15_000;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/** `kit_ref` must exist in the kit's repository: every generated `npx -y github:...#<kit_ref>` command fails otherwise. Network trouble is "cannot verify". */
export async function checkKitRef(env: DoctorEnv, cfg: Config): Promise<Check> {
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
