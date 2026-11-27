import type { Command } from 'commander';
import type { Config } from '../config/schema.js';
import { ensureBoard } from '../github/board.js';
import type { GhRunner } from '../github/gh.js';
import { applyPlan, formatPlan, planApply, type ApplyPlan, type ApplyResult, type Notice, type PlanError } from '../install/apply.js';
import { MANIFEST_PATH, readManifest } from '../install/manifest.js';
import {
  ensureBranchProtection,
  ensureLabels,
  ensurePushProtection,
  HOOKS_PATH,
  setHooksPath,
  type GitRunner,
} from '../install/provision.js';
import type { RepoFs } from '../install/repoFs.js';
import { renderAll } from '../render/plan.js';
import { packageVersion } from '../version.js';
import { formatEnsureResult } from './board.js';
import { errorAsJson, formatCliError } from './errors.js';

/** What `init`, `upgrade` and `uninstall` need. Only `init` uses `gh`; only `uninstall` can do without the config. */
export interface InstallContext {
  /** The repository the files are written to. */
  fs: RepoFs;
  git: GitRunner;
  gh: GhRunner;
  /** Reads and validates the config; throws when it cannot. Called by `init` and `upgrade`, as their first step. */
  loadConfig: () => Config;
  /** Where the report goes (stdout). */
  out: (text: string) => void;
  /** Where an error that stopped the command before any step went goes (stderr). */
  err: (text: string) => void;
}

export type InstallContextFactory = () => InstallContext | Promise<InstallContext>;

/** `skipped`: nothing to do or not done on purpose (`--skip-github`, a dry run that would have changed something). */
export type StepStatus = 'ok' | 'skipped' | 'failed';

export interface InstallStep {
  name: string;
  status: StepStatus;
  details: string[];
}

export interface WriteSummary {
  path: string;
  action: 'create' | 'update' | 'remove';
}

/** The report of the three commands, and what `--json` prints. */
export interface InstallReport {
  steps: InstallStep[];
  plan: { writes: WriteSummary[]; notices: Notice[]; errors: PlanError[] };
}

const lines = (text: string): string[] => text.split('\n');
const byPath = (a: WriteSummary, b: WriteSummary): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Collects the steps. A person sees each one as soon as it is done; `--json` prints one document at the end. */
export class Reporter {
  readonly steps: InstallStep[] = [];
  plan: InstallReport['plan'] = { writes: [], notices: [], errors: [] };

  constructor(
    private readonly ctx: InstallContext,
    private readonly json: boolean,
  ) {}

  step(name: string, status: StepStatus, details: string[] = []): void {
    this.steps.push({ name, status, details });
    if (!this.json) this.ctx.out([`[${status}] ${name}`, ...details.map(line => `  ${line}`)].join('\n'));
  }

  /** Runs one step: `run` adds its details and returns its status; a throw is a failed step. */
  async guarded(name: string, run: (details: string[]) => Promise<StepStatus> | StepStatus): Promise<void> {
    const details: string[] = [];
    try {
      this.step(name, await run(details), details);
    } catch (error) {
      this.step(name, 'failed', [...details, ...lines(formatCliError(error))]);
    }
  }

  /** Prints the JSON document, and makes the exit code 1 when a step failed. */
  finish(): InstallReport {
    const report: InstallReport = { steps: this.steps, plan: this.plan };
    if (this.steps.some(step => step.status === 'failed')) process.exitCode = 1;
    if (this.json) this.ctx.out(JSON.stringify(report, null, 2));
    return report;
  }
}

/** Step 1: the config must load, with its MCP server ids; nothing else runs without it. */
export function validateConfig(ctx: InstallContext, report: Reporter): Config | undefined {
  try {
    const cfg = ctx.loadConfig();
    report.step('config', 'ok', [`${cfg.github.repo}: harnesses ${cfg.harnesses.join(', ')}, mode ${cfg.mode}`]);
    return cfg;
  } catch (error) {
    report.step('config', 'failed', lines(formatCliError(error)));
    return undefined;
  }
}

/** The writes of a plan as a person sees them; with `removeObsolete`, the files and keys that are no longer generated too. */
function plannedWrites(plan: ApplyPlan, removeObsolete: boolean): WriteSummary[] {
  const writes: WriteSummary[] = plan.writes.filter(w => w.path !== MANIFEST_PATH).map(w => ({ path: w.path, action: w.action }));
  if (removeObsolete) {
    for (const entry of plan.obsolete) {
      const action = entry.kind === 'file' ? 'remove' : 'update';
      if (!writes.some(w => w.path === entry.path && w.action === action)) writes.push({ path: entry.path, action });
    }
  }
  return writes.sort(byPath);
}

/** What an applied plan did: the files written and removed, without the manifest. */
function appliedWrites(plan: ApplyPlan, result: ApplyResult): WriteSummary[] {
  const planned = new Map(plan.writes.map(write => [write.path, write.action]));
  const writes: WriteSummary[] = [
    ...result.written.map((path): WriteSummary => ({ path, action: planned.get(path) === 'create' ? 'create' : 'update' })),
    ...result.removed.map((path): WriteSummary => ({ path, action: 'remove' })),
  ];
  return writes.filter((w, i) => writes.findIndex(other => other.path === w.path) === i).sort(byPath);
}

/**
 * Prints a plan, applies it unless `dryRun`, and files the outcome with the report. The step is
 * `failed` for any error, `skipped` for a dry run that would have written something, else `ok`.
 * `leading` lines go first in the step's details.
 */
export function reportPlan(
  report: Reporter,
  name: string,
  plan: ApplyPlan,
  fs: RepoFs,
  options: { dryRun: boolean; removeObsolete: boolean; leading?: string[] },
): void {
  const { dryRun, removeObsolete } = options;
  // Applying adds the notices and errors found on the way (obsolete entries, failed writes) to the plan's own.
  const result = dryRun ? undefined : applyPlan(plan, fs, { removeObsolete });
  const notices = result?.notices ?? plan.notices;
  const errors = result?.errors ?? plan.errors;
  const writes = result ? appliedWrites(plan, result) : plannedWrites(plan, removeObsolete);
  report.plan = { writes, notices, errors };
  const status: StepStatus = errors.length > 0 ? 'failed' : dryRun && writes.length > 0 ? 'skipped' : 'ok';
  report.step(name, status, [...(options.leading ?? []), ...lines(formatPlan({ ...plan, notices, errors }, dryRun, { removeObsolete }))]);
}

/**
 * Step 2 of `init` and `upgrade`: render everything for `cfg`, plan it against the manifest, print
 * the plan and apply it unless `dryRun`. Returns what the owner still has to do. A failure to render
 * or to read the manifest is a failed step, not an exception.
 */
export function installFiles(
  ctx: InstallContext,
  cfg: Config,
  report: Reporter,
  options: { dryRun: boolean; overwriteModified: boolean; removeObsolete: boolean; showKit: boolean },
): { userCommands: string[]; notes: string[] } {
  try {
    const manifest = readManifest(ctx.fs);
    const { changes, userCommands, notes } = renderAll(cfg, ctx.fs);
    const plan = planApply(changes, ctx.fs, manifest, { overwriteModified: options.overwriteModified });
    reportPlan(report, 'files', plan, ctx.fs, {
      dryRun: options.dryRun,
      removeObsolete: options.removeObsolete,
      ...(options.showKit ? { leading: [`kit ${manifest?.kit ?? 'none'} → ${packageVersion()}`] } : {}),
    });
    return { userCommands, notes };
  } catch (error) {
    report.step('files', 'failed', lines(formatCliError(error)));
    return { userCommands: [], notes: [] };
  }
}

/** Step 3: point `core.hooksPath` at the kit's hooks, unless the owner has set it to something else. */
export function installHooksPath(ctx: InstallContext, report: Reporter, dryRun: boolean): Promise<void> {
  return report.guarded('git hooks path', async details => {
    const notices: string[] = [];
    const result = await setHooksPath(ctx.git, { dryRun, notice: message => notices.push(message) });
    details.push(...notices);
    switch (result) {
      case 'set':
        details.push(dryRun ? `dry run: would set core.hooksPath to ${HOOKS_PATH}` : `core.hooksPath set to ${HOOKS_PATH}`);
        return dryRun ? 'skipped' : 'ok';
      case 'already':
        details.push(`core.hooksPath is already ${HOOKS_PATH}`);
        return 'ok';
      case 'conflict':
        return 'skipped';
    }
  });
}

export interface InitOptions {
  dryRun?: boolean;
  overwriteModified?: boolean;
  skipGithub?: boolean;
  json?: boolean;
}

const GITHUB_STEPS = ['board', 'labels', 'branch protection', 'push protection'] as const;

/** A provisioning step that a dry run only described did not change anything; one that found nothing to do is `ok`. */
const statusOf = (dryRun: boolean, wouldChange: boolean): StepStatus => (dryRun && wouldChange ? 'skipped' : 'ok');

async function provisionGithub(ctx: InstallContext, cfg: Config, report: Reporter, dryRun: boolean): Promise<void> {
  await report.guarded('board', async details => {
    const result = await ensureBoard(ctx.gh, cfg, {
      dryRun,
      // Said at once, and kept in the details even when a later write fails: this is the number to put in the config.
      onProjectCreated: project =>
        details.push(
          `Created project #${project.number}${project.url ? ` (${project.url})` : ''}; ` +
            `set github.project.number: ${project.number} in sdlc.config.yaml (init never edits your config) ` +
            'before running init again, or a second project will be created',
        ),
    });
    details.push(...lines(formatEnsureResult(result, dryRun)));
    if (result.viewsFailed.length > 0) return 'failed';
    const wouldChange =
      result.wouldCreateProject || result.plan.createFields.length > 0 || result.plan.addOptions.length > 0 || result.viewsPlanned.length > 0;
    return statusOf(dryRun, wouldChange);
  });

  await report.guarded('labels', async details => {
    const { created, existing } = await ensureLabels(ctx.gh, cfg, { dryRun });
    if (created.length > 0) details.push(`${dryRun ? 'dry run: would create' : 'created'} labels: ${created.join(', ')}`);
    if (existing.length > 0) details.push(`already there: ${existing.join(', ')}`);
    return statusOf(dryRun, created.length > 0);
  });

  await report.guarded('branch protection', async details => {
    const result = await ensureBranchProtection(ctx.gh, cfg, { dryRun });
    details.push(result.message);
    if (result.status === 'skipped' || result.status === 'unavailable') return 'skipped';
    return statusOf(dryRun, result.status === 'created');
  });

  await report.guarded('push protection', async details => {
    const result = await ensurePushProtection(ctx.gh, cfg, { dryRun });
    details.push(result.message);
    if (result.status === 'unavailable') return 'skipped';
    return statusOf(dryRun, result.status === 'enabled');
  });
}

/** Step 5: what the owner does next, and what the install could not do for them. */
function nextSteps(report: Reporter, cfg: Config, rendered: { userCommands: string[]; notes: string[] }, dryRun: boolean): void {
  report.step('next steps', 'ok', [
    ...rendered.userCommands.map(command => `run yourself: ${command}`),
    ...rendered.notes.map(note => `note: ${note}`),
    ...(dryRun
      ? ['next: rerun without --dry-run to apply this plan']
      : [
          'next: commit the changes on a branch and open the install PR "chore: install agentic-sdlc-kit"',
          'next: run sdlc doctor',
          ...(cfg.stack.actions ? ['next: add the SDLC_TOKEN secret: gh secret set SDLC_TOKEN'] : []),
        ]),
  ]);
}

/**
 * `sdlc init`: validate the config, write the managed files, point git at the hooks, then (unless
 * `skipGithub`) provision the board, labels, branch protection and push protection. Commits
 * nothing. The exit code is 1 when a step failed; an invalid config stops everything, any other
 * failure leaves the later steps to run.
 */
export async function runInit(ctx: InstallContext, options: InitOptions): Promise<InstallReport> {
  const dryRun = options.dryRun === true;
  const report = new Reporter(ctx, options.json === true);
  const cfg = validateConfig(ctx, report);
  if (cfg === undefined) return report.finish();

  const rendered = installFiles(ctx, cfg, report, {
    dryRun,
    overwriteModified: options.overwriteModified === true,
    removeObsolete: false,
    showKit: false,
  });
  await installHooksPath(ctx, report, dryRun);
  if (options.skipGithub === true) {
    for (const name of GITHUB_STEPS) report.step(name, 'skipped', ['--skip-github']);
  } else {
    await provisionGithub(ctx, cfg, report, dryRun);
  }
  nextSteps(report, cfg, rendered, dryRun);
  return report.finish();
}

/**
 * Runs one install command: builds the context, runs `run`, and reports a failure that stopped it
 * before any step (no git repository, ...) the way the other commands do: on stderr, or as
 * `{"error": ...}` with `--json`, and exit code 1. It never rejects.
 */
export async function runInstallAction(
  makeContext: InstallContextFactory,
  options: { json?: boolean },
  run: (ctx: InstallContext) => Promise<unknown>,
): Promise<void> {
  let ctx: InstallContext | undefined;
  try {
    ctx = await makeContext();
    await run(ctx);
  } catch (error) {
    process.exitCode = 1;
    if (options.json) (ctx?.out ?? (text => void process.stdout.write(`${text}\n`)))(JSON.stringify(errorAsJson(error), null, 2));
    else (ctx?.err ?? (text => void process.stderr.write(`${text}\n`)))(formatCliError(error));
  }
}

/** Registers `sdlc init [--dry-run] [--overwrite-modified] [--skip-github] [--json]`; `--config` is the program's. */
export function registerInitCommand(program: Command, makeContext: InstallContextFactory): void {
  program
    .command('init')
    .description('Install the managed files, git hooks and GitHub setup for sdlc.config.yaml; commits nothing')
    .option('--dry-run', 'print the plan and what GitHub would get; change nothing')
    .option('--overwrite-modified', 'also replace managed files and blocks that were edited by hand')
    .option('--skip-github', 'leave GitHub alone: no board, labels, branch protection or push protection')
    .option('--json', 'print machine-readable JSON')
    .action((options: InitOptions) => runInstallAction(makeContext, options, ctx => runInit(ctx, options)));
}
