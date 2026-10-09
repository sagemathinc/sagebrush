<!-- description: How Sagebrush's free multivariate polynomial engine was built from the literature: F4, Gröbner bases over Q, proofs, FGLM, gcd and factoring, with benchmarks against Magma, msolve and Singular. -->
# Free multivariate polynomial algebra: how it was built

Sagebrush's multivariate polynomial engine (`engine/mpoly`, with the
linear algebra in `engine/arith`) is written from the literature, MIT OR
Apache-2.0 licensed. These articles describe it algorithm by algorithm:

- how each one is implemented, top to bottom;
- what worked and what did not, and why;
- what would have saved time.

They were written right after the implementations, while the dead ends
were still fresh. The dead ends are what papers usually leave out.

1. [Sparse elimination modulo p](01-sparse-elimination.md): the matrix
   kernel under F4, the Faugère–Lachartre layout, and why random linear
   combinations did not help.
2. [F4 over finite fields](02-f4.md): pair selection, symbolic
   preprocessing, lex orders through homogenization, and a signature-based
   F4 that is correct but slower.
3. [Gröbner bases over the rationals](03-groebner-over-q.md): from "one F4
   per prime" to one F4 run over $\mathbb{Q}$ whose matrices are reduced
   modulo primes.
4. [Proving a Gröbner basis over the rationals](04-proving.md): Arnold's
   theorem, a certificate from eliminations modulo primes, and Sage's proof
   flags.
5. [FGLM: changing the order](05-fglm.md): lex bases of zero-dimensional
   ideals, and exponents too big for a machine word.
6. [Multivariate gcd and factorization](06-gcd-and-factoring.md): Brown,
   Wang's EEZ, and finite fields, where Hilbert irreducibility fails.

## Ground rules

- **Clean-room.** Every algorithm comes from papers. Singular, Sage 10.10,
  Magma 2.18 and msolve 0.9.4 were used only as binary oracles: to compare
  answers and timings, and in Magma's case to read its verbose output. No
  GPL source (Singular, msolve, Giac, Groebner.jl, Sage) was read.
- **Oracle-tested.** Random ideals and polynomials are compared with
  Singular. Every docstring example also runs in a Sage 10.10 built from
  source, and must print the same.
- **Measured.** Every claim of speed below was measured on one machine:
  16 cores, x86-64 with AVX2. "1 thread" means `SAGEBRUSH_THREADS=1`.

## Where things stand (October 2026)

Reduced degrevlex bases modulo 32003, in seconds:

| ideal | Sagebrush, 1 thread / 16 threads | Magma 2.18 (1 thread) | msolve 0.9.4, 1 / 16 | Singular `std` |
|---|---|---|---|---|
| katsura-10 | 3.1 / 1.5 | 2.8 | 2.4 / 0.9 | 44 |
| katsura-11 | 24 / 8.5 | 21 | 18 / 4.6 | 601 |
| cyclic-8 | 4.8 / 2.8 | 2.2 | 1.9 / 1.2 | 23.5 |

Over $\mathbb{Q}$, in seconds. The proven result is Sage's default; it is
Magma's semantics that we cannot tell (see article 4).

| ideal | without proof, 16 / 1 | with proof, 16 / 1 | Magma | Singular |
|---|---|---|---|---|
| katsura-8 | 0.39 / 0.55 | 0.66 / 4.0 | 0.37 | 4.9 |
| katsura-9 | 2.4 / 3.9 | 4.1 / 43 | 2.4 | 89 |
| cyclic-7 | 0.61 / 0.80 | 0.72 / 2.8 | 0.57 | over 30 min |

Lex bases, in seconds:

| ideal | Sagebrush, 16 / 1 | Magma | Singular |
|---|---|---|---|
| katsura-9 mod 32003 | 0.63 / 0.79 | 1.49 | |
| katsura-7 over $\mathbb{Q}$, without proof | 7.6 / 31 | 27.4 | |
| katsura-7 over $\mathbb{Q}$, with proof | 64 (16 threads) | | over 600 (`std` in lex), 109 (`std` + `fglm`) |

## The lessons that recur

1. **Measure before optimizing.** Several "obvious" speedups lost:
   probabilistic elimination, fixed-width integer accumulators, a dense
   accumulator in place of an ordered map. Each mistaken assumption was
   about where the time went.
2. **Measure the sizes of the numbers you will reconstruct before choosing
   a certificate.** Normal forms were 1.7× the basis's size; quotients
   were 3.6×. That one measurement decided the design of the proof.
3. **The oracle's verbose output is a free design document.** Magma's
   `SetVerbose("Groebner", 1)` showed, step by step, the moduli and matrix
   sizes of a computation over $\mathbb{Q}$. That one printout redirected
   a day of work.
4. **The data layout limits the algorithms.** Packed 64-bit exponent words
   make F4 fast. They also cap lex bases at degree $2^{\lfloor 64/n
   \rfloor - 1}$ (64 in 9 variables), far below what FGLM produces.
5. **WebAssembly has no clock.** `std::time::Instant::now()` traps there.
   Every timing must sit behind the debug flag. This bit twice.
