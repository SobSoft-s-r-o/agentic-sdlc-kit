# Plan 3 smoke: harness hooks

Status: run 2026-11-28 against dist built from aeedc6e: all rows pass. The controller ran it after the Task 13 review. It writes nothing to GitHub: every call below is a local `node dist/cli.js hook ...` run against a throwaway git repository.

## Setup

1. `npm run build` in the plan-3 worktree, so that `dist/cli.js` is current.
2. A temporary directory, outside the repository, made into a git repository on the branch `main` (no task branch, no remote needed). Put a one-line `README.md` and a `src/a.ts` in it, and commit them.
3. In it, `sdlc.config.yaml` with `mode: enforce`, `harnesses: [claude, codex, gemini]`, `owners: [owner-login]`, `github.repo: owner/name`, `github.default_branch: main` and one task type (`tooling`; a type with no deploy end, see Findings (a)). The hook never calls GitHub for these payloads: a branch without a task number needs no lookup, and the shell rules read only the command text.
4. For each fixture of `tests/fixtures/hooks/`, rewrite `cwd` (and any absolute path under `/work/proj`) to the temporary directory, then feed it on stdin:

   ```sh
   node <worktree>/dist/cli.js hook <harness> <event> < payload.json
   ```

   Capture stdout and the exit code separately, and keep stderr.

For the shell rows, copy the Bash fixture of the harness (`claude-pretool-bash.json`, `codex-pretool-bash.json`, `gemini-pretool-shell.json`) and replace `tool_input.command`.

## What to check

- **Refused** means stdout is one JSON object: for Claude Code and Codex `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`, for Gemini `{"decision":"deny","reason":"..."}`. The reason names the rule.
- **Allowed** means stdout is empty for Claude Code and Codex, and `{}` for Gemini.
- **Exit code is 0 in every row.** A block is JSON on stdout, never an exit code.
- Nothing is written outside the temporary directory. `.sdlc/cache/gaps.jsonl` in it gains one line per violation (`blocked: true` in `enforce`), and a later background sync drops those lines, because a gap with no task cannot be recorded (see Findings (b)); no other file is expected there.

## Results: pre-tool, shell payloads

The expected column is the criterion; the last three are filled in by the run. Stdout is shortened to the decision and the start of the rule message (`empty` is an empty stdout).

| Harness | Command | Expected | Stdout | Exit | Verdict |
|---|---|---|---|---|---|
| claude | `npm test` (the fixture as it is) | allowed | empty | 0 | pass |
| claude | `gh pr merge 1 --admin` | refused (`admin-merge`) | deny: `gh pr merge --admin` bypasses checks and reviews | 0 | pass |
| claude | `claude -p "x"` | refused (`ai-cli`) | deny: launching another AI CLI (claude) is not allowed | 0 | pass |
| claude | `claude --version` | allowed | empty | 0 | pass |
| claude | `git push --force origin main` | refused (`force-push`) | deny: force-pushing is not allowed | 0 | pass |
| claude | `sdlc config set mode observe` | refused (`mode-change`) | deny: only the owner changes sdlc settings | 0 | pass |
| claude | `sdlc hook claude prompt` | refused (`hook-spoof`) | deny: sdlc hooks are run by the harness only | 0 | pass |
| codex | `npm test` (the fixture as it is) | allowed | empty | 0 | pass |
| codex | `gh pr merge 1 --admin` | refused (`admin-merge`) | deny: `gh pr merge --admin` bypasses checks and reviews | 0 | pass |
| codex | `codex exec "x"` | refused (`ai-cli`) | deny: launching another AI CLI (codex) is not allowed | 0 | pass |
| codex | `git status` | allowed | empty | 0 | pass |
| gemini | `npm test` (the fixture as it is) | allowed | `{}` | 0 | pass |
| gemini | `gh pr merge 1 --admin` | refused (`admin-merge`) | deny: `gh pr merge --admin` bypasses checks and reviews | 0 | pass |
| gemini | `gemini -p "x"` | refused (`ai-cli`) | deny: launching another AI CLI (gemini) is not allowed | 0 | pass |
| gemini | `git status` | allowed | `{}` | 0 | pass |

## Results: pre-tool, fixtures as they are (paths rewritten)

Edits of a code file on `main` with no task are refused in `enforce` (`no-task`); a read, and a subagent dispatch that names an `sdlc-<role>` agent and a model, are allowed. A Codex `spawn_agent` or a Gemini `invoke_agent` without a role and model tier is refused (`subagent-tier`; Gemini has no model to read).

| Fixture | Expected | Stdout | Exit | Verdict |
|---|---|---|---|---|
| `claude-pretool-write.json` | refused (`no-task`) | deny: editing src/a.ts outside a task | 0 | pass |
| `claude-pretool-notebook.json` | refused (`no-task`) | deny: editing analysis/model.ipynb outside a task | 0 | pass |
| `claude-pretool-read.json` | allowed | empty | 0 | pass |
| `claude-pretool-agent.json` | allowed | empty | 0 | pass |
| `claude-pretool-in-subagent.json` | refused (`no-task`) | deny: editing src/b.ts outside a task | 0 | pass |
| `codex-pretool-apply-patch.json` | refused (`no-task`) | deny: editing hello.txt outside a task | 0 | pass |
| `codex-pretool-spawn-agent.json` | refused (`subagent-tier`) | deny: subagent explorer needs a model tier | 0 | pass |
| `codex-pretool-in-subagent.json` (`ls`) | allowed | empty | 0 | pass |
| `gemini-pretool-write.json` | refused (`no-task`) | deny: editing src/a.ts outside a task | 0 | pass |
| `gemini-pretool-replace.json` | refused (`no-task`) | deny: editing src/c.ts outside a task | 0 | pass |
| `gemini-pretool-agent.json` | refused (`subagent-tier`) | deny: subagent codebase_investigator needs a model tier | 0 | pass |

## Results: prompt and session start

Neither event blocks. A prompt that is not an owner command and a session start on a branch without a task print nothing for Claude Code and Codex, and `{}` for Gemini, or one `additionalContext` object that says which task the branch has (none).

| Fixture | Expected | Stdout | Exit | Verdict |
|---|---|---|---|---|
| `claude-session-start.json` | context or empty, never a block | context: `sdlc: mode enforce. No task on branch main.` | 0 | pass |
| `claude-prompt.json` | empty | empty | 0 | pass |
| `codex-session-start.json` | context or empty, never a block | context: `sdlc: mode enforce. No task on branch main.` | 0 | pass |
| `codex-prompt.json` | empty | empty | 0 | pass |
| `gemini-session-start.json` | context or `{}`, never a block | context: `sdlc: mode enforce. No task on branch main.` | 0 | pass |
| `gemini-prompt.json` | `{}` | `{}` | 0 | pass |

## Also check (optional, local only)

| Check | Expected | Observed |
|---|---|---|
| Copy `templates/hooks/run.sh` to `.sdlc/hooks/run.sh` of the temporary repository (`chmod +x`) and run it as `.sdlc/hooks/run.sh claude pre-tool` with a refused payload and a `sdlc` shim for `dist/cli.js` on the PATH | the same JSON as above, exit 0 | The same deny JSON, exit 0. Pass. |
| The same with no `sdlc` on the PATH and no `npx` project install | empty stdout, stderr `sdlc: hook skipped: sdlc not found`, exit 0 | Empty stdout, stderr `sdlc: hook skipped: sdlc not found`, exit 0. Pass. |
| The same for `gemini` with no `sdlc` | stdout `{}`, the same stderr line, exit 0 | Stdout `{}`, the same stderr line, exit 0. Pass. |

## Findings

Both are about the setup, not about the hooks; no row failed.

- (a) The smoke config needed task types with no deploy end. With the full type list of the fixture config, every hook skipped with "Invalid config" and let the call through: the documented fail-open behaviour (threat model, "Hooks fail open by design"). A broken `sdlc.config.yaml` therefore switches the hooks off without a block.
- (b) Gaps of calls with no task are logged, then dropped by the background sync (`Dropped 19 gap(s) that could not be recorded` in `sync.log`), with no GitHub call, because a gap belongs to a task. Every violation in this run was on `main`, which has no task. The threat model ("Gaps reach GitHub late and in part") and INSTALL.md ("Offline") say so.
