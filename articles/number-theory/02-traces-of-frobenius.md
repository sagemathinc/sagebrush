<!-- description: Computing a_p = p + 1 - #E(F_p) for every prime up to 10^8: smalljac's genus-1 strategy written from scratch in Rust, checked prime by prime, and what made it slower or faster than smalljac. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history and result notes (results/ap.md) of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Traces of Frobenius

*Code: `engine/ap`. Source: Kedlaya and Sutherland's smalljac strategy for
genus 1.*

## The problem

For an elliptic curve $E/\mathbb{Q}$ and every prime $p$ up to a bound,
compute $a_p = p + 1 - \#E(\mathbb{F}_p)$. These are the inputs to
$L$-functions, Sato–Tate statistics and modularity checks. They are
needed for millions of primes, so the cost per prime is what matters.

## The method

- **Arithmetic modulo $p < 2^{62}$ in Montgomery form**, with branchless
  addition and subtraction and an interleaved batch inversion.
- **A point without square roots.** For each prime, one Legendre symbol
  decides between $E$ and its quadratic twist. With $d = f(x_0)$, the
  point $(d x_0, d^2)$ lies on $y^2 = x^3 + a d^2 x + b d^3$.
- **Baby-step giant-step** over the Hasse interval $|t| \le 2\sqrt p$, for
  every $t$ with $(p + 1 - t) P = O$. Points are in Jacobian coordinates
  with batched normalization.
- **Halve the search** when one Legendre symbol (of the cubic's
  discriminant) shows that $a_p$ is even.
- **Never probabilistic.** Take more points until exactly one $a_p$ is
  consistent with all of them. Below $p = 1000$, count points directly.
- **Parallel** over chunks of primes for one curve, or over curves.

It is about 600 lines of Rust.

## Checks

- Every $a_p$ of 11a for $p < 10^6$ is identical to smalljac's output, all
  78,497 primes.
- The sum of $a_p$ for 11a up to $10^8$ is identical (5,761,454 primes).
- Sage agrees for $p < 20000$ on 11 curves, covering ranks 0–3, CM curves
  and large coefficients.
- Sato–Tate moments of 11a up to $10^7$ are 1.000, 1.999, 4.998, 13.992
  (theory: 1, 2, 5, 14). For the CM curve 27a3 they follow the CM
  distribution: 0.999, 2.997, 9.988, 34.955.

## Against smalljac

Curve 11a, all good primes up to $N$:

| $N$ | smalljac, 1 core | Rust, 1 thread | smalljac, 16 processes | Rust, 16 threads |
|---|---|---|---|---|
| $10^7$ | 3.99 s | 4.93 s | 0.58 s | 0.45 s |
| $10^8$ | 42.1 s | 67.4 s | 4.27 s | 6.10 s |

For many curves at once, $a_p$ of 1000 curves at all 9592 primes below
$10^5$ takes 4.24 s from Python on 16 threads.

## Where the gap is, and what did not work

- **The gap grows with $p$** (1.23× at $10^7$, 1.6× at $10^8$). The
  baby-step giant-step work grows like $p^{1/4}$, so smalljac's advantage
  is per group operation.
- **The kernel is latency-bound.** About 45% of the time is Montgomery
  multiplication, but in serial chains: scalar multiplication and batch
  inversion are chains of roughly 12-cycle multiplications.
- **Affine progressions with shared inversions** (6 multiplications per
  point instead of about 16) were 20% *slower* at $10^7$. Each extra
  inversion is a serial chain of about 33 multiplications. And a
  progression that adds $kB$ to $[B, \dots, kB]$ also hits a doubling,
  which at first made every call fall back.

## What would have saved time

- **Profile for latency, not just for instruction counts.** Saving
  multiplications does not help a kernel whose multiplications wait on
  each other. The lever is interleaving several primes, so that the
  chains overlap.
- **Check digests, not samples.** A digest of all 78,497 $a_p$ of 11a sits
  in the test suite, so any regression anywhere shows up at once.
