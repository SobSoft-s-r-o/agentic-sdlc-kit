import { describe, expect, it } from 'vitest';
import {
  finalMergeTime,
  parseApprovalCommands,
  validateCommentApproval,
  ApprovalRefusedError,
  type CommentApprovalCheck,
} from '../../src/core/approvals.js';
import { newTask, TransitionError } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { TaskState } from '../../src/core/types.js';
import type { IssueComment } from '../../src/tracker/types.js';

const PUBLISHED = '2026-03-01T00:00:00.000Z';
const BEFORE = '2026-02-01T00:00:00.000Z';
const AFTER = '2026-04-01T00:00:00.000Z';

let nextId = 1;
function comment(body: string, author = 'owner', createdAt = AFTER, updatedAt = createdAt): IssueComment {
  const id = String(nextId++);
  return { id, url: `https://github.test/issues/1#issuecomment-${id}`, author, body, createdAt, updatedAt };
}

const feature = BUILTIN_TYPES.find(t => t.id === 'feature')!;
function paused(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...newTask({ issue: 1, type: feature, summary: 's', now: '2026-01-01T00:00:00.000Z' }),
    phase: 'brainstorming',
    status: 'paused',
    waitingOn: 'owner',
    stages: { brainstorming: { revision: 1, publishedAt: PUBLISHED } },
    ...overrides,
  };
}

function check(overrides: Partial<CommentApprovalCheck>): CommentApprovalCheck {
  return {
    comment: comment('/approve'),
    action: 'approve',
    phase: 'brainstorming',
    state: paused(),
    cfg: { owners: ['Owner'], mode: 'observe' },
    login: async () => 'sdlc-bot',
    finalMergedAt: async () => undefined,
    ...overrides,
  };
}

describe('parseApprovalCommands', () => {
  it('returns owner commands in order and the same commands by others as ignored', () => {
    const comments = [
      comment('/approve', 'OWNER'),
      comment('/approve', 'drive-by'),
      comment('Looks good\n/accept', 'owner'),
      comment('/merge', 'owner'),
      comment('\n /Cancel no longer needed\nmore', 'owner'),
      comment('/ran', 'owner'),
    ];
    const commands = parseApprovalCommands(comments, ['owner']);

    expect(commands.map(c => [c.action, c.reason, c.comment.id])).toEqual([
      ['approve', undefined, comments[0]!.id],
      ['cancel', 'no longer needed', comments[4]!.id],
      ['ran', undefined, comments[5]!.id],
    ]);
    expect(commands.ignored.map(c => [c.action, c.comment.author])).toEqual([['approve', 'drive-by']]);
  });

  it('drops a /cancel without a reason', () => {
    expect(parseApprovalCommands([comment('/cancel', 'owner')], ['owner'])).toHaveLength(0);
  });
});

describe('validateCommentApproval', () => {
  it('returns a comment approval with the url, author and comment time', async () => {
    const c = comment('/approve', 'owner');
    const { approval } = await validateCommentApproval(check({ comment: c }));
    expect(approval).toEqual({ source: 'comment', ref: c.url, by: 'owner', at: AFTER });
  });

  it('refuses a comment by someone who is not an owner', async () => {
    await expect(validateCommentApproval(check({ comment: comment('/approve', 'drive-by') }))).rejects.toThrow(
      ApprovalRefusedError,
    );
  });

  it('refuses a comment that is not the command', async () => {
    await expect(validateCommentApproval(check({ comment: comment('/accept') }))).rejects.toThrow(
      /is not a \/approve command/,
    );
  });

  it('refuses an edited comment', async () => {
    await expect(
      validateCommentApproval(check({ comment: comment('/approve', 'owner', AFTER, '2026-04-02T00:00:00.000Z') })),
    ).rejects.toThrow(/was edited after posting/);
  });

  it("refuses the tool's own login in enforce mode and records it unverified in observe mode", async () => {
    const own = comment('/approve', 'owner');
    await expect(
      validateCommentApproval(check({ comment: own, login: async () => 'OWNER', cfg: { owners: ['owner'], mode: 'enforce' } })),
    ).rejects.toThrow(/agent's own login/);
    const { approval } = await validateCommentApproval(check({ comment: own, login: async () => 'owner' }));
    expect(approval).toMatchObject({ source: 'unverified', ref: own.url });
  });

  it('skips the own-login check when the login is unknown', async () => {
    const { approval } = await validateCommentApproval(
      check({ login: async () => undefined, cfg: { owners: ['owner'], mode: 'enforce' } }),
    );
    expect(approval.source).toBe('comment');
  });

  it('does not read the login for a comment refused by an earlier check', async () => {
    let read = false;
    await expect(
      validateCommentApproval(check({ comment: comment('nope'), login: async () => ((read = true), 'x') })),
    ).rejects.toThrow();
    expect(read).toBe(false);
  });

  it('refuses a stage approval that is not newer than the publication', async () => {
    await expect(validateCommentApproval(check({ comment: comment('/approve', 'owner', PUBLISHED) }))).rejects.toThrow(
      TransitionError,
    );
  });

  it('refuses an acceptance not newer than the result', async () => {
    const state = paused({ resultPublishedAt: PUBLISHED });
    await expect(
      validateCommentApproval(check({ action: 'accept', state, comment: comment('/accept', 'owner', BEFORE) })),
    ).rejects.toThrow(/not newer than the result published at/);
    await expect(
      validateCommentApproval(check({ action: 'accept', state: paused(), comment: comment('/accept') })),
    ).rejects.toThrow('cannot accept: no result has been published');
  });

  it('refuses a cancel or a run confirmation not newer than the reopen', async () => {
    const state = paused({ reopenedAt: PUBLISHED });
    await expect(
      validateCommentApproval(check({ action: 'cancel', state, comment: comment('/cancel why', 'owner', BEFORE) })),
    ).rejects.toThrow(/cancellation at .* is not newer than the reopen/);
    await expect(
      validateCommentApproval(check({ action: 'ran', state, comment: comment('/ran', 'owner', BEFORE) })),
    ).rejects.toThrow(/confirmation at .* is not newer than the reopen/);
  });

  it('refuses a run confirmation not newer than the final merge', async () => {
    await expect(
      validateCommentApproval(
        check({ action: 'ran', comment: comment('/ran', 'owner', BEFORE), finalMergedAt: async () => PUBLISHED }),
      ),
    ).rejects.toThrow(`confirmation at ${BEFORE} is not newer than the final PR merged at ${PUBLISHED}`);
  });
});

describe('finalMergeTime', () => {
  it("uses the tracker's mergedAt of the final PRs and falls back to the recorded merge time", () => {
    const state = paused({
      prs: [
        { number: 5, scope: 'partial', mergeSha: 'a' },
        { number: 6, scope: 'final', mergeSha: 'b' },
      ],
      finalMergedAt: AFTER,
    });
    const pr = (number: number, mergedAt?: string) => ({
      number,
      url: '',
      merged: true,
      baseRef: 'main',
      body: '',
      ...(mergedAt && { mergedAt }),
    });
    expect(finalMergeTime(state, [pr(5, '2026-05-01T00:00:00.000Z'), pr(6, PUBLISHED)])).toBe(PUBLISHED);
    expect(finalMergeTime(state, [pr(6)])).toBe(AFTER);
  });
});
