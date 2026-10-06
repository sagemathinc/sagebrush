# The integrator on Rubi's test suite

[Rubi's integration test suite](https://github.com/RuleBasedIntegration/MathematicaSyntaxTestSuite)
(MIT) has about 72,000 problems in Mathematica syntax. `convert.py` turns
59,583 of them into Sage syntax; the rest use functions the engine does
not have. `score.py` runs `engine/sym`'s integrator on each, with a limit
of 1 s per problem, in parallel workers. Each worker has 4 GB of memory,
and a watchdog ends runs that stop checking for interrupts.

A problem counts as **found** when `integrate()` returns an
antiderivative. Every such answer has been verified by differentiation, so
it is correct, but it may not be in the simplest form. Rubi's own grading
also rates the size and form of an answer; this one does not.

    git clone --depth 1 https://github.com/RuleBasedIntegration/MathematicaSyntaxTestSuite /tmp/rubi-tests
    python3 bench/rubi/convert.py /tmp/rubi-tests > /tmp/rubi.jsonl
    python3 bench/rubi/score.py /tmp/rubi.jsonl -j 14 --timeout 1000 --out /tmp/results.jsonl

## Results (October 6, 2026, 14 workers)

| section                       | problems | 3f424de | b421618 | 0d1f2e0 |
|-------------------------------|---------:|--------:|--------:|--------:|
| 0 Independent test suites     |    1,853 |   52.8% |   54.6% |   62.7% |
| 1 Algebraic functions         |   22,211 |   16.4% |   24.3% |   26.6% |
| 2 Exponentials                |      615 |   24.2% |   25.4% |   25.4% |
| 3 Logarithms                  |    2,492 |    7.5% |   12.8% |   13.1% |
| 4 Trig functions              |   16,165 |    6.0% |    6.9% |   11.9% |
| 5 Inverse trig functions      |    4,620 |    3.3% |    5.1% |    5.0% |
| 6 Hyperbolic functions        |    4,938 |   16.6% |   24.9% |   24.9% |
| 7 Inverse hyperbolic functions|    6,575 |    2.2% |    3.4% |    3.4% |
| 8 Special functions           |      114 |    8.8% |    8.8% |    8.8% |
| **total found**               |   59,583 | 7,036 (11.8%) | 9,695 (16.3%) | 11,174 (18.8%) |
| timeouts                      |          |  22,843 |  10,308 |  12,852 |
| runs ended by the watchdog    |          |     961 |       7 |       8 |
| wall time                     |          |  2639 s |   920 s |  1098 s |

The commits are:

- `3f424de`: the first integrator;
- `b421618`: failing fast (a work budget, a memo of failures, no chains
  of renaming substitutions);
- `0d1f2e0`: trigonometric substitution, every trigonometric form through
  sin and cos, symbolic partial fractions and mixed radicals.

The independent suites are textbook collections: Stewart, Apostol, Hearn,
Moses, Timofeev and others. At 0d1f2e0 we find 95% of Stewart's problems (357/376), 87% of
Moses', 76% of Apostol's, 64% of Hearn's and 53% of Timofeev's. Most problems in the
other sections have symbolic exponents and parameters ((a + b x)^m ...),
where a rule-based integrator like Rubi does far better.
