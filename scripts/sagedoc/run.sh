#!/bin/sh
# Coverage of Sage's English documentation outside the reference manual
# (tutorial, thematic tutorials, constructions, PREP, FAQ, tour) by the
# Sagebrush CPython package: every sage: example, one session per file,
# output compared as in Sage's doctests.  Sage's .rst sources are only read
# as a test corpus (sparse clone under /scratch, nothing copied here).
#   sh scripts/sagedoc/run.sh            # about 5 minutes on 14 processes
# Measured 2026-10-08: 4632 of 6652 examples right (69.6%); first run (4287a57): 1845 of 6615 (27.9%):
# tutorial 63%, PREP 67%, constructions 54%, thematic tutorials 75%.
set -e
W=${SAGEDOC:-/scratch/sagedoc}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$W" && cd "$W"
[ -d sage ] || { git clone -q --depth 1 --filter=blob:none --sparse https://github.com/sagemath/sage.git && (cd sage && git sparse-checkout set src/doc/en); }
find sage/src/doc/en/tutorial sage/src/doc/en/thematic_tutorials sage/src/doc/en/constructions sage/src/doc/en/prep sage/src/doc/en/faq sage/src/doc/en/a_tour_of_sage -name "*.rst" > files.txt
rm -rf out && mkdir out
export PYTHONPATH="$HERE/../../engine/py/python"
xargs -P 14 -I{} sh -c 'timeout 600 python3 "'"$HERE"'/rundocs.py" "{}" "out/$(echo {} | md5sum | cut -c1-12).json" >/dev/null 2>&1' < files.txt || true
python3 "$HERE/analyze.py" out
