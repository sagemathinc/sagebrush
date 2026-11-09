# One multiprecision core: mpmath on Rust (design)

*@sagebrush-sage2, November 9, 2026. This is a design document only; code follows once it merges, one phase at a time.*

## In plain words

- Sagebrush ships several separate implementations of arbitrary-precision numbers and their functions. mpmath (added in #927) is the largest. Sage mode's `RealField` (`lib/_sage_real.py`) is a second. The engines' ball arithmetic (`engine/ball`) is a third. This design folds them into one Rust core, so that only one piece of code computes, say, a 30x30 matrix inverse at 30 digits.
- mpmath's own interface stays the same: its names, its conventions, and its test suite, which runs unchanged as the oracle at every step.
- The rule is **one implementation per precision tier**. Double-precision code (`lib/_special.py`, numpy's linear algebra, scipy) is a different tier with different algorithms. It is not merged into the multiprecision core, because that would make it many times slower.
- Measured today, mpmath on Sagebrush takes 5.25 s on the benchmark, against 6.82 s for Pyodide and 1.31 s for CPython with gmpy. Most of Sagebrush's time goes to running mpmath's Python code for each small operation, not to big-number arithmetic. So the first phase moves mpmath's number type and basic arithmetic into the core; just making the integers faster would not be enough.
- There are seven phases. Each has its own speed target, its own size budget, its oracle and its way back. Phase 0 is a measurement spike with a go/no-go line, and nothing ships in it.
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

So there is one exp, one zeta, one LU at multiprecision, behind three policies. The F64 tier stays separate. A 53-bit evaluation through a big-float core costs many times what a tuned double-precision kernel costs (Phase 0 measures the factor for exp and gamma), and SciPy and MATLAB users would pay for that on every call.

**Rigorous bounds come per function, not all at once.** mpmath's algorithms carry heuristic error estimates, not proofs. A kernel can serve MP before its bound is proven. It serves CR and BALL only once the bound is proven, with the proof cited in its doc comment. That proof is what lets Sage's and the ball code's own copies be deleted.

## 4. The layers

### 4.1 L0: the Rust crate `sagebrush-mp` (`engine/mp`)

The crate is MIT OR Apache-2.0, like the other engine crates. It has no C dependencies, and the same Rust runs in the browser's WebAssembly, natively and in the Node CLI. It owns:
- **The number type and its arithmetic:**
  - mantissa and exponent on `sagebrush-bigint`, with an inline fast path for mantissas up to 64 bits;
  - the five rounding modes;
  - correctly rounded `add sub mul div sqrt`, plus `pow_int`, `ldexp` and conversions;
  - the text conversions that mpmath and Sage need, with exactly mpmath's digit rules.
- **Fixed-point kernels and constants:** pi, e, log 2, Euler's gamma and Catalan's constant, each cached per precision; exp, log, cos/sin, atan, and the hyperbolic and inverse functions.
- **Series:** the generalized hypergeometric summation (`hypsum`), Bernoulli numbers, gamma, log-gamma, zeta, Hurwitz zeta, polylog, and the Riemann-Siegel machinery behind `zetazero` and `siegelz`.
- **Calculus:** quadrature nodes and weights (tanh-sinh and Gauss-Legendre, cached per degree and precision), the summation loops, and the inner loops of root finding.
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

Every other mpmath module stays the upstream Python, now running on fast primitives. Keeping the raw-tuple `libmp` functions (`mpf_add(s, t, prec, rnd)`) matters beyond mpmath itself: SymPy's evalf calls them directly.

**How the wheel finds the backend: open question O1, for python and SEC.** `backend.py` reaches the Sage branch only when `import sage.all` and `sage.libs.mpmath.*` import successfully. The options:
- **(a) An overlay.** One pinned patch file for `backend.py` adds a `'sagebrush'` branch that imports our module. It is recorded with its own checksum next to the wheel's, the way the curated-package mechanism records the wheel.
- **(b) Impersonation.** Register modules under `gmpy2` or `sage.libs.mpmath` names.

I recommend (a). With (b), `import gmpy2` would succeed in user code with a partial API, and the system would misreport what it is running. python prefers not to patch the wheel. An overlay keeps the wheel's own bytes untouched and diffable, so I hope that is acceptable to them.

**Phase 6 on: our own `mpmath` module.** The pinned wheel is retired. The high-level Python (the functions, calculus and matrices modules that remain Python) becomes a Sagebrush module, ported from mpmath with its BSD notice kept. It has the same names, signatures and behaviour, the same `mp`/`fp`/`iv` contexts, and the same docstrings (`function_docs`). The upstream suite still runs against it unchanged.

### 4.4 L3: SymPy's API (later; a design of its own)

SymPy's numerics reach mpmath through `mpmath.libmp`'s raw functions and the `mpf` and `mpc` types. Keeping those names stable from Phase 1 on is the only obligation this design places on the SymPy work. Whether to reimplement SymPy's API on Sage mode's symbolic engine (`engine/sym`) is a separate design. It is gated on Phases 1 to 5 meeting their numbers (§6).

## 5. The inventory: everything that overlaps, and where it lands

"Deleted" means removed from the tree in that phase's PR, with the size gate showing the reduction.

### 5.1 The multiprecision tiers (MP, CR, BALL): all land in `engine/mp`

| Today | Size | Tier | Lands in the core as | Deleted |
|---|---|---|---|---|
| mpmath `libmp/` (`libmpf`, `libmpc`, `libelefun`, `libintmath`, `gammazeta`, `libhyper`, `libmpi`) | 8,705 lines of Python | MP, interval | number type, arithmetic, elementary functions, series, gamma and zeta | the backend branches stop running from Phase 1 (the Python stays as the rollback path); the modules leave the tree in Phase 6 |
| mpmath `ctx_mp_python.py` (`mpf`, `mpc`, `PythonMPContext`) | 1,149 lines | MP | the native `Context` (Phase 2) | Phase 6 |
| mpmath `calculus/`, `matrices/`, `functions/` | 6,711 + 5,012 + 10,652 lines | MP | inner loops in Phases 3 to 5; the rest is ported as our Python API in Phase 6 | the duplicated loops leave the tree in Phase 6 |
| `lib/_sage_real.py`: `RealField`, `ComplexField`, `RealIntervalField`, `N()` | 4,927 lines in all, including about 330 of fixed-point elementary functions and constants, 130 of gamma, 200 of rounding, and 1,415 in the `RealNumberMP` class | CR, BALL | Sage's elements wrap the core's number type; their functions use the CR policy (Ziv) over the core's kernels | Phase 3: the fixed-point functions, gamma, Bernoulli, the rounding helpers, and the arithmetic inside `RealNumberMP`. Sage's printing, parsing and coercion stay, because they are Sage semantics, not numerics |
| `engine/ball` (`Ball`, `Mag`, ball elementary functions, Li2, Ti2, Bernoulli) | 2,149 lines of Rust | BALL | the core's BALL policy; the dilogarithm and inverse tangent integral become core kernels with proven bounds | Phase 6, once `engine/ap`'s heights and the certificates call the core |
| Sage's numerical matrices over RR and CC above 53 bits (`lib/_sage_rdf.py`, `lib/_sage_matrix*.py`) | the parts of 1,367 + 4,524 lines that do arithmetic above 53 bits | CR | the core's MP linear algebra under the CR policy where Sage promises correct rounding, plain MP where it does not | Phase 5 |

**Gains Sage gets on the way:** today `zeta(3).n(100)` stops with "NotImplementedError: zeta at more than 53 bits is not available in sagebrush yet". The same is true of every special function except gamma and log_gamma. Phase 3 makes these work, checked against the Sage oracle. That brings the zeta and prime-counting pins at high precision within reach.

### 5.2 The F64 tier: not merged into the core

These are each the one F64 implementation of their function, and they stay. Their algorithms are tuned to doubles.

| Today | Size | Stays as |
|---|---|---|
| `lib/_special.py` and `lib/_special_ibeta.py` (gamma, psi, zeta, erf, Bessel, elliptic and others, in double precision) | 3,926 + 556 lines | the F64 special functions for scipy.special, MATLAB mode (`lib/_matlab_special.py` is a thin wrapper) and Sage's RDF |
| `scipy.integrate` (QUADPACK-shaped `quad`, the RK and DOP853 solvers), `scipy.optimize` | 1,927 + 2,463 lines | the F64 quadrature, root finding and ODE solvers |
| `engine/sym` `num.rs` and `eval.rs` | 1,052 lines of Rust | symbolic expressions' 53-bit numbers. `special.rs` holds symbolic canonical forms, not numerics, so it does not overlap |

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

I propose a separate, short "F64 tier" design. Its main question is whether the no-WebAssembly fallback (`SAGEBRUSH_NO_WASM`) is still needed. If it isn't, each twin can go.

## 6. Phases

Every phase has these, in addition to its own targets:
- **Its oracle:**
  - mpmath's upstream suite, unchanged: 339/339 in `bench/mpmath/compare.py` and the curated package's `pypi-tests/mpmath`;
  - `bench/mpmath/perf.py`'s result checksums, identical to CPython's;
  - from Phase 3 on, Sage pins recorded from the Sage oracle (`/scratch/sage-oracle/sage/sage`), including the zeta and prime-counting pins at high precision.
- **Bit-identical results:** through Phase 5, every result is bit for bit what upstream mpmath gives on CPython with the python backend. The kernels port mpmath's algorithms, and the suite and doctests stay exactly as they are. A faster algorithm that changes last bits is a separate, explicitly reviewed PR after Phase 5.
- **A differential fuzzer:** random operations at random precisions and rounding modes, compared bit for bit with CPython's mpmath. It runs in TESTS' lane, and its seed is recorded with every failure.
- **A rollback:** through Phase 5, a setting (`SAGEBRUSH_MPMATH_BACKEND=python`, plus a session option) selects upstream's pure-Python backend, which is still in the tree. Reverting a phase's PR also restores the previous state.
- **A size budget:** given below as the growth the phase may add net of what it deletes, with lazy loading as the rule. The core's WebAssembly loads on first `import mpmath` (or the first Sage `RealField` above 53 bits), never with the worker. The worker and notebook rows may grow by at most 1 KB in any phase.
- **Speed targets:** measured with `perf.py` in Node and in Chromium. Chromium is the comparison that matters against Pyodide.

| Phase | What | Targets: Sagebrush, not the baseline | Size budget | Go / kill |
|---|---|---|---|---|
| **0. Spike** (nothing ships) | The crate's skeleton with `mpf_add`/`mpf_mul`, and three bindings measured on the per-operation microbenchmark: (i) direct wasm exports with an i64 fast path and limbs in memory; (ii) handles to wasm-resident numbers; (iii) today. The benchmark harness's browser driver is repaired, so that Sagebrush has a Chromium column next to Pyodide's. | A binding that makes `mpf + mpf`, called from mpmath's Python, cost at most 1.5 microseconds (today 6.18) in Node and in Chromium | none shipped | **Kill or redesign** if no binding reaches 2.5 microseconds |
| **1. Arithmetic** | `normalize`, `from_man_exp`, `mpf_add/sub/mul/div/sqrt`, `mpc` arithmetic, and the integer helpers on the core, behind the overlay hook (O1) | arith loop at most 0.10 s (today 0.303); complex loop at most 0.05 s (0.127); suite at most 150 s (216); no row slower than today | core wasm at most 120 KB raw / 50 KB gzip, lazy | **Stop and rethink** if the total doesn't reach 3.5 s (today 5.25) |
| **2. Context and elementary functions** | The native `Context` with `mpf` and `mpc`; `mpf_exp/log/cos/sin/pow`, `exp_fixed`, `cos_sin_fixed` and the cached constants | arith loop at most 0.07 s (CPython + gmpy: 0.068); `fp` loop unchanged (F64); pi at 100k digits at most 0.04 s (0.062); total at most 2.5 s | +60 KB raw | |
| **3. Series, gamma, zeta; Sage CR** | `hypsum_internal`, gamma and log-gamma, zeta and Hurwitz zeta, Bernoulli numbers, the Riemann-Siegel kernels. Sage's `RealField` and `ComplexField` move onto the core, with proven bounds for the CR functions they use | hyp2f1 at most 0.015 s (0.103); gamma(1/3) at 1000 digits at most 0.68 s (1.27); zetazero(100) at most 0.10 s (1.14); Sage's `zeta(3).n(100)` agrees with the oracle | +80 KB raw, offset by deleting about 660 lines of `lib/_sage_real.py` | **Stop** if any Sage pin changes its printed digits |
| **4. Calculus** | Quadrature nodes and weights, the summation and extrapolation inner loops, `findroot`'s inner steps | quad at dps=50 at most 0.04 s (0.289); suite at most 80 s | +40 KB raw | |
| **5. Matrices** | MP LU, QR, eigenproblems, SVD and inverse; Sage's RR and CC matrices above 53 bits | 30x30 inverse at dps=30 at most 0.10 s (0.775) | +60 KB raw, offset by the deleted Sage matrix numerics | |
| **6. Our own mpmath** | The wheel is retired. The remaining high-level Python is ported (BSD notice kept) and compiled lazily; `engine/ball` and `libmpi` move onto the BALL policy | **total at most 1.31 s** (beating CPython + gmpy) in Node; in Chromium at least 3 times faster than Pyodide's total (6.82 s); suite unchanged | net **negative**: the wheel's lazy blob (+673 KB in the CLI at #927) is replaced by our smaller module and the core | rollback is reverting the PR |

All targets are against this machine's baseline. When the benchmark machine or load changes, the target becomes the baseline remeasured on the same machine at the same time, scaled by the ratio above. PERF (daybreak4) owns how the measurement is done.

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

- **O1.** How the pinned wheel finds the backend: an overlay patch of `backend.py` (recommended) or modules that impersonate gmpy2 or Sage (§4.3). For python and SEC.
- **O2.** Whether the no-WebAssembly fallback is still needed. If it isn't, the MP core has no TypeScript twin, and the F64 twins in §5.3 can go. For William.
- **O3.** Whether `mpmath.fp`, mpmath's double-precision context, should call `lib/_special.py` so that the F64 tier also has one implementation. Today `fp` runs mpmath's own double-precision Python. This would change last bits against upstream, so it belongs after Phase 5.
