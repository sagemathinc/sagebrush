# numpy for sagebrush: write our own, or expose numpy-ts?

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
