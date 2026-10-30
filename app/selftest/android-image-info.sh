#!/usr/bin/env bash
# Which system image and WebView this emulator leg runs on (app-mobile-selftest.yml's
# emulator job, before the self-test, with adb connected):
#   bash app/selftest/android-image-info.sh <api-level> <summary.md>
# The booted image must be the leg's (ro.build.version.sdk == the api-level's
# major, so a runner that booted something else fails here); its source.properties
# revision and the WebView provider/version go to the summary, with the closed
# reading of "current": WebView major >= 145 (Chromium 145, about Feb 2026).
set -euo pipefail
LEVEL=${1:?usage: android-image-info.sh <api-level> <summary.md>}
SUMMARY=${2:?usage: android-image-info.sh <api-level> <summary.md>}
THRESHOLD=145
fail() { echo "FAIL: $*"; exit 1; }
say() { echo "$*" | tee -a "$SUMMARY"; }
want=${LEVEL%%.*}
[[ "$want" =~ ^[0-9]+$ ]] || fail "api-level '$LEVEL' has no numeric major"
sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
[ "$sdk" = "$want" ] || fail "the booted image is API $sdk, not $want (api-level $LEVEL)"
props="${ANDROID_HOME:?}/system-images/android-$LEVEL/google_apis/x86_64/source.properties"
[ -f "$props" ] || fail "no $props"
rev=$(sed -n 's/^Pkg.Revision=//p' "$props" | tr -d '\r')
[ -n "$rev" ] || fail "no Pkg.Revision in $props"
line=$(adb shell dumpsys webviewupdate | tr -d '\r' | grep -m1 'Current WebView package (name, version):' || true)
provider=$(echo "$line" | sed -n 's/^.*: (\([A-Za-z0-9_.]*\), \([0-9][0-9.]*\)).*$/\1/p')
version=$(echo "$line" | sed -n 's/^.*: (\([A-Za-z0-9_.]*\), \([0-9][0-9.]*\)).*$/\2/p')
[ -n "$provider" ] && [ -n "$version" ] || fail "no WebView provider/version in dumpsys webviewupdate: '$line'"
major=${version%%.*}
if [ "$major" -ge "$THRESHOLD" ]; then verdict=current; else verdict=old; fi
say "system image: system-images;android-$LEVEL;google_apis;x86_64 Pkg.Revision $rev (API $sdk)"
say "WebView $version ($provider): $verdict against threshold $THRESHOLD"
