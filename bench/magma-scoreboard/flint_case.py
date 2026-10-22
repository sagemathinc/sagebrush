"""One FLINT 3.6 benchmark case; input setup is outside the timed region."""

from __future__ import annotations

from fractions import Fraction
import sys
import time

import flint


case_id, n, repeats = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
MOD = 1000000007
P = 65537
flint.ctx.threads = 1


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


def zpoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % 1000003) - 500001 for i in range(size)]


def fppoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % P) for i in range(size)]


def det_rows(kind, size):
    if kind == "q":
        return [
            [
                flint.fmpq(pow(i + 2, j + 3, 101) - 50, 1 + (i * j) % 7)
                for j in range(size)
            ]
            for i in range(size)
        ]
    modulus = 1000003 if kind == "z" else P
    offset = 500001 if kind == "z" else 0
    return [
        [pow(i + 2, j + 3, modulus) - offset for j in range(size)] for i in range(size)
    ]


def zfactor_product(size):
    x = flint.fmpz_poly([0, 1])
    f = flint.fmpz_poly([1])
    for i in range(1, size + 1):
        f *= x * x + (i + 1) * x + (i * i + i + 1)
    return f


def prepare():
    if case_id.startswith("bigint_"):
        a = flint.fmpz((1 << n) - (1 << (n // 3)) + 123456789)
        b = flint.fmpz((1 << (n - 1)) + (1 << (n // 2)) + 987654321)
        if case_id == "bigint_mul":
            return lambda: a * b
        return lambda: (a * 1000003).gcd(b * 1000003)
    if case_id.startswith("poly_z_"):
        if case_id == "poly_z_mul":
            a, b = flint.fmpz_poly(zpoly(n, 11)), flint.fmpz_poly(zpoly(n, 17))
            return lambda: a * b
        if case_id == "poly_z_gcd":
            g = flint.fmpz_poly(zpoly(n // 2, 5))
            a, b = g * flint.fmpz_poly(zpoly(n, 11)), g * flint.fmpz_poly(zpoly(n, 17))
            return lambda: a.gcd(b)
        if case_id == "poly_z_factor":
            f = flint.fmpz_poly([-1] + [0] * (n - 1) + [1])
        else:
            f = zfactor_product(n)
        return lambda: f.factor()
    if case_id.startswith("poly_fp_"):
        if case_id == "poly_fp_mul":
            a, b = flint.nmod_poly(fppoly(n, 11), P), flint.nmod_poly(fppoly(n, 17), P)
            return lambda: a * b
        if case_id == "poly_fp_gcd":
            g = flint.nmod_poly(fppoly(n // 2, 5), P)
            a, b = (
                g * flint.nmod_poly(fppoly(n, 11), P),
                g * flint.nmod_poly(fppoly(n, 17), P),
            )
            return lambda: a.gcd(b)
        f = flint.nmod_poly([-1] + [0] * (n - 1) + [1], P)
        return lambda: f.factor()
    if case_id.startswith("mat_"):
        kind = (
            "z"
            if case_id.startswith("mat_z_")
            else "fp"
            if case_id.startswith("mat_fp_")
            else "q"
        )
        rows = det_rows(kind, n)
        A = (
            flint.fmpz_mat(rows)
            if kind == "z"
            else flint.nmod_mat(rows, P)
            if kind == "fp"
            else flint.fmpq_mat(rows)
        )
        op = case_id.rsplit("_", 1)[1]
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
        op = case_id.rsplit("_", 1)[1]
        if op in ("det", "rank"):
            return str(answer)
        if op == "charpoly":
            cs = list(answer)
            return "%d:%d" % (len(cs) - 1, seq_hash(cs))
        if op == "smith":
            return "%d:%d" % (n, seq_hash(abs(int(answer[i, i])) for i in range(n)))
        return "%d:%d" % (n, seq_hash(flatten(answer)))
    raise ValueError(case_id)


operation = prepare()
t0 = time.perf_counter()
for _ in range(repeats):
    answer = operation()
seconds = (time.perf_counter() - t0) / repeats
print("RESULT|%.9f|%s" % (seconds, signature(answer)))
