#!/usr/bin/env bash
# The app's self-test on an Android emulator (.github/workflows/app-mobile-selftest.yml
# runs it inside reactivecircus/android-emulator-runner, with adb connected):
# install the debug APK, put the self-test notebook in the app's own files
# directory (run-as: debuggable APKs only), start the app, wait for its report
# (the debug-only hooks in app/src-tauri/src/lib.rs), and judge it
# (app/selftest/android-report.py), then the terminal bridge probe's native
# witness in the app's own log lines (app/selftest/probe-log.py: the page's
# markers once each, no worker line; DEBUG-ONLY evidence, as the self-test).
# Every failure ends the run with its own message; on any failure the app's
# log is printed.
#   bash app/selftest/android-selftest.sh <apk> [summary.md]
set -euo pipefail
PKG=space.sagebrush.notebook
APK=${1:?usage: android-selftest.sh <apk> [summary.md]}
SUMMARY=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)
REPORT=$(mktemp)
LOGC=$(mktemp)
PLOG=$(mktemp)
fail() { echo "FAIL: $*"; exit 1; }
on_exit() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "--- the app's log (last 400 lines: the app, WebView and chromium tags)"
    adb logcat -d -t 4000 2>/dev/null | grep -E "$PKG|chromium|WebView|Tauri|RustStdout|AndroidRuntime" | tail -400 || true
  fi
  rm -f "$REPORT" "$LOGC" "$PLOG"
}
trap on_exit EXIT

[ -f "$APK" ] || fail "no APK at $APK"
echo "emulator: $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r')), WebView $(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 -oE 'Current WebView package.*' | tr -d '\r')"

adb install -r "$APK" > /tmp/adb-install.log 2>&1 || { cat /tmp/adb-install.log; fail "adb install"; }
grep -q Success /tmp/adb-install.log || { cat /tmp/adb-install.log; fail "adb install did not say Success"; }

adb shell run-as "$PKG" mkdir -p files/selftest || fail "run-as mkdir (is the APK debuggable?)"
for f in selftest.ipynb data.csv; do
  # adb joins its arguments into one device-shell line, so a "cat > file" piped
  # through run-as gets its redirect applied by the shell user (first attempt:
  # 0 bytes). Push to the world-readable /data/local/tmp, then copy as the app.
  adb push "$HERE/$f" "/data/local/tmp/sagebrush-$f" > /dev/null || fail "adb push of $f"
  adb shell run-as "$PKG" cp "/data/local/tmp/sagebrush-$f" "files/selftest/$f" || fail "run-as copy of $f"
  adb shell rm -f "/data/local/tmp/sagebrush-$f"
  want=$(wc -c < "$HERE/$f" | tr -d ' ')
  got=$(adb shell run-as "$PKG" wc -c "files/selftest/$f" | tr -d '\r' | awk '{print $1}')
  [ "$got" = "$want" ] || fail "run-as copy of $f: $got bytes in the app, $want here"
done
adb shell run-as "$PKG" rm -f files/selftest/report.txt files/selftest/report.txt.tmp || fail "run-as rm of an old report"
# (a log buffer big enough for the whole self-test, and only this run's
# lines in it: a wrapped buffer would lose the early markers)
adb logcat -G 16M || fail "logcat -G 16M"
echo "logcat buffers: $(adb logcat -g | tr -d '\r' | tr '\n' ';')"
adb logcat -c || fail "logcat -c"

out=$(adb shell am start -W -n "$PKG/.MainActivity" | tr -d '\r') || fail "am start"
echo "$out"
echo "$out" | grep -q 'Status: ok' || fail "the activity did not start"
pid=$(adb shell pidof "$PKG" | tr -d '\r' || true)
[[ "$pid" =~ ^[0-9]+$ ]] || fail "no single process for $PKG after start ('$pid')"

# (the report is written whole and renamed into place by the app)
for _ in $(seq 1 300); do
  if adb shell run-as "$PKG" cat files/selftest/report.txt > "$REPORT" 2>/dev/null && [ -s "$REPORT" ]; then break; fi
  : > "$REPORT"
  sleep 1
done
[ -s "$REPORT" ] || fail "no self-test report after 300 s"
tr -d '\r' < "$REPORT" > "$REPORT.clean" && mv "$REPORT.clean" "$REPORT"
# (selftest_report ends with app.exit (lib.rs), so the app may already be gone:
# empty is the designed exit; any OTHER pid is a restart, so its log can't be
# read as one run.  The report above and, below, the sentinel and every marker
# must come from the start pid's own lines, so an early crash still fails.)
now=$(adb shell pidof "$PKG" | tr -d '\r' || true)
[ "$now" = "$pid" ] || [ -z "$now" ] || fail "the app's process changed during the self-test (pid $pid, now '$now'): its log can't be read as one run"
echo "--- report"
cat "$REPORT"
echo "---"
# (the diagnosis of cross-origin isolation, information only: the debug
# build's server lines and the page's start line, which reaches the log the
# same way (eprintln), at most 60 lines, then the readings, coi-reading.py)
adb logcat -d 2>/dev/null | grep -a -F -e '[localhost]' -e '[page] start' | head -60 > "$LOGC" || true
echo "--- the app's server log ([localhost] and [page] start lines, at most 60)"
cat "$LOGC"
n_req=$(grep -a -c -F '[localhost] #' "$LOGC" || true)
has() { if grep -a -q -F "$1" "$LOGC"; then echo yes; else echo no; fi; }
line="server log: $n_req request lines; logger start: $(has '[localhost] logger start'); [page] start: $(has '[page] start'); cap reached: $(has '[localhost] cap reached')"
echo "$line"
[ -z "$SUMMARY" ] || printf '%s\n\n' "$line" >> "$SUMMARY"
python3 -I "$HERE/coi-reading.py" "$REPORT" --logcat "$LOGC" ${SUMMARY:+--summary "$SUMMARY"} || echo "(coi-reading.py exited $?; the readings are information only)"
python3 -I "$HERE/android-report.py" --engine chromium "$REPORT" ${SUMMARY:+"$SUMMARY"} || fail "the self-test's required checks (see above)"
# (the nonce is the page's, from its check-2 line; probe-log.py checks that line itself)
nonce=$(sed -n "s/^ok   the page reaches the app's bridge: nonce=\([0-9a-f-]*\) routes=.*/\1/p" "$REPORT" | head -1)
[ -n "$nonce" ] || fail "no ok check-2 line with a nonce in the report, so the probe's native log can't be read"
# (the page logs the done sentinel after the Terminal checks cleaned up and
# before the report, so it should already be there: wait for it, bounded,
# re-checking the process; the last capture is the one judged)
bash "$HERE/wait-log-sentinel.sh" 20 "$PKG" "$pid" "$nonce" "$PLOG" || fail "the app's log never showed the probe's done sentinel (above)"
python3 -I "$HERE/probe-log.py" --android "$PLOG" "$pid" "$nonce" "$REPORT" || fail "the terminal bridge probe's native log (above)"
echo "ok: the Android self-test's required checks passed"
