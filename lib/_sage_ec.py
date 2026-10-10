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


def _f_bound(ld, t):
    """(f(t), err): f(t) = sum a_n/n e^(-q n), q = 2 pi t / sqrt(N), and a
    bound on its error: the tail beyond the stored a_n (|a_n| <= d(n) sqrt(n)
    <= 2 n, so at most 2 sum e^(-q n)), the rounding of the sum, and an
    allowance for exp."""
    q = 2 * _m.pi * t / _m.sqrt(ld.N)
    M = len(ld.an) - 1
    s = sabs = 0.0
    for n in range(1, M + 1):
        a = ld.an[n]
        if a:
            term = a / n * _m.exp(-q * n)
            s += term
            sabs += abs(term)
    tail = 2 * _m.exp(-q * (M + 1)) / (1 - _m.exp(-q))
    return s, tail * 1.01 + ((M + 10) * 2.3e-16 + 1e-13) * sabs + 1e-300


def certified_low_rank(ld):
    """The analytic rank if it is 0 or 1, decided on balls by the engine
    (engine/ap/src/lcert.rs: every exp, E_1 and sum enclosed, tails
    bounded; the systematic review's R2-EC-F2), else None.  The f64
    version below is kept for comparison only."""
    from sagebrush import ap as _apm
    r = _apm.low_rank(ld.an, ld.N)
    return None if r is None else r["rank"]


def certified_low_rank_f64(ld):
    """The analytic rank if it is 0 or 1, decided with error bounds (None
    otherwise, or if the bounds do not decide).  The root number w = +-1
    satisfies f(1) - f(t) = w (f(1/t) - f(1)): of A - B and A + B one is 0,
    so the other exceeding the errors decides w.  Rank 0: w = 1 and |L(E,1)|
    = |2 f(1)| beyond its error; rank 1: w = -1 and |L'(E,1)| beyond its
    error (E_1 allowed 1e-12 relatively).  (The floating root number and the
    threshold 1e-6 were taken as proofs: the systematic review's EC-F8.)
    The allowances for exp (1e-13) and E_1 (1e-12) are assumptions, not
    enclosures (R2-EC-F2): the decision is proved given them."""
    t = 1.2
    f1, e1 = _f_bound(ld, 1.0)
    ft, et = _f_bound(ld, t)
    fi, ei = _f_bound(ld, 1 / t)
    A, B = f1 - ft, fi - f1
    E = 2 * e1 + et + ei + 1e-15 * (abs(A) + abs(B))
    plus, minus = abs(A + B) > E, abs(A - B) > E
    if plus == minus:
        return None
    if plus:  # w = +1
        return 0 if abs(2 * f1) > 2 * e1 else None
    q = 2 * _m.pi / _m.sqrt(ld.N)
    M = len(ld.an) - 1
    s = sabs = 0.0
    for n in range(1, M + 1):
        a = ld.an[n]
        if a:
            term = a / n * _e1(q * n)
            s += term
            sabs += abs(term)
    tail = 2 * _m.exp(-q * (M + 1)) / ((1 - _m.exp(-q)) * q * (M + 1))
    err = 2 * (tail * 1.01 + ((M + 10) * 2.3e-16 + 1e-12) * sabs) + 1e-300
    return 1 if abs(2 * s) > err else None


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
    # e^(-x)/(r-1)! int_0^oo e^(-s) log(1 + s/x)^(r-1) / (x + s) ds, by
    # Gauss-Laguerre quadrature (the integrand is smooth: its only
    # singularity is at s = -x <= -4); 48 nodes give about 1e-14
    xs, ws = _laguerre()
    acc = 0.0
    for s_, w in zip(xs, ws):
        acc += w * _m.log1p(s_ / x) ** (r - 1) / (x + s_)
    return _m.exp(-x) * acc / _m.factorial(r - 1)


_LAGUERRE = None


def _laguerre(n=48):
    """Nodes and weights of n-point Gauss-Laguerre quadrature (Newton's
    method on the Laguerre polynomial L_n from asymptotic first guesses)."""
    global _LAGUERRE
    if _LAGUERRE is not None:
        return _LAGUERRE
    xs, ws = [], []
    z = 0.0
    for i in range(n):
        if i == 0:
            z = 3.0 / (1 + 2.4 * n)
        elif i == 1:
            z += 15.0 / (1 + 2.5 * n)
        else:
            z += (1 + 2.55 * (i - 1)) / (1.9 * (i - 1)) * (z - xs[i - 2])
        for _ in range(100):
            p1, p2 = 1.0, 0.0
            for j in range(1, n + 1):
                p3, p2 = p2, p1
                p1 = ((2 * j - 1 - z) * p2 - (j - 1) * p3) / j
            pp = n * (p1 - p2) / z
            z1, z = z, z - p1 / pp
            if abs(z - z1) <= 1e-15 * z:
                break
        xs.append(z)
        ws.append(-1 / (pp * n * p2))
    _LAGUERRE = (xs, ws)
    return _LAGUERRE


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
    # on a model with integral a_i, torsion points have 4x integral (and so do
    # their multiples): a multiple without it has infinite order, found before
    # the coordinates of 12P get large
    integral = all(isinstance(c, int) or getattr(c, "denominator", 0) == 1 for c in a)
    Q = P
    for n in range(1, bound + 1):
        if Q is None:
            return n
        if integral and (4 * _F(Q[0])).denominator != 1:
            return 0
        Q = add(a, Q, P)
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


def _integrate(f, lo, hi, tol=None, depth=0, whole=None):
    """Adaptive Gauss-Legendre: an absolute tolerance shared by the halves,
    never below what double precision can reach on a piece (else rounding
    noise would split forever)."""
    if whole is None:
        whole = _gauss_legendre(f, lo, hi)
    mid = (lo + hi) / 2
    left, right = _gauss_legendre(f, lo, mid), _gauss_legendre(f, mid, hi)
    halves = left + right
    if tol is None:
        tol = 1e-15 * max(1.0, abs(halves))
    if abs(whole - halves) <= max(tol, 8e-16 * abs(halves)) or depth > 30:
        return halves
    return (_integrate(f, lo, mid, tol / 2, depth + 1, left) +
            _integrate(f, mid, hi, tol / 2, depth + 1, right))


def _carlson_rf(x, y, z):
    """Carlson's R_F(x, y, z) = 1/2 int_0^oo dt / sqrt((t+x)(t+y)(t+z)), by
    duplication (x, y, z real >= 0 or complex off the negative axis)."""
    while True:
        sx, sy, sz = _cm.sqrt(x), _cm.sqrt(y), _cm.sqrt(z)
        lam = sx * (sy + sz) + sy * sz
        x, y, z = (x + lam) / 4, (y + lam) / 4, (z + lam) / 4
        ave = (x + y + z) / 3
        dx, dy, dz = (ave - x) / ave, (ave - y) / ave, (ave - z) / ave
        if max(abs(dx), abs(dy), abs(dz)) < 0.0025:
            break
    e2 = dx * dy - dz * dz
    e3 = dx * dy * dz
    return (1 + (e2 / 24 - 0.1 - 3 * e3 / 44) * e2 + e3 / 14) / _cm.sqrt(ave)


_ROOTS_FIXED = {}


def _roots_fixed(a):
    """The roots of 4x^3 + b2 x^2 + 2 b4 x + b6 in fixed point (scale
    2^_K): ('3', E1, E2, E3) real, or ('1', E1, U, V) with e1 real and
    e2, e3 = u +- iv (v from the fixed-point discriminant: exact even when
    the complex roots are nearly real)."""
    key = tuple(a)
    if key not in _ROOTS_FIXED:
        b2, b4, b6, b8 = _b(a)
        coeffs = (4, b2, 2 * b4, b6)
        one = 1 << _K
        if _disc(a) > 0:
            _ROOTS_FIXED[key] = ("3",) + tuple(_real_roots_fixed(coeffs))
        else:
            e = _cubic_roots(4.0, float(b2), float(2 * b4), float(b6))
            E1 = _refine_real(coeffs, min(e, key=lambda x: abs(x.imag)).real)
            # 4 (x - e1)(x^2 + p x + q): p = b2/4 + e1, q = b4/2 + e1 p
            P = b2 * one // 4 + E1
            Q = b4 * one // 2 + E1 * P // one
            disc = P * P - 4 * Q * one  # scale 2^(2K), negative
            V = _m.isqrt(max(-disc, 0)) // 2
            _ROOTS_FIXED[key] = ("1", E1, -P // 2, V)
    return _ROOTS_FIXED[key]


def elliptic_log_real(a, P, roots):
    """z in (0, w1/2]: the integral of dt / sqrt(f(t)) from x(P) to infinity,
    f = 4x^3 + b2 x^2 + 2 b4 x + b6 = 4 (x - e1)(x - e2)(x - e3), for a real
    point P on the identity component (x >= e1, the largest real root):
    R_F(x - e1, x - e2, x - e3) (Carlson), with the differences x - e_i
    computed in fixed point: robust also for nearly singular curves (close
    roots, or complex roots nearly real)."""
    one = 1 << _K
    X = P[0].numerator * one // P[0].denominator
    r = _roots_fixed(a)
    if r[0] == "3":
        d1, d2, d3 = (complex(_fx(max(X - E, 0))) for E in r[1:])
    else:
        _, E1, U, V = r
        d1 = complex(_fx(max(X - E1, 0)))
        re, im = _fx(X - U), _fx(V)
        d2, d3 = complex(re, -im), complex(re, im)
    return _carlson_rf(d1, d2, d3).real


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
    the (1/12) v(Delta) term; an exact Fraction."""
    a1, a2, a3, a4, a6 = a
    b2, b4, b6, b8 = _b(a)
    x, y = P
    A = _vq(3 * x * x + 2 * a2 * x + a4 - a1 * y, p)
    B = _vq(2 * y + a1 * x + a3, p)
    if A <= 0 or B <= 0:
        return _F(max(0, -_vq(x, p)), 2)
    N = _v(_disc(a), p)
    c4, c6 = _c(a)
    if c4 % p:
        M = min(_F(B), _F(N, 2))
        return -M * (N - M) / (2 * N)
    C = _vq(3 * x ** 4 + b2 * x ** 3 + 3 * b4 * x * x + 3 * b6 * x + b8, p)
    if C >= 3 * B:
        return _F(-B, 3)
    return _F(-C, 8)


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


def canonical_height_ball(a, P, bad_primes, prec=128):
    """(lo, hi): exact Fractions with lo <= hhat(P) <= hi, from the engine's
    ball arithmetic (engine/ap/src/height.rs: the periods, the elliptic
    logarithm and the theta product with enclosures, the systematic review's
    R2-EC-F3); the finite local terms are exact here."""
    from sagebrush._engine import call
    if P is None:
        return _F(0), _F(0)
    r = _roots_fixed(a)
    roots = [[str(E), _K] for E in r[1:]] if r[0] == "3" else [[str(r[1]), _K]]
    for Q, n in ((P, 1), (add(a, P, P), 2)):
        if Q is None:
            return _F(0), _F(0)
        d = _m.isqrt(Q[0].denominator)
        local = []
        for p in bad_primes:
            d //= p ** _v(d, p)
            nu = _local_height_finite(a, Q, p)
            local.append([str(p), str(nu.numerator), str(nu.denominator)])
        try:
            h = call("ec_height", a=[str(int(c)) for c in a], x=[str(Q[0].numerator), str(Q[0].denominator)],
                     n=n, local=local, d=str(d), roots=roots, prec=int(prec))
        except ValueError as e:
            # 2P is on the identity component
            if n == 1 and "identity component" in str(e):
                continue
            raise
        (lm, le), (um, ue) = ((int(m), int(e)) for m, e in (h["lo"], h["hi"]))
        return _dyadic(lm, le), _dyadic(um, ue)


def _dyadic(m, e):
    return _F(m * 2 ** e) if e >= 0 else _F(m, 2 ** -e)


def log_ball(x, prec=128):
    """(lo, hi): exact Fractions enclosing log(x) for a positive rational x
    (the engine's ball logarithm)."""
    from sagebrush._engine import call
    x = _F(x)
    h = call("ball_log", x=[str(x.numerator), str(x.denominator)], prec=int(prec))
    return _dyadic(int(h["lo"][0]), int(h["lo"][1])), _dyadic(int(h["hi"][0]), int(h["hi"][1]))


def height_pairing_ball(a, P, Q, bad, prec=128):
    """(lo, hi) enclosing <P, Q> = (hhat(P + Q) - hhat(P) - hhat(Q)) / 2."""
    s = canonical_height_ball(a, add(a, P, Q), bad, prec)
    p = canonical_height_ball(a, P, bad, prec)
    q = canonical_height_ball(a, Q, bad, prec)
    return (s[0] - p[1] - q[1]) / 2, (s[1] - p[0] - q[0]) / 2


def height_pairing(a, P, Q, bad):
    return (canonical_height(a, add(a, P, Q), bad) - canonical_height(a, P, bad) - canonical_height(a, Q, bad)) / 2


def _lll_points(a, pts, bad):
    """An LLL-reduced basis of the lattice the points span (independent points)."""
    r = len(pts)
    if r >= 2:
        G = [[height_pairing(a, P, Q, bad) for Q in pts] for P in pts]
        U = _lll_gram(G)
        if any(U[i][j] != (i == j) for i in range(r) for j in range(r)):
            pts = [_combo(a, pts, u) for u in U]
    return pts


def _iv_mul(x, y):
    p = (x[0] * y[0], x[0] * y[1], x[1] * y[0], x[1] * y[1])
    return min(p), max(p)


def _iv_out(x, k):
    """[lo, hi] widened to the grid 2^-k (bounds the sizes of the Fractions)."""
    one = 1 << k
    return _F(_m.floor(x[0] * one), one), _F(-_m.floor(-x[1] * one), one)


def regulator_ball(a, pts, bad, prec=128):
    """(lo, hi): exact Fractions enclosing the regulator of the points
    (independent, of infinite order), from canonical_height_ball: the Gram
    matrix of an LLL-reduced basis as intervals, eliminated without pivoting
    (the matrix is positive definite, so its pivots are positive) with the
    intervals widened outward; also hi <= the product of the heights
    (Hadamard's inequality for a Gram matrix), the bound used if a pivot's
    interval reaches 0."""
    r = len(pts)
    if r == 0:
        return _F(1), _F(1)
    pts = _lll_points(a, pts, bad)
    h = [canonical_height_ball(a, P, bad, prec) for P in pts]
    M = [[None] * r for _ in range(r)]
    for i in range(r):
        M[i][i] = h[i]
        for j in range(i + 1, r):
            s = canonical_height_ball(a, add(a, pts[i], pts[j]), bad, prec)
            M[i][j] = M[j][i] = ((s[0] - h[i][1] - h[j][1]) / 2, (s[1] - h[i][0] - h[j][0]) / 2)
    hadamard = _F(1)
    for lo, hi in h:
        hadamard *= hi
    k = prec + 64
    det = (_F(1), _F(1))
    for i in range(r):
        piv = M[i][i]
        if piv[0] <= 0:
            return _F(0), hadamard
        det = _iv_out(_iv_mul(det, piv), k)
        for i2 in range(i + 1, r):
            c = M[i2][i]
            q = (c[0] / piv[0], c[0] / piv[1], c[1] / piv[0], c[1] / piv[1])
            f = (min(q), max(q))
            for j in range(i + 1, r):
                fm = _iv_mul(f, M[i][j])
                M[i2][j] = _iv_out((M[i2][j][0] - fm[1], M[i2][j][1] - fm[0]), k)
    return max(det[0], _F(0)), min(det[1], hadamard)


def regulator(a, pts, bad):
    """det of the height pairing matrix of the points: of an LLL-reduced
    basis of the same lattice (the determinant is unchanged), whose heights
    are computed from the reduced points themselves (from [P, 300 P + Q] on
    389a1 the pairing matrix lost about 1e-9 of its determinant: the
    systematic review's R2-EC-F3)."""
    r = len(pts)
    pts = _lll_points(a, pts, bad)
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
    """Is g(x) >= 0 for some real x, for a quartic g (constant term first)?
    Exactly: yes if the leading or constant coefficient is positive, or the
    degree is odd; otherwise g tends to -infinity both ways, and it is >= 0
    somewhere exactly when it has a real root (a Sturm count over Q; a
    double-precision check said yes for -(x^2 - 10^8)^2 - 1: the systematic
    review's EC-F9)."""
    from fractions import Fraction as Fr
    c = [Fr(x) for x in g]
    while len(c) > 1 and c[-1] == 0:
        c.pop()
    if len(c) == 1:
        return c[0] >= 0
    if c[-1] > 0 or c[0] > 0 or (len(c) - 1) % 2 == 1:
        return True
    return _sturm_real_roots(c) > 0


def _sturm_real_roots(c):
    """The number of distinct real roots of the polynomial c (Fractions,
    constant term first, nonzero)."""
    def deriv(p):
        return [i * p[i] for i in range(1, len(p))]

    def rem(a, b):
        a = list(a)
        while len(a) >= len(b) and any(a):
            if a[-1] == 0:
                a.pop()
                continue
            q = a[-1] / b[-1]
            k = len(a) - len(b)
            for i in range(len(b)):
                a[i + k] -= q * b[i]
            a.pop()
        while a and a[-1] == 0:
            a.pop()
        return a
    seq = [c, deriv(c)]
    while seq[-1] and len(seq[-1]) > 1:
        r = rem(seq[-2], seq[-1])
        if not r:
            break
        seq.append([-x for x in r])

    def changes(signs):
        signs = [s for s in signs if s != 0]
        return sum(1 for u, v in zip(signs, signs[1:]) if u != v)
    # signs at -infinity and +infinity: from the leading coefficients
    at_pinf = [(p[-1] > 0) - (p[-1] < 0) for p in seq if p]
    at_minf = [((p[-1] > 0) - (p[-1] < 0)) * (1 if (len(p) - 1) % 2 == 0 else -1) for p in seq if p]
    return changes(at_minf) - changes(at_pinf)


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


# ------------------------------------------------------------------ general 2-descent
# Birch and Swinnerton-Dyer's method: the elements of the 2-Selmer group are
# the everywhere locally soluble integral quartics y^2 = g(x, z) with
# invariants I = c4, J = 2 c6 of the minimal model (Cremona, Fisher and Stoll
# 2010, Theorem 1.1), up to equivalence.  The search for the quartics with
# reduced covariant is in Rust (engine/ap/src/quartic.rs).  A quartic's class
# in A*/A*^2, A = Q[phi]/(phi^3 - 3 I phi + J), is that of (4 a phi - H)/3
# (an invariant of the quartic); a point (X, Y) of Y^2 = X^3 - 27 I X - 27 J
# has class X + 3 phi.  Classes are compared through characters: the
# Legendre symbol at p of the value at a root of phi^3 - 3 I phi + J mod p,
# for many auxiliary primes p (distinct classes of A(S,2) differ at about half
# of all such characters, so 2^-k is the chance that k agree by accident).

def _form_tr(f, p, q, r, s):
    """f = [a, b, c, d, e] (sum f_k X^(4-k) Y^k) at X -> pX + qY, Y -> rX + sY."""
    def pm(A, B):
        o = [0] * (len(A) + len(B) - 1)
        for i, x in enumerate(A):
            for j, y in enumerate(B):
                o[i + j] += x * y
        return o
    pw1, pw2 = [[1]], [[1]]
    for _ in range(4):
        pw1.append(pm(pw1[-1], [p, q]))
        pw2.append(pm(pw2[-1], [r, s]))
    out = [0] * 5
    for k, fk in enumerate(f):
        if fk:
            for i, x in enumerate(pm(pw1[4 - k], pw2[k])):
                out[i] += fk * x
    return out


def _descent_characters(I, J, bad, k=64):
    out, p = [], 5
    while len(out) < k:
        p += 2
        if any(p % q == 0 for q in range(3, _m.isqrt(p) + 1, 2)) or bad % p == 0:
            continue
        for r in _cubic_roots_mod(0, (-3 * I) % p, J % p, p):
            out.append((p, r))
    return out


def _quartic_class(f, chars):
    v = []
    for p, r in chars:
        g, k = f, 0
        while True:
            a, b, c = g[0], g[1], g[2]
            x = _legendre((4 * a * r - (8 * a * c - 3 * b * b)) * _inv(3, p), p)
            if x:
                break
            k += 1
            g = _form_tr(f, 1, 0, k, 1)  # an equivalent quartic, the same class
        v.append(x)
    return tuple(v)


def _point_class(X, chars):
    n, d = X.numerator, X.denominator
    return tuple(_legendre((n + 3 * r * d) * d, p) for p, r in chars)


def _quartic_rational_point(f, B):
    a, b, c, d, e = f
    for z in range(0, B + 1):
        for x in range(-B, B + 1):
            if (z == 0 and x != 1) or _m.gcd(x, z) != 1:
                continue
            v = (((a * x + b * z) * x + c * z * z) * x + d * z ** 3) * x + e * z ** 4
            if v > 0:
                s = _m.isqrt(v)
                if s * s == v:
                    return x, z, s
    return None


def _xgcd(a, b):
    if b == 0:
        return (a, 1, 0) if a >= 0 else (-a, -1, 0)
    g, x, y = _xgcd(b, a % b)
    return g, y, x - (a // b) * y


def _quartic_to_E(f, x0, z0, s):
    """The image (X, Y) on Y^2 = X^3 - 27 I X - 27 J of (x0 : z0 : s) on
    y^2 = f: move the point to (1 : 0); then X = -3H/(4a), Y = 27R/(8 s^3)."""
    g, u, v = _xgcd(x0, z0)
    h = _form_tr(f, x0, -v, z0, u)
    a, b, c, d = h[:4]
    H = 8 * a * c - 3 * b * b
    R = b ** 3 + 8 * a * a * d - 4 * a * b * c
    return _F(-3 * H, 4 * a), _F(27 * R, 8 * s ** 3)


def two_descent(a, quartic_bound=60, point_bound=6.0, max_candidates=1e10, algorithm=None):
    """General 2-descent on a minimal model a without rational 2-torsion.
    Returns a dict with the 2-Selmer group size, rank bounds (from it and from
    the points found on E and on the quartics) and the points (on a).
    algorithm "quartic": the BSD quartics, found by a search that visits
    about |Delta|^(1/2) candidates (1e10 takes seconds); "cubic": the
    2-Selmer group from S-units of the cubic field Q[x]/(f)
    (_sage_ec_cubic.py), with points from a search on E only.  By default
    the quartics, and the cubic field beyond max_candidates."""
    from sagebrush._engine import call
    if algorithm == "cubic":
        return two_descent_cubic(a)
    c4, c6 = _c(a)
    b2 = _b(a)[0]
    a1, a3 = a[0], a[2]
    D = _disc(a)
    I, J = c4, 2 * c6
    try:
        res = call("quartic_search", I=str(I), J=str(J), max_cost=float(max_candidates))
    except Exception as e:
        if "too large" in str(e) or "beyond 128 bits" in str(e):
            if algorithm == "quartic":
                raise NotImplementedError("2-descent: %s" % e)
            return two_descent_cubic(a)
        raise
    qs = [[int(x) for x in f] for f in res["quartics"]]
    primes = sorted({p for p, _ in _factor_int(abs(2 * D))})
    chars = _descent_characters(I, J, 6 * D)
    # points on E (naive height search): drop the characters that vanish at one
    pts = []
    for P in point_search(a, point_bound):
        X = 36 * _F(P[0]) + 3 * b2
        pts.append((P, _point_class(X, chars)))
    keep = [i for i in range(len(chars)) if all(v[i] for _, v in pts)]
    chars = [chars[i] for i in keep]
    pts = [(P, tuple(v[i] for i in keep)) for P, v in pts]
    sel, undecided = {}, 0
    for f in qs:
        g = list(reversed(f))
        if not quartic_real_soluble(g):
            continue
        loc = [quartic_locally_soluble(g, p) for p in primes]
        if False in loc:
            continue
        if None in loc:
            undecided += 1
        sel.setdefault(_quartic_class(f, chars), f)
    one = tuple([1] * len(chars))
    sel.setdefault(one, None)
    span, gens = {one}, []
    def add(v, P):
        nonlocal span
        if v not in span:
            span |= {tuple(s * t for s, t in zip(v, w)) for w in span}
            gens.append(P)
    for P, v in pts:
        add(v, P)
    for cl, f in sel.items():
        if f is None or cl in span:
            continue
        q = _quartic_rational_point(f, quartic_bound)
        if q:
            X, Y = _quartic_to_E(f, *q)
            x = (X - 3 * b2) / 36
            y = (Y / 108 - a1 * x - a3) / 2
            assert on_curve(a, (x, y)), "2-descent: the covering map left the curve"
            v = _point_class(X, chars)
            if 0 not in v:
                add(v, (x, y))
    s = len(sel)
    closed = all(tuple(x * y for x, y in zip(u, v)) in sel for u in sel for v in sel)
    upper = (s - 1).bit_length() if closed else s.bit_length()  # log2 when a power of 2
    lower = len(span).bit_length() - 1
    out = dict(selmer=s, rank_bounds=(lower, upper), points=gens, closed=closed,
               undecided=undecided, quartics=len(qs), work=res["work"], cost=res["cost"],
               algorithm="quartic", grh=False)
    # (also when the quartic algorithm was asked for: its classes come from
    # floating point, and it returned Selmer order 2 for 9709b3, whose rank
    # is 2, with closed=True: the systematic review's EC-F9)
    # Cross-check with the cubic field.  The points from the quartics are
    # checked on E, but the search region and the classes come from floating
    # point (covariants, the resolvent's roots), which lose their digits when
    # |j| is huge: 9709b3 (|j| ~ 4e20) misses half the Selmer group, 1342c3
    # (|j| ~ 1e26) splits the trivial class in two.  The cubic field's count
    # is exact assuming GRH (its class group), and decides when they differ.
    # The quartic count alone is not certified (floating-point classes), and
    # agreeing with the cubic count does not certify it: the upper bound then
    # rests on the cubic field's class group, with what that assumes; without
    # a cubic count the bound is marked unverified (5077a1 had assumes=[]:
    # the systematic review's R2-EC-F1)
    try:
        import _sage_ec_cubic as cd
        sel_c = cd.selmer(a)
        sc = sel_c["dim"]
    except (ArithmeticError, NotImplementedError, ValueError, RuntimeError):
        out.update(grh=True, certified=False, assumes=["the quartic descent's Selmer classes (floating point, without the cubic field's cross-check)"])
        return out
    out.update(grh=True, assumes=sel_c.get("assumes", ["GRH"]), certified=sel_c.get("certified", False))
    sq = (s - 1).bit_length() if closed and s & (s - 1) == 0 else None
    if sq != sc:
        bad = [p for p, _ in _factor_int(D)]
        pts = independent_points(a, list(gens) + point_search_engine(a, 10.0, limit=20000), bad, sc)
        out.update(selmer=2 ** sc, rank_bounds=(max(lower, len(pts)), sc), points=pts, grh=True, quartic_selmer=s,
                   assumes=sel_c.get("assumes", ["GRH"]), certified=sel_c.get("certified", False))
    return out


def independent_points(a, cands, bad, rmax):
    """Independent points of infinite order among cands (smallest heights
    first, at most rmax): each is kept if the height Gram determinant stays
    clearly positive."""
    pool, seen = [], set()
    for P in cands:
        if P is None or P[0] in seen or point_order(a, P) != 0:
            continue
        seen.add(P[0])
        pool.append((canonical_height(a, P, bad), P))
    pool.sort(key=lambda t: t[0])
    chosen = []
    for h, P in pool:
        if len(chosen) == rmax:
            break
        trial = chosen + [P]
        G = [[height_pairing(a, X, Y, bad) for Y in trial] for X in trial]
        if _det_float(G) > 1e-7 * _m.prod(G[i][i] for i in range(len(trial))):
            chosen = trial
    return chosen


def _det_float(G):
    n = len(G)
    M = [list(map(float, row)) for row in G]
    d = 1.0
    for c in range(n):
        piv = max(range(c, n), key=lambda i: abs(M[i][c]))
        if M[piv][c] == 0:
            return 0.0
        if piv != c:
            M[c], M[piv] = M[piv], M[c]
            d = -d
        d *= M[c][c]
        for i in range(c + 1, n):
            f = M[i][c] / M[c][c]
            for j in range(c, n):
                M[i][j] -= f * M[c][j]
    return d


def two_descent_cubic(a, heights=(8.0, 10.0, 12.0)):
    """two_descent by the cubic field: the 2-Selmer group exactly (the rank
    is at most its dimension), and independent points from searches on E
    up to the given naive heights, until there are as many."""
    import _sage_ec_cubic as cd
    sel = cd.selmer(a)
    s = sel["dim"]
    bad = [p for p, _ in _factor_int(_disc(a))]
    pts = []
    for H in heights:
        if len(pts) >= s:
            break
        pts = independent_points(a, point_search_engine(a, H, limit=20000), bad, s)
    return dict(selmer=2 ** s, rank_bounds=(len(pts), s), points=pts, closed=True,
                undecided=0, quartics=None, work=None, cost=None, algorithm="cubic", grh=True,
                assumes=sel.get("assumes", ["GRH"]), certified=sel.get("certified", False))


# ------------------------------------------------------------------ saturation
# Generators of E(Q) from independent points: saturate the subgroup they
# span at every prime p up to a bound on its index.
#  * p-saturation (Cremona, Prickett and Siksek's method, as in mwrank): a
#    combination sum a_i P_i in pE(Q) maps to 0 in E(F_q)/pE(F_q) for every
#    good prime q; with p exactly dividing #E(F_q) that group is Z/p, read
#    off as (#E(F_q)/p) P in E(F_q)[p].  Enough primes q leave no
#    combination (p-saturated: proved), or a candidate R, which is divided
#    by p exactly: the x-coordinates of the Q with pQ = R are the rational
#    roots of phi_p(x) - x(R) psi_p(x)^2 (division polynomials).
#  * the index: E(Q)/tors is a lattice for the height pairing whose nonzero
#    vectors have height at least lambda, so its covolume is at least
#    (lambda/gamma_r)^r (Hermite's constant) and the index n of the span of
#    the points satisfies n^2 <= R(points) gamma_r^r / lambda^r.  lambda comes
#    from a bound B for h(x(P)) - hhat(P) (the smaller of Silverman's, Math.
#    Comp. 55, 1990, in Sage's normalization, and Cremona-Prickett-Siksek's,
#    cps_bound) and an exhaustive search of the points of naive height <= T:
#    every point it misses has hhat > T - B.

def point_search_engine(a, H, limit=100000, R=None):
    """The points with x = r/s^2, log max(|r|, s^2) <= H (the Rust engine's
    search; x lifted to the points above it).  Exactly: max(|r|, s^2) <= R
    with R = int(exp(H)) (a double), or the R given."""
    from sagebrush._engine import call
    b2, b4, b6, _ = _b(a)
    if R is None:
        R = int(_m.exp(H))
    S = _m.isqrt(R)
    xs = call("ec_point_search", b=[str(b2), str(b4), str(b6)], rmax=R, smax=S, limit=limit)
    out = []
    for r, s in xs:
        for P in lift_x(a, _F(int(r), int(s) ** 2)):
            out.append(P)
    return out


def _polymul(f, g):
    if not f or not g:
        return []
    out = [0] * (len(f) + len(g) - 1)
    for i, x in enumerate(f):
        if x:
            for j, y in enumerate(g):
                out[i + j] += x * y
    return out


def _polyadd(f, g, sign=1):
    n = max(len(f), len(g))
    out = [(f[i] if i < len(f) else 0) + sign * (g[i] if i < len(g) else 0) for i in range(n)]
    while out and out[-1] == 0:
        out.pop()
    return out


def _division_polys(a, n):
    """[psi~_0, ..., psi~_n] (integer polynomials in x, constant first):
    psi_k = psi~_k for odd k, psi_k = psi_2 psi~_k for even k, with
    psi_2^2 = F = 4x^3 + b2 x^2 + 2 b4 x + b6."""
    b2, b4, b6, b8 = _b(a)
    F = [b6, 2 * b4, b2, 4]
    F2 = _polymul(F, F)
    psi = [[], [1], [1], [b8, 3 * b6, 3 * b4, b2, 3],
           [b4 * b8 - b6 * b6, b2 * b8 - b4 * b6, 10 * b8, 10 * b6, 5 * b4, b2, 2]]
    for k in range(5, n + 1):
        m = k // 2
        P = lambda i: psi[i]
        if k % 2:  # k = 2m + 1
            t1 = _polymul(P(m + 2), _polymul(P(m), _polymul(P(m), P(m))))
            t2 = _polymul(P(m - 1), _polymul(P(m + 1), _polymul(P(m + 1), P(m + 1))))
            if m % 2 == 0:
                t1 = _polymul(F2, t1)
            else:
                t2 = _polymul(F2, t2)
            psi.append(_polyadd(t1, t2, -1))
        else:  # k = 2m
            t1 = _polymul(P(m + 2), _polymul(P(m - 1), P(m - 1)))
            t2 = _polymul(P(m - 2), _polymul(P(m + 1), P(m + 1)))
            psi.append(_polymul(P(m), _polyadd(t1, t2, -1)))
    return psi[: n + 1]


def divide_point(a, R, p):
    """A point Q with pQ = R (p prime), or None.  R is a point (x, y) of the
    curve a (integral coefficients)."""
    if R is None:
        return None
    from sagebrush._engine import call
    psi = _division_polys(a, p + 1)
    b2, b4, b6, _ = _b(a)
    F = [b6, 2 * b4, b2, 4]
    sq = lambda f: _polymul(f, f)
    # phi_p = x psi_p^2 - psi_{p+1} psi_{p-1}
    if p == 2:
        phi, den = _polyadd(_polymul([0, 1], F), psi[3], -1), F
    else:
        phi = _polyadd(_polymul([0, 1], sq(psi[p])), _polymul(F, _polymul(psi[p + 1], psi[p - 1])), -1)
        den = sq(psi[p])
    xr = R[0]
    g = _polyadd([c * xr.denominator for c in phi], [c * xr.numerator for c in den], -1)
    if not g:
        return None
    while g and g[0] == 0:  # x = 0 is a root
        g = g[1:]
        for Q in lift_x(a, _F(0)):
            if mul(a, p, Q) == R:
                return Q
    from math import gcd
    c = 0
    for t in g:
        c = gcd(c, t)
    g = [t // c for t in g]
    fac = call("factor", f=[str(t) for t in g])["factors"]
    for f, e in fac:
        if len(f) == 2:
            x = _F(-int(f[0]), int(f[1]))
            for Q in lift_x(a, x):
                if mul(a, p, Q) == R:
                    return Q
    return None


def _combo(a, pts, coeffs):
    R = None
    for c, P in zip(coeffs, pts):
        if c:
            R = add(a, R, mul(a, c, P))
    return R


def _kernel_mod_p(rows, n, p):
    """A basis of {v in F_p^n : r . v = 0 for every row r}."""
    rows = [list(r) for r in rows]
    piv = []
    m = 0
    for col in range(n):
        k = next((i for i in range(m, len(rows)) if rows[i][col] % p), None)
        if k is None:
            continue
        rows[m], rows[k] = rows[k], rows[m]
        inv = pow(rows[m][col], -1, p)
        rows[m] = [x * inv % p for x in rows[m]]
        for i in range(len(rows)):
            if i != m and rows[i][col] % p:
                f = rows[i][col]
                rows[i] = [(x - f * y) % p for x, y in zip(rows[i], rows[m])]
        piv.append(col)
        m += 1
    free = [c for c in range(n) if c not in piv]
    basis = []
    for fcol in free:
        v = [0] * n
        v[fcol] = 1
        for i, c in enumerate(piv):
            v[c] = -rows[i][fcol] % p
        basis.append(v)
    return basis


def _sqrt_mod(n, q):
    """A square root of n mod the odd prime q (Tonelli-Shanks), or None."""
    n %= q
    if n == 0:
        return 0
    if pow(n, (q - 1) // 2, q) != 1:
        return None
    if q % 4 == 3:
        return pow(n, (q + 1) // 4, q)
    s, e = q - 1, 0
    while s % 2 == 0:
        s //= 2
        e += 1
    z = 2
    while pow(z, (q - 1) // 2, q) != q - 1:
        z += 1
    x, b, g, r = pow(n, (s + 1) // 2, q), pow(n, s, q), pow(z, s, q), e
    while b != 1:
        t, m = b, 0
        while t != 1:
            t = t * t % q
            m += 1
        gs = pow(g, 1 << (r - m - 1), q)
        x, g, b, r = x * gs % q, gs * gs % q, b * gs * gs % q, m
    return x


def _random_point_mod(a, q, x):
    """A point of E(F_q) with x-coordinate x, or None."""
    a1, a2, a3, a4, a6 = a
    b2, b4, b6, _ = _b(a)
    d = (4 * x ** 3 + b2 * x * x + 2 * b4 * x + b6) % q
    r = _sqrt_mod(d, q)
    if r is None:
        return None
    return (x % q, (r - a1 * x - a3) * pow(2, -1, q) % q)


def _quotient_coords(a, q, N, p, pts, limit=3000):
    """Rows over F_p: the coordinates of the images of the points in
    E(F_q)/pE(F_q) ~ (Z/p)^k on a basis (k rows), or None if the p-part of
    E(F_q) is too large to enumerate.  P -> m P maps E(F_q) onto its Sylow
    p-subgroup S (m the prime-to-p part of N), and E(F_q)/pE(F_q) = S/pS."""
    pv, m = 1, N
    while m % p == 0:
        m //= p
        pv *= p
    if pv > limit:
        return None
    # the Sylow p-subgroup, from random points
    S = {None}
    x = 0
    while len(S) < pv:
        x += 1
        if x > 4 * q + 40:
            return None
        R = _random_point_mod(a, q, x)
        if R is None:
            continue
        g = _mul_p(a, m, R, q)
        if g in S:
            continue
        # <S, g> = S + <g> (an abelian group)
        cyc = [None]
        z = g
        while z is not None:
            cyc.append(z)
            z = _add_p(a, z, g, q)
        new = {_add_p(a, u, c, q) for u in S for c in cyc}
        S = new
    pS = {_mul_p(a, p, y, q) for y in S}
    basis = []
    span = set(pS)
    for y in S:
        if y not in span:
            basis.append(y)
            span = {_add_p(a, u, _mul_p(a, c, y, q), q) for u in span for c in range(p)}
            if len(span) == len(S):
                break
    k = len(basis)
    if k == 0:
        return []
    coords = {}
    import itertools
    for cs in itertools.product(range(p), repeat=k):
        off = None
        for c, b in zip(cs, basis):
            off = _add_p(a, off, _mul_p(a, c, b, q), q)
        for u in pS:
            coords[_add_p(a, off, u, q)] = cs
    rows = [[0] * len(pts) for _ in range(k)]
    for i, P in enumerate(pts):
        img = _mul_p(a, m, _red_point(a, P, q), q)
        cs = coords[img]
        for j in range(k):
            rows[j][i] = cs[j]
    return rows


def p_saturate(a, pts, p, aps, torsion=(), max_q=400):
    """The points with the subgroup they span (with torsion) saturated at p:
    (points, how many times the index was divided by p)."""
    pts = list(pts)
    gained = 0
    while True:
        gens = pts + [T for T in torsion if T is not None]
        n = len(gens)
        rows = []
        kernel = None
        used = stable = 0
        for q, aq in aps:
            if aq is None or q < 5 or q == p:
                continue
            N = q + 1 - aq
            if N % p:
                continue
            res = _quotient_coords(a, q, N, p, gens)
            if res is None:
                continue
            used += 1
            rows.extend(res)
            new = _kernel_mod_p(rows, n, p) if rows else [[int(i == j) for j in range(n)] for i in range(n)]
            stable = stable + 1 if kernel is not None and len(new) == len(kernel) else 0
            kernel = new
            # no combination left (saturated), or the same candidates for many q
            if not kernel or stable >= 20 + 2 * n or used >= max_q:
                break
        # combinations of the torsion alone are no news
        if kernel is not None:
            kernel = [v for v in kernel if any(x % p for x in v[:len(pts)])]
        if kernel == []:
            return pts, gained
        if kernel is None:
            raise ArithmeticError("no good prime q with %d | #E(F_q) among those computed" % p)
        # a candidate: divide it by p (any nonzero combination of the kernel
        # basis may be the divisible one, e.g. P + T with T torsion)
        import itertools
        combos = []
        k = len(kernel)
        for cs in itertools.product(range(p), repeat=k):
            if not any(cs):
                continue
            if len(combos) > 2000:
                break
            v = [sum(c * b[i] for c, b in zip(cs, kernel)) % p for i in range(n)]
            if any(x % p for x in v[:len(pts)]):
                combos.append(v)
        done = False
        for v in combos:
            R = _combo(a, gens, v)
            Q = divide_point(a, R, p) if R is not None else None
            if Q is None:
                continue
            j = next(i for i in range(len(pts)) if v[i] % p)
            # pQ = sum v_i P_i with v_j prime to p: with u v_j + w p = 1, the
            # lattice spanned by the P_i and Q has the basis P_i (i != j),
            # Q* = u Q + w P_j (P_j = pQ* - u sum_{i != j} v_i P_i, and
            # Q = v_j Q* + w sum_{i != j} v_i P_i)
            u = pow(v[j], -1, p)
            w = (1 - u * v[j]) // p
            pts[j] = add(a, mul(a, u, Q), mul(a, w, pts[j]))
            gained += 1
            done = True
            break
        if not done:
            raise ArithmeticError("%d-saturation: a combination survives %d primes but is not divisible by %d" % (p, used, p))


def _lll_gram(G):
    """An integer matrix U (rows) with U G U^T LLL-reduced (G a real Gram matrix)."""
    n = len(G)
    U = [[int(i == j) for j in range(n)] for i in range(n)]
    def gram(u, v):
        return sum(u[i] * G[i][j] * v[j] for i in range(n) for j in range(n))
    k = 1
    while k < n:
        # Gram-Schmidt coefficients
        B, mu = [], [[0.0] * n for _ in range(n)]
        for i in range(n):
            bi = gram(U[i], U[i])
            for j in range(i):
                mu[i][j] = (gram(U[i], U[j]) - sum(mu[j][l] * mu[i][l] * B[l] for l in range(j))) / B[j]
                bi -= mu[i][j] ** 2 * B[j]
            B.append(bi)
        for j in range(k - 1, -1, -1):
            q = round(mu[k][j])
            if q:
                U[k] = [x - q * y for x, y in zip(U[k], U[j])]
                for l in range(j + 1):
                    mu[k][l] -= q * (mu[j][l] if l < j else 1)
        if B[k] >= (0.75 - mu[k][k - 1] ** 2) * B[k - 1]:
            k += 1
        else:
            U[k], U[k - 1] = U[k - 1], U[k]
            k = max(k - 1, 1)
    return U


# gamma_r^r exactly for r <= 8 (Korkine-Zolotarev, Blichfeldt); Hermite's
# (4/3)^(r(r-1)/2) beyond (2^r was once used for r > 8, which is not a bound:
# a 10-dimensional lattice has gamma^10 >= 4096/3, the systematic review's
# R2-EC-F6)
_HERMITE_POW_Q = {1: _F(1), 2: _F(4, 3), 3: _F(2), 4: _F(4), 5: _F(8), 6: _F(64, 3), 7: _F(64), 8: _F(256)}


def _hermite_pow_upper(r):
    """An exact rational upper bound for gamma_r^r."""
    return _HERMITE_POW_Q.get(r) or _F(4, 3) ** (r * (r - 1) // 2)


def silverman_bound(a):
    """B with h(x(P)) - hhat(P) <= B for every P on the minimal model a
    (Sage's normalization of hhat)."""
    return float(silverman_bound_upper(a))


def silverman_bound_upper(a):
    """silverman_bound as an exact Fraction rounded up (the logarithms on
    balls): 2 (h(j)/8 + log|Delta|/12 + 0.973) + 2 log 2."""
    c4, c6 = _c(a)
    D = _disc(a)
    j = _F(c4 ** 3, D)
    hj = log_ball(max(abs(j.numerator), abs(j.denominator)))[1]
    return 2 * (hj / 8 + log_ball(abs(D))[1] / 12 + _F(973, 1000)) + 2 * log_ball(2)[1]


def _real_roots_in(c, lo, hi):
    """The real roots in [lo, hi] of the polynomial c[0] + c[1] z + ... (floats;
    roots of the derivative split it into monotone pieces, then bisection)."""
    while len(c) > 1 and c[-1] == 0:
        c = c[:-1]
    if len(c) <= 1:
        return []
    ev = lambda z: sum(ci * z ** i for i, ci in enumerate(c))
    crit = _real_roots_in([i * c[i] for i in range(1, len(c))], lo, hi)
    pts = [lo] + sorted(crit) + [hi]
    out = []
    for u, v in zip(pts, pts[1:]):
        fu, fv = ev(u), ev(v)
        if fu == 0:
            out.append(u)
            continue
        if fu * fv > 0:
            continue
        for _ in range(200):
            m = (u + v) / 2
            if m == u or m == v:
                break
            fm = ev(m)
            if (fm < 0) == (fu < 0):
                u, fu = m, fm
            else:
                v = m
        out.append((u + v) / 2)
    if ev(hi) == 0:
        out.append(hi)
    return out


def _horner_iv(c, u, v):
    """An enclosure [lo, hi] of c[0] + c[1] z + ... over z in [u, v]
    (Fractions, exact interval arithmetic)."""
    lo = hi = _F(0)
    for ci in reversed(c):
        ps = (lo * u, lo * v, hi * u, hi * v)
        lo, hi = min(ps) + ci, max(ps) + ci
    return lo, hi


def _cps_eps_inf(a):
    """A certified lower bound for eps_infinity (an exact Fraction, 0 if none): the minimum over x(E(R)) of
    max(|F(X,Z)|, |G(X,Z)|) / max(|X|, |Z|)^4, with F = 4X^3 Z + ... and
    G = X^4 - b4 X^2 Z^2 - ... the denominator and numerator of x(2P).
    Branch and bound over z in [-1, 1] (x = z, and x = 1/z) with exact
    interval evaluation: pieces where F < 0 hold no real point; each other
    piece's lower bound is certified, and the least over the final pieces
    bounds the minimum.  (Sampling near critical points bounded it from
    above: 8.9 for a curve with a 2-torsion point of naive height 13.05,
    where the infimum is at most 1/r^4: the systematic review's EC-F10.)"""
    b2, b4, b6, b8 = _b(a)
    f = [b6, 2 * b4, b2, 4]                    # F(x, 1)
    g = [-b8, -2 * b6, -b4, 0, 1]              # G(x, 1)
    ft = [0, 4, b2, 2 * b4, b6]                # F(1, t)
    gt = [1, 0, -b4, -2 * b6, -b8]             # G(1, t)
    best = None
    for P, Q in ((f, g), (ft, gt)):
        P = [_F(c) for c in P]
        Q = [_F(c) for c in Q]
        def lower(u, v):
            plo, phi = _horner_iv(P, u, v)
            if phi < 0:
                return None  # no point of E(R) here
            qlo, qhi = _horner_iv(Q, u, v)
            lp = _F(0) if plo <= 0 <= phi else min(abs(plo), abs(phi))
            lq = _F(0) if qlo <= 0 <= qhi else min(abs(qlo), abs(qhi))
            return max(lp, lq)
        import heapq
        heap = []
        lb = lower(_F(-1), _F(1))
        if lb is not None:
            heap.append((lb, _F(-1), _F(1)))
        steps = 0
        # split the piece with the least bound, until it is small or the
        # work is spent; the least bound left is the certified one
        while heap and steps < 3000:
            lb, u, v = heapq.heappop(heap)
            if v - u < _F(1, 2 ** 40):
                heapq.heappush(heap, (lb, u, v))
                break
            steps += 1
            m = (u + v) / 2
            for uu, vv in ((u, m), (m, v)):
                l2 = lower(uu, vv)
                if l2 is not None:
                    heapq.heappush(heap, (max(l2, _F(0)), uu, vv))
        if heap:
            v = heap[0][0]
            best = v if best is None else min(best, v)
    if not best:
        return _F(0)
    return best


# sup over the rational components of the minimal model's Neron model of
# the local height-difference correction (in units of log p, Sage's
# normalization of hhat): 0 on the identity component
def _cps_alpha(kod, c):
    """(an exact Fraction)"""
    if c == 1:
        return _F(0)
    if kod.endswith("*") and kod[1:-1].isdigit():
        m = int(kod[1:-1])
        if m == 0:
            return _F(1)
        # Galois fixes the near component (the one of order 2 next to the
        # identity), so with c = 2 it is the rational one
        return _F(1) if c == 2 else _F(4 + m, 4)
    if kod[1:].isdigit():
        m = int(kod[1:])
        if c == m:
            return _F((m // 2) * (m - m // 2), m)
        return _F(m, 4)
    return {"III": _F(1, 2), "IV": _F(2, 3), "IV*": _F(4, 3), "III*": _F(3, 2)}.get(kod, _F(0))


def cps_bound(a):
    """The Cremona-Prickett-Siksek bound: B with h(x(P)) - hhat(P) <= B for
    every P on the minimal model a (Sage's normalization of hhat; h(x) =
    log max(|num|, den)).  -1/3 log eps_inf, plus at each bad prime the
    largest local correction over the components with rational points."""
    B = cps_bound_upper(a)
    return _m.inf if B is None else float(B)


def cps_bound_upper(a):
    """cps_bound as an exact Fraction rounded up (the logarithms on balls),
    or None without a certified positive lower bound for eps_inf."""
    eps = _cps_eps_inf(a)
    if eps <= 0:
        return None
    B = -log_ball(eps)[0] / 3
    for p, (kod, f, c) in local_data(a).items():
        B += _cps_alpha(kod, c) * log_ball(p)[1]
    return B


def index_bound(a, pts, bad, T=None):
    """(n, T): an integer n at least the index of the subgroup spanned by
    the points in E(Q)/tors, and the search radius T used; n is None if the
    search needed is out of reach.  Every quantity is an exact rational
    bound in the right direction (the systematic review's R2-EC-F3, where
    doubles with margins of 1e-6 stood in for the heights and the
    regulator): B1 >= min(Silverman, CPS) with the logarithms on balls; the
    search covers max(|r|, s^2) <= R exactly, so a point it misses has
    hhat > log R - B1, with log R from below; the heights of the points
    found and the regulator are enclosures; gamma_r^r is exact or Hermite's
    bound; and n = floor(sqrt(R gamma_r^r / lambda^r)) exactly."""
    r = len(pts)
    B1 = silverman_bound_upper(a)
    cps = cps_bound_upper(a)
    if cps is not None:
        B1 = min(B1, cps)
    if T is None:
        # every point of hhat < T - B1 has naive height < T: a search to
        # T = 10 is cheap, and a larger lam0 lowers the index bound
        b = float(B1)
        T = max(b + 0.5, min(b + 2, 10.0))
    if T > 14:
        return None, T
    limit = 10 ** 6
    R = int(_m.exp(T))
    found = point_search_engine(a, T, limit=limit, R=R)
    if len(found) >= limit:
        return None, T
    lam = log_ball(R)[0] - B1
    for P in found:
        if point_order(a, P) == 0:
            lam = min(lam, canonical_height_ball(a, P, bad)[0])
    if lam <= 0:
        return None, T
    if r == 0:
        return 1, T
    Rhi = regulator_ball(a, pts, bad)[1]
    n2 = Rhi * _hermite_pow_upper(r) / lam ** r
    return _m.isqrt(_m.floor(n2)), T


def _torsion_generators(a, tors):
    """Generators of the torsion subgroup (one point of largest order, and a
    second one if the group is not cyclic)."""
    if not tors:
        return []
    order = {i: point_order(a, T, 16) for i, T in enumerate(tors)}
    i = max(order, key=lambda k: order[k])
    T1 = tors[i]
    span = set()
    Q = None
    for _ in range(order[i]):
        Q = add(a, Q, T1)
        span.add(Q)
    if len(span) == len(tors) + 1 or len(span) >= len(tors) + 1:
        return [T1]
    T2 = next(T for T in tors if T not in span)
    return [T1, T2]


def saturated_generators(a, pts, bad, aps, torsion=(), max_prime=None, odd_only=False):
    """(generators, index, primes): the points LLL-reduced and saturated at
    every prime up to the index bound (or max_prime, if given, which then
    proves nothing about larger primes)."""
    r = len(pts)
    G = [[height_pairing(a, P, Q, bad) for Q in pts] for P in pts]
    U = _lll_gram(G)
    pts = [_combo(a, pts, u) for u in U]
    if max_prime is None:
        n, T = index_bound(a, pts, bad)
        if n is None:
            raise NotImplementedError("no index bound: the search for points of naive height %.1f is too large" % T)
        # (an exact integer bound: a float 1.99999999999997 for an index
        # bound 2 once took top = 1 and left 2 P unsaturated, the systematic
        # review's EC-F13)
        top = n
    else:
        top = int(max_prime)
    index = 1
    primes = [p for p in range(2, top + 1) if all(p % q for q in range(2, int(p ** 0.5) + 1)) and not (odd_only and p == 2)]
    torsion = _torsion_generators(a, [T for T in torsion if T is not None])
    for p in primes:
        pts, k = p_saturate(a, pts, p, aps, torsion)
        index *= p ** k
    if index > 1:
        G = [[height_pairing(a, P, Q, bad) for Q in pts] for P in pts]
        U = _lll_gram(G)
        pts = [_combo(a, pts, u) for u in U]
    pts.sort(key=lambda P: canonical_height(a, P, bad))
    return pts, index, primes
