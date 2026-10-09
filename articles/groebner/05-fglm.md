<!-- description: FGLM in Sagebrush: lex bases of zero-dimensional ideals from degrevlex, exponents beyond a machine word, huge rational coefficients, and how close it comes to the fastest implementations. -->
# FGLM: changing the order of a zero-dimensional ideal

*Code: `engine/mpoly/src/fglm.rs`, the `groebner` op in `lib.rs`,
`_dict_of_text` in `lib/_sage_mpoly.py`. Papers: Faugère, Gianni, Lazard
and Mora, JSC 1993; Faugère and Mou, "Sparse FGLM" (2017, for what comes
next).*

## Why

Users want lex bases: elimination, triangular systems, solving. Computing
them directly is slow. Singular's `std` in lex order took 34 s on
katsura-6 over $\mathbb{Q}$ and did not finish katsura-7 in 10 minutes.
For zero-dimensional ideals, Magma's default is a degree-order basis
first, then a change of order by linear algebra: FGLM.

## The algorithm

Let $G$ be the degrevlex basis. Its **staircase** $B$, the monomials that
no leading monomial divides, is a basis of $A = k[x]/I$, of dimension $D$.
It is finite exactly when every variable has a pure power among the
leading monomials.

1. **Multiplication matrices.** $x_i b$ is either in $B$ or on the border.
   The normal forms of all border monomials come from **one matrix
   reduction**: F4's symbolic preprocessing with $G$, then `spelim`
   reduces a unit row for each border monomial by the multiples of $G$.
   What is left of each unit row, on the staircase, is the normal form.
   Watch the sign: the reduced unit row *is* $\mathrm{NF}(x^u)$, not its
   negative.
2. **The walk.** Visit monomials in increasing target order, each as $x_i
   s$ for an $s$ already standard. Its vector is $M_i v(s)$. Reduce it
   against the standard vectors so far, kept in echelon form, each with
   its combination of the original vectors.
   - If it reduces to zero, the dependency is a new basis element, already
     reduced (its tail is on standard monomials).
   - Otherwise the monomial is standard, and its multiples join a
     priority queue.
   - Multiples of leading monomials already found are skipped.

The cost is about $n D^3$ operations modulo $p$. That is fine for
$D \le 1000$: katsura-9 ($D = 512$) takes 0.63 s, against Magma's 1.49 s.

## The surprise: exponents do not fit

F4 packs a monomial into one `u64`: in 9 variables, 7 bits per variable,
so exponents up to 63 with the guard bit. Katsura-8's lex basis contains
$x_8^{256}$. Lex bases of zero-dimensional ideals have degrees up to $D$,
far beyond any packing. Before FGLM, such cases errored out ("exponents
too large to pack") and Sage-side Python Buchberger took over.

FGLM itself keeps monomials as exponent vectors. Only the staircase and
border, which have degrevlex-small degrees, use packed words. The engine
returns each result polynomial as packed bytes when it fits, and
otherwise as text (`TXT` + `e1,…,en:c;…`), which Python turns into its
dict representation.

## Over $\mathbb{Q}$: the coefficients are huge

1. Compute the degrevlex basis over $\mathbb{Q}$ (articles 3 and 4).
2. Run FGLM on its image modulo many primes.
3. Reconstruct.

The surprise was the number of primes: **2368 for katsura-7**. Lex bases
in shape position, $\{x_i - g_i(x_n),\ f(x_n)\}$, have coefficients far
larger than the eliminant $f$ suggests. That is why msolve outputs a
rational parametrization instead. Sage's API asks for the reduced lex
basis, so the size is inherent.

At that size, reconstruction was everything: 37 of 41 s. Two fixes:

- **Attempt only when the primes grow by a quarter.** Every attempt
  reconstructs numbers as large as the modulus, and the old rule tried
  after every batch, 146 times.
- **CRT by a product tree from 64 primes**, $O(M(k)\log k)$ per value
  instead of Garner's $O(k^2)$.

Katsura-7 went from 41 s to 7.6 s on 16 threads, and 31 s on one. On one
core, the fastest implementation we measured takes 17–22 s.

One experiment failed. **Per-entry rational reconstruction**, instead of a
running common denominator per row, was 3–4× slower. In these bases,
entries of a row do share most of their denominator.

## Proving the lex basis

Arnold's conditions again (article 4), adapted:

- **Leading monomials**: compare with the lex basis modulo a fresh prime,
  computed by F4 and FGLM on the generators modulo that prime.
- **When the exponents fit a word**: the generators and S-pairs go through
  `verify_q` and its certificate.
- **When they do not**: exact reductions on exponent vectors. In shape
  position all leading monomials are pairwise coprime, so there are **no
  S-pairs to check**. Only the generators must reduce to zero.

Katsura-7 takes 64 s with proof, of which 56 s are those reductions. They
are slow because they effectively compute in $\mathbb{Q}[t]/f(t)$ with
coefficients of tens of thousands of bits. Singular takes 109 s with
`std` then `fglm`, and Sage's default does not finish.

Faster ways to prove that $f(g_1(t), \dots, g_{n-1}(t), t) \equiv 0 \bmod
f(t)$:

- reconstruct the quotient modularly, and check the identity with one
  Kronecker-substituted multiplication;
- prove via the much smaller rational parametrization.

## Results

| | Sagebrush, 16 / 1 thread | Magma 2.29 (normalized) / 2.18 | Singular |
|---|---|---|---|
| katsura-8 lex mod 32003 | 0.14 s | 0.05–0.06 / 0.21 s | |
| katsura-9 lex mod 32003 | 0.63 / 0.79 s | 0.27–0.35 / 1.49 s | |
| cyclic-7 lex mod 32003 | 0.27 / 0.29 s | 0.92–1.23 / 0.40 s | |
| katsura-6 lex over $\mathbb{Q}$ | 0.36 s, proof 1.2 s | 0.61–0.80 / 0.84 s | 1.7 s (`std` + `fglm`) |
| katsura-7 lex over $\mathbb{Q}$ | 7.6 / 31 s, proof 64 s | 17–22 / 27.4 s | 109 s |

So on one core Sagebrush takes 1.4–3× the time of the fastest
implementation measured, except on cyclic-7, where it takes less. With all
cores it is ahead over $\mathbb{Q}$. How Magma 2.29 was measured and
normalized is explained in the series index.

The output is identical to Sage 10.10 on 11 cases (lex and invlex; over
$\mathbb{Q}$, $\mathbb{F}_{32003}$ and $\mathbb{F}_7$).

## Next

- **Sparse FGLM** (Faugère–Mou) for shape position. The multiplication
  matrix of the last variable is sparse, so the sequence
  $s_k = r^T M_n^k e_1$ and Berlekamp–Massey give the eliminant in about
  $O(D \cdot \mathrm{nnz})$, and the other variables follow from Hankel
  systems. Dense FGLM at $D = 2048$ ($n D^3 \approx 10^{11}$) is where
  this becomes necessary. Wiedemann's machinery is also what modular
  symbols want.
- **A faster lex proof**, as above.

## What would have saved time

- **Check the output representation against the worst case first.** A
  one-line estimate ($D$ up to $2^n$ for katsura, against $2^{64/n}$) would
  have shown the packing problem before any code was written.
- **Print the per-phase split** (images vs. reconstruction) in the first
  version. The 37 s of reconstruction was invisible in the total.
- **Measure the oracle on the exact operation the user calls.** Sage's
  default lex path, Singular's `std` in lex, and `std` + `fglm` differ by
  orders of magnitude; comparing with only one of them misleads.
