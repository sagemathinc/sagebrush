#!/usr/bin/env bash
# Wait, bounded, until the app's log holds the terminal bridge probe's done
# sentinel for this run, from the app's own process (app/selftest/android-selftest.sh,
# before probe-log.py reads the log; NC-R1-A2).  Each poll re-checks that
# the app is still the same process and that the capture itself worked; the
# capture written last to OUT is the one probe-log.py reads.
# The bound is wall time (NC-R2-A1): every adb call runs under `timeout -k`
# with the time that remains, and writes to a file (never a pipe a lingering
# child could hold open), so a hung adb fails the wait instead of blocking it.
#   bash app/selftest/wait-log-sentinel.sh SECONDS PACKAGE PID NONCE OUT
# Exit 0: found; 1: the deadline passed, an adb call timed out or failed, or
# the process changed (another pid; no process at all is the app's designed
# exit after its report, and passes the re-check); 2: bad arguments.
set -euo pipefail
[ $# = 5 ] || { echo "usage: wait-log-sentinel.sh SECONDS PACKAGE PID NONCE OUT"; exit 2; }
LIMIT=$1 PKG=$2 PID=$3 NONCE=$4 OUT=$5
[[ "$LIMIT" =~ ^[0-9]+$ && "$PID" =~ ^[0-9]+$ ]] || { echo "usage: SECONDS and PID must be numbers"; exit 2; }
want="[page] terminal bridge probe: done $NONCE"
T=$(mktemp); trap 'rm -f "$T"' EXIT
exec 3>&1   # (verdicts go to fd 3: the adb calls' own stdout/stderr are redirected to files)
deadline=$((SECONDS + LIMIT))
left() { local r=$((deadline - SECONDS)); [ "$r" -ge 1 ] && echo "$r" || echo 1; }
bounded() {  # what, then the command: run it under the time that remains; 0, or FAIL on a timeout or an error
  local what=$1 rc=0; shift
  timeout -k 2 "$(left)" "$@" || rc=$?
  case $rc in
    0) return 0 ;;
    124 | 137) echo "FAIL: $what did not finish before the ${LIMIT} s deadline" >&3; exit 1 ;;
    *) return "$rc" ;;
  esac
}
while :; do
  rc=0; bounded "adb shell pidof" adb shell pidof "$PKG" > "$T" 2>/dev/null || rc=$?
  now=$(tr -d '\r\n' < "$T")
  # (the app exits by design after its report (lib.rs selftest_report): no
  # process is fine, the log outlives it; another pid is a restart and FAILs)
  [ "$now" = "$PID" ] || [ -z "$now" ] || { echo "FAIL: the app's process changed while waiting for the done sentinel (pid $PID, now '$now', pidof exit $rc)"; exit 1; }
  bounded "adb logcat -d" adb logcat -d -v threadtime > "$OUT" 2>/dev/null || { echo "FAIL: logcat -d failed while waiting for the done sentinel"; exit 1; }
  # (the threadtime pid column is the 3rd field; the message is the line's tail)
  if awk -v p="$PID" -v w="$want" '$3 == p && index($0, ": " w) > 0 && substr($0, length($0) - length(w) + 1) == w { f = 1 } END { exit !f }' "$OUT"; then
    echo "ok: the done sentinel is in pid $PID's log after $((SECONDS - deadline + LIMIT)) s"
    exit 0
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep 1
done
echo "FAIL: no done sentinel for $NONCE in pid $PID's log within $LIMIT s"
exit 1
