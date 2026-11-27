import type { Command } from 'commander';
import type { EvidenceKind, TaskState } from '../core/types.js';
import {
  commit,
  describeState,
  parseEvidenceKind,
  parseIssueNumber,
  runCommand,
  type CommandContext,
  type ContextFactory,
} from './context.js';

/** Records evidence (a backup, a dry run) that a task type may require before review. */
export async function evidenceAdd(
  ctx: CommandContext,
  issue: number,
  input: { kind: EvidenceKind; ref: string },
): Promise<TaskState> {
  const ref = input.ref.trim();
  if (!ref) throw new Error('Evidence needs a ref: a link, path or id that shows it');
  return commit(ctx, issue, { kind: 'evidence_added', evidenceKind: input.kind, ref });
}

/** Registers `sdlc evidence add`. */
export function registerEvidenceCommand(program: Command, makeContext: ContextFactory): void {
  const evidence = program.command('evidence').description('Record evidence required before review');

  evidence
    .command('add')
    .description('Record evidence, e.g. a backup or a dry run')
    .argument('<issue>', 'issue number')
    .requiredOption('--kind <kind>', 'backup or dry_run')
    .requiredOption('--ref <text>', 'link, path or id that shows the evidence')
    .option('--json', 'print machine-readable JSON')
    .action(async (issue: string, options: { kind: string; ref: string; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => evidenceAdd(ctx, parseIssueNumber(issue), { kind: parseEvidenceKind(options.kind), ref: options.ref }),
        describeState,
      );
    });
}
