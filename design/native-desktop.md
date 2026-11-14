# Native engines in the desktop app

*Status: plan r18: r11 (the architecture revision, its tests and the page items) with William's answers to every §9 question recorded (Nov 7, about 2:26–2:31 PM PST), and (r14–r17) the licence invariant, the support-window clock and the PDF milestone N6 with its tests (T6) and measurements (§7.1), and (r18) William's revised PDF decision (installed TeX only) and his test-key choice; docs only, nothing is built. It replaces r12 (merged at 2999416e) with William's architecture decision of
Nov 7, 2026, about 12:15–12:30 PM PST.

Owner and sole author: @sagebrush-remote-compute. Reviewers: astra (SEC), daybreak3 (ENGINE), daybreak4 (PERF),
daybreak2 (SIZE), grader (TESTS), board (COPY), agents-ui (app).

The r1–r12 history and its evidence are kept in §3 and the appendix. William asked for this as "r10"; the earlier r10, which
recorded the §7 answers, is part of r12.*

## In plain words

- **The engine always runs apart from the app:** as its own process on the desktop and on remote machines, and in a worker on the web and mobile. The app talks to it through **one versioned protocol** (§2).
  There are three ways to reach it:
  - **desktop:** a local subprocess;
  - **web and mobile:** an in-page WebAssembly worker, because those can't start processes;
  - **cloud and "Your computer":** the remote relay.
- **The app has one client for all three.**
- **Sagebrush Engine becomes its own product,** `sagebrush-engine` (§4):
  - command line only, without the browser app;
  - the engine's own code stays MIT OR Apache-2.0, always. LGPL is allowed only for the Bun runtime (William, §1);
  - its own releases and upgrades;
  - it runs code and works with LaTeX.
  - One engine serves the desktop app, "Your computer", CI and agents.
- **The Sagebrush App** (§5) ships one known-good engine, so the first run works offline. The engine can then be upgraded on its own.
  - File and network permissions are enforced in the engine.
  - There is still no OS sandbox.
- **Which JavaScript runtime the engine uses is a packaging choice, not architecture.** The options are Bun, Deno and Node's single executable (SEA). V8 against JSC is part of that choice. N1 measures it (§7).
- **Signing and notarizing engine binaries and the app:** William's keys only, used only by a CI job, from a GitHub environment he fills. Agents never see or handle them (§6).
- **Nothing ships, is signed, tagged, renamed or relicensed without William.**

## 1. William's decisions

1. **Interpreter route A** (Nov 7, about 7:54 AM PST): "the same Python interpreter the website uses", which is pyjs, not CPython.
2. **No OS sandbox** (same message): "I do not think OS sandboxing should be part of our plan". So there is no Landlock, seccomp, Seatbelt or AppContainer work.
3. **Signing** (about 9:30 AM PST): "I (William) own them; agents never touch the keys."
4. **Easy upgrades** (about 9:30 AM PST): "it depends - easy upgrades are just as important to get right."
5. **The architecture** (about 12:15–12:30 PM PST): "we could 100% chose 'run sagebrush engine as a subprocess'"; "Let's go with sagebrush engine."; "Proceed with r10." Mobile stays WebAssembly.

   Recorded with it:
   - the engine is a separate product, CLI-only (the browser app is cut out), with its own upgrade cycle;
   - "It is mit licensed always";
   - it runs code and compiles LaTeX;
   - the app requires the engine, and may come with one version of it;
   - the app's licence is William's call;
   - the JavaScript runtime is not decided ("bun may be better for the engine").
6. **The licence** (about 2:26 PM PST): "LGPL OK for Bun; stay MIT OR Apache-2.0" (§4.2).
7. **"Your computer"** (about 2:26 PM PST): "Yes, keep CPython as an option" (§4.3).
8. **The protocol support window** (about 2:29 PM PST): "12 months but this support should ONLY start once we make a 1.0 release. Before a 1.0 release, there's no compatibility guarantees at all." (§2.1).
9. **The name** (about 2:29 PM PST): "Use sagebrush-engine", for both the command and the package.
10. **LaTeX to PDF** (about 2:31 PM PST): "Both: user's TeX if present, else offer the Tectonic download" (§4.1). Its Tectonic half is **superseded** by item 11.
11. **LaTeX to PDF, revised** (about 2:57 PM PST): "To keep scope focused, it sounds like we should just suggest to users "install latex" and leave it to them. We will use installed latex, but otherwise it is their responsibility." (§4.1).
12. **Test keys** (about 2:49 PM PST): "(b) Tests may generate a throwaway in-memory keypair each run (never saved, never trusted by any shipped engine)" (§4.4).

r12's lead question ("decide after the prototype's side-by-side measurements") was about where pyjs runs inside the app. The architecture decision answers it: pyjs and the native engine run in the engine process. N1 still measures, but now only to choose the engine's runtime (§7).

## 2. Architecture: one engine process, one protocol, three transports

```
  Sagebrush App / sagebrush.space page            (one client)
        |                 |                  |
   local subprocess   in-page wasm worker   remote relay
   (desktop)          (web, mobile)         (cloud, "Your computer")
        |                 |                  |
  Sagebrush Engine:  pyjs + lib/ + the Rust engines
                     (native code in a subprocess, wasm in a worker)
```

- **One client.** The page's kernel client speaks the engine protocol and doesn't care which transport carries it. Today the page has separate paths: the wasm worker (`web/notebook/worker-kernel.js`) and the remote client (`web/notebook/remote-client.js`, #778). They become three transports under one client.
- **What runs where:**
  - **subprocess:** pyjs runs in the engine's JavaScript runtime, and the Rust engines are native code, with native threads and 64-bit memory;
  - **wasm worker:** the same pyjs with the Rust engines as WebAssembly, as on the website today;
  - **relay:** whatever engine runs on the remote machine.
- **The engine owns its own state:** sessions, files given to it, permissions, Stop. The app owns the UI, documents and the person's choices.

### 2.1 The protocol

The protocol is the message set the page's worker kernel already uses (`src/notebook-session.ts`, `web/worker.ts`), with a version and a handshake added:
- run, input and live-data answers;
- outputs and progress;
- files (`files`, `fsPut`, `fsChanged`);
- permission and Stop.

**Handshake.** It happens before anything else, on every transport.

1. The client sends `hello`:
   - `protocol: {min, max}`, the range of protocol versions it speaks;
   - its own version;
   - the capabilities it wants.
2. The engine replies with:
   - the chosen protocol version, which is the highest one both sides speak;
   - its engine version and build ID;
   - the capabilities it has, for example `native`, `threads`, `latex`, `files`, `network`, `terminal`, `stop-word`.
3. If the two ranges don't overlap, the engine replies `incompatible`, gives its own range and closes. Nothing runs.
4. Both sides use only the capabilities that both declared. A feature whose capability is missing is shown as unavailable, never attempted.

**Version skew.**
- **Desktop app:** if the installed engine is outside the app's range, the app uses the engine it ships with (§5) and says that an engine upgrade (or an app upgrade) is available. It never runs a mismatched pair.
- **Relay:** the page already requires a minimum runner version (`RUNNER_MIN`). The handshake replaces that check with the same rule: outside the range, the page says which side to upgrade.
- **Support window** (William, §1): **before 1.0 there is no compatibility guarantee at all.** From 1.0 on:
  - **The clock:** when an engine release first speaks protocol version $v+1$, version $v$ gets a window that ends 12 months after that release's date. The date comes from the signed release metadata, never from the person's computer clock.
  - **The end date, exactly:** calendar arithmetic in UTC. The end date is the same day of the month 12 months later; if that day doesn't exist, it is the last day of that month (a supersession dated 2028-02-29 ends on 2029-02-28). The end date is **inclusive**: an engine release dated on it must still speak $v$.
  - **The promise:** every engine release dated on or before the window's end date still speaks $v$.
  - **Several predecessors:** each older version has its own window, so an engine may speak several older versions at once. A version is dropped only after its own window ends.
  - **Before 1.0:** versions superseded before the 1.0 release get no window. The version current at 1.0 gets its window from the first release after 1.0 that supersedes it.
- Within a negotiated version, an unknown message type is a protocol error. It ends the session, never silently drops the message.

**Transports, all carrying the same messages:**

| Transport | Data | Control (permission, Stop) |
|---|---|---|
| local subprocess | length-prefixed frames on one pipe | a **separate** framed pipe, so large data can't queue in front of Stop or permission (N1-2) |
| in-page wasm worker | `postMessage` | the existing shared `WRITABLE` / `INTR` / `RUN` words |
| relay | the relay's frames over its one outbound connection, end-to-end DPoP | control frames on the same connection, sent ahead of queued data |

**Stop and permission semantics are the same on every transport** (§2.2). A transport may change how a message travels, never what it means.

### 2.2 Control contracts (from r5–r9, unchanged in meaning)

**Permission version.**
- The client keeps a monotonic `pv` per (session, generation) and sends `{writable, gen, pv, on}`.
- The engine applies and acknowledges only a matching generation with a strictly newer `pv`, so a stale allow can't reopen writes.
- The current permission is applied before the session starts. `ready` echoes `pv`, and no run comes before it.
- A missing acknowledgement, a malformed control frame or a closed channel ends the generation.

**Stop.**
- Each run has a 64-bit token. `RUN = token*2 + stopbit` is visible to pyjs, and the native engine's `ARMED` word has the same layout. Around each engine call, the engine arms and clears only its own token.
- Stop's one decision in the engine is `RUN: token*2 → token*2+1`:
  - only a successful swap stops `ARMED`, wakes waits and returns `applied: true`;
  - a failed swap returns `applied: false` and changes nothing.
- Before its terminal `done`, the engine retires `RUN`:
  - `token*2 → 0` keeps the completion;
  - `token*2+1 → 0` makes the run interrupted.
- The client has one terminal compare-and-set per request, shared by `done`, Stop and the hard restart. So every request gets exactly one result.
- Stop never uses a signal: no SIGINT handler is installed in the engine (`engine/interrupt`'s `host-word` feature on the N1 branch).
- **Stop now reaches the long `ap` calls** (#831: `aplist`, `aplist_many` and the sieve check for interrupts).
- **The hard restart:** after a deadline, the client stops waiting, ends the generation, kills the subprocess and starts a new one. A wasm worker is terminated; a relay session is closed.

**Input and live data** bind to the generation and the active request. Late answers do nothing.

## 3. Evidence carried over from r8–r12

The same-commit packet is unchanged:
- **Evidence:** `/scratch/sagebrush-reviews/remote-compute/native-bench-r8-dbdf5984/`, frozen with SHA256SUMS, together with daybreak4's packets `pr825-r8-aplist-decomposition/` and `pr825-r8-jsengines/`. All PERF CLEAR.
- **What was measured:** every engine is the v0.6.0 tag `dbdf5984`.
  - **W:** the npm CLI, pyjs plus wasm.
  - **A:** the same CLI with its engine calls on a native N-API add-on in the same process. A is the shape of an engine subprocess.

| Engine cell | W (wasm) | A (native, via pyjs) | A vs W |
|---|---|---|---|
| `det` 200×200 | 183.7 ms (167.7–212.1) | 90.2 ms (87.7–97.7) | about 2.0× |
| `factor`, 41 digits | 611.8 ms (578.6–703.3) | 248.5 ms (244.2–285.9) | about 2.5× |
| `aplist(200000)`, 32 threads | 100.6 ms (98.1–116.5) | 38.7 ms (36.2–51.5) | about 2.6× |

These are medians of 5 per-process medians, with their range, on a loaded machine: observed values, not precise speedups. The causal findings stand:
- `factor` converges across kernel, direct, A and CPython;
- `aplist`'s gap is the data format and the wrapper;
- `aplist`'s gain needs threads.

**Big integers depend on the JavaScript engine** (daybreak4's packet, identical pyjs on both): JSC is 7.3× slower than V8 on `factorial(60000)`, 13.4× on a big multiply and 9.8× on division, but 11.2× faster on a 92,000-bit `gcd`. So if the engine runs on Bun (JSC), big integers need per-operation Rust dispatch, measured in N1 (§7).

r4's A-vs-B timings stay withdrawn: the PyPI wheel came from a different commit.

## 4. Sagebrush Engine, the product

### 4.1 What it is

- **One command-line program, `sagebrush-engine`** (the command and the package; William, §1). It runs code in Python (pyjs), Sage, Magma and MATLAB modes, as `sagebrush` does today. It also gains the engine protocol's server side (`--stdio` for the app, the relay for remote).
- **The browser app is cut out.** Today's single-file CLI embeds the web page for `sagebrush notebook` (`scripts/build-cli.mjs`). The engine build leaves it out. The page lives in the app and on the website.
- **LaTeX:** the engine includes today's LaTeX tools (`src/latex-cli.ts`: the expander, the HTML preview, SageTeX).
  - **Today Sagebrush doesn't make PDFs:** the preview is not TeX (`articles/latex/01-how-it-works.md`).
  - **PDFs** (William, §1 item 11): the engine compiles to PDF with **the person's installed TeX** only.
    - **Detection runs again on every compile**: first `PATH`, then each OS's standard install locations (macOS `/Library/TeX/texbin`; the MiKTeX and TeX Live directories on Windows; the Linux distributions' paths). So a TeX installed while the app runs is found by the next compile, without a restart: a running app keeps the `PATH` it started with.
    - **With no TeX found,** the engine shows plain guidance instead: board's text, with per-OS pointers, saying that Sagebrush doesn't download or install LaTeX, and a "Compile again" action. There is no consent dialog, because nothing is offered. Agents get the same guidance from the command line.
    - **Sagebrush downloads and manages no TeX.** The Tectonic offer, its download verification, its bundle policy and its licence and source-offer text (r13–r17) are **superseded, Nov 7** (William, §1 item 11; Tectonic's own package downloads aren't verified, which @sagebrush and astra confirmed in its source).
- **The runtime is a packaging choice:** Bun (`bun build --compile`), Deno (`deno compile`) or a Node single executable. `scripts/build-cli.mjs` already builds all three (`--bun`, `--deno`, `--sea`).
  - The native Rust engine is loaded into that runtime, through N-API or the runtime's own FFI.
  - A Rust module without a native build stays wasm inside the engine.

### 4.2 MIT OR Apache-2.0 always: the licence check

- **The engine stays MIT OR Apache-2.0** (`NOTICE.md`; William, §1), so the MIT licence is always available.
- **Every dependency must be MIT-compatible** (permissive, so the engine can be redistributed under MIT terms with the notices kept), **with one scoped exception:** the Bun runtime's own LGPL parts, below.
- **The proposed allow-list** is the licences the npm package already carries: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, BSL-1.0, Unicode-3.0, PSF-2.0 (CPython parts) and Artistic-2.0 (Cremona's data).
  - **One scoped exception:** LGPL is allowed **for the Bun runtime only** (William, §1). It is not allowed for anything else in the engine.
  - **Not allowed:** GPL, AGPL, MPL, LGPL outside the Bun runtime, and anything unlisted.
- **A finding for the runtime choice:** Bun says "Bun statically links JavaScriptCore (and WebKit), which is LGPL-2 licensed" (bun.com/docs/project/licensing).
  - So a Bun-compiled engine contains LGPL-2 code, with LGPL's relinking obligations. William accepted that for the Bun runtime.
  - The check allows LGPL only in the Bun runtime's own inventory entries.
  - Node and Deno ship V8 (BSD-3-Clause) and their own permissively licensed parts. Their full inventories are N1 work (§7).
- **The check (proposed, not yet running):** a script (`scripts/license-check.mjs`) inventories everything that goes into each engine build: the Rust crates, the npm packages bundled, the runtime binary's own parts, and the data. It fails on anything outside the allow-list.
  - It runs in the existing CI `checks` job. Wiring it into a workflow file is done by William or @sagebrush, because agents don't push workflow files.
  - `THIRD-PARTY-NOTICES.txt` is generated from the same inventory.

### 4.3 One engine for local, remote, CI and agents

- **"Your computer" (#778)** today runs `uvx sagebrush@latest remote --loopback`, which is **CPython** with the PyO3 engine, as William chose ("uvx only", Nov 6).
- **Merging means the engine also speaks the relay transport.** The page then talks to "Your computer" with the same protocol and client as to the desktop subprocess.
- **The CPython runner stays as an option** (William, §1: "Yes, keep CPython as an option"). "Your computer" can run the engine (pyjs) or the existing CPython runner (`uvx sagebrush remote`), for people's own Python and packages.
  - When both are available, the page offers a plain-words picker, and the choice is remembered per machine.
  - The relay, DPoP and terminal designs don't change; only the program at the end of the relay does.
- **CI and agents** run the same engine binary from the command line or over the protocol.

### 4.4 Releases, upgrades, size and start-up

- **Own release cycle:** the engine has its own version and release notes, separate from the app's.
  - The protocol range in the handshake (§2.1) is what ties an app to the engines it accepts, not equal version numbers.
- **Upgrades:**
  - The engine upgrades itself from the release channel (`engine upgrade`). The app can trigger that.
  - Every upgrade is checked against the release's published checksum.
  - Signature checks use William's keys once he sets them up (§6). No agent creates or holds an updater key; development uses unsigned or mock update metadata.
  - **One scoped exception, for tests only** (William, §1 item 12): a test run may generate an **ephemeral in-memory keypair** and inject its public key as that test's pinned key.
    - The keypair must be made fresh in each run, and must never be written to disk, logged or committed.
    - It must never be pinned or accepted by any shipped engine, app or release metadata.
    - It must never be, or become, a release, updater, signing or notarization key. Real signing and notarization keys remain William's only (§6).
- **Size and start-up:** William's CLI rule applies: judged by install time and start-up time, with no fixed size ceiling.
  - Each engine build gets its own size-gate entry, with tight growth markers.
  - N1 reports, per runtime and OS:
    - the download;
    - the update delta;
    - the time to install;
    - the time to the first line;
    - the time to first output with Sage's library loaded.
  - Today, measured in r4: about 0.4 s to the first line and 1.1 s with Sage under Node.
  - Start-up work: snapshots where the runtime has them, lazy library loading, and no browser bundle. A target, not a gate.

## 5. Sagebrush App

- **The shell:** Tauri 2 on desktop, unchanged, with iOS and Android builds.
  - **Desktop** starts the engine as a subprocess (§2).
  - **Phones and tablets** use the wasm worker, as William decided (mobile stays WebAssembly); iOS doesn't allow an app to start a separate engine process.
  - **Electron is kept only as a fallback shell,** if Tauri's webviews block something N1 finds (§7).
- **It ships one known-good engine**, so the first run works offline.
  - The app prefers an installed engine whose protocol range fits, and otherwise uses its own.
  - The person can upgrade the engine without upgrading the app.
- **Permissions are enforced in the engine:** the engine's files and network switches (William, Nov 3: two per-document permissions).
  - Python sees only `web/shims/fs` and the host broker, never the runtime's own `fs`, sockets or subprocesses.
  - The app sets the switches over the control channel (§2.2), and the page keeps its own gate for durable changes.
  - These are application boundaries. They don't contain a bug in the runtime, the native engine or the app, and nothing calls the engine "sandboxed". **There is no OS sandbox.**
- **The app's licence is William's call.** The engine stays MIT whatever the app's licence is. The app talks to the engine only through the protocol.

## 6. Signing and notarization

- Engine binaries and app installers are signed and notarized **only with William's keys.**
  - This covers Apple notarization, Windows Authenticode and the update signing key.
- **Where the keys are used:** a CI job, and nowhere else. The keys are secrets of a GitHub environment that William creates and fills himself (`sagebrush-signing` for Apple). The job runs only for a release tag or a dispatch that asks for it, never on a pull request.
  - Agents may write that job; a person commits it, since agents don't push workflow files. Its secret handling gets a security review.
  - Agents never see, hold, copy or print a key, a certificate, its password or an account login, and never sign anything outside that job.
  - A signed build is an artifact of the job. Publishing it (a release, a download link) is William's decision.
- Every build an agent makes on its own machine is an unsigned local build, and nothing is published.

## 7. N1, narrowed

**Dropped:**
- engines inside the app's process: an N-API add-on in the app, the engine linked into Tauri's Rust core, Tauri commands with a sync-to-async bridge, and Tauri 3 CEF;
- the embedded-V8 helper (old candidate 3);
- Deno Desktop.

**Electron** remains only as a fallback shell, not a measured candidate.

**The new candidate 1** is Tauri plus an engine subprocess. N1 compares **the engine's runtime**, all as a subprocess under the same Tauri shell, at one engine commit:

| Label | Runtime | JavaScript engine |
|---|---|---|
| **1a, 1b** | Node single executable (SEA) | V8 |
| **2** | Bun (`bun build --compile`) | JSC |
| **3** | Deno (`deno compile`) | V8 |

Node is the baseline because r8's evidence (A) is Node. 1b is the A/A control. These are the same four labels as pre-registration r3, so its schedule and balance rules carry over unchanged.

**What N1 measures**, per runtime and OS:
- the engine's start-up (to `ready`, and to first output with Sage);
- memory of the engine process and the whole tree;
- the big-integer corpus (§3), which now decides the Rust-dispatch thresholds and weighs on Bun;
- Stop, as send→accepted and accepted→done after RUN/ARMED, plus the 2 s restart;
- the permission acknowledgement window;
- the protocol over the pipe: framing stages, bytes and the empty round-trip;
- download, install time and **update deltas**, as bytes;
- the installed footprint, both steady (the bundled engine plus the current one) and at the peak of an update (bundled, current, the download being staged and any rollback copy);
- the licence inventory (§4.2).

**Machine-independent work already done or in progress** (branch `n1-native-proto`, never merged):
- the `host-word` interrupt feature;
- the N-API add-on with Stop pins;
- the framed data and control pipes, permission version and RUN/ARMED Stop (N1-2), with conformance rows 1–5.

**The output-frames harness** (#826, carried from r12) runs in the app's webview: the desktop UI is still WebKit (macOS, Linux) and WebView2 (Windows), and outputs move into frames from OUT-ISO phase 2. This is a UI test, not an engine measurement.

**The pre-registration** (`proto/n1/harness/PREREGISTRATION.md`, r3, PERF PROTOCOL CLEAR at 98ed461e) becomes r4:
- the labels become the three runtimes above;
- the measurements are those listed here. The page and webview timing marks are dropped from the runtime comparison (the subprocess's own marks stay); the output-frames harness above is separate.

r4 goes back to PERF. Counted runs still need PERF's final harness and packet review. William answered the machine questions on Nov 7 (about 12:46 PM PST): Windows runs use a CI workflow he adds himself; the m1 GUI "Yes, for N1 only"; sudo packages and the VM3/VM4 timing box "Yes to both".

### 7.1 Outside N1: PDFs with the installed TeX

Sagebrush downloads and manages no TeX (§4.1), so the Tectonic measurements of r13–r17 are gone.
- **SIZE invariant:** the person's installed TeX contributes **0 bytes** of Sagebrush-managed archive, cache, install or update data, and is outside the app's and the engine's footprint. No size pre-registration is needed.
- **PERF, one optional descriptive row:** end-to-end compile latency with the person's installed TeX, on a frozen document and fixture, recording the TeX executable's identity and version and the machine. It is never ranked across machines or TeX distributions, and has no SESOI or winner: most of its time belongs to the external TeX.
- **N6's performance gate:** detecting and invoking TeX must not regress the engine path.

## 8. Milestones and tests

| | Work | Gate |
|---|---|---|
| **N0** | r10 reviewed; William's architecture decision recorded | all lanes; William |
| **N1** | §7: runtime comparison, protocol over the pipe, licence inventory; unsigned local builds only | ENGINE, PERF, SIZE, SEC |
| **N2** | **First, one client:** merge the page's worker client (`web/notebook/worker-kernel.js`) and remote client (`web/notebook/remote-client.js`) into the one protocol client of §2, pinned to today's `WorkerKernel` behaviour, before any subprocess work. Then the protocol and handshake in the client and the engine. Then: the engine subprocess on macOS and Linux with the chosen runtime, the bundled engine in the app, engine upgrades, the licence check in CI, and permissions in the engine. **The page items** (carried from r12): the refused-write restore per change kind, progress from the engine's snapshots, Stop through the one client with the restart pattern for the hard kill, a "starting" pill state, and the engine's own words for "where code runs" and "didn't start" (board writes the words) | all lanes, with the §8.1 tests (T1–T5, and T7 for engine upgrades) passing |
| **N3** | Windows parity | all lanes; the same T1 suite passes on the Windows subprocess |
| **N4** | The engine as the desktop default; "Your computer" offers the engine alongside the CPython runner (§4.3) | William |
| **N5** | Later, planned separately: CPython and C extensions, terminals over the protocol, Android native, warm engines | — |
| **N6** | PDFs (§4.1): detecting the person's installed TeX on every compile (standard locations included), running it, and the guidance message when none is found. Deferred until after N4; its own PR series | all lanes, with T6 passing and §7.1's gate met |

### 8.1 Tests

**T1. One conformance suite for every transport.** "A transport may change how a message travels, never what it means" (§2.1) is tested by one suite of protocol cases, run unchanged on each transport.
- **It lives in** `test/engine-protocol/`: the cases, plus one small adapter per transport. It grows from N1-2's conformance rows 1–5.
- **It covers:** run, input and live data; outputs; files; permission; Stop.
- **The transports:**
  - the local subprocess;
  - the in-page wasm worker, in headless Chrome;
  - the relay, against a local relay: engine/py's fake relay in core, and Miniflare in the cloud repo.
- **A new transport, or a new OS for the subprocess, must pass it before it ships.**

**T2. Handshake and skew**, each its own case, using fixture engines rather than real old builds:
- the highest common version is chosen;
- non-overlapping ranges give `incompatible` with the engine's range, and the connection closes. The test asserts that no run message is accepted afterwards;
- only capabilities both sides declared are used. A fixture engine without `latex` shows LaTeX as unavailable, and the client never sends it a LaTeX request;
- an unknown message type within a negotiated version ends the session, never a silent drop;
- fixture engines one version older and one version newer than the app's range: the app falls back to its bundled engine and says so;
- the relay's handshake replaces `RUNNER_MIN` with the same rule;
- the support window, from fixture release metadata with fixed dates (never wall time):
  - a pre-1.0 engine may drop any older version: the test asserts that the set of versions it is required to speak is **empty**;
  - a version superseded before 1.0 gets no window, even after 1.0;
  - the version current at 1.0 is windowed from the first post-1.0 release that supersedes it, not from the 1.0 date;
  - after 1.0: an engine dated the day before the end date, and one dated **on** the end date, still speak $v$; one dated the day after may drop it: the test asserts that $v$ is **no longer required** of it, so a checker whose windows never expire fails;
  - calendar fixtures: a supersession dated 2028-02-29 ends on 2029-02-28, and one dated 2028-01-31 ends on 2029-01-31;
  - two older versions with live windows are both spoken;
  - a control with the computer's clock injected far before and far after the metadata dates: the result doesn't change.

**T3. The §2.2 control contracts, on each transport, deterministically:**
- a stale `pv` or another generation can't reopen writes;
- `ready` echoes `pv`, and no run comes before it;
- a missing acknowledgement or a malformed control frame ends the generation;
- the Stop compare-and-set gives exactly one result per request, across `done`, Stop and the hard restart;
- a late input or live-data answer does nothing.

The hard-restart deadline uses a fake clock or an injected deadline, never wall time, and no test fixes a flake by raising a timeout.

**T4. Controls for the licence check** (§4.2), so a check that never fails can't pass forever:
- an LGPL fixture dependency **outside the Bun runtime** fails, including one named like Bun (`bun-plugin-x`), so a name-prefix matcher can't pass it;
- the Bun runtime's own LGPL inventory entries pass (the scoped exception of §4.2), and the same LGPL entry attached to any other component fails;
- a dependency under an unlisted licence fails;
- an MIT fixture passes;
- `THIRD-PARTY-NOTICES.txt` must regenerate byte-identical from the inventory, so a stale notices file fails.

Wiring it into a workflow file stays William's or @sagebrush's.

**T5. Where they run.** PR CI stays within 10 minutes.

| | Every PR | Nightly, or the APP job |
|---|---|---|
| T1 | Linux subprocess; wasm worker in headless Chrome | macOS and Windows subprocess; relay (local relay) |
| T2 | all cases, against fixture engines | — |
| T3 | Linux subprocess; wasm worker | macOS and Windows subprocess; relay |
| T4 | all controls | — |
| T6 | all cases, against fixtures | — |
| T7 | all cases, with an ephemeral test key | — |

**T6. PDFs with the installed TeX** (N6), against fixture TeX installations:
- precedence: with two distinct fixture TeX installations, one on `PATH` and one in a standard location, the one on `PATH` is used;
- detection beyond `PATH`: a fixture TeX only in an OS's standard location is found;
- **found without a restart:** a fixture TeX installed after the engine started is found by the next compile;
- **gone without a restart:** a fixture TeX that was used, then removed, makes the next compile show the guidance (no cached path is reused);
- with no TeX, the compile shows the guidance message, downloads nothing (a network fixture that refuses connections sees no request) and falls back to nothing;
- the command line with no TeX prints the same guidance and exits with a stated non-zero status.

**T7. Engine upgrade verification** (§4.4), with an ephemeral in-memory test key (§1 item 12) and fixture releases:
- **the positive case:** a release signed by the ephemeral key, with its public key injected as the test's pinned key, passes;
- the same release with one byte altered fails;
- a release signed by a key that wasn't injected fails;
- wrong length, wrong hash, metadata for another OS or architecture or another version, missing metadata and a missing digest each fail before anything is unpacked;
- expired metadata and a rollback to an older version both fail;
- a failure at download, verify, unpack or replace leaves the previous engine byte-identical, and a retry starts clean;
- **a release-configured engine refuses the injection:** the same key injection given to an engine built in its release configuration is ignored, and the ephemeral-signed release is rejected, so a test hook left on in a release build fails T7. The injection hook must not exist in release builds at all;
- the ephemeral key is never written to disk or logged: the test checks its temporary directory and its logs for the key in every encoding (raw, hex, base64, PEM and JWK).

## 9. Questions for William: answered

All five were answered on Nov 7, 2026, between about 2:26 and 2:31 PM PST. They are recorded verbatim in §1 (items 6–10), with the PDF answer revised at about 2:57 PM PST (item 11) and the test-key choice at about 2:49 PM PST (item 12):
- the licence (§4.2);
- "Your computer" (§4.3);
- LaTeX to PDF (§4.1);
- the support window (§2.1);
- the name (§4.1).

## Appendix: what r10 removes

- r12's eight in-app candidates and the Electron head-to-head (r8–r12): the engine is always a subprocess, so where pyjs runs inside the app is no longer a question.
- The recommendation of an N-API add-on inside a Node child as the app's design: that child is now simply the engine.
- The JSC-in-the-webview discussion: the webview runs only the UI now. JSC matters only if the engine runs on Bun.
- Unchanged: route A, no OS sandbox, William's signing, the §2.2 control contracts, the §3 evidence and r4's withdrawn timings.

## Grounding

- **Code at master** (2503bcf7):
  - `src/notebook-session.ts`, `web/worker.ts`, `web/notebook/worker-kernel.js`;
  - `web/notebook/remote-client.js`, `engine/py/python/sagebrush/remote/`;
  - `scripts/build-cli.mjs`, `scripts/install.sh`, `src/latex-cli.ts`;
  - `NOTICE.md`, `packages/sagebrush/package.json`;
  - `engine/interrupt/src/lib.rs`, `engine/ap/src/lib.rs` (#831).
- **Evidence:** the §3 packets.
- **External, checked Nov 7, 2026:** bun.com/docs/project/licensing.
