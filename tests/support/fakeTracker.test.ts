import { describe, expect, it } from 'vitest';
import { newTask } from '../../src/core/stateMachine.js';
import { renderStateComment, STATE_MARKER, StateCommentError } from '../../src/core/stateComment.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { BoardFields } from '../../src/core/projection.js';
import type { TaskState } from '../../src/core/types.js';
import { FakeTracker } from './fakeTracker.js';

const NOW = '2026-01-01T00:00:00.000Z';

const task = (issue: number, summary = 'Do the thing'): TaskState =>
  newTask({ issue, type: BUILTIN_TYPES.find(t => t.id === 'feature')!, summary, now: NOW });

const boardFields = (): BoardFields => ({
  status: 'Ready',
  phase: 'Intake',
  type: 'Feature',
  waitingOn: '—',
  summary: 'S',
  currentStep: 'c',
  nextStep: 'n',
  pendingTargets: '',
  agent: '',
  lastUpdate: NOW,
});

describe('FakeTracker.authenticatedLogin', () => {
  it('is the login, and can be made to fail', async () => {
    const tracker = new FakeTracker();
    tracker.login = 'agent-login';
    await expect(tracker.authenticatedLogin()).resolves.toBe('agent-login');
    tracker.failNext('authenticatedLogin');
    await expect(tracker.authenticatedLogin()).rejects.toThrow(/authenticatedLogin/);
    expect(tracker.writes).toBe(0);
  });
});

describe('FakeTracker.failNext', () => {
  it('rejects exactly one call', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('T', 'B', ['sdlc:task']);
    tracker.failNext('getTask');
    await expect(tracker.getTask(number)).rejects.toThrow(/getTask/);
    // The next call proceeds (and fails only because no state was written, not because of injection).
    await expect(tracker.getTask(number)).rejects.toThrow(/no state comment/);
    await tracker.writeState(number, task(number));
    expect((await tracker.getTask(number)).issue).toBe(number);
  });

  it('only affects the named method', async () => {
    const tracker = new FakeTracker();
    tracker.failNext('createIssue');
    await expect(tracker.listTrackedTasks()).resolves.toEqual([]);
    await expect(tracker.createIssue('T', 'B', [])).rejects.toThrow(/createIssue/);
    expect(tracker.issues).toHaveLength(0);
  });

  it('queues one failure per call to failNext', async () => {
    const tracker = new FakeTracker();
    tracker.failNext('isOnDefaultBranch');
    tracker.failNext('isOnDefaultBranch');
    await expect(tracker.isOnDefaultBranch('a')).rejects.toThrow();
    await expect(tracker.isOnDefaultBranch('a')).rejects.toThrow();
    await expect(tracker.isOnDefaultBranch('a')).resolves.toBe(false);
  });

  it('does not count or apply a failed write', async () => {
    const tracker = new FakeTracker();
    tracker.failNext('createIssue');
    await tracker.createIssue('T', 'B', []).catch(() => undefined);
    expect(tracker.writes).toBe(0);
    expect(tracker.issues).toEqual([]);
  });
});

describe('FakeTracker issues', () => {
  it('creates issues with increasing numbers and tracks board membership', async () => {
    const tracker = new FakeTracker();
    const a = await tracker.createIssue('A', 'body a', ['sdlc:task', 'type:feature']);
    const b = await tracker.createIssue('B', 'body b', []);
    expect(b.number).toBe(a.number + 1);
    expect(a.url).toContain(`/issues/${a.number}`);
    expect(tracker.issues[0]).toEqual({
      number: a.number,
      title: 'A',
      body: 'body a',
      labels: ['sdlc:task', 'type:feature'],
      open: true,
      onBoard: false,
    });
    await tracker.addToBoard(a.number);
    expect(tracker.issues[0]!.onBoard).toBe(true);
    expect(tracker.issues[1]!.onBoard).toBe(false);
  });

  it('does not reuse the number of a seeded PR', async () => {
    const tracker = new FakeTracker();
    tracker.prs.push({ issue: 1, number: 7, url: 'u', merged: false, baseRef: 'main', body: '' });
    const created = await tracker.createIssue('A', '', []);
    expect(created.number).toBe(8);
  });

  it('closes with a reason and reopens', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('A', '', []);
    await tracker.setIssueOpen(number, false, 'not_planned');
    expect(tracker.issues[0]).toMatchObject({ open: false, closeReason: 'not_planned' });
    await tracker.setIssueOpen(number, true);
    expect(tracker.issues[0]!.open).toBe(true);
    expect(tracker.issues[0]!.closeReason).toBeUndefined();
  });

  it('adds and removes labels without duplicating', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('A', '', ['a', 'b']);
    await tracker.setLabels(number, ['b', 'c'], ['a']);
    expect(tracker.issues[0]!.labels).toEqual(['b', 'c']);
  });

  it('rejects operations on an unknown issue', async () => {
    const tracker = new FakeTracker();
    await expect(tracker.addToBoard(99)).rejects.toThrow(/#99/);
    await expect(tracker.setIssueOpen(99, false)).rejects.toThrow(/#99/);
    await expect(tracker.listComments(99)).rejects.toThrow(/#99/);
  });

  it('stores synced board fields per issue', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('A', '', []);
    await tracker.syncFields(number, boardFields());
    expect(tracker.fields.get(number)).toEqual(boardFields());
  });
});

describe('FakeTracker state', () => {
  it('stores state as the real hidden state comment and reads it back', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('Title', '', ['sdlc:task']);
    const state = task(number);
    await tracker.writeState(number, state);

    expect(tracker.comments).toHaveLength(1);
    expect(tracker.comments[0]!.body.startsWith(STATE_MARKER)).toBe(true);

    const got = await tracker.getTask(number);
    expect(got).toEqual({
      issue: number,
      title: 'Title',
      issueOpen: true,
      state,
      stateCommentId: tracker.comments[0]!.id,
    });
    // Reads return copies, not live references.
    got.state.summary = 'mutated';
    expect((await tracker.getTask(number)).state.summary).toBe('Do the thing');
  });

  it('updates the existing state comment in place on later writes', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('T', '', []);
    await tracker.writeState(number, task(number));
    const id = tracker.comments[0]!.id;
    await tracker.writeState(number, { ...task(number), status: 'in_progress' });
    expect(tracker.comments).toHaveLength(1);
    expect(tracker.comments[0]!.id).toBe(id);
    expect((await tracker.getTask(number)).state.status).toBe('in_progress');
  });

  it('lists only issues that carry a state comment, in issue order', async () => {
    const tracker = new FakeTracker();
    tracker.seedTask(task(5));
    tracker.seedTask(task(2));
    await tracker.createIssue('plain', '', []); // number 6, no state
    const listed = await tracker.listTrackedTasks();
    expect(listed.map(t => t.issue)).toEqual([2, 5]);
  });

  it('lists only issues labelled sdlc:task, as the real tracker does', async () => {
    const tracker = new FakeTracker();
    tracker.seedTask(task(2));
    tracker.seedTask(task(3), { labels: ['bug'] }); // has a state comment, but no sdlc:task label
    expect((await tracker.listTrackedTasks()).map(t => t.issue)).toEqual([2]);
    // getTask is not label-gated.
    expect((await tracker.getTask(3)).issue).toBe(3);
  });

  it('skips a corrupt state comment when listing, but getTask reports it', async () => {
    const tracker = new FakeTracker();
    tracker.seedTask(task(2));
    tracker.seedTask(task(3));
    tracker.comments.find(c => c.issue === 3)!.body = `${STATE_MARKER}\nnot json`;
    await expect(tracker.listTrackedTasks()).resolves.toMatchObject([{ issue: 2 }]);
    await expect(tracker.getTask(3)).rejects.toBeInstanceOf(StateCommentError);
  });

  it('ignores a state-marker comment written by anyone but the tracker login or the Actions bot', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('T', '', ['sdlc:task']);
    const forged = tracker.seedComment(number, {
      body: `${STATE_MARKER}\n\`\`\`json\n{}\n\`\`\``,
      author: 'intruder',
    });
    await expect(tracker.getTask(number)).rejects.toThrow(/no state comment/);

    await tracker.writeState(number, task(number));
    const own = tracker.comments.find(c => c.id !== forged)!;
    expect(own.author).toBe(tracker.login);
    expect((await tracker.getTask(number)).stateCommentId).toBe(own.id);

    tracker.seedTask(task(20), { labels: ['sdlc:task'] });
    tracker.comments.find(c => c.issue === 20)!.author = 'github-actions[bot]';
    expect((await tracker.getTask(20)).issue).toBe(20);
  });

  describe('trusted state-comment authors', () => {
    const forgedBody = `${STATE_MARKER}\n\`\`\`json\n{}\n\`\`\``;

    it('trusts a configured owner like the tracker login and the Actions bot', async () => {
      const tracker = new FakeTracker();
      tracker.owners = ['shop-owner'];
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      tracker.comments.find(c => c.issue === 30)!.author = 'shop-owner';
      expect((await tracker.getTask(30)).issue).toBe(30);
      expect((await tracker.listTrackedTasks()).map(t => t.issue)).toEqual([30]);
    });

    it('trusts a configured agent login like an owner', async () => {
      const tracker = new FakeTracker();
      tracker.login = 'shop-owner';
      tracker.agents = ['Agent-Bot'];
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      tracker.comments.find(c => c.issue === 30)!.author = 'agent-bot';
      expect((await tracker.listTrackedTasks()).map(t => t.issue)).toEqual([30]);
    });

    it('does not trust an owner nobody configured', async () => {
      const tracker = new FakeTracker();
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      tracker.comments.find(c => c.issue === 30)!.author = 'shop-owner';
      await expect(tracker.getTask(30)).rejects.toThrow(/no state comment/);
    });

    it('compares authors case-insensitively', async () => {
      const tracker = new FakeTracker();
      tracker.owners = ['Shop-Owner'];
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      tracker.seedTask(task(31), { labels: ['sdlc:task'] });
      tracker.seedTask(task(32), { labels: ['sdlc:task'] });
      tracker.comments.find(c => c.issue === 30)!.author = 'SHOP-OWNER';
      tracker.comments.find(c => c.issue === 31)!.author = tracker.login.toUpperCase();
      tracker.comments.find(c => c.issue === 32)!.author = 'GitHub-Actions[bot]';
      expect((await tracker.listTrackedTasks()).map(t => t.issue)).toEqual([30, 31, 32]);
    });

    it('reads, and writes to, the trusted state comment with the newest update when several exist', async () => {
      const tracker = new FakeTracker();
      tracker.owners = ['shop-owner'];
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      const own = tracker.comments.find(c => c.issue === 30)!;
      const ownerCopy = tracker.seedComment(30, {
        body: renderStateComment({ ...task(30), status: 'blocked' }),
        author: 'shop-owner',
      });
      expect((await tracker.getTask(30)).stateCommentId).toBe(ownerCopy);
      expect((await tracker.getTask(30)).state.status).toBe('blocked');

      const before = own.body;
      await tracker.writeState(30, { ...task(30), summary: 'Edited last' });
      expect((await tracker.getTask(30)).stateCommentId).toBe(ownerCopy);
      expect((await tracker.getTask(30)).state.summary).toBe('Edited last');
      expect(own.body).toBe(before);
      expect(tracker.comments.filter(c => c.issue === 30)).toHaveLength(2);
      // Like GitHub, an edit moves updatedAt past createdAt.
      const patched = tracker.comments.find(c => c.id === ownerCopy)!;
      expect(Date.parse(patched.updatedAt)).toBeGreaterThan(Date.parse(patched.createdAt));
      expect(own.updatedAt).toBe(own.createdAt);
    });

    it('prefers the later update over the later creation', async () => {
      const tracker = new FakeTracker();
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      const older = tracker.comments.find(c => c.issue === 30)!;
      const newer = tracker.seedComment(30, { body: older.body, author: tracker.login });
      // `older` is created first but updated last.
      older.updatedAt = '2030-01-01T00:00:00.000Z';
      expect((await tracker.getTask(30)).stateCommentId).toBe(older.id);
      expect(newer).not.toBe(older.id);
    });

    it('never reads or updates an intruder comment, however recent', async () => {
      const tracker = new FakeTracker();
      tracker.seedTask(task(30), { labels: ['sdlc:task'] });
      const real = tracker.comments.find(c => c.issue === 30)!;
      const intruder = tracker.seedComment(30, { body: forgedBody, author: 'intruder' });
      tracker.comments.find(c => c.id === intruder)!.updatedAt = '2099-01-01T00:00:00.000Z';
      expect((await tracker.getTask(30)).stateCommentId).toBe(real.id);
      await tracker.writeState(30, { ...task(30), summary: 'Mine' });
      expect(tracker.comments.find(c => c.id === intruder)!.body).toBe(forgedBody);
      expect((await tracker.getTask(30)).state.summary).toBe('Mine');
    });
  });

  it('seedTask refuses a duplicate issue number', () => {
    const tracker = new FakeTracker();
    tracker.seedTask(task(3));
    expect(() => tracker.seedTask(task(3))).toThrow(/#3/);
  });
});

describe('FakeTracker.listUntracked', () => {
  it('reports sdlc:task issues with a missing or corrupt state comment, in issue order', async () => {
    const tracker = new FakeTracker();
    tracker.seedTask(task(1)); // tracked
    await tracker.createIssue('No state yet', '', ['sdlc:task']); // 2: missing
    tracker.seedTask(task(3), { title: 'Broken' });
    tracker.comments.find(c => c.issue === 3)!.body = `${STATE_MARKER}\n\`\`\`json\n{oops\n\`\`\``;
    await tracker.createIssue('Unrelated issue', '', ['bug']); // 4: not an sdlc:task

    const untracked = await tracker.listUntracked();
    expect(untracked).toEqual([
      { issue: 2, title: 'No state yet', reason: 'missing state comment' },
      { issue: 3, title: 'Broken', reason: expect.stringContaining('invalid JSON') },
    ]);
  });

  it('can be made to fail like any other method', async () => {
    const tracker = new FakeTracker();
    tracker.failNext('listUntracked');
    await expect(tracker.listUntracked()).rejects.toThrow(/listUntracked/);
    await expect(tracker.listUntracked()).resolves.toEqual([]);
  });
});

describe('FakeTracker comments', () => {
  it('posts comments with increasing timestamps and filters by since', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('T', '', []);
    const first = await tracker.postComment(number, 'one');
    const second = await tracker.postComment(number, 'two');
    expect(second).not.toBe(first);

    const all = await tracker.listComments(number);
    expect(all.map(c => c.body)).toEqual(['one', 'two']);
    expect(Date.parse(all[1]!.createdAt)).toBeGreaterThan(Date.parse(all[0]!.createdAt));
    expect(all[0]).toEqual({
      id: first,
      url: expect.stringContaining(`/issues/${number}`),
      author: tracker.login,
      body: 'one',
      createdAt: all[0]!.createdAt,
      updatedAt: all[0]!.createdAt,
    });

    const later = await tracker.listComments(number, all[0]!.createdAt);
    expect(later.map(c => c.body)).toEqual(['two']);
  });

  it('lists an edited comment with its later updatedAt', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('T', '', []);
    tracker.seedComment(number, { body: 'a', author: 'x', createdAt: '2026-02-01T00:00:00.000Z' });
    tracker.seedComment(number, {
      body: 'b',
      author: 'x',
      createdAt: '2026-02-02T00:00:00.000Z',
      updatedAt: '2026-02-03T00:00:00.000Z',
    });
    const listed = await tracker.listComments(number);
    expect(listed.map(c => c.updatedAt)).toEqual(['2026-02-01T00:00:00.000Z', '2026-02-03T00:00:00.000Z']);
  });

  it('serves PR numbers as well as issue numbers', async () => {
    const tracker = new FakeTracker();
    tracker.prs.push({ issue: 1, number: 10, url: 'u', merged: false, baseRef: 'main', body: '' });
    tracker.seedComment(10, { body: '/approve', author: 'owner', createdAt: '2026-02-01T00:00:00.000Z' });
    const comments = await tracker.listComments(10);
    expect(comments.map(c => [c.author, c.body])).toEqual([['owner', '/approve']]);
  });

  it('only returns the comments of the requested issue, oldest first', async () => {
    const tracker = new FakeTracker();
    const a = (await tracker.createIssue('A', '', [])).number;
    const b = (await tracker.createIssue('B', '', [])).number;
    tracker.seedComment(a, { body: 'late', author: 'x', createdAt: '2026-03-01T00:00:00.000Z' });
    tracker.seedComment(a, { body: 'early', author: 'x', createdAt: '2026-02-01T00:00:00.000Z' });
    tracker.seedComment(b, { body: 'other', author: 'x', createdAt: '2026-02-01T00:00:00.000Z' });
    expect((await tracker.listComments(a)).map(c => c.body)).toEqual(['early', 'late']);
  });
});

describe('FakeTracker releases', () => {
  const release = (tag: string, publishedAt: string) => ({ tag, sha: tag.padEnd(40, '0'), url: `https://github.test/releases/${tag}`, publishedAt });

  it('lists releases newest first, at most `limit`', async () => {
    const tracker = new FakeTracker();
    tracker.releases.push(
      release('v1', '2026-01-01T00:00:00Z'),
      release('v3', '2026-03-01T00:00:00Z'),
      release('v2', '2026-02-01T00:00:00Z'),
    );

    expect((await tracker.listReleases(10)).map(r => r.tag)).toEqual(['v3', 'v2', 'v1']);
    expect((await tracker.listReleases(2)).map(r => r.tag)).toEqual(['v3', 'v2']);
    expect(await tracker.listReleases(0)).toEqual([]);
    expect(tracker.writes).toBe(0);
  });

  it('rejects once when failNext is set', async () => {
    const tracker = new FakeTracker();
    tracker.failNext('listReleases');
    await expect(tracker.listReleases(5)).rejects.toThrow(/listReleases failed/);
    expect(await tracker.listReleases(5)).toEqual([]);
  });
});

describe('FakeTracker PRs and deployments', () => {
  it('returns the PRs of an issue without the bookkeeping field', async () => {
    const tracker = new FakeTracker();
    tracker.prs.push(
      { issue: 1, number: 10, url: 'u10', merged: true, mergeSha: 'abc', mergedAt: NOW, baseRef: 'main', body: 'Related to #1' },
      { issue: 2, number: 11, url: 'u11', merged: false, baseRef: 'main', body: 'Related to #2' },
    );
    const prs = await tracker.listTaskPrs(1);
    expect(prs).toEqual([
      { number: 10, url: 'u10', merged: true, mergeSha: 'abc', mergedAt: NOW, baseRef: 'main', body: 'Related to #1' },
    ]);
    expect(await tracker.listTaskPrs(404)).toEqual([]);
  });

  it('creates deployments with incrementing ids and a fake clock, newest first when listed', async () => {
    const tracker = new FakeTracker();
    const first = await tracker.createDeployment({ environment: 'production-web', sha: 's1', target: 'web', description: 'd1' });
    const second = await tracker.createDeployment({ environment: 'production-web', sha: 's2', target: 'web', description: 'd2' });
    await tracker.createDeployment({ environment: 'production-api', sha: 's3', target: 'api', description: 'd3' });

    expect(second.id).toBe(first.id + 1);
    expect(first).toEqual({
      id: first.id,
      sha: 's1',
      environment: 'production-web',
      url: expect.stringContaining(String(first.id)),
      createdAt: first.createdAt,
    });
    expect(Date.parse(second.createdAt)).toBeGreaterThan(Date.parse(first.createdAt));
    expect(first.createdAt.startsWith('2026-01-01T00:')).toBe(true);
    expect(tracker.deployments).toHaveLength(3);

    const web = await tracker.listSuccessfulDeployments('production-web', 10);
    expect(web.map(d => d.sha)).toEqual(['s2', 's1']);
    expect(Object.keys(web[0]!).sort()).toEqual(['createdAt', 'environment', 'id', 'sha', 'url']);
    expect((await tracker.listSuccessfulDeployments('production-web', 1)).map(d => d.sha)).toEqual(['s2']);
    expect(await tracker.listSuccessfulDeployments('staging', 5)).toEqual([]);
  });

  it('answers ancestry and default-branch questions from its sets', async () => {
    const tracker = new FakeTracker();
    tracker.ancestors.add('a>b');
    tracker.defaultBranchShas.add('b');
    expect(await tracker.isAncestor('a', 'b')).toBe(true);
    expect(await tracker.isAncestor('b', 'a')).toBe(false);
    expect(await tracker.isAncestor('c', 'c')).toBe(true);
    expect(await tracker.isOnDefaultBranch('b')).toBe(true);
    expect(await tracker.isOnDefaultBranch('a')).toBe(false);
  });
});

describe('FakeTracker.writes', () => {
  it('counts every mutating call and no reads', async () => {
    const tracker = new FakeTracker();
    const { number } = await tracker.createIssue('T', '', []); // 1
    await tracker.addToBoard(number); // 2
    await tracker.writeState(number, task(number)); // 3
    await tracker.postComment(number, 'hi'); // 4
    await tracker.setLabels(number, ['x'], []); // 5
    await tracker.syncFields(number, boardFields()); // 6
    await tracker.setIssueOpen(number, false, 'completed'); // 7
    await tracker.createDeployment({ environment: 'e', sha: 's', target: 't', description: 'd' }); // 8
    expect(tracker.writes).toBe(8);

    await tracker.getTask(number);
    await tracker.listTrackedTasks();
    await tracker.listComments(number);
    await tracker.listTaskPrs(number);
    await tracker.listSuccessfulDeployments('e', 5);
    await tracker.isAncestor('a', 'b');
    await tracker.isOnDefaultBranch('a');
    expect(tracker.writes).toBe(8);
  });

  it('does not count seeding helpers', () => {
    const tracker = new FakeTracker();
    tracker.seedTask(task(1));
    tracker.seedComment(1, { body: 'x', author: 'y' });
    expect(tracker.writes).toBe(0);
  });
});
