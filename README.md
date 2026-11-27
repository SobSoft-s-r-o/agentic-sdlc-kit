# agentic-sdlc-kit

Installable, agent-driven software development lifecycle for GitHub — works with Claude Code, Gemini CLI, OpenAI Codex and any `AGENTS.md`-aware agent.

> Status: the core CLI (`sdlc`, below) is available; the installer that sets it up for each agent is still to come. See [the design](docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md).

## CLI

`sdlc` tracks each task as a GitHub issue with a hidden state comment and mirrors it onto a Projects v2 board. It needs the [GitHub CLI](https://cli.github.com) (`gh`), authenticated, and reads `sdlc.config.yaml` from the root of the git repository (override with `--config <path>`). Every command prints JSON with `--json` and exits non-zero on failure.

- `sdlc task new | set-type | checkpoint | reopen` - create a tracked task, change its type, record progress, or reopen a done task.
- `sdlc stage start | publish` - start a phase, or post its result as an issue comment.
- `sdlc evidence add` - record the evidence (a backup, a dry run) a task type requires before review.
- `sdlc review handoff` - hand a task over for review with a linked pull request.
- `sdlc approve` - record an owner decision: approve a stage, accept a result, confirm a run, or cancel.
- `sdlc deploy record` - record that a commit is deployed to a target.
- `sdlc reconcile` - bring tasks, the board and issues in line with merges, approvals and deployments (`--dry-run` only reports). It reads open tasks and those closed within `reconcile.closed_lookback_days` (default 30); `--all` reads every task.
- `sdlc status` - show tasks by status, what waits on the owner, what is stale (`--stale-days`, default 7), untracked issues and what reconcile would change (`--all` also lists tasks closed before the lookback).
- `sdlc board ensure` - create the board or add its missing fields, options and views (add-only).
- `sdlc init` - install the managed files, git hooks and GitHub setup (board, labels, branch and push protection) for `sdlc.config.yaml` (`--dry-run` only reports, `--skip-github` leaves GitHub alone, `--overwrite-modified` replaces files you edited). It commits nothing.
- `sdlc upgrade` - bring the managed files up to the installed kit version and remove what it no longer generates (`--dry-run`, `--overwrite-modified`). It never touches GitHub.
- `sdlc uninstall` - remove the managed files and the git hooks path, keeping everything you wrote and edited (`--dry-run`). The board, labels and issues on GitHub remain.

Run `sdlc <command> --help` for the options of each command.

License: MIT
