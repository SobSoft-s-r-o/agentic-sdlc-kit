# Plan 3 codebase map (branch feat/plan-3-harness-hooks)

Read-only survey for planning Plan 3. Paths are relative to the repo root
(the plan-3 worktree). TypeScript ESM, node >= 20, commander 14, zod 4, yaml 2,
vitest 4. Binary `sdlc` is `dist/cli.js`. "(absent)" means grepped and not there.

Spec: `docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md` section 5 (architecture, outbox + `sdlc sync`),
11 (enforcement table, session hooks, `sdlc config set mode enforce`), 12 (generated files), 13 (worktrees, radar),
14 (stack install, MCP doctor). Rulings: `docs/notes/plan-1-rulings.md` R20 (MCP doctor is Plan 3), R30 (prompt approval).

## 1. CLI wiring and `ctx`

`src/cli.ts`
- `interface CliDeps { makeContext?, makeBoardContext?, makeConfigContext?, makeGitHookContext?, makeInstallContext?, makeDoctorContext?, out?, err? }`.
  Every command family gets its own injected factory; tests pass fakes, nothing is read until a command runs.
- `buildProgram(deps = {}): Command`, `runCli(args, deps = {}): Promise<void>` (catches escapes, `process.exitCode = 1`,
  `--json` prints `{error}` via `errorAsJson`, else `formatCliError`), re-export `formatCliError`.
- Global options: `--config <path>`, `--json` (a `preAction` hook copies the program's `--json` onto the running command).
- Private helpers: `CONFIG_FILE = 'sdlc.config.yaml'`, `gitRoot(cwd)` (git rev-parse --show-toplevel), `readFileIfPresent`,
  `loadEnvironment(configOption, cwd) => {cfg, repoRoot}` (throws outside a git repo), `writeLine(stream)`.
- Default `makeContext` = `{tracker: new GitHubTracker(defaultGhRunner, cfg, {repoRoot}), cfg, now: () => new Date().toISOString(), out, err}`.
- Registration order (add a `registerHookCommand`, `registerSyncCommand` here): task, stage, evidence, review, approve,
  deploy, reconcile, status, board, config, githook, init, upgrade, uninstall, doctor.

`src/commands/context.ts` (the `ctx` all task commands share)
- `interface CommandContext { tracker: Tracker; cfg: Config; now(): string; out(data: unknown): void; err?(text: string): void }`
- `type ContextFactory = () => CommandContext | Promise<CommandContext>`; `class CommandError`.
- `runCommand<T>(makeContext, {json?}, run, describe)`: build ctx, run, print `json ? JSON.stringify(result) : describe(result)`;
  any throw prints and sets exit 1; never rejects.
- Task plumbing: `trackerStep(name, issue, fn, hint?)`, `resolveType(cfg, id)`, `fetchTask(ctx, issue): Promise<TrackedTask>`,
  `loadTask(ctx, issue): Promise<LoadedTask {task, type}>`, `saveAndSync`, `persist(ctx, loaded, next, opts?)`,
  `commitLoaded(ctx, loaded, event, opts?)`, `commit(ctx, issue, event, opts?)` (load, `applyEvent`, write state, sync board
  fields and issue open/closed), `expectedOf(task)`, `describeState(state)`.
- Parsers: `parseIssueNumber`, `parseChoice`, `parsePhase`, `parseEvidenceKind`, `parseWaitingOn`, `parseCheckpointStatus`, `parseTargetList`.

Commands (one `registerXCommand(program, makeContext)` per file under `src/commands/`):
- `task.ts`: `new` (`taskNew`), `set-type` (`taskSetType`, owner-approval flow for weakening type changes), `checkpoint`, `reopen`.
- `stage.ts`: `stage start|publish` (`stageStart`, `stagePublish`). `evidence.ts`: `evidence add`. `review.ts`: `review handoff`.
- `approve.ts`: `sdlc approve <issue> <action>` with `ApproveInput`. Needs `--comment-url` or `--unverified` (observe only).
  No `--prompt` yet.
- `deploy.ts`: `deploy record` (`deployRecord`, `VerifyRunner`, `runShell`). `reconcile.ts`: `reconcile`. `status.ts`: `status`
  (`--stale-days`, `--all`, `--json`; `parseStaleDays`, `describeStatus(report, staleDays)`).
- `board.ts`: `board ensure`. `init.ts` / `upgrade.ts` / `uninstall.ts` on `InstallContext` (`install.ts`). `doctor.ts`: see section 9.
- `config.ts`: ONLY `config validate` and `config suggest [--write]`. There is no `config set` and no `config` read path
  for a loaded `Config`. `ConfigCommandContext {run: GhRunner, repoRoot, configPath, out, err}`, `ConfigContextFactory`,
  private `runConfigAction`, `validate`, `suggest` (writes with flag `wx`, so it never overwrites). `registerConfigCommand(program, makeContext)`.
  A `config set mode` subcommand slots in here, but it must not run through `loadConfig` strictness the way `validate`
  does not either, and it needs an owner check (see 3 and 10).
- `githook.ts`: the git hook entrypoint, the pattern to copy (section 10).
- `errors.ts`: `formatCliError(error)`, `errorAsJson(error)`.

## 2. Config schema and load/write

`src/config/schema.ts`
- Consts: `PHASES`, `HARNESSES` (`claude|codex|gemini|agents-md`), `type Harness`.
- `RawConfigSchema` (zod strictObject, snake_case) fields: `version: 1`, `harnesses[]`, `mode: observe|enforce`,
  `github {repo, default_branch, project {owner, owner_type, number?}}`, `owners[]` (min 1), `agents[]` (logins agents write as),
  `content_language`, `merge_policy`, `quality_gate[]`, `task_types {enabled[], custom[]}`, `targets[]`, `models`,
  `stack {superpowers, graphify, branch_protection, actions}`, `mcp {servers[], scope project|user, github_transport remote|local}`,
  `kit_ref?`, `reconcile {closed_lookback_days}`, `secrets {local_store, production_store, allow[]}`.
  `superRefine` checks mcp ids (via `mcpIdValidator`), owners vs agents overlap, unique targets/environments, type registry.
- `ConfigSchema = RawConfigSchema.transform(...)` to camelCase `Config` (`cfg.github.defaultBranch`, `cfg.mcp.githubTransport`,
  `cfg.stack.branchProtection`, `cfg.kitRef` defaults to `v<packageVersion>`, `cfg.reconcile.closedLookbackDays`, ...).
  Plan 3 adds config fields here: a new `hooks`/`outbox` key needs raw field + transform entry + `tests/fixtures/config/valid.yaml`.
- `loadConfig(path): Config`, `loadConfigFromString(text)` (= `parseConfig`), `ConfigValidationError {issues: ConfigIssue[]}`,
  `typeRegistry(cfg): Map<string, TaskTypeDef>`, `targetByName(cfg, name)`, `setMcpIdValidator(validator): () => void`
  (test hook; `src/render/mcp.ts` `validateMcpIds` is the real validator injected at load).
- Parse is `yaml.parse` only (`import { parse as parseYaml } from 'yaml'`). NO comment-preserving round-trip writer exists.
  `src/install/detect.ts` uses `Document, isMap, isScalar, visit` from `yaml` but only to scan workflow files, and
  `src/render/frontMatter.ts` uses `stringify` for agent front matter. For `config set mode`, use `yaml` `parseDocument` +
  `doc.setIn(['mode'], value)` + `String(doc)` (keeps comments) or a one-line regex edit. Nothing does it yet.
- `mode` is read per call through `ctx.cfg.mode` (no caching), so a write takes effect on the next invocation.

## 3. Core: task model, state machine, approvals, trust

`src/core/types.ts`
- `Phase`, `Status` (`ready|in_progress|blocked|paused|in_review|awaiting_deployment|done`), `WaitingOn`, `EndsOn`, `EvidenceKind`,
  `TaskTypeDef {id,label,phases,endsOn,requiresBeforeReview,targetsRequired}`.
- `Approval {source: 'prompt'|'comment'|'unverified'; ref; by; at}`. `'prompt'` is in the type but NOTHING produces it yet.
- `StageRecord {revision, publishedAt?, approval?}`, `PrRecord`, `TypeChange {from,to,at,ref,source}`.
- `TaskState {schema: 1; issue; type; status; phase; waitingOn; summary; currentStep; nextStep; agent; targets; pendingTargets;
  prs; stages: Partial<Record<Phase, StageRecord>>; evidence; outcome?; cancelReason?; outcomeApproval?; resultPublishedAt?;
  finalMergedAt?; reopenedAt?; deliveredBy?; typeChanges?; updatedAt}`.
- `TaskEvent` union: `phase_started, stage_published, stage_approved, evidence_added, review_handoff, pr_merged, targets_deployed,
  accepted, confirmed_ran, cancelled, reopened, checkpoint`.
- "Is the plan approved?" has no helper. It is `state.stages.planning?.approval !== undefined` (set by `stage_approved` with
  `phase: 'planning'`). Types without a `planning` phase: `analysis` (intake, analysis, delivery), `artifact` (intake, brainstorming,
  creation, review, delivery), `spike` (intake, exploration, delivery). `bugfix` swaps `brainstorming` for `debugging`.
  Full lifecycle: intake, brainstorming, planning, implementation, verification, review, delivery
  (`feature`, `bugfix`, `tooling`, `production-data`). Spec 11 says edits are allowed without plan approval in "debugging repro,
  spike, docs": no such predicate exists; Plan 3 must define it (a pure `editsAllowed(state, type)` in `src/core/`).

`src/core/stateMachine.ts`
- `class TransitionError`, `newTask({issue,type,summary,now}): TaskState`, `applyEvent(state, event, type, now): TaskState`
  (pure, throws `TransitionError`), `ApprovalEvent`, `assertApprovalTiming(state, event)`.
- Approval timing: approval must be newer than `stages[phase].publishedAt` (and than `reopenedAt` / `resultPublishedAt` for end actions).

`src/core/stateComment.ts` (the hidden state; where gaps could go)
- `STATE_MARKER = '<!-- sdlc:state -->'`, `renderStateComment(state): string` (marker + fenced ```json + footer),
  `parseStateComment(body): TaskState | null` (null = not a state comment; throws `StateCommentError` naming the bad field),
  validated fields: `issue,status,phase,type,updatedAt,targets,pendingTargets,prs,evidence,stages`; schema must be 1.
- Gap recording (observe mode): there is no gaps field. Follow the `typeChanges?` pattern: optional `gaps?: Gap[]` on `TaskState`,
  a new `TaskEvent` kind (e.g. `gap_recorded`) handled in `applyEvent`, and an optional-array check in `parseStateComment`.
  Old comments stay valid because the field is optional. Keep it bounded (cap the array) since the whole state is one comment.

`src/core/approvals.ts` (R30 lives here)
- `APPROVAL_ACTIONS = ['approve','accept','ran','cancel']`, `approvalEvent(action, phase, reason, approval): ApprovalEvent`,
  `assertApprovalFits(state, type, action, phase, reason)`, `FAR_FUTURE`, `ApprovalRefusedError`.
- `parseApprovalCommands(comments, owners): ApprovalCommands`, `finalMergeTime(state, prs)`, `recordedRefs(state): Set<string>`
  (a comment url counts once), `normalizeCommentUrl`, `includesLogin`, `isOwner`.
- `validateOwnerComment({comment, action, cfg, login, typeId?}): Promise<{approval, command}>`: agents' logins refused in enforce,
  `unverified` in observe; author must be an owner; comment must not be edited (`updatedAt > createdAt` refuses); R30: author ==
  tracker login (`authenticatedLogin()`) refused in enforce with "authored by the agent's own login; approve via prompt or use a separate
  agent account", recorded `unverified` in observe; enforce with unknown login and no `agents` refused.
- `validateCommentApproval({comment, action, phase, state, cfg, login, finalMergedAt})` wraps it plus timing.
- Prompt approval (Plan 3) = a new producer of `Approval{source:'prompt', ref: <prompt id/hash>, by: <owner>, at}` fed from the
  UserPromptSubmit hook payload. It must come from the harness hook (the human's prompt), never from agent-controlled text.
  `approve.ts` today builds `{source:'unverified', ref:'unverified', by: login ?? 'unknown', at: ctx.now()}` when no `--comment-url`;
  add a `--prompt` branch there. The hook must record the prompt (id + text of `/approve ...` lines) where `approve --prompt`
  can verify it (a file under `.sdlc/cache/`, or a gap-style state field); `recordedRefs` must learn the prompt ref for reuse protection.

`src/core/ownerCommand.ts`: `OwnerAction = approve|accept|ran|merge|cancel`, `OwnerCommand {action, reason?}`,
`parseOwnerCommand(body): OwnerCommand | null` (first non-empty line, `/<action>`, case-insensitive, `/cancel` needs a reason).
`src/core/trust.ts`: `ACTIONS_BOT = 'github-actions[bot]'`, `trustedLogins(cfg, login): Set<string>`.
`src/core/taskTypes.ts`: `BUILTIN_TYPES`, `buildTypeRegistry(enabled, custom)`, `ConfigError`.
`src/core/projection.ts` (board field projection, `displayPhase`, `STATUS_LABELS`), `summary.ts`, `prBody.ts` (PR `Targets:`/`Scope:` lines).

"Owner-only" check for `config set mode`: owners are `cfg.owners` (GitHub logins). The tracker login comes from
`ctx.tracker.authenticatedLogin()` (may be `undefined` for Actions tokens). A local check would compare it with `cfg.owners`
(case-insensitive `isOwner`). Note an agent running under the owner's own login is indistinguishable; the spec relies on the
harness hook blocking agents from running `sdlc config set` (Bash-command matching in the PreToolUse hook).

## 4. Tracker interface, GithubTracker, FakeTracker, caching/outbox

`src/tracker/types.ts`
- `interface Tracker`: `authenticatedLogin`, `createIssue(title, body, labels)`, `addToBoard`, `listTrackedTasks`, `listUntracked`,
  `scanTasks(opts?: ScanOptions): TaskScan`, `getTask(issue): TrackedTask` (throws `NoStateCommentError` / `StateCommentError`),
  `getIssue`, `writeState(issue, state, expected?: ExpectedStateComment)` (throws `StateChangedError`), `postComment(issue, body):
  PostedComment {id, createdAt}`, `listComments(issue, sinceIso?)`, `setIssueOpen(issue, open, reason?)`, `setLabels(issue, add, remove)`,
  `syncFields(issue, fields)`, `listTaskPrs`, `getPr`, `listSuccessfulDeployments`, `listReleases`, `isAncestor`, `isOnDefaultBranch`,
  `createDeployment`.
- Types: `TrackedTask {issue,title,issueOpen,closeReason?,state,stateCommentId,stateCommentUpdatedAt}`, `IssueInfo`, `IssueComment`,
  `PrInfo`, `UntrackedIssue`, `TaskScan {tracked, untracked}`, `DeploymentInfo`, `ReleaseInfo`.
- Write methods (the outbox candidates): `createIssue, addToBoard, writeState, postComment, setIssueOpen, setLabels, syncFields,
  createDeployment`. Reads: everything else.

`src/github/githubTracker.ts`: `class GitHubTracker implements Tracker`, `constructor(run: GhRunner, cfg: Config, options:
GitHubTrackerOptions {repoRoot?})`. Everything goes through the `gh` CLI. `src/github/gh.ts`: `type GhRunner = (args, input?) =>
Promise<{stdout, stderr, code}>`, `defaultGhRunner`, `GhError {stderr}`, `ghJson`, `ghText`, `graphql`. `src/github/board.ts`:
`ensureBoard`, `planBoardChanges`, `resolveFieldIds`, `findRepoRoot`, `FieldMap`, `FIELD_NAMES`.

Caching/outbox: there is NO outbox, no offline queue and no `sdlc sync` (absent). The only on-disk cache is board field ids at
`.sdlc/cache/fields.json` (board.ts `resolveFieldIds`) and `.sdlc/cache/reconcile.log` (post-merge log, `RECONCILE_LOG`). `.sdlc/cache/`
is gitignored (`src/render/github.ts` `gitignoreLines`) and removed by uninstall (`src/commands/uninstall.ts`). Failure surfaces:
`trackerStep(name, issue, fn, hint)` wraps tracker calls with the failing step name; `StateChangedError` already means "re-run".
An outbox fits as a `Tracker` decorator (same pattern as `runTracker` in reconcile, section 6) that catches transport errors on the
write methods above and appends `{id, method, args}` JSON lines to `.sdlc/cache/outbox.jsonl`; `sdlc sync` replays them in order and
treats `StateChangedError` as conflict (re-read, then re-apply the event, not the stale state). Writes carry whole `TaskState`
values, so queue the event or the intent, not the state.

`tests/support/fakeTracker.ts`: `class FakeTracker implements Tracker` plus `FakeIssue`, `FakeComment`, `FakePr`, `FakeDeployment`.
In-memory, supports seeded issues/comments/PRs/deployments; used by `tests/commands/taskFlow.test.ts`, `tests/engine/*.test.ts`.
Test the outbox decorator against it by making a method throw.

## 5. Current-task resolution

- The only helper: `taskIssueOf(branch: string | undefined): number | undefined` in `src/commands/githook.ts` (`/^task\/(\d+)-/`).
- `currentBranch(git)` in `githook.ts` is private (`git symbolic-ref --short -q HEAD`, undefined when detached). `describeCheckout(state)`
  builds the one-line task context for post-checkout (`#N: phase / status ...`): reuse it for session-start context injection.
- Nothing maps a worktree path to a task; nothing reads `cwd` from a harness payload. Conventions in the instructions:
  branch `task/<issue>-<slug>`, worktree `.worktrees/<issue>-<slug>` (template block.md "Worktrees").
- Plan 3 needs: `resolveCurrentTask(git, cwd): Promise<{issue, branch, worktree} | undefined>` from the hook payload `cwd` via
  `git -C <cwd> symbolic-ref --short -q HEAD` and `git -C <cwd> rev-parse --show-toplevel`. `GitRunner` takes only `args`, so use
  `createGitRunner(cwd)` per payload cwd (`src/install/provision.ts`).
- Tracker lookup of the resolved issue: `lookupTrackedTask(tracker): TaskLookup` (githook.ts, boolean) or `tracker.getTask(issue)`.

## 6. Engine: status and reconcile (read-only mode)

`src/engine/status.ts`
- `statusReport(ctx, {staleDays, all?}): Promise<StatusReport>`, `StatusReport {byStatus: Record<Status, TaskSummary[]>, waitingOnOwner,
  staleAwaitingDeployment, stalePausedOnAgent, untracked: {issue,title}[], pendingReconcile: ReconcileAction[]}`,
  `TaskSummary {issue,title,status,phase,type,pendingTargets,updatedAt,ageDays}`. `QUIET_KINDS` filters reconcile actions that
  write nothing. Orphan worktrees (spec 13) are absent: add `orphanWorktrees: {path, branch, reason}[]` to `StatusReport`, fill it
  in `statusReport` (needs a git runner on `CommandContext` or an extra param), and render it in `describeStatus` (`src/commands/status.ts`).
  `statusReport` only has `ctx.tracker` and `ctx.cfg` today, no git, so `CommandContext` or the options need a `git` addition
  (tests build contexts by hand in `tests/engine/status.test.ts`, `tests/commands/status.test.ts`).
- Orphan definition to settle: worktree under `.worktrees/` whose branch `task/<n>-...` has no tracked task, or whose task is `done`
  (cleanup due), or whose branch is gone.

`src/engine/reconcile.ts`
- `reconcile(ctx, opts: ReconcileOptions = {}): Promise<ReconcileResult {actions, errors}>`, `ReconcileOptions {dryRun?, only?: 'deployments'|'all', issue?}`,
  `ReconcileAction {issue, kind, detail ...}`, `lookbackScan(cfg, now): ScanOptions`.
- Read-only mode already exists: `runTracker(tracker, dryRun)` wraps a `Tracker` so reads pass through and every write
  (`createIssue, addToBoard, writeState, postComment, setIssueOpen, setLabels, syncFields, createDeployment`) is a no-op that
  returns a canned value in a dry run. The session-start hook's "read-only reconcile" is `reconcile(ctx, {dryRun: true})`;
  `statusReport` already uses it for `pendingReconcile`.
- `src/engine/deployments.ts`: deployment/evidence matching. Not touched by Plan 3.

## 7. Git helpers and worktree list

- `src/install/provision.ts`: `type GitRunner = (args: string[]) => Promise<{stdout, code, stderr}>`, `createGitRunner(cwd?)`
  (rejects only when git cannot run; non-zero exit is returned), `defaultGitRunner`, `HOOKS_PATH = '.sdlc/githooks'`,
  `normalizeHooksPath`, `readHooksPath(git)`, `setHooksPath(git, opts): 'set'|'already'|'conflict'`, `HookFileState`, `HookProbe`,
  `nodeHookProbe`, `findLegacyHooks(git, root, probe)`, `ensureLabels`, `ensureBranchProtection`, `readPushProtection`, `ensurePushProtection`.
- `src/secrets/gitDiff.ts`: `stagedChanges(git)`, `pushedChanges(git, updates)`, `parseUnifiedDiff`. `src/secrets/gitleaks.ts`:
  `Exec`, `Which`, `execProgram(cwd, timeoutMs?, env?)`, `findOnPath(command, env?)`, `runGitleaks`.
- `src/install/repoFs.ts`: `RepoFs {root, read, write, remove, list(dir, depth)}`, `nodeRepoFs(root)`.
- Worktree list: `git worktree list --porcelain` is used NOWHERE (absent). The only worktree knowledge is `.worktrees/` in the
  gitignore block, the Worktrees section of `templates/instructions/block.md`, and `findRepoRoot` in board.ts (treats a `.git`
  file as a root). Add `listWorktrees(git): Promise<Worktree[]>` (parse `worktree <path>`, `HEAD`, `branch refs/heads/..`, `detached`,
  `bare`, `locked`, `prunable`), probably `src/install/worktrees.ts` or `src/engine/worktrees.ts`. No `--force`/`prune` anywhere (spec 13).
- Caveat when the hook runs inside a worktree: `git rev-parse --git-common-dir` is the shared dir; the git hook script already
  uses it to find the legacy hook (`templates/githooks/hook.sh`). `.sdlc/cache/` and `sdlc.config.yaml` resolve against
  `gitRoot(cwd)` which is the worktree's own top level (the config is tracked, so each worktree has its copy).

## 8. Render and install

Pipeline: `src/render/plan.ts` `renderAll(cfg, fs): {changes: Change[], userCommands: string[], notes: string[]}` runs, per harness,
`renderInstructions` + `renderAgents` + `renderMcp`, then once `renderGithub` + `renderGitHooks`, then `mergeChanges` (one change per
path, sorted; json-keys of a path merged to one change; toml-blocks of a path merged, bodies joined by a blank line; identical
file/md/line-blocks deduped; conflicts throw). Add `renderHooks(cfg, harness): Change[]` to the per-harness loop in `renderAll`.

`src/render/changes.ts` `Change` kinds (paths repo-relative, `/`):
- `FileChange {kind:'file', path, content, mode?: 0o755}`; `MdBlockChange {kind:'md-block', path, content}` (`<!-- sdlc:begin/end -->`);
  `LineBlockChange {kind:'line-block', path, content, comment:'#'}` (`# sdlc:begin/end`);
  `JsonKeysChange {kind:'json-keys', path, entries: {pointer: string[], value, items?: {marker: string}}[]}`;
  `TomlBlockChange {kind:'toml-block', path, content, ownedTables: string[]}` (markers `# >>> sdlc:begin (managed by agentic-sdlc-kit; ...) >>>`).

Merge engine `src/install/merge.ts` (pure, string in/out; `MergeError`): `mergeMdBlock`, `mergeLineBlock`, `mergeTomlBlock(existing, body,
ownedTables)`, `filterTomlBody` (drops tables the user already defines outside the block, reports `skipped`), `tomlTableText`,
`mergeJsonKeys(existing, entries, owned: Set<string>, path)`: sets a key if absent or owned (by manifest key, pointers joined by `/`);
a present key the user owns is left alone and reported in `skipped`; the edits are spliced into the user's text (offset-tracking
scanner in `src/install/jsonText.ts`), so everything the user wrote around them stays byte for byte; `createdParents` for objects and
arrays it had to create. `removeJsonKeys`, `jsonKey`, `jsonValueAt`, `parseJsonObject`, `canonicalJson`, `blockBody`.
Owned array items: a `json-keys` entry owns its entire value, unless it carries `items: {marker}`. It then owns only the elements of
the array whose `JSON.stringify` contains the marker; the user's other elements stay, ours are appended last, and uninstall removes only
ours. Use this for hook arrays such as `['hooks','PreToolUse']`: `value` is the array of our items, each containing the marker.
`.claude/settings.json` is NOT rendered today (absent); Claude MCP goes to `.mcp.json`. Rendering hooks there is a new json-keys
change at `['hooks', <Event>]` (also `permissions` must not be touched).

Existing MCP rendering `src/render/mcp.ts` (`renderMcp(cfg, harness, catalog?)`, `parseMcpCatalog`, `loadMcpCatalog`, `validateMcpIds`,
`mcpEnvVars`, `mcpNotes`, `McpServerDef`, `McpCatalogError`): project scope writes `.mcp.json` (claude, key `mcpServers/<id>`),
`.gemini/settings.json` (gemini, `mcpServers/<id>`, `httpUrl`), `.codex/config.toml` (codex, `toml-block` with `ownedTables`
`mcp_servers.<id>`); user scope returns `userCommands` (`claude mcp add --scope user ...`, `codex mcp add ...`, `gemini mcp add ...`).
So `.gemini/settings.json` and `.codex/config.toml` are ALREADY written by the MCP renderer: hooks must merge into the same
`Change` (same path, same kind) via `mergeChanges`, so a gemini `hooks` json-keys entry and the `mcpServers` ones fuse, and the
codex hooks tables join the one toml-block (add their names to `ownedTables`).

Manifest `src/install/manifest.ts`: `MANIFEST_PATH = '.sdlc/manifest.json'`, `ManifestEntry {path, kind, key?, hash, marker?, createdFile?,
createdParents?}`, `Manifest {version: 1, kit, entries}`, `newManifest`, `serializeManifest`, `parseManifest`, `readManifest(fs)`,
`hashText`, `entryDiskHash(entry, text)`. Entry kinds: `file`, `md-block`, `line-block`, `json-keys` (key = pointer joined by `/`),
`toml-block` (key = table name, or none for the whole block). A user-modified managed region is detected by hash and kept unless
`--overwrite-modified`. An items entry records its `marker` (uninstall needs it) and its `hash` covers the owned elements only;
`createdParents` may list an array we created. Entries without `marker` read as before, so the manifest `version` stays 1.
Apply `src/install/apply.ts`: `planApply(...)`, `applyPlan(plan, fs, {removeObsolete})`, `planUninstall(fs, manifest)`, `formatPlan`,
`Notice`, `PlanError`, `ApplyPlan`, `OBSOLETE_MODIFIED`. Commands `src/commands/install.ts`: `Reporter`, `InstallContext`,
`installFiles(...)`, `runInit(ctx, options)`, `runUpgrade`, `runUninstall`.

Instructions `src/render/instructions.ts`: `renderData(cfg, roles): RenderData`, `renderInstructions(cfg, harness, data): Change[]`
(md-block in `INSTRUCTION_FILE[harness]`: claude `CLAUDE.md`, codex/agents-md `AGENTS.md`, gemini `GEMINI.md`; skills in
`SKILL_DIR`: `.claude/skills`, `.agents/skills`), `RenderData`, `KIT_GIT_URL`. Agents `src/render/agents.ts`: `renderAgents`, `loadRoles`,
`builtinRoles`, `modelFor`, `CUSTOM_ROLES_DIR = '.sdlc/agents/custom'`, `TIERS`. Template engine `src/render/template.ts`
(`renderTemplate(text, data, name)`, mustache-like `{{x}}`, `{{#if x}}...{{else}}...{{/if}}`), `src/render/templates.ts` `loadTemplate(relPath)`, `templatesDir()`.
GitHub files `src/render/github.ts`: `renderGithub`, `renderGitHooks`, `GIT_HOOKS`, `WORKFLOW_PATH`, `gitignoreLines` (private).

Templates `templates/`: `instructions/block.md` (105 lines), `skills/sdlc-{task-tracking,delivery,orientation}/SKILL.md`, `agents/*.md`
(11 roles), `githooks/hook.sh`, `github/{pull_request_template.md,sdlc-reconcile.yml}`, `mcp/catalog.yaml`.
Hook mentions in `templates/instructions/block.md`: line 6 (enforce paragraph) says "Harness hooks that block edits before the plan is
approved are coming; until then, keep that rule yourself." Replace when hooks ship. Observe paragraph says "Gaps are recorded and warned
about". Superpowers section is `{{#if superpowers}}` (line 28); graphify section `{{#if graphify}}` (line 93); Worktrees section line 70;
"Never `git push --force`, `git worktree prune` or `rm -rf`" at line 56. Golden files for it: `tests/golden/instructions/**`.

## 9. Doctor

`src/install/doctor.ts`
- `type CheckStatus = 'ok'|'warn'|'fail'`, `Check {id, status, message, fix?}`, helpers `ok/warn/fail/notChecked(id, why)`,
  `isolated(id, run)` (a throw becomes `fail` with one-line message), `describeError`, `printable`, `ghReason`.
- `DoctorEnv {run: GhRunner, git: GitRunner, fs: RepoFs, which(cmd, env?), exec(cmd, args, {env?, timeoutMs?}), hookProbe?, env, nodeVersion,
  config: {path, read()}}`. All IO is injected, so every new check is unit-testable with fakes.
- `runPreflight(env, {actions?}): Check[]`: ids `git.repo, node.version, gh.installed, gh.auth, gh.scopes, repo.remote, repo.instructionFiles, config.present`.
- `runDoctor(env, cfg)` order: preflight, `config.valid`, `manifest.present`, `files.managed`, `git.hooksPath`, `git.legacyHooks`, `sdlc.onPath`,
  `kit.ref`, `board.fields`, `labels`, (`actions.workflow`, `actions.secret` when `stack.actions`), `mcp.token`, `mcp.claude`, `secrets.guard`,
  `secrets.pushProtection`, `secrets.trackedFiles`, `approvals.trust`. `doctorChecks(env, {preflightOnly?})` is what the command runs.
- Add checks inside `runDoctor` with `await add(isolated('<id>', () => checkX(env, cfg)))`. Candidates: `stack.superpowers`, `stack.graphify`,
  `mcp.codex`, `mcp.gemini`, `hooks.claude|codex|gemini` (rendered hooks present), `outbox.pending`, `worktrees.orphans`.
- MCP check today: `checkMcpClaude(env, cfg)` (id `mcp.claude`): skips if claude not a harness (`ok ... skipped`) or `claude` not on PATH; runs
  `env.exec('claude', ['mcp','list'])`; parses `<id>: ...` lines into a set; `warn` listing missing ids with a fix. Only Claude exists. `checkMcpToken`
  (`mcp.token`) checks env var names only (never values). Codex and Gemini equivalents: `codex mcp list`, `gemini mcp list`, plus reading the rendered
  `.codex/config.toml` / `.gemini/settings.json` through `env.fs` (cannot depend on the CLI being installed). Generalise `checkMcpClaude` into
  `checkMcpHarness(env, cfg, harness)`; the `exec` fake in `tests/install/doctor.test.ts` already answers only `claude`, `npx`, `git`
  and throws `unexpected exec: <cmd>` otherwise: extend it.
- Superpowers/graphify doctor: `exec`/`which` are the tools (`which('graphify')`, `claude plugin list`, `gemini extensions list`; the harness
  fake answers `npx` with code 1 and `git` with ls-remote output for `kit.ref`). Install side: `renderAll` returns `userCommands` and `notes`,
  `src/commands/init.ts` prints them as `next:` lines; Superpowers/graphify install belongs in the same channel (print the command when a step needs the user).
- `hookEnvironment(env, platform)` (doctor.ts) strips env vars before spawning a child; use it for any new `exec` that runs a harness CLI.
- Command: `src/commands/doctor.ts` `DoctorContext {env, out, err}`, `formatChecks`, `runDoctorCommand(ctx, {preflight?, json?})` (exit 1 on any `fail`),
  `registerDoctorCommand(program, makeContext, io)`. Real env built in `cli.ts` `makeDoctorContext` (`findOnPath`, `execProgram`).

## 10. githook: the hook-entrypoint pattern

`src/commands/githook.ts` (about 582 lines). `sdlc githook <name> [args...]`, registered with `.allowUnknownOption()`, sets
`process.exitCode = await runGitHook(name, args, await makeContext())`. Script side: `templates/githooks/hook.sh` (mustache-rendered per hook by
`renderGitHooks`; calls `sdlc githook`, falls back to `npx --no-install sdlc`, else prints "sdlc not found; ... skipped" and exits 0; then
chains the legacy hook).
- Context: `GitHookContext {repoRoot, git, loadConfig(), makeTracker(cfg), readStdin(), spawnReconcile(logPath), out, err, exec?, which?,
  timeouts?, exit?}`. Everything is injected; `cli.ts` `makeGitHookContext` builds the real one (lazy config via `environment()`,
  lazy tracker, `readAllStdin()`, `spawnDetachedLogged`, `exitAfterFlush`). A hook never throws out of the context factory.
- Decisions are pure: `decidePreCommit(branch, cfg): HookDecision`, `decidePrePush(...)`, `HookDecision {exitCode: 0|1, messages: HookMessage[]}`,
  `HookMessage {level: 'warn'|'error', text}`, private `rule(cfg, text)` = warn in observe, error in enforce, `decisionOf`, `report(ctx, decision)`
  prints `sdlc: error: ...` / `sdlc: warning: ...` to stderr.
- Robustness: secret guard fails closed (both modes); everything else fails open (warn, exit 0): `configReader(ctx, hook, quiet)` returns
  `() => Config | undefined`, `runSteps(ctx, hook, steps)` (never throws, highest exit code wins), private `deadlineOf(totalMs): Deadline`
  shared by all tracker calls of one hook (`run`, `stop`, `abandoned`; if abandoned, `ctx.exit?.(code)` ends the process),
  timeouts `PRE_PUSH_LOOKUP_TIMEOUT_MS = 10_000`, `POST_CHECKOUT_LOOKUP_TIMEOUT_MS = 5_000`. `HOOK_NAMES`, `HookName`, `RECONCILE_LOG`.
- Helpers to reuse: `taskIssueOf`, `lookupTrackedTask(tracker): TaskLookup`, `describeCheckout(state)`, `parsePushUpdates`, `readAllStdin`,
  `exitAfterFlush(code, exit?, streams?)`, `spawnDetachedLogged({command,args,cwd,logPath})`.
- For `sdlc hook <harness> <event>` mirror this: new `src/commands/hook.ts` with `HookContext`, `registerHookCommand(program, makeContext)`,
  pure `normalizePayload(harness, event, json): CommonEvent`, pure `decideX(event, state, cfg): HarnessDecision`, a `runHook(harness, event,
  ctx): Promise<number>` that fails open outside the explicit blocks, and a `makeHookContext` in `cliDeps`. The harness protocols differ:
  Claude hooks exit 2 + stderr to block (or print JSON `{decision, reason}`), session context via stdout / `additionalContext`; Gemini
  and Codex have their own payload shapes (verify against current docs; not in this repo). `sdlc hook` must always answer fast: apply a
  `Deadline`, never prompt, never write to stdout except the protocol's own output (`--json` global option is not for hooks).

## 11. Tests, goldens, fakes, e2e

Run: `npm test` (`vitest run`, include `tests/**/*.test.ts`), `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`), `npm run build` (tsc to `dist/`).
`tests/cli.test.ts` spawns the built CLI (`spawnSync(process.execPath, [cliPath, ...args], {cwd, env})`), so e2e needs `npm run build` first.
- `tests/support/golden.ts`: `expectGolden(dir, changes)`, `goldenLayout(changes)`, `GOLDEN_INDEX = '_changes.txt'` (one line per path with its kind).
  Goldens under `tests/golden/{agents,githooks,github,instructions,mcp}/<scenario>/`. Rewrite with `UPDATE_GOLDEN=1 npx vitest run <file>`
  (also removes stale files). New `tests/golden/hooks/` follows the same pattern; the `instructions` goldens change when block.md changes.
- `tests/support/fakeGh.ts`: `fakeGh(script: FakeGhStep[]): FakeGh` (n-th call answered by n-th step; `match: string[]` all must appear among args;
  has `calls`, `inputs`). `tests/support/fakeTracker.ts`: `FakeTracker`. `tests/support/memoryFs.ts`: `memoryFs(initial): MemoryFs` (`files`, `modes`,
  `log`, `snapshot()`, `root: '/memory'`, refuses paths outside). `tests/support/gitRepo.ts`: `createTestRepo(): TestRepo {root, env, git(...),
  write, commit, cleanup}` (real git in a tmp dir with isolated HOME), `isolatedEnv(home, path?)`. `tests/support/secrets.ts` (fake secret strings).
- Doctor tests `tests/install/doctor.test.ts`: private `harness(options): Harness` builds a full `DoctorEnv` from fakes (`fakeGit`, `fakeGh(ghScript(cfg))`,
  `installed` PATH set, `exec` answers by command, `config.read`), `byId`, `statuses`, `notOk`, `mutations(gh)` asserts doctor never writes.
- Hook-style tests to copy: `tests/commands/githook.test.ts` (decision functions and `runGitHook` with a hand-built `GitHookContext`, real repos
  via `createTestRepo`). Config fixture `tests/fixtures/config/valid.yaml` (mode observe, three harnesses, mcp defaults).
- Other relevant suites: `tests/commands/{taskFlow,status,config,install,board,errors}.test.ts`, `tests/engine/{reconcile,status,deployments}.test.ts`,
  `tests/core/*.test.ts`, `tests/render/mcp.test.ts` (all harnesses and scopes), `tests/install/{apply,merge,provision,detect}.test.ts`,
  `tests/render/{githooks,instructions,agents,template,toml}.test.ts`, `tests/docs/readme.test.ts` (README/INSTALL consistency; update with docs).

## 12. Leftovers and doc mentions of Plan 3 / hooks

- `docs/notes/plan-1-rulings.md`: R20 (MCP doctor checks Plan 3), R30 (own-login approvals: "approve via prompt or use a separate agent account"; cost
  note "solo same-login users can't approve by comment in enforce until Plan 3 prompt log"), R40, R47 (N1+N2 parked: `weakensEnd` covers
  `merge_or_acceptance`; `require /approve type` ...; fix before merge).
- `docs/superpowers/plans/2026-11-27-plan-2-installer.md` lines 15, 81, 82, 85: hooks, MCP doctor and prompt approval deferred to Plan 3.
- `templates/instructions/block.md` line 6: "Harness hooks that block edits before the plan is approved are coming".
- `README.md` line 5: "Status: core CLI and installer available; harness hooks next". Command list lines 57-61 (add `hook`, `sync`, `config set`).
  `INSTALL.md` line 53 (enforce paragraph), 161 (what `init` writes: add the hook files/keys), "Owner, agents and tokens" section (prompt approval).
- Code: no TODO/FIXME markers in `src/` or `templates/`. `Approval.source: 'prompt'` and the `unverified` fallbacks in `approve.ts`/`task.ts` are the seams.
- Not present anywhere (confirmed by grep): `config set`, YAML round-trip writer, `--prompt`, outbox, `sync`, `git worktree list`, orphan detection,
  `.claude/settings.json` rendering, Codex/Gemini hook rendering, "edits allowed" phase predicate, Superpowers/graphify doctor checks, MCP doctor for
  codex/gemini, gaps field in `TaskState`.
