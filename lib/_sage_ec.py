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
