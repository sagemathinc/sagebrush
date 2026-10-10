"""Canonical heights on balls (engine/ap/src/height.rs) against Sage's
(P.height(precision=400), make_heights_*.sage: random curves through a
point, close and nearly real roots, multiples up to 12P and translates by
torsion): every enclosure must hold Sage's value and be accurate to about
prec bits; and the index bound of [kP] must be at least k (it is 1, 2-3 and
4-5 for k = 1, 2, 3 on these curves).

    engine/.venv/bin/python engine/ap/oracle/check_heights.py
"""

import json, os, sys
from decimal import Decimal, getcontext
from fractions import Fraction as F

from sagebrush.sage import *  # noqa: F401,F403 (sets up the library)
from sagebrush._sagelib import _sage_ec as ec

getcontext().prec = 130
L = [json.loads(l) for l in open(os.path.join(os.path.dirname(__file__), "heights.jsonl"))]
bad = 0
for prec, tol, width in ((128, F(1, 10 ** 118), 2.0 ** -120), (360, F(1, 10 ** 118), 2.0 ** -350)):
    worst = 0
    for d in L:
        P = (F(d["x"]), F(d["y"]))
        h = F(Decimal(d["h"]))
        lo, hi = ec.canonical_height_ball(d["a"], P, d["bad"], prec)
        if not lo - tol <= h <= hi + tol:
            bad += 1
            print("NOT CONTAINED", prec, d["a"], d["x"])
        worst = max(worst, float(hi - lo) / max(1.0, float(h)))
    if worst > width:
        bad += 1
        print("TOO WIDE", prec, worst)
    print("prec", prec, len(L), "heights, widest relative", "%.3g" % worst)
seen = set()
for d in L:
    if tuple(d["a"]) in seen or len(seen) >= 40:
        continue
    seen.add(tuple(d["a"]))
    P = (F(d["x"]), F(d["y"]))
    Q = None
    for k in (1, 2, 3):
        Q = ec.add(d["a"], Q, P)
        n, T = ec.index_bound(d["a"], [Q], d["bad"])
        if n is None or n < k:
            bad += 1
            print("INDEX BOUND", d["a"], k, n)
print(len(seen), "curves: index bounds of [P], [2P], [3P] checked")
sys.exit(1 if bad else 0)
