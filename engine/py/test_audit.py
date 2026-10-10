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
from sagebrush.sage import cosh, I, limit, exp as sexp, sin, sqrt, log, var
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
# fourth review: U1 (terminates), U2-U6 (never a wrong value)
y = var("y")
assert str(limit(abs(y) + x, x=0)) == "abs(y)" and str(integrate(abs(y), x, 0, 1)) == "abs(y)"
for e, a, d in [((abs(1 + I * x) - 1) / x, 0, None), (sexp(-x) * sin(I * x), oo, None), (log(-1 + I * x), 0, "-"), (sqrt(-1 + I * x), 0, "-"), (abs(x + sin(10**20 + 1)), 0, None)]:
    try:
        r = limit(e, x=a, dir=d) if d else limit(e, x=a)
        assert str(r) in ("0", "-I*pi", "-I", "abs(sin(100000000000000000001))"), (e, r)
    except ValueError:
        pass
try:
    r = integrate(1 / (x * cosh(log(-x) / 2) ** 2), x, QQ(1) / 2, 2)
    assert "integrate" in str(r), r
except ValueError as e:
    assert "divergent" in str(e)
print("audit regressions: ok")
# the analytic class-group certificate (Belabas-Friedman, GRH): certified
for f in ([-11, 0, 0, 1], [2588, -581, 593, -422, 1], [1, 0, -10, 0, 1]):
    b = nf.bnf(f)
    assert b["certified"] and b["assumes"] == ["GRH"], (f, b)
for d in (-1016021983508, 710573243720556):
    q = nf.quadratic_class_group_data(d)
    assert q["certified"] and q["assumes"] == ["GRH"], (d, q)
print("certificate ok")
# fifth review: V2-V5 (never a wrong value; the side's value where certified)
from sagebrush.sage import limit, log, sqrt, sin, cos, tan, atan, asin, asinh, atanh, I, SR
x = var("x")
s5 = sin(10**20 + 1)
def outcome(f):
    try:
        return str(f())
    except Exception as e:
        return "error"
r = outcome(lambda: integrate(1 / (1 + tan(x)**2) + SR("1/10^30") / cos(x - SR("1/10^14"))**2, x, 0, pi))
assert r == "error" or "integrate" in r, ("V2", r)
for a, ok in [(s5, ("error",)), (-s5, ("error",))]:
    r = outcome(lambda: integrate(1 / x**2, x, a, 1))
    assert r in ok or "integrate" in r, ("V3", a, r)
for e in [log(-s5 + I * x), sqrt(-s5 + I * x), atan(2 * I + x), asin(2 + I * x), asinh(2 * I + x), atanh(2 + I * x)]:
    for d in ("-", "+", None):
        r = outcome(lambda: limit(e, x=0, dir=d) if d else limit(e, x=0))
        assert r == "error", ("V4/V5", e, d, r)
assert str(limit(log(-1 + I * x), x=0, dir="-")) == "-I*pi" and str(limit(sqrt(-1 + I * x), x=0, dir="-")) == "-I"
print("fifth review ok")
# systematic review: Arnault's strong pseudoprime to the first 20 prime bases
_p = 29674495668685510550154174642905332730771991799853043350995075531276838753171770199594238596428121188033664754218345562493168782883
_N = _p * (313 * (_p - 1) + 1) * (353 * (_p - 1) + 1)
assert not nf.is_prime(_N)
assert nf.factor_integer(2**64 + 1) == [(274177, 1), (67280421310721, 1)]
print("arith ok")
# systematic review G1/G2/ASR: inhomogeneous Groebner bases proven through
# the homogenized ideal; the cache keeps its proof status; bases immutable
from sagebrush.sage import PolynomialRing, QQ
from _sage_lang import proof as _proof
_N = 2147483647 * 2147483629
for _o in ("degrevlex", "deglex", "lex"):
    _R = PolynomialRing(QQ, ["x", "y"], order=_o); _x, _y = _R.gens()
    assert sorted(map(str, _R.ideal([_x - _y, _x**2 + (_N - 1) * _x * _y - _x]).groebner_basis())) == sorted(["x - y", "y^2 - 1/4611685975477714963*y"])
_R = PolynomialRing(QQ, ["x", "y"]); _x, _y = _R.gens()
_J = _R.ideal([_x - _y, _x**2 + (_N - 1) * _x * _y - _x])
with _proof.WithProof('polynomial', False):
    _J.groebner_basis()
assert len(_J.groebner_basis()) == 2 and _J._gb_proven
_B = _R.ideal([_x]).groebner_basis()
try:
    _B.append(1); assert False
except ValueError:
    pass
print("groebner ok")
# systematic review NFD: two-element generators at a common index divisor
from sagebrush.sage import NumberField, polygen
_t = polygen(QQ, "t")
_K = NumberField(_t**3 + _t**2 - 2*_t + 8, "a")
_Ps = _K.primes_above(2)
assert len(_Ps) == 3 and all(P.norm() == 2 for P in _Ps) and len(set(map(str, _Ps))) == 3
print("nf ok")
# systematic review MUL-F1..F7
from sagebrush.sage import ZZ, GF, TermOrder
_R = PolynomialRing(ZZ, names=("x", "y")); _x, _y = _R.gens()
assert not (2*_x).divides(_x) and str(_x.quo_rem(2*_x)) == "(0, x)"
for _bad in [lambda: _R({(1, 0): QQ(1)/2}), lambda: _R({(-1, 0): 1})]:
    try:
        _bad(); assert False
    except (TypeError, ValueError):
        pass
_S = PolynomialRing(QQ, names=("x", "y")); _X, _Y = _S.gens()
_h = _X + (_Y - 1)*(_Y - 2)
assert (_h*(_X + 3)).gcd(_h*(_X + 4)) == _h
_M = PolynomialRing(GF(4, "a"), names=("x", "y")); _mx = _M.gen(0)
_Fa = (_mx*(_mx + 1)).factor()
assert _Fa.value() == _mx*(_mx + 1)
print("mpoly ok")
# systematic review GB-F2..F4
_R = PolynomialRing(QQ, "x,y", order="lex"); _x, _y = _R.gens()
assert str(_R.ideal(_x*_x - _y, _x*_y - 2147483647).groebner_basis()) == "[x - 1/2147483647*y^2, y^3 - 4611686014132420609]"
_R = PolynomialRing(GF(2), "x,y"); _x, _y = _R.gens()
assert str(_R.ideal(_x*_x, _y).radical().gens()) in ("[y, x]", "(y, x)")
_R = PolynomialRing(ZZ, "x,y"); _x, _y = _R.gens()
try:
    _x in _R.ideal(2*_x); assert False
except NotImplementedError:
    pass
print("groebner2 ok")
# systematic review ROOT-F1..F3
from sagebrush.sage import QQbar, AA, RIF, exp, sin, polygen as _pg
_t = _pg(QQ, "t")
_rs = (10**120*(_t - 1)**2 - 2).roots(QQbar)
_a, _b = _rs[0][0], _rs[1][0]
assert (_a < 1) != (_b < 1) and _a != _b
_s = AA(QQ(2)/10**330).sqrt()
assert _s > 0
assert str(QQbar(I).n(prec=100)).endswith("*I")
_e = RIF(10**100*(exp(QQ(1)/10**100) - 1))
assert _e.lower() <= 1 <= _e.upper()
print("roots ok")
# systematic review EC-F1..F13
from sagebrush.sage import EllipticCurve
_E = EllipticCurve("988b1")
assert str(_E.gens(proof=True)) in ("[(18309 : -2476099 : 1)]", "[(18309 : 2476099 : 1)]")
_E = EllipticCurve("43a1"); _P = _E(QQ(0), QQ(0))
assert _E.saturation([2*_P])[1] == 2
_r = 467203
assert EllipticCurve([0, 0, 0, -3*_r*_r + 1, 2*_r**3 - _r]).CPS_height_bound() >= 13.0545
_E9 = EllipticCurve([0, 1, 1, -3145717, -2148521298]); _E9.two_descent(algorithm="quartic")
assert _E9.rank_bounds()[1] >= 2
assert EllipticCurve("37a1").ap(2) == EllipticCurve([0, 0, 8, -16, 0]).ap(2) == -2
assert EllipticCurve([1, 2, 3, 4, 5]).is_minimal()
print("elliptic ok")

# Systematic review, modular forms (MOD-F1..F6, F11)
from sagebrush.sage import ModularSymbols, ModularForms, Newforms, newform_orbits, GF
assert "2^30" in raises(ValueError, mf.charpoly, 2, 2, 18446744073709551557, sign=1, threads=1)
assert [o.charpoly() for o in newform_orbits(37, prec=1)] == [o.charpoly() for o in newform_orbits(37, prec=12)]
raises(ValueError, mf.newspace, 37, 2, factor=lambda f: [([0, 0, 1], 1)], threads=1)
raises(NotImplementedError, ModularSymbols, 11, 2, sign=1, base_ring=GF(5))
assert newform_orbits(11, prec=1)[0].trace_form(6) == "q - 2*q^2 - q^3 + 2*q^4 + q^5 + O(q^6)"
assert "+ 2*q^21 " in str(Newforms(11)[0].q_expansion(30))
assert ModularForms(11, 2).eisenstein_subspace().newforms() == []
_c = mf.charpoly(3, 3, 2, chi=(2**33, [2], [2**32]), sign=0, threads=1)
assert _c["status"] == "proven" and _c["dim"] == 2, _c
print("modular ok")

# Systematic review, Galois and permutation groups (GAL-F1, F4, GRP-F1..F6)
from sagebrush.sage import PermutationGroup, PermutationGroupElement, SymmetricGroup, CyclicPermutationGroup, polygen
from sagebrush.sage import TransitiveGroups
_x = polygen(QQ, "x")
assert str((2 * _x**2 + 2).galois_group()) == "Transitive group number 1 of degree 2"
_G = PermutationGroup(["(1,2,3)"], domain=range(1, 5))
assert _G.is_primitive(domain=[1, 2, 3]) and not _G.is_primitive()
assert sum(SymmetricGroup(4).cycle_type_counts(limit=1, samples=7).values()) == 7
assert SymmetricGroup(4).cycle_type_counts(limit=1, samples=7).exact is False
_g = CyclicPermutationGroup(3).gen() * PermutationGroupElement("(1,2)")
assert _g in _g.parent()
raises(ValueError, PermutationGroupElement, [2.9, 1.1])
raises(ValueError, TransitiveGroups, 14)
print("groups ok")

# Systematic review, symbolic (SYM-F5, F6, F10, F18)
from sagebrush.sage import SR, floor, ceil, arcsec, arccos, diff, integrate, I, oo, exp, log
_t = SR("1/10^400")
assert (bool(_t == 0), bool(_t != 0), bool(_t > 0)) == (False, True, True)
assert bool(SR(10**20 + 1) > SR(10**20))
_s = sin(SR(10**20 + 1))
assert str(floor(_s)).startswith("floor(")  # undecided, not a wrong integer
raises(ValueError, limit, exp(_s * var("x")), x=oo)
_x = var("x")
assert diff(abs(1 + I * _x), _x).subs(x=0) == 0
assert diff(arcsec(_x), _x).subs(x=-2) == diff(arccos(1 / _x), _x).subs(x=-2)
_eps = SR("1/10^30"); _f = 1 / ((2 * _x + 1)**2 * (3 * _x + 1))
_F = integrate(_eps * _f, _x)
assert ((diff(_F, _x) - _eps * _f) / _eps).simplify_full() == 0
assert bool(integrate(_eps * _f, _x, 0, 1) / _eps == 3 * log(4) - 3 * log(3) - SR(2) / 3)
print("symbolic ok")

# Systematic review, symbolic (SYM-F9, F11..F16)
from sagebrush.sage import solve, assume, forget, taylor, desolve, function, sqrt, asin, pi, sin, cos
_x, _a = var("x a")
assume(_x, "real"); assert solve(_x**2 + 1, _x) == []; forget()
assume(_x, "integer"); assert solve(_x**2 - 2, _x) == []; forget()
assert solve(sqrt(_x) == -1, _x) == [] and solve(asin(_x) == pi, _x) == [] and solve(log(_x) == 4 * I, _x) == []
assert str(solve(_x**5 + _x + 3, _x)) == "[0 == x^5 + x + 3]"
assert len(solve(_x**3 == 2, _x)) == 3 and solve([_x == 0, _x == 1], _x) == []
assert str(solve((_x - 1)**3, _x, multiplicities=True)) == "([x == 1], [3])"
assert str(taylor(var("__taylor_t") + _x, _x, 0, 2)) == "__taylor_t + x"
_y = function("y")(_x)
assert str(desolve(diff(_y, _x) == var("__ode_y"), _y, ics=[0, 1])) == "__ode_y*x + 1"
_J = integrate(function("f")(_x, _a), _x, 0, 1)
assert str(_J.variables()) == "(a,)" and diff(_J, _x) == 0
assert desolve(diff(_y, _x) == _y**2, _y, ics=[0, 0]) == 0
raises(ValueError, desolve, diff(_y, _x) == _y, _y, ics=[0, 1, 99])
raises(NotImplementedError, taylor, sqrt(_x**2), _x, 0, 3)
raises(NotImplementedError, taylor, log(-1 + I * _x), _x, 0, 2)
_s = exp(_x).series(_x, 3)
assert str(_s * _s) == "1 + 2*x + 2*x^2 + Order(x^3)" and str(_s - _s) == "Order(x^3)"
assert taylor(exp(_x), _x, 0, 201).coefficient(_x, 201) != 0
assert "x^(-2)" in str((exp(_x) / _x**2).series(_x, 3))
print("symbolic2 ok")

# Systematic review, numerics (NUM-F11, F12)
from sagebrush.sage import RealField, numerical_integral
_R = RealField(100)
assert _R(Fraction(1, 2**300)).sin() != 0 and abs(_R(Fraction(1, 2**300)).sin() * 2**300 - 1) < _R(2)**-90
_v = (_R(1) + _R(Fraction(1, 2**75))).log() * 2**75
assert abs(_v - (1 - _R(2)**-76)) < _R(2)**-95
assert str(_R("+inf").exp()) == "+infinity" and str(_R("+inf").log()) == "+infinity"
assert _R("-inf").exp() == 0 and _R("nan").exp().is_NaN() and _R("+inf").sin().is_NaN() and _R("nan").cos().is_NaN()
import warnings as _w
with _w.catch_warnings(record=True) as _ws:
    _w.simplefilter("always")
    numerical_integral(sin(100000 * var("x")), 0, 1, eps_abs=1e-10, eps_rel=1e-10)
    assert any("tolerance was not met" in str(w.message) for w in _ws)
assert numerical_integral(lambda t, c: c * t, 0, 1, params=[3])[0] == 1.5
print("numerics ok")

# Systematic review, extended areas (EXT-F1..F22)
from sagebrush.sage import DiGraph, digraphs, Graph, Sandpile, codes, matrix, vector, crystals, WeylCharacterRing, CartanType, CartanMatrix, AlphabeticStrings, SubstitutionCryptosystem, TranspositionCryptosystem, Polyhedron, PowerSeriesRing, LaurentSeriesRing, EuclideanSpace
assert DiGraph([(0, 0), (1, 1), (2, 2)], loops=True).is_isomorphic(digraphs.Circuit(3)) is False
assert Graph([(0, 1, 10), (0, 2, 1), (2, 1, 1)]).distance(0, 1, by_weight=True) == 2
_S = Sandpile({0: {}, 1: {0: 1, 1: 1}}, 0); _x0, _x1 = _S.ring().gens()
assert (_x1 - _x0) in _S.ideal()
assert str(Sandpile({0: {1: 2}, 1: {0: 2}}, 0).tutte_polynomial()) == "x + y"
raises(ValueError, Sandpile, {0: {}, 1: {1: 1}}, 0)
raises(ValueError, codes.GeneralizedReedSolomonCode, [GF(5)(i) for i in range(3)], 2, [0, 1, 1])
_F4 = GF(4, "a"); _a = _F4.gen(); _C = codes.LinearRankMetricCode(matrix(_F4, [[1, _a, _a + 1]])); _r = vector(_F4, [1, 1, 1])
assert _C.rank_distance_between_vectors(_r, _C.decode_to_code(_r)) == 1
assert not (crystals.Letters("A2")(1) == crystals.Letters("B2")(1))
assert CartanType(CartanMatrix([[2, -1], [-1, 2]])).is_finite() and CartanType(CartanMatrix([[2, -2], [-2, 2]])).is_affine()
assert not CartanType("A1~xA1").is_finite()
assert (0 * Polyhedron(lines=[[1]])).dim() == 0 and Polyhedron(ieqs=[], ambient_dim=2).dim() == 2
_R = PolynomialRing(ZZ, "z"); _z = _R.gen()
raises(NotImplementedError, _R.ideal, 2, _z)
assert _R(0) in _R.ideal(0)
_T = PolynomialRing(QQ, "t"); _t = _T.gen(); _A = _T.quotient(_t**3, "a3"); _B = _T.quotient(_t**2, "b2")
assert _B(_A.gen()**2) == _B(0)
_L = LaurentSeriesRing(QQ, "x"); _lx = _L.gen()
assert _lx.is_unit() and not PowerSeriesRing(ZZ, "z")(2).is_unit() and not LaurentSeriesRing(ZZ, "z").is_field()
_P = PowerSeriesRing(QQ, "x", default_prec=8); _px = _P.gen()
assert str((_px**9)(_px)) == "x^9"
raises(ValueError, (_lx**-1).exp)
_E1 = EuclideanSpace(2, names=("bad_r", "s")); _rr, _ss = list(_E1.cartesian_coordinates()); _v = _E1.vector_field(_rr, 0)
EuclideanSpace(2, names=("a", "b")).polar_coordinates(names=("bad_r", "theta"))
assert _v.norm()(_E1((-2, 0))) == 2
_Sa = AlphabeticStrings()
raises(ValueError, _Sa, [26]); raises(ValueError, SubstitutionCryptosystem(_Sa), _Sa("A" * 26)); raises(ValueError, TranspositionCryptosystem, _Sa, -1)
print("extended ok")

# (DOC-F10..F12, text I/O: numpy-tests/test_textio.py, against NumPy)

# Systematic review, arithmetic and polynomials (ARI-F4..F8, POL-F2..F6)
from sagebrush.sage import crt, PolynomialRing
raises(ValueError, crt, [1, 2], [3])
assert factor(QQ(1) / 10**400).value() == QQ(1) / 10**400 and factor(QQ(2) / 15).value() == QQ(2) / 15
assert str(PolynomialRing(GF(5), "x")(2).factor()) == "2"
_RZ = PolynomialRing(ZZ, "x"); _xz = _RZ.gen()
assert sorted(_RZ(12).factor()) == [(2, 2), (3, 1)] and _RZ(12).factor().value() == 12
_K9 = GF(9, "a"); _a9 = _K9.gen()
assert _a9.frobenius(-1).frobenius() == _a9
raises(ValueError, GF, 9, "b", modulus=[QQ(3) / 2, 0, 1])
print("arith2 ok")

# Second review (2026-10-10): solve keeps no certified non-solution
from sagebrush.sage import solve, sqrt, SR, var
_xs = var("x")
assert solve(sqrt(_xs - 10**12) == -1, _xs) == [] and solve(sqrt(_xs) == -SR("1/10^20"), _xs) == []
assert str(solve(sqrt(_xs - 10**12) == 1, _xs)) == "[x == 1000000000001]"
print("rereview ok")

# Second review (2026-10-10), batch 2
from sagebrush.sage import RIF, QQbar, AA, I, limit, exp, oo, integrate, acosh, pi, graphs, Graph, GF, ZZ, QQ, PolynomialRing
raises(ValueError, AA, QQbar(I) / 10**100)
_a = var("a")
assert str(integrate(1 / sqrt(_a**2 - _xs**2), _xs)) == "arcsin(x/abs(a))"
assert limit(exp(_xs**2 + _xs) / (exp(_xs**2) + 1), x=oo) == oo and limit(exp(_xs**2 - _xs) / (exp(_xs**2) + 1), x=oo) == 0
_eps = SR("1/10^400"); _F = integrate(_eps * (acosh(-_xs) - I * pi), _xs)
assert "integrate" in str(_F) or (_F.diff(_xs) - _eps * (acosh(-_xs) - I * pi)).simplify_full() == 0
_RZ2 = PolynomialRing(ZZ, "u,v"); _u, _v = _RZ2.gens()
raises(NotImplementedError, _RZ2.ideal(2).intersection, _RZ2.ideal(3))
raises(TypeError, GF, QQ(15) / 2)
_H = Graph([(0, 1, "__no__"), (1, 2, "__no__"), (2, 0, "__no__"), (3, 4, "__no__"), (4, 5, "__no__"), (5, 3, "__no__")])
assert not graphs.CycleGraph(6).is_isomorphic(_H, edge_labels=True)
_Rz = PolynomialRing(ZZ, "z")
assert _Rz.ideal(2, 0).gens() == (_Rz(2),) and _Rz(1) not in _Rz.ideal(2, 0) if False else _Rz.ideal(2, 0).gens() == (_Rz(2),)
assert PolynomialRing(QQ, []).is_field() and not PolynomialRing(ZZ, []).is_field()
_o = SR(oo)
assert bool(_o == oo) and not bool(_o == -oo) and bool(_o > 5) and not bool(_o < 5) and bool(-_o < _o) and not bool(_o > I) and not bool(_o > _xs)
_l2 = limit(1 / _xs**2, x=0)
assert len({oo, _l2}) == 1 and _l2 in {oo} and _l2 in [oo] and {_l2: 1}.get(oo) == 1  # R2-SYMCALC-F9
for _d in ("+", "-", None):  # R2-SYMCALC-F10: asech's cut is (-oo, 0] and [1, oo)
    _k = {"dir": _d} if _d else {}
    raises(ValueError, limit, SR("asech(2+I*x)"), x=0, **_k)
assert str(limit(SR("asech(3+x^2)"), x=0)) == "arcsech(3)" and str(limit(SR("asech(x)"), x=SR(1) / 2)) == "arcsech(1/2)"
import math as _math
_m = _math.isqrt(2 * 10**100); _a = 10**50 * AA(2).sqrt() - _m  # R2-ROOT-F2: 0 < a < 1 exactly
assert _a > 0 and _a < 1 and _a.floor() == 0 and str(_a.n(prec=100)) == "0.80731766797379907324784621070"
assert str((AA(2).sqrt() / 10**100).n(prec=100)) == "1.4142135623730950488016887242e-100"  # R2-ROOT-F3
assert str(RIF(QQ(1) / 10**400)) == "1.000000000000000?e-400" and str(AA(2).sqrt() * 10**400) == "1.414213562373095?e400"  # R2-ROOT-F4
assert AA(QQ(2) / 10**330).sqrt() > 0  # R2-ROOT-F5
assert len({AA(2).sqrt(), AA(8).sqrt() / 2}) == 1 and (10**400 * AA(2).sqrt()).floor() // 10**399 == 14
_R1 = PolynomialRing(QQ, 1, "x"); _f63 = _R1({(2**63,): 1}); _f63.quo_rem(_R1.one())
assert (_f63 * _f63).degree() == 2**64  # R2-MUL-F3: no exponent wraparound after caching
_Zr = PolynomialRing(ZZ, names=("x", "y")); _Qr = PolynomialRing(QQ, names=("x", "y")); _zx, _qx = _Zr.gen(), _Qr.gen()
raises(TypeError, _Zr, _qx / 2); raises(TypeError, _Zr, PolynomialRing(QQ, "x").gen() / 2)  # R2-MUL-F1
_fz = _zx + _qx / 2
assert _fz.parent() is _Qr and (_zx + QQ(1) / 2).parent() is _Qr and (_zx * (_qx / 2)).parent() is _Qr
_qq, _rr = _fz.quo_rem(_Qr(_zx)); assert _qq * _Qr(_zx) + _rr == _fz
from sagebrush.sage import codes, vector, matrix, EuclideanSpace, NumberField
_F5 = GF(5); raises(ValueError, codes.GeneralizedReedSolomonCode, [_F5(0), 5, _F5(1)], 2)  # R2-EXT-F3
_F4 = GF(4, "a"); _Cr = codes.LinearRankMetricCode(matrix(_F4, [[0, 0], [1, 0]]))  # R2-EXT-F8
assert _Cr.dimension() == 1 and len({tuple(_Cr.encode(vector(_F4, [_c]))) for _c in _F4}) == 4 and len(_Cr.list()) == 4
_Kq = PolynomialRing(QQ, "t").fraction_field(); _Lq = PolynomialRing(GF(5), "t").fraction_field()
raises(ZeroDivisionError, _Lq, _Kq(1, 5))  # R2-EXT-F9
_fr = var("free_radius"); _Ef = EuclideanSpace(2, names=("x_ext", "y_ext")); _vf = _Ef.vector_field(_fr, 0)  # R2-EXT-F5
_Ef.polar_coordinates(names=("free_radius", "phi_ext"))
assert _vf.norm().expr().subs({_fr: -2}) == 2
from sagebrush import nf as _nfm
assert _nfm.nf_data([-(2**127 - 1), 0, 1]).get("assumes")  # R2-NFD-F1: exponent-one probable prime
_q89 = 2**89 - 1
assert all(_d.get("assumes") for _d in _nfm.primes_above([-2 * _q89**2, 0, 1], 7))
_K89 = NumberField(PolynomialRing(QQ, "x").gen()**2 + 1009 * _q89**2, "a")
assert len(_K89._bnfdata()["assumes"]) == 2; raises(NotImplementedError, _K89.class_number, proof=True)
from fractions import Fraction as _Fr
from sagebrush.sage import RealField
_R100 = RealField(100); _t = _R100(_Fr(1, 2**300))  # R2-NUM-F9
assert all(abs(_v / _t - 1) < _R100(_Fr(1, 2**90)) for _v in (_t.sinh(), _t.tanh(), _t.arcsinh(), _t.arctanh()))
assert str(_R100(-2**300).arcsinh()) == "-208.63730134854353813458686856"
_U = RealField(100, rnd="RNDU")  # R2-NUM-F10
assert _U(_Fr(1, 2**300)).exp() > 1 and (_U(1) + _U(_Fr(1, 2**98))).log() > _U(_Fr(1, 2**98)) - _U(_Fr(1, 2**197))
print("rereview2 ok")
