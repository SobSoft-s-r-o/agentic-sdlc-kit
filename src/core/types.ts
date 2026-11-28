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

/** A `task set-type` change that weakened how the task ends, with the approval that allowed it. */
export interface TypeChange {
  from: string;
  to: string;
  at: string;
  /** The owner's `/approve type <to>` comment URL, or `unverified` (observe mode). */
  ref: string;
  source: Approval['source'];
}

/** The harness-hook rules whose violations are recorded as gaps. */
export type GapRule =
  | 'no-task'
  | 'plan-not-approved'
  | 'task-done'
  | 'protected-path'
  | 'subagent-role'
  | 'subagent-tier'
  | 'admin-merge'
  | 'api-merge'
  | 'ai-cli'
  | 'mode-change'
  | 'hook-spoof'
  | 'kit-removal'
  | 'no-verify'
  | 'force-push'
  | 'worktree-prune'
  | 'rm-rf';

/** A rule an agent broke, or was stopped from breaking, as seen by a harness hook. */
export interface Gap {
  at: string;
  rule: GapRule;
  text: string;
  /** The harness that ran the hook (`claude`, `codex`, `gemini`). */
  harness: string;
  /** True when enforce mode refused the action, false when observe mode only warned. */
  blocked: boolean;
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
  /** Weakening type changes and their approvals; absent in state written before it existed. */
  typeChanges?: TypeChange[];
  /** Rule gaps recorded by the harness hooks, newest last, capped; absent in state written before it existed. */
  gaps?: Gap[];
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
  | { kind: 'gap_recorded'; gaps: Gap[] }
  | {
      kind: 'checkpoint';
      currentStep?: string;
      nextStep?: string;
      agent?: string;
      waitingOn?: WaitingOn;
      status?: 'in_progress' | 'blocked';
    };
