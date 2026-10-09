# Multivariate gcd and factorization

*Code: `engine/mpoly/src/gcd.rs`, `factor.rs`, `hensel.rs`, `factor_p.rs`,
`rdense.rs`. Papers: Brown 1971; Wang 1978 (EEZ); Yun 1976; the textbooks
of von zur Gathen and Gerhard (*Modern Computer Algebra*) and of Geddes,
Czapor and Labahn (*Algorithms for Computer Algebra*).*

## GCD: Brown's modular algorithm, with cofactors

Over $\mathbb{Z}$, the gcd is computed modulo large primes and the images
are combined by CRT. Modulo a prime:

- evaluate the last variable at points of $\mathbb{F}_p$;
- find the gcds of the images recursively, down to univariate gcds;
- interpolate back (Newton).

Leading coefficients are normalized to $\gcd(\mathrm{lc}(A),
\mathrm{lc}(B))$ at each level. Unlucky primes and points show up as
leading monomials that are too large, and are discarded.

**What worked: interpolate the cofactors too.** $A/G$ and $B/G$ go through
the same evaluations and interpolation as $G$. The result is then checked
by two products, $G \cdot \bar A = A$ and $G \cdot \bar B = B$, rather
than two trial divisions. Multiplication is cheaper and simpler to make
fast than division. The Fateman gcd ($k = 10$) takes 0.075 s, against
Singular's 0.077 s.

## Factorization over $\mathbb{Z}$: Wang's EEZ

1. Contents.
2. Yun's square-free decomposition, which reuses the gcd's cofactors.
3. For each square-free part:
   - evaluate all variables but one;
   - factor the univariate image (Zassenhaus, in `sagebrush-poly`);
   - impose the leading coefficients;
   - Hensel-lift one variable at a time, by multivariate diophantine
     equations.

Things that mattered:

- **Leading coefficients by distinctive primes.** Wang's trick:
  - factor the leading coefficient;
  - evaluate its factors at the point;
  - attribute each one to the image factors through primes that divide
    exactly one evaluated factor.

  This avoids the coefficient blow-up of imposing $\mathrm{lc}^{r-1}$ on
  everything.
- **Choose the point and the main variable well.** Prefer zeros (sparse
  images), and the variable with the simplest leading coefficient.
- **Lift modulo a 62-bit prime, not $p^k$.** Coefficients smaller than
  half the prime come out as symmetric residues. Every factor is checked
  by exact division, and the rare failure falls back to $p$-adic lifting
  with a rigorous bound.
- **Prefix products split by degree in the lifting.** The error term of
  each step comes from products kept per power of the new variable, so a
  variable costs a few products, not one per degree.

$f(f+1)$ with $f = (1+x+y+z+t)^{15}$ factors in 0.66 s; Singular takes
0.58 s. 216 random factorizations matched Singular.

## Over finite fields: images split

Hilbert irreducibility fails over $\mathbb{F}_p$: the univariate image of
an irreducible polynomial usually splits. So Wang's method cannot assume
the image's factors correspond to true factors. The fix is a
**bivariate stage**:

1. Lift the factors of the univariate image $y$-adically, with the
   polynomial made monic as a power series, far enough that any true
   factor is determined.
2. Recombine by trying subsets.
3. Lift the true bivariate factors to all variables by the same
   multivariate Hensel lifting, with the leading coefficient imposed on
   every factor. Over a field that costs degree, not coefficient size.

**Characteristic $p$ square-free parts** are different too. A derivative
can vanish without the polynomial being constant. Take a variable $v$ with
$\partial f/\partial v \ne 0$:

- $f/\gcd(f, \partial f/\partial v)$ is the product of the irreducible
  factors that are separable in $v$ and of multiplicity prime to $p$;
- factor those, divide them out (repeated divisions give the
  multiplicities), and treat the rest again;
- when every derivative vanishes, $f$ is a $p$-th power: divide the
  exponents by $p$.

**GCDs without evaluation points.** Over $\mathbb{F}_2$ there are no good
points, so Brown's algorithm cannot run. `rdense.rs` stores polynomials
recursively and densely, and computes the subresultant PRS gcd. The first
version used a naive PRS and was far too slow; the subresultant
(`prem` multiplies by exactly $\mathrm{lc}^{\delta+1}$) plus square-free
tests on univariate and bivariate images fixed it.

**Tiny fields**: other main variables, then automorphisms $x_j \mapsto
x_j + c\, x_i^e$, within a budget. Otherwise the engine says "not in the
engine" and the caller falls back. Evaluation in extension fields is the
proper fix and is still to do (some $\mathbb{F}_2$ cases).

**Printing like Sage** took real work:

- factors are made monic in *invlex*;
- they are sorted by degree, then exponent, then Sage's own comparison of
  $\mathbb{F}_p$ polynomials, which is **not transitive**.

503 of 506 random factorizations print exactly as Sage 10.10 does. All
506 are correct; the three differ only in the order of ties.

## Bugs worth remembering

- **Detecting the level of a recursive dense polynomial by its first
  coefficient** fails when that coefficient is zero. Use the last.
- **Constant factors in square-free loops** can loop forever. Guard every
  "divide out and repeat" loop with a degree check.

## What would have saved time

- **Fix the output conventions (monic in which order, sorting) against
  the oracle before optimizing.** Matching Sage's printing reached into
  the normalization code after it was written.
- **Build the PRS gcd for tiny fields first, then Brown.** Brown is the
  fast path; the PRS gcd is the one that always works, and tests on
  $\mathbb{F}_2$ and $\mathbb{F}_3$ find bugs early.
- **Interpolate cofactors from the start.** Checking a gcd by products
  instead of divisions removed a whole class of slow paths.
