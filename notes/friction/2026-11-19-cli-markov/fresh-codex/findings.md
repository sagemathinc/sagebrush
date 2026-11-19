# Sagebrush public CLI sample

Completed in about five minutes on 2026-11-19. The exact report is `markov-report.json`, produced by public npm Sagebrush 0.10.1 on Node v26.13.1. All mathematical outputs passed independent SymPy checks. No product source or checkout was read or modified, and nobody was contacted.

Reproduce the report: `npx --yes sagebrush@0.10.1 markov_report.sage`. Rational entries are JSON strings: reduced `n/d` with positive denominator, or `n` for integers. Rows follow the stated state order; fundamental-matrix rows/columns are the two transient states and absorption columns are converted, abandoned. Step count is transitions until first absorption, including the transition entering absorption. Initially absorbing states have zero mean and variance.

Results: N = [[5/2, 5/4], [1, 5/2]]; absorption = [[3/4, 1/4], [1/2, 1/2]]; transient expected steps = [15/4, 7/2]; transient variance = [155/16, 37/4]. Full P^5 and second moments are saved in the report.

## Coverage and machine readability

Hits: public npm metadata and README; CLI help/version; JSON documentation search; Sage syntax and exact QQ literals; matrix construction, indexing, identity, inverse, multiplication, powers and equality; fundamental matrix, absorption probabilities, expected time, second moment, variance, P^5; Sagebrush internal identities; JSON output file and stdout; 10 independent SymPy checks; 15 invalid-input/serialization cases compared with Sage; 6 comparable with CPython; top-level runtime, syntax, option and file errors; bounded REPL Ctrl+C and process-group SIGINT attempts; probe-only process cleanup verified.

Misses: No dedicated absorbing-chain function discovered; actual absence unproven; PyPI wheel not tested; GUI/Jupyter Stop not exercised; Rust/Wasm engine interruption not tested; workload was a Python generator sum; State recovery after interruption not verified because prompt did not return; No broad library compatibility or performance claims; No input stochasticity validator API investigated.

Discovery returns JSON. Computation required user-authored JSON serialization. Native errors are text; caught test exceptions were serialized by the harness. Error status/type parity was 13/15 against Sage and 6/6 against CPython for comparable cases. The two Sage differences were acceptance of an invalid QQ entry and the type for a string matrix exponent. Message parity is not claimed. See `error-parity.json` and the three `errors-*.json` files.

## Interrupt and state

A finite sum over range(1000000000) was interrupted after one second, with eight seconds allowed for a prompt. Both a Ctrl+C input byte and a separate SIGINT process-group attempt timed out. Marker and matrix state existed before the calculation, but could not be queried afterward. State preservation is unverified. Only started probe process groups were terminated; `cleanup-result.json` confirms none remained. GUI Stop and Rust/Wasm interruption were not tested. The first probe was a harness error (wrong prompt), preserved separately.

## Every observed obstacle and workaround

Exact argv, stdout, stderr, exit code, impact and suggested fixes for every entry below are embedded in `findings.json`. `commands.jsonl` and `transcript.log` retain full command results. Interactive sends and output are in the `interrupt-*-transcript.log` files. Scripts are retained beside the artifacts.

1. **No dedicated absorbing-chain discovery result**

   Impact: No task-specific function found; absence of a search match does not prove API absence. JSON stdout was [] and explanatory diagnostics were plain stderr.

   Workaround: Use standard block-matrix formulas entirely in Sagebrush. No request link was followed.

   Suggested fix: Add an absorbing-chain example and structured no-match metadata alongside JSON results.

   Record 10: `npx --yes sagebrush@0.10.1 --search 'absorbing Markov' --limit 5 --json` (exit 0).

2. **No general computation --json switch**

   Impact: Exit 2: unknown option --json; no structured evaluation/error envelope.

   Workaround: Serialize the report using json inside the Sagebrush program; catch test exceptions and emit type/message JSON.

   Suggested fix: Offer a computation JSON envelope with value, stdout, error type/message and exit status.

   Record 13: `npx --yes sagebrush@0.10.1 --json --sage -c 'print(1/3)'` (exit 2).

3. **Matrix and Fraction require explicit JSON encoding**

   Impact: json.dumps on Matrix/Fraction raises TypeError. This is also normal CPython Fraction behavior, not a parity bug.

   Workaround: Encode all matrix entries explicitly as canonical rational strings, documented in the report.

   Suggested fix: Document a reusable exact-rational/matrix JSON serializer with a schema.

   Record 18: `python error_cases.py` (exit 0).

   Record 19: `npx --yes sagebrush@0.10.1 --sage error_cases.py` (exit 0).

   Record 26: `npx --yes sagebrush@0.10.1 --sage -c 'import json; print(json.dumps(matrix(QQ, [[1/3]])))'` (exit 1).

4. **Invalid QQ entry accepted**

   Impact: Sagebrush accepts a nonnumeric entry while declaring Rational Field. Sage rejects it immediately with TypeError. Inverse later raises ValueError instead. The valid report inputs were unaffected.

   Workaround: No product workaround used; valid task inputs were exact numeric literals. Independent report checks passed. For general input handling, explicitly coerce each entry through QQ before matrix construction.

   Suggested fix: Coerce and validate every QQ matrix entry at construction and match Sage TypeError behavior.

   Record 18: `python error_cases.py` (exit 0).

   Record 19: `npx --yes sagebrush@0.10.1 --sage error_cases.py` (exit 0).

   Record 28: `npx --yes sagebrush@0.10.1 --sage -c 'print(matrix(QQ, [['"'"'nope'"'"']]).base_ring()); print(matrix(QQ, [['"'"'nope'"'"']]).inverse())'` (exit 1).

5. **Invalid matrix power has different exception type**

   Impact: String exponent gives ValueError in Sagebrush and NotImplementedError in Sage.

   Workaround: Record the discrepancy; no invalid exponent used in the report.

   Suggested fix: Match Sage non-integral exponent validation and exception type.

   Record 18: `python error_cases.py` (exit 0).

   Record 19: `npx --yes sagebrush@0.10.1 --sage error_cases.py` (exit 0).

   Record 20: `sage -python sage_errors.py` (exit 2).

   Record 21: `sage sage_errors.py` (exit 0).

6. **Native errors are human-readable text**

   Impact: Runtime errors exit 1; missing file exits 2. Tracebacks and SyntaxError diagnostics are text, not JSON.

   Workaround: Custom try/except yields structured error test output, but top-level syntax/argument errors require an external capture wrapper.

   Suggested fix: Provide consistent opt-in JSON error envelopes, including argument, parsing and file errors.

   Record 14: `npx --yes sagebrush@0.10.1 --sage -c 'print(1/0)'` (exit 1).

   Record 25: `npx --yes sagebrush@0.10.1 definitely-missing.sage` (exit 2).

   Record 26: `npx --yes sagebrush@0.10.1 --sage -c 'import json; print(json.dumps(matrix(QQ, [[1/3]])))'` (exit 1).

   Record 27: `npx --yes sagebrush@0.10.1 --sage -c 'x ='` (exit 1).

   Record 28: `npx --yes sagebrush@0.10.1 --sage -c 'print(matrix(QQ, [['"'"'nope'"'"']]).base_ring()); print(matrix(QQ, [['"'"'nope'"'"']]).inverse())'` (exit 1).

7. **Sage oracle launcher differs from expected -python form**

   Impact: Oracle command failed with exit 2: unrecognized arguments: -python.

   Workaround: Use sage sage_errors.py, which succeeded.

   Suggested fix: Document available launcher forms; this obstacle belongs to the local Sage oracle, not Sagebrush.

   Record 20: `sage -python sage_errors.py` (exit 2).

8. **Sage version query deprecation**

   Impact: Version succeeded but emitted a DeprecationWarning. No effect on report.

   Workaround: Record SageMath version 10.9.post1; ignore no warnings silently.

   Suggested fix: For future probes use sage.version.version; this is an oracle concern.

   Record 16: `sage -c 'print(version())'` (exit 0).

9. **PTY harness initially expected Python prompt**

   Impact: First attempt timed out after 8 seconds because actual prompt was sage: rather than >>>. No interrupt was sent in that attempt.

   Workaround: Preserve first attempt artifacts; change only the prompt matcher and rerun.

   Suggested fix: Harness should match language-specific prompts; documentation could show Sage REPL prompt.

   Record 22: `python interrupt_probe.py` (exit 0).

10. **Ctrl+C and SIGINT did not restore CLI prompt within bound**

   Impact: After setting saved_marker=1729 and saved_matrix, a finite sum over 1,000,000,000 values ran; neither Ctrl+C byte nor SIGINT to the probe process group restored a prompt within 8 seconds. Existing state could not be queried.

   Workaround: Terminate only probe process groups with SIGTERM, escalating if required; verify no remaining processes in those groups. Do not claim state preservation or data loss.

   Suggested fix: Make CLI interruption preempt computations, including generator loops; preserve variables and return KeyboardInterrupt plus a usable prompt. Add a documented bounded interrupt test.

   Record 23: `python interrupt_probe.py` (exit 0).

   Record 29: `python interrupt_sigint_probe.py` (exit 0).

11. **Discovery metadata falls short of public prose**

   Impact: Observed matching search entries had name/signature/doc/examples but no status/differs/alternative fields; public llms.txt describes statuses and request URLs. No-match request URL appeared only in stderr.

   Workaround: Treat runnable examples and actual execution as evidence; make no feature claims from undocumented status fields.

   Suggested fix: Align shipped JSON search schema with public documentation or clarify which interfaces supply those fields.

   Record 8: `npx --yes sagebrush@0.10.1 --search inverse --limit 6 --json` (exit 0).

   Record 9: `npx --yes sagebrush@0.10.1 --search matrix --limit 12 --json` (exit 0).

   Record 10: `npx --yes sagebrush@0.10.1 --search 'absorbing Markov' --limit 5 --json` (exit 0).

   Record 15: `npx --yes sagebrush@0.10.1 --search Matrix.rows --json` (exit 0).

## Discovery notes and boundaries

Initial web search: `Sagebrush mathematics CLI npm PyPI install`. The homepage https://sagebrush.space/ advertised npm/npx and pip; https://pypi.org/project/sagebrush/ also appeared, but its search excerpt showed an older release, so the current npm registry and public llms.txt were used for pinned CLI instructions. No wheel was installed. Public npm README, metadata and llms.txt are saved. Normal npx package installation/cache behavior was allowed; package implementation was never inspected. Traceback references to embedded library files were captured only as CLI output.

The initial scratch check was `pwd && ls -la`: current directory /scratch/friction-cli-fresh-codex-cZHAfF, containing only an empty transcript.log. A logger was then created before product commands. CPython/Sage/SymPy were used only as oracles, not as substitutes for Sagebrush. No SKILL.md was needed because this is a black-box user exercise, not algorithm implementation.
