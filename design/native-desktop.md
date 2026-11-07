# Native engines in the desktop app

*Status: plan r3, for review. No code accompanies it, and nothing is built until it is reviewed and William
approves (his rule of Oct 30). Owner: @sagebrush-remote-compute. Reviewers: astra (SEC), daybreak3 (ENGINE), daybreak4
(PERF), daybreak2 (SIZE), agents-ui (app). r2 took the r1 reviews. r3 takes the r2 reviews:
- PERF: the low-level thread rows now have a wasm run of the identical call (§2);
- SEC: NATIVE-DIFF-1's three contracts, destination resolution, the disk failure model and the freeze barrier
  (§3.1, N1, N2);
- ENGINE: NATIVE-IPC-2, unsupported modes (§1.3), and NATIVE-IPC-3, views of a shared kernel (§1.3);
- app: the N4 interact gate and agents-ui's addendum, where the all-or-nothing batch is a new page API (§3.1).

Whether an item is closed is for its reviewer to say. Still open whatever the reviews say: N1's proofs and William's
decisions (§7).*

## In plain words

- The desktop app will run notebooks with Sagebrush's **native engines**: the Rust engine compiled for your computer,
  with real threads, native SIMD and all of your memory, inside a real CPython. It will not use WebAssembly in the web
  view.
  - On the engine-heavy cells measured below it is 2.2–4.8 times faster than WebAssembly at the same version. The
    most is where an engine uses many cores, which WebAssembly here doesn't. It starts in milliseconds.
  - It is not yet faster at everything; §2 says plainly where.
- Each notebook gets its own engine process, locked down by the operating system before any of its code runs:
  - it reads only the notebook's own folder and what you've allowed;
  - its file changes reach your files only after Sagebrush's permission checks;
  - it has no network of its own.
- The website, iPhone and iPad keep WebAssembly, and so does Android at first. Where the app can't lock a process
  down, it keeps today's behaviour, never something looser.

William, Nov 7 2026: "one key thing: the desktop app must NOT just use wasm. that it does not must be very temporary"
(6:02 AM PST), and "we really need to have a native app that is not wasm, since that is a major part of the value
prop of native" (~6:05 AM).

## 1. What runs, and how the app runs it

### 1.1 The engines run native, not only the interpreter

The point of the native app is the **engines**: the Rust crates under `engine/` (exact linear algebra, number fields
and factoring, modular symbols and forms, a_p, polynomials, Gröbner bases, the parallel scheduler), compiled for the
host CPU.

Against the browser's `wasm32` build they gain:
- **real threads**: the wheel's `sagebrush-par` is built with its `parallel` feature; for example `aplist` uses every
  core by default (`threads=0`);
- **a 64-bit address space**: no 4 GB cap;
- **native code generation and the native allocator**;
- **no JS↔wasm boundary**.

The interpreter around them is CPython.

**The build the app ships:** the same `sagebrush` wheel that PyPI gets (`engine/py`, maturin, abi3 with
`pyo3/abi3-py310`, release profile; `sagebrush._native` is the whole engine as one `cdylib`), built from **the same
commit as the app** in the app's own release job.
- **Targets:** x86_64 macOS, Linux and Windows, plus arm64 macOS and Linux (Windows on Arm later).
- **CPU level:** the published wheels target each architecture's baseline (x86-64 SSE2, arm64 NEON). There is no
  `target-cpu` setting today. **N1 decides** (daybreak4's lane) between:
  - **A:** the baseline only;
  - **B:** the baseline plus runtime dispatch on the hot kernels a profile picks, with identical results proved, the
    selected ISA recorded, and the baseline fallback exercised on a CPU without it.

  If B is chosen it enters N2; otherwise it is dropped. (A separate `x86-64-v3` build is not proposed: it doubles the
  artifacts.)

### 1.2 How the app starts it: the native runner's kernel as a sidecar (recommended)

- The app bundles a pinned CPython (python-build-standalone, stripped) and the wheel above. There's no system Python
  and nothing for the user to install.
- **A trusted launcher** (§3.4) in the Rust shell (`app/src-tauri`) starts **one kernel process per document
  identity** (confinement spec §4.2), confined before the interpreter starts.
- **The execution core** is `engine/py/python/sagebrush/remote/child.py`, the native kernel the runner already
  uses: line-delimited JSON on stdin/stdout, SIGINT Stop, display bundles. Its existing tests (`test_remote_child.py`) cover that core
  only. The adapter (§1.3), the sandbox and the reconciliation (§3) are new and get their own tests in N1 and N2.
- **Over stdio pipes only:** the kernel runs no listening service, so there is no port, no pairing and no DPoP inside
  the app. The app host and the kernel still share an OS-local trust boundary, which §3 confines. The loopback gateway
  stays for the website's "Run on: Your computer".
- The page reaches it through an adapter behind `WorkerKernel` (§1.3). The **run API** the notebook, boards and console
  call stays the same. Underneath, files (§3.1) and `input()` (§1.4) change.

### 1.3 The adapter: page ↔ Tauri ↔ kernel (NATIVE-IPC-1)

`WorkerKernel` and `child.py` are **not wire-compatible**:
- `WorkerKernel` sends `{init: {limits}}` first;
- it sends runs with boolean `sage`/`magma`/`matlab` fields;
- it also sends completion and check, file, writable, live-data, input, interact and lifecycle messages.

`child.py` accepts only `{id, code, mode}` and `{id, complete, mode}`. An unadapted `init` would be an empty Python
run. So N2 builds a **`NativeKernelPort`**: a Worker-like object (`postMessage`, `onmessage`, `terminate`,
`interrupt`) on the page side, with its counterpart in the Rust host. It defines:

- **The message map** (each line pinned in N2):

  | WorkerKernel → | Native |
  |---|---|
  | `init {limits}` | handled by the host: launch, sandbox self-check, file delivery, then `ready {python, engine, limits}` to the page; never forwarded as a run |
  | run `{id, code}` or `{id, code, sage}` | `{id, code, mode: "python"\|"sage"}` |
  | run `{id, code, magma\|matlab}` | **never sent to the child** (NATIVE-IPC-2, below) |
  | completion / check | `{id, complete, mode}`; check is refused until the child supports it |
  | file messages, `writable` | not forwarded: files go by delivery and reconciliation (§3.1); the policy stays in the page |
  | live data | through the host broker (§3.2) |
  | `input()` | §1.4 |
  | interact and widgets | refused with a clear error in N2 unless the child supports them; listed as deferred |
  | lifecycle (Stop, restart, close) | §1.4 and §3.5 |

- **Modes (NATIVE-IPC-2):** `child.py` implements Python and Sage only. Any other `mode` string takes its plain-Python
  path, so mapping Magma or MATLAB to it would run their source as Python. Two rules:
  - **A document that uses Magma or MATLAB runs on the wasm kernel.** The page decides before the kernel starts: the
    document's cells or its stated mode select the engine. A Magma or MATLAB cell that appears later in a native
    session is **refused before anything is sent**, with nothing executed and a clear error ("this cell needs the wasm
    kernel; switch engines"). Switching follows §1.4's engine-switch rule: a new interpreter, the run in flight ends
    "interrupted". Real native Magma and MATLAB implementations are N5, each with its own parity tests.
  - **The host validates `mode` against an allowlist** (`python`, `sage`) and refuses any other value without
    forwarding it. In the same N2 PR `child.py` refuses unknown modes too, rather than defaulting to Python, so the
    rule holds at both ends.

  N2 pins: a Magma cell and a MATLAB cell in a native session are refused with nothing executed; an unknown mode is
  refused by the host and, sent directly, by the child.
- **Startup ordering:** launch, then confinement (§3.4), then the self-check (§3.3), then delivery of the read scope
  (§3.1), then `ready`. The page sends no run before `ready`.
- **Identity:**
  - The host owns the kernel for each stable document identity.
  - Every message carries the host's **generation** for that kernel. A message from an older generation, after a
    restart, crash or close, is dropped and acted on by no one (stale fencing).
- **Views of a shared kernel (NATIVE-IPC-3):** two views of one identity share its kernel, and their runs are
  serialized. Each `WorkerKernel` numbers its requests from 1, so the page's own IDs collide across views. Therefore:
  - **The host mints an attachment ID** for each view when it attaches, and a **host request ID**, unique for the
    kernel's lifetime, for each request. Only host request IDs reach the child. The host keeps the map from host
    request ID to (attachment, page request ID), and every response is routed by it to the originating view alone.
  - **Origin binding:** `runnerInput` answers, Stop and completion are accepted only from the attachment that issued
    the request, for that request. An input answer or Stop from another view is refused. Output, `input()` prompts and
    `done` go to the originating view only.
  - **Fanout:** a restart (by either view, an engine switch, a revoke, a crash) is announced to every attached view
    with the new generation. Each view's in-flight request ends "interrupted" or "restarted", and the views
    re-attach to the new generation.
  - **Refcount:** closing a view detaches it. Its in-flight run is stopped if it has one, and its pending input
    requests end. Replies still due to it are dropped. The kernel ends (after reconciliation, §3.1) only when the
    last attachment closes.

  N2 adapter pins: colliding page IDs from two views; a late reply after its view detaches (dropped, delivered to no
  one); Stop from each view (it stops only its own run, and is refused for the other's); a restart from one view
  notifying the other; closing a view that is not the last, with the kernel kept; closing the last view, with the
  kernel ended.
- **Stop and hard kill:** §1.4. A hard kill ends the whole descendant tree (§3.3).
- **`done` waits for reconciliation:** a run's terminal `done` reaches the page only after its reconciliation (§3.1)
  has finished. The page can never start the next run against an unreconciled tree.

### 1.4 What the wasm kernel does today, and how the native one does it

- **`input()`:** today it is a SharedArrayBuffer round trip (design/runner.md). Natively it becomes a protocol message:
  the kernel sends `{id, input: {prompt, max}}` and blocks for the page's `{runnerInput: id, text}`, with today's
  rules. A request ends at its answer, at the run's next question or end, and at Stop; a late answer writes nothing.
- **Stop:**
  - **macOS and Linux:** SIGINT to the kernel, giving KeyboardInterrupt with the variables kept.
  - **Windows:** a control message on the protocol pipe, which the kernel's reader thread turns into the interpreter's
    interrupt (`_thread.interrupt_main`); the Rust engines check the same flag.
  - **Everywhere:** if the kernel doesn't stop within a bound, the host kills the descendant tree (§3.3), and the run
    ends "interrupted" (the restart pattern).
- **Large outputs and files over IPC:** Tauri 2's binary responses or channels, not one JSON message per 64 MB. N1
  measures the cost.
- **Display bundles:** child.py emits the same MIME bundles as the wasm worker. So the page's output path, its bounds
  and OUT-ISO's frames are unchanged; N2 pins this.
- **Switching engine** (native and wasm) mid-session means a new interpreter, following the existing restart message
  pattern: the run in flight ends "interrupted", per @sagebrush's ruling on #822.
- **Lifecycle:**
  - There is one kernel per document identity across windows.
  - Closing a window or switching documents follows the wasm worker's rule.
  - Quitting the app kills every kernel's descendant tree.

### 1.5 Rejected alternatives

- **CPython embedded in the app process (pyo3), with the engine linked into the Tauri binary.** It is one process, so
  there is no OS sandbox per document, a crash takes the app down, and there is no tree to kill.
- **The wasm engine under wasmtime outside the web view.** It is still wasm32, which is what William ruled out.
- **The user's own Python and packages.** That is later (N5); it can't be sandboxed or versioned with the app.

## 2. Measured: native engine against wasm, same version

- **Version:** Sagebrush **0.6.0** on both sides, the newest release on both npm and PyPI.
- **Wasm:** the npm CLI (the browser runtime: Python compiled to JS plus the wasm engine) under Node v26.13.0 (V8).
- **Native:** the PyPI wheel `sagebrush-0.6.0-cp39-abi3-manylinux_2_28_x86_64.whl` under CPython 3.14.4.
- **Machine:** an Intel Xeon at 2.80 GHz with 32 cores (AVX2 and AVX-512 present; the baseline build doesn't use them).
- **Method:** the same cells file on both sides. Each cell gets one warm-up, then the median of 3, in each process.
  There were two process runs per side, and five per side for the threads comparison.
- **Agreement:** the mathematical outputs agree on both sides. The timings vary as shown.
- **Evidence:** `/scratch/sagebrush-reviews/remote-compute/native-bench-0.6.0/` (two runs per side),
  `native-bench-0.6.0-threads/` (five native processes), `native-bench-0.6.0-threads-wasm/` (the identical
  `threads.py`, five wasm processes) and `native-bench-0.6.0-bigint/` (the `Integer` probe):
  scripts, environment, raw runs, SHA256SUMS, read-only. Every number in the table is from these files.

| Cell | Threads (native) | Native | Wasm | Native speedup |
|---|---|---|---|---|
| `det` of a 200×200 integer matrix (539-digit result) | engine default | 65–69 ms | 166 ms | **2.4–2.5×** |
| `factor` of a 41-digit product of three primes (ECM) | engine default | 243–247 ms | 541–544 ms | **2.2×** |
| `aplist(200000)` for `[0,0,1,-1,0]` (a_p engine), Sage namespace | all cores (32) | 27.7–34.7 ms | 96.7–98.7 ms | **2.8–3.6×** |
| `sagebrush.ap.aplist(…, 200000)`, `threads=1`, both sides | 1 | 78.5–79.3 ms | 100.6–111.2 ms | **1.3–1.4×** |
| `sagebrush.ap.aplist(…, 200000)`, `threads=0`, both sides | all (32) | 22.4–24.4 ms | 102.2–108.0 ms | **4.2–4.8×** |
| `fib(24)`, pure Python recursion | — | 5.0–5.1 ms | 2.7–5.0 ms | 0.5–1.0× |
| `factorial(60000)` (865,809 bits) | — | 88–89 ms | 11.4 ms | **≈0.13×** |
| `import` of the library | — | 19–22 ms | 454–528 ms | — |

**What this shows, and what it doesn't:**
- **The engines are 2.2–4.8× faster natively** with the baseline build. **Threads matter:** with the identical
  low-level call on both sides, `aplist` on one thread is 1.3–1.4× faster natively; with `threads=0` it is 4.2–4.8×
  faster. Wasm takes the same time either way (102.2–108.0 ms against 100.6–111.2 ms): this runtime runs it on one
  thread. Native's advantage grows with the cores an engine can use and with problems that don't fit in 4 GB, which
  N1 measures. (Each range spans the per-process medians, and each speedup range pairs the extremes.)
- **Pure Python is not faster natively.** V8 JIT-compiles the JS-compiled Python, while CPython 3.14 interprets it.
- **NAT-BIGINT-1 (an N2 ENGINE gate):** in the native wheel, `Integer` is a subclass of CPython's `int`, so big-integer
  arithmetic is CPython's. In a separate frozen probe, `factorial(Integer(60000))` takes 58 ms against
  `math.factorial`'s 55 ms, the same code path (`native-bench-0.6.0-bigint/`); in the browser runtime it runs on
  Sagebrush's Rust bigint. N2 owns a representation and dispatch design:
  - mixed `int`/`Integer` operands;
  - exact result types and Sage semantics;
  - interrupt and limit propagation;
  - thresholds;
  - parity and performance controls for multiply, division, gcd, power and factorial.

  **Native does not become the default (N4) until the routed large cases match or beat wasm without regressing
  ordinary integers.**
- **Limits:** this is V8, not the app's web views (JavaScriptCore on macOS and Linux); it is one machine, and the
  cells are mine. N1 re-measures (§6).

## 3. Enforcing "File writes" and "Network" for native code

The confinement spec (r3.2) defines two switches per document and the host's authority (§4.1). It labels a native
kernel "unconfined" (§4.4). Inside the app this plan makes the native kernel **confined**:
- the host's policy is the authority;
- the engine has no permission logic and no way to change grants.

The native semantics differ from the browser's in two stated ways (§3.1, §3.5); both go to William (§7).

### 3.1 Files: delivery in, one transaction out (NATIVE-DIFF-1)

- **The working directory.** Each kernel has a private per-document directory under the app's data folder. It holds
  the **read scope only** (spec §2.7): the document's own folder tree plus granted trees. These are **independent
  copies** (or copy-on-write clones, `clonefile` on APFS), never hard links or bind mounts of the real files.
- **The source:**
  - **workspace documents** (in the web view's IndexedDB, no file on disk): the **page** serializes the read scope, as
    it loads the wasm worker today, and the host writes it in;
  - **disk documents** (`file:<path>`): the host copies them directly, with the app's existing limits (64 MB a file,
    256 MB in all).
- **The baseline:** at delivery the host records a bounded manifest. Each path gets its delivered bytes' hash and the
  **expected revision** of the real file, workspace or disk, that it came from.
- **The kernel's directory is untrusted.** Native code controls everything in it, so nothing it contains carries
  authority:
  - Only **regular files and directories** are reconciled. Symlinks, hard links (link count above 1), special files,
    reparse points and link changes make the run fail reconciliation; they are never followed or copied back.
  - Paths are canonicalized by the host and must lie under the working directory. Each maps to a real destination
    under the document root or a granted write tree, resolved only as in step 5 of the transaction.
  - Traversal, file count, total bytes and per-file size are bounded, with the app's existing limits, including files
    native C code created.
- **The freeze barrier (a stable snapshot first).** A cell finishing doesn't mean every writer stopped: background
  threads and children may still write. **The invariant:** from the freeze until the resume, no thread in the
  kernel's tree runs, no new process can join the tree, and none can leave it.
  - **Linux:** the launcher puts the kernel in its own delegated cgroup v2. `cgroup.freeze` freezes every thread in it.
    A child forked during the freeze is born in the same cgroup and frozen too. The host waits for `cgroup.events` to
    report `frozen 1` before it scans. Without a delegated cgroup v2 there is no barrier, so native execution is
    denied (§3.6). SIGSTOP of a process group is racy against fork and is not used.
  - **macOS:** only §3.3's option (a), where the profile denies `process-fork`, gives a barrier: the tree is one process,
    and `task_suspend` stops all of its threads at once. Under option (b) native execution is denied unless N1 proves
    a barrier.
  - **Windows:** the Job's active-process limit is first set to its current count, so no process can be created in it.
    Then every process in the Job is suspended, and the host checks that the Job's process list is unchanged and all
    suspended. N1 (for N3) establishes this, or Windows native execution is denied.
  - **Order:** freeze, verify, scan, run the transaction below, then **either** advance the baseline (everything
    applied) **or** restore every changed path from the baseline and verify the restore. **Only then resume.** The
    resume never comes before restore or advance has finished, and finishing the page's batch is not enough.
  - **On failure:** if the freeze can't be established or verified, or the restore, verification or resume fails,
    the generation is **retired**. Its tree is killed and the kill confirmed, its working directory is discarded, and
    the run fails. The next run gets a fresh kernel from a clean delivery, never this generation.
- **The transaction:**
  1. The host diffs the snapshot against the baseline: create, modify, delete and rename.
  2. **Admission, all or nothing, before anything is applied.** This is a **new page API**, `files.applyBatch`,
     added in N2. Today's queue doesn't do it: `drainFiles()` (web/index.html) admits one path at a time, each in its
     own write, and skips a refused path while the rest go on. wasm keeps that queue. Under the workspace's lock,
     held from the first check to the last write, `applyBatch` checks **every** change before applying any:
     `mayChange`, the write trees, `rename` at both ends, the stale-generation and sender checks, the current grants
     and each change's **expected revision** (a compare-and-swap: a real file that changed since delivery is a
     **conflict**, never overwritten). If any check fails, nothing is applied.
  3. **Apply, workspace documents:** one IndexedDB `readwrite` transaction over every store the batch touches. It
     commits or aborts as a whole. N2 confirms that the workspace store allows this; if it doesn't, the same journal
     model as for disk is used, inside the database.
  4. **Apply, disk documents: a journal, staged then renamed, with recovery.** No OS gives a multi-file atomic write,
     so the host provides **an all-or-nothing decision with recovery**, not instant atomic visibility:
     - **Prepare:** each new content goes into a staging file in its target's own folder (same file system),
       written and `fsync`ed. A journal in the host's private data folder lists every step, its expected revision,
       its staging and backup names and the grant version, and is `fsync`ed.
     - **Commit, step by step, recorded in the journal:** before each step, the host checks the grant version, the
       target's expected revision and the destination identity (below). A modify moves the original to a backup and
       renames the staged file into place. A create and the new end of a rename use a no-replace rename
       (`renameat2` `RENAME_NOREPLACE`, `renamex_np` `RENAME_EXCL`, `MoveFileEx` without `REPLACE_EXISTING`). A
       delete moves the file to a backup. Then a "committed" mark, and the backups and journal are removed.
     - **A failure during commit** (a late conflict, an I/O error, narrowed permission, a revoke's grant bump) rolls
       back the completed steps from their backups, in reverse order. If the rollback succeeds, the run is reported
       refused, with nothing changed. **If the rollback fails, the run is reported as partially applied,** naming
       each path changed and each restored, and the backups are kept. A batch is never reported fully refused when a
       real change was committed.
     - **A crash:** at the next start, before any kernel for that document runs, the host reads the unfinished
       journals. Before the "committed" mark, it rolls back; after it, it finishes the cleanup. The person is told
       what happened.
     - **The stated limits:** other programs can see the intermediate state while a commit runs, and staging or
       backup files (`.sagebrush-txn-…`, in the target folders) until recovery after a crash.
     - **Subfolders:** wasm's disk writes reach only the document's top folder today (`writeDisk`, `/^\/[^/]+$/`).
       N2 keeps that limit. A native run that changed a path in a subfolder of a disk document fails reconciliation
       with a named error, and nothing is applied. That is louder than wasm, where such a write never reaches disk,
       and not looser. Subfolder writes, for both engines and with directory creation in the journal, are later
       work, planned separately.
  5. **Destination identity, at the durable step.** The kernel can't reach the real files, but another program or
     links already in the real tree can change a destination between the check and the write. Paths are never
     re-resolved by name:
     - At delivery the host opens the **document root** and records its identity (device and inode; on Windows, the
       volume serial and file ID). It records every delivered file's parent identity too.
     - Every durable operation (a write's staging and rename, both ends of a rename, a delete) walks from the held
       root handle one component at a time: `openat2` with `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS` on Linux
       (`O_NOFOLLOW` at each step where `openat2` is missing), `O_NOFOLLOW_ANY` on macOS, and on Windows a relative
       `NtCreateFile` with `FILE_OPEN_REPARSE_POINT` that refuses any object carrying a reparse point. The operation
       then happens relative to the parent handle (`renameat`, `unlinkat`).
     - A link or reparse point anywhere on the path, or a parent whose identity differs from the recorded one, is a
       **conflict**. A file revision alone is not enough when its parent has changed.
     - The current grant version is checked immediately before the durable operation, not only at admission.
     - Workspace documents have no links. Their identity is the workspace document's ID, checked in the same
       transaction.
  6. Every path the run changed is then restored from the baseline in the working directory, or the generation is
     retired, before any later run (the barrier above). Unauthorized bytes never survive into the next cell.
  7. The baseline advances only after a complete apply.
- **The run's outcome:** a refused or conflicting batch marks the run failed. The error names each target to allow or
  each conflict. A partially applied batch (a failed rollback, step 4) is reported as that, never as refused. The page draws the prompt for the first refused target (spec §3), and **nothing is replayed after a
  grant**: the person runs it again.
- **Serialization:** run completion, Stop, close and crash all go through reconciliation before the kernel takes
  another run.
  - Stop reconciles like completion.
  - Close reconciles, then ends the tree.
  - After a crash the working directory's changes are **discarded**, and the next run starts from the baseline.
  - The `done` of §1.3 waits for it.
- **The stated semantic difference from the browser (for William, §7):** in the browser a refused write fails at once
  with `PermissionError`, inside the cell. Natively, a write the policy will refuse **succeeds privately** during the
  cell, and the whole cell's changes are refused at reconciliation. Code that reads back what it wrote sees its own
  write until the cell ends. This is the price of not intercepting native C code call by call. A later option,
  separately reviewed, is a FUSE or ProjFS view that refuses at the call.
- **Widening** (a new read or write grant) delivers more files before the next run, with no restart.

### 3.2 Network: none in the kernel

- The OS policy (§3.3) refuses every socket. The kernel has only its inherited stdio pipes.
- Live data, the remote relay and any future fetch go through the host's one connection broker (spec §4.1,
  CONF-NET-1) over the same pipes. Each request is bound to the registered kernel's **document identity and
  generation**, known to the host by the pipe it came on and never by a field in the message, and is bounded in size
  and rate.

### 3.3 The OS policy, per platform: a minimum contract (NATIVE-OS-1)

The kernel runs only if the **whole** minimum policy for its platform is installed. Otherwise, §3.6.

| | Files | Sockets and local IPC | Descendants (who owns every child) |
|---|---|---|---|
| **Linux** | Landlock, **minimum ABI 3** (Linux 6.2: read/write rights and truncate): read the runtime, read and write the working dir and temp, nothing else. ABI 6's scoping of abstract Unix sockets and signals is used where present. The launcher checks the ABI and refuses below the minimum. | seccomp-bpf: `socket()` refused for **every** family, `AF_UNIX` included, so there are no abstract or filesystem Unix sockets; `socketpair()` allowed (no external endpoint). Also refused: `ptrace`, `process_vm_readv/writev`, `mount`, `unshare` of new namespaces, `bpf`, `perf_event_open`, `keyctl`, `io_uring_setup`. `no_new_privs`. | a **PID namespace** (in an unprivileged user namespace) whose init is the launcher: killing it ends every descendant, whatever `setsid` they call. Without user namespaces, seccomp also refuses `setsid`/`setpgid`, so the process group is durable, and the host kills the group. |
| **macOS** | a Seatbelt profile applied by the launcher **before exec** of the interpreter (`sandbox_init` with a generated profile; it persists across exec): deny by default; allow the runtime (read), the working dir and temp (read and write) | `(deny network*)`, which covers Unix-domain sockets too, plus `(deny mach-lookup)` except the minimum the runtime needs (listed in N1), and `(deny process-info*)` for other processes | **open, decided in N1:** macOS has no PID namespace. Candidates: (a) a Seatbelt profile that denies `process-fork`, so no children and no native `!cmd` on macOS in v1 (the shell stays wasm); or (b) a session leader plus a descendant sweep with verified completeness. **Fail closed:** without a verified mechanism, (a). The freeze barrier (§3.1) also needs (a), unless N1 proves one for (b). |
| **Windows** | an AppContainer token at `CreateProcess`, so the kernel is confined from its first instruction; ACLs grant its SID only the working dir and temp; the runtime is read-only | no network capabilities (no `internetClient` or `privateNetwork`), and no named pipes beyond the inherited ones (AppContainer object isolation) | a Job object with `KILL_ON_JOB_CLOSE`, **no breakaway** (`BREAKAWAY_OK` and `SILENT_BREAKAWAY_OK` off), the process assigned at creation, and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so that only the pipes are inherited |

- **The self-check is a canary, not the proof.** At start, before `ready`, the kernel runs probes:
  - a TCP socket;
  - a Unix socket;
  - a write outside its directories;
  - a read of the user's home;
  - a child that tries the same and tries to leave the tree.

  Any success means that kernel isn't used. **N1's proof** is the complete policy tested on each platform: denied
  IPC, descendant lifecycle through Stop, close and revoke, and the escape attempts SEC lists.

### 3.4 The trusted launcher: no ambient authority before confinement (NATIVE-BOOT-1)

- **Confinement precedes every untrusted instruction.** The launcher, a small Rust program shipped and signed with the
  app, installs the whole policy of §3.3, then `exec`s the interpreter. On Windows the AppContainer token is applied at
  `CreateProcess`. So no import, `.pth` file or extension load runs unconfined.
- **The interpreter starts isolated:**
  - `python -I` (no user site, no `PYTHON*` environment, no current directory on the path) with `-S` and an explicit
    `sys.path` of the bundled runtime and wheel only;
  - no `sitecustomize` or `usercustomize`;
  - the user's packages are invisible.
- **A sanitized environment and descriptors:**
  - an allowlisted environment (locale, `TMPDIR`/`TEMP` set to the private temp, `HOME` set to the working dir), with
    no app secrets, signing material or tokens;
  - every inherited descriptor or handle closed except the protocol pipes.
- **Host files can't be replaced:** the runtime and the staging metadata (the baseline manifest) live outside
  everything the kernel can write. The manifest is the host's alone.
- **The protocol is bounded and validated:** a maximum line size, output rate and display size (child.py's existing
  bounds, checked again by the host), and malformed framing ends the kernel. Every broker request is bound to its
  generation (§3.2).

### 3.5 Revoke: restart, in order (NATIVE-REVOKE-1, a William decision)

An OS policy can't re-check reads on handles opened earlier (spec LIVE-HANDLE-1). The proposal, which needs
**William's explicit exception** to spec §4.2 (interpreter preservation) and §4.1 (immediate revoke) for native kernels
(§7):
1. The grant version is bumped. The host at once refuses every broker request and every reconciliation from the old
   generation, and **exports no pending change** from it.
2. The old kernel's descendant tree is killed, and the kill is **confirmed** (the PID namespace init gone, the Job
   empty, or the group empty).
3. The old working directory and staged data are **discarded**.
4. A fresh working directory with the **narrowed** read scope is delivered before the next run.

The person sees "permissions changed: the kernel restarted". Widening never restarts. Restarting can't take back bytes
the old kernel already read; the plan doesn't claim it does.

### 3.6 When native confinement isn't available: today's behaviour, not looser (NATIVE-FALLBACK-1)

- A kernel that fails launch, policy or self-check is **killed and retired** before anything else runs for that
  document. Its generation is fenced, and its started cell is never replayed.
- The document then gets **exactly the app's current behaviour**, #822's option 1:
  - a notebook allowed to change files runs on the plain wasm worker, as today;
  - one that isn't allowed is refused with the existing Allow flow.

  It never gets a plain wasm worker that today's policy wouldn't allow, and never an unconfined native process.
- The page says which mode is available and why (the words go to COPY).
- Spec §4.4's kernels (a remote runner, Jupyter, `sagebrush remote` on a server) stay as the spec says.

## 4. Size, install and startup, and signing

- **Size (daybreak2):** today's installers are 10–15 MB. The wheel adds about 6–7 MB compressed (0.8.2 on PyPI,
  6.0–6.8 MB). A stripped CPython adds roughly 15–30 MB compressed.
  - **Estimated payload: +21–37 MB** per thin installer.
  - **Release budget: +25–40 MB,** including packaging, signing and alignment contingency.
- **Two independent choices:**
  - **Delivery:** bundle the native runtime in the installer, **or** fetch it on first use by content hash, signed
    (William's call, §7).
  - **Artifact shape:** thin per-architecture installers, **or** a universal macOS app (roughly double the native
    payload).

  **Recommendation:** bundle, with thin per-architecture installers.
- **The N1 size gate** records, per supported OS and architecture, at the same commit, before and after:
  - the compressed signed installer and its update delta;
  - the installed-on-disk delta;
  - the unpacked runtime and wheel inventory;
  - on macOS, the thin and universal totals;
  - for download mode, the payload's compressed and installed size and any cache or update duplication.
- **Acceptance budget, fixed before N2:** **+40 MB compressed per thin installer** (proposed). A universal macOS
  artifact gets its own stated budget.
- **Startup (daybreak4):** N1 reports, separately and with variability:
  - kernel start;
  - launcher policy setup;
  - the self-check;
  - `import sagebrush` (19–22 ms here);
  - the first cell;

  all against the wasm worker's about 300 ms to ready in the page (design/runner.md). A warm spare kernel is a later
  option.
- **Updates:** the runtime is versioned with the app (the Tauri updater). Kernels are never shared across app
  versions.
- **Signing:** the app is unsigned today (app/README.md), and native code makes signing necessary.
  - **macOS:** Developer ID, hardened runtime and notarization, with every `.dylib`/`.so`, the `python` binary and the
    launcher signed.
  - **Windows:** Authenticode (Azure Trusted Signing or an EV certificate) for the app, the launcher, `python.exe` and
    every DLL and `.pyd`.
  - **Linux:** signed checksums; AppImage, deb and rpm.
  - The accounts and their cost are William's decision.

## 5. What stays wasm

- **The website:** a page can't start processes. "Run on: Your computer" (loopback) and remote compute remain its
  native paths.
- **iOS and iPadOS:** no child processes. The WebKit probe (astra's 1-day estimate) still has value there.
- **Android at first:** native later, separately planned. Its wasm runner (a Chromium WebView) is then the only safe
  way to run a notebook not allowed to change files. So the Android wasm-runner sandbox remains worth doing **when
  @sagebrush sequences it**; per the coordinator, app wasm-runner work stays paused until this plan's milestones settle
  what is needed.
- **The app's fallback:** §3.6.
- **Desktop Windows:** **no wasm-sandbox PR**, since N3 replaces it (agents-ui agrees). #822 stays as option 1 until
  N2 ends it (§6).
- **The runner pill's words** are COPY's (board's) to rule on. "Isolated" may describe only the process sandbox. It
  must not read as the confinement claim, which the spec reserves until its phases ship.

## 6. Milestones

| | What | Gate |
|---|---|---|
| **N0** | This plan, reviewed; William's decisions (§7) | all lanes; William |
| **N1** | Spikes and measurements, no product code. **(1)** The launcher and §3.3's complete minimum policy on macOS, Linux and Windows, with SEC's escape tests: sockets of every family, local IPC, write and read outside, descendant escape (`setsid`, double fork, Job breakaway), ptrace, Stop, close and revoke lifecycle; and the macOS descendant decision (§3.3). **(2)** daybreak4's measurements at one commit in the app's own web views (JavaScriptCore on macOS arm64 and Linux x86_64, WebView2 on Windows x86_64): for each parallel cell, native at `threads=1` and in automatic mode with the pool size recorded, against wasm; a specified **> 4 GB case** (native completes with peak RSS and time recorded; wasm reaches its memory limit or fails cleanly); enough independent process runs for medians and variability; and §4's startup breakdown. **(3)** The CPU-dispatch decision A or B (§1.1), profiled first. **(4)** §4's size gate against the budget. **(5)** The IPC cost of large payloads. **(6)** The freeze barrier of §3.1 on each platform (a delegated cgroup v2 freeze on Linux, the single-process `task_suspend` on macOS, the Job's process limit and suspension on Windows), with controls: a background thread writing in a loop through reconciliation, a child forking repeatedly during the freeze, a child created between the cell's end and the freeze, and a failed freeze retiring the generation. Where no barrier is established, that execution mode is denied. **(7)** Destination resolution from a held root (`openat2`, `O_NOFOLLOW_ANY`, `FILE_OPEN_REPARSE_POINT`) on each platform, with the substitution controls listed under N2. | SEC, ENGINE, PERF, SIZE |
| **N2** | macOS and Linux: the bundled runtime and wheel (same commit), the launcher, `NativeKernelPort` (§1.3) with adapter-level tests for every mapping and transition, the reconciliation transaction (§3.1) with pins (refused modify, create, delete and rename followed by another cell; an external edit during a run; a mixed admitted and refused batch; Stop; crash; close; a second view), the new page API `files.applyBatch` (wasm keeps `drainFiles()`), the disk journal with controls (an I/O failure injected at each commit step, rolled back with nothing changed; a failed rollback, reported as partially applied with each path named; a crash at each journal state, recovered before the document's next kernel starts; a narrowed grant and a revoke during commit; a late external conflict on the last file; a workspace transaction abort; a subfolder change in a disk document, refused), destination controls (a destination parent replaced by a symlink or junction between delivery and commit; a parent renamed; a target replaced by a link; each end of a rename and a delete target substituted), barrier controls (a failed restore retiring the generation; a writer that would run before restore finishes never sees staged bytes), revoke ordering (§3.5), broker-only network, the fallback (§3.6), NAT-BIGINT-1, CPU dispatch if N1 chose B. **The self-test judges** (`app/selftest/android-report.py`, `run-judge.mjs`, `ios-judge.py`) gain the native lines in the same PR. **#822's option 1 ends:** `NEEDS_RUNNER` ("the app has no sandbox") and its branch change; the self-test stops allowing by default; both cases are pinned (allowed means writes go through the gate; not allowed means refused at reconciliation and nothing written). | all lanes |
| **N3** | Windows: the AppContainer, the Job and the control-message Stop | all lanes |
| **N4** | Native becomes the app's default, once NAT-BIGINT-1's controls pass **and** interact and widgets reach parity natively, or notebooks that use them are routed to wasm under §3.6's rules, so `@interact` notebooks don't regress; the wasm fallback stays | William |
| **N5** | Later, each planned separately: the user's own Python, native terminals in the app, Android native, warm kernels, a FUSE or ProjFS file view | — |

## 7. Decisions for William

1. **Signing:** the Apple Developer ID and notarization account, and Windows code signing (Azure Trusted Signing or an
   EV certificate).
2. **Size:** bundle the native runtime (payload +21–37 MB per thin installer; budget +40 MB; recommended), or download
   it on first use?
3. **An "unconfined" native mode,** where the user explicitly runs a notebook's native code without the OS sandbox.
   Recommended: not in v1; the remote runner covers that, labelled as spec §4.4 says.
4. **The native kernel's two semantic exceptions to the confinement spec:**
   - (a) a refused write fails at the end of the cell, all or nothing, not at the call (§3.1). For disk documents
     "all or nothing" is a decision with recovery: other programs can briefly see a commit in progress, and a failed
     rollback is reported as partially applied. Subfolder changes of disk documents are refused natively until
     subfolder writes exist for both engines;
   - (b) a revoke restarts the document's kernel, with the ordering of §3.5, an exception to §4.1 and §4.2.

## 8. Grounding

- master cfa6d281 (Nov 7 2026);
- app/README.md;
- design/runner.md and design/engines.md;
- `engine/py/Cargo.toml` and `pyproject.toml` (`sagebrush-par` with `parallel`; abi3-py310);
- `engine/py/python/sagebrush/ap.py` (`threads=0` means all cores);
- `engine/py/python/sagebrush/remote/child.py`;
- `web/notebook/worker-kernel.js`;
- the confinement spec r3.2 (§2.2–2.7, §4.1–4.4);
- the evidence in §2;
- `web/index.html` (`drainFiles()`, `writeDisk()`);
- the r1 reviews in /scratch/sagebrush-reviews/pr825-81e508e7-*.md and /home/user/sagebrush/reviews/pr825-81e508e7-perf-daybreak4.md;
- the r2 reviews (pr825-6d6c2fd3-*.md in the same folders, daybreak3's and daybreak4's updated in place);
- Linux Landlock (docs.kernel.org/userspace-api/landlock.html), setsid(2), and Windows Job objects (learn.microsoft.com).
