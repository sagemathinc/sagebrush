<!-- description: How Sagebrush's MIT-licensed number theory engines were built: modular symbols and newforms, traces of Frobenius, Galois groups of polynomials, and class groups, checked against Cremona's tables, the LMFDB and established systems. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code, commit history and result notes of the Sagebrush project, led by William Stein (SageMath, Inc.). Every number below comes from those notes and commits; corrections are welcome on GitHub. -->
# Number theory engines, MIT-licensed: how they were built

Sagebrush's number theory engines are Rust crates, written from the
literature and licensed MIT OR Apache-2.0. They run natively, in threads,
and in the browser as WebAssembly.

Systems that already do these computations are under the GPL (Sage, PARI,
GAP, eclib, smalljac) or closed (Magma). A permissively licensed set of
engines at this level is rare. These articles explain how each one works,
what was checked against what, and what went wrong on the way.

1. [Modular symbols and newforms](01-modular-symbols.md): Hecke operators,
   proven characteristic polynomials over $\mathbb{Z}$, Cremona's tables to
   conductor 9999, and LMFDB's newspaces recomputed.
2. [Traces of Frobenius](02-traces-of-frobenius.md): $a_p$ of an elliptic
   curve for all primes up to $10^8$, smalljac's strategy written from
   scratch.
3. [Galois groups of polynomials](03-galois-groups.md): permutation groups,
   transitive groups generated from scratch, and Stauduhar's descent with
   $p$-adic roots.
4. [Class groups](04-class-groups.md): imaginary and real quadratic fields
   by Jacobson's sieve, and general number fields by Buchmann's method with
   a field-specific GRH bound.

## Is it fast enough to choose?

**Short answer:** yes. On one core, every engine here is within about 2× of
the reference we measured it against, or faster, with two exceptions that
are small in absolute terms.

| engine | reference (one core) | Sagebrush, one core |
|---|---|---|
| modular symbols: proven $T_q$ charpolys | Sage 10, default path and LinBox | 1.1–7.8× faster |
| rational newforms, all levels to 2000 | Magma 2.18 | faster (13.5×); a current Magma is surely faster than 2.18 |
| traces of Frobenius to $10^7$–$10^8$ | smalljac 4.1.3 | 1.2–1.6× slower; on 16 threads, from 1.3× faster to 1.4× slower |
| Galois groups, degree 12 | Magma 2.18 | faster (2.2×) |
| imaginary quadratic class groups | PARI 2.17 | 2.3× slower at $\lvert D \rvert \approx 10^9$ (milliseconds); equal at $10^{17}$; faster beyond |
| class groups of cubic and quartic fields | PARI 2.17 | cubics faster from $\lvert d \rvert \approx 10^{25}$; quartics 1–4× slower |

Most engines also run in parallel, and all of them run in the browser as
WebAssembly, at roughly 1.3–4× the native single-core time. The articles
give the full measurements: versions, machines and caveats. Where the only
reference available was an old version (Magma 2.18, from 2012), the
article says so.

## Ground rules

- **Independent code.** Sagebrush shares no code with the systems it is
  compared with, not even GMP or FLINT, so agreement with them is evidence
  from two independent implementations. See
  [what is shared](/articles/#independent).
- **Clean-room.** Papers and books only. PARI, Sage, Magma, GAP and
  smalljac were used as binary oracles and benchmarks; their sources were
  not read.
- **Checked against independent data.** Examples: Cremona's tables, the
  LMFDB, Magma's transitive group database, PARI's `quadclassunit` and
  `bnfinit`, and smalljac's output.
- **Proven where it says so.** Each engine reports when a result rests on
  an unproven step, such as GRH for class groups or a large-index
  resolvent for Galois groups.
