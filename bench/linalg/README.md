# Exact linear algebra and polynomial arithmetic

Benchmarks of `engine/arith` (see [its README](../../engine/arith/README.md))
against FLINT 3.6, and of the Sage layer before and after it. Every timing
also checks that the answers agree. One core of an AMD EPYC 7B13;
`OPENBLAS_NUM_THREADS=1` for FLINT.

## Matrices over Z

The inputs are random square matrices with entries of the given size. rref
is an n by n+5 matrix of rank n/2. Rerun with
`cargo run --release -p sagebrush-arith --example matbench -- 10 30 100`.

| op | n | entry bits | Sagebrush | FLINT 3.6 | ratio |
|---|---:|---:|---:|---:|---:|
| det | 10 | 7 | 0.010 ms | 0.003 ms | 3.26 |
| solve | 10 | 7 | 0.033 ms | 0.008 ms | 3.95 |
| inverse | 10 | 7 | 0.164 ms | 0.039 ms | 4.17 |
| charpoly | 10 | 7 | 0.017 ms | 0.017 ms | 1.01 |
| rref | 10 | 7 | 0.048 ms | 0.005 ms | 8.78 |
| det | 10 | 41 | 0.152 ms | 0.018 ms | 8.46 |
| solve | 10 | 41 | 0.166 ms | 0.032 ms | 5.14 |
| inverse | 10 | 41 | 0.671 ms | 0.131 ms | 5.14 |
| charpoly | 10 | 41 | 0.057 ms | 0.050 ms | 1.14 |
| rref | 10 | 41 | 0.269 ms | 0.030 ms | 8.90 |
| det | 30 | 7 | 0.533 ms | 0.110 ms | 4.84 |
| solve | 30 | 7 | 0.427 ms | 0.201 ms | 2.12 |
| inverse | 30 | 7 | 4.681 ms | 3.282 ms | 1.43 |
| charpoly | 30 | 7 | 1.294 ms | 0.303 ms | 4.27 |
| rref | 30 | 7 | 1.461 ms | 0.469 ms | 3.11 |
| det | 30 | 41 | 1.623 ms | 0.545 ms | 2.98 |
| solve | 30 | 41 | 1.685 ms | 0.955 ms | 1.76 |
| inverse | 30 | 41 | 23.240 ms | 17.567 ms | 1.32 |
| charpoly | 30 | 41 | 5.608 ms | 1.599 ms | 3.51 |
| rref | 30 | 41 | 5.487 ms | 1.329 ms | 4.13 |
| det | 100 | 7 | 16.917 ms | 3.892 ms | 4.35 |
| solve | 100 | 7 | 11.648 ms | 3.878 ms | 3.00 |
| inverse | 100 | 7 | 338.174 ms | 222.965 ms | 1.52 |
| charpoly | 100 | 7 | 134.181 ms | 26.399 ms | 5.08 |
| rref | 100 | 7 | 82.546 ms | 25.766 ms | 3.20 |
| det | 100 | 41 | 37.392 ms | 10.218 ms | 3.66 |
| solve | 100 | 41 | 30.997 ms | 15.067 ms | 2.06 |
| inverse | 100 | 41 | 1928.333 ms | 1632.520 ms | 1.18 |
| charpoly | 100 | 41 | 618.027 ms | 119.327 ms | 5.18 |
| rref | 100 | 41 | 328.049 ms | 185.335 ms | 1.77 |

The ratio is Sagebrush's time divided by FLINT's, so higher means Sagebrush
is slower.

- **Inverses and solving:** about 1.2–2x behind FLINT, at sizes where the
  p-adic lifting dominates.
- **Determinants:** 3–5x behind.
- **Small rrefs:** further behind (up to 9x at n = 10), where FLINT's
  fraction-free elimination needs no solve or check.
- **Charpoly:** about 4–5x behind at n ≥ 30.
- **Where FLINT gains:** blocked and BLAS-backed elimination modulo
  primes, and smaller primes. Those are the next things to tune.

## Polynomials over Z

The gcd inputs are g·a and g·b, with g of half the length. Rerun with
`cargo run --release -p sagebrush-arith --example polybench`.

| op | length | coefficient bits | Sagebrush | FLINT 3.6 | ratio |
|---|---:|---:|---:|---:|---:|
| mul | 10 | 10 | 0.001 ms | 0.000 ms | 8.51 |
| gcd | 10 | 10 | 0.004 ms | 0.002 ms | 2.47 |
| mul | 100 | 10 | 0.011 ms | 0.004 ms | 2.64 |
| gcd | 100 | 10 | 0.073 ms | 0.015 ms | 4.89 |
| mul | 1000 | 10 | 0.111 ms | 0.068 ms | 1.63 |
| gcd | 1000 | 10 | 1.979 ms | 0.453 ms | 4.37 |
| mul | 10000 | 10 | 2.389 ms | 1.460 ms | 1.64 |
| gcd | 10000 | 10 | 149.416 ms | 33.600 ms | 4.45 |
| mul | 100 | 1000 | 1.413 ms | 0.206 ms | 6.85 |
| gcd | 100 | 1000 | 5.869 ms | 1.653 ms | 3.55 |
| mul | 1000 | 1000 | 24.124 ms | 2.699 ms | 8.94 |
| gcd | 1000 | 1000 | 122.583 ms | 36.268 ms | 3.38 |
| mul | 100000 | 20 | 24.736 ms | 27.437 ms | 0.90 |

Products of polynomials with small coefficients use the NTT directly and
are within 1–2x of FLINT; at length 100,000 they are even. Large
coefficients go through Kronecker substitution and dashu's multiplication,
7–9x slower than FLINT's multimodular products. Gcds are 2.5–5x slower.

## Huge integers: our NTT against dashu's multiplication

`cargo run --release -p sagebrush-arith --example nttbench`

| bits | Sagebrush NTT | dashu | dashu / NTT |
|---:|---:|---:|---:|
| 65,536 | 0.318 ms | 0.241 ms | 0.76 |
| 131,072 | 0.716 ms | 0.670 ms | 0.93 |
| 262,144 | 1.592 ms | 2.256 ms | 1.42 |
| 524,288 | 3.400 ms | 4.846 ms | 1.43 |
| 1,048,576 | 7.168 ms | 10.675 ms | 1.49 |
| 2,097,152 | 15.056 ms | 23.599 ms | 1.57 |
| 4,194,304 | 32.101 ms | 58.544 ms | 1.82 |
| 8,388,608 | 68.315 ms | 127.195 ms | 1.86 |

From 256K bits the 3-prime NTT is 1.4–1.9x faster than dashu's (GMP is
another ~2x faster). The bigint layer does not use it yet.

## The Sage layer, before and after

`sage_layer.py` times the same operations through `from sagebrush.sage
import *` under CPython. "Before" is the previous pure-Python algorithm:
Fraction Gaussian elimination, and Euclid over QQ for gcds. `-` means it
was not run because it took too long, or the operation did not exist.
`sage_layer.sage` runs the same cases in Sage 10 for comparison.

| operation | before | after | Sage |
|---|---:|---:|---:|
| det ZZ 20x20 | 5.9 ms | 0.4 ms | 0.5 ms |
| det ZZ 50x50 | 138 ms | 3.3 ms | 1.0 ms |
| det ZZ 100x100 | - | 20 ms | 5.0 ms |
| det QQ 40x40 | 267 ms | 7.3 ms | 0.6 ms |
| inverse QQ 20x20 | 94 ms | 12 ms | 2.2 ms |
| inverse QQ 40x40 | - | 132 ms | 17 ms |
| rref QQ 30x40 | 86 ms | 9.8 ms | 2.4 ms |
| rref QQ 60x70 | - | 66 ms | 13 ms |
| charpoly ZZ 30x30 | - | 2.1 ms | 3.6 ms |
| charpoly ZZ 60x60 | - | 23 ms | 18 ms |
| gcd ZZ[x] degree 148 | 10.5 s | 0.4 ms | 0.1 ms |
| gcd ZZ[x] degree 1498 | - | 4.0 ms | 2.0 ms |
| product ZZ[x] degree 9999 | - | 15 ms | 2.3 ms |

The gcd improvement is large because Euclid over QQ makes the coefficients
grow very quickly. The remaining distance to Sage on products is mostly
the cost of passing coefficients between Python and Rust.
