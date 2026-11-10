# One multiprecision core: mpmath on Rust (design)

*@sagebrush-sage2, November 9, 2026. This is a design document only; code follows once it merges, one phase at a time.*

## In plain words

- Sagebrush ships several separate implementations of arbitrary-precision numbers and their functions. mpmath (added in #927) is the largest. Sage mode's `RealField` (`lib/_sage_real.py`) is a second. The engines' ball arithmetic (`engine/ball`) is a third. This design folds them into one Rust core, so that only one piece of code computes, say, a 30x30 matrix inverse at 30 digits.
- mpmath's own interface stays the same: its names, its conventions, and its test suite, which runs unchanged as the oracle at every step.
- The rule is **one implementation per precision tier**. Double-precision code (`lib/_special.py`, numpy's linear algebra, scipy) is a different tier with different algorithms. It is not merged into the multiprecision core, because that would make it many times slower.
- Measured today, mpmath on Sagebrush takes 5.25 s on the benchmark, against 6.82 s for Pyodide and 1.31 s for CPython with gmpy. Most of Sagebrush's time goes to running mpmath's Python code for each small operation, not to big-number arithmetic. So the first phase moves mpmath's number type and basic arithmetic into the core; just making the integers faster would not be enough.
- There are five shipping phases (numbered 1, 3, 4, 5 and 6) after a measurement spike (Phase 0, done). Each has its own speed target, its own size budget, its oracle and its way back. The spike showed that the win comes from a native number type, not from replacing mpmath's arithmetic functions alone, so the first shipping phase is the native type with its arithmetic and elementary functions (r5: the former Phases 1 and 2, merged).
- SymPy's API on the same core is the long-term plan. Its design waits until the mpmath phases have real numbers.

---

## 1. William's decision (Nov 9, 2026, 11:55 AM PST)

> "I think we definitely need to do a rewrite of mpmath ... The philosophy that makes sagebrush stay small is NOT having any overlapping code at all -- only one thing we ship should implement '30x30 matrix inverse, dps=30', not 20 things."

The goals: "(1) don't allow duplication of code, and (2) try to BEAT mpmath." On SymPy: "We will likely eventually do the same with sympy, so we might as well plan that from the start ... we reimplement the same api ... longterm plan."

The approved route, as relayed by @sagebrush:
1. A Rust/wasm big-float core behind mpmath's own backend hook, with mpmath's API and test suite as the oracle.
2. Then the hot paths move into Rust, phase by phase: elementary functions, hypergeometric series, quadrature, zeta, matrices.
3. The end state is a full Rust-backed mpmath API, which the SymPy-API work and Sage mode build on.

## 2. What the measurements say

### 2.1 The baseline

The baseline report is `/scratch/wake/mpmath-perf-2026-11-09.md`. It ran `bench/mpmath/perf.py`, best of 3, on a loaded 16-core machine, so read every ratio as plus or minus 20%. All times are in seconds.

| Benchmark | CPython + gmpy | CPython, no gmpy | Sagebrush (Node) | Pyodide (Chromium) |
|---|---:|---:|---:|---:|
| arith loop, dps=15 (60k ops) | 0.068 | 0.089 | 0.303 | 0.214 |
| complex loop, dps=15 (20k ops) | 0.034 | 0.050 | 0.127 | 0.101 |
| `fp.sin`/`fp.exp` loop (20k) | 0.0067 | 0.0067 | 0.050 | 0.027 |
| pi, 100k digits | 0.033 | 0.199 | 0.062 | 0.392 |
| sqrt(2), 100k digits | 0.0024 | 0.029 | 0.011 | 0.053 |
| zeta(3), 1000 digits | 0.0032 | 0.0045 | 0.0068 | 0.0085 |
| gamma(1/3), 1000 digits | 0.68 | 2.64 | 1.27 | 4.39 |
| quad e^(-x^2) over R, dps=50 | 0.040 | 0.043 | 0.289 | 0.132 |
| zetazero(100) | 0.104 | 0.132 | 1.14 | 0.262 |
| hyp2f1, dps=30 (200 calls) | 0.015 | 0.014 | 0.103 | 0.038 |
| 30x30 matrix inverse, dps=30 | 0.100 | 0.108 | 0.775 | 0.338 |
| **total** | **1.31** | **3.64** | **5.25** | **6.82** |

On mpmath's own test suite (`bench/mpmath/compare.py`, no gmpy), Sagebrush passes 339 of 339 tests and CPython 338. The time inside the tests is 216.0 s on Sagebrush against 56.1 s on CPython.

### 2.2 Cost per operation

I measured this for this design with `/scratch/sage2-notes/mpcore/xcost.py`: best of 5, at dps=15, using Sagebrush at master d34023b8 plus #922, and the oracle's CPython 3.14 with mpmath. All times are in microseconds per operation.

| Operation | CPython, gmpy | CPython, no gmpy | Sagebrush |
|---|---:|---:|---:|
| `mpf + mpf` | 0.98 | 1.49 | 6.18 |
| `mpf * mpf` | 0.84 | 0.97 | 3.74 |
| one engine call through `sagebrush._engine.call` (`ball_log`, 64 bits) | | | 51.7 |

### 2.3 What follows

1. **Sagebrush's big integers are already fast.** On the big-number rows (pi, sqrt, gamma at 1000 digits), Sagebrush beats Pyodide by 3 to 6 times, because V8's BigInt beats CPython's integers compiled to WebAssembly.
2. **The loss is in the many small operations**: arithmetic loops, quadrature, zeta zeros, hypergeometric series and matrices. One `mpf + mpf` runs several of mpmath's Python functions (the `mpf` type's `__add__`, `mpf_add`, `normalize` or `from_man_exp`, and object creation), and each of those lines costs more in pyjs than in CPython.
3. **A gmpy-shaped backend alone would not close this gap.** mpmath's gmpy hook replaces the integer type and two helpers (`_mpmath_normalize`, `_mpmath_create`). The rest of each operation would still be interpreted Python. The hook that matters is the deeper one mpmath already has for Sage (§4.3). It replaces the number types, the context, the arithmetic, the elementary functions and the hypergeometric summation, and it is the hook Sage itself uses.
4. **The engine's JSON call path cannot carry per-operation traffic.** At 51.7 microseconds a call (an upper bound for the crossing, since it includes a small 64-bit computation), it costs about 8 times a whole interpreted `mpf + mpf`. The per-operation binding has to be a direct WebAssembly call with no JSON, the way `src/runtime/kernels.ts` calls the numeric kernels. Whether that crossing is cheap enough is what Phase 0 measures (§6).

## 3. The rule: one implementation per precision tier

"No overlapping code" has to mean the same operation at the same tier. Different tiers need different algorithms:

| Tier | What it is | Accuracy contract | Who uses it |
|---|---|---|---|
| **F64** | machine doubles | about 1 ulp, or correctly rounded where documented | numpy, scipy, MATLAB mode, Sage's RDF/CDF, `mpmath.fp` |
| **MP** | arbitrary-precision floating point, m * 2^e | mpmath's: correctly rounded `+ - * / sqrt`; functions accurate to the working precision, using guard bits | mpmath, SymPy's evalf later |
| **CR** | arbitrary precision, correctly rounded | the exact value rounded in the requested direction (MPFR's semantics) | Sage's `RealField` and `ComplexField` |
| **BALL** | rigorous enclosures, mid +- rad | the true value is always inside | Sage's `RealIntervalField`, the engines' certificates, mpmath's `iv` |

**One core serves MP, CR and BALL.** Each function in the core is one kernel that returns a value together with a proven error bound:
- MP uses the value directly, as mpmath does today.
- CR runs Ziv's strategy over the same kernel: retry at higher precision until the bound shows the result rounds unambiguously. `lib/_sage_real.py` already does this in Python, in `_ziv_eval`.
- BALL takes the value plus the bound as the radius.

So there is one exp and one zeta at multiprecision, behind three policies. Matrices are different (see the table below). The F64 tier stays separate. A 53-bit evaluation through a big-float core costs many times what a tuned double-precision kernel costs (Phase 0 measures the factor for exp and gamma), and SciPy and MATLAB users would pay for that on every call.

**Rigorous bounds come per function, not all at once.** mpmath's algorithms carry heuristic error estimates, not proofs. A kernel can serve MP before its bound is proven. It serves CR and BALL only once the bound is proven, with the proof cited in its doc comment. That proof is what lets Sage's and the ball code's own copies be deleted.

**The ball contract for basic operations.** Balls `a +- r` and `b +- s` (midpoints exact dyadics, radii upper bounds) give these results. `e` is the rounding error of computing the midpoint, rounded upward into the radius.
- `+` and `-`: midpoint `a +- b`, radius `r + s + e`.
- `*`: midpoint `a*b`, radius `|a| s + |b| r + r s + e`.
- `/`: defined only when the divisor's ball excludes 0. Then the midpoint is `a/b` and the radius is `(|a| s + |b| r) / (|b| (|b| - s)) + e`. A divisor ball containing 0 is refused, as `engine/ball` refuses it today (`None`).
- `sqrt`: for a ball inside `[0, inf)`, the midpoint is `sqrt(a)` and the radius is `r / (sqrt(a - r) + sqrt(a)) + e`. A ball containing 0 with a nonnegative midpoint gives `[0 +- sqrt(a + r)]`, as today. A negative midpoint is refused, as today.

Every result's radius is rounded upward. The domain rules match what `engine/ball` and `RealIntervalField` do today, and each consumer's current behaviour is pinned before its implementation is deleted. Sage's `RealIntervalField` keeps Sage's own semantics (endpoints, and what it does at a domain edge), checked against the Sage oracle. The formulas are the standard ones of midpoint-radius arithmetic, taken from the literature (§8). They are proved in the kernel's doc comments and pinned at their worst cases by tests (§6.1, point 5).

**Who owns what, per operation:**

| Operation | MP | CR | BALL | Condition |
|---|---|---|---|---|
| `+ - * /`, `sqrt`, conversions | core | core (correctly rounded by construction) | core, under the ball contract below | none |
| Elementary and special functions of one scalar | core kernel | the same kernel under Ziv | the same kernel: value at the midpoint, plus the truncation bound, plus the radius times a proven bound on the derivative over the ball (the way `engine/ball`'s functions work today) | CR and BALL only once the function's bound is proven and cited; until then the old implementation keeps that policy, as listed in the ledger (§6.2) |
| Dense LU, solve, inverse, determinant, QR, eigenproblems, SVD | core, with mpmath's semantics | **none**: there is no correctly rounded contract for these. Sage's matrices over `RealField` and `ComplexField` keep Sage's generic field algorithms (`lib/_sage_matrix*.py`, shared with every other field), running on the core's CR scalars. They have no numeric code of their own, so nothing overlaps | **none** today. A future ball linear algebra is its own design, with a verification method from the literature (Rump's, for example), never a point LU plus a scalar radius | — |
| Quadrature, summation, extrapolation, root finding | core for the callback-free parts (§4.6); mpmath's Python for the loops that call user functions | none | none | — |

## 4. The layers

### 4.1 L0: the Rust crate `sagebrush-mp` (`engine/mp`)

The crate is MIT OR Apache-2.0, like the other engine crates. It has no C dependencies, and the same Rust runs in the browser's WebAssembly, natively and in the Node CLI. It owns:
- **The number type and its arithmetic:**
  - mantissa and exponent on `sagebrush-bigint`, with a **kernel fast path** for mantissas up to 64 bits (inside the core's arithmetic; not to be confused with the hybrid number's storage edge at 2^53, §4.6), and the **limb path** above it;
  - the five rounding modes;
  - correctly rounded `add sub mul div sqrt`, plus `pow_int`, `ldexp` and conversions;
  - the text conversions that mpmath and Sage need, with exactly mpmath's digit rules.
- **Fixed-point kernels and constants:** pi, e, log 2, Euler's gamma and Catalan's constant, each cached per precision; exp, log, cos/sin, atan, and the hyperbolic and inverse functions.
- **Series:** the generalized hypergeometric summation (`hypsum`), Bernoulli numbers, gamma, log-gamma, zeta, Hurwitz zeta, polylog, and the Riemann-Siegel machinery behind `zetazero` and `siegelz`.
- **Calculus, the callback-free parts only (§4.6):** quadrature nodes and weights (tanh-sinh and Gauss-Legendre, cached per degree and precision), weighted sums of values already computed, and extrapolation tables. Every loop that calls user code, including quadrature's levels, `findroot`'s iterations and `nsum`'s term loops, stays in mpmath's Python.
- **Dense matrices:** LU, QR, the symmetric and general eigenproblems, SVD and inverse, at MP precision.
- **Error bounds:** for every kernel that has a proof, and the CR and BALL policies over those kernels (§3).
- **Interrupt and limits:** every loop that can run long polls the engines' interrupt flag (`engine/interrupt`) and honours the session's limits. `mp.dps = 10**7` must stay stoppable.

It owns no Python semantics: no exceptions, no printing conventions and no object model.

### 4.2 L1: the bindings

- **pyjs (browser and CLI):** direct WebAssembly exports, with numbers handed over as i64 or as limbs in linear memory, never JSON. This follows the precedent of `src/runtime/kernels.ts`. The ABI is chosen by measurement in Phase 0 (§6).
- **Native CPython** (the native app and the engine's Python package): the same crate behind `sagebrush._native`, through a raw function table rather than `_engine.call`'s JSON.

### 4.3 L2: the mpmath API

**Phases 1 to 5: the pinned mpmath 1.3.0 wheel, unchanged, on a new backend.** mpmath's `libmp/backend.py` selects a backend once, at import time. The `'sage'` branch replaces these:
- **`ctx_mp`:** the `Context` base class, which is mpmath's `PythonMPContext`, with the `mpf` and `mpc` types.
- **`libmpf`:** `mpf_add`, `mpf_sub`, `mpf_mul`, `mpf_div` and `mpf_sqrt`, plus `normalize` and `from_man_exp`.
- **`libelefun`:** `mpf_exp`, `mpf_log`, `mpf_cos`, `mpf_sin`, `mpf_pow`, `exp_fixed`, `cos_sin_fixed` and `log_int_fixed`.
- **`libmpc`:** `mpc_exp` and `mpc_sqrt`.
- **`libhyper`:** `hypsum_internal`.
- **`libintmath`:** `bitcount`, `isqrt`, `sqrtrem` and `ifac`.

Our backend supplies those same names, with the semantics mpmath's own pure-Python versions define. Those versions are BSD-licensed and are the specification; Sage's implementation of this hook is never read (§8).

It also supplies three that Sage's branch doesn't: `libmpc`'s `mpc_mul`, `mpc_div` and `mpc_abs`, in the same `'sagebrush'` branch. Each builds its result from exact products (`mpf_mul` at precision 0) that it then rounds once. Through the hooks alone, each exact product crossed into Python as an int and back, and complex arithmetic was slower than on the Python backend: mpmath's own `test_polyroots_legendre` took 102 s against 28 s (Nov 10, one run each, the machine shared). In the core, the products never leave it: 17.1 s against 26.1 s.

Every other mpmath module stays the upstream Python, now running on fast primitives. Keeping the raw-tuple `libmp` functions (`mpf_add(s, t, prec, rnd)`) matters beyond mpmath itself: SymPy's evalf calls them directly.

**How the wheel finds the backend: an overlay under a Sagebrush namespace (O1, recommended by SEC).** `BACKEND == 'sage'` guards, with direct `sage.libs.mpmath` imports, appear in seven files: `libmp/backend.py`, `ctx_mp.py`, `libmp/libmpf.py`, `libmp/libelefun.py`, `libmp/libmpc.py`, `libmp/libhyper.py` and `libmp/libintmath.py`. So a branch in `backend.py` alone would not be a complete integration. The overlay:
- **Surface.** Each of the seven files gets a `BACKEND == 'sagebrush'` branch next to its `'sage'` one. That branch imports the same names from a Sagebrush-owned module, `_sagebrush_mpcore`, and touches nothing else. The overlay is a patch file pinned next to the wheel. Its complete list of hunks is part of the Phase 1 PR, so that SEC and python can audit it line by line.
- **Hashes.** Three sets are recorded: the wheel's file hashes (already pinned by the curated-package mechanism), the patch's hash, and the hash of each patched result file. The build applies the patch only to exactly those wheel bytes and checks the results. A different wheel, or a patch that applies with fuzz, fails the build.
- **Strict selection.** The backend is chosen once, at the first `import mpmath` in a fresh interpreter. It never changes within a session, so objects from two backends never mix. After selection, a check confirms that `BACKEND == 'sagebrush'` and that every replaced name is `_sagebrush_mpcore`'s: a partial integration is an import error.
- **No silent fallback.** If the core can't load, `import mpmath` raises. A limit or an error inside the core raises to the caller. Neither falls back to the Python backend. Only the explicit rollback setting (§6) selects the Python backend. It takes effect in a fresh session, never by a retry inside a running one, and never after a resource, cancellation or numerical failure.
- **No impersonation.** Nothing is registered as `gmpy2`, `gmpy` or `sage.*`. Doing so would make `import gmpy2` succeed in user code with a partial API, poison other packages' feature probes, and make the system misreport what it runs. A test asserts that `import gmpy2` and `import sage` still raise ImportError, and that `mpmath.libmp.BACKEND` reports `'sagebrush'`.
- **The backend value is `'sagebrush'`, never `'sage'`.** `backend.py` reads `SAGEBRUSH_MPMATH_BACKEND` once, at first import. It defaults to `sagebrush`; `python` is the rollback. An unknown value raises at import, never falling through to `python`. The session option (§6) sets the same value before the first import, and the Phase 1 PR names where that option lives. The gmpy branches stay untouched and never run, because pyjs has no gmpy.
- **Mantissas stay Python ints.** The `'sage'` branch also sets `MPZ = sage.Integer`, and the pickling helpers branch on it. The `'sagebrush'` branch leaves `MPZ = int`, so `MPZ_TYPE` is `int`. That keeps `mpf.man`, the raw tuples' mantissas, pickles and `isinstance(man, int)` exactly as upstream's python backend has them, which SymPy's evalf, user code and §6.1's tuple comparator rely on. Pickles made in Sagebrush must load in CPython's mpmath 1.3.0, and the other way round; the merged Phase 1's conformance list (§4.6) checks both directions.
- **What ships is the effective source.** pypi-import applies the patch when the package is imported into the tree (`packages/pypi-mpmath/py`) and records the three hash sets, and `--check` re-derives them. The runtime never patches anything. Whether the patch file itself ships is a size question (python's view: it doesn't need to).
- **Where the ABI comes from.** The ABI that `_sagebrush_mpcore` implements is derived only from mpmath's own BSD-licensed call sites in these branches and its pure-Python reference functions. Sage's `sage/libs/mpmath` (GPL) is never read for signatures or semantics; Sage is a black-box oracle only.
- **Ownership.** python's lane owns the overlay mechanism as a Phase 0/1 deliverable: the patch file, the wheel, patch and effective-source hashes, `pypi-import --check`, failing closed (@sagebrush's ruling). The patch lives in `packages/pypi-mpmath/` next to the wheel pin, and its hashes are recorded in the package's `sagebrush.json`. A new upstream version means the patch is reviewed again, never applied with fuzz.
- **The Core API surface** (`scripts/core-api-surface.mjs`) records mpmath's public names before and after every phase. No name is lost without a stated divergence.
- **Phases 1 to 5 ship upstream's code plus the overlay, nothing else.** No upstream file is edited beyond its hook branches. The rewrite replaces modules wholesale in Phase 6, which deletes the wheel bytes and the overlay in the same PR.

@sagebrush ruled O1 this way (Nov 9): a pinned overlay and adaptor under a Sagebrush-owned namespace, with no impersonation, covering the full cross-module hook surface. SEC (MPC940-1), python and ENGINE each confirmed the seven-file surface from the pinned source.

**Phase 6 on: our own `mpmath` module.** The pinned wheel is retired. The high-level Python (the functions, calculus and matrices modules that remain Python) becomes a Sagebrush module, ported from mpmath with its BSD notice kept. It has the same names, signatures and behaviour, the same `mp`/`fp`/`iv` contexts, and the same docstrings (`function_docs`). The upstream suite still runs against it unchanged.

### 4.5 The binding's resource contract (SEC invariants, required before any phase ships)

The exact ABI and the numeric thresholds are Phase 0 decisions. These invariants are not; every shipping phase must meet them:
1. **Sizes are checked before allocation.** Precision, exponent, matrix dimension and limb count are each checked against the session's limits, and the arithmetic that sizes a buffer is checked for overflow, before anything is allocated. A request over a limit is refused with the limits' usual error.
2. **Every allocation is charged and bounded.** WebAssembly linear memory, native heap and retained caches (constants per precision, quadrature nodes, Bernoulli numbers) are charged to the session's memory accounting. Each cache is per session, with a stated bound and an eviction rule.
3. **Ownership: the core holds no number between calls** (the JS-resident limbs, @sagebrush's ruling, Nov 10). There are no handles, so nothing can be stale or forged.
   - A big number's limbs live in the JavaScript heap, in a plain array of 32-bit words (each an exact JavaScript number) owned by its `mpf` object: ordinary garbage-collected storage, with no `ArrayBuffer` backing store. They go with that object when it is collected, as a Python int's digits do. The `_mpf_` tuple, once made, is kept on the same object. The core's memory never holds a session value, only its caches.
   - **Retained memory.** A number of n limbs holds 2n words (about 16n bytes of elements) and, once `_mpf_` is read, its int (about 8n). In sampled workloads (the live heap per value after a full collection, at dps 30 and 1000), it was 1.7 to 2.2 times the python backend's storage with the limbs alone, and 2.5 to 3.2 times once `_mpf_` was read (dps 30: 187 B against 314 and up to 514 B; dps 1000: about 590 B against 1,300 and up to 1,905 B). These are measured ratios, not a bound, and retained payload, not a cap on a call. Retained values are in the same regime as every other Python value: the host's garbage-collected heap, with no counter of their own (SEC's ruling, Nov 10).
   - **Every copy in the JavaScript heap is admitted before anything is made.** The limb count is checked against the per-number limit (2^22 limbs: a 32 MiB payload), then the copy's peak against the session's heap limit, as `format.ts`'s `admitDigits` admits an int's conversion to text. The peaks, in bytes, for n limbs:
     - a result copied out: 24n (the words, and the growth of the array they are pushed into);
     - an int's limbs (`wordsOf`): 40n (its hex text, 16n, and the words, up to 24n while their store changes kind). The length comes from the int's bit length, taken with small copies, before any text is made;
     - an int made from limbs (`manOf`, for `_mpf_` and the `libmp` functions' results): 40n (the digits as bytes, 16n, their text, 16n, and the int, 8n).
     These are estimates from each copy's allocations. Sampled runs (each copy alone, in an old space of the live heap plus its estimate) completed; that is operational support, not a high-water proof, since young-generation room and transient external buffers aren't measured.
   - **The known gap.** This admission compares a peak with the whole limit, not with the heap that is free. When the heap is already partly full, an admitted conversion can still exhaust it, and the host stops the session. Converting an int to text has the same gap today. SEC accepted it for Phase 1 as a documented, temporary risk. One shared fix, admission against the free heap in `src/runtime/heap.ts`, comes in its own runtime PR for every caller (#956).
   - **Stop.** The word loops test for Stop every 65,536 words. A single native conversion (`toString(16)`, `BigInt` of hex text) can't be interrupted, but it is linear in the number's size and is admitted first.
   - **Every operand that crosses is validated by the core before use.** Its span must lie inside the IO buffer, and its limbs must be normalized (the top limb non-zero, the count exact). `bc` must equal the mantissa's bit length, the exponent must be exact, and the sign must be 0 or 1. A malformed operand (wrong length, a `bc` that disagrees, a zero top limb) is refused, never read.
   - **Copy-out makes a fresh array**, so no view of the core's memory stays reachable.
   - **The core's memory**, including its caches and the IO buffer, is bounded at its source by engine/wasmheap's page bound (1 GiB). Copies into it are checked against that bound before the buffer grows.
4. **Cancellation everywhere.** The interrupt flag is polled in every loop that can run long. That includes conversions (text to number at a million digits), series summation, quadrature and Ziv's retries in the CR policy. Cancellation also reaches the long loops that stay in Python: hypsum's retries at higher working precision go through the same interrupt check.
5. **Cleanup.** On cancellation, on error and at session end, everything the core allocated for the call or the session is released, and no partial result is left reachable. In the binding, an `mpf` is made only after its call has succeeded. A refusal, a Stop or a trap raises before any result object exists, and a trap retires the core's instance.

These invariants get tests in the same PR as the code they govern: a refusal at each limit, a malformed limb array, a cancelled or refused large copy, the session used again after an error, a cancelled conversion and a cancelled Ziv retry. Each limit is registered in the limits census.

### 4.6 The boundary between Python and Rust, phase by phase

Results stay bit-identical (§6) because each phase moves only code whose observable contract can be stated and tested exactly:
- **Phase 1 (merged in r5), part 1: `libmp` functions, one for one.** Same names, signatures, raw-tuple arguments and return values, rounding modes, and exceptions (types and messages). Their Python callers don't change.
- **Phase 1 (merged in r5), part 2: the context and the `mpf` and `mpc` types.**
  - The contract is `PythonMPContext`'s observable behaviour: the attributes (`_mpf_`, `_mpc_`, `man`, `exp`, `real`, `imag` and the rest), and the precision and rounding read from the context at each operation.
  - Every result has the same type (`mpf`, `mpc`, `constant`, or `NotImplemented` for foreign operands), and errors raise the same exceptions.
  - Pickling, hashing (equal hashes with equal `int`, `float` and `Fraction` values), and comparison with other types all behave the same.
  - A conformance list generated from `ctx_mp_python`'s public surface is checked alongside the suite. It gates the merged Phase 1; it isn't deferred.
  - **The hybrid number (Phase 0's finding).** The predicate is on the raw tuple's mantissa, which is unsigned (the sign is the tuple's separate `sign`, and `mpf.man` is `_mpf_[1]`): a number with `0 <= man < 2^53` is held inline, as its raw tuple of exact JavaScript numbers. One with `man >= 2^53` keeps its mantissa JavaScript-side as packed limbs (a plain array of 32-bit words, two to each 64-bit limb, little-endian), with its sign, exponent and `bc`. Each operation copies its operands' limbs into the core and the result's limbs out (§4.5): the JS-resident limbs of @sagebrush's ruling (Nov 10), which replaced Phase 0's core-resident handles. The sign never decides the storage, and the fuzzer pins both signs at mantissas 2^53 - 1, 2^53 and 2^53 + 1 (§6.1). Storage is never observable (python's R1):
    - every observable value (`mpf.man`, `._mpf_`, `mpc._mpc_`, the `libmp` raw tuples, pickles) is a plain Python `int` tuple, identical to the python backend's;
    - `type(x.man) is int`;
    - `x._mpf_ is x._mpf_` holds, as upstream's: the tuple is materialized once per object and kept.
- **Phase 3: `hypsum_internal`.** It is pure numerics, with no callbacks. It replaces the summators that `libhyper` generates, one for one: the same arguments, the same `(result, magnitude)` and the same `NoConvergence`.
- **Phase 4: calculus.** User functions are callbacks, so **every loop that calls user code stays in mpmath's Python**. That covers quadrature's levels and intervals, `findroot`'s iterations, and `nsum`'s and `nprod`'s term loops. They call `f` at the same points, in the same order, under the same precision context, and exceptions propagate unchanged. The core takes only the callback-free parts:
  - tanh-sinh and Gauss-Legendre nodes and weights;
  - the weighted sums of values already computed (`fdot`, `fsum`);
  - the extrapolation tables (Richardson, Shanks, Levin) over numeric sequences.

  The core is never re-entered from a callback in the middle of a kernel. `findroot` moves nothing into the core and gets faster from Phase 1 alone.
- **Phase 5: matrices.** There are no callbacks.
  - **The kernel's job.** The kernel takes a dense snapshot of a matrix's entries as raw tuples. It runs the same sequence of operations, in the same order and at the same working precision, as mpmath's Python, operation for operation (the precedent is `kernels/src/eigen.rs`), and returns tuples.
  - **What stays in mpmath's Python.** The wrappers keep their signatures, the `_LU` cache, and the exact exceptions, such as `ZeroDivisionError('matrix is numerically singular')`.
  - **Singular and ill-conditioned matrices.** These behave exactly as upstream does. The kernel runs mpmath's own pivot and singularity tests in mpmath's order and adds no conditioning checks of its own, and the fuzzer includes singular and nearly singular inputs.
- **Interrupts.** Upstream mpmath checks for no interrupts. The core polls the interrupt flag at least every 2^16 basic operations and between the rows of a matrix kernel. Stop surfaces as a `KeyboardInterrupt`, the same as in the Python loops, and is pinned with the Stop seam (§6.1).

### 4.4 L3: SymPy's API (later; a design of its own)

SymPy's numerics reach mpmath through `mpmath.libmp`'s raw functions and the `mpf` and `mpc` types. Keeping those names stable from Phase 1 on is the only obligation this design places on the SymPy work. Whether to reimplement SymPy's API on Sage mode's symbolic engine (`engine/sym`) is a separate design. It is gated on Phases 1 to 5 meeting their numbers (§6).

## 5. The inventory: everything that overlaps, and where it lands

"Deleted" means removed from the tree in that phase's PR, with the size gate showing the reduction.

### 5.1 The multiprecision tiers (MP, CR, BALL): all land in `engine/mp`

| Today | Size | Tier | Lands in the core as | Deleted |
|---|---|---|---|---|
| mpmath `libmp/` (`libmpf`, `libmpc`, `libelefun`, `libintmath`, `gammazeta`, `libhyper`, `libmpi`) | 8,705 lines of Python | MP, interval | number type, arithmetic and elementary functions (`libmpf`, `libmpc`, `libelefun`, `libintmath`) in Phase 1; series, gamma and zeta (`libhyper`, `gammazeta`) in Phase 3; intervals (`libmpi`) in Phase 6 | each module's backend branches stop running in its phase (the Python stays as the rollback path); the modules leave the tree in Phase 6 |
| mpmath `ctx_mp_python.py` (`mpf`, `mpc`, `PythonMPContext`) | 1,149 lines | MP | the native `Context` (Phase 1, merged in r5) | Phase 6 |
| mpmath `calculus/`, `matrices/`, `functions/` | 6,711 + 5,012 + 10,652 lines | MP | inner loops in Phases 3 to 5; the rest is ported as our Python API in Phase 6 | the duplicated loops leave the tree in Phase 6 |
| `lib/_sage_real.py`: `RealField`, `ComplexField`, `RealIntervalField`, `N()` | 4,927 lines in all, including about 330 of fixed-point elementary functions and constants, 130 of gamma, 200 of rounding, and 1,415 in the `RealNumberMP` class | CR, BALL | Sage's elements wrap the core's number type; their functions use the CR policy (Ziv) over the core's kernels | Phase 3: the fixed-point functions, gamma, Bernoulli, the rounding helpers, and the arithmetic inside `RealNumberMP`. Sage's printing, parsing and coercion stay, because they are Sage semantics, not numerics |
| `engine/ball` (`Ball`, `Mag`, ball elementary functions, Li2, Ti2, Bernoulli) | 2,149 lines of Rust | BALL | the core's BALL policy; the dilogarithm and inverse tangent integral become core kernels with proven bounds | Phase 6, once `engine/ap`'s heights and the certificates call the core |
| Sage's matrices over `RealField` and `ComplexField` (`lib/_sage_matrix*.py`) | generic field algorithms | CR scalars | not moved: generic field algorithms over the core's CR scalars (§3's table) | their scalar arithmetic goes with `RealNumberMP`'s in Phase 3; the algorithms are shared with every field, so nothing overlaps |
| Magma mode's reals: `MReal`, `RealField_` and `Exp`, `Log`, `Pi`, `Sqrt` (`lib/_magma.py`), in Fraction arithmetic with decimal precision | about 290 lines | MP | Magma's real elements wrap the core's number type; the functions call the core's kernels. Magma's printing and its decimal-precision rules stay, checked against the Magma oracle (`/usr/local/bin/magma -b`) | Phase 3, with Sage's |
| `lib/_sage_ec.py`'s `_real_root_fixed` (200-bit fixed-point real roots of the 2-torsion cubic, with `_real_roots_fixed`) | about 50 lines | MP, specific to elliptic curves | not moved: its algorithm is specific to elliptic curves. Its arithmetic becomes calls into the core | retained |
| `engine/ap`'s heights (`height.rs`: bisection on balls) | callers | BALL | not moved: they are callers of the ball arithmetic and switch to the core's BALL policy | their imports change in Phase 6 |

**Gains Sage gets on the way:** today `zeta(3).n(100)` stops with "NotImplementedError: zeta at more than 53 bits is not available in sagebrush yet". The same is true of every special function except gamma and log_gamma. Phase 3 makes these work, checked against the Sage oracle. That brings the zeta and prime-counting pins at high precision within reach.

### 5.2 The F64 tier: not merged into the core

These are each the one F64 implementation of their function, and they stay. Their algorithms are tuned to doubles.

| Today | Size | Stays as |
|---|---|---|
| `lib/_special.py` and `lib/_special_ibeta.py` (gamma, psi, zeta, erf, Bessel, elliptic and others, in double precision) | 3,926 + 556 lines | the F64 special functions for scipy.special, MATLAB mode (`lib/_matlab_special.py` is a thin wrapper) and Sage's RDF |
| `scipy.integrate` (QUADPACK-shaped `quad`, the RK and DOP853 solvers), `scipy.optimize` | 1,927 + 2,463 lines | the F64 quadrature, root finding and ODE solvers |
| `engine/sym` `num.rs` and `eval.rs` | 1,052 lines of Rust | symbolic expressions' 53-bit numbers. `special.rs` holds symbolic canonical forms, not numerics, so it does not overlap |
| MATLAB's function functions (`lib/_matlab_funfun.py`: `fzero`, `fminbnd`, `fminsearch`, `quad`, `integral`, `quadgk`, `integral2`, `integral3`) | 1,633 lines | MATLAB's documented algorithms and outputs (such as `quad`'s adaptive Simpson after Gander and Gautschi, and its function-evaluation counts), owned by MATLAB mode |
| MATLAB's linear algebra that calls `numpy.linalg` (`lib/_matlab.py`'s `eig`, `svd`, `qr`, `chol`, `inv`, `pinv`, and `det` for complex matrices) | callers | not an implementation: these call `numpy.linalg`, the F64 tier's one linear algebra |
| MATLAB's own factorizations in `lib/_matlab.py`: `_lu_factors`, `_tri_solve`, `_lu_solve_through`, `_solve`, `_rcond_estimate`, the Householder `_qr_solve` with column pivoting, `lu_`, and `det_`'s own elimination for real matrices | about 315 lines | a second F64 LU and QR, kept for MATLAB's documented outputs: `mldivide`'s basic solution for rank-deficient systems, its singular and badly-scaled warnings with the `rcond` estimate, and `lu`'s output forms. Owned by MATLAB mode, and listed in §5.3's F64 ledger |
| Sage's `numerical_integral` (Gauss-Kronrod 7-15, adaptive) and `find_root` (Brent) in `lib/_sage_expr.py` | about 150 lines | Sage's documented F64 behaviour and outputs, owned by Sage mode |
| `lib/_sage_ec.py`'s `_integrate` (adaptive Gauss-Legendre), `_agm`, `real_period` and `_periods` in doubles | about 70 lines | specific to elliptic curves, in F64 |
| `kernels/` (F64 kernels over arrays) | about 2,850 lines of Rust | the F64 tier's WebAssembly; see §5.3 |

**Magma mode, in short.** Its reals are an MP implementation of their own and fold into the core (§5.1). Everything else numeric in Magma mode already calls the shared Sage and F64 code.

**One rule applies across tiers:** the MP core is never the test oracle for the F64 code. `lib/_special.py`'s accuracy claims stay measured against upstream mpmath on CPython. Measuring it against our own core would make the oracle depend on the code under test.

### 5.3 Duplication found inside the F64 tier: out of scope here, listed so it isn't lost

These are not this design's work, and they need a ruling of their own:
- **Dense linear algebra exists three times:**
  - `src/runtime/numpy_linalg.ts` (1,561 lines);
  - its operation-for-operation twin `kernels/src/eigen.rs` (1,241 lines), kept so that results are identical with and without WebAssembly;
  - `engine/nd`'s LU and Cholesky (5,408 lines in the crate).
- **Elementary functions exist three times, with three different contracts:**
  - `src/runtime/fdlibm.ts` gives the same bits in every JavaScript engine, for TimeTravel replay;
  - `src/runtime/crmath.ts` is correctly rounded;
  - `src/runtime/libm.ts` with `kernels/src/libm.rs` matches glibc, as CPython does.

  The contracts differ, but some call sites could share one.
- **F64 LU and QR exist a fourth time,** in MATLAB mode's own factorizations (§5.2). The F64 design decides whether they become MATLAB front ends over `numpy.linalg`'s factorizations, keeping MATLAB's outputs, warnings and pivot choices, which are pinned first, or stay as they are.
- **F64 quadrature exists four times:** `scipy.integrate.quad` (QUADPACK-shaped), MATLAB's `quad` and `quadgk`, Sage's `numerical_integral`, and `_sage_ec._integrate`. **Brent's method exists three times:** `scipy.optimize` (and `scipy.integrate`'s private `_brentq`), MATLAB's `fzero` and Sage's `find_root`.
  - Each system's documented outputs (error estimates, evaluation counts, warnings) must stay its own.
  - The shared rule tables and the iteration step could be one implementation under three front ends.

I propose a separate, short "F64 tier" design. William's O2 decision (§10) settles its main question: the no-WebAssembly fallback (`SAGEBRUSH_NO_WASM`) isn't needed, so each twin can go.

## 6. Phases

Every phase has these, in addition to its own targets:
- **Its oracle:**
  - mpmath's upstream suite, unchanged: 339/339 in `bench/mpmath/compare.py` and the curated package's `pypi-tests/mpmath`;
  - `bench/mpmath/perf.py`'s result checksums, identical to CPython's (hashes of the raw tuples, §6.1);
  - from Phase 3 on, Sage pins recorded from the Sage oracle (`/scratch/sage-oracle/sage/sage`), including the zeta and prime-counting pins at high precision.
- **Bit-identical results:** through Phase 5, every result is bit for bit what upstream mpmath gives on CPython with the python backend. The kernels port mpmath's algorithms, and the suite and doctests stay exactly as they are. A faster algorithm that changes last bits is a separate, explicitly reviewed PR after Phase 5.
- **A differential fuzzer:** specified in §6.1.
- **A rollback:** through Phase 5, a setting (`SAGEBRUSH_MPMATH_BACKEND=python`, plus a session option) selects upstream's pure-Python backend, which is still in the tree. Reverting a phase's PR also restores the previous state.
- **A size budget:** §6.2, with lazy loading as the rule. The core's WebAssembly loads on first `import mpmath` (or the first Sage `RealField` above 53 bits), never with the worker.
- **Speed, import and memory targets:** measured with the protocol in §6.3, in Node and in Chromium. Chromium is the comparison that matters against Pyodide.

| Phase | What | Targets: ratios of medians to a named paired baseline (§6.3): `SB` is Sagebrush at the phase's base master, `CG` is CPython 3.14 with mpmath 1.3.0 and gmpy, `PY` is Pyodide; seconds from the Nov 9 report only for orientation | Size budget | Go / kill |
|---|---|---|---|---|
| **0. Spike** (nothing ships; done, §6.4) | The crate's skeleton with `mpf_add`/`mpf_mul`, and three bindings measured on the per-operation microbenchmark: (i) direct wasm exports with an i64 fast path and limbs in memory; (ii) handles to wasm-resident numbers; (iii) today. The benchmark harness's browser driver is repaired, so that Sagebrush has a Chromium column next to Pyodide's. | Small operations: `mpf + mpf` and `mpf * mpf` at dps 15 and 30, called from mpmath's Python, at most 1.5 microseconds each, absolute (today 6.18 and 3.74 at dps 15), in Node **and** in Chromium. The high-precision multiply at dps 1000 (limbs) has its own gate: at most 1.25 times paired CPython + gmpy's median (about 2.48 microseconds there) and at most 1.0 times paired Sagebrush's. Every case includes allocation, handle lifetime and the transfer of operands and results | none shipped | Two separate gates. **Small operations (dps 15 and 30) gate Phase 1:** at most 1.5 microseconds is GO; between 1.5 and 2.5, **redesign**, and no Phase 1 ships; above 2.5, the per-operation WebAssembly approach is killed (§7, risk 1). **The dps 1000 multiply gates Phase 3 only:** failing it means **redesign** of the limb path, which must pass before Phase 3 starts (§6.4); it doesn't block Phase 1. Outcome (§6.4): small operations GO; the dps 1000 multiply failed and goes to the redesign
| **1. Native types, arithmetic and elementary functions** (r5: the former Phases 1 and 2, merged by @sagebrush's Phase 0 ruling) | The native `Context` with the `mpf` and `mpc` types, holding the hybrid number (§4.6); `normalize`, `from_man_exp`, `mpf_add/sub/mul/div/sqrt`, `mpc` arithmetic and the integer helpers; `mpf_exp/log/cos/sin/pow`, `exp_fixed`, `cos_sin_fixed`, `log_int_fixed` and the cached constants; all behind python's overlay of the seven files (O1) | arith loop at most 1.0 x `CG` (about 0.07 s); complex loop at most 1.0 x `CG` (about 0.04 s); `fp` loop at most 1.0 x `SB` (F64, unchanged); pi at 100k digits at most 0.65 x `SB`; suite at most 0.70 x `SB`; macro at most 0.48 x `SB`; every row at most 1.0 x `SB`; `import mpmath` at most 1.0 x `SB` | core +100 KiB raw / +40 KiB gzip-9 (re-justified with measurements in r7, §6.2); glue at most 12 / 5 KiB; both hard no-ship ceilings (§6.2) | **Stop and rethink** if the macro isn't at most 0.67 x `SB`, or if the arith loop isn't at most 2.0 x `CG` |
| **3. Series, gamma, zeta; Sage CR** | `hypsum_internal`, gamma and log-gamma, zeta and Hurwitz zeta, Bernoulli numbers, the Riemann-Siegel kernels. Sage's `RealField` and `ComplexField` move onto the core, with proven bounds for the CR functions they use | hyp2f1 at most 1.0 x `CG` (about 0.015 s); gamma(1/3) at 1000 digits at most 1.0 x `CG` (about 0.68 s); zetazero(100) at most 1.0 x `CG` (about 0.10 s); Sage's `zeta(3).n(100)` agrees with the oracle | +70 KiB raw / +31 KiB gzip, net of its own deletions (§6.2) | **Stop** if any Sage pin changes its printed digits |
| **4. Calculus** | Quadrature nodes and weights, weighted sums, extrapolation tables. The loops that call user functions stay in Python (§4.6) | quad at dps=50 at most 1.0 x `CG` (about 0.04 s); suite at most 0.37 x `SB` (about 80 s) | +35 KiB raw / +15 KiB gzip (§6.2) | |
| **5. Matrices** | MP LU, QR, eigenproblems, SVD and inverse, operation for operation (§4.6) | 30x30 inverse at dps=30 at most 1.0 x `CG` (about 0.10 s) | +55 KiB raw / +23 KiB gzip, net of its own deletions (§6.2) | |
| **6. Our own mpmath** | The wheel is retired. The remaining high-level Python is ported (BSD notice kept) and compiled lazily; `engine/ball` and `libmpi` move onto the BALL policy | **Macro time at most 0.90 of paired CPython + gmpy's median** in Node, a measured win rather than a tie. In Chromium, at least 3 times faster than paired Pyodide. Suite time no slower than paired CPython + gmpy's (at worst, no regression from Phase 4). `import mpmath` no slower than paired Pyodide's | every row at most #927's baseline, everything counted (§6.2) | rollback is reverting the PR |

Every target is a ratio to a baseline measured at the same time on the same machine (§6.3). The seconds in the table apply those ratios to the Nov 9 report, only for orientation: that report's total isn't a valid gate (§6.3, P2). PERF (daybreak4) owns the measurement.

### 6.1 How the oracle is run (TESTS)

1. **Bit-identical means the raw values.** Results are compared as `(sign, man, exp, bc)` tuples:
   - `mpf._mpf_`;
   - the pair `mpc._mpc_`;
   - the tuples the `libmp` functions return.

   Printed text is never the comparison, because printing rounds and two different last bits can print the same. perf.py's checksums hash those tuples. The comparator is one shared helper, `bench/mpmath/tuples.py`, used by the fuzzer, perf.py and the pins.
2. **Where the suite runs.** From Phase 1 on, mpmath's suite runs in PR CI on both backends:
   - the new one;
   - the rollback (`SAGEBRUSH_MPMATH_BACKEND=python`), so the rollback path never rots.

   Each run is its own sharded job of at most 10 minutes, like `pypi-tests/mpmath`. If the suite on the Python backend doesn't fit, it is split into shards rather than given a longer timeout.
3. **The fuzzer.**
   - **The reference** is CPython with mpmath 1.3.0 on the **python** backend (not gmpy), pinned, with both versions recorded with every run.
   - **The inputs** cover every operation the phase replaces, crossed with the five rounding modes and with precisions 2, 3, 53, 54, 113, 1000 and random ones up to 10^4 bits. Operands include exact ties at the rounding bit, +0 and -0, huge and tiny exponents, cancellation (a - b with a close to b), mantissas around 2^64 (the edge of the kernel fast path, §4.1), mantissas around 2^53 (the edge of the hybrid number's storage, §4.6), and the specials inf and nan.
   - **The runs.** A fixed-seed subset (about 10^4 cases, about a minute) runs in PR CI. The long run is nightly on sbpool and gates on correctness and case counts only.
   - **Failures.** Every failure is stored with its seed and a minimized case, which becomes a permanent pinned row.
4. **Negative controls, before Phase 1's first kernel ships.** The suite plus the fuzzer's CI subset must catch each of these planted faults, planted in **the binding that ships** (the type-level binding of §4.6, which bypasses more of mpmath's Python than a `libmp` swap), not only in the kernel. (Phase 0 ran the first one, floor and ceiling swapped, against the kernel: §6.4.)
   - one rounding mode swapped (floor and ceiling);
   - round-half-even off by one at a tie;
   - the sign of a zero result lost;
   - `bc` off by one with `man` unchanged;
   - the kernel fast path's carry dropped (mantissas up to 64 bits, §4.1);
   - `normalize` not stripping trailing zeros;
   - in the limb path, which Phase 1 already ships: a carry or borrow dropped at a limb boundary, or the Karatsuba/Toom split off by one at its threshold. The fuzzer's CI subset pins rows at the multiplication threshold, one limb below it and one limb above it.

   A planted fault that passes means the oracle is too weak, and the phase doesn't ship until it isn't. TESTS also mutates each phase's kernels independently.
   - **What the merged Phase 1 adds to the fuzzer and the suite's coverage:**
     - `mpf` and `mpc` construction;
     - the methods the native type takes over: `__add__`, `__mul__` and the rest of the arithmetic, comparisons, hashing, and pickling in both directions;
     - the hybrid number's boundary: mantissas of exactly 2^53 - 1, 2^53 and 2^53 + 1, with both signs, as operands and as results;
     - **lifetime:** a few million `mpf` operations at dps 30 complete within the session's memory, asserting the count and a digest, never a time;
     - **copy boundaries:** limb counts 1, 2, n and n + 1 at the IO buffer's capacity; mantissas at 2^53, 2^64 and 2^96, each ± 1, with both signs; aliased operands (`x*x`, `x += x`); the largest operand the buffer takes, and one past it, refused cleanly;
     - **R1:** `x._mpf_ is x._mpf_` and `type(x.man) is int` on the big form, both after materialization and after a pickle round trip;
     - **planted faults in the copies:** the top limb dropped on copy-in, and a stale IO word left after a shorter result (a long result followed by a short one).
5. **CR and BALL have oracles of their own.**
   - **CR (Phase 3 on):** results are compared with the Sage oracle (MPFR) in every rounding direction. The points are random and adversarial, including the published hardest-to-round cases for exp, log and sin.
   - **BALL (Phase 6):** containment is checked against an MP evaluation at twice the precision and against Sage's `RealIntervalField`. The radius must stay within a stated factor of the true error.
   - **Proofs:** each function's proof is cited in its doc comment (§3), and a test pins the claimed bound at the worst input known.
6. **Interrupt and limits.** That `mp.dps = 10**7` can be stopped is pinned with the deterministic Stop seam, never by elapsed time. Each long loop's limit refusal is registered in the limits census (§4.5).
7. **Speed and determinism.**
   - perf.py's targets are measured and reported by PERF and never asserted in CI. The go/kill lines are read from PERF's reports.
   - Determinism (§7.5) is a test: the fuzzer's CI subset also runs in Chromium, one Chromium job per box, and its tuples must be byte-identical to Node's. The fixed differential corpus (Phase 0's 49,989 cases, regenerated from mpmath 1.3.0) runs in both as well.
8. **No self-comparison.** The MP core is never compared with its own earlier output. Every phase's oracle is CPython's mpmath, plus Sage for CR, and never the previous phase's Sagebrush results. Likewise, the F64 tier's oracle stays upstream mpmath on CPython (§5.2).

### 6.2 Size budgets (SIZE)

Every size in this section is in KiB (1 KiB = 1,024 bytes), raw or gzip-9 as stated.

**The baseline, B927.** These are #927's shipped rows. They come from #927's growth marker, measured with bun 1.4.4 on master 0291bcd9, and from the browser chunk built at 4ebb525b:
- the browser's lazy chunk `pkg-pypi-mpmath.src`: 2,005,054 bytes raw, 495,350 gzip-9;
- `cli/pyjs.cjs`: +940,942 raw, of which the package blob `packages.gen.js` is +672,785;
- `engine/sagebrush-worker.js`: +16,525;
- `engine/sagebrush-notebook.js`: +48;
- `cli/lib.gen.js`: +2,153.

B927 is re-recorded with the size gate's own tools (raw and gzip for every row, plus the offline inventory and the CLI's install size), at the same path and with the same toolchain. This is the last Phase 0 item: a pre-implementation input, due before the merged Phase 1's PR opens (@sagebrush's explicit ruling on r6). Every cap below is checked against that record.

**What ships.**
- **One core asset.** It is content-addressed and lazy, shared by the web editor, the CLI and the offline inventory. The native packaging compiles the same crate. A check fails the build if the asset is copied into more than one web chunk, or embedded in the worker's or the notebook's startup.
- **The glue,** counted in its governed rows: `_sagebrush_mpcore`, the overlay patch and the runtime binding.

**Caps.** Each phase's number is net shipped bytes against that phase's current master, measured after the deletions in the same PR. The measurement uses paired exact-toolchain builds at the same path, the transition gate, and the offline and package inventories. Deletions are never credited in advance.

| Phase | Core asset (phase / cumulative), raw / gzip | Glue, cumulative raw / gzip | Worker (phase, cumulative), raw / gzip | Notebook (phase, cumulative), gzip-9 |
|---|---|---|---|---|
| 1 (merged) | +100 / +40 KiB (100 / 40) | 12 / 5 KiB | +7,460 / +3,260 bytes (7,460 / 3,260) | at most +1 KiB, +3 KiB cumulatively |
| 3 | +70 / +31 KiB (170 / 71) | 14 / 5 KiB | +0 / +0 (7,460 / 3,260) | the same |
| 4 | +35 / +15 KiB (205 / 86) | 15 / 6 KiB | +0 / +0 (7,460 / 3,260) | the same |
| 5 | +55 / +23 KiB (260 / 109) | 16 / 6 KiB | +0 / +0 (7,460 / 3,260) | the same |
| 6 | see below | | | |

**Why the merged Phase 1's numbers, and not the old ones.** r4 allowed Phase 1 120 / 50 KiB and Phase 2 60 / 25 KiB, 180 / 75 KiB together. r5 doesn't inherit that sum: it is one cap, set from Phase 0's measurements.
- **Arithmetic.** The spike's module, measured, is 42,999 bytes raw and 16,829 gzip-9. That covers the arithmetic (u128 and limb paths, the 28-bit SIMD product) plus the handle store and a profiling export that won't ship.
- **Elementary functions and constants.** `exp`, `log`, `cos`/`sin`, `atan`, `pow` and the constants are ported from `libelefun` (1,428 lines of Python). They are estimated at no more than 35 KiB raw.
- **The cap set in r5.** 80 / 32 KiB covered both with the slack of one estimate, not two.
- **The measurement (r7).** The built Phase 1 core missed that cap, so it is re-justified here from measurements, as the next bullet's rule requires (@sagebrush's ruling, Nov 9).
  - **As first built:** 143.4 KiB raw / 49.5 KiB gzip-9. That was the literal port on value-returning `Result` arithmetic: each of about 350 `?` sites inlined its error path and the drops of every live big integer.
  - **After the restructure:** 95.6 / 38.8 KiB (97,886 / 39,752 bytes), at commit 1b7a1761, with no change to what the core does.
    - Failures are sticky, checked once per call.
    - The caches are dense tables, and session state is const-initialized.
    - Every reference corpus still matches with 0 mismatches: arithmetic 300k, floats 733,993, integer square roots 172,409, constants 3,000, elementary functions 246k, float-chosen parameters 199,999.
    - A limits test refuses every operation part-way at ten limb limits and at precision 10^15: each refusal is clean, and the session is exact afterwards.
  - **How it was measured:** rustc 1.99.1, opt-level z, LTO, one codegen unit, custom sections stripped, gzip-9 by node 24.21.0's zlib. Both records are frozen with their section and function breakdowns.
  - **What the 95.6 KiB holds:**
    - glibc's pow/log/exp tables, which ruling P1 requires: about 7.5 KB;
    - dlmalloc, engine/wasmheap's shared heap: 6.3 KB;
    - std's panic machinery and fmt, present because every bounds check can panic: about 7.4 KB;
    - compiler-builtins (software fma, 128-bit division): 2.3 KB;
    - the ported algorithms and the call interface: about 62 KB.
  - **What r5's estimate left out:** the tables, the heap, the panic machinery and the full call interface. The 43 KiB spike covered add and multiply only.
- **The cap (r7).** 100 / 40 KiB: the measured 95.6 / 38.8 with about 4% of headroom. The 20 / 8 KiB comes out of the later phases' increments (the table above), so the cumulative total through Phase 5 stays 260 / 109 KiB, and Phase 6's cap is unchanged.
- **A later size option, not taken now (@sagebrush's ruling, Nov 10).**
  - **The change:** build the core `no_std` in WebAssembly, with its own panic handler.
  - **What it costs:**
    - stable `core` has no `f64::mul_add`, `trunc` or `powi`, so it needs a hand-written, correctly rounded fma for the glibc pow port, verified against hardware fma;
    - one new unsafe site (`Sync` for the single-threaded session statics);
    - TESTS surface.
  - **The estimated saving:** about 7 KB raw / 2.5 KB gzip.
  - **Gate:** it comes, if ever, as its own reviewed PR.
- **Hard no-ship ceilings** (@sagebrush's ruling on r6, kept in r7): the merged Phase 1's core cap (100 KiB raw / 40 KiB gzip-9 since r7) and its glue cap (12 KiB raw / 5 KiB gzip-9) are ceilings, not estimates. If the measured Phase 1 PR exceeds either one, raw or gzip-9, the phase doesn't ship. It either cuts to fit, or a new design PR re-justifies the cap with measurements.
- **The glue.** The spike's runtime binding is 5,796 bytes raw and 2,083 gzip for add, sub and mul plus the handles. The native type adds comparisons, hashing, conversions, pickling and `mpc`, so the glue keeps r4's cumulative 12 / 5 KiB as a ceiling, not an entitlement.
  - **How the glue is counted (@sagebrush's ruling, Nov 10).** One total, 12,288 / 5,120 bytes, covers the minified runtime binding, the overlay and any other `_sagebrush_mpcore` support. The core asset counts only against its own cap.
  - **Measured (r8).** The binding (`src/runtime/mpcore.ts`, minified by bun 1.4.4, gzip-9 by node 24.21.0's zlib) is 7,142 / 3,265 bytes, and the overlay's added lines are 4,328 / 1,304. Together: 11,470 / 4,569 bytes, inside 12,288 / 5,120.
  - **Measured (r9).** The binding with SEC's admission and Stop polls and PERF's fixes is 7,548 / 3,497 bytes; with the overlay, 11,876 / 4,801 bytes, still inside 12,288 / 5,120.
- **The worker row (r8).** The binding is code the worker runs: it registers `_sagebrush_mpcore` and wraps every `mpf` operation, so it ships in the worker bundle. Only the core asset is lazy (@sagebrush's ruling, Nov 10: the binding stays in the worker bundle).
  - **Measured.** These are paired builds of master 69859f01 and the Phase 1 branch merged with it, at the same path, with bun 1.4.4 and node 24.21.0. `engine/sagebrush-worker.js` grows +7,067 bytes raw and +2,972 gzip-9. `engine/sagebrush-notebook.js` grows +39 / +22: one entry, the core asset's name, in the offline file list. The gzip figure moves by about 80 bytes between builds, because the content hashes in the bundle change.
  - **What it holds.** The binding (the 30 hooks, the context's fast arithmetic, the hybrid number's limbs) and the asset loader that the PNG module now shares (`src/runtime/wasm-asset.ts`), which takes the place of the PNG module's own copy.
  - **The cap (r8).** Phase 1's worker row was +7 KiB raw / +3 KiB gzip-9 (7,168 / 3,072 bytes): the measurement plus about 100 bytes, both raw and gzip. Like the other Phase 1 caps, it is a hard no-ship ceiling.
  - **The amendment (r9).** Two later requirements added worker code:
    - SEC's ruling on the JavaScript-side limbs (§4.5): every copy of limbs is admitted before it is made, the large ones by the shared free-heap admission (`admitHeap`), and every copy loop tests for Stop. The limbs became plain arrays instead of typed arrays.
    - PERF's 1.5 µs line at dps 30 (§6.3): the precision is read without a BigInt, and one cached view of the core's memory serves every copy.
    - **Measured:** paired builds of master b734f76e and the Phase 1 branch merged with it, the same toolchain and path (and the same figures on master 6f7da92d). The worker grows +7,360 bytes raw and +3,158 gzip-9: 192 / 86 bytes over r8's row. The notebook grows +39 / +26.
    - **The cap:** Phase 1's worker row becomes +7,460 / +3,260 bytes, the measurement plus 100 bytes raw and 102 gzip-9, still a hard no-ship ceiling. Phases 3, 4 and 5 stay at +0 / +0, so the cumulative worker total through Phase 5 rises by the same 292 / 188 bytes, to 7,460 / 3,260.
    - **An alternative, not measured:** the `Context` class could be built in the overlay's Python (a lazy file) instead of the binding, which would move some bytes out of the worker. It needs a change to the overlay, python's lane, and a measurement; it isn't proposed here.
  - **The notebook column** is read as gzip-9 too, like the worker's (r9). Measured: +39 raw / +26 gzip-9, one entry in the offline file list.
  - **Where it comes from.** r7's row gave the worker at most +1 KiB per phase and +3 KiB cumulatively, without saying raw or gzip. This revision reads it as gzip-9, the bytes a user downloads. Phase 1 takes the whole cumulative +3 KiB gzip, and Phases 3, 4 and 5 give up their worker increments: their worker growth is +0 / +0. The cumulative worker total through Phase 5 stays +3 KiB gzip. Its raw figure, +7 KiB, is stated here for the first time. In a later phase, any binding code the worker gains must be paid for by cuts in the same bundle, in the same PR. The notebook's row is unchanged.
  - **A later option, not taken now: a lazy JavaScript loader.** The binding could load with the core asset, as a second lazy file, and leave the worker. It would need a code-loading path the worker doesn't have today. That comes, if ever, as its own PR, with its own SEC review.

Each later phase kept its r4 increment in r5, and their cumulative totals dropped by the 100 / 43 KiB that the merge took out. In r7, Phases 3, 4 and 5 give up 10 / 4, 5 / 2 and 5 / 2 KiB of their increments, the 20 / 8 KiB Phase 1's measured cap needed. The cumulative total through Phase 5 is unchanged.

**Each phase's gate reports:**
- the core asset's raw and gzip size;
- the Python/API lazy asset's raw and gzip size;
- the glue by governed row;
- the offline stored and transfer deltas;
- the CLI, package and install-size deltas;
- the worker and notebook startup rows.

**The temporary duplicate stack, through Phase 5.** The pinned wheel keeps its own pure-Python `libmp` while the core replaces it. That is an explicit, time-bounded exception to the one-implementation rule:
- **Cost.** The rollback adds no bytes of its own: it is the wheel, which ships anyway until Phase 6, because mpmath's high-level Python needs it.
- **Maximum footprint.** The most the stack can reach is B927 + 260 KiB raw / 109 KiB gzip of core + 16 KiB / 6 KiB of glue.
- **Retirement point.** The exception ends with Phase 6, which deletes the wheel and with it the Python `libmp`.
- **Stop condition.** If Phase 6 hasn't merged within 10 weeks of the merged Phase 1's merge (the clock starts there, and no earlier), the migration stops. @sagebrush then rules between landing a reduced Phase 6 (retiring the Python `libmp` alone, with a pinned overlay of the remaining modules) and reverting Phases 1 to 5.

**The Phase 6 final cap.** Everything is counted: the replacement Python module, the shared core, the bindings, the notices and every packaged copy (web chunk, CLI blob, offline inventory). The total must be **at most B927 in every row, raw and gzip**, with a target of 15% below. The upstream tests move to a test-only chunk that users never load. The deletions of Sage's and the ball code's duplicates (§5.1) come on top of this cap, never instead of it.

**The deletion ledger.** CR and BALL move one function at a time. A ledger in this file, under §5.1, records each move: the function, the policy, the core kernel, the PR, and the implementation deleted. Once a core kernel is approved to serve a policy, the old shipped implementation of that function is deleted in the same PR. If it isn't, the ledger names it under the temporary exception with its removal phase. A deletion claim counts only with the paired-build evidence above, never by line count.

### 6.3 How speed, import time and memory are measured (PERF)

1. **A paired protocol.**
   - **Builds.** Every compared Sagebrush build is built at the same path and run from the same fixed path.
   - **Runs.** Candidates run interleaved, in alternating order, on the same machine.
   - **What is kept.** Raw samples are retained, and the report gives the median and the p95, never the minimum.
   - **What is recorded.** Every packet records tool versions, exact commits, CPU and load, and cold or warm state, and it is frozen before review.
   - **Baselines and gates.** Baselines (Sagebrush, CPython with and without gmpy, Pyodide) are remeasured at the same time for each phase's review, and gates are ratios to them.
2. **`perf.py` is repaired in Phase 0, before its numbers become gates.**
   - **The total.** Today's total isn't the sum of the reported rows: it mixes repeat counts, setup and output conversion. Phase 0 replaces it with a separately repeated, fixed one-pass macro workload, and a phase gate uses that macro's median.
   - **The digest.** The truncated result marker becomes a SHA-256 of each complete result's raw tuples (§6.1).
3. **A like-for-like browser comparison.** Sagebrush and Pyodide run in the same Chromium build on the same host, with the same pinned mpmath version (1.3.0 in both, loaded into Pyodide from the same wheel) and the same benchmark bytes. Node and Chromium are separate columns for Sagebrush.
4. **What Phase 0 covers.** Phase 0 measures add and multiply at dps 15 and 30 and at dps 1000 (limbs), including allocation, handle lifetime and transfer. The small operations at dps 15 and 30 have an absolute GO line of 1.5 microseconds. The limb-backed dps 1000 multiply has its own paired ratio gate, at most 1.25 x `CG` and 1.0 x `SB`, because paired CPython + gmpy already takes about 2.48 microseconds there (the table above).
5. **"Beat mpmath" is a measured win.** Phase 6's gate is a macro time at most 0.90 of paired CPython + gmpy's median, with a suite-time target, and at least 3 times faster than paired Pyodide in Chromium.
6. **Import and memory gates, in every shipped phase.** The rows below are measured with the default backend. Runs on the rollback backend are diagnostic only and can't satisfy a gate. Each row may not regress against the phase's paired baseline beyond its noise band:
   - the cold-cache and warm-cache time to the first successful `import mpmath`, and the time to the first representative result;
   - idle RSS before import, peak RSS during the first import, and RSS retained after the workload;
   - in Chromium, the time to download, compile and instantiate the core's WebAssembly, and the WebAssembly memory it retains.

   The final import target is at most paired Pyodide's: the Nov 9 report has `import mpmath` at 1.6 s on Sagebrush against 0.59 s on Pyodide.

### 6.4 Phase 0: what the spike showed (done)

The packet is frozen at `/scratch/sage2-notes/mpcore/phase0-packet`. PERF's paired re-measurement on an idle VM is frozen at `/scratch/sagebrush-reviews/phase0-perf-a0e2a0aa-daybreak4/`. Nothing from the spike ships.

- **Exactness.** The spike's Rust port of `normalize`, `mpf_add`, `mpf_sub` and `mpf_mul` gave raw tuples bit-identical to CPython's mpmath 1.3.0 (python backend) on 49,989 random cases in all five rounding modes. A planted floor/ceiling swap was caught (4,748 mismatches).
- **Small operations: GO.**
  - A native `mpf.__add__`/`__mul__` calling the WebAssembly core: PERF's worst median was 1.03 µs (Chromium, dps 30 multiply).
  - Handles: at most 0.75 µs.
  - All under the 1.5 µs line in Node and Chromium.
- **What doesn't reach the line.** Replacing only the `libmp` functions gave about 2.3 µs per add, because most of today's cost is mpmath's Python `mpf.__add__` and object creation. That is why r5 merges Phases 1 and 2 (@sagebrush's ruling).
- **The dps 1000 multiply: redesign the limb path, no kill.**
  - PERF measured 6.51 to 6.60 µs with handles, against paired `CG` at 2.11 to 2.15 µs: about 3.09 `CG`. It fails the 1.25 `CG` gate and passes 1.0 `SB` (0.76 in Node, about 0.97 in Chromium).
  - WebAssembly has no 64x64-to-128-bit multiply, so the spike's SIMD product works on 28-bit digits, and its fixed-size number type made Karatsuba slower, not faster.
  - **A gate before Phase 3:** the real crate's limb path (allocation-free buffers, in-place Karatsuba or Toom-3 with scratch, a tuned SIMD basecase) is re-measured by PERF against the 1.25 `CG` and 1.0 `SB` gates at dps 1000. Phase 3 doesn't start until it passes, or until @sagebrush rules on a reported shortfall. Phase 1 already runs the limb path (elementary functions at high precision, pi to 100k digits), but only against its own gates: correctness, limits, interrupts, and ratios to `SB`. Phase 3 has the first rows with a `CG`-relative target at 1000 digits (gamma and zeta), and those need the redesigned path.
- **Still due from Phase 0, before r5 merges:**
  - the `perf.py` repair (PR #942);
  - the like-for-like Pyodide column: Pyodide 314.0.7 in the same Chromium, with mpmath 1.3.0 loaded from Sagebrush's pinned copy. Its driver and a first, loaded-host run are frozen at `/scratch/sage2-notes/mpcore/phase0-addendum` (every `perf.py` digest identical on both), for PERF to measure on an idle VM.
- **Due before the merged Phase 1's PR opens:** B927 re-recorded (§6.2).

## 7. Risks

1. **The cost of crossing into wasm.** If no binding reaches Phase 0's line, per-operation arithmetic can't live in WebAssembly. The fallback is to put the number type in the pyjs runtime itself (TypeScript on its own BigInt ints), with Rust taking only whole loops (Phases 3 to 5). That would be a binding, not a second implementation of the algorithms. Even so, it needs William's OK, because it puts numerics in TypeScript.
2. **The long tail.** mpmath carries nearly two decades of cancellation and precision fixes. Phases 1 to 5 port its algorithms line for line, bit-identical, so the tail comes along. New algorithms, such as ones from the papers behind Arb, come only after Phase 5, each with its own review.
3. **Rigorous bounds** take real mathematical work for each function. CR and BALL migrate one function at a time, and a function without a proof stays on its current implementation until it has one.
4. **SymPy compatibility** depends on `mpmath.libmp`'s raw-tuple API staying exactly as it is (§4.4).
5. **Determinism.** TimeTravel replays a session in another browser and needs the same bits there. The core is integer-only, with no host floating point in MP, CR or BALL results, so it is deterministic by construction. Any F64 shortcut inside it (for example a double-precision starting guess) must be shown not to affect results.

## 8. Provenance

- **mpmath and SymPy** are BSD-3-Clause. Their code may be read and ported. Each ported file keeps the upstream copyright and licence notice, and `NOTICE.md` records it. The pure-Python `libmp` functions are the specification for the backend hook.
- **Sage** is black-box only: `/scratch/sage-oracle/sage/sage`, input in and output out. In particular, Sage's implementation of mpmath's backend hook (`sage/libs/mpmath/`) is never read. The hook's names and semantics come from mpmath's own call sites and pure-Python reference functions.
- **FLINT/Arb, MPFR and GMP** are LGPL. We take algorithms from their papers and books only, never from their code. Examples: Johansson's papers on Arb and on computing hypergeometric functions; Brent and Zimmermann's *Modern Computer Arithmetic*; the DLMF. `engine/flint` stays what it is today, a reference used only in tests.
- **The core's own code** is new Sagebrush code, MIT OR Apache-2.0, with no new dependency beyond the engine crates.

## 9. Review lanes

ENGINE (daybreak3), SEC (astra), TESTS (grader), PERF (daybreak4), SIZE (daybreak2). python co-reviews, as the owner of the runtime and the curated-package hook (O1). Each phase is then its own series of PRs through the usual lanes.

## 10. Open questions

- **O1.** Ruled by @sagebrush on Nov 9: a pinned overlay of the seven guarded files under the Sagebrush-owned `_sagebrush_mpcore`, with no impersonation (§4.3). python owns the mechanism. The full hunk list is part of Phase 1's PR, for python and SEC.
- **O2.** Decided by William on Nov 9 (afternoon, PST): there is no pure mode without WebAssembly or a native module. In his words: "you can always use wasm or n-api." So:
  - **The MP core has no fallback implementation.** In the browser and the Node CLI it runs as WebAssembly; natively it runs through N-API or `sagebrush._native`. The upstream Python backend remains only as the time-bounded rollback through Phase 5 (§4.3, §6.2), selected explicitly in a fresh session, never as a capability fallback.
  - **The F64 twins that exist only so results are identical with and without WebAssembly** (§5.3: `src/runtime/numpy_linalg.ts` against `kernels/src/eigen.rs`, and the JavaScript side of each `kernels/` kernel) can go. That cleanup belongs to the separate F64-tier design (§5.3), not to this one.
- **O3.** Whether `mpmath.fp`, mpmath's double-precision context, should call `lib/_special.py` so that the F64 tier also has one implementation. Today `fp` runs mpmath's own double-precision Python. This would change last bits against upstream, so it belongs after Phase 5.
