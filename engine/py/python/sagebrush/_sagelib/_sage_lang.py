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
    not repeated if it was hit, or (2) without an explicit step, b in
    `a, b, ..`, which sets the step to b - a, or (3) a lone start; later
    segments inherit the step; an empty segment contributes nothing.
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
            if step is None and i >= 2 and (i < 3 or args[i - 3] is not Ellipsis):
                a = out.pop()
                cur = start - a
                start = a
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

class RealNumber(float):
    """A 53-bit real, printed as Sage prints elements of RR.

    EXAMPLES::

        sage: x = RR(2); x
        2.00000000000000
        sage: x.sqrt(), x.exp(), x / 3
        (1.41421356237310, 7.38905609893065, 0.666666666666667)
    """

    __slots__ = ()

    def __new__(cls, x=0.0):
        if isinstance(x, str) and cls is RealNumber:
            # a literal keeps its decimal digits, for exact conversion into
            # higher precision: RealField(100)(0.1) = 0.1000...0
            r = _RealLiteral(float(x))
            r._lit = x
            return r
        if isinstance(x, str):
            x = float(x)
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

    # arithmetic stays in RR
    def _r(f):
        def g(self, *a):
            r = f(float(self), *a)
            return RealNumber(r) if isinstance(r, float) else r
        g.__name__ = f.__name__
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
        return RealNumber(_m.exp(self))

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
        def g(self):
            return RealNumber(getattr(_m, name)(float(self)))
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
            return RealNumber(g(float(self)))
        import _sage_real
        from fractions import Fraction
        return RealNumber(float(_sage_real.RealField(60)(_sage_real._gamma(Fraction(float(self)), 60))))

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


class _RealDigits(RealNumber):
    """An element of RR shown to more digits than 53 bits carry (from
    n(rational, digits=...)); arithmetic on it is in 53 bits."""

    def __repr__(self):
        return self._repr

    __str__ = __repr__


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
        if isinstance(x, str):
            return RealNumber(float(x))
        if type(x).__name__ == "RealNumberMP":
            return RealNumber(float(x))
        return RealNumber(float(x))

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

    EXAMPLES::

        sage: f(x) = x^2 + 1; f
        x |--> x^2 + 1
        sage: f(3), f.diff(), f(x).integrate(x)
        (10, x |--> 2*x, 1/3*x^3 + x)
    """

    def __init__(self, expr, args):
        from _sage_expr import _expr
        self._expr, self._args = _expr(expr), tuple(args)

    def __repr__(self):
        a = self._args[0] if len(self._args) == 1 else "(" + ", ".join(map(str, self._args)) + ")"
        return "%s |--> %s" % (a, self._expr)

    __str__ = __repr__

    def _latex_(self):
        a = self._args[0]._latex_() if len(self._args) == 1 else \
            "\\left(%s\\right)" % ", ".join(v._latex_() for v in self._args)
        return "%s \\ {\\mapsto}\\ %s" % (a, self._expr._latex_())

    def __call__(self, *vals, **kw):
        """Substitute the arguments.

        EXAMPLES::

            sage: f(x, y) = x^2 + y
            sage: f(1, 2), f(x, 3)
            (3, x^2 + 3)
        """
        if len(vals) != len(self._args):
            raise ValueError("the number of arguments must be less than or equal to %d" % len(self._args))
        return self._expr.subs(dict(zip(self._args, vals)))

    def variables(self):
        """The arguments (as Sage's variables()).

        EXAMPLES::

            sage: f(x, y) = x*y
            sage: f.variables()
            (x, y)
        """
        return self._args

    arguments = variables

    def expression(self):
        """The expression, as an ordinary symbolic expression.

        EXAMPLES::

            sage: f(x) = sin(x)^2
            sage: f.expression()  # sagebrush only
            sin(x)^2
        """
        return self._expr

    def _fast_callable(self, names=None):
        return self._expr._fast_callable(names if names is not None else [str(a) for a in self._args])

    def _wrap(self, r):
        from _sage_expr import Expression
        if isinstance(r, Expression) and not r.is_relational():
            return SymbolicFunction(r, self._args)
        return r

    def diff(self, *args):
        """The derivative, as a callable expression.

        EXAMPLES::

            sage: f(x) = x^3
            sage: f.diff(), f.derivative(x, 2), f.differentiate()
            (x |--> 3*x^2, x |--> 6*x, x |--> 3*x^2)
        """
        return self._wrap(self._expr.diff(*(args or self._args[:1])))

    derivative = differentiate = diff

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

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        m = getattr(self._expr, name)
        if not callable(m):
            return m

        def f(*args, **kw):
            return self._wrap(m(*args, **kw))
        return f


def _evaluate(e, subs):
    """e with the variables named in subs replaced (Sage evaluates)."""
    from _sage_expr import Expression
    if not isinstance(e, Expression):
        return e
    return e.subs(**subs)


def symbolic_expression(e):
    """The symbolic expression of a number or string.

    EXAMPLES::

        sage: symbolic_expression(2) + x
        x + 2
        sage: symbolic_expression(x^2).function(x)
        x |--> x^2
    """
    from _sage_expr import _expr
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


def _install_int_methods(sa):
    """Sage's Integer methods on Python ints, from sage_all's functions (in
    pyjs); under CPython, which cannot extend int, an Integer subclass of
    int with those methods, returned for sage_all.Integer."""

    def isqrt_exact(n):
        r = _m.isqrt(n)
        return r if r * r == n else sa.sqrt(n)

    def nth_root(n, k, truncate_mode=False):
        r = round(abs(n) ** (1.0 / k))
        for c in (r - 1, r, r + 1):
            if c ** k == abs(n):
                return -c if n < 0 else c
        raise ValueError("%d is not a %dth power" % (n, k))

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
        "factor": lambda n: sa.factor(n),
        "is_prime": lambda n, proof=None: sa.is_prime(n),
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
        "next_prime": lambda n, proof=None: sa.next_prime(n),
        "previous_prime": lambda n, proof=None: sa.previous_prime(n),
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
        "valuation": lambda n, p: sa.valuation(n, p),
        "euler_phi": lambda n: sa.euler_phi(n),
        "sigma": lambda n, k=1: sa.sigma(n, k),
        "moebius": lambda n: sa.moebius(n),
        "n": lambda n, digits=None, prec=None: RealNumber(n),
        "N": lambda n, digits=None, prec=None: RealNumber(n),
        "numerical_approx": lambda n, digits=None, prec=None: RealNumber(n),
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

