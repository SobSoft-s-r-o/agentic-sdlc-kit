#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerApproveCommand } from './commands/approve.js';
import { registerBoardCommand, type BoardCommandContext } from './commands/board.js';
import type { CommandContext, ContextFactory } from './commands/context.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerEvidenceCommand } from './commands/evidence.js';
import { registerReconcileCommand } from './commands/reconcile.js';
import { registerReviewCommand } from './commands/review.js';
import { registerStageCommand } from './commands/stage.js';
import { registerStatusCommand } from './commands/status.js';
import { registerTaskCommand } from './commands/task.js';
import { loadConfig, type Config } from './config/schema.js';
import { defaultGhRunner, GhError } from './github/gh.js';
import { GitHubTracker } from './github/githubTracker.js';

const CONFIG_FILE = 'sdlc.config.yaml';

export interface CliDeps {
  /** Builds the context of the commands that run through `runCommand`; defaults to config + `gh`. */
  makeContext?: ContextFactory;
  /** Builds the context of `board`; defaults to config + `gh`. */
  makeBoardContext?: () => BoardCommandContext | Promise<BoardCommandContext>;
  /** Where results go; defaults to stdout. */
  out?: (text: string) => void;
  /** Where errors go; defaults to stderr. */
  err?: (text: string) => void;
}

const writeLine = (stream: NodeJS.WriteStream) => (text: string) => void stream.write(`${text}\n`);

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: string;
  };
  return manifest.version ?? '0.0.0';
}

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
 * Reads the config: `configOption` when given, else `sdlc.config.yaml` in the git root. Runs
 * only when a command needs it, so `--help` and `--version` work anywhere.
 */
function loadEnvironment(configOption: string | undefined, cwd: string): { cfg: Config; repoRoot: string } {
  const root = gitRoot(cwd);
  if (configOption === undefined && root === undefined) {
    throw new Error(
      'Not inside a git repository: run sdlc from your repository, or pass the config file with --config <path>',
    );
  }
  const configPath = configOption === undefined ? join(root as string, CONFIG_FILE) : resolve(cwd, configOption);
  return { cfg: loadConfig(configPath), repoRoot: root ?? cwd };
}

/** The text a failed run prints: the message, and for a failed `gh` call also its arguments and stderr. */
export function formatCliError(error: unknown): string {
  if (error instanceof GhError) {
    return [
      error.message,
      `  command: gh ${error.args.join(' ')}`,
      `  stderr: ${error.stderr.trim() || '(no error output)'}`,
    ].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function errorAsJson(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof GhError ? { error: message, args: error.args, stderr: error.stderr } : { error: message };
}

/** The `sdlc` command tree. Nothing is read or contacted until a command runs. */
export function buildProgram(deps: CliDeps = {}): Command {
  const out = deps.out ?? writeLine(process.stdout);
  const err = deps.err ?? writeLine(process.stderr);
  const program = new Command()
    .name('sdlc')
    .description('Track agentic SDLC tasks on GitHub Issues and a Projects v2 board')
    .version(readVersion())
    .option('--config <path>', `config file (default: ${CONFIG_FILE} in the git root)`)
    .option('--json', 'print machine-readable JSON, as --json does on each command');

  const environment = () => loadEnvironment(program.opts<{ config?: string }>().config, process.cwd());
  const makeContext: ContextFactory =
    deps.makeContext ??
    ((): CommandContext => {
      const { cfg, repoRoot } = environment();
      return {
        tracker: new GitHubTracker(defaultGhRunner, cfg, { repoRoot }),
        cfg,
        now: () => new Date().toISOString(),
        out: data => out(typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
        err,
      };
    });
  const makeBoardContext =
    deps.makeBoardContext ??
    ((): BoardCommandContext => ({ run: defaultGhRunner, config: environment().cfg, out, err }));

  // Commander gives `--json` to the program wherever it appears, so hand it on to the command that runs.
  program.hook('preAction', (_program, command) => {
    if (program.opts<{ json?: boolean }>().json) command.setOptionValue('json', true);
  });

  registerTaskCommand(program, makeContext);
  registerStageCommand(program, makeContext);
  registerEvidenceCommand(program, makeContext);
  registerReviewCommand(program, makeContext);
  registerApproveCommand(program, makeContext);
  registerDeployCommand(program, makeContext);
  registerReconcileCommand(program, makeContext);
  registerStatusCommand(program, makeContext);
  registerBoardCommand(program, makeBoardContext);
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
  const program = buildProgram(deps);
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
