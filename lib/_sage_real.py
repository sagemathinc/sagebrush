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
    return (-q if neg else q), e + shift


def _round_int(m, e, prec, rnd="RNDN"):
    """(m, e) with m any integer, rounded to prec bits."""
    if m == 0:
        return 0, 0
    b = abs(m).bit_length()
    if b <= prec:
        s = prec - b
        return m << s, e - s
    return _round_q(m, 1, prec, rnd, e)


# ------------------------------------------------------------------ fixed-point kernels
# A fixed-point number at scale W is an integer X standing for X / 2^W.

_CACHE = {}


def _fx(m, e, W):
    """m 2^e as a fixed-point integer at scale W (truncated)."""
    s = e + W
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



def _to_real(R, x, base=10):
    prec, rnd = R._prec, R._rnd
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
    """

    __slots__ = ("_R", "_m", "_e", "_special")

    def __init__(self, R, m, e, special=None):
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
        return _format(self._q(), _digits(self._R._prec), rnd=_DEC_RND[self._R._rnd] if self._m >= 0 or self._R._rnd != "RNDZ" else "U")

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
        return _format(self._q(), D, no_sci)

    def _latex_(self):
        return repr(self)

    def __format__(self, spec):
        return repr(self) if spec == "" else format(float(self), spec)

    # ---- conversion
    def __float__(self):
        if self._special:
            return {"+inf": float("inf"), "-inf": float("-inf"), "nan": float("nan")}[self._special]
        return float(self._q())

    def __int__(self):
        return int(self._q())

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
        return RealField(prec)(self) if int(prec) != 53 else _sa().RR(float(self))

    n = N = numerical_approx

    def __hash__(self):
        if self._special:
            return hash(self._special)
        return hash(self._q())

    # ---- arithmetic
    def _other(self, o):
        """(o as a RealNumberMP, the field of the result), or (None, None)."""
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
        if R._prec == 53 and R._rnd == "RNDN":
            return _sa().RR(float(r))
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
            if n >= 0:
                if self._m == 0:
                    return R(1) if n == 0 else self
                # exact power, rounded once (for moderate exponents)
                if n * abs(self._m).bit_length() < 200000:
                    m, e = _round_int(self._m ** n, self._e * n, R._prec, R._rnd)
                    return RealNumberMP(R, m, e)
            else:
                if n * -abs(self._m).bit_length() < 200000 and self._m:
                    q = self._q() ** n
                    return R(q)
        if isinstance(n, RealNumberMP) and n._m == 0 and not n._special:
            return R(1)
        x = self
        y = n if isinstance(n, RealNumberMP) else R(n)
        if x._m < 0:
            # a negative real to a real power: complex
            return ComplexField(R._prec)(x) ** ComplexField(R._prec)(y)
        return (y * x.log()).exp()

    def __rpow__(self, b):
        return self._R(b) ** self

    # ---- comparison
    def _cmpq(self, o):
        if isinstance(o, RealNumberMP):
            if o._special or self._special:
                return (float(self) > float(o)) - (float(self) < float(o))
            a, b = self._q(), o._q()
        else:
            try:
                b = _F(o) if not isinstance(o, float) else _F(o)
            except (TypeError, ValueError):
                return None
            if self._special:
                return (float(self) > float(b)) - (float(self) < float(b))
            a = self._q()
        return (a > b) - (a < b)

    def __eq__(self, o):
        if self._special == "nan":
            return False
        c = self._cmpq(o)
        return NotImplemented if c is None else c == 0

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    def __lt__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else c < 0

    def __le__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else c <= 0

    def __gt__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else c > 0

    def __ge__(self, o):
        c = self._cmpq(o)
        return NotImplemented if c is None else c >= 0

    # ---- integer parts
    def floor(self):
        """The greatest integer at most self.

        EXAMPLES::

            sage: RealField(100)(-2.5).floor(), RealField(100)(2.5).ceil()
            (-3, 3)
        """
        return _sa().Integer(math.floor(self._q()))

    def ceil(self):
        """The least integer at least self.

        EXAMPLES::

            sage: RealField(100)(2.1).ceil()
            3
        """
        return _sa().Integer(math.ceil(self._q()))

    ceiling = ceil

    def round(self):
        """The nearest integer (halves to even).

        EXAMPLES::

            sage: RealField(100)(2.5).round(), RealField(100)(-2.5).round(), RealField(100)(3.5).round()
            (2, -2, 4)
        """
        return _sa().Integer(round(self._q()))

    def trunc(self):
        """The integer part.

        EXAMPLES::

            sage: RealField(100)(-2.7).trunc()
            -2
        """
        return _sa().Integer(int(self._q()))

    def frac(self):
        """self minus its integer part.

        EXAMPLES::

            sage: RealField(20)(2.75).frac()
            0.75000
        """
        return self - self._R(int(self._q()))

    def is_integer(self):
        """Whether an integer.

        EXAMPLES::

            sage: RealField(20)(3).is_integer(), RealField(20)(2.5).is_integer()
            (True, False)
        """
        return not self._special and self._q().denominator == 1

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

    def exp(self):
        """e^self.

        EXAMPLES::

            sage: RealField(100)(1).exp()
            2.7182818284590452353602874714
        """
        R = self._R
        if self._m == 0:
            return R(1)
        mag = self._e + abs(self._m).bit_length()
        if mag > 40:
            raise OverflowError("exponent too large")
        # the result has about |x|/ln 2 integer bits: enough fraction bits
        W = R._prec + 30 + max(0, int(abs(float(self)) * 1.4427) + 2)
        X = self._fix(W)
        return R._fixed(_exp_fx(X, W), W)

    def log(self, base=None):
        """The natural logarithm (or to the given base).

        EXAMPLES::

            sage: RealField(100)(2).log(), RealField(30)(8).log(2)
            (0.69314718055994530941723212146, 3.0000000)
        """
        R = self._R
        if self._m <= 0:
            if self._m == 0:
                return RealNumberMP(R, 0, 0, "-inf")
            return ComplexField(R._prec)(self).log() if base is None else ComplexField(R._prec)(self).log() / R(base).log()
        W = R._prec + 30
        v = R._fixed(_log_fx(self._m, self._e, W), W)
        if base is not None:
            return v / R(base).log()
        return v

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

    def _trig(self):
        R = self._R
        W = R._prec + 30
        return _sincos_fx(self._fix(W), W), W

    def sin(self):
        """The sine.

        EXAMPLES::

            sage: RealField(100)(1).sin()
            0.84147098480789650665250232163
        """
        if self._m == 0:
            return self
        (s, c), W = self._trig()
        return self._R._fixed(s, W)

    def cos(self):
        """The cosine.

        EXAMPLES::

            sage: RealField(100)(1).cos()
            0.54030230586813971740093660744
        """
        (s, c), W = self._trig()
        return self._R._fixed(c, W)

    def tan(self):
        """The tangent.

        EXAMPLES::

            sage: RealField(100)(1).tan()
            1.5574077246549022305069748075
        """
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
        (s, c), W = self._trig()
        return self._R(_F(c, s))

    def arctan(self):
        """The arctangent.

        EXAMPLES::

            sage: RealField(100)(1).arctan()
            0.78539816339744830961566084582
        """
        R = self._R
        W = R._prec + 30 + max(0, -(self._e + abs(self._m).bit_length()))
        return R._fixed(_atan_fx(self._fix(W), W), W)

    atan = arctan

    def arcsin(self):
        """The arcsine.

        EXAMPLES::

            sage: RealField(100)(1/2).arcsin()
            0.52359877559829887307710723055
        """
        R = self._R
        q = self._q()
        if abs(q) > 1:
            raise ValueError("arcsin of a number outside [-1, 1]")
        if abs(q) == 1:
            return R.pi() / 2 * (1 if q > 0 else -1)
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
        H = RealField(self._R._prec + 30)
        t = H(self).exp()
        return self._R((t - 1 / t) / 2)

    def cosh(self):
        """The hyperbolic cosine.

        EXAMPLES::

            sage: RealField(100)(1).cosh()
            1.5430806348152437784779056208
        """
        H = RealField(self._R._prec + 30)
        t = H(self).exp()
        return self._R((t + 1 / t) / 2)

    def tanh(self):
        """The hyperbolic tangent.

        EXAMPLES::

            sage: RealField(100)(1).tanh()
            0.76159415595576488811945828260
        """
        H = RealField(self._R._prec + 30)
        t = H(2 * H(self)).exp()
        return self._R((t - 1) / (t + 1))

    def arcsinh(self):
        """The inverse hyperbolic sine.

        EXAMPLES::

            sage: RealField(100)(1).arcsinh()
            0.88137358701954302523260932498
        """
        H = RealField(self._R._prec + 30)
        x = H(self)
        return self._R((x + (x * x + 1).sqrt()).log())

    def arccosh(self):
        """The inverse hyperbolic cosine.

        EXAMPLES::

            sage: RealField(100)(2).arccosh()
            1.3169578969248167086250463473
        """
        H = RealField(self._R._prec + 30)
        x = H(self)
        return self._R((x + (x * x - 1).sqrt()).log())

    def arctanh(self):
        """The inverse hyperbolic tangent.

        EXAMPLES::

            sage: RealField(100)(1/2).arctanh()
            0.54930614433405484569762261846
        """
        H = RealField(self._R._prec + 30)
        x = H(self)
        return self._R(((1 + x) / (1 - x)).log() / 2)

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
        """
        return self._R(_gamma(self._q(), self._R._prec))

    def log_gamma(self):
        """The logarithm of the gamma function.

        EXAMPLES::

            sage: RealField(100)(10).log_gamma()
            12.801827480081469611207717875
        """
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
        return R(_float_op(float(a), float(b), op))
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


def _float_op(x, y, op):
    try:
        return {"+": x + y, "-": x - y, "*": x * y}[op] if op != "/" else (x / y if y else (float("inf") if x > 0 else float("-inf") if x < 0 else float("nan")))
    except ZeroDivisionError:
        return float("nan")


def _digits(prec):
    return max(2, int(math.floor((prec - 1) * _LOG10_2 + 1e-12)))


def _format(q, D, no_sci=None, rnd="N"):
    """The rational q printed with D significant digits, as Sage prints a
    RealNumber (rounded to nearest, or toward +infinity "U" / -infinity
    "D")."""
    if q == 0:
        return "0." + "0" * D
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
            return sign + s + "0" * (E + 1 - D) + "."
        return sign + s[:E + 1] + "." + s[E + 1:]
    return sign + "0." + "0" * (-E - 1) + s


def _gamma(q, prec):
    """Gamma(q) to prec bits, q rational (Stirling's series)."""
    R = RealField(prec + 40)
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
    while float(x) < N:
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
        if abs(float(t)) < 2.0 ** (-(prec + 45)):
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
        return self._c(o) / self

    def __eq__(self, o):
        o = self._c(o)
        return o is not None and self._re == o._re and self._im == o._im

    def __ne__(self, o):
        return not self == o

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

def evaluate(expr, prec):
    """The value of a constant symbolic expression to prec bits: a
    RealNumberMP, or a ComplexNumberMP if it is not real.

    EXAMPLES::

        sage: from _sage_real import evaluate  # sagebrush only
        sage: evaluate(pi + sqrt(2), 100)  # sagebrush only
        4.5558062159628882872643321075
    """
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
        return RealField(prec)(v) if prec != 53 else _sa().RR(float(v))
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
        from _sage_qqbar import _str_interval
        return _str_interval(self._lo, self._hi, self._F_._prec)

    __str__ = __repr__

    def str(self, style="question"):
        """The interval as text (style='brackets': [lo .. hi]).

        EXAMPLES::

            sage: RIF(1/3).str(style='brackets')
            '[0.33333333333333331 .. 0.33333333333333338]'
        """
        if style == "brackets":
            D = 1 + int(math.ceil(self._F_._prec * _LOG10_2 - 1e-12))
            return "[%s .. %s]" % (_format(self._lo, D, rnd="D"), _format(self._hi, D, rnd="U"))
        return repr(self)

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
        n = int(n)
        r = self._F_(1)
        for _ in range(abs(n)):
            r = r * self
        return r if n >= 0 else 1 / r

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
