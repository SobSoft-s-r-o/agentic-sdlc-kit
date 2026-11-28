import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { ConfigValidationError, loadConfig } from '../config/schema.js';
import { setConfigMode, type ConfigMode } from '../config/write.js';
import { includesLogin, isOwner } from '../core/approvals.js';
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
  /** The config file `validate` reads, `suggest --write` creates and `set` edits. */
  configPath: string;
  /** The GitHub login the tool runs as; `undefined` when GitHub cannot say (see `authenticatedLogin`). */
  login: () => Promise<string | undefined>;
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

const SETTABLE_MODES: readonly ConfigMode[] = ['observe', 'enforce'];

/** Each checkout reads the mode from its own copy of the config, so a change reaches a task worktree only through git. */
const PER_CHECKOUT_NOTE =
  'Commit and push sdlc.config.yaml: existing task worktrees and new ones read the mode from their own checkout.';

/**
 * `sdlc config set mode <observe|enforce> [--dry-run]`: owners only. Edits the one line in
 * `sdlc.config.yaml`, so its comments and layout stay. A config that does not load is refused with
 * the usual load error (this command does not repair one).
 */
async function setMode(
  ctx: ConfigCommandContext,
  key: string,
  value: string,
  options: { dryRun?: boolean; json?: boolean },
): Promise<void> {
  if (key !== 'mode') throw new Error('only "mode" can be set');
  if (!SETTABLE_MODES.includes(value as ConfigMode)) {
    throw new Error(`mode must be observe or enforce, got "${value}"`);
  }
  const mode = value as ConfigMode;
  const cfg = loadConfig(ctx.configPath);

  const login = await ctx.login();
  if (login === undefined) throw new Error("cannot confirm the owner's GitHub login; run gh auth login");
  if (includesLogin(cfg.agents, login)) {
    throw new Error(`config set must be run by an owner; ${login} is listed in agents`);
  }
  if (!isOwner(cfg.owners, login)) {
    throw new Error(`config set must be run by an owner (owners: ${cfg.owners.join(', ')})`);
  }

  const dryRun = options.dryRun === true;
  const changed = cfg.mode !== mode;
  const written = changed && !dryRun;
  if (written) {
    writeFileSync(ctx.configPath, setConfigMode(readFileSync(ctx.configPath, 'utf8'), mode).text);
  }
  if (options.json) {
    ctx.out(
      JSON.stringify(
        { mode, previous: cfg.mode, changed: written, dryRun, path: ctx.configPath, ...(written ? { note: PER_CHECKOUT_NOTE } : {}) },
        null,
        2,
      ),
    );
  } else if (!changed) {
    ctx.out(`mode is already ${mode}`);
  } else if (dryRun) {
    ctx.out(`mode: ${cfg.mode} -> ${mode} (dry run: nothing written)`);
  } else {
    ctx.out(`mode: ${cfg.mode} -> ${mode}. Run \`sdlc upgrade\` so the instructions and hooks match.`);
    ctx.out(PER_CHECKOUT_NOTE);
  }
}

/** Registers `sdlc config validate`, `sdlc config suggest` and `sdlc config set`. */
export function registerConfigCommand(program: Command, makeContext: ConfigContextFactory): void {
  const config = program.command('config').description('Check, suggest or change sdlc.config.yaml');
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
  config
    .command('set')
    .description('Set a config value (owners only; only "mode" can be set): sdlc config set mode <observe|enforce>')
    .argument('<key>', 'the setting to change; only "mode"')
    .argument('<value>', 'observe or enforce')
    .option('--dry-run', 'report the change, write nothing')
    .option('--json', 'print machine-readable JSON')
    .action((key: string, value: string, options: { dryRun?: boolean; json?: boolean }) =>
      runConfigAction(makeContext, options, ctx => setMode(ctx, key, value, options)),
    );
}
