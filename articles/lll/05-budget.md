<!-- description: Putting a whole matrix.LLL() call under one memory and work budget: a rank modulo a prime, a Hermite form whose entries reach several times the Hadamard bound, reservations that grow before the numbers do, and five bugs that review found. -->
# A budget for the whole call

## The problem

`matrix.LLL()` accepts any integer matrix, including rows that are
linearly dependent. LLL needs independent rows, so a dependent input is
first replaced by a basis of its lattice: its Hermite normal form. Then
the reduced basis is returned, with zero rows first, one for each
dependent row.

The reduction itself was budgeted (article 4); the Hermite form and the
output were not. A dependent matrix could allocate without limit before
the budget ever saw it. Now the whole call runs under one budget, from
the parsed input matrix to the result. Every stage reserves its memory
before allocating, and debits an estimate of its work, counted in limb
operations, before doing it. Memory is limited by default; work is
limited only when a caller sets a limit.

## The stages

1. **The sizes** of the entries.
2. **The rank modulo a prime** $p = 2^{62} - 57$:
   - each entry is reduced over its words without allocating;
   - Gaussian elimination runs in place, with `u128` products.

   The rank modulo $p$ is at most the rank over $\mathbb{Q}$, so rank $r$
   *proves* the $r$ rows independent. Those rows are then reduced
   directly. With more rows than columns, the rows can't be independent,
   and this stage is skipped.
3. **The Hermite form**, for dependent rows, or for the rare independent
   rows whose rank is short only modulo $p$.
4. **The reduction**, handed the rows' reservation (article 4).
5. **The output**: the zero rows and the outer vector, reserved before
   they are made.

## The surprise: the Hermite form's numbers

The first design gave the Hermite elimination a fixed cap on its entries:
the exact LLL's cap, about twice the Hadamard bound
$r e + \tfrac{r}{2}\log_2 n$. Before finalizing, the design called for
measuring the largest intermediate entry on dependent inputs. Below is
that measurement, rerun with the final code: the bound on the entries'
bits that the budgeted Hermite stage grew to, as a multiple of the
Hadamard bound.

| rows × columns, entry bits | input | bound reached | ÷ Hadamard |
|---|---|---:|---:|
| 8 × 7, 203 | random | 4318 | 2.64 |
| 26 × 25, 303 | random | 64937 | 8.18 |
| 26 × 25, 600 | common factors | 90872 | 5.80 |
| 31 × 30, 103 | random | 31099 | 9.51 |
| 40 × 20, 10 | random | 1458 | 2.92 |
| 17 × 16, 1003 | random | 93553 | 5.47 |

Small and near-duplicate inputs stayed at 0.25 to 1.83. The final Hermite
form stays within the Hadamard bound, but the intermediate entries of
this elimination (smallest pivot first, Euclid-style) do not. The
multiple grew with the dimension in these runs, and no fixed multiple was
safe.

A fixed cap would have refused dependent matrices that the code reduced
before. So the cap went, and instead the reservation grows ahead of the
numbers. The stage keeps a bound $c$ on its entries' bits. Before each
row update $x \leftarrow x - q\,y$, the new entries are bounded by

$$\max\bigl(\text{bits}(x\text{'s row}),\ \text{bits}(q) + \text{bits}(y\text{'s row})\bigr) + 1.$$

If that bound passes $c$, the difference in reserved bytes is reserved
first and merged into the stage's one reservation. Growth then refuses as
an ordinary memory limit, and nothing is allocated unreserved.

A modular Hermite form (modulo a nonzero maximal minor) would make the
growth predictable. That is a later improvement; the budget doesn't need
it.

## What review found

Each of these was found by a reviewer before merging, and each now has a
test that fails without the fix:

1. **A carry past the bound.** The first bound was
   $\text{bits}(q) + \text{bits}(y) + 1$, which bounds the product but not
   the difference. An entry already at the bound, minus a short product,
   can carry one bit past it. That would have been a false internal error
   on a valid input. The witness is the rows $(1, -1)$ and $(2, 255)$:
   $255 - 2 \cdot (-1) = 257$ needs 9 bits, at a bound of 8.
2. **The subtraction's work.** The work charged for a row update covered
   the multiplications, but only one unit for the subtraction, which is
   linear in the limbs. The fix charges limb-based estimates for every
   step: size scans, copies, pivot comparisons, the pivot row's copy,
   sign changes and zero-row scans. A test stops the call at each charge
   in turn and checks that nothing is left reserved.
3. **A list's leftover capacity.** After the elimination drops zero rows,
   the list of rows still had room for all the input rows. With a
   thousand equal rows, 24,048 bytes stayed live against 144 reserved.
   The rows are now compacted while the larger reservation still covers
   them.
4. **"Exact" capacity by contract.** `Vec::shrink_to_fit` may leave spare
   capacity; that it doesn't with today's allocator is not a contract. The
   list now goes through a boxed slice, whose length is exact by type,
   and the capacity is checked, failing closed.
5. **A test that proved nothing.** One test took its baseline after
   building its input, so the difference it checked was negative whatever
   the code did. Its baseline now comes first.

One worry turned out to be unfounded. After a long elimination, could
the big integers keep buffers sized for their largest past value? In
Sagebrush's big-integer library (a fork of dashu), every stored value
keeps at most $\text{len} + \text{len}/4 + 4$ words, and the charge per
entry covers that. Making the library report its exact heap bytes, so
budgets can charge measured sizes, is the next step.

## What would have saved time

- **Measure before fixing a cap.** The measurement took minutes, and it
  replaced a design that would have refused real inputs.
- **Know your big-integer library.** One review round reasoned from
  another library's capacity rules. Reading the fork's buffer code
  settled it.
- **Compile-time line numbers are in the binary.** A comment-only edit
  changed the WebAssembly engine's hash, because panic locations embed
  line numbers. The engine pin must be rebuilt after any source edit.
