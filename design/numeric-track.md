# The numeric track

*November 21, 2026, r1.* track/numeric is where MATLAB mode's numerical
side grows: the functions an agent reaches for when it writes MATLAB, and a
subset of the Symbolic Toolbox. It works like track/math: PRs go into
track/numeric, and the track is pulled into master. This note settles what
"compatible" means there, how results may differ between targets, what
things may cost, where the work starts, and how it is checked.

"MATLAB users" now mostly means agents (Claude, Codex) directed by people.
So the priorities are the agents' own: what they would write first (§4).

## 1. The compatibility contract

Two kinds of behaviour, held to two standards.

**Matched exactly.** Everything a program can branch on, or that a person reads as structure:

- **Shapes and classes:** `size`, the class (`double`, `single`, integer classes, `logical`, `char`, `string`, `cell`, `struct`), complexity (`isreal`), and sparsity (`issparse`).
- **Errors:** which inputs raise, and the identifier. Identifiers come only from a MATLAB-printed source (an observed MATLAB run, or the documentation's text); otherwise the identifier is empty, never guessed. The message keeps Sagebrush's wording unless a test pins MATLAB's.
- **Warnings:** which inputs warn (singular matrix, nearly singular with the RCOND value's form, iteration limits), and the identifier where MATLAB prints one.
- **Edge cases:** empty inputs and their shapes (`sum(zeros(0,3))` is `zeros(1,3)`), `NaN` and `Inf` propagation, `-0` where MATLAB's documentation says so, dimension arguments, `'omitnan'`, integer saturation and rounding, and implicit expansion's rules.
- **Exact values:** results whose value is defined exactly. These are integer-valued results, sorting and set results with their index outputs, `find`, logical results, the order of `eig`'s values where it is documented, and display formatting (`disp`, `format`, `mat2str`, `num2str`), which scripts parse.
- **Random numbers:** `rand`, `randn` and `randi` after `rng(seed)` give MATLAB's numbers (already so: design/matlab.md).

**Matched within a stated accuracy.** Floating-point values from an algorithm:
- linear algebra, eigen- and singular values, FFTs, ODE solutions, quadrature, optimizers, interpolation and special functions.

Each function states its bound in its catalog entry: `accuracy`, in ulps or as a relative or residual bound. Some examples:

- `A\b`: normwise backward error at most $c \cdot n \cdot \varepsilon$, checked as $\|Ax - b\| / (\|A\|\|x\| + \|b\|)$;
- `eig` of a symmetric matrix: each value within $c \cdot n \varepsilon \|A\|$;
- `exp`, `sin` and the like: within 1 ulp of the correctly rounded value, checked against mpmath;
- `ode45`: the documented RelTol/AbsTol contract against a high-precision reference solution, not MATLAB's step sequence.

**Never bitwise against MATLAB.** MATLAB's own results change across versions, BLAS libraries and CPUs. A test that pins MATLAB's last digits pins an accident.
- Where a published MATLAB example prints values, the comparison is at the digits displayed: `format short` rounds, so a match there means agreement to that display.
- Where an algorithm's choice is visible in the result (an eigenvector's sign, the basis `null` returns, an SVD's signs), we document our normalization and test it. We don't claim MATLAB's choice unless its documentation states one.

**Where MATLAB and Octave disagree, MATLAB wins.** Its documentation, or an observed MATLAB run, decides. Octave decides where MATLAB's documentation is silent, as design/matlab.md already does ("Where MATLAB and Octave differ").

## 2. Determinism: native and wasm

Rules for engine/nd (numerics-core r4.2 §7) and everything built on it:

- **Thread counts and partitions:** bitwise. Every reduction (a GEMM's dot products, a sum, a norm) has a fixed order that doesn't depend on the thread count, the column partition or the tile shape. One backend and kernel gives the same bits on 1 thread and 16.
- **One target, run to run:** bitwise. No data-dependent scheduling and no atomics in a sum.
- **Across targets** (portable scalar, wasm SIMD128, AVX2+FMA, NEON): within a bound stated per function, in the same `accuracy` field as §1.
  - Kernels without FMA reproduce the portable scalar kernel's bits.
  - FMA kernels reproduce the scalar `mul_add` kernel's bits.
  - So the difference between two targets is exactly the FMA/non-FMA difference. Its bound for a length-$k$ dot product is that of the two summations, at most $2k\varepsilon\sum|a_ib_i|$ apart.
- **SIMD reduction order is part of the kernel's definition:** lane-wise partial sums combined in a fixed order. It's the same order in every SIMD kernel of a given width, and a scalar kernel of that width reproduces it. A new kernel that changes the order is a new kernel, with its own test against the scalar reference.
- **Element-wise functions** (`exp`, `sin`, ...): bitwise across targets wherever Sagebrush computes them itself, as one Rust implementation. Where a target uses the platform's libm, the bound is 1 ulp, and the test says which.
- **Tests:** a per-function test runs the same inputs on every target CI executes, and checks bitwise where this section says bitwise, otherwise the stated bound.

## 3. Cost

The engine cost policy r4 applies unchanged:
- **L:** refuses only for memory, wasm32's 4 GiB, reply size or the user's time budget.
- **E:** a calibrated estimate in seconds on this machine, given the number of cores.
- **k:** E's measured error factor.
- **U:** an optional promise, never a refusal.
- **TimeError:** raised above the notebook budget. Refusing work that would have finished is a defect.

Dense kernels are where E can be tight, because their work is known exactly:
- GEMM: $2mnk$ flops;
- LU: $\frac{2}{3}n^3$;
- Cholesky: $\frac{1}{3}n^3$;
- QR: $\frac{4}{3}n^3$ for square input;
- the symmetric eigenproblem: about $\frac{4}{3}n^3$ for values alone, and about $9n^3$ with vectors;
- the FFT: $5n\log_2 n$.

So E for these is flops divided by the calibrated flop rate for that kernel, target and thread count. The rate comes from the same calibration harness as the other families: 20 or more rows over 5 sizes spanning two decades. Iterative routines (eigs, ode45, fzero, fminsearch, integral) get no time estimate up front. They meter through their pieces, with progress and ETA, and E is "unknown" until calibrated, said honestly.

**Performance target, against a native BLAS.** Each kernel's speed is reported as a fraction of OpenBLAS's speed on the same machine and thread count (NumPy 2.5.1's scipy-openblas), measured on a quiet spot VM, not a shared one. Targets for r1, to be re-set once measured there:

| kernel, $n = 1000$ | native (AVX2+FMA), 1 thread | native, all cores | browser wasm SIMD, 1 thread |
|---|---|---|---|
| GEMM | at least 50% of OpenBLAS | at least 35% | at least 15% of native OpenBLAS, 1 thread |
| LU solve `A\b` | at least 40% | at least 25% | at least 10% |
| Cholesky | at least 40% | at least 25% | at least 10% |
| symmetric eig | at least 25% | none yet | at least 5% |

An indicative run today, on a shared 16-core host with other jobs running, so it's noisy:
- Sagebrush's MATLAB mode under node ran `A*B` at $n=1000$ at 26 GF/s; NumPy/OpenBLAS ran at 170 GF/s on all cores.
- At $n = 1000$, `eig` of a general matrix took 4.2 s, against NumPy's 1.0 s.
- At $n = 500$, `A\b` was far off in one run (1.8 s, against 0.05 s), which needs looking into first.

The first track PR measures all of these properly and records them in the note's r2.

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
- **How two answers are compared:** `simplify(a - b) == 0`. Where the symbolic engine can't decide that, numerical agreement at several random points to 30 digits by mpmath, and the test says which was used.
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
- **ENGINE:** the engine reviewers, only for PRs that touch engine Rust (engine/nd, engine/sym) or metering. Owns §2 and §3.
- **TESTS:** owns oracle coverage, cross-target checks and E drift.

**Merging:** the track's maintainer merges into track/numeric on the coordinator's GO.

**Order:**
1. This note, cleared by NUMERIC and ENGINE.
2. A measurement PR: §3's table, measured on a spot VM, and the `A\b` outlier explained.
3. The §4 gaps in order, each PR a gap or two with its oracle tests.
4. The symbolic subset begins once the table/missing-data PRs are in. Its first PR is `sym`/`syms`/`subs`/`diff`/`double` over the Sage-mode objects.
