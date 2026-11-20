"""sagebrush.poly.mul (the engine's poly_mul: Kronecker substitution on one
NTT product, admitted before any allocation) against Python's exact integer
arithmetic, on many shapes: tiny, square, unbalanced, huge and negative
coefficients, cancellation, zero factors.  Past the caps the engine refuses,
naming the cap: the quadratic shape (many one-digit coefficients times one
huge one) is refused before any allocation.  Runs on CPython and in pyjs:

    python engine/py/test_poly_mul.py
    node dist/src/cli.js engine/py/test_poly_mul.py
"""
import random

import sagebrush.poly as P


def reference(a, b):
    # (the test's own schoolbook product, the reference; trailing zeros dropped)
    if not a or not b:
        return []
    c = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            c[i + j] += x * y
    while c and c[-1] == 0:
        c.pop()
    return c


def coef(r, bits):
    x = r.getrandbits(bits) if bits else 0
    return -x if r.random() < 0.5 else x


def main():
    r = random.Random(1234)
    shapes = [(1, 1, 1, 1), (3, 8, 3, 8), (1, 8, 40, 8), (7, 64, 5, 63), (40, 65, 41, 1), (120, 64, 90, 200),
              (500, 8, 4, 64), (8, 4096, 8, 4096), (2, 20000, 3, 9), (600, 1, 700, 2)]
    n = 0
    for la, ba, lb, bb in shapes:
        for _ in range(3):
            a = [coef(r, ba) for _ in range(la)]
            b = [coef(r, bb) for _ in range(lb)]
            assert P.mul(a, b) == reference(a, b), (la, ba, lb, bb)
            n += 1
    edge = [([], [1, 2]), ([0, 0], [1, 2]), ([1, 1], [1, -1]), ([-1, -2, -3], [-4, -5]),
            ([2 ** 64 - 1], [2 ** 64 - 1]), ([-(2 ** 63)], [2 ** 63]), ([0, 0, 5], [0, 3]), ([1] * 33, [-1] * 31)]
    for a, b in edge:
        assert P.mul(a, b) == reference(a, b), (a, b)
        n += 1
    # the quadratic shape: refused, naming the cap, before any allocation
    try:
        P.mul([1] * (1 << 16), [(1 << 600000) - 1])
    except ValueError as e:
        assert "the product's bits" in str(e) and "a smaller product per call" in str(e), e
    else:
        raise AssertionError("a 2^25-bit-plus product was admitted")
    # Sage mode's products go through it (over QQ by the common denominators)
    from fractions import Fraction
    try:
        import sagebrush.sage as S
    except ImportError:
        import sage_all as S
    R = S.PolynomialRing(S.QQ, "x")
    x = R.gen()
    f = (x + Fraction(1, 2)) * (x - Fraction(1, 3)) * (3 * x + 1)
    assert list(f) == [Fraction(-1, 6), Fraction(-1, 3), Fraction(3, 2), 3], list(f)
    print("poly_mul against exact products: %d cases ok" % n)


if __name__ == "__main__":
    main()
