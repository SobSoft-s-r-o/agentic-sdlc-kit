import { existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { ConfigValidationError, loadConfig } from '../config/schema.js';
import type { GhRunner } from '../github/gh.js';
import { detectConfig, probeRepo } from '../install/detect.js';
import { errorAsJson, formatCliError } from './errors.js';

/**
 * What the `config` commands need. They work without a loadable config (that is what they are for),
 * so this is not a `CommandContext`: no tracker and no parsed config.
 */
export interface ConfigCommandContext {
  run: GhRunner;
  /** Where the repository's files are read from (`probeRepo`). */
  repoRoot: string;
  /** The config file `validate` reads and `suggest --write` creates. */
  configPath: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

export type ConfigContextFactory = () => ConfigCommandContext | Promise<ConfigCommandContext>;

const printLine = (stream: NodeJS.WriteStream) => (text: string) => void stream.write(`${text}\n`);

/** Runs one action; any failure is printed (as `{"error": ...}` through `out` with `--json`) and sets exit code 1. */
async function runConfigAction(
  makeContext: ConfigContextFactory,
  options: { json?: boolean },
  action: (ctx: ConfigCommandContext) => Promise<void>,
): Promise<void> {
  let ctx: ConfigCommandContext | undefined;
  try {
    ctx = await makeContext();
    await action(ctx);
  } catch (error) {
    process.exitCode = 1;
    if (options.json) (ctx?.out ?? printLine(process.stdout))(JSON.stringify(errorAsJson(error), null, 2));
    else (ctx?.err ?? printLine(process.stderr))(formatCliError(error));
  }
}

/** `sdlc config validate`: `Config OK`, or the issues with exit code 1. Reads no GitHub. */
async function validate(ctx: ConfigCommandContext, options: { json?: boolean }): Promise<void> {
  try {
    loadConfig(ctx.configPath);
  } catch (error) {
    if (options.json && error instanceof ConfigValidationError) {
      process.exitCode = 1;
      ctx.out(JSON.stringify({ ok: false, error: error.message, issues: error.issues }, null, 2));
      return;
    }
    throw error;
  }
  ctx.out(options.json ? JSON.stringify({ ok: true, path: ctx.configPath }, null, 2) : 'Config OK');
}

/**
 * `sdlc config suggest [--write]`: the YAML on stdout, so it can be redirected; notes and progress
 * go to stderr. `--write` creates the config file only when it does not exist yet.
 */
async function suggest(
  ctx: ConfigCommandContext,
  options: { write?: boolean; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const write = options.write === true;
  const dryRun = options.dryRun === true;
  const name = basename(ctx.configPath);
  const exists = new Error(`${name} exists; edit it instead`);
  // Checked before asking GitHub anything: there is nothing to do.
  if (write && existsSync(ctx.configPath)) throw exists;

  const { yaml, notes } = detectConfig(await probeRepo(ctx.run, ctx.repoRoot));

  let written = false;
  if (write && !dryRun) {
    try {
      // `wx` fails if the file appeared meanwhile: an existing config is never overwritten.
      writeFileSync(ctx.configPath, yaml, { flag: 'wx' });
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? exists : error;
    }
    written = true;
  }

  if (options.json) {
    ctx.out(JSON.stringify({ yaml, notes, written, dryRun, path: ctx.configPath }, null, 2));
    return;
  }
  ctx.out(yaml.trimEnd());
  for (const note of notes) ctx.err(`note: ${note}`);
  if (write) ctx.err(written ? `Wrote ${name}` : `Would write ${name}`);
}

/** Registers `sdlc config validate` and `sdlc config suggest`. */
export function registerConfigCommand(program: Command, makeContext: ConfigContextFactory): void {
  const config = program.command('config').description('Check or suggest sdlc.config.yaml');
  config
    .command('validate')
    .description('Check sdlc.config.yaml; prints "Config OK" or the issues (exit 1)')
    .option('--json', 'print machine-readable JSON')
    .action((options: { json?: boolean }) =>
      runConfigAction(makeContext, options, ctx => validate(ctx, options)),
    );
  config
    .command('suggest')
    .description('Print a sdlc.config.yaml suggested from this repository')
    .option('--write', 'write sdlc.config.yaml (only when it does not exist yet)')
    .option('--dry-run', 'with --write: report what would be written, write nothing')
    .option('--json', 'print machine-readable JSON')
    .action((options: { write?: boolean; dryRun?: boolean; json?: boolean }) =>
      runConfigAction(makeContext, options, ctx => suggest(ctx, options)),
    );
}
