#!/usr/bin/env bash
# The app's self-test on an Android emulator (.github/workflows/app-mobile-selftest.yml
# runs it inside reactivecircus/android-emulator-runner, with adb connected):
# install the debug APK, put the self-test notebook in the app's own files
# directory (run-as: debuggable APKs only), start the app, wait for its report
# (the debug-only hooks in app/src-tauri/src/lib.rs), and judge it
# (app/selftest/android-report.py).  Every failure ends the run with its own
# message; on any failure the app's log is printed.
#   bash app/selftest/android-selftest.sh <apk> [summary.md]
set -euo pipefail
PKG=space.sagebrush.notebook
APK=${1:?usage: android-selftest.sh <apk> [summary.md]}
SUMMARY=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)
REPORT=$(mktemp)
fail() { echo "FAIL: $*"; exit 1; }
on_exit() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "--- the app's log (last 400 lines: the app, WebView and chromium tags)"
    adb logcat -d -t 4000 2>/dev/null | grep -E "$PKG|chromium|WebView|Tauri|RustStdout|AndroidRuntime" | tail -400 || true
  fi
  rm -f "$REPORT"
}
trap on_exit EXIT

[ -f "$APK" ] || fail "no APK at $APK"
echo "emulator: $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r')), WebView $(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 -oE 'Current WebView package.*' | tr -d '\r')"

adb install -r "$APK" > /tmp/adb-install.log 2>&1 || { cat /tmp/adb-install.log; fail "adb install"; }
grep -q Success /tmp/adb-install.log || { cat /tmp/adb-install.log; fail "adb install did not say Success"; }

adb shell run-as "$PKG" mkdir -p files/selftest || fail "run-as mkdir (is the APK debuggable?)"
for f in selftest.ipynb data.csv; do
  adb exec-in run-as "$PKG" sh -c "cat > files/selftest/$f" < "$HERE/$f" || fail "run-as copy of $f"
  want=$(wc -c < "$HERE/$f" | tr -d ' ')
  got=$(adb shell run-as "$PKG" wc -c "files/selftest/$f" | tr -d '\r' | awk '{print $1}')
  [ "$got" = "$want" ] || fail "run-as copy of $f: $got bytes in the app, $want here"
done
adb shell run-as "$PKG" rm -f files/selftest/report.txt files/selftest/report.txt.tmp || fail "run-as rm of an old report"

out=$(adb shell am start -W -n "$PKG/.MainActivity" | tr -d '\r') || fail "am start"
echo "$out"
echo "$out" | grep -q 'Status: ok' || fail "the activity did not start"

# (the report is written whole and renamed into place by the app)
for _ in $(seq 1 300); do
  if adb shell run-as "$PKG" cat files/selftest/report.txt > "$REPORT" 2>/dev/null && [ -s "$REPORT" ]; then break; fi
  : > "$REPORT"
  sleep 1
done
[ -s "$REPORT" ] || fail "no self-test report after 300 s"
tr -d '\r' < "$REPORT" > "$REPORT.clean" && mv "$REPORT.clean" "$REPORT"
echo "--- report"
cat "$REPORT"
echo "---"
python3 -I "$HERE/android-report.py" "$REPORT" ${SUMMARY:+"$SUMMARY"} || fail "the self-test's required checks (see above)"
echo "ok: the Android self-test's required checks passed"
