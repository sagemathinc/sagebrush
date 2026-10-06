# sagebrush-arith

Exact arithmetic for the Sagebrush engines: the layer FLINT provides for
Sage (nmod, nmod_poly, fmpz_poly, fmpz_mat), written clean-room in Rust from
the literature, MIT OR Apache-2.0, with no C dependencies, so it runs the
same natively and in WebAssembly.

| module | what | algorithms |
|---|---|---|
| `nmod` | arithmetic modulo a word n < 2^64, primality of words, primes for multimodular work | Möller–Granlund division by invariant integers (no hardware division), Shoup multiplication by a fixed value, deterministic Miller–Rabin |
| `ntt` | number-theoretic transforms; products of polynomials mod any n < 2^64 and of big integers | Harvey's lazy butterflies over three primes c·2^50 + 1 < 2^62 (Gentleman–Sande forward, Cooley–Tukey inverse, no bit reversal), Garner's CRT; one transform for primes p ≡ 1 mod 2^32 |
| `nmod_poly` | polynomials over Z/n | schoolbook products with delayed reduction or NTT; Newton division; Euclid with fused steps; half-gcd (Yap, Thull–Yap) |
| `nmod_mat` | dense matrices over Z/p | Gauss–Jordan with Shoup row operations; Hessenberg characteristic polynomial (Cohen, Algorithm 2.2.9) |
| `zmat` | dense matrices over Z (and Q, by scaling) | Dixon p-adic lifting with rational reconstruction; determinant by Abbott–Bronstein–Mulders; certified rref; multimodular charpoly with a proven bound |
| `zpoly` | polynomials over Z | NTT or Kronecker products; heuristic gcd (Char–Geddes–Gonnet), modular gcd (Brown); exact division modulo primes |

## Every answer is certified

Multimodular and p-adic algorithms are fast but easy to get subtly wrong.
Each result is either checked exactly or rests on a proven bound:

- **Solving and inverses:** `solve` returns X = N/d only after checking
  A N = d B exactly over Z.
- **Determinant:**
  - the denominator of a solve with a random right-hand side is a divisor
    d of det A;
  - det A / d is then reconstructed from enough primes to exceed twice
    the Hadamard bound divided by d.
- **Reduced row echelon form:**
  - pivots come from a reduction mod p, the candidate R = N/d from a solve;
  - it is accepted only if A d = A[:, P] N holds exactly and R has the
    echelon shape. Together these prove R is the rref, since the row
    spaces are equal.
- **Characteristic polynomial:** primes until their product exceeds twice a
  bound on every coefficient: elementary symmetric functions of the row
  (or column) norms, which bound the sums of principal minors (Hadamard).
- **Polynomial gcd:** a candidate is returned only if it divides both
  inputs exactly. With the degree argument (modular) or the ξ bound
  (heuristic), this proves it is the gcd.

Every test compares with FLINT (`sagebrush-flint`, a dev-dependency only),
with naive algorithms, or with identities (Cayley–Hamilton, det(AB) =
det A det B, remainder sequences).

## Speed against FLINT 3.6

`cargo run --release -p sagebrush-arith --example matbench` (and
`polybench`, `nttbench`) time each operation against FLINT on the same
inputs and check that the answers agree. See
[bench/linalg](../../bench/linalg/README.md) for the tables and for the Sage
layer's timings before and after.

Roughly:
- **Matrices:** within 1.1–5x of FLINT. FLINT uses BLAS-backed products and
  more tuned elimination.
- **Polynomial products:** 1–2x for small coefficients; Kronecker
  substitution is 7–9x slower for 1000-bit coefficients (multimodular
  products are next).
- **Polynomial gcds:** 2–5x behind FLINT.
- **Huge integer products:** the NTT beats dashu's from 256K bits
  (1.5–1.8x), still about 2x behind GMP.

## Next

- A multimodular inverse for many right-hand sides.
- Faster mod-p elimination: delayed reduction and blocking.
- Strassen-style products.
- Multimodular products for polynomials with large coefficients.
- Using `ntt::mul_words` for huge products in `sagebrush-bigint`, which
  would speed up the half-gcd.
- Resultants and minimal polynomials.
- Sparse matrices.
