import type { Phase, Status, TaskState, TaskTypeDef, WaitingOn } from './types.js';

/** Board field values as display strings, matching the option names the board is set up with. */
export interface BoardFields {
  status: string;
  phase: string;
  type: string;
  waitingOn: string;
  summary: string;
  currentStep: string;
  nextStep: string;
  pendingTargets: string;
  agent: string;
  lastUpdate: string;
}

const STATUS_LABELS: Record<Status, string> = {
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  paused: 'Paused',
  in_review: 'In review',
  awaiting_deployment: 'Awaiting deployment',
  done: 'Done',
};

const WAITING_ON_LABELS: Record<WaitingOn, string> = {
  owner: 'Owner',
  agent: 'Agent',
  external: 'External',
  none: '—',
};

export function displayPhase(phase: Phase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/** The cancellation reason, or a placeholder so "Cancelled — <reason>" never ends in a bare dash. */
export function cancelReasonOf(state: TaskState): string {
  return state.cancelReason?.trim() || 'no reason given';
}

/**
 * Derives the board fields and the issue's open/closed state from the task state.
 * A done task is closed `completed`, or `not_planned` when it was cancelled; every other
 * status leaves the issue open.
 */
export function projectTask(
  state: TaskState,
  type: TaskTypeDef,
): { fields: BoardFields; issueOpen: boolean; closeReason?: 'completed' | 'not_planned' } {
  const cancelled = state.status === 'done' && state.outcome === 'cancelled';

  const fields: BoardFields = {
    status: STATUS_LABELS[state.status],
    phase: displayPhase(state.phase),
    type: type.label,
    waitingOn: WAITING_ON_LABELS[state.waitingOn],
    summary: state.summary,
    currentStep: cancelled ? `Cancelled — ${cancelReasonOf(state)}` : state.currentStep,
    nextStep: cancelled ? 'None' : state.nextStep,
    pendingTargets: [...state.pendingTargets].sort().join(', '),
    agent: state.agent,
    lastUpdate: state.updatedAt,
  };

  if (state.status !== 'done') return { fields, issueOpen: true };
  return { fields, issueOpen: false, closeReason: cancelled ? 'not_planned' : 'completed' };
}
