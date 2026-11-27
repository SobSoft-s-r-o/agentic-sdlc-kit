import type { Command } from 'commander';
import type { Config } from '../config/schema.js';
import { ensureBoard } from '../github/board.js';
import { ensureBranchProtection, ensureLabels, ensurePushProtection } from '../install/provision.js';
import { formatEnsureResult } from './board.js';
import {
  Reporter,
  installFiles,
  installHooksPath,
  lines,
  runInstallAction,
  validateConfig,
  type InstallContext,
  type InstallContextFactory,
  type InstallReport,
  type StepStatus,
} from './install.js';

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
