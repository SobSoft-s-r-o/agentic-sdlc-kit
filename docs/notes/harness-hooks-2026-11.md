# Harness hooks research, 2026-11 (Claude Code, Codex CLI, Gemini CLI)

Research date: 2026-11-28. Author: research subagent. No harness was executed; everything below comes
from current docs and source read on that date.

Legend:
- VERIFIED = read in the cited doc or source on 2026-11-28 (version/tag given).
- UNCERTAIN = inferred, not stated in a doc, or docs and source disagree. Test before relying on it.
- "constructed example" = JSON assembled by me from the documented field list; the field names are VERIFIED, the literal values are illustrative.

## 0. Versions and primary sources

| Harness | Version verified | Primary sources (all fetched 2026-11-28) |
|---|---|---|
| Claude Code | changelog latest 2.1.332 | https://code.claude.com/docs/en/hooks.md ; https://code.claude.com/docs/en/mcp.md ; https://code.claude.com/docs/en/plugins/cli-reference.md ; changelog page on code.claude.com |
| Codex CLI | release rust-v0.172.0 (published 2026-11-24, latest non-alpha; alphas up to 0.174.0-alpha.9 on 2026-11-27) | https://learn.chatgpt.com/docs/hooks.md (developers.openai.com/codex/hooks 308-redirects here) ; https://learn.chatgpt.com/docs/config-file/config-reference.md ; https://learn.chatgpt.com/docs/extend/mcp.md ; source https://github.com/openai/codex (tag rust-v0.172.0 and main) |
| Gemini CLI | v0.71.1 (GitHub latest and npm `@google/gemini-cli` latest, published 2026-11-24) | https://github.com/google-gemini/gemini-cli/blob/v0.71.1/docs/hooks/reference.md , `docs/hooks/index.md`, `docs/hooks/writing-hooks.md`, `docs/hooks/best-practices.md`, `docs/cli/trusted-folders.md`, `docs/reference/tools.md`, `docs/reference/configuration.md`, `docs/core/subagents.md`, `docs/tools/mcp-server.md`, `docs/extensions/reference.md`; source under `packages/core/src/hooks/`, `packages/core/src/agents/`, `packages/cli/src/commands/` at tag v0.71.1 |
| Superpowers | v7.0.2 (release published 2026-11-03T22:17:54Z) | https://github.com/obra/superpowers README |
| graphify | PyPI `graphifyy` 0.9.122 (uploaded 2026-11-28T03:55Z); GitHub release v0.9.122 | https://pypi.org/pypi/graphifyy/json ; https://github.com/Graphify-Labs/graphify (tag v0.9.122: README.md, pyproject.toml, graphify/__main__.py) |

Note on doc drift (matters for an installer): Gemini's `docs/changelogs/latest.md` still says "latest stable v0.69.0" while the real latest is v0.71.1, and `docs/cli/trusted-folders.md` says Folder Trust is "disabled by default" while `docs/reference/configuration.md` and source both say `security.folderTrust.enabled` defaults to `true`. Treat Gemini prose docs as lagging; prefer source.

---

## 1. Claude Code (v2.1.332)

Source for this whole section: https://code.claude.com/docs/en/hooks.md (fetched 2026-11-28, 301K chars, read in full by line range). All VERIFIED unless marked.

### 1.1 Config files and schema

Locations (all merge, entries from every level run):
- `~/.claude/settings.json` (user)
- `.claude/settings.json` (project, committable)
- `.claude/settings.local.json` (project, gitignored)
- managed policy settings
- plugin `hooks/hooks.json`
- skill and subagent frontmatter (`hooks:` key)

Three-level nesting: event -> matcher group -> handler list.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "args": [],
            "timeout": 30,
            "statusMessage": "Checking command"
          }
        ]
      }
    ]
  }
}
```

Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent` (agent type is documented as experimental).
Handler fields: `type`, `if` (permission-rule syntax, only honoured on tool events, best effort), `timeout` (seconds), `statusMessage`, `once` (skill frontmatter only). Command handlers also take `command`, `args`, `async`, `asyncRewake`, `shell` (`bash`|`powershell`), `onFailure` (`continue`|`block`, v2.1.295+).

Timeouts (seconds): default 600 for command/http/mcp_tool; 30 prompt; 60 agent; UserPromptSubmit, PreModelSwitch, PostModelSwitch lowered to 30; MessageDisplay 10. SessionEnd shares a 1.5 s budget (raised up to 60 s if a per-hook `timeout` is set; env `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`).

Command form:
- Exec form: `args` present, no shell. `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/format.js","--fix"]}`. The doc prefers this for paths with placeholders.
- Shell form: `command` is one string run by a shell; quote placeholders.
- Windows: `npx`/`.cmd` shims need shell form (doc statement).
- Path placeholders: `${CLAUDE_PROJECT_DIR}` (project root where the session started; stable in worktrees), `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`. Payload `cwd` follows `cd` in the session.
- Project-relative script: `"command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh"` or `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.sdlc/hook.js"]`.
- `npx` form: `"command": "npx", "args": ["-y", "agentic-sdlc-kit", "hook", "pre-tool"]` (exec form) or `"command": "npx -y agentic-sdlc-kit hook pre-tool"` (shell form). Each form follows the documented rules; I did not find a doc sentence that blesses exactly this `npx` combination, so the combination is UNCERTAIN. Latency of `npx` on every tool call is a design concern (use a locally installed binary `sdlc` where possible).

Matchers: `*`, `""`, or omitted = all. A string made only of letters/digits/`_`/`-`/space/`,`/`|` is an exact name or list; anything else is an unanchored JS regex. Matcher target by event: tool events match tool name; SessionStart matches `startup|resume|clear|compact|fork`; SessionEnd `clear|resume|logout|prompt_input_exit|other`; SubagentStart/SubagentStop match agent type; UserPromptSubmit, Stop and others ignore the matcher silently.

MCP tools: `mcp__<server>__<tool>` (plugin servers `mcp__plugin_<plugin>_<server>__<tool>`), matchable e.g. `mcp__memory__.*`.

### 1.2 Events (exact spelling) and when they fire

SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreSkillShellCommand, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.

Needed equivalents:
- session start (inject context): `SessionStart` (startup, resume, clear, compact, fork)
- user prompt submit: `UserPromptSubmit` (before the prompt is processed)
- before tool call: `PreToolUse` (matchers `Write`, `Edit`, `NotebookEdit`, `Bash`, `Agent`)
- after tool call: `PostToolUse` (also `PostToolUseFailure`)
- stop: `Stop` (agent finished responding); `SubagentStop`; session end: `SessionEnd`

### 1.3 Stdin payloads

Common fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name`; inside a subagent also `agent_id` and `agent_type`. `model` appears only on SessionStart.

Verbatim doc example (PreToolUse Bash):
```json
{"session_id":"abc123","prompt_id":"...","transcript_path":"...","cwd":"/home/user/my-project","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test","description":"Run test suite","timeout":120000,"run_in_background":false},"tool_use_id":"toolu_01ABC123..."}
```

Per event additions (VERIFIED field lists):
- SessionStart: `source` (`startup|resume|clear|compact|fork`), optional `model`, `agent_type`, `session_title`.
- UserPromptSubmit: `prompt`.
- Stop: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.
- SessionEnd: `reason`.
- SubagentStart/SubagentStop: `agent_id`, `agent_type`.
- PostToolUse: adds `tool_response`, `duration_ms`.

`tool_input` per tool:
- Write: `file_path` (always absolute), `content`
- Edit: `file_path`, `old_string`, `new_string`, `replace_all`
- Bash: `command`, `description`, `timeout`, `run_in_background`
- Agent: `prompt`, `description`, `subagent_type`, optional `model`

Constructed example, PreToolUse for the subagent tool:
```json
{"session_id":"abc123","cwd":"/work/proj","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Review diff","prompt":"Review the staged diff ...","subagent_type":"code-reviewer","model":"sonnet"},"tool_use_id":"toolu_01..."}
```

### 1.4 Blocking, messages, context injection

Exit codes: 0 = success (stdout JSON applied); 2 = blocking error with stderr as the reason; any other = non-blocking error. Effect of exit 2 by event: PreToolUse blocks the call; UserPromptSubmit blocks and erases the prompt; Stop and SubagentStop prevent stopping; PostToolUse shows stderr to Claude only; SessionStart, SubagentStart, SessionEnd show stderr to the user only.

Stdout JSON:
- Universal: `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `terminalSequence`.
- PreToolUse: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask|defer","permissionDecisionReason":"...","updatedInput":{...},"additionalContext":"..."}}`. Top-level `decision`/`reason` is deprecated for PreToolUse. Precedence across hooks: deny > defer > ask > allow.
- UserPromptSubmit, PostToolUse, Stop, SubagentStop: top-level `{"decision":"block","reason":"..."}`.
- SessionStart: `hookSpecificOutput.additionalContext`, plus `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`.
- UserPromptSubmit: `hookSpecificOutput.additionalContext`, `sessionTitle`, `suppressOriginalPrompt`.

Context injection: plain stdout on SessionStart, UserPromptSubmit, UserPromptExpansion, PostModelSwitch is added as context. `additionalContext` is wrapped in a system reminder and capped at 10,000 characters per string (overflow saved to a file with a 2,000-character preview). The doc recommends factual rather than imperative phrasing so prompt-injection defences do not discard it.

### 1.5 Tool names and subagent identification

- File edit/write: `Write`, `Edit`, `NotebookEdit`. No `MultiEdit` in the current tool list (https://code.claude.com/docs/en/tools-reference.md as downloaded to scratchpad `claude-tools.md`).
- Shell: `Bash` (also `PowerShell` where Git Bash is absent; match `Bash|PowerShell`). A `Bash` matcher also covers Monitor since v2.1.314.
- Subagent dispatch: `Agent` (no `Task` in the current docs). Older docs/transcripts used `Task`; to be safe a matcher `Agent|Task` costs nothing (UNCERTAIN whether any live version still emits `Task`).
- Subagent role/model: in the dispatching PreToolUse payload as `tool_input.subagent_type` and optional `tool_input.model`; PostToolUse `tool_response` for `Agent` carries `resolvedModel`, `agentId`, `status`. Hook events fired inside that subagent carry `agent_id` and `agent_type`.
- SubagentHandback tool (v2.1.271+) carries the subagent report in `tool_input.message`.

### 1.6 Trust, approval, flags

- Interactive: hooks from every settings file (including user) are held back until the workspace trust dialog is accepted. In `-p`/SDK mode the folder is treated as trusted.
- `disableAllHooks` setting; managed `allowManagedHooksOnly`.
- No feature flag needed. Edits are picked up by a file watcher. `/hooks` is a read-only browser.

### 1.7 Limitations

- Hooks from settings do run inside subagents (tool events carry `agent_id`/`agent_type`).
- PreToolUse does not fire for `@`-file references, skill-injected shell commands (use `PreSkillShellCommand`), or EndConversation.
- `if` filter on Bash is best effort; do not use it as the only guard.
- MCP tools are matchable (see 1.1).

---

## 2. Codex CLI (rust-v0.172.0)

Sources: https://learn.chatgpt.com/docs/hooks.md (fetched 2026-11-28), https://learn.chatgpt.com/docs/config-file/config-basic.md and config-reference.md, schemas at https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated, source files `codex-rs/protocol/src/hooks.rs`, `codex-rs/config/src/hook_config.rs`, `codex-rs/hooks/src/engine/discovery.rs`. Hooks reached GA on 2026-05-14 (https://learn.chatgpt.com/docs/whats-new.md).

### 2.1 Config files and schema

Locations (VERIFIED):
- `/etc/codex/hooks.json` (system), `%ProgramData%\OpenAI\Codex\hooks.json` (Windows)
- `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) -- user scope
- `.codex/hooks.json` in a trusted project -- project scope
- inline `[hooks]` tables in `config.toml` of each of those directories
- plugin-bundled `hooks/hooks.json` or a `hooks` entry in `.codex-plugin/plugin.json`
- managed hooks via `requirements.toml` (`hooks.managed_dir`)
- Both `hooks.json` and inline `[hooks]` in one layer both load, with a warning.

`hooks.json` file shape is `{"description"?: string, "hooks": {<Event>: [matcherGroup]}}` (source `HooksFile`, `deny_unknown_fields`). Same three levels as Claude.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"",
            "timeout": 30,
            "statusMessage": "Checking Bash command"
          }
        ]
      }
    ]
  }
}
```

TOML equivalent (VERIFIED, doc example):
```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '/usr/bin/python3 "$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py"'
timeout = 30
statusMessage = "Checking Bash command"
```

Handler types: `command` and `mcp_tool` run; `prompt` and `agent` are parsed and skipped (source `HookHandlerConfig`). Command fields (source): `command`, `commandWindows` (alias `command_windows`), `timeout` (seconds), `async`, `statusMessage`, `onFailure` (continue|block), `additionalContextLimit` (default 2500 tokens; 0 = unlimited). `mcp_tool` fields: `server`, `tool`, `input`, `timeout`, `statusMessage`, `onFailure`, `additionalContextLimit`.

Timeouts: default 600 s; SessionEnd/Interrupt default 1 s, max 3 s.

Matchers are regexes: SessionStart matches `source` (`startup|resume|clear|compact|fork`); SessionEnd `reason` (always `other`); SubagentStart/SubagentStop match `agent_type`; PreToolUse/PostToolUse/PermissionRequest match tool name; UserPromptSubmit, Stop, Interrupt ignore the matcher.

Project-relative path / npx:
- Commands run with the session `cwd`, which may be a subdirectory of the repo, so the doc recommends resolving from the git root: `$(git rev-parse --show-toplevel)/.codex/hooks/...`. There is no `${PROJECT_DIR}` placeholder documented for non-plugin hooks (UNCERTAIN whether one exists in source).
- Plugin hooks get env `PLUGIN_ROOT`/`PLUGIN_DATA` and the compatibility aliases `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`.
- `npx -y agentic-sdlc-kit hook pre-tool` as a plain command string: no doc statement either way (UNCERTAIN), expected to work because `command` is a shell string (UNCERTAIN: shell not explicitly named in the doc).

### 2.2 Events

SessionStart, SessionEnd, SubagentStart, PreToolUse, PermissionRequest, PostToolUse, PreModelRequest, PostModelRequest, PreCompact, PostCompact, UserPromptSubmit, SubagentStop, Stop, Interrupt.

Mapping: session start = `SessionStart`; user prompt submit = `UserPromptSubmit`; before tool = `PreToolUse`; after tool = `PostToolUse`; stop = `Stop`; end = `SessionEnd` (1 s budget, always `reason: "other"`).

### 2.3 Stdin payloads

Common: `session_id` (subagents reuse the parent session id), `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`), `turn_id` (Codex extension). Schemas set `additionalProperties:false`; PreToolUse, UserPromptSubmit and SubagentStart schemas carry optional `agent_id`/`agent_type`.

Per event: PreToolUse adds `tool_name`, `tool_use_id`, `tool_input`; PostToolUse adds `tool_response`; UserPromptSubmit adds `prompt`; SessionStart adds `source`; Stop adds `stop_hook_active`, `last_assistant_message`; SubagentStart adds `agent_id`, `agent_type`.

Verbatim doc example (SessionEnd): `{"session_id":"thr_123","transcript_path":"/workspace/.codex/rollout.jsonl","cwd":"/workspace","hook_event_name":"SessionEnd","reason":"other"}`

Constructed examples (field names VERIFIED against the schemas and doc, values illustrative):
```json
{"session_id":"thr_123","transcript_path":"/home/u/.codex/sessions/rollout.jsonl","cwd":"/work/proj","hook_event_name":"PreToolUse","model":"gpt-5","permission_mode":"default","turn_id":"turn_1","tool_name":"Bash","tool_use_id":"call_1","tool_input":{"command":"npm test"}}
{"session_id":"thr_123","cwd":"/work/proj","hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_use_id":"call_2","tool_input":{"command":"*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch"}}
{"session_id":"thr_123","cwd":"/work/proj","hook_event_name":"PreToolUse","tool_name":"spawn_agent","tool_use_id":"call_3","tool_input":{"message":"inspect this repo","agent_type":"explorer"}}
```

### 2.4 Blocking, messages, context

- Block: exit 2 with the reason on stderr, or JSON.
- PreToolUse deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` or the older `{"decision":"block","reason":"..."}`.
- PreToolUse also accepts `additionalContext`; `updatedInput` only together with `permissionDecision:"allow"`.
- NOT supported on PreToolUse (hook is marked failed and the tool call proceeds): `permissionDecision:"ask"`, `continue:false`, `stopReason`, `suppressOutput`. This is a notable gap: a Codex PreToolUse hook cannot halt the whole turn, only deny the call.
- UserPromptSubmit block: `{"decision":"block","reason":"..."}` or exit 2.
- Stop/SubagentStop need JSON on exit 0 (plain text is invalid); `decision:"block"` there means "keep going" with `reason` becoming a new prompt.
- PermissionRequest uses `decision.behavior` allow/deny.
- `systemMessage` shows as a UI warning.
- Context injection: plain stdout on SessionStart, UserPromptSubmit, SubagentStart is added as developer context; JSON `hookSpecificOutput.additionalContext` works for SessionStart, UserPromptSubmit, SubagentStart (to the subagent), PreToolUse, PostToolUse. Plain stdout on PreToolUse/PostToolUse is ignored. Context above about 2,500 tokens spills to `<temp_dir>/hook_outputs/...` unless `additionalContextLimit` is raised.

### 2.5 Tool names and subagent identification

- Shell (including `exec_command`) appears as `Bash` with `tool_input.command` (source test: `{"cmd":...}` is normalised to `{"command":...}`).
- File edits arrive as `apply_patch`: canonical `tool_name` is `apply_patch` (matcher aliases `Edit` and `Write` also match it, but the payload still says `apply_patch`); `tool_input` is `{"command":"<whole patch text>"}`. There is NO `file_path` field. A pre-edit gate must parse `*** Add File: `, `*** Update File: `, `*** Delete File: ` (and `*** Move to: `) headers from the patch text. Sources: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch.rs (builds `tool_input = {"command": <patch text>}`) and https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/parser.rs (header grammar `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`), read on main 2026-11-28.
- Subagent dispatch: `spawn_agent` (matcher alias `Agent`); `tool_input` is the raw function args. Observed field names in source: v1 `message`, `items`, `agent_type`, `model`, `reasoning_effort`, `service_tier`, `fork_context`; v2 `message`, `task_name`, `agent_type`, `model`, `fork_turns`. Which set is live depends on the multi-agent version (UNCERTAIN). Role = `tool_input.agent_type`, model = `tool_input.model`, both optional.
- MCP tools: `mcp__<server>__<tool>`.
- Hosted tools (for example WebSearch) never go through hooks. `write_stdin` does not re-trigger PreToolUse.
- Inside the subagent the hooks get `agent_id`/`agent_type` in the payload and `session_id` is the parent's.

### 2.6 Trust, approval, flags

- Hooks are on by default. Disable with `[features] hooks = false` (`codex_hooks` is a deprecated alias).
- Non-managed hooks need review and trust through `/hooks`; trust is stored per hook in `config.toml` as `hooks.state."<hook key>".trusted_hash` (source `HookStateToml`: `enabled`, `trusted_hash`, `trusted_content_hash`; key derived from source path, event, group index, handler index). New or changed hooks are skipped until trusted. A plugin update that changes a script needs re-review.
- `--dangerously-bypass-hook-trust` (also on `codex resume`) runs enabled hooks without review, per invocation.
- Untrusted project: project-scoped `.codex/` layers (config, hooks, rules) are skipped; user and system hooks still load (https://learn.chatgpt.com/docs/config-file/config-basic.md). Project trust is `projects.<path>.trust_level = "trusted"|"untrusted"` in the user config.
- Managed hooks are trusted by policy; `allow_managed_hooks_only` in requirements.toml disables user/project/session/plugin hooks.
- Consequence for `sdlc install`: writing `.codex/hooks.json` is not enough. A human must trust the project and review the hooks in `/hooks` (or the installer must write `hooks.state."<key>".trusted_hash` itself, whose hash algorithm I did not verify: UNCERTAIN, do not attempt). Non-interactive `codex exec` has no review step (UNCERTAIN how it treats untrusted hooks; assume skipped).

### 2.7 Limitations

- Doc wording: tool hooks are "a useful guardrail, not a complete enforcement boundary"; some specialised tool paths can opt out.
- Hooks do see subagent tool calls (payload carries `agent_id`/`agent_type`).
- Hosted tools are not hookable.
- Cloud orchestration: command, local-config and plugin hooks are unsupported (config-reference.md); only local threads honour them.
- MCP tools are matchable (`mcp__server__tool`).

---

## 3. Gemini CLI (v0.71.1)

Sources: Gemini docs and source at tag v0.71.1, listed in section 0. Source files read: `packages/core/src/hooks/{types,hookRunner,hookEventHandler,hookRegistry,trustedHooks}.ts`, `packages/core/src/scheduler/{scheduler,hook-utils}.ts`, `packages/core/src/agents/{agent-tool,agent-scheduler,local-executor}.ts`, `packages/core/src/utils/trust.ts`, `packages/core/src/tools/tool-names.ts`, `packages/cli/src/commands/mcp/list.ts`, `packages/cli/src/commands/extensions/{list,install}.ts`.

### 3.1 Config files and schema

Precedence (docs/hooks/index.md): project `.gemini/settings.json` > user `~/.gemini/settings.json` > system `/etc/gemini-cli/settings.json` > extensions. Hooks also come from an extension's `hooks/hooks.json` (NOT from `gemini-extension.json`; docs/extensions/reference.md; `${extensionPath}` is substituted in extension files).

Schema is the same three levels (`hooks.<Event>[] -> {matcher, sequential, hooks[]}`):
```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "write_file|replace",
        "hooks": [
          {
            "name": "security-check",
            "type": "command",
            "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/security.sh",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```
Fields: `type` (only `"command"`; an internal `runtime` type exists for SDK use), `command`, `name`, `description`, `timeout` in MILLISECONDS (default 60000), group-level `sequential` (true = run in order, false = parallel), `matcher`.

Matchers: tool events (BeforeTool, AfterTool) use regex; lifecycle events use exact strings; `"*"` or `""` matches all.

Command form (source `hookRunner.ts`): spawns the platform shell (`bash -c` style, PowerShell on Windows) with the command string, `cwd = input.cwd` (the session working dir), so `npx -y ...` as a plain string works (VERIFIED by code path; not executed). Before spawn it textually replaces `$GEMINI_PROJECT_DIR`, `$GEMINI_CWD`, `$GEMINI_PLANS_DIR`, `$GEMINI_SESSION_ID`, `$CLAUDE_PROJECT_DIR` with shell-escaped values, and exports the same variables in the env. CAUTION (source vs doc): the docs say `GEMINI_PROJECT_DIR` is "the project root", but source sets it to `input.cwd` = `config.getWorkingDir()`, which is the directory Gemini was launched in, not necessarily the git root. A hook command should resolve the root itself (`git rev-parse --show-toplevel`) if the user may launch from a subdirectory.

### 3.2 Events (exact spelling)

BeforeTool, AfterTool, BeforeAgent, AfterAgent, Notification, SessionStart, SessionEnd, PreCompress, BeforeModel, AfterModel, BeforeToolSelection (source enum `HookEventName`).

Mapping:
- session start (inject context): `SessionStart` (`source`: startup | resume | clear)
- user prompt submit: `BeforeAgent` (after the user submits, before planning; once per user turn)
- before tool: `BeforeTool` (matchers `write_file`, `replace`, `run_shell_command`, `invoke_agent`)
- after tool: `AfterTool`
- stop: `AfterAgent` (once per turn after the final model response) ; session end: `SessionEnd` (best effort, CLI does not wait)

### 3.3 Stdin payloads

Base (types.ts `HookInput`): `session_id`, `transcript_path` (empty string if none), `cwd`, `hook_event_name`, `timestamp` (ISO 8601). There is NO `permission_mode`, NO `model`, NO `agent_id`/`agent_type` on any event.

Per event (types.ts):
- SessionStart: `source` (`startup|resume|clear`)
- SessionEnd: `reason` (`exit|clear|logout|prompt_input_exit|other`)
- BeforeAgent: `prompt`
- AfterAgent: `prompt`, `prompt_response`, `stop_hook_active`
- BeforeTool: `tool_name`, `tool_input` (raw model args), optional `mcp_context`, optional `original_request_name`
- AfterTool: the same plus `tool_response` (`llmContent`, `returnDisplay`, optional `error`)

Argument keys per built-in tool (docs/reference/tools.md "Tool argument keys"):
- `write_file`: `file_path`, `content`
- `replace`: `file_path`, `old_string`, `new_string`, `instruction`, `allow_multiple`
- `run_shell_command`: `command`, `description`, `dir_path`, `is_background`
- `invoke_agent`: `agent_name`, `prompt` (source `agent-tool.ts`)

Constructed examples:
```json
{"session_id":"7f3e...","transcript_path":"/home/u/.gemini/tmp/<hash>/chats/session-....json","cwd":"/work/proj","hook_event_name":"BeforeTool","timestamp":"2026-11-28T10:00:00.000Z","tool_name":"write_file","tool_input":{"file_path":"/work/proj/src/a.ts","content":"..."}}
{"session_id":"7f3e...","transcript_path":"","cwd":"/work/proj","hook_event_name":"BeforeTool","timestamp":"2026-11-28T10:00:01.000Z","tool_name":"run_shell_command","tool_input":{"command":"npm test","description":"Run tests"}}
{"session_id":"7f3e...","transcript_path":"","cwd":"/work/proj","hook_event_name":"BeforeTool","timestamp":"2026-11-28T10:00:02.000Z","tool_name":"invoke_agent","tool_input":{"agent_name":"codebase_investigator","prompt":"Map the auth flow ..."}}
```
`file_path` in write_file/replace: whether it is always absolute is not stated in the hooks docs (UNCERTAIN; normalise against `cwd`).

### 3.4 Blocking, messages, context

- Exit codes: 0 = success, stdout parsed as JSON (preferred, including deliberate denials); 2 = system block, stderr is the reason; any other code = warning, the action proceeds.
- Output parsing (source): the CLI parses `stdout.trim() || stderr.trim()`. If it is not JSON it is converted to a plain-text result: exit 0 -> `decision:"allow"` plus the text as `systemMessage` (shown to the user, NOT injected into the model); exit 1 -> allow plus `Warning: <text>`; any other non-zero including 2 -> `decision:"deny"` with the text as reason. Consequence: context injection MUST be emitted as JSON; plain stdout does not reach the model on Gemini.
- Common JSON fields: `systemMessage`, `suppressOutput`, `continue`, `stopReason`, `decision` (`allow`|`deny`, alias `block`; source also handles `ask` and `approve`), `reason`, `hookSpecificOutput`.
- BeforeTool: `{"decision":"deny","reason":"..."}` (reason goes to the agent as a tool error, the turn continues); `hookSpecificOutput.tool_input` merges into and overrides the model's args; `continue:false` kills the whole agent loop. Exit 2 = same as deny, stderr is the reason.
- AfterTool: `decision:"deny"` replaces the tool result with `reason`; `hookSpecificOutput.additionalContext` is appended to the tool result; `hookSpecificOutput.tailToolCallRequest {name,args}` chains a tool call.
- BeforeAgent: `hookSpecificOutput.additionalContext` appended to the prompt for this turn only; `decision:"deny"` blocks the turn and discards the user's message; `continue:false` blocks but keeps the message in history; exit 2 = deny.
- AfterAgent: `decision:"deny"` rejects the response and forces a retry with `reason` as a new prompt; `continue:false` stops; `hookSpecificOutput.clearContext`.
- SessionStart: `hookSpecificOutput.additionalContext` (interactive: injected as the first history turn; non-interactive: prepended to the user's prompt) and `systemMessage`. `continue` and `decision` are ignored: startup is never blocked.
- `additionalContext` is sanitised by escaping `<` and `>` (source `getAdditionalContext`).

### 3.5 Tool names and subagent identification

- Edit/write: `replace` (edit) and `write_file` (create/overwrite). No multi-edit tool. (`EDIT_TOOL_NAMES = {replace, write_file}` in `tool-names.ts`.)
- Shell: `run_shell_command`.
- Read-side names, for completeness: `read_file`, `read_many_files`, `glob`, `grep_search` (legacy alias `search_file_content`), `list_directory`.
- MCP tools: `mcp_<server_name>_<tool_name>` (docs/hooks/reference.md).
- Subagent dispatch: at v0.71.1 a single unified tool `invoke_agent` (constant `AGENT_TOOL_NAME`, registered unconditionally in `config.ts` unless `coreTools` filters it) with args `{agent_name, prompt}`. The older doc sentence "subagents are exposed as a tool of the same name" in docs/core/subagents.md is stale (the per-agent `SubagentTool` class no longer exists; `policy-engine.ts` explicitly maps `agent_name` to a virtual alias). So the BeforeTool matcher for subagent dispatch is `invoke_agent`, and the role is `tool_input.agent_name` (built-ins: `codebase_investigator`, `cli_help`, `generalist`, `browser_agent`; custom ones from `.gemini/agents/*.md` or `~/.gemini/agents/*.md`). Model is NOT in the payload; it lives in the agent definition frontmatter (`model:`) or `agents.overrides.<name>.modelConfig`, so a hook must read it from disk.
- Subagents cannot call other subagents.

### 3.6 Trust, approval, flags

- Hooks enabled by default: `hooksConfig.enabled` (default `true`, requires restart); `hooksConfig.disabled` (array of hook names/commands); `hooksConfig.notifications`. There is no `tools.enableHooks` flag in v0.71.1 settings (the old name survives only as an internal config field wired to `hooksConfig.enabled`). VERIFIED in `docs/reference/configuration.md` and `packages/cli/src/config/config.ts`.
- Folder trust: `security.folderTrust.enabled` defaults to `true` in v0.71.1 (docs/reference/configuration.md and `isFolderTrustEnabled` in `trustedFolders.ts`). The prose in docs/cli/trusted-folders.md ("disabled by default") is stale. In an untrusted folder, project hooks are NOT loaded (`hookRegistry.ts`: "Project hooks disabled because the folder is not trusted"), and `.gemini/settings.json` is ignored altogether. Trust decisions live in `~/.gemini/trustedFolders.json` (override with `GEMINI_CLI_TRUSTED_FOLDERS_PATH`).
- Headless/CI: with trust enabled and an undecided folder the CLI exits with `FatalUntrustedWorkspaceError`; bypass with `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true` (`GEMINI_CLI_TRUST_WORKSPACE=false` or `GEMINI_RESTRICTED_MODE=true` forces untrusted). `gemini trust` trusts the current folder (per mcp-server.md note; UNCERTAIN whether it is non-interactive).
- Project hook fingerprinting (`trustedHooks.ts`): key = `<name>:<command>`; first sight of a project hook prints a WARNING and the hook still runs, then the key is stored in `~/.gemini/trusted_hooks.json` under the project root path; a changed `name` or `command` warns again. This is a warn-once mechanism, not a gate (unlike Codex). Extension and user/system hooks are not fingerprinted.
- Non-interactive `-p/--prompt` runs hooks the same way; SessionStart additionalContext is prepended to the prompt.

### 3.7 Limitations

- Hooks DO fire for tool calls made by subagents: the subagent executor calls `scheduleAgentTools`, which builds the same `Scheduler`, and `Scheduler` calls `evaluateBeforeToolHook` against the single global hook system (source `agent-scheduler.ts`, `scheduler.ts`, `hook-utils.ts`). But the payload carries NO subagent identifier and the same `session_id`, so a hook cannot tell main-agent calls from subagent calls (VERIFIED by code, not executed). BeforeAgent/AfterAgent behaviour inside subagent loops is UNCERTAIN.
- MCP tools are matchable (`mcp_<server>_<tool>`) and `mcp_context` is supplied.
- The `@file` (read_many_files) and `!cmd` (shell) user shortcuts are documented as triggering those tools, but I did not confirm that they pass through BeforeTool (UNCERTAIN). Claude Code explicitly does not fire PreToolUse for `@`-file references.
- SessionEnd and PreCompress are advisory and best effort.
- Hook stdout must be JSON only; any stray stdout text turns into a `systemMessage`.
- Only `command` hooks exist; there is no prompt/agent hook type.

---

## 4. Superpowers (https://github.com/obra/superpowers, v7.0.2, README read 2026-11-28)

| Harness | Install | Detection |
|---|---|---|
| Claude Code | `/plugin install superpowers@claude-plugins-official` (official marketplace), or `/plugin marketplace add obra/superpowers-marketplace` then `/plugin install superpowers@superpowers-marketplace`. Non-interactive: `claude plugin install superpowers@claude-plugins-official [--scope user\|project\|local] [--json]`; pass `-y` if no TTY (needed only when the plugin triggers a command-source prompt). | `claude plugin list --json` returns an array; match `id` starting `superpowers@` (fields `id`, `version`, `scope`, `enabled`, `installPath`). Source https://code.claude.com/docs/en/plugins/cli-reference.md. |
| Codex CLI | README: in the TUI run `/plugins`, search `superpowers`, choose `Install Plugin`. A non-interactive CLI also exists at rust-v0.172.0 (`codex plugin add PLUGIN@MARKETPLACE [--json]`, `codex plugin list [--json] [--available] [--marketplace M]`, `codex plugin remove`, `codex plugin marketplace add\|list\|upgrade\|remove`; source `codex-rs/cli/src/plugin_cmd.rs`). The official marketplace https://github.com/openai/plugins (`.agents/plugins/marketplace.json`, name `openai-curated`) has a `superpowers` entry for CODEX, so the likely command is `codex plugin add superpowers@openai-curated` (derived, not executed: UNCERTAIN). Start a new session afterwards. | `codex plugin list --json` -> `{"installed":[{pluginId,name,marketplaceName,version,installed,enabled,...}],"available":[]}`; or the directory `$CODEX_HOME/plugins/cache/<marketplace>/superpowers/...` (constant `PLUGINS_CACHE_DIR = "plugins/cache"`). |
| Gemini CLI | `gemini extensions install https://github.com/obra/superpowers` (update: `gemini extensions update superpowers`). Add `--consent` to skip the security prompt in scripts (flag documented in docs/extensions/reference.md; whether the prompt blocks without a TTY is UNCERTAIN). The repo root `gemini-extension.json` is name `superpowers`, version 7.0.2, `contextFileName: "GEMINI.md"`. | `gemini extensions list -o json` returns a JSON array of extension objects (fields include `name`, `version`, `isActive`, `path`, `id`); `[]` when none. Install dir `~/.gemini/extensions/` (directory name equals the extension name: UNCERTAIN). |

---

## 5. graphify

- Canonical source: PyPI package is `graphifyy` (double y). The repo README states: "The official PyPI package is `graphifyy` (double-y). The CLI and skill command are still `graphify`." Homepage https://graphify.com, docs https://docs.graphify.com, repo https://github.com/Graphify-Labs/graphify (Apache-2.0, default branch `v8`, not archived, last push 2026-11-28; the `main` branch is an old snapshot, version 0.1.14, ignore it). PyPI 0.9.122 requires Python `>=3.11.5,<3.15`. Verified 2026-11-28 via https://pypi.org/pypi/graphifyy/json and tag v0.9.122 files.
- Do not confuse with: PyPI `graphify` (404, not registered) and PyPI `graphify-cli` 0.1.0 (an unrelated project by another author).
- Install (README v0.9.122): `uv tool install graphifyy` (recommended) | `pipx install graphifyy` | `pip install graphifyy`. Then `graphify install` once to register the assistant skill (Claude default; `--platform codex` for Codex, `--platform gemini` for Gemini CLI; `--project` for repo-scoped skill under `.claude/skills/graphify/` or `.agents/skills/graphify/`). Console scripts in pyproject: `graphify` and `graphify-mcp`.
- Detection:
  - `command -v graphify` then `graphify --version` prints `graphify <version>` and exits 0 (source `graphify/__main__.py`: `-v`, `--version`, `version` all handled).
  - Alternative: `uv tool list` / `pipx list` containing `graphifyy`.
  - Skill registered: `~/.claude/skills/graphify/SKILL.md` plus a `.graphify_version` stamp file in that directory (graphify refreshes the skill when the stamp is older than the package).
  - Output of a run: `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`, `cache/`).
- Note: the PyPI name is only canonical because the project README says so; no PyPA-level proof of ownership is available (UNCERTAIN beyond that statement). The user's local skill (`~/.claude/skills/graphify/SKILL.md`) uses `graphifyy` as well, consistent.

---

## 6. `mcp list` commands (non-interactive use)

| | `claude mcp list` | `codex mcp list` | `gemini mcp list` |
|---|---|---|---|
| Exists | Yes (https://code.claude.com/docs/en/mcp.md) | Yes (source `codex-rs/cli/src/mcp_cmd.rs`; docs https://learn.chatgpt.com/docs/extend/mcp.md) | Yes, no flags (docs/tools/mcp-server.md; source `packages/cli/src/commands/mcp/list.ts` at v0.71.1) |
| Health check | Yes, per-server status | No, config only | Yes, real connection test with 5 s default timeout (spawns stdio servers, only in trusted folders) |
| Output | Per server a status: `Connected`, `Needs authentication`, `Failed to connect` (with detail), `Pending approval (run claude to approve)`, `Disabled for this project`, `Blocked by enterprise managed policy`, `not configured`. Exact line layout not in docs (UNCERTAIN). No `--json` documented (UNCERTAIN). | Two aligned tables. Stdio: `Name Command Args Env Cwd Status Auth`. HTTP: `Name Url Bearer Token Env Var Status Auth`. Status `enabled`, `disabled`, `disabled: <reason>`. Empty: ``No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.`` `--json` gives entries with `name`, `enabled`, `disabled_reason`, `transport{type:"stdio"\|"streamable_http",...}`, `startup_timeout_sec`, `tool_timeout_sec`, `auth_status`. | Header `Configured MCP servers:` then lines like `✓ stdio-server: command: python3 server.py (stdio) - Connected`, `✗ sse-server: https://... (sse) - Disconnected`; other states `Disabled` (circle), `Blocked`, `Connecting`. Empty: `No MCP servers configured.` Written to stdout via `console.log`. No JSON mode. |
| Exit code | 0 when the command runs, even if a server fails (doc says a failure status is not a command failure; exit 0 not literally documented: UNCERTAIN) | 0 (`run_list` returns Ok; source-inferred) | 0 always (handler calls `exitCli()` default 0; source). |
| Non-interactive | Yes. Does not start untrusted `.mcp.json` servers; shows Pending approval until the workspace is trusted. | Yes | Yes, but in an untrusted folder every server is shown `Disabled` and stdio servers are never tested. |

Recommendation for the kit: do not parse the human text of `claude mcp list` or `gemini mcp list` for decisions; for Codex use `--json`; for Claude and Gemini treat the presence of the server name in stdout as the only stable signal, or read the config files directly.

---

## 7. Needs-to-mechanism mapping and gaps

Legend: OK = native mechanism; PARTIAL = works with caveats; GAP = no native equivalent.

| Need | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| session-context (inject at start) | OK. `SessionStart`; stdout or `hookSpecificOutput.additionalContext` (10k chars cap) | OK. `SessionStart`; plain stdout or `additionalContext` (2.5k token spill threshold, tunable) | OK but JSON only. `SessionStart` `hookSpecificOutput.additionalContext`; plain stdout becomes a user-facing `systemMessage`, not model context. No `compact`/`fork` source (only startup/resume/clear) |
| prompt-record (log every user prompt) | OK. `UserPromptSubmit` payload `prompt` | OK. `UserPromptSubmit` payload `prompt` | OK. `BeforeAgent` payload `prompt` (name differs; fires per user turn) |
| pre-edit gate | OK. `PreToolUse` matcher `Write\|Edit\|NotebookEdit`; `tool_input.file_path` absolute | PARTIAL. `PreToolUse` matcher `apply_patch` (or alias `Edit\|Write`); NO file path field, must parse the patch text headers; shell-based edits (`sed -i`, redirects) arrive as `Bash` | OK. `BeforeTool` matcher `write_file\|replace`; `tool_input.file_path` (absolute-ness UNCERTAIN); shell edits arrive as `run_shell_command` |
| pre-shell gate | OK. `PreToolUse` `Bash` (+`PowerShell` on Windows); `tool_input.command` | OK. `PreToolUse` `Bash`; `tool_input.command` | OK. `BeforeTool` `run_shell_command`; `tool_input.command` |
| pre-subagent gate | OK. `PreToolUse` `Agent`; `subagent_type`, `model`, `prompt`, `description` | PARTIAL. `PreToolUse` `spawn_agent` (alias `Agent`); only `message`/`agent_type`/`model` etc, field set varies by multi-agent version. `SubagentStart` can also inject context into the subagent | PARTIAL. `BeforeTool` `invoke_agent`; only `agent_name` + `prompt`; no model in payload (read the agent file); subagent role visible only here, not on the subagent's own tool calls |
| block-with-message | OK. exit 2 + stderr, or `permissionDecision:"deny"` + reason (PreToolUse), `decision:"block"` + reason (UserPromptSubmit, Stop) | PARTIAL. exit 2 + stderr or deny JSON on PreToolUse/UserPromptSubmit; no `continue:false`/`ask` on PreToolUse; hook must be trusted first; "guardrail, not a complete boundary" | OK. exit 2 + stderr or `{"decision":"deny","reason":...}` exit 0; reason reaches the agent as a tool error and the turn continues; `continue:false` kills the loop |
| post-tool record | OK. `PostToolUse` | OK. `PostToolUse` | OK. `AfterTool` |
| stop / end hooks | OK. `Stop`, `SubagentStop`, `SessionEnd` | OK. `Stop`, `SubagentStop`, `SessionEnd` (1 s) | OK. `AfterAgent` (retry via deny), `SessionEnd` (best effort); no SubagentStop equivalent (GAP) |
| distinguish subagent-made calls | OK. `agent_id`, `agent_type` in payload | OK. `agent_id`, `agent_type` in payload | GAP. no identifier, same `session_id` |
| works without human trust step | PARTIAL. interactive needs workspace trust; `-p` mode is treated as trusted | GAP. hooks must be trusted (hash) via `/hooks` or run with `--dangerously-bypass-hook-trust`; project must be trusted | PARTIAL. folder trust (default on) gates project hooks; headless needs `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true`; per-hook fingerprint only warns |

Main gaps to design around:
1. Codex edit gate has no file path (must parse `apply_patch` text) and shell-driven edits bypass `apply_patch` entirely.
2. Codex hooks (and its project layer) need user trust, so `sdlc install` cannot guarantee activation; `sdlc doctor` should report "installed but untrusted" using `codex` trust state (unverified how to read it non-interactively).
3. Gemini cannot identify subagent calls and has no model/role in tool payloads; dispatch role is only `invoke_agent.agent_name`.
4. Gemini plain stdout never reaches the model; every context-injecting hook must output strict JSON (and no stray stdout).
5. Codex `spawn_agent` args vary by multi-agent version; Claude's subagent tool name (`Agent`, formerly `Task`) should be matched defensively.
6. Env/path placeholders differ: Claude `${CLAUDE_PROJECT_DIR}` (and Gemini accepts `$CLAUDE_PROJECT_DIR` as an alias, set to the launch directory), Codex has none (resolve git root in the command), Gemini `$GEMINI_PROJECT_DIR` (launch dir, not necessarily root).
7. Timeouts differ in unit: Claude seconds, Codex seconds, Gemini milliseconds.

## 8. Items to test before shipping (all UNCERTAIN above)

- Claude: `claude mcp list` exit code with a failing server; whether any live version still emits tool name `Task`.
- Codex: shell used for `command` strings (so `npx ...` and `$(...)` work); non-interactive `codex exec` behaviour for untrusted hooks; exact `spawn_agent` field set on the installed version; `codex plugin add superpowers@openai-curated` behaviour.
- Gemini: whether `file_path` is absolute in write_file/replace payloads; whether `!cmd` shell shortcuts trigger BeforeTool; whether `--consent` fully removes prompts in non-TTY; `gemini trust` interactivity; BeforeAgent behaviour inside subagent loops.
