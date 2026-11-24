"""groupby with one key (a column, a Series or a list of labels, or the
index with level=0): size, count, sum, mean, min, max, std, var, median
and agg, as pandas 3.1.0 computes them, ported from pandas/_libs/groupby.pyx (BSD-3-Clause,
see _pd_license.py and NOTICE.md):

- groups are the key's distinct values, sorted (sort=True) or in order of
  first appearance; missing keys are dropped unless dropna=False (then one
  group, last);
- when the rows already come in group order (pandas' is_monotonic ids, the
  dropped missing keys first) and no float value is missing, pandas 3.1 sums
  with numpy's reduceat (per run, the first value plus numpy's pairwise sum
  of the rest; a mean is that sum, in float64, over the size): so does
  this;
- otherwise sum and mean of floats use pandas' Kahan summation, in the
  column's own float type (float32 accumulates in float32); integer sums are exact and
  keep the column's dtype where every sum fits it (else int64, as pandas'
  downcast), bool sums are int64; means of integers and bools are float64;
- min and max skip missing values and keep the dtype; str sums
  concatenate ('' for a group of missing values);
- std and var are pandas' Welford update (var of float32 in float32
  arithmetic), median the middle value or the mean of the two middle ones;
  a float32 column's std and median run in float64 and come back float32
  only when every value of its block fits within 5e-4,
  absolute (_fits32).
Several keys need a MultiIndex, which isn't in the subset: they raise.
"""

import math

import numpy as np

from ._pd_errors import unsupported_name
from ._pd_column import Column, column_from
from ._pd_dtypes import STR, INTS, FLOATS, is_missing
from ._pd_datetime import DT
from ._pd_index import Index, default_index

__all__ = ["DataFrameGroupBy", "SeriesGroupBy", "group_frame", "group_series"]

_DATAFRAME_NAMES = frozenset([
    'agg', 'aggregate', 'all', 'any', 'apply', 'bfill', 'boxplot', 'corr', 'corrwith', 'count', 'cov', 'cumcount',
    'cummax', 'cummin', 'cumprod', 'cumsum', 'describe', 'diff', 'ewm', 'expanding', 'ffill', 'filter', 'first',
    'get_group', 'groups', 'head', 'hist', 'idxmax', 'idxmin', 'indices', 'keys', 'kurt', 'last', 'level', 'max',
    'mean', 'median', 'min', 'ndim', 'ngroup', 'ngroups', 'nth', 'nunique', 'ohlc', 'pct_change', 'pipe', 'plot',
    'prod', 'quantile', 'rank', 'resample', 'rolling', 'sample', 'sem', 'shift', 'size', 'skew', 'std', 'sum', 'tail',
    'take', 'transform', 'value_counts', 'var'])
_SERIES_NAMES = _DATAFRAME_NAMES - {'boxplot', 'corrwith'} | {
    'dtype', 'is_monotonic_decreasing', 'is_monotonic_increasing', 'nlargest', 'nsmallest', 'unique'}
_REDUCTIONS = ("sum", "mean", "min", "max", "count", "size", "std", "var", "median")


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _scalar(x):
    return x[()] if isinstance(x, np.ndarray) else x


def _f32(x):
    # (one float32 operation: the double result of two float32 operands rounded once, as float32 arithmetic)
    return float(np.float32(x))


class _Groups(object):
    """The grouping: each group's key and row positions, in result order."""

    __slots__ = ("keys", "positions", "key_col", "name", "monotonic")

    def __init__(self, key_col, name, sort, dropna):
        raw = key_col.tolist()
        missing = key_col.isna().tolist()
        slot, keys, positions = {}, [], []
        na_rows = []
        for i, (v, m) in enumerate(zip(raw, missing)):
            if m:
                na_rows.append(i)
                continue
            k = slot.get(v)
            if k is None:
                k = slot[v] = len(keys)
                keys.append(i)
                positions.append([])
            positions[k].append(i)
        order = list(range(len(keys)))
        if sort:
            vals = [raw[i] for i in keys]
            try:
                order.sort(key=lambda k: vals[k])
            except TypeError:
                raise _unsupported("groupby of keys of mixed types (pandas sorts them its own way)") from None
        self.keys = [keys[k] for k in order]
        self.positions = [positions[k] for k in order]
        if na_rows and not dropna:
            self.keys.append(na_rows[0])
            self.positions.append(na_rows)
        self.key_col = key_col
        self.name = name
        # (pandas' is_monotonic: the rows' group numbers, -1 for a dropped key, never decreasing)
        ids = [-1] * len(raw)
        for g, p in enumerate(self.positions):
            for i in p:
                ids[i] = g
        self.monotonic = all(ids[i] <= ids[i + 1] for i in range(len(ids) - 1))

    def index(self):
        return Index(self.key_col.take(self.keys), name=self.name)


# --- one column's reductions ------------------------------------------------

def _kahan(values, positions, f32):
    # (pandas' group_sum/group_mean: Kahan compensation per group, a non-finite compensation reset to 0)
    out_sum, nobs = [], []
    for pos in positions:
        sumx = comp = 0.0
        n = 0
        for i in pos:
            val = values[i]
            if val != val:
                continue
            n += 1
            if f32:
                y = _f32(val - comp)
                t = _f32(sumx + y)
                comp = _f32(_f32(t - sumx) - y)
            else:
                y = val - comp
                t = sumx + y
                comp = t - sumx - y
            if comp != comp or comp in (float("inf"), float("-inf")):
                comp = 0.0
            sumx = t
        out_sum.append(sumx)
        nobs.append(n)
    return out_sum, nobs


def _int_sum_column(col, sums):
    d = col.dtype
    if d == "bool":
        return Column("int64", np.array(sums, dtype=np.int64))
    info = np.iinfo(d)
    if all(info.min <= s <= info.max for s in sums):
        return Column(d, np.array(sums, dtype=d))
    if d.startswith("u"):
        raise _unsupported("groupby sum of %s beyond its range (pandas gives uint64)" % d)
    return Column("int64", np.array(sums, dtype=np.int64))


def _segments(col, groups, op, min_count, block_nan):
    # (pandas' _reduceat_aggregate: each group a run of rows; numpy's reduction of each run)
    d = col.dtype
    v = col._pd_values
    if op == "mean":
        work = "float64"
    elif op == "sum" and (d in INTS or d == "bool"):
        work = "uint64" if d.startswith("u") else "int64"
    else:
        work = d
    res = []
    for p in groups.positions:
        seg = v[p[0]:p[-1] + 1].astype(work)
        if op in ("sum", "mean"):
            # (numpy's reduceat: a run's first value, plus the pairwise sum of the rest)
            r = _scalar(seg[0] + _scalar(seg[1:].sum())) if len(seg) > 1 else _scalar(seg[0])
            res.append(float(r) / len(p) if op == "mean" else r)
        else:
            res.append(_scalar(seg.min() if op == "min" else seg.max()))
    if op == "mean":
        return Column("float64", np.array(res, dtype=np.float64))
    if op == "sum":
        if min_count > 0 and any(len(p) < min_count for p in groups.positions):
            vals = [float(r) if len(p) >= min_count else float("nan") for r, p in zip(res, groups.positions)]
            return Column("float64", np.array(vals, dtype=np.float64))
        if d in INTS or d == "bool":
            return _int_sum_column(col, [int(r) for r in res])
        return Column(d, np.array([float(r) for r in res], dtype=d))
    if d == "bool":
        return Column("bool", np.array([bool(r) for r in res], dtype=bool))
    return Column(d, np.array(res, dtype=d))


def fast_path(col, groups, op, block_nan):
    """Whether pandas 3.1 takes its reduceat path for this column."""
    return (op in ("sum", "mean", "min", "max") and groups.monotonic and bool(groups.positions)
            and (col.dtype in INTS or col.dtype in FLOATS or col.dtype == "bool")
            and not (col.dtype in FLOATS and block_nan))


def _welford(values, positions, f32, ddof, skipna, std):
    # (pandas' group_var: Welford's update per group; NaN where a group has no more values than ddof, or, with
    # skipna=False, any missing value. For a float32 column pandas 3.1 runs var in float32 arithmetic, and std in
    # float64, its square root correctly rounded: measured, each matching pandas bit for bit)
    rnd = _f32 if (f32 and not std) else float
    out = []
    for pos in positions:
        nobs = 0
        mean = acc = 0.0
        missing = False
        for i in pos:
            val = values[i]
            if val != val:
                missing = True
                continue
            nobs += 1
            oldmean = mean
            mean = rnd(mean + rnd(rnd(val - oldmean) / nobs))
            acc = rnd(acc + rnd(rnd(val - mean) * rnd(val - oldmean)))
        if (missing and not skipna) or nobs <= ddof:
            out.append(float("nan"))
            continue
        v = rnd(acc / rnd(nobs - ddof))
        out.append((math.sqrt(v) if v >= 0 else float("nan")) if std else v)
    return out


def _median(values, positions, skipna):
    # (pandas' group_median_float64: the middle value of the group's values present, or the mean of the two
    # middle ones, in float64)
    out = []
    for pos in positions:
        present = sorted(values[i] for i in pos if values[i] == values[i])
        if not present or (not skipna and len(present) < len(pos)):
            out.append(float("nan"))
            continue
        n = len(present)
        out.append(present[n // 2] if n % 2 else (present[n // 2] + present[n // 2 - 1]) / 2)
    return out


def _fits32(res):
    # (pandas' maybe_downcast_numeric for a float32 column's float64 result: float32 only if every value, cast,
    # stays within 5e-4 of it (absolute), NaN matching NaN and an infinity its own sign)
    for r in res:
        c = _f32(r)
        if r != r:
            continue
        if c == r or abs(c - r) <= 5e-4:
            continue
        return False
    return True


def _spread_values(col, groups, op, owner, ddof, skipna):
    """(op per group as floats, whether float64 work needs the float32
    check): std and median of a float32 column run in float64."""
    d = col.dtype
    if d is DT:
        raise _unsupported("%s.%s of a datetime64[us] column" % (owner, op))
    if d is STR:
        raise TypeError("dtype 'str' does not support operation '%s'" % op)
    if not (d in INTS or d in FLOATS or d == "bool"):
        raise _unsupported("%s.%s of an object column" % (owner, op))
    f32 = d == "float32"
    values = col._pd_values.astype(np.float64).tolist()
    if op == "median":
        res = _median(values, groups.positions, skipna)
    else:
        res = _welford(values, groups.positions, f32, ddof, skipna, op == "std")
    return res, f32 and op != "var"


def _ddof(ddof):
    # (pandas passes ddof to its Cython group_var as a C int64: an integer as it is, a float truncated toward 0,
    # anything else a TypeError)
    if isinstance(ddof, (bool, int, np.integer)):
        v = int(ddof)
    elif isinstance(ddof, (float, np.floating)):
        v = int(float(ddof))
    else:
        raise TypeError("an integer is required")
    if not -2 ** 63 <= v < 2 ** 63:
        raise OverflowError("Python int too large to convert to C long")
    return v


def spread_columns(cols, groups, op, owner, ddof=1, skipna=True):
    """std, var or median of each column, as Columns. pandas computes a
    float32 column's std and median in float64, then casts its whole block
    (here: the columns given, all of the float32 ones) back to float32 only
    when every value fits (_fits32)."""
    ddof = _ddof(ddof)
    done = [_spread_values(c, groups, op, owner, ddof, skipna) for c in cols]
    to32 = all(_fits32(res) for res, check in done if check)
    out = []
    for c, (res, check) in zip(cols, done):
        d = "float32" if c.dtype == "float32" and (to32 or not check) else "float64"
        out.append(Column(d, np.array(res, dtype=d)))
    return out


def reduce_groups(col, groups, op, owner, min_count=0, block_nan=None, ddof=1, skipna=True):
    """One column's op per group, as a Column in group order. block_nan:
    whether the column's pandas block (its frame's columns of that float
    dtype) holds a missing value; the column's own when None."""
    d = col.dtype
    pos = groups.positions
    if op in ("std", "var", "median"):
        return spread_columns([col], groups, op, owner, ddof, skipna)[0]
    if block_nan is None:
        block_nan = d in FLOATS and bool(col.isna().any())
    if fast_path(col, groups, op, block_nan):
        return _segments(col, groups, op, min_count, block_nan)
    if op == "size":
        return Column("int64", np.array([len(p) for p in pos], dtype=np.int64))
    if op == "count":
        miss = col.isna().tolist()
        return Column("int64", np.array([sum(1 for i in p if not miss[i]) for p in pos], dtype=np.int64))
    if d is DT:
        raise _unsupported("%s.%s of a datetime64[us] column" % (owner, op))
    if d in FLOATS or (op == "mean" and (d in INTS or d == "bool")):
        f32 = d == "float32"
        values = col._pd_values.astype(np.float64).tolist()
        if op in ("sum", "mean"):
            sums, nobs = _kahan(values, pos, f32)
            out_type = "float32" if f32 else "float64"
            if op == "sum":
                res = [s if n >= min_count else float("nan") for s, n in zip(sums, nobs)]
            else:
                res = [((_f32(s / n) if f32 else s / n) if n else float("nan")) for s, n in zip(sums, nobs)]
            return Column(out_type, np.array(res, dtype=out_type))
        # (min, max: missing values skipped, NaN for a group without any)
        res = []
        for p in pos:
            present = [values[i] for i in p if values[i] == values[i]]
            res.append((min(present) if op == "min" else max(present)) if present else float("nan"))
        return Column(d, np.array(res, dtype=d))
    if d in INTS or d == "bool":
        values = col._pd_values.tolist()
        if op == "sum":
            return _int_sum_column(col, [sum(int(values[i]) for i in p) for p in pos])
        res = [(min if op == "min" else max)(values[i] for i in p) for p in pos]
        return Column(d, np.array(res, dtype=d))
    # (str and object: Python values, missing ones skipped)
    values = col._pd_values
    if op == "mean":
        if d is STR:
            raise TypeError("dtype 'str' does not support operation 'mean'")
        raise _unsupported("%s.mean of an object column" % owner)
    res = []
    for p in pos:
        present = [values[i] for i in p if not is_missing(values[i])]
        if op == "sum":
            if d is STR:
                res.append("".join(present))
            elif not present:
                res.append(0)
            else:
                total = present[0]
                for v in present[1:]:
                    total = total + v
                res.append(total)
        else:
            res.append((min(present) if op == "min" else max(present)) if present else float("nan"))
    return Column(d, res) if d is STR else column_from(res)


def _numeric(col):
    return col.dtype in INTS or col.dtype in FLOATS or col.dtype == "bool"


# --- the groupby objects ------------------------------------------------------

class _GroupBy(object):
    __slots__ = ("_pd_obj", "_pd_groups", "_pd_as_index")
    _pd_kind = "GroupBy"

    def __repr__(self):
        return "<pandas.api.typing.%s object at %s>" % (self._pd_kind, hex(id(self)))

    def __len__(self):
        return len(self._pd_groups.keys)

    @property
    def ngroups(self):
        return len(self._pd_groups.keys)

    def __iter__(self):
        g = self._pd_groups
        labels = g.key_col.take(g.keys).tolist()
        for lab, p in zip(labels, g.positions):
            yield lab, self._pd_obj._pd_take_rows(p)

    def get_group(self, name):
        g = self._pd_groups
        labels = g.key_col.take(g.keys).tolist()
        for lab, p in zip(labels, g.positions):
            if lab == name:
                return self._pd_obj._pd_take_rows(p)
        raise KeyError(name)

    def _pd_agg_one(self, func):
        if isinstance(func, str):
            if func not in _REDUCTIONS:
                if func in self._pd_names():
                    raise _unsupported("%s.agg(%r)" % (self._pd_kind, func))
                raise AttributeError("'%s' object has no attribute '%s'" % (self._pd_kind, func))
            return func
        name = _NUMPY_NAMES.get(func)
        if name is not None:
            return name
        if callable(func):
            return func
        raise _unsupported("%s.agg of a %s" % (self._pd_kind, type(func).__name__))

    def __getattr__(self, name):
        if not name.startswith("_"):
            if name in self._pd_names():
                raise unsupported_name("%s.%s" % (self._pd_kind, name))
        raise AttributeError("'%s' object has no attribute '%s'" % (self._pd_kind, name))


_NUMPY_NAMES = {np.sum: "sum", np.mean: "mean", np.min: "min", np.max: "max"}


def _func_name(f):
    n = f if isinstance(f, str) else f.__name__
    return n


class SeriesGroupBy(_GroupBy):
    """A Series grouped by one key."""

    __slots__ = ()
    _pd_kind = "SeriesGroupBy"

    def _pd_names(self):
        return _SERIES_NAMES

    def _pd_result(self, col, name=None):
        from ._pd_series import Series
        from ._pd_frame import DataFrame
        g = self._pd_groups
        s = self._pd_obj
        if not self._pd_as_index:
            return DataFrame._pd_new([g.key_col.take(g.keys), col], Index([g.name, s.name if name is None else name]),
                                     default_index(len(g.keys)))
        return Series._pd_new(col, g.index(), s.name if name is None else name)

    def _pd_reduce(self, op, min_count=0):
        return self._pd_result(reduce_groups(self._pd_obj._pd_col, self._pd_groups, op, "SeriesGroupBy", min_count))

    def _pd_apply(self, func):
        from ._pd_series import Series
        s = self._pd_obj
        out = []
        for p in self._pd_groups.positions:
            out.append(func(Series._pd_new(s._pd_col.take(p), s._pd_index._pd_take(p), s.name)))
        return column_from(out)

    def size(self):
        return self._pd_reduce("size")

    def count(self):
        return self._pd_reduce("count")

    def _pd_spread(self, op, ddof, skipna, engine, engine_kwargs):
        if engine is not None or engine_kwargs is not None:
            raise _unsupported("SeriesGroupBy.%s(engine=, engine_kwargs=)" % op)
        return self._pd_result(reduce_groups(self._pd_obj._pd_col, self._pd_groups, op, "SeriesGroupBy",
                                             ddof=ddof, skipna=skipna))

    def std(self, ddof=1, engine=None, engine_kwargs=None, numeric_only=False, skipna=True):
        """Each group's standard deviation (pandas' Welford update; see _pd_groupby)."""
        return self._pd_spread("std", ddof, skipna, engine, engine_kwargs)

    def var(self, ddof=1, engine=None, engine_kwargs=None, numeric_only=False, skipna=True):
        """Each group's variance (pandas' Welford update; see _pd_groupby)."""
        return self._pd_spread("var", ddof, skipna, engine, engine_kwargs)

    def median(self, numeric_only=False, skipna=True):
        """Each group's median (the middle value, or the mean of the two middle ones)."""
        return self._pd_spread("median", 1, skipna, None, None)

    def sum(self, numeric_only=False, min_count=0, **kwargs):
        if kwargs:
            raise _unsupported("SeriesGroupBy.sum(%s=)" % ", ".join(sorted(kwargs)))
        return self._pd_reduce("sum", min_count)

    def mean(self, numeric_only=False, **kwargs):
        if kwargs:
            raise _unsupported("SeriesGroupBy.mean(%s=)" % ", ".join(sorted(kwargs)))
        return self._pd_reduce("mean")

    def min(self, numeric_only=False, min_count=-1, **kwargs):
        if kwargs or min_count != -1:
            raise _unsupported("SeriesGroupBy.min(min_count=, engine=)")
        return self._pd_reduce("min")

    def max(self, numeric_only=False, min_count=-1, **kwargs):
        if kwargs or min_count != -1:
            raise _unsupported("SeriesGroupBy.max(min_count=, engine=)")
        return self._pd_reduce("max")

    def agg(self, func=None, *args, **kwargs):
        """A reduction's name (or numpy's sum/mean/min/max), a function of each
        group's Series, a list of them (a frame of one column each), or
        name=func keywords."""
        from ._pd_frame import DataFrame
        if args:
            raise _unsupported("SeriesGroupBy.agg(*args)")
        if func is None:
            if not kwargs:
                raise TypeError("Must provide 'func' or named aggregation **kwargs.")
            names, funcs = list(kwargs), list(kwargs.values())
        elif kwargs:
            raise _unsupported("SeriesGroupBy.agg(func, **kwargs)")
        elif isinstance(func, (list, tuple)):
            names, funcs = [_func_name(f) for f in func], list(func)
        elif isinstance(func, dict):
            raise _unsupported("SeriesGroupBy.agg(a dict)")
        else:
            f = self._pd_agg_one(func)
            if isinstance(f, str):
                return self._pd_reduce(f)
            return self._pd_result(self._pd_apply(f))
        cols = []
        for f in funcs:
            f = self._pd_agg_one(f)
            cols.append(reduce_groups(self._pd_obj._pd_col, self._pd_groups, f, "SeriesGroupBy") if isinstance(f, str)
                        else self._pd_apply(f))
        g = self._pd_groups
        if not self._pd_as_index:
            raise _unsupported("SeriesGroupBy.agg(a list) with as_index=False")
        return DataFrame._pd_new(cols, Index(names), g.index())

    aggregate = agg


class DataFrameGroupBy(_GroupBy):
    """A DataFrame grouped by one key; [col] gives a SeriesGroupBy, [[cols]]
    a DataFrameGroupBy of those columns."""

    __slots__ = ("_pd_cols",)
    _pd_kind = "DataFrameGroupBy"

    def _pd_names(self):
        return _DATAFRAME_NAMES

    def __getitem__(self, key):
        f = self._pd_obj
        labels = list(key) if isinstance(key, list) else [key]
        for lab in labels:
            if lab not in f.columns:
                raise KeyError("Column not found: %s" % (lab,))
        if isinstance(key, list):
            out = DataFrameGroupBy.__new__(DataFrameGroupBy)
            out._pd_obj, out._pd_groups, out._pd_as_index = f, self._pd_groups, self._pd_as_index
            out._pd_cols = [f.columns._pd_positions(lab) for lab in labels]
            return out
        p = f.columns._pd_positions(key)
        if isinstance(p, list):
            raise _unsupported("DataFrameGroupBy[a repeated column label]")
        out = SeriesGroupBy.__new__(SeriesGroupBy)
        out._pd_obj, out._pd_groups, out._pd_as_index = f._pd_column_series(p), self._pd_groups, self._pd_as_index
        return out

    def __getattr__(self, name):
        if not name.startswith("_") and name not in _DATAFRAME_NAMES:
            if name in self._pd_obj.columns:
                return self[name]
        return _GroupBy.__getattr__(self, name)

    def _pd_frame(self, cols, js):
        from ._pd_frame import DataFrame
        g = self._pd_groups
        f = self._pd_obj
        labels = f.columns._pd_take(js)
        if not self._pd_as_index:
            return DataFrame._pd_new([g.key_col.take(g.keys)] + cols, Index([g.name] + labels.tolist()),
                                     default_index(len(g.keys)))
        return DataFrame._pd_new(cols, labels, g.index())

    def _pd_reduce(self, op, numeric_only=False, min_count=0):
        f = self._pd_obj
        js = [j for j in self._pd_cols if not numeric_only or _numeric(f._pd_cols[j])]
        if op in ("std", "var", "median"):
            return self._pd_frame(spread_columns([f._pd_cols[j] for j in js], self._pd_groups, op, "DataFrameGroupBy"), js)
        # (pandas checks for NaN over a whole block: the frame's columns of one float dtype)
        nan_in = {}
        for j in js:
            c = f._pd_cols[j]
            if c.dtype in FLOATS:
                nan_in[c.dtype] = nan_in.get(c.dtype, False) or bool(c.isna().any())
        cols = [reduce_groups(f._pd_cols[j], self._pd_groups, op, "DataFrameGroupBy", min_count,
                              nan_in.get(f._pd_cols[j].dtype, False)) for j in js]
        return self._pd_frame(cols, js)

    def size(self):
        from ._pd_series import Series
        from ._pd_frame import DataFrame
        g = self._pd_groups
        col = Column("int64", np.array([len(p) for p in g.positions], dtype=np.int64))
        if not self._pd_as_index:
            return DataFrame._pd_new([g.key_col.take(g.keys), col], Index([g.name, "size"]), default_index(len(g.keys)))
        return Series._pd_new(col, g.index(), None)

    def count(self):
        return self._pd_reduce("count")

    def _pd_spread(self, op, ddof, skipna, numeric_only, engine, engine_kwargs):
        if engine is not None or engine_kwargs is not None:
            raise _unsupported("DataFrameGroupBy.%s(engine=, engine_kwargs=)" % op)
        f = self._pd_obj
        js = [j for j in self._pd_cols if not numeric_only or _numeric(f._pd_cols[j])]
        cols = spread_columns([f._pd_cols[j] for j in js], self._pd_groups, op, "DataFrameGroupBy", ddof, skipna)
        return self._pd_frame(cols, js)

    def std(self, ddof=1, engine=None, engine_kwargs=None, numeric_only=False, skipna=True):
        """Each group's standard deviation per column (pandas' Welford update)."""
        return self._pd_spread("std", ddof, skipna, numeric_only, engine, engine_kwargs)

    def var(self, ddof=1, engine=None, engine_kwargs=None, numeric_only=False, skipna=True):
        """Each group's variance per column (pandas' Welford update)."""
        return self._pd_spread("var", ddof, skipna, numeric_only, engine, engine_kwargs)

    def median(self, numeric_only=False, skipna=True):
        """Each group's median per column."""
        return self._pd_spread("median", 1, skipna, numeric_only, None, None)

    def sum(self, numeric_only=False, min_count=0, **kwargs):
        if kwargs:
            raise _unsupported("DataFrameGroupBy.sum(%s=)" % ", ".join(sorted(kwargs)))
        return self._pd_reduce("sum", numeric_only, min_count)

    def mean(self, numeric_only=False, **kwargs):
        if kwargs:
            raise _unsupported("DataFrameGroupBy.mean(%s=)" % ", ".join(sorted(kwargs)))
        return self._pd_reduce("mean", numeric_only)

    def min(self, numeric_only=False, min_count=-1, **kwargs):
        if kwargs or min_count != -1:
            raise _unsupported("DataFrameGroupBy.min(min_count=, engine=)")
        return self._pd_reduce("min", numeric_only)

    def max(self, numeric_only=False, min_count=-1, **kwargs):
        if kwargs or min_count != -1:
            raise _unsupported("DataFrameGroupBy.max(min_count=, engine=)")
        return self._pd_reduce("max", numeric_only)

    def agg(self, func=None, *args, **kwargs):
        """A reduction's name or a function for every column, a dict of
        column -> one of those, or name=(column, func) keywords. A list (or a
        dict of lists) needs MultiIndex columns: it raises."""
        if args:
            raise _unsupported("DataFrameGroupBy.agg(*args)")
        f = self._pd_obj
        if func is None:
            if not kwargs:
                raise TypeError("Must provide 'func' or named aggregation **kwargs.")
            specs = []
            for name, spec in kwargs.items():
                if not isinstance(spec, tuple) or len(spec) != 2:
                    raise TypeError("func is expected but received %s in **kwargs." % type(spec).__name__)
                specs.append((name, spec[0], spec[1]))
            missing = [c for _, c, _ in specs if c not in f.columns]
            if missing:
                raise KeyError("Label(s) %r do not exist" % (missing,))
            cols = [self[c]._pd_column_of(fn) for _, c, fn in specs]
            return self._pd_named([n for n, _, _ in specs], cols)
        if kwargs:
            raise _unsupported("DataFrameGroupBy.agg(func, **kwargs)")
        if isinstance(func, dict):
            missing = [c for c in func if c not in f.columns]
            if missing:
                raise KeyError("Label(s) %r do not exist" % (missing,))
            if any(isinstance(v, (list, tuple, dict)) for v in func.values()):
                raise _unsupported("DataFrameGroupBy.agg(a dict of lists) (MultiIndex columns)")
            js = [f.columns._pd_positions(c) for c in func]
            if any(isinstance(j, list) for j in js):
                raise _unsupported("DataFrameGroupBy.agg of a repeated column label")
            cols = [self[c]._pd_column_of(fn) for c, fn in func.items()]
            return self._pd_frame(cols, js)
        if isinstance(func, (list, tuple)):
            raise _unsupported("DataFrameGroupBy.agg(a list) (MultiIndex columns)")
        one = self._pd_agg_one(func)
        if isinstance(one, str):
            return self._pd_reduce(one)
        js = list(self._pd_cols)
        return self._pd_frame([self._pd_series_groupby(j)._pd_column_of(one) for j in js], js)

    def _pd_series_groupby(self, j):
        out = SeriesGroupBy.__new__(SeriesGroupBy)
        out._pd_obj, out._pd_groups, out._pd_as_index = self._pd_obj._pd_column_series(j), self._pd_groups, self._pd_as_index
        return out

    aggregate = agg

    def _pd_named(self, names, cols):
        from ._pd_frame import DataFrame
        g = self._pd_groups
        if not self._pd_as_index:
            return DataFrame._pd_new([g.key_col.take(g.keys)] + cols, Index([g.name] + names), default_index(len(g.keys)))
        return DataFrame._pd_new(cols, Index(names), g.index())


def _column_of(self, func):
    f = self._pd_agg_one(func)
    if isinstance(f, str):
        return reduce_groups(self._pd_obj._pd_col, self._pd_groups, f, "SeriesGroupBy")
    return self._pd_apply(f)


SeriesGroupBy._pd_column_of = _column_of


def _key_column(obj, by, level, owner):
    """The key as (a Column of one key per row, its name, the column
    positions it takes out of a frame's aggregation)."""
    from ._pd_series import Series
    from ._pd_index import RangeIndex
    n = len(obj)
    if level is not None:
        if by is not None:
            raise TypeError("'by' and 'level' cannot both be specified")
        if level not in (0, obj.index.name) or isinstance(level, (list, tuple)):
            raise _unsupported("%s(level=) other than the index itself" % owner)
        return obj.index._pd_column(), obj.index.name, []
    if by is None:
        raise TypeError("You have to supply one of 'by' and 'level'")
    if isinstance(by, list) and len(by) == 1 and not isinstance(by[0], (list, Series)) and _label_in_frame(obj, by[0]):
        by = by[0]
    if isinstance(by, Series):
        if len(by) != n or not by.index.equals(obj.index):
            raise _unsupported("%s by a Series with other labels" % owner)
        return by._pd_col, by.name, []
    if isinstance(by, (list, np.ndarray)):
        if len(by) != n:
            raise _unsupported("%s by several keys (a MultiIndex)" % owner)
        return column_from(list(by) if isinstance(by, list) else by), None, []
    if callable(by) or isinstance(by, (tuple, dict, set)):
        raise _unsupported("%s by a %s" % (owner, type(by).__name__))
    from ._pd_frame import DataFrame
    if isinstance(obj, DataFrame):
        if by in obj.columns:
            p = obj.columns._pd_positions(by)
            if isinstance(p, list):
                raise ValueError("Grouper for '%s' not 1-dimensional" % (by,))
            return obj._pd_cols[p], by, [p]
        if obj.index.name is not None and by == obj.index.name:
            return obj.index._pd_column(), by, []
    elif obj.index.name is not None and by == obj.index.name:
        return obj.index._pd_column(), by, []
    raise KeyError(by)


def _label_in_frame(obj, label):
    # (a one-element list of a column label groups by that column)
    from ._pd_frame import DataFrame
    return isinstance(obj, DataFrame) and label in obj.columns


def _check(as_index, sort, group_keys, observed, dropna, owner):
    if observed is not True or group_keys is not True:
        raise _unsupported("%s(observed=, group_keys=)" % owner)


def group_frame(frame, by, level, as_index, sort, group_keys, observed, dropna):
    _check(as_index, sort, group_keys, observed, dropna, "DataFrame.groupby")
    if isinstance(by, list) and len(by) > 1:
        raise _unsupported("DataFrame.groupby by several keys (a MultiIndex)")
    col, name, taken = _key_column(frame, by, level, "DataFrame.groupby")
    g = DataFrameGroupBy.__new__(DataFrameGroupBy)
    g._pd_obj, g._pd_groups, g._pd_as_index = frame, _Groups(col, name, sort, dropna), as_index
    g._pd_cols = [j for j in range(len(frame._pd_cols)) if j not in taken]
    return g


def group_series(s, by, level, as_index, sort, group_keys, observed, dropna):
    _check(as_index, sort, group_keys, observed, dropna, "Series.groupby")
    if not as_index:
        raise TypeError("as_index=False only valid with DataFrame")
    col, name, _ = _key_column(s, by, level, "Series.groupby")
    g = SeriesGroupBy.__new__(SeriesGroupBy)
    g._pd_obj, g._pd_groups, g._pd_as_index = s, _Groups(col, name, sort, dropna), as_index
    return g
