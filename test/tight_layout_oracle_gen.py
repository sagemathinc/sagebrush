"""Record what matplotlib 3.11 does with each case of test/tight_layout_cases.py, and how wide and tall its Agg
renderer measures sample texts, into test/tight-layout-oracle.json, which test/tight-layout.test.ts compares
Sagebrush with (CI has no matplotlib). Run with a CPython that has matplotlib 3.11:

    python3 -I test/tight_layout_oracle_gen.py
"""
import json
import os
import random
import warnings

import matplotlib

matplotlib.use("agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.font_manager import FontProperties  # noqa: E402

here = os.path.dirname(os.path.abspath(__file__))
ns = {}
exec(open(os.path.join(here, "tight_layout_cases.py")).read(), ns)

rows = {}
for cid, code in ns["CASES"]:
    g = {}
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        exec(ns["PRELUDE"] + code, g)
    rows[cid] = {"out": g["out"], "warnings": [str(x.message) for x in w]}

# texts as tick labels and titles have them, and random ones of every character the metrics table has
renderer = plt.figure().canvas.get_renderer()
rng = random.Random(1872)
chars = "".join(chr(c) for c in range(32, 127)) + "−"
samples = ["0", "10", "−2.5", "0.0", "1000", "1e-05", "apple", "Revenue", "time (s)", "Ly", "AVAWAY", "r.F"]
samples += ["".join(rng.choice(chars) for _ in range(rng.randint(1, 9))) for _ in range(150)]
texts = []
for size in [5.79, 6.94, 8.33, 10.0, 12.0, 14.4, 17.28]:
    fp = FontProperties(size=size)
    for s in samples:
        w, h, d = renderer.get_text_width_height_descent(s, fp, ismath=False)
        texts.append([s, fp.get_size_in_points(), w, h - d, d])
plt.close("all")

json.dump({"versions": {"matplotlib": matplotlib.__version__}, "rows": rows, "texts": texts},
          open(os.path.join(here, "tight-layout-oracle.json"), "w"), indent=0, ensure_ascii=False)
