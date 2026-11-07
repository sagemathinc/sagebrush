# N1-0 pre-registration (draft r1, for PERF review before the protocol is frozen)

*This is item N1-0 of the #825 N1 plan r3 (f391bdb1). It folds in daybreak4's PERF review of r0 (eecf6da6,
`reviews/n1-prereg-eecf6da6-perf-daybreak4.md`, items P1–P10 below) and their earlier guardrails. Branch
n1-native-proto, never merged. Nothing here is a counted result.*

*Gate.* Before any counted run, the final pre-registration names:
- the exact harness commit;
- every frozen file: `schedule-*.json`, `controls.json`, `corpus/m8-writes.json`, `corpus/m10-bigint.json`, `m6.json`, `expected-hashes.json`.

PERF reviews that code and that packet before authorizing a counted run. Runs that need a machine also wait for William's answers to Q1, Q2, Q3 and Q5. Values marked **[pilot]** are picked from uncounted pilot runs and frozen in those files before counting starts. Pilot data never enters a counted result.

## 1. Candidates, baseline, comparisons

Candidates:
- **1:** Tauri + Node sidecar + N-API add-on;
- **2:** Electron utility process;
- **3:** Tauri + embedded-V8 helper;
- **4:** boundary spike only, never ranked.

The **baseline** of every paired comparison is candidate 1. Comparisons are made only **within one OS, one machine class and one metric definition** (P7). Results are never ranked across OSes, across unlike cache treatments (P1), or across different memory definitions.

## 2. Measurements

### M1 startup marks (P2)

The page runs one frozen event sequence, the same in every candidate. Its source is `harness/page-marks.js`, frozen.

| Mark | Event | Notes |
|---|---|---|
| `fcp` | the `first-contentful-paint` entry from `PerformanceObserver({type:'paint'})` | If the webview has no paint timing, the row is **not available** for that candidate. There is no fallback. |
| `render-proxy` | double `requestAnimationFrame` after the first content node is inserted | Named a **render-opportunity proxy**, not presentation. Recorded in every candidate. |
| `page-ready` | the notebook page's own ready event | |
| `kernel-ready-base` | the kernel's `ready` message reaching the page, base engine | |
| `kernel-ready-sage` | the same, with Sage's library loaded | A **separate row**, never merged with base. |

**Clocks.**
- **Primary value:** the harness's own monotonic clock (`process.hrtime.bigint()`). It is measured from the `spawn` call to the **arrival at the harness** of the page message sent at the event. This includes page-to-harness delivery. That delivery cost is reported per candidate as the empty-message RTT/2 control, measured in the same process after `page-ready`.
- **Secondary value:** the renderer timestamp (`performance.timeOrigin + entry.startTime`), mapped to harness time.
  - The mapping uses 5 ping/pong handshakes after `page-ready`. The one with the minimum RTT gives the offset, and its RTT/2 is the stated uncertainty.
- The two values are never mixed in one row.

### M2 cache treatments (P1)

| Treatment | Procedure | Ranked? |
|---|---|---|
| **T1 profile-cold** (primary) | A new process with a fresh user-data directory. The OS file cache is left as it is. The previous process in the round has exited and the admission gate (§3) has passed. | Yes |
| **T2 warm** | The next launch of the same candidate with the same user-data directory. It starts **10 s after the harness observes the T1 process's exit**. | Yes, within T2 only |
| **T3 boot-cold** | Exactly one launch per boot, from a pre-generated reboot schedule. The schedule rotates which candidate gets each boot, so every candidate gets the same number of first-after-boot launches. | Only if T3 is run at all. It is never compared with a non-first launch. |

`drop_caches` is **not used** on any OS.

### M3 engine calls (P6)

- **Call set:**
  - `aplist(199999)`;
  - `det` of a seeded 200×200 integer matrix;
  - `factor` of a fixed 41-digit integer;
  - each result is hashed against `expected-hashes.json`.
- **Execution:**
  - One kernel per process, so all calls share that kernel. That shared state is recorded.
  - 8 repetitions of the set. Inside each repetition, the order of the three calls is a seeded rotation, recorded per process and balanced across processes.
  - No forced GC, and no GC flags beyond each runtime's shipped defaults, which are recorded.
  - The JIT is in its natural state.
- **Reporting:**
  - The **first call** of each kind is its own row.
  - Steady state is the median of repetitions 2–8.
  - All 8 repetitions are kept in the raw packet.

### M4 memory (P7)

The definition is per OS. Values are never compared across OSes.

| OS | Metric | Tree membership |
|---|---|---|
| Linux | **PSS** (shared pages split proportionally), plus USS, from `/proc/<pid>/smaps_rollup` | The launched pid and every descendant. The tree is re-walked through `/proc/<pid>/task/*/children` at each sample. |
| macOS | **phys_footprint** per process, from `footprint`, summed | The same descendant walk, via `pgrep -P`, recursive. |
| Windows | Job object **private commit** and **PeakProcessMemoryUsed** | Every process assigned to the harness's Job. |

**Sampling.**
- Samples are taken at the marks: after `render-proxy`, after `kernel-ready-base`, and after M3.
- At each mark the harness waits for stability: three consecutive 500 ms samples within 2 % of each other, up to 10 s. If they never settle, the row is marked **unstable** and the last sample is recorded.
- Swap in use is recorded at every mark.

### M5 scaling

M1 `kernel-ready-base` and M4 after kernel ready, with 1, 2 and 4 identical documents open and ready. The result is the incremental memory per document.

### M6 the over-4 GiB case (P8)

The case is frozen in `m6.json` before any counted run.
- **Computation:** a **dense exact integer matrix** computation through the engine's existing matrix path, the same call in every ranked candidate.
  - The matrix comes from a recorded seed.
  - Its dimension and entry size are **[pilot]**. They are calibrated to a **target peak of 5.0–6.5 GiB** in candidate 1 on Linux. Modular symbols are not used.
- **Expected result:** a hash, frozen.
- **Deadline:** **[pilot]** ×3.
- **Machine:** at least 16 GiB of RAM.
- **Memory:** high-water sampling at 10 Hz on the M4 tree. The peak is reported per candidate.
- **Swap and OOM:** if swap use grows during the run, or there is any OOM intervention, the row is **invalid** for both correctness and timing. It is reported, never re-run silently.

### M7 Stop (P9)

- **Calls:** `spin` (blocking) and `aplist` sized at **[pilot]**. The size is chosen so that its no-Stop duration on the **fastest** candidate is at least 10× the trigger delay.
- **Trigger:**
  - The harness waits for the RUN/ARMED acknowledgement of the call's token.
  - It then waits a fixed **200 ms**.
  - It checks that the call is still running: the token is still armed in the RUN state and no reply has arrived.
  - Only then does it send Stop.
- **Recorded marks:** `t_send` (Stop frame written), `t_accepted` (Stop accepted, acknowledgement received) and `t_done` (terminal `done`).
  - The reported rows are send→accepted and accepted→done. The total is a separate row.
- **Outcomes, closed:**
  - An accepted Stop whose call **ran to completion** is a **Stop FAILURE**.
  - A **rejected or late** Stop is not a latency row. Examples are a stale token, or a call that was already retired. If more than one of the 7 Stops in a configuration is rejected or late, the configuration is invalid.
  - The deadline is 5 s from `t_send`. Passing it is a FAILURE.
- **The 2 s hard restart** is its own row, never mixed into cooperative latency.

### M8 permission acknowledgement window (P10)

The corpus is `corpus/m8-writes.json`, frozen. A busy cell attempts one numbered write every **[pilot]** ms. Each attempt is logged with:
- its attempt time;
- the pv and gen seen;
- whether it was **allowed or refused**, and by which layer.

**Counts.** Attempts are classified relative to `t_revoke_send` and `t_ack`, in three windows: before send, between send and ack, and after ack. The rows are:
- the ack latency;
- attempted, allowed and refused counts in each window.

**Correctness.** **Any allowed write after `t_ack` is a FAILURE.**

### M9 framing decomposition (P6)

For each M3 call, the harness records the time and the **bytes at each boundary**. The stages are:
1. page/host encode
2. framed write
3. child decode
4. engine
5. child encode
6. framed read
7. page/host decode

**Control.** An **empty framed round-trip** (a 0-byte payload) runs 8 times per process.

### M10 big-integer corpus (P10)

The corpus is `corpus/m10-bigint.json`, frozen. It holds:
- the operations: `mul`, `divmod`, `pow` mod, `gcd`, `int→str` and `str→int`;
- operands from a seeded generator, at bit sizes $\{64, 2^{10}, 2^{14}, 2^{17}, 2^{20}\}$, including the runtime's algorithm-switch boundaries ±1 limb;
- the dispatch path recorded per operation;
- warm-up 2, repetitions 7;
- result hashes and per-operation deadlines.

It runs in each candidate's actual pyjs runtime and boundary. System webviews are used only for candidate 4's spike.

## 3. Run discipline

### Schedule (P4)

- The full seeded schedule is generated and **frozen before running**, in `schedule-<os>-<treatment>.json`. It lists every round and the candidate order within each round. Orders are seeded permutations, balanced so that each candidate holds each position equally often over the rounds.
- One uncounted warm-up process runs per candidate and configuration, then **N = 7 rounds**.

### Pre-round admission gate (P4)

The gate runs before the first candidate of a round starts. It takes 5 readings at a 2 s cadence:
- CPU idle at least 95 % in each interval;
- 1-minute load at most cores/4;
- no process outside the frozen allow-list snapshot of the box using more than 1 % CPU;
- governor and power source as recorded at freeze; on battery is never admitted;
- no thermal throttle flag where readable;
- swap in use unchanged since freeze.

If the gate fails, the harness waits 60 s and retries, up to 10 times. A round that is never admitted is recorded as **not admitted**, and the schedule moves on. No candidate ever started in it.

### After a round starts (P4)

- The round is **never erased or re-run because of observed performance.**
- A 1 Hz monitor watches for non-allow-listed processes. If one exceeds 5 % CPU, the round is marked **contaminated**. This monitor is the only trigger; observed timings never trigger it.
- Contaminated rounds are reported in full and left out of the paired summary.
- If more than 2 of 7 rounds are contaminated or not admitted, the whole run is invalid. A new run with a newly frozen schedule may follow, and the invalid run is reported too.

### Failures

A process that crashes, passes its fixed deadline or gives a wrong hash is a **FAILURE** row. It is reported, never silently re-run, and never counted as a timing.

### Metadata per process

- time, load (1/5/15), CPU model and governor;
- power and thermal state where readable;
- swap and free memory;
- package and add-on hashes;
- the harness commit.

## 4. Statistics (P3)

**Paired summary.** For each candidate $c$ against the baseline $b$, and each admitted, uncontaminated round $r$, the summary keeps:

$$d_r = x_{c,r} - x_{b,r}, \qquad q_r = x_{c,r} / x_{b,r}.$$

Here $x$ is the per-process median of the in-process repetitions. The report lists **every** $d_r$ and $q_r$, then their median and range. Independent per-candidate medians are reported too, but never used for a decision.

**Pilot status.** N = 7 is a **decision pilot**:
- no significance or precision claims;
- every round is in the report.

### Smallest effect of interest (SESOI), frozen now

| Metric class | SESOI (ratio band, or absolute, whichever is larger) |
|---|---|
| startup marks (M1, M5) | ±15 % or 150 ms |
| memory (M4, M5, M6 peak) | ±15 % or 40 MiB |
| engine calls (M3 steady, M10) | ±10 % |
| M3 first call | ±20 % |
| Stop (send→accepted, accepted→done) | 50 ms |
| M8 ack latency | 50 ms |
| M9 empty round-trip / stage | ±20 % or 0.2 ms |

### Decision and escalation rule, fixed before any counted result

For each comparison and metric:
- **Different:** all paired $q_r$ (or $d_r$) are on the same side of no-difference, **and** the paired median is outside the SESOI band.
- **Equivalent:** all paired values are inside the SESOI band.
- **Undecided:** anything else.

**Escalation.** An undecided comparison gets **one** escalation: a newly frozen schedule of 14 further rounds for those two candidates only. Its rounds are reported alongside the first 7, and the same rule is applied to all 21. If it is still undecided, it is reported to William as undecided. There is no second escalation.

## 5. Sensitivity controls (P5)

### A/A

Every schedule includes candidate 1 under two labels, 1a and 1b, each in its own randomized position. The paired 1a/1b values of every ranked metric must be **equivalent** under §4. If they are not, that metric's run is invalid, because it shows drift or order effects.

### Known perturbations

Each metric class used in a ranking gets one perturbation, run as a marked configuration of candidate 1 in the same schedule. The sizes are **[pilot]**, set near 2× the SESOI and frozen in `controls.json`. The recovered paired median must fall in **[0.5, 1.5]×** the injected effect. If it does not, the run is invalid for that metric class.

| Class | Perturbation |
|---|---|
| startup | a fixed delay in the page before the first content node |
| kernel ready | a fixed delay in the child before `ready` |
| engine calls | a fixed delay in the child's call handler |
| framing | fixed padding bytes added to each frame |
| memory | the child allocates and touches a fixed buffer |
| Stop | the child delays applying an accepted Stop by a fixed time |
| M8 | the child delays its permission acknowledgement by a fixed time |

## 6. Freezing

Each packet is frozen before any cleanup. It contains:
- the raw per-process outputs (every round, including failed, contaminated and not-admitted rounds);
- the harness code at its commit;
- the schedule, controls, corpus, m6 and expected-hash files;
- the commands;
- the tool versions: `node`, `@tauri-apps/cli@2.12.4` and `tauri --version`, Electron v45.2.3, rustc;
- the package and add-on hashes;
- the size schema of plan r3 (wire, update transfer, logical installed, allocated, component inventory);
- SHA256SUMS, made read-only.

## 7. Guardrails and report limitations (PERF)

- **E3's f64 reply** is valid only for the bounded `aplist` experiment. Before any wider use:
  - add fixtures beyond $2^{53}$, either rejected explicitly or encoded exactly;
  - tag None in the schema so a real NaN can't alias it.
- **All E3 and Stop development observations** (0dca2358, eecf6da6) stay uncounted. They never enter rankings or speedup claims.
- Startup, memory and M6 are reported **within one OS and machine class only**. Raw observations and paired rounds are always shown. No significance or cross-platform-superiority claims.
- **macOS without GUI permission (Q2):** build and size only, plus explicitly relative E-core micro-results.
- **Windows:** counted timings come only from a stable dedicated VM (Q1). GitHub Actions supply bytes only.

## 8. Still open (to be closed by uncounted pilots, then frozen)

The **[pilot]** values:
- the M6 dimension, entry size and deadline;
- the M7 `aplist` size;
- the M8 write cadence;
- the perturbation sizes.

Also open: whether T3 boot-cold runs at all on each OS. It needs reboot rights on the timing box (Q5).
