# Native engines in the desktop app

*Status: plan r6, for review. No code accompanies it, and nothing is built until it is reviewed and William
approves (his rule of Oct 30). Owner: @sagebrush-remote-compute. Reviewers: astra (SEC), daybreak3 (ENGINE), daybreak4
(PERF), daybreak2 (SIZE), agents-ui (app). r3 (bb03eabb) was PLAN CLEAR in all five lanes for route B alone. r4
answers William (Nov 7, about 6:33 AM PST): "there are two approaches to no wasm native: js runtime and napi; cpython
and oxpy. we need to fully consider both options". r4 compares the two routes in full, on the same cells and the
same version, and recommends one. Part B is r3's route-B plan, unchanged. Whether anything is closed is for its
reviewer to say. r5 adds §A.2b, the control bridge for permission and Stop (astra's NATIVE-A-CONTROL-1,
daybreak3's NATIVE-A-STOP-1). r6 adds the Stop linearization (NATIVE-A-STOP-2), astra's r5 notes
and agents-ui's four N2 page items. Still open whatever the reviews say: N1's proofs and William's decisions (§5).*

## In plain words

- Either way, the desktop app runs Sagebrush's **engines natively**: the Rust engine compiled for your computer, with
  real threads, native code and all of your memory, not WebAssembly. William's rule holds on both routes.
- There are two ways to run the **Python** around those engines:
  - **A:** the same Python interpreter the website uses (Sagebrush's own, written in TypeScript), run by a JavaScript
    runtime such as Node, with the Rust engine loaded as a native add-on;
  - **B:** CPython, the standard Python, with the Rust engine loaded as a native Python extension (r3's plan).
- Measured here, at the same version and on the same machine:
  - both routes make the engine cells about **2–3 times faster** than WebAssembly;
  - A keeps the web's fast pure Python and big integers, where B is 2–14 times slower;
  - B is faster at dictionaries and strings (about 2×) and at big gcd (about 75×; a pyjs gap that also affects the
    website);
  - B starts in tens of milliseconds, A in about half a second (one second with the Sage library).
- **A runs exactly the website's Python, Sage, Magma and MATLAB.** Its Python can't touch files or the network
  except through the page's own permission checks, as in the browser. So the operating-system sandbox is only the
  outer wall, and **no change to the permission rules** is needed, given the ordering of the control bridge
  (§A.2b).
- **B gives standard CPython** and, later, real C extensions such as numpy. But it is a second Python whose behaviour
  differs from the website's, and it needs new file machinery and two exceptions to the permission rules.
- **Recommendation: A for the desktop app's native engines, with B as a later, separately planned option** for real C
  extensions (§4).

## 1. The two routes

| | **A: a JavaScript runtime + N-API** | **B: CPython + PyO3** (r3, Part B) |
|---|---|---|
| Python interpreter | **pyjs**, Sagebrush's own (src/runtime), the one the website and the npm CLI run | CPython (python-build-standalone, bundled) |
| Sage, Magma, MATLAB layers | lib/ (the same files as the web), run by pyjs | the Sage layer: the same Python files (`engine/py/python/sagebrush/_sagelib`, "the same Python files implement Sage mode in the browser"), but run by CPython; Magma and MATLAB not available (NATIVE-IPC-2) |
| The engine | **engine/web's JSON ABI** (`call`, `sym_call`, `mp_call`: exactly what pyjs calls in wasm today), built as a native **N-API add-on** (napi-rs), with rayon threads | the PyO3 wheel `sagebrush._native` (engine/py), a separate binding layer |
| JS runtime | Node first (V8, measured); Bun or Deno load the same add-on file (smoke-tested, §2); an embedded V8 host is an N1 option | — |
| The session | `notebookSession` (src/notebook-session.ts), already run by the web worker **and** in a Node worker thread by `sagebrush notebook` (src/notebook.ts) | `child.py` (the native runner's kernel) plus a new adapter |

"oxpy" is read here as the PyO3 route (Rust "oxide" bindings for Python). If William meant something else, B's
column changes with it.

## 2. Measured: the same cells on both routes and on wasm, same version

- **Version:** Sagebrush **0.6.0** everywhere.
  - **W (wasm):** the npm CLI under Node v26.13.0. This is the browser runtime: pyjs plus the wasm engine.
  - **A (the spike):** the same CLI, its engine calls sent to an **N-API add-on built from the v0.6.0 tag's
    engine/web** (release, LTO, one codegen unit, as `engine/Cargo.toml`; `sagebrush-ap` with rayon, as the wheel).
    A 12-line napi-rs crate wraps `sagebrush_web::call`, `sagebrush_sym::api::call` and
    `sagebrush_mpoly::call_framed`. A preload (`napi-engine.mjs`) swaps the wasm instance's `sb_call`,
    `sb_sym_call` and `sb_mp_call` for the add-on.
  - **B:** CPython 3.14.4 with the PyPI wheel, as in r3.
  - **A1, B1:** the same, with `RAYON_NUM_THREADS=1`.
- **Method:** two cells files (`cells.py`, r3's, and `cells2.py`, new: more pure Python and big integers). Each cell
  gets one warm-up and then the median of 3, in each process. There is one discarded process per configuration, then
  5 counted processes. The table gives the **median of the 5 per-process medians**, with their range.
- **Machine:** the same 32-core Xeon as r3. The load average was 12–20 from other agents during the matrix, so
  ranges are wider than r3's. N1 re-measures on quiet machines.
- **Agreement:** every result agrees across W, A and B.
- **Evidence:** `/scratch/sagebrush-reviews/remote-compute/native-bench-0.6.0-r4-routes/`. It holds the scripts,
  the spike's source and Cargo.lock, the add-on's SHA-256, raw runs, `summary.txt`, `wasm-calls.txt`,
  `startup.txt`, `sizes.txt`, `runtimes-smoke.txt` and `env.txt`, with SHA256SUMS, read-only. Every number below
  is from these files.
- **Which cells reach the engine** (`wasm-calls.txt`, counting wasm exports): det, factor and aplist call
  `sb_call`. fib, the factorial and every cell of `cells2.py` never do: in pyjs, Python and big integers run as V8
  JIT code and V8 `BigInt`.
  - **Correction to r3:** r3 said the browser runtime does big-integer arithmetic on Sagebrush's Rust bigint. It
    doesn't: it is V8's `BigInt`.

| Cell | W (wasm) | **A** (N-API) | **B** (CPython) | A1 / B1 (1 thread) |
|---|---|---|---|---|
| `det`, 200×200 integer matrix (engine) | 181.7 (165.5–210.7) | **95.6** (88.7–100.8): **1.9×** | **82.2** (76.2–109.0): **2.2×** | 96.2 / 78.9 |
| `factor`, 41-digit product (engine, ECM) | 567.7 (543.0–598.1) | **257.4** (250.9–260.4): **2.2×** | **299.0** (283.1–339.4): **1.9×** | 257.7 / 279.6 |
| `aplist(200000)`, Sage namespace (engine) | 100.6 (96.1–113.1) | **43.6** (35.9–52.3): **2.3×** | **32.1** (31.8–34.7): **3.1×** | 99.2 (1.0×) / 88.9 (1.1×) |
| `fib(24)`, pure Python | 2.8 | 2.8: 1.0× | 5.9: 0.47× | |
| `fib(27)`, pure Python | 9.7 (9.4–13.1) | 10.1: 0.96× | 32.0 (21.7–40.4): **0.30×** | |
| a 10⁶-iteration arithmetic loop | 30.5 | 32.8: 0.93× | 70.8: **0.43×** | |
| a 200,000-key dict of formatted strings, sorted | 402.1 | 411.8: 0.98× | 186.4: **2.2×** | |
| `factorial(60000)` | 11.5 | 11.7: 0.98× | 62.9: **0.18×** | |
| a 317,000 × 456,000-bit multiply | 2.5 | 2.6: 0.96× | 37.1: **0.07×** | |
| the matching division | 11.6 | 11.5: 1.0× | 86.6: **0.13×** | |
| `gcd` of a 91,700-bit and a 96,400-bit integer | 1333.4 | 1306.6: 1.0× | 17.8: **75×** | |
| `import` of the Sage library | 459–507 | 441–529 | 20–28 | |

(ms; the speedup is W's median over the route's median. Cells, sizes and exact operands are in `cells2.py`.)

**What this shows:**
- **Engine cells: both routes are native and comparable,** 1.9–3.1× over wasm here.
  - B is somewhat ahead on `det` and `aplist`. A is ahead on `factor`.
  - A's spike still copies each request and reply through the wasm instance's memory and JSON. A real build calls
    the add-on directly; N1 measures what that saves.
  - With one thread, both are about wasm's speed on `aplist`. Threads are what make the difference there, and both
    routes have them.
- **Pure Python and big integers: A keeps the web's speed; B is slower,** 2–3× on pure Python and 5–14× on big
  integers. On B, NAT-BIGINT-1 (Part B §2) remains a gate before native becomes the default.
- **B wins on dict and string work (2.2×) and on big `gcd` (75×).**
  - The `gcd` gap is pyjs computing `gcd` in JS `BigInt` instead of calling the engine. Routing it (and the other
    big-integer kernels) to the engine fixes it **for the website too**, through wasm. That is ordinary engine work
    on route A.
  - The dict/string gap is pyjs's own; it shows on the website today.
- **Startup** (`startup.txt`; load 26–34, 7 runs each; time to the first printed line, in ms):

  | Program | A | B |
  |---|---|---|
  | `print(1)` | 411–483 | 23–25 |
  | after importing the Sage library | 1060–1284 | 53–65 |
  | for reference: W's `print(1)` | 398–454 | |

  `node -e 0` takes 43–58 ms, and loading the add-on adds nothing measurable. A's startup is pyjs's boot, the same
  as the web worker's today (design/runner.md: about 300 ms to ready in the page). A V8 startup snapshot of the
  booted interpreter is the obvious remedy: **a guess**, N1 measures it.
- **Other JS runtimes** (`runtimes-smoke.txt`, **one process each, not a benchmark**):
  - The same add-on file loads and answers in Node v26.13.0, Bun 1.3.14 and Deno 2.9.0.
  - The wasm CLI also runs all five r3 cells under Bun and Deno.
  - Under Bun (JavaScriptCore) `factorial(60000)` took 84.0 ms, against 11.2–12.6 ms on V8 (Node, Deno). **The JS
    engine matters for pyjs's big integers.** That is one reason A names Node (V8) first. It also suggests that the
    website itself is slower at big integers in Safari and the macOS/Linux web views, which this plan doesn't fix.
- **Limits:** one machine, Linux x86_64, under load. The cells are mine. A is a spike through a shim. N1 measures
  both routes properly, at one commit, on each OS (Part A §A.6).

## 3. The comparison, criterion by criterion

Each row says whether it is **measured** (here, with the evidence above), **from the code** (read at master), or **a
guess** (to be settled in N1).

| | **A: JS runtime + N-API** | **B: CPython + PyO3** |
|---|---|---|
| **Semantics parity with the web** | **One interpreter** (from the code): the same pyjs, lib/, Sage, Magma and MATLAB layers, numpy implementation, `@interact`, display bundles and errors. The same test suites and oracle diffs cover both. NAT-BIGINT-1 doesn't exist: big integers are V8's, as on the web. The engine is the same Rust behind the same JSON ABI. | **Two interpreters** (from the code): CPython against pyjs. The shared Sage files run on different builtins (`Integer` is an `int` subclass, NAT-BIGINT-1). Magma and MATLAB are missing (NATIVE-IPC-2), interact is deferred (N4 gate), and the engine is reached through a second binding layer (PyO3, engine/py) that must track engine/web's. Every oracle and test needs a CPython run too. |
| **Speed** | **Measured:** engine cells 1.9–2.3× over wasm; pure Python and big integers equal to wasm-in-V8; dict/strings and big gcd as slow as the web. | **Measured:** engine cells 1.9–3.1×; pure Python 2–3× slower, big integers 5–14× slower than wasm-in-V8; dict/strings 2.2× faster, big gcd 75× faster. |
| **Startup** | **Measured:** about 0.4 s to the first line, about 1.1 s with Sage. A snapshot could cut it (**guess**). | **Measured:** 23–25 ms; 53–65 ms with Sage. |
| **Threads** | **Measured:** rayon in the add-on, all cores (`aplist` 43.6 ms against 99.2 with one thread). The interpreter is single-threaded, as on the web. | **Measured:** rayon in the wheel (32.1 against 88.9). Python threads exist, but the GIL limits them. |
| **Memory** | 64-bit, so the engine has no 4 GB cap (from the code). V8's heap limit for JS objects is set by a flag (`--max-old-space-size`); the > 4 GB case is N1 (**guess** that it passes). | 64-bit, no cap (from the code). |
| **Files and permissions** | **From the code:** pyjs has no raw file system. Python's files are the in-memory `web/shims/fs`: the page delivers `{files}`, Python's changes come back as `{fsChanged}`, and every write is checked at the call by `setWritable`, with `PermissionError`, as in the browser. There is no shell process (`!cmd` is just-bash, in JS: web/shell). So **no reconciliation transaction, no freeze barrier, no disk journal, and neither of the two semantic exceptions** of Part B §3.1 and §3.5: refusals happen at the call. A revoke closes the page's gate at once and reaches a running cell through the control bridge (§A.2b), within its acknowledgement window. | **From the code:** CPython code makes real system calls, so Part B §3.1's delivery and reconciliation, the freeze barrier, the journal and both William exceptions are needed. |
| **The OS sandbox** | Still required: the runtime and the add-on are native code, and a pyjs or engine bug must not become the user's account. The policy can be **stricter than B's**: no writable file system at all (a private temp at most), no sockets, no child processes (fork and exec denied on every OS, so the descendant problem of NATIVE-OS-1 disappears). V8 needs JIT memory: on macOS the hardened runtime's `com.apple.security.cs.allow-jit` entitlement, and seccomp must allow executable mappings (**guess** that both fit; Chromium runs V8 under seccomp and Seatbelt). Node's own permission model is **not** a sandbox (its docs: "a seat belt" for trusted code), so it is not relied on. | Required, with Part B §3.3's table: files limited to the working directory, no sockets, and the descendant problem (PID namespace or Job, macOS open). CPython has no JIT, so the profiles are simpler. |
| **IPC and WorkerKernel fit** | **From the code:** the child runs `notebookSession`, the same protocol the page's `WorkerKernel` already speaks (init, runs with sage/magma/matlab, files, `fsWritable`, interact, completion, check, live data). The `NativeKernelPort` is a framed pipe carrying those messages. `input()`, Stop, the permission word and progress keep their SharedArrayBuffer design **inside** the child. The session runs in a worker thread, and the child's main thread applies control frames to the buffers and to the add-on (§A.2b). So no signals and no Windows special case. NATIVE-IPC-1 and IPC-2 don't arise. IPC-3 (two views) stays. | **From the code:** a new adapter maps WorkerKernel to child.py's narrower protocol (Part B §1.3: IPC-1, IPC-2, IPC-3), plus `input()` and Stop by signal or control message (Part B §1.4). |
| **Size** | **Measured** (Linux x86_64, xz -9e): Node v26.13.0 stripped 27.3 MB (Bun 24.8, Deno 30.9) plus the add-on 3.1 MB, about **+30 MB**. pyjs and lib/ are already in the app for the wasm worker. | **Measured:** uv's CPython 3.13 install, untrimmed, 21.2 MB, plus the wheel's `.so` 1.7 MB and Python files, about **+23–28 MB**. A trimmed build is smaller (**guess**). |
| **Signing** | The app, the launcher, the Node binary (with the JIT entitlement on macOS) and the add-on. | The app, the launcher, `python`, every `.so`/`.pyd`/DLL of the runtime, and the wheel. |
| **Maintenance** | **One Python implementation**, the one the web needs anyway. New: an N-API build of engine/web (the spike is 12 lines), later engine/nd and the SIMD kernels too, a Node entry for the session with the web's file shim, and a pinned Node with its security updates. | **Two Python implementations:** every behaviour difference between CPython and pyjs is a user-visible difference between desktop and web. Two engine binding layers (PyO3 and the JSON ABI). A pinned CPython. |
| **Native C extensions** (numpy, scipy, pandas) | **Never** through pyjs: it isn't CPython and has no C API. numpy, scipy and pandas stay Sagebrush's own implementations, as on the web, made faster by native engine kernels. | **Possible later:** real wheels load into CPython. Each is arbitrary native code, so it runs only under the OS sandbox, and the app's size grows with each. |
| **Risks** | V8 under each OS sandbox (JIT entitlement, seccomp, AppContainer): N1. pyjs's startup. Node's release cadence and CVEs. The engine's interrupt and memory limits are wasm-specific today. Natively, Stop needs §A.2b's bridge (engine/interrupt's native mode installs a SIGINT handler, which must not run in the child), and the limits must be re-plumbed. pyjs's slow spots (dicts, big gcd) are shared with the web. | Semantic drift between two interpreters, forever. The larger security design of Part B §3 and its William exceptions. Magma, MATLAB and interact gaps. NAT-BIGINT-1. The macOS descendant question. |

## 4. Recommendation

**Route A for the desktop app's native engines; route B as a later option, planned separately, for real C
extensions and "your own Python".**

- **It meets William's rule:** the engines run natively, with threads and 64-bit memory (**measured** 1.9–2.3× on the
  engine cells, close to B's 1.9–3.1×).
- **It is the web's Python, exactly.** Parity comes by construction, not by testing two interpreters against each
  other. Magma, MATLAB, interact and the numpy layer work from the first day.
- **It is faster than B** at pure Python and big integers (**measured**), and slower at startup (**measured**) and
  dict/string work. The big-gcd gap is fixable in the engine, for the web as well.
- **Its confinement is simpler and stronger.** Python never makes a system call, so the browser's permission semantics
  hold unchanged. The OS sandbox only has to stop native code from doing anything at all: no files, no sockets, no
  children. Neither of Part B's William exceptions is needed.
- **What A gives up:** CPython's ecosystem of C extensions. Users who need real numpy or scipy have the native runner
  (`sagebrush remote`, the "Your computer" runner) today, and B later as N5.

**What would change this:**
- N1 finds that V8 can't be confined to the minimum policy on an OS: then B on that OS, or Part B §3.6's fallback.
- pyjs's startup can't be brought near the web worker's.
- William wants CPython semantics on the desktop for their own sake.

## 5. Decisions for William

1. **The route: A (recommended) or B.**
2. **Signing:** the Apple Developer ID and notarization account (on A, also the JIT entitlement for Node), and Windows
   code signing.
3. **Size:** bundle the native runtime (about +30 MB on A, +23–28 MB on B, compressed; budget +40 MB per thin
   installer; recommended), or download it on first use?
4. **An "unconfined" native mode:** recommended not in v1, on either route.
5. **Only if B:** the native kernel's two semantic exceptions (Part B §3.1, §3.5). On A neither is needed.

## Part A: route A in detail (if William chooses A)

### A.1 What runs

- The app bundles a pinned Node (V8), the **N-API add-on** built from engine/web at the app's commit (with
  sagebrush-ap's rayon, and later engine/nd's and the SIMD kernels' native builds), and the pyjs bundle the web
  worker already uses.
- **A trusted launcher** (Part B §3.4's, unchanged in role) starts one child per document identity, confined before
  Node runs any JavaScript.
- **The child's entry** is a Node build of `web/worker.ts`'s session: `notebookSession` with **`web/shims/fs`** (the
  in-memory file system), not `sagebrush notebook`'s real files. It runs in a worker thread, so the SharedArrayBuffer
  designs work between the child's main thread and that worker. The main thread relays data frames and applies
  control frames (§A.2b).
- Engine modules that have no native build yet keep running as **wasm inside the same child** (Node runs wasm too).
  So the change is incremental, and each module's native build is its own reviewed step. engine/web, which carries
  the hot paths measured here (modular symbols, a_p, factoring, exact linear algebra), is native from the first
  release.

### A.2 The port

- `NativeKernelPort` carries **the worker protocol itself** over a framed pipe: the host's
  `postMessage`/`onmessage`, with structured data serialized (`v8.serialize` or JSON plus binary frames, chosen in N1
  by cost).
- `init` stays host-handled, as in Part B §1.3 (launch, self-check, then `ready`).
- **Generation fencing, attachment IDs and host request IDs, origin binding, fanout and refcount** are Part B §1.3's
  NATIVE-IPC-3 contract, unchanged.
- No mode map is needed: Python, Sage, Magma and MATLAB are all the session's own modes.

### A.2b The control bridge: permission, Stop, input, live data, progress (NATIVE-A-CONTROL-1, NATIVE-A-STOP-1)

In the browser the page and the worker share memory. The page writes the files-permission word and the interrupt flag
directly (worker-kernel.js `setWritable`, web/worker.ts `writableWord`, `R.INTR`), and the worker reads them **while a
cell runs**, at its next write or check. A pipe carries values, not shared memory, and a message queued to a worker
that is busy in a cell (or blocked in a synchronous engine call) isn't read until the cell ends. So route A defines
the boundaries and what crosses each:

| Boundary | What crosses it |
|---|---|
| Tauri host ↔ child process | framed messages only. **Two pipe pairs:** data (runs, files, output) and **control** (permission, Stop, input and live-data answers, acknowledgements), so a large file or output never delays a control frame. Both are length-bounded and validated; malformed framing retires the generation. |
| child main thread ↔ session worker (worker_threads) | the **shared buffers, all child-local:** `WRITABLE`, `INTR` (pyjs's interrupt word), `RUN` (the active host request ID and a stop bit), the progress slots, and each `input()`/live-data answer buffer. The main thread creates them **before** it starts the worker and passes them in `workerData`. The Node entry is given them explicitly: no `crossOriginIsolated` test, and no fallback to the between-runs `fsWritable` message. A child without them **refuses to start**. |
| child main thread ↔ Rust add-on | **add-on control exports** on a process-global word inside the add-on (below). The main thread never runs Python and never calls the engine, so it stays responsive while the worker is blocked in a call. |

**The child main thread is the only receiver of control frames.** It applies each one to the shared buffers or the
add-on and acknowledges it. It never forwards a control frame into the worker's message queue.

#### Files permission (NATIVE-A-CONTROL-1)

- **Version and authority:**
  - The host keeps a **monotonic permission version** `pv` for each (document identity, generation).
  - A change is sent as `{ctl: "writable", gen, pv, on}` on the control pipe.
  - The child main thread applies it only if `gen` is its own and `pv` is greater than the last it applied: it does
    `Atomics.store(WRITABLE, on)` and replies `{ack: "writable", gen, pv}`.
  - An older or equal `pv` (a delayed earlier allow) and any other generation's frame are ignored. **A stale allow
    can't reopen writes.**
- **The durable fence is the page's, at once:**
  - On revoke the page's gate closes immediately: the page admits a `fsChanged` only if `perms.may(owner, "files")`
    holds at admission (web/index.html, the worker message handler). So no file reaches the person's storage after
    the revoke, whatever the child does.
  - The host also drops every `fsChanged` from a retired or older generation.
- **When revoke completes:** at the child's acknowledgement of that `pv`. Until then the in-flight cell can still
  write **in the child's memory** (the shim); those writes are refused at the page (the files bar shows, as for
  `fsRefused`). The page then puts back the child's copy of each refused path, with an `fsPut` of the page's version.
    That restore is conditional: it is sent only if the generation and `pv` are still current and the page's
    revision of that path is still the one the refusal saw. A newer page revision, run or grant is never
    overwritten by it; the newer revision reaches the child by its own `fsPut`.
    The restore is **new page code** (wasm refuses inside the worker and never diverges). It covers every kind of
    change:
    - a refused modify gets the page's bytes back;
    - a refused create is deleted in the child (`fsPut` with `data: null`, its delete form);
    - a refused delete gets its bytes back;
    - a refused rename restores both ends;
    - directories are restored likewise.

    Each restore is conditional as above: never over a newer page revision or a later run's write.
  - The browser has the same race for any change queued before a revoke and drained after it. Route A widens the
    window from a memory store to a pipe round trip. N1 measures it, and the ack deadline below bounds it.
  - So route A claims **no new permission exception**, provided this ordering holds. SEC rules on whether the
    window is acceptable; if not, the fallback is to stop the run at revoke.
- **Failure is closed:** if the acknowledgement doesn't arrive within a deadline fixed in N1 (proposed 250 ms), or the
  control pipe closes, errors or carries a malformed frame, the host **retires the generation**: the tree is killed
  and the kill confirmed, every later frame from it is dropped, and the document restarts with the current
  permission.
- **Startup:** the host's `init` carries the current `pv` and `on`. The child stores `WRITABLE` **before** it starts the
  session worker, and `ready` echoes the `pv`. The page sends no run before `ready`.
- **Allow:** a higher `pv` with `on`. Writes refused earlier aren't replayed (as today).

#### Stop (NATIVE-A-STOP-1)

- **The host validates first:** it checks `(generation, attachment ID, host request ID)` under NATIVE-IPC-3: the
  request must be the attachment's own and **currently running**. Then it sends `{ctl: "stop", gen, req}` on the
  control pipe and starts the hard-kill timer (today's 2-second bound).
- **One token per run, in two words.** The token is the host request ID, unique for the kernel's life.
  - **`RUN`**, child-local, read by pyjs: `token × 2 + stopbit`.
  - **`ARMED`**, inside the add-on, read by the Rust engine: the same layout.
  - When the session worker starts a run it stores `RUN = token × 2` and clears `INTR`.
  - Around **every** add-on call (`call`, `symCall`, `mpCall`), the add-on stores `ARMED = token × 2` on entry and
    sets it back to 0 on exit, by compare-and-swap on its own token only.
- **Applying a Stop: one linearization point, the `RUN` compare-and-swap** (NATIVE-A-STOP-2's child half).
  - The child main thread compare-and-swaps `RUN` from `token × 2` to `token × 2 + 1`.
  - **Only if that succeeds** does it do anything else, in this order:
    1. set the stop bit in `ARMED` by compare-and-swap on the same token (it may fail if no engine call is active;
       that is fine);
    2. set `INTR`, so pyjs raises `KeyboardInterrupt` at its next check, as in the browser;
    3. wake any `input()` or live-data wait (`Atomics.notify`), answering it "aborted", as the browser's Stop does.

    Then it replies `{ack: "stop", gen, req, applied: true}`.
  - **If the `RUN` swap fails** (another token, or none), it replies `applied: false` and does **nothing else**: no
    `ARMED`, no `INTR`, no wakeup, no aborted answer. So a late, duplicate or stale-generation Stop has **no
    observable effect** on a newer run, whether that run is in pyjs, in `input()`, in a live-data wait or in an
    engine call.
  - Ending a call clears only its own token, so it can't erase a Stop meant for a newer call.
  - Each run starts clear.
- **The engine side:** a new feature of `engine/interrupt`, `host-word`, alongside `wasm-host`.
  - `check()` and `check_coarse()` read `ARMED`'s stop bit. Rayon helper threads read the same process-global word,
    so a parallel call stops too.
  - **No SIGINT handler** is installed: no `SigintGuard`. The launcher starts the child in its own session, with
    SIGINT ignored, so no terminal or signal path reaches it.
  - The add-on catches the `Interrupted` unwind (`sagebrush_interrupt::catch`) and returns an interrupted reply. The
    runtime turns that into `KeyboardInterrupt`, and the add-on stays usable: no instance to retire, unlike wasm's
    trap.
- **Stop against `done`, at the host (NATIVE-A-STOP-2).** Data and control travel on separate pipes, so arrival order
  across them means nothing. The host keeps one state per `(generation, host request ID)`: `running`, then
  `stop-pending`, then `terminal`. It moves to `terminal` exactly **once**, by one compare-and-set shared by every
  path.
  - **`done` first:** a `done` that arrives while the request is `running` commits it as terminal and is forwarded.
    A Stop for it is then refused at the host and never sent.
  - **Stop first:** accepting a Stop moves the request to `stop-pending` before the control frame is sent. A `done`
    that arrives while `stop-pending` is **held**, not forwarded, until the matching acknowledgement:
    - `applied: true`: the run was stopped. The `done` the worker sends (normally "interrupted") commits as terminal
      and is forwarded.
    - `applied: false`: the run had already ended in the child before the Stop reached it. **The original completion
      wins:** the held (or still arriving) `done` commits unchanged. The Stop is reported to the view as having
      arrived too late, and nothing was interrupted. This matches the browser: when WorkerKernel's Stop races
      a run that has already finished in the worker, that run's `done` still arrives and settles it as completed
      (worker-kernel.js `interrupt()`; only runs still pending at 2 s cause a restart).
  - **Hard kill:** if the request isn't terminal within the bound, the host takes the same compare-and-set to
    terminal "interrupted: restarted". In order, it then:
    1. **fences the generation** first, so every later frame from it (a held or late `done`, a late
       acknowledgement) is dropped;
    2. kills the tree;
    3. waits for confirmation;
    4. announces the restart to the other views (NATIVE-IPC-3 fanout).

    A buffered `done` or a late acknowledgement can never produce a second terminal outcome.
  - Tokens are fixed-width and atomic in both Node and Rust (a 64-bit word: `BigInt64Array` and `AtomicU64`). The
    generation retires before its token counter could wrap.

#### `input()`, live data and progress

- **`input()` and live data:** the worker asks as today: `{id, input}` or `{id, liveData}`, with its child-local
  buffer. The child main thread relays the request to the host on the data pipe.
  - The answer comes back as `{ctl: "input" | "live", gen, req, …}`. It is accepted only for the active request of
    that attachment. The main thread writes the buffer and wakes the worker.
  - Stop, a deadline or a detach answers "aborted", as the browser's `live.abort()` and `retireInputs()` do. A late
    answer writes nothing.
- **Progress:** during a run the child main thread samples the progress slots, at most 10 times a second, and sends
  the snapshots as data frames. The page shows snapshots instead of reading the shared slots.

#### Controls (N1 shows the path; N2 pins it)

- **N1:** the control path demonstrated **during a deliberately blocking add-on call**, not by the engine requesting
  its own interrupt: Stop reaches the Rust check, and a permission change reaches a busy pure-Python cell.
- **N2, permission pins:**
  - a busy cell that writes a file in a loop observes revoke **at its next write after the acknowledgement**;
  - a write between the revoke and the acknowledgement is refused at the page and the child's copy restored;
  - a delayed old allow, and an old generation's acknowledgement, can't reopen writes;
  - startup with writes off refuses the first write;
  - a lost acknowledgement, a closed control pipe and a malformed control frame each retire the generation, with
    nothing persisted after the revoke;
  - a restore of a refused path skipped when the page's revision has moved on.
- **N2, Stop pins:**
  - Stop during each of `call`, `symCall` and `mpCall`, including one rayon-parallel call;
  - a stopped call followed by a successful call in the same interpreter;
  - **the race, deterministically:** the Stop control frame held while `done` reaches the host, then released.
    The result is the single terminal outcome chosen above: the original completion when `applied: false`. Also
    the reverse order, and the hard kill racing a held `done`;
  - a late, duplicate or stale-generation Stop delivered while a **newer** request is blocked in pyjs, in
    `input()`, in a live-data wait and in an engine call, causing **no observable change** to any of them;
  - two attached views with colliding page IDs, where only the origin's active request stops;
  - an uncooperative call reaching the hard-kill bound, with exactly one terminal outcome and no later `done` from
    the retired generation;
  - no SIGINT handler installed or changed in the child.
- **N2, input and live-data pins:**
  - a blocked `input()` or live-data wait answered, stopped and detached;
  - a late answer writing nothing.

### A.3 Files and permissions

- The page delivers the read scope as `{files}`, and later `{fsPut}`, as it does for the wasm worker.
- Python's changes come back as `{fsChanged}` and enter `drainFiles()`, the queue wasm writes use, with today's
  semantics.
- Permission changes follow §A.2b: the page's gate at once, the running cell after the acknowledgement.
- Narrowing the read scope behaves as it does for the wasm worker today: files already delivered stay in the
  child's memory until it restarts. The confinement spec's existing worker semantics apply, unchanged.
- **There is no working directory on disk, no reconciliation, no freeze, no journal.**
- The host checks that every `fsChanged` comes from the registered child and its generation (stale fencing), as the
  page already does for workers.
- A forged message from a compromised child meets the same page gate as a compromised wasm worker today.

### A.4 Network

None in the child. Live data goes through the session's existing `liveData` request, answered by the host's broker
(Part B §3.2's binding to identity and generation).

### A.5 The OS policy (stricter than Part B §3.3)

| | Files | Sockets and IPC | Processes |
|---|---|---|---|
| **Linux** | Landlock, minimum ABI 3: read the runtime only; write nothing (a private temp only if N1 finds Node needs one) | seccomp: `socket()` refused for every family; plus Part B's list; executable mappings allowed for V8's JIT | `fork`/`vfork`/`clone` without `CLONE_THREAD`, and `execve` after start, refused: no children at all |
| **macOS** | Seatbelt before exec: read the runtime; no writes | `(deny network*)`, Mach lookups minimal | `(deny process-fork)` and `(deny process-exec)` after start; the hardened runtime with `allow-jit` |
| **Windows** | an AppContainer with no file capabilities; read-only runtime | no network capabilities | a Job with an active-process limit of 1 and no breakaway |

The self-check and N1's proof work as in Part B §3.3, with the stricter probes: any file write, any socket, any
child process.

### A.6 Milestones for route A

| | What | Gate |
|---|---|---|
| **N0** | This plan, reviewed; William's choice of route and the decisions of §5 | all lanes; William |
| **N1** | Spikes and measurements: **(1)** Node under §A.5's policy on macOS, Linux and Windows, with SEC's escape tests and the JIT under each sandbox. **(2)** daybreak4's measurements at one commit, A against W (in each OS's web view) and against B: the cells here, with the engine called directly (no shim), threads on and off, the > 4 GB case, startup with and without a V8 snapshot. **(3)** The framing (`v8.serialize` or JSON plus binary) by cost. **(4)** Size per OS and architecture: Node against an embedded V8 host (deno_core) against Bun, under Part B §4's budget (+40 MB compressed). **(5)** The control bridge of §A.2b: Stop reaching the Rust check during a deliberately blocking add-on call, a permission change reaching a busy cell, and the acknowledgement window measured. | SEC, ENGINE, PERF, SIZE |
| **N2** | macOS and Linux: the add-on (engine/web; nd and the SIMD kernels as separate reviewed steps), the child entry with `web/shims/fs`, the port, the control bridge with its pins (§A.2b), `engine/interrupt`'s `host-word` feature, the launcher, the engine's limits natively, broker-only network, the fallback (Part B §3.6), and the judges' native lines. **Page items** (agents-ui): the refused-write restore of §A.2b for modify, create, delete, rename and directories; the progress reader fed by the port's snapshots (one reader, no second shared-memory path); Stop through `NativeKernelPort.interrupt()`, with the hard kill using the existing restart pattern (the words go to board); a "starting" runner-pill state for the launch (0.4 s, or 1.1 s with Sage, measured in §2). **#822's option 1 ends** as in Part B's N2. | all lanes |
| **N3** | Windows | all lanes |
| **N4** | Native becomes the default. No interact or bigint gate is needed: both are the web's own. | William |
| **N5** | Later, each planned separately: **route B** for real C extensions, native terminals, Android native, warm kernels | — |

---

## Part B: route B in detail (the r3 plan)

*This is r3's text (bb03eabb), PLAN CLEAR in all five lanes as a plan for route B, unchanged except one correction
in its §2 (the browser's big integers are V8's `BigInt`). Section numbers and references inside Part B are Part B's
own. Its §7 decisions are §5 above.*

### 1. What runs, and how the app runs it

#### 1.1 The engines run native, not only the interpreter

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

#### 1.2 How the app starts it: the native runner's kernel as a sidecar (recommended)

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

#### 1.3 The adapter: page ↔ Tauri ↔ kernel (NATIVE-IPC-1)

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

#### 1.4 What the wasm kernel does today, and how the native one does it

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

#### 1.5 Rejected alternatives

- **CPython embedded in the app process (pyo3), with the engine linked into the Tauri binary.** It is one process, so
  there is no OS sandbox per document, a crash takes the app down, and there is no tree to kill.
- **The wasm engine under wasmtime outside the web view.** It is still wasm32, which is what William ruled out.
- **The user's own Python and packages.** That is later (N5); it can't be sandboxed or versioned with the app.

### 2. Measured: native engine against wasm, same version

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
  V8's `BigInt` (corrected in r4: r3 said Sagebrush's Rust bigint; see §2 above). N2 owns a representation and
  dispatch design:
  - mixed `int`/`Integer` operands;
  - exact result types and Sage semantics;
  - interrupt and limit propagation;
  - thresholds;
  - parity and performance controls for multiply, division, gcd, power and factorial.

  **Native does not become the default (N4) until the routed large cases match or beat wasm without regressing
  ordinary integers.**
- **Limits:** this is V8, not the app's web views (JavaScriptCore on macOS and Linux); it is one machine, and the
  cells are mine. N1 re-measures (§6).

### 3. Enforcing "File writes" and "Network" for native code

The confinement spec (r3.2) defines two switches per document and the host's authority (§4.1). It labels a native
kernel "unconfined" (§4.4). Inside the app this plan makes the native kernel **confined**:
- the host's policy is the authority;
- the engine has no permission logic and no way to change grants.

The native semantics differ from the browser's in two stated ways (§3.1, §3.5); both go to William (§7).

#### 3.1 Files: delivery in, one transaction out (NATIVE-DIFF-1)

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

#### 3.2 Network: none in the kernel

- The OS policy (§3.3) refuses every socket. The kernel has only its inherited stdio pipes.
- Live data, the remote relay and any future fetch go through the host's one connection broker (spec §4.1,
  CONF-NET-1) over the same pipes. Each request is bound to the registered kernel's **document identity and
  generation**, known to the host by the pipe it came on and never by a field in the message, and is bounded in size
  and rate.

#### 3.3 The OS policy, per platform: a minimum contract (NATIVE-OS-1)

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

#### 3.4 The trusted launcher: no ambient authority before confinement (NATIVE-BOOT-1)

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

#### 3.5 Revoke: restart, in order (NATIVE-REVOKE-1, a William decision)

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

#### 3.6 When native confinement isn't available: today's behaviour, not looser (NATIVE-FALLBACK-1)

- A kernel that fails launch, policy or self-check is **killed and retired** before anything else runs for that
  document. Its generation is fenced, and its started cell is never replayed.
- The document then gets **exactly the app's current behaviour**, #822's option 1:
  - a notebook allowed to change files runs on the plain wasm worker, as today;
  - one that isn't allowed is refused with the existing Allow flow.

  It never gets a plain wasm worker that today's policy wouldn't allow, and never an unconfined native process.
- The page says which mode is available and why (the words go to COPY).
- Spec §4.4's kernels (a remote runner, Jupyter, `sagebrush remote` on a server) stay as the spec says.

### 4. Size, install and startup, and signing

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

### 5. What stays wasm

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

### 6. Milestones

| | What | Gate |
|---|---|---|
| **N0** | This plan, reviewed; William's decisions (§7) | all lanes; William |
| **N1** | Spikes and measurements, no product code. **(1)** The launcher and §3.3's complete minimum policy on macOS, Linux and Windows, with SEC's escape tests: sockets of every family, local IPC, write and read outside, descendant escape (`setsid`, double fork, Job breakaway), ptrace, Stop, close and revoke lifecycle; and the macOS descendant decision (§3.3). **(2)** daybreak4's measurements at one commit in the app's own web views (JavaScriptCore on macOS arm64 and Linux x86_64, WebView2 on Windows x86_64): for each parallel cell, native at `threads=1` and in automatic mode with the pool size recorded, against wasm; a specified **> 4 GB case** (native completes with peak RSS and time recorded; wasm reaches its memory limit or fails cleanly); enough independent process runs for medians and variability; and §4's startup breakdown. **(3)** The CPU-dispatch decision A or B (§1.1), profiled first. **(4)** §4's size gate against the budget. **(5)** The IPC cost of large payloads. **(6)** The freeze barrier of §3.1 on each platform (a delegated cgroup v2 freeze on Linux, the single-process `task_suspend` on macOS, the Job's process limit and suspension on Windows), with controls: a background thread writing in a loop through reconciliation, a child forking repeatedly during the freeze, a child created between the cell's end and the freeze, and a failed freeze retiring the generation. Where no barrier is established, that execution mode is denied. **(7)** Destination resolution from a held root (`openat2`, `O_NOFOLLOW_ANY`, `FILE_OPEN_REPARSE_POINT`) on each platform, with the substitution controls listed under N2. | SEC, ENGINE, PERF, SIZE |
| **N2** | macOS and Linux: the bundled runtime and wheel (same commit), the launcher, `NativeKernelPort` (§1.3) with adapter-level tests for every mapping and transition, the reconciliation transaction (§3.1) with pins (refused modify, create, delete and rename followed by another cell; an external edit during a run; a mixed admitted and refused batch; Stop; crash; close; a second view), the new page API `files.applyBatch` (wasm keeps `drainFiles()`), the disk journal with controls (an I/O failure injected at each commit step, rolled back with nothing changed; a failed rollback, reported as partially applied with each path named; a crash at each journal state, recovered before the document's next kernel starts; a narrowed grant and a revoke during commit; a late external conflict on the last file; a workspace transaction abort; a subfolder change in a disk document, refused), destination controls (a destination parent replaced by a symlink or junction between delivery and commit; a parent renamed; a target replaced by a link; each end of a rename and a delete target substituted), barrier controls (a failed restore retiring the generation; a writer that would run before restore finishes never sees staged bytes), revoke ordering (§3.5), broker-only network, the fallback (§3.6), NAT-BIGINT-1, CPU dispatch if N1 chose B. **The self-test judges** (`app/selftest/android-report.py`, `run-judge.mjs`, `ios-judge.py`) gain the native lines in the same PR. **#822's option 1 ends:** `NEEDS_RUNNER` ("the app has no sandbox") and its branch change; the self-test stops allowing by default; both cases are pinned (allowed means writes go through the gate; not allowed means refused at reconciliation and nothing written). | all lanes |
| **N3** | Windows: the AppContainer, the Job and the control-message Stop | all lanes |
| **N4** | Native becomes the app's default, once NAT-BIGINT-1's controls pass **and** interact and widgets reach parity natively, or notebooks that use them are routed to wasm under §3.6's rules, so `@interact` notebooks don't regress; the wasm fallback stays | William |
| **N5** | Later, each planned separately: the user's own Python, native terminals in the app, Android native, warm kernels, a FUSE or ProjFS file view | — |

### 8. Grounding (r3)

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

## Grounding (r4)

- master b9a712b4 (Nov 7 2026); the v0.6.0 tag (dbdf5984) for the spike;
- src/runtime/engine.ts (`_sbengine`: `sb_call`, `sb_sym_call`, `sb_mp_call`), engine/web/src/lib.rs (`pub fn
  call`), engine/node (an earlier, partial napi-rs add-on, not wired to pyjs);
- src/notebook-session.ts (the protocol; run by web/worker.ts and by src/notebook.ts in a Node worker thread),
  web/shims/fs.ts (the in-memory files and `setWritable`), web/shell (just-bash);
- engine/py/python/sagebrush/sage.py ("the same Python files implement Sage mode in the browser");
- engine/interrupt/src/lib.rs (the wasm host flag and the native SIGINT handler);
- the evidence in §2: /scratch/sagebrush-reviews/remote-compute/native-bench-0.6.0-r4-routes/;
- Node's permission model: nodejs.org/api/permissions.html (a "seat belt", not a defence against malicious code);
- the r3 reviews: /scratch/sagebrush-reviews/pr825-bb03eabb-*.md and the updated pr825-81e508e7 files.
