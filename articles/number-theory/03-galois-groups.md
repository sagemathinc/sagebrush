<!-- description: Galois groups of rational polynomials in Sagebrush: a permutation group engine, transitive groups generated from scratch, Stauduhar's descent with p-adic roots, 2.2x faster than Magma in degree 12, through degree 23 and M23. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and commit history of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Galois groups of polynomials

*Code: `engine/group`, `engine/galois`. Sources: Holt, Eick and O'Brien,
*Handbook of Computational Group Theory*; Seress, *Permutation Group
Algorithms*; Atkinson 1975 (blocks); Geissler and Klüners, JSC 2000; Fieker
and Klüners, LMS JCM 2014.*

The goal: for an irreducible $f \in \mathbb{Z}[x]$, name $\mathrm{Gal}(f)$
as a transitive group $n\mathrm{T}k$ in the standard numbering. Degrees 1
to 13, 17, 19 and 23 are supported.

## Step 1: a permutation group engine

- **Stabilizer chains** by randomized Schreier–Sims (product
  replacement), then the deterministic Schreier–Sims test. So orders and
  membership are proven, not just likely.
- **Structure:** orbits, Atkinson's minimal blocks, all block systems,
  primitivity, $k$-fold transitivity, normal closures, derived series.
- **Named groups**, including the Mathieu groups ($M_{24}$ by Conway's
  construction on $\mathbb{P}^1(\mathbb{F}_{23})$).

**Validation:** all 2604 transitive groups of degree $\le 16$ agree with
Magma's database. The invariants compared were order, primitivity,
solvability, commutativity, transitivity, number of block systems,
$|G'|$ and $|G_1|$.

**One measured win:** solvability became **650× faster**. Normal closures
were generated from long lists of generators; a few random generators
suffice, checked exactly against the order.

## Step 2: the transitive groups, generated from scratch

Rather than importing a GPL database, the tables were generated:

- **subgroup lattices** by the cyclic extension method, from perfect
  seeds;
- **primitive groups** from known constructions (affine, projective lines,
  $\mathrm{PSL}(3, q)$, Mathieu, $S_n$ and $A_n$ on subsets);
- **imprimitive groups** from subgroups of wreath products and Goursat
  constructions;
- everything deduplicated up to conjugacy in $S_n$.

The counts reproduce OEIS: subgroup classes of $S_n$ for $n \le 9$
(A000638) and transitive groups (A002106). The standard $n\mathrm{T}k$
numbering was matched against GAP's library, used as an oracle.

**A bug the tests caught: a wrong "obvious" fact.** The search for
perfect subgroups assumed their orders are divisible by 60. That is
false: $\mathrm{PSL}(3,2)$ has order 168. The correct shortcut is
Burnside's $p^a q^b$ theorem: a nontrivial perfect group, being
nonsolvable, has at least 3 primes dividing its order.

## Step 3: the Galois group

1. **Frobenius cycle types.** For $p \nmid \mathrm{disc}(f)$, the degrees
   of the factors of $f \bmod p$ give the cycle type of an element of
   $\mathrm{Gal}(f)$ (Dedekind). Together with the parity (whether the
   discriminant is a square), this leaves the candidate groups. Often only
   one is left.
2. **Stauduhar's descent** from $S_n$ or $A_n$:
   - The roots are computed $p$-adically, in the unramified extension where
     Frobenius acts as a known permutation.
   - For each maximal transitive subgroup $K$ that is still a candidate, a
     relative invariant with stabilizer $K$ is evaluated at the roots,
     permuted by coset representatives.
   - $\mathrm{Gal}(f) \le s K s^{-1}$ forces a rational integer of known
     size. A value that is not one rules that conjugate out, rigorously.
   - Only cosets fixed by Frobenius can work ("short cosets").
   - Repeated values trigger a Tschirnhausen transformation.
3. **Huge indices.** From $A_{23}$ to $M_{23}$ the index is
   $1.3 \cdot 10^{15}$. The Frobenius-fixed cosets are found through a
   Sylow subgroup: if a power of Frobenius has prime order $q$ with
   $q^2 \nmid |K|$, all fixed cosets come from one subgroup of order $q$.
   The M23 polynomials of arXiv:2608.08538 take 0.4 s. Cycle types leave
   $M_{23}$ and $A_{23}$, which is proven. The resolvent built from the
   Steiner system then picks $M_{23}$, but that step is not proven: a norm
   bound would need about $10^{15} \cdot 50$ bits of precision.

**Invariants as products of linear forms.** For an index-2 subgroup cut
out by a sign character, a product of differences can replace an orbit
sum. For example, $\Delta_1 \Delta_2 (s_1 - s_2)$ for 12T298 inside
$S_6 \wr S_2$ has 31 factors, instead of an orbit sum of 518,400 terms.

**Proof status.** The result is marked proven when every step is
rigorous: a norm bound shows that the value is an integer, and it differs
from the values at all other cosets. For huge indices the result is what
the numerical evidence says, with an error probability far below $2^{-40}$
per step. That is how Magma's `GaloisGroup` works before `GaloisProof`.

## Results

- **2500 degree-12 polynomials:** 0.059 s each, against Magma's 0.132 s;
  72% proven. All agree with Magma.
- **840 random polynomials of degree 2–12** in 6.6 s, all agreeing with
  Magma.
- **Speedups along the way:**
  - one Newton lift per Frobenius cycle, with the Frobenius automorphism
    for the rest of the cycle;
  - the prime chosen for a small unramified degree;
  - fixed cosets computed once per subgroup;
  - machine words while $p^k < 2^{62}$.

  Together these took degree 12 from 0.214 s to 0.059 s.

## What would have saved time

- **Generate and check tables against counts you can look up** (OEIS),
  before trusting your own enumeration of groups.
- **Test every "standard fact" used as a shortcut** on the smallest cases
  you know. $\mathrm{PSL}(3,2)$ would have caught the divisibility
  shortcut at once.
- **Pick invariants for size, not uniformity.** The automatic orbit-sum
  invariant was correct everywhere but huge where a product invariant
  was tiny.
