#!/usr/bin/env bash
# logcat-crash.py and logcat-kill.py on fixed logcat dumps
# (app/selftest/logcat-fixtures), before they judge the release APK on the
# emulator: each dump must give its expected exit code, so a judge that never
# finds anything (or always does) can't pass.
#   bash app/selftest/test-logcat-crash.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
F="$HERE/logcat-fixtures"
bad=0
run() {
  local judge=$1 want=$2 file=$3 pid=$4 rc=0
  python3 -I "$HERE/$judge" "$F/$file" space.sagebrush.notebook "$pid" > /tmp/logcat-judge-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $judge $file $pid -> $rc"; else echo "FAIL $judge $file $pid -> $rc, expected $want:"; cat /tmp/logcat-judge-test.out; bad=1; fi
}
check() { run logcat-crash.py "$1" "$2" 1234; }
check 0 clean.txt
check 0 other-fatal.txt
check 0 other-pid-linkerror.txt
check 1 our-fatal-restarted.txt
check 1 our-linkerror.txt
check 0 other-tombstone.txt
check 1 our-tombstone.txt
check 2 empty.txt
check 2 missing.txt
# the two real system kills (Oct 30) are not crashes
run logcat-crash.py 0 gms-kill-41145830456.txt 2688
run logcat-crash.py 0 gms-kill-41078076607.txt 3405

# logcat-kill.py: the system killed the app's process for a dying dependency
run logcat-kill.py 0 gms-kill-41145830456.txt 2688
run logcat-kill.py 0 gms-kill-41078076607.txt 3405
run logcat-kill.py 0 kill-ours-synthetic.txt 1234
# (the controls: another pid, package, sub-process, reason, tag; a truncated line)
run logcat-kill.py 1 gms-kill-41145830456.txt 3405
run logcat-kill.py 1 gms-kill-41078076607.txt 2688
run logcat-kill.py 1 kill-other-package.txt 1234
run logcat-kill.py 1 kill-subprocess.txt 1234
run logcat-kill.py 1 kill-ours-other-reason.txt 1234
run logcat-kill.py 1 kill-ours-wrong-tag.txt 1234
run logcat-kill.py 1 kill-ours-no-dying-proc.txt 1234
run logcat-kill.py 1 clean.txt 1234
run logcat-kill.py 1 our-fatal-restarted.txt 1234
run logcat-kill.py 2 empty.txt 1234
run logcat-kill.py 2 missing.txt 1234
run logcat-kill.py 2 kill-ours-synthetic.txt x1234
# (its message names the provider and the dying process, as the FAIL line will)
python3 -I "$HERE/logcat-kill.py" "$F/gms-kill-41145830456.txt" space.sagebrush.notebook 2688 > /tmp/logcat-judge-test.out 2>&1 || true
if grep -qx 'killed by the system (dependency died): provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent (10-30 23:47:33.349)' /tmp/logcat-judge-test.out; then
  echo "ok   logcat-kill.py names the provider, the dying process and the time"
else
  echo "FAIL logcat-kill.py's message:"; cat /tmp/logcat-judge-test.out; bad=1
fi
[ "$bad" = 0 ] || { echo "FAIL: the logcat judges"; exit 1; }
echo "ok: the logcat judges give every fixture its expected result"
