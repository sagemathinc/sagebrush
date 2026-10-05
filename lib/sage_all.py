"""A small, pure-Python taste of Sage, imported into Sage mode.

Sage mode (``sagebrush --sage``, ``.sage`` files, the Sage toggle on
sagebrush.space) changes the syntax: ``^`` is exponentiation, ``^^`` is
xor and ``/`` on two integers gives an exact :class:`Rational`.  This
module supplies Rational and a handful of Sage's number theory functions.
"""

import math as _math
from fractions import Fraction as _Fraction

__all__ = [
    # modular forms and elliptic curves (Sagebrush's engines)
    "ModularSymbols", "ModularForms", "CuspForms", "Gamma0", "DirichletGroup", "EllipticCurve",
    "Newforms", "newform_orbits",
    "Rational", "Integer", "ZZ", "QQ", "RR", "factor", "Factorization",
    "PolynomialRing", "polygen", "parent",
    "is_prime", "is_prime_power", "is_square", "next_prime", "previous_prime", "nth_prime",
    "prime_range", "primes", "primes_first_n", "prime_pi", "divisors", "number_of_divisors",
    "sigma", "euler_phi", "moebius", "gcd", "lcm", "xgcd", "inverse_mod", "power_mod", "crt",
    "binomial", "factorial", "fibonacci", "isqrt", "sqrt", "srange", "prod", "continued_fraction",
    "numerator", "denominator", "valuation", "digits", "n", "N", "pi", "e",
    # symbolic expressions (just enough for plotting)
    "var", "x", "sin", "cos", "tan", "asin", "acos", "atan", "arcsin", "arccos", "arctan", "atan2",
    "arctan2", "sinh", "cosh", "tanh", "exp", "log", "ln", "floor", "ceil", "gamma",
    # graphics
    "Graphics", "plot", "parametric_plot", "polar_plot", "list_plot", "line", "line2d", "point",
    "points", "point2d", "text", "polygon", "polygon2d", "circle", "disk", "arrow", "arrow2d",
    "bar_chart", "show", "graphics_array", "animate", "Animation",
    # interact
    "interact", "slider", "range_slider", "selector", "checkbox", "input_box", "color_selector",
    "text_control",
]

from _sage_expr import (Expr as _Expr, var, x, pi, e, sin, cos, tan, asin, acos, atan, arcsin,
                        arccos, arctan, atan2, arctan2, sinh, cosh, tanh, exp, log, ln, floor, ceil,
                        gamma)
from sage_plot import (Graphics, plot, parametric_plot, polar_plot, list_plot, line, line2d, point,
                       points, point2d, text, polygon, polygon2d, circle, disk, arrow, arrow2d,
                       bar_chart, show, graphics_array, animate, Animation)
from _sage_modular import (ModularSymbols, ModularForms, CuspForms, Gamma0, DirichletGroup,
                           EllipticCurve, Newforms, newform_orbits)
from _sage_poly import ZZ, QQ, PolynomialRing, polygen, Polynomial as _Polynomial


def parent(x):
    """The parent structure of x: ZZ, QQ, a polynomial ring, ..."""
    if hasattr(x, "parent"):
        return x.parent()
    if isinstance(x, bool) or isinstance(x, int):
        return ZZ
    if isinstance(x, _Fraction):
        return QQ
    raise NotImplementedError("parent of %r" % (x,))


from _interact import (interact, slider, range_slider, selector, checkbox, input_box,
                       color_selector, text_control)


# ------------------------------------------------------------------ Rational

def _q(x):
    # A Fraction result as Sage would show it: an int when it is integral.
    if type(x) is _Fraction:
        if x._denominator == 1:
            return x._numerator
        return Rational._from_coprime_ints(x._numerator, x._denominator)
    return x


def _lift(name):
    # Do the arithmetic on a plain Fraction: with a Rational operand, Python
    # would try Rational's reflected method first and recurse.
    op = getattr(_Fraction, name)

    def f(a, b):
        return _q(op(_Fraction._from_coprime_ints(a._numerator, a._denominator), b))
    f.__name__ = name
    return f


class Rational(_Fraction):
    """An exact rational number, such as ``2/3`` in Sage mode."""

    __slots__ = ()

    def __repr__(self):
        return f"{self._numerator}/{self._denominator}"

    __str__ = __repr__

    def _repr_latex_(self):
        return f"$\\frac{{{self._numerator}}}{{{self._denominator}}}$"

    __add__ = _lift("__add__")
    __radd__ = _lift("__radd__")
    __sub__ = _lift("__sub__")
    __rsub__ = _lift("__rsub__")
    __mul__ = _lift("__mul__")
    __rmul__ = _lift("__rmul__")
    __truediv__ = _lift("__truediv__")
    __rtruediv__ = _lift("__rtruediv__")
    __mod__ = _lift("__mod__")
    __rmod__ = _lift("__rmod__")
    __pow__ = _lift("__pow__")
    __rpow__ = _lift("__rpow__")

    def __neg__(self):
        return Rational._from_coprime_ints(-self._numerator, self._denominator)

    def __pos__(self):
        return self

    def __abs__(self):
        return Rational._from_coprime_ints(abs(self._numerator), self._denominator)

    def n(self, digits=None):
        return float(self)

    def floor(self):
        return _math.floor(self)

    def ceil(self):
        return _math.ceil(self)

    def is_integer(self):
        return self._denominator == 1


def _intdiv(a, b):
    # The runtime's `/` on two ints in Sage mode.
    if b == 0:
        raise ZeroDivisionError("rational division by zero")
    a, b = int(a), int(b)
    if b < 0:
        a, b = -a, -b
    g = _math.gcd(a, b)
    if g != 1:
        a //= g
        b //= g
    if b == 1:
        return a
    return Rational._from_coprime_ints(a, b)


def Integer(x):
    return int(x)


def _QQ(x, d=None):
    """QQ(2, 3) or QQ("2/3") or QQ(0.75): the exact rational."""
    f = _Fraction(x) if d is None else _Fraction(x, d)
    if type(f) is not _Fraction:
        f = _Fraction(f._numerator, f._denominator)
    return _q(f)


def RR(x):
    return float(x)


def numerator(x):
    return x.numerator


def denominator(x):
    return x.denominator


def n(x, digits=None):
    """The numerical approximation of x (a float)."""
    return float(x)


N = n


# ------------------------------------------------------------------ primes

_SMALL = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97)


def _sprp(n, a):
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    x = pow(a, d, n)
    if x == 1 or x == n - 1:
        return True
    for _ in range(s - 1):
        x = x * x % n
        if x == n - 1:
            return True
    return False


def _lucas_prp(n):
    # Strong Lucas probable prime test with Selfridge's parameters.
    d = 5
    while True:
        j = _jacobi(d, n)
        if j == -1:
            break
        if j == 0 and abs(d) != n:
            return False
        d = -d - 2 if d > 0 else -d + 2
        if d == 13 and is_square(n):
            return False
    p, q = 1, (1 - d) // 4
    k, s = n + 1, 0
    while k % 2 == 0:
        k //= 2
        s += 1
    u, v, qk = 1, p, q
    for bit in bin(k)[3:]:
        u, v = u * v % n, (v * v - 2 * qk) % n
        qk = qk * qk % n
        if bit == "1":
            u, v = p * u + v, d * u + p * v
            if u % 2:
                u += n
            if v % 2:
                v += n
            u, v = (u // 2) % n, (v // 2) % n
            qk = qk * q % n
    if u == 0 or v == 0:
        return True
    for _ in range(s - 1):
        v = (v * v - 2 * qk) % n
        if v == 0:
            return True
        qk = qk * qk % n
    return False


def _jacobi(a, n):
    a %= n
    result = 1
    while a:
        while a % 2 == 0:
            a //= 2
            if n % 8 in (3, 5):
                result = -result
        a, n = n, a
        if a % 4 == 3 and n % 4 == 3:
            result = -result
        a %= n
    return result if n == 1 else 0


def is_prime(n):
    """Whether n is prime (deterministic below 3.3e24, BPSW above)."""
    n = int(n)
    if n < 2:
        return False
    for p in _SMALL:
        if n % p == 0:
            return n == p
    if n < 10201:
        return True
    if n < 3317044064679887385961981:
        return all(_sprp(n, a) for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41) if a < n)
    return _sprp(n, 2) and _lucas_prp(n)


def next_prime(n):
    """The smallest prime > n."""
    n = int(n) + 1
    if n <= 2:
        return 2
    if n % 2 == 0:
        n += 1
    while not is_prime(n):
        n += 2
    return n


def previous_prime(n):
    """The largest prime < n."""
    n = int(n) - 1
    if n < 2:
        raise ValueError("no prime less than 2")
    while not is_prime(n):
        n -= 1
    return n


def prime_range(start, stop=None):
    """The primes p with start <= p < stop (or 2 <= p < start)."""
    if stop is None:
        start, stop = 2, start
    start, stop = max(int(start), 2), int(stop)
    if stop <= start:
        return []
    sieve = bytearray([1]) * stop
    sieve[0:2] = b"\x00\x00"
    for p in range(2, isqrt(stop - 1) + 1):
        if sieve[p]:
            sieve[p * p::p] = bytes(len(range(p * p, stop, p)))
    return [i for i in range(start, stop) if sieve[i]]


def primes(start, stop=None):
    """Iterate over the primes in [start, stop) (or [2, start))."""
    if stop is None:
        start, stop = 2, start
    p = next_prime(int(start) - 1)
    while p < stop:
        yield p
        p = next_prime(p)


def primes_first_n(k):
    out, p = [], 1
    while len(out) < k:
        p = next_prime(p)
        out.append(p)
    return out


def nth_prime(k):
    if k < 1:
        raise ValueError("n must be positive")
    return primes_first_n(k)[-1]


def prime_pi(x):
    """The number of primes <= x."""
    return len(prime_range(int(x) + 1))


# ------------------------------------------------------------------ factoring

def _rho(n):
    # Pollard rho, Brent's variant: a nontrivial factor of composite odd n.
    c = 1
    while True:
        y, r, q, g = 2, 1, 1, 1
        f = lambda x: (x * x + c) % n
        while g == 1:
            x = y
            for _ in range(r):
                y = f(y)
            k = 0
            while k < r and g == 1:
                ys = y
                for _ in range(min(128, r - k)):
                    y = f(y)
                    q = q * abs(x - y) % n
                g = _math.gcd(q, n)
                k += 128
            r *= 2
        if g == n:
            g = 1
            while g == 1:
                ys = f(ys)
                g = _math.gcd(abs(x - ys), n)
        if g != n:
            return g
        c += 1


def _factor_into(n, out):
    if n == 1:
        return
    if is_prime(n):
        out[n] = out.get(n, 0) + 1
        return
    d = _rho(n)
    _factor_into(d, out)
    _factor_into(n // d, out)


class Factorization(list):
    """A factorization: a list of (prime, exponent) pairs that prints like Sage."""

    def __init__(self, pairs, unit=1):
        super().__init__(pairs)
        self.unit = unit

    def __repr__(self):
        if not self:
            return str(self.unit)
        s = " * ".join(f"{p}^{e}" if e > 1 else str(p) for p, e in self)
        return ("-" if self.unit == -1 else "") + s

    __str__ = __repr__

    def value(self):
        v = self.unit
        for p, e in self:
            v *= p ** e
        return v

    def expand(self):
        return self.value()


def factor(n):
    """The prime factorization of a nonzero integer (or Rational), or of a
    polynomial."""
    if isinstance(n, _Polynomial):
        return n.factor()
    if isinstance(n, _Fraction) and n.denominator != 1:
        num, den = factor(n.numerator), factor(n.denominator)
        pairs = sorted(list(num) + [(p, -e) for p, e in den])
        return Factorization(pairs, num.unit)
    n = int(n)
    if n == 0:
        raise ArithmeticError("factorization of 0 is not defined")
    unit = -1 if n < 0 else 1
    n = abs(n)
    out = {}
    for p in _SMALL:
        while n % p == 0:
            out[p] = out.get(p, 0) + 1
            n //= p
    _factor_into(n, out)
    return Factorization(sorted(out.items()), unit)


def divisors(n):
    """The sorted list of positive divisors of n."""
    ds = [1]
    for p, e in factor(abs(int(n))):
        ds = [d * p ** k for d in ds for k in range(e + 1)]
    return sorted(ds)


def number_of_divisors(n):
    return prod(e + 1 for _, e in factor(n))


def sigma(n, k=1):
    """The sum of the k-th powers of the divisors of n."""
    return sum(d ** k for d in divisors(n))


def euler_phi(n):
    n = int(n)
    if n < 1:
        return 0
    r = n
    for p, _ in factor(n):
        r = r // p * (p - 1)
    return r


def moebius(n):
    f = factor(n)
    if any(e > 1 for _, e in f):
        return 0
    return -1 if len(f) % 2 else 1


def is_prime_power(n):
    return int(n) > 1 and len(factor(n)) == 1


def is_square(n):
    n = int(n)
    return n >= 0 and isqrt(n) ** 2 == n


def valuation(n, p):
    """The exponent of the prime p in n."""
    n, v = int(n), 0
    if n == 0:
        raise ValueError("valuation of 0 is infinite")
    while n % p == 0:
        n //= p
        v += 1
    return v


def digits(n, base=10):
    """The digits of n in base, least significant first (as in Sage)."""
    n, out = abs(int(n)), []
    while n:
        n, d = divmod(n, base)
        out.append(d)
    return out


# ------------------------------------------------------------------ arithmetic

def gcd(*args):
    if len(args) == 1:
        args = tuple(args[0])
    if any(isinstance(a, _Polynomial) for a in args):
        r = args[0]
        for a in args[1:]:
            r = r.gcd(a) if isinstance(r, _Polynomial) else a.gcd(r)
        return r
    if any(isinstance(a, _Fraction) for a in args):
        r = _Fraction(0)
        for a in args:
            a = _Fraction(a)
            r = _Fraction(_math.gcd(r.numerator, a.numerator), _math.lcm(r.denominator, a.denominator))
        return _q(r)
    return _math.gcd(*args)


def lcm(*args):
    if len(args) == 1:
        args = tuple(args[0])
    return _math.lcm(*args)


def xgcd(a, b):
    """(g, s, t) with g = gcd(a, b) = s*a + t*b."""
    x0, x1, y0, y1 = 1, 0, 0, 1
    while b:
        q, a, b = a // b, b, a % b
        x0, x1 = x1, x0 - q * x1
        y0, y1 = y1, y0 - q * y1
    if a < 0:
        a, x0, y0 = -a, -x0, -y0
    return (a, x0, y0)


def inverse_mod(a, m):
    return pow(a, -1, m)


def power_mod(a, k, m):
    return pow(a, k, m)


def crt(a, b, m=None, n=None):
    """crt(a, b, m, n): x with x = a mod m and x = b mod n; or crt([a...], [m...])."""
    if m is None:
        rs, ms = list(a), list(b)
    else:
        rs, ms = [a, b], [m, n]
    x, M = 0, 1
    for r, mi in zip(rs, ms):
        g, s, _ = xgcd(M, mi)
        if (r - x) % g:
            raise ValueError("no solution to crt problem since gcd(%s,%s) does not divide %s-%s" % (M, mi, x, r))
        x += M * ((r - x) // g * s % (mi // g))
        M = M * mi // g
        x %= M
    return x


def binomial(n, k):
    return _math.comb(n, k) if k >= 0 and n >= 0 else _binom_general(n, k)


def _binom_general(n, k):
    if k < 0:
        return 0
    r = 1
    for i in range(k):
        r = r * (n - i) // (i + 1)
    return r


def factorial(n):
    return _math.factorial(n)


def fibonacci(n):
    """The n-th Fibonacci number (fast doubling)."""
    def fib(k):
        if k == 0:
            return (0, 1)
        a, b = fib(k >> 1)
        c = a * (2 * b - a)
        d = a * a + b * b
        return (d, c + d) if k & 1 else (c, d)
    n = int(n)
    if n < 0:
        return (-1) ** (n + 1) * fibonacci(-n)
    return fib(n)[0]


def isqrt(n):
    return _math.isqrt(int(n))


def sqrt(x):
    """Exact for perfect squares (of integers and rationals), else a float."""
    if isinstance(x, _Expr):
        return _Expr("fn", ("sqrt", x))
    if isinstance(x, int) and x >= 0:
        r = _math.isqrt(x)
        if r * r == x:
            return r
    elif isinstance(x, _Fraction) and x >= 0:
        a, b = _math.isqrt(x.numerator), _math.isqrt(x.denominator)
        if a * a == x.numerator and b * b == x.denominator:
            return _q(_Fraction(a, b))
    if x < 0:
        return complex(0, _math.sqrt(-x))
    return _math.sqrt(x)


def srange(start, stop=None, step=1):
    """range() that also accepts Rationals."""
    if stop is None:
        start, stop = 0, start
    out = []
    x = start
    while (x < stop) if step > 0 else (x > stop):
        out.append(x)
        x = x + step
    return out


def prod(xs, start=1):
    r = start
    for x in xs:
        r = r * x
    return r


def continued_fraction(x, nterms=20):
    if isinstance(x, _Expr):
        x = float(x)
    """The (simple) continued fraction partial quotients of x."""
    if isinstance(x, (int, _Fraction)):
        f = _Fraction(x)
        out = []
        while True:
            a = _math.floor(f)
            out.append(a)
            f -= a
            if f == 0:
                return out
            f = 1 / f
    out = []
    for _ in range(nterms):
        a = _math.floor(x)
        out.append(a)
        x -= a
        if x < 1e-12:
            break
        x = 1 / x
    return out
