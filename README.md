# agentic-sdlc-kit

Installable, agent-driven software development lifecycle for GitHub — works with Claude Code, Gemini CLI, OpenAI Codex and any `AGENTS.md`-aware agent.

> Status: design phase. See [the design](docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md).

## CLI

`sdlc` tracks each task as a GitHub issue with a hidden state comment and mirrors it onto a Projects v2 board. It needs the [GitHub CLI](https://cli.github.com) (`gh`), authenticated, and reads `sdlc.config.yaml` from the root of the git repository (override with `--config <path>`). Every command prints JSON with `--json` and exits non-zero on failure.

- `sdlc task new | set-type | checkpoint | reopen` - create a tracked task, change its type, record progress, or reopen a done task.
- `sdlc stage start | publish` - start a phase, or post its result as an issue comment.
- `sdlc evidence add` - record the evidence (a backup, a dry run) a task type requires before review.
- `sdlc review handoff` - hand a task over for review with a linked pull request.
- `sdlc approve` - record an owner decision: approve a stage, accept a result, confirm a run, or cancel.
- `sdlc deploy record` - record that a commit is deployed to a target.
- `sdlc reconcile` - bring tasks, the board and issues in line with merges, approvals and deployments (`--dry-run` only reports).
- `sdlc status` - show tasks by status, what waits on the owner, what is stale (`--stale-days`, default 7), untracked issues and what reconcile would change.
- `sdlc board ensure` - create the board or add its missing fields, options and views (add-only).

Run `sdlc <command> --help` for the options of each command.

License: MIT
