#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerApproveCommand } from './commands/approve.js';
import { registerBoardCommand, type BoardCommandContext } from './commands/board.js';
import { registerConfigCommand, type ConfigCommandContext } from './commands/config.js';
import type { CommandContext, ContextFactory } from './commands/context.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerDoctorCommand, type DoctorContext } from './commands/doctor.js';
import { registerEvidenceCommand } from './commands/evidence.js';
import {
  exitAfterFlush,
  readAllStdin,
  registerGitHookCommand,
  spawnDetachedLogged,
  type GitHookContext,
} from './commands/githook.js';
import { GIT_TIMEOUT_MS, registerHookCommand, type HookContext } from './commands/hook.js';
import { registerInitCommand } from './commands/init.js';
import type { InstallContext, InstallContextFactory } from './commands/install.js';
import { registerReconcileCommand } from './commands/reconcile.js';
import { registerReviewCommand } from './commands/review.js';
import { registerStageCommand } from './commands/stage.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSyncCommand, spawnReplay, type SyncContext } from './commands/sync.js';
import { registerTaskCommand } from './commands/task.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { errorAsJson, formatCliError } from './commands/errors.js';
import { loadConfig, type Config } from './config/schema.js';
import { defaultGhRunner } from './github/gh.js';
import { GitHubTracker } from './github/githubTracker.js';
import { CACHE_DIR, SYNC_LOG_FILE } from './hooks/localLog.js';
import { mainRootOf } from './hooks/resolve.js';
import { nodeRepoFs } from './install/repoFs.js';
import { createGitRunner } from './install/provision.js';
import { isQueueableCommandPath, queueArgvOf } from './outbox/outbox.js';
import { execProgram, findOnPath } from './secrets/gitleaks.js';
import { packageVersion } from './version.js';

const CONFIG_FILE = 'sdlc.config.yaml';

export interface CliDeps {
  /** Builds the context of the commands that run through `runCommand`; defaults to config + `gh`. */
  makeContext?: ContextFactory;
  /** Builds the context of `board`; defaults to config + `gh`. */
  makeBoardContext?: () => BoardCommandContext | Promise<BoardCommandContext>;
  /** Builds the context of `config`, which needs no loadable config; defaults to the git root and `gh`. */
  makeConfigContext?: () => ConfigCommandContext | Promise<ConfigCommandContext>;
  /** Builds the context of `githook`, which loads the config and builds the tracker only if a hook needs them. */
  makeGitHookContext?: () => GitHookContext | Promise<GitHookContext>;
  /** Builds the context of `hook`, which reads the config and builds the tracker only when a rule needs them. */
  makeHookContext?: () => HookContext | Promise<HookContext>;
  /** Builds the context of `sync`, which loads the config only when a gap has to be recorded; defaults to the main checkout, this program and `gh`. */
  makeSyncContext?: () => SyncContext | Promise<SyncContext>;
  /** Builds the context of `init`, `upgrade` and `uninstall`; defaults to the git root, git and `gh`. */
  makeInstallContext?: InstallContextFactory;
  /** Builds the context of `doctor`, which needs no loadable config; defaults to the git root, git, `gh` and the real PATH. */
  makeDoctorContext?: () => DoctorContext | Promise<DoctorContext>;
  /**
   * The command line the program runs with (what follows `sdlc`), which a queued command is replayed
   * from; defaults to the arguments `runCli` was given, else `process.argv`.
   */
  argv?: string[];
  /** Where results go; defaults to stdout. */
  out?: (text: string) => void;
  /** Where errors go; defaults to stderr. */
  err?: (text: string) => void;
}

/** The words that name `command`: `stage publish`. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(' ');
}

const writeLine = (stream: NodeJS.WriteStream) => (text: string) => void stream.write(`${text}\n`);

/** The top-level directory of the git repository containing `cwd`, or `undefined` outside one (or without git). */
function gitRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return root === '' ? undefined : root;
  } catch {
    return undefined;
  }
}

/**
 * The top-level directory of the checkout containing `cwd` and the root of the main checkout, which
 * is the same unless `cwd` is in a linked worktree. The kit's local files (`.sdlc/cache/`) live in the
 * main one. `undefined` outside a repository.
 */
function gitRoots(cwd: string): { root: string; mainRoot: string } | undefined {
  try {
    const [root, commonDir] = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).split(/\r?\n/);
    if (root && commonDir) return { root, mainRoot: mainRootOf({ root, commonDir }) };
  } catch {
    // A git that does not know `--path-format` (before 2.31), or no repository: the plain answer below.
  }
  const root = gitRoot(cwd);
  return root === undefined ? undefined : { root, mainRoot: root };
}

/** The text of a file, `undefined` when there is no such file; any other failure (permissions, a directory) throws. */
function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * Reads the config: `configOption` when given, else `sdlc.config.yaml` in the git root. Runs
 * only when a command needs it, so `--help` and `--version` work anywhere.
 */
function loadEnvironment(
  configOption: string | undefined,
  cwd: string,
): { cfg: Config; repoRoot: string; mainRoot?: string } {
  const roots = gitRoots(cwd);
  if (configOption === undefined && roots === undefined) {
    throw new Error(
      'Not inside a git repository: run sdlc from your repository, or pass the config file with --config <path>',
    );
  }
  const configPath = configOption === undefined ? join(roots?.root as string, CONFIG_FILE) : resolve(cwd, configOption);
  return { cfg: loadConfig(configPath), repoRoot: roots?.root ?? cwd, mainRoot: roots?.mainRoot };
}

export { formatCliError };

/** The `sdlc` command tree. Nothing is read or contacted until a command runs. */
export function buildProgram(deps: CliDeps = {}): Command {
  const out = deps.out ?? writeLine(process.stdout);
  const err = deps.err ?? writeLine(process.stderr);
  const program = new Command()
    .name('sdlc')
    .description('Track agentic SDLC tasks on GitHub Issues and a Projects v2 board')
    .version(packageVersion())
    .option('--config <path>', `config file (default: ${CONFIG_FILE} in the git root)`)
    .option('--json', 'print machine-readable JSON, as --json does on each command');

  const environment = () => loadEnvironment(program.opts<{ config?: string }>().config, process.cwd());
  const makeContext: ContextFactory =
    deps.makeContext ??
    ((): CommandContext => {
      const { cfg, repoRoot, mainRoot } = environment();
      return {
        tracker: new GitHubTracker(defaultGhRunner, cfg, { repoRoot }),
        cfg,
        now: () => new Date().toISOString(),
        out: data => out(typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
        err,
        // Where a command that cannot reach GitHub is queued: outside a repository nothing is.
        ...(mainRoot === undefined ? {} : { repoRoot: mainRoot }),
      };
    });
  const makeBoardContext =
    deps.makeBoardContext ??
    ((): BoardCommandContext => ({ run: defaultGhRunner, config: environment().cfg, out, err }));

  const makeConfigContext =
    deps.makeConfigContext ??
    ((): ConfigCommandContext => {
      // No `loadEnvironment`: `config validate` reports a broken config and `config suggest` creates one.
      const cwd = process.cwd();
      const repoRoot = gitRoot(cwd) ?? cwd;
      const configOption = program.opts<{ config?: string }>().config;
      const configPath = configOption === undefined ? join(repoRoot, CONFIG_FILE) : resolve(cwd, configOption);
      return {
        run: defaultGhRunner,
        repoRoot,
        configPath,
        // Loads the config only when asked, which `config set` does after it has checked the config.
        login: () => new GitHubTracker(defaultGhRunner, loadConfig(configPath), { repoRoot }).authenticatedLogin(),
        out,
        err,
      };
    });

  const makeSyncContext =
    deps.makeSyncContext ??
    ((): SyncContext => {
      const cwd = process.cwd();
      const roots = gitRoots(cwd);
      if (roots === undefined) throw new Error('Not inside a git repository: run sdlc sync from your repository');
      // The same program that runs this command replays the queue, as for the reconcile of the git hook.
      const entry = process.argv[1];
      if (entry === undefined) throw new Error('cannot tell which program is running');
      const now = (): string => new Date().toISOString();
      return {
        repoRoot: roots.mainRoot,
        replay: spawnReplay(entry, roots.mainRoot),
        makeCommandContext: async (): Promise<CommandContext> => {
          const { cfg } = environment();
          return {
            tracker: new GitHubTracker(defaultGhRunner, cfg, { repoRoot: roots.mainRoot }),
            cfg,
            now,
            out: data => out(typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
            err,
            repoRoot: roots.mainRoot,
          };
        },
        now,
        out,
        err,
      };
    });

  const makeInstallContext =
    deps.makeInstallContext ??
    ((): InstallContext => {
      // The config is read by the command's first step, so that a broken one is a reported step.
      const cwd = process.cwd();
      const root = gitRoot(cwd);
      if (root === undefined) {
        throw new Error('Not inside a git repository: run sdlc from the repository you want to install into');
      }
      const configOption = program.opts<{ config?: string }>().config;
      const configPath = configOption === undefined ? join(root, CONFIG_FILE) : resolve(cwd, configOption);
      return {
        fs: nodeRepoFs(root),
        git: createGitRunner(root),
        gh: defaultGhRunner,
        loadConfig: () => loadConfig(configPath),
        out,
        err,
      };
    });

  const makeDoctorContext =
    deps.makeDoctorContext ??
    ((): DoctorContext => {
      // No `loadEnvironment`: `doctor` reports a missing or broken config and a missing repository as checks.
      const cwd = process.cwd();
      const repoRoot = gitRoot(cwd) ?? cwd;
      const configOption = program.opts<{ config?: string }>().config;
      const configPath = configOption === undefined ? join(repoRoot, CONFIG_FILE) : resolve(cwd, configOption);
      return {
        env: {
          run: defaultGhRunner,
          git: createGitRunner(repoRoot),
          fs: nodeRepoFs(repoRoot),
          which: async (command, env = process.env) => findOnPath(command, env) !== undefined,
          exec: (command, args, options) => execProgram(repoRoot, options?.timeoutMs, options?.env)(command, args),
          env: process.env,
          nodeVersion: process.version,
          config: { path: configOption ?? CONFIG_FILE, read: () => readFileIfPresent(configPath) },
        },
        out,
        err,
      };
    });

  const makeGitHookContext =
    deps.makeGitHookContext ??
    ((): GitHookContext => {
      // Git runs a hook in the repository root; nothing here may throw, or git would see a failed hook.
      const cwd = process.cwd();
      const repoRoot = gitRoot(cwd) ?? cwd;
      const configOption = program.opts<{ config?: string }>().config;
      return {
        repoRoot,
        git: createGitRunner(repoRoot),
        exec: execProgram(repoRoot),
        which: command => findOnPath(command, process.env),
        loadConfig: () => environment().cfg,
        makeTracker: cfg => new GitHubTracker(defaultGhRunner, cfg, { repoRoot }),
        readStdin: () => readAllStdin(),
        spawnReconcile: logPath => {
          // The same program that runs this hook, so it works through `sdlc` on the PATH and through npx alike.
          const entry = process.argv[1];
          if (entry === undefined) throw new Error('cannot tell which program is running');
          const config = configOption === undefined ? [] : ['--config', resolve(cwd, configOption)];
          spawnDetachedLogged({ command: process.execPath, args: [entry, ...config, 'reconcile'], cwd: repoRoot, logPath });
        },
        out,
        err,
        exit: code => exitAfterFlush(code),
      };
    });

  const makeHookContext =
    deps.makeHookContext ??
    ((): HookContext => {
      // The repository is the one of the payload's cwd, found by the hook itself; nothing here may throw.
      const cwd = process.cwd();
      const configOption = program.opts<{ config?: string }>().config;
      return {
        cwd,
        readStdin: () => readAllStdin(),
        loadConfig: root => {
          const path = configOption === undefined ? join(root, CONFIG_FILE) : resolve(cwd, configOption);
          return existsSync(path) ? loadConfig(path) : undefined;
        },
        makeTracker: (cfg, root) => new GitHubTracker(defaultGhRunner, cfg, { repoRoot: root }),
        gitFor: dir => createGitRunner(dir, { timeoutMs: GIT_TIMEOUT_MS }),
        now: () => new Date().toISOString(),
        spawnSync: root => {
          // The same program that runs this hook, as for the post-checkout reconcile above.
          const entry = process.argv[1];
          if (entry === undefined) throw new Error('cannot tell which program is running');
          const config = configOption === undefined ? [] : ['--config', resolve(cwd, configOption)];
          spawnDetachedLogged({
            command: process.execPath,
            args: [entry, ...config, 'sync'],
            cwd: root,
            logPath: join(root, ...CACHE_DIR.split('/'), SYNC_LOG_FILE),
          });
        },
        out,
        err,
        exit: code => exitAfterFlush(code),
      };
    });

  // Commander gives `--json` to the program wherever it appears, so hand it on to the command that runs.
  // A command that may be queued also gets the command line to queue (`runCommand` does the queueing).
  program.hook('preAction', (_program, command) => {
    if (program.opts<{ json?: boolean }>().json) command.setOptionValue('json', true);
    if (isQueueableCommandPath(commandPath(command))) {
      // Only a command line sync could run is queued; `undefined` (`--config`, `--dry-run`, ...) keeps the failure as it is.
      const queueArgv = queueArgvOf(deps.argv ?? process.argv.slice(2), process.cwd());
      if (queueArgv !== undefined) command.setOptionValue('queueArgv', queueArgv);
    }
  });

  registerTaskCommand(program, makeContext);
  registerStageCommand(program, makeContext);
  registerEvidenceCommand(program, makeContext);
  registerReviewCommand(program, makeContext);
  registerApproveCommand(program, makeContext);
  registerDeployCommand(program, makeContext);
  registerReconcileCommand(program, makeContext);
  registerStatusCommand(program, makeContext);
  registerSyncCommand(program, makeSyncContext);
  registerBoardCommand(program, makeBoardContext);
  registerConfigCommand(program, makeConfigContext);
  registerGitHookCommand(program, makeGitHookContext);
  registerHookCommand(program, makeHookContext);
  registerInitCommand(program, makeInstallContext);
  registerUpgradeCommand(program, makeInstallContext);
  registerUninstallCommand(program, makeInstallContext);
  registerDoctorCommand(program, makeDoctorContext, { out, err });
  return program;
}

/**
 * Runs the CLI with the arguments after `node sdlc`. Commands that run through `runCommand` report
 * their own failures; anything that still escapes is printed here (as JSON with `--json`) and sets
 * exit code 1.
 */
export async function runCli(args: string[], deps: CliDeps = {}): Promise<void> {
  const out = deps.out ?? writeLine(process.stdout);
  const err = deps.err ?? writeLine(process.stderr);
  const program = buildProgram({ ...deps, argv: deps.argv ?? args });
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    process.exitCode = 1;
    if (program.opts<{ json?: boolean }>().json) out(JSON.stringify(errorAsJson(error), null, 2));
    else err(formatCliError(error));
  }
}

/** Whether this module is the program being run, also when started through a symlink such as an npm bin. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await runCli(process.argv.slice(2));
