#!/usr/bin/env bash
# The Android self-test's judge (android-report.py) on fixed reports: the two
# that must pass (all ok; isolation and Stop failing, which are reported only)
# and the five that must fail (a required check failing, renamed, missing,
# twice, or the self-test throwing).
#   bash app/selftest/test-android-report.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bad=0
for f in good:0 coi-fail:0 req-fail:1 renamed:1 missing:1 dup:1 threw:1; do
  name=${f%%:*} want=${f##*:}
  python3 -I "$here/android-report.py" "$here/report-fixtures/$name.txt" > /dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name (exit $got)"; else echo "FAIL $name: exit $got, expected $want"; bad=1; fi
done
exit $bad
