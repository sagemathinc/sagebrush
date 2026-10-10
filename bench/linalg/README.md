# Exact linear algebra and polynomial arithmetic

Benchmarks of `engine/arith` (see [its README](../../engine/arith/README.md))
against FLINT 3.6, and of the Sage layer before and after it. Every timing
also checks that the answers agree. One core of an AMD EPYC 7B13;
`OPENBLAS_NUM_THREADS=1` for FLINT.

## Matrices over Z

The inputs are random square matrices with entries of the given size. rref
is an n by n+5 matrix of rank n/2. Rerun with
`cargo run --release -p sagebrush-oracle --example matbench -- 10 30 100`.
The ratio is Sagebrush's time divided by FLINT's: below 1 means Sagebrush
is faster.

| op | n | entry bits | Sagebrush | FLINT 3.6 | ratio |
|---|---:|---:|---:|---:|---:|
| det | 10 | 7 | 0.011 ms | 0.003 ms | 3.62 |
| solve | 10 | 7 | 0.031 ms | 0.008 ms | 3.86 |
| inverse | 10 | 7 | 0.032 ms | 0.039 ms | 0.82 |
| charpoly | 10 | 7 | 0.020 ms | 0.017 ms | 1.17 |
| rref | 10 | 7 | 0.028 ms | 0.005 ms | 5.33 |
| det | 10 | 41 | 0.027 ms | 0.018 ms | 1.50 |
| solve | 10 | 41 | 0.176 ms | 0.032 ms | 5.54 |
| inverse | 10 | 41 | 0.084 ms | 0.128 ms | 0.65 |
| charpoly | 10 | 41 | 0.053 ms | 0.050 ms | 1.06 |
| rref | 10 | 41 | 0.057 ms | 0.029 ms | 1.96 |
| det | 30 | 7 | 0.163 ms | 0.109 ms | 1.49 |
| solve | 30 | 7 | 0.255 ms | 0.200 ms | 1.27 |
| inverse | 30 | 7 | 0.693 ms | 3.246 ms | 0.21 |
| charpoly | 30 | 7 | 0.449 ms | 0.310 ms | 1.45 |
| rref | 30 | 7 | 0.358 ms | 0.476 ms | 0.75 |
| det | 30 | 41 | 0.580 ms | 0.540 ms | 1.07 |
| solve | 30 | 41 | 1.371 ms | 0.920 ms | 1.49 |
| inverse | 30 | 41 | 2.903 ms | 16.405 ms | 0.18 |
| charpoly | 30 | 41 | 1.788 ms | 1.593 ms | 1.12 |
| rref | 30 | 41 | 0.948 ms | 1.319 ms | 0.72 |
| det | 100 | 7 | 6.113 ms | 3.835 ms | 1.59 |
| solve | 100 | 7 | 4.323 ms | 3.774 ms | 1.15 |
| inverse | 100 | 7 | 45.680 ms | 183.025 ms | 0.25 |
| charpoly | 100 | 7 | 38.713 ms | 26.310 ms | 1.47 |
| rref | 100 | 7 | 17.207 ms | 25.936 ms | 0.66 |
| det | 100 | 41 | 23.451 ms | 10.185 ms | 2.30 |
| solve | 100 | 41 | 19.458 ms | 14.757 ms | 1.32 |
| inverse | 100 | 41 | 248.490 ms | 1570.097 ms | 0.16 |
| charpoly | 100 | 41 | 176.180 ms | 119.466 ms | 1.47 |
| rref | 100 | 41 | 56.915 ms | 173.521 ms | 0.33 |

- **Inverses:** 4–6x faster than FLINT (multimodular, with the number of
  primes fixed by the Hadamard bound).
- **rref:** 1.4–3x faster from n = 30.
- **charpoly:** within 1.1–1.5x. Modulo each prime it is a Krylov sequence
  plus one elimination.
- **det and solve:** 1.1–2.3x behind (Dixon lifting).
- **Small matrices (n = 10):** a few times behind, under 0.2 ms either way.

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
| mul | 10 | 10 | 0.001 ms | 0.000 ms | 7.82 |
| gcd | 10 | 10 | 0.004 ms | 0.002 ms | 2.50 |
| mul | 100 | 10 | 0.011 ms | 0.004 ms | 2.66 |
| gcd | 100 | 10 | 0.074 ms | 0.015 ms | 5.01 |
| mul | 1000 | 10 | 0.112 ms | 0.068 ms | 1.66 |
| gcd | 1000 | 10 | 1.978 ms | 0.446 ms | 4.44 |
| mul | 10000 | 10 | 2.380 ms | 1.422 ms | 1.67 |
| gcd | 10000 | 10 | 147.837 ms | 32.891 ms | 4.49 |
| mul | 100 | 1000 | 0.999 ms | 0.202 ms | 4.94 |
| gcd | 100 | 1000 | 5.888 ms | 1.602 ms | 3.68 |
| mul | 1000 | 1000 | 9.520 ms | 2.647 ms | 3.60 |
| gcd | 1000 | 1000 | 105.446 ms | 35.133 ms | 3.00 |
| mul | 100000 | 20 | 24.337 ms | 25.002 ms | 0.97 |

- **Products, small coefficients:** the NTT directly, 1–2x behind FLINT
  and level at length 100,000.
- **Products, large coefficients:** multimodular over primes p ≡ 1 mod
  2^32, one transform each, with a word-level CRT. 3.6–5x behind FLINT,
  whose large products use a SIMD floating-point FFT.
- **Gcds:** 2.5–5x behind.

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

## The Sage layer, before and after

`sage_layer.py` times the same operations through `from sagebrush.sage
import *` under CPython. "Before" is the previous pure-Python algorithm:
Fraction Gaussian elimination, and Euclid over QQ for gcds. `-` means it
was not run because it took too long, or the operation did not exist.
`sage_layer.sage` runs the same cases in Sage 10.

| operation | before | after | Sage 10 |
|---|---:|---:|---:|
| det ZZ 20x20 | 6.1 ms | 0.30 ms | 0.40 ms |
| det ZZ 50x50 | 139.2 ms | 2.1 ms | 0.90 ms |
| det ZZ 100x100 | - | 9.8 ms | 4.6 ms |
| det QQ 10x10 | 0.80 ms | 0.20 ms | < 0.1 ms |
| det QQ 20x20 | 6.5 ms | 0.50 ms | 0.20 ms |
| det QQ 40x40 | 72.9 ms | 2.3 ms | 0.60 ms |
| inverse QQ 20x20 | 34.4 ms | 2.2 ms | 1.9 ms |
| inverse QQ 40x40 | - | 14.4 ms | 15.6 ms |
| rref QQ 30x40 | 85.9 ms | 3.2 ms | 2.3 ms |
| rref QQ 60x70 | - | 15.4 ms | 12.5 ms |
| charpoly ZZ 30x30 | - | 1.0 ms | 3.2 ms |
| charpoly ZZ 60x60 | - | 7.6 ms | 17.3 ms |
| gcd ZZ[x] degree 148 | 10.3 s | 0.50 ms | 0.10 ms |
| gcd ZZ[x] degree 448 | - | 1.6 ms | 0.10 ms |
| gcd ZZ[x] degree 1498 | - | 3.9 ms | 2.0 ms |
| product ZZ[x] degree 999 | - | 1.2 ms | 0.10 ms |
| product ZZ[x] degree 9999 | - | 14.6 ms | 2.2 ms |

- **rref, inverse and charpoly:** level with Sage, or faster.
- **Products and the smallest gcds:** behind, mostly because of the cost of
  passing coefficients between Python and Rust.
- **gcd improvement:** large because Euclid over QQ makes the
  coefficients grow very quickly.
