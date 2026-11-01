#!/usr/bin/env bash
# wait-log-sentinel.sh with a stub adb (PATH first): the sentinel arriving on
# the 3rd poll passes; never arriving fails at the deadline; under another pid
# only fails; a changed process, a failing logcat and bad arguments fail; and
# (NC-R2-A1) an adb that BLOCKS in pidof or in logcat -d, plain or ignoring
# TERM, fails within the deadline plus a stated cleanup allowance.  pidof is
# read as a set of whole pids after the log (run 41202232761): the app's pid
# with a helper passes, a helper or another pid without it fails, and a hung
# ps (the information print) doesn't stop the wait.  The outer watchdog here
# only guards the test: if it fires, the case FAILs.
#   bash app/selftest/test-wait-log-sentinel.sh
#   WAIT_SCRIPT=<a copy> bash app/selftest/test-wait-log-sentinel.sh   (a control)
#   FAILED_OUT=<file>: each failing case's label is appended to it (for controls)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=${WAIT_SCRIPT:-$HERE/wait-log-sentinel.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
N=11111111-2222-4333-8444-555555555555
ALLOW=4      # the cleanup allowance past the deadline: timeout's -k 2, plus startup and the last poll
GUARD=20     # the outer watchdog, only a guard
mkdir "$T/bin"
# the stub: `adb shell pidof` prints $PIDOF (from its call $GONE_AFTER+1 on: nothing,
# exit 1, as after the app's designed exit); `adb logcat -d ...` counts its calls and,
# from call $APPEAR on, includes the sentinel under pid $SPID ($LOGCAT_FAIL=1: exits 1).
# `adb shell ps ...` prints a table with $PIDOF's pids.
# BLOCK=pidof|logcat|ps: that call sleeps 60 s instead; BLOCK_TERM=1: it ignores TERM too.
cat > "$T/bin/adb" <<'EOF'
#!/usr/bin/env bash
block() { [ "${BLOCK_TERM:-0}" = 1 ] && trap '' TERM; sleep 60; }
case "$1 $2" in
  "shell pidof") [ "${BLOCK:-}" = pidof ] && block
    k=$(( $(cat "$STATE.pidof" 2>/dev/null || echo 0) + 1 )); echo $k > "$STATE.pidof"
    [ "$k" -gt "${GONE_AFTER:-999}" ] && exit 1
    echo "$PIDOF" ;;
  "logcat -d")
    [ "${BLOCK:-}" = logcat ] && block
    [ "${LOGCAT_FAIL:-0}" = 1 ] && exit 1
    n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE"
    echo "10-31 01:20:01.000  4242  4243 I RustStdout: [page] terminal bridge probe: page $NONCE"
    [ "$n" -ge "$APPEAR" ] && echo "10-31 01:20:02.000  $SPID  4243 I RustStdout: [page] terminal bridge probe: done $NONCE"
    true ;;
  "shell ps") [ "${BLOCK:-}" = ps ] && block
    echo "PID PPID USER NAME ARGS"
    for p in $PIDOF; do echo "$p 300 u0_a192 space.sagebrush.notebook space.sagebrush.notebook"; done
    echo "1 0 root init /system/bin/init" ;;
  *) echo "stub adb: unexpected $*" >&2; exit 9 ;;
esac
EOF
chmod +x "$T/bin/adb"
bad=0
failed() { bad=1; [ -z "${FAILED_OUT:-}" ] || echo "$1" >> "$FAILED_OUT"; }
run() {  # want, label, SECONDS, PIDOF, APPEAR, SPID, LOGCAT_FAIL, BLOCK, BLOCK_TERM, [PID]; $TEXT: the verdict must contain it
  local want=$1 label=$2 limit=$3 rc=0 t0=$SECONDS el; rm -f "$T/state" "$T/state.pidof"
  PATH="$T/bin:$PATH" STATE="$T/state" NONCE=$N PIDOF=$4 APPEAR=$5 SPID=$6 LOGCAT_FAIL=$7 BLOCK=$8 BLOCK_TERM=$9 GONE_AFTER=${GONE_AFTER:-999} \
    timeout -k 2 "$GUARD" bash "$SCRIPT" "$limit" space.sagebrush.notebook "${10:-4242}" "$N" "$T/out" > "$T/msg" 2>&1 || rc=$?
  el=$((SECONDS - t0))
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then echo "FAIL $label: the test's watchdog fired after ${el} s (the script did not bound itself)"; failed "$label"; return; fi
  if [ "$rc" != "$want" ]; then echo "FAIL $label -> $rc, expected $want:"; cat "$T/msg"; failed "$label"; return; fi
  if [ -n "${TEXT:-}" ] && ! grep -q -F -- "$TEXT" "$T/msg"; then echo "FAIL $label -> $rc, but not for \"$TEXT\":"; cat "$T/msg"; failed "$label"; return; fi
  if [ "$el" -gt $((limit + ALLOW)) ]; then echo "FAIL $label -> $rc but after ${el} s, over ${limit} + ${ALLOW} s"; failed "$label"; return; fi
  echo "ok   $label -> $rc in ${el} s: $(tail -1 "$T/msg")"
}
#   want label                              s  pidof appear spid logcatfail block  term
run 0 "the sentinel on the 3rd poll"        5  4242  3      4242 0          ""     0
run 1 "never: the deadline (2 s)"           2  4242  99     4242 0          ""     0
run 1 "only under another pid"              2  4242  1      5151 0          ""     0
TEXT="the app's process changed" run 1 "the process changed"   5  4343  99     4242 0          ""     0
# (the log is read first: a sentinel from PID's own lines is the proof)
run 0 "the sentinel present; pidof shows only another pid"      5  4343  1      4242 0          ""     0
# (pidof as a set of whole pids)
run 0 "pidof prints nothing (exit 0)"                           5  ""    3      4242 0          ""     0
TEXT="pidof lists more" run 0 "the app plus a helper; the sentinel on the 3rd poll" 5 "4242 4888" 3 4242 0 "" 0
TEXT="the app's process changed" run 1 "a helper only (the app gone), no sentinel" 5 4888 99 4242 0 "" 0
TEXT="the app's process changed" run 1 "pid 37, pidof 3792 (whole words)"       5  3792  99     37   0          ""     0  37
TEXT="no done sentinel" run 1 "the app plus a new pid; the sentinel only from the new one" 2 "4242 5151" 1 5151 0 "" 0
TEXT="isn't pids" run 1 "pidof prints something else"          5  abc   99     4242 0          ""     0
TEXT="ps failed or did not finish" run 0 "a helper, and ps hangs ignoring TERM: the wait goes on" 8 "4242 4888" 3 4242 0 ps 1
run 1 "logcat -d fails"                     5  4242  1      4242 1          ""     0
run 2 "a bad pid"                           5  4242  1      4242 0          ""     0  x42
TEXT="adb shell pidof did not finish" run 1 "adb pidof blocks"                    3  4242  99      4242 0          pidof  0
TEXT="adb shell pidof did not finish" run 1 "adb pidof blocks, ignoring TERM"     3  4242  99      4242 0          pidof  1
TEXT="adb logcat -d did not finish" run 1 "adb logcat -d blocks"                3  4242  1      4242 0          logcat 0
TEXT="adb logcat -d did not finish" run 1 "adb logcat -d blocks, ignoring TERM" 3  4242  1      4242 0          logcat 1
# (the app exits by design after its report: no process passes the re-check,
# the log outlives it; another pid still FAILs, above "the process changed")
GONE_AFTER=1 run 0 "the app exits after the 1st poll; the sentinel on the 3rd" 5  4242  3      4242 0          ""     0
GONE_AFTER=0 run 0 "the app already gone; the sentinel in the log"            5  4242  1      4242 0          ""     0
GONE_AFTER=1 run 1 "the app gone and no sentinel: the deadline"               2  4242  99     4242 0          ""     0
# (the capture the reader gets is the last one, with the sentinel)
run 0 "the sentinel at once"                0  4242  1      4242 0          ""     0
grep -q -F "terminal bridge probe: done $N" "$T/out" || { echo "FAIL: OUT is not the capture with the sentinel"; bad=1; }
[ "$bad" = 0 ] || { echo "FAIL: wait-log-sentinel.sh"; exit 1; }
echo "ok: wait-log-sentinel.sh gives every case its expected result"
