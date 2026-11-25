"""Reductions (sum, mean, min, max, count) and the comparisons that make
boolean masks (plan-pandas-m1-r1 §0), as pandas 3.1.0 computes them
(measured on the oracle):

- int64: sum and min/max are np.int64, mean np.float64;
- float64: NaN skipped unless skipna=False; the sum of nothing is 0.0, the
  mean, min and max of nothing NaN;
- bool: sum counts (np.int64), mean is a fraction, min/max np.bool_;
- str: sum concatenates, min/max compare, mean raises TypeError;
- count is np.int64 for every dtype.

These replace pandas/_libs and nanops routines with numpy: the float sums
use numpy's own (pairwise) summation, as pandas' nanops do.  Sagebrush's
numpy returns a 0-d array where NumPy returns a scalar (a known bug), so
each result is taken with [()].
"""

import functools
import operator

import numpy as np

from ._pd_column import Column
from ._pd_dtypes import STR, INTS, FLOATS, is_missing

__all__ = ["check_args", "reduce_column", "truth_column", "compare", "logical"]


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def check_args(name, axis, kwargs, min_count=0):
    if kwargs:
        raise _unsupported("%s(%s=)" % (name, ", ".join(sorted(kwargs))))
    if axis not in (None, 0, "index"):
        raise _unsupported("%s(axis=%r)" % (name, axis))
    if min_count != 0:
        raise _unsupported("%s(min_count=)" % name)


def _scalar(x):
    if isinstance(x, np.ndarray):
        return x[()]
    return x


_INT_SCALARS = {"int64": np.int64, "int32": np.int32, "int16": np.int16, "int8": np.int8,
                "uint32": np.uint32, "uint16": np.uint16, "uint8": np.uint8}


def truth_column(col, op, skipna):
    """Series.any / Series.all: each value's truth (numbers: nonzero; str
    and object: Python's), missing values skipped; with skipna=False every
    value is Python's bool of it, as pandas (None is False, NaN True), an
    np.bool_ as pandas gives."""
    from ._pd_datetime import DT
    if col.dtype is DT:
        raise _unsupported("Series.%s of a datetime64[us] column" % op)
    vals = col.tolist()
    miss = col.isna().tolist()
    if skipna:
        truths = [bool(v) for v, m in zip(vals, miss) if not m]
    else:
        truths = [bool(v) for v in vals]
    return np.bool_(any(truths) if op == "any" else all(truths))


def reduce_column(col, op, skipna):
    d = col.dtype
    if op == "count":
        return np.int64(int(len(col) - int(_scalar(col.isna().sum()))))
    if d in INTS or d == "bool":
        # (a smaller integer, as numpy and pandas 3.1: summed in int64, or uint64 when unsigned, averaged in float64,
        # its min/max a scalar of its own dtype)
        v = col._pd_values
        if op == "sum":
            if d.startswith("uint"):
                return np.uint64(int(_scalar(v.astype("uint64").sum())) if len(v) else 0)
            return np.int64(int(_scalar(v.astype("int64").sum())) if len(v) else 0)
        if op == "mean":
            return float("nan") if not len(v) else np.float64(float(_scalar(v.astype("float64").mean())))
        if not len(v):
            return float("nan")
        r = _scalar(v.min() if op == "min" else v.max())
        return np.bool_(bool(r)) if d == "bool" else _INT_SCALARS[d](int(r))
    if d == "float32":
        return _reduce_float32(col._pd_values, op, skipna)
    if d == "float64":
        v = col._pd_values
        if not len(v):
            return np.float64(0.0) if op == "sum" else float("nan")
        if skipna:
            v = v[~(v != v)]
            if not len(v):
                # (all missing: the sum 0.0 and min/max NaN are NumPy's; the
                # mean is a Python float, as for no values)
                if op == "mean":
                    return float("nan")
                return np.float64(0.0 if op == "sum" else float("nan"))
        elif len(v) and bool(_scalar((v != v).any())):
            return np.float64(float("nan"))
        if op == "sum":
            return np.float64(float(_scalar(v.sum())) if len(v) else 0.0)
        if not len(v):
            return float("nan")
        r = v.mean() if op == "mean" else (v.min() if op == "min" else v.max())
        return np.float64(float(_scalar(r)))
    # (str and object: Python values)
    vals = col._pd_values
    if d is STR and op == "mean":
        raise TypeError("Cannot perform reduction 'mean' with string dtype")
    if skipna:
        vals = [x for x in vals if not is_missing(x)]
    elif any(is_missing(x) for x in vals):
        return float("nan")
    if d is STR:
        if op == "mean":
            raise TypeError("Cannot perform reduction 'mean' with string dtype")
        if op == "sum":
            return "".join(vals)
    if op == "mean":
        raise NotImplementedError("pandas.Series.mean of an object Series is not in Sagebrush's pandas 0.x subset")
    if not vals:
        return float("nan") if op != "sum" else 0
    if op == "sum":
        return functools.reduce(operator.add, vals)
    return min(vals) if op == "min" else max(vals)


def _reduce_float32(v, op, skipna):
    # (pandas' nanops for float32: missing values filled in place (0 for the sum, +-inf for min/max), the sum and the
    # mean in float32 (numpy's float32 pairwise sum, then over a float32 count), each a np.float32)
    mask = v != v
    nmissing = int(_scalar(mask.sum()))
    if nmissing and not skipna:
        return np.float32(float("nan"))
    count = len(v) - nmissing
    if op == "sum":
        filled = v.copy()
        filled[mask] = 0.0
        return np.float32(_scalar(filled.sum())) if len(v) else np.float32(0.0)
    if op == "mean":
        if not count:
            return float("nan")
        filled = v.copy()
        filled[mask] = 0.0
        return np.float32(_scalar(filled.sum())) / np.float32(count)
    if not len(v):
        return float("nan")
    if not count:
        return np.float32(float("nan"))
    bound = v.copy()
    bound[mask] = float("inf") if op == "min" else float("-inf")
    return np.float32(_scalar(bound.min() if op == "min" else bound.max()))


_OPS = {
    "eq": operator.eq, "ne": operator.ne, "lt": operator.lt,
    "le": operator.le, "gt": operator.gt, "ge": operator.ge,
}


def compare(col, right, op):
    """A bool Column: col <op> right (a scalar or a Column of the same
    length).  A missing value compares False (True for ne), as pandas."""
    f = _OPS[op]
    from ._pd_datetime import DT
    if col.dtype is DT:
        return _compare_times(col, right, op, f)
    if isinstance(right, str) and op not in ("eq", "ne") and not col.is_list and (col.dtype in INTS or col.dtype in FLOATS
                                                                               or col.dtype == "bool"):
        # (pandas' message for ordering numbers against a string)
        raise TypeError("Invalid comparison between dtype=%s and str" % col.dtype)
    if not col.is_list and (not isinstance(right, Column) or not right.is_list) and not isinstance(right, str):
        rv = right._pd_values if isinstance(right, Column) else right
        if col.dtype == "float32" and isinstance(rv, (int, float)) and not isinstance(rv, bool):
            # (NumPy 2's weak promotion: a Python number compares with a float32 column as a float32)
            rv = np.float32(rv)
        if rv is None:
            return Column("bool", np.full(len(col), op == "ne", dtype=bool))
        try:
            out = f(col._pd_values, rv)
        except TypeError:
            out = False
        if np.ndim(out) == 0:
            # (numpy can't compare its numbers with this value, a Timestamp say: equal to none, and no order)
            if op in ("eq", "ne"):
                return Column("bool", np.full(len(col), op == "ne", dtype=bool))
            raise TypeError("'%s' not supported between instances of 'numpy.ndarray' and '%s'"
                            % ({"lt": "<", "le": "<=", "gt": ">", "ge": ">="}[op], type(rv).__name__))
        return Column("bool", np.asarray(out, dtype=bool))
    left = col.tolist()
    rvals = right.tolist() if isinstance(right, Column) else [right] * len(left)
    out = []
    for a, b in zip(left, rvals):
        if is_missing(a) or is_missing(b):
            out.append(op == "ne")
        else:
            try:
                out.append(bool(f(a, b)))
            except TypeError:
                if op in ("eq", "ne"):
                    out.append(op == "ne")
                else:
                    raise TypeError("'%s' not supported between instances of '%s' and '%s'"
                                    % ({"lt": "<", "le": "<=", "gt": ">", "ge": ">="}[op],
                                       type(a).__name__, type(b).__name__)) from None
    return Column("bool", np.array(out, dtype=bool))


def _compare_times(col, right, op, f):
    # (a datetime64[us] column: microseconds compared, NaT on either side comparing False, True for ne; a
    # string is parsed as pandas parses it; another value is equal to none, and ordering by it raises)
    from ._pd_datetime import DT, NAT_INT, Timestamp, as_us, is_time
    import datetime as _datetime
    v = col._pd_values
    n = len(v)
    if isinstance(right, Column) and right.dtype is DT:
        r = right._pd_values
        miss = (v == NAT_INT) | (r == NAT_INT)
    elif isinstance(right, Column):
        # (another array, as pandas infers it: numbers or bools are equal to none, with no order; strings are
        # parsed, all of them or none; values of mixed types are compared one by one)
        d = right.dtype
        rv = right.tolist()
        if d in INTS or d in FLOATS or d == "bool":
            if op in ("eq", "ne"):
                return Column("bool", np.full(n, op == "ne", dtype=bool))
            raise TypeError("Invalid comparison between dtype=datetime64[us] and ndarray")
        if all(is_missing(x) for x in rv):
            return Column("bool", np.full(n, op == "ne", dtype=bool))
        if d is STR:
            try:
                r = np.array([NAT_INT if is_missing(x) else as_us(Timestamp(x)) for x in rv], dtype=np.int64)
            except ValueError:
                if op in ("eq", "ne"):
                    return Column("bool", np.full(n, op == "ne", dtype=bool))
                raise TypeError("Invalid comparison between dtype=datetime64[us] and StringArray") from None
            miss = (v == NAT_INT) | (r == NAT_INT)
        else:
            left = col.tolist()
            out = []
            for a, b in zip(left, rv):
                if is_missing(a) or is_missing(b):
                    out.append(op == "ne")
                else:
                    out.append(bool(f(a, b)))
            return Column("bool", np.array(out, dtype=bool))
    else:
        r = None
        if is_missing(right):
            return Column("bool", np.full(n, op == "ne", dtype=bool))
        if isinstance(right, str):
            try:
                r = as_us(Timestamp(right))
            except ValueError:
                r = None
        elif is_time(right) and not (isinstance(right, _datetime.date) and not isinstance(right, _datetime.datetime)):
            r = as_us(right)
        if r is None:
            if op in ("eq", "ne"):
                return Column("bool", np.full(n, op == "ne", dtype=bool))
            raise TypeError("Invalid comparison between dtype=datetime64[us] and %s" % type(right).__name__)
        miss = v == NAT_INT
    out = np.asarray(f(v, r), dtype=bool)
    out[miss] = op == "ne"
    return Column("bool", out)


def logical(col, right, op):
    if col.dtype != "bool" or (isinstance(right, Column) and right.dtype != "bool"):
        raise _unsupported("logical operators on non-bool Series")
    a = col._pd_values
    b = right._pd_values if isinstance(right, Column) else bool(right)
    if op == "and":
        r = a & b
    elif op == "or":
        r = a | b
    else:
        r = a ^ b
    return Column("bool", np.asarray(r, dtype=bool))
