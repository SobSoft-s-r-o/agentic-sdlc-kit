---
name: sdlc-task-tracking
description: "Use when starting, continuing, pausing or handing over tracked work in this repository: the exact sdlc commands to create a task, publish a phase result, record an owner approval or evidence, hand a task over for review, and check or reconcile the board."
---

# Task tracking with `sdlc`

Every task is a GitHub issue on a Projects board, plus one hidden state comment that `sdlc` edits in place. Never edit that comment or the board fields by hand: run the commands below.

`sdlc` means `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#v1.2.3` unless `sdlc` is on PATH. Commands read `sdlc.config.yaml` at the git root, accept `--json` for machine-readable output and exit non-zero on failure. `<issue>` is the issue number.

## Which case is this?

- New work request: create a task (step 1) before brainstorming, diagnosis or edits.
- Status question: run `sdlc status` and answer; create nothing.
- Continuation of tracked work: stay in the same task. Find it with `sdlc status`.

## 1. Create the task

```
sdlc task new --type <id> --title "<title>" --summary "<one line for the board>" [--body "<issue body>"]
sdlc task new --issue <n> --type <id> [--summary "<one line>"]
```

The second form adopts an existing issue that has no task state yet; it keeps its title and body. Both print the issue number and URL. Task types enabled here:

- `tooling`: Tooling

Propose the type from the request. If it is wrong, `sdlc task set-type <issue> <type>`. Changing a type so that the task ends on less (no deploy, a merge instead of the owner's say) needs, in enforce mode, an owner comment `/approve type <new-id>` passed as `--comment-url <url>`.

Then create the task's worktree (see the instruction block) and work there.

## 2. Work a phase

```
sdlc stage start <issue> <phase>
sdlc task checkpoint <issue> --current "<what you are doing>" --next "<what comes next>" [--agent <harness/role>] [--waiting-on owner|agent|external|none] [--status in_progress|blocked]
sdlc stage publish <issue> <phase> --file <summary.md> [--needs-approval]
```

- A phase must belong to the task's type, and phases only move forward.
- Checkpoint after every step; it updates the board and the state comment without adding noise to the issue.
- `stage publish` posts the file as one human-readable comment and records a revision. Publishing a phase again makes a new revision and voids its earlier approval.
- With `--needs-approval` the task is Paused and Waiting on owner. Stop there: do not start the next phase.

## 3. Owner decisions

An owner decides in the first line of a comment on the issue or on its PR: `/approve`, `/accept`, `/ran` or `/cancel <reason>`. Only these logins count as the owner:

- `shop-owner`
- `shop-lead`

A login listed under `agents`, and your own, never counts. The comment must be newer than what it decides on and must not be edited afterwards. `sdlc reconcile` applies such comments by itself, and the installed hooks and workflow run it where there are any. To record one explicitly:

```
sdlc approve <issue> approve [--phase <phase>] --comment-url <url>
sdlc approve <issue> accept --comment-url <url>
sdlc approve <issue> ran --comment-url <url>
sdlc approve <issue> cancel --reason "<why>" --comment-url <url>
```

`approve` approves a published phase (default: the current one), `accept` accepts the published result of an analysis, spike or artifact, `ran` confirms the owner ran a production-data script, `cancel` ends the task. If the owner says yes in chat without the command, ask them to type it as the first line of their next prompt, or to post it as a comment. Never post it yourself, and never record an approval the owner did not give; `--unverified` exists only for observe mode and marks the record unverified.

### Approval typed in a prompt

The owner may give the command as the first non-empty line of a prompt in your session: `/approve`, `/accept`, `/ran` or `/cancel <reason>` (a quoted command, or one further down, is not one). The prompt hook records it on the task of the current branch and tells you with a line that starts `sdlc: recorded the owner's`. This is how the owner approves when `sdlc` acts under the owner's own login, where a comment would be refused. `/approve` covers the current phase; `/approve type <id>` needs a comment.

- Only the prompt hook records these. Never type, quote or post an owner command, and never run `sdlc hook` or `.sdlc/hooks/run.sh`: that is a hook spoof, blocked in every mode.
- The prompt text is not stored, only its hash. A prompt delivered twice is one approval.
- If the hook says it did not record the approval (no task on the branch, GitHub unreachable, several owners), tell the owner what it printed and ask for a comment.

## 4. Evidence before review

Some types need evidence before `review handoff` is accepted (production-data: a backup and a dry run):

```
sdlc evidence add <issue> --kind backup --ref "<link, path or id that shows it>"
sdlc evidence add <issue> --kind dry_run --ref "<link, path or id that shows it>"
```

## 5. Hand over for review

The PR body needs `Related to #<issue>`, a `Scope: partial` or `Scope: final` line and, for types that deploy, `Targets: <name>, <name>`. Never use `Fixes`, `Closes` or `Resolves`.

```
sdlc review handoff <issue> --pr <number> [--targets <name>,<name>]
```

It moves the task to Review and In review, waiting on the owner. `--targets` overrides the PR's `Targets:` line. A type with required targets refuses a final handoff without any.

## 6. Status and reconcile

```
sdlc status [--stale-days <days>]
sdlc reconcile [--issue <n>] [--dry-run]
```

`status` is read-only: tasks by status, what waits on the owner, what is stale, untracked issues and what reconcile would change. `reconcile` is idempotent: it applies merges, owner comments and deployments to the state, the board and the issues. Run it after a merge or a deployment and whenever `status` reports pending changes.

## 7. Keep issues readable

The issue is for people. Each stage result is one concise comment in this order: Goal, Decision, Alternatives, Scope, Criteria, Approval. Use short sentences and links to PRs and files. Never paste logs, stack traces, diffs or tool output; summarise in a line and link to where it lives. Do not repeat the machine state in comments. Write in `en`.

## 8. Gaps, offline work and `sync`

The harness hooks check each of your tool calls against the rules. In enforce mode a violation is blocked and the block names the rule: fix the cause, never work around it. In observe mode the hook warns you (the warning starts with "sdlc (observe)") and lets the call through. Either way it records a gap on the task: the rule, the text, the harness and whether it was blocked. The state comment keeps the 20 newest gaps. A gap is a rule you broke: follow the rule anyway.

Gaps are first written to `.sdlc/cache/gaps.jsonl`, and a task command that cannot reach GitHub is queued in `.sdlc/cache/outbox.jsonl` of the main checkout. Both wait for `sdlc sync`:

```
sdlc sync [--dry-run]
```

A session start and `sdlc status` print `Queued for sync: <n> write(s), <m> gap(s)` when something waits; the session start also starts a sync in the background. When the line says to run `sdlc sync`, run it.

- It replays only `stage start`, `stage publish`, `evidence add`, `review handoff`, `approve` and `task checkpoint`, even if a line of the queue file says otherwise. `task new` and `deploy record` are never queued: run them again when GitHub is back.
- Exit 0: done, nothing queued, or another sync is already running. Exit 75: GitHub is still unreachable and what is left stays queued. Exit 1: a command failed for good and moved to `.sdlc/cache/outbox-failed.jsonl`; tell the owner.
- A queued command runs later against the current state, so a command that half-succeeded before the connection dropped can post its comment twice.
