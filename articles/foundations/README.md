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

1. [Big integers](01-big-integers.md): choosing dashu by measurement, a
   subquadratic gcd, NTT multiplication, and WebAssembly.
2. [An exact arithmetic layer](02-exact-arithmetic.md): FLINT's role,
   clean-room: arithmetic modulo a word, NTTs, matrices and polynomials
   over $\mathbb{Z}/p$, $\mathbb{Z}$ and $\mathbb{Q}$, every answer
   certified.
3. [Factoring in $\mathbb{Z}[x]$](03-factoring-zx.md): Zassenhaus with Hensel
   lifting, in pure Rust, so newforms can be computed in a browser.
