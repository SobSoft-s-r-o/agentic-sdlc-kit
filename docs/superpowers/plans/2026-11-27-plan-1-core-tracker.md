# agentic-sdlc-kit Plan 1 — Core & Tracker CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `sdlc` CLI that tracks tasks on GitHub Issues + a Projects v2 board through typed lifecycles, detects merges and deployments, and keeps the board current via an idempotent `reconcile`.

**Architecture:** Pure core (task types, state machine, projection) with no I/O; a `Tracker` interface with a `GitHubTracker` implementation over the `gh` CLI (REST + GraphQL) and an in-memory `FakeTracker` for tests; thin command modules wired by `commander`. GitHub is the single source of truth: task state lives in one hidden issue comment, board fields are a projection of it.

**Tech Stack:** Node.js ≥ 20, TypeScript (strict, ESM), `commander`, `yaml`, `zod`; `vitest` for tests; `gh` CLI ≥ 2.40 for all GitHub access.

**Spec:** `docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md` (§5, §7, §8, §10 are implemented here; §6/§9/§11–§14 are Plans 2–3; §15–§16 Plan 4).

**Plan series:** 1 Core & tracker CLI (this) · 2 Installer & renderer (config writing, `init/upgrade/doctor`, instruction/agent/skill templates per harness, git hooks, Actions workflow, `INSTALL.md`) · 3 Harness hooks & enforcement (hook entrypoint, prompt log + `--prompt` approvals, enforce blocks, Superpowers/graphify install, worktrees) · 4 OSS packaging, dogfooding, e2e.

## Global Constraints

- Node ≥ 20; TypeScript `strict: true`, `module`/`moduleResolution: NodeNext`, ESM only.
- Runtime dependencies limited to `commander`, `yaml`, `zod`. No Octokit; all GitHub calls go through `gh` (`gh api`, `gh api graphql`).
- Package name `agentic-sdlc-kit`, binary `sdlc`. Until npm publishing (Plan 4), run via `npx github:SobSoft-s-r-o/agentic-sdlc-kit`.
- Everything English. **No code, text, names, identifiers or domain terms from the private reference project** may appear in this repo; regression tests are generic scenarios.
- Hidden state comment marker: first line exactly `<!-- sdlc:state -->`, followed by a fenced ```json block.
- Labels: `sdlc:task` (every tracked issue), `type:<id>`, `sdlc:partial` (PRs).
- PR body conventions: `Related to #<issue>`, `Scope: partial` or `Scope: final` (default `final` if absent), `Targets: web, api` (optional). Closing keywords are never generated.
- Board field names (exact, matched case-insensitively): `Status`, `Phase`, `Type`, `Waiting on`, `Summary`, `Current step`, `Next step`, `Pending targets`, `Agent`, `Last update`, `Start`, `Target date`.
- Status option names: `Ready`, `In progress`, `Blocked`, `Paused`, `In review`, `Awaiting deployment`, `Done`. Waiting-on options: `Owner`, `Agent`, `External`, `—`.
- Cancellation: Status `Done`, Current step `Cancelled — <reason>`, Next step `None`, issue closed `not_planned`.
- Owner approval commands in comments (by a login in `owners`): `/approve`, `/accept`, `/ran`, `/cancel <reason>`; must be newer than the result they act on.
- Board setup only adds fields/options; never renames or deletes.
- Each target maps to a unique GitHub environment; config validation refuses duplicates.
- Done is final: any past successful deployment containing all task merge commits satisfies a target; rollbacks never reopen.
- `sdlc deploy record` refuses a SHA not reachable from `origin/<default_branch>`.
- All commands print machine-readable JSON with `--json`; exit code non-zero on any failed GitHub write.

## Review Focus

1. **A GitHub write fails mid-command** (network, rate limit) → the command exits non-zero naming the failed step, and re-running `sdlc reconcile` converges to the correct board state (Task 10 test `converges after partial failure`).
2. **GitHub auto-closes or a human closes/reopens the issue** while the task is not done → reconcile reopens it; when done, reconcile closes it with the right reason (Task 10 test `restores issue open state from task state`).
3. **An approval command from a non-owner, or older than the published result** → ignored and listed in the report as `ignored_approval` (Task 10 test `ignores stale and non-owner approvals`).
4. **`deploy record` for a SHA that is not on the default branch** → refused, no deployment created (Task 9 test `refuses sha not on default branch`).
5. **Existing board whose Status options differ in case or include extra options** (`In Progress`, `Todo`) → matched case-insensitively, extras kept and never written (Task 6 test `reuses built-in status options case-insensitively`).

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore
src/cli.ts                       commander entry; registers command modules
src/core/types.ts                Phase, Status, WaitingOn, EndsOn, TaskTypeDef, TaskState, Approval, TaskEvent
src/core/taskTypes.ts            built-in types, custom type merge, lookup
src/core/stateMachine.ts         newTask, applyEvent (pure)
src/core/projection.ts           projectTask → BoardFields + issue open/closed
src/core/stateComment.ts         render/parse hidden state comment
src/core/summary.ts              stage summary + delivery/cancel report markdown
src/core/prBody.ts               parse Related/Scope/Targets from PR body
src/core/approvals.ts            parse approval commands from comments, filter by owner/time
src/config/schema.ts             zod schema, loadConfig, validation rules
src/tracker/types.ts             Tracker interface + DTOs
src/github/gh.ts                 GhRunner (execFile gh), ghJson, graphql
src/github/board.ts              planBoardChanges, ensureBoard, field resolution cache
src/github/githubTracker.ts      GitHubTracker implements Tracker
src/engine/reconcile.ts          reconcile engine
src/engine/status.ts             radar report
src/commands/{task,stage,approve,evidence,review,deploy,reconcile,status,board}.ts
tests/support/fakeTracker.ts     in-memory Tracker
tests/support/fakeGh.ts          scripted GhRunner
tests/**.test.ts
```

---

### Task 1: Package scaffold, core types and task type registry

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/core/types.ts`, `src/core/taskTypes.ts`
- Test: `tests/core/taskTypes.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
  - `type Phase = 'intake'|'debugging'|'brainstorming'|'analysis'|'exploration'|'creation'|'planning'|'implementation'|'verification'|'review'|'delivery'`
  - `type Status = 'ready'|'in_progress'|'blocked'|'paused'|'in_review'|'awaiting_deployment'|'done'`
  - `type WaitingOn = 'owner'|'agent'|'external'|'none'`
  - `type EndsOn = 'deploy'|'merge'|'owner_acceptance'|'owner_confirmation'|'merge_or_acceptance'`
  - `type EvidenceKind = 'backup'|'dry_run'`
  - `interface TaskTypeDef { id: string; label: string; phases: Phase[]; endsOn: EndsOn; requiresBeforeReview: EvidenceKind[]; targetsRequired: boolean }`
- Produces (`src/core/taskTypes.ts`): `BUILTIN_TYPES: readonly TaskTypeDef[]`, `buildTypeRegistry(enabled: string[], custom: TaskTypeDef[]): Map<string, TaskTypeDef>` (throws `ConfigError` on unknown enabled id or custom id colliding with built-in), `class ConfigError extends Error`.

- [ ] **Step 1: Scaffold.** `package.json` with `"type": "module"`, `"bin": {"sdlc": "dist/cli.js"}`, `"engines": {"node": ">=20"}`, scripts `build: tsc`, `test: vitest run`, `prepare: tsc`; deps `commander`, `yaml`, `zod`; devDeps `typescript`, `vitest`, `@types/node`. `.gitignore`: `node_modules/`, `dist/`, `.sdlc/cache/`. Run `npm install`. Expected: lockfile created.

- [ ] **Step 2: Write the failing test** `tests/core/taskTypes.test.ts`:

```ts
it('defines the seven built-in types with spec end conditions', () => {
  const ids = BUILTIN_TYPES.map(t => t.id);
  expect(ids).toEqual(['feature','bugfix','tooling','analysis','production-data','artifact','spike']);
  const by = Object.fromEntries(BUILTIN_TYPES.map(t => [t.id, t]));
  expect(by.feature.endsOn).toBe('deploy');
  expect(by.feature.targetsRequired).toBe(true);
  expect(by.bugfix.phases[1]).toBe('debugging');
  expect(by.tooling.endsOn).toBe('merge');
  expect(by.analysis.phases).toEqual(['intake','analysis','delivery']);
  expect(by.analysis.endsOn).toBe('owner_acceptance');
  expect(by['production-data'].endsOn).toBe('owner_confirmation');
  expect(by['production-data'].requiresBeforeReview).toEqual(['backup','dry_run']);
  expect(by.artifact.phases).toEqual(['intake','brainstorming','creation','review','delivery']);
  expect(by.artifact.endsOn).toBe('merge_or_acceptance');
  expect(by.spike.phases).toEqual(['intake','exploration','delivery']);
});
it('builds a registry of enabled + custom types', () => { /* enabled ['feature'], custom infra-change → keys ['feature','infra-change'] */ });
it('rejects unknown enabled ids and custom ids that shadow built-ins', () => { /* expect(() => …).toThrow(ConfigError) twice */ });
```

Feature/tooling/production-data phases: `['intake','brainstorming','planning','implementation','verification','review','delivery']`; bugfix replaces `brainstorming` with `debugging`.

- [ ] **Step 3: Run** `npx vitest run tests/core/taskTypes.test.ts` → FAIL (module not found).
- [ ] **Step 4: Implement** `types.ts` and `taskTypes.ts`.
- [ ] **Step 5: Run** the test → PASS. `npx tsc --noEmit` → no errors.
- [ ] **Step 6: Commit** `feat: scaffold package and task type registry`.

---

### Task 2: Config schema and loader

**Files:**
- Create: `src/config/schema.ts`
- Test: `tests/config/schema.test.ts`, fixture `tests/fixtures/config/valid.yaml`

**Interfaces:**
- Consumes: `TaskTypeDef`, `buildTypeRegistry`, `ConfigError` (Task 1).
- Produces: `type Config` (inferred from zod `ConfigSchema`), `loadConfig(path: string): Config`, `parseConfig(text: string): Config`, `typeRegistry(cfg: Config): Map<string, TaskTypeDef>`, `targetByName(cfg: Config, name: string): TargetConfig`, `type TargetConfig = { name: string; environment: string; deploy: { via: 'script'|'actions'|'manual'|'release'; command?: string; workflow?: string }; paths: string[] }`.

Schema fields (spec §6 sketch, snake_case in YAML, camelCase after parse): `version: 1`, `harnesses: ('claude'|'codex'|'gemini'|'agents-md')[]`, `mode: 'observe'|'enforce'`, `github: { repo: 'owner/name', default_branch, project: { owner, owner_type: 'org'|'user', number?: int } }`, `owners: string[]` (min 1), `content_language` (default `en`), `merge_policy: 'owner_only'|'agent_on_request'` (default `owner_only`), `quality_gate: string[]`, `task_types: { enabled: string[], custom: CustomType[] }`, `targets: TargetConfig[]`, `models: Record<harness, {deep, standard, fast}>`, `stack: { superpowers, graphify, branch_protection, actions }` (all default true). Custom type YAML uses `ends_on`, `requires_before_review`, `targets_required`.

- [ ] **Step 1: Write failing tests:**
  - `parses the valid fixture` → `cfg.github.repo === 'acme/shop'`, `cfg.mergePolicy === 'owner_only'`, `cfg.targets[0].environment === 'production-web'`.
  - `defaults environment to production for a single target and production-<name> for several` → one target without `environment` → `'production'`; two targets without → `'production-web'`, `'production-api'`.
  - `refuses two targets sharing an environment` → throws `ConfigError` with message containing `unique environment`.
  - `refuses deploy-ending types enabled with no targets` → `enabled: ['feature']`, `targets: []` → `ConfigError` containing `requires at least one target`.
  - `refuses invalid repo slug and empty owners` → two `ConfigError`s.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with zod `.superRefine` for cross-field rules; `ConfigError` message lists every issue path.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: config schema with target and type validation`.

---

### Task 3: Task state machine

**Files:**
- Create: `src/core/stateMachine.ts`; extend `src/core/types.ts`
- Test: `tests/core/stateMachine.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces (types.ts):
  - `interface Approval { source: 'prompt'|'comment'|'unverified'; ref: string; by: string; at: string }`
  - `interface PrRecord { number: number; scope: 'partial'|'final'; mergeSha?: string }`
  - `interface StageRecord { revision: number; publishedAt?: string; approval?: Approval }`
  - `interface TaskState { schema: 1; issue: number; type: string; status: Status; phase: Phase; waitingOn: WaitingOn; summary: string; currentStep: string; nextStep: string; agent: string; targets: string[]; pendingTargets: string[]; prs: PrRecord[]; stages: Partial<Record<Phase, StageRecord>>; evidence: { kind: EvidenceKind; ref: string; at: string }[]; outcome?: 'completed'|'cancelled'; cancelReason?: string; resultPublishedAt?: string; deliveredBy?: string[]; updatedAt: string }`
  - `type TaskEvent = {kind:'phase_started'; phase: Phase} | {kind:'stage_published'; phase: Phase; needsApproval: boolean} | {kind:'stage_approved'; phase: Phase; approval: Approval} | {kind:'evidence_added'; evidenceKind: EvidenceKind; ref: string} | {kind:'review_handoff'; pr: number; scope: 'partial'|'final'; targets: string[]} | {kind:'pr_merged'; pr: number; scope: 'partial'|'final'; mergeSha: string} | {kind:'targets_deployed'; targets: string[]; deploymentUrls: string[]} | {kind:'accepted'; approval: Approval} | {kind:'confirmed_ran'; approval: Approval} | {kind:'cancelled'; reason: string; approval: Approval} | {kind:'reopened'} | {kind:'checkpoint'; currentStep?: string; nextStep?: string; agent?: string; waitingOn?: WaitingOn; status?: 'in_progress'|'blocked'}`
- Produces (stateMachine.ts): `newTask(input: { issue: number; type: TaskTypeDef; summary: string; now: string }): TaskState` (status `in_progress`, phase `intake`, waitingOn `agent`), `applyEvent(state: TaskState, event: TaskEvent, type: TaskTypeDef, now: string): TaskState` (returns a new object), `class TransitionError extends Error`.

Transition rules (each a test):

| Event | Rule |
|---|---|
| `phase_started` | phase must be in `type.phases` and not before current phase; sets status `in_progress`, waitingOn `agent` |
| `stage_published` | increments `stages[phase].revision`, sets `publishedAt`; if `needsApproval` → status `paused`, waitingOn `owner`. If phase is `delivery` (or the last non-delivery phase of an acceptance type) sets `resultPublishedAt` |
| `stage_approved` | `approval.at` must be > `stages[phase].publishedAt` else `TransitionError`; records approval; status `in_progress`, waitingOn `agent` |
| `review_handoff` | `requiresBeforeReview` kinds must all exist in `evidence` else `TransitionError('missing evidence: backup')`; if `targetsRequired` and `scope==='final'` and union targets empty → `TransitionError`; upserts PrRecord; `targets` = union; phase `review`, status `in_review`, waitingOn `owner` |
| `pr_merged` partial | records `mergeSha`; no status change |
| `pr_merged` final | records `mergeSha`; phase `delivery`; by `endsOn`: `merge`/`merge_or_acceptance` → `done`, outcome `completed`; `deploy` → `awaiting_deployment`, `pendingTargets = targets`, waitingOn `external`; `owner_acceptance`/`owner_confirmation` → `paused`, waitingOn `owner` |
| `targets_deployed` | only in `awaiting_deployment`; removes targets from `pendingTargets`, appends urls to `deliveredBy`; when empty → `done`, outcome `completed` |
| `accepted` | only for `owner_acceptance`/`merge_or_acceptance`; requires `resultPublishedAt` and `approval.at > resultPublishedAt` → `done` |
| `confirmed_ran` | only for `owner_confirmation`, after final merge → `done` |
| `cancelled` | from any non-done → `done`, outcome `cancelled`, `cancelReason` |
| `reopened` | only from `done` → status `in_progress`, outcome cleared, waitingOn `agent` |
| `checkpoint` | only updates provided fields; never touches status `done` |
| any other event on `done` | `TransitionError` |

- [ ] **Step 1: Write failing tests**, one `it` per row above plus these generic regression scenarios:
  - `feature with two targets stays awaiting deployment until both are deployed` → after `targets_deployed(['web'])` status `awaiting_deployment`, `pendingTargets ['api']`; after `['api']` → `done`.
  - `partial PR merge does not move the task` → status stays `in_review`.
  - `acceptance after delivery reaches done in one event` (guards the "stuck after acceptance" class) → analysis: `stage_published(delivery)` then `accepted` → `done`, outcome `completed`.
  - `cancel then reopen restores an open task` → `cancelled` → `done/cancelled`; `reopened` → `in_progress`, `outcome` undefined.
  - `production-data cannot reach review without backup and dry run` → `TransitionError` message contains `backup`.
  - `approval older than publication is rejected` → `TransitionError`.
- [ ] **Step 2: Run** `npx vitest run tests/core/stateMachine.test.ts` → FAIL.
- [ ] **Step 3: Implement** `applyEvent` as a `switch` on `event.kind`, cloning with `structuredClone`, setting `updatedAt = now`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: typed task state machine`.

---

### Task 4: Projection, state comment, summaries, PR body parsing

**Files:**
- Create: `src/core/projection.ts`, `src/core/stateComment.ts`, `src/core/summary.ts`, `src/core/prBody.ts`
- Test: `tests/core/projection.test.ts`, `tests/core/stateComment.test.ts`, `tests/core/prBody.test.ts`, `tests/core/summary.test.ts`

**Interfaces:**
- Consumes: `TaskState`, `TaskTypeDef`.
- Produces:
  - `interface BoardFields { status: string; phase: string; type: string; waitingOn: string; summary: string; currentStep: string; nextStep: string; pendingTargets: string; agent: string; lastUpdate: string }` (display strings, e.g. `'Awaiting deployment'`, `'Production data'` from `type.label`)
  - `projectTask(state: TaskState, type: TaskTypeDef): { fields: BoardFields; issueOpen: boolean; closeReason?: 'completed'|'not_planned' }`
  - `STATE_MARKER = '<!-- sdlc:state -->'`, `renderStateComment(state: TaskState): string`, `parseStateComment(body: string): TaskState | null` (null if marker absent; throws `StateCommentError` on marker with invalid JSON)
  - `renderStageSummary(input: { phase: Phase; revision: number; markdown: string }): string` (heading `### <Phase> — revision <n>` + markdown + footer `Approve with /approve`) when needs approval
  - `renderDeliveryReport(state: TaskState): string`, `renderCancelReport(state: TaskState): string`
  - `parsePrBody(body: string): { issues: number[]; scope: 'partial'|'final'; targets: string[] }`

- [ ] **Step 1: Write failing tests:**
  - projection: `done/completed → issue closed completed`; `done/cancelled → closed not_planned, currentStep 'Cancelled — <reason>', nextStep 'None'`; `awaiting_deployment → pendingTargets 'api, web'` (sorted); every non-done status → `issueOpen true`; waitingOn `none` → `'—'`.
  - state comment: round-trip `parseStateComment(renderStateComment(s))` deep-equals `s`; body without marker → `null`; marker + broken JSON → throws `StateCommentError`.
  - prBody: `'Related to #12\nScope: partial\nTargets: web, api'` → `{issues:[12], scope:'partial', targets:['web','api']}`; no Scope line → `'final'`; `'Fixes #5'` → `issues: []` (closing keywords are not task links); multiple `Related to #1, #2` → `[1,2]`.
  - summary: delivery report lists each deployment URL from `deliveredBy`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: board projection, state comment and PR body parsing`.

---

### Task 5: Tracker interface, gh runner, FakeTracker

**Files:**
- Create: `src/tracker/types.ts`, `src/github/gh.ts`, `tests/support/fakeTracker.ts`, `tests/support/fakeGh.ts`
- Test: `tests/github/gh.test.ts`, `tests/support/fakeTracker.test.ts`

**Interfaces:**
- Produces (`src/tracker/types.ts`):
  - `interface TrackedTask { issue: number; title: string; issueOpen: boolean; state: TaskState; stateCommentId: string }`
  - `interface IssueComment { id: string; url: string; author: string; body: string; createdAt: string }`
  - `interface PrInfo { number: number; url: string; merged: boolean; mergeSha?: string; baseRef: string; body: string }`
  - `interface DeploymentInfo { id: number; sha: string; environment: string; url: string; createdAt: string }`
  - `interface Tracker { createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>; addToBoard(issue: number): Promise<void>; listTrackedTasks(): Promise<TrackedTask[]>; getTask(issue: number): Promise<TrackedTask>; writeState(issue: number, state: TaskState): Promise<void>; postComment(issue: number, body: string): Promise<string>; listComments(issue: number, sinceIso?: string): Promise<IssueComment[]>; setIssueOpen(issue: number, open: boolean, reason?: 'completed'|'not_planned'): Promise<void>; setLabels(issue: number, add: string[], remove: string[]): Promise<void>; syncFields(issue: number, fields: BoardFields): Promise<void>; listTaskPrs(issue: number): Promise<PrInfo[]>; listSuccessfulDeployments(environment: string, limit: number): Promise<DeploymentInfo[]>; isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>; isOnDefaultBranch(sha: string): Promise<boolean>; createDeployment(input: { environment: string; sha: string; target: string; description: string }): Promise<DeploymentInfo> }`
- Produces (`src/github/gh.ts`): `type GhRunner = (args: string[], input?: string) => Promise<{ stdout: string; code: number; stderr: string }>`, `defaultGhRunner: GhRunner` (execFile `gh`), `ghJson<T>(run: GhRunner, args: string[], input?: unknown): Promise<T>` (throws `GhError` with args + stderr on non-zero), `graphql<T>(run: GhRunner, query: string, variables: Record<string, unknown>): Promise<T>` (uses `gh api graphql --input -`, throws `GhError` if response has `errors`), `class GhError extends Error { args: string[]; stderr: string }`.
- Produces (tests/support): `class FakeTracker implements Tracker` with public arrays `issues`, `comments`, `prs`, `deployments`, `fields: Map<number, BoardFields>`, an ancestry map `ancestors: Set<string>` of `"a>b"` pairs, `defaultBranchShas: Set<string>`, and `failNext(method: keyof Tracker)` that makes the next call reject. `fakeGh(script: Array<{ match: string[]; stdout?: string; code?: number; stderr?: string }>): GhRunner`.

- [ ] **Step 1: Write failing tests:** `ghJson parses stdout JSON`; `ghJson throws GhError carrying stderr on non-zero exit`; `graphql throws on errors array`; `FakeTracker.failNext rejects exactly one call`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: tracker interface, gh runner and test fakes`.

---

### Task 6: Board provisioning

**Files:**
- Create: `src/github/board.ts`, `src/commands/board.ts`
- Test: `tests/github/board.test.ts`

**Interfaces:**
- Consumes: `GhRunner`, `graphql` (Task 5), `Config` (Task 2), `typeRegistry`.
- Produces:
  - `interface ExistingField { id: string; name: string; dataType: 'SINGLE_SELECT'|'TEXT'|'DATE'|string; options?: { id: string; name: string }[] }`
  - `interface DesiredField { name: string; dataType: 'SINGLE_SELECT'|'TEXT'|'DATE'; options?: string[] }`
  - `desiredFields(cfg: Config): DesiredField[]` (Phase options = union of enabled types' phases in canonical order; Type options = enabled type labels)
  - `planBoardChanges(existing: ExistingField[], desired: DesiredField[]): { createFields: DesiredField[]; addOptions: { fieldId: string; fieldName: string; missing: string[] }[]; typeConflicts: string[] }` (case-insensitive name match; existing extra options untouched)
  - `ensureBoard(run: GhRunner, cfg: Config, opts: { dryRun: boolean }): Promise<{ projectNumber: number; projectId: string; created: boolean; plan: ReturnType<typeof planBoardChanges> }>` — creates the project when `cfg.github.project.number` is absent (`createProjectV2`, linked to the repo), creates fields (`createProjectV2Field`), and adds options.
  - `resolveFieldIds(run: GhRunner, cfg: Config): Promise<FieldMap>` caching to `.sdlc/cache/fields.json` keyed by project id; `type FieldMap = Record<keyof BoardFields | 'start' | 'targetDate', { id: string; options?: Record<string, string> }>`.
  - CLI: `sdlc board ensure [--dry-run] [--json]`.

- [ ] **Step 1: Spike (no code kept):** on a throwaway user-owned project, set a single-select value on an item, call `updateProjectV2Field` adding one option, and read the item value back. Record result in `docs/notes/projects-option-update.md` (fields: date, gh version, preserved yes/no). Set `OPTION_UPDATE_PRESERVES_VALUES` in `board.ts` accordingly. Delete the throwaway project.
- [ ] **Step 2: Write failing tests** (`planBoardChanges` is pure):
  - `creates all fields on an empty board` → 11 fields in `createFields` (Status is built-in → becomes `addOptions`, not create, when present).
  - `reuses built-in status options case-insensitively` → existing Status options `Todo, In Progress, Done` → `missing` = `['Ready','Blocked','Paused','In review','Awaiting deployment']`; `In Progress` not re-added; `Todo` kept.
  - `reports a type conflict when a field exists with another data type` → existing `Summary` as `SINGLE_SELECT` → `typeConflicts ['Summary']`.
  - `ensureBoard refuses option changes on a populated field when updates are unsafe` → with `OPTION_UPDATE_PRESERVES_VALUES=false` and fake gh reporting items with values → throws `BoardError` containing `create a new board`.
  - `ensureBoard dry run issues no mutations` → fakeGh script contains only query calls.
  - `ensureBoard creates the four views when the API supports it, else returns manual instructions` → views `Board` (board layout by Status), `In flight` (table, filter `-status:Done`, sort Last update desc), `Awaiting deployment` (table, filter `status:"Awaiting deployment"`, group Pending targets), `Waiting on owner` (filter `waiting-on:Owner`). Verify the current view-creation API (GraphQL or REST Projects API) during the Step 1 spike; if none exists, `ensureBoard` returns `viewsManual: string[]` and `sdlc board ensure` prints them.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** When adding options with `updateProjectV2Field`, send the full option list (existing names + colors + missing). **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat: add-only board provisioning`.

---

### Task 7: GitHubTracker

**Files:**
- Create: `src/github/githubTracker.ts`
- Test: `tests/github/githubTracker.test.ts` with recorded fixtures `tests/fixtures/gh/*.json`

**Interfaces:**
- Consumes: Tracker interface (Task 5), `resolveFieldIds` (Task 6), `renderStateComment`/`parseStateComment` (Task 4), `parsePrBody` (Task 4).
- Produces: `class GitHubTracker implements Tracker { constructor(run: GhRunner, cfg: Config) }`.

Implementation decisions:
- `listTrackedTasks`: `gh issue list --label sdlc:task --state all --json number,title,state --limit 500` scoped to `cfg.github.repo`, then each issue's comments; the comment whose body starts with `STATE_MARKER` and whose author is the authenticated user or `github-actions[bot]` holds state. Issues with no state comment are skipped (they appear as untracked in `status`).
- `writeState`: PATCH the existing state comment (`gh api -X PATCH repos/{repo}/issues/comments/{id}`), else POST a new one.
- `syncFields`: resolve the item id via the issue's `projectItems`, then one `updateProjectV2ItemFieldValue` per changed field (compare to current values first; skip unchanged).
- `listTaskPrs`: `gh pr list --state all --search "\"Related to #N\" in:body" --json number,url,mergedAt,mergeCommit,baseRefName,body`, then confirm with `parsePrBody(body).issues.includes(N)`.
- `listSuccessfulDeployments`: `repos/{repo}/deployments?environment=<env>&per_page=<limit>`, keep those whose latest status (`/statuses?per_page=1`) is `success`.
- `isAncestor(a, b)`: `repos/{repo}/compare/{a}...{b}` → `status` in `['ahead','identical']`.
- `isOnDefaultBranch(sha)`: `isAncestor(sha, <default branch head sha>)`.
- `createDeployment`: POST `deployments` with `ref: sha`, `environment`, `auto_merge: false`, `required_contexts: []`, `payload: { sdlc_target: target }`, `description`; then POST status `success` with `environment_url` omitted.

- [ ] **Step 1: Write failing tests** with `fakeGh` returning fixtures: `lists tracked tasks and skips issues without state`; `writeState patches existing comment`; `writeState creates comment when absent`; `syncFields only writes changed fields`; `listTaskPrs ignores PRs whose body only mentions the issue with a closing keyword`; `listSuccessfulDeployments filters by latest status`; `isAncestor maps compare status`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: GitHub-backed tracker`.

---

### Task 8: Task, stage, evidence, review and approve commands

**Files:**
- Create: `src/commands/task.ts`, `src/commands/stage.ts`, `src/commands/evidence.ts`, `src/commands/review.ts`, `src/commands/approve.ts`, `src/commands/context.ts` (shared `CommandContext`)
- Test: `tests/commands/taskFlow.test.ts`

**Interfaces:**
- Consumes: Tracker, state machine, projection, summaries, config.
- Produces: `interface CommandContext { tracker: Tracker; cfg: Config; now: () => string; out: (data: unknown) => void }`; a shared helper `commit(ctx, issue, event): Promise<TaskState>` that loads the task, applies the event, `writeState` → `syncFields` → issue open/close per projection, in that order, and rethrows the first failure with the step name. Command functions (each also registered on commander):
  - `taskNew(ctx, { title, summary, type, body? }): Promise<{ issue: number; url: string }>` — labels `sdlc:task`, `type:<id>`; adds to board; writes initial state.
  - `taskSetType(ctx, issue, type)` — swaps `type:` label, updates state.type (allowed in any non-done status).
  - `taskCheckpoint(ctx, issue, { current?, next?, agent?, waitingOn?, status? })`.
  - `taskReopen(ctx, issue)`.
  - `stageStart(ctx, issue, phase)`; `stagePublish(ctx, issue, phase, { file, needsApproval })` — posts `renderStageSummary` comment then commits `stage_published`.
  - `evidenceAdd(ctx, issue, { kind, ref })`.
  - `reviewHandoff(ctx, issue, { pr, targets })` — reads PR body scope via `listTaskPrs`.
  - `approve(ctx, issue, { action: 'approve'|'accept'|'ran'|'cancel'; phase?; reason?; commentUrl?: string; unverified?: boolean })` — `commentUrl` must belong to an owner and be newer than the relevant publication (validated via `listComments`); `unverified` allowed only when `cfg.mode === 'observe'` (else exits with `unverified approvals are not allowed in enforce mode`). `cancel` posts `renderCancelReport` before committing.
  - CLI forms: `sdlc task new|set-type|checkpoint|reopen`, `sdlc stage start|publish`, `sdlc evidence add`, `sdlc review handoff`, `sdlc approve <issue> <action> [--phase] [--reason] (--comment-url <url> | --unverified)`.

- [ ] **Step 1: Write failing tests** against `FakeTracker`:
  - `new task creates labelled issue on the board in intake`.
  - `full feature flow up to review handoff` → status `in_review`, fields.status `'In review'`.
  - `stage publish with approval pauses waiting on owner`.
  - `unverified approval refused in enforce mode`.
  - `cancel posts report then closes issue not_planned` (assert comment order and close reason).
  - `commit surfaces the failing step` → `failNext('syncFields')` → error message contains `syncFields`; state comment already written.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: task lifecycle commands`.

---

### Task 9: Deployment recording

**Files:**
- Create: `src/commands/deploy.ts`, `src/engine/deployments.ts`
- Test: `tests/engine/deployments.test.ts`

**Interfaces:**
- Consumes: Tracker, `targetByName`, `TaskState`.
- Produces:
  - `deployRecord(ctx, { target: string; sha: string; verify?: string }): Promise<DeploymentInfo>` — refuses unknown target; refuses when `!isOnDefaultBranch(sha)` (`sha <x> is not on <branch>`); if `verify` given, runs it via `/bin/sh -c` and refuses on non-zero exit before creating anything; creates deployment. (Task 10 adds the follow-up reconcile call.)
  - `satisfiedTargets(tracker: Tracker, cfg: Config, state: TaskState): Promise<{ targets: string[]; urls: string[] }>` — a pending target is satisfied when **every** `state.prs[].mergeSha` is an ancestor of (or equal to) **any** of the last 50 successful deployments for that target's environment.
  - CLI: `sdlc deploy record --target <name> --sha <sha> [--verify "<cmd>"]`.

- [ ] **Step 1: Write failing tests:** `refuses sha not on default branch` (no deployment created); `refuses when verify command fails`; `satisfies a target only when all merge commits are contained` (two PR merge SHAs, deployment contains one → not satisfied; contains both → satisfied); `older successful deployment still satisfies after a rollback` (latest deployment SHA not containing, older one containing → satisfied).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: deployment recording and target satisfaction`.

---

### Task 10: Reconcile engine

**Files:**
- Create: `src/engine/reconcile.ts`, `src/core/approvals.ts`, `src/commands/reconcile.ts`
- Modify: `src/commands/deploy.ts` — after creating the deployment, `deployRecord` calls `reconcile(ctx, { only: 'deployments' })` and returns its actions alongside the deployment.
- Test: `tests/engine/reconcile.test.ts`, `tests/core/approvals.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `parseApprovalCommands(comments: IssueComment[], owners: string[]): { action: 'approve'|'accept'|'ran'|'cancel'; reason?: string; comment: IssueComment }[]` — command must be the first non-empty line, case-insensitive; authors compared case-insensitively; non-owner commands returned separately as `ignored`.
  - `interface ReconcileAction { issue: number; kind: 'pr_merged'|'targets_deployed'|'approval'|'ignored_approval'|'issue_reopened'|'issue_closed'|'fields_synced'|'delivery_report'|'skipped_unknown_type'|'error'; detail: string }`
  - `reconcile(ctx: CommandContext, opts: { dryRun?: boolean; only?: 'deployments'|'all'; issue?: number }): Promise<{ actions: ReconcileAction[]; errors: number }>`
  - CLI: `sdlc reconcile [--dry-run] [--issue N] [--json]`; exit code 1 when `errors > 0`.

Per tracked task, in order: (1) unknown type → `skipped_unknown_type`, continue; (2) for each task PR merged into `default_branch` and not yet recorded → `pr_merged` event (scope from body); (3) approval commands newer than the relevant publication → `stage_approved` (when the task is paused waiting on owner in a phase) / `accepted` / `confirmed_ran` / `cancelled`; stale or non-owner → `ignored_approval`; (4) if `awaiting_deployment` → `satisfiedTargets` → `targets_deployed`; when it reaches done, post `renderDeliveryReport` before the state write; (5) projection: write state if changed, `syncFields`, open/close issue to match `projectTask`. Errors on one task are recorded as `error` actions and do not stop other tasks.

- [ ] **Step 1: Write failing tests:**
  - `moves a merged feature to awaiting deployment` and `moves a merged tooling task to done`.
  - `closes a task when its last target is deployed and posts the delivery report first`.
  - `restores issue open state from task state` → task `in_review`, issue closed by GitHub auto-close → reopened; task done → issue closed `completed`.
  - `ignores stale and non-owner approvals` → two `ignored_approval` actions, state unchanged.
  - `applies /accept for an analysis task with a published result` → done.
  - `applies /cancel with reason`.
  - `converges after partial failure` → `failNext('syncFields')` on first run → `errors 1`; second run → fields correct, `errors 0`.
  - `is idempotent` → second run on a converged board yields only zero mutating actions.
  - `skips tasks whose type is no longer configured`.
  - `dry run performs no writes` (FakeTracker write counters stay 0).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: idempotent reconcile engine`.

---

### Task 11: Status radar and CLI wiring

**Files:**
- Create: `src/engine/status.ts`, `src/commands/status.ts`, `src/cli.ts`
- Modify: `README.md` (CLI section)
- Test: `tests/engine/status.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: Tracker, reconcile (dry run), all command modules.
- Produces:
  - `statusReport(ctx, { staleDays: number }): Promise<{ byStatus: Record<string, TaskSummary[]>; waitingOnOwner: TaskSummary[]; staleAwaitingDeployment: TaskSummary[]; stalePausedOnAgent: TaskSummary[]; untracked: { issue: number; title: string }[]; pendingReconcile: ReconcileAction[] }>`, `type TaskSummary = { issue: number; title: string; status: Status; phase: Phase; type: string; pendingTargets: string[]; updatedAt: string; ageDays: number }`.
  - `sdlc status [--stale-days 7] [--json]` prints a grouped human table by default.
  - `src/cli.ts`: builds `CommandContext` from `loadConfig(<git root>/sdlc.config.yaml)` + `new GitHubTracker(defaultGhRunner, cfg)`; `--config <path>` override; global `--json`; unknown errors print message and exit 1, `GhError` prints args + stderr.

- [ ] **Step 1: Write failing tests:** `groups tasks and flags stale awaiting deployment older than staleDays`; `lists issues labelled sdlc:task without state as untracked`; `cli --help lists every command` (spawn `node dist/cli.js --help` after `npm run build`; expect `task`, `stage`, `evidence`, `review`, `approve`, `deploy`, `reconcile`, `status`, `board`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run build && npx vitest run` → all PASS, `npx tsc --noEmit` clean.
- [ ] **Step 5: Manual smoke (owner-visible, sandbox only):** in a throwaway repo with a fresh board: `sdlc board ensure`, `sdlc task new --type tooling …`, open a PR with `Related to #N`, merge it, `sdlc reconcile` → task Done on the board. Record commands and results in `docs/notes/plan-1-smoke.md`. Delete the sandbox afterwards.
- [ ] **Step 6: Commit** `feat: status radar and CLI wiring`.

---

## Done criteria for Plan 1

- `npx vitest run` green; `npx tsc --noEmit` clean.
- Sandbox smoke recorded in `docs/notes/plan-1-smoke.md`.
- Every Review Focus line has a passing test in its owning task.
- No reference-project identifiers in the repo (`git grep -iE "<reference terms list kept outside the repo>"` run by the controller returns nothing).
