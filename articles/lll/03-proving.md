<!-- description: Proving that a floating-point LLL's output is reduced: interval Gram-Schmidt from the exact Gram matrix or the rows, a ladder of interval precisions from 53 bits to exact, double-word error bounds, and why the proof costs little. -->
# Proving the output

*Papers:
Chang, Stehlé and Villard, "Perturbation analysis of the QR factor R in
the context of LLL lattice basis reduction" (2012); Muller and Rideau,
"Formalization of double-word arithmetic, and comments on 'Tight and
rigorous error bounds for basic building blocks of double-word
arithmetic'" (2022).*

## Why a proof

A floating-point reduction that is not checked can stop inconclusively,
or return a basis that is not reduced: rounding can make a size
reduction or a Lovász test come out wrong. Proved or certified
floating-point algorithms exist; FLINT's LLL, for one, checks its result
with a certified test. Sagebrush needs the same guarantee:

- van Hoeij's factoring algorithm relies on reducedness to recognize
  factors;
- `matrix.LLL()` promises a reduced basis.

So L^2's output is returned only once it is **proved** $(0.51,
0.99)$-reduced, for the exact numbers.

Lattice equality needs no proof: the reducer only applies unimodular
integer row operations to an exact basis.

## What is proved

The Gram–Schmidt data are recomputed from scratch, in interval
arithmetic with every operation rounded outward, either from the exact
Gram matrix $G$ or from the rows:

$$r_{kj} = G_{kj} - \sum_{i<j} \mu_{ji}\, r_{ki}, \qquad \mu_{kj} = r_{kj} / r_{jj}.$$

Then:

- each $|\mu_{kj}| \le 0.51$ must hold for the whole interval;
- each Lovász inequality must hold for the whole interval.

The Lovász quantity is computed as
$s_{k-1} = G_{kk} - \sum_{i<k-1} \mu_{ki}\, r_{ki}$. Its terms are
$r_{ki}^2 / r_{ii} \ge 0$, which keeps the intervals narrow.

The answer is `Proved`, or `Inconclusive` when the intervals are too wide
to decide. It is never "not reduced" by mistake: an inconclusive check
moves on to more precision.

## A ladder of precisions

The precision a proof needs grows with the dimension: Chang, Stehlé and
Villard show it is linear. On the benchmark families it was about 0.6
bits per row. So, like the reducer, the check climbs a ladder and stops
at the first rung that decides:

| check | what it is |
|---|---|
| exact, in words | the exact Gram matrix in machine words, for rows of at most 8 limbs |
| `53` | doubles with a separate exponent, widened by one place per operation |
| `dw` | double-word midpoint-radius intervals on the exponent-scaled Gram matrix, about 106 bits |
| `dw-rows` | the same, computed from the rows, for rows with big entries |
| `md2`, `md3`, `md4` | midpoint-radius intervals whose midpoint is an exact sum of 2, 3 or 4 doubles: about 96, 149 and 202 bits |
| `dd-rows` | multi-double intervals from the rows |
| exact | the certificate of article 1 |

`l2_proof` (Sage's `proof=True`) adds a rung of binary floats with a
$p$-bit big-integer mantissa, rounded exactly down and up.

## Error bounds you can cite

The double-word rung adds and multiplies pairs of doubles. Its intervals
are only as good as the error bound charged for each operation, and the
published bounds for double-word arithmetic have had errors: that is the
subject of Muller and Rideau's paper. Sagebrush charges more than their
proved bounds:

- $6u^2$ for the accurate double-word addition;
- $8u^2$ for the double-word product with an fma, against their proved
  $5u^2$;
- quotients are bounded from their exact remainders, not from a formula.

## What it costs

Little, most of the time. In the final benchmark run (article 2), the
proof took:

| $d$ | proof time | checks that decided |
|---|---|---|
| 10 to 20 | 0 to 0.5 ms | `53`, `dw-rows` |
| 40 | 1.0 to 2.5 ms | `53`, `dw-rows` |
| 80 | 5.5 to 19.4 ms | `53`, `dw`, `dw-rows` |
| 120 | 12 to 219 ms | up to `md3` |
| 200 | 46 ms to 1.49 s | up to `md4`, against reductions of up to minutes |

The exception is uniform lattices with small entries at $d = 200$, where
the check is up to 44% of the total time. Uniform lattices with
1000-bit entries go the other way. Their proof runs from the rows
(`dw-rows`), and it is part of why Sagebrush beats FLINT on that family
(0.45 to 0.64x, at every dimension).

## What did not work

- **Going straight from 53 bits to exact.** The first design fell back to
  the exact certificate whenever 53-bit intervals could not decide. The
  exact check computes the $d_i$ in full, hundreds of thousands of bits
  at $d = 200$: on the largest outputs it did not finish in 600 seconds,
  after reductions of under a second. The intermediate rungs (`dw`, then
  `md2` to `md4`) exist because of that.

## What would have saved time

- **Separate the reducer from its proof from day one.** The reducer can
  be aggressive (approximate Gram matrices, low precision) because
  nothing it computes is trusted. Only the proof is.
- **Record which check proved each output.** The benchmark's "proved by"
  column showed at once where the ladder had a gap: 200-dimensional
  cases needing more than 106 bits went straight to `md4`.
