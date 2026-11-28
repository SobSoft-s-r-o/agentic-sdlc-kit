#!/bin/sh
# agentic-sdlc-kit git hook: {{name}}. Managed by `sdlc init` and `sdlc upgrade`; local edits are overwritten.
# It runs `sdlc githook {{name}}`, then the repository's own {{name}} hook from the git hooks
# directory, if there is one: core.hooksPath points git here, so git no longer runs that one itself.
{{#if stdin}}
# git feeds pre-push the refs on stdin and both steps need them, so keep a copy, byte for byte: the
# `.` keeps the trailing newlines that $(...) would drop, and is removed again. If stdin cannot be
# read the push is blocked, because the secret guard would otherwise see no refs and let it through.
if ! sdlc_stdin=$(cat && echo .); then
  echo "agentic-sdlc-kit: pre-push could not read the refs git passed on stdin; push blocked" >&2
  exit 1
fi
sdlc_stdin=${sdlc_stdin%.}
{{/if}}
sdlc_status=0
if command -v sdlc >/dev/null 2>&1; then
  {{#if stdin}}printf '%s' "$sdlc_stdin" | {{/if}}sdlc githook {{name}} "$@"
  sdlc_status=$?
# --no-install: a hook must never download a package, and npx would ask before doing so.
# </dev/null: the probe must not read the stdin that git feeds pre-push.
elif command -v npx >/dev/null 2>&1 && npx --no-install sdlc --version >/dev/null 2>&1 </dev/null; then
  {{#if stdin}}printf '%s' "$sdlc_stdin" | {{/if}}npx --no-install sdlc githook {{name}} "$@"
  sdlc_status=$?
else
  echo "sdlc not found; agentic-sdlc-kit git hook {{name}} skipped (install: see INSTALL.md){{#if guard}}; the secret guard is NOT active{{/if}}" >&2
fi
if [ "$sdlc_status" -ne 0 ]; then
  exit "$sdlc_status"
fi

# The repository's own hook (pre-commit framework, lefthook, a hand-written one), with the same
# arguments{{#if stdin}} and stdin{{/if}}; its exit code is the hook's. Not when that hook is this script,
# or when this runs inside a chained hook already: either would loop.
sdlc_common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
sdlc_legacy="$sdlc_common/hooks/{{name}}"
if [ ! -f "$sdlc_legacy" ] || [ "$SDLC_CHAINED_HOOK" = "{{name}}" ]; then
  exit 0
fi
# -ef: the same file (device and inode), whatever path leads to it.
if [ "$sdlc_legacy" -ef "$0" ]; then
  exit 0
fi
if [ ! -x "$sdlc_legacy" ]; then
  echo "agentic-sdlc-kit: $sdlc_legacy is not executable, so it was not run (chmod +x it to run it after the sdlc hook)" >&2
  exit 0
fi
SDLC_CHAINED_HOOK={{name}}
export SDLC_CHAINED_HOOK
{{#if stdin}}printf '%s' "$sdlc_stdin" | {{/if}}"$sdlc_legacy" "$@"
exit $?
