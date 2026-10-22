"""One native Sagebrush benchmark case; stdout ends in RESULT|seconds|signature."""
# ruff: noqa: F401,F403,F405

from __future__ import annotations

import sys
import time

import sagebrush.sage  # install the Sage-compatible modules
import _sage_shim

_sage_shim.install()
from sagebrush import ap, mf, modsym  # noqa: E402
from sagebrush.sage import *  # noqa: E402,F401,F403
import sage  # noqa: E402

case_id, n, repeats = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
MOD = 1000000007


def intval(x):
    try:
        return int(x)
    except Exception:
        return int(x.lift())


def numden(x):
    a = x.numerator() if callable(getattr(x, "numerator", None)) else x.numerator
    b = x.denominator() if callable(getattr(x, "denominator", None)) else x.denominator
    return int(a), int(b)


def scalar_hash(x):
    try:
        a, b = numden(x)
        return (a % MOD) * pow(b % MOD, MOD - 2, MOD) % MOD
    except Exception:
        return intval(x) % MOD


def seq_hash(xs):
    h = 17
    for x in xs:
        h = (h * 1000003 + scalar_hash(x)) % MOD
    return h


def matrix_hash(A):
    return seq_hash(A.list())


def coeffs(f):
    return list(f.list())


def det_input(ring, size):
    if ring is QQ:
        return matrix(
            QQ,
            size,
            size,
            lambda i, j: QQ(pow(i + 2, j + 3, 101) - 50) / (1 + (i * j) % 7),
        )
    if ring is ZZ:
        return matrix(ZZ, size, size, lambda i, j: pow(i + 2, j + 3, 1000003) - 500001)
    return matrix(ring, size, size, lambda i, j: pow(i + 2, j + 3, 65537))


def zpoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % 1000003) - 500001 for i in range(size)]


def fppoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % 65537) for i in range(size)]


def cyclic_ideal(size):
    R = PolynomialRing(GF(32003), "x", size, order="degrevlex")
    return sage.rings.ideal.Cyclic(R)


def katsura_ideal(size):
    R = PolynomialRing(GF(32003), "x", size + 1, order="degrevlex")
    return sage.rings.ideal.Katsura(R)


def class_disc(digits):
    # Fixed fundamental discriminants used by the classgroup benchmark family.
    return {
        12: -100000000003,
        24: -1000000000000000000000003,
        40: -10000000000000000000000000000000000000003,
    }[digits]


def prepare():
    if case_id.startswith("poly_z_"):
        R = PolynomialRing(ZZ, "x")
        x = R.gen()
        if case_id == "poly_z_mul":
            a, b = R(zpoly(n, 11)), R(zpoly(n, 17))
            return lambda: a * b
        if case_id == "poly_z_gcd":
            g, a, b = R(zpoly(n // 2, 5)), R(zpoly(n, 11)), R(zpoly(n, 17))
            ga, gb = g * a, g * b
            return lambda: ga.gcd(gb)
        if case_id == "poly_z_factor":
            f = x**n - 1
            return lambda: f.factor()
        f = R(1)
        for i in range(1, n + 1):
            f *= x**2 + (i + 1) * x + (i * i + i + 1)
        return lambda: f.factor()
    if case_id.startswith("poly_fp_"):
        F = GF(65537)
        R = PolynomialRing(F, "x")
        x = R.gen()
        if case_id == "poly_fp_mul":
            a, b = R(fppoly(n, 11)), R(fppoly(n, 17))
            return lambda: a * b
        if case_id == "poly_fp_gcd":
            g, a, b = R(fppoly(n // 2, 5)), R(fppoly(n, 11)), R(fppoly(n, 17))
            ga, gb = g * a, g * b
            return lambda: ga.gcd(gb)
        f = x**n - 1
        return lambda: f.factor()
    if case_id.startswith("mat_"):
        ring = (
            ZZ
            if case_id.startswith("mat_z_")
            else GF(65537)
            if case_id.startswith("mat_fp_")
            else QQ
        )
        A = det_input(ring, n)
        op = case_id.rsplit("_", 1)[1]
        if op == "det":
            return lambda: A.det()
        if op == "rank":
            return lambda: A.rank()
        if op == "charpoly":
            return lambda: A.charpoly()
        if op == "hnf":
            return lambda: A.hermite_form()
        if op == "smith":
            return lambda: A.smith_form()[0]
        if op == "solve":
            b = vector(ring, [i + 1 for i in range(n)])
            return lambda: A.solve_right(b)
    if case_id == "groebner_cyclic":
        proof.polynomial(False)
        ideal = cyclic_ideal(n)
        return lambda: ideal.groebner_basis()
    if case_id == "groebner_katsura":
        proof.polynomial(False)
        ideal = katsura_ideal(n)
        return lambda: ideal.groebner_basis()
    if case_id == "class_group":
        D = class_disc(n)
        K = QuadraticField(D, "a")
        return lambda: K.class_group()
    if case_id == "galois_group":
        R = PolynomialRing(QQ, "x")
        x = R.gen()
        f = x**n - x - 1
        return lambda: f.galois_group()
    if case_id == "modsym_charpoly":
        return lambda: modsym.charpoly_exact(n, 2, threads=1)["charpoly"]
    if case_id == "newforms":
        return lambda: mf.newforms(n, 2, bound=30, threads=1)
    if case_id == "ec_aplist":
        return lambda: ap.aplist([0, 0, 1, -7, 6], n, threads=1)
    raise ValueError(case_id)


def signature(answer):
    if case_id.startswith("poly_") and "factor" in case_id:
        fs = sorted((f.degree(), int(e), seq_hash(coeffs(f))) for f, e in answer)
        flat = [x for item in fs for x in item]
        return "%d:%d" % (len(fs), seq_hash(flat))
    if case_id.startswith("poly_"):
        return "%d:%d" % (answer.degree(), seq_hash(coeffs(answer)))
    if case_id.startswith("mat_"):
        op = case_id.rsplit("_", 1)[1]
        if op in ("det", "rank"):
            return str(answer)
        if op == "charpoly":
            return "%d:%d" % (answer.degree(), seq_hash(coeffs(answer)))
        if op == "smith":
            diagonal = [abs(int(answer[i, i])) for i in range(n)]
            return "%d:%d" % (n, seq_hash(diagonal))
        return "%d:%d" % (
            n,
            matrix_hash(answer if hasattr(answer, "list") else matrix(answer)),
        )
    if case_id.startswith("groebner_"):
        degrees = sorted(f.total_degree() for f in answer)
        return "%d:%d" % (len(answer), seq_hash(degrees))
    if case_id == "class_group":
        inv = sorted(map(int, answer.invariants()))
        return "%d:%s" % (int(answer.order()), ",".join(map(str, inv)))
    if case_id == "galois_group":
        return str(int(answer.order()))
    if case_id == "modsym_charpoly":
        return "%d:%d" % (len(answer) - 1, seq_hash(answer))
    if case_id == "newforms":
        forms = answer["newforms"] if isinstance(answer, dict) else answer
        dims = sorted(int(f["dim"] if "dim" in f else f["dimension"]) for f in forms)
        return "%d:%s" % (len(dims), ",".join(map(str, dims)))
    if case_id == "ec_aplist":
        good = [(p, a) for p, a in answer if a is not None]
        return "%d:%d" % (len(good), seq_hash([p * 1000 + a for p, a in good]))
    raise ValueError(case_id)


operation = prepare()
t0 = time.perf_counter()
for _ in range(repeats):
    answer = operation()
seconds = (time.perf_counter() - t0) / repeats
print("RESULT|%.9f|%s" % (seconds, signature(answer)))
