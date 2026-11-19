<!-- description: How each LLL call in Sagebrush chooses between L^2 and the exact LLL: by comparing whole memory peaks before anything runs, with typed fallbacks, van Hoeij's cut, and a WebAssembly clock trap native tests could not see. -->
# Choosing the route

*Paper: van Hoeij, "Factoring polynomials and the knapsack problem"
(2002).*

## The problem

There are two reducers:

- L^2 (article 2), usually much faster;
- the exact LLL (article 1), always correct, but with numbers about $d$
  times longer.

Every call runs under a budget. By default it limits memory: in the
browser, to the share of the tab's memory the user's computation may
use. Work is unlimited unless a caller sets a limit.
So the choice is not only which reducer is faster. It is also:

- which reducer fits;
- what happens when the chosen one stops halfway.

## Decide before running, by the whole peak

`l2_route` decides before L^2 runs, never by retrying after a refusal.
It compares two whole peaks:

- **L^2's route:** the caller's rows held, plus L^2's state, plus (for
  van Hoeij) the kept rows and the cut's state.
- **The exact route:** the caller's rows held, plus the exact LLL's state.

L^2 is chosen only when its whole peak is at most the exact LLL's. That
is the rule that makes the switch safe: **a memory limit that admits the
exact LLL also admits L^2**. Moving a caller to L^2 can't turn a
computation that used to fit into a refusal. Every term is computed in
checked arithmetic, and one that overflows means the exact LLL, whose own
terms then refuse as before.

Two shapes go to the exact LLL:

- **wide rows with few rows**, such as the identity with a column of
  $10^{60}$-sized entries: L^2's floating-point state is larger than the
  exact LLL's;
- **anything too large to size** in 64 bits.

## When L^2 stops

L^2 runs with an entry cap of $e + d + 64$ bits. This is a heuristic,
not a bound: the reductions measured needed at most $e + 11$ bits for
$d \le 120$. L^2 can stop for these reasons:

| stop | what happens |
|---|---|
| an entry past the cap (`Bits`) | its state is released; the exact LLL starts over from the original rows |
| the result could not be proved (`Precision`) | the same |
| the work limit | the call ends: a refusal |
| memory, an interrupt, dependent rows, an internal error | the call ends |

Only the first two fall back, and they are typed: `L2Err::Fallback` and
`L2Err::Refused` are different types, so a work refusal cannot become a
fallback by accident. Falling back after the work limit would spend the
limit twice.

## van Hoeij's cut

To factor a polynomial over $\mathbb{Z}$, van Hoeij's algorithm reduces
a knapsack-like lattice. It then drops the trailing rows whose
Gram–Schmidt norm exceeds a bound $t$: no lattice vector of norm at most
$t$ uses them, whatever the basis.

`cut` decides each comparison $|b^*_{s-1}|^2 > t$ with 53-bit
intervals. If that can't decide, it uses $p$-bit ones ($p = 48 + d$, then
$96 + 2d$), and then exact arithmetic, $d_s > t\, d_{s-1}$. Each stage
reserves its memory and debits its work before it runs. The van Hoeij
route's peak includes the cut's own state, which is why it has its own
`l2_route`, separate from `reduce`'s.

## A trap only the browser could see

The first version of the factoring route passed every native test and
failed in the WebAssembly engine, the one the browser runs: factoring a
Swinnerton-Dyer polynomial stopped with `unreachable`, with no message.

The cause: `std::time::Instant::now()` *panics* on
`wasm32-unknown-unknown`, which has no clock. L^2's report timed its
rungs for the benchmarks, and the production build called the clock too.

The fix:

- a `clock` module that reads the time only in tests and benchmark
  builds, and returns 0 everywhere else;
- a test that scans the production source for any other clock call;
- a WebAssembly test that runs the
  real engine on the lattices L^2 handles, so this class of bug fails in
  CI, not in a user's tab.

## What would have saved time

- **State the admission rule first.** "A limit that admits the old route
  admits the new one" settled every routing question. Before it was
  written down, each caller's switch was argued case by case.
- **Test the real WebAssembly engine early.** Native tests can't see
  missing platform APIs.
- **Type the stops.** The fallback paths were the hardest to test.
  Making "fall back" and "stop" different types moved one class of
  mistake to compile time.
