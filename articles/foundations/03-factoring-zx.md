<!-- description: Factoring polynomials over Z in pure Rust (Zassenhaus with Hensel lifting), identical to FLINT on hundreds of cases, so that Galois orbits of newforms can be computed in a browser, and the 350x fix a big Hecke polynomial needed. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and commit history of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Factoring in $\mathbb{Z}[x]$

*Code: `engine/poly` (crate `sagebrush-poly`). Source: von zur Gathen and
Gerhard, *Modern Computer Algebra*, chapters 14–15.*

## Why another factorizer

The newform engine splits a Hecke polynomial into irreducible factors:
those are the Galois orbits. At first it called FLINT (van Hoeij's
algorithm), which is LGPL and native only. A pure-Rust factorizer makes
the engine permissive end to end, and lets the browser compute newform
orbits, LMFDB labels and trace forms with no server.

## The algorithm (the classical one)

The contract is the same as the FLINT binding's: content times $\prod
g_i^{e_i}$, each $g_i$ irreducible, primitive, with positive leading
coefficient.

1. **Square-free decomposition** (Yun), skipped when $f$ is square-free
   modulo a prime.
2. **Factor modulo a few small primes** (distinct-degree, then
   Cantor–Zassenhaus), keeping the prime with the fewest factors. The
   factor degrees possible modulo *every* prime tried often prove
   irreducibility outright.
3. **Hensel lifting** on a factor tree, with quadratic steps, past twice
   the Mignotte bound times the leading coefficient.
4. **Zassenhaus recombination** of subsets of the lifted factors, with a
   constant-term test before each trial division.

**Validation:** identical to FLINT on 400 random products, on cyclotomic
polynomials, and on the Hecke polynomials of $T_2$ and $T_3$ at about 100
levels up to 2003.

## The 350× bug

The square-free test tried 20 primes before falling back to an exact gcd
over $\mathbb{Z}$, which takes minutes at large degree. A polynomial with
many factors can need primes beyond its degree before one keeps it
square-free. With up to 200 primes, the degree-116 Hecke polynomial at
level 3105 factors in **0.23 s instead of 80 s**, and the newspace
3105.2.a takes 49 s instead of 129 s.

FLINT does the same polynomial in 0.01 s. FLINT uses van Hoeij's
lattice-based recombination, which avoids Zassenhaus's exponential subset
search. That is the likely difference, and the next step if Hecke
polynomials with many modular factors become common.

## What would have saved time

- **Fallbacks are where the time goes.** "Try 20 primes, then do it the
  slow way" made a common case 350× slower. Size such limits from the
  degree, not from a constant.
- **Keep the reference binding as a test dependency.** Comparing with
  FLINT on every Hecke polynomial the engine produces caught the cases
  that random tests do not.
