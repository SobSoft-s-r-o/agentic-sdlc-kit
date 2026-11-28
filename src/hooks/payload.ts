import { isAbsolute, resolve } from 'node:path';
import type { HookEvent, HookEventName, HookHarness, ToolCall } from './types.js';

/** A hook payload the tool cannot use. The hook entrypoint turns it into "allow". */
export class HookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookPayloadError';
  }
}

type Fields = Record<string, unknown>;

/** How one tool of one harness is read: its category and the `tool_input` fields that matter. */
type ToolSpec =
  | { kind: 'path'; field: string }
  | { kind: 'patch'; field: string }
  | { kind: 'shell'; fields: readonly string[] }
  | { kind: 'subagent'; roleField: string; modelField?: string };

const CLAUDE_SUBAGENT: ToolSpec = { kind: 'subagent', roleField: 'subagent_type', modelField: 'model' };

/** Per harness, tool name to reading rule (the "Harness Hook Facts" table). Other tools are `other`. */
const TOOLS: Record<HookHarness, Record<string, ToolSpec>> = {
  claude: {
    Write: { kind: 'path', field: 'file_path' },
    Edit: { kind: 'path', field: 'file_path' },
    NotebookEdit: { kind: 'path', field: 'notebook_path' },
    Bash: { kind: 'shell', fields: ['command'] },
    PowerShell: { kind: 'shell', fields: ['command'] },
    Agent: CLAUDE_SUBAGENT,
    Task: CLAUDE_SUBAGENT,
  },
  codex: {
    apply_patch: { kind: 'patch', field: 'command' },
    // Older Codex versions send `cmd`; the current ones normalize it to `command`.
    Bash: { kind: 'shell', fields: ['command', 'cmd'] },
    spawn_agent: { kind: 'subagent', roleField: 'agent_type', modelField: 'model' },
  },
  gemini: {
    write_file: { kind: 'path', field: 'file_path' },
    replace: { kind: 'path', field: 'file_path' },
    run_shell_command: { kind: 'shell', fields: ['command'] },
    invoke_agent: { kind: 'subagent', roleField: 'agent_name' },
  },
};

/** Whether the harness's payload says the event fired inside a subagent (Gemini cannot say). */
const SUBAGENT_MARKER: Record<HookHarness, string | undefined> = {
  claude: 'agent_id',
  codex: 'agent_id',
  gemini: undefined,
};

/** The payload field that identifies the prompt (Claude `prompt_id`, Codex `turn_id`). */
const PROMPT_ID_FIELD: Record<HookHarness, string | undefined> = {
  claude: 'prompt_id',
  codex: 'turn_id',
  gemini: undefined,
};

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value when it is a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/;

/**
 * The paths a Codex `apply_patch` text names, as written and in order, without duplicates: the
 * `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` headers. Lines are
 * trimmed like the Codex parser does, so a padded header still counts. Added and removed content
 * lines start with `+` or `-`, so they never read as a header; a context line that happens to
 * spell one is over-reported, which is the safe side for an edit gate.
 */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const path = PATCH_HEADER.exec(line.trim())?.[1]?.trim();
    if (path) paths.add(path);
  }
  return [...paths];
}

function absolute(cwd: string, paths: readonly string[]): string[] {
  return [...new Set(paths.map(path => resolve(cwd, path)))];
}

function readTool(harness: HookHarness, raw: Fields, cwd: string): ToolCall {
  const name = text(raw.tool_name);
  if (name === undefined) throw new HookPayloadError('pre-tool payload has no tool_name');

  const spec = Object.hasOwn(TOOLS[harness], name) ? TOOLS[harness][name] : undefined;
  const input: Fields = isFields(raw.tool_input) ? raw.tool_input : {};
  if (spec === undefined) return { category: 'other', name };

  switch (spec.kind) {
    case 'path': {
      const path = text(input[spec.field]);
      return { category: 'edit', name, paths: path === undefined ? [] : absolute(cwd, [path]) };
    }
    case 'patch': {
      const patch = typeof input[spec.field] === 'string' ? (input[spec.field] as string) : '';
      return { category: 'edit', name, paths: absolute(cwd, patchPaths(patch)) };
    }
    case 'shell': {
      const field = spec.fields.find(candidate => typeof input[candidate] === 'string');
      return { category: 'shell', name, command: field === undefined ? '' : (input[field] as string) };
    }
    case 'subagent': {
      const role = text(input[spec.roleField]);
      const model = spec.modelField === undefined ? undefined : text(input[spec.modelField]);
      return {
        category: 'subagent',
        name,
        ...(role === undefined ? {} : { role }),
        ...(model === undefined ? {} : { model }),
      };
    }
  }
}

/**
 * One `HookEvent` from a harness's hook stdin payload. `event` is the CLI event the caller was
 * started for; only the fields of that event are read, and unknown fields are ignored. Edit paths
 * come back absolute (relative ones resolve against `cwd`). Throws `HookPayloadError` when the
 * payload is not an object, has no absolute `cwd`, or (for `pre-tool`) has no `tool_name`.
 */
export function normalizePayload(harness: HookHarness, event: HookEventName, raw: unknown): HookEvent {
  if (!isFields(raw)) throw new HookPayloadError('payload is not a JSON object');

  const cwd = text(raw.cwd);
  if (cwd === undefined) throw new HookPayloadError('payload has no cwd');
  if (!isAbsolute(cwd)) throw new HookPayloadError(`payload cwd is not an absolute path: ${cwd}`);

  const sessionId = text(raw.session_id);
  const promptIdField = PROMPT_ID_FIELD[harness];
  const promptId = promptIdField === undefined ? undefined : text(raw[promptIdField]);
  const markerField = SUBAGENT_MARKER[harness];
  const inSubagent = markerField !== undefined && text(raw[markerField]) !== undefined;

  const normalized: HookEvent = { harness, event, cwd, inSubagent };
  if (sessionId !== undefined) normalized.sessionId = sessionId;
  if (promptId !== undefined) normalized.promptId = promptId;

  if (event === 'prompt') {
    const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;
    if (prompt !== undefined) normalized.prompt = prompt;
  } else if (event === 'session-start') {
    const source = text(raw.source);
    if (source !== undefined) normalized.source = source;
  } else {
    normalized.tool = readTool(harness, raw, cwd);
  }
  return normalized;
}
