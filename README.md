# Sagebrush

Fast, certified, parallel engines for research mathematics, written in Rust
and usable from Python and JavaScript.

Sagebrush is an early experiment from the founder of SageMath. The idea:
mathematicians, and the AI agents working with them, should be able to ask
large questions (thousands of levels, millions of objects) and get results
in seconds. Every result should come with a status saying whether it is
*proven* or only heuristic. The design is many small, strong engines that
share one core, not one huge system.

Status: two engines (modular symbols with rational newforms, and a_p of elliptic curves), not
published to any package registry, and no license chosen yet.

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
- **Sage mode** (`--sage`): `2^3 == 8`, and `2/3` is an exact rational.
- **numpy:** the NumPy 2 API in TypeScript (ndarray, ufuncs, random,
  linalg, fft, polynomials), checked against NumPy itself. Printed output and
  seeded random numbers are byte-identical. dense linear algebra, the FFT, `exp` and
  `log` run in Rust WebAssembly SIMD kernels ([kernels/](kernels)). See [NUMPY.md](NUMPY.md).
- **Plots and `@interact`:** Sage's `plot`/`point`/... and
  `matplotlib.pyplot` draw deterministic, self-describing SVG, and controls
  rerun a function in milliseconds. See [PLOTTING.md](PLOTTING.md).

## Try it

You need Rust (stable), `uv` and Node.js.

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

`cd engine && cargo test -p sagebrush-modsym -p sagebrush-ap` runs in about 10 seconds after the
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
| `engine/` | the Rust workspace: engines `modsym` and `ap`; bindings `cli`, `py`, `node`, `wasm`; `bench` |
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

## License

Not chosen yet.
