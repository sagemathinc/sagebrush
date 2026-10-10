"""Number fields, integers and integer matrices (sagebrush.nf): the Rust
engine engine/classgroup, clean-room and MIT/Apache-licensed.

Polynomials are integer coefficient lists, constant term first; a number
field is Q[x]/(f) for f monic irreducible.  Results assume GRH where noted.

    from sagebrush import nf
    nf.factor_integer(2**64 + 1)          # [(274177, 1), (67280421310721, 1)]
    nf.nf_data([-11, 0, 0, 1])["disc"]    # -3267
    nf.primes_above([-11, 0, 0, 1], 5)    # [(5, e=1, f=1, pi), ...]
    nf.bnf([-11, 0, 0, 1])                # class group [2], regulator, w (GRH)
    nf.quadratic_class_group(-23)         # (3, [3], None)
    nf.lll([[1, 2, 3], [4, 5, 6], [7, 8, 10]])
"""

from ._engine import call


def _ints(f):
    return [str(int(c)) for c in f]


def _mat(m):
    return [[str(int(x)) for x in row] for row in m]


def factor_integer(n):
    """The factorization of n != 0 as [(p, e)], primes ascending (probable
    primes beyond 3.3e24).  A composite is never reported as a prime: one
    that cannot be split (beyond 1024 bits) raises ValueError."""
    return [(int(p), e) for p, e in call("factor_integer", n=str(int(n)))]


def is_prime(n):
    """Whether n is prime (Miller-Rabin; deterministic below 3.3e24); False
    for n < 2."""
    return call("is_prime", n=str(int(n)))


def nf_data(f):
    """The maximal order of Q[x]/(f): dict with degree, r1, r2, disc,
    index [O_K : Z[x]], basis (rows over the power basis) and den (the
    basis is rows/den), w (the number of roots of unity) and w_proven
    (whether w is proven, else a lower bound)."""
    r = call("nf_data", f=_ints(f))
    r["disc"] = int(r["disc"])
    r["index"] = int(r["index"])
    r["den"] = int(r["den"])
    r["basis"] = [[int(c) for c in row] for row in r["basis"]]
    return r


def primes_above(f, p):
    """The prime ideals above p as dicts (p, e, f, pi, pi_den): P = (p, pi),
    pi = (pi numerators over the power basis) / pi_den."""
    out = []
    for q in call("primes_above", f=_ints(f), p=int(p)):
        q["pi"] = [int(c) for c in q["pi"]]
        q["pi_den"] = int(q["pi_den"])
        out.append(q)
    return out


def bnf(f):
    """Class group and regulator of Q[x]/(f), assuming GRH: dict with h,
    cyc (invariants, largest first), regulator (a decimal string, its
    digits correct), w, r1, r2, disc, certified and assumes (what the
    result depends on: ["GRH"] when certified, i.e. h* R* is below twice a
    proven lower bound for h R (Belabas and Friedman); otherwise also the
    uncertified estimate)."""
    r = call("bnf", f=_ints(f))
    r["h"] = int(r["h"])
    r["disc"] = int(r["disc"])
    r["cyc"] = [int(c) for c in r["cyc"]]
    return r


def quadratic_class_group(d):
    """(h, cyc, regulator) for the quadratic field of fundamental
    discriminant d (regulator a decimal string for d > 0, else None);
    assumes GRH.  quadratic_class_group_data(d) also says whether the
    result is certified (see bnf)."""
    r = call("quadratic_class_group", d=str(int(d)))
    return int(r["h"]), [int(c) for c in r["cyc"]], r["regulator"]


def quadratic_class_group_data(d):
    """quadratic_class_group as a dict: h, cyc, regulator, certified and
    assumes."""
    r = call("quadratic_class_group", d=str(int(d)))
    r["h"] = int(r["h"])
    r["cyc"] = [int(c) for c in r["cyc"]]
    return r


def hermite_form(m):
    """The Hermite normal form of an integer matrix (rows; zero rows dropped)."""
    return [[int(x) for x in row] for row in call("hermite_form", m=_mat(m))]


def elementary_divisors(m):
    """The elementary divisors of an integer matrix: min(rows, cols) numbers
    d_1 | d_2 | ..., zeros last."""
    return [int(x) for x in call("elementary_divisors", m=_mat(m))]


def lll(m):
    """An LLL-reduced basis (delta 0.99) of the lattice spanned by the rows;
    zero rows first for dependent rows."""
    return [[int(x) for x in row] for row in call("lll", m=_mat(m))]


def complex_roots(f, digits=15):
    """The complex roots of f with multiplicities: [(re, im, m)] as decimal
    strings, real roots first."""
    return [(re, im, m) for re, im, m in call("complex_roots", f=_ints(f), digits=int(digits))]


def factor_mod(f, p):
    """The factorization of f modulo a prime p < 2^32: [(g, e)], g monic
    (coefficients constant term first)."""
    return [(g, e) for g, e in call("factor_mod", f=_ints(f), p=int(p))]
