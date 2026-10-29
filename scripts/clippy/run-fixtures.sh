#!/bin/bash
# run-fixtures.sh DIR: clippy-summary.py against its frozen fixtures (DIR/fixtures/*.json, DIR/fixtures/expected.tsv).
# Each fixture must give the expected exit status and COLLECTION / SUMMARY / CLEAN lines, and match its extra ERE if
# one is given. Executed only on the granted VM (and later in CI), never in the CoCalc project.
# Exit 0 only if every row passes and at least one row ran.
set -uo pipefail
dir=${1:?usage: $0 DIR}
fx=$dir/fixtures
n=0 bad=0
while IFS=$'\t' read -r name rc ex col summ clean extra; do
  case "$name" in ''|'#'*) continue ;; esac
  n=$((n+1))
  e=0
  out=$(python3 -I "$dir/clippy-summary.py" "$fx/$name.json" "$rc" engine/py/Cargo.toml 2>&1) || e=$?
  why=""
  [ "$e" = "$ex" ] || why="$why exit $e (want $ex);"
  printf '%s\n' "$out" | grep -q "^COLLECTION $col" || why="$why COLLECTION not $col;"
  printf '%s\n' "$out" | grep -q "^SUMMARY $summ" || why="$why SUMMARY not $summ;"
  printf '%s\n' "$out" | grep -q "^CLEAN $clean\$" || why="$why CLEAN not $clean;"
  if [ -n "$extra" ]; then printf '%s\n' "$out" | grep -qE -- "$extra" || why="$why no match for /$extra/;"; fi
  if [ -z "$why" ]; then echo "  fixture ok   $name"; else echo "  fixture FAIL $name:$why"; printf '%s\n' "$out" | tail -5 | sed 's/^/      /'; bad=$((bad+1)); fi
done < "$fx/expected.tsv"
echo "fixtures: $n run, $bad failed"
[ "$n" -gt 0 ] && [ "$bad" -eq 0 ]
