"""The methods of Sage's integers (elements of ZZ) in Sagebrush.

In pyjs, ZZ's elements are Python ints, and _sage_lang installs these
functions on int as its methods; under CPython they are the methods of
sage_all.Integer, an int subclass.  Each takes the integer as its first
argument, so ``ZZ(60).factor()`` calls ``factor(60)``.  The help text and
the examples here are what ``help(n.factor)`` shows, and the examples run
in CI (test/doctest.test.ts) and are checked against Sage
(scripts/doctest-oracle.py).
"""

import builtins as _b
import math as _m


def _sa():
    import sage_all
    return sage_all


# ------------------------------------------------------------------ primes and factors

def factor(n, proof=None, **kwds):
    """The factorization of n into primes, with the sign as a unit.

    EXAMPLES::

        sage: ZZ(360).factor()
        2^3 * 3^2 * 5
        sage: ZZ(-60).factor()
        -1 * 2^2 * 3 * 5
        sage: list(ZZ(360).factor())
        [(2, 3), (3, 2), (5, 1)]
    """
    return _sa().factor(n, proof=proof)


def is_prime(n, proof=None):
    """Whether n is a prime number.

    EXAMPLES::

        sage: ZZ(97).is_prime(), ZZ(91).is_prime(), ZZ(1).is_prime()
        (True, False, False)
        sage: ZZ(2^61 - 1).is_prime()
        True
    """
    return _sa().is_prime(n, proof=proof)


def is_pseudoprime(n):
    """Whether n passes a probable-prime test (every prime does).

    EXAMPLES::

        sage: ZZ(101).is_pseudoprime(), ZZ(100).is_pseudoprime()
        (True, False)
    """
    return _sa().is_prime(n)


def is_prime_power(n):
    """Whether n is p^k for a prime p and some k >= 1.

    EXAMPLES::

        sage: ZZ(81).is_prime_power(), ZZ(7).is_prime_power(), ZZ(12).is_prime_power(), ZZ(1).is_prime_power()
        (True, True, False, False)
    """
    return _sa().is_prime_power(n)


def is_square(n):
    """Whether n is the square of an integer.

    EXAMPLES::

        sage: ZZ(144).is_square(), ZZ(2).is_square(), ZZ(0).is_square()
        (True, False, True)
    """
    return _sa().is_square(n)


def is_squarefree(n):
    """Whether no square of a prime divides n.

    EXAMPLES::

        sage: ZZ(30).is_squarefree(), ZZ(12).is_squarefree()
        (True, False)
    """
    return all(e == 1 for _, e in _sa().factor(_b.abs(n))) if n else False


def prime_divisors(n):
    """The primes dividing n, in increasing order.

    EXAMPLES::

        sage: ZZ(360).prime_divisors(), ZZ(-12).prime_divisors()
        ([2, 3, 5], [2, 3])
    """
    return [p for p, _ in _sa().factor(_b.abs(n))]


prime_factors = prime_divisors


def next_prime(n, proof=None):
    """The smallest prime greater than n.

    EXAMPLES::

        sage: ZZ(100).next_prime(), ZZ(7).next_prime()
        (101, 11)
    """
    return _sa().next_prime(n, proof=proof)


def next_probable_prime(n):
    """The smallest probable prime greater than n.

    EXAMPLES::

        sage: ZZ(1000).next_probable_prime()
        1009
    """
    return _sa().next_prime(n)


def previous_prime(n, proof=None):
    """The largest prime less than n.

    EXAMPLES::

        sage: ZZ(100).previous_prime(), ZZ(11).previous_prime()
        (97, 7)
    """
    return _sa().previous_prime(n, proof=proof)


def divisors(n):
    """The positive divisors of n, in increasing order.

    EXAMPLES::

        sage: ZZ(12).divisors()
        [1, 2, 3, 4, 6, 12]
        sage: ZZ(-9).divisors()
        [1, 3, 9]
    """
    return _sa().divisors(n)


def number_of_divisors(n):
    """How many positive divisors n has.  (A Sagebrush method: in Sage, call
    the function, number_of_divisors(n).)

    EXAMPLES::

        sage: number_of_divisors(12)
        6

        sage: ZZ(12).number_of_divisors()  # sagebrush only
        6
    """
    return _sa().number_of_divisors(n)


def squarefree_part(n):
    """The squarefree part of n: n divided by its largest square factor, with n's sign.

    EXAMPLES::

        sage: ZZ(12).squarefree_part(), ZZ(-50).squarefree_part(), ZZ(7).squarefree_part()
        (3, -2, 7)
    """
    sa = _sa()
    return sa.prod([p for p, e in sa.factor(_b.abs(n)) if e % 2]) * (1 if n > 0 else -1)


def valuation(n, p):
    """The exponent of the highest power of p that divides n (infinity for n = 0).

    EXAMPLES::

        sage: ZZ(48).valuation(2), ZZ(48).valuation(3), ZZ(48).valuation(5)
        (4, 1, 0)
        sage: ZZ(0).valuation(2)
        +Infinity
    """
    sa = _sa()
    return sa.oo if (sa._valuation_base(p) and n == 0) else sa.valuation(n, p)


# ------------------------------------------------------------------ arithmetic functions

def euler_phi(n):
    """Euler's totient: how many of 1, ..., n are coprime to n.  (A Sagebrush
    method: in Sage, call the function, euler_phi(n).)

    EXAMPLES::

        sage: euler_phi(12), euler_phi(13)
        (4, 12)
        sage: ZZ(12).euler_phi()  # sagebrush only
        4
    """
    return _sa().euler_phi(n)


def sigma(n, k=1):
    """The sum of the k-th powers of the positive divisors of n.  (A
    Sagebrush method: in Sage, call the function, sigma(n, k).)

    EXAMPLES::

        sage: sigma(6), sigma(6, 2), sigma(6, 0)
        (12, 50, 4)
        sage: ZZ(6).sigma(2)  # sagebrush only
        50
    """
    return _sa().sigma(n, k)


def moebius(n):
    """The Moebius function: 0 if a square divides n, else (-1)^r for r prime
    factors.  (The method is Sagebrush's: in Sage, call the function,
    moebius(n).)

    EXAMPLES::

        sage: [moebius(k) for k in [1, 2, 4, 6, 30]]
        [1, -1, 0, 1, -1]
        sage: ZZ(30).moebius()  # sagebrush only
        -1
    """
    return _sa().moebius(n)


def kronecker(n, b):
    """The Kronecker symbol (n/b), which extends the Legendre and Jacobi symbols.

    EXAMPLES::

        sage: ZZ(2).kronecker(7), ZZ(3).kronecker(7), ZZ(7).kronecker(7)
        (1, -1, 0)
    """
    return _sa().kronecker_symbol(n, b)


def binomial(n, k):
    """The binomial coefficient n choose k.

    EXAMPLES::

        sage: ZZ(10).binomial(3), ZZ(5).binomial(7)
        (120, 0)
    """
    return _sa().binomial(n, k)


def factorial(n):
    """n! = 1 * 2 * ... * n, for n >= 0.

    EXAMPLES::

        sage: ZZ(5).factorial(), ZZ(0).factorial()
        (120, 1)
    """
    return _sa().factorial(n)


# ------------------------------------------------------------------ gcd and modular arithmetic

def gcd(n, m):
    """The greatest common divisor of n and m.

    EXAMPLES::

        sage: ZZ(12).gcd(18), ZZ(7).gcd(0)
        (6, 7)
    """
    return _sa().gcd(n, m)


def lcm(n, m):
    """The least common multiple of n and m.

    EXAMPLES::

        sage: ZZ(4).lcm(6)
        12
    """
    return _sa().lcm(n, m)


def xgcd(n, m):
    """(g, s, t) with g = gcd(n, m) = s*n + t*m.

    EXAMPLES::

        sage: g, s, t = ZZ(12).xgcd(18); (g, s * 12 + t * 18)
        (6, 6)
        sage: ZZ(240).xgcd(46)
        (2, -9, 47)
    """
    return _sa().xgcd(n, m)


def inverse_mod(n, m):
    """The inverse of n modulo m (an error when gcd(n, m) is not 1).

    EXAMPLES::

        sage: ZZ(3).inverse_mod(7), ZZ(3) * 5 % 7
        (5, 1)
    """
    return _sa().inverse_mod(n, m)


def powermod(n, k, m):
    """n^k modulo m, computed by repeated squaring.

    EXAMPLES::

        sage: ZZ(2).powermod(10, 1000), ZZ(3).powermod(100, 7)
        (24, 4)
    """
    return pow(n, k, m)


def mod(n, m):
    """n modulo m, in 0, ..., m - 1 for m > 0.

    EXAMPLES::

        sage: ZZ(17).mod(5), ZZ(-17).mod(5)
        (2, 3)
    """
    return n % m


def quo_rem(n, m):
    """(q, r) with n = q*m + r, q the floor of n/m.

    EXAMPLES::

        sage: ZZ(17).quo_rem(5), ZZ(-17).quo_rem(5)
        ((3, 2), (-4, 3))
    """
    return (n // m, n % m)


# ------------------------------------------------------------------ roots

def sqrt(n):
    """The square root of n: an integer when n is a perfect square, else exact and symbolic.

    EXAMPLES::

        sage: ZZ(16).sqrt(), ZZ(8).sqrt()
        (4, 2*sqrt(2))
    """
    r = _m.isqrt(n) if n >= 0 else -1
    return r if r * r == n else _sa().sqrt(n)


def isqrt(n):
    """The integer part of the square root of n >= 0.

    EXAMPLES::

        sage: ZZ(17).isqrt(), ZZ(16).isqrt()
        (4, 4)
    """
    return _m.isqrt(n)


def nth_root(n, k, truncate_mode=False):
    """The integer k-th root of n; an error when n is not a k-th power, unless
    truncate_mode, which gives (the root truncated toward zero, whether it
    is exact).

    EXAMPLES::

        sage: ZZ(125).nth_root(3), ZZ(-32).nth_root(5)
        (5, -2)
        sage: ZZ(10).nth_root(3, truncate_mode=True), ZZ(-10).nth_root(3, truncate_mode=True)
        ((2, False), (-2, False))
        sage: ZZ(10).nth_root(3)
        Traceback (most recent call last):
        ...
        ValueError: 10 is not a 3rd power
    """
    # (exact: integer Newton's method, as a float root was wrong past 2^53
    # and overflowed past 2^1024; an even root of a negative number is an
    # error, as in Sage)
    k = int(k)
    if k < 1:
        raise ValueError("k=%d must be positive" % k)
    if n < 0 and k % 2 == 0:
        raise ValueError("cannot take even root of negative number")
    a = _b.abs(int(n))
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


# ------------------------------------------------------------------ digits and bits

def digits(n, base=10):
    """The digits of n in the given base, least significant first.

    EXAMPLES::

        sage: ZZ(1234).digits(), ZZ(10).digits(2)
        ([4, 3, 2, 1], [0, 1, 0, 1])
    """
    return _sa().digits(n, base)


def ndigits(n, base=10):
    """How many digits n has in the given base (0 for n = 0).

    EXAMPLES::

        sage: ZZ(1234).ndigits(), ZZ(255).ndigits(2), ZZ(0).ndigits()
        (4, 8, 0)
    """
    return len(_sa().digits(_b.abs(n), base)) if n else 0


def binary(n):
    """n written in base 2, as a string.

    EXAMPLES::

        sage: ZZ(10).binary(), ZZ(-5).binary()
        ('1010', '-101')
    """
    return bin(n)[2:] if n >= 0 else "-" + bin(n)[3:]


def str(n, base=10):
    """n written in the given base (2 to 36), as a string.

    EXAMPLES::

        sage: ZZ(255).str(16), ZZ(255).str(2), ZZ(-35).str(36)
        ('ff', '11111111', '-z')
    """
    if base == 10:
        return int.__repr__(n)
    digs = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    s, m = "", _b.abs(n)
    while m:
        s = digs[m % base] + s
        m //= base
    return ("-" if n < 0 else "") + s


def nbits(n):
    """How many bits |n| has.

    EXAMPLES::

        sage: ZZ(255).nbits(), ZZ(256).nbits(), ZZ(0).nbits()
        (8, 9, 0)
    """
    return _b.abs(n).bit_length()


def popcount(n):
    """How many 1s n has in base 2.

    EXAMPLES::

        sage: ZZ(255).popcount(), ZZ(10).popcount()
        (8, 2)
    """
    return bin(n).count("1")


# ------------------------------------------------------------------ predicates and the rest

def is_even(n):
    """Whether n is divisible by 2.

    EXAMPLES::

        sage: ZZ(10).is_even(), ZZ(7).is_even()
        (True, False)
    """
    return n % 2 == 0


def is_odd(n):
    """Whether n is not divisible by 2.

    EXAMPLES::

        sage: ZZ(7).is_odd(), ZZ(-3).is_odd(), ZZ(10).is_odd()
        (True, True, False)
    """
    return n % 2 == 1


def is_one(n):
    """Whether n is 1.

    EXAMPLES::

        sage: ZZ(1).is_one(), ZZ(-1).is_one()
        (True, False)
    """
    return n == 1


def is_zero(n):
    """Whether n is 0.

    EXAMPLES::

        sage: ZZ(0).is_zero(), ZZ(3).is_zero()
        (True, False)
    """
    return n == 0


def is_unit(n):
    """Whether n is invertible in ZZ: 1 or -1.

    EXAMPLES::

        sage: ZZ(-1).is_unit(), ZZ(2).is_unit()
        (True, False)
    """
    return n in (1, -1)


def is_integral(n):
    """Whether n is an integer: always True for an element of ZZ.

    EXAMPLES::

        sage: ZZ(7).is_integral()
        True
    """
    return True


def abs(n):
    """The absolute value of n.

    EXAMPLES::

        sage: ZZ(-5).abs(), ZZ(5).abs()
        (5, 5)
    """
    return _b.abs(n)


def floor(n):
    """n itself: an integer is its own floor.

    EXAMPLES::

        sage: ZZ(7).floor(), ZZ(-7).floor()
        (7, -7)
    """
    return n


def ceil(n):
    """n itself: an integer is its own ceiling.

    EXAMPLES::

        sage: ZZ(7).ceil()
        7
    """
    return n


def round(n):
    """n itself: an integer is already rounded.

    EXAMPLES::

        sage: ZZ(7).round()
        7
    """
    return n


def n(n, prec=None, digits=None):
    """n as a real number, with 53 bits, or prec bits, or digits decimal
    digits.  n.n() and n.numerical_approx() are Sage's methods too; n.N() is
    Sagebrush's (in Sage, call the function, N(n), or use n.n()).

    EXAMPLES::

        sage: ZZ(2).n(), ZZ(2).n(digits=5)
        (2.00000000000000, 2.0000)
        sage: ZZ(10).n(prec=10)
        10.
        sage: ZZ(10).N(prec=10)  # sagebrush only
        10.
        sage: ZZ(3).numerical_approx()
        3.00000000000000
    """
    from _sage_lang import _int_n
    return _int_n(n, prec, digits)


N = numerical_approx = n


def parent(n):
    """The ring n belongs to: the integers, ZZ.

    EXAMPLES::

        sage: ZZ(5).parent()
        Integer Ring
        sage: ZZ(5).parent() is ZZ
        True
    """
    return _sa().ZZ


# The methods, by name: _sage_lang installs these (ints in pyjs, the
# Integer class under CPython)
METHODS = {name: globals()[name] for name in (
    "factor", "is_prime", "is_pseudoprime", "is_prime_power", "is_square", "is_squarefree",
    "is_even", "is_odd", "is_one", "is_zero", "is_unit", "is_integral",
    "sqrt", "isqrt", "nth_root", "digits", "ndigits", "divisors", "number_of_divisors",
    "prime_divisors", "prime_factors", "next_prime", "previous_prime", "next_probable_prime",
    "binomial", "factorial", "binary", "str", "nbits", "popcount", "abs",
    "inverse_mod", "powermod", "gcd", "lcm", "xgcd", "mod", "quo_rem", "valuation",
    "euler_phi", "sigma", "moebius", "n", "N", "numerical_approx", "parent",
    "floor", "ceil", "round", "squarefree_part", "kronecker")}
