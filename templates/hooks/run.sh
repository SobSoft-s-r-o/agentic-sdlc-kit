#!/bin/sh
# agentic-sdlc-kit harness hook launcher. Managed by `sdlc init` and `sdlc upgrade`; local edits are overwritten.
# Claude Code, Codex and Gemini CLI call it as `run.sh <harness> <event>` with their JSON payload on stdin;
# it runs `sdlc hook <harness> <event>`, which reads that payload and prints the harness's answer.
#
# A hook must never get in the way of the agent. Whatever goes wrong here, this script says why on
# stderr, prints nothing of its own to stdout except `{}` for Gemini (the empty answer its hooks expect;
# Claude and Codex read empty stdout as "allow"), and exits 0. A block is the JSON that `sdlc hook`
# prints, never an exit code.
#
# sdlc's stdout is kept in a variable so that a failed run can be told from an answer. `.<status>` is
# added inside the $(...) so that trailing newlines survive and the exit status comes out with the text.
sdlc_out=
sdlc_ok=
if command -v sdlc >/dev/null 2>&1; then
  sdlc_out=$(sdlc hook "$@"; echo ".$?")
# --no-install: a hook must never download a package, and npx would ask before doing so.
# </dev/null: the probe must not read the payload on stdin, which the real command needs.
elif command -v npx >/dev/null 2>&1 && npx --no-install sdlc --version >/dev/null 2>&1 </dev/null; then
  sdlc_out=$(npx --no-install sdlc hook "$@"; echo ".$?")
fi

if [ -z "$sdlc_out" ]; then
  echo "sdlc: hook skipped: sdlc not found" >&2
else
  sdlc_status=${sdlc_out##*.}
  sdlc_out=${sdlc_out%.*}
  printf '%s' "$sdlc_out"
  if [ "$sdlc_status" -eq 0 ]; then
    sdlc_ok=1
  else
    echo "sdlc: hook skipped: sdlc exited with status $sdlc_status" >&2
  fi
fi

# Skipped without an answer: Gemini wants a JSON object on stdout.
if [ -z "$sdlc_ok" ] && [ -z "$sdlc_out" ] && [ "$1" = gemini ]; then
  echo '{}'
fi
exit 0
