"""The field of algebraic numbers QQbar and the real algebraic numbers AA, as
in Sage: exact elements (a polynomial with rational coefficients in a chosen
root of an irreducible integer polynomial), printed as Sage prints them, with
an interval and a question mark: 1.414213562373095?, -1.732050807568878?*I.

Each element carries, besides its exact value, the 64-bit interval Sage would
display, computed the way Sage computes it (interval arithmetic at 64 bits
on the intervals of the operands, rounded outward to 53 bits for printing),
so that printed digits agree with Sage.  Arithmetic between elements of the
same field is polynomial arithmetic modulo the defining polynomial; between
different fields the minimal polynomial of the result is a factor of the
characteristic polynomial of a Kronecker product of companion matrices,
chosen by a numerical test at increasing precision."""

import cmath
import math
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


PREC = 64  # bits of Sage's default QQbar intervals


# ------------------------------------------------------------------ intervals

def _rnd(q, up, bits=PREC):
    """q rounded to a binary number with `bits` significant bits, toward
    +infinity (up) or -infinity."""
    if q == 0:
        return _F(0)
    q = _F(q)
    n, d = abs(q.numerator), q.denominator
    e = n.bit_length() - d.bit_length()
    if (n << max(0, -e)) < (d << max(0, e)):
        e -= 1
    s = bits - 1 - e
    num, den = (n << s, d) if s >= 0 else (n, d << -s)
    m, r = divmod(num, den)
    if r and (up == (q > 0)):
        m += 1
    v = _F(m, 1 << s) if s >= 0 else _F(m << -s)
    return v if q > 0 else -v


class _Iv:
    """A real interval [lo, hi] with endpoints of PREC bits."""
    __slots__ = ("lo", "hi")

    def __init__(self, lo, hi):
        self.lo, self.hi = lo, hi

    @staticmethod
    def _of(q):
        """The tightest interval around the rational q."""
        q = _F(q)
        lo, hi = _rnd(q, False), _rnd(q, True)
        return _Iv(lo, hi)

    @staticmethod
    def _around(v, err):
        """The interval around an approximation v with error at most err."""
        return _Iv(_rnd(v - err, False), _rnd(v + err, True))

    def _is_point(self):
        return self.lo == self.hi

    def _is_zero(self):
        return self.lo == 0 and self.hi == 0

    def __add__(self, o):
        return _Iv(_rnd(self.lo + o.lo, False), _rnd(self.hi + o.hi, True))

    def __neg__(self):
        return _Iv(-self.hi, -self.lo)

    def __sub__(self, o):
        return self + (-o)

    def __mul__(self, o):
        if self._is_zero() or o._is_zero():
            return _Iv(_F(0), _F(0))
        p = [self.lo * o.lo, self.lo * o.hi, self.hi * o.lo, self.hi * o.hi]
        return _Iv(_rnd(min(p), False), _rnd(max(p), True))

    def _inv(self):
        if self.lo <= 0 <= self.hi:
            raise ZeroDivisionError("interval contains 0")
        return _Iv(_rnd(1 / self.hi, False), _rnd(1 / self.lo, True))


_ZERO = _Iv(_F(0), _F(0))


class _CIv:
    """A complex interval re + im*I."""
    __slots__ = ("re", "im")

    def __init__(self, re, im=_ZERO):
        self.re, self.im = re, im

    def __add__(self, o):
        return _CIv(self.re + o.re, self.im + o.im)

    def __sub__(self, o):
        return _CIv(self.re - o.re, self.im - o.im)

    def __neg__(self):
        return _CIv(-self.re, -self.im)

    def __mul__(self, o):
        if self.im._is_zero() and o.im._is_zero():
            return _CIv(self.re * o.re)
        return _CIv(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)

    def _inv(self):
        if self.im._is_zero():
            return _CIv(self.re._inv())
        n = self.re * self.re + self.im * self.im
        ni = n._inv()
        return _CIv(self.re * ni, -(self.im * ni))


def _civ_rational(q):
    return _CIv(_Iv._of(q))


# ------------------------------------------------------------------ printing

def _floor_log10(q):
    """floor(log10 q) for a positive rational, exactly (a float logarithm
    fails at 10^-400 and overflows at 10^400: the systematic review's ROOT-F4)."""
    q = _F(q)
    e = len(str(q.numerator)) - len(str(q.denominator))
    while _F(10) ** e > q:
        e -= 1
    while _F(10) ** (e + 1) <= q:
        e += 1
    return e


def _ilog(n):
    """The natural logarithm of a positive integer of any size."""
    b = n.bit_length()
    if b <= 1000:
        return math.log(n)
    return math.log(n >> (b - 64)) + (b - 64) * math.log(2)


def _str_interval(lo, hi, bits=53):
    """An interval printed as Sage's RealIntervalField(bits) prints it: the
    most digits (at most ceil(bits log10 2) + 1, 17 for 53 bits) such that,
    in units of the last digit, the interval lies within the printed value
    plus or minus 1."""
    lo, hi = _rnd(lo, False, bits), _rnd(hi, True, bits)
    cap = int(math.ceil(bits * 0.30102999566398119521 - 1e-12)) + 1
    if lo == hi:
        if lo.denominator == 1 and abs(lo) < 2 ** bits:
            return str(lo.numerator)
    if lo < 0 < hi or (lo == 0) != (hi == 0):
        # contains 0: 0.?e<k> with the least k such that [-10^k, 10^k] covers it
        a = max(-lo, hi)
        k = _floor_log10(a)
        while math.floor(lo / _F(10) ** k) < -1 or math.ceil(hi / _F(10) ** k) > 1:
            k += 1
        while math.floor(lo / _F(10) ** (k - 1)) >= -1 and math.ceil(hi / _F(10) ** (k - 1)) <= 1:
            k -= 1
        return "0.?e%d" % k
    neg = hi < 0
    a1, a2 = (-hi, -lo) if neg else (lo, hi)
    E = _floor_log10(a2)
    best = None
    for d in range(1, cap + 1):
        k = E - d + 1
        u = _F(10) ** k
        L, H = math.floor(a1 / u), math.ceil(a2 / u)
        if H - L > 2:
            break
        best = (-((-(L + H)) // 2), k)
    if best is None:
        # wider than its magnitude: one digit at a coarser scale
        k = E + 1
        while True:
            u = _F(10) ** k
            L, H = math.floor(a1 / u), math.ceil(a2 / u)
            if H - L <= 2:
                best = (-((-(L + H)) // 2), k)
                break
            k += 1
    m, k = best
    ds = str(m)
    e10 = len(ds) - 1 + k
    sign = "-" if neg else ""
    if m == 0:
        return "0.?e%d" % k
    if e10 >= 6 or e10 <= -6:
        return sign + ds[0] + "." + ds[1:] + "?e%d" % e10
    if k >= 0:
        return sign + ds + "0" * k + ".?"
    if -k >= len(ds):
        return sign + "0." + "0" * (-k - len(ds)) + ds + "?"
    return sign + ds[:k] + "." + ds[k:] + "?"


def _str_civ(c):
    re, im = c.re, c.im
    if im._is_zero():
        return _str_interval(re.lo, re.hi)
    neg = im.hi < 0
    si = _str_interval(-im.hi, -im.lo) if neg else _str_interval(im.lo, im.hi)
    if re._is_zero():
        return ("-" if neg else "") + si + "*I"
    return "%s %s %s*I" % (_str_interval(re.lo, re.hi), "-" if neg else "+", si)


def _str_rational(q):
    q = _F(q)
    return str(q.numerator) if q.denominator == 1 else "%d/%d" % (q.numerator, q.denominator)


# ------------------------------------------------------------------ polynomials over QQ (lists, constant first)

def _trim(a):
    a = list(a)
    while a and a[-1] == 0:
        a.pop()
    return a


def _pmul(a, b):
    if not a or not b:
        return []
    r = [_F(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                r[i + j] += x * y
    return _trim(r)


def _pmod(a, g):
    a = [_F(x) for x in a]
    n = len(g) - 1
    lc = _F(g[-1])
    while len(a) > n:
        c = a[-1] / lc
        if c:
            off = len(a) - 1 - n
            for i in range(n + 1):
                a[off + i] -= c * g[i]
        a.pop()
        a = _trim(a)
        if not a:
            break
    return _trim(a)


def _pdivmod(a, b):
    a = [_F(x) for x in a]
    b = _trim(b)
    q = [_F(0)] * max(len(a) - len(b) + 1, 1)
    while len(a) >= len(b) and a:
        c = a[-1] / b[-1]
        off = len(a) - len(b)
        q[off] = c
        for i in range(len(b)):
            a[off + i] -= c * b[i]
        a.pop()
        a = _trim(a)
    return _trim(q), a


def _pinv(a, g):
    """a^-1 modulo g (g irreducible)."""
    r0, r1 = [_F(x) for x in g], _trim(a)
    s0, s1 = [], [_F(1)]
    while len(r1) > 1:
        q, r = _pdivmod(r0, r1)
        r0, r1 = r1, r
        s0, s1 = s1, _psub(s0, _pmul(q, s1))
    if not r1:
        raise ZeroDivisionError("division by zero in a number field")
    c = r1[0]
    return _pmod([x / c for x in s1], g)


def _psub(a, b):
    n = max(len(a), len(b))
    return _trim([(a[i] if i < len(a) else 0) - (b[i] if i < len(b) else 0) for i in range(n)])


def _padd(a, b):
    n = max(len(a), len(b))
    return _trim([(a[i] if i < len(a) else 0) + (b[i] if i < len(b) else 0) for i in range(n)])


def _primitive(f):
    """The primitive integer polynomial with positive leading coefficient
    proportional to f."""
    f = [_F(x) for x in _trim(f)]
    d = 1
    for x in f:
        d = d * x.denominator // math.gcd(d, x.denominator)
    c = [int(x * d) for x in f]
    g = 0
    for x in c:
        g = math.gcd(g, x)
    c = [x // g for x in c]
    if c[-1] < 0:
        c = [-x for x in c]
    return c


def _factor(f):
    """The irreducible factors of an integer polynomial (with exponents)."""
    from sagebrush import poly
    if len(f) == 2:
        return [(list(f), 1)]
    _, fs = poly.factor([int(x) for x in f])
    return [(_primitive(g), e) for g, e in fs]


# ------------------------------------------------------------------ numerics

def _cpow_eval(f, z, bits):
    """f(z) for f a list of rationals, z = (re, im) Fractions, truncated to
    `bits` bits after each step."""
    re, im = _F(0), _F(0)
    s = 1 << bits
    for c in reversed(f):
        re, im = re * z[0] - im * z[1] + c, re * z[1] + im * z[0]
        re = _F(round(re * s), s)
        im = _F(round(im * s), s)
    return re, im


class _Gen:
    """A root of an irreducible integer polynomial g, located by an
    approximation, with the interval Sage displays for it."""
    __slots__ = ("g", "z", "digits", "civ", "real", "_cache")

    def __init__(self, g, z, digits=40):
        self.g = g
        # (re, im) Fractions, accurate to about 10^-digits, digits enough to
        # identify the root (_identify)
        if len(g) > 2:
            z, digits = _identify(g, z, digits)
        self.z = z
        self.digits = digits
        self.real = z[1] == 0
        self._cache = {}
        self.civ = self._display()

    def _approx(self, digits):
        """(re, im) to about `digits` digits."""
        if digits <= self.digits:
            return self.z
        if digits in self._cache:
            return self._cache[digits]
        z = _nearest_root(self.g, self.z, digits)
        self._cache[digits] = z
        return z

    def _display(self):
        g = self.g
        d = len(g) - 1
        if self.real:
            re, im = self._approx(60)
            return _CIv(_Iv._around(re, _F(1, 10 ** 55)))
        if d == 2:
            # r +- s I, r = -b/2a.  Sage's interval Newton step keeps the
            # real part the exact point r when f(m) is computed with an
            # exactly zero imaginary part at the midpoint m = r + s_f I
            # (s_f the double nearest s), i.e. when r s_f is a double
            c, b, a = g
            r = _F(-b, 2 * a)
            s2 = _F(4 * a * c - b * b, 4 * a * a)  # s^2, s = |imaginary part|
            sq = _rational_sqrt(s2)
            z = self._approx(60)
            sf = _F(float(abs(z[1])))
            exact_re = r == 0 or (_F(float(r)) == r and _F(float(abs(r) * sf)) == abs(r) * sf)
            ire = _Iv(r, r) if exact_re and _rnd(r, True) == r else _Iv._around(z[0], _F(1, 10 ** 55))
            if sq is not None:
                iim = _Iv._of(sq)
            else:
                iim = _Iv._around(abs(z[1]), _F(1, 10 ** 55))
            if z[1] < 0:
                iim = -iim
            return _CIv(ire, iim)
        z = self._approx(60)
        if _is_pure_imaginary(g, self):
            ire = _ZERO
        else:
            ire = _Iv._around(z[0], _F(1, 10 ** 55))
        return _CIv(ire, _Iv._around(z[1], _F(1, 10 ** 55)))


def _rational_sqrt(q):
    q = _F(q)
    if q < 0:
        return None
    a, b = math.isqrt(q.numerator), math.isqrt(q.denominator)
    if a * a == q.numerator and b * b == q.denominator:
        return _F(a, b)
    return None


def _is_pure_imaginary(g, gen):
    """Whether the root of the irreducible g that gen holds has real part
    exactly 0: then g(-x) = +-g(x), so -conj(z) is a root too, and it is the
    same root (identified exactly: a real part of 10^-41 is not 0, the
    systematic review's ROOT-F1)."""
    if any(g[i] for i in range(len(g)) if (i % 2) != ((len(g) - 1) % 2)):
        return False
    neg = lambda e: (lambda u: (-u[0], u[1]))(gen._approx(e))
    z, d = _identify(g, gen._approx, gen.digits)
    w, d2 = _identify(g, neg, d)
    if d2 != d:
        z, _ = _identify(g, gen._approx, d2)
    return z == w


def _roots(g, digits):
    """The complex roots of the integer polynomial g to `digits` digits:
    [(re, im)] as Fractions."""
    from sagebrush import nf
    out = []
    for re, im, m in nf.complex_roots([int(x) for x in g], digits + 5):
        out.append((_F(re), _F(im)))
    return out


def _nearest_root(g, z, digits):
    # (z identifies its root: _Gen keeps z at a precision where the roots are
    # separated, _identify; the nearest root at a higher precision is then
    # that root, and it is checked to be unique)
    rs = _roots(g, digits)
    ds = sorted(((r[0] - z[0]) ** 2 + (r[1] - z[1]) ** 2, k) for k, r in enumerate(rs))
    if len(ds) > 1 and ds[1][0] <= 4 * ds[0][0]:
        raise ArithmeticError("a root of %r is not identified by its approximation" % (g,))
    return rs[ds[0][1]]


def _identify(f, approx, start=40):
    """(z, d): the root of the irreducible integer polynomial f that approx
    (an approximation (re, im), or a function of a number of digits d giving
    one to about d digits) approaches, to d digits, with d large enough that
    no other root is near: z is within 2 tol of the approximation and every
    other root farther than 6 tol, tol = 10^-d max(1, |z|), all compared
    exactly (roots told apart by 40-digit floats or by an underflowing
    double were confused: 1 +- sqrt(2) 10^-60 compared equal, the square
    root of 2/10^330 came out negative; the systematic review's ROOT-F1).
    Refused if they cannot be told apart."""
    d = start
    while d <= 6000:
        z = approx(d) if callable(approx) else approx
        z = (_F(z[0]), _F(z[1]))
        rs = _roots(f, d)
        if len(rs) == 1:
            return rs[0], d
        mag2 = max(_F(1), z[0] ** 2 + z[1] ** 2)
        tol2 = mag2 / _F(10) ** (2 * d)
        ds = sorted(((r[0] - z[0]) ** 2 + (r[1] - z[1]) ** 2, k) for k, r in enumerate(rs))
        if ds[0][0] <= 4 * tol2 and ds[1][0] > 36 * tol2:
            return rs[ds[0][1]], d
        if not callable(approx):
            break
        d *= 2
    raise ArithmeticError("the root of %r near the approximation cannot be identified" % (f,))


def _separated_roots(g, digits=40):
    """(roots, d): the roots of g to d digits, d large enough that every one
    identifies its root (_identify: pairwise farther apart than 8 tol)."""
    d = digits
    while True:
        rs = _roots(g, d)
        ok = True
        for i, r in enumerate(rs):
            mag2 = max(_F(1), r[0] ** 2 + r[1] ** 2)
            tol2 = mag2 / _F(10) ** (2 * d)
            if any((r[0] - s[0]) ** 2 + (r[1] - s[1]) ** 2 <= 64 * tol2 for s in rs[i + 1:]):
                ok = False
                break
        if ok or d > 6000:
            return rs, d
        d *= 2


def _sorted_roots(g, digits=40):
    """(roots, d): the roots of g as Sage orders them (the real roots
    increasing, then the others by real part, then imaginary part), to d
    digits, separated (_separated_roots)."""
    rs, d = _separated_roots(g, digits)
    real = sorted([r for r in rs if r[1] == 0])
    cx = sorted([r for r in rs if r[1] != 0])
    return real + cx, d


# ------------------------------------------------------------------ the fields

class _AlgebraicField:
    """QQbar, the field of algebraic numbers.

    EXAMPLES::

        sage: QQbar
        Algebraic Field
        sage: QQbar(2).sqrt(), QQbar(-3).sqrt()
        (1.414213562373095?, 1.732050807568878?*I)
        sage: sqrt(3) in QQbar
        True
    """

    _is_generic_field = True
    _real = False

    def __repr__(self):
        return "Algebraic Field"

    def _latex_(self):
        return r"\overline{\Bold{Q}}"

    def __call__(self, x=0):
        """Convert a number or an exact symbolic expression.

        EXAMPLES::

            sage: QQbar(1/2), QQbar(I), QQbar(sqrt(2) + 1)
            (1/2, I, 2.414213562373095?)
        """
        a = _convert(x)
        if self._real:
            if not a._is_real():
                raise ValueError("Cannot coerce algebraic number with non-zero imaginary part to algebraic real")
            return AlgebraicReal(a._gen, a._c, a._civ)
        if type(a) is AlgebraicReal:
            return AlgebraicNumber(a._gen, a._c, a._civ, a._gauss)
        return a

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError, NotImplementedError):
            return False

    def zero(self):
        """0.

        EXAMPLES::

            sage: QQbar.zero(), AA.one()
            (0, 1)
        """
        return self(0)

    def one(self):
        """1.

        EXAMPLES::

            sage: QQbar.one()
            1
        """
        return self(1)

    def gen(self, n=0):
        """The generator I (QQbar), or 1 (AA).

        EXAMPLES::

            sage: QQbar.gen()
            I
        """
        return self(1) if self._real else _gaussian(0, 1)

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: QQbar.characteristic()
            0
        """
        return _sa().Integer(0)

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: QQbar.is_field(), AA.is_exact(), QQbar.is_finite()
            (True, True, False)
        """
        return True

    def is_exact(self):
        """True: the elements are exact.

        EXAMPLES::

            sage: AA.is_exact()
            True
        """
        return True

    def is_finite(self):
        """False.

        EXAMPLES::

            sage: QQbar.is_finite()
            False
        """
        return False

    def order(self):
        """+Infinity.

        EXAMPLES::

            sage: QQbar.order()
            +Infinity
        """
        return _sa().infinity

    def __eq__(self, o):
        return type(o) is type(self)

    def __hash__(self):
        return hash(repr(self))


class _AlgebraicRealField(_AlgebraicField):
    """AA, the field of real algebraic numbers.

    EXAMPLES::

        sage: AA
        Algebraic Real Field
        sage: AA(2)^(1/2), AA(2)^(1/3)
        (1.414213562373095?, 1.259921049894873?)
    """

    _real = True

    def __repr__(self):
        return "Algebraic Real Field"

    def _latex_(self):
        return r"\mathbf{A}"


QQbar = _AlgebraicField()
AA = _AlgebraicRealField()


# ------------------------------------------------------------------ elements

class AlgebraicNumber:
    """An algebraic number: c(z) for z a root of an irreducible integer
    polynomial (gen None: a rational number c[0]).

    EXAMPLES::

        sage: a = QQbar(2).sqrt(); a, a + 1, a^2, 1/a
        (1.414213562373095?, 2.414213562373095?, 2.000000000000000?, 0.7071067811865475?)
        sage: a.minpoly(), a^2 == 2
        (x^2 - 2, True)
    """

    __slots__ = ("_gen", "_c", "_civ", "_gauss")

    def __init__(self, gen, c, civ=None, gauss=False):
        if gen is not None and len(_trim(c)) <= 1:
            gen = None
        self._gen = gen
        self._c = _trim([_F(x) for x in c]) if gen is not None else ([_F(c[0])] if c and c[0] else [])
        self._civ = civ
        self._gauss = gauss
        if civ is None:
            self._civ = self._embed()

    # ---- structure
    def _q(self):
        """The rational value (gen None)."""
        return self._c[0] if self._c else _F(0)

    def _is_rational(self):
        return self._gen is None

    def _is_real(self):
        if self._gen is None or self._gen.real:
            return True
        # exactly (equal to its conjugate): an imaginary part that rounds to
        # 0 at a fixed precision (I / 10^100) is not 0
        return self._exact_is_real()

    def _exact_is_real(self):
        return self == self.conjugate()

    def _embed(self):
        """The display interval of c(z): Horner on the generator's interval."""
        if self._gen is None:
            return _civ_rational(self._q())
        z = self._gen.civ
        acc = None
        for c in reversed(self._c + [_F(0)] * (len(self._gen.g) - 1 - len(self._c))):
            ci = _civ_rational(c)
            acc = ci if acc is None else acc * z + ci
        return acc if acc is not None else _civ_rational(0)

    def _approx(self, digits):
        """The value (re, im) to about `digits` digits."""
        if self._gen is None:
            return (self._q(), _F(0))
        z = self._gen._approx(digits + 5)
        bits = int((digits + 10) * 3.33)
        return _cpow_eval(self._c, z, bits)

    def _ball(self, digits):
        """(re, im, err): c(z) evaluated exactly at an approximation z of the
        generator good to 10^-digits max(1, |z|) (complex_roots gives that
        many significant digits), and err >= |c(z*) - c(z)| for the true
        root z*: sum k |c_k| delta (|z| + delta)^(k-1).  Decisions read from
        a ball are certified; a fixed number of digits is not (10^50 sqrt(2)
        - isqrt(2 10^100) compared not < 1: the systematic review's ROOT-F2)."""
        if self._gen is None:
            return (self._q(), _F(0), _F(0))
        z = self._gen._approx(digits)
        zr, zi = _F(z[0]), _F(z[1])
        re, im = _F(0), _F(0)
        for c in reversed(self._c):
            re, im = re * zr - im * zi + c, re * zi + im * zr
        m = abs(zr) + abs(zi)
        delta = max(_F(1), m) / _F(10) ** digits
        r = m + delta
        err, rk = _F(0), _F(1)
        for k in range(1, len(self._c)):
            err += k * abs(self._c[k]) * delta * rk
            rk *= r
        return (re, im, err)

    def _complex(self):
        re, im = self._approx(20)
        return complex(float(re), float(im))

    def parent(self):
        """QQbar (AA for algebraic reals).

        EXAMPLES::

            sage: QQbar(2).sqrt().parent(), AA(2).sqrt().parent()
            (Algebraic Field, Algebraic Real Field)
        """
        return QQbar

    def _new(self, gen, c, civ, gauss=False):
        return type(self)(gen, c, civ, gauss)

    # ---- printing
    def _exact_rational(self):
        """Whether this is a rational number that Sage prints exactly (its
        interval is the rational's own, not the result of interval
        arithmetic: sqrt(2)^2 prints as 2.000000000000000?)."""
        if self._gen is not None:
            return False
        rc = _civ_rational(self._q())
        c = self._civ
        return c.im._is_zero() and c.re.lo == rc.re.lo and c.re.hi == rc.re.hi

    def __repr__(self):
        if self._gen is None:
            if self._exact_rational():
                return _str_rational(self._q())
            return _str_civ(self._civ)
        if self._gauss:
            return _str_gaussian(self._c)
        return _str_civ(self._civ)

    __str__ = __repr__

    def _latex_(self):
        return repr(self).replace("*I", " i").replace("?", "?")

    # ---- arithmetic
    def _coerce(self, o):
        if isinstance(o, AlgebraicNumber):
            return o
        try:
            return _convert(o)
        except (TypeError, ValueError, NotImplementedError):
            return None

    def _result_type(self, o):
        return AlgebraicReal if type(self) is AlgebraicReal and type(o) is AlgebraicReal else AlgebraicNumber

    def _binop(self, o, op, rev=False):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        a, b = (o, self) if rev else (self, o)
        T = a._result_type(b)
        civ = {"+": lambda: a._civ + b._civ, "-": lambda: a._civ - b._civ,
               "*": lambda: a._civ * b._civ, "/": lambda: a._civ * b._civ._inv()}[op]
        if op == "/" and not b:
            raise ZeroDivisionError("division by zero in algebraic field")
        gauss = a._gauss_like() and b._gauss_like() and (a._gauss or b._gauss)
        gen = a._gen if a._gen is not None else b._gen
        if a._gen is None or b._gen is None or a._gen is b._gen:
            g = gen.g if gen is not None else None
            x, y = a._c, b._c
            if op == "+":
                c = _padd(x, y)
            elif op == "-":
                c = _psub(x, y)
            elif op == "*":
                c = _pmul(x, y) if g is None else _pmod(_pmul(x, y), g)
            else:
                if g is None:
                    c = [a._q() / b._q()]
                else:
                    c = _pmod(_pmul(x, _pinv(y, g)), g)
            exact = a._exact_rational() and b._exact_rational()
            if gauss:
                exact = True  # Gaussian rationals stay exact, as in Sage
            return T(gen, c, None if exact else civ(), gauss)
        return _combine(a, b, op, T, civ())

    def _gauss_like(self):
        return self._gen is None or self._gauss

    def __add__(self, o): return self._binop(o, "+")
    def __radd__(self, o): return self._binop(o, "+", True)
    def __sub__(self, o): return self._binop(o, "-")
    def __rsub__(self, o): return self._binop(o, "-", True)
    def __mul__(self, o): return self._binop(o, "*")
    def __rmul__(self, o): return self._binop(o, "*", True)
    def __truediv__(self, o): return self._binop(o, "/")
    def __rtruediv__(self, o): return self._binop(o, "/", True)

    def __neg__(self):
        return self._new(self._gen, [-x for x in self._c], -self._civ, self._gauss)

    def __pos__(self):
        return self

    def __pow__(self, e, mod=None):
        e = _F(e) if not isinstance(e, AlgebraicNumber) else e
        if isinstance(e, AlgebraicNumber):
            if not e._is_rational():
                raise TypeError("exponent must be rational")
            e = e._q()
        if e.denominator != 1:
            r = self.nth_root(e.denominator)
            return r ** e.numerator
        n = int(e)
        if n < 0:
            return (1 / self) ** (-n)
        r = self._new(None, [1], _civ_rational(1))
        b = self
        while n:
            if n & 1:
                r = r * b
            n >>= 1
            if n:
                b = b * b
        return r

    def __abs__(self):
        return self.abs()

    def __bool__(self):
        return bool(self._c)

    # ---- comparison
    def __eq__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        if self._gen is None and o._gen is None:
            return self._q() == o._q()
        if self._gen is o._gen:
            return self._c == o._c
        if (self._gen is None) != (o._gen is None):
            return False
        if self._minpoly_coeffs() != o._minpoly_coeffs():
            return False
        return _same_root(self._minpoly_coeffs(), self, o)

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    def __hash__(self):
        if self._gen is None:
            return hash(self._q())
        # the minimal polynomial alone: equal numbers hash equal (rounded
        # approximations need not, and overflow at 10^400); conjugates collide
        return hash(tuple(self._minpoly_coeffs()))

    def _cmp(self, o):
        """-1, 0, 1: by real part, then imaginary part (as Sage orders QQbar)."""
        o = self._coerce(o)
        if o is None:
            raise TypeError("cannot compare")
        if self == o:
            return 0
        # self != o exactly, so certified balls separate a differing part
        # eventually; equal real parts are recognised exactly
        both_real = self._is_real() and o._is_real()
        same_re = None
        digits = 30
        while digits <= 40000:
            a, b = self._ball(digits), o._ball(digits)
            e = a[2] + b[2]
            if abs(a[0] - b[0]) > e:
                return 1 if a[0] > b[0] else -1
            if not both_real and digits >= 120:
                if same_re is None:
                    same_re = self.real() == o.real()
                if same_re and abs(a[1] - b[1]) > e:
                    return 1 if a[1] > b[1] else -1
            digits *= 2
        raise ArithmeticError("comparison did not converge")

    def __lt__(self, o): return self._cmp(o) < 0
    def __le__(self, o): return self._cmp(o) <= 0
    def __gt__(self, o): return self._cmp(o) > 0
    def __ge__(self, o): return self._cmp(o) >= 0

    # ---- conversions
    def __float__(self):
        if not self._is_real():
            raise TypeError("unable to convert to float: the number is not real")
        return float(self._approx(20)[0])

    def __complex__(self):
        return self._complex()

    def __int__(self):
        if self._gen is None:
            return int(self._q())
        raise TypeError("not an integer")

    def n(self, prec=None, digits=None):
        """A numerical approximation (53 bits by default).

        EXAMPLES::

            sage: QQbar(2).sqrt().n(), QQbar(-2).sqrt().n()
            (1.41421356237309, 1.41421356237309*I)
        """
        sa = _sa()

        def mid(iv):
            # the centre of the 53-bit display interval, as Sage's n()
            lo, hi = _rnd(iv.lo, False, 53), _rnd(iv.hi, True, 53)
            return float((lo + hi) / 2)
        if prec is not None or digits is not None:
            # both parts, from an approximation with the precision asked for
            # and 10 more digits (the real part of a 60-digit approximation
            # was returned: QQbar(I).n(prec=100) was 0, the systematic
            # review's ROOT-F2)
            # each nonzero part to p significant bits, from a certified ball
            # (a fixed number of digits lost them after scaling or
            # cancellation: (sqrt(2)/10^100).n(prec=100) was 0, the
            # systematic review's ROOT-F3); a part is 0 only exactly
            import _sage_real
            p = _sage_real.digits_to_prec(digits) if digits is not None else int(prec)
            real = self._is_real()
            d0 = d = int(p * 0.30103) + 10
            zero = [None, True if real else None]
            while True:
                re, im, err = self._ball(d)
                ok = True
                for i, v in ((0, re), (1, im)):
                    if zero[i] or err * 2 ** (p + 2) <= abs(v):
                        continue
                    if d >= 4 * d0 and zero[i] is None:
                        zero[i] = (self.real() if i == 0 else self.imag()) == 0
                        if zero[i]:
                            continue
                    ok = False
                if ok:
                    break
                if d > 200000:
                    raise ArithmeticError("n(): the approximation did not converge")
                d *= 2
            if zero[0]:
                re = _F(0)
            if real or zero[1]:
                return sa.RealField(p)(re)
            return sa.ComplexField(p)(re, im)
        if self._is_real():
            return sa.RealNumber(mid(self._civ.re))
        import _sage_matrix
        return _sage_matrix.ComplexNumber(complex(mid(self._civ.re), mid(self._civ.im)))

    numerical_approx = N = n

    def _sym(self):
        re = self._approx(60)[0]
        return _sa().Rational._from_coprime_ints(re.numerator, re.denominator) if re.denominator != 1 else _sa().Integer(re.numerator)

    # ---- algebra
    def _minpoly_coeffs(self):
        """The minimal polynomial over QQ, primitive integral, constant first."""
        if self._gen is None:
            q = self._q()
            return [-q.numerator, q.denominator]
        g = self._gen.g
        if self._c == [_F(0), _F(1)]:
            return list(g)
        cp = _charpoly(_mult_matrix(self._c, g))
        fs = _factor(_primitive(cp))
        return fs[0][0] if len(fs) == 1 else _select(fs, self)

    def minpoly(self, var="x"):
        """The minimal polynomial over QQ (monic).

        EXAMPLES::

            sage: (QQbar(2).sqrt() + QQbar(3).sqrt()).minpoly()
            x^4 - 10*x^2 + 1
        """
        f = self._minpoly_coeffs()
        from _sage_poly import PolynomialRing
        return PolynomialRing(_sa().QQ, var)([_F(c, f[-1]) for c in f])

    minimal_polynomial = minpoly

    def degree(self):
        """The degree of the minimal polynomial.

        EXAMPLES::

            sage: QQbar(2).sqrt().degree()
            2
        """
        return _sa().Integer(len(self._minpoly_coeffs()) - 1)

    def conjugate(self):
        """The complex conjugate.

        EXAMPLES::

            sage: QQbar(-3).sqrt().conjugate()
            -1.732050807568878?*I
        """
        if self._is_real_gen():
            return self
        f = self._minpoly_coeffs()
        civ = _CIv(self._civ.re, -self._civ.im)
        if self._gauss:
            return self._new(self._gen, [self._c[0] if self._c else 0, -(self._c[1] if len(self._c) > 1 else 0)], civ, True)
        return _from_root(f, lambda d: (lambda z: (z[0], -z[1]))(self._approx(d)), type(self), civ)

    def _is_real_gen(self):
        return self._gen is None or self._gen.real

    def real(self):
        """The real part, an element of AA.

        EXAMPLES::

            sage: QQbar(-3).sqrt().real(), (1 + QQbar(-3).sqrt()).real()
            (0, 1)
        """
        if self._is_real_gen():
            return AlgebraicReal(self._gen, self._c, self._civ)
        r = (self + self.conjugate()) / 2
        civ = _CIv(self._civ.re)
        return AlgebraicReal(r._gen, r._c, civ) if r._is_real_gen() else _as_real(r, civ)

    real_part = real

    def imag(self):
        """The imaginary part, an element of AA.

        EXAMPLES::

            sage: QQbar(-3).sqrt().imag()
            1.732050807568878?
        """
        if self._is_real_gen():
            return AlgebraicReal(None, [0], _civ_rational(0))
        i = _gaussian(0, 1)
        r = (self - self.conjugate()) / (2 * i)
        civ = _CIv(self._civ.im)
        return AlgebraicReal(r._gen, r._c, civ) if r._is_real_gen() else _as_real(r, civ)

    imag_part = imag

    def abs(self):
        """The absolute value, an element of AA.

        EXAMPLES::

            sage: QQbar(1 + I).abs()
            1.414213562373095?
        """
        if self._is_real_gen():
            return AlgebraicReal(self._gen, self._c, self._civ) if self >= 0 else AlgebraicReal(self._gen, [-x for x in self._c], -self._civ)
        n = self * self.conjugate()
        n = _as_real(n, None) if not n._is_real_gen() else AlgebraicReal(n._gen, n._c, n._civ)
        return n.sqrt()

    def norm(self):
        """|self|^2.

        EXAMPLES::

            sage: QQbar(1 + 2*I).norm()
            5
        """
        if self._is_real_gen():
            return self * self
        n = self * self.conjugate()
        return _as_real(n, None) if not n._is_real_gen() else AlgebraicReal(n._gen, n._c, n._civ)

    def sqrt(self, all=False, extend=True):
        """The square root (principal branch; real for nonnegative reals).

        EXAMPLES::

            sage: QQbar(2).sqrt(), AA(4).sqrt(), QQbar(-4).sqrt()
            (1.414213562373095?, 2, 2*I)
        """
        r = self.nth_root(2)
        return [r, -r] if all else r

    def nth_root(self, n, all=False):
        """The principal n-th root (for AA: the real root).

        EXAMPLES::

            sage: AA(2).nth_root(3), AA(-8).nth_root(3)
            (1.259921049894873?, -2)
        """
        n = int(n)
        if self._gen is None:
            q = self._q()
            if q >= 0 or n % 2 == 1:
                a, b = _int_root(abs(q.numerator), n), _int_root(q.denominator, n)
                if a is not None and b is not None and (q >= 0 or n % 2):
                    v = _F(a, b) * (1 if q >= 0 else -1)
                    if q >= 0 or type(self) is AlgebraicReal:
                        return self._new(None, [v], _civ_rational(v))
            if q < 0 and n == 2:
                s = _rational_sqrt(-q)
                if s is not None:
                    return AlgebraicNumber(_gaussian_gen(), [0, s], None)
        f = self._minpoly_coeffs()
        h = []
        for i, c in enumerate(f):
            h += [c] + [0] * (n - 1) if i < len(f) - 1 else [c]
        # the principal root's (log |w|, arg w): log |z| / n, arg z / n
        lz, az = _log_arg(self._approx(40))
        if type(self) is AlgebraicReal and abs(az) > 3.0 and n % 2 == 1:
            target = (lz / n, math.pi)  # the real n-th root of a negative real
        else:
            target = (lz / n, az / n)
        T = AlgebraicReal if type(self) is AlgebraicReal and (target[1] == 0 or target[1] == math.pi) else AlgebraicNumber
        fs = _factor(h)
        return _root_near(fs, target, T, lambda r: _close_power(r, self, n))

    def is_integer(self):
        """Whether this is a rational integer.

        EXAMPLES::

            sage: AA(4).sqrt().is_integer(), AA(2).sqrt().is_integer()
            (True, False)
        """
        return self._gen is None and self._q().denominator == 1

    def is_square(self):
        """True: every algebraic number is a square in QQbar.

        EXAMPLES::

            sage: QQbar(-2).is_square()
            True
        """
        return True

    def __round__(self, n=None):
        if n is not None:
            return round(float(self), n)
        # the nearest integer, halves away from 0 (as Sage), exactly
        h = AlgebraicReal(None, [_F(1, 2)], None)
        return (self + h).floor() if self >= 0 else -((-self + h).floor())

    def floor(self):
        """The greatest integer at most self (real).

        EXAMPLES::

            sage: AA(2).sqrt().floor(), (-AA(2).sqrt()).floor()
            (1, -2)
        """
        # from a certified ball (a float start overflowed at 10^400 and
        # stepped 10^34 times at 10^50), corrected exactly
        d = 20
        while True:
            re, _, err = self._ball(d)
            if err < _F(1, 2):
                break
            d *= 2
        f = math.floor(re)
        while AlgebraicReal(None, [f + 1], None) <= self:
            f += 1
        while AlgebraicReal(None, [f], None) > self:
            f -= 1
        return _sa().Integer(f)

    def ceil(self):
        """The least integer at least self (real).

        EXAMPLES::

            sage: AA(2).sqrt().ceil()
            2
        """
        return -((-self).floor())


class AlgebraicReal(AlgebraicNumber):
    """A real algebraic number (an element of AA).

    EXAMPLES::

        sage: AA(2).sqrt() < AA(3).sqrt(), AA(2).sqrt().parent()
        (True, Algebraic Real Field)
    """
    __slots__ = ()

    def parent(self):
        """AA.

        EXAMPLES::

            sage: AA(3).sqrt().parent()
            Algebraic Real Field
        """
        return AA


def _int_root(n, k):
    r = round(n ** (1.0 / k)) if n < 2 ** 1000 else None
    if r is None:
        return None
    for c in (r - 1, r, r + 1):
        if c >= 0 and c ** k == n:
            return c
    return None


def _close_power(r, a, n):
    return r


# ------------------------------------------------------------------ helpers

_GAUSS_GEN = None


def _gaussian_gen():
    global _GAUSS_GEN
    if _GAUSS_GEN is None:
        _GAUSS_GEN = _Gen([1, 0, 1], (_F(0), _F(1)))
    return _GAUSS_GEN


def _gaussian(a, b):
    a, b = _F(a), _F(b)
    if b == 0:
        return AlgebraicNumber(None, [a], None)
    return AlgebraicNumber(_gaussian_gen(), [a, b], None, True)


def _str_gaussian(c):
    a = c[0] if c else _F(0)
    b = c[1] if len(c) > 1 else _F(0)
    if b == 1:
        s = "I"
    elif b == -1:
        s = "-I"
    else:
        s = _str_rational(b) + "*I"
    if a == 0:
        return s
    return "%s %s %s" % (s, "-" if a < 0 else "+", _str_rational(abs(a)))


def _mult_matrix(c, g):
    """The matrix of multiplication by c(z) on the basis 1, z, ..., z^(d-1)."""
    d = len(g) - 1
    rows = []
    for i in range(d):
        v = _pmod(_pmul(c, [0] * i + [1]), g)
        rows.append([v[j] if j < len(v) else _F(0) for j in range(d)])
    # rows[i] = coordinates of c z^i; the matrix acting on columns is the transpose
    return [[rows[j][i] for j in range(d)] for i in range(d)]


def _charpoly(m):
    from sagebrush import linalg
    return [_F(x) for x in linalg.charpoly(m)]


def _companion(f):
    """Companion matrix of the integer polynomial f (constant first)."""
    d = len(f) - 1
    lc = _F(f[-1])
    m = [[_F(0)] * d for _ in range(d)]
    for i in range(1, d):
        m[i][i - 1] = _F(1)
    for i in range(d):
        m[i][d - 1] = -_F(f[i]) / lc
    return m


def _kron(a, b):
    n, m = len(a), len(b)
    return [[a[i // m][j // m] * b[i % m][j % m] for j in range(n * m)] for i in range(n * m)]


def _eye(n):
    return [[_F(int(i == j)) for j in range(n)] for i in range(n)]


def _select(fs, a, values=None):
    """The factor (from [(f, e)]) vanishing at the algebraic number a."""
    for digits in (30, 60, 120, 250, 500):
        z = a._approx(digits)
        vals = []
        for f, _ in fs:
            re, im = _cpow_eval([_F(x) for x in f], z, int(digits * 3.4))
            scale = sum(abs(_F(x)) for x in f) * (1 + abs(z[0]) + abs(z[1])) ** len(f)
            vals.append((abs(re) + abs(im)) / scale)
        order = sorted(range(len(fs)), key=lambda i: vals[i])
        if len(order) == 1 or (vals[order[0]] < _F(1, 10 ** (digits // 2)) and vals[order[1]] > _F(1, 10 ** (digits // 3))):
            return fs[order[0]][0]
    raise ArithmeticError("could not identify the minimal polynomial")


def _from_root(f, z, T=AlgebraicNumber, civ=None):
    """The element of type T which is the root of the irreducible f that z
    (an approximation, or a function of a number of digits giving one)
    identifies (_identify)."""
    if len(f) == 2:
        q = _F(-f[0], f[1])
        return T(None, [q], civ if civ is not None else _civ_rational(q))
    zz, d = _identify(f, z, 40)
    gen = _Gen(f, zz, d)
    return T(gen, [0, 1], civ if civ is not None else gen.civ)


def _log_arg(z):
    """(log |z|, arg z) for z = (re, im) Fractions, without underflow (the
    logarithm from the integers; the angle from z scaled to size 1)."""
    re, im = _F(z[0]), _F(z[1])
    s = max(abs(re), abs(im))
    if s == 0:
        return (-math.inf, 0.0)
    a, b = float(re / s), float(im / s)
    ls = _ilog(s.numerator) - _ilog(s.denominator)
    return (ls + 0.5 * math.log(a * a + b * b), math.atan2(b, a))


def _root_near(fs, target, T, check):
    """Among the roots of the factors fs, the one nearest the target (log |w|,
    arg w), compared in logarithm and angle (a double target for the square
    root of 2/10^330 was 0, and the negative root was taken: the systematic
    review's ROOT-F1); the nearest must be unique."""
    cands = []
    for f, _ in fs:
        rs, d = _separated_roots(f, 40)
        for r in rs:
            lr, ar = _log_arg(r)
            da = abs(ar - target[1])
            da = min(da, 2 * math.pi - da)
            cands.append(((lr - target[0]) ** 2 + da * da, f, r, d))
    cands.sort(key=lambda c: c[0])
    if len(cands) > 1 and cands[1][0] <= 4 * cands[0][0] + 1e-18:
        raise ArithmeticError("the principal root cannot be told apart from another")
    _, f, r, d = cands[0]
    if len(f) == 2:
        q = _F(-f[0], f[1])
        return T(None, [q], _civ_rational(q))
    gen = _Gen(f, r, d)
    return T(gen, [0, 1], gen.civ)


def _combine(a, b, op, T, civ):
    """a op b for elements of different fields: the minimal polynomial is a
    factor of the characteristic polynomial of a Kronecker combination."""
    fa, fb = a._minpoly_coeffs(), b._minpoly_coeffs()
    if op == "/":
        fb = list(reversed(fb))  # the minimal polynomial of 1/b
    A, B = _companion(fa), _companion(fb)
    if op in "+-":
        if op == "-":
            B = [[-x for x in r] for r in B]
        M = [[x + y for x, y in zip(r, s)] for r, s in zip(_kron(A, _eye(len(B))), _kron(_eye(len(A)), B))]
    else:
        M = _kron(A, B)
    cp = _primitive(_charpoly(M))
    fs = _factor(cp)
    res = {"+": lambda x, y: x + y, "-": lambda x, y: x - y, "*": lambda x, y: x * y, "/": lambda x, y: x / y}[op]

    class _Probe:
        def _approx(self, digits):
            x, y = a._approx(digits + 10), b._approx(digits + 10)
            u, v = complex(0), complex(0)
            xr, xi, yr, yi = x[0], x[1], y[0], y[1]
            if op == "+":
                return (xr + yr, xi + yi)
            if op == "-":
                return (xr - yr, xi - yi)
            if op == "*":
                return (xr * yr - xi * yi, xr * yi + xi * yr)
            n = yr * yr + yi * yi
            return ((xr * yr + xi * yi) / n, (xi * yr - xr * yi) / n)

    p = _Probe()
    f = fs[0][0] if len(fs) == 1 else _select(fs, p)
    real = T is AlgebraicReal or (a._is_real_gen() and b._is_real_gen())
    return _from_root(f, lambda d: (lambda z: (z[0], _F(0)) if real else z)(p._approx(d)), T, civ)


def _same_root(f, a, b):
    """Whether a and b, both roots of the irreducible f, are the same root:
    each identified exactly (_identify), at one precision."""
    if len(f) <= 2:
        return True
    za, da = _identify(f, a._approx, 40)
    zb, db = _identify(f, b._approx, da)
    if db != da:
        za, _ = _identify(f, a._approx, db)
    return za == zb


def _as_real(r, civ):
    """r (known to be real) as an element of AA."""
    f = r._minpoly_coeffs()
    return _from_root(f, lambda d: (r._approx(d)[0], _F(0)), AlgebraicReal, civ)


def _same_gen_elements(rows):
    return rows


# ------------------------------------------------------------------ conversion

def _convert(x):
    """An AlgebraicNumber from x (int, rational, algebraic number, exact
    symbolic expression)."""
    if isinstance(x, AlgebraicNumber):
        return x
    if isinstance(x, bool):
        x = int(x)
    if isinstance(x, int):
        return AlgebraicNumber(None, [x], None)
    if isinstance(x, _F):
        return AlgebraicNumber(None, [x], None)
    if type(x).__name__ in ("Rational", "Integer"):
        return AlgebraicNumber(None, [_F(x)], None)
    if isinstance(x, float):
        raise TypeError("Illegal initializer for algebraic number")
    import _sage_nf
    if isinstance(x, _sage_nf.NumberFieldElement):
        return _from_nf_element(x)
    s = getattr(x, "_s", None)
    if s is not None:
        return _from_expr(x)
    raise TypeError("Illegal initializer for algebraic number")


def _from_expr(e):
    s = e._s
    if s.startswith("n"):
        num, den = s[1:].rstrip(";").split("/")
        return AlgebraicNumber(None, [_F(int(num), int(den))], None)
    op = e._op()
    tag = op[0]
    import _sage_expr
    args = [_sage_expr.Expression(t) for t in op[1:]]
    if tag == "complex":
        body = s[1:].split(";")
        re, im = _F(body[0]), _F(body[1])
        return _gaussian(re, im)
    if tag == "add":
        r = _convert(args[0])
        for a in args[1:]:
            r = r + _convert(a)
        return r
    if tag == "mul":
        r = _convert(args[0])
        for a in args[1:]:
            r = r * _convert(a)
        return r
    if tag == "pow":
        b, x = _convert(args[0]), _convert(args[1])
        if not x._is_rational():
            raise TypeError("Illegal initializer for algebraic number")
        q = x._q()
        if q.denominator == 1:
            return b ** int(q)
        return b.nth_root(q.denominator) ** q.numerator
    if tag == "neg":
        return -_convert(args[0])
    raise TypeError("Illegal initializer for algebraic number")


def _from_nf_element(x):
    K = x.parent()
    f = _primitive(K._poly) if hasattr(K, "_poly") else None
    raise TypeError("Illegal initializer for algebraic number")


# ------------------------------------------------------------------ linear algebra over Q[z]/(g)

def _nf_eigen_kernel(rows, g):
    """An echelonized basis of the right kernel of rows - z I over the
    number field Q[z]/(g): vectors of coefficient lists (constant first)."""
    n = len(rows)
    m = [[[_F(rows[i][j])] if rows[i][j] else [] for j in range(n)] for i in range(n)]
    for i in range(n):
        m[i][i] = _psub(m[i][i], [0, 1])
    basis = _nf_kernel(m, g, n)
    if not basis:
        return []
    return _nf_rref(basis, g, n)[0]


def _nf_rref(m, g, ncols):
    m = [list(r) for r in m]
    piv = []
    r = 0
    for c in range(ncols):
        p = next((i for i in range(r, len(m)) if m[i][c]), None)
        if p is None:
            continue
        m[r], m[p] = m[p], m[r]
        inv = _pinv(m[r][c], g)
        m[r] = [_pmod(_pmul(x, inv), g) for x in m[r]]
        for i in range(len(m)):
            if i != r and m[i][c]:
                f = m[i][c]
                m[i] = [_psub(x, _pmod(_pmul(f, y), g)) for x, y in zip(m[i], m[r])]
        piv.append(c)
        r += 1
        if r == len(m):
            break
    return [row for row in m if any(row)], piv


def _nf_kernel(m, g, ncols):
    red = _nf_rref(m, g, ncols)
    rows, piv = red
    free = [j for j in range(ncols) if j not in piv]
    out = []
    for f in free:
        v = [[] for _ in range(ncols)]
        v[f] = [_F(1)]
        for i, p in enumerate(piv):
            v[p] = _psub([], rows[i][f])
        out.append(v)
    return out


# ------------------------------------------------------------------ embedding number field data

def _roots_of(f_int, T=AlgebraicNumber):
    """The roots of the irreducible integer polynomial f in Sage's order, as
    elements of type T (one generator per root)."""
    if len(f_int) == 2:
        q = _F(-f_int[0], f_int[1])
        return [T(None, [q], None)]
    out = []
    rs, d = _sorted_roots(f_int)
    for z in rs:
        gen = _Gen(list(f_int), z, d)
        out.append(T(gen, [0, 1], gen.civ))
    return out


def _embed_nf(c, root):
    """The element c(z) (c rational coefficients, constant first) for z the
    generator of the algebraic number `root`; its display interval is
    Horner's rule on the generator's interval, as when Sage embeds a number
    field element."""
    if root._gen is None:
        v = sum(_F(x) * root._q() ** i for i, x in enumerate(c))
        return AlgebraicNumber(None, [v], None)
    return AlgebraicNumber(root._gen, _pmod(list(c), root._gen.g), None)
