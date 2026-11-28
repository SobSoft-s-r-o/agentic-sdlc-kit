# Plan 4 rulings

Decisions taken while planning Plan 4 (open-source packaging, npm, CI, dogfood and the Plan 3 deferrals), then those taken during its execution. Each binds the code on this branch; the spec remains the authority where a ruling is silent.

## Rulings made while planning

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

## Execution rulings

- The PR template is not created by hand in Task 4; `init` renders the managed one in Task 11, because `init` keeps unmanaged files and would never replace a hand copy — cost: no template between those commits.
- A stale `dist/` cannot reach npm: the owner publishes from a clean checkout of the tag and CI's pack smoke builds fresh — cost: none.
- `parseTokenScopes` lives in `src/install/doctor/preflight.ts` after the split — cost: none.
- The default `kit_ref` (`v` plus the installed version) makes `doctor` fail `kit.ref` until that version is on npm — accepted for the bootstrap window — cost: one failing check until 0.3.0 is published.
- The `api-merge` rule skips an explicit GET/HEAD, and the last `-X`/`--method` wins, as `gh` reads it — a GET-then-PUT form must not pass — cost: none.
- A GraphQL failure while reading PR body edit times warns through an optional `warn` callback (stderr), not in the command result, to keep the `Tracker` type unchanged — cost: the warning is not in `--json` output.
- `--unverified` approvals are stamped `now` when that is strictly after every GitHub timestamp, else the newest timestamp plus 1 ms — the brief's literal formula contradicted its own clock-ahead test — cost: none.
- A gap flush that changes the state comment can void a pending `/approve` type comment — fails safe, the owner repeats the command — cost: an occasional repeat.
- A missing or unknown `Scope:` in a PR body counts as final, so `reconcile` removes `sdlc:partial` — cost: a label flip on a malformed body.
- The sync lock keeps a `<lock>.takeover` claim file in addition to the atomic rename: rename-only takeover let two syncs run with 8 or more racing processes — cost: one extra file, and a crashed takeover blocks others for up to 30 s. Accepted residual: a live sync silent for over 10 minutes can still be judged stale.
- The SIGKILL escalation timer for a timed-out `gh` is unref'd, so a `gh` that ignores SIGTERM survives if `sdlc` itself exits within the 2 s grace — cost: a rare stray process.
- The e2e suite runs the commands in-process through a fail-closed `gh` guard, and cancels through `approve <n> cancel --unverified` because there is no `task cancel` command — cost: none.
- In the kit's own repository the owner's public GitHub login appears in `sdlc.config.yaml` and in the generated `sdlc-task-tracking` skill, which renders the owner list by design — cost: the pre-push privacy scan allows those two files.
- The kit's own repository sets `stack.graphify: false`, since it ships no `graphify-out/` — cost: none.
- Small fix rounds were re-reviewed by the controller inline when the diff was mechanical and fully visible (Tasks 4, 5, 7, 8, 9, 10 round 2, 11) — cost: no independent seat for those rounds.

## Follow-ups (not done in Plan 4)

- `reopenedAt` and prompt approvals are stamped by the local clock.
- Reading PR body edit times fails open all-or-nothing, and its warning reaches stderr only (in Actions, the job log).
- `tests/cli.test.ts` and `tests/packaging.test.ts` both build into `dist/`; a parallel run can see a half-written `dist/` (seen once).
- Live hook smoke for Codex and Gemini (manual checklist in `docs/notes/plan-4-smoke.md`).
