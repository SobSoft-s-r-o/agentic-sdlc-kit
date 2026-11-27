# Plan 2 sandbox smoke

Date: 2026-11-28. Built CLI (`node dist/cli.js`, version 0.1.0) against a throwaway private
repository owned by the maintainer's user account, with a new user-owned Projects v2 board. Both
were deleted after the run (title checked first). gh 2.81, Node 22, token scopes `repo`, `project`,
`workflow`.

Fixture: a fresh repository with a README and a one-line `CLAUDE.md`.

## Steps and results

| Step | Result |
|------|--------|
| `doctor --preflight` | all ok; `config.present` warn (expected); exit 0 |
| `config suggest --write` | wrote `sdlc.config.yaml`: claude, observe, owner_only, 5 task types without targets |
| `config validate` | `Config OK` |
| `init --dry-run` | 23 planned changes (11 agents, 3 skills, PR template, workflow, `.gitignore`, `.mcp.json`, 4 git hooks, `CLAUDE.md` block); board, labels and protection reported as "would"; no file, git config or GitHub change |
| `init` | files written, `core.hooksPath` set, project created with all fields, options and views, 7 labels, branch protection on `main`; push protection reported unavailable (private repository on a plan without it) as `skipped` with the local-guard note; project number printed with the instruction to put it in the config |
| config edit (`number: 5`), second `init` | no-op: "Everything is up to date", board, labels and protection unchanged |
| `doctor` | all ok except the expected: `actions.secret` fail (no `SDLC_TOKEN`), `sdlc.onPath` warn and `secrets.guard` fail (sdlc not installed), `mcp.token` warn, `secrets.pushProtection` warn; exit 1 |
| `sdlc` on PATH, commit with a generated fake GitHub token | pre-commit blocked: masked value (`ghp_…(40 chars)`) and fingerprint only; commit without it passed |
| `git commit --no-verify` with a token, then `git push` | pre-push blocked, nothing reached the remote; branch-rule warning printed (observe mode) |
| `doctor` with sdlc on PATH | `sdlc.onPath` ok, `secrets.guard` ok |
| `uninstall` | 24 changes, `core.hooksPath` unset, `sdlc.config.yaml` kept, "GitHub was not touched" message; tree equal to the pre-init commit except `sdlc.config.yaml` |

## Findings

1. Empty directories remain after `uninstall` (`.claude/`, `.github/workflows/`). Git ignores them,
   so the tree compares equal, but they are untidy. Known deferred minor (prune stops at top-level
   roots).
2. The push-protection warning on a private repository says "not an admin, or the plan has none"
   even for the owner. Accurate but could name the plan case first.
3. `doctor` correctly fails until `sdlc` is installed; INSTALL.md's dev-dependency step is needed for
   the secret guard to be active.

No crash, no secret printed, no mutation in dry run, second init idempotent.
