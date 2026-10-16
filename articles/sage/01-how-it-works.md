<!-- description: How Sagebrush implements the Sage language: a preparser, Sage's integers, rationals, reals and parents on Sagebrush's own engines, a Rust symbolic calculus engine, number theory from the literature, and tests against SageMath as a black box. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, tests, coverage reports and commit history of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# How the Sage implementation works

:::disclaimer
**Sagebrush is not SageMath, and shares no code with it.**

Sagebrush's Sage mode is an independent implementation of the Sage language, written from SageMath's public documentation and tested against SageMath as a black box. It contains no SageMath code.

It does not aim for 100% compatibility with SageMath. Where it answers, the answer is meant to be mathematically correct and complete, but it may be printed or ordered differently from SageMath's. Where something is not implemented, Sagebrush raises an error instead of guessing.
:::

*Code: `src/sagepre.ts` (the preparser), `lib/sage_all.py` and
`lib/_sage_*.py` (the library, about 69,000 lines of Python), and the Rust
engines under `engine/`: `sym` (symbolic calculus), `mpoly` (multivariate
polynomials), `arith` and `bigint` (exact arithmetic), and the number
theory crates (`classgroup`, `modsym`, `galois`, `hmf` and others).*

Type this into a Sagebrush notebook in Sage mode:

```sage
1/3 + 1/6
factor(2^64 - 1)
R.<t> = QQ[]
K.<a> = NumberField(t^2 + 5)
K.class_number()
integrate(x*exp(x), x)
RealField(100)(2).sqrt()
```

What comes back is what SageMath prints:

```
1/2
3 * 5 * 17 * 257 * 641 * 65537 * 6700417
2
(x - 1)*e^x
1.4142135623730950488016887242
```

None of it comes from SageMath's code. The rest of this page explains
how, and how close it gets.

## 1. The language: a preparser

Sage is Python with a few additions, and Sage rewrites a program into
plain Python before running it. Sagebrush does the same, from the rules
in SageMath's documentation:

- `^` is a power and `^^` is exclusive or.
- `1/2` is the exact rational $1/2$, because integer literals are Sage
  integers, not Python's.
- `1.5` is a real number of 53 bits, and `100r` is a raw Python integer.
- `R.<x, y> = QQ[]` creates a ring and names its generators, and `R.0` is
  its first generator.
- `f(x, y) = x^2 + y` defines a symbolic function.
- `[1..10]` and `[1, 3..11]` are ranges that include their end.

Strings and comments are never rewritten, and line numbers stay as they
were, so error messages point at the line you wrote.

In the browser, part of this is done by the Python compiler itself, not by
text rewriting: in Sage mode, `^` compiles to a power, and `/` between two
integers compiles to an exact division. A second preparser, in Python,
does the whole job when the library runs under CPython, as
`sagebrush.sage`. Any place that runs Sage code given as a string, such as
`timeit("...")`, has to go through the same machinery. Otherwise it would
time a different computation: `2^3` would be exclusive or.

## 2. Numbers and parents

**Integers.** A Sage integer is a Python integer. In the browser,
Sagebrush's Python gives the integer type Sage's methods (`factor`,
`is_prime`, `digits`, `nth_root` and many more). CPython cannot extend its
`int`, so there `Integer` is a subclass of it with the same methods.
Ordinary integer arithmetic (`+`, `*`, `^`) is the runtime's own: in the
browser, JavaScript's `BigInt`; under CPython, CPython's `int`. The Rust
engines have big integers of their own, Sagebrush's code (see
[the foundations](/articles/foundations/)), for the computations they do:
factoring, exact linear algebra, number theory.

**Rationals** are exact fractions, always reduced, with Sage's printing
and methods. Where Sage's rules for $\mathbb{Q}$ differ from Python's, the
library follows Sage. For example, `gcd(2/3, 4/9)` is $2/9$, the gcd
of the numerators over the lcm of the denominators.

**Real numbers.** `RealField(prec)` is real arithmetic of any precision,
written from scratch: a number is $m \cdot 2^e$ with $m$ an integer of
exactly `prec` bits, correctly rounded after every operation, in each of
the rounding modes. The elementary functions and the constants $\pi$, $e$,
$\log 2$, Euler's $\gamma$ and Catalan's constant are computed in fixed
point with guard bits. At the default 53 bits a real number is a machine
double, for speed, and it switches to the general representation only when
a value leaves the double range. Numbers print with Sage's number of
digits for their precision.

**Parents.** Every Sage element knows its *parent*: the ring or field it
belongs to (`ZZ`, `QQ`, `RR`, `GF(7)`, `QQ['x']`, a number field). Parents
decide what arithmetic means and how mixed operations coerce: an integer
plus a rational is a rational, and an element of $\mathbb{F}_7$ plus an
integer stays in $\mathbb{F}_7$. Sagebrush implements the parents and
coercions that programs use, so that `parent()`, `base_ring()`, `change_ring`
and conversions such as `QQ(x)` and `K(a)` give Sage's answers.

**Other rings.** Univariate and multivariate polynomials, power series,
finite fields and their extensions, $p$-adic numbers, number fields and
their orders and ideals, algebraic numbers (`QQbar`), and matrices over all
of these are each a module of the library. The heavy computations
(factoring, Gröbner bases, exact linear algebra) run in the Rust engines.

## 3. Symbolic calculus

`var('x')`, `sin(x)`, `diff`, `integrate`, `limit`, `taylor`, `series`,
`solve`, `simplify` and the rest are backed by a symbolic engine written in
Rust (`engine/sym`). An `Expression` holds the engine's representation,
and each operation is one stateless call into the engine. The engine
covers:

- differentiation, and expansion and simplification of rational,
  trigonometric, exponential and logarithmic expressions;
- integration: exact integration of rational functions, a table of
  standard integrals, substitution, integration by parts, and products of
  trigonometric functions. Every antiderivative is checked by
  differentiating it. A definite integral is computed from an
  antiderivative only if the integrand has no nonintegrable singularity in
  the interval;
- limits, Taylor and Laurent series, and asymptotic expansions;
- `solve` for polynomial equations and systems, and for trigonometric and
  exponential equations, where Sagebrush returns every solution as a
  family (`x == pi*n1` for integer `n1`);
- sums with closed forms (polynomials, geometric sums, binomial sums,
  $\zeta$ values), and ordinary differential equations of the common types.

Printing follows Sage: the order of terms in a sum, the placement of signs
and the form of a fraction were measured on a corpus of expressions run
through SageMath, and then reproduced.

A rewrite must not change where an expression is defined. For example,
$\sum_k \binom{n}{k} x^k y^{n-k}$ is $(x+y)^n$, which is defined at $y=0$.
The form $(x/y + 1)^n y^n$ would raise an error there.

## 4. Algebra and number theory

Number fields, class groups and units, modular symbols and newforms,
elliptic curves, Galois groups, Gröbner bases and varieties are computed by
engines written from the literature, and checked against tables and
established systems. These engines have their own articles:

- [Number theory engines](/articles/number-theory/): modular symbols,
  traces of Frobenius, Galois groups and class groups.
- [Gröbner bases and multivariate polynomials](/articles/groebner/): F4,
  proofs over $\mathbb{Q}$, FGLM, gcd and factoring.
- [The foundations](/articles/foundations/): big integers, exact linear
  algebra and factoring in $\mathbb{Z}[x]$.

The Sage library is the layer that turns them into Sage's objects:
`NumberField`, `EllipticCurve`, `ModularSymbols`, `ideal(...).groebner_basis()`
and so on, with Sage's names, arguments and printed forms. A few of these
layers, in more detail:

**Number fields, class groups and units.** A field is
$\mathbb{Q}[x]/(f)$ for a monic irreducible $f$. Its elements, integral
bases, prime ideals, class groups, unit groups and regulators print as Sage
prints them, and the arithmetic runs in the Rust engine
(`engine/classgroup`). Polynomials over a number field have:

- gcds computed multimodularly and verified exactly;
- square-free decomposition by Yun's algorithm;
- factorization by Trager's norm method (Cohen, GTM 138, Algorithm
  3.6.4), checked by multiplying the factors back together.

Class groups and regulators assume GRH, as PARI's do and as Sage's do with
`proof=False`; the methods are Jacobson's sieve for imaginary quadratic
fields and Buchmann's subexponential method for general fields (see
[class groups](/articles/number-theory/04-class-groups)). With
`proof=True`, the engine returns an unconditional certificate when it can
find one within its limits; otherwise it raises `NotImplementedError` and
says why. It never returns the GRH value as proven. `unit_group()` gives
the rank, proven from the signature by certified root isolation, and the
roots of unity; fundamental units are not available yet.

**Algebraic numbers.** `QQbar` and `AA` are exact. An element is a
polynomial in a chosen root of an irreducible integer polynomial, and it
carries the 64-bit interval that Sage displays. When an operation combines
elements of different fields, the minimal polynomial of the result is a
factor of the characteristic polynomial of a Kronecker product of
companion matrices; the right factor is chosen by a numerical test at
increasing precision.

**Varieties.** `I.variety()` lists the points of a zero-dimensional ideal
as Sage's list of dictionaries: the Gröbner engine computes a lex basis,
and back-substitution finds the roots of each univariate polynomial in
turn over the base field, such as $\mathbb{Q}$ or $\mathbb{F}_p$. A
positive-dimensional ideal raises Sage's `ValueError`.

`I.variety(ring)` also works over $\mathbb{R}$ and $\mathbb{C}$ (`RR`,
`CC`, `RealField(p)`, `ComplexField(p)`, `RDF`, `CDF`) and over `AA` and
`QQbar`, through a rational univariate representation (Rouillier, 1999):

1. A separating linear form $t = x_0 + c x_1 + c^2 x_2 + \cdots$ is
   chosen.
2. The minimal polynomial $\chi$ of multiplication by $t$ is computed on
   the normal basis of the radical (the ideal plus the squarefree parts of
   its eliminants).
3. Each coordinate is then a rational function of a root of the
   squarefree $\chi$, so every point is exact.

Over `AA` and `QQbar` the points are exact algebraic numbers; over the
real and complex fields they are those exact points, correctly rounded to
the field's precision. The real points come first, then the rest in
increasing order, as Sage orders `AA` and `QQbar` points. Every size is
capped before the work it bounds (an eliminant's degree at most 4096, at
most 100 points, at most 32 tries for a separating form, at most 20,000
digits), and anything over a cap raises `NotImplementedError` rather than
running away or returning a partial list. Varieties over other number
fields are refused for now.

**Graphs.** `Graph` and `DiGraph` cover simple graphs with loops and edge
labels (multigraphs are refused), with the `graphs.*` and `digraphs.*`
families: degrees and neighbours, adjacency and Laplacian matrices,
shortest paths with or without weights, connected and strongly connected
components, spanning-tree counts by Kirchhoff's theorem, the Tutte
polynomial by deletion and contraction, and isomorphism. Isomorphism uses
colour refinement and then backtracking: a returned isomorphism is an
explicit vertex map, and `False` comes from an exhaustive search, so both
answers are exact.

**Matrices.** Over $\mathbb{Z}$ and $\mathbb{Q}$, determinants, ranks,
characteristic polynomials, echelon forms, kernels and solving run in the
Rust engine (`engine/arith`), with multimodular and $p$-adic algorithms,
and every answer is certified. Hermite and Smith forms with their
transforms, elementary divisors and LLL come from the number field engine;
as in Sage, `echelon_form()` over $\mathbb{Z}$ is the Hermite form.
Matrices over finite fields use Gaussian elimination over the field,
with echelon forms, kernels, inverses, solving, characteristic polynomials
and multiplicative orders. Over $\mathbb{Z}/n\mathbb{Z}$ with $n$
composite, which is not a field, the ring arithmetic works, but the same
elimination can meet a pivot that is not a unit, and then it raises an
error instead of answering. For example, the determinant of
`matrix(Zmod(6), [[2, 0], [0, 3]])` (which is $0$) is not computed yet.

**Hilbert modular forms.** `HilbertModularForms(N)` gives the forms of
weight $(2,2)$ over $F = \mathbb{Q}(\sqrt 5)$. It ports William Stein's
PSAGE implementation, with his permission, and uses the definite method:
by Jacquet–Langlands and class number one, $M_2(N)$ is the space of
functions on $R^\times \backslash \mathbb{P}^1(\mathcal{O}_F/N)$, where
$R$ is the icosian ring (Dembélé 2005). The engine (`engine/hmf`) also
gives $U_P$ for primes dividing the level, true new dimensions, and
weights $(k_1, k_2) \ne (2,2)$. Over any other real quadratic field,
`HilbertModularForms(F, N)` uses the general definite method of Dembélé
and Voight (2013): a certified maximal order in a totally definite
quaternion algebra, its right ideal classes by neighbours and the mass
formula, and the Hecke operators. Newforms come as Galois orbits, and each
eigenvalue is proven by checking $T_P v = c(T)\,v$ in integers.

## 5. Proofs, and refusing instead of guessing

Two rules govern every answer.

**A wrong answer is never acceptable.** If Sagebrush cannot compute
something correctly, it raises an error (usually `NotImplementedError`,
saying what is missing) rather than return something plausible. An empty
list where roots exist, a truncated series without its $O(\cdot)$ term, or
a number of the wrong precision are all wrong answers, and each is treated
as a bug.

**`proof=True` means proven.** Where Sage distinguishes proven from
probable results, Sagebrush does too:

- `is_prime(n)` with `proof=True` either proves primality or raises
  `NotImplementedError`. "Composite" is always proven.
- Class groups say when they depend on GRH.
- Gröbner bases over $\mathbb{Q}$ are proven by default, as Sage expects.

A result is never presented as proven when it rests on an unproven step.

## 6. How it was tested

SageMath was used as a black-box oracle: Sagebrush's authors ran it and
compared outputs, but never read its source. There are four layers.

**Program tests.** About 30 Sage programs (`sage-tests/`) print results
across the library. Their output under SageMath 10.10 is committed, and the
test suite requires Sagebrush's output to be identical, byte for byte.

**Docstrings, checked in both systems.** About 4,000 examples in the
library's docstrings run in Sagebrush's own doctester on every change. A
separate script runs the same examples in SageMath, to check that each
expected output is what SageMath prints. Examples of Sagebrush-only
features are marked and skipped there.

**Coverage corpora.** Every example in two public documents is run through
both systems and compared:

- the Sage Tutorial (CC BY-SA 3.0): 1,075 examples;
- *Computational Mathematics with SageMath* (Zimmermann et al., 2018,
  CC BY-SA 4.0): 2,619 examples, chapter by chapter.

**Generated hunts.** Thousands of random cases (integers and rationals,
polynomials over several rings, matrices, finite fields, symbolic
expressions) are generated, run in both systems, and every difference is
triaged by hand. These hunts find the wrong answers that documentation
examples miss, because they try the cases nobody writes down: negative
arguments, empty matrices, rationals where integers are usual.

## 7. How close

The latest coverage run was made on 16 October 2026, at commit
`e4a9ce94`, with SageMath 10.10 as the oracle.

| corpus | scored | match | different | error | refused | by design | timeout |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sage Tutorial | 1,069 | 784 (73.3%) | 45 (4.2%) | 194 (18.1%) | 45 (4.2%) | 1 | 0 |
| *Computational Mathematics with SageMath* | 2,615 | 1,666 (63.7%) | 174 (6.7%) | 719 (27.5%) | 47 (1.8%) | 6 | 3 |

How to read the columns:

- **Match** means the case passes the comparison rules, which are those
  of a doctest, not byte-for-byte identity. Whitespace, warnings and
  memory addresses are normalized; numbers may differ within a small
  tolerance; an error matches an error of the same exception class; and a
  case the source marks as random matches if it runs. Of the book's 1,666
  matches, 159 are matching exceptions, 6 are within the tolerance and 1
  is a random case; of the tutorial's 784, 62, 1 and 5.
- **Different** counts every other case where Sagebrush gives a result or
  an exception different from SageMath's, whatever the reason, including
  a missing or different exception. Many of these are the same mathematics
  in another form or order: an equivalent expression, or the same terms or
  roots listed in another order. Others follow from an earlier case that
  failed. When these were triaged by hand, about 10 cases in the book were
  confirmed as new wrong values, and all of them are being fixed.
- **Error** mostly means a missing feature (a function or method
  Sagebrush does not have yet), or an earlier failure in the same session,
  such as a name that was never defined.
- **Refused** means an explicit error instead of a guess: Sagebrush
  recognized the request and said it cannot answer it correctly yet.

**By design** are the few cases where Sagebrush deliberately answers
differently. For example, `solve(sin(x) == 0, x)` returns
every solution, `x == pi*n1` for an integer `n1`, where SageMath returns
only `x == 0`. A **timeout** is a case that did not finish within the
harness's time limit.

The book's weakest chapters are numerical integration, combinatorics and
graph theory, where much is still missing. Its strongest are the first
steps, programming, and finite fields and number theory, where 86–94%
of the cases match.

## What would have saved time

- **The oracle from day one, with the outputs committed.** A test that
  stores SageMath's output next to the program runs without SageMath,
  catches regressions in seconds, and makes "the same as Sage" a check, not
  a judgment.
- **Hunting for wrong answers, not just failures.** Errors are visible.
  Wrong answers are not, and generated cases, compared line by line with
  the oracle, found more of them than any corpus did.
- **Refuse early, and loudly.** Each place that returned something
  plausible instead of raising an error (an empty list of roots, a
  rewritten formula with a new denominator) cost more to find than the
  refusal would have cost to write.
- **Printing is a specification.** Sage's order of terms and its number
  formats are part of the answer readers see, and measuring them on many
  examples at once was much faster than fixing them one by one.
