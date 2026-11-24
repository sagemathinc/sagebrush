"""Series arithmetic (+ - * / // % ** and their reflections, unary -, +,
abs), as pandas 3.1 computes it over numpy:

- the result dtype is NumPy 2's: a Python number is a weak scalar (an
  integer column keeps its dtype, numpy's OverflowError if the int doesn't
  fit; a float32 column stays float32, the number rounded to float32 first),
  and so is a numpy number, which pandas takes as its Python value; an array
  or another Series promotes as numpy does; int / int is float64;
- division by zero is pandas': / is numpy's (a signed infinity, NaN for
  0/0); // (and divmod) take pandas' mask_zero_div_zero, inf or -inf by the
  signs of the dividend and of the zero, NaN for 0, the result float64; %
  is NaN there, an integer result becoming float64;
- bools: + is or, * is and, - is numpy's TypeError, and /, //, ** are
  pandas' NotImplementedError; a bool with a number is that number's type;
- str: + concatenates and * an int repeats, a missing value staying
  missing; anything else is Python's TypeError; object columns are refused
  (pandas masks their missing values out, which this subset doesn't);
- two Series with other labels align on the sorted union of their labels
  (missing values where one side has none); the name is kept when both
  names are the same.
"""

import math
import operator

import numpy as np

from ._pd_column import Column, column_from
from ._pd_dtypes import STR, INTS, FLOATS, is_missing
from ._pd_datetime import DT

__all__ = ["binary", "unary", "OPS"]

OPS = {
    "add": operator.add, "sub": operator.sub, "mul": operator.mul, "truediv": operator.truediv,
    "floordiv": operator.floordiv, "mod": operator.mod, "pow": operator.pow,
}
_SYMBOL = {"add": "+", "sub": "-", "mul": "*", "truediv": "/", "floordiv": "//", "mod": "%", "pow": "**"}


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _scalar(x):
    return x[()] if isinstance(x, np.ndarray) else x


def _numeric(d):
    return d in INTS or d in FLOATS or d == "bool"


def _kind(d):
    return "b" if d == "bool" else "f" if d in FLOATS else "u" if d.startswith("u") else "i"


def _weak_dtype(d, v):
    """NumPy 2's result dtype of a column of dtype d with a Python number v."""
    if isinstance(v, bool):
        return d
    if isinstance(v, int):
        if d == "bool":
            return "int64"
        if d in INTS:
            info = np.iinfo(d)
            if not info.min <= v <= info.max:
                raise OverflowError("Python integer %d out of bounds for %s" % (v, d))
        return d
    return d if d in FLOATS else "float64"


def _right_values(right, n):
    """The other operand as (kind, values): 'col' with a Column, 'weak' with
    a Python number, 'scalar' with a numpy scalar, 'obj' with any other
    scalar."""
    if isinstance(right, Column):
        return "col", right
    if isinstance(right, (list, tuple, np.ndarray)):
        col = column_from(right) if not isinstance(right, np.ndarray) else column_from(right.copy())
        if len(col) != n:
            raise ValueError("operands could not be broadcast together with shapes (%d,) (%d,) " % (n, len(col)))
        return "col", col
    if isinstance(right, (np.bool_, np.integer, np.floating)):
        # (pandas takes a numpy number as its Python value: a weak scalar, as a Python number is)
        right = right.item()
    if isinstance(right, (bool, int, float)):
        return "weak", right
    return "obj", right


def _signed_zero(b):
    # (a zero divisor's sign, as np.signbit reads it)
    return isinstance(b, float) and math.copysign(1.0, b) < 0


def _mask_zero_div_zero(x, y, out):
    # (pandas' mask_zero_div_zero, for // and divmod: where the divisor is 0, NaN for 0, and inf or -inf by the
    # signs of the dividend and of the zero; the result becomes float64 when any such position exists)
    nan, pinf, ninf = [], [], []
    for p, (a, b) in enumerate(zip(x.tolist(), y.tolist())):
        if b == 0:
            neg = _signed_zero(b)
            if a == 0:
                nan.append(p)
            elif a > 0:
                (ninf if neg else pinf).append(p)
            elif a < 0:
                (pinf if neg else ninf).append(p)
    if not (nan or pinf or ninf):
        return out
    out = out.astype(np.float64)
    for p in nan:
        out[p] = np.nan
    for p in pinf:
        out[p] = np.inf
    for p in ninf:
        out[p] = -np.inf
    return out


def _fill_zeros(y, out):
    # (pandas' _fill_zeros, for %: an integer result is NaN, as float64, where the integer divisor is 0; a float
    # result is numpy's own, NaN there)
    zero = [p for p, b in enumerate(y.tolist()) if b == 0]
    if not zero:
        return out
    if out.dtype.kind != "f":
        out = out.astype(np.float64)
    for p in zero:
        out[p] = np.nan
    return out


def _numeric_op(op, x, y, d):
    """op of two numpy arrays already of dtype d (the result's dtype class)."""
    if op == "truediv":
        # (numpy's true division: an integer one in float64; a zero divisor gives its signed infinity or NaN)
        xf, yf = (x, y) if d in FLOATS else (x.astype(np.float64), y.astype(np.float64))
        with np.errstate(all="ignore"):
            return xf / yf
    if op in ("floordiv", "mod"):
        one = np.ones(len(y), dtype=d)
        safe = np.where(y == 0, one, y)
        out = (x // safe) if op == "floordiv" else (x % safe)
        return _mask_zero_div_zero(x, y, out) if op == "floordiv" else _fill_zeros(y, out)
    if op == "pow" and d in INTS and bool(_scalar((y < 0).any())):
        raise ValueError("Integers to negative integer powers are not allowed.")
    return OPS[op](x, y)


def _bool_bool(op, x, y):
    if op == "add":
        return x | y
    if op == "mul":
        return x & y
    if op == "sub":
        raise TypeError("numpy boolean subtract, the `-` operator, is not supported, use the bitwise_xor, the `^` "
                        "operator, or the logical_xor function instead.")
    if op == "mod":
        return Column("int8", np.zeros(len(x), dtype=np.int8))
    raise NotImplementedError("operator '%s' not implemented for bool dtypes" % op)


def binary(col, right, op, reflected, owner):
    """col <op> right (right <op> col when reflected): a Column. right is a
    Column (already aligned), a list or array, or a scalar."""
    d = col.dtype
    n = len(col)
    kind, rv = _right_values(right, n)
    if d == "object" or (kind == "col" and rv.dtype == "object"):
        # (pandas masks missing values out of an object column's arithmetic; not in the subset)
        raise _unsupported("%s of an object column" % owner)
    if d is DT or (kind == "col" and rv.dtype is DT):
        raise _unsupported("%s of a datetime64[us] column (Timedelta arithmetic)" % owner)
    if _numeric(d) and (kind in ("weak", "scalar") or (kind == "col" and _numeric(rv.dtype))):
        if kind == "weak":
            rd = _weak_dtype(d, rv)
            if d == "bool" and rd == "bool":
                rcol = Column("bool", np.full(n, bool(rv), dtype=bool))
            else:
                rcol = Column(rd, np.full(n, rv, dtype=rd) if not (rd in FLOATS) else np.full(n, float(rv), dtype=rd))
            res_d = rd
        else:
            other_d = str(rv.dtype) if kind == "scalar" else rv.dtype
            if kind == "scalar" and other_d not in ("bool",) + INTS + FLOATS:
                raise _unsupported("%s with a numpy %s" % (owner, other_d))
            rcol = Column(other_d, np.full(n, rv, dtype=other_d)) if kind == "scalar" else rv
            res_d = "bool" if d == "bool" and other_d == "bool" else str(np.result_type(d, other_d))
            if res_d not in ("bool",) + INTS + FLOATS:
                raise _unsupported("%s giving %s" % (owner, res_d))
        x = col._pd_values.astype(res_d)
        y = rcol._pd_values.astype(res_d)
        if reflected:
            x, y = y, x
        if res_d == "bool":
            out = _bool_bool(op, x, y)
            return out if isinstance(out, Column) else Column("bool", out)
        out = _numeric_op(op, x, y, res_d)
        out_d = str(out.dtype)
        return Column(out_d, out)
    # (str, object, and mixes: Python's operators value by value, a missing value staying missing)
    left = col.tolist()
    rights = rv.tolist() if kind == "col" else [rv] * n
    f = OPS[op]
    out = []
    for a, b in zip(left, rights):
        if reflected:
            a, b = b, a
        if (d is STR or (kind == "col" and rv.dtype is STR)) and (is_missing(a) or is_missing(b)):
            out.append(float("nan"))
            continue
        out.append(f(a, b))
    if d is STR and all(isinstance(v, str) or is_missing(v) for v in out):
        return Column(STR, out)
    return column_from(out) if out else col.copy()


def unary(col, op):
    d = col.dtype
    if d is DT:
        raise _unsupported("Series.__%s__ of a datetime64[us] column" % op)
    if d == "bool":
        v = col._pd_values
        return Column("bool", ~v if op == "neg" else v.copy())
    if _numeric(d):
        v = col._pd_values
        out = -v if op == "neg" else v.copy() if op == "pos" else np.abs(v)
        return Column(d, out)
    if d == "object":
        raise _unsupported("Series.__%s__ of an object column" % op)
    f = {"neg": operator.neg, "pos": operator.pos, "abs": abs}[op]
    return column_from([v if is_missing(v) else f(v) for v in col.tolist()])
