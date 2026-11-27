# Plan 1 sandbox smoke (2026-11-27)

Run against a throwaway private repository and a fresh user-owned Projects v2 board, using the
built CLI (`node dist/cli.js`, head `5308fb6`). Config: `mode: enforce`, task types `feature` and
`tooling`, one target `web` (`deploy.via: manual`), the authenticated login listed as owner.
The board and repository were deleted afterwards.

## Flow and results

| Step | Command | Result |
| --- | --- | --- |
| 1 | `sdlc board ensure` (no project number) | Created the project, 11 fields, 5 Status options, 4 views; asked to set `github.project.number`. |
| 2 | `sdlc board ensure` (number set) | "Fields and options are up to date" (add-only, idempotent). |
| 3 | `sdlc task new --type tooling …` | Issue #1 created, on the board at Intake. |
| 4 | PR #2 body `Related to #1` / `Scope: final`; `sdlc review handoff 1 --pr 2` | First attempt failed: PR "not linked" (search index lag, see F1). Succeeded ~20 s later: In review, waiting on Owner. |
| 5 | merge PR #2; `sdlc reconcile --dry-run`, `sdlc reconcile`, `sdlc reconcile` | Dry run and real run reported the same 3 actions (`pr_merged`, `fields_synced`, `issue_closed`); third run 0 actions. Issue closed as completed; board Status Done. |
| 6 | `sdlc task new --type feature …`; PR #4 `Targets: web`; handoff; merge; `sdlc reconcile` | `pr_merged` → Awaiting deployment, Pending targets `web`; issue stays open. |
| 7 | `sdlc deploy record --target web --sha <main> --verify true` | Deployment created; follow-up reconcile: `targets_deployed`, `delivery_report`, `fields_synced`, `issue_closed`. Next reconcile 0 actions. Board Done. |
| 8 | `sdlc stage publish … --needs-approval`, then `/approve` comment from the same login | `ignored_approval` (agent's own login, enforce mode); task stays Paused, `sdlc status` lists it under "Waiting on the owner". |

## Findings

- **F1: `review handoff` right after opening a PR fails.** `listTaskPrs` uses `gh pr list --search`,
  and GitHub's search index lags a newly created PR by seconds. When `--pr N` is given, handoff
  should read that PR directly (`gh pr view N`) and check its body. Reconcile only lags one run.
- **F2: deployment links are API URLs.** The delivery report and actions show
  `https://api.github.com/repos/…/deployments/<id>`, which is not a page a person can open.
  Prefer the deployment status `environment_url`/`log_url`, else the repository's
  `…/deployments/<environment>` page.
- **F3: `board ensure` prints the "Created project" line twice** (once with the URL, once without).
