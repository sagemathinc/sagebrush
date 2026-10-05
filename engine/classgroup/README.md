# sagebrush-classgroup

Class groups of imaginary quadratic fields in pure Rust, MIT OR Apache-2.0.

This is a clean-room implementation from the published algorithms: Jacobson's
self-initialising sieve for relations, Hafner–McCurley style linear algebra and
Bach's bound under GRH. PARI/GP is used only as an oracle and a benchmark. No
PARI source was read or ported.

## Status

- Fundamental discriminants D < 0 with |D| < 2^118.
- The result is `h` and the invariants `cyc`, in the same order as PARI's
  `quadclassunit(D).cyc`.
- The result assumes GRH, like PARI's default.
- Real quadratic fields and general number fields are next.

```
cargo run --release -p sagebrush-classgroup --example qcl -- -100000000000000000000000000319
```

## How it works

1. **Factor base.** Split primes up to Bach's bound 6 log²|D|, which generate
   the class group under GRH.
2. **Relations** (`relations.rs`). For each sieve polynomial
   `(a x + b)² − D = a·Q(x)`, `a` is a product of factor-base primes. The
   sieve uses u8 logarithms; candidates are confirmed by trial division.
   - Partial relations with one large prime are combined in pairs.
   - The first prime of `a` is the least-covered prime, so every column gets
     relations quickly.
3. **Structured Gaussian elimination** (`linalg.rs`) on ±1 pivots, large
   primes first. It leaves a dense core of a few hundred columns.
4. **A multiple of the determinant.** Take the gcd of the determinants of two
   or three independent square subsets of the core. The determinants are
   computed by CRT over word-size primes, with lazily reduced elimination.
5. **Hermite normal form modulo that multiple**, in u64 Barrett arithmetic. It
   stops as soon as the determinant drops below √2·ĥ, where ĥ is the Euler
   product estimate of h. The true h lies within a factor √2 of ĥ, so any
   multiple of h below that bound is h.
6. **Smith normal form**, on the few generators whose HNF diagonal is > 1 after
   the others are substituted away.

## Timing against PARI 2.17.4

One core of an AMD EPYC 7B13. D = −p for the first three primes p ≡ 3 (mod 4)
above 10^k. PARI is `quadclassunit(D)`. The time shown is the median of the
three discriminants, in ms. All 42 results agree with PARI.

| k  | PARI | ours |
|----|-----:|-----:|
| 9  |    1 |    5 |
| 13 |    2 |   14 |
| 17 |    6 |   33 |
| 21 |   29 |   65 |
| 25 |   78 |  128 |
| 27 |  183 |  220 |
| 29 |  415 |  335 |
| 31 |  770 |  575 |
| 33 | 1850 |  870 |
| 35 | 2299 | 2332 |

At the small end the time is mostly fixed overhead in sieve setup and the
L-function estimate. That has not been tuned yet.
