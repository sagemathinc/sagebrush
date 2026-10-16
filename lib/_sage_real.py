"""Real and complex numbers of any precision, as in Sage: RealField(prec),
ComplexField(prec), and numerical approximation of symbolic expressions to
any number of digits: N(pi, digits=50).

A number is m * 2^e with m an integer of exactly prec bits (or 0), rounded
correctly (to nearest with ties to even, up, down or toward zero) after
each arithmetic operation.  The elementary functions and the constants pi,
e, log 2, Euler's gamma and Catalan's constant are computed in fixed point
with guard bits by Taylor series after argument reduction.  Printed as
Sage prints them: max(2, floor((prec - 1) log10 2)) significant digits."""

import math
from fractions import Fraction as _F

_LOG10_2 = 0.30102999566398119521
_LOG2_10 = 3.32192809488736234787


def _sa():
    import sage_all
    return sage_all


def digits_to_prec(d):
    """The precision Sage uses for d decimal digits: ceil((d + 1) log2 10).

    EXAMPLES::

        sage: from _sage_real import digits_to_prec  # sagebrush only
        sage: digits_to_prec(15), digits_to_prec(50)  # sagebrush only
        (54, 170)
    """
    x = (int(d) + 1) * _LOG2_10
    return int(math.ceil(x - 1e-12))


# ------------------------------------------------------------------ rounding

_RND = ("RNDN", "RNDZ", "RNDU", "RNDD", "RNDA")
_DEC_RND = {"RNDN": "N", "RNDU": "U", "RNDD": "D", "RNDZ": "D", "RNDA": "U"}


def _round_q(n, d, prec, rnd="RNDN", shift=0):
    """(m, e): the rational n/d * 2^shift (d > 0) rounded to prec bits."""
    if n == 0:
        return 0, 0
    neg = n < 0
    a = abs(n)
    e = a.bit_length() - d.bit_length() - prec
    while True:
        if e >= 0:
            D = d << e
            q, r = divmod(a, D)
        else:
            D = d
            q, r = divmod(a << -e, d)
        if q >= (1 << prec):
            e += 1
            continue
        if q < (1 << (prec - 1)):
            e -= 1
            continue
        break
    if r:
        if rnd == "RNDN":
            c = 2 * r - D
            if c > 0 or (c == 0 and q & 1):
                q += 1
        elif rnd == "RNDU":
            if not neg:
                q += 1
        elif rnd == "RNDD":
            if neg:
                q += 1
        elif rnd == "RNDA":
            q += 1
    if q == (1 << prec):
        q >>= 1
        e += 1
    if e + shift + prec < _EMIN:
        # below the exponent range: decided on the exact value (the rounded
        # one has lost its sticky bit: an exact u/2 (1 + 2^-100) rounds to
        # the smallest number u, not to 0)
        return _underflow(neg, a, d, shift, rnd)
    return (-q if neg else q), e + shift


def _underflow(neg, a, d, shift, rnd):
    """The rounding of the nonzero (-1)^neg a/d 2^shift, whose rounding with
    an unbounded exponent falls below 2^(EMIN - 1) (MPFR's documented
    rule): 0 or the smallest number u = 2^(EMIN - 1), by the rounding mode;
    to nearest, u when |x| > u/2 and 0 when |x| <= u/2 (a tie to even 0)."""
    if rnd == "RNDN":
        # a 2^shift / d > 2^(EMIN - 2)  <=>  a 2^shift > d 2^(EMIN - 2)
        up = _cmp_dyadic(a, shift, d, _EMIN - 2, 1) > 0
    else:
        up = rnd == "RNDA" or (rnd == "RNDU" and not neg) or (rnd == "RNDD" and neg)
    if up:
        return (-1 if neg else 1), _EMIN - 1
    return 0, 0


def _round_int(m, e, prec, rnd="RNDN"):
    """(m, e) with m any integer, rounded to prec bits."""
    if m == 0:
        return 0, 0
    b = abs(m).bit_length()
    if b <= prec:
        s = prec - b
        if e - s + prec < _EMIN:
            return _underflow(m < 0, abs(m), 1, e, rnd)
        return m << s, e - s
    return _round_q(m, 1, prec, rnd, e)


# ------------------------------------------------------------------ exponent range
# As MPFR (Sage's RealField): x = f 2^E with 1/2 <= |f| < 1 and
# EMIN <= E <= EMAX; beyond, a result overflows to infinity or underflows
# to zero (or the largest/smallest number, by the rounding mode).
_EMAX = (1 << 62) - 1
_EMIN = 1 - (1 << 62)
# The exact rational value (and so the exact integer part) is formed only
# for binary exponents up to this size: beyond, _q() raises
# NotImplementedError instead of building a multi-megabyte integer.
_EXACT_BITS = 1 << 20


def _range(R, m, e):
    """(m, e, special) for the rounded m 2^e (m != 0) in R's exponent range."""
    E = e + abs(m).bit_length()
    if _EMIN <= E <= _EMAX:
        return m, e, None
    p, rnd, neg = R._prec, R._rnd, m < 0
    if E > _EMAX:
        away = rnd in ("RNDN", "RNDA") or (rnd == "RNDU" and not neg) or (rnd == "RNDD" and neg)
        if away:
            return 0, 0, "-inf" if neg else "+inf"
        top = (1 << p) - 1
        return (-top if neg else top), _EMAX - p, None
    # underflow: 0 or the smallest number 2^(EMIN - 1)
    if rnd == "RNDN":
        # nearest: above half the smallest number (2^(EMIN - 2)) rounds up
        up = E == _EMIN - 1 and abs(m) & (abs(m) - 1) != 0
    else:
        up = rnd == "RNDA" or (rnd == "RNDU" and not neg) or (rnd == "RNDD" and neg)
    if up:
        return (-1 if neg else 1), _EMIN - 1, None
    return 0, 0, None


def _bound(v, s, W, up):
    """v 2^s (v > 0) cut to W bits: rounded down, or up."""
    k = v.bit_length() - W
    if k <= 0:
        return v, s
    q = v >> k
    if up and (q << k) != v:
        q += 1
    return q, s + k


def _ipow(a, N, W, up):
    """(v, s) with v 2^s a lower (up: an upper) bound for a^N, a > 0, N >= 0,
    by binary powering cut to W bits after each product."""
    rv, rs = 1, 0
    bv, bs = _bound(a, 0, W, up)
    while N:
        if N & 1:
            rv, rs = _bound(rv * bv, rs + bs, W, up)
        N >>= 1
        if N:
            bv, bs = _bound(bv * bv, bs + bs, W, up)
    return rv, rs


def _pow_round(m, e, n, prec, rnd):
    """(m 2^e)^n (m != 0, n != 0 an integer) correctly rounded to prec bits.
    The exact power is bracketed by binary powering cut down and up to W
    bits; when both ends round alike that is the result, else W doubles.
    This ends: the power of the odd part of m either fits in W bits (no
    cut, the ends agree) or is odd with more than prec + 1 significant
    bits, so not a rounding boundary."""
    neg = m < 0 and n % 2 == 1
    a = abs(m)
    t = (a & -a).bit_length() - 1
    a >>= t
    e += t
    N = abs(n)
    sgn = -1 if neg else 1
    if a == 1:
        return _round_int(sgn, e * n, prec, rnd)
    W = prec + 2 * N.bit_length() + 20
    while True:
        lo, slo = _ipow(a, N, W, False)
        hi, shi = _ipow(a, N, W, True)
        if n > 0:
            r1 = _round_int(sgn * lo, slo + e * n, prec, rnd)
            r2 = _round_int(sgn * hi, shi + e * n, prec, rnd)
        else:
            # 1/a^N lies between 1/hi and 1/lo
            r1 = _round_q(sgn, hi, prec, rnd, e * n - shi)
            r2 = _round_q(sgn, lo, prec, rnd, e * n - slo)
        if r1 == r2:
            return r1
        W *= 2


# log2(10) lies strictly between these (3.32192809488736234...)
_LOG2_10_LO = _F(3321928094887362, 10 ** 15)
_LOG2_10_HI = _F(3321928094887363, 10 ** 15)


# 1/ln(2) lies strictly between these (1.44269504088896340...)
_INV_LN2_LO = _F(14426950408889634, 10 ** 16)
_INV_LN2_HI = _F(14426950408889635, 10 ** 16)


def _log2_bounds(m, e):
    """Rational lo <= log2(m 2^e) <= hi (m > 0), from m's bits alone.  With
    m 2^e = 2^k y, y in [1, 2) and d = y - 1: d/(1 + d) <= ln y <= d; the
    same around y/2 in [1/2, 1) (d' = y/2 - 1 < 0) is tight when y is near
    2, so the two brackets intersect to one that excludes 0 for every m 2^e
    other than a power of 2 (1.5 or 0.75: where bit lengths alone give
    [0, 1] or [-1, 0])."""
    b = m.bit_length()
    k = e + b - 1
    y = _F(m, 1 << (b - 1))
    if y == 1:
        return _F(k), _F(k)
    d = y - 1
    lo1, hi1 = k + d / y * _INV_LN2_LO, k + d * _INV_LN2_HI
    d2 = y / 2 - 1
    # (ln of y/2 is negative: the smaller magnitude d2/(1 + d2) ... d2,
    # each scaled by the bound on 1/ln 2 that keeps it a bound)
    lo2, hi2 = k + 1 + d2 / (1 + d2) * _INV_LN2_HI, k + 1 + d2 * _INV_LN2_LO
    return max(lo1, lo2), min(hi1, hi2)


def _beyond(lo, hi, neg):
    """(m, e) past the exponent range when lo <= log2|x| <= hi puts x past
    it for certain (|x| >= 2^EMAX: overflow; |x| < 2^(EMIN - 2): below half
    the smallest number), for RealNumberMP to round by its mode; else None.
    lo and hi are integers or Fractions, from bit lengths: no power is
    formed."""
    if lo >= _EMAX:
        return (-1 if neg else 1), _EMAX + 8
    if hi < _EMIN - 2:
        return (-1 if neg else 1), _EMIN - 8
    return None


def _round_dec(M, E, prec, rnd):
    """(m, e): M 10^E (M != 0) correctly rounded to prec bits, with the
    exponent range decided on that final value (never on a separately
    computed 10^E: 10^200 x 10^-(E + 200) is in range when 10^-E is not).
    M 10^E = M 5^E 2^E: the 2^E is an exact shift and 5^|E| is bracketed by
    binary powering cut to W bits, as in _pow_round.  This ends: for E < 0
    the 5s of M are cancelled first, so the value is either exact (dyadic)
    or not dyadic, never a rounding boundary; for E > 0 it is an integer
    whose odd part, M's times 5^E, is exact once W holds it.  A value past
    the exponent range for certain is decided first, from bit lengths and
    bounds on log2(10): then |E| < 2^62 and 5^|E| is never formed for it."""
    b = abs(M).bit_length()
    t = _beyond(b - 1 + min(E * _LOG2_10_LO, E * _LOG2_10_HI), b + max(E * _LOG2_10_LO, E * _LOG2_10_HI), M < 0)
    if t is not None:
        return t
    if E < 0:
        N = -E
        while N and M % 5 == 0:
            M //= 5
            N -= 1
        if N == 0:
            return _round_int(M, E, prec, rnd)
    else:
        N = E
    W = prec + 2 * N.bit_length() + 20
    while True:
        lo, slo = _ipow(5, N, W, False)
        hi, shi = _ipow(5, N, W, True)
        if E >= 0:
            r1 = _round_int(M * lo, slo + E, prec, rnd)
            r2 = _round_int(M * hi, shi + E, prec, rnd)
        else:
            # M / 5^N lies between M/hi and M/lo
            r1 = _round_q(M, hi, prec, rnd, E - shi)
            r2 = _round_q(M, lo, prec, rnd, E - slo)
        if r1 == r2:
            return r1
        W *= 2


def _dround(v, rnd, neg):
    """The decimal mantissa rounding of _format: v >= 0 a Fraction."""
    N = math.floor(v)
    r = v - N
    if rnd == "N":
        if r > _F(1, 2) or (r == _F(1, 2) and N % 2):
            N += 1
    elif r and ((rnd == "U") != neg):
        N += 1
    return N


_L10 = []


def _log10_2():
    """log10(2) as a Fraction to about 200 bits (error < 2^-190)."""
    if not _L10:
        R = RealField(240)
        _L10.append((R(2).log() / R(10).log())._q())
    return _L10[0]


def _format_big(m, e, D, no_sci=None, rnd="N"):
    """_format(m 2^e, D, no_sci, rnd) without forming the exact rational
    (for huge binary exponents): the decimal exponent and the D digits are
    found from intervals for m 2^e 10^k, 10^|k| bracketed by binary
    powering, refined until both ends give the same digits (they do: such
    a number is not a decimal rounding boundary, see the comments)."""
    neg = m < 0
    a = abs(m)
    # E: 10^E <= a 2^e < 10^(E+1), first estimated (within 1 or so)
    t = max(0, a.bit_length() - 53)
    le = e * _log10_2()
    ip = math.floor(le)
    E = ip + math.floor(float(le - ip) + math.log10(a >> t) + t * _LOG10_2)
    W = 4 * D + 64
    lo10, hi10 = _F(10) ** (D - 1), _F(10) ** D
    while True:
        k = D - 1 - E
        K = abs(k)
        pl, sl = _ipow(10, K, W, False)
        ph, sh = _ipow(10, K, W, True)
        if k >= 0:
            vl = _F(a * pl) * _F(2) ** (e + sl)
            vh = _F(a * ph) * _F(2) ** (e + sh)
        else:
            vl = _F(a, ph) * _F(2) ** (e - sh)
            vh = _F(a, pl) * _F(2) ** (e - sl)
        if vh < lo10:
            E -= 1
            continue
        if vl >= hi10:
            E += 1
            continue
        if vl >= lo10 and vh < hi10:
            Nl, Nh = _dround(vl, rnd, neg), _dround(vh, rnd, neg)
            if Nl == Nh:
                N, E2 = Nl, E
                if N >= 10 ** D:
                    N //= 10
                    E2 += 1
                return _layout(N, E2, D, neg, no_sci)
        W *= 2


def _layout(N, E, D, neg, no_sci):
    """The digits N (D of them) of a number with decimal exponent E, laid
    out as Sage prints a RealNumber."""
    s = str(N)
    sign = "-" if neg else ""
    if no_sci is False or (no_sci is None and (E >= 6 or E <= -6)) or (no_sci is not True and E > 300):
        return sign + s[0] + "." + s[1:] + "e" + str(E)
    if E >= 0:
        if E + 1 >= D:
            return sign + s + _zeros(E + 1 - D) + "."
        return sign + s[:E + 1] + "." + s[E + 1:]
    return sign + "0." + _zeros(-E - 1) + s


def _cmp_special(s1, s2):
    """The sign of x1 - x2 where s1, s2 are "+inf", "-inf", "nan", or None
    for a finite number (two finite numbers do not come here)."""
    if s1 == "nan" or s2 == "nan":
        return "nan"
    rank = {"-inf": -1, None: 0, "+inf": 1}
    a, b = rank[s1], rank[s2]
    return (a > b) - (a < b)


def _special_op(a, b, op, R):
    """a op b when a or b is an infinity or NaN (IEEE rules, by signs: a
    finite operand counts only by its sign, however large)."""
    def sgn(x):
        if x._special:
            return {"+inf": 1, "-inf": -1}.get(x._special)
        return (x._m > 0) - (x._m < 0)

    def inf(sign):
        return RealNumberMP(R, 0, 0, "+inf" if sign > 0 else "-inf")

    nan = RealNumberMP(R, 0, 0, "nan")
    if a._special == "nan" or b._special == "nan":
        return nan
    sa, sb = sgn(a), sgn(b)
    if op in "+-":
        if op == "-":
            sb = -sb
            bs = {"+inf": "-inf", "-inf": "+inf"}.get(b._special)
        else:
            bs = b._special
        if a._special and bs:
            return inf(sa) if sa == sb else nan
        return inf(sa) if a._special else inf(sb)
    if op == "*":
        if sa == 0 or sb == 0:
            return nan
        return inf(sa * sb)
    # division
    if a._special and b._special:
        return nan
    if a._special:
        return inf(sa * (sb if sb else 1))
    return R(0)


def _cmp_dyadic(m1, e1, n2, e2, d2):
    """The sign of m1 2^e1 - n2 2^e2 / d2 (d2 > 0), without forming large
    powers of 2: by the binary magnitudes first."""
    s1 = (m1 > 0) - (m1 < 0)
    s2 = (n2 > 0) - (n2 < 0)
    if s1 != s2 or s1 == 0:
        return (s1 > s2) - (s1 < s2)
    a, b = abs(m1), abs(n2)
    # |x1| in [2^(E1-1), 2^E1); |x2| in (2^(E2-2), 2^E2)
    E1 = e1 + a.bit_length()
    E2 = e2 + b.bit_length() - d2.bit_length() + 1
    if E1 > E2 + 1:
        return s1
    if E2 > E1 + 2:
        return -s1
    # comparable sizes: a 2^e1 d2 vs b 2^e2, shifts bounded by the lengths
    x, y = a * d2, b
    k = e1 - e2
    if k >= 0:
        x <<= k
    else:
        y <<= -k
    c = (x > y) - (x < y)
    return c * s1


def _nudge(R, m, e, d):
    """m 2^e (exact in R, m != 0) moved by a nonzero amount far below its
    last place, upward (d = 1) or downward (d = -1), rounded in R's
    direction: m 2^e itself to nearest, else it or its neighbour."""
    p, rnd = R._prec, R._rnd
    b = abs(m).bit_length()
    m, e = m << (p - b), e - (p - b)
    pos = m > 0
    if rnd == "RNDN":
        move = 0
    elif rnd == "RNDU":
        move = 1 if d > 0 else 0
    elif rnd == "RNDD":
        move = -1 if d < 0 else 0
    elif rnd == "RNDZ":
        move = d if (d < 0) == pos else 0
    else:
        move = d if (d > 0) == pos else 0
    if move:
        top = 1 << (p - 1)
        if move < 0 and m == top:
            m, e = (1 << p) - 1, e - 1
        elif move > 0 and m == -top:
            m, e = -((1 << p) - 1), e - 1
        else:
            m += move
            if abs(m) == 1 << p:
                m, e = m >> 1, e + 1
    return RealNumberMP(R, m, e)


# the small-argument behaviour f(x) = x (1 + c x^2 + ...) of odd functions,
# the sign of c; and f(x) = 1 + c x^2 + ... for cos, cosh
_ODD = {"sin": -1, "tan": 1, "arctan": -1, "arcsin": 1, "sinh": 1, "tanh": -1, "arcsinh": -1, "arctanh": 1}
_EVEN = {"cos": -1, "cosh": 1}


def _exp_big(x, R, shift=0, sign=1, delta_bits=None):
    """sign 2^shift exp(x) for 512 <= |x| < 2^63 (x a finite RealNumberMP),
    correctly rounded in R: exp(x) = 2^k exp(r), k = floor(x / log 2) and
    r = x - k log 2 in [0, log 2), in a field of p + bits(k) + G bits (so
    the error of r is below 2^-(p + G - 8)); the value is accepted when both
    ends of its error interval round alike, else G doubles.  delta_bits:
    a further relative perturbation below 2^-delta_bits allowed for (sinh
    and cosh drop exp(-|x|))."""
    p = R._prec
    G = 64
    while True:
        F = RealField(p + 2 * abs(x._e + abs(x._m).bit_length()) + G)
        X = F(x)
        L2 = F(2).log()
        k = (X / L2).floor()
        r = X - F(k) * L2
        y = r.exp()
        m, e = y._m, y._e
        # relative error below 2^-(p + G/2)
        g = p + G // 2
        if delta_bits is not None:
            g = min(g, delta_bits - 2)
        t = abs(m) >> g
        lo = _round_int(sign * (abs(m) - t - 1), e + int(k) + shift, p, R._rnd)
        hi = _round_int(sign * (abs(m) + t + 1), e + int(k) + shift, p, R._rnd)
        if lo == hi:
            return RealNumberMP(R, lo[0], lo[1])
        G *= 2


def _exact_log(x, b):
    """k when the positive finite x is exactly b^k, b an integer >= 2 or
    the reciprocal 1/c of one (or a real equal to one of these), else None
    (an exact result is a rounding boundary that a checked evaluation
    cannot settle in the directed modes: log(2^-100, 1/2) is 100)."""
    try:
        q = (None if b._special else b._q()) if isinstance(b, RealNumberMP) else _F(b)
    except (TypeError, ValueError, NotImplementedError, OverflowError):
        q = None
    if q is not None and q > 0 and q.numerator == 1 and q.denominator >= 2:
        k = _exact_log(x, q.denominator)
        return None if k is None else -k
    try:
        if isinstance(b, RealNumberMP):
            if b._special or not b.is_integer():
                return None
            b = int(b)
        b = int(b) if _F(b).denominator == 1 else None
    except (TypeError, ValueError):
        return None
    if b is None or b < 2:
        return None
    m, e = x._m, x._e
    t = (m & -m).bit_length() - 1
    m >>= t
    e += t
    j = (b & -b).bit_length() - 1
    o = b >> j
    if m == 1:
        # x = 2^e: b must be a power of 2
        if o != 1 or j == 0 or e % j:
            return None
        return e // j
    if o == 1 or e < 0:
        return None
    k = max(1, round(math.log(m) / math.log(o)))
    for kk in (k - 1, k, k + 1):
        if kk >= 1 and o ** kk == m and j * kk == e:
            return kk
    return None


def _ziv_eval(R, fn, extra=40, limit=None, overflow=False, exact=None):
    """fn(F), F = RealField(p + extra), rounded in R.  fn must return the
    value within 2^8 units in the last place of F (relative), and the value
    must not be a rounding boundary of R; both ends of that interval must
    round alike, else extra doubles.

    limit: past that many extra bits the interval still holds a rounding
    boundary c = cm 2^ce (the value's nearest (p + 1)-bit number):
    exact(cm, ce) tells whether the value is exactly c (True: c is rounded,
    the correct rounding), is not (False: the extra bits keep doubling, up
    to _ZIV_CAP(p, limit), as the value is then not a boundary), or cannot
    be told within its budget (None): NotImplementedError, never an
    unproved rounding.  (c stays a pair: 2^ce is never formed.)"""
    p = R._prec
    checked = False
    while True:
        v = fn(RealField(p + extra))
        if overflow and v._special in ("+inf", "-inf"):
            # (overflow=True: fn's value is finite, so an infinity is the
            # working field's overflow; its threshold is above this field's,
            # so the value is beyond this range too, rounded in this field's
            # direction.  Otherwise an infinity is a true one: log(2, 1).
            # Callers: tiny gamma and log_gamma (finite for finite x > 0)
            # opt in; log(x, b) (|log x / log b| < 2^(62 + p) for b != 1)
            # and arctan (|value| < pi/2) cannot overflow and stay out.)
            return RealNumberMP(R, 1 if v._special == "+inf" else -1, _EMAX + 8)
        if v._special or not v._m:
            return R(v)
        m, e = v._m, v._e
        # 2^8 units of F's last place, in units of m's last bit
        B = abs(m).bit_length()
        k = B - (p + extra)
        t = (256 << k) if k >= 0 else max(1, 256 >> -k) + 1
        sgn = 1 if m > 0 else -1
        lo = _round_int(m - sgn * t, e, p, R._rnd)
        hi = _round_int(m + sgn * t, e, p, R._rnd)
        if lo == hi:
            return RealNumberMP(R, lo[0], lo[1])
        if limit is not None and extra > limit:
            if not checked:
                checked = True
                cm, ce = _round_int(v._m, v._e, p + 1, "RNDN")
                t = exact(cm, ce) if exact is not None else None
                if t:
                    return RealNumberMP(R, *_round_int(cm, ce, p, R._rnd))
                if t is None:
                    raise NotImplementedError("the correct rounding of this value to %d bits is not decided within %d extra bits (it may be a rounding boundary) in sagebrush yet" % (p, extra))
            if extra > _ZIV_CAP(p, limit):
                raise NotImplementedError("the correct rounding of this value to %d bits is not decided within %d extra bits in sagebrush yet" % (p, extra))
        extra *= 2


def _ZIV_CAP(p, limit):
    """The most extra bits _ziv_eval spends on a value shown not to be a
    rounding boundary (one that close to a boundary needs about p more
    bits: the root of 1 + 3 2^(1-p) to p = 8192 bits needs 2p)."""
    return max(16 * limit, 8 * p)


def _odd2(n, d=1, s=0):
    """(N, D, t) with n/d 2^s = N/D 2^t, N and D odd and coprime (n, d >
    0 integers)."""
    g = math.gcd(n, d)
    n, d = n // g, d // g
    a, b = (n & -n).bit_length() - 1, (d & -d).bit_length() - 1
    return n >> a, d >> b, s + a - b


def _iroot(n, k):
    """The integer k-th root of n >= 1, rounded down (Newton's method from
    above)."""
    if k == 1:
        return n
    x = 1 << -(-n.bit_length() // k)
    while True:
        y = ((k - 1) * x + n // x ** (k - 1)) // k
        if y >= x:
            return x
        x = y


def _ipow_eq(A, m1, B, m2):
    """Whether A^m1 == B^m2, for odd A, B >= 1 and coprime m1, m2 >= 1:
    exactly when A = C^m2 and B = C^m1 for an integer C, so only roots no
    larger than A and B are formed (C >= 3 when A > 1, so m2 < bitlen(A))."""
    if A == 1 or B == 1:
        return A == B
    if m2 >= A.bit_length() or m1 >= B.bit_length():
        return False
    C = _iroot(A, m2)
    if C ** m2 != A or (C.bit_length() - 1) * m1 >= B.bit_length():
        return False
    return C ** m1 == B


def _pow_eq(a, n1, b, n2):
    """Whether a^n1 == b^n2, exactly, for positive rationals a, b given as
    _odd2 triples (N, D, t) and integers n1 > 0, n2 of any size: the odd
    numerators and denominators and the powers of 2 must agree separately
    (unique factorization), and an equality of odd powers is decided by
    integer roots no larger than the operands (no float, no power formed)."""
    if n2 < 0:
        b, n2 = (b[1], b[0], -b[2]), -n2
    if n2 == 0:
        return a == (1, 1, 0)
    if a[2] * n1 != b[2] * n2:
        return False
    g = math.gcd(n1, n2)
    m1, m2 = n1 // g, n2 // g
    return _ipow_eq(a[0], m1, b[0], m2) and _ipow_eq(a[1], m1, b[1], m2)


def _dyadic_ratio(m, e):
    """(n, d) with m 2^e = n/d (m != 0), or None when |e| (after m's
    trailing zeros) exceeds _EXACT_BITS: an exponent of that size is not
    formed as an integer."""
    t = (abs(m) & -abs(m)).bit_length() - 1
    m, e = m >> t, e + t
    if abs(e) > _EXACT_BITS:
        return None
    return (m << e, 1) if e >= 0 else (m, 1 << -e)


def _huge(m, e):
    """Whether m 2^e is too large or small to handle by its exact rational
    value comfortably (formatting, comparison, hashing take other paths)."""
    return abs(e) > 4096


# ------------------------------------------------------------------ format()
# format(x, spec) as Sage gives it: the printed decimal digits formatted by
# Python's documented format-spec rules for Decimal (no float: a 100-bit
# 1/3 with '.30f' is 0.333...330, 2^2000 with '.3e' is 1.148e+602).
# Checked against CPython's Decimal on 60000 random specs.
import re as _re

_SPEC = _re.compile(r"\A(?:(?P<fill>.)?(?P<align>[<>=^]))?(?P<sign>[-+ ])?(?P<alt>#)?(?P<zero>0)?(?P<width>\d+)?(?P<grouping>[,_])?(?:\.(?P<precision>\d+))?(?P<type>[eEfFgG%])?\Z", _re.S)


def _dec_parse(s):
    """(negative, digits, exponent) of a decimal string: the value is
    (-1)^negative int(digits) 10^exponent (digits without leading zeros)."""
    s = s.strip()
    neg = s.startswith("-")
    s = s.lstrip("+-")
    mant, _, ex = s.lower().partition("e")
    ex = int(ex) if ex else 0
    ip, _, fp = mant.partition(".")
    digits = (ip + fp).lstrip("0") or "0"
    return neg, digits, ex - len(fp)


def _zeros(n):
    """n zeros, for a fixed-point string (Sage too raises MemoryError for
    2^(2^40) with '.30f')."""
    if n > 10 ** 7:
        raise MemoryError("a fixed-point string of more than 10^7 digits")
    return "0" * n


def _dec_round(digits, exp, q):
    """int(digits) 10^exp rounded half to even to a multiple of 10^q:
    (digits, q), digits without leading zeros ('0' for zero)."""
    if exp >= q:
        return (digits + _zeros(exp - q)).lstrip("0") or "0", q
    cut = q - exp
    if cut > len(digits):
        return "0", q
    head, tail = digits[:len(digits) - cut], digits[len(digits) - cut:]
    n = int(head) if head else 0
    half = "5" + "0" * (len(tail) - 1)
    if tail > half or (tail == half and n % 2):
        n += 1
    return str(n), q


def _fixed(d, k):
    """The digits d times 10^k in fixed point (no exponent)."""
    if k >= 0:
        return (d + _zeros(k)) if d != "0" else "0"
    n = -k
    if len(d) <= n:
        d = _zeros(n - len(d) + 1) + d
    return d[:-n] + "." + d[-n:]


def _sci(d, top, e_char, alt):
    """The digits d (d[0] nonzero unless zero) as d[0].d[1:] e top."""
    mant = d[0] + ("." + d[1:] if len(d) > 1 else ("." if alt else ""))
    return mant + e_char + ("%+d" % top)


def _fmt_e(digits, exp, prec, e_char, alt):
    if digits == "0":
        if prec is None:
            return _sci("0", exp, e_char, alt)
        return _sci(_zeros(prec + 1), exp + prec, e_char, alt)
    top = exp + len(digits) - 1
    if prec is None:
        return _sci(digits, top, e_char, alt)
    d, _ = _dec_round(digits, exp, top - prec)
    if len(d) > prec + 1:
        top += 1
        d, _ = _dec_round(digits, exp, top - prec)
    return _sci(d, top, e_char, alt)


def _fmt_f(digits, exp, prec, alt):
    if prec is None:
        s = _fixed(digits, exp) if exp < 0 else (digits + _zeros(exp) if digits != "0" else "0")
    else:
        d, k = _dec_round(digits, exp, -prec)
        s = _fixed(d, k)
    if alt and "." not in s:
        s += "."
    return s


def _fmt_g(digits, exp, prec, e_char, alt):
    """'g' (and no type): with a precision p, a value of more than p digits
    is rounded to p significant digits (fewer are kept as they are, and
    trailing zeros stay); then Decimal's to-scientific-string rule: fixed
    point when the exponent is <= 0 and the adjusted exponent >= -6."""
    d, k = digits, exp
    if prec is not None and digits != "0":
        p = max(prec, 1)
        if len(d) > p:
            top = exp + len(digits) - 1
            d, k = _dec_round(digits, exp, top - (p - 1))
            if len(d) > p:
                d, k = _dec_round(digits, exp, top + 1 - (p - 1))
    X = k + len(d) - 1
    if k <= 0 and X >= -6:
        s = _fixed(d, k)
        if alt and "." not in s:
            s += "."
        return s
    return _sci(d, X, e_char, alt)


def _dec_format(neg, digits, exp, spec):
    """format(Decimal((neg, digits, exp)), spec) for the presentation types
    e, E, f, F, g, G, % and none, with fill, align, sign, #, 0, width,
    grouping and precision."""
    m = _SPEC.match(spec)
    if m is None:
        raise ValueError("invalid format specifier %r" % spec)
    t = m.group("type")
    prec = m.group("precision")
    prec = int(prec) if prec is not None else None
    alt = bool(m.group("alt"))
    if t in ("e", "E"):
        body = _fmt_e(digits, exp, prec, t, alt)
    elif t in ("f", "F"):
        body = _fmt_f(digits, exp, prec, alt)
    elif t == "%":
        body = _fmt_f(digits, exp + 2, prec, alt) + "%"
    else:
        body = _fmt_g(digits, exp, prec, "e" if t == "g" else "E", alt)
    sign = m.group("sign") or "-"
    s = "-" if neg else {"+": "+", " ": " "}.get(sign, "")
    return _pad(s, body, m)


def _pad(sign, body, m):
    grouping = m.group("grouping")
    width = int(m.group("width") or 0)
    fill = m.group("fill") or " "
    align = m.group("align")
    zero = m.group("zero") and not m.group("align")
    if zero:
        fill, align = "0", "="
    if grouping:
        j = 0
        while j < len(body) and body[j].isdigit():
            j += 1
        ip, rest = body[:j], body[j:]
        if zero:
            # zero padding goes through the grouping (Decimal pads digits)
            need = width - len(sign) - len(rest)
            while len(_group(ip, grouping)) < need:
                ip = "0" + ip
            g = _group(ip, grouping)
            if len(g) > need and need > 0 and g.startswith("0"):
                pass
            body = g + rest
            return sign + body
        body = _group(ip, grouping) + rest
    if align is None:
        align = ">"
    n = width - len(sign) - len(body)
    if n <= 0:
        return sign + body
    if align == "<":
        return sign + body + fill * n
    if align == ">":
        return fill * n + sign + body
    if align == "=":
        return sign + fill * n + body
    left = n // 2
    return fill * left + sign + body + fill * (n - left)


def _group(ip, sep):
    groups = []
    while len(ip) > 3:
        groups.insert(0, ip[-3:])
        ip = ip[:-3]
    groups.insert(0, ip)
    return sep.join(groups)


# ------------------------------------------------------------------ fixed-point kernels
# A fixed-point number at scale W is an integer X standing for X / 2^W.

_CACHE = {}


def _fx(m, e, W):
    """m 2^e as a fixed-point integer at scale W (truncated)."""
    s = e + W
    if s < 0 and -s > abs(m).bit_length():
        # (below the last place: 0, without a shift by a huge count)
        return 0
    return m << s if s >= 0 else (m >> -s if m >= 0 else -((-m) >> -s))


def _sh(a, g):
    """a / 2^g truncated toward zero (so series of either sign terminate)."""
    return a >> g if a >= 0 else -((-a) >> g)


def _dv(a, n):
    """a / n truncated toward zero (n > 0)."""
    return a // n if a >= 0 else -((-a) // n)


def _fx_div(a, b, W):
    return (a << W) // b


def _fx_mul(a, b, W):
    return (a * b) >> W


def _fx_sqrt(a, W):
    return math.isqrt(a << W)


def _atan_inv(k, W):
    """atan(1/k) at scale W (k an integer > 1)."""
    x = (1 << W) // k
    k2 = k * k
    s, t, n = x, x, 1
    sign = -1
    while t:
        t //= k2
        n += 2
        s += sign * (t // n)
        sign = -sign
    return s


# The largest magnitude (log2 |x|) whose trigonometric functions are
# computed (argument reduction takes pi to that many bits)
_TRIG_MAX_MAG = 1 << 16


def _pi(W):
    key = ("pi", W)
    if key not in _CACHE:
        g = W + 20
        # Machin: pi = 16 atan(1/5) - 4 atan(1/239)
        p = 16 * _atan_inv(5, g) - 4 * _atan_inv(239, g)
        _CACHE[key] = p >> 20
    return _CACHE[key]


def _atanh_inv(k, W):
    """atanh(1/k) at scale W."""
    x = (1 << W) // k
    k2 = k * k
    s, t, n = x, x, 1
    while t:
        t //= k2
        n += 2
        s += t // n
    return s


def _ln2(W):
    key = ("ln2", W)
    if key not in _CACHE:
        g = W + 20
        # ln 2 = 18 atanh(1/26) - 2 atanh(1/4801) + 8 atanh(1/8749)
        v = 18 * _atanh_inv(26, g) - 2 * _atanh_inv(4801, g) + 8 * _atanh_inv(8749, g)
        _CACHE[key] = v >> 20
    return _CACHE[key]


def _exp_fx(x, W):
    """exp(x) for a fixed-point x (scale W), at scale W."""
    g = W + 30
    X = x << 30
    L = _ln2(g)
    k = (X + (L >> 1)) // L if X >= 0 else -((-X + (L >> 1)) // L)
    r = X - k * L
    s = max(4, int(math.isqrt(g)) // 2)
    r = _sh(r, s)
    one = 1 << g
    t, total, n = one, one, 0
    while t:
        n += 1
        t = _dv(_sh(t * r, g), n)
        total += t
    for _ in range(s):
        total = total * total >> g
    total >>= 30
    return total << k if k >= 0 else total >> -k


def _log_fx(m, e, W):
    """log(m 2^e) (m > 0) at scale W."""
    g = W + 30
    b = m.bit_length()
    k = e + b  # m 2^e = f 2^k with f = m / 2^b in [1/2, 1)
    f = _fx(m, -b, g)
    # f in [1/2, 1): log f = 2 atanh((f - 1)/(f + 1)); reduce with square roots
    one = 1 << g
    sq = 0
    while abs(f - one) > (one >> 12) and sq < 40:
        f = _fx_sqrt(f, g)
        sq += 1
    y = _dv((f - one) << g, f + one)
    y2 = y * y >> g
    s, t, n = y, y, 1
    while t:
        t = _sh(t * y2, g)
        n += 2
        s += _dv(t, n)
    v = (2 * s) << sq
    v += k * _ln2(g)
    return _sh(v, 30)


def _sincos_fx(x, W):
    """(sin x, cos x) for a fixed-point x at scale W."""
    g = W + 30 + max(0, abs(x).bit_length() - W)
    X = x << (g - W)
    P = _pi(g)
    half = P >> 1
    q = (X + (half >> 1)) // half if X >= 0 else -((-X + (half >> 1)) // half)
    r = X - q * half
    s = 8
    r = _sh(r, s)
    one = 1 << g
    r2 = r * r >> g
    # Taylor for sin and cos of r
    sn, t, n = r, r, 1
    while t:
        t = -_dv(_sh(t * r2, g), (n + 1) * (n + 2))
        n += 2
        sn += t
    cs, t, n = one, one, 0
    while t:
        t = -_dv(_sh(t * r2, g), (n + 1) * (n + 2))
        n += 2
        cs += t
    for _ in range(s):
        sn, cs = _sh(2 * sn * cs, g), _sh(cs * cs - sn * sn, g)
    q %= 4
    if q == 1:
        sn, cs = cs, -sn
    elif q == 2:
        sn, cs = -sn, -cs
    elif q == 3:
        sn, cs = -cs, sn
    sh = g - W
    return _sh(sn, sh), _sh(cs, sh)


def _atan_fx(x, W):
    """atan of a fixed-point x at scale W."""
    g = W + 30
    X = x << 30
    one = 1 << g
    neg = X < 0
    X = abs(X)
    inv = False
    if X > one:
        X = (one << g) // X
        inv = True
    k = 0
    while X > (one >> 4):
        # atan(x) = 2 atan(x / (1 + sqrt(1 + x^2)))
        X = (X << g) // (one + math.isqrt((one << g) + X * X))
        k += 1
    x2 = X * X >> g
    s, t, n = X, X, 1
    sign = -1
    while t:
        t = t * x2 >> g
        n += 2
        s += sign * (t // n)
        sign = -sign
    s <<= k
    if inv:
        s = (_pi(g) >> 1) - s
    if neg:
        s = -s
    return _sh(s, 30)


def _euler_gamma(W):
    """Euler's constant (Brent-McMillan: gamma = A/B - log n)."""
    key = ("gamma", W)
    if key not in _CACHE:
        g = W + 40
        n = max(1, int(W * 0.1733) + 1)  # n with exp(-4n) < 2^-W
        one = 1 << g
        a = -_log_fx(n, 0, g)
        b = one
        u, v = a, b
        k = 1
        n2 = n * n
        while True:
            b = b * n2 // (k * k)
            a = (a * n2 // k + b) // k
            if not b and not a:
                break
            u += a
            v += b
            k += 1
        _CACHE[key] = (u << g) // v >> 40
    return _CACHE[key]


def _catalan(W):
    """Catalan's constant: pi/8 log(2 + sqrt 3) + 3/8 sum (k!)^2 / ((2k)! (2k+1)^2)."""
    key = ("catalan", W)
    if key not in _CACHE:
        g = W + 30
        one = 1 << g
        s = 0
        t = one  # (k!)^2/(2k)!
        k = 0
        while t:
            s += t // ((2 * k + 1) ** 2)
            k += 1
            t = t * k * k // ((2 * k) * (2 * k - 1))
        r = 3 * s // 8
        two_sqrt3 = (2 << g) + math.isqrt(3 << (2 * g))
        lg = _log_fx(two_sqrt3, -g, g)
        r += _pi(g) * lg // (8 << g)
        _CACHE[key] = r >> 30
    return _CACHE[key]


# ------------------------------------------------------------------ fields

_FIELDS = {}


def RealField(prec=53, sci_not=False, rnd="RNDN"):
    """The field of real numbers with prec bits of precision (RR for 53
    bits, rounding to nearest).

    EXAMPLES::

        sage: RealField(100)
        Real Field with 100 bits of precision
        sage: RealField(100)(2).sqrt(), RealField(10)(1/3)
        (1.4142135623730950488016887242, 0.33)
        sage: RealField(3, rnd='RNDU')
        Real Field with 3 bits of precision and rounding RNDU
    """
    prec = int(prec)
    if prec < 1:
        raise ValueError("prec (=%d) must be >= 1 and <= 2147483391" % prec)
    rnd = str(rnd)
    if rnd not in _RND:
        raise ValueError("rounding mode (=%s) must be one of %s" % (rnd, ", ".join(_RND)))
    if prec == 53 and rnd == "RNDN":
        return _sa().RR
    key = (prec, rnd)
    if key not in _FIELDS:
        _FIELDS[key] = RealField_(prec, rnd)
    return _FIELDS[key]


class RealField_:
    """A real field with a given precision and rounding mode.

    EXAMPLES::

        sage: R = RealField(30); R, R.precision(), R.pi()
        (Real Field with 30 bits of precision, 30, 3.1415927)
    """

    _is_generic_field = True
    _numeric = True


    # (True only for the 53-bit field that holds RR's elements past the
    # doubles: its arithmetic keeps MP values instead of returning RR)
    _rr_internal = False

    def __init__(self, prec, rnd="RNDN"):
        self._prec, self._rnd = prec, rnd

    def __repr__(self):
        s = "Real Field with %d bits of precision" % self._prec
        return s + (" and rounding %s" % self._rnd if self._rnd != "RNDN" else "")

    def _latex_(self):
        return "\\Bold{R}"

    def __eq__(self, o):
        return isinstance(o, RealField_) and (o._prec, o._rnd) == (self._prec, self._rnd)

    def __hash__(self):
        return hash(("RealField", self._prec, self._rnd))

    def precision(self):
        """The precision in bits.

        EXAMPLES::

            sage: RealField(100).precision(), RealField(100).prec()
            (100, 100)
        """
        return _sa().Integer(self._prec)

    prec = precision

    def rounding_mode(self):
        """The rounding mode.

        EXAMPLES::

            sage: RealField(10, rnd='RNDD').rounding_mode()
            'RNDD'
        """
        return self._rnd

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: RealField(100).is_exact()
            False
        """
        return False

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: RealField(100).is_field()
            True
        """
        return True

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: RealField(100).characteristic()
            0
        """
        return _sa().Integer(0)

    def to_prec(self, prec):
        """The real field with another precision.

        EXAMPLES::

            sage: RealField(100).to_prec(20)
            Real Field with 20 bits of precision
        """
        return RealField(prec, rnd=self._rnd)

    def complex_field(self):
        """ComplexField of the same precision.

        EXAMPLES::

            sage: RealField(100).complex_field()
            Complex Field with 100 bits of precision
        """
        return ComplexField(self._prec)

    def zero(self):
        """0.

        EXAMPLES::

            sage: RealField(30).zero()
            0.00000000
        """
        return RealNumberMP(self, 0, 0)

    def one(self):
        """1.

        EXAMPLES::

            sage: RealField(30).one()
            1.0000000
        """
        return self(1)

    def pi(self):
        """pi to the precision of the field.

        EXAMPLES::

            sage: RealField(100).pi()
            3.1415926535897932384626433833
        """
        return self._const(_pi)

    def log2(self):
        """log(2).

        EXAMPLES::

            sage: RealField(100).log2()
            0.69314718055994530941723212146
        """
        return self._const(_ln2)

    def euler_constant(self):
        """Euler's constant gamma.

        EXAMPLES::

            sage: RealField(100).euler_constant()
            0.57721566490153286060651209008
        """
        return self._const(_euler_gamma)

    def catalan_constant(self):
        """Catalan's constant.

        EXAMPLES::

            sage: RealField(100).catalan_constant()
            0.91596559417721901505460351493
        """
        return self._const(_catalan)

    def _const(self, f):
        W = self._prec + 20
        return self._fixed(f(W), W)

    def _fixed(self, X, W):
        m, e = _round_q(X, 1, self._prec, self._rnd, -W) if X else (0, 0)
        return RealNumberMP(self, m, e)

    def _ziv(self, f, W):
        """f(W) rounded in this field's direction (Ziv): f(W) approximates
        a value at scale W within 2^8 units (30 guard bits inside); both ends
        of that interval must round alike, else W grows.  The value must not
        be a binary number (exp, log, sin, cos, atan at nonzero rationals,
        other than log 1 and cos 0, are transcendental), so this ends.  (The
        rounded approximation alone went the wrong way: exp(2^-300) rounded
        up was 1, the systematic review's R2-NUM-F10.)"""
        E = 1 << 8
        for k in range(10):
            X = f(W)
            lo = _round_q(X - E, 1, self._prec, self._rnd, -W) if X - E else None
            hi = _round_q(X + E, 1, self._prec, self._rnd, -W) if X + E else None
            if lo is not None and lo == hi:
                return RealNumberMP(self, *lo)
            W += 64 << k
        return self._fixed(X, W)

    def __call__(self, x=0, base=10):
        """Convert a number, a string or an exact expression.

        EXAMPLES::

            sage: R = RealField(100); R(1/3), R('1.5'), R(pi)
            (0.33333333333333333333333333333, 1.5000000000000000000000000000, 3.1415926535897932384626433833)
        """
        return _to_real(self, x, base)

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False

    def random_element(self, min=-1, max=1):
        """A random number in [min, max].

        EXAMPLES::

            sage: RealField(100).random_element().parent()
            Real Field with 100 bits of precision
        """
        import random as _r
        b = self._prec + 10
        u = _F(_r.getrandbits(b), 1 << b)
        return self(_F(min) + (_F(max) - _F(min)) * u)



_BIG = None


def _rr_big_mp(x):
    """The 53-bit value of x when x is an element of RR past the doubles
    (lib/_sage_lang.py's _RealBig), else None.  (An isinstance test: a
    missing attribute's lookup is slow in pyjs, and this is on every path.)"""
    global _BIG
    if _BIG is None:
        import _sage_lang
        _BIG = _sage_lang._RealBig
    return x._mp if isinstance(x, _BIG) else None


def _to_real(R, x, base=10):
    prec, rnd = R._prec, R._rnd
    # (an element of RR past the doubles is its 53-bit value, not its float;
    # a decimal literal's, its digits: RealField(100)(1e400) is 1e400)
    big = _rr_big_mp(x)
    if big is not None:
        if x._lit is not None:
            return _parse(R, x._lit)
        x = big
    if isinstance(x, RealNumberMP):
        if x._special:
            return RealNumberMP(R, 0, 0, x._special)
        m, e = _round_int(x._m, x._e, prec, rnd) if x._m else (0, 0)
        return RealNumberMP(R, m, e)
    if isinstance(x, bool):
        x = int(x)
    if isinstance(x, int):
        m, e = _round_q(x, 1, prec, rnd) if x else (0, 0)
        return RealNumberMP(R, m, e)
    if isinstance(x, _F):
        m, e = _round_q(x.numerator, x.denominator, prec, rnd) if x else (0, 0)
        return RealNumberMP(R, m, e)
    lit = getattr(x, "_lit", None)
    if lit is not None:
        return _parse(R, lit)
    if isinstance(x, float):
        if x != x:
            return RealNumberMP(R, 0, 0, "nan")
        if x in (float("inf"), float("-inf")):
            return RealNumberMP(R, 0, 0, "+inf" if x > 0 else "-inf")
        q = _F(x)
        m, e = _round_q(q.numerator, q.denominator, prec, rnd) if q else (0, 0)
        return RealNumberMP(R, m, e)
    if isinstance(x, str):
        return _parse(R, x, base)
    if isinstance(x, ComplexNumberMP):
        if x._im:
            raise TypeError("unable to convert %r to a real number" % (x,))
        return _to_real(R, x._re)
    s = getattr(x, "_s", None)
    if s is not None:
        v = evaluate(x, prec + 20)
        if isinstance(v, ComplexNumberMP):
            if not v._im.is_zero():
                raise TypeError("unable to convert %r to a real number" % (x,))
            v = v._re
        return _to_real(R, v)
    if type(x).__name__ in ("AlgebraicNumber", "AlgebraicReal"):
        z = x._approx(int(prec * _LOG10_2) + 10)
        if z[1]:
            raise TypeError("unable to convert %r to a real number" % (x,))
        return _to_real(R, z[0])
    try:
        return _to_real(R, _F(x))
    except (TypeError, ValueError):
        pass
    try:
        return _to_real(R, float(x))
    except (TypeError, ValueError):
        raise TypeError("unable to convert %r to a real number" % (x,))


def _parse(R, s, base=10):
    t = s.strip().replace("_", "")
    low = t.lower()
    if low in ("inf", "+inf", "infinity", "+infinity"):
        return RealNumberMP(R, 0, 0, "+inf")
    if low in ("-inf", "-infinity"):
        return RealNumberMP(R, 0, 0, "-inf")
    if low == "nan":
        return RealNumberMP(R, 0, 0, "nan")
    if base != 10:
        neg = t.startswith("-")
        t = t.lstrip("+-")
        if "." in t:
            ip, fp = t.split(".")
        else:
            ip, fp = t, ""
        n = int(ip or "0", base) * base ** len(fp) + (int(fp, base) if fp else 0)
        q = _F(n, base ** len(fp))
        return _to_real(R, -q if neg else q)
    m = _re.match(r"^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?)(\d+)$", t)
    if m and (m.group(2) or m.group(3)):
        neg = m.group(1) == "-"
        if not (m.group(2) or "").strip("0") and not (m.group(3) or "").strip("0"):
            return RealNumberMP(R, 0, 0) if not neg else -RealNumberMP(R, 0, 0)
        ed = m.group(5).lstrip("0")
        if len(ed) > 25 and len(t) < 10 ** 20:
            # an exponent of 10^24 or more, against a mantissa of fewer
            # than 10^20 digits: past the range by its sign alone (the
            # exponent is never converted: a 5000-digit one was)
            big = (1, _EMAX + 8) if m.group(4) != "-" else (1, _EMIN - 8)
            return RealNumberMP(R, -big[0] if neg else big[0], big[1])
        Ex = int(ed or "0") * (-1 if m.group(4) == "-" else 1)
        if abs(Ex) > 4096:
            # a large decimal exponent (RR('1e1000000000')): not the exact
            # rational, whose size is the exponent's, but M 10^E correctly
            # rounded (_round_dec)
            fp = m.group(3) or ""
            M = int((m.group(2) or "0") + fp) * (-1 if neg else 1)
            return RealNumberMP(R, *_round_dec(M, Ex - len(fp), R._prec, R._rnd))
    try:
        q = _F(t)
    except ValueError:
        raise TypeError("unable to convert %r to a real number" % s)
    return _to_real(R, q)


class RealNumberMP:
    """A real number of a RealField(prec).

    EXAMPLES::

        sage: R = RealField(100); x = R(2).sqrt(); x
        1.4142135623730950488016887242
        sage: x^2, x.parent(), x.prec()
        (2.0000000000000000000000000000, Real Field with 100 bits of precision, 100)

    Integer powers are correctly rounded for any exponent, and the exponent
    range is MPFR's, as in Sage: beyond about 2^(+-2^62) a result
    overflows to infinity or underflows to 0::

        sage: R(3)^(10^9)
        5.2439970329552882635606695895e477121254
        sage: R(2)^(2^62), R(2)^(-2^63), R(1.5)^-11
        (+infinity, 0.00000000000000000000000000000, 0.011561019943888409061400983364)
        sage: R(-1.1), R(oo), R(-oo)
        (-1.1000000000000000000000000000, +infinity, -infinity)
    """

    __slots__ = ("_R", "_m", "_e", "_special")

    def __init__(self, R, m, e, special=None):
        if m and special is None:
            m, e, special = _range(R, m, e)
        self._R, self._m, self._e, self._special = R, m, e, special

    # ---- data
    def parent(self):
        """The real field.

        EXAMPLES::

            sage: RealField(20)(1).parent()
            Real Field with 20 bits of precision
        """
        return self._R

    def prec(self):
        """The precision in bits.

        EXAMPLES::

            sage: RealField(20)(1).prec()
            20
        """
        return _sa().Integer(self._R._prec)

    precision = prec

    def _q(self):
        """The exact rational value."""
        if self._special:
            raise ValueError("%s has no exact value" % self._special)
        if abs(self._e) > _EXACT_BITS:
            raise NotImplementedError("the exact value of a real number with binary exponent %d (beyond 2^20) is not available in sagebrush" % (self._e + abs(self._m).bit_length()))
        if self._e >= 0:
            return _F(self._m << self._e)
        return _F(self._m, 1 << -self._e)

    def exact_rational(self):
        """The rational number this is exactly.

        EXAMPLES::

            sage: RealField(20)(1/3).exact_rational()
            699051/2097152
        """
        from _sage_poly import _norm
        return _norm(self._q())

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: RealField(20)(0).is_zero()
            True
        """
        return self._m == 0 and not self._special

    def __bool__(self):
        return not self.is_zero()

    def is_infinity(self):
        """Whether infinite.

        EXAMPLES::

            sage: RealField(30)(1).is_infinity(), (RealField(30)(1)/0).is_infinity()
            (False, True)
        """
        return self._special in ("+inf", "-inf")

    def is_NaN(self):
        """Whether NaN.

        EXAMPLES::

            sage: RealField(30)(1).is_NaN()
            False
        """
        return self._special == "nan"

    def sign(self):
        """-1, 0 or 1.

        EXAMPLES::

            sage: RealField(20)(-3).sign()
            -1
        """
        if self._special:
            return {"+inf": 1, "-inf": -1}.get(self._special, 0)
        return _sa().Integer((self._m > 0) - (self._m < 0))

    def sign_mantissa_exponent(self):
        """(sign, mantissa, exponent) with self = sign * mantissa * 2^exponent.

        EXAMPLES::

            sage: RealField(20)(3).sign_mantissa_exponent()
            (1, 786432, -18)
        """
        Z = _sa().Integer
        return Z(1 if self._m >= 0 else -1), Z(abs(self._m)), Z(self._e)

    # ---- printing
    def __repr__(self):
        if self._special:
            return {"+inf": "+infinity", "-inf": "-infinity", "nan": "NaN"}[self._special]
        rnd = _DEC_RND[self._R._rnd]
        if self._m < 0 and self._R._rnd in ("RNDZ", "RNDA"):
            # toward zero is up for a negative number, away from it down
            rnd = "U" if self._R._rnd == "RNDZ" else "D"
        if self._m and _huge(self._m, self._e):
            return _format_big(self._m, self._e, _digits(self._R._prec), rnd=rnd)
        return _format(self._q(), _digits(self._R._prec), rnd=rnd)

    __str__ = __repr__

    def str(self, base=10, digits=0, no_sci=None, e=None, truncate=False, skip_zeroes=False):
        """The decimal string: all the digits needed to read the number back
        (1 + ceil(prec log10 2)), or digits digits.

        EXAMPLES::

            sage: RealField(100)(1/3).str(), RealField(100)(1/3).str(digits=5)
            ('0.33333333333333333333333333333346', '0.33333')
        """
        if self._special:
            return {"+inf": "+infinity", "-inf": "-infinity", "nan": "NaN"}[self._special]
        D = int(digits) if digits else 1 + int(math.ceil(self._R._prec * _LOG10_2 - 1e-12))
        if truncate and not digits:
            D = _digits(self._R._prec)
        if self._m and _huge(self._m, self._e):
            return _format_big(self._m, self._e, D, no_sci)
        return _format(self._q(), D, no_sci)

    def _latex_(self):
        return repr(self)

    def __format__(self, spec):
        """format(x, spec): Sage's printed digits formatted as a Decimal.

        EXAMPLES::

            sage: x = RealField(100)(1)/3
            sage: format(x, '.30f'), format(RealField(100)(2)^2000, '.3e'), '{:>12.4g}'.format(x)
            ('0.333333333333333333333333333330', '1.148e+602', '      0.3333')
        """
        if spec == "":
            return repr(self)
        if self._special:
            m = _SPEC.match(spec)
            if m is None:
                raise ValueError("invalid format specifier %r" % spec)
            body = ("NaN" if self._special == "nan" else "Infinity") + ("%" if m.group("type") == "%" else "")
            neg = self._special == "-inf"
            sign = m.group("sign") or "-"
            if m.group("zero") and not m.group("align"):
                # (no zero padding of a non-number: spaces, as Decimal)
                m = _SPEC.match(spec.replace("0", "", 1)) if not m.group("fill") else m
            return _pad("-" if neg else {"+": "+", " ": " "}.get(sign, ""), body, m)
        neg, digits, exp = _dec_parse(repr(self))
        return _dec_format(neg, digits, exp, spec)

    # ---- conversion
    def __float__(self):
        if self._special:
            return {"+inf": float("inf"), "-inf": float("-inf"), "nan": float("nan")}[self._special]
        m, e = self._m, self._e
        if not m:
            return 0.0
        neg, a = m < 0, abs(m)
        E = e + a.bit_length()
        if E > 1025:
            return float("-inf") if neg else float("inf")
        if E <= -1022:
            # below 2^-1022: the nearest multiple of 2^-1074 (half to even),
            # rounded once from the exact value (3 2^-1076 is 2^-1074)
            if E < -1076:
                return -0.0 if neg else 0.0
            sh = e + 1074
            if sh >= 0:
                q = a << sh
            else:
                q, r = divmod(a, 1 << -sh)
                c = 2 * r - (1 << -sh)
                if c > 0 or (c == 0 and q & 1):
                    q += 1
            r = math.ldexp(q, -1074)
        else:
            # 53 bits, rounded once; overflow to inf
            q, k = _round_q(a, 1, 53, "RNDN", e)
            if k + q.bit_length() > 1024:
                return float("-inf") if neg else float("inf")
            r = math.ldexp(q, k)
        return -r if neg else r

    def __int__(self):
        return int(self.trunc())

    def __complex__(self):
        return complex(float(self))

    def _rational_(self):
        return self._q()

    def numerical_approx(self, prec=None, digits=None):
        """The number in another precision.

        EXAMPLES::

            sage: RealField(100)(1/3).n(20)
            0.33333
        """
        if digits is not None:
            prec = digits_to_prec(digits)
        if prec is None:
            prec = 53
        return RealField(prec)(self) if int(prec) != 53 else _sa().RR(self)

    n = N = numerical_approx

    def __hash__(self):
        if self._special:
            return hash(self._special)
        if _huge(self._m, self._e):
            # Python's hash of the rational m 2^e, without forming it
            P = (1 << 61) - 1
            k = self._e % (P - 1)
            h = abs(self._m) % P * pow(2, k, P) % P
            h = -h if self._m < 0 else h
            return -2 if h == -1 else h
        return hash(self._q())

    # ---- arithmetic
    def _other(self, o):
        """(o as a RealNumberMP, the field of the result), or (None, None)."""
        mp = _rr_big_mp(o)
        if mp is not None:
            # an element of RR past the doubles: its 53-bit value, the
            # result in RR when this field is not coarser
            return mp, (RealField_(53, "RNDN") if self._R._prec > 53 else self._R)
        if isinstance(o, RealNumberMP):
            return o, (o._R if o._R._prec < self._R._prec else self._R)
        if isinstance(o, (int, _F)) or type(o).__name__ in ("Integer", "Rational"):
            return _to_real(self._R, o), self._R
        if isinstance(o, float):
            # a Python float or an element of RR: 53 bits
            R53 = RealField_(53, "RNDN")
            return _to_real(R53, o), (R53 if self._R._prec > 53 else self._R)
        return None, None

    def _binop(self, o, op, rev=False):
        b, R = self._other(o)
        if b is None:
            return NotImplemented
        a = self
        if rev:
            a, b = b, a
        r = _arith(a, b, op, R)
        if R._prec == 53 and R._rnd == "RNDN" and not R._rr_internal:
            # (53 bits to nearest is RR: a double, or past the doubles an RR
            # element held at 53 bits; the field RR uses internally for that
            # keeps its MP values)
            return _sa().RR(r)
        return r

    def __add__(self, o): return self._binop(o, "+")
    def __radd__(self, o): return self._binop(o, "+", True)
    def __sub__(self, o): return self._binop(o, "-")
    def __rsub__(self, o): return self._binop(o, "-", True)
    def __mul__(self, o): return self._binop(o, "*")
    def __rmul__(self, o): return self._binop(o, "*", True)
    def __truediv__(self, o): return self._binop(o, "/")
    def __rtruediv__(self, o): return self._binop(o, "/", True)

    def __neg__(self):
        if self._special:
            return RealNumberMP(self._R, 0, 0, {"+inf": "-inf", "-inf": "+inf"}.get(self._special, "nan"))
        return RealNumberMP(self._R, -self._m, self._e)

    def __pos__(self):
        return self

    def __abs__(self):
        """The absolute value.

        EXAMPLES::

            sage: RealField(30)(-2).abs()
            2.0000000
        """
        return -self if self._m < 0 or self._special == "-inf" else self

    abs = __abs__

    def __pow__(self, n, mod=None):
        R = self._R
        if isinstance(n, int) or (isinstance(n, _F) and n.denominator == 1) or type(n).__name__ == "Integer":
            n = int(n)
            if self._special:
                return R(float(self) ** n)
            if n == 0:
                return R(1)
            if self._m == 0:
                if n > 0:
                    return self
                return RealNumberMP(R, 0, 0, "+inf")
            # past the exponent range for certain: decided from bit lengths
            # before any powering (RR(3)^(2^20000) squared a 20000-bit
            # exponent's worth of big integers to reach infinity)
            lo, hi = _log2_bounds(abs(self._m), self._e)
            t = _beyond(min(n * lo, n * hi), max(n * lo, n * hi), self._m < 0 and n % 2 == 1)
            if t is not None:
                return RealNumberMP(R, *t)
            # correctly rounded, by bracketed binary powering (any n)
            m, e = _pow_round(self._m, self._e, n, R._prec, R._rnd)
            return RealNumberMP(R, m, e)
        if isinstance(n, RealNumberMP) and n._m == 0 and not n._special:
            return R(1)
        x = self
        y = n if isinstance(n, RealNumberMP) else R(n)
        if x._m < 0:
            # a negative real to a real power: complex
            return ComplexField(R._prec)(x) ** ComplexField(R._prec)(y)
        if x._special or y._special or not x._m or x == 1:
            return (y * x.log()).exp()
        # exp(y log x), correctly rounded (Ziv): an error d in y log x is a
        # relative error d in the power, so y log x is computed with as many
        # more bits as its magnitude has (beyond 2^80 the power is past any
        # exponent and rounds to an infinity or zero)
        # (log2 |y log x| <= log2 |y| + log2 (|exponent of x| + 1), summed
        # rather than multiplied: |y| may be near the largest double)
        yf = abs(float(y))
        lx = abs(x._e + abs(x._m).bit_length()) + 1
        mag = min(80, max(0, math.ceil(math.log2(yf) + math.log2(lx)) + 2)) if 0 < yf < float("inf") else 80

        def fn(F):
            H = RealField(F._prec + mag)
            return F((H(y) * H(x).log()).exp())

        def exact(cm, ce):
            # x^y == c, y = n/d (d a power of 2)  <=>  c^d == x^n
            nd = _dyadic_ratio(y._m, y._e)
            if nd is None or cm <= 0:
                return None
            return _pow_eq(_odd2(cm, 1, ce), nd[1], _odd2(x._m, 1, x._e), nd[0])
        return _ziv_eval(R, fn, limit=4096, overflow=True, exact=exact)

    def __rpow__(self, b):
        return self._R(b) ** self

    # ---- comparison
    def _cmpq(self, o):
        """The sign of self - o, "nan" when unordered, None when o is not a
        number; infinities by their sign (a finite number, however large,
        is below +infinity: no float conversion)."""
        o = _rr_big_mp(o) or o
        if isinstance(o, RealNumberMP):
            if o._special or self._special:
                return _cmp_special(self._special, o._special)
            return _cmp_dyadic(self._m, self._e, o._m, o._e, 1)
        if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
            return _cmp_special(self._special, "nan" if o != o else ("+inf" if o > 0 else "-inf"))
        try:
            b = _F(o) if not isinstance(o, float) else _F(o)
        except (TypeError, ValueError):
            return None
        if self._special:
            return _cmp_special(self._special, None)
        return _cmp_dyadic(self._m, self._e, b.numerator, 0, b.denominator)

    def __eq__(self, o):
        if self._special == "nan":
            return False
        c = self._cmpq(o)
        return NotImplemented if c is None else (c != "nan" and c == 0)

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    def __lt__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else (c != "nan" and c < 0)

    def __le__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else (c != "nan" and c <= 0)

    def __gt__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else (c != "nan" and c > 0)

    def __ge__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else (c != "nan" and c >= 0)

    # ---- integer parts
    def floor(self):
        """The greatest integer at most self.

        EXAMPLES::

            sage: RealField(100)(-2.5).floor(), RealField(100)(2.5).ceil()
            (-3, 3)
        """
        return _sa().Integer(self._floor())

    def _floor(self):
        """floor(m 2^e), exactly (an integer of at most 2^20 bits)."""
        if self._special:
            raise ValueError("cannot convert %s to an integer" % self)
        m, e = self._m, self._e
        if e >= 0:
            if e > _EXACT_BITS:
                raise NotImplementedError("the integer part of a real number with binary exponent %d (beyond 2^20) is not available in sagebrush" % (e + abs(m).bit_length()))
            return m << e
        if -e > abs(m).bit_length():
            return 0 if m >= 0 else -1
        return m >> -e

    def ceil(self):
        """The least integer at least self.

        EXAMPLES::

            sage: RealField(100)(2.1).ceil()
            3
        """
        return _sa().Integer(-(-self)._floor())

    ceiling = ceil

    def round(self):
        """The nearest integer (halves to even).

        EXAMPLES::

            sage: RealField(100)(2.5).round(), RealField(100)(-2.5).round(), RealField(100)(3.5).round()
            (2, -2, 4)
        """
        # (halves to even: floor(x + 1/2), less 1 at an exact odd tie)
        m, e = self._m, self._e
        if self._special or e >= 0:
            return _sa().Integer(self._floor())
        if -e > abs(m).bit_length() + 1:
            return _sa().Integer(0)
        f = (2 * m + (1 << -e)) >> (1 - e)
        if (2 * m + (1 << -e)) % (1 << (1 - e)) == 0 and f % 2:
            f -= 1
        return _sa().Integer(f)

    def trunc(self):
        """The integer part.

        EXAMPLES::

            sage: RealField(100)(-2.7).trunc()
            -2
        """
        return _sa().Integer(self._floor() if self._m >= 0 else -(-self)._floor())

    def frac(self):
        """self minus its integer part.

        EXAMPLES::

            sage: RealField(20)(2.75).frac()
            0.75000
        """
        if not self._special and self._e >= 0:
            return self._R(0)
        return self - self._R(int(self.trunc()))

    def is_integer(self):
        """Whether an integer.

        EXAMPLES::

            sage: RealField(20)(3).is_integer(), RealField(20)(2.5).is_integer()
            (True, False)
        """
        if self._special:
            return False
        m, e = self._m, self._e
        if e >= 0 or m == 0:
            return True
        return -e <= abs(m).bit_length() and m % (1 << -e) == 0

    def ulp(self):
        """The unit in the last place.

        EXAMPLES::

            sage: RealField(20)(1).ulp()
            1.9073e-6
        """
        return RealNumberMP(self._R, 1 << (self._R._prec - 1), self._e - self._R._prec + 1)

    def nextabove(self):
        """The next representable number above.

        EXAMPLES::

            sage: RealField(3)(1).nextabove()
            1.2
        """
        return self._R._fixed((self._m + 1), -self._e) if self._m else self._R(0)

    # ---- functions
    def sqrt(self, extend=True, all=False):
        """The square root (complex for negative numbers).

        EXAMPLES::

            sage: RealField(100)(2).sqrt(), RealField(30)(-4).sqrt()
            (1.4142135623730950488016887242, 2.0000000*I)
        """
        R = self._R
        if self._m < 0:
            if not extend:
                raise ValueError("negative number has no real square root")
            r = (-self).sqrt()
            return ComplexNumberMP(ComplexField(R._prec), R(0), r)
        if self._m == 0:
            return self
        m, e = self._m, self._e
        if e % 2:
            m <<= 1
            e -= 1
        p = R._prec
        shift = max(0, 2 * p + 4 - m.bit_length())
        if shift % 2:
            shift += 1
        s = math.isqrt(m << shift)
        exact = s * s == (m << shift)
        # s 2^((e - shift)/2), with a sticky bit for the rounding
        mm = 2 * s + (0 if exact else 1)
        mo, eo = _round_q(mm, 1, p, R._rnd, (e - shift) // 2 - 1)
        return RealNumberMP(R, mo, eo)

    def _fix(self, W):
        return _fx(self._m, self._e, W)

    def _W(self, extra=30):
        return self._R._prec + extra + max(0, self._e + abs(self._m).bit_length())

    def _nan(self):
        return RealNumberMP(self._R, 0, 0, "nan")

    def _mag(self):
        """floor(log2 |self|) + 1 (self nonzero and finite)."""
        return self._e + abs(self._m).bit_length()

    def _small(self, name):
        """The correctly rounded name(self) when self is so small that the
        function is x or 1 to far below the last place, else None:
        f(x) = x (1 + c x^2 + ...) or 1 + c x^2 + ... (exp: 1 + x + ...),
        so the value is x or 1 nudged by the sign of c x."""
        if self._special or not self._m:
            return None
        R, E = self._R, self._mag()
        p = R._prec
        if name in _ODD:
            if E > -(p // 2) - 4:
                return None
            d = _ODD[name] if self._m > 0 else -_ODD[name]
            return _nudge(R, self._m, self._e, d)
        if name == "exp":
            if E > -(p + 3):
                return None
            return _nudge(R, 1, 0, 1 if self._m > 0 else -1)
        if E > -(p // 2) - 4:
            return None
        return _nudge(R, 1, 0, _EVEN[name])

    def exp(self):
        """e^self.

        EXAMPLES::

            sage: RealField(100)(1).exp()
            2.7182818284590452353602874714
            sage: RealField(100)(10^6).exp(), RealField(100)(2^70).exp()
            (3.0332153968020875450864021414e434294, +infinity)
        """
        t = self._small("exp")
        if t is not None:
            return t
        R = self._R
        if self._special:
            return {"+inf": self, "-inf": R(0)}.get(self._special, self._nan())
        if self._m == 0:
            return R(1)
        mag = self._e + abs(self._m).bit_length()
        if mag > 9:
            # (|x| >= 512: by range reduction, not a fixed-point series with
            # |x| / log 2 more bits, which took minutes for gamma(10^6))
            if mag >= 64:
                # |x| >= 2^63 > EMAX log 2: overflow, or underflow
                return RealNumberMP(R, 1, _EMAX + 8) if self._m > 0 else RealNumberMP(R, 1, _EMIN - 8)
            return _exp_big(self, R)
        # the result has about |x|/ln 2 integer bits: enough fraction bits
        W = R._prec + 30 + max(0, int(abs(float(self)) * 1.4427) + 2)
        return R._ziv(lambda W: _exp_fx(self._fix(W), W), W)

    def log(self, base=None):
        """The natural logarithm (or to the given base).

        EXAMPLES::

            sage: RealField(100)(2).log(), RealField(30)(8).log(2)
            (0.69314718055994530941723212146, 3.0000000)
            sage: RealField(100)(1/3).log(10), RealField(100)(1000).log(10)
            (-0.47712125471966243729502790325, 3.0000000000000000000000000000)

        An exact result is exact in every rounding mode (Sage divides two
        rounded logarithms: 100.00000000000000000000000001 here)::

            sage: RealField(100, rnd='RNDA')(2^-100).log(1/2)  # sagebrush only
            100.00000000000000000000000000
        """
        R = self._R
        if self._special:
            return self if self._special == "+inf" else self._nan()
        if self._m <= 0:
            if self._m == 0:
                return RealNumberMP(R, 0, 0, "-inf")
            return ComplexField(R._prec)(self).log() if base is None else ComplexField(R._prec)(self).log() / R(base).log()
        # log(1 + d) is about d: fixed point needs -log2|d| more bits for the
        # relative precision (log(1 + 2^-75) to 100 bits)
        E = self._e + self._m.bit_length()
        if E < 0 or E > 2:
            # far from 1: no cancellation
            extra = 0
        else:
            d = self._q() - 1
            if d == 0:
                return R(0) if base is None else R(0)
            extra = max(0, d.denominator.bit_length() - abs(d.numerator).bit_length() + 1)
        W = R._prec + 30 + extra
        if base is not None:
            # log x / log b, rounded once (it rounded twice: log10(1/3)
            # was 1 ulp off); an exact power b^k is k
            k = _exact_log(self, base)
            if k is not None:
                return R(k)
            def exact(cm, ce):
                # log_b x == c = n/d  <=>  x^d == b^n
                if cm == 0:
                    return self == 1
                nd = _dyadic_ratio(cm, ce)
                b = _rr_big_mp(base) or base
                if nd is None:
                    return None
                if isinstance(b, RealNumberMP):
                    if b._special or b._m <= 0:
                        return None
                    bt = _odd2(b._m, 1, b._e)
                else:
                    try:
                        bq = _F(b)
                    except (TypeError, ValueError):
                        return None
                    if bq <= 0:
                        return None
                    bt = _odd2(bq.numerator, bq.denominator)
                return _pow_eq(_odd2(self._m, 1, self._e), nd[1], bt, nd[0])
            return _ziv_eval(R, lambda F: F(self).log() / F(base).log(), limit=4096, exact=exact)
        return R._ziv(lambda W: _log_fx(self._m, self._e, W), W)

    ln = log

    def log2(self):
        """The logarithm to base 2.

        EXAMPLES::

            sage: RealField(30)(8).log2()
            3.0000000
        """
        return self.log(2)

    def log10(self):
        """The logarithm to base 10.

        EXAMPLES::

            sage: RealField(30)(1000).log10()
            3.0000000
        """
        return self.log(10)

    def _trig_W(self):
        # tiny arguments: sin x is about x, so -log2|x| more fixed-point
        # bits keep the relative precision (sin(2^-300) is not 0)
        if self._m and not self._special and self._mag() > _TRIG_MAX_MAG:
            # (reducing x mod pi needs pi to as many bits as x has before
            # the point: seconds at 2^15, minutes at 2^17)
            raise NotImplementedError("the sine and cosine of a number of magnitude 2^%d (above 2^%d) are not available in sagebrush yet"
                                      % (self._mag(), _TRIG_MAX_MAG))
        return self._R._prec + 30 + (max(0, -self._mag()) if self._m else 0)

    def _trig(self):
        W = self._trig_W()
        return _sincos_fx(self._fix(W), W), W

    def sin(self):
        """The sine.

        EXAMPLES::

            sage: RealField(100)(1).sin()
            0.84147098480789650665250232163
        """
        t = self._small("sin")
        if t is not None:
            return t
        if self._special:
            return self._nan()
        if self._m == 0:
            return self
        W = self._trig_W()
        return self._R._ziv(lambda W: _sincos_fx(self._fix(W), W)[0], W)

    def cos(self):
        """The cosine.

        EXAMPLES::

            sage: RealField(100)(1).cos()
            0.54030230586813971740093660744
        """
        t = self._small("cos")
        if t is not None:
            return t
        if self._special:
            return self._nan()
        if self._m == 0:
            return self._R(1)
        W = self._trig_W()
        return self._R._ziv(lambda W: _sincos_fx(self._fix(W), W)[1], W)

    def tan(self):
        """The tangent.

        EXAMPLES::

            sage: RealField(100)(1).tan()
            1.5574077246549022305069748075
        """
        t = self._small("tan")
        if t is not None:
            return t
        if self._special:
            return self._nan()
        if self._m == 0:
            return self
        (s, c), W = self._trig()
        return self._R(_F(s, c))

    def sec(self):
        """The secant.

        EXAMPLES::

            sage: RealField(100)(1).sec()
            1.8508157176809256179117532414
        """
        return 1 / self.cos()

    def csc(self):
        """The cosecant.

        EXAMPLES::

            sage: RealField(100)(1).csc()
            1.1883951057781212162615994524
        """
        return 1 / self.sin()

    def cot(self):
        """The cotangent.

        EXAMPLES::

            sage: RealField(100)(1).cot()
            0.64209261593433070300641998659
        """
        if self._special:
            return self._nan()
        (s, c), W = self._trig()
        return self._R(_F(c, s))

    def arctan(self):
        """The arctangent.

        EXAMPLES::

            sage: RealField(100)(1).arctan()
            0.78539816339744830961566084582
        """
        t = self._small("arctan")
        if t is not None:
            return t
        R = self._R
        if self._special:
            return {"+inf": R.pi() / 2, "-inf": -R.pi() / 2}.get(self._special, self._nan())
        if self._m == 0:
            return self
        if self._mag() > R._prec + 10:
            # pi/2 - 1/x + 1/(3 x^3) - ...: the cubic term is far below
            sgn = 1 if self._m > 0 else -1
            a = abs(self)
            return _ziv_eval(R, lambda F: sgn * (F.pi() / 2 - 1 / F(a)))
        W = R._prec + 30 + max(0, -(self._e + abs(self._m).bit_length()))
        return R._ziv(lambda W: _atan_fx(self._fix(W), W), W)

    atan = arctan

    def arcsin(self):
        """The arcsine.

        EXAMPLES::

            sage: RealField(100)(1/2).arcsin()
            0.52359877559829887307710723055
            sage: RealField(100)(5).arcsin()
            NaN
        """
        t = self._small("arcsin")
        if t is not None:
            return t
        R = self._R
        if self._special:
            return self._nan()
        c = abs(self)._cmpq(1)
        if c > 0:
            # (outside [-1, 1]: NaN, as Sage's real arcsin)
            return self._nan()
        if c == 0:
            return R.pi() / 2 * (1 if self._m > 0 else -1)
        H = RealField(R._prec + 30)
        x = H(self)
        return R(_to_real(H, x / (1 - x * x).sqrt()).arctan())

    asin = arcsin

    def arccos(self):
        """The arccosine.

        EXAMPLES::

            sage: RealField(100)(1/2).arccos()
            1.0471975511965977461542144611
        """
        R = self._R
        if self._special or abs(self)._cmpq(1) > 0:
            # (outside [-1, 1]: NaN, as Sage)
            return self._nan()
        H = RealField(R._prec + 30)
        return R(H.pi() / 2 - H(self).arcsin())

    acos = arccos

    def _arctan2(self, x):
        """atan2(self, x)."""
        R = self._R
        H = RealField(R._prec + 30)
        y, x = H(self), H(x)
        if x._m == 0:
            if y._m == 0:
                return R(0)
            return R(H.pi() / 2 * (1 if y._m > 0 else -1))
        a = (y / x).arctan()
        if x._m < 0:
            a = a + H.pi() if y._m >= 0 else a - H.pi()
        return R(a)

    def sinh(self):
        """The hyperbolic sine.

        EXAMPLES::

            sage: RealField(100)(1).sinh()
            1.1752011936438014568823818506
        """
        t = self._small("sinh")
        if t is not None:
            return t
        if self._special or self._m == 0:
            return self  # (sinh of +-oo and nan is itself)
        big = self._big_hyp()
        if big is not None:
            return big
        H = self._hyp()
        t = H(self).exp()
        return self._R((t - 1 / t) / 2)

    def _big_hyp(self, even=False):
        """sinh (cosh if even) for |x| >= 512 and |x| > p + 64: +-e^|x| / 2,
        the other exponential below 2^-(2.88 (p + 64)) relative, rounded
        once with the halving inside (exp(x) / 2 overflowed first at the top
        of the range), overflow by the field's rounding mode."""
        R = self._R
        if self._mag() <= 9 or abs(self)._cmpq(R._prec + 64) <= 0:
            return None
        sign = 1 if (even or self._m > 0) else -1
        if self._mag() >= 64:
            return RealNumberMP(R, sign, _EMAX + 8)
        return _exp_big(abs(self), R, shift=-1, sign=sign)

    def cosh(self):
        """The hyperbolic cosine.

        EXAMPLES::

            sage: RealField(100)(1).cosh()
            1.5430806348152437784779056208

        Near the top of the exponent range cosh x is e^x/2 to far below its
        last place, finite whenever that is (Sage gives +infinity for this
        x, at which its sinh is finite: e^x/2 is 0.59 times the largest
        100-bit number)::

            sage: x = RealField(100)(878668439483319573475365403401) / 2^38
            sage: x.cosh() == x.sinh(), x.cosh().is_infinity()  # sagebrush only (Sage: False, True)
            (True, False)
        """
        t = self._small("cosh")
        if t is not None:
            return t
        if self._special:
            return self._nan() if self._special == "nan" else RealNumberMP(self._R, 0, 0, "+inf")
        big = self._big_hyp(even=True)
        if big is not None:
            return big
        H = RealField(self._R._prec + 30)
        t = H(self).exp()
        return self._R((t + 1 / t) / 2)

    def tanh(self):
        """The hyperbolic tangent.

        EXAMPLES::

            sage: RealField(100)(1).tanh()
            0.76159415595576488811945828260
        """
        t = self._small("tanh")
        if t is not None:
            return t
        if self._m == 0 and not self._special:
            return self
        if self._special:
            return {"+inf": self._R(1), "-inf": self._R(-1)}.get(self._special, self._nan())
        if self._mag() > 40:
            # 1 - 2 e^(-2|x|): between 1 - 2^-(p+12) and 1, rounded as that is
            p = self._R._prec
            v = RealField(p + 20)(1) - RealField(p + 20)(_F(1, 1 << (p + 12)))
            return self._R(v if self._m > 0 else -v)
        H = self._hyp()
        t = H(2 * H(self)).exp()
        return self._R((t - 1) / (t + 1))

    def arcsinh(self):
        """The inverse hyperbolic sine.

        EXAMPLES::

            sage: RealField(100)(1).arcsinh()
            0.88137358701954302523260932498
        """
        t = self._small("arcsinh")
        if t is not None:
            return t
        if self._special or self._m == 0:
            return self
        if self._m < 0:
            # odd: x + sqrt(x^2 + 1) cancels for x < 0 (asinh(-2^300) was -oo)
            return self._R(-(RealField(self._R._prec + 30)(-self).arcsinh()))
        H = self._hyp()
        x = H(self)
        return self._R((x + (x * x + 1).sqrt()).log())

    def arccosh(self):
        """The inverse hyperbolic cosine.

        EXAMPLES::

            sage: RealField(100)(2).arccosh()
            1.3169578969248167086250463473
        """
        if self._special == "+inf":
            return self
        if self._special or self._cmpq(1) < 0:
            # (below 1: NaN, as Sage)
            return self._nan()
        H = RealField(self._R._prec + 30)
        x = H(self)
        # (x - 1)(x + 1): x^2 - 1 cancels near 1
        return self._R((x + ((x - 1) * (x + 1)).sqrt()).log())

    def arctanh(self):
        """The inverse hyperbolic tangent.

        EXAMPLES::

            sage: RealField(100)(1/2).arctanh()
            0.54930614433405484569762261846
        """
        t = self._small("arctanh")
        if t is not None:
            return t
        if self._m == 0 and not self._special:
            return self
        if self._special:
            return self._nan()
        c = abs(self)._cmpq(1)
        if c > 0:
            # (outside [-1, 1]: NaN, as Sage)
            return self._nan()
        if c == 0:
            return RealNumberMP(self._R, 0, 0, "+inf" if self._m > 0 else "-inf")
        H = self._hyp()
        x = H(self)
        return self._R(((1 + x) / (1 - x)).log() / 2)

    def _hyp(self):
        """The working field for a hyperbolic function: -log2|x| more bits for
        tiny x, whose 1 + x or e^x - e^-x cancels (sinh(2^-300) was 0, the
        systematic review's R2-NUM-F9)."""
        return RealField(self._R._prec + 30 + (max(0, -self._mag()) if self._m else 0))

    def nth_root(self, n):
        """The real n-th root.

        EXAMPLES::

            sage: RealField(100)(2).nth_root(3)
            1.2599210498948731647672106073
        """
        n = int(n)
        if self._m < 0 and n % 2:
            return -((-self).nth_root(n))
        H = RealField(self._R._prec + 30)
        return self._R((H(self).log() / n).exp())

    def gamma(self):
        """The gamma function (by Stirling's series after shifting).

        EXAMPLES::

            sage: RealField(53)(5).gamma(), RealField(100)(1/2).gamma()
            (24.0000000000000, 1.7724538509055160272981674833)
            sage: RealField(100)(10^6).gamma()
            8.2639316883312400623766461032e5565702
        """
        R = self._R
        if self._special:
            # Gamma(+infinity) = +infinity; -infinity and NaN give NaN
            return self if self._special == "+inf" else self._nan()
        if not self._special and self._m and self._mag() < -(R._prec + 40):
            # Gamma(x) = 1/x - euler_gamma + O(x), the O(x) term below 2^-2(p+40)
            # relative.  When 1/x is a power of 2 it is a rounding boundary
            # and the value lies just below it (by about euler_gamma, far
            # below its last place): it is rounded from that, analytically,
            # not by working precision growing toward the input's exponent.
            # Otherwise 1/x is not dyadic, at relative distance >= 2^-(2p+1)
            # from every boundary, and the checked evaluation settles.
            a = abs(self._m)
            if a & (a - 1) == 0:
                t = a.bit_length() - 1
                return _nudge(R, 1 if self._m > 0 else -1, -(self._e + t), -1)
            return _ziv_eval(R, lambda F: 1 / F(self) - F.euler_constant(), overflow=True)
        v = _gamma(self._q(), R._prec)
        if not self._special and getattr(v, "_special", None) in ("+inf", "-inf"):
            # the working field overflowed: the value is beyond the range,
            # rounded in this field's direction (the largest number toward 0)
            return RealNumberMP(R, 1 if v._special == "+inf" else -1, _EMAX + 8)
        if (not self._special and self._m < 0 and isinstance(v, RealNumberMP)
                and not v._special and (not v._m or v._mag() < _EMIN + 64)):
            # the reflection Gamma(x) = pi / (sin(pi x) Gamma(1 - x)) with
            # Gamma(1 - x) overflowed (a zero: Gamma has none) or nearly so:
            # |Gamma(x)| is near or below 2^EMIN, where the working field's
            # value is not reliable; it is taken from log |Gamma(x)|
            if (1 - self)._cmpq(128) < 0:
                raise NotImplementedError("Gamma(%s) at the bottom of the exponent range is not available in sagebrush yet" % self)
            return _gamma_reflected(self)
        return R(v)

    def log_gamma(self):
        """The logarithm of the gamma function.

        EXAMPLES::

            sage: RealField(100)(10).log_gamma()
            12.801827480081469611207717875
            sage: RealField(100)(10^6).log_gamma()
            1.2815504569147611659976971785e7
            sage: R = RealField(100, rnd='RNDZ'); x = R(2)^(2^62 - 2); x.log_gamma() / x
            1.9999999999999999999999999999
            sage: R(oo).log_gamma(), R(oo).gamma(), R(-oo).gamma()
            (+infinity, +infinity, NaN)
        """
        R = self._R
        if self._special == "+inf" or self._special == "nan":
            return self
        if self._special == "-inf":
            raise NotImplementedError("log_gamma(-infinity) is not available in sagebrush yet (Sage raises an error too)")
        if not self._special and self._m > 0:
            E = self._mag()
            # (log Gamma is finite for every finite x > 0; the working
            # computation returns +infinity only when it proves the result
            # beyond the range, which is then rounded as overflow:
            # log_gamma(2^(2^62 - 2)) is the largest number in RNDZ and RNDD,
            # as in Sage; the working field always has >= p + 40 bits)
            if E > 7 and _log_gamma_stirling(RealField(R._prec + 40)(self)) is not None:
                def fn(F):
                    v = _log_gamma_stirling(F(self))
                    if v is not None:
                        # (finite, or +infinity only as a proof that the
                        # result overflows: _log_gamma_stirling)
                        return v
                    # (Stirling's 19 terms fall short at this working
                    # precision; an infinite Gamma(x) would say nothing
                    # about log Gamma(x))
                    g = F(self).gamma()
                    if g._special:
                        raise NotImplementedError("log_gamma(%s) at this precision is not available in sagebrush yet" % self)
                    return g.log()
                return _ziv_eval(R, fn, overflow=True)
            if E < -(R._prec + 40):
                # -log x - euler_gamma x + ...: the linear term is far below
                return _ziv_eval(R, lambda F: -F(self).log(), overflow=True)
        return self.gamma().log()

    def __round__(self, n=None):
        return round(float(self), n) if n is not None else int(self.round())

    def __lshift__(self, n):
        return RealNumberMP(self._R, self._m, self._e + int(n))

    def __rshift__(self, n):
        return RealNumberMP(self._R, self._m, self._e - int(n))

    def real(self):
        """The number itself.

        EXAMPLES::

            sage: RealField(30)(2).real()
            2.0000000
        """
        return self

    def imag(self):
        """0.

        EXAMPLES::

            sage: RealField(30)(2).imag()
            0
        """
        return _sa().Integer(0)

    def conjugate(self):
        """The number itself.

        EXAMPLES::

            sage: RealField(30)(2).conjugate()
            2.0000000
        """
        return self


def _arith(a, b, op, R):
    """a op b in the field R, rounded once."""
    if a._special or b._special:
        return _special_op(a, b, op, R)
    p, rnd = R._prec, R._rnd
    if op in "+-":
        mb = b._m if op == "+" else -b._m
        if a._m == 0:
            m, e = _round_int(mb, b._e, p, rnd) if mb else (0, 0)
            return RealNumberMP(R, m, e)
        if mb == 0:
            m, e = _round_int(a._m, a._e, p, rnd)
            return RealNumberMP(R, m, e)
        ea, eb = a._e, b._e
        ta = ea + a._m.bit_length() if a._m > 0 else ea + (-a._m).bit_length()
        tb = eb + abs(mb).bit_length()
        if ta - tb > p + 8 or tb - ta > p + 8:
            # one operand is far below the other's last bit: a sticky bit
            if ta > tb:
                big, be, small = a._m, ea, mb
            else:
                big, be, small = mb, eb, a._m
            shift = p + 10 - abs(big).bit_length()
            M = (big << (shift + 3)) + (1 if small > 0 else -1)
            m, e = _round_q(M, 1, p, rnd, be - shift - 3)
            return RealNumberMP(R, m, e)
        e = min(ea, eb)
        M = (a._m << (ea - e)) + (mb << (eb - e))
        if M == 0:
            return RealNumberMP(R, 0, 0)
        m, e2 = _round_q(M, 1, p, rnd, e)
        return RealNumberMP(R, m, e2)
    if op == "*":
        M = a._m * b._m
        if M == 0:
            return RealNumberMP(R, 0, 0)
        m, e = _round_q(M, 1, p, rnd, a._e + b._e)
        return RealNumberMP(R, m, e)
    if op == "/":
        if b._m == 0:
            if a._m == 0:
                return RealNumberMP(R, 0, 0, "nan")
            return RealNumberMP(R, 0, 0, "+inf" if a._m > 0 else "-inf")
        n, d = a._m, b._m
        if d < 0:
            n, d = -n, -d
        if n == 0:
            return RealNumberMP(R, 0, 0)
        m, e = _round_q(n, d, p, rnd, a._e - b._e)
        return RealNumberMP(R, m, e)
    raise ValueError(op)


def _digits(prec):
    return max(2, int(math.floor((prec - 1) * _LOG10_2 + 1e-12)))


def _format(q, D, no_sci=None, rnd="N"):
    """The rational q printed with D significant digits, as Sage prints a
    RealNumber (rounded to nearest, or toward +infinity "U" / -infinity
    "D")."""
    if q == 0:
        return "0." + _zeros(D)
    neg = q < 0
    a = -q if neg else q
    E = math.floor(math.log10(a.numerator) - math.log10(a.denominator)) if a.numerator < 10 ** 300 and a.denominator < 10 ** 300 else len(str(a.numerator)) - len(str(a.denominator))
    # correct E: 10^E <= a < 10^(E+1)
    while _F(10) ** E > a:
        E -= 1
    while _F(10) ** (E + 1) <= a:
        E += 1
    k = D - 1 - E
    v = a * _F(10) ** k
    N = math.floor(v)
    r = v - N
    if rnd == "N":
        if r > _F(1, 2) or (r == _F(1, 2) and N % 2):
            N += 1
    elif r and ((rnd == "U") != neg):
        N += 1
    if N >= 10 ** D:
        N //= 10
        E += 1
    s = str(N)
    sign = "-" if neg else ""
    if no_sci is False or (no_sci is None and (E >= 6 or E <= -6)) or (no_sci is not True and E > 300):
        return sign + s[0] + "." + s[1:] + "e" + str(E)
    if E >= 0:
        if E + 1 >= D:
            return sign + s + _zeros(E + 1 - D) + "."
        return sign + s[:E + 1] + "." + s[E + 1:]
    return sign + "0." + _zeros(-E - 1) + s


def _gamma_reflected(x):
    """Gamma(x) for a negative non-integer x with 1 - x >= 2^7, correctly
    rounded in x's field, where the reflection Gamma(x) = pi / (sin(pi x)
    Gamma(1 - x)) cannot be formed: Gamma(1 - x) is beyond the exponent
    range while Gamma(x) is near or below its bottom.  Instead
    L = log |Gamma(x)| = log pi - log |sin(pi x)| - log Gamma(1 - x)
    (Stirling), and Gamma(x) = s 2^k exp(r) with k = floor(L / log 2),
    r = L - k log 2 and the sign s = (-1)^ceil(-x).  With |L| < 2^B, at W
    bits L is within 2^(B - W + 8) (Stirling's sum to a few units of its
    last place, the logarithms to a few of theirs) and k log 2 within
    2^(B - W + 1), so exp(r) is within 2^-(W - B - 12) relative; the value
    is accepted when both ends of that interval round alike in x's field
    (below the range, decided on their exact values), else W grows."""
    R = x._R
    p = R._prec
    fl = x._floor()
    sign = 1 if (-fl) % 2 == 0 else -1
    # |L| <= (1 - x) log(1 - x) + log(pi / |sin(pi x)|) < 2^B, 1 - x < 2^n
    n = (-fl).bit_length() + 1
    B = n + n.bit_length() + 1
    # bits that hold x, 1 - x and the fractional part of x exactly
    exact = abs(x._m).bit_length() + abs(fl).bit_length() + 64
    G = 64
    while G <= 1 << 14:
        F = RealField(max(p + B + G, exact))
        X = F(x)
        lg = _log_gamma_stirling(1 - X)
        if lg is None or lg._special:
            # (an infinite log Gamma(1 - x) would need |x| near 2^(2^62))
            break
        # |sin(pi x)| = sin(pi f), f = min(frac(x), 1 - frac(x)) (no
        # cancellation near pi)
        f = X - F(fl)
        if (2 * f)._cmpq(1) > 0:
            f = 1 - f
        L = F.pi().log() - (F.pi() * f).sin().log() - lg
        L2 = F(2).log()
        k = int((L / L2).floor())
        y = (L - F(k) * L2).exp()
        m, e = y._m, y._e
        g = F._prec - B - 12
        t = abs(m) >> g if g > 0 else abs(m)
        lo = _round_int(sign * (abs(m) - t - 1), e + k, p, R._rnd)
        hi = _round_int(sign * (abs(m) + t + 1), e + k, p, R._rnd)
        if lo == hi:
            return RealNumberMP(R, lo[0], lo[1])
        G *= 2
    raise NotImplementedError("Gamma(%s) at the bottom of the exponent range is not available in sagebrush yet" % x)


def _log_gamma_stirling(x):
    """log Gamma(x) for x >= 128 in x's field F, to a few units in the last
    place: x (log x - 1) - (log x)/2 + log(2 pi)/2 + sum B_2k / (2k (2k-1)
    x^(2k-1)), summed while the terms matter (for x > 0 the series' error is
    below its first omitted term, DLMF 5.11.ii); None when 19 terms do not
    get below the last place.

    Only A = x (log x - 1) can leave the exponent range (the other terms are
    below 2^63).  (x - 1/2) log x, the former arrangement, could overflow
    while log Gamma(x) is representable.  When A rounds to +infinity at W
    bits, x (log x - 1) >= (1 - 2^(2 - W)) 2^EMAX, so log Gamma(x) >=
    (1 - 2^(2 - W)) 2^EMAX - 2^63, above the largest number of any field of
    at most W - 40 bits plus half its last place: the result overflows,
    and +infinity is returned as that proof (callers at p <= W - 40 bits
    round it as overflow)."""
    F = x.parent()
    L = x.log()
    A = x * (L - 1)
    if A._special:
        return A
    lg = A - L / 2 + (2 * F.pi()).log() / 2
    B = _bernoulli_list(40)
    xp = x
    x2 = x * x
    # (magnitudes compared by binary exponent: lg may be far beyond the
    # double range, log_gamma(2^1015))
    lim = lg._mag() - (F._prec + 4)
    for k in range(1, 20):
        t = F(B[2 * k]) / (F(2 * k * (2 * k - 1)) * xp)
        lg = lg + t
        if t._m == 0 or t._mag() < lim:
            return lg
        xp = xp * x2
    return None


def _gamma(q, prec):
    """Gamma(q) to prec bits, q rational (Stirling's series)."""
    # log Gamma(q) is about q log q: its exponential needs that many more
    # bits (gamma(3^30) lost its last digits at prec + 40)
    big = max(0, abs(q.numerator).bit_length() - q.denominator.bit_length())
    R = RealField(prec + 40 + (big + big.bit_length() + 2 if big > 4 else 0))
    if q.denominator == 1 and q > 0 and q < 3000:
        return math.factorial(int(q) - 1)
    if q <= 0 and q.denominator == 1:
        raise ValueError("gamma has a pole at %s" % q)
    if q < _F(1, 2):
        # reflection: Gamma(q) Gamma(1 - q) = pi / sin(pi q)
        pq = R.pi() * R(q)
        return R.pi() / (pq.sin() * R(_gamma(1 - q, prec + 20)))
    # shift q up to N, then Stirling with Bernoulli numbers
    N = int(prec * 0.35) + 10
    shift = 0
    prod = R(1)
    x = R(q)
    while x._cmpq(N) < 0:
        prod = prod * x
        x = x + 1
        shift += 1
    # log Gamma(x) = (x - 1/2) log x - x + log(2 pi)/2 + sum B_2k / (2k (2k-1) x^(2k-1))
    lg = (x - R(_F(1, 2))) * x.log() - x + (2 * R.pi()).log() / 2
    B = _bernoulli_list(2 * N + 2)
    xp = x
    x2 = x * x
    for k in range(1, N):
        t = R(B[2 * k]) / (R(2 * k * (2 * k - 1)) * xp)
        lg = lg + t
        xp = xp * x2
        if t._m == 0 or t._mag() < -(prec + 45):
            break
    return lg.exp() / prod


_BERN = [_F(1)]


def _bernoulli_list(n):
    """B_0 .. B_n (B_1 = -1/2), by the Akiyama-Tanigawa recurrence."""
    while len(_BERN) <= n:
        m = len(_BERN)
        A = [_F(1, k + 1) for k in range(m + 1)]
        for j in range(m, 0, -1):
            for i in range(j):
                A[i] = (i + 1) * (A[i] - A[i + 1])
        _BERN.append(A[0] if m != 1 else _F(-1, 2))
    return _BERN


# ------------------------------------------------------------------ complex numbers

_CFIELDS = {}


def ComplexField(prec=53, names=None):
    """The field of complex numbers with prec bits of precision.

    EXAMPLES::

        sage: ComplexField(100)
        Complex Field with 100 bits of precision
        sage: ComplexField(100)(1, 2), ComplexField(100)(-2).sqrt()
        (1.0000000000000000000000000000 + 2.0000000000000000000000000000*I, 1.4142135623730950488016887242*I)
    """
    prec = int(prec)
    if prec == 53:
        return _sa().CC
    if prec not in _CFIELDS:
        _CFIELDS[prec] = ComplexField_(prec)
    return _CFIELDS[prec]


class ComplexField_:
    """A complex field of a given precision.

    EXAMPLES::

        sage: C = ComplexField(30); C, C.gen()
        (Complex Field with 30 bits of precision, 1.0000000*I)
    """

    _is_generic_field = True
    _numeric = True


    def __init__(self, prec):
        self._prec = prec
        self._R = RealField(prec) if prec != 53 else RealField_(53, "RNDN")

    def __repr__(self):
        return "Complex Field with %d bits of precision" % self._prec

    def __eq__(self, o):
        return isinstance(o, ComplexField_) and o._prec == self._prec

    def __hash__(self):
        return hash(("ComplexField", self._prec))

    def precision(self):
        """The precision in bits.

        EXAMPLES::

            sage: ComplexField(30).precision()
            30
        """
        return _sa().Integer(self._prec)

    prec = precision

    def gen(self, i=0):
        """I.

        EXAMPLES::

            sage: ComplexField(30).gen()
            1.0000000*I
        """
        return ComplexNumberMP(self, self._R(0), self._R(1))

    def _real_field(self):
        return self._R

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: ComplexField(30).is_field()
            True
        """
        return True

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: ComplexField(30).is_exact()
            False
        """
        return False

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: ComplexField(30).characteristic()
            0
        """
        return _sa().Integer(0)

    def pi(self):
        """pi as a complex number.

        EXAMPLES::

            sage: ComplexField(30).pi()
            3.1415927
        """
        return ComplexNumberMP(self, self._R.pi(), self._R(0))

    def zero(self):
        """0.

        EXAMPLES::

            sage: ComplexField(30).zero()
            0.00000000
        """
        return self(0)

    def __call__(self, re=0, im=None):
        """A complex number from a number, or real and imaginary parts.

        EXAMPLES::

            sage: C = ComplexField(30); C(1/3), C(1, -2), C(I)
            (0.33333333, 1.0000000 - 2.0000000*I, 1.0000000*I)
        """
        R = self._R
        if im is not None:
            return ComplexNumberMP(self, R(re), R(im))
        x = re
        if isinstance(x, ComplexNumberMP):
            return ComplexNumberMP(self, R(x._re), R(x._im))
        if isinstance(x, complex) or type(x).__name__ == "ComplexNumber":
            z = complex(x)
            return ComplexNumberMP(self, R(z.real), R(z.imag))
        s = getattr(x, "_s", None)
        if s is not None:
            v = evaluate(x, self._prec + 20)
            if isinstance(v, ComplexNumberMP):
                return ComplexNumberMP(self, R(v._re), R(v._im))
            return ComplexNumberMP(self, R(v), R(0))
        if type(x).__name__ in ("AlgebraicNumber", "AlgebraicReal"):
            z = x._approx(int(self._prec * _LOG10_2) + 10)
            return ComplexNumberMP(self, R(z[0]), R(z[1]))
        return ComplexNumberMP(self, R(x), R(0))


class ComplexNumberMP:
    """A complex number of a ComplexField(prec).

    EXAMPLES::

        sage: z = ComplexField(100)(1, 1); z^2, z.abs(), z.arg()
        (2.0000000000000000000000000000*I, 1.4142135623730950488016887242, 0.78539816339744830961566084582)
    """

    __slots__ = ("_C", "_re", "_im")

    def __init__(self, C, re, im):
        self._C, self._re, self._im = C, re, im

    def parent(self):
        """The complex field.

        EXAMPLES::

            sage: ComplexField(30)(1).parent()
            Complex Field with 30 bits of precision
        """
        return self._C

    def prec(self):
        """The precision in bits.

        EXAMPLES::

            sage: ComplexField(30)(1).prec()
            30
        """
        return _sa().Integer(self._C._prec)

    def real(self):
        """The real part.

        EXAMPLES::

            sage: ComplexField(30)(1, 2).real()
            1.0000000
        """
        return self._re

    real_part = real

    def imag(self):
        """The imaginary part.

        EXAMPLES::

            sage: ComplexField(30)(1, 2).imag()
            2.0000000
        """
        return self._im

    imag_part = imag

    def __repr__(self):
        re, im = self._re, self._im
        if im.is_zero():
            return repr(re)
        si = repr(abs(im)) + "*I"
        if re.is_zero():
            return ("-" if im._m < 0 else "") + si
        return "%r %s %s" % (re, "-" if im._m < 0 else "+", si)

    __str__ = __repr__

    def _latex_(self):
        return repr(self).replace("*I", "i")

    def __complex__(self):
        return complex(float(self._re), float(self._im))

    def __hash__(self):
        return hash((self._re, self._im))

    def _c(self, o):
        if isinstance(o, ComplexNumberMP):
            return o
        if getattr(o, "_is_ffmatrix", False):
            # (a matrix answers for itself: converting it into the field
            # recursed, so A / ComplexField(200)(1) was a RecursionError)
            return None
        if isinstance(o, RealNumberMP):
            return ComplexNumberMP(self._C, self._C._R(o), self._C._R(0))
        try:
            return self._C(o)
        except (TypeError, ValueError):
            return None

    def __add__(self, o):
        o = self._c(o)
        if o is None:
            return NotImplemented
        return ComplexNumberMP(self._C, self._re + o._re, self._im + o._im)

    __radd__ = __add__

    def __neg__(self):
        return ComplexNumberMP(self._C, -self._re, -self._im)

    def __sub__(self, o):
        o = self._c(o)
        if o is None:
            return NotImplemented
        return ComplexNumberMP(self._C, self._re - o._re, self._im - o._im)

    def __rsub__(self, o):
        return (-self) + o

    def __mul__(self, o):
        o = self._c(o)
        if o is None:
            return NotImplemented
        H = RealField(self._C._prec + 20)
        a, b, c, d = H(self._re), H(self._im), H(o._re), H(o._im)
        R = self._C._R
        return ComplexNumberMP(self._C, R(a * c - b * d), R(a * d + b * c))

    __rmul__ = __mul__

    def __truediv__(self, o):
        o = self._c(o)
        if o is None:
            return NotImplemented
        H = RealField(self._C._prec + 20)
        a, b, c, d = H(self._re), H(self._im), H(o._re), H(o._im)
        n = c * c + d * d
        R = self._C._R
        return ComplexNumberMP(self._C, R((a * c + b * d) / n), R((b * c - a * d) / n))

    def __rtruediv__(self, o):
        c = self._c(o)
        return NotImplemented if c is None else c / self

    def __eq__(self, o):
        if getattr(o, "_is_ffmatrix", False):
            return NotImplemented  # (the matrix compares: c == A as A == c)
        o = self._c(o)
        return o is not None and self._re == o._re and self._im == o._im

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    def __bool__(self):
        return not (self._re.is_zero() and self._im.is_zero())

    def abs(self):
        """The absolute value.

        EXAMPLES::

            sage: ComplexField(30)(3, 4).abs()
            5.0000000
        """
        H = RealField(self._C._prec + 20)
        a, b = H(self._re), H(self._im)
        return self._C._R((a * a + b * b).sqrt())

    __abs__ = abs

    def norm(self):
        """|self|^2.

        EXAMPLES::

            sage: ComplexField(30)(3, 4).norm()
            25.000000
        """
        return self._re * self._re + self._im * self._im

    def arg(self):
        """The argument in (-pi, pi].

        EXAMPLES::

            sage: ComplexField(30)(0, 1).arg()
            1.5707963
        """
        return self._im._arctan2(self._re)

    argument = arg

    def conjugate(self):
        """The complex conjugate.

        EXAMPLES::

            sage: ComplexField(30)(1, 2).conjugate()
            1.0000000 - 2.0000000*I
        """
        return ComplexNumberMP(self._C, self._re, -self._im)

    def sqrt(self, all=False):
        """The principal square root.

        EXAMPLES::

            sage: ComplexField(30)(-4).sqrt(), ComplexField(30)(0, 2).sqrt()
            (2.0000000*I, 1.0000000 + 1.0000000*I)
        """
        H = RealField(self._C._prec + 20)
        a, b = H(self._re), H(self._im)
        if b.is_zero():
            if a._m >= 0:
                r = ComplexNumberMP(self._C, self._C._R(a.sqrt()), self._C._R(0))
            else:
                r = ComplexNumberMP(self._C, self._C._R(0), self._C._R((-a).sqrt()))
        else:
            m = (a * a + b * b).sqrt()
            x = ((m + a) / 2).sqrt()
            y = ((m - a) / 2).sqrt()
            if b._m < 0:
                y = -y
            r = ComplexNumberMP(self._C, self._C._R(x), self._C._R(y))
        return [r, -r] if all else r

    def exp(self):
        """e^self.

        EXAMPLES::

            sage: ComplexField(100)(0, 1).exp()
            0.54030230586813971740093660744 + 0.84147098480789650665250232163*I
        """
        H = RealField(self._C._prec + 20)
        r = H(self._re).exp()
        b = H(self._im)
        R = self._C._R
        return ComplexNumberMP(self._C, R(r * b.cos()), R(r * b.sin()))

    def log(self):
        """The principal logarithm.

        EXAMPLES::

            sage: ComplexField(30)(-1).log()
            3.1415927*I
        """
        H = RealField(self._C._prec + 20)
        a, b = H(self._re), H(self._im)
        R = self._C._R
        return ComplexNumberMP(self._C, R((a * a + b * b).log() / 2), R(b._arctan2(a)))

    def __pow__(self, n, mod=None):
        C = self._C
        if isinstance(n, int) or type(n).__name__ == "Integer" or (isinstance(n, _F) and n.denominator == 1):
            n = int(n)
            if n < 0:
                return 1 / (self ** (-n))
            r = C(1)
            b = self
            while n:
                if n & 1:
                    r = r * b
                n >>= 1
                if n:
                    b = b * b
            return r
        if not self:
            return C(0)
        w = n if isinstance(n, ComplexNumberMP) else C(n)
        return (w * self.log()).exp()

    def __rpow__(self, b):
        return self._C(b) ** self

    def sin(self):
        """The sine.

        EXAMPLES::

            sage: ComplexField(30)(0, 1).sin()
            1.1752012*I
        """
        H = RealField(self._C._prec + 20)
        a, b = H(self._re), H(self._im)
        R = self._C._R
        return ComplexNumberMP(self._C, R(a.sin() * b.cosh()), R(a.cos() * b.sinh()))

    def cos(self):
        """The cosine.

        EXAMPLES::

            sage: ComplexField(30)(0, 1).cos()
            1.5430806
        """
        H = RealField(self._C._prec + 20)
        a, b = H(self._re), H(self._im)
        R = self._C._R
        return ComplexNumberMP(self._C, R(a.cos() * b.cosh()), R(-(a.sin() * b.sinh())))

    def n(self, prec=None, digits=None):
        """The number in another precision.

        EXAMPLES::

            sage: ComplexField(100)(1, 2).n(20)
            1.0000 + 2.0000*I
        """
        if digits is not None:
            prec = digits_to_prec(digits)
        return ComplexField(prec or 53)(self) if (prec or 53) != 53 else _sa().CC(complex(self))

    numerical_approx = N = n

    def is_real(self):
        """Whether the imaginary part is 0.

        EXAMPLES::

            sage: ComplexField(30)(2).is_real(), ComplexField(30)(0, 1).is_real()
            (True, False)
        """
        return self._im.is_zero()


# ------------------------------------------------------------------ symbolic evaluation

def evaluate(expr, prec, R=None):
    """The value of a constant symbolic expression to prec bits: a
    RealNumberMP, or a ComplexNumberMP if it is not real.

    EXAMPLES::

        sage: from _sage_real import evaluate  # sagebrush only
        sage: evaluate(pi + sqrt(2), 100)  # sagebrush only
        4.5558062159628882872643321075
    """
    if R is None:
        R = RealField(prec) if prec != 53 else RealField_(53, "RNDN")
    v = _ev(expr._s, R, prec)
    return v


def _cplx(v, prec):
    C = ComplexField_(prec) if prec != 53 else ComplexField_(53)
    if isinstance(v, ComplexNumberMP):
        return v
    return ComplexNumberMP(C, v, v._R(0))


def _ev(s, R, prec):
    import _sage_expr
    e = _sage_expr.Expression(s)
    op = e._op()
    tag = op[0]
    if s.startswith("n"):
        num, den = s[1:].rstrip(";").split("/")
        return R(_F(int(num), int(den)))
    if tag == "float":
        return R(_bits_to_float(s[1:].rstrip(";")))
    if tag == "complex":
        body = s[1:].split(";")
        re, im = _F(body[0]), _F(body[1])
        if im == 0:
            return R(re)
        C = ComplexField_(prec)
        return ComplexNumberMP(C, R(re), R(im))
    if tag == "constant":
        name = s[1:]
        W = prec + 20
        if name == "p":
            return R._fixed(_pi(W), W)
        if name == "e":
            return R(1).exp()
        if name == "g":
            return R._fixed(_euler_gamma(W), W)
        if name in ("+", "-"):
            # oo and -oo: RealField(100)(oo) is +infinity, as in Sage
            return RealNumberMP(R, 0, 0, "+inf" if name == "+" else "-inf")
        f = {"pi": "p"}.get(name)
        raise TypeError("cannot evaluate the constant %r" % name)
    args = [_ev(t, R, prec) for t in op[1:]]
    cx = any(isinstance(a, ComplexNumberMP) for a in args)
    if tag == "add":
        r = args[0]
        for a in args[1:]:
            r = (_cplx(r, prec) + _cplx(a, prec)) if (cx) else r + a
        return _simplify(r)
    if tag == "mul":
        r = args[0]
        for a in args[1:]:
            r = (_cplx(r, prec) * _cplx(a, prec)) if cx else r * a
        return _simplify(r)
    if tag == "pow":
        b, x = args
        if op[1] == "ce":
            # e^x is exp(x), as in Sage (not a rounded e to the power x)
            return _simplify(x.exp())
        # an exact rational exponent of a real base
        if not cx:
            xs = op[2]
            if xs.startswith("n"):
                num, den = xs[1:].rstrip(";").split("/")
                q = _F(int(num), int(den))
                if q.denominator == 1:
                    return b ** int(q)
                if b._m >= 0 or q.denominator % 2 == 1:
                    if q.denominator == 2 and b._m >= 0:
                        return b.sqrt() ** q.numerator if q.numerator > 0 else 1 / (b.sqrt() ** -q.numerator)
                    if b._m >= 0:
                        return b ** R(q)
            if b._m >= 0:
                return b ** x
            return _simplify(_cplx(b, prec) ** _cplx(x, prec))
        return _simplify(_cplx(b, prec) ** _cplx(x, prec))
    if tag.startswith("fun:"):
        name = tag[4:]
        a = args[0]
        # the special functions: gamma and log_gamma of real arguments only
        # (the other ones are 53-bit only, from lib/_special.py)
        from _sage_expr import _SPECIAL_NAMES
        if name in _SPECIAL_NAMES and not (name in ("gamma", "log_gamma") and len(args) == 1 and not isinstance(a, ComplexNumberMP)):
            raise NotImplementedError("%s at more than 53 bits is not available in sagebrush yet" % name)
        # log Gamma at negative reals: Sage's branch (the principal log Gamma,
        # -2 pi i k on (-2k - 1, -2k + 1)) is not log(gamma(a)), which is
        # all this precision has
        if name == "log_gamma" and a < 0:
            raise NotImplementedError("log_gamma of a negative real at more than 53 bits is not available in sagebrush yet")
        if name in ("abs",):
            return a.abs() if isinstance(a, ComplexNumberMP) else abs(a)
        if isinstance(a, ComplexNumberMP):
            f = getattr(a, name, None)
            if f is None:
                raise TypeError("cannot evaluate %s numerically" % name)
            return _simplify(f())
        alias = {"arctan": "arctan", "arcsin": "arcsin", "arccos": "arccos", "ln": "log", "gamma": "gamma",
                 "arcsinh": "arcsinh", "arccosh": "arccosh", "arctanh": "arctanh", "sqrt": "sqrt"}
        if name == "log" and len(args) == 2:
            return args[0].log() / args[1].log()
        if name == "arctan2":
            return args[0]._arctan2(args[1])
        if name == "exp":
            return a.exp()
        f = getattr(a, alias.get(name, name), None)
        if f is None:
            raise TypeError("cannot evaluate %s numerically" % name)
        return f()
    raise TypeError("cannot evaluate %r numerically" % (e,))


def _bits_to_float(h):
    """The double with the IEEE bits h (hexadecimal), as a Fraction."""
    b = int(h, 16)
    sign = -1 if b >> 63 else 1
    ex = (b >> 52) & 0x7FF
    man = b & ((1 << 52) - 1)
    if ex == 0:
        return sign * _F(man, 1 << 1074)
    if ex == 0x7FF:
        return float("inf") * sign if not man else float("nan")
    v = _F((1 << 52) + man) * (_F(2) ** (ex - 1075))
    return sign * v


def _simplify(v):
    if isinstance(v, ComplexNumberMP) and v._im.is_zero():
        return v._re
    return v


def N(x, prec=None, digits=None):
    """A numerical approximation to prec bits or digits decimal digits.

    EXAMPLES::

        sage: from _sage_real import N as _N  # sagebrush only
        sage: _N(pi, digits=30)  # sagebrush only
        3.14159265358979323846264338328
    """
    if digits is not None:
        prec = digits_to_prec(digits)
    prec = int(prec or 53)
    s = getattr(x, "_s", None)
    if s is not None:
        v = evaluate(x, prec + 20)
        if isinstance(v, ComplexNumberMP):
            return ComplexField(prec)(v) if prec != 53 else _sa().CC(complex(v))
        return RealField(prec)(v) if prec != 53 else _sa().RR(v)
    if isinstance(x, (RealNumberMP, ComplexNumberMP)):
        return x.n(prec)
    return RealField(prec)(x)


# ------------------------------------------------------------------ intervals

_IFIELDS = {}


def RealIntervalField(prec=53):
    """The field of real intervals with endpoints of prec bits.

    EXAMPLES::

        sage: RealIntervalField(10), RealIntervalField(10)(1/3)
        (Real Interval Field with 10 bits of precision, 0.334?)
        sage: RIF(pi), RealIntervalField(100)(2).sqrt()
        (3.141592653589794?, 1.414213562373095048801688724210?)
    """
    prec = int(prec)
    if prec not in _IFIELDS:
        _IFIELDS[prec] = RealIntervalField_(prec)
    return _IFIELDS[prec]


class RealIntervalField_:
    """A real interval field.

    EXAMPLES::

        sage: RealIntervalField(30).precision()
        30
    """

    def __init__(self, prec):
        self._prec = prec

    def __repr__(self):
        return "Real Interval Field with %d bits of precision" % self._prec

    def __eq__(self, o):
        return isinstance(o, RealIntervalField_) and o._prec == self._prec

    def __hash__(self):
        return hash(("RIF", self._prec))

    def precision(self):
        """The precision of the endpoints.

        EXAMPLES::

            sage: RIF.precision()
            53
        """
        return _sa().Integer(self._prec)

    prec = precision

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: RIF.is_exact()
            False
        """
        return False

    def pi(self):
        """An interval containing pi.

        EXAMPLES::

            sage: RIF.pi()
            3.141592653589794?
        """
        W = self._prec + 30
        p = _pi(W)
        return self._mk(_F(p - 2, 1 << W), _F(p + 2, 1 << W))

    def _mk(self, lo, hi):
        p = self._prec
        a = _round_q(lo.numerator, lo.denominator, p, "RNDD") if lo else (0, 0)
        b = _round_q(hi.numerator, hi.denominator, p, "RNDU") if hi else (0, 0)
        return RealIntervalElement(self, _F(a[0]) * _F(2) ** a[1] if a[0] else _F(0), _F(b[0]) * _F(2) ** b[1] if b[0] else _F(0))

    def __call__(self, x=0, y=None):
        """An interval: around a number or expression, or [x, y].

        EXAMPLES::

            sage: RIF(1, 2), RIF(1/3)
            (2.?, 0.3333333333333334?)
        """
        if y is not None:
            return self._mk(_exact_lo(x, self._prec), _exact_hi(y, self._prec))
        if isinstance(x, RealIntervalElement):
            return self._mk(x._lo, x._hi)
        if isinstance(x, (int, _F)) or type(x).__name__ in ("Integer", "Rational"):
            q = _F(x)
            return self._mk(q, q)
        if isinstance(x, RealNumberMP):
            q = x._q()
            return self._mk(q, q)
        if isinstance(x, float):
            lit = getattr(x, "_lit", None)
            q = _F(lit) if lit is not None else _F(x)
            return self._mk(q, q)
        if isinstance(x, str):
            q = _F(x)
            return self._mk(q, q)
        if getattr(x, "_s", None) is not None:
            # an exact number is a point; anything else gets the engine's
            # certified enclosure (outward rounding, in doubles), or none: a
            # radius guessed around an approximation enclosed 0 for
            # 10^100 (exp(10^-100) - 1), which is above 1 (the systematic
            # review's ROOT-F3)
            s = x._s
            if s.startswith("n") and s.endswith(";") and "/" in s:
                try:
                    q = _F(*map(int, s[1:-1].split("/")))
                    return self._mk(q, q)
                except ValueError:
                    pass
            if str(x) in ("pi", "e"):
                # a constant alone: its high-precision value has no
                # cancellation, so a tight interval around it is sound
                v = evaluate(x, self._prec + 40)
                q = v._q()
                err = abs(q) / (_F(2) ** (self._prec + 30))
                return self._mk(q - err, q + err)
            import _sage_expr
            r = _sage_expr._call("enclose", s)
            if len(r) == 2:
                return self._mk(_F(float(r[0])), _F(float(r[1])))
            raise NotImplementedError("no certified enclosure of %r" % (x,))
        q = _F(x)
        return self._mk(q, q)


def _exact_lo(x, prec):
    return _F(getattr(x, "_lit", None) or x) if not isinstance(x, RealIntervalElement) else x._lo


def _exact_hi(x, prec):
    return _F(getattr(x, "_lit", None) or x) if not isinstance(x, RealIntervalElement) else x._hi


RIF = RealIntervalField(53)


class RealIntervalElement:
    """A real interval [lo, hi], printed as Sage prints it (with ?).

    EXAMPLES::

        sage: I = RIF(1/3); I, I.lower(), I.upper(), I.endpoints()
        (0.3333333333333334?, 0.333333333333333, 0.333333333333334, (0.333333333333333, 0.333333333333334))

    Powers are tight (an even power of an interval containing 0 starts at 0),
    and the printing follows sage.rings.real_mpfi.printing_style:

        sage: x = RIF(-1, 1); 1 - x^2, 1 - x*x, RIF(-2, -1)^3, RIF(1, 2)^-1, RIF(0, 4)
        (1.?, 1.?, -1.?e1, 1.?, 1.?e1)
        sage: sage.rings.real_mpfi.printing_style = 'brackets'
        sage: 1 - x^2, RIF(2)
        ([0.0000000000000000 .. 1.0000000000000000], [2.0000000000000000 .. 2.0000000000000000])
        sage: sage.rings.real_mpfi.printing_style = 'question'
    """

    __slots__ = ("_F_", "_lo", "_hi")

    def __init__(self, Fld, lo, hi):
        self._F_, self._lo, self._hi = Fld, lo, hi

    def parent(self):
        """The interval field.

        EXAMPLES::

            sage: RIF(1).parent()
            Real Interval Field with 53 bits of precision
        """
        return self._F_

    def __repr__(self):
        """As Sage prints an interval: sage.rings.real_mpfi.printing_style
        'question' (the default) or 'brackets' (examples in the class's
        docstring)."""
        return self.str()

    __str__ = __repr__

    def str(self, style=None):
        """The interval as text: style 'question' (2.?) or 'brackets'
        ([lo .. hi]); None, the default, follows
        sage.rings.real_mpfi.printing_style, as Sage does. An explicit style
        is always honoured (astra's CORR-42D-1).

        EXAMPLES::

            sage: RIF(1/3).str(style='brackets')
            '[0.33333333333333331 .. 0.33333333333333338]'
            sage: import sage.rings.real_mpfi as M; M.printing_style = 'brackets'
            sage: RIF(1, 2).str(style='question'), RIF(1, 2).str()
            ('2.?', '[1.0000000000000000 .. 2.0000000000000000]')
            sage: M.printing_style = 'question'
        """
        if style is None:
            import sys
            m = sys.modules.get("sage.rings.real_mpfi")
            style = "brackets" if m is not None and m.__dict__.get("printing_style") == "brackets" else "question"
        if style == "brackets":
            D = 1 + int(math.ceil(self._F_._prec * _LOG10_2 - 1e-12))

            def end(q, rnd):
                # (a zero endpoint has D digits in all, as Sage prints it)
                return "0." + "0" * (D - 1) if q == 0 else _format(q, D, rnd=rnd)
            return "[%s .. %s]" % (end(self._lo, "D"), end(self._hi, "U"))
        from _sage_qqbar import _str_interval
        return _str_interval(self._lo, self._hi, self._F_._prec)

    def lower(self):
        """The lower endpoint (in a field rounding down).

        EXAMPLES::

            sage: RIF(1, 2).lower()
            1.00000000000000
        """
        return RealField_(self._F_._prec, "RNDD")(self._lo)

    def upper(self):
        """The upper endpoint (in a field rounding up).

        EXAMPLES::

            sage: RIF(1, 2).upper()
            2.00000000000000
        """
        return RealField_(self._F_._prec, "RNDU")(self._hi)

    def endpoints(self):
        """(lower, upper).

        EXAMPLES::

            sage: RIF(1, 2).endpoints()
            (1.00000000000000, 2.00000000000000)
        """
        return self.lower(), self.upper()

    def center(self):
        """The midpoint.

        EXAMPLES::

            sage: RIF(1, 2).center()
            1.50000000000000
        """
        return RealField(self._F_._prec)((self._lo + self._hi) / 2)

    def absolute_diameter(self):
        """hi - lo.

        EXAMPLES::

            sage: RIF(1, 2).absolute_diameter()
            1.00000000000000
        """
        return RealField(self._F_._prec)(self._hi - self._lo)

    diameter = absolute_diameter

    def contains_zero(self):
        """Whether 0 is in the interval.

        EXAMPLES::

            sage: RIF(-1, 1).contains_zero(), RIF(1, 2).contains_zero()
            (True, False)
        """
        return self._lo <= 0 <= self._hi

    def __contains__(self, x):
        try:
            q = _F(getattr(x, "_lit", None) or x) if not isinstance(x, RealNumberMP) else x._q()
        except (TypeError, ValueError):
            return False
        return self._lo <= q <= self._hi

    def _o(self, o):
        if isinstance(o, RealIntervalElement):
            return o
        return self._F_(o)

    def __add__(self, o):
        o = self._o(o)
        return self._F_._mk(self._lo + o._lo, self._hi + o._hi)

    __radd__ = __add__

    def __neg__(self):
        return RealIntervalElement(self._F_, -self._hi, -self._lo)

    def __sub__(self, o):
        o = self._o(o)
        return self._F_._mk(self._lo - o._hi, self._hi - o._lo)

    def __rsub__(self, o):
        return self._o(o) - self

    def __mul__(self, o):
        o = self._o(o)
        p = [self._lo * o._lo, self._lo * o._hi, self._hi * o._lo, self._hi * o._hi]
        return self._F_._mk(min(p), max(p))

    __rmul__ = __mul__

    def __truediv__(self, o):
        o = self._o(o)
        if o._lo <= 0 <= o._hi:
            raise ZeroDivisionError("interval contains 0")
        q = [self._lo / o._lo, self._lo / o._hi, self._hi / o._lo, self._hi / o._hi]
        return self._F_._mk(min(q), max(q))

    def __rtruediv__(self, o):
        return self._o(o) / self

    def __pow__(self, n):
        """x^n for an integer n: the tight interval of the endpoints' powers
        (an even power of an interval containing 0 starts at 0, as in Sage:
        RIF(-1, 1)^2 is [0, 1], not the product [-1, 1]), rounded outward
        once for n >= 0; a negative power is the reciprocal of that, rounded
        outward again, so it may be an ulp wider than tight (examples in the
        class's docstring)."""
        if isinstance(n, bool) or not isinstance(n, int):
            if isinstance(n, _F) and n.denominator == 1:
                n = int(n)
            else:
                raise NotImplementedError("a power of an interval with a non-integer exponent is not available in sagebrush yet")
        if n == 0:
            return self._F_(1)
        if n < 0:
            return 1 / (self ** -n)
        lo, hi = self._lo, self._hi
        # (the exact endpoint powers: refused beyond a million bits rather
        # than computed; the loop of products was unbounded in n)
        bits = max(abs(lo.numerator).bit_length() + lo.denominator.bit_length(),
                   abs(hi.numerator).bit_length() + hi.denominator.bit_length())
        if n * bits > 1 << 20:
            raise NotImplementedError("an interval power of more than 2^20 bits is not available in sagebrush yet")
        if n % 2:
            return self._F_._mk(lo ** n, hi ** n)
        if lo >= 0:
            return self._F_._mk(lo ** n, hi ** n)
        if hi <= 0:
            return self._F_._mk(hi ** n, lo ** n)
        return self._F_._mk(_F(0), max(-lo, hi) ** n)

    def sqrt(self):
        """The square root (of a nonnegative interval).

        EXAMPLES::

            sage: RIF(2).sqrt()
            1.414213562373095?
        """
        p = self._F_._prec + 20
        R = RealField(p)
        lo = R(self._lo).sqrt()._q() if self._lo > 0 else _F(0)
        hi = R(self._hi).sqrt()._q()
        u = _F(1, 2 ** p) * (1 + abs(hi))
        return self._F_._mk(lo - u, hi + u)

    def __eq__(self, o):
        try:
            o = self._o(o)
        except (TypeError, ValueError):
            return False
        return self._lo == self._hi == o._lo == o._hi

    def __hash__(self):
        return hash((self._lo, self._hi))

    def __float__(self):
        return float((self._lo + self._hi) / 2)
