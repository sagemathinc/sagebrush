<!-- description: The exact integral LLL that every faster route falls back to, how its numbers are capped and budgeted, and an exact certificate that a basis is LLL-reduced and spans the input's lattice. -->
# The exact LLL and its certificate

*Papers: Lenstra, Lenstra and Lovász 1982; Cohen, A
Course in Computational Algebraic Number Theory, Algorithm 2.6.7 (after
de Weger).*

## The idea in one paragraph

LLL turns a basis $b_1, \dots, b_d$ of a lattice into one whose vectors
are short and nearly orthogonal. Two conditions define "reduced", in
terms of the Gram–Schmidt vectors $b_i^*$ and coefficients
$\mu_{ij} = \langle b_i, b_j^* \rangle / |b_j^*|^2$:

- size reduction: $|\mu_{ij}| \le \eta$ for $j < i$;
- the Lovász condition:
  $\delta |b_{k-1}^*|^2 \le |b_k^*|^2 + \mu_{k,k-1}^2 |b_{k-1}^*|^2$.

Sagebrush uses $\eta = 0.51$ and $\delta = 0.99$. The algorithm
alternates two moves until both conditions hold everywhere: subtract
integer multiples of earlier rows (size reduction), and swap neighbours
that violate Lovász.

## The exact version

The Gram–Schmidt data are rational, but Cohen's integral form (after de
Weger) keeps them as integers:

- $d_0 = 1$ and $d_i = \prod_{j \le i} |b_j^*|^2$, the leading principal
  minors of the Gram matrix;
- $\lambda_{ij} = d_{j+1} \mu_{ij}$.

Every step updates these by exact integer formulas. Nothing is rounded,
so there is nothing to prove afterwards: the output is reduced because
the algorithm says so.

The price is size. The $d_i$ and $\lambda_{ij}$ grow to about $d$ times
the bit length of the entries. So `lll` runs with a cap on every stored
value,

$$L = d\,(2e + \lceil \log_2 d \rceil + 4) + 64$$

bits, for $d$ rows with entries of at most $e$ bits. Every product is
checked in advance from its operands' bit lengths: one that could pass
$2L + 64$ bits is refused before it is computed. Every stored value is
checked against $L$ after each step. The caller reserves the memory of
the basis and the state (`lattice_bytes`) before building anything.
Every step debits its work first. A refusal is an error, never a wrong
answer and never an unbounded allocation.

This exact LLL is the fallback for everything else in this series. When
the floating-point L^2 (article 2) cannot prove its result, or its
numbers pass its own cap, the exact LLL starts over from the input.

## Is the answer right? A separate certificate

A reducer that proves its own output (article 3) still needs an outside
check while it is being written. `lll_cert::certify` is that check,
written in integer arithmetic only, from scratch, and sharing no code
with the reducers. Given the input rows $B$ and an output $R$, it checks:

1. **Reducedness**, with Cohen's integral Gram–Schmidt data of $R$:
   - $|\mu_{ij}| \le \eta$ becomes
     $\eta_d\, |\lambda_{ij}| \le \eta_n\, d_{j+1}$, for $\eta = \eta_n/\eta_d$;
   - the Lovász condition, multiplied by $d_k d_{k-1}$, becomes
     $\delta_n\, d_k^2 \le \delta_d\, (d_{k+1} d_{k-1} + \lambda_{k,k-1}^2)$.
2. **The same lattice**:
   - $R$ has as many rows as $B$, and they are independent (every
     $d_k > 0$);
   - there are integer matrices $X$ and $Y$ with $X B = R$ and
     $Y R = B$.

   Then each lattice contains the other. $X$ and $Y$ are found modulo
   primes, so they are only candidates; the proof is the two exact
   products.

Every output of every benchmark and every test went through it. It
refuses with a reason: a size-reduction failure at $(i, j)$, a Lovász
failure at $k$, dependent rows, or a row not in the lattice.

## When the certificate is too slow

The exact certificate computes the $d_i$ of the output, which have
hundreds of thousands of bits for large lattices. On the benchmark's
largest uniform and Ajtai outputs it did not finish in 600 seconds,
while reducing them took under a second. A checker much slower than
the thing it checks is a nuisance, so `lll_cert` gained an **interval
oracle** for reducedness:

- the Gram–Schmidt data in dyadic intervals (BigInt mantissas of $p$
  bits, every result rounded outward);
- $p$ doubled until the conditions are decided.

This implementation is separate from the reducer's own interval checks
(article 3). Lattice equality is still checked exactly, with the
products. In the development benchmark, 7 outputs that the exact check
could not finish within 600 seconds were certified this way, at 224 to
464 bits, in 0.4 to 7 seconds each. In the final run on the cloud
machine (article 2), all 78 outputs were certified: 48 exactly, in at
most 9.5 seconds each, and 30 by the interval oracle, at 84 to 464 bits,
in at most 10.8 seconds each.

## What would have saved time

- **Write the certificate first.** It took well under an hour, and every
  later step depended on it: each speed-up of the reducer was accepted
  only when every output still certified. Without it, a fast wrong
  reducer would have looked like progress.
- **Plan the certificate's speed.** An exact check is the right reference
  but scales badly. The interval oracle should have been in the first
  version, not added when the benchmark's largest cases timed out.
- **Cap and budget from the start.** The cap $L$ and the advance check
  on products made the exact LLL safe to use as a fallback anywhere,
  including in the browser, where memory is small and a runaway
  allocation kills the tab.
