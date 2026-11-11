# Big integers: a plan for Sagebrush's dashu fork

**Status: a plan, not an implementation.** Nothing here is built yet. William asked for it on Nov 10 2026: "I do NOT think we should implement it right now. But it's an ideal time to have a good plan in our repo. Then it will be easier at any point to pull the trigger." Each phase below is meant to start on its own decision.

## 1. In short

- Sagebrush's engines do their big-integer arithmetic in `sagebrush-bigint` (`engine/bigint`). It is a thin layer over [dashu-int](https://github.com/cmpute/dashu) 0.6.2 (MIT OR Apache-2.0), plus three things of our own:
  - an NTT for huge products;
  - a half-gcd for huge gcds;
  - word-size modular arithmetic.
  
  Our fork of dashu, `sagemathinc/dashu`, has a benchmark against GMP (`benchmark/vs-gmp/`) but no code that Sagebrush builds from yet.
- **What we know (section 4).**
  - Natively, dashu is at most 4 times slower than GMP built with assembly at every size we measured, and faster at parsing 1,000-digit decimals.
  - Up to $10^5$ digits it takes 0.32 to 1.09 of the time of GMP built without assembly.
  - In the browser, it is 3.4 to 20 times faster than the GMP that Pyodide ships.
  - The remaining gaps are:
    - at $10^6$ digits, algorithms: no Newton division, and the NTT not used inside division, square root and conversion;
    - below $10^5$ digits, GMP's assembly inner loops;
    - in WebAssembly, the missing $64 \times 64 \to 128$ multiply.
- **What we don't know yet** decides the order of the work. We have never measured:
  - numbers below 1,000 digits, which is where most of Sagebrush's number theory lives;
  - what share of real workloads' time is big-integer arithmetic at all.

  So the first phase only measures (section 7, item W0).
- **The work (section 7)** is ten items, W0 to W9, ranked by expected payoff on Sagebrush's own workloads. They land as small independent PRs in five phases (section 8), with an explicit stopping point after the third.

## 2. Where big integers live today

There are three integer implementations, and two boundaries between them.

1. **The Python runtime's `int`.** It is a JS number when it fits in $\pm(2^{53}-1)$, and a V8 `BigInt` otherwise (PLAN.md, "int"). Every mode's Python code uses it: Sage, Magma (whose arithmetic reuses Sage mode's library, lib/_magma.py), MATLAB, Rill and plain Python. V8's BigInt is native code, with a hardware 128-bit multiply per limb product and subquadratic algorithms for large operands.
2. **The engines' integers**, `sagebrush_bigint::{BigInt, BigUint, BigRational}`. These are num-bigint's API as newtypes over dashu's `IBig` and `UBig` (engine/bigint/src/dashu_impl.rs). On top of dashu:
   - products of two operands of at least 4,096 words go to our 3-prime NTT (engine/bigint/src/ntt.rs, ntt32.rs, ntt_core.rs; Harvey's transforms), 1.4 to 1.9 times faster than dashu's own from 256K bits;
   - gcds of operands of at least $2^{20}$ bits go to our half-gcd (hgcd.rs);
   - `nmod.rs` does word-size modular arithmetic: Möller-Granlund reciprocals and Shoup multiplication.

   dashu comes from crates.io (Cargo.lock: dashu-int 0.6.2, dashu-base 0.6.1), not from the fork.
3. **The multiprecision core** (`engine/mp`, mpmath's numbers) uses the same `sagebrush-bigint` for its mantissas.

The boundaries:

- **Python to the engines.** Requests are JSON. Big integers cross as decimal strings, parsed with `str::parse::<BigInt>` (engine/web/src/lib.rs, `call`), and replies come back as decimal too. Every big operand therefore pays a radix conversion each way.
- **Python to the mp core.** Mantissas cross as 64-bit words (src/runtime/mpcore.ts, `wordsOf`), with no radix conversion.

**The fork.** `sagemathinc/dashu` follows upstream's master, version 0.6.2 plus later commits. It holds `benchmark/vs-gmp/` and one unused branch, `sagebrush-wasm32`, which tunes schoolbook multiplication for 32-bit wasm words.

## 3. Users, now and planned

| User | Crates | Typical sizes | What matters most |
|---|---|---|---|
| Multimodular algorithms: F4 over $\mathbb{Q}$, linear algebra over $\mathbb{Z}$ and $\mathbb{Q}$, modular symbols, Hilbert modular forms | mpoly (f4q, certify, fglm), arith (crt, zmat, zpoly), modsym, hmf | coefficients of 1 to a few hundred words; many of them | reducing many integers mod many word-size primes, CRT and rational reconstruction, small-integer overhead, word-size modular arithmetic |
| Number fields and class groups | poly (nf), classgroup (relations, HNF, bnf), galois | 1 to 100 words; HNF entries grow | small and medium multiplication, gcd and extended gcd, exact division |
| Elliptic curves, factoring, point counting | ap, arith (ECM's Montgomery multiplication), poly | 1 to 30 words, the same modulus many times | multiplication modulo a fixed $N$ (a reusable inverse), modular exponentiation |
| Exact constants and ball arithmetic | sym, ball, bigint/exact.rs (Bernoulli numbers) | up to $10^5$ to $10^6$ digits for big tables | large products, binary splitting, exact division |
| mpmath | mp | 53 bits to $10^5$ digits and beyond | mul, div, sqrt and shifts at the working precision; radix conversion for printing; at high precision, the binary-splitting constants ($\pi$, $\log 2$, $\gamma$, $e$) and the elementary functions |
| Sage and Magma modes | through `_sbengine` (lib/sagebrush/_engine.py) and the mp core | as above | as above, plus the JSON boundary |
| MATLAB and Rill | none of the engines' yet | none | none today. A variable-precision feature (MATLAB's `vpa`, R's `Rmpfr` or `gmp`) would go through the mp core and the engines, not a copy |

The sizes in this table are estimates from the algorithms. W0 measures them.

**The tiers:**

| Tier | Build | Threads | Limb products |
|---|---|---|---|
| The browser | wasm32 | one (the `parallel` feature of engine/par is off) | each $64 \times 64 \to 128$ product costs about four `i64.mul` |
| Native (CLI over N-API, PyPI over PyO3) | x86-64 and aarch64 | rayon, through engine/par | one hardware instruction |

**On threads.** Parallelism pays at the level of the algorithm: primes in multimodular algorithms, rows, independent subproblems. engine/par already provides it natively. Threading one integer operation pays only at millions of digits, which is outside the sizes above, so this plan doesn't propose it.

## 4. Measurements so far

**Native, against GMP 6.3.0.** Measured Nov 11 2026 on one core of an AMD EPYC 7B13. "Generic C" is GMP built with `--disable-assembly`. Times in ms; the "sagebrush-bigint" column includes our NTT. Source: the fork's `benchmark/vs-gmp/README.md` and `results/`.

| digits | op | GMP asm | GMP generic C | dashu-int | sagebrush-bigint |
|---:|---|---:|---:|---:|---:|
| $10^3$ | mul | 0.00154 | 0.00608 | 0.00201 | 0.00193 |
| $10^3$ | div | 0.00257 | 0.00755 | 0.00442 | 0.00439 |
| $10^4$ | mul | 0.0436 | 0.153 | 0.0823 | 0.0826 |
| $10^5$ | mul | 1.04 | 3.21 | 3.12 | 3.48 |
| $10^5$ | div | 3.13 | 10.2 | 6.03 | 6.37 |
| $10^6$ | mul | 14 | 46.7 | 46.3 | 30.2 |
| $10^6$ | div | 44.6 | 142 | 178 | 195 |
| $10^6$ | sqrt | 33.6 | 85.8 | 130 | 144 |
| $10^6$ | to_str | 82.9 | 235 | 240 | 259 |

**In the browser** (wasm32, headless Chromium 149, same source):

| digits | op | sagebrush-bigint | Pyodide's GMP (gmpy2) |
|---:|---|---:|---:|
| $10^3$ | mul | 0.00865 | 0.110 |
| $10^5$ | mul | 7.04 | 37.7 |
| $10^6$ | mul | 66.9 | 716 |
| $10^6$ | div | 562 | 1,906 |

Pyodide's GMP is a poor baseline: in the same page, its 1,000-digit product is ten times slower than Pyodide's own Python `int`.

**Other findings:**
- **The wasm core against V8's BigInt** (mpmath core work, Nov 10 2026, measured on the core's earlier limb arithmetic, before it moved onto sagebrush-bigint; to be measured again in Phase 0). The wasm core loses to V8's BigInt from about 1,000 digits, structurally:
  - WebAssembly has no instruction for the high half of a $64 \times 64$ product, so each limb product costs about four `i64.mul`.
  - An explicit 32-bit-halves kernel gained nothing, since LLVM already inlines the equivalent.
  - 32-bit limbs need four times the products.
  - SIMD `extmul` gains at most about 2 times.
  - Examples: an integer square root at 664K bits takes 54 ms in the core and 11 ms with V8's BigInt. At 1,000 digits, limb multiplication is a third of an mpf product's time.
- **Half-gcd** (Oct 2026). At 8M bits: ours 5.9 s, dashu's Lehmer 25 s, GMP 1.2 s.
- **F4 over $\mathbb{Q}$** (Oct 2026).
  - Fixed-width limb accumulators did not beat dashu, because the volume of arithmetic dominates.
  - Converting to 64-bit words allocated three times what it needed. Code that only needs a residue should use `rem_u64` and `from_limbs`.

**Not yet measured,** which is Phase 0's job:
- sizes of 1 to 50 words;
- batched kernels (residues, CRT, dot products, rational reconstruction);
- the JSON boundary's cost;
- the share of real workloads' time spent in integer arithmetic.

## 5. What dashu-int 0.6.2 lacks

Read from its source (MIT OR Apache-2.0):

- **Multiplication:**
  - schoolbook up to 24 words, Karatsuba up to 96, Toom-3 above that, and its own NTT above about 4,000 words;
  - no Toom-4, Toom-6.5 or Toom-8.5;
  - the same thresholds on every target;
  - no wasm-specific basecase. The fork's `sagebrush-wasm32` branch starts one.
- **Our NTT is used only for top-level products.** dashu's division, square root and radix conversion call dashu's own multiplication, so they never see it. That's why sagebrush-bigint's division at $10^6$ digits is no faster than dashu's.
- **Division** is divide-and-conquer (Burnikel-Ziegler), $O(M(n) \log n)$:
  - no Newton reciprocal;
  - no division by an invariant divisor with a precomputed inverse (Barrett, or Montgomery for odd moduli);
  - no API for reusing an inverse across many divisions by the same number.
- **Square root** is Zimmermann's Karatsuba square root, on that division.
- **Radix conversion** is divide-and-conquer, on that division.
- **gcd** is Lehmer's, quadratic. Ours replaces it above $2^{20}$ bits, outside dashu.
- **No fused or batched operations:**
  - multiply-and-accumulate into an existing buffer;
  - dot products with delayed carries;
  - residues of many integers modulo one set of primes.
  

## 6. Rules the work follows

- **One implementation per tier, in the shared crate** (William, Nov 10 2026). A faster algorithm goes into the fork or sagebrush-bigint, never into a mode's or an engine's private copy. Every user gets it at once.
- **Size is tracked.** The lazy core has no hard limit ("no hard limit for the lazy core, track size only", William, Nov 10 2026). Every byte the engine or core wasm grows still needs a reviewed growth marker (design/size-gate.md).
- **Confirmed upstream bugs get fixed, not reproduced.** A bug found in dashu is fixed in the fork, reported upstream, and pinned by a test.
- **Clean-room, permissive sources only.** We may read:
  - published papers and textbooks:
    - Brent and Zimmermann, *Modern Computer Arithmetic*;
    - Knuth, TAOCP vol. 2;
    - Crandall and Pomerance;
    - Bernstein, "Fast multiplication and its applications";
    - Burnikel and Ziegler;
    - Möller and Granlund;
    - Harvey's NTT papers;
    - Zimmermann's Karatsuba square root;
    - Hasselström's thesis on Newton division;
  - permissively licensed code: dashu itself, num-bigint, and V8's BigInt (BSD).

  We may not read GMP, MPFR or FLINT source, nor any GPL or LGPL code. Those libraries are black-box oracles and benchmark baselines only, never shipped dependencies.
- **Shipped dependencies stay MIT or Apache-2.0.** No shipped engine links GMP, MPFR or FLINT.

## 7. The work, ranked

Each gain below is an estimate, from the measured ratios in section 4, until its phase measures it. The baselines:
- **Native:** GMP 6.3.0 with assembly and as generic C.
- **Browser:** Pyodide 314.0.7's gmpy2, and V8's BigInt through the Python runtime.

### W0. Measure first (no change to dashu)

- **What:** extend `benchmark/vs-gmp` with:
  - sizes of 1, 2, 4, 8, 16, 32 and 64 words;
  - batched kernels: residues of 1,000 integers modulo 100 word-size primes, CRT reconstruction, a dot product over $\mathbb{Z}$, gcd, extended gcd, rational reconstruction;
  - the JSON boundary, as decimal against hex or words.

  Then profile real workloads, each natively and in wasm, and report the share of time in big-integer arithmetic, by size:
  - modular symbols at a large level;
  - F4 over $\mathbb{Q}$ (katsura-9, cyclic-7);
  - a class group;
  - ECM;
  - the mp core's performance rows.
- **Why:** sections 3 and 4 show the most common sizes are the ones we haven't measured. W2 to W5's order depends on the result.
- **Baselines:** GMP asm and generic C natively. FLINT's `fmpz` for the batched kernels, as a benchmark binary only. Pyodide's gmpy2 and V8's BigInt in the browser.
- **Risk:** none to the product. **Size:** none. **Tests:** the harness checks every result against GMP's.

### W1. Our NTT inside dashu's multiplication

- **What:** move the NTT (ntt.rs, ntt32.rs, ntt_core.rs, and the parts of nmod.rs they use) into the fork, as part of dashu-int's multiplication dispatch, behind a feature. sagebrush-bigint and sagebrush-arith then use it from there; arith needs it for polynomial products mod $n$. That keeps one copy.
- **Why:** dashu's division, square root and radix conversion get the faster multiplication too.
- **Expected gain:** largest in wasm, where our NTT beats dashu's from somewhere between $10^4$ and $10^5$ digits:
  - wasm at $10^6$ digits: division, square root and printing about 1.5 times faster;
  - native: about 10 to 20% at $10^6$ digits, nothing below about $10^5$ (our NTT starts at 4,096 words there).
- **Risk:** low. The NTT is already tested and used. The work is plumbing and thresholds.
- **Size:** near zero for the engine, since the code moves. The mp core already links the NTT.
- **Tests:**
  - every product at the threshold, plus and minus 1 word, against schoolbook and against GMP;
  - the existing NTT tests, moved with it.
- **Mutants:** the threshold off by one word; a dropped carry in the final carry pass; a wrong prime's CRT constant.

### W2. Small integers and the basecase loops

- **What:**
  - **Allocation:** measure and cut the per-operation overhead for 1- to 4-word values (inline storage, avoiding clones in the facade's newtypes).
  - **Inner loops, native:** tune the loops everything rests on (schoolbook multiplication, `addmul_1`, `submul_1`, division by one word) with `u128` arithmetic, then `core::arch` intrinsics (`_mulx_u64`, `_addcarry_u64`).
  - **Inner loops, wasm32:** finish and measure the fork's `sagebrush-wasm32` branch.
  - **Thresholds:** set them per target.
- **Why:** most numbers in the multimodular, number-field and elliptic-curve users are 1 to 100 words (section 3). At 1,000 digits, GMP's assembly is 1.3 to 2.2 times faster natively for every operation but parsing.
- **Expected gain:**
  - native: perhaps 1.2 to 1.5 times at 1 to 100 words;
  - wasm: bounded by the four-`i64.mul` limb product (section 4), so at most about 1.5 to 2 times, with SIMD.
- **Risk:** medium. Carry bugs are subtle, and intrinsics bring `unsafe`, which needs a SEC review and Miri runs.
- **Size:** a few KB.
- **Tests:**
  - exhaustive carry patterns (all-ones limbs, $2^k \pm 1$, alternating bits);
  - every size from 1 to 128 words against the portable path and GMP;
  - Miri on the unsafe paths.

### W3. Batched kernels for multimodular algorithms

- **What:**
  - residues of many integers modulo one set of primes, with a remainder tree above a threshold;
  - CRT reconstruction with a product tree above a threshold;
  - multiply-and-accumulate into a preallocated buffer;
  - dot products with delayed carries;
  - conversions to and from words that don't allocate.

  These live in sagebrush-bigint, or in the fork where they're general. engine/arith/src/crt.rs and F4's accumulators move onto them.
- **Why:** the multimodular pattern (reduce, compute mod $p$, lift) is the most common shape of Sagebrush's exact algorithms. Its cost is in these steps, not in large multiplications.
- **Expected gain:** set by W0. The current CRT is linear in (primes $\times$ words) per value, which is right for tens to hundreds of primes. The trees pay off only beyond that.
- **Risk:** low to medium.
- **Size:** a few KB.
- **Tests:**
  - CRT round trips against the residues;
  - sizes across the tree thresholds;
  - the engines' own suites as end-to-end tests: sage-tests and the modular symbols, F4 and class group tests.

### W4. Newton division, division by an invariant, square root and radix conversion

- **What:**
  - a Newton reciprocal;
  - division using it ("mu" division, which costs $O(M(n))$);
  - an API to precompute the inverse of a divisor and reuse it (Barrett; Montgomery for odd moduli);
  - square root on the new division;
  - radix conversion that reuses the inverses of the powers of the radix.
- **Why:** this is the algorithmic gap at $10^6$ digits. A reusable inverse also serves arithmetic modulo a fixed $N$: ECM, modular exponentiation, class groups.
- **Expected gain, at $10^6$ digits with W1:**
  - native division from 178 ms to about 90 ms (about 2 times GMP asm, 0.65 times GMP generic C);
  - native square root from 130 to about 60;
  - wasm division from 545 to about 200;
  - at $10^5$ digits natively: 10 to 15%.

  A first version may land 20 to 30% above these.
- **Risk:** medium to high. Newton steps need exact correction steps, and an off-by-one in a correction gives wrong quotients only rarely.
- **Size:** about 10 to 20 KB (an estimate).
- **Tests:**
  - $a = qb + r$ with $0 \le r < b$ on random and adversarial operands ($b$ just above a power of 2, $a$ just below $qb$), at every threshold plus and minus 1 word;
  - $s^2 \le n < (s+1)^2$;
  - radix round trips;
  - GMP as the oracle.
- **Mutants:** one Newton step fewer; the final correction removed; the precomputed inverse one ulp low.

### W5. Toom-4 and Toom-6.5, with per-target thresholds

- **What:** the Toom-Cook variants between Toom-3 and the NTT, each threshold measured on each target.
- **Why:** from $10^4$ to $10^5$ digits, native multiplication is 1.9 to 3.3 times GMP asm. Division, square root and conversion inherit whatever multiplication costs.
- **Expected gain:** perhaps 1.2 to 1.5 times on multiplication in that range (an estimate).
- **Risk:** medium. The interpolation formulas carry exact divisions and signs.
- **Size:** about 5 to 10 KB.
- **Tests:** every size across each threshold against schoolbook and GMP; unbalanced operands.

### W6. gcd

- **What:**
  - move our half-gcd into the fork's gcd dispatch;
  - lower its threshold where measurements say;
  - an extended gcd and a half-gcd-based rational reconstruction.
- **Why:** number fields, class groups, lifting, and anything over $\mathbb{Q}$.
- **Expected gain:** medium and large sizes. At 8M bits we are at 5.9 s against GMP's 1.2 s.
- **Risk:** medium.
- **Size:** small (the code moves).
- **Tests:** Bezout identities; gcds against GMP; matrices of determinant $\pm 1$.

### W7. The Python-to-engine boundary

- **What:** carry big integers between the Python runtime and the engines as hex or as words, not as decimal JSON strings.
- **Why:** every big operand pays a decimal conversion each way today. This is part of the integer path, but not of dashu.
- **Expected gain:** set by W0.
- **Risk:** low.
- **Size:** small.
- **Tests:** round trips at every size, and the engines' suites.

### W8. WebAssembly-specific levers

- **What:** three options, each a decision rather than a default:
  - **The wide-arithmetic proposal** (`i64.mul_wide_u`, `i64.add128`). Mozilla's intent to ship (Aug 2026) enables it by default in Firefox 155. Chrome's status is unverified. It would make a limb product one instruction. Since browsers differ, using it means two builds of the lazy mp core, or of the engine, chosen at load time.
  - **SIMD** basecase loops.
  - **Routing huge mp-core operands to V8's BigInt.** It beats the wasm core from about 1,000 digits, but this is a design change.
- **Why:** the wasm limb product is the browser tier's structural limit (section 4).
- **Risk:** medium (two builds), or a design change (routing).
- **Size:** a second build of the mp core is about 200 KB, fetched instead of the first, never in addition. A second engine build is much larger.
- **Tests:** the same suites on every build.

### W9. Native assembly (optional)

- **What:** `asm!` basecase loops for x86-64 (`mulx`, `adcx`, `adox`) and aarch64.
- **Why:** the last factor of 1.3 to 2 natively below $10^4$ digits.
- **Risk:** high maintenance, and `unsafe` code (SEC review, Miri cannot run inline assembly).
- **Size:** native only, so no wasm growth.
- **Tests:** against the portable path and GMP, on both architectures in CI.

## 8. Phases

Each phase is a series of small PRs that each land on their own, with tests, size markers and the usual review lanes.

| Phase | Items | Exit criteria |
|---|---|---|
| 0. Measure | W0 | A committed report: per-size baselines for 1 word to $10^6$ digits, natively and in wasm; each real workload's share of time in integer arithmetic, by operation and size; the boundary's cost. Decides the order of W2 to W5 and whether to go on. |
| 1. Plumbing | building from the fork; W1 | Sagebrush builds dashu from the fork, pinned to a commit (section 9). CI runs dashu's own tests on the fork. The differential harness (GMP as oracle) and fuzz targets exist. W1 lands, with results identical to before on every suite and its measured gain recorded. |
| 2. The common sizes | W3, W2 (native, then wasm), W7 if W0 shows it matters | Measured gains on the Phase 0 workloads, not just on micro-benchmarks. |
| **Stop here** unless Phase 0 or 2 shows a reason to go on: a real workload spending a sizable share of its time in multiplication or division at $10^4$ digits or more, or the mp core needing high-precision speed (mpmath at $10^5$ digits and beyond). | | |
| 3. Large sizes | W4, W6 | At $10^6$ digits, natively: division within about 2 times GMP asm, and at or below GMP generic C for every operation. |
| 4. The middle range and the browser | W5, W8 | Thresholds measured per target. A decision on wide arithmetic, recorded. |
| 5. Optional | W9 | Only on a separate decision. |

## 9. Upstream, and the cost of the fork

- **Upstream** is dashu (its crates are MIT OR Apache-2.0), maintained and active: its last commits are from Oct 18 2026, and our fork's master is that plus the benchmark. General improvements go upstream as PRs alongside our own use: W1's NTT, W4, W5, W6, and the basecase work. That keeps the fork's diff small.
- **What stays in the fork:**
  - Sagebrush-specific hooks: interrupt checks in long loops (engine/interrupt), and the memory ledger's accounting if it moves down;
  - tuning upstream doesn't want;
  - batched kernels too specific to Sagebrush's uses.
- **How Sagebrush builds from the fork** is a decision (open question 1):
  - a `[patch.crates-io]` entry pinned to a git commit;
  - a vendored copy under `engine/`;
  - our own published crates.

  Each choice is pinned and reproducible; its provenance needs SEC review (supply chain).
- **The cost:**
  - rebasing on each upstream release (0.6.x, 0.7);
  - CI for the fork;
  - review of every fork change in the same lanes as engine code.

  Upstreaming early keeps it small.

## 10. Testing, in every phase

- **Oracles:**
  - GMP, through a C harness or gmpy2, as a black box;
  - num-bigint, an independent permissive implementation, already selectable as `sagebrush-bigint`'s `num-backend` feature;
  - Python's `int`;
  - FLINT as a benchmark baseline only.
- **Identities** that need no oracle:
  - $a = qb + r$;
  - $s^2 \le n < (s+1)^2$;
  - radix round trips;
  - Bezout coefficients;
  - CRT round trips;
  - a product computed by every algorithm agreeing with the others.
- **Sizes:** every threshold plus and minus 1 word, on each target.
- **Adversarial operands:** all-ones limbs, $2^k \pm 1$, sparse operands, divisors just above a power of 2.
- **Fuzzing:** cargo-fuzz targets per operation, run natively.
- **Mutants:** each item lists the mutants its tests must kill, and the TESTS review runs them.
- **End to end:** sage-tests, magma-tests, the engines' suites, and the mp core's corpora, natively and in wasm.

## 11. Open questions for William

1. **How should Sagebrush consume the fork?** A pinned git dependency, a vendored copy, or published crates.
2. **Upstream first, or the fork first** with upstream PRs following?
3. **May we read GMP's manual?** Its "Algorithms" chapter is documentation, not code. This plan assumes papers and textbooks only.
4. **Is native assembly (W9) worth the `unsafe` code and the maintenance?**
5. **In the browser:** routing huge mp-core operands to V8's BigInt (a design change), or keeping everything in wasm?
6. **Should we use wide arithmetic,** with two builds chosen at load time, once the major browsers ship it?
7. **What priority does this work get** against the rest of the roadmap? Is the stopping point after Phase 2 the right one?
