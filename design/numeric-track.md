# The numeric track

*November 21, 2026, r6.* track/numeric is where MATLAB mode's numerical
side grows: the functions an agent reaches for when it writes MATLAB, and a
subset of the Symbolic Toolbox. It works like track/math: PRs go into
track/numeric, and the track is pulled into master. This note settles what
"compatible" means there, how results may differ between targets, what
things may cost, where the work starts, and how it is checked.

This track prioritizes agents directed by people: its priorities are what
agents (Claude, Codex) would write first (§4).

## 1. The compatibility contract

Two kinds of behaviour, held to two standards.

**Matched exactly.** Everything a program can branch on, or that a person reads as structure:

- **Shapes and classes:** `size`, the class (`double`, `single`, integer classes, `logical`, `char`, `string`, `cell`, `struct`), complexity (`isreal`), and sparsity (`issparse`).
- **Errors:** which inputs raise, and the identifier. Identifiers come only from a MATLAB-printed source (an observed MATLAB run, or the documentation's text); otherwise the identifier is empty, never guessed. The message keeps Sagebrush's wording unless a test pins MATLAB's.
- **Warnings:** which inputs warn (singular matrix, nearly singular with the RCOND value's form, iteration limits), and the identifier where MATLAB prints one.
- **Edge cases:** empty inputs and their shapes (`sum(zeros(0,3))` is `zeros(1,3)`), `-0` where MATLAB's documentation says so, dimension arguments, `'omitnan'`, integer saturation and rounding, and implicit expansion's rules.
- **NaN and Inf:** "exact" covers NaN and Inf that come from the inputs. Intermediate overflow is exact as §2's canonical order produces it, which differs from MATLAB's and Octave's order by design:
  - `sum([1e308 1e308 -1e308])` is `1e308` here, where Octave gives `Inf`;
  - `sum([1 1e100 1 -1e100])` is 2 here and 0 in Octave, which is within the accuracy contract.

  Tests of overflow-dependent results say so. Reductions start their accumulators at $+0$, so `sum([-0 -0])` is $+0$, as in Octave; that's pinned.
- **Exact values:** results whose value is defined exactly. These are integer-valued results (`rank` and other tolerance decisions only away from the tolerance: near it, §2), sorting and set results with their index outputs, `find`, logical results, the order of `eig`'s values where it is documented, and display formatting (`disp`, `format`, `mat2str`, `num2str`), which scripts parse. Display is exact as a function of the double printed, not a claim that a computed value prints as MATLAB's does, so display tests use exactly representable or exact-result inputs.
- **Random numbers:** `rand`, `randn` and `randi` after `rng(seed)` give MATLAB's numbers (already so: design/matlab.md).

**Matched within a stated accuracy.** Floating-point values from an algorithm:
- linear algebra, eigen- and singular values, FFTs, ODE solutions, quadrature, optimizers, interpolation and special functions.

Each function states its bound in its catalog entry's `accuracy` field. Each entry has five parts; without the constant and the domain, a bound can't fail a test:
- (a) **kind:** ulp, normwise backward, componentwise backward, residual, or forward-relative;
- (b) **norm:** 1, 2, $\infty$ or Frobenius, normwise or per component;
- (c) **constant $c$:** a number, with its source. It is either an a-priori bound from the literature, or measured once with a stated margin and recorded. It is never adjusted to make a failing test pass;
- (d) **domain:** overflow and underflow ranges excluded, and how subnormals, NaN, $\pm$Inf and $-0$ behave;
- (e) **scope:** per target only, or also a cross-target forward comparison, which is allowed only for well-conditioned outputs (§2).

Examples:
- **`A\b`, square and nonsingular:** normwise backward error $\|Ax - b\| / (\|A\|\|x\| + \|b\|) \le c\,n\,\varepsilon$.
- **`A\b`, least squares (non-square A):** a least-squares backward error, such as $\|A^T r\| / (\|A\|\,\|r\|)$ with $r = b - Ax$, or the Waldén–Karlson–Sun bound. The residual itself isn't small.
- **`A\b`, rank-deficient A:** MATLAB's warning `Rank deficient, rank = r, tol = …` is a §1 exact-match item, in its structure and form and in its tolerance rule, with Octave as the oracle where MATLAB's documentation is silent.
- **`eig` of a symmetric matrix:** each value within $c\,n\,\varepsilon\|A\|_2$ (Weyl), forward and cross-target.
- **`[V, D] = eig(A)` in general:** the residual $\|AV - VD\| \le c\,n\,\varepsilon\|A\|\|V\|$, per target.
- **`svd`:** $\|A - U\Sigma V^T\| \le c\,n\,\varepsilon\|A\|$ per target, and singular values forward within $c\,n\,\varepsilon\|A\|_2$.
- **The FFT:** per variant. Relative $\ell_2$ error at most $c\,\varepsilon\log_2 n$ for powers of 2, and a larger stated $c$ for Bluestein.
- **`exp`, `sin`, `pow`, `gamma`, `erf` and the like:** a bound per function, in ulps, measured against mpmath across the function's whole domain. The sweep includes huge arguments (trigonometric argument reduction), subnormals, and arguments near zero crossings and in the tails. Sagebrush's own Rust implementations make a claim per function with its sweep, never a blanket "1 ulp", and the entry flags when a platform libm is used instead.
- **`ode45` and the other ODE solvers:** MATLAB documents RelTol and AbsTol as a local, per-step test (odeset: at each step the solver estimates the local error in each component, and the step must have acceptable error). The contract is that acceptance test, checked on the solver's own error estimate. Plus a global-error check on named test problems, $\|y - y_{\mathrm{ref}}\| \le C \cdot \mathrm{tol}$, with $C$ measured and recorded per problem, not tuned. Global error can exceed the tolerances by the problem's stability factor, and that isn't a defect.

**mpmath as the reference** computes at a working precision high enough to round correctly to double: at least twice the bits, re-evaluated at higher precision (Ziv-style) when the result is close to a rounding boundary, and higher still for ill-conditioned inputs.

**Never bitwise against MATLAB.** MATLAB's own results change across versions, BLAS libraries and CPUs. A test that pins MATLAB's last digits pins an accident.
- Where a published MATLAB example prints values, the comparison is at the digits displayed: `format short` rounds, so a match there means agreement to that display.
- Where an algorithm's choice is visible in the result (an eigenvector's sign, the basis `null` returns, an SVD's signs), we document our normalization and test it. We don't claim MATLAB's choice unless its documentation states one.

**Where MATLAB and Octave disagree, MATLAB wins.** Its documentation, or an observed MATLAB run, decides. Octave decides where MATLAB's documentation is silent, as design/matlab.md already does ("Where MATLAB and Octave differ").

## 2. Determinism: native and wasm

These rules apply to engine/nd (numerics-core r4.2 §7) and everything built on it. Throughout, $\varepsilon = 2^{-53}$, $K$ is a product's inner dimension, and $\gamma_K = K\varepsilon/(1-K\varepsilon)$, for $K\varepsilon < 1$. ($k$ alone is E's error factor, §3.)

**Bitwise:**
- **Thread counts and partitions.** Each reduction's order doesn't depend on the thread count, the partition or the tile shape. One backend and kernel gives the same bits on 1 thread and 16.
- **One target, run to run.** No data-dependent scheduling and no atomics in a sum.

**One summation order on every target.** Two kinds of kernel, each with an order fixed independently of the hardware's SIMD width:

- **Products (GEMM and everything blocked on it: LU, Cholesky, triangular solves with many right-hand sides).**
  - SIMD runs across output elements, never along a dot product.
  - Each element of C is summed over its inner index in order: the KC blocks in order, and within a block $p = 0, 1, \ldots$; each block's partial sum is then added into C.
  - That's engine/nd's rule today, and it holds for any vector width.
  - Consequence, accepted: the inner dimension $K$ is never split across threads. That costs parallelism for tall-skinny products (small $m n$, large $K$), which run on fewer threads than cores.
- **Reductions along one vector** (sum, dot, norm, `A'*x` by columns, the mean in `std` and `var`).
  - A **canonical 8 accumulators**: element $i$ goes to partial sum $s_{i \bmod 8}$, in order of $i$.
  - The partial sums combine in a fixed tree, $\big((s_0+s_4)+(s_2+s_6)\big)+\big((s_1+s_5)+(s_3+s_7)\big)$. Elements that don't fill a full group of 8 just continue the round robin.
  - Every target emulates exactly this. The scalar reference keeps 8 scalars, wasm SIMD128 and NEON keep four 2-lane vectors, and AVX2 keeps two 4-lane vectors (AVX-512 later: one 8-lane vector).
  - So there is one reduction order and one scalar reference for every target.

**Across targets, the only difference is FMA**, and only in kernels whose multiply-adds may fuse (GEMM's microkernels, as selected per target).
- Kernels without FMA give the scalar reference's bits.
- FMA kernels give the scalar `mul_add` reference's bits.
- For a length-$K$ product, the two references differ by at most $2\gamma_K\sum_i|a_ib_i|$, since each is within $\gamma_K\sum|a_ib_i|$ of the exact value.
- Reductions never fuse: each accumulator adds products rounded separately, so reductions are bitwise across targets.

**Element-wise functions** (`exp`, `sin`, `log`, `gamma`, ...), where Sagebrush computes them itself in Rust:
- No `mul_add` in their code, and no floating-point contraction. Rust doesn't contract unless asked.
- A test checks that the generated code has no fused multiply-adds in these functions: the wasm, and the native builds' disassembly (x86-64 with `+fma`, aarch64). Any third-party libm crate they call is audited for internal `fma`.
- So they're bitwise across targets.
- (The other choice, `mul_add` everywhere, would be correct everywhere but slow in wasm, where FMA is in software.)
- Where a target uses the platform's libm instead, the bound is the per-function bound measured for it (§1), and the catalog entry flags it.

**Iterative dense algorithms and anything that decides by comparison** branch on comparisons. That covers QR iteration for `eig` and `svd`, Jacobi sweeps, partial pivoting in LU, column pivoting in QR, and the tolerance tests in `rank`, `null`, `orth` and `pinv` (convergence tests, deflation, shift choices, pivot choices, rank decisions).
- An FMA difference in their inner products can change an iteration count or a deflation point.
- Discrete outputs can differ across targets near a tie or the tolerance: the pivot vector P, `rank`'s integer, the dimension of `null`'s basis.
- So each target's result meets the algorithm's backward or residual bound on its own: it is the exact result for a nearby input. Two backward-stable results can still be far apart in forward terms. Near a Jordan block of size $m$, eigenvalues move by about $\varepsilon^{1/m}$; `null` and `orth` bases rotate; eigenvectors of close eigenvalues mix.
- So their cross-target tests check each target's residual or backward bound separately, never the distance between targets' outputs. A forward comparison across targets is made only for well-conditioned outputs, such as symmetric eigenvalues (Weyl) and singular values, and the `accuracy` field's scope says which.
- **Their metered units are bitwise per target, and across targets only for non-iterative kernels.** So E is calibrated per target (§3).
- (Unlike the Smith and Hecke work, which reproduces units across native and wasm.)

**Tests:** each function's test runs the same inputs on every target CI executes. It checks bitwise where this section says bitwise, otherwise each target against the stated bound, per the `accuracy` field's scope. The 8-accumulator order is tested against the scalar reference on lengths 0 to 33 and on large lengths, with NaN, $\pm$Inf, $-0$ and subnormals placed in each accumulator lane.

## 3. Cost

The engine cost policy r4 applies unchanged:
- **L:** refuses only for memory, wasm32's 4 GiB, reply size or the user's time budget.
- **E:** a calibrated estimate in seconds on this machine, given the number of cores.
- **k:** E's measured error factor.
- **U:** an optional promise, never a refusal.
- **TimeError:** raised above the notebook budget. Refusing work that would have finished is a defect.

**Metering** (the Family list's owner ruled on this, Nov 21). Three families, appended after Other so that existing indices and every integer-side pin keep their meaning:
- **FlopBlocked:** flops of cache-blocked, compute-bound kernels. That's GEMM and the Level-3 parts of LU, Cholesky, QR, and the Hessenberg and tridiagonal reductions.
- **FlopStream:** flops of memory-bound kernels: dot, axpy, gemv, triangular solves with one right-hand side, unblocked panel work, element-wise `+ - .* ./ sqrt`, and FFT butterflies.
- **FlopFn:** one unit per call of a library elementary function (`exp`, `log`, `sin`, `power`, ...), which costs tens of flops and isn't flop-counted.

How they're charged:
- **The unit is one flop:** a multiply or an add is 1, an FMA is 2. That matches the textbook counts below, so the model's terms are the published formulas, and the counts don't depend on whether a target fuses.
- **Memory traffic** stays on Move: one unit per 8-byte word copied without arithmetic.
- **Leaf rules unchanged:** charge after the work, at the kernel that does it, with Stop-prefix pins and moved-charge mutants. Never charge work not done: an early exit charges its actual iterations.
- The PR that adds the families updates every pin that prints the full Units vector, mechanically.

**The model.** For each kernel, target and thread count:

$$E = c_0 + \sum_{f} \frac{\text{units}_f}{r_f(n)}$$

for the families $f$ the kernel charges (for most kernels, one Flop family dominates).

- $c_0$ is the call and dispatch overhead.
- $r_f(n)$ is the calibrated rate, piecewise over the calibrated sizes, which captures cache effects.
- The calibration is as on track/math: at least 20 rows over at least 5 sizes spanning two decades, including $n$ in 10 to 50, where agents' calls mostly are. Each kernel reports its $k$, the p90 over rows of $\max(\text{actual}/E,\ E/\text{actual})$.
- Beyond the calibrated range, $k$ widens and `cost()` says "extrapolated".

**Flop counts, and how each kernel is treated:**

| kernel | flops (leading term) | treatment |
|---|---|---|
| GEMM $m\times k$ by $k\times n$ | $2mnk$ | direct: E from flops |
| LU, square | $\frac{2}{3}n^3$ | direct |
| Cholesky | $\frac{1}{3}n^3$ | direct |
| QR (Householder), $m\ge n$ | $2mn^2 - \frac{2}{3}n^3$ | direct |
| triangular solve, $r$ right-hand sides | $n^2 r$ | direct |
| Hessenberg reduction | $\frac{10}{3}n^3$ | direct |
| tridiagonal reduction (symmetric) | $\frac{4}{3}n^3$ | direct |
| symmetric eig, values / with vectors | $\frac{4}{3}n^3$ / about $9n^3$ | direct-like (see below) |
| nonsymmetric eig, values / with vectors | about $10n^3$ / about $25n^3$ | direct-like |
| SVD (Golub–Kahan bidiagonalization, then implicit QR), $m\ge n$, values / with vectors | $4mn^2-\frac{4}{3}n^3$ / about $4m^2n+8mn^2+9n^3$ | direct-like |
| FFT, power of 2 / other lengths (Bluestein) / real input | $5n\log_2 n$ / about $3\times$ that at the padded length / about $\frac12\times$ | direct |
| `eigs`, `ode*`, `fzero`, `fmin*`, `integral*`, `lsq*` | depends on the problem | iterative: no E up front; metered through their pieces with progress and ETA; E "unknown" until calibrated |

**Direct-like.** The dense eigensolvers and SVD iterate, but their iteration counts are nearly constant per size in practice. So E uses the leading-term counts above, and the reduction phase dominates. That's stated as a model, not a bound: their $k$ is measured like any other kernel's. Inputs where the iterations run unusually long show up as rows with large actual/E, and are reported, not hidden.

**L per kernel**, the rigorous lower bound and the only refusal. It's what the shipped route necessarily holds, the output plus unavoidable workspace, in bytes for real f64 input, doubled for complex, and never more: an L above what the code holds refuses calls that would fit, which r4 counts as a defect. Each kernel PR derives L from that kernel's actual buffers at their peak, lowered where storage is reused or freed early, and pins it from its definition at one known size.

L counts what the op itself allocates (the input is the caller's), per MATLAB call form, not per kernel. The table below is the kernel's floor. Each catalog op adds the outputs it returns, by nargout and options: `[L, U, P] = lu(A)` returns L and U separately plus P as a full $n \times n$ matrix unless `'vector'`, about $3 \cdot 8n^2$; `A\b` keeps A, so it adds an $8n^2$ copy. The kernel floors, for the routes we expect:

| kernel | L |
|---|---|
| GEMM | $8mn$ (C) |
| LU in place | $8n^2$ + pivots $4n$ |
| QR, economy / full | $8mn + 8n$ / $8m^2 + 8mn$ |
| Cholesky | $8n^2$ |
| eig, values / with vectors (`[V, D] = eig(A)`, real input) | $8n^2 + 16n$ / V and the full D, $2\cdot 8n^2$, plus a third $8n^2$ only if the route keeps the Hessenberg/Schur working copy apart from D's storage: $2\cdot8n^2$ or $3\cdot8n^2$ by route, stated and pinned in the eig PR (complex V doubles V's term) |
| SVD, values / economy vectors | $8mn + 8n$ / $8(mn + n^2 + n)$, plus another $8mn$ only if the route keeps the bidiagonalized copy apart from U: stated and pinned in the SVD PR |
| FFT of length $n$ | $16n$ out, $+16n'$ for Bluestein's padded length $n'$ |

- Pivots count 4 bytes each, the floor on every target: they're `usize`, which is 4 bytes on wasm32.
- Each L is computed with checked arithmetic. An overflow refuses as "out of memory", and an extremes test covers sizes near `usize::MAX` and the wasm32 4 GiB limit.
- **Outputs of unknown size** (ode45 with a 2-element tspan, whose output grows per step; `find`; `unique`) can't be refused up front. The ledger charges as the output grows, and refuses only at the step that exceeds memory.

**Performance target, against a native BLAS.** Each kernel's speed is reported as a fraction of OpenBLAS's on the same machine and thread count (NumPy 2.5.1's scipy-openblas).
- The targets are **tracked, never gated**: CI never fails on wall-clock time.
- **Measurement hygiene:**
  - a quiet spot VM;
  - the same thread count on both sides (`OPENBLAS_NUM_THREADS` set, engine/nd's thread count set);
  - column-major input on both sides (Fortran-ordered NumPy arrays);
  - warm-up runs, then the median of at least 7.

Targets for r1, re-set once measured:

| kernel, $n = 1000$ | native (AVX2+FMA), 1 thread | native, all cores | browser wasm SIMD, 1 thread |
|---|---|---|---|
| GEMM | at least 50% of OpenBLAS | at least 35% | at least 15% of native OpenBLAS, 1 thread |
| LU solve `A\b` | at least 40% | at least 25% | at least 10% |
| Cholesky | at least 40% | at least 25% | at least 10% |
| symmetric eig | at least 25% | none yet | at least 5% |

An indicative run today, on a shared 16-core host with other jobs running, so it's noisy:
- `A*B` at $n=1000$ ran at 26 GF/s against OpenBLAS's 170 GF/s on all cores.
- `eig` at $n = 1000$ (nonsymmetric) took 4.2 s against NumPy's 1.0 s.
- **The `A\b` outlier is explained.** `A\b` took 1.6 s at $n = 500$ and 0.03 s at $n = 501$. The solve itself is fast; the time goes to the "nearly singular" check after it.
  - lib/_matlab.py `_rcond_warning` estimates rcond only for $n \le 500$.
  - It refactors A with a Python loop of unblocked rank-1 updates (`_lu_factors`) and runs the estimator's triangular solves row by row in Python (`_tri_solve`).
  - So every solve up to 500 rows paid for a second, slow LU. Above 500 rows the check was skipped, and a nearly singular matrix bigger than that never warned, which breaks §1's contract.
  - The fix, in the measurement PR: estimate rcond from the factors the solve already computed, with engine/nd's `gecon` (the same Higham/dlacn2 algorithm, already tested against the Python one), for every $n$. That removes both the cost and the 500-row cap, and a test pins that a nearly singular $n = 600$ matrix warns.

## 4. Where we start

**The two top-20 lists.** One list, from Claude asked as an agent writing MATLAB, is functions:
- array semantics; `\`; eig/eigs; svd, pinv, rank, norm and cond; lu, qr and chol; fft;
- ode45/ode15s; interpolation; polynomials; root finding and optimizers; quadrature;
- reductions and sets; constructors with `rng`; plotting; data I/O and `table`; strings; structs and cells;
- sparse; conv/filter; display formatting.

A fresh Codex (codex-cli 0.159.2, no context, Nov 21) answered with features:
1. array operations;
2. vectorization and implicit expansion;
3. logical indexing;
4. functions and local functions;
5. size, reshape, permute and concatenation;
6. built-in solvers (`\`, optimization, integration, ODEs);
7. `arguments` blocks;
8. tables and timetables;
9. plotting;
10. `matlab.unittest`;
11. debugging (`dbstop if error`);
12. data I/O (MAT, CSV, spreadsheets);
13. preallocation;
14. function handles;
15. structs and cells;
16. strings;
17. missing-data handling;
18. `profile`/`timeit`;
19. error identifiers and try/catch;
20. packages and the path.

**The core is the overlap:**
- arrays and indexing;
- the solvers (`\`, optimization, quadrature, ODEs);
- plotting;
- data I/O and tables;
- strings;
- structs and cells;
- function handles;
- error identifiers.

Each item on either list falls in one of four groups below. "Present" here means the runtime knows the name (`exist` is nonzero on track/numeric at 77f04576), not that every option is done. The catalog's `status` field says partial or full per function.

- **Present** (refine options, accuracy statements and tests):
  - array semantics, indexing and implicit expansion; size, reshape, permute and cat;
  - `\`, eig, eigs, svd, pinv, rank, norm, cond, lu, qr, chol, det, inv, expm, null and orth;
  - fft, ifft and fft2;
  - ode45 and ode23; fzero, fminsearch and fminbnd; integral, integral2, trapz and cumtrapz;
  - interp1, interp2, spline and pchip; polyfit, polyval and roots;
  - the reductions and sets;
  - linspace, logspace, meshgrid, rand, randn, randi and rng;
  - plotting: plot, figure, subplot, tiledlayout/nexttile, labels, legend, surf, contour, histogram, scatter and fplot;
  - sprintf, fprintf, num2str, mat2str, regexp, strsplit and string;
  - structs, cells, cellfun and arrayfun;
  - sparse, spdiags and sparse `\`;
  - conv, filter and deconv;
  - local functions, `arguments` blocks with validators, packages and the search path;
  - try/catch, MException, error identifiers (#1380 adds 28 more), save/load of MAT files, tic/toc and profile, jsonencode/jsondecode.
- **Missing, on both lists or in the overlap (first PRs, in this order):**
  1. `table` with readtable, writetable, readmatrix, writematrix and readcell/writecell. Both lists have data I/O, and Codex has tables. This is the biggest gap.
  2. Missing data: ismissing, rmmissing, fillmissing (with `standardizeMissing`).
  3. validateattributes and inputParser. Older argument validation, still everywhere in agents' code. #1380's run shows validateattributes's identifiers.
  4. ode15s, the stiff solver, and ode113.
  5. Optimization Toolbox: lsqnonlin, lsqcurvefit and fmincon (interior point and SQP, on what engine/nd gives), then fminunc, linprog and quadprog.
  6. `matlab.unittest`: TestCase, the verify/assert methods, runtests. Codex ranks testing tenth; agents use it to check their own work.
  7. timeit, bsxfun, griddedInterpolant, datetime/duration, containers.Map.
- **Depends on other work:** classdef, which is in progress; `matlab.unittest` needs it.
- **Out of scope for now:** Simulink, App Designer and GUIs, Java, MEX, the Parallel Computing Toolbox (parfor runs serially, as now).

engine/nd today has GEMM, LU, Cholesky, triangular solves and condition estimates, with per-target microkernels. The eigensolvers, SVD, QR and FFT run in Sagebrush's numpy over the runtime. Moving them onto engine/nd, under the §2 rules and the §3 targets, is the ENGINE-lane part of the track, taken one kernel at a time after the gaps above.

## 5. The Symbolic Toolbox subset

The goal (Nov 21): "a drop in replacement for a subset of this, based on what's in sagebrush now (e.g., plotting, integration, etc.)".

**Scope (r1):**
- syms, sym;
- diff, int, limit, taylor and series;
- solve;
- simplify, expand, factor and subs;
- vpa and digits;
- dsolve and matlabFunction;
- fplot and fsurf of a symbolic expression;
- laplace, ilaplace and fourier, after the first PRs.

**The engine under it is Sagebrush's own symbolic code.** That's the Sage-mode symbolic ring (engine/sym, and mpmath-core for vpa) that Sage mode already uses for `diff`, `integrate`, `limit`, `taylor`, `solve` and `simplify`. MATLAB mode's `sym` is a thin class over the same objects, so there's one implementation, as with Magma and Sage (no MATLAB-only mathematics).

**MATLAB's surface, as its documentation states it:**
- `syms x y real` declares symbols with assumptions;
- `sym(1/3)` is the exact rational 1/3 (the `'r'` default flag);
- `sym('x')` makes a symbol;
- arithmetic and functions on `sym` return `sym`;
- `double(s)` converts back;
- `subs(f, x, 2)` substitutes;
- `vpa(s, d)` evaluates to `d` significant digits (default `digits` 32);
- `int(f, x, a, b)` is the definite integral;
- `solve(eqns, vars)` returns solutions as documented: a vector for one variable, a struct of fields for several;
- `matlabFunction(f)` returns a function handle that computes numerically;
- `fplot(f)` plots it through the MATLAB plotting already there.

Display uses MATLAB's documented form for `sym` (`ans =` then the expression); `pretty` and `latex(s)` come later.

**The oracle is the documented behaviour, compared up to mathematical equivalence, never against MATLAB's text.**
- **How two answers are compared:** `simplify(a - b) == 0`. Where the symbolic engine can't decide that, numerical agreement at several random points, and the test says which was used.
  - The points are drawn from the declared assumptions' domain (real, positive, ...), away from branch cuts.
  - The comparison is to 30 digits, with both sides evaluated by mpmath at higher precision (50 digits), using a relative tolerance and allowing for cancellation.
- **`double(s)`** promises the correctly rounded double. **`vpa(s, d)`** promises $d$ correct significant digits, computed with guard digits.
- **Output normalization, stated per function and pinned in tests:**
  - polynomials in expanded form, in descending powers of the first variable;
  - rationals in lowest terms, sign in the numerator;
  - `solve`'s solutions sorted (real before complex, then by value);
  - constants of integration omitted (`int` of an indefinite integral, as MATLAB);
  - `dsolve`'s constants named `C1, C2, ...`.

  Where MATLAB's documentation shows a specific printed form for an example, the catalog example pins our printed form and says whether it matches MATLAB's text or only its meaning.
- **Not claimed:** MuPAD's simplification choices. Two equivalent forms are both correct, and our `simplify` documents what it tries.

## 6. Oracles and CI

The ruling for this track:
- **Octave** is authoritative for semantics, under §1's MATLAB-first rule.
- **mpmath** is the reference for accuracy.
- **NumPy/SciPy** is a second reference: it disagrees with us only for a reason we can name.

They run in a separate **oracle** CI job, not the main `ci` job. Two things trigger it:
- **On a PR:** path-filtered to lib/_matlab*.py, src/matlab.ts, engine/nd, engine/sym's MATLAB surface, matlab-tests/ and catalog/matlab/.
- **Nightly** on track/numeric and master.

The job runs:
- matlab-tests/run.py against Octave (as now, moved there);
- a new accuracy sweep: each function's `accuracy` statement checked against mpmath on generated inputs, including ill-conditioned ones, near singularities and large sizes;
- §2's cross-target checks.

The main job keeps today's fast MATLAB tests (pinned outputs, no oracle at run time).

## 7. Lanes and order

**Lanes:**
- **NUMERIC:** the numeric reviewer. Owns §1's contract and each function's accuracy statement.
- **ENGINE:** the engine reviewers, only for PRs that touch engine Rust (engine/nd, engine/sym) or metering. Owns §2 and §3; the Flop families belong to the meter Family list's owner.
- **TESTS:** owns oracle coverage, cross-target checks and E drift.

**Merging:** the track's maintainer merges into track/numeric on the coordinator's GO.

**Order:**
1. This note, cleared by NUMERIC and ENGINE.
2. A measurement PR: §3's table, measured on a spot VM, and the `A\b` fix (rcond from the solve's own factors by `gecon`, for every size).
3. The §4 gaps in order, each PR a gap or two with its oracle tests.
4. The symbolic subset begins once the table/missing-data PRs are in. Its first PR is `sym`/`syms`/`subs`/`diff`/`double` over the Sage-mode objects.

## 8. Roadmap: threads, accelerated backends, GPU

Direction, Nov 21: "keep: multithreaded and accelerated, and possible GPU use on the roadmap". Nothing here is a design commitment beyond this: the interfaces must not preclude any of it.

- **Multithreaded is a first-class target, not an afterthought.**
  - §2 already makes results bitwise across thread counts.
  - The all-cores column of §3's performance table stands, and kernels must scale with cores.
  - E takes the thread count as an input (policy r4), so an agent sees what more cores buy.
- **Accelerated backends sit behind the same catalog op.**
  - The kernel interface stays pluggable: today's per-target SIMD microkernels, and later, optionally, a vendor BLAS/LAPACK or Apple's Accelerate on native.
  - Each backend states its own accuracy and determinism class (§2): bitwise, FMA-only difference, or within the op's stated accuracy.
  - The backend a result came from is recorded with it, as engine/nd records its kernel today.
- **GPU is on the roadmap:** WebGPU in the browser, CUDA or Metal on native. When it lands:
  - It's a separate determinism class: never bitwise, values within the op's stated accuracy.
  - It's opt-in, and never required for correctness: every op keeps a CPU route.
  - It's metered with its own families, under the meter Family list's owner, and E is calibrated per device like any other target.

**Obligations of a backend.** Every future backend PR is held to these:
1. **f64 on GPUs.** WGSL (WebGPU) and Metal have no f64, so those routes either serve only single-precision work, with single-precision accuracy statements, or emulate double (for example double-single arithmetic) with its own measured bound. The PR says which. A double op computed in f32 can't meet a double's stated accuracy.
2. **GPU reductions.** Reductions that use atomics or schedule order aren't bitwise even run to run, or across launch configurations. §2's "one target, run to run" holds on a GPU only where a deterministic reduction is chosen, and the class says which.
3. **Vendor BLAS/LAPACK** (MKL, OpenBLAS, Accelerate). Results generally vary with the thread count and the detected CPU unless a reproducibility mode is set (for example MKL's CNR). The backend's class either states that variability, as an explicit exception to §2's bitwise-across-threads rule, or requires the mode.
4. **Subnormals.** Each backend states its subnormal handling (flush-to-zero, denormals-are-zero, or full), and the special-value tests run per backend.
5. **Metering an opaque backend.** The wrapper meters it: the textbook flop formula for the call, charged after it returns, to the same families, with the backend recorded. Large calls are tiled (GEMM by panels, GPU launches likewise), so Stop answers within the coarse-check budget.
6. **Units, E and L per backend.** Units and E are per backend. A GPU's L counts device memory as well as host memory.
