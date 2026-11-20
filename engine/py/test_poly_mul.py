"""sagebrush.poly.mul (the engine's poly_mul: Kronecker substitution on one
NTT product, admitted before any allocation) against Python's exact integer
arithmetic, on many shapes: tiny, square, unbalanced, huge and negative
coefficients, cancellation, zero factors; and sagebrush.poly.qmul (qpoly_mul,
over QQ: the common denominators, the product and each coefficient's
reduction in the engine) against Fraction arithmetic.  Past the caps the engine refuses,
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


def qcoef(r, nbits, dbits):
    from fractions import Fraction
    d = r.getrandbits(dbits) + 1 if dbits else 1
    return Fraction(coef(r, nbits), d)


def coef(r, bits):
    x = r.getrandbits(bits) if bits else 0
    return -x if r.random() < 0.5 else x


def qclear_checks(r):
    """sagebrush.poly.qclear (the engine's qpoly_clear): (d, the integers of
    d f) with d the lcm of the nonzero coefficients' denominators as given,
    one integer per coefficient, in order, trailing zeros kept; against
    Fraction arithmetic.  Coefficients of any type but exactly int and
    Fraction (and Sage's own Integer, Rational and the int a Rational's
    numerator() returns) are refused before any of
    their properties, formatting or the engine's bridge is reached."""
    from fractions import Fraction
    from math import lcm
    from sagebrush import _engine as E

    def ref(c):
        d = 1
        for x in c:
            if x:
                d = lcm(d, Fraction(x).denominator)
        return d, [int(Fraction(x) * d) for x in c]
    n = 0
    shapes = [[], [0], [0, 0, 0], [5], [Fraction(-3, 7)], [Fraction(1, 2), Fraction(1, 3), Fraction(1, 6)],
              [Fraction(1, 2), 0, 0], [3, -2, 1], [Fraction(2 ** 200 + 1, 3 ** 90), -(2 ** 150), Fraction(1, 2 ** 70), 0]]
    for la, nb, db in [(10, 8, 8), (100, 63, 20), (300, 30, 3)]:
        shapes.append([qcoef(r, nb, db) for _ in range(la)])
    for c in shapes:
        assert P.qclear(c) == ref(c), c[:5]
        n += 1
    # (Fractions are always in lowest terms here; zero is 0, whose
    # denominator takes no part)
    assert P.qclear([0, Fraction(1, 3)]) == (3, [0, 1])
    # (exact types only: subclasses whose numerator, denominator, format or
    # __class__ are spoofed are refused before any of those runs, and before
    # the bridge is called; bool is refused too)
    touched = []

    class I1(int):
        def __format__(self, spec):
            touched.append("format")
            return "0"

    class I2(int):
        __class__ = property(lambda self: int)

    class F1(Fraction):
        @property
        def numerator(self):
            touched.append("numerator")
            return 1

    class F2(Fraction):
        @property
        def denominator(self):
            touched.append("denominator")
            return 1

    class F3(Fraction):
        def __format__(self, spec):
            touched.append("format")
            return "0"

    class F4(Fraction):
        __class__ = property(lambda self: Fraction)

    class F5(Fraction):
        def __getattribute__(self, attr):
            touched.append(attr)
            return Fraction.__getattribute__(self, attr)
    name = "_sbengine" if hasattr(E, "_sbengine") else "_native"
    real = getattr(E, name)
    calls = []

    class Spy:
        def call(self, text):
            calls.append(text)
            return '{"ok":{"d":"1","c":""}}'
    setattr(E, name, Spy())
    try:
        for bad in [I1(3), I2(3), F1(1, 2), F2(1, 2), F3(1, 2), F4(1, 2), F5(1, 2), True, 1.5, "1", None]:
            try:
                P.qclear([1, bad])
            except TypeError as e:
                assert "qclear" in str(e), e
            else:
                raise AssertionError("accepted %r" % (bad,))
            n += 1
    finally:
        setattr(E, name, real)
    assert calls == [] and touched == [], (calls, touched)
    # (Sage's own Integer and Rational, and the int numerator() returns, are
    # accepted)
    try:
        import sagebrush.sage as S
    except ImportError:
        import sage_all as S
    q = S.QQ(5) / 7
    assert P.qclear([S.Integer(3), q, q.numerator()]) == (7, [21, 5, 35])
    return n


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
    # over QQ: qmul against Fraction arithmetic, lowest terms and int for an
    # integral coefficient (as Fraction's own arithmetic normalizes)
    from fractions import Fraction

    def qnorm(c):
        return [int(x) if x.denominator == 1 else x for x in map(Fraction, c)]
    qshapes = [(1, 1, 1, 1, 1, 1), (3, 8, 2, 5, 8, 3), (20, 64, 70, 30, 40, 1), (7, 200, 100, 9, 1, 130),
               (60, 1, 2, 60, 1, 2), (5, 300, 300, 5, 300, 300)]
    for la, na, da, lb, nb, db in qshapes:
        for _ in range(3):
            a = [qcoef(r, na, da) for _ in range(la)]
            b = [qcoef(r, nb, db) for _ in range(lb)]
            got = P.qmul(a, b)
            assert got == qnorm(reference(a, b)), (la, na, da, lb, nb, db)
            assert all(type(x) is int or x.denominator > 1 for x in got)
            n += 1
    for a, b in [([], [Fraction(1, 2)]), ([0, 0], [Fraction(1, 3)]), ([Fraction(1, 2)] * 40, [Fraction(-1, 2)] * 30),
                 ([Fraction(1, 3), Fraction(2, 3)], [3, -3]), ([Fraction(-7, 2 ** 70)], [2 ** 70]), ([1, 2, 3], [4, 5])]:
        assert P.qmul(a, b) == qnorm(reference(a, b)), (a, b)
        n += 1
    # many distinct coprime denominators: refused by the lcm's metered work,
    # naming it
    try:
        P.qmul([Fraction(1, (1 << 62) + 2 * i + 1) for i in range(20000)], [Fraction(1, 3)])
    except ValueError as e:
        assert "the denominators' lcm needs more than" in str(e), e
    else:
        raise AssertionError("20000 coprime denominators were admitted")
    # Sage mode's products go through it (ZZ[x] by poly_mul, QQ[x] by qpoly_mul)
    try:
        import sagebrush.sage as S
    except ImportError:
        import sage_all as S
    R = S.PolynomialRing(S.QQ, "x")
    x = R.gen()
    f = (x + Fraction(1, 2)) * (x - Fraction(1, 3)) * (3 * x + 1)
    assert list(f) == [Fraction(-1, 6), Fraction(-1, 3), Fraction(3, 2), 3], list(f)
    n += qclear_checks(r)
    print("poly_mul against exact products: %d cases ok" % n)


if __name__ == "__main__":
    main()
