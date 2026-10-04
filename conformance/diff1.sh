#!/bin/bash
# Show the CPython vs pyjs diff for micropython conformance cases.
#   bash conformance/diff1.sh string_split [more substrings...]
D="$(cd "$(dirname "$0")" && pwd)"
CLI="$D/../dist/src/cli.js"
for pat in "$@"; do
  for f in "$D"/upstream/micropython/basics/*"$pat"*.py; do
    [ -f "$f" ] || continue
    cd "$(dirname "$f")"
    b=$(basename "$f")
    diff <(timeout 10 python3 "$b" 2>&1) <(timeout 20 node "$CLI" "$b" 2>&1) > /tmp/d1.$$ && continue
    echo "=== $b"
    head -${N:-12} /tmp/d1.$$ | cut -c1-200
  done
done
rm -f /tmp/d1.$$
