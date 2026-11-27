# Installing agentic-sdlc-kit

This is the procedure an AI agent follows to install the kit into a repository, with the repository's owner in the chat. You are the agent; "the owner" is the person you ask.

Rules for the whole install:

- Ask the install questions one topic at a time, each with the default you detected, and wait for the answer. Do not batch them.
- The installer never commits, pushes or writes outside the repository. You commit; the owner runs the steps in Step 7.
- No secret goes into a file, a commit, a chat message or a log. Never ask the owner to paste a token to you.
- `<ref>` is the kit version to install: a release tag such as `v0.1.0`, or `main`. Until `sdlc` is installed (Step 4), run every `sdlc` command as `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> <command>`.

## Step 1: Preflight

```sh
npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> doctor --preflight
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
npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> config suggest
```

This prints a `sdlc.config.yaml` detected from the repository (YAML on stdout, notes on stderr; `--write` creates the file only when it does not exist). It writes `version`, `harnesses`, `mode`, `github`, `owners`, `agents`, `merge_policy`, `quality_gate`, `task_types` and `targets`. The other keys keep their defaults until you add them: `content_language`, `models`, `stack`, `mcp`, `secrets`, `reconcile` and `kit_ref`.

Now ask the questions below in order, one at a time. For each, state the detected default and the key it sets, and keep the owner's answer for Step 3.

### The questions

#### 1. Harnesses

Which agents work in this repository? Key `harnesses`, any of `claude`, `codex`, `gemini`, `agents-md` (any other agent that reads `AGENTS.md`). Detected from `CLAUDE.md`, `.codex/`, `AGENTS.md` and `GEMINI.md`; with none of them the suggestion is `claude`. If `AGENTS.md` exists, ask whether it belongs to Codex (`codex`) or to some other agent (`agents-md`).

#### 2. Board

Use an existing GitHub Project or create one? Key `github.project`: `owner` (the login that owns it), `owner_type` (`org` or `user`) and `number`. For an existing project list them (`gh project list --owner <owner>`) and set `number`. Leave `number` out to have `init` create one titled `<repo> SDLC tasks`; `init` then prints the number and you add it to the config (Step 4).

#### 3. Enforcement mode

Key `mode`: `observe` (default) records gaps and warns; `enforce` blocks. In `enforce` the git hooks refuse commits to the default branch, pushes to it, and pushes of a `task/<n>-...` branch whose task is not tracked, and owner approvals need the account setup in "Owner, agents and tokens". The secret guard blocks in both modes.

#### 4. Task types

Key `task_types.enabled`; built-in ids are `feature`, `bugfix`, `tooling`, `analysis`, `production-data`, `artifact`, `spike`. Keep `tooling`: the install PR is a `tooling` task. `feature` and `bugfix` end on a deploy and need at least one target, so they are off when no target was detected. Custom types go under `task_types.custom` (see section 7 of the design).

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

Keys `mcp.servers` (catalog ids: `github` is the default; optional `context7` for library docs and `playwright` for browser checks), `mcp.scope` and `mcp.github_transport`. Ask for each server whether it is configured for the project or the owner's user account.

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

- `stack.superpowers`: adds the Superpowers skill route to the instructions. The kit does not install the Superpowers plugin; the owner does, per harness.
- `stack.graphify`: adds the graphify rules and `graphify-out/` to `.gitignore`.
- `stack.branch_protection`: `init` protects the default branch (pull request required, no force pushes or deletions).
- `stack.actions`: renders `.github/workflows/sdlc-reconcile.yml`, which needs the `SDLC_TOKEN` secret. Without it the board updates only from local commands and hooks.

#### 12. Owners and agents

`owners`: GitHub logins whose `/approve`, `/accept`, `/ran` and `/cancel` comments count (default: the login `gh` runs as). `agents`: logins the agents write as, if the owner uses a separate account. Read "Owner, agents and tokens" before asking.

#### 13. Language of task content

Key `content_language`, default `en`: the language agents write issues, pull requests and comments in. The instruction files themselves stay English.

## Step 3: Write the config and get the owner's OK

Write `sdlc.config.yaml` from the answers (edit the suggestion, or write it fresh), then:

```sh
npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> config validate
```

Set `kit_ref` to the `<ref>` you installed from: the generated instructions and the reconcile workflow run `npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<kit_ref>`, and the default is `v` plus the installed version, which must exist as a tag. Show the file to the owner and wait for a yes. A complete example:

```yaml
version: 1
harnesses: [claude, codex]
mode: observe                 # observe | enforce
kit_ref: v0.1.0               # the ref you installed from
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
npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> init --dry-run
```

Show the plan to the owner, then run `init` without `--dry-run`. It writes the managed files (instruction blocks, agent roles, skills, MCP config, the PR template, the reconcile workflow, `.sdlc/manifest.json`, the git hooks and `.gitignore` lines), sets `core.hooksPath` to `.sdlc/githooks` (the hooks `pre-commit` and `pre-push`, which run the secret guard and the branch rules, then `post-merge` and `post-checkout`), and provisions the board, labels, default-branch protection and secret scanning push protection. It commits nothing. `init` is idempotent: run it again and nothing changes.

- Files that already exist and are not the kit's are kept (notice `exists, not managed by sdlc; kept`); files you or the owner edited are kept (notice `modified locally; kept`); `--overwrite-modified` replaces them.
- If `init` created a board, it printed `Created project #N`. Put `number: N` under `github.project` in `sdlc.config.yaml` and run `init` again, or a second board is created next time.
- `--skip-github` leaves GitHub alone; use it when the account is not an admin of the repository.

Then make `sdlc` resolvable, because the git hooks call it and, when they cannot find it, the secret guard does not run (see "Secret guard"):

```sh
npm install --save-dev github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>
```

For a repository without `package.json`, install it for the owner's machine instead: `npm install --global github:SobSoft-s-r-o/agentic-sdlc-kit#<ref>`. From here on plain `sdlc <command>` works.

## Step 5: Commit, open the PR, track it

The install is the first task, type `tooling`. Create it before the branch, because the branch name carries its number:

```sh
sdlc task new --type tooling --title "Install agentic-sdlc-kit" --summary "Install agentic-sdlc-kit"
```

It prints `Created #<n>: <url>`. Then:

```sh
git switch -c task/<n>-install-agentic-sdlc-kit
git add sdlc.config.yaml .sdlc .github .gitignore   # plus the instruction files, agent folders, MCP files, package.json and the lockfile that init and npm changed
git commit -m "chore: install agentic-sdlc-kit"
git push -u origin task/<n>-install-agentic-sdlc-kit
gh pr create --title "chore: install agentic-sdlc-kit" --body-file <body>
```

The PR body says `Related to #<n>` (never `Fixes` or `Closes`) and `Scope: final`. Then hand it over: `sdlc review handoff <n> --pr <pr-number>`. The owner reviews and merges.

If the commit is blocked, the secret guard found something: see "Secret guard". Never use `--no-verify`.

## Step 6: Verify

```sh
sdlc doctor
```

Each line starts with `✓` (ok), `!` (warning) or `✗` (failure), and a failure exits non-zero. Until the owner finishes Step 7, expect `actions.secret` to fail and `mcp.token` to warn; report anything else to the owner instead of hiding it. The checks and their fixes are in "Troubleshooting".

## Step 7: Owner-only steps

Give the owner this list; do not do these yourself and do not ask for any value.

1. `gh secret set SDLC_TOKEN` (when `stack.actions` is on): the token the reconcile workflow uses, see "Owner, agents and tokens". `gh` prompts for the value.
2. Store the GitHub token for the MCP server in the OS keystore and export `GITHUB_PERSONAL_ACCESS_TOKEN` from it in the shell profile, with the commands for the chosen `secrets.local_store` in "Secrets". Never in a file in the repository.
3. Approve the project's MCP servers when Claude Code asks, and trust the project in Codex (it loads `.codex/config.toml` only for trusted projects).
4. Run the user-scope commands `init` printed (`mcp.scope: user`), then check them as described in "MCP servers".
5. Turn on secret scanning push protection if `doctor` warns that it is off (repository settings, Code security).
6. Install the Superpowers plugin for each harness if `stack.superpowers` is on.

## Secrets

The policy, set by the owner and written into every agent's instructions:

- Secrets for local testing live in the OS keystore and are exported into the shell from it when needed. They are never written to a file in the repository, and never printed.
- Production secrets live only in the store named by `secrets.production_store`. An agent that needs one asks the owner to put it there and never asks for the value.
- `.env` files exist only gitignored. The `.gitignore` block that `init` adds covers `.env` and `.env.*` (not `.env.example`).

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
Set-Secret -Vault CredMan -Name github-mcp -Secret (Read-Host 'GitHub token' -AsSecureString)
# in $PROFILE:
$env:GITHUB_PERSONAL_ACCESS_TOKEN = Get-Secret -Vault CredMan -Name github-mcp -AsPlainText
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
- The hooks call `sdlc`: from the PATH, or the project's installed dev dependency. When neither resolves, the hook prints that `sdlc` was not found and that the secret guard is NOT active, and lets the commit through. Run `sdlc doctor` (checks `sdlc.onPath` and `secrets.guard`).
- Version skew: the hooks run the installed `sdlc`, not the version `init` ran from. After `sdlc upgrade`, keep the dev dependency at the same version (`npm install --save-dev github:SobSoft-s-r-o/agentic-sdlc-kit#<new-ref>`), or the hooks keep running the old guard.

## Owner, agents and tokens

`sdlc` has to tell what the owner decided from what an agent wrote. It does that by GitHub login.

- **Agents should write under a separate account**, listed under `agents` in the config (a bot or machine account, or a GitHub App's `<app>[bot]` login). The state comments of the logins in `agents` are trusted like the owners', but their comments never count as an owner approval. A login cannot be both an owner and an agent (config error).
- **If they do not**, because the agents run `gh` with the owner's own account, an owner's `/approve` comment is written by the same login `sdlc` acts as, and the tool cannot tell it from the agent approving its own work. In `enforce` mode it is refused ("authored by the agent's own login"); in `observe` mode it is recorded as `unverified`. The same happens in `enforce` when the tool's login cannot be read (an Actions `GITHUB_TOKEN` or an App token) and `agents` is empty: owner comments are refused as indistinguishable. `doctor` warns about that case (`approvals.trust`, in `enforce` mode with `stack.actions` on and `agents` empty).
- **The workflow token.** The reconcile workflow reads the secret `SDLC_TOKEN` (set with `gh secret set SDLC_TOKEN`) and fails with a message when it is missing. Use a token with the scopes `repo` and `project` for an account that can write to the repository and the board. The Actions-provided `GITHUB_TOKEN` is not enough for the board. Make that account the one listed under `agents`, not the owner's: with the owner's token the workflow runs as the owner, and in `enforce` mode the owner's own `/approve` comments are then refused as the tool's login.

In short: owner decides under the owner login; agents and the workflow act under the agent account listed in `agents`.

## MCP servers

- The harness reads `GITHUB_PERSONAL_ACCESS_TOKEN` when it starts a server, so export it in the shell that starts the agent. `doctor` (`mcp.token`) checks that the variable is set and never shows its value.
- **Claude Code:** project scope is `.mcp.json`, and Claude Code asks the owner to approve the servers. For user scope, `init` prints a `claude mcp add --scope user ...` command whose header holds the reference `${GITHUB_PERSONAL_ACCESS_TOKEN}` unexpanded. Whether Claude Code expands that reference in user scope depends on its version, so after the owner runs the command, have them run `claude mcp list` and check that `github` shows as connected. `doctor`'s `mcp.claude` check only confirms the server is listed.
- **Codex:** the configuration lives under `CODEX_HOME` (default `~/.codex`); `codex mcp add` writes there. The project file `.codex/config.toml` is loaded only after the project is trusted in Codex. `codex mcp add` cannot forward an environment variable to a local server: `init` prints the `env_vars` line to add by hand.
- **Gemini CLI:** project scope is `.gemini/settings.json`; user scope is the printed `gemini mcp add --scope user ...` command.
- **`agents-md` only:** there is no MCP wiring; the instructions are the only layer.

## Custom agent roles

Project-specific roles are Markdown files in `.sdlc/agents/custom/`, named `<role>.md`, never overwritten by `upgrade`. The front matter has exactly `role` (equal to the file name), `description`, `tier` (`deep`, `standard` or `fast`), `can_edit`, `returns` and `escalate_when`; the body is the prompt. After adding one, run `sdlc upgrade` to render it for every harness. A role named like a built-in one replaces it, with a notice.

Role files are templates: `{{...}}` is filled in when the file is rendered. To write a literal `{{`, put a backslash before it (`\{{`), for example to quote a GitHub Actions expression.

## Upgrading and uninstalling

- `sdlc upgrade --dry-run`, then `sdlc upgrade`: re-render the managed files from the installed kit version and remove what the kit no longer generates. It keeps everything outside managed blocks, edited files and custom roles, and never touches GitHub. If you set `kit_ref`, change it to the new ref first or the regenerated files keep calling the old one. Update the dev dependency to the same version, and commit through a task PR.
- `sdlc uninstall --dry-run`, then `sdlc uninstall`: removes the managed files and unsets `core.hooksPath` when it is the kit's. It keeps `sdlc.config.yaml`, `.sdlc/agents/custom/`, the cache and any file that was edited. The board, labels, issues, branch protection and push protection stay on GitHub. Remove the dev dependency yourself.

## Troubleshooting and limits

`sdlc doctor` prints one line per check, and a `fix:` line under a failed one.

| Check | Meaning and fix |
|---|---|
| `config.valid` | the config does not load: `sdlc config validate` lists the issues |
| `manifest.present`, `files.managed` | the kit is not installed, or managed files are missing (failure: `sdlc init`) or edited (warning: your edits are kept, `--overwrite-modified` replaces them) |
| `git.hooksPath` | `core.hooksPath` is unset or something else (husky, say), so the kit's hooks do not run: `init` leaves another value alone, so run `git config core.hooksPath .sdlc/githooks`, or call the scripts in `.sdlc/githooks` from your own hooks |
| `sdlc.onPath` (warning), `secrets.guard` (failure) | the hooks cannot find `sdlc` (they look on the PATH, then run `npx --no-install sdlc`), so the secret guard is not active: install the dev dependency or a global install (Step 4) |
| `board.fields`, `labels` | no board number in the config, or fields, options or views missing: `sdlc board ensure`; labels missing: `sdlc init`. A view the API cannot create is a warning and a manual step |
| `actions.workflow`, `actions.secret` | the workflow file is missing (`sdlc init`) or `SDLC_TOKEN` is not set (`gh secret set SDLC_TOKEN`); without admin rights the secret cannot be checked and `doctor` only warns |
| `mcp.token`, `mcp.claude` | export `GITHUB_PERSONAL_ACCESS_TOKEN`; approve or add the MCP server |
| `secrets.pushProtection` | enable secret scanning and push protection; a plan or account without admin rights cannot, and the local guard still works |
| `secrets.trackedFiles` | a tracked file has a secret-looking name: `git rm --cached <file>`, rotate the secret, or allow its fingerprint |
| `approvals.trust` | see "Owner, agents and tokens" |

Other limits:

- Branch protection: `init` sets classic branch protection (a pull request is required, no approvals, no force pushes or deletions) and only when the branch has none. A repository that uses rulesets keeps its own rules: check them there, `init` does not read them.
- A plan or account that cannot have branch protection or push protection (a free private repository, or a token without admin rights) is reported by `init` as unavailable, and `init` goes on.
- `init` and `upgrade` write only inside the repository. User-scope MCP commands and the keystore are the owner's to run.
