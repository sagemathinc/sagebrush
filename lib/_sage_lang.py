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
    """[a..b], [a,b..c], [a..b, step=s] as Sage computes them."""
    return _ellipsis(args, step, False)[0]


def ellipsis_iter(*args, step=None):
    """(a..b), (a,b..), (a..): an iterator, possibly infinite."""
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

class RealNumber(float):
    """A 53-bit real, printed as Sage prints elements of RR."""

    __slots__ = ()

    def __new__(cls, x=0.0):
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

    def n(self, digits=None, prec=None):
        return self

    numerical_approx = N = n

    def sqrt(self):
        return RealNumber(_m.sqrt(self)) if self >= 0 else complex(0, _m.sqrt(-self))

    def exp(self):
        return RealNumber(_m.exp(self))

    def log(self, base=None):
        return RealNumber(_m.log(self) if base is None else _m.log(self, base))

    def floor(self):
        return _m.floor(self)

    def ceil(self):
        return _m.ceil(self)

    def __round__(self, ndigits=None):
        # Python's rounding (half to even), as Sage's round(x)
        if ndigits is not None:
            return RealNumber(round(float(self), ndigits))
        return round(float(self))

    def round(self):
        return int(_m.floor(self + 0.5)) if self >= 0 else -int(_m.floor(-self + 0.5))

    def parent(self):
        return _RealField()

    def is_integer(self):
        return float(self).is_integer()

    def abs(self):
        return abs(self)


class _RealField:
    def __repr__(self):
        return "Real Field with 53 bits of precision"

    def __call__(self, x):
        return RealNumber(float(x))


# ------------------------------------------------------------------ f(x) = ...

class SymbolicFunction:
    """f(x) = x^2: a callable expression, printed x |--> x^2."""

    def __init__(self, expr, args):
        self._expr, self._args = expr, tuple(args)

    def __repr__(self):
        a = self._args[0] if len(self._args) == 1 else "(" + ", ".join(map(str, self._args)) + ")"
        return "%s |--> %s" % (a, self._expr)

    def __call__(self, *vals, **kw):
        if len(vals) != len(self._args):
            raise ValueError("the number of arguments must be less than or equal to %d" % len(self._args))
        subs = {str(a): v for a, v in zip(self._args, vals)}
        return _evaluate(self._expr, subs)

    def variables(self):
        return self._args

    arguments = variables


def _evaluate(e, subs):
    """e with variables replaced, evaluated as Sage would: exactly for
    integers and rationals, numerically for reals, symbolic otherwise."""
    from _sage_expr import Expr, _wrap
    import sage_all as sa
    if not isinstance(e, Expr):
        return e
    op, a = e.op, e.args
    if op == "var":
        return subs.get(a[0], e)
    if op == "num":
        return a[0]
    if op == "const":
        return e
    if op == "fn":
        args = [_evaluate(x, subs) for x in a[1:]]
        if any(isinstance(x, float) for x in args) and not any(isinstance(x, Expr) for x in args):
            return getattr(sa, a[0])(*args)
        if a[0] == "abs" and not any(isinstance(x, Expr) for x in args):
            return abs(args[0])
        return Expr("fn", (a[0],) + tuple(_wrap(x) for x in args))
    if op == "neg":
        return -_evaluate(a[0], subs)
    x, y = _evaluate(a[0], subs), _evaluate(a[1], subs)
    if op == "+":
        return x + y
    if op == "-":
        return x - y
    if op == "*":
        return x * y
    if op == "/":
        if isinstance(x, int) and isinstance(y, int):
            return sa._intdiv(x, y)
        return x / y
    if op == "^":
        if isinstance(x, int) and isinstance(y, int) and y < 0:
            return sa._intdiv(1, x ** -y)
        return x ** y
    raise ValueError(op)


class _Symbolic:
    def __init__(self, e):
        self.e = e

    def function(self, *args):
        return SymbolicFunction(self.e, args)


def symbolic_expression(e):
    return _Symbolic(e)


# ------------------------------------------------------------------ Integer methods

class _CallableInt(int):
    """An int that is also a method returning itself: Sage's x.numerator()
    next to Python's x.numerator."""

    __slots__ = ()

    def __call__(self):
        return int(self)


def _install_int_methods(sa):
    """Sage's Integer methods on Python ints, from sage_all's functions."""
    import _sbengine

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
    _sbengine.extend_type(int, "numerator", property(lambda n: _CallableInt(n)))
    _sbengine.extend_type(int, "denominator", property(lambda n: _CallableInt(1)))
    for name, f in methods.items():
        if f is None:
            continue
        f.__name__ = name
        _sbengine.extend_type(int, name, f)
