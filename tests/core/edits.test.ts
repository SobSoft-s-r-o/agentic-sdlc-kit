import { describe, expect, it } from 'vitest';
import { editsAllowed } from '../../src/core/edits.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { Approval, Phase, Status, TaskState, TaskTypeDef } from '../../src/core/types.js';

const typeDef = (id: string): TaskTypeDef => {
  const def = BUILTIN_TYPES.find(t => t.id === id);
  if (!def) throw new Error(`no built-in type ${id}`);
  return def;
};

const approval: Approval = {
  source: 'comment',
  ref: 'https://example.test/issues/7#issuecomment-1',
  by: 'owner-login',
  at: '2026-01-01T02:00:00.000Z',
};

/** A task of `typeId` in `phase` with `status`, optionally with an approved planning stage. */
const task = (typeId: string, phase: Phase, status: Status, planApproved = false): TaskState => ({
  ...newTask({ issue: 7, type: typeDef(typeId), summary: 'Do the thing', now: '2026-01-01T00:00:00.000Z' }),
  phase,
  status,
  stages: planApproved ? { planning: { revision: 1, publishedAt: '2026-01-01T01:00:00.000Z', approval } } : {},
});

describe('editsAllowed', () => {
  it('refuses a feature in brainstorming with no approved plan, naming the issue and the phase', () => {
    const verdict = editsAllowed(task('feature', 'brainstorming', 'in_progress'), typeDef('feature'));
    expect(verdict).toMatchObject({ allowed: false, rule: 'plan-not-approved' });
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(verdict.text).toContain('#7');
    expect(verdict.text).toContain('brainstorming');
  });

  it('uses the exact plan-not-approved text', () => {
    expect(editsAllowed(task('feature', 'brainstorming', 'in_progress'), typeDef('feature'))).toEqual({
      allowed: false,
      rule: 'plan-not-approved',
      text: '#7 is in brainstorming and its plan is not approved yet; publish it with `sdlc stage publish 7 planning` and wait for the owner\'s /approve',
    });
  });

  it('refuses a feature in planning with no approved plan', () => {
    expect(editsAllowed(task('feature', 'planning', 'in_progress'), typeDef('feature'))).toMatchObject({
      allowed: false,
      rule: 'plan-not-approved',
    });
  });

  it('allows a feature in planning once the plan is approved', () => {
    expect(editsAllowed(task('feature', 'planning', 'in_progress', true), typeDef('feature'))).toEqual({
      allowed: true,
    });
  });

  it('allows a feature in a phase after planning, even with no recorded approval', () => {
    expect(editsAllowed(task('feature', 'implementation', 'in_progress'), typeDef('feature'))).toEqual({
      allowed: true,
    });
  });

  it('allows a bugfix in debugging with no approved plan (reproduction)', () => {
    expect(editsAllowed(task('bugfix', 'debugging', 'in_progress'), typeDef('bugfix'))).toEqual({ allowed: true });
  });

  it('allows a spike in exploration (no planning phase)', () => {
    expect(editsAllowed(task('spike', 'exploration', 'in_progress'), typeDef('spike'))).toEqual({ allowed: true });
  });

  it('allows analysis and artifact tasks in every phase of their type (no planning phase)', () => {
    for (const id of ['analysis', 'artifact']) {
      const def = typeDef(id);
      for (const phase of def.phases) {
        expect(editsAllowed(task(id, phase, 'in_progress'), def), `${id}/${phase}`).toEqual({ allowed: true });
      }
    }
  });

  it('refuses a done task and points at `sdlc task reopen`, even with an approved plan', () => {
    const verdict = editsAllowed(task('feature', 'delivery', 'done', true), typeDef('feature'));
    expect(verdict).toMatchObject({ allowed: false, rule: 'task-done' });
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(verdict.text).toContain('sdlc task reopen');
    expect(verdict.text).toContain('#7');
  });

  it('refuses a done task of a type with no planning phase', () => {
    expect(editsAllowed(task('spike', 'delivery', 'done'), typeDef('spike'))).toMatchObject({
      allowed: false,
      rule: 'task-done',
    });
  });

  it('does not treat a stale approval on another stage as plan approval', () => {
    const state: TaskState = {
      ...task('feature', 'planning', 'in_progress'),
      stages: { brainstorming: { revision: 1, publishedAt: approval.at, approval } },
    };
    expect(editsAllowed(state, typeDef('feature'))).toMatchObject({ allowed: false, rule: 'plan-not-approved' });
  });
});
