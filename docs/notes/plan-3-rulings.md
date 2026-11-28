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

- hooks.roundtrip gets an optional DoctorEnv seam (`hookRunner?`) defaulting to the real runHook; the broken-renderer test injects a runner whose output is not a deny — plan says "inject render override" without a name — cost: none beyond naming.
- a failed/timed-out task lookup is handled degradation (warning output, allow), not a hook error; the "stdout empty + skip line" rule applies only to thrown errors — matches plan Task 4 bullet text — cost: Gemini/Claude show a warning instead of silence.
- protected-path is enforce-only as Task 3 states (planning ruling "In enforce mode, agents may not edit…") — global observe rule applies to rules that exist in observe — cost: observe agents can edit config unwarned.
- subagent commits keep their own model's Co-Authored-By trailer (Sonnet 5.5) — accurate attribution of the authoring model — cost: mixed trailers in history
- fix in Task 9 (gap flush owner): gap_recorded leaves updatedAt unchanged — cost: one-line change + test update.
- controller did the scoped re-review of the 17-line src fix diff inline — fix is mechanical and fully visible — cost: no independent seat for this round.
- heredoc bodies are data, not scanned; `cat <<EOF | sh` is an accepted gap for the threat model (T13) — avoids false positives in commit/PR bodies that mention forbidden commands — cost: piped-heredoc bypass.
- paths under commonDir are protected-path (enforce) — editing .git/config disables git-hook layer — cost: agents can't touch .git files in enforce.
- local logs (gaps/prompts/task cache) live under the main checkout via mainRootOf — worktree removal would lose them — cost: none.
- damaged state comment = lookup failed (allow+warn) — consistent fail-open degradation — cost: corrupted state doesn't gate edits.
- prompt ref = prompt:<harness>:<session>:<promptId | action-phase>:<sha16> (overrides plan format) — text-only ref refused every later /approve in one session — cost: Gemini re-delivered old prompt could approve a later stage only via replayed hook (hook-spoof/threat model).
- JSON merges splice into original text (new src/install/jsonText.ts) instead of re-serializing — whole-file JSON.stringify reflowed hand-written settings and lost big-int precision, conflicting with "never clobber user content" — cost: extra scanner code; comments in JSON still refused.
- implementer-common trailer = authoring model (aligned with earlier ledger ruling) — removes repeated concern — cost: none.
- launcher prints {} for gemini on skip — global constraint overrides brief "nothing on stdout" — cost: none.
- launcher passes partial stdout through when sdlc exits non-zero — keeps a complete deny JSON printed before a crash (fail-closed for blocks) — cost: rare garbage context line on SessionStart/prompt.
- config set writes with node:fs like `suggest --write` (not RepoFs) — --config may point outside repo — cost: none.
- sync replay allowlists the 6 queueable commands and rejects --config/--verify/--json/--dry-run; runs with --config are not queued — forged outbox lines (shell redirect) would otherwise run config set / deploy --verify outside hook control — cost: offline runs with a custom --config fail instead of queueing.
- malformed outbox lines count as failed in sync (exit 1); not counted in status/session-start — surfaces corruption — cost: none.
- finish refuses when ignored .env/.env.* files exist in the worktree (other ignored files don't block) — local secrets would be silently deleted — cost: one extra manual step for users with local .env.
- mcp list calls get 60 s (MCP_LIST_TIMEOUT_MS), run concurrently; other CLIs 15 s — brief's 15 s false-warned (claude mcp list measured 22 s) and regressed the old 120 s default — cost: doctor up to ~60 s slower worst case.
- outbox.pending warns only for queued/failed writes; gaps are an ok-suffix — observe mode produces gaps routinely — cost: none.
- Plan 2 plan doc keeps historical `@latest` text — plans are records, not shipped content — cost: a grep hit in docs/superpowers/plans.
- final fix wave adds harness hook files (.claude/settings.json, .claude/settings.local.json, .codex/hooks.json, .gemini/settings.json) to isProtectedPath — an agent in an approved task could otherwise edit the hooks out (T13 threat-model bypass 9) — cost: owner edits those files by hand in enforce; threat model bypass 9 rewritten after.
- INSTALL manual hook check uses `npx --no-install sdlc config set mode observe --dry-run` (refused as mode-change) instead of `gh pr merge 1 --admin` — the old check performs a real admin merge exactly when hooks are off — cost: deviates from plan's literal text.
- final-wave protected paths also include .codex/config.toml (can set features.hooks=false).
- fix wave does I1, I2(+M6, .mcp.json, ~/.claude.json), I4 (fallback to CLAUDE_PROJECT_DIR/GEMINI_PROJECT_DIR + per-file checkout), I5, I3 as hint+docs only, M1–M3, M5, M8 and the triage "fix now" rows — each is a cheap hook-off route or a doc inaccuracy — cost: larger wave, one re-review.
- Plan 4 gets live per-harness smoke (M4, M9), reading mode from main checkout, gh api merge rule, and the remaining parked minors — need live harnesses or are cosmetic — cost: those gaps stay documented-not-closed in v0.2.
- `sdlc upgrade` stays allowed for agents — it only reinstalls hooks — cost: agent can rewrite hook items to the rendered ones (no weakening).

## Deferred to Plan 4 during execution

- Live smoke run per harness: a typed `/approve` reaching the prompt hook in Codex and Gemini, a write after `cd` outside the repo, Claude's `Monitor` matcher coverage, and the exact INSTALL manual-check command.
- Read `mode` (and ideally the whole config) from the main checkout's `sdlc.config.yaml`, so worktrees follow a mode change without a commit.
- A shell rule for merging through `gh api ... /merge`, and for plain `node .../cli.js` forms of owner-only commands.
- `RENDERED_SHAPE` accepts any quoted path ending in `/.sdlc/hooks/run.sh`; doctor's git-call budget comment; a shared checkout cache in the hook.
- doctor: the Codex inline-table switch (`features = { hooks = false }`); split `doctor.ts`.
- Sync lock: stale-lock takeover by atomic rename; the orphan lock after a failed read-back.
- Cosmetics: appended JSON items always multi-line; the `.env/` directory wording in `worktree finish`; surfacing a publish dedup hit; a test where `authenticatedLogin` throws in the dedup.
- A timeout for the `gh` runner; the intermittently slow secret-scan test.
