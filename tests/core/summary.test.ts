import { describe, expect, it } from 'vitest';
import { renderCancelReport, renderDeliveryReport, renderStageSummary } from '../../src/core/summary.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { TaskState } from '../../src/core/types.js';

const task = (overrides: Partial<TaskState> = {}): TaskState => ({
  ...newTask({
    issue: 7,
    type: BUILTIN_TYPES.find(t => t.id === 'feature')!,
    summary: 'Do the thing',
    now: '2026-01-01T00:00:00.000Z',
  }),
  ...overrides,
});

describe('renderStageSummary', () => {
  it('renders the heading, the markdown and the approval footer', () => {
    const body = renderStageSummary({
      phase: 'planning',
      revision: 2,
      markdown: '## Plan\n\n- step one',
      needsApproval: true,
    });
    expect(body.split('\n')[0]).toBe('### Planning — revision 2');
    expect(body).toContain('## Plan\n\n- step one');
    expect(body).toContain('Approve with /approve');
    expect(body.indexOf('- step one')).toBeLessThan(body.indexOf('Approve with /approve'));
  });

  it('omits the footer when no approval is needed', () => {
    const body = renderStageSummary({ phase: 'verification', revision: 1, markdown: 'All green.', needsApproval: false });
    expect(body).toBe('### Verification — revision 1\n\nAll green.');
    expect(body).not.toContain('/approve');
  });

  it('does not let trailing whitespace in the markdown leak into the layout', () => {
    const body = renderStageSummary({ phase: 'intake', revision: 1, markdown: 'Notes\n\n\n', needsApproval: false });
    expect(body).toBe('### Intake — revision 1\n\nNotes');
  });
});

describe('renderDeliveryReport', () => {
  it('lists the targets and each deployment URL', () => {
    const state = task({
      status: 'done',
      outcome: 'completed',
      targets: ['api', 'web'],
      deliveredBy: ['https://example.test/deployments/1', 'https://example.test/deployments/2'],
    });
    const report = renderDeliveryReport(state);
    expect(report.split('\n')[0]).toBe('### Delivered');
    expect(report).toContain('api, web');
    expect(report).toContain('https://example.test/deployments/1');
    expect(report).toContain('https://example.test/deployments/2');
  });

  it('still renders when nothing was deployed', () => {
    const report = renderDeliveryReport(task({ status: 'done', outcome: 'completed' }));
    expect(report.split('\n')[0]).toBe('### Delivered');
    expect(report).not.toContain('undefined');
  });
});

describe('renderCancelReport', () => {
  it('gives the reason and who approved the cancellation', () => {
    const state = task({
      status: 'done',
      outcome: 'cancelled',
      cancelReason: 'superseded by #9',
      outcomeApproval: {
        source: 'comment',
        ref: 'https://example.test/issues/7#issuecomment-5',
        by: 'owner-login',
        at: '2026-01-02T00:00:00.000Z',
      },
    });
    const report = renderCancelReport(state);
    expect(report.split('\n')[0]).toBe('### Cancelled');
    expect(report).toContain('superseded by #9');
    expect(report).toContain('owner-login');
    expect(report).toContain('https://example.test/issues/7#issuecomment-5');
  });

  it('omits the approver when none is recorded', () => {
    const report = renderCancelReport(task({ status: 'done', outcome: 'cancelled', cancelReason: 'not needed' }));
    expect(report).toContain('not needed');
    expect(report).not.toContain('Approved by');
    expect(report).not.toContain('undefined');
  });
});
