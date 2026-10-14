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
}
# (the real functions' values are real; loggamma and E1 of a negative real are complex)
complex_valued = {"faddeeva"}
out = []
for name, pts in points.items():
    for args in pts:
        v = ref[name](*args)
        c = complex(v)
        wc = any(isinstance(a, complex) for a in args) or name in complex_valued or c.imag != 0
        out.append([name, [enc(a) for a in args], enc(val(v, wc))])
json.dump(out, open(__file__.replace("special_mpmath_gen.py", "special-mpmath.json"), "w"), indent=0)
print(len(out), "cases")
