"""Regression tests for the 2026-10-09 audit (wrong answers and invalid
inputs through the public APIs): python engine/py/test_audit.py.  A wrong
answer is never acceptable; refusing (an error, or an unevaluated result)
is."""

from fractions import Fraction

from sagebrush import ap, linalg, modsym, nf
from sagebrush.sage import GF, integrate, pi, var, oo


def raises(exc, f, *args, **kwds):
    try:
        r = f(*args, **kwds)
    except exc as e:
        return str(e)
    raise AssertionError("%s%r returned %r, expected %s" % (f.__name__, args, r, exc.__name__))


# F1: an unsplit composite is never reported as a prime factor
n = (2**521 - 1) * (2**607 - 1)
assert "1128 bits" in raises(ValueError, nf.factor_integer, n)
for m in [2**64 + 1, 1000000016000000063, 600851475143, -60]:
    fs = nf.factor_integer(m)
    assert all(nf.is_prime(p) for p, _ in fs)
    prod = 1
    for p, e in fs:
        prod *= p**e
    assert prod == abs(m), (m, fs)
assert [nf.is_prime(k) for k in (-7, -1, 0, 1, 2, 7)] == [False, False, False, False, True, True]

# F2: traces of Frobenius with large coefficients agree with point counting
a = [2000000, 0, 0, 1, 0]


def count(p):
    a1, a2, a3, a4, a6 = a
    t = 0
    for x in range(p):
        d = ((a1 * x + a3) ** 2 + 4 * (x**3 + a2 * x * x + a4 * x + a6)) % p
        t += 0 if d == 0 else (1 if pow(d, (p - 1) // 2, p) == 1 else -1)
    return -t


for p in [991, 997, 1009, 1013, 1019, 1031, 10007]:
    assert ap.ap(a, p) == count(p), p

# F3: definite integrals across singularities
x = var("x")
for f, lo, hi in [(1 / x**2, 1, -1), (1 / x**2, -1, 1), (1 / (x**3 - 2), 0, 2), (x / (x**2 - 3), 1, 2)]:
    assert "divergent" in raises(ValueError, integrate, f, x, lo, hi)
from sagebrush.sage import cos, sqrt, tan
assert "divergent" in raises(ValueError, integrate, 1 / cos(x) ** 2, x, 0, pi)
assert "divergent" in raises(ValueError, integrate, tan(x), x, 0, pi)
assert integrate(1 / (2 + cos(x)), x, 0, 2 * pi) == 2 * pi / sqrt(3)
assert integrate(1 / (5 - 4 * cos(x)), x, 0, 2 * pi) == 2 * pi / 3
assert integrate(1 / (1 + x**2), x, -oo, oo) == pi

# F4: a finite field's modulus is irreducible of the right degree
assert "irreducible" in raises(ValueError, GF, 4, "a", modulus=[0, 0, 1])
assert "degree" in raises(ValueError, GF, 4, "a", modulus=[1, 1, 0, 1])
assert "irreducible" in raises(ValueError, GF, 16, "a", modulus=[1, 0, 1, 0, 1])
F = GF(4, "a", modulus=[1, 1, 1])
assert F.gen() ** 2 == F.gen() + 1

# F5: solve needs a square coefficient matrix
assert "square" in raises(ValueError, linalg.solve, [[1, 2]], [[3]])
assert linalg.solve([[2, 1], [1, 3]], [[1], [2]]) == [[Fraction(1, 5)], [Fraction(3, 5)]]

# F7: invalid inputs are errors, not panics or silent answers
raises(ValueError, nf.hermite_form, [[1, 2], [3]])
raises(ValueError, modsym.level_data, 0)
from sagebrush import mf
for f, args, kw in [(mf.dims, (11, 0), {}), (mf.dims, (11, 1), {}), (mf.characters, (0,), {}),
                    (mf.dims, (15, 2), {"chi": (2, [11, 7], [1])}), (mf.dims, (15, 2), {"chi": (0, [11, 7], [1, 0])})]:
    raises(ValueError, f, *args, **kw)
assert mf.dims(11, 2)["cusp"] == 1
assert nf.hermite_form([[1, 2], [3, 4]]) == [[1, 0], [0, 2]]
print("audit regressions: ok")
