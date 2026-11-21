# Command transcript notes: Sagebrush absorbing-Markov sample (2026-11-19, ~16:17–16:30 UTC)

Environment: Linux, Node v26.13.1, CPython 3.14.4, SageMath 10.9.post1, deno and bun present.
`transcript.log` in this directory is the harness's own session recording. I did not write to it.

## Discovery / install
1. `npm view sagebrush ...` → 0.10.1, bin `sagebrush`, "Python 3.14 on a JavaScript runtime".
   `pip index versions sagebrush` / PyPI JSON → 0.10.1, a different product description (Rust engines for CPython, MCP server).
   Saved READMEs: `npm-readme.md`, `pypi-readme.md`.
2. `cd npmpkg && npm init -y && npm install sagebrush@0.10.1` (1.1 s)
   `python3.14 -m venv venv && venv/bin/pip install sagebrush==0.10.1` (5.2 s) → bins `sagebrush`, `sagebrush-mcp`.
3. `npmpkg/node_modules/.bin/sagebrush --help` (rc 0) / `--version` → `sagebrush 0.10.1 (Python 3.14 language on a JavaScript runtime)`.
   `venv/bin/sagebrush --help` → only `bench`, `remote`, `--version`. Computing goes through `python -m sagebrush FILE.sage`.

## Machine-readable discovery
4. `sagebrush --search "<q>" --json --limit 5` for markov / fundamental matrix / absorbing / inverse / matrix power.
   JSON goes to stdout and the "no results" hint goes to stderr (verified: `2>/dev/null | json.load` works). rc 0.
   - "absorbing" → `[]` plus a coverage-request URL on stderr. No Markov-chain API exists (Sage has none either).
   - `--mode bogus` → rc 2 with a clear message. `--limit abc` → silently 20 results. `--limit -1` → 1 result.
   - `--bogus-flag` → rc 2 with usage. Missing file → rc 2, CPython-style message.

## Computation
5. `sagebrush scripts/markov.sage` → rc 1: `AttributeError: 'Matrix' object has no attribute 'submatrix'`.
   `dir(P)` shows no `submatrix` and no `matrix_from_rows_and_columns`. `P[0:2,0:2]` slicing works → workaround applied.
6. Rerun → rc 0, JSON on stdout (`out/npm_report.raw`).
7. `venv/bin/python -m sagebrush scripts/markov.sage` (run from /tmp) → identical JSON (`out/pypi_report.raw`, equal: True).
   `from sagebrush import linalg; linalg.inverse(...)` → mixed `int`/`Fraction` entries (e.g. `1` next to `Fraction(5, 2)`).
   `sagebrush.__version__` → missing in both. npm `sys.version` → `3.14.0 (pyjs-spike)`.
8. Independent checks: `python3 -I scripts/check_cpython.py out/npm_report.raw` → all true.
   `sage scripts/check_sage.sage out/npm_report.raw` → all true (2.0 s).
9. Final report: `markov_report.json` (Sagebrush output plus provenance/verification metadata only). Re-checked with Sage → all true.

## Error parity (`scripts/errors.sage`, `scripts/probe.sage`)
10. First attempt used `eval(preparse(expr))` → every case `NameError: name 'preparse' is not defined` in Sagebrush (real Sage has a global `preparse`). Rewritten with lambdas.
11. Results: `out/error_parity.txt`, `out/probe_sagebrush.txt`, `out/probe_sage.txt`, `out/cpython_fraction_errors.txt`.
12. Uncaught errors via the CLI: stderr traceback, rc 1, stdout empty. No JSON error mode. Frames show internal paths `/$pyjs/lib/_sage_matrix.py`.
    Python-mode SyntaxError / ZeroDivisionError / ModuleNotFoundError: same type, message, caret position and rc as CPython 3.14 (`out/syntax_parity.txt`). The only difference is that CPython shows the `~^~` range marker.

## Stop / interrupt
13. REPL in a pty (`scripts/interrupt_repl.py`, `scripts/interrupt_repl_timed.py`):
    - 10^9 loop + Ctrl-C (\x03): nothing for 5 s, and REPL unresponsive for 10+ s more → killed by my script.
    - 10^8 loop (timed): Ctrl-C sent at about 3 s. The loop ran to the end (`i= 99999999`, elapsed 23.1 s). `KeyboardInterrupt` was printed only afterwards. State (`keep`, `P`) kept and new calc OK. So Ctrl-C is deferred, not an interrupt, for pure-Python loops.
    - OS `kill -INT <pid>` → REPL process exits at once, no `KeyboardInterrupt`, state lost.
    Logs: `out/interrupt_repl*.log`.
14. PyPI `sagebrush.session.Session` (`scripts/session_interrupt.py`): `submit` 10^9 loop, `interrupt()` after 2 s → structured `error_info {type: interrupted, exception: KeyboardInterrupt}` within 0.05 s. `restarted: false`, state kept (`i= 3048724`, elapsed 2.0), new calc OK, `alive() == True`. `out/session_interrupt.json`.
15. `out/session_errors.json`: Session returns structured `error_info` (type/exception/message). The same silent wrong answers reproduce via PyPI.
16. Cleanup: every child I started was killed/closed. `pgrep -fa friction-cli-fresh-claude-fn98e0` shows only the harness's `script` recorder.
    (An earlier broad `pgrep -fa sagebrush` also listed unrelated processes of other jobs on this machine. I ignored that output and touched nothing.)
