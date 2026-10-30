#!/usr/bin/env bash
# verify-then.sh, the gate for the pinned WebView download: with the right hash
# the command runs; with a wrong one, a malformed one or a missing file it
# fails and the command (a marker file standing in for unzip/install) is NOT
# reached.  This is the wrong-hash negative control, on a small fixture, through
# the same script the workflow uses on the real download.
#   bash app/selftest/test-verify-then.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FIX="$HERE/verify-fixture.txt"
GOOD=$(sha256sum "$FIX" | cut -d' ' -f1)
WRONG=$(printf '%s' "$GOOD" | tr '0-9a-f' '1-9a-f0')
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
bad=0
run() {
  local name=$1 want=$2 marker=$3; shift 3
  local rc=0; rm -f "$T/ran"
  bash "$HERE/verify-then.sh" "$@" -- touch "$T/ran" > "$T/out" 2>&1 || rc=$?
  local ran=no; [ -e "$T/ran" ] && ran=yes
  if [ "$rc" = "$want" ] && [ "$ran" = "$marker" ]; then echo "ok   $name -> rc $rc, command ran: $ran"
  else echo "FAIL $name -> rc $rc (want $want), command ran: $ran (want $marker):"; cat "$T/out"; bad=1; fi
}
run "right hash" 0 yes "$GOOD" "$FIX"
run "wrong hash" 1 no "$WRONG" "$FIX"
run "uppercase hash" 2 no "$(printf '%s' "$GOOD" | tr a-f A-F)" "$FIX"
run "short hash" 2 no "${GOOD:0:63}" "$FIX"
run "missing file" 1 no "$GOOD" "$T/no-such-file"
[ "$WRONG" != "$GOOD" ] || { echo "FAIL: the wrong hash equals the right one"; bad=1; }
[ "$bad" = 0 ] || { echo "FAIL: verify-then.sh"; exit 1; }
echo "ok: verify-then.sh runs the command only on the exact hash"
