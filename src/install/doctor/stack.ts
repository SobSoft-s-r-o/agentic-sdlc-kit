import type { Config } from '../../config/schema.js';
import type { HookHarness } from '../../hooks/types.js';
import { mcpEnvVars } from '../../render/mcp.js';
import { mcpListArgs, mcpNames, superpowersInstall, superpowersInstalled, superpowersListArgs, graphifyInstall } from '../stack.js';
import { hookEnvironment } from './files.js';
import type { WorktreeList } from './local.js';
import { describeError, printable, ok, warn, failure, cliHarnesses, type Check, type DoctorEnv } from './types.js';

/** The MCP token and the harness CLIs: MCP servers, Superpowers and graphify. */

/** Names only: whether each variable the configured MCP servers read is set, never what it holds. */
export function checkMcpToken(env: DoctorEnv, cfg: Config): Check {
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
export async function checkMcpHarness(env: DoctorEnv, cfg: Config, harness: HookHarness): Promise<Check> {
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
export async function checkSuperpowers(env: DoctorEnv, cfg: Config, worktrees: () => Promise<WorktreeList>): Promise<Check> {
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
export async function checkGraphify(env: DoctorEnv, cfg: Config): Promise<Check> {
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
