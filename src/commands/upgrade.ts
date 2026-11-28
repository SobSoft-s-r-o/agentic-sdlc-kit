import type { Command } from 'commander';
import {
  installFiles,
  installHooksPath,
  Reporter,
  runInstallAction,
  validateConfig,
  type InstallContext,
  type InstallContextFactory,
  type InstallReport,
} from './install.js';

export interface UpgradeOptions {
  dryRun?: boolean;
  overwriteModified?: boolean;
  json?: boolean;
}

/**
 * `sdlc upgrade`: render the kit's current templates for the config and bring the repository up to
 * them: update what changed, add what is new and, unlike `init`, remove what the kit no longer
 * generates (while it is unmodified). The first line of the `files` step says which kit version the
 * manifest recorded and which one is running. Never touches GitHub.
 */
export async function runUpgrade(ctx: InstallContext, options: UpgradeOptions): Promise<InstallReport> {
  const dryRun = options.dryRun === true;
  const report = new Reporter(ctx, options.json === true);
  const cfg = validateConfig(ctx, report);
  if (cfg === undefined) return report.finish();

  const files = installFiles(ctx, cfg, report, {
    dryRun,
    overwriteModified: options.overwriteModified === true,
    removeObsolete: true,
    showKit: true,
  });
  await installHooksPath(ctx, report, dryRun, files.status);
  return report.finish();
}

/** Registers `sdlc upgrade [--dry-run] [--overwrite-modified] [--json]`; `--config` is the program's. */
export function registerUpgradeCommand(program: Command, makeContext: InstallContextFactory): void {
  program
    .command('upgrade')
    .description('Bring the managed files up to the installed kit version, removing what it no longer generates; GitHub is not touched')
    .option('--dry-run', 'print the plan; change nothing')
    .option('--overwrite-modified', 'also replace managed files and blocks that were edited by hand')
    .option('--json', 'print machine-readable JSON')
    .action((options: UpgradeOptions) => runInstallAction(makeContext, options, ctx => runUpgrade(ctx, options)));
}
