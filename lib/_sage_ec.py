"""Arithmetic of elliptic curves over QQ for Sagebrush: local data by Tate's
algorithm (Kodaira symbols, conductor exponents, Tamagawa numbers), global
minimal models, torsion orders, real periods, root numbers, L(E,1) and
L'(E,1), and the analytic order of Sha in analytic rank 0.

References: J. Tate, "Algorithm for determining the type of a singular fiber
in an elliptic pencil" (1975); J. Silverman, Advanced Topics in the
Arithmetic of Elliptic Curves, IV.9; H. Cohen, A Course in Computational
Algebraic Number Theory, 7.4-7.5; J. Cremona, Algorithms for Modular
Elliptic Curves (2nd ed.), 3.2 and 2.11.
"""

import math as _m
import cmath as _cm
from fractions import Fraction as _F


# ------------------------------------------------------------------ helpers

def _v(n, p):
    """p-adic valuation of an integer (infinity for 0)."""
    if n == 0:
        return 10 ** 9
    k = 0
    while n % p == 0:
        n //= p
        k += 1
    return k


def _b(a):
    a1, a2, a3, a4, a6 = a
    b2 = a1 * a1 + 4 * a2
    b4 = 2 * a4 + a1 * a3
    b6 = a3 * a3 + 4 * a6
    b8 = a1 * a1 * a6 + 4 * a2 * a6 - a1 * a3 * a4 + a2 * a3 * a3 - a4 * a4
    return b2, b4, b6, b8


def _c(a):
    b2, b4, b6, b8 = _b(a)
    return b2 * b2 - 24 * b4, -b2 ** 3 + 36 * b2 * b4 - 216 * b6


def _disc(a):
    b2, b4, b6, b8 = _b(a)
    return -b2 * b2 * b8 - 8 * b4 ** 3 - 27 * b6 * b6 + 9 * b2 * b4 * b6


def _change(a, r, s, t):
    """The model for x = x' + r, y = y' + s x' + t (u = 1)."""
    a1, a2, a3, a4, a6 = a
    return (a1 + 2 * s,
            a2 - s * a1 + 3 * r - s * s,
            a3 + r * a1 + 2 * t,
            a4 - s * a3 + 2 * r * a2 - (t + r * s) * a1 + 3 * r * r - 2 * s * t,
            a6 + r * a4 + r * r * a2 + r ** 3 - t * a3 - t * t - r * t * a1)


def _inv(x, p):
    return pow(x % p, -1, p)


def _legendre(a, p):
    a %= p
    if a == 0:
        return 0
    return 1 if pow(a, (p - 1) // 2, p) == 1 else -1


def _quadratic(A, B, C, p):
    """For A X^2 + B X + C mod p with A a unit: (distinct roots?, roots in F_p?, the double root)."""
    if p == 2:
        if B % 2:
            # X^2 + X + C/A: roots in F_2 iff C even
            return True, C % 2 == 0, None
        # (X + r)^2 with r^2 = C/A
        return False, True, C % 2
    d = (B * B - 4 * A * C) % p
    if d:
        return True, _legendre(d, p) == 1, None
    return False, True, (-B * _inv(2 * A, p)) % p


def _factor_int(n):
    from sage_all import factor
    return [(int(p), int(e)) for p, e in factor(abs(n))]


def _cubic_roots_mod(c2, c1, c0, p):
    """Roots of T^3 + c2 T^2 + c1 T + c0 mod p with multiplicities, as {root: mult}."""
    if p < 2000:
        roots = {}
        rem = [1, c2 % p, c1 % p, c0 % p]
        for x in range(p):
            # synthetic division repeatedly
            while len(rem) > 1:
                q, r = [rem[0]], rem[0]
                for c in rem[1:]:
                    r = (r * x + c) % p
                    q.append(r)
                if q[-1] != 0:
                    break
                rem = q[:-1]
                roots[x] = roots.get(x, 0) + 1
        return roots
    from sagebrush._engine import call
    out = {}
    for g, e in call("factor_mod", f=[str(c0), str(c1), str(c2), "1"], p=int(p)):
        if len(g) == 2:  # monic linear: g0 + T
            out[(-int(g[0])) % p] = out.get((-int(g[0])) % p, 0) + e
    return out


# ------------------------------------------------------------------ Tate's algorithm

_KODAIRA = {"I0": "I0", "II": "II", "III": "III", "IV": "IV", "I0*": "I0*", "IV*": "IV*", "III*": "III*", "II*": "II*"}


def tate(a, p):
    """Tate's algorithm at p for an integral model a = (a1, ..., a6).
    Returns (kodaira symbol, conductor exponent f_p, Tamagawa number c_p,
    the number k of times the model was scaled by p (so that the minimal
    discriminant has valuation v_p(Delta) - 12 k))."""
    a = tuple(int(x) for x in a)
    k = 0
    while True:
        D = _disc(a)
        vD = _v(D, p)
        if vD == 0:
            return "I0", 0, 1, k
        b2, b4, b6, b8 = _b(a)
        c4, c6 = _c(a)
        a1, a2, a3, a4, a6 = a
        # step 2: move the singular point to (0, 0)
        if p == 2:
            if b2 % 2 == 0:
                r = a4 % 2
                t = (r * (1 + a2 + a4) + a6) % 2
            else:
                r = a3 % 2
                t = (r + a4) % 2
        elif p == 3:
            r = (-b6) % 3 if b2 % 3 == 0 else (-b2 * b4) % 3
            t = (a1 * r + a3) % 3
        else:
            if c4 % p == 0:
                r = (-b2 * _inv(12, p)) % p
            else:
                r = (-(c6 + b2 * c4) * _inv(12 * c4, p)) % p
            t = (-(a1 * r + a3) * _inv(2, p)) % p
        a = _change(a, r, 0, t)
        a1, a2, a3, a4, a6 = a
        assert a3 % p == 0 and a4 % p == 0 and a6 % p == 0, "Tate step 2"
        b2, b4, b6, b8 = _b(a)
        if b2 % p:
            # multiplicative: I_n
            n = vD
            dist, split, _ = _quadratic(1, a1, -a2, p)
            c = n if split else (2 if n % 2 == 0 else 1)
            return "I%d" % n, 1, c, k
        if _v(a6, p) < 2:
            return "II", vD, 1, k
        if _v(b8, p) < 3:
            return "III", vD - 1, 2, k
        if _v(b6, p) < 3:
            dist, split, _ = _quadratic(1, a3 // p, -(a6 // (p * p)), p)
            return "IV", vD - 2, (3 if split else 1), k
        # step 6: p | a1, a2; p^2 | a3, a4; p^3 | a6
        if p == 2:
            s = a2 % 2
            t = 2 * ((a6 // 4) % 2)
        else:
            s = (-a1 * _inv(2, p)) % p
            t = (-a3 * _inv(2, p * p)) % (p * p)
        a = _change(a, 0, s, t)
        a1, a2, a3, a4, a6 = a
        assert a1 % p == 0 and a2 % p == 0 and a3 % (p * p) == 0 and a4 % (p * p) == 0 and a6 % p ** 3 == 0, "Tate step 6"
        roots = _cubic_roots_mod(a2 // p, a4 // (p * p), a6 // p ** 3, p)
        mults = sorted(roots.values())
        nroots = len(roots)
        # distinct roots in an algebraic closure: the cubic's discriminant
        P2, P1, P0 = a2 // p, a4 // (p * p), a6 // p ** 3
        dP = (18 * P2 * P1 * P0 - 4 * P2 ** 3 * P0 + P2 * P2 * P1 * P1 - 4 * P1 ** 3 - 27 * P0 * P0) % p
        if dP:
            return "I0*", vD - 4, 1 + nroots, k
        if mults != [3]:
            # I_n^*: a simple and a double root; put the double root at 0
            dbl = [x for x, mlt in roots.items() if mlt == 2][0]
            a = _change(a, dbl * p, 0, 0)
            a1, a2, a3, a4, a6 = a
            n = 1
            j = 1
            while True:
                if n % 2 == 1:
                    # Y^2 + (a3 / p^(j+1)) Y - a6 / p^(2j+2)
                    py = p ** (j + 1)
                    dist, split, rt = _quadratic(1, a3 // py, -(a6 // (py * py)), p)
                    if dist:
                        c = 4 if split else 2
                        break
                    a = _change(a, 0, 0, rt * py)
                    a1, a2, a3, a4, a6 = a
                else:
                    # (a2 / p) X^2 + (a4 / p^(j+2)) X + a6 / p^(2j+3)
                    px = p ** (j + 1)
                    dist, split, rt = _quadratic(a2 // p, a4 // (p * px), a6 // (p * px * px), p)
                    if dist:
                        c = 4 if split else 2
                        break
                    a = _change(a, rt * px, 0, 0)
                    a1, a2, a3, a4, a6 = a
                    j += 1
                n += 1
            return "I%d*" % n, vD - 4 - n, c, k
        # a triple root: move it to 0
        tr = list(roots.keys())[0]
        a = _change(a, tr * p, 0, 0)
        a1, a2, a3, a4, a6 = a
        dist, split, rt = _quadratic(1, a3 // (p * p), -(a6 // p ** 4), p)
        if dist:
            return "IV*", vD - 6, (3 if split else 1), k
        a = _change(a, 0, 0, rt * p * p)
        a1, a2, a3, a4, a6 = a
        if _v(a4, p) < 4:
            return "III*", vD - 7, 2, k
        if _v(a6, p) < 6:
            return "II*", vD - 8, 1, k
        # not minimal: scale by p
        a = (a1 // p, a2 // p ** 2, a3 // p ** 3, a4 // p ** 4, a6 // p ** 6)
        k += 1


def minimal_model(a):
    """A global minimal model, reduced as in Cremona (a1, a3 in {0, 1},
    a2 in {-1, 0, 1}), and its local data {p: (kodaira, f_p, c_p)}."""
    a = tuple(int(x) for x in a)
    D = _disc(a)
    u = 1
    for p, _ in _factor_int(D):
        k = tate(a, p)[3]
        u *= p ** k
    c4, c6 = _c(a)
    c4, c6 = c4 // u ** 4, c6 // u ** 6
    # Cremona's reduced model from (c4, c6)
    b2 = (-c6) % 12
    if b2 > 6:
        b2 -= 12
    b4 = (b2 * b2 - c4) // 24
    b6 = (-b2 ** 3 + 36 * b2 * b4 - c6) // 216
    a1 = b2 % 2
    a3 = b6 % 2
    a2 = (b2 - a1) // 4
    a4 = (b4 - a1 * a3) // 2
    a6 = (b6 - a3) // 4
    m = (a1, a2, a3, a4, a6)
    assert _c(m) == (c4, c6), "minimal model"
    return m


def local_data(a):
    """{p: (kodaira, f_p, c_p)} for the bad primes of a (minimal) model."""
    out = {}
    for p, _ in _factor_int(_disc(a)):
        kod, f, c, k = tate(a, p)
        out[p] = (kod, f, c)
    return out


# ------------------------------------------------------------------ torsion

def _add(P, Q, A):
    """Group law on y^2 = x^3 + A x + B (affine points as Fractions, None = O)."""
    if P is None:
        return Q
    if Q is None:
        return P
    x1, y1 = P
    x2, y2 = Q
    if x1 == x2:
        if y1 == -y2:
            return None
        lam = (3 * x1 * x1 + A) / (2 * y1)
    else:
        lam = (y2 - y1) / (x2 - x1)
    x3 = lam * lam - x1 - x2
    return (x3, lam * (x1 - x3) - y1)


def _int_roots_cubic(A, C):
    """Integer roots of x^3 + A x + C (exactly, by factoring over Z)."""
    from sagebrush._engine import call
    if C == 0:
        roots = {0}
        # x^2 + A
        r = _m.isqrt(-A) if A <= 0 else -1
        if r >= 0 and r * r == -A:
            roots |= {r, -r}
        return roots
    roots = set()
    for g, e in call("factor", f=[str(C), str(A), "0", "1"])["factors"]:
        if len(g) == 2 and int(g[1]) == 1:
            roots.add(-int(g[0]))
    return roots


def torsion_order(a, aps):
    """#E(Q)_tors: bounded by #E(F_p) at good primes, then Nagell-Lutz on
    y^2 = x^3 - 27 c4 x - 54 c6."""
    D = _disc(a)
    bound = 0
    for p, ap in aps:
        if ap is not None and p > 2:
            bound = _m.gcd(bound, p + 1 - ap)
            if bound == 1:
                return 1
    c4, c6 = _c(a)
    A, B = -27 * c4, -54 * c6
    disc = 4 * A ** 3 + 27 * B * B
    # square divisors of disc: from its factorization (that of Delta, times 2s and 3s)
    fac = {}
    n = abs(disc)
    for q in (2, 3):
        while n % q == 0:
            fac[q] = fac.get(q, 0) + 1
            n //= q
    for q, e in _factor_int(_disc(a)):
        while n % q == 0:
            fac[q] = fac.get(q, 0) + 1
            n //= q
    if n > 1:
        for q, e in _factor_int(n):
            fac[q] = fac.get(q, 0) + e
    ys = [1]
    for q, e in fac.items():
        ys = [y * q ** i for y in ys for i in range(e // 2 + 1)]
    cands = []
    for y in [0] + ys:
        for x in _int_roots_cubic(A, B - y * y):
            cands.append((_F(x), _F(y)))
            if y:
                cands.append((_F(x), _F(-y)))
    count = 1
    for P in cands:
        Q = P
        for n in range(1, 13):
            if Q is None:
                break
            Q = _add(Q, P, A)
            if Q is not None and (Q[0].denominator != 1 or Q[1].denominator != 1):
                Q = "not torsion"
                break
        if Q is None:
            count += 1
    assert bound % count == 0, "torsion bound"
    return count


# ------------------------------------------------------------------ periods

def _agm(a, b):
    for _ in range(200):
        a, b = (a + b) / 2, _cm.sqrt(a * b)
        if abs(a - b) <= 1e-17 * abs(a):
            break
    return a


def _cubic_roots(c3, c2, c1, c0):
    """The complex roots of c3 x^3 + c2 x^2 + c1 x + c0 (Durand-Kerner, then Newton)."""
    c2, c1, c0 = c2 / c3, c1 / c3, c0 / c3
    f = lambda z: ((z + c2) * z + c1) * z + c0
    df = lambda z: (3 * z + 2 * c2) * z + c1
    R = 1 + max(abs(c2), abs(c1), abs(c0))
    z = [R * _cm.exp(2j * _m.pi * k / 3 + 0.4j) for k in range(3)]
    for _ in range(500):
        new = []
        for i in range(3):
            den = 1
            for j in range(3):
                if j != i:
                    den *= z[i] - z[j]
            new.append(z[i] - f(z[i]) / den)
        if max(abs(x - y) for x, y in zip(new, z)) < 1e-15 * R:
            z = new
            break
        z = new
    out = []
    for r in z:
        for _ in range(3):
            d = df(r)
            if d != 0:
                r = r - f(r) / d
        out.append(r)
    return out


_K = 200  # fixed point: x is X / 2^K


def _refine_real(coeffs, x0):
    """Newton's iteration in fixed point (X / 2^K, exact integers) for a
    real root of the integer cubic coeffs (highest degree first)."""
    c0, c1, c2, c3 = (int(v) for v in coeffs)
    one = 1 << _K
    m, e = _m.frexp(float(x0))
    X = int(m * (1 << 53)) << max(0, _K + e - 53) if _K + e - 53 >= 0 else int(m * (1 << 53)) >> (53 - _K - e)
    for _ in range(400):
        # f(x) 2^(3K) and f'(x) 2^(2K)
        f = ((c0 * X + c1 * one) * X + c2 * one * one) * X + c3 * one ** 3
        df = (3 * c0 * X + 2 * c1 * one) * X + c2 * one * one
        if df == 0:
            break
        step = f // df  # (f / 2^(3K)) / (df / 2^(2K)) * 2^K
        X -= step
        if abs(step) <= 1:
            break
    return X


def _real_roots_fixed(coeffs):
    """The three real roots, largest first, of the integer cubic coeffs
    (positive leading coefficient, positive discriminant), as X / 2^K."""
    c0, c1, c2, c3 = (int(v) for v in coeffs)
    one = 1 << _K
    g = lambda X: ((c0 * X + c1 * one) * X + c2 * one * one) * X + c3 * one ** 3
    # critical points: roots of 3 c0 x^2 + 2 c1 x + c2
    disc = c1 * c1 - 3 * c0 * c2
    S = _m.isqrt(disc * one * one)
    lo_c = (-c1 * one - S) // (3 * c0)
    hi_c = (-c1 * one + S) // (3 * c0) + 1
    R = (1 + max(abs(c1), abs(c2), abs(c3)) // c0 + 1) * one
    def bisect(lo, hi):
        glo = g(lo)
        if glo == 0:
            return lo
        for _ in range(_K + 4 * max(1, (hi - lo).bit_length())):
            if hi - lo <= 1:
                break
            mid = (lo + hi) // 2
            gm = g(mid)
            if gm == 0:
                return mid
            if (gm < 0) == (glo < 0):
                lo, glo = mid, gm
            else:
                hi = mid
        return lo
    r3 = bisect(-R, lo_c)
    r2 = bisect(lo_c, hi_c)
    r1 = bisect(hi_c, R)
    return r1, r2, r3


def _fx(X):
    """X / 2^K as a float."""
    return X / (1 << _K) if abs(X) < (1 << 900) else float(_F(X, 1 << _K))


def real_period(a):
    """Omega_E: the least positive real period of the Neron differential of
    the (minimal) model a, times the number of components of E(R)."""
    b2, b4, b6, b8 = _b(a)
    D = _disc(a)
    coeffs = (4, b2, 2 * b4, b6)
    e = _cubic_roots(4.0, float(b2), float(2 * b4), float(b6))
    if D > 0:
        # three real roots: bracket each between the critical points
        # (-b2 +- sqrt(c4)) / 12 and bisect in fixed point, so that close
        # roots stay apart
        E1, E2, E3 = _real_roots_fixed(coeffs)
        w1 = _m.pi / _agm(_cm.sqrt(_fx(E1 - E3)), _cm.sqrt(_fx(E1 - E2))).real
        return 2 * w1
    # one real root e1
    E1 = _refine_real(coeffs, min(e, key=lambda x: abs(x.imag)).real)
    one = 1 << _K
    # a = 3 e1 + b2/4 and b = sqrt(3 e1^2 + (b2/2) e1 + b4/2), in fixed point:
    # 2b + a can cancel almost completely when the complex roots are nearly real
    AA = 3 * E1 + b2 * one // 4
    BB2 = (6 * E1 * E1 + b2 * E1 * one + b4 * one * one) // 2  # scale 2^(2K)
    BB = _m.isqrt(max(BB2, 0))
    bb = _fx(BB)
    return (2 * _m.pi / _agm(complex(2 * _m.sqrt(bb)), _cm.sqrt(_fx(2 * BB + AA)))).real


# ------------------------------------------------------------------ L-series at s = 1

def _e1(x):
    """The exponential integral E_1(x) for x > 0."""
    if x < 1:
        s, term, k = 0.0, 1.0, 1
        while True:
            term *= -x / k
            add = -term / k
            s += add
            if abs(add) < 1e-18 * max(1.0, abs(s)):
                break
            k += 1
        return -0.5772156649015328606 - _m.log(x) + s
    # continued fraction (Lentz)
    b = x + 1
    c = 1 / 1e-300
    d = 1 / b
    h = d
    for i in range(1, 300):
        an = -i * i
        b += 2
        d = 1 / (an * d + b)
        c = b + an / c
        de = c * d
        h *= de
        if abs(de - 1) < 1e-16:
            break
    return h * _m.exp(-x)


class _LData:
    """a_n and the series f(t) = sum a_n / n exp(-2 pi n t / sqrt(N))."""

    def __init__(self, an, N):
        self.an = an
        self.N = N

    def f(self, t):
        s = 0.0
        q = 2 * _m.pi * t / _m.sqrt(self.N)
        for n in range(1, len(self.an)):
            a = self.an[n]
            if a:
                s += a / n * _m.exp(-q * n)
        return s


def terms_needed(N, tmin=0.8):
    return int(45 * _m.sqrt(N) / (2 * _m.pi * tmin)) + 20


def root_number(ld):
    """w from the functional equation: L(E,1) = f(t) + w f(1/t) for every t > 0."""
    t = 1.2
    f1, ft, fi = ld.f(1.0), ld.f(t), ld.f(1 / t)
    w = (f1 - ft) / (fi - f1)
    if abs(abs(w) - 1) > 1e-6:
        raise ArithmeticError("root number test failed (%r): wrong conductor?" % w)
    return 1 if w > 0 else -1


def L1(ld, w):
    return (1 + w) * ld.f(1.0)


def L1_derivative(ld):
    """L'(E,1) for root number -1: 2 sum a_n / n E_1(2 pi n / sqrt(N))."""
    q = 2 * _m.pi / _m.sqrt(ld.N)
    s = 0.0
    for n in range(1, len(ld.an)):
        a = ld.an[n]
        if a:
            s += a / n * _e1(q * n)
    return 2 * s


# Higher derivatives (Buhler, Gross and Zagier; Cremona, Algorithms 2.13):
# when L(E,s) vanishes to order >= r at s = 1 (r of the parity of the root
# number), L^(r)(E,1) = 2 r! sum a_n / n G_r(2 pi n / sqrt N), with
# G_r(x) = 1/(r-1)! int_1^oo e^(-x t) (log t)^(r-1) dt / t  (G_0(x) = e^(-x)).
_ZETA = (0.0, 0.0, 1.6449340668482264, 1.2020569031595943, 1.0823232337111382,
         1.0369277551433699, 1.0173430619844491, 1.0083492773819228, 1.0040773561979443,
         1.0020083928260822, 1.0009945751278181, 1.0004941886041195, 1.0002460865533080)


def _gamma_taylor(r):
    """Taylor coefficients of Gamma(1 + z) up to z^r."""
    lg = [0.0, -0.5772156649015329] + [(-1) ** k * _ZETA[k] / k for k in range(2, r + 1)]
    e = [1.0] + [0.0] * r
    for n in range(1, r + 1):
        e[n] = sum(k * lg[k] * e[n - k] for k in range(1, n + 1)) / n
    return e


def _G(r, x, gt):
    if r == 0:
        return _m.exp(-x)
    if x < 4:
        # P_r(-log x) + sum_n (-1)^(n-r) x^n / (n^r n!), P_r(t) the z^r
        # coefficient of exp(t z) Gamma(1 + z)
        t = -_m.log(x)
        s = sum(t ** (r - n) / _m.factorial(r - n) * gt[n] for n in range(r + 1))
        term, n = 1.0, 1
        while True:
            term *= x / n
            add = (-1) ** (n - r) * term / n ** r
            s += add
            if abs(add) < 1e-18 and n > x:
                return s
            n += 1
    # e^(-x)/(r-1)! int_0^oo e^(-s) log(1 + s/x)^(r-1) / (x + s) ds, Simpson on [0, 40]
    m, h = 160, 40 / 160
    acc = 0.0
    for i in range(m + 1):
        s = i * h
        v = _m.exp(-s) * _m.log1p(s / x) ** (r - 1) / (x + s)
        acc += v * (1 if i in (0, m) else (4 if i % 2 else 2))
    return _m.exp(-x) * acc * h / 3 / _m.factorial(r - 1)


def L1_deriv(ld, r):
    """L^(r)(E,1), valid when L vanishes to order >= r at 1 (and r has the
    parity of the root number: otherwise L^(r)(E,1) is not given by this sum)."""
    q = 2 * _m.pi / _m.sqrt(ld.N)
    gt = _gamma_taylor(r)
    s = 0.0
    for n in range(1, len(ld.an)):
        a = ld.an[n]
        if a:
            x = q * n
            if x > 60:
                break
            s += a / n * _G(r, x, gt)
    return 2 * _m.factorial(r) * s


def analytic_rank_numerical(ld, w, max_rank=10, eps=1e-6):
    """(r, L^(r)(E,1)): the first r of the parity of w with |L^(r)(E,1)| > eps.
    Numerical: L^(k)(E,1) for k < r are only known to be small."""
    for r in range(0 if w == 1 else 1, max_rank + 1, 2):
        v = L1_deriv(ld, r)
        if abs(v) > eps:
            return r, v
    raise ArithmeticError("L(E,s) seems to vanish to order > %d at s = 1" % max_rank)


def recognize(x, dens, tol=1e-8):
    """The fraction m/d with d dividing an element of dens closest to x, if within tol."""
    best = None
    for d in sorted(set(dens)):
        m = round(x * d)
        err = abs(x - m / d)
        if err <= tol * max(1.0, abs(x)):
            if best is None or d < best.denominator:
                best = _F(m, d)
            break
    return best


# ------------------------------------------------------------------ points
# Affine points are (x, y) pairs of Fractions; None is the point at infinity.

def on_curve(a, P):
    if P is None:
        return True
    a1, a2, a3, a4, a6 = a
    x, y = P
    return y * y + a1 * x * y + a3 * y == x ** 3 + a2 * x * x + a4 * x + a6


def neg(a, P):
    if P is None:
        return None
    a1, a2, a3, a4, a6 = a
    x, y = P
    return (x, -y - a1 * x - a3)


def add(a, P, Q):
    """P + Q on y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6."""
    if P is None:
        return Q
    if Q is None:
        return P
    a1, a2, a3, a4, a6 = a
    x1, y1 = P
    x2, y2 = Q
    if x1 == x2:
        if y1 + y2 + a1 * x2 + a3 == 0:
            return None
        lam = (3 * x1 * x1 + 2 * a2 * x1 + a4 - a1 * y1) / (2 * y1 + a1 * x1 + a3)
        nu = (-x1 ** 3 + a4 * x1 + 2 * a6 - a3 * y1) / (2 * y1 + a1 * x1 + a3)
    else:
        lam = (y2 - y1) / (x2 - x1)
        nu = (y1 * x2 - y2 * x1) / (x2 - x1)
    x3 = lam * lam + a1 * lam - a2 - x1 - x2
    y3 = -(lam + a1) * x3 - nu - a3
    return (x3, y3)


def mul(a, n, P):
    n = int(n)
    if n < 0:
        return mul(a, -n, neg(a, P))
    R = None
    Q = P
    while n:
        if n & 1:
            R = add(a, R, Q)
        Q = add(a, Q, Q)
        n >>= 1
    return R


def point_order(a, P, bound=12):
    """The order of P if it is a torsion point (orders are at most 12 over Q), else 0."""
    Q = P
    for n in range(1, bound + 1):
        if Q is None:
            return n
        Q = add(a, Q, P)
        if Q is not None and (Q[0].denominator > 10 ** 6 and n > 1):
            # torsion points are nearly integral (Nagell-Lutz on any model with integral a_i: denominators divide 4)
            pass
    return 0 if Q is not None else bound + 1


def lift_x(a, x):
    """The points with x-coordinate x (a Fraction), as a list."""
    a1, a2, a3, a4, a6 = a
    x = _F(x)
    # y^2 + (a1 x + a3) y - (x^3 + a2 x^2 + a4 x + a6) = 0
    B = a1 * x + a3
    C = -(x ** 3 + a2 * x * x + a4 * x + a6)
    disc = B * B - 4 * C
    if disc < 0:
        return []
    n, d = disc.numerator, disc.denominator
    rn, rd = _m.isqrt(n), _m.isqrt(d)
    if rn * rn != n or rd * rd != d:
        return []
    r = _F(rn, rd)
    ys = sorted({(-B + r) / 2, (-B - r) / 2})
    return [(x, y) for y in ys]


def point_search(a, H, max_points=None):
    """Points with x = r/s^2, |r| <= e^H... in practice |r| <= H_r and s <= H_s:
    here H is the bound on the naive logarithmic height log max(|r|, s^2)."""
    a1, a2, a3, a4, a6 = a
    b2, b4, b6, b8 = _b(a)
    R = int(_m.exp(H))
    S = _m.isqrt(R)
    out = []
    for s in range(1, S + 1):
        s2 = s * s
        s4, s6 = s2 * s2, s2 * s2 * s2
        for r in range(-R, R + 1):
            if s > 1 and _m.gcd(r, s) != 1:
                continue
            # (2y + a1 x + a3)^2 = f(x) with x = r/s^2: s^6 f(x) = 4r^3 + b2 r^2 s^2 + 2 b4 r s^4 + b6 s^6
            F = 4 * r * r * r + b2 * r * r * s2 + 2 * b4 * r * s4 + b6 * s6
            if F < 0:
                continue
            q = _m.isqrt(F)
            if q * q != F:
                continue
            x = _F(r, s2)
            for P in lift_x(a, x):
                out.append(P)
            if max_points and len(out) >= max_points:
                return out
    return out


# ------------------------------------------------------------------ canonical height

def _periods(a):
    """(w1, w2) with w1 > 0 the least real period of the Neron lattice and
    tau = w2 / w1 in the upper half plane; and the real roots data."""
    b2, b4, b6, b8 = _b(a)
    D = _disc(a)
    coeffs = (4, b2, 2 * b4, b6)
    if D > 0:
        E1, E2, E3 = _real_roots_fixed(coeffs)
        e1, e2, e3 = _fx(E1), _fx(E2), _fx(E3)
        w1 = _m.pi / _agm(_cm.sqrt(_fx(E1 - E3)), _cm.sqrt(_fx(E1 - E2))).real
        w2 = 1j * _m.pi / _agm(_cm.sqrt(_fx(E1 - E3)), _cm.sqrt(_fx(E2 - E3))).real
        return w1, w2, (e1, e2, e3)
    e = _cubic_roots(4.0, float(b2), float(2 * b4), float(b6))
    E1 = _refine_real(coeffs, min(e, key=lambda x: abs(x.imag)).real)
    one = 1 << _K
    AA = 3 * E1 + b2 * one // 4
    BB2 = (6 * E1 * E1 + b2 * E1 * one + b4 * one * one) // 2
    BB = _m.isqrt(max(BB2, 0))
    bb = _fx(BB)
    w1 = (2 * _m.pi / _agm(complex(2 * _m.sqrt(bb)), _cm.sqrt(_fx(2 * BB + AA)))).real
    w2 = -w1 / 2 + 1j * _m.pi / _agm(complex(2 * _m.sqrt(bb)), _cm.sqrt(_fx(2 * BB - AA))).real
    e1 = _fx(E1)
    e23 = [z for z in e if abs(z.imag) > 0] or e
    return w1, w2, (e1,)


def _gauss_legendre(f, lo, hi, n=20):
    # nodes and weights for n = 20 (computed once)
    global _GL
    try:
        nodes = _GL
    except NameError:
        nodes = None
    if nodes is None:
        xs = []
        for i in range(1, n + 1):
            x = _m.cos(_m.pi * (i - 0.25) / (n + 0.5))
            for _ in range(100):
                p0, p1 = 1.0, x
                for k in range(2, n + 1):
                    p0, p1 = p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k
                dp = n * (x * p1 - p0) / (x * x - 1)
                dx = p1 / dp
                x -= dx
                if abs(dx) < 1e-16:
                    break
            xs.append((x, 2 / ((1 - x * x) * dp * dp)))
        _GL = xs
        nodes = xs
    m, h = (lo + hi) / 2, (hi - lo) / 2
    return h * sum(w * f(m + h * x) for x, w in nodes)


def _integrate(f, lo, hi, depth=0):
    """Adaptive Gauss-Legendre."""
    whole = _gauss_legendre(f, lo, hi)
    mid = (lo + hi) / 2
    halves = _gauss_legendre(f, lo, mid) + _gauss_legendre(f, mid, hi)
    if abs(whole - halves) <= 1e-15 * max(1.0, abs(halves)) or depth > 40:
        return halves
    return _integrate(f, lo, mid, depth + 1) + _integrate(f, mid, hi, depth + 1)


def elliptic_log_real(a, P, roots):
    """z in (0, w1/2]: the integral of dt / sqrt(f(t)) from x(P) to infinity, for
    a real point P on the identity component (x >= e1, the largest real root)."""
    x = float(P[0])
    if len(roots) == 3:
        e1, e2, e3 = roots
        al, be = e1 - e2, e1 - e3
        g = lambda r: 1 / _m.sqrt((1 + al * r * r) * (1 + be * r * r))
    else:
        e1 = roots[0]
        b2, b4, b6, b8 = _b(a)
        # f(t) = 4 (t - e1)(t^2 + p t + q): the quadratic factor
        p_ = b2 / 4 + e1
        q_ = (b4 / 2 + e1 * p_)
        # (t - e2)(t - e3) = t^2 + p t + q; with t = e1 + 1/r^2: r^-4 (1 + (2 e1 + p) r^2 + (e1^2 + p e1 + q) r^4)
        c1, c2 = 2 * e1 + p_, e1 * e1 + p_ * e1 + q_
        g = lambda r: 1 / _m.sqrt(1 + c1 * r * r + c2 * r ** 4)
    if x - e1 <= 0:
        r0 = 1e8
    else:
        r0 = 1 / _m.sqrt(x - e1)
    # split [0, r0] geometrically for large r0
    pts = [0.0]
    t = min(r0, 1.0)
    pts.append(t)
    while t < r0:
        t = min(t * 4, r0)
        pts.append(t)
    return sum(_integrate(g, lo, hi) for lo, hi in zip(pts, pts[1:]))


def _on_identity_component(a, P, roots):
    return len(roots) == 1 or float(P[0]) >= roots[0] - 1e-9 * max(1, abs(roots[0]))


def _reduces_nonsingular(a, P, p):
    """Does P (on a model integral and minimal at p) reduce to a nonsingular point mod p?"""
    a1, a2, a3, a4, a6 = a
    x, y = P
    if x.denominator % p == 0:
        return True  # reduces to O
    def ip(t):  # t mod p for p-integral t
        return t.numerator * pow(t.denominator, -1, p) % p
    xp, yp = ip(x), ip(y)
    fx = (3 * xp * xp + 2 * a2 * xp + a4 - a1 * yp) % p
    fy = (2 * yp + a1 * xp + a3) % p
    return fx != 0 or fy != 0


def _vq(t, p):
    """p-adic valuation of a nonzero Fraction (a large number for 0)."""
    if t == 0:
        return 10 ** 6
    return _v(t.numerator, p) - _v(t.denominator, p)


def _local_height_finite(a, P, p):
    """lambda_p(P) / log p for P on a model minimal at p (Silverman, "Computing
    heights on elliptic curves", Math. Comp. 51 (1988), Theorem 5.2), without
    the (1/12) v(Delta) term."""
    a1, a2, a3, a4, a6 = a
    b2, b4, b6, b8 = _b(a)
    x, y = P
    A = _vq(3 * x * x + 2 * a2 * x + a4 - a1 * y, p)
    B = _vq(2 * y + a1 * x + a3, p)
    if A <= 0 or B <= 0:
        return max(0, -_vq(x, p)) / 2
    N = _v(_disc(a), p)
    c4, c6 = _c(a)
    if c4 % p:
        M = min(B, N / 2)
        return -M * (N - M) / (2 * N)
    C = _vq(3 * x ** 4 + b2 * x ** 3 + 3 * b4 * x * x + 3 * b6 * x + b8, p)
    if C >= 3 * B:
        return -B / 3
    return -C / 8


def canonical_height(a, P, bad_primes):
    """The Neron-Tate height of P on the minimal model a, normalized as in
    Cremona's tables and Sage (h(P) ~ log max(|r|, s^2) for x = r/s^2)."""
    if P is None:
        return 0.0
    w1, w2, roots = _periods(a)
    Q, n = P, 1
    if not _on_identity_component(a, Q, roots):
        Q, n = add(a, P, P), 2
        if Q is None:
            return 0.0
    # the archimedean Neron function at z = the elliptic log of Q (real)
    z = elliptic_log_real(a, Q, roots)
    tau = w2 / w1
    qq = _cm.exp(2j * _m.pi * tau)
    u = _cm.exp(2j * _m.pi * z / w1)
    lam = -(1 / 12.0) * _m.log(abs(qq)) - _m.log(abs(1 - u))
    qn = qq
    for _ in range(2000):
        lam -= _m.log(abs((1 - qn * u) * (1 - qn / u)))
        if abs(qn) < 1e-18:
            break
        qn *= qq
    # the finite places: log of the denominator away from the bad primes,
    # and Silverman's local heights at them
    d = _m.isqrt(Q[0].denominator)
    fin = 0.0
    for p in bad_primes:
        k = _v(d, p)
        d //= p ** k
        fin += _local_height_finite(a, Q, p) * _m.log(p)
    fin += _m.log(d)
    h = lam + fin + _m.log(abs(_disc(a))) / 12
    return 2 * h / (n * n)


def height_pairing(a, P, Q, bad):
    return (canonical_height(a, add(a, P, Q), bad) - canonical_height(a, P, bad) - canonical_height(a, Q, bad)) / 2


def regulator(a, pts, bad):
    """det of the height pairing matrix of the points."""
    r = len(pts)
    M = [[0.0] * r for _ in range(r)]
    for i in range(r):
        M[i][i] = canonical_height(a, pts[i], bad)
        for j in range(i + 1, r):
            M[i][j] = M[j][i] = height_pairing(a, pts[i], pts[j], bad)
    # Gaussian elimination
    det = 1.0
    for i in range(r):
        piv = max(range(i, r), key=lambda k: abs(M[k][i]))
        if M[piv][i] == 0:
            return 0.0
        if piv != i:
            M[i], M[piv] = M[piv], M[i]
            det = -det
        det *= M[i][i]
        for k in range(i + 1, r):
            f = M[k][i] / M[i][i]
            for j in range(i, r):
                M[k][j] -= f * M[i][j]
    return det


# ------------------------------------------------------------------ reduction mod p and saturation

def _red_point(a, P, p):
    """P mod p as (x, y) in F_p or None (= O), for p not dividing the denominators unless P reduces to O."""
    if P is None:
        return None
    x, y = P
    if x.denominator % p == 0:
        return None
    return (x.numerator * pow(x.denominator, -1, p) % p, y.numerator * pow(y.denominator, -1, p) % p)


def _add_p(a, P, Q, p):
    if P is None:
        return Q
    if Q is None:
        return P
    a1, a2, a3, a4, a6 = (c % p for c in a)
    x1, y1 = P
    x2, y2 = Q
    if x1 == x2:
        if (y1 + y2 + a1 * x2 + a3) % p == 0:
            return None
        den = (2 * y1 + a1 * x1 + a3) % p
        lam = (3 * x1 * x1 + 2 * a2 * x1 + a4 - a1 * y1) * pow(den, -1, p) % p
    else:
        lam = (y2 - y1) * pow((x2 - x1) % p, -1, p) % p
    x3 = (lam * lam + a1 * lam - a2 - x1 - x2) % p
    y3 = (-(lam + a1) * x3 - (y1 - lam * x1) - a3) % p
    return (x3, y3)


def _mul_p(a, n, P, p):
    R, Q = None, P
    while n:
        if n & 1:
            R = _add_p(a, R, Q, p)
        Q = _add_p(a, Q, Q, p)
        n >>= 1
    return R


def not_divisible(a, P, ell, aps):
    """A proof that P is not in ell E(Q) + E(Q)_tors... more precisely not
    ell-divisible in E(Q): a good prime p with ell exactly dividing #E(F_p)
    and (#E(F_p)/ell) P != 0 mod p.  Returns that p, or None."""
    for p, ap in aps:
        if ap is None or p < 3:
            continue
        N = p + 1 - ap
        if N % ell or (N // ell) % ell == 0:
            continue
        Pp = _red_point(a, P, p)
        if Pp is None:
            continue
        if _mul_p(a, N // ell, Pp, p) is not None:
            return p
    return None


def search_generator(a, aps, bad, H=8.0):
    """The non-torsion point of least canonical height among the points of
    naive height at most H, or None."""
    best = None
    for P in point_search(a, H):
        if point_order(a, P) != 0:
            continue
        h = canonical_height(a, P, bad)
        if best is None or h < best[1] - 1e-9:
            best = (P, h)
    return best


# ------------------------------------------------------------------ 2-isogeny descent

def _poly_eval(g, x):
    r = 0
    for c in reversed(g):
        r = r * x + c
    return r


def _poly_deriv(g):
    return [i * g[i] for i in range(1, len(g))]


def _is_square_qp(c, p):
    """Is the nonzero rational c a square in Q_p?"""
    v = _vq(c, p)
    if v % 2:
        return False
    u = c / _F(p) ** v
    num, den = u.numerator, u.denominator
    if p == 2:
        return (num * den) % 8 == 1
    return _legendre(num * den, p) == 1


class _Budget(Exception):
    pass


def _compose_lin(g, t0, p):
    """The coefficients of g(t0 + p s) (integers, constant term first)."""
    out = [0] * len(g)
    # Horner: g(x) = (((g_n x + g_{n-1}) x + ...) with x = t0 + p s
    for c in reversed(g):
        # out = out * (t0 + p s) + c
        new = [0] * len(g)
        for i, oc in enumerate(out):
            if oc:
                new[i] += oc * t0
                if i + 1 < len(new):
                    new[i + 1] += oc * p
        new[0] += c
        out = new
    return out


def _strip_square_content(g, p):
    c = min(_v(x, p) for x in g if x)
    k = (c // 2) * 2
    return [x // p ** k for x in g]


def _zp_poly_soluble(g, p, budget, depth=0):
    """Is y^2 = g(s) soluble with s in Z_p (g integral, not identically 0)?"""
    budget[0] -= 1
    if budget[0] < 0 or depth > 80:
        raise _Budget()
    g = _strip_square_content(g, p)
    need = 3 if p == 2 else 1
    dg = _poly_deriv(g)
    for t0 in range(p):
        val = _poly_eval(g, t0)
        if val == 0:
            return True
        v = _v(val, p)
        h = _compose_lin(g, t0, p)  # h(s) = g(t0 + p s), h(0) = val
        # stable: the non-constant coefficients of h are divisible by p^(v + need)
        if all(c == 0 or _v(c, p) >= v + need for c in h[1:]):
            if _is_square_qp(_F(val), p):
                return True
            continue
        d = _poly_eval(dg, t0)
        if d != 0 and v > 2 * _v(d, p):
            return True  # Hensel: a root of g in t0 + p Z_p
        if _zp_poly_soluble(h, p, budget, depth + 1):
            return True
    return False


def quartic_locally_soluble(g, p, budget=200000):
    """Is y^2 = g(x) (g a quartic with integer coefficients, constant term
    first) soluble in Q_p, counting the points at infinity?  Returns None if
    undecided within the budget."""
    b = [budget]
    try:
        if _zp_poly_soluble(list(g), p, b):
            return True
        # x = 1/(p s): y'^2 = (p s)^4 g(1/(p s)) = reversed quartic at p s
        gr = list(reversed(g))
        return _zp_poly_soluble(_compose_lin(gr, 0, p), p, b)
    except _Budget:
        return None


def quartic_real_soluble(g):
    """Is g(x) > 0 for some real x (or a root), for a quartic g?"""
    if g[4] > 0 or g[0] > 0:
        return True
    # sample generously between the real critical points
    import cmath
    pts = []
    # derivative is a cubic: use its real roots
    d = _poly_deriv(g)
    for z in _cubic_roots(float(d[3]), float(d[2]), float(d[1]), float(d[0])) if d[3] else []:
        if abs(z.imag) < 1e-9 * (1 + abs(z)):
            pts.append(z.real)
    return any(_poly_eval([float(c) for c in g], t) >= 0 for t in pts)


def _squarefree_divisors(n, primes):
    """The squarefree divisors (with both signs) of n built from the primes dividing it."""
    ps = [p for p in primes if n % p == 0]
    out = [1]
    for p in ps:
        out = out + [d * p for d in out]
    return out + [-d for d in out]


def _two_torsion_model(a):
    """(A, B, (r, s, t, u-data)) with E isomorphic to y^2 = x^3 + A x^2 + B x
    (integers) via a rational 2-torsion point of a, or None."""
    a1, a2, a3, a4, a6 = a
    b2, b4, b6, b8 = _b(a)
    # 2-torsion: roots of 4x^3 + b2 x^2 + 2 b4 x + b6; scale x = X/4 for integer roots
    # X^3 + b2 X^2 + 8 b4 X + 16 b6 = 0 with X = 4x
    from sagebrush._engine import call
    fac = call("factor", f=[str(16 * b6), str(8 * b4), str(b2), "1"])["factors"]
    roots = [_F(-int(g[0]), 4) for g, e in fac if len(g) == 2 and int(g[1]) == 1]
    if not roots:
        return None
    x0 = roots[0]
    # (2y + a1 x + a3)^2 = 4x^3 + b2 x^2 + 2 b4 x + b6 = 4 (x - x0)(x^2 + c x + e)
    # with Y = 4(2y + a1 x + a3)... use X = 4(x - x0): Y^2 = X^3 + A X^2 + B X with Y = 4(2y + a1 x + a3)
    # 4 x^3 + b2 x^2 + 2 b4 x + b6 at x = x0 + X/4, times 16
    c3, c2, c1 = _F(1, 1), (12 * x0 + b2) / 4, (12 * x0 * x0 + 2 * b2 * x0 + 2 * b4)
    A, B = c2 * 4 / 4, c1
    # Y^2 = 16 * (4 (X/4)^3 + ...) = X^3 + (3*4*x0 + b2) X^2 + 4(12 x0^2 + 2 b2 x0 + 2 b4) X / 4...
    # compute directly: h(X) = 16 * F(x0 + X/4), F(x) = 4x^3 + b2 x^2 + 2 b4 x + b6
    F = lambda x: 4 * x ** 3 + b2 * x * x + 2 * b4 * x + b6
    # coefficients of h by interpolation (cubic, leading 1)
    h0 = 16 * F(x0)
    h1 = 16 * F(x0 + _F(1, 4)) - h0 - 1  # h(1) = 1 + A + B (h0 = 0)
    hm = 16 * F(x0 - _F(1, 4)) - h0 + 1  # h(-1) = -1 + A - B
    A = (h1 + hm) / 2
    B = (h1 - hm) / 2
    assert h0 == 0 and A.denominator == 1 and B.denominator == 1, "2-torsion model"
    return int(A), int(B), x0


def _quartic_points(d, A, e, bound):
    """Points (M, e', N) with N^2 = d M^4 + A M^2 e'^2 + e e'^4, gcd(M, e') = 1, small."""
    out = []
    for E2 in range(1, bound + 1):
        for M in range(-bound, bound + 1):
            if M == 0 or _m.gcd(M, E2) != 1:
                continue
            v = d * M ** 4 + A * M * M * E2 * E2 + e * E2 ** 4
            if v < 0:
                continue
            N = _m.isqrt(v)
            if N * N == v:
                out.append((M, E2, N))
                return out
    return out


def _sqfree(n):
    """The squarefree part of a nonzero integer (with sign)."""
    sgn = -1 if n < 0 else 1
    n = abs(n)
    out = 1
    for p, e in _factor_int(n) if n > 1 else []:
        if e % 2:
            out *= p
    return sgn * out


def _span_mod_squares(gens):
    """The subgroup of Q*/Q*^2 generated by the squarefree integers gens."""
    group = {1}
    for g in gens:
        g = _sqfree(g)
        if g not in group:
            group |= {_sqfree(h * g) for h in group}
    return group


def two_isogeny_descent(a, search_bound=60):
    """Descent via 2-isogeny for a curve a with a rational 2-torsion point.
    Returns a dict: rank bounds, the Selmer group sizes (#Sel^phi, #Sel^phihat)
    and the images found, and points of E (on the model y^2 = x^3 + A x^2 + B x)."""
    m = _two_torsion_model(a)
    if m is None:
        return None
    A, B, x0 = m
    Ap, Bp = -2 * A, A * A - 4 * B
    out = {"model": (A, B), "isogenous": (Ap, Bp)}
    sizes = []
    images = []
    pts = []
    for (AA, BB) in ((A, B), (Ap, Bp)):
        primes = sorted({p for p, _ in _factor_int(2 * BB * (AA * AA - 4 * BB))})
        sel, img = [], [1, BB]  # the images of O and of the 2-torsion point (0, 0)
        for d in _squarefree_divisors(abs(BB), [p for p, _ in _factor_int(BB)]):
            e = BB // d
            g = [e, 0, AA, 0, d]  # d M^4 + AA M^2 + e
            if not quartic_real_soluble(g):
                continue
            loc = [quartic_locally_soluble(g, p) for p in primes]
            if None in loc:
                out["undecided"] = out.get("undecided", 0) + 1
            if all(x is not False for x in loc):
                sel.append(d)
                if _sqfree(d) in _span_mod_squares(img):
                    continue
                q = _quartic_points(d, AA, e, search_bound)
                if q:
                    M, e2, N = q[0]
                    img.append(d)
                    X = _F(d * M * M, e2 * e2)
                    Y = _F(d * M * N, e2 ** 3)
                    pts.append(((AA, BB), (X, Y)))
        img = sorted(_span_mod_squares(img))
        sizes.append(len(sel))
        images.append(len(img))
    s1, s2 = sizes
    i1, i2 = images
    # 2^r = |alpha(E)| |alpha'(E')| / 4
    lower = int(round(_m.log2(max(i1, 1) * max(i2, 1)))) - 2
    upper = int(round(_m.log2(s1 * s2))) - 2
    out.update(selmer=(s1, s2), images=(i1, i2), rank_bounds=(max(lower, 0), upper), points=pts)
    return out
