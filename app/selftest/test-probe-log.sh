#!/usr/bin/env bash
# probe-log.py on fixed inputs (app/selftest/probe-log-fixtures): each case
# must give its expected exit code and, for a FAIL, name the rule it breaks,
# so a reader that never fails (or always does, or for the wrong reason)
# can't pass.  The grammar: the native-checks packet's probe-grammar.md (r1.1)
# plus rule 9, the done sentinel (NC-R1-A2).  Every log fixture ends with the
# sentinel unless its case is about the sentinel.
#   bash app/selftest/test-probe-log.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
F="$HERE/probe-log-fixtures"
N=11111111-2222-4333-8444-555555555555
bad=0
run() {  # want-exit, want-text ("" for none), then the reader's arguments (file names relative to F)
  local want=$1 text=$2 rc=0; shift 2
  local args=() a
  for a in "$@"; do if [ -e "$F/$a" ] || [[ "$a" == missing* ]]; then args+=("$F/$a"); else args+=("$a"); fi; done
  python3 -I "$HERE/probe-log.py" "${args[@]}" > /tmp/probe-log-test.out 2>&1 || rc=$?
  if [ "$rc" != "$want" ]; then echo "FAIL $* -> $rc, expected $want:"; cat /tmp/probe-log-test.out; bad=1; return; fi
  if [ -n "$text" ] && ! grep -q -F -- "$text" /tmp/probe-log-test.out; then echo "FAIL $* -> $rc, but not for \"$text\":"; cat /tmp/probe-log-test.out; bad=1; return; fi
  echo "ok   $* -> $rc${text:+ ($text)}"
}
# desktop: the positives
run 0 "" --desktop desktop-good-one.txt "$N" report-one-ok.txt
run 0 "" --desktop desktop-good-two.txt "$N" report-two-ok.txt
run 0 "" --desktop desktop-good-crlf.txt "$N" report-one-ok.txt
# desktop: rule 1, the report
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-check2-fail.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-malformed-routes.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-reordered-routes.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-four-routes.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-stale-nonce.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-two-check2.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" report-no-check2.txt
# rule 2: no ok route
run 1 "rule 2" --desktop desktop-good-one.txt "$N" report-none-ok.txt
# rule 3: the page marker
run 1 "rule 3" --desktop desktop-no-page.txt "$N" report-one-ok.txt
run 1 "rule 3" --desktop desktop-page-twice.txt "$N" report-one-ok.txt
run 1 "rule 3" --desktop desktop-prefixed-marker.txt "$N" report-one-ok.txt
run 1 "rule 3" --desktop desktop-marker-trailing-text.txt "$N" report-one-ok.txt
# rules 4-5: per route
run 1 "rule 4" --desktop desktop-ok-route-missing.txt "$N" report-one-ok.txt
run 1 "rule 4" --desktop desktop-ok-route-twice.txt "$N" report-one-ok.txt
run 1 "rule 4" --desktop desktop-two-ok-one-line.txt "$N" report-two-ok.txt
run 1 "rule 5" --desktop desktop-unavailable-route-line.txt "$N" report-one-ok.txt
# rule 6: any worker line, any prefix, any nonce, CRLF, after the sentinel too
run 1 "rule 6" --desktop desktop-worker-line.txt "$N" report-one-ok.txt
run 1 "rule 6" --desktop desktop-worker-other-prefix.txt "$N" report-one-ok.txt
run 1 "rule 6" --desktop desktop-worker-crlf.txt "$N" report-one-ok.txt
run 1 "rule 6" --desktop desktop-worker-stale.txt "$N" report-one-ok.txt
run 1 "rule 6" --desktop desktop-worker-after-done.txt "$N" report-one-ok.txt
# rule 7: a stale nonce only counts for nothing
run 1 "rule 3" --desktop desktop-stale-only.txt "$N" report-one-ok.txt
# rule 9: the done sentinel exactly once, last among this nonce's probe lines
run 1 "rule 9" --desktop desktop-done-missing.txt "$N" report-one-ok.txt
run 1 "rule 9" --desktop desktop-done-twice.txt "$N" report-one-ok.txt
run 1 "rule 9: a probe marker after" --desktop desktop-done-before-route.txt "$N" report-one-ok.txt
run 1 "rule 9" --desktop desktop-done-stale-only.txt "$N" report-one-ok.txt
# android: the positives (the pid's own lines; CRLF)
run 0 "" --android android-good.txt 4242 "$N" report-android.txt
run 0 "" --android android-good-crlf.txt 4242 "$N" report-one-ok.txt
# rule 8: other pids don't count for 3-5 and 9, but a worker line under ANY pid fails
run 1 "rule 3" --android android-other-pid-only.txt 4242 "$N" report-one-ok.txt
run 1 "rule 6" --android android-worker-other-pid.txt 4242 "$N" report-one-ok.txt
run 1 "rule 3" --android android-noise-unparsed-marker.txt 4242 "$N" report-one-ok.txt
run 1 "rule 5" --android android-raw-route-line.txt 4242 "$N" report-android.txt
run 1 "rule 9" --android android-done-other-pid.txt 4242 "$N" report-android.txt
run 1 "rule 8" --android android-good.txt 0 "$N" report-android.txt
run 1 "rule 8" --android android-good.txt x42 "$N" report-android.txt
# can't judge: bad arguments or unreadable files
run 2 "" --desktop desktop-good-one.txt NOT-A-UUID report-one-ok.txt
run 2 "" --desktop desktop-good-one.txt 11111111-2222-4333-8444-55555555555A report-one-ok.txt  # (uppercase hex)
run 2 "" --desktop missing.txt "$N" report-one-ok.txt
run 2 "" --desktop desktop-good-one.txt "$N" missing.txt
run 2 "" --desktop desktop-good-one.txt "$N"
run 2 "" --windows desktop-good-one.txt "$N" report-one-ok.txt
# an empty log and an empty report both fail
run 1 "rule 3" --desktop empty.txt "$N" report-one-ok.txt
run 1 "rule 1" --desktop desktop-good-one.txt "$N" empty.txt
[ "$bad" = 0 ] || { echo "FAIL: probe-log.py"; exit 1; }
echo "ok: probe-log.py gives every case its expected result"
