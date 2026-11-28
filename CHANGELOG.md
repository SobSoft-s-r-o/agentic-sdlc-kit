# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-28

Open-source packaging: the kit is published on npm, has CI and a release workflow, runs on itself in observe mode, and closes the hook and robustness items deferred from 0.2.0.

### Added

- The package is published on npm as `agentic-sdlc-kit` (from 0.3.0), with provenance. `v0.1.0` and `v0.2.0` were GitHub releases only and never reached npm.
- CI on every push to `main` and every pull request: typecheck, tests, build and a pack smoke test (`scripts/pack-smoke.mjs`: pack, install the tarball into an empty project, run the installed `sdlc`), on Ubuntu with Node 20, 22 and 24 and on macOS with Node 22.
- A release workflow that publishes to npm from a version tag through trusted publishing (OIDC), without an npm token. It checks that the tag matches `package.json`, runs typecheck, tests, build and the pack smoke test first, publishes a version containing `-` (a prerelease such as `0.4.0-rc.1`) under the `next` dist-tag instead of `latest`, and skips a version that is already published. The first publish is manual (`npm publish --provenance=false`, then `npm trust`); `CONTRIBUTING.md` has the steps.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (reports through GitHub private reporting).
- An opt-in end-to-end suite, `npm run test:e2e`, that walks a task through `task new`, `stage publish`, an owner approval, `reconcile`, `task checkpoint` and a cancel against a real sandbox repository. It is skipped unless `SDLC_E2E_REPO` is set and is never part of `npm test`.
- A shell rule `api-merge` (enforce only) for merging through `gh api .../merge` or a GraphQL `mergePullRequest` or `enablePullRequestAutoMerge` mutation (`gh pr merge --auto` without `--admin` stays allowed: branch protection governs it, see the threat model); owner-only commands are recognised when run as `node .../dist/cli.js` or `node_modules/.bin/sdlc`.
- `reconcile` mirrors a PR body's `Scope: partial` to the `sdlc:partial` label on that PR, and removes it otherwise.
- `gh` calls time out after 60 s (SIGTERM, then SIGKILL); a timed-out call counts as GitHub unreachable, so queueable commands go to the outbox.

### Changed

- A `kit_ref` that is a release tag (`v0.3.0` and later) now renders the registry form `npx -y agentic-sdlc-kit@<version>` in the instructions, skills and reconcile workflow. A branch or commit keeps the `github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>` form.
- `sdlc doctor` checks a release `kit_ref` with `npm view`, and a branch with `git ls-remote`, as before.
- The npm package contains only `dist`, `templates`, `INSTALL.md`, `CHANGELOG.md`, `README.md` and `LICENSE`.
- `README.md` and `INSTALL.md` describe the npm install and the requirements.
- Hooks read `mode` from the main checkout's `sdlc.config.yaml`, so a worktree follows a mode change without a commit. Task-state lookups share a checkout cache and have tighter deadlines.
- An owner approval is refused when the PR body was edited after the approving comment, and `--unverified` approvals are stamped no earlier than GitHub's own timestamps.
- `reconcile` prints ignored owner commands, untracked issues and skipped tasks as one summary line; `--json` still lists each of them.
- `sdlc upgrade` and `sdlc uninstall` own only the exact hook commands the kit rendered, so a user hook that merely resembles the kit's is no longer replaced or removed.
- Labels are listed with pagination, so repositories with more than 500 labels are checked correctly (the old code listed at most 500).
- `sdlc doctor` reads Codex hook switches written as inline tables (`features = { hooks = false }`) and is split into per-area modules.
- `sdlc sync` takes over a stale lock atomically, so concurrent syncs never run together, and releases a lock it cannot read back.
- JSON items appended to a one-line array stay on one line; `worktree finish` names an ignored `.env/` directory correctly; a reused `stage publish` comment is reported.

## [0.2.0] - 2026-11-28

Harness hooks: the kit now guards agent tool calls in Claude Code, Codex and Gemini CLI, not only git operations.

### Added

- Harness hooks: `sdlc hook <harness> <event>` runs at session start, on each prompt and before each tool call. The launcher `.sdlc/hooks/run.sh` is installed next to your own hooks, always exits 0 and fails open.
- `mode: observe | enforce`. In `observe` a violation is a warning and a gap recorded on the task; in `enforce` the call is refused. Only the owner changes the mode, with `sdlc config set mode`.
- Shell rules: `gh pr merge --admin`, force pushes and `--no-verify`; launching other AI CLIs; `sdlc config set`; running the hooks by hand; and `sdlc uninstall` and `init --overwrite-modified`, which block in both modes.
- Edit policy: no code edits outside a task or before its plan is approved; protected paths (`sdlc.config.yaml`, `.sdlc/`, `.git`, `.mcp.json`, and harness settings in the repository and in the home directory); a subagent dispatch must name a role and a model tier.
- Owner approvals: `/approve` is accepted from the owner's prompt as well as from issue comments.
- Offline work: an outbox queues commands while GitHub cannot be reached, and `sdlc sync` replays them and records gaps.
- Worktrees: `sdlc worktree start | finish <issue>`, and a radar for orphaned worktrees in `sdlc status`.
- `sdlc doctor` checks for the stack, MCP servers, hooks per harness, hook switches, a hook round trip, the outbox, orphaned worktrees and the git version.
- A [threat model](docs/threat-model.md) with the known bypasses, and updated INSTALL and README.

## [0.1.0] - 2026-11-28

First release. It installs an agentic SDLC into any repository: the task lifecycle is tracked on GitHub Issues and a Projects v2 board, and coding agents (Claude Code, Codex, Gemini) work under shared rules.

### Added

- Core CLI: task lifecycle and stages, approvals, review handoff, deploy and evidence records, and reconcile.
- Installer: `sdlc config suggest | validate` and `sdlc init | upgrade | uninstall`. It renders the instruction block, the skills, 11 agent roles, the MCP config, the PR template, the reconcile workflow and the git hooks, never overwrites your content, and provisions the GitHub board, labels and protection.
- Secret guard: the pre-commit and pre-push hooks run 76 content rules and 10 file-name rules. Output is masked and the guard fails closed; gitleaks is optional.
- `sdlc doctor`: preflight and install checks.

[Unreleased]: https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/releases/tag/v0.1.0
