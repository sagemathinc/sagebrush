# N1-0 pre-registration (draft r0, for PERF code review before any counted run)

*#825 N1 plan r3 (f391bdb1), item N1-0, with daybreak4's N1-PERF-3 and the guardrails of their 0dca2358 read. Branch
n1-native-proto, never merged. Nothing here is a counted result. Counted runs start only after PERF reviews this file
and the harness code, and after William's machine answers (Q1, Q2, Q3, Q5) where a run needs a machine.*

## 1. What is measured, per candidate (1: Tauri + Node + N-API; 2: Electron utility process; 3: Tauri + embedded-V8 helper; 4: boundary spike only)

| Id | Measurement | Definition |
|---|---|---|
| M1 | **startup marks** | Three timestamps from process launch (the harness's `spawn` instant, monotonic clock): **first paint** (the page's `requestAnimationFrame` after the first contentful paint, posted to the harness); **page ready** (the notebook page's own ready event); **kernel ready** (the kernel's `ready` message reaching the page, with Sage's library loaded in a second variant). |
| M2 | **cold and warm** | **Cold:** after a reboot, or where the OS allows it, after dropping the page cache (`echo 3 > /proc/sys/vm/drop_caches` needs sudo: Q3), with a fresh user-data directory. **Warm:** the second launch, same data directory, within 60 s. Each counted row says which. |
| M3 | **engine calls** | First and steady (median of the 2nd–8th) wall time of fixed engine calls, from the page's call to the reply in the page: `aplist(199999)`, `det` 200×200, `factor` 41 digits; each result hashed and checked against the frozen expected hash. |
| M4 | **memory** | RSS and PSS summed over the **whole process tree** of the app (every descendant, via `/proc/*/smaps_rollup` on Linux, `footprint`/`vmmap` on macOS, the Job's accounting on Windows), at: after first paint; after kernel ready; after M3's calls. |
| M5 | **scaling** | M1 (kernel ready) and M4 (after kernel ready) with 1, 2 and 4 identical documents open and ready; incremental memory per document. |
| M6 | **> 4 GB case** | A pre-defined engine computation whose peak working set exceeds 4 GiB (chosen and its expected result hash frozen before any run; candidates: a large modular-symbols space or a dense exact matrix), recording peak/high-water memory, wall time and result correctness. |
| M7 | **Stop** | Cooperative Stop: the time from the control frame's send to the kernel's terminal `done`, during a deliberately blocking engine call (`spin`) and during `aplist` (which checks per prime after #831). **A `stop()` that returned true but whose call ran to completion is recorded as a Stop FAILURE, never as completion.** The 2 s hard restart is recorded separately, never mixed into cooperative Stop latency. |
| M8 | **permission acknowledgement window** | The time from a revoke's control frame to the child's acknowledgement while a busy cell writes in a loop, and the count of in-window writes refused at the page. |
| M9 | **framing copies** | The bytes and time of the host↔child frames for M3's calls. |
| M10 | **big-integer corpus** | The corpus (frozen list of operations and sizes, result hashes) in each candidate's **actual pyjs runtime and boundary**; system webviews only for candidate 4's spike. |

## 2. Statistics and run discipline

- **Processes:** one discarded warm-up process per candidate and configuration, then **N = 7 counted processes**.
- **Interleaving:** balanced and randomized. Each round runs every candidate once in an order from a seeded permutation (the seed is recorded); rounds repeat N times.
- **Statistic:** per process, the median of the in-process repetitions. Across processes, the median of those medians, with the range.
- **Discard and failure rules (closed):**
  - A process that crashes, times out (each measurement has a fixed deadline, recorded), or gives a wrong result hash is a FAILURE row. It is reported, never silently re-run, and never counted as a timing.
  - A round is re-run only if the machine's load before it exceeded the recorded threshold (1-minute load > cores/4). The skipped round is reported.
  - Nothing else is discarded.
- **Metadata per process:** time, load (1/5/15 min), CPU model and governor, power state where readable, swap use, free memory, the package hashes, the exact commit.
- **Sensitivity control:** a known slowdown injected into the harness's own path (a fixed 20 ms busy wait before kernel ready, in one marked configuration) that the statistics must detect. If it can't be seen above the noise, the run is not valid for that measurement.

## 3. Freezing

Each packet is frozen before any cleanup:
- the raw per-process outputs, the harness code at its commit hash, the commands, the tool versions (`node`, Tauri CLI `@tauri-apps/cli@2.12.4` and `tauri --version`, Electron v45.2.3, rustc), the package and add-on hashes;
- the size schema of plan r3 (wire, update transfer, logical installed, allocated, component inventory);
- SHA256SUMS, read-only.

## 4. Guardrails carried from PERF (daybreak4)

- **E3's f64 reply** is valid only for the bounded `aplist` experiment. Before any wider use, add fixtures beyond $2^{53}$ (rejected explicitly, or encoded exactly) and tag None in the schema so a real NaN can't alias it.
- **Uncounted dev rows** (E3, the 0dca2358 Stop pins) never enter architecture rankings or final speedup claims.
- **macOS without GUI permission** (Q2): build and size only, plus explicitly relative E-core micro-results. **Windows:** a stable dedicated VM for counted timings (Q1); GitHub Actions may supply bytes only.

## 5. Open items for PERF review

1. The > 4 GB computation (M6): which one, and its envelope.
2. N = 7 and the load threshold.
3. The sensitivity control's size (20 ms).
4. Cold-start method where dropping caches isn't allowed (macOS without root; Windows).
