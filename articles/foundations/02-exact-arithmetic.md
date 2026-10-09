<!-- description: A clean-room, MIT-licensed counterpart of FLINT's core layers in Rust: word arithmetic, NTTs, matrices and polynomials over Z/p, Z and Q, every answer certified, within 1-5x of FLINT and sometimes faster. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history and notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# An exact arithmetic layer

*Code: `engine/arith` (crate `sagebrush-arith`). Sources: Möller and
Granlund (division by invariant integers); Shoup's multiplication; Harvey's
NTTs; Dixon's $p$-adic solving; Abbott, Bronstein and Mulders' determinant;
standard multimodular algorithms. FLINT 3.6 was used only as a test oracle
and benchmark, through a separate LGPL test-only crate.*

## What FLINT does for Sage, and what Sagebrush needed

Sage computes determinants, ranks, echelon forms, inverses, characteristic
polynomials, kernels, polynomial products and gcds through FLINT. The goal
was a layer that:

- does the same jobs;
- is MIT/Apache;
- runs in WebAssembly;
- **certifies every answer**, either exactly or by a proven bound.

## The modules

- **`nmod`: arithmetic modulo a word.** Möller–Granlund reduction, Shoup
  multiplication, deterministic primality, and cached prime sequences
  (including $p \equiv 1 \bmod 2^{32}$, for single-transform products).
- **`ntt`.** Harvey-style transforms over three primes $c \cdot 2^{50}+1$,
  for polynomials modulo any $n < 2^{64}$ and for big integers.
- **`nmod_poly`.** NTT products, Newton division, Euclid with fused steps,
  half-gcd, powmod.
- **`nmod_mat`.** rref, rank, det, inverse, solve, nullspace, products,
  and the characteristic polynomial.
- **`zmat`.**
  - Dixon solve and inverse;
  - Abbott–Bronstein–Mulders determinant;
  - certified rref, rank and kernel;
  - multimodular characteristic polynomial with a proven bound.
- **`zpoly`.** NTT/Kronecker products, heuristic then modular gcd, exact
  division.

## Certified multimodular algorithms

Most algorithms over $\mathbb{Z}$ here compute modulo primes and combine.
The certificate is what makes the result exact. One example:

**rref over $\mathbb{Z}$.**

1. Compute $N = \det(A[S, P])\, R$ by CRT, where $R$ is the echelon form,
   $P$ its pivot columns and $S$ a set of rows.
2. Check the identity $A\, d = A[:, P]\, N$ modulo primes whose product
   exceeds a bound on its entries.

An identity that holds modulo a large enough $M$, with both sides bounded,
holds over $\mathbb{Z}$. The same argument later certified Gröbner bases
(see the Gröbner series, article 4).

## Closing the gaps with FLINT

The first version agreed with FLINT 3.6 everywhere and was within
1.1–5× of it for matrices and 1–5× for polynomials. What closed most of
the remaining gaps:

- **Delayed block updates** in elimination modulo $p$: 16 pivots pending,
  `u128` sums, one reduction per entry. Row-by-row updates were 3–4×
  slower once the matrix left L1. det, rref and inverse modulo $p$ got
  3.5–4× faster.
- **Characteristic polynomials from a Krylov sequence**, with Hessenberg
  as the fallback: 3.7× faster.
- **Multimodular inverse with a Hadamard bound**, instead of Dixon with $n$
  right-hand sides: now 4–6× *faster* than FLINT.
- **Multimodular rref**, certified as above: 1.4–3× faster than FLINT.
- **An explicit CRT** with a floating-point quotient in 64-bit limbs,
  residues as dot products with $2^{64 i} \bmod p$. Every multimodular
  reconstruction uses it.
- **$\mathbb{Z}[x]$ products with large coefficients**, multimodular over
  $p \equiv 1 \bmod 2^{32}$ with one NTT each: from 8–12× of FLINT to
  3.6–5×.

## In the Sage layer

Through the engine's JSON dispatcher (with a compact "csv" wire format),
the Sage layer's matrices and polynomials use this layer:

- det, rank, rref and inverse became 15–66× faster than the earlier
  pure-Python code, and the characteristic polynomial 2× faster than
  Sage's;
- a degree-148 gcd in $\mathbb{Z}[x]$ went from 10.5 s to 0.4 ms.

## What would have saved time

- **The performance lessons are about dependencies between instructions,
  not counts.**
  - A row operation whose multiplier depends on the previous row serializes
    the pipeline, so fuse the Euclid steps.
  - `Modulus::inv` must divide in `u64`; `i128` division is slow.
- **Choose the certificate before the algorithm.** "Compute modulo primes,
  then prove an identity with a bound" covers rref, inverse, charpoly and,
  later, Gröbner bases. Designing for it from the start keeps every
  result exact.
- **A test-only binding to the reference library** (FLINT here, LGPL,
  never linked into the product) gives a correctness oracle for every
  function, and benchmarks for free.
