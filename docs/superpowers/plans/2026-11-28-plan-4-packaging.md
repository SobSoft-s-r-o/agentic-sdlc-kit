# agentic-sdlc-kit Plan 4: Packaging, Testing & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship agentic-sdlc-kit as an npm package with CI, release automation and the open-source files; close the parked Plan 1–3 minors; add the opt-in e2e suite; install the kit in its own repository in `observe` mode; and prove the Claude Code hooks live.

**Architecture:**
- **Packaging:**
  - `package.json` gains a `files` whitelist, `repository` and provenance.
  - Generated commands switch to the npm registry form (`npx -y agentic-sdlc-kit@X.Y.Z`) whenever `kit_ref` is a release tag, and keep the `github:` form for branches and commits.
  - `doctor kit.ref` checks the registry or git to match.
- **CI and release:**
  - `ci.yml` runs typecheck, tests and build on every push and PR, and also installs the packed tarball.
  - `release.yml` publishes to npm through trusted publishing (OIDC) on a `v*` tag.
- **Hardening:** every item is a small change test-first. `doctor.ts` is first split into modules by verbatim moves, so later tasks edit focused files.
- **Dogfood:** the kit's own repo runs its own build through `npx --no-install sdlc`. Research D shows this works with no setup.

**Tech Stack:** Node.js ≥ 20 (the publish job uses Node 24 for npm ≥ 11.5.1), TypeScript strict ESM, `commander`, `yaml`, `zod`, `vitest`, GitHub Actions. No new runtime or dev dependency.

**Spec:** `docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md`. This plan implements:
- §15: e2e opt-in suite and dogfood;
- §16: npm releases, CI, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG;
- the `sdlc:partial` label mirror of §8 (line 340);
- the deferrals in `docs/notes/plan-3-rulings.md`.

**Research input (read before the task that needs it):** `docs/notes/plan-4-research.md`. It gives sections A–F, with file:line for every item below. Each task cites its research item.

## Global Constraints

- **Plan 1–3 Global Constraints still hold:**
  - Node ≥ 20, strict ESM;
  - runtime deps only `commander`/`yaml`/`zod`;
  - `gh` for all GitHub access;
  - English only;
  - nothing from any private reference project;
  - secrets never in files; test fixtures build fake tokens at run time;
  - hooks fail open and exit 0;
  - no code path runs `git push --force`, `git worktree prune`, `git worktree remove --force`, `git branch -D` or `rm -rf`.
- **No new dependencies.** "Lint" in spec §16 is `npm run typecheck` (TypeScript strict). No ESLint.
- **Package name and binary:** package `agentic-sdlc-kit`, binary `sdlc`. Scripts always call `npx --no-install sdlc`, because the unscoped npm name `sdlc` belongs to an unrelated package.
- **`repository.url`** is exactly `git+https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git`. npm compares it case-sensitively.
- **Action pins:** workflows pin actions by full SHA, the same pins as `templates/github/sdlc-reconcile.yml`:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1);
  - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` (v7.1.0).

  Release builds use no cache.
- **Owner-only steps:** agents never run `npm publish`, `npm login` or `npm trust`, and never change repository settings beyond what a task names. Those steps are written down for the owner.
- **Public docs:** no personal email, name or login in any committed file. Security reports go through GitHub private vulnerability reporting.
- **Every behaviour change updates its docs in the same task:** README, INSTALL and `docs/threat-model.md` where a bypass changes.

## Rulings Made While Planning

- **Release tags use the registry; everything else uses git.** A `kit_ref` matching `^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$` renders `npx -y agentic-sdlc-kit@<semver>`. Any other ref (`main`, a branch, a commit) renders today's `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>`. There is no new config key. Cost if wrong: v0.1.0 and v0.2.0 never reached npm, so a config pinned to them must switch to `v0.3.0` or later. INSTALL says so, and `doctor kit.ref` reports it.
- **The first npm publish is manual by the owner. OIDC handles later releases.** npm requires the package to exist before `npm trust`. `release.yml` skips publishing when `agentic-sdlc-kit@<version>` already exists on the registry. Cost if wrong: none; the manual publish is the bootstrap.
- **`sdlc:partial` is applied, not dropped.** The spec mirrors `Scope: partial` to the label. Reconcile adds it to a PR whose body says `Scope: partial` and removes it otherwise. Cost: one label write per changed PR.
- **Review bodies (M10) are covered by docs only.** The PR template and INSTALL say owner commands go in a plain comment, never in a review. Cost if wrong: a `/approve` typed into a review is silently ignored, as today.
- **Mode comes from the main checkout; the rest of the config does not.** The hook reads the worktree's config, then overrides only `mode` from the main checkout's `sdlc.config.yaml` when that file parses. `--config` wins over both. Cost if wrong: an uncommitted mode edit in main applies to all worktrees, which is what the owner wanted.
- **PR body edits after an owner comment void the comment for re-pointing (I1).** This uses GraphQL `lastEditedAt`. Cost: one GraphQL query per PR set read.
- **Dogfood:** repo-local `npx --no-install sdlc` (research D option 1).
  - Config: harness `claude`, `mode: observe`, `stack.actions: false` until the owner adds the `SDLC_TOKEN` secret.
  - `init --skip-github` runs in the task. Board, labels, branch protection and push protection are created after the owner's OK at finish.
  - Cost: each task worktree needs `npm ci && npm run build` before its hooks run. The dogfood notes say so.
- **CI runs on Ubuntu (Node 20, 22, 24) and macOS (Node 22). It does not run on Windows:** tests already skip POSIX-only parts there, and Windows support is not claimed. Cost: Windows regressions go unseen.
- **The live smoke covers Claude Code only.** The owner chose this; codex and gemini are not installed. The controller runs it (Task 12). Codex and Gemini keep the fixture smoke plus a manual checklist.
- **The e2e suite runs in-process against real `gh`.** It is gated on `SDLC_E2E_REPO`. Its first run is against a throwaway repository and user project under the owner's login, both deleted afterwards. Project #1 is never touched.
- **The three Plan 2 residual minors were accepted as-is by the owner.** No task covers them.

## Review Focus

1. **The packed tarball works with nothing but itself.** It is installed from `npm pack` into an empty directory with no dev dependencies. `npx --no-install sdlc --version` prints the version, and `templates/` resolves. Tests: Task 2 `packs only the whitelist`; Task 4 CI tarball smoke.
2. **`kit_ref` values that are not plain release tags** (`main`, `v0.3.0-rc.1`, a 40-hex SHA, `release/x`) render the right command. `doctor kit.ref` does not call npm for a branch and does not call git for a tag. Task 3 table test.
3. **A hook in a worktree when the main checkout's config is missing, unparsable or on another branch.** The worktree config is used and the hook never throws. Task 5 test `mode falls back to the worktree config`.
4. **Owner commands on a PR whose body was edited later, and unverified approvals with a skewed local clock.** A clock 10 minutes behind or ahead of GitHub never changes the order. Task 6 tests.
5. **Two `sdlc sync` processes judge the same lock stale at once.** Exactly one proceeds, and no lock file is left behind. Task 9 test `concurrent takeover`.

---

### Task 1: Split `doctor.ts` into modules (verbatim moves)

Research B6.

**Files:**
- Create: `src/install/doctor/types.ts`, `preflight.ts`, `files.ts`, `github.ts`, `stack.ts`, `secrets.ts`, `hooks.ts`, `local.ts`
- Modify: `src/install/doctor.ts`. It keeps `runDoctor` and `doctorChecks` and re-exports the public names.

**Interfaces:**
- Produces: `src/install/doctor.ts` still exports `Check`, `DoctorEnv`, `ExecOptions`, `runPreflight`, `runDoctor`, `doctorChecks`, `describeError`, `parseTokenScopes`, `hookEnvironment` and every name exported today. Later tasks edit:
  - `github.ts` for `checkKitRef` and `checkLabels`;
  - `hooks.ts` for `codexSwitch` and `checkHookSwitches`.

- [ ] **Step 1:** Record the export list: `grep -n "^export" src/install/doctor.ts > /tmp/doctor-exports.txt` (scratch, not committed).
- [ ] **Step 2:** Move each range named in research B6 into its module unchanged. Only imports may change. Make one commit per module, `refactor(doctor): move <area> checks to doctor/<file>.ts`.
- [ ] **Step 3:** After the last move, check that `src/install/doctor.ts` is under 150 lines and that its public export names equal the recorded list.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: the same pass count as before the split, no test file edited.

### Task 2: Package manifest and pack guard

Research A4 and C.

**Files:**
- Modify: `package.json`, `tsconfig.json` (`"declaration": false`)
- Test: `tests/packaging.test.ts` (new)

**Interfaces:**
- Produces: `package.json` fields:
  - `"files": ["dist", "templates", "INSTALL.md", "CHANGELOG.md"]`
  - `"repository": {"type": "git", "url": "git+https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git"}`
  - `"homepage": "https://github.com/SobSoft-s-r-o/agentic-sdlc-kit#readme"`
  - `"bugs": {"url": "https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/issues"}`
  - `"keywords": ["sdlc", "agents", "claude-code", "codex", "gemini-cli", "github-projects", "hooks"]`
  - `"author": "SobSoft s.r.o."`
  - `"publishConfig": {"access": "public", "provenance": true}`

- [ ] **Step 1: Write the failing test `packs only the whitelist`.**
  - Run `npm pack --dry-run --json --ignore-scripts` (with a `dist/` already built in `beforeAll` by `npm run build`) and parse `files[].path`.
  - Assert it contains `dist/cli.js`, `templates/hooks/run.sh`, `templates/githooks/hook.sh`, `INSTALL.md`, `README.md`, `LICENSE` and `package.json`.
  - Assert no path starts with `tests/`, `src/`, `docs/` or `.superpowers/`.
  - Assert no path ends with `.d.ts`, and none is `tsconfig.json` or `vitest.config.ts`.
  - Second test, `manifest names the repository`: `pkg.repository.url === 'git+https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git'` and `pkg.publishConfig.provenance === true`.
- [ ] **Step 2:** Run `npx vitest run tests/packaging.test.ts`. Expected: FAIL, with `tests/` paths present.
- [ ] **Step 3:** Add the manifest fields and `declaration: false`. Create an empty `CHANGELOG.md` stub (`# Changelog`); Task 4 fills it.
- [ ] **Step 4:** Run the test again, then `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `build: whitelist package files, add repository and provenance`.

### Task 3: Registry form for release tags

Research C "Touch points".

**Files:**
- Modify:
  - `src/render/instructions.ts:60-62,127`;
  - `src/install/doctor/github.ts` (`checkKitRef`);
  - `templates/github/sdlc-reconcile.yml` (comments only, if they name the `github:` form);
  - `README.md`, `INSTALL.md`;
  - `tests/docs/readme.test.ts` (the `CALL` regex).
- Test:
  - `tests/render/instructions.test.ts`;
  - `tests/install/doctor.test.ts`;
  - goldens under `tests/golden/**`, regenerated.

**Interfaces:**
- Produces in `src/render/instructions.ts`:
  - `export function kitCommand(ref: string): { npx: string; devDependency: string; source: 'npm' | 'github' }`.
  - For `v1.2.3[-pre]` it returns `{ npx: 'npx -y agentic-sdlc-kit@1.2.3', devDependency: 'agentic-sdlc-kit@1.2.3', source: 'npm' }`.
  - Otherwise it returns `{ npx: 'npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>', devDependency: 'github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>', source: 'github' }`.
  - `export const KIT_PACKAGE = 'agentic-sdlc-kit'`.
  - The template view's `kit.npx` comes from `kitCommand`.

- [ ] **Step 1: Write the failing table test `kitCommand picks the source`.** Each row gives the source:
  - `v0.3.0` → npm `@0.3.0`;
  - `v1.0.0-rc.1` → npm `@1.0.0-rc.1`;
  - `main` → github;
  - `release/x` → github;
  - a 40-hex SHA → github;
  - `0.3.0` without the `v` → github.
- [ ] **Step 2: Write the failing doctor tests.**
  - A release-tag ref makes `checkKitRef` call `exec('npm', ['view', 'agentic-sdlc-kit@0.3.0', 'version', '--json'])` and never `git ls-remote`.
  - Exit 0 with output `"0.3.0"` is ok.
  - An E404 is a failure: `kit_ref v0.3.0 is not published on npm`, fix `set kit_ref to a published version (v0.3.0 or later) or main`.
  - Any other failure is a warning (`cannot verify`).
  - A branch ref keeps today's `git ls-remote` path.
- [ ] **Step 3:** Run both test files. Expected: FAIL.
- [ ] **Step 4:** Implement it, then regenerate the goldens with the repo's existing golden-update mechanism (see `tests/render/*golden*`). Update README's walkthrough and INSTALL's `<ref>` text to say: the release form is `npx -y agentic-sdlc-kit@<version>` for `v0.3.0` and later, and `github:...#<ref>` is for `main` or a commit. Extend the `CALL` regex so both forms pass.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** Commit `feat: render the npm registry form for release tags`.

### Task 4: CI, release workflow and open-source files

Research C, F and A4 (`prepare`).

**Files:**
- Create:
  - `.github/workflows/ci.yml`, `.github/workflows/release.yml`;
  - `scripts/pack-smoke.mjs`;
  - `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`;
  - `.github/pull_request_template.md`. Copy the kit's own rendered template text so the repo matches what it ships. Task 11 replaces it with the managed one.
- Modify: `CHANGELOG.md`, `README.md` (status line, Requirements, npm install, links to the new files)
- Test: `tests/docs/oss.test.ts` (new)

**Interfaces:**
- **`ci.yml`:**
  - Triggers: `push` to `main` and `pull_request`. `permissions: contents: read`.
  - Matrix: `ubuntu-latest` × Node `[20, 22, 24]`, plus `macos-latest` × Node 22.
  - Steps: checkout, setup-node (pinned, `package-manager-cache: false`), `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `node scripts/pack-smoke.mjs`.
- **`scripts/pack-smoke.mjs`:**
  - Runs `npm pack --json` and makes a temp directory with `{"name":"smoke","private":true}`.
  - Installs the tarball there with `npm install --no-audit --no-fund <tgz>`.
  - Runs `npx --no-install sdlc --version` and asserts it equals `package.json` version.
  - Runs `npx --no-install sdlc config validate --config <fixture>` against a copy of `tests/fixtures/config/valid.yaml` and asserts exit 0.
  - Removes the temp directory and the tarball with `fs.rm(dir, {recursive: true})` on the temp path only.
  - Exits non-zero with a one-line reason on any mismatch.
- **`release.yml`:**
  - Trigger: `push: tags: ['v*']`. Job `publish` with `permissions: { contents: read, id-token: write }`, `runs-on: ubuntu-latest`.
  - Steps: checkout; setup-node Node 24 with `registry-url: https://registry.npmjs.org`; `npm --version` checked to be ≥ 11.5.1, else fail; `npm ci`; `npm test`.
  - A step asserts `${GITHUB_REF_NAME} == v$(node -p "require('./package.json').version")`.
  - A step sets `skip=true` when `npm view agentic-sdlc-kit@$V version` succeeds.
  - `npm publish` runs if not skipped.
  - No token secrets are referenced.
- **`SECURITY.md`:**
  - Supported versions: the latest minor.
  - Report through GitHub "Report a vulnerability", URL `https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/security/advisories/new`.
  - Scope and the known bypasses: link `docs/threat-model.md`.
  - No email.
- **`CODE_OF_CONDUCT.md`:** Contributor Covenant 2.1 text. The enforcement contact line says reports go to the maintainers through the same private reporting link, or a private message to a maintainer on GitHub.
- **`CONTRIBUTING.md`:**
  - Setup: `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.
  - Goldens: how to update them.
  - Opt-in e2e: `SDLC_E2E_REPO`, see Task 10.
  - Commit style.
  - No new runtime dependencies without discussion.
  - Note that the repo dogfoods the kit (Task 11).
- **`CHANGELOG.md`:** Keep a Changelog format, with sections `## [Unreleased]`, `## [0.2.0] - 2026-11-28` and `## [0.1.0] - 2026-11-28`, summarised from the two GitHub release notes (`gh release view v0.2.0`, `v0.1.0`).

- [ ] **Step 1: Write the failing `tests/docs/oss.test.ts`.**
  - The four files exist.
  - `SECURITY.md` contains `security/advisories/new` and `docs/threat-model.md`.
  - No committed Markdown at the root matches `/@[a-z0-9-]+\.[a-z]{2,}/i`.
  - `release.yml` contains `id-token: write` and `registry-url: https://registry.npmjs.org`, and does not contain `NPM_TOKEN` or `NODE_AUTH_TOKEN: ${{ secrets`.
  - Both workflows use only the two pinned SHAs in `uses:` lines.
  - `CHANGELOG.md` has `## [0.2.0]`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Write the files. In the README, replace the status line with the npm form and add a short Requirements list (Node ≥ 20, git ≥ 2.31, `gh` logged in) and links to CONTRIBUTING, SECURITY and CHANGELOG.
- [ ] **Step 4:** Run `npm test && npm run build && node scripts/pack-smoke.mjs`. Expected: PASS, and the smoke prints the version.
- [ ] **Step 5:** Commit `ci: add CI and npm release workflows; add OSS files`.

### Task 5: Hook hardening: mode from main, shell rules, exact ownership, shared checkout cache

Research B1–B4.

**Files:**
- Modify:
  - `src/commands/hook.ts` (`answer`, `anchorCheckout`, `judgeEdit`, budget comment);
  - `src/hooks/shell.ts` (`callViolations`, new `sdlcViolations`);
  - `src/hooks/types.ts` (`GapRule` adds `api-merge`);
  - `src/render/hooks.ts` (`RENDERED_SHAPE` replaced by `LEGACY_COMMANDS`);
  - `src/commands/config.ts` (`PER_CHECKOUT_NOTE`);
  - INSTALL ("Enforcement mode", step 9), `docs/threat-model.md` (items 25, 29 and the merge bypass).
- Test: `tests/commands/hook.test.ts`, `tests/hooks/shell.test.ts`, `tests/render/hooks.test.ts`, `tests/install/merge.test.ts`, `tests/commands/config.test.ts`

**Interfaces:**
- Produces:
  - `type CheckoutCache = Map<string, Promise<Checkout | undefined>>`;
  - `cachedCheckoutOf(cache: CheckoutCache, dir: string, gitFor: HookContext['gitFor']): Promise<Checkout | undefined>` in `src/hooks/resolve.ts`;
  - `effectiveMode(worktreeCfg: Config, mainCfg: Config | undefined, explicitConfig: boolean): Config['mode']`. It returns the worktree mode when `explicitConfig` is true or `mainCfg` is undefined, and otherwise `mainCfg.mode`.

- [ ] **Step 1: Write the failing tests.**
  - **Mode:**
    - `mode comes from the main checkout`: worktree config is observe, main is enforce, an edit outside a task, so the output is deny.
    - `mode falls back to the worktree config`: the main file is missing, or holds invalid YAML. The worktree mode is used, there is no throw, and the hook still exits 0.
  - **Shell table rows:**
    - `['gh api repos/o/r/pulls/3/merge -X PUT', ['api-merge']]`
    - `['gh api -X PUT repos/o/r/pulls/3/merge', ['api-merge']]`
    - `['gh api graphql -f query="mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}"', ['api-merge']]`
    - `['gh api repos/o/r/pulls/3', []]`
    - `['node dist/cli.js config set mode observe', ['mode-change']]`
    - `['node ./node_modules/agentic-sdlc-kit/dist/cli.js uninstall', ['kit-removal']]`
    - `['node_modules/.bin/sdlc hook claude prompt', ['hook-spoof']]`
    - `['node dist/cli.js status', []]`
  - **Ownership:** `"$(my-tool)/.sdlc/hooks/run.sh" claude prompt` and `"/other/.sdlc/hooks/run.sh" claude prompt` are not kit items. The legacy `"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" claude pre-tool` is still a kit item.
  - **Budget:** `git calls stay bounded`. A counting `gitFor`, a cwd outside any checkout, a project dir outside, and one edited file in a checkout give at most 4 git calls. The invariant test asserts `(2 + 2 + 2) * GIT_TIMEOUT_MS + DEFAULT_DEADLINE_MS <= PRE_TOOL_TIMEOUT_MS`; lower `DEFAULT_DEADLINE_MS` if needed to hold it.
- [ ] **Step 2:** Run the four test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `api-merge` is enforce-only, like `admin-merge`. Its text is `merging through gh api bypasses the merge policy; ask the owner to merge`. Read the `query` value before `withoutTextValues` strips it.
  - The `node` form applies when the first argument ends in `/cli.js` under a `dist/` directory or is a `node_modules/.bin/sdlc` path.
  - `PER_CHECKOUT_NOTE` becomes: the mode applies to all worktrees at once from the main checkout; the rest of the config is per checkout.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: one commit per sub-area (mode, shell, ownership, cache).

### Task 6: Approvals integrity: PR body edits, unverified clock, fake login

Research A5–A7.

**Files:**
- Modify:
  - `src/tracker/types.ts` (`PrInfo.bodyEditedAt?: string`);
  - `src/github/githubTracker.ts` (`listTaskPrs`/`getPr` fill it through `graphql()`);
  - `src/engine/reconcile.ts` (`linksOnly`);
  - `src/commands/approve.ts` (`assertPrSpeaksFor`, `unverifiedAt`);
  - `src/commands/task.ts:190`;
  - `tests/support/fakeTracker.ts`.
- Test: `tests/engine/reconcile.test.ts`, `tests/commands/taskFlow.test.ts`, `tests/github/githubTracker.test.ts`, `tests/support/fakeTracker.test.ts`

**Interfaces:**
- Produces:
  - `linksOnly(pr: PrInfo, issue: number, commentAt: string): boolean` is false when `pr.bodyEditedAt !== undefined && pr.bodyEditedAt > commentAt`.
  - `assertPrSpeaksFor(pr, issue, url, commentAt)` throws `ApprovalRefusedError('PR body was edited after the comment')` in the same case.
  - `unverifiedAt(state: TaskState, now: string): string` returns `max(now, latest of stage.publishedAt / resultPublishedAt / reopenedAt) + 1 ms`, as ISO.
  - FakeTracker: `login: string | undefined` (default `'sdlc-bot'`), and `FakePr.bodyEditedAt?: string`.

- [ ] **Step 1: Write the failing tests.**
  - `PR comment ignored after a body re-point`: a comment at T, `bodyEditedAt` T+1 min, so `ignored_approval` names the edit, in reconcile and in `approve --comment-url`.
  - `PR comment counts when the body was edited before it`.
  - `unverified approval with a clock 10 min behind GitHub is recorded`: `ctx.now` is 10 min before `publishedAt`. It is recorded, and `at > publishedAt`.
  - `unverified approval with a clock ahead keeps the local time`.
  - `state comments of an undefined login are not trusted`: FakeTracker `login = undefined`, so `findStateComment` ignores the tracker's own earlier comment unless its author is an owner or agent.
  - githubTracker: the GraphQL `lastEditedAt` maps to `bodyEditedAt`, and null maps to undefined.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Fetch `lastEditedAt` for all PRs of one `listTaskPrs` call in a single GraphQL query by node ids or numbers. When that query fails, leave `bodyEditedAt` undefined and add a warning to the result (fail open, the same as today).
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(approvals): ignore re-pointed PR comments; order unverified approvals by GitHub time`.

### Task 7: Reconcile and labels: quiet ignores, `sdlc:partial`, label paging, review-body docs

Research A1–A3.

**Files:**
- Modify:
  - `src/commands/reconcile.ts` (`describeReconcile`);
  - `src/engine/status.ts` (export `QUIET_KINDS`);
  - `src/engine/reconcile.ts` (partial label);
  - `src/install/provision.ts` (`ensureLabels` paging);
  - `templates/github/pull_request_template.md`;
  - INSTALL ("Owner, agents and tokens").
- Test: `tests/commands/reconcile.test.ts` (new), `tests/engine/reconcile.test.ts`, `tests/install/provision.test.ts`, the PR template goldens

**Interfaces:**
- Produces:
  - Reconcile action kind `pr_label`, with `detail` `PR #<n>: +sdlc:partial` or `-sdlc:partial`.
  - `ensureLabels` reads existing labels with `gh api repos/<repo>/labels --paginate --jq '.[].name'`.

- [ ] **Step 1: Write the failing tests.**
  - `describeReconcile prints one summary line for ignored commands`: 3 `ignored_approval` and 1 `pr_merged` give the real line plus `3 ignored owner command(s); --json lists them`. `--json` still lists all 4.
  - `partial PR gets sdlc:partial`: body `Scope: partial` on a PR without the label calls `setLabels(pr, ['sdlc:partial'], [])`.
  - `final PR loses sdlc:partial`: a PR that has the label calls `setLabels(pr, [], ['sdlc:partial'])`.
  - A PR in the right state makes no write.
  - `labels beyond 500 are seen`: the paginated fake returns 600 names including `sdlc:task`, and the dry run reports none missing.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The tracker needs the PR's current labels. Add `labels: string[]` to `PrInfo`, filled from the `labels` JSON field.
  - Add one line to the PR template under Notes: `Owner commands (/approve, /accept, /ran, /cancel) go in a plain comment, not in a review.`
  - Add the same sentence to INSTALL.
  - Regenerate the goldens.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(reconcile): mirror Scope partial to sdlc:partial; quiet ignored commands`.

### Task 8: Doctor: Codex inline-table switch

Research B5.

**Files:** Modify `src/install/doctor/hooks.ts` (`codexSwitch`). Test: `tests/install/doctor.test.ts`.

- [ ] **Step 1: Write the failing rows.**
  - `features = { hooks = false }` gives the warning `features.hooks is false`.
  - `features = { other = 1, codex_hooks = false } # x` gives `features.codex_hooks is false`.
  - `features = { hooks = true }` gives no switch.
  - `[profile]` followed by `features = { hooks = false }` gives no switch, because the key qualifies to `profile.features`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the inline-table branch as research B5 describes.
- [ ] **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5:** Commit `fix(doctor): read Codex hook switches in inline tables`.

### Task 9: Robustness: sync lock, gh timeout, cosmetics, slow test

Research B7–B10.

**Files:**
- Modify: `src/commands/sync.ts` (`acquireLock`), `src/github/gh.ts`, `src/install/jsonText.ts` (`appendEntry`), `src/commands/worktree.ts`, `src/commands/stage.ts`
- Test: `tests/commands/sync.test.ts`, `tests/github/gh.test.ts`, `tests/install/jsonText.test.ts`, `tests/commands/worktree.test.ts`, `tests/commands/taskFlow.test.ts`, `tests/secrets/scan.test.ts`

**Interfaces:**
- Produces:
  - `export function createGhRunner(opts?: { timeoutMs?: number }): GhRunner`, with default `GH_TIMEOUT_MS = 60_000`. `defaultGhRunner = createGhRunner()`. A timeout rejects with `GhError` whose message starts `gh timed out after 60 s:`.
  - `acquireLock` takes over a stale lock by `rename(lock, lock + '.stale-' + token)`. Only the winner of the rename proceeds. The renamed file is always unlinked.
  - `stagePublish` writes `stage publish: reused the stage summary already posted (<url>)` to `ctx.err` on a dedup hit.

- [ ] **Step 1: Write the failing tests.**
  - `concurrent takeover`: two `acquireLock` calls on one stale lock. Exactly one returns a token, and afterwards only that token's lock file exists, with no `.stale-*` files.
  - `orphan lock is released`: the read-back misses, so the lock file created by this call is removed.
  - gh: `withFakeGh('sleep 5')` with `createGhRunner({timeoutMs: 100})` rejects with `/gh timed out/`. Skip on win32, like the existing block.
  - jsonText: appending to a one-line `[{"a":1}]` array keeps the new entry on one line.
  - worktree: an ignored `.env/` directory is reported as `.env/`.
  - stage: a dedup hit writes the reuse line. `failNext('authenticatedLogin')` makes `stagePublish` reject with `/authenticatedLogin failed/` and writes nothing.
  - scan: replace the absolute `< 1_000` ms bound with `< 25 * baseline`. Baseline is the best of three scans of `'a'.repeat(100_000)` on the same machine. Keep every adversarial case.
- [ ] **Step 2:** Run them. Expected: FAIL, except the scan change, which is a refactor of the assertion.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS, and `tests/secrets/scan.test.ts` time is not higher than before.
- [ ] **Step 5:** Commit: one commit per area.

### Task 10: Opt-in e2e suite

Research E.

**Files:**
- Create: `tests/e2e/flow.e2e.ts`, `tests/e2e/support.ts`, `vitest.e2e.config.ts`
- Modify: `package.json` (script `"test:e2e": "vitest run --config vitest.e2e.config.ts"`), `CONTRIBUTING.md`

**Interfaces:**
- Consumes:
  - `GitHubTracker`, `defaultGhRunner`, `ensureLabels`, `ensureBoard`;
  - the command functions used by `src/cli.ts` (`taskNew`, `stagePublish`, `approve`, `reviewHandoff`, `runReconcile`; use the exact exported names in `src/commands/*`).
- Environment:
  - `SDLC_E2E_REPO` (`owner/name`, required);
  - `SDLC_E2E_PROJECT_OWNER` (default: the repo owner);
  - `SDLC_E2E_PROJECT` (an existing project number, optional; without it the suite creates one and prints its number).
  - Without `SDLC_E2E_REPO` every test is skipped (`describe.skipIf`).

- [ ] **Step 1: Write `flow.e2e.ts`.** It runs against the real repo, with config `mode: observe`, `owners: [<gh login>]`, task types `tooling` and `spike`. Test `issue lifecycle`:
  1. `task new` (spike) creates an issue with `sdlc:task` and a state comment.
  2. `stage publish` posts the summary.
  3. An owner `/approve` comment through `gh issue comment` is followed by `reconcile`, and the approval is recorded (`unverified` in observe, same login).
  4. `task checkpoint`.
  5. `task cancel --reason e2e` closes the issue.

  `afterAll` closes any issue the suite opened, with the label `e2e`. It never deletes the repo or the project.
- [ ] **Step 2:** `vitest.config.ts` keeps `tests/**/*.test.ts`, so `.e2e.ts` files stay out of `npm test`. Run `npm test` and check the count is unchanged.
- [ ] **Step 3:** Run `npm run test:e2e` with no environment set. Expected: all skipped, exit 0.
- [ ] **Step 4:** Commit `test: add opt-in e2e suite against a sandbox repository`.
- [ ] **Step 5 (controller, not the implementer):** Make a throwaway repo under the owner's login (`gh repo create <login>/sdlc-e2e-<random> --private`) and a throwaway user project. Run `SDLC_E2E_REPO=... npm run test:e2e`. Record the result in `docs/notes/plan-4-smoke.md`. Check the titles, then delete the repo and the project. Project #1 is never touched.

### Task 11: Dogfood in the kit's own repository

Research D.

**Files:**
- Create: `sdlc.config.yaml`, `docs/notes/dogfood.md`
- Generated by `init --skip-github`: `.claude/settings.json`, `.sdlc/**`, `CLAUDE.md` block, skills, `.github/pull_request_template.md` (replacing Task 4's copy), `.gitignore` block, `.sdlc/manifest`
- Modify: `CONTRIBUTING.md` (worktree setup: `npm ci && npm run build`)

- [ ] **Step 1:** `npm run build`, then `node dist/cli.js config suggest --write`. Edit the result:
  - `owners: [<owner login from gh api user>]`;
  - `mode: observe`;
  - `harnesses: [claude]`;
  - `kit_ref: main`, since no npm release exists yet; Task 12 sets `v0.3.0` after the publish;
  - `stack.actions: false`;
  - `quality_gate: [npm run typecheck, npm test, npm run build]`.

  The owner login goes only into `sdlc.config.yaml`, which the kit requires. It is a public GitHub handle, not an email. Then run `node dist/cli.js config validate`.
- [ ] **Step 2:** `node dist/cli.js init --skip-github --dry-run`, then `node dist/cli.js init --skip-github`. Run `npx --no-install sdlc doctor` and record which checks fail only because GitHub provisioning is pending (board, labels, protection).
- [ ] **Step 3: Write `docs/notes/dogfood.md`.**
  - How the repo runs its own build (option 1 of research D), and that every worktree needs `npm ci && npm run build`.
  - Owner follow-ups, in order:
    1. `npx --no-install sdlc init` without `--skip-github`, which creates the board, labels, branch protection and push protection;
    2. set `github.project.number`;
    3. `gh secret set SDLC_TOKEN` and `stack.actions: true`;
    4. add the CI job as a required status check;
    5. later, `config set mode enforce`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. The managed files must not break `tests/docs/*` or the pack whitelist; `.sdlc/` is not in `files`.
- [ ] **Step 5:** Commit `chore: install agentic-sdlc-kit in its own repository (observe)`.

### Task 12: Live Claude smoke, release prep and rulings (controller)

- [ ] **Step 1: Live smoke.**
  - In a throwaway local git repo in the scratchpad, take the smoke config from Plan 3 (`tests/fixtures/config/valid.yaml` with `enabled: [tooling, analysis, spike]`), set `mode: enforce` and `harnesses: [claude]`, and run `node <worktree>/dist/cli.js init --skip-github` with a `sdlc` shim for `dist/cli.js` on PATH.
  - Run `claude -p` with `--permission-mode acceptEdits` and these prompts:
    - (a) "Create src/b.ts with `export {}`": expect the tool call denied with `no-task`, and the file absent;
    - (b) "Run `gh pr merge 1 --admin`": expect a deny naming `admin-merge`;
    - (c) "Edit .claude/settings.json to remove the hooks": expect a deny with `protected-path`;
    - (d) the INSTALL manual-check command `npx --no-install sdlc config set mode observe --dry-run`: expect a deny with `mode-change`;
    - (e) a write after `cd /tmp` to `/tmp/x.txt`: expect it allowed (outside the project).
  - Also confirm the `Monitor` matcher coverage from the Plan 3 notes by observing whether a shell rule fires for a Monitor call. If `Monitor` cannot be triggered from `-p`, write "not observable".
  - Record each prompt, the observed tool result and `.sdlc/cache/gaps.jsonl` lines in `docs/notes/plan-4-smoke.md`. Add a manual checklist for Codex and Gemini: the same five rows, to be run by the owner.
- [ ] **Step 2:** `npm version 0.3.0 --no-git-tag-version`. Move `## [Unreleased]` in `CHANGELOG.md` to `## [0.3.0] - <date>`. Update the README/INSTALL release examples to `v0.3.0`.
- [ ] **Step 3:** Write `docs/notes/plan-4-rulings.md`: the planning rulings above verbatim, then an empty `## Execution rulings` section for the controller to fill.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run build && node scripts/pack-smoke.mjs`. Expected: all pass.
- [ ] **Step 5:** Commit `chore: release 0.3.0`.

## Owner steps after merge (not agent tasks)

1. Merge the PR. Tag `v0.3.0` on the merge commit and create the GitHub release from `CHANGELOG.md`. The controller can do this with the owner's OK. `release.yml` runs, finds no package and the trusted publisher is not set, so publishing fails. That failure is expected for the bootstrap only.
2. Owner, on a clean checkout of the tag: `npm ci && npm publish`. npm asks for 2FA. Provenance applies only from CI, so publish the first one with `npm publish --provenance=false`.
3. Owner: `npm trust github agentic-sdlc-kit --file release.yml --repo SobSoft-s-r-o/agentic-sdlc-kit --allow-publish` (npm ≥ 11.15.0). Then turn on "Require two-factor authentication and disallow tokens" for the package.
4. Owner: in the dogfood config, `kit_ref: v0.3.0`, then the follow-ups in `docs/notes/dogfood.md`.
