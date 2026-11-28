/** The harnesses whose hook payloads `sdlc hook` understands. */
export const HOOK_HARNESSES = ['claude', 'codex', 'gemini'] as const;
export type HookHarness = (typeof HOOK_HARNESSES)[number];

/**
 * The hook events `sdlc hook` serves, under one name for every harness. Claude and Codex call them
 * `SessionStart` / `UserPromptSubmit` / `PreToolUse`; Gemini calls them `SessionStart` /
 * `BeforeAgent` / `BeforeTool`.
 */
export const HOOK_EVENTS = ['session-start', 'prompt', 'pre-tool'] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * The tool call of a `pre-tool` event, whatever the harness calls its tools. `name` is the
 * harness's own tool name. Edit `paths` are absolute.
 */
export type ToolCall =
  | { category: 'edit'; name: string; paths: string[] }
  | { category: 'shell'; name: string; command: string }
  | { category: 'subagent'; name: string; role?: string; model?: string }
  | { category: 'other'; name: string };

/** One hook invocation, normalized from a harness's stdin payload. */
export interface HookEvent {
  harness: HookHarness;
  event: HookEventName;
  /** Absolute working directory the harness reports. */
  cwd: string;
  sessionId?: string;
  /** Claude `prompt_id`, Codex `turn_id`; Gemini has none. */
  promptId?: string;
  /** `prompt` events only. */
  prompt?: string;
  /** `session-start` events only: `startup`, `resume`, `clear`, ... */
  source?: string;
  /** The event fired inside a subagent. Gemini payloads cannot tell, so it is always false there. */
  inSubagent: boolean;
  /** `pre-tool` events only. */
  tool?: ToolCall;
}

/** What the rules decided for one event; each harness's output format is rendered from it. */
export interface HookOutcome {
  /** When set, the event is denied with this reason. */
  block?: string;
  /** Text for the agent's context. */
  context: string[];
  /** Warnings shown to the agent. */
  warnings: string[];
}
