# Big integers: GMP, malachite, dashu, num-bigint

Sagebrush's engines use `num-bigint` today. This benchmark measures how the
pure-Rust alternatives compare with GMP, natively and in WebAssembly, on the
operations research math leans on. GMP (through `rug`) and malachite are
LGPL: they are yardsticks here, never dependencies. Every result is checked
against the reference library (zero mismatches in both runs below).

```sh
GMP_MPFR_SYS_USE_SYSTEM_LIBS=1 cargo run --release -- --max-bits 4194304 > results/native.csv
cargo build --release --target wasm32-wasip1 --no-default-features && node run.mjs --max-bits 4194304 > results/wasm.csv
python3 summarize.py results/native.csv results/wasm.csv > results/tables.md
```

Operations, on random n-bit inputs: `mul` (n by n), `sqr`, `divrem` (2n by
n), `gcd`, `powmod` (n-bit base, exponent and odd modulus, n up to 8192),
`to_dec` and `from_dec` (decimal conversion). One core of an AMD EPYC 7B13,
Rust 1.99, Node 26 (V8) for WebAssembly, October 2026. Full tables:
[results/tables.md](results/tables.md).

## Native: time relative to GMP (lower is better)

| operation | bits | malachite 0.12 | dashu 0.6 | num-bigint 0.5 |
|---|---:|---:|---:|---:|
| mul | 1,024 | 1.5 | 1.3 | 1.7 |
| mul | 65,536 | 20 | 2.2 | 2.5 |
| mul | 4,194,304 | 12 | 3.4 | 8.1 |
| divrem | 1,024 | 1.4 | 1.9 | 1.7 |
| divrem | 1,048,576 | 18 | 3.9 | 4.6 |
| gcd | 64 | 0.8 | 0.9 | **15** |
| gcd | 4,096 | 0.8 | 1.1 | **6.9** |
| gcd | 1,048,576 | 8.1 | 3.9 | **65** |
| powmod | 2,048 | 1.7 | 1.9 | 1.8 |
| to_dec | 1,048,576 | 7.5 | 3.0 | 3.2 |
| from_dec | 4,194,304 | 10 | 3.5 | **38** |

`num-bigint` 0.5 is the same speed as 0.4.

## WebAssembly

Every library runs **2.5 to 4 times slower** in WebAssembly than natively
(32-bit limbs, no 64 x 64 -> 128-bit multiply). The best permissive library
in the browser is 3 to 13 times slower than native GMP, depending on the
operation and size.

## What this says

1. **`num-bigint`'s gcd is the weak spot**: 5 to 65 times slower than GMP and
   quadratic with a large constant; decimal input is quadratic too (38 times
   GMP at 4 million bits). Multiplication and division are within 2 to 8
   times of GMP.
2. **dashu is the strongest permissive library**: 1.3 to 3.5 times GMP for
   multiplication at every size, gcd at GMP's speed up to 64K bits, and
   competitive conversions. Its remaining gap is asymptotic: no subquadratic
   gcd (4 to 10 times GMP beyond a million bits) and a 4 to 5 times gap in
   division there.
3. **malachite** (LGPL, excluded anyway) matches or beats GMP below 32K bits
   but has a performance cliff at 64K bits, where it becomes 10 to 20 times
   slower than GMP.
4. Our engine's ~30-fold WebAssembly slowdown on ECM is not explained by the
   big-integer library, since these libraries lose only 2.5 to 4 times. The
   likely cause, to be measured, is our own word-level arithmetic: Montgomery
   multiplication with 64 x 64 -> 128-bit products, which wasm32 emulates.
