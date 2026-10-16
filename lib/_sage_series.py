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
        """a / b in the base ring (exactly for rationals; over ZZ only an
        exact quotient: 1/2 is not a coefficient of ZZ[[x]])."""
        if self._exact:
            from _sage_poly import _norm
            q = _F(a) / _F(b)
            if self._base is _sa().ZZ and q.denominator != 1:
                raise ArithmeticError("%s/%s is not in Integer Ring (use a series ring over QQ)" % (a, b))
            return _norm(q)
        if _is_padic(self._base) and not self._base._field:
            # stay in Zp: b is a unit there (inverse() checks)
            return a * self._base(b).inverse_of_unit()
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
        return self._laurent and self._base.is_field()

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


def _is_padic(B):
    return type(B).__name__ in ("pAdicRingCappedRelative", "pAdicFieldCappedRelative")


def _frac(B):
    """The fraction field of the base B (QQ for ZZ, Qp for Zp); B itself
    for a field."""
    sa = _sa()
    if B is sa.ZZ:
        return sa.QQ
    if _is_padic(B) and not B._field:
        return B.fraction_field()
    return B


def _is_unit(c, B):
    """Whether the coefficient c is a unit of the base B."""
    if B is _sa().ZZ:
        return c == 1 or c == -1
    if _is_padic(B):
        return not c.is_zero() and (B._field or c.valuation() == 0)
    return not _is_zero(c)


def _exact_quo(x, c, B):
    """x / c in the base B when it lies there (over ZZ when c divides x,
    over Zp when v(x) >= v(c)), else None."""
    if B is _sa().ZZ:
        q, r = divmod(int(x), int(c))
        return _sa().Integer(q) if r == 0 else None
    if _is_padic(B):
        if x.valuation() < c.valuation():
            return None
        return B(x / c)
    return x / c


def _inexact(c):
    """Whether c is a p-adic coefficient of finite precision (O(p^k) too)."""
    return hasattr(c, "_x") and type(c).__name__ in ("pAdicCappedRelativeElement", "EisensteinExtensionElement") and not c._x.is_exact_zero()


def _is_zero(c):
    # (a p-adic coefficient O(p^n) is kept, as Sage prints it: O(5)*T)
    if hasattr(c, "_x") and type(c).__name__ in ("pAdicCappedRelativeElement", "EisensteinExtensionElement"):
        return c._x.is_exact_zero()
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

    Series compare at their common precision, so only exact ones hash:
    a series of finite precision, or with a coefficient of finite
    precision (O(p^k) included), is unhashable (Sage hashes the latter by
    value, though R([B(1, 2)]) == R([B(10, 3)]))::

        sage: B = Qp(3, 5); R = PowerSeriesRing(B, 'T'); a, b = R([B(1, 2)]), R([B(10, 3)])
        sage: a == b, b == a
        (True, True)
        sage: hash(a)  # sagebrush only
        Traceback (most recent call last):
        ...
        TypeError: unhashable: a power series with inexact coefficients [1 + O(3^2)]
        sage: R([B(0, 2)]) == 9, hash(R([B(0)])) == hash(0), hash(w^2 + 1) == hash(w^2 + 1)
        (True, True, True)
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

            sage: R.<t> = QQ[[]]; (t + 2*t^3 + O(t^5)).list(), O(t^3).list()
            ([0, 1, 0, 2], [])
        """
        out = self._R._base
        if not self._c:
            # (no coefficients known, as in O(t^3): [] as Sage gives, but
            # [0] over Qp and Zp, whose series list like their polynomials)
            return [_out(self._R._zero())] if _is_padic(self._R._base) else []
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
            sage: K = Qp(3, 5)
            sage: S.<T> = K[[]]
            sage: f = K(0, 2) + K(0, 1)*T + O(T^3); f, f.is_zero()
            (O(T^3), True)
        """
        # (p-adic coefficients O(p^k) count as 0, as in Sage)
        return all(not c for c in self._c)

    def __bool__(self):
        """False exactly when is_zero() (p-adic coefficients O(p^k) count as
        0, as in Sage).

        EXAMPLES::

            sage: K = Qp(3, 5)
            sage: S.<T> = K[[]]
            sage: bool(K(0, 2) + K(0, 1)*T + O(T^3)), bool(K(0, 2) + K(1, 1)*T + O(T^3))
            (False, True)
            sage: R.<t> = QQ[[]]; bool(O(t^3)), bool(t)
            (False, True)
        """
        return not self.is_zero()

    def is_unit(self):
        """Whether invertible in the power series ring.

        EXAMPLES::

            sage: R.<t> = QQ[[]]; (1 + t).is_unit(), t.is_unit()
            (True, False)
        """
        # the leading coefficient must be a unit of the base ring (2 is not
        # one in ZZ[[z]]); a Laurent series may have any valuation
        if not self._c or (self._v != 0 and not self._R._laurent):
            return False
        c = self._c[0]
        B = self._R._base
        return bool(c) if B.is_field() else (B(c).is_unit() if hasattr(B(c), "is_unit") else abs(int(c)) == 1)

    # ---- printing
    def __repr__(self):
        name = self._R._name
        parts = []
        # a series whose coefficients are all 0 to their precision shows
        # only its O() (Sage: O(T^3), not O(3^2) + O(3)*T + O(T^3))
        cs = [] if self.is_zero() else self._c
        for i, c in enumerate(cs):
            if _is_zero(c):
                continue
            e = self._v + i
            parts.append(_term(c, e, name, self._R._laurent))
        if self._prec is not None:
            if not parts:
                # (a bare O() shows its exponent: O(t^1), O(t^0), as Sage)
                parts.append((False, "O(%s^%d)" % (name, self._prec)))
            else:
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
            if o._R is self._R:
                return o
            if o._R == self._R:
                # the same ring but another default precision: self's (Sage)
                return Series(self._R, o._v, o._c, o._prec)
            if o._R._laurent and not self._R._laurent and o._R._base == self._R._base:
                return o
            return self._R(o)
        try:
            return self._R(o)
        except (TypeError, ValueError, ArithmeticError):
            return None

    def _lift_base(self, o):
        """self, moved to the common parent Sage uses with o when that
        differs, else self: the series ring over _target_base(o), and a
        Laurent series ring if either operand is one (QQ[[z]] meets a
        Laurent series over ZZ in QQ((z)), whichever comes first; the
        review's CORR-078-1)."""
        R = self._R
        base = self._target_base(o)
        laurent = R._laurent or (isinstance(o, Series) and o._R._laurent)
        if base is R._base and laurent == R._laurent:
            return self
        # the default precision as Sage: the other operand's parent when it
        # is the common one, the larger of the two when the common parent is
        # new (QQ[[z]], default 5, meets ZZ((z)), default 20, in QQ((z))
        # with 20), self's with a scalar (the review's CORR-6F0-1)
        dp = R._dp
        if isinstance(o, Series):
            S = o._R
            dp = S._dp if (base is S._base and laurent == S._laurent) else max(R._dp, S._dp)
        return self._over(base, laurent=laurent, dp=dp)

    def _target_base(self, o):
        """The coefficient ring of self's parent with o.  p-adic bases: an
        element of Y joins a series over X in X if Y coerces into X, else
        over the p-adics with the larger cap, a field if either is
        (Zp(5, 4)[[T]] times an element of Zp(5) lands in Zp(5, 20)[[T]];
        Zp(5, 20)[[T]] plus one of Qp(5, 4) in Qp(5, 20)[[T]]); two series
        meet in the base that the other coerces into, else in the same
        pushout.  ZZ: the fraction field when o needs it (ZZ[[z]] meets 1/2
        or a series over QQ in QQ[[z]]).  Otherwise the base."""
        B = self._R._base
        if _is_padic(B):
            if isinstance(o, Series):
                P = o._R._base
            elif type(o).__name__ == "pAdicCappedRelativeElement":
                P = o.parent()
            else:
                return B
            if P is B or not _is_padic(P) or P.prime() != B.prime():
                return B
            from _sage_padic import _series_pushout, _coerces
            if isinstance(o, Series) and not _coerces(P, B) and _coerces(B, P):
                return P
            return _series_pushout(B, P)
        F = _frac(B)
        if F is B:
            return B
        if isinstance(o, Series):
            return F if o._R._base is F else B
        try:
            B(o)
            return B
        except (TypeError, ValueError, ArithmeticError):
            pass
        try:
            F(o)
        except (TypeError, ValueError, ArithmeticError):
            return B
        return F

    def _over(self, base, laurent=None, dp=None):
        """self in the series ring over base (a Laurent series ring if asked;
        default precision dp, else self's)."""
        R = self._R
        lau = R._laurent if laurent is None else laurent
        return (LaurentSeriesRing if lau else PowerSeriesRing)(base, R._name, R._dp if dp is None else dp)(self)

    def _ring_for(self, o, v):
        R = self._R
        if isinstance(o, Series) and o._R._laurent and not R._laurent:
            R = o._R
        if v < 0 and not R._laurent:
            R = R.laurent_series_ring()
        return R

    def __add__(self, o):
        self._check_var(o, "+")
        lifted = self._lift_base(o)
        if lifted is not self:
            return lifted.__add__(o)
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

    def __radd__(self, o):
        return self.__add__(o)

    def __neg__(self):
        return Series(self._R, self._v, [-c for c in self._c], self._prec)

    def __sub__(self, o):
        self._check_var(o, "-")
        lifted = self._lift_base(o)
        if lifted is not self:
            return lifted.__sub__(o)
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return self + (-o)

    def __rsub__(self, o):
        lifted = self._lift_base(o)
        if lifted is not self:
            return lifted.__rsub__(o)
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return o + (-self)

    def __mul__(self, o):
        self._check_var(o, "*")
        lifted = self._lift_base(o)
        if lifted is not self:
            return lifted.__mul__(o)
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

    def __rmul__(self, o):
        return self.__mul__(o)

    def _check_var(self, o, op):
        """Series in different variables do not meet (Sage refuses)."""
        if isinstance(o, Series) and o._R._name != self._R._name:
            raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (op, self._R, o._R))

    def __truediv__(self, o):
        self._check_var(o, "/")
        B = self._R._base
        if _is_padic(B) and not isinstance(o, Series):
            # by a scalar: over the fraction field (Sage: T/2 and T/Zp(5)(2)
            # are over Qp; the review's CORR-D9E-2), joined with the
            # scalar's own fraction field
            F = B if B._field else B.fraction_field()
            if type(o).__name__ == "pAdicCappedRelativeElement" and o.parent().prime() == B.prime():
                from _sage_padic import _series_pushout
                F = _series_pushout(F, o.parent().fraction_field())
            s = self if F is B else self._over(F)
            c = F(o)
            if c.is_zero():
                raise ZeroDivisionError("division by zero")
            return Series(s._R, s._v, [x / c for x in s._c], s._prec)
        F = _frac(B)
        if F is not B and not isinstance(o, Series):
            # by a scalar: over the fraction field (Sage: z/2 and z/1 are in
            # QQ[[z]])
            s = self._over(F)
            c = F(o)
            if _is_zero(c):
                raise ZeroDivisionError("division by zero")
            return Series(s._R, s._v, [s._R._div(x, c) for x in s._c], s._prec)
        lifted = self._lift_base(o)
        if lifted is not self:
            return lifted.__truediv__(o)
        o2 = self._coerce(o)
        if o2 is None:
            return NotImplemented
        if not o2._c:
            raise ZeroDivisionError("division by zero series")
        if o2._R._laurent and not self._R._laurent:
            # by a Laurent series: the quotient is one too (Sage: z/L(1) in L)
            return self._over(self._R._base, laurent=True).__truediv__(o2)
        if F is not B:
            # over ZZ or Zp: Sage's rule for a base that is not a field
            return self._ring_div(o2)
        if not self._c and self._prec is None:
            # an exact zero stays exact (Sage: 0/(1 + t) is 0)
            return Series(self._R, 0, [], None)
        if o2._prec is None and len(o2._c) == 1 and o2._v == 0 and self._prec is None and not _is_padic(B):
            # exact division by a constant stays exact
            return Series(self._R, self._v, [self._R._div(c, o2._c[0]) for c in self._c], None)
        return self * o2.inverse()

    def _ring_div(self, g):
        """self / g over a base that is not a field (ZZ, Zp), as Sage (whose
        output served as the oracle).  By an exact monomial c z^v: if c is a
        unit, the quotient stays over the base when it is a power series or
        self is a Laurent series; a Laurent series is divided coefficient by
        coefficient when c divides each of them (2 w/2 = w; else Sage's
        refusal); otherwise the quotient is a Laurent series over the
        fraction field (z/(2 z) = 1/2, 1/z).  By anything else the constant
        term of g / z^v must be a unit (else ValueError), and the quotient
        stays over the base unless it needs negative powers in a power
        series ring (then: Laurent over the fraction field).  An exact zero
        stays exact.  (A Laurent divisor made self a Laurent series first.)"""
        R = self._R
        B = R._base
        vg = g._v
        vf = self._v if self._c else (self._prec if self._prec is not None else vg)
        prec = None if self._prec is None else self._prec - vg
        if g._prec is None and len(g._c) == 1:
            c = g._c[0]
            if _is_unit(c, B) and (vf >= vg or R._laurent):
                ci = R._div(1, c)
                return Series(R, self._v - vg, [x * ci for x in self._c], prec)
            if R._laurent:
                q = [_exact_quo(x, c, B) for x in self._c]
                if all(t is not None for t in q):
                    return Series(R, self._v - vg, q, prec)
                # (Sage's refusals: over ZZ, and over Zp)
                if _is_padic(B):
                    raise ValueError("negative valuation")
                raise ArithmeticError("division not defined")
        else:
            c0 = g._c[0]
            if not _is_unit(c0, B):
                raise ValueError("constant term %r is not a unit" % (c0,))
            if vf >= vg or R._laurent:
                if not self._c and self._prec is None:
                    return Series(R, 0, [], None)
                u = Series(g._R, 0, g._c, None if g._prec is None else g._prec - vg)
                return Series(R, self._v - vg, self._c, prec) * u.inverse()
        F = _frac(B)
        return self._over(F, laurent=True) / g._over(F, laurent=True)

    def __rtruediv__(self, o):
        lifted = self._lift_base(o)
        if lifted is not self:
            return lifted.__rtruediv__(o)
        o = self._coerce(o)
        if o is None:
            return NotImplemented
        return o / self

    def inverse(self):
        """1/self (a Laurent series when the valuation is positive).

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (1 + q + O(q^3)).inverse(), (q^2 + q^3 + O(q^5))^-1
            (1 - q + q^2 + O(q^3), q^-2 - q^-1 + 1 + O(q))

        Over ZZ the constant term must be a unit; an exact monomial is
        inverted in the fraction field::

            sage: Z.<z> = ZZ[[]]; (1 - z + O(z^4))^-1, z^-1, ~Z(2)
            (1 + z + z^2 + z^3 + O(z^4), z^-1, 1/2)
            sage: (2 + z)^-1
            Traceback (most recent call last):
            ...
            ValueError: constant term 2 is not a unit
            sage: z/2, (2*z)/z, z/(2*z), (1/z).parent()
            (1/2*z, 2, 1/2, Laurent Series Ring in z over Rational Field)
        """
        if not self._c:
            raise ZeroDivisionError("division by zero series")
        R = self._R
        B = R._base
        if self._prec is None and len(self._c) == 1:
            # an exact monomial has an exact inverse (Sage: 1/z is z^-1;
            # 1/2 in ZZ[[z]] is the Laurent series 1/2 over QQ)
            v = -self._v
            c = self._c[0]
            if not _is_unit(c, B):
                if v != 0:
                    raise ValueError("constant term %r is not a unit" % (c,))
                return Series(LaurentSeriesRing(_frac(B), R._name, R._dp), 0, [_frac(B)(1) / _frac(B)(c)], None)
            if v < 0 and not R._laurent:
                R = R.laurent_series_ring()
            return Series(R, v, [R._div(1, c)], None)
        if not _is_unit(self._c[0], B):
            # over ZZ (or Zp) the constant term must be a unit, as Sage
            raise ValueError("constant term %r is not a unit" % (self._c[0],))
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
        """Whether the difference is zero to the common precision: its
        coefficients are all 0, p-adic ones O(p^k) included, as for p-adic
        elements (so s == s for a series with inexact coefficients).

        EXAMPLES::

            sage: R.<t> = QQ[[]]; 1 + t + O(t^3) == 1 + t + t^3, 1 + t + O(t^3) == 1 + 2*t
            (True, False)
            sage: S.<T> = Qp(3, 5)[[]]; g = S([Qp(3, 5)(1, 2), 3], 4)
            sage: g == g, g == g + 9, g == g + 3, S([Qp(3, 5)(0, 2)], 3) == 0
            (True, True, False, True)
        """
        o = self._coerce(o)
        if o is None:
            return False
        return (self - o).is_zero()

    def __ne__(self, o):
        return not self == o

    def __hash__(self):
        # equality is at the common precision, so u + O(u^2) equals u + u^2
        # and u + u^3 alike: no hash of a finite-precision series can agree
        # with it (the second review's R2-EXT-F16); an exact series hashes as
        # the polynomial it equals
        if self._prec is not None:
            raise TypeError("unhashable: a power series of finite precision (%s)" % (self,))
        # likewise with a coefficient of finite precision, O(p^k) included:
        # R([Qp(3)(1, 2)]) equals R([Qp(3)(10, 3)]) (Sage hashes them apart)
        if any(_inexact(c) for c in self._c):
            raise TypeError("unhashable: a power series with inexact coefficients %s" % (list(self._c),))
        from _sage_poly import poly_hash
        n = self._R._name
        return poly_hash({((n, self._v + i),) if self._v + i else (): c for i, c in enumerate(self._c)})

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
        if self._R._laurent:
            # a Laurent series: the exact Laurent series of the terms below n
            k = max(0, int(n) - self._v)
            return Series(self._R, self._v, list(self._c[:k]), None)
        L = self.list()[:max(0, int(n))]
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
            sage: f = 1 + w + w^2 + w^3 + O(w^5); f.derivative(w, 2), f.derivative([w, w]), f.derivative(w, 0) == f
            (2 + 6*w + O(w^3), 2 + 6*w + O(w^3), True)

        A pure O-term keeps its uncertainty (Sage 10.10's Laurent series
        give 0 here, an exact zero)::

            sage: L.<z> = LaurentSeriesRing(QQ); O(z^3).derivative(), (z^-3 + O(z^-1)).derivative()  # sagebrush only
            (O(z^2), -3*z^-4 + O(z^-2))
        """
        R = self._R
        if len(args) == 1 and isinstance(args[0], (list, tuple)):
            args = tuple(args[0])
        # the number of differentiations: the series variable, each
        # optionally followed by a count (derivative(w, 2) was the first
        # derivative: its count was ignored)
        n, have = 0, False
        for a in args:
            if isinstance(a, int) or (not isinstance(a, Series) and str(a).lstrip("-").isdigit()):
                if not have:
                    raise ValueError("a derivative count needs a variable before it")
                k = int(str(a)) if not isinstance(a, int) else int(a)
                if k < 0:
                    raise ValueError("the number of derivatives must be nonnegative")
                n += k - 1
                have = False
            else:
                if str(a) != R._name:
                    raise NotImplementedError("the derivative of a series in %s with respect to %s" % (R._name, a))
                n += 1
                have = True
        if not args:
            n = 1
        if n == 0:
            return self
        # in closed form: c_e x^e becomes e (e-1) ... (e-n+1) c_e x^(e-n),
        # which is 0 when 0 <= e < n (no loop of n steps: derivative(w, 10^9))
        c = []
        for i, ci in enumerate(self._c):
            e = self._v + i
            if 0 <= e < n or _is_zero(ci):
                c.append(R._zero())
                continue
            if n > 100000:
                raise NotImplementedError("the %d-th derivative of a series with a nonzero x^%d term" % (n, e))
            f = 1
            for j in range(n):
                f *= e - j
            c.append(ci * f)
        # O(x^p) holds every sum of c_k x^k with k >= p; each derivative
        # lowers p by one, except that O(1)' is O(1) (the x^0 term's is 0)
        p = self._prec
        if p is not None:
            p = p - n if (p < 0 or p >= n) else 0
        return Series(R, self._v - n, c, p)

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
        c = [R._zero() if self._v + i + 1 == 0 else R._div(self._c[i], self._v + i + 1) for i in range(len(self._c))]
        return Series(R, self._v + 1, c, self._prec + 1 if self._prec is not None else None)

    def exp(self, prec=None):
        """exp(self), for a series with constant term 0.

        EXAMPLES::

            sage: R.<q> = QQ[[]]; (q + O(q^5)).exp()
            1 + q + 1/2*q^2 + 1/6*q^3 + 1/24*q^4 + O(q^5)
        """
        R = self._R
        # exp needs positive valuation: a constant term, or negative powers
        # (exp(1/x) is not a Laurent series), are refused
        if any(self._v + i <= 0 and not _is_zero(c) for i, c in enumerate(self._c)):
            raise ValueError("can only take the exponential of a series with constant term 0 and no negative powers")
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
            if x._prec is not None and self._v >= 0:
                q = x._prec + (self._v - 1) * x._v if self._c else x._prec
                p = q if p is None else min(p, q)
            # (exact inputs give an exact result: no cutoff at the default
            # precision; negative powers use 1/x)
            first = self._v if self._v < 0 else 0
            pw = x.inverse() ** (-first) if first < 0 else Series(x._R, 0, [x._R._one()], None)
            res = Series(pw._R, 0, [], p)
            for k in range(first, self._v + len(self._c)):
                c = self[k]
                if not _is_zero(c):
                    res = res + pw * x._R._base(c)
                if k + 1 < self._v + len(self._c):
                    pw = pw * x
                if p is not None and pw._v >= p:
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


def _term(c, e, name, laurent=False):
    """(negative, text) of the term c*x^e."""
    if type(c).__name__ in ("pAdicCappedRelativeElement", "EisensteinExtensionElement"):
        # (Sage: a p-adic coefficient is not atomic: it is parenthesized
        # whenever it shows a + or a -, as (O(5^-1))*T, and so is the
        # constant term of a Laurent series then)
        s = repr(c)
        compound = "+" in s or "-" in s
        if e == 0 and not (laurent and compound):
            return False, s
        if compound:
            s = "(" + s + ")"
        return False, s if e == 0 else s + "*" + _mono(name, e)
    full = repr(_out(c))
    neg = full.startswith("-")
    s = full[1:] if neg else full
    compound = " + " in s or " - " in s
    if e == 0 and not (laurent and compound):
        # (Sage parenthesizes no constant term of a power series, 5 + O(5^4)
        # + O(5)*T, but a compound one of a Laurent series: t^-1 + (a + 1))
        return neg, s
    if compound:
        # the whole coefficient, sign included: (-a - 1)*s, not -(a - 1)*s
        s, neg = "(" + full + ")", False
        return neg, s if e == 0 else s + "*" + _mono(name, e)
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
    if type(x).__name__ == "EisensteinExtensionElement":
        # O(alpha^n): an inexact zero of the extension
        return x.parent()(0).add_bigoh(x.valuation())
    if isinstance(x, (int, _F)) and not isinstance(x, bool):
        # O(p^n): an inexact zero of Zp(p) (Qp(p) for n < 0)
        from _sage_padic import _bigoh
        return _bigoh(x)
    raise NotImplementedError("O(%r)" % (x,))
