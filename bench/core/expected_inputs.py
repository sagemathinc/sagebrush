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
            else:
                out.append(pow(i + 2 + v, j + 3, P))
    return out


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
    if row == "galois_group":
        return [-1, -1] + [0] * (n - 2) + [1]
    if row in ("modsym_charpoly", "newforms"):
        return [n, 2]
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
        for key in sizes:
            n, k = row["sizes"][key]["n"], run.variants(row, key)
            out[f"{row['id']}:{key}"] = {
                "n": n,
                "variants": k,
                "input_hash": str(input_hash(row["id"], n, k)),
            }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size", default="all", help="s, m, l or all")
    ap.add_argument("--only", action="append", default=[], metavar="ROW")
    a = ap.parse_args()
    sizes = ["s", "m", "l"] if a.size == "all" else a.size.split(",")
    print(json.dumps(expected(sizes, a.only), indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
