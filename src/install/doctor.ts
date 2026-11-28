import { loadConfigFromString, type Config } from '../config/schema.js';
import { HOOK_HARNESSES } from '../hooks/types.js';
import { readManifest, type Manifest } from './manifest.js';
import { readHooks, checkManifest, checkManagedFiles, checkGitVersion, checkHooksPath, checkSdlcOnPath, checkLegacyHooks } from './doctor/files.js';
import { checkKitRef, checkBoard, checkLabels, checkWorkflow, checkActionsSecret } from './doctor/github.js';
import { launcherState, checkHooksOf, checkHookSwitches, checkRoundTrip } from './doctor/hooks.js';
import { worktreeLister, checkOutbox, checkWorktreeOrphans } from './doctor/local.js';
import { ghBlocker, runPreflight } from './doctor/preflight.js';
import { checkSecretGuard, checkPushProtection, checkTrackedFiles, checkApprovalTrust } from './doctor/secrets.js';
import { checkMcpToken, checkMcpHarness, checkSuperpowers, checkGraphify } from './doctor/stack.js';
import { describeError, printable, ok, fail, notChecked, isolated, type Check, type DoctorEnv } from './doctor/types.js';

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
