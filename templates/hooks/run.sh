#!/bin/sh
# agentic-sdlc-kit harness hook launcher. Managed by `sdlc init` and `sdlc upgrade`; local edits are overwritten.
# Claude Code, Codex and Gemini CLI call it as `run.sh <harness> <event>` with their JSON payload on stdin;
# it runs `sdlc hook <harness> <event>`, which reads that payload and prints the harness's answer.
#
# A hook must never get in the way of the agent. Whatever goes wrong here, this script prints nothing
# of its own to stdout, says why on stderr, and exits 0, which every harness reads as "allow". A block
# is the JSON that `sdlc hook` prints, never an exit code.
sdlc_status=0
if command -v sdlc >/dev/null 2>&1; then
  sdlc hook "$@" || sdlc_status=$?
# --no-install: a hook must never download a package, and npx would ask before doing so.
# </dev/null: the probe must not read the payload on stdin, which the real command needs.
elif command -v npx >/dev/null 2>&1 && npx --no-install sdlc --version >/dev/null 2>&1 </dev/null; then
  npx --no-install sdlc hook "$@" || sdlc_status=$?
else
  echo "sdlc: hook skipped: sdlc not found" >&2
fi
if [ "$sdlc_status" -ne 0 ]; then
  echo "sdlc: hook skipped: sdlc exited with status $sdlc_status" >&2
fi
exit 0
