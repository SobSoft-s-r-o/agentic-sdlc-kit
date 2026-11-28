import { envKey, pathDelimiter } from '../../secrets/gitleaks.js';
import { MANIFEST_PATH, entryDiskHash, type Manifest, type ManifestEntry } from '../manifest.js';
import { HOOKS_PATH, findLegacyHooks, normalizeHooksPath, readHooksPath, type GitRunner } from '../provision.js';
import type { RepoFs } from '../repoFs.js';
import { describeError, printable, ok, warn, fail, notChecked, failure, list, type Check, type DoctorEnv } from './types.js';

/** Managed files and git: the manifest, the git version and hooks path, `sdlc` on the PATH and the repository's own hooks. */

export type Hooks = { value: string | undefined } | { error: unknown };

export async function readHooks(git: GitRunner): Promise<Hooks> {
  try {
    return { value: await readHooksPath(git) };
  } catch (error) {
    return { error };
  }
}

export const hooksActive = (hooks: Hooks): boolean => 'value' in hooks && hooks.value !== undefined && normalizeHooksPath(hooks.value) === HOOKS_PATH;

export function checkManifest(manifest: Manifest | undefined, problem: string | undefined): Check {
  const id = 'manifest.present';
  if (problem !== undefined) return fail(id, problem, 'fix or remove the manifest, then run sdlc init');
  if (manifest === undefined) return fail(id, `${MANIFEST_PATH} not found: the kit is not installed here`, 'sdlc init');
  return ok(id, `${MANIFEST_PATH}: ${manifest.entries.length} managed entries, written by sdlc ${printable(manifest.kit)}`);
}

const entryLabel = (entry: ManifestEntry): string => printable(entry.key === undefined ? entry.path : `${entry.path} (${entry.key})`);

/** Every manifest entry present on disk and matching its hash; a region that cannot be read (damaged markers, invalid JSON) counts as modified. */
export function checkManagedFiles(fs: RepoFs, manifest: Manifest | undefined): Check {
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

export async function checkGitVersion(env: DoctorEnv): Promise<Check> {
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

export function checkHooksPath(hooks: Hooks): Check {
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
export async function checkSdlcOnPath(env: DoctorEnv): Promise<Check> {
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
export async function checkLegacyHooks(env: DoctorEnv, hooks: Hooks): Promise<Check> {
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
