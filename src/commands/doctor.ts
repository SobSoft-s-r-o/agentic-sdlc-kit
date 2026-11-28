import type { Command } from 'commander';
import { doctorChecks, type Check, type DoctorEnv } from '../install/doctor.js';
import { errorAsJson, formatCliError } from './errors.js';

/** What `sdlc doctor` needs: the injected IO of the checks and where the report goes. */
export interface DoctorContext {
  env: DoctorEnv;
  /** Where the report goes (stdout). */
  out: (text: string) => void;
  /** Where an error that stopped the command before any check went goes (stderr). */
  err: (text: string) => void;
}

export type DoctorContextFactory = () => DoctorContext | Promise<DoctorContext>;

export interface DoctorOptions {
  preflight?: boolean;
  json?: boolean;
}

/** What `--json` prints. */
export interface DoctorReport {
  checks: Check[];
  /** No check failed (warnings are fine). */
  ok: boolean;
}

const SYMBOLS: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✗' };

/** A message on one line, whatever it was made of. */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

/** `✓`/`!`/`✗`, the id and the message; a fix on its own indented line after it. */
export function formatChecks(checks: Check[]): string {
  return checks
    .flatMap(check => [
      `${SYMBOLS[check.status]} ${check.id}: ${oneLine(check.message)}`,
      ...(check.fix === undefined ? [] : [`  fix: ${oneLine(check.fix)}`]),
    ])
    .join('\n');
}

/** Runs the checks, prints the report and sets exit code 1 when one failed. */
export async function runDoctorCommand(ctx: DoctorContext, options: DoctorOptions): Promise<DoctorReport> {
  const checks = await doctorChecks(ctx.env, { preflightOnly: options.preflight === true });
  const report: DoctorReport = { checks, ok: !checks.some(check => check.status === 'fail') };
  if (!report.ok) process.exitCode = 1;
  ctx.out(options.json ? JSON.stringify(report, null, 2) : formatChecks(checks));
  return report;
}

/**
 * Registers `sdlc doctor [--preflight] [--json]`; `--config` is the program's. A failure that
 * stops it before any check is printed like the other commands do it: on stderr, or as
 * `{"error": ...}` with `--json`, and exit code 1.
 */
export function registerDoctorCommand(
  program: Command,
  makeContext: DoctorContextFactory,
  io: { out: (text: string) => void; err: (text: string) => void },
): void {
  program
    .command('doctor')
    .description('Check the machine and the installation; exit 1 when a check fails')
    .option('--preflight', 'only the checks that need no config: git, Node, gh, the repository')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: DoctorOptions) => {
      let ctx: DoctorContext | undefined;
      try {
        ctx = await makeContext();
        await runDoctorCommand(ctx, options);
      } catch (error) {
        process.exitCode = 1;
        if (options.json) (ctx?.out ?? io.out)(JSON.stringify(errorAsJson(error), null, 2));
        else (ctx?.err ?? io.err)(formatCliError(error));
      }
    });
}
