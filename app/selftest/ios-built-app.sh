#!/usr/bin/env bash
# After an iOS simulator build (.github/workflows/app-ios-selftest.yml):
# 1. gen/apple changed in the one allowed way only (ios-judge.py tree: the
#    Tauri CLI's merge of Info.ios.plist into sagebrush-app_iOS/Info.plist);
# 2. exactly one .app was built by it for this configuration, for the
#    simulator (its path says <debug|release>-iphonesimulator), and the Rust
#    library Xcode linked was built for this configuration, not the other
#    (gen/apple/Externals/<arch>/<debug|release>/libapp.a newer than the
#    build's start): the two independent signs of which build this is;
# 3. the built app's own Info.plist has Info.ios.plist's settings exactly
#    (typed, nested) and no encryption declaration (ios-judge.py bundle):
#    what the app runs with, not only the source;
# 4. it is unsigned: no embedded.mobileprovision, and codesign shows either
#    "not signed at all" alone or an ad hoc signature without a team or
#    certificate (ios-judge.py codesign).
# Writes the .app's path to OUT.  When step 1 fails, it prints what changed
# (git diff --stat, and each changed file's diff, cut at 20000 bytes) and
# leaves the whole diff in $DIFF_DIR/gen-apple-<mode>.diff (DIFF_DIR, default
# $RUNNER_TEMP), which the workflow keeps as an artifact.
#   bash app/selftest/ios-built-app.sh debug|release <start stamp file> <out>
set -euo pipefail
MODE=${1:?usage: ios-built-app.sh debug|release <start stamp> <out>}
START=${2:?usage: ios-built-app.sh debug|release <start stamp> <out>}
OUT=${3:?usage: ios-built-app.sh debug|release <start stamp> <out>}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
GEN=app/src-tauri/gen/apple
case "$MODE" in debug) OTHER=release;; release) OTHER=debug;; *) echo "FAIL: unknown mode '$MODE'"; exit 1;; esac
fail() { echo "FAIL ($MODE build): $*"; exit 1; }
[ -f "$START" ] || fail "no start stamp $START"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cd "$ROOT"

# 1. the tree
git status --porcelain --untracked-files=all -- "$GEN" > "$T/status.txt"
echo "--- gen/apple after the build:"; cat "$T/status.txt"
git show "HEAD:$GEN/sagebrush-app_iOS/Info.plist" > "$T/generated.plist"
if ! python3 -I "$HERE/ios-judge.py" tree "$T/status.txt" "$T/generated.plist" "$GEN/sagebrush-app_iOS/Info.plist" app/src-tauri/Info.ios.plist; then
  D=${DIFF_DIR:-${RUNNER_TEMP:-$T}}
  mkdir -p "$D"
  git diff -- "$GEN" > "$D/gen-apple-$MODE.diff" || true
  echo "--- what the build changed under gen/apple (the whole diff: $D/gen-apple-$MODE.diff, $(wc -c < "$D/gen-apple-$MODE.diff") bytes)"
  git diff --stat -- "$GEN" || true
  while IFS= read -r f; do
    echo "--- $f (at most 20000 bytes)"
    git diff -- "$f" | head -c 20000 || true
  done < <(git diff --name-only -- "$GEN")
  fail "gen/apple after the build (above)"
fi

# 2. the .app and the library, for this configuration
find "$GEN/build" "$HOME/Library/Developer/Xcode/DerivedData" -type d -name '*.app' -newer "$START" 2> /dev/null | LC_ALL=C sort > "$T/apps.txt" || true
grep -i -- "/$MODE-iphonesimulator/" "$T/apps.txt" > "$T/mine.txt" || true
n=$(wc -l < "$T/mine.txt" | tr -d ' ')
[ "$n" = 1 ] || { echo "--- .app bundles built since the start:"; cat "$T/apps.txt"; fail "expected exactly one $MODE-iphonesimulator .app, found $n"; }
APP=$(cat "$T/mine.txt")
if grep -i -q -- "/$OTHER-iphonesimulator/" "$T/apps.txt"; then cat "$T/apps.txt"; fail "a $OTHER .app was built too"; fi
find "$GEN/Externals" -name libapp.a -newer "$START" 2> /dev/null | LC_ALL=C sort > "$T/libs.txt" || true
echo "--- libapp.a built since the start:"; cat "$T/libs.txt"
grep -q -- "/$MODE/libapp.a$" "$T/libs.txt" || fail "no $MODE libapp.a was built (gen/apple/Externals/<arch>/$MODE/)"
if grep -q -- "/$OTHER/libapp.a$" "$T/libs.txt"; then fail "a $OTHER libapp.a was built by this $MODE build"; fi
echo "ok: the $MODE simulator app: $APP"

# 3. the built app's Info.plist
python3 -I "$HERE/ios-judge.py" bundle "$APP/Info.plist" app/src-tauri/Info.ios.plist || fail "the built app's Info.plist (above)"

# 4. unsigned
[ ! -e "$APP/embedded.mobileprovision" ] || fail "the app has an embedded.mobileprovision"
codesign -dv "$APP" > "$T/codesign.txt" 2>&1 || true
cat "$T/codesign.txt"
python3 -I "$HERE/ios-judge.py" codesign "$T/codesign.txt" || fail "the app is signed with an identity (above)"
printf '%s\n' "$APP" > "$OUT"
