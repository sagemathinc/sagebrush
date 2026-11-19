# Public CLI friction: exact absorbing Markov-chain report

Date: November 19, 2026, morning PST. Reviewer: daybreak2. Public packages tested: npm and PyPI `sagebrush` 0.10.1; Node 26.13.1. References: CPython 3.14.4, Sage 10.9.post1, and SymPy 1.14.0. These are release observations, not claims about current master.

Outcome: the real task succeeded, with exact machine-readable answers independently checked. Both fresh agents encountered missing structured CLI execution errors and invalid matrix inputs accepted silently. CLI Ctrl+C did not preempt the tested loops, but the wheel's programmatic `Session.interrupt()` worked and preserved state. No product changes or issues were made during the run; findings below await triage.

## Method and retained evidence

Two fresh subprocess agents received the same [neutral task](2026-11-19-cli-markov/task.txt), without project context, prior findings, source access, or remediation hints. They worked independently in initially empty scratch directories, using public installs. Codex used `codex exec --skip-git-repo-check --ephemeral --json`; Claude used `claude -p --no-session-persistence --output-format stream-json`. Default configured models were used. References were used only to check results, not to substitute for Sagebrush. This implements the fresh-agent method update; my earlier direct exploration is explicitly supplementary.

Raw transcripts remain in each sample's scratch directory. Selected scripts and raw outputs are retained in the adjacent [evidence directory](2026-11-19-cli-markov/). The [Codex findings](2026-11-19-cli-markov/fresh-codex/findings.md), [Claude findings](2026-11-19-cli-markov/fresh-claude/FINDINGS.md) and [Claude command notes](2026-11-19-cli-markov/fresh-claude/notes.md) retain their obstacle/workaround lists, including oracle and harness mistakes. The fresh samples took about 5 and 14 minutes respectively. These are raw sample accounts: Claude's claim of API absence from an empty search, and its inference about shared implementation, are not established by black-box evidence. This reviewed note makes neither claim. Raw model reasoning is not part of the committed evidence.

## Real task and checks

Produce a customer-state absorbing-chain report: states new, engaged, converted, abandoned; the latter two absorbing. The transition matrix is

$$P=\begin{pmatrix}1/2&1/4&1/4&0\\1/5&1/2&1/10&1/5\\0&0&1&0\\0&0&0&1\end{pmatrix}.$$

The requested outputs were the fundamental matrix, eventual absorption probabilities, expected steps and variance, and $P^5$, with exact rationals saved as JSON strings. Both agents computed the report in Sagebrush. For transient block $Q$ and absorbing block $R$, they used $N=(I-Q)^{-1}$, $B=NR$, $t=N\mathbf{1}$ and $\operatorname{Var}(T)=(2N-I)t-t^{\circ2}$.

Results: $N=\begin{pmatrix}5/2&5/4\\1&5/2\end{pmatrix}$, $B=\begin{pmatrix}3/4&1/4\\1/2&1/2\end{pmatrix}$, $t=(15/4,7/2)$ and variance $(155/16,37/4)$. Full matrices and state labels are in the [Codex JSON report](2026-11-19-cli-markov/fresh-codex/markov-report.json) and [Claude npm output](2026-11-19-cli-markov/fresh-claude/out/npm_report.raw). Claude's [PyPI output](2026-11-19-cli-markov/fresh-claude/out/pypi_report.raw) matches its npm output. Codex's ten [independent SymPy checks](2026-11-19-cli-markov/fresh-codex/independent-checks.json) passed; Claude checked the five requested outputs against CPython/SymPy and Sage.

Reproduce with `npx --yes sagebrush@0.10.1 notes/friction/2026-11-19-cli-markov/fresh-codex/markov_report.sage`. The script writes `markov-report.json` in the working directory as well as printing JSON; run in a scratch directory if preserving existing files.

## Triage items: observation, impact, workaround, suggested fix

### 1. Execution errors are not machine-readable

Both agents found `--json` works for documentation search, not execution. `npx --yes sagebrush@0.10.1 --json --sage -c 'print(1/3)'` exits 2 with `unknown option --json`. An uncaught runtime or syntax error exits 1 with a text traceback/diagnostic; a missing file exits 2 with text. There is no native execution error object containing **type, message, and source line**.

Impact: an agent must parse prose, or write custom wrappers for every task. Workaround: emit successful reports with `json.dumps`, and wrap individual invalid-input probes in `try/except` to serialize exception types/messages. That wrapper does not capture a syntax error preventing the wrapper itself from parsing, and does not provide a uniform source-line schema. Claude later discovered the wheel's programmatic `sagebrush.session.Session` API, which does return structured result/error dictionaries; that is an alternative interface, not a CLI `--json` option. Suggested fix: an opt-in execution JSON envelope covering argument, file, parse and runtime errors, with at least `{type, message, line}` and sensible `null` line for non-source errors. Keep stdout/stderr and exit status explicit rather than conflating program output with diagnostics.

### 2. Invalid matrix inputs can silently produce results

Both fresh samples accepted a string inside a declared `QQ` matrix, where Sage immediately raises `TypeError`. Subsequent arithmetic can fail later and differently. Claude also found wrong-shape addition/subtraction and matrix-vector multiplication can silently truncate, and a fractional matrix exponent is accepted. See [raw probes](2026-11-19-cli-markov/fresh-claude/out/probe_sagebrush.txt), [Sage reference](2026-11-19-cli-markov/fresh-claude/out/probe_sage.txt), and [repro cases](2026-11-19-cli-markov/fresh-claude/scripts/errors.sage).

Examples: a $2\times2$ matrix plus a $3\times3$ matrix returns a $2\times2$ result; `identity_matrix(QQ,2) * vector(QQ,[1,2,3])` returns `(1, 2)`; `identity_matrix(QQ,2)^(1/2)` returns the identity rather than rejecting the unsupported exponent. These are invalid-input checks, not failures of the valid Markov calculation.

Impact: plausible-looking wrong results, especially dangerous for machine consumers. Workaround: the agents retained valid literal inputs and independently checked every requested output; no general compatibility shim was written. Suggested fix: validate ring coercion, matching dimensions and supported integral exponents before arithmetic, with Sage-compatible exception types. Supplementary direct run independently observed `matrix(QQ,[[1,2]]) * vector(QQ,[1,2,3])` returning `(5)` instead of Sage's `TypeError`.

### 3. Ctrl+C did not recover the CLI session

Codex saved a marker and matrix, started the finite Python generator calculation `sum(i*i for i in range(1000000000))`, then sent Ctrl+C after one second. No prompt returned within eight seconds. A separate process-group SIGINT attempt also timed out. Both probe groups were terminated; [cleanup evidence](2026-11-19-cli-markov/fresh-codex/cleanup-result.json) found none remaining. [Probe](2026-11-19-cli-markov/fresh-codex/interrupt_probe.py) and [result](2026-11-19-cli-markov/fresh-codex/interrupt-control-c-result.json) are retained. Claude independently tried an interactive long loop, then queried saved matrix state and a new calculation, without receiving results after Ctrl+C; its [interactive log](2026-11-19-cli-markov/fresh-claude/out/interrupt_repl.log) records the bounded waits.

Claude then allowed a smaller $10^8$-iteration CLI loop to finish: `KeyboardInterrupt` eventually appeared and saved state/new calculations worked, but the final loop index was 99,999,999. Thus it had completed all iterations rather than stopping early. A direct SIGINT to its separate npm CLI process exited the process without recovering a session. Its harness's elapsed summary includes subsequent waits: do not interpret the whole-script duration as interrupt latency.

Impact: the CLI process remains busy and a new user cannot regain control promptly. Workaround: terminate only the test processes and restart, or use the wheel's programmatic session API. **CLI Stop failed to preempt within the tested bounds; state was unqueryable in the terminated long probes, but survived the smaller loop's natural completion.** Do not interpret a harness's `state_kept: false` as proof that variables were erased: no response was available to inspect them.

Positive control: Claude used the published wheel's `sagebrush.session.Session.interrupt()` during a billion-iteration loop. The structured interrupt response arrived in 0.05 s; the index was about 3 million, the saved matrix remained intact, a new inverse succeeded, and `restarted` was false. The session was explicitly closed afterward. See [session evidence](2026-11-19-cli-markov/fresh-claude/out/session_interrupt.json) and [probe](2026-11-19-cli-markov/fresh-claude/scripts/session_interrupt.py). Suggested fix: align CLI Ctrl+C with that working interruption behavior, with a bounded regression test. GUI/Jupyter Stop and Rust-engine interruption were not exercised.

### 4. Public entry points and task discovery require glue

Claude installed npm and the PyPI wheel: npm's `sagebrush` executable runs computations, whereas the wheel's console `sagebrush` exposes management commands; `python -m sagebrush` runs code. Workaround: switch to the documented module entry point. Suggested fix: a clear side-by-side quickstart and actionable guidance from the wrong entry point.

Neither agent discovered an absorbing-chain workflow through search. Codex's `--search 'absorbing Markov' --json` returns `[]` on stdout with explanatory text on stderr. Workaround: derive the block-matrix formulas. This is a discovery miss, not proof that every related API is absent. Codex also found shipped JSON search metadata lacked status/difference/alternative fields described in public prose. Suggested fix: an absorbing-chain example and a documented, versioned search schema; keep no-match explanations accessible to JSON consumers.

Claude tried Sage's `.submatrix()` and `.matrix_from_rows_and_columns()`; neither was available. Workaround: matrix slicing `P[0:2,0:2]`. Suggested fix: discoverable supported alternatives or compatible extraction methods. Error probes also needed executable lambdas rather than relying on global `preparse()`.

### 5. Exact values need explicit JSON encoding

Raw `Matrix` and rational/Fraction values are not directly JSON serializable. Workaround: convert each entry to a canonical reduced rational string, with positive denominator and integers written without `/1`; include row/column labels and schema. This behavior also occurs with CPython Fraction and Sage, so it is not an exception-parity defect. Suggested fix: a documented exact-value JSON recipe/schema so each new agent does not reinvent it.

### 6. Other paper cuts and harness mistakes

Claude observed search limits `--limit abc` and `--limit -1` silently falling back/clamping rather than reporting invalid options. Suggested fix: reject malformed limits with an actionable error; no task workaround needed beyond valid numeric limits. `sagebrush.__version__` was unavailable, so it recorded package/CLI versions instead; a documented programmatic version would simplify provenance. Direct wheel `linalg.inverse` results mixed integer and Fraction entries; explicit rational-string encoding handled both, not a numerical defect. CLI help/docstrings/tracebacks also contain internal source paths and development references; they did not block progress, but user-facing help should explain actionable entry points rather than internal history.

Do not file these harness/oracle mistakes as product bugs: Codex initially expected `>>>` rather than `sage: ` (corrected before the valid interrupt probes); its local `sage -python` invocation was unsupported (used `sage script.py`); the oracle `version()` query emitted a deprecation warning. Claude initially redirected into an uncreated `out/` directory (created it and reran); merged stderr with stdout and used `head` (separated streams and checked the actual command status). Search JSON stdout itself was valid. These mistakes consumed work and are retained to avoid overstating product friction.

My supplementary direct exploration at 8:09 AM PST found checkout documentation recommending npm 0.10.2 while the registry still reported latest 0.10.1 and returned ETARGET for 0.10.2; I pinned the available release. This was a point-in-time release gap, not evidence of the deployed site's version or a permanent install failure. The direct REPL also lacked `exit()`; Ctrl-D exited. After an ordinary `ZeroDivisionError`, a saved marker remained readable, so normal exception recovery worked even though interrupt recovery did not.

## Required run checklist

- **Coverage — hits:** public npm install/help/version, public documentation and JSON search; PyPI wheel execution; exact Sage literals, matrix construction/slicing/inverse/multiply/powers, stochasticity and internal identities; full real report and independent reference checks; invalid inputs, top-level errors, JSON output, interactive interruption and bounded cleanup.
- **Coverage — misses:** browser/Jupyter, Rust-engine interruption, large-scale/performance behavior, broad API compatibility and arbitrary user-supplied stochasticity validation. No claims about current master fixes or hosted CI.
- **Stop and session:** bounded CLI interrupts did not preempt; long probes needed termination and state was unqueryable. A smaller loop finished naturally, then state/new calculations worked. The wheel's programmatic session interrupt passed in 0.05 s without restart or state loss. Ordinary exception recovery passed in the supplementary sample.
- **Error-type parity:** fresh Codex sample matched Sage on 13/15 status/type cases and CPython on all 6 comparable cases; fresh Claude matched Sage on 8/13, with five differences (invalid entry accepted, `QQ('1/0')` exception type, fractional power accepted, nonsquare power exception type, wrong-shape addition accepted). Different case sets, not comparable percentages. Exact messages are not claimed to match. [Codex table](2026-11-19-cli-markov/fresh-codex/error-parity.json), [Claude table](2026-11-19-cli-markov/fresh-claude/out/error_parity.txt).
- **Machine readability:** discovery JSON and user-authored successful reports passed; native CLI execution errors failed this requirement. The wheel's Session API offers structured dictionaries, a useful alternative. Custom caught-error JSON is a workaround, not native CLI support. Exact arithmetic output is explicitly schema-labelled and machine-parseable.

No fixes, pushes, issue creation or deployments were performed. Coordinator triage should prioritize silent invalid-input arithmetic, interruption/session recovery, and structured execution errors; the remaining items are discovery/documentation/compatibility follow-ups.

Evidence presentation: committed interactive logs trim trailing prompt spaces for repository whitespace checks; original scratch logs remain unchanged. No diagnostic text or timestamps were removed.
