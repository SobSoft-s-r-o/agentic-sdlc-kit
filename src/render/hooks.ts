import type { Config, Harness } from '../config/schema.js';
import type { HookEventName, HookHarness } from '../hooks/types.js';
import type { Change, JsonKeysChange } from './changes.js';
import { loadTemplate } from './templates.js';

/**
 * The harness hook wiring: each harness calls the launcher script, which runs
 * `sdlc hook <harness> <event>` (`src/commands/hook.ts`). The launcher is one file for all of them;
 * the harnesses' own files only say when to call it.
 *
 * The hook arrays in those files are shared with the user, who may have hooks of their own there
 * (`.codex/hooks.json` and `.gemini/settings.json` as much as `.claude/settings.json`), so each
 * event is an `items` entry: the kit owns the elements that contain `HOOK_MARKER`, and only those.
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
 * directory it was started in, which may be a subdirectory, and only Claude has a project-directory
 * placeholder. The path is quoted for a root with spaces.
 */
export function hookCommand(harness: HookHarness, event: HookEventName): string {
  return `"$(git rev-parse --show-toplevel)/${HOOK_LAUNCHER}" ${harness} ${event}`;
}

const SETTINGS_FILE: Record<HookHarness, string> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  gemini: '.gemini/settings.json',
};

/** What each harness calls the three events. */
const NATIVE_EVENT: Record<HookHarness, Record<HookEventName, string>> = {
  claude: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' },
  codex: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' },
  gemini: { 'session-start': 'SessionStart', prompt: 'BeforeAgent', 'pre-tool': 'BeforeTool' },
};

/**
 * The tools `pre-tool` looks at: file edits, the shell and subagent dispatch, under each harness's
 * names. Claude's matcher is a plain list (letters and `|` only), which the harness compares to the
 * whole tool name; Codex and Gemini take regular expressions, so those are anchored.
 */
const PRE_TOOL_MATCHER: Record<HookHarness, string> = {
  claude: 'Write|Edit|NotebookEdit|Bash|PowerShell|Agent|Task',
  codex: '^(apply_patch|Edit|Write|Bash|spawn_agent|Agent)$',
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
