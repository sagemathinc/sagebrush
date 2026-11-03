"""The oracle of test/magma-page-order.json: each case's cells run top to
bottom, as one Magma session, by real Magma (a black box), each case's output
recorded as its `out`.

    python3 scripts/magma-page-order-oracle.py test/magma-page-order.json

runs /usr/local/bin/magma -b once per case and rewrites the JSON with the outputs."""
import json
import subprocess
import sys

path = sys.argv[1]
table = json.load(open(path))
for case in table["cases"]:
    src = "\n".join(case["cells"]) + "\nquit;\n"
    r = subprocess.run(["/usr/local/bin/magma", "-b"], input=src, capture_output=True, text=True, timeout=120)
    case["out"] = r.stdout
with open(path, "w") as f:
    json.dump(table, f, indent=1)
    f.write("\n")
