#!/usr/bin/env bash
# Wait, bounded, until the app's log holds the terminal bridge probe's done
# sentinel for this run, from the app's own process (app/selftest/android-selftest.sh,
# before probe-log.py reads the log; NC-R1-A2).  Each poll re-checks that
# the app is still the same process and that the capture itself worked; the
# capture written last to OUT is the one probe-log.py reads.
#   bash app/selftest/wait-log-sentinel.sh SECONDS PACKAGE PID NONCE OUT
# Exit 0: found; 1: the deadline passed, the process changed, or a capture failed.
set -euo pipefail
[ $# = 5 ] || { echo "usage: wait-log-sentinel.sh SECONDS PACKAGE PID NONCE OUT"; exit 2; }
SECONDS_MAX=$1 PKG=$2 PID=$3 NONCE=$4 OUT=$5
[[ "$SECONDS_MAX" =~ ^[0-9]+$ && "$PID" =~ ^[0-9]+$ ]] || { echo "usage: SECONDS and PID must be numbers"; exit 2; }
want="[page] terminal bridge probe: done $NONCE"
for ((i = 0; i <= SECONDS_MAX; i++)); do
  now=$(adb shell pidof "$PKG" | tr -d '\r' || true)
  [ "$now" = "$PID" ] || { echo "FAIL: the app's process changed while waiting for the done sentinel (pid $PID, now '$now')"; exit 1; }
  adb logcat -d -v threadtime > "$OUT" 2>/dev/null || { echo "FAIL: logcat -d failed while waiting for the done sentinel"; exit 1; }
  # (the threadtime pid column is the 3rd field; the message is the line's tail)
  if awk -v p="$PID" -v w="$want" '$3 == p && index($0, ": " w) > 0 && substr($0, length($0) - length(w) + 1) == w { f = 1 } END { exit !f }' "$OUT"; then
    echo "ok: the done sentinel is in pid $PID's log after ${i} s"
    exit 0
  fi
  [ "$i" = "$SECONDS_MAX" ] || sleep 1
done
echo "FAIL: no done sentinel for $NONCE in pid $PID's log within $SECONDS_MAX s"
exit 1
