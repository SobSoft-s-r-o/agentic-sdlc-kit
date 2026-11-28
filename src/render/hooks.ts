import type { Config, Harness } from '../config/schema.js';
import { HOOK_EVENTS, HOOK_HARNESSES, type HookEventName, type HookHarness } from '../hooks/types.js';
import type { Change, JsonKeysChange } from './changes.js';
import { loadTemplate } from './templates.js';

/**
 * The harness hook wiring: each harness calls the launcher script, which runs
 * `sdlc hook <harness> <event>` (`src/commands/hook.ts`). The launcher is one file for all of them;
 * the harnesses' own files only say when to call it.
 *
 * The hook arrays in those files are shared with the user, who may have hooks of their own there
 * (`.codex/hooks.json` and `.gemini/settings.json` as much as `.claude/settings.json`), so each
 * event is an `items` entry: the kit owns the elements that call the launcher (`isKitHookItem`), and
 * only those.
 */

/** Where the launcher is written, relative to the repository root. */
export const HOOK_LAUNCHER = '.sdlc/hooks/run.sh';

/**
 * What marks an array element as the kit's: every item holds the launcher path in its command. The
 * manifest records it, so a later kit version can still find (and replace) the items of this one.
 */
export const HOOK_MARKER = HOOK_LAUNCHER;

/** Seconds the harness gives each event (Gemini counts milliseconds; see `handler`). */
export const HOOK_TIMEOUT_S = { 'session-start': 30, prompt: 30, 'pre-tool': 15 } as const satisfies Record<HookEventName, number>;

/**
 * The command a harness runs. The launcher is found from the git root: a harness runs hooks in the
 * directory it was started in (or wherever the session has since gone), which may be a subdirectory
 * or no checkout at all. Claude Code gives its hook commands `CLAUDE_PROJECT_DIR`, the project
 * directory, so its command takes the git root of that directory. Codex has no such variable, and
 * Gemini's `GEMINI_PROJECT_DIR` is substituted into the command text before the shell sees it,
 * so those two use the git root of the working directory (see docs/notes/harness-hooks-2026-11.md).
 * The path is quoted for a root with spaces.
 */
export function hookCommand(harness: HookHarness, event: HookEventName): string {
  const root = harness === 'claude' ? 'cd "${CLAUDE_PROJECT_DIR:-.}" && git rev-parse --show-toplevel' : 'git rev-parse --show-toplevel';
  return `"$(${root})/${HOOK_LAUNCHER}" ${harness} ${event}`;
}

/** Every command the kit renders, for any harness and event. */
const RENDERED_COMMANDS: ReadonlySet<string> = new Set(
  HOOK_HARNESSES.flatMap(harness => HOOK_EVENTS.map(event => hookCommand(harness, event))),
);

/**
 * The shape of a command an earlier version of the kit rendered: the quoted launcher path under a
 * computed root, then the harness and the event, and nothing else (no `;`, `&`, `|` or `#` that
 * would run or hide something more).
 */
const RENDERED_SHAPE = new RegExp(
  `^"[^"#;&|\\n]*(?:"[^"#;&|\\n]*"[^"#;&|\\n]*)*/${HOOK_LAUNCHER.replace(/\./g, '\\.')}" (?:${HOOK_HARNESSES.join('|')}) (?:${HOOK_EVENTS.join('|')})$`,
);

/** Whether a hook command is one the kit rendered: exactly this version's, or one of the earlier shape. */
const isKitCommand = (command: string): boolean => RENDERED_COMMANDS.has(command) || RENDERED_SHAPE.test(command);

/**
 * Whether an element of a harness's hook array (a matcher group) is the kit's: one of its handlers
 * runs a command the kit rendered. A user hook that merely mentions the launcher path is not.
 */
export function isKitHookItem(element: unknown): boolean {
  if (typeof element !== 'object' || element === null || Array.isArray(element)) return false;
  const { hooks } = element as { hooks?: unknown };
  return (
    Array.isArray(hooks) &&
    hooks.some(handler => {
      const command = typeof handler === 'object' && handler !== null ? (handler as { command?: unknown }).command : undefined;
      return typeof command === 'string' && isKitCommand(command);
    })
  );
}

/** The file each harness reads its hooks from, relative to the repository root. */
export const SETTINGS_FILE: Record<HookHarness, string> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  gemini: '.gemini/settings.json',
};

/** What each harness calls the three events (the keys under `hooks` in its settings file). */
export const NATIVE_EVENT: Record<HookHarness, Record<HookEventName, string>> = {
  claude: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' },
  codex: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' },
  gemini: { 'session-start': 'SessionStart', prompt: 'BeforeAgent', 'pre-tool': 'BeforeTool' },
};

/**
 * The tools `pre-tool` looks at: file edits, the shell and subagent dispatch, under each harness's
 * names. Claude's matcher is a plain list (letters and `|` only), which the harness compares to the
 * whole tool name; Codex and Gemini take regular expressions, so those are anchored. Codex edits
 * files only through `apply_patch` (its `Edit` and `Write` are matcher aliases of that tool, and the
 * payload still says `apply_patch`), so the aliases are not listed.
 */
const PRE_TOOL_MATCHER: Record<HookHarness, string> = {
  claude: 'Write|Edit|NotebookEdit|Bash|PowerShell|Agent|Task',
  codex: '^(apply_patch|Bash|spawn_agent|Agent)$',
  gemini: '^(write_file|replace|run_shell_command|invoke_agent)$',
};

const EVENTS: readonly HookEventName[] = ['session-start', 'prompt', 'pre-tool'];

/**
 * One command handler. Codex rejects fields it does not know, so it gets only `type`, `command` and
 * `timeout`; Gemini also names its handlers and takes the timeout in milliseconds.
 */
function handler(harness: HookHarness, event: HookEventName): Record<string, unknown> {
  const command = hookCommand(harness, event);
  const seconds = HOOK_TIMEOUT_S[event];
  return harness === 'gemini'
    ? { name: `sdlc-${event}`, type: 'command', command, timeout: seconds * 1000 }
    : { type: 'command', command, timeout: seconds };
}

function matcherGroup(harness: HookHarness, event: HookEventName): Record<string, unknown> {
  return {
    // Session start and the prompt have nothing to match: they are not tool events.
    ...(event === 'pre-tool' ? { matcher: PRE_TOOL_MATCHER[harness] } : {}),
    hooks: [handler(harness, event)],
  };
}

/**
 * The hooks of one harness: its settings file, with an `items` entry at `hooks/<Event>` for each of
 * session start, the user prompt and the tool call before it runs. None for `agents-md`, which has
 * no hooks.
 */
export function renderHooks(_cfg: Config, harness: Harness): Change[] {
  if (harness === 'agents-md') return [];
  const change: JsonKeysChange = {
    kind: 'json-keys',
    path: SETTINGS_FILE[harness],
    entries: EVENTS.map(event => ({
      pointer: ['hooks', NATIVE_EVENT[harness][event]],
      value: [matcherGroup(harness, event)],
      items: { marker: HOOK_MARKER },
    })),
  };
  return [change];
}

/**
 * The launcher, once for every harness: an executable whole file. None when no configured harness
 * has hooks (`agents-md` alone), because nothing would call it.
 */
export function renderHookLauncher(cfg: Config): Change[] {
  if (cfg.harnesses.every(harness => harness === 'agents-md')) return [];
  return [{ kind: 'file', path: HOOK_LAUNCHER, content: loadTemplate('hooks/run.sh'), mode: 0o755 }];
}

/**
 * What the owner does once, by hand, before the harness runs the hooks: both Codex and Gemini ignore
 * project hooks until the project is trusted. Claude Code asks for its own trust when it starts.
 */
export function hookNotes(cfg: Config): string[] {
  return [
    ...(cfg.harnesses.includes('codex')
      ? [
          'Codex runs project hooks only in a trusted project after you review them: open codex in this repository, trust it, then run /hooks and approve the sdlc hooks.',
        ]
      : []),
    ...(cfg.harnesses.includes('gemini')
      ? ['Gemini CLI loads project hooks only in a trusted folder: run gemini in this repository and trust the folder.']
      : []),
  ];
}
