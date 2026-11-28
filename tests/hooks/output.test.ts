import { describe, expect, it } from 'vitest';
import { renderOutput } from '../../src/hooks/output.js';
import { HOOK_HARNESSES, type HookHarness, type HookOutcome } from '../../src/hooks/types.js';

const empty: HookOutcome = { context: [], warnings: [] };
const reason = 'sdlc (enforce): #5 is in planning and its plan is not approved yet';

/** Both Claude Code and Codex CLI speak the same protocol; Gemini differs in its pre-tool and event names. */
const shared = ['claude', 'codex'] as const satisfies readonly HookHarness[];

describe('renderOutput pre-tool', () => {
  it.each(shared)('%s: nothing to say is empty stdout', harness => {
    expect(renderOutput(harness, 'pre-tool', empty)).toBe('');
  });

  it('gemini: nothing to say is an empty object', () => {
    expect(renderOutput('gemini', 'pre-tool', empty)).toBe('{}');
  });

  it.each(shared)('%s: a block is the PreToolUse deny', harness => {
    expect(renderOutput(harness, 'pre-tool', { ...empty, block: reason })).toBe(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }),
    );
  });

  it('gemini: a block is decision deny', () => {
    expect(renderOutput('gemini', 'pre-tool', { ...empty, block: reason })).toBe(
      JSON.stringify({ decision: 'deny', reason }),
    );
  });

  it.each(shared)('%s: warnings are context and a system message, one per line', harness => {
    const text = 'sdlc (observe): first\nsdlc: second';
    expect(renderOutput(harness, 'pre-tool', { ...empty, warnings: ['sdlc (observe): first', 'sdlc: second'] })).toBe(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
        systemMessage: text,
      }),
    );
  });

  it('gemini: warnings are a system message', () => {
    expect(renderOutput('gemini', 'pre-tool', { ...empty, warnings: ['sdlc (observe): first', 'sdlc: second'] })).toBe(
      JSON.stringify({ systemMessage: 'sdlc (observe): first\nsdlc: second' }),
    );
  });

  it.each(HOOK_HARNESSES)('%s: a block drops the warnings, so the reason is not shown twice', harness => {
    const text = renderOutput(harness, 'pre-tool', { block: reason, context: [], warnings: [reason, 'sdlc: other'] });
    expect(text.split(reason)).toHaveLength(2);
    expect(text).not.toContain('systemMessage');
    expect(text).not.toContain('other');
  });

  it.each(HOOK_HARNESSES)('%s: context lines are not part of a pre-tool answer', harness => {
    expect(renderOutput(harness, 'pre-tool', { context: ['ignored'], warnings: [] })).toBe(harness === 'gemini' ? '{}' : '');
  });
});

describe.each([
  ['session-start', { claude: 'SessionStart', codex: 'SessionStart', gemini: 'SessionStart' }],
  ['prompt', { claude: 'UserPromptSubmit', codex: 'UserPromptSubmit', gemini: 'BeforeAgent' }],
] as const)('renderOutput %s', (event, names) => {
  it.each(HOOK_HARNESSES)('%s: context lines become additionalContext', harness => {
    expect(renderOutput(harness, event, { context: ['line one', 'line two'], warnings: [] })).toBe(
      JSON.stringify({ hookSpecificOutput: { hookEventName: names[harness], additionalContext: 'line one\nline two' } }),
    );
  });

  it.each(shared)('%s: no context is empty stdout', harness => {
    expect(renderOutput(harness, event, empty)).toBe('');
  });

  it('gemini: no context is an empty object', () => {
    expect(renderOutput('gemini', event, empty)).toBe('{}');
  });

  it.each(HOOK_HARNESSES)('%s: a 20000-character context is cut to 9000 characters ending in an ellipsis', harness => {
    const parsed = JSON.parse(renderOutput(harness, event, { context: ['x'.repeat(20_000)], warnings: [] })) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toHaveLength(9000);
    expect(context.endsWith('…')).toBe(true);
    expect(context.slice(0, 8999)).toBe('x'.repeat(8999));
  });

  it('keeps a context of exactly 9000 characters whole', () => {
    const parsed = JSON.parse(renderOutput('claude', event, { context: ['y'.repeat(9000)], warnings: [] })) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toBe('y'.repeat(9000));
  });

  it('does not cut a surrogate pair in two', () => {
    const emoji = '\u{1F600}';
    const parsed = JSON.parse(renderOutput('claude', event, { context: [emoji.repeat(6000)], warnings: [] })) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThanOrEqual(9000);
    expect(context.endsWith(`${emoji}…`)).toBe(true);
  });
});
