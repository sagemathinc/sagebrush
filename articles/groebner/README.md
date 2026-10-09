<!-- description: How Sagebrush's permissively licensed (MIT/Apache) multivariate polynomial engine was built from the literature: F4, Gröbner bases over Q, proofs, FGLM, gcd and factoring, and how close it comes to the fastest implementations. -->
# Gröbner bases and multivariate polynomials, MIT-licensed: how they were built

Sagebrush's multivariate polynomial engine (`engine/mpoly`, with the
linear algebra in `engine/arith`) is written from the literature and
licensed MIT OR Apache-2.0.

As far as we know, it is the only permissively licensed implementation of
Faugère's F4 algorithm in the class of Magma and msolve:

- every open-source system of comparable strength is under the GPL:
  Singular, Macaulay2, CoCoA, Giac, msolve and Groebner.jl;
- the fastest ones, Magma, Maple and FGb, are closed.

A permissive license means anyone can build on this code: companies,
other open-source projects under any license, and AI tools.

These articles describe the engine algorithm by algorithm:

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

- **Independent code.** Sagebrush shares no code with the systems it is
  compared with, not even GMP or FLINT, so agreement with them is evidence
  from two independent implementations. See
  [what is shared](/articles/#independent).
- **Clean-room.** Every algorithm comes from papers. Singular, Sage 10.10,
  Magma 2.18 and msolve 0.9.4 were used only as binary oracles: to compare
  answers and timings, and in Magma's case to read its verbose output. No
  GPL source (Singular, msolve, Giac, Groebner.jl, Sage) was read.
- **Oracle-tested.** Random ideals and polynomials are compared with
  Singular. Every docstring example also runs in a Sage 10.10 built from
  source, and must print the same.
- **Measured.** Every claim of speed below was measured on one machine:
  16 cores, x86-64 with AVX2. "1 thread" means `SAGEBRUSH_THREADS=1`.

## Is it fast enough to choose?

**Short answer:** yes for most uses.

- **One core, over $\mathbb{Q}$ and for lex bases:** Sagebrush takes about
  1.4–2.3× the time of the fastest implementation we could measure.
- **One core, modulo a prime:** about 2–5×. That gap is known (symbolic
  preprocessing and matrix building) and is the next piece of work.
- **All cores:** Sagebrush threads natively, and over $\mathbb{Q}$ it then
  finishes before that single-core reference.
- **Proven results over $\mathbb{Q}$ by default**, as Sage expects.

So choosing Sagebrush does not mean waiting 10× longer than with the best
commercial system. On many problems it means waiting less.

Each row compares Sagebrush with the fastest time we measured for that
problem, from any system:

| problem | Sagebrush, 1 core | Sagebrush, 16 cores | best measured, 1 core | ratio, 1 core | ratio, 16 cores |
|---|---|---|---|---|---|
| katsura-10 mod p | 3.19 s | 1.60 s | 0.6–0.9 s | 3.7–5.0× | 1.9–2.5× |
| cyclic-8 mod p | 4.76 s | 2.84 s | 0.9–1.2 s | 3.9–5.2× | 2.3–3.1× |
| katsura-8 over $\mathbb{Q}$ | 0.71 s | 0.28 s | 0.37 s | 1.9× | 0.8× |
| cyclic-7 over $\mathbb{Q}$ | 0.75 s | 0.38 s | 0.4–0.5 s | 1.6–2.1× | 0.8–1.1× |
| katsura-9 over $\mathbb{Q}$ | 5.77 s | 1.54 s | 2.5 s | 2.3× | 0.6× |
| katsura-9 lex mod p | 0.74 s | 0.58 s | 0.3–0.4 s | 2.1–2.8× | 1.6–2.2× |
| cyclic-7 lex mod p | 0.26 s | 0.25 s | 0.39 s | 0.7× | 0.6× |
| katsura-6 lex over $\mathbb{Q}$ | 1.17 s | 0.34 s | 0.6–0.8 s | 1.5–1.9× | 0.4–0.6× |
| katsura-7 lex over $\mathbb{Q}$ | 31.4 s | 7.1 s | 17–22 s | 1.4–1.9× | 0.3–0.4× |

The Sagebrush times over $\mathbb{Q}$ here skip the final proof
(`proof.polynomial(False)`), as the reference appears to. With the proof
(the default), the 16-core times are 0.63 s for katsura-8, 0.68 s for
cyclic-7 and 4.19 s for katsura-9; see article 4.

### How we measure

- **"Best measured"** is the fastest single-core time among Magma 2.29,
  Magma 2.18, msolve 0.9.4 and Singular. In every row it was Magma, 2.29 or
  2.18. Over $\mathbb{Q}$, Magma 2.18 was the faster of the two Magmas on
  katsura-8 and katsura-9.
- **Magma 2.29 ran on its online calculator**, not on our machine. Its
  times are scaled to our machine by a calibration block in the same
  script: big-integer arithmetic and an interpreter loop, which disagree
  slightly (factors 1.6 and 2.1). Hence the ranges.
- **Everything else ran on one machine:** 16 cores, x86-64 with AVX2.
  Repeated runs vary by up to about 1.5×.
- **Reproduce:** the Magma scripts are `bench/groebner/magma_online_1.m`
  and `_2.m`; the Sagebrush script is `bench/groebner/sagebrush_bench.sage`.

### Direct measurements

These are the raw, named numbers that the ratios above come from, for
anyone who needs a direct comparison. In seconds:

| problem | Sagebrush 1 / 16 cores | Magma 2.29 (normalized) | Magma 2.18 | msolve 0.9.4, 1 / 16 | Singular `std` |
|---|---|---|---|---|---|
| katsura-10 mod p | 3.19 / 1.60 | 0.64–0.85 | 2.81 | 2.40 / 0.90 | 44 |
| cyclic-8 mod p | 4.76 / 2.84 | 0.92–1.22 | 2.22 | 1.9 / 1.2 | 23.5 |
| katsura-8 over $\mathbb{Q}$ | 0.71 / 0.28 | 0.49–0.65 | 0.37 | | 4.9 |
| katsura-9 over $\mathbb{Q}$ | 5.77 / 1.54 | 3.2–4.2 | 2.53 | | 89 |
| cyclic-7 over $\mathbb{Q}$ | 0.75 / 0.38 | 0.35–0.46 | 0.55 | | over 30 min |
| katsura-9 lex mod p | 0.74 / 0.58 | 0.27–0.35 | 1.49 | | |
| cyclic-7 lex mod p | 0.26 / 0.25 | 0.92–1.23 | 0.39 | | |
| katsura-7 lex over $\mathbb{Q}$ | 31.4 / 7.1 | 17–22 | 27.8 | | 109 (`std` + `fglm`) |

Singular's times are for exact (proven) computations; msolve's are modulo
$p$ only.

## The lessons that recur

1. **Measure before optimizing.** Several "obvious" speedups lost:
   probabilistic elimination, fixed-width integer accumulators, a dense
   accumulator in place of an ordered map. Each mistaken assumption was
   about where the time went.
2. **Measure the sizes of the numbers you will reconstruct before choosing
   a certificate.** Normal forms were 1.7× the basis's size; quotients
   were 3.6×. That one measurement decided the design of the proof.
3. **The oracle's verbose output is a design document you get for nothing.** Magma's
   `SetVerbose("Groebner", 1)` showed, step by step, the moduli and matrix
   sizes of a computation over $\mathbb{Q}$. That one printout redirected
   a day of work.
4. **The data layout limits the algorithms.** Packed 64-bit exponent words
   make F4 fast. They also cap lex bases at degree $2^{\lfloor 64/n
   \rfloor - 1}$ (64 in 9 variables), far below what FGLM produces.
5. **WebAssembly has no clock.** `std::time::Instant::now()` traps there.
   Every timing must sit behind the debug flag. This bit twice.
