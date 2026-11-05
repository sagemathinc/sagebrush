"""Generate engine/nd/src/lapack_fixtures.rs: LAPACK dgetrf pivot sequences for engine/nd's LU tests
(numerics-core P2b-1; grader's design item 1, @sagebrush's ruling on fixtures).

Each fixture names an input that the Rust tests rebuild bit for bit (a formula or engine/nd's 32-bit LCG, so
only the pivots are stored) and the pivots real LAPACK returns for it (scipy.linalg.lapack.dgetrf; 0-based, as
scipy reports them; the BLAS/LAPACK provenance is written into the generated file). A fixture is kept only if
its pivots cannot depend on rounding order. Every elimination step is classified in exact rational arithmetic
(Fractions, following dgetf2's rule: the largest |a|, the first on ties):
  - an exact tie, allowed only while every value so far (entries and multipliers) is a dyadic rational with a
    denominator dividing 2^8 and magnitude at most 2^12, so that any floating-point schedule computes them
    exactly (products under 2^40 over 2^16; sums of a few hundred of them exact); such a tie tests the rule;
  - otherwise the winner must beat the runner-up by a relative gap above MARGIN.
Each kept fixture records its smallest exact gap and its number of exact ties.

NaN inputs are not LAPACK fixtures: this OpenBLAS's idamax chooses a NaN that the reference BLAS definition
(engine/nd's rule) never chooses after the first element, so the generated file records OpenBLAS's choice as
information only, and the Rust tests hold engine/nd to the reference rule.

Run (generation only; no test needs Python): /usr/local/bin/python3 -I scripts/gen-nd-lapack-fixtures.py
"""
import io
import math
import sys
from fractions import Fraction

import numpy as np
import scipy
import scipy.linalg.lapack as lapack

MARGIN = 1e-6  # (engine/nd/src/lu.rs tests::PIVOT_GAP)


def lcg_uniform(count, seed):
    """engine/nd's seeded(): s = s * 1103515245 + 12345 (mod 2^32); s / 2^32 - 0.5, exact in f64."""
    out, s = [], seed
    for _ in range(count):
        s = (s * 1103515245 + 12345) % 2**32
        out.append(s / 4294967296.0 - 0.5)
    return out, s


def lcg_ints(count, seed):
    """Small integers -4..4 from the same LCG: (s >> 16) % 9 - 4."""
    out, s = [], seed
    for _ in range(count):
        s = (s * 1103515245 + 12345) % 2**32
        out.append(float((s >> 16) % 9 - 4))
    return out


def colmajor(vals, n):
    return np.array(vals, dtype=np.float64).reshape(n, n, order="F")


def hadamard(n):
    """Sylvester: H(i, j) = (-1)^popcount(i & j)."""
    return np.array([[(-1.0) ** bin(i & j).count("1") for j in range(n)] for i in range(n)])


def magic_odd(n):
    """MATLAB's magic(n) for odd n: M(i, j) = n * mod(i + j - (n + 3)/2, n) + mod(i + 2j - 2, n) + 1 (1-based)."""
    return np.array([[n * ((i + j - (n + 3) // 2) % n) + ((i + 2 * j - 2) % n) + 1 for j in range(1, n + 1)] for i in range(1, n + 1)], dtype=float)


def small_dyadic(x):
    return x.denominator & (x.denominator - 1) == 0 and x.denominator <= 256 and abs(x) <= 4096


def classify(a):
    """Exact elimination with dgetf2's rule: (True, min gap, exact ties) or (False, why)."""
    n = a.shape[0]
    m = [[Fraction(float(a[i, j])) for j in range(n)] for i in range(n)]
    exact = all(small_dyadic(v) for row in m for v in row)
    gap, ties = math.inf, 0
    for k in range(n):
        col = [abs(m[i][k]) for i in range(k, n)]
        best = max(col)
        p = k + col.index(best)
        rest = sorted(col, reverse=True)
        if best != 0 and len(rest) > 1:
            if rest[1] == best:
                if not exact:
                    return False, "an exact tie after inexact arithmetic"
                ties += 1
            else:
                g = (rest[0] - rest[1]) / rest[0]
                if g <= Fraction(MARGIN) and not exact:
                    return False, f"a gap of {float(g):.3g}, under the margin"
                gap = min(gap, float(g))
        m[k], m[p] = m[p], m[k]
        if m[k][k] == 0:
            continue
        for i in range(k + 1, n):
            l = m[i][k] / m[k][k]
            m[i][k] = l
            for j in range(k + 1, n):
                m[i][j] -= l * m[k][j]
            exact = exact and small_dyadic(l) and all(small_dyadic(m[i][j]) for j in range(k + 1, n))
    return True, gap, ties


def lapack_lu(a):
    _, piv, info = lapack.dgetrf(np.asfortranarray(a, dtype=np.float64))
    return [int(p) for p in piv], int(info)


def main():
    cands = []  # (name, rust constructor expression, matrix)
    for n in (5, 7, 9, 11):
        cands.append((f"magic({n})", f"Input::MagicOdd({n})", magic_odd(n)))
    for n in (4, 8, 16, 32, 64, 128):
        cands.append((f"hadamard({n})", f"Input::Hadamard({n})", hadamard(n)))
    for n, s in ((6, 1), (10, 2), (40, 3), (64, 4), (100, 5)):
        cands.append((f"small integers n={n} seed={s}", f"Input::Ints({n}, {s})", colmajor(lcg_ints(n * n, s), n)))
    for n, s in ((40, 11), (64, 12), (97, 13), (150, 14), (257, 15)):
        cands.append((f"uniform n={n} seed={s}", f"Input::Uniform({n}, {s})", colmajor(lcg_uniform(n * n, s)[0], n)))
    dense = [
        ("first column -0.0, +0.0, +0.0 (all zero: the first wins; a zero pivot)", [[-0.0, 1.0, 2.0], [0.0, 3.0, 1.0], [0.0, 1.0, 5.0]]),
        ("first column 2, -2, 1 (an exact tie: the first wins)", [[2.0, 1.0, 0.0], [-2.0, 3.0, 1.0], [1.0, 1.0, 4.0]]),
        ("ties in two steps: 4, -4, 4 then 2, -2", [[4.0, 1.0, 2.0], [-4.0, 1.0, 0.0], [4.0, 3.0, 2.0]]),
    ]
    for name, rows in dense:
        a = np.array(rows)
        flat = ", ".join(("-0.0" if (v == 0 and math.copysign(1, v) < 0) else f"{v:.1f}") for v in a.flatten(order="F"))
        cands.append((name, f"Input::Dense(3, &[{flat}])", a))
    kept, rejected = [], []
    for name, ctor, a in cands:
        r = classify(a)
        if not r[0]:
            rejected.append((name, r[1]))
            continue
        piv, info = lapack_lu(a)
        kept.append((name, ctor, piv, info, r[1], r[2]))
    nan_info = []
    for name, rows in (("NaN after the first element of column 0", [[1.0, 2.0, 0.5], [math.nan, 1.0, 2.0], [3.0, 0.5, 1.0]]),
                       ("NaN first in column 0", [[math.nan, 2.0, 0.5], [1.0, 1.0, 2.0], [3.0, 0.5, 1.0]])):
        nan_info.append((name, lapack_lu(np.array(rows))[0]))
    out = io.StringIO()
    w = out.write
    w("// Generated by scripts/gen-nd-lapack-fixtures.py (do not edit; regenerate): LAPACK dgetrf pivots for\n")
    w("// engine/nd's LU tests, 0-based as scipy reports them (ipiv[k]: the row interchanged with row k at step k).\n")
    w(f"// Provenance: python {sys.version.split()[0]}, numpy {np.__version__}, scipy {scipy.__version__}")
    try:
        deps = np.show_config(mode="dicts")["Build Dependencies"]
        w(", numpy blas " + " ".join(str(deps['blas'].get(k, '?')) for k in ("name", "version")))
        w(", lapack " + " ".join(str(deps['lapack'].get(k, '?')) for k in ("name", "version")))
    except Exception as e:  # (never silent)
        w(f", blas/lapack unknown ({e})")
    w(f".\n// Margin: {MARGIN} (lu.rs tests::PIVOT_GAP). Rejected (their pivots could depend on rounding order):\n")
    for name, why in rejected:
        w(f"//   {name}: {why}\n")
    w("// NaN (information only, not fixtures; engine/nd follows the reference BLAS idamax, never choosing a NaN\n")
    w("// after the first element): this OpenBLAS chose\n")
    for name, piv in nan_info:
        w(f"//   {name}: {piv}\n")
    w("\nuse super::tests::Input;\n\n")
    w("/// (name, input, LAPACK ipiv (0-based), LAPACK info (1-based column of the first zero pivot, 0 if none),\n")
    w("/// smallest exact relative pivot gap (INFINITY if no step had two candidates), exact ties)\n")
    w("pub(crate) const FIXTURES: &[(&str, Input, &[usize], usize, f64, usize)] = &[\n")
    for name, ctor, piv, info, gap, ties in kept:
        g = "f64::INFINITY" if math.isinf(gap) else repr(gap)
        w(f'    ("{name}", {ctor}, &{piv!r}, {info}, {g}, {ties}),\n')
    w("];\n")
    sys.stdout.write(out.getvalue())


main()
