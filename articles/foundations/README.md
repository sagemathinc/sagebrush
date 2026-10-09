<!-- description: The MIT-licensed foundations under Sagebrush's math engines: big integers on dashu with a subquadratic gcd, a FLINT-like exact arithmetic layer, and polynomial factoring in Z[x], all checked against GMP and FLINT. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history, benchmarks and notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Foundations, MIT-licensed: integers, exact linear algebra, polynomials

Research mathematics software sits on a few layers: big integers,
arithmetic modulo machine words, exact linear algebra, and polynomial
arithmetic. In the open-source world that stack is GMP, FLINT and NTL,
all under the LGPL or the GPL.

Sagebrush needed the same layers under the MIT and Apache-2.0 licenses.
They also had to work in WebAssembly, in a browser. These articles explain
how they were built and how they compare with GMP and FLINT, which were
used as yardsticks only.

## Is it fast enough to choose?

For research computations, yes. The engines above these layers spend their
time in their own algorithms, and the layers themselves are close to the
LGPL and GPL libraries they replace.

| layer | reference | Sagebrush |
|---|---|---|
| big-integer multiplication | GMP | 1.3–3.4× its time (dashu) |
| big-integer gcd at 8 million bits | GMP | 4.8× its time (our half-gcd; dashu alone: 21×) |
| exact matrices over $\mathbb{Z}$ and $\mathbb{Z}/p$ | FLINT 3.6 | 1.1–5× its time; inverse over $\mathbb{Z}$ 4–6× faster |
| polynomial arithmetic over $\mathbb{Z}$ | FLINT 3.6 | 1–5× its time |
| factoring in $\mathbb{Z}[x]$ | FLINT 3.6 | identical results; usually comparable, about 20× slower on a hard Hecke polynomial (0.23 s against 0.01 s) |

The worst cases are named in the articles, with what would close them:
faster big-integer division, and van Hoeij's recombination for
factoring.

1. [Big integers](01-big-integers.md): choosing dashu by measurement, a
   subquadratic gcd, NTT multiplication, and WebAssembly.
2. [An exact arithmetic layer](02-exact-arithmetic.md): FLINT's role,
   clean-room: arithmetic modulo a word, NTTs, matrices and polynomials
   over $\mathbb{Z}/p$, $\mathbb{Z}$ and $\mathbb{Q}$, every answer
   certified.
3. [Factoring in $\mathbb{Z}[x]$](03-factoring-zx.md): Zassenhaus with Hensel
   lifting, in pure Rust, so newforms can be computed in a browser.
