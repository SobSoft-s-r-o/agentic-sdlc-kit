import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { describeStatus, registerStatusCommand } from '../../src/commands/status.js';
import { loadConfig, typeRegistry } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { statusReport } from '../../src/engine/status.js';
import { FakeTracker } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const types = typeRegistry(cfg);
const NOW = '2026-06-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
});

function setup() {
  const tracker = new FakeTracker();
  tracker.owners = [...cfg.owners];
  const out: unknown[] = [];
  const err: string[] = [];
  const ctx: CommandContext = { tracker, cfg, now: () => NOW, out: data => out.push(data), err: text => err.push(text) };
  return { tracker, ctx, out, err };
}

type Harness = ReturnType<typeof setup>;

function task(issue: number, overrides: Partial<TaskState> = {}): TaskState {
  return { ...newTask({ issue, type: types.get('feature')!, summary: `Task ${issue}`, now: ago(30) }), ...overrides };
}

const awaiting = (issue: number, updatedAt: string): TaskState =>
  task(issue, {
    phase: 'delivery',
    status: 'awaiting_deployment',
    waitingOn: 'external',
    targets: ['web', 'api'],
    pendingTargets: ['web', 'api'],
    updatedAt,
  });

async function run(h: Harness, ...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerStatusCommand(program, () => h.ctx);
  await program.parseAsync(['node', 'sdlc', 'status', ...args]);
}

/**
 * Runs `sdlc status` with a context factory that fails as a broken config would, capturing what is
 * printed to stdout and stderr (with no context, errors go straight to the process streams).
 */
async function runWithoutContext(...args: string[]): Promise<{ out: string[]; err: string[]; contexts: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let contexts = 0;
  const capture = (into: string[]) => (chunk: string | Uint8Array): boolean => {
    into.push(String(chunk).replace(/\n$/, ''));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture(out));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture(err));
  try {
    const program = new Command().exitOverride();
    registerStatusCommand(program, () => {
      contexts += 1;
      throw new Error('config is broken');
    });
    await program.parseAsync(['node', 'sdlc', 'status', ...args]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return { out, err, contexts };
}

describe('sdlc status', () => {
  it('prints tasks grouped by status, then only the attention sections that have entries', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, { status: 'in_progress', phase: 'implementation', updatedAt: ago(2) }), {
      title: 'Add search',
    });
    h.tracker.seedTask(awaiting(2, ago(9)), { title: 'Ship export' });
    h.tracker.seedTask(task(3, { status: 'paused', waitingOn: 'owner', phase: 'brainstorming', updatedAt: ago(1) }), {
      title: 'Pick a design',
    });
    h.tracker.issues.push({ number: 9, title: 'Hand-made', body: '', labels: ['sdlc:task'], open: true, onBoard: false });

    await run(h);

    const text = h.out[0] as string;
    expect(text).toContain('In progress (1)');
    expect(text).toContain('Paused (1)');
    expect(text).toContain('Awaiting deployment (1)');
    expect(text).toContain('#1 Add search');
    expect(text).toContain('feature, Implementation, 2d');
    expect(text).toContain('#2 Ship export');
    expect(text).toContain('pending: api, web');
    expect(text).toContain('Waiting on the owner (1)');
    expect(text).toContain('Awaiting deployment for more than 7 days (1)');
    expect(text).toContain('Untracked sdlc:task issues (1)');
    expect(text).toContain('#9 Hand-made');
    // Listed once, under untracked issues, not again under pending reconcile.
    expect(text.match(/#9 /g)).toHaveLength(1);
    expect(text).not.toContain('Pending reconcile');
    expect(text).not.toContain('Paused on the agent');
    expect(text).not.toContain('Ready (');
    expect(text).not.toContain('\u001b[');
    expect(process.exitCode).toBe(exitCode);
  });

  it('prints a short line for an empty repository and leaves out every attention section', async () => {
    const h = setup();

    await run(h);

    expect(h.out[0]).toBe('No tracked tasks.');
  });

  it('lists the pending reconcile actions', async () => {
    const h = setup();
    h.tracker.seedTask({ ...awaiting(1, ago(1)), targets: [], pendingTargets: [] });

    await run(h);

    const text = h.out[0] as string;
    expect(text).toContain('Pending reconcile (1)');
    expect(text).toContain('#1 error: no targets declared');
  });

  it('prints the report as JSON with --json', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(9)));

    await run(h, '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual(JSON.parse(JSON.stringify(await statusReport(h.ctx, { staleDays: 7 }))));
  });

  it('uses --stale-days for the staleness cut-off', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(9)));

    await run(h, '--stale-days', '10', '--json');

    const report = JSON.parse(h.out[0] as string) as { staleAwaitingDeployment: unknown[] };
    expect(report.staleAwaitingDeployment).toEqual([]);
  });

  it.each(['0', '-3', '1.5', '7days', 'abc', '', '1e3', '0x10', ' '])(
    'rejects --stale-days %j with an error and exit code 1',
    async value => {
      const h = await runWithoutContext('--stale-days', value);

      expect(h.out).toEqual([]);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toMatch(/--stale-days/);
      expect(h.err[0]).toMatch(/positive integer/);
      expect(process.exitCode).toBe(1);
    },
  );

  it('checks --stale-days before building the context, so a bad value is named even with a broken config', async () => {
    const result = await runWithoutContext('--stale-days', 'abc');

    expect(result.contexts).toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([expect.stringMatching(/--stale-days "abc".*positive integer/)]);
    expect(process.exitCode).toBe(1);
  });

  it('still reports a broken config when --stale-days is valid', async () => {
    const result = await runWithoutContext('--stale-days', '3');

    expect(result.contexts).toBe(1);
    expect(result.err).toEqual(['config is broken']);
  });

  it('reports an invalid --stale-days as JSON with --json', async () => {
    const h = await runWithoutContext('--stale-days', '0', '--json');

    expect(h.contexts).toBe(0);
    expect(JSON.parse(h.out[0]!)).toEqual({ error: expect.stringContaining('positive integer') });
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when the tasks cannot be read', async () => {
    const h = setup();
    h.tracker.failNext('scanTasks');

    await run(h);

    expect(h.err[0]).toContain('scanTasks');
    expect(process.exitCode).toBe(1);
  });
});

describe('describeStatus', () => {
  it('names the stale-days cut-off in the stale section', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(2, ago(4)));

    const text = describeStatus(await statusReport(h.ctx, { staleDays: 3 }), 3);

    expect(text).toContain('Awaiting deployment for more than 3 days (1)');
  });

  it('lists paused-on-agent tasks that are stale', async () => {
    const h = setup();
    h.tracker.seedTask(task(4, { status: 'paused', waitingOn: 'agent', updatedAt: ago(12) }), { title: 'Stuck' });

    const text = describeStatus(await statusReport(h.ctx, { staleDays: 7 }), 7);

    expect(text).toContain('Paused on the agent for more than 7 days (1)');
    expect(text).toContain('#4 Stuck');
  });
});
