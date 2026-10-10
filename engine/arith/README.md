# sagebrush-arith

Exact arithmetic for the Sagebrush engines: the layer FLINT provides for
Sage (nmod, nmod_poly, fmpz_poly, fmpz_mat), written clean-room in Rust from
the literature, MIT OR Apache-2.0, with no C dependencies, so it runs the
same natively and in WebAssembly.

| module | what | algorithms |
|---|---|---|
| `nmod` (in `sagebrush-bigint`, re-exported) | arithmetic modulo a word n < 2^64, primality of words, primes for multimodular work | Möller–Granlund division by invariant integers (no hardware division), Shoup multiplication by a fixed value, deterministic Miller–Rabin |
| `ntt` (in `sagebrush-bigint`, re-exported) | number-theoretic transforms; products of polynomials mod any n < 2^64 and of big integers | Harvey's lazy butterflies over three primes c·2^50 + 1 < 2^62 (Gentleman–Sande forward, Cooley–Tukey inverse, no bit reversal), Garner's CRT; one transform for primes p ≡ 1 mod 2^32 |
| `nmod_poly` | polynomials over Z/n | schoolbook products with delayed reduction or NTT; Newton division; Euclid with fused steps; half-gcd (Yap, Thull–Yap) |
| `nmod_mat` | dense matrices over Z/p | elimination with delayed block updates (u128 sums, one reduction per entry), LU; characteristic polynomial from a Krylov sequence, else Hessenberg (Cohen, Algorithm 2.2.9) |
| `zmat` | dense matrices over Z (and Q, by scaling) | Dixon p-adic lifting; determinant by Abbott–Bronstein–Mulders; multimodular inverse, rref and charpoly with proven bounds |
| `zpoly` | polynomials over Z | NTT, multimodular or Kronecker products; heuristic gcd (Char–Geddes–Gonnet), modular gcd (Brown); exact division modulo primes |
| `crt` | Chinese remaindering of many values | the explicit CRT formula with a floating-point quotient, in 64-bit limbs |

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
- **Inverse:** primes until their product exceeds twice the Hadamard bound,
  which bounds det A and every entry of the adjugate.
- **Reduced row echelon form:**
  - modulo each prime, d = det A[S, P] for a fixed nonsingular pivot minor
    gives N = d R; the CRT reconstructs N, whose entries are minors.
  - The identity A d = A[:, P] N holds modulo every prime used, and its
    entries are bounded. Primes whose product exceeds twice that bound
    prove it over Z.
  - The row spaces are then equal, so R = N/d is the rref, with no product
    of big matrices needed.
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

`cargo run --release -p sagebrush-oracle --example matbench` (and
`polybench`, `nttbench`) time each operation against FLINT on the same
inputs and check that the answers agree. See
[bench/linalg](../../bench/linalg/README.md) for the tables and for the Sage
layer's timings before and after.

Roughly:
- **Matrices:**
  - inverses are 4–6x faster than FLINT and rref 1.4–3x faster;
  - charpoly is within 1.1–1.5x;
  - det and solve are within 1.1–2.3x.
- **Polynomial products:**
  - small coefficients: 1–2x;
  - large coefficients: 3.6–5x (multimodular over primes p ≡ 1 mod 2^32).
- **Polynomial gcds:** 2.5–5x.
- **Huge integer products:** the NTT beats dashu's by 1.4–1.9x from 256K
  bits, and `sagebrush-bigint` uses it.

## Next

- Gcds: tune the half-gcd's matrix products, and use the heuristic gcd at
  larger sizes.
- SIMD (AVX2 / WebAssembly SIMD) kernels for elimination and transforms
  modulo p.
- A faster det (Dixon with fewer reconstruction attempts).
- Resultants and minimal polynomials.
- Sparse matrices.
