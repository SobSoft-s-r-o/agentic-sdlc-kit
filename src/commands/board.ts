import type { Command } from 'commander';
import type { Config } from '../config/schema.js';
import { ensureBoard, type EnsureBoardResult } from '../github/board.js';
import type { GhRunner } from '../github/gh.js';

export interface BoardCommandContext {
  run: GhRunner;
  config: Config;
  /** Where results go; defaults to stdout. */
  out?: (text: string) => void;
  /** Where progress notices go; defaults to stderr. */
  err?: (text: string) => void;
}

const list = (names: string[]): string => names.join(', ');

/** Human-readable summary of an `ensureBoard` run. */
export function formatEnsureResult(result: EnsureBoardResult, dryRun: boolean): string {
  const lines: string[] = [];
  if (result.created) {
    lines.push(
      `Created project #${result.projectNumber}; set github.project.number: ${result.projectNumber} in sdlc.config.yaml`,
    );
  } else if (result.wouldCreateProject) {
    lines.push('No project configured; a new one would be created');
  } else {
    lines.push(`Project #${result.projectNumber}`);
  }

  const { createFields, addOptions } = result.plan;
  const fieldVerb = dryRun ? 'Would create fields' : 'Created fields';
  const optionVerb = dryRun ? 'Would add options' : 'Added options';
  if (createFields.length > 0) lines.push(`${fieldVerb}: ${list(createFields.map(f => f.name))}`);
  for (const change of addOptions) {
    lines.push(`${optionVerb} to ${change.fieldName}: ${list(change.missing)}`);
  }
  if (createFields.length === 0 && addOptions.length === 0) lines.push('Fields and options are up to date');

  if (dryRun) {
    if (result.viewsPlanned.length > 0) lines.push(`Would create views: ${list(result.viewsPlanned)}`);
  } else if (result.viewsCreated.length > 0) {
    lines.push(`Created views: ${list(result.viewsCreated)}`);
  }
  if (result.viewsManual.length > 0) {
    lines.push('Manual steps:', ...result.viewsManual.map(step => `  - ${step}`));
  }
  if (result.viewsFailed.length > 0) {
    lines.push('Failed views:', ...result.viewsFailed.map(f => `  - ${f.name}: ${f.error}`));
  }
  return lines.join('\n');
}

/** Registers `sdlc board ensure [--dry-run] [--json]`. */
export function registerBoardCommand(
  program: Command,
  makeContext: () => BoardCommandContext | Promise<BoardCommandContext>,
): void {
  const board = program.command('board').description('Manage the Projects v2 board');
  board
    .command('ensure')
    .description('Create the board or add its missing fields, options and views (add-only)')
    .option('--dry-run', 'only query GitHub and print what would change')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      const {
        run,
        config,
        out = text => process.stdout.write(`${text}\n`),
        err = text => process.stderr.write(`${text}\n`),
      } = await makeContext();
      const dryRun = options.dryRun === true;
      const result = await ensureBoard(run, config, {
        dryRun,
        // Said immediately: if a later write fails, this is the number to put in the config.
        onProjectCreated: project =>
          err(
            `Created project #${project.number}${project.url ? ` (${project.url})` : ''}; ` +
              `set github.project.number: ${project.number} in sdlc.config.yaml before running this again`,
          ),
      });
      out(options.json ? JSON.stringify({ dryRun, ...result }, null, 2) : formatEnsureResult(result, dryRun));
      // A view that failed to create is a failed GitHub write.
      if (result.viewsFailed.length > 0) process.exitCode = 1;
    });
}
