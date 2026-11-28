# agentic-sdlc-kit

Installable, agent-driven software development lifecycle for GitHub — works with Claude Code, Gemini CLI, OpenAI Codex and any `AGENTS.md`-aware agent.

> Status: core CLI, installer and harness hooks available; on npm as `agentic-sdlc-kit` from version 0.3.0

See [the design](docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md) for the whole picture.

## Install

Ask your coding agent to install it. In the repository you want to set up, give it this prompt:

```text
Install agentic-sdlc-kit from https://github.com/SobSoft-s-r-o/agentic-sdlc-kit into this repository. Follow its INSTALL.md.
```

The agent runs the preflight, detects your setup, asks you the install questions one at a time (agents, board, mode, task types, deploy targets, quality gate, merge policy, MCP servers, where secrets live, models, stack, owners, language), shows you `sdlc.config.yaml` and the plan, installs, and opens a pull request for you to review. The steps only you can do (tokens, MCP approvals) are listed at the end. The full procedure is in [INSTALL.md](INSTALL.md).

## Requirements

- Node.js 20 or newer
- git 2.31 or newer
- the [GitHub CLI](https://cli.github.com) (`gh`), logged in (`gh auth login`)

The package is [`agentic-sdlc-kit` on npm](https://www.npmjs.com/package/agentic-sdlc-kit) and its binary is `sdlc`. Add it to a project with `npm install --save-dev agentic-sdlc-kit`, or run a release once with `npx -y agentic-sdlc-kit@<version> <command>`; the walkthrough below uses both.

## Two-minute walkthrough

Run these yourself instead, from the root of a git repository with `gh` logged in. `<version>` is a release on npm, from `0.3.0` on (for example `0.3.0`; `v0.1.0` and `v0.2.0` were never published). To try `main` or a commit instead, write `github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>` where the commands say `agentic-sdlc-kit@<version>`.

```sh
npx -y agentic-sdlc-kit@<version> doctor --preflight       # git, Node, gh, repository
npx -y agentic-sdlc-kit@<version> config suggest --write   # sdlc.config.yaml from what it finds
$EDITOR sdlc.config.yaml                    # answer the questions of INSTALL.md; set kit_ref to v<version>
npx -y agentic-sdlc-kit@<version> init --dry-run           # the plan; nothing is written
npx -y agentic-sdlc-kit@<version> init                     # files, git hooks, board, labels, protection
$EDITOR sdlc.config.yaml                    # init printed "Created project #N": set github.project.number to N
npm install --save-dev agentic-sdlc-kit@<version>          # the git hooks need sdlc to resolve
npx --no-install sdlc doctor                # expect only actions.secret and mcp.token to complain (possibly also secrets.pushProtection, mcp.claude)
```

Those go away with the owner-only steps in [INSTALL.md](INSTALL.md): `gh secret set SDLC_TOKEN`, and a GitHub token in your OS keystore exported as `GITHUB_PERSONAL_ACCESS_TOKEN`. Then commit the result on a branch, open a pull request, and give the agents their work as tasks: `npx --no-install sdlc task new --type <type> --title "..." --summary "..."`.

## CLI

`sdlc` tracks each task as a GitHub issue with a hidden state comment and mirrors it onto a Projects v2 board. It needs the [GitHub CLI](https://cli.github.com) (`gh`), authenticated, and reads `sdlc.config.yaml` from the root of the git repository (override with `--config <path>`). Every command prints JSON with `--json` and exits non-zero on failure.

After the project install above, run it as `npx --no-install sdlc <command>`: a dev dependency is in `node_modules/.bin`, not on the PATH. Plain `sdlc <command>`, as written below, works after a global install (`npm install --global`).

Tasks and the board:

- `sdlc task new | set-type | checkpoint | reopen` - create a tracked task, change its type, record progress, or reopen a done task.
- `sdlc stage start | publish` - start a phase, or post its result as an issue comment.
- `sdlc evidence add` - record the evidence (a backup, a dry run) a task type requires before review.
- `sdlc review handoff` - hand a task over for review with a linked pull request.
- `sdlc approve` - record an owner decision: approve a stage, accept a result, confirm a run, or cancel.
- `sdlc deploy record` - record that a commit is deployed to a target.
- `sdlc reconcile` - bring tasks, the board and issues in line with merges, approvals and deployments (`--dry-run` only reports). It reads open tasks and those closed within `reconcile.closed_lookback_days` (default 30); `--all` reads every task.
- `sdlc status` - show tasks by status, what waits on the owner, what is stale (`--stale-days`, default 7), untracked issues, what reconcile would change, what waits for `sdlc sync` (`Queued for sync:`) and the orphan worktrees (`--all` also lists tasks closed before the lookback).
- `sdlc sync` - replay the commands that were queued while GitHub was unreachable and record the gaps the harness hooks logged (`--dry-run` only lists them). The queue is `.sdlc/cache/outbox.jsonl` in the main checkout; only `stage start`, `stage publish`, `evidence add`, `review handoff`, `approve` and `task checkpoint` are ever replayed.
- `sdlc worktree start | finish` - create the worktree `.worktrees/<issue>-<slug>` of a task from the fetched default branch, and after the merge remove it and its branch. Nothing is forced: `finish` refuses while the worktree has uncommitted or untracked changes or holds an ignored `.env*` file, when the task has no merged PR, and when run from inside the worktree (`--dry-run` shows the plan).
- `sdlc board ensure` - create the board or add its missing fields, options and views (add-only).

Installing and checking:

- `sdlc config validate | suggest` - check `sdlc.config.yaml`, or print one suggested from the repository (`suggest --write` creates it when it does not exist).
- `sdlc config set mode <observe|enforce>` - switch the enforcement mode (`--dry-run` only reports). Owners only: a login listed under `agents` is refused, and the harness hooks block an agent from running it. Run `sdlc upgrade` afterwards so the instructions and hooks match, and commit and push the config: each checkout reads the mode from its own copy.
- `sdlc init` - install the managed files, git hooks and GitHub setup (board, labels, branch and push protection) for `sdlc.config.yaml` (`--dry-run` only reports, `--skip-github` leaves GitHub alone, `--overwrite-modified` replaces files you edited). It commits nothing.
- `sdlc upgrade` - bring the managed files up to the installed kit version and remove what it no longer generates (`--dry-run`, `--overwrite-modified`). It never touches GitHub.
- `sdlc uninstall` - remove the managed files and the git hooks path, keeping everything you wrote and edited (`--dry-run`). The board, labels and issues on GitHub remain.
- `sdlc doctor` - check the machine and the installation, with a fix for each failure (`--preflight` runs only the checks that need no config).
- `sdlc githook <name>` - run one of the kit's git hooks, including the secret guard. The scripts in `.sdlc/githooks` call it; you do not run it by hand.
- `sdlc hook <harness> <event>` - run one of the kit's harness hooks (`claude`, `codex` or `gemini`; `session-start`, `prompt` or `pre-tool`). Claude Code, Codex and Gemini CLI call it through the launcher `.sdlc/hooks/run.sh`, which always exits 0; you do not run it by hand, and agents are blocked from running it.

Run `sdlc <command> --help` for the options of each command.

## Harness hooks

With the hooks installed, `sdlc` is also the referee of the agent's session. At session start the agent is told its task. Every prompt is read for the owner's `/approve`, `/accept`, `/ran` or `/cancel <reason>` as its first line, which is recorded as an approval. Every edit made with the harness's edit tools, every shell command and every subagent dispatch is checked, and in `enforce` mode a violation is refused: edits before the plan is approved, subagents without a role and model tier, `gh pr merge --admin`, other AI CLIs, `sdlc config set`. In `observe` mode the agent is only warned. Either way a gap is recorded on the task. Hooks fail open: any error of their own lets the action through. Commit `.sdlc/hooks/run.sh`, or new worktrees and clones run no hooks; Codex and Gemini also need the project trusted ([INSTALL.md](INSTALL.md), "Harness hooks and trust").

What the layers guarantee, and what an agent with a shell can still do, is in [the threat model](docs/threat-model.md).

## Secrets

The commit and push hooks block anything that looks like a secret, in `observe` and `enforce` mode alike, and print only a masked value. Secrets for local testing live in your OS keystore, production secrets in the store you name in the config; none belongs in a repository file. See "Secret guard" in [INSTALL.md](INSTALL.md).

## Contributing, security and changes

Setup, tests and commit style are in [CONTRIBUTING.md](CONTRIBUTING.md); everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes. What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

License: MIT
