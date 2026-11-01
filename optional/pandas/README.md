# @sagebrush/pandas

Sagebrush's pandas 0.x (plan-pandas r7, M1): a subset of pandas 3.1.0's API, in Python over Sagebrush's numpy, as an optional package.

## The subset (M1)

- **Data:** `Series`, `DataFrame` and `Index`/`RangeIndex`, with the dtypes int64, float64, bool, str (pandas 3's default string dtype) and object.
- **Indexing:** `[]`, `.loc` and `.iloc`, with Copy-on-Write ownership. A derived object never shares a column with its source or with a caller's array.
- **Reading CSV:** `read_csv`, with sep, header, names, index_col, usecols, na_values, keep_default_na, dtype, nrows, skiprows, quotechar and parse_dates (False only).
- **Display:** text and HTML reprs, and six display options.
- **Reductions:** sum, mean, min, max and count, plus the comparisons that make masks.

Everything outside the subset raises `NotImplementedError("... is not in Sagebrush's pandas 0.x subset")` before doing any work. `tests/test_unsupported.py` lists each such form, and `known.json` gives the reason for each one.

## Limits

When the engine's limit `pandas.decoded_bytes` is finite (grading sets it; it is unlimited by default), `read_csv` preflights every allocation against that budget. It refuses with a `ValueError` before the growth. `tests/test_budget.py` and `tests/test_budget_map.py` check its six adversarial shapes.

## Tests

`tests/test_*.py` run under the built CLI with the package set (`node scripts/optional-packages.mjs test --pkgset ...`). Each is compared with its `.out`:

- **pandas' own output** (`tests/oracle/`, recorded by `tests/gen-oracle.sh` in the environment `tests/oracle-env.txt`) for every test except five;
- **Sagebrush's output** for those five, where the oracle can't speak: `test_unsupported`, `test_repr_escape`, `test_budget`, `test_budget_map` and `test_known` (which checks `known.json`).

A test with a `test_<name>.limits.json` beside it runs under those limits.

## Notices

See `NOTICE.md`. pandas' license ships as `py/pandas/_pd_license.py`.
