"""Record what NumPy and SciPy give for test/random_binomial_cases.py and test/scipy_bootstrap_cases.py into
test/stats-oracle.json, which test/random-binomial-bootstrap.test.ts compares Sagebrush's results with (CI has
neither).  Run with a CPython that has NumPy 2.5 and SciPy 1.18:

    python3 -I test/stats_oracle_gen.py
"""
import json
import math
import os
import sys
import warnings

import numpy
import scipy

here = os.path.dirname(os.path.abspath(__file__))


def plain(v):
    """the result with NaN as null and the infinities as "inf" and "-inf" (JSON has neither)"""
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, float) and math.isinf(v):
        return "inf" if v > 0 else "-inf"
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v


out = {"note": "written by test/stats_oracle_gen.py: CPython %s, NumPy %s, SciPy %s"
       % (sys.version.split()[0], numpy.__version__, scipy.__version__)}
for name in ("random_binomial_cases.py", "scipy_bootstrap_cases.py"):
    ns = {}
    exec(open(os.path.join(here, name)).read(), ns)
    rows = {}
    for cid, code in ns["CASES"]:
        g = {}
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                exec(ns.get("PRELUDE", "") + ns.get("DATA", "") + code, g)
            rows[cid] = plain(g["out"])
        except Exception as e:
            rows[cid] = {"error": type(e).__name__, "message": str(e)}
    out[name] = rows
with open(os.path.join(here, "stats-oracle.json"), "w") as f:
    f.write("{%s: %s" % (json.dumps("note"), json.dumps(out["note"])))
    for name in ("random_binomial_cases.py", "scipy_bootstrap_cases.py"):
        f.write(",\n%s: {\n" % json.dumps(name))
        f.write(",\n".join("%s: %s" % (json.dumps(k), json.dumps(v, allow_nan=False)) for k, v in out[name].items()))
        f.write("\n}")
    f.write("}\n")
print("test/stats-oracle.json:", {k: len(v) for k, v in out.items() if k.endswith(".py")})
