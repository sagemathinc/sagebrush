#!/usr/bin/env python3
"""The golden input check: every backend present on this host builds the
same operands for every row, in each of its K input variants (each driver has its own input generator, in
its own language).  python3 bench/core/test_inputs.py [--size s]

run.py makes the same check before each point it measures; this runs it
alone, quickly, at the small size."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--size", default="s")
args = ap.parse_args()
rows = json.loads((run.HERE / "items.json").read_text())["rows"]
bad = 0
for row in rows:
    n, k = row["sizes"][args.size]["n"], run.variants(row, args.size)
    hashes = {}
    for b in [b for b in run.BACKENDS.split(",") if not b.endswith("-n")]:
        if run.command(b, row, n, "inputs", k):
            r = run.invoke(b, row, n, "inputs", row["sizes"][args.size]["timeout"], k)
            hashes[b] = r.get("input_hash") or r["status"]
    ok = len(set(hashes.values())) == 1 and all(h.isdigit() for h in hashes.values())
    bad += not ok
    print(("ok  " if ok else "BAD ") + row["id"], n, "K=%d" % k, hashes, flush=True)
print("all inputs agree" if not bad else f"{bad} row(s) disagree")
sys.exit(1 if bad else 0)
