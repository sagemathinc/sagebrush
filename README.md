# Sagebrush

Fast, certified, parallel engines for research mathematics, written in Rust
and usable from Python and JavaScript.

Sagebrush is an early experiment from the founder of SageMath. The idea:
mathematicians, and the AI agents working with them, should be able to ask
large questions (thousands of levels, millions of objects) and get results
in seconds. Every result should come with a status saying whether it is
*proven* or only heuristic. The design is many small, strong engines that
share one core, not one huge system.

Status: early, unpublished. Engines for modular symbols and newforms, a_p
of elliptic curves, polynomials over Z, and class groups and units of number
fields; a Python front end in the browser with Sage and Magma modes.

## Principles

These define what Sagebrush is.

1. **Rust at the core.** The mathematics is written in Rust: fast,
   memory-safe, and one code base from a browser tab to a 64-core server.
   Python, JavaScript, Sage and Magma are thin interfaces over it.
2. **Permissive licenses.** Sagebrush is MIT OR Apache-2.0, so anyone,
   and any agent, can use it, embed it or ship it, with no conditions on
   the code it ends up in. Serious research mathematics software has so far
   been either GPL (PARI, Sage, FLINT) or closed (Magma, Mathematica).
   Sagebrush is deliberately neither, and deliberately not Sage: it is a
   component meant to be usable anywhere. No GPL code is linked into an
   engine. GPL systems are used only from the outside, as oracles in tests
   and as benchmarks. They are never dependencies, and never sources to
   port. Algorithms are implemented clean-room from the literature or with
   the copyright owner's permission. An independent implementation has
   mathematical value of its own: when it agrees with PARI, that is
   evidence about both.
3. **Portable and lightweight.** Pure Rust, with no C libraries (no GMP,
   FLINT or PARI) and no build system beyond `cargo`. So every engine also
   compiles to WebAssembly and runs wherever WebAssembly runs: in the
   browser, in Node, in a chat artifact, and in CPython through the same
   code. The whole engine is one 1.4 MB `.wasm` file.
4. **Asymptotically fast.** Performance is measured as the inputs grow,
   against the best existing system, and published as tables with every
   number. The goal is to win on the large computations that research needs,
   not on toy sizes.
5. **Proven, or labelled.** Every result says what it rests on: *proven*,
   *conditional on GRH*, or *heuristic*.
6. **Familiar, checked interfaces.** Sage's and Magma's APIs are consistent,
   documented and known to mathematicians, so Sagebrush speaks both. The test
   suites check printed output byte for byte against Sage and Magma
   themselves. Every engine also has a plain-data API (lists, ints, dicts)
   for programs and AI agents.
7. **Small strong engines, one core.** Many focused engines sharing
   arithmetic and linear algebra, not one monolith.

## What works today

**`ap`**: traces of Frobenius a_p of elliptic curves over Q at all primes up
to a bound. It is a from-scratch Rust port of the genus-1 strategy of Drew
Sutherland's smalljac. Its output matches smalljac exactly (every prime to
10^6, checksums to 10^8) and matches Sage below 20000. On 16 threads it
beats smalljac's own 16-process mode at 10^7; on one core it is
1.2-1.6x slower. See [results/ap.md](results/ap.md).

**Rational newforms** (in `modsym`): every rational newform of level N and
its a_p, found by splitting with integer Hecke eigenvalues in the Hasse
range. It reproduces Cremona's tables exactly for every conductor up to
9999 (38,042 isogeny classes) in 14 minutes on 16 cores, and agrees prime
by prime with point counts from `ap`. See
[results/newforms.md](results/newforms.md).

**Class groups and units** (`engine/classgroup`, MIT/Apache, clean-room;
see [its README](engine/classgroup/README.md)):

- **Imaginary quadratic fields:** Jacobson's sieve. Up to 44x faster than
  PARI's `quadclassunit` (10^47: 5.4 s against 219 s).
- **Real quadratic fields:** class group and regulator. Faster than PARI
  from 10^25.
- **General number fields** (`bnfinit`):
  - the maximal order by Round 2;
  - prime decomposition, including common index divisors;
  - the class group, regulator and roots of unity, by Buchmann's method with
    units kept in compact form.
  - Agrees with PARI on every field tested (up to |d| ~ 10^35); about 10x
    slower at small d and close to even at 10^35.
- **Integer algorithms:** factoring (Pollard rho and ECM), the Hermite and
  Smith normal forms, exact LLL, and complex roots to any precision.

All of it runs in Sage mode (`NumberField`, `QuadraticField`,
`class_group()`, `regulator()`, `matrix(ZZ, ...).LLL()`, ...), in Magma mode
(`ClassGroup`, `MaximalOrder`, `HermiteForm`, ...), and from Python as
`from sagebrush import nf`.

**`modsym`**: weight-2 modular symbols for Gamma0(N), sign +1:

- characteristic polynomials of Hecke operators T_q modulo a prime;
- **proven** characteristic polynomials over Z, by multimodular CRT with a
  proven coefficient bound (see below), each returned with the checks it passed;
- batches of levels in parallel, with a bad level reported and the batch continuing;
- estimates of dimension, primes, memory and time before running anything;
- level data (index, genus, cusps, Eisenstein and total dimension).

The same functions are available from:

| interface | built with | notes |
|---|---|---|
| Python (`from sagebrush import modsym`) | PyO3 | releases the GIL; exact coefficients are Python `int`s |
| Node.js (`require("./engine/node").modsym`) | napi-rs | native addon; exact coefficients are `BigInt`s |
| Rust (`sagebrush-modsym`) | - | the engine itself |
| command line (`sagebrush`) | - | `sagebrush modsym N q [p] [--exact] [--threads T]` |
| WebAssembly | wasm-bindgen | single-threaded; mod-p only for now |

Every interface is multithreaded except WASM: `threads=0` means all cores.

## The Python front end: pyjs

`src/` and `lib/` are pyjs, the Python 3.14 language compiled to JavaScript.
Its parser is generated from CPython's own grammar, so syntax errors match
CPython's. It passes 532 of 536 conformance programs, and pure-Python
packages such as mpmath pass their own test suites. It is the front end for
the engines.

- **Browser:** [sagebrush.space](https://sagebrush.space) is a notebook and a
  console running in the page, and nothing is sent to a server. See
  [web/README.md](web/README.md).
- **Command line:** `npx sagebrush`, or one self-contained executable from
  `curl -fsSL https://get.sagebrush.space/install.sh | sh`.
- **Sage mode** (`--sage`): Sage's preparser (`src/sagepre.ts`): `2^3 == 8`,
  `2/3` is an exact rational, `[1..10]`, `[1,3..99]`, `(1..)`, `1.5` prints
  as `1.50000000000000`, `100r`, `12.factor()`, `R.<x> = ZZ[]`, `R.0`,
  `f(x) = x^2`; checked against Sage by `sage-tests/test_language.sage`.
- **Magma** (`--magma`, implied for `.m` files; a mode of the notebook):
  `src/magma.ts` translates Magma to Python, run on `lib/_magma.py` over
  the same engines: the language (`:=`, `function`/`procedure` with `~x`
  arguments, `$$`, `select`, comprehensions, ranges, multiple return
  values, value semantics), Magma's printing (wrapped at 80 columns), and
  integers, sequences, sets, tuples, reals to 30 digits, polynomials,
  modular symbols, newforms and elliptic curves. `magma-tests/` checks
  500 lines against Magma itself.
- **Number fields and integer matrices:** in Sage mode, `K.<a> =
  NumberField(x^3 - 11)`, `QuadraticField`, `CyclotomicField`, with
  `discriminant`, `signature`, `integral_basis`, `maximal_order`,
  `primes_above`, `factor`, `class_group`, `class_number`, `unit_group` and
  `regulator`. Field elements support arithmetic, `norm`, `trace` and
  `minpoly`. `matrix(ZZ, ...)` supports `hermite_form`,
  `elementary_divisors`, `smith_form`, `LLL`, `det` and `inverse`. Also
  `roots(RR)`, `roots(CC)`, and `factor(n)` by ECM. In Magma mode:
  `NumberField`, `QuadraticField`, `MaximalOrder`, `IntegralBasis`,
  `ClassGroup`, `ClassNumber`, `UnitGroup`, `Signature`, `Decomposition`,
  `Matrix`, `HermiteForm`, `SmithForm`, `ElementaryDivisors` and `LLL`.
  Checked against Sage (`sage-tests/test_numberfield.sage`) and Magma
  (`magma-tests/test_numberfield.m`).
- **Modular forms, elliptic curves and polynomials:** in Sage mode,
  `ModularSymbols`, `CuspForms`, `ModularForms`, `Newforms`, `Gamma0`,
  `DirichletGroup`, `EllipticCurve` and polynomial rings over `ZZ` and `QQ`
  (`R.<x> = ZZ[]`, `f.factor()`, `f.roots()`, `gcd`, `discriminant`) run on
  the Sagebrush engines (a 1.4 MB WebAssembly build of `engine/web`, loaded
  on first use), with Sage's printed output: `sage-tests/` checks 3,200
  lines against Sage. `newform_orbits(N, k)` lists every Galois orbit of
  newforms with its LMFDB label, dimension, trace form and Hecke
  characteristic polynomial. `from sagebrush import modsym, ap, mf, nf, poly`
  is the API of the native Python package. `nf` and `poly` are the same
  Python files in the browser and in CPython, over one JSON dispatcher
  (`engine/web`).
- **The Atlas** ([sagebrush.space/atlas](https://sagebrush.space/atlas/)):
  an LMFDB-style site of the 7,961 Galois orbits of newforms of weight 2
  and level ≤ 1000 (and weights 4–12 with Nk² ≤ 4000), proven by the
  modular symbols engine, with LMFDB labels; all 5,951 weight-2 orbits
  agree with the LMFDB. Every page is also JSON, other spaces are computed
  in the browser, and any stored space can be recomputed there and compared
  ([web/atlas](web/atlas/README.md)).
- **numpy:** the NumPy 2 API in TypeScript (ndarray, ufuncs, random,
  linalg, fft, polynomials), checked against NumPy itself. Printed output and
  seeded random numbers are byte-identical. dense linear algebra, the FFT, `exp` and
  `log` run in Rust WebAssembly SIMD kernels ([kernels/](kernels)). See [NUMPY.md](NUMPY.md).
- **Plots and `@interact`:** Sage's `plot`/`point`/... and
  `matplotlib.pyplot` draw deterministic, self-describing SVG, and controls
  rerun a function in milliseconds. See [PLOTTING.md](PLOTTING.md).

## Try it

From Python (3.9 or later; a 1.2 MB wheel for Linux, macOS and Windows):

```sh
pip install sagebrush
```

```python
>>> from sagebrush.sage import *      # Sage's names and printing
>>> x = PolynomialRing(QQ, 'x').gen()
>>> K = NumberField(x**3 + 17*x + 1, 'a')
>>> K.class_group()
Class group of order 3 with structure C3 of Number Field in a with defining polynomial x^3 + 17*x + 1
```

`sagebrush.sage` is plain Python (`x**3`, not `x^3`); its output is checked
line by line against Sage's (`sage-tests/run_cpython.py`). The engines are
also directly available (`from sagebrush import nf, mf, ap, poly`); see
[engine/py/README.md](engine/py/README.md). In the browser, open
[sagebrush.space](https://sagebrush.space).

To build from source you need Rust (stable), `uv` and Node.js.

```sh
cd engine
uv venv .venv && uv pip install --python .venv/bin/python maturin ipython
(cd py && ../.venv/bin/maturin develop --release)   # Python module
node/build.sh                                       # Node addon
./try-python                                        # IPython, m = sagebrush.modsym
./try-node                                          # Node REPL, m = sagebrush.modsym
```

```python
>>> m.charpoly_exact(37, 2)["charpoly"]       # x^3 - x^2 - 6x = x (x - 3)(x + 2)
[0, -6, -1, 1]
>>> r = m.batch_exact(range(11, 500, 2), 2)   # 245 proven charpolys, ~0.02 s
>>> m.estimate(20011, 2)                      # what would a big one cost?
```

See [engine/TRY.md](engine/TRY.md) for the full function list in both
languages.

## How "proven" is earned

Exact characteristic polynomials are reconstructed by CRT from computations
modulo primes below 2^31. Each prime is accepted only if the space it
produces has exactly the dimension that the genus and cusp formulas
predict. The number of primes comes from a proven bound on the
coefficients:

- cusp eigenvalues are real with |a| <= 2 sqrt(q) (Deligne);
- Eisenstein eigenvalues are chi(q) + psi(q) q, so |a| <= 1 + q;
- the bound is then sharpened using the exact sum of squares of the
  eigenvalues, read off the first prime, and Jensen's inequality. This
  needs 24-25% fewer primes than Deligne alone.

A result is marked `proven` only if it is monic, has q + 1 as a root, and
fits within the bound.

## Tests

`cd engine && cargo test -p sagebrush-modsym -p sagebrush-ap -p sagebrush-poly` runs in about 10 seconds after the
first build. For `ap` it checks agreement with smalljac and Sage (see
[results/ap.md](results/ap.md)). For `modsym` it checks:

- exact characteristic polynomials against 24 Sage computations, levels 1
  to 2003, including prime powers and non-squarefree levels;
- the dimension formula against the computed dimension for every N <= 1000
  and four large composite levels;
- mod-p hashes against the independent pure-Python implementation
  (`bench/modsym/modsym.py`);
- error handling: invalid input is an error, never a panic;
- consistency between the code paths: Hecke operators commute, the mod-p
  result equals the exact result reduced mod p, and the estimator predicts
  the dimension;
- the charpoly kernel against determinants, the AVX2 kernels against the
  portable ones, and P^1(Z/NZ) by brute force.

`cargo test -p sagebrush-classgroup` checks the class group engine against
brute force and against values from PARI (used as an oracle), along with
its layers (Round 2, prime decomposition, LLL, Barrett and Montgomery
arithmetic, ECM, kernel vectors, the unit lattice). Larger comparisons
against PARI are in [engine/classgroup/README.md](engine/classgroup/README.md).

For `poly` (Zassenhaus: square-free decomposition, Cantor-Zassenhaus modulo
several primes, quadratic Hensel lifting on a factor tree, recombination) it
checks the factorization against FLINT on 400 random products, the
cyclotomic polynomials x^n - 1 and x^(2^k) + 1, and the Hecke polynomials of
T_2 and T_3 at about 100 levels up to 2003.

## Performance

On one thread, on the same machine, the engine computes proven exact
charpolys 3.9-7.8x faster than Sage's default path and 1.1-4.7x faster than
Sage's fastest (LinBox, heuristic) path, for dimensions 592-835. It also
parallelizes: exact T_2 for all 1495 odd levels below 3000 takes 18 seconds
on 8 cores. Details, including what did not work and the benchmarking
caveats: [results/engine-exact.md](results/engine-exact.md) and
[results/engine.md](results/engine.md).

## Repository layout

| path | contents |
|---|---|
| `engine/` | the Rust workspace: engines `modsym`, `ap`, `poly` and `classgroup`; bindings `cli`, `py`, `node`, `wasm`, `web`; `bench` |
| `kernels/` | Rust WebAssembly SIMD kernels (matmul, LU, QR, eigenproblems, SVD, FFT, exp, log) for the numpy runtime |
| `results/` | write-ups of every experiment, with numbers |
| `bench/modsym/` | the pure-Python reference implementation and a line-by-line Rust port |
| `src/`, `lib/`, `test/`, `target/`, `scripts/`, `web/`, `PLAN.md` | pyjs, the Python front end: compiler, runtime, library, CLI and the browser notebook |

## History: from pyjs-spike to Sagebrush

This repository began as **pyjs-spike**, a two-week experiment to see
whether Python semantics compiled to JavaScript could compete with CPython,
as a foundation for sagejs ([PLAN.md](PLAN.md),
[results/pyperformance-bench1.md](results/pyperformance-bench1.md)). The
compiler worked, but a modular-symbols benchmark changed the plan. The same
algorithm ran 31x slower in CPython, 18x slower in pyjs and 2.4x slower in
PyPy than in a direct Rust port ([results/rust.md](results/rust.md)).

So the mathematics moved into Rust, behind thin bindings for the ecosystems
people actually use (Python and JavaScript), and the work went into making
results fast, parallel and certified. The pyjs code remains here for
reference.

## Acknowledgements

The a_p engine (`engine/ap`) follows the genus-1 strategy of smalljac, by
Andrew V. Sutherland (with Kiran Kedlaya; "Computing L-series of
hyperelliptic curves", ANTS 2008). We thank Drew Sutherland for his
permission, given on 2026-10-02, for this port to be licensed however
Sagebrush chooses; see `engine/ap/PROVENANCE.md`.

## License

Copyright (c) 2026 SageMath, Inc. Licensed under either of the
[Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT),
at your option.

A few parts derive from other permissively licensed projects (CPython,
NumPy, Arm Optimized Routines, fdlibm) or were ported with the author's
permission (smalljac); [NOTICE.md](NOTICE.md) lists them with their
notices.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in Sagebrush, as defined in the Apache-2.0 license,
is dual licensed as above, without any additional terms or conditions. See
[CONTRIBUTING.md](CONTRIBUTING.md).
