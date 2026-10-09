<!-- description: How Sagebrush's MIT-licensed number theory engines were built: modular symbols and newforms, traces of Frobenius, Galois groups of polynomials, and class groups, measured against Magma, Sage, PARI and smalljac. -->
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

## Ground rules

- **Clean-room.** Papers and books only. PARI, Sage, Magma, GAP and
  smalljac were used as binary oracles and benchmarks; their sources were
  not read.
- **Checked against independent data.** Examples: Cremona's tables, the
  LMFDB, Magma's transitive group database, PARI's `quadclassunit` and
  `bnfinit`, and smalljac's output.
- **Proven where it says so.** Each engine reports when a result rests on
  an unproven step, such as GRH for class groups or a large-index
  resolvent for Galois groups.
