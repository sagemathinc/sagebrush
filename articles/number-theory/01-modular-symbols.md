<!-- description: How Sagebrush computes modular symbols, Hecke operators, proven characteristic polynomials over Z, all rational newforms to conductor 9999 and LMFDB's newspaces, checked against Cremona's tables and the LMFDB. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history and result notes (results/engine*.md, newforms.md, newspaces.md, general*.md) of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Modular symbols and newforms

*Code: `engine/modsym`. Sources: Cremona, "Algorithms for Modular Elliptic
Curves"; Stein, "Modular Forms: A Computational Approach"; Merel's Hecke
matrices; Cohen–Oesterlé dimension formulas; Atkin–Lehner–Li theory.*

## What is computed

The engine works with modular symbols for $\Gamma_0(N)$, in the sign $+1$
quotient. It computes:

- Hecke operators $T_q$, and their characteristic polynomials over
  $\mathbb{F}_p$ and, proven, over $\mathbb{Z}$;
- every rational newform of weight 2, with its $a_p$;
- for any weight $k \ge 2$ and any Dirichlet character: the newspace's
  Galois orbits of newforms, their trace forms, and LMFDB labels.

## The presentation

- **$\mathbb{P}^1(\mathbb{Z}/N)$ in $O(N d(N))$ memory**, with Sage's
  normalization and per-divisor tables. A first plain-Python version used
  an $N^2$ lookup table.
- **2-term relations** $x + x\sigma = 0$ by a *signed* union-find. With a
  character, the edges carry weights in $\mathbb{F}_\ell^\times$. An
  inconsistent cycle makes the whole class zero, which is how
  $\varepsilon(-1) \ne (-1)^k$ shows up.
- **3-term relations** by sparse elimination over $\mathbb{F}_p$.
- **$T_q$** from Cremona's Heilbronn matrices (Merel's for general weight),
  counted per generator and parallel over basis elements.

## The lesson of the dense coordinate table

The first engine stored every generator's coordinates in the quotient
basis: $O(m \cdot \dim)$ numbers. Measurement showed that after sparse
elimination in creation order, the relations keep about **2.0 nonzeros
per row at every level tried**. The dense table was 154× (at $N = 960$)
to 1764× (at $N = 9240$) larger than the information in it.

The engine now stores only the sparse relations. A functional extends to
all generators in $O(m)$, and Hecke matrices are assembled 64 columns at a
time. Peak memory at $N = 9240$ fell from 235 to 120 MB, and the $T_{17}$
split from 23 s to 3 s.

## Characteristic polynomials over $\mathbb{Z}$, proven

The characteristic polynomial is computed by CRT over primes below
$2^{31}$, under three rules:

- **Reject bad primes.** A prime whose space does not have the dimension
  predicted by the genus and cusp formulas is rejected.
- **A proven coefficient bound.** Cusp eigenvalues satisfy $|a| \le
  2\sqrt q$ (Deligne); Eisenstein eigenvalues are $\chi(q) + \psi(q) q$.
  The first prime gives the exact sum of the squares of the eigenvalues,
  and Jensen's inequality then gives $\prod (1 + |a_i|) \le (1 + r)^g$.
  This needs 24–25% fewer primes than the Deligne-only bound.
- **A final check.** The result is "proven" only if it is monic, $q + 1$
  is a root, and every coefficient is within the bound.

**The kernel.** The Hessenberg reduction mod $p$ did a 64-bit `%` in
every inner step. It now uses `u32` entries and Shoup multiplication (a
precomputed $\lfloor w 2^{32}/p \rfloor$), so the inner loops have no
division and vectorize. AVX2 is chosen at run time, at the leaf kernels,
because closures run by rayon do not inherit `#[target_feature]`. One
prime at $N = 10007$: 2501 ms became 276 ms.

Against Sage, one thread (before the sharper bound):

| $N$, $q$ | dim | Sage default | Sage, $\mathbb{Z}$ matrix + LinBox | Sagebrush, proven |
|---|---|---|---|---|
| 2310, 13 | 592 | 44.0 s | 12.6 s | 11.2 s |
| 5000, 3 | 754 | 113.4 s | | 14.5 s |
| 10007, 2 | 835 | 162.1 s | 121.9 s | 25.8 s |

LinBox stops early (heuristically), while ours proves its bound. With 8
threads and the sharper bound, $N = 10007$ takes 2.56 s.

**What did not work.** Interleaving 8 primes in one matrix of `[u32; 8]`
lanes was correct and used half the memory. It was also 1.5× slower below
dimension 1000, and only equal at 1668. The single-prime kernel was
already 8-wide across columns, so lanes did not reduce the bytes moved per
prime. Large dimensions are memory-bound (3.6 ns per element out of L3):
the fix there is a blocked charpoly, not more SIMD.

## Rational newforms: Cremona's tables from scratch

A rational newform has integer $a_q$ with $|a_q| \le 2\sqrt q$. So the
space is split only by those finitely many eigenvalues:

1. take the charpoly's integer roots for the first $T_q$, and kernels only
   for them;
2. refine prime by prime;
3. drop any subspace that the **known old part** explains: each newform of
   level $M \mid N$ occurs with multiplicity $d(N/M)$, memoized across
   levels;
4. a 1-dimensional joint eigenspace is new.

Then $a_p = \psi(T_p x)/\psi(x)$ for one functional $\psi$, one sum over
Heilbronn matrices per prime.

Results:

- **All 38,042 rational newforms of conductor 11–9999 match Cremona's
  tables.** That took 854 s on 16 threads.
- **Modularity cross-check:** 440,551 pairs (newform, $p$) agree with point
  counts on the curves, by the $a_p$ engine of the next article.

Against Magma 2.18 (`NewformDecomposition` of the cuspidal new subspace):

| workload | Magma | Sagebrush |
|---|---|---|
| $N = 5077$ | 3.82 s | 0.10 s |
| $N = 9240$ (dim 2336) | 855 s | 92 s on one thread, 18 s on 16 |
| all levels 11–2000, one core | 1039 s | 76.7 s (13.5×) |

Magma's route also decomposes the non-rational part, so this is not a
like-for-like comparison of algorithms. eclib (Cremona's own program) is
the honest benchmark, and has not been run yet.

## Any weight, any character: LMFDB's newspaces

Work modulo primes $\ell \equiv 1 \pmod{\exp(\mathbb{Z}/N)^\times}$, so
every character takes values in $\mathbb{F}_\ell$. For each level $M$
between the conductor of $\chi$ and $N$, and each conjugate character
$\chi^j$:

1. compute the charpoly of a combination $T = \sum r_i T_{q_i}$;
2. remove the Eisenstein eigenvalues $\psi(q) + \varphi(q) q^{k-1}$, which
   are enumerated, and whose count is checked against the formula for
   $\dim E_k$;
3. divide out the old forms $g^{\rm new}(M')^{\sigma_0(M/M')}$.

What remains is the new part. The product over conjugates, lifted by CRT,
is the charpoly over $\mathbb{Q}$ on the newspace. Its irreducible factors
are the Galois orbits.

The **choice of $T$** has to beat two things:

- **CM forms**, which vanish at inert primes: $T_2 + 3T_5$ is zero on
  63.2.e.a;
- **inner twists**, which fix $a_p$ wherever the twisting character is 1.

Candidates escalate from two primes, to primes generating $(\mathbb{Z}/N)^\times$,
to 8–16 primes; 26 spaces needed the later stages.

Results:

- **5533 of 5533 newspaces and 4843 of 4843 orbits** with $N k^2 \le 1000$
  agree with LMFDB. So do 15666 of 15666 newspaces with $N k^2 \le 2000$,
  which is every one up to $\mathbb{Q}$-dimension 2016; the 66 larger ones
  were skipped.
- The **trace forms to $n = 1000$** of all 4843 orbits match, which
  reproduces every LMFDB label from `11.2.a.a` to `227.2.c.a`.

**A convention the tests caught.** The character relation's direction
matters. With $\varepsilon$ replaced by $\varepsilon^{-1}$, 664 of 1452
validation spaces disagree with Sage. Testing against the oracle is what
pinned the convention.

## What would have saved time

- **Measure the fill-in before choosing a data structure.** "2.0
  nonzeros per row" should have been measured on day one; the dense table
  cost two rewrites.
- **Benchmark machines drift.** In the middle of one session a cloud VM
  became 3–5× slower on the same binary: a noisy neighbor thrashing the
  shared L3. A 4 MB cache-read probe now runs before every timing, and
  comparisons are made A/B in the same window.
- **Do the bookkeeping you can prove.** Old-part multiplicities and
  Eisenstein counts are known exactly. Using them to skip work, and to
  check it, did more than any kernel optimization.
