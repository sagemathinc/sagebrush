"""The column store of Sagebrush's pandas (plan-pandas r7 §B, §C2, §C3).

A column is a dtype and its values:
- int64, float64, bool: a 1-D numpy array of that dtype;
- str (StringDtype) and object: a Python list (Sagebrush's numpy has no
  object arrays), missing values NaN (str) or as given (object).

Columns are copied eagerly when an object is derived from another (M1's
Copy-on-Write, §C3): a column is never shared between two pandas objects,
and never with a caller's array.
"""

import numpy as np

from ._pd_dtypes import STR, StringDtype, infer, is_missing, resolve_dtype

__all__ = ["Column", "column_from"]

_NUMERIC = ("int64", "float64", "bool")


class Column(object):
    """A dtype ('int64', 'float64', 'bool', STR or 'object') and its values
    (a numpy array or a list), of one length."""

    __slots__ = ("_pd_dtype", "_pd_values")

    def __init__(self, dtype, values):
        self._pd_dtype = dtype
        self._pd_values = values

    def __len__(self):
        return len(self._pd_values)

    @property
    def dtype(self):
        return self._pd_dtype

    @property
    def is_numeric(self):
        return self._pd_dtype in ("int64", "float64")

    @property
    def is_list(self):
        return not isinstance(self._pd_values, np.ndarray)

    def copy(self):
        v = self._pd_values
        return Column(self._pd_dtype, list(v) if self.is_list else v.copy())

    def take(self, positions):
        """A new column of the values at positions (a list of ints)."""
        v = self._pd_values
        if self.is_list:
            return Column(self._pd_dtype, [v[i] for i in positions])
        return Column(self._pd_dtype, v[np.asarray(positions, dtype=np.int64)] if positions else v[:0].copy())

    def slice(self, start, stop, step):
        v = self._pd_values
        return Column(self._pd_dtype, list(v[start:stop:step]) if self.is_list else v[start:stop:step].copy())

    def value(self, i):
        """The value at position i as pandas returns it: a numpy scalar for
        a numeric or bool column, else the stored object."""
        v = self._pd_values
        if self.is_list:
            return v[i]
        return v[i]

    def isna(self):
        """A bool numpy array: which values are missing."""
        v = self._pd_values
        if self._pd_dtype == "float64":
            return v != v
        if self._pd_dtype in ("int64", "bool"):
            return np.zeros(len(v), dtype=bool)
        return np.array([is_missing(x) for x in v], dtype=bool)

    def tolist(self):
        v = self._pd_values
        if self.is_list:
            return list(v)
        return v.tolist()


def _type_name(v):
    return type(v).__name__


def _invalid(v, dtype):
    if dtype is STR:
        return TypeError("Invalid value '%s' for dtype 'str'. Value should be a string or missing value, got '%s' instead." % (v, _type_name(v)))
    return TypeError("Invalid value '%s' for dtype '%s'" % (v, dtype))


def _holdable(dtype, v):
    """v as stored in a column of dtype, or raise pandas 3.1's TypeError
    (setting never upcasts, except a missing value into int64)."""
    if dtype == "int64":
        if isinstance(v, (bool, np.bool_)):
            raise _invalid(v, dtype)
        if isinstance(v, (int, np.integer)):
            if not _I64[0] <= int(v) <= _I64[1]:
                raise ValueError("Invalid integer data type 'O'.")
            return int(v)
        if isinstance(v, (float, np.floating)) and v == v and float(v).is_integer():
            return int(v)
        raise _invalid(v, dtype)
    if dtype == "float64":
        if v is None:
            return float("nan")
        if isinstance(v, (bool, np.bool_)):
            raise _invalid(v, dtype)
        if isinstance(v, (int, float, np.integer, np.floating)):
            return float(v)
        raise _invalid(v, dtype)
    if dtype == "bool":
        if isinstance(v, (bool, np.bool_)):
            return bool(v)
        raise _invalid("nan" if v is None else v, dtype)
    if dtype is STR:
        if is_missing(v):
            return float("nan")
        if isinstance(v, str):
            return v
        raise _invalid(v, dtype)
    return v


_I64 = (-(2 ** 63), 2 ** 63 - 1)


def set_values(col, positions, values):
    """Set values (a list, one per position) at positions in col, in place,
    with pandas 3.1's rules; returns the column, a new float64 one when a
    missing value goes into int64."""
    d = col.dtype
    if d == "int64" and any(is_missing(v) for v in values):
        col = Column("float64", col._pd_values.astype("float64"))
        d = "float64"
    held = [_holdable(d, v) for v in values]
    vals = col._pd_values
    for p, v in zip(positions, held):
        vals[p] = v
    return col


def _as_values(data):
    # (a list of Python values from a list, tuple, range or 1-D numpy array)
    if isinstance(data, np.ndarray):
        if data.ndim != 1:
            raise ValueError("Data must be 1-dimensional, got ndarray of shape %r instead" % (tuple(data.shape),))
        return None
    if isinstance(data, (list, tuple, range)):
        return list(data)
    raise NotImplementedError("pandas: data of type %s is not in Sagebrush's pandas 0.x subset" % type(data).__name__)


def column_from(data, dtype=None):
    """A new Column from a list, tuple, range or 1-D numpy array (always a
    copy, never the caller's storage), with pandas 3.1's inference or the
    dtype given."""
    want = resolve_dtype(dtype)
    if isinstance(data, np.ndarray):
        if data.ndim != 1:
            raise ValueError("Data must be 1-dimensional, got ndarray of shape %r instead" % (tuple(data.shape),))
        kind = str(data.dtype)
        if kind not in _NUMERIC:
            raise NotImplementedError("pandas: an array of dtype %s is not in Sagebrush's pandas 0.x subset" % kind)
        if want is None or want == kind:
            return Column(kind, data.copy())
        if want in _NUMERIC:
            return Column(want, data.astype(want))
        return _cast_list(data.tolist(), want)
    values = _as_values(data)
    if want is None:
        want = infer(values)
    return _cast_list(values, want)


def _cast_list(values, want):
    if want == "int64":
        # (pandas 3.1's errors, in its order: None, NaN, a fractional
        # float, then the range)
        out = []
        fractional = False
        for v in values:
            if v is None:
                raise TypeError("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'")
            if isinstance(v, (float, np.floating)):
                if v != v:
                    raise ValueError("cannot convert float NaN to integer")
                if v in (float("inf"), float("-inf")):
                    raise OverflowError("cannot convert float infinity to integer")
                fractional = fractional or not float(v).is_integer()
            out.append(int(v))
        if fractional:
            raise ValueError("Trying to coerce float values to integers")
        if out and (min(out) < -(2 ** 63) or max(out) > 2 ** 63 - 1):
            raise OverflowError("The elements provided in the data cannot all be casted to the dtype int64")
        return Column("int64", np.array(out, dtype=np.int64))
    if want == "float64":
        return Column("float64", np.array([float("nan") if v is None else float(v) for v in values], dtype=np.float64))
    if want == "bool":
        return Column("bool", np.array([bool(v) for v in values], dtype=bool))
    if want is STR or isinstance(want, StringDtype):
        return Column(STR, [float("nan") if is_missing(v) else str(v) for v in values])
    return Column("object", list(values))
