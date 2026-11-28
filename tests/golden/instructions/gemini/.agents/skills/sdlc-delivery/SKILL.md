---
name: sdlc-delivery
description: "Use when a tracked task is ready for review, merge or deployment, or is being finished, split into several PRs, cancelled or reopened: review, merge by the owner, deploy on explicit confirmation, deploy record, reconcile, Done."
---

# Delivery

The path of a task to Done: review, merge (owner) and, for a type that ends on a deployment, deploy (explicit owner confirmation), record the deployment, reconcile, Done. Which steps a task needs depends on how its type ends (instruction block). `sdlc` means `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#v1.2.3` unless `sdlc` is on PATH.

## 1. Review

1. Run the quality gate and fix every failure:
   - `npm test`
   - `npm run lint`
2. Open the PR from `task/<issue>-<slug>` against `main`. Its body has `Related to #<issue>`, `Scope: partial` or `Scope: final`, `Targets: <name>, <name>`, and a short account of what you verified and the result. Never use `Fixes`, `Closes` or `Resolves`.
3. `sdlc review handoff <issue> --pr <number>`, then wait. Answer review findings with new commits on the same branch; never rewrite published history and never `git push --force`.

## 2. Merge

Only the owner merges. Never merge a PR yourself, even when it is green. When the owner has merged, run `sdlc reconcile --issue <issue>`.

Never `gh pr merge --admin`; never bypass checks, reviews or branch protection. If they block you, say what blocks and stop.

What a final merge does depends on the type: it ends the task (merge), waits for the deployment of every target (deploy), or leaves the task Paused and Waiting on owner (acceptance or confirmation).

Partial PRs: a task may have several PRs. `Scope: partial` merges are recorded but end nothing. Only a merged `Scope: final` PR triggers the type's end. The task's targets are the union of the `Targets:` lines of its PRs, and a deployment satisfies the task only when it contains every merged PR of the task.

## 3. Deploy

Only for types that end on deploy, and only after the owner's explicit confirmation in the current turn. A merge, a green check or an earlier "go ahead" is not confirmation.

Deployment targets:

- `web`: environment `production-web`, Actions workflow `.github/workflows/deploy-web.yml`.
- `api`: environment `production-api`, script `./scripts/deploy-api.sh`.

Record a deployment that happened (it never deploys anything):

```
sdlc deploy record --target <name> --sha <commit> [--verify "<command that exits 0 when the deploy is live>"]
```

- The commit must be on `main`; use the merge commit or a later one.
- A workflow that deploys through a GitHub environment records the deployment itself; `deploy record` is then only a fallback. For `release` targets a published GitHub Release counts.
- Recording is evidence, not authorization. Reconcile runs right after it: when every pending target has a successful deployment containing every merged PR, it posts the delivery comment, closes the issue and sets Done.
- A later rollback does not reopen a Done task. Track it as a new bugfix task.

## 4. Types that end on the owner

- Acceptance (analysis, spike, artifact): publish the result with `sdlc stage publish <issue> <phase> --file <summary.md>` for the phase before `delivery`. The owner accepts with a `/accept` comment. An artifact may instead end on its merge.
- Confirmation (production-data): after the final merge the owner runs the script and posts `/ran`. You never run it; you only record the backup and dry-run evidence before review.

Do not mark any of these done yourself; reconcile applies the owner's comment, or run `sdlc approve <issue> accept|ran --comment-url <url>`.

## 5. Cancellation

Only the owner cancels, with a `/cancel <reason>` comment, recorded by reconcile or by `sdlc approve <issue> cancel --comment-url <url>`. It posts a cancel report, sets Done with the reason and closes the issue as not planned. Then stop work, leave open PRs to the owner's call, and ask the owner before discarding unmerged work. Remove the worktree only with `git worktree remove` (no force) and the branch only with `git branch -d`; if either is refused, say so.

## 6. After Done

Run `sdlc worktree finish <issue>` from the main checkout, never from inside the task's worktree. It fast-forwards the local `main` when that checkout is on it and clean, then removes the worktree (`git worktree remove`) and the merged branch (`git branch -d`), never forced. `--dry-run` shows the plan first.

- It refuses while the worktree has uncommitted or untracked changes, holds an ignored `.env` or `.env.*` file, or none of the task's PRs has merged. Move the `.env` file out and commit or discard the changes with the owner's say, then run it again.
- Other ignored files (`node_modules`, build output) are deleted together with the worktree. Anything you want to keep must be committed or moved out first.
- A refused `git branch -d` (a squash merge, say) keeps the branch and is no failure: tell the owner, never `git branch -D`.
- `sdlc status` lists orphan worktrees under `.worktrees/`: one whose task is done is due for `sdlc worktree finish`, and the others (no tracked task, detached HEAD, directory gone) are for the owner to look at.

To continue a Done task, `sdlc task reopen <issue>`: it restarts at the first phase and every earlier approval must be given again.
