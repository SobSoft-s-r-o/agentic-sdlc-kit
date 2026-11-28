---
name: sdlc-delivery
description: "Use when a tracked task is ready for review, merge or deployment, or is being finished, split into several PRs, cancelled or reopened: review, merge by the owner, deploy on explicit confirmation, deploy record, reconcile, Done."
---

# Delivery

The path of a task to Done: review, merge (owner) and, for a type that ends on a deployment, deploy (explicit owner confirmation), record the deployment, reconcile, Done. Which steps a task needs depends on how its type ends (instruction block). `sdlc` means `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#v1.2.3` unless `sdlc` is on PATH.

## 1. Review

1. Run the quality gate and fix every failure:
   - none is configured: run the project's tests and linters and report what you ran.
2. Open the PR from `task/<issue>-<slug>` against `main`. Its body has `Related to #<issue>`, `Scope: partial` or `Scope: final`, and a short account of what you verified and the result. Never use `Fixes`, `Closes` or `Resolves`.
3. `sdlc review handoff <issue> --pr <number>`, then wait. Answer review findings with new commits on the same branch; never rewrite published history and never `git push --force`.

## 2. Merge

Only the owner merges. Never merge a PR yourself, even when it is green. When the owner has merged, run `sdlc reconcile --issue <issue>`.

Never `gh pr merge --admin`; never bypass checks, reviews or branch protection. If they block you, say what blocks and stop.

What a final merge does depends on the type: it ends the task (merge), waits for the deployment of every target (deploy), or leaves the task Paused and Waiting on owner (acceptance or confirmation).

Partial PRs: a task may have several PRs. `Scope: partial` merges are recorded but end nothing. Only a merged `Scope: final` PR triggers the type's end. The task's targets are the union of the `Targets:` lines of its PRs, and a deployment satisfies the task only when it contains every merged PR of the task.

## 3. Deploy

Only for types that end on deploy, and only after the owner's explicit confirmation in the current turn. A merge, a green check or an earlier "go ahead" is not confirmation.

No deployment targets are configured, so no type here ends on a deployment.

## 4. Types that end on the owner

- Acceptance (analysis, spike, artifact): publish the result with `sdlc stage publish <issue> <phase> --file <summary.md>` for the phase before `delivery`. The owner accepts with a `/accept` comment. An artifact may instead end on its merge.
- Confirmation (production-data): after the final merge the owner runs the script and posts `/ran`. You never run it; you only record the backup and dry-run evidence before review.

Do not mark any of these done yourself; reconcile applies the owner's comment, or run `sdlc approve <issue> accept|ran --comment-url <url>`.

## 5. Cancellation

Only the owner cancels, with a `/cancel <reason>` comment, recorded by reconcile or by `sdlc approve <issue> cancel --comment-url <url>`. It posts a cancel report, sets Done with the reason and closes the issue as not planned. Then stop work, leave open PRs to the owner's call, and ask the owner before discarding unmerged work. Remove the worktree only with `git worktree remove` (no force) and the branch only with `git branch -d`; if either is refused, say so.

## 6. After Done

Fast-forward the local `main` (`git pull --ff-only`), then remove the task's worktree and merged branch as above. To continue a Done task, `sdlc task reopen <issue>`: it restarts at the first phase and every earlier approval must be given again.
