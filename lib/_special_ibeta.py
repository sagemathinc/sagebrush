"""The incomplete beta function, its inverse and the incomplete gamma
function's inverse, for scipy.special and scipy.stats' distributions: a
module of its own (its own library chunk in the browser, mod-special-ibeta),
over lib/_special.py's incomplete gamma, beta and Stirling functions.

After two algorithms SciPy's xsf carries (BSD 3-Clause, see NOTICE.md):
Cephes's incbet (Moshier: its power series, continued fractions and their
choice, followed closely) and CDFLIB's translation of DiDonato and Morris's
Algorithm 708 (ACM TOMS 18, 1992: bgrat, bfrac and basym, followed nearly line
by line; brcomp's prefactor in a form of its own); the inverses are
Sagebrush's, from Numerical Recipes' starts (invbetai, invgammp).  The accuracy each
docstring states is measured against mpmath in test/special.test.ts.
(Under CPython, use SciPy itself.)"""

import math as _math

from _special import (NotCovered, _PI, _STIRLING_R, _betaln_pos, _elementwise, _erfcx1, _exp_or_inf, _gammainc1, _gammainc_logd, _isnan, _lgamma_diff, _log1pmx, _stirling_mu)


def _gammainc_deriv(a, x):
    """dP/dx = x^(a-1) e^-x / Gamma(a), from log D (x^a e^-x / Gamma(a+1)): a D / x"""
    return _exp_or_inf(_gammainc_logd(a, x) + _math.log(a) - _math.log(x))


def _tail_root(tail, slope, target, x, lo, hi):
    """the x in (lo, hi) with tail(x) = target, for a monotone tail (a
    distribution's smaller tail, increasing in x when slope > 0): Newton's
    method on log tail(x) in log x, where a tail's power or exponential
    behaviour is near-linear, so the far tails converge as fast as the body;
    a step out of the bracket bisects it (geometrically).  Converged at the
    residual's rounding floor, a few ulps of log target, or when x stops
    moving: where the root is ill-conditioned (P ~ x^a for small a), x's
    last steps are rounding noise, not progress"""
    lt = _math.log(target)
    for _ in range(400):
        t = tail(x)
        if not (t > 0):
            # (the tail underflowed: x is too far out on its small side)
            g = -_math.inf
        else:
            g = _math.log(t) - lt
        if abs(g) <= 8 * 2.220446049250313e-16 * max(1.0, abs(lt)):
            return x
        below = (g < 0) == (slope > 0)
        if below:
            lo = x
        else:
            hi = x
        nx = _math.nan
        if t > 0:
            dl = slope * x * abs(_dtail[0](x)) / t
            if dl != 0 and dl == dl and abs(dl) < _math.inf:
                nx = x * _exp_or_inf(-g / dl)
        if abs(nx - x) <= 4e-16 * x:
            return nx
        if not (lo < nx < hi):
            if hi == _math.inf:
                nx = 4 * x
            elif lo == 0:
                nx = x / 16 if x > 1e-300 else 0.5 * x
            else:
                nx = _math.sqrt(lo) * _math.sqrt(hi)
            if not (lo < nx < hi):
                nx = 0.5 * (lo + hi)
        if nx == x or hi - lo <= 2 * _math.ulp(lo):
            return nx
        x = nx
    raise NotCovered("no convergence at target %r" % target)


# (the derivative of the tail solved for, set by the caller: a one-slot cell, so _tail_root stays one function)
_dtail = [None]


def _gammaincinv1(a, p, q):
    """the x >= 0 with P(a, x) = p (q = 1 - p, the one given exactly): the
    smaller tail is solved for, so that p or q near 1e-300 keeps its digits.
    The start after Numerical Recipes' invgammp (Wilson-Hilferty's cube for
    a > 1, else its small-x power and large-x log forms), or the small-x
    power form p Gamma(a + 1) = x^a where it is closer; then _tail_root"""
    upper = q < p
    target = q if upper else p
    if a > 1:
        pp = min(p, q)
        t = _math.sqrt(-2 * _math.log(pp))
        z = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t
        if p < 0.5:
            z = -z
        x = a * (1 - 1 / (9 * a) - z / (3 * _math.sqrt(a))) ** 3
        if not upper:
            xs = _exp_or_inf((_math.log(p) + _math.lgamma(a + 1)) / a)
            if not (x > 0) or xs < x:
                x = xs
        x = max(x, 1e-300)
    else:
        t = 1 - a * (0.253 + a * 0.12)
        if p < t:
            x = _exp_or_inf((_math.log(p) - _math.log(t)) / a)
        else:
            # (1 - (p - t)/(1 - t) = q/(1 - t), with q, the tail given exactly, never rounded through p)
            x = 1 - _math.log(q / (1 - t)) if q > 0 else _math.inf
    if not (0 < x < _math.inf):
        x = a if a > 0 else 1.0
    _dtail[0] = lambda x: _gammainc_deriv(a, x)
    try:
        return _tail_root(lambda x: _gammainc1(a, x, upper=upper), -1 if upper else 1, target, x, 0.0, _math.inf)
    except NotCovered:
        raise NotCovered("gammaincinv: no convergence at a = %r, p = %r" % (a, p)) from None


def _gammaincinv_check(name, a, y):
    if isinstance(a, complex) or isinstance(y, complex):
        raise NotCovered("%s: Sagebrush covers real arguments" % name)


def _gammaincinv_outer(a, y, upper):
    name = "gammainccinv" if upper else "gammaincinv"
    if _isnan(a) or _isnan(y):
        return _math.nan
    _gammaincinv_check(name, a, y)
    # (scipy's conventions: nan for a < 0 or y outside [0, 1]; the ends y = 0 and y = 1 at any a >= 0, a = 0 and
    # a = inf included; nan elsewhere at a = 0 or a = inf)
    if a < 0 or y < 0 or y > 1:
        return _math.nan
    p, q = (1 - y, y) if upper else (y, 1 - y)
    if p == 0:
        return 0.0
    if q == 0:
        return _math.inf
    if a == 0 or a == _math.inf:
        return _math.nan
    # (where the root underflows: P(a, x) ~ x^a / Gamma(a + 1) for small x, so x = (p Gamma(a + 1))^(1/a))
    if a < 1 and p < 0.5:
        lx = (_math.log(p) + _math.lgamma(a + 1)) / a
        if lx < -745:
            return 0.0
    return _gammaincinv1(a, p, q)


def gammaincinv(a, y):
    """the inverse of gammainc in x: the x >= 0 with P(a, x) = y, a > 0,
    0 <= y <= 1 (scipy's conventions: 0 at y = 0, inf at y = 1, nan outside
    or at a <= 0).  Halley's method on the smaller of P and Q from Numerical
    Recipes' start (invgammp), safeguarded by bisection; 0 where the root
    underflows.  Largest error found against mpmath (a from 1e-3 to 1e8,
    y from 1e-300 to 1 - 1e-12): see test/special.test.ts's tolerance"""
    return _elementwise(lambda a, y: _gammaincinv_outer(a, y, False), a, y)


def gammainccinv(a, y):
    """the inverse of gammaincc in x: the x >= 0 with Q(a, x) = y, solved on
    Q itself where it is the smaller tail (see gammaincinv)"""
    return _elementwise(lambda a, y: _gammaincinv_outer(a, y, True), a, y)


# ------------------------------------------------------------------ incomplete beta functions

# (the continued fraction's largest number of terms: it converges in about
# sqrt(max(a, b)) of them near x = a/(a + b), so a and b up to about 1e8)
_BETAINC_TERMS = 20000
_BETAINC_MAX = 1e8


def _betainc_logpre(a, b, x, y):
    """log(x^a y^b / B(a, b)), y = 1 - x given as well (the complement of a
    rounded x near 1 is y, not 1 - x).  For a, b >= 15 by DiDonato and
    Morris's form (ACM TOMS 18, 1992, brcomp): with x0 = a/(a+b), the large
    terms of a log x + b log y - log B(a, b) cancel analytically, leaving
    log(ab/(a+b))/2 - log(2 pi)/2 + a (log(1 + e1) - e1) + b (log(1 + e2) - e2)
    - (mu(a) + mu(b) - mu(a + b)), e1 = (x - x0)/x0, e2 = (y - y0)/y0, whose
    linear terms cancel exactly (a e1 + b e2 = 0); else directly"""
    if a >= _STIRLING_R and b >= _STIRLING_R:
        s = a + b
        x0, y0 = a / s, b / s
        d = (x - x0) if x <= 0.5 else (y0 - y)
        return (0.5 * _math.log(a / s * b) - 0.5 * _math.log(2 * _PI) + a * _log1pmx(d / x0) + b * _log1pmx(-d / y0)
                - (_stirling_mu(a) + _stirling_mu(b) - _stirling_mu(s)))
    lx = _math.log(x) if x <= 0.5 else _math.log1p(-y)
    ly = _math.log(y) if y <= 0.5 else _math.log1p(-x)
    return a * lx + b * ly - _betaln_pos(a, b)


_BIG = 4.503599627370496e15
_BIGINV = 2.22044604925031308085e-16


def _betainc_frac(z, k):
    """a continued fraction of Cephes's incbet (Moshier, Cephes Math Library,
    incbet.c: incbcf and incbd), by its convergents with their rescaling:
    k = [k1, ..., k8] the coefficients' starts, stepped as Cephes steps them"""
    k1, k2, k3, k4, k5, k6, k7, k8, d2, d6 = k
    pkm2, qkm2, pkm1, qkm1 = 0.0, 1.0, 1.0, 1.0
    ans, r = 1.0, 1.0
    thresh = 3.0 * 1.1102230246251565e-16
    for _ in range(_BETAINC_TERMS):
        xk = -(z * k1 * k2) / (k3 * k4)
        pk, qk = pkm1 + pkm2 * xk, qkm1 + qkm2 * xk
        pkm2, pkm1, qkm2, qkm1 = pkm1, pk, qkm1, qk
        xk = (z * k5 * k6) / (k7 * k8)
        pk, qk = pkm1 + pkm2 * xk, qkm1 + qkm2 * xk
        pkm2, pkm1, qkm2, qkm1 = pkm1, pk, qkm1, qk
        if qk != 0:
            r = pk / qk
        if r != 0:
            t = abs((ans - r) / r)
            ans = r
        else:
            t = 1.0
        if t < thresh:
            return ans
        k1 += 1.0
        k2 += d2
        k3 += 2.0
        k4 += 2.0
        k5 += 1.0
        k6 += d6
        k7 += 2.0
        k8 += 2.0
        if abs(qk) + abs(pk) > _BIG:
            pkm2 *= _BIGINV; pkm1 *= _BIGINV; qkm2 *= _BIGINV; qkm1 *= _BIGINV
        if abs(qk) < _BIGINV or abs(pk) < _BIGINV:
            pkm2 *= _BIG; pkm1 *= _BIG; qkm2 *= _BIG; qkm1 *= _BIG
    raise NotCovered("betainc: the continued fraction didn't converge")


def _betainc_series(a, b, x):
    """Cephes's pseries: I_x(a, b) for b x <= 1 and x <= 0.95, as
    x^a / B(a, b) times 1/a + sum_n (1 - b)_n x^n / (n! (a + n))"""
    ai = 1.0 / a
    u = (1.0 - b) * x
    v = u / (a + 1.0)
    t1, t, n, s = v, u, 2.0, 0.0
    z = 1.1102230246251565e-16 * ai
    while abs(v) > z:
        u = (n - b) * x / n
        t *= u
        v = t / (a + n)
        s += v
        n += 1.0
    s += t1 + ai
    lp = a * _math.log(x) - _betaln_pos(a, b)
    if lp < -746:
        return 0.0
    return _math.exp(lp) * s


def _betainc_bgrat(a, b, x, y):
    """I_x(a, b) for a >= 15 and 0 < b <= 1 by DiDonato and Morris's
    asymptotic expansion (ACM TOMS 18, 1992, Algorithm 708's bgrat): with
    nu = a + (b - 1)/2 and z = -nu log x, Q(b, z) times the series of their
    section 4 in powers of 1/nu, its terms through Q(b, z) z^-b e^z Gamma(b)
    and its recurrence.  None where the series doesn't reach full precision
    within 30 terms (then the continued fraction is used)"""
    bm1 = b - 1.0
    nu = a + 0.5 * bm1
    lnx = _math.log(x) if y > 0.375 else _math.log1p(-y)
    z = -nu * lnx
    if b * z == 0:
        return None
    # (u = r / (Gamma(a + b)/Gamma(a) nu^b), r = z^b e^-z / Gamma(b): their prefactor, in logs)
    logr = b * _math.log(z) - z - _math.lgamma(b)
    logu = logr - (_lgamma_diff(a, b) + b * _math.log(nu))
    if logu < -745:
        return 0.0
    u = _math.exp(logu)
    # (j = Q(b, z) / r = Q(b, z) z^-b e^z Gamma(b) = gammaincc scaled / b, never formed as an underflowed Q over r)
    j = _gammainc1(b, z, upper=True, scaled=True) / b
    v = 0.25 / (nu * nu)
    t2 = 0.25 * lnx * lnx
    total = j
    t, cn, n2 = 1.0, 1.0, 0.0
    c = [0.0] * 31
    d = [0.0] * 31
    for n in range(1, 31):
        bp2n = b + n2
        j = (bp2n * (bp2n + 1.0) * j + (z + bp2n + 1.0) * t) * v
        n2 += 2.0
        t *= t2
        cn /= n2 * (n2 + 1.0)
        c[n] = cn
        acc = 0.0
        if n > 1:
            coef = b - n
            for i in range(1, n):
                acc += coef * c[i] * d[n - i]
                coef += b
        d[n] = bm1 * cn + acc / n
        dj = d[n] * j
        total += dj
        if total <= 0:
            return None
        if abs(dj) <= 1e-16 * total:
            return u * total
    return None


def _betainc_large_a(a, b, x, y):
    """I_x(a, b) for a >= 15 and 0 < b <= 15: bgrat at b' = b - n in (0, 1],
    then the recurrence DLMF 8.17.21, I_x(a, b) = I_x(a, b') +
    sum_{k < n} x^a y^(b'+k) / ((b' + k) B(a, b' + k)), whose terms are all
    positive.  None where bgrat is (see _betainc_bgrat)"""
    n = int(_math.ceil(b) - 1) if b > 1 else 0
    b0 = b - n
    w = _betainc_bgrat(a, b0, x, y)
    if w is None:
        return None
    if n:
        terms = []
        for k in range(n):
            bk = b0 + k
            lp = _betainc_logpre(a, bk, x, y)
            terms.append(0.0 if lp < -746 else _math.exp(lp) / bk)
        w += _math.fsum(terms)
    return w


def _betainc_bfrac(a, b, x, y, lam):
    """I_x(a, b) for a, b > 1 by DiDonato and Morris's continued fraction
    (Algorithm 708's bfrac), in lambda = (a + b) y - b, with the prefactor
    x^a y^b / B(a, b) of _betainc_logpre; None if it doesn't converge"""
    lp = _betainc_logpre(a, b, x, y)
    if lp < -746:
        return 0.0
    c = 1.0 + lam
    c0 = b / a
    c1 = 1.0 + 1.0 / a
    yp1 = y + 1.0
    n, pp, ss = 0.0, 1.0, a + 1.0
    an, bn, anp1, bnp1 = 0.0, 1.0, 1.0, c / c1
    r = c1 / c
    for _ in range(_BETAINC_TERMS):
        n += 1.0
        t = n / a
        w = n * (b - n) * x
        e = a / ss
        alpha = (pp * (pp + c0) * e * e) * (w * x)
        e = (1.0 + t) / (c1 + t + t)
        beta = n + w / ss + e * (c + n * yp1)
        pp = 1.0 + t
        ss += 2.0
        t = alpha * an + beta * anp1
        an, anp1 = anp1, t
        t = alpha * bn + beta * bnp1
        bn, bnp1 = bnp1, t
        r0 = r
        r = anp1 / bnp1
        if abs(r - r0) <= 1e-16 * r:
            return _math.exp(lp) * r
        an /= bnp1
        bn /= bnp1
        anp1 = r
        bnp1 = 1.0
    return None


_E0 = 1.1283791670955126  # 2/sqrt(pi)
_E1 = 0.35355339059327373  # 2^(-3/2)


def _betainc_basym(a, b, lam):
    """I_x(a, b) for a, b >= 15, lambda = (a + b) y - b >= 0, by Temme's
    uniform asymptotic expansion as DiDonato and Morris give it (Algorithm
    708's basym), with erfcx for their erfc1; None where its terms don't
    reach full precision within 20"""
    num = 20
    if a < b:
        h = a / b
        r0 = 1.0 / (1.0 + h)
        r1 = (b - a) / b
        w0 = 1.0 / _math.sqrt(a * (1.0 + h))
    else:
        h = b / a
        r0 = 1.0 / (1.0 + h)
        r1 = (b - a) / a
        w0 = 1.0 / _math.sqrt(b * (1.0 + h))
    f = -a * _log1pmx(-lam / a) - b * _log1pmx(lam / b)
    t = _math.exp(-f)
    if t == 0.0:
        return 0.0
    z0 = _math.sqrt(f)
    z = 0.5 * (z0 / _E1)
    z2 = f + f
    a0 = [0.0] * (num + 2)
    b0 = [0.0] * (num + 2)
    cc = [0.0] * (num + 2)
    d = [0.0] * (num + 2)
    a0[1] = (2.0 / 3.0) * r1
    cc[1] = -0.5 * a0[1]
    d[1] = -cc[1]
    j0 = (0.5 / _E0) * float(_erfcx1(z0))
    j1 = _E1
    total = j0 + d[1] * w0 * j1
    sacc, h2, hn, w = 1.0, h * h, 1.0, w0
    znm1, zn = z, z2
    for n in range(2, num + 1, 2):
        hn = h2 * hn
        a0[n] = 2.0 * r0 * (1.0 + h * hn) / (n + 2.0)
        np1 = n + 1
        sacc += hn
        a0[np1] = 2.0 * r1 * sacc / (n + 3.0)
        for i in range(n, np1 + 1):
            r = -0.5 * (i + 1.0)
            b0[1] = r * a0[1]
            for m in range(2, i + 1):
                bsum = 0.0
                for j in range(1, m):
                    bsum += (j * r - (m - j)) * a0[j] * b0[m - j]
                b0[m] = r * a0[m] + bsum / m
            cc[i] = b0[i] / (i + 1.0)
            dsum = 0.0
            for j in range(1, i):
                dsum += d[i - j] * cc[j]
            d[i] = -(dsum + cc[i])
        j0 = _E1 * znm1 + (n - 1.0) * j0
        j1 = _E1 * zn + n * j1
        znm1 = z2 * znm1
        zn = z2 * zn
        w = w0 * w
        t0 = d[n] * w * j0
        w = w0 * w
        t1 = d[np1] * w * j1
        total += t0 + t1
        if abs(t0) + abs(t1) <= 1e-16 * total:
            u = _math.exp(-(_stirling_mu(a) + _stirling_mu(b) - _stirling_mu(a + b)))
            return _E0 * t * u * total
    return None


def _betainc_pq(a, b, x, y):
    """(I_x(a, b), 1 - I_x(a, b)), y = 1 - x given as well, after Cephes's
    incbet: the tail below the mean a/(a + b) computed directly (through the
    symmetry I_x(a, b) = 1 - I_y(b, a), DLMF 8.17.4, above it); there the
    power series for b x <= 1 and x <= 0.95, else incbcf's continued
    fraction (DLMF 8.17.22) or incbd's, in x/(1 - x), by the sign of
    x (a + b - 2) - (a - 1); and the prefactor x^a y^b / B(a, b) by
    _betainc_logpre"""
    swap = x > a / (a + b)
    if swap:
        a, b, x, y = b, a, y, x
    t = None
    if b * x <= 1.0 and x <= 0.95:
        t = _betainc_series(a, b, x)
    elif a >= _STIRLING_R and b <= 40:
        # (a large, b small, x near 1: there Cephes's continued fractions are ill-conditioned in doubles (1e-11 at
        # a = 8e4, b = 0.13, x = 1 - 1.4e-5), and DiDonato and Morris's expansion is accurate)
        t = _betainc_large_a(a, b, x, y)
    elif a > 1 and b > 1:
        # (Algorithm 708's choice for a, b > 1 below the mean: Temme's expansion near the mean for both above 100,
        # else their continued fraction in lambda; lambda computed from whichever of x, y is the smaller)
        lam = (a + b) * y - b if a > b else a - (a + b) * x
        if lam < 0:
            lam = 0.0
        mn = min(a, b)
        if mn > 100 and lam <= 0.03 * mn:
            t = _betainc_basym(a, b, lam)
        if t is None:
            t = _betainc_bfrac(a, b, x, y, lam)
    if t is None:
        if x * (a + b - 2.0) - (a - 1.0) < 0:
            w = _betainc_frac(x, [a, a + b, a, a + 1.0, 1.0, b - 1.0, a + 1.0, a + 2.0, 1.0, -1.0])
        else:
            w = _betainc_frac(x / y, [a, b - 1.0, a, a + 1.0, 1.0, a + b, a + 1.0, a + 2.0, -1.0, 1.0]) / y
        lp = _betainc_logpre(a, b, x, y)
        t = 0.0 if lp < -746 else _math.exp(lp) * w / a
    t = min(max(t, 0.0), 1.0)
    return (1 - t, t) if swap else (t, 1 - t)


def _betainc_check(name, a, b, x):
    if isinstance(a, complex) or isinstance(b, complex) or isinstance(x, complex):
        raise NotCovered("%s: Sagebrush covers real arguments" % name)
    if max(a, b) > _BETAINC_MAX and a < _math.inf and b < _math.inf:
        raise NotCovered("%s: Sagebrush covers a and b up to %g" % (name, _BETAINC_MAX))


def _betainc1(a, b, x, upper=False):
    name = "betaincc" if upper else "betainc"
    if _isnan(a) or _isnan(b) or _isnan(x):
        return _math.nan
    if a < 0 or b < 0 or x < 0 or x > 1 or (a == 0 and b == 0) or (a == _math.inf and b == _math.inf):
        return _math.nan
    # (scipy's limits: x = 0 and x = 1 first; then a = 0, all the mass at 0, b = 0 at 1; an infinite a at 1, b at 0)
    if x == 0:
        p = 0.0
    elif x == 1:
        p = 1.0
    elif a == 0 or b == _math.inf:
        p = 1.0
    elif b == 0 or a == _math.inf:
        p = 0.0
    else:
        _betainc_check(name, a, b, x)
        p, q = _betainc_pq(a, b, x, 1 - x)
        return max(0.0, q) if upper else max(0.0, p)
    return 1 - p if upper else p


def betainc(a, b, x):
    """the regularized incomplete beta function I_x(a, b) =
    B(x; a, b) / B(a, b) (DLMF 8.17.2), real a, b >= 0 and 0 <= x <= 1
    (scipy's argument order).  The continued fraction DLMF 8.17.22 by
    Lentz's method, for x < (a + 1)/(a + b + 2) and through the symmetry
    I_x(a, b) = 1 - I_{1-x}(b, a) above it, so the smaller of I and 1 - I is
    computed directly; its prefactor x^a (1 - x)^b / B(a, b) for a, b >= 15
    by DiDonato and Morris's cancellation-free form (see _betainc_logpre).
    scipy's limits: 0 at x = 0, 1 at x = 1, 1 at a = 0 and 0 at b = 0
    (otherwise), 0 at a = inf and 1 at b = inf; nan outside the domain and
    at a = b = 0.  NotCovered above a or b = 1e8 (the fraction needs about
    sqrt(max(a, b)) terms) or for complex arguments.  Largest error found
    against mpmath: see test/special.test.ts's tolerance (relative, of
    max(1, |log value|) as gammainc's)"""
    return _elementwise(lambda a, b, x: _betainc1(a, b, x), a, b, x)


def betaincc(a, b, x):
    """1 - I_x(a, b), computed directly where it is the smaller (see betainc)"""
    return _elementwise(lambda a, b, x: _betainc1(a, b, x, upper=True), a, b, x)


def _betainc_deriv(a, b, x):
    """dI_x/dx = x^(a-1) (1 - x)^(b-1) / B(a, b)"""
    return _exp_or_inf(_betainc_logpre(a, b, x, 1 - x) - _math.log(x) - _math.log1p(-x))


def _betaincinv1(a, b, p, q, side=None):
    """the x in (0, 1) with I_x(a, b) = p (q = 1 - p, the one given exactly).
    It is solved for in x where the root is at most 1/2, I_(1/2)(a, b) >= p,
    and in y = 1 - x by the symmetry I_x(a, b) = 1 - I_y(b, a) (DLMF 8.17.4)
    otherwise, so a root near 0 or near 1 keeps its digits; the residual is
    the smaller of the two tails, so that p or q near 1e-300 keeps its
    digits.  The start after Numerical Recipes' invbetai (Abramowitz and
    Stegun 26.5.22 for a, b >= 1, else its two power forms), or the small-x
    power form p a B(a, b) = x^a where it is closer; then _tail_root"""
    if side is None:
        # (compared on the smaller tail: p near 1 rounds, q doesn't)
        h = _betainc_pq(a, b, 0.5, 0.5)
        side = "x" if (h[0] >= p if p <= q else h[1] <= q) else "y"
    if side == "y":
        return 1 - _betaincinv1(b, a, q, p, "x")
    x = None
    small = min(p, q)
    if a >= 1 and b >= 1:
        t = _math.sqrt(-2 * _math.log(small))
        z = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t
        if p < 0.5:
            z = -z
        al = (z * z - 3) / 6
        h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1))
        w = z * _math.sqrt(al + h) / h - (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h))
        x = a / (a + b * _exp_or_inf(2 * w))
    xs = _exp_or_inf((_math.log(p) + _math.log(a) + _betaln_pos(a, b)) / a)
    if x is None or not (0 < x <= 0.5) or (0 < xs < x):
        x = xs
    if not (0 < x <= 0.5):
        x = min(0.25, a / (a + b))
    _dtail[0] = lambda x: _betainc_deriv(a, b, x)
    try:
        if p <= q:
            return _tail_root(lambda x: _betainc_pq(a, b, x, 1 - x)[0], 1, p, x, 0.0, 0.5 + 1e-16)
        return _tail_root(lambda x: _betainc_pq(a, b, x, 1 - x)[1], -1, q, x, 0.0, 0.5 + 1e-16)
    except NotCovered:
        raise NotCovered("betaincinv: no convergence at a = %r, b = %r, p = %r" % (a, b, p)) from None


def _betaincinv_outer(a, b, y, upper):
    name = "betainccinv" if upper else "betaincinv"
    if _isnan(a) or _isnan(b) or _isnan(y):
        return _math.nan
    if isinstance(a, complex) or isinstance(b, complex) or isinstance(y, complex):
        raise NotCovered("%s: Sagebrush covers real arguments" % name)
    # (scipy's conventions: nan for a or b <= 0 or y outside [0, 1]; the ends y = 0 and y = 1 for a or b infinite
    # too, nan elsewhere there)
    if a <= 0 or b <= 0 or y < 0 or y > 1:
        return _math.nan
    p, q = (1 - y, y) if upper else (y, 1 - y)
    if p == 0:
        return 0.0
    if q == 0:
        return 1.0
    if a == _math.inf or b == _math.inf:
        return _math.nan
    if max(a, b) > _BETAINC_MAX:
        raise NotCovered("%s: Sagebrush covers a and b up to %g" % (name, _BETAINC_MAX))
    if a == b and p == q:
        # (the symmetric distribution's median, exactly: I_(1/2)(a, a) = 1/2, DLMF 8.17.4)
        return 0.5
    # (where the root underflows: I_x(a, b) ~ x^a / (a B(a, b)) for small x)
    if p < 0.5:
        lx = (_math.log(p) + _math.log(a) + _betaln_pos(a, b)) / a
        if lx < -745:
            return 0.0
    return _betaincinv1(a, b, p, q)


def betaincinv(a, b, y):
    """the inverse of betainc in x: the x in [0, 1] with I_x(a, b) = y,
    a, b > 0, 0 <= y <= 1 (scipy's conventions: 0 at y = 0, 1 at y = 1, nan
    outside or at a, b <= 0 or infinite).  Halley's method on the smaller
    tail from Numerical Recipes' start (invbetai), safeguarded by
    bisection; 0 where the root underflows.  NotCovered above a or b = 1e8.
    Largest error found against mpmath: see test/special.test.ts's tolerance"""
    return _elementwise(lambda a, b, y: _betaincinv_outer(a, b, y, False), a, b, y)


def betainccinv(a, b, y):
    """the inverse of betaincc in x: the x with 1 - I_x(a, b) = y, solved on
    1 - I itself where it is the smaller tail (see betaincinv)"""
    return _elementwise(lambda a, b, y: _betaincinv_outer(a, b, y, True), a, b, y)
