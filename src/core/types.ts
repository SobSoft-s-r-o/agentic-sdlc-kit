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
