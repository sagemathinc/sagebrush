# numpy for sagebrush

Status (2026-10-05): built, following the recommendation below. The core is
`src/runtime/numpy.ts`, with `numpy_random.ts`, `numpy_linalg.ts`,
`numpy_fft.ts` and `libm.ts` beside it; the Python API is `lib/numpy/`.

## How it is checked

`numpy-tests/` holds programs that print results: creation, arithmetic and
promotion, ufuncs, reductions, indexing, shapes, printing, random, linalg,
fft, polynomials. `python3 numpy-tests/run.py` runs each one under CPython
with the real NumPy (2.5.1) and under sagebrush, and requires the output to
be **byte-identical**. All 13 pass, and CI runs them.

- **Printing:** `repr`/`str` port NumPy's `arrayprint` rules (dragon4
  shortest digits, padding, line wrapping, summarization, `shape=`/`dtype=`
  suffixes, float32 shortest forms), so printed arrays look exactly like
  NumPy's.
- **Arithmetic:** NumPy 2 promotion, with Python scalars "weak" (NEP 50),
  and OverflowError for out-of-range Python ints. Float sums use NumPy's
  pairwise summation, so they agree to the last bit. `mean`, `var` and `std`
  follow NumPy's formulas.
- **Random:** NumPy's exact streams.
  - `np.random.seed` and `RandomState`: MT19937 with NumPy's legacy seeding,
    53-bit doubles, polar-method normals, masked-rejection integers, and
    NumPy's shuffle, Poisson (PTRS) and exponential.
  - `default_rng`: PCG64 seeded through NumPy's SeedSequence hashing, Lemire
    bounded integers, and Floyd's algorithm for `choice(replace=False)`.
  - `Generator.normal` uses a different algorithm (NumPy's ziggurat tables
    are not ported yet), so its stream differs from NumPy's.
- **Bit-for-bit math:** NumPy's distributions and ufuncs call glibc's libm,
  and V8's `Math.log` and `Math.exp` differ from it in the last bit for 7–10%
  of inputs. So `libm.ts` ports glibc's `log` and `exp`, which come from Arm's
  optimized-routines (MIT OR Apache-2.0 WITH LLVM-exception; the tables are
  generated from `math/log_data.c` and `math/exp_data.c`). The port includes
  the fused multiply-adds of glibc's x86-64 FMA build. It agrees with glibc on
  every one of 200,000 test inputs each, and Python's `math.log`/`math.exp`
  use it too, so they match CPython.
- **Not bit-for-bit, to rounding error only:**
  - `sin`, `cos`, `tan`, `arctan`... (glibc's are IBM's larger code; V8
    differs in the last bit for a few percent of inputs).
  - linalg decompositions (LAPACK's blocked algorithms order operations
    differently).
  - fft (pocketfft).
  - float32 transcendentals.

## What is there

- **The `ndarray` and dtypes:** dtypes bool, int8–64, uint8–64, float32/64,
  complex64/128. Arrays are views (`shape`, `strides`, `offset`).
- **Indexing:** basic, advanced and boolean indexing, including NumPy's rule
  for where mixed advanced indices put their axes. Assignment through all of
  them.
- **Broadcasting ufuncs** with `out`, `where`, `reduce`, `accumulate` and
  `outer`.
- **Reductions** with `axis` (int or tuple) and `keepdims`: `nan*`
  variants, `median`, `percentile`/`quantile` (NumPy's `_lerp`), `average`,
  `cov`, `corrcoef`.
- **Shape functions:** `concatenate`, `stack`, `split`, `tile`, `repeat`,
  `pad`, `roll`, `flip`, `rot90`, ...
- **Searching and sorting:** `sort`, `argsort`, `unique` (with indices,
  inverse and counts), `searchsorted`, `where`, `nonzero`, `histogram`,
  `bincount`, `digitize`, `interp`, `convolve`, `gradient`, `trapezoid`,
  `diff`, `cross`, `einsum` (without repeated indices), `tensordot`, `kron`.
- **`linalg`:** `solve`, `inv`, `det`, `slogdet`, `qr`, `cholesky`,
  `eigh`/`eigvalsh` (tred2/tql2), general `eig`/`eigvals` (orthes/hqr2, with
  complex eigenvectors normalized as LAPACK does), `svd` (one-sided Jacobi),
  `pinv`, `lstsq`, `matrix_rank`, `norm`, `cond`, `matrix_power`, and stacked
  (batched) inputs.
- **`fft`:** `fft`/`ifft`/`rfft`/`irfft`/`fft2`/`fftn`, ..., with norms,
  `fftfreq` and `fftshift`.
- **Polynomials:** `polyfit` (NumPy's scaled least squares), `polyval`,
  `roots`, `poly1d`, `polyder`/`polyint`, ... and `np.polynomial.Polynomial`.
- **`np.testing`.**
- **Scalars:** NumPy 2's scalar types (`np.float64(1.5)`, `np.int64`,
  `np.True_`) print and promote as in NumPy.

**Not yet:**
- string, object and structured arrays;
- datetime;
- masked arrays;
- `np.save`/`np.load` (`savetxt`/`loadtxt` exist);
- complex `linalg`;
- `Generator.normal`'s exact stream.
- int64 and uint64 are exact only up to 2^53, since they are stored as
  doubles.

## Speed

Measured in Node against NumPy (C, OpenBLAS) on the same machine:

| | sagebrush | NumPy |
|---|---|---|
| `x*2+1` (10^6) | 3.2 ms | 0.5 ms |
| `sin` (10^6) | 15 ms | 10 ms |
| `sum` (10^6) | 0.9 ms | 0.2 ms |
| `randn` (10^6) | 54 ms | 20 ms |
| 300×300 matmul | 3.7 ms | 2.9 ms |
| `inv` 200×200 | 4.5 ms | 0.7 ms |
| `det` 1000×1000 | 126 ms | 7.4 ms |

Elementwise work is within a few times of NumPy. In the browser, against
NumPy compiled to WebAssembly (Pyodide), see
[bench/browser](bench/browser/README.md).

### WebAssembly SIMD kernels

Dense linear algebra and the FFT run in Rust
([kernels/src](kernels/src)). They are compiled for
`wasm32-unknown-unknown` with `simd128`, `no_std` and without wasm-bindgen,
to a 38 KB module:

- `dgemm`: matmul, register-blocked 4×4 with `f64x2`;
- `dgetrf`/`dgetrs`: LU with partial pivoting (`det`, `slogdet`, `solve`,
  `inv`);
- `dgeqr`: Householder QR (`qr`, and tall matrices before the SVD);
- `dsyev`: tred2 + tql2 (`eigh`, `eigvalsh`);
- `dgeev`: orthes + hqr2 (`eig`, `eigvals`, `roots`);
- `dgesvd`: Golub–Kahan–Reinsch (`svd`, `pinv`, `lstsq`, `matrix_rank`,
  `polyfit`);
- `fft_stockham`/`rfft_rows`: the mixed-radix Stockham FFT (radix 4, 2, 3,
  5 and generic 7–13 butterflies, one complex number per `f64x2`). This
  covers every `numpy.fft` transform, including Bluestein's inner FFTs.
  Twiddle tables come from the TypeScript (`Math.cos`/`Math.sin`) and stay
  resident in WebAssembly memory between calls of the same length.

Matrices whose columns an algorithm walks are stored transposed, so those
walks are contiguous and the elementwise ones (rotations, rank-1 updates)
run two lanes at a time. Long dot products (QR) use four partial sums,
the same in the TypeScript, since one running sum is limited by the latency
of floating-point addition. Arrays are laid out a few cache lines apart
beyond their lengths: power-of-two buffers placed back to back all fall
into the same cache sets, which made the FFT slower than JavaScript.

`scripts/build-kernels.mjs` embeds the module as base64 in
`src/runtime/kernels_wasm.ts`, which is committed, so building sagebrush
does not need Rust. `src/runtime/kernels.ts` compiles it synchronously on
first use and copies operands into its linear memory. Copying is O(n²)
against O(n³) work.

Each kernel does the same floating-point operations in the same order as
the TypeScript it replaces (no fused multiply-add, no reassociation), so
results are bit-identical with or without WebAssembly.
`test/kernels.test.ts` checks this on several hundred results. `Math.hypot`
is not specified bit for bit, and engines differ, so both sides use V8's
two-argument algorithm, written out. Where WebAssembly is unavailable, or
with `SAGEBRUSH_NO_WASM=1` or `globalThis.__SAGEBRUSH_NO_WASM__ = true`, the
TypeScript runs.

In Node, against the TypeScript: matmul 300×300 12× faster (44 → 3.7 ms),
`det` 1000×1000 4× (494 → 126 ms), `eigh` 200×200 4× (45 → 11.5 ms), `svd`
200×200 5× (118 → 22 ms), `eig` 100×100 3× (18 → 5.6 ms), `rfft` of 10^6
points 2× (48.6 → 23.4 ms). In the browser all the dense linear algebra
except `solve` is now faster than Pyodide's LAPACK; see
[bench/browser](bench/browser/README.md).

# The investigation that led here

## write our own, or expose numpy-ts?

An investigation from 2026-10-05. numpy-ts 1.7.0 (MIT,
github.com/dupontcyborg/numpy-ts) was measured in Node 26 against plain
JavaScript and against real NumPy 2.5.1 under CPython 3.14 on the same
machine.

## numpy-ts: what was measured

**Breadth.** 421 exports, and the project claims 476 of 507 NumPy
functions. Present: linalg (inv, solve, svd, eig/eigh, qr, cholesky,
lstsq, ...), fft, random, polyfit, histogram, sorting, broadcasting and
complex numbers. `np.random.seed(0); rand(3)` gives exactly NumPy's
`0.5488135 0.71518937 0.60276338`, so it reproduces the legacy MT19937
stream.

**Speed.** One million float64 values, best of 7 runs, in ms:

| | NumPy (CPython) | numpy-ts | plain JS loop |
|---|---|---|---|
| `sin(x)` | 9.8 | 7.8 | 12.7 |
| `x.sum()` | 0.20 | 0.48 | 0.95 |
| `x*2 + 1` | 0.56 | 0.83 | 4.7 |
| 300×300 matmul | 2.8 | 4.1 | 36 (naive) |

Its Zig/WASM SIMD kernels are close to NumPy and 2–9× faster than straight
JavaScript loops; for matmul it is about 9× faster than a naive loop.

**Problems found in an hour of probing:**

1. **A correctness bug in basic slicing.**
   `np.arange(12).reshape([3, 4]).slice(":", "1:3")` returns
   `[[1, 2], [9, 10], [-inf, -inf]]` instead of `[[1, 2], [5, 6], [9, 10]]`.
   This happens in a fresh process, with a literal array too.
2. **`eig` on a general (non-symmetric) matrix.** A random 100×100 matrix
   took **16 s**, and the result is "real approximations" when the
   eigenvalues are complex, which is wrong for most such matrices.
3. **Memory is managed by hand.** Arrays live in a WASM heap and must be
   `dispose()`d; there is no FinalizationRegistry. A loop of
   `np.sin(x).add(1).multiply(x)` on 10⁶ elements exhausts the default heap
   within a few iterations. The library then falls back to slower JS arrays
   "and the heap will not recover in this process". Python has no `dispose`,
   so a pyjs program (and a notebook session) would hit this routinely.
4. **The defaults differ from NumPy.** `np.array([1, 2])` and
   `np.arange(5)` are float64, where NumPy gives int64. This is natural in
   JS, where numbers are untyped, but a Python bridge would have to pass
   dtypes everywhere.
5. **The API is shaped for TypeScript.** Shapes are arrays
   (`zeros([10])`), slices are strings (`a.slice("1:3")`), and there are no
   keyword arguments. Every function would need a Python-facing wrapper:
   `a[1:3, ::2]`, `a[mask]`, `axis=`, `dtype=`, `out=`, and operators.
6. **Size.** The full browser bundle is 2.8 MB (631 kB gzipped), about
   three times all of sagebrush's browser worker (0.97 MB). Tree-shaking
   does not help, because Python can call anything at run time.

## The two options

**Expose numpy-ts.**

- Pros: huge breadth now; fast kernels; NumPy-compatible printing and
  random streams; MIT; synchronous WASM, which suits our synchronous runtime.
- Cons:
  - Its correctness has gaps (slicing above; eig), so we would inherit
    them, and diagnosing them across a JS library boundary is slow.
  - Its memory model fights Python's: we would need FinalizationRegistry
    and to live with its allocator.
  - A wrapper is still needed for the whole Python surface (indexing,
    kwargs, dtypes, operators, repr). That is where most of the semantic
    work lies anyway.
  - It adds 2.8 MB.

**Write our own.**

- Pros:
  - Python semantics by construction: int64/float64/complex128/bool
    defaults, `a[1:3, ::-2]` views, boolean and fancy indexing,
    broadcasting through the normal dunder protocol, and `repr` as
    `array([...])`.
  - Arrays are ordinary JS objects over typed arrays, freed by the garbage
    collector.
  - It stays small and loads only on `import numpy`.
  - We can validate it continuously against **real NumPy**, which is
    installed here. The conformance harness that already compares pyjs with
    CPython can run the same programs with `import numpy` on both sides, and
    every difference is a bug with a reproducer.
- Cons:
  - NumPy is enormous, and the long tail (dtypes, ufunc machinery,
    `np.einsum`, datetime, structured arrays, masked arrays) never ends.
  - Plain JavaScript loops are 2–9× slower than SIMD kernels.
  - Serious linear algebra (general eig, svd) needs real numerics, not a
    weekend implementation.

## Recommendation: our own semantics, borrowed kernels

1. **A NumPy core of our own, in the runtime (TypeScript).** An `ndarray`
   with shape, strides, offset and dtype over a typed array, with views and
   no copying for slices. Python indexing, broadcasting, ufuncs as functions
   over strided loops, reductions with `axis`, creation functions, `repr`,
   and conversions to and from lists. On top of it, a `numpy` package in
   `lib/` for the Python-side surface. This is the part where semantics
   matter, and owning it is what makes it correct.
2. **Validation against real NumPy from day one,** extending the
   conformance harness, starting with the tutorial-level surface that
   agents and plotting use: `linspace`, `arange`, math ufuncs, `sum`/`mean`/
   `std`, `reshape`, `where`, `random`, boolean masks and `@`.
3. **Speed where it matters.** Inner loops start in JS, which is already
   fast enough for plotting-sized data. Hot kernels (elementwise math,
   reductions, matmul) can later move to WASM SIMD. We could reuse numpy-ts's
   MIT-licensed Zig kernels for that, operating on our own memory, or write
   them in Rust with the toolchain Sagebrush already uses for its WASM
   engines.
4. **Linear algebra from Rust (faer or nalgebra) compiled to WASM:**
   proven eig, svd and qr, in the same packaging as the Sagebrush engines,
   instead of hand-written decompositions.
5. **`random` reproducing NumPy's streams** (MT19937 for the legacy
   `np.random.*`, PCG64 for `default_rng`), checked against NumPy. numpy-ts
   shows it can be done.

A first slice could be the core plus the tutorial surface plus
validation. That is enough for `np.linspace`, `np.sin`, masks and
`plt.plot(x, y)` to just work, with each later step benchmarked against
NumPy itself.
