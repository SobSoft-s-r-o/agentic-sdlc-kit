import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, registerApproveCommand } from '../../src/commands/approve.js';
import {
  parseChoice,
  parseIssueNumber,
  parseTargetList,
  type CommandContext,
} from '../../src/commands/context.js';
import { evidenceAdd, registerEvidenceCommand } from '../../src/commands/evidence.js';
import { registerReviewCommand, reviewHandoff } from '../../src/commands/review.js';
import { registerStageCommand, stagePublish, stageStart } from '../../src/commands/stage.js';
import {
  registerTaskCommand,
  taskCheckpoint,
  taskNew,
  taskReopen,
  taskSetType,
} from '../../src/commands/task.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
import { STATE_MARKER } from '../../src/core/stateComment.js';
import { applyEvent } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { FakeTracker } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const enforceCfg: Config = { ...cfg, mode: 'enforce' };
const OWNER = 'shop-owner';
/** The command clock runs from 2026-06-01; owner comments are placed clearly before or after it. */
const BEFORE = '2026-05-01T00:00:00.000Z';
const AFTER = '2026-07-01T00:00:00.000Z';

let dir: string;
let exitCode: typeof process.exitCode;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sdlc-flow-'));
  exitCode = process.exitCode;
});
afterEach(async () => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function setup(config: Config = cfg) {
  const tracker = new FakeTracker();
  tracker.owners = [...config.owners];
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

const stateOf = async (tracker: FakeTracker, issue: number): Promise<TaskState> =>
  (await tracker.getTask(issue)).state;
const issueOf = (tracker: FakeTracker, number: number) => tracker.issues.find(i => i.number === number)!;
/** Comments a person would see: everything but the hidden state comment. */
const visibleComments = (tracker: FakeTracker, thread: number) =>
  tracker.comments.filter(c => c.issue === thread && !c.body.startsWith(STATE_MARKER));

async function summaryFile(markdown = 'Goal: add search.\n\nDecision: use the index.'): Promise<string> {
  const file = join(dir, `summary-${Math.random().toString(36).slice(2)}.md`);
  await writeFile(file, markdown);
  return file;
}

const newTask = (h: Harness, type = 'feature') =>
  taskNew(h.ctx, { title: 'Add search', summary: 'Search box on the shop page', type }).then(r => r.issue);

function linkPr(tracker: FakeTracker, issue: number, number: number, body: string, extra: object = {}): void {
  tracker.prs.push({
    issue,
    number,
    url: `https://github.test/pull/${number}`,
    merged: false,
    baseRef: 'main',
    body,
    ...extra,
  });
}

/** A feature task paused on the owner's approval of its brainstorming stage. */
async function pausedFeature(h: Harness): Promise<number> {
  const issue = await newTask(h);
  await stageStart(h.ctx, issue, 'brainstorming');
  await stagePublish(h.ctx, issue, 'brainstorming', { file: await summaryFile(), needsApproval: true });
  return issue;
}

/** Seeds a comment (an `/approve` by the owner unless told otherwise) and returns its URL. */
const ownerComment = (
  tracker: FakeTracker,
  thread: number,
  createdAt: string,
  options: { author?: string; body?: string } = {},
): string => {
  const { author = OWNER, body = '/approve' } = options;
  const id = tracker.seedComment(thread, { body, author, createdAt });
  return tracker.comments.find(c => c.id === id)!.url;
};

describe('taskNew', () => {
  it('new task creates labelled issue on the board in intake', async () => {
    const h = setup();
    const { issue, url } = await taskNew(h.ctx, {
      title: 'Add search',
      summary: 'Search box on the shop page',
      type: 'feature',
    });

    expect(url).toBe(`https://github.test/issues/${issue}`);
    expect(issueOf(h.tracker, issue)).toMatchObject({
      title: 'Add search',
      body: 'Search box on the shop page',
      labels: ['sdlc:task', 'type:feature'],
      open: true,
      onBoard: true,
    });
    expect(await stateOf(h.tracker, issue)).toMatchObject({
      issue,
      type: 'feature',
      status: 'in_progress',
      phase: 'intake',
      waitingOn: 'agent',
      summary: 'Search box on the shop page',
    });
    expect(h.tracker.fields.get(issue)).toMatchObject({
      status: 'In progress',
      phase: 'Intake',
      type: 'Feature',
      waitingOn: 'Agent',
      summary: 'Search box on the shop page',
    });
  });

  it('keeps an explicit issue body', async () => {
    const h = setup();
    const { issue } = await taskNew(h.ctx, { title: 'T', summary: 'S', type: 'tooling', body: 'Long text' });
    expect(issueOf(h.tracker, issue).body).toBe('Long text');
  });

  it('starts a custom type at the first phase of that type', async () => {
    const h = setup({
      ...cfg,
      taskTypes: {
        ...cfg.taskTypes,
        custom: [{ ...cfg.taskTypes.custom[0], id: 'debug-first', phases: ['debugging', 'delivery'] }],
      },
    });
    const { issue } = await taskNew(h.ctx, { title: 'T', summary: 'S', type: 'debug-first' });
    expect((await stateOf(h.tracker, issue)).phase).toBe('debugging');
    expect(h.tracker.fields.get(issue)?.phase).toBe('Debugging');
  });

  it('refuses an unknown or disabled type, listing the enabled ones, before creating anything', async () => {
    const h = setup({ ...cfg, taskTypes: { ...cfg.taskTypes, enabled: ['feature', 'tooling'] } });
    await expect(taskNew(h.ctx, { title: 'T', summary: 'S', type: 'nope' })).rejects.toThrow(
      'Unknown or disabled task type "nope" (enabled types: feature, tooling, infra-change)',
    );
    await expect(taskNew(h.ctx, { title: 'T', summary: 'S', type: 'analysis' })).rejects.toThrow(/analysis/);
    expect(h.tracker.issues).toHaveLength(0);
    expect(h.tracker.writes).toBe(0);
  });

  it('refuses an empty title or summary', async () => {
    const h = setup();
    await expect(taskNew(h.ctx, { title: '  ', summary: 'S', type: 'feature' })).rejects.toThrow(/title/);
    await expect(taskNew(h.ctx, { title: 'T', summary: '', type: 'feature' })).rejects.toThrow(/summary/);
    expect(h.tracker.writes).toBe(0);
  });

  it('names the issue when a later step fails, so it can be found again', async () => {
    const h = setup();
    h.tracker.failNext('addToBoard');
    await expect(taskNew(h.ctx, { title: 'T', summary: 'S', type: 'feature' })).rejects.toThrow(
      /addToBoard failed for #1.*untracked/,
    );
    expect(h.tracker.comments).toHaveLength(0);
  });
});

describe('full flow', () => {
  it('full feature flow up to review handoff', async () => {
    const h = setup();
    const issue = await newTask(h);

    await stageStart(h.ctx, issue, 'brainstorming');
    await stagePublish(h.ctx, issue, 'brainstorming', { file: await summaryFile(), needsApproval: true });
    await approve(h.ctx, issue, { action: 'approve', unverified: true });
    await stageStart(h.ctx, issue, 'planning');
    await stagePublish(h.ctx, issue, 'planning', { file: await summaryFile('Plan: three steps.'), needsApproval: false });
    await stageStart(h.ctx, issue, 'implementation');
    await taskCheckpoint(h.ctx, issue, { current: 'Writing the index', agent: 'claude/developer' });
    linkPr(h.tracker, issue, 50, 'Related to #1\n\nScope: final\nTargets: web, api');

    const state = await reviewHandoff(h.ctx, issue, { pr: 50 });

    expect(state).toMatchObject({
      status: 'in_review',
      phase: 'review',
      waitingOn: 'owner',
      targets: ['web', 'api'],
      prs: [{ number: 50, scope: 'final' }],
    });
    expect(state.stages.brainstorming?.approval).toMatchObject({ source: 'unverified', by: 'sdlc-bot' });
    expect(await stateOf(h.tracker, issue)).toEqual(state);
    expect(h.tracker.fields.get(issue)).toMatchObject({
      status: 'In review',
      phase: 'Review',
      waitingOn: 'Owner',
      currentStep: 'Writing the index',
      agent: 'claude/developer',
    });
    expect(issueOf(h.tracker, issue).open).toBe(true);
  });
});

describe('stagePublish', () => {
  it('stage publish with approval pauses waiting on owner', async () => {
    const h = setup();
    const issue = await pausedFeature(h);

    expect(await stateOf(h.tracker, issue)).toMatchObject({ status: 'paused', waitingOn: 'owner' });
    expect(h.tracker.fields.get(issue)).toMatchObject({ status: 'Paused', waitingOn: 'Owner' });
    const [comment] = visibleComments(h.tracker, issue);
    expect(comment.body).toContain('### Brainstorming — revision 1');
    expect(comment.body).toContain('Decision: use the index.');
    expect(comment.body).toContain('Approve with /approve');
  });

  it('posts a new revision each time and leaves the task running without approval', async () => {
    const h = setup();
    const issue = await newTask(h);
    await stagePublish(h.ctx, issue, 'planning', { file: await summaryFile('v1'), needsApproval: false });
    await stagePublish(h.ctx, issue, 'planning', { file: await summaryFile('v2'), needsApproval: false });

    const [first, second] = visibleComments(h.tracker, issue);
    expect(first.body).toContain('revision 1');
    expect(second.body).toContain('revision 2');
    expect(second.body).not.toContain('/approve');
    expect(await stateOf(h.tracker, issue)).toMatchObject({ status: 'in_progress', waitingOn: 'agent' });
  });

  it('changes nothing when the comment cannot be posted', async () => {
    const h = setup();
    const issue = await newTask(h);
    const before = await stateOf(h.tracker, issue);
    const writes = h.tracker.writes;
    h.tracker.failNext('postComment');

    await expect(
      stagePublish(h.ctx, issue, 'planning', { file: await summaryFile(), needsApproval: true }),
    ).rejects.toThrow(/postComment failed for #1.*state was not changed/);

    expect(await stateOf(h.tracker, issue)).toEqual(before);
    expect(h.tracker.writes).toBe(writes);
  });

  it('posts no comment for a phase the task type does not have', async () => {
    const h = setup();
    const issue = await newTask(h);
    await expect(
      stagePublish(h.ctx, issue, 'analysis', { file: await summaryFile(), needsApproval: false }),
    ).rejects.toThrow(/phase "analysis" is not part of task type "feature"/);
    expect(visibleComments(h.tracker, issue)).toHaveLength(0);
  });

  it('fails clearly when the summary file is missing, before touching the tracker', async () => {
    const h = setup();
    const issue = await newTask(h);
    const writes = h.tracker.writes;
    await expect(
      stagePublish(h.ctx, issue, 'planning', { file: join(dir, 'missing.md'), needsApproval: false }),
    ).rejects.toThrow(/Cannot read the stage summary .*missing\.md/);
    expect(h.tracker.writes).toBe(writes);
  });
});

describe('commit', () => {
  it('commit surfaces the failing step', async () => {
    const h = setup();
    const issue = await newTask(h);
    h.tracker.failNext('syncFields');

    await expect(taskCheckpoint(h.ctx, issue, { current: 'Reading code' })).rejects.toThrow(/syncFields failed for #1/);

    // The state comment was written before the failing step; the board was not synced.
    expect((await stateOf(h.tracker, issue)).currentStep).toBe('Reading code');
    expect(h.tracker.fields.get(issue)?.currentStep).toBe('');
  });

  it('points at reconcile once the state is saved but a later step failed', async () => {
    const h = setup();
    const issue = await newTask(h);
    h.tracker.failNext('syncFields');
    await expect(taskCheckpoint(h.ctx, issue, { current: 'x' })).rejects.toThrow(/saved; run "sdlc reconcile"/);
  });

  it('stops at a failed state write without syncing anything', async () => {
    const h = setup();
    const issue = await newTask(h);
    h.tracker.failNext('writeState');

    await expect(taskCheckpoint(h.ctx, issue, { current: 'Reading code' })).rejects.toThrow(/writeState failed for #1/);

    expect((await stateOf(h.tracker, issue)).currentStep).toBe('');
    expect(h.tracker.fields.get(issue)?.currentStep).toBe('');
  });

  it('names a failed read of the task', async () => {
    const h = setup();
    const issue = await newTask(h);
    h.tracker.failNext('getTask');
    await expect(taskCheckpoint(h.ctx, issue, { current: 'x' })).rejects.toThrow(/getTask failed for #1/);
  });

  it('only touches the issue when its open state has to change', async () => {
    const h = setup();
    const issue = await newTask(h);

    let writes = h.tracker.writes;
    await taskCheckpoint(h.ctx, issue, { current: 'Working' });
    expect(h.tracker.writes - writes).toBe(2); // writeState + syncFields

    await approve(h.ctx, issue, { action: 'cancel', reason: 'Not needed', unverified: true });
    expect(issueOf(h.tracker, issue).open).toBe(false);

    writes = h.tracker.writes;
    await taskReopen(h.ctx, issue);
    expect(h.tracker.writes - writes).toBe(3); // writeState + syncFields + setIssueOpen
    expect(issueOf(h.tracker, issue).open).toBe(true);
  });

  it('names a failed issue close', async () => {
    const h = setup();
    const issue = await newTask(h);
    h.tracker.failNext('setIssueOpen');
    await expect(approve(h.ctx, issue, { action: 'cancel', reason: 'r', unverified: true })).rejects.toThrow(
      /setIssueOpen failed for #1/,
    );
    expect((await stateOf(h.tracker, issue)).outcome).toBe('cancelled');
  });

  it('refuses a task whose type is no longer enabled, listing the enabled ones', async () => {
    const h = setup();
    const issue = await newTask(h, 'analysis');
    const narrowed: CommandContext = { ...h.ctx, cfg: { ...cfg, taskTypes: { ...cfg.taskTypes, enabled: ['feature'] } } };
    await expect(taskCheckpoint(narrowed, issue, { current: 'x' })).rejects.toThrow(
      /Task #1 has task type "analysis", which is not enabled \(enabled types: feature, infra-change\)/,
    );
  });
});

describe('taskSetType', () => {
  it('swaps the type label, the state and the board type', async () => {
    const h = setup();
    const issue = await newTask(h);
    const state = await taskSetType(h.ctx, issue, 'tooling');

    expect(state.type).toBe('tooling');
    expect((await stateOf(h.tracker, issue)).type).toBe('tooling');
    expect(issueOf(h.tracker, issue).labels).toEqual(['sdlc:task', 'type:tooling']);
    expect(h.tracker.fields.get(issue)?.type).toBe('Tooling');
  });

  it('refuses a type that is not enabled and leaves the labels alone', async () => {
    const h = setup();
    const issue = await newTask(h);
    await expect(taskSetType(h.ctx, issue, 'nope')).rejects.toThrow(/Unknown or disabled task type "nope"/);
    expect(issueOf(h.tracker, issue).labels).toEqual(['sdlc:task', 'type:feature']);
  });

  it('refuses a done task', async () => {
    const h = setup();
    const issue = await newTask(h);
    await approve(h.ctx, issue, { action: 'cancel', reason: 'r', unverified: true });
    await expect(taskSetType(h.ctx, issue, 'tooling')).rejects.toThrow(/the task is done/);
    expect(issueOf(h.tracker, issue).labels).toEqual(['sdlc:task', 'type:feature']);
  });

  it('can move a task off a type that is no longer enabled', async () => {
    const h = setup();
    const issue = await newTask(h, 'analysis');
    const narrowed: CommandContext = { ...h.ctx, cfg: { ...cfg, taskTypes: { ...cfg.taskTypes, enabled: ['feature'] } } };
    await taskSetType(narrowed, issue, 'feature');
    expect((await stateOf(h.tracker, issue)).type).toBe('feature');
    expect(issueOf(h.tracker, issue).labels).toEqual(['sdlc:task', 'type:feature']);
  });
});

describe('taskCheckpoint and taskReopen', () => {
  it('records the step, agent, who is waited on and a blocked status on the board', async () => {
    const h = setup();
    const issue = await newTask(h);
    await taskCheckpoint(h.ctx, issue, {
      current: 'Waiting for the API key',
      next: 'Wire the client',
      agent: 'codex/developer',
      waitingOn: 'external',
      status: 'blocked',
    });
    expect(h.tracker.fields.get(issue)).toMatchObject({
      status: 'Blocked',
      waitingOn: 'External',
      currentStep: 'Waiting for the API key',
      nextStep: 'Wire the client',
      agent: 'codex/developer',
    });
  });

  it('reopens a cancelled task at its first phase and opens the issue', async () => {
    const h = setup();
    const issue = await newTask(h);
    await stageStart(h.ctx, issue, 'planning');
    await approve(h.ctx, issue, { action: 'cancel', reason: 'r', unverified: true });
    const state = await taskReopen(h.ctx, issue);

    expect(state).toMatchObject({ status: 'in_progress', phase: 'intake', waitingOn: 'agent' });
    expect(issueOf(h.tracker, issue)).toMatchObject({ open: true });
    expect(issueOf(h.tracker, issue).closeReason).toBeUndefined();
    expect(h.tracker.fields.get(issue)).toMatchObject({ status: 'In progress', phase: 'Intake' });
  });

  it('refuses to reopen a task that is not done', async () => {
    const h = setup();
    const issue = await newTask(h);
    await expect(taskReopen(h.ctx, issue)).rejects.toThrow(/only a done task can be reopened/);
  });
});

describe('evidenceAdd', () => {
  it('records evidence that unblocks the review handoff of a production-data task', async () => {
    const h = setup();
    const issue = await newTask(h, 'production-data');
    linkPr(h.tracker, issue, 50, 'Related to #1');

    await expect(reviewHandoff(h.ctx, issue, { pr: 50 })).rejects.toThrow('missing evidence: backup, dry_run');
    await evidenceAdd(h.ctx, issue, { kind: 'backup', ref: 's3://backups/2026-06-01' });
    await evidenceAdd(h.ctx, issue, { kind: 'dry_run', ref: 'https://ci.test/runs/9' });
    const state = await reviewHandoff(h.ctx, issue, { pr: 50 });

    expect(state.status).toBe('in_review');
    expect(state.evidence.map(e => [e.kind, e.ref])).toEqual([
      ['backup', 's3://backups/2026-06-01'],
      ['dry_run', 'https://ci.test/runs/9'],
    ]);
  });

  it('refuses evidence without a ref', async () => {
    const h = setup();
    const issue = await newTask(h, 'production-data');
    await expect(evidenceAdd(h.ctx, issue, { kind: 'backup', ref: ' ' })).rejects.toThrow(/needs a ref/);
  });
});

describe('reviewHandoff', () => {
  it('refuses a PR that is not linked to the task', async () => {
    const h = setup();
    const issue = await newTask(h);
    linkPr(h.tracker, 99, 51, 'Related to #99');
    await expect(reviewHandoff(h.ctx, issue, { pr: 51 })).rejects.toThrow(
      'PR #51 is not linked to #1 (add "Related to #1" to its body)',
    );
    expect((await stateOf(h.tracker, issue)).status).toBe('in_progress');
  });

  it('refuses a Scope line with no recognised value, naming the accepted ones', async () => {
    const h = setup();
    const issue = await newTask(h);
    linkPr(h.tracker, issue, 50, 'Related to #1\nScope: wip\nTargets: web');
    await expect(reviewHandoff(h.ctx, issue, { pr: 50 })).rejects.toThrow(/"Scope: partial", "Scope: final"/);
    expect((await stateOf(h.tracker, issue)).prs).toEqual([]);
  });

  it('takes the scope from the PR body: partial hands over without targets', async () => {
    const h = setup();
    const issue = await newTask(h);
    linkPr(h.tracker, issue, 50, 'Related to #1\nScope: partial');
    const state = await reviewHandoff(h.ctx, issue, { pr: 50 });
    expect(state.prs).toEqual([{ number: 50, scope: 'partial' }]);
    expect(state.status).toBe('in_review');
  });

  it('prefers the targets it is given over the PR body', async () => {
    const h = setup();
    const issue = await newTask(h);
    linkPr(h.tracker, issue, 50, 'Related to #1\nTargets: web');
    const state = await reviewHandoff(h.ctx, issue, { pr: 50, targets: ['api'] });
    expect(state.targets).toEqual(['api']);
  });

  it('refuses a target that is not configured when the type requires targets', async () => {
    const h = setup();
    const issue = await newTask(h);
    linkPr(h.tracker, issue, 50, 'Related to #1');
    await expect(reviewHandoff(h.ctx, issue, { pr: 50, targets: ['mobile'] })).rejects.toThrow(
      'Unknown target "mobile" (configured targets: web, api)',
    );
    expect((await stateOf(h.tracker, issue)).status).toBe('in_progress');
  });

  it('refuses a final handoff without targets when the type requires them', async () => {
    const h = setup();
    const issue = await newTask(h);
    linkPr(h.tracker, issue, 50, 'Related to #1\nScope: final');
    await expect(reviewHandoff(h.ctx, issue, { pr: 50 })).rejects.toThrow(/requires at least one target/);
  });

  it('hands a type without targets over with none', async () => {
    const h = setup();
    const issue = await newTask(h, 'tooling');
    linkPr(h.tracker, issue, 50, 'Related to #1');
    expect((await reviewHandoff(h.ctx, issue, { pr: 50 })).targets).toEqual([]);
  });

  it('names a failed PR lookup', async () => {
    const h = setup();
    const issue = await newTask(h);
    h.tracker.failNext('listTaskPrs');
    await expect(reviewHandoff(h.ctx, issue, { pr: 50 })).rejects.toThrow(/listTaskPrs failed for #1/);
  });
});

describe('approve sources', () => {
  it('unverified approval refused in enforce mode', async () => {
    const h = setup(enforceCfg);
    const issue = await pausedFeature(h);
    const before = await stateOf(h.tracker, issue);
    const writes = h.tracker.writes;

    await expect(approve(h.ctx, issue, { action: 'approve', unverified: true })).rejects.toThrow(
      'unverified approvals are not allowed in enforce mode',
    );

    expect(await stateOf(h.tracker, issue)).toEqual(before);
    expect(h.tracker.writes).toBe(writes);
  });

  it('records an unverified approval as the tracker login at the time of the command', async () => {
    const h = setup();
    h.tracker.login = 'agent-login';
    const issue = await pausedFeature(h);
    const state = await approve(h.ctx, issue, { action: 'approve', unverified: true });

    const approval = state.stages.brainstorming?.approval;
    expect(approval).toMatchObject({ source: 'unverified', by: 'agent-login' });
    expect(Date.parse(approval!.at)).toBeGreaterThan(Date.parse(state.stages.brainstorming!.publishedAt!));
    expect(state).toMatchObject({ status: 'in_progress', waitingOn: 'agent' });
  });

  it('needs exactly one source', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    await expect(approve(h.ctx, issue, { action: 'approve' })).rejects.toThrow(/needs --comment-url/);
    await expect(
      approve(h.ctx, issue, { action: 'approve', unverified: true, commentUrl: 'https://x.test/1#issuecomment-1' }),
    ).rejects.toThrow(/either --comment-url or --unverified/);
  });

  it("accepts an owner's comment on the issue, stored with its url, author and time", async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    const url = ownerComment(h.tracker, issue, AFTER, { author: 'Shop-Owner' });

    const state = await approve(h.ctx, issue, { action: 'approve', commentUrl: url });

    expect(state.stages.brainstorming?.approval).toEqual({ source: 'comment', ref: url, by: 'Shop-Owner', at: AFTER });
    expect(state).toMatchObject({ status: 'in_progress', waitingOn: 'agent' });
    expect(h.tracker.fields.get(issue)).toMatchObject({ status: 'In progress', waitingOn: 'Agent' });
  });

  it("accepts an owner's comment on one of the task's PRs", async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    linkPr(h.tracker, issue, 50, 'Related to #1');
    const url = ownerComment(h.tracker, 50, AFTER);

    const state = await approve(h.ctx, issue, { action: 'approve', commentUrl: url });
    expect(state.stages.brainstorming?.approval).toMatchObject({ source: 'comment', ref: url });
  });

  it('refuses a comment by someone who is not an owner', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    const url = ownerComment(h.tracker, issue, AFTER, { author: 'drive-by' });
    await expect(approve(h.ctx, issue, { action: 'approve', commentUrl: url })).rejects.toThrow(
      /by drive-by, who is not a configured owner/,
    );
    expect((await stateOf(h.tracker, issue)).status).toBe('paused');
  });

  it('refuses an owner comment that is not the command being run', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    const bodies = ['Looks good to me', '> /approve', 'Thanks!\n/approve', '/approved', '/accept'];
    for (const body of bodies) {
      const url = ownerComment(h.tracker, issue, AFTER, { body });
      await expect(approve(h.ctx, issue, { action: 'approve', commentUrl: url })).rejects.toThrow(
        `Comment ${url} is not a /approve command`,
      );
    }
    expect((await stateOf(h.tracker, issue)).status).toBe('paused');
  });

  it('accepts the command in any letter case with a note after it', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    const url = ownerComment(h.tracker, issue, AFTER, { body: '\n/Approve  go ahead\n\nThanks' });
    const state = await approve(h.ctx, issue, { action: 'approve', commentUrl: url });
    expect(state.stages.brainstorming?.approval).toMatchObject({ source: 'comment', ref: url });
  });

  it('refuses a comment older than the stage it approves', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    const url = ownerComment(h.tracker, issue, BEFORE);
    await expect(approve(h.ctx, issue, { action: 'approve', commentUrl: url })).rejects.toThrow(
      /not newer than stage "brainstorming" published at/,
    );
    expect((await stateOf(h.tracker, issue)).status).toBe('paused');
  });

  it('refuses a comment that is not on the issue or its PRs', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    linkPr(h.tracker, issue, 50, 'Related to #1');
    await expect(
      approve(h.ctx, issue, { action: 'approve', commentUrl: 'https://github.test/issues/9#issuecomment-404' }),
    ).rejects.toThrow('Comment https://github.test/issues/9#issuecomment-404 was not found on #1 or its pull requests');
  });

  it('names a failed comment lookup', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    const url = ownerComment(h.tracker, issue, AFTER);
    h.tracker.failNext('listComments');
    await expect(approve(h.ctx, issue, { action: 'approve', commentUrl: url })).rejects.toThrow(/listComments failed/);
  });

  it('checks the stage was published before looking at any comment', async () => {
    const h = setup();
    const issue = await newTask(h);
    await expect(
      approve(h.ctx, issue, { action: 'approve', commentUrl: 'https://github.test/issues/1#issuecomment-404' }),
    ).rejects.toThrow('stage "intake" has not been published, nothing to approve');
  });
});

describe('approve actions', () => {
  it('approves the current phase by default and another phase on request', async () => {
    const h = setup();
    const issue = await pausedFeature(h);
    await stageStart(h.ctx, issue, 'planning');

    await expect(approve(h.ctx, issue, { action: 'approve', unverified: true })).rejects.toThrow(
      'stage "planning" has not been published, nothing to approve',
    );
    const state = await approve(h.ctx, issue, { action: 'approve', phase: 'brainstorming', unverified: true });
    expect(state.stages.brainstorming?.approval?.source).toBe('unverified');
  });

  it('accepts a published analysis result with a newer owner comment', async () => {
    const h = setup();
    const issue = await newTask(h, 'analysis');
    await stageStart(h.ctx, issue, 'analysis');
    await stagePublish(h.ctx, issue, 'analysis', { file: await summaryFile('Findings'), needsApproval: false });

    const stale = ownerComment(h.tracker, issue, BEFORE, { body: '/accept' });
    await expect(approve(h.ctx, issue, { action: 'accept', commentUrl: stale })).rejects.toThrow(
      /not newer than the result published at/,
    );

    const url = ownerComment(h.tracker, issue, AFTER, { body: '/accept' });
    const state = await approve(h.ctx, issue, { action: 'accept', commentUrl: url });
    expect(state).toMatchObject({ status: 'done', outcome: 'completed' });
    expect(state.outcomeApproval).toMatchObject({ source: 'comment', ref: url, by: OWNER });
    expect(issueOf(h.tracker, issue)).toMatchObject({ open: false, closeReason: 'completed' });
    expect(h.tracker.fields.get(issue)?.status).toBe('Done');
  });

  it('refuses to accept a type that does not end on acceptance', async () => {
    const h = setup();
    const issue = await newTask(h);
    await expect(approve(h.ctx, issue, { action: 'accept', unverified: true })).rejects.toThrow(
      /does not end on owner acceptance/,
    );
  });

  describe('ran', () => {
    /**
     * A production-data task whose final PR 50 merged at `mergedAt` (the tracker reports none when
     * it is undefined); the merge was recorded at 2026-06-02, as reconcile would.
     */
    async function mergedProductionData(h: Harness, mergedAt: string | undefined): Promise<number> {
      const issue = await newTask(h, 'production-data');
      await evidenceAdd(h.ctx, issue, { kind: 'backup', ref: 'b' });
      await evidenceAdd(h.ctx, issue, { kind: 'dry_run', ref: 'd' });
      linkPr(h.tracker, issue, 50, 'Related to #1\nScope: final');
      await reviewHandoff(h.ctx, issue, { pr: 50 });
      const { state } = await h.tracker.getTask(issue);
      const type = typeRegistry(cfg).get('production-data')!;
      await h.tracker.writeState(
        issue,
        applyEvent(state, { kind: 'pr_merged', pr: 50, scope: 'final', mergeSha: 'abc123' }, type, '2026-06-02T00:00:00.000Z'),
      );
      Object.assign(h.tracker.prs[0], { merged: true, mergeSha: 'abc123', ...(mergedAt && { mergedAt }) });
      return issue;
    }

    it('confirms a run with an owner comment posted after the PR merged', async () => {
      const h = setup();
      const issue = await mergedProductionData(h, '2026-06-10T00:00:00.000Z');
      const url = ownerComment(h.tracker, issue, '2026-06-11T00:00:00.000Z', { body: '/ran' });

      const state = await approve(h.ctx, issue, { action: 'ran', commentUrl: url });
      expect(state).toMatchObject({ status: 'done', outcome: 'completed' });
      expect(issueOf(h.tracker, issue)).toMatchObject({ open: false, closeReason: 'completed' });
    });

    it('refuses a comment posted before the final PR merged', async () => {
      const h = setup();
      const issue = await mergedProductionData(h, '2026-06-10T00:00:00.000Z');
      const early = ownerComment(h.tracker, issue, '2026-06-09T00:00:00.000Z', { body: '/ran' });

      await expect(approve(h.ctx, issue, { action: 'ran', commentUrl: early })).rejects.toThrow(
        /not newer than the final PR merged at 2026-06-10/,
      );
      expect((await stateOf(h.tracker, issue)).status).toBe('paused');
    });

    it('falls back to the recorded merge time when the PR has no mergedAt', async () => {
      const h = setup();
      const issue = await mergedProductionData(h, undefined);

      const early = ownerComment(h.tracker, issue, BEFORE, { body: '/ran' });
      await expect(approve(h.ctx, issue, { action: 'ran', commentUrl: early })).rejects.toThrow(
        /not newer than the final PR merged at 2026-06-02/,
      );
      expect((await stateOf(h.tracker, issue)).status).toBe('paused');

      const late = ownerComment(h.tracker, issue, AFTER, { body: '/ran' });
      expect((await approve(h.ctx, issue, { action: 'ran', commentUrl: late })).status).toBe('done');
    });

    it('refuses before the final PR is merged', async () => {
      const h = setup();
      const issue = await newTask(h, 'production-data');
      await expect(approve(h.ctx, issue, { action: 'ran', unverified: true })).rejects.toThrow(
        'cannot confirm: the final PR has not been merged',
      );
    });
  });

  describe('cancel', () => {
    it('cancel posts report then closes issue not_planned', async () => {
      const h = setup();
      const issue = await newTask(h);
      const state = await approve(h.ctx, issue, { action: 'cancel', reason: 'Superseded by #8', unverified: true });

      const [report, ...rest] = visibleComments(h.tracker, issue);
      expect(rest).toHaveLength(0);
      expect(report.body).toContain('### Cancelled');
      expect(report.body).toContain('**Reason:** Superseded by #8');
      expect(report.body).toContain('Approved by sdlc-bot (unverified)');

      // The report was posted before the state comment was last written.
      const stateComment = h.tracker.comments.find(c => c.body.startsWith(STATE_MARKER))!;
      expect(Date.parse(stateComment.updatedAt)).toBeGreaterThan(Date.parse(report.createdAt));

      expect(issueOf(h.tracker, issue)).toMatchObject({ open: false, closeReason: 'not_planned' });
      expect(state).toMatchObject({ status: 'done', outcome: 'cancelled', cancelReason: 'Superseded by #8' });
      expect(h.tracker.fields.get(issue)).toMatchObject({
        status: 'Done',
        currentStep: 'Cancelled — Superseded by #8',
        nextStep: 'None',
      });
    });

    it('changes nothing when the report cannot be posted', async () => {
      const h = setup();
      const issue = await newTask(h);
      const writes = h.tracker.writes;
      h.tracker.failNext('postComment');

      await expect(approve(h.ctx, issue, { action: 'cancel', reason: 'r', unverified: true })).rejects.toThrow(
        /postComment failed/,
      );
      expect((await stateOf(h.tracker, issue)).status).toBe('in_progress');
      expect(issueOf(h.tracker, issue).open).toBe(true);
      expect(h.tracker.writes).toBe(writes);
    });

    it('posts no report for a task that cannot be cancelled', async () => {
      const h = setup();
      const issue = await newTask(h);
      await approve(h.ctx, issue, { action: 'cancel', reason: 'r', unverified: true });
      await expect(approve(h.ctx, issue, { action: 'cancel', reason: 'again', unverified: true })).rejects.toThrow(
        /done task/,
      );
      expect(visibleComments(h.tracker, issue)).toHaveLength(1);
    });

    it('needs a comment newer than the reopen after a reopen', async () => {
      const h = setup();
      const issue = await newTask(h);
      await approve(h.ctx, issue, { action: 'cancel', reason: 'r', unverified: true });
      await taskReopen(h.ctx, issue);

      const stale = ownerComment(h.tracker, issue, BEFORE, { body: '/cancel again' });
      await expect(approve(h.ctx, issue, { action: 'cancel', commentUrl: stale })).rejects.toThrow(
        /not newer than the reopen/,
      );
      const fresh = ownerComment(h.tracker, issue, AFTER, { body: '/cancel again' });
      const state = await approve(h.ctx, issue, { action: 'cancel', commentUrl: fresh });
      expect(state.outcomeApproval).toMatchObject({ source: 'comment', ref: fresh });
    });

    it("takes the reason from the owner's comment, unless --reason is given", async () => {
      const h = setup();
      const first = await newTask(h);
      const second = await newTask(h);
      const fromComment = ownerComment(h.tracker, first, AFTER, { body: '/cancel scope dropped\n\nsorry' });
      const overridden = ownerComment(h.tracker, second, AFTER, { body: '/cancel scope dropped' });

      const a = await approve(h.ctx, first, { action: 'cancel', commentUrl: fromComment });
      const b = await approve(h.ctx, second, { action: 'cancel', commentUrl: overridden, reason: 'Superseded by #8' });

      expect(a.cancelReason).toBe('scope dropped');
      expect(h.tracker.fields.get(first)?.currentStep).toBe('Cancelled — scope dropped');
      expect(visibleComments(h.tracker, first).at(-1)?.body).toContain('**Reason:** scope dropped');
      expect(b.cancelReason).toBe('Superseded by #8');
    });

    it('refuses a /cancel comment that gives no reason', async () => {
      const h = setup();
      const issue = await newTask(h);
      const url = ownerComment(h.tracker, issue, AFTER, { body: '/cancel' });
      await expect(approve(h.ctx, issue, { action: 'cancel', commentUrl: url })).rejects.toThrow(
        `Comment ${url} is not a /cancel command`,
      );
      expect((await stateOf(h.tracker, issue)).status).toBe('in_progress');
    });
  });
});

describe('argument parsing', () => {
  it('reads issue numbers with or without #', () => {
    expect(parseIssueNumber('12')).toBe(12);
    expect(parseIssueNumber('#12')).toBe(12);
    for (const bad of ['', '0', '-3', '1.5', 'abc', '12abc']) {
      expect(() => parseIssueNumber(bad)).toThrow(/Invalid issue number/);
    }
  });

  it('matches choices ignoring case and treating - as _, and lists the choices otherwise', () => {
    expect(parseChoice('Dry-Run', ['backup', 'dry_run'], 'evidence kind')).toBe('dry_run');
    expect(() => parseChoice('x', ['backup', 'dry_run'], 'evidence kind')).toThrow(
      'Invalid evidence kind "x" (expected one of: backup, dry_run)',
    );
  });

  it('splits a target list into unique lowercase names', () => {
    expect(parseTargetList(' Web, api ,,web')).toEqual(['web', 'api']);
  });
});

describe('commander wiring', () => {
  function program(h: Harness): Command {
    const root = new Command().exitOverride();
    const make = () => h.ctx;
    registerTaskCommand(root, make);
    registerStageCommand(root, make);
    registerEvidenceCommand(root, make);
    registerReviewCommand(root, make);
    registerApproveCommand(root, make);
    return root;
  }
  const run = (root: Command, ...args: string[]) => root.parseAsync(['node', 'sdlc', ...args]);

  it('drives a task from the command line and prints human text', async () => {
    const h = setup();
    const root = program(h);
    const file = await summaryFile();

    await run(root, 'task', 'new', '--title', 'Add search', '--summary', 'Search box', '--type', 'feature');
    await run(root, 'stage', 'start', '1', 'brainstorming');
    await run(root, 'stage', 'publish', '1', 'brainstorming', '--file', file, '--needs-approval');
    await run(root, 'approve', '1', 'approve', '--unverified');
    await run(root, 'task', 'checkpoint', '1', '--current', 'Planning', '--waiting-on', 'agent', '--status', 'blocked');

    expect(h.out).toEqual([
      'Created #1: https://github.test/issues/1',
      '#1: In progress, Brainstorming, waiting on Agent',
      '#1: Paused, Brainstorming, waiting on Owner',
      '#1: In progress, Brainstorming, waiting on Agent',
      '#1: Blocked, Brainstorming, waiting on Agent',
    ]);
    expect(h.err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
  });

  it('runs the evidence, review and set-type commands', async () => {
    const h = setup();
    const root = program(h);
    await run(root, 'task', 'new', '--title', 'T', '--summary', 'S', '--type', 'production-data');
    await run(root, 'evidence', 'add', '1', '--kind', 'dry-run', '--ref', 'run-1');
    await run(root, 'evidence', 'add', '1', '--kind', 'backup', '--ref', 'snap-1');
    linkPr(h.tracker, 1, 50, 'Related to #1');
    await run(root, 'review', 'handoff', '1', '--pr', '50', '--targets', 'Web');
    await run(root, 'task', 'set-type', '1', 'tooling');

    expect(h.err).toEqual([]);
    expect(await stateOf(h.tracker, 1)).toMatchObject({ type: 'tooling', status: 'in_review', targets: ['web'] });
  });

  it('prints JSON with --json', async () => {
    const h = setup();
    const root = program(h);
    await run(root, 'task', 'new', '--title', 'T', '--summary', 'S', '--type', 'tooling', '--json');
    await run(root, 'task', 'checkpoint', '1', '--current', 'x', '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual({ issue: 1, url: 'https://github.test/issues/1' });
    expect(JSON.parse(h.out[1] as string)).toMatchObject({ issue: 1, status: 'in_progress', currentStep: 'x' });
  });

  it('prints a failure to err and exits 1 instead of rejecting', async () => {
    const h = setup();
    const root = program(h);
    await run(root, 'task', 'checkpoint', '99', '--current', 'x');

    expect(h.out).toEqual([]);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(/getTask failed for #99/);
    expect(process.exitCode).toBe(1);
  });

  it('prints a failure as {"error"} on out with --json and exits 1', async () => {
    const h = setup();
    const root = program(h);
    await run(root, 'approve', '1', 'cancel', '--unverified', '--json');

    expect(h.err).toEqual([]);
    expect(JSON.parse(h.out[0] as string)).toEqual({ error: expect.stringMatching(/getTask failed for #1/) });
    expect(process.exitCode).toBe(1);
  });

  it('reports invalid arguments the same way', async () => {
    const h = setup();
    const root = program(h);
    await run(root, 'stage', 'start', 'one', 'planning');
    await run(root, 'stage', 'start', '1', 'dreaming');
    await run(root, 'approve', '1', 'bless', '--unverified');

    expect(h.err).toEqual([
      expect.stringContaining('Invalid issue number "one"'),
      expect.stringContaining('Invalid phase "dreaming" (expected one of: intake, debugging'),
      expect.stringContaining('Invalid action "bless" (expected one of: approve, accept, ran, cancel)'),
    ]);
  });

  it('falls back to stdout and stderr when the context cannot be built', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const root = new Command().exitOverride();
    registerTaskCommand(root, () => {
      throw new Error('sdlc.config.yaml not found');
    });

    await run(root, 'task', 'reopen', '1');
    expect(stderr).toHaveBeenCalledWith('sdlc.config.yaml not found\n');
    await run(root, 'task', 'reopen', '1', '--json');
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ error: 'sdlc.config.yaml not found' }, null, 2) + '\n');
    expect(process.exitCode).toBe(1);
  });
});
