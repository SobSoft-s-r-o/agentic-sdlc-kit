import type { TaskState, TaskTypeDef } from './types.js';

export type EditVerdict =
  | { allowed: true }
  | { allowed: false; rule: 'plan-not-approved' | 'task-done'; text: string };

/**
 * Whether the agent may edit files for this task right now. Never once the task is done. Before
 * the plan is approved only in phases that do not need one: a `debugging` phase (bug
 * reproduction) and every phase of a type with no `planning` phase (`analysis`, `spike`,
 * `artifact`). In `planning` itself edits wait for the approval; in a later phase of the type they
 * are allowed. A phase the type does not list (`review` after a handoff) counts as not yet past
 * `planning`, so it needs the approval too.
 */
export function editsAllowed(state: TaskState, type: TaskTypeDef): EditVerdict {
  if (state.status === 'done') {
    return {
      allowed: false,
      rule: 'task-done',
      text: `#${state.issue} is done; reopen it with \`sdlc task reopen ${state.issue}\` before changing files for it`,
    };
  }

  const planning = type.phases.indexOf('planning');
  if (planning < 0 || state.phase === 'debugging') return { allowed: true };
  if (type.phases.indexOf(state.phase) > planning) return { allowed: true };
  if (state.stages.planning?.approval) return { allowed: true };

  return {
    allowed: false,
    rule: 'plan-not-approved',
    text: `#${state.issue} is in ${state.phase} and its plan is not approved yet; publish it with \`sdlc stage publish ${state.issue} planning\` and wait for the owner's /approve`,
  };
}
