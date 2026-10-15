"""mpmath's values of the functions in lib/_special.py, for
test/special.test.ts: `python3 test/special_mpmath_gen.py` writes
test/special-mpmath.json (mpmath at 40 digits).

Each case is [function, arguments, value]: numbers as repr() strings, a
complex one as [re, im]."""

import cmath
import json
import math
import random

import mpmath as mp

mp.mp.dps = 40
random.seed(20261014)
U = random.uniform


def LU(a, b):
    return math.exp(U(math.log(a), math.log(b)))


def cz(R, lo=None):
    return complex(U(-R, R), U(-R, R) if lo is None else U(lo, R))


def enc(v):
    if isinstance(v, complex):
        return [repr(v.real), repr(v.imag)]
    return repr(v)


def val(r, want_complex):
    c = complex(r)
    return c if want_complex else c.real


points = {
    "loggamma": [(LU(1e-3, 1e5),) for _ in range(40)] + [(cz(60),) for _ in range(60)] + [(cz(3),) for _ in range(40)]
    + [(complex(x, y),) for x in (-0.5, -10.5, -31.5) for y in (1.0, 1e-10, 300.0, -400.0)],
    "gamma": [(U(-170, 171),) for _ in range(60)] + [(cz(30),) for _ in range(60)],
    "psi": [(U(-50, 100),) for _ in range(60)] + [(U(0.5, 3),) for _ in range(30)] + [(cz(100),) for _ in range(60)],
    "polygamma": [(n, U(-40, 50)) for n in (1, 2, 5, 20) for _ in range(20)]
    + [(n, cz(20)) for n in (1, 3, 10) for _ in range(20)],
    "zeta": [(U(-40, 60),) for _ in range(50)] + [(complex(U(0, 1), U(-1000, 1000)),) for _ in range(40)]
    + [(complex(U(-30, 30), U(-100, 100)),) for _ in range(40)],
    "hurwitz_zeta": [(U(-0.999, 30), LU(0.01, 10)) for _ in range(40)] + [(float(random.randint(-30, 0)), LU(0.01, 10)) for _ in range(20)]
    + [(complex(U(-0.999, 10), U(-500, 500)), U(0.1, 10)) for _ in range(30)],
    "beta": [(LU(1e-3, 80), LU(1e-3, 80)) for _ in range(40)] + [(U(-30, 30), U(-30, 30)) for _ in range(30)],
    "betaln": [(LU(1e-5, 1e6), LU(1e-5, 1e6)) for _ in range(60)],
    "faddeeva": [(complex(U(-50, 50), U(0, 50)),) for _ in range(40)] + [(complex(U(-8, 8), U(-5, 8)),) for _ in range(60)],
    "erf": [(cz(6),) for _ in range(60)] + [(cz(0.7),) for _ in range(20)],
    "erfc": [(cz(6),) for _ in range(60)],
    "erfi": [(cz(6),) for _ in range(40)] + [(U(-26, 26),) for _ in range(30)],
    "erfcx": [(U(-26, 30),) for _ in range(40)] + [(LU(1, 1e10),) for _ in range(10)] + [(complex(U(0, 30), U(-30, 30)),) for _ in range(30)],
    "erfinv": [(U(-1, 1),) for _ in range(60)] + [(1 - LU(1e-16, 0.5),) for _ in range(20)] + [(LU(1e-300, 0.1),) for _ in range(10)],
    "erfcinv": [(U(0, 2),) for _ in range(40)] + [(LU(1e-320, 0.5),) for _ in range(30)],
    "exp_integral_e1": [(cz(60),) for _ in range(60)] + [(cz(5),) for _ in range(40)]
    + [(cmath.rect(LU(1e-3, 500), U(2.8, math.pi)),) for _ in range(30)] + [(U(-700, 700),) for _ in range(30)],
    "exp_integral_ei": [(U(-700, 709),) for _ in range(40)] + [(LU(1e-10, 50),) for _ in range(30)] + [(U(0.25, 0.5),) for _ in range(20)],
}
# (daybreak's review of special-phase1: complex a is refused, so its cases
# go; zeta high in the critical strip and E1 at |z| = 500, deterministic
# points included; drawn after everything above, which stays as it was)
points["hurwitz_zeta"] = [p for p in points["hurwitz_zeta"] if not isinstance(p[1], complex)] + [
    (complex(U(-0.999, 3), random.choice((1, -1)) * U(500, 1000)), U(0.05, 10)) for _ in range(10)]
points["zeta"] = points["zeta"] + [(complex(0.5495278737588145, -946.9393705835552),)] + [
    (complex(U(0, 1), random.choice((1, -1)) * U(900, 10000)),) for _ in range(20)]
points["exp_integral_e1"] = points["exp_integral_e1"] + [
    (complex(349.99049601561853, -316.93605952131946),), (complex(-327.52218011370275, -320.3024594333194),)] + [
    (cmath.rect(500, U(-math.pi, math.pi)),) for _ in range(20)]
# (Lambert W: every branch, near the branch point -1/e and close above and
# below the cuts, from 1e-300 to 1e300)
points["lambert_w"] = (
    [(cz(5), k) for k in (-3, -1, 0, 1, 2) for _ in range(15)]
    + [(complex(-1 / math.e + U(-0.05, 0.05), U(-0.05, 0.05)), k) for k in (-1, 0, 1) for _ in range(15)]
    + [(complex(-1 / math.e + random.choice((1, -1)) * LU(1e-14, 1e-3), random.choice((1, -1)) * LU(1e-30, 1e-8)), k)
       for k in (-1, 0, 1) for _ in range(10)]
    + [(complex(U(-3, 3), random.choice((1, -1)) * LU(1e-30, 1e-3)), k) for k in (-1, 0, 1) for _ in range(10)]
    + [(cmath.rect(LU(1e-300, 1e300), U(-math.pi, math.pi)), k) for k in (-2, 0, 1, 57) for _ in range(10)]
    + [(U(-1 / math.e, 0), k) for k in (-1, 0) for _ in range(10)] + [(LU(1e-300, 1e300), 0) for _ in range(10)]
)
# (polylogarithms of integer order: inside, on and outside the unit circle,
# next to 1 and to the cut (1, inf), and real arguments below 1)
points["polylog"] = (
    [(n, cz(3)) for n in (-20, -7, -2, -1, 0, 1, 2, 3, 4, 7, 25, 100) for _ in range(12)]
    + [(n, cmath.rect(U(0.4, 2.2), U(-math.pi, math.pi))) for n in (-12, -3, 1, 2, 3, 10) for _ in range(12)]
    + [(n, cmath.rect(LU(1e-5, 1e5), U(-math.pi, math.pi))) for n in (-5, 1, 2, 5, 30) for _ in range(10)]
    + [(n, complex(1 + U(-0.01, 0.01), U(-0.01, 0.01))) for n in (-1, 2, 3, 6) for _ in range(6)]
    + [(n, complex(U(1.01, 50), random.choice((1, -1)) * LU(1e-30, 1e-5))) for n in (2, 3, 5) for _ in range(6)]
    + [(n, U(-30, 0.99)) for n in (-4, 1, 2, 3, 8) for _ in range(8)]
)
points["dilog"] = [(cz(4),) for _ in range(20)] + [(U(-50, 0.99),) for _ in range(10)]
# (fixed large orders with large |z|, daybreak's TEST-E24-2 point first; no
# random draws, so that the cases after these stay as they were)
points["polylog"] = points["polylog"] + [
    (100, complex(4.918943795749446e47, -8.631356821706026e47)), (99, complex(-3.1e120, 2.7e119)),
    (95, complex(1.3e15, 9.9e14)), (90, complex(-7.7e200, -1.1e201)), (80, complex(2.5e30, -4.0e29)),
    (50, complex(6.0e8, 8.0e8)), (20, complex(-1.0e300, 3.0e299)), (100, complex(25.0, -10.0))]
# (elliptic integrals and Jacobian functions: m from -1e300 to within 1e-16
# of 1, u across many periods and next to the quarter periods)
points["ellipk"] = [(U(-100, 1),) for _ in range(30)] + [(1 - math.exp(U(-36, 0)),) for _ in range(30)] + [(-math.exp(U(0, 600)),) for _ in range(10)]
points["ellipe"] = list(points["ellipk"]) + [(U(0.4, 0.6),) for _ in range(10)]


def _jac_points():
    out = []
    for _ in range(120):
        r = random.random()
        if r < 0.3:
            out.append((U(-10, 10), U(0, 1)))
        elif r < 0.5:
            out.append((U(-40, 40), 1 - math.exp(U(-36, -1))))
        elif r < 0.7:
            out.append((U(-1e3, 1e3), U(0, 1)))
        else:
            m = U(0, 1)
            out.append((float(mp.ellipk(m)) * random.choice((0.5, 1, 1.5, 2, 3)) + U(-1e-3, 1e-3), m))
    return out


points["ellipj"] = _jac_points()
# (Legendre columns, m = 0..n, in each normalization; the reference is the
# unnormalized recurrence at 80 digits, where its rounding does not matter)
points["legendre_all"] = [(float(random.choice((0, 1, 2, 3, 5, 10, 30, 80, 150, 200))),
                           random.choice((U(-1, 1), 1 - math.exp(U(-30, -1)), -1 + math.exp(U(-30, -1)), 0.0, 1.0, -1.0)),
                           float(random.randint(0, 2))) for _ in range(40)]


# (u from 1e-300 to 1.7e308: the series for tiny u, the exact reduction for
# large u, and daybreak's case CORR-027-1)
points["ellipj"] = points["ellipj"] + [(random.choice((1, -1)) * LU(1e-300, 1e-2), random.choice((U(0, 1), 1 - LU(1e-16, 0.1))))
                                       for _ in range(30)] + [
    (random.choice((1, -1)) * LU(1e3, 1.7e308), random.choice((U(0, 1), 1 - LU(1e-16, 0.1)))) for _ in range(30)] + [
    (314159265358979328.0, 0.9999999990686774)]
# (the regularized incomplete gamma functions P and Q: every region of
# lib/_special.py's (series, continued fraction, Gautschi's small-x Q,
# Temme's expansion for large a near x) and the boundaries between them;
# drawn last, so that the cases above stay as they were)
_gi = ([(LU(1e-6, 1e4), None) for _ in range(60)] + [(LU(12, 1e6), "near") for _ in range(40)]
       + [(LU(1e-8, 2), "small") for _ in range(30)])
_gi_pts = []
for a, kind in _gi:
    if kind is None:
        x = a * LU(0.05, 20)
    elif kind == "near":
        x = a * (1 + U(-0.4, 0.4))
    else:
        x = LU(1e-6, 1.5)
    _gi_pts.append((a, x))
_gi_pts += [(a, x) for a in (0.5, 1.0, 1.5, 11.9, 12.0, 15.0, 100.0) for x in (0.2, 0.26, 1.5, 1.6, a + 0.25, a * 0.6, a * 1.6)]
# (a = 1e10 about x = a: Temme's expansion where P or Q underflows; added
# after the drawn points, deterministically)
_gi_pts += [(1e10, 1e10 + z * 1e5) for z in (-20, -10, -5, -1, 0, 1, 5, 10, 20)] + [(1.0, 5e-324), (2.0, 1e-200)]
points["gammainc"] = _gi_pts
points["gammaincc"] = list(_gi_pts)
# (the scaled forms, P or Q times Gamma(a+1) e^x / x^a: where the unscaled
# value underflows (daybreak's HARD-05E-1: 0.001 at a = 1, x = 1000), in
# each region, and at the least subnormal x)
points["gammainc_scaled"] = [(a, x, float(up)) for a, x, up in [
    (1.0, 1000.0, 1), (2.0, 1000.0, 1), (50.0, 2000.0, 1), (1e4, 1.2e4, 1), (1e4, 8e3, 0), (0.5, 1e-300, 0),
    (1.0, 5e-324, 0), (3.0, 1e-200, 0), (1e10, 1e10 + 5e5, 1), (1e10, 1e10 - 5e5, 0), (1e10, 1e10 + 5e5, 0),
    (20.0, 21.0, 0), (20.0, 21.0, 1), (0.3, 0.1, 1), (0.3, 0.1, 0), (5.0, 30.0, 0), (5.0, 30.0, 1), (0.01, 1.2, 1)]]
# (Bessel J of real order and argument: each region of lib/_special.py's
# (power series, Hankel's expansion, Miller's recurrence) and the
# transition x near nu, integer and negative integer orders, large x, and
# negative x (complex for non-integer orders); drawn last, so that the
# cases above stay as they were)
points["besselj"] = (
    [(U(0, 200), U(1e-3, 300)) for _ in range(60)] + [(U(0, 3), LU(1e-4, 1e6)) for _ in range(40)]
    + [(float(random.randint(0, 40)), U(0, 60)) for _ in range(40)] + [(float(-random.randint(1, 30)), U(0.1, 50)) for _ in range(20)]
    + [(n, n * U(0.8, 1.2)) for n in (LU(5, 1000) for _ in range(30))]
    + [(random.choice((float(random.randint(0, 10)), U(0, 10))), -U(0.01, 40)) for _ in range(30)]
    + [(0.0, 2.404825557695773), (1.0, 3.8317059702075125), (0.5, 1e-300), (100.0, 1.0), (0.0, 1e300)]
)
# (daybreak's review of 088bc11, deterministic, after everything drawn: the
# series/Miller boundary x = sqrt(2 (nu + 1)) at large orders, with its
# neighbouring doubles; large orders below the turning point; the least
# subnormal x)
_bj = []
for _k in range(0, 345, 12):
    _nu = 155 + 0.25 * _k
    _xb = math.sqrt(2.0) * math.sqrt(_nu + 1)
    _bj += [(_nu, _xb), (_nu, math.nextafter(_xb, 0)), (_nu, math.nextafter(_xb, 100))]
_bj += [(240.5, 21.977260975835907), (240.5, 21.977260975835915), (235.0, 21.725560982400427), (200.5, 20.07485989988473)]
_bj += [(494.64835926046334, 284.56332208950073), (1134.5070496950125, 631.7690438100962), (311.12552474955464, 174.76213244286976),
        (300.0, 50.0), (1000.0, 500.0), (1500.0, 1400.0)]
_bj += [(0.5, 5e-324), (1.0, 5e-324), (0.5, 1e-310)]
# (daybreak's review of c7653a7, CORR-C76-1, and the largest errors of the
# recurrences in doubles found since: below the turning point (Miller's)
# and above it (upward from Hankel's), now in double-double arithmetic)
_bj += [(1213.0281254434196, 939.6256040528829), (816.4829854938145, 439.39218016459034), (1389.6506472836113, 1450.6133723750388),
        (919.3838517917308, 971.908303269163), (159.4722416650559, 78.15146436342027)]
points["besselj"] = points["besselj"] + _bj


def ferrers_column(n, x):
    with mp.workdps(80):
        x = mp.mpf(x)
        s = mp.sqrt(1 - x * x)
        out = []
        pmm = mp.mpf(1)
        for m in range(n + 1):
            if m:
                pmm *= -(2 * m - 1) * s
            if n == m:
                out.append(+pmm)
                continue
            p0, p1 = pmm, (2 * m + 1) * x * pmm
            for k in range(m + 1, n):
                p0, p1 = p1, ((2 * k + 1) * x * p1 - (k + m) * p0) / (k - m + 1)
            out.append(+p1)
        return out


def legendre_all(n, x, norm):
    n, norm = int(n), ("unnorm", "sch", "norm")[int(norm)]
    col = ferrers_column(n, x)
    with mp.workdps(80):
        out = []
        for m, P in enumerate(col):
            if norm == "unnorm" or (norm == "sch" and m == 0):
                v = P
            elif norm == "sch":
                v = (-1) ** m * mp.sqrt(2 * mp.factorial(n - m) / mp.factorial(n + m)) * P
            else:
                v = (-1) ** m * mp.sqrt((n + mp.mpf(1) / 2) * mp.factorial(n - m) / mp.factorial(n + m)) * P
            out.append(float(v) if abs(v) < mp.mpf(10) ** 308 else (math.inf if v > 0 else -math.inf))
        return out


def ellipj_ref(u, m):
    # (enough digits to reduce u by the period exactly)
    with mp.workdps(40 + max(0, int(math.log10(abs(u) + 1)))):
        return [float(mp.ellipfun(f, mp.mpf(u), m=mp.mpf(m))) for f in ("sn", "cn", "dn")]


def _gammainc_ref(a, x, upper):
    a, x = mp.mpf(a), mp.mpf(x)
    if a >= 1e6:
        # (mpmath's upper function is fast here; P = 1 - Q with digits enough for P's size)
        with mp.workdps(400):
            q = mp.gammainc(a, x, mp.inf, regularized=True)
            return q if upper else 1 - q
    with mp.workdps(80):
        if x < a:
            # (P = x^a e^-x / Gamma(a+1) 1F1(1; a+1; x), DLMF 8.7.1 and 13.2.2)
            p = mp.exp(a * mp.log(x) - x - mp.loggamma(a + 1)) * mp.hyp1f1(1, a + 1, x, maxterms=10 ** 7)
            return 1 - p if upper else p
        try:
            q = mp.gammainc(a, x, mp.inf, regularized=True)
        except mp.libmp.libhyper.NoConvergence:
            # (then 1 - P from the series, with digits enough for Q's size)
            with mp.workdps(400):
                q = 1 - mp.exp(a * mp.log(x) - x - mp.loggamma(a + 1)) * mp.hyp1f1(1, a + 1, x, maxterms=10 ** 7)
        return q if upper else 1 - q


def _gammainc_scaled_ref(a, x, upper):
    with mp.workdps(400):
        v = _gammainc_ref(a, x, bool(upper))
        A, X = mp.mpf(a), mp.mpf(x)
        return v / mp.exp(A * mp.log(X) - X - mp.loggamma(A + 1))


def faddeeva(z):
    z = mp.mpc(z)
    return mp.exp(-z * z) * mp.erfc(-1j * z)


def erfcinv(q):
    if q > 1e-10:
        return mp.erfinv(1 - mp.mpf(q))
    return mp.findroot(lambda x: mp.log(mp.erfc(x)) - mp.log(q), mp.sqrt(-mp.log(q)))


ref = {
    "loggamma": mp.loggamma, "gamma": mp.gamma, "psi": mp.digamma, "polygamma": mp.polygamma, "zeta": mp.zeta,
    "hurwitz_zeta": mp.zeta, "beta": mp.beta, "betaln": lambda a, b: mp.log(mp.beta(a, b)), "faddeeva": faddeeva,
    "erf": mp.erf, "erfc": mp.erfc, "erfi": mp.erfi, "erfcx": lambda z: mp.exp(mp.mpmathify(z) ** 2) * mp.erfc(z),
    "erfinv": lambda y: mp.erfinv(y), "erfcinv": erfcinv, "exp_integral_e1": mp.e1, "exp_integral_ei": mp.ei,
    "lambert_w": lambda z, k: mp.lambertw(z, k),
    "polylog": lambda n, z: mp.polylog(n, z), "dilog": lambda z: mp.polylog(2, z),
    "ellipk": mp.ellipk, "ellipe": mp.ellipe,
    "ellipj": lambda u, m: ellipj_ref(u, m),
    "legendre_all": legendre_all,
    "gammainc": lambda a, x: _gammainc_ref(a, x, False), "gammaincc": lambda a, x: _gammainc_ref(a, x, True),
    "gammainc_scaled": _gammainc_scaled_ref,
    "besselj": lambda nu, x: mp.besselj(nu, x),
}
# (the real functions' values are real; loggamma and E1 of a negative real are complex)
complex_valued = {"faddeeva"}
out = []


def add(name, args, v):
    if isinstance(v, list):
        out.append([name, [enc(a) for a in args], [repr(t) for t in v]])
        return
    c = complex(v)
    wc = any(isinstance(a, complex) for a in args) or name in complex_valued or c.imag != 0
    out.append([name, [enc(a) for a in args], enc(val(v, wc))])


for name, pts in points.items():
    for args in pts:
        add(name, args, ref[name](*args))

# (astra's review of special-hardening, CORR-957-1 and CORR-957-2, and the
# value-comparing edge sweep: beta with a large negative argument, nearly
# cancelling or not, both negative, a + b next to a pole of Gamma; polygamma
# whose powers of 1/w underflow before the factorials restore them; erf
# where the rounding of 2xy turned e^(-z^2)'s phase; zeta(2, a) for huge a.
# Appended after the cases above, which stay as they were; beta's at
# digits enough that a + b is exact)
random.seed(957)


def _noint(v):
    return v if v != math.floor(v) else v + 0.5


_neg_beta = [(-999999999999.5, 1000000000016.0), (-999999999.5, 1000000016.0), (-285980934477808.94, 0.10104657144202031),
             (-0.003665719805022444, -8.996799190458725), (-0.012782929186446497, -952087114464834.6)]
for _ in range(8):
    _neg_beta += [(-_noint(LU(1e-3, 1e15)), LU(1e-3, 1e15)), (-_noint(LU(15, 1e15)), 0.0), (-_noint(LU(1e-3, 1e15)), -_noint(LU(1e-3, 1e15))),
                  (-_noint(U(0, 40)), U(0, 60))]
_neg_beta = [(a, b if b else -a + U(-30, 30)) for a, b in _neg_beta]


def _beta_hi(a, b, log=False):
    with mp.workdps(60 + 2 * int(math.log10(abs(a) + abs(b) + 1))):
        v = mp.beta(mp.mpf(a), mp.mpf(b))
        return mp.log(abs(v)) if log else +v


for a, b in _neg_beta:
    v = _beta_hi(a, b)
    if mp.mpf(1e-300) < abs(v) < mp.mpf(1e300):
        add("beta", (a, b), v)
    add("betaln", (a, b), _beta_hi(a, b, True))
for n, z in [(50, 1e7), (100, 1e4), (100, 290.0), (80, 2e3), (100, complex(1000, 1000)), (60, complex(3e5, -2e5)), (30, 1e9)]:
    with mp.workdps(60):
        add("polygamma", (n, z), mp.polygamma(n, z))
for name, z in [("erf", complex(3e7, 3e7)), ("erf", complex(1e8, 1e8)), ("erfc", complex(3e7, 3e7)), ("erfi", complex(3e7, -3e7)),
                ("erf", complex(4e5, -3e5)), ("erfc", complex(3e3, 2999.9))]:
    add(name, (z,), ref[name](z))
for s_, a in [(2.0, 1e300), (2.0, 1e308), (3.0, 1e100), (1.5, 1e50)]:
    add("hurwitz_zeta", (s_, a), mp.zeta(s_, a))
# (astra's review of d691440, CORR-D69-1: polygamma next to the negative
# real axis, where the recurrence's terms either side of a pole cancel;
# her two examples, and a grid of orders, real parts and small imaginary
# parts, at digits enough for the cancellation)
_pg = [(40, complex(-0.5, 1e-9)), (30, complex(-1.5, 1e-9))]
_pg += [(n, complex(x, y)) for n in (10, 40, 100) for x in (-0.5, -3.5, -37.5, -0.25, -12.3)
        for y in (1e-3, -1e-9, 1e-15)]
_pg += [(100, complex(-1.5, 0.0)), (20, complex(-2.75, 0.5)), (5, complex(-30.2, -0.9))]
for n, z in _pg:
    with mp.workdps(320):
        add("polygamma", (n, z), mp.polygamma(n, mp.mpc(z.real, z.imag)))
# (astra's zeta(-0.5, 4e205), about -1.69e308, whose power a^1.5 overflows
# before the quotient by s - 1 brings it back: Euler-Maclaurin's terms
# a^(1-s)/(s-1) + a^-s/2 + s a^(-s-1)/12, at a = 4e205 the rest below 1e-600
# of them; mpmath's zeta takes too long there)
with mp.workdps(60):
    _a, _s = mp.mpf(4e205), mp.mpf(-0.5)
    add("hurwitz_zeta", (-0.5, 4e205), _a ** (1 - _s) / (_s - 1) + _a ** (-_s) / 2 + _s * _a ** (-_s - 1) / 12)
# (Hankel's expansion at huge x, found by the edge sweep: the prefactor
# sqrt(2/(pi x)) overflowed or went subnormal, J_0(1e308) was 0, and the
# phase pi (nu/2 + 1/4) lost its 1/4 for nu >= 2^52; at 400 digits, for x's
# phase; appended after everything above, which stays as it was)
for nu, x in [(0.0, 1e308), (0.5, 1.7976931348623157e308), (3.0, -1e308), (170.5, 1e308), (0.0, 3e305), (1e20, 1e200),
              (1e20, 1e300), (2.0 ** 53, 1e40), (1e5, 1e12),
              # (and the series' Gamma(nu + 1) at the rounded nu + 1: 2.9e-14 off)
              (63.589762425754834, 6.476702183150906), (63.985572465086086, 8.957063545130058)]:
    with mp.workdps(400):
        add("besselj", (nu, x), mp.besselj(nu, x))
json.dump(out, open(__file__.replace("special_mpmath_gen.py", "special-mpmath.json"), "w"), indent=0)
print(len(out), "cases")
