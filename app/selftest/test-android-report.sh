#!/usr/bin/env bash
# The Android self-test's judge (android-report.py) on fixed reports: the two
# that must pass (all ok; isolation and Stop failing, which are reported only)
# and the five that must fail (a required check failing, renamed, missing,
# twice, or the self-test throwing; and the Terminal's three keys: one missing,
# one twice, one FAIL; check 3's engine rule against the caller's --engine: webkit's 0 or 3 events with the
# differential pass, chromium's 0 or 1 fail, 1-2 fail anywhere, a failed control, the own fetch fetched, an IPC
# fetch not refused on chromium, a report's engine not the caller's (iOS claiming chromium), a broken detail; the
# per-request matching (astra's NC-R1-A1): an unmatched event in place of a request's, an extra one, counts that
# don't add up, a request matched twice, webkit's unmatched-only or partial sets, webkit's IPC not marked
# information; and
# --engine missing or unknown, exit 2); then the diagnosis lines' grammar: a key
# missing, twice, unknown, without ": ", a prefix of another, empty, or a raw
# CR in a value fail; an escaped newline, a truncated value and error,
# timeout or unsupported values pass (they are facts, read by coi-reading.py).
#   bash app/selftest/test-android-report.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bad=0
# (name:engine:expected exit; the engine is what the caller's platform fixes: android-selftest.sh chromium,
# ios-selftest.sh webkit)
for f in good:chromium:0 coi-fail:chromium:0 req-fail:chromium:1 renamed:chromium:1 missing:chromium:1 dup:chromium:1 threw:chromium:1 \
    info-missing:chromium:1 info-dup:chromium:1 info-unknown:chromium:1 info-nocolon:chromium:1 info-prefix:chromium:1 info-empty:chromium:1 info-raw-cr:chromium:1 \
    info-escaped:chromium:0 info-truncated:chromium:0 info-errors:chromium:0 term-missing:chromium:1 term-dup:chromium:1 term-fail:chromium:1 \
    term-webkit-good:webkit:0 term-webkit-three:webkit:0 term-chromium-zero:chromium:1 term-chromium-one:chromium:1 term-webkit-two:webkit:1 \
    term-control-failed:webkit:1 term-own-fetched:chromium:1 term-engine-webkit:chromium:1 term-ios-claims-chromium:webkit:1 \
    term-chromium-ipc-timeout:chromium:1 term-bad-grammar:chromium:1 \
    term-chromium-unmatched:chromium:1 term-chromium-extra:chromium:1 term-sum-mismatch:chromium:1 term-events-two:chromium:1 \
    term-webkit-unmatched-only:webkit:1 term-webkit-one-unmatched:webkit:1 term-webkit-three-no-information:webkit:1; do
  IFS=: read -r name engine want <<< "$f"
  python3 -I "$here/android-report.py" --engine "$engine" "$here/report-fixtures/$name.txt" > /dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name --engine $engine (exit $got)"; else echo "FAIL $name --engine $engine: exit $got, expected $want"; bad=1; fi
done
# (the engine is the caller's, closed: missing or unknown is a usage error, exit 2)
for args in "" "--engine firefox" "--engine"; do
  python3 -I "$here/android-report.py" $args "$here/report-fixtures/good.txt" > /dev/null 2>&1
  got=$?
  if [ "$got" = 2 ]; then echo "ok   usage error for [$args] (exit 2)"; else echo "FAIL usage [$args]: exit $got, expected 2"; bad=1; fi
done
exit $bad
