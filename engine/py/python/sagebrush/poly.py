"""Polynomials over Z (sagebrush.poly): factoring (engine/poly), products,
gcds and exact division (engine/arith), in Rust."""

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
