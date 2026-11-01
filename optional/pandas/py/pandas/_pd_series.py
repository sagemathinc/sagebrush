"""Series (plan-pandas-m1-r1 §0, §2; r7 §C).

A Series is one column (_pd_column), an Index and a name.  Everything
derived from a Series is an eager copy (Copy-on-Write, r7 §C3).
"""

import numpy as np

from ._pd_column import Column, column_from, set_values
from ._pd_dtypes import STR, infer, is_missing, resolve_dtype
from ._pd_index import Index, RangeIndex, default_index, ensure_index
from . import _pd_indexing as X
from . import _pd_reduce as R
from . import _pd_repr

__all__ = ["Series"]


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _length_error(nvals, nindex):
    return ValueError("Length of values (%d) does not match length of index (%d)" % (nvals, nindex))


def _is_scalar(v):
    return X.is_scalar_key(v) and not isinstance(v, (Index, Series))


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

    def to_numpy(self, dtype=None, copy=False, na_value=None):
        if dtype is not None or na_value is not None:
            raise _unsupported("Series.to_numpy(dtype=, na_value=)")
        if copy:
            if self._pd_col.is_list:
                raise _unsupported("Series.to_numpy() of a %s Series" % self._pd_col.dtype)
            return self._pd_col._pd_values.copy()
        return _export(self._pd_col, "Series.to_numpy()")

    @property
    def array(self):
        raise _unsupported("Series.array")

    def __array__(self, dtype=None, copy=None):
        if dtype is not None:
            raise _unsupported("numpy.asarray(Series, dtype=)")
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

    # --- comparisons (for boolean masks) -----------------------------------

    def _pd_compare(self, other, op):
        if isinstance(other, Series):
            if not self._pd_index.equals(other._pd_index):
                raise ValueError("Can only compare identically-labeled Series objects")
            right = other._pd_col
        elif _is_scalar(other):
            right = other
        else:
            raise _unsupported("Series comparison with a %s" % type(other).__name__)
        return Series._pd_new(R.compare(self._pd_col, right, op), self._pd_index.copy(), self._pd_name)

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
            return X.mask_positions(key, len(self), self._pd_index), False
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
            col = column_from(vals, dt if infer([value]) == dt or (dt == "float64" and infer([value]) == "int64") else None)
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
    if d in ("int64", "float64", "bool"):
        return np.dtype(d)
    return d if d is STR else _ObjectDtype


def _astype(col, dtype):
    want = resolve_dtype(dtype)
    if want == col.dtype:
        return col.copy()
    return column_from(col.tolist(), want)


def _export(col, what):
    """to_numpy()/.values of one column: a read-only copy of a numeric
    column (r7 §C3's table); str/object are rejected."""
    if col.is_list:
        raise _unsupported("%s of a %s column" % (what, col.dtype))
    a = col._pd_values.copy()
    a.flags.writeable = False
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
