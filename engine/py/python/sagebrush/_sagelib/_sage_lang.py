"""The runtime side of Sage's language (src/sagepre.ts rewrites the syntax):

  ellipsis_range, ellipsis_iter   [a..b], [a,b..c], (a..)
  RealNumber                      1.5 -> 1.50000000000000 (Sage's RR printing)
  symbolic_expression(...).function(x)   f(x) = x^2 -> x |--> x^2
  Sage's Integer methods on Python ints: (12).factor(), 13.is_prime(), ...
"""

import math as _m
from fractions import Fraction as _Fraction


# ------------------------------------------------------------------ ellipsis

def _is_real(v):
    return isinstance(v, float)


def _segment(start, end, step):
    # start, start + step, ... up to end, inclusive when it is hit
    if step == 0:
        raise ValueError("step must not be zero")
    out, x = [], start
    while (x <= end) if step > 0 else (x >= end):
        out.append(x)
        x = x + step
    return out


def _ellipsis(args, step, infinite):
    """Sage's semantics (its doctests are in sage-tests/test_language.sage):
    plain values are kept; at each Ellipsis the segment starts at the value
    before it, which is (1) the previous segment's endpoint, then shared and
    not repeated if it was hit, or (2) at the first Ellipsis only, without
    an explicit step, b in `a, b, ..`, which sets the step to b - a, or (3)
    a lone start; later segments inherit the step (so [1..3, 7, 10..13]
    continues by 1 after 10, not by 10 - 7); an empty segment contributes
    nothing.
    Returns (values, (start, step) of an infinite tail, or None)."""
    args = list(args)
    vals = [a for a in args if a is not Ellipsis]
    if any(_is_real(a) for a in vals) or _is_real(step):
        args = [a if a is Ellipsis else RealNumber(a) for a in args]
        if step is not None:
            step = RealNumber(step)
    n = len(args)
    out = []
    cur = 1 if step is None else step
    hit = False
    first = True  # no Ellipsis processed yet (constant state: no rescan of the prefix)
    i = 0
    while i < n:
        if args[i] is not Ellipsis:
            out.append(args[i])
            i += 1
            continue
        if i == 0:
            raise SyntaxError("an ellipsis range needs a start")
        start = args[i - 1]
        if i >= 2 and args[i - 2] is Ellipsis:
            shared = True
        else:
            shared = False
            out.pop()  # start was appended as a plain value
            if step is None and i >= 2 and first:
                a = out.pop()
                cur = start - a
                start = a
        first = False
        if i + 1 >= n:
            if not infinite:
                raise IndexError("Ellipsis range must have an endpoint, use (n..) for infinite sequence.")
            if shared and hit:
                start = start + cur
            return out, (start, cur)
        end = args[i + 1]
        seg = _segment(start, end, cur)
        if shared and hit and seg:
            seg = seg[1:]
        out.extend(seg)
        hit = bool(seg) and seg[-1] == end or (shared and hit and not seg and start == end)
        i += 2
    return out, None


def ellipsis_range(*args, step=None):
    """[a..b], [a,b..c], [a..b, step=s] as Sage computes them.

    EXAMPLES::

        sage: [1..5], [1, 3..11], [10, 8..0]
        ([1, 2, 3, 4, 5], [1, 3, 5, 7, 9, 11], [10, 8, 6, 4, 2, 0])
    """
    return _ellipsis(args, step, False)[0]


def ellipsis_iter(*args, step=None):
    """(a..b), (a,b..), (a..): an iterator, possibly infinite.

    EXAMPLES::

        sage: list((1..4))
        [1, 2, 3, 4]
    """
    out, tail = _ellipsis(args, step, True)

    def gen():
        yield from out
        if tail is not None:
            x, st = tail
            while True:
                yield x
                x = x + st
    return gen()


# ------------------------------------------------------------------ RealNumber

def _sage_float_layout(sign, digits, e):
    """Sage's layout of the significant digits d1 d2 ... with exponent e."""
    if -5 <= e <= 5:
        if e >= 0:
            if len(digits) <= e + 1:
                digits = digits + "0" * (e + 2 - len(digits))
            return sign + digits[: e + 1] + "." + digits[e + 1:]
        return sign + "0." + "0" * (-e - 1) + digits
    return sign + digits[0] + "." + digits[1:] + "e" + str(e)


def _digits_real(q, digits):
    """The rational q rounded to `digits` significant decimal digits (exact
    arithmetic), as an element of RR printed with those digits: what
    n(q, digits=...) gives in Sage."""
    from fractions import Fraction
    q = Fraction(q)
    if q == 0:
        return RealNumber(0.0)
    sign = "-" if q < 0 else ""
    a = abs(q)
    e = len(str(a.numerator)) - len(str(a.denominator))
    while Fraction(10) ** e > a:
        e -= 1
    while Fraction(10) ** (e + 1) <= a:
        e += 1
    scaled = a * Fraction(10) ** (digits - 1 - e)
    m = scaled.numerator // scaled.denominator
    if 2 * (scaled - m) >= 1:
        m += 1
    if m == 10 ** digits:
        m //= 10
        e += 1
    x = _RealDigits(float(q))
    x._repr = _sage_float_layout(sign, str(m), e)
    return x

# RR past the doubles.  Sage's RR is MPFR at 53 bits with exponents up to
# 2^62; a double holds the same numbers only from 2^-1022 to 2^1024 (and
# below 2^-1022 only those with no bits under 2^-1074).  A RealNumber is a
# double while its value is one; a result past that is an _RealBig, held at
# 53 bits in the MP real field (lib/_sage_real.py), rounded once from the
# exact operands, and turned back into a double when a later result is one.
_NORMAL_MIN = 2.2250738585072014e-308     # 2^-1022, the least normal double
_INF = float("inf")
# math's names for the functions of RR, as RealNumberMP names them
_MP_NAMES = {"atan": "arctan", "asin": "arcsin", "acos": "arccos", "asinh": "arcsinh",
             "acosh": "arccosh", "atanh": "arctanh"}


class RealNumber(float):
    """A 53-bit real, printed as Sage prints elements of RR.

    EXAMPLES::

        sage: x = RR(2); x
        2.00000000000000
        sage: x.sqrt(), x.exp(), x / 3
        (1.41421356237310, 7.38905609893065, 0.666666666666667)

    Past the double range, RR is still Sage's RR (an _RealBig holds the
    value at 53 bits)::

        sage: x = RR(1e308) * 10; x, x.parent(), x > 1e308
        (1.00000000000000e309, Real Field with 53 bits of precision, True)
        sage: x / 10, float(x), RR(2)^-1074 / 3
        (1.00000000000000e308, inf, 1.64688548613749e-324)

    Where sagebrush has no MP value, an error, never a double's infinity or
    zero (Sage has values for these)::

        sage: B = RR(10)^400; SR(B)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: 1.00000000000000e400, an element of RR past the double range, has no symbolic form in sagebrush yet
        sage: erfc(RR(30))  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: erfc(30.0000000000000): the value in RR, past the double range, is not available in sagebrush yet
        sage: n(erfc(30))  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: the value of erfc(30) in RR (the doubles give 0.0): erfc at more than 53 bits is not available in sagebrush yet
        sage: B % 3  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: % with an RR element past the doubles is not available in sagebrush yet
        sage: zeta(RR(-261.5))  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: zeta(-261.500000000000): the value in RR, past the double range, is not available in sagebrush yet
        sage: sin(RR(10)^(10^6))  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: the sine and cosine of a number of magnitude 2^3321929 (above 2^65536) are not available in sagebrush yet
        sage: RR(2)^1100 // 3  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: // and divmod with an RR element past the doubles are not available in sagebrush yet
        sage: (-RR(2)^2200)^RR(0.5)  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: -1.84497489401773e662^0.500000000000000: a negative real to a non-integer power is complex, and CC holds doubles; this one, past the double range, is not available in sagebrush yet
        sage: CC(1, 1) * RR(2)^1100  # sagebrush only
        Traceback (most recent call last):
        ...
        NotImplementedError: CC arithmetic with 1.35829852904939e331, an element of RR past the double range, is not available in sagebrush yet (CC holds doubles)
    """

    __slots__ = ()

    def __new__(cls, x=0.0):
        if type(x) is float:
            # (the common case first: arithmetic and functions make these)
            return float.__new__(cls, x)
        if isinstance(x, float):
            # an element of RR: itself when past the doubles (its float
            # would lose its value)
            if isinstance(x, _RealBig) and cls is RealNumber:
                return x
            return float.__new__(cls, x)
        if isinstance(x, str) and cls is RealNumber:
            # a literal keeps its decimal digits, for exact conversion into
            # higher precision: RealField(100)(0.1) = 0.1000...0
            f = float(x)
            if not _NORMAL_MIN < abs(f) < _INF:
                b = _rr_literal_edge(x, f)
                if b is not None:
                    return b
            r = _RealLiteral(f)
            r._lit = x
            return r
        if isinstance(x, str):
            x = float(x)
        if cls is RealNumber and not isinstance(x, float):
            # an exact number past the doubles (10^400, 1/10^400): rounded
            # once, at 53 bits
            try:
                f = float(x)
            except OverflowError:
                f = None
            if f is None or (not _NORMAL_MIN < abs(f) < _INF and x != 0):
                return _RealField()(x)
            x = f
        return float.__new__(cls, x)

    def __repr__(self):
        x = float(self)
        if x != x:
            return "NaN"
        if x in (float("inf"), float("-inf")):
            return "+infinity" if x > 0 else "-infinity"
        if x == 0:
            return ("-" if _m.copysign(1.0, x) < 0 else "") + "0.000000000000000"
        sign = "-" if x < 0 else ""
        mant, e = ("%.14e" % abs(x)).split("e")
        digits = mant.replace(".", "")  # 15 significant digits, rounded
        e = int(e)
        if -5 <= e <= 5:
            if e >= 0:
                return sign + digits[: e + 1] + "." + digits[e + 1:]
            return sign + "0." + "0" * (-e - 1) + digits
        return sign + digits[0] + "." + digits[1:] + "e" + str(e)

    __str__ = __repr__

    def __format__(self, spec):
        # f"{x}" prints as Sage does; f"{x:.3f}" formats the float
        return repr(self) if spec == "" else float.__format__(float(self), spec)

    def _repr_latex_(self):
        return "$" + repr(self) + "$"

    # arithmetic stays in RR: the double result where it is a normal double
    # (IEEE arithmetic rounds it exactly as RR does), else _rr_edge
    def _r(f):
        name = f.__name__
        # (closure constants and float.__new__: this is every operation)
        lo, inf, new = _NORMAL_MIN, _INF, float.__new__
        def g(self, *a):
            # (an operand held in the MP field has a lossy backing double:
            # 1e308 * RR('1e-320'), a literal on the left, reaches here)
            if a and isinstance(a[0], _RealBig):
                return _rr_slow(name, self, a)
            try:
                r = f(float(self), *a)
            except OverflowError:
                return _rr_edge(name, self, a, None)
            if type(r) is float or isinstance(r, float):
                # (strictly above 2^-1022: a result rounded up to it from
                # below may be a 53-bit RR number that the double lost)
                if lo < r < inf or -inf < r < -lo:
                    return new(RealNumber, r)
                return _rr_edge(name, self, a, r)
            if type(r) is complex and r == r and not (-inf < r.real < inf and -inf < r.imag < inf) \
                    and -inf < float(self) < inf and -inf < float(a[0]) < inf:
                # (a negative base to a real power: CC holds doubles, so a
                # complex value past them is refused, not an infinity)
                raise NotImplementedError("%s ** %s: a complex number past the double range is not available in sagebrush yet" % (self, a[0]))
            if type(r) is complex:
                # (a negative base to a real power: an element of CC)
                import _sage_matrix
                return _sage_matrix.ComplexNumber(r)
            return r
        g.__name__ = name
        return g

    __add__ = _r(float.__add__)
    __radd__ = _r(float.__radd__)
    __sub__ = _r(float.__sub__)
    __rsub__ = _r(float.__rsub__)
    __mul__ = _r(float.__mul__)
    __rmul__ = _r(float.__rmul__)
    __truediv__ = _r(float.__truediv__)
    __rtruediv__ = _r(float.__rtruediv__)
    __pow__ = _r(float.__pow__)
    __rpow__ = _r(float.__rpow__)
    __mod__ = _r(float.__mod__)
    __neg__ = _r(float.__neg__)
    __pos__ = _r(float.__pos__)
    __abs__ = _r(float.__abs__)
    del _r

    def __hash__(self):
        return float.__hash__(self)

    def n(self, prec=None, digits=None):
        """The number itself, or in another precision.

        EXAMPLES::

            sage: RR(2/3).n(), RR(2/3).numerical_approx(), RR(2/3).n(20)
            (0.666666666666667, 0.666666666666667, 0.66667)
            sage: RR(2/3).N()  # sagebrush only
            0.666666666666667
        """
        if prec is None and digits is None:
            return self
        import _sage_real
        return _sage_real.RealField(_sage_real.digits_to_prec(digits) if digits is not None else prec)(float(self))

    numerical_approx = N = n

    def sqrt(self):
        """The square root.

        EXAMPLES::

            sage: RR(2).sqrt()
            1.41421356237310
        """
        return RealNumber(_m.sqrt(self)) if self >= 0 else complex(0, _m.sqrt(-self))

    def exp(self):
        """The exponential.

        EXAMPLES::

            sage: RR(1).exp()
            2.71828182845905
        """
        return _rr_fn(self, _m.exp, "exp")

    def log(self, base=None):
        """The natural logarithm (or to a base).

        EXAMPLES::

            sage: RR(10).log(), RR(8).log(2)
            (2.30258509299405, 3.00000000000000)
        """
        return RealNumber(_m.log(self) if base is None else _m.log(self, base))

    def floor(self):
        """The floor, an integer.

        EXAMPLES::

            sage: RR(2.7).floor(), RR(-2.7).floor()
            (2, -3)
        """
        return _m.floor(self)

    def ceil(self):
        """The ceiling, an integer.

        EXAMPLES::

            sage: RR(2.2).ceil(), RR(-2.2).ceil()
            (3, -2)
        """
        return _m.ceil(self)

    def __round__(self, ndigits=None):
        # Python's rounding (half to even), as Sage's round(x)
        if ndigits is not None:
            return RealNumber(round(float(self), ndigits))
        return round(float(self))

    def round(self):
        """The nearest integer (halves to even, as Sage's RR).

        EXAMPLES::

            sage: RR(2.5).round(), RR(-2.5).round(), RR(2.4).round()
            (2, -2, 2)
        """
        return round(float(self))

    def parent(self):
        """The real field RR.

        EXAMPLES::

            sage: RR(2).parent()
            Real Field with 53 bits of precision
        """
        return _RealField()

    def is_integer(self):
        """Whether the number is an integer.

        EXAMPLES::

            sage: RR(2).is_integer(), RR(2.5).is_integer()
            (True, False)
        """
        return float(self).is_integer()

    def abs(self):
        """The absolute value.

        EXAMPLES::

            sage: RR(-2.5).abs()
            2.50000000000000
        """
        return abs(self)

    def _f(name, doc):
        f = getattr(_m, name)
        mpname = _MP_NAMES.get(name, name)
        def g(self):
            return _rr_fn(self, f, mpname)
        g.__name__ = name
        g.__doc__ = doc
        return g

    sin = _f("sin", """The sine.

        EXAMPLES::

            sage: RR(1).sin(), RR(1).cos(), RR(1).tan()
            (0.841470984807897, 0.540302305868140, 1.55740772465490)
        """)
    cos = _f("cos", """The cosine.

        EXAMPLES::

            sage: RR(pi).cos()
            -1.00000000000000
        """)
    tan = _f("tan", """The tangent.

        EXAMPLES::

            sage: RR(1).tan()
            1.55740772465490
        """)
    arctan = atan = _f("atan", """The arctangent.

        EXAMPLES::

            sage: RR(1).arctan()
            0.785398163397448
        """)
    arcsin = asin = _f("asin", """The arcsine.

        EXAMPLES::

            sage: RR(1/2).arcsin()
            0.523598775598299
        """)
    arccos = acos = _f("acos", """The arccosine.

        EXAMPLES::

            sage: RR(1/2).arccos()
            1.04719755119660
        """)
    sinh = _f("sinh", """The hyperbolic sine.

        EXAMPLES::

            sage: RR(1).sinh(), RR(1).cosh(), RR(1).tanh()
            (1.17520119364380, 1.54308063481524, 0.761594155955765)
        """)
    cosh = _f("cosh", """The hyperbolic cosine.

        EXAMPLES::

            sage: RR(0).cosh()
            1.00000000000000
        """)
    tanh = _f("tanh", """The hyperbolic tangent.

        EXAMPLES::

            sage: RR(0).tanh()
            0.000000000000000
        """)
    arcsinh = _f("asinh", """The inverse hyperbolic sine.

        EXAMPLES::

            sage: RR(1).arcsinh()
            0.881373587019543
        """)
    arccosh = _f("acosh", """The inverse hyperbolic cosine.

        EXAMPLES::

            sage: RR(2).arccosh()
            1.31695789692482
        """)
    arctanh = _f("atanh", """The inverse hyperbolic tangent.

        EXAMPLES::

            sage: RR(1/2).arctanh()
            0.549306144334055
        """)
    del _f

    def log2(self):
        """The logarithm to base 2.

        EXAMPLES::

            sage: RR(8).log2(), RR(1000).log10()
            (3.00000000000000, 3.00000000000000)
        """
        return RealNumber(_m.log2(float(self)))

    def log10(self):
        """The logarithm to base 10.

        EXAMPLES::

            sage: RR(100).log10()
            2.00000000000000
        """
        return RealNumber(_m.log10(float(self)))

    def gamma(self):
        """The gamma function.

        EXAMPLES::

            sage: RR(5).gamma(), RR(1/2).gamma()
            (24.0000000000000, 1.77245385090552)
        """
        g = getattr(_m, "gamma", None)
        if g is not None:
            return _rr_fn(self, g, "gamma")
        import _sage_real
        from fractions import Fraction
        return RealNumber(float(_sage_real.RealField(60)(_sage_real._gamma(Fraction(float(self)), 60))))

    def log_gamma(self):
        """The logarithm of the gamma function (positive numbers).

        EXAMPLES::

            sage: RR(10).log_gamma(), RR(1e308).log_gamma()
            (12.8018274800815, 7.08196208642166e310)
        """
        if not float(self) > 0:
            raise NotImplementedError("log_gamma of a real number <= 0 (complex in Sage) is not available for RR elements in sagebrush yet; use log_gamma(x)")
        return _rr_fn(self, _m.lgamma, "log_gamma")

    def nth_root(self, n):
        """The real n-th root.

        EXAMPLES::

            sage: RR(8).nth_root(3), RR(-8).nth_root(3)
            (2.00000000000000, -2.00000000000000)
        """
        x = float(self)
        n = int(n)
        r = abs(x) ** (1.0 / n)
        rr = round(r)
        if rr ** n == abs(x):
            r = float(rr)
        return RealNumber(-r if x < 0 and n % 2 else r)

    def sign(self):
        """-1, 0 or 1.

        EXAMPLES::

            sage: RR(-2).sign(), RR(0).sign()
            (-1, 0)
        """
        x = float(self)
        return (x > 0) - (x < 0)

    def exact_rational(self):
        """The rational number this double is exactly.

        EXAMPLES::

            sage: RR(0.5).exact_rational(), RR(1/3).exact_rational()
            (1/2, 6004799503160661/18014398509481984)
        """
        from fractions import Fraction
        from _sage_poly import _norm
        return _norm(Fraction(float(self)))

    def prec(self):
        """53.

        EXAMPLES::

            sage: RR(1).prec()
            53
        """
        return 53

    precision = prec

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: RR(0).is_zero()
            True
        """
        return float(self) == 0

    def str(self, digits=0, **kwds):
        """The decimal string (with digits significant digits).

        EXAMPLES::

            sage: RR(1/3).str(), RR(1/3).str(digits=5)
            ('0.33333333333333331', '0.33333')
        """
        import _sage_real
        from fractions import Fraction
        return _sage_real._format(Fraction(float(self)), int(digits) if digits else 17)


class _RealLiteral(RealNumber):
    """A decimal literal of RR: a 53-bit real that remembers its digits."""

    def __reduce__(self):
        return (RealNumber, (float(self),))

    def __neg__(self):
        # -1.1 is still the literal, digits and all, as in Sage:
        # RealField(100)(-1.1) is -1.1000...0, not the negated double
        r = _RealLiteral(-float(self))
        lit = self._lit
        r._lit = lit[1:] if lit.startswith("-") else "-" + lit.lstrip("+")
        return r

    def __pos__(self):
        return self


class _RealDigits(RealNumber):
    """An element of RR shown to more digits than 53 bits carry (from
    n(rational, digits=...)); arithmetic on it is in 53 bits."""

    def __repr__(self):
        return self._repr

    __str__ = __repr__


class _RealBig(RealNumber):
    """An element of RR past the doubles (a magnitude of 2^1024 or more, or
    under 2^-1022 with bits below 2^-1074): its 53-bit value _mp, in the MP
    real field, rounded once from the exact operands.  To the user it is a
    RealNumber of RR like any other (parent, printing, comparisons, hash,
    isinstance), and float() gives its double rounding (+-inf, 0.0 or a
    subnormal), as Sage's float(RR(...)) does.  Its arithmetic and functions
    are those of RealNumberMP at 53 bits; a result that is a double again
    becomes a plain RealNumber.
    (Its examples are in RealNumber's docstring.)
    """

    def __new__(cls, x=0.0):
        # (type(B)(1): an element of RR made from x, never an _RealBig
        # without its value; _rr_from_mp makes these with float.__new__)
        return _RealField()(x)

    def __repr__(self):
        return repr(self._mp)

    __str__ = __repr__

    def __format__(self, spec):
        return repr(self) if spec == "" else format(self._mp, spec)

    def _repr_latex_(self):
        return "$" + repr(self) + "$"

    # (Sage hashes RR elements by their float, as RealNumber does here)
    __hash__ = RealNumber.__hash__

    # the digits of a decimal literal past the doubles (1e400), for exact
    # conversion into a higher precision, as Sage's RealLiteral; None for a
    # computed value
    _lit = None

    # float's methods that would act on the backing double (0.0, inf, a
    # subnormal) instead of the value: the value's, or an explicit refusal.
    # (float(), complex(), math and NumPy conversions round to a double,
    # as intended.)
    @property
    def real(self):
        return self

    @property
    def imag(self):
        return RealNumber(0.0)

    def conjugate(self):
        return self

    def as_integer_ratio(self):
        q = self._mp.exact_rational()
        return int(q.numerator()), int(q.denominator())

    def hex(self):
        raise NotImplementedError("hex() of an RR element past the doubles is not available in sagebrush yet")

    def __floordiv__(self, o):
        raise NotImplementedError("// and divmod with an RR element past the doubles are not available in sagebrush yet")

    __rfloordiv__ = __divmod__ = __rdivmod__ = __floordiv__

    def __reduce__(self):
        return (_rr_from_mp, (self._mp,))

    def __reduce_ex__(self, protocol):
        return self.__reduce__()

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self

    def __bool__(self):
        return True

    def __int__(self):
        return int(self._mp)

    __trunc__ = __int__

    def __floor__(self):
        return self._mp.floor()

    def __ceil__(self):
        return self._mp.ceil()

    def __round__(self, ndigits=None):
        if ndigits is not None:
            raise NotImplementedError("round(x, ndigits) of an RR element past the doubles is not available in sagebrush yet")
        return self._mp.round()

    def _cmp(op):
        def g(self, o):
            m = _rr_operand(o)
            if m is None:
                if isinstance(o, complex) and op in ("__eq__", "__ne__"):
                    if type(o) is complex:
                        # a Python complex: Sage converts to it (doubles), so
                        # RR(2)^-1100 == complex(0), from either side
                        eq = complex(float(self)) == o
                    else:
                        # CC(0) == RR(2)^-1100 is False: by value, not by the
                        # double
                        eq = o.imag == 0 and self._mp == _rr_mp()(o.real)
                    return eq if op == "__eq__" else not eq
                return NotImplemented
            return getattr(self._mp, op)(m)
        g.__name__ = op
        return g

    __eq__ = _cmp("__eq__")
    __ne__ = _cmp("__ne__")
    __lt__ = _cmp("__lt__")
    __le__ = _cmp("__le__")
    __gt__ = _cmp("__gt__")
    __ge__ = _cmp("__ge__")
    del _cmp

    def _bin(op, rev=False):
        def g(self, o):
            m = _rr_operand(o)
            if m is None:
                if isinstance(o, complex):
                    raise NotImplementedError("%s with an RR element past the doubles and a complex number is not available in sagebrush yet (CC holds doubles)" % op)
                return NotImplemented
            return _rr_from_mp(_rr_arith(m, self._mp, op) if rev else _rr_arith(self._mp, m, op))
        return g

    __add__, __radd__ = _bin("+"), _bin("+", True)
    __sub__, __rsub__ = _bin("-"), _bin("-", True)
    __mul__, __rmul__ = _bin("*"), _bin("*", True)
    __truediv__, __rtruediv__ = _bin("/"), _bin("/", True)
    del _bin

    def __pow__(self, o, mod=None):
        if mod is not None:
            return NotImplemented
        if isinstance(o, int) or type(o).__name__ == "Integer" or (isinstance(o, _Fraction) and o.denominator == 1):
            return _rr_from_mp(self._mp ** int(o))
        m = _rr_operand(o)
        if m is None:
            if isinstance(o, complex):
                raise NotImplementedError("** with an RR element past the doubles and a complex number is not available in sagebrush yet (CC holds doubles)")
            return NotImplemented
        return _rr_real_pow(self._mp, m)

    def __rpow__(self, o):
        m = _rr_operand(o)
        if m is None:
            if isinstance(o, complex):
                raise NotImplementedError("** with an RR element past the doubles and a complex number is not available in sagebrush yet (CC holds doubles)")
            return NotImplemented
        return _rr_real_pow(m, self._mp)

    def __mod__(self, o):
        raise NotImplementedError("% with an RR element past the doubles is not available in sagebrush yet")

    __rmod__ = __mod__

    def __neg__(self):
        r = _rr_from_mp(-self._mp)
        if self._lit is not None:
            # (-1e400 is still the literal, as in Sage)
            lit = self._lit
            r._lit = lit[1:] if lit.startswith("-") else "-" + lit.lstrip("+")
        return r

    def __pos__(self):
        return self

    def __abs__(self):
        return _rr_from_mp(abs(self._mp))

    def n(self, prec=None, digits=None):
        if prec is None and digits is None:
            return self
        return self._mp.n(prec, digits)

    numerical_approx = N = n

    def _mpf(name):
        def g(self, *a):
            return _rr_from_mp(getattr(self._mp, name)(*a))
        g.__name__ = name
        return g

    sqrt = _mpf("sqrt")
    exp = _mpf("exp")

    def log(self, base=None):
        if self._mp < 0:
            # log|x| + pi I (over log(base)): log|x| is a double for every
            # element of RR
            import _sage_matrix
            re = float(_rr_from_mp((-self._mp).log()))
            if base is None:
                return _sage_matrix.ComplexNumber(re, _m.pi)
            lb = float(RealNumber(base).log()) if not isinstance(base, _RealBig) else float(base.log())
            return _sage_matrix.ComplexNumber(re / lb, _m.pi / lb)
        return _rr_from_mp(self._mp.log() if base is None else self._mp.log(_rr_operand(base) or base))

    log2 = _mpf("log2")
    log10 = _mpf("log10")
    gamma = _mpf("gamma")
    log_gamma = _mpf("log_gamma")
    nth_root = _mpf("nth_root")
    sin = _mpf("sin")
    cos = _mpf("cos")
    tan = _mpf("tan")
    sinh = _mpf("sinh")
    cosh = _mpf("cosh")
    tanh = _mpf("tanh")
    arctan = atan = _mpf("arctan")
    arcsin = asin = _mpf("arcsin")
    arccos = acos = _mpf("arccos")
    arcsinh, arccosh, arctanh = _mpf("arcsinh"), _mpf("arccosh"), _mpf("arctanh")
    del _mpf

    def floor(self):
        return self._mp.floor()

    def ceil(self):
        return self._mp.ceil()

    def round(self):
        return self._mp.round()

    def is_integer(self):
        return self._mp.is_integer()

    def abs(self):
        return abs(self)

    def sign(self):
        return self._mp.sign()

    def exact_rational(self):
        return self._mp.exact_rational()

    def is_zero(self):
        return False

    def str(self, digits=0, **kwds):
        return self._mp.str(digits, **kwds) if digits else self._mp.str(**kwds)


# (it is a RealNumber to the user: the same name in type())
_RealBig.__name__ = _RealBig.__qualname__ = "RealNumber"

_RRMP = None


def _rr_mp():
    """The 53-bit MP real field that holds RR's elements past the doubles
    (its arithmetic keeps MP values: RealField_._rr_internal)."""
    global _RRMP
    if _RRMP is None:
        import _sage_real
        _RRMP = _sage_real.RealField_(53, "RNDN")
        _RRMP._rr_internal = True
    return _RRMP


def _rr_from_mp(v):
    """The element of RR with the value of v (a RealNumberMP, rounded to 53
    bits; anything else is returned as it is): a double when it is exactly
    one, an _RealBig otherwise."""
    import _sage_real
    if not isinstance(v, _sage_real.RealNumberMP):
        return v
    F = _rr_mp()
    if v._R is not F:
        v = F(v)
    if v._special:
        # +-infinity past MPFR's exponent range itself, or NaN
        return RealNumber(float(v))
    if not v._m:
        return RealNumber(0.0)
    f = float(v)
    if f != 0 and -_INF < f < _INF and v._cmpq(f) == 0:
        return RealNumber(f)
    b = float.__new__(_RealBig, f)
    b._mp = v
    return b


def _rr_operand(o):
    """o coerced into RR, as Sage coerces an Integer, a Rational or a float
    (rounded to 53 bits), as a 53-bit MP value; None when o is not a real
    number."""
    if isinstance(o, _RealBig):
        return o._mp
    if isinstance(o, (float, int, _Fraction)) or type(o).__name__ in ("Integer", "Rational", "RealNumberMP"):
        return _rr_mp()(o)
    return None


def _rr_arith(a, b, op):
    """a op b (53-bit MP values), rounded once."""
    import _sage_real
    return _sage_real._arith(a, b, op, _rr_mp())


_RR_EXACT_ZERO_OPS = ("__add__", "__radd__", "__sub__", "__rsub__", "__mod__", "__rmod__")
_RR_OPS = {"__add__": ("+", False), "__radd__": ("+", True), "__sub__": ("-", False), "__rsub__": ("-", True),
           "__mul__": ("*", False), "__rmul__": ("*", True), "__truediv__": ("/", False), "__rtruediv__": ("/", True)}


def _rr_edge(name, x, a, r):
    """The result of the RR operation name (x, *a), whose double result r
    (None: it overflowed) is not a normal double: kept where it is exact (a
    NaN; an infinity from an infinite operand; a zero or subnormal sum, an
    exact zero product or quotient; a unary operation of a double), else
    computed in the 53-bit MP field."""
    o = a[0] if a else None
    if r is not None and not isinstance(o, _RealBig):
        if r != r or not a:
            return RealNumber(r)
        xf = float(x)
        of = o if isinstance(o, float) else None
        if r in (_INF, -_INF):
            if xf in (_INF, -_INF) or (of is not None and of in (_INF, -_INF)):
                return RealNumber(r)
        elif name in _RR_EXACT_ZERO_OPS:
            # (a sum or difference that is zero or subnormal is exact, and
            # so is a remainder)
            return RealNumber(r)
        elif r == 0:
            if (name in ("__mul__", "__rmul__") and (xf == 0 or o == 0)) or \
                    (name == "__truediv__" and (xf == 0 or of in (_INF, -_INF))) or \
                    (name == "__rtruediv__" and (o == 0 or xf in (_INF, -_INF))) or \
                    (name == "__pow__" and xf == 0) or (name == "__rpow__" and o == 0):
                return RealNumber(r)
    return _rr_slow(name, x, a)


def _rr_slow(name, x, a):
    """name(x, *a) computed in the 53-bit MP field, x and a[0] coerced into
    RR as Sage does."""
    mx = _rr_operand(x)
    if not a:
        return _rr_from_mp({"__neg__": lambda v: -v, "__pos__": lambda v: v, "__abs__": abs}[name](mx))
    o = a[0]
    if name in ("__pow__", "__rpow__"):
        if name == "__pow__" and (isinstance(o, int) or type(o).__name__ == "Integer"):
            return _rr_from_mp(mx ** int(o))
        m = _rr_operand(o)
        if m is None:
            return NotImplemented
        return _rr_real_pow(mx, m) if name == "__pow__" else _rr_real_pow(m, mx)
    if name in ("__mod__", "__rmod__"):
        raise NotImplementedError("% past the doubles is not available for RR in sagebrush yet")
    m = _rr_operand(o)
    if m is None:
        return NotImplemented
    op, rev = _RR_OPS[name]
    return _rr_from_mp(_rr_arith(m, mx, op) if rev else _rr_arith(mx, m, op))


def _rr_real_pow(mx, my):
    """mx ** my (53-bit MP values) in RR; a negative base to a non-integer
    power is complex, and CC holds doubles: refused when the base is past
    them."""
    if mx._m < 0 and not my.is_integer():
        raise NotImplementedError("%s^%s: a negative real to a non-integer power is complex, and CC holds doubles; this one, past the double range, is not available in sagebrush yet" % (_rr_from_mp(mx), _rr_from_mp(my)))
    return _rr_from_mp(mx ** my)


def _rr_fn(x, fn, mpname, *a):
    """The function fn (math's) of the RR element x as RR: the double result
    where it is a normal double, or where x is 0, an infinity or NaN (the
    double functions are exact there); else the 53-bit MP field's mpname
    (an overflow, an underflow, a subnormal result)."""
    xf = float(x)
    try:
        r = fn(xf, *a)
    except OverflowError:
        r = None
    if r is not None:
        if not isinstance(r, float):
            return r
        if _NORMAL_MIN < abs(r) < _INF or xf == 0 or xf != xf or xf in (_INF, -_INF):
            return RealNumber(r)
    return _rr_from_mp(getattr(_rr_mp()(xf), mpname)(*a))


def _rr_literal_edge(lit, f):
    """The RR element of the decimal literal lit whose double f is not a
    normal double: an _RealBig remembering its digits (RealField(100)(1e400)
    is 1e400 to 100 bits), or None to keep the double (a zero, an exact
    subnormal, inf or nan written out)."""
    if f != f or (f in (_INF, -_INF) and any(c.isalpha() and c not in "eE" for c in lit)):
        return None
    try:
        v = _rr_mp()(lit)
    except (ValueError, TypeError):
        return None
    if not v._m and not v._special:
        return None
    b = _rr_from_mp(v)
    if not isinstance(b, _RealBig):
        return None
    b._lit = lit
    return b


class _RealField:
    """RR, the real field with 53 bits of precision (Python floats).

    EXAMPLES::

        sage: RR, RR is RealField(53)
        (Real Field with 53 bits of precision, True)
    """

    _instance = None
    _is_generic_field = True
    _numeric = True

    def __new__(cls):
        if cls._instance is None:
            cls._instance = object.__new__(cls)
        return cls._instance

    def __repr__(self):
        return "Real Field with 53 bits of precision"

    def _latex_(self):
        return "\\Bold{R}"

    def __call__(self, x=0):
        """Convert x into RR.

        EXAMPLES::

            sage: RR(1/3), RR(2), RR('1.5')
            (0.333333333333333, 2.00000000000000, 1.50000000000000)
        """
        if isinstance(x, _RealBig):
            return x
        try:
            f = float(x)
        except OverflowError:
            f = None
        if f is not None:
            # (strictly above 2^-1022: (2^53 - 1)/2^1075 is an RR number
            # whose double rounds up to 2^-1022)
            if _NORMAL_MIN < abs(f) < _INF:
                return RealNumber(f)
            if f != f or (isinstance(x, float) and f in (_INF, -_INF)):
                return RealNumber(f)
            if f == 0 and (isinstance(x, (float, int, _Fraction)) or type(x).__name__ in ("Integer", "Rational")) and x == 0:
                return RealNumber(f)
        # past the doubles (10^400, '1e-400', exp(1000), a 100-bit
        # number beyond them): rounded once at 53 bits
        try:
            v = _rr_mp()(x)
        except (TypeError, ValueError):
            if f is None:
                raise
            return RealNumber(f)
        return _rr_from_mp(v)

    def __eq__(self, o):
        return isinstance(o, _RealField)

    def __hash__(self):
        return hash(("RealField", 53, "RNDN"))

    def precision(self):
        """53.

        EXAMPLES::

            sage: RR.precision(), RR.prec()
            (53, 53)
        """
        return 53

    prec = precision

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: RR.is_exact()
            False
        """
        return False

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: RR.is_field()
            True
        """
        return True

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: RR.characteristic()
            0
        """
        return 0

    def rounding_mode(self):
        """'RNDN'.

        EXAMPLES::

            sage: RR.rounding_mode()
            'RNDN'
        """
        return "RNDN"

    def pi(self):
        """pi.

        EXAMPLES::

            sage: RR.pi()
            3.14159265358979
        """
        return RealNumber(_m.pi)

    def to_prec(self, prec):
        """The real field with another precision.

        EXAMPLES::

            sage: RR.to_prec(100)
            Real Field with 100 bits of precision
        """
        import _sage_real
        return _sage_real.RealField(prec)

    def complex_field(self):
        """CC.

        EXAMPLES::

            sage: RR.complex_field()
            Complex Field with 53 bits of precision
        """
        import sage_all
        return sage_all.CC

    def zero(self):
        """0.

        EXAMPLES::

            sage: RR.zero()
            0.000000000000000
        """
        return RealNumber(0.0)

    def one(self):
        """1.

        EXAMPLES::

            sage: RR.one()
            1.00000000000000
        """
        return RealNumber(1.0)

    def random_element(self, min=-1, max=1):
        """A random element of [min, max].

        EXAMPLES::

            sage: RR.random_element().parent()
            Real Field with 53 bits of precision
        """
        import random as _r
        return RealNumber(_r.uniform(float(min), float(max)))

    def __contains__(self, x):
        try:
            float(x)
            return True
        except (TypeError, ValueError):
            return False

    def _name(self):
        return "RealField53_RNDN"


# ------------------------------------------------------------------ f(x) = ...

class SymbolicFunction:
    """f(x) = x^2: a callable expression, printed x |--> x^2.  Calling it
    substitutes; its methods (diff, taylor, ...) give callable results.
    A callable may also be vector-valued: r(t) = (cos(t), sin(t)).

    EXAMPLES::

        sage: f(x) = x^2 + 1; f
        x |--> x^2 + 1
        sage: f(3), f.diff(), f(x).integrate(x)
        (10, x |--> 2*x, 1/3*x^3 + x)
        sage: var('t')
        t
        sage: r(t) = (cos(t), sin(t)); r, r.diff(t)
        (t |--> (cos(t), sin(t)), t |--> (-sin(t), cos(t)))
    """

    def __init__(self, expr, args):
        from _sage_expr import _expr
        if isinstance(expr, (list, tuple)):
            from _sage_matrix import Vector
            self._expr = Vector(_expr(e) for e in expr)
            self._vec = True
        else:
            self._expr, self._vec = _expr(expr), False
        self._args = tuple(args)

    def _argstr(self):
        return str(self._args[0]) if len(self._args) == 1 else "(" + ", ".join(map(str, self._args)) + ")"

    def __repr__(self):
        return "%s |--> %s" % (self._argstr(), self._expr)

    __str__ = __repr__

    def _latex_(self):
        a = self._args[0]._latex_() if len(self._args) == 1 else \
            "\\left(%s\\right)" % ", ".join(v._latex_() for v in self._args)
        e = self._expr._latex_() if not self._vec else "\\left(%s\\right)" % ", ".join(x._latex_() for x in self._expr)
        return "%s \\ {\\mapsto}\\ %s" % (a, e)

    def __call__(self, *vals, **kw):
        """Substitute the arguments.

        EXAMPLES::

            sage: f(x, y) = x^2 + y
            sage: f(1, 2), f(x, 3)
            (3, x^2 + 3)
        """
        if kw and not vals:
            sub = {a: kw[str(a)] for a in self._args if str(a) in kw}
        else:
            if len(vals) != len(self._args):
                raise ValueError("the number of arguments must be less than or equal to %d" % len(self._args))
            sub = dict(zip(self._args, vals))
        if self._vec:
            from _sage_matrix import Vector
            return Vector(e.subs(sub) for e in self._expr)
        return self._expr.subs(sub)

    def variables(self):
        """The variables of the expression (not the arguments: g(x) = 1
        has none), as in Sage.

        EXAMPLES::

            sage: f(x, y) = x*y
            sage: f.variables()
            (x, y)
            sage: g(x, y) = x + 1
            sage: g.variables(), g.arguments()
            ((x,), (x, y))
        """
        if not self._vec:
            e = self._expr
            return tuple(e.variables()) if hasattr(e, "variables") else ()
        exprs = self._expr
        seen = {}
        for e in exprs:
            for v in (e.variables() if hasattr(e, "variables") else ()):
                seen[str(v)] = v
        return tuple(seen[k] for k in sorted(seen))

    def arguments(self):
        """The arguments.

        EXAMPLES::

            sage: f(x, y) = x*y
            sage: f.arguments()
            (x, y)
        """
        return self._args

    def expression(self):
        """The expression, as an ordinary symbolic expression.

        EXAMPLES::

            sage: f(x) = sin(x)^2
            sage: f.expression()  # sagebrush only
            sin(x)^2
        """
        return self._expr

    def parent(self):
        """The callable function ring (or the vector space over it).

        EXAMPLES::

            sage: f(x, y) = x*y; f.parent()
            Callable function ring with arguments (x, y)
        """
        ring = "Callable function ring with argument%s %s" % ("" if len(self._args) == 1 else "s", self._argstr())
        if self._vec:
            return _Text("Vector space of dimension %d over %s" % (len(self._expr), ring))
        return _Text(ring)

    def _fast_callable(self, names=None):
        return self._expr._fast_callable(names if names is not None else [str(a) for a in self._args])

    def _wrap(self, r):
        from _sage_expr import Expression
        from _sage_matrix import Vector
        if isinstance(r, Expression) and not r.is_relational():
            return SymbolicFunction(r, self._args)
        if isinstance(r, Vector) and all(isinstance(e, Expression) for e in r):
            return SymbolicFunction(r, self._args)
        return r

    def _each(self, f):
        from _sage_matrix import Vector
        return self._wrap(Vector(f(e) for e in self._expr) if self._vec else f(self._expr))

    def diff(self, *args):
        """The derivative, as a callable expression; without a variable, the
        gradient of a function of several variables (the Jacobian of a
        vector), diff(2) the Hessian.

        EXAMPLES::

            sage: f(x) = x^3
            sage: f.diff(), f.derivative(x, 2), f.differentiate()
            (x |--> 3*x^2, x |--> 6*x, x |--> 3*x^2)
            sage: f.derivative(2)
            x |--> 6*x
            sage: var('y')
            y
            sage: g(x, y) = x^2*y
            sage: g.diff()
            (x, y) |--> (2*x*y, x^2)
        """
        import sage_all as _sa
        n = None
        if len(args) == 1 and isinstance(args[0], int) and not isinstance(args[0], bool):
            n, args = int(args[0]), ()
        if self._vec:
            if args:
                return self._each(lambda e: e.diff(*args))
            from _sage_matrix import Matrix, _shape
            _shape(len(self._expr), len(self._args))  # (the Jacobian's shape before its cells)
            return Matrix(_sa.SR, [[SymbolicFunction(e.diff(v), self._args) for v in self._args] for e in self._expr])
        if args:
            return self._wrap(self._expr.diff(*args))
        if len(self._args) == 1:
            return self._wrap(self._expr.diff(self._args[0], n or 1))
        if n is None or n == 1:
            return self.gradient()
        if n == 2:
            return self.hessian()
        raise ValueError("diff(%d) of a function of several variables" % n)

    derivative = differentiate = diff

    def gradient(self, vars=None):
        """The gradient, as a callable vector.

        EXAMPLES::

            sage: var('y')
            y
            sage: f(x, y) = x^2 + x*y
            sage: f.gradient()
            (x, y) |--> (2*x + y, x)
        """
        from _sage_matrix import Vector
        return SymbolicFunction(Vector(self._expr.diff(v) for v in (vars or self._args)), self._args)

    def hessian(self):
        """The Hessian, a matrix of callable expressions.

        EXAMPLES::

            sage: var('y')
            y
            sage: f(x, y) = x^2*y
            sage: f.hessian()
            [(x, y) |--> 2*y (x, y) |--> 2*x]
            [(x, y) |--> 2*x   (x, y) |--> 0]
        """
        import sage_all as _sa
        from _sage_matrix import Matrix, _shape
        _shape(len(self._args), len(self._args))  # (the Hessian's shape before its cells)
        return Matrix(_sa.SR, [[SymbolicFunction(self._expr.diff(a).diff(b), self._args) for b in self._args] for a in self._args])

    def integral(self, *args, **kw):
        """The integral: callable for an antiderivative, a number for a
        definite integral.

        EXAMPLES::

            sage: f(x) = x^2
            sage: f.integral(x), f.integral(x, 0, 3)
            (x |--> 1/3*x^3, 9)
        """
        from _sage_expr import integrate
        definite = len(args) >= 3 or (args and isinstance(args[0], (tuple, list)))
        if self._vec:
            from _sage_matrix import Vector
            r = Vector(integrate(e, *args, **kw) for e in self._expr)
            return r if definite else self._wrap(r)
        r = integrate(self._expr, *args, **kw)
        return r if definite else self._wrap(r)

    integrate = integral

    def _binop(self, other, op, rev=False):
        o = other._expr if isinstance(other, SymbolicFunction) else other
        return self._wrap(op(o, self._expr) if rev else op(self._expr, o))

    def __add__(self, o): return self._binop(o, lambda a, b: a + b)
    def __radd__(self, o): return self._binop(o, lambda a, b: a + b, True)
    def __sub__(self, o): return self._binop(o, lambda a, b: a - b)
    def __rsub__(self, o): return self._binop(o, lambda a, b: a - b, True)
    def __mul__(self, o): return self._binop(o, lambda a, b: a * b)
    def __rmul__(self, o): return self._binop(o, lambda a, b: a * b, True)
    def __truediv__(self, o): return self._binop(o, lambda a, b: a / b)
    def __rtruediv__(self, o): return self._binop(o, lambda a, b: a / b, True)
    def __pow__(self, o): return self._binop(o, lambda a, b: a ** b)
    def __neg__(self): return self._wrap(-self._expr)

    def _rel(self, o, op):
        o = o._expr if isinstance(o, SymbolicFunction) else o
        return op(self._expr, o)

    def __eq__(self, o):
        return self._rel(o, lambda a, b: a == b)

    def __ne__(self, o):
        return self._rel(o, lambda a, b: a != b)

    def __lt__(self, o):
        return self._rel(o, lambda a, b: a < b)

    def __le__(self, o):
        return self._rel(o, lambda a, b: a <= b)

    def __gt__(self, o):
        return self._rel(o, lambda a, b: a > b)

    def __ge__(self, o):
        return self._rel(o, lambda a, b: a >= b)

    def __hash__(self):
        return hash((repr(self),))

    def __iter__(self):
        if self._vec:
            return iter([SymbolicFunction(e, self._args) for e in self._expr])
        raise TypeError("a callable symbolic expression is not iterable")

    def __len__(self):
        if self._vec:
            return len(self._expr)
        raise TypeError("a callable symbolic expression has no length")

    def __getitem__(self, i):
        if self._vec:
            return SymbolicFunction(self._expr[i], self._args)
        raise TypeError("a callable symbolic expression is not subscriptable")

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        if self._vec:
            m = getattr(self._expr, name)
            if not callable(m):
                return m

            def fv(*args, **kw):
                return self._wrap(m(*args, **kw))
            return fv
        m = getattr(self._expr, name)
        if not callable(m):
            return m

        def f(*args, **kw):
            return self._wrap(m(*args, **kw))
        return f


# (Sage's callable expressions are symbolic Expressions: type(f) shows the
# same class as an Expression's, as Expression's own does)
SymbolicFunction.__name__ = SymbolicFunction.__qualname__ = "Expression"
SymbolicFunction.__module__ = "sage.symbolic.expression"
SymbolicFunction._defined_in = "_sage_lang"


class _Text:
    def __init__(self, s):
        self._s = s

    def __repr__(self):
        return self._s

    def __eq__(self, o):
        return isinstance(o, _Text) and o._s == self._s

    def __hash__(self):
        return hash(self._s)


def _evaluate(e, subs):
    """e with the variables named in subs replaced (Sage evaluates)."""
    from _sage_expr import Expression
    if not isinstance(e, Expression):
        return e
    return e.subs(**subs)


def symbolic_expression(e):
    """The symbolic expression of a number or string (a vector of them for
    a list or tuple).

    EXAMPLES::

        sage: symbolic_expression(2) + x
        x + 2
        sage: symbolic_expression(x^2).function(x)
        x |--> x^2
        sage: symbolic_expression((x, x^2))
        (x, x^2)
    """
    from _sage_expr import _expr
    if isinstance(e, (list, tuple)):
        from _sage_matrix import Vector
        return Vector(_expr(x) for x in e)
    if isinstance(e, SymbolicFunction):
        return e._expr
    return _expr(e)


# ------------------------------------------------------------------ Integer methods

class _CallableInt(int):
    """An int that is also a method returning itself: Sage's x.numerator()
    next to Python's x.numerator."""

    __slots__ = ()

    def __call__(self):
        """Sage's numerator() and denominator(): the int called returns itself.

        EXAMPLES::

            sage: (3/4).numerator(), (3/4).denominator()
            (3, 4)
        """
        return int(self)


def _int_n(n, prec=None, digits=None):
    """An integer as a real number: 53 bits, or at the precision asked
    (from the exact integer, not a double)."""
    if prec is None and digits is None:
        return RealNumber(n)
    import _sage_real
    p = _sage_real.digits_to_prec(digits) if digits is not None else prec
    return _sage_real.RealField(p)(int(n))


def _install_int_methods(sa):
    """Sage's Integer methods on Python ints, from sage_all's functions (in
    pyjs); under CPython, which cannot extend int, an Integer subclass of
    int with those methods, returned for sage_all.Integer."""

    def isqrt_exact(n):
        r = _m.isqrt(n)
        return r if r * r == n else sa.sqrt(n)

    def nth_root(n, k, truncate_mode=False):
        # exact (integer Newton's method: a float root was wrong past 2^53
        # and overflowed past 2^1024), and an even root of a negative
        # number is an error, as in Sage (-4 had the root -2)
        k = int(k)
        if k < 1:
            raise ValueError("k=%d must be positive" % k)
        if n < 0 and k % 2 == 0:
            raise ValueError("cannot take even root of negative number")
        a = abs(int(n))
        if a < 2 or k == 1:
            c = a
        else:
            c = 1 << -(-a.bit_length() // k)
            while True:
                d = ((k - 1) * c + a // c ** (k - 1)) // k
                if d >= c:
                    break
                c = d
        exact = c ** k == a
        r = -c if n < 0 else c
        if truncate_mode:
            return r, exact
        if not exact:
            sfx = "th" if 10 <= k % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(k % 10, "th")
            raise ValueError("%d is not a %d%s power" % (n, k, sfx))
        return r

    def binary(n):
        return bin(n)[2:] if n >= 0 else "-" + bin(n)[3:]

    def int_str(n, base=10):
        if base == 10:
            return int.__repr__(n)
        digs = "0123456789abcdefghijklmnopqrstuvwxyz"
        if n == 0:
            return "0"
        s, m = "", abs(n)
        while m:
            s = digs[m % base] + s
            m //= base
        return ("-" if n < 0 else "") + s

    def is_squarefree(n):
        return all(e == 1 for _, e in sa.factor(abs(n))) if n else False

    def prime_divisors(n):
        return [p for p, _ in sa.factor(abs(n))]

    def quo_rem(a, b):
        return (a // b, a % b)

    def ndigits(n, base=10):
        return len(sa.digits(abs(n), base)) if n else 0

    methods = {
        "factor": lambda n, proof=None, **k: sa.factor(n, proof=proof),
        "is_prime": lambda n, proof=None: sa.is_prime(n, proof=proof),
        "is_pseudoprime": lambda n: sa.is_prime(n),
        "is_prime_power": lambda n: sa.is_prime_power(n),
        "is_square": lambda n: sa.is_square(n),
        "is_squarefree": is_squarefree,
        "is_even": lambda n: n % 2 == 0,
        "is_odd": lambda n: n % 2 == 1,
        "is_one": lambda n: n == 1,
        "is_zero": lambda n: n == 0,
        "is_unit": lambda n: n in (1, -1),
        "is_integral": lambda n: True,
        "sqrt": isqrt_exact,
        "isqrt": lambda n: _m.isqrt(n),
        "nth_root": nth_root,
        "digits": lambda n, base=10: sa.digits(n, base),
        "ndigits": ndigits,
        "divisors": lambda n: sa.divisors(n),
        "number_of_divisors": lambda n: sa.number_of_divisors(n),
        "prime_divisors": prime_divisors,
        "prime_factors": prime_divisors,
        "next_prime": lambda n, proof=None: sa.next_prime(n, proof=proof),
        "previous_prime": lambda n, proof=None: sa.previous_prime(n, proof=proof),
        "next_probable_prime": lambda n: sa.next_prime(n),
        "binomial": lambda n, k: sa.binomial(n, k),
        "factorial": lambda n: sa.factorial(n),
        "binary": binary,
        "str": int_str,
        "nbits": lambda n: abs(n).bit_length(),
        "popcount": lambda n: bin(n).count("1"),
        "abs": lambda n: abs(n),
        "inverse_mod": lambda n, m: sa.inverse_mod(n, m),
        "powermod": lambda n, k, m: pow(n, k, m),
        "gcd": lambda n, m: sa.gcd(n, m),
        "lcm": lambda n, m: sa.lcm(n, m),
        "xgcd": lambda n, m: sa.xgcd(n, m),
        "mod": lambda n, m: n % m,
        "quo_rem": quo_rem,
        "valuation": lambda n, p: sa.oo if (sa._valuation_base(p) and n == 0) else sa.valuation(n, p),
        "euler_phi": lambda n: sa.euler_phi(n),
        "sigma": lambda n, k=1: sa.sigma(n, k),
        "moebius": lambda n: sa.moebius(n),
        # (at the precision asked: it was ignored, the systematic review's
        # API-F5)
        "n": lambda n, prec=None, digits=None: _int_n(n, prec, digits),
        "N": lambda n, prec=None, digits=None: _int_n(n, prec, digits),
        "numerical_approx": lambda n, prec=None, digits=None: _int_n(n, prec, digits),
        "parent": lambda n: sa.ZZ,
        "floor": lambda n: n,
        "ceil": lambda n: n,
        "round": lambda n: n,
        "squarefree_part": lambda n: sa.prod([p for p, e in sa.factor(abs(n)) if e % 2]) * (1 if n > 0 else -1),
        "kronecker": lambda n, b: sa.kronecker(n, b) if hasattr(sa, "kronecker") else None,
        "multiplicative_order": None,
    }
    try:
        import _sbengine
    except ImportError:
        return _integer_class(sa, methods)
    _sbengine.extend_type(int, "numerator", property(lambda n: _CallableInt(n)))
    _sbengine.extend_type(int, "denominator", property(lambda n: _CallableInt(1)))
    for name, f in methods.items():
        if f is None:
            continue
        f.__name__ = name
        _sbengine.extend_type(int, name, f)


def _integer_class(sa, methods):
    """Sage's Integer for CPython: an int with Sage's methods, closed under
    arithmetic; a / b and negative powers give Rationals, as in Sage."""

    def wrap(r):
        return Integer(r) if type(r) is int else r

    class Integer(int):
        __slots__ = ()

        def __repr__(self):
            return int.__repr__(self)

        numerator = property(lambda n: _CallableInt(n))
        denominator = property(lambda n: _CallableInt(1))

        def __truediv__(self, other):
            if isinstance(other, int):
                return sa._QQ(int(self), int(other))
            return NotImplemented

        def __rtruediv__(self, other):
            if isinstance(other, int):
                return sa._QQ(int(other), int(self))
            return NotImplemented

        def __pow__(self, other, mod=None):
            if mod is None and isinstance(other, int) and other < 0:
                return sa._QQ(1, int(self) ** -int(other))
            r = int.__pow__(self, other, mod)
            return wrap(r) if r is not NotImplemented else r

    for op in ("add", "sub", "mul", "floordiv", "mod", "lshift", "rshift", "and", "or", "xor"):
        for name in ("__%s__" % op, "__r%s__" % op):
            def f(a, b, _g=getattr(int, name)):
                r = _g(a, b)
                return wrap(r) if r is not NotImplemented else r
            f.__name__ = name
            setattr(Integer, name, f)
    # 0 < x is the relation 0 < x (not x > 0), as in Sage
    for name in ("__lt__", "__le__", "__gt__", "__ge__"):
        def c(a, b, _g=getattr(int, name), _n=name):
            r = _g(a, b)
            if r is NotImplemented and type(b).__name__ == "Expression":
                from _sage_expr import _expr
                return getattr(_expr(int(a)), _n)(b)
            return r
        c.__name__ = name
        setattr(Integer, name, c)
    for name in ("__neg__", "__pos__", "__abs__"):
        def g(a, _g=getattr(int, name)):
            return Integer(_g(a))
        g.__name__ = name
        setattr(Integer, name, g)

    def int_str(n, base=10):
        return methods["str"](int(n), base)

    for name, f in methods.items():
        if f is None or name == "str":
            continue
        setattr(Integer, name, (lambda f: lambda self, *a, **k: wrap(f(int(self), *a, **k)))(f))
    Integer.str = int_str
    Integer.__module__ = "sagebrush.sage"
    Integer.__qualname__ = Integer.__name__ = "Integer"
    return Integer



# ---------------------------------------------------------------- proof flags

def _make_proof():
    """Sage's global proof flags (sage.structure.proof.all): whether
    results must be proven or may rely on unproven (if overwhelmingly
    likely) steps.  sagebrush consults proof.polynomial() for Groebner
    bases over QQ: without it, the basis of one F4 run over QQ whose
    matrices are reconstructed from their images modulo primes, skipping
    the final exact check.

        sage: proof.polynomial()
        True
        sage: sorted(proof.all().items())
        [('arithmetic', True), ('elliptic_curve', True), ('linear_algebra', True), ('number_field', True), ('other', True), ('polynomial', True)]
        sage: proof.polynomial(False)
        sage: proof.polynomial(), proof.arithmetic()
        (False, True)
        sage: proof.polynomial(True)
        sage: with proof.WithProof('polynomial', False):
        ....:     proof.polynomial()
        False
        sage: proof.polynomial()
        True
    """
    import types as _types
    m = _types.ModuleType("sage.structure.proof.all")
    flags = {k: True for k in ("arithmetic", "elliptic_curve", "linear_algebra", "number_field", "polynomial", "other")}

    def flag(name):
        def f(t=None):
            if t is None:
                return flags[name]
            flags[name] = bool(t)
        f.__name__ = f.__qualname__ = name
        f.__doc__ = "Whether %s results must be proven (default True); with an argument, set it." % name.replace("_", " ")
        return f

    for k in flags:
        if k != "other":
            setattr(m, k, flag(k))

    def all(t=None):
        if t is None:
            return dict(flags)
        for k in flags:
            flags[k] = bool(t)
    m.all = all

    class WithProof:
        """A context in which the proof flag `subsystem` is `t`."""

        def __init__(self, subsystem, t):
            self._s, self._t = subsystem, bool(t)

        def __enter__(self):
            self._old = flags[self._s]
            flags[self._s] = self._t

        def __exit__(self, *exc):
            flags[self._s] = self._old
    m.WithProof = WithProof
    m._flags = flags
    import sys as _sys
    _sys.modules.setdefault("sage.structure.proof.all", m)
    return m


proof = _make_proof()
