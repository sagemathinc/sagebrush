<!-- description: Class groups in Sagebrush: imaginary quadratic fields by Jacobson's sieve, real quadratic regulators, and general number fields by Buchmann's method with a field-specific GRH bound, with the bugs that taught the most. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history and project notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Class groups

*Code: `engine/classgroup`. Sources: Cohen's GTM 138 and 193; Buchmann's
subexponential method; Hafner–McCurley; Jacobson, "Applying sieving to the
computation of class groups" (Math. Comp. 1999); Bach's averaging;
Belabas, Diaz y Diaz and Friedman; Grenié and Molteni (arXiv:1507.00602,
1607.02430, 2212.09461). PARI was used only as an oracle and benchmark.*

Like PARI's `quadclassunit` and `bnfinit`, everything here assumes GRH,
which makes the bound on the generators small.

## Imaginary quadratic fields

**Relations by Jacobson's sieve**, in the self-initializing style of SIQS:

- A polynomial is a form $\varphi = (a, b, c)$, with $a$ a product of
  factor-base primes and $b$ found by CRT.
- A smooth value of $\varphi(x, 1)$ gives a relation among prime forms.
- All of this uses `u64`/`i128` arithmetic, with one big-integer division
  per polynomial.

**The group** is $\mathbb{Z}^n/L$ for the relation lattice $L$:

- structured Gaussian elimination;
- a Hermite normal form modulo a multiple of the determinant;
- the Smith form for the structure.

$\det L$ is a multiple of $h$. The analytic class number formula puts the
true $h$ within $\sqrt 2$ of an estimate (Bach's weighted Euler product),
so $\det L$ is $h$ once it falls below $\sqrt 2$ times the estimate.

**What made it fast:**

- **Grenié–Molteni's generator bound** $\frac{15}{4} \log^2 |D|$ instead of
  Bach's $6 \log^2|D|$.
- **Sieve only the small primes** of the factor base: larger ones enter
  as prime cofactors. One mistake here: rare "coverage partners" caused
  index-$2^k$ sublattices.
- **Fixed-width HNF.** A 128-bit Barrett HNF, with 256-bit products,
  replaced the big-integer HNF when $h > 2^{62}$: 1–4.6 s became about
  0.1 s.

**Results.** All 405 random discriminants up to $10^{30}$ and a 42-entry
benchmark agree with PARI. We are slower below $10^{17}$, equal at
$10^{17}$, and faster above: 22–44× faster at $10^{37}$–$10^{47}$. At
$10^{47}$ PARI takes 219 s and we take 5.4 s.

## Real quadratic fields: the regulator

The same sieve relations also describe principal ideals
$\gamma = \prod ((B + \sqrt D)/2)^c$. Kernel vectors of the relation
matrix give units, whose logarithms are multiples of $2R$. The class
number formula bounds $hR$, so multiples $h^*$ and $R^*$ with $h^* R^* <
\sqrt 2$ times the estimate are $h$ and $R$ themselves.

- **Fixed-point reals** (`real.rs`): square roots, logarithms, and an exact
  gcd of reals by continued fractions.
- **Precision is measured, not modeled.** Two cheap passes at low
  precision give the error. Cancellation makes the coefficients far exceed
  the logarithms, and modeling it failed.
- **Negative-norm relations** are included, so that units of norm $-1$
  appear.

At $D \approx 10^{41}$, PARI takes 4.6 s and we take 1.4 s. All 51
benchmark discriminants, 200 random and 29 small ones agree with PARI, to
at least 15 digits of the regulator.

## General number fields: `bnfinit`

The pipeline:

1. the maximal order by Round 2;
2. prime decomposition, by splitting $O/\mathrm{rad}(p)$ with minimal
   polynomials of random elements. This works for common index divisors,
   where Kummer–Dedekind does not.
3. relations from small elements of LLL-reduced ideals;
4. units as kernel vectors, kept in compact form;
5. the regulator by exact rational identification of the unit lattice;
6. roots of unity by Fincke–Pohst.

**The factor base is field-specific.** It holds the prime ideals of norm
below a bound $T$ computed for each field: Belabas, Diaz y Diaz and
Friedman's explicit-formula criterion, searched over step functions as in
Grenié and Molteni, with the witness checked directly. On the paper's
example this gives 11083 (the paper: 11071). This made `bnfinit` 3–10×
faster.

Result: 900 random cubic and quartic fields agree with PARI 2.17.

- **Cubic fields** beat PARI from discriminants around $10^{25}$, by
  2–5×.
- **Quartic fields** are still 1–4× slower, because products of prime
  ideals dominate.

## The bugs that taught the most

- **A too-small $h^*$ passes the check.** The test $h^* R^* <
  \sqrt 2 \cdot$ estimate only bounds $h^*$ from above, since a sublattice
  gives $h^* \ge h$. One path took the determinant to be 1 (the HNF ran
  modulo 1) and returned $h^* = 1$ whatever the lattice. Lesson: any code
  path that can make $h^*$ too *small* is a silent bug, and needs its own
  test.
- **Never trust an `f64` decision on an ill-conditioned basis.**
  - Round 2 on a polynomial with large coefficients gives a basis with
    huge numerators (even 1 has coordinates around $10^{10}$). Every
    floating-point step cancelled, giving a singular $T_2$ form and an
    endless enumeration. Bases are now $T_2$-reduced first, exactly.
  - Nearly coincident real roots looked like a complex pair. Real roots
    now come from Sturm sequences.
  - An `f64` "already in the lattice" shortcut skipped a vector of index
    2, so $R^*$ stayed $2R$ and the precision doubled forever.
- **LLL must not size-reduce at $|\mu| \approx 1/2$**, or it oscillates.
  Size-reduce only when $|\mu| > 0.51$.
- **Relations need skew.** LLL under the plain $T_2$ form finds only small
  elements, whose units are all small, and $R^*$ came out millions of times
  too big. Randomly weighted $T_2$ forms fixed it (Buchmann).

Several of these bugs were found by the next customer of the code: the
2-descent on elliptic curves, which pushes the class group code to
polynomials like $x^3 - 27 c_4 x - 54 c_6$.

## What would have saved time

- **Classify every check as an upper or a lower bound**, and write tests
  that break the unchecked side.
- **Confirm floating-point decisions exactly** whenever the basis is not
  known to be well conditioned.
- **Point a second algorithm at the first.** The 2-descent found bugs that
  900 random fields did not.
