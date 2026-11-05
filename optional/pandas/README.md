# @sagebrush/pandas

Sagebrush's pandas 0.x (plan-pandas r7, M1): a subset of pandas 3.1.0's API, in Python over Sagebrush's numpy, as an optional package.

## The subset (M1)

- **Data:** `Series`, `DataFrame` and `Index`/`RangeIndex`, with the dtypes int64, float64, bool, str (pandas 3's default string dtype) and object.
- **Indexing:** `[]`, `.loc` and `.iloc`, with Copy-on-Write ownership. A derived object never shares a column with its source or with a caller's array.
- **Reading CSV:** `read_csv`, with sep, header, names, index_col, usecols, na_values, keep_default_na, dtype, nrows, skiprows, quotechar and parse_dates (False only).
- **Display:** text and HTML reprs, and six display options.
- **Reductions:** sum, mean, min, max and count, plus the comparisons that make masks.
- **Times (PR A of the xlsx/time-series design):** naive `datetime64[us]` columns and `DatetimeIndex`, `Timestamp`, `NaT` and `to_datetime` (ISO dates and times, M/D/YYYY, YYYYMMDD, a `format` of `%Y %m %d %H %M %S %y %f`, numbers with a `unit` and `origin`; a list's format inferred from its first string, as pandas 3.1). Also `.dt.year/.month/.day/.hour/.minute/.second/.strftime`, an index's `.year/.month/.day/.strftime`, `Series/DataFrame.diff(periods)`, `dropna(how, thresh, subset, inplace)`, and `DataFrame.set_index(label)`. Sagebrush's numpy has no `datetime64` yet, so a datetime column is int64 microseconds inside the package: its `.values`/`.to_numpy()` raise NotImplementedError rather than give another type, as do `Timedelta`, timezones, nanosecond results, and times outside the years 1685–2255 (where those microseconds stop being exact).

Everything outside the subset raises `NotImplementedError("... is not in Sagebrush's pandas 0.x subset")` before doing any work. `tests/test_unsupported.py` lists each such form, and `known.json` gives the reason for each one.

## Limits

When the engine's limit `pandas.decoded_bytes` is finite (grading sets it; it is unlimited by default), `read_csv` preflights every allocation against that budget. It refuses with a `ValueError` before the growth. `tests/test_budget.py` and `tests/test_budget_map.py` check its six adversarial shapes, and `tests/test_budget_order.py` checks that each charge comes before the growth it admits (at zero headroom nothing is read or copied first).

## Tests

`tests/test_*.py` run under the built CLI with the package set (`node scripts/optional-packages.mjs test --pkgset ...`). Each is compared with its `.out`:

- **pandas' own output** (`tests/oracle/`, recorded by `tests/gen-oracle.sh` in the environment `tests/oracle-env.txt`) for every other test;
- **Sagebrush's output** for the tests listed in `tests/sagebrush-only.txt`, where the oracle can't speak: `test_unsupported`, `test_repr_escape`, `test_budget`, `test_budget_map`, `test_budget_order` and `test_known` (which checks `known.json`, and that every test is either in that list or has an oracle output, never both). `tests/gen-oracle.sh` skips that list.

A test with a `test_<name>.limits.json` beside it runs under those limits.

## Notices

See `NOTICE.md`. pandas' license ships as `py/pandas/_pd_license.py`.
