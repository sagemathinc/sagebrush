# TimeTravel replay: the live session at any point in the history

**Status:** design and feasibility study (October 11, 2026). The experiments
are run; nothing is implemented yet. Two runtime bugs found along the way are
fixed (see the end).

## The idea

TimeTravel already records every edit of a notebook. If it also recorded
**each execution** (which cells ran, in what order, with what source, and how
long each took), then at any point in the history Sagebrush could:

1. **Recreate the live session exactly as it was**: the variables, not just
   the text.
2. **Say how long that will take**: "Resume from here — about 8 seconds".

A **portable bundle** extends this: the history and every file the session
loaded (a `.mat` file, a CSV) in one file, opened on another device.

## What exists today

- **The history** ([web/notebook/history.js](../web/notebook/history.js)) is
  patchflow patches on CoCalc-style records:
  - `{type: "settings", kernel}`;
  - `{type: "cell", id, pos, input, cell_type}`.
  - Outputs are not kept. `record(doc)` commits on each change, and
    `docAt(time)` rebuilds any version.
- **The kernel** ([worker-kernel.js](../web/notebook/worker-kernel.js),
  [src/notebook-session.ts](../src/notebook-session.ts)) already has most of
  the hooks a journal needs:
  - **Runs:** each run has an id; its messages are `{id, start}` …
    `{id, done, ms}`.
  - **Restarts:** the kernel's `generation` counter changes on each one.
  - **@interact:** control changes rerun the function as `{id, interact, values}`.
  - **Files:** the page sends `{files}` at start and `{fsPut}` on upload, and
    the worker reports `{fsChanged}`.
- **The worker is a closed world.**
  - There is no network: the only request is the engine's `.wasm`.
  - `input()` raises `EOFError`.
  - Files arrive only as messages from the page.
  - So the inputs to a session are few and all visible to the page, which
    is what makes this idea practical. On a desktop kernel it would be
    hopeless.

## Feasibility: what was measured

### 1. There is no memory image to snapshot: replay is the mechanism

pyjs compiles Python to **JavaScript** ([src/compile.ts](../src/compile.ts)).

- **Where the state lives:** the session's variables are JavaScript objects
  (functions are closures), and no browser API can snapshot a JavaScript
  heap. The Rust engines are WebAssembly, but they are called with strings
  and hold only caches.
- **So there is no "save the memory block"** as there would be for CPython
  compiled to WebAssembly.
- **Restoring means replaying the runs.** Snapshots, if any, are a later
  speed-up through `pickle` (section 5).

### 2. With four things pinned, two fresh sessions are identical

**The experiment** ([experiment.mjs](timetravel-replay/experiment.mjs)) used
the real `sagebrush-worker.js` in headless Chromium. It ran 12 cells in fresh
workers:

- **unpinned:** twice;
- **pinned:** twice with the same seed, and once with a different seed.

[pin.js](timetravel-replay/pin.js) runs before the runtime loads and replaces
`Date.now`, `performance.now`, `Math.random` and `crypto.getRandomValues`
with seeded or virtual versions.

| Cell | Unpinned runs agree | Pinned runs agree |
|---|---|---|
| `random.random()`, `randint` | no | **yes** |
| `time.time()`, `perf_counter()` | no | **yes** |
| `np.random.default_rng().integers(...)` | no | **yes** |
| `os.urandom(4)` | no | **yes** |
| Sage `randint(1, 10^9)` | no | **yes** |
| set order, `hash()` of str/tuple | yes | yes |
| `id(object())` (a counter in pyjs) | yes | yes |
| `factor(2^128 + 1)`, `solve(...)` | yes | yes |
| `pickle`, `factorial(30000)` | yes | yes |

**Pinned, every cell's output was identical.**

- **The time costs were stable:** total 3.64–3.74 s across the five runs.
- **Startup:** about 120 ms for the worker, plus about 1.5 s to import
  `sage_all` on the first Sage cell.
- **Two details:**
  - Pinning `performance.now` inside the worker also zeroed the kernel's
    reported `ms`, so **durations must be measured by the page**, outside
    the replayed world.
  - With no seed given, `np.random.rand()` gives seed 0's stream: it is
    deterministic, but NumPy's default is fresh entropy.

### 3. The sources of nondeterminism, completely

This list comes from searching `src/runtime`, `web/shims` and the Rust
engines:

| Source | Where | Treatment |
|---|---|---|
| Clock | `time.*` ([modules.ts:227](../src/runtime/modules.ts)); file mtimes in [web/shims/fs.ts](../web/shims/fs.ts) | record the values read (below) |
| Entropy | `random.seed(None)` (`Date.now`), `os.urandom`, numpy's `default_rng`, `Math.random` | one seeded generator per session; the seed is in the journal |
| Files | `{files}`, `{fsPut}` from the page | content hashes in the journal; the bytes in the bundle |
| @interact values | `{id, interact, values}` | journaled as runs |
| Tab completion | `complete(main, ...)` can evaluate attribute access (properties) | ignore (rare); note it |
| Float math in JS | `Math.sin` etc. differ between browsers (section 4) | one deterministic libm |
| Engine and runtime version | the build | the content hash in the journal |
| Rust engines | clock reads are diagnostics only and a no-op on wasm32; search budgets are counts, not times | nothing to do |

Things that are **not** sources:

- **Hash randomization:** pyjs has no hash seed.
- **Set order:** follows insertion.
- **`id()`:** a counter.
- **GC timing:** this would matter only through `__del__` or weakref
  callbacks, which are rare in notebooks. Not checked further; divergence
  detection (below) would catch it.

### 4. Across browsers: Python's float math differs today

This matters for the portable bundle. JavaScript does not specify
`Math.sin`, `Math.exp`, … to the last bit. On 200,000 pseudo-random inputs
([mathcmp.js](timetravel-replay/mathcmp.js)), V8 (Chrome, Node) and
JavaScriptCore (Safari, Bun 1.3) disagreed as follows:

| Function | Disagree | Function | Disagree |
|---|---|---|---|
| `hypot` | 37.8 % | `sinh` | 3.1 % |
| `atan2` | 14.6 % | `log` | 2.7 % |
| `cbrt` | 8.3 % | `cos`, `sin`, `tan` | 1.7–1.9 % |
| `exp` | 5.3 % | `atan` | 1.1 % |
| `asin` | 2.9 % | `pow` | 0 |

Coverage today:

- **Already deterministic:** pyjs ports glibc's `log`, `exp` and `log1p`
  ([libm.ts](../src/runtime/libm.ts)) for NumPy's random streams. `math.exp`
  uses them.
- **Still browser-dependent:**
  - `math.sin`, `math.cos`, `math.hypot` …;
  - `cmath`;
  - most of numpy's ufuncs.

Same-browser replay is exact today. **Cross-browser replay needs one
deterministic libm for every transcendental function.** Two ways:

- extend `libm.ts`;
- compile a libm (musl's, or CORE-MATH's correctly rounded one) to
  WebAssembly.

Choosing glibc's algorithms would also make pyjs agree with CPython on
Linux, a conformance gain on its own.

### 5. Snapshots via pickle: mostly possible, with known limits

To test this, a namespace was pickled in one process and loaded in a fresh
one.

**What round-trips:**
- Integer, Rational, `RR` and `RealField(100)` numbers;
- symbolic expressions, polynomials, matrices, factorizations;
- `GF(7)` elements, number fields, elliptic curves;
- dicts, sets, tuples.

**What doesn't, as in CPython:**
- **Lambdas and generators** can't be pickled.
- **Functions and classes defined in cells** pickle by name: restoring them
  needs their definitions first.

**Bugs found and fixed** (7ac0b83):
- `RR(pi)` came back as `0.0`. No `__getnewargs__` existed on the built-in
  types, so the value of every `int`, `float`, `str`, `bytes` and `tuple`
  subclass was silently dropped.

**Still open:**
- Unpickling a numpy array fails.
- Protocol 0 fails for those subclasses (pickle's default is protocol 5).

**Conclusion:** snapshots are a possible later speed-up, not the foundation.

## Design

### The execution journal: in the same history

Runs become records in the same patchflow document as the cells:

- **The document stays a single history:** TimeTravel, CoCalc sync and the
  bundle carry them for free.
- **`docAt(time)` is unaffected:** it ignores unknown record types.

```js
{type: "run", id: "r17", cell: "c3", at: "<history version>", gen: 2,
 start: 1791684316669, ms: 1594.1, status: "ok" | "error" | "interrupted",
 out: "<hash of the outputs>", clock: [1791684316.669, ...]}
{type: "interact", id: "r18", run: "r12", values: {n: 7}, ...same timing fields}
{type: "restart", id: "r19", gen: 3, seed: "<256-bit seed of the new session>"}
{type: "file", id: "f2", path: "data.mat", hash: "sha256:...", size: 48213}
{type: "env", runtime: "<content hash>", engine: "<content hash>", agent: "Chrome 148"}
```

**`at` is the key.** Before a run starts, the page commits the history and
records that version. So the source that actually ran is always recoverable,
including when the cell is edited afterwards without being run again. Astra's
example: `a = 10` runs, then the cell is edited to `a = 20`.
- **The restored text** shows `a = 20`.
- **The restored session** has `a == 10`.
Both come from the same journal.

### Determinism: record or seed, never pin the user's clock

- **Entropy:**
  - Each kernel generation gets a 256-bit seed, generated by the page and
    journaled in the `restart` record.
  - A ChaCha20 stream seeded with it feeds `Math.random`,
    `crypto.getRandomValues` and `os.urandom`.
  - Live behavior is unchanged statistically.
  - **The trade-off to state plainly:** anyone holding the history can
    reproduce the session's "random" values, including `os.urandom` and
    `secrets`. For a math notebook that is the point. A per-notebook switch
    can turn journaling of randomness off.
- **Clock:**
  - A virtual clock would break `%timeit` and every benchmark in a live
    session.
  - Instead, the live session reads the real clock, and the run record
    keeps the values read, as rr does.
  - On replay, the reads return the recorded values in order. If a replay
    reads more values than were recorded, it has already diverged.
  - Long timing loops produce many values, so the record is capped (for
    example at 10,000 reads). A run above the cap is marked "clock-dependent:
    not exactly replayable".
- **Divergence is detected, not assumed.**
  - Each run journals a hash of its outputs. On replay, the first mismatch
    is reported: "the replay diverged at run 17 (`[5]`)".
  - This turns "exactly" from a promise into a check, and it catches every
    gap in this list we did not foresee.

### Restore points and the time estimate

**Restore points** are the boundaries after completed runs.
- A run that was interrupted, or errored after side effects, replays as it
  happened. Its status is recorded.
- A restore point inside a run is not offered.

**Only the runs since the last restart before the point matter**, because a
restart empties the session. So the estimate is

$$T \approx t_{\text{start}} + t_{\text{import}} + s \sum_{\text{runs since that restart}} t_i ,$$

where:
- $t_{\text{start}}$ is the worker startup, about 120 ms;
- $t_{\text{import}}$ is the first `sage_all` import, about 1.5 s;
- $t_i$ is each run's recorded duration;
- $s$ is the speed ratio of this device to the recording one.

**Measuring $s$:**
- At first, take it from a 50 ms microbenchmark recorded in the `env` record
  and run again here.
- During the replay, refine it as runs complete. The progress bar shows the
  estimate converging.

### The UI

- **Timeline:** TimeTravel's slider shows the runs as tick marks, colored by
  status, with restarts marked.
- **Selecting a version** shows its text as today, plus:
  - "Resume from here — about 8 s (12 runs)";
  - or "not replayable: depends on an interrupted run (`[4]`)".
- **Resume opens a fresh session** (a new tab, or a fork of the notebook)
  that replays with a progress bar. The current session is untouched. Forking
  is just this with "save as".

### The portable bundle

**A `.sbreplay` file** (a zip) contains:
- the patchflow patches (text and journal);
- each journaled file's bytes, by hash;
- the `env` record.

**Opening it on another device** means a replay with divergence checking.
- **Same browser engine:** the replay should match exactly today.
- **Across engines:** it needs the deterministic libm first (section 4).

**Versions:**
- **The recorded version:** asset URLs already carry content hashes
  (`sagebrush-engine.wasm?h=...`). Keeping old builds available makes
  replaying under the recorded runtime possible.
- **The current version:** replaying under it is a different and equally
  useful experiment. Every saved notebook becomes a regression test, and a
  diverging output is a candidate bug report with a reproducer attached.

### For agents (MCP)

The same operations as methods:
- `timeline()`;
- `resumeAt(version) -> session`;
- `replay({upTo, verify}) -> {diverged?: {run, expected, got}}`;
- `bisect(predicate)`: find the first run after which an expression changes
  value.

With exact replay, bisect takes about $\log_2 n$ replays.

## Phases

| # | Work | Size |
|---|---|---|
| 1 | Journal `run`, `interact`, `restart`, `file` and `env` records (commit the history before each run; page-measured durations; output hashes); show run marks in TimeTravel | small |
| 2 | Deterministic worker: seeded ChaCha20 entropy per generation; clock-read recording and replay | small–medium |
| 3 | "Resume from here": fresh worker, replay with progress, estimate, divergence report | medium |
| 4 | Deterministic libm for `math`, `cmath` and numpy (port, or WebAssembly); a cross-engine check in CI (Chromium + WebKit via Playwright) | medium |
| 5 | `.sbreplay` export and import | small |
| 6 | Agent API and bisect; replay under the current version as a regression mode | small each |
| 7 | (optional) pickle keyframes for long sessions | medium; needs the numpy-unpickle fix |

Phases 1–3 deliver the feature on one device. Phases 4–5 make it portable.

## Open questions

1. **Seeded entropy by default?** It is needed for exact replay of anything
   random. The cost is that the history reveals the random values.
   Recommended: on, with a per-notebook off switch.
2. **Clock:** record reads (recommended), or a virtual clock (simpler, but
   it breaks benchmarking)?
3. **Journal size:** run records are small, but clock arrays and file blobs
   are not. Should the history keep file hashes only, with bytes in the
   bundle and in IndexedDB?
4. **CoCalc:** should run records sync into CoCalc's Jupyter syncdb as an
   extra record type, so CoCalc's own TimeTravel can show runs?

## Found along the way (fixed, pushed)

- **ce65d42:** `hash(1.5)` in Sage mode raised RecursionError: a Sage real
  literal's `__hash__` calls `float.__hash__(self)`, which dispatched back to
  it. The same bug existed for `int` and `str` subclasses.
- **7ac0b83:** pickling an `int`, `float`, `str`, `bytes` or `tuple` subclass
  dropped its value (`RR(pi)` came back as 0). A `bytes` subclass's internal
  storage also leaked into its pickled `__dict__`.
