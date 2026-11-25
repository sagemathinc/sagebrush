"""Series (plan-pandas-m1-r1 §0, §2; r7 §C).

A Series is one column (_pd_column), an Index and a name.  Everything
derived from a Series is an eager copy (Copy-on-Write, r7 §C3).
"""

import numpy as np

from ._pd_errors import unsupported_name
from ._pd_column import Column, column_from, set_values, astype_column
from ._pd_dtypes import STR, INTS, FLOATS, infer, is_missing, resolve_dtype
from ._pd_datetime import DT, NaT, FIELDS
from .errors import _INPLACE, inplace_given
from ._pd_index import Index, RangeIndex, default_index, ensure_index
from . import _pd_indexing as X
from . import _pd_reduce as R
from . import _pd_repr
from . import _pd_sort as S
from . import _pd_reshape as RS
from . import _pd_combine as CB
from . import _pd_info as INF
from . import _pd_stats as ST

__all__ = ["Series"]


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _length_error(nvals, nindex):
    return ValueError("Length of values (%d) does not match length of index (%d)" % (nvals, nindex))


def _is_scalar(v):
    return X.is_scalar_key(v) and not isinstance(v, (Index, Series))


def _compare_values(values, n, broadcast):
    # (a list-like compared by an operator: its length must be the Series', with pandas' message, or numpy's
    # broadcast message for a range)
    m = len(values)
    if m != n:
        if broadcast:
            raise ValueError("operands could not be broadcast together with shapes (%d,) (%d,) " % (n, m))
        raise ValueError("Lengths must match to compare", (n,), (m,))
    if isinstance(values, Index):
        values = values.tolist()
    return column_from(values.copy() if isinstance(values, np.ndarray) else list(values))


class Series(object):
    """A one-dimensional labelled array."""

    __slots__ = ("_pd_col", "_pd_index", "_pd_name")

    def __init__(self, data=None, index=None, dtype=None, name=None, copy=None):
        from ._pd_frame import DataFrame
        if isinstance(data, np.ndarray) and copy is False:
            raise _unsupported("Series(..., copy=False) with an ndarray")
        if isinstance(data, DataFrame):
            raise _unsupported("Series(DataFrame)")
        if isinstance(data, Series):
            if index is not None:
                col = data._pd_reindex(ensure_index(index))._pd_col
                idx = ensure_index(index)
            else:
                col, idx = data._pd_col.copy(), data._pd_index.copy()
            if dtype is not None:
                col = _astype(col, dtype)
            if name is None:
                name = data._pd_name
        elif isinstance(data, dict):
            keys = list(data.keys())
            if index is None:
                idx = Index(keys) if keys else default_index(0)
                col = column_from(list(data.values()), dtype)
            else:
                idx = ensure_index(index)
                vals = [data[k] if k in data else float("nan") for k in idx.tolist()]
                col = column_from(vals, dtype)
        elif data is None or _is_scalar(data):
            if data is None and index is None:
                col, idx = column_from([], dtype), default_index(0)
            else:
                idx = ensure_index(index) if index is not None else default_index(1)
                col = column_from([data if data is not None else float("nan")] * len(idx), dtype)
        else:
            if isinstance(data, Index):
                data = data._pd_column()
            col = data.copy() if isinstance(data, Column) else column_from(data, dtype)
            if isinstance(data, Column) and dtype is not None:
                col = _astype(col, dtype)
            if index is None:
                idx = default_index(len(col))
            else:
                idx = ensure_index(index)
                if len(idx) != len(col):
                    raise _length_error(len(col), len(idx))
        self._pd_col = col
        self._pd_index = idx
        self._pd_name = name

    @classmethod
    def _pd_new(cls, col, index, name=None):
        s = cls.__new__(cls)
        s._pd_col = col
        s._pd_index = index
        s._pd_name = name
        return s

    # --- attributes --------------------------------------------------------

    @property
    def index(self):
        return self._pd_index

    @index.setter
    def index(self, value):
        idx = ensure_index(value)
        if len(idx) != len(self):
            raise ValueError("Length mismatch: Expected axis has %d elements, new values have %d elements" % (len(self), len(idx)))
        self._pd_index = idx

    @property
    def name(self):
        return self._pd_name

    @name.setter
    def name(self, value):
        self._pd_name = value

    @property
    def dtype(self):
        d = self._pd_col.dtype
        return dtype_object(d)

    dtypes = dtype

    @property
    def shape(self):
        return (len(self),)

    @property
    def size(self):
        return len(self)

    @property
    def ndim(self):
        return 1

    @property
    def empty(self):
        return len(self) == 0

    @property
    def values(self):
        return _export(self._pd_col, "Series.values")

    def to_numpy(self, dtype=None, copy=False, na_value=RS.NO_VALUE, **kwargs):
        """The values as a numpy array: missing values as na_value if given,
        converted to dtype if given (a new, writable array when that changes
        the dtype); see _export."""
        if kwargs:
            raise _unsupported("Series.to_numpy(**kwargs)")
        col = self._pd_col if na_value is RS.NO_VALUE else with_na_value(self._pd_col, na_value)
        if dtype is not None:
            a = export_as([col], dtype, "Series.to_numpy(dtype=)")[:, 0]
            # (read-only where the values already have that dtype: pandas' view of them)
            if not copy and not col.is_list and str(a.dtype) == str(col._pd_values.dtype):
                a.flags.writeable = False
            return a
        if copy:
            if col.dtype is DT or col.dtype is STR:
                return _export(col, "Series.to_numpy()")
            if col.is_list:
                raise _unsupported("Series.to_numpy() of a%s %s column" % ("n" if col.dtype == "object" else "", col.dtype))
            return col._pd_values.copy()
        return _export(col, "Series.to_numpy()")

    @property
    def array(self):
        raise _unsupported("Series.array")

    def __array__(self, dtype=None, copy=None):
        if dtype is not None:
            raise _unsupported("numpy.asarray(Series, dtype=)")
        if self._pd_col.dtype is STR:
            # (Sagebrush's numpy can't take a string array from __array__ yet; to_numpy() gives one)
            raise _unsupported("numpy.asarray(Series) of a str column (Series.to_numpy() gives its '<U' array)")
        return _export(self._pd_col, "numpy.asarray(Series)")

    def __len__(self):
        return len(self._pd_col)

    def __iter__(self):
        return iter(self.tolist())

    def tolist(self):
        return self._pd_col.tolist()

    to_list = tolist

    def keys(self):
        return self._pd_index

    def items(self):
        return zip(self._pd_index.tolist(), self.tolist())

    def __contains__(self, key):
        return key in self._pd_index

    def __bool__(self):
        raise ValueError("The truth value of a Series is ambiguous. Use a.empty, a.item(), a.any() or a.all().")

    def copy(self, deep=True):
        return Series._pd_new(self._pd_col.copy(), self._pd_index.copy(), self._pd_name)

    def head(self, n=5):
        return self._pd_take(_head_positions(len(self), n))

    def tail(self, n=5):
        return self._pd_take(_tail_positions(len(self), n))

    def sample(self, n=None, frac=None, replace=False, weights=None, random_state=None, axis=None, ignore_index=False):
        return self._pd_take(_sample_positions(len(self), n, frac, replace, weights, random_state, axis, ignore_index, "Series"))

    def isna(self):
        return Series._pd_new(Column("bool", self._pd_col.isna()), self._pd_index.copy(), self._pd_name)

    isnull = isna

    def notna(self):
        return Series._pd_new(Column("bool", ~self._pd_col.isna()), self._pd_index.copy(), self._pd_name)

    notnull = notna

    # --- reductions --------------------------------------------------------

    def sum(self, axis=None, skipna=True, numeric_only=False, min_count=0, **kwargs):
        R.check_args("Series.sum", axis, kwargs, min_count)
        return R.reduce_column(self._pd_col, "sum", skipna)

    def mean(self, axis=None, skipna=True, numeric_only=False, **kwargs):
        R.check_args("Series.mean", axis, kwargs)
        return R.reduce_column(self._pd_col, "mean", skipna)

    def min(self, axis=None, skipna=True, numeric_only=False, **kwargs):
        R.check_args("Series.min", axis, kwargs)
        return R.reduce_column(self._pd_col, "min", skipna)

    def max(self, axis=None, skipna=True, numeric_only=False, **kwargs):
        R.check_args("Series.max", axis, kwargs)
        return R.reduce_column(self._pd_col, "max", skipna)

    def count(self):
        return R.reduce_column(self._pd_col, "count", True)

    def any(self, *, axis=0, bool_only=False, skipna=True, **kwargs):
        """Whether any value is true (see _pd_reduce.truth_column)."""
        if kwargs or axis not in (0, "index", None) or bool_only:
            raise _unsupported("Series.any(axis=, bool_only=, **kwargs)")
        return R.truth_column(self._pd_col, "any", skipna)

    def all(self, *, axis=0, bool_only=False, skipna=True, **kwargs):
        """Whether every value is true (see _pd_reduce.truth_column)."""
        if kwargs or axis not in (0, "index", None) or bool_only:
            raise _unsupported("Series.all(axis=, bool_only=, **kwargs)")
        return R.truth_column(self._pd_col, "all", skipna)

    def take(self, indices, axis=0, **kwargs):
        """The rows at positions indices (negative from the end), labels
        kept."""
        if kwargs:
            raise _unsupported("Series.take(**kwargs)")
        if axis not in (0, "index", "rows"):
            raise ValueError("No axis named %s for object type Series" % (axis,))
        return self._pd_take(take_positions(indices, len(self)))

    # --- comparisons ---------------------------------------------------------

    def _pd_compare(self, other, op, warned=False):
        """An operator: another Series needs the same labels, a list-like the
        same length; a frame's comparison is the frame's."""
        from . import _pd_arith as A
        from ._pd_frame import DataFrame
        if isinstance(other, DataFrame):
            return NotImplemented
        if not warned:
            other = A.operand(other, "Series.%s" % op, False)
        if isinstance(other, Series):
            if not self._pd_index.equals(other._pd_index):
                raise ValueError("Can only compare identically-labeled Series objects")
            right = other._pd_col
        elif isinstance(other, range):
            right = _compare_values(list(other), len(self), True)
        elif isinstance(other, (list, tuple, np.ndarray, Index)):
            right = _compare_values(other, len(self), False)
        elif _is_scalar(other):
            right = other
        else:
            raise _unsupported("Series comparison with a %s" % type(other).__name__)
        return Series._pd_new(R.compare(self._pd_col, right, op), self._pd_index.copy(), self._pd_name)

    def _pd_flex_compare(self, other, op, level, fill_value, axis):
        """A named comparison: another Series aligned on the sorted union of
        the labels (a label one side lacks compares False, True for ne); a
        list, tuple or array of the same length; fill_value where one side
        is missing and the other isn't, as the named arithmetic fills."""
        from . import _pd_arith as A
        from ._pd_frame import DataFrame
        owner = "Series.%s" % op
        if level is not None:
            raise _unsupported("%s(level=) (a MultiIndex)" % owner)
        if axis not in (0, "index", "rows"):
            raise ValueError("No axis named %s for object type Series" % (axis,))
        if isinstance(other, DataFrame):
            raise TypeError("%s does not support a DataFrame `other`. Use df.%s(ser) instead." % (owner, op))
        other = A.operand(other, owner, True)
        if isinstance(other, (range, Index)) or not isinstance(other, (Series, list, tuple, np.ndarray)):
            # (a range, an Index or a scalar takes the operator's path, after filling this Series)
            left = self
            if fill_value is not None and not isinstance(other, (range, Index)) and is_missing(other):
                # (pandas: a missing scalar is replaced by fill_value, and this Series' own missing values stay)
                other = fill_value
            elif fill_value is not None:
                left = Series._pd_new(RS.fill_column(self._pd_col, fill_value), self._pd_index.copy(), self._pd_name)
            return left._pd_compare(other, op, True)
        left, right, index, name = self._pd_operand(other, owner)
        if not isinstance(other, Series):
            if len(right) != len(left):
                raise ValueError("Lengths must be equal")
            right = column_from(right.copy() if isinstance(right, np.ndarray) else list(right))
        if fill_value is not None:
            lm, rm = left.isna().tolist(), right.isna().tolist()
            left = RS.fill_positions(left, dict((p, fill_value) for p, (a, b) in enumerate(zip(lm, rm)) if a and not b))
            right = RS.fill_positions(right, dict((p, fill_value) for p, (a, b) in enumerate(zip(lm, rm)) if b and not a))
        return Series._pd_new(R.compare(left, right, op), index, name)

    def __eq__(self, other):
        return self._pd_compare(other, "eq")

    def __ne__(self, other):
        return self._pd_compare(other, "ne")

    def __lt__(self, other):
        return self._pd_compare(other, "lt")

    def __le__(self, other):
        return self._pd_compare(other, "le")

    def __gt__(self, other):
        return self._pd_compare(other, "gt")

    def __ge__(self, other):
        return self._pd_compare(other, "ge")

    def eq(self, other, level=None, fill_value=None, axis=0):
        """Named eq: aligned as the named arithmetic, a bool Series."""
        return self._pd_flex_compare(other, "eq", level, fill_value, axis)

    def ne(self, other, level=None, fill_value=None, axis=0):
        """Named ne: aligned as the named arithmetic, a bool Series."""
        return self._pd_flex_compare(other, "ne", level, fill_value, axis)

    def lt(self, other, level=None, fill_value=None, axis=0):
        """Named lt: aligned as the named arithmetic, a bool Series."""
        return self._pd_flex_compare(other, "lt", level, fill_value, axis)

    def le(self, other, level=None, fill_value=None, axis=0):
        """Named le: aligned as the named arithmetic, a bool Series."""
        return self._pd_flex_compare(other, "le", level, fill_value, axis)

    def gt(self, other, level=None, fill_value=None, axis=0):
        """Named gt: aligned as the named arithmetic, a bool Series."""
        return self._pd_flex_compare(other, "gt", level, fill_value, axis)

    def ge(self, other, level=None, fill_value=None, axis=0):
        """Named ge: aligned as the named arithmetic, a bool Series."""
        return self._pd_flex_compare(other, "ge", level, fill_value, axis)

    __hash__ = None

    def _pd_logical(self, other, op):
        if isinstance(other, Series):
            if not self._pd_index.equals(other._pd_index):
                raise _unsupported("Series logical operators on differently-labeled Series")
            right = other._pd_col
        elif isinstance(other, (bool, np.bool_)):
            right = other
        else:
            raise _unsupported("Series logical operators with a %s" % type(other).__name__)
        return Series._pd_new(R.logical(self._pd_col, right, op), self._pd_index.copy(), self._pd_name)

    def __and__(self, other):
        return self._pd_logical(other, "and")

    def __or__(self, other):
        return self._pd_logical(other, "or")

    def __xor__(self, other):
        return self._pd_logical(other, "xor")

    def __invert__(self):
        if self._pd_col.dtype != "bool":
            raise _unsupported("~ on a %s Series" % self._pd_col.dtype)
        return Series._pd_new(Column("bool", ~self._pd_col._pd_values), self._pd_index.copy(), self._pd_name)

    # --- arithmetic (see _pd_arith) ---------------------------------------

    def _pd_operand(self, other, owner):
        """(this Series' column, the other operand, the result's index and
        name): another Series aligned on the sorted union of the labels."""
        from ._pd_frame import DataFrame
        if isinstance(other, DataFrame):
            raise _unsupported("%s with a DataFrame (a frame result)" % owner)
        if isinstance(other, Index):
            other = other.tolist()
        if not isinstance(other, Series):
            return self._pd_col, other, self._pd_index.copy(), self._pd_name
        name = self._pd_name if self._pd_name == other._pd_name else None
        if self._pd_index.equals(other._pd_index):
            return self._pd_col, other._pd_col, self._pd_index.copy(), name
        if not self._pd_index.is_unique or not other._pd_index.is_unique:
            raise _unsupported("%s of Series with other, repeated labels" % owner)
        from . import _pd_combine as CB
        labels = CB.join_labels([self._pd_index, other._pd_index], "outer", True)
        return self._pd_aligned(labels), other._pd_aligned(labels), labels, name

    def _pd_aligned(self, labels):
        """The column at labels (pandas' reindex for arithmetic): a float
        column keeps its dtype (float32 too) with NaN at labels it hasn't;
        others as _pd_reindex gives them."""
        if self._pd_col.dtype not in FLOATS:
            return self._pd_reindex(labels)._pd_col
        positions = []
        for lab in labels.tolist():
            try:
                positions.append(self._pd_index._pd_positions(lab))
            except KeyError:
                positions.append(None)
        v = self._pd_col._pd_values
        out = np.full(len(positions), np.nan, dtype=self._pd_col.dtype)
        for k, p in enumerate(positions):
            if p is not None:
                out[k] = v[p]
        return Column(self._pd_col.dtype, out)

    def _pd_arith(self, other, op, reflected=False, fill_value=None, method=False):
        from . import _pd_arith as A
        from ._pd_frame import DataFrame
        if isinstance(other, DataFrame) and not method:
            # (an operator with a frame is the frame's: Python then calls its reflected operator)
            return NotImplemented
        owner = "Series.%s" % (("r" if reflected else "") + op)
        other = A.operand(other, owner, method)
        # (pandas' flex methods take a Series, list, tuple or array argument through their own path: its length
        # checked first, and numpy's op without the zero division masks; a range, an Index, a scalar (a 0-d array
        # too) and the operators keep the operator's path, numpy's broadcast message and the masks)
        flex = method and isinstance(other, (Series, list, tuple, np.ndarray))
        left, right, index, name = self._pd_operand(other, owner)
        if flex and not isinstance(other, Series) and len(right) != len(left):
            raise ValueError("Lengths must be equal")
        if fill_value is not None and flex and not isinstance(right, Column):
            # (pandas' flex path makes a list, tuple or array a Series first, so fill_value fills either side)
            right = column_from(right.copy() if isinstance(right, np.ndarray) else list(right))
        if fill_value is not None and isinstance(right, Column):
            # (fill_value where one side is missing and the other isn't, each column keeping its dtype)
            lm, rm = left.isna().tolist(), right.isna().tolist()
            left = RS.fill_positions(left, dict((p, fill_value) for p, (a, b) in enumerate(zip(lm, rm)) if a and not b))
            right = RS.fill_positions(right, dict((p, fill_value) for p, (a, b) in enumerate(zip(lm, rm)) if b and not a))
        elif fill_value is not None:
            if not isinstance(right, (list, tuple, range, np.ndarray)) and is_missing(right):
                # (pandas: a missing scalar is replaced by fill_value, and this Series' own missing values stay)
                right = fill_value
            else:
                left = RS.fill_column(left, fill_value)
        mask_zero = not flex
        return Series._pd_new(A.binary(left, right, op, reflected, owner, mask_zero), index, name)

    def __add__(self, other):
        return self._pd_arith(other, "add")

    def __radd__(self, other):
        return self._pd_arith(other, "add", True)

    def __sub__(self, other):
        return self._pd_arith(other, "sub")

    def __rsub__(self, other):
        return self._pd_arith(other, "sub", True)

    def __mul__(self, other):
        return self._pd_arith(other, "mul")

    def __rmul__(self, other):
        return self._pd_arith(other, "mul", True)

    def __truediv__(self, other):
        return self._pd_arith(other, "truediv")

    def __rtruediv__(self, other):
        return self._pd_arith(other, "truediv", True)

    def __floordiv__(self, other):
        return self._pd_arith(other, "floordiv")

    def __rfloordiv__(self, other):
        return self._pd_arith(other, "floordiv", True)

    def __mod__(self, other):
        return self._pd_arith(other, "mod")

    def __rmod__(self, other):
        return self._pd_arith(other, "mod", True)

    def __pow__(self, other):
        return self._pd_arith(other, "pow")

    def __rpow__(self, other):
        return self._pd_arith(other, "pow", True)

    def __divmod__(self, other):
        from ._pd_frame import DataFrame
        if isinstance(other, DataFrame):
            return NotImplemented
        return self._pd_arith(other, "floordiv"), self._pd_arith(other, "mod")

    def __rdivmod__(self, other):
        from ._pd_frame import DataFrame
        if isinstance(other, DataFrame):
            return NotImplemented
        return self._pd_arith(other, "floordiv", True), self._pd_arith(other, "mod", True)

    def __matmul__(self, other):
        raise _unsupported("Series.__matmul__ (a dot product)")

    def __rmatmul__(self, other):
        raise _unsupported("Series.__rmatmul__ (a dot product)")

    def __neg__(self):
        from . import _pd_arith as A
        return Series._pd_new(A.unary(self._pd_col, "neg"), self._pd_index.copy(), self._pd_name)

    def __pos__(self):
        from . import _pd_arith as A
        return Series._pd_new(A.unary(self._pd_col, "pos"), self._pd_index.copy(), self._pd_name)

    def __abs__(self):
        from . import _pd_arith as A
        return Series._pd_new(A.unary(self._pd_col, "abs"), self._pd_index.copy(), self._pd_name)

    def abs(self):
        return self.__abs__()

    def add(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.add(level=, axis=)")
        return self._pd_arith(other, "add", False, fill_value, method=True)

    def sub(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.sub(level=, axis=)")
        return self._pd_arith(other, "sub", False, fill_value, method=True)

    def subtract(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.subtract(level=, axis=)")
        return self._pd_arith(other, "sub", False, fill_value, method=True)

    def mul(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.mul(level=, axis=)")
        return self._pd_arith(other, "mul", False, fill_value, method=True)

    def multiply(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.multiply(level=, axis=)")
        return self._pd_arith(other, "mul", False, fill_value, method=True)

    def truediv(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.truediv(level=, axis=)")
        return self._pd_arith(other, "truediv", False, fill_value, method=True)

    def div(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.div(level=, axis=)")
        return self._pd_arith(other, "truediv", False, fill_value, method=True)

    def divide(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.divide(level=, axis=)")
        return self._pd_arith(other, "truediv", False, fill_value, method=True)

    def floordiv(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.floordiv(level=, axis=)")
        return self._pd_arith(other, "floordiv", False, fill_value, method=True)

    def mod(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.mod(level=, axis=)")
        return self._pd_arith(other, "mod", False, fill_value, method=True)

    def pow(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.pow(level=, axis=)")
        return self._pd_arith(other, "pow", False, fill_value, method=True)

    def radd(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.radd(level=, axis=)")
        return self._pd_arith(other, "add", True, fill_value, method=True)

    def rsub(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rsub(level=, axis=)")
        return self._pd_arith(other, "sub", True, fill_value, method=True)

    def rmul(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rmul(level=, axis=)")
        return self._pd_arith(other, "mul", True, fill_value, method=True)

    def rtruediv(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rtruediv(level=, axis=)")
        return self._pd_arith(other, "truediv", True, fill_value, method=True)

    def rdiv(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rdiv(level=, axis=)")
        return self._pd_arith(other, "truediv", True, fill_value, method=True)

    def rfloordiv(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rfloordiv(level=, axis=)")
        return self._pd_arith(other, "floordiv", True, fill_value, method=True)

    def rmod(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rmod(level=, axis=)")
        return self._pd_arith(other, "mod", True, fill_value, method=True)

    def rpow(self, other, level=None, fill_value=None, axis=0):
        if level is not None or axis not in (0, "index", "rows"):
            raise _unsupported("Series.rpow(level=, axis=)")
        return self._pd_arith(other, "pow", True, fill_value, method=True)

    def __getattr__(self, name):
        if name == "dt":
            raise AttributeError("Can only use .dt accessor with datetimelike values")
        from ._pd_names import SERIES
        if name in SERIES:
            raise unsupported_name("Series.%s" % name)
        raise AttributeError("'Series' object has no attribute '%s'" % name)

    # --- selection ---------------------------------------------------------

    def _pd_take(self, positions):
        return Series._pd_new(self._pd_col.take(positions), self._pd_index._pd_take(positions), self._pd_name)

    def _pd_take_rows(self, positions):
        return self._pd_take(positions)

    def _pd_reindex(self, index):
        vals = []
        for lab in index.tolist():
            try:
                p = self._pd_index._pd_positions(lab)
            except KeyError:
                vals.append(float("nan"))
                continue
            if isinstance(p, list):
                raise ValueError("cannot reindex on an axis with duplicate labels")
            vals.append(self._pd_col.value(p))
        return Series._pd_new(column_from(vals) if vals else self._pd_col.take([]), index, self._pd_name)

    def _pd_select(self, positions, scalar):
        if scalar:
            return self._pd_col.value(positions[0])
        return self._pd_take(positions)

    def _pd_getitem_positions(self, key):
        if isinstance(key, slice):
            return X.getitem_slice_positions(self._pd_index, key), False
        if X.is_bool_key(key):
            return X.mask_positions(key, len(self), self._pd_index, what="Series"), False
        if X.is_list_like(key):
            return X.loc_positions(self._pd_index, key)
        if isinstance(key, tuple):
            raise _unsupported("Series[tuple]")
        return X.loc_positions(self._pd_index, key)

    def __getitem__(self, key):
        return self._pd_select(*self._pd_getitem_positions(key))

    def __setitem__(self, key, value):
        if X.is_scalar_key(key):
            self._pd_set_labels(key, value)
            return
        positions, scalar = self._pd_getitem_positions(key)
        self._pd_set_positions(positions, value)

    def _pd_set_labels(self, key, value):
        try:
            positions, scalar = X.loc_positions(self._pd_index, key)
        except KeyError:
            self._pd_enlarge(key, value)
            return
        self._pd_set_positions(positions, value)

    def _pd_enlarge(self, label, value):
        if not _is_scalar(value):
            raise ValueError("setting an array element with a sequence.")
        # (a new label: appended, the dtype kept where the value fits)
        vals = self.tolist() + [value]
        dt = self._pd_col.dtype
        try:
            col = column_from(vals, dt if infer([value]) == dt or (dt in FLOATS and infer([value]) in ("int64", "float64")) else None)
        except (TypeError, ValueError):
            col = column_from(vals)
        self._pd_col = col
        self._pd_index = Index(self._pd_index.tolist() + [label], name=self._pd_index.name)

    def _pd_set_positions(self, positions, value):
        values = _broadcast(value, len(positions))
        self._pd_col = set_values(self._pd_col, positions, values)

    @property
    def loc(self):
        return _SeriesLoc(self)

    @property
    def iloc(self):
        return _SeriesILoc(self)

    # --- time series (design-pandas-xlsx-timeseries PR A) --------------------

    @property
    def dt(self):
        if self._pd_col.dtype is not DT:
            raise AttributeError("Can only use .dt accessor with datetimelike values")
        return _DatetimeProperties(self)

    def diff(self, periods=1):
        """The difference from the value `periods` before (after, if
        negative), as float64; NaN where there is none."""
        return Series._pd_new(diff_column(self._pd_col, periods), self._pd_index.copy(), self._pd_name)

    def dropna(self, *, axis=0, inplace=_INPLACE, how=None, ignore_index=False):
        inplace = inplace_given(inplace, "Series.dropna")
        if axis not in (0, "index", "rows") or ignore_index:
            raise _unsupported("Series.dropna(axis=, ignore_index=)")
        keep = [i for i, na in enumerate(self._pd_col.isna().tolist()) if not na]
        out = self._pd_take(keep)
        if inplace:
            self._pd_col, self._pd_index = out._pd_col, out._pd_index
            return None
        return out

    # --- sorting and reshaping -----------------------------------------------

    def fillna(self, value=RS.NO_VALUE, *, axis=None, inplace=_INPLACE, limit=None):
        """The missing values replaced by value (a scalar, or a dict of
        label -> value); see _pd_reshape.fill_column for the dtype."""
        if value is RS.NO_VALUE:
            raise TypeError("NDFrame.fillna() missing 1 required positional argument: 'value'")
        inplace = inplace_given(inplace, "Series.fillna")
        if axis not in (None, 0, "index", "rows") or limit is not None:
            raise _unsupported("Series.fillna(axis=, limit=)")
        if isinstance(value, dict):
            col = RS.fill_mapped(self._pd_col, self._pd_index.tolist(), value)
        elif value is not None and not _is_scalar(value):
            raise _unsupported("Series.fillna(a %s)" % type(value).__name__)
        else:
            col = RS.fill_column(self._pd_col, value)
        if inplace:
            self._pd_col = col
            return None
        return Series._pd_new(col, self._pd_index.copy(), self._pd_name)

    def rename(self, index=None, *, axis=None, copy=None, inplace=_INPLACE, level=None, errors="ignore"):
        """A scalar (or None) as the new name; a dict or a function maps the
        index's labels."""
        inplace = inplace_given(inplace, "Series.rename")
        if level is not None:
            raise _unsupported("Series.rename(level=)")
        if isinstance(index, dict) or callable(index):
            out = Series._pd_new(self._pd_col.copy(), RS.relabel(self._pd_index, index, errors, "Series.rename"), self._pd_name)
        elif index is None or _is_scalar(index) or isinstance(index, tuple):
            out = Series._pd_new(self._pd_col.copy(), self._pd_index.copy(), index)
        else:
            raise _unsupported("Series.rename(a %s)" % type(index).__name__)
        if inplace:
            self._pd_index, self._pd_name = out._pd_index, out._pd_name
            return None
        return out

    def reset_index(self, level=None, *, drop=False, name=RS.NO_VALUE, inplace=_INPLACE, allow_duplicates=False):
        """drop=True: the values with a new RangeIndex; else a DataFrame of
        the index (a column named after it, or 'index') and the values (a
        column named `name`, the Series' name or 0)."""
        inplace = inplace_given(inplace, "Series.reset_index")
        if level is not None or allow_duplicates:
            raise _unsupported("Series.reset_index(level=, allow_duplicates=)")
        if drop:
            out = Series._pd_new(self._pd_col.copy(), default_index(len(self)), self._pd_name)
            if inplace:
                self._pd_index = out._pd_index
                return None
            return out
        if inplace:
            raise TypeError("Cannot reset_index inplace on a Series to create a DataFrame")
        from ._pd_frame import DataFrame
        vname = name if name is not RS.NO_VALUE else (0 if self._pd_name is None else self._pd_name)
        iname = self._pd_index.name if self._pd_index.name is not None else ("index" if vname != "index" else "level_0")
        cols = [self._pd_index._pd_column().copy(), self._pd_col.copy()]
        return DataFrame._pd_new(cols, Index([iname, vname]), default_index(len(self)))

    def apply(self, func, convert_dtype=None, args=(), *, by_row="compat", **kwargs):
        """func of each value, as a new Series (the dtype inferred from the
        results, as pandas does; an empty Series keeps its dtype)."""
        if convert_dtype is not None or by_row != "compat" or not callable(func):
            raise _unsupported("Series.apply(convert_dtype=, by_row=, a func name)")
        if not len(self):
            return Series._pd_new(self._pd_col.copy(), self._pd_index.copy(), self._pd_name)
        results = [func(v, *args, **kwargs) for v in self._pd_col.tolist()]
        if any(isinstance(r, Series) for r in results):
            raise _unsupported("Series.apply with a func returning a Series")
        return Series._pd_new(column_from(results), self._pd_index.copy(), self._pd_name)

    def unique(self):
        """The distinct values in order of first appearance (NaN once, -0.0
        as 0.0): an array of the Series' dtype; a str Series gives a '<U'
        array (pandas: a StringArray; Sagebrush's numpy has no object dtype
        yet)."""
        col = self._pd_col
        seen = {}
        keep = []
        nan_seen = False
        for i, v in enumerate(col.tolist()):
            if is_missing(v):
                if not nan_seen:
                    nan_seen = True
                    keep.append(i)
                continue
            if v not in seen:
                seen[v] = True
                keep.append(i)
        return _export(col.take(keep), "Series.unique()", False)

    def astype(self, dtype, copy=None, errors="raise"):
        """A copy as dtype (see _pd_column.astype_column)."""
        if errors != "raise" or isinstance(dtype, dict):
            raise _unsupported("Series.astype(errors=, a dict)")
        return Series._pd_new(astype_column(self._pd_col, dtype), self._pd_index.copy(), self._pd_name)

    def sort_values(self, *, axis=0, ascending=True, inplace=_INPLACE, kind="quicksort", na_position="last",
                    ignore_index=False, key=None):
        """The values in order (stable; see _pd_sort), missing values last
        or first."""
        inplace = inplace_given(inplace, "Series.sort_values")
        if axis not in (0, "index", "rows") or key is not None:
            raise _unsupported("Series.sort_values(axis=, key=)")
        flags = S.check_ascending(ascending)
        if len(flags) != 1:
            raise ValueError("Length of ascending (%d) must be 1 for Series" % len(flags))
        S.check_na_position(na_position)
        S.check_kind(kind)
        out = self._pd_take(S.sort_positions([self._pd_col], flags, na_position))
        if ignore_index:
            out._pd_index = default_index(len(out))
        if inplace:
            self._pd_col, self._pd_index = out._pd_col, out._pd_index
            return None
        return out

    def value_counts(self, normalize=False, sort=True, ascending=False, bins=None, dropna=True):
        """Each distinct value's count (or share of all, normalize=True),
        most frequent first, ties in order of first appearance (pandas'
        stable sort); the values become the index, named after the Series."""
        if bins is not None:
            raise _unsupported("Series.value_counts(bins=) (an IntervalIndex)")
        first, counts = CB.count_values(self._pd_col, dropna)
        order = list(range(len(counts)))
        if sort:
            order.sort(key=lambda k: counts[k] if ascending else -counts[k])
        index = Index(self._pd_col.take([first[k] for k in order]), name=self._pd_name)
        n = np.array([counts[k] for k in order], dtype=np.int64)
        if normalize:
            return Series._pd_new(Column("float64", n / n.sum() if len(n) else np.array([], dtype=np.float64)), index, "proportion")
        return Series._pd_new(Column("int64", n), index, "count")

    def drop(self, labels=None, *, axis=0, index=None, columns=None, level=None, inplace=_INPLACE, errors="raise"):
        """Without the rows of labels (or index=; columns= is a frame's and
        ignored here), every row of a repeated label."""
        inplace = inplace_given(inplace, "Series.drop")
        if level is not None:
            raise _unsupported("Series.drop(level=)")
        if axis not in (0, "index", "rows"):
            raise ValueError("No axis named %s for object type Series" % (axis,))
        if labels is not None:
            if index is not None or columns is not None:
                raise ValueError("Cannot specify both 'labels' and 'index'/'columns'")
        elif index is None and columns is None:
            raise ValueError("Need to specify at least one of 'labels', 'index' or 'columns'")
        else:
            labels = index
        if labels is None:
            out = self.copy()
        else:
            keep = CB.keep_positions(self._pd_index, labels, errors)
            out = Series._pd_new(self._pd_col.take(keep), CB.kept_index(self._pd_index, keep), self._pd_name)
        if inplace:
            self._pd_col, self._pd_index = out._pd_col, out._pd_index
            return None
        return out

    def describe(self, percentiles=None, include=None, exclude=None):
        """count, mean, std, min, the percentiles and max of a numeric
        Series (float64); count, unique, top and freq of any other (see
        _pd_stats)."""
        qs = ST.refine_percentiles(percentiles)
        if include is not None or exclude is not None:
            import warnings
            from .errors import Pandas4Warning
            warnings.warn("The 'include' and 'exclude' arguments are deprecated for Series.describe and will be removed "
                          "in a future version. These arguments have no effect on Series and will be removed.",
                          Pandas4Warning, stacklevel=2)
        names, values, forced = ST.describe_column(self._pd_col, qs, ST.format_percentiles(qs), "Series.describe")
        return Series._pd_new(ST.describe_values(values, forced, ST.is_numeric(self._pd_col.dtype)), Index(names), self._pd_name)

    def corr(self, other, method="pearson", min_periods=None):
        """Pearson's correlation with other over the labels both have and the
        rows where both are present (see _pd_stats.series_corr); NaN with
        fewer than min_periods of them."""
        if not isinstance(other, Series):
            raise _unsupported("Series.corr of a %s" % type(other).__name__)
        a, b = self._pd_col, other._pd_col
        if not self._pd_index.equals(other._pd_index):
            if not self._pd_index.is_unique or not other._pd_index.is_unique:
                raise _unsupported("Series.corr of Series with repeated labels")
            labels = [lab for lab in self._pd_index.tolist() if lab in other._pd_index]
            a = a.take([self._pd_index._pd_positions(lab) for lab in labels])
            b = b.take([other._pd_index._pd_positions(lab) for lab in labels])
        if not len(a):
            return float("nan")
        x, y = ST.float_columns([a, b], "Series.corr")
        ST.check_method(method, "Series.corr")
        return ST.series_corr(x, y, method, min_periods)

    def groupby(self, by=None, level=None, *, as_index=True, sort=True, group_keys=True, observed=True, dropna=True):
        """The Series grouped by one key (a Series of the same labels, a list
        of keys, or the index with level=0); see _pd_groupby."""
        from ._pd_groupby import group_series
        return group_series(self, by, level, as_index, sort, group_keys, observed, dropna)

    def memory_usage(self, index=True, deep=False):
        """The bytes pandas counts for the values (and the index); see
        _pd_info."""
        if deep:
            INF.check_deep("Series.memory_usage(deep=True)", [self._pd_col], self._pd_index if index else None)
        return INF.column_nbytes(self._pd_col) + (INF.index_nbytes(self._pd_index) if index else 0)

    def info(self, verbose=None, buf=None, max_cols=None, memory_usage=None, show_counts=True):
        return INF.series_info(self, verbose, buf, max_cols, memory_usage, show_counts)

    # --- reprs -------------------------------------------------------------

    def __repr__(self):
        return _pd_repr.series_repr(self)

    __str__ = __repr__

    def to_string(self, *args, **kwargs):
        if args or kwargs:
            raise _unsupported("Series.to_string arguments")
        return _pd_repr.series_repr(self)


class _ObjectDtypeType(object):
    """numpy's dtype('O'), which Sagebrush's numpy lacks: prints as
    object, compares equal to object, 'O' and 'object'."""

    __slots__ = ()
    name = "object"
    kind = "O"

    def __repr__(self):
        return "dtype('O')"

    def __str__(self):
        return "object"

    def __eq__(self, other):
        return other is object or other is self or (isinstance(other, str) and other in ("O", "object"))

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash("object")


_ObjectDtype = _ObjectDtypeType()


def dtype_object(d):
    """The dtype object pandas shows for a column dtype."""
    if d in INTS or d in FLOATS or d == "bool":
        return np.dtype(d)
    return d if d is STR or d is DT else _ObjectDtype


def _astype(col, dtype):
    return astype_column(col, dtype)


def _export(col, what, readonly=True):
    """to_numpy()/.values of one column: a read-only copy of a numeric
    column (r7 §C3's table). A str column without missing values gives a
    '<U' array of its strings, where pandas gives an object array
    (Sagebrush's numpy has no object dtype yet); object
    columns and str with missing values are rejected, and so is a datetime
    column: pandas gives a numpy datetime64 array, which Sagebrush's numpy
    doesn't have yet (never the microsecond ints in its place)."""
    if col.dtype is DT:
        raise _unsupported("%s of a datetime64[us] column (Sagebrush's numpy has no datetime64 yet)" % what)
    if col.dtype is STR:
        if any(is_missing(v) for v in col._pd_values):
            raise _unsupported("%s of a str column with missing values (pandas gives an object array; Sagebrush's numpy has no object dtype yet)" % what)
        return np.array(list(col._pd_values), dtype=str) if len(col) else np.array([], dtype="<U1")
    if col.is_list:
        raise _unsupported("%s of a%s %s column" % (what, "n" if col.dtype == "object" else "", col.dtype))
    a = col._pd_values.copy()
    if readonly:
        a.flags.writeable = False
    return a


def take_positions(indices, n):
    """take's positions: numbers as integers (a float truncated), negative
    ones from the end, each within n (pandas' IndexError otherwise)."""
    from ._pd_index import Index
    if isinstance(indices, (Series, Index)):
        indices = indices.tolist()
    if isinstance(indices, np.ndarray):
        vals = indices.tolist()
    elif isinstance(indices, (list, tuple, range)):
        vals = list(indices)
    else:
        # (a scalar: pandas casts it with numpy, whose 0-d result has no length)
        _intp(indices)
        raise TypeError("len() of unsized object")
    out = []
    for i in vals:
        i = _intp(i)
        if i < -n or i >= n:
            raise IndexError("indices are out-of-bounds")
        out.append(i + n if i < 0 else i)
    return out


def _intp(v):
    # (one position as numpy's cast to intp: a float truncates, NaN and None are int()'s errors)
    if v is None:
        raise TypeError("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'")
    if isinstance(v, (float, np.floating)) and v != v:
        raise ValueError("cannot convert float NaN to integer")
    if isinstance(v, (str, bool, int, float, np.integer, np.floating, np.bool_)):
        return int(v)
    raise TypeError("int() argument must be a string, a bytes-like object or a real number, not '%s'" % type(v).__name__)


def with_na_value(col, na_value):
    """col with its missing values replaced by na_value (to_numpy's), the
    dtype kept where it holds the value (a float column filled with an int
    stays float64), else inferred."""
    missing = col.isna().tolist()
    if not any(missing):
        return col
    vals = [na_value if m else v for v, m in zip(col.tolist(), missing)]
    d = infer(vals)
    if d in ("int64", "float64") and col.dtype in FLOATS:
        d = col.dtype
    return column_from(vals, d)


def export_as(cols, dtype, what):
    """to_numpy(dtype=) of columns, as a new 2-D array: numeric and bool
    columns converted one by one with numpy's casts, str columns as their
    '<U' array for dtype=str. Other conversions go through pandas' object
    arrays, which Sagebrush's numpy doesn't have yet."""
    if dtype is object or (isinstance(dtype, str) and dtype in ("O", "object")):
        raise _unsupported("%s with dtype=object (Sagebrush's numpy has no object dtype yet)" % what)
    n, m = (len(cols[0]) if cols else 0), len(cols)
    if dtype is str or (isinstance(dtype, str) and dtype in ("str", "U", "<U")):
        if cols and all(c.dtype is STR for c in cols):
            parts = [_export(c, what, False) for c in cols]
            return np.array([[p[i] for p in parts] for i in range(n)], dtype=str) if n else np.empty((0, m), dtype="<U1")
        if any(c.is_list or c.dtype is DT for c in cols):
            raise _unsupported("%s of str mixed with other columns, or of object or datetime columns" % what)
        return _stacked(cols, np.result_type(*[c._pd_values.dtype for c in cols])).astype(str)
    target = np.dtype(dtype)
    if target.kind not in "biuf":
        raise _unsupported("%s with dtype=%s" % (what, target))
    if any(c.is_list or c.dtype is DT for c in cols):
        raise _unsupported("%s of str, object or datetime columns to a numeric dtype (pandas converts an object array)" % what)
    if target.kind in "iu" and any(c.isna().any() for c in cols):
        raise _unsupported("%s of missing values to an integer dtype (numpy's cast of NaN; give na_value=)" % what)
    return _stacked(cols, target)


def is_int_target(dtype):
    """Whether to_numpy's dtype is a numpy integer one."""
    if dtype is object or dtype is str or (isinstance(dtype, str) and dtype in ("O", "object", "str", "U", "<U")):
        return False
    return np.dtype(dtype).kind in "iu"


def _stacked(cols, dtype):
    a = np.empty((len(cols[0]) if cols else 0, len(cols)), dtype=dtype)
    for j, c in enumerate(cols):
        a[:, j] = c._pd_values.astype(dtype)
    return a


def _broadcast(value, n):
    from ._pd_frame import DataFrame
    if isinstance(value, DataFrame):
        raise _unsupported("setting a Series from a DataFrame")
    if isinstance(value, Series):
        vals = value.tolist()
    elif isinstance(value, np.ndarray):
        vals = value.tolist()
    elif isinstance(value, (list, tuple, range)):
        vals = list(value)
    else:
        return [value] * n
    if len(vals) != n:
        raise ValueError("cannot set using a list-like indexer with a different length than the value")
    return vals


def _head_positions(n, k):
    k = int(k)
    return list(range(min(k, n))) if k >= 0 else list(range(max(n + k, 0)))


def _tail_positions(n, k):
    k = int(k)
    if k == 0:
        return []
    return list(range(max(n - k, 0), n)) if k > 0 else list(range(min(-k, n), n))


def _sample_positions(n, k, frac, replace, weights, random_state, axis, ignore_index, owner):
    if frac is not None or replace or weights is not None or ignore_index or axis not in (None, 0, "index", "rows"):
        raise _unsupported("%s.sample(frac=, replace=, weights=, axis=, ignore_index=)" % owner)
    if k is None:
        k = 1
    if not isinstance(k, int) or k < 0:
        raise ValueError("Only integers accepted as `n` values")
    if k > n:
        raise ValueError("Cannot take a larger sample than population when 'replace=False'")
    if random_state is not None and not isinstance(random_state, int):
        raise _unsupported("%s.sample(random_state=) other than an int or None" % owner)
    rs = np.random.RandomState(random_state)
    return [int(i) for i in rs.permutation(n)[:k]]


class _SeriesILoc(object):
    __slots__ = ("_pd_obj",)

    def __init__(self, obj):
        self._pd_obj = obj

    def __getitem__(self, key):
        s = self._pd_obj
        return s._pd_select(*X.iloc_positions(key, len(s)))

    def __setitem__(self, key, value):
        s = self._pd_obj
        positions, scalar = X.iloc_positions(key, len(s))
        s._pd_set_positions(positions, value)


class _SeriesLoc(object):
    __slots__ = ("_pd_obj",)

    def __init__(self, obj):
        self._pd_obj = obj

    def __getitem__(self, key):
        s = self._pd_obj
        return s._pd_select(*X.loc_positions(s._pd_index, key))

    def __setitem__(self, key, value):
        s = self._pd_obj
        if X.is_scalar_key(key):
            s._pd_set_labels(key, value)
            return
        positions, scalar = X.loc_positions(s._pd_index, key)
        s._pd_set_positions(positions, value)


def diff_column(col, periods):
    """Column.diff: float64 (float32 for a float32 column, computed in it),
    NaN where the value `periods` away is missing or past either end (pandas
    3.1: the integers and float64 alike)."""
    if isinstance(periods, bool) or not isinstance(periods, (int, np.integer)):
        raise ValueError("periods must be an integer")
    periods = int(periods)
    if col.dtype is DT:
        raise _unsupported("diff of a datetime64[us] column (a Timedelta column)")
    if col.dtype not in INTS and col.dtype not in FLOATS:
        raise _unsupported("diff of a %s column" % (col.dtype,))
    d = "float32" if col.dtype == "float32" else "float64"
    v = col._pd_values.astype(d)
    n = len(v)
    out = np.full(n, np.nan, dtype=d)
    if periods >= 0 and periods < n:
        out[periods:] = v[periods:] - v[:n - periods]
    elif periods < 0 and -periods < n:
        out[:n + periods] = v[:n + periods] - v[-periods:]
    return Column(d, out)


class _DatetimeProperties(object):
    """Series.dt for a datetime64[us] Series: year, month and day (int32,
    or float64 with NaN when there's a NaT, as pandas), and strftime."""

    __slots__ = ("_pd_s",)

    def __init__(self, s):
        self._pd_s = s

    def _pd_field(self, f):
        s = self._pd_s
        ts = s._pd_col.tolist()
        if any(t is NaT for t in ts):
            col = Column("float64", np.array([np.nan if t is NaT else float(FIELDS[f](t)) for t in ts], dtype=np.float64))
        else:
            col = Column("int32", np.array([FIELDS[f](t) for t in ts], dtype=np.int32))
        return Series._pd_new(col, s._pd_index.copy(), s._pd_name)

    year = property(lambda self: self._pd_field("year"))
    month = property(lambda self: self._pd_field("month"))
    day = property(lambda self: self._pd_field("day"))
    hour = property(lambda self: self._pd_field("hour"))
    minute = property(lambda self: self._pd_field("minute"))
    second = property(lambda self: self._pd_field("second"))

    def strftime(self, date_format):
        s = self._pd_s
        return Series._pd_new(Column(STR, [float("nan") if t is NaT else t.strftime(date_format) for t in s._pd_col.tolist()]), s._pd_index.copy(), s._pd_name)

    def __getattr__(self, name):
        raise unsupported_name("Series.dt.%s" % name)
