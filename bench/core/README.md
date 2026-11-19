# Core-algorithm harness

This harness times Sagebrush's core algorithms against the best available software, on fixed inputs, after checking every answer. Each row is a named operation at three sizes, tied to an item of the progress board's "Math: core algorithms" page. `items.json` lists all 38 entries: the board's 37 items, which rows cover them, and what each unlocks, plus `int` for the big-integer rows below the list.

The finish line for an item is our native engine within $2\times$ of the best reference on the same machine, for most inputs. This replaces `bench/magma-scoreboard`: the same 29 cases with the same inputs and answer signatures, plus a native column, input checks, adaptive timing and one JSON file per point. Its October tables are kept in `results/history/`.

## Backends

| backend | driver | what it measures |
|---|---|---|
| user | `drivers/sagebrush_case.py` in `engine/.venv` (Sage mode); `drivers/sagebrush_bigint.py` under `build/cli/pyjs.cjs` for the big-integer rows | what users get. The big-integer rows run in WebAssembly |
| native | `native/`: a bench-only Rust binary that calls the engine's routines directly | the engine itself, without the Sage layer or the request wire |
| native-host | the same binary built with `-C target-cpu=native` (in `native/target-host`) | headroom only: what this CPU's SIMD would give. It never counts toward the $2\times$ rule until the engine dispatches on CPU features at run time |
| wasm | the same crate built for `wasm32-wasip1`, run under Node's WASI by `drivers/wasi_run.mjs` | the engine as WebAssembly. Same toolchain, release profile and default target features as the product's `wasm32-unknown-unknown` build (`scripts/build-engine.mjs`), and like it without the `parallel` feature. Only the target differs: WASI gives the driver its arguments, a clock and stdout, which the product's host provides in its own way |
| magma | `drivers/magma_case.m`, run by `/usr/local/bin/magma` | Magma V2.18-5, a black-box reference |
| flint | `flint-rust/` (Rust bindings) where it covers the operation, else `drivers/flint_case.py` (python-flint 0.9.0) | FLINT 3.6, a black-box reference |
| native-n, flint-n | native and flint on $N$ threads (`--threads`, default the CPU count) | the parallel speed of each. Magma V2.18 runs on one thread |

- The gap between user and native shows a *routing* cost: the Sage layer and the wire. The gap between native and the best reference shows an *algorithm* cost.
- Rows without a native driver show no native ratio.
- Each point records which adapter each backend used.
- Magma and FLINT are references only. They are run as programs and through their public interfaces, never read, and never linked into anything Sagebrush ships. The same holds for `native/` and `flint-rust/`: each is its own Cargo workspace (`[workspace]` in its `Cargo.toml`), outside `engine/`. So neither is a member of the engine's workspace, and no shipped build or wasm pin includes them.
- `native/` is built with the engine's pinned toolchain (`engine/rust-toolchain.toml`) and default flags, which is the code we ship. Its `Cargo.lock` starts from `engine/Cargo.lock`.
- Natively, `native/` enables `sagebrush-par/parallel`, as every shipped native build does (the Python wheel, the Node addon, the CLI). The 1-thread columns set `RAYON_NUM_THREADS=1` and the -n columns $N$. Today only a few of the engine routines these rows call run in parallel, so most rows show no gain from threads yet.
- Ratios:
  - **1-thread:** user, native, native-host and wasm, each against the faster 1-thread reference (Magma or FLINT).
  - **best/best** (the $2\times$ rule's): our faster of native and native-n against the fastest of Magma, flint and flint-n.
- The Rust FLINT oracle needs a static FLINT 3 build at `SAGEBRUSH_FLINT_PREFIX` (see `engine/flint/build.rs`).

## The protocol

Every driver is invoked as `DRIVER ROW N MODE K` and prints one line (`drivers/common.py`).

$K$ is the number of input variants. No point is timed on one input repeated, which can flatter a path by $3\times$ (warm caches, branch history, one lucky shape):
- Each variant has the same shape and size, from its own seed: salts $+6v$, matrix nodes $+v$, the factor product's constant terms $+v$, and the big integers $+v \cdot 1000003$ and $+v \cdot 998244353$.
- Variant 0 is the row's reference input, the old scoreboard's.
- $K = 8$ by default (`run.py`'s `DEFAULT_VARIANTS`).
- A row with one named input ($x^n - 1$, Cyclic-$n$, a fixed discriminant, level or curve) has `"variants": 1` in `items.json`, with its reason. So does a size whose single operation takes minutes.

The modes:
- `inputs`: `INPUTS|hash`, the hash of the $K$ variants' operand hashes (polynomial coefficients, matrix entries, residues of rationals modulo $10^9+7$; for ideals, the sorted degrees and term counts of the generators).
- `once`: `RESULT|seconds|signature`, variant 0 run once, and a compact signature of the answer.
- `time`: `TIME|median|signature|min|max|reps|samples`.
  - First every variant is built and run once, untimed. This is the warm-up, and its answers make the signature: `K:hash`, the hash of the $K$ signatures joined by `;`.
  - The timed repetitions then cycle through the variants.
  - Repetitions are calibrated until a sample takes at least 0.2 s. Then 5 samples are taken, or 3 when one operation takes over 2 s.
  - Times are seconds per operation.
- `time-fresh`: the same, but each repetition gets a freshly built input (of its variant) outside the timed region. It is used for rows whose objects cache answers: Gröbner bases, class groups, Galois groups and modular symbols.

Input construction, signature conversion and process startup are never timed.

## A point, step by step

For each row and size, `run.py`:

1. Asks every backend present for its input hash. If they differ, the point is an `input mismatch` and nothing is timed.
2. Runs each backend once on variant 0 and compares the signatures. If they differ, the point is a `mismatch` and nothing is timed.
3. Times each backend over the $K$ variants. Their combined signatures must agree, which checks every variant's answer.
4. Writes `results/<date>/<host label>/rows/<row>-<size>.json` (atomically: a temporary file, then a rename).

Each point's JSON holds:
- the machine: label, CPU model, architecture, SIMD flags, CPU count;
- the commit, and whether `engine/` or `bench/core/` had uncommitted changes;
- $K$, the number of input variants;
- the input hash;
- per backend: the adapter, and the time, signature, peak resident memory, wall and CPU time of each subprocess;
- the best reference, and the user and native ratios.

`summary.md` collects the points. A rerun skips the points already complete for the same commit, protocol and host label.

Every subprocess runs:
- alone;
- in its own process group, with one thread (`SAGEBRUSH_THREADS`, `RAYON_NUM_THREADS`, `BENCH_THREADS` and the BLAS/OpenMP equivalents), or $N$ for the -n backends;
- in its own cgroup with a memory cap (below);
- under the row's wall timeout from `items.json`: the group gets TERM, then KILL 5 s later;
- with whatever the child leaves in its group and in its cgroup killed after it exits. If the runner is interrupted, the same happens before the interruption propagates.

Its peak resident memory comes from `wait4`, and the whole cgroup's peak from `memory.peak`.

## Memory caps

By default every subprocess gets its own cgroup v2 directory, a sibling of the runner's:
- `memory.max` is the cap: the machine's memory less a reserve of $\max(2\text{ GiB}, 10\%)$, or `--mem-cap BYTES`;
- `memory.swap.max` is 0;
- `memory.oom.group` is 1.

After the child exits, the runner:
- reads the cgroup's `memory.peak` and its OOM kills (a point that hit the cap has status `oom`, never a time);
- kills whatever is still in the cgroup with `cgroup.kill`, including descendants that left the process group;
- removes the directory.

The removal is the proof that nothing is left: cgroup v2 refuses to remove a cgroup with a process in it. If the directory can't be removed, the runner stops at once with a `TeardownError` (exit status 3): no file for that point, and no next point, since something it started may still be running. A failed partial setup removes its cgroup before the error propagates.

This needs a cgroup v2 host and a directory delegated to the user. `cgroup-setup.sh` makes it once, with sudo, and starts the runner inside it. Its directory is fixed, `/sys/fs/cgroup/bench-core`: the privileged steps take no path from the environment, and refuse a symlink or a directory that isn't on cgroup2fs. (`run.py` reads `BENCH_CGROUP` for its own unprivileged work; a root other than the default has to be set up by hand, in the same way.)

```sh
bash bench/core/cgroup-setup.sh python3 bench/core/run.py --build --host-label n2-standard-16
```

Without it, `run.py` refuses to run and says why. `--mem-cap none` runs uncapped, and the points record that.

## Reruns

A rerun skips a complete point only when it matches the current run exactly:
- the protocol, the commit, and a hash of the uncommitted changes under `engine/` and `bench/core/`;
- the machine: label, CPU model, flags, architecture, CPU count and kernel;
- the Rust, Node, Python, python-flint and Magma versions;
- the build flags, the threads, the memory cap and the backends;
- the point's own $n$ and $K$.

## Running it

Benchmarks never run in the CoCalc project; they run on a quiet VM. On a VM with the repository built (`engine/.venv` with the wheel and python-flint 0.9.0, `build/cli/pyjs.cjs`, Magma):

```sh
bash bench/core/cgroup-setup.sh python3 bench/core/run.py --build --host-label n2-standard-16
python3 bench/core/run.py --only poly_fp_gcd --sizes l --mem-cap none
python3 bench/core/run.py --dry-run          # the points, and the backends found
python3 bench/core/test_inputs.py            # the input check alone, small size
python3 bench/core/test_runner.py            # the runner's process handling; needs nothing built (its cgroup tests need the setup above)
```

Planned, not built yet:
- the sharded multi-machine runs: a VM-hour envelope, and the copy-back acknowledged before the next point;
- the new rows for the uncovered items.

`items.json` gives each uncovered item's status.
