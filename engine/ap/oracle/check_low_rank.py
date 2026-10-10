"""The exported enclosure of L^(r)(E,1) from sagebrush.ap.low_rank must hold
the true value (PARI's ellL1 at 60 digits; the review's ECBALL-F3: a
midpoint and a radius rounded separately did not).

    engine/.venv/bin/python engine/ap/oracle/check_low_rank.py
"""

import sys
from decimal import Decimal
from fractions import Fraction as F

from sagebrush.sage import *  # noqa: F401,F403
from sagebrush import ap

CASES = [  # a-invariants, conductor, rank, ellL1(E, rank) at 60 digits
    ([0, -1, 1, -10, -20], 11, 0, "0.253841860855910684337758923350909461043898448366121733593427"),
    ([0, 0, 1, -1, 0], 37, 1, "0.305999773834052301820483683321676474452637774590771998534542"),
]
bad = 0
for a, N, rank, ref in CASES:
    r = ap.low_rank([int(c) for c in EllipticCurve(a).anlist(3000)], N)
    v = F(Decimal(ref))
    ok = r is not None and r["rank"] == rank and r["lo"] - F(1, 10 ** 59) <= v <= r["hi"] + F(1, 10 ** 59) and r["hi"] - r["lo"] < F(1, 10 ** 18)
    bad += not ok
    print(a, "ok" if ok else "FAIL", r and float(r["hi"] - r["lo"]))
sys.exit(1 if bad else 0)
