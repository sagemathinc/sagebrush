<!-- description: What comes after an L^2 at 1.7x FLINT (geometric mean over a benchmark corpus): flatter's recursive reduction for lattices with huge entries, BLASter and Kirchner–Espitau–Fouque, several cores, and measured memory budgets. -->
# Next

*Papers: Ryan and Heninger, "Fast practical lattice reduction through
iterated compression" (flatter, CRYPTO 2023, ePrint 2023/237); Ducas,
Pulles and Stevens, "Towards a Modern LLL Implementation" (BLASter,
ASIACRYPT 2025, ePrint 2025/774); Neumaier and Stehlé on segmentation; Kirchner, Espitau and Fouque, "Towards faster
polynomial-time lattice reduction" (CRYPTO 2021).*

The first goal was an L^2 within 2x of FLINT, with every output proved.
On the benchmark corpus it is met on average: the geometric mean over
the 77 completed comparisons is 1.7x. It is not met everywhere: 54 of
the 77 cases are within 2x, the worst is 2.81x, and the hardest lattice
is excluded because FLINT did not finish (article 2). The next round aims past FLINT, using
algorithms newer than the ones FLINT and fplll implement.

## Huge entries: compression

L^2's cost grows with the bit length of the entries, and its worst
ratios against FLINT are on lattices with large entries at
$d = 200$ (knapsack with 1000-bit entries). Recent algorithms change the
shape of the problem rather than speeding up each step:

- **flatter** (Ryan and Heninger) reduces recursively. It splits the
  lattice into blocks, reduces each block's *compressed* (truncated)
  version, and applies the transformation to the full-precision lattice.
  Most of the work then happens on numbers far shorter than the input's.
  It reaches LLL-like quality, and its authors report large speed-ups
  over fplll on lattices with big entries, the shape of the cryptanalysis
  and Coppersmith lattices where they matter.
- **BLASter** (Ducas, Pulles and Stevens) combines several known ideas:
  - Neumaier and Stehlé's segmentation;
  - Seysen's reduction, which avoids multiprecision in larger dimensions;
  - parallelism, with the linear algebra done by BLAS.

  Its authors report it much faster than fplll and flatter on q-ary
  lattices, without worse output.
- **Kirchner, Espitau and Fouque** give the recursive approach a
  provable complexity, with a precision analysis.

All three will be implemented clean-room from the papers, with outputs
proved the same way as L^2's (article 3). A faster reducer whose output
is not proved would be a step back.

## Several cores

L^2 runs on one thread. The block structure of flatter and BLASter is
what makes several cores useful: blocks of a level can be reduced at
the same time. A design note comes first, with the measurements it
needs: how much of the time is in independent blocks, and what the
merge costs.

## Measured memory

Every budget in this series charges estimates: big-integer sizes from
bit lengths, with some slack. The big-integer library is Sagebrush's own
fork of dashu, which is to become much more than a dependency. Making it
report each value's exact heap bytes would let the budgets charge
measured sizes, and drop the deliberate over-reservations (article 5).
