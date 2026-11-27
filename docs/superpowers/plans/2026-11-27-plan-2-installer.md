# agentic-sdlc-kit Plan 2 — Installer & Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sdlc init` installs agentic-sdlc-kit into any repository from a committed `sdlc.config.yaml`. It renders instructions, role agents, skills and MCP servers for every selected harness, writes git hooks, the PR template and the reconcile workflow, and provisions GitHub (board, labels, branch protection). `upgrade`, `uninstall` and `doctor` keep the installation correct, and none of them clobbers user content.

**Architecture:**
- Rendering is pure. Config + canonical templates → a list of `Change`s (a managed file, a managed Markdown block, owned JSON keys, a managed TOML block).
- One apply engine compares the changes with the repository and the install manifest `.sdlc/manifest.json`, prints the plan (`--dry-run`) and writes it.
- GitHub provisioning reuses Plan 1's `gh` layer.
- Harness adapters are data and small render functions over one template set. No logic is duplicated per harness.

**Tech Stack:** Node.js ≥ 20, TypeScript strict ESM, `commander`, `yaml`, `zod`, `vitest`. No new runtime dependency: the template engine and the TOML block writer are in-house.

**Spec:** `docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md`. This plan implements §6 and §12, §9 rendering, §11 (git-hook layer only) and §14 (MCP). It covers the instruction and skill content that §12 requires, the §10 workflow template, and the doctor checks of §6 step 7 except the harness-hook round trip, which is Plan 3.

**Harness formats:** verified 2026-11-27 against official docs, see "Harness Facts" below. Re-verify a format only if a test against a real harness disagrees.

**Plan series:**
1. Core & tracker CLI (merged).
2. Installer & renderer (this plan).
3. Harness hooks & enforcement: hook entrypoint, prompt log, enforce blocks, `sdlc config set mode`, Superpowers/graphify install, worktrees, harness-hook doctor round trip.
4. OSS packaging, npm publish, dogfooding, e2e.

## Global Constraints

- Everything in Plan 1's Global Constraints still holds: Node ≥ 20, strict ESM, runtime deps only `commander`/`yaml`/`zod`, `gh` for all GitHub access, English only, and nothing from the private reference project.
- Rendering and planning are pure functions over an injected `RepoFs`. Only `apply` writes, and only inside the repository root. `init`, `upgrade` and `uninstall` never write outside the repository (no `~/.claude.json`, no `~/.codex`). User-scope steps are printed as commands for the owner to run.
- Never clobber user content:
  - Markdown instruction files get only the block between `<!-- sdlc:begin -->` and `<!-- sdlc:end -->`.
  - JSON files get only the keys the manifest says we own.
  - `.codex/config.toml` gets only the block between `# >>> sdlc:begin (managed by agentic-sdlc-kit; edits inside are overwritten) >>>` and `# <<< sdlc:end <<<`.
  - A whole file we would create that already exists and is not in the manifest is skipped with notice `exists, not managed by sdlc; kept`.
  - A managed file or block whose content no longer matches the manifest hash is skipped with notice `modified locally; kept (rerun with --overwrite-modified to replace)`.
- Managed paths, exactly:
  - Repository root: `sdlc.config.yaml` (user-owned, never written by init), `.sdlc/manifest.json`, `.sdlc/githooks/{pre-commit,pre-push,post-merge,post-checkout}` (mode 0755), `.sdlc/cache/` (gitignored), `.sdlc/agents/custom/` (user-owned).
  - Claude: `CLAUDE.md` block, `.claude/agents/sdlc-<role>.md`, `.claude/skills/sdlc-<skill>/SKILL.md`, `.mcp.json` keys `mcpServers.<id>`.
  - Codex: `AGENTS.md` block, `.codex/agents/sdlc-<role>.toml`, `.codex/config.toml` managed block with `[mcp_servers.<id>]`.
  - Gemini: `GEMINI.md` block, `.gemini/agents/sdlc-<role>.md`, `.gemini/settings.json` keys `mcpServers.<id>`.
  - AGENTS.md-only harnesses: `AGENTS.md` block with a "Roles" section.
  - Skills for Codex, Gemini and AGENTS.md-only harnesses: `.agents/skills/sdlc-<skill>/SKILL.md`.
  - GitHub: `.github/pull_request_template.md`, `.github/workflows/sdlc-reconcile.yml`.
  - `.gitignore` lines `.sdlc/cache/` and, with `stack.graphify`, `graphify-out/`, inside a `# sdlc:begin` / `# sdlc:end` block.
- Secrets never go into a file. MCP credentials are read from env var `GITHUB_PERSONAL_ACCESS_TOKEN`:
  - Claude: `${GITHUB_PERSONAL_ACCESS_TOKEN}`.
  - Codex: `bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"`.
  - Gemini: `$GITHUB_PERSONAL_ACCESS_TOKEN`.
- Generated agent instructions must contain these prohibitions verbatim in meaning:
  - no deploy without the owner's explicit confirmation in the current turn;
  - never run a script that changes production data (the owner runs it);
  - never `gh pr merge --admin`, never bypass checks or reviews;
  - never launch another AI CLI or model (claude, codex, gemini, aider, cursor, ollama, …) as a helper;
  - never `git push --force`, `git worktree prune` or `rm -rf`;
  - PRs use `Related to #N`, never closing keywords.
- The managed instruction block is under 150 lines for every config (test).
- Every command supports `--json` and `--dry-run` where it writes. The exit code is non-zero on any failed write or failed doctor check.
- The kit is referenced in generated files as `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<kit_ref>`. `kit_ref` defaults to `v<package version>` until npm publishing (Plan 4).

## Harness Facts (verified 2026-11-27)

| Harness | Instructions | Role agents | Skills | MCP |
|---|---|---|---|---|
| claude | `CLAUDE.md` | `.claude/agents/<name>.md`, YAML front matter `name`, `description` (required), `model` (`opus`/`sonnet`/`haiku`/`fable`/full id/`inherit`), `disallowedTools` (comma string) | `.claude/skills/<n>/SKILL.md`, front matter `name`, `description` | `.mcp.json` `mcpServers.<id>`; stdio = `command`/`args`/`env` (no `type`); remote = `type: "http"`, `url`, `headers`; `${VAR}` expands |
| codex | `AGENTS.md` | `.codex/agents/<name>.toml`: `name`, `description`, `developer_instructions` (required), optional `model`, `model_reasoning_effort` | `.agents/skills/<n>/SKILL.md` (`name`, `description` required) | `.codex/config.toml` `[mcp_servers.<id>]`; stdio = `command`, `args`, `env_vars`; HTTP = `url`, `bearer_token_env_var`; no `${VAR}` expansion; project `.codex/` loads only for trusted projects |
| gemini | `GEMINI.md` | `.gemini/agents/<name>.md`, front matter `name` (lowercase, digits, `-`, `_`), `description`, optional `model` (default `inherit`) | `.agents/skills/<n>/SKILL.md` | `.gemini/settings.json` `mcpServers.<id>`; stdio = `command`/`args`/`env`; streamable HTTP = `httpUrl` + `headers`; `$VAR` expands; no `type` key |
| agents-md | `AGENTS.md` | "Roles" section in the block | `.agents/skills/<n>/SKILL.md` | none |

- GitHub MCP remote endpoint: `https://api.githubcopilot.com/mcp/`, header `Authorization: Bearer <PAT>`.
- GitHub MCP local server: `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server`.
- Context7: stdio `npx -y @upstash/context7-mcp`, remote `https://mcp.context7.com/mcp`.
- Playwright: stdio `npx @playwright/mcp@latest`; there is no remote endpoint.
- User-scope add commands:
  - `claude mcp add --scope user --transport http <id> <url> --header "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN"`, or `claude mcp add --scope user <id> -- <command> <args…>`;
  - `codex mcp add <id> --url <url> --bearer-token-env-var GITHUB_PERSONAL_ACCESS_TOKEN`, or `codex mcp add <id> -- <command> <args…>`;
  - `gemini mcp add --scope user --transport http --header "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" <id> <url>`, or `gemini mcp add --scope user <id> <command> <args…>`.

## Rulings Made While Planning

- Gemini CLI stays a target, as the spec says. Antigravity reads `AGENTS.md` and `.agents/skills`, so the `agents-md` tier already covers it. A native Antigravity target (`.agents/agents`, `.agents/mcp_config.json`) is deferred — cost if wrong: one more adapter later.
- Harness hooks, enforcement blocks, and installing Superpowers or graphify all belong to Plan 3. Plan 2 only renders the instruction text that mentions them — cost if wrong: installs before Plan 3 have no harness-level guard, only git hooks.
- The Actions workflow needs a PAT secret `SDLC_TOKEN` with repo and project scopes, because `GITHUB_TOKEN` cannot write Projects v2. If that PAT is the owner's own token and mode is enforce, R30 ignores the owner's `/approve` comments, since owner and agent comments come from the same login. INSTALL.md recommends that agents run under a separate account listed in `agents`, and doctor warns about it — cost if wrong: owners in enforce mode with one account must approve with `--prompt` (Plan 3).
- Until tags exist (Plan 4), the kit's own dogfood config sets `kit_ref: main`.
- Still deferred from Plan 1: M6 label check, M7 retry dedup, M8 old-approval noise, M10 review-body commands, M11 package `files`, the threat-model write-up, the outbox / `sdlc sync`, and the Plan 3 minors listed in `docs/notes/plan-1-rulings.md`.

## Review Focus

1. **The repository already has a hand-written `CLAUDE.md`, `.mcp.json` with its own `github` server, and a `.codex/config.toml` with root keys.** Init keeps every byte outside its managed regions. It skips the user's `github` server with a notice and does not take ownership of it. It appends the TOML block after the user's content (Task 3 test `preserves user content in every merge kind`; Task 10 test `init into a customized repository`).
2. **Running `init` twice, or `upgrade` with no template change**, writes nothing and reports `up to date` (Task 10 test `second init is a no-op`).
3. **The user edited a managed agent file, then runs `upgrade`.** The file is kept, the notice names it, and the exit code is 0. `--overwrite-modified` replaces it (Task 3 test `keeps locally modified managed content`).
4. **`uninstall` after the user changed a managed file or added their own MCP server** removes only unmodified managed content, leaves user servers and text, and removes the manifest last (Task 10 test `uninstall leaves user content`).
5. **Markers damaged by hand** (a `<!-- sdlc:begin -->` without its end, or two begin markers) → the apply refuses that file with a precise error and writes nothing to it. Other files still apply and the exit code is non-zero (Task 3 test `refuses damaged markers`).

---

## File Structure

```
templates/                                 canonical content (shipped in the package)
  instructions/block.md                    managed block body (template)
  skills/{sdlc-task-tracking,sdlc-delivery,sdlc-orientation}/SKILL.md
  agents/<role>.md                         11 roles: front matter + prompt body
  mcp/catalog.yaml                         MCP server catalog (data)
  github/pull_request_template.md
  github/sdlc-reconcile.yml
  githooks/hook.sh                         one script body, rendered per hook name
src/render/template.ts                     tiny template engine
src/render/templates.ts                    template directory resolution + loading
src/render/frontMatter.ts                  parse/emit YAML front matter
src/render/changes.ts                      Change types
src/render/instructions.ts                 managed instruction block + skills per harness
src/render/agents.ts                       role library → per-harness files
src/render/mcp.ts                          catalog → per-harness MCP changes + user-scope commands
src/render/github.ts                       PR template, workflow, githooks, .gitignore changes
src/render/plan.ts                         renderAll(cfg, ctx) → Change[]
src/install/repoFs.ts                      RepoFs interface + node implementation
src/install/manifest.ts                    manifest read/write, hashing
src/install/merge.ts                       markdown block, JSON keys, TOML block merges
src/install/apply.ts                       planApply / applyPlan / planUninstall
src/install/provision.ts                   labels, branch protection, hooksPath
src/install/detect.ts                      config suggestion from the repository
src/install/doctor.ts                      checks
src/commands/{init,upgrade,uninstall,doctor,config,githook}.ts
INSTALL.md                                 read by the installing agent (kit repo root)
tests/support/memoryFs.ts                  in-memory RepoFs
tests/golden/<scenario>/…                  golden renders
```

---

### Task 1: Config additions, `config validate`, `config suggest`

**Files:**
- Modify: `src/config/schema.ts`, `src/cli.ts`
- Create: `src/install/detect.ts`, `src/commands/config.ts`
- Test: `tests/config/schema.test.ts`, `tests/install/detect.test.ts`

**Interfaces:**
- Produces: config fields (YAML → `Config`):
  - `mcp: { servers: string[] (default ["github"]), scope: 'project'|'user' (default 'project'), github_transport: 'remote'|'local' (default 'remote') }` → `cfg.mcp = { servers, scope, githubTransport }`;
  - `kit_ref?: string` → `cfg.kitRef` (default `v<package version>`, read from package.json);
  - `reconcile: { closed_lookback_days: number (int ≥ 1, default 30) }` → `cfg.reconcile.closedLookbackDays`.
- Unknown MCP ids are a config error naming the catalog ids, validated in Task 6 through `validateMcpIds(ids: string[]): string[]` (error messages). Task 1 adds a zod refinement hook that calls an injected validator. Until Task 6 the validator accepts `github`, `context7` and `playwright`.
- `detectConfig(probe: RepoProbe): DetectedConfig` (pure), where:
  - `RepoProbe = { repo: string; defaultBranch: string; ownerType: 'org'|'user'; login: string; files: string[] /* repo-relative paths */; workflowEnvironments: Array<{ workflow: string; environment: string }>; packageScripts: Record<string,string> }`;
  - `DetectedConfig = { yaml: string; notes: string[] }`.
- `probeRepo(run: GhRunner, root: string): Promise<RepoProbe>` (read-only, uses `node:fs` directly; `RepoFs` arrives in Task 3 and is not needed here):
  - reads `gh repo view --json nameWithOwner,defaultBranchRef,owner,isInOrganization` and `gh api user --jq .login`;
  - lists files to depth 3 (skipping `.git` and `node_modules`), scans `.github/workflows/*.yml` for `environment:` with a regex, reads `package.json` scripts.
- Commands:
  - `sdlc config validate` prints `Config OK` or the zod issues, exit 1 on issues;
  - `sdlc config suggest [--write]` prints the YAML. `--write` writes `sdlc.config.yaml` only when it does not exist, otherwise exits 1 with `sdlc.config.yaml exists; edit it instead`.

- [ ] **Step 1: Write failing schema tests**
  - `mcp` defaults to `{servers:['github'], scope:'project', githubTransport:'remote'}`.
  - `mcp.servers: [nope]` → error mentioning `github, context7, playwright`.
  - `kit_ref` default equals `v` + package.json version.
  - `reconcile.closed_lookback_days: 0` → error.
- [ ] **Step 2: Write failing `detectConfig` tests**
  - **Harnesses from files:** `CLAUDE.md` → `claude`; `GEMINI.md` → `gemini`; `.codex/` or `AGENTS.md` → `codex` (with note `AGENTS.md found: choose codex or agents-md`). None → `[claude]` with note `no harness files found; defaulting to claude`.
  - **Targets:** `workflowEnvironments [{workflow:'.github/workflows/deploy-web.yml', environment:'production'}]` → `targets: [{name: web, environment: production, deploy: {via: actions, workflow: …}}]`. The name comes from the workflow file name with `deploy-` stripped, else from the environment name.
  - **Quality gate:** `packageScripts.test` → `quality_gate: ["npm test"]`.
  - **Task types:**
    - No targets → `task_types.enabled` omits `feature` and `bugfix`, and notes `no deploy targets detected; feature/bugfix disabled until you add a target`.
    - With targets → all seven built-ins enabled.
  - **Owners:** `[login]`, `agents: []`.
  - **Round trip:** the emitted YAML parses with `loadConfigFromString` without errors.
- [ ] **Step 3: Run tests, verify failures**: `npx vitest run tests/config tests/install/detect.test.ts` → FAIL.
- [ ] **Step 4: Implement** the schema fields, `loadConfigFromString(text: string): Config` (extract from `loadConfig`), `detectConfig`, `probeRepo` and the `config` command group. Register it in `cli.ts`. `config suggest` must work without an existing config: give it its own context factory with no `loadEnvironment`.
- [ ] **Step 5: Run tests**: `npm test` → PASS; `npm run typecheck` → exit 0.
- [ ] **Step 6: Commit** `feat: config mcp/kit_ref/reconcile fields, config validate and suggest`.

---

### Task 2: Template engine and template loading

**Files:**
- Create: `src/render/template.ts`, `src/render/templates.ts`, `src/render/frontMatter.ts`
- Test: `tests/render/template.test.ts`, `tests/render/frontMatter.test.ts`

**Interfaces:**
- `renderTemplate(source: string, data: Record<string, unknown>, name: string): string`, with this syntax:
  - `{{path.to.value}}` (strings and numbers; arrays are an error);
  - `{{#if path}}…{{else}}…{{/if}}` (truthy: non-empty string or array, `true`, non-zero number);
  - `{{#unless path}}…{{/unless}}`;
  - `{{#each path}}…{{/each}}`, where `{{.}}` is the item and `{{item.field}}` reads a field of the item. Inside `each`, the root data stays reachable as `{{@root.path}}`.
  - Blocks nest.
  - A missing path throws `TemplateError` `<name>: unknown value "<path>" at line <n>`. An unclosed or mismatched block throws with the line number.
  - A line that holds only a block tag is removed together with its newline, so templates stay readable without blank-line noise.
- `templatesDir(): string`: `new URL('../../templates/', import.meta.url)` resolved to a path. It works from `src/` (vitest) and `dist/`, because both sit one level below the package root next to `templates/`.
- `loadTemplate(relPath: string): string`.
- `parseFrontMatter(text: string): { data: Record<string, unknown>; body: string }` and `emitFrontMatter(data: Record<string, unknown>, body: string): string`. Key order is kept. Emitting uses the `yaml` package with `lineWidth: 0`.

- [ ] **Step 1: Write failing tests** for:
  - each construct, nesting, `@root` inside `each`, standalone-tag line removal (`"a\n{{#if x}}\nb\n{{/if}}\nc"` with `x=true` → `"a\nb\nc"`);
  - the unknown-path error message with the line number, and the unclosed-block error;
  - `{{arr}}` erroring;
  - a front matter round trip: parse → emit gives byte-identical output for a file with `name`, `description`, `model`.
- [ ] **Step 2: Run** `npx vitest run tests/render` → FAIL.
- [ ] **Step 3: Implement**: a single-pass tokenizer into a tree, then evaluation. No regex-only replacement, because nesting must work.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: template engine and front matter helpers`.

---

### Task 3: Change model, merges, manifest and the apply engine

**Files:**
- Create: `src/render/changes.ts`, `src/install/repoFs.ts`, `src/install/manifest.ts`, `src/install/merge.ts`, `src/install/apply.ts`, `tests/support/memoryFs.ts`
- Test: `tests/install/merge.test.ts`, `tests/install/apply.test.ts`

**Interfaces:**
- `Change` (discriminated union, `path` is repo-relative POSIX):
  - `{ kind: 'file'; path; content: string; mode?: 0o755 }`: whole managed file;
  - `{ kind: 'md-block'; path; content }`: body between `<!-- sdlc:begin -->` / `<!-- sdlc:end -->`;
  - `{ kind: 'line-block'; path; content; comment: '#' }`: body between `# sdlc:begin` / `# sdlc:end` (for `.gitignore`);
  - `{ kind: 'json-keys'; path; entries: Array<{ pointer: string[]; value: unknown }> }`: owned keys, for example `['mcpServers','github']`;
  - `{ kind: 'toml-block'; path; content; ownedTables: string[] }`: body between the TOML markers from Global Constraints. `ownedTables` lists the headers it defines, for example `mcp_servers.github`.
- `RepoFs`: `{ root: string; read(p): string | undefined; write(p, content, mode?): void; remove(p): void; list(dir, depth): string[] }`.
  - `nodeRepoFs(root)` refuses any path that resolves outside `root`, with error `refusing to write outside the repository: <p>`.
  - `memoryFs(files: Record<string,string>)` is the test double and records modes.
- Manifest `.sdlc/manifest.json`: `{ "version": 1, "kit": "<package version>", "entries": [ { "path", "kind", "key"?: string /* json pointer joined by "/" or toml table */, "hash": "sha256:<hex>" } ] }`.
  - `hash` is the sha256 of exactly what we wrote: the whole file, the block body, `JSON.stringify(value)` canonical with sorted keys, or the TOML table text.
  - Entries are sorted by path then key, so the file is deterministic.
- Merge functions (pure, string in → string out, throw `MergeError` on damaged markers):
  - `mergeMdBlock(existing: string | undefined, body: string): string`:
    - creates `<!-- sdlc:begin -->\n<body>\n<!-- sdlc:end -->\n` when the file is absent;
    - appends the block after one blank line when markers are absent;
    - replaces between markers when they are present;
    - throws on a begin without an end, an end before a begin, or more than one begin.
  - `removeMdBlock(existing: string): string`: removes the block and the blank line init added before it.
  - `mergeLineBlock` / `removeLineBlock` (same rules, `#` markers).
  - `mergeJsonKeys(existing: string | undefined, entries, owned: Set<string>): { text; skipped: string[] }`:
    - parses JSON (invalid JSON → `MergeError` `<path> is not valid JSON; fix or remove it`);
    - sets each pointer whose key is absent or owned; a present, un-owned key is reported in `skipped`;
    - output is `JSON.stringify(obj, null, 2) + "\n"`, keeping the existing key order and adding new keys last.
  - `removeJsonKeys(existing, pointers): string`: deletes the keys and then an `mcpServers` object left empty. A file left as `{}` is deleted by apply.
  - `mergeTomlBlock(existing: string | undefined, body: string, ownedTables: string[]): { text; skipped: string[] }`:
    - a table header `[<t>]` already present outside the block → that table's section is dropped from the body and reported in `skipped`;
    - the block is appended at the end of the file, after one blank line;
    - markers present → replace between them.
  - `removeTomlBlock`.
- Apply:
  - `planApply(changes: Change[], fs: RepoFs, manifest: Manifest | undefined, opts: { overwriteModified: boolean }): ApplyPlan`, where `ApplyPlan = { writes: PlannedWrite[]; notices: Notice[]; errors: Array<{ path; message }>; manifest: Manifest; obsolete: ManifestEntry[] }`. Per change:
    - unchanged vs manifest and disk → no write;
    - new → write;
    - managed, disk hash equals manifest hash, content differs → write (update);
    - managed, disk differs from manifest (user edit) → notice `modified locally; kept …` unless `overwriteModified`;
    - `file` kind present on disk with no manifest entry → notice `exists, not managed by sdlc; kept`;
    - JSON/TOML skipped keys → notice `<path>: <key> already defined by you; kept`.
    - `obsolete` = manifest entries no change produced any more (for example, a harness was removed).
  - `applyPlan(plan, fs, opts: { removeObsolete: boolean }): ApplyResult`:
    - performs the writes;
    - deletes obsolete entries whose disk content still matches their hash (modified ones become notices);
    - writes the manifest last.
    - An error on one file never stops the others; `ApplyResult.errors` makes the command exit 1.
  - `planUninstall(fs, manifest): ApplyPlan`: removes every manifest entry whose disk content matches its hash, keeps and notices the rest. The manifest itself is removed last. Empty directories created by us under `.claude/agents`, `.claude/skills`, `.codex/agents`, `.gemini/agents`, `.agents/skills` and `.sdlc` are removed.
- `formatPlan(plan, dryRun): string`: lines `create <path>`, `update <path>`, `remove <path>`, `keep <path> (<reason>)`, then `N changes` or `Everything is up to date`.

- [ ] **Step 1: Write failing merge tests:**
  - `preserves user content in every merge kind`: a user `CLAUDE.md` with text before and after an existing block; a `.mcp.json` with a user server `db` and a user `github`; a `config.toml` with root keys and a user `[mcp_servers.github]`. Results: user bytes identical, `github` reported as skipped, and the TOML block contains no `[mcp_servers.github]`.
  - `refuses damaged markers`: begin without end; two begins.
  - Remove functions restore the original text exactly when init created the block (round trip).
  - Invalid JSON → MergeError message.
- [ ] **Step 2: Write failing apply tests** (memoryFs):
  - create from empty;
  - second plan → zero writes and the `Everything is up to date` line;
  - `keeps locally modified managed content` (edit an agent file, re-plan: notice + no write; with `overwriteModified`: write);
  - unmanaged existing file → notice;
  - obsolete removal (drop a change, apply with `removeObsolete` → file removed; modified obsolete → kept + notice);
  - an error in one file still writes the others, and `errors.length === 1`;
  - manifest deterministic (two applies give a byte-identical manifest);
  - `nodeRepoFs` refuses `../x` (tmpdir test);
  - mode 0755 recorded for `file` with mode.
- [ ] **Step 3: Run** `npx vitest run tests/install` → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat: change model, managed merges, manifest and apply engine`.

---

### Task 4: Instruction block and skills

**Files:**
- Create: `templates/instructions/block.md`, `templates/skills/sdlc-task-tracking/SKILL.md`, `templates/skills/sdlc-delivery/SKILL.md`, `templates/skills/sdlc-orientation/SKILL.md`, `src/render/instructions.ts`
- Test: `tests/render/instructions.test.ts`, golden files `tests/golden/instructions/{claude,codex,gemini,agents-md,minimal}/…`

**Interfaces:**
- `renderData(cfg: Config): RenderData`: the one data object every template gets. Fields:
  - `cfg` (raw values), `kit: { ref, npx }` (`npx` = `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>`);
  - `enforce: boolean`, `mergeOwnerOnly: boolean`;
  - `types: Array<{ id, label, endsOn, endsOnText }>`, `targets: Array<{ name, environment, via }>`;
  - `qualityGate: string[]`, `graphify: boolean`, `superpowers: boolean`, `contentLanguage`;
  - `roles: Array<{ role, description, tier }>` (from Task 5's library; Task 4 passes `[]` until Task 5 lands, and the template guards with `{{#if roles}}`).
- `renderInstructions(cfg: Config, harness: Harness, data: RenderData): Change[]` returns:
  - the `md-block` for the harness's instruction file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). Codex and agents-md both target `AGENTS.md`: when both are selected, one block is emitted (dedupe by path in Task 10's `renderAll`);
  - a skill `file` change per skill: `.claude/skills/sdlc-<skill>/SKILL.md` for claude, `.agents/skills/sdlc-<skill>/SKILL.md` for others (deduped by path);
  - skill front matter `name: sdlc-<skill>` and `description` (required by Codex).
- Required sections of `block.md`, all in English, terse, linking to skills for detail:
  1. **What this is.** Tasks are tracked with `sdlc` on GitHub; the board must always be current.
  2. **Starting work.** A new work request → `sdlc task new` before brainstorming or diagnosis. A status question is answered without creating a task. Continuation stays in the same task.
  3. **Phases per type.** One line per enabled type: id, phases, and how it ends. Owner approvals between phases (`sdlc stage <phase> publish`, owner `/approve`).
  4. **Superpowers route.** Only `{{#if superpowers}}`: brainstorming, writing-plans, systematic-debugging, subagent-driven-development, requesting-code-review, verification-before-completion.
  5. **Review and PR rules.** Branch `task/<issue>-<slug>`, `Related to #N`, `Scope:`, `Targets:`, `sdlc review handoff`. Run the quality gate commands before handoff.
  6. **Merge and deploy authority.** The merge-policy text, and the prohibitions from Global Constraints.
  7. **Production data** (only if the `production-data` type is enabled). Backup + dry-run evidence; the owner runs the script.
  8. **Worktrees.** `.worktrees/<issue>-<slug>` from fresh `origin/<default>`. After merge, remove with `git worktree remove` (no force) and `git branch -d`.
  9. **Context survival.** Keep a running work index file beside the plan and update it after every step.
  10. **graphify** (only `{{#if graphify}}`). Query before grep, `graphify update .` after changes, `graphify-out/` is not committed.
  11. **Roles** (only `{{#if roles}}`). One line per role with its tier.
- Skills content:
  - `sdlc-task-tracking`: the CLI procedures with exact commands (`task new`, `task new --issue`, `stage … publish`, `approve`, `evidence add`, `review handoff`, `status`, `reconcile`) and the issue-readability rule (concise human summaries, never logs).
  - `sdlc-delivery`: review → merge (owner) → deploy (owner confirmation) → `deploy record` → reconcile → Done; partial PRs; cancellation.
  - `sdlc-orientation`: a template the owner fills (project purpose, architecture map, commands, gotchas), with clearly marked placeholders.

- [ ] **Step 1: Write failing tests:**
  - golden output per harness for a full config (all types, two targets, graphify + superpowers on);
  - a `minimal` config (tooling only, no graphify/superpowers): the block omits the Superpowers, graphify, production-data and Roles sections;
  - `owner_only` vs `agent_on_request` wording differs;
  - **every prohibition present:** assert the regexes `/--admin/`, `/rm -rf/`, `/worktree prune/`, `/push --force/`, `/production data/i`, `/another AI/i`, `/explicit confirmation/i`, `/Related to #/` match the block for every harness;
  - the block is under 150 lines for the full config;
  - codex + agents-md together → exactly one `AGENTS.md` change.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write templates and `renderInstructions`.** Golden files are written by running the tests with `UPDATE_GOLDEN=1`. A helper `expectGolden(dir, changes)` in `tests/support/golden.ts` compares, or writes when the env var is set. Read the golden output once and check it against the section list above before committing it.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: managed instruction block and sdlc skills`.

---

### Task 5: Role agent library

**Files:**
- Create: `templates/agents/{analyst,architect,developer,tester,reviewer,final-reviewer,security-reviewer,diagnostician,release-manager,docs-writer,scout}.md`, `src/render/agents.ts`
- Test: `tests/render/agents.test.ts`, golden `tests/golden/agents/…`

**Interfaces:**
- Role template front matter:
  - `role` (= file name), `description`, `tier: deep|standard|fast`, `can_edit: boolean`;
  - `returns` (one line: what the role reports back), `escalate_when` (one line);
  - the body is the role prompt (English, terse, ≤ 40 lines).
- Tiers:
  - `final-reviewer`, `architect` and `diagnostician` are `deep`;
  - `scout` is `fast`;
  - the rest are `standard`.
- `can_edit: false` for `architect`, `reviewer`, `final-reviewer`, `security-reviewer`, `diagnostician` and `scout`.
- Every body ends with the shared rule lines: never spawn further agents, never run another AI CLI, and report with the `returns` shape.
- `loadRoles(fs: RepoFs): RoleDef[]` reads the built-ins plus `.sdlc/agents/custom/*.md`. The same schema is validated with zod; a custom role with a built-in name overrides it and gets a notice.
- `modelFor(cfg, harness, tier): string | undefined`:
  - claude defaults `{deep:'opus', standard:'sonnet', fast:'haiku'}`; `cfg.models.claude` overrides them;
  - codex and gemini have no defaults and use only `cfg.models[harness]`, so the field is omitted when unset.
- `renderAgents(cfg, harness, roles): Change[]`:
  - **claude** → `.claude/agents/sdlc-<role>.md`. Front matter `name: sdlc-<role>`, `description`, `model`. When `can_edit` is false it adds `disallowedTools: Edit, Write, NotebookEdit`. Body = prompt.
  - **codex** → `.codex/agents/sdlc-<role>.toml`: `name = "sdlc-<role>"`, `description`, `developer_instructions = """…"""`, and `model` only when configured. Triple quotes inside a body are an error at render time.
  - **gemini** → `.gemini/agents/sdlc-<role>.md`. Front matter `name: sdlc-<role>`, `description`, plus `model` only when configured.
  - **agents-md** → no files. The roles reach the instruction block through `RenderData.roles` (Task 4).
- A TOML string writer `tomlString(value: string): string` (basic string with escapes) lives in `src/render/toml.ts` and is reused by Task 6.
- Custom roles from `.sdlc/agents/custom/` are rendered like built-ins and stay user-owned at the source. The rendered files are managed.

- [ ] **Step 1: Write failing tests:**
  - 11 built-ins load and validate;
  - golden per harness;
  - non-editing roles have `disallowedTools` on claude;
  - codex omits `model` without config and includes it with `models.codex`;
  - a custom role renders, and overriding a built-in yields a notice;
  - a role body with `"""` fails with the role named;
  - `RenderData.roles` is populated and the agents-md block now contains the Roles section (update Task 4's golden).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: role agent library rendered per harness`.

---

### Task 6: MCP servers

**Files:**
- Create: `templates/mcp/catalog.yaml`, `src/render/mcp.ts`
- Modify: `src/config/schema.ts` (wire `validateMcpIds`)
- Test: `tests/render/mcp.test.ts`

**Interfaces:**
- Catalog entry schema (zod):
  - `id`, `description`, `default: boolean`;
  - `remote?: { url, auth?: { header: 'Authorization', scheme: 'Bearer', env: string } }`;
  - `local?: { command, args: string[], env?: string[] /* names forwarded */ }`.
- v1 catalog:
  - `github`: remote `https://api.githubcopilot.com/mcp/` with auth env `GITHUB_PERSONAL_ACCESS_TOKEN`; local `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server` with env `[GITHUB_PERSONAL_ACCESS_TOKEN]`;
  - `context7`: local `npx -y @upstash/context7-mcp`;
  - `playwright`: local `npx @playwright/mcp@latest`.
- Transport choice: `github` uses `cfg.mcp.githubTransport`; others use `local` when defined, else `remote`.
- `renderMcp(cfg, harness): { changes: Change[]; userCommands: string[] }`:
  - **scope `project`:**
    - claude → `json-keys` on `.mcp.json`: `{"type":"http","url":…,"headers":{"Authorization":"Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"}}` or `{"command","args","env":{NAME:"${NAME}"}}`;
    - codex → `toml-block` on `.codex/config.toml`: `[mcp_servers.<id>]` with `url` + `bearer_token_env_var`, or `command` + `args` + `env_vars`;
    - gemini → `json-keys` on `.gemini/settings.json`: `{"httpUrl":…,"headers":{"Authorization":"Bearer $GITHUB_PERSONAL_ACCESS_TOKEN"}}` or `{"command","args","env":{NAME:"$NAME"}}`;
    - agents-md → nothing.
  - **scope `user`:** no changes; `userCommands` holds the exact commands from Harness Facts per harness and server.
- `validateMcpIds` reads the catalog.
- `mcpNotes(cfg): string[]`:
  - `export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent` when github is configured;
  - for codex, `Codex loads .codex/config.toml only for trusted projects`;
  - for claude, `approve the project MCP servers when Claude Code asks`.

- [ ] **Step 1: Write failing tests:**
  - exact JSON per harness for remote github, local github and context7;
  - codex TOML text exact, with `ownedTables`;
  - the user scope produces the exact command strings and no changes;
  - unknown id error via config;
  - **no token in output:** no rendered text contains the env var's value. Set `process.env.GITHUB_PERSONAL_ACCESS_TOKEN='ghp_secret'` in the test; output must not contain `ghp_secret`.
- [ ] **Step 2–4:** run, fail, implement, pass.
- [ ] **Step 5: Commit** `feat: MCP server catalog rendered per harness`.

---

### Task 7: Reconcile scan that scales

Lands before the Actions workflow (Task 8). It replaces the 500-issue ceiling of Plan 1's `scanTasks`.

**Files:**
- Modify: `src/github/githubTracker.ts`, `src/tracker/types.ts`, `src/engine/reconcile.ts`, `src/engine/status.ts`, `src/commands/reconcile.ts`, `src/commands/status.ts`, `tests/support/fakeTracker.ts`
- Test: `tests/github/githubTracker.test.ts`, `tests/engine/reconcile.test.ts`

**Interfaces:**
- `scanTasks(opts?: { closedSince?: string /* ISO date */ }): Promise<TaskScan>`, implemented as two queries:
  - every **open** `sdlc:task` issue, limit 2000, asserted not cut;
  - **closed** `sdlc:task` issues `updated:>=<closedSince>`, limit 1000, asserted not cut.
  - Without `closedSince`, closed issues are read with the 2000 limit and the existing cut assertion (`--all`).
- Reconcile and status pass `closedSince = today − cfg.reconcile.closedLookbackDays`, unless `--all` is given (new flag on both commands).
- An issue closed earlier and not updated since then has nothing to converge, by construction:
  - reopening it updates it;
  - a deployment never reopens Done (Plan 1 rule).
  - Document this in the code comment.

- [ ] **Step 1: Write failing tests:**
  - the gh args for the open and closed queries, including `--search "updated:>=2026-10-28"` for lookback 30 on 2026-11-27 (fake clock);
  - `--all` uses one `--state all` query;
  - FakeTracker filters closed tasks by `updatedAt` (add `updatedAt` to the fake's issues);
  - reconcile with lookback ignores an old closed done task;
  - status's untracked list respects the lookback for closed issues.
- [ ] **Step 2–4:** run, fail, implement, pass (`npm test`).
- [ ] **Step 5: Commit** `feat: reconcile scans open tasks plus recently closed ones`.

---

### Task 8: GitHub files and provisioning

**Files:**
- Create: `templates/github/pull_request_template.md`, `templates/github/sdlc-reconcile.yml`, `src/render/github.ts`, `src/install/provision.ts`
- Test: `tests/render/github.test.ts`, `tests/install/provision.test.ts`

**Interfaces:**
- `renderGithub(cfg, data): Change[]`:
  - the PR template (always). Lines `Related to #`, `Scope: final` (with an HTML comment explaining `partial`), `Targets:` (only when targets exist, listing the configured names), a `## Verification` heading, and a `## Notes` heading;
  - the workflow (only when `cfg.stack.actions`);
  - the `.gitignore` `line-block`.
- Workflow `.github/workflows/sdlc-reconcile.yml`:
  - **Triggers:**
    - `pull_request: types [closed]`;
    - `deployment_status`;
    - `release: types [published]`;
    - `issue_comment: types [created]`;
    - `issues: types [closed, reopened]`;
    - `schedule: cron '17 * * * *'`;
    - `workflow_dispatch`.
  - **Job:**
    - `concurrency: { group: sdlc-reconcile, cancel-in-progress: false }`;
    - `if:` skips an `issue_comment` whose body does not start with `/`;
    - `permissions: contents: read`;
    - steps: `actions/checkout@v4` (default depth), `actions/setup-node@v4` with `node-version: 20`, then `run: npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<kitRef> reconcile`;
    - env `GH_TOKEN: ${{ secrets.SDLC_TOKEN }}`;
    - a first step fails with `::error::` text `Add the SDLC_TOKEN secret (a token with repo and project scopes); see INSTALL.md` when the secret is empty.
  - The file is valid YAML (test parses it).
- `ensureLabels(run, cfg, { dryRun }): Promise<{ created: string[]; existing: string[] }>`:
  - labels `sdlc:task`, `sdlc:partial`, and `type:<id>` for every enabled type;
  - list via `gh label list --json name --limit 500`, create via `gh label create <name> --color <hex> --description <text>`;
  - add-only, never edits existing labels.
- `ensureBranchProtection(run, cfg, { dryRun }): Promise<{ status: 'created'|'exists'|'skipped'|'unavailable'; message }>`, only when `cfg.stack.branch_protection`:
  - reads `repos/<repo>/branches/<default>/protection`. 404 "Branch not protected" → PUT a minimal protection: `required_pull_request_reviews: { required_approving_review_count: 0 }`, `enforce_admins: false`, `required_status_checks: null`, `restrictions: null`, `allow_force_pushes: false`, `allow_deletions: false`.
  - Existing protection → `exists`, never modified.
  - 403 with "Upgrade to GitHub Pro" or a similar plan message → `unavailable` with the message, not an error.
- `setHooksPath(git: GitRunner, { dryRun }): Promise<'set'|'already'|'conflict'>`, where `GitRunner = (args: string[]) => Promise<{ stdout; code; stderr }>`:
  - `git config --get core.hooksPath`; an unset value → set `.sdlc/githooks`; equal → `already`;
  - another value → `conflict`. The notice says hooks are not active and names both paths, and nothing is overwritten.
  - `defaultGitRunner` is in `src/install/provision.ts`.

- [ ] **Step 1: Write failing tests:**
  - PR template golden with and without targets;
  - workflow golden, parsed with `yaml` (assert `on` keys, the job `if`, and that `kitRef` appears in the run line);
  - no workflow when `stack.actions: false`;
  - `ensureLabels` creates only missing labels, with exact gh args (fakeGh);
  - branch protection paths: not protected → PUT body exact; protected → `exists`; 403 plan message → `unavailable`; dry run → no PUT;
  - `setHooksPath` for all three cases.
- [ ] **Step 2–4:** run, fail, implement, pass.
- [ ] **Step 5: Commit** `feat: PR template, reconcile workflow and GitHub provisioning`.

---

### Task 9: Git hooks

**Files:**
- Create: `templates/githooks/hook.sh`, `src/commands/githook.ts`
- Modify: `src/render/github.ts` (hook changes), `src/cli.ts`
- Test: `tests/commands/githook.test.ts`, `tests/render/githooks.test.ts`

**Interfaces:**
- `renderGitHooks(): Change[]` creates four `file` changes with mode 0755 at `.sdlc/githooks/<name>` for `pre-commit`, `pre-push`, `post-merge` and `post-checkout`. Script body:
  - `#!/bin/sh`;
  - run `sdlc githook <name> "$@"` when `command -v sdlc` succeeds, else `npx --no-install sdlc githook <name> "$@"` when that resolves;
  - otherwise print `sdlc not found; agentic-sdlc-kit git hook <name> skipped (install: see INSTALL.md)` to stderr and exit 0;
  - `pre-push` passes stdin through.
- `sdlc githook <name> [args…]`. Decisions are pure functions in `src/commands/githook.ts`; IO is injected.
  - **pre-commit** (`decidePreCommit(branch, cfg)`):
    - on `cfg.github.defaultBranch`: observe → warn `committing directly to <branch>; work on a task branch (task/<issue>-<slug>)` and exit 0; enforce → same text as error, exit 1;
    - detached HEAD or other branches → exit 0 silently.
  - **pre-push** (`decidePrePush(lines, cfg, lookup)`):
    - reads stdin lines `<local ref> <local sha> <remote ref> <remote sha>`;
    - remote ref `refs/heads/<default>` → warn/block as above;
    - `refs/heads/task/<n>-…` → `lookup(n)` (tracker `getTask`, which must be tracked) → unknown → warn/block `branch task/<n>-… has no tracked task #<n>; run sdlc task new or sdlc task new --issue <n>`;
    - a lookup failure (offline) → warn `could not verify task #<n> (<reason>); push allowed` and exit 0 in both modes;
    - deleting a branch (local sha all zeros) → ignored.
  - **post-merge** (`runPostMerge`): when on the default branch, spawn `sdlc reconcile` detached with stdout/stderr appended to `.sdlc/cache/reconcile.log`, and print `sdlc: reconcile started in the background (log: .sdlc/cache/reconcile.log)`. Always exit 0.
  - **post-checkout**:
    - args `<prev> <new> <flag>`, flag `1` = branch checkout;
    - when the new branch is `task/<n>-…`, print one line `task #<n>: <status> · <phase> · next: <next step>` from the tracker;
    - failures print nothing; always exit 0.
- The hook command never needs the full context when it exits early. Config load errors print a warning and exit 0, so hooks never block over a config problem.

- [ ] **Step 1: Write failing tests:**
  - every decision function in observe and enforce (default branch commit; push to default; push of a task branch tracked, untracked, lookup error; branch deletion);
  - post-checkout output line;
  - post-merge spawns with the log path (inject a spawner);
  - config error → exit 0 with a warning;
  - the script golden;
  - the script runs under `/bin/sh -n` without syntax errors (`execFileSync('sh', ['-n', path])` on a tmp file).
- [ ] **Step 2–4:** run, fail, implement, pass.
- [ ] **Step 5: Commit** `feat: git hooks and the sdlc githook command`.

---

### Task 10: `init`, `upgrade`, `uninstall`

**Files:**
- Create: `src/render/plan.ts`, `src/commands/init.ts`, `src/commands/upgrade.ts`, `src/commands/uninstall.ts`
- Modify: `src/cli.ts`, `README.md` (command list)
- Test: `tests/commands/install.test.ts`

**Interfaces:**
- `renderAll(cfg: Config, fs: RepoFs): { changes: Change[]; userCommands: string[]; notes: string[] }`:
  - concatenates `renderInstructions` per harness, `renderAgents`, `renderMcp`, `renderGithub` and `renderGitHooks`;
  - dedupes `file`/`md-block` changes by path (identical content required, else throws, a programming error);
  - merges `json-keys` and `toml-block` changes for the same path into one;
  - sorts by path.
- `sdlc init [--config <path>] [--dry-run] [--overwrite-modified] [--skip-github] [--json]`. Steps in order, each reported:
  1. Validate config (Plan 1 `loadConfig` + MCP ids).
  2. `planApply` → print → apply unless dry run.
  3. `setHooksPath`.
  4. Unless `--skip-github`:
     - `ensureBoard` (Plan 1). A newly created project number is printed with the instruction to set `github.project.number`; init never edits the config;
     - `ensureLabels`;
     - `ensureBranchProtection`.
  5. Print `userCommands`, `notes`, and the next steps:
     - `commit the changes on a branch and open the install PR "chore: install agentic-sdlc-kit"`;
     - `run sdlc doctor`;
     - with actions on, `add the SDLC_TOKEN secret: gh secret set SDLC_TOKEN`.

  Init commits nothing. Exit 1 if any step failed; later steps still run when a file write failed, but not when config validation failed.
- `sdlc upgrade [--dry-run] [--overwrite-modified] [--json]`: steps 1, 2 (with `removeObsolete: true`) and 3. It never touches GitHub. It reports `kit <old> → <new>` from the manifest.
- `sdlc uninstall [--dry-run] [--json]`:
  - `planUninstall` → apply;
  - unset `core.hooksPath` only if it equals `.sdlc/githooks`;
  - print what was kept;
  - never touches GitHub (board, labels and issues remain). The message says so.
- JSON output for all three: `{ steps: Array<{ name, status: 'ok'|'skipped'|'failed', details }>, plan: { writes, notices, errors } }`.

- [ ] **Step 1: Write failing tests** (memoryFs + fakeGh + fake git):
  - `init into an empty repository`: the exact list of created paths for a claude+codex config with actions on;
  - `second init is a no-op`;
  - `init into a customized repository` (Review Focus 1);
  - `--dry-run` writes nothing and runs no gh mutation (fakeGh asserts only read calls);
  - `--skip-github` makes no gh calls;
  - **upgrade:** a template change (simulate by changing `cfg.mcp.servers`) → update and remove; a modified file is kept;
  - `uninstall leaves user content` (Review Focus 4): after uninstall, the repository equals the pre-init fixture byte for byte except user edits made in between;
  - a failed write → exit code 1 with other steps still reported.
- [ ] **Step 2–4:** run, fail, implement, pass.
- [ ] **Step 5: Commit** `feat: sdlc init, upgrade and uninstall`.

---

### Task 11: `sdlc doctor`

**Files:**
- Create: `src/install/doctor.ts`, `src/commands/doctor.ts`
- Modify: `src/cli.ts`
- Test: `tests/install/doctor.test.ts`

**Interfaces:**
- `Check = { id: string; status: 'ok'|'warn'|'fail'; message: string; fix?: string }`.
- `runPreflight(env: DoctorEnv): Promise<Check[]>`. It works without a config. Checks:
  - `git.repo` (inside a git work tree);
  - `node.version` (≥ 20);
  - `gh.installed`;
  - `gh.auth` (`gh auth status`);
  - `gh.scopes` (needs `repo` and `project`; `workflow` is a warn when actions will be used. Parse `Token scopes:` from `gh auth status` stderr/stdout);
  - `repo.remote` (`gh repo view --json nameWithOwner,defaultBranchRef` succeeds and is reported);
  - `repo.instructionFiles` (lists existing `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, info as ok);
  - `config.present` (warn if absent: `run sdlc config suggest`).
- `runDoctor(env: DoctorEnv, cfg: Config): Promise<Check[]>`: the preflight checks plus:
  - `config.valid`;
  - `manifest.present`;
  - `files.managed`: every manifest entry present and matching its hash. Modified entries are a warn naming them; missing ones are a fail;
  - `git.hooksPath` (= `.sdlc/githooks`, else fail with fix `sdlc init`);
  - `sdlc.onPath` (warn if `sdlc` is not resolvable: git hooks skip);
  - `board.fields` (Plan 1 `ensureBoard` in dry-run mode: planned changes → fail with fix `sdlc board ensure`);
  - `labels` (missing → fail, fix `sdlc init`);
  - `actions.workflow` + `actions.secret` (`gh secret list --json name` contains `SDLC_TOKEN`, else fail with fix `gh secret set SDLC_TOKEN`), only with `stack.actions`;
  - `mcp.token` (`GITHUB_PERSONAL_ACCESS_TOKEN` set in the environment when github is configured, else warn);
  - `mcp.claude` (when claude is selected and `claude` is on PATH: `claude mcp list` output lists every configured id. A missing id → warn with fix `approve the server in Claude Code or run the printed claude mcp add command`. `claude` absent → ok `claude CLI not found; skipped`);
  - `approvals.trust`: mode enforce, `stack.actions` and `agents` empty → warn `comment approvals from the Actions token's login are ignored in enforce mode; run agents under a separate account listed in agents (see INSTALL.md)`.
- `DoctorEnv = { run: GhRunner; git: GitRunner; fs: RepoFs; which(cmd): Promise<boolean>; exec(cmd, args): Promise<{stdout; code; stderr}>; env: NodeJS.ProcessEnv; nodeVersion: string }`. This is all IO, injected.
- `sdlc doctor [--preflight] [--json]`:
  - human output: `✓`/`!`/`✗` + message (+ `  fix: …`);
  - exit 1 when any check is `fail`.

- [ ] **Step 1: Write failing tests:** every check's ok/warn/fail path with a fake env. Include:
  - the `gh auth status` scopes parsing, using the real-format sample `  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'`;
  - preflight with no config;
  - exit code mapping;
  - JSON shape.
- [ ] **Step 2–4:** run, fail, implement, pass.
- [ ] **Step 5: Commit** `feat: sdlc doctor with preflight and install checks`.

---

### Task 12: INSTALL.md, README and the install smoke

**Files:**
- Create: `INSTALL.md`
- Modify: `README.md`, `tests/docs/readme.test.ts`
- Create: `docs/notes/plan-2-smoke.md` (written by the controller after the smoke)

**Interfaces:**
- `INSTALL.md` is the procedure the installing agent follows, step by step, matching spec §6:
  1. Preflight: `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> doctor --preflight`, then fix fails with the owner.
  2. `config suggest`, then ask the install questions one topic at a time. Use the §6 list: harnesses, board, mode, task types, targets, quality gate, merge policy, MCP servers and scope, models, stack, owners and agents, content language. Each question proposes the detected default.
  3. Write `sdlc.config.yaml`, show it, and get the owner's OK.
  4. `init --dry-run`, show the plan, then `init`.
  5. Commit on branch `task/<n>-install-agentic-sdlc-kit`, open the PR `chore: install agentic-sdlc-kit`, and track it as the first `tooling` task.
  6. `doctor`.
  7. Owner-only steps:
     - `gh secret set SDLC_TOKEN`;
     - export `GITHUB_PERSONAL_ACCESS_TOKEN`;
     - approve the MCP servers; trust the project in Codex;
     - run the printed user-scope commands.
- The INSTALL.md section "Owner, agents and tokens" explains:
  - why agents should write under a separate account listed in `agents`;
  - what happens in enforce mode when they do not;
  - which token the workflow should use.
- README:
  - the bootstrap prompt in a code block, exactly: `Install agentic-sdlc-kit from https://github.com/SobSoft-s-r-o/agentic-sdlc-kit into this repository. Follow its INSTALL.md.`;
  - a 2-minute walkthrough;
  - the command list including `init`, `upgrade`, `uninstall`, `doctor`, `config`, `githook`;
  - the status line updated to "core CLI and installer available; harness hooks next".

- [ ] **Step 1: Extend the docs test:**
  - README contains the exact bootstrap prompt;
  - every `sdlc <command>` mentioned in README and INSTALL.md exists in `buildProgram()`;
  - INSTALL.md mentions every §6 question topic;
  - (no private-project names in tests either: the controller scans the branch for them before any push).
- [ ] **Step 2: Run** → FAIL. **Step 3: Write the docs.** **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` → all pass.
- [ ] **Step 5: Commit** `docs: INSTALL.md and README for the installer`.
- [ ] **Step 6 (controller, sandbox smoke):** in a throwaway user-owned repository plus a new board, deleted afterwards after a title check (never project #1):
  - run `node dist/cli.js` through `doctor --preflight` → `config suggest --write` → `init --dry-run` → `init` → second `init` (no-op) → `doctor` → `uninstall`;
  - record results and findings in `docs/notes/plan-2-smoke.md`;
  - commit `docs: plan 2 sandbox smoke`.
