# Exact linear algebra and polynomial arithmetic

Benchmarks of `engine/arith` (see [its README](../../engine/arith/README.md))
against FLINT 3.6, and of the Sage layer before and after it. Every timing
also checks that the answers agree. One core of an AMD EPYC 7B13;
`OPENBLAS_NUM_THREADS=1` for FLINT. The two Rust-level tables below are
from Oct 18 2026, FLINT 3.6.0, on an otherwise idle machine
([results/bench/2026-10-18-rust-flint.txt](../../results/bench/2026-10-18-rust-flint.txt)).
Only FLINT's call is timed: its results are converted to BigInt (which
Sagebrush's already are) after the timing.
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
| det | 10 | 7 | 0.010 ms | 0.003 ms | 3.96 |
| solve | 10 | 7 | 0.030 ms | 0.005 ms | 5.52 |
| inverse | 10 | 7 | 0.035 ms | 0.026 ms | 1.38 |
| charpoly | 10 | 7 | 0.020 ms | 0.014 ms | 1.42 |
| rref | 10 | 7 | 0.030 ms | 0.005 ms | 6.24 |
| det | 10 | 41 | 0.026 ms | 0.016 ms | 1.60 |
| solve | 10 | 41 | 0.180 ms | 0.024 ms | 7.59 |
| inverse | 10 | 41 | 0.088 ms | 0.069 ms | 1.27 |
| charpoly | 10 | 41 | 0.052 ms | 0.041 ms | 1.25 |
| rref | 10 | 41 | 0.058 ms | 0.027 ms | 2.15 |
| det | 30 | 7 | 0.156 ms | 0.103 ms | 1.51 |
| solve | 30 | 7 | 0.248 ms | 0.176 ms | 1.41 |
| inverse | 30 | 7 | 0.673 ms | 2.743 ms | 0.25 |
| charpoly | 30 | 7 | 0.435 ms | 0.273 ms | 1.59 |
| rref | 30 | 7 | 0.352 ms | 0.446 ms | 0.79 |
| det | 30 | 41 | 0.555 ms | 0.508 ms | 1.09 |
| solve | 30 | 41 | 1.346 ms | 0.800 ms | 1.68 |
| inverse | 30 | 41 | 2.920 ms | 14.114 ms | 0.21 |
| charpoly | 30 | 41 | 1.725 ms | 1.448 ms | 1.19 |
| rref | 30 | 41 | 0.949 ms | 1.246 ms | 0.76 |
| det | 100 | 7 | 6.112 ms | 3.601 ms | 1.70 |
| solve | 100 | 7 | 4.265 ms | 3.414 ms | 1.25 |
| inverse | 100 | 7 | 44.166 ms | 156.554 ms | 0.28 |
| charpoly | 100 | 7 | 36.403 ms | 24.615 ms | 1.48 |
| rref | 100 | 7 | 16.607 ms | 23.479 ms | 0.71 |
| det | 100 | 41 | 22.587 ms | 9.952 ms | 2.27 |
| solve | 100 | 41 | 18.563 ms | 13.000 ms | 1.43 |
| inverse | 100 | 41 | 247.773 ms | 1340.066 ms | 0.18 |
| charpoly | 100 | 41 | 168.196 ms | 111.790 ms | 1.50 |
| rref | 100 | 41 | 54.943 ms | 165.584 ms | 0.33 |

- **Inverses:** 3.6–5.6x faster than FLINT from n = 30 (multimodular, with
  the number of primes fixed by the Hadamard bound).
- **rref:** 1.3–3x faster from n = 30.
- **charpoly:** within 1.2–1.6x. Modulo each prime it is a Krylov sequence
  plus one elimination.
- **det and solve:** 1.1–2.3x behind (Dixon lifting).
- **Small matrices (n = 10):** up to 7.6x behind, under 0.2 ms either way.

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
| mul | 10 | 10 | 0.001 ms | 0.000 ms | 7.55 |
| gcd | 10 | 10 | 0.004 ms | 0.002 ms | 2.67 |
| mul | 100 | 10 | 0.010 ms | 0.004 ms | 2.74 |
| gcd | 100 | 10 | 0.072 ms | 0.014 ms | 5.17 |
| mul | 1000 | 10 | 0.104 ms | 0.063 ms | 1.64 |
| gcd | 1000 | 10 | 1.871 ms | 0.410 ms | 4.56 |
| mul | 10000 | 10 | 2.181 ms | 1.334 ms | 1.64 |
| gcd | 10000 | 10 | 136.660 ms | 30.948 ms | 4.42 |
| mul | 100 | 1000 | 0.968 ms | 0.190 ms | 5.09 |
| gcd | 100 | 1000 | 5.595 ms | 1.494 ms | 3.74 |
| mul | 1000 | 1000 | 8.940 ms | 2.474 ms | 3.61 |
| gcd | 1000 | 1000 | 98.621 ms | 32.740 ms | 3.01 |
| mul | 100000 | 20 | 22.168 ms | 23.597 ms | 0.94 |

- **Products, small coefficients:** the NTT directly, 1.6–2.7x behind
  FLINT from length 100, and level at length 100,000.
- **Products, large coefficients:** multimodular over primes p ≡ 1 mod
  2^32, one transform each, with a word-level CRT. 3.6–5.1x behind FLINT,
  whose large products use a SIMD floating-point FFT.
- **Gcds:** 2.7–5.2x behind.

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
Oct 18 2026, at c7eea749 ([results/bench](../../results/bench/README.md)).

| case | sagebrush.linalg / poly | engine (wire) | FLINT 3.6 | public / FLINT | engine / FLINT |
|---|---:|---:|---:|---:|---:|
| det n=10 7-bit | 0.038 ms | 0.021 ms | 0.003 ms | 15.21 | 8.36 |
| solve n=10 7-bit | 0.111 ms | 0.047 ms | 0.005 ms | 20.31 | 8.65 |
| inverse n=10 7-bit | 0.184 ms | 0.064 ms | 0.024 ms | 7.65 | 2.66 |
| charpoly n=10 7-bit | 0.064 ms | 0.033 ms | 0.014 ms | 4.58 | 2.33 |
| rref n=10 7-bit | 0.122 ms | 0.053 ms | 0.005 ms | 25.60 | 11.06 |
| det n=10 41-bit | 0.060 ms | 0.042 ms | 0.017 ms | 3.56 | 2.49 |
| solve n=10 41-bit | 0.288 ms | 0.193 ms | 0.025 ms | 11.60 | 7.79 |
| inverse n=10 41-bit | 0.494 ms | 0.185 ms | 0.070 ms | 7.10 | 2.66 |
| charpoly n=10 41-bit | 0.111 ms | 0.073 ms | 0.041 ms | 2.70 | 1.78 |
| rref n=10 41-bit | 0.225 ms | 0.107 ms | 0.027 ms | 8.28 | 3.96 |
| det n=30 7-bit | 0.315 ms | 0.199 ms | 0.102 ms | 3.09 | 1.94 |
| solve n=30 7-bit | 0.742 ms | 0.336 ms | 0.189 ms | 3.91 | 1.78 |
| inverse n=30 7-bit | 3.04 ms | 1.23 ms | 2.63 ms | 1.15 | 0.47 |
| charpoly n=30 7-bit | 0.733 ms | 0.507 ms | 0.279 ms | 2.63 | 1.82 |
| rref n=30 7-bit | 1.09 ms | 0.534 ms | 0.413 ms | 2.64 | 1.29 |
| det n=30 41-bit | 0.770 ms | 0.649 ms | 0.512 ms | 1.50 | 1.27 |
| solve n=30 41-bit | 2.24 ms | 1.61 ms | 0.749 ms | 2.99 | 2.15 |
| inverse n=30 41-bit | 14.0 ms | 5.66 ms | 13.9 ms | 1.01 | 0.41 |
| charpoly n=30 41-bit | 2.13 ms | 1.86 ms | 1.45 ms | 1.47 | 1.28 |
| rref n=30 41-bit | 3.02 ms | 1.52 ms | 1.26 ms | 2.39 | 1.20 |
| det n=100 7-bit | 7.66 ms | 6.46 ms | 3.81 ms | 2.01 | 1.70 |
| solve n=100 7-bit | 8.76 ms | 4.83 ms | 3.65 ms | 2.40 | 1.32 |
| inverse n=100 7-bit | 125 ms | 62.0 ms | 150 ms | 0.83 | 0.41 |
| charpoly n=100 7-bit | 39.3 ms | 37.2 ms | 24.7 ms | 1.59 | 1.51 |
| rref n=100 7-bit | 29.2 ms | 19.6 ms | 23.0 ms | 1.27 | 0.85 |
| det n=100 41-bit | 25.0 ms | 23.7 ms | 9.64 ms | 2.59 | 2.46 |
| solve n=100 41-bit | 30.7 ms | 23.2 ms | 13.2 ms | 2.32 | 1.76 |
| inverse n=100 41-bit | 861 ms | 383 ms | 1350 ms | 0.64 | 0.28 |
| charpoly n=100 41-bit | 171 ms | 168 ms | 111 ms | 1.54 | 1.51 |
| rref n=100 41-bit | 121 ms | 71.0 ms | 171 ms | 0.71 | 0.42 |
| poly mul len=10 10-bit | 0.013 ms | 0.010 ms | 0.000 ms | 92.44 | 67.30 |
| poly gcd len=10 10-bit | 0.015 ms | 0.012 ms | 0.002 ms | 9.46 | 7.77 |
| poly mul len=100 10-bit | 0.076 ms | 0.043 ms | 0.004 ms | 20.74 | 11.87 |
| poly gcd len=100 10-bit | 0.115 ms | 0.094 ms | 0.013 ms | 8.78 | 7.20 |
| poly mul len=1000 10-bit | 0.749 ms | 0.400 ms | 0.062 ms | 12.07 | 6.45 |
| poly gcd len=1000 10-bit | 2.35 ms | 2.16 ms | 0.411 ms | 5.71 | 5.27 |
| poly mul len=10000 10-bit | 8.29 ms | 5.00 ms | 1.55 ms | 5.34 | 3.22 |
| poly gcd len=10000 10-bit | 143 ms | 142 ms | 31.3 ms | 4.57 | 4.52 |
| poly mul len=100 1000-bit | 3.05 ms | 2.30 ms | 0.191 ms | 15.94 | 11.99 |
| poly gcd len=100 1000-bit | 7.36 ms | 6.52 ms | 1.51 ms | 4.87 | 4.32 |
| poly mul len=1000 1000-bit | 29.7 ms | 22.0 ms | 3.13 ms | 9.50 | 7.03 |
| poly gcd len=1000 1000-bit | 116 ms | 108 ms | 34.7 ms | 3.35 | 3.11 |
| poly mul len=100000 20-bit | 97.6 ms | 56.7 ms | 25.9 ms | 3.76 | 2.19 |

Passing a matrix as text costs about as much as a small computation, so from
Python the inverse lead is 2.1–3.6x (n = 30 and 100) instead of 3.6–5.6x, and
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