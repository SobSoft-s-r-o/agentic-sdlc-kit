import { describe, expect, it } from 'vitest';
import { applyEvent, newTask, TransitionError } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { Approval, TaskEvent, TaskState, TaskTypeDef } from '../../src/core/types.js';

/** ISO timestamp `n` seconds after a fixed origin; lets tests state ordering explicitly. */
const ts = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const typeDef = (id: string): TaskTypeDef => {
  const def = BUILTIN_TYPES.find(t => t.id === id);
  if (!def) throw new Error(`no built-in type ${id}`);
  return def;
};

const fresh = (typeId: string, issue = 7): TaskState =>
  newTask({ issue, type: typeDef(typeId), summary: 'Do the thing', now: ts(0) });

const approval = (at: string, overrides: Partial<Approval> = {}): Approval => ({
  source: 'comment',
  ref: 'https://example.test/issues/7#comment-1',
  by: 'owner-login',
  at,
  ...overrides,
});

/** Applies `[event, secondsOffset]` steps in order against `def`. */
const drive = (def: TaskTypeDef, from: TaskState, ...steps: Array<[TaskEvent, number]>): TaskState =>
  steps.reduce((state, [event, at]) => applyEvent(state, event, def, ts(at)), from);

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/** A feature task in review with a final PR and the given targets. */
const featureInReview = (targets: string[]): TaskState =>
  drive(typeDef('feature'), fresh('feature'), [
    { kind: 'review_handoff', pr: 11, scope: 'final', targets },
    10,
  ]);

describe('newTask', () => {
  it('starts in progress at intake, waiting on the agent, with empty collections', () => {
    const state = newTask({ issue: 42, type: typeDef('feature'), summary: 'Add search', now: ts(5) });
    expect(state).toEqual({
      schema: 1,
      issue: 42,
      type: 'feature',
      status: 'in_progress',
      phase: 'intake',
      waitingOn: 'agent',
      summary: 'Add search',
      currentStep: '',
      nextStep: '',
      agent: '',
      targets: [],
      pendingTargets: [],
      prs: [],
      stages: {},
      evidence: [],
      updatedAt: ts(5),
    });
    expect('outcome' in state).toBe(false);
  });
});

describe('phase_started', () => {
  const feature = typeDef('feature');

  it('moves to a later phase of the type, in progress and waiting on the agent', () => {
    const paused = drive(feature, fresh('feature'), [
      { kind: 'stage_published', phase: 'intake', needsApproval: true },
      1,
    ]);
    expect(paused.status).toBe('paused');
    const next = applyEvent(paused, { kind: 'phase_started', phase: 'planning' }, feature, ts(2));
    expect(next.phase).toBe('planning');
    expect(next.status).toBe('in_progress');
    expect(next.waitingOn).toBe('agent');
    expect(next.updatedAt).toBe(ts(2));
  });

  it('allows restarting the current phase', () => {
    const planning = drive(feature, fresh('feature'), [{ kind: 'phase_started', phase: 'planning' }, 1]);
    const again = applyEvent(planning, { kind: 'phase_started', phase: 'planning' }, feature, ts(2));
    expect(again.phase).toBe('planning');
  });

  it('rejects a phase that is not part of the task type', () => {
    expect(() => applyEvent(fresh('feature'), { kind: 'phase_started', phase: 'debugging' }, feature, ts(1))).toThrow(
      TransitionError,
    );
    expect(() => applyEvent(fresh('analysis'), { kind: 'phase_started', phase: 'review' }, typeDef('analysis'), ts(1))).toThrow(
      TransitionError,
    );
  });

  it('rejects a phase before the current phase', () => {
    const planning = drive(feature, fresh('feature'), [{ kind: 'phase_started', phase: 'planning' }, 1]);
    expect(() => applyEvent(planning, { kind: 'phase_started', phase: 'brainstorming' }, feature, ts(2))).toThrow(
      TransitionError,
    );
  });
});

describe('stage_published', () => {
  const feature = typeDef('feature');

  it('creates the stage record at revision 1 and increments it on every publish', () => {
    const first = applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: false }, feature, ts(1));
    expect(first.stages.planning).toEqual({ revision: 1, publishedAt: ts(1) });
    const second = applyEvent(first, { kind: 'stage_published', phase: 'planning', needsApproval: false }, feature, ts(2));
    expect(second.stages.planning).toEqual({ revision: 2, publishedAt: ts(2) });
  });

  it('drops the previous approval when a stage is published again', () => {
    const next = drive(
      feature,
      fresh('feature'),
      [{ kind: 'stage_published', phase: 'planning', needsApproval: true }, 1],
      [{ kind: 'stage_approved', phase: 'planning', approval: approval(ts(2)) }, 3],
      [{ kind: 'stage_published', phase: 'planning', needsApproval: true }, 4],
    );
    expect(next.stages.planning).toEqual({ revision: 2, publishedAt: ts(4) });
    expect('approval' in (next.stages.planning ?? {})).toBe(false);
    expect(next.status).toBe('paused');
  });

  it('pauses and waits on the owner when approval is needed', () => {
    const next = applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: true }, feature, ts(1));
    expect(next.status).toBe('paused');
    expect(next.waitingOn).toBe('owner');
  });

  it('leaves status and waiting-on alone when approval is not needed', () => {
    const next = applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: false }, feature, ts(1));
    expect(next.status).toBe('in_progress');
    expect(next.waitingOn).toBe('agent');
  });

  it('rejects a phase that is not part of the task type', () => {
    expect(() =>
      applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'debugging', needsApproval: false }, feature, ts(1)),
    ).toThrow(TransitionError);
    expect(() =>
      applyEvent(fresh('analysis'), { kind: 'stage_published', phase: 'review', needsApproval: false }, typeDef('analysis'), ts(1)),
    ).toThrow(TransitionError);
  });

  it('accepts a phase that belongs to the type even when other types lack it', () => {
    const next = applyEvent(fresh('bugfix'), { kind: 'stage_published', phase: 'debugging', needsApproval: false }, typeDef('bugfix'), ts(1));
    expect(next.stages.debugging?.revision).toBe(1);
  });

  it('keeps the phase unchanged', () => {
    const next = applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: true }, feature, ts(1));
    expect(next.phase).toBe('intake');
  });

  it('sets resultPublishedAt when the delivery phase is published', () => {
    const next = applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'delivery', needsApproval: false }, feature, ts(1));
    expect(next.resultPublishedAt).toBe(ts(1));
  });

  it('does not set resultPublishedAt for other phases of a type that does not end on acceptance', () => {
    const next = drive(
      feature,
      fresh('feature'),
      [{ kind: 'stage_published', phase: 'planning', needsApproval: false }, 1],
      [{ kind: 'stage_published', phase: 'review', needsApproval: false }, 2],
    );
    expect(next.resultPublishedAt).toBeUndefined();
  });

  it.each([
    ['analysis', 'analysis'],
    ['spike', 'exploration'],
    ['artifact', 'review'],
  ] as const)('sets resultPublishedAt for the phase before delivery of acceptance type %s (%s)', (typeId, phase) => {
    const next = applyEvent(fresh(typeId), { kind: 'stage_published', phase, needsApproval: true }, typeDef(typeId), ts(3));
    expect(next.resultPublishedAt).toBe(ts(3));
  });

  it('does not set resultPublishedAt for earlier phases of an acceptance type', () => {
    const next = applyEvent(fresh('artifact'), { kind: 'stage_published', phase: 'creation', needsApproval: true }, typeDef('artifact'), ts(3));
    expect(next.resultPublishedAt).toBeUndefined();
  });

  it('refreshes resultPublishedAt when the result is published again', () => {
    const next = drive(
      typeDef('analysis'),
      fresh('analysis'),
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 1],
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 5],
    );
    expect(next.resultPublishedAt).toBe(ts(5));
    expect(next.stages.delivery?.revision).toBe(2);
  });
});

describe('stage_approved', () => {
  const feature = typeDef('feature');
  const published = (): TaskState =>
    applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: true }, feature, ts(10));

  it('records the approval and returns the task to the agent', () => {
    const a = approval(ts(11));
    const next = applyEvent(published(), { kind: 'stage_approved', phase: 'planning', approval: a }, feature, ts(12));
    expect(next.stages.planning?.approval).toEqual(a);
    expect(next.stages.planning?.revision).toBe(1);
    expect(next.stages.planning?.publishedAt).toBe(ts(10));
    expect(next.status).toBe('in_progress');
    expect(next.waitingOn).toBe('agent');
  });

  it('rejects an approval older than the publication', () => {
    expect(() =>
      applyEvent(published(), { kind: 'stage_approved', phase: 'planning', approval: approval(ts(9)) }, feature, ts(12)),
    ).toThrow(TransitionError);
  });

  it('rejects an approval at exactly the publication time', () => {
    expect(() =>
      applyEvent(published(), { kind: 'stage_approved', phase: 'planning', approval: approval(ts(10)) }, feature, ts(12)),
    ).toThrow(TransitionError);
  });

  it('rejects an approval whose timestamp is not a valid date', () => {
    expect(() =>
      applyEvent(published(), { kind: 'stage_approved', phase: 'planning', approval: approval('not-a-date') }, feature, ts(12)),
    ).toThrow(TransitionError);
  });

  it('rejects an approval for a stage that was never published', () => {
    expect(() =>
      applyEvent(fresh('feature'), { kind: 'stage_approved', phase: 'planning', approval: approval(ts(11)) }, feature, ts(12)),
    ).toThrow(TransitionError);
  });

  it('rejects an approval that predates a re-publication of the stage', () => {
    const republished = applyEvent(
      published(),
      { kind: 'stage_published', phase: 'planning', needsApproval: true },
      feature,
      ts(20),
    );
    expect(() =>
      applyEvent(republished, { kind: 'stage_approved', phase: 'planning', approval: approval(ts(15)) }, feature, ts(21)),
    ).toThrow(TransitionError);
  });
});

describe('evidence_added', () => {
  it('appends evidence stamped with the event time', () => {
    const def = typeDef('production-data');
    const next = drive(
      def,
      fresh('production-data'),
      [{ kind: 'evidence_added', evidenceKind: 'backup', ref: 'backups/2026-01-01.sql' }, 1],
      [{ kind: 'evidence_added', evidenceKind: 'dry_run', ref: 'logs/dry-run.txt' }, 2],
    );
    expect(next.evidence).toEqual([
      { kind: 'backup', ref: 'backups/2026-01-01.sql', at: ts(1) },
      { kind: 'dry_run', ref: 'logs/dry-run.txt', at: ts(2) },
    ]);
  });
});

describe('review_handoff', () => {
  const feature = typeDef('feature');
  const prodData = typeDef('production-data');

  it('moves to review, in review, waiting on the owner, and records the PR and targets', () => {
    const next = applyEvent(
      fresh('feature'),
      { kind: 'review_handoff', pr: 11, scope: 'final', targets: ['web', 'api'] },
      feature,
      ts(1),
    );
    expect(next.phase).toBe('review');
    expect(next.status).toBe('in_review');
    expect(next.waitingOn).toBe('owner');
    expect(next.targets).toEqual(['web', 'api']);
    expect(next.prs).toEqual([{ number: 11, scope: 'final' }]);
  });

  it('refuses to reach review without required evidence and names what is missing', () => {
    expect(() =>
      applyEvent(fresh('production-data'), { kind: 'review_handoff', pr: 3, scope: 'final', targets: [] }, prodData, ts(1)),
    ).toThrow(TransitionError);
    expect(() =>
      applyEvent(fresh('production-data'), { kind: 'review_handoff', pr: 3, scope: 'final', targets: [] }, prodData, ts(1)),
    ).toThrow('missing evidence: backup');
  });

  it('names only the evidence kinds that are still missing', () => {
    const withBackup = applyEvent(
      fresh('production-data'),
      { kind: 'evidence_added', evidenceKind: 'backup', ref: 'b' },
      prodData,
      ts(1),
    );
    expect(() =>
      applyEvent(withBackup, { kind: 'review_handoff', pr: 3, scope: 'final', targets: [] }, prodData, ts(2)),
    ).toThrow('missing evidence: dry_run');
  });

  it('accepts the handoff once every required evidence kind exists', () => {
    const next = drive(
      prodData,
      fresh('production-data'),
      [{ kind: 'evidence_added', evidenceKind: 'backup', ref: 'b' }, 1],
      [{ kind: 'evidence_added', evidenceKind: 'dry_run', ref: 'd' }, 2],
      [{ kind: 'review_handoff', pr: 3, scope: 'final', targets: [] }, 3],
    );
    expect(next.status).toBe('in_review');
    expect(next.phase).toBe('review');
  });

  it('rejects a final handoff with no targets when the type requires targets', () => {
    expect(() =>
      applyEvent(fresh('feature'), { kind: 'review_handoff', pr: 11, scope: 'final', targets: [] }, feature, ts(1)),
    ).toThrow(TransitionError);
  });

  it('accepts a final handoff with no event targets when targets were declared by an earlier PR', () => {
    const next = drive(
      feature,
      fresh('feature'),
      [{ kind: 'review_handoff', pr: 11, scope: 'partial', targets: ['web'] }, 1],
      [{ kind: 'review_handoff', pr: 12, scope: 'final', targets: [] }, 2],
    );
    expect(next.targets).toEqual(['web']);
  });

  it('accepts a partial handoff with no targets even when the type requires targets', () => {
    const next = applyEvent(
      fresh('feature'),
      { kind: 'review_handoff', pr: 11, scope: 'partial', targets: [] },
      feature,
      ts(1),
    );
    expect(next.status).toBe('in_review');
    expect(next.targets).toEqual([]);
  });

  it('accepts a final handoff with no targets when the type does not require targets', () => {
    const next = applyEvent(
      fresh('tooling'),
      { kind: 'review_handoff', pr: 4, scope: 'final', targets: [] },
      typeDef('tooling'),
      ts(1),
    );
    expect(next.status).toBe('in_review');
  });

  it('keeps targets as the de-duplicated union across PRs, in first-seen order', () => {
    const next = drive(
      feature,
      fresh('feature'),
      [{ kind: 'review_handoff', pr: 11, scope: 'partial', targets: ['web'] }, 1],
      [{ kind: 'review_handoff', pr: 12, scope: 'final', targets: ['api', 'web'] }, 2],
    );
    expect(next.targets).toEqual(['web', 'api']);
  });

  it('upserts the PR record instead of duplicating it, keeping a recorded merge sha', () => {
    const merged = drive(
      feature,
      fresh('feature'),
      [{ kind: 'review_handoff', pr: 11, scope: 'partial', targets: ['web'] }, 1],
      [{ kind: 'pr_merged', pr: 11, scope: 'partial', mergeSha: 'abc123' }, 2],
    );
    const again = applyEvent(merged, { kind: 'review_handoff', pr: 11, scope: 'final', targets: ['web'] }, feature, ts(3));
    expect(again.prs).toEqual([{ number: 11, scope: 'final', mergeSha: 'abc123' }]);
  });
});

describe('pr_merged', () => {
  it('records the merge sha of a partial PR without moving the task', () => {
    const feature = typeDef('feature');
    const inReview = drive(feature, fresh('feature'), [
      { kind: 'review_handoff', pr: 11, scope: 'partial', targets: ['web'] },
      1,
    ]);
    const next = applyEvent(inReview, { kind: 'pr_merged', pr: 11, scope: 'partial', mergeSha: 'sha-1' }, feature, ts(2));
    expect(next.prs).toEqual([{ number: 11, scope: 'partial', mergeSha: 'sha-1' }]);
    expect(next.status).toBe('in_review');
    expect(next.phase).toBe('review');
    expect(next.waitingOn).toBe('owner');
  });

  it('on a final merge of a deploy type, awaits deployment of every declared target', () => {
    const feature = typeDef('feature');
    const next = applyEvent(
      featureInReview(['web', 'api']),
      { kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 'sha-9' },
      feature,
      ts(20),
    );
    expect(next.prs).toEqual([{ number: 11, scope: 'final', mergeSha: 'sha-9' }]);
    expect(next.phase).toBe('delivery');
    expect(next.status).toBe('awaiting_deployment');
    expect(next.waitingOn).toBe('external');
    expect(next.pendingTargets).toEqual(['web', 'api']);
    expect(next.outcome).toBeUndefined();
  });

  it('on a final merge of a merge type, is done and completed', () => {
    const tooling = typeDef('tooling');
    const inReview = drive(tooling, fresh('tooling'), [{ kind: 'review_handoff', pr: 4, scope: 'final', targets: [] }, 1]);
    const next = applyEvent(inReview, { kind: 'pr_merged', pr: 4, scope: 'final', mergeSha: 's' }, tooling, ts(2));
    expect(next.phase).toBe('delivery');
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
    expect(next.waitingOn).toBe('none');
    expect('outcomeApproval' in next).toBe(false);
  });

  it('on a final merge of a merge-or-acceptance type, is done and completed', () => {
    const artifact = typeDef('artifact');
    const inReview = drive(artifact, fresh('artifact'), [{ kind: 'review_handoff', pr: 5, scope: 'final', targets: [] }, 1]);
    const next = applyEvent(inReview, { kind: 'pr_merged', pr: 5, scope: 'final', mergeSha: 's' }, artifact, ts(2));
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
  });

  it.each(['analysis', 'production-data'] as const)(
    'on a final merge of owner-closed type %s, pauses waiting on the owner',
    typeId => {
      const def = typeDef(typeId);
      const evidence: Array<[TaskEvent, number]> = def.requiresBeforeReview.map((kind, i) => [
        { kind: 'evidence_added', evidenceKind: kind, ref: `ref-${kind}` },
        1 + i,
      ]);
      const ready = drive(def, fresh(typeId), ...evidence, [{ kind: 'review_handoff', pr: 6, scope: 'final', targets: [] }, 5]);
      const next = applyEvent(ready, { kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's' }, def, ts(6));
      expect(next.phase).toBe('delivery');
      expect(next.status).toBe('paused');
      expect(next.waitingOn).toBe('owner');
      expect(next.outcome).toBeUndefined();
    },
  );

  it('stamps finalMergedAt on a final merge only', () => {
    const feature = typeDef('feature');
    const partial = applyEvent(fresh('feature'), { kind: 'pr_merged', pr: 1, scope: 'partial', mergeSha: 'a' }, feature, ts(1));
    expect(partial.finalMergedAt).toBeUndefined();
    const final = applyEvent(
      partial,
      { kind: 'pr_merged', pr: 2, scope: 'final', mergeSha: 'b', targets: ['web'] },
      feature,
      ts(2),
    );
    expect(final.finalMergedAt).toBe(ts(2));
  });

  it('treats the merged report of an owner-acceptance type as its published result', () => {
    const analysis = typeDef('analysis');
    const inReview = drive(analysis, fresh('analysis'), [{ kind: 'review_handoff', pr: 6, scope: 'final', targets: [] }, 1]);
    expect(inReview.resultPublishedAt).toBeUndefined();
    const next = applyEvent(inReview, { kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's' }, analysis, ts(2));
    expect(next.resultPublishedAt).toBe(ts(2));
    expect(next.status).toBe('paused');
  });

  it('keeps a result that was already published when the report PR merges', () => {
    const analysis = typeDef('analysis');
    const next = drive(
      analysis,
      fresh('analysis'),
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 1],
      [{ kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's' }, 2],
    );
    expect(next.resultPublishedAt).toBe(ts(1));
  });

  it('does not publish a result on merge for other types', () => {
    const prodData = typeDef('production-data');
    const next = applyEvent(fresh('production-data'), { kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's' }, prodData, ts(2));
    expect(next.resultPublishedAt).toBeUndefined();
    const feature = typeDef('feature');
    const merged = applyEvent(
      fresh('feature'),
      { kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's', targets: ['web'] },
      feature,
      ts(2),
    );
    expect(merged.resultPublishedAt).toBeUndefined();
  });

  it('unions the targets declared on the merged PR into the task targets', () => {
    const feature = typeDef('feature');
    const next = applyEvent(
      featureInReview(['web']),
      { kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 's', targets: ['api', 'web'] },
      feature,
      ts(20),
    );
    expect(next).toMatchObject({ status: 'awaiting_deployment', targets: ['web', 'api'], pendingTargets: ['web', 'api'] });
  });

  it('refuses a final merge that would await deployment with no targets', () => {
    const feature = typeDef('feature');
    expect(() =>
      applyEvent(fresh('feature'), { kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's' }, feature, ts(2)),
    ).toThrow(new TransitionError('no targets declared on PR #6; add a Targets: line or run review handoff --targets'));
  });

  it('records a merge for a PR that was never handed off', () => {
    const tooling = typeDef('tooling');
    const next = applyEvent(fresh('tooling'), { kind: 'pr_merged', pr: 99, scope: 'final', mergeSha: 'late' }, tooling, ts(1));
    expect(next.prs).toEqual([{ number: 99, scope: 'final', mergeSha: 'late' }]);
    expect(next.status).toBe('done');
  });

  it('records a partial merge for a PR that was never handed off, without moving the task', () => {
    const next = applyEvent(
      fresh('feature'),
      { kind: 'pr_merged', pr: 98, scope: 'partial', mergeSha: 'early' },
      typeDef('feature'),
      ts(1),
    );
    expect(next.prs).toEqual([{ number: 98, scope: 'partial', mergeSha: 'early' }]);
    expect(next.status).toBe('in_progress');
    expect(next.phase).toBe('intake');
  });

  it('keeps earlier merged PRs when the final PR merges', () => {
    const feature = typeDef('feature');
    const next = drive(
      feature,
      fresh('feature'),
      [{ kind: 'review_handoff', pr: 11, scope: 'partial', targets: ['web'] }, 1],
      [{ kind: 'pr_merged', pr: 11, scope: 'partial', mergeSha: 'sha-a' }, 2],
      [{ kind: 'review_handoff', pr: 12, scope: 'final', targets: ['web'] }, 3],
      [{ kind: 'pr_merged', pr: 12, scope: 'final', mergeSha: 'sha-b' }, 4],
    );
    expect(next.prs).toEqual([
      { number: 11, scope: 'partial', mergeSha: 'sha-a' },
      { number: 12, scope: 'final', mergeSha: 'sha-b' },
    ]);
    expect(next.pendingTargets).toEqual(['web']);
  });
});

describe('targets_deployed', () => {
  const feature = typeDef('feature');
  const awaiting = (targets: string[]): TaskState =>
    applyEvent(featureInReview(targets), { kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 'sha' }, feature, ts(20));

  it('is only valid while awaiting deployment', () => {
    expect(() =>
      applyEvent(featureInReview(['web']), { kind: 'targets_deployed', targets: ['web'], deploymentUrls: [] }, feature, ts(21)),
    ).toThrow(TransitionError);
    expect(() =>
      applyEvent(fresh('feature'), { kind: 'targets_deployed', targets: ['web'], deploymentUrls: [] }, feature, ts(21)),
    ).toThrow(TransitionError);
  });

  it('removes deployed targets, appends deployment urls, and stays awaiting while targets remain', () => {
    const next = applyEvent(
      awaiting(['web', 'api']),
      { kind: 'targets_deployed', targets: ['web'], deploymentUrls: ['https://example.test/deploy/1'] },
      feature,
      ts(21),
    );
    expect(next.pendingTargets).toEqual(['api']);
    expect(next.deliveredBy).toEqual(['https://example.test/deploy/1']);
    expect(next.status).toBe('awaiting_deployment');
    expect(next.waitingOn).toBe('external');
    expect(next.outcome).toBeUndefined();
  });

  it('completes the task when the last pending target is deployed', () => {
    const next = applyEvent(
      awaiting(['web']),
      { kind: 'targets_deployed', targets: ['web'], deploymentUrls: ['https://example.test/deploy/1'] },
      feature,
      ts(21),
    );
    expect(next.pendingTargets).toEqual([]);
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
    expect(next.waitingOn).toBe('none');
  });

  it('ignores targets that are not pending and does not repeat a recorded deployment url', () => {
    const once = applyEvent(
      awaiting(['web', 'api']),
      { kind: 'targets_deployed', targets: ['web'], deploymentUrls: ['https://example.test/deploy/1'] },
      feature,
      ts(21),
    );
    const again = applyEvent(
      once,
      { kind: 'targets_deployed', targets: ['web', 'ghost'], deploymentUrls: ['https://example.test/deploy/1'] },
      feature,
      ts(22),
    );
    expect(again.pendingTargets).toEqual(['api']);
    expect(again.deliveredBy).toEqual(['https://example.test/deploy/1']);
    expect(again.status).toBe('awaiting_deployment');
  });

  it('feature with two targets stays awaiting deployment until both are deployed', () => {
    const afterWeb = applyEvent(
      awaiting(['web', 'api']),
      { kind: 'targets_deployed', targets: ['web'], deploymentUrls: ['https://example.test/deploy/web'] },
      feature,
      ts(21),
    );
    expect(afterWeb.status).toBe('awaiting_deployment');
    expect(afterWeb.pendingTargets).toEqual(['api']);

    const afterApi = applyEvent(
      afterWeb,
      { kind: 'targets_deployed', targets: ['api'], deploymentUrls: ['https://example.test/deploy/api'] },
      feature,
      ts(22),
    );
    expect(afterApi.status).toBe('done');
    expect(afterApi.outcome).toBe('completed');
    expect(afterApi.deliveredBy).toEqual(['https://example.test/deploy/web', 'https://example.test/deploy/api']);
  });
});

describe('while awaiting deployment', () => {
  const feature = typeDef('feature');
  const awaiting = (): TaskState =>
    drive(
      feature,
      fresh('feature'),
      [{ kind: 'stage_published', phase: 'planning', needsApproval: false }, 1],
      [{ kind: 'review_handoff', pr: 11, scope: 'final', targets: ['web', 'api'] }, 2],
      [{ kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 'sha-1' }, 3],
    );

  it('starts from awaiting_deployment with every target pending', () => {
    expect(awaiting().status).toBe('awaiting_deployment');
    expect(awaiting().pendingTargets).toEqual(['web', 'api']);
  });

  const blocked: Array<[string, TaskEvent]> = [
    ['phase_started', { kind: 'phase_started', phase: 'delivery' }],
    ['stage_published', { kind: 'stage_published', phase: 'delivery', needsApproval: true }],
    ['stage_approved', { kind: 'stage_approved', phase: 'planning', approval: approval(ts(50)) }],
    ['evidence_added', { kind: 'evidence_added', evidenceKind: 'backup', ref: 'b' }],
    ['review_handoff', { kind: 'review_handoff', pr: 12, scope: 'final', targets: ['web'] }],
  ];

  it.each(blocked)('rejects %s so the task cannot be pulled out of deployment', (_name, event) => {
    expect(() => applyEvent(awaiting(), event, feature, ts(60))).toThrow(TransitionError);
    expect(() => applyEvent(awaiting(), event, feature, ts(60))).toThrow(/awaiting deployment/);
  });

  it('still completes through targets_deployed after a rejected event', () => {
    const state = awaiting();
    expect(() => applyEvent(state, { kind: 'phase_started', phase: 'delivery' }, feature, ts(60))).toThrow(TransitionError);
    const done = applyEvent(state, { kind: 'targets_deployed', targets: ['web', 'api'], deploymentUrls: [] }, feature, ts(61));
    expect(done.status).toBe('done');
  });

  it('lets a checkpoint update notes but ignores its status and waiting-on', () => {
    const next = applyEvent(
      awaiting(),
      { kind: 'checkpoint', status: 'blocked', waitingOn: 'owner', currentStep: 'Watching the rollout', agent: 'claude/ops' },
      feature,
      ts(60),
    );
    expect(next.status).toBe('awaiting_deployment');
    expect(next.waitingOn).toBe('external');
    expect(next.currentStep).toBe('Watching the rollout');
    expect(next.agent).toBe('claude/ops');
  });

  it('records a partial PR merge without touching status, phase or pending targets', () => {
    const partial = applyEvent(awaiting(), { kind: 'pr_merged', pr: 12, scope: 'partial', mergeSha: 'sha-2' }, feature, ts(60));
    expect(partial.prs).toEqual([
      { number: 11, scope: 'final', mergeSha: 'sha-1' },
      { number: 12, scope: 'partial', mergeSha: 'sha-2' },
    ]);
    expect(partial.status).toBe('awaiting_deployment');
    expect(partial.pendingTargets).toEqual(['web', 'api']);
  });

  it('records another final PR merge without resetting targets that were already deployed', () => {
    const afterWeb = applyEvent(
      awaiting(),
      { kind: 'targets_deployed', targets: ['web'], deploymentUrls: ['https://example.test/deploy/web'] },
      feature,
      ts(20),
    );
    const next = applyEvent(afterWeb, { kind: 'pr_merged', pr: 12, scope: 'final', mergeSha: 'sha-2' }, feature, ts(60));
    expect(next.prs).toEqual([
      { number: 11, scope: 'final', mergeSha: 'sha-1' },
      { number: 12, scope: 'final', mergeSha: 'sha-2' },
    ]);
    expect(next.status).toBe('awaiting_deployment');
    expect(next.phase).toBe('delivery');
    expect(next.waitingOn).toBe('external');
    expect(next.pendingTargets).toEqual(['api']);
    expect(next.targets).toEqual(['web', 'api']);
  });

  it('can still be cancelled', () => {
    const next = applyEvent(awaiting(), { kind: 'cancelled', reason: 'rolled back', approval: approval(ts(50)) }, feature, ts(60));
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('cancelled');
  });

  it('rejects targets_deployed in every status other than awaiting_deployment', () => {
    const event: TaskEvent = { kind: 'targets_deployed', targets: ['web'], deploymentUrls: [] };
    const paused = applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: true }, feature, ts(1));
    const blockedState = applyEvent(fresh('feature'), { kind: 'checkpoint', status: 'blocked' }, feature, ts(1));
    for (const state of [fresh('feature'), paused, blockedState, featureInReview(['web'])]) {
      expect(() => applyEvent(state, event, feature, ts(70))).toThrow(TransitionError);
    }
  });
});

describe('accepted', () => {
  const analysis = typeDef('analysis');
  const published = (): TaskState =>
    applyEvent(fresh('analysis'), { kind: 'stage_published', phase: 'delivery', needsApproval: true }, analysis, ts(10));

  it('completes an owner-acceptance task when the owner accepts after the result was published', () => {
    const next = applyEvent(published(), { kind: 'accepted', approval: approval(ts(11)) }, analysis, ts(12));
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
    expect(next.waitingOn).toBe('none');
  });

  it('records the accepting approval as the outcome approval, without aliasing it', () => {
    const a = approval(ts(11));
    const next = applyEvent(published(), { kind: 'accepted', approval: a }, analysis, ts(12));
    expect(next.outcomeApproval).toEqual(a);
    a.by = 'someone-else';
    expect(next.outcomeApproval?.by).toBe('owner-login');
  });

  it('acceptance after delivery reaches done in one event', () => {
    const next = drive(
      analysis,
      fresh('analysis'),
      [{ kind: 'phase_started', phase: 'analysis' }, 1],
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 2],
      [{ kind: 'accepted', approval: approval(ts(3)) }, 4],
    );
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
  });

  it('analysis delivered through a merged report is accepted by a newer approval', () => {
    const merged = drive(
      analysis,
      fresh('analysis'),
      [{ kind: 'review_handoff', pr: 6, scope: 'final', targets: [] }, 1],
      [{ kind: 'pr_merged', pr: 6, scope: 'final', mergeSha: 's' }, 2],
    );
    expect(() => applyEvent(merged, { kind: 'accepted', approval: approval(ts(1)) }, analysis, ts(3))).toThrow(
      TransitionError,
    );
    const next = applyEvent(merged, { kind: 'accepted', approval: approval(ts(3)) }, analysis, ts(4));
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
  });

  it('rejects an acceptance older than a reopen even when it is newer than the published result', () => {
    const reopened = drive(
      analysis,
      fresh('analysis'),
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 1],
      [{ kind: 'cancelled', reason: 'on hold', approval: approval(ts(2)) }, 3],
      [{ kind: 'reopened' }, 4],
    );
    expect(reopened.resultPublishedAt).toBe(ts(1));
    expect(() => applyEvent(reopened, { kind: 'accepted', approval: approval(ts(2)) }, analysis, ts(5))).toThrow(/reopen/);
    expect(() => applyEvent(reopened, { kind: 'accepted', approval: approval(ts(4)) }, analysis, ts(5))).toThrow(
      TransitionError,
    );
    expect(applyEvent(reopened, { kind: 'accepted', approval: approval(ts(5)) }, analysis, ts(6)).status).toBe('done');
  });

  it('completes a merge-or-acceptance task that was never merged', () => {
    const artifact = typeDef('artifact');
    const next = drive(
      artifact,
      fresh('artifact'),
      [{ kind: 'stage_published', phase: 'review', needsApproval: true }, 1],
      [{ kind: 'accepted', approval: approval(ts(2)) }, 3],
    );
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
  });

  it('rejects acceptance for types that do not end on owner acceptance', () => {
    for (const id of ['feature', 'tooling', 'production-data']) {
      const def = typeDef(id);
      const state = applyEvent(fresh(id), { kind: 'stage_published', phase: 'delivery', needsApproval: true }, def, ts(10));
      expect(() => applyEvent(state, { kind: 'accepted', approval: approval(ts(11)) }, def, ts(12))).toThrow(
        TransitionError,
      );
    }
  });

  it('rejects acceptance before any result was published', () => {
    expect(() => applyEvent(fresh('analysis'), { kind: 'accepted', approval: approval(ts(11)) }, analysis, ts(12))).toThrow(
      TransitionError,
    );
  });

  it('rejects acceptance at or before the result publication time', () => {
    expect(() => applyEvent(published(), { kind: 'accepted', approval: approval(ts(9)) }, analysis, ts(12))).toThrow(
      TransitionError,
    );
    expect(() => applyEvent(published(), { kind: 'accepted', approval: approval(ts(10)) }, analysis, ts(12))).toThrow(
      TransitionError,
    );
  });

  it('rejects an acceptance that predates a re-published result', () => {
    const republished = applyEvent(published(), { kind: 'stage_published', phase: 'delivery', needsApproval: true }, analysis, ts(20));
    expect(() => applyEvent(republished, { kind: 'accepted', approval: approval(ts(15)) }, analysis, ts(21))).toThrow(
      TransitionError,
    );
  });
});

describe('confirmed_ran', () => {
  const prodData = typeDef('production-data');
  const reviewReady = (): TaskState =>
    drive(
      prodData,
      fresh('production-data'),
      [{ kind: 'evidence_added', evidenceKind: 'backup', ref: 'b' }, 1],
      [{ kind: 'evidence_added', evidenceKind: 'dry_run', ref: 'd' }, 2],
      [{ kind: 'review_handoff', pr: 8, scope: 'final', targets: [] }, 3],
    );

  it('completes an owner-confirmation task after the final merge', () => {
    const merged = applyEvent(reviewReady(), { kind: 'pr_merged', pr: 8, scope: 'final', mergeSha: 's' }, prodData, ts(4));
    const next = applyEvent(merged, { kind: 'confirmed_ran', approval: approval(ts(5)) }, prodData, ts(6));
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('completed');
    expect(next.waitingOn).toBe('none');
  });

  it('records the confirming approval as the outcome approval', () => {
    const a = approval(ts(5), { source: 'prompt', ref: 'prompt-17' });
    const merged = applyEvent(reviewReady(), { kind: 'pr_merged', pr: 8, scope: 'final', mergeSha: 's' }, prodData, ts(4));
    const next = applyEvent(merged, { kind: 'confirmed_ran', approval: a }, prodData, ts(6));
    expect(next.outcomeApproval).toEqual(a);
  });

  it('a reopened task cannot be closed again by the old confirmation', () => {
    const done = drive(
      prodData,
      reviewReady(),
      [{ kind: 'pr_merged', pr: 8, scope: 'final', mergeSha: 's' }, 4],
      [{ kind: 'confirmed_ran', approval: approval(ts(5)) }, 6],
    );
    expect(done.status).toBe('done');

    const reopened = applyEvent(done, { kind: 'reopened' }, prodData, ts(7));
    expect(reopened.finalMergedAt).toBeUndefined();
    // No final merge yet in the new cycle: even a fresh approval cannot confirm a run of the old merge.
    expect(() => applyEvent(reopened, { kind: 'confirmed_ran', approval: approval(ts(5)) }, prodData, ts(9))).toThrow(
      TransitionError,
    );
    expect(() => applyEvent(reopened, { kind: 'confirmed_ran', approval: approval(ts(8)) }, prodData, ts(9))).toThrow(
      /final PR has not been merged/,
    );

    const remerged = drive(
      prodData,
      reopened,
      [{ kind: 'review_handoff', pr: 9, scope: 'final', targets: [] }, 8],
      [{ kind: 'pr_merged', pr: 9, scope: 'final', mergeSha: 's2' }, 9],
    );
    expect(remerged.finalMergedAt).toBe(ts(9));
    // The merge is new, but the old approval predates the reopen.
    expect(() => applyEvent(remerged, { kind: 'confirmed_ran', approval: approval(ts(5)) }, prodData, ts(10))).toThrow(/reopen/);
    expect(() => applyEvent(remerged, { kind: 'confirmed_ran', approval: approval(ts(7)) }, prodData, ts(10))).toThrow(
      TransitionError,
    );
    const again = applyEvent(remerged, { kind: 'confirmed_ran', approval: approval(ts(10)) }, prodData, ts(11));
    expect(again.status).toBe('done');
    expect(again.outcomeApproval?.at).toBe(ts(10));
  });

  it('rejects confirmation before the final PR merged', () => {
    expect(() => applyEvent(reviewReady(), { kind: 'confirmed_ran', approval: approval(ts(5)) }, prodData, ts(6))).toThrow(
      TransitionError,
    );
    expect(() => applyEvent(fresh('production-data'), { kind: 'confirmed_ran', approval: approval(ts(5)) }, prodData, ts(6))).toThrow(
      TransitionError,
    );
  });

  it('rejects confirmation when only a partial PR merged', () => {
    const partial = applyEvent(
      reviewReady(),
      { kind: 'pr_merged', pr: 9, scope: 'partial', mergeSha: 'p' },
      prodData,
      ts(4),
    );
    expect(() => applyEvent(partial, { kind: 'confirmed_ran', approval: approval(ts(5)) }, prodData, ts(6))).toThrow(
      TransitionError,
    );
  });

  it('rejects confirmation for types that do not end on owner confirmation', () => {
    const tooling = typeDef('tooling');
    const merged = applyEvent(fresh('tooling'), { kind: 'pr_merged', pr: 1, scope: 'partial', mergeSha: 's' }, tooling, ts(1));
    expect(() => applyEvent(merged, { kind: 'confirmed_ran', approval: approval(ts(2)) }, tooling, ts(3))).toThrow(
      TransitionError,
    );
    const analysis = typeDef('analysis');
    expect(() => applyEvent(fresh('analysis'), { kind: 'confirmed_ran', approval: approval(ts(2)) }, analysis, ts(3))).toThrow(
      TransitionError,
    );
  });
});

describe('cancelled', () => {
  const feature = typeDef('feature');

  it('ends an open task as done with a cancelled outcome and the reason', () => {
    const next = applyEvent(
      fresh('feature'),
      { kind: 'cancelled', reason: 'no longer needed', approval: approval(ts(1)) },
      feature,
      ts(2),
    );
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('cancelled');
    expect(next.cancelReason).toBe('no longer needed');
    expect(next.waitingOn).toBe('none');
  });

  it('records the cancelling approval as the outcome approval', () => {
    const a = approval(ts(1), { source: 'prompt', ref: 'prompt-3' });
    const next = applyEvent(fresh('feature'), { kind: 'cancelled', reason: 'dropped', approval: a }, feature, ts(2));
    expect(next.outcomeApproval).toEqual(a);
  });

  it.each([
    ['paused', (): TaskState => applyEvent(fresh('feature'), { kind: 'stage_published', phase: 'planning', needsApproval: true }, feature, ts(1))],
    ['in_review', (): TaskState => featureInReview(['web'])],
    [
      'awaiting_deployment',
      (): TaskState =>
        applyEvent(featureInReview(['web']), { kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 's' }, feature, ts(20)),
    ],
  ] as const)('cancels from %s', (_label, make) => {
    const next = applyEvent(make(), { kind: 'cancelled', reason: 'dropped', approval: approval(ts(30)) }, feature, ts(31));
    expect(next.status).toBe('done');
    expect(next.outcome).toBe('cancelled');
  });

  it('clears pending targets when cancelled from awaiting deployment', () => {
    const awaiting = applyEvent(featureInReview(['web', 'api']), { kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 's' }, feature, ts(20));
    expect(awaiting.pendingTargets).toEqual(['web', 'api']);
    const next = applyEvent(awaiting, { kind: 'cancelled', reason: 'rolled back', approval: approval(ts(30)) }, feature, ts(31));
    expect(next.pendingTargets).toEqual([]);
    expect(next.targets).toEqual(['web', 'api']);
  });

  it('rejects a cancellation that is not newer than the last reopen', () => {
    const reopened = drive(
      feature,
      fresh('feature'),
      [{ kind: 'cancelled', reason: 'first', approval: approval(ts(1)) }, 2],
      [{ kind: 'reopened' }, 3],
    );
    expect(() =>
      applyEvent(reopened, { kind: 'cancelled', reason: 'stale', approval: approval(ts(1)) }, feature, ts(5)),
    ).toThrow(/reopen/);
    expect(() =>
      applyEvent(reopened, { kind: 'cancelled', reason: 'stale', approval: approval(ts(3)) }, feature, ts(5)),
    ).toThrow(TransitionError);
    const next = applyEvent(reopened, { kind: 'cancelled', reason: 'fresh', approval: approval(ts(4)) }, feature, ts(5));
    expect(next.status).toBe('done');
    expect(next.cancelReason).toBe('fresh');
  });

  it('cannot cancel a task that is already done', () => {
    const done = applyEvent(
      fresh('feature'),
      { kind: 'cancelled', reason: 'first', approval: approval(ts(1)) },
      feature,
      ts(2),
    );
    expect(() =>
      applyEvent(done, { kind: 'cancelled', reason: 'second', approval: approval(ts(3)) }, feature, ts(4)),
    ).toThrow(TransitionError);
  });
});

describe('reopened', () => {
  const feature = typeDef('feature');

  it('is only valid from done', () => {
    expect(() => applyEvent(fresh('feature'), { kind: 'reopened' }, feature, ts(1))).toThrow(TransitionError);
  });

  it('cancel then reopen restores an open task', () => {
    const cancelled = applyEvent(
      fresh('feature'),
      { kind: 'cancelled', reason: 'changed our minds', approval: approval(ts(1)) },
      feature,
      ts(2),
    );
    expect(cancelled.status).toBe('done');
    expect(cancelled.outcome).toBe('cancelled');

    const reopened = applyEvent(cancelled, { kind: 'reopened' }, feature, ts(3));
    expect(reopened.status).toBe('in_progress');
    expect(reopened.waitingOn).toBe('agent');
    expect(reopened.outcome).toBeUndefined();
    expect('outcome' in reopened).toBe(false);
    expect(reopened.cancelReason).toBeUndefined();
    expect('outcomeApproval' in reopened).toBe(false);
  });

  it('restarts at the first phase of the type and records when it was reopened', () => {
    const cancelled = applyEvent(
      fresh('feature'),
      { kind: 'cancelled', reason: 'paused for now', approval: approval(ts(1)) },
      feature,
      ts(2),
    );
    expect(cancelled.reopenedAt).toBeUndefined();
    const reopened = applyEvent(cancelled, { kind: 'reopened' }, feature, ts(3));
    expect(reopened.phase).toBe('intake');
    expect(reopened.reopenedAt).toBe(ts(3));
  });

  it('a reopened delivered task can go back to an earlier phase', () => {
    const done = drive(
      feature,
      featureInReview(['web']),
      [{ kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 's' }, 20],
      [{ kind: 'targets_deployed', targets: ['web'], deploymentUrls: ['https://example.test/deploy/1'] }, 21],
    );
    expect(done.status).toBe('done');
    expect(done.phase).toBe('delivery');
    const reopened = applyEvent(done, { kind: 'reopened' }, feature, ts(22));
    const next = applyEvent(reopened, { kind: 'phase_started', phase: 'implementation' }, feature, ts(23));
    expect(next.phase).toBe('implementation');
    expect(next.status).toBe('in_progress');
  });

  it('keeps the latest reopen time when a task is reopened twice', () => {
    const next = drive(
      feature,
      fresh('feature'),
      [{ kind: 'cancelled', reason: 'a', approval: approval(ts(1)) }, 2],
      [{ kind: 'reopened' }, 3],
      [{ kind: 'cancelled', reason: 'b', approval: approval(ts(4)) }, 5],
      [{ kind: 'reopened' }, 6],
    );
    expect(next.reopenedAt).toBe(ts(6));
  });

  it('does not mutate a done input state', () => {
    const done = deepFreeze(
      applyEvent(
        fresh('feature'),
        { kind: 'cancelled', reason: 'dropped', approval: approval(ts(1)) },
        feature,
        ts(2),
      ),
    );
    const snapshot = structuredClone(done);
    expect(applyEvent(done, { kind: 'reopened' }, feature, ts(3)).status).toBe('in_progress');
    expect(done).toEqual(snapshot);
  });

  it('keeps the published result when a cancelled task is reopened, since nothing accepted it', () => {
    const analysis = typeDef('analysis');
    const cancelled = drive(
      analysis,
      fresh('analysis'),
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 1],
      [{ kind: 'cancelled', reason: 'on hold', approval: approval(ts(2)) }, 3],
    );
    const reopened = applyEvent(cancelled, { kind: 'reopened' }, analysis, ts(4));
    expect(reopened.resultPublishedAt).toBe(ts(1));
    const accepted = applyEvent(reopened, { kind: 'accepted', approval: approval(ts(5)) }, analysis, ts(6));
    expect(accepted.status).toBe('done');
  });

  it('reopens a completed task and discards the stale published result', () => {
    const analysis = typeDef('analysis');
    const done = drive(
      analysis,
      fresh('analysis'),
      [{ kind: 'stage_published', phase: 'delivery', needsApproval: true }, 1],
      [{ kind: 'accepted', approval: approval(ts(2)) }, 3],
    );
    expect(done.status).toBe('done');
    const reopened = applyEvent(done, { kind: 'reopened' }, analysis, ts(4));
    expect(reopened.status).toBe('in_progress');
    expect(reopened.outcome).toBeUndefined();
    expect(reopened.resultPublishedAt).toBeUndefined();
    expect('outcomeApproval' in reopened).toBe(false);
    // The earlier acceptance must not be able to close the reopened task again.
    expect(() => applyEvent(reopened, { kind: 'accepted', approval: approval(ts(2)) }, analysis, ts(5))).toThrow(
      TransitionError,
    );
  });
});

describe('checkpoint', () => {
  const feature = typeDef('feature');

  it('updates only the provided fields', () => {
    const next = applyEvent(
      fresh('feature'),
      { kind: 'checkpoint', currentStep: 'Writing tests', agent: 'claude/developer' },
      feature,
      ts(1),
    );
    expect(next.currentStep).toBe('Writing tests');
    expect(next.agent).toBe('claude/developer');
    expect(next.nextStep).toBe('');
    expect(next.status).toBe('in_progress');
    expect(next.waitingOn).toBe('agent');
    expect(next.updatedAt).toBe(ts(1));
  });

  it('updates status and waiting-on of an open task', () => {
    const next = applyEvent(
      fresh('feature'),
      { kind: 'checkpoint', status: 'blocked', waitingOn: 'external', nextStep: 'Wait for the API key' },
      feature,
      ts(1),
    );
    expect(next.status).toBe('blocked');
    expect(next.waitingOn).toBe('external');
    expect(next.nextStep).toBe('Wait for the API key');
  });

  it('never changes status or waiting-on of a done task but still updates the notes', () => {
    const done = applyEvent(
      fresh('feature'),
      { kind: 'cancelled', reason: 'dropped', approval: approval(ts(1)) },
      feature,
      ts(2),
    );
    const next = applyEvent(
      done,
      {
        kind: 'checkpoint',
        status: 'in_progress',
        waitingOn: 'agent',
        currentStep: 'Cancelled — dropped',
        nextStep: 'None',
        agent: 'claude/developer',
      },
      feature,
      ts(3),
    );
    expect(next.status).toBe('done');
    expect(next.waitingOn).toBe('none');
    expect(next.outcome).toBe('cancelled');
    expect(next.currentStep).toBe('Cancelled — dropped');
    expect(next.nextStep).toBe('None');
    expect(next.agent).toBe('claude/developer');
    expect(next.updatedAt).toBe(ts(3));
  });

  it('accepts an empty checkpoint on a done task', () => {
    const done = applyEvent(
      fresh('feature'),
      { kind: 'cancelled', reason: 'dropped', approval: approval(ts(1)) },
      feature,
      ts(2),
    );
    const next = applyEvent(done, { kind: 'checkpoint' }, feature, ts(3));
    expect(next.status).toBe('done');
    expect(next.updatedAt).toBe(ts(3));
  });
});

describe('events on a done task', () => {
  const feature = typeDef('feature');
  const done = (): TaskState =>
    applyEvent(fresh('feature'), { kind: 'cancelled', reason: 'dropped', approval: approval(ts(1)) }, feature, ts(2));

  const rejected: Array<[string, TaskEvent]> = [
    ['phase_started', { kind: 'phase_started', phase: 'planning' }],
    ['stage_published', { kind: 'stage_published', phase: 'planning', needsApproval: true }],
    ['stage_approved', { kind: 'stage_approved', phase: 'planning', approval: approval(ts(50)) }],
    ['evidence_added', { kind: 'evidence_added', evidenceKind: 'backup', ref: 'b' }],
    ['review_handoff', { kind: 'review_handoff', pr: 1, scope: 'final', targets: ['web'] }],
    ['pr_merged', { kind: 'pr_merged', pr: 1, scope: 'final', mergeSha: 's' }],
    ['targets_deployed', { kind: 'targets_deployed', targets: ['web'], deploymentUrls: [] }],
    ['accepted', { kind: 'accepted', approval: approval(ts(50)) }],
    ['confirmed_ran', { kind: 'confirmed_ran', approval: approval(ts(50)) }],
    ['cancelled', { kind: 'cancelled', reason: 'again', approval: approval(ts(50)) }],
  ];

  it.each(rejected)('rejects %s', (_name, event) => {
    expect(() => applyEvent(done(), event, feature, ts(60))).toThrow(TransitionError);
  });
});

describe('purity', () => {
  const feature = typeDef('feature');

  it('does not mutate the input state, even through nested collections', () => {
    const base = drive(
      feature,
      fresh('feature'),
      [{ kind: 'stage_published', phase: 'planning', needsApproval: true }, 1],
      [{ kind: 'evidence_added', evidenceKind: 'backup', ref: 'b' }, 2],
      [{ kind: 'review_handoff', pr: 11, scope: 'final', targets: ['web'] }, 3],
    );
    const snapshot = structuredClone(base);
    const frozen = deepFreeze(structuredClone(base));

    const events: TaskEvent[] = [
      { kind: 'phase_started', phase: 'delivery' },
      { kind: 'stage_published', phase: 'planning', needsApproval: true },
      { kind: 'stage_approved', phase: 'planning', approval: approval(ts(5)) },
      { kind: 'evidence_added', evidenceKind: 'dry_run', ref: 'd' },
      { kind: 'review_handoff', pr: 11, scope: 'final', targets: ['api'] },
      { kind: 'pr_merged', pr: 11, scope: 'final', mergeSha: 's' },
      { kind: 'cancelled', reason: 'x', approval: approval(ts(5)) },
      { kind: 'checkpoint', currentStep: 'x', status: 'blocked' },
    ];
    for (const event of events) {
      const next = applyEvent(frozen, event, feature, ts(9));
      expect(next).not.toBe(frozen);
    }
    expect(frozen).toEqual(snapshot);
  });

  it('does not mutate the input state when an event is rejected', () => {
    const frozen = deepFreeze(fresh('feature'));
    const snapshot = structuredClone(frozen);
    expect(() => applyEvent(frozen, { kind: 'phase_started', phase: 'debugging' }, feature, ts(1))).toThrow(TransitionError);
    expect(frozen).toEqual(snapshot);
  });

  it('does not alias arrays or objects carried by the event', () => {
    const targets = ['web'];
    const approvalIn = approval(ts(2));
    const inReview = applyEvent(
      fresh('feature'),
      { kind: 'review_handoff', pr: 11, scope: 'final', targets },
      feature,
      ts(1),
    );
    targets.push('api');
    expect(inReview.targets).toEqual(['web']);

    const published = applyEvent(
      fresh('feature'),
      { kind: 'stage_published', phase: 'planning', needsApproval: true },
      feature,
      ts(1),
    );
    const approved = applyEvent(published, { kind: 'stage_approved', phase: 'planning', approval: approvalIn }, feature, ts(3));
    approvalIn.by = 'someone-else';
    expect(approved.stages.planning?.approval?.by).toBe('owner-login');
  });
});

describe('regression scenarios', () => {
  it('partial PR merge does not move the task', () => {
    const feature = typeDef('feature');
    const inReview = drive(feature, fresh('feature'), [
      { kind: 'review_handoff', pr: 21, scope: 'partial', targets: ['web'] },
      1,
    ]);
    const merged = applyEvent(inReview, { kind: 'pr_merged', pr: 21, scope: 'partial', mergeSha: 'sha' }, feature, ts(2));
    expect(merged.status).toBe('in_review');
  });

  it('production-data cannot reach review without backup and dry run', () => {
    const prodData = typeDef('production-data');
    expect(() =>
      applyEvent(fresh('production-data'), { kind: 'review_handoff', pr: 30, scope: 'final', targets: [] }, prodData, ts(1)),
    ).toThrow(/backup/);
  });

  it('approval older than publication is rejected', () => {
    const feature = typeDef('feature');
    const published = applyEvent(
      fresh('feature'),
      { kind: 'stage_published', phase: 'brainstorming', needsApproval: true },
      feature,
      ts(100),
    );
    expect(() =>
      applyEvent(published, { kind: 'stage_approved', phase: 'brainstorming', approval: approval(ts(50)) }, feature, ts(101)),
    ).toThrow(TransitionError);
  });

  it('updates updatedAt on every accepted event', () => {
    const feature = typeDef('feature');
    const next = applyEvent(fresh('feature'), { kind: 'phase_started', phase: 'planning' }, feature, ts(77));
    expect(next.updatedAt).toBe(ts(77));
  });
});
