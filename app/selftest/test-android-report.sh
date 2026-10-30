#!/usr/bin/env bash
# The Android self-test's judge (android-report.py) on fixed reports: the two
# that must pass (all ok; isolation and Stop failing, which are reported only)
# and the five that must fail (a required check failing, renamed, missing,
# twice, or the self-test throwing); then the diagnosis lines' grammar: a key
# missing, twice, unknown, without ": ", a prefix of another, empty, or a raw
# CR in a value fail; an escaped newline, a truncated value and error,
# timeout or unsupported values pass (they are facts, read by coi-reading.py).
#   bash app/selftest/test-android-report.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bad=0
for f in good:0 coi-fail:0 req-fail:1 renamed:1 missing:1 dup:1 threw:1 \
    info-missing:1 info-dup:1 info-unknown:1 info-nocolon:1 info-prefix:1 info-empty:1 info-raw-cr:1 \
    info-escaped:0 info-truncated:0 info-errors:0; do
  name=${f%%:*} want=${f##*:}
  python3 -I "$here/android-report.py" "$here/report-fixtures/$name.txt" > /dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name (exit $got)"; else echo "FAIL $name: exit $got, expected $want"; bad=1; fi
done
exit $bad
