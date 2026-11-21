# Friction log

Run started 2026-11-19 UTC. Scope: public Sagebrush only; all new files, package caches and installs stay in this scratch directory. No local repositories, notes, memory, or other agents consulted. Every subprocess will have a timeout. Existing unrelated scratch files are left untouched.

## Initial discovery
- Public website documents MATLAB mode and `npx sagebrush`. `octave` is available at `/usr/bin/octave`, enabling a MATLAB-compatible reference without installation.
- No obstacles yet. Shell discovery, package metadata, and public documentation are recorded under `evidence/`.

## F01 — MATLAB JSON export is absent (product coverage gap)
- What happened: `sagebrush --search jsonencode --mode matlab --json` explicitly returns `status: absent`, alternative `Python mode's json.dumps`.
- Impact: a MATLAB numerical script cannot directly serialize a result structure using the customary JSON encoder.
- Workaround: use `fprintf` with a fixed JSON schema and numeric fields, then validate the JSON with the host Python standard library. Trajectories will use CSV. This preserves MATLAB syntax for all numerics.
- Exact discovery commands: `timeout 30s ./runtime/node_modules/.bin/sagebrush --search 'jsonencode' --mode matlab --json` (raw response in evidence/search-jsonencode.json).
- Suggested fix: implement `jsonencode` and structured CLI success/error output, including nonfinite values and arrays.

## F02 — No browser automation package initially available (harness/environment)
- What happened: local Node `require.resolve('playwright')` and `require.resolve('puppeteer')` found neither.
- Impact: cannot yet click the notebook's Stop button to distinguish UI Stop from CLI Ctrl+C.
- Next step: first exercise the CLI's persistent session interrupt, then use a scratch-local browser harness if feasible. No product defect inferred.

## F03 — Octave run() changes working directory (harness mistake)
- What happened: the numerical calculation completed, but `octave --eval "prefix='evidence/octave'; run('scripts/oscillator_fit.m');"` failed at export: `fprintf: invalid stream number = -1`. `run` executes from the script's directory, making the relative evidence directory nonexistent there.
- Impact: first Octave run produced no result files; not a Sagebrush issue.
- Exact change: rerun with `prefix=fullfile(pwd,'evidence','octave')` before `run(...)`, so the destination is absolute.
- Suggested harness fix: resolve output destinations before invoking scripts; check fopen's return value for actionable path errors.

## Numerical path completed in Sagebrush
- Three-start Nelder-Mead fit with log coordinates for positive amplitude/decay/frequency; deterministic trigonometric noise. Script: scripts/oscillator_fit.m.
- Analytic displacement compared against a separately evaluated first-order system using ode45 at all 401 sample times.
- MATLAB fopen/fprintf/fclose and column-major matrix CSV formatting work in the initial smoke test and full fit. Native JSON encoder remains a miss; fixed numeric JSON is parseable.

## F04 — Local notebook authentication URL omitted (harness mistake)
- What happened: the first browser navigation used `http://127.0.0.1:8877` instead of the token-bearing URL printed by the notebook server, so the UI said to open that URL and had no notebook controls.
- Impact: one failed UI discovery; no computation lost.
- Exact change: parse `http://127...` from evidence/notebook-server.stdout and navigate to that full URL. Corrected scripts/browser_inspect.cjs does this.
- Suggested harness fix: always use the emitted URL. Product message was clear and appropriate.

## F05 — Stable error identifiers missing for several numerics failures (product issue)
- What happened: MATLAB try/catch works, but fminsearch NaN/complex/vector objectives and ode45/odeset invalid inputs expose an empty err.identifier. Messages are useful. Raw cases: evidence/error-probes.json; scripts/probe_*.m.
- Impact: a program cannot reliably branch on an error type without parsing natural-language messages. Uncaught CLI errors exit 1 but are plain stderr text, with no structured error ID.
- Workaround: the bounded host harness records return code, stdout, stderr, caught status, identifier and message in JSON. Preserve empty identifiers rather than invent parity.
- Exact invocation: `timeout 210s python scripts/probe_errors.py`; each child has a 20-second timeout.
- Suggested fix: populate stable MATLAB-style identifiers for every public numerical validation error; provide optional CLI JSON output carrying identifier, message and source location.

## F06 — ODE input behavior differs from Octave (reference limitation/behavior difference)
- What happened: Sagebrush rejects tspan=[0 1 0.5] as nonmonotonic; installed Octave accepts it. Both reject wrong RHS size and negative tolerance, at different validation stages and with different identifiers.
- Impact: rejection parity cannot be assumed. Octave is a compatibility oracle, not proprietary MATLAB; this observation alone does not establish a Sagebrush defect.
- Workaround: use strictly increasing requested times for the actual task, and report acceptance/error-category/identifier separately.
- Suggested fix: document this edge-case difference and verify against MATLAB when available. No proprietary MATLAB installed for this run.

## F07 — Notebook language changed during initial load (harness timing mistake)
- What happened: the first Stop attempts selected MATLAB immediately after creating/opening a notebook. The saved document and traceback showed Sage mode (`RealNumber(...)` in a MATLAB vector), despite my earlier selection attempt. The setup cell therefore failed before the long loop ran.
- Impact: first two Stop attempts were invalid and do not count as interruption evidence.
- Exact change: in scripts/stop_browser.cjs wait for `ready (sagebrush`, wait another 1000 ms, select the MATLAB option, accept the language-change dialog, wait 1200 ms, and record the select's value. The corrected attempt reports `LANGUAGE matlab` and the saved notebook metadata confirms MATLAB.
- Suggested fix: expose a stable notebook/kernel-ready signal to automation; disable language changes until initial document load is settled or preserve a user's selection made during loading.
- Classification: harness timing mistake; a UI race is a possible contributing product issue, not established independently.

## F08 — Transient local-notebook resource errors (observed product integration issue)
- What happened: browser network logs include 404 `.../nb/oscillator-stop-test.ipynb/api/session/<id>/send` (`no such session`) and 403 `.../nb/oscillator-stop-test.ipynb/lib/core.src.<hash>.json` (asks for token), even though the browser initially navigated to the emitted token-bearing URL. See evidence/stop-browser-stable.stdout.
- Impact: noisy console errors; source-map/traceback source fetch unavailable. After the ready/language wait the actual MATLAB cells and Stop work. Root cause was not investigated in product code.
- Workaround: ignore these auxiliary failures for task completion; validate language, cell stdout, preserved state and the native saved notebook directly.
- Suggested fix: resolve notebook resource/API URLs against the server root, carry local authentication consistently, and suppress stale-session sends when switching kernels. These are hypotheses from network evidence, not verified internal causes.

## F09 — Browser download harness mishandled the submenu (harness mistake, product status unknown)
- What happened: after the successful Stop/recovery test, my hover over `Download ▸` and click on `.ipynb` did not generate the expected browser download event within 10 seconds. An eagerly created event promise rejected before it was awaited. The test itself had already passed and saved its JSON, screenshots and UI text.
- Impact: wrapper exited 1 despite valid interruption evidence; do not read that exit code as Stop failure. Native notebook had already autosaved all three cells and outputs to oscillator-stop-test.ipynb.
- Exact change: copy that native file to evidence/stop-test.ipynb; update the reusable browser harness to wait for the autosaved third-cell output and copy the file. Retain the failed download version as scripts/stop_browser_download_attempt.cjs.
- Suggested harness fix: use the local server's saved file or pair a correctly triggered click with its download promise in Promise.all. No product download defect established.

## Stop result
- Corrected MATLAB UI run: loop active for about 1.2 seconds, Stop produced KeyboardInterrupt in 110 ms, prior sentinel=271828 and four-component vector remained readable, subsequent arithmetic returned 42, assertions passed.
- Evidence: stop-result.json, stop-before/running/interrupted/after.txt, screenshots, and stop-test.ipynb. The vector was initialized from exported fit values in this separate notebook session, not inherited from the CLI process.
- The .ipynb is machine-readable JSON but represents KeyboardInterrupt as a stderr stream, not a structured Jupyter error with ename/evalue. UI shows an internal Python traceback for a MATLAB Stop; suggested product fix: a short MATLAB-facing interrupted status with structured error metadata.

## F10 — Reusing a notebook name invalidated a harness rerun (harness mistake)
- What happened: a repeat Stop harness reused `oscillator-stop-test`, which reopened the existing three-cell notebook. The harness appended empty cells but edited the old numbered cells; its `Run cell 3` button was hidden and the click timed out. Old third-cell stdout must not be mistaken for fresh full-vector assertion evidence.
- Impact: the repeat harness exited 1. The earlier clean three-cell Stop success and copied evidence remained valid. The repeat's artifacts are retained, not counted as a second success.
- Exact change: generate a unique notebook name (`'oscillator-stop-'+Date.now()`), derive the autosave path from that name, and run the focused textarea using documented Ctrl+Enter instead of relying on a hover-revealed run button. Updated scripts/stop_browser.cjs; retain scripts/stop_browser_reused_name_attempt.cjs.
- Suggested fix: make `New notebook` distinguish opening an existing name from creating a new document; offer a unique default and an explicit overwrite/open choice. Harnesses should use unique names and verify cell count.

## F11 — Reading a variable from the interrupted cell blocks execution (product behavior/coverage edge)
- What happened: an additional preservation probe tried to print `spin`, a variable defined and modified in the interrupted loop cell. The reactive notebook refused to run the recovery cell: `Not run: cell 2, which this cell depends on, was interrupted.` Prior-only recovery had already succeeded.
- Impact: a cell that depends on partial output from an interrupted cell is blocked; this does not demonstrate loss of variables defined before the loop. No claim about partial-variable retention is justified from that UI.
- Exact change: remove `spin` from the recovery fprintf while retaining sentinel and all-four-components assertions for the pre-loop vector. Save attempted probe as scripts/stop_recover_partial_dependency.m and UI as evidence/stop-interrupted-dependency.txt.
- Suggested product fix: explain the distinction between retained preexisting state and blocked partial results in Stop help; optionally offer an explicit manual inspection of partial state without triggering dependency reruns. This may be intentional reactive semantics rather than a defect.

## Completion — 2026-11-19 about 16:26 UTC (approximately 10 minutes)
- Final uniquely named notebook test passed with wrapper exit 0, Stop latency 54 ms, scalar preserved, every component of the prior vector asserted unchanged, and subsequent arithmetic/assertions completed. Native three-cell evidence: evidence/stop-test.ipynb. Raw successful wrapper logs: evidence/stop-browser-passed.stdout/.stderr/.exit.
- The server launched under `timeout 360s` exited 124 at its intended bound; no unrelated process was signaled. Browser harnesses close their own persistent contexts. Final audit checks the run-owned notebook port is closed.
- Numerical checks and all intended invalid-input probes completed; no child probe hit its timeout. Numerical success exports are valid JSON/CSV; error capture is wrapper JSON with partially missing product identifiers. Coverage and limits are explicit in REPORT.md and evidence/coverage.json.
- Artifacts are retained, including unsuccessful attempts, without modifying Sagebrush. No global install, repository edit, commit, push, deployment, or external message occurred.
