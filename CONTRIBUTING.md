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

An opt-in suite runs the task flow against a real GitHub repository with the real `gh`. It is never part of `npm test`. Use a throwaway repository you own, never a repository you care about:

```sh
SDLC_E2E_REPO=<owner>/<name> npm run test:e2e
```

Without `SDLC_E2E_REPO` every e2e test is skipped.

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

The kit is installed in its own repository, in `observe` mode, so its hooks and secret guard watch your commits too. The hooks run `npx --no-install sdlc`, which resolves this checkout's `dist/`. A new clone or task worktree has no `node_modules/` and no `dist/` yet, so run `npm ci && npm run build` there before its hooks can run; until then they skip silently. After you edit `src/`, build again, or the hooks enforce the old code.

## Releases

Releases are cut by the maintainers. Bump the version in `package.json`, move the `## [Unreleased]` entries of `CHANGELOG.md` under the new version, and push a tag `v<version>`. The `release` workflow checks that the tag matches `package.json`, runs the tests and publishes to npm through trusted publishing. It skips a version that is already on npm.
