#!/usr/bin/env bash
# The current-WebView leg of app-mobile-selftest.yml's emulator job: put a
# pinned, already-verified WebView build (Chromium's SystemWebView.apk, package
# com.android.webview) on the API 34 google_apis emulator and make it the
# provider, before android-image-info.sh and android-selftest.sh run; then,
# after them, check the provider again.  Runs inside the emulator-runner step,
# with adb connected.
#   bash app/selftest/android-sideload-webview.sh install <apk> <version> <summary.md>
#   bash app/selftest/android-sideload-webview.sh check <version> <summary.md>
# <version> is the APK's own versionName (aapt2 dump badging on the verified
# APK, in the workflow); the provider must be exactly that package at exactly
# that version (app/selftest/webview-provider.py), so a silent fallback to the
# image's WebView can't count.  Every failure ends the run with its message.
set -euo pipefail
PKG=com.android.webview
HERE=$(cd "$(dirname "$0")" && pwd)
fail() { echo "FAIL: $*"; exit 1; }
say() { echo "$*" | tee -a "$SUMMARY"; }
provider() {
  adb shell dumpsys webviewupdate | tr -d '\r' > /tmp/webviewupdate.txt
  python3 -I "$HERE/webview-provider.py" /tmp/webviewupdate.txt "$PKG" "$VERSION" || { sed -n '1,30p' /tmp/webviewupdate.txt; fail "the WebView provider (above) is not $PKG $VERSION"; }
}
mode=${1:?usage: android-sideload-webview.sh install <apk> <version> <summary> | check <version> <summary>}
case "$mode" in
  install)
    APK=${2:?apk}; VERSION=${3:?version}; SUMMARY=${4:?summary}
    [ -s "$APK" ] || fail "no APK at $APK"
    # (boot_completed can come before the package service: wait for it, bounded)
    for _ in $(seq 1 120); do
      adb shell service check package 2>/dev/null | tr -d '\r' | grep -q ': found$' && break
      sleep 1
    done
    adb shell service check package | tr -d '\r' | grep -q ': found$' || fail "the package service is not up after 120 s"
    # (com.android.webview is an eligible provider on GMS images only on
    # userdebug/eng builds; an eligibility rule, not a signature bypass)
    type=$(adb shell getprop ro.build.type | tr -d '\r')
    [ "$type" = userdebug ] || fail "the image is '$type', not userdebug"
    # (and not installed already: a successful query, with a positive control)
    pkgs=$(adb shell pm list packages | tr -d '\r') || fail "pm list packages"
    grep -qx 'package:android' <<<"$pkgs" || fail "pm list packages has no package:android (the query didn't work)"
    if grep -qx "package:$PKG" <<<"$pkgs"; then fail "$PKG is already installed; replacing a preinstalled provider is not this script's job"; fi
    timeout 600 adb install "$APK" > /tmp/webview-install.log 2>&1 || { cat /tmp/webview-install.log; fail "adb install of $PKG"; }
    grep -q Success /tmp/webview-install.log || { cat /tmp/webview-install.log; fail "adb install did not say Success"; }
    adb shell dumpsys package "$PKG" | tr -d '\r' > /tmp/webview-package.txt
    got=$(sed -n 's/^ *versionName=//{p;q}' /tmp/webview-package.txt)
    [ "$got" = "$VERSION" ] || fail "the installed $PKG is version '$got', not $VERSION"
    adb shell cmd webviewupdate set-webview-implementation "$PKG" | tr -d '\r' | tee /tmp/webview-set.log
    provider
    say "WebView provider set: $PKG $VERSION (sideloaded, a pinned Chromium snapshot; not a stable-channel build)"
    ;;
  check)
    VERSION=${2:?version}; SUMMARY=${3:?summary}
    provider
    say "WebView provider after the self-test: still $PKG $VERSION"
    ;;
  *) fail "unknown mode '$mode'";;
esac
