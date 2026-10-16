"""Record what CPython with matplotlib prints for test/mpl_legend_ticks_cases.py
and test/mpl_invert_cases.py
into test/mpl-oracle.json, which test/mpl-legend-ticks.test.ts compares
Sagebrush's output with (CI has no matplotlib).

    python3 test/mpl_oracle_gen.py
"""
import json
import os
import subprocess
import sys

import matplotlib

here = os.path.dirname(os.path.abspath(__file__))
out = {"note": "written by test/mpl_oracle_gen.py: CPython %s, matplotlib %s" % (sys.version.split()[0], matplotlib.__version__)}
for name in ("mpl_legend_ticks_cases.py", "mpl_invert_cases.py"):
    r = subprocess.run([sys.executable, os.path.join(here, name)], capture_output=True, text=True, cwd=here,
                       env={**os.environ, "MPLBACKEND": "Agg"})
    if r.returncode != 0:
        sys.exit("%s: %s" % (name, r.stderr))
    out[name] = r.stdout
with open(os.path.join(here, "mpl-oracle.json"), "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print("test/mpl-oracle.json:", {k: v.count("\n") for k, v in out.items() if k.endswith(".py")})
