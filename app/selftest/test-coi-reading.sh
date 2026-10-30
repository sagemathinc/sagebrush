#!/usr/bin/env bash
# coi-reading.py on fixed reports and logs (app/selftest/coi-fixtures): each
# must give exactly its set of readings (the tags), so a reading can't be
# missing, extra or exclusive by accident; plus the usage errors.
#   bash app/selftest/test-coi-reading.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
F="$here/coi-fixtures"
READING=${COI_READING:-$here/coi-reading.py}
bad=0
check() {  # report, the log ("-" for --no-logcat), the expected tags (sorted, space-separated)
  local report=$1 log=$2 want=$3 args got rc=0
  if [ "$log" = - ]; then args=(--no-logcat); else args=(--logcat "$F/$log.txt"); fi
  out=$(python3 -I "$READING" "$F/$report.txt" "${args[@]}" 2>&1) || rc=$?
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
# (the document's fact and the check line disagree: no row that depends on
# them, isolated, H2 or H4; the independent ones, here H1, stay)
check contradictory-doc-true logcat-full "contradictory navigation-unverified"
check contradictory-doc-false logcat-full "contradictory navigation-unverified"
check contradictory-doc-true-coep logcat-full "contradictory h1 navigation-unverified"
# (a fetch is header evidence only for exactly the URL asked for, answered
# 200 from it; anything else, or no JSON object, is incomplete, no crash)
for f in android-redirect android-404 android-wrong-path android-extra-query android-final-differs android-other-origin android-malformed android-not-object android-truncated; do
  check "$f" logcat-full "incomplete navigation-unverified not-distinguished"
done
for a in "" "--logcat" "--bogus"; do
  rc=0; python3 -I "$READING" "$F/android.txt" $a > /dev/null 2>&1 || rc=$?
  if [ "$rc" = 2 ]; then echo "ok   usage error '$a' -> 2"; else echo "FAIL usage error '$a' -> $rc, expected 2"; bad=1; fi
done
[ "$bad" = 0 ] || { echo "FAIL: coi-reading.py"; exit 1; }
echo "ok: coi-reading.py gives every fixture exactly its readings"
# (the controls: with each of these rules undone, in a copy, the fixtures
# above must catch it)
if [ -z "${COI_READING:-}" ]; then
  t=$(mktemp -d)
  mutate() {  # name, python replacement (old, new) applied once to a copy
    python3 -I -c 'import sys; s=open(sys.argv[1]).read(); assert s.count(sys.argv[2])==1, sys.argv[2]; open(sys.argv[3],"w").write(s.replace(sys.argv[2], sys.argv[4]))' "$here/coi-reading.py" "$2" "$t/$1.py" "$3" || { echo "FAIL control $1: the rule to undo is not in coi-reading.py"; bad=1; return; }
    if COI_READING="$t/$1.py" bash "$0" > "$t/$1.out" 2>&1; then echo "FAIL control $1: the fixtures still pass with it undone"; bad=1; else echo "ok   control $1: caught ($(grep -c '^FAIL ' "$t/$1.out") fixtures)"; fi
  }
  mutate contradictory-feeds-rows '        doc = None
' ''
  mutate any-url-counts 'o.get("requested") != want or o.get("final") != want' 'False'
  mutate non-object-parsed 'if not isinstance(o, dict):' 'if o is None:'
  rm -rf "$t"
  [ "$bad" = 0 ] || { echo "FAIL: coi-reading.py's controls"; exit 1; }
  echo "ok: each control is caught"
fi
