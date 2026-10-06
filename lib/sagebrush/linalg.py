"""Exact linear algebra over ZZ and QQ (sagebrush.linalg): the Rust engine
engine/arith, clean-room and MIT/Apache-licensed, multimodular and p-adic
with every answer certified.

Matrices are lists of rows; entries are ints or rationals (Fraction or
anything Fraction accepts).  Rational answers come back as Fractions,
integral ones as ints.

    from sagebrush import linalg
    linalg.det([[1, 2], [3, 4]])                    # -2
    linalg.rref([[1, 2, 3], [2, 4, 7]])             # ([[1, 2, 0], [0, 0, 1]], [0, 2])
    linalg.solve([[2, 1], [1, 3]], [[1], [2]])      # [[Fraction(1, 5)], [Fraction(3, 5)]]
    linalg.charpoly([[0, 1], [-1, 0]])              # [1, 0, 1]  (x^2 + 1)
    linalg.kernel([[1, 2, 3], [4, 5, 6]])           # [[1, -2, 1]]
"""

from fractions import Fraction as _F
from math import lcm as _lcm

from ._engine import call


def _num(x):
    return x if isinstance(x, int) else _F(x)


def _out(n, d=1):
    """n/d as an int when integral, else a Fraction."""
    n, d = int(n), int(d)
    if n % d == 0:
        return n // d
    return _F(n, d)


def _enc(rows):
    """Integer rows in the engine's compact wire format "a,b;c,d"."""
    return ";".join(",".join(map(str, r)) for r in rows)


def _dec(s):
    return [list(map(int, r.split(","))) if r else [] for r in s.split(";")] if s else []


def _scaled_rows(m):
    """(integer rows "a,b;c,d", row multipliers): row i of m times d[i] is
    integral."""
    if all(isinstance(x, int) for r in m for x in r):
        return _enc(m), [1] * len(m)
    rows, ds = [], []
    for r in m:
        r = [x if isinstance(x, int) or hasattr(x, "denominator") else _F(x) for x in r]
        d = 1
        for x in r:
            if not isinstance(x, int):
                d = _lcm(d, int(x.denominator))
        rows.append([x * d if isinstance(x, int) else int(x.numerator) * (d // int(x.denominator)) for x in r])
        ds.append(d)
    return _enc(rows), ds


def _check(m):
    m = [list(r) for r in m]
    if m and any(len(r) != len(m[0]) for r in m):
        raise ValueError("matrix rows of different lengths")
    return m


def det(m):
    """The determinant of a square matrix."""
    m = _check(m)
    if any(len(r) != len(m) for r in m):
        raise ValueError("self must be a square matrix")
    if not m:
        return 1
    rows, ds = _scaled_rows(m)
    d = 1
    for x in ds:
        d *= x
    return _out(call("mat_det", m=rows), d)


def rank(m):
    m = _check(m)
    if not m or not m[0]:
        return 0
    return call("mat_rank", m=_scaled_rows(m)[0])


def rref(m):
    """(R, pivots): the reduced row echelon form over QQ (all rows,
    zero rows last) and the pivot columns."""
    m = _check(m)
    if not m or not m[0]:
        return [list(r) for r in m], []
    ncols = len(m[0])
    r = call("mat_rref", m=_scaled_rows(m)[0], wire="csv")
    den = int(r["den"])
    out = [[_out(x, den) for x in row] for row in _dec(r["rows"])]
    out += [[0] * ncols for _ in range(len(m) - len(out))]
    return out, list(r["pivots"])


def solve(a, b):
    """X with a X = b, for a square nonsingular (b a matrix: list of rows);
    raises ZeroDivisionError if a is singular."""
    a, b = _check(a), _check(b)
    if len(a) != len(b):
        raise ValueError("number of rows of a and b differ")
    # scale row i of [a | b] by one integer
    n = len(a)
    if n == 0:
        return []
    rows = _dec(_scaled_rows([list(ra) + list(rb) for ra, rb in zip(a, b)])[0])
    r = call("mat_solve", a=_enc(row[:n] for row in rows), b=_enc(row[n:] for row in rows), wire="csv")
    if r is None:
        raise ZeroDivisionError("input matrix must be nonsingular")
    den = int(r["den"])
    return [[_out(x, den) for x in row] for row in _dec(r["rows"])]


def inverse(m):
    """The inverse of a square matrix; ZeroDivisionError if singular."""
    m = _check(m)
    if any(len(r) != len(m) for r in m):
        raise ArithmeticError("self must be a square matrix")
    if not m:
        return []
    rows, ds = _scaled_rows(m)
    r = call("mat_inverse", m=rows, wire="csv")
    if r is None:
        raise ZeroDivisionError("input matrix must be nonsingular")
    den = int(r["den"])
    # m = D^-1 M with D = diag(ds): m^-1 = M^-1 D
    return [[_out(x * ds[j], den) for j, x in enumerate(row)] for row in _dec(r["rows"])]


def charpoly(m):
    """The coefficients of det(x I - m), constant term first."""
    m = _check(m)
    n = len(m)
    if any(len(r) != n for r in m):
        raise ValueError("matrix must be square")
    if n == 0:
        return [1]
    d = 1
    for r in m:
        for x in r:
            x = _num(x)
            if not isinstance(x, int):
                d = _lcm(d, x.denominator)
    rows = _enc([int(_num(x) * d) for x in r] for r in m)
    c = list(map(int, call("mat_charpoly", m=rows, wire="csv").split(",")))
    # charpoly(M / d)(x) = d^-n charpoly(M)(d x): c_k / d^(n - k)
    return [_out(c[k], d ** (n - k)) for k in range(n + 1)]


def kernel(m):
    """A basis of the right kernel {x : m x = 0} over QQ, as integer
    vectors (one per non-pivot column)."""
    m = _check(m)
    if not m or not m[0]:
        n = len(m[0]) if m else 0
        return [[int(i == j) for j in range(n)] for i in range(n)]
    return _dec(call("mat_kernel", m=_scaled_rows(m)[0], wire="csv"))


def matmul(a, b):
    """The product of integer matrices."""
    a, b = _check(a), _check(b)
    return _dec(call("mat_mul", a=_enc(a), b=_enc(b), wire="csv"))
