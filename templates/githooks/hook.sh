#!/bin/sh
# agentic-sdlc-kit git hook: {{name}}. Managed by `sdlc init` and `sdlc upgrade`; local edits are overwritten.
# The logic is `sdlc githook {{name}}`; this script only finds the sdlc command and hands over.
if command -v sdlc >/dev/null 2>&1; then
  exec sdlc githook {{name}} "$@"
fi
# --no-install: a hook must never download a package, and npx would ask before doing so.
if command -v npx >/dev/null 2>&1 && npx --no-install sdlc --version >/dev/null 2>&1; then
  exec npx --no-install sdlc githook {{name}} "$@"
fi
echo "sdlc not found; agentic-sdlc-kit git hook {{name}} skipped (install: see INSTALL.md){{#if guard}}; the secret guard is NOT active{{/if}}" >&2
exit 0
