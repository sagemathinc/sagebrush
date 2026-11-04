"""The oracle of test/matlab-page-order.json: each case's cells run top to
bottom, as one script, by GNU Octave (a black box for MATLAB's semantics; the
cases print with fprintf, whose output the two agree on), each case's output
recorded as its `out`.

    python3 scripts/matlab-page-order-oracle.py test/matlab-page-order.json

runs octave-cli once per case and rewrites the JSON with the outputs."""
import json
import os
import subprocess
import sys
import tempfile

path = sys.argv[1]
table = json.load(open(path))
for case in table["cases"]:
    with tempfile.TemporaryDirectory() as d:
        script = os.path.join(d, "cells.m")
        # ("1;": a script, not a function file, whatever its first cell defines)
        with open(script, "w") as f:
            f.write("1;\n" + "\n".join(case["cells"]) + "\n")
        r = subprocess.run(["octave-cli", "--no-init-file", "--quiet", script], capture_output=True, text=True, timeout=120, cwd=d)
    case["out"] = r.stdout
with open(path, "w") as f:
    json.dump(table, f, indent=1, ensure_ascii=False)
    f.write("\n")
