#!/usr/bin/env bash
# ios-judge.py on fixed inputs (app/selftest/ios-fixtures): each must give its
# exit code AND its outcome line (ok: / FAIL: / ERROR:), so a judge that
# accepts a signed (or contradictory) codesign report, a stopped app, an extra
# change after the build, a built app without Info.ios.plist's exact settings
# (typed: true is not 1) or with an encryption declaration, or a malformed
# UDID can't pass, and a judge that crashes (exit 3) is never taken for a
# FAIL.  Then the controls: with each rule undone in a copy of the judge, the
# fixtures must catch it.
#   bash app/selftest/test-ios-judge.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
F="$here/ios-fixtures"
JUDGE=${IOS_JUDGE:-$here/ios-judge.py}
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
bad=0
check() {  # want, then the judge's arguments
  local want=$1 rc=0 line prefix; shift
  python3 -I "$JUDGE" "$@" > "$OUT" 2>&1 || rc=$?
  line=$(head -1 "$OUT")
  case "$want" in
    0) prefix="ok: ";; 1) prefix="FAIL: ";; 2) prefix="ERROR: ";;
  esac
  # (udid's ok line is the UDID itself)
  if [ "$1" = udid ] && [ "$want" = 0 ]; then prefix=""; fi
  if [ "$rc" = "$want" ] && { [ -z "$prefix" ] || [ "${line#"$prefix"}" != "$line" ]; } && ! grep -q '^ERROR: internal' "$OUT"; then
    echo "ok   $1 ${*: -1} -> $rc"
  else
    echo "FAIL $* -> rc $rc, expected $want; first line: $line"; bad=1
  fi
}
B=space.sagebrush.notebook
check 0 udid "0F3C9A1E-5B7D-4C2A-9E81-3D6F0A2B4C5D"
check 0 udid "0F3C9A1E-5B7D-4C2A-9E81-3D6F0A2B4C5D
"
check 1 udid "0f3c9a1e-5b7d-4c2a-9e81-3d6f0a2b4c5d"
check 1 udid "0F3C9A1E-5B7D-4C2A-9E81-3D6F0A2B4C5D
1A2B3C4D-5B7D-4C2A-9E81-3D6F0A2B4C5D"
check 1 udid ""
check 1 udid "Invalid device type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
check 0 codesign "$F/codesign-adhoc.txt"
check 0 codesign "$F/codesign-unsigned.txt"
check 1 codesign "$F/codesign-team.txt"
check 1 codesign "$F/codesign-contradictory.txt"
check 1 codesign "$F/codesign-adhoc-no-team-line.txt"
check 2 codesign "$F/codesign-empty.txt"
check 2 codesign "$F/no-such-file.txt"
check 0 running "$F/launchctl-running.txt" "$B"
check 1 running "$F/launchctl-exited.txt" "$B"
check 1 running "$F/launchctl-other-app.txt" "$B"
check 2 running "$F/launchctl-garbage.txt" "$B"
X="$here/../src-tauri/Info.ios.plist"
G="$F/plist-generated.plist"
check 0 tree "$F/status-only-info-plist.txt" "$G" "$F/plist-merged.plist" "$X"
check 0 tree "$F/status-empty.txt" "$G" "$G" "$X"
check 1 tree "$F/status-only-info-plist.txt" "$G" "$G" "$X"
check 1 tree "$F/status-only-info-plist.txt" "$G" "$F/plist-extra-key.plist" "$X"
check 1 tree "$F/status-only-info-plist.txt" "$G" "$F/plist-missing-key.plist" "$X"
check 1 tree "$F/status-only-info-plist.txt" "$G" "$F/plist-changed-key.plist" "$X"
check 1 tree "$F/status-other-file.txt" "$G" "$F/plist-merged.plist" "$X"
check 1 tree "$F/status-untracked.txt" "$G" "$F/plist-merged.plist" "$X"
check 2 tree "$F/status-only-info-plist.txt" "$G" "$F/plist-not-a-plist.plist" "$X"
check 1 tree "$F/status-only-info-plist.txt" "$G" "$F/plist-merged-int.plist" "$X"
check 0 bundle "$F/plist-merged.plist" "$X"
check 0 bundle "$F/plist-merged-binary.plist" "$X"
check 1 bundle "$G" "$X"
check 1 bundle "$F/plist-missing-key.plist" "$X"
check 1 bundle "$F/plist-merged-int.plist" "$X"
check 1 bundle "$F/plist-file-sharing-false.plist" "$X"
check 1 bundle "$F/plist-encryption.plist" "$X"
check 2 bundle "$F/plist-not-a-plist.plist" "$X"
check 2 bogus
[ "$bad" = 0 ] || { echo "FAIL: ios-judge.py"; exit 1; }
echo "ok: ios-judge.py gives every fixture its expected result"
if [ -z "${IOS_JUDGE:-}" ]; then
  t=$(mktemp -d)
  mutate() {  # name, then the exact text to replace once, and its replacement
    python3 -I -c 'import sys; s=open(sys.argv[1]).read(); assert s.count(sys.argv[2])==1, sys.argv[2]; open(sys.argv[3],"w").write(s.replace(sys.argv[2], sys.argv[4]))' "$here/ios-judge.py" "$2" "$t/$1.py" "$3" || { echo "FAIL control $1: the rule to undo is not in ios-judge.py"; bad=1; return; }
    if IOS_JUDGE="$t/$1.py" bash "$0" > "$t/$1.out" 2>&1; then echo "FAIL control $1: the fixtures still pass with it undone"; bad=1; else echo "ok   control $1: caught ($(grep -c '^FAIL ' "$t/$1.out") fixtures)"; fi
  }
  mutate running-any-entry 'if any(r[0].isdigit() for r in mine):' 'if mine:'
  mutate tree-merge-unchecked 'if not same(b, want):' 'if False:'
  mutate codesign-team-unchecked 'if authority or sig != ["Signature=adhoc"] or team != ["TeamIdentifier=not set"]:' 'if authority:'
  mutate codesign-contradiction-ok '        if len(lines) == 1:' '        if True:'
  mutate untyped-compare '    if type(a) is not type(b):
        return False
' ''
  mutate bundle-presence-only 'bad = [k for k in e if k not in b or not same(b[k], e[k])]' 'bad = [k for k in e if k not in b]'
  mutate bundle-encryption-unchecked 'if "ITSAppUsesNonExemptEncryption" in b:' 'if False:'
  rm -rf "$t"
  [ "$bad" = 0 ] || { echo "FAIL: ios-judge.py's controls"; exit 1; }
  echo "ok: each control is caught"
fi
