#!/usr/bin/env bash
# The app's self-test on an iOS simulator (.github/workflows/app-ios-selftest.yml),
# one created device per run, used by its UDID throughout (never "booted"),
# shut down and deleted at exit (only that device):
# - debug:   put the self-test notebook in the app's Documents/selftest (the
#            debug-only hook in app/src-tauri/src/lib.rs), start the app, wait
#            for its report and judge it (android-report.py; the report format
#            is shared), then read its diagnosis (coi-reading.py, --no-logcat);
# - release: the same notebook in the same place, but a release build must
#            NOT pick it up: after 60 s there is no report, the notebook is
#            byte-identical, and the app is still running (so the absence is
#            not a crash).
# Every wait is bounded and every failure names itself.
#   bash app/selftest/ios-selftest.sh debug|release <the .app> [summary.md]
# with DEVTYPE and RUNTIME (simctl identifiers) in the environment.
set -euo pipefail
MODE=${1:?usage: ios-selftest.sh debug|release <app> [summary.md]}
APP=${2:?usage: ios-selftest.sh debug|release <app> [summary.md]}
SUMMARY=${3:-}
BUNDLE=space.sagebrush.notebook
HERE=$(cd "$(dirname "$0")" && pwd)
: "${DEVTYPE:?DEVTYPE (a simctl device type identifier)}" "${RUNTIME:?RUNTIME (a simctl runtime identifier)}"
case "$MODE" in debug|release) ;; *) echo "FAIL: unknown mode '$MODE'"; exit 1;; esac
fail() { echo "FAIL ($MODE): $*"; exit 1; }
[ -d "$APP" ] || fail "no app at $APP"

UDID=""
T=$(mktemp -d)
on_exit() {
  local rc=$?
  if [ "$rc" != 0 ] && [ -n "$UDID" ]; then
    echo "--- the app's log (last 5 minutes, at most 200 kB)"
    xcrun simctl spawn "$UDID" log show --last 5m --style compact --predicate 'process == "Sagebrush"' 2>/dev/null | head -c 200000 || true
  fi
  if [ -n "$UDID" ]; then
    xcrun simctl shutdown "$UDID" > /dev/null 2>&1 || true
    xcrun simctl delete "$UDID" > /dev/null 2>&1 || true
    echo "(deleted the simulator $UDID)"
  fi
  rm -rf "$T"
}
trap on_exit EXIT

# (the bundle is the app's own)
got=$(plutil -extract CFBundleIdentifier raw "$APP/Info.plist") || fail "no CFBundleIdentifier in $APP/Info.plist"
[ "$got" = "$BUNDLE" ] || fail "the app is '$got', not $BUNDLE"

out=$(xcrun simctl create "sb-selftest-${GITHUB_RUN_ID:-local}-$MODE" "$DEVTYPE" "$RUNTIME" 2>&1) || fail "simctl create: $out"
UDID=$(python3 -I "$HERE/ios-judge.py" udid "$out") || fail "simctl create gave no UDID: $out"
echo "simulator: $UDID ($DEVTYPE, $RUNTIME)"

xcrun simctl boot "$UDID" || fail "simctl boot"
# (bootstatus -b waits until the device has booted; bounded here: macOS has
# no timeout(1))
xcrun simctl bootstatus "$UDID" -b > "$T/bootstatus.log" 2>&1 &
bs=$!
for _ in $(seq 1 300); do kill -0 "$bs" 2> /dev/null || break; sleep 1; done
if kill -0 "$bs" 2> /dev/null; then kill "$bs" || true; tail -5 "$T/bootstatus.log"; fail "the simulator did not boot within 300 s"; fi
wait "$bs" || { tail -5 "$T/bootstatus.log"; fail "simctl bootstatus"; }

xcrun simctl install "$UDID" "$APP" || fail "simctl install"
C=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data) || fail "simctl get_app_container"
[ -d "$C" ] || fail "the app's data container '$C' is not a directory"
D="$C/Documents/selftest"
rm -rf "$D"
mkdir -p "$D"
for f in selftest.ipynb data.csv; do
  cp "$HERE/$f" "$D/$f"
  [ "$(shasum -a 256 < "$D/$f")" = "$(shasum -a 256 < "$HERE/$f")" ] || fail "the copy of $f differs"
done
before=$(shasum -a 256 < "$D/selftest.ipynb")

xcrun simctl launch "$UDID" "$BUNDLE" || fail "simctl launch"

if [ "$MODE" = debug ]; then
  # (the report is written whole and renamed into place by the app)
  for _ in $(seq 1 300); do [ -s "$D/report.txt" ] && break; sleep 1; done
  [ -s "$D/report.txt" ] || fail "no self-test report after 300 s"
  cp "$D/report.txt" "$T/report.txt"
  echo "--- report"
  cat "$T/report.txt"
  echo "---"
  python3 -I "$HERE/coi-reading.py" "$T/report.txt" --no-logcat ${SUMMARY:+--summary "$SUMMARY"} || echo "(coi-reading.py exited $?; the readings are information only)"
  python3 -I "$HERE/android-report.py" --engine webkit "$T/report.txt" ${SUMMARY:+"$SUMMARY"} || fail "the self-test's required checks (see above)"
  echo "ok: the iOS simulator self-test's required checks passed"
else
  sleep 60
  [ ! -e "$D/report.txt" ] && [ ! -e "$D/report.txt.tmp" ] || fail "the release build wrote a self-test report (the debug-only hook is in a release build)"
  [ "$(shasum -a 256 < "$D/selftest.ipynb")" = "$before" ] || fail "the release build changed the self-test notebook"
  xcrun simctl spawn "$UDID" launchctl list > "$T/launchctl.txt" 2>&1 || fail "simctl spawn launchctl list"
  python3 -I "$HERE/ios-judge.py" running "$T/launchctl.txt" "$BUNDLE" || fail "the release app is not running after 60 s (its absence of a report proves nothing then)"
  line="release build: no self-test report after 60 s, the notebook unchanged, and the app still running"
  echo "ok: $line"
  [ -z "$SUMMARY" ] || printf -- '- %s\n' "$line" >> "$SUMMARY"
fi
