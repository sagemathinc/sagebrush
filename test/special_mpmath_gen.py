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
    "besselj": lambda nu, x: mp.besselj(nu, x),
}
# (the real functions' values are real; loggamma and E1 of a negative real are complex)
complex_valued = {"faddeeva"}
out = []
for name, pts in points.items():
    for args in pts:
        v = ref[name](*args)
        if isinstance(v, list):
            out.append([name, [enc(a) for a in args], [repr(t) for t in v]])
            continue
        c = complex(v)
        wc = any(isinstance(a, complex) for a in args) or name in complex_valued or c.imag != 0
        out.append([name, [enc(a) for a in args], enc(val(v, wc))])
json.dump(out, open(__file__.replace("special_mpmath_gen.py", "special-mpmath.json"), "w"), indent=0)
print(len(out), "cases")
