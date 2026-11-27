import { cancelReasonOf, displayPhase } from './projection.js';
import type { Phase, TaskState } from './types.js';

/** A stage comment: heading, the stage's markdown, and an approval prompt when the owner must sign off. */
export function renderStageSummary(input: {
  phase: Phase;
  revision: number;
  markdown: string;
  needsApproval: boolean;
}): string {
  const heading = `### ${displayPhase(input.phase)} — revision ${input.revision}`;
  const body = `${heading}\n\n${input.markdown.trim()}`;
  return input.needsApproval ? `${body}\n\n---\n\nApprove with /approve` : body;
}

/** The first line of every delivery report; reconcile looks for it to avoid posting a report twice. */
export const DELIVERY_REPORT_HEADING = '### Delivered';

/** The comment posted when a task completes: what was delivered and the deployments that delivered it. */
export function renderDeliveryReport(state: TaskState): string {
  const lines = [DELIVERY_REPORT_HEADING, ''];
  lines.push(state.targets.length > 0 ? `**Targets:** ${state.targets.join(', ')}` : 'No deployment targets.');
  const urls = state.deliveredBy ?? [];
  if (urls.length > 0) {
    lines.push('', '**Deployments:**', ...urls.map(url => `- ${url}`));
  }
  return lines.join('\n');
}

/** The comment posted when a task is cancelled: why, and which owner action approved it. */
export function renderCancelReport(state: TaskState): string {
  const lines = ['### Cancelled', '', `**Reason:** ${cancelReasonOf(state)}`];
  const approval = state.outcomeApproval;
  if (approval) {
    lines.push('', `Approved by ${approval.by} (${approval.ref})`);
  }
  return lines.join('\n');
}
