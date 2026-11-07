# Native engines in the desktop app

*Status: plan r1, for review. No code accompanies it, and nothing is built until it is reviewed and William
approves (his rule of Oct 30). Owner: @sagebrush-remote-compute. Reviewers: astra (SEC), daybreak3 (ENGINE), daybreak4
(PERF), daybreak2 (SIZE), agents-ui (app).*

## In plain words

- The desktop app will run notebooks with Sagebrush's **native engines**: the Rust engine compiled for your computer,
  with its real threads, SIMD and all of your memory, inside a real CPython. It will not use WebAssembly in the web
  view. On the engine-heavy cells measured below, that is 2.2–3.6 times faster today, before any tuning, and it
  starts in milliseconds.
- Each notebook gets its own engine process, locked down by the operating system:
  - it reads only the notebook's own folder and what you've allowed;
  - it changes your files only through Sagebrush's permission checks;
  - it has no network of its own.
- The website, iPhone and iPad keep WebAssembly. So does Android at first, and so does the app wherever the system
  can't lock a process down.

William, Nov 7 2026: "one key thing: the desktop app must NOT just use wasm. that it does not must be very temporary"
(6:02 AM PST), and "we really need to have a native app that is not wasm, since that is a major part of the value
prop of native" (~6:05 AM).

## 1. What runs, and how the app runs it

### 1.1 The engines run native, not only the interpreter

The point of the native app is the **engines**: the Rust crates under `engine/` (exact linear algebra, number fields
and factoring, modular symbols and forms, a_p, polynomials, Gröbner bases, the parallel scheduler), compiled for the
host CPU.

Against the browser's `wasm32` build they gain:
- **real threads**: the wheel's `sagebrush-par` is built with its `parallel` feature, whereas wasm in the page is one
  thread per worker;
- **a 64-bit address space**: no 4 GB cap, so large matrices, big Gröbner bases and long modular-symbol spaces fit
  in RAM;
- **native SIMD and the native allocator**;
- **no JS↔wasm boundary**.

The interpreter around them is CPython.

**The build the app ships:** the same `sagebrush` wheel that PyPI gets (`engine/py`, maturin, abi3, release profile;
`sagebrush._native` is the whole engine as one `cdylib`), built from **the same commit as the app** in the app's own
release job.
- **Targets:** x86_64 macOS, Linux and Windows, plus arm64 macOS and Linux (and Windows on Arm later).
- **CPU level:** the published wheels target each architecture's baseline (x86-64 SSE2, arm64 NEON). There is no
  `target-cpu` setting today. Because the app ships its own build, it can do better without leaving old CPUs behind:
  - **Option A:** keep the baseline (zero risk, measured below).
  - **Option B (proposed for N2):** a baseline build plus runtime dispatch (`is_x86_feature_detected!`, or
    `multiversion`) on the few hot kernels daybreak4 picks (multimodular reduction, bigint multiply). AVX2 or AVX-512
    is then used where the CPU has it.
  - **Option C:** a separate `x86-64-v3` build chosen at install. It doubles the artifacts; not proposed.

### 1.2 How the app starts it: the native runner's kernel as a sidecar (recommended)

- The app bundles a pinned CPython (python-build-standalone, stripped) and the wheel above. There's no system Python
  and nothing for the user to install.
- The Rust shell (`app/src-tauri`) starts **one kernel process per document identity** (confinement spec §4.2):
  `sagebrush/remote/child.py`, the native kernel the runner already uses.
  - Its protocol is one JSON message per line on stdin/stdout. Stdout's fd is moved aside, so stray C writes can't
    corrupt it.
  - It supports `{id, code, mode}`, completion, display bundles and SIGINT Stop (KeyboardInterrupt, the Rust engines
    too).
  - It runs in its own process group, for the tree rule.
- It talks over **stdio pipes**. There is no listening port, no pairing and no DPoP inside the app: nothing else on
  the machine can connect to a kernel. The loopback gateway (`sagebrush remote --loopback`) stays for the website's
  "Run on: Your computer".
- **The page reaches it through Tauri IPC** behind the `WorkerKernel` interface the wasm worker already implements.
  Notebooks, boards, the console and the runner pill don't change their callers.
- This is the same kernel as "Your computer" (#778) and the relay runner (b3b), so its tests (`test_remote_child.py`,
  the gateway and relay suites) cover it already.

### 1.3 Rejected alternatives

- **CPython embedded in the app process (pyo3), with the engine linked into the Tauri binary.** It is one process, so
  there is no OS sandbox per document. A crash or a runaway allocation takes the whole app down, and Stop can't kill a
  tree.
- **The wasm engine under wasmtime outside the web view.** It is still wasm32: one thread, 4 GB, no native SIMD. That
  is what William ruled out.
- **The user's own Python and packages.** That is a later option (N5), as the same sidecar with another interpreter
  path. It is not in v1, because it can't be sandboxed or versioned with the app.

## 2. Measured: native engine against wasm, same version

Sagebrush **0.6.0** on both sides, the newest release on both npm and PyPI.
- **Wasm:** the npm CLI, which runs the browser runtime (Python compiled to JS plus the wasm engine) under Node
  v26.13.0, the V8 that Chromium and WebView2 use.
- **Native:** the PyPI wheel `sagebrush-0.6.0-cp39-abi3-manylinux_2_28_x86_64.whl` under CPython 3.14.4.
- **Machine:** Intel Xeon 2.80 GHz (AVX2 and AVX-512 present, unused by the baseline build), 32 cores.
- **Method:** the same cells file on both sides. Each cell gets one warm-up, then the median of 3 runs. Two full runs
  agreed to within a few percent, and the results agree exactly.
- **Evidence:** `/scratch/sagebrush-reviews/remote-compute/native-bench-0.6.0/` (cells.py, env.txt, both runs per
  side, SHA256SUMS; read-only).

| Cell | Native | Wasm | Native speedup |
|---|---|---|---|
| `det` of a 200×200 integer matrix (539-digit result; multimodular, certified) | 65 ms | 163 ms | **2.5×** |
| `factor` of a 41-digit product of three primes (ECM) | 245 ms | 550 ms | **2.2×** |
| `EllipticCurve([0,0,1,-1,0]).aplist(200000)` (a_p engine) | 27 ms | 99 ms | **3.6×** |
| `fib(24)`, pure Python recursion | 5.1 ms | 2.7–5.0 ms | 0.5–1.0× |
| `factorial(60000)` (865,809 bits) | 54–95 ms | 11.6 ms | **0.12–0.2×** |
| Start: `import` of the library | 19 ms | 450 ms (2.2 s the first time) | — |

**What this shows, and what it doesn't:**
- **The engines are 2.2–3.6× faster natively,** with the baseline build, one thread, and no tuning. These cells don't
  use threads or more than 4 GB, which is where native should gain far more (N1 measures it; below).
- **Pure Python is not faster natively.** V8 JIT-compiles the JS-compiled Python, while CPython 3.14 interprets it.
  The value is in the engines, not the interpreter loop.
- **A finding (NAT-BIGINT-1):** in the native wheel, `Integer` is a subclass of CPython's `int`, so big-integer
  arithmetic is CPython's. `factorial(60000)` takes 82 ms, the same as `math.factorial` at 86 ms. In the browser
  runtime, the same arithmetic runs on Sagebrush's Rust bigint. The native kernel must route large-integer arithmetic
  (multiply, divide, gcd, power, factorial and conversion past a size threshold) to the engine's bigint
  (`sagebrush-bigint`), as the browser does. Otherwise it is slower than wasm there. This is ENGINE work in N2.
- **Limits of this measurement:**
  - It uses Node's V8, not the app's web views. On macOS and Linux the app's web view is WebKit (JavaScriptCore),
    whose wasm speed differs.
  - It is one machine, and the cells are mine.
  - In N1 daybreak4 re-measures at one commit, in the app's own web views, on macOS arm64, Linux x86_64 and Windows,
    with multithreaded cells and one over 4 GB.

## 3. Enforcing "File writes" and "Network" for native code

The confinement spec (r3.2, `design/` once merged) defines two switches per document and the host's authority
(§4.1). It labels a native kernel "unconfined" (§4.4). Inside the app, this plan makes the native kernel **confined**,
with the same model:
- The host's policy is the authority.
- The engine has no permission logic and no way to change grants.
- Every refusal follows the spec's one flow: refuse with a `PermissionError`, the host draws the prompt, and the user
  runs it again.

Natively, "the host" is the Tauri Rust shell, and the OS sandbox makes the kernel unable to go around it.

### 3.1 Files: enforced by delivery, as in the browser

- **The working directory.** Each kernel runs in a private per-document directory under the app's data folder. The
  host fills it with the **read scope only** (spec §2.7): the document's own folder tree plus the trees granted. This
  is what the browser does when it loads the read scope into the worker's file system. The app already copies the
  notebook's folder today (64 MB a file, 256 MB in all, app/README.md).
- **The sandbox.** The kernel can **read** only its working directory, the bundled runtime (read-only) and a private
  temp directory. It can **write** only its working directory and temp. Nothing else on disk is visible.
- **Changes reach real files only through the file gate.** After each run, and at Stop and close, the host diffs the
  working directory and passes each change through `mayChange`: the write trees, `rename` checked at both ends, and
  the change queue (spec §2.3, §4.1). A refused change is not applied, and the run's error names what to allow.
  - Changes are applied **after** a run. There is no live mirroring in v1: a native C extension's writes can't be
    intercepted one call at a time, so the gate works on the result instead.
- **Widening** (a new read or write grant) copies more files in at the next run. The kernel isn't restarted (§4.2).
- **Narrowing** (a revoke) restarts that document's kernel. An OS sandbox can't re-check every read on a handle opened
  earlier (spec LIVE-HANDLE-1). The person sees "permissions changed: the kernel restarted". Widening never restarts.
  **This is a deviation from §4.2 for SEC to rule on.**
- **Large folders** (later): copying has a cost. Options are a read-only bind mount in a user namespace on Linux, an
  APFS clone (`clonefile`) on macOS, and hard links of read-only inputs on Windows. v1 keeps the app's existing limits.

### 3.2 Network: none in the kernel

- The OS sandbox refuses every socket. The kernel has only its inherited stdio pipes.
- Live data, the remote relay and any future fetch go **through the host's one connection broker** (spec §4.1,
  CONF-NET-1) over the same IPC. So the broker rules apply unchanged: granted hosts only, no ambient credentials,
  redirects checked, `https`/`wss` only.

### 3.3 The sandbox, per platform

| | Files | Network | Process tree |
|---|---|---|---|
| **macOS** | a Seatbelt profile applied by the kernel before any user code (`sandbox_init` with a generated profile, as Chromium and Firefox do for their children): deny by default; allow the runtime (read), the working dir and temp (read and write) | `(deny network*)` | own process group; the host kills the group |
| **Linux** | Landlock (5.13+; ABI checked at start): read the runtime, read and write the working dir and temp | Landlock TCP rules where available (6.7+), **and** a seccomp-bpf filter refusing `socket(AF_INET, AF_INET6, AF_NETLINK, AF_PACKET)` everywhere; `no_new_privs` | new session; `PR_SET_PDEATHSIG`; the host kills the group |
| **Windows** | an AppContainer process; ACLs granting its SID only the working dir and temp; the runtime is read-only by package ACL | no `internetClient`/`privateNetwork` capability | a Job object: kill on close, the tree rule, memory limits later |

- **Fail closed.** At start the kernel runs a **self-check** before reporting `ready`:
  - open a TCP socket;
  - write outside its directories;
  - read the user's home;
  - start a child that tries the same.

  If any probe succeeds, or the sandbox can't be applied (an old Linux without Landlock, or a policy that forbids
  AppContainer), the kernel isn't used. The document runs on wasm, and the runner pill says "WebAssembly: this system
  can't isolate native code".
- **Children** (subprocesses, `!cmd`, the shell) inherit the sandbox on all three systems. The shell's mutating verbs
  still go through the file gate (spec G3), because their effects are applied by the same diff.
- **Kernels Sagebrush doesn't own** (a remote runner, Jupyter, `sagebrush remote` on a server) stay as spec §4.4 says.

## 4. Size, install and startup, and signing

- **Size (daybreak2):** today's installers are 10–15 MB. The wheel adds about 6–7 MB compressed (0.8.2 on PyPI,
  6.0–6.8 MB). A stripped CPython adds roughly 15–30 MB compressed (no tests, idle, tkinter or ensurepip). Estimate:
  **+25–40 MB per installer, to be measured in N1.** Options:
  - **(a)** bundle everything (no network at first run);
  - **(b)** ship the shell plus wasm, and fetch the native runtime on first use by content hash, signed;
  - **(c)** one installer per architecture instead of a universal macOS app.

  **Recommendation: (a)** with (c). (b) is William's call (below).
- **Startup (daybreak4):** a kernel is ready in CPython's start plus `import sagebrush`: 19 ms to import here, against
  the wasm worker's about 300 ms to ready in the page (design/runner.md). A warm spare kernel per window is a later
  option. The sandbox setup and self-check must stay under ~50 ms (measured in N1).
- **Updates:** the runtime is versioned with the app and updated with it (the Tauri updater). Kernels are never
  shared across app versions.
- **Signing:** the app is unsigned today (app/README.md). Native code makes signing necessary.
  - **macOS:** Developer ID, hardened runtime and notarization. Every `.dylib`/`.so` and the `python` binary are
    signed; entitlements are kept minimal (no JIT for CPython).
  - **Windows:** Authenticode (Azure Trusted Signing or an EV certificate) for the app, `python.exe` and every DLL and
    `.pyd`.
  - **Linux:** checksummed release artifacts with a signed checksum file; AppImage, deb and rpm.
  - The accounts and their cost are William's decision.

## 5. What stays wasm

- **The website:** a page can't start processes. "Run on: Your computer" (loopback) and remote compute remain its
  native paths.
- **iOS and iPadOS:** no child processes.
- **Android at first:** bundled native binaries are possible (`nativeLibraryDir`); later, separately planned.
- **The app's fallback** where §3.3's self-check fails.

**Effect on current work:**
- The wasm-runner sandbox in the app becomes interim. #822 (Confinement 1b) stays as option 1, per William's "yes
  option 1".
- **Recommendation to agents-ui: don't start the Windows desktop wasm-sandbox PR,** since N3 replaces it. Android
  work is unaffected.

## 6. Milestones

| | What | Gate |
|---|---|---|
| **N0** | This plan, reviewed; William's decisions (§7) | all lanes; William |
| **N1** | Spikes, no product code: (1) the sandbox and its self-check on macOS, Linux and Windows, each with escape probes (socket, write outside, read outside, child process, ptrace/debugger attach); (2) daybreak4's same-commit measurements in the app's own web views, with multithreaded cells and a > 4 GB case; (3) the installer size with a stripped runtime | SEC, ENGINE, PERF, SIZE |
| **N2** | macOS and Linux: the bundled runtime and wheel (same commit), the sidecar over stdio and IPC, delivery-based files with the post-run gate, broker-only network, NAT-BIGINT-1, fail-closed fallback, the runner pill "Native · isolated", app selftest coverage | all lanes |
| **N3** | Windows: AppContainer and Job | all lanes |
| **N4** | Native becomes the app's default; wasm stays as fallback | William |
| **N5** | Later, each planned separately: CPU dispatch beyond baseline, the user's own Python, native terminals in the app, Android native, warm kernels | — |

## 7. Decisions for William

1. **Signing:** the Apple Developer ID and notarization account, and Windows code signing (Azure Trusted Signing or an
   EV certificate). Neither exists yet.
2. **Size:** bundle the native runtime (+25–40 MB, recommended), or download it on first use?
3. **An "unconfined" native mode,** where the user explicitly lets a notebook run native code without the OS sandbox
   (for their own packages or GPUs). Recommended: not in v1; the remote runner already covers that case, labelled as
   spec §4.4 says.

## 8. Grounding

- master cfa6d281 (Nov 7 2026);
- app/README.md (Tauri 2, wasm in the web view, folder copy limits);
- design/runner.md and design/engines.md;
- `engine/py/Cargo.toml` (`sagebrush-par` with `parallel`; abi3 cdylib);
- `sagebrush/remote/child.py` (the stdio kernel);
- the confinement spec r3.2 (§2.2–2.7, §4.1–4.4);
- the bench evidence in §2.
