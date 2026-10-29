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
   code. The whole engine is one 1.7 MB `.wasm` file.
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
1.2-1.6x slower. See [results/ap.md](results/ap.md): measured once there;
`sagebrush bench ap` reruns Sagebrush's side (11a to 10^8 in 65 s on one
core, from Python) and checks it against the count recorded from smalljac,
but it cannot rerun smalljac itself, which is rarely installed.

**Rational newforms** (in `modsym`): every rational newform of level N and
its a_p, found by splitting with integer Hecke eigenvalues in the Hasse
range. It reproduces Cremona's tables exactly for every conductor up to
9999 (38,042 isogeny classes) in 14 minutes on 16 cores, and agrees prime
by prime with point counts from `ap`. See
[results/newforms.md](results/newforms.md).

**Class groups and units** (`engine/classgroup`, MIT/Apache, clean-room;
see [its README](engine/classgroup/README.md) for the tables). Against
PARI 2.17 on one core of an AMD EPYC 7B13. *Certified* is the default call:
under GRH, with an analytic certificate. *Uncertified* is
`certify=False`, conditional on GRH and a heuristic stopping rule like
PARI's `quadclassunit`, which does not certify:

- **Imaginary quadratic fields:** Jacobson's sieve.
  - Certified: faster than PARI from about 10^27, and 18-32x faster at
    10^41-10^47 (10^47: 8.8 s against 284 s). Below 10^15 it is 23-142x
    slower, because the certificate costs about 0.1 s.
  - Uncertified: faster from about 10^15, and 38-58x faster at
    10^41-10^47.
  - Rerun: `sagebrush bench imagquad --large`.
- **Real quadratic fields:** class group and regulator.
  - Certified: faster than PARI from about 10^35 (2.3x at 10^41), and
    1.8-74x slower below.
  - Uncertified: faster from about 10^25 (4.9x at 10^41).
  - Rerun: `sagebrush bench realquad`.
- **General number fields** (`bnfinit`):
  - the maximal order by Round 2;
  - prime decomposition, including common index divisors;
  - the class group, regulator and roots of unity, by Buchmann's method with
    units kept in compact form.
  - Agrees with PARI on all 30 fields of a fixed random list of degree 3-6
    (|d| from 10^8 to 10^41). The default call is certified as above, and
    all 30 came out certified. Cubics are faster than PARI from about
    |d| = 10^20 (6x at 10^32-10^36), quartics from about 10^33 (3.6x at
    10^41). Quintics and sextics are 5-122x slower at every size tested.
    Rerun: `sagebrush bench nf --large`.
- **Integer algorithms:** factoring (Pollard rho and ECM), the Hermite and
  Smith normal forms, exact LLL, and complex roots to any precision.

**Exact linear algebra and polynomial arithmetic** (`engine/arith`,
MIT/Apache, clean-room; the layer FLINT provides for Sage; see
[its README](engine/arith/README.md)):

- **Matrices over Z and Q:**
  - determinants (Abbott–Bronstein–Mulders);
  - solving and inverses (Dixon's p-adic lifting);
  - reduced echelon form, rank and kernels;
  - characteristic polynomials (multimodular, with a proven bound).
- **Polynomials:**
  - over Z/n: NTT products, Newton division, half-gcd;
  - over Z: products, and heuristic and modular gcds.
- **Certified:** every answer is checked exactly or rests on a proven bound.
- **Speed against FLINT 3.6** ([bench/linalg](bench/linalg/README.md); random
  dense matrices with 7- and 41-bit entries, n = 10, 30, 100; one core;
  sub-millisecond times are imprecise). These are for the Rust engine
  called directly (`cargo run -p sagebrush-oracle --example matbench`,
  `--example polybench`):
  - inverses 3.6–5.6x faster for n = 30 and 100 (1.3–1.4x slower at n = 10);
  - rref 1.3–3x faster for n = 30 and 100, but 2–6x slower at n = 10;
  - charpoly, det and solve within 1.1–2.3x for n = 30 and 100, up to 7.6x
    slower at n = 10;
  - polynomial products and gcds within 1–5.2x for lengths 100 to 100,000
    (up to 7.6x slower at length 10, where both take about a microsecond).
  - Called from Python (`sagebrush bench linalg`), each call also passes its
    matrix as text, so the lead shrinks. For n = 30 and 100: inverses are
    2.1–3.6x faster, rref at n = 100 is 1.2–2.4x faster, and det, solve and
    charpoly are 1.3–2.5x slower. Polynomials of length 100 and more are
    2–12x slower.
- **In the Sage layer**, against Sage 10.9 (`sagebrush bench sagelayer`):
  - `charpoly` is 2–2.5x faster;
  - `rref` and `inverse` are within 1.3x of Sage;
  - `det` is 2–10x slower;
  - polynomial gcds and products are 2–23x slower, mostly from passing
    coefficients between Python and Rust.

  The Rust engine made `det`, `rref` and `inverse` 9–77x faster than the
  previous pure-Python code, and a polynomial gcd that took 10 s now takes
  under a millisecond (measured once; see bench/linalg).

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
| WebAssembly (`engine/web`) | plain wasm32, JSON in and out | single-threaded |

Every interface is multithreaded except WASM: `threads=0` means all cores.

## The Python front end: pyjs

`src/` and `lib/` are pyjs, the Python 3.14 language compiled to JavaScript.
Its parser is generated from CPython's own grammar, so syntax errors match
CPython's. It passes 532 of 536 conformance programs, and pure-Python
packages such as mpmath pass their own test suites. It is the front end for
the engines. Strings are JavaScript strings, so a character past U+FFFF is a
surrogate pair: they compare and sort by code point as in Python, but two
lone surrogates that form a pair (`'\ud800\udc00'`) are the same string as
that character (`'\U00010000'`), where CPython keeps them apart. An int's
decimal conversions have no default limit: `sys.get_int_max_str_digits()` is
0 in every mode, where CPython's default is 4300, so a large integer prints
and saves without a setting. A program that calls
`sys.set_int_max_str_digits(n)` gets CPython's checks and messages; the only
other bound on a conversion, or on `math.log` of a huge int, is the session's
memory, refused at once with a `MemoryError` that says how much it needs.
With several GB of arrays in memory, Stop can lag about 0.1 s per GB: that is
the JavaScript engine's own garbage collection, which can't be interrupted
("with several GB of arrays in memory, Stop can lag about 0.1 s per GB",
William, Oct 25 2026). Sagebrush's own code still checks for Stop at least
every 250 ms; the exception covers only engine garbage-collection pauses
longer than that.
For now, rendering a plot to PNG in the command-line host can't be stopped
mid-render: Stop takes effect once the render finishes. This lifts when
interruptible rendering lands.

Files: pyjs has no reference counting, so a file object isn't closed when
its last reference goes. `with open(...)` or `.close()` is the portable form.
`open(f, m).write(s)` as a statement, its value assigned or returned, with
any expressions for `f`, `m` and `s`, is written and closed at the statement,
as in CPython. The file is opened where CPython opens it, before `s` is
evaluated, and closed even if `s` raises or Stop arrives. That holds for text
modes `w` and `a` and binary `wb` and `ab`, with a `str` path. Any other
unclosed file is written when a notebook cell or the program ends. That
includes one released by `del`, by rebinding or by a function's return, and a
write inside a larger expression, such as `print(open(f, "w").write(s))`, or
in a lambda. Opening the same path again doesn't write it first, as CPython
doesn't. A held file writes its whole contents when flushed, not from its
position. At an `open(f, m).write(s)` statement, a write error such as a full
disk raises there, where CPython's small buffered write reports it only when
the file is finalized. pyjs writes UTF-8 with `"\n"` newlines, CPython's
POSIX defaults.

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
  modular symbols, newforms and elliptic curves. As in Magma, a file stops
  at its first runtime or syntax error, while input on stdin
  (`sagebrush --magma < f.m`) is a session that reports errors and goes on.
  `magma-tests/` checks 600 lines against Magma itself.
- **Number fields and integer matrices:** in Sage mode, `K.<a> =
  NumberField(x^3 - 11)`, `QuadraticField`, `CyclotomicField`, with
  `discriminant`, `signature`, `integral_basis`, `maximal_order`,
  `primes_above`, `factor`, `class_group`, `class_number`, `unit_group` and
  `regulator`. Field elements support arithmetic, `norm`, `trace` and
  `minpoly`. `matrix(ZZ, ...)` and `matrix(QQ, ...)` support `det`, `rank`,
  `echelon_form`, `inverse`, `charpoly`, `kernel`, `right_kernel`,
  `solve_right` and `solve_left` (`sagebrush.linalg`; checked by
  `sage-tests/test_linalg.sage`), and over ZZ `hermite_form`,
  `elementary_divisors`, `smith_form` and `LLL`. Also
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
  the Sagebrush engines (a 1.7 MB WebAssembly build of `engine/web`, loaded
  on first use), with Sage's printed output: `sage-tests/` checks 3,500
  lines against Sage. `newform_orbits(N, k)` lists every Galois orbit of
  newforms with its LMFDB label, dimension, trace form and Hecke
  characteristic polynomial. `from sagebrush import modsym, ap, mf, nf,
  poly, linalg` is the API of the native Python package. `nf`, `poly` and
  `linalg` are the same
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
- **Symbolic calculus:** in Sage mode, `var`, `diff`, `expand`, `factor`,
  `simplify_full`, `taylor`, `series`, `limit`, `solve`, `subs`, `n` and
  `latex` run on Sagebrush's own symbolic engine (Rust, `engine/sym`). Its
  output is printed as Sage prints it, checked by `sage-tests/test_symbolic.sage`
  and a corpus of 300 expressions.
- **Integration:** `integrate(f, x)` and `integrate(f, x, a, b)` (infinite
  bounds too) use Sagebrush's own integrator. It works through tables,
  substitution, parts, exact partial fractions (Hermite and
  Rothstein–Trager), trigonometric powers, square roots of quadratics and
  the Weierstrass substitution.
  - Every answer is checked by differentiating it: exactly when the
    difference simplifies to 0, otherwise numerically at sample points
    (relative tolerance). The numerical check is strong evidence, not a
    proof.
  - On a corpus of 171 first-year integrals it finds 166; Maxima, what Sage
    calls, finds 170, including two non-elementary integrals we leave
    unevaluated. 152 of ours print exactly as Sage prints Maxima's answers.
  - `integrate_steps(f, x)` shows the rules used, and `numerical_integral`
    computes adaptive Gauss–Kronrod quadrature.
- **Limits and differential equations:**
  - `limit` works by continuity, series, comparison of growth at infinity
    (powers, logs, exponentials) and L'Hôpital's rule. It gives Sage's
    answer on 61 of 62 textbook limits (`engine/sym/corpus/limits.json`).
  - `desolve` solves first-order linear, separable, exact, homogeneous and
    Bernoulli equations, and second-order linear ones with constant
    coefficients (undetermined coefficients, variation of parameters) or
    of Cauchy–Euler type, with initial conditions. It solves all 37
    equations of `corpus/odes.json`, and every explicit solution is
    verified by substitution (exactly, or numerically at sample points with
    the constants given values: evidence, not a proof). Separation of
    variables does not list equilibrium solutions, except when an initial
    condition is one.
  - `desolve_rk4` integrates numerically.
- **Permutation groups** (engine/group, the start of Galois groups):
  Sage's `PermutationGroup`, `SymmetricGroup`, `AlternatingGroup`,
  `DihedralGroup`, `MathieuGroup`, `PSL(2, p)`, and more. They have exact
  orders and membership, from stabilizer chains that the deterministic
  Schreier-Sims test proves. Also: orbits, stabilizers, blocks and block
  systems, primitivity, multiple transitivity, derived series and
  solvability. All 2604 transitive groups of degree up to 16 agree with
  Magma on eight properties each (`engine/group/tests`).
- **Plots and `@interact`:** Sage's `plot`/`point`/... and
  `matplotlib.pyplot` draw deterministic, self-describing SVG, and controls
  rerun a function in milliseconds. `plot3d`, `parametric_plot3d`,
  `implicit_plot3d`, the Platonic solids, ... show in an interactive WebGL
  view (with an SVG for files and agents). The view orbits, pans, zooms to
  the cursor, and flies through the scene like a game (F: mouse look,
  W A S D, gamepads). `contour_plot`, `density_plot`, `implicit_plot`,
  `region_plot`, `plot_vector_field` and `plot_slope_field` draw functions
  of two variables. `import k3d` runs notebooks written for k3d (meshes of
  millions of triangles, ray-marched volumes, standalone snapshots) in the
  browser, with `scipy.io.loadmat` for their MATLAB data. See
  [PLOTTING.md](PLOTTING.md).

## Try it

From Python (3.10 or later; a 1.2 MB wheel for Linux, macOS and Windows):

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
line by line against Sage's (`sage-tests/run_cpython.py`). For Sage syntax,
`sagebrush.preparse.preparse` turns it into this Python. The engines are
also directly available (`from sagebrush import nf, mf, ap, poly`); see
[engine/py/README.md](engine/py/README.md). In the browser, open
[sagebrush.space](https://sagebrush.space).

To build everything from source and run every test suite (the exact tool
versions, `scripts/build-all.sh`, `scripts/test-all.sh` and their timings),
see [DEVELOPMENT.md](DEVELOPMENT.md). For the engines in Python or Node
alone, you need Rust (rustup: `engine/rust-toolchain.toml` pins the
toolchain, and rustup installs it), `uv` and Node.js 24:

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

Sage code then runs natively (the engines compiled for your machine, the
Gröbner bases over QQ on every core):

```sh
.venv/bin/python -m sagebrush FILE.sage        # or -c "CODE"
.venv/bin/python -m sagebrush -c 'R = PolynomialRing(QQ, "x", 8)
print(len(sage.rings.ideal.Katsura(R).groebner_basis()))'
```

The CLI, the notebook and sagebrush.space are built with pnpm (the lock file
is `pnpm-lock.yaml`; `npm ci` does not apply) and bun:

```sh
pnpm install --frozen-lockfile        # seconds with a warm store
node scripts/build-engine.mjs         # the Rust engine as WebAssembly (35 s on 16 cores)
pnpm run build:cli                    # build/cli/pyjs.cjs, the single-file CLI (a few seconds)
bun web/build.ts                      # the notebook page in web/dist (about 17 s)
pnpm test                             # the Node tests (about 24 min one after another; CI runs them as 8 shards)
```

The engine's Rust toolchain is pinned (`engine/rust-toolchain.toml`, 1.99.1;
rustup installs it on the first `cargo` command under `engine/`), so that
the committed `wasm/sagebrush-engine.wasm` is exactly what a fresh build
gives: CI rebuilds it and fails on master pushes, dispatches and the
schedule if they differ. Bumping the toolchain is a deliberate pull request
that commits the rebuilt `wasm/` and `cdn/` files with their size marker.
The module embeds the crate registry's paths, so a local build reproduces
the committed bytes only with CI's path:

```sh
RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/home/runner/.cargo" node scripts/build-engine.mjs
cmp wasm/sagebrush-engine.wasm <(git show HEAD:wasm/sagebrush-engine.wasm) && echo identical
```

### The notebook on your computer

```sh
npx sagebrush notebook [DIR]        # opens the notebook in your browser
```

This is the notebook of sagebrush.space, but Python runs natively on your
computer (a Node worker thread per notebook) with your files. Each notebook
is an `.ipynb` file in DIR. Like Jupyter, the server listens on 127.0.0.1
only and needs the random token in the URL it opens. It answers only for
its own host name, and serves files under DIR only. Stop raises
KeyboardInterrupt and keeps the variables. The page is embedded in the
single-file CLI and executables (`src/notebook.ts`; the page and the
browser's worker share `src/notebook-session.ts`).
`web/test-local-notebook.mjs` tests it end to end in Chromium.

### Boards on your computer

```sh
npx sagebrush board check talk.board.json   # every problem in one report
npx sagebrush board open talk.board.json    # shows it in your browser, and follows the file
```

`board open` shows the board as sagebrush.space/board does, and again, in
place (the same camera, the code's outputs kept), each time the file
changes: an AI agent writing boards on your laptop can rewrite the file and
you see each version as it lands. A version that isn't a board (half
written, or wrong) leaves the last good one shown, with a bar saying what is
wrong. The board's code runs in the page, as on the site; nothing of the
board is uploaded. As with the notebook, the server listens on 127.0.0.1
only, needs the random token in the URL it opens, answers only for its own
host and port, and serves that one file and the page, nothing else. The
page is sandboxed as the site's board frame is. Edits made in the page
aren't saved to the file (yet): the file is the board. `src/board-open.ts`;
`web/test-board-open.mjs` tests it end to end in Chromium.

sagebrush.space itself is also an app: open it once, and it works offline
(a service worker, `web/sw.js`). Chrome and Edge offer "Install as an app"
(also in the File menu), and Safari has Add to Dock or Home Screen. The
installed app opens `.ipynb`, `.py` and `.sage` files from the computer.
`web/test-pwa.mjs` loads it, stops the server, and runs Python offline.

### The desktop app

`app/` is Sagebrush as a desktop app for macOS, Linux and Windows (Tauri 2,
using the system's web view; the macOS app is 6 MB and its `.dmg` 4 MB).
It opens and saves `.ipynb` files with the system's dialogs, gives Python the
files in the notebook's folder, and opens double-clicked notebooks. CI
builds it for all three systems and runs its self-test in each one's web
view. See [app/README.md](app/README.md).

### A Jupyter kernel

```sh
npx sagebrush --install-jupyter-kernel              # "Sagebrush (Sage)"; --mode all adds Python and Magma
```

The kernel is pyjs with the engines and SVG graphics. It speaks the
Jupyter protocol over a ZeroMQ transport written in plain JavaScript
(`src/zmtp.ts`, `src/kernel.ts`), so it needs neither Python nor a native
ZeroMQ library. The self-contained executable works too.

The code runs in a worker thread. The kernel's main thread answers
heartbeats and interrupts, and Stop raises KeyboardInterrupt in Python
loops and stops the Rust engines.

`test/jupyter_kernel.py` drives it with Jupyter's own client
(`jupyter_client`) through 18 checks: execution, streams, SVG, errors,
completion, interrupts, modes and shutdown.

### For AI agents: the MCP server

`pip install sagebrush` also installs `sagebrush-mcp`, a
[Model Context Protocol](https://modelcontextprotocol.io) server. It needs
nothing else.

```sh
claude mcp add sagebrush -- sagebrush-mcp            # Claude Code
# other clients: { "mcpServers": { "sagebrush": { "command": "sagebrush-mcp" } } }
```

It provides these tools:
- `sage`: Sage syntax in a persistent session. It returns printed output,
  the last value and SVG plots.
- `python`, `reset` and `guide`.
- The shortcuts `factor`, `number_field` and `newforms`.

Every call has a time limit that interrupts the computation (Ctrl-C reaches
the Rust engines), and a stuck session is restarted. The Sage preparser is
`sagebrush.preparse`, a Python port of the browser's; the same `sage-tests`
pass through it. `engine/py/test_mcp.py` checks the protocol, including
with the official MCP client.

### From Rust

The engines are ordinary Rust crates (MIT OR Apache-2.0, no C libraries),
usable from any Rust program. They are not on crates.io yet; depend on them
from git:

```toml
[dependencies]
sagebrush-bigint = { git = "https://github.com/sagemathinc/sagebrush" }
sagebrush-classgroup = { git = "https://github.com/sagemathinc/sagebrush" }  # number fields, class groups, factoring
sagebrush-ap = { git = "https://github.com/sagemathinc/sagebrush" }          # a_p of elliptic curves
sagebrush-galois = { git = "https://github.com/sagemathinc/sagebrush" }      # Galois groups over Q
sagebrush-sym = { git = "https://github.com/sagemathinc/sagebrush" }         # symbolic calculus
```

```rust
use sagebrush_bigint::BigInt;

fn main() -> Result<(), String> {
    let z = |v: &[i64]| v.iter().map(|&c| BigInt::from(c)).collect::<Vec<_>>();
    // 2^128 + 1 = 59649589127497217 * 5704689200685129054721 (ECM)
    let n: BigInt = (BigInt::from(1) << 128u32) + 1;
    println!("{:?}", sagebrush_classgroup::api::factor_integer(&n)?);
    // Q[x]/(x^3 - 11): h = 2, R = 5.5872066260609077619 (assuming GRH: see k.certified)
    let k = sagebrush_classgroup::api::bnf(&z(&[-11, 0, 0, 1]))?;
    println!("h = {}, cyc = {:?}, R = {}", k.h, k.cyc, k.regulator);
    // a_p of 11a1 for p <= 30 (None at the bad prime 11)
    let e = sagebrush_ap::EllipticCurve::new([0, -1, 1, -10, -20])?;
    println!("{:?}", sagebrush_ap::aplist(&e, 30));
    // Gal(x^5 - x - 1) = S5, proven
    let g = sagebrush_galois::galois_group(&z(&[-1, -1, 0, 0, 0, 1]))?;
    println!("{} (order {}, proven {})", g.name, g.order, g.proven);
    // an antiderivative and a limit
    let f = sagebrush_sym::parse("x*exp(x)*sin(x)");
    println!("{}", sagebrush_sym::to_string(&sagebrush_sym::integrate::integrate(&f, "x").ok_or("none")?));
    let l = sagebrush_sym::limit::limit(&sagebrush_sym::parse("sin(x)/x"), "x", &sagebrush_sym::parse("0"), sagebrush_sym::limit::Dir::Both);
    println!("{}", sagebrush_sym::to_string(&l));
    Ok(())
}
```

The other crates: `sagebrush-modsym` (modular symbols, newforms),
`sagebrush-mpoly` (multivariate polynomials, Gröbner bases), `sagebrush-poly`
(univariate factoring), `sagebrush-arith` and `sagebrush-group` (permutation
groups). `sagebrush_web::call(json)` (`engine/web`) is the JSON interface
that the notebook, the CLI and the Python package share: one entry point to
all of them, e.g. `call(r#"{"fn": "factor_integer", "n": "1001"}"#)`.

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

Each speed comparison in this README says how to rerun it. Most name a
`sagebrush bench` suite (`pip install sagebrush`, then `sagebrush bench
--list`), which runs PARI, FLINT and Sage as competitors where they are
installed; the runs behind those numbers, with every sample, are in
[results/bench](results/bench/README.md). The Rust-level, parallel and
smalljac figures point to the command or the results file they come from.

On one thread of an AMD EPYC 7B13, the engine computes proven exact
charpolys of Hecke operators for dimensions 592-835 (N = 2310, 5000, 10007)
5.9-12.8x faster than Sage 10.9's default path, and 5-33x faster than its
LinBox path, which is heuristic. Sagebrush's time includes building the
modular symbols; Sage's starts from a Hecke matrix built before timing.
Rerun with `sagebrush bench charpoly --large`.

It also parallelizes: exact T_2 for all 1495 odd levels below 3000 takes
18 seconds on 8 cores. Details, including what did not work and the
benchmarking caveats: [results/engine-exact.md](results/engine-exact.md) and
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

### What each download contains, and under which licenses

Sagebrush's own code is MIT OR Apache-2.0 everywhere. What ships alongside
it differs by distribution; each carries a `THIRD-PARTY-NOTICES` file
listing every component with its license text, generated by
`scripts/third-party-notices.mjs` and checked in CI.

| Distribution | Also contains | Notices |
|---|---|---|
| Python package `sagebrush` (PyPI) | Rust crates (MIT, Apache-2.0, BSD-style, Unicode); John Cremona's elliptic curves of conductor below 1000 (**Artistic License 2.0**) | `THIRD-PARTY-NOTICES.txt` and `LICENSE-Artistic-2.0.txt` in the wheel |
| npm `sagebrush`, the standalone executables | the above Rust crates and Cremona data; CPython's parser and some standard-library modules (**PSF License**); code following NumPy (BSD-3-Clause), Arm Optimized Routines (MIT), fdlibm; the notebook page's JavaScript (xterm.js, KaTeX, marked, patchflow and its dependencies: MIT, Apache-2.0, Blue Oak); **KaTeX's fonts (SIL Open Font License 1.1)** | `packages/sagebrush/THIRD-PARTY-NOTICES.txt`; the executables print everything with `sagebrush --licenses` |
| npm `sagebrush-web` | the Rust crates; CPython's parser (PSF License) | `cdn/THIRD-PARTY-NOTICES.txt` |
| The web site, sagebrush.space | the same as npm `sagebrush` | [/THIRD-PARTY-NOTICES.txt](https://sagebrush.space/THIRD-PARTY-NOTICES.txt), linked as "Licenses" in the page footer |
| The desktop app | the web site's contents, plus its native code: Tauri, Wry, Tao and about 400 Rust crates, five of them under the **Mozilla Public License 2.0** (cssparser, cssparser-macros, dtoa-short, option-ext, selectors; used unmodified, source on crates.io). The Linux **AppImage** also bundles shared libraries of the system it was built on (GTK, WebKitGTK and others, mostly **LGPL**), which are dynamically linked and replaceable; they are not listed in the notices. GTK's TIFF image loader, with libtiff and the GPL-licensed libjbig it brings, is removed from the AppImage (`app/strip-appimage.sh`; the build fails if anything still needs them). On Windows and macOS the app uses the operating system's web view. | `THIRD-PARTY-NOTICES.txt` and `THIRD-PARTY-NOTICES-native.txt` in the app (`app/` in the repository) |

So: everything except the desktop app is permissively licensed throughout
(MIT, Apache-2.0, BSD-style, PSF, OFL for the fonts, Artistic-2.0 for the
curve data); the desktop app adds MPL-2.0 crates and, in the AppImage, LGPL
system libraries, whose terms (source availability of those files and
libraries, the right to replace a shared library) apply to that download.
Engines never link GPL or LGPL code; the notices generator fails the build
if one would.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in Sagebrush, as defined in the Apache-2.0 license,
is dual licensed as above, without any additional terms or conditions. See
[CONTRIBUTING.md](CONTRIBUTING.md).
