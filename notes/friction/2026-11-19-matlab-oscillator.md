# MATLAB friction run — reviewed fresh-agent sample

Updated November 19, 2026 after the fresh-context method change. This note now leads with a fresh Codex run; the original reviewer-driven run is retained below as a separately labeled baseline.

## Method and evidence

I gave a new Codex process only the task in `2026-11-19-matlab-oscillator/fresh-agent/TASK.txt`, working from `.` with no project history, repository, memory, or prior findings. Command: `codex exec --skip-git-repo-check -s danger-full-access --json - < TASK.txt`. One fresh Codex sample was run; no Claude sample is claimed. The task specified oscillator identification, independent ODE validation, machine-readable output, Stop/session recovery, invalid inputs, and a workaround log. It supplied no implementation or known failures.

The fresh run took approximately ten minutes (16:16–16:26 UTC / 8:16–8:26 AM PST), using public npm Sagebrush 0.10.1, existing Octave 11.1.0, and an isolated local Chromium/Playwright notebook. It did not inspect project source or contact other agents. I reviewed the transcript, task script, Stop harness, numerical/error evidence and final audit; reran the exported-result validator; and checked that the final transcript ends in turn.completed. The notebook server's port was closed at the final audit.

The directory `2026-11-19-matlab-oscillator/fresh-agent/` contains the report, chronological friction log, main task script and key JSON/notebook evidence. The adjacent `fresh-agent-evidence.tar.gz` contains the complete text transcript, all reproduction scripts, raw streams, JSON/CSV results and textual UI snapshots. Extract it into `2026-11-19-matlab-oscillator/` to restore that complete `fresh-agent/` layout. PNG screenshots are omitted. Local notebook authentication tokens are redacted; the archive's `packet-sha256.json` hashes its normalized members. Original scratch-byte manifests are omitted because paths/tokens were normalized.

## Reviewed outcome

**The numerical workflow completed with a JSON-export workaround.** The agent independently selected 401 deterministic noisy samples and three optimizer starts, fitting $x(t)=A e^{-\beta t}\cos(\omega t+\phi)$ with positive parameters in log coordinates. It validated the fitted curve using the equivalent two-state ODE, then compared both fit and trajectory against Octave. Export uses MATLAB `fopen`/`fprintf`/`fclose`, with strict host JSON/CSV parsing and recomputed residual metrics.

| Check | Fresh-agent result |
|---|---|
| Parameters $(A,\beta,\omega,\phi)$ | (2.404309827720, 0.180488802504, 4.700253378699, 0.649083238415) |
| Maximum parameter difference from Octave | $2.398\times10^{-9}$ |
| Maximum ODE versus fitted-curve error | $2.210\times10^{-9}$ |
| JSON/CSV validation | Passed; 401 finite, ordered samples |
| Final notebook Stop | 54 ms; final harness exit 0 |
| Prior session state after Stop | Scalar and all four vector components asserted unchanged; later arithmetic returned 42 |

The saved native notebook and the final browser transcript corroborate the Stop result. The fitted vector was explicitly initialized in that separate notebook session; it was not inherited from the CLI process. The earlier 110 ms browser attempt also demonstrated recovery, but the final 54 ms run is the fully asserted clean sample. This browser success does not erase the CLI prompt Stop failure observed in the original baseline: these are different interfaces.

## Friction to triage

1. **MATLAB JSON export:** the agent independently found `jsonencode` documented as absent and confirmed its runtime failure. A custom numeric `fprintf` schema completed export. This workaround is valid for this finite numeric schema, not a general serializer. The earlier jsonencode assignment to matlab remains applicable.
2. **Empty numerical error identifiers:** six of nine caught invalid-input probes expose empty identifiers in Sagebrush, including optimizer objective and ODE validation errors. Messages are useful, but programs cannot branch reliably on stable types. The host harness provides JSON; this is not native structured CLI error output. Route with the structured-error work already assigned to daybreak2 and the relevant numerics owner.
3. **Auxiliary notebook resource errors:** browser evidence records 404 session-send and 403 source-fetch errors. Corrected MATLAB execution and Stop still pass. URL/auth handling is a suggested investigation, not an established internal root cause.
4. **Interrupted-cell dependencies:** reading `spin`, assigned by the interrupted cell, blocks the recovery cell with an explicit dependency message. Recovery using variables defined before the loop succeeds. This may be intended reactive semantics; document it rather than reporting loss of prior variables.
5. **Stop presentation:** saved notebook interruption is a stderr stream containing a Python traceback, rather than structured Jupyter error metadata or a concise MATLAB-facing interruption status.

The fresh agent logged its own errors separately: Octave `run` changed the relative export directory; an initial browser navigation omitted the emitted authentication URL; language selection raced initial notebook load; a download-event harness mishandled a submenu; and reusing a notebook name reopened a previous document. These are not counted as confirmed product defects. Language-load timing and existing-name behavior may merit usability follow-up, with those qualifications.

## Required run dimensions

**Coverage:** MATLAB arrays/closures, three-start fminsearch with options and output status, ode45/odeset, assertions, file JSON/CSV export, nine invalid-input cases, and the real local-notebook Stop button. Misses: proprietary MATLAB, measured external data, plotting/export, MAT files, statistical uncertainty, stiff/native-kernel interruption, and partial interrupted-cell state inspection. Full inventory: fresh-agent/evidence/coverage.json.

**Stop:** final actual UI Stop passed in 54 ms, preserving preexisting scalar/vector state without restart. Reactive dependencies on the interrupted cell remain blocked. The baseline's CLI prompt failure remains separately scoped to that interface.

**Error-type parity:** seven numerical cases are rejected in both Sagebrush and Octave, with category agreement but differing identifiers. Nonmonotonic ODE times are rejected by Sagebrush and accepted by Octave; this alone does not establish a Sagebrush bug. MATLAB itself was unavailable, so exact MATLAB parity is unverified.

**Machine readability:** successful results are validated JSON/CSV via an explicit MATLAB export workaround. Error capture is host-wrapper JSON with some empty product identifiers; uncaught CLI errors remain text plus exit status. Saved notebook JSON has textual interruption output.

---

# Original reviewer-driven baseline (not a fresh-agent sample)

# MATLAB friction run: identify and validate a damped oscillator

Run by @sagebrush-astra4 on November 19, 2026, approximately 8:08–8:14 AM PST. Assigned first-round MATLAB numerics run; no product code changes, commits, pushes, or deployments. This is a released-product check, not a review of the current development branch.

## Real task and outcome

Recover amplitude, decay, angular frequency and phase from 121 deterministic noisy displacement samples over 12 seconds. Minimize least-squares error with `fminsearch`, then validate the fitted solution independently with `ode45` using the equivalent second-order state-space system. Export the result for another program.

**Completed with one MATLAB export workaround.** The original script reaches `jsonencode` and exits 1 because that function is unsupported. Replacing only the final export with a fixed `fprintf` JSON format makes the task complete. Both original and portable scripts pass the preceding numerical assertions in Sagebrush; Octave completes both scripts.

| Result | Sagebrush 0.10.1 |
|---|---:|
| Amplitude | 1.700522407263162 |
| Decay rate | 0.180076750994714 |
| Angular frequency | 2.300015511880242 |
| Phase | 0.3999327681793247 |
| Sum of squared residuals | 0.0002403069041041797 |
| Maximum ODE versus fitted trajectory error | 8.238834170448683e-9 |
| Optimizer exit flag | 1 |

The maximum fitted-parameter difference from Octave is 1.087987033798754e-9. Synthetic generating parameters are [1.7, 0.18, 2.3, 0.4]. Both runtimes pass parameter norm error <0.01 and ODE validation error <1e-5. This is evidence for this particular fit, not broad numerical certification.

## Reproduce

Install in an isolated folder: `npm install --prefix /tmp/sb-friction sagebrush@0.10.1`.

Run `node /tmp/sb-friction/node_modules/sagebrush/bin/sagebrush.cjs --matlab notes/friction/2026-11-19-matlab-oscillator/oscillator.m` (expected export failure), then substitute `oscillator-portable.m` (expected exit 0 and one JSON object). Compare with `octave --quiet --no-gui <script>`.

Artifacts beside this note:

- `2026-11-19-matlab-oscillator/oscillator.m`: original MATLAB task, including assertions.
- `2026-11-19-matlab-oscillator/oscillator-portable.m`: completed task with formatted JSON export.
- `2026-11-19-matlab-oscillator/evidence.json`: exact commands, stdout/stderr, statuses, Stop outcomes and terminal transcripts. Absolute paths in those commands identify this run's isolated installation.

Runtime: published npm sagebrush **0.10.1**, Node **v26.13.1**, Linux x86_64; Octave **11.1.0**. Bundle `dist/sagebrush.cjs` SHA256 **61a66988e8efa94f8087b07f384e624769368d9493624771737bc6ba9866e21a**; launcher SHA256 **6aec22924be7b858d33922e9efdb7d775cf1c76df3e00ff7927a3318e2e630e3**. PyPI sagebrush **0.10.1** was also installed in an isolated venv during setup, but did not execute the MATLAB task. No locally built runtime was substituted.

## Friction, impact, workaround, suggested fix

1. **High: interactive Stop did not recover the session.** Load the portable script with `--matlab -q -i <script>`, set `sentinel=4242;`, then run `while true; spin=1; end`. Sending terminal Ctrl-C after 0.8 s did not return a prompt within 8 s. A separate fresh REPL test with an explicit OS SIGINT also did not return a prompt within 5 s. Both processes remained alive until the harness terminated them. Consequently the fitted variables could not be inspected after Stop; session preservation failed in these probes. Workaround: perform risky work in a separate batch process, leaving any valuable interactive session alone. Suggested fix: make interactive execution interruptible while preserving the interpreter's namespace, and include an infinite MATLAB loop in terminal Stop/session-recovery coverage. These findings are on release 0.10.1; current development behavior was not checked.

2. **Medium: JSON export is unavailable in MATLAB mode.** `jsonencode(result)` errors with “jsonencode is not in Sagebrush; instead: Python mode's json.dumps.” The task had already computed its result, but the export failure causes a nonzero process exit and no result on stdout. Workaround: manually write a fixed `fprintf` JSON schema for eight finite scalar values. It parsed with the host's `json.loads`, but is not a general serializer and does not address escaping, nested data or nonfinite numbers. Suggested fix: implement `jsonencode` for normal MATLAB numeric arrays and structs, or document a supported same-session export route; switching language modes is not a concrete MATLAB-only export recipe.

3. **Low: product entry-point detour.** No `sagebrush` executable was initially on PATH. Installing the PyPI wheel and reading `python -m sagebrush --help` led to a Sage/Python entry point, with no MATLAB option shown. Workaround: install the npm CLI, whose `--help` documents `--matlab` and `.m` inference. This is a discoverability gap, not a claim that the PyPI package promises MATLAB support. Suggested fix: include a short cross-language launcher table in the Python package help or onboarding docs.

## Required run dimensions

**Coverage — hits:** column vectors, elementwise arithmetic, trigonometry/exponential, anonymous closures capturing data, least-squares objective, `optimset`, three-output `fminsearch`, `norm`/assertions, `odeset`, vector-valued `ode45`, multidimensional indexing, structs, formatted export, batch and interactive entry points. **Misses:** real measured data import, plots/notebook/browser, large or stiff systems, complex/sparse matrices, missing data, and optimizer failure/nonconvergence. This synthetic task validates an end-to-end numerical workflow; it is not an exhaustive MATLAB conformance run.

**Stop:** batch SIGINT succeeded: approximately 64 ms from signal to exit, `KeyboardInterrupt`, subprocess return code -2 (termination by SIGINT; shell convention 130). `STARTED` printed before termination. Batch has no persistent session to preserve. Interactive Ctrl-C and OS SIGINT failed the bounded prompt-recovery checks; processes required termination, so session recovery was not achieved. Initial harness mistakes are retained separately in scratch: I first expected the Python `>>>` prompt instead of MATLAB `>>`, and tried waiting for `disp` output during an infinite loop; neither initial attempt is counted as product evidence. The final probes use the correct prompt and fixed post-submission delays. A browser Stop button was not tested.

**Error-type parity:** three uncaught cases produce nonzero exit 1 in both Sagebrush and Octave: incompatible matrix solve dimensions, an ODE RHS indexing beyond its one-element state, and an undefined function. Sagebrush presents MATLAB-style messages and source-line context; Octave's exact messages differ. A caught dimension error is `MException` with identifier `MATLAB:dimagree` in Sagebrush; Octave exposes a `struct` with `Octave:nonconformant-args`. Thus broad error categories agree with Octave, but exact type/identifier parity does not. MATLAB itself was unavailable, so exact MATLAB parity remains unverified; Octave differences alone are not classified as Sagebrush defects.

**Machine-readable results:** the completed workaround emits one valid JSON object, parsed by the host and compared numerically. The stock `jsonencode` path fails. CLI help shows `--json` for documentation search, not a general execution-result/error envelope. Errors are textual stderr plus process status; extracting their identifiers programmatically requires an in-language catch or parsing text. Suggested improvement: document or provide a structured execution/error interface for agents.

## Triage request

Please route interactive Stop/session preservation and MATLAB `jsonencode` to the relevant owners. Entry-point discovery and structured error export are lower-priority follow-ups. No code fixes were attempted during the run; retaining the observed friction was the goal.

## Git packet portability

This commit contains only this note and its named supporting directory. Workspace paths in raw transcripts and evidence are normalized; `BASELINE_RUNTIME`, `REPO_ROOT`, and `WORKSPACE_PATH` are placeholders, not installed paths. The fresh reproduction starts from its own directory with a public npm install as documented in `fresh-agent/REPORT.md`. Textual UI evidence and the saved notebook are retained; screenshots remain outside the git packet.
