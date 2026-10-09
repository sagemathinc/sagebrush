<!-- description: Choosing a permissively licensed big integer library by measurement (dashu vs num-bigint vs GMP), adding a half-gcd and NTT multiplication, and what WebAssembly really costs. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history and benchmarks (bench/bigint) of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Big integers

*Code: `engine/bigint` (crate `sagebrush-bigint`), `bench/bigint`.
Sources: Schönhage; Thull–Yap; Möller, "On Schönhage's algorithm and
subquadratic integer gcd computation"; Harvey's NTT techniques.*

## Measure first

GMP is the standard, but it is LGPL, and it is not easy to ship in a
browser. Before choosing, `bench/bigint` measured the pure-Rust options
against GMP, natively and in WebAssembly. Every result was checked against
the reference library.

Time relative to GMP, natively (lower is better):

| operation | bits | malachite | dashu | num-bigint |
|---|---|---|---|---|
| mul | 1,024 | 1.5 | 1.3 | 1.7 |
| mul | 4,194,304 | 12 | 3.4 | 8.1 |
| gcd | 64 | 0.8 | 0.9 | **15** |
| gcd | 1,048,576 | 8.1 | 3.9 | **65** |
| from_dec | 4,194,304 | 10 | 3.5 | **38** |

The engines had been written against `num-bigint`. Its gcd was the weak
spot: 5–65× slower than GMP, and quadratic with a large constant.
**dashu** was the strongest permissive library: 1.3–3.5× GMP for
multiplication at every size, with gcd at GMP's speed up to 64K bits.
malachite is LGPL, so it was a yardstick only, and has a performance cliff
at 64K bits.

## A facade, not a rewrite

`sagebrush-bigint` exposes `num-bigint`'s API as newtypes over dashu's
`IBig`/`UBig`: operators with references, `num-traits`, `num-integer`,
`Roots`, and `Ratio`. The engines' code only changed its imports.

Two details made the switch safe:

- **A semantics test, run against both backends.** It pins
  `num-bigint`'s behavior: truncating `/` and `%`, floor division,
  $\gcd(0, 0) = 0$, the ranges of `modinv`.
- **A feature flag, `num-backend`, keeps `num-bigint` selectable.** A/B
  runs on real workloads gave identical outputs. General number fields got
  1.4–1.7× faster; the word-level engines were unchanged.

## A subquadratic gcd

Beyond a million bits, dashu's Lehmer gcd is quadratic. `hgcd.rs` adds the
half-gcd: $O(M(n) \log n)$, recursing on the top bits and bottoming out in
`u128` arithmetic. It is used when both inputs have at least $2^{20}$ bits;
the measured crossover with dashu's Lehmer gcd is about 800K bits.

**The design point that kept it simple.** Any integer matrix of
determinant $\pm 1$ preserves the gcd, and the reduced pair is always
computed exactly from the matrix. So a matrix found from truncated numbers
can only slow the reduction, never make it wrong. If progress is poor, a
plain division step follows. Correctness never depends on how good the
recursion's guesses are.

Measured gcd times:

| bits | GMP | dashu | Sagebrush |
|---|---|---|---|
| 1M | 86 ms | 0.40 s | 0.34 s |
| 2M | 0.21 s | 1.59 s | 0.92 s |
| 4M | 0.51 s | 6.31 s | 2.37 s |
| 8M | 1.22 s | 25.2 s | 5.87 s |

Each doubling now costs about 2.5× instead of 4×. The rest of the gap to
GMP is multiplication.

**NTT multiplication.** From 4096 words, products use three-prime NTTs
(primes $c \cdot 2^{50} + 1$), 1.4–1.9× faster than dashu's. Division
still uses dashu's own multiplication, and costs about 3.4 of them. So
faster division, and with it a faster gcd, is the next lever.

## WebAssembly: the "30× slower" that was not

An early note said the engines were 30× slower in the browser. The native
baseline had been mismeasured: 0.1 s instead of 0.9 s. The measured
truth: every library is **2.5–4× slower** in WebAssembly than natively.
The causes are 32-bit limbs and no 64×64→128-bit multiply instruction.

One targeted fix: on wasm32, 64×64-bit products in the ECM kernel are
split into 32-bit halves instead of calling the 128-bit multiply routine.
That is tested exhaustively against `u128`, and took factoring
$2^{128} + 1$ from 2.7 s to 1.5 s in WebAssembly.

## Small numbers matter too

ECM's Montgomery multiplication is specialized per limb count, so its
loops unroll: 37 ns became 13 ns at 128 bits, and $2^{128}+1$ factors in
0.57 s natively (it was 0.90 s).

Inside hot loops, avoid the facade's convenience conversions. For example,
`to_u64_digits` went through bytes, with three allocations. The
Gröbner-basis work (see its series) added `rem_u64` and `from_limbs`,
which read and write words in place.

## What would have saved time

- **Benchmark the libraries on the operations you use, at the sizes you
  use, before writing engines against one.** A day of measurement decided
  this cleanly.
- **Double-check surprising baselines.** The "30×" claim shaped decisions
  until a re-measurement showed it was wrong.
- **Prefer algorithms whose correctness does not depend on their
  heuristics.** The half-gcd's determinant-$\pm 1$ argument meant there were
  no subtle correctness bugs to chase.
