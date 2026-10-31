#!/usr/bin/env bash
# One leg of app-mobile-selftest.yml's emulator job (inside the emulator-runner
# step, with adb connected):
#   bash app/selftest/android-selftest-leg.sh image   <app apk> <summary.md>
#   bash app/selftest/android-selftest-leg.sh current <app apk> <summary.md>
# image:   the image's own WebView: android-image-info.sh, then the self-test.
# current: a pinned current WebView build first (WEBVIEW_APK and
#          WEBVIEW_VERSION from the workflow, both REQUIRED: the leg can't
#          quietly run on the image's WebView instead), sideloaded and selected
#          by android-sideload-webview.sh; then image-info and the self-test as
#          above; then the provider is checked again.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LEG=${1:?usage: android-selftest-leg.sh image|current <app apk> <summary.md>}
APP=${2:?app apk}
SUMMARY=${3:?summary}
case "$LEG" in
  image)
    bash "$HERE/android-image-info.sh" 34 "$SUMMARY"
    bash "$HERE/android-selftest.sh" "$APP" "$SUMMARY"
    ;;
  current)
    [ -n "${WEBVIEW_APK:-}" ] && [ -n "${WEBVIEW_VERSION:-}" ] || { echo "FAIL: the current-WebView leg has no WEBVIEW_APK/WEBVIEW_VERSION"; exit 1; }
    bash "$HERE/android-sideload-webview.sh" install "$WEBVIEW_APK" "$WEBVIEW_VERSION" "$SUMMARY"
    bash "$HERE/android-image-info.sh" 34 "$SUMMARY"
    bash "$HERE/android-selftest.sh" "$APP" "$SUMMARY"
    bash "$HERE/android-sideload-webview.sh" check "$WEBVIEW_VERSION" "$SUMMARY"
    ;;
  *) echo "FAIL: unknown leg '$LEG'"; exit 1;;
esac
