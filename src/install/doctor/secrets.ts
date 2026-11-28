import type { Config } from '../../config/schema.js';
import { GhError } from '../../github/gh.js';
import { scanFileName } from '../../secrets/scan.js';
import { HOOKS_PATH, readPushProtection } from '../provision.js';
import { hooksActive, type Hooks } from './files.js';
import { describeError, printable, ok, warn, fail, ghReason, list, type Check, type DoctorEnv } from './types.js';

/** The secret guard, push protection, tracked secret files and the approval trust settings. */

/** Inactive when the hooks path is wrong or `sdlc` is missing; failing to read the hooks path is "cannot verify" (still a fail), not a wrong path. */
export function checkSecretGuard(hooks: Hooks, sdlcResolvable: boolean): Check {
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

export async function checkPushProtection(env: DoctorEnv, cfg: Config): Promise<Check> {
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
export async function checkTrackedFiles(env: DoctorEnv, cfg: Config): Promise<Check> {
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

export function checkApprovalTrust(cfg: Config): Check {
  const id = 'approvals.trust';
  if (cfg.mode === 'enforce' && cfg.stack.actions && cfg.agents.length === 0) {
    return warn(
      id,
      "comment approvals from the Actions token's login are ignored in enforce mode; run agents under a separate account listed in agents (see INSTALL.md)",
    );
  }
  return ok(id, 'the approval trust settings are consistent');
}
