import type { HookEventName, HookHarness, HookOutcome } from './types.js';

/** Claude Code and Codex CLI wrap their answers in `hookSpecificOutput`; Gemini names its events differently. */
const EVENT_NAMES: Record<HookHarness, Record<HookEventName, string>> = {
  claude: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' },
  codex: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' },
  gemini: { 'session-start': 'SessionStart', prompt: 'BeforeAgent', 'pre-tool': 'BeforeTool' },
};

/** Claude caps `additionalContext` at 10 000 characters; what is longer is cut here, with room to spare. */
const MAX_CONTEXT_CHARS = 9000;

/** The text cut to `MAX_CONTEXT_CHARS` characters, the last of them `…`; a surrogate pair is never split. */
function capped(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  let end = MAX_CONTEXT_CHARS - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** The answer of "nothing to say", also what a skipped hook prints: Gemini wants a JSON object, the others silence. */
export const emptyOutput = (harness: HookHarness): string => (harness === 'gemini' ? '{}' : '');

/**
 * The text a hook prints on stdout for `outcome`, in the protocol of `harness`. A block and warnings
 * are `pre-tool` answers; `context` is for `session-start` and `prompt`. A block is the whole
 * answer: `decide` also lists a `hook-spoof` block among the warnings in observe mode, and those
 * warnings are dropped here so the reason is shown once.
 */
export function renderOutput(harness: HookHarness, event: HookEventName, outcome: HookOutcome): string {
  const hookEventName = EVENT_NAMES[harness][event];

  if (event === 'pre-tool') {
    if (outcome.block !== undefined) {
      const reason = capped(outcome.block);
      return JSON.stringify(
        harness === 'gemini'
          ? { decision: 'deny', reason }
          : { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: reason } },
      );
    }
    if (outcome.warnings.length === 0) return emptyOutput(harness);
    const warnings = capped(outcome.warnings.join('\n'));
    return JSON.stringify(
      harness === 'gemini'
        ? { systemMessage: warnings }
        : { hookSpecificOutput: { hookEventName, additionalContext: warnings }, systemMessage: warnings },
    );
  }

  if (outcome.context.length === 0) return emptyOutput(harness);
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: capped(outcome.context.join('\n')) } });
}
