# Plan 3 smoke: harness hooks

Status: procedure written, results not yet recorded. The controller runs this after the Task 13 review. It writes nothing to GitHub: every call below is a local `node dist/cli.js hook ...` run against a throwaway git repository.

## Setup

1. `npm run build` in the plan-3 worktree, so that `dist/cli.js` is current.
2. A temporary directory, outside the repository, made into a git repository on the branch `main` (no task branch, no remote needed). Put a one-line `README.md` and a `src/a.ts` in it, and commit them.
3. In it, `sdlc.config.yaml` with `mode: enforce`, `harnesses: [claude, codex, gemini]`, `owners: [owner-login]`, `github.repo: owner/name`, `github.default_branch: main` and one task type (`tooling`). The hook never calls GitHub for these payloads: a branch without a task number needs no lookup, and the shell rules read only the command text.
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
- Nothing is written outside the temporary directory. `.sdlc/cache/gaps.jsonl` in it gains one line per violation (`blocked: true` in `enforce`); no other file is expected there.

## Results: pre-tool, shell payloads

The expected column is the criterion; the last three are filled in by the run.

| Harness | Command | Expected | Stdout | Exit | Verdict |
|---|---|---|---|---|---|
| claude | `npm test` (the fixture as it is) | allowed | | | |
| claude | `gh pr merge 1 --admin` | refused (`admin-merge`) | | | |
| claude | `claude -p "x"` | refused (`ai-cli`) | | | |
| claude | `claude --version` | allowed | | | |
| claude | `git push --force origin main` | refused (`force-push`) | | | |
| claude | `sdlc config set mode observe` | refused (`mode-change`) | | | |
| claude | `sdlc hook claude prompt` | refused (`hook-spoof`) | | | |
| codex | `npm test` (the fixture as it is) | allowed | | | |
| codex | `gh pr merge 1 --admin` | refused (`admin-merge`) | | | |
| codex | `codex exec "x"` | refused (`ai-cli`) | | | |
| codex | `git status` | allowed | | | |
| gemini | `npm test` (the fixture as it is) | allowed | | | |
| gemini | `gh pr merge 1 --admin` | refused (`admin-merge`) | | | |
| gemini | `gemini -p "x"` | refused (`ai-cli`) | | | |
| gemini | `git status` | allowed | | | |

## Results: pre-tool, fixtures as they are (paths rewritten)

Edits of a code file on `main` with no task are refused in `enforce` (`no-task`); a read, and a subagent dispatch that names an `sdlc-<role>` agent and a model, are allowed. A Codex `spawn_agent` or a Gemini `invoke_agent` without a role and model tier is refused (`subagent-tier`; Gemini has no model to read).

| Fixture | Expected | Stdout | Exit | Verdict |
|---|---|---|---|---|
| `claude-pretool-write.json` | refused (`no-task`) | | | |
| `claude-pretool-notebook.json` | refused (`no-task`) | | | |
| `claude-pretool-read.json` | allowed | | | |
| `claude-pretool-agent.json` | allowed | | | |
| `claude-pretool-in-subagent.json` | refused (`no-task`) | | | |
| `codex-pretool-apply-patch.json` | refused (`no-task`) | | | |
| `codex-pretool-spawn-agent.json` | refused (`subagent-tier`) | | | |
| `codex-pretool-in-subagent.json` (`ls`) | allowed | | | |
| `gemini-pretool-write.json` | refused (`no-task`) | | | |
| `gemini-pretool-replace.json` | refused (`no-task`) | | | |
| `gemini-pretool-agent.json` | refused (`subagent-tier`) | | | |

## Results: prompt and session start

Neither event blocks. A prompt that is not an owner command and a session start on a branch without a task print nothing for Claude Code and Codex, and `{}` for Gemini, or one `additionalContext` object that says which task the branch has (none).

| Fixture | Expected | Stdout | Exit | Verdict |
|---|---|---|---|---|
| `claude-session-start.json` | context or empty, never a block | | | |
| `claude-prompt.json` | empty | | | |
| `codex-session-start.json` | context or empty, never a block | | | |
| `codex-prompt.json` | empty | | | |
| `gemini-session-start.json` | context or `{}`, never a block | | | |
| `gemini-prompt.json` | `{}` | | | |

## Also check (optional, local only)

| Check | Expected | Observed |
|---|---|---|
| Copy `templates/hooks/run.sh` to `.sdlc/hooks/run.sh` of the temporary repository (`chmod +x`) and run it as `.sdlc/hooks/run.sh claude pre-tool` with a refused payload and a `sdlc` shim for `dist/cli.js` on the PATH | the same JSON as above, exit 0 | |
| The same with no `sdlc` on the PATH and no `npx` project install | empty stdout, stderr `sdlc: hook skipped: sdlc not found`, exit 0 | |
| The same for `gemini` with no `sdlc` | stdout `{}`, the same stderr line, exit 0 | |

## Findings

None recorded yet.
