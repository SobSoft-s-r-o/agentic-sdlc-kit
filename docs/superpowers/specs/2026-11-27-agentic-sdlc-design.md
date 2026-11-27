# agentic-sdlc-kit — Design

Date: 2026-11-27 · Status: approved by owner 2026-11-27 · Name: `agentic-sdlc-kit` · Repository: `SobSoft-s-r-o/agentic-sdlc-kit` (public) · License: MIT

## 1. Intent

The owner runs a mature agent-driven development lifecycle in a private project
("the reference project"): every work request becomes a GitHub issue on a GitHub
Projects board, moves through phases (intake → diagnosis/brainstorming → planning →
implementation → review → delivery), and the board shows at any moment what is in
flight, what waits on whom, and what is merged but not yet deployed. Many tasks run
in parallel; the board being **always current** is the single most valuable property.

That system is welded to the reference project (Slovak field names, a fixed list of
deploy targets, Flutter/Firebase quality gates, absolute paths, ~13k lines of
Python tied to Claude Code hooks). The owner wants the *process* extracted into a
standalone, **open-source, English** project that can be installed into **any**
repository, for **any** agent harness (Claude Code, Gemini CLI, OpenAI Codex, and
others), by pasting a single prompt into the agent.

The reference project is **not touched** and does not migrate to this project.

## 2. Goals, non-goals, anti-goals

**Goals**
1. One-prompt install: the agent asks the install questions in chat, writes a
   config, and runs a non-interactive installer that sets everything up.
2. Multi-harness: generates the correct instruction files, hooks, agent
   definitions and skills for each harness the owner selects.
3. The board is always current: task creation, phase/status transitions, PR links,
   review, merge and deployment are reflected automatically.
4. Task types with distinct end conditions (deploy / merge / report / production
   data / artifact / spike), so "done" is natural and mostly automatic.
5. Deployment evidence comes from **GitHub Deployments / Releases**; one deploy
   closes every task it contains.
6. A library of predefined role agents (analyst, architect, developer, tester,
   reviewer, …) defined once and rendered per harness.
7. Enforcement level chosen at install: `observe` or `enforce`.
8. Installs the agent environment stack: Superpowers, graphify, hooks/guards, and the
   MCP servers the agents need (GitHub MCP by default, others optional).

**Non-goals (v1)**
- Migrating or changing the reference project.
- Non-GitHub trackers (Jira, Linear, GitLab). Design keeps the GitHub layer behind
  an interface, but only GitHub ships.
- Running deployments itself. The project records and reacts to deployments; the
  project's own scripts/CI perform them.
- A hosted service or GitHub App. Everything runs from the repo, the local CLI and
  optional GitHub Actions.
- Domain rules of any specific project (those stay in the target project's own
  instructions, preserved outside managed blocks).

**Anti-goals (failure even if it "works")**
- The board drifts from reality (stale "awaiting deployment", tasks stuck after a
  bug like the reference project's #573).
- Issues become unreadable machine logs (reference project #563 has 131 comments,
  revision 136). Humans must be able to read an issue top to bottom.
- Logic duplicated per harness. One core; harness adapters stay thin.
- Agents gaining authority they should not have: merging without the owner's
  instruction, deploying without explicit confirmation, running production-data
  scripts, launching other AI CLIs.
- Install clobbers the user's existing `CLAUDE.md` / `AGENTS.md` content.

## 3. Constraints

- Language: everything English (prompts, board labels, docs, CLI).
- License: MIT (owner decision). Repository `SobSoft-s-r-o/agentic-sdlc-kit`, public.
- Runtime: Node.js ≥ 20 (present wherever Claude Code, Gemini CLI and Codex are
  installed, all of which ship via npm). No Python requirement for the core.
- GitHub access through `gh` CLI (auth reused; needs `project` scope) — the
  installer verifies `gh auth status` and scopes.
- Works for org-owned and user-owned repositories and Projects (v2).
- GitHub Actions must remain **optional** (the reference project disables them for
  billing reasons); every automation that runs in Actions also runs locally.
- **Reference project access**: the builder may read the reference project
  (read-only, location kept outside this repository) to extract rules and edge cases. It is
  **private**: no code, issue text, names, domain terms or identifiers from it may
  be copied into this public repository; regression tests are rewritten as generic
  scenarios.
- Harness capabilities verified 2026-11 (re-verify at build time):
  - Claude Code: hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
    `PostToolUse`, `Stop`, `SubagentStop`, …) in `.claude/settings.json`;
    subagents in `.claude/agents/*.md`; skills in `.claude/skills/`; `CLAUDE.md`.
  - Gemini CLI: hooks (since v0.26, command type, `BeforeTool`/`AfterTool` and
    lifecycle events) in `.gemini/settings.json`; `GEMINI.md`; Superpowers ships a
    Gemini extension. Subagent definition format must be verified at build.
  - OpenAI Codex: hooks via `.codex/hooks.json` or `[hooks]` in
    `.codex/config.toml` (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
    `SubagentStart/Stop`, `Stop`; project hooks load only when the project layer
    is trusted); subagent roles under `[agents]` in `config.toml`; `AGENTS.md`.
  - Others (Cursor, Copilot, Antigravity, …): `AGENTS.md` only → instructions-only
    tier.

## 4. Approaches considered

**Install mechanism**
- **A. Agent-driven install (chosen).** Bootstrap prompt → agent reads `INSTALL.md`
  from the repo → asks questions in chat → writes `sdlc.config.yaml` → runs
  `npx agentic-sdlc-kit init --config sdlc.config.yaml` (non-interactive, idempotent).
  Natural, identical across harnesses, repeatable (config is committed).
- B. Interactive terminal wizard. Simpler, but agents drive interactive TTYs badly;
  the "install by prompt" property is lost.
- C. Native per-harness plugins. Most native, but three install paths to maintain.
  May come later as thin wrappers over A.

**Core implementation**
- **A. Fresh TypeScript implementation, reference project as spec (chosen).** Node
  is guaranteed on agent machines; `npx` install; one language for CLI, hooks and
  Actions. Reference code is too coupled to port cleanly; its rules and edge cases
  become test cases.
- B. Port the Python tracker. Faster start, proven logic, but requires Python 3.11+
  everywhere and carries the debt the reference project's #563 is trying to remove.

## 5. Architecture

```
agentic-sdlc-kit (npm package, CLI binary `sdlc`)
├── installer      init / upgrade / doctor / uninstall — reads sdlc.config.yaml,
│                  renders files, provisions GitHub (board, fields, labels, protection)
├── core           task model, task types, state machine, reconcile engine
├── github         gh-backed client: issues, Projects v2 (GraphQL), PRs,
│                  deployments, labels, branch protection; behind a Tracker interface
├── evidence       deployment matching (ancestor check per target), merge detection
├── hooks          one hook entrypoint `sdlc hook <harness> <event>` normalizing
│                  each harness's payload into a common event
├── render         templates → per-harness files (instructions, agents, skills, hooks)
└── templates      canonical content: instruction blocks, agent roles, skills,
                   GitHub workflow files, git hooks, INSTALL.md
```

Single source of truth for task state is **GitHub** (issue + Project item + a hidden
state comment). Local state is a cache plus an outbox for writes that failed (offline,
rate limit); `sdlc sync` flushes it. No local database of evidence.

Every agent interacts through the same CLI (`sdlc task …`, `sdlc stage …`,
`sdlc deploy record …`). Harness hooks only call the CLI; they contain no logic.

## 6. Install flow

1. User pastes the bootstrap prompt (published in README), e.g.
   *"Install agentic-sdlc-kit from https://github.com/<owner>/agentic-sdlc-kit into this
   repository. Follow its INSTALL.md."*
2. Agent reads `INSTALL.md`, runs `npx agentic-sdlc-kit@<version> doctor --preflight`
   (git repo? `gh` authenticated with `repo`,`project` scopes? Node ≥ 20? default
   branch? existing instruction files? existing board?).
3. Agent asks the questions below **one topic at a time** in chat, proposing
   defaults detected from the repo (e.g. detected deploy scripts, workflows with
   `environment:`).
4. Agent writes `sdlc.config.yaml`, shows it, gets the owner's OK.
5. Agent runs `npx agentic-sdlc-kit init --config sdlc.config.yaml`. The installer is
   idempotent and prints a change summary; `--dry-run` shows the plan first (the
   agent runs dry-run before the real run).
6. Installer commits nothing by itself; the agent opens an install PR
   (`chore: install agentic-sdlc-kit`) tracked as the first task (type `tooling`).
7. `sdlc doctor` verifies: hooks fire for each harness, board fields exist, labels
   exist, a test event round-trips.

`sdlc upgrade` re-renders managed files from a newer package version, preserving
user content outside managed blocks and custom agents/types.

### Install questions

1. **Harnesses**: which agents will work in this repo? (multi-select: Claude Code,
   Gemini CLI, Codex, other/AGENTS.md-only).
2. **Board**: use an existing Project (pick from list) or create one; owner
   (org/user). Project title default: `<repo> SDLC`.
3. **Enforcement mode**: `observe` (record and warn) or `enforce` (block).
4. **Task types**: which built-in types are enabled; add custom types.
5. **Deploy targets** (only if a deploy-ending type is enabled): for each target —
   name, GitHub environment name (default `production`), how it is deployed
   (`script` with path, `actions` with workflow file, `manual`), and optional
   path globs used to *suggest* which targets a PR touches.
6. **Quality gate**: command(s) the agent runs before handing off to review
   (e.g. `npm test`, `make check`); optional per target.
7. **Merge policy**: owner-only merge (default) or agent may merge after review +
   green gate when the owner explicitly asks (reference behaviour).
7a. **MCP servers**: GitHub MCP (default on) plus optional servers from the catalog
   (see §14); for each, project-scoped or user-scoped configuration.
8. **Models per tier** for each harness (defaults offered; see §9).
9. **Stack**: install Superpowers (yes default), graphify (yes default), branch
   protection on default branch (yes default), GitHub Actions reconcile workflow
   (**on by default**, owner decision; can be declined, then the board updates only
   from local triggers).
10. **Owners**: GitHub logins whose `/approve`-style comments count (default: the
    authenticated `gh` user).
11. **Language of task content**: board labels stay English; issue summaries may be
    written in the owner's language (config `content_language`, default `en`).

### Config sketch (`sdlc.config.yaml`)

```yaml
version: 1
harnesses: [claude, codex, gemini]
mode: observe            # observe | enforce
github:
  repo: owner/name
  default_branch: main
  project: { owner: owner, owner_type: org, number: 7 }   # filled by init
content_language: en
merge_policy: owner_only # owner_only | agent_on_request
quality_gate: ["npm test"]
task_types:
  enabled: [feature, bugfix, tooling, analysis, production-data, artifact, spike]
  custom: []             # see §7
targets:
  - name: web
    environment: production
    deploy: { via: actions, workflow: .github/workflows/deploy-web.yml }
    paths: ["apps/web/**"]
  - name: api
    environment: production-api
    deploy: { via: script, command: "./scripts/deploy-api.sh" }
models:
  claude: { deep: opus, standard: sonnet, fast: haiku }
  codex:  { deep: <verify>, standard: <verify>, fast: <verify> }
  gemini: { deep: <verify>, standard: <verify>, fast: <verify> }
stack: { superpowers: true, graphify: true, branch_protection: true, actions: true }
mcp:
  servers: [github]          # catalog ids; github on by default
  scope: project             # project | user
```

GitHub field/option IDs are **not** stored in config; they are resolved by name at
runtime and cached locally (fixes the reference project's brittle stored IDs).

## 7. Task types

A task type declares its phases, how it ends, and who may close it.

| Type | Phases | Ends when | Closed by |
|---|---|---|---|
| `feature` | intake → brainstorming → planning → implementation → verification → review → delivery | every declared target has a successful deployment containing the merge commit | automatic (reconcile) |
| `bugfix` | intake → **debugging** → planning → implementation → verification → review → delivery | same as feature | automatic |
| `tooling` (internal tools, CI, docs, refactor) | as feature | full PR merged to default branch | automatic on merge |
| `analysis` (report) | intake → analysis → delivery | report published (file in repo via PR, or report comment) **and** owner accepts | owner acceptance |
| `production-data` (script changing prod data) | as feature + required `backup` and `dry-run` evidence before review | owner confirms they ran it (agent never runs it) | owner confirmation |
| `artifact` (PDF, plan, translation, document) | intake → brainstorming → creation → review → delivery | artifact merged to default branch or attached; owner accepts if not merged | merge or owner acceptance |
| `spike` | intake → exploration → delivery | findings summary published | owner acceptance |

Custom type schema:

```yaml
- id: infra-change
  label: "Infra change"
  phases: [intake, brainstorming, planning, implementation, review, delivery]
  ends_on: deploy        # deploy | merge | owner_acceptance | owner_confirmation
  requires_before_review: [backup]   # evidence kinds that must exist
  targets_required: true
```

Classification: at intake the agent **proposes** a type from the request; the owner
can correct it at any point (`sdlc task set-type`). Type is stored as label
`type:<id>` and Project field **Task type**. A `feature`/`bugfix` declares its targets at
review time (`sdlc stage review --targets web,api`); path globs only suggest.

## 8. Board model and lifecycle

**Project fields** (created if missing; matched by name if the board exists):

| Field | Type | Values |
|---|---|---|
| Status | single select | Ready, In progress, Blocked, Paused, In review, Awaiting deployment, Done |
| Phase | single select | Intake, Debugging, Brainstorming, Analysis, Planning, Implementation, Verification, Review, Delivery |
| Task type | single select | enabled task types (GitHub reserves the name `Type`) |
| Waiting on | single select | Owner, Agent, External, — |
| Summary | text | one line |
| Current step | text | |
| Next step | text | |
| Pending targets | text | e.g. `api` (targets not yet deployed) |
| Agent | text | harness + role currently working, e.g. `claude/developer` |
| Last update | text | ISO timestamp |
| Start / Target date | date | |

Cancellation is a terminal outcome shown as Status = Done, Current step =
`Cancelled — <reason>`, issue closed `not_planned`.

**Existing boards** *(builder's call)*: init only **adds** missing fields and
options; it never renames or deletes options. If adding options to an existing
single-select would clear values on existing items (verify `updateProjectV2Field`
behaviour at build), init refuses for that board and recommends a new one. The
built-in Status field is reused and extended. One board serves one repo in v1, but
every query is scoped by repository so a shared board does not break. Items without
an `sdlc:state` comment are ignored by reconcile and listed as "untracked" by
`sdlc status`.

**Owner approval** (owner decision): an approval, acceptance, production-data run
confirmation, merge instruction or cancellation counts only from one of two sources:
1. **The owner's own chat message**, captured by the harness's prompt-submit hook
   (Claude `UserPromptSubmit`, Codex `UserPromptSubmit`, Gemini equivalent) into a
   local append-only prompt log with session id, prompt id, timestamp and hash. The
   CLI (`sdlc stage approve --prompt <id>`) accepts only a prompt id present in that
   log, from the current session, newer than the result being approved. Agents
   cannot write to the log (hook-owned path; in enforce mode harness hooks block
   agent writes to it).
2. **A GitHub comment `/approve`** (also `/accept`, `/ran`, `/merge`, `/cancel
   <reason>`) on the task issue or PR by a login listed in config `owners:`, newer
   than the published result. Reconcile picks these up; works from mobile and for
   harnesses without hooks.
Each recorded approval stores its source (prompt id or comment URL). In observe
mode, an approval without either source is recorded but flagged as unverified.
`owners` (GitHub logins) is an install question.

**Views** created: Board (by Status), "In flight" (table, not Done, sorted by Last
update), "Awaiting deployment" (grouped by Pending targets), "Waiting on owner".

**Transitions** (who/what triggers):
- New work request → `sdlc task new` (agent, from instructions/hook) → issue +
  Project item, Status Ready/In progress, Phase Intake.
- Phase result published (`sdlc stage <phase> publish`) → human summary comment;
  if owner approval is needed, Status Paused + Waiting on Owner.
- Owner approval recorded (`sdlc stage approve`) → next phase, Waiting on Agent.
- PR opened for the task (branch `task/<issue>-<slug>`, body `Related to #N`) →
  Phase Review, Status In review (on review handoff).
- PR merged to default branch → per type: `ends_on: merge` → Done; `deploy` →
  Awaiting deployment with Pending targets; others → Paused, Waiting on Owner.
- Successful deployment recorded → reconcile (§10) → Done when no targets pending.
- Owner cancels → cancelled outcome.

**Multiple PRs per task** *(builder's call)*: a task may have several PRs. The PR
template has `Scope: partial | final` (mirrored to label `sdlc:partial`). Only a
`final` PR merge triggers the type's end transition; the task stores all merged PR
merge commits, and deploy reconcile requires **every** stored merge commit to be an
ancestor of the deployed SHA. Targets are the union declared across the task's PRs.

PRs never use closing keywords (`Fixes #N`); the tracker closes issues itself when
the task is actually done, so GitHub's auto-close cannot fake Done.

**Issue readability**: each stage result is one human-readable comment (Goal,
Decision, Alternatives, Scope, Criteria, Approval). Machine state lives in a
**single hidden state comment** (`<!-- sdlc:state -->` + JSON) edited in place, not
appended. Checkpoints update the Project fields and that state comment, not new
comments. Approvals record who, when, and the harness session/prompt id when the
harness provides it.

## 9. Agent library

Roles defined once in `templates/agents/<role>.md` (Markdown body + YAML front
matter: `role`, `description`, `tier`, `can_edit`, `tools`, `returns`,
`escalate_when`). Rendered per harness:
- Claude: `.claude/agents/sdlc-<role>.md` (model from tier map).
- Codex: `[agents.<role>]` entries in `.codex/config.toml` (format verified at build).
- Gemini: native subagent files if supported at build time, else "modes" section in
  `GEMINI.md`.
- Instructions-only harnesses: roles described as modes in `AGENTS.md`.

Roles (v1): `analyst` (requirements, acceptance criteria, questions for owner),
`architect` (design decisions, no source edits), `developer` (scoped implementation
+ tests), `tester` (test design and coverage), `reviewer` (per-task spec + quality
review, never edits), `final-reviewer` (whole-branch review, deep tier),
`security-reviewer`, `diagnostician` (evidence-based root cause, no edits),
`release-manager` (delivery: deploy checklist, records deployment, reconciles),
`docs-writer`, `scout` (fast lookups, fast tier).

Default phase → role mapping (used in instructions and written to field Agent):
Intake/Analysis → analyst, Debugging → diagnostician, Brainstorming → analyst +
architect, Planning → architect, Implementation → developer (+ tester),
Review → reviewer / final-reviewer, Delivery → release-manager.

Tiers `deep | standard | fast` map to concrete models per harness via config.
Budget routing from the reference project is generalized: each role has a minimum
tier; escalation allowed with a stated reason; in `enforce` mode the Claude/Codex
PreToolUse hook checks that a subagent dispatch names a role and does not go below
its tier.

Project-specific agents live in `.sdlc/agents/custom/*.md` (same schema), rendered
alongside and never overwritten by upgrade.

## 10. Deployment evidence and reconcile

- **Source of truth**: GitHub Deployments with status `success` for an environment,
  and Releases (a Release counts as a deployment of its tag commit to every target
  configured with `deploy.via: release`).
- **Recording**:
  - `script`: the project's deploy script ends with
    `sdlc deploy record --target api --sha "$(git rev-parse HEAD)"`. The command
    refuses unless the SHA is reachable from `origin/<default_branch>`; it creates
    the Deployment and sets status `success` (optionally after a user-supplied
    `--verify "<command>"` read-back exits 0).
  - `actions`: deploy job uses `environment: <name>`; GitHub creates Deployments
    natively. Installer can add `sdlc deploy record` as a fallback step if the
    workflow doesn't use environments.
  - `manual`: owner runs `sdlc deploy record` (or creates a Release).
- **Reconcile** (`sdlc reconcile`, idempotent): for each task in Awaiting
  deployment, for each pending target, check whether its merge commit is an ancestor
  of the latest successful deployment SHA for that target's environment. Remove
  satisfied targets; when none remain → publish delivery comment (links to the
  deployments), close issue `completed`, Status Done.
- **Target ↔ evidence mapping** *(builder's call)*: each target must map to a
  unique GitHub environment (config validation refuses duplicates; default
  environment name `production-<target>` when more than one target exists). This
  works for Actions-native deployments, which carry only the environment name.
- **Rollback** *(builder's call)*: Done is final. A task is satisfied by any past
  successful deployment containing its commits; a later rollback does not reopen
  it (rollbacks are tracked as new bugfix tasks if needed).
- **Triggers** (so the board never lags): right after `sdlc deploy record`; GitHub
  Action `sdlc-reconcile.yml` on `deployment_status`, `pull_request: closed`,
  `issue_comment` (approval commands) — installed **by default**; agent
  `SessionStart` hook; `sdlc status` runs a read-only diff and offers reconcile.
- Deployment authorization stays with the owner: generated instructions forbid an
  agent from deploying without explicit owner confirmation in the current turn;
  recording evidence is not authorization.

## 11. Enforcement layers and modes

| Layer | Applies to | observe | enforce |
|---|---|---|---|
| git hooks (`pre-commit`, `pre-push`, `post-merge`, `post-checkout`) installed via `core.hooksPath=.sdlc/githooks` | everyone incl. humans | warn | block commits to default branch, push of `task/*` branch without known issue; post-merge triggers reconcile |
| harness hooks | Claude, Codex, Gemini | record gaps in state comment, warn agent | block file edits for a task before its plan is approved (except in phases that allow it: debugging repro, spike, docs); block subagent dispatch without role/tier; block `gh pr merge --admin`; block launching other AI CLIs |
| GitHub branch protection | everyone | — | require PR + linked task label on default branch (optional) |
| instructions + skills | all harnesses | the only layer for AGENTS.md-only harnesses | same |

Session hooks (all modes): on session start, inject current task context and run
read-only reconcile; on prompt submit, classify (status question vs new work vs
continuation) — classification is done by the agent following instructions; the hook
only supplies context and records the session/prompt id.

Mode switch: `sdlc config set mode enforce` (owner-run; the hook blocks agents from
changing it).

## 12. Generated files in the target repo

```
sdlc.config.yaml
.sdlc/
  agents/custom/            # project agents (user-owned)
  types/                    # custom task types (user-owned, optional)
  githooks/                 # managed
  cache/                    # gitignored: field ID cache, outbox
CLAUDE.md / GEMINI.md / AGENTS.md   # managed block <!-- sdlc:begin --> … <!-- sdlc:end -->
.claude/{settings.json (hooks merged), agents/sdlc-*.md, skills/sdlc-*/}
.codex/{config.toml (hooks + agents + [mcp_servers] merged)}
.gemini/{settings.json (hooks + mcpServers merged), agents/ or modes in GEMINI.md}
.mcp.json                              # Claude Code project MCP servers (merged)
.github/workflows/sdlc-reconcile.yml   # default on
.github/pull_request_template.md       # Related to #N, targets, verification
```

Instruction content (rendered from one template set): task tracking rules, phase
procedure with Superpowers skills (brainstorming, writing-plans,
systematic-debugging, subagent-driven-development, requesting-code-review,
verification-before-completion), task types and end conditions, merge/deploy
authority, production-data rules (backup, dry-run, owner runs), no external AI CLIs,
worktree discipline, running work index for compaction survival, graphify usage.
The managed block is concise (target < 150 lines); detail lives in skills loaded on
demand.

Skills shipped: `sdlc-task-tracking` (procedures for the CLI), `sdlc-delivery`
(review → merge → deploy → reconcile), `sdlc-orientation` (project orientation
template the owner fills).

## 13. Worktrees and repository hygiene (from reference #563)

- Each task gets a worktree `.worktrees/<issue>-<slug>` from fresh
  `origin/<default_branch>`, created when the issue is confirmed; spec/plan files are
  committed there, never left uncommitted in the main checkout.
- After merge: local default branch fast-forwarded (`--ff-only`); worktree removed
  only when clean and its branch is merged (`git worktree remove` without force,
  `git branch -d`). Never `--force`, `git worktree prune`, or `rm -rf`.
- `sdlc status` (radar): read-only overview — tasks by Status, Waiting on, stale
  items (Awaiting deployment > N days, Paused on agent > N days), orphan worktrees.

## 14. Stack installation

- **Superpowers**: per harness via its native route (Claude plugin marketplace;
  Gemini extension; Codex/others per Superpowers' docs). Installer prints/executes
  the documented command; if a step needs the user (e.g. `/plugin install` inside
  Claude), the agent asks the user to run it and `doctor` verifies.
- **graphify**: installed per its docs; generated instructions include the graphify
  rules (query before grep, `graphify update .` after changes, `graphify-out/`
  gitignored). Skipped cleanly if declined.
- **MCP servers** (install question 7a): rendered per harness into its native MCP
  config, merged without touching servers the user already has — Claude Code
  `.mcp.json` (project) or `claude mcp add --scope user`, Codex `[mcp_servers.*]` in
  `config.toml`, Gemini CLI `mcpServers` in `settings.json`. Catalog in v1:
  - `github` (default on): GitHub's official MCP server — remote endpoint
    (`https://api.githubcopilot.com/mcp/`, OAuth where the harness supports it) or the
    local server with a token read from an environment variable
    (`GITHUB_PERSONAL_ACCESS_TOKEN`), never written into a file.
  - optional: `context7` (library docs), `playwright` (browser checks for UI work);
    the catalog is a data file so more can be added without code changes.
  The `sdlc` CLI itself never depends on MCP — it always uses `gh` — so the board
  stays correct even for harnesses without MCP. Agents may use the GitHub MCP for
  reading issues/PRs/reviews; task state changes still go through `sdlc` so they are
  recorded and projected. `doctor` checks each configured server is listed by the
  harness (e.g. `claude mcp list`) and reports missing tokens/auth.
- Checks: `git`, `gh` (with scopes), Node ≥ 20.

## 15. Testing the project itself

- Unit tests for the state machine, task types, reconcile (ancestor logic with
  fake git graph), renderers (golden files per harness), config validation.
- Edge cases imported from the reference project as named regression tests: stuck
  after delivery acceptance (#573), GitHub auto-close on merge, partial PRs,
  multi-target partial deployment, cancellation and reopen, offline outbox replay.
- GitHub client tested against recorded fixtures; an opt-in e2e suite runs against
  a sandbox repo + Project (`SDLC_E2E_REPO`), never by default.
- The repo dogfoods itself: agentic-sdlc-kit is installed in its own repo.

## 16. Open-source packaging

MIT license, README with the bootstrap prompt and a 2-minute walkthrough,
CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, semver releases to npm,
CI (lint, unit tests, golden renders) on GitHub Actions.

## 17. v1 scope vs later

v1: Claude Code + Codex + Gemini + AGENTS.md-only; GitHub only; all of §5–§16.
Later: native plugins (approach C), other trackers, GitLab, web dashboard,
migration tool for existing boards with differently named fields.

## 18. Left to the builder

- Internal module layout, libraries (CLI framework, YAML, GraphQL client vs `gh api
  graphql`), template engine.
- Exact CLI subcommand names and flags beyond those named here.
- Exact hidden-state JSON schema and cache format.
- Exact wording of instruction templates and agent role prompts (within §9/§12
  content requirements).
- Gemini/Codex subagent file formats and hook payload mapping, verified against
  current docs at build time.
