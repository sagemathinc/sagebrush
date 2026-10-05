"""Polynomials over Z (sagebrush.poly): factoring, in Rust (engine/poly)."""

from ._engine import call


def factor(f):
    """f (coefficients, constant term first) as (content, [(g, e)]): f =
    content * prod g^e, each g irreducible over Q, primitive, with positive
    leading coefficient (constant term first), sorted by degree."""
    r = call("factor", f=[str(int(c)) for c in f])
    return int(r["content"]), [([int(c) for c in g], e) for g, e in r["factors"]]
