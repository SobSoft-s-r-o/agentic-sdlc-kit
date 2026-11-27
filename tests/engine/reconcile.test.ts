import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import { deployRecord } from '../../src/commands/deploy.js';
import { registerReconcileCommand } from '../../src/commands/reconcile.js';
import { reviewHandoff } from '../../src/commands/review.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
import { STATE_MARKER } from '../../src/core/stateComment.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { reconcile, type ReconcileAction } from '../../src/engine/reconcile.js';
import { FakeTracker } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const enforceCfg: Config = { ...cfg, mode: 'enforce' };
const types = typeRegistry(cfg);
const OWNER = 'shop-owner';

/** Task times: created T0, a stage or result published at PUBLISHED; owner comments BEFORE or AFTER it. */
const T0 = '2026-03-01T00:00:00.000Z';
const BEFORE = '2026-03-05T00:00:00.000Z';
const PUBLISHED = '2026-03-10T00:00:00.000Z';
const MERGED = '2026-03-15T00:00:00.000Z';
const AFTER = '2026-03-20T00:00:00.000Z';
const DEPLOYED = '2026-03-25T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

function setup(config: Config = cfg) {
  const tracker = new FakeTracker();
  tracker.owners = [...config.owners];
  tracker.agents = [...config.agents];
  const out: unknown[] = [];
  const err: string[] = [];
  let tick = 0;
  const ctx: CommandContext = {
    tracker,
    cfg: config,
    now: () => new Date(Date.UTC(2026, 5, 1, 0, 0, ++tick)).toISOString(),
    out: data => out.push(data),
    err: text => err.push(text),
  };
  return { tracker, ctx, out, err };
}

type Harness = ReturnType<typeof setup>;

function task(issue: number, type: string, overrides: Partial<TaskState> = {}): TaskState {
  return { ...newTask({ issue, type: types.get(type)!, summary: 'Add search', now: T0 }), ...overrides };
}

const inReview = (issue: number, type: string, overrides: Partial<TaskState> = {}): TaskState =>
  task(issue, type, {
    phase: 'review',
    status: 'in_review',
    waitingOn: 'owner',
    targets: type === 'feature' ? ['web'] : [],
    prs: [{ number: 50 + issue, scope: 'final' }],
    ...overrides,
  });

const awaiting = (issue: number, overrides: Partial<TaskState> = {}): TaskState =>
  task(issue, 'feature', {
    phase: 'delivery',
    status: 'awaiting_deployment',
    waitingOn: 'external',
    targets: ['web'],
    pendingTargets: ['web'],
    prs: [{ number: 50 + issue, scope: 'final', mergeSha: A }],
    finalMergedAt: MERGED,
    ...overrides,
  });

const pausedOn = (issue: number, type = 'feature', phase: TaskState['phase'] = 'brainstorming'): TaskState =>
  task(issue, type, {
    phase,
    status: 'paused',
    waitingOn: 'owner',
    stages: { [phase]: { revision: 1, publishedAt: PUBLISHED } },
  });

function mergedPr(h: Harness, issue: number, number: number, extra: object = {}): void {
  h.tracker.prs.push({
    issue,
    number,
    url: `https://github.test/pull/${number}`,
    merged: true,
    mergeSha: A,
    mergedAt: MERGED,
    baseRef: 'main',
    body: `Related to #${issue}\nScope: final`,
    ...extra,
  });
}

function deployedToWeb(h: Harness, id = 1): string {
  h.tracker.ancestors.add(`${A}>${B}`);
  const url = `https://github.test/deployments/${id}`;
  h.tracker.deployments.push({ id, sha: B, environment: 'production-web', url, createdAt: DEPLOYED });
  return url;
}

const comment = (h: Harness, thread: number, body: string, createdAt: string, author = OWNER, updatedAt?: string) => {
  const id = h.tracker.seedComment(thread, { body, author, createdAt, updatedAt });
  return h.tracker.comments.find(c => c.id === id)!.url;
};

const stateOf = async (h: Harness, issue: number) => (await h.tracker.getTask(issue)).state;
const issueOf = (h: Harness, n: number) => h.tracker.issues.find(i => i.number === n)!;
const visible = (h: Harness, thread: number) =>
  h.tracker.comments.filter(c => c.issue === thread && !c.body.startsWith(STATE_MARKER));
const kinds = (actions: ReconcileAction[]) => actions.map(a => a.kind);
const NON_MUTATING = new Set(['ignored_approval', 'skipped_unknown_type', 'untracked', 'error']);
const mutating = (actions: ReconcileAction[]) => actions.filter(a => !NON_MUTATING.has(a.kind));

describe('merged PRs', () => {
  it('moves a merged feature to awaiting deployment', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'feature'));
    mergedPr(h, 1, 51);

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(0);
    expect(kinds(result.actions)).toEqual(['pr_merged', 'fields_synced']);
    const state = await stateOf(h, 1);
    expect(state).toMatchObject({
      status: 'awaiting_deployment',
      phase: 'delivery',
      pendingTargets: ['web'],
      finalMergedAt: MERGED,
      updatedAt: MERGED,
    });
    expect(state.prs).toEqual([{ number: 51, scope: 'final', mergeSha: A }]);
    expect(h.tracker.fields.get(1)).toMatchObject({ status: 'Awaiting deployment', pendingTargets: 'web' });
    expect(issueOf(h, 1).open).toBe(true);
  });

  it('moves a merged tooling task to done', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    mergedPr(h, 1, 51);

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toEqual(['pr_merged', 'fields_synced', 'issue_closed']);
    expect(await stateOf(h, 1)).toMatchObject({ status: 'done', outcome: 'completed' });
    expect(issueOf(h, 1)).toMatchObject({ open: false, closeReason: 'completed' });
  });

  it('records a partial merge without ending the task, and takes the scope from the body', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling', { prs: [] }));
    mergedPr(h, 1, 51, { body: 'Related to #1\nScope: partial' });

    await reconcile(h.ctx, {});

    const state = await stateOf(h, 1);
    expect(state.status).toBe('in_review');
    expect(state.prs).toEqual([{ number: 51, scope: 'partial', mergeSha: A }]);
  });

  it('reports an unrecognised Scope value as an error and does not record the merge', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    mergedPr(h, 1, 51, { body: 'Related to #1\nScope: everything' });

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(1);
    expect(result.actions).toContainEqual({ issue: 1, kind: 'error', detail: 'unrecognised Scope value on PR #51' });
    expect((await stateOf(h, 1)).prs[0]?.mergeSha).toBeUndefined();

    // Retried once the body is fixed.
    h.tracker.prs[0]!.body = 'Related to #1\nScope: final';
    const retried = await reconcile(h.ctx, {});
    expect(retried.errors).toBe(0);
    expect((await stateOf(h, 1)).status).toBe('done');
  });

  it('never moves updatedAt back to an older GitHub event time', async () => {
    const h = setup();
    const later = '2026-04-01T00:00:00.000Z';
    h.tracker.seedTask(inReview(1, 'feature', { updatedAt: later }));
    mergedPr(h, 1, 51);

    await reconcile(h.ctx, {});

    expect(await stateOf(h, 1)).toMatchObject({ status: 'awaiting_deployment', finalMergedAt: MERGED, updatedAt: later });
  });

  it('applies merges in merge order, a merge without a time last, ties by PR number', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling', { prs: [] }));
    mergedPr(h, 1, 53, { mergedAt: undefined, mergeSha: 'c'.repeat(40), body: 'Related to #1\nScope: partial' });
    mergedPr(h, 1, 52, { mergeSha: 'b'.repeat(40), body: 'Related to #1\nScope: partial' });
    mergedPr(h, 1, 51, { mergedAt: '2026-03-16T00:00:00.000Z', body: 'Related to #1\nScope: partial' });
    mergedPr(h, 1, 54, { mergedAt: undefined, mergeSha: 'd'.repeat(40), body: 'Related to #1\nScope: partial' });

    const result = await reconcile(h.ctx, {});

    expect(result.actions.filter(a => a.kind === 'pr_merged').map(a => a.detail.slice(0, 6))).toEqual([
      'PR #52',
      'PR #51',
      'PR #53',
      'PR #54',
    ]);
  });

  it('ignores PRs that are unmerged or merged into another branch', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    mergedPr(h, 1, 51, { baseRef: 'release' });
    mergedPr(h, 1, 52, { merged: false, mergeSha: undefined, mergedAt: undefined });

    const result = await reconcile(h.ctx, {});

    expect(mutating(result.actions)).toEqual([]);
    expect((await stateOf(h, 1)).status).toBe('in_review');
  });
});

describe('deployments', () => {
  it('closes a task when its last target is deployed and posts the delivery report first', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    const url = deployedToWeb(h);

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(0);
    expect(kinds(result.actions)).toEqual(['targets_deployed', 'delivery_report', 'fields_synced', 'issue_closed']);
    const state = await stateOf(h, 1);
    expect(state).toMatchObject({ status: 'done', outcome: 'completed', pendingTargets: [], deliveredBy: [url] });
    expect(state.updatedAt).toBe(DEPLOYED);

    const [report, ...rest] = visible(h, 1);
    expect(rest).toEqual([]);
    expect(report!.body).toContain('### Delivered');
    expect(report!.body).toContain(url);
    const stateComment = h.tracker.comments.find(c => c.body.startsWith(STATE_MARKER))!;
    expect(Date.parse(stateComment.updatedAt)).toBeGreaterThan(Date.parse(report!.createdAt));
    expect(issueOf(h, 1)).toMatchObject({ open: false, closeReason: 'completed' });
    expect(h.tracker.fields.get(1)?.status).toBe('Done');
  });

  it('keeps waiting while a target is still pending', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1, { targets: ['web', 'api'], pendingTargets: ['web', 'api'] }));
    deployedToWeb(h);

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toEqual(['targets_deployed', 'fields_synced']);
    expect(await stateOf(h, 1)).toMatchObject({ status: 'awaiting_deployment', pendingTargets: ['api'] });
    expect(visible(h, 1)).toEqual([]);
  });

  it('writes no state when the delivery report cannot be posted, and retries next run', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    deployedToWeb(h);
    h.tracker.failNext('postComment');

    const failed = await reconcile(h.ctx, {});
    expect(failed.errors).toBe(1);
    expect(failed.actions.at(-1)).toMatchObject({ issue: 1, kind: 'error' });
    expect((await stateOf(h, 1)).status).toBe('awaiting_deployment');
    expect(issueOf(h, 1).open).toBe(true);

    const retried = await reconcile(h.ctx, {});
    expect(retried.errors).toBe(0);
    expect((await stateOf(h, 1)).status).toBe('done');
    expect(visible(h, 1)).toHaveLength(1);
  });

  it('does not post the delivery report twice when the state write failed after it', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    deployedToWeb(h);
    h.tracker.failNext('writeState');

    const failed = await reconcile(h.ctx, {});
    expect(failed.errors).toBe(1);
    expect(visible(h, 1)).toHaveLength(1);
    expect((await stateOf(h, 1)).status).toBe('awaiting_deployment');

    const retried = await reconcile(h.ctx, {});
    expect(retried.errors).toBe(0);
    expect(kinds(retried.actions)).not.toContain('delivery_report');
    expect(visible(h, 1)).toHaveLength(1);
    expect((await stateOf(h, 1)).status).toBe('done');
  });

  it('ignores a forged delivery report by an untrusted author and posts the real one', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    const url = deployedToWeb(h);
    comment(h, 1, '### Delivered\n\nnothing to see', AFTER, 'drive-by');

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toContain('delivery_report');
    const reports = visible(h, 1).filter(c => c.body.startsWith('### Delivered'));
    expect(reports.map(c => c.author)).toEqual(['drive-by', h.tracker.login]);
    expect(reports[1]!.body).toContain(url);
  });

  it('counts a report by an owner or the Actions bot as already posted', async () => {
    for (const author of ['Shop-Owner', 'GitHub-Actions[bot]']) {
      const h = setup();
      h.tracker.seedTask(awaiting(1));
      deployedToWeb(h);
      comment(h, 1, '### Delivered', AFTER, author);

      const result = await reconcile(h.ctx, {});
      expect(kinds(result.actions)).not.toContain('delivery_report');
      expect((await stateOf(h, 1)).status).toBe('done');
    }
  });

  it('reports an awaiting task without pending targets as an error', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1, { targets: [], pendingTargets: [] }));

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(1);
    expect(result.actions).toContainEqual({ issue: 1, kind: 'error', detail: 'no targets declared' });
  });

  it('reads deployments, releases, ancestry and the login once per run', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1, { pendingTargets: ['web', 'api'], targets: ['web', 'api'] }));
    h.tracker.seedTask(awaiting(2, { pendingTargets: ['web', 'api'], targets: ['web', 'api'] }));
    h.tracker.seedTask(pausedOn(3));
    h.tracker.seedTask(pausedOn(4));
    comment(h, 3, '/approve', AFTER);
    comment(h, 4, '/approve', AFTER);
    deployedToWeb(h);
    const deployments = vi.spyOn(h.tracker, 'listSuccessfulDeployments');
    const ancestry = vi.spyOn(h.tracker, 'isAncestor');
    const login = vi.spyOn(h.tracker, 'authenticatedLogin');

    await reconcile(h.ctx, {});

    expect(deployments.mock.calls.map(([env]) => env).sort()).toEqual(['production-api', 'production-web']);
    expect(ancestry).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
  });
});

describe('issue open state', () => {
  it('restores issue open state from task state', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'feature'), { open: false });
    h.tracker.seedTask(task(2, 'tooling', { status: 'done', outcome: 'completed', waitingOn: 'none' }));
    h.tracker.seedTask(task(3, 'tooling', { status: 'done', outcome: 'cancelled', cancelReason: 'x', waitingOn: 'none' }));

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(0);
    expect(mutating(result.actions)).toEqual([
      { issue: 1, kind: 'issue_reopened', detail: expect.any(String) },
      { issue: 2, kind: 'issue_closed', detail: expect.stringContaining('completed') },
      { issue: 3, kind: 'issue_closed', detail: expect.stringContaining('not_planned') },
    ]);
    expect(issueOf(h, 1).open).toBe(true);
    expect(issueOf(h, 2)).toMatchObject({ open: false, closeReason: 'completed' });
    expect(issueOf(h, 3)).toMatchObject({ open: false, closeReason: 'not_planned' });
  });
});

describe('deployment evidence time', () => {
  it('times the event by the deployment that contains the merges, when deployments share one link', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    h.tracker.ancestors.add(`${A}>${B}`);
    const link = 'https://github.test/deployments/production-web';
    h.tracker.deployments.push({ id: 1, sha: B, environment: 'production-web', url: link, createdAt: DEPLOYED });
    // A later rollback to a commit without the merge, behind the same link.
    h.tracker.deployments.push({
      id: 2,
      sha: 'c'.repeat(40),
      environment: 'production-web',
      url: link,
      createdAt: '2026-03-28T00:00:00.000Z',
    });

    await reconcile(h.ctx, {});

    expect(await stateOf(h, 1)).toMatchObject({ status: 'done', updatedAt: DEPLOYED, deliveredBy: [link] });
  });
});

describe('API cost per run', () => {
  it('scans the task issues once per full run', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature', { phase: 'implementation' }));
    h.tracker.issues.push({ number: 9, title: 'Labelled by hand', body: '', labels: ['sdlc:task'], open: true, onBoard: false });
    const scan = vi.spyOn(h.tracker, 'scanTasks');
    const tracked = vi.spyOn(h.tracker, 'listTrackedTasks');
    const untracked = vi.spyOn(h.tracker, 'listUntracked');

    await reconcile(h.ctx, {});

    expect(scan).toHaveBeenCalledTimes(1);
    expect(tracked).not.toHaveBeenCalled();
    expect(untracked).not.toHaveBeenCalled();
  });

  it('leaves a done task alone when its issue is closed with the right reason', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'tooling', { status: 'done', outcome: 'completed', waitingOn: 'none' }), { open: false });
    h.tracker.seedTask(
      task(2, 'tooling', { status: 'done', outcome: 'cancelled', cancelReason: 'x', waitingOn: 'none' }),
      { open: false },
    );
    const sync = vi.spyOn(h.tracker, 'syncFields');
    const comments = vi.spyOn(h.tracker, 'listComments');

    const result = await reconcile(h.ctx, {});

    expect(result.actions).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
    expect(comments).not.toHaveBeenCalled();
  });

  it('corrects the close reason of a done task closed with the wrong one', async () => {
    const h = setup();
    h.tracker.seedTask(
      task(1, 'tooling', { status: 'done', outcome: 'cancelled', cancelReason: 'x', waitingOn: 'none' }),
      { open: false, closeReason: 'completed' },
    );
    h.tracker.seedTask(task(2, 'tooling', { status: 'done', outcome: 'completed', waitingOn: 'none' }), {
      open: false,
      closeReason: 'not_planned',
    });

    const result = await reconcile(h.ctx, {});

    expect(mutating(result.actions)).toEqual([
      { issue: 1, kind: 'issue_closed', detail: 'close reason corrected to not_planned' },
      { issue: 2, kind: 'issue_closed', detail: 'close reason corrected to completed' },
    ]);
    expect(issueOf(h, 1)).toMatchObject({ open: false, closeReason: 'not_planned' });
    expect(issueOf(h, 2)).toMatchObject({ open: false, closeReason: 'completed' });
    expect((await reconcile(h.ctx, {})).actions).toEqual([]);
  });
});

describe('approvals', () => {
  it('approves the paused stage from an owner comment on the issue', async () => {
    const h = setup();
    h.tracker.seedTask(pausedOn(1));
    const url = comment(h, 1, '/approve', AFTER, 'Shop-Owner');

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toEqual(['approval', 'fields_synced']);
    const state = await stateOf(h, 1);
    expect(state).toMatchObject({ status: 'in_progress', waitingOn: 'agent', updatedAt: AFTER });
    expect(state.stages.brainstorming?.approval).toEqual({ source: 'comment', ref: url, by: 'Shop-Owner', at: AFTER });
  });

  it("reads owner commands on the task's PRs as well", async () => {
    const h = setup();
    h.tracker.seedTask(pausedOn(1));
    mergedPr(h, 1, 51, { merged: false, mergeSha: undefined, mergedAt: undefined });
    const url = comment(h, 51, '/approve', AFTER);

    await reconcile(h.ctx, {});

    expect((await stateOf(h, 1)).stages.brainstorming?.approval?.ref).toBe(url);
  });

  it('ignores stale and non-owner approvals', async () => {
    const h = setup();
    h.tracker.seedTask(pausedOn(1));
    comment(h, 1, '/approve', BEFORE);
    comment(h, 1, '/approve', AFTER, 'drive-by');
    const before = await stateOf(h, 1);

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(0);
    const ignored = result.actions.filter(a => a.kind === 'ignored_approval');
    expect(ignored).toHaveLength(2);
    expect(ignored.map(a => a.detail).join('\n')).toMatch(/not newer than stage "brainstorming"/);
    expect(ignored.map(a => a.detail).join('\n')).toMatch(/drive-by, who is not a configured owner/);
    expect(mutating(result.actions)).toEqual([]);
    expect(await stateOf(h, 1)).toEqual(before);
  });

  it('ignores edited comments and commands that do not fit the state', async () => {
    const h = setup();
    h.tracker.seedTask(pausedOn(1));
    h.tracker.seedTask(inReview(2, 'feature'));
    comment(h, 1, '/approve', AFTER, OWNER, '2026-03-21T00:00:00.000Z');
    comment(h, 1, '/accept', AFTER);
    comment(h, 2, '/approve', AFTER);

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(0);
    expect(result.actions.filter(a => a.kind === 'ignored_approval').map(a => [a.issue, a.detail])).toEqual([
      [1, expect.stringMatching(/was edited after posting/)],
      [1, expect.stringMatching(/does not end on owner acceptance/)],
      [2, expect.stringMatching(/not paused waiting on the owner/)],
    ]);
    expect((await stateOf(h, 1)).status).toBe('paused');
  });

  it("ignores the tool's own comments in enforce mode and records them unverified in observe mode", async () => {
    const enforce = setup(enforceCfg);
    enforce.tracker.login = OWNER;
    enforce.tracker.seedTask(pausedOn(1));
    comment(enforce, 1, '/approve', AFTER);
    const refused = await reconcile(enforce.ctx, {});
    expect(refused.actions[0]).toMatchObject({ kind: 'ignored_approval', detail: expect.stringMatching(/own login/) });
    expect((await stateOf(enforce, 1)).status).toBe('paused');

    const observe = setup();
    observe.tracker.login = OWNER;
    observe.tracker.seedTask(pausedOn(1));
    const url = comment(observe, 1, '/approve', AFTER);
    await reconcile(observe.ctx, {});
    expect((await stateOf(observe, 1)).stages.brainstorming?.approval).toMatchObject({ source: 'unverified', ref: url });
  });

  it('ignores owner commands on a PR that links several tasks', async () => {
    const h = setup();
    h.tracker.seedTask(pausedOn(1));
    h.tracker.prs.push({
      issue: 1,
      number: 51,
      url: 'https://github.test/pull/51',
      merged: false,
      baseRef: 'main',
      body: 'Related to #1, #2\nScope: partial',
    });
    const url = comment(h, 51, '/approve', AFTER);
    const result = await reconcile(h.ctx, {});
    expect(result.actions).toEqual([
      { issue: 1, kind: 'ignored_approval', detail: `/approve (${url}): PR #51 links several tasks` },
    ]);
    expect((await stateOf(h, 1)).status).toBe('paused');
  });

  describe('agent logins (`agents` in the config)', () => {
    const AGENT = 'agent-bot';
    const withAgents = (config: Config): Config => ({ ...config, agents: [AGENT] });

    it('reads state written by an agent login when the owner runs sdlc', async () => {
      const h = setup(withAgents(enforceCfg));
      h.tracker.login = OWNER;
      h.tracker.seedTask(inReview(1, 'tooling'));
      h.tracker.comments.find(c => c.issue === 1)!.author = AGENT;
      const result = await reconcile(h.ctx, {});
      expect(result.actions.filter(a => a.kind === 'error')).toEqual([]);
      expect((await h.tracker.getTask(1)).issue).toBe(1);
    });

    it("ignores an agent's /approve in enforce mode, even when another login runs sdlc", async () => {
      const h = setup(withAgents(enforceCfg));
      h.tracker.login = OWNER;
      h.tracker.seedTask(pausedOn(1));
      const url = comment(h, 1, '/approve', AFTER, AGENT);
      const result = await reconcile(h.ctx, {});
      expect(result.actions[0]).toEqual({
        issue: 1,
        kind: 'ignored_approval',
        detail: `/approve (${url}): comment ${url} is by ${AGENT}, an agent login (listed under \`agents\`); agents cannot approve`,
      });
      expect((await stateOf(h, 1)).status).toBe('paused');
    });

    it("records an agent's /approve as unverified in observe mode", async () => {
      const h = setup(withAgents(cfg));
      h.tracker.login = OWNER;
      h.tracker.seedTask(pausedOn(1));
      const url = comment(h, 1, '/approve', AFTER, AGENT);
      const result = await reconcile(h.ctx, {});
      expect(result.actions[0]).toMatchObject({ kind: 'approval', detail: expect.stringMatching(/unverified/) });
      expect((await stateOf(h, 1)).stages.brainstorming?.approval).toEqual({
        source: 'unverified',
        ref: url,
        by: AGENT,
        at: AFTER,
      });
    });

    it('ignores owner comments in enforce mode when the login is unknown and no agents are listed', async () => {
      const h = setup(enforceCfg);
      vi.spyOn(h.tracker, 'authenticatedLogin').mockResolvedValue(undefined);
      h.tracker.seedTask(pausedOn(1));
      comment(h, 1, '/approve', AFTER);
      const result = await reconcile(h.ctx, {});
      expect(result.actions[0]).toMatchObject({
        kind: 'ignored_approval',
        detail: expect.stringContaining(
          'cannot tell owner from agent comments; list agent logins under `agents` in sdlc.config.yaml',
        ),
      });
      expect((await stateOf(h, 1)).status).toBe('paused');
    });
  });

  it('applies /accept for an analysis task with a published result', async () => {
    const h = setup();
    h.tracker.seedTask({ ...pausedOn(1, 'analysis', 'analysis'), status: 'in_progress', resultPublishedAt: PUBLISHED });
    const url = comment(h, 1, '/accept', AFTER);

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toEqual(['approval', 'fields_synced', 'issue_closed']);
    const state = await stateOf(h, 1);
    expect(state).toMatchObject({ status: 'done', outcome: 'completed' });
    expect(state.outcomeApproval).toMatchObject({ source: 'comment', ref: url });
    expect(issueOf(h, 1)).toMatchObject({ open: false, closeReason: 'completed' });
  });

  it('applies /cancel with reason', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature'));
    comment(h, 1, '/cancel superseded by #9\n\nsorry', AFTER);

    await reconcile(h.ctx, {});

    expect(await stateOf(h, 1)).toMatchObject({ status: 'done', outcome: 'cancelled', cancelReason: 'superseded by #9' });
    expect(issueOf(h, 1)).toMatchObject({ open: false, closeReason: 'not_planned' });
    expect(h.tracker.fields.get(1)?.currentStep).toBe('Cancelled — superseded by #9');
  });

  it('posts the cancel report before the state write', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature'));
    const url = comment(h, 1, '/cancel superseded by #9', AFTER);

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toEqual(['approval', 'cancel_report', 'fields_synced', 'issue_closed']);
    const report = visible(h, 1).at(-1)!;
    expect(report.author).toBe(h.tracker.login);
    expect(report.body).toContain('### Cancelled');
    expect(report.body).toContain('**Reason:** superseded by #9');
    expect(report.body).toContain(`Approved by ${OWNER} (${url})`);
    const stateComment = h.tracker.comments.find(c => c.body.startsWith(STATE_MARKER))!;
    expect(Date.parse(stateComment.updatedAt)).toBeGreaterThan(Date.parse(report.createdAt));
  });

  it('writes nothing when the cancel report cannot be posted, and retries next run', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature'));
    comment(h, 1, '/cancel dropped', AFTER);
    h.tracker.failNext('postComment');

    const failed = await reconcile(h.ctx, {});
    expect(failed.errors).toBe(1);
    expect(failed.actions.at(-1)).toMatchObject({ issue: 1, kind: 'error', detail: expect.stringMatching(/postComment failed/) });
    expect((await stateOf(h, 1)).status).toBe('in_progress');
    expect(issueOf(h, 1).open).toBe(true);
    expect(visible(h, 1)).toHaveLength(1);

    const retried = await reconcile(h.ctx, {});
    expect(retried.errors).toBe(0);
    expect((await stateOf(h, 1)).outcome).toBe('cancelled');
    expect(visible(h, 1).filter(c => c.body.startsWith('### Cancelled'))).toHaveLength(1);
  });

  it('does not post the cancel report twice when the state write failed after it', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature'));
    comment(h, 1, '/cancel dropped', AFTER);
    h.tracker.failNext('writeState');

    expect((await reconcile(h.ctx, {})).errors).toBe(1);
    expect((await stateOf(h, 1)).status).toBe('in_progress');

    const retried = await reconcile(h.ctx, {});
    expect(retried.errors).toBe(0);
    expect(kinds(retried.actions)).not.toContain('cancel_report');
    expect(visible(h, 1).filter(c => c.body.startsWith('### Cancelled'))).toHaveLength(1);
    expect((await stateOf(h, 1)).outcome).toBe('cancelled');
  });

  it('applies /ran only after the final PR merged, using the merge time from GitHub', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'production-data'));
    mergedPr(h, 1, 51);
    comment(h, 1, '/ran', BEFORE);
    comment(h, 1, '/ran', AFTER);

    const result = await reconcile(h.ctx, {});

    expect(kinds(result.actions)).toEqual(['pr_merged', 'ignored_approval', 'approval', 'fields_synced', 'issue_closed']);
    expect(result.actions[1]!.detail).toMatch(/not newer than the final PR merged at 2026-03-15/);
    expect(await stateOf(h, 1)).toMatchObject({ status: 'done', outcome: 'completed' });
  });

  it('skips a comment already recorded as an approval, without an action', async () => {
    const h = setup();
    h.tracker.seedTask(pausedOn(1));
    comment(h, 1, '/approve', AFTER);
    await reconcile(h.ctx, {});

    const second = await reconcile(h.ctx, {});
    expect(second.actions).toEqual([]);
  });
});

describe('robustness', () => {
  it('converges after partial failure', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'feature'));
    mergedPr(h, 1, 51);
    h.tracker.failNext('syncFields');

    const first = await reconcile(h.ctx, {});
    expect(first.errors).toBe(1);
    expect(first.actions).toContainEqual({ issue: 1, kind: 'error', detail: expect.stringMatching(/syncFields failed/) });
    expect(h.tracker.fields.get(1)).toBeUndefined();

    const second = await reconcile(h.ctx, {});
    expect(second.errors).toBe(0);
    expect(h.tracker.fields.get(1)).toMatchObject({ status: 'Awaiting deployment', pendingTargets: 'web' });
  });

  it('is idempotent', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'feature'), { open: false });
    h.tracker.seedTask(inReview(2, 'tooling'));
    h.tracker.seedTask(awaiting(3));
    h.tracker.seedTask(pausedOn(4));
    h.tracker.seedTask(task(5, 'feature'));
    mergedPr(h, 1, 51);
    mergedPr(h, 2, 52);
    deployedToWeb(h);
    comment(h, 4, '/approve', AFTER);
    comment(h, 4, '/approve', AFTER, 'drive-by');
    comment(h, 5, '/cancel dropped', AFTER);

    const first = await reconcile(h.ctx, {});
    expect(first.errors).toBe(0);
    expect(mutating(first.actions).length).toBeGreaterThan(5);
    const board = structuredClone([...h.tracker.fields]);
    const comments = h.tracker.comments.length;

    const second = await reconcile(h.ctx, {});
    expect(second.errors).toBe(0);
    expect(mutating(second.actions)).toEqual([]);
    expect([...h.tracker.fields]).toEqual(board);
    expect(h.tracker.comments).toHaveLength(comments);
  });

  it('skips tasks whose type is no longer configured', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature', { type: 'retired-type' }));
    h.tracker.seedTask(inReview(2, 'tooling'));
    mergedPr(h, 2, 52);

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(0);
    expect(result.actions[0]).toMatchObject({ issue: 1, kind: 'skipped_unknown_type' });
    expect(result.actions[0]!.detail).toContain('retired-type');
    expect(result.actions.filter(a => a.issue === 1)).toHaveLength(1);
    expect((await stateOf(h, 2)).status).toBe('done');
  });

  it('dry run performs no writes', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'feature'), { open: false });
    h.tracker.seedTask(awaiting(2));
    h.tracker.seedTask(pausedOn(3));
    mergedPr(h, 1, 51);
    deployedToWeb(h);
    comment(h, 3, '/approve', AFTER);
    const writes = h.tracker.writes;
    const comments = h.tracker.comments.length;

    const dry = await reconcile(h.ctx, { dryRun: true });

    expect(h.tracker.writes).toBe(writes);
    expect(h.tracker.writes).toBe(0);
    expect(h.tracker.comments).toHaveLength(comments);
    expect(dry.errors).toBe(0);

    const real = await reconcile(h.ctx, {});
    // The same actions, except that a report a dry run did not post says it would be posted.
    const wouldPost = /^would post (delivery report|cancel report) /;
    expect(dry.actions.map(a => ({ ...a, detail: a.detail.replace(wouldPost, '$1 posted ') }))).toEqual(real.actions);
  });

  it('says a dry run would post the delivery and cancel reports, not that it posted them', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    deployedToWeb(h);
    h.tracker.seedTask(pausedOn(2));
    comment(h, 2, '/cancel not needed', AFTER);

    const dry = await reconcile(h.ctx, { dryRun: true });

    const reports = dry.actions.filter(a => a.kind === 'delivery_report' || a.kind === 'cancel_report');
    expect(reports.map(a => [a.issue, a.kind, a.detail])).toEqual([
      [1, 'delivery_report', expect.stringMatching(/^would post delivery report \(/)],
      [2, 'cancel_report', 'would post cancel report (not needed)'],
    ]);
    expect(dry.actions.some(a => a.detail.includes('posted'))).toBe(false);
  });

  it('keeps going after one task fails', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    h.tracker.seedTask(inReview(2, 'tooling'));
    mergedPr(h, 1, 51);
    mergedPr(h, 2, 52);
    h.tracker.failNext('listTaskPrs');

    const result = await reconcile(h.ctx, {});

    expect(result.errors).toBe(1);
    expect(result.actions[0]).toMatchObject({ issue: 1, kind: 'error', detail: expect.stringMatching(/listTaskPrs failed/) });
    expect((await stateOf(h, 1)).status).toBe('in_review');
    expect((await stateOf(h, 2)).status).toBe('done');
  });

  it('ignores a Targets: line on the PR of a type that does not deploy', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    mergedPr(h, 1, 51, { body: 'Related to #1\nTargets: mobile' });
    const result = await reconcile(h.ctx, {});
    expect(result.errors).toBe(0);
    expect(await stateOf(h, 1)).toMatchObject({ status: 'done', targets: [] });
  });

  it('reports a state comment changed during the run as an error, and the next run converges', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature', { phase: 'implementation' }));
    mergedPr(h, 1, 51, { body: 'Related to #1\nScope: final\nTargets: web' });
    h.tracker.concurrentWriteBeforeNextWriteState(1);

    const first = await reconcile(h.ctx, {});
    expect(first.actions).toContainEqual({
      issue: 1,
      kind: 'error',
      detail: 'writeState failed for #1: state of #1 changed since it was read; re-run (the state was not changed)',
    });
    expect((await stateOf(h, 1)).status).toBe('in_progress');

    expect((await reconcile(h.ctx, {})).errors).toBe(0);
    expect((await stateOf(h, 1)).status).toBe('awaiting_deployment');
  });

  describe('final merge before handoff', () => {
    it('takes the targets from the PR body: awaiting deployment pending [web]', async () => {
      const h = setup();
      h.tracker.seedTask(task(1, 'feature', { phase: 'implementation' }));
      mergedPr(h, 1, 51, { body: 'Related to #1\nScope: final\nTargets: web' });

      const result = await reconcile(h.ctx, {});

      expect(result.errors).toBe(0);
      expect(kinds(result.actions)).toContain('pr_merged');
      expect(await stateOf(h, 1)).toMatchObject({
        status: 'awaiting_deployment',
        targets: ['web'],
        pendingTargets: ['web'],
        prs: [{ number: 51, scope: 'final', mergeSha: A }],
      });
    });

    it('without targets: an error every run, the merge not recorded, until review handoff --targets', async () => {
      const h = setup();
      h.tracker.seedTask(task(1, 'feature', { phase: 'implementation' }));
      mergedPr(h, 1, 51);

      const first = await reconcile(h.ctx, {});
      expect(first.actions).toEqual([
        {
          issue: 1,
          kind: 'error',
          detail: 'pr_merged: no targets declared on PR #51; add a Targets: line or run review handoff --targets',
        },
      ]);
      expect(await stateOf(h, 1)).toMatchObject({ status: 'in_progress', prs: [] });
      expect((await reconcile(h.ctx, {})).errors).toBe(1);

      const handedOff = await reviewHandoff(h.ctx, 1, { pr: 51, targets: ['web'] });
      expect(handedOff).toMatchObject({ status: 'in_review', targets: ['web'] });

      const after = await reconcile(h.ctx, {});
      expect(after.errors).toBe(0);
      expect(await stateOf(h, 1)).toMatchObject({
        status: 'awaiting_deployment',
        pendingTargets: ['web'],
        prs: [{ number: 51, scope: 'final', mergeSha: A }],
      });
    });

    it('lets a task already in review declare its targets with review handoff --targets', async () => {
      const h = setup();
      h.tracker.seedTask(inReview(1, 'feature', { targets: [] }));
      mergedPr(h, 1, 51);
      expect((await reconcile(h.ctx, {})).errors).toBe(1);

      await reviewHandoff(h.ctx, 1, { pr: 51, targets: ['web'] });
      await reconcile(h.ctx, {});
      expect(await stateOf(h, 1)).toMatchObject({ status: 'awaiting_deployment', pendingTargets: ['web'] });
    });

    it('refuses an unknown target on the PR and does not record the merge', async () => {
      const h = setup();
      h.tracker.seedTask(task(1, 'feature', { phase: 'implementation' }));
      mergedPr(h, 1, 51, { body: 'Related to #1\nTargets: mobile' });

      const result = await reconcile(h.ctx, {});

      expect(result.actions).toEqual([
        { issue: 1, kind: 'error', detail: 'PR #51: Unknown target "mobile" (configured targets: web, api)' },
      ]);
      expect((await stateOf(h, 1)).prs).toEqual([]);
    });
  });

  it('reports untracked sdlc:task issues in a full run only, as untracked rather than errors', async () => {
    const h = setup();
    h.tracker.seedTask(task(1, 'feature'));
    h.tracker.issues.push({ number: 2, title: 'x', body: '', labels: ['sdlc:task'], open: true, onBoard: true });

    const full = await reconcile(h.ctx, {});
    expect(full.errors).toBe(0);
    expect(full.actions).toContainEqual({
      issue: 2,
      kind: 'untracked',
      detail: 'untracked sdlc:task issue: missing state comment',
    });

    expect((await reconcile(h.ctx, { issue: 1 })).actions.some(a => a.kind === 'untracked')).toBe(false);
    expect((await reconcile(h.ctx, { only: 'deployments' })).actions.some(a => a.kind === 'untracked')).toBe(false);
  });
});

describe('options', () => {
  it('limits the run to one issue, and reports an untracked one as an error', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    h.tracker.seedTask(inReview(2, 'tooling'));
    mergedPr(h, 1, 51);
    mergedPr(h, 2, 52);

    const result = await reconcile(h.ctx, { issue: 2 });
    expect(result.actions.every(a => a.issue === 2)).toBe(true);
    expect((await stateOf(h, 1)).status).toBe('in_review');
    expect((await stateOf(h, 2)).status).toBe('done');

    const missing = await reconcile(h.ctx, { issue: 99 });
    expect(missing.errors).toBe(1);
    expect(missing.actions).toEqual([{ issue: 99, kind: 'error', detail: expect.any(String) }]);
  });

  it('only processes tasks awaiting deployment with only: deployments', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    h.tracker.seedTask(awaiting(2));
    mergedPr(h, 1, 51);
    deployedToWeb(h);

    const result = await reconcile(h.ctx, { only: 'deployments' });

    expect(result.actions.every(a => a.issue === 2)).toBe(true);
    expect((await stateOf(h, 1)).status).toBe('in_review');
    expect((await stateOf(h, 2)).status).toBe('done');
  });
});

describe('deployRecord', () => {
  it('reconciles deployments after recording and returns the actions', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1));
    h.tracker.defaultBranchShas.add(B);
    h.tracker.ancestors.add(`${A}>${B}`);

    const recorded = await deployRecord(h.ctx, { target: 'web', sha: B });

    expect(recorded.sha).toBe(B);
    expect(recorded.reconcile.errors).toBe(0);
    expect(kinds(recorded.reconcile.actions)).toEqual([
      'targets_deployed',
      'delivery_report',
      'fields_synced',
      'issue_closed',
    ]);
    expect((await stateOf(h, 1)).status).toBe('done');
  });
});

describe('sdlc reconcile', () => {
  const run = async (h: Harness, ...args: string[]) => {
    const program = new Command().exitOverride();
    registerReconcileCommand(program, () => h.ctx);
    await program.parseAsync(['node', 'sdlc', 'reconcile', ...args]);
  };

  it('prints the actions as JSON and exits 0 without errors', async () => {
    const h = setup();
    h.tracker.seedTask(inReview(1, 'tooling'));
    mergedPr(h, 1, 51);
    await run(h, '--dry-run', '--json');
    const printed = JSON.parse(h.out[0] as string) as { actions: ReconcileAction[]; errors: number };
    expect(printed.errors).toBe(0);
    expect(kinds(printed.actions)).toContain('pr_merged');
    expect(h.tracker.writes).toBe(0);
    expect(process.exitCode).toBe(exitCode);
  });

  it('exits 1 when any action is an error, and prints human text', async () => {
    const h = setup();
    h.tracker.seedTask(awaiting(1, { targets: [], pendingTargets: [] }));
    await run(h, '--issue', '1');
    expect(h.out[0]).toContain('#1 error: no targets declared');
    expect(process.exitCode).toBe(1);
  });
});
