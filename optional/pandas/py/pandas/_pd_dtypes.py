"""The dtypes of Sagebrush's pandas (plan-pandas r7 §B, §C2), and how data
infers them, as pandas 3.1 does without pyarrow.

The dtypes:
- int64, float64 and bool are numpy dtypes; their columns are numpy arrays;
- str is pandas 3's default string dtype, StringDtype(storage='python',
  na_value=nan): a Python list of str, with NaN for a missing value;
- object is mixed values, also a Python list.

Inference, measured on the oracle (pandas 3.1.0):
- all bool -> bool;
- all int (Python or numpy ints within int64) -> int64;
- ints and floats, or ints with a missing value (None/NaN) -> float64;
- all str, with missing values -> str;
- a bool with a missing value, bools mixed with ints, or anything else ->
  object;
- no values, or only None -> object.
An int in [2^63, 2^64) is uint64 in pandas, and beyond that object: neither
is in the 0.x subset (NotImplementedError), rather than another dtype.
"""

import numpy as np

__all__ = ["StringDtype", "STR", "is_missing", "infer", "resolve_dtype"]

_I64_MIN, _I64_MAX = -(2 ** 63), 2 ** 63 - 1


class StringDtype(object):
    """pandas' StringDtype, its default str dtype: storage 'python', missing
    values NaN (there is no pyarrow here)."""

    __slots__ = ()
    name = "str"
    storage = "python"
    kind = "O"

    @property
    def na_value(self):
        return float("nan")

    def __repr__(self):
        return "<StringDtype(storage='python', na_value=nan)>"

    def __str__(self):
        return "str"

    def __eq__(self, other):
        return isinstance(other, StringDtype) or (isinstance(other, str) and other in ("str", "string"))

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash("str")


STR = StringDtype()


def is_missing(v):
    """None, a float NaN or numpy's NaN: pandas' missing values for M1."""
    if v is None:
        return True
    if isinstance(v, float):
        return v != v
    if isinstance(v, np.floating):
        return bool(v != v)
    return False


def _is_bool(v):
    return isinstance(v, (bool, np.bool_))


def _is_int(v):
    return isinstance(v, (int, np.integer)) and not _is_bool(v)


def _is_float(v):
    return isinstance(v, (float, np.floating))


def infer(values):
    """The dtype pandas 3.1 infers for a list of Python values: 'int64',
    'float64', 'bool', STR or 'object'.  An int outside int64 raises
    NotImplementedError (pandas makes it uint64 or object)."""
    if not values:
        return "object"
    has_missing = has_bool = has_int = has_float = has_str = has_other = False
    for v in values:
        if v is None:
            has_missing = True
        elif _is_bool(v):
            has_bool = True
        elif _is_int(v):
            if not _I64_MIN <= int(v) <= _I64_MAX:
                raise NotImplementedError("pandas: an integer outside int64 (%d) is not in Sagebrush's pandas 0.x subset" % int(v))
            has_int = True
        elif _is_float(v):
            if v != v:
                has_missing = True
            has_float = True
        elif isinstance(v, str):
            has_str = True
        else:
            has_other = True
    if has_other:
        return "object"
    if has_str:
        return STR if not (has_bool or has_int or has_float and not _all_nan_floats(values)) else "object"
    if has_bool:
        return "bool" if not (has_missing or has_int or has_float) else "object"
    if has_int and not has_float and not has_missing:
        return "int64"
    if has_int or has_float:
        return "float64"
    return "object"   # (only None)


def _all_nan_floats(values):
    # (str with NaN for missing values stays str: the only floats are NaN)
    return all(not _is_float(v) or v != v for v in values)


def resolve_dtype(dtype):
    """A dtype argument as one of 'int64', 'float64', 'bool', STR, 'object'
    or None; others raise NotImplementedError (not in M1's table)."""
    if dtype is None:
        return None
    if dtype is STR or isinstance(dtype, StringDtype):
        return STR
    if isinstance(dtype, str):
        if dtype == "str":
            return STR
        # ('string' is StringDtype(na_value=pd.NA), the nullable variant:
        # out, as pd.NA is)
        if dtype in ("int64", "int", "i8"):
            return "int64"
        if dtype in ("float64", "float", "f8"):
            return "float64"
        if dtype in ("bool", "?"):
            return "bool"
        if dtype in ("object", "O"):
            return "object"
    if dtype is int:
        return "int64"
    if dtype is float:
        return "float64"
    if dtype is bool:
        return "bool"
    if dtype is str:
        return STR
    if dtype is object:
        return "object"
    try:
        nd = np.dtype(dtype)
    except Exception:
        nd = None
    if nd is not None and str(nd) in ("int64", "float64", "bool"):
        return str(nd)
    raise NotImplementedError("pandas: dtype=%r is not in Sagebrush's pandas 0.x subset" % (dtype,))
