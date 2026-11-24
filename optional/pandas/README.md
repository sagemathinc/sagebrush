# @sagebrush/pandas

Sagebrush's pandas 0.x (plan-pandas r7, M1): a subset of pandas 3.1.0's API, in Python over Sagebrush's numpy, as an optional package.

## The subset (M1)

- **Data:** `Series`, `DataFrame` and `Index`/`RangeIndex`, with the dtypes int64, float64, bool, str (pandas 3's default string dtype) and object, and the smaller integers astype gives.
- **Indexing:** `[]`, `.loc` and `.iloc`, with Copy-on-Write ownership. A derived object never shares a column with its source or with a caller's array.
- **Reading CSV:** `read_csv`, with sep, header, names, index_col, usecols, na_values, keep_default_na, dtype, nrows, skiprows, quotechar and parse_dates (False only).
- **Display:** text and HTML reprs, and six display options.
- **Reductions:** sum, mean, min, max and count, plus the comparisons that make masks.
- **Sorting and reshaping (for scikit-learn's lessons):** `sort_values` (by one or more columns, ascending per key, na_position, ignore_index; always stable: pandas' default quicksort isn't, so for tied keys its order is unspecified and this one is a valid answer), `unique`, `apply` (a function of each value, column or row), `fillna` (a value, or a dict per column), `astype` (between the subset's dtypes, a dict per column, and to int8, int16, int32, uint8, uint16 and uint32, which wrap as numpy's astype does), `rename`, `reset_index`.
- **Counting, joining and reshaping:** `Series.value_counts` (normalize, sort, ascending, dropna; ties in order of first appearance), `pd.concat` of Series and frames (rows or columns, outer or inner join, ignore_index, sort, verify_integrity; pandas' dtype rules for missing cells), `drop` (rows or columns by label), `melt` and `pd.melt`, `info` and `memory_usage` (deep only for numeric data: the sizes of Python objects are CPython's), and `to_numpy(dtype=, na_value=)`. Keys and dicts in `concat`, `bins` in `value_counts` and `level=` need a MultiIndex or an IntervalIndex and are refused.
- **float32 columns:** from float32 arrays, `dtype="float32"`, numpy float32 values or `astype`; they stay float32 through setting, sorting, filling, `concat` (numpy's promotion: float32 with int16 is float32, with int32 or int64 float64) and `diff`, reduce in float32 as pandas' nanops do (`sum`, `mean`, `min` and `max` are `np.float32`), and print, `describe` and `corr` as pandas does. `read_csv(dtype="float32")` is refused for now.
- **groupby:** by one key (a column, a Series or list of the same length, or the index), with `sort`, `dropna` and `as_index`; `size`, `count`, `sum`, `mean`, `min`, `max` and `agg` (a name, numpy's sum/mean/min/max, a function of each group, a list for one column, a dict, or named aggregation); iteration and `get_group`. Sums and means follow pandas' own two paths: numpy's per-run sum when the rows already come in group order without missing floats, else its Kahan summation. Several keys, and lists of functions over a frame, need a MultiIndex and are refused.
- **Selecting and testing:** `take` (rows or columns by position), `any` and `all` (per Series, or per column of a frame), and an Index's `to_numpy`, `numpy.asarray` and `astype`. `Index.to_numpy` exports string labels as a `'<U'` array (as a str column does); `numpy.asarray` of a str Index is refused.
- **Series arithmetic:** `+ - * / // % **` with a number, a list or array, or another Series (aligned on the sorted union of their labels), their reflections, unary `-`, `+` and `abs`, and the named methods (`add`, `sub`, `mul`, `truediv`, `floordiv`, `mod`, `pow` and their `r` forms) with `fill_value`. NumPy 2's dtype rules apply, with a Python or numpy number as a weak scalar (a float32 column stays float32); division by zero is pandas' (`/` numpy's signed infinities; `//` and `divmod` by the signs of the dividend and of the zero, as float64; `%` NaN); bools and str values follow pandas. Object columns, and a frame's arithmetic, are refused for now.
- **Summary statistics:** `describe` of a Series or a frame (percentiles, include, exclude; count, mean, std with ddof=1, min, numpy's linear percentiles and max for numbers, count, unique, top and freq for the rest) and `corr` (Pearson's, pairwise over the rows where both columns are finite, min_periods, numeric_only, or a function; `Series.corr`). These follow pandas' own steps (its nanops sums and its nancorr updates), so the floats are pandas'. Datetime columns and the rank correlations (spearman, kendall) are refused.
- **Exporting str data:** `to_numpy()` and `.values` of a str column or of a frame of only str columns, and `unique()` of a str Series, give a `'<U'` numpy array where pandas gives an object array (or its StringArray): Sagebrush's numpy has no object dtype yet. Missing values in str data, a frame mixing str with other columns, and `numpy.asarray` of str data are refused. `tests/test_str_export.py` states what Sagebrush gives.
- **Times (PR A of the xlsx/time-series design):** naive `datetime64[us]` columns and `DatetimeIndex`, `Timestamp`, `NaT` and `to_datetime` (ISO dates and times, M/D/YYYY, YYYYMMDD, a `format` of `%Y %m %d %H %M %S %y %f`, numbers with a `unit` and `origin`; a list's format inferred from its first string, as pandas 3.1). Also `.dt.year/.month/.day/.hour/.minute/.second/.strftime`, an index's `.year/.month/.day/.strftime`, `Series/DataFrame.diff(periods)`, `dropna(how, thresh, subset, inplace)`, and `DataFrame.set_index(label)`. Sagebrush's numpy has no `datetime64` yet, so a datetime column is int64 microseconds inside the package: its `.values`/`.to_numpy()` raise NotImplementedError rather than give another type, as do `Timedelta`, timezones, nanosecond results, and times outside the years 1685–2255 (where those microseconds stop being exact).

Everything outside the subset raises `NotImplementedError("... is not in Sagebrush's pandas 0.x subset")` before doing any work. `tests/test_unsupported.py` lists each such form, and `known.json` gives the reason for each one. `known.json`'s `value_divergences` also name the few ruled places where a value differs from pandas without a refusal (today one: a groupby sum or mean over a frame with a float column added after construction, which can take a different summation path; `tests/test_groupby_blocks.py` pins it).

## Limits

When the engine's limit `pandas.decoded_bytes` is finite (grading sets it; it is unlimited by default), `read_csv` preflights every allocation against that budget. It refuses with a `ValueError` before the growth. `tests/test_budget.py` and `tests/test_budget_map.py` check its six adversarial shapes, and `tests/test_budget_order.py` checks that each charge comes before the growth it admits (at zero headroom nothing is read or copied first).

## Tests

`tests/test_*.py` run under the built CLI with the package set (`node scripts/optional-packages.mjs test --pkgset ...`). Each is compared with its `.out`:

- **pandas' own output** (`tests/oracle/`, recorded by `tests/gen-oracle.sh` in the environment `tests/oracle-env.txt`) for every other test;
- **Sagebrush's output** for the tests listed in `tests/sagebrush-only.txt`, where the oracle can't speak: `test_unsupported`, `test_repr_escape`, `test_budget`, `test_budget_map`, `test_budget_order`, `test_read_excel_budget`, `test_read_excel_limits`, `test_str_export`, `test_groupby_blocks` and `test_known` (which checks `known.json`, and that every test is either in that list or has an oracle output, never both). `tests/gen-oracle.sh` skips that list.

A test with a `test_<name>.limits.json` beside it runs under those limits.

## Notices

See `NOTICE.md`. pandas' license ships as `py/pandas/_pd_license.py`.
