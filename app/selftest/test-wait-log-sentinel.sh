#!/usr/bin/env bash
# wait-log-sentinel.sh with a stub adb (PATH first): the sentinel arriving on
# the 3rd poll passes; never arriving fails at the deadline; under another pid
# only fails; a changed process, a failing logcat and bad arguments fail.
#   bash app/selftest/test-wait-log-sentinel.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
N=11111111-2222-4333-8444-555555555555
mkdir "$T/bin"
# the stub: `adb shell pidof` prints $PIDOF; `adb logcat -d ...` counts its calls and,
# from call $APPEAR on, includes the sentinel under pid $SPID ($LOGCAT_FAIL=1: exits 1)
cat > "$T/bin/adb" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "shell pidof") echo "$PIDOF" ;;
  "logcat -d")
    [ "${LOGCAT_FAIL:-0}" = 1 ] && exit 1
    n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE"
    echo "10-31 01:20:01.000  4242  4243 I RustStdout: [page] terminal bridge probe: page $NONCE"
    [ "$n" -ge "$APPEAR" ] && echo "10-31 01:20:02.000  $SPID  4243 I RustStdout: [page] terminal bridge probe: done $NONCE"
    true ;;
  *) echo "stub adb: unexpected $*" >&2; exit 9 ;;
esac
EOF
chmod +x "$T/bin/adb"
bad=0
run() {  # want, label, SECONDS, PIDOF, APPEAR, SPID, LOGCAT_FAIL, [PID]
  local want=$1 label=$2 rc=0; rm -f "$T/state"
  PATH="$T/bin:$PATH" STATE="$T/state" NONCE=$N PIDOF=$4 APPEAR=$5 SPID=$6 LOGCAT_FAIL=$7 \
    bash "$HERE/wait-log-sentinel.sh" "$3" space.sagebrush.notebook "${8:-4242}" "$N" "$T/out" > "$T/msg" 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $label -> $rc: $(tail -1 "$T/msg")"; else echo "FAIL $label -> $rc, expected $want:"; cat "$T/msg"; bad=1; fi
}
run 0 "the sentinel on the 3rd poll" 5 4242 3 4242 0
run 1 "never: the deadline (2 s)" 2 4242 99 4242 0
run 1 "only under another pid" 2 4242 1 5151 0
run 1 "the process changed" 5 4343 1 4242 0
run 1 "logcat -d fails" 5 4242 1 4242 1
run 2 "a bad pid" 5 4242 1 4242 0 x42
# (the capture the reader gets is the last one, with the sentinel)
run 0 "the sentinel at once" 0 4242 1 4242 0
grep -q -F "terminal bridge probe: done $N" "$T/out" || { echo "FAIL: OUT is not the capture with the sentinel"; bad=1; }
[ "$bad" = 0 ] || { echo "FAIL: wait-log-sentinel.sh"; exit 1; }
echo "ok: wait-log-sentinel.sh gives every case its expected result"
