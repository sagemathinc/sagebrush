"""One FLINT 3.6 case through python-flint (a black-box oracle); the protocol
is common.py's."""

from __future__ import annotations

from fractions import Fraction
import os
import sys

import flint

import common


case_id, n = sys.argv[1], int(sys.argv[2])
MOD = common.MOD
OPERANDS = []
P = 65537
# (1, or N for the flint-n backend: run.py sets BENCH_THREADS)
flint.ctx.threads = int(os.environ.get("BENCH_THREADS", "1"))


def scalar_hash(x):
    if isinstance(x, Fraction):
        a, b = x.numerator, x.denominator
    elif isinstance(x, flint.fmpq):
        a, b = int(x.numerator), int(x.denominator)
    else:
        return int(x) % MOD
    return (a % MOD) * pow(b % MOD, MOD - 2, MOD) % MOD


def seq_hash(xs):
    h = 17
    for x in xs:
        h = (h * 1000003 + scalar_hash(x)) % MOD
    return h


def flatten(A):
    return [x for row in A.tolist() for x in row]


# The rank rows beyond the square ones (expected_inputs.py's formulas, which
# also certify the ranks): wide R(n x 2n); def R(n x n//2) R(n//2 x n); def_p
# R(n x n) diag(1, ..., 1, p) R(n x n), p = 2^62 - 57.  Over Q, row i is
# divided by 1 + i mod 7.
RANK_P = (1 << 62) - 57
RANK_RANGE = {"z": (1000003, 500001), "q": (101, 50)}


def rank_rnd(rows, cols, s, kind):
    m, off = RANK_RANGE[kind]
    return [
        [pow(131 * i + 31 * j + s, 5, m) - off for j in range(cols)]
        for i in range(rows)
    ]


def rank_factors(shape, kind, size, v):
    """(B, C), integer rows, with the row's matrix the product B C."""
    s1, s2 = 10 * v + 1, 10 * v + 2
    if shape == "wide":
        return rank_rnd(size, 2 * size, s1, kind), None
    if shape == "def":
        r = size // 2
        return rank_rnd(size, r, s1, kind), rank_rnd(r, size, s2, kind)
    c = rank_rnd(size, size, s2, kind)
    c[-1] = [RANK_P * x for x in c[-1]]
    return rank_rnd(size, size, s1, kind), c


def rank_input(case, size, v):
    """A wide, def or def_p rank row's matrix (fmpz_mat, or fmpq_mat with
    row i over 1 + i mod 7)."""
    kind, shape = case.split("_")[1], case.split("_rank_")[1]
    b, c = rank_factors(shape, kind, size, v)
    A = flint.fmpz_mat(b) if c is None else flint.fmpz_mat(b) * flint.fmpz_mat(c)
    if kind == "z":
        return A
    return flint.fmpq_mat(
        [
            [flint.fmpq(int(x), 1 + i % 7) for x in row]
            for i, row in enumerate(A.tolist())
        ]
    )


def zpoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % 1000003) - 500001 for i in range(size)]


def fppoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % P) for i in range(size)]


def det_rows(kind, size, v=0):
    if kind == "q":
        return [
            [
                flint.fmpq(pow(i + 2 + v, j + 3, 101) - 50, 1 + (i * j) % 7)
                for j in range(size)
            ]
            for i in range(size)
        ]
    modulus = 1000003 if kind == "z" else P
    offset = 500001 if kind == "z" else 0
    return [
        [pow(i + 2 + v, j + 3, modulus) - offset for j in range(size)]
        for i in range(size)
    ]


def zfactor_product(size, v=0):
    x = flint.fmpz_poly([0, 1])
    f = flint.fmpz_poly([1])
    for i in range(1, size + 1):
        f *= x * x + (i + 1) * x + (i * i + i + 1 + v)
    return f


def operands(*parts):
    OPERANDS.clear()
    for part in parts:
        OPERANDS.extend(scalar_hash(x) for x in part)


def prepare(v):
    """Variant v (sagebrush_case.prepare's variants)."""
    if case_id.startswith("bigint_"):
        a = flint.fmpz((1 << n) - (1 << (n // 3)) + 123456789 + v * 1000003)
        b = flint.fmpz((1 << (n - 1)) + (1 << (n // 2)) + 987654321 + v * 998244353)
        operands([a, b])
        if case_id == "bigint_mul":
            return lambda: a * b
        return lambda: (a * 1000003).gcd(b * 1000003)
    if case_id.startswith("poly_z_"):
        if case_id == "poly_z_mul":
            a, b = (
                flint.fmpz_poly(zpoly(n, 11 + 6 * v)),
                flint.fmpz_poly(zpoly(n, 17 + 6 * v)),
            )
            operands(list(a), list(b))
            return lambda: a * b
        if case_id == "poly_z_gcd":
            g = flint.fmpz_poly(zpoly(n // 2, 5 + 6 * v))
            a, b = (
                g * flint.fmpz_poly(zpoly(n, 11 + 6 * v)),
                g * flint.fmpz_poly(zpoly(n, 17 + 6 * v)),
            )
            operands(list(a), list(b))
            return lambda: a.gcd(b)
        if case_id == "poly_z_factor":
            f = flint.fmpz_poly([-1] + [0] * (n - 1) + [1])
        else:
            f = zfactor_product(n, v)
        operands(list(f))
        return lambda: f.factor()
    if case_id.startswith("poly_fp_"):
        if case_id == "poly_fp_mul":
            a, b = (
                flint.nmod_poly(fppoly(n, 11 + 6 * v), P),
                flint.nmod_poly(fppoly(n, 17 + 6 * v), P),
            )
            operands([int(c) for c in a], [int(c) for c in b])
            return lambda: a * b
        if case_id == "poly_fp_gcd":
            g = flint.nmod_poly(fppoly(n // 2, 5 + 6 * v), P)
            a, b = (
                g * flint.nmod_poly(fppoly(n, 11 + 6 * v), P),
                g * flint.nmod_poly(fppoly(n, 17 + 6 * v), P),
            )
            operands([int(c) for c in a], [int(c) for c in b])
            return lambda: a.gcd(b)
        f = flint.nmod_poly([-1] + [0] * (n - 1) + [1], P)
        operands([int(c) for c in f])
        return lambda: f.factor()
    if case_id.startswith("mat_") and "_rank_" in case_id:
        A = rank_input(case_id, n, v)
        operands(flatten(A))
        return lambda: A.rank()
    if case_id.startswith("mat_"):
        kind = (
            "z"
            if case_id.startswith("mat_z_")
            else "fp"
            if case_id.startswith("mat_fp_")
            else "q"
        )
        rows = det_rows(kind, n, v)
        A = (
            flint.fmpz_mat(rows)
            if kind == "z"
            else flint.nmod_mat(rows, P)
            if kind == "fp"
            else flint.fmpq_mat(rows)
        )
        op = case_id.rsplit("_", 1)[1]
        entries = [int(x) if kind == "fp" else x for x in flatten(A)]
        operands(entries)
        if op == "det":
            return lambda: A.det()
        if op == "rank":
            return lambda: A.rank()
        if op == "charpoly":
            return lambda: A.charpoly()
        if op == "hnf":
            return lambda: A.hnf()
        if op == "smith":
            return lambda: A.snf()
        b_rows = [[i + 1] for i in range(n)]
        b = flint.nmod_mat(b_rows, P) if kind == "fp" else flint.fmpq_mat(b_rows)
        operands(entries, [i + 1 for i in range(n)])
        return lambda: A.solve(b)
    raise ValueError("FLINT operation unavailable: " + case_id)


def factor_signature(answer):
    _, factors = answer
    items = sorted((len(f) - 1, int(e), seq_hash(list(f))) for f, e in factors)
    return "%d:%d" % (len(items), seq_hash([x for item in items for x in item]))


def signature(answer):
    if case_id.startswith("bigint_"):
        value = int(answer)
        return "%d:%d" % (value.bit_length(), value % MOD)
    if case_id.startswith("poly_") and "factor" in case_id:
        return factor_signature(answer)
    if case_id.startswith("poly_"):
        cs = list(answer)
        return "%d:%d" % (len(cs) - 1, seq_hash(cs))
    if case_id.startswith("mat_"):
        op = "rank" if "_rank_" in case_id else case_id.rsplit("_", 1)[1]
        if op in ("det", "rank"):
            return str(answer)
        if op == "charpoly":
            cs = list(answer)
            return "%d:%d" % (len(cs) - 1, seq_hash(cs))
        if op == "smith":
            return "%d:%d" % (n, seq_hash(abs(int(answer[i, i])) for i in range(n)))
        return "%d:%d" % (n, seq_hash(flatten(answer)))
    raise ValueError(case_id)


common.main(sys.argv, prepare, signature, lambda: common.ihash(OPERANDS))
