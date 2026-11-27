import type { Command } from 'commander';
import { applyPlan, formatPlan, planUninstall } from '../install/apply.js';
import { MANIFEST_PATH, readManifest } from '../install/manifest.js';
import { HOOKS_PATH, normalizeHooksPath } from '../install/provision.js';
import {
  Reporter,
  runInstallAction,
  type InstallContext,
  type InstallContextFactory,
  type InstallReport,
  type StepStatus,
  type WriteSummary,
} from './init.js';
import { formatCliError } from './errors.js';

export interface UninstallOptions {
  dryRun?: boolean;
  json?: boolean;
}

/** What uninstall never removes, as `sdlc init` and the owner left it. */
const USER_OWNED: Array<{ path: string; what: string; directory: boolean }> = [
  { path: 'sdlc.config.yaml', what: 'your config', directory: false },
  { path: '.sdlc/agents/custom', what: 'your custom roles', directory: true },
  { path: '.sdlc/cache', what: 'the local cache', directory: true },
];

const GITHUB_REMAINS =
  'GitHub was not touched: the board, labels and issues remain, and so do branch protection and secret scanning';

/** The files step: remove what the manifest says the kit wrote, keeping whatever was edited. */
function uninstallFiles(ctx: InstallContext, report: Reporter, dryRun: boolean): void {
  try {
    const manifest = readManifest(ctx.fs);
    if (manifest === undefined) {
      report.step('files', 'skipped', [`nothing to remove: ${MANIFEST_PATH} does not exist`]);
      return;
    }
    const plan = planUninstall(ctx.fs, manifest);
    const result = dryRun ? undefined : applyPlan(plan, ctx.fs, { removeObsolete: false });
    const notices = result?.notices ?? plan.notices;
    const errors = result?.errors ?? plan.errors;
    const writes: WriteSummary[] = result
      ? result.removed.map(path => ({ path, action: 'remove' }))
      : plan.writes.filter(w => w.path !== MANIFEST_PATH).map(w => ({ path: w.path, action: w.action }));
    report.plan = { writes, notices, errors };
    const status: StepStatus = errors.length > 0 ? 'failed' : dryRun && writes.length > 0 ? 'skipped' : 'ok';
    report.step('files', status, formatPlan({ ...plan, notices, errors }, dryRun).split('\n'));
  } catch (error) {
    report.step('files', 'failed', formatCliError(error).split('\n'));
  }
}

/** Unsets `core.hooksPath` when it is the kit's hooks directory, and only then. */
function uninstallHooksPath(ctx: InstallContext, report: Reporter, dryRun: boolean): Promise<void> {
  return report.guarded('git hooks path', async details => {
    const read = await ctx.git(['config', '--get', 'core.hooksPath']);
    if (read.code !== 0 && !(read.code === 1 && read.stdout.trim() === '')) {
      throw new Error(`git config --get core.hooksPath failed: ${read.stderr.trim() || `exit code ${read.code}`}`);
    }
    const current = read.code === 0 ? read.stdout.trim() : '';
    if (current === '') {
      details.push('core.hooksPath is not set; nothing to unset');
      return 'ok';
    }
    if (normalizeHooksPath(current) !== HOOKS_PATH) {
      details.push(`core.hooksPath is "${current}", not ${HOOKS_PATH}; left alone`);
      return 'ok';
    }
    if (dryRun) {
      details.push(`dry run: would unset core.hooksPath (it is ${HOOKS_PATH})`);
      return 'skipped';
    }
    const unset = await ctx.git(['config', '--unset', 'core.hooksPath']);
    if (unset.code !== 0) {
      throw new Error(`git config --unset core.hooksPath failed: ${unset.stderr.trim() || `exit code ${unset.code}`}`);
    }
    details.push(`unset core.hooksPath (it was ${HOOKS_PATH})`);
    return 'ok';
  });
}

/** What stays: the user-owned files that exist, the managed files that were edited, and all of GitHub. */
function reportKept(ctx: InstallContext, report: Reporter): void {
  const details: string[] = [];
  for (const { path, what, directory } of USER_OWNED) {
    const exists = directory ? ctx.fs.list(path, 1).length > 0 : ctx.fs.read(path) !== undefined;
    if (exists) details.push(`${path}: ${what}`);
  }
  for (const notice of report.plan.notices) details.push(`${notice.path}: ${notice.message}`);
  details.push(GITHUB_REMAINS);
  report.step('kept', 'ok', details);
}

/**
 * `sdlc uninstall`: remove what the manifest says the kit wrote (regions the owner edited are kept),
 * unset `core.hooksPath` if it is the kit's, and say what stays. Needs no config. Never touches
 * GitHub.
 */
export async function runUninstall(ctx: InstallContext, options: UninstallOptions): Promise<InstallReport> {
  const dryRun = options.dryRun === true;
  const report = new Reporter(ctx, options.json === true);
  uninstallFiles(ctx, report, dryRun);
  await uninstallHooksPath(ctx, report, dryRun);
  reportKept(ctx, report);
  return report.finish();
}

/** Registers `sdlc uninstall [--dry-run] [--json]`. */
export function registerUninstallCommand(program: Command, makeContext: InstallContextFactory): void {
  program
    .command('uninstall')
    .description('Remove the managed files and the git hooks path; your content and GitHub are left alone')
    .option('--dry-run', 'print the plan; change nothing')
    .option('--json', 'print machine-readable JSON')
    .action((options: UninstallOptions) => runInstallAction(makeContext, options, ctx => runUninstall(ctx, options)));
}
