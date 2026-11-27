import { describe, expect, it } from 'vitest';
import {
  parseStateComment,
  renderStateComment,
  STATE_MARKER,
  StateCommentError,
} from '../../src/core/stateComment.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { TaskState } from '../../src/core/types.js';

const base = (): TaskState =>
  newTask({
    issue: 42,
    type: BUILTIN_TYPES.find(t => t.id === 'feature')!,
    summary: 'Do the thing',
    now: '2026-01-01T00:00:00.000Z',
  });

const rich = (): TaskState => ({
  ...base(),
  status: 'awaiting_deployment',
  phase: 'delivery',
  waitingOn: 'external',
  currentStep: 'Waiting for the deployment',
  nextStep: 'Record the deployment',
  agent: 'worker-1',
  targets: ['api', 'web'],
  pendingTargets: ['web'],
  prs: [
    { number: 11, scope: 'partial', mergeSha: 'abc123' },
    { number: 12, scope: 'final', mergeSha: 'def456' },
  ],
  stages: {
    planning: {
      revision: 2,
      publishedAt: '2026-01-01T01:00:00.000Z',
      approval: {
        source: 'comment',
        ref: 'https://example.test/issues/42#issuecomment-1',
        by: 'owner-login',
        at: '2026-01-01T02:00:00.000Z',
      },
    },
  },
  evidence: [{ kind: 'backup', ref: 'https://example.test/backup', at: '2026-01-01T03:00:00.000Z' }],
  finalMergedAt: '2026-01-01T04:00:00.000Z',
  deliveredBy: ['https://example.test/deployments/1'],
  updatedAt: '2026-01-01T05:00:00.000Z',
});

describe('renderStateComment', () => {
  it('starts with the marker on its own first line', () => {
    expect(STATE_MARKER).toBe('<!-- sdlc:state -->');
    expect(renderStateComment(base()).split('\n')[0]).toBe('<!-- sdlc:state -->');
  });

  it('puts the state in a fenced json block followed by a human line', () => {
    const state = base();
    const body = renderStateComment(state);
    expect(body).toContain('```json\n' + JSON.stringify(state, null, 2) + '\n```');
    const afterFence = body.slice(body.lastIndexOf('```') + 3).trim();
    expect(afterFence).toBe('_Managed by agentic-sdlc-kit. Do not edit._');
  });
});

describe('parseStateComment', () => {
  it('round-trips a fresh state', () => {
    const state = base();
    expect(parseStateComment(renderStateComment(state))).toStrictEqual(state);
  });

  it('round-trips a state with every kind of field populated', () => {
    const state = rich();
    expect(parseStateComment(renderStateComment(state))).toStrictEqual(state);
  });

  it('round-trips type changes, reads state written before they existed, and refuses a malformed list', () => {
    const changed: TaskState = {
      ...base(),
      typeChanges: [
        { from: 'feature', to: 'tooling', at: '2026-01-02T00:00:00.000Z', ref: 'https://github.test/issues/42#issuecomment-7', source: 'comment' },
      ],
    };
    expect(parseStateComment(renderStateComment(changed))).toStrictEqual(changed);
    expect(parseStateComment(renderStateComment(base()))).not.toHaveProperty('typeChanges');
    const malformed = renderStateComment(base()).replace('"schema": 1', '"schema": 1, "typeChanges": {}');
    expect(() => parseStateComment(malformed)).toThrow('invalid "typeChanges"');
  });

  it('round-trips text that contains code fences, markers and markdown', () => {
    const state = { ...base(), summary: 'Use ```json\n{}\n``` and <!-- sdlc:state --> in docs' };
    expect(parseStateComment(renderStateComment(state))).toStrictEqual(state);
  });

  it('returns null when the marker is absent', () => {
    expect(parseStateComment('Just a normal comment')).toBeNull();
    expect(parseStateComment('```json\n{"schema":1,"issue":1}\n```')).toBeNull();
    expect(parseStateComment('')).toBeNull();
  });

  it('returns null when the marker is not at the start of the body', () => {
    const quoted = `Replying to this:\n${renderStateComment(base())}`;
    expect(parseStateComment(quoted)).toBeNull();
  });

  it('tolerates leading whitespace before the marker', () => {
    const state = base();
    expect(parseStateComment(`\n  \n${renderStateComment(state)}`)).toStrictEqual(state);
  });

  it('accepts CRLF line endings, as GitHub may store edited comments', () => {
    const state = rich();
    const crlf = renderStateComment(state).replace(/\n/g, '\r\n');
    expect(parseStateComment(crlf)).toStrictEqual(state);
  });

  it('parses the first json fence when there are several', () => {
    const state = base();
    const body = `${renderStateComment(state)}\n\n\`\`\`json\n{"schema":1,"issue":999}\n\`\`\`\n`;
    expect(parseStateComment(body)).toStrictEqual(state);
  });

  it('throws StateCommentError when the marker is followed by broken JSON', () => {
    const body = `${STATE_MARKER}\n\`\`\`json\n{ "schema": 1, \n\`\`\``;
    expect(() => parseStateComment(body)).toThrow(StateCommentError);
  });

  it('throws StateCommentError when the marker has no json fence', () => {
    expect(() => parseStateComment(STATE_MARKER)).toThrow(StateCommentError);
    expect(() => parseStateComment(`${STATE_MARKER}\n{"schema":1,"issue":1}`)).toThrow(StateCommentError);
  });

  it('throws StateCommentError when the JSON is not an object', () => {
    for (const json of ['null', '[]', '42', '"text"']) {
      expect(() => parseStateComment(`${STATE_MARKER}\n\`\`\`json\n${json}\n\`\`\``), json).toThrow(
        StateCommentError,
      );
    }
  });

  it('throws StateCommentError for an unsupported schema version', () => {
    const body = renderStateComment({ ...base(), schema: 2 as unknown as 1 });
    expect(() => parseStateComment(body)).toThrow(StateCommentError);
  });

  it('throws StateCommentError when the issue is not a number', () => {
    const body = renderStateComment({ ...base(), issue: '42' as unknown as number });
    expect(() => parseStateComment(body)).toThrow(StateCommentError);
  });

  it('throws StateCommentError naming each mistyped or missing field', () => {
    const cases: Array<[string, unknown]> = [
      ['status', 5],
      ['status', undefined],
      ['phase', null],
      ['phase', undefined],
      ['type', 7],
      ['type', undefined],
      ['updatedAt', 1_700_000_000],
      ['updatedAt', undefined],
      ['targets', 'api'],
      ['targets', undefined],
      ['pendingTargets', { api: true }],
      ['pendingTargets', undefined],
      ['prs', 'none'],
      ['prs', undefined],
      ['evidence', null],
      ['evidence', undefined],
      ['stages', []],
      ['stages', 'planning'],
      ['stages', null],
      ['stages', undefined],
    ];
    for (const [field, value] of cases) {
      const label = `${field}=${String(value)}`;
      const body = renderStateComment({ ...base(), [field]: value } as unknown as TaskState);
      expect(() => parseStateComment(body), label).toThrow(StateCommentError);
      expect(() => parseStateComment(body), label).toThrow(`"${field}"`);
    }
  });

  it('accepts a state whose optional fields are absent', () => {
    const state = base();
    expect(state.outcome).toBeUndefined();
    expect(parseStateComment(renderStateComment(state))).toStrictEqual(state);
  });

  it('names the error class', () => {
    expect.assertions(2);
    try {
      parseStateComment(STATE_MARKER);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('StateCommentError');
    }
  });
});
