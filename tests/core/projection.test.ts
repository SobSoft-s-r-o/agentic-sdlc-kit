import { describe, expect, it } from 'vitest';
import { projectTask } from '../../src/core/projection.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { Phase, Status, TaskState, TaskTypeDef, WaitingOn } from '../../src/core/types.js';

const typeDef = (id: string): TaskTypeDef => {
  const def = BUILTIN_TYPES.find(t => t.id === id);
  if (!def) throw new Error(`no built-in type ${id}`);
  return def;
};

const task = (typeId: string, overrides: Partial<TaskState> = {}): TaskState => ({
  ...newTask({ issue: 7, type: typeDef(typeId), summary: 'Do the thing', now: '2026-01-01T00:00:00.000Z' }),
  ...overrides,
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

describe('projectTask: issue state', () => {
  it('closes a completed task as completed', () => {
    const state = task('feature', { status: 'done', outcome: 'completed', waitingOn: 'none' });
    const result = projectTask(state, typeDef('feature'));
    expect(result.issueOpen).toBe(false);
    expect(result.closeReason).toBe('completed');
  });

  it('keeps every non-done status open without a close reason', () => {
    const statuses: Status[] = ['ready', 'in_progress', 'blocked', 'paused', 'in_review', 'awaiting_deployment'];
    for (const status of statuses) {
      const result = projectTask(task('feature', { status }), typeDef('feature'));
      expect(result.issueOpen, status).toBe(true);
      expect('closeReason' in result, status).toBe(false);
    }
  });

  it('closes a cancelled task as not planned and shows the cancellation', () => {
    const state = task('feature', {
      status: 'done',
      outcome: 'cancelled',
      cancelReason: 'superseded by #9',
      waitingOn: 'none',
      currentStep: 'Writing tests',
      nextStep: 'Open the PR',
    });
    const { fields, issueOpen, closeReason } = projectTask(state, typeDef('feature'));
    expect(issueOpen).toBe(false);
    expect(closeReason).toBe('not_planned');
    expect(fields.status).toBe('Done');
    expect(fields.currentStep).toBe('Cancelled — superseded by #9');
    expect(fields.nextStep).toBe('None');
  });

  it('does not dangle a dash when a cancelled task has no recorded reason', () => {
    const state = task('feature', { status: 'done', outcome: 'cancelled', waitingOn: 'none' });
    expect(projectTask(state, typeDef('feature')).fields.currentStep).toBe('Cancelled — no reason given');
  });

  it('leaves a completed task’s step fields as they are in the state', () => {
    const state = task('feature', {
      status: 'done',
      outcome: 'completed',
      waitingOn: 'none',
      currentStep: 'Deployed',
      nextStep: 'Nothing',
    });
    const { fields } = projectTask(state, typeDef('feature'));
    expect(fields.currentStep).toBe('Deployed');
    expect(fields.nextStep).toBe('Nothing');
  });
});

describe('projectTask: display fields', () => {
  it('maps every status to its board option name', () => {
    const expected: Record<Status, string> = {
      ready: 'Ready',
      in_progress: 'In progress',
      blocked: 'Blocked',
      paused: 'Paused',
      in_review: 'In review',
      awaiting_deployment: 'Awaiting deployment',
      done: 'Done',
    };
    for (const [status, label] of Object.entries(expected) as [Status, string][]) {
      expect(projectTask(task('feature', { status }), typeDef('feature')).fields.status).toBe(label);
    }
  });

  it('capitalizes every phase', () => {
    const expected: Record<Phase, string> = {
      intake: 'Intake',
      debugging: 'Debugging',
      brainstorming: 'Brainstorming',
      analysis: 'Analysis',
      exploration: 'Exploration',
      creation: 'Creation',
      planning: 'Planning',
      implementation: 'Implementation',
      verification: 'Verification',
      review: 'Review',
      delivery: 'Delivery',
    };
    for (const [phase, label] of Object.entries(expected) as [Phase, string][]) {
      expect(projectTask(task('feature', { phase }), typeDef('feature')).fields.phase).toBe(label);
    }
  });

  it('maps waiting-on values, using an em dash for none', () => {
    const expected: Record<WaitingOn, string> = {
      owner: 'Owner',
      agent: 'Agent',
      external: 'External',
      none: '—',
    };
    for (const [waitingOn, label] of Object.entries(expected) as [WaitingOn, string][]) {
      expect(projectTask(task('feature', { waitingOn }), typeDef('feature')).fields.waitingOn).toBe(label);
    }
  });

  it('uses the task type label', () => {
    expect(projectTask(task('production-data'), typeDef('production-data')).fields.type).toBe('Production data');
    expect(projectTask(task('bugfix'), typeDef('bugfix')).fields.type).toBe('Bug fix');
  });

  it('passes summary, steps, agent and last update through verbatim', () => {
    const state = task('feature', {
      summary: 'Ship the widget',
      currentStep: 'Writing tests',
      nextStep: 'Open the PR',
      agent: 'worker-1',
      updatedAt: '2026-02-03T04:05:06.000Z',
    });
    const { fields } = projectTask(state, typeDef('feature'));
    expect(fields.summary).toBe('Ship the widget');
    expect(fields.currentStep).toBe('Writing tests');
    expect(fields.nextStep).toBe('Open the PR');
    expect(fields.agent).toBe('worker-1');
    expect(fields.lastUpdate).toBe('2026-02-03T04:05:06.000Z');
  });

  it('lists pending targets sorted and comma separated', () => {
    const state = task('feature', {
      status: 'awaiting_deployment',
      targets: ['web', 'api'],
      pendingTargets: ['web', 'api'],
    });
    expect(projectTask(state, typeDef('feature')).fields.pendingTargets).toBe('api, web');
  });

  it('shows no pending targets as an empty string', () => {
    expect(projectTask(task('feature'), typeDef('feature')).fields.pendingTargets).toBe('');
  });

  it('does not mutate the state or reorder its pending targets', () => {
    const state = deepFreeze(task('feature', { status: 'awaiting_deployment', pendingTargets: ['web', 'api'] }));
    projectTask(state, typeDef('feature'));
    expect(state.pendingTargets).toEqual(['web', 'api']);
  });
});
