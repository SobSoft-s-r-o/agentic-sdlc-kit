# Dogfood: the kit installed in its own repository

Status: installed on 2026-11-28 in `observe` mode with `sdlc init --skip-github`. Nothing was written to GitHub: no board, no labels, no branch protection, no push protection, no secret. The owner still has the follow-ups at the end of this page.

## How the repository runs its own build

The hooks and the git hooks start `sdlc` through `.sdlc/hooks/run.sh` and `.sdlc/githooks/hook.sh`. Both look for `sdlc` on PATH, then for `npx --no-install sdlc`. Neither ever downloads anything. Inside this repository, `npx --no-install sdlc` resolves the project's own `bin` entry, which is `dist/cli.js`, so the repository enforces its own last build with no extra setup. This is option 1 of the research in `docs/notes/plan-4-research.md` (section D).

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
- `owners` holds the owner's GitHub login, which the kit requires. It is a public handle, and it is the only place this page's author put it. The managed skill `sdlc-task-tracking` renders the same list from the config, as it does in every installation.

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

1. Run `npx --no-install sdlc init` without `--skip-github`. It creates the board, the labels, the branch protection and the push protection. It prints `Created project #N`. Run it once: a rerun before step 2 creates a second project.
2. Set `github.project.number: N` in `sdlc.config.yaml`.
3. Run `gh secret set SDLC_TOKEN` (a token with the `repo` and `project` scopes), then set `stack.actions: true` and run `npx --no-install sdlc init` again to render the reconcile workflow.
4. Add the CI job (`test` in `.github/workflows/ci.yml`) as a required status check in the branch protection of `main`. `init` sets no required check.
5. Later, after a few tasks have run cleanly in observe mode: `npx --no-install sdlc config set mode enforce`.

Run `npx --no-install sdlc doctor` after each step; every check should pass once step 3 is done.
