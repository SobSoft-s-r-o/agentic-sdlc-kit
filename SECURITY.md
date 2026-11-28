# Security policy

## Supported versions

Only the latest minor release of agentic-sdlc-kit gets security fixes, as a patch release of that minor. If you run an older minor, upgrade first (`npx --no-install sdlc upgrade`; see [INSTALL.md](INSTALL.md)) and check whether the problem is still there.

## Report a vulnerability

Report it privately through GitHub: open [Report a vulnerability](https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/security/advisories/new) (the repository's Security tab, "Report a vulnerability"). Please do not open a public issue or pull request for it, and do not post it in a discussion.

Include what you can:

- the version (`npx --no-install sdlc --version`) and your operating system;
- the harness involved (Claude Code, Codex, Gemini CLI) and the `mode` (`observe` or `enforce`);
- the steps to reproduce, and what you expected instead;
- what an attacker gains.

Do not put a real secret in the report. A masked value, or a fake one of the same shape, is enough.

The maintainers read every report, answer on the same private thread, and publish a fix and an advisory once a fix is out. This is a small project, so allow some days for the first answer.

## What is in scope

The kit's guards are layered, and each layer has limits. [docs/threat-model.md](docs/threat-model.md) says what each layer guarantees and lists the known bypasses: an agent with a shell can do more than the harness hooks catch, and the git hooks can be skipped with `git commit --no-verify` unless push protection or branch protection backs them. A bypass that is already listed there is a known limit, not a vulnerability; a new one is worth a report.

In scope:

- a way around a guard that the threat model says holds;
- the secret guard printing or storing an unmasked secret, or failing open where it says it fails closed;
- a hook, command or workflow of the kit that runs attacker-controlled input as code, or leaks a token (`SDLC_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`);
- the published package or its release workflow shipping something other than this repository's source.

Out of scope: a bug in `gh`, git, a harness or a dependency itself (report it upstream), and anything that needs the owner's own token or local account to be compromised first.
