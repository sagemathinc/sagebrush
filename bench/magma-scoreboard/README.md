# Magma/FLINT speed scoreboard

This benchmark compares named Sagebrush workhorses with the locally installed Magma V2.18-5 and FLINT 3.6.0. Both are invoked only as black-box timing and answer oracles; the benchmark does not inspect either implementation's source.

The local profile is deliberately light: one subprocess at a time, one worker per subprocess, a timeout of at most 60 seconds, and an aggregate child-CPU budget of 30 minutes. It evaluates the small and medium points and records every large point as `pending VM`.

## Run locally

Build Sagebrush and create the native engine environment in the usual way, then run:

```sh
python3 bench/magma-scoreboard/run.py --profile local
```

Restrict a diagnostic run with repeatable `--only CASE_ID` arguments. `--dry-run` lists the exact point selection without invoking either engine.

Every point has a separate correctness pass before timing. The runner compares compact deterministic answer signatures and suppresses timing for any mismatch. Timings are arithmetic means over the repeat counts in `cases.json`; input construction, answer-signature conversion, and process startup are excluded. Output is written to `results.md`.

Big-integer cases use the built Sagebrush Python CLI (`node build/cli/pyjs.cjs`) because that is the user-facing integer path. Algebra, number theory, modular forms, and elliptic-curve cases use Sagebrush's native Python bindings in `engine/.venv`. Every path receives single-worker environment settings.

FLINT coverage reuses the bench-only `sagebrush-flint` Rust oracle from `bench/linalg` for integer polynomials and the integer matrix operations it exposes. The remaining integer, finite-field, rational-matrix, HNF, and Smith operations use `python-flint` 0.9.0 backed by FLINT 3.6.0. The adapters time only the operation call and convert the answer to a signature afterward. FLINT remains a benchmark dependency only and is never linked into a shipped Sagebrush package.

## Pending VM run

The large points must not run in the project. After the coordinator confirms that a Sagebrush test VM has been started, use the repository checkout on that VM:

```sh
python3 bench/magma-scoreboard/run.py --profile vm --host-label sagebrush --output bench/magma-scoreboard/results-vm.md
```

The VM profile runs only the large points marked `pending_vm`. It remains sequential and retains the per-subprocess timeout and aggregate CPU budget. Do not start it until the coordinator has allocated an exclusive timing window on the VM.

## Files

- `cases.json`: named workloads, sizes, repeats, importance ranking, timeout, and CPU budget.
- `sagebrush_bigint.py`: user-facing CLI integer workloads.
- `sagebrush_case.py`: native Sagebrush workloads and answer signatures.
- `magma_case.m`: clean-room Magma equivalents and answer signatures.
- `flint_case.py`: clean-room FLINT adapter for operations outside the Rust oracle's current surface.
- `flint-rust/`: bench-only adapter around the existing Rust FLINT oracle.
- `run.py`: sequential correctness/timing runner and Markdown report generator.
- `results.md`: checked local result.
