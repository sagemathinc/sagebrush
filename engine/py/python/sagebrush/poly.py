"""Polynomials over Z (sagebrush.poly): factoring (engine/poly), products,
gcds and exact division (engine/arith), in Rust; and truncated power series
over Z and Q, the Euler product and sigma_k (engine/arith's zseries).

A series is its coefficients mod q^n, constant term first; over Q, integer
numerators a and a positive denominator da (the series a / da).  The
results are reduced as Sage shows them: a list of ints, or of Fractions in
lowest terms, trailing zeros dropped.  raw=True gives the engine's
unreduced (numerators, denominator) instead, for a caller that reduces once
at the end.  Inputs and outputs travel in hex, which both sides convert in
linear time.
"""

from fractions import Fraction as _Fraction

from ._engine import call


def factor(f):
    """f (coefficients, constant term first) as (content, [(g, e)]): f =
    content * prod g^e, each g irreducible over Q, primitive, with positive
    leading coefficient (constant term first), sorted by degree."""
    r = call("factor", f=[str(int(c)) for c in f])
    return int(r["content"]), [([int(c) for c in g], e) for g, e in r["factors"]]



def _enc(f):
    return ",".join(map(str, f))


def _dec(s):
    return list(map(int, s.split(","))) if s else []


def mul(a, b):
    """The product of integer polynomials (constant term first)."""
    return _dec(call("poly_mul", a=_enc(a), b=_enc(b), wire="csv"))


def gcd(a, b):
    """The gcd in Z[x] of integer polynomials, with positive leading
    coefficient (constant term first; [] if both are zero)."""
    return _dec(call("poly_gcd", a=_enc(a), b=_enc(b), wire="csv"))


def divexact(a, b):
    """a / b if b divides a in Z[x], else None."""
    r = call("poly_divexact", a=_enc(a), b=_enc(b), wire="csv")
    return None if r is None else _dec(r)


def _hex(f):
    return ",".join([format(int(c), "x") for c in f])


def _ints(s):
    return [int(t, 16) for t in s.split(",")] if s else []


# (a reduced token "n/d" is already in lowest terms: no second gcd where
# the interpreter has the coprime constructor)
_coprime = getattr(_Fraction, "_from_coprime_ints", None)


def _token(t):
    n, _, d = t.partition("/")
    if not d:
        return int(n, 16)
    return _coprime(int(n, 16), int(d, 16)) if _coprime else _Fraction(int(n, 16), int(d, 16))


def _series(r, raw):
    c, d = r["c"], r.get("d")
    if d is not None:
        num, den = _ints(c), int(d, 16)
        if raw:
            return num, den
        # (a reduced request's "d" is 1: over Z the integers themselves;
        # the engine reduces over Q, so there is no second pass here)
        if den != 1:
            raise RuntimeError("series: an unreduced reply to a reduced request")
        return num
    if raw:
        raise RuntimeError("series: a reduced reply to a raw request")
    return [_token(t) for t in c.split(",")] if c else []


def series_mul(a, b, n, da=1, db=1, raw=False):
    """(a / da)(b / db) mod q^n, a and b integer coefficients (constant term
    first), da and db positive integers: a list of ints or Fractions in
    lowest terms (trailing zeros dropped), or with raw=True the unreduced
    (numerators, denominator).  The values are Sage's (truncated power series
    over QQ):

    >>> from sagebrush.poly import series_mul
    >>> series_mul([1, 1], [1, -1], 4)
    [1, 0, -1]
    >>> series_mul([1, 1], [1, 2], 3, da=2, db=3)
    [Fraction(1, 6), Fraction(1, 2), Fraction(1, 3)]
    >>> series_mul([1, 1], [1, 2], 3, da=2, db=3, raw=True)
    ([1, 3, 2], 6)
    """
    args = dict(a=_hex(a[:n]), b=_hex(b[:n]), n=int(n))
    if da != 1:
        args["da"] = format(int(da), "x")
    if db != 1:
        args["db"] = format(int(db), "x")
    if raw:
        args["raw"] = True
    return _series(call("series_mul", **args), raw)


def series_pow(a, k, n, da=1, raw=False):
    """(a / da)^k mod q^n, k >= 0 (k = 0 gives 1, as Sage's f^0, also for
    the zero series): as series_mul.

    >>> from sagebrush.poly import series_pow
    >>> series_pow([1, 1], 3, 3, da=2)
    [Fraction(1, 8), Fraction(3, 8), Fraction(3, 8)]
    >>> series_pow([0, 1], 0, 3)
    [1]
    """
    args = dict(a=_hex(a[:n]), k=int(k), n=int(n))
    if da != 1:
        args["da"] = format(int(da), "x")
    if raw:
        args["raw"] = True
    return _series(call("series_pow", **args), raw)


def series_euler(n):
    """prod_{m >= 1} (1 - q^m) mod q^n: its coefficients (1, -1, -1, 0, 0,
    1, 0, 1, ...: Euler's pentagonal number theorem), trailing zeros
    dropped.

    >>> from sagebrush.poly import series_euler
    >>> series_euler(8)
    [1, -1, -1, 0, 0, 1, 0, 1]
    """
    s = call("series_euler", n=int(n))
    return [int(t) for t in s.split(",")] if s else []


def sigma_table(k, n):
    """[sigma_k(1), ..., sigma_k(n)], sigma_k(m) the sum of d^k over the
    divisors d of m.

    >>> from sagebrush.poly import sigma_table
    >>> sigma_table(1, 6)
    [1, 3, 4, 7, 6, 12]
    """
    return _ints(call("sigma_table", k=int(k), n=int(n)))
