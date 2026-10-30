#!/usr/bin/env bash
# verify-then.sh <expected sha256> <file> -- <command...>
# Runs the command only if <file>'s sha256 is exactly <expected> (64 lowercase
# hex); otherwise fails without running it.  The one gate every downloaded
# byte goes through in app-mobile-selftest.yml (the pinned WebView build), and
# the gate its negative control exercises with a wrong hash on a small fixture
# (test-verify-then.sh): same code path, the command must not be reached.
set -euo pipefail
want=${1:?usage: verify-then.sh <sha256> <file> -- <command...>}
file=${2:?usage: verify-then.sh <sha256> <file> -- <command...>}
[ "${3:-}" = "--" ] || { echo "FAIL: verify-then.sh: expected -- before the command"; exit 2; }
shift 3
[ "$#" -gt 0 ] || { echo "FAIL: verify-then.sh: no command"; exit 2; }
[[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: '$want' is not a 64-hex lowercase sha256"; exit 2; }
[ -f "$file" ] || { echo "FAIL: no file $file"; exit 1; }
# (an explicit status test: errexit ignores a `!` pipeline)
if printf '%s  %s\n' "$want" "$file" | sha256sum -c --status; then
  echo "ok: sha256 $want  $(basename "$file")" >&2
else
  echo "FAIL: $file's sha256 is $(sha256sum "$file" | cut -d' ' -f1), not $want; not using it"
  exit 1
fi
exec "$@"
