import type { Approval, EndsOn, Gap, Phase, PrRecord, TaskEvent, TaskState, TaskTypeDef } from './types.js';

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

const ACCEPTANCE_ENDS: readonly EndsOn[] = ['owner_acceptance', 'merge_or_acceptance'];

/** The state is one comment, so it keeps only this many recorded gaps (the newest). */
export const MAX_GAPS = 20;

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

/** Milliseconds for ordering gaps; an unreadable `at` sorts as the oldest. */
function gapTime(gap: Gap): number {
  const time = Date.parse(gap.at);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * Merges `incoming` gaps into `existing`: one entry per rule and text (the one with the newest
 * `at`; the later one wins a tie), oldest first, only the newest `MAX_GAPS` kept.
 */
function mergeGaps(existing: readonly Gap[], incoming: readonly Gap[]): Gap[] {
  const newest = new Map<string, Gap>();
  for (const gap of [...existing, ...incoming]) {
    const key = JSON.stringify([gap.rule, gap.text]);
    const seen = newest.get(key);
    if (!seen || gapTime(gap) >= gapTime(seen)) newest.set(key, { ...gap });
  }
  const merged = [...newest.values()].sort((a, b) => gapTime(a) - gapTime(b));
  return merged.slice(-MAX_GAPS);
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

/** After a reopen, an owner action that ends the task must be newer than the reopen itself. */
function requireNewerThanReopen(state: TaskState, approval: Approval, action: string): void {
  if (state.reopenedAt && !isAfter(approval.at, state.reopenedAt)) {
    throw new TransitionError(`${action} at ${approval.at} is not newer than the reopen at ${state.reopenedAt}`);
  }
}

/** The events that record an owner decision. */
export type ApprovalEvent = Extract<TaskEvent, { kind: 'stage_approved' | 'accepted' | 'confirmed_ran' | 'cancelled' }>;

/**
 * Throws `TransitionError` unless the owner decision in `event` is newer than what it acts on: the
 * published stage (`stage_approved`, which also needs the stage to be published), the published
 * result (`accepted`, which also needs a result) and, for decisions that end the task, the last
 * reopen. The one timing check for `applyEvent` and for owner comments read from GitHub.
 */
export function assertApprovalTiming(state: TaskState, event: ApprovalEvent): void {
  const { approval } = event;
  switch (event.kind) {
    case 'stage_approved': {
      const publishedAt = state.stages[event.phase]?.publishedAt;
      if (!publishedAt) {
        throw new TransitionError(`stage "${event.phase}" has not been published, nothing to approve`);
      }
      if (!isAfter(approval.at, publishedAt)) {
        throw new TransitionError(
          `approval at ${approval.at} is not newer than stage "${event.phase}" published at ${publishedAt}`,
        );
      }
      return;
    }
    case 'accepted':
      if (!state.resultPublishedAt) {
        throw new TransitionError('cannot accept: no result has been published');
      }
      if (!isAfter(approval.at, state.resultPublishedAt)) {
        throw new TransitionError(
          `acceptance at ${approval.at} is not newer than the result published at ${state.resultPublishedAt}`,
        );
      }
      requireNewerThanReopen(state, approval, 'acceptance');
      return;
    case 'confirmed_ran':
      requireNewerThanReopen(state, approval, 'confirmation');
      return;
    case 'cancelled':
      requireNewerThanReopen(state, approval, 'cancellation');
      return;
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
  // A gap is a note about the task, not work on it: it is recorded in any status (an edit on a done task is a gap).
  if (
    state.status === 'done' &&
    event.kind !== 'reopened' &&
    event.kind !== 'checkpoint' &&
    event.kind !== 'gap_recorded'
  ) {
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
      const revision = (next.stages[event.phase]?.revision ?? 0) + 1;
      // A new revision drops the previous approval: it approved a result that no longer stands.
      next.stages[event.phase] = { revision, publishedAt: now };
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
      assertApprovalTiming(state, event);
      const stage = next.stages[event.phase];
      if (!stage) throw new TransitionError(`stage "${event.phase}" has not been published, nothing to approve`);
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
      next.targets = union(next.targets, event.targets ?? []);
      if (event.scope === 'final') next.finalMergedAt = now;
      // While awaiting deployment a merge is only recorded: it must not reset pending targets.
      if (event.scope === 'partial' || state.status === 'awaiting_deployment') break;

      next.phase = 'delivery';
      switch (type.endsOn) {
        case 'merge':
        case 'merge_or_acceptance':
          complete(next);
          break;
        case 'deploy':
          // Nothing could ever complete the task: refuse, so the merge is picked up once targets exist.
          if (next.targets.length === 0) {
            throw new TransitionError(
              `no targets declared on PR #${event.pr}; add a Targets: line or run review handoff --targets`,
            );
          }
          next.status = 'awaiting_deployment';
          next.pendingTargets = [...next.targets];
          next.waitingOn = 'external';
          break;
        case 'owner_acceptance':
          // The merged report is the result the owner accepts, unless one was published earlier.
          next.resultPublishedAt ??= now;
          next.status = 'paused';
          next.waitingOn = 'owner';
          break;
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
      assertApprovalTiming(state, event);
      complete(next, event.approval);
      break;
    }

    case 'confirmed_ran': {
      if (type.endsOn !== 'owner_confirmation') {
        throw new TransitionError(`task type "${type.id}" does not end on owner confirmation`);
      }
      if (!next.finalMergedAt) {
        throw new TransitionError('cannot confirm: the final PR has not been merged');
      }
      assertApprovalTiming(state, event);
      complete(next, event.approval);
      break;
    }

    case 'cancelled': {
      assertApprovalTiming(state, event);
      next.status = 'done';
      next.outcome = 'cancelled';
      next.cancelReason = event.reason;
      next.outcomeApproval = { ...event.approval };
      next.pendingTargets = [];
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
      delete next.finalMergedAt;
      // Approvals were for the work before the reopen; each stage must be approved again.
      for (const stage of Object.values(next.stages)) if (stage) delete stage.approval;
      // Back to the start so work can resume at any phase; owner actions must now postdate the reopen.
      next.phase = type.phases[0];
      next.reopenedAt = now;
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

    case 'gap_recorded': {
      next.gaps = mergeGaps(state.gaps ?? [], event.gaps);
      break;
    }

    default:
      return assertNever(event);
  }

  next.updatedAt = now;
  return next;
}
