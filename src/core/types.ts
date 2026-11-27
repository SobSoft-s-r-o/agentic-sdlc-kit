export type Phase =
  | 'intake'
  | 'debugging'
  | 'brainstorming'
  | 'analysis'
  | 'exploration'
  | 'creation'
  | 'planning'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'delivery';

export type Status =
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'paused'
  | 'in_review'
  | 'awaiting_deployment'
  | 'done';

export type WaitingOn = 'owner' | 'agent' | 'external' | 'none';

export type EndsOn =
  | 'deploy'
  | 'merge'
  | 'owner_acceptance'
  | 'owner_confirmation'
  | 'merge_or_acceptance';

export type EvidenceKind = 'backup' | 'dry_run';

export interface TaskTypeDef {
  id: string;
  label: string;
  phases: Phase[];
  endsOn: EndsOn;
  requiresBeforeReview: EvidenceKind[];
  targetsRequired: boolean;
}

export interface Approval {
  source: 'prompt' | 'comment' | 'unverified';
  ref: string;
  by: string;
  at: string;
}

export interface PrRecord {
  number: number;
  scope: 'partial' | 'final';
  mergeSha?: string;
}

export interface StageRecord {
  revision: number;
  publishedAt?: string;
  approval?: Approval;
}

export interface TaskState {
  schema: 1;
  issue: number;
  type: string;
  status: Status;
  phase: Phase;
  waitingOn: WaitingOn;
  summary: string;
  currentStep: string;
  nextStep: string;
  agent: string;
  targets: string[];
  pendingTargets: string[];
  prs: PrRecord[];
  stages: Partial<Record<Phase, StageRecord>>;
  evidence: { kind: EvidenceKind; ref: string; at: string }[];
  outcome?: 'completed' | 'cancelled';
  cancelReason?: string;
  /** The owner action that ended the task: set by `accepted`, `confirmed_ran`, `cancelled`. */
  outcomeApproval?: Approval;
  resultPublishedAt?: string;
  /** When the latest final PR merged; set by `pr_merged` (final), cleared by `reopened`. */
  finalMergedAt?: string;
  /** When the task was last reopened; owner actions that end the task must be newer. */
  reopenedAt?: string;
  deliveredBy?: string[];
  updatedAt: string;
}

export type TaskEvent =
  | { kind: 'phase_started'; phase: Phase }
  | { kind: 'stage_published'; phase: Phase; needsApproval: boolean }
  | { kind: 'stage_approved'; phase: Phase; approval: Approval }
  | { kind: 'evidence_added'; evidenceKind: EvidenceKind; ref: string }
  | { kind: 'review_handoff'; pr: number; scope: 'partial' | 'final'; targets: string[] }
  | {
      kind: 'pr_merged';
      pr: number;
      scope: 'partial' | 'final';
      mergeSha: string;
      /** Targets declared on the PR (its `Targets:` line); added to the task's targets. */
      targets?: string[];
    }
  | { kind: 'targets_deployed'; targets: string[]; deploymentUrls: string[] }
  | { kind: 'accepted'; approval: Approval }
  | { kind: 'confirmed_ran'; approval: Approval }
  | { kind: 'cancelled'; reason: string; approval: Approval }
  | { kind: 'reopened' }
  | {
      kind: 'checkpoint';
      currentStep?: string;
      nextStep?: string;
      agent?: string;
      waitingOn?: WaitingOn;
      status?: 'in_progress' | 'blocked';
    };
