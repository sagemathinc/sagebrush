#!/usr/bin/env python3
"""The expected input hashes of every point, from the input formulas alone:
a reference generator in plain Python (no engine, Magma, FLINT or Sage), a
separate implementation of what each driver's `inputs` mode hashes
(drivers/common.py: the hash of the K variants' operand hashes).

A run's plan carries these hashes, computed before the plan is approved;
every backend's own generator must match them before it is timed.  The
tests (test_expected_inputs.py) check them against the drivers.

  python3 bench/core/expected_inputs.py [--size s|m|l|all] [--only ROW]

prints JSON: {"<row>:<size>": {"n": n, "variants": K, "input_hash": h}}.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MOD = 1000000007
P = 65537
P31 = 2147483647  # (the mat_fp31_* rows: a word-size prime)


def ihash(xs) -> int:
    h = 17
    for x in xs:
        h = (h * 1000003 + int(x) % MOD) % MOD
    return h


def rat(a: int, b: int) -> int:
    """a/b as a residue modulo MOD (the drivers' scalar hash of a rational)."""
    return (a % MOD) * pow(b % MOD, MOD - 2, MOD) % MOD


def trim(c: list[int]) -> list[int]:
    while c and c[-1] == 0:
        c.pop()
    return c


def mul(a: list[int], b: list[int]) -> list[int]:
    """The product of two integer polynomials (constant term first), by
    Kronecker substitution: evaluate at 2^k, multiply the integers, read
    the coefficients back (balanced digits)."""
    if not a or not b:
        return []
    bound = max(map(abs, a)) * max(map(abs, b)) * min(len(a), len(b))
    k = bound.bit_length() + 2
    k += -k % 8
    half = 1 << (k - 1)

    def pack(c):
        x = 0
        for v in reversed(c):
            x = (x << k) + v
        return x

    prod = pack(a) * pack(b)
    n = len(a) + len(b) - 1
    # (bias every digit by 2^(k-1), so all are nonnegative: then bytes)
    bias = pack([half] * n)
    raw = (prod + bias).to_bytes(n * k // 8 + 1, "little")
    step = k // 8
    return trim(
        [
            int.from_bytes(raw[i * step : (i + 1) * step], "little") - half
            for i in range(n)
        ]
    )


def zpoly(size: int, salt: int) -> list[int]:
    return trim([((i * i * salt + 3 * i + 1) % 1000003) - 500001 for i in range(size)])


def dense_poly(size: int, kind: str, v: int) -> list[int]:
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


# galois_group_small's inputs by degree, coefficients from the constant term
# up: a sextic with group PSL(2,5) (6T12, order 60), x^8 - 2 (8T8, order 16,
# a 2-group) and x^12 - 2 (12T28, order 48): small and imprimitive groups,
# where S_n's cycle-type certificate doesn't apply (groups checked with a
# black-box reference)
SMALL_GROUP_POLYS = {
    6: [3, 2, -2, -2, -1, 0, 1],
    8: [-2, 0, 0, 0, 0, 0, 0, 0, 1],
    12: [-2] + [0] * 11 + [1],
}


def fppoly(size: int, salt: int) -> list[int]:
    return trim([(i * i * salt + 3 * i + 1) % P for i in range(size)])


def det_entries(kind: str, size: int, v: int) -> list[int]:
    """det_input's entries, row-major, as the drivers hash them."""
    out = []
    for i in range(size):
        for j in range(size):
            if kind == "q":
                out.append(rat(pow(i + 2 + v, j + 3, 101) - 50, 1 + (i * j) % 7))
            elif kind == "z":
                out.append(pow(i + 2 + v, j + 3, 1000003) - 500001)
            elif kind == "fp31":
                out.append(pow(i + 2 + v, j + 3, P31))
            else:
                out.append(pow(i + 2 + v, j + 3, P))
    return out


# The rank rows beyond the square ones: wide (n x 2n, rank n), def (n x n,
# rank n // 2) and def_p (n x n, rank n over Q but at most n - 1 mod the
# engine's word prime).  Random dense factors, so elimination sees real
# coefficient growth; each rank is proved by construction (an upper bound)
# plus its rank modulo an auxiliary prime (a lower bound): a seed whose
# certificate fails is refused (it essentially never happens).  Every
# driver builds the same matrices from these formulas; only this file
# certifies them.
RANK_P = (1 << 62) - 57
CERT_Q = (1 << 31) - 1
# (the entries' range: as the square rows', +-500001 over Z and +-50 over Q)
RANK_RANGE = {"z": (1000003, 500001), "q": (101, 50)}


def rnd(i: int, j: int, s: int, kind: str) -> int:
    m, off = RANK_RANGE[kind]
    return pow(131 * i + 31 * j + s, 5, m) - off


def rnd_matrix(rows: int, cols: int, s: int, kind: str) -> list[list[int]]:
    return [[rnd(i, j, s, kind) for j in range(cols)] for i in range(rows)]


def matmul(a: list[list[int]], b: list[list[int]]) -> list[list[int]]:
    """An integer matrix product, each row of the result a combination of
    b's rows: b's rows are packed into integers (Kronecker substitution, as
    mul does for polynomials), so a product of size 250 stays cheap."""
    if not a or not b:
        return []
    width = len(b[0])
    bound = (
        max(max(map(abs, r)) for r in a) * max(max(map(abs, r)) for r in b) * len(b) + 1
    )
    k = bound.bit_length() + 2
    k += -k % 8
    half = 1 << (k - 1)

    def pack(row):
        x = 0
        for v in reversed(row):
            x = (x << k) + v
        return x

    packed = [pack(r) for r in b]
    bias = pack([half] * width)
    step = k // 8
    out = []
    for row in a:
        acc = 0
        for c, p in zip(row, packed):
            if c:
                acc += c * p
        raw = (acc + bias).to_bytes(width * k // 8 + 1, "little")
        out.append(
            [
                int.from_bytes(raw[i * step : (i + 1) * step], "little") - half
                for i in range(width)
            ]
        )
    return out


def rank_mod(a: list[list[int]], q: int) -> int:
    """The rank of an integer matrix modulo the prime q."""
    m = [[x % q for x in r] for r in a]
    rank, cols = 0, len(m[0]) if m else 0
    for c in range(cols):
        piv = next((i for i in range(rank, len(m)) if m[i][c]), None)
        if piv is None:
            continue
        m[rank], m[piv] = m[piv], m[rank]
        inv = pow(m[rank][c], -1, q)
        top = [x * inv % q for x in m[rank]]
        m[rank] = top
        for i in range(rank + 1, len(m)):
            f = m[i][c]
            if f:
                m[i] = [(x - f * y) % q for x, y in zip(m[i], top)]
        rank += 1
    return rank


def rank_matrix(shape: str, kind: str, n: int, v: int) -> list[list[int]]:
    """The integer matrix of a wide, def or def_p rank row (before the
    rational rows' scaling), certified: its rank is proved, or the seed is
    refused."""
    s1, s2 = 10 * v + 1, 10 * v + 2
    if shape == "wide":
        a, want = rnd_matrix(n, 2 * n, s1, kind), n
    elif shape == "def":
        r = n // 2
        a, want = matmul(rnd_matrix(n, r, s1, kind), rnd_matrix(r, n, s2, kind)), r
    elif shape == "def_p":
        c = rnd_matrix(n, n, s2, kind)
        c[-1] = [RANK_P * x for x in c[-1]]
        a, want = matmul(rnd_matrix(n, n, s1, kind), c), n
    else:
        raise ValueError(shape)
    # (rank <= want by construction: n rows, or an inner dimension r; and
    # the rank mod CERT_Q is a lower bound over Q.  def_p's rank mod RANK_P
    # is at most n - 1 by construction: a factor's row is a multiple of it)
    if rank_mod(a, CERT_Q) != want:
        raise ValueError(
            f"{shape} {kind} n={n} variant {v}: the rank certificate failed; refusing the seed"
        )
    return a


def rank_entries(row: str, n: int, v: int) -> list[int]:
    """A rank row's entries, row-major, as the drivers hash them (rationals
    as residues: row i of the rational rows divided by 1 + i mod 7)."""
    kind, shape = row.split("_")[1], row.split("_rank_")[1]
    a = rank_matrix(shape, kind, n, v)
    if kind == "z":
        return [x for r in a for x in r]
    return [rat(x, 1 + i % 7) for i, r in enumerate(a) for x in r]


def cyclic_shape(n: int) -> list[int]:
    """Cyclic-n's generators as sorted (total degree, number of terms)."""
    pairs = [(d, n) for d in range(1, n)] + [(n, 2)]
    return [x for pair in sorted(pairs) for x in pair]


def katsura_shape(n: int) -> list[int]:
    """Katsura-n (n + 1 variables x_0..x_n): x_0 + 2 sum x_i - 1, and for
    m = 0..n-1, sum_{j=-n..n} x_|j| x_|m-j| - x_m (the terms that remain)."""
    pairs = [(1, n + 2)]
    for m in range(n):
        terms: dict[tuple, int] = {}
        for j in range(-n, n + 1):
            a, b = abs(j), abs(m - j)
            if a <= n and b <= n:
                key = tuple(sorted((a, b)))
                terms[key] = terms.get(key, 0) + 1
        mono = {k: c % 32003 for k, c in terms.items() if c % 32003}
        lin = (m,)
        mono[lin] = (mono.get(lin, 0) - 1) % 32003
        mono = {k: c for k, c in mono.items() if c}
        pairs.append((max(len(k) for k in mono), len(mono)))
    return [x for pair in sorted(pairs) for x in pair]


# The class-group stream rows' discriminants: variant v of a point is the
# v-th D of its stream, so each repetition meets a D nothing has seen (no
# cached field or class number), and every system walks the same list.
# The drivers and the Magma driver build the same streams (a test checks).
#   prime:     -p, p = 3 (mod 4) prime, from 2 10^(n-1) up
#   composite: even v: -p q, p = 1 and q = 3 (mod 4); odd v: -4 p q,
#              p = q = 1 (mod 4); p from 2 10^h, q from 4 10^(n-2-h) or
#              3 10^(n-2-h), h = (n - 1) // 2 (each the v // 2-th prime)
#   large_h:   -p, p = 7 (mod 8) prime with (-p | q) = +1 for q = 3 .. 23,
#              so L(1, chi) and h are large for |D|
_STREAM_BASES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97)


def _is_prime(m):
    """Miller-Rabin with the first 25 primes as bases (deterministic below
    3.3 10^24, and far past any doubt for the 40-digit streams)."""
    if m < 2:
        return False
    for b in _STREAM_BASES:
        if m % b == 0:
            return m == b
    d, s = m - 1, 0
    while d % 2 == 0:
        d, s = d // 2, s + 1
    for b in _STREAM_BASES:
        x = pow(b, d, m)
        if x in (1, m - 1):
            continue
        for _ in range(s - 1):
            x = x * x % m
            if x == m - 1:
                break
        else:
            return False
    return True


def _nth_prime(start, mod, res, j):
    """The j-th prime p >= start with p = res (mod mod), j counting from 0."""
    p = start + (res - start) % mod
    while True:
        if _is_prime(p):
            if j == 0:
                return p
            j -= 1
        p += mod


def _legendre(a, q):
    t = pow(a % q, (q - 1) // 2, q)
    return -1 if t == q - 1 else t


def stream_disc(kind, n, v):
    """Variant v's discriminant of the class-group stream `kind` at about n
    digits (see above)."""
    if kind == "prime":
        return -_nth_prime(2 * 10 ** (n - 1), 4, 3, v)
    if kind == "composite":
        h, j = (n - 1) // 2, v // 2
        if v % 2 == 0:
            return -_nth_prime(2 * 10**h, 4, 1, j) * _nth_prime(4 * 10 ** (n - 2 - h), 4, 3, j)
        return -4 * _nth_prime(2 * 10**h, 4, 1, j) * _nth_prime(3 * 10 ** (n - 2 - h), 4, 1, j)
    if kind == "large_h":
        p, left = 2 * 10 ** (n - 1) + (7 - 2 * 10 ** (n - 1)) % 8, v
        while True:
            if all(_legendre(-p, q) == 1 for q in (3, 5, 7, 11, 13, 17, 19, 23)) and _is_prime(p):
                if left == 0:
                    return -p
                left -= 1
            p += 8
    raise ValueError(kind)


# The class-group stream rows: each row's stream (stream_disc) and route
CG_STREAM = {
    "class_group_prime": "prime",
    "class_group_composite": "composite",
    "class_group_large_h": "large_h",
    "class_group_proven": "prime",
    "class_group_generic": "prime",
}


def class_disc(digits: int) -> int:
    return {
        12: -100000000003,
        24: -1000000000000000000000003,
        40: -10000000000000000000000000000000000000003,
    }[digits]


def operands(row: str, n: int, v: int) -> list[int]:
    """The integers a driver's `inputs` mode hashes for variant v."""
    if row in ("bigint_mul", "bigint_gcd"):
        a = (1 << n) - (1 << (n // 3)) + 123456789 + v * 1000003
        b = (1 << (n - 1)) + (1 << (n // 2)) + 987654321 + v * 998244353
        return [a, b]
    s = 6 * v
    if row == "poly_z_mul":
        return zpoly(n, 11 + s) + zpoly(n, 17 + s)
    if row == "poly_z_gcd":
        g = zpoly(n // 2, 5 + s)
        return mul(g, zpoly(n, 11 + s)) + mul(g, zpoly(n, 17 + s))
    if row == "poly_z_factor":
        return [-1] + [0] * (n - 1) + [1]
    if row == "poly_z_factor_product":
        f = [1]
        for i in range(1, n + 1):
            f = mul(f, [i * i + i + 1 + v, i + 1, 1])
        return f
    if row == "poly_fp_mul":
        return fppoly(n, 11 + s) + fppoly(n, 17 + s)
    if row == "poly_fp_gcd":
        g = fppoly(n // 2, 5 + s)
        ga = trim([c % P for c in mul(g, fppoly(n, 11 + s))])
        gb = trim([c % P for c in mul(g, fppoly(n, 17 + s))])
        return ga + gb
    if row == "poly_fp_factor":
        return [P - 1] + [0] * (n - 1) + [1]
    if row == "poly_fp_factor_dense":
        return dense_poly(n, "fp", v)
    if row == "poly_z_factor_dense":
        return dense_poly(n, "z", v)
    if row.endswith("_hard"):
        return [x for r in smith_hard_rows(n, v) for x in r]
    if row.startswith("mat_") and "_rank_" in row:
        return rank_entries(row, n, v)
    if row.startswith("mat_"):
        kind = row.split("_")[1]
        entries = det_entries(kind, n, v)
        if row.endswith("_solve"):
            entries += list(range(1, n + 1))
        return entries
    if row == "groebner_cyclic":
        return cyclic_shape(n)
    if row == "groebner_katsura":
        return katsura_shape(n)
    if row == "class_group":
        return [class_disc(n)]
    if row in CG_STREAM:
        return [stream_disc(CG_STREAM[row], n, v)]
    if row == "galois_group":
        return [-1, -1] + [0] * (n - 2) + [1]
    if row == "galois_group_small":
        return list(SMALL_GROUP_POLYS[n])
    if row in ("modsym_charpoly", "newforms"):
        return [n, 2]
    if row in ("hecke_matrix", "hecke_matrix_prebuilt"):
        return [389, 2, n]
    if row == "ec_aplist":
        return [0, 0, 1, -7, 6, n]
    raise ValueError("no input formula for row " + row)


def input_hash(row: str, n: int, k: int) -> int:
    return ihash(ihash(operands(row, n, v)) for v in range(k))


def expected(sizes: list[str], only: list[str]) -> dict:
    sys.path.insert(0, str(HERE))
    import run  # noqa: E402  (only for items.json and the variants rule)

    rows = json.loads((HERE / "items.json").read_text())["rows"]
    out = {}
    for row in rows:
        if only and row["id"] not in only:
            continue
        for key in (k for k in (sizes or row["sizes"]) if k in row["sizes"]):
            n, k = row["sizes"][key]["n"], run.variants(row, key)
            out[f"{row['id']}:{key}"] = {
                "n": n,
                "variants": k,
                "input_hash": str(input_hash(row["id"], n, k)),
            }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--size", default="all", help="comma-separated sizes (s, m, l, c0 .. c4) or all"
    )
    ap.add_argument("--only", action="append", default=[], metavar="ROW")
    a = ap.parse_args()
    # ("all": every size each row has, calibration sizes included)
    sizes = [] if a.size == "all" else a.size.split(",")
    print(json.dumps(expected(sizes, a.only), indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
