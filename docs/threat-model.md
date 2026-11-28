# Threat model

This document says what the safeguards of agentic-sdlc-kit are meant to stop, what each one really guarantees, and what an agent that wants to get around them can still do. It is for owners who decide how far to trust a setup, and for contributors who change the rules. Read it together with INSTALL.md ("Harness hooks and trust", "Owner, agents and tokens", "Secret guard").

In one sentence: **the kit is a set of guardrails and an audit trail for agents that mostly follow their instructions. It is not a sandbox.** An agent that can run shell commands as you can undo most of what the hooks do. What holds against it is review of the pull request, branch protection that binds the agent's account, and a separate agent account. The hooks are what makes the honest path easy and the shortcuts visible.

## Scope

The kit defends against:

- an agent that cuts a corner by mistake: editing code before the plan is approved, committing to the default branch, skipping a hook, merging with admin rights, starting another AI tool, committing a secret;
- an agent that is steered into one of those by text it reads (an issue, a web page, a file), through the obvious route;
- loss of the state of a task when GitHub or the network is down.

It does not defend against:

- a determined attacker, or an agent acting like one, with code execution on the machine and the owner's credentials;
- a stolen or over-privileged GitHub token, or a compromised GitHub account;
- vulnerabilities in the harnesses (Claude Code, Codex, Gemini CLI), or in `git`, `gh` and Node;
- a compromised dependency of the kit itself.

## Assets

1. **The default branch**, and whatever is released or deployed from it.
2. **Secrets**: tokens, keys and the contents of `.env` files, in the working tree, in git history and on the remote.
3. **The owner's decisions**: approvals, acceptances, cancellations, confirmations that a production-data script was run, merges. The point of the kit is that these are given by the owner, and that the record says so.
4. **The task record**: the issue, its hidden state comment, the board, the evidence and the gaps.
5. **The rules themselves**: `sdlc.config.yaml`, `.sdlc/` (the git hooks, the hook launcher, the manifest), the harness settings files, the instruction files and the agent roles.
6. **The owner's credentials**: the `gh` login, `GITHUB_PERSONAL_ACCESS_TOKEN`, the `SDLC_TOKEN` secret and the OS keystore. The kit never writes them into the repository, but every command an agent runs in a shell has whatever the shell has.
7. **Production systems and data** that a task may touch.

## Actors

- **The owner.** Decides, and is trusted. Their GitHub login is listed under `owners`.
- **An agent under the owner's login.** The agent runs `gh` as the owner. Everything the owner's token can do, the agent's shell can do. The tool cannot tell a comment written by the owner from one written by the agent, so in `enforce` mode comment approvals are refused and the owner approves by typing the command in a prompt (see "Approvals").
- **An agent under its own login**, listed under `agents`. This is the recommended setup. Its comments never count as owner approvals, and its token can be given fewer rights (no admin rights, no right to merge into the default branch if the plan allows), so that branch protection binds it.
- **Other contributors.** People with write access who use plain git, and people who open pull requests from forks. The harness hooks do not run for them, and the git hooks run only in a clone that has set `core.hooksPath`. Branch protection and review are what bind them. Only state comments written by a login under `owners` or `agents` are read as task state. The reconcile workflow skips Dependabot runs and installs the kit in a step that has no token.

An agent that is manipulated by hostile text is treated as an agent under whichever login it runs as.

## Layers and what each guarantees

| Layer | What it is | What it guarantees | What it does not guarantee |
|---|---|---|---|
| Instructions | the managed block in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, the skills and the agent roles | nothing by itself: they tell the agent the rules | that the agent reads, remembers or follows them |
| Harness hooks | `sdlc hook` run by Claude Code, Codex and Gemini CLI at session start, on each prompt and before each tool call | while they run and the call goes through the paths they read: in `enforce` a matching call is refused before it runs; in `observe` it is allowed, with a warning; either way a gap is recorded on the task | that they run at all; that a call is seen; that shell commands and shell edits are read through |
| Git hooks | `.sdlc/githooks`: `pre-commit`, `pre-push`, `post-merge`, `post-checkout` | in a clone that has set `core.hooksPath` and can resolve `sdlc`: the secret guard on commit and push, and in `enforce` the branch rules | anything when `--no-verify`, a changed hooks path or a missing `sdlc` is in play |
| Secret guard | the scan in `pre-commit` and `pre-push` (built-in patterns, and gitleaks if installed) | a known secret shape in a staged or pushed change is refused, in both modes; it fails closed, so a guard that cannot scan blocks; only a masked value and a fingerprint are printed | secrets in a shape no pattern knows, split or encoded secrets, or a commit made with the hooks off |
| Branch protection | classic protection on the default branch, set by `init` when it has none | a pull request is required, and force pushes and deletions are refused, for accounts without admin rights | anything for an admin: the kit sets `enforce_admins: false` and no required reviews, so an account with admin rights can merge or push around it |
| Approvals | an owner's comment, or a command typed in a prompt | a recorded approval came from a comment by an owner login, or from a human prompt that the hook read | a distinction between the owner and an agent that holds the owner's token |

### Instructions

The block, the skills and the roles are read by the agent and nothing else enforces them. Their job is to make the agent do the right thing without being stopped. Instruction files are Markdown, and Markdown needs no task (see "Known bypasses"), so an agent can edit them. `sdlc upgrade` restores the managed block, `doctor` (`files.managed`) reports edited managed files, and the change shows in the pull request.

### Harness hooks

Three events, one program: `sdlc hook <harness> <event>` behind the launcher `.sdlc/hooks/run.sh`.

- **Session start** tells the agent which task its branch has and starts `sdlc sync` in the background if something is queued.
- **Prompt** reads the first non-empty line of a human prompt for an owner command and records it (see "Approvals"). Prompts of subagents are ignored where the harness marks them.
- **Pre-tool** checks the call:
  - file edits: no tracked task for the branch, a plan not yet approved, a finished task, or a protected path (`sdlc.config.yaml`, `.git`, `.sdlc/` except `.sdlc/agents/custom/`; protected paths are refused in `enforce` only);
  - subagent dispatches without a role and a model tier (an `sdlc-<role>` agent counts, and Gemini payloads carry no model, so in `enforce` Gemini built-in agents are refused);
  - shell commands: `gh pr merge --admin`, another AI CLI (`claude`, `codex`, `gemini`, `aider`, `cursor`, `cursor-agent`, `ollama`, `opencode`, `goose`, `llm`, `sgpt`; `--version` and `mcp`, `plugin` or `extensions` `list` are allowed), `--no-verify`, force pushes, `git worktree prune`, `rm -rf`, `sdlc config set`, and running `sdlc hook` or the launcher by hand.

  In `enforce` the first matching rule refuses the call with a message that names the rule. In `observe` the call goes ahead, with a warning. Either way each violation is recorded as a gap: the rule, the text, the harness and whether it was refused. The state comment keeps the 20 newest gaps. Running the hooks by hand (`hook-spoof`) is refused in both modes.

Docs (`docs/**`) and any `*.md` file need no task. Edits are allowed in `debugging` and in task types that have no planning phase; otherwise the plan has to be approved. The state of the task is cached for 10 minutes in `.sdlc/cache/hook-tasks.json`, only when edits were allowed, so an approval takes effect on the next edit.

What the harness hooks guarantee is narrow: when the harness runs them, and the tool call reaches them in a form they read, a call that breaks a rule is refused (`enforce`) or recorded (`observe`). Everything else is in "Known bypasses". The kit leans on each harness treating a hook that fails or times out as non-blocking, and does not ask any harness to block on a hook failure.

### Git hooks and the secret guard

- `pre-commit`: the secret guard, then in `enforce` a refusal of commits to the default branch.
- `pre-push`: the secret guard on the pushed commits, then in `enforce` a refusal of pushes to the default branch and of `task/*` branches whose task is not tracked. It looks the task up on GitHub; when GitHub cannot be reached in time, it allows the push with a warning.
- `post-merge`: starts a reconcile in the background. `post-checkout`: prints the task of the branch.

The guard blocks in both modes and fails closed. The rest are branch rules and fail open: an unreadable config, an unknown hook or an unexpected error prints a warning and lets git go on. `core.hooksPath` is local git config, so it is set again in every clone (INSTALL.md, Step 4). `sdlc` has to resolve (on the PATH, or through `npx --no-install sdlc`); when it does not, the hook says the guard is not active and lets the commit through. GitHub secret scanning push protection is the server-side backstop where the plan has it.

### Branch protection and the merge policy

`init` sets classic protection on the default branch when it has none: a pull request is required, no approving reviews, no force pushes or deletions, administrators not included. Without required reviews, one account can open and merge its own pull request, so the merge policy (`owner_only` or `agent_on_request`) is a rule in the instructions, and the only mechanical part is that the harness hooks refuse `gh pr merge --admin`. A repository that uses rulesets keeps its own rules, which `init` does not read. A free private repository, or a token without admin rights, cannot have protection at all.

### Approvals

- **By comment.** `sdlc approve ... --comment-url <url>` reads the comment from GitHub and checks that its author is an owner, and that it was not written by the login `sdlc` acts as (or by a login under `agents`). If the tool's login is the owner's own, an owner comment is indistinguishable from the agent's own, so `enforce` refuses it and `observe` records it as `unverified`.
- **By prompt.** When the first non-empty line of a human prompt is `/approve`, `/accept`, `/ran` or `/cancel <reason>`, the prompt hook records it on the task of the current branch. `/approve` covers the current phase; the others cover the task; `/approve type <id>` is comment-only. The record carries a reference built from the harness, the session, the prompt id and a hash of the prompt. The prompt text is never stored. With one owner it is recorded for that owner whichever login `gh` runs as; with several, the login `gh` runs as has to be one of them. The agent cannot type into its own prompt line, and the hook refuses an agent that tries to call it.
- `--unverified`, which records an approval without checking its author, exists only in `observe`.

## Known bypasses

These are stated plainly, because an owner should not discover them by surprise. None of them needs a vulnerability in anything: each is something the design does not look at.

### Shell commands the rule does not see through

The shell rule reads the text of the command. It follows wrappers (`env`, `sudo`, `exec`, `nohup`, `time`, `timeout`, `nice`, `stdbuf`, `xargs`, `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec`), follows `sh -c`, `bash -c` and `eval` down to three levels, and treats the body of a heredoc as data, so that a commit or pull request message that mentions a forbidden command is not refused. It never runs or expands anything. It therefore misses:

1. **Variables and substitutions.** `CLI=claude; $CLI -p x`, `$(which claude) -p x`, or any command whose name is built at run time.
2. **`find -exec`.** A program started by `find ... -exec` is not read.
3. **Nesting beyond three levels.** `sh -c "sh -c 'sh -c \"sh -c claude\"'"` is past the limit.
4. **Scripts written, then run.** The agent writes `x.sh` (with an edit tool or a redirect) and runs `sh x.sh`; the rule reads the second command only.
5. **Piped and fed heredocs.** Because heredoc bodies are data, `cat <<EOF | sh`, `bash <<EOF`, and a `$(...)` inside the body of an unquoted heredoc run commands the rule never reads.
6. **Aliases, functions and encoded text** decoded at run time.

Every shell rule has this limit: `--admin` merges, other AI CLIs, `--no-verify`, force pushes, `git worktree prune`, `rm -rf`, `sdlc config set` and the hook-spoof rule. Obfuscation is not an accident, so these rules stop the careless and the steered-by-accident, not the determined.

### Edits the edit rule does not see

7. **Shell-driven edits are not parsed.** The edit rule checks the harness's own edit tools: Claude Code's Edit, Write and NotebookEdit, Codex's `apply_patch`, Gemini CLI's `write_file` and `replace`. `sed -i`, `tee`, `>` and `>>` redirects, `cp`, `mv`, `git apply`, `patch` and scripts write files with no check. "No edits before the plan is approved" holds for edit tools, not for the shell. This includes the protected paths: a redirect into `sdlc.config.yaml` or into a file under `.sdlc/` is not refused.
8. **Markdown and docs never need a task.** Anything under `docs/` and any `*.md` is exempt. That includes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, the agent roles and the skills. A code change disguised as Markdown passes the harness hooks; the git hooks and review remain.
9. **The harness settings files are not protected paths.** `.claude/settings.json`, `.codex/hooks.json` and `.gemini/settings.json` are ordinary code to the edit rule: an agent in a task with an approved plan can change them with the edit tools, and with the shell at any time, and take the hooks out. Claude Code picks up edits to its settings while it runs. Codex asks for a new `/hooks` review when a hook changes, and Gemini CLI only warns once about a hook it has not seen. The change shows in the pull request, and `doctor` (`hooks.<harness>`, `hooks.roundtrip`) notices hooks that are missing or that do not answer.
10. **Git configuration can be changed from the shell, which turns the git hooks off.** `git config core.hooksPath`, `git -c core.hooksPath=...`, the `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` environment variables, and redirects into `.git/config` or `.git/hooks` are not read. `doctor` (`git.hooksPath`) notices a changed hooks path the next time it runs.

### Switching the hooks off

11. **The harness has to run them.** Claude Code holds hooks back until the workspace trust dialog is accepted (print mode and the SDK count as trusted). Codex needs a trusted project and a review of each hook in `/hooks`, and `--dangerously-bypass-hook-trust` runs hooks without review. Gemini CLI loads project hooks only in a trusted folder, and says nothing when it does not; a headless run needs `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true`. Each harness also has a switch that turns hooks off (`disableAllHooks` in Claude Code settings, `[features] hooks = false` in the Codex config, `hooksConfig.enabled` in Gemini CLI settings), and project files that an agent can write can carry it. `doctor` cannot read any harness's trust state or these switches, so a project whose hooks are not running can look installed.
12. **Codex calls its hooks a guardrail.** Its documentation says tool hooks are "a useful guardrail, not a complete enforcement boundary", and that some specialised tool paths can opt out. Treat the Codex layer as weaker than the others.
13. **Gemini CLI marks nothing as a subagent call.** Its payloads carry no model, no prompt id and no subagent marker, so the hooks cannot tell a subagent's calls from the main agent's (the tool rules are applied to both), and built-in agents are refused in `enforce` because their model cannot be seen. If Gemini runs the prompt hook for a prompt that the main agent hands to a subagent, the hook cannot tell it from a human prompt. Whether Gemini does that is not verified. Hooks are not supported on Windows for Gemini in this version.
14. **A broken launcher is no launcher.** The settings run `"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh"`. Outside a git repository, in a clone or a worktree where the launcher is not committed (or is committed without the executable bit), the shell exits 127 with its own error, which the harness treats as non-blocking: nothing is checked. Commit `.sdlc/hooks/run.sh`; `doctor` (`hooks.<harness>`) warns when it is not committed or not mode 100755.

### Failing open

15. **Hooks fail open by design.** A hook must never stand between the agent and its work, so these let the action through, with one line `sdlc: hook skipped: <reason>` on stderr (Gemini gets `{}`): `sdlc` not found or exiting with an error, a payload the hook does not understand, a config that cannot be read, a hook that runs past its timeout (15 seconds before a tool call, 30 for prompt and session start; the harness cuts it off, and the kit relies on it treating that as non-blocking), and any exception of the hook's own. Two more fail-open cases are quieter: when the task lookup fails (GitHub unreachable, `gh` not usable) the edit is allowed with the warning "could not read task #N; edit allowed", and when git fails in a file's directory so that its checkout cannot be resolved, the edit is allowed.

### Forging local state and approvals

16. **The local cache is writable by redirect.** `.sdlc/cache/` holds plain files that an agent with a shell can write: `hook-tasks.json` (the cached task state the edit rule reads; a forged entry says "the plan is approved" for up to ten minutes), `outbox.jsonl` (the queue of commands that wait for `sdlc sync`), `gaps.jsonl` (the gap log, which can also be edited to erase a record) and `sync.lock`. The cache is not in git, so a reviewer does not see it. Forging `hook-tasks.json` gives no power beyond shell-driven edits (7). **The control for the outbox is the replay allowlist**: `sdlc sync` replays only `stage start`, `stage publish`, `evidence add`, `review handoff`, `approve` and `task checkpoint`, refuses the options `--config`, `--verify`, `--json` and `--dry-run`, and never replays `task new` or `deploy record`, whatever a line says. A forged line can do no more than the agent could by running the same command. A malformed line moves to `outbox-failed.jsonl` and makes `sdlc sync` exit 1.
17. **An agent with a shell can call the prompt hook itself.** The `hook-spoof` rule refuses `sdlc hook` and the launcher in both modes, but it reads command text (1 to 6), so an agent that obfuscates the command can run `sdlc hook <harness> prompt` with a payload it wrote, and have `/approve` recorded. An agent that holds the owner's token can do more: post a comment as the owner, or write the state comment through `gh api`. The answer is the setup in "Recommendations": a separate agent account that cannot approve, and an owner who reads a task before merging it.
18. **Gemini has no prompt id, so a re-delivered `/approve` can count again.** For Claude Code and Codex, the reference of a prompt approval contains the harness's prompt id, so the same prompt delivered twice is one approval and cannot approve a later phase. Gemini payloads carry no prompt id, so the reference falls back to the action, or `approve-<phase>`. An old `/approve` that is delivered again after the task has moved to the next phase (by a replayed hook, per 17) is a different reference, and approves that phase.

### Limits that are not bypasses

19. **Replay can repeat a comment.** A queued command runs later against the current state. A command that half-succeeded before the connection dropped can post its comment twice when it is replayed. The check that stops a retried `stage publish` from posting a second comment recognises its own earlier comment by the login `sdlc` acts as; when that login is unknown (an Actions `GITHUB_TOKEN` or an App token), the check is off and the comment is posted again. This costs noise, not authority.
20. **Gaps reach GitHub late and in part.** They are written locally and flushed by `sdlc sync` (at the next session start, or by hand), and only the 20 newest stay in the state comment.
21. **`--unverified` and a missing login.** In `observe` mode an approval from a login that cannot be told from the agent is recorded as `unverified`: a record, not a proof.
22. **Time of check and time of use.** The hook decides on the state it read at that moment, or on a cache up to ten minutes old for an allowed edit. A task cancelled or reopened a minute ago may still let an edit through.

## Recommendations

1. **Give agents their own GitHub account**, listed under `agents`, with a token that has no admin rights and, where the plan allows, no right to merge into the default branch. This is the one measure that turns most of the bypasses above from "possible" into "possible, but the account cannot merge it". Keep the owner's token out of the agent's shell and environment.
2. **Protect the default branch for everyone.** Keep the classic protection `init` sets, and where the plan allows, add a ruleset that requires an approving review from someone who is not the agent's account and includes administrators. Without that, a merge is one command for any account with admin rights.
3. **Use `enforce` mode** once the team trusts the rules (`sdlc config set mode enforce`, then `sdlc upgrade`). In `observe` the hooks only warn and record gaps; the secret guard blocks in both.
4. **Keep the hooks running.** Commit `.sdlc/hooks/run.sh` with mode 100755; trust the project in each harness the team uses, and review the hooks in Codex's `/hooks`; run `sdlc doctor` and read `hooks.<harness>` and `hooks.roundtrip`. Check once per harness, in `enforce`, that it refuses a command it must refuse (INSTALL.md, end of Step 6).
5. **Read what the agent changed**, not only what it says. Review the diff for changes to `.claude/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`, `sdlc.config.yaml`, anything under `.sdlc/`, and instruction files. Treat a pull request that changes them like one that changes CI.
6. **Keep secrets out of reach.** Use the OS keystore for the tokens, turn on secret scanning push protection, rotate any secret that was ever committed, and never paste a token into a chat. The local guard is a net, not a vault.
7. **Run `sdlc status` and `sdlc sync` now and then.** Look at the gaps on the tasks, at `Queued for sync`, and at orphan worktrees.
8. **Run agents in a sandbox when the stakes call for it.** A container or a virtual machine with no production credentials, and a token with narrow rights, protects what these hooks cannot.
