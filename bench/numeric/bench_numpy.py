# NumPy/OpenBLAS baseline for the numeric track's §3: the same ops and sizes as bench_matlab.m, column-major
# (Fortran-ordered) inputs, warm-up runs, then the median of 7. Set OPENBLAS_NUM_THREADS before running.
import os
import statistics
import time

import numpy as np

R = 7
rng = np.random.default_rng(1)
print("# numpy", np.__version__, "OPENBLAS_NUM_THREADS", os.environ.get("OPENBLAS_NUM_THREADS"))
for n in (10, 30, 50, 100, 300, 1000):
    A = np.asfortranarray(rng.random((n, n)))
    B = np.asfortranarray(rng.random((n, n)))
    b = rng.random(n)
    S = np.asfortranarray(A.T @ A + n * np.eye(n))
    ops = [("gemm", lambda: A @ B, 2 * n**3), ("solve", lambda: np.linalg.solve(A, b), 2 / 3 * n**3),
           ("chol", lambda: np.linalg.cholesky(S), 1 / 3 * n**3), ("eigsym", lambda: np.linalg.eigvalsh(S), 4 / 3 * n**3),
           ("eig", lambda: np.linalg.eigvals(A), 10 * n**3)]
    for name, f, flops in ops:
        f()
        f()
        t = []
        for _ in range(R):
            t0 = time.perf_counter()
            f()
            t.append(time.perf_counter() - t0)
        m = statistics.median(t)
        print(f"{name} {n} {m:.6g} {flops / m / 1e9:.4g}")
