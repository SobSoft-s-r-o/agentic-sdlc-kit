import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { describeReconcile, registerReconcileCommand } from '../../src/commands/reconcile.js';
import { loadConfig } from '../../src/config/schema.js';
import { reconcile, type ReconcileAction, type ReconcileResult } from '../../src/engine/reconcile.js';
import { QUIET_KINDS } from '../../src/engine/status.js';
import { FakeTracker } from '../support/fakeTracker.js';

vi.mock('../../src/engine/reconcile.js', () => ({ reconcile: vi.fn() }));

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const ignored = (issue: number, command: string): ReconcileAction => ({
  issue,
  kind: 'ignored_approval',
  detail: `/${command} (https://github.test/issues/${issue}#issuecomment-${issue}): not newer than stage "planning"`,
});
const merged: ReconcileAction = { issue: 12, kind: 'pr_merged', detail: 'PR #50 merged (final) as abc' };

describe('describeReconcile', () => {
  it('prints one summary line for ignored commands', () => {
    const result: ReconcileResult = {
      actions: [ignored(1, 'approve'), merged, ignored(2, 'accept'), ignored(3, 'approve')],
      errors: 0,
    };
    expect(describeReconcile(result).split('\n')).toEqual([
      '#12 pr_merged: PR #50 merged (final) as abc',
      '3 ignored owner command(s); --json lists them',
      '1 action(s), 0 error(s)',
    ]);
  });

  it('prints no summary line when nothing was ignored', () => {
    const result: ReconcileResult = { actions: [merged], errors: 0 };
    expect(describeReconcile(result)).toBe('#12 pr_merged: PR #50 merged (final) as abc\n1 action(s), 0 error(s)');
  });

  it('prints only the summary and a zero count when every action is quiet', () => {
    const result: ReconcileResult = { actions: [ignored(1, 'approve'), ignored(1, 'cancel')], errors: 0 };
    expect(describeReconcile(result)).toBe(
      '2 ignored owner command(s); --json lists them\n0 action(s), 0 error(s)',
    );
  });

  it('keeps errors as their own lines and counts them', () => {
    const failure: ReconcileAction = { issue: 3, kind: 'error', detail: 'no targets declared' };
    const result: ReconcileResult = { actions: [ignored(3, 'approve'), failure], errors: 1 };
    expect(describeReconcile(result)).toBe(
      '#3 error: no targets declared\n1 ignored owner command(s); --json lists them\n1 action(s), 1 error(s)',
    );
  });

  it('does not call the other quiet kinds ignored owner commands, and names them in the summary', () => {
    const result: ReconcileResult = {
      actions: [
        ignored(1, 'approve'),
        { issue: 2, kind: 'untracked', detail: 'untracked sdlc:task issue: missing state comment' },
        { issue: 3, kind: 'skipped_unknown_type', detail: 'task type "x" is not enabled' },
      ],
      errors: 0,
    };
    expect(describeReconcile(result).split('\n')).toEqual([
      '1 ignored owner command(s), 1 untracked issue(s), 1 skipped task(s); --json lists them',
      '0 action(s), 0 error(s)',
    ]);
  });
});

describe('describeReconcile and the quiet kinds', () => {
  it('summarizes every kind status.ts treats as quiet, so none of them vanishes from the text output', () => {
    expect([...QUIET_KINDS].sort()).toEqual(['ignored_approval', 'skipped_unknown_type', 'untracked']);
    for (const kind of QUIET_KINDS) {
      const text = describeReconcile({ actions: [{ issue: 7, kind, detail: 'why' }], errors: 0 });
      expect(text, kind).not.toContain(`#7 ${kind}`);
      expect(text, kind).toMatch(/^1 .+; --json lists them$/m);
    }
  });
});

describe('sdlc reconcile output', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.mocked(reconcile).mockReset();
  });

  const RESULT: ReconcileResult = {
    actions: [ignored(1, 'approve'), merged, ignored(2, 'accept'), ignored(3, 'approve')],
    errors: 0,
  };

  async function run(...args: string[]): Promise<unknown[]> {
    vi.mocked(reconcile).mockResolvedValue(RESULT);
    const out: unknown[] = [];
    const ctx: CommandContext = {
      tracker: new FakeTracker(),
      cfg,
      now: () => '2026-06-01T00:00:00.000Z',
      out: data => out.push(data),
      err: () => undefined,
    };
    const program = new Command().exitOverride();
    registerReconcileCommand(program, () => ctx);
    await program.parseAsync(['node', 'sdlc', 'reconcile', ...args]);
    return out;
  }

  it('prints the summary line instead of one line per ignored command', async () => {
    const [text] = await run();
    expect(text).toContain('#12 pr_merged: PR #50 merged (final) as abc');
    expect(text).toContain('3 ignored owner command(s); --json lists them');
    expect(text).not.toContain('ignored_approval');
  });

  it('--json still lists all four actions', async () => {
    const [json] = await run('--json');
    const printed = JSON.parse(json as string) as ReconcileResult;
    expect(printed.actions).toHaveLength(4);
    expect(printed.actions.filter(action => action.kind === 'ignored_approval')).toHaveLength(3);
    expect(printed.actions.map(action => action.kind)).toContain('pr_merged');
  });
});
