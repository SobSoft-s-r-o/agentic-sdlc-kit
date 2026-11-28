# Plan 3 rulings

Decisions taken while planning Plan 3 (harness hooks), then those taken during its execution. Each binds the code on this branch; the spec remains the authority where a ruling is silent.

## Rulings made while planning

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

## Deferred to Plan 4

- M6 (doctor already has a `labels` check, so only re-verify)
- M8
- M10
- M11 (package `files`, packaging)
- I1 PR re-point
- the `--unverified` local clock
- fake trust with an undefined login
- the three Plan 2 residual minors the owner accepted as-is

## Execution rulings
