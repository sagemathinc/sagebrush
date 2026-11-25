# Core-algorithm harness

This harness times Sagebrush's core algorithms against the best available software, on fixed inputs, after checking every answer. Each row is a named operation at three sizes, tied to an item of the progress board's "Math: core algorithms" page. `items.json` lists all 38 entries: the board's 37 items, which rows cover them, and what each unlocks, plus `int` for the big-integer rows below the list.

The finish line for an item is our native engine within $2\times$ of the best reference on the same machine, for most inputs. This replaces `bench/magma-scoreboard`: the same 29 cases with the same inputs and answer signatures, plus a native column, input checks, adaptive timing and one JSON file per point. Its October tables are kept in `results/history/`.

## Backends

| backend | driver | what it measures |
|---|---|---|
| user | `drivers/sagebrush_case.py` in `engine/.venv` (Sage mode); under `build/cli/pyjs.cjs`, a row's own script (`"pyjs_driver"`): `drivers/sagebrush_bigint.py` for the big-integer rows, `drivers/numpy_case.py` (NumPy's `A @ B`) for the f64 product rows | what users get. The pyjs rows run in WebAssembly. A row may have no user column (`"user": null`), or keep it at a few sizes only (`"user_sizes"`): those points are informational, with no user ratio, and the other sizes skip the column |
| native | `native/`: a bench-only Rust binary that calls the engine's routines directly | the engine itself, without the Sage layer or the request wire |
| native-host | the same binary built with `-C target-cpu=native` (in `native/target-host`) | headroom only: what this CPU's SIMD would give. It never counts toward the $2\times$ rule until the engine dispatches on CPU features at run time |
| wasm | the same crate built for `wasm32-wasip1`, run under Node's WASI by `drivers/wasi_run.mjs` | the engine as WebAssembly. Same toolchain, release profile and default target features as the product's `wasm32-unknown-unknown` build (`scripts/build-engine.mjs`), and like it without the `parallel` feature. Only the target differs: WASI gives the driver its arguments, a clock and stdout, which the product's host provides in its own way |
| magma | `drivers/magma_case.m`, run by `/usr/local/bin/magma` | Magma V2.18-5, a black-box reference |
| flint | `flint-rust/` (Rust bindings) where it covers the operation, else `drivers/flint_case.py` (python-flint 0.9.0) | FLINT 3.6, a black-box reference |
| blas | `drivers/numpy_case.py` in `.venv-blas` (NumPy 2.3.5, its wheel's OpenBLAS), on the rows marked `"blas": true` | a black-box reference for the f64 product. `OPENBLAS_NUM_THREADS` is the column's thread count |
| native-n, flint-n, blas-n | native, flint and blas on $N$ threads (`--threads`, default the CPU count) | the parallel speed of each. Magma V2.18 runs on one thread |
| user-n | user on $N$ threads, only on the rows marked `"parallel"` (F4, modular symbols, newforms) | the parallel speed users get |

- The gap between user and native shows a *routing* cost: the Sage layer and the wire. The gap between native and the best reference shows an *algorithm* cost.
- Rows without a native driver show no native ratio.
- Each point records which adapter each backend used.
- Magma and FLINT are references only. They are run as programs and through their public interfaces, never read, and never linked into anything Sagebrush ships. The same holds for `native/` and `flint-rust/`: each is its own Cargo workspace (`[workspace]` in its `Cargo.toml`), outside `engine/`. So neither is a member of the engine's workspace, and no shipped build or wasm pin includes them.
- `native/` is built with the engine's pinned toolchain (`engine/rust-toolchain.toml`) and default flags, which is the code we ship. Its `Cargo.lock` starts from `engine/Cargo.lock`.
- Natively, `native/` enables `sagebrush-par/parallel`, as every shipped native build does (the Python wheel, the Node addon, the CLI). The 1-thread columns set `RAYON_NUM_THREADS=1` and the -n columns $N$. Today only a few of the engine routines these rows call run in parallel, so most rows show no gain from threads yet.
- Ratios:
  - **1-thread:** user, native, native-host and wasm, each against the fastest 1-thread reference (Magma, FLINT or NumPy/OpenBLAS).
  - **best/best** (the $2\times$ rule's): our faster of native and native-n against the fastest of Magma, flint, flint-n, blas and blas-n.
- The Rust FLINT oracle needs a static FLINT 3 build at `SAGEBRUSH_FLINT_PREFIX` (see `engine/flint/build.rs`).

## The protocol

Every driver is invoked as `DRIVER ROW N MODE K` and prints one line (`drivers/common.py`).

$K$ is the number of input variants. No point is timed on one input repeated, which can flatter a path by $3\times$ (warm caches, branch history, one lucky shape):
- Each variant has the same shape and size, from its own seed: salts $+6v$, matrix nodes $+v$, the factor product's constant terms $+v$, and the big integers $+v \cdot 1000003$ and $+v \cdot 998244353$.
- Variant 0 is the row's reference input, the old scoreboard's.
- The rank rows beyond the square ones are built from random dense factors, with every rank proved: `mat_{z,q}_rank_wide` ($n \times 2n$, rank $n$), `mat_{z,q}_rank_def` ($n \times n$, rank $n/2$, a product through an inner dimension of $n/2$) and `mat_{z,q}_rank_def_p` ($n \times n$, full rank over $\mathbb{Q}$ but rank $n - 1$ modulo the engine's word prime $2^{62} - 57$, which exercises the certified rank's fallback).
  - The upper bound comes from the construction. The lower bound comes from the rank modulo an auxiliary prime, $2^{31} - 1$, which `expected_inputs.py` checks for every variant. A seed whose certificate fails is refused.
  - Their input hashes stay in `expected_inputs_golden.json`'s `pending` section until a VM run where every backend agrees on them.
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

Protocol 5 adds a `TIMING|json` line before each `TIME` line: the samples a sweep pairs across candidates.
- The driver measures its timer's granularity $g$. The per-op threshold is $\max(1\,\text{ms},\ 1000\,g)$.
- **per-op** mode, when one operation takes at least the threshold: $R$ full rotations, each operation timed alone, in rotation order from a seeded offset. `samples[v]` holds variant $v$'s $R$ times, never back to back.
- **batched** mode, below it: the calibrated rotation batches, each a whole number of rotations. Batch $j$ starts at the seeded offset, the same for every candidate's batch $j$.
- The offset of rotation or batch $j$ is $o_j = \big((\mathrm{seed} \cdot 1000003) \bmod (K-1) + j\,s\big) \bmod K$ ($o_j = 0$ for $K = 1$), with $s = 1$ for $K > 2$ and $s = 0$ for $K = 2$. Rotation 0 never starts on $K-1$, which ends the warm pass and every whole-rotation calibration run, and no rotation starts on the variant the previous one ended on. So no variant runs twice in a row in any mode (every driver uses the same schedule, and the tests check the order and that the drivers agree).
- **Stream rows** (`"stream": true`, the class-group rows `class_group_prime`, `_composite`, `_large_h`, `_proven` and `_generic`) run in a third mode, `time-stream`: variant $v$ is the $v$-th input of a deterministic stream (for the class groups, the $v$-th discriminant of `stream_disc`), built outside the timer and timed once, in order, with no warm pass. So no input is seen twice, and nothing a system caches between calls (a field, its class number) can be reused. The input hash covers the whole list as used, and the combined signature (each input's class number and invariants) must agree across systems. Input 0 is the cold sample: it is recorded but never in the TIME line's statistics, a ratio or a fit. The headline ratios pair the systems input by input: the median of the per-input ratios over inputs 1 to $K-1$, against the best reference, with their quartiles and the cold ratio beside them (`per_input_<backend>`). A stream run is only its per-input record: one without a valid `stream` TIMING record of exactly the requested $K$ (missing, malformed, another mode, another $K$) is an error, its aggregate TIME numbers dropped, and the point is an error too, with no ratio; nothing falls back to the ratio of medians. Stream points go into `calibration.json` with every backend's seconds per input from input 1 on (`seconds_per_input`), the references' too, and the cold input 0 apart (`seconds_cold`); they have no vtime pass.
- Magma's clock ticks at about 10 ms, so the Magma reference is always batched.
- `BENCH_SEED` sets the seed. `BENCH_TIMING=per-op|batched` forces a mode (for tests).
- `run.py` keeps the record, bounded and checked, in the point's `time.timing`.

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

## Thread sweep

With `--sweep` (the shard driver always passes it), the rows marked `"sweep"` also time their -n backends on a series of pinned CPU sets: the first $c$ physical cores for $c = 1, 2, 4, 8, \dots$ (and all of them), one logical CPU per core, then every logical CPU (the `-smt` column) when the machine has SMT. A row marked `"sweep": "ends"` (mat_z_charpoly and the GF(p) products, flat baselines) takes only the first and the last column.

Code that sizes its own thread pool from the CPUs it may use (the CLI's NumPy product: its pool follows `navigator.hardwareConcurrency`, which follows the affinity) needs its 1-thread columns pinned to one CPU. A row marked `"threads_by_affinity"` runs every column that isn't -n (user, blas) pinned to the first CPU the runner may use, recorded as the run's `cpus`. Its -n columns are pinned only in the sweep. The cores come from `thread_siblings_list`, limited to the CPUs the runner may use.

Each run is pinned twice: by `cpuset.cpus` in its capped cgroup (`cgroup-setup.sh` enables the cpuset controller too) and by its affinity, so `sched_getaffinity`, and so `available_parallelism`, see $c$. Its thread settings are $c$ as well: `BENCH_THREADS` (the Sage-mode driver passes it as `threads=` to modular symbols and newforms), `SAGEBRUSH_THREADS` (F4) and `RAYON_NUM_THREADS`. A column whose combined signature differs from the timed one is a `mismatch`; a column that can't be pinned (its cgroup's cpuset or the child's affinity refused) is that column's `error`, never the point's. Each point records the columns' results under `sweep` (the run identity lists the columns under `sweep_columns`), and the summary lists them with each column's speedup over one core. `cgroup-setup.sh` checks that a child cgroup takes a `cpuset.cpus`, and the VM build runs it once, so a VM that can't pin fails its setup rather than every point.

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

## Runs across VMs: the shard driver

`shard.py` runs one harness run across spot VMs from the project. Its design, reviewed before any code, is binding.

1. **Plan, in the project, before any VM exists:**
   ```sh
   python3 bench/core/shard.py plan RUN_DIR --types types.json --envelope 18 --pin-policy track
   ```
   This refuses a dirty tree. It writes `plan.json`: the run id (16 random hex digits), the commit, the machine types, the VM-hour envelope, the points, and every point's expected input hash from `expected_inputs.py`. It also writes `payload.tar`: a `git archive` of the commit plus `.bench-commit` and `expected-inputs.json`, with no `.git`. It prints the plan's sha256.
2. **Approval:** the run's approver approves that exact sha256. Nothing may change the plan afterwards.
3. **Run:**
   ```sh
   python3 bench/core/shard.py run RUN_DIR --sbvm PATH/sbvm.py
   ```

What a run does:
- **Lock:** it holds a lock on the run directory, so only one driver can spend its envelope.
- **Ledger:** every VM action is announced in `ledger.jsonl` before it happens: reserve, created, delete-requested, deleted, absent, build, accepted. Each line is written whole and fsynced before its action; a write that fails is fatal before the action, and new directories are fsynced into their parents. A torn last line stops the driver until `--repair-tail` moves exactly those bytes aside.
- **VM tool:** VMs are created, read and deleted only through `sbvm.py`, with argv (`create`, `show`, `names`, `delete`). Each VM gets the single label `bench-run=<run id>` and no service account.
- **The envelope:** a VM is charged from its reservation: its full `maxRunDuration`, plus the create timeout until its creation is seen. A VM counts until its deletion is confirmed, or its whole lifetime if it expires. Preemptions and retries are charged in full, and a create with an unknown outcome blocks all spending until it is resolved. A create whose VM was never seen (it may have run and been preempted unseen, or may still appear) stays charged its full `maxRunDuration` plus the create timeout: nothing is refunded for not being seen. If such a VM appears later, it is adopted and deleted. No VM is reserved unless the total stays within the envelope.
- **Restart:** the driver lists the run's VMs by name prefix. It adopts only a VM it reserved, exactly as reserved: labels, type, zone, image, lifetime, no service account, created after its reservation. Anything else is fatal and left untouched. Adopted VMs are deleted before anything new is created. Every acknowledged point must still be its file, with the acknowledged sha256, and pass every acceptance check again, identity included; a missing or changed one stops the run. An unacknowledged file goes through the same checks before it is adopted.
- **Each VM:** it receives the payload and builds once. The payload's sha256 is checked against the plan just before the copy, and on the VM before anything is extracted. `vm-setup.sh` checks FLINT's tarball against its sha256. It then checks the fresh engine wasm by the plan's pin policy (`--pin-policy`, recorded in the plan and the payload; a payload without it stops the type). The pin moves only with a track's pull into master. A check that can't run at all (a malformed `pins.json`, a missing module) stops the type under either policy. Every point's engine claim must be consistent: its policy is the plan's, `ok` is exactly whether the fresh sha256 equals the pinned one, and that sha256 is the hash of the engine-wasm artifact the point used.
  - `strict`, for master or a pull into master: the fresh engine wasm must equal `wasm/pins.json`, or that machine type stops, with both hashes printed.
  - `track`, for a track tip, whose pin lags its source: the comparison is printed, and every point records the fresh build's sha256. All points of a type must share it, and each must have been checked under the plan's policy. A failed build stops that machine type. Then the VM measures one point at a time: `run.py` under `cgroup-setup.sh`, with the plan's expected inputs.
- **Copy-back:** each point's file and its checksum sidecar are streamed back. The file is cut at 1 MiB + 1 byte and the sidecar at 66 bytes. The driver checks the bounds, the checksum, the JSON, the schema, the identity and the key, in that order. It writes the file without following links, fsyncs it, renames it into `rows/<type>/`, fsyncs the directory, and writes the ledger line. Only then does that VM get its next point.
- **Accepted points:** an identical file already accepted is acknowledged again; a different one is quarantined and stops the run. Every point of a machine type must share that type's identity: the machine, toolchain, versions and every executed file's hash. The user column's engine must be the pinned one under `strict`, and the type's one recorded fresh build under `track`.
- **Failed points:** when run.py itself fails on a VM that stayed up (not a preemption or ssh's 255), the VM is retired and the ledger keeps the last 4 KB of its output, where the exception is. A point whose run.py fails on 2 VMs is recorded `point-failed` and gets no more VMs, across restarts too; a type with 3 failed points stops, since the failure is then the code's or the image's.
- **Deletion:** a VM is deleted only after an exact-name read shows it is the one reserved: labels, type, zone, image, scheduling, lifetime, and the recorded creation time. Anything else, or a read that fails, is reported and left alone.
- **Exit:** a fatal error, SIGINT or SIGTERM stops new reservations and points and cuts the remote commands in flight. The driver joins every worker, lists the run's VMs, deletes each one proven to be its own, and confirms the deletion. Only then does it release the lock. Without a listing, nothing is deleted. Beyond that, each VM deletes itself at its `maxRunDuration`.

`test_shard.py` covers it with a fake VM tool and a fake remote, no VMs and no network:
- the plan, the ledger and the accounting;
- acceptance and recovery at every durable boundary;
- ownership;
- preemption and retirement;
- the payload checks, deletion only of proven VMs, stopping on signals, and ledger write failures;
- the transport's bounds, with stub `ssh` and `sbvm.py`.

Planned, not built yet:
- the new rows for the uncovered items.

`items.json` gives each uncovered item's status.
