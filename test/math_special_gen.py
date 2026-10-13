"""CPython's values of math.erf, erfc, gamma, lgamma, exp2, nextafter and ulp,
for test/math-special.test.ts: `python3 test/math_special_gen.py` writes
test/math-special-cpython.json (CPython 3.14 on glibc 2.43, whose erf, erfc
and exp2 they call; gamma and lgamma are CPython's own).

Each value is float.hex() of the result, or "!" and the exception's type."""

import json
import math
import random

random.seed(20261013)


def rnd(lo, hi, n):
    return [random.uniform(lo, hi) for _ in range(n)]


inputs = {
    "erf": rnd(-7, 7, 300) + rnd(-1e-6, 1e-6, 20) + [0.0, -0.0, 0.84375, 1.25, 2.857142857142857, 6.0, 28.0, 1e-300, math.inf, -math.inf],
    "erfc": rnd(-7, 30, 300) + [0.0, 0.25, 0.84375, 1.25, 27.9, 28.0, 40.0, -6.0, math.inf, -math.inf],
    "gamma": rnd(-40, 171, 250) + rnd(0, 3, 50) + [0.5, 1.5, 23.5, 170.5, 171.5, 172.0, 1e-20, -1e-20, 1e-300, -170.5,
                                                    0.0, -0.0, -1.0, -2.0, math.inf, -math.inf],
    "lgamma": rnd(-50, 300, 250) + rnd(0, 3, 50) + [10.0 ** random.uniform(2, 300) for _ in range(20)]
    + [1.0, 2.0, 0.5, 1e-300, -0.5, 2.5e305, 0.0, -1.0, -3.0, math.inf, -math.inf],
    "exp2": rnd(-1080, 1030, 300) + rnd(-2, 2, 100) + [0.0, -0.0, 0.5, 10.0, -1074.0, -1075.0, -1022.5, 1023.0, 1023.99,
                                                        1024.0, math.inf, -math.inf],
}

out = {}
for name, xs in inputs.items():
    f = getattr(math, name)
    rows = []
    for x in xs:
        try:
            rows.append([x.hex(), f(x).hex()])
        except (ValueError, OverflowError) as e:
            rows.append([x.hex(), "!" + type(e).__name__])
    out[name] = rows

# nextafter and ulp: exact
pairs = [(1.0, 2.0), (1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (-0.0, 1.0), (-5e-324, 1.0), (5e-324, -1.0), (math.inf, 0.0),
         (1.7976931348623157e308, math.inf), (-1.5, -math.inf), (2.0, 2.0), (-0.0, 0.0), (0.0, -0.0)]
out["nextafter"] = [[a.hex(), b.hex(), math.nextafter(a, b).hex()] for a, b in pairs]
steps = [(1.0, 2.0, 3), (1.0, 1.0000000000000004, 10), (5e-324, -1.0, 2), (-5e-324, 1.0, 3), (1.0, 0.0, 0),
         (-2.0, 3.0, 2 ** 64), (0.0, 1.0, 2 ** 52)]
out["nextafter_steps"] = [[a.hex(), b.hex(), n, math.nextafter(a, b, steps=n).hex()] for a, b, n in steps]
ulps = [1.0, 0.0, -3.5, 1.7976931348623157e308, math.inf, 5e-324, 1e-310, 123456.789, 2.0 ** 1023]
out["ulp"] = [[x.hex(), math.ulp(x).hex()] for x in ulps]

with open("test/math-special-cpython.json", "w") as fh:
    json.dump(out, fh, indent=0)
print({k: len(v) for k, v in out.items()})
