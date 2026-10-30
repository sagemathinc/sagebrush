#!/usr/bin/env bash
# logcat-crash.py on fixed logcat dumps (app/selftest/logcat-fixtures), before
# it judges the release APK on the emulator: each dump must give its expected
# exit code, so a judge that never finds anything (or always does) can't pass.
#   bash app/selftest/test-logcat-crash.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
F="$HERE/logcat-fixtures"
bad=0
check() {
  local want=$1 file=$2 rc=0
  python3 -I "$HERE/logcat-crash.py" "$F/$file" space.sagebrush.notebook 1234 > /tmp/logcat-crash-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $file -> $rc"; else echo "FAIL $file -> $rc, expected $want:"; cat /tmp/logcat-crash-test.out; bad=1; fi
}
check 0 clean.txt
check 0 other-fatal.txt
check 0 other-pid-linkerror.txt
check 1 our-fatal-restarted.txt
check 1 our-linkerror.txt
check 0 other-tombstone.txt
check 1 our-tombstone.txt
check 2 empty.txt
check 2 missing.txt
[ "$bad" = 0 ] || { echo "FAIL: the logcat judge"; exit 1; }
echo "ok: the logcat judge gives every fixture its expected result"
