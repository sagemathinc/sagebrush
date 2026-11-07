# Native engines in the desktop app

*Status: plan r10: r9 (cleared by all five lanes at 6849c320) with William's §7 answers recorded. Docs only; nothing is built. Owner and sole author: @sagebrush-remote-compute. The r8 base
was drafted by @sagebrush-daybreak3 at @sagebrush's request. Reviewers: astra (SEC), daybreak3 (ENGINE), daybreak4
(PERF), daybreak2 (SIZE), agents-ui (app). William decided the interpreter route and the sandbox question on Nov 7,
2026 at about 7:54 AM PST, and added Electron as a first-class candidate at about 8:03 AM PST. This revision replaces
r7's one Node layout with a comparison of the real ways to build the chosen route. It also replaces r4's A-vs-B
timings, which were invalid (§3).*

## In plain words

- The desktop app will run **the same Python interpreter as the website**: Sagebrush's pyjs, not CPython. The Rust
  engines run as native machine code, with native threads and a 64-bit address space. The website, phones and tablets
  keep WebAssembly.
- The plan does **not** add an operating-system sandbox. Sagebrush enforces File writes and Network in pyjs and at
  the host's control bridge, as the website does. That is application permission enforcement. It doesn't contain a
  bug in the JavaScript runtime, the Rust engine or the desktop host, and the plan doesn't claim it does.
- There are several ways to put pyjs and the native engine in a desktop app (§2). They differ in which JavaScript
  engine runs pyjs and the UI, the download size, startup, and whether an engine call is a direct call, an N-API call
  or serialized IPC.
- Measured at one commit (§3), the native engine is **about 2.0–2.6× faster than WebAssembly** on the engine cells,
  through the same pyjs. These are observed medians on a loaded machine, not precise speedups. Pure Python stays at
  the website's speed.
- **Recommendation: keep Tauri and add one bundled Node process per document, with the engine as a narrow N-API
  add-on** (candidate 1). It is the smallest change: the spike already runs today's pyjs engine calls on V8, the Tauri
  app and its iOS/Android builds stay, and a separate process makes crash and restart simple.
- **Electron (candidate 2) is a valid alternative.** It uses one V8 engine for both the UI and pyjs on every OS. Its
  costs are a larger download, a port of the desktop shell off Tauri, and a separate shell for iOS/Android, which
  Electron doesn't build. The download difference is **about +50 MB, a derived, provisional estimate**: roughly 93 MB
  against roughly 40–45 MB. That comes from measured Linux runtime parts (Electron 90.1 MB compressed; Node plus the
  add-on 30.3 MB), plus the README's 10–15 MB for today's app, which wasn't re-measured. N1's matched signed
  installers are authoritative. N1 builds both, packaged, and measures them side by side before N2 starts.
- Startup of about a second with the Sage library is **worrying but can be optimized**. As William said, it stays an
  N1 measurement and optimization item, not a reason to choose one candidate over another.

## 1. Decisions and fixed boundaries

### 1.1 William's decisions

1. **Interpreter route A is chosen:** "I think obviously we do option A 'the same Python interpreter the website
   uses'." Route B (bundled CPython plus PyO3) is not the desktop v1 plan. Real CPython and C extensions may come
   later, as a separately designed feature.
2. **No OS sandbox is part of this plan:** "I do not think OS sandboxing should be part of our plan, since that is just
   at the wrong level and adds a lot of complexity and reduces the ability of people to run this software." So there is
   no Landlock, seccomp, Seatbelt, AppContainer, JIT-entitlement-under-sandbox work or escape-test gate. The r1–r7
   sections that required them are removed.
3. **Electron is a first-class candidate:** "This could be a reason to switch to Electron which is another completely
   valid native option, right?" (about Tauri's JavaScriptCore on macOS and Linux). §2.1 compares it head to head.

### 1.2 What every candidate must preserve

- **One interpreter:** `src/runtime` pyjs and `lib/`, including Sage, Magma, MATLAB, numpy, displays and `@interact`.
- **One narrow engine ABI:** the operations pyjs calls today (`call`, `sym_call`, `mp_call`). Native builds of
  `engine/nd` and the other kernels come later, each reviewed separately. Python can't receive a Node, Tauri, FFI,
  native-pointer or host object. It sees only validated values and the in-memory web file shim.
- **Application permissions:** Python uses `web/shims/fs`, not the host `fs` of Node, Deno or Bun. File changes go
  back through the page's existing change queue and permission gate. Live data and network requests go through the
  existing host broker. Python has no supported API for sockets, subprocesses or the host filesystem.
- **Control ordering:** generation, permission version, acknowledgement, retirement and Stop linearization are the
  contracts of §5. They apply whatever the transport is: child pipes, Tauri IPC, Electron MessagePorts or an
  in-process V8 op.
- **No containment claim:** these checks govern supported Sagebrush operations. Without an OS sandbox, a defect in, or
  a deliberately introduced escape from, native code or the host is outside the permission model. The document never
  calls the kernel "sandboxed", and never claims that the permission switches contain arbitrary native code.

## 2. Architecture candidates

Ordered by estimated **product implementation complexity**, not download size. Sizes are xz-compressed Linux x86_64
runtime payloads, measured where marked (`sizes.txt` of r4, `electron-size.txt` of r8). Startups and memory are N1
measurements unless marked.

| Candidate | Where pyjs runs; JS engine on macOS / Windows / Linux | Engine crossing | Added payload | Startup | Complexity and status |
|---|---|---|---|---|---|
| **1. Tauri + bundled Node process + N-API (recommended)** | pyjs in Node: **V8 / V8 / V8**. The UI stays in the system webview: **JSC / V8 (WebView2) / JSC (WebKitGTK)**, so macOS and Linux ship two JS engines | synchronous **N-API** inside the Node process; framed IPC only between it and the Tauri host | **measured: Node 27.3 MB + add-on 3.1 MB ≈ +30 MB** on top of today's app (README: installers about 10–15 MB; not re-measured here) | spike: 0.4 s to the first line, 1.1 s with Sage (r4); packaged: N1 | **The smallest code change.** Keeps Tauri 2, its iOS/Android builds and today's pyjs engine calls; r4's spike and r5–r7's control design exercise it. Costs: an extra runtime, two JS engines on macOS/Linux, a child process to manage. |
| **2. Electron + Node utility process + N-API** | Chromium UI and pyjs in a Node utility process: **V8 / V8 / V8** for both | synchronous **N-API** in the utility process; MessagePorts to the UI | **measured: Electron v45.2.3 runtime 90.1 MB** (287 MB unpacked); + add-on 3.1 MB ≈ **+93 MB**, replacing Tauri's ~10–15 MB | N1 | One engine family for the UI and pyjs everywhere. Engine integration is as simple as candidate 1. The shell port is real work (§2.1), and iOS/Android stay on Tauri, so there are two shells. |
| **3. Tauri + embedded V8 (`deno_core`/`rusty_v8`)** | pyjs in V8 embedded in the Tauri process: **V8 / V8 / V8**; the UI stays **JSC / V8 / JSC** | **direct Rust calls** to the linked engine; no Node, no N-API | estimate **+20–35 MB** (rusty_v8's release static library is 40.3 MB gzipped for Linux; linked size is N1) | N1; V8 snapshots may help | A direct boundary in one process. More runtime engineering becomes ours: module loading, workers, timers, structured data, snapshots, debugging, updates. A crash takes the app down unless pyjs gets its own process. `deno_core` 0.413 is a core, not Node or a browser. |
| **4. Tauri + system webview, engine linked into the Rust core** | today's page and worker: **JSC (WKWebView) / V8 (WebView2) / JSC (WebKitGTK)** | Tauri commands/channels: **asynchronous serialized IPC** to direct Rust calls | **smallest: no extra JS runtime** | likely lowest; N1 | **Not a drop-in.** Tauri's `invoke()` returns a Promise, while pyjs's engine calls are synchronous. N1 must prove a bridge that doesn't deadlock, keeps Stop ordering and copies acceptably. pyjs runs on JSC on macOS/Linux, with its big-integer profile (§3.3). |
| **5. Tauri 3 CEF runtime, engine linked into the Rust core** | bundled Chromium: **V8 / V8 / V8** | as candidate 4 | Tauri's docs: hundreds of MB larger | N1 | Removes the JSC difference but keeps candidate 4's sync-to-async bridge. `tauri-runtime-cef` is **3.0.0-alpha.7** (crates.io, Nov 6, 2026); Tauri 3 with CEF is an API-unstable alpha. **Not a v1 foundation.** |
| **6a. Tauri + Bun single-file process + N-API** | Bun: **JSC / JSC / JSC** | N-API in the process; framed IPC to Tauri | measured: Bun 24.8 MB + 3.1 MB ≈ **+28 MB** | N1 | The same add-on file loads (r4 smoke). JSC's big-integer profile applies (§3.3). |
| **6b. Tauri + Deno single-file process + N-API** | `deno compile`: **V8 / V8 / V8** | Deno's Node-API (the add-on is materialized locally); framed IPC | measured: Deno 30.9 MB + 3.1 MB ≈ **+34 MB** | N1 | V8 in a standalone binary, but native add-ons need extraction details and a larger compatibility surface than Node. |
| **7. Deno Desktop instead of Tauri** | Deno's V8 backend, with the system webview (**JSC/V8/JSC**) or CEF (**V8 everywhere**) | Node-API in Deno | webview: unknown; CEF: Deno's docs estimate about 150 MB for the framework | N1 | A real extra candidate: Deno 2.9 ships both backends. It replaces Tauri and is young. It doesn't beat candidate 1 on v1 complexity. |

### 2.1 Electron head to head with candidates 1 and 3

| | **1. Tauri + Node** | **2. Electron** | **3. Tauri + embedded V8** |
|---|---|---|---|
| JS engine for the UI | system webview: JSC on macOS/Linux, V8 on Windows | **V8 everywhere** (Chromium) | system webview |
| JS engine for pyjs | **V8** (Node) | **V8** (Node in a utility process) | **V8** (embedded) |
| Where pyjs runs | a Node child per document; a worker thread inside it runs `notebookSession` | a utility process per document (`utilityProcess.fork`); a worker thread runs `notebookSession` | a V8 isolate in a Rust thread, or its own process |
| How the engine is loaded | `require()` of the N-API add-on in the child | `require()` of the N-API add-on in the utility process (rebuilt against Electron's Node ABI, or using N-API's stable ABI) | linked into the binary; ops are Rust functions |
| Added download, Linux x86_64, measured | **+30.3 MB** (Node 27.3 + add-on 3.1) over today's ~10–15 MB app | **≈ 93 MB** total runtime (Electron 90.1 + add-on 3.1), instead of Tauri's | estimate +20–35 MB |
| Download on macOS and Windows | N1 (Node is a similar size) | Electron's release zips: 121 MB (macOS arm64), 125 MB (macOS x64), 158 MB (Windows x64); installers compress further; N1 | N1 |
| Memory | Tauri host + webview + one Node process per document; N1 measures the whole process tree | Chromium's browser, GPU and renderer processes + one utility process per document; N1 measures the whole tree | one process; N1 |
| Startup | Node itself 43–58 ms (r4); pyjs boot dominates; N1 | Chromium start + utility process; N1 | V8 start + pyjs; snapshots; N1 |
| Security updates (maintenance on every candidate) | the system webview updates with the OS; Node is pinned by us, with its own CVE cadence | a new Electron major **every 8 weeks**; only the **latest three** are supported, so we ship a Chromium update at least every ~6 months, sooner for security fixes | V8 pinned by us through rusty_v8; we track V8 security fixes ourselves |
| Moving today's app | none | port `app/src-tauri`: 202 lines of Rust (4 commands: `startup_files`, `selftest_file`, `selftest_report`, `app_log`), the dialog, fs and localhost plugins, the capabilities file, file associations and bundling to Electron's main process, preload and electron-builder. Replace the Tauri uses in the page (24 in web/index.html, plus web/board/page.ts and web/notebook/terminal-probe.js and their tests) with a preload API that keeps the same interface. The localhost plugin serves the page at 127.0.0.1 with COOP/COEP, so Electron needs a protocol handler sending the same headers. No updater is in use yet. Signing needs the same Apple and Windows accounts. **iOS and Android stay on Tauri 2:** two shells. | none for the shell; a new Rust host for V8 |
| Complexity | lowest | moderate: the shell port and two shells | highest runtime engineering |

**What JSC means here.** pyjs runs on JSC only in **candidate 4 on macOS and Linux** and **candidate 6a on every OS**.
Candidates 1, 2, 3, 5, 6b and 7 keep pyjs on V8, even where a separate UI webview is JSC. Electron's real advantage over candidate 1 is one
engine for the UI as well, so a page tested in Chrome behaves the same in the app. Its costs are the size, the
8-week update treadmill and two shells.

### 2.2 Recommendation and fallbacks

**Build candidate 1 first.** It alone combines pyjs on V8, today's synchronous engine calls, a measured add-on
spike, an unchanged Tauri shell (desktop and mobile), and independent crash and restart per document.

N1 builds **candidates 1, 2 and 3 as packaged comparisons**, with the same UI payload and the same engine commit, and
spikes candidate 4's boundary.
- **Electron (2)** becomes the lead if its measured size, memory and startup are acceptable to William, and one V8
  engine for the UI is judged worth the shell port and the second (mobile) shell.
- **Candidate 4** becomes preferred if it keeps the interpreter contract without blocking the UI's event loop and
  passes the control-race pins. Its JSC big-integer profile must be acceptable on the workload corpus, or answered
  by per-operation Rust dispatch (§3.3).
- **Candidate 3** is the fallback if bundling Node is unacceptable but V8 is required.
- The others are measured alternatives, not parallel implementation tracks.

## 3. Performance evidence: one commit

### 3.1 r4's A-vs-B timings are invalid

r4 compared W and A (engine at the v0.6.0 tag, `dbdf5984`, Oct 23) with B, which used the **PyPI wheel "sagebrush
0.6.0"**. That wheel was built from **`61a18002` (Oct 7)**: PyPI and npm number their versions separately, and the
tag's own `engine/py` already says 0.7.2. So r4's A-vs-B rows compared different engines and are withdrawn, along
with every conclusion drawn from them. r8's packet rebuilds B from the tag.

### 3.2 The same-commit packet

- **Evidence:** `/scratch/sagebrush-reviews/remote-compute/native-bench-r8-dbdf5984/` (frozen, SHA256SUMS), together
  with daybreak4's two packets: `/scratch/sagebrush-reviews/daybreak4/pr825-r8-aplist-decomposition/` and
  `.../pr825-r8-jsengines/`. daybreak4 reviewed the packet itself as PERF CLEAR (checksums, commit pins, build,
  method). The wording here is reviewed with r8.
- **Every engine is `dbdf5984`:**
  - **W:** the npm CLI, pyjs plus wasm, under Node v26.13.0.
  - **A:** the same CLI with its engine calls on the N-API add-on (r4's shim).
  - **D:** the add-on called directly from Node, with no pyjs and no shim: the call, then `JSON.parse`.
  - **K:** the kernels alone, in Rust.
  - **B, reference only:** CPython 3.14.4 with a maturin wheel built from the tag.
- **Build:** rustc 1.99.0. Every Rust build uses opt-level 3, `lto = true` and `codegen-units = 1`, with no RUSTFLAGS
  and no `target-cpu`. The rayon pool is 32 threads; the `1` columns use `RAYON_NUM_THREADS=1`.
- **Method:** each cell gets a warm-up, then the median of 3 (5 for D and K). There are 5 counted processes per
  configuration, and the tables give the median of the per-process medians.
- **Load:** the configurations ran one after another on a loaded machine, at a 1-minute load of 9.9–28.0, recorded
  per process (W 20.5–28.0, A 16.8–20.6). So the **A-vs-W ratios are approximate observed medians**, not precise
  stable speedups; read the ranges. N1's interleaved packaged runs are authoritative. The causal findings (`factor`
  converging, the direct and kernel decompositions) are much stronger than small ratios between configurations.
- **factor is deterministic everywhere:** a rho seed of `0x9E3779B9`, then an ECM seed of `0x2545F4914F6CDD1D`,
  sequential, through the same `classgroup` `factor_integer` in web, PyO3 and Rust.

| Engine cell | W (wasm) | **A** (N-API, via pyjs) | D (add-on direct) | K (kernel alone) | B (reference) | **A vs W** |
|---|---|---|---|---|---|---|
| `det` 200×200 | 183.7 (167.7–212.1) | **90.2** (87.7–97.7) | 48.8 + 0.0 parse | 44.5; with JSON 47.5 | 70.0 | **≈2.0×** |
| `factor` 41 digits | 611.8 (578.6–703.3) | **248.5** (244.2–285.9) | 247.5 | 243.9 | 247.4 | **≈2.5×** |
| `aplist(200000)`, 32 threads | 100.6 (98.1–116.5) | **38.7** (36.2–51.5) | 25.5 + 2.0 parse | 19.3; with JSON 24.8 | 25.1 | **≈2.6×** |
| `aplist(200000)`, 1 thread | — | 105.1 | 83.4 + 2.1 | 78.1; with JSON 83.1 | 81.3 | |

(ms, median of the 5 per-process medians, with their range.)

**What this shows:**
- **`factor` converges:** the kernel, the direct call, A and B are all 244–249 ms. r4's gap was the old wheel.
- **`aplist`:** the result is **17,984 (p, a_p) pairs**, which engine/web's JSON makes 226,270 bytes.
  - The kernel takes 19.3 ms. JSON generation adds about 5.5 ms, and parsing about 2 ms (daybreak4's decomposition
    agrees: 5–11 ms of JSON and 2–3 ms of copying and parsing).
  - A then adds about 11 ms in pyjs, turning the pairs into Python objects, plus the spike's shim.
  - So A's gap to B is the data format and the wrapper, not the engine or build flags. A binary reply format and
    the shim's removal are N2 work, measured in N1.
- **`det`:** the kernel is 44.5 ms. A's extra time over the direct call (~41 ms) is pyjs building the matrix and its
  137 KB request. That is pyjs work, the same on the website.
- **Threads matter:** with one thread, `aplist` is about wasm's speed. All the native gain on that cell comes from
  rayon's 32 threads.

### 3.3 Pure Python and big integers: the JS engine and the Rust engine

| Cell | W = A (pyjs on V8) | pyjs on JSC (Bun; daybreak4 jsengines) | K (Rust engine, dashu) | B (CPython, reference) |
|---|---|---|---|---|
| `fib(27)` | 9.6 / 10.2 | — | — | 21.8 |
| 10⁶-iteration loop | 28.9 / 34.5 | — | — | 57.0 |
| 200,000-key dict, sorted | 467.3 / 447.2 | — | — | 123.8 |
| `factorial(60000)` | 11.5 | 85.0 | 15.8 (product tree) | 54.3 |
| 317,000 × 456,000-bit multiply | 2.6 | 36.2 | 3.2 | 21.2 |
| the matching division | 11.6 | 112.7 | 8.2 | 59.9 |
| `gcd`, 91,700 and 96,400 bits | 1364.8 / 1341.4 | 120.1 | **3.5** | 12.4 |

- **The gcd row is not a route difference.** pyjs computes `gcd` in JS `BigInt`; CPython uses its C code. The Rust
  engine does it in 3.5 ms. Routing big `gcd` to the engine fixes it **for the website too**, through wasm.
- **JSC is workload-dependent, not uniformly slower:** 7.3× slower than V8 on factorial, 13.4× on multiply and 9.8× on
  division, but **11.2× faster on this gcd**. These ratios come from daybreak4's packet, which ran identical pyjs on
  both engines (V8 medians 11.6, 2.7, 11.5 and 1347 ms there). Factorial alone neither requires Rust routing nor selects Electron.
- **Rust dispatch is per operation and size.** The Rust engine is best here for gcd and division, close to V8 for
  multiply, and slower than V8's factorial. N1 benchmarks a real big-integer corpus in the real system webviews and
  then chooses per-operation, per-size dispatch, counting the crossing cost and exact result semantics (an N2 ENGINE
  gate). It matters for the candidates where pyjs runs on JSC: 4 on macOS and Linux, and 6a everywhere.
- **Pure Python:** A keeps pyjs's V8 speed. The dict/string gap is pyjs's own and shows on the website today.
- **Startup** (r4, unchanged): A takes about 0.4 s to the first line and about 1.1 s with Sage. It is an N1
  optimization item (V8 snapshots, lazy library loading), not a gate.

## 4. Candidate 1 in detail

### 4.1 Processes and data path

- Tauri owns one child generation per stable document identity. Views attach with host-minted IDs; page request IDs
  never become child authority.
- The pinned Node child's main thread owns the bounded host pipes and the control words. A worker thread runs
  `notebookSession` with `web/shims/fs` and the same pyjs and lib bundles as the website.
- The add-on exports only the fixed engine ABI and the control functions. It exports no general FFI, host objects,
  file descriptors, Node callbacks, `require`, Tauri handles or arbitrary Rust entry points to Python.
- `NativeKernelPort` maps the worker protocol to bounded frames. Large files and outputs use binary frames; framing
  and copy costs are N1 measurements.
- Engine modules without a reviewed native build stay wasm inside the child, so native adoption is incremental.
- Under candidate 2 the same design holds, with Electron's utility process in place of the Node child and
  MessagePorts in place of pipes.

### 4.2 Application permission enforcement

- **Files:** the host delivers `{files}`/`{fsPut}` to the in-memory shim. Python's writes produce `{fsChanged}` and
  enter the page's existing change queue. The page admits durable changes only while File writes is on. The child has
  no supported host filesystem API.
- **Network:** Python's live-data requests cross the session protocol to the host broker. The child has no supported
  direct socket API.
- **Revocation:** the page's durable gate closes immediately. The versioned control below reaches a busy child. A
  write made in the child's memory inside the window is refused at the page and conditionally restored in the child.
- These are application boundaries. They don't contain a defect in Node, the add-on, Tauri or native memory.

## 5. Control bridge (from r5–r7, independent of transport)

### 5.1 Boundaries

| Candidate 1 boundary | What crosses it |
|---|---|
| Tauri host ↔ child main thread | separate bounded data and control frames, so large data can't queue behind Stop or permission. Malformed framing retires the generation. |
| child main thread ↔ pyjs worker | child-local `WRITABLE`, `INTR`, `RUN`, progress and input/live-answer buffers, created before the worker starts. The Node entry is given them explicitly: no `crossOriginIsolated` test and no between-runs fallback. A child without them refuses to start. |
| child main thread ↔ add-on | narrow control exports and the process-global `ARMED`. The main thread never runs pyjs or an engine call. |

Other candidates may replace the transport, but must keep the authority, ordering and outcomes below.

### 5.2 Permission version and retirement

- The host keeps a monotonic `pv` per (identity, generation) and sends `{writable, gen, pv, on}`. Only a matching
  generation with a strictly newer `pv` is applied and acknowledged, so a stale allow can't reopen writes.
- At startup the current permission is applied before the session starts; `ready` echoes `pv`, and no run comes
  before it.
- The page's durable gate closes immediately and drops changes from stale generations.
- A refused change made in the child's memory (modify, create, delete, rename, directory) is restored only while the
  generation, `pv` and the page's revision of that path still match, **checked when the restore is applied**. A newer
  revision, grant or run is never overwritten.
- A missing acknowledgement, a malformed control frame or a closed channel retires the generation. N1 measures the
  window and sets the deadline from evidence.

### 5.3 Stop linearization (NATIVE-A-STOP-1/2/3)

- Each run has a unique 64-bit token (`BigInt64Array` and `AtomicU64`). The generation retires before the counter
  could wrap.
  - `RUN = token*2 + stopbit` is visible to pyjs; the add-on's `ARMED` has the same layout.
  - Around each add-on call, the add-on arms and clears only its own token.
- Stop's only child-side decision is `RUN: token*2 → token*2+1`.
  - Only a successful swap may stop `ARMED`, set `INTR`, wake waits and return `applied: true`.
  - A failed swap returns `applied: false` and changes no word, wait or answer.
- Before its terminal `done`, the worker retires `RUN`:
  - `token*2 → 0` keeps the original completion;
  - if the Stop won, `token*2+1 → 0` makes the run interrupted and clears `INTR`.

  That retire, racing the Stop, is the one race that decides the outcome.
- Rust checks and rayon helpers read `ARMED`, and an interrupted call leaves the add-on reusable. Stop never uses a
  signal, and no SIGINT handler is installed in the child (`engine/interrupt`'s new `host-word` feature).
- The host has one terminal compare-and-set per (generation, request), shared by `done`, Stop and the hard restart.
  - `done` first: the completion stands.
  - Stop first: the host holds `done` until the acknowledgement. `applied: false` releases it unchanged, and
    `applied: true` ends the run interrupted.
  - A timeout fences the generation before terminating the child, and yields exactly one result.
- A Stop that comes too late shows nothing to the person, as in the browser. Any wording is board's, the same in
  both kernels.

### 5.4 Input, live data, progress and pins

- Input and live-data answers bind to the generation, the attachment and the active request. Stop, detach or a
  deadline aborts them, and late answers do nothing. Progress snapshots go to the page's single reader at most ten
  times a second.
- Deterministic pins cover:
  - **permission:** a busy cell, in-window refusal and conditional restore, a stale allow or generation, startup
    with writes off, and channel failures;
  - **Stop:** every engine ABI call and rayon, reuse by the next call, both `done`/Stop orders, the hard restart,
    a stale Stop against newer pyjs, input, live-data or engine work, colliding view IDs, and exactly one terminal
    result.
- The held-control pin asserts that `RUN == 0` before `done` leaves the worker, that the released Stop reports
  `applied: false`, that `INTR` stays clear, and that the next run succeeds.

## 6. Milestones

| | Work | Gate |
|---|---|---|
| **N0** | The plan reviewed (r9 cleared by all lanes) and William's §7 answers recorded: the lead is decided after N1's measurements | all lanes; William (done) |
| **N1** | No product integration. **(1)** Build packaged comparisons of **1 (Tauri + Node), 2 (Electron utility process) and 3 (Tauri + embedded V8)**, with the same UI payload and engine commit; spike 4's boundary and resolve its sync-engine/async-IPC design. **(2)** Prove pyjs boot, native calls, Stop, busy-cell permission and crash/restart. **(3)** Measure per OS: the compressed signed installer and update delta, installed size, cold and warm launch to runner-ready, first and steady engine calls, idle memory as RSS/PSS of the whole process tree after first paint and after the pyjs worker is ready, the > 4 GB case, framing copies, and the permission acknowledgement window. **(4)** The big-integer corpus in the real system webviews, and per-operation Rust dispatch thresholds (§3.3). **(5)** Startup optimization (snapshots, lazy loading): a target, not a gate. **(6)** Before rich output moves into frames in the desktop app, #826's output-frames harness in each candidate's UI engine (WebKit for 1, 3 and 4; Chromium for 2 and 5). **(7)** The upgrade path of each candidate, bundled and downloaded (William, §7): the update delta size, the auto-update mechanics, and updating the runtime and the engine add-on with the app or apart from it. **(8)** Unsigned local builds only; signing is William's (§7). | ENGINE, PERF, SIZE, SEC (application boundaries) |
| **N2** | macOS and Linux, the chosen candidate: the pinned runtime, the `web/shims/fs` worker, the native `engine/web` add-on, a binary reply format, the port, the §5 bridge and its pins, native limits, broker-only supported network, per-engine wasm fallback, and the page items (refused-write restore per change kind, progress from port snapshots, Stop through `NativeKernelPort.interrupt()` with the restart pattern for the hard kill, a "starting" pill state, and the native kernel's own words for "where code runs" and "didn't start": the runner-sandbox messages don't apply, and board writes the words). Later engine modules are reviewed separately. **#822's option 1 ends.** | all lanes |
| **N3** | Windows parity for N2 | all lanes |
| **N4** | Native becomes the desktop default, after parity, limits, corrected performance, size and the big-integer dispatch decision close | William |
| **N5** | Planned separately later: CPython and C extensions, terminals, Android native, warm kernels | — |

## 7. William's decisions

Already decided: pyjs (route A); no OS sandbox; Electron is a first-class candidate.

William answered §7 on Nov 7, 2026 at about 9:30 AM PST:

1. **The lead architecture:** "Decide after the prototype's side-by-side measurements." N1 goes ahead with packaged
   prototypes of candidate 1 (Tauri + Node + N-API), 2 (Electron) and 3 (Tauri + embedded V8), measured side by side
   at one commit on each OS. N1 builds measurement prototypes only: nothing ships and nothing is released.
2. **Bundle the runtime or download it on first use:** "it depends - easy upgrades are just as important to get
   right." N1 measures and compares the upgrade path of each option: the update delta size, the auto-update
   mechanics, and how the runtime and the engine add-on are updated with the app or apart from it.
3. **Signing:** "I (William) own them; agents never touch the keys." N1 makes unsigned local builds only. No agent
   handles signing accounts, certificates or keys.

There is no "unconfined mode" switch. Without an OS sandbox, that label would suggest a boundary the plan doesn't
provide. The UI describes only where code runs and the application permissions.

## Appendix: what r8 removes or corrects

- CPython/PyO3 is no longer a competing v1 plan. r3 is historical input to a separate, future proposal.
- Landlock, seccomp, Seatbelt, AppContainer, Job objects as containment, JIT-under-sandbox entitlements, the sandbox
  fallback and escape probes are removed from the milestones and gates.
- r4's A-vs-B timings are invalid (B used a different engine commit) and are replaced by §3's same-commit packet.
- r4's big-integer reading is corrected: JSC is not uniformly slower, and Rust dispatch is per operation and size.
- r5–r7's permission-version and Stop contracts stay. They are application ordering and lifecycle contracts, not OS
  sandboxing.

## Grounding

- master at review time, and the v0.6.0 tag `dbdf5984` for every measurement;
- `src/runtime/engine.ts` (`_sbengine`), `engine/web/src/lib.rs` (`pub fn call`), `src/notebook-session.ts`,
  `web/worker.ts`, `web/shims/fs.ts`, `web/notebook/worker-kernel.js`, `engine/interrupt/src/lib.rs`,
  `classgroup/src/nf/factor.rs`;
- `app/src-tauri` (lib.rs, Cargo.toml, capabilities/default.json, tauri.conf.json, gen/android, gen/apple) and
  `app/README.md`;
- the evidence in §3 and r4's `sizes.txt`;
- external, checked Nov 7, 2026:
  - Tauri's process model and IPC: v2.tauri.app/concept/process-model, v2.tauri.app/concept/inter-process-communication;
  - Tauri CEF: v3.tauri.app/develop/cef, and crates.io `tauri-runtime-cef` (3.0.0-alpha.7, Nov 6);
  - `deno_core` (crates.io 0.413.0); rusty_v8 v152.2.0 release assets;
  - Electron: the process model and utility processes, native modules, the release timeline (8-week majors, the
    latest three supported), and the v45.2.3 release assets;
  - Bun's compiler; Deno compile and Node-API; Deno Desktop.
