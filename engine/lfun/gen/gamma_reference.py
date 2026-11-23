"""Generate tests/gamma_reference.txt: ln Gamma(z) and Gamma(a, z) by mpmath at 40 digits.

    python3 -I engine/lfun/gen/gamma_reference.py > engine/lfun/tests/gamma_reference.txt

The points cover what the L-series uses: a = sigma + i t with sigma in [-3, 3] and |t| up to 1000, and
z = x e^(i theta) with theta = sign(t) (pi/2 - c/|t|) for c in [2, 5] (or a fraction of it), x from
1e-4 to 500; plus a near the poles 0, -1, -2, -3 of Gamma(a) and exactly at them, and real a and z.
Each line gives the inputs as shortest round-trip decimals, a logarithm of the value (any branch:
the test compares exponentials) and ln S, the scale the error is measured against:
S = max(|Gamma(a, z)|, |Gamma(a)|), what an error costs in the L-series (which divides by Gamma(s)),
or max(|Gamma(a, z)|, |z^a e^-z|) at the poles of Gamma(a).
"""
import math
import random

import mpmath

mpmath.mp.dps = 40
random.seed(20261115)


def ray_point(t, sig):
    if abs(t) < 1:
        th = 0.0
    else:
        c = random.uniform(2, 5)
        th = math.copysign(max(0.0, math.pi / 2 - c / abs(t)), t) * random.choice([1, 1, random.random()])
    x = 10 ** random.uniform(-4, math.log10(500))
    if random.random() < 0.4:
        # the band around |z| = |a|, where the series and the continued fraction meet
        x = abs(complex(sig, t)) * random.uniform(0.8, 1.25) + 1e-3
    if x * math.cos(th) > 80:
        x = 80 / math.cos(th) * random.random() + 1e-3
    return complex(x * math.cos(th), x * math.sin(th))


def emit_inc(a, z):
    A, Z = mpmath.mpc(a.real, a.imag), mpmath.mpc(z.real, z.imag)
    v = mpmath.gammainc(A, Z)
    pole = A.imag == 0 and A.real <= 0 and A.real == int(A.real)
    s = max(abs(v), abs(Z ** A * mpmath.exp(-Z)) if pole else abs(mpmath.gamma(A)))
    lv = mpmath.log(v)
    print("inc %r %r %r %r %s %s %s" % (a.real, a.imag, z.real, z.imag,
          mpmath.nstr(lv.real, 25), mpmath.nstr(lv.imag, 25), mpmath.nstr(mpmath.log(s), 25)))


print("# ln Gamma(z) by mpmath 1.3.0 at 40 digits: lg z_re z_im ln_re ln_im")
for _ in range(200):
    z = complex(random.choice([random.uniform(-30, 30), random.uniform(-3, 3), 0.5, 1.0, 2.0]),
                random.choice([0.0, random.uniform(-5, 5), random.uniform(-400, 400)]))
    if z.imag == 0 and z.real <= 0 and z.real == round(z.real):
        continue
    lv = mpmath.log(mpmath.gamma(mpmath.mpc(z.real, z.imag)))
    print("lg %r %r %s %s" % (z.real, z.imag, mpmath.nstr(lv.real, 25), mpmath.nstr(lv.imag, 25)))

print("# Gamma(a, z) by mpmath 1.3.0 at 40 digits: inc a_re a_im z_re z_im ln_re ln_im ln_scale")
for _ in range(800):
    t = random.choice([0.0, random.uniform(-1, 1), random.uniform(-10, 10), random.uniform(-120, 120),
                       random.uniform(-400, 400), random.uniform(-1000, 1000)])
    sig = random.choice([random.uniform(-3, 3), 0.0, 1.0, 2.0, -1.0, 0.5])
    emit_inc(complex(sig, t), ray_point(t, sig))
# the band |z| = 0.9 |a| to 1.1 |a| on the rays at large heights, where the continued fraction fails
# below 0.95 |a| and the series above 1.05 |a| (at Im a = 1000)
for t in (300.0, -600.0, 1000.0, -1000.0):
    th = math.copysign(math.pi / 2 - 3 / abs(t), t)
    for sig in (1.25, -0.25):
        for rho in (0.91, 0.92, 0.93, 0.95, 0.97, 1.0, 1.03, 1.06, 1.09):
            x = rho * abs(complex(sig, t))
            emit_inc(complex(sig, t), complex(x * math.cos(th), x * math.sin(th)))
# near and at the poles of Gamma(a), small and moderate z, real and complex
for m in range(4):
    for eps in (0.0, 1e-12, -1e-9, 3e-6, -0.01, 0.2, complex(0, 1e-8), complex(1e-3, -0.1)):
        for z in (1e-4, 0.3, 1.0, 1.9, complex(0.5, 1.5), complex(0.01, -1.2)):
            emit_inc(complex(-m, 0) + eps, complex(z))
