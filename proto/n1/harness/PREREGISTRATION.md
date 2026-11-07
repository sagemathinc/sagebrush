# N1-0 pre-registration (draft r5, for PERF review before the protocol is frozen)

*This is item N1-0 for the native-desktop plan r11 (#838, merged at 66f8df98). That plan fixed the architecture: the engine is always a subprocess behind one protocol, and N1 now compares only the engine's **runtime**.*

*r4 is a **new measurement scope**. It is built on r3 (98ed461e, PERF PROTOCOL CLEAR), but nothing carries over implicitly: §2 maps every r3 row to retained, replaced, descriptive or dropped. r4 closes daybreak4's eight r4 requirements from the #838 review (`reviews/pr838-50b82b9d-perf-daybreak4.md`, R1–R8 below) and that review's carry notes. r5 closes PERF's four r4 residuals (86413cee): the complete ranked-row/control map, separate archive and footprint controls, exact update-peak capture, and frozen trees with no name collision.*

*Branch n1-native-proto, never merged. Nothing here is a counted result.*

**Gate.** Before any counted run, the final pre-registration names:
- the exact harness commit;
- every frozen file: `schedule-<os>.json`, `controls-<os>-<class>.json`, `controls.json`, `runtimes.json`, `artifacts.json` (with every tree manifest), `machines.json`, `corpus/m8-writes.json`, `corpus/m10-train.json`, `corpus/m10-heldout.json`, `dispatch-<runtime>.json`, `m6.json`, `expected-hashes.json`;
- the packet manifest.

PERF reviews that exact code and packet before authorizing a counted run. Values marked **[pilot]** come from uncounted pilot runs and are frozen in those files before counting starts. Pilot data and every earlier development observation (r8, E3, the Stop pins at 0dca2358 and eecf6da6) never become counted evidence.

## 1. Candidates and their boundary (R5, R6, R7)

| Label | Runtime | JavaScript engine | Role |
|---|---|---|---|
| **1a** | Node single executable (SEA) | V8 | **baseline** of every paired comparison |
| **1b** | the same build as 1a | V8 | the A/A control only, never ranked |
| **2** | Bun (`bun build --compile`) | JSC | candidate |
| **3** | Deno (`deno compile`) | V8 | candidate |

- **Same everything else:** every label runs the same engine commit, the same pyjs and `lib/`, the same protocol, and the same conformance corpus with identical result hashes.
  - The Tauri shell is fixed and identical across labels.
  - Exact runtime versions and build commands are frozen in `runtimes.json`.
- **The boundary is recorded per label** in `runtimes.json`:
  - whether the native Rust engine loads through N-API or the runtime's own FFI;
  - every external dynamic library, from `ldd`, `otool -L` or `dumpbin /dependents`;
  - the full component inventory.
- **What the result means:** an end-to-end comparison of packaged runtimes. It is **not** a pure V8-versus-JSC claim.
- **Licence eligibility (R6):** Bun's licence page says it statically links LGPL-2 JavaScriptCore.
  - William's answer on the allow-list and LGPL (plan §9 Q1) is recorded in `runtimes.json` **before any runtime is called selectable**.
  - Bun is measured either way in unsigned local N1 work.
  - No candidate is dropped or added after performance is seen. A candidate that turns out ineligible is reported as **measured but ineligible**.
- **Electron (R7)** is not a runtime candidate and is not timed here.
  - If Tauri webview compatibility ever triggers the Electron fallback, that is a separate functional conformance gate.
  - Runtime timings with the fixed Tauri shell say nothing about Electron's performance.
- **The output-frames harness** (#826, in the app's WebKit/WebView2 webview) is functional UI evidence. It is never pooled with this ranking.

## 2. Map of r3 rows (R1)

| r3 row | r4 status | r4 row |
|---|---|---|
| M1 startup marks (`fcp`, `render-proxy`, `page-ready`, `kernel-ready-*`) | **replaced**. The page and webview marks are dropped. | S1–S6, subprocess marks (§3.1) |
| M2 cache treatments T1/T2/T3 | **retained**, redefined for the engine | §3.1 treatments |
| M3 engine calls | **retained**, over the pipe | E1 (§3.2) |
| M4 memory | **retained**, split into the engine tree and the whole tree | E2 (§3.3) |
| M5 scaling (1, 2, 4 documents) | **retained** | E3: 1, 2 and 4 engine sessions (§3.3) |
| M6 the over-4 GiB case | **retained**: peak ranked, wall time descriptive | E4 (§3.4) |
| M7 Stop | **retained** | E5 (§3.5) |
| M8 permission window | **retained** | E6 (§3.5) |
| M9 framing | **retained**: the stages are now client↔engine over the pipe | E7 (§3.6) |
| M10 big integers | **replaced**: an uncounted training corpus, then a held-out **ranked** corpus | B1 (train, uncounted), B2 (held-out, ranked) (§3.7) |
| (new) | install and update | I1–I4 (§3.8) |
| (new) | installed footprint | F1–F3 (§3.8) |

## 3. Measurements

### 3.1 Start-up marks and treatments (R2)

**One clock.** Every start-up mark is on the harness's monotonic clock (`process.hrtime.bigint()`). The origin $t_0$ is read immediately before the `spawn()` call.

The harness starts the engine directly, with exactly the arguments the Tauri shell uses. The shell is identical across labels, so it is not part of the start-up rows.

| Row | Endpoint (harness clock) |
|---|---|
| **S1** spawned | the child process's `spawn` event. **Descriptive only**: it is mostly the OS's process creation, before any engine code runs, so no engine-side perturbation can test it. |
| **S2** handshake | the engine's `hello` reply fully received and parsed, with a version in range |
| **S3** ready | the engine's `ready` message received (base engine) |
| **S4** first CLI line | separate CLI-mode process (`<engine> -c 'print(1)'`): the first byte on stdout |
| **S5** base first output | the first output message of the fixed cell `print(1)`, sent right after S3 |
| **S6** Sage first output | a `--sage` session: the first output message of the fixed cell `2^10`, sent right after its `ready` |

Each row is reported as an offset from $t_0$. S4 has its own process and its own $t_0$.

**Treatments.** Results are never compared across treatments.

| Treatment | Procedure |
|---|---|
| **T1 profile-cold** (primary) | A fresh, empty `HOME`/`XDG_*`/`%LOCALAPPDATA%` directory per process, so the engine's compile cache is empty. The OS file cache is left as it is. |
| **T2 warm** | The same directories as that label's T1, started 10 s after the harness observes the T1 process exit. |
| **T3 boot-cold** | One launch per boot, from a pre-generated reboot schedule that rotates labels. Never compared with a non-first launch. Runs only on a machine where reboots are admitted (`machines.json`). |

`drop_caches` is not used on any OS. As in r3, each label's T1→T2 runs as one atomic unit inside its round (§4).

### 3.2 E1 engine calls (from M3)

- **Calls:** `aplist(199999)`, `det` of a seeded 200×200 integer matrix, and `factor` of a fixed 41-digit integer. Each result is hashed against `expected-hashes.json`.
- **Execution:** sent over the protocol by the harness's client.
  - One engine session per process.
  - 8 repetitions; the call order is a seeded rotation, balanced across processes.
  - Runtime default GC and JIT; the flags are recorded.
- **Reporting:** the first call of each kind is its own row. Steady state is the median of repetitions 2–8, and all 8 are kept.

### 3.3 E2 memory and E3 scaling (from M4, M5)

The definition is per OS, and values are never compared across OSes.

| OS | Metric |
|---|---|
| Linux | PSS, plus USS, from `/proc/<pid>/smaps_rollup` |
| macOS | `phys_footprint`, from `footprint` |
| Windows | Job private commit and PeakProcessMemoryUsed |

- **Two trees, both reported:**
  - **the engine tree:** the engine pid and every descendant;
  - **the whole tree:** the Tauri shell plus the engine tree.

  The whole tree comes from a separate launch through the Tauri shell, so the shell's share can't hide runtime differences.
- **Marks:** after S3, after S5, and after E1.
- **Stability:** three consecutive 500 ms samples within 2 %, up to 10 s; otherwise the row is **unstable**.
  - An unstable row and its paired round are excluded from decisions at that mark.
  - More than 1 unstable round in 7 for any label at a mark makes that mark invalid.
- **E3:** E2 and S3 with 1, 2 and 4 engine sessions, one process each, all ready.
  - **The ranked estimator**, per round: $\Delta = (M_4 - M_1)/3$, where $M_k$ is the stable engine-tree memory (§3.3's metric for the OS) at the after-S3 mark with $k$ sessions ready.
  - $M_2$ and S3 for 2 and 4 sessions are descriptive.
  - If $M_1$ or $M_4$ is unstable in a round, that round's $\Delta$ is excluded, under §3.3's rule.

### 3.4 E4 the over-4 GiB case (from M6)

`m6.json`, frozen:
- a dense exact integer matrix computation through the engine's matrix path, from a recorded seed;
- dimension and entry size **[pilot]**, calibrated to a 5.0–6.5 GiB peak on Linux 1a;
- the expected hash, and a deadline of **[pilot]**×3;
- a machine with at least 16 GiB of RAM.

The **peak** (10 Hz high-water on the engine tree) is ranked. **Wall time is descriptive.** Any growth in swap, or any OOM intervention, makes the row invalid.

### 3.5 E5 Stop and E6 permission window (from M7, M8)

**E5, unchanged from r3:**
- The calls are `spin` and `aplist` at a **[pilot]** size, which must run at least 10× the trigger delay on the fastest label.
- Stop is sent 200 ms after the RUN/ARMED acknowledgement, and only after checking the call is still running.
- Ranked rows: send→accepted and accepted→done. **The total is descriptive** (it is their sum).
- Accepted-but-completed is a FAILURE. A rejected or late Stop is not a latency row; more than 1 in 7 makes the configuration invalid. The deadline is 5 s.
- The 2 s hard restart is a separate row and **descriptive**: its time is set by the frozen deadline, not by the runtime.

**E6, unchanged from r3:** `corpus/m8-writes.json` with a **[pilot]** write cadence. Rows: attempted, allowed and refused counts in three windows (before the revoke is sent, between send and acknowledgement, after the acknowledgement), plus the ack latency. Any allowed write after the acknowledgement is a FAILURE.

### 3.6 E7 the protocol over the pipe (from M9)

For each E1 call, time and **bytes at each boundary**:
1. client encode
2. framed write
3. engine decode
4. engine work
5. engine encode
6. framed read
7. client decode

Plus an empty framed round-trip, 8 times per process.

### 3.7 B1 and B2 big integers (R3)

**The tuning and the grading never see the same observations.**

1. **B1, training (uncounted):** `corpus/m10-train.json`.
   - Seed $s_T$.
   - Operations: `mul`, `divmod`, `pow` mod, `gcd`, `int→str` and `str→int`.
   - Bit sizes $\{64, 2^{10}, 2^{14}, 2^{17}, 2^{20}\}$, plus each runtime's algorithm-switch boundaries ±1 limb.

   On every label it measures the JS path and the Rust path per operation and size. From that, each runtime gets a per-operation, per-size dispatch table, frozen in `dispatch-<runtime>.json` with the engine commit that implements it.
2. **Freeze:** the dispatch tables and their implementation are frozen and hashed before any B2 schedule is generated. **Thresholds never move after a counted label or result is seen.**
3. **B2, held-out (ranked):** `corpus/m10-heldout.json`.
   - Seed $s_H \ne s_T$, with the same operation and size classes.
   - The generator asserts that no operand value appears in both corpora.
   - Each label runs with its frozen dispatch table: 2 warm-ups, 7 repetitions, hashes and deadlines.
   - The ranked row per class is the median time.
   - The **no-dispatch baseline** (JS path only) is also run, and is descriptive.
4. **B2 is decision evidence**, so it gets a SESOI (§5), the A/A rule (1b) and an identical-path control (§6).

### 3.8 I1–I4 install and update, F1–F3 footprint (R4 and the footprint note)

`artifacts.json` freezes, with sha256:
- **the prior build** and **the target build**, each at an exact engine commit. These names are used only here, so they don't collide with the big-integer rows B1/B2;
- for each label: the download artifact, the installer command, and the update artifact from the prior build to the target build;
- **the app's bundled engine:** its artifact, plus a **tree manifest** (every path, logical size, allocated size and sha256);
- **the expected tree manifest at each footprint mark** (F1, every F2 boundary, F3). After each mark, the harness records the actual tree and compares it with the frozen one; any difference makes that row invalid.

| Row | Definition | Ranked? |
|---|---|---|
| **I1** download bytes | the size of the label's target-build download artifact | yes (bytes) |
| **I2** install time | from a **frozen local artifact file**: the installer command into an **empty destination directory** on the same filesystem, from start to exit 0, with a deadline. No network. | yes |
| **I3** update delta bytes | the size of the prior→target update artifact | yes (bytes) |
| **I4** network transfer time | downloading I1 from the release location | **descriptive only** |

**Footprint.** Two byte measures:
- **logical bytes:** the sum of file sizes;
- **allocated bytes:** `st_blocks`×512 on Linux and macOS, or the allocation size on Windows.

| Row | Lifecycle mark |
|---|---|
| **F1** steady | after installing the target build into a destination that already holds the app's bundled engine, running S5 once and the engine exiting. It covers the bundled engine plus the current engine. |
| **F2** update peak | the maximum over the update's **lifecycle boundaries** (below) during the prior→target update: bundled + current + the staged download + any rollback copy |
| **F3** after update | at the update's completion mark, with what the update keeps for rollback recorded as its retention policy |

**Capturing F2 exactly.** 10 Hz sampling alone can miss a short peak, so each label's updater is instrumented.
1. At each lifecycle boundary it emits a mark on its control channel and **waits** until the harness acknowledges. The boundaries are:
   - download staged;
   - new engine unpacked;
   - switch done;
   - old engine kept for rollback;
   - cleanup done.
2. While it waits, the harness measures the tree (logical and allocated) and checks it against that boundary's frozen manifest.
3. F2 is the maximum over the boundaries.
4. The 10 Hz sampler keeps running as a cross-check. If any sample exceeds the boundary maximum by more than F2's SESOI, F2 is **invalid**: a state was missed.
5. Recovery is proven by the footprint control (§6) at every boundary.

**Comparison boundary:** within one OS and one filesystem type (ext4, APFS or NTFS, recorded in `machines.json`) only.

## 4. Run discipline (R8: regenerated, not carried)

**Schedule.**
- Seeded and frozen before running: `schedule-<os>.json` lists every round and the label order.
- Main labels are 1a, 1b, 2 and 3. Each label's counts per position are 1 or 2 over 7 rounds.
- The 14-round escalation schedule has the same four labels and positions, with counts of 3 or 4. Over all 21 rounds the counts are 5 or 6.
- Orders are accepted only if they meet these rules, and the counts are listed.
- Each control has its own schedule (`controls-<os>-<class>.json`, 1 against 1+perturbation, 4/3 positions), run right after the main run in the same session.
- One uncounted warm-up per label and configuration, then N = 7 rounds.

**Units.** In each round, for each label in order:
1. T1 launch, measure, exit;
2. a 10 s wait;
3. T2 launch, measure, exit;
4. 10 s idle before the next label.

Start-up, memory and E1 come from these launches. B2, E4–E7 and I/F have their own rounds, using the same order rules, in separate schedules listed in the schedule file.

**Admission gate**, before each round's first label. It takes 5 readings at 2 s:
- idle at least 95 %;
- 1-minute load at most cores/4;
- no process outside the frozen allow-list above 1 % CPU;
- governor and power as frozen (battery is never admitted);
- no thermal flag;
- swap unchanged.

If it fails, the harness waits 60 s, up to 10 tries. A round never admitted is recorded as **not admitted**.

**After a round starts:**
- It is never erased or re-run because of observed performance.
- A 1 Hz monitor marks it **contaminated** if a non-allow-listed process exceeds 5 % CPU. That is the only trigger.
- More than 2 of 7 rounds contaminated or not admitted makes the run invalid.

**Failures:** a crash, a passed deadline or a wrong hash is a FAILURE row. It is reported and never counted as a timing.

**Metadata per process:**
- time, load, CPU model, governor, power and thermal state;
- swap and free memory;
- the filesystem type;
- every artifact hash and the harness commit.

## 5. Statistics and SESOI

**Paired comparison.** Each label $c \in \{2, 3, \text{1b}\}$ is compared with the baseline $b$ = 1a, per metric, over the usable rounds:

$$t_r = \max(a,\ \rho\, x_{b,r}), \qquad e_r = \frac{x_{c,r} - x_{b,r}}{t_r}.$$

Every ranked metric is smaller-is-better. $d_r$, $q_r$ and the independent medians are reported as description only.

**Decision rule, in order:**
1. If there are fewer than 5 usable rounds: **undecided**.
2. **Equivalent** iff every $|e_r| \le 1$.
3. **Different** iff every $e_r$ has the same strict sign and $|\operatorname{median}(e_r)| > 1$.
4. Otherwise **undecided**.

**Escalation:** one only, a newly frozen 14-round schedule of the full structure. Comparisons already decided stay decided. A/A is repeated on the 14. Still undecided goes to William as undecided.

N = 7 is a decision pilot: no significance claims, and every round is reported.

| Metric class | $\rho$ | $a$ |
|---|---|---|
| start-up S2–S6 (T1 and T2 separately; S1 descriptive) | 0.15 | 50 ms |
| memory E2, E3 $\Delta$, E4 peak | 0.15 | 40 MiB |
| E1 steady | 0.10 | 0 |
| E1 first call | 0.20 | 0 |
| E5 send→accepted, accepted→done | 0 | 50 ms |
| E6 ack latency | 0 | 50 ms |
| E7 empty round-trip and each stage | 0.20 | 0.2 ms |
| E7 bytes per boundary | 0.10 | 0 |
| **B2** held-out big integers, per class | 0.10 | 0 |
| I1, I3 bytes | 0.10 | 0 |
| I2 install time | 0.15 | 100 ms |
| F1, F2, F3 bytes (logical and allocated) | 0.10 | 4 MiB |

(r3's start-up $a$ of 150 ms was for page marks. A subprocess's marks are shorter, so $a$ is 50 ms.)

## 6. Controls

**A/A:** 1b's comparison with 1a must be **equivalent** for every ranked metric. Otherwise that metric is invalid for the run.

**Known perturbations.** Each one is its own control schedule, with its size set by **[pilot]** near 2× the SESOI.
- **Timing and memory:** the median of the recovered $d_r$ must fall in **[0.5, 1.5]×** the injected amount.
- **Bytes:** recovery must be **exact**.

| Class | Perturbation (on 1a) | Targeted rows |
|---|---|---|
| handshake | a fixed delay in the engine before its `hello` reply | S2, S3, S5, S6 |
| ready | a fixed delay in the engine between `hello` and `ready` | S3, S5, S6 |
| first CLI line | a fixed delay in CLI mode before the first stdout write | S4 |
| engine calls | a fixed delay in the engine's call handler | E1 first and steady; E7 stage 4 |
| framing time | a fixed delay at the start of engine decode | E7 stage 3; the empty round-trip |
| framing bytes | fixed padding added to each frame | E7 bytes (exact) |
| memory | the engine allocates and touches a fixed buffer | E2 at each mark |
| E3 per session | each engine session allocates and touches a fixed buffer $m$ | E3 $\Delta$, recovered as $m$ |
| E4 peak | a fixed buffer during the E4 call, held until it returns | E4 peak |
| Stop send→accepted | a fixed delay before the engine sends Stop-accepted | E5 send→accepted |
| Stop accepted→done | a fixed delay in applying an accepted Stop | E5 accepted→done |
| permission | a fixed delay in the engine's permission acknowledgement | E6 ack latency |
| **big integers** | a fixed delay at the dispatch entry, before the JS/Rust choice, so it is identical on both paths | B2 per class |
| install time | a fixed delay inside the frozen installer command | I2 |
| archive bytes | $P_a$ fixed bytes appended to the frozen download artifact and to the update artifact, outside any compression | I1, I3: recovered exactly as $+P_a$ |
| footprint bytes | the installer writes one extra file of $P_f$ bytes into the current engine's directory. $P_f$ is a multiple of the filesystem block size, written non-sparse, with filesystem compression off (recorded). | F1, every F2 boundary, F3: recovered exactly as $+k P_f$ in **both** logical and allocated bytes, where $k$ is the number of copies of the current engine's directory at that mark in the frozen manifest |

## 7. Machines (from the #838 carry notes)

`machines.json` admits each counted machine by name, with its frozen description.
- **Linux:** the VM3/VM4 timing box (William: "Yes to both"), after the slot checklist.
- **macOS:** the m1 with a GUI login session (William: "Yes, for N1 only"). Counted only if `machines.json` admits it with its core placement rule.
- **Windows:** ranked timing **only** on a frozen, stable, dedicated or self-hosted runner admitted in `machines.json`. William's Windows CI workflow, on ordinary hosted runners, supplies **conformance, correctness and bytes (I1, I3, F1–F3) only**.

A machine approval supplies a machine; it never authorizes counting. Counting needs the final PERF review.

## 8. Freezing

Each packet is frozen before any cleanup. It contains:
- every raw output, including failed, contaminated and not-admitted rounds;
- the harness at its commit;
- every file named in the gate;
- the commands;
- the runtime, Tauri CLI and rustc versions;
- all artifact hashes;
- the filesystem type;
- SHA256SUMS, made read-only.

## 9. Report limits

- Start-up, memory, E4 and footprint are reported within one OS, one machine class and one filesystem type only.
- Raw observations and every paired round are shown. No significance or cross-platform claims.
- The result is end-to-end packaged runtimes, not V8 against JSC.
- A candidate that is ineligible on licence is reported as measured but ineligible.
- **E3's f64 reply** stays valid only for the bounded `aplist` experiment. Before any wider use: fixtures beyond $2^{53}$, and None tagged in the schema.

## 10. [pilot] values still open

- the E4 dimension, entry size and deadline;
- the E5 `aplist` size;
- the E6 write cadence;
- every perturbation size;
- the B1 training runs and the frozen dispatch tables;
- the prior and target builds, the bundled engine, the artifacts and every tree manifest;
- whether T3 runs on each machine.
