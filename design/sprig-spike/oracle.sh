#!/bin/bash
# Mathics3 as a black-box oracle: each input line (one expression) is evaluated
# in one session and its result printed in InputForm, one line per input:
#   oracle.sh inputs.txt > outputs.txt
# Lines starting with '#' are skipped.  Definitions (:=) print "Null".
set -euo pipefail
export TMPDIR=/scratch/matlab-tmp/tmp
M=/scratch/matlab-tmp/mathics/venv/bin/mathics
in=$1
prog=$(mktemp)
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  esc=${line//\\/\\\\}; esc=${esc//\"/\\\"}
  printf 'Print["@@@ ", ToString[InputForm[Quiet[ToExpression["%s"]]]]]\n' "$esc" >> "$prog"
done < "$in"
$M -q --no-readline --colors NoColor < "$prog" 2>&1 | grep -o "@@@ .*" | sed "s/^@@@ //" | cut -c1-400
rm -f "$prog"
