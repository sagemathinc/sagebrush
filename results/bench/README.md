# sagebrush bench runs

The runs behind the performance claims in the top-level README,
[engine/classgroup/README.md](../../engine/classgroup/README.md) and
[bench/linalg/README.md](../../bench/linalg/README.md). `sagebrush bench`
is the Python package's command (`pip install sagebrush`; `sagebrush bench
--help`). Each JSON file holds the host description and every sample of
every engine for every case. Render one as tables with
`sagebrush bench --markdown FILE.json`.

All were run on Oct 18 2026 on one core of an AMD EPYC 7B13 (a 48-core
Linux VM, otherwise idle: load average about 1, the benchmark's own core,
at the start and end of each run), at commit 7658b274 (the FLINT reruns at
c7eea749), CPython 3.14.8.

| file | what | wall time |
|---|---|---:|
| [2026-10-18-standard.json](2026-10-18-standard.json) | every suite, quick and standard tiers (`--tiers=quick,standard`); the Sage columns failed to start here (conda-forge's `sage` has no `-python`) and were rerun in the next file | 16 min |
| [2026-10-18-standard-sage.json](2026-10-18-standard-sage.json) | `sagelayer` and `charpoly`, quick and standard tiers, with Sage | 25 s |
| [2026-10-18-large.json](2026-10-18-large.json) | every suite, large tier (`--tiers=large --timeout 1800`) | 31 min |
| [2026-10-18-linalg-rerun.json](2026-10-18-linalg-rerun.json) | `linalg`, quick and standard tiers, rerun at c7eea749, whose FLINT harness fingerprints the answer after the timing (at 7658b274 the first and last call of a case included it); supersedes the `linalg` suite of the standard run | 1.3 min |
| [2026-10-18-rust-flint.txt](2026-10-18-rust-flint.txt) | the Rust engine against FLINT directly: `cargo run --release -p sagebrush-oracle --example matbench -- 10 30 100` and `--example polybench`, at c7eea749, where only FLINT's call is timed (at 7658b274 its results' conversion to BigInt was timed with it) | 1 min |

Competitors, each run as its own process and used as a black box:
PARI/GP 2.17.1 (`gp`), FLINT 3.6.0 (through `flint_harness.c`, compiled
against it), and SageMath 10.9 from conda-forge. smalljac was not installed,
so the `ap` suite checks Sagebrush's count at 10^8 against the one recorded
from smalljac in [results/ap.md](../ap.md).

Every answer agreed across the engines in every case. Every default
(certified) call of the class group suites came back certified.

The inputs are fixed and committed with the package
(`engine/py/python/sagebrush/bench/data`): the quadratic discriminants
(`make_quad.py`) and the 30 number fields (`make_nf.py`, seed 20261018).
