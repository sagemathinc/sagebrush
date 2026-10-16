<!-- description: How Sagebrush runs Sage programs in the browser: an independent implementation of the Sage language, with its own engines for exact arithmetic, symbolic calculus and number theory, tested against SageMath as a black box. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, tests, coverage reports and commit history of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Sage

:::disclaimer
**Sagebrush is not SageMath, and shares no code with it.**

Sagebrush's Sage mode is an independent implementation of the Sage language, written from SageMath's public documentation and tested against SageMath as a black box. It contains no SageMath code.

It does not aim for 100% compatibility with SageMath. Where it answers, the answer is meant to be mathematically correct and complete, but it may be printed or ordered differently from SageMath's. Where something is not implemented, Sagebrush raises an error instead of guessing.
:::

Sagebrush runs Sage programs: in the notebook, on boards, in the Jupyter
kernel, from the command line, and from Python as `sagebrush.sage`. A
program is preparsed, as Sage preparses it, and runs on Sagebrush's own
Python library and engines: exact integers and rationals, real numbers of
any precision, polynomials, a symbolic calculus engine, and number theory
written from the literature. It was written from SageMath's public
documentation and tested against SageMath, run as a black box.

1. [How the Sage implementation works](01-how-it-works.md): the
   preparser, numbers and parents, symbolic calculus, algebra and number
   theory, proofs and refusals; how it was tested against SageMath; how
   close it is, by the numbers; and what would have saved time.

The engines underneath have articles of their own:
[Gröbner bases and multivariate polynomials](/articles/groebner/),
[number theory engines](/articles/number-theory/) and
[the foundations](/articles/foundations/) (big integers, exact linear
algebra, factoring).
