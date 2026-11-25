"""Dense f64 matrix products through NumPy's A @ B: one file, two runtimes.

- Under the Sagebrush CLI (build/cli/pyjs.cjs), the user column: NumPy mode,
  whose matmul takes engine/nd's GEMM, on the CLI's thread pool, when every
  dimension is at least 256 (smaller products take another route, so the rows
  start at 256). The pool sizes itself from the CPUs the process may run on:
  run.py pins these rows' runs (threads_by_affinity), so a 1-thread column is
  one CPU and a sweep column is its CPUs.
- Under real NumPy with OpenBLAS (run.py's blas and blas-n backends), the
  reference, its threads set by OPENBLAS_NUM_THREADS.

The protocol is common.py's.  Rows:
- mat_f64_gemm: integer-valued inputs (|x| <= 1024), so every dot product
  (|sum| <= n 2^20 < 2^53) and so the product is exact, and its signature can
  be compared with any system's;
- mat_f64_gemm_bits: the same matrices scaled to non-integers (x / 1024 +
  1/3), ours only, informational: its signature is the product's exact bits,
  which must be the same whatever the thread count (the pool's promise).
"""

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

import numpy as np  # noqa: E402

case_id, n = sys.argv[1], int(sys.argv[2])
OPERANDS = []


def base(size, v, salt):
    """The integer entries of a size x size matrix, row-major: x_k =
    (2654435761 k + 40503 v + salt) mod 2049 - 1024 (expected_inputs.py's
    gemm_entries), as int64 (no overflow below size 4096)."""
    k = np.arange(size * size, dtype=np.int64)
    return ((k * 2654435761 + (v * 40503 + salt)) % 2049 - 1024).reshape(size, size)


def prepare(v):
    a, b = base(n, v, 12345), base(n, v, 54321)
    OPERANDS.clear()
    OPERANDS.extend([n, v] + [int(x) for x in a.sum(axis=1)] + [int(x) for x in b.sum(axis=0)])
    A, B = a.astype(np.float64), b.astype(np.float64)
    if case_id == "mat_f64_gemm_bits":
        A, B = A / 1024.0 + 1.0 / 3.0, B / 1024.0 + 1.0 / 3.0
    elif case_id != "mat_f64_gemm":
        raise ValueError(case_id)
    return lambda: A @ B


def signature(answer):
    # (the product's bytes, -0.0 made +0.0, row-major: exact integers for
    # mat_f64_gemm, comparable across systems; the exact bits for _bits)
    c = np.ascontiguousarray(answer + 0.0, dtype=np.float64)
    return "%d:%s" % (n, hashlib.sha256(c.tobytes()).hexdigest()[:16])


common.main(sys.argv, prepare, signature, lambda: common.ihash(OPERANDS))
