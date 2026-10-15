"""Record what CPython with matplotlib (and Pillow) prints for the PNG probes,
test/png_imread_cases.py, png_savefig_cases.py, png_savefig_args_cases.py and png_color_cases.py, into
test/png-oracle.json, which test/png.test.ts compares Sagebrush's output with
(CI has no matplotlib).

    python3 test/png_oracle_gen.py
"""
import json
import os
import subprocess
import sys

import matplotlib
import PIL

here = os.path.dirname(os.path.abspath(__file__))
out = {"note": "written by test/png_oracle_gen.py: CPython %s, matplotlib %s, Pillow %s"
       % (sys.version.split()[0], matplotlib.__version__, PIL.__version__)}
for name in ("png_imread_cases.py", "png_savefig_cases.py", "png_savefig_args_cases.py", "png_color_cases.py"):
    r = subprocess.run([sys.executable, os.path.join(here, name)], capture_output=True, text=True, cwd=here,
                       env={**os.environ, "MPLBACKEND": "Agg"})
    if r.returncode != 0:
        sys.exit("%s: %s" % (name, r.stderr))
    out[name] = r.stdout
with open(os.path.join(here, "png-oracle.json"), "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print("test/png-oracle.json:", {k: v.count("\n") for k, v in out.items() if k.endswith(".py")})
