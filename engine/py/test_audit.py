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
# F6: proof=True is honored (a proven answer, or NotImplementedError), and
# results say what they assume
from sagebrush.sage import QuadraticField, NumberField, polygen, QQ, ZZ, factor
xx = polygen(QQ, "x")
assert QuadraticField(-5, "a").class_number(proof=True) == 2
assert NumberField(xx**2 + 23, "a").class_group(proof=True).order() == 3
assert "GRH" in raises(NotImplementedError, NumberField(xx**3 - 11, "a").class_number, proof=True)
assert "GRH" in raises(NotImplementedError, QuadraticField(10, "a").regulator, proof=True)
assert QuadraticField(-5, "a").class_number() == 2
assert ZZ(2**61 - 1).is_prime(proof=True) and not ZZ(2**127 - 3).is_prime(proof=True)
assert "BPSW" in raises(NotImplementedError, ZZ(2**127 - 1).is_prime, proof=True)
assert ZZ(2**127 - 1).is_prime() and ZZ(2**127 - 1).is_prime(proof=False)
raises(NotImplementedError, factor, (2**127 - 1) * 3, proof=True)
assert nf.bnf([5, 0, 1])["assumes"] == ["GRH"]
# second review R3: a translated model of Q(i), certified roots and signature
zz = polygen(QQ, "z")
K = NumberField((zz - 10**8) ** 2 + 1, "a")
assert K.signature() == (0, 1)
U = K.unit_group(proof=True)
assert (U.rank(), U.torsion_generator_order()) == (0, 4)
assert nf.complex_roots([10**16 + 1, -2 * 10**8, 1], 30) == [
    ("100000000.000000000000000000000", "-1.00000000000000000000000000000", 1),
    ("100000000.000000000000000000000", "1.00000000000000000000000000000", 1)]
d = nf.nf_data([-89677, 9416, -531841, 2, 72857, 1])
assert (d["r1"], d["r2"], d["w"], d["w_proven"]) == (3, 1, 2, True)
# second review R4: proof=True through rationals (numerator and denominator)
from sagebrush.sage import QQ
raises(NotImplementedError, factor, QQ(2**127 - 1) / 2, proof=True)
raises(NotImplementedError, factor, QQ(2) / (2**127 - 1), proof=True)
assert str(factor(QQ(2**61 - 1) / 6, proof=True)) == "2^-1 * 3^-1 * 2305843009213693951"
# R5: zero after reduction, composite moduli
raises(ValueError, nf.factor_mod, [4, 8, 4], 2)
raises(ValueError, nf.factor_mod, [-1, 0, 1], 4)
# F11: checked newforms say so
r = modsym.rational_newforms(11, 20, details=True)
assert r["status"] == "checked" and len(r["checks"]) == 2 and r["forms"][0][:2] == [(2, -2), (3, -1)]
# third review: T2, T3 (no finite value), T5 (limits), T6 (small roots), bnf's w
from sagebrush.sage import cosh, I, limit, exp as sexp
for f, a, b in [(1 / cosh(I * x) ** 2, 0, pi), (1 / (10**12 * cos(x + 10**20) ** 2), 0, pi)]:
    try:
        r = integrate(f, x, a, b)
        assert "integrate" in str(r), r
    except ValueError as e:
        assert "divergent" in str(e)
assert str(limit(abs(x - 10**20), x=oo)) in ("+Infinity", "Infinity")
assert limit(sexp(-abs(x - 10**20)), x=oo) == 0
assert limit(abs(x), x=QQ(1) / 10**20, dir="-") > 0
assert nf.complex_roots([-1, 10**100], 30)[0][0] == "1.00000000000000000000000000000e-100"
b = nf.bnf([1, 0, 1])
assert b["w"] == 4 and b["w_proven"] and b["assumes"] == ["GRH"]
print("audit regressions: ok")
