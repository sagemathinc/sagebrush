"""The oracle for test/jupyter-figures.test.ts: what IPython's own Jupyter kernel (ipykernel, with matplotlib and
matplotlib-inline) shows for each case's cells, the formats of its figures and their PNG sizes, written to
test/jupyter-figures.json.

    pip install jupyter_client ipykernel matplotlib
    python3 test/jupyter_figures_gen.py
"""
import base64
import json
import os
import struct
import sys

import ipykernel
import matplotlib
import matplotlib_inline
from jupyter_client.manager import start_new_kernel

# (each case runs in a fresh kernel: its cells in order, the last one's outputs recorded)
CASES = [
    ("a figure shown at the cell's end", ["import matplotlib.pyplot as plt\nplt.plot([1, 2, 3]);"]),
    ("a figure of its own size", ["import matplotlib.pyplot as plt\nfig, ax = plt.subplots(figsize=(4, 3))\nax.plot([1, 2]);"]),
    ("a figure as the cell's value", ["import matplotlib.pyplot as plt\nfig, ax = plt.subplots(figsize=(4, 3))\nax.plot([1, 2])\nplt.close(fig)", "fig"]),
    ("figure_formats svg", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_formats = ['svg']\nplt.plot([1, 2, 3]);"]),
    ("figure_formats png and svg", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_formats = {'png', 'svg'}\nplt.plot([1, 2, 3]);"]),
    ("figure_format svg (one)", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_format = 'svg'\nplt.plot([1, 2, 3]);"]),
    ("figure_format retina", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_format = 'retina'\nplt.plot([1, 2, 3]);"]),
    ("figure_format retina, a figure of its own size", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_format = 'retina'\nfig, ax = plt.subplots(figsize=(4, 3))\nax.plot([1, 2]);"]),
    ("figure_formats png", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_formats = ['png']\nplt.plot([1, 2, 3]);"]),
    ("a format it can't show", ["%config InlineBackend.figure_formats = ['bmp']"]),
    ("a format it can't show leaves the formats", ["import matplotlib.pyplot as plt", "%config InlineBackend.figure_formats = ['svg']", "%config InlineBackend.figure_formats = ['bmp']", "plt.plot([1, 2, 3]);"]),
    ("figure_formats from a name", ["import matplotlib.pyplot as plt\nwanted = ['svg']", "%config InlineBackend.figure_formats = wanted\nplt.plot([1, 2, 3]);"]),
    ("another configurable", ["%config Foo.bar = 1"]),
]


def outputs(kc, code):
    got = []
    kc.execute_interactive(code, timeout=120, output_hook=lambda m: got.append(m) if m["msg_type"] in ("display_data", "execute_result", "error", "stream") else None)
    res = []
    for m in got:
        c = m["content"]
        if m["msg_type"] == "stream":
            res.append({"stream": c["name"]})
        elif m["msg_type"] == "error":
            res.append({"error": c["ename"]})
        else:
            o = {"type": m["msg_type"], "mimes": sorted(c["data"]), "metadata": c.get("metadata", {})}
            if "image/png" in c["data"]:
                b = base64.b64decode(c["data"]["image/png"])
                o["png"] = list(struct.unpack(">II", b[16:24]))
            res.append(o)
    return res


cases = []
for name, cells in CASES:
    km, kc = start_new_kernel(kernel_name="python3")
    try:
        for code in cells[:-1]:
            outputs(kc, code)
        cases.append({"name": name, "cells": cells, "outputs": outputs(kc, cells[-1])})
    finally:
        kc.stop_channels()
        km.shutdown_kernel(now=True)

out = {"made_by": "test/jupyter_figures_gen.py", "python": sys.version.split()[0], "ipykernel": ipykernel.__version__,
       "matplotlib": matplotlib.__version__,
       "matplotlib_inline": matplotlib_inline.__version__, "cases": cases}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jupyter-figures.json")
with open(path, "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print("wrote", path, len(cases), "cases")
