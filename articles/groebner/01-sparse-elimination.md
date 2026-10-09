<!-- description: The sparse modular elimination under F4: a one-pass accumulator, Faugère–Lachartre's layout with AVX2 dense updates, and why Steel's random combinations did not help. -->
# Sparse elimination modulo p for F4

*Code: `engine/arith/src/spelim.rs`. Papers: Faugère 1999 (F4); Faugère and
Lachartre, PASCO 2010; Boyer, Eder, Faugère, Lachartre and Martani, "GBLA"
(2016); Monagan and Pearce on Steel's random combinations.*

## The problem

Each F4 step builds a matrix. Its columns are monomials in decreasing
order, and it has two kinds of rows:

- **Pivot rows**: one multiple $m g$ of a basis element for each
  monomial that some leading monomial divides. Their leading columns are
  all distinct, and each is monic.
- **Rows to reduce**: one half of each S-pair.

The goal is the reduced echelon form of the second kind modulo the first:
the rows whose leading monomials are new. The matrices are very sparse
(katsura-11 reaches about $30000$ columns), mostly triangular already, and
most rows reduce to zero. A general sparse LU wastes all of that
structure.

## The kernel

Primes are below $2^{31}$, stored as `u32`. A row is two vectors: `cols:
Vec<u32>` (increasing) and `vals: Vec<u32>`.

**Reduction by the known pivots.** A row is loaded into a dense `i64`
accumulator whose entries are kept in $[0, p^2)$. To subtract $c\,v$ with
$c, v < p$, compute $y = d - c v$ and add $p^2$ back if $y$ is negative:
`y + ((y >> 63) & p2)`, with no division. An entry is reduced modulo $p$
(Barrett, `r = floor(2^64 / p)`) only when the left-to-right scan reads it.
At a pivot column, the entry is eliminated by that pivot, which only
touches columns to its right. Anywhere else the entry is final. So
reducing a row is **one pass**, and rows are independent: natively they
are spread over threads in chunks of four.

**Echelon and back-reduction.** The remainders are echelonized among
themselves, sequentially, in order. Then they are **fully back-reduced**:
no new row keeps an entry at another new row's leading column. Paying for
full back-reduction looks optional, since the basis would still be
correct. It is not: on katsura-9 it cut the later matrices from 5508 to
4795 columns (msolve shows 4571) and the total work by 34%. Shorter basis
elements mean smaller matrices in every later step.

## Faugère–Lachartre: change the order of operations

The cascade above reduces each row separately. Each elimination may bring
in entries further right that need further pivots, so long cascades redo
the same work for every row.

Faugère and Lachartre split the columns into pivot columns $L$ and the
others $N$. The pivots are $[A \mid B]$ with $A$ triangular, the rows
$[C \mid D]$. Then:

1. **Reduce the pivots by each other first.** $B' = A^{-1} B$ is computed
   right to left, densely over the $N$ columns: one dense row per pivot.
2. **Each row then needs one dense update per entry it has in $L$:**
   $D - C B'$. There is no cascade, because a reduced pivot has nothing
   left in $L$.

Details that mattered:

- **Only the pivots reachable from the rows' entries are needed.** A
  depth-first search through the pivots' own $L$ entries finds them.
  Without this pruning, $B'$ is computed for pivots no row ever uses.
- **The dense update vectorizes.** It is a 32×32→64-bit multiply-add kept
  in $[0, p^2)$ (`y = acc + c*b; if y >= p2 { y - p2 }`). Compiled with
  `#[target_feature(enable = "avx2")]` and chosen at run time, it is about
  4× cheaper per entry than the scattered cascade updates.
- **Threads take column slices.** $B'$ and the updates separate by
  columns: thread $t$ does all of the work on its slice of $N$, with no
  synchronization. These are Faugère and Lachartre's column blocks.
- **`reduce_auto` picks per matrix.** It runs a symbolic cascade on 8
  sample rows to count scattered updates, and compares that with
  $(\text{entries in } L) \times |N| \times w$. The weight $w$ is 0.25
  with AVX2 and 0.6 without, as in WebAssembly. Neither method wins
  everywhere. Katsura's matrices favor the dense layout; cyclic-8's
  (larger $|N|$ relative to the pivots) favor the cascade.

Measured, degrevlex mod 32003, one thread:

| ideal | before FL | with FL | msolve |
|---|---|---|---|
| katsura-9 | 0.68 s | 0.46 s | 0.33 s |
| katsura-10 | 5.2 s | 3.06 s | 2.40 s |
| katsura-11 | 49 s | 24.2 s | 18.1 s |
| cyclic-8 | 4.9 s | 4.8 s | 1.9 s |

## What did not work: random combinations

Steel's idea, as described by Monagan and Pearce, is to reduce random
linear combinations of blocks of rows instead of the rows themselves.
Stop at the first combination that reduces to zero; with probability
about $1 - 1/p$ the rest of the block would too. Since most F4 rows reduce
to zero, this looks like an obvious win.

Measured, it saved nothing: katsura-8 over $\mathbb{Q}$ went from 10.1 s
to 10.9 s, and cyclic-7 from 9.3 s to 8.6 s. The reason is structural: **a
combination of sparse rows has the union of their supports**. Reducing it
cascades through the pivots of every row in the block, so one combination
costs about as much as the rows it replaces. The trick pays for dense
blocks, not for F4's sparse rows. The code stays (`reduce_random`) for
dense uses.

## What would have saved time

- **Read GBLA's matrix statistics first.** They show how many columns are
  pivots and how long the cascades are. A ten-line `SB_F4_SHAPE` dump of
  our own matrices (columns, pivots, average entries in $L$ per row) would
  have shown on day one that katsura wants FL and cyclic does not.
- **A wrong Barrett constant passed small tests.** `u128::MAX / p` instead
  of $2^{64}/p$ is off by one only rarely, so small tests passed. Test
  modular kernels on random large inputs against a slow reference from
  the start (`random_against_dense` now does).
- **Return the reduced pivots as a by-product.** `fl_parts`, the version
  that hands $B'$ back to the caller, turned out to be what both the proof
  certificate (article 4) and FGLM (article 5) needed. Designing the
  kernel's API around "give me the normal forms of these monomials" from
  the start would have avoided writing it twice.

## Beyond Gröbner bases

The kernel is generic: "many sparse rows, most pivots known in advance".
That is also the shape of relation matrices and of Hecke-operator kernels
in modular symbols.
