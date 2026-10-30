#!/usr/bin/env bash
# coi-reading.py on fixed reports and logs (app/selftest/coi-fixtures): each
# must give exactly its set of readings (the tags), so a reading can't be
# missing, extra or exclusive by accident; plus the usage errors.
#   bash app/selftest/test-coi-reading.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
F="$here/coi-fixtures"
bad=0
check() {  # report, the log ("-" for --no-logcat), the expected tags (sorted, space-separated)
  local report=$1 log=$2 want=$3 args got rc=0
  if [ "$log" = - ]; then args=(--no-logcat); else args=(--logcat "$F/$log.txt"); fi
  out=$(python3 -I "$here/coi-reading.py" "$F/$report.txt" "${args[@]}" 2>&1) || rc=$?
  got=$(sed -n 's/^reading \([a-z0-9-]*\): .*/\1/p' <<<"$out" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')
  if [ "$rc" = 0 ] && [ "$got" = "$want" ]; then echo "ok   $report + $log -> $got"; else echo "FAIL $report + $log -> rc $rc [$got], expected [$want]:"; echo "$out"; bad=1; fi
}
check desktop-isolated - "isolated logcat-na"
check android logcat-full "h2 navigation-unverified"
check android logcat-nav "h2"
check android logcat-empty "logcat-unknown not-distinguished"
check android logcat-no-control "logcat-unknown not-distinguished"
check android - "logcat-na not-distinguished"
check android-errors logcat-full "incomplete navigation-unverified not-distinguished"
check android-coep-missing logcat-full "h1 navigation-unverified"
check android-origin logcat-full "h3 navigation-unverified"
check android-origin-coep logcat-full "h1 h3 navigation-unverified"
check android-policy-false logcat-full "h2 navigation-unverified policy"
check kernel-discrepancy - "h4 logcat-na"
check contradictory logcat-full "contradictory isolated navigation-unverified"
check android-redirect logcat-full "incomplete navigation-unverified not-distinguished"
check android-404 logcat-full "incomplete navigation-unverified not-distinguished"
check android-truncated logcat-full "incomplete navigation-unverified not-distinguished"
for a in "" "--logcat" "--bogus"; do
  rc=0; python3 -I "$here/coi-reading.py" "$F/android.txt" $a > /dev/null 2>&1 || rc=$?
  if [ "$rc" = 2 ]; then echo "ok   usage error '$a' -> 2"; else echo "FAIL usage error '$a' -> $rc, expected 2"; bad=1; fi
done
[ "$bad" = 0 ] || { echo "FAIL: coi-reading.py"; exit 1; }
echo "ok: coi-reading.py gives every fixture exactly its readings"
