import type { Approval, EndsOn, Phase, PrRecord, TaskEvent, TaskState, TaskTypeDef } from './types.js';

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

const ACCEPTANCE_ENDS: readonly EndsOn[] = ['owner_acceptance', 'merge_or_acceptance'];

export function newTask(input: { issue: number; type: TaskTypeDef; summary: string; now: string }): TaskState {
  return {
    schema: 1,
    issue: input.issue,
    type: input.type.id,
    status: 'in_progress',
    phase: 'intake',
    waitingOn: 'agent',
    summary: input.summary,
    currentStep: '',
    nextStep: '',
    agent: '',
    targets: [],
    pendingTargets: [],
    prs: [],
    stages: {},
    evidence: [],
    updatedAt: input.now,
  };
}

/** True when `later` is strictly after `earlier`; false if either is not a parseable date. */
function isAfter(later: string, earlier: string): boolean {
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
}

/** De-duplicated concatenation, keeping first-seen order. */
function union(...lists: readonly string[][]): string[] {
  return [...new Set(lists.flat())];
}

/**
 * Publishing this phase publishes the task's result: always for `delivery`, and for acceptance
 * types also the phase directly before `delivery` (e.g. an analysis report, a spike's findings).
 */
function publishesResult(type: TaskTypeDef, phase: Phase): boolean {
  if (phase === 'delivery') return true;
  if (!ACCEPTANCE_ENDS.includes(type.endsOn)) return false;
  const delivery = type.phases.indexOf('delivery');
  return delivery > 0 && type.phases[delivery - 1] === phase;
}

function upsertPr(state: TaskState, number: number, fields: Omit<PrRecord, 'number'>): void {
  const existing = state.prs.find(pr => pr.number === number);
  if (existing) {
    Object.assign(existing, fields);
  } else {
    state.prs.push({ number, ...fields });
  }
}

function complete(state: TaskState, approval?: Approval): void {
  state.status = 'done';
  state.outcome = 'completed';
  state.waitingOn = 'none';
  if (approval) state.outcomeApproval = { ...approval };
}

/** Events that would pull a task back out of `awaiting_deployment` or start new work on it. */
const BLOCKED_WHILE_AWAITING_DEPLOYMENT: ReadonlySet<TaskEvent['kind']> = new Set<TaskEvent['kind']>([
  'phase_started',
  'stage_published',
  'stage_approved',
  'evidence_added',
  'review_handoff',
]);

function assertNever(event: never): never {
  throw new TransitionError(`unknown event: ${JSON.stringify(event)}`);
}

/**
 * Applies one event and returns a new state; `state` is never mutated. Throws `TransitionError`
 * when the event is not valid for the current state or task type.
 */
export function applyEvent(state: TaskState, event: TaskEvent, type: TaskTypeDef, now: string): TaskState {
  if (state.status === 'done' && event.kind !== 'reopened' && event.kind !== 'checkpoint') {
    throw new TransitionError(`cannot apply "${event.kind}" to a done task`);
  }
  if (state.status === 'awaiting_deployment' && BLOCKED_WHILE_AWAITING_DEPLOYMENT.has(event.kind)) {
    throw new TransitionError(`cannot apply "${event.kind}" while awaiting deployment`);
  }

  const next = structuredClone(state);

  switch (event.kind) {
    case 'phase_started': {
      const target = type.phases.indexOf(event.phase);
      if (target < 0) {
        throw new TransitionError(`phase "${event.phase}" is not part of task type "${type.id}"`);
      }
      const current = type.phases.indexOf(state.phase);
      if (current >= 0 && target < current) {
        throw new TransitionError(`cannot go back from phase "${state.phase}" to "${event.phase}"`);
      }
      next.phase = event.phase;
      next.status = 'in_progress';
      next.waitingOn = 'agent';
      break;
    }

    case 'stage_published': {
      if (!type.phases.includes(event.phase)) {
        throw new TransitionError(`phase "${event.phase}" is not part of task type "${type.id}"`);
      }
      const stage = next.stages[event.phase] ?? { revision: 0 };
      next.stages[event.phase] = { ...stage, revision: stage.revision + 1, publishedAt: now };
      if (event.needsApproval) {
        next.status = 'paused';
        next.waitingOn = 'owner';
      }
      if (publishesResult(type, event.phase)) {
        next.resultPublishedAt = now;
      }
      break;
    }

    case 'stage_approved': {
      const stage = next.stages[event.phase];
      if (!stage?.publishedAt) {
        throw new TransitionError(`stage "${event.phase}" has not been published, nothing to approve`);
      }
      if (!isAfter(event.approval.at, stage.publishedAt)) {
        throw new TransitionError(
          `approval at ${event.approval.at} is not newer than stage "${event.phase}" published at ${stage.publishedAt}`,
        );
      }
      stage.approval = { ...event.approval };
      next.status = 'in_progress';
      next.waitingOn = 'agent';
      break;
    }

    case 'evidence_added': {
      next.evidence.push({ kind: event.evidenceKind, ref: event.ref, at: now });
      break;
    }

    case 'review_handoff': {
      const have = new Set(next.evidence.map(e => e.kind));
      const missing = type.requiresBeforeReview.filter(kind => !have.has(kind));
      if (missing.length > 0) {
        throw new TransitionError(`missing evidence: ${missing.join(', ')}`);
      }
      const targets = union(next.targets, event.targets);
      if (type.targetsRequired && event.scope === 'final' && targets.length === 0) {
        throw new TransitionError(`task type "${type.id}" requires at least one target for a final review handoff`);
      }
      upsertPr(next, event.pr, { scope: event.scope });
      next.targets = targets;
      next.phase = 'review';
      next.status = 'in_review';
      next.waitingOn = 'owner';
      break;
    }

    case 'pr_merged': {
      upsertPr(next, event.pr, { scope: event.scope, mergeSha: event.mergeSha });
      // While awaiting deployment a merge is only recorded: it must not reset pending targets.
      if (event.scope === 'partial' || state.status === 'awaiting_deployment') break;

      next.phase = 'delivery';
      switch (type.endsOn) {
        case 'merge':
        case 'merge_or_acceptance':
          complete(next);
          break;
        case 'deploy':
          next.status = 'awaiting_deployment';
          next.pendingTargets = [...next.targets];
          next.waitingOn = 'external';
          break;
        case 'owner_acceptance':
        case 'owner_confirmation':
          next.status = 'paused';
          next.waitingOn = 'owner';
          break;
        default:
          assertNever(type.endsOn);
      }
      break;
    }

    case 'targets_deployed': {
      if (next.status !== 'awaiting_deployment') {
        throw new TransitionError(`targets can only be deployed while awaiting deployment, not "${next.status}"`);
      }
      const deployed = new Set(event.targets);
      next.pendingTargets = next.pendingTargets.filter(target => !deployed.has(target));
      next.deliveredBy = union(next.deliveredBy ?? [], event.deploymentUrls);
      if (next.pendingTargets.length === 0) complete(next);
      break;
    }

    case 'accepted': {
      if (!ACCEPTANCE_ENDS.includes(type.endsOn)) {
        throw new TransitionError(`task type "${type.id}" does not end on owner acceptance`);
      }
      if (!next.resultPublishedAt) {
        throw new TransitionError('cannot accept: no result has been published');
      }
      if (!isAfter(event.approval.at, next.resultPublishedAt)) {
        throw new TransitionError(
          `acceptance at ${event.approval.at} is not newer than the result published at ${next.resultPublishedAt}`,
        );
      }
      complete(next, event.approval);
      break;
    }

    case 'confirmed_ran': {
      if (type.endsOn !== 'owner_confirmation') {
        throw new TransitionError(`task type "${type.id}" does not end on owner confirmation`);
      }
      if (!next.prs.some(pr => pr.scope === 'final' && pr.mergeSha !== undefined)) {
        throw new TransitionError('cannot confirm: the final PR has not been merged');
      }
      complete(next, event.approval);
      break;
    }

    case 'cancelled': {
      next.status = 'done';
      next.outcome = 'cancelled';
      next.cancelReason = event.reason;
      next.outcomeApproval = { ...event.approval };
      next.waitingOn = 'none';
      break;
    }

    case 'reopened': {
      if (state.status !== 'done') {
        throw new TransitionError(`only a done task can be reopened, not "${state.status}"`);
      }
      // An accepted result must not be able to re-close the task with the same approval.
      if (state.outcome === 'completed') delete next.resultPublishedAt;
      delete next.outcome;
      delete next.cancelReason;
      delete next.outcomeApproval;
      next.status = 'in_progress';
      next.waitingOn = 'agent';
      break;
    }

    case 'checkpoint': {
      if (event.currentStep !== undefined) next.currentStep = event.currentStep;
      if (event.nextStep !== undefined) next.nextStep = event.nextStep;
      if (event.agent !== undefined) next.agent = event.agent;
      // Terminal and externally-driven statuses are owned by their own events, not by checkpoints.
      if (next.status !== 'done' && next.status !== 'awaiting_deployment') {
        if (event.waitingOn !== undefined) next.waitingOn = event.waitingOn;
        if (event.status !== undefined) next.status = event.status;
      }
      break;
    }

    default:
      return assertNever(event);
  }

  next.updatedAt = now;
  return next;
}
