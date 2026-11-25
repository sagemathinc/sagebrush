"""One Sagebrush case through the user-facing Sage mode (engine/.venv's
native bindings); the protocol is common.py's."""
# ruff: noqa: F401,F403,F405

from __future__ import annotations

import sys

import common

import sagebrush.sage  # install the Sage-compatible modules
import _sage_shim

_sage_shim.install()
from sagebrush import ap, mf, modsym  # noqa: E402
from sagebrush.sage import *  # noqa: E402,F401,F403
import sage  # noqa: E402

case_id, n = sys.argv[1], int(sys.argv[2])
MOD = common.MOD
# The operands' integers (residues of rationals), set by prepare()
OPERANDS = []


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


def det_input(ring, size, v=0):
    """Variant v: entry (i, j) from the node i + 2 + v."""
    if ring is QQ:
        return matrix(
            QQ,
            size,
            size,
            lambda i, j: QQ(pow(i + 2 + v, j + 3, 101) - 50) / (1 + (i * j) % 7),
        )
    if ring is ZZ:
        return matrix(
            ZZ, size, size, lambda i, j: pow(i + 2 + v, j + 3, 1000003) - 500001
        )
    p = int(ring.characteristic())
    return matrix(ring, size, size, lambda i, j: pow(i + 2 + v, j + 3, p))


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
    """A wide, def or def_p rank row's matrix (ZZ, or QQ with row i over
    1 + i mod 7)."""
    kind, shape = case.split("_")[1], case.split("_rank_")[1]
    b, c = rank_factors(shape, kind, size, v)
    A = matrix(ZZ, b) if c is None else matrix(ZZ, b) * matrix(ZZ, c)
    if kind == "z":
        return A
    return matrix(
        QQ, [[QQ(x) / (1 + i % 7) for x in row] for i, row in enumerate(A.rows())]
    )


def zpoly(size, salt):
    return [((i * i * salt + 3 * i + 1) % 1000003) - 500001 for i in range(size)]


def dense_poly(size, kind, v):
    """The dense factoring rows' input: a monic polynomial of degree size,
    its coefficients from a 64-bit LCG (not a polynomial in i, whose
    generating function would be structured), residues mod 65537 (kind
    "fp") or integers in [-1000, 1000] (kind "z"); the same in every
    driver."""
    s = 1000003 * (1 if kind == "fp" else 2) + 7919 * v + 12345
    out = []
    for _ in range(size):
        s = (6364136223846793005 * s + 1442695040888963407) % (1 << 64)
        r = s >> 33
        out.append(r % 65537 if kind == "fp" else r % 2001 - 1000)
    return out + [1]


SMITH_P = 1000003


def smith_hard_rows(size, v):
    """The hard Smith family: U diag(1, p, ..., p) V with p = 1000003, U and
    V unimodular (unit lower times unit upper triangular, off-diagonal
    entries in [-2^16, 2^16] from a 64-bit LCG), so its Smith form is known
    and its divisors are large.  The same in every driver."""
    state = [987654321 + 7919 * v]

    def rnd():
        state[0] = (6364136223846793005 * state[0] + 1442695040888963407) % (1 << 64)
        return (state[0] >> 33) % 131073 - 65536

    def unimodular():
        lo = [
            [1 if i == j else (rnd() if j < i else 0) for j in range(size)]
            for i in range(size)
        ]
        up = [[1 if i == j else 0 for j in range(size)] for i in range(size)]
        for i in range(size):
            for j in range(i + 1, size):
                up[i][j] = rnd()
        return [
            [
                sum(lo[i][k] * up[k][j] for k in range(min(i, j) + 1))
                for j in range(size)
            ]
            for i in range(size)
        ]

    u, w = unimodular(), unimodular()
    ud = [
        [u[i][j] * (1 if j == 0 else SMITH_P) for j in range(size)] for i in range(size)
    ]
    return [
        [sum(ud[i][k] * w[k][j] for k in range(size)) for j in range(size)]
        for i in range(size)
    ]


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


def operands(*parts):
    OPERANDS.clear()
    for part in parts:
        OPERANDS.extend(scalar_hash(x) for x in part)


def ideal_shape(ideal):
    """An ideal's generators as a sorted list of (total degree, number of
    terms) pairs, flattened."""
    gens = ideal.gens()
    return [
        x
        for pair in sorted((int(f.total_degree()), len(f.monomials())) for f in gens)
        for x in pair
    ]


def prepare(v):
    """Variant v of the row's input: salts + 6 v, matrix nodes + v, the
    factor product's constant terms + v (rows with one input: v = 0)."""
    if case_id.startswith("poly_z_"):
        R = PolynomialRing(ZZ, "x")
        x = R.gen()
        if case_id == "poly_z_mul":
            a, b = R(zpoly(n, 11 + 6 * v)), R(zpoly(n, 17 + 6 * v))
            operands(coeffs(a), coeffs(b))
            return lambda: a * b
        if case_id == "poly_z_gcd":
            g, a, b = (
                R(zpoly(n // 2, 5 + 6 * v)),
                R(zpoly(n, 11 + 6 * v)),
                R(zpoly(n, 17 + 6 * v)),
            )
            ga, gb = g * a, g * b
            operands(coeffs(ga), coeffs(gb))
            return lambda: ga.gcd(gb)
        if case_id == "poly_z_factor":
            f = x**n - 1
            operands(coeffs(f))
            return lambda: f.factor()
        if case_id == "poly_z_factor_dense":
            f = R(dense_poly(n, "z", v))
            operands(coeffs(f))
            return lambda: f.factor()
        f = R(1)
        for i in range(1, n + 1):
            f *= x**2 + (i + 1) * x + (i * i + i + 1 + v)
        operands(coeffs(f))
        return lambda: f.factor()
    if case_id.startswith("poly_fp_"):
        F = GF(65537)
        R = PolynomialRing(F, "x")
        x = R.gen()
        if case_id == "poly_fp_mul":
            a, b = R(fppoly(n, 11 + 6 * v)), R(fppoly(n, 17 + 6 * v))
            operands(coeffs(a), coeffs(b))
            return lambda: a * b
        if case_id == "poly_fp_gcd":
            g, a, b = (
                R(fppoly(n // 2, 5 + 6 * v)),
                R(fppoly(n, 11 + 6 * v)),
                R(fppoly(n, 17 + 6 * v)),
            )
            ga, gb = g * a, g * b
            operands(coeffs(ga), coeffs(gb))
            return lambda: ga.gcd(gb)
        f = R(dense_poly(n, "fp", v)) if case_id == "poly_fp_factor_dense" else x**n - 1
        operands(coeffs(f))
        return lambda: f.factor()
    if case_id.startswith("mat_") and "_rank_" in case_id:
        A = rank_input(case_id, n, v)
        operands(A.list())
        return lambda: A.rank()
    if case_id.startswith("mat_"):
        ring = (
            ZZ
            if case_id.startswith("mat_z_")
            else GF(2147483647)
            if case_id.startswith("mat_fp31_")
            else GF(65537)
            if case_id.startswith("mat_fp_")
            else QQ
        )
        hard = case_id.endswith("_hard")
        A = matrix(ZZ, smith_hard_rows(n, v)) if hard else det_input(ring, n, v)
        op = case_id.removesuffix("_hard").rsplit("_", 1)[1]
        operands(A.list())
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
        if op == "divisors":
            return lambda: A.elementary_divisors()
        if op == "solve":
            b = vector(ring, [i + 1 for i in range(n)])
            operands(A.list(), list(b))
            return lambda: A.solve_right(b)
    if case_id == "groebner_cyclic":
        proof.polynomial(False)
        ideal = cyclic_ideal(n)
        operands(ideal_shape(ideal))
        return lambda: ideal.groebner_basis()
    if case_id == "groebner_katsura":
        proof.polynomial(False)
        ideal = katsura_ideal(n)
        operands(ideal_shape(ideal))
        return lambda: ideal.groebner_basis()
    if case_id == "class_group":
        D = class_disc(n)
        operands([D])
        K = QuadraticField(D, "a")
        return lambda: K.class_group()
    if case_id == "galois_group":
        R = PolynomialRing(QQ, "x")
        x = R.gen()
        f = x**n - x - 1
        operands(coeffs(f))
        return lambda: f.galois_group()
    if case_id in ("modsym_charpoly", "newforms"):
        operands([n, 2])
    if case_id == "ec_aplist":
        operands([0, 0, 1, -7, 6, n])
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
        op = (
            "rank"
            if "_rank_" in case_id
            else case_id.removesuffix("_hard").rsplit("_", 1)[1]
        )
        if op in ("det", "rank"):
            return str(answer)
        if op == "charpoly":
            return "%d:%d" % (answer.degree(), seq_hash(coeffs(answer)))
        if op == "smith":
            diagonal = [abs(int(answer[i, i])) for i in range(n)]
            return "%d:%d" % (n, seq_hash(diagonal))
        if op == "divisors":
            # (the diagonal, as the Smith form's signature: padded with
            # zeros to n, since some systems list only the nonzero ones)
            d = [abs(int(x)) for x in answer]
            return "%d:%d" % (n, seq_hash(d + [0] * (n - len(d))))
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


common.main(sys.argv, prepare, signature, lambda: common.ihash(OPERANDS))
