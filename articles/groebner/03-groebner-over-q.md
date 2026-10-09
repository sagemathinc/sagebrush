# Gröbner bases over the rationals

*Code: `engine/mpoly/src/f4q.rs`, `f4.rs` (`groebner_q`). Papers: Arnold,
"Modular algorithms for computing Gröbner bases", JSC 2003; Idrees,
Pfister and Steidel 2011; Parisse 2013 (Giac); the f4ncgb paper (2025)
for multimodular echelon forms. Oracle: Magma 2.18's verbose output.*

## Version 1: one F4 per prime

The textbook modular method (Arnold):

1. Compute the reduced basis modulo many primes.
2. Keep the primes whose bases have the most common leading monomials
   (unlucky primes give different ones).
3. Combine the coefficients by CRT and rational reconstruction until
   another prime confirms them.
4. Check the result over $\mathbb{Q}$ (article 4).

It works. It has two inefficiencies:

- **Every prime runs the whole F4**, including the early steps that need
  only a few primes' worth of precision.
- **The final check is most of the time.** On katsura-8, 20 primes at
  0.085 s each took 1.7 s, and the exact check took 7.4 s.

Magma 2.18 did katsura-8 over $\mathbb{Q}$ in 0.37 s, against our 9.6 s.

## What Magma's verbose output showed

`SetVerbose("Groebner", 1)` prints, for each F4 step over $\mathbb{Q}$,
lines like:

```
Matrix kind: Integral
0:  ... RR: 0.000, fail at 0:7
1:  ... CRT
2:  ... CRT, RR
Modulus: 400 bits [121 digits], n/d: 214/216, bmax: 223
```

So Magma runs **one F4 over $\mathbb{Q}$**. Each matrix is echelonized
modulo a few primes, and the new rows are recovered by CRT and rational
reconstruction, adding primes until reconstruction succeeds with some
margin: 528 bits of numerator and denominator in a 588-bit modulus is
about two primes to spare. Early steps need 71–165 bits, later ones 600.
There is no final pass.

It also prints `Recurse with homogenization` for inhomogeneous input
over $\mathbb{Q}$ (its handbook: `Homogenize` defaults to true over the
rationals). That detail turned out to matter as much as the main idea.

## Version 2: one F4 run over $\mathbb{Q}$ (`f4q.rs`)

- **Symbolic layer.** Pairs, Gebauer–Möller and preprocessing are F4's own
  code, refactored out of `f4.rs` as `select` and `preprocess`. They run on
  the leading monomials over $\mathbb{Q}$. The basis elements are
  primitive integer polynomials.
- **Residues are cached.** Each element keeps its monic residue modulo
  each prime used so far. The same prime sequence serves every step, so
  the residues are reused. A prime dividing a leading coefficient is
  marked bad for good.
- **Each matrix is solved modulo primes.**
  - The first two primes eliminate the whole matrix. The better image
    wins: more new rows, else lexicographically smaller leading columns.
  - **Tracer**: later primes reduce only the rows that became pivots modulo
    the best prime. Most rows reduce to zero, so later primes cost a small
    fraction of a full elimination.
- **Reconstruction**, row by row:
  - Each entry is CRT-lifted by Garner. A row is put over a common
    denominator as it goes: multiply the next entry by the denominator so
    far; if the result is small, the entry is known without rational
    reconstruction.
  - Acceptance requires bits(numerator) + bits(denominator) + 60 ≤
    bits(modulus): two primes to spare.
  - A "hard entry" (the last one that failed) is tried first, so an
    attempt that will fail fails cheaply.
  - Rows found earlier are only checked against new primes, not rebuilt.
    Without this cache, the final interreduction spent 0.56 s
    reconstructing; with it, 0.07 s.
- **Homogenize** inhomogeneous degrevlex input, then dehomogenize. The
  homogenized run's basis is only made minimal, not fully reduced:
  reducing it is wasted work, since the dehomogenized basis gets reduced
  anyway.
- **Witness prime.** If the first prime agreed in every step, its images
  were a complete F4 run modulo that prime. This is what Arnold's theorem
  needs (article 4).

Results, one thread, without the final check (Magma in brackets):

| ideal | before | after |
|---|---|---|
| katsura-8 | 9.6 s | 0.55 s (0.37) |
| katsura-9 | | 3.9 s (2.4) |
| cyclic-7 | 7.5 s | 0.80 s (0.57) |

## The homogenization story

Without homogenization, cyclic-7 took 2.5 s, and one step dominated:
degree 13 needed **97 primes** for coefficients of 1490 bits. The steps
before and after it needed under 300 bits. Sugar selection on
inhomogeneous input produced a short-lived coefficient swell that the
final basis does not have.

With homogenization, the same step needed 141 bits, and the whole run
took 0.79 s. Katsura got slightly slower (0.49 s to 0.55 s), but the
worst case improved 3×. Magma had made the same choice.

## Engineering that mattered

- **Garner is $O(k^2)$ per value.** That is fine for 20 primes and
  terrible for 2000, which lex bases need (article 5). From 64 primes a
  product tree takes over, at $O(M(k)\log k)$ per value. Katsura-7's lex
  reconstruction went from 37 s to 3.6 s.
- **Reconstruction runs in parallel over rows.** Rows are independent, and
  this made the proof certificate 50× faster in its reconstruction phase.
- **`to_u64_digits` allocates three times.** The bigint facade went
  through bytes. Residues of bigints became a hot path, so `rem_u64` was
  added, which reads words in place.
- **Proof is a flag, not a fork.** `groebner_q_opt(fs, order, proof)`
  takes Sage's `proof.polynomial()`. The engine op is spelled
  `"degrevlex/noproof"`.

## What would have saved time

- **Run the strongest oracle in verbose mode on day one.** Twenty minutes
  of reading Magma's per-step moduli would have replaced the whole
  "one F4 per prime" phase.
- **Log the bits needed per step.** The `f4q: deg … primes … max bits`
  line made the cyclic-7 swell obvious immediately.
- **Expect the reconstruction to be as costly as the elimination.** Plan
  the caching, the hard entry and parallelism up front.
