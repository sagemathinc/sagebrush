# Findings: Sagebrush 0.10.1 as a new user, absorbing Markov-chain report

**Deliverable:** `markov_report.json`, computed by Sagebrush (`npm sagebrush@0.10.1`, `--sage`). It reproduces byte-identically through the PyPI wheel. CPython `fractions` and SageMath 10.9 agree on every value.
**Rational encoding:** each exact rational is a JSON string `"p/q"` in lowest terms with q > 0, or `"p"` when q = 1. Parse with `fractions.Fraction(s)`. This is documented inside the report (`rational_encoding`).

| quantity | value (rows new, engaged) |
|---|---|
| N = (I−Q)⁻¹ | [[5/2, 5/4], [1, 5/2]] |
| B = NR (converted, abandoned) | [[3/4, 1/4], [1/2, 1/2]] |
| t = N·1 | [15/4, 7/2] |
| Var = (2N−I)t − t² | [155/16, 37/4] |
| P⁵ rows new / engaged | [1/10, 11/100, 31/50, 17/100] / [11/125, 1/10, 48/125, 107/250] |

## Obstacles and workarounds (each one logged)

| # | Severity | Command | Output | Impact | Suggested fix |
|---|---|---|---|---|---|
| 1 | **High (silent wrong answer)** | `matrix(QQ,2,2,[1,1,1,1]) + matrix(QQ,3,3,range(9))` (same for `-`) | `[1 2; 4 5]`: a truncated 2×2 result. Sage: `TypeError: unsupported operand parent(s)`. `3x3+2x2` gives `ValueError` instead. | Didn't affect this report, but a shape bug in a user's Markov code would give wrong numbers with no error | Check `nrows/ncols` equality in `__add__`/`__sub__` and raise Sage's TypeError |
| 2 | **High (silent wrong answer)** | `identity_matrix(QQ,2) * vector(QQ,[1,2,3])` | `(1, 2)`. Sage: `TypeError` | Same risk (e.g. `N * ones` with the wrong length) | Check the dimension in matrix×vector |
| 3 | **High (silent wrong answer)** | `matrix(QQ,[[2,0],[0,3]])^(1/2)` and `^0.5` | the identity matrix. Sage: `NotImplementedError: non-integral exponents not supported` | Mathematically false result | Reject non-integral exponents |
| 4 | Medium | `matrix(QQ, [['a',1],[0,1]])`, `matrix(QQ,[[1/3,'x']])` | Accepted. The entry stays a `str`, and the failure only comes later (`det` → ValueError, `M*M` → TypeError). Sage: `TypeError: unable to convert 'a' to a rational` at construction | Bad input is detected late, far from its cause | Coerce entries to the base ring in the constructor |
| 5 | Medium (blocker, worked around) | `P.submatrix(0,0,2,2)` | `AttributeError: 'Matrix' object has no attribute 'submatrix'`. `matrix_from_rows_and_columns` is missing too | Script failed on first run. Worked around with `P[0:2,0:2]` slicing | Implement `submatrix` / `matrix_from_rows_and_columns` (standard Sage, central for block decompositions) |
| 6 | Medium (worked around) | `eval(preparse(expr))` in a `.sage` file | `NameError: name 'preparse' is not defined` (CLI and PyPI Session). Sage defines it globally | Error-parity harness failed. Rewritten with lambdas | Expose `preparse` in the Sage namespace (PyPI has `sagebrush.preparse.preparse`) |
| 7 | **High (Stop)** | npm REPL, `for i in range(10^8): s += i`, Ctrl-C after 3 s | Loop ran to completion (`i=99999999`, 23 s). `KeyboardInterrupt` was printed only afterwards. With 10^9 the REPL was unresponsive past my 15 s window | Stop doesn't work for pure-Python work in the CLI REPL. A long run can only be killed, which loses state | Check for interrupts during Python execution (e.g. SharedArrayBuffer/Atomics flag polled in the evaluator, as the Jupyter kernel's "Stop" presumably does) |
| 8 | Medium | `kill -INT <REPL pid>` | REPL process exits at once, no `KeyboardInterrupt`, state lost | Standard SIGINT can't be used as Stop | Install a SIGINT handler that sets the interrupt flag |
| 9 | Low | CLI errors | Only a stderr traceback (rc 1). No `--json` error/result mode for `-c`/file runs | Callers must scrape tracebacks. I wrote my own JSON in the script | Add `--json` output for runs: `{ok, stdout, error:{type,message,traceback}}`. PyPI `Session.run` already has this shape |
| 10 | Low | traceback frames | `File "/$pyjs/lib/_sage_matrix.py", line 1741` | Internal paths leak. Not actionable for users | Hide internal frames or label them |
| 11 | Low | `--search inverse --limit abc` / `--limit -1` | 20 results / 1 result, no error (`--mode bogus` does give rc 2) | Confusing | Validate `--limit` as a positive integer and exit 2 |
| 12 | Low | `--search absorbing --json` | `[]` with rc 0. Hint plus issue URL on stderr | Fine. JSON stays clean on stdout. No Markov-chain API exists (Sage has none either) | Optional: a recipe/example for absorbing chains |
| 13 | Low | error-type mismatches | `M_{2×3}^2`: TypeError (Sage ArithmeticError "self must be a square matrix"). `QQ('1/0')`: ZeroDivisionError (Sage TypeError; matches CPython `Fraction('1/0')`) | Code that catches Sage's types misses these | Match Sage's exception types |
| 14 | Low | PyPI CLI | `venv/bin/sagebrush --help` has only bench/remote. Running maths needs `python -m sagebrush FILE.sage`, which only appears in help text | Two different CLIs share one name across npm and PyPI | Say so in both READMEs. Consider `sagebrush run FILE` on PyPI |
| 15 | Low | version introspection | `sagebrush.__version__` missing (npm and PyPI). npm `sys.version` = `3.14.0 (pyjs-spike)` | Couldn't record the version from inside the script. Took it from `--version` | Add `__version__` and drop the internal codename |
| 16 | Cosmetic | docs/help | `--help` names source files (`src/magma.ts`, `scripts/optional-packages.mjs`). `Session.__doc__` mentions "daybreak2 PR120-FIX4-1" | Noise | Remove internal references |
| 17 | Cosmetic | `linalg.inverse` (PyPI) | Mixed `int` and `Fraction` entries (`[[Fraction(5,2), ...], [1, ...]]`) | Callers must normalise | Return `Fraction` consistently, or document it |
| 18 | Self-inflicted | `> out/npm_report.raw` before `mkdir out` | bash: No such file or directory | none | n/a |

## Coverage hits and misses
- **Hits:** `matrix(QQ, ...)` with exact rationals, slicing `P[a:b, c:d]` and `P[[rows],[cols]]`, `identity_matrix`, `inverse`, `^n` (integer), `*`, `vector`, `sum(row)`, `QQ(x)` printing, `.rows()`, the `json` module, `.sage` file preparsing (`1/2` exact, `^` power), the documented PyPI `linalg.inverse`, `Session.submit/interrupt/run`.
- **Misses:** `Matrix.submatrix`, `matrix_from_rows_and_columns`, global `preparse`, `sagebrush.__version__`, any Markov-chain helper (Sage has none either), a JSON result/error mode for CLI runs, and dimension checks on matrix `+`, `-` and `×vector`.

## Stop / state result
- **npm CLI REPL:** Ctrl-C does **not** interrupt a running pure-Python loop. It is deferred until the loop ends. State survives, since nothing was interrupted. OS SIGINT kills the process and all state.
- **PyPI `sagebrush.session.Session`:** `interrupt()` stops the run in about 0.05 s with structured `error_info.type == "interrupted"`, `restarted: false`, variables kept (`keep`, `P`, partial `i`), and later runs work. Bounded throughout. I cleaned up all processes I started.
- Not tested: interrupting a Rust-engine call (e.g. ECM) via the CLI, the Jupyter kernel's Stop, and MCP `run_cancel`.

## Error-type parity
- Python level vs CPython 3.14: SyntaxError, ZeroDivisionError and ModuleNotFoundError match in type, message, caret and exit code.
- Sage level vs SageMath 10.9 (13 cases + probes): types match for singular inverse (ZeroDivisionError, same message), non-square inverse (ArithmeticError), `*` mismatch (TypeError), ragged rows (ValueError, different message), `QQ(1)/0`, singular `^-1`, and index out of range.
- Mismatches: non-square power (TypeError vs ArithmeticError) and `QQ('1/0')` (ZeroDivisionError vs TypeError). Three cases where Sage raises **return wrong values silently** (#1–#3), and one where it raises late (#4).

## Machine-readability
- `--search --json`: valid JSON on stdout, diagnostics on stderr, rc 2 on bad `--mode`.
- CLI run results: only what the user script prints. Errors are human tracebacks plus rc 1/2 (no JSON).
- PyPI `Session.run`: fully structured dict (`stdout`, `result` (a repr string, not exact data), `error_info{type,exception,message,traceback}`, `seconds`, `restarted`).
- The report itself is JSON. Exact rationals are strings, documented in-file, and verified by parsing with `Fraction`.

Time spent: about 14 minutes.
