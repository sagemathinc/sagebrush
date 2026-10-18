# Exact linear algebra and polynomial arithmetic

Benchmarks of `engine/arith` (see [its README](../../engine/arith/README.md))
against FLINT 3.6, and of the Sage layer before and after it. Every timing
also checks that the answers agree. One core of an AMD EPYC 7B13;
`OPENBLAS_NUM_THREADS=1` for FLINT. The two Rust-level tables below are
from Oct 18 2026, FLINT 3.6.0, on an otherwise idle machine
([results/bench/2026-10-18-rust-flint.txt](../../results/bench/2026-10-18-rust-flint.txt)).
`sagebrush bench linalg` and `sagebrush bench sagelayer` time the same
kinds of operations from Python (last sections).

## Matrices over Z

The inputs are random square matrices with entries of the given size. rref
is an n by n+5 matrix of rank n/2. Rerun with
`cargo run --release -p sagebrush-oracle --example matbench -- 10 30 100`.
The ratio is Sagebrush's time divided by FLINT's: below 1 means Sagebrush
is faster.

| op | n | entry bits | Sagebrush | FLINT 3.6 | ratio |
|---|---:|---:|---:|---:|---:|
| det | 10 | 7 | 0.011 ms | 0.003 ms | 3.73 |
| solve | 10 | 7 | 0.031 ms | 0.008 ms | 3.93 |
| inverse | 10 | 7 | 0.036 ms | 0.039 ms | 0.93 |
| charpoly | 10 | 7 | 0.021 ms | 0.017 ms | 1.23 |
| rref | 10 | 7 | 0.030 ms | 0.005 ms | 6.01 |
| det | 10 | 41 | 0.027 ms | 0.017 ms | 1.58 |
| solve | 10 | 41 | 0.179 ms | 0.031 ms | 5.83 |
| inverse | 10 | 41 | 0.089 ms | 0.120 ms | 0.74 |
| charpoly | 10 | 41 | 0.052 ms | 0.048 ms | 1.09 |
| rref | 10 | 41 | 0.061 ms | 0.029 ms | 2.14 |
| det | 30 | 7 | 0.162 ms | 0.105 ms | 1.54 |
| solve | 30 | 7 | 0.252 ms | 0.194 ms | 1.30 |
| inverse | 30 | 7 | 0.687 ms | 3.062 ms | 0.22 |
| charpoly | 30 | 7 | 0.436 ms | 0.292 ms | 1.49 |
| rref | 30 | 7 | 0.356 ms | 0.446 ms | 0.80 |
| det | 30 | 41 | 0.573 ms | 0.521 ms | 1.10 |
| solve | 30 | 41 | 1.367 ms | 0.890 ms | 1.54 |
| inverse | 30 | 41 | 2.834 ms | 15.408 ms | 0.18 |
| charpoly | 30 | 41 | 1.760 ms | 1.528 ms | 1.15 |
| rref | 30 | 41 | 0.938 ms | 1.261 ms | 0.74 |
| det | 100 | 7 | 6.106 ms | 3.662 ms | 1.67 |
| solve | 100 | 7 | 4.202 ms | 3.691 ms | 1.14 |
| inverse | 100 | 7 | 43.367 ms | 167.683 ms | 0.26 |
| charpoly | 100 | 7 | 37.671 ms | 25.120 ms | 1.50 |
| rref | 100 | 7 | 16.169 ms | 23.568 ms | 0.69 |
| det | 100 | 41 | 22.765 ms | 9.798 ms | 2.32 |
| solve | 100 | 41 | 19.223 ms | 14.215 ms | 1.35 |
| inverse | 100 | 41 | 232.697 ms | 1407.773 ms | 0.17 |
| charpoly | 100 | 41 | 167.687 ms | 112.721 ms | 1.49 |
| rref | 100 | 41 | 54.581 ms | 169.110 ms | 0.32 |

- **Inverses:** 3.8–5.9x faster than FLINT from n = 30 (multimodular, with
  the number of primes fixed by the Hadamard bound).
- **rref:** 1.25–3.1x faster from n = 30.
- **charpoly:** within 1.1–1.5x. Modulo each prime it is a Krylov sequence
  plus one elimination.
- **det and solve:** 1.1–2.3x behind (Dixon lifting).
- **Small matrices (n = 10):** up to 6x behind, under 0.2 ms either way.

Modulo p, elimination keeps up to 16 pivots pending. It brings the rows
below up to date one column at a time to find the next pivot, then applies
the whole block at once with u128 sums, one reduction per entry. That
matrix-product shape keeps the rows in cache. Done row by row instead, it
was 3–4x slower once the matrix no longer fit in L1.

## Polynomials over Z

The gcd inputs are g·a and g·b, with g of half the length. Rerun with
`cargo run --release -p sagebrush-oracle --example polybench`.

| op | length | coefficient bits | Sagebrush | FLINT 3.6 | ratio |
|---|---:|---:|---:|---:|---:|
| mul | 10 | 10 | 0.001 ms | 0.000 ms | 7.42 |
| gcd | 10 | 10 | 0.004 ms | 0.002 ms | 2.64 |
| mul | 100 | 10 | 0.011 ms | 0.004 ms | 2.73 |
| gcd | 100 | 10 | 0.074 ms | 0.014 ms | 5.25 |
| mul | 1000 | 10 | 0.104 ms | 0.064 ms | 1.62 |
| gcd | 1000 | 10 | 1.885 ms | 0.421 ms | 4.48 |
| mul | 10000 | 10 | 2.184 ms | 1.326 ms | 1.65 |
| gcd | 10000 | 10 | 141.982 ms | 31.761 ms | 4.47 |
| mul | 100 | 1000 | 0.951 ms | 0.197 ms | 4.82 |
| gcd | 100 | 1000 | 5.567 ms | 1.494 ms | 3.73 |
| mul | 1000 | 1000 | 9.146 ms | 2.507 ms | 3.65 |
| gcd | 1000 | 1000 | 99.804 ms | 33.914 ms | 2.94 |
| mul | 100000 | 20 | 22.371 ms | 23.442 ms | 0.95 |

- **Products, small coefficients:** the NTT directly, 1.6–2.7x behind
  FLINT from length 100, and level at length 100,000.
- **Products, large coefficients:** multimodular over primes p ≡ 1 mod
  2^32, one transform each, with a word-level CRT. 3.6–4.8x behind FLINT,
  whose large products use a SIMD floating-point FFT.
- **Gcds:** 2.6–5.3x behind.

## Huge integers: our NTT against dashu's multiplication

`cargo run --release -p sagebrush-arith --example nttbench`

| bits | Sagebrush NTT | dashu | dashu / NTT |
|---:|---:|---:|---:|
| 65,536 | 0.309 ms | 0.239 ms | 0.77 |
| 131,072 | 0.690 ms | 0.663 ms | 0.96 |
| 262,144 | 1.552 ms | 2.226 ms | 1.43 |
| 524,288 | 3.317 ms | 4.746 ms | 1.43 |
| 1,048,576 | 6.944 ms | 10.317 ms | 1.49 |
| 2,097,152 | 14.617 ms | 22.447 ms | 1.54 |
| 4,194,304 | 30.828 ms | 54.429 ms | 1.77 |
| 8,388,608 | 65.870 ms | 115.406 ms | 1.75 |

From 256K bits the 3-prime NTT is 1.4–1.9x faster than dashu's. The
`sagebrush-bigint` products use it from 4096 words on 64-bit targets.

## From Python: `sagebrush bench linalg`

The same kinds of inputs (drawn with fixed seeds, not the same matrices as
above), timed from CPython against FLINT 3.6 in a separate process (a small C
program, `flint_harness.c`, compiled against the FLINT that is installed):
the public call (`sagebrush.linalg`, `sagebrush.poly`, which returns Python
ints and Fractions), and the engine through its wire interface
(`sagebrush._engine.call`, the answer left as text). FLINT is timed inside
its own process on inputs it has already parsed. Every answer is compared
(as a fingerprint of its exact entries). One core of an AMD EPYC 7B13,
Oct 18 2026 ([results/bench](../../results/bench/README.md)).

| case | sagebrush.linalg / poly | engine (wire) | FLINT 3.6 | public / FLINT | engine / FLINT |
|---|---:|---:|---:|---:|---:|
| det n=10 7-bit | 0.038 ms | 0.021 ms | 0.003 ms | 15.27 | 8.48 |
| solve n=10 7-bit | 0.113 ms | 0.048 ms | 0.005 ms | 20.85 | 8.93 |
| inverse n=10 7-bit | 0.187 ms | 0.065 ms | 0.024 ms | 7.69 | 2.65 |
| charpoly n=10 7-bit | 0.066 ms | 0.033 ms | 0.014 ms | 4.63 | 2.31 |
| rref n=10 7-bit | 0.124 ms | 0.054 ms | 0.005 ms | 25.71 | 11.18 |
| det n=10 41-bit | 0.061 ms | 0.042 ms | 0.017 ms | 3.61 | 2.49 |
| solve n=10 41-bit | 0.288 ms | 0.195 ms | 0.025 ms | 11.55 | 7.83 |
| inverse n=10 41-bit | 0.499 ms | 0.188 ms | 0.070 ms | 7.13 | 2.68 |
| charpoly n=10 41-bit | 0.112 ms | 0.074 ms | 0.042 ms | 2.66 | 1.75 |
| rref n=10 41-bit | 0.229 ms | 0.107 ms | 0.027 ms | 8.33 | 3.90 |
| det n=30 7-bit | 0.319 ms | 0.207 ms | 0.107 ms | 2.99 | 1.94 |
| solve n=30 7-bit | 0.751 ms | 0.345 ms | 0.193 ms | 3.89 | 1.79 |
| inverse n=30 7-bit | 3.05 ms | 1.25 ms | 2.68 ms | 1.14 | 0.47 |
| charpoly n=30 7-bit | 0.733 ms | 0.496 ms | 0.276 ms | 2.65 | 1.80 |
| rref n=30 7-bit | 1.09 ms | 0.537 ms | 0.413 ms | 2.65 | 1.30 |
| det n=30 41-bit | 0.788 ms | 0.649 ms | 0.508 ms | 1.55 | 1.28 |
| solve n=30 41-bit | 2.27 ms | 1.59 ms | 0.757 ms | 2.99 | 2.11 |
| inverse n=30 41-bit | 13.6 ms | 5.53 ms | 13.8 ms | 0.98 | 0.40 |
| charpoly n=30 41-bit | 2.13 ms | 1.87 ms | 1.46 ms | 1.46 | 1.28 |
| rref n=30 41-bit | 3.03 ms | 1.52 ms | 1.26 ms | 2.41 | 1.21 |
| det n=100 7-bit | 7.78 ms | 6.56 ms | 3.84 ms | 2.03 | 1.71 |
| solve n=100 7-bit | 9.20 ms | 5.00 ms | 3.63 ms | 2.54 | 1.38 |
| inverse n=100 7-bit | 125 ms | 61.9 ms | 153 ms | 0.82 | 0.40 |
| charpoly n=100 7-bit | 39.6 ms | 37.1 ms | 24.7 ms | 1.61 | 1.50 |
| rref n=100 7-bit | 29.3 ms | 19.7 ms | 22.9 ms | 1.28 | 0.86 |
| det n=100 41-bit | 24.5 ms | 23.6 ms | 9.51 ms | 2.57 | 2.48 |
| solve n=100 41-bit | 30.7 ms | 22.8 ms | 13.3 ms | 2.32 | 1.72 |
| inverse n=100 41-bit | 872 ms | 393 ms | 1339 ms | 0.65 | 0.29 |
| charpoly n=100 41-bit | 173 ms | 168 ms | 112 ms | 1.54 | 1.50 |
| rref n=100 41-bit | 121 ms | 71.1 ms | 174 ms | 0.70 | 0.41 |
| poly mul len=10 10-bit | 0.013 ms | 0.010 ms | 0.000 ms | 93.03 | 65.90 |
| poly gcd len=10 10-bit | 0.015 ms | 0.012 ms | 0.002 ms | 9.55 | 7.74 |
| poly mul len=100 10-bit | 0.076 ms | 0.043 ms | 0.004 ms | 20.75 | 11.83 |
| poly gcd len=100 10-bit | 0.116 ms | 0.095 ms | 0.013 ms | 8.90 | 7.31 |
| poly mul len=1000 10-bit | 0.756 ms | 0.407 ms | 0.062 ms | 12.22 | 6.58 |
| poly gcd len=1000 10-bit | 2.33 ms | 2.13 ms | 0.410 ms | 5.69 | 5.19 |
| poly mul len=10000 10-bit | 8.50 ms | 5.05 ms | 1.55 ms | 5.50 | 3.27 |
| poly gcd len=10000 10-bit | 143 ms | 141 ms | 31.3 ms | 4.56 | 4.50 |
| poly mul len=100 1000-bit | 3.05 ms | 2.27 ms | 0.194 ms | 15.73 | 11.74 |
| poly gcd len=100 1000-bit | 7.46 ms | 6.62 ms | 1.52 ms | 4.90 | 4.34 |
| poly mul len=1000 1000-bit | 29.6 ms | 22.3 ms | 3.11 ms | 9.53 | 7.17 |
| poly gcd len=1000 1000-bit | 118 ms | 109 ms | 34.8 ms | 3.39 | 3.14 |
| poly mul len=100000 20-bit | 97.9 ms | 56.6 ms | 27.8 ms | 3.52 | 2.04 |

Passing a matrix as text costs about as much as a small computation, so from
Python the inverse lead is 2.1–3.4x (n = 30 and 100) instead of 3.8–5.9x, and
small cases fall further behind.

## The Sage layer, before and after

`sage_layer.py` timed these operations through `from sagebrush.sage
import *` under CPython. "Before" is the previous pure-Python algorithm
(Fraction Gaussian elimination, and Euclid over QQ for gcds), measured once;
`-` means it was not run because it took too long, or the operation did not
exist. "After" and Sage 10.9 are from `sagebrush bench sagelayer`, which runs
the same Python code under both (Sage's own Python for Sage, on a copy of
each matrix so that no cached result is timed), and checks that the answers
agree: one core of an AMD EPYC 7B13, Oct 18 2026
([results/bench](../../results/bench/README.md)). Sage is conda-forge's
10.9.

| operation | before | after | Sage 10.9 | after / Sage |
|---|---:|---:|---:|---:|
| det ZZ 20x20 | 6.1 ms | 0.15 ms | 0.067 ms | 2.17 |
| det ZZ 50x50 | 139.2 ms | 1.8 ms | 0.75 ms | 2.37 |
| det ZZ 100x100 | - | 8.7 ms | 4.2 ms | 2.08 |
| det QQ 10x10 | 0.80 ms | 0.089 ms | 0.009 ms | 10.25 |
| det QQ 20x20 | 6.5 ms | 0.34 ms | 0.10 ms | 3.23 |
| det QQ 40x40 | 72.9 ms | 2.0 ms | 0.51 ms | 3.96 |
| inverse QQ 20x20 | 34.4 ms | 2.0 ms | 1.6 ms | 1.30 |
| inverse QQ 40x40 | - | 13.0 ms | 13.8 ms | 0.94 |
| rref QQ 30x40 | 85.9 ms | 2.8 ms | 2.3 ms | 1.23 |
| rref QQ 60x70 | - | 14.5 ms | 12.0 ms | 1.21 |
| charpoly ZZ 30x30 | - | 0.87 ms | 1.8 ms | 0.49 |
| charpoly ZZ 60x60 | - | 7.3 ms | 18.2 ms | 0.40 |
| gcd ZZ[x] degree 148 | 10.3 s | 0.19 ms | 0.015 ms | 12.27 |
| gcd ZZ[x] degree 448 | - | 1.3 ms | 0.056 ms | 23.47 |
| gcd ZZ[x] degree 1498 | - | 3.3 ms | 1.6 ms | 2.09 |
| product ZZ[x] degree 999 | - | 1.1 ms | 0.100 ms | 10.77 |
| product ZZ[x] degree 9999 | - | 12.3 ms | 2.0 ms | 6.31 |

- **charpoly:** 2–2.5x faster than Sage.
- **rref and inverse:** within 1.3x of Sage.
- **det:** 2–10x slower than Sage.
- **Products and gcds:** 2–23x slower, mostly because of the cost of
  passing coefficients between Python and Rust.
- **gcd improvement:** large because Euclid over QQ makes the
  coefficients grow very quickly.