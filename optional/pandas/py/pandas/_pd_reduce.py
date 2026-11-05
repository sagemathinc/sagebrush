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
from ._pd_dtypes import STR, is_missing

__all__ = ["check_args", "reduce_column", "compare", "logical"]


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


def reduce_column(col, op, skipna):
    d = col.dtype
    if op == "count":
        return np.int64(int(len(col) - int(_scalar(col.isna().sum()))))
    if d in ("int64", "bool"):
        v = col._pd_values
        if op == "sum":
            return np.int64(int(_scalar(v.astype("int64").sum())) if len(v) else 0)
        if op == "mean":
            return float("nan") if not len(v) else np.float64(float(_scalar(v.astype("float64").mean())))
        if not len(v):
            return float("nan")
        r = _scalar(v.min() if op == "min" else v.max())
        return np.bool_(bool(r)) if d == "bool" else np.int64(int(r))
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


_OPS = {
    "eq": operator.eq, "ne": operator.ne, "lt": operator.lt,
    "le": operator.le, "gt": operator.gt, "ge": operator.ge,
}


def compare(col, right, op):
    """A bool Column: col <op> right (a scalar or a Column of the same
    length).  A missing value compares False (True for ne), as pandas."""
    f = _OPS[op]
    if not col.is_list and (not isinstance(right, Column) or not right.is_list) and not isinstance(right, str):
        rv = right._pd_values if isinstance(right, Column) else right
        if rv is None:
            return Column("bool", np.full(len(col), op == "ne", dtype=bool))
        return Column("bool", np.asarray(f(col._pd_values, rv), dtype=bool))
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
