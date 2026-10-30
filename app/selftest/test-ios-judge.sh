#!/usr/bin/env bash
# ios-judge.py on fixed inputs (app/selftest/ios-fixtures): each must give its
# exit code, so a judge that accepts a signed (or contradictory) codesign
# report, a stopped app, an extra change after the build, a built app without
# Info.ios.plist's exact settings (typed: true is not 1) or with an encryption
# declaration, or a malformed UDID can't pass.
#   bash app/selftest/test-ios-judge.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
F="$here/ios-fixtures"
bad=0
check() {  # want, then the judge's arguments
  local want=$1 rc=0; shift
  python3 -I "$here/ios-judge.py" "$@" > /tmp/ios-judge-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $* -> $rc"; else echo "FAIL $* -> $rc, expected $want:"; cat /tmp/ios-judge-test.out; bad=1; fi
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
