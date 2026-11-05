# math.sumprod (CPython 3.14's math_sumprod_impl, ported) on Sagebrush, compared with what CPython 3.14 prints: the int, float
# and generic paths, the order they join the result, int64 overflow, non-finite values, extremes and subnormals.
from math import sumprod
from fractions import Fraction as F
import random


def show(p, q):
    try:
        r = sumprod(p, q)
        print(type(r).__name__, repr(r))
    except Exception as e:
        print(type(e).__name__, e)


fixed = [
    ((), ()), ([1, 2], [3, 4]), ([1.5, 2], [3, 4]), ([F(1, 3), 2], [3, F(1, 2)]), ([True, 2], [3, 4]),
    ([1e308, 1e308], [10, -10]), ([0.1] * 10, [0.1] * 10), ([1e16, 1, -1e16], [1, 1, 1]),
    ([2**70, 1.0], [3, 1]), ([1, 2.5], [3, 1j]), (iter([1, 2]), iter([3, 4])),
    ([float('inf'), 1], [1, 1]), ([float('inf')], [0.0]), ([float('nan')], [1]), ([1e308], [10]),
    ([1e200, -1e200], [1e200, 1e200]), ([1, 2], [3]), ([1], [2, 3]), ([1], [None]), (['a'], [2]),
    ([2**62, 2**62], [2, 2]), ([2**63 - 1], [1]), ([2**63], [1]), ([-2**63], [1]), ([2**32, 2**32], [2**31, 2**31]),
    ([1.0, 2, 3.0], [True, False, 2]), ([1e300, 1e-300], [1e300, 1e-300]), ([5e-324, 1.0], [0.5, 1e-300]),
    ([1e-310, 3.0], [1e-10, 7.0]), ([2.0**-1074], [2.0**1023]), ([1e308, -1e308, 1.0], [1.0, 1.0, 1e-300]),
    ([1, 1.0, 1, 1.0], [1, 1.0, 1, 1.0]), ([F(1, 2), 0.25], [2, 4]), ([10**30, 0.5], [10**30, 2.0]),
    ([1.0, 2**1024], [1.0, 1]), ([2**1023 * 1.5, 1.0], [1, 1.0]),
]
for p, q in fixed:
    show(p, q)

rng = random.Random(20261105)
for trial in range(400):
    n = rng.randrange(0, 40)
    kind = trial % 8

    def x():
        if kind == 0:
            return rng.uniform(-1, 1)
        if kind == 1:
            return rng.uniform(-1, 1) * 10 ** rng.randrange(-320, 309)
        if kind == 2:
            return rng.choice([rng.uniform(-1e3, 1e3), rng.randrange(-10**6, 10**6)])
        if kind == 3:
            return rng.choice([rng.uniform(-1, 1), rng.randrange(-5, 5), True, False])
        if kind == 4:
            return rng.uniform(-1, 1) * 2.0 ** rng.randrange(-1074, 1000)
        if kind == 5:
            return rng.choice([rng.randrange(-2**64, 2**64), rng.uniform(-1e10, 1e10)])
        if kind == 6:
            return rng.choice([1e16, -1e16, 1.0, -1.0, 0.5, 3, 1e-16])
        return rng.choice([rng.uniform(-1, 1), F(rng.randrange(-9, 9), rng.randrange(1, 9))])

    show([x() for _ in range(n)], [x() for _ in range(n)])
