import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/schema.js';
import type { BoardFields } from '../../src/core/projection.js';
import { renderStateComment, StateCommentError } from '../../src/core/stateComment.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import { GhError } from '../../src/github/gh.js';
import { resolveFieldIds } from '../../src/github/board.js';
import { GitHubTracker } from '../../src/github/githubTracker.js';
import { fakeGh, type FakeGh, type FakeGhStep } from '../support/fakeGh.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
/** valid.yaml: repo acme/shop, org project acme #7, default branch main. */
const cfg = loadConfig(join(FIXTURES, 'config/valid.yaml'));

const fixture = (name: string): string => readFileSync(join(FIXTURES, 'gh', name), 'utf8');
const json = <T>(name: string): T => JSON.parse(fixture(name)) as T;

const ok = (match: string[], stdout: string): FakeGhStep => ({ match, stdout });
const fromFixture = (match: string[], name: string): FakeGhStep => ok(match, fixture(name));
const failing = (match: string[], stderr: string): FakeGhStep => ({ match, code: 1, stderr });

const ISSUE_LIST = [
  'issue', 'list', '--repo', 'acme/shop', '--label', 'sdlc:task', '--state', 'all',
  '--json', 'number,title,state', '--limit', '500',
];
const LOGIN = ok(['api', 'user', '-q', '.login'], 'octo-agent\n');
const comments = (issue: number, name?: string): FakeGhStep =>
  fromFixture(['api', '--paginate', `repos/acme/shop/issues/${issue}/comments?per_page=100`], name ?? `comments-${issue}.json`);

/** What the Nth gh call sent on stdin, as a GraphQL or REST body. */
const sent = (run: FakeGh, index: number): { query: string; variables: Record<string, any> } =>
  JSON.parse(run.inputs[index] as string);
const body = (run: FakeGh, index: number): any => JSON.parse(run.inputs[index] as string);

interface ProjectResponse {
  data: { owner: { projectV2: { fields: { nodes: { id: string; name: string; options?: { id: string; name: string }[] }[] } } } };
}
const projectFields = json<ProjectResponse>('project-fields.json').data.owner.projectV2.fields.nodes;
const fieldId = (name: string): string => projectFields.find(f => f.name === name)!.id;
const optionId = (field: string, option: string): string =>
  projectFields.find(f => f.name === field)!.options!.find(o => o.name === option)!.id;

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'sdlc-tracker-'));
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function trackerFor(script: FakeGhStep[]): { run: FakeGh; tracker: GitHubTracker } {
  const run = fakeGh(script);
  return { run, tracker: new GitHubTracker(run, cfg, { repoRoot }) };
}

/** Fills `.sdlc/cache/fields.json` of the temp checkout as a previous `sdlc` run would have. */
async function seedFieldCache(rename?: (project: ProjectResponse['data']['owner']['projectV2']) => void): Promise<void> {
  const response = json<ProjectResponse>('project-fields.json');
  rename?.(response.data.owner.projectV2);
  await resolveFieldIds(fakeGh([ok(['graphql'], JSON.stringify(response))]), cfg, { repoRoot });
}

const feature = BUILTIN_TYPES.find(t => t.id === 'feature')!;
const task = (issue: number) =>
  newTask({ issue, type: feature, summary: 'Add CSV export to the orders page', now: '2026-11-27T10:00:00.000Z' });

/** Matches the board item fixture (issue 12), so a sync with these fields writes nothing. */
const boardFields: BoardFields = {
  status: 'In progress',
  phase: 'Implementation',
  type: 'Feature',
  waitingOn: 'Agent',
  summary: 'Add CSV export to the orders page',
  currentStep: 'Writing the export endpoint',
  nextStep: '',
  pendingTargets: 'web',
  agent: 'octo-agent',
  lastUpdate: '2026-11-20T09:30:00.000Z',
};
const GRAPHQL = ['api', 'graphql', '--input', '-'];
const graphqlOk = (name: string): FakeGhStep => fromFixture(GRAPHQL, name);

describe('GitHubTracker tracked tasks', () => {
  const listScript = (): FakeGhStep[] => [
    fromFixture(ISSUE_LIST, 'issue-list.json'),
    LOGIN,
    comments(12),
    comments(13),
    comments(14),
    comments(15),
    comments(16),
  ];

  it('lists tracked tasks and skips issues without state', async () => {
    const { run, tracker } = trackerFor(listScript());
    const tasks = await tracker.listTrackedTasks();

    expect(tasks.map(t => t.issue)).toEqual([12, 13]);
    expect(tasks[0]).toMatchObject({
      issue: 12,
      title: 'Add CSV export to the orders page',
      issueOpen: true,
      stateCommentId: '5003',
      state: { status: 'in_progress', phase: 'implementation', summary: 'Add CSV export to the orders page' },
    });
    // Written by the Actions bot, on a closed issue.
    expect(tasks[1]).toMatchObject({ issue: 13, issueOpen: false, stateCommentId: '5101', state: { status: 'done' } });
    expect(run.calls).toHaveLength(7);
  });

  it('ignores a state-marker comment written by anyone but the user or the Actions bot', async () => {
    const { tracker } = trackerFor(listScript());
    const [first] = await tracker.listTrackedTasks();
    // Issue 12 carries a forged "done" state comment from another login, posted before the real one.
    expect(first!.state.status).toBe('in_progress');
    expect(first!.state.summary).not.toBe('FORGED');
  });

  it('never throws on a corrupt state comment', async () => {
    const { tracker } = trackerFor(listScript());
    await expect(tracker.listTrackedTasks()).resolves.toHaveLength(2);
  });

  describe('trusted state-comment authors', () => {
    const view = (issue: number): FakeGhStep =>
      fromFixture(['issue', 'view', String(issue), '--repo', 'acme/shop', '--json', 'number,title,state'], `issue-view-${issue}.json`);

    it('trusts a state comment written by a configured owner, not only by the authenticated login', async () => {
      // Issue 17: octo-agent (the login) only chatted; the state comment is by shop-owner.
      const { tracker } = trackerFor([view(17), LOGIN, comments(17)]);
      expect(await tracker.getTask(17)).toMatchObject({
        issue: 17,
        stateCommentId: '5502',
        state: { summary: 'Owner-written state', status: 'in_progress' },
      });
    });

    it('lists an owner-tracked issue as tracked, not untracked', async () => {
      const list = [{ number: 17, title: 'Owner-tracked task', state: 'OPEN' }];
      const { tracker } = trackerFor([ok(ISSUE_LIST, JSON.stringify(list)), LOGIN, comments(17)]);
      expect((await tracker.listTrackedTasks()).map(t => t.issue)).toEqual([17]);
    });

    it('compares authors case-insensitively', async () => {
      const shouting = ok(['api', 'user', '-q', '.login'], 'Octo-Agent\n');
      const { tracker } = trackerFor([view(12), shouting, comments(12)]);
      // Issue 12's real state comment is by "octo-agent".
      expect(await tracker.getTask(12)).toMatchObject({ stateCommentId: '5003' });
    });

    it('reads the trusted state comment with the newest updated_at when several exist', async () => {
      // Issue 18: octo-agent (older), shop-owner (edited last), the Actions bot (in between).
      const { tracker } = trackerFor([view(18), LOGIN, comments(18)]);
      expect(await tracker.getTask(18)).toMatchObject({ stateCommentId: '5602', state: { status: 'blocked' } });
    });

    it('lists the newest trusted state comment too', async () => {
      const list = [{ number: 18, title: 'Diverged copies', state: 'OPEN' }];
      const { tracker } = trackerFor([ok(ISSUE_LIST, JSON.stringify(list)), LOGIN, comments(18)]);
      const [only] = await tracker.listTrackedTasks();
      expect(only).toMatchObject({ stateCommentId: '5602', state: { status: 'blocked' } });
    });

    it('still ignores an intruder state comment, even when it was edited more recently', async () => {
      const { tracker } = trackerFor([view(19), LOGIN, comments(19)]);
      expect(await tracker.getTask(19)).toMatchObject({
        stateCommentId: '5701',
        state: { summary: 'Real state', status: 'in_progress' },
      });
    });
  });

  it('listUntracked reports sdlc:task issues with a missing or unreadable state comment', async () => {
    const { tracker } = trackerFor(listScript());
    expect(await tracker.listUntracked()).toEqual([
      { issue: 14, title: 'Labelled by hand', reason: 'missing state comment' },
      { issue: 15, title: 'Corrupt state comment', reason: expect.stringContaining('invalid JSON') },
      // Only a forged state comment: it does not count, so the issue has none.
      { issue: 16, title: 'Spoofed state', reason: 'missing state comment' },
    ]);
  });

  it('asks for no comments and no login when no issue carries the label', async () => {
    const { run, tracker } = trackerFor([ok(ISSUE_LIST, '[]')]);
    expect(await tracker.listTrackedTasks()).toEqual([]);
    expect(run.calls).toHaveLength(1);
  });

  it('refuses to list when the issue list may have been cut off', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ number: i + 1, title: `T${i}`, state: 'OPEN' }));
    const { tracker } = trackerFor([ok(ISSUE_LIST, JSON.stringify(many))]);
    await expect(tracker.listTrackedTasks()).rejects.toThrow(/500/);
  });

  it('getTask reads one issue and its state comment', async () => {
    const { run, tracker } = trackerFor([
      fromFixture(['issue', 'view', '12', '--repo', 'acme/shop', '--json', 'number,title,state'], 'issue-view-12.json'),
      LOGIN,
      comments(12),
    ]);
    expect(await tracker.getTask(12)).toMatchObject({
      issue: 12,
      issueOpen: true,
      stateCommentId: '5003',
      state: { issue: 12, status: 'in_progress' },
    });
    expect(run.calls).toHaveLength(3);
  });

  it('getTask throws when the issue has no state comment', async () => {
    const { tracker } = trackerFor([
      ok(['issue', 'view', '14'], JSON.stringify({ number: 14, title: 'Labelled by hand', state: 'OPEN' })),
      LOGIN,
      comments(14),
    ]);
    await expect(tracker.getTask(14)).rejects.toThrow(/#14 has no state comment/);
  });

  it('getTask throws StateCommentError when the state comment is corrupt', async () => {
    const { tracker } = trackerFor([
      ok(['issue', 'view', '15'], JSON.stringify({ number: 15, title: 'Corrupt', state: 'OPEN' })),
      LOGIN,
      comments(15),
    ]);
    await expect(tracker.getTask(15)).rejects.toBeInstanceOf(StateCommentError);
  });
});

describe('GitHubTracker login', () => {
  const view12 = ok(['issue', 'view', '12'], fixture('issue-view-12.json'));

  it('looks the authenticated user up once per instance', async () => {
    const { run, tracker } = trackerFor([view12, LOGIN, comments(12), view12, comments(12)]);
    await tracker.getTask(12);
    await tracker.getTask(12);
    expect(run.calls.filter(args => args.includes('user'))).toHaveLength(1);
  });

  it('exposes the login, and none when the token may not read /user', async () => {
    const own = trackerFor([LOGIN]);
    await expect(own.tracker.authenticatedLogin()).resolves.toBe('octo-agent');
    await expect(own.tracker.authenticatedLogin()).resolves.toBe('octo-agent');
    expect(own.run.calls).toHaveLength(1);

    const forbidden = trackerFor([failing(['api', 'user'], 'gh: Resource not accessible by integration (HTTP 403)')]);
    await expect(forbidden.tracker.authenticatedLogin()).resolves.toBeUndefined();
  });

  it('retries the lookup after it failed', async () => {
    const { run, tracker } = trackerFor([
      view12,
      failing(['api', 'user'], 'gh: Bad gateway (HTTP 502)'),
      view12,
      LOGIN,
      comments(12),
    ]);
    await expect(tracker.getTask(12)).rejects.toThrow(/502/);
    await expect(tracker.getTask(12)).resolves.toMatchObject({ issue: 12 });
    expect(run.calls.filter(args => args.includes('user'))).toHaveLength(2);
  });

  it('trusts only the Actions bot and the owners when the token may not read /user', async () => {
    const forbidden = failing(['api', 'user'], 'gh: Resource not accessible by integration (HTTP 403)');
    const { tracker } = trackerFor([
      ok(['issue', 'view', '13'], fixture('issue-view-13.json')),
      forbidden,
      comments(13),
      view12,
      comments(12),
      ok(['issue', 'view', '17'], fixture('issue-view-17.json')),
      comments(17),
    ]);
    await expect(tracker.getTask(13)).resolves.toMatchObject({ issue: 13, issueOpen: false });
    // Issue 12's real state comment is by octo-agent, which is now not trusted.
    await expect(tracker.getTask(12)).rejects.toThrow(/no state comment/);
    // Issue 17's is by an owner, who is always trusted.
    await expect(tracker.getTask(17)).resolves.toMatchObject({ stateCommentId: '5502' });
  });
});

describe('GitHubTracker.writeState', () => {
  it('writeState patches existing comment', async () => {
    const state = task(12);
    const { run, tracker } = trackerFor([
      LOGIN,
      comments(12),
      ok(['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/5003', '--input', '-'], '{}'),
    ]);
    await tracker.writeState(12, state);
    expect(run.calls).toHaveLength(3);
    expect(body(run, 2)).toEqual({ body: renderStateComment(state) });
  });

  it('writeState creates comment when absent', async () => {
    const state = task(14);
    const { run, tracker } = trackerFor([
      LOGIN,
      comments(14),
      ok(['api', '-X', 'POST', 'repos/acme/shop/issues/14/comments', '--input', '-'], fixture('comment-created.json')),
    ]);
    await tracker.writeState(14, state);
    expect(body(run, 2)).toEqual({ body: renderStateComment(state) });
  });

  it('does not patch a forged state comment, it posts its own', async () => {
    const { run, tracker } = trackerFor([
      LOGIN,
      comments(16),
      ok(['api', '-X', 'POST', 'repos/acme/shop/issues/16/comments', '--input', '-'], fixture('comment-created.json')),
    ]);
    await tracker.writeState(16, task(16));
    expect(run.calls[2]).not.toContain('PATCH');
  });

  it('patches the newest of several trusted state comments, and an owner-written one', async () => {
    const { run, tracker } = trackerFor([
      LOGIN,
      comments(18),
      ok(['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/5602', '--input', '-'], '{}'),
      comments(17),
      ok(['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/5502', '--input', '-'], '{}'),
    ]);
    await tracker.writeState(18, task(18));
    await tracker.writeState(17, task(17));
    expect(run.calls).toHaveLength(5);
  });

  it('never patches an intruder comment, however recently it was edited', async () => {
    const { run, tracker } = trackerFor([
      LOGIN,
      comments(19),
      ok(['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/5701', '--input', '-'], '{}'),
    ]);
    await tracker.writeState(19, task(19));
    expect(run.calls[2]).toContain('repos/acme/shop/issues/comments/5701');
  });

  describe('when the PATCH is refused', () => {
    const patch = (stderr: string): FakeGhStep => failing(['PATCH'], stderr);
    const post = ok(['api', '-X', 'POST', 'repos/acme/shop/issues/12/comments', '--input', '-'], fixture('comment-created.json'));

    it.each([
      ['403', 'gh: Resource not accessible by integration (HTTP 403)'],
      ['404', 'gh: Not Found (HTTP 404)'],
    ])('posts a new state comment after HTTP %s', async (_code, stderr) => {
      const state = task(12);
      const { run, tracker } = trackerFor([LOGIN, comments(12), patch(stderr), post]);
      await tracker.writeState(12, state);
      expect(run.calls).toHaveLength(4);
      expect(run.calls[2]).toContain('repos/acme/shop/issues/comments/5003');
      expect(run.calls[3]).toContain('repos/acme/shop/issues/12/comments');
      expect(body(run, 3)).toEqual({ body: renderStateComment(state) });
    });

    it('rejects, and posts nothing, on any other failure such as HTTP 500', async () => {
      const { run, tracker } = trackerFor([LOGIN, comments(12), patch('gh: Server error (HTTP 500)'), post]);
      await expect(tracker.writeState(12, task(12))).rejects.toThrow(/500/);
      expect(run.calls).toHaveLength(3);
    });

    it('rejects when the fallback POST fails too', async () => {
      const { tracker } = trackerFor([
        LOGIN,
        comments(12),
        patch('gh: Resource not accessible by integration (HTTP 403)'),
        failing(['POST'], 'gh: Forbidden (HTTP 403)'),
      ]);
      await expect(tracker.writeState(12, task(12))).rejects.toBeInstanceOf(GhError);
    });
  });
});

describe('GitHubTracker issues and comments', () => {
  it('creates an issue with its labels and returns number and html url', async () => {
    const { run, tracker } = trackerFor([
      ok(['api', '-X', 'POST', 'repos/acme/shop/issues', '--input', '-'], fixture('issue-created.json')),
    ]);
    const created = await tracker.createIssue('Add CSV export', 'Export orders as CSV.', ['sdlc:task', 'type:feature']);
    expect(created).toEqual({ number: 21, url: 'https://github.com/acme/shop/issues/21' });
    expect(body(run, 0)).toEqual({
      title: 'Add CSV export',
      body: 'Export orders as CSV.',
      labels: ['sdlc:task', 'type:feature'],
    });
  });

  it('posts a comment and returns its id', async () => {
    const { run, tracker } = trackerFor([
      ok(['api', '-X', 'POST', 'repos/acme/shop/issues/12/comments', '--input', '-'], fixture('comment-created.json')),
    ]);
    expect(await tracker.postComment(12, 'Heads up: tests are red.')).toBe('5010');
    expect(body(run, 0)).toEqual({ body: 'Heads up: tests are red.' });
  });

  it('lists comments oldest first, mapped to the interface', async () => {
    const { tracker } = trackerFor([comments(12)]);
    const listed = await tracker.listComments(12);
    expect(listed.map(c => c.id)).toEqual(['5001', '5002', '5003', '5004']);
    expect(listed[0]).toEqual({
      id: '5001',
      url: 'https://github.com/acme/shop/issues/12#issuecomment-5001',
      author: 'shop-owner',
      body: 'Please keep the export streaming.',
      createdAt: '2026-11-19T08:00:00Z',
      updatedAt: '2026-11-19T08:00:00Z',
    });
  });

  it('carries updated_at so an edited comment can be told from an untouched one', async () => {
    const row = (id: number, created: string, updated?: string) => ({
      id,
      html_url: `https://github.com/acme/shop/issues/12#issuecomment-${id}`,
      user: { login: 'shop-owner' },
      body: '/approve',
      created_at: created,
      ...(updated && { updated_at: updated }),
    });
    const { tracker } = trackerFor([
      ok(
        ['api', '--paginate', 'repos/acme/shop/issues/12/comments?per_page=100'],
        JSON.stringify([
          row(1, '2026-11-19T08:00:00Z', '2026-11-19T08:00:00Z'),
          row(2, '2026-11-19T09:00:00Z', '2026-11-20T09:00:00Z'),
          row(3, '2026-11-19T10:00:00Z'),
        ]),
      ),
    ]);
    const listed = await tracker.listComments(12);
    expect(listed.map(c => [c.createdAt, c.updatedAt])).toEqual([
      ['2026-11-19T08:00:00Z', '2026-11-19T08:00:00Z'],
      ['2026-11-19T09:00:00Z', '2026-11-20T09:00:00Z'],
      ['2026-11-19T10:00:00Z', '2026-11-19T10:00:00Z'],
    ]);
  });

  it('keeps only comments created strictly after since, whatever the server returned', async () => {
    const { run, tracker } = trackerFor([
      fromFixture(
        ['api', '--paginate', 'repos/acme/shop/issues/12/comments?per_page=100&since=2026-11-19T08%3A30%3A00.000Z'],
        'comments-12.json',
      ),
    ]);
    // 5002 was created exactly at `since`, so it is excluded.
    const listed = await tracker.listComments(12, '2026-11-19T08:30:00Z');
    expect(listed.map(c => c.id)).toEqual(['5003', '5004']);
    expect(run.calls).toHaveLength(1);
  });

  it('rejects a since timestamp that is not a date', async () => {
    const { run, tracker } = trackerFor([]);
    await expect(tracker.listComments(12, 'yesterday')).rejects.toThrow(/since/);
    expect(run.calls).toHaveLength(0);
  });

  it('joins pages whether gh stitched them into one array or printed one array per page', async () => {
    const all = json<unknown[]>('comments-12.json');
    const separate = `${JSON.stringify(all.slice(0, 2))}\n${JSON.stringify(all.slice(2))}`;
    const { tracker } = trackerFor([ok(['--paginate'], separate)]);
    const listed = await tracker.listComments(12);
    expect(listed.map(c => c.id)).toEqual(['5001', '5002', '5003', '5004']);
  });

  it('is not confused by brackets inside comment bodies when joining pages', async () => {
    const tricky = [{ id: 1, html_url: 'u', user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z', body: 'a][b "]" [' }];
    const { tracker } = trackerFor([ok(['--paginate'], `${JSON.stringify(tricky)}${JSON.stringify(tricky)}`)]);
    expect((await tracker.listComments(12)).map(c => c.body)).toEqual(['a][b "]" [', 'a][b "]" [']);
  });

  it('closes an issue as completed or not planned, and reopens it', async () => {
    const patch = ok(['api', '-X', 'PATCH', 'repos/acme/shop/issues/12', '--input', '-'], '{}');
    const { run, tracker } = trackerFor([patch, patch, patch, patch]);
    await tracker.setIssueOpen(12, false, 'completed');
    await tracker.setIssueOpen(12, false, 'not_planned');
    await tracker.setIssueOpen(12, false);
    await tracker.setIssueOpen(12, true);
    expect(body(run, 0)).toEqual({ state: 'closed', state_reason: 'completed' });
    expect(body(run, 1)).toEqual({ state: 'closed', state_reason: 'not_planned' });
    expect(body(run, 2)).toEqual({ state: 'closed' });
    expect(body(run, 3)).toEqual({ state: 'open' });
  });

  it('removes labels before adding, and tolerates a label that was not on the issue', async () => {
    const { run, tracker } = trackerFor([
      ok(['api', '-X', 'DELETE', 'repos/acme/shop/issues/12/labels/sdlc%3Apartial'], '[]'),
      failing(['api', '-X', 'DELETE', 'repos/acme/shop/issues/12/labels/gone'], 'gh: Label does not exist (HTTP 404)'),
      ok(['api', '-X', 'POST', 'repos/acme/shop/issues/12/labels', '--input', '-'], '[]'),
    ]);
    await tracker.setLabels(12, ['type:feature'], ['sdlc:partial', 'gone']);
    expect(body(run, 2)).toEqual({ labels: ['type:feature'] });
  });

  it('does not tolerate any other failure to remove a label', async () => {
    const { tracker } = trackerFor([
      failing(['api', '-X', 'DELETE'], 'gh: Not Found (HTTP 404)'),
    ]);
    await expect(tracker.setLabels(12, [], ['x'])).rejects.toThrow(/Not Found/);
  });

  it('makes no call when there are no label changes', async () => {
    const { run, tracker } = trackerFor([]);
    await tracker.setLabels(12, [], []);
    expect(run.calls).toHaveLength(0);
  });
});

describe('GitHubTracker board', () => {
  const boardQuery = (name: string): FakeGhStep => graphqlOk(name);
  const updated = graphqlOk('board-item-updated.json');
  const cleared = graphqlOk('board-item-cleared.json');
  const mutation = (run: FakeGh, index: number) => sent(run, index);

  it('syncFields only writes changed fields', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json'), updated, updated, cleared, updated]);
    await tracker.syncFields(12, {
      ...boardFields,
      status: 'In review',
      nextStep: 'Open the PR',
      agent: '',
      lastUpdate: '2026-11-27T10:00:00.000Z',
    });

    expect(run.calls).toHaveLength(5);
    // The board query names the issue and the configured project.
    expect(sent(run, 0).variables).toMatchObject({
      repoOwner: 'acme', repoName: 'shop', issue: 12, projectOwner: 'acme', projectNumber: 7,
    });
    const ids = { projectId: 'PVT_kwDOBx7', itemId: 'PVTI_lADOBx7_12' };
    expect(mutation(run, 1).variables.input).toEqual({
      ...ids, fieldId: fieldId('Status'), value: { singleSelectOptionId: optionId('Status', 'In review') },
    });
    expect(mutation(run, 2).variables.input).toEqual({
      ...ids, fieldId: fieldId('Next step'), value: { text: 'Open the PR' },
    });
    expect(mutation(run, 3).query).toContain('clearProjectV2ItemFieldValue');
    expect(mutation(run, 3).variables.input).toEqual({ ...ids, fieldId: fieldId('Agent') });
    expect(mutation(run, 4).variables.input).toEqual({
      ...ids, fieldId: fieldId('Last update'), value: { text: '2026-11-27T10:00:00.000Z' },
    });
  });

  it('syncFields writes nothing when no field changed', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json')]);
    await tracker.syncFields(12, boardFields);
    expect(run.calls).toHaveLength(1);
  });

  it('syncFields matches single-select values to options case-insensitively', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json'), updated]);
    await tracker.syncFields(12, { ...boardFields, status: 'in progress', phase: 'REVIEW' });
    // "in progress" is the current option, so only Phase is written.
    expect(run.calls).toHaveLength(2);
    expect(mutation(run, 1).variables.input.value).toEqual({ singleSelectOptionId: optionId('Phase', 'Review') });
  });

  it('syncFields names the field and value when an option does not exist, before writing anything', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json')]);
    const attempt = tracker.syncFields(12, { ...boardFields, nextStep: 'x', status: 'Shipped' });
    await expect(attempt).rejects.toThrow(/Status.*Shipped.*sdlc board ensure/);
    expect(run.calls).toHaveLength(1);
  });

  it('syncFields adds an issue that is not on the board first', async () => {
    await seedFieldCache();
    // Nine non-empty fields are written; the empty Next step is cleared, as the item's values are unknown.
    const writes = [...Array.from({ length: 6 }, () => updated), cleared, ...Array.from({ length: 3 }, () => updated)];
    const { run, tracker } = trackerFor([boardQuery('board-item-absent.json'), graphqlOk('board-item-add.json'), ...writes]);
    await tracker.syncFields(12, boardFields);

    expect(sent(run, 1).query).toContain('addProjectV2ItemById');
    expect(sent(run, 1).variables.input).toEqual({ projectId: 'PVT_kwDOBx7', contentId: 'I_kwDOBx12' });
    expect(run.calls).toHaveLength(2 + 10);
    expect(mutation(run, 2).variables.input).toMatchObject({ itemId: 'PVTI_lADOBx7_new' });
    expect(mutation(run, 11).variables.input).toMatchObject({ fieldId: fieldId('Last update') });
  });

  it('syncFields clears an empty field of an item whose values it did not read', async () => {
    await seedFieldCache();
    // GitHub hands back an item that may already carry values (a concurrent add); only the new
    // item's id is known, so a stale value could be hiding behind each empty desired value.
    const { run, tracker } = trackerFor([
      boardQuery('board-item-absent.json'),
      graphqlOk('board-item-add.json'),
      ...Array.from({ length: 6 }, () => updated),
      cleared,
      ...Array.from({ length: 3 }, () => updated),
    ]);
    await tracker.syncFields(12, boardFields);
    const clears = run.calls.map((_, i) => i).filter(i => i >= 2 && sent(run, i).query.includes('clearProjectV2ItemFieldValue'));
    expect(clears).toHaveLength(1);
    expect(mutation(run, clears[0]!).variables.input).toEqual({
      projectId: 'PVT_kwDOBx7', itemId: 'PVTI_lADOBx7_new', fieldId: fieldId('Next step'),
    });
  });

  it('syncFields does not clear an empty field of an item it read when the board has no value for it', async () => {
    await seedFieldCache();
    // board-item-12 has no Next step value and boardFields.nextStep is ''.
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json')]);
    await tracker.syncFields(12, boardFields);
    expect(run.calls).toHaveLength(1);
  });

  it('syncFields asks for pageInfo on the project items and on the field values', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json')]);
    await tracker.syncFields(12, boardFields);
    expect(sent(run, 0).query.match(/pageInfo \{ hasNextPage \}/g)).toHaveLength(2);
  });

  it.each([
    ['project items', (issue: any) => { issue.projectItems.pageInfo.hasNextPage = true; }, /more than 50 project/],
    [
      'field values',
      (issue: any) => {
        issue.projectItems.nodes.find((n: any) => n.project.id === 'PVT_kwDOBx7').fieldValues.pageInfo.hasNextPage = true;
      },
      /more than 50 field values/,
    ],
  ])('syncFields refuses to write when the %s were cut off', async (_what, cut, message) => {
    await seedFieldCache();
    const response = json<any>('board-item-12.json');
    cut(response.data.repository.issue);
    const { run, tracker } = trackerFor([ok(GRAPHQL, JSON.stringify(response))]);
    await expect(tracker.syncFields(12, { ...boardFields, nextStep: 'x' })).rejects.toThrow(message);
    expect(run.calls).toHaveLength(1);
  });

  it('syncFields ignores a cut-off list of field values on another project\'s item', async () => {
    await seedFieldCache();
    const response = json<any>('board-item-12.json');
    response.data.repository.issue.projectItems.nodes.find((n: any) => n.project.id !== 'PVT_kwDOBx7')
      .fieldValues.pageInfo.hasNextPage = true;
    const { run, tracker } = trackerFor([ok(GRAPHQL, JSON.stringify(response))]);
    await tracker.syncFields(12, boardFields);
    expect(run.calls).toHaveLength(1);
  });

  it('addToBoard refuses to guess when the project items were cut off', async () => {
    const response = json<any>('board-item-absent.json');
    response.data.repository.issue.projectItems.pageInfo.hasNextPage = true;
    const { run, tracker } = trackerFor([ok(GRAPHQL, JSON.stringify(response))]);
    await expect(tracker.addToBoard(12)).rejects.toThrow(/more than 50 project/);
    expect(run.calls).toHaveLength(1);
  });

  it('syncFields picks the item of the configured project, not another project with the same number', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json'), updated]);
    await tracker.syncFields(12, { ...boardFields, nextStep: 'Open the PR' });
    expect(mutation(run, 1).variables.input.itemId).toBe('PVTI_lADOBx7_12');
  });

  it('syncFields refreshes the field ids once and retries when a write names an unknown id', async () => {
    await seedFieldCache(project => {
      project.fields.nodes.find(f => f.name === 'Status')!.id = 'PVTSSF_stale';
    });
    const { run, tracker } = trackerFor([
      boardQuery('board-item-12.json'),
      failing(GRAPHQL, "gh: Could not resolve to a node with the global id of 'PVTSSF_stale'"),
      graphqlOk('project-fields.json'),
      updated,
      updated,
      cleared,
      updated,
    ]);
    await tracker.syncFields(12, {
      ...boardFields,
      status: 'In review',
      nextStep: 'Open the PR',
      agent: '',
      lastUpdate: '2026-11-27T10:00:00.000Z',
    });

    expect(run.calls).toHaveLength(7);
    expect(sent(run, 2).query).toContain('projectV2(number: $number)');
    // The retried write uses the id from the refreshed board.
    expect(mutation(run, 3).variables.input.fieldId).toBe(fieldId('Status'));
    expect(mutation(run, 4).variables.input.fieldId).toBe(fieldId('Next step'));
  });

  it('syncFields does not refresh more than once', async () => {
    await seedFieldCache(project => {
      project.fields.nodes.find(f => f.name === 'Status')!.id = 'PVTSSF_stale';
    });
    const unknown = failing(GRAPHQL, "gh: Could not resolve to a node with the global id of 'PVTSSF_x'");
    const { run, tracker } = trackerFor([
      boardQuery('board-item-12.json'),
      unknown,
      graphqlOk('project-fields.json'),
      unknown,
    ]);
    await expect(tracker.syncFields(12, { ...boardFields, status: 'In review' })).rejects.toBeInstanceOf(GhError);
    expect(run.calls).toHaveLength(4);
  });

  it('syncFields does not refresh for an unrelated failed write', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json'), failing(GRAPHQL, 'gh: Bad gateway (HTTP 502)')]);
    await expect(tracker.syncFields(12, { ...boardFields, nextStep: 'x' })).rejects.toThrow(/502/);
    expect(run.calls).toHaveLength(2);
  });

  it('syncFields stops at the first failed write', async () => {
    await seedFieldCache();
    const { run, tracker } = trackerFor([
      boardQuery('board-item-12.json'),
      updated,
      failing(GRAPHQL, 'gh: Forbidden (HTTP 403)'),
    ]);
    await expect(
      tracker.syncFields(12, { ...boardFields, status: 'Blocked', nextStep: 'x', agent: 'y' }),
    ).rejects.toThrow(/403/);
    expect(run.calls).toHaveLength(3);
  });

  it('addToBoard adds an issue that is not on the board', async () => {
    const { run, tracker } = trackerFor([boardQuery('board-item-absent.json'), graphqlOk('board-item-add.json')]);
    await tracker.addToBoard(12);
    expect(sent(run, 1).variables.input).toEqual({ projectId: 'PVT_kwDOBx7', contentId: 'I_kwDOBx12' });
  });

  it('addToBoard does nothing for an issue already on the board', async () => {
    const { run, tracker } = trackerFor([boardQuery('board-item-12.json')]);
    await tracker.addToBoard(12);
    expect(run.calls).toHaveLength(1);
  });

  it('addToBoard fails when the issue does not exist', async () => {
    const missing = { data: { repository: { issue: null }, boardOwner: { projectV2: { id: 'PVT_kwDOBx7' } } } };
    const { tracker } = trackerFor([ok(GRAPHQL, JSON.stringify(missing))]);
    await expect(tracker.addToBoard(99)).rejects.toThrow(/#99/);
  });
});

describe('GitHubTracker pull requests', () => {
  const prList = [
    'pr', 'list', '--repo', 'acme/shop', '--state', 'all',
    '--search', '"Related to #12" in:body',
    '--json', 'number,url,mergedAt,mergeCommit,baseRefName,body', '--limit', '100',
  ];

  it('listTaskPrs ignores PRs whose body only mentions the issue with a closing keyword', async () => {
    const { tracker } = trackerFor([fromFixture(prList, 'pr-list.json')]);
    const prs = await tracker.listTaskPrs(12);
    // 33 only says "Closes #12"; 34 relates to #120, not #12.
    expect(prs.map(p => p.number)).toEqual([31, 32, 35]);
  });

  it('maps merge data and keeps the body for the caller to read scope and targets from', async () => {
    const { tracker } = trackerFor([fromFixture(prList, 'pr-list.json')]);
    const [merged, open] = await tracker.listTaskPrs(12);
    expect(merged).toEqual({
      number: 31,
      url: 'https://github.com/acme/shop/pull/31',
      merged: true,
      mergeSha: '1111111111111111111111111111111111111111',
      mergedAt: '2026-11-21T14:00:00Z',
      baseRef: 'main',
      body: 'Related to #12\nScope: partial\nTargets: web',
    });
    expect(open).toEqual({
      number: 32,
      url: 'https://github.com/acme/shop/pull/32',
      merged: false,
      baseRef: 'main',
      body: 'Related to #12\nScope: final\nTargets: web, api',
    });
  });

  it('refuses to answer when the PR search may have been cut off', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, url: 'u', mergedAt: null, mergeCommit: null, baseRefName: 'main', body: 'Related to #12',
    }));
    const { tracker } = trackerFor([ok(prList, JSON.stringify(many))]);
    await expect(tracker.listTaskPrs(12)).rejects.toThrow(/100/);
  });
});

describe('GitHubTracker deployments', () => {
  const deployments = (environment: string, perPage: number, page?: number): string[] => [
    'api',
    `repos/acme/shop/deployments?environment=${environment}&per_page=${perPage}${page ? `&page=${page}` : ''}`,
  ];
  const statuses = (id: number, name: string): FakeGhStep =>
    fromFixture(['api', `repos/acme/shop/deployments/${id}/statuses?per_page=1`], name);

  it('listSuccessfulDeployments filters by latest status', async () => {
    const { tracker } = trackerFor([
      fromFixture(deployments('production-web', 10), 'deployments.json'),
      statuses(904, 'deployment-statuses-904.json'), // in progress
      statuses(903, 'deployment-statuses-903.json'), // success
      statuses(902, 'deployment-statuses-902.json'), // failure
      statuses(901, 'deployment-statuses-901.json'), // inactive: it succeeded, then a later deployment replaced it
    ]);
    const listed = await tracker.listSuccessfulDeployments('production-web', 10);
    expect(listed.map(d => d.id)).toEqual([903, 901]);
    expect(listed[0]).toEqual({
      id: 903,
      sha: 'cccccccccccccccccccccccccccccccccccccccc',
      environment: 'production-web',
      url: 'https://api.github.com/repos/acme/shop/deployments/903',
      createdAt: '2026-11-25T12:00:00Z',
    });
  });

  it('only looks at the newest `limit` deployments', async () => {
    const { run, tracker } = trackerFor([
      fromFixture(deployments('production-web', 2), 'deployments.json'),
      statuses(904, 'deployment-statuses-904.json'),
      statuses(903, 'deployment-statuses-903.json'),
    ]);
    const listed = await tracker.listSuccessfulDeployments('production-web', 2);
    expect(listed.map(d => d.id)).toEqual([903]);
    expect(run.calls).toHaveLength(3);
  });

  it('pages on when more than 100 deployments are asked for', async () => {
    const make = (id: number) => ({
      id, sha: String(id).padStart(40, '0'), environment: 'production-web',
      url: `https://api.github.com/repos/acme/shop/deployments/${id}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(),
    });
    const first = Array.from({ length: 100 }, (_, i) => make(1000 - i));
    const second = Array.from({ length: 3 }, (_, i) => make(900 - i));
    const state = (name: string) => JSON.stringify([{ id: 1, state: name }]);
    const { run, tracker } = trackerFor([
      ok(deployments('production-web', 100), JSON.stringify(first)),
      ...first.map(d => ok(['api', `repos/acme/shop/deployments/${d.id}/statuses?per_page=1`], state(d.id === 950 ? 'success' : 'failure'))),
      ok(deployments('production-web', 100, 2), JSON.stringify(second)),
      ...second.map(d => ok(['api', `repos/acme/shop/deployments/${d.id}/statuses?per_page=1`], state(d.id === 899 ? 'success' : 'failure'))),
    ]);
    const listed = await tracker.listSuccessfulDeployments('production-web', 103);
    expect(listed.map(d => d.id)).toEqual([950, 899]);
    expect(run.calls).toHaveLength(1 + 100 + 1 + 3);
  });

  it('makes no call for a non-positive limit', async () => {
    const { run, tracker } = trackerFor([]);
    expect(await tracker.listSuccessfulDeployments('production-web', 0)).toEqual([]);
    expect(run.calls).toHaveLength(0);
  });

  it('createDeployment creates the deployment, then marks it successful', async () => {
    const sha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { run, tracker } = trackerFor([
      fromFixture(['api', '-X', 'POST', 'repos/acme/shop/deployments', '--input', '-'], 'deployment-created.json'),
      fromFixture(['api', '-X', 'POST', 'repos/acme/shop/deployments/905/statuses', '--input', '-'], 'deployment-status-created.json'),
    ]);
    const created = await tracker.createDeployment({
      environment: 'production-web',
      sha,
      target: 'web',
      description: 'Deploy web for #12',
    });

    expect(created).toEqual({
      id: 905,
      sha,
      environment: 'production-web',
      url: 'https://api.github.com/repos/acme/shop/deployments/905',
      createdAt: '2026-11-27T15:00:00Z',
    });
    expect(body(run, 0)).toEqual({
      ref: sha,
      environment: 'production-web',
      auto_merge: false,
      required_contexts: [],
      payload: { sdlc_target: 'web' },
      description: 'Deploy web for #12',
    });
    expect(body(run, 1)).toEqual({ state: 'success' });
  });

  it('createDeployment says which deployment is left without a status when marking it fails', async () => {
    const { tracker } = trackerFor([
      fromFixture(['api', '-X', 'POST', 'repos/acme/shop/deployments'], 'deployment-created.json'),
      failing(['api', '-X', 'POST', 'repos/acme/shop/deployments/905/statuses'], 'gh: Server error (HTTP 500)'),
    ]);
    await expect(
      tracker.createDeployment({ environment: 'production-web', sha: 'e'.repeat(40), target: 'web', description: 'd' }),
    ).rejects.toThrow(/Deployment 905 was created.*500/);
  });
});

describe('GitHubTracker releases', () => {
  const releases = (perPage: number, page?: number): string[] => [
    'api',
    `repos/acme/shop/releases?per_page=${perPage}${page ? `&page=${page}` : ''}`,
  ];
  const commit = (ref: string, sha: string): FakeGhStep =>
    ok(['api', `repos/acme/shop/commits/${ref}`, '--jq', '.sha'], `${sha}\n`);
  const V12 = '1'.repeat(40);
  const V11 = '2'.repeat(40);

  it('listReleases skips drafts and prereleases and resolves each tag to its commit', async () => {
    const { run, tracker } = trackerFor([
      fromFixture(releases(10), 'releases.json'),
      commit('v1.2.0', V12),
      commit('cli/v1.1.0', V11),
    ]);

    const listed = await tracker.listReleases(10);

    expect(listed).toEqual([
      { tag: 'v1.2.0', sha: V12, url: 'https://github.com/acme/shop/releases/tag/v1.2.0', publishedAt: '2026-11-25T09:10:00Z' },
      { tag: 'cli/v1.1.0', sha: V11, url: 'https://github.com/acme/shop/releases/tag/cli/v1.1.0', publishedAt: '2026-11-20T09:10:00Z' },
    ]);
    // The draft and the prerelease are never resolved.
    expect(run.calls).toHaveLength(3);
    expect(run.calls[2]).toEqual(['api', 'repos/acme/shop/commits/cli/v1.1.0', '--jq', '.sha']);
  });

  it('encodes each part of a tag name', async () => {
    const rows = [{ ...json<any[]>('releases.json')[2], tag_name: 'v1 beta/2#x' }];
    const { run, tracker } = trackerFor([
      ok(releases(5), JSON.stringify(rows)),
      commit('v1%20beta/2%23x', V12),
    ]);

    expect((await tracker.listReleases(5))[0]?.tag).toBe('v1 beta/2#x');
    expect(run.calls[1]?.[1]).toBe('repos/acme/shop/commits/v1%20beta/2%23x');
  });

  it('returns at most `limit`, newest first, however GitHub ordered the page', async () => {
    const rows = json<any[]>('releases.json');
    const { tracker } = trackerFor([
      ok(releases(1), JSON.stringify([rows[3], rows[2]])),
      commit('v1.2.0', V12),
    ]);

    expect((await tracker.listReleases(1)).map(r => r.tag)).toEqual(['v1.2.0']);
  });

  it('pages on while drafts and prereleases leave fewer than `limit` published releases', async () => {
    const rows = json<any[]>('releases.json');
    const { run, tracker } = trackerFor([
      ok(releases(2), JSON.stringify([rows[0], rows[1]])),
      ok(releases(2, 2), JSON.stringify([rows[2], rows[3]])),
      commit('v1.2.0', V12),
      commit('cli/v1.1.0', V11),
    ]);

    expect((await tracker.listReleases(2)).map(r => r.tag)).toEqual(['v1.2.0', 'cli/v1.1.0']);
    expect(run.calls).toHaveLength(4);
  });

  it('makes no call for a non-positive limit', async () => {
    const { run, tracker } = trackerFor([]);
    expect(await tracker.listReleases(0)).toEqual([]);
    expect(run.calls).toHaveLength(0);
  });

  it('returns nothing when the repository has no releases', async () => {
    const { tracker } = trackerFor([ok(releases(10), '[]')]);
    expect(await tracker.listReleases(10)).toEqual([]);
  });

  it('rejects when the release list cannot be read', async () => {
    const { tracker } = trackerFor([failing(releases(10), 'gh: Server error (HTTP 500)')]);
    await expect(tracker.listReleases(10)).rejects.toThrow(/500/);
  });

  it('rejects when a tag cannot be resolved to a commit', async () => {
    const { tracker } = trackerFor([
      fromFixture(releases(10), 'releases.json'),
      failing(['api', 'repos/acme/shop/commits/v1.2.0'], 'gh: No commit found for SHA: v1.2.0 (HTTP 422)'),
      commit('cli/v1.1.0', V11),
    ]);
    await expect(tracker.listReleases(10)).rejects.toThrow(/422/);
  });

  it('rejects when a tag resolves to nothing', async () => {
    const { tracker } = trackerFor([
      fromFixture(releases(10), 'releases.json'),
      ok(['api', 'repos/acme/shop/commits/v1.2.0'], '\n'),
      commit('cli/v1.1.0', V11),
    ]);
    await expect(tracker.listReleases(10)).rejects.toThrow(/Could not resolve the tag "v1.2.0"/);
  });
});

describe('GitHubTracker repository', () => {
  /** The compare call asks for one commit of the diff and prints only its status. */
  const compareArgs = (base: string, head: string): string[] => [
    'api', `repos/acme/shop/compare/${base}...${head}?per_page=1`, '--jq', '.status',
  ];
  const compare = (name: string): FakeGhStep => fromFixture(compareArgs('aaa', 'bbb'), name);

  it('isAncestor asks for a single commit and only the status, not the whole diff', async () => {
    const { run, tracker } = trackerFor([compare('compare-ahead.txt')]);
    await tracker.isAncestor('aaa', 'bbb');
    expect(run.calls[0]).toEqual(compareArgs('aaa', 'bbb'));
  });

  it('isAncestor maps compare status', async () => {
    const { tracker } = trackerFor([
      compare('compare-ahead.txt'),
      compare('compare-identical.txt'),
      compare('compare-behind.txt'),
      compare('compare-diverged.txt'),
    ]);
    expect(await tracker.isAncestor('aaa', 'bbb')).toBe(true); // ahead
    expect(await tracker.isAncestor('aaa', 'bbb')).toBe(true); // identical
    expect(await tracker.isAncestor('aaa', 'bbb')).toBe(false); // behind
    expect(await tracker.isAncestor('aaa', 'bbb')).toBe(false); // diverged
  });

  it('isAncestor is false for commits with no common ancestor, and throws on other errors', async () => {
    const { tracker } = trackerFor([
      failing(['api'], 'gh: No common ancestor between aaa and bbb. (HTTP 404)'),
      failing(['api'], 'gh: Not Found (HTTP 404)'),
    ]);
    expect(await tracker.isAncestor('aaa', 'bbb')).toBe(false);
    await expect(tracker.isAncestor('aaa', 'bbb')).rejects.toThrow(/Not Found/);
  });

  it('isOnDefaultBranch compares with the head of the default branch', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01';
    const { run, tracker } = trackerFor([
      fromFixture(['api', 'repos/acme/shop/branches/main'], 'branch-main.json'),
      fromFixture(compareArgs('1'.repeat(40), head), 'compare-ahead.txt'),
      fromFixture(['api', 'repos/acme/shop/branches/main'], 'branch-main.json'),
      fromFixture(compareArgs('2'.repeat(40), head), 'compare-diverged.txt'),
    ]);
    expect(await tracker.isOnDefaultBranch('1'.repeat(40))).toBe(true);
    expect(await tracker.isOnDefaultBranch('2'.repeat(40))).toBe(false);
    expect(run.calls).toHaveLength(4);
  });
});

describe('GitHubTracker failed writes', () => {
  const boom = (match: string[]): FakeGhStep => failing(match, 'gh: Server error (HTTP 500)');

  const cases: [string, FakeGhStep[], (t: GitHubTracker) => Promise<unknown>][] = [
    ['createIssue', [boom(['POST'])], t => t.createIssue('T', 'B', [])],
    ['postComment', [boom(['POST'])], t => t.postComment(12, 'x')],
    ['setIssueOpen', [boom(['PATCH'])], t => t.setIssueOpen(12, false, 'completed')],
    ['setLabels (add)', [boom(['POST'])], t => t.setLabels(12, ['a'], [])],
    ['writeState (patch)', [LOGIN, comments(12), boom(['PATCH'])], t => t.writeState(12, task(12))],
    ['writeState (create)', [LOGIN, comments(14), boom(['POST'])], t => t.writeState(14, task(14))],
    [
      'addToBoard',
      [graphqlOk('board-item-absent.json'), boom(GRAPHQL)],
      t => t.addToBoard(12),
    ],
    ['createDeployment', [boom(['POST'])], t => t.createDeployment({ environment: 'e', sha: 's', target: 't', description: 'd' })],
  ];

  it.each(cases)('%s rejects instead of swallowing the error', async (_name, script, call) => {
    const { tracker } = trackerFor(script);
    await expect(call(tracker)).rejects.toThrow(/500/);
  });

  it('rejects with the gh failure, not a bare message', async () => {
    const { tracker } = trackerFor([boom(['POST'])]);
    await expect(tracker.postComment(12, 'x')).rejects.toBeInstanceOf(GhError);
  });
});
