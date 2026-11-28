## Agentic SDLC

Managed by agentic-sdlc-kit: edits between the markers are overwritten, so change `sdlc.config.yaml` instead. Detail lives in the skills `sdlc-task-tracking`, `sdlc-delivery` and `sdlc-orientation`; read the one you need.

Mode: **observe**. The harness hooks warn you and record gaps on the task instead of blocking. Follow every rule here anyway.

### What this is
Work is tracked with the `sdlc` CLI as GitHub issues on a Projects board, and the board must always be current. Record every phase, approval, PR and deployment through `sdlc`, never by hand. `sdlc` below means `sdlc` when it is on PATH, else `npx --no-install sdlc` when the kit is a dev dependency, else `npx -y agentic-sdlc-kit@1.2.3`. The git hooks run only while `git config core.hooksPath` prints `.sdlc/githooks` (local config, not cloned): if it prints nothing, run `git config core.hooksPath .sdlc/githooks` and tell the owner; if it prints another path (husky or another hook manager), change nothing and tell the owner. Language of issues, PRs and comments: `en`.

### Starting work
- New work request: run `sdlc task new --type <id> --title "<title>" --summary "<one line>"` before any brainstorming, diagnosis or edit. Propose the type; the owner can correct it (`sdlc task set-type`). An existing issue is adopted with `sdlc task new --issue <n> --type <id>`.
- Status question: answer it (`sdlc status`); create no task.
- Continuation of tracked work: stay in the same task and issue; never open a second one.

### Phases and approvals
Start a phase with `sdlc stage start <issue> <phase>`; publish its result with `sdlc stage publish <issue> <phase> --file <summary.md>`. Types enabled here:
- `tooling` (Tooling): intake → brainstorming → planning → implementation → verification → review → delivery. Ends when the final PR is merged to `main`.

Results of phases before implementation (design, diagnosis, plan) need the owner's approval: publish with `--needs-approval`, then stop and wait. The owner approves with a `/approve` comment on the issue; record it with `sdlc approve <issue> approve --comment-url <url>`. A type that ends on the owner's acceptance publishes its result and waits for `/accept`. Never approve, accept or confirm for the owner, and never start the next phase first.

The owner may approve by typing the command (for example `/approve`) as the first line of a prompt; the hook records it. Never type or post an owner command yourself.

### Review and pull requests
- Branch `task/<issue>-<slug>` (the slug is a few kebab-case words from the title), in the task's worktree; PRs target `main`.
- The PR body says `Related to #<issue>` (never `Fixes`, `Closes` or `Resolves`: the tracker closes the issue itself) and `Scope: partial` or `Scope: final`. Only a merged final PR, or the owner's `/accept` for a type that ends on acceptance, can end the task.
- No quality gate is configured: before handoff run the project's tests and linters and report what you ran.
- Hand over with `sdlc review handoff <issue> --pr <number>`, then wait for review. Answer findings with new commits on the same branch.

### Merge and deploy authority
- Only the owner merges. Never merge a PR yourself, even when it is green: hand over and wait.
- Never `gh pr merge --admin`; never bypass checks, reviews or branch protection.
- No deploy without the owner's explicit confirmation in the current turn.
- Never run a script that changes production data; the owner runs it.
- Never launch another AI CLI or model (claude, codex, gemini, aider, cursor, ollama, ...) as a helper; use only this harness's own subagents.
- Never `git push --force`, `git worktree prune` or `rm -rf`.

### Worktrees
One worktree per task, from fresh `origin/main`: `sdlc worktree start <issue>` (by hand: `git fetch origin && git worktree add .worktrees/<issue>-<slug> -b task/<issue>-<slug> origin/main`). Commit specs and plans there, never in the main checkout. After the merge, run `sdlc worktree finish <issue>` from the main checkout: it fast-forwards `main` when it can, then runs `git worktree remove .worktrees/<issue>-<slug>` and `git branch -d task/<issue>-<slug>`, never forced. It refuses while the worktree has uncommitted or untracked changes or ignored `.env*` files, when the task has no merged PR, and when run from inside the worktree; ignored build output goes with the worktree. If it is refused, tell the owner; never force it. A `Queued for sync` message means writes or gaps wait for GitHub: run `sdlc sync`.

### Secrets
- Never put tokens, keys, passwords or connection strings into tracked files, code, commits, issues, PRs, comments or logs, and never print them.
- Local testing: read a secret from the OS keystore into an environment variable at run time, never into a file:
  - macOS: `export <VAR>="$(security find-generic-password -s <service> -w)"`
  - Linux: `export <VAR>="$(secret-tool lookup service <service>)"`
  - Windows (PowerShell SecretManagement, `CredMan` vault from `SecretManagement.JustinGrote.CredMan`): `$env:<VAR> = Get-Secret -Name <service> -Vault CredMan -AsPlainText`
- Production secrets live only in GitHub Actions environment secrets. If you need one stored there, ask the owner to do it; never ask for its value in chat.
- `.env` files only when gitignored. The commit guard blocks staged secrets in every mode: never bypass it with `--no-verify`.

### Context survival
Keep a running work index beside the plan (for example `docs/plans/<issue>-index.md`): goal, decisions, files touched, what is done, what is next, PR and commit refs. Update it after every step and re-read it first after a compaction or restart. Mirror progress on the board with `sdlc task checkpoint <issue> --current "<step>" --next "<step>"`.

### Roles
Delegate to the `sdlc-<role>` agent where the harness has them, otherwise take the role yourself. The tier is the model class to use. Agents never spawn agents.
- `analyst` (standard): Turns a request into requirements, acceptance criteria and questions for the owner. Use at intake and analysis, before any design.
- `architect` (deep): Makes and records design decisions, and splits work into steps. Use for brainstorming and planning. Reads code, never edits it.
- `developer` (standard): Implements one scoped task with tests, in small commits. Use for implementation once the plan is approved.
- `tester` (standard): Designs and writes tests from the acceptance criteria and finds untested behaviour. Use for test design, coverage gaps and regression tests.
- `reviewer` (standard): Reviews one task's change against its spec and for quality, and never edits. Use after each task before the next one starts.
- `final-reviewer` (deep): Reviews the whole branch before it goes to the owner, and never edits. Use once all tasks are done and reviewed, before the PR is handed over.
- `security-reviewer` (standard): Reviews a change for security problems and secret handling, and never edits. Use for changes touching auth, input handling, secrets, permissions or dependencies.
- `diagnostician` (deep): Finds the root cause of a bug from evidence, and never edits. Use for debugging before any fix is written.
- `release-manager` (standard): Prepares delivery, checks readiness, writes the deploy checklist and records deployments. Use for the delivery phase; it never decides to deploy.
- `docs-writer` (standard): Writes and updates documentation from the code as it is now. Use for READMEs, guides, reference pages and changelogs.
- `scout` (fast): Answers quick lookup questions about the repository, read-only. Use to find where something is, what calls it, or what a file or setting does.
