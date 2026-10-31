#!/usr/bin/env bash
# probe-log.py on fixed inputs (app/selftest/probe-log-fixtures): each case
# must give its expected exit code, so a reader that never fails (or always
# does) can't pass.  The grammar: the native-checks packet's probe-grammar.md.
#   bash app/selftest/test-probe-log.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
F="$HERE/probe-log-fixtures"
N=11111111-2222-4333-8444-555555555555
bad=0
run() {  # want, then the reader's arguments (file names relative to F)
  local want=$1 rc=0; shift
  local args=() a
  for a in "$@"; do if [ -e "$F/$a" ] || [[ "$a" == missing* ]]; then args+=("$F/$a"); else args+=("$a"); fi; done
  python3 -I "$HERE/probe-log.py" "${args[@]}" > /tmp/probe-log-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $* -> $rc"; else echo "FAIL $* -> $rc, expected $want:"; cat /tmp/probe-log-test.out; bad=1; fi
}
# desktop: the positives
run 0 --desktop desktop-good-one.txt "$N" report-one-ok.txt
run 0 --desktop desktop-good-two.txt "$N" report-two-ok.txt
run 0 --desktop desktop-good-crlf.txt "$N" report-one-ok.txt
# desktop: rule 1, the report
run 1 --desktop desktop-good-one.txt "$N" report-check2-fail.txt
run 1 --desktop desktop-good-one.txt "$N" report-malformed-routes.txt
run 1 --desktop desktop-good-one.txt "$N" report-reordered-routes.txt
run 1 --desktop desktop-good-one.txt "$N" report-four-routes.txt
run 1 --desktop desktop-good-one.txt "$N" report-stale-nonce.txt
run 1 --desktop desktop-good-one.txt "$N" report-two-check2.txt
run 1 --desktop desktop-good-one.txt "$N" report-no-check2.txt
# rule 2: no ok route
run 1 --desktop desktop-good-one.txt "$N" report-none-ok.txt
# rule 3: the page marker
run 1 --desktop desktop-no-page.txt "$N" report-one-ok.txt
run 1 --desktop desktop-page-twice.txt "$N" report-one-ok.txt
run 1 --desktop desktop-prefixed-marker.txt "$N" report-one-ok.txt
run 1 --desktop desktop-marker-trailing-text.txt "$N" report-one-ok.txt
# rules 4-5: per route
run 1 --desktop desktop-ok-route-missing.txt "$N" report-one-ok.txt
run 1 --desktop desktop-ok-route-twice.txt "$N" report-one-ok.txt
run 1 --desktop desktop-two-ok-one-line.txt "$N" report-two-ok.txt
run 1 --desktop desktop-unavailable-route-line.txt "$N" report-one-ok.txt
# rule 6: any worker line, any prefix, any nonce, CRLF
run 1 --desktop desktop-worker-line.txt "$N" report-one-ok.txt
run 1 --desktop desktop-worker-other-prefix.txt "$N" report-one-ok.txt
run 1 --desktop desktop-worker-crlf.txt "$N" report-one-ok.txt
run 1 --desktop desktop-worker-stale.txt "$N" report-one-ok.txt
# rule 7: a stale nonce only counts for nothing
run 1 --desktop desktop-stale-only.txt "$N" report-one-ok.txt
# android: the positives (the pid's own lines; CRLF)
run 0 --android android-good.txt 4242 "$N" report-android.txt
run 0 --android android-good-crlf.txt 4242 "$N" report-one-ok.txt
# rule 8: other pids don't count for 3-5, but a worker line under ANY pid fails
run 1 --android android-other-pid-only.txt 4242 "$N" report-one-ok.txt
run 1 --android android-worker-other-pid.txt 4242 "$N" report-one-ok.txt
run 1 --android android-noise-unparsed-marker.txt 4242 "$N" report-one-ok.txt
run 1 --android android-raw-route-line.txt 4242 "$N" report-android.txt
run 1 --android android-good.txt 0 "$N" report-android.txt
run 1 --android android-good.txt x42 "$N" report-android.txt
# can't judge: bad arguments or unreadable files
run 2 --desktop desktop-good-one.txt NOT-A-UUID report-one-ok.txt
run 2 --desktop desktop-good-one.txt 11111111-2222-4333-8444-55555555555A report-one-ok.txt  # (uppercase hex)
run 2 --desktop missing.txt "$N" report-one-ok.txt
run 2 --desktop desktop-good-one.txt "$N" missing.txt
run 2 --desktop desktop-good-one.txt "$N"
run 2 --windows desktop-good-one.txt "$N" report-one-ok.txt
# an empty log and an empty report both fail (no page marker; no check 2)
run 1 --desktop empty.txt "$N" report-one-ok.txt
run 1 --desktop desktop-good-one.txt "$N" empty.txt
[ "$bad" = 0 ] || { echo "FAIL: probe-log.py"; exit 1; }
echo "ok: probe-log.py gives every case its expected result"
