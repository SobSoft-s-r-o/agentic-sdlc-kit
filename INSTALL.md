# Installing agentic-sdlc-kit

This is the procedure an AI agent follows to install the kit into a repository, with the repository's owner in the chat. You are the agent; "the owner" is the person you ask.

Rules for the whole install:

- Ask the install questions one topic at a time, each with the default you detected, and wait for the answer. Do not batch them.
- The installer never commits, pushes or writes outside the repository. You commit; the owner runs the steps in Step 7.
- No secret goes into a file, a commit, a chat message or a log. Never ask the owner to paste a token to you.
- `kit_ref` is the kit version to install, and it decides the form of every command. A release tag from `v0.3.0` on is run from the npm registry: `npx -y agentic-sdlc-kit@<version>`, where `<version>` is the tag without its `v` (`0.3.0`). `main`, another branch or a commit is run from git: `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>`. `v0.1.0` and `v0.2.0` were never published to npm, so a config pinned to either must switch to `v0.3.0` or later (or to `main`). The commands in this document are written in the release form; for `main` or a commit, write the `github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>` form in its place.
- How to run `sdlc`: until it is installed (Step 4), as `npx -y agentic-sdlc-kit@<version> <command>`. After the project dependency of Step 4, as `npx --no-install sdlc <command>`: a dev dependency lives in `node_modules/.bin`, which is not on the PATH, so plain `sdlc` works only after a global install. Elsewhere in this document `sdlc <command>` in running text means whichever form applies.

## Step 1: Preflight

```sh
npx -y agentic-sdlc-kit@<version> doctor --preflight
```

It checks git, Node 20 or newer, `gh` (installed, logged in, token scopes `repo` and `project`, and `workflow` because the reconcile workflow is pushed), the repository `gh` sees, which instruction files exist, and whether `sdlc.config.yaml` exists yet. Read every line. Fix each failure with the owner before going on:

| Failure | Fix |
|---|---|
| not a git work tree | run from the repository, or `git init` |
| Node older than 20 | install Node.js 20 or newer |
| `gh` missing or logged out | install the GitHub CLI, then `gh auth login` |
| missing scope | `gh auth refresh -s repo -s project -s workflow` |
| no GitHub remote | add one, or `gh repo create` |

A fine-grained token has no scopes `gh` can list: the preflight then warns and you ask the owner to confirm the token can use repositories and Projects.

## Step 2: Detect, then ask

```sh
npx -y agentic-sdlc-kit@<version> config suggest
```

This prints a `sdlc.config.yaml` detected from the repository (YAML on stdout, notes on stderr; `--write` creates the file only when it does not exist). It writes `version`, `harnesses`, `mode`, `kit_ref`, `github`, `owners`, `agents`, `merge_policy`, `quality_gate`, `task_types` and `targets`. The other keys keep their defaults until you add them: `content_language`, `models`, `stack`, `mcp`, `secrets` and `reconcile`. The suggested `kit_ref` is `v` plus the kit's version, with a comment: a release is only usable once it is published on npm (`v0.3.0` and later), so when the suggestion is older, or the release is not out yet, set it to `v0.3.0` or later, `main`, or the ref you installed from.

Now ask the questions below in order, one at a time. For each, state the detected default and the key it sets, and keep the owner's answer for Step 3.

### The questions

#### 1. Harnesses

Which agents work in this repository? Key `harnesses`, any of `claude`, `codex`, `gemini`, `agents-md` (any other agent that reads `AGENTS.md`). Detected from `CLAUDE.md`, `.codex/`, `AGENTS.md` and `GEMINI.md`; with none of them the suggestion is `claude`. If `AGENTS.md` exists, ask whether it belongs to Codex (`codex`) or to some other agent (`agents-md`).

#### 2. Board

Use an existing GitHub Project or create one? Key `github.project`: `owner` (the login that owns it), `owner_type` (`org` or `user`) and `number`. For an existing project list them (`gh project list --owner <owner>`) and set `number`. `config suggest` never sets `number`. Leave it out to have `init` create a board titled `<repo> SDLC tasks`; `init` then prints the number and you add it to the config (Step 4).

#### 3. Enforcement mode

Key `mode`: `observe` (default) records gaps and warns; `enforce` blocks. In `enforce` the git hooks refuse commits to the default branch, pushes to it, and pushes of a `task/<n>-...` branch whose task is not tracked; the harness hooks refuse file edits before the plan is approved, subagents without a role and model tier, `gh pr merge --admin` and merges through `gh api`, other AI CLIs and `sdlc config set` (see "Harness hooks and trust"); and owner approvals need the account setup in "Owner, agents and tokens". The secret guard blocks in both modes. The harness hooks read the mode from the main checkout's `sdlc.config.yaml` (see Step 7, item 9), so a change there reaches every task worktree at once. The owner can change the mode later with `sdlc config set mode enforce` (Step 7), so `observe` is a safe first answer.

#### 4. Task types

Key `task_types.enabled`; built-in ids are `feature`, `bugfix`, `tooling`, `analysis`, `production-data`, `artifact`, `spike`. Keep `tooling`: the install PR is a `tooling` task. `feature` and `bugfix` end on a deploy and need at least one target, so they are off when no target was detected. Custom types go under `task_types.custom`; see [the design, Task types](https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/blob/main/docs/superpowers/specs/2026-11-27-agentic-sdlc-design.md#7-task-types).

#### 5. Deploy targets

Only when a type that ends on a deploy is enabled. Key `targets`, for each: `name` (kebab-case), `environment` (the GitHub environment; default `production` for one target, `production-<name>` for several; each must be unique), `deploy.via` and optionally `paths` (globs that suggest which targets a PR touches).

- `deploy.via: script` with `command`;
- `deploy.via: actions` with `workflow` (detected from workflows that name an `environment:`);
- `deploy.via: manual`;
- `deploy.via: release` (a GitHub Release).

#### 6. Quality gate

Commands the agent runs before handing over for review. Key `quality_gate`, a list such as `["npm test"]`; detected from the `test` script in `package.json`, empty when there is none.

#### 7. Merge policy

Key `merge_policy`: `owner_only` (default) or `agent_on_request` (the agent may merge after review and a green gate, only when the owner explicitly asks in that turn).

#### 8. MCP servers and scope

Keys `mcp.servers` (catalog ids: `github` is the default; optional `context7` for library docs and `playwright` for browser checks), `mcp.scope` and `mcp.github_transport`. Ask which servers, then ask once whether they are configured for the project or for the owner's user account: there is one `mcp.scope` for all of them.

- `mcp.scope: project` (default): `init` writes `.mcp.json` (Claude Code), `.codex/config.toml` (Codex) and `.gemini/settings.json` (Gemini CLI).
- `mcp.scope: user`: `init` writes nothing and prints one command per server for the owner to run (Step 7). It never touches `~/.claude.json`, `~/.codex` or `~/.gemini`.
- `mcp.github_transport`: `remote` (default, GitHub's hosted server) or `local` (a Docker container).

The GitHub server reads its token from the environment variable `GITHUB_PERSONAL_ACCESS_TOKEN`; the files only name the variable. See "MCP servers" below.

#### 9. Secrets storage

Two keys, ask both. `secrets.local_store` is where local test secrets live: `auto` (default: macOS Keychain, Linux Secret Service, or Windows Credential Manager, by operating system), `keychain`, `secret-service`, `wincred`, or the name of a password-manager command line such as `op`. `secrets.production_store` is free text naming where production secrets live, shown in the agents' rules (default `GitHub Actions environment secrets`; for example `GCP Secret Manager`). The commit guard is always on. The commands per store are in "Secrets" below.

#### 10. Models

Key `models.<harness>`, each `{ deep, standard, fast }`. Claude defaults to `opus`, `sonnet`, `haiku`. Codex and Gemini have no default: their agent files leave `model` out and the harness picks its own, so only set them when the owner wants to pin a model, using names the harness accepts today.

#### 11. Stack

Keys `stack.superpowers`, `stack.graphify`, `stack.branch_protection` and `stack.actions`, all default `true`.

- `stack.superpowers`: adds the Superpowers skill route to the instructions. The kit does not install the plugin; the owner does, per harness (Step 7):
  - Claude Code: `/plugin install superpowers@claude-plugins-official` inside Claude Code, or `claude plugin install superpowers@claude-plugins-official` from a shell.
  - Gemini CLI: `gemini extensions install https://github.com/obra/superpowers --consent` (from the Superpowers README; not run by the kit).
  - Codex: open `/plugins` in the Codex terminal UI and install Superpowers from its plugin marketplace. `codex plugin add superpowers@openai-curated` is the command `init` prints, but the kit has not verified it against a real Codex, so trust the `/plugins` route if the command fails.
  - Other harnesses: see https://github.com/obra/superpowers.

  `init` prints the commands for the configured harnesses as `run yourself:` lines, and `doctor` (`stack.superpowers`) checks that the plugin is listed.
- `stack.graphify`: adds the graphify rules and `graphify-out/` to `.gitignore`. The kit does not install graphify either: `uv tool install graphifyy` (or `pipx install graphifyy`; the package name has two `y`), then register its skill for each harness: `graphify install` for Claude Code, `graphify install --platform codex` for Codex, `graphify install --platform gemini` for Gemini CLI (`init` prints the ones that apply). Build the graph once as its documentation says. `doctor` (`stack.graphify`) checks that `graphify --version` runs.
- `stack.branch_protection`: `init` protects the default branch (pull request required, no force pushes or deletions).
- `stack.actions`: renders `.github/workflows/sdlc-reconcile.yml`, which needs the `SDLC_TOKEN` secret. Without it the board updates only from local commands and hooks.

#### 12. Owners and agents

`owners`: GitHub logins whose `/approve`, `/accept`, `/ran` and `/cancel` comments count (default: the login `gh` runs as). `agents`: logins the agents write as, if the owner uses a separate account. Read "Owner, agents and tokens" before asking.

#### 13. Language of task content

Key `content_language`, default `en`: the language agents write issues, pull requests and comments in. The instruction files themselves stay English.

## Step 3: Write the config and get the owner's OK

Write `sdlc.config.yaml` from the answers (edit the suggestion, or write it fresh), then:

```sh
npx -y agentic-sdlc-kit@<version> config validate
```

Set `kit_ref` to the version you installed from: the generated instructions and the reconcile workflow run `npx -y agentic-sdlc-kit@<version>` for a release tag (`v0.3.0` and later, with `<version>` the tag without its `v`) and `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<kit_ref>` for `main`, another branch or a commit. The default is `v` plus the installed version, which for a release must be published on npm. `doctor` checks that (`kit.ref`: `npm view agentic-sdlc-kit@<version>` for a release tag, `git ls-remote` for a branch, nothing for a commit). A config pinned to `v0.1.0` or `v0.2.0` fails the check, because those versions never reached npm: set `v0.3.0` or later, or `main`. Show the file to the owner and wait for a yes. A complete example:

```yaml
version: 1
harnesses: [claude, codex]
mode: observe                 # observe | enforce
kit_ref: v0.3.0               # the ref you installed from
github:
  repo: owner/name
  default_branch: main
  project: { owner: owner, owner_type: org }   # add number: N once the board exists
owners: [owner-login]
agents: [agent-account-login]
content_language: en
merge_policy: owner_only      # owner_only | agent_on_request
quality_gate: ["npm test"]
task_types:
  enabled: [feature, bugfix, tooling, analysis, production-data, artifact, spike]
targets:
  - name: web
    environment: production
    deploy: { via: actions, workflow: .github/workflows/deploy-web.yml }
    paths: ["apps/web/**"]
models:
  claude: { deep: opus, standard: sonnet, fast: haiku }
stack: { superpowers: true, graphify: true, branch_protection: true, actions: true }
mcp:
  servers: [github]
  scope: project              # project | user
  github_transport: remote    # remote | local
secrets:
  local_store: auto           # auto | keychain | secret-service | wincred | <password manager CLI>
  production_store: "GitHub Actions environment secrets"
  allow: []                   # fingerprints of accepted secret-guard findings
```

## Step 4: Install

```sh
npx -y agentic-sdlc-kit@<version> init --dry-run
```

Show the plan to the owner, then run `init` without `--dry-run`. It writes the managed files (instruction blocks, agent roles, skills, MCP config, the PR template, the reconcile workflow, `.sdlc/manifest.json`, the git hooks and `.gitignore` lines), sets `core.hooksPath` to `.sdlc/githooks` (the hooks `pre-commit` and `pre-push`, which run the secret guard and the branch rules, then `post-merge` and `post-checkout`), and provisions the board, labels, default-branch protection and secret scanning push protection. It commits nothing. `init` is idempotent: run it again and nothing changes.

`init` also writes the harness hooks: the launcher `.sdlc/hooks/run.sh` (executable) and, for each configured harness, `.claude/settings.json`, `.codex/hooks.json` or `.gemini/settings.json` with a hook for session start, prompt and pre-tool. It adds `.worktrees/` and `.sdlc/cache/` to the managed `.gitignore` block. **Commit `.sdlc/hooks/run.sh`** (Step 5). The settings files run `"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" <harness> <event>`, so a worktree or a clone that does not have the launcher committed runs no hooks: the command exits 127 and the harness carries on, fail open. Codex and Gemini also need the owner's trust before they run the hooks (see "Harness hooks and trust").

- Hooks the repository already has in `.git/hooks` (a hand-written hook, the pre-commit framework, lefthook) keep running: with `core.hooksPath` set git no longer calls them itself, so each kit hook runs the one of the same name after its own step, with the same arguments and input, and its exit code counts. `init` lists the hooks it chains, and the ones it cannot run because they are not executable (`chmod +x` them). `doctor` reports them as `git.legacyHooks`.

- Files that already exist and are not the kit's are kept (notice `exists, not managed by sdlc; kept`); files you or the owner edited are kept (notice `modified locally; kept`); `--overwrite-modified` replaces them.
- If `init` created a board, it printed `Created project #N`. Put `number: N` under `github.project` in `sdlc.config.yaml` now: `sdlc task new` and `doctor` need it, and without it every `init` creates another board.
- `--skip-github` leaves GitHub alone (no board, labels, branch protection or push protection). Use it only when the owner provisions the board and the labels themselves, because Step 5 needs both before it can create the task. An account that is not an admin does not need it: `init` reports the admin-only parts as unavailable and goes on.

Then make `sdlc` resolvable, because the git hooks call it and, when they cannot find it, the secret guard does not run (see "Secret guard"; until then `doctor` fails `secrets.guard`). Tell the owner first: this adds a dev dependency to `package.json` and the lockfile, and the PR body of Step 5 must list it. Use the repository's own package manager:

```sh
npm install --save-dev agentic-sdlc-kit@<version>   # pnpm add -D ...  /  yarn add -D ...  with the same specifier
```

For `main` or a commit the specifier is `github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>`. A release from npm ships its built files and needs no approval. A git dependency builds itself from git in its `prepare` script, and recent pnpm versions run that build only when it is approved; without it the install has no working `sdlc`. The simple path is npm, with a release from the registry, or a global install. With pnpm and a git dependency:

- pnpm 10.26 to 10.x: allow it in `pnpm-workspace.yaml` before `pnpm add -D`:

  ```yaml
  onlyBuiltDependencies:
    - agentic-sdlc-kit
  ```

- pnpm 11 and newer: `onlyBuiltDependencies` is gone; builds are approved in the `allowBuilds:` map of `pnpm-workspace.yaml`. A bare package name never approves a git dependency: the key is the package name, `@`, and the repository URL without `#<ref>`, and it must match exactly. The easiest way to get the exact key is `pnpm approve-builds`, or the placeholder entry pnpm writes into `pnpm-workspace.yaml` when an install blocks the build; set it to `true`. See https://pnpm.io/settings/build.

The hooks then find `sdlc` through `npx --no-install sdlc`, and from here on you run `npx --no-install sdlc <command>`. A repository without a `package.json`, or one that uses Yarn Plug'n'Play (no `node_modules/.bin`), needs a global install instead: `npm install --global agentic-sdlc-kit@<version>` (the `github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>` form for `main` or a commit), after which plain `sdlc <command>` works. A global install protects only that machine: tell the owner that every other clone and every other contributor needs the same install, or the guard is not active there.

**Every clone.** `core.hooksPath` is local git config: it is not committed or cloned. Every collaborator, every new clone and every cloud agent sandbox runs, once, from the repository root:

```sh
git config core.hooksPath || git config core.hooksPath .sdlc/githooks   # sets it only when it is unset
```

then the repository's package manager install, as in Step 4 (`npm install`, `pnpm install` or `yarn install`), so the hooks find `sdlc` through the dev dependency (or use the global install above). If `git config core.hooksPath` prints something else (husky or another hook manager), do not change it: that tool owns the hooks, and the kit's hooks do not run until the owner decides (call the scripts in `.sdlc/githooks` from that tool's hooks, or switch).

Put this in the README or CONTRIBUTING file of the repository. With npm you can make it automatic with a `prepare` script in `package.json`, which npm runs after every `npm install`: `"prepare": "git config core.hooksPath || git config core.hooksPath .sdlc/githooks || exit 0"` (merge it with an existing `prepare` script). It leaves a value that is already set alone, and `|| exit 0` keeps the install working outside a git checkout. The generated instructions also tell agents to check `git config core.hooksPath`: set it when it is unset, tell the owner when it points elsewhere.

## Step 5: Commit, open the PR, track it

The install is the first task, type `tooling`. Create it before the branch, because the branch name carries its number:

```sh
npx --no-install sdlc task new --type tooling --title "Install agentic-sdlc-kit" --summary "Install agentic-sdlc-kit"
```

It prints `Created #<n>: <url>`. Then:

```sh
git switch -c task/<n>-install-agentic-sdlc-kit
git add sdlc.config.yaml .sdlc .github .gitignore   # .sdlc includes .sdlc/hooks/run.sh; add the instruction files, agent folders, the hook settings (.claude/settings.json, .codex/hooks.json, .gemini/settings.json), MCP files, package.json and the lockfile that init and npm changed
git ls-files -s .sdlc/hooks/run.sh   # must start with 100755: the launcher has to be committed and executable
git commit -m "chore: install agentic-sdlc-kit"
git push -u origin task/<n>-install-agentic-sdlc-kit
gh pr create --title "chore: install agentic-sdlc-kit" --body-file <body>
```

The PR body says `Related to #<n>` (never `Fixes` or `Closes`) and `Scope: final`, and lists what the install added, including the dev dependency of Step 4 and the harness hooks. Then hand it over: `npx --no-install sdlc review handoff <n> --pr <pr-number>`. The owner reviews and merges.

If the commit is blocked, the secret guard found something: see "Secret guard". Never use `--no-verify`.

## Step 6: Verify

```sh
npx --no-install sdlc doctor
```

Each line starts with `✓` (ok), `!` (warning) or `✗` (failure), and a failure exits non-zero. Until the owner finishes Step 7, expect `actions.secret` to fail (`SDLC_TOKEN` is not set) and `mcp.token` to warn (the variable is not exported); `secrets.pushProtection` may warn (no admin rights, or the plan has none) and `mcp.claude` may warn until the owner approves or adds the server. A failing `secrets.guard` means `sdlc` is not installed yet (Step 4): an `npm error npx canceled due to missing packages` from `npx --no-install sdlc` means the same, Step 4 was skipped. `doctor` run through `npx -y` reports this correctly too: it ignores the temporary package npx put on its own PATH. `kit.ref` fails when a release `kit_ref` is not published on npm, warns when a branch does not exist in the kit's repository, and warns when it cannot be checked (no network). The hook checks warn until things are done that only a person can do: `hooks.<harness>` warns while the launcher is not committed (Step 5), `stack.superpowers` and `stack.graphify` warn until the owner installs them (Step 7), and `mcp.<harness>` can warn until the project is trusted. `hooks.roundtrip` runs the hook code on a command it must refuse and fails when it does not answer as it should; it touches neither GitHub nor your logs. Report anything else to the owner instead of hiding it. The checks and their fixes are in "Troubleshooting".

Doctor cannot tell whether a harness actually runs the hooks. Check that once, in `enforce` mode, from inside the harness: start it in the repository, ask it to run `npx --no-install sdlc config set mode observe --dry-run`, and see it refused with a message that names the rule (`mode-change`). If it prints the dry-run plan instead, the hooks are not running (see "Harness hooks and trust"). The command is safe either way: with `--dry-run` it writes nothing.

## Step 7: Owner-only steps

Give the owner this list; do not do these yourself and do not ask for any value.

1. `gh secret set SDLC_TOKEN` (when `stack.actions` is on): the token the reconcile workflow uses, see "Owner, agents and tokens". `gh` prompts for the value.
2. Create the GitHub token for the MCP server, store it in the OS keystore and export `GITHUB_PERSONAL_ACCESS_TOKEN` from it in the shell profile, with the commands for the chosen `secrets.local_store` in "Secrets". Never in a file in the repository, never pasted into the chat.
3. Approve the project's MCP servers when Claude Code asks, and trust the project in Codex (it loads `.codex/config.toml` only for trusted projects).
4. Run the user-scope commands `init` printed (`mcp.scope: user`), then check them as described in "MCP servers".
5. Turn on secret scanning push protection if `doctor` warns that it is off (repository settings, Code security).
6. Install the Superpowers plugin for each harness if `stack.superpowers` is on, and graphify if `stack.graphify` is on (commands under question 11, including Codex's `/plugins` route).
7. Trust the project in each harness so that it runs the hooks: Claude Code's workspace trust dialog, Codex's project trust and the `/hooks` review, Gemini CLI's folder trust (see "Harness hooks and trust"). Make sure `.sdlc/hooks/run.sh` is committed and merged.
8. When the owner works through an agent session under the account the agents use, approve by typing the command as the first line of a prompt (see "Owner, agents and tokens").
9. When the rules should block instead of warn, switch the mode: `npx --no-install sdlc config set mode enforce` (an owner login only: an agent login is refused, and the hooks refuse an agent that tries), then `npx --no-install sdlc upgrade` so the instruction blocks and hooks match. Commit the result through a task PR. Run `config set` in the main checkout: the harness hooks read the worktree's `sdlc.config.yaml` and then take `mode`, and only `mode`, from the main checkout's file, so the change reaches every existing task worktree at once, committed or not. When the main checkout has no config or its config does not load, the hooks use the worktree's own mode. `--config <file>` wins over both. The rest of the config, and the git hooks and `sdlc` commands, read each checkout's own copy, so they follow the commit. Run the check at the end of Step 6.

## Secrets

The policy, set by the owner and written into every agent's instructions:

- Secrets for local testing live in the OS keystore and are exported into the shell from it when needed. They are never written to a file in the repository, and never printed.
- Production secrets live only in the store named by `secrets.production_store`. An agent that needs one asks the owner to put it there and never asks for the value.
- `.env` files exist only gitignored. The `.gitignore` block that `init` adds covers `.env` and `.env.*` (not `.env.example`, `.env.sample` or `.env.template`).

**The GitHub token for the MCP server.** The owner creates it under the account the agents act as (the one listed in `agents`; the owner's own when there is no separate account), either fine-grained at https://github.com/settings/personal-access-tokens or classic at https://github.com/settings/tokens, with an expiry and the least it needs:

- Fine-grained: limited to this repository, with Contents, Issues and Pull requests (read is enough when the agents only read through MCP; Metadata read is automatic). For an organization's board, choose that organization as the resource owner and add the organization permission Projects. GitHub's fine-grained tokens do not cover a board owned by a user account; for such a board use a classic token. Outside collaborators and agent accounts that are not members of the organization cannot get a fine-grained token for its resources either: they use a classic token.
- Classic: the scopes `repo` and `project`.

`sdlc` itself uses `gh`, not this token. The token goes straight into the keystore with the command below. It is never written to a file and never pasted into the chat.

Store a secret once, then export it in the shell profile (`~/.zshrc`, `~/.bashrc`, or the PowerShell `$PROFILE`). Replace `github-mcp` with any service name; the commands prompt for the value, so it is not in the shell history.

| `secrets.local_store` | Store once | Export in the profile |
|---|---|---|
| `keychain` (macOS Keychain; also `auto` on macOS) | `security add-generic-password -a "$USER" -s github-mcp -w` | `export GITHUB_PERSONAL_ACCESS_TOKEN="$(security find-generic-password -s github-mcp -w)"` |
| `secret-service` (Linux, libsecret; also `auto` on Linux) | `secret-tool store --label=github-mcp service github-mcp` | `export GITHUB_PERSONAL_ACCESS_TOKEN="$(secret-tool lookup service github-mcp)"` |
| `wincred` (Windows Credential Manager; also `auto` on Windows) | see below | see below |
| a password-manager command, e.g. `op` (1Password) | create the item in the password manager | `export GITHUB_PERSONAL_ACCESS_TOKEN="$(op read 'op://<vault>/<item>/<field>')"` |

`secret-tool` needs a running Secret Service (GNOME Keyring or KWallet in a desktop session); on a headless machine name a password-manager command instead. For any other command, use its own documented read command.

Windows, in PowerShell, with the SecretManagement modules and their Credential Manager vault:

```powershell
Install-Module Microsoft.PowerShell.SecretManagement, SecretManagement.JustinGrote.CredMan -Scope CurrentUser
Register-SecretVault -Name CredMan -ModuleName SecretManagement.JustinGrote.CredMan
Set-Secret -Name github-mcp -Vault CredMan    # prompts for the value
# in $PROFILE:
$env:GITHUB_PERSONAL_ACCESS_TOKEN = Get-Secret -Name github-mcp -Vault CredMan -AsPlainText
```

## Secret guard

Built into the git hooks, no extra dependency. It runs in `pre-commit` (the staged added lines and added file names) and in `pre-push` (the commits being pushed, which catches commits made with `--no-verify`), in `observe` and in `enforce` mode alike: a pushed secret cannot be taken back. If `gitleaks` is on the PATH it also runs at commit, and either finding blocks.

- **What it prints.** The file, line, rule, the value masked (its first 4 characters and its length) and a fingerprint. Never the secret.
- **It fails closed.** If it cannot scan (git fails, the push input cannot be read), it says so and blocks. A config that cannot be loaded only means that no fingerprint is allowed.
- **Names blocked whatever they contain:** `.env` and `.env.*` (except `.env.example`, `.env.sample`, `.env.template`), private key and certificate stores (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.ppk`, SSH keys such as `id_rsa`), Java keystores (`*.jks`, `*.keystore`), `credentials*.json` and `service-account*.json`, cloud credential files, kubeconfig, Terraform variables and state (`*.tfvars`, `terraform.tfstate*`), `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `.dockercfg`, and `*.ovpn`. A file with one of these names is blocked even when it holds no credential (an `.npmrc` that only sets a registry, say): allow it by fingerprint when that is intended.
- **Firebase client files.** `google-services.json` and `GoogleService-Info.plist` are not blocked by name, but the public Firebase key in them (starting `AIza`) is reported. Allow its fingerprint once.
- **`.gitattributes` hides content.** A file marked `binary` or `-diff` has no text diff, so its content is not scanned. The file-name rules still apply.

False positives, two ways:

1. The marker `sdlc:allow-secret` on the line. It skips the whole line, so never use it on a minified or generated file: everything else on that line goes unscanned.
2. The fingerprint in `secrets.allow` in `sdlc.config.yaml`. A fingerprint allows one rule and one value (for a file-name finding, one rule and one path) and nothing else. Quote every fingerprint: an all-digit one is read by YAML as a number and rejected.

```yaml
secrets:
  allow:
    - "3f9a1c0b7d2e4a58"
    - "1234567890123456"   # all digits: the quotes are required
```

Limits you must tell the owner:

- `git commit --no-verify` skips the local hooks, and the pre-push hook can be skipped the same way. The server-side backstop is GitHub secret scanning push protection: `init` enables it where the plan allows, and `doctor` warns when it is off. Turn it on.
- The hooks call `sdlc` from the PATH, or from the project's dev dependency through `npx --no-install sdlc`. When neither resolves, the hook prints that `sdlc` was not found and that the secret guard is NOT active, and lets the commit through. Run `npx --no-install sdlc doctor` (it checks `sdlc.onPath` and `secrets.guard`), or install the dev dependency as in Step 4. A global install covers only that machine.
- Version skew: the hooks run the installed `sdlc`, not the version `init` ran from. When you upgrade, move the dev dependency to the same version (`npm install --save-dev agentic-sdlc-kit@<new-version>`, or the `github:SobSoft-s-r-o/agentic-sdlc-kit#<new-ref>` form for `main` or a commit), or the hooks keep running the old guard.

## Owner, agents and tokens

`sdlc` has to tell what the owner decided from what an agent wrote. It does that by GitHub login.

- **Agents should write under a separate account**, listed under `agents` in the config (a bot or machine account, or a GitHub App's `<app>[bot]` login). The state comments of the logins in `agents` are trusted like the owners', but their comments never count as an owner approval. A login cannot be both an owner and an agent (config error).
- **If they do not**, because the agents run `gh` with the owner's own account, an owner's `/approve` comment is written by the same login `sdlc` acts as, and the tool cannot tell it from the agent approving its own work. In `enforce` mode it is refused ("authored by the agent's own login"); in `observe` mode it is recorded as `unverified`. The way out for an owner who uses one login is the **prompt approval**: type the command as the first non-empty line of a prompt in the agent session (`/approve`, `/accept`, `/ran` or `/cancel <reason>`). The prompt hook sees what the human typed, not what the agent did, and records it on the task of the current branch as an approval from the prompt. With a single owner it is recorded for that owner whichever login `gh` runs as; with several owners, the login `gh` runs as must be one of them. `/approve` covers the current phase; the other commands apply to the task. The prompt text is never stored, only a hash. A subagent's prompt is ignored, a quoted or later line is not a command, and `/approve type <id>` still needs a comment. A prompt approval is only as good as the hook: see "Harness hooks and trust" and the threat model for what an agent with a shell can still forge. The same happens in `enforce` when the tool's login cannot be read (an Actions `GITHUB_TOKEN` or an App token) and `agents` is empty: owner comments are refused as indistinguishable. `doctor` warns about that case (`approvals.trust`, in `enforce` mode with `stack.actions` on and `agents` empty).
- **Owner commands on a pull request.** A `/approve`, `/accept`, `/ran` or `/cancel` in a comment on a PR counts only while the PR body links that task alone (`Related to #<n>`) and has not been edited since the comment. If the body is edited after the owner commented, the comment is ignored (`reconcile` reports it as an ignored approval (`--json` gives the reason), `sdlc approve --comment-url` refuses it), so write the command again once the body is final. The same command on the task issue is never affected. Owner commands (`/approve`, `/accept`, `/ran`, `/cancel`) go in a plain comment, not in a review. A command typed into a review body or an inline review comment is never read: no approval is recorded and `reconcile` does not report it.
- **The workflow token.** The reconcile workflow reads the secret `SDLC_TOKEN` (set with `gh secret set SDLC_TOKEN`) and fails with a message when it is missing. Use a token with the scopes `repo` and `project` for an account that can write to the repository and the board. The Actions-provided `GITHUB_TOKEN` is not enough for the board. Make that account the one listed under `agents`, not the owner's: with the owner's token the workflow runs as the owner, and in `enforce` mode the owner's own `/approve` comments are then refused as the tool's login. The workflow installs the kit in a step without the token, pins its actions by commit SHA and skips Dependabot runs.
- **Actions minutes.** The workflow also runs every hour. On a private repository each run counts against the account's Actions minutes (on a public repository it is free): roughly 720 short runs a month, each billed as at least one minute. Tell the owner; to save minutes, lower the frequency in the `cron:` line, keeping at least one run per `reconcile.closed_lookback_days`.

In short: owner decides under the owner login; agents and the workflow act under the agent account listed in `agents`.

## Harness hooks and trust

`init` and `upgrade` write the harness hooks for each configured harness: Claude Code (`.claude/settings.json`), Codex (`.codex/hooks.json`) and Gemini CLI (`.gemini/settings.json`); `agents-md` has none. Each runs the launcher `.sdlc/hooks/run.sh <harness> <event>` on session start, on every prompt and before every tool call. The launcher runs `sdlc hook <harness> <event>` (the `sdlc` on the PATH, or `npx --no-install sdlc`), prints its answer and always exits 0. What the hooks do:

- Session start tells the agent which task its branch has, and starts `sdlc sync` in the background when something is queued.
- Every prompt is read for the owner's first-line command (see "Owner, agents and tokens").
- Before a tool call, `enforce` blocks and `observe` only warns, and both record a gap on the task, for: a file edit before the plan is approved (docs, `*.md`, debugging repro and task types without a planning phase are excepted; in `enforce` the agent may not edit `sdlc.config.yaml`, `.git`, `.sdlc/` apart from `.sdlc/agents/custom/`, or the harness settings: `.claude/settings.json`, `.claude/settings.local.json`, `.codex/hooks.json`, `.codex/config.toml` and `.gemini/settings.json` at any depth, `.mcp.json` at the root, and the same files plus `.claude.json` in the home directory), a subagent without a role and model tier, `gh pr merge --admin`, a merge through `gh api` (`.../pulls/<n>/merge`, or a GraphQL `mergePullRequest` in the command; `api-merge`), another AI CLI (`claude`, `codex`, `gemini`, `aider`, and the like; `--version` and `mcp`, `plugin` or `extensions` `list` are allowed), `--no-verify`, turning the git hooks off through git config (`core.hooksPath`, `include.path`), force pushes, `git worktree prune` and forced `git worktree remove`, `rm -rf`, `sdlc config set`, `sdlc uninstall` and `sdlc init --overwrite-modified` (`kit-removal`; `--dry-run` of uninstall and `sdlc upgrade` are allowed) and running the hooks by hand. The `sdlc` rules also read `node .../dist/cli.js ...` and `node_modules/.bin/sdlc`. Running `sdlc hook` or the launcher by hand, and `kit-removal`, block in both modes.
- **The hooks fail open.** Any error of their own (no `sdlc` found, GitHub unreachable, a malformed payload, a timeout) lets the action through, with one line `sdlc: hook skipped: <reason>` on stderr. A hook is a guardrail for an agent that follows the rules, not a wall against one that does not: the threat model (`docs/threat-model.md`) lists what it does not stop.

**Commit the launcher.** The settings files find it through `git rev-parse --show-toplevel` (Claude Code's first changes to `$CLAUDE_PROJECT_DIR`), so a clone or a new worktree runs the hooks only when `.sdlc/hooks/run.sh` is committed, with mode 100755. Without it the command exits 127, the harness shows an error, and nothing is checked. `doctor` (`hooks.<harness>`) warns when it is not committed or not executable (`git update-index --chmod=+x .sdlc/hooks/run.sh` fixes the mode). A worktree made before the launcher was merged needs the branch updated first. The hook commands also need git 2.31 or later (`doctor` checks `git.version`).

**Trust, per harness.** Each harness loads project hooks only after a person says the project may be trusted. The owner does this once per machine and project; nothing in the repository can do it for them.

- **Claude Code:** holds hooks back until the workspace trust dialog is accepted, the first time it starts in the project. In print mode (`claude -p`) and the SDK the folder counts as trusted. Edits to the settings are picked up while it runs.
- **Codex:** needs the project trusted, and then each hook reviewed: start `codex` in the repository, trust the project, run `/hooks` and approve the sdlc hooks. A new or changed hook is skipped until it is reviewed again, so `upgrade` can require a new review. `--dangerously-bypass-hook-trust` runs hooks without review, which is the owner's call, not the agent's. Codex's own documentation calls its hooks "a useful guardrail, not a complete enforcement boundary".
- **Gemini CLI:** loads project hooks only in a trusted folder: start `gemini` in the repository and trust it (decisions are kept in `~/.gemini/trustedFolders.json`). A headless run (`gemini -p`, CI) needs `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true`, or it stops with an untrusted-workspace error. Gemini only warns once about a project hook it has not seen, then runs it. On Windows, Gemini runs hooks through PowerShell and the sdlc hooks need a POSIX shell, so they are not supported there (`doctor` warns).

**Switches.** Each harness can turn all hooks off: `disableAllHooks` in Claude Code settings, `[features] hooks = false` in the Codex config, `hooksConfig.enabled: false` (or the sdlc hooks listed in `hooksConfig.disabled`) in Gemini CLI settings. `doctor` (`hooks.switches`) reads them in the project files (failure in `enforce`, warning in `observe`) and in your own home directory (warning only).

`doctor` cannot read a harness's trust state (the `hooks.codex` line only reminds you), so a harness whose project is not trusted still looks installed. Use the check at the end of Step 6 in each harness the team uses.

**Worktrees.** One worktree per task keeps edits out of the main checkout: `npx --no-install sdlc worktree start <issue>` creates `.worktrees/<issue>-<slug>` on the branch `task/<issue>-<slug>` from the freshly fetched default branch (`--dry-run` shows the plan). After the merge, run `npx --no-install sdlc worktree finish <issue>` from the main checkout, never from inside the worktree. It refuses while the worktree has uncommitted or untracked changes or an ignored `.env` or `.env.*` file, or when no pull request of the task has merged. Other ignored files, such as `node_modules` and build output, are deleted with the worktree. It fast-forwards the default branch when the main checkout is clean and on it, then runs `git worktree remove` and `git branch -d`, never forced. `sdlc status` lists orphan worktrees and `doctor` (`worktrees.orphans`) warns about them.

**Offline.** When GitHub cannot be reached (a `gh` call that runs longer than 60 seconds is killed and counts as unreachable), the commands an agent needs to keep working are queued instead of failing: `stage start`, `stage publish`, `evidence add`, `review handoff`, `approve` and `task checkpoint`. A queued command prints ``queued for `sdlc sync` (GitHub unreachable): sdlc ...`` and exits 0. The queue is `.sdlc/cache/outbox.jsonl` in the main checkout (git ignores it), shared by all worktrees. The gaps recorded by the hooks wait in `.sdlc/cache/gaps.jsonl` and go into the task's state comment on the next sync (the newest 20 are kept). A gap belongs to a task: one logged where no task exists is dropped by the sync. Run `npx --no-install sdlc sync` when GitHub is back: it replays the queue in order (`--dry-run` only lists it) and exits 0 when it is done, 75 when GitHub is still unreachable (what is left stays queued), and 1 when a command failed for good (it moves to `.sdlc/cache/outbox-failed.jsonl` for the owner to look at). Session start runs a sync in the background, and `sdlc status` shows `Queued for sync: <n> write(s), <m> gap(s)`; `doctor` (`outbox.pending`) warns when writes are queued or failed. `task new` and `deploy record` are never queued: run them again once GitHub is back. With `SDLC_NO_QUEUE=1` a command that cannot reach GitHub exits 75 and queues nothing. A command that half-succeeded before the connection dropped can post its comment twice when it is replayed.

## MCP servers

- The harness reads `GITHUB_PERSONAL_ACCESS_TOKEN` when it starts a server, so export it in the shell that starts the agent. `doctor` (`mcp.token`) checks that the variable is set and never shows its value.
- **Claude Code:** project scope is `.mcp.json`, and Claude Code asks the owner to approve the servers. For user scope, `init` prints a `claude mcp add --scope user ...` command whose header holds the reference `${GITHUB_PERSONAL_ACCESS_TOKEN}` unexpanded. Whether Claude Code expands that reference in user scope depends on its version, so after the owner runs the command, have them run `claude mcp list` and check that `github` shows as connected. `doctor`'s `mcp.claude` check only confirms the server is listed.
- **Codex:** the configuration lives under `CODEX_HOME` (default `~/.codex`); `codex mcp add` writes there. The project file `.codex/config.toml` is loaded only after the project is trusted in Codex. `codex mcp add` cannot forward an environment variable to a local server: `init` prints the `env_vars` line to add by hand.
- **Gemini CLI:** project scope is `.gemini/settings.json`; user scope is the printed `gemini mcp add --scope user ...` command.
- **`agents-md` only:** there is no MCP wiring; the instructions are the only layer.

## Custom agent roles

Project-specific roles are Markdown files in `.sdlc/agents/custom/`, named `<role>.md`, never overwritten by `upgrade`. The front matter has exactly `role` (equal to the file name), `description`, `tier` (`deep`, `standard` or `fast`), `can_edit`, `returns` and `escalate_when`; the body is the prompt. After adding one, run `npx --no-install sdlc upgrade` to render it for every harness. A role named like a built-in one replaces it, with a notice.

Role files are templates: `{{...}}` is filled in when the file is rendered. To write a literal `{{`, put a backslash before it (`\{{`), for example to quote a GitHub Actions expression.

## Upgrading and uninstalling

- Upgrade: set `kit_ref` to the new ref, move the dev dependency to it (the command in Step 4), then run `npx --no-install sdlc upgrade --dry-run` and `npx --no-install sdlc upgrade`. Without a dev dependency, run `npx -y agentic-sdlc-kit@<new-version> upgrade` instead (the `github:SobSoft-s-r-o/agentic-sdlc-kit#<new-ref>` form for `main` or a commit). It re-renders the managed files from the installed kit version and removes what the kit no longer generates, keeps everything outside managed blocks, edited files and custom roles, and never touches GitHub. Commit the result through a task PR.
- Uninstall: `npx --no-install sdlc uninstall --dry-run`, then `npx --no-install sdlc uninstall`. It removes the managed files and unsets `core.hooksPath` when it is the kit's. It keeps `sdlc.config.yaml`, `.sdlc/agents/custom/`, the cache and any file that was edited. It removes the `.gitignore` block too, so `.env`, `.env.*` and `.sdlc/cache/` are no longer ignored: add back the lines you need. The board, labels, issues, branch protection and push protection stay on GitHub. Remove the dev dependency yourself.

## Troubleshooting and limits

`npx --no-install sdlc doctor` prints one line per check, and a `fix:` line under a failed one. In the fixes below, `sdlc <command>` means `npx --no-install sdlc <command>`.

| Check | Meaning and fix |
|---|---|
| `config.valid` | the config does not load: `sdlc config validate` lists the issues |
| `manifest.present`, `files.managed` | the kit is not installed, or managed files are missing (failure: `sdlc init`) or edited (warning: your edits are kept, `--overwrite-modified` replaces them) |
| `git.hooksPath` | `core.hooksPath` is unset or something else (husky, say), so the kit's hooks do not run: `init` leaves another value alone, so run `git config core.hooksPath .sdlc/githooks`, or call the scripts in `.sdlc/githooks` from your own hooks |
| `git.legacyHooks` | the repository's own hooks in `.git/hooks` that the kit's hooks run after their own step; a warning names one that is not executable and is skipped: `chmod +x` it |
| `sdlc.onPath` (warning), `secrets.guard` (failure) | the hooks cannot find `sdlc` (they look on the PATH, then run `npx --no-install sdlc`), so the secret guard is not active: install the dev dependency or a global install (Step 4). Under `npx -y` doctor leaves out the PATH entries npx added for its own run, as a hook does not see them |
| `kit.ref` | failure: a release `kit_ref` (`v0.3.0`) is not published on npm, so the generated `npx -y agentic-sdlc-kit@<version>` commands fail (`v0.1.0` and `v0.2.0` never were): set `kit_ref` to a published version (`v0.3.0` or later) or `main`. Warning: a branch `kit_ref` does not exist in the kit's repository, so the generated `npx -y github:...#<kit_ref>` commands fail: set it to `main` or the ref you installed from. "cannot verify" means `npm view` (release) or `git ls-remote` (branch) could not reach the registry or GitHub |
| `board.fields`, `labels` | no board number in the config, or fields, options or views missing: `sdlc board ensure`; labels missing: `sdlc init`. A view the API cannot create is a warning and a manual step |
| `actions.workflow`, `actions.secret` | the workflow file is missing (`sdlc init`) or `SDLC_TOKEN` is not set (`gh secret set SDLC_TOKEN`); without admin rights the secret cannot be checked and `doctor` only warns |
| `mcp.token`, `mcp.<harness>` | export `GITHUB_PERSONAL_ACCESS_TOKEN` from the OS keystore in the shell profile ("Secrets"); `mcp.claude`, `mcp.codex` and `mcp.gemini` warn when `<harness> mcp list` does not show the configured servers: approve or add the server, and trust the project in Codex and Gemini |
| `git.version` | git is older than 2.31, which the hooks and worktrees need: upgrade git |
| `hooks.<harness>` | the settings file has no sdlc hook (`sdlc upgrade`), or `.sdlc/hooks/run.sh` is missing, not committed or not mode 100755: commit it, or `git update-index --chmod=+x .sdlc/hooks/run.sh`. When all is well, the Codex line adds that Codex runs the hooks only after you trust the project and approve them in `/hooks`. Gemini on Windows is a warning: not supported |
| `hooks.switches` | a setting turns the hooks of a configured harness off: `disableAllHooks: true` in `.claude/settings.json` or `.claude/settings.local.json`, `hooksConfig.enabled: false` or an sdlc hook in `hooksConfig.disabled` in `.gemini/settings.json`, `hooks = false` (or `codex_hooks`) under `[features]` in `.codex/config.toml`, also written as `features.hooks = false` or `features = { hooks = false }`. In the project it fails in `enforce` and warns in `observe`; in your home directory (`~/...`) it only warns. Remove the setting |
| `hooks.roundtrip` | the hook code does not refuse `gh pr merge 1 --admin` as it should (failure): `sdlc upgrade`, then reinstall `sdlc` if it persists; do not rely on the hooks until it passes |
| `stack.superpowers`, `stack.graphify` | a plugin or tool of the stack is not installed (warning): run the commands under question 11 |
| `outbox.pending` | writes are queued or failed: `sdlc sync` (see "Harness hooks and trust") |
| `worktrees.orphans` | a worktree under `.worktrees` that no live task needs: `sdlc worktree finish <issue>` for a done task, `git worktree remove <path>` for the others; "not checked" means GitHub could not be read |
| `secrets.pushProtection` | enable secret scanning and push protection; a plan or account without admin rights cannot, and the local guard still works |
| `secrets.trackedFiles` | a tracked file has a secret-looking name: `git rm --cached <file>`, rotate the secret, or allow its fingerprint |
| `approvals.trust` | see "Owner, agents and tokens" |

Other limits:

- Branch protection: `init` sets classic branch protection (a pull request is required, no approvals, no force pushes or deletions) and only when the branch has none. A repository that uses rulesets keeps its own rules: check them there, `init` does not read them.
- A plan or account that cannot have branch protection or push protection (a free private repository, or a token without admin rights) is reported by `init` as unavailable, and `init` goes on.
- `init` and `upgrade` write only inside the repository. User-scope MCP commands and the keystore are the owner's to run.
- The harness hooks are a guardrail, not a security boundary, and they fail open. `docs/threat-model.md` lists what the layers guarantee and what an agent with a shell can still do. `sdlc: hook skipped: ...` on stderr means a hook did not run for that call; exit 127 on a hook command means the launcher is missing from that checkout or the command ran outside a git repository.
