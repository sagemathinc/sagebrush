# Dense kernels against OpenBLAS (design/numeric-track.md §3)

The numeric track reports each dense kernel's speed as a fraction of OpenBLAS's on the same machine and thread
count. These are tracked, never gated.

**How to run.** `run-vm.sh` runs on a spot VM, from the public repository and a git bundle of the commit (no
credentials). It times three things, each with warm-up runs and then the median of 7 (except `eig` and
`eig` symmetric at $n = 1000$ in MATLAB mode: the median of 3, to keep the run short):
- **MATLAB mode under node**: `bench_matlab.m`, engine/nd's wasm module, on one core (`taskset -c 0`, so no
  helper threads) and on all cores;
- **NumPy 2.5.1 with scipy-openblas**: `bench_numpy.py`, column-major inputs, `OPENBLAS_NUM_THREADS` 1 and 16;
- **native engine/nd**: `gemm_bench` and `solve_bench` (MATLAB mode), from engine/nd/examples.

## 2026-11-21

The run was on a GCP n2-standard-16: an Intel Xeon at 2.80 GHz with 8 cores, 2 threads per core, AVX2, FMA and
AVX-512. It used commit 475c0e69 (track/numeric plus PR 1) and node v24.21.0. The raw output is in
results-2026-11-21/. The table shows median seconds, at $n = 1000$ unless stated; "% of OpenBLAS" is OpenBLAS's
time divided by ours.

| kernel | MATLAB mode, 1 core | OpenBLAS, 1 thread | % | MATLAB mode, all cores | OpenBLAS, 16 threads | % |
|---|---|---|---|---|---|---|
| `A*B` | 0.218 | 0.0296 | 14% | 0.205 | 0.00417 | 2% |
| `A\b` | 0.182 | 0.0219 | 12% | 0.137 | 0.00751 | 5% |
| `chol` | 0.192 | 0.0181 | 9% | 0.134 | 0.0126 | 9% |
| `eig`, symmetric | 1.46 | 0.0933 | 6% | 1.41 | 0.0436 | 3% |
| `eig`, general | 4.51 | 0.685 | 15% | 4.49 | 0.866 | 19% |

Native engine/nd on the same machine, with the AVX2+FMA kernel:

| kernel, $n = 1000$ | engine/nd | OpenBLAS | % |
|---|---|---|---|
| GEMM, 1 thread | 49.3 ms (40.6 GF/s) | 29.6 ms (67.6 GF/s) | 60% |
| GEMM, 8 threads (the physical cores) | 7.9 ms (254 GF/s) | 4.2 ms on **16** threads (480 GF/s): OpenBLAS on 8 threads wasn't measured | 53% of OpenBLAS's 16-thread time |
| GEMM, 16 threads | 9.6 ms (209 GF/s) | 4.2 ms | 44% |
| `A\b`, MATLAB mode (structure pass and rcond included), 1 thread | 26.4 ms | 21.9 ms (gesv, no rcond) | 83% |

## What this says

- **Native engine/nd meets §3's targets, with one caveat.** GEMM reaches 60% of OpenBLAS on one thread (the target is
  50%). On all cores it reaches 53% (35%), but against OpenBLAS on 16 threads, while engine/nd ran on 8: the
  equal-thread comparison §3 asks for (OpenBLAS with `OPENBLAS_NUM_THREADS=8`) is for the next run. The solve reaches 83% (40%). GEMM is slower on 16 threads than on 8: the extra 8 are SMT
  siblings.
- **MATLAB mode is far from the targets**, for three reasons to work on:
  1. **A fixed cost per call** of about 0.3 to 1 ms: interpretation, the copies in and out of the wasm module.
     So $n \le 100$ runs at 1 to 6% of OpenBLAS. That's §3's $c_0$, and the first thing to reduce, because
     agents' calls are mostly small.
  2. **wasm against native:** the solve takes 182 ms in MATLAB mode on one core against 26 ms natively. GEMM
     runs at 9 GF/s in wasm SIMD128 against 41 GF/s natively.
  3. **Threads didn't engage in this run:** `A*B` took the same time on 1 core and on 16. On a shared 16-core
     host the same build's `A*B` does use threads (0.19 s on one core, 0.066 s on all), so the pool's lazy start
     on the VM is the first thing to check. At $n = 1000$, MATLAB's `A*B` also costs about 30 ms more than
     Python's `A @ B` in the same build, which suggests extra copies in `mtimes`.
- **`A\b` no longer has the step at 500 rows.** Before PR 1, $n = 500$ took 1.6 s and $n = 501$ took 0.03 s, on a
  shared host. Now 300 rows take 11 ms and 1000 rows take 182 ms.
- **Eigenvalues** run in Sagebrush's numpy (EISPACK-style), not engine/nd: 15% of OpenBLAS for general `eig`, and
  6% for symmetric `eig`, where LAPACK uses a faster algorithm. Moving them onto engine/nd is the ENGINE-lane part
  of the track.
