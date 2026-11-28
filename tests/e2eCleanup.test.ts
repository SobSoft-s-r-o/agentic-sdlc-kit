import { describe, expect, it } from 'vitest';
import type { GhRunner } from '../src/github/gh.js';
import { closeRunIssues } from './e2e/support.js';
import { sandboxRunner } from './e2e/guard.js';

const REPO = 'acme/sandbox';
const PREFIX = 'sdlc-e2e-ab12';

interface FakeIssue {
  state: 'OPEN' | 'CLOSED';
  title: string;
  /** `gh issue close` of this issue fails with this message. */
  closeFails?: string;
  /** `gh issue view` of this issue fails. */
  viewFails?: boolean;
}

/** A `gh` that knows some issues of one repository: view, list and close, and records every call. */
function fakeRepo(issues: Record<number, FakeIssue>, options: { listFails?: boolean } = {}) {
  const calls: string[][] = [];
  const run: GhRunner = async args => {
    calls.push(args);
    const [group, sub, arg] = args;
    const issue = issues[Number(arg)];
    if (group === 'issue' && sub === 'view' && issue) {
      if (issue.viewFails) return { stdout: '', stderr: 'HTTP 502', code: 1 };
      return { stdout: JSON.stringify({ state: issue.state }), stderr: '', code: 0 };
    }
    if (group === 'issue' && sub === 'close' && issue) {
      if (issue.closeFails) return { stdout: '', stderr: issue.closeFails, code: 1 };
      issue.state = 'CLOSED';
      return { stdout: `closed #${arg}\n`, stderr: '', code: 0 };
    }
    if (group === 'issue' && sub === 'list') {
      if (options.listFails) return { stdout: '', stderr: 'HTTP 500', code: 1 };
      const open = Object.entries(issues)
        .filter(([, row]) => row.state === 'OPEN')
        .map(([number, row]) => ({ number: Number(number), title: row.title }));
      return { stdout: JSON.stringify(open), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: `unexpected call: ${args.join(' ')}`, code: 1 };
  };
  const closed = () => calls.filter(args => args[1] === 'close').map(args => Number(args[2]));
  return { run, calls, closed, issues };
}

describe('e2e cleanup: closeRunIssues', () => {
  it('closes the issues it opened, and leaves a closed one alone', async () => {
    const repo = fakeRepo({
      1: { state: 'OPEN', title: `${PREFIX}: a` },
      2: { state: 'CLOSED', title: `${PREFIX}: b` },
    });
    const warnings: string[] = [];
    expect(await closeRunIssues(repo.run, REPO, [1, 2], PREFIX, warnings)).toEqual([]);
    expect(repo.closed()).toEqual([1]);
    expect(repo.issues[1]?.state).toBe('CLOSED');
    expect(warnings).toEqual([]);
  });

  it('closes the issues it opened before it scans for strays', async () => {
    const repo = fakeRepo({ 1: { state: 'OPEN', title: `${PREFIX}: a` }, 5: { state: 'OPEN', title: `${PREFIX}: stray` } });
    await closeRunIssues(repo.run, REPO, [1], PREFIX, []);
    const firstClose = repo.calls.findIndex(args => args[1] === 'close');
    const scan = repo.calls.findIndex(args => args[1] === 'list');
    expect(firstClose).toBeGreaterThanOrEqual(0);
    expect(firstClose).toBeLessThan(scan);
  });

  it('closes the others when one fails, and reports the one that failed', async () => {
    const repo = fakeRepo({
      1: { state: 'OPEN', title: `${PREFIX}: a`, closeFails: 'HTTP 403: forbidden' },
      2: { state: 'OPEN', title: `${PREFIX}: b` },
      3: { state: 'OPEN', title: `${PREFIX}: c` },
    });
    const errors = await closeRunIssues(repo.run, REPO, [1, 2, 3], PREFIX, []);
    expect(repo.issues[2]?.state).toBe('CLOSED');
    expect(repo.issues[3]?.state).toBe('CLOSED');
    expect(repo.issues[1]?.state).toBe('OPEN');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^#1 was not closed: .*HTTP 403/);
    // The failed issue is not tried a second time by the scan.
    expect(repo.closed().filter(number => number === 1)).toHaveLength(1);
  });

  it('closes an issue it cannot read', async () => {
    const repo = fakeRepo({ 1: { state: 'OPEN', title: `${PREFIX}: a`, viewFails: true } });
    expect(await closeRunIssues(repo.run, REPO, [1], PREFIX, [])).toEqual([]);
    expect(repo.closed()).toEqual([1]);
  });

  it('closes an open e2e issue of this run that it did not see being created', async () => {
    const repo = fakeRepo({
      1: { state: 'OPEN', title: `${PREFIX}: a` },
      7: { state: 'OPEN', title: `${PREFIX}: created, then the call failed` },
    });
    expect(await closeRunIssues(repo.run, REPO, [1], PREFIX, [])).toEqual([]);
    expect(repo.issues[7]?.state).toBe('CLOSED');
  });

  it('leaves alone an open e2e issue of another run', async () => {
    const repo = fakeRepo({
      1: { state: 'OPEN', title: `${PREFIX}: a` },
      8: { state: 'OPEN', title: 'sdlc-e2e-ffff: another run' },
      9: { state: 'OPEN', title: 'somebody else' },
    });
    await closeRunIssues(repo.run, REPO, [1], PREFIX, []);
    expect(repo.issues[8]?.state).toBe('OPEN');
    expect(repo.issues[9]?.state).toBe('OPEN');
    expect(repo.closed()).toEqual([1]);
  });

  it('reports a stray it cannot close', async () => {
    const repo = fakeRepo({ 7: { state: 'OPEN', title: `${PREFIX}: stray`, closeFails: 'HTTP 500' } });
    const errors = await closeRunIssues(repo.run, REPO, [], PREFIX, []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^#7 was not closed/);
  });

  it('treats a failing stray scan as a warning, after the opened issues are closed', async () => {
    const repo = fakeRepo({ 1: { state: 'OPEN', title: `${PREFIX}: a` } }, { listFails: true });
    const warnings: string[] = [];
    expect(await closeRunIssues(repo.run, REPO, [1], PREFIX, warnings)).toEqual([]);
    expect(repo.issues[1]?.state).toBe('CLOSED');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/scan for other open e2e issues of this run failed/);
  });

  it('only sends calls the guard allows, and never deletes', async () => {
    const repo = fakeRepo({ 1: { state: 'OPEN', title: `${PREFIX}: a` }, 7: { state: 'OPEN', title: `${PREFIX}: stray` } });
    const guarded = sandboxRunner({ repo: REPO, projectOwner: 'acme', projects: new Set([3]) }, repo.run);
    expect(await closeRunIssues(guarded, REPO, [1], PREFIX, [])).toEqual([]);
    expect(repo.issues[1]?.state).toBe('CLOSED');
    expect(repo.issues[7]?.state).toBe('CLOSED');
    expect(repo.calls.some(args => args.includes('delete'))).toBe(false);
  });
});
