import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve } from '../../src/commands/approve.js';
import { stagePublish } from '../../src/commands/stage.js';
import { taskCheckpoint, taskNew } from '../../src/commands/task.js';
import { normalizeCommentUrl } from '../../src/core/approvals.js';
import { projectTask } from '../../src/core/projection.js';
import { STATE_MARKER } from '../../src/core/stateComment.js';
import { reconcile } from '../../src/engine/reconcile.js';
import { typeRegistry } from '../../src/config/schema.js';
import { createSandbox, readE2eEnv, type Sandbox } from './support.js';

// Opt-in: without SDLC_E2E_REPO every test below is skipped, and `npm test` never loads this file.
// The commands run in-process, the way src/cli.ts calls them (a CommandContext over a real
// GitHubTracker and the real `gh`), against one sandbox repository and one Projects v2 board.
const env = readE2eEnv();

describe.skipIf(env === undefined)('e2e: task flow against a sandbox repository', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await createSandbox(env as NonNullable<typeof env>);
  });

  afterAll(async () => {
    // Closes what is still open; the repository and the project are never deleted.
    await sandbox?.cleanup();
    for (const warning of sandbox?.warnings ?? []) console.warn(`e2e: ${warning}`);
  });

  it('issue lifecycle', async () => {
    const { ctx, login, repo } = sandbox;
    const spike = typeRegistry(ctx.cfg).get('spike');
    if (!spike) throw new Error('the spike task type is not enabled in the e2e config');

    // 1. task new (spike): an issue with `sdlc:task`, the type and e2e labels, a state comment and a board item.
    const title = `${sandbox.titlePrefix}: lifecycle`;
    const created = await taskNew(ctx, { title, summary: 'e2e issue lifecycle', type: 'spike' });
    const issue = created.issue;
    expect(created.url.toLowerCase()).toContain(`${repo.toLowerCase()}/issues/${issue}`);
    const opened = await sandbox.issueView(issue);
    expect(opened.state).toBe('OPEN');
    expect(opened.labels).toEqual(expect.arrayContaining(['sdlc:task', 'type:spike', 'e2e']));
    const comments = await ctx.tracker.listComments(issue);
    const stateComment = comments.find(comment => comment.body.trimStart().startsWith(STATE_MARKER));
    expect(stateComment?.author.toLowerCase()).toBe(login.toLowerCase());
    const first = await ctx.tracker.getTask(issue);
    expect(first.state).toMatchObject({ issue, type: 'spike', phase: 'intake', status: 'in_progress', summary: 'e2e issue lifecycle' });
    expect((await sandbox.boardItem(title))?.status).toBe(projectTask(first.state, spike).fields.status);

    // 2. stage publish: the summary is an issue comment, and the task waits on the owner.
    const summaryFile = join(sandbox.dir, 'intake.md');
    writeFileSync(summaryFile, 'e2e intake summary: nothing to decide, this is a test.\n');
    const published = await stagePublish(ctx, issue, 'intake', { file: summaryFile, needsApproval: true });
    expect(published).toMatchObject({ status: 'paused', waitingOn: 'owner' });
    expect(published.stages.intake?.revision).toBe(1);
    const afterPublish = await ctx.tracker.listComments(issue);
    const summary = afterPublish.find(comment => comment.body.includes('e2e intake summary'));
    expect(summary?.body).toContain('### Intake');
    expect(summary?.author.toLowerCase()).toBe(login.toLowerCase());

    // 3. An owner's /approve comment, then reconcile: recorded as unverified, because in observe mode
    // a comment by the tool's own login cannot be told from the agent approving itself.
    await sandbox.pause();
    const approveUrl = await sandbox.commentOn(issue, '/approve');
    const reconciled = await reconcile(ctx, { issue });
    expect(reconciled.errors, JSON.stringify(reconciled.actions)).toBe(0);
    expect(reconciled.actions).toEqual(expect.arrayContaining([expect.objectContaining({ issue, kind: 'approval' })]));
    const approved = await ctx.tracker.getTask(issue);
    expect(approved.state).toMatchObject({ status: 'in_progress', waitingOn: 'agent' });
    const approval = approved.state.stages.intake?.approval;
    expect(approval?.source).toBe('unverified');
    expect(approval?.by.toLowerCase()).toBe(login.toLowerCase());
    expect(normalizeCommentUrl(approval?.ref ?? '')).toBe(normalizeCommentUrl(approveUrl));

    // 4. task checkpoint
    const checkpoint = await taskCheckpoint(ctx, issue, { current: 'e2e checkpoint', next: 'cancel', agent: 'e2e/suite' });
    expect(checkpoint).toMatchObject({ currentStep: 'e2e checkpoint', nextStep: 'cancel', agent: 'e2e/suite' });
    const checkpointed = await ctx.tracker.getTask(issue);
    expect(checkpointed.state).toMatchObject({ currentStep: 'e2e checkpoint', nextStep: 'cancel', agent: 'e2e/suite' });

    // 5. cancel with the reason "e2e" (`sdlc approve <issue> cancel --reason e2e --unverified`): the issue is closed.
    const cancelled = await approve(ctx, issue, { action: 'cancel', reason: 'e2e', unverified: true });
    expect(cancelled).toMatchObject({ status: 'done', outcome: 'cancelled', cancelReason: 'e2e' });
    const closed = await sandbox.issueView(issue);
    expect(closed.state).toBe('CLOSED');
    expect(closed.stateReason).toBe('NOT_PLANNED');
    const done = await ctx.tracker.getTask(issue);
    expect(done).toMatchObject({ issueOpen: false, closeReason: 'not_planned' });
    expect(done.state).toMatchObject({ status: 'done', outcome: 'cancelled', cancelReason: 'e2e' });
    expect((await ctx.tracker.listComments(issue)).some(comment => comment.body.startsWith('### Cancelled'))).toBe(true);
    expect((await sandbox.boardItem(title))?.status).toBe(projectTask(done.state, spike).fields.status);

    // Nothing is left for reconcile to repair.
    const settled = await reconcile(ctx, { issue });
    expect(settled.errors, JSON.stringify(settled.actions)).toBe(0);
  });
});
