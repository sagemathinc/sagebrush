"""describe and corr, as pandas 3.1.0 computes them, ported from
pandas/core/methods/describe.py, pandas/core/nanops.py,
pandas/io/formats/format.py and pandas/_libs/algos.pyx (BSD-3-Clause, see
_pd_license.py and NOTICE.md):

- describe of a numeric column: count; mean as nanops' sum (missing values
  filled with 0 in place, so numpy's pairwise sum groups as pandas') over
  the count; std with ddof=1 from the same mean; min; numpy's linear
  quantiles of the values present; max. Of any other column: count,
  unique, top (the most frequent value, the first to appear on a tie) and
  freq.
- DataFrame.corr (Pearson): libalgos.nancorr, Welford's updates over the
  rows where both columns are finite, in the same order, so the same
  floats; a constant column gives NaN. Series.corr: nanops' _pearson_corr
  with numpy (centred, scaled, np.dot).
"""

import math

import numpy as np

from ._pd_column import Column, column_from
from ._pd_dtypes import STR, INTS, FLOATS, is_missing
from ._pd_datetime import DT
from . import _pd_combine as CB

__all__ = ["refine_percentiles", "format_percentiles", "describe_column", "describe_values", "is_numeric",
           "select_columns", "check_method", "float_columns", "nancorr", "callable_corr", "series_corr"]


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _scalar(x):
    # (Sagebrush's numpy returns a 0-d array where NumPy returns a scalar)
    return x[()] if isinstance(x, np.ndarray) else x


def is_numeric(dtype):
    """describe's numeric columns: the integers and the floats (bool is
    described as categories)."""
    return dtype in INTS or dtype in FLOATS


# --- percentiles -------------------------------------------------------------

def refine_percentiles(percentiles):
    """describe's percentiles: 25%, 50% and 75% by default, else the ones
    given, sorted, each in [0, 1] and none twice."""
    if percentiles is None:
        return [0.25, 0.5, 0.75]
    ps = [float(p) for p in (list(percentiles) if not isinstance(percentiles, (int, float)) else [percentiles])]
    if not all(0 <= p <= 1 for p in ps):
        raise ValueError("percentiles should all be in the interval [0, 1]")
    unique = sorted(set(ps))
    if len(unique) < len(ps):
        raise ValueError("percentiles cannot contain duplicates")
    return unique


def _round(x, prec):
    # (numpy's round: x * 10**prec rounded half to even, divided back)
    f = 10.0 ** prec
    return float(round(x * f)) / f


def _precision(array):
    to_begin = [array[0]] if array[0] > 0 else []
    to_end = [100 - array[-1]] if array[-1] < 100 else []
    diff = [abs(d) for d in to_begin + [array[i + 1] - array[i] for i in range(len(array) - 1)] + to_end]
    prec = -int(math.floor(math.log10(min(diff))))
    return max(1, prec)


def _isclose(a, b):
    return abs(a - b) <= 1e-08 + 1e-05 * abs(b)


def format_percentiles(percentiles):
    """The row labels of percentiles: '25%', or with as many decimals as
    tell them apart ('33.3%', '0.01%'), as pandas' format_percentiles."""
    if not percentiles:
        return []
    pcts = [100 * p for p in percentiles]
    prec = _precision(pcts)
    as_int = [int(_round(x, prec)) for x in pcts]
    int_idx = [_isclose(r, x) for r, x in zip(as_int, pcts)]
    if all(int_idx):
        return ["%d%%" % r for r in as_int]
    prec = _precision(sorted(set(pcts)))
    return [("%d" % int(round(x)) if ok else repr(_round(x, prec))) + "%" for x, ok in zip(pcts, int_idx)]


def _quantile(values, q):
    # (numpy's quantile, method 'linear', of sorted values: its virtual index and lerp)
    n = len(values)
    virtual = (n - 1) * q
    if virtual >= n - 1:
        return values[-1]
    if virtual < 0:
        return values[0]
    prev = math.floor(virtual)
    gamma = virtual - prev
    a, b = values[int(prev)], values[int(prev) + 1]
    diff = b - a
    if gamma >= 0.5:
        return b - diff * (1 - gamma)
    return a + diff * gamma


# --- describe ----------------------------------------------------------------

def _quantile32(values, q, cast):
    # (numpy's quantile of float32 values: the two neighbours' difference in float32, the lerp in float64; cast:
    # back to float32, as pandas' masked path does)
    n = len(values)
    virtual = (n - 1) * q
    if virtual >= n - 1 or virtual < 0:
        return values[-1] if virtual >= n - 1 else values[0]
    prev = math.floor(virtual)
    gamma = virtual - prev
    a, b = values[int(prev)], values[int(prev) + 1]
    diff = float(np.float32(b) - np.float32(a))
    r = b - diff * (1 - gamma) if gamma >= 0.5 else a + diff * gamma
    return float(np.float32(r)) if cast else r


def _numeric_stats32(col, qs):
    # (pandas' nanops for float32: the mean summed in float32 over a float32 count; the variance in float64 from
    # sum(dtype=float64), cast to float32 before its square root; min, max and the percentiles float32)
    v = col._pd_values
    mask = v != v
    count = len(v) - int(_scalar(mask.sum()))
    nan = float("nan")
    if count == 0:
        return [0.0, nan, nan, nan] + [nan] * len(qs) + [nan]
    filled = v.copy()
    filled[mask] = 0.0
    c32 = np.float32(count)
    mean = float(np.float32(_scalar(filled.sum())) / c32)
    if count <= 1:
        std = nan
    else:
        avg = float(_scalar(filled.sum(dtype=np.float64))) / float(c32)
        d = avg - filled.astype(np.float64)
        sqr = d * d
        sqr[mask] = 0.0
        var = float(_scalar(sqr.sum())) / float(np.float32(count - 1))
        std = float(np.sqrt(np.float32(var)))
    lo = v.copy()
    lo[mask] = float("inf")
    hi = v.copy()
    hi[mask] = float("-inf")
    present = sorted(x for x, m in zip(v.tolist(), mask.tolist()) if not m)
    # (with a missing value pandas' masked path casts the percentiles back to float32; without one numpy's float64
    # result stands)
    quantiles = [_quantile32(present, q, count < len(v)) for q in qs]
    return [float(count), mean, std, float(_scalar(lo.min()))] + quantiles + [float(_scalar(hi.max()))]


def _numeric_stats(col, qs):
    if col.dtype == "float32":
        return _numeric_stats32(col, qs)
    v = col._pd_values
    if col.dtype == "float64":
        mask = v != v
        vals = v
    else:
        mask = np.zeros(len(v), dtype=bool)
        vals = v.astype(np.float64)
    n = len(vals)
    count = n - int(_scalar(mask.sum()))
    nan = float("nan")
    if count == 0:
        return [0.0, nan, nan, nan] + [nan] * len(qs) + [nan]
    filled = vals.copy()
    filled[mask] = 0.0
    total = float(_scalar(filled.sum()))
    mean = total / count
    if count <= 1:
        std = nan
    else:
        d = mean - filled
        sqr = d * d
        sqr[mask] = 0.0
        std = math.sqrt(float(_scalar(sqr.sum())) / (count - 1))
    lo = vals.copy()
    lo[mask] = float("inf")
    hi = vals.copy()
    hi[mask] = float("-inf")
    present = sorted(x for x, m in zip(vals.tolist(), mask.tolist()) if not m)
    quantiles = [_quantile(present, q) for q in qs]
    return [float(count), mean, std, float(_scalar(lo.min()))] + quantiles + [float(_scalar(hi.max()))]


def _categorical_stats(col):
    first, counts = CB.count_values(col, True)
    count = len(col) - int(_scalar(col.isna().sum()))
    if not counts:
        return [count, 0, float("nan"), float("nan")], True
    best = 0
    for k in range(1, len(counts)):
        if counts[k] > counts[best]:
            best = k
    top = col.take([first[best]]).tolist()[0]
    return [count, len(counts), top, counts[best]], False


def describe_column(col, qs, labels, owner):
    """One column's describe: (row names, values, forced object dtype)."""
    if col.dtype is DT:
        raise _unsupported("%s of a datetime64[us] column" % owner)
    if is_numeric(col.dtype):
        return ["count", "mean", "std", "min"] + labels + ["max"], _numeric_stats(col, qs), False
    values, forced = _categorical_stats(col)
    return ["count", "unique", "top", "freq"], values, forced


def describe_values(values, forced, numeric):
    """A describe result's column: float64 for a numeric one, else as pandas
    infers it (object when nothing was counted)."""
    if numeric:
        return Column("float64", np.array(values, dtype=np.float64))
    return Column("object", list(values)) if forced else column_from(values)


# --- describe's include and exclude -----------------------------------------

def _kind_of(spec):
    """What an include/exclude entry selects, as a predicate on a column's
    dtype (select_dtypes' common spellings)."""
    if spec is np.number or spec == "number":
        return is_numeric, False
    if spec is object or spec in ("object", "O"):
        return (lambda d: d == "object" or d is STR), True
    if spec is str or spec in ("str", "string"):
        return (lambda d: d is STR), False
    if spec is bool or spec is np.bool_ or spec == "bool":
        return (lambda d: d == "bool"), False
    if spec is np.integer or spec == "integer":
        return (lambda d: d in INTS), False
    if spec is np.floating or spec == "floating":
        return (lambda d: d in FLOATS), False
    if spec in ("datetime", "datetime64", "datetime64[us]", "M8[us]"):
        return (lambda d: d is DT), False
    if spec == "category":
        return (lambda d: False), False
    if spec is int:
        return (lambda d: d == "int64"), False
    if spec is float:
        return (lambda d: d == "float64"), False
    try:
        name = str(np.dtype(spec))
    except Exception:
        name = None
    if name in INTS or name in FLOATS:
        return (lambda d: d == name), False
    raise _unsupported("DataFrame.describe(include=, exclude=) with %r" % (spec,))


def _specs(x):
    return list(x) if isinstance(x, (list, tuple, set)) else [x]


def select_columns(dtypes, include, exclude):
    """The positions describe keeps for include/exclude (neither 'all'):
    those matching an include entry (any, if none is given) and no exclude
    entry; 'object' selects str too, with pandas' warning."""
    inc = [_kind_of(s) for s in _specs(include)] if include is not None else None
    exc = [_kind_of(s) for s in _specs(exclude)] if exclude is not None else []
    keep = []
    warned = False
    for j, d in enumerate(dtypes):
        if inc is not None and not any(f(d) for f, _ in inc):
            continue
        if any(f(d) for f, _ in exc):
            continue
        if inc is not None and d is STR and not warned and any(obj and f(d) for f, obj in inc) and \
                not any(f(d) and not obj for f, obj in inc):
            import warnings
            from .errors import Pandas4Warning
            warnings.warn("For backward compatibility, 'str' dtypes are included by select_dtypes when 'object' dtype "
                          "is specified. This behavior is deprecated and will be removed in a future version. Explicitly "
                          "pass 'str' to `include` to select them, or to `exclude` to remove them and silence this "
                          "warning.\nSee https://pandas.pydata.org/docs/dev/user_guide/migration.html#string-migration-"
                          "select-dtypes for details on how to write code that works with pandas 2 and 3.",
                          Pandas4Warning, stacklevel=4)
            warned = True
        keep.append(j)
    return keep


# --- corr --------------------------------------------------------------------

def check_method(method, owner):
    if method in ("pearson", "spearman", "kendall") or callable(method):
        if method in ("spearman", "kendall"):
            raise _unsupported("%s(method='%s') (a rank correlation)" % (owner, method))
        return
    raise ValueError("method must be either 'pearson', 'spearman', 'kendall', or a callable, '%s' was supplied" % (method,))


def float_columns(cols, owner):
    """Each column as a list of floats (to_numpy(dtype=float, na_value=nan)):
    numbers as they are, str values through float() column by column (as
    pandas converts its blocks), so the first failure is pandas'."""
    out = []
    for c in cols:
        if c.dtype is DT:
            raise _unsupported("%s of a datetime64[us] column" % owner)
        if c.is_list:
            out.append([float("nan") if is_missing(v) else float(v) for v in c._pd_values])
        else:
            out.append(c._pd_values.astype(np.float64).tolist())
    return out


def _finite(x):
    return x == x and x not in (float("inf"), float("-inf"))


def nancorr(mat, minp):
    """libalgos.nancorr of columns (lists of floats): a K x K list."""
    k = len(mat)
    n = len(mat[0]) if k else 0
    nan = float("nan")
    finite = [[_finite(x) for x in col] for col in mat]
    no_nans = all(all(f) for f in finite)
    out = [[nan] * k for _ in range(k)]
    for xi in range(k):
        for yi in range(xi + 1):
            nobs = 0
            ssqdmx = ssqdmy = covxy = meanx = meany = 0.0
            cx, cy, fx, fy = mat[xi], mat[yi], finite[xi], finite[yi]
            for i in range(n):
                if no_nans or (fx[i] and fy[i]):
                    vx, vy = cx[i], cy[i]
                    nobs += 1
                    dx = vx - meanx
                    dy = vy - meany
                    meanx += 1.0 / nobs * dx
                    meany += 1.0 / nobs * dy
                    ssqdmx += (vx - meanx) * dx
                    ssqdmy += (vy - meany) * dy
                    covxy += (vx - meanx) * dy
            if nobs < minp:
                val = nan
            else:
                divisor = math.sqrt(ssqdmx * ssqdmy)
                if divisor != 0:
                    val = covxy / divisor
                    if val > 1.0:
                        val = 1.0
                    elif val < -1.0:
                        val = -1.0
                else:
                    val = nan
            out[xi][yi] = out[yi][xi] = val
    return out


def callable_corr(mat, method, minp):
    """DataFrame.corr with a function of two arrays: each pair over the rows
    where both are finite, 1.0 on the diagonal."""
    k = len(mat)
    nan = float("nan")
    out = [[nan] * k for _ in range(k)]
    arrays = [np.array(c, dtype=np.float64) for c in mat]
    finite = [np.array([_finite(x) for x in c], dtype=bool) for c in mat]
    for i in range(k):
        for j in range(i, k):
            valid = finite[i] & finite[j]
            nvalid = int(_scalar(valid.sum()))
            if nvalid < minp:
                c = nan
            elif i == j:
                c = 1.0
            elif nvalid < len(valid):
                c = method(arrays[i][valid], arrays[j][valid])
            else:
                c = method(arrays[i], arrays[j])
            out[i][j] = out[j][i] = float(_scalar(c))
    return out


def pearson(a, b):
    """nanops._pearson_corr of two float arrays without missing values."""
    if len(a) < 2:
        return float("nan")
    a = a - _scalar(a.mean())
    b = b - _scalar(b.mean())
    a_scale = _scalar(np.max(np.abs(a)))
    b_scale = _scalar(np.max(np.abs(b)))
    if a_scale == 0 or b_scale == 0:
        return float("nan")
    a = a / a_scale
    b = b / b_scale
    fact = len(a) - 1
    divisor = math.sqrt(float(_scalar(np.dot(a, a))) / fact)
    if divisor == 0:
        return float("nan")
    result = float(_scalar(np.dot(a, b))) / fact / divisor
    divisor = math.sqrt(float(_scalar(np.dot(b, b))) / fact)
    if divisor == 0:
        return float("nan")
    return np.float64(min(max(result / divisor, -1.0), 1.0))


def series_corr(a, b, method, min_periods):
    """nanops.nancorr of two float lists: the pairs where both are present,
    NaN under min_periods (1 when None)."""
    if min_periods is None:
        min_periods = 1
    keep = [i for i in range(len(a)) if a[i] == a[i] and b[i] == b[i]]
    if len(keep) < len(a):
        a = [a[i] for i in keep]
        b = [b[i] for i in keep]
    if len(a) < min_periods:
        return float("nan")
    x = np.array(a, dtype=np.float64)
    y = np.array(b, dtype=np.float64)
    if callable(method):
        return method(x, y)
    return pearson(x, y)
