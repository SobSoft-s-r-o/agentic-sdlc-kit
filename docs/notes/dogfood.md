# Dogfood: the kit installed in its own repository

Status: installed on 2026-11-28 in `observe` mode with `sdlc init --skip-github`. Nothing was written to GitHub: no board, no labels, no branch protection, no push protection, no secret. The owner still has the follow-ups at the end of this page.

## How the repository runs its own build

The harness hooks start `sdlc` through `.sdlc/hooks/run.sh`, and the git hooks through the four scripts in `.sdlc/githooks/` (`pre-commit`, `pre-push`, `post-checkout`, `post-merge`). Both look for `sdlc` on PATH, then for `npx --no-install sdlc`. Neither ever downloads anything. Inside this repository, `npx --no-install sdlc` resolves the project's own `bin` entry, which is `dist/cli.js`, so the repository enforces its own last build with no extra setup. This is option 1 of the research in `docs/notes/plan-4-research.md` (section D).

Consequences to know:

- `dist/` and `node_modules/` are git-ignored. Every clone and every task worktree (`.worktrees/<n>-<slug>`) must run `npm ci && npm run build` before its hooks work. Until then the harness hooks skip with a one-line notice and the git hooks warn that the secret guard is NOT active; both fail open.
- `dist/` goes stale after you edit `src/`. Run `npm run build` again, or the hooks enforce the code of the previous build.
- A build that does not compile leaves the old `dist/` or none, and the guard is off or stale until it compiles.
- `core.hooksPath` is local git configuration, and a worktree shares it with the main checkout. It is set to `.sdlc/githooks`, a path relative to each working tree. A checkout without `.sdlc/githooks/` simply runs no git hooks.
- `.sdlc/`, `.claude/`, `CLAUDE.md`, `.mcp.json` and `sdlc.config.yaml` are not in the `files` list of `package.json`, so none of them enters the npm package.

## Configuration choices

`sdlc.config.yaml` was started with `sdlc config suggest --write` and edited:

- `harnesses: [claude]` and `mode: observe`: hooks warn and record gaps on the task instead of blocking.
- `kit_ref: main`: no npm release exists yet, so the generated commands use the git form `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#main`. Set `v0.3.0` after the first publish (the release tags `v0.1.0` and `v0.2.0` were never on npm).
- `stack.actions: false`: the reconcile workflow needs the `SDLC_TOKEN` secret, which does not exist yet, so `init` does not render `.github/workflows/sdlc-reconcile.yml`.
- `quality_gate: [npm run typecheck, npm test, npm run build]`: the suggestion only found `npm test`.
- `stack.graphify: false`: this repository ships no `graphify-out/` knowledge graph, so the generated `CLAUDE.md` has no graphify section. The managed files were re-rendered with `sdlc upgrade` after this change.
- `owners` holds the owner's GitHub login, which the kit requires. It is a public handle. The managed skill `sdlc-task-tracking` renders the same list from the config, as it does in every installation.

## What `sdlc doctor` reports before the follow-ups

Failing only because GitHub provisioning is pending:

- `board.fields`: `github.project.number` is not set (fix: the board is created by `sdlc init`).
- `labels`: `sdlc:task`, `sdlc:partial` and the five `type:<id>` labels do not exist yet (fix: `sdlc init`).

Warnings that clear with the follow-ups or after the commit:

- `secrets.pushProtection`: push protection and secret scanning are disabled (fix: `sdlc init`).
- `hooks.claude`: `.sdlc/hooks/run.sh` is not committed yet (clears with the install commit).
- `mcp.token`: `GITHUB_PERSONAL_ACCESS_TOKEN` is not exported in the shell. Export it from the OS keystore before starting the agent, never as a literal value (see INSTALL.md, Secrets).

Everything else passes, including `files.managed`, `git.hooksPath`, `secrets.guard`, `hooks.roundtrip` and `kit.ref`.

## Owner follow-ups, in order

1. Make sure the `gh` token has the `project` scope (`gh auth refresh -s project`), then run `npx --no-install sdlc init` without `--skip-github`. It creates the board, the labels, the branch protection and the push protection. It prints `Created project #N`. Run it once: a rerun before step 2 creates a second project.
2. Set `github.project.number: N` in `sdlc.config.yaml`.
3. Create a token with the `repo` and `project` scopes under the account that should write as the agents, list that account under `agents` in `sdlc.config.yaml` (INSTALL.md, "Owner, agents and tokens": the workflow must not run under the owner's own login), and run `gh secret set SDLC_TOKEN`. Then set `stack.actions: true` and run `npx --no-install sdlc upgrade` to render `.github/workflows/sdlc-reconcile.yml`. Commit and push that file: the workflow, which runs hourly and on issue and pull request events, starts once it is on the default branch.
4. Add the CI checks as required status checks in the branch protection of `main`. `init` sets none. The matrix job `test` of `.github/workflows/ci.yml` reports four checks: `test (ubuntu-latest, node 20)`, `test (ubuntu-latest, node 22)`, `test (ubuntu-latest, node 24)` and `test (macos-latest, node 22)`. Pick them from the checks list after one CI run, because GitHub offers only checks it has seen.
5. Later, after a few tasks have run cleanly in observe mode: `npx --no-install sdlc config set mode enforce`.

Run `npx --no-install sdlc doctor` after each step; no failures remain once step 3 is done. The warnings about the shell environment (`mcp.token`) depend on your own setup.
