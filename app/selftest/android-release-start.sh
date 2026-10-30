#!/usr/bin/env bash
# The RELEASE APK starts on an Android emulator (.github/workflows/app-mobile-selftest.yml's
# release-starts job runs it inside reactivecircus/android-emulator-runner, with
# adb connected).  The release-only failure it looks for: R8 or LTO removing
# something Tauri/WRY reach only through JNI or reflection, so the app crashes
# or doesn't come up, while the debug self-test is green.  Shallow on purpose:
# release has no self-test hooks (lib.rs: debug only) and no run-as.
#   bash app/selftest/android-release-start.sh <signed release apk> <summary.md>
# Needs BT (build-tools dir, for aapt2).  Every failure ends the run with its
# own message; on any failure the app's log is printed.
set -euo pipefail
PKG=space.sagebrush.notebook
ACT=.MainActivity
APK=${1:?usage: android-release-start.sh <apk> <summary.md>}
SUMMARY=${2:?usage: android-release-start.sh <apk> <summary.md>}
: "${BT:?}"
HERE=$(cd "$(dirname "$0")" && pwd)
LOG=$(mktemp)
fail() { echo "FAIL: $*"; exit 1; }
on_exit() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "--- the log (last 300 lines: the app, AndroidRuntime, ActivityTaskManager, WebView and chromium)"
    adb logcat -d -v threadtime 2>/dev/null | grep -E "$PKG|AndroidRuntime|ActivityTaskManager|WebView|chromium|cr_" | tail -300 || true
  fi
  rm -f "$LOG"
}
trap on_exit EXIT
say() { echo "$*" | tee -a "$SUMMARY"; }

[ -s "$APK" ] || fail "no APK at $APK"
# (the activity this script starts is the APK's own launchable activity)
"$BT/aapt2" dump badging "$APK" > /tmp/release-badging.txt
grep -q "^package: name='$PKG' " /tmp/release-badging.txt || { grep -m1 '^package:' /tmp/release-badging.txt || true; fail "the APK's package is not $PKG"; }
grep -q "^launchable-activity: name='$PKG$ACT'" /tmp/release-badging.txt || { grep '^launchable-activity' /tmp/release-badging.txt || true; fail "the APK's launchable activity is not $PKG$ACT"; }
say "release APK: $(sha256sum "$APK" | cut -d' ' -f1)  $(basename "$APK") (this file is installed)"
say "emulator: $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r'))"

# (a fresh key can't update an install signed by another one: start clean)
if adb shell pm list packages "$PKG" | tr -d '\r' | grep -qx "package:$PKG"; then
  adb uninstall "$PKG" > /dev/null || fail "uninstall of an earlier $PKG"
fi
! adb shell pm list packages "$PKG" | tr -d '\r' | grep -qx "package:$PKG" || fail "$PKG is still installed before the install"

timeout 300 adb install "$APK" > /tmp/adb-install.log 2>&1 || { cat /tmp/adb-install.log; fail "adb install"; }
grep -q Success /tmp/adb-install.log || { cat /tmp/adb-install.log; fail "adb install did not say Success"; }
adb shell pm list packages "$PKG" | tr -d '\r' | grep -qx "package:$PKG" || fail "$PKG is not installed after the install"
adb shell dumpsys package "$PKG" | tr -d '\r' > /tmp/release-package.txt
grep -q 'pkgFlags=\[' /tmp/release-package.txt || fail "no package record (pkgFlags) for $PKG"
if grep 'pkgFlags=\[' /tmp/release-package.txt | grep -q DEBUGGABLE; then fail "the installed $PKG is debuggable"; fi
say "ok: installed, not debuggable"

provider=$(adb shell dumpsys webviewupdate | tr -d '\r' | sed -n 's/^.*Current WebView package (name, version): (\([A-Za-z0-9_.]*\), .*$/\1/p' | head -1)
[ -n "$provider" ] || { adb shell dumpsys webviewupdate | head -20; fail "no WebView provider package in dumpsys webviewupdate"; }
say "WebView provider: $provider"

adb logcat -c
out=$(timeout 120 adb shell am start -W -n "$PKG/$ACT" | tr -d '\r') || fail "am start"
echo "$out"
echo "$out" | grep -q 'Status: ok' || fail "the activity did not start"
pid=$(adb shell pidof "$PKG" | tr -d '\r')
[[ "$pid" =~ ^[0-9]+$ ]] || fail "no single process for $PKG after start ('$pid')"
sleep 30
now=$(adb shell pidof "$PKG" | tr -d '\r' || true)
[ "$now" = "$pid" ] || fail "$PKG is not the same process 30 s later (pid $pid, now '$now')"
# (a WebView renderer: Chromium starts one only when a page loads; the name
# may have a suffix, so a prefix)
renderers=$(adb shell ps -A -o NAME | tr -d '\r' | grep -c "^$provider:sandboxed_process") || [ $? = 1 ]
[ "$renderers" -gt 0 ] || { adb shell ps -A -o PID,NAME | grep -E "$provider|$PKG" || true; fail "no $provider:sandboxed_process renderer while $PKG runs"; }
now=$(adb shell pidof "$PKG" | tr -d '\r' || true)
[ "$now" = "$pid" ] || fail "$PKG died while looking for its renderer (pid $pid, now '$now')"

adb logcat -d -v threadtime > "$LOG"
grep -q "ActivityTaskManager: Displayed $PKG/$ACT" "$LOG" || fail "no 'Displayed $PKG/$ACT' in the log"
python3 -I "$HERE/logcat-crash.py" "$LOG" "$PKG" "$pid" || fail "the app crashed or failed to link (above)"
say "ok: started (Status ok, Displayed), the same pid $pid after 30 s, $renderers WebView renderer(s), no crash or link/class error"
{
  echo "the app's chromium/WebView log lines (information):"
  echo '```'
  awk -v p="$pid" '$3 == p' "$LOG" | grep -E 'chromium|cr_|WebView' | tail -40 || true
  echo '```'
} >> "$SUMMARY"
echo "ok: the release APK starts on the emulator"
