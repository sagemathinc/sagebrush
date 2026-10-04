# Conformance

How the Python front end is measured against CPython 3.14.

| Suite | Command | Result (2026-10-04) |
|---|---|---|
| Parser: AST identical to `ast.parse` on real code | `python3 pyparse/test/compare_stdlib.py DIR` | stdlib 628/628, site-packages (numpy, pandas, matplotlib, pyarrow, ...) 4327/4327, Sage library 2594/2594 |
| Parser: SyntaxError identical (type, message, line, offset, end) | `python3 pyparse/test/compare_errors.py` | CPython's `test_syntax.py`: 463/463 errors, 126/126 valid snippets accepted |
| Runtime: MicroPython `tests/basics` output identical to CPython | `python3 conformance/micropython.py` | pyjs spike (tree-sitter front end, untouched since the 2-week experiment): 388/562; sagejs: 505/508 |

The MicroPython corpus is the one vendored in sagejs
(`~/sagejs/upstream-tests/micropython`, MIT); the RustPython suite is at
`~/sagejs/upstream-tests/python-compat/suites/rustpython`.  Next: wire
`pyparse` into the spike in place of tree-sitter, then run all three suites
on every change.
