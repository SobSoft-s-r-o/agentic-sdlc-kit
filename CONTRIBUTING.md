# Contributing to agentic-sdlc-kit

Thank you for helping. This page is what you need to build, test and change the kit. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report a security problem as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Setup

You need Node.js 20 or newer and git 2.31 or newer. The tests use a fake `gh`, so they need no GitHub account and no network.

```sh
npm ci                  # install the locked dependencies
npm run typecheck       # TypeScript in strict mode; this is the project's lint, there is no ESLint
npm test                # the whole test suite
npm run build           # compile src/ to dist/
```

CI runs the same four commands, then `node scripts/pack-smoke.mjs`, on Ubuntu with Node 20, 22 and 24 and on macOS with Node 22. Run the smoke yourself after a build to see what an npm user gets: it packs the package, installs the tarball into an empty project and runs the installed `sdlc` (`--version` and `config validate`). It needs the npm registry for the dependencies.

Run one test file with `npx vitest run tests/docs/readme.test.ts`.

## Golden files

The renderers (instructions, skills, agent roles, hooks, MCP config, git hooks, the GitHub files) are tested against golden output in `tests/golden/`. When you change a template or a renderer on purpose, rewrite the goldens, then read the diff before you commit it:

```sh
UPDATE_GOLDEN=1 npx vitest run tests/render
git diff tests/golden
```

`UPDATE_GOLDEN=1` rewrites each golden directory the run touches and removes files the renderer no longer produces. A golden diff you did not expect is a bug, not something to commit.

## End-to-end tests

An opt-in suite runs the task flow against a real GitHub repository with the real `gh`. It is never part of `npm test`: `vitest.config.ts` only includes `tests/**/*.test.ts`, and the e2e files are `tests/e2e/*.e2e.ts`, run with `vitest.e2e.config.ts`. Use a throwaway repository you own, never a repository you care about:

```sh
SDLC_E2E_REPO=<owner>/<name> npm run test:e2e
```

Without `SDLC_E2E_REPO` every e2e test is skipped and the command exits 0.

| Variable | Meaning |
| --- | --- |
| `SDLC_E2E_REPO` | Required. The sandbox repository, `owner/name`. |
| `SDLC_E2E_PROJECT_OWNER` | The login that owns the project. Defaults to the owner of the repository. |
| `SDLC_E2E_PROJECT` | The number of an existing Projects v2 board to use. Optional: without it the suite creates a project named `sdlc-e2e-<random>` with `gh project create` and prints its number. |

You need `gh` logged in with the `repo` and `project` scopes (`gh auth refresh -s project` adds the second). The logged-in user becomes the only owner in the suite's config, which runs in `observe` mode with the task types `tooling` and `spike`. The commands run in-process, as `src/cli.ts` calls them, through a runner that fails closed (`tests/e2e/guard.ts`, unit-tested by `tests/e2eGuard.test.ts`, which is part of `npm test`). It runs a `gh` call only when it is one of these, and refuses anything it does not recognise:

- `gh issue|pr|label|repo|release|run|workflow|secret|variable ...` with `--repo <sandbox>` (or `-R`). Without it, or with another repository, the call is refused, and so is `delete`, `transfer`, `archive`, `rename` or `lock`, and every `gh repo` subcommand but `view`.
- `gh api` on `repos/<sandbox>/...` (never the repository itself with a method other than GET, never `transfer` or `archive`), on `/users/<owner>/projectsV2/<n>` or `/orgs/<owner>/projectsV2/<n>` for a project the suite owns, `gh api user` and `gh api users/<owner>` (reads only), and `gh api graphql` with its request on stdin, naming only the sandbox repository, the project owner and a project the suite owns, and never a `delete...`, `archive...` or `transfer...` mutation.
- `gh project create|list --owner <owner>`, and `gh project view|field-list|item-list <n> --owner <owner>` for a project the suite owns. A project the suite owns is the one in `SDLC_E2E_PROJECT` or the one it created. `delete`, `close`, `edit` and the rest are refused.

Any call with a URL argument that is not inside the sandbox repository (`https://github.com/<sandbox>/...`) is refused, even when the rest of the call would be allowed. A repeated `-X`/`--method` counts as the last one, as `gh` reads it. A `gh api` path with a `.` or `..` segment, an empty segment, an encoded dot or slash, a backslash or a fragment is refused, and trailing slashes are ignored when the repository root is recognised, so `-X DELETE repos/<sandbox>/` is refused like `-X DELETE repos/<sandbox>`.

GraphQL calls by node id (the item and field ids the tool reads from the owner's project) cannot be checked beyond that; the runner does not set `GH_REPO`, because it has no environment to pass.

The one test, `issue lifecycle`, walks a spike task through `task new`, `stage publish`, an owner `/approve` comment followed by `reconcile` (recorded as `unverified`, since the comment is by the tool's own login in `observe` mode), `task checkpoint` and a cancel with the reason `e2e`. It checks the issue, its labels, the state comment and the board item at each step. A test has 180 seconds, because every step is a real network round trip.

The suite writes to the sandbox repository (it creates the labels `sdlc:task`, `sdlc:partial`, `type:tooling`, `type:spike` and `e2e`) and to one board: the one you name or the one it creates. Every issue it opens carries the label `e2e` and a title starting with `sdlc-e2e-`, and `afterAll` closes any of them still open: first the ones it saw being created, each on its own so one failure leaves the others closed, then, best-effort, any other open `e2e` issue of the run. If an issue could not be closed, the run fails and lists it. It never deletes the repository, the issues or the project; delete a throwaway project and repository yourself when you are done. It never touches a project it did not create or that you did not name.

## Commit style

Short, imperative subject in the form `type: what changed`, with an optional scope: `feat:`, `fix:`, `docs:`, `test:`, `refactor(doctor):`, `build:`, `ci:`, `chore:`. Say why in the body when the diff does not. One logical change per commit. Do not rewrite history that others have pulled.

## Pull requests

- Work on a branch, not on `main`, and keep the pull request to one change.
- Add or update tests with the code. A bug fix starts with a test that fails for the bug.
- A behaviour change updates its docs in the same pull request: README, INSTALL, and `docs/threat-model.md` when a guard or a known bypass changes. Add a line to `CHANGELOG.md` under `## [Unreleased]`.
- Fill in the pull request template. Owner commands such as `/approve` go in a plain comment, never in a review.
- `npm run typecheck`, `npm test` and `npm run build` must pass.

## Dependencies

The runtime dependencies are `commander`, `yaml` and `zod`, and that is deliberate: the package is installed into other people's repositories and run by git hooks. Do not add a runtime dependency, or a dev dependency that changes how the project is built, without opening an issue to discuss it first.

## Secrets and personal data

Never commit a secret, a token, a personal email address or a private name. Test fixtures build fake tokens at run time instead of containing them, so the secret guard does not flag the repository itself. Write code, comments and docs in English.

## This repository uses the kit

The kit is installed in its own repository, in `observe` mode, so its hooks and secret guard watch your commits too. The hooks run `npx --no-install sdlc`, which resolves this checkout's `dist/`. A new clone or task worktree has no `node_modules/` and no `dist/` yet, so run `npm ci && npm run build` there before its hooks can run. Until `dist/` is built, the git hooks print a warning that the secret guard is NOT active and let the commit through, and the harness hooks skip with a one-line notice. After you edit `src/`, build again, or the hooks enforce the old code.

`CLAUDE.md`, `.claude/` and `.mcp.json` are the maintainers' agent workflow. You do not need them to contribute, and the hooks only warn in `observe` mode.

## Releases

Releases are cut by the maintainers. Bump the version in `package.json`, move the `## [Unreleased]` entries of `CHANGELOG.md` under the new version, and push a tag `v<version>`. The `release` workflow checks that the tag matches `package.json`, runs the tests and publishes to npm through trusted publishing. It skips a version that is already on npm.
