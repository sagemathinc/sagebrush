"""Record what seaborn 0.13.2 draws for each case of test/seaborn_geometry_cases.py into test/seaborn-oracle.json,
which test/seaborn-geometry.test.ts compares Sagebrush's drawing with (CI has no seaborn).  Run with a CPython
that has seaborn 0.13.2, pandas and matplotlib:

    python3 -I test/seaborn_oracle_gen.py
"""
import json
import math
import os
import sys

import matplotlib
import pandas
import seaborn

here = os.path.dirname(os.path.abspath(__file__))
ns = {}
exec(open(os.path.join(here, "seaborn_geometry_cases.py")).read(), ns)


def plain(v):
    """the result with NaN as null (JSON has no NaN)"""
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v


rows = {}
for cid, code in ns["CASES"]:
    g = {}
    exec(ns["ORACLE_PRELUDE"] + ns["DATA"] + code, g)
    rows[cid] = plain(g["out"])
out = {"note": "written by test/seaborn_oracle_gen.py: CPython %s, seaborn %s, pandas %s, matplotlib %s"
       % (sys.version.split()[0], seaborn.__version__, pandas.__version__, matplotlib.__version__), "rows": rows}
with open(os.path.join(here, "seaborn-oracle.json"), "w") as f:
    # (one case to a line)
    f.write('{"note": %s, "rows": {\n' % json.dumps(out["note"]))
    f.write(",\n".join("%s: %s" % (json.dumps(k), json.dumps(v, allow_nan=False)) for k, v in rows.items()))
    f.write("\n}}\n")
print("test/seaborn-oracle.json: %d cases" % len(rows))
