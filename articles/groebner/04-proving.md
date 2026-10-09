<!-- description: Proving a Gröbner basis over Q: Arnold's theorem, Sage's proof flags, why reductions over Z and quotient certificates lost, and a certificate from normal forms modulo primes. -->
# Proving a Gröbner basis over the rationals

*Code: `engine/mpoly/src/certify.rs`, `f4.rs` (`verify_q`), `f4q.rs`
(`check`), `lib/_sage_lang.py` (`proof`). Papers: Arnold 2003 (Thm 7.1);
Parisse 2013; Storjohann's thesis via f4ncgb (2025) for the criterion of
a multimodular echelon form.*

## What has to be proven

A basis reconstructed from modular images is correct with overwhelming
probability, but not provably. Arnold's Theorem 7.1 says what suffices.
Let $\tilde G \subset \mathbb{Q}[x]$ be the candidate and $I$ the ideal of
the generators $F$. If

1. $\tilde G$ is a Gröbner basis of the ideal it generates,
2. $F \subseteq \langle \tilde G \rangle$, and
3. the leading monomials of $\tilde G$ are those of a Gröbner basis of
   $\langle F \bmod p \rangle$ for some prime $p$,

then $\langle\tilde G\rangle = I$ and $\tilde G$ is its reduced basis.
Condition 3 is what removes the need to show $\tilde G \subseteq I$. It
works because Hilbert functions can only go up modulo $p$.

- **Condition 3 is free** when the first prime took part in every step of
  the F4 run over $\mathbb{Q}$ (article 3). Otherwise one F4 modulo a
  fresh prime provides it.
- **Condition 2** is a handful of reductions.
- **Condition 1 is the cost.** It means every S-pair left by the
  Gebauer–Möller criteria reduces to zero over $\mathbb{Q}$: 877 pairs
  for katsura-8.

## Whose semantics: Sage's proof flags

Sage has global proof flags (`proof.all()`, `proof.polynomial()`,
`proof.WithProof('polynomial', False)`). Sage's own Gröbner bases over
$\mathbb{Q}$ come from Singular's exact `std`, so they are proven.
Sagebrush now has the same flags, checked against Sage 10.10:

- with `proof.polynomial()` true (the default), the check runs;
- with it false, it is skipped, as Magma appears to do.

Magma's handbook does not say whether its rational results are proven.

## Attempt 1: reduce over $\mathbb{Z}$ (the baseline)

Each S-polynomial is reduced fraction-free: scale the remainder by
$\mathrm{lc}(g)/\gcd(c, \mathrm{lc}(g))$ and remove the content now and
then. On katsura-8 this took 7.4 s for 877 pairs, each about 560 steps
of about 180 terms.

**Where the time went (measured, not guessed).** Coefficients stayed
moderate: 263 bits on average, 438 at most. The scaling factor was 1 in
93% of steps. So neither coefficient growth nor scaling dominated. It
was **the number of term operations**: about 90 million
multiply-subtracts at about 70 ns each.

## Two things that did not work

- **A dense accumulator instead of an ordered map.** F4's preprocessing
  gives the columns once, so each S-polynomial can be reduced in a dense
  vector with no `BTreeMap`. Result: 7.4 s became 6.3 s. The map was not
  the problem.
- **Fixed-width limbs instead of bigints.** Each entry became $w$ 64-bit
  limbs in two's complement, with schoolbook products into a scratch
  buffer and no allocation per operation. Result: **slower**, 11 s.
  - Content removal needs exact gcds, so entries had to be converted back
    to bigints every few steps.
  - Rescanning to bound the sizes cost as much as the arithmetic.
  - The arithmetic itself, about 15–35 limb products per term, is what it
    is.

  Lesson: when 90M operations are needed, make fewer operations, not
  cheaper ones.

## Attempt 2: certify with quotients (rejected after measuring)

Parisse's "modular certification" reconstructs the quotients $q_k$ of
$S = \sum_k q_k g_k$ from modular reductions. It then checks the identity
by a size bound, without multiplying anything out. The cost depends on
the size of the quotients, so I measured them first (Sage oracle,
katsura-7). They reach **1158 bits**, against **317** for the basis: 3.6×
as many primes as the basis needed. Giac's own benchmarks agree: modular
certification is no faster than integer certification for katsura.

## Attempt 3: certify with normal forms (what we use)

Put all S-polynomials (integer rows $T$) and their reducers (integer pivot
rows $P$, leading columns $L$) in one matrix. Let $X$ be the pivots
reduced by each other, restricted to the other columns $N$. This is
Faugère–Lachartre's $B' = A^{-1} B$, and its row for $u \in L$ is
$x^u - \mathrm{NF}(x^u)$: the normal forms of the pivot monomials. Two
identities hold:

$$\text{(i)}\quad P_k|_N = \sum_{u \in L} P_k[u]\, X_u \quad\text{for every
pivot row}, \qquad \text{(ii)}\quad T_t|_N = \sum_{u\in L} T_t[u]\, X_u
\quad\text{for every S-polynomial}.$$

- (i) pins $X$ down to $A^{-1}B$, since $A$ is triangular with nonzero
  diagonal.
- (ii) says each $T_t$ lies in the span of the pivots, so every
  S-polynomial reduces to zero.

**The certificate.** Modulo each prime, `fl_parts` computes $X \bmod p$
and reduces $T$, which must give zero. $X$ is reconstructed from the
images, as numerators $X'_u$ over denominators $d_u$. With denominators
cleared, both identities hold modulo $M$, the product of the primes. Both
sides are integers, bounded by

$$2^{\,\mathrm{bits}(\Delta) + \max_u(\mathrm{bits}(c_u) - \mathrm{bits}(d_u) + 1 +
\mathrm{bits}(X'_u)) + \log_2(\#\text{terms}) + 1},$$

where $\Delta$ is the lcm of the denominators in that identity and $c_u$
its coefficients. Once $M$ exceeds twice the bound, they are equal over
$\mathbb{Z}$. This is Storjohann's criterion for a multimodular echelon
form, as the f4ncgb paper uses it.

**A wrong $X$ cannot pass.** (i) has a unique solution, so if the bound
check passes, the identities hold exactly and $X$ is the true one. This
also allowed a small reconstruction margin (30 bits): garbage simply fails
the bound and more primes are added.

**Why it is cheaper.** Normal forms are 1.5–2× the basis's size (katsura-7:
550 bits against 317), half the quotients' size. And elimination modulo
$p$ is fast.

Results (seconds, 16 threads / 1 thread):

| ideal | integer check | certificate | Singular |
|---|---|---|---|
| katsura-8 | 1.0 / 8.2 total | 0.66 / 4.0 total | 4.9 |
| katsura-9 | 8.2 / 72 | 4.1 / 43 | 89 |
| cyclic-7 | 0.82 / 3.4 | 0.72 / 2.8 | over 30 min |

Tests check that the certificate accepts the true basis of katsura-3 and
rejects a perturbed basis, a basis missing an element, and the generators
themselves (which are not a basis).

## What is still slow

On one thread the cost is the eliminations modulo primes. Katsura-9 takes
about 1.2 s per prime: $B'$ for 3954 pivots over 511 columns, for 30
primes. Restricting $X$ to what the identities actually touch, or reusing
the work across primes, is the next lever. The integer check remains as a
fallback when the certificate would need too much memory.

## What would have saved time

- **Before building a certificate, measure the heights of every candidate
  object** (quotients, normal forms, the basis) on a small family member,
  with the oracle. Ten minutes of Sage told us which certificate could
  win.
- **Instrument the hot loop with counters** (steps, scalings, content
  removals, rescans, fallbacks) before rewriting it. The fixed-width
  attempt would never have been started.
- **Write the negative tests first.** A certificate that accepts
  everything looks exactly like one that works.
