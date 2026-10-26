<!-- description: A map of how Sagebrush is built: the Rust engine, pyjs (Python compiled to JavaScript), the browser app, the command line, sync, sharing, the servers and the checks, each with a link to the code that shows it best. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and design notes of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
<!-- (written from architecture.board.json by scripts/architecture-article.mjs: edit the board, then run it with --write) -->
# The map

Last updated 2026-10-25, at sagebrush [`cfa609d4`](https://github.com/sagemathinc/sagebrush/tree/cfa609d474f72401fa7e8792a5c2291a7d22b5c5).

This page is the text of the [interactive board](/board/?doc=/articles/architecture/architecture.board.json), region by region. On the board, zoom in on a note for the details shown here under it, and press Play for the reading path.

## Start here

A map of Sagebrush in eight regions, with arrows for the main data flows. Each note links to the one file that best shows its idea. Zoom in on a note for more, and press **Play** for the reading path.

The reading path: (1) the Principles in the README; (2) the engine's JSON door and Stop; (3) pyjs's value representation; (4) the runner's sandbox; (5) the reactive notebook; (6) the workspace's patch history, then sync; (7) sharing's storage rules; (8) the growth gate. Every link is pinned to the commit above.

Start with [`README.md`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/README.md#principles).

## The three journeys

**A cell:** notebook → pyjs → engine (JSON) → result.

**An edit:** an op (or, for a notebook or board, a patchflow patch) in the device's outbox → sync client → account object (→ the document's object, for a patch) → the other device, which is told and pulls.

**A share:** upload → D1 and R2 → the public page → its files, from the files domain.

## Browser app

### Code runs where an escape gets nothing

Someone else's code (a shared collection) always runs in a Web Worker inside a sandboxed iframe with an opaque origin and `connect-src 'none'`: no cookies, no IndexedDB, no network. Your own notebooks and boards use the same runner by default. Nothing is sent to a server to compute.

The page fetches only the files Python needs (the engine, library chunks, a shared collection's files) and the frame copies them in through a SharedArrayBuffer, 4 MB at a time, while the worker waits on `Atomics.wait`, since Python's file reads are synchronous. The worker still checks each file's SHA-256. Stop is a shared flag. It costs about 35 ms of startup. If the frame doesn't answer within a few seconds, your own documents fall back to a plain worker; the desktop app and offline pages don't use the runner.

Source: [`design/runner.md`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/design/runner.md)

### The reactive notebook

Jupyter's cells with marimo's semantics. `src/dataflow.ts` finds what each cell defines and reads, and the scheduler reruns the cells that depend on a change and marks stale outputs. The goal: what you see is what the notebook computes.

`src/dataflow.ts` is a port of marimo's `ScopedVisitor` over pyparse's AST. It agrees exactly with marimo on 3,924 cells and on all 13,032 top-level statements of CPython's standard library. The scheduler is pure logic behind a small host interface, so it's tested without a browser. The notebook is plain DOM, about 110 kB minified.

Source: [`src/notebook-reactive.ts, lines 1–20`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/notebook-reactive.ts#L1-L20)

### Boards (like this one)

A board is a JSON file of notes, code, groups and edges. You describe its structure, and it lays itself out. Code items are reactive, like notebook cells.

The renderer mounts DOM only for items near the viewport. Far out, it draws items on a canvas as colored rectangles, and a note's detail appears only when you zoom in. Agents write boards as files: the format is documented for them in `web/board-format.md`.

Source: [`web/board/board.ts, lines 1–11`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/board/board.ts#L1-L11)

### One workspace, kept in this browser

Notebooks (`.ipynb`), boards (`.board.json`) and data files live in one tree in IndexedDB, with one file browser and one File menu. Every edit to a notebook or board is also a patchflow patch in a history database: that's TimeTravel, and in slice 2 it's what sync sends.

patchflow is CoCalc's patch library. A document is a set of records with primary keys, and each change is a patch with its parents, so any version can be rebuilt and two histories merge. Notebooks and boards share this code (`patch-history.js`). A notebook's save is compare-and-swap on a revision, and a conflict is merged three ways; a board's conflicting save is kept as a copy.

Source: [`web/notebook/patch-history.js, lines 1–8`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/notebook/patch-history.js#L1-L8)

## Python layer (pyjs)

### pyjs: Python 3.14 compiled to JavaScript

`src/` is a compiler written in TypeScript. Python source goes through CPython's own grammar, generated into TypeScript (`pyparse`), to a Python AST and then to JavaScript, which V8 or JavaScriptCore runs. `lib/` holds the part of the standard library written in Python; the rest (sys, os, math, re, ...) is native, in `src/runtime/`.

Because the parser is CPython's grammar, syntax errors match CPython's exactly: message, line and offset. pyjs passes 532 of 536 conformance programs, and pure-Python packages such as mpmath pass their own test suites. Strings are JavaScript strings. Ints have no 4300-digit printing limit by default.

Source: [`src/frontend.ts, lines 1–3`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/frontend.ts#L1-L3)

### Why it's fast

A Python `int` is a JS number while it's within $\pm(2^{53}-1)$, and a BigInt beyond that. That's exactly one representation per value, so telling `int` from `float` takes a `typeof` and a `Number.isInteger`, with no allocation. Lists are JS arrays, `None` is `null`, and `str` is a JS string.

Attribute and method call sites carry inline caches keyed by (class, version), so V8's hidden classes stay monomorphic, and method calls create no bound-method objects. A float is boxed only when its value is integral (or −0.0), which is rare in real floating-point work. PLAN.md is the original experiment: can Python semantics on V8 compete with CPython?

Source: [`PLAN.md, lines 155–170`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/PLAN.md?plain=1#L155-L170)

### Sage mode

Sage's preparser is reimplemented in `src/sagepre.ts`, for what Python's grammar can't express: `[1..10]`, `R.<x> = ZZ[]`, `f(x) = x^2`, and `1.5` read as `RealNumber('1.5')`. (`^` as power and exact division `2/3` are handled by the grammar and the runtime instead.) Preparsed code runs on `lib/sage_all.py` and the `_sage_*` modules: a clean-room, Sage-compatible library on the engines.

Printed output is checked byte for byte against recorded Sage output (`sage-tests/`). Every public function in the tracked modules has Sage-format doctests (749 of 749; DOCTESTS.md), which also run in real Sage as an oracle (`scripts/doctest-oracle.py`). `pip install sagebrush` gives the native engines plus `_sagelib`, a synced copy of these modules for ordinary CPython (`scripts/sync-python-package.sh`).

Source: [`src/sagepre.ts, lines 1–14`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/sagepre.ts#L1-L14)

### Magma and MATLAB, by translation

`src/magma.ts` parses Magma and emits Python that runs on `lib/_magma.py`: 1-based sequences with value semantics, `~x` reference arguments, multiple return values, Magma's printing. `src/matlab.ts` does the same for MATLAB, on `lib/_matlab.py` over Sagebrush's NumPy.

Every MATLAB operator is a runtime call (`a + b` is `_m.plus(a, b)`), because it acts on MATLAB's own values (matrices, char arrays, cells). So Magma and MATLAB run wherever pyjs runs (the notebook, the CLI, Node, browsers), with no second interpreter. The emitted Python carries program text only as string literals (JSON-quoted) or checked names, so a program can't inject code into its translation. `magma-tests/` runs each program under `sagebrush --magma`, and its output must equal Magma's own output for the same program, recorded from Magma and committed; `matlab-tests/` checks against GNU Octave, plus outputs written from MATLAB's documented behaviour wherever Octave differs.

Source: [`src/magma.ts, lines 1–10`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/magma.ts#L1-L10)

## Engine (Rust)

### One core, many engines

The mathematics is pure Rust, one cargo workspace in `engine/`. Shared layers (`arith`, `bigint`, `ball`, `poly`, `mpoly`, `sym`) carry the engines: `modsym`, `ap`, `classgroup`, `galois`, `group`, `hmf`. There are no C libraries in the engines, so they all compile to WebAssembly.

`arith` is in the spirit of FLINT's nmod, nmod_poly, fmpz_poly and fmpz_mat layers: word-size moduli, number-theoretic transforms, CRT, dense matrices over $\mathbb{Z}/p$, $\mathbb{Z}$ and $\mathbb{Q}$. It's clean-room: FLINT and PARI appear only in the `oracle` and `flint` crates, as test oracles and benchmarks, never as dependencies. `hmf` (Hilbert modular forms over $\mathbb{Q}(\sqrt 5)$) is ported from William Stein's PSAGE code, with his permission.

Source: [`engine/arith/src/lib.rs, lines 1–12`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/engine/arith/src/lib.rs#L1-L12)

### Proven, or labelled

Every result says what it rests on: *proven*, *conditional on GRH*, or *heuristic*.

For modular symbols, a characteristic polynomial is rebuilt by CRT from computations modulo primes below $2^{31}$. A prime counts only if its space has exactly the dimension the formulas predict. The number of primes comes from a proven bound on the coefficients: Deligne's $|a| \le 2\sqrt q$ for cusp forms ($1 + q$ for Eisenstein series), sharpened with the exact sum of squares of the eigenvalues (24–25% fewer primes). Class groups are certified under GRH by default, with an analytic certificate.

Source: [`README.md`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/README.md#how-proven-is-earned)

### One wasm file, one JSON door

`engine/web` is a plain wasm32 module, with no wasm-bindgen. Write a JSON request `{fn, ...args}` into its memory, call `sb_call`, and read back `{ok}` or `{error}`. In JSON requests, big integers are decimal strings. Multivariate polynomials use a second, binary entry point (`sb_mp_call`).

That's why the engine runs anywhere WebAssembly does: a browser worker, Node, a chat artifact that forbids `fetch()`. The same functions are bound natively for CPython (`engine/py`, PyO3: the GIL is released, so threads run computations in parallel) and for Node (`engine/node`).

Source: [`engine/web/src/lib.rs, lines 1–12`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/engine/web/src/lib.rs#L1-L12)

### Stop that leaves nothing broken

Long loops call `check()`. After Stop, it panics with a private payload, so the computation unwinds through every frame, running destructors, up to the binding. The binding reports Python's `KeyboardInterrupt`. Caches stay valid, and the next call works.

Natively, a guard held around an engine call from the main thread routes Ctrl-C to the flag for the duration of the call (SIGINT on Unix, the console handler on Windows). In WebAssembly (in a browser or the CLI), `check` asks the host every 1024 calls through the module's one import, `sagebrush.interrupted`; in a browser that reads a flag the page sets in a SharedArrayBuffer. Natively, pressing Ctrl-C three times falls back to the default action, for loops that never check. `check_coarse` asks every time, for coarse units of work. WebAssembly can't unwind, so there the engine instance is discarded, and the interpreter's state, which lives outside it, survives.

Source: [`engine/interrupt/src/lib.rs, lines 1–28`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/engine/interrupt/src/lib.rs#L1-L28)

### Memory: refuse before allocating

A computation works out its memory need before it allocates. If the need is too large, it's refused before anything is built. The Python layer's guards raise one `SagebrushMemoryError`, which says what tried to allocate, how much, and which allowance it exceeded. The engine's own budgets (polynomial factorization) refuse with a message naming the phase, the bytes and the share.

`lib/_capacity.py` is the one place that reads what memory the session can see (pyjs's heap limit; in CPython, the cgroup limits, RLIMIT_AS and RLIMIT_DATA and physical memory, or a Windows job's limit). The host pushes a share of it into the engine before a call (`set_memory_share`, in the interrupt crate), and the engine's default factorization budget follows it. The direction ("no cliffs"): limits follow the memory that's actually there, rather than fixed sizes. Some guards are still fixed sizes, and they say so in their message.

Source: [`lib/_capacity.py, lines 1–30`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/lib/_capacity.py#L1-L30)

## CLI (npx sagebrush)

### The same runtime, in Node

`src/cli.ts` runs Python, Sage (`--sage`), Magma or MATLAB programs, or a prompt. Everything, the engine's wasm included, is bundled into one JavaScript file, so it needs neither Python nor native libraries.

It's on npm (`npx sagebrush`), and there's also a single executable from `get.sagebrush.space`. CI measures its install time and startup time.

Source: [`src/cli.ts, lines 29–39`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/cli.ts#L29-L39)

### A Jupyter kernel without Python

`sagebrush --install-jupyter-kernel` installs a kernel that speaks Jupyter's protocol over a pure-JavaScript ZeroMQ transport.

The main thread owns the sockets, and code runs in a worker thread with a shared interrupt flag. So heartbeats and interrupts are answered while a cell runs.

Source: [`src/kernel.ts, lines 1–14`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/kernel.ts#L1-L14)

### Boards for agents

`sagebrush board check | run | render | open`: an agent writes a board as a file, checks it and runs its code. `board open` shows it in your browser and follows the file as it changes.

The page is served sandboxed, with the same policy the site uses, so a board's text never runs as the local server's origin.

Source: [`src/board-open.ts, lines 1–12`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/src/board-open.ts#L1-L12)

## Sync (backup and devices)

### Local-first: the device is the truth

Sync is backup and multi-device for a signed-in account. Everything works with it off. The workspace's operations go up in order, and data files go up once each, by SHA-256. It's in testing, not yet on sagebrush.space.

Slice 1 (the index and files) is built. Slice 2 (the contents of notebooks, boards and chats, as their patch logs, merged by patchflow) is being built now. One tab per device holds a Web Lock, opens the account socket and sends the outbox. After a lost ack, a resend is answered with the server's stored decision, so nothing is applied twice.

Source: [`web/workspace/sync-client.ts, lines 1–14`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/workspace/sync-client.ts#L1-L14)

### An open contract

`web/sync-protocol/` (MIT OR Apache-2.0) is the protocol both sides import: message forms, limits and checks. The client and the server are tested against the same rules.

Slice 2's byte encodings (`doc-protocol.ts`) have shared test vectors, made by an independent Python implementation, so the client and every server compute the same bytes and hashes.

Source: [`web/sync-protocol/protocol.ts, lines 1–7`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/sync-protocol/protocol.ts#L1-L7)

### A Durable Object per account

For the account socket, the Worker authenticates the session, then talks to exactly one object: the account's. It holds each device's account socket, decides each device's index operations once, in order, pins the blobs (stored in R2) that batches name, and tells the account's other devices when something changed.

Durable Objects are Cloudflare's single-threaded objects with their own SQLite storage: one instance per name, worldwide. The account object is named `acct:` plus the account's hash. The hibernation API keeps idle sockets cheap. The hosted server's code is developed in a separate repository; this one holds its design, the open contract it implements, and its code from when it moved out (`web/sync/`).

Source: [`design/sync-server.md, lines 114–173`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/design/sync-server.md?plain=1#L114-L173)

### A Durable Object per document

Each notebook's, board's or chat's patch log is its own object. It checks the patch graph (each client's patches numbered consecutively, every parent present) but never parses the patches themselves, and appends each batch in one transaction, with a compare-and-swap on the head when a writer asks for one (an agent's write does).

Since the server never reads document contents, the merge happens on devices, with patchflow, the patch-merge library also used by CoCalc. Writes reach it through its owner's account object, which authenticates and admits them; a live document socket attaches to it directly, with a one-time ticket from that account object.

Source: [`design/sync-server.md, lines 174–194`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/design/sync-server.md?plain=1#L174-L194)

## Sharing

### Sharing a collection

You sign in with CoCalc (OAuth with PKCE). The page hashes each file, asks which ones the server lacks, uploads only those, then commits a version `{title, license, files}`. A share is `/s/<id>`, and a frozen version is `/s/<id>@<hash prefix>`.

The session is a `__Host-` cookie, stored on the server only as its SHA-256. The same sign-in and account hash are reused by sync. Shared code runs in the runner, with no fallback.

Source: [`web/share-client/upload.ts, lines 1–3`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/share-client/upload.ts#L1-L3)

### D1 and R2, without a shared transaction

Each upload is its own R2 object. Bytes are reserved by one conditional INSERT before they go up. A write that depends on an earlier check ends in one D1 batch, with a guard row. R2 deletes go through an outbox.

So any failure leaves a state that the scheduled job finishes. Deduplication is per account, so nobody learns whether someone else has a file. A deleted CoCalc account keeps a tombstone, by hash, and CoCalc's signed purge requests delete all of an account's data.

Source: [`web/share/server.ts, lines 19–41`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/share/server.ts#L19-L41)

### A separate domain for user bytes

Shared files are served only from `files.cocalcusercontent.com`, only through a collection that has them, and always as `application/octet-stream` attachments with a sandboxing CSP. An uploaded `.html` or `.svg` can never become a page.

Files are named by their hash, so they're cached in the browser for good. Range requests work, so code that reads part of a large file doesn't download it all. "Not shared" and "absent" are the same 404.

Source: [`web/share/files.ts, lines 1–12`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/web/share/files.ts#L1-L12)

## Cloud and deploy

### Open core, separate servers

This repository (MIT/Apache) holds everything that runs in a browser or on your computer, plus the sync protocol and client. The servers that run sagebrush.space are maintained separately, built on that open protocol.

The open repository still has the sharing and sync servers' code from when they moved out (`web/share/`, `web/sync/`), MIT/Apache, used by its own tests; the links in Sharing point to it, and those in Sync to the server's design. The deployed servers have changed since, so read those links for the design, not as the exact code running today. What you run locally, from the CLI or the desktop app, needs no server at all.

### Cloudflare: Workers, Durable Objects, D1, R2

The site is a Cloudflare Worker that serves static files, the articles and the share API. Shared files have their own Worker, on their own domain. Sharing's records are in D1 (SQLite), and file bytes are in R2 (object storage).

Sync adds Durable Objects, one per account and one per document. A separate test deployment runs the same code with sync turned on for test accounts; production doesn't route sync yet. No secret is ever in a repository.

### Engines by content, kept forever

Each build's engine (the worker, the wasm and the library chunks) is published at `/engine/<id>/`, where the id is a hash of its manifest. Files are served as immutable.

A board or notebook saved with one engine can keep running with exactly that engine, years later, and the page checks every file's SHA-256. A downloaded board can even embed its engine and run from a `file://` page.

Source: [`design/engines.md`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/design/engines.md)

## CI and checks

### Gates, not just tests

One `ci` workflow covers Rust, wasm, CPython, Node, browser suites, conformance and the language modes. Pull requests run a fast, path-filtered subset, and a full run on the exact head comes before a merge.

The growth gate fails any growth of the core, beyond a small jitter allowance, that has no reviewed marker in `.growth/`; an optional package may never grow the core. Heap budgets and CLI startup are measured with pinned toolchains.

Source: [`design/size-gate.md`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/design/size-gate.md)

### Limits are registered

`test/limit_sites.py` lists every line that looks like a limit or a refusal in `lib/`, `engine/` and `src/`, and checks the list against a reviewed registry. A new cap can't slip in unnoticed.

It's a lexical change detector, not a proof, and it says so itself. The registry gives each site a class. A limit on a user's own computation (work, time or input size) is unlimited by default, and finite only by opt-in through `lib/_limits.py` or a trusted host such as a grader. It pairs with the "no cliffs" work in the engine.

Source: [`test/limit_sites.py, lines 1–12`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/test/limit_sites.py#L1-L12)

### Other systems as oracles, from outside

Sage, Magma, PARI and FLINT are used only from the outside, as black boxes: byte-for-byte output tests (`sage-tests/`, `magma-tests/`, doctests run in Sage), oracles and benchmarks. Their code is never read, translated or copied. smalljac is an oracle too; the a_p engine follows its strategy, written from scratch with its author's permission (`engine/ap/PROVENANCE.md`).

When Sagebrush and another system compute the same class group or newform and agree, the answers come from independent implementations. That agreement is evidence about both.

Source: [`CONTRIBUTING.md, lines 10–21`](https://github.com/sagemathinc/sagebrush/blob/cfa609d474f72401fa7e8792a5c2291a7d22b5c5/CONTRIBUTING.md?plain=1#L10-L21)
