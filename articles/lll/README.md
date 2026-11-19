<!-- description: How Sagebrush's permissively licensed (MIT/Apache) lattice reduction was built from the literature: an exact LLL and its certificate, a floating-point L^2 whose output is proved, at 1.7x FLINT's time (geometric mean over the 77 completed comparisons of a benchmark corpus), how a call picks its route, and a memory and work budget for the whole call. -->
# Lattice reduction, MIT-licensed: how it was built

Sagebrush's lattice reduction is written from the literature and
licensed MIT OR Apache-2.0. It is what `matrix.LLL()` runs in Sage mode,
and `LLL` in Magma mode. The number fields use it to reduce orders, and
polynomial factoring uses it to recombine factors (van Hoeij's
algorithm).

Every output is proved to be an $(\eta, \delta) = (0.51, 0.99)$-reduced
basis of the input's lattice, not just a basis that is very likely
reduced. On a corpus of 77 standard lattices, it takes on average 1.7x
the time of FLINT's LLL (which also checks its result with a certified
test) and 1.45x that of fplll.

The widely used open-source reducers, FLINT and fplll, are under the
LGPL, and Magma's is closed. A permissive license means anyone can build
on this code: companies, other open-source projects under any license,
and AI tools.

These articles describe it piece by piece:

- how each piece is implemented, top to bottom;
- what worked and what did not, and why;
- what would have saved time.

They were written right after the implementations, while the dead ends
were still fresh.

1. [The exact LLL and its certificate](01-exact-and-certificate.md): the
   integral LLL that everything falls back to, and an exact check that a
   basis is reduced and spans the right lattice.
2. [L^2: 1.7x FLINT on the benchmark corpus](02-l2.md): Nguyen and
   Stehlé's algorithm, a ladder of precisions, and the two hours from 15x
   slower than FLINT to 1.7x.
3. [Proving the output](03-proving.md): interval arithmetic on the Gram
   matrix, from 53 bits up to exact, and why the proof costs little.
4. [Choosing the route](04-routing.md): when L^2 runs and when the exact
   LLL does, decided by memory before anything runs, and a WebAssembly
   trap that native tests could not see.
5. [A budget for the whole call](05-budget.md): a rank modulo a prime, a
   Hermite form whose entries grow far past the Hadamard bound, and the
   bugs that review found.
6. [Next](06-next.md): faster algorithms for large entries (flatter,
   BLASter) and several cores.

## Is it fast enough to choose?

**Short answer:** yes for most uses.

- **One core:** Sagebrush takes on average 1.7x the time of FLINT and
  1.45x the time of fplll. It is within 2x of FLINT on 54 of the 77
  cases.
- **Faster than FLINT** on uniform lattices with 1000-bit entries:
  0.45 to 0.64x at every dimension.
- **Every result proved reduced.** The proof is included in Sagebrush's
  times. FLINT's LLL also checks its result with a certified test, so
  the comparison with FLINT is like for like.
- **The worst gaps** are about 2.8x, in two places:
  - knapsack lattices with 1000-bit entries at $d = 200$, where
    compression (article 6) is the planned fix;
  - uniform lattices with small entries at $d = 200$, where the proof
    is up to 44% of the time (article 3).

Measured on an idle n2-standard-8 cloud machine, one pinned core, on 77
lattices from five families (details and tables in article 2):

| family | cases | Sagebrush / FLINT | Sagebrush / fplll |
|---|---:|---:|---:|
| knapsack | 18 | 1.97 | 1.16 |
| Goldstein–Mayer | 18 | 1.77 | 1.30 |
| NTRU | 12 | 1.67 | 2.16 |
| uniform | 18 | 1.41 | 1.22 |
| Ajtai | 11 | 1.83 | 2.11 |
| all | 77 | 1.71 | 1.45 |

(Geometric means. The corpus has dimensions 10 to 200.)

## Ground rules

- **Independent code.** Sagebrush shares no code with the systems it is
  compared with, not even GMP or FLINT, so agreement with them is strong
  evidence from two independent implementations (not a guarantee: shared
  algorithms, assumptions or reference data can still produce correlated
  mistakes). See [what is shared](/articles/#independent).
- **Clean-room.** Every algorithm comes from papers:
  - Lenstra, Lenstra and Lovász (1982);
  - the integral LLL in Cohen's *A Course in Computational Algebraic
    Number Theory* (Algorithm 2.6.7);
  - Nguyen and Stehlé, "An LLL algorithm with quadratic complexity"
    (2009), and Stehlé's surveys;
  - Muller and Rideau (2022) for double-word error bounds.

  FLINT's public documentation was read. FLINT, fplll and SageMath were
  used only as binary oracles, to compare answers and timings; no code
  from them was read.
- **Proved, then checked again.** The reducer proves every output itself.
  In the tests and the benchmarks, a separate exact certifier (article 1)
  checks every output again.
- **Measured.** The published timings are from one run on an idle
  Google Cloud n2-standard-8 machine: one pinned core, all at
  $\eta = 0.51$, $\delta = 0.99$. FLINT was called through python-flint
  0.9.0 (`fmpz_mat.lll`) and fplll through fpylll 0.6.4, taking the best
  of up to 3 runs. The development timeline in article 2 comes from
  earlier runs on a busy shared machine.

## Different from SageMath, on purpose

A lattice has many LLL-reduced bases, so `matrix.LLL()` in Sagebrush can
return a different basis from SageMath's for the same matrix. Both are
reduced bases of the same lattice. Sagebrush is inspired by Sage, not a
clone of it, and it reduces with its own algorithm.
