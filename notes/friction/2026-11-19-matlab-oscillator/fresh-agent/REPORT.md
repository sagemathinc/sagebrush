# Sagebrush MATLAB oscillator trial

Run: 2026-11-19 UTC, entirely within `.`. Public npm `sagebrush@0.10.1`, installed under `runtime/`; no locally built runtime, local Sagebrush repository, agent memory, other agents, global installs, commits or publication used. Discovery used the [public Sagebrush instructions](https://sagebrush.space/llms.txt) and npm registry metadata. GNU Octave 11.1.0 was already installed and is the MATLAB-compatible reference. Proprietary MATLAB was not used, so literal MATLAB error-type parity remains unverified.

## Numerical task and result

The model is

`x(t) = A exp(-beta t) cos(omega t + phi)`.

Time is in seconds, angular frequency in rad/s, decay rate in 1/s, phase in radians, and displacement/amplitude in arbitrary displacement units. The 401 samples span 0–10 seconds at 0.025-second intervals. True parameters are `[2.4, 0.18, 4.7, 0.65]`. Additive deterministic noise is

`0.025*sin(17.3*t+0.2) + 0.020*cos(29.1*t-0.7) + 0.010*sin(43*t+1.1)`.

No random generator or external data is involved. The noise is deterministic, not a probabilistic noise model; no confidence interval is claimed.

| Parameter | Truth | Sagebrush | Octave |
|---|---:|---:|---:|
| Amplitude | 2.4 | 2.404309827720 | 2.404309825322 |
| Decay rate | 0.18 | 0.180488802504 | 0.180488802442 |
| Angular frequency | 4.7 | 4.700253378699 | 4.700253378725 |
| Phase | 0.65 | 0.649083238415 | 0.649083238745 |

`scripts/oscillator_fit.m` minimizes the sum of squared displacement residuals with MATLAB `fminsearch`. Logarithmic coordinates constrain amplitude, decay and frequency to be positive. Three frequency starts (4.2, 4.7, 5.2 rad/s) all converge with exitflag 1 to essentially identical losses. Phase is wrapped to `[-pi,pi)`. Initial guesses are sensible for this task, but this is not a guarantee of a global optimum for arbitrary oscillator data.

Sagebrush SSE is **0.2233150267875753**, residual RMSE **0.0235986298044467**. Maximum deviation from the noiseless true trajectory is **0.00476411861**. The greatest fitted-parameter difference between engines is **2.398e-9**; maximum fitted-trajectory difference is **2.390e-9**. All scripted acceptance assertions pass in both engines.

## Independent ODE validation

The fitted displacement was independently integrated with `ode45` using the two-state system

```
y1' = y2
y2' = -2*beta*y2 - (beta^2 + omega^2)*y1
```

with `y1(0)=A*cos(phi)` and `y2(0)=-beta*A*cos(phi)-omega*A*sin(phi)`. The RHS never calls the fitted analytic displacement formula. Relative tolerance is 1e-9, absolute tolerance 1e-11; outputs are requested at all original sample times.

Maximum ODE-versus-analytic displacement error: **2.210e-9** in Sagebrush and **1.410e-9** in Octave. This validates trajectory consistency and the ODE implementation; the separate cross-engine fit comparison supplies additional numerical corroboration. It does not establish statistical parameter uncertainty.

The independent host script `scripts/validate_results.py` strictly parses exported JSON, parses all 401 CSV rows, checks finite values and ordered times, reconstructs the synthetic data with host Python math, recomputes SSE/RMSE/ODE error, and compares engines. All checks pass; raw results are in `evidence/validation.json`.

## Stop and session recovery

The public npm package's local notebook was opened in scratch-local headless Chromium through a scratch-local Playwright harness. This tests the actual **Stop button**, not killing the runtime or simulating Stop with an OS process signal. MATLAB code set a sentinel scalar and four-component vector, ran an infinite incrementing loop for about 1.2 seconds, clicked Stop, then executed a recovery cell.

The successful initial test delivered `KeyboardInterrupt` about **110 ms** after the click. The prior scalar and vector were usable, `6*7` returned 42, and assertions passed without restarting the interpreter. A clean follow-up checked all four vector components, completed with wrapper exit 0, and measured **54 ms** Stop latency; its result is in `evidence/stop-result.json`. The vector was initialized from the fitted numbers in this separate notebook session, not shared implicitly with the CLI fit process.

A further probe that read `spin`, which was assigned in the interrupted cell, was **blocked by reactive dependency handling** with `Not run: cell 2, which this cell depends on, was interrupted.` Removing that dependency permits prior-state recovery. This is an important limit: prior state preservation passed; inspection/retention of partial interrupted-cell results was not established. Stop inside a native/WASM numerical kernel and interruption rollback/atomicity were not tested.

Native notebook output, UI snapshots, screenshots, browser logs and the bounded harness are saved. Failed harness attempts are retained and distinguished from valid Stop evidence in `FRICTION.md`. Browser resources also produced auxiliary 404/403 errors, which did not prevent the corrected MATLAB test.

## Invalid inputs and error parity

Nine identical probes were run in each engine, each with a 20-second child timeout. Seven invalid numerical cases are rejected by both engines. No shared rejection has a literally equal nonempty identifier across these engines. Octave's identifiers are not authoritative MATLAB identifiers. The semantic error categories match for invalid indexing, incompatible matrix multiplication, nonfinite/complex/nonscalar objectives, wrong ODE RHS size and negative tolerance, although validation stages and messages differ.

| Probe | Sagebrush | Octave | Rejection parity |
|---|---|---|---|
| index_zero | error (`MATLAB:index:expected_positive_integer`) | error (`Octave:invalid-index`) | True |
| matrix_dimensions | error (`MATLAB:innerdim`) | error (`Octave:nonconformant-args`) | True |
| objective_nan | error (empty ID) | error (`fminsearch:isnan`) | True |
| objective_complex | error (empty ID) | error (`fminsearch:notreal`) | True |
| objective_vector | error (empty ID) | error (`Octave:nonconformant-args`) | True |
| ode_wrong_rhs | error (empty ID) | error (`Octave:nonconformant-args`) | True |
| ode_nonmonotonic_times | error (empty ID) | success | False |
| ode_negative_tolerance | error (empty ID) | error (`Octave:expected-positive`) | True |
| jsonencode | error (`MATLAB:UndefinedFunction`) | success | False |

For nonmonotonic ODE times, Sagebrush rejects the input while Octave accepts it. This is an observed compatibility difference, not proof Sagebrush is wrong. `jsonencode` works in Octave but Sagebrush reports it absent both in documentation search and at execution. Six of the nine Sagebrush caught errors have an empty identifier; the remaining three have MATLAB-style identifiers. All caught error messages are useful. Full messages, exact commands, durations, stdout/stderr and return codes are retained in `evidence/error-probes.json` and individual stream files.

## Coverage and machine readability

**Hits:** MATLAB array operations, broadcasting used by the task, anonymous closures, loops, log-coordinate optimization, `fminsearch` four-output interface, `optimset`, `ode45`, `odeset`, indexing, reductions, assertions, `try/catch`, and `fopen`/`fprintf`/`fclose`. Search results are JSON and accurately advertised the missing JSON encoder and partial ODE coverage.

**Misses and limits:** MATLAB `jsonencode`; stable numerical error identifiers for several failures; a general documented CLI execution/error JSON envelope; structured notebook interruption metadata; auxiliary notebook resource/auth failures. Plot export, MAT-file round trips, statistical uncertainty, proprietary MATLAB comparison, and Stop in native kernels were not tested. Machine-readable coverage inventory: `evidence/coverage.json`.

Success results are program-readable **native MATLAB-written numeric JSON and CSV**, validated independently. Because the schema contains only known finite numeric values and a fixed literal string, `fprintf` is sufficient here; this is not a substitute for a general JSON serializer. Sagebrush does not need Python mode for any numerical task code.

Caught errors are program-readable through `err.identifier` and `err.message`, with the empty-ID limitation above; the external harness serializes them into JSON. A caught error correctly leaves process status 0. An uncaught invalid index exits 1 but supplies **plain stderr text**, without the identifier in a structured envelope. The host wrapper's JSON is added by the harness, not by Sagebrush. Notebook `.ipynb` output is JSON, but interruptions are stored as stderr text streams, not structured Jupyter `ename`/`evalue` error objects.

## Reproduction and evidence

All commands below run from the scratch root and use bounded subprocesses. The existing `runtime/package-lock.json` records package versions/integrity. Installation was `timeout 120s npm --cache ./runtime/npm-cache install --prefix ./runtime --no-audit --no-fund sagebrush@0.10.1`; Playwright Core was likewise installed only under `runtime/` and used the existing `/usr/bin/chromium`.

- Re-run fit, Octave reference and artifact validation: `timeout 270s bash scripts/run_fit.sh` (overwrites corresponding result/stream files).
- Re-run invalid-input probes: `timeout 210s python scripts/probe_errors.py`; then `timeout 20s python scripts/summarize_coverage.py`.
- UI reproduction: start `timeout 360s ./runtime/node_modules/.bin/sagebrush notebook . --port 8877 --no-browser > evidence/notebook-server.stdout 2> evidence/notebook-server.stderr`, then in a second scratch-root shell run `timeout 100s env TMPDIR="$PWD/runtime/tmp" XDG_CACHE_HOME="$PWD/runtime/cache" node scripts/stop_browser.cjs`. The harness extracts the printed local token URL, creates a unique notebook, selects MATLAB after load, clicks Stop, verifies prior state and saves the native notebook. Install `playwright-core` locally if not using the preserved runtime. It launches/closes only its own Chromium instance.

Primary artifacts:

- `FRICTION.md`: chronological obstacles, classifications, exact workarounds and product suggestions.
- `scripts/oscillator_fit.m`: complete MATLAB numerical task and exports; `scripts/run_fit.sh`: bounded reproduction.
- `evidence/sagebrush-result.json`, `evidence/octave-result.json`: numeric results.
- `evidence/sagebrush-trajectory.csv`, `evidence/octave-trajectory.csv`: samples, clean truth, fitted curve, ODE trajectory and residuals.
- `evidence/validation.json`, `evidence/error-probes.json`, `evidence/coverage.json`: checks and compatibility inventory.
- `scripts/stop_browser.cjs`, `scripts/stop_*.m`, `evidence/stop-test.ipynb`, `evidence/stop-result.json`, `evidence/stop-*.txt`, `evidence/stop-*.png`: Stop/recovery evidence.
- `evidence/*stdout`, `evidence/*stderr`, `evidence/*exit`: raw successful and failed attempts; `evidence/npm-metadata.json`, CLI help, version files and documentation searches: release/discovery evidence.

No Sagebrush files were patched. Product friction and harness mistakes are kept separate. All explicitly launched calculations and servers were bounded; cleanup targets only this run's processes.

Final audit: numerical exports and native three-cell Stop notebook verified; final browser harness exited 0; the bounded notebook server exited 124 and its port is closed. Run completed in approximately 10 minutes. See `evidence/final-audit.json` and `evidence/sha256-manifest.json`.
