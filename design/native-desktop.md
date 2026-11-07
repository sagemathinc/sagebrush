# Native engines in the desktop app

*Status: plan r11: the architecture revision (r10) with its tests added (§8.1, r11); docs only, nothing is built. It replaces r12 (merged at 2999416e) with William's architecture decision of
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
- **Sagebrush Engine becomes its own product** (§4):
  - command line only, without the browser app;
  - the engine's own code is MIT, always. Whether a build may include LGPL runtime code (Bun) is William's question (§9);
  - its own releases and upgrades;
  - it runs code and works with LaTeX.
  - One engine serves the desktop app, "Your computer", CI and agents.
- **The Sagebrush App** (§5) ships one known-good engine, so the first run works offline. The engine can then be upgraded on its own.
  - File and network permissions are enforced in the engine.
  - There is still no OS sandbox.
- **Which JavaScript runtime the engine uses is a packaging choice, not architecture.** The options are Bun, Deno and Node's single executable (SEA). V8 against JSC is part of that choice. N1 measures it (§7).
- **Signing and notarizing engine binaries:** William's keys only. Agents never touch them (§6).
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
- **Support window:** an engine keeps speaking at least the previous protocol version for a period that William sets.
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

- **One command-line program.** It runs code in Python (pyjs), Sage, Magma and MATLAB modes, as `sagebrush` does today. It also gains the engine protocol's server side (`--stdio` for the app, the relay for remote).
- **The browser app is cut out.** Today's single-file CLI embeds the web page for `sagebrush notebook` (`scripts/build-cli.mjs`). The engine build leaves it out. The page lives in the app and on the website.
- **LaTeX:** the engine includes today's LaTeX tools (`src/latex-cli.ts`: the expander, the HTML preview, SageTeX).
  - **Today Sagebrush doesn't make PDFs:** the preview is not TeX (`articles/latex/01-how-it-works.md`).
  - "Compiles LaTeX" to PDF would need a TeX engine. Whether to add one, and which, is a separate decision for William. It must also pass the licence check (§4.2).
- **The runtime is a packaging choice:** Bun (`bun build --compile`), Deno (`deno compile`) or a Node single executable. `scripts/build-cli.mjs` already builds all three (`--bun`, `--deno`, `--sea`).
  - The native Rust engine is loaded into that runtime, through N-API or the runtime's own FFI.
  - A Rust module without a native build stays wasm inside the engine.

### 4.2 MIT always: the licence check

- **Today:** Sagebrush is MIT OR Apache-2.0 (`NOTICE.md`), so the MIT licence is always available. The engine keeps that. Changing it to MIT-only is William's call.
- **Every dependency must be MIT-compatible:** permissive, so the engine can be redistributed under MIT terms with the notices kept.
- **The proposed allow-list** is the licences the npm package already carries: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, BSL-1.0, Unicode-3.0, PSF-2.0 (CPython parts) and Artistic-2.0 (Cremona's data).
  - **Not allowed without William's OK:** GPL, LGPL, AGPL, MPL and anything unlisted.
- **A finding for the runtime choice:** Bun says "Bun statically links JavaScriptCore (and WebKit), which is LGPL-2 licensed" (bun.com/docs/project/licensing).
  - So a Bun-compiled engine contains LGPL-2 code, with LGPL's relinking obligations.
  - That fails the proposed allow-list unless William accepts it.
  - Node and Deno ship V8 (BSD-3-Clause) and their own permissively licensed parts. Their full inventories are N1 work (§7).
- **The check (proposed, not yet running):** a script (`scripts/license-check.mjs`) inventories everything that goes into each engine build: the Rust crates, the npm packages bundled, the runtime binary's own parts, and the data. It fails on anything outside the allow-list.
  - It runs in the existing CI `checks` job. Wiring it into a workflow file is done by William or @sagebrush, because agents don't push workflow files.
  - `THIRD-PARTY-NOTICES.txt` is generated from the same inventory.

### 4.3 One engine for local, remote, CI and agents

- **"Your computer" (#778)** today runs `uvx sagebrush@latest remote --loopback`, which is **CPython** with the PyO3 engine, as William chose ("uvx only", Nov 6).
- **Merging means the engine also speaks the relay transport.** The page then talks to "Your computer" with the same protocol and client as to the desktop subprocess.
- **That changes the interpreter on "Your computer"** from CPython to pyjs, and the install from uvx to the engine's installer. **Both are William's decisions** (§9, Q2).
  - Until he decides, the CPython runner stays as it is.
  - The relay, DPoP and terminal designs don't change; only the program at the end of the relay does.
- **CI and agents** run the same engine binary from the command line or over the protocol.

### 4.4 Releases, upgrades, size and start-up

- **Own release cycle:** the engine has its own version and release notes, separate from the app's.
  - The protocol range in the handshake (§2.1) is what ties an app to the engines it accepts, not equal version numbers.
- **Upgrades:**
  - The engine upgrades itself from the release channel (`engine upgrade`). The app can trigger that.
  - Every upgrade is checked against the release's published checksum.
  - Signature checks use William's keys once he sets them up (§6). No agent creates or holds an updater key, not even a test one; development uses unsigned or mock update metadata.
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

- Engine binaries and app installers are signed and notarized **only with William's keys, by William.**
  - This covers Apple notarization, Windows Authenticode and the update signing key.
  - Agents never touch the keys, accounts, certificates or signing steps.
- Until then, every build an agent makes is an unsigned local build, and nothing is published.

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

**The pre-registration** (`proto/n1/harness/PREREGISTRATION.md`, r3, PERF PROTOCOL CLEAR at 98ed461e) becomes r4:
- the labels become the three runtimes above;
- the measurements are those listed here. The page and webview marks are dropped; the subprocess's own marks stay.

r4 goes back to PERF. Counted runs still need PERF's final harness and packet review. William answered the machine questions on Nov 7 (about 12:46 PM PST): Windows runs use a CI workflow he adds himself; the m1 GUI "Yes, for N1 only"; sudo packages and the VM3/VM4 timing box "Yes to both".

## 8. Milestones and tests

| | Work | Gate |
|---|---|---|
| **N0** | r10 reviewed; William's architecture decision recorded | all lanes; William |
| **N1** | §7: runtime comparison, protocol over the pipe, licence inventory; unsigned local builds only | ENGINE, PERF, SIZE, SEC |
| **N2** | The protocol and handshake in the page client and the engine. Then: the engine subprocess on macOS and Linux with the chosen runtime, the bundled engine in the app, engine upgrades, the licence check in CI, and permissions in the engine | all lanes, with the §8.1 tests (T1–T5) passing |
| **N3** | Windows parity | all lanes; the same T1 suite passes on the Windows subprocess |
| **N4** | The engine as the desktop default; "Your computer" on the engine, if William decides so (Q2) | William |
| **N5** | Later, planned separately: CPython and C extensions, terminals over the protocol, Android native, warm engines | — |

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
- the relay's handshake replaces `RUNNER_MIN` with the same rule.

**T3. The §2.2 control contracts, on each transport, deterministically:**
- a stale `pv` or another generation can't reopen writes;
- `ready` echoes `pv`, and no run comes before it;
- a missing acknowledgement or a malformed control frame ends the generation;
- the Stop compare-and-set gives exactly one result per request, across `done`, Stop and the hard restart;
- a late input or live-data answer does nothing.

The hard-restart deadline uses a fake clock or an injected deadline, never wall time, and no test fixes a flake by raising a timeout.

**T4. Controls for the licence check** (§4.2), so a check that never fails can't pass forever:
- an LGPL fixture dependency fails;
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

## 9. Questions for William

1. **The licence allow-list** (§4.2): is the list right (including PSF-2.0 and Artistic-2.0)? Is LGPL-2 acceptable if Bun is chosen? Should the engine stay MIT OR Apache-2.0, or become MIT-only?
2. **"Your computer" on the engine** (§4.3): this replaces CPython with pyjs there, and uvx with the engine's installer. Should the CPython runner stay as an option for people's own Python and packages?
3. **LaTeX to PDF** (§4.1): should the engine include a TeX engine, and which one?
4. **The protocol support window** (§2.1): how long should an engine keep the previous protocol version?
5. **Names:** the engine's command and package names. Nothing is renamed without you.

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
