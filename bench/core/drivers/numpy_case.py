"""Dense f64 matrix products through NumPy's A @ B: one file, two runtimes.

- Under the Sagebrush CLI (build/cli/pyjs.cjs), the user column: NumPy mode,
  whose matmul takes engine/nd's GEMM, on the CLI's thread pool, when every
  dimension is at least 256 (smaller products take another route, so the rows
  start at 256). The pool sizes itself from the CPUs the process may run on:
  run.py pins these rows' runs (threads_by_affinity), so a 1-thread column is
  one CPU and a sweep column is its CPUs.
  The pool starts at the first large product, in the background, and a
  product before it is ready runs on one thread. So before a timed run the
  driver starts it and waits for it (pool_gate): a run on T CPUs
  (BENCH_THREADS) must have min(T - 1, 8) helpers, else the run fails. After
  the run it prints a POOL line (run.py records it): the participants every
  product since the gate actually ran on, and the run fails unless they all
  ran on 1 + those helpers.
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

import json
import os
import sys
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

import numpy as np  # noqa: E402

case_id, n, MODE = sys.argv[1], int(sys.argv[2]), sys.argv[3]
OPERANDS = []
# the CLI's engine/nd pool (np.linalg._threads); real NumPy has none
POOL = getattr(np.linalg, "_threads", None)
# its products' least dimension, from src/runtime/nd.ts's ND_MATMUL_MIN
ND_MATMUL_MIN = 256
# how long the gate waits for the pool (src/runtime/nd.ts gives up at 20 s)
POOL_WAIT = 30.0
GATE = {}


def pool_gate(A, B):
    """Before a timed run under the CLI: start the pool (one product, outside
    any timing) and wait until it is ready or off; then the participants a
    product gets must be 1 + min(T - 1, 8) on T CPUs, or the run fails."""
    if POOL is None or GATE or MODE not in ("time", "time-fresh") or n < ND_MATMUL_MIN:
        return
    T = int(os.environ.get("BENCH_THREADS", "1"))
    want = min(T - 1, 8) + 1 if T > 1 else 1
    ran = sum(POOL()["products"].values())
    A @ B
    if sum(POOL()["products"].values()) != ran + 1:
        raise SystemExit("pool: the product did not run on engine/nd (state %s%s)" % (POOL()["state"], ": " + POOL()["why"] if POOL()["why"] else ""))
    t0 = time.perf_counter()
    while POOL()["state"] == "starting" and time.perf_counter() - t0 < POOL_WAIT:
        time.sleep(0.005)
    st = POOL()
    if st["threads"] != want:
        raise SystemExit(
            "pool: a product gets %d participants, not %d (BENCH_THREADS=%d; state %s%s)"
            % (st["threads"], want, T, st["state"], ": " + st["why"] if st["why"] else "")
        )
    GATE.update(want=want, waited=round(time.perf_counter() - t0, 6), before=dict(st["products"]))


def pool_report():
    """After the run: the POOL line, and a failure unless every product since
    the gate ran on the participants the gate saw."""
    if not GATE:
        return
    st = POOL()
    since = {k: c - GATE["before"].get(k, 0) for k, c in st["products"].items()}
    since = {k: c for k, c in since.items() if c}
    print("POOL|" + json.dumps({"want": GATE["want"], "threads": st["threads"], "state": st["state"], "waited": GATE["waited"], "products": {str(k): c for k, c in sorted(since.items())}}, sort_keys=True))
    if set(since) != {GATE["want"]}:
        raise SystemExit("pool: the products since the gate ran on %s participants, not all on %d" % (sorted(since), GATE["want"]))


def crc(data):
    """64 bits of a byte string: its CRC-32 and its Adler-32 (zlib's, the
    standard ones), as one integer. Not SHA-256: the CLI's hashlib takes
    about 10 s a megabyte, its zlib milliseconds, and the products here are
    up to 32 MB."""
    return zlib.crc32(data) << 32 | zlib.adler32(data)


def digest(x, dtype="<i8"):
    """Every entry of a matrix: crc() of its entries as little-endian int64
    (or float64 bits), row-major (expected_inputs.py's gemm_digest)."""
    return crc(np.ascontiguousarray(x, dtype=dtype).tobytes())


def base(size, v, salt):
    """The integer entries of a size x size matrix, row-major: x_k =
    (2654435761 k + 40503 v + salt) mod 2049 - 1024 (expected_inputs.py's
    gemm_entries), as int64. Computed as ((k mod 2049) (2654435761 mod 2049)
    + c) mod 2049, the same values, so every intermediate stays far below
    2^53: the CLI's int64 refuses values beyond it (k 2654435761 reaches
    2^53 at k = 2^22, n = 2048)."""
    k = np.arange(size * size, dtype=np.int64)
    return (((k % 2049) * (2654435761 % 2049) + (v * 40503 + salt)) % 2049 - 1024).reshape(size, size)


def prepare(v):
    a, b = base(n, v, 12345), base(n, v, 54321)
    OPERANDS.clear()
    # (n, v and a digest of every entry of each integer matrix; the bits
    # row's operands also cover the mapped matrices' exact bits)
    OPERANDS.extend([n, v, digest(a), digest(b)])
    A, B = a.astype(np.float64), b.astype(np.float64)
    if case_id == "mat_f64_gemm_bits":
        A, B = A / 1024.0 + 1.0 / 3.0, B / 1024.0 + 1.0 / 3.0
        OPERANDS.extend([digest(A, "<f8"), digest(B, "<f8")])
    elif case_id != "mat_f64_gemm":
        raise ValueError(case_id)
    pool_gate(A, B)
    return lambda: A @ B


def signature(answer):
    # (the product's bytes, -0.0 made +0.0, row-major: exact integers for
    # mat_f64_gemm, comparable across systems; the exact bits for _bits)
    c = np.ascontiguousarray(answer + 0.0, dtype="<f8")
    return "%d:%016x" % (n, crc(c.tobytes()))


common.main(sys.argv, prepare, signature, lambda: common.ihash(OPERANDS))
pool_report()
