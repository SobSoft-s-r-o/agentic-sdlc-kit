import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployRecord, registerDeployCommand } from '../../src/commands/deploy.js';
import type { CommandContext } from '../../src/commands/context.js';
import { loadConfig } from '../../src/config/schema.js';
import { satisfiedTargets } from '../../src/engine/deployments.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { TaskState } from '../../src/core/types.js';
import { FakeTracker, type FakeDeployment } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));

/** A valid 40-character commit id made of one hex digit. */
const sha = (digit: string): string => digit.repeat(40);
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(sha) as [string, string, string, string];

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

function setup() {
  const tracker = new FakeTracker();
  const out: unknown[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    tracker,
    cfg,
    now: () => '2026-06-01T00:00:00.000Z',
    out: data => out.push(data),
    err: text => err.push(text),
  };
  return { tracker, ctx, out, err };
}

/** Seeds a deployment; `n` orders them by creation time, newest last. */
function deployment(
  tracker: FakeTracker,
  n: number,
  environment: string,
  deployedSha: string,
  extra: Partial<FakeDeployment> = {},
): FakeDeployment {
  const found: FakeDeployment = {
    id: n,
    sha: deployedSha,
    environment,
    url: `https://deploys.test/${environment}/${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    ...extra,
  };
  tracker.deployments.push(found);
  return found;
}

const noVerify = async (): Promise<number> => {
  throw new Error('the verify command must not run');
};

describe('deployRecord', () => {
  it('refuses sha not on default branch', async () => {
    const { tracker, ctx } = setup();

    await expect(deployRecord(ctx, { target: 'web', sha: A })).rejects.toThrow(`sha ${A} is not on main`);

    expect(tracker.deployments).toEqual([]);
    expect(tracker.writes).toBe(0);
  });

  it('refuses when verify command fails', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);
    const commands: string[] = [];

    await expect(
      deployRecord(ctx, { target: 'web', sha: A, verify: './check.sh' }, { runVerify: async cmd => (commands.push(cmd), 3) }),
    ).rejects.toThrow('verify command failed (exit 3); no deployment recorded');

    expect(commands).toEqual(['./check.sh']);
    expect(tracker.deployments).toEqual([]);
    expect(tracker.writes).toBe(0);
  });

  it('runs the verify command through a real shell and refuses on its exit code', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);

    await expect(deployRecord(ctx, { target: 'web', sha: A, verify: 'exit 3' })).rejects.toThrow(
      'verify command failed (exit 3); no deployment recorded',
    );

    expect(tracker.deployments).toEqual([]);
  });

  it('records the deployment once the verify command passes', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);
    const commands: string[] = [];

    const recorded = await deployRecord(
      ctx,
      { target: 'web', sha: A, verify: 'curl -fsS https://example.test/health' },
      { runVerify: async cmd => (commands.push(cmd), 0) },
    );

    expect(commands).toEqual(['curl -fsS https://example.test/health']);
    expect(tracker.deployments).toHaveLength(1);
    expect(tracker.deployments[0]).toMatchObject({
      sha: A,
      environment: 'production-web',
      target: 'web',
      description: 'sdlc deploy record (web)',
    });
    expect(recorded).toMatchObject({ id: tracker.deployments[0]!.id, sha: A, environment: 'production-web' });
    expect(recorded.alreadyRecorded).toBeUndefined();
  });

  it('uses the environment of the target, not a fixed one', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);

    await deployRecord(ctx, { target: 'api', sha: A });

    expect(tracker.deployments[0]).toMatchObject({ environment: 'production-api', target: 'api' });
  });

  it('records without a verify command', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);

    await deployRecord(ctx, { target: 'web', sha: A }, { runVerify: noVerify });

    expect(tracker.deployments).toHaveLength(1);
  });

  it('refuses an unknown target before anything else', async () => {
    const { tracker, ctx } = setup();
    const onDefault = vi.spyOn(tracker, 'isOnDefaultBranch');

    await expect(deployRecord(ctx, { target: 'mobile', sha: 'not-a-sha' })).rejects.toThrow(/Unknown target "mobile"/);

    expect(onDefault).not.toHaveBeenCalled();
    expect(tracker.deployments).toEqual([]);
  });

  it.each(['abc123', 'g'.repeat(40), `${A}0`, 'main', ''])('refuses the malformed sha %j', async bad => {
    const { tracker, ctx } = setup();
    const onDefault = vi.spyOn(tracker, 'isOnDefaultBranch');

    await expect(deployRecord(ctx, { target: 'web', sha: bad }, { runVerify: noVerify })).rejects.toThrow(
      `invalid sha ${bad}`,
    );

    expect(onDefault).not.toHaveBeenCalled();
    expect(tracker.deployments).toEqual([]);
  });

  it('accepts an abbreviated sha of 7 characters and upper-case hex', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add('ABCDEF1');

    await deployRecord(ctx, { target: 'web', sha: 'ABCDEF1' });

    expect(tracker.deployments[0]!.sha).toBe('ABCDEF1');
  });

  it('does not run the verify command for a sha that is not on the default branch', async () => {
    const { tracker, ctx } = setup();

    await expect(deployRecord(ctx, { target: 'web', sha: A, verify: 'true' }, { runVerify: noVerify })).rejects.toThrow(
      /is not on main/,
    );
    expect(tracker.deployments).toEqual([]);
  });

  it('returns the existing deployment instead of recording the same sha twice', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);
    const existing = deployment(tracker, 1, 'production-web', A);

    const recorded = await deployRecord(ctx, { target: 'web', sha: A });

    expect(recorded).toEqual({
      id: existing.id,
      sha: A,
      environment: 'production-web',
      url: existing.url,
      createdAt: existing.createdAt,
      alreadyRecorded: true,
    });
    expect(tracker.deployments).toHaveLength(1);
    expect(tracker.writes).toBe(0);
  });

  it('matches an existing deployment of the same sha ignoring letter case', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A.toUpperCase());
    deployment(tracker, 1, 'production-web', A);

    const recorded = await deployRecord(ctx, { target: 'web', sha: A.toUpperCase() });

    expect(recorded.alreadyRecorded).toBe(true);
    expect(tracker.deployments).toHaveLength(1);
  });

  it('records a sha deployed to another environment, or an older one deployed here', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);
    deployment(tracker, 1, 'production-api', A);
    deployment(tracker, 2, 'production-web', B);

    const recorded = await deployRecord(ctx, { target: 'web', sha: A });

    expect(recorded.alreadyRecorded).toBeUndefined();
    expect(tracker.deployments).toHaveLength(3);
    expect(tracker.deployments[2]).toMatchObject({ sha: A, environment: 'production-web' });
  });

  it('still runs the verify command when the sha is already recorded', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);
    deployment(tracker, 1, 'production-web', A);

    await expect(deployRecord(ctx, { target: 'web', sha: A, verify: 'check' }, { runVerify: async () => 1 })).rejects.toThrow(
      'verify command failed (exit 1); no deployment recorded',
    );
  });

  it('rejects when a tracker call fails, naming the step, and records nothing', async () => {
    const { tracker, ctx } = setup();
    tracker.defaultBranchShas.add(A);

    tracker.failNext('isOnDefaultBranch');
    await expect(deployRecord(ctx, { target: 'web', sha: A })).rejects.toThrow(/^isOnDefaultBranch failed:/);

    tracker.failNext('listSuccessfulDeployments');
    await expect(deployRecord(ctx, { target: 'web', sha: A })).rejects.toThrow(/^listSuccessfulDeployments failed:/);

    tracker.failNext('createDeployment');
    await expect(deployRecord(ctx, { target: 'web', sha: A })).rejects.toThrow(/^createDeployment failed:/);

    expect(tracker.deployments).toEqual([]);
  });
});

/** A task waiting for deployment: `merged` are the merge commits of its PRs. */
function awaiting(merged: Array<string | undefined>, pending: string[] = ['web']): TaskState {
  const base = newTask({ issue: 12, type: BUILTIN_TYPES.find(t => t.id === 'feature')!, summary: 'Add search', now: '2026-01-01T00:00:00.000Z' });
  return {
    ...base,
    status: 'awaiting_deployment',
    phase: 'delivery',
    waitingOn: 'external',
    targets: ['web', 'api'],
    pendingTargets: pending,
    prs: merged.map((mergeSha, i) => ({ number: 100 + i, scope: 'final' as const, ...(mergeSha && { mergeSha }) })),
  };
}

describe('satisfiedTargets', () => {
  it('satisfies a target only when all merge commits are contained', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', D);
    tracker.ancestors.add(`${A}>${D}`);

    expect(await satisfiedTargets(tracker, cfg, awaiting([A, B]))).toEqual({ targets: [], urls: [] });

    tracker.ancestors.add(`${B}>${D}`);

    expect(await satisfiedTargets(tracker, cfg, awaiting([A, B]))).toEqual({
      targets: ['web'],
      urls: ['https://deploys.test/production-web/1'],
    });
  });

  it('older successful deployment still satisfies after a rollback', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', C);
    deployment(tracker, 2, 'production-web', B);
    tracker.ancestors.add(`${A}>${C}`);
    // The rollback target B does not contain A; the older deployment C does.

    expect(await satisfiedTargets(tracker, cfg, awaiting([A]))).toEqual({
      targets: ['web'],
      urls: ['https://deploys.test/production-web/1'],
    });
  });

  it('counts a deployment of the merge commit itself', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', A);

    expect((await satisfiedTargets(tracker, cfg, awaiting([A]))).targets).toEqual(['web']);
  });

  it('needs every merge commit in one deployment, not spread over several', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', C);
    deployment(tracker, 2, 'production-web', D);
    tracker.ancestors.add(`${A}>${C}`);
    tracker.ancestors.add(`${B}>${D}`);

    expect(await satisfiedTargets(tracker, cfg, awaiting([A, B]))).toEqual({ targets: [], urls: [] });
  });

  it('satisfies nothing when the task has no merged PR', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', A);
    const isAncestor = vi.spyOn(tracker, 'isAncestor');

    expect(await satisfiedTargets(tracker, cfg, awaiting([]))).toEqual({ targets: [], urls: [] });
    expect(await satisfiedTargets(tracker, cfg, awaiting([undefined]))).toEqual({ targets: [], urls: [] });
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it('ignores PRs without a merge commit', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', D);
    tracker.ancestors.add(`${A}>${D}`);

    expect((await satisfiedTargets(tracker, cfg, awaiting([A, undefined]))).targets).toEqual(['web']);
  });

  it('evaluates only pending targets, each in its own environment', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', A);
    deployment(tracker, 2, 'production-api', A);
    const lookups = vi.spyOn(tracker, 'listSuccessfulDeployments');

    expect(await satisfiedTargets(tracker, cfg, awaiting([A], ['api']))).toEqual({
      targets: ['api'],
      urls: ['https://deploys.test/production-api/2'],
    });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(lookups).toHaveBeenCalledWith('production-api', 50);

    expect(await satisfiedTargets(tracker, cfg, awaiting([A], ['web', 'api']))).toEqual({
      targets: ['web', 'api'],
      urls: ['https://deploys.test/production-web/1', 'https://deploys.test/production-api/2'],
    });
  });

  it('satisfies one pending target and leaves the other', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', A);
    deployment(tracker, 2, 'production-api', B);

    expect((await satisfiedTargets(tracker, cfg, awaiting([A], ['web', 'api']))).targets).toEqual(['web']);
  });

  it('lists each url once', async () => {
    const tracker = new FakeTracker();
    const shared = 'https://deploys.test/shared';
    deployment(tracker, 1, 'production-web', A, { url: shared });
    deployment(tracker, 2, 'production-api', A, { url: shared });

    expect(await satisfiedTargets(tracker, cfg, awaiting([A], ['web', 'api']))).toEqual({
      targets: ['web', 'api'],
      urls: [shared],
    });
  });

  it('names a pending target that is not in the config', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', A);

    await expect(satisfiedTargets(tracker, cfg, awaiting([A], ['web', 'mobile']))).rejects.toThrow(
      /Unknown target "mobile"/,
    );
    await expect(satisfiedTargets(tracker, cfg, awaiting([], ['mobile']))).rejects.toThrow(/Unknown target "mobile"/);
  });

  it('satisfies nothing when there are no pending targets', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', A);

    expect(await satisfiedTargets(tracker, cfg, awaiting([A], []))).toEqual({ targets: [], urls: [] });
  });

  it('rejects when a tracker call fails', async () => {
    const tracker = new FakeTracker();
    deployment(tracker, 1, 'production-web', D);

    tracker.failNext('listSuccessfulDeployments');
    await expect(satisfiedTargets(tracker, cfg, awaiting([A]))).rejects.toThrow(/listSuccessfulDeployments failed/);

    tracker.failNext('isAncestor');
    await expect(satisfiedTargets(tracker, cfg, awaiting([A]))).rejects.toThrow(/isAncestor failed/);
  });
});

describe('sdlc deploy record', () => {
  function program(h: ReturnType<typeof setup>): Command {
    const root = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerDeployCommand(root, () => h.ctx);
    return root;
  }
  const run = (root: Command, ...args: string[]) => root.parseAsync(['node', 'sdlc', 'deploy', 'record', ...args]);

  it('records a deployment and says so', async () => {
    const h = setup();
    h.tracker.defaultBranchShas.add(A);

    await run(program(h), '--target', 'web', '--sha', A, '--verify', 'exit 0');

    expect(h.err).toEqual([]);
    expect(h.out).toEqual([`Recorded deployment 1 of ${A} to production-web: https://github.test/deployments/1`]);
    expect(h.tracker.deployments).toHaveLength(1);
    expect(process.exitCode).toBe(exitCode);
  });

  it('notes that the sha was already recorded and creates nothing', async () => {
    const h = setup();
    h.tracker.defaultBranchShas.add(A);
    deployment(h.tracker, 7, 'production-web', A);

    await run(program(h), '--target', 'web', '--sha', A);

    expect(h.out).toEqual([`Deployment 7 of ${A} to production-web was already recorded: https://deploys.test/production-web/7`]);
    expect(h.tracker.deployments).toHaveLength(1);
  });

  it('prints JSON with --json', async () => {
    const h = setup();
    h.tracker.defaultBranchShas.add(A);
    deployment(h.tracker, 7, 'production-web', B);

    await run(program(h), '--target', 'web', '--sha', A, '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual({
      id: 8,
      sha: A,
      environment: 'production-web',
      url: 'https://github.test/deployments/8',
      createdAt: expect.any(String),
    });
  });

  it('prints a refusal to err and exits 1', async () => {
    const h = setup();

    await run(program(h), '--target', 'web', '--sha', A);

    expect(h.out).toEqual([]);
    expect(h.err).toEqual([`sha ${A} is not on main`]);
    expect(process.exitCode).toBe(1);
    expect(h.tracker.deployments).toEqual([]);
  });

  it('prints a failure as {"error"} on out with --json and exits 1', async () => {
    const h = setup();
    h.tracker.defaultBranchShas.add(A);
    h.tracker.failNext('createDeployment');

    await run(program(h), '--target', 'web', '--sha', A, '--json');

    expect(h.err).toEqual([]);
    expect(JSON.parse(h.out[0] as string)).toEqual({ error: expect.stringMatching(/^createDeployment failed:/) });
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when the verify command fails', async () => {
    const h = setup();
    h.tracker.defaultBranchShas.add(A);

    await run(program(h), '--target', 'web', '--sha', A, '--verify', 'exit 3');

    expect(h.err).toEqual(['verify command failed (exit 3); no deployment recorded']);
    expect(process.exitCode).toBe(1);
    expect(h.tracker.deployments).toEqual([]);
  });

  it('requires --target and --sha', async () => {
    const h = setup();

    await expect(run(program(h), '--sha', A)).rejects.toThrow(/--target/);
    await expect(run(program(h), '--target', 'web')).rejects.toThrow(/--sha/);
  });
});
