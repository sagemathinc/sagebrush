"""Power series and Laurent series in one variable, as in Sage:
R.<t> = PowerSeriesRing(QQ), QQ[['t']], LaurentSeriesRing(GF(7), 'T'),
f = t + 3*t^2 + O(t^4); arithmetic with Sage's precision rules, inverses
(Laurent series when the valuation is positive), exp, log, sqrt,
derivatives, integrals and reversion; printed as Sage prints them.

A series is x^v (c_0 + c_1 x + ...) + O(x^prec), stored as the valuation v,
the coefficients c_i (c_0 nonzero) and the absolute precision prec (None for
an exact element, a polynomial)."""

from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


_RINGS = {}


def PowerSeriesRing(base, name=None, default_prec=20, names=None, sparse=False, **kwds):
    """The ring of power series over base.

    EXAMPLES::

        sage: R.<T> = PowerSeriesRing(GF(7)); R
        Power Series Ring in T over Finite Field of size 7
        sage: f = T + 3*T^2 + T^3 + O(T^4); f^3, 1/f
        (T^3 + 2*T^4 + 2*T^5 + O(T^6), T^-1 + 4 + T + O(T^2))
    """
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    if name is None:
        name = "x"
    if isinstance(name, (list, tuple)):
        name = name[0]
    key = ("P", id(base), str(name), int(default_prec))
    if key not in _RINGS:
        _RINGS[key] = SeriesRing_(base, str(name), int(default_prec), False)
    return _RINGS[key]


def LaurentSeriesRing(base, name=None, default_prec=20, names=None, sparse=False, **kwds):
    """The ring of Laurent series over base.

    EXAMPLES::

        sage: R.<x> = LaurentSeriesRing(QQ); R
        Laurent Series Ring in x over Rational Field
        sage: 1/(1 - x) + O(x^10)
        1 + x + x^2 + x^3 + x^4 + x^5 + x^6 + x^7 + x^8 + x^9 + O(x^10)
    """
    if names is not None:
        name = names[0] if isinstance(names, (list, tuple)) else names
    if name is None:
        name = "x"
    if isinstance(name, (list, tuple)):
        name = name[0]
    key = ("L", id(base), str(name), int(default_prec))
    if key not in _RINGS:
        _RINGS[key] = SeriesRing_(base, str(name), int(default_prec), True)
    return _RINGS[key]


class SeriesRing_:
    """A power series ring or Laurent series ring.

    EXAMPLES::

        sage: R.<t> = PowerSeriesRing(QQ, default_prec=10); R.default_prec()
        10
    """

    def __init__(self, base, name, default_prec, laurent):
        self._base, self._name, self._dp, self._laurent = base, name, default_prec, laurent
        sa = _sa()
        self._exact = base is sa.QQ or base is sa.ZZ

    def _div(self, a, b):
        """a / b in the base field (exactly for rationals)."""
        if self._exact:
            from _sage_poly import _norm
            return _norm(_F(a) / _F(b))
        return a / b

    def __repr__(self):
        return "%s Series Ring in %s over %r" % ("Laurent" if self._laurent else "Power", self._name, self._base)

    def _latex_(self):
        return "%s[[%s]]" % (getattr(self._base, "_latex_", lambda: repr(self._base))(), self._name)

    def __eq__(self, o):
        return isinstance(o, SeriesRing_) and (o._base, o._name, o._laurent) == (self._base, self._name, self._laurent)

    def __hash__(self):
        return hash((repr(self._base), self._name, self._laurent))

    def base_ring(self):
        """The ring of coefficients.

        EXAMPLES::

            sage: QQ[['x']].base_ring()
            Rational Field
        """
        return self._base

    def variable_name(self):
        """The name of the variable.

        EXAMPLES::

            sage: QQ[['x']].variable_name()
            'x'
        """
        return self._name

    def default_prec(self):
        """The default precision.

        EXAMPLES::

            sage: PowerSeriesRing(QQ, 'x', default_prec=5).default_prec()
            5
        """
        return _sa().Integer(self._dp)

    def gen(self, i=0):
        """The variable.

        EXAMPLES::

            sage: QQ[['x']].gen()
            x
        """
        return Series(self, 1, [self._one()], None)

    def gens(self):
        """(the variable,).

        EXAMPLES::

            sage: QQ[['x']].gens()
            (x,)
        """
        return (self.gen(),)

    def _first_ngens(self, k):
        return (self.gen(),)[:k]

    def ngens(self):
        """1.

        EXAMPLES::

            sage: QQ[['x']].ngens()
            1
        """
        return 1

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: QQ[['x']].is_exact()
            False
        """
        return False

    def is_field(self, proof=True):
        """Whether this is a field (Laurent series over a field).

        EXAMPLES::

            sage: QQ[['x']].is_field(), LaurentSeriesRing(QQ, 'x').is_field()
            (False, True)
        """
        return self._laurent

    def laurent_series_ring(self):
        """The Laurent series ring with the same variable.

        EXAMPLES::

            sage: QQ[['x']].laurent_series_ring()
            Laurent Series Ring in x over Rational Field
        """
        return LaurentSeriesRing(self._base, self._name, self._dp)

    def power_series_ring(self):
        """The power series ring with the same variable.

        EXAMPLES::

            sage: LaurentSeriesRing(QQ, 'x').power_series_ring()
            Power Series Ring in x over Rational Field
        """
        return PowerSeriesRing(self._base, self._name, self._dp)

    def characteristic(self):
        """The characteristic of the base ring.

        EXAMPLES::

            sage: PowerSeriesRing(GF(7), 'T').characteristic()
            7
        """
        return self._base.characteristic()

    def zero(self):
        """0.

        EXAMPLES::

            sage: QQ[['x']].zero()
            0
        """
        return Series(self, 0, [], None)

    def one(self):
        """1.

        EXAMPLES::

            sage: QQ[['x']].one()
            1
        """
        return self(1)

    def _one(self):
        return self._base(1)

    def _zero(self):
        return self._base(0)

    def __call__(self, x=0, prec=None):
        """Convert x (a number, polynomial, series, list of coefficients).

        EXAMPLES::

            sage: R.<t> = QQ[[]]; R([1, 2, 3]), R(1/(1 - t)), R(5)
            (1 + 2*t + 3*t^2, 1 + t + t^2 + t^3 + t^4 + t^5 + t^6 + t^7 + t^8 + t^9 + t^10 + t^11 + t^12 + t^13 + t^14 + t^15 + t^16 + t^17 + t^18 + t^19 + O(t^20), 5)
        """
        if isinstance(x, Series):
            if x._R is self:
                r = x
            else:
                if not self._laurent and x._v < 0:
                    raise TypeError("self is not a power series")
                r = Series(self, x._v, [self._base(c) for c in x._c], x._prec)
            return r.add_bigoh(prec) if prec is not None else r
        if isinstance(x, (list, tuple)):
            r = Series(self, 0, [self._base(c) for c in x], None)
            return r.add_bigoh(prec) if prec is not None else r
        if hasattr(x, "list") and hasattr(x, "degree") and hasattr(x, "parent") and not isinstance(x, (int, _F)):
            r = Series(self, 0, [self._base(c) for c in x.list()], None)
            return r.add_bigoh(prec) if prec is not None else r
        if type(x).__name__ == "FractionFieldElement":
            num, den = self(x.numerator()), self(x.denominator())
            r = num / den
            return r.add_bigoh(prec) if prec is not None else r
        c = self._base(x)
        r = Series(self, 0, [c], None)
        return r.add_bigoh(prec) if prec is not None else r

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False


def _is_zero(c):
    try:
        return not c
    except Exception:
        return c == 0


class Series:
    """A power series or Laurent series.

    EXAMPLES::

        sage: R.<w> = QQ[[]]; ps = w + 17/2*w^2 + 15/4*w^4 + O(w^6); ps
        w + 17/2*w^2 + 15/4*w^4 + O(w^6)
        sage: ps.exp()
        1 + w + 9*w^2 + 26/3*w^3 + 265/6*w^4 + 413/10*w^5 + O(w^6)
        sage: ps.prec(), ps.valuation(), ps.list()
        (6, 1, [0, 1, 17/2, 0, 15/4])
    """

    __slots__ = ("_R", "_v", "_c", "_prec")

    def __init__(self, R, v, c, prec):
        c = list(c)
        # normalize: strip leading zeros into the valuation, trailing zeros,
        # terms at or beyond the precision
        k = 0
        while k < len(c) and _is_zero(c[k]):
            k += 1
        c = c[k:]
        v += k
        if prec is not None:
            c = c[:max(0, prec - v)]
        while c and _is_zero(c[-1]):
            c.pop()
        if not c:
            v = prec if prec is not None else 0
        self._R, self._v, self._c, self._prec = R, v, c, prec

    # ---- data
    def parent(self):
        """The series ring.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; t.parent()
            Power Series Ring in t over Rational Field
        """
        return self._R

    def prec(self):
        """The absolute precision (+Infinity for an exact series).

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + O(t^5)).prec(), t.prec()
            (5, +Infinity)
        """
        return _sa().Integer(self._prec) if self._prec is not None else _sa().infinity

    def precision_absolute(self):
        """The absolute precision.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + O(t^4)).precision_absolute()
            4
        """
        return self.prec()

    def precision_relative(self):
        """prec - valuation.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t^2 + O(t^5)).precision_relative()
            3
        """
        if self._prec is None:
            return _sa().infinity
        return _sa().Integer(self._prec - self._v)

    def valuation(self):
        """The exponent of the first nonzero term.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t^2 + t^3 + O(t^5)).valuation()
            2
        """
        if not self._c:
            return self.prec()
        return _sa().Integer(self._v)

    def degree(self):
        """The largest exponent of a nonzero term.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + 3*t^4 + O(t^6)).degree()
            4
        """
        if not self._c:
            return _sa().Integer(-1)
        return _sa().Integer(self._v + len(self._c) - 1)

    def list(self):
        """The coefficients from x^0 (power series) or x^valuation.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + 2*t^3 + O(t^5)).list()
            [0, 1, 0, 2]
        """
        out = self._R._base
        if self._v >= 0:
            return [_out(c) for c in [self._R._zero()] * self._v + self._c]
        return [_out(c) for c in self._c]

    def padded_list(self, n=None):
        """The first n coefficients (zeros beyond the known ones).

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (1 + t + O(t^3)).padded_list(5)
            [1, 1, 0, 0, 0]
        """
        L = self.list()
        if n is None:
            n = self._prec if self._prec is not None else len(L)
        return (L + [_out(self._R._zero())] * n)[:n]

    def coefficients(self):
        """The nonzero coefficients.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + 17/2*t^2 + 15/4*t^4 + O(t^6)).coefficients()
            [1, 17/2, 15/4]
        """
        return [_out(c) for c in self._c if not _is_zero(c)]

    def exponents(self):
        """The exponents of the nonzero terms.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + 2*t^3 + O(t^5)).exponents()
            [1, 3]
        """
        return [self._v + i for i, c in enumerate(self._c) if not _is_zero(c)]

    def __getitem__(self, n):
        if isinstance(n, slice):
            raise NotImplementedError("slices of series")
        n = int(n)
        k = n - self._v
        if 0 <= k < len(self._c):
            return _out(self._c[k])
        return _out(self._R._zero())

    def variable(self):
        """The name of the variable.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; t.variable()
            't'
        """
        return self._R._name

    def is_zero(self):
        """Whether all known coefficients are 0.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; O(t^3).is_zero(), t.is_zero()
            (True, False)
        """
        return not self._c

    def __bool__(self):
        return bool(self._c)

    def is_unit(self):
        """Whether invertible in the power series ring.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (1 + t).is_unit(), t.is_unit()
            (True, False)
        """
        return bool(self._c) and self._v == 0

    # ---- printing
    def __repr__(self):
        name = self._R._name
        parts = []
        for i, c in enumerate(self._c):
            if _is_zero(c):
                continue
            e = self._v + i
            parts.append(_term(c, e, name))
        if self._prec is not None:
            parts.append((False, "O(%s)" % (_mono(name, self._prec) if self._prec != 0 else "1")))
        if not parts:
            return "0"
        s = ("-" if parts[0][0] else "") + parts[0][1]
        for neg, t in parts[1:]:
            s += (" - " if neg else " + ") + t
        return s

    __str__ = __repr__

    def _latex_(self):
        import re
        return re.sub(r"\^(-?\d+)", r"^{\1}", repr(self).replace("*", " "))

    # ---- arithmetic
    def _coerce(self, o):
        if isinstance(o, Series):
            if o._R == self._R:
                return o
            if o._R._laurent and not self._R._laurent and o._R._base == self._R._base:
                return o
            return self._R(o)
        try:
            return self._R(o)
        except (TypeError, ValueError, ArithmeticError):
            return None

    def _ring_for(self, o, v):
        R = self._R
        if isinstance(o, Series) and o._R._laurent:
            R = o._R
        if v < 0 and not R._laurent:
            R = R.laurent_series_ring()
        return R

    def __add__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        p = _minp(self._prec, o._prec)
        v = min(self._v if self._c else (p if p is not None else 0), o._v if o._c else (p if p is not None else 0))
        n = max(self._v + len(self._c), o._v + len(o._c)) - v
        if p is not None:
            n = min(n, max(0, p - v))
        c = [self._R._zero()] * max(0, n)
        for i, x in enumerate(self._c):
            k = self._v + i - v
            if 0 <= k < len(c):
                c[k] = c[k] + x
        for i, x in enumerate(o._c):
            k = o._v + i - v
            if 0 <= k < len(c):
                c[k] = c[k] + x
        return Series(self._ring_for(o, v), v, c, p)

    __radd__ = __add__

    def __neg__(self):
        return Series(self._R, self._v, [-c for c in self._c], self._prec)

    def __sub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return self + (-o)

    def __rsub__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return o + (-self)

    def __mul__(self, o):
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        # absolute precision: min(v(a) + prec(b), v(b) + prec(a))
        va = self._v if self._c else (self._prec or 0)
        vb = o._v if o._c else (o._prec or 0)
        p = _minp(None if self._prec is None else self._prec + vb, None if o._prec is None else o._prec + va)
        v = va + vb
        n = len(self._c) + len(o._c) - 1
        if p is not None:
            n = min(n, max(0, p - v))
        c = [self._R._zero()] * max(0, n)
        for i, x in enumerate(self._c):
            if i >= n:
                break
            for j, y in enumerate(o._c):
                if i + j >= n:
                    break
                c[i + j] = c[i + j] + x * y
        return Series(self._ring_for(o, v), v, c, p)

    __rmul__ = __mul__

    def __truediv__(self, o):
        o2 = self._coerce(o)
        if o2 is None:
            return NotImplemented
        if not o2._c:
            raise ZeroDivisionError("division by zero series")
        if o2._prec is None and len(o2._c) == 1 and o2._v == 0 and self._prec is None:
            # exact division by a constant stays exact
            return Series(self._R, self._v, [self._R._div(c, o2._c[0]) for c in self._c], None)
        return self * o2.inverse()

    def __rtruediv__(self, o):
        o = self._coerce(o)
        return o / self

    def inverse(self):
        """1/self (a Laurent series when the valuation is positive).

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (1 + q + O(q^3)).inverse(), (q^2 + q^3 + O(q^5))^-1
            (1 - q + q^2 + O(q^3), q^-2 - q^-1 + 1 + O(q))
        """
        if not self._c:
            raise ZeroDivisionError("division by zero series")
        R = self._R
        rel = (self._prec - self._v) if self._prec is not None else R._dp
        c0inv = R._div(1, self._c[0])
        a = self._c + [R._zero()] * rel
        b = [R._zero()] * rel
        b[0] = c0inv
        for n in range(1, rel):
            s = R._zero()
            for k in range(1, n + 1):
                if not _is_zero(a[k]):
                    s = s + a[k] * b[n - k]
            b[n] = -s * c0inv
        v = -self._v
        if v < 0 and not R._laurent:
            R = R.laurent_series_ring()
        return Series(R, v, b, v + rel)

    __invert__ = inverse

    def __pow__(self, n, mod=None):
        if isinstance(n, _F) and n.denominator != 1 or (isinstance(n, float)):
            return self._rpow(n)
        n = int(n)
        if n < 0:
            return self.inverse() ** (-n)
        r = self._R(1)
        b = self
        while n:
            if n & 1:
                r = r * b
            n >>= 1
            if n:
                b = b * b
        return r

    def _rpow(self, e):
        e = _F(e)
        if self._v != 0:
            if (self._v * e).denominator != 1:
                raise ValueError("the valuation times the exponent must be an integer")
        c0 = self._c[0]
        if c0 != 1:
            raise NotImplementedError("rational powers need constant term 1")
        return (self.log() * self._R._base(e)).exp()

    def __eq__(self, o):
        o = self._coerce(o)
        if o is None:
            return False
        d = self - o
        return not d._c

    def __ne__(self, o):
        return not self == o

    def __hash__(self):
        return hash((self._v, tuple(self._c)))

    # ---- precision
    def add_bigoh(self, prec):
        """The series truncated to precision O(x^prec).

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (1 + t + O(t^5)).add_bigoh(3)
            1 + t + O(t^3)
        """
        p = _minp(self._prec, int(prec))
        return Series(self._R, self._v, self._c, p)

    O = add_bigoh

    def truncate(self, prec=None):
        """The polynomial of the terms below prec.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (1 + 2*t + 3*t^2 + O(t^5)).truncate(2)
            2*t + 1
        """
        from _sage_poly import PolynomialRing
        P = PolynomialRing(self._R._base, self._R._name)
        n = prec if prec is not None else (self._prec if self._prec is not None else self._v + len(self._c))
        L = self.list()[:max(0, int(n))] if self._v >= 0 else self.list()
        return P(L)

    polynomial = truncate

    def common_prec(self, o):
        """The smaller of the two precisions.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (t + O(t^3)).common_prec(t + O(t^5))
            3
        """
        return _minp(self._prec, o._prec)

    # ---- calculus
    def derivative(self, *args):
        """The derivative.

        EXAMPLES::

            sage: R.<w> = QQ[[]]; (w + 17/2*w^2 + 15/4*w^4 + O(w^6)).derivative()
            1 + 17*w + 15*w^3 + O(w^5)
        """
        R = self._R
        c = [self._c[i] * (self._v + i) for i in range(len(self._c))]
        return Series(R, self._v - 1, c, self._prec - 1 if self._prec is not None else None)

    diff = differentiate = derivative

    def integral(self, var=None):
        """The integral with constant term 0.

        EXAMPLES::

            sage: R.<w> = QQ[[]]; (w + 17/2*w^2 + 15/4*w^4 + O(w^6)).integral()
            1/2*w^2 + 17/6*w^3 + 3/4*w^5 + O(w^7)
        """
        R = self._R
        if any(self._v + i == -1 and not _is_zero(c) for i, c in enumerate(self._c)):
            raise ArithmeticError("the integral of a series with a 1/x term")
        c = [R._div(self._c[i], self._v + i + 1) for i in range(len(self._c))]
        return Series(R, self._v + 1, c, self._prec + 1 if self._prec is not None else None)

    def exp(self, prec=None):
        """exp(self), for a series with constant term 0.

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (q + O(q^5)).exp()
            1 + q + 1/2*q^2 + 1/6*q^3 + 1/24*q^4 + O(q^5)
        """
        R = self._R
        if self._c and self._v < 1:
            if self._v == 0 and not _is_zero(self._c[0]):
                raise ValueError("can only take the exponential of a series with constant term 0")
        p = self._prec if self._prec is not None else (prec or R._dp)
        # f' = g' f, f(0) = 1
        g = [self[i] for i in range(p)]
        f = [R._zero()] * p
        f[0] = R._one()
        for n in range(1, p):
            s = R._zero()
            for k in range(1, n + 1):
                if not _is_zero(g[k]):
                    s = s + R._base(k) * R._base(g[k]) * f[n - k]
            f[n] = R._div(s, n)
        return Series(R if not R._laurent else R, 0, f, p)

    def log(self, prec=None):
        """log(self), for a series with constant term 1.

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (1 + q + O(q^4)).log()
            q - 1/2*q^2 + 1/3*q^3 + O(q^4)
        """
        if self._v != 0 or self._c[0] != 1:
            raise ValueError("can only take the logarithm of a series with constant term 1")
        return (self.derivative() / self).integral()

    def sqrt(self, prec=None):
        """The square root, for a series with constant term a square.

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (1 + q + O(q^5)).sqrt()
            1 + 1/2*q - 1/8*q^2 + 1/16*q^3 - 5/128*q^4 + O(q^5)
        """
        R = self._R
        if self._v % 2:
            raise ValueError("the valuation must be even")
        c0 = self._c[0]
        s0 = _sa().sqrt(c0) if not hasattr(c0, "sqrt") else c0.sqrt()
        p = self._prec if self._prec is not None else (self._v + (prec or R._dp))
        rel = p - self._v
        a = self._c + [R._zero()] * rel
        b = [R._zero()] * rel
        b[0] = R._base(s0)
        two_b0 = 2 * b[0]
        for n in range(1, rel):
            s = a[n]
            for k in range(1, n):
                s = s - b[k] * b[n - k]
            b[n] = R._div(s, two_b0)
        return Series(R, self._v // 2, b, self._v // 2 + rel)

    def reverse(self, precision=None):
        """The compositional inverse (for valuation 1).

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (q - q^3 + O(q^6)).reverse()
            q + q^3 + 3*q^5 + O(q^6)
        """
        R = self._R
        if self._v != 1:
            raise ValueError("the series must have valuation 1")
        p = self._prec if self._prec is not None else (precision or R._dp)
        # Newton-free: solve g(f) = x term by term
        g = Series(R, 1, [R._div(1, self._c[0])], p)
        for n in range(2, p):
            comp = self._compose_into(g, p)
            err = comp - R.gen()
            e = err[n]
            if not _is_zero(e):
                g = g - Series(R, n, [R._div(e, self._c[0])], p)
        return g

    def _compose_into(self, g, p):
        """self(g) to precision p (g of positive valuation)."""
        R = self._R
        res = Series(R, 0, [], p)
        pw = Series(R, 0, [R._one()], p)
        for k in range(0, p):
            if k >= self._v:
                c = self[k]
                if not _is_zero(c):
                    res = res + pw * R._base(c)
            pw = (pw * g).add_bigoh(p)
        return res

    def __call__(self, x):
        """Substitute x (a number, or a series of positive valuation).

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (1 + t + t^2)(2), (1 + t + O(t^3))(t^2)
            (7, 1 + t^2 + O(t^6))
        """
        if isinstance(x, Series):
            if x._v < 1:
                raise ValueError("can only substitute series of positive valuation")
            p = None
            if self._prec is not None:
                p = self._prec * x._v
            if x._prec is not None:
                q = x._prec + (self._v - 1) * x._v if self._c else x._prec
                p = q if p is None else min(p, q)
            pp = p if p is not None else self._R._dp
            res = Series(x._R, 0, [], p)
            pw = Series(x._R, 0, [x._R._one()], None)
            for k in range(0, self._v + len(self._c)):
                c = self[k]
                if not _is_zero(c):
                    res = res + pw * x._R._base(c)
                pw = pw * x
                if pw._v >= pp:
                    break
            return res.add_bigoh(p) if p is not None else res
        if self._prec is not None:
            raise ValueError("cannot evaluate a series with finite precision at a number")
        s = 0
        for i, c in enumerate(self._c):
            s = s + _out(c) * x ** (self._v + i)
        return s


def _minp(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


def _out(c):
    if isinstance(c, _F) or type(c).__name__ == "Rational":
        from _sage_poly import _norm
        return _norm(c)
    return c


def _mono(name, e):
    return name if e == 1 else "%s^%d" % (name, e)


def _term(c, e, name):
    """(negative, text) of the term c*x^e."""
    s = repr(_out(c))
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    if " + " in s or " - " in s:
        s = "(" + s + ")"
    if e == 0:
        return neg, s
    m = _mono(name, e)
    if s == "1":
        return neg, m
    return neg, s + "*" + m


def O(x):
    """The big-oh term O(x^n), for x^n a power of a series variable.

    EXAMPLES::

        sage: R.<t> = QQ[[]]; O(t^3), t + O(t^3)
        (O(t^3), t + O(t^3))
    """
    if isinstance(x, Series):
        if len(x._c) != 1:
            raise ValueError("O(x) is defined only for x a power of the variable")
        return Series(x._R, x._v, [], x._v)
    if hasattr(x, "degree") and hasattr(x, "list") and hasattr(x, "parent"):
        R = x.parent()
        S = PowerSeriesRing(R.base_ring(), R.variable_name())
        return Series(S, 0, [], int(x.degree()))
    if type(x).__name__ in ("Integer", "int") or isinstance(x, int):
        from sage_all import Integer
        raise NotImplementedError("p-adic big-oh O(p^n) is not available in sagebrush yet")
    raise NotImplementedError("O(%r)" % (x,))
