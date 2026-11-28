# agentic-sdlc-kit Plan 3: Harness Hooks & Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code, Codex and Gemini sessions in an installed repository run `sdlc hook <harness> <event>`. The hook:
- injects the current task's context;
- applies an owner's `/approve` that the owner typed into the prompt;
- warns about rule gaps (observe mode) or blocks them (enforce mode): edits before plan approval, subagents without a role and tier, `gh pr merge --admin`, other AI CLIs, and agents changing the mode.

Around the hook come:
- `sdlc config set mode`;
- an outbox with `sdlc sync`;
- task worktree commands, with orphan detection in `sdlc status`;
- Superpowers, graphify and per-harness MCP doctor checks;
- the threat model.

**Architecture:**
- One entrypoint, `src/commands/hook.ts`.
  - It normalizes each harness payload into a `HookEvent`.
  - It resolves the task from the git checkout that contains the edited file (or from the session `cwd`).
  - It asks pure policy functions for a `HookOutcome` and renders that outcome in the harness's own output protocol.
  - It fails open on every error except the explicit rules, the same as `githook.ts`.
- Hooks are rendered as owned array items, matched by a marker, inside each harness's settings file. A rendered launcher script `.sdlc/hooks/run.sh` resolves `sdlc` the same way the git hooks do.
- Gaps and queued writes go to `.sdlc/cache/` first, which keeps hooks fast. `sdlc sync` flushes them to GitHub.

**Tech Stack:** Node.js ≥ 20, TypeScript strict ESM, `commander`, `yaml` (its `parseDocument` writes `sdlc.config.yaml` without losing comments), `zod`, `vitest`. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md`. This plan implements:
- §5 hooks entrypoint, outbox and `sdlc sync`;
- §11 harness-hook layer, session hooks and mode switch;
- §13 worktrees and orphan radar;
- §14 Superpowers/graphify install and doctor, MCP doctor for every harness, and the harness-hook doctor round trip.

**Research inputs (read before the task that needs them):**
- `docs/notes/harness-hooks-2026-11.md`: hook formats verified 2026-11-28 against Claude Code 2.1.332, Codex rust-v0.172.0 and Gemini CLI v0.71.1. Section 7 lists the gaps; section 8 lists UNCERTAIN items.
- `docs/notes/plan-3-codebase-map.md`: where everything lives today.

## Global Constraints

- Plan 1 and Plan 2 Global Constraints still hold:
  - Node ≥ 20, strict ESM;
  - runtime deps only `commander`/`yaml`/`zod`;
  - `gh` for all GitHub access;
  - English only;
  - nothing from any private reference project;
  - secrets never in files; test fixtures build fake tokens at run time.
- Generated files never write outside the repository. User-scope installs (Superpowers, graphify, harness trust) are printed as commands for the owner and verified by `doctor`. They are never executed.
- A hook process:
  - writes only its protocol output to stdout;
  - finishes within its rendered timeout (`pre-tool` 15 s, `prompt` 30 s, `session-start` 30 s);
  - exits 0 in every case. Blocks are expressed in the protocol JSON, never as exit code 2.
- Any error inside a hook (bad payload, `sdlc` config missing, GitHub unreachable, timeout) gives "allow". The hook prints one stderr line `sdlc: hook skipped: <reason>`; stdout is empty (Claude, Codex) or `{}` (Gemini).
- Rules apply by mode: in `enforce` a rule violation blocks; in `observe` it warns the agent and is recorded as a gap. One exception: `hook-spoof` blocks in both modes.
- No code path runs `git push --force`, `git worktree prune`, `git worktree remove --force`, `git branch -D` or `rm -rf`. Tests assert the git argument lists.
- Every new command supports `--json`. Writing commands support `--dry-run`.
- Prompt text is never stored. Prompt records hold a SHA-256 hash, the session id and the prompt id only.
- The managed instruction block stays under 150 lines for every config (existing test).

## Harness Hook Facts (from `docs/notes/harness-hooks-2026-11.md`)

| | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| File we render | `.claude/settings.json` | `.codex/hooks.json` | `.gemini/settings.json` |
| session start / prompt / pre-tool | `SessionStart` / `UserPromptSubmit` / `PreToolUse` | `SessionStart` / `UserPromptSubmit` / `PreToolUse` | `SessionStart` / `BeforeAgent` / `BeforeTool` |
| Edit tools → paths | `Write`, `Edit`, `NotebookEdit` → `tool_input.file_path` (`notebook_path` for NotebookEdit) | `apply_patch` → parse `*** Add File: `, `*** Update File: `, `*** Delete File: `, `*** Move to: ` lines of `tool_input.command` | `write_file`, `replace` → `tool_input.file_path` (may be relative: resolve against `cwd`) |
| Shell | `Bash`, `PowerShell` → `tool_input.command` | `Bash` → `tool_input.command` | `run_shell_command` → `tool_input.command` |
| Subagent → role / model | `Agent` (also `Task`) → `subagent_type` / `model` | `spawn_agent` → `agent_type` / `model` | `invoke_agent` → `agent_name` / none |
| In a subagent | `agent_id` present | `agent_id` present | not detectable |
| Timeout unit | seconds | seconds | milliseconds |
| Deny output | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":R}}` | same as Claude | `{"decision":"deny","reason":R}` |
| Context output | `{"hookSpecificOutput":{"hookEventName":E,"additionalContext":C}}` | same as Claude | same shape, `E` is the Gemini event name; plain stdout never reaches the model |
| Trust | workspace trust dialog | trusted project and per-hook review in `/hooks` | trusted folder |

## Rulings Made While Planning

- **Prompt approvals are applied by the prompt hook itself.** A `sdlc approve --prompt` flag would be agent-invocable, so it is not added. The hook sees the human's prompt directly. When its first non-empty line is an owner command, the hook records `Approval{source:'prompt'}` on the current task. The pre-shell rule `hook-spoof` blocks agents from running `sdlc hook` or the launcher themselves. Cost if wrong: an agent with a shell can still forge approvals by obfuscating the command, and the threat model says so.
- **Gaps are logged locally, then flushed.** Writing the state comment on every tool call would mean one GitHub write per call, so `.sdlc/cache/gaps.jsonl` is written instead. `sdlc sync` (started in the background by the session-start hook when anything is queued) flushes it into the state comment's `gaps` field, which is capped at the 20 newest. Cost if wrong: gaps reach GitHub only on the next session start or sync.
- **The outbox queues command lines, not tracker writes.** A queued `{argv}` is re-run by `sdlc sync`, so the event is re-applied to fresh state and stale state is never replayed. Queueable commands: `stage start`, `stage publish`, `evidence add`, `review handoff`, `approve`, `task checkpoint`.
  - Not queued: `task new` (it would duplicate issues) and `deploy record` (it would re-run `--verify` later).
  - A transport failure with queueing disabled exits 75.
  - Cost if wrong: a command that half-succeeded before going offline repeats its comment on replay (stage publish dedup in Task 12 limits that).
- **Task state for edit checks is cached only when edits are allowed.** That entry lives 10 minutes in `.sdlc/cache/hook-tasks.json`. A "not allowed" answer is always re-read, so the owner's approval takes effect on the next edit. Cost if wrong: one GitHub read per blocked edit.
- **Paths that never need a task:**
  - files outside the project (outside the repository and its worktrees);
  - `docs/**`;
  - any `*.md`.

  In enforce mode, agents may not edit `sdlc.config.yaml` or anything under `.sdlc/` except `.sdlc/agents/custom/`. Cost if wrong: a code change disguised as Markdown passes; the git pre-commit layer and review remain.
- **The subagent tier rule.** A dispatch passes when it names a role and either names a model or uses a rendered `sdlc-<role>` agent, whose file pins the model. Gemini payloads never carry a model, so in enforce mode Gemini built-in agents are blocked. Cost if wrong: Gemini users must use `sdlc-*` roles in enforce.
- **Allowed read-only AI CLI calls:** `<cli> --version`, `<cli> mcp list`, `<cli> plugin list`, `<cli> extensions list`. Everything else that starts claude, codex, gemini, aider, cursor, cursor-agent, ollama, opencode, goose, llm or sgpt (directly, through `npx`/`pnpm dlx`/`bunx`/`env`/`sudo`, or as `@anthropic-ai/claude-code`, `@openai/codex` or `@google/gemini-cli`) is a violation. Shell-driven file edits (`sed -i`, redirects) are not parsed; the threat model lists this as a known gap (the Codex edit gap of research section 7).
- **Codex hooks go in `.codex/hooks.json`, not inline in `config.toml`.** Inline `[[hooks.*]]` arrays of tables would collide with user `[hooks]` tables and the managed TOML block. Codex loads both and only warns.
- **Superpowers and graphify are never installed by `init`.** It prints the per-harness commands as `next:` lines, and `doctor` verifies them (spec §14 "prints/executes"; the Plan 2 constraint forbids user-scope writes). The Codex command `codex plugin add superpowers@openai-curated` is unverified, so INSTALL.md also names the `/plugins` TUI route.
- **Gemini hooks on Windows are unsupported in v1.** Gemini runs hook commands through PowerShell there, and the launcher command is POSIX shell. Doctor warns on `win32` when gemini is a harness.
- **Deferred items folded in:** the Plan 1 threat model, outbox/`sdlc sync`, R30 prompt approvals, I4 (compare body in the same-second concurrency window), M7 (stage publish retry dedup), MCP catalog `@latest` pinning, MCP doctor for Codex/Gemini, and the harness-hook round trip.
- **Deferred to Plan 4:** M6 (doctor already has a `labels` check, so only re-verify), M8, M10, M11 (package `files`, packaging), I1 PR re-point, the `--unverified` local clock, fake trust with an undefined login, and the three Plan 2 residual minors the owner accepted as-is. They are recorded in `docs/notes/plan-3-rulings.md` (Task 12).

## Review Focus

1. **The repository already has its own hooks and settings.** `.claude/settings.json` has `permissions` and a user `PreToolUse` hook; `.gemini/settings.json` has its own `hooks.BeforeTool` entry and MCP servers. `init` appends our items, keeps every user item and key byte-for-byte, and `uninstall` removes only items carrying the `.sdlc/hooks/run.sh` marker (Task 6 test `keeps user items in an owned array`, Task 7 test `init merges hooks into customized settings`).
2. **The hook meets a broken world:** malformed JSON on stdin, no `sdlc.config.yaml`, GitHub offline, or a lookup slower than the deadline. The agent is never blocked by a rule it did not break. Exit 0, protocol-valid stdout (Gemini `{}`), one stderr line (Task 4 test `fails open`).
3. **The agent edits a file in another worktree than its `cwd`, or creates a file in a directory that does not exist yet.** The task comes from the worktree that contains the file. The nearest existing ancestor directory is used (Task 4 test `resolves the task from the edited file`).
4. **Forbidden commands hidden in chains, subshells and env prefixes are caught, and mentions are not.** `cd x && gh pr merge 3 --admin`, `FOO=1 npx -y @openai/codex exec hi` and `$(claude -p hi)` are caught. `echo "codex"`, `grep -r gemini src` and `git commit -m "explain claude hooks"` are not (Task 3 test table).
5. **The owner's `/approve` prompt arrives twice** (prompt resubmitted, or session resumed and replayed). It is applied once; the second time the context says it was already recorded. With several owners and a login that is not an owner, nothing is recorded and the context says why (Task 5 tests).

---

### Task 1: Core: edit permission, gaps in the state

**Files:**
- Create: `src/core/edits.ts`
- Modify: `src/core/types.ts`, `src/core/stateMachine.ts`, `src/core/stateComment.ts`
- Test: `tests/core/edits.test.ts`, `tests/core/stateMachine.test.ts`, `tests/core/stateComment.test.ts`

**Interfaces:**
- Produces:
  - `type GapRule = 'no-task' | 'plan-not-approved' | 'task-done' | 'protected-path' | 'subagent-role' | 'subagent-tier' | 'admin-merge' | 'ai-cli' | 'mode-change' | 'hook-spoof' | 'no-verify' | 'force-push' | 'worktree-prune' | 'rm-rf'` (in `types.ts`).
  - `interface Gap { at: string; rule: GapRule; text: string; harness: string; blocked: boolean }`.
  - `TaskState.gaps?: Gap[]`.
  - `TaskEvent` member `{ kind: 'gap_recorded'; gaps: Gap[] }`.
  - `MAX_GAPS = 20`.
  - In `edits.ts`: `type EditVerdict = { allowed: true } | { allowed: false; rule: 'plan-not-approved' | 'task-done'; text: string }` and `editsAllowed(state: TaskState, type: TaskTypeDef): EditVerdict`.

- [ ] **Step 1: Write the failing tests**

`tests/core/edits.test.ts`, one `it` per row, all via `editsAllowed(state, BUILTIN type)`:

| type | phase | status | planning approval | expected |
|---|---|---|---|---|
| feature | brainstorming | in_progress | none | `{allowed:false, rule:'plan-not-approved'}`, text contains `#<issue>` and `brainstorming` |
| feature | planning | in_progress | none | not allowed, `plan-not-approved` |
| feature | planning | in_progress | set | allowed |
| feature | implementation | in_progress | none | allowed (phase after planning) |
| bugfix | debugging | in_progress | none | allowed (repro) |
| spike | exploration | in_progress | none | allowed (no planning phase) |
| analysis / artifact | any | in_progress | none | allowed |
| feature | delivery | done | set | `{allowed:false, rule:'task-done'}`, text contains `sdlc task reopen` |

The `plan-not-approved` text is exactly: `` #<issue> is in <phase> and its plan is not approved yet; publish it with `sdlc stage publish <issue> planning` and wait for the owner's /approve ``.

`tests/core/stateMachine.test.ts` gets the `gap_recorded` tests:
- it appends gaps;
- it deduplicates gaps with the same `rule`+`text`, keeping the newest `at`;
- it keeps only the `MAX_GAPS` newest;
- it does not change `status`, `phase` or `updatedAt` beyond the max of the event times.

`tests/core/stateComment.test.ts`:
- a state with `gaps` round-trips;
- an old state without `gaps` still parses;
- `gaps: "x"` throws `StateCommentError` naming `gaps`.

- [ ] **Step 2: Run** `npx vitest run tests/core` and expect failures (missing module/kind).
- [ ] **Step 3: Implement.** `editsAllowed` compares phase indexes inside `type.phases`. The `gap_recorded` handler lives in `applyEvent`. `parseStateComment` validates the optional array: each element is an object with string `at`, `rule`, `text`, `harness` and boolean `blocked`.
- [ ] **Step 4: Run** `npx vitest run tests/core && npm run typecheck` and expect a pass.
- [ ] **Step 5: Commit** `feat(core): edit permission by phase and recorded gaps`

---

### Task 2: Hook payload normalization

**Files:**
- Create: `src/hooks/types.ts`, `src/hooks/payload.ts`
- Test: `tests/hooks/payload.test.ts`, fixtures `tests/fixtures/hooks/<harness>-<case>.json` (built from the constructed examples in research §1.3, §2.3, §3.3)

**Interfaces:**
- Produces (`types.ts`):
  - `HOOK_HARNESSES = ['claude','codex','gemini'] as const`; `type HookHarness`.
  - `HOOK_EVENTS = ['session-start','prompt','pre-tool'] as const`; `type HookEventName`.
  - `type ToolCall = { category:'edit'; name:string; paths:string[] } | { category:'shell'; name:string; command:string } | { category:'subagent'; name:string; role?:string; model?:string } | { category:'other'; name:string }`.
  - `interface HookEvent { harness: HookHarness; event: HookEventName; cwd: string; sessionId?: string; promptId?: string; prompt?: string; source?: string; inSubagent: boolean; tool?: ToolCall }`.
  - `interface HookOutcome { block?: string; context: string[]; warnings: string[] }`.
- Produces (`payload.ts`):
  - `class HookPayloadError extends Error`.
  - `normalizePayload(harness: HookHarness, event: HookEventName, raw: unknown): HookEvent`.
  - `patchPaths(patch: string): string[]` (relative paths as written in the patch, in order, without duplicates).

- [ ] **Step 1: Write the failing tests**
  - Claude `PreToolUse` `Write` gives `{category:'edit', name:'Write', paths:['/work/proj/src/a.ts']}`; `NotebookEdit` uses `notebook_path`; `Bash` gives shell with the command; `Agent` with `subagent_type:'sdlc-reviewer', model:'sonnet'` gives subagent role/model; `agent_id` present gives `inSubagent:true`; `Read` gives `other`.
  - Codex: `apply_patch` with an Add + Update + Move patch gives edit paths resolved against `cwd` (`/work/proj/hello.txt`, …); `spawn_agent` `{agent_type:'explorer'}` gives role `explorer`, model undefined; `Bash` gives shell.
  - Gemini: `write_file` with relative `src/a.ts` and cwd `/work/proj` gives `/work/proj/src/a.ts`; `run_shell_command` gives shell; `invoke_agent {agent_name:'codebase_investigator'}` gives role, no model; `inSubagent` is always false.
  - Prompt events: Claude/Codex `UserPromptSubmit` and Gemini `BeforeAgent` give `prompt`, `sessionId` and `promptId` (Claude `prompt_id`, Codex `turn_id`, Gemini none). Session start gives `source`.
  - `patchPaths('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: c.ts\n*** End Patch')` equals `['a.ts','b.ts','c.ts']`.
  - Errors: `raw` not an object, missing `cwd`, or a relative `cwd` → `HookPayloadError`. Unknown extra fields are ignored.
- [ ] **Step 2: Run** `npx vitest run tests/hooks/payload.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** `normalizePayload` with one small mapping table per harness (tool name → category and field names, per the Harness Hook Facts table). Paths are made absolute with `path.resolve(cwd, p)`.
- [ ] **Step 4: Run** it again and expect PASS. Then run `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hooks): normalize Claude, Codex and Gemini hook payloads`

---

### Task 3: Policy: shell rules, subagent rule, edit rule (pure)

**Files:**
- Create: `src/hooks/shell.ts`, `src/hooks/policy.ts`
- Test: `tests/hooks/shell.test.ts`, `tests/hooks/policy.test.ts`

**Interfaces:**
- Consumes: `GapRule`, `editsAllowed` (Task 1); `HookEvent`, `ToolCall`, `HookOutcome` (Task 2); `Config`, `TaskState`, `TaskTypeDef`.
- Produces:
  - `shellWords(command: string): string[][]`: one word list per simple command. It splits on `;`, `&&`, `||`, `|`, `&`, newlines, and inside `$( … )` and backticks. It honours single and double quotes, so quoted text stays one word.
  - `interface Violation { rule: GapRule; text: string }`.
  - `shellViolations(command: string): Violation[]`.
  - `subagentViolation(tool: Extract<ToolCall,{category:'subagent'}>): Violation | undefined`.
  - `interface PathCheck { path: string; inProject: boolean; relPath?: string; issue?: number; branch?: string; lookup: 'ok' | 'none' | 'failed'; state?: TaskState; type?: TaskTypeDef }`.
  - `editViolations(checks: PathCheck[], mode: 'observe'|'enforce'): { violations: Violation[]; warnings: string[] }`.
  - `decide(violations: Violation[], mode, harnessWarnings?: string[]): HookOutcome`: in enforce, the first violation's text, prefixed `sdlc (enforce): `, is the `block`; every violation's text is in `warnings` in observe, and `hook-spoof` always blocks.

- [ ] **Step 1: Write the failing tests.** `tests/hooks/shell.test.ts` is a table of `[command, expected rules]`:

| command | rules |
|---|---|
| `gh pr merge 12 --admin` | `admin-merge` |
| `cd x && gh pr merge 3 --squash --admin` | `admin-merge` |
| `gh pr merge 12 --squash` | none |
| `claude -p "fix it"` | `ai-cli` |
| `FOO=1 npx -y @openai/codex exec hi` | `ai-cli` |
| `echo $(gemini -p hi)` | `ai-cli` |
| `/usr/local/bin/aider --yes` | `ai-cli` |
| `pnpm dlx @google/gemini-cli` | `ai-cli` |
| `claude mcp list`, `codex --version`, `gemini extensions list`, `claude plugin list --json` | none |
| `echo "codex"`, `grep -r gemini src`, `git commit -m "explain claude hooks"` | none |
| `sdlc config set mode observe`, `npx --no-install sdlc config set mode enforce` | `mode-change` |
| `sdlc hook claude prompt < x.json`, `.sdlc/hooks/run.sh claude prompt`, `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#v0.1.0 hook gemini prompt` | `hook-spoof` |
| `git commit --no-verify -m x`, `git commit -n -m x`, `git push --no-verify` | `no-verify` |
| `git push --force`, `git push -f origin x`, `git push --force-with-lease` | `force-push` |
| `git worktree prune`, `git worktree remove --force .worktrees/1-x` | `worktree-prune` |
| `rm -rf build`, `rm -fr x`, `rm -r -f x` | `rm-rf` |
| `rm -r build`, `git push origin task/1-x` | none |

  Violation texts (exact):
  - `admin-merge`: `` `gh pr merge --admin` bypasses checks and reviews; merge through the normal PR flow ``
  - `ai-cli`: `launching another AI CLI (<name>) is not allowed; do the work yourself or dispatch an sdlc role subagent`
  - `mode-change`: `` only the owner changes sdlc settings (`sdlc config set`); ask the owner ``
  - `hook-spoof`: `sdlc hooks are run by the harness only`
  - `no-verify`: `--no-verify skips the git hooks and the secret guard`
  - `force-push`: `force-pushing is not allowed`
  - `worktree-prune`: `` `git worktree prune` and forced removal are not allowed; use `sdlc worktree finish` ``
  - `rm-rf`: `` `rm -rf` is not allowed; delete specific files ``

  `tests/hooks/policy.test.ts`:
  - **subagent:** role missing gives `subagent-role` (`subagent dispatch needs a role: use an sdlc-<role> agent`); role `Explore` without a model gives `subagent-tier` (`subagent <role> needs a model tier: pass a model or use an sdlc-<role> agent`); `Explore` + `haiku` gives none; `sdlc-reviewer` without a model gives none.
  - **edit:** each of the following, in both modes:
    - `inProject:false` gives none;
    - `relPath` `docs/x.ts`, `README.md`, `a/b/notes.md` give none;
    - `sdlc.config.yaml` and `.sdlc/manifest.json` give `protected-path` in enforce and none in observe, while `.sdlc/agents/custom/x.md` gives none;
    - no issue gives `no-task` with text `` editing <relPath> outside a task: create one with `sdlc task new` and work in its worktree `` (branch named when known);
    - `lookup:'failed'` gives no violation plus a warning `could not read task #<n>; edit allowed`;
    - a state where `editsAllowed` is false gives its rule and text.
  - **decide:** enforce gives a `block` starting `sdlc (enforce): `; observe gives no `block` and warnings prefixed `sdlc (observe): `; `hook-spoof` in observe still blocks.
- [ ] **Step 2: Run** `npx vitest run tests/hooks` and expect FAIL.
- [ ] **Step 3: Implement.** Before checking the first word, `shellWords` callers strip leading `VAR=value` words and the wrappers `env`, `sudo`, `exec`, `npx [-y|--yes|--no-install]`, `pnpm dlx`, `bunx`, `yarn dlx`. Compare the basename of the first word. Package names map to CLIs: `@anthropic-ai/claude-code` → claude, `@openai/codex` → codex, `@google/gemini-cli` → gemini. An argument starting `github:` whose path contains `agentic-sdlc-kit`, or the word `agentic-sdlc-kit`, counts as `sdlc`.
- [ ] **Step 4: Run** it again and expect PASS. Then run `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hooks): shell, subagent and edit policy rules`

---

### Task 4: `sdlc hook <harness> pre-tool`: resolution, output protocol, fail-open

**Files:**
- Create: `src/hooks/resolve.ts`, `src/hooks/output.ts`, `src/hooks/localLog.ts`, `src/commands/hook.ts`
- Modify: `src/cli.ts` (add `makeHookContext` to `CliDeps`, `registerHookCommand`)
- Test: `tests/hooks/output.test.ts`, `tests/hooks/resolve.test.ts`, `tests/commands/hook.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3. `createGitRunner(cwd)` (`src/install/provision.ts`), `taskIssueOf` (`src/commands/githook.ts`), the `Tracker.getTask`, `typeRegistry` and Deadline pattern of `githook.ts`.
- Produces:
  - `resolve.ts`:
    - `interface Checkout { root: string; commonDir: string; branch?: string; issue?: number }`;
    - `checkoutOf(dir: string, gitFor: (cwd: string) => GitRunner): Promise<Checkout | undefined>`, which walks up to the nearest existing directory and uses `git rev-parse --show-toplevel --path-format=absolute --git-common-dir` plus `git symbolic-ref --short -q HEAD`.
  - `output.ts`: `renderOutput(harness: HookHarness, event: HookEventName, outcome: HookOutcome): string` (exact JSON per the Harness Hook Facts table; context joined with `\n` and capped at 9000 characters).
    - pre-tool with no block and no warnings gives `''` (Claude, Codex) or `'{}'` (Gemini).
    - pre-tool warnings give Claude/Codex `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":W},"systemMessage":W}` and Gemini `{"systemMessage":W}`.
  - `localLog.ts`:
    - `CACHE_DIR = '.sdlc/cache'`;
    - `appendJsonLine(root: string, file: string, value: unknown): Promise<void>`;
    - `readJsonLines<T>(root, file): Promise<T[]>` (skips bad lines);
    - `GAPS_FILE = 'gaps.jsonl'`, `PROMPTS_FILE = 'prompts.jsonl'`, `TASK_CACHE_FILE = 'hook-tasks.json'`;
    - `interface LoggedGap extends Gap { issue?: number }`.
  - `hook.ts`:
    - `interface HookContext { cwd: string; readStdin(): Promise<string>; loadConfig(root: string): Config | undefined; makeTracker(cfg: Config, root: string): Tracker; gitFor(cwd: string): GitRunner; now(): string; out(text: string): void; err(text: string): void; spawnSync?(root: string): void; deadlineMs?: number }`;
    - `runHook(harness: HookHarness, event: HookEventName, ctx: HookContext): Promise<0>`;
    - `registerHookCommand(program, makeContext)` for `sdlc hook <harness> <event>`, which validates both arguments against the consts and on an unknown value prints the skip line and exits 0.

- [ ] **Step 1: Write the failing tests**
  - `output.test.ts`: golden strings for each harness × {block, warnings, empty} for pre-tool, and context for session-start and prompt. Gemini prompt uses `hookEventName:'BeforeAgent'`. A 20 000-character context is truncated to 9000 characters ending `…`.
  - `resolve.test.ts` (real repos via `createTestRepo`):
    - a file in `.worktrees/7-x` (added with `git worktree add -b task/7-x`) resolves to issue 7 even when `cwd` is the main checkout;
    - a path whose directories do not exist resolves through its nearest existing ancestor;
    - a path in `/tmp` outside the repo gives `undefined`;
    - main and worktree share `commonDir`.
  - `hook.test.ts`, with a hand-built `HookContext` and a `FakeTracker`. Enforce config unless noted:
    - Claude `Write` to `src/a.ts` on branch `task/5-x` where #5 is feature/planning without approval → stdout is the deny JSON with `plan-not-approved` text; one line in `gaps.jsonl` with `issue:5, blocked:true`.
    - The same in observe → warnings JSON, `blocked:false`.
    - Approved plan → `''`, and a `hook-tasks.json` entry for 5. A second call within 10 minutes does not call `getTask` (spy).
    - `cwd` main checkout, file in `.worktrees/7-y` → task 7 is looked up (Review Focus 3).
    - Codex `apply_patch` touching `docs/a.md` only → allowed without a tracker call.
    - Shell `gh pr merge 1 --admin` → deny, with no tracker call.
    - **fails open** (Review Focus 2), each giving exit 0, stdout `''` (`{}` for Gemini) and exactly one stderr line starting `sdlc: hook skipped:`:
      - stdin `not json`;
      - `loadConfig` returns undefined;
      - `getTask` throws `GhError`: this one instead gives a warning outcome `could not read task #5; edit allowed` and no block;
      - `getTask` never resolves with `deadlineMs: 50`: allowed, with the warning.
- [ ] **Step 2: Run** `npx vitest run tests/hooks tests/commands/hook.test.ts` and expect FAIL.
- [ ] **Step 3: Implement**
  - `runHook` reads stdin, normalizes it, finds the repo root with `checkoutOf(event.cwd)`, loads the config, and dispatches on the event (session-start and prompt return an empty outcome until Task 5).
  - Pre-tool:
    - shell → `shellViolations`;
    - subagent → `subagentViolation`;
    - edit → one `checkoutOf` per distinct parent directory, then `inProject = checkout.commonDir === root commonDir`, then a cache-or-`getTask` lookup under one shared deadline (default 8000 ms).
  - Then `decide`; append every violation to the gaps log; print `renderOutput`.
  - Wrap everything in one try/catch that implements the fail-open constraint.
  - `cli.ts` builds the real context: `process.cwd()`, `readAllStdin` from githook.ts, and a lazy tracker like `makeGitHookContext`.
- [ ] **Step 4: Run** the tests again and expect PASS. Then run `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hooks): sdlc hook pre-tool gate with fail-open protocol output`

---

### Task 5: Session start context, prompt record, prompt approvals

**Files:**
- Create: `src/hooks/session.ts`
- Modify: `src/commands/hook.ts`, `src/commands/approve.ts` (extract the apply step), `src/core/approvals.ts` (prompt refs in `recordedRefs` if not already covered)
- Test: `tests/hooks/session.test.ts`, `tests/commands/hook.test.ts`, `tests/commands/taskFlow.test.ts` (approve still passes)

**Interfaces:**
- Consumes: `describeCheckout(state)` (githook.ts), `reconcile(ctx, {dryRun:true, issue})`, `parseOwnerCommand`, `approvalEvent`, `assertApprovalFits`, `recordedRefs`, `isOwner`, `localLog` (Task 4).
- Produces:
  - `approve.ts` exports `applyApproval(ctx: CommandContext, issue: number, input: { action: ApprovalAction; phase?: Phase; reason?: string }, approval: Approval): Promise<TaskState>`, which `approve` itself now uses.
  - `session.ts`:
    - `sessionContext(input: { cfg: Config; branch?: string; task?: TrackedTask; pending: number; queued: { outbox: number; gaps: number } }): string[]`;
    - `promptRef(harness, sessionId: string | undefined, prompt: string): string` = `prompt:<harness>:<sessionId ?? 'nosession'>:<first 16 hex of sha256(prompt)>`;
    - `promptApprover(cfg: Config, login: string | undefined): { by: string } | { refused: string }`.

- [ ] **Step 1: Write the failing tests**
  - `sessionContext` lines (exact):
    - with a task: `sdlc: mode <mode>. Task #<n> "<title>": <describeCheckout(state)>. Next step: <nextStep>.`, plus `Pending reconcile for #<n>: <k> action(s); run \`sdlc reconcile\`.` when `pending > 0`, plus `Queued for sync: <o> write(s), <g> gap(s); \`sdlc sync\` is running in the background.` when either is > 0;
    - without a task: `` sdlc: mode <mode>. No task on branch <branch>. New work starts with `sdlc task new`; status questions use `sdlc status`. ``
  - `promptApprover`:
    - login in owners gives that login;
    - login undefined with one owner gives that owner;
    - a login in `agents` with one owner gives the owner (the human at the keyboard is the owner);
    - a non-owner login with two owners gives `{refused: 'prompt approval not recorded: <login> is not an owner and several owners are configured; approve by comment'}`.
  - `hook.test.ts`:
    - session-start on `task/5-x` prints the context JSON with the task line;
    - session-start calls `spawnSync` only when `gaps.jsonl` or `outbox.jsonl` is non-empty;
    - prompt `please continue` appends `{at, harness, sessionId, promptId, issue:5, sha256}` to `prompts.jsonl` (no text field: assert the keys);
    - prompt `/approve\nlooks good` with #5's plan published and unapproved records `stages.planning.approval` with `source:'prompt'`, `ref` = `promptRef(...)`, and context line `sdlc: recorded the owner's approve for #5 (planning) from this prompt.`;
    - the same prompt again gives context `sdlc: this approval was already recorded for #5.` and no second write (Review Focus 5);
    - `/approve` on `main` with no task gives context `sdlc: no task on this branch; the approval was not recorded.`;
    - `/merge` is ignored;
    - `/cancel` without a reason gives the refusal text from `parseOwnerCommand`.
- [ ] **Step 2: Run** them and expect FAIL.
- [ ] **Step 3: Implement**
  - Prompt approval: `parseOwnerCommand(prompt)`; action ∈ `APPROVAL_ACTIONS`; resolve the task from `cwd`; `promptApprover`. A ref already in `recordedRefs(state)` gives "already recorded". Otherwise `applyApproval` with `Approval{source:'prompt', ref, by, at: ctx.now()}`.
  - An approval error message becomes a context line `sdlc: approval not recorded: <message>`.
  - The tracker calls share the deadline. A timeout gives context `sdlc: could not reach GitHub; approval not recorded, ask again or approve by comment`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat(hooks): session context, prompt record and owner prompt approvals`

---

### Task 6: Owned array items in JSON merges

**Files:**
- Modify: `src/render/changes.ts`, `src/install/merge.ts`, `src/install/apply.ts`, `src/install/manifest.ts` (only if the entry hash needs a helper), `src/render/plan.ts` (`mergeChanges` keeps entries with `items`)
- Test: `tests/install/merge.test.ts`, `tests/install/apply.test.ts`

**Interfaces:**
- Produces: `JsonKeysChange.entries[]` gains `items?: { marker: string }`. When it is set, `value` is an array whose elements are owned items.
  - **Merge:** the existing value at `pointer` must be absent or an array, otherwise `MergeError` `expected an array at <pointer joined by />`. Existing elements whose `JSON.stringify` contains `marker` are removed; `value` items are appended in order; parents are created as for plain entries.
  - **Owned-items hash:** the manifest entry for an items entry stores `hashText(canonicalJson(ownedItemsOnDisk))`. An on-disk owned-items hash that differs from the manifest's means "modified locally; kept".
  - **`removeJsonKeys`** on an items entry removes the marker elements. If the array is then empty and the manifest records that we created it, the key is removed too, and empty created parents are removed as for plain entries.

- [ ] **Step 1: Write the failing tests**
  - `keeps user items in an owned array`: existing `{"permissions":{"allow":["Bash(ls)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./mine.sh"}]}]}}` plus our items entry → user item first, ours appended, `permissions` byte-identical, key order and indent kept.
  - Re-apply with the same items is a no-op (`up to date`).
  - A changed item replaces ours only, in place of the old one at the end.
  - Uninstall leaves exactly the user item, and removes `hooks.SessionStart` that we created.
  - A user edit inside our item (marker still present) gives the notice `modified locally; kept (rerun with --overwrite-modified to replace)`.
  - `hooks.PreToolUse` set to an object gives `MergeError`.
  - `mergeChanges` fuses a Gemini `mcpServers/<id>` plain entry and a `hooks/BeforeTool` items entry for `.gemini/settings.json` into one change.
- [ ] **Step 2: Run** `npx vitest run tests/install` and expect FAIL.
- [ ] **Step 3: Implement** it in `mergeJsonKeys`/`removeJsonKeys`, reusing `jsonValueAt`, `canonicalJson` and the existing formatting preservation.
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat(install): owned array items in JSON merges`

---

### Task 7: Render harness hooks and the launcher

**Files:**
- Create: `src/render/hooks.ts`, `templates/hooks/run.sh`
- Modify: `src/render/plan.ts` (per-harness `renderHooks`; launcher once when any hook harness is configured; `notes`)
- Test: `tests/render/hooks.test.ts`, goldens `tests/golden/hooks/{claude,codex,gemini,all}/`, `tests/commands/install.test.ts`

**Interfaces:**
- Consumes: the items entries (Task 6).
- Produces:
  - `HOOK_LAUNCHER = '.sdlc/hooks/run.sh'`;
  - `HOOK_MARKER = HOOK_LAUNCHER`;
  - `HOOK_TIMEOUT_S = { 'session-start': 30, prompt: 30, 'pre-tool': 15 }`;
  - `hookCommand(harness, event): string` = `"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" <harness> <event>`;
  - `renderHooks(cfg: Config, harness: Harness): Change[]` (`[]` for `agents-md`);
  - `renderHookLauncher(cfg: Config): Change[]` (mode 0755).

- [ ] **Step 1: Write the failing tests**
  - Claude: `.claude/settings.json` json-keys items entries:
    - `hooks/SessionStart` = `[{hooks:[{type:'command',command:hookCommand('claude','session-start'),timeout:30}]}]`;
    - `hooks/UserPromptSubmit` (event `prompt`, 30);
    - `hooks/PreToolUse` = `[{matcher:'Write|Edit|NotebookEdit|Bash|PowerShell|Agent|Task',hooks:[{…'pre-tool', timeout:15}]}]`.
  - Codex: `.codex/hooks.json` with the same three events, PreToolUse matcher `^(apply_patch|Edit|Write|Bash|spawn_agent|Agent)$`, timeouts in seconds.
  - Gemini: `.gemini/settings.json` `hooks/SessionStart`, `hooks/BeforeAgent`, `hooks/BeforeTool` (matcher `^(write_file|replace|run_shell_command|invoke_agent)$`). Each handler has `name: 'sdlc-<event>'`. Timeouts are `30000`/`30000`/`15000`.
  - Every item contains `HOOK_MARKER`.
  - Notes (exact):
    - codex: `Codex runs project hooks only in a trusted project after you review them: open codex in this repository, trust it, then run /hooks and approve the sdlc hooks.`
    - gemini: `Gemini CLI loads project hooks only in a trusted folder: run gemini in this repository and trust the folder.`
  - The launcher template follows `templates/githooks/hook.sh`: run `sdlc hook "$@"` when `sdlc` is on PATH, else `npx --no-install sdlc hook "$@"` when that resolves, else print nothing to stdout and `sdlc: hook skipped: sdlc not found` to stderr, and exit 0. It forwards stdin.
  - Goldens via `expectGolden`, plus the test `init merges hooks into customized settings`: a memoryFs with a user `.claude/settings.json` containing `permissions` and a user PreToolUse hook. After `runInit`, both are kept and ours are appended; after `runUninstall`, the file equals the original.
- [ ] **Step 2: Run** `npx vitest run tests/render/hooks.test.ts tests/commands/install.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** Then refresh the goldens with `UPDATE_GOLDEN=1 npx vitest run tests/render` and inspect the diff: only hook files and `_changes.txt` lines change.
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat(render): harness hooks for Claude, Codex and Gemini`

---

### Task 8: `sdlc config set mode`

**Files:**
- Modify: `src/commands/config.ts`
- Create: `src/config/write.ts`
- Test: `tests/config/write.test.ts`, `tests/commands/config.test.ts`

**Interfaces:**
- Produces:
  - `setConfigMode(text: string, mode: 'observe'|'enforce'): { text: string; previous: string | undefined }`, which uses `parseDocument` + `doc.setIn(['mode'], mode)` + `String(doc)` and throws when the result fails `loadConfigFromString`.
  - Subcommand `sdlc config set mode <observe|enforce> [--dry-run]`.
  - `ConfigCommandContext` gains `login(): Promise<string | undefined>` (the real one is `GitHubTracker.authenticatedLogin` on a loaded config).

- [ ] **Step 1: Write the failing tests**
  - `setConfigMode` keeps comments, blank lines and key order (fixture with a `# owner notes` comment above `mode:` and a trailing comment); it adds `mode` when it is missing; it refuses an unknown mode.
  - Command:
    - an owner login writes the file and prints `` mode: observe -> enforce. Run `sdlc upgrade` so the instructions and hooks match. ``;
    - a login in `agents` gives exit 1 `config set must be run by an owner; <login> is listed in agents`;
    - a non-owner gives `config set must be run by an owner (owners: <list>)`;
    - an undefined login gives `cannot confirm the owner's GitHub login; run gh auth login`;
    - `--dry-run` writes nothing;
    - setting the current mode prints `mode is already <mode>` and writes nothing;
    - an unknown key `sdlc config set foo bar` gives exit 1 `only "mode" can be set`.
- [ ] **Step 2: Run** them and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat(config): owner-only sdlc config set mode, comments kept`

---

### Task 9: Outbox and `sdlc sync`

**Files:**
- Create: `src/outbox/outbox.ts`, `src/commands/sync.ts`
- Modify: `src/commands/context.ts` (`runCommand` option, `CommandContext.repoRoot?`), `src/cli.ts` (`deps.argv`, queueable registrations, `registerSyncCommand`), `src/engine/status.ts` + `src/commands/status.ts` (queued counts)
- Test: `tests/outbox/outbox.test.ts`, `tests/commands/sync.test.ts`, `tests/commands/status.test.ts`

**Interfaces:**
- Consumes: `localLog` (Task 4), `gap_recorded` (Task 1), `commit` (context.ts).
- Produces:
  - `OUTBOX_FILE = 'outbox.jsonl'`;
  - `OUTBOX_FAILED_FILE = 'outbox-failed.jsonl'`;
  - `SYNC_LOCK = '.sdlc/cache/sync.lock'`;
  - `EXIT_TEMPFAIL = 75`;
  - `isTransportError(error: unknown): boolean` (a `GhError` whose stderr matches `/could not resolve host|connection (refused|reset)|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|rate limit|HTTP (502|503|504)/i`);
  - `interface OutboxEntry { id: string; at: string; argv: string[] }`;
  - `runCommand(makeContext, opts: { json?: boolean; queueArgv?: string[] }, run, describe)`;
  - `syncAll(ctx: SyncContext, opts: { dryRun?: boolean }): Promise<SyncResult { replayed: number; failed: { argv: string[]; error: string }[]; remaining: number; gapsFlushed: number; gapsDropped: number }>`;
  - `SyncContext { repoRoot; replay(argv): Promise<{ code: number; stderr: string }>; makeCommandContext(): Promise<CommandContext>; now(); out; err }` (the real `replay` spawns `process.execPath dist/cli.js …argv` with env `SDLC_NO_QUEUE=1`).
  - `StatusReport.queued: { outbox: number; gaps: number }`.

- [ ] **Step 1: Write the failing tests**
  - A queueable command whose tracker throws a transport `GhError`:
    - appends `{id, at, argv}`;
    - prints `` queued for `sdlc sync` (GitHub unreachable): sdlc <argv joined> ``;
    - exits 0; `--json` gives `{"queued":true,"id":…}`.
  - With env `SDLC_NO_QUEUE=1` → exit 75 and nothing appended.
  - A non-transport error is not queued.
  - `task new` is never queued.
  - `syncAll`, with entries A, B, C:
    - replay codes 0, 75 → A removed, B and C kept, `remaining: 2`;
    - codes 0, 1, 0 → B moved to `outbox-failed.jsonl` with its last stderr line;
    - gaps for #5 (3 lines) and one without an issue → one `gap_recorded` commit for #5, `gapsFlushed: 3`, `gapsDropped: 1`, `gaps.jsonl` emptied;
    - an existing fresh lock → `sync already running`, exit 0, nothing done; a lock older than 10 minutes is taken over;
    - `--dry-run` lists without changing anything.
  - `status` shows `Queued for sync: 2 write(s), 1 gap(s)` when non-zero; the JSON has `queued`.
- [ ] **Step 2: Run** them and expect FAIL.
- [ ] **Step 3: Implement.** The lock is created with `open(…, 'wx')` and removed in `finally`. Gaps whose state write raises `StateChangedError` are retried once after a re-read.
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat: outbox for offline task commands and sdlc sync`

---

### Task 10: Task worktrees and orphan radar

**Files:**
- Create: `src/git/worktrees.ts`, `src/commands/worktree.ts`
- Modify: `src/engine/status.ts`, `src/commands/status.ts`, `src/cli.ts`
- Test: `tests/git/worktrees.test.ts`, `tests/commands/worktree.test.ts`, `tests/engine/status.test.ts`

**Interfaces:**
- Consumes: `GitRunner`, `createGitRunner`, `taskIssueOf`, `Tracker.getTask`/`listTrackedTasks`.
- Produces:
  - `interface Worktree { path: string; head?: string; branch?: string; detached: boolean; bare: boolean; locked: boolean; prunable: boolean }`;
  - `parseWorktreeList(porcelain: string): Worktree[]`;
  - `listWorktrees(git): Promise<Worktree[]>` (`git worktree list --porcelain`);
  - `taskSlug(title: string): string` (lowercase, runs of non `[a-z0-9]` → `-`, trimmed of `-`, max 40 characters cut at a `-` when possible, `task` when empty);
  - `interface OrphanWorktree { path: string; branch?: string; reason: 'no-task' | 'task-done' | 'detached' | 'prunable' }`;
  - `orphanWorktrees(worktrees: Worktree[], repoRoot: string, tasks: Map<number, { status: Status }>): OrphanWorktree[]` (only paths under `<repoRoot>/.worktrees/`);
  - commands `sdlc worktree start <issue> [--dry-run]` and `sdlc worktree finish <issue> [--dry-run]`;
  - `statusReport(ctx, { staleDays, all?, git?: GitRunner, repoRoot?: string })` adds `orphanWorktrees`.

- [ ] **Step 1: Write the failing tests**
  - `parseWorktreeList` on a porcelain sample with main, a branch worktree, a detached one and a `prunable` one.
  - `taskSlug('Fix: Login – crash on iOS 18!')` = `fix-login-crash-on-ios-18`.
  - `orphanWorktrees`: branch `task/9-x` not in tasks gives `no-task`; status `done` gives `task-done`; detached gives `detached`; outside `.worktrees/` gives nothing.
  - `worktree start 5` (real repo with an `origin` bare remote, FakeTracker #5 titled `Add login`):
    - git calls include `fetch origin main` and `worktree add -b task/5-add-login .worktrees/5-add-login origin/main`;
    - it prints the path;
    - an existing branch or path gives exit 1 `task/5-add-login already exists`.
  - `worktree finish 5`:
    - it refuses while the worktree has changes, listing them;
    - it refuses while #5 has no PR with `mergeSha` and status is not `awaiting_deployment`/`done`: `#5 has no merged PR yet`;
    - otherwise it runs `merge --ff-only origin/main` in the main checkout when that checkout is on `main` and clean (and only reports when it is not), then `worktree remove <path>`, then `branch -d task/5-add-login`;
    - when `branch -d` fails, it prints `` branch task/5-add-login kept: git branch -d refused (squash merge?); check it and delete it yourself `` and exits 0.
  - Every recorded git call is free of `--force`, `-f`, `-D` and `prune`.
  - `status` prints `Orphan worktrees:` with path and reason.
- [ ] **Step 2: Run** them and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat: task worktree start/finish and orphan worktrees in status`

---

### Task 11: Doctor: stack, MCP per harness, hooks round trip; init stack commands

**Files:**
- Modify: `src/install/doctor.ts`, `src/render/plan.ts` (stack `userCommands`), `src/commands/init.ts` if printing needs it
- Create: `src/install/stack.ts`
- Test: `tests/install/doctor.test.ts`, `tests/install/stack.test.ts`, `tests/render/plan.test.ts` (or wherever `renderAll` is tested)

**Interfaces:**
- Consumes: `DoctorEnv`, `hookEnvironment`, `renderHooks`/`HOOK_MARKER` (Task 7), `runHook` (Task 4), `readJsonLines` (Task 4), `listWorktrees`/`orphanWorktrees` (Task 10).
- Produces:
  - `stack.ts`: `superpowersInstall(harness): string`:
    - claude `claude plugin install superpowers@claude-plugins-official`;
    - codex `codex plugin add superpowers@openai-curated`;
    - gemini `gemini extensions install https://github.com/obra/superpowers --consent`.
  - `stack.ts`: `graphifyInstall(harnesses): string[]`: `uv tool install graphifyy`, then `graphify install` for claude, `graphify install --platform codex`, `graphify install --platform gemini`.
  - `stack.ts`: `superpowersInstalled(harness, stdout): boolean`:
    - claude JSON array with an `id` starting `superpowers@`;
    - codex JSON with `installed[].name === 'superpowers'`;
    - gemini JSON array with `name === 'superpowers'`.
  - `stack.ts`: `mcpNames(harness, stdout): Set<string>`:
    - claude lines `<id>: …`;
    - codex `--json` array `name`;
    - gemini lines matching `^\s*\S\s+([^:\s]+):`.
  - Doctor check ids: `stack.superpowers`, `stack.graphify`, `mcp.claude`, `mcp.codex`, `mcp.gemini`, `hooks.claude`, `hooks.codex`, `hooks.gemini`, `hooks.roundtrip`, `outbox.pending`, `worktrees.orphans`.

- [ ] **Step 1: Write the failing tests** (extend the `harness()` fake's `exec` for `claude plugin list --json`, `codex plugin list --json`, `gemini extensions list -o json`, `graphify --version`, `codex mcp list --json`, `gemini mcp list`)
  - `stack.superpowers`:
    - ok when every configured harness has it;
    - warn naming the missing harness with fix `superpowersInstall(h)`;
    - a CLI not on PATH gives that harness `not checked (<cli> not on PATH)` and no warn for it;
    - unparsable output gives warn `could not read <cli> plugin list`;
    - skipped (`ok … skipped`) when `stack.superpowers` is false.
  - `stack.graphify`: `graphify 0.9.122` gives ok with the version; a missing binary gives warn with the `graphifyInstall` commands joined by ` && `; skipped when off.
  - `mcp.codex` / `mcp.gemini`: the same contract as the existing `mcp.claude` (missing ids gives warn with a fix). Gemini output `✓ github: https://… (http) - Connected` counts `github`.
  - `hooks.<h>`:
    - ok when the rendered file holds an item with `HOOK_MARKER` for each of the three events and `.sdlc/hooks/run.sh` exists;
    - warn listing missing events, with fix `sdlc upgrade`;
    - codex ok message ends with ` (Codex runs it only after you trust the project and approve it in /hooks)`;
    - gemini on `win32` gives warn `Gemini CLI runs hooks through PowerShell on Windows; sdlc hooks need a POSIX shell`.
  - `hooks.roundtrip`: runs `runHook(h, 'pre-tool')` in process for each hook harness with payload shell `gh pr merge 1 --admin` and a captured `out`. It is ok when the output parses as JSON and is a deny (enforce) or carries the warning (observe). Otherwise it is fail, quoting the output. It is also run once in a test with a deliberately broken renderer (inject `render` override) to prove it fails.
  - `outbox.pending`: warn `<n> queued write(s), <m> failed; run sdlc sync` when non-empty.
  - `worktrees.orphans`: warn listing orphans.
  - `mutations(gh)` stays empty.
  - `renderAll` with `stack.superpowers` and `stack.graphify` on and harnesses claude+gemini puts the install commands in `userCommands`.
- [ ] **Step 2: Run** `npx vitest run tests/install` and expect FAIL.
- [ ] **Step 3: Implement** it, replacing `checkMcpClaude` with `checkMcpHarness(env, cfg, harness)` (same id per harness). Every `exec` uses `hookEnvironment(env)` and `timeoutMs: 15_000`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.
- [ ] **Step 5: Commit** `feat(doctor): stack, per-harness MCP, harness hooks and round trip checks`

---

### Task 12: Deferred minors and rulings file

**Files:**
- Modify: `src/github/githubTracker.ts` (I4), `src/commands/stage.ts` (M7), `templates/mcp/catalog.yaml` + `tests/golden/mcp/**` (pinning)
- Create: `docs/notes/plan-3-rulings.md`
- Test: `tests/github/githubTracker.test.ts` (or the existing writeState test file), `tests/commands/taskFlow.test.ts`, `tests/render/mcp.test.ts`

**Interfaces:**
- Consumes: the existing `writeState(issue, state, expected)` and `ExpectedStateComment`.

- [ ] **Step 1: Write the failing tests**
  - **I4:** `writeState` throws `StateChangedError` when the re-read comment has the same `updatedAt` second but a different body. `ExpectedStateComment` gains `body`, compared after trimming.
  - **M7:** `stage publish` re-run after a failure that happened after its comment was posted (FakeTracker has a newest comment by the tracker login with an identical body and no state change) does not post a second comment and still writes state.
  - **Pinning:** the catalog has no `@latest`. Playwright args are `["@playwright/mcp@<version>"]` and context7 `["-y","@upstash/context7-mcp@<version>"]`, where `<version>` is the exact `npm view <pkg> version` output at implementation time (an exact semver, no range). The test asserts `/@\d+\.\d+\.\d+$/`.
- [ ] **Step 2: Run** them and expect FAIL.
- [ ] **Step 3: Implement** the changes, then refresh the MCP goldens (`UPDATE_GOLDEN=1 npx vitest run tests/render/mcp.test.ts`).
- [ ] **Step 4: Write `docs/notes/plan-3-rulings.md`.** It holds the planning rulings above, verbatim as one bullet each, and the Plan 4 deferrals list. Execution rulings are appended later by the controller.
- [ ] **Step 5: Run** `npm test && npm run typecheck` and expect PASS. Commit `fix: same-second state race, publish retry dedup, pinned MCP packages`.

---

### Task 13: Instructions, docs, threat model, smoke

**Files:**
- Modify: `templates/instructions/block.md`, `templates/skills/sdlc-task-tracking/SKILL.md`, `templates/skills/sdlc-delivery/SKILL.md`, `README.md`, `INSTALL.md`, `tests/golden/instructions/**`, `tests/docs/readme.test.ts`
- Create: `docs/threat-model.md`, `docs/notes/plan-3-smoke.md`

- [ ] **Step 1: Update `block.md`.** Replace the enforce paragraph with (exact):
  `Mode: **enforce**. The git hooks block commits to \`{{defaultBranch}}\` and pushes of \`task/*\` branches without a tracked task. Harness hooks block file edits before the plan is approved (docs, debugging repro and task types without a planning phase excepted), subagents without a role and model tier, \`gh pr merge --admin\`, other AI CLIs and \`sdlc config set\`, and \`sdlc\` refuses steps the rules do not allow. Fix the cause of a block; never work around it.`

  Replace the observe paragraph with:
  `Mode: **observe**. The harness hooks warn you and record gaps on the task instead of blocking. Follow every rule here anyway.`

  Under approvals, add one line: `The owner may approve by typing the command (for example \`/approve\`) as the first line of a prompt; the hook records it. Never type or post an owner command yourself.`

  In Worktrees, name `sdlc worktree start <issue>` and `sdlc worktree finish <issue>`. Name `sdlc sync` for `queued for sync` messages.
- [ ] **Step 2: Update the skills.** `sdlc-task-tracking` covers prompt approvals, gaps, and `sync`. `sdlc-delivery` covers `worktree finish`.
- [ ] **Step 3: Refresh the instruction goldens** (`UPDATE_GOLDEN=1 npx vitest run tests/render/instructions.test.ts`). The block-length test still passes.
- [ ] **Step 4: Update README and INSTALL.**
  - README line 5 becomes `Status: core CLI, installer and harness hooks available; npm package next`. The command list adds `hook`, `sync`, `config set mode`, `worktree start|finish`.
  - INSTALL.md:
    - harness trust steps per harness (Claude workspace trust; Codex trusted project + `/hooks` review; Gemini trusted folder, `--skip-trust`/`GEMINI_CLI_TRUST_WORKSPACE=true` for headless);
    - the Superpowers/graphify commands, including Codex's `/plugins` TUI route;
    - prompt approvals for a same-login owner (replacing the "Plan 3" wording);
    - `sdlc config set mode enforce`;
    - offline behaviour and `sdlc sync`;
    - the manual check: "start your harness in the repo, ask it to run `gh pr merge 1 --admin` in enforce mode, and see it refused".

  `tests/docs/readme.test.ts` asserts every registered command appears in README.
- [ ] **Step 5: Write `docs/threat-model.md`.** Headings:
  - Assets;
  - Actors (owner; agent under the owner's login; agent under its own login listed in `agents`; other contributors);
  - Layers and what each guarantees (instructions, harness hooks, git hooks, secret guard, branch protection, approvals by comment/prompt);
  - Known bypasses. These are stated plainly:
    - shell-driven edits;
    - obfuscated commands;
    - harness hooks untrusted or disabled;
    - an agent with a shell can edit `.sdlc/cache` and the config file;
    - Gemini cannot tell subagent calls apart;
    - Codex hooks are "a guardrail, not a complete enforcement boundary";
    - fail-open on errors;
  - Recommendations (separate agent account, branch protection, enforce mode).
- [ ] **Step 6: Smoke** (controller runs this after review, no GitHub writes). `npm run build`; in a temp git repo with an enforce config, feed each fixture from `tests/fixtures/hooks/` to `node dist/cli.js hook <harness> pre-tool`. Record each stdout and exit code in `docs/notes/plan-3-smoke.md` and check: deny for `--admin` and AI CLI payloads, `''`/`{}` for allowed ones, exit 0 everywhere.
- [ ] **Step 7: Run** `npm test && npm run typecheck && npm run build` and expect PASS. Commit `docs: harness hooks, prompt approvals, worktrees, threat model`.
