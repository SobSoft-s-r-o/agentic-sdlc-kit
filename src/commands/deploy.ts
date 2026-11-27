import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Command } from 'commander';
import { targetByName } from '../config/schema.js';
import { DEPLOYMENT_LOOKBACK } from '../engine/deployments.js';
import type { DeploymentInfo } from '../tracker/types.js';
import { runCommand, trackerStep, type CommandContext, type ContextFactory } from './context.js';

/** A commit id as `git` prints it: 7 to 40 hex digits. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** A deployment, flagged `alreadyRecorded` when it was found instead of created. */
export type RecordedDeployment = DeploymentInfo & { alreadyRecorded?: true };

/** Runs a shell command and resolves with its exit code. */
export type VerifyRunner = (command: string) => Promise<number>;

/**
 * Runs `command` with `/bin/sh -c`. It reads this process's stdin and writes its stderr to ours;
 * its stdout also goes to our stderr (fd 2), so `--json` output on stdout stays a valid document.
 * A command killed by a signal exits with 128 plus the signal number, as a shell would report it.
 */
export const runShell: VerifyRunner = command =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['inherit', 2, 'inherit'] });
    child.on('error', error =>
      reject(new Error(`verify command could not run: ${error.message}; no deployment recorded`)),
    );
    child.on('close', (code, signal) =>
      resolve(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0)),
    );
  });

/**
 * Records, as a GitHub Deployment, that `sha` is deployed to the environment of `target`. It
 * records a deploy that already happened and never deploys anything. Checks run in this order and
 * the first failure rejects with nothing recorded: the target is configured, `sha` is a commit id,
 * `sha` is on the default branch, the optional `verify` command exits 0. A successful deployment
 * of exactly `sha` (ignoring letter case) to the environment is returned as it is, flagged
 * `alreadyRecorded`, instead of recording a second one.
 */
export async function deployRecord(
  ctx: CommandContext,
  input: { target: string; sha: string; verify?: string },
  options: { runVerify?: VerifyRunner } = {},
): Promise<RecordedDeployment> {
  const { runVerify = runShell } = options;
  const target = targetByName(ctx.cfg, input.target);
  const { sha } = input;
  if (!SHA_PATTERN.test(sha)) throw new Error(`invalid sha ${sha}`);

  const onDefault = await trackerStep('isOnDefaultBranch', undefined, () => ctx.tracker.isOnDefaultBranch(sha));
  if (!onDefault) throw new Error(`sha ${sha} is not on ${ctx.cfg.github.defaultBranch}`);

  if (input.verify !== undefined) {
    const exit = await runVerify(input.verify);
    if (exit !== 0) throw new Error(`verify command failed (exit ${exit}); no deployment recorded`);
  }

  const existing = await trackerStep('listSuccessfulDeployments', undefined, () =>
    ctx.tracker.listSuccessfulDeployments(target.environment, DEPLOYMENT_LOOKBACK),
  );
  const found = existing.find(d => d.sha.toLowerCase() === sha.toLowerCase());
  if (found) return { ...found, alreadyRecorded: true };

  return trackerStep('createDeployment', undefined, () =>
    ctx.tracker.createDeployment({
      environment: target.environment,
      sha,
      target: target.name,
      description: `sdlc deploy record (${target.name})`,
    }),
  );
}

const describeRecorded = (d: RecordedDeployment): string =>
  d.alreadyRecorded
    ? `Deployment ${d.id} of ${d.sha} to ${d.environment} was already recorded: ${d.url}`
    : `Recorded deployment ${d.id} of ${d.sha} to ${d.environment}: ${d.url}`;

/** Registers `sdlc deploy record`. */
export function registerDeployCommand(program: Command, makeContext: ContextFactory): void {
  const deploy = program.command('deploy').description('Record deployments');

  deploy
    .command('record')
    .description('Record that a commit is deployed to a target (records a deploy that already happened)')
    .requiredOption('--target <name>', 'target name from the config')
    .requiredOption('--sha <sha>', 'deployed commit; must be on the default branch')
    .option('--verify <command>', 'shell command that must exit 0 before the deployment is recorded')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { target: string; sha: string; verify?: string; json?: boolean }) => {
      await runCommand(
        makeContext,
        options,
        ctx => deployRecord(ctx, { target: options.target, sha: options.sha, verify: options.verify }),
        describeRecorded,
      );
    });
}
