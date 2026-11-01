"""DataFrame (plan-pandas-m1-r1 §0, §2; r7 §C).

A DataFrame is a list of columns (_pd_column), the Index of their labels
and the row Index, every column of the row Index's length.  Everything
derived from a frame is an eager copy (Copy-on-Write, r7 §C3).
"""

import numpy as np

from ._pd_column import Column, column_from, set_values
from ._pd_dtypes import STR, infer, is_missing, resolve_dtype
from ._pd_index import Index, RangeIndex, default_index, ensure_index
from ._pd_series import Series, _astype, _broadcast, _head_positions, _tail_positions, _sample_positions, dtype_object
from . import _pd_indexing as X
from . import _pd_reduce as R
from . import _pd_repr

__all__ = ["DataFrame"]


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _is_scalar(v):
    return X.is_scalar_key(v) and not isinstance(v, (Index, Series, DataFrame))


def _union(indexes):
    """The union of differently-labelled indexes, sorted where it can be
    (pandas' default for dict-of-Series alignment)."""
    seen = {}
    for idx in indexes:
        for lab in idx.tolist():
            if lab not in seen:
                seen[lab] = True
    labels = list(seen)
    try:
        labels = sorted(labels)
    except TypeError:
        pass
    return Index(labels)


def _common_dtype(cols):
    """The dtype of a row (or a transposed column) across columns."""
    ds = [c.dtype for c in cols]
    if not ds:
        return "object"
    if all(d == ds[0] for d in ds):
        return ds[0]
    if all(d in ("int64", "float64") for d in ds):
        return "float64"
    return "object"


def _row_values(cols, i, dtype):
    if dtype == "float64":
        return [float(c._pd_values[i]) for c in cols]
    return [c.value(i) for c in cols]


def _column_of(values, dtype):
    if dtype in ("int64", "float64", "bool"):
        return Column(dtype, np.array(values, dtype=dtype))
    return Column(dtype, list(values))


class DataFrame(object):
    """A two-dimensional table of labelled columns."""

    __slots__ = ("_pd_cols", "_pd_columns", "_pd_index")

    def __init__(self, data=None, index=None, columns=None, dtype=None, copy=None):
        if isinstance(data, np.ndarray) and copy is False:
            raise _unsupported("DataFrame(..., copy=False) with an ndarray")
        if isinstance(data, dict) and copy is False and any(isinstance(v, np.ndarray) for v in data.values()):
            raise _unsupported("DataFrame(..., copy=False) with an ndarray")
        want = resolve_dtype(dtype)
        if data is None:
            labels = [] if columns is None else list(ensure_index(columns).tolist())
            idx = default_index(0) if index is None else ensure_index(index)
            cols = [column_from([float("nan")] * len(idx) if len(idx) else [], want) for _ in labels]
            self._pd_init(cols, Index(labels) if columns is not None else _empty_columns(), idx)
            return
        if isinstance(data, DataFrame):
            if index is not None or columns is not None:
                raise _unsupported("DataFrame(DataFrame, index=, columns=)")
            cols = [_astype(c, want) if want else c.copy() for c in data._pd_cols]
            self._pd_init(cols, data._pd_columns.copy(), data._pd_index.copy())
            return
        if isinstance(data, Series):
            label = 0 if data.name is None else data.name
            s = data if index is None else data._pd_reindex(ensure_index(index))
            col = _astype(s._pd_col, want) if want else s._pd_col.copy()
            self._pd_init([col], Index([label]), s._pd_index.copy())
            if columns is not None:
                raise _unsupported("DataFrame(Series, columns=)")
            return
        if isinstance(data, dict):
            self._pd_from_dict(data, index, columns, want)
            return
        if isinstance(data, np.ndarray):
            if data.ndim == 1:
                data = data.reshape((len(data), 1))
            if data.ndim != 2:
                raise ValueError("Must pass 2-d input. shape=%r" % (tuple(data.shape),))
            if str(data.dtype) not in ("int64", "float64", "bool"):
                raise _unsupported("DataFrame of an array of dtype %s" % data.dtype)
            n, m = data.shape
            cols = [column_from(data[:, j].copy(), want) for j in range(m)]
            self._pd_init_checked(cols, columns, index, n)
            return
        if isinstance(data, (list, tuple, range)):
            self._pd_from_list(list(data), index, columns, want)
            return
        raise _unsupported("DataFrame(%s)" % type(data).__name__)

    def _pd_init(self, cols, columns, index):
        self._pd_cols = cols
        self._pd_columns = columns
        self._pd_index = index

    def _pd_init_checked(self, cols, columns, index, n):
        m = len(cols)
        if columns is not None:
            labels = ensure_index(columns)
            if len(labels) != m:
                raise ValueError("Shape of passed values is %r, indices imply %r" % ((n, m), (n, len(labels))))
        else:
            labels = default_index(m)
        if index is not None:
            idx = ensure_index(index)
            if len(idx) != n:
                raise ValueError("Shape of passed values is %r, indices imply %r" % ((n, m), (len(idx), m)))
        else:
            idx = default_index(n)
        self._pd_init(cols, labels, idx)

    def _pd_from_dict(self, data, index, columns, want):
        keys = list(data.keys())
        if columns is not None:
            keys = ensure_index(columns).tolist()
        vals = dict(data)
        series = [v for k, v in vals.items() if k in keys and isinstance(v, Series)]
        dicts = [v for k, v in vals.items() if k in keys and isinstance(v, dict)]
        if dicts:
            series = series + [Series(v) for v in dicts]
            vals = dict((k, Series(v) if isinstance(v, dict) else v) for k, v in vals.items())
        if index is not None:
            idx = ensure_index(index)
        elif series:
            first = series[0].index
            idx = first.copy() if all(s.index.equals(first) for s in series) else _union([s.index for s in series])
        else:
            lengths = [len(v) for k, v in vals.items() if k in keys and not _is_scalar(v)]
            if not lengths:
                if any(k in vals for k in keys):
                    raise ValueError("If using all scalar values, you must pass an index")
                lengths = [0]
            if any(n != lengths[0] for n in lengths):
                raise ValueError("All arrays must be of the same length")
            idx = default_index(lengths[0])
        n = len(idx)
        cols = []
        for k in keys:
            if k not in vals:
                cols.append(column_from([float("nan")] * n, want if want else "object"))
                continue
            v = vals[k]
            if isinstance(v, Series):
                s = v if v.index.equals(idx) else v._pd_reindex(idx)
                col = s._pd_col.copy()
                cols.append(_astype(col, want) if want else col)
            elif _is_scalar(v):
                cols.append(column_from([v] * n, want))
            else:
                col = column_from(v, want)
                if len(col) != n:
                    raise ValueError("Length of values (%d) does not match length of index (%d)" % (len(col), n))
                cols.append(col)
        self._pd_init(cols, Index(keys) if keys else _empty_columns(), idx)

    def _pd_from_list(self, rows, index, columns, want):
        if not rows:
            self._pd_init([], _empty_columns() if columns is None else ensure_index(columns), default_index(0) if index is None else ensure_index(index))
            if columns is not None:
                self._pd_cols = [column_from([], want) for _ in range(len(self._pd_columns))]
            return
        if all(isinstance(r, dict) for r in rows):
            keys = {}
            for r in rows:
                for k in r:
                    keys[k] = True
            labels = list(keys) if columns is None else ensure_index(columns).tolist()
            cols = [column_from([r.get(k, float("nan")) for r in rows], want) for k in labels]
            self._pd_init_checked(cols, labels, index, len(rows))
            return
        if all(isinstance(r, (list, tuple)) for r in rows):
            m = len(rows[0])
            if any(len(r) != m for r in rows):
                raise _unsupported("DataFrame of rows of different lengths (deprecated in pandas 3)")
            if columns is not None and len(ensure_index(columns)) != m:
                raise ValueError("%d columns passed, passed data had %d columns" % (len(ensure_index(columns)), m))
            cols = [column_from([r[j] for r in rows], want) for j in range(m)]
            self._pd_init_checked(cols, columns, index, len(rows))
            return
        if any(isinstance(r, (list, tuple, dict, Series, np.ndarray)) for r in rows):
            raise _unsupported("DataFrame of a list mixing rows and values")
        self._pd_init_checked([column_from(rows, want)], columns, index, len(rows))

    @classmethod
    def _pd_new(cls, cols, columns, index):
        f = cls.__new__(cls)
        f._pd_init(cols, columns, index)
        return f

    # --- attributes --------------------------------------------------------

    @property
    def columns(self):
        return self._pd_columns

    @columns.setter
    def columns(self, value):
        idx = ensure_index(value)
        if len(idx) != len(self._pd_cols):
            raise ValueError("Length mismatch: Expected axis has %d elements, new values have %d elements" % (len(self._pd_cols), len(idx)))
        self._pd_columns = idx

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
    def dtypes(self):
        return Series._pd_new(Column("object", [dtype_object(c.dtype) for c in self._pd_cols]), self._pd_columns.copy())

    @property
    def shape(self):
        return (len(self), len(self._pd_cols))

    @property
    def size(self):
        return len(self) * len(self._pd_cols)

    @property
    def ndim(self):
        return 2

    @property
    def empty(self):
        return len(self) == 0 or len(self._pd_cols) == 0

    @property
    def values(self):
        return self._pd_export("DataFrame.values", False)

    def to_numpy(self, dtype=None, copy=False, na_value=None):
        if dtype is not None or na_value is not None:
            raise _unsupported("DataFrame.to_numpy(dtype=, na_value=)")
        return self._pd_export("DataFrame.to_numpy()", copy)

    def __array__(self, dtype=None, copy=None):
        if dtype is not None:
            raise _unsupported("numpy.asarray(DataFrame, dtype=)")
        return self._pd_export("numpy.asarray(DataFrame)", False)

    def _pd_export(self, what, copy):
        # (r7 §C3: homogeneous numeric -> a read-only copy; int64 with
        # float64 -> a writable float64 copy; any str/object -> rejected)
        d = _common_dtype(self._pd_cols)
        if d not in ("int64", "float64", "bool") or any(c.is_list for c in self._pd_cols):
            raise _unsupported("%s of a frame with %s columns" % (what, "str/object" if any(c.is_list for c in self._pd_cols) else "mixed bool"))
        n, m = self.shape
        a = np.empty((n, m), dtype=d)
        for j, c in enumerate(self._pd_cols):
            a[:, j] = c._pd_values
        homogeneous = all(c.dtype == d for c in self._pd_cols)
        if homogeneous and not copy:
            a.flags.writeable = False
        return a

    def __len__(self):
        return len(self._pd_index)

    def __iter__(self):
        return iter(self._pd_columns.tolist())

    def keys(self):
        return self._pd_columns

    def items(self):
        for j, lab in enumerate(self._pd_columns.tolist()):
            yield lab, self._pd_column_series(j)

    def __contains__(self, key):
        return key in self._pd_columns

    def __bool__(self):
        raise ValueError("The truth value of a DataFrame is ambiguous. Use a.empty, a.item(), a.any() or a.all().")

    def copy(self, deep=True):
        return DataFrame._pd_new([c.copy() for c in self._pd_cols], self._pd_columns.copy(), self._pd_index.copy())

    def head(self, n=5):
        return self._pd_take_rows(_head_positions(len(self), n))

    def tail(self, n=5):
        return self._pd_take_rows(_tail_positions(len(self), n))

    def sample(self, n=None, frac=None, replace=False, weights=None, random_state=None, axis=None, ignore_index=False):
        return self._pd_take_rows(_sample_positions(len(self), n, frac, replace, weights, random_state, axis, ignore_index, "DataFrame"))

    def isna(self):
        return DataFrame._pd_new([Column("bool", c.isna()) for c in self._pd_cols], self._pd_columns.copy(), self._pd_index.copy())

    isnull = isna

    def notna(self):
        return DataFrame._pd_new([Column("bool", ~c.isna()) for c in self._pd_cols], self._pd_columns.copy(), self._pd_index.copy())

    notnull = notna

    @property
    def T(self):
        return self.transpose()

    def transpose(self, *args, copy=False):
        if args:
            raise _unsupported("DataFrame.transpose(*args)")
        d = _common_dtype(self._pd_cols)
        cols = [_column_of(_row_values(self._pd_cols, i, d), d) for i in range(len(self))]
        return DataFrame._pd_new(cols, self._pd_index.copy(), self._pd_columns.copy())

    # --- reductions --------------------------------------------------------

    def _pd_reduce(self, op, axis, skipna, numeric_only, kwargs, min_count=0):
        R.check_args("DataFrame.%s" % op, axis, kwargs, min_count)
        keep = [j for j, c in enumerate(self._pd_cols)
                if not numeric_only or c.dtype in ("int64", "float64", "bool")]
        vals = [R.reduce_column(self._pd_cols[j], op, skipna) for j in keep]
        labels = self._pd_columns._pd_take(keep)
        if op == "count":
            col = Column("int64", np.array([int(v) for v in vals], dtype=np.int64))
        elif numeric_only and any(self._pd_cols[j].dtype == "float64" for j in keep) and op in ("sum", "mean"):
            col = Column("float64", np.array([float(v) for v in vals], dtype=np.float64))
        else:
            col = column_from(vals) if vals else Column("float64" if op != "count" else "int64", np.array([], dtype=np.float64))
        return Series._pd_new(col, labels)

    def sum(self, axis=None, skipna=True, numeric_only=False, min_count=0, **kwargs):
        return self._pd_reduce("sum", axis, skipna, numeric_only, kwargs, min_count)

    def mean(self, axis=None, skipna=True, numeric_only=False, **kwargs):
        return self._pd_reduce("mean", axis, skipna, numeric_only, kwargs)

    def min(self, axis=None, skipna=True, numeric_only=False, **kwargs):
        return self._pd_reduce("min", axis, skipna, numeric_only, kwargs)

    def max(self, axis=None, skipna=True, numeric_only=False, **kwargs):
        return self._pd_reduce("max", axis, skipna, numeric_only, kwargs)

    def count(self, axis=None, numeric_only=False):
        return self._pd_reduce("count", axis, True, numeric_only, {})

    # --- selection ---------------------------------------------------------

    def _pd_column_series(self, j):
        return Series._pd_new(self._pd_cols[j].copy(), self._pd_index.copy(), self._pd_columns[j] if not isinstance(self._pd_columns, RangeIndex) else int(self._pd_columns[j]))

    def _pd_take_rows(self, positions):
        return DataFrame._pd_new([c.take(positions) for c in self._pd_cols], self._pd_columns.copy(), self._pd_index._pd_take(positions))

    def _pd_take_cols(self, positions):
        return DataFrame._pd_new([self._pd_cols[j].copy() for j in positions], self._pd_columns._pd_take(positions), self._pd_index.copy())

    def _pd_row_series(self, i, cols=None):
        js = list(range(len(self._pd_cols))) if cols is None else cols
        sel = [self._pd_cols[j] for j in js]
        d = _common_dtype(sel)
        return Series._pd_new(_column_of(_row_values(sel, i, d), d), self._pd_columns._pd_take(js), self._pd_index[i])

    def _pd_select(self, rows, rscalar, cols, cscalar):
        if rscalar and cscalar:
            return self._pd_cols[cols[0]].value(rows[0])
        if cscalar:
            s = self._pd_column_series(cols[0])
            return s._pd_take(rows)
        if rscalar:
            return self._pd_row_series(rows[0], cols)
        return DataFrame._pd_new([self._pd_cols[j].take(rows) for j in cols], self._pd_columns._pd_take(cols), self._pd_index._pd_take(rows))

    def _pd_col_positions(self, key):
        """Columns for df[key] with a label or a list of labels."""
        if X.is_list_like(key):
            return X.loc_positions(self._pd_columns, key)
        if isinstance(key, tuple):
            raise _unsupported("DataFrame[tuple]")
        p = self._pd_columns._pd_positions(key)
        return ([p], True) if not isinstance(p, list) else (p, False)

    def __getitem__(self, key):
        if isinstance(key, DataFrame):
            raise _unsupported("DataFrame[DataFrame] (where)")
        if isinstance(key, slice):
            rows = X.getitem_slice_positions(self._pd_index, key)
            return self._pd_take_rows(rows)
        if X.is_bool_key(key):
            return self._pd_take_rows(X.mask_positions(key, len(self), self._pd_index))
        cols, scalar = self._pd_col_positions(key)
        if scalar:
            return self._pd_column_series(cols[0])
        return self._pd_take_cols(cols)

    def __getattr__(self, name):
        if not name.startswith("_pd_") and not name.startswith("__"):
            if name in self._pd_columns:
                return self[name]
            from ._pd_names import DATAFRAME
            if name in DATAFRAME:
                raise _unsupported("DataFrame.%s" % name)
        raise AttributeError("'DataFrame' object has no attribute '%s'" % name)

    # (arithmetic is M2's: every operator raises NotImplementedError)
    def __add__(self, other):
        raise _unsupported("DataFrame.__add__ (arithmetic)")

    def __radd__(self, other):
        raise _unsupported("DataFrame.__radd__ (arithmetic)")

    def __sub__(self, other):
        raise _unsupported("DataFrame.__sub__ (arithmetic)")

    def __rsub__(self, other):
        raise _unsupported("DataFrame.__rsub__ (arithmetic)")

    def __mul__(self, other):
        raise _unsupported("DataFrame.__mul__ (arithmetic)")

    def __rmul__(self, other):
        raise _unsupported("DataFrame.__rmul__ (arithmetic)")

    def __truediv__(self, other):
        raise _unsupported("DataFrame.__truediv__ (arithmetic)")

    def __rtruediv__(self, other):
        raise _unsupported("DataFrame.__rtruediv__ (arithmetic)")

    def __floordiv__(self, other):
        raise _unsupported("DataFrame.__floordiv__ (arithmetic)")

    def __rfloordiv__(self, other):
        raise _unsupported("DataFrame.__rfloordiv__ (arithmetic)")

    def __mod__(self, other):
        raise _unsupported("DataFrame.__mod__ (arithmetic)")

    def __rmod__(self, other):
        raise _unsupported("DataFrame.__rmod__ (arithmetic)")

    def __pow__(self, other):
        raise _unsupported("DataFrame.__pow__ (arithmetic)")

    def __rpow__(self, other):
        raise _unsupported("DataFrame.__rpow__ (arithmetic)")

    def __matmul__(self, other):
        raise _unsupported("DataFrame.__matmul__ (arithmetic)")

    def __rmatmul__(self, other):
        raise _unsupported("DataFrame.__rmatmul__ (arithmetic)")

    def __divmod__(self, other):
        raise _unsupported("DataFrame.__divmod__ (arithmetic)")

    def __rdivmod__(self, other):
        raise _unsupported("DataFrame.__rdivmod__ (arithmetic)")

    def __neg__(self):
        raise _unsupported("DataFrame.__neg__ (arithmetic)")

    def __pos__(self):
        raise _unsupported("DataFrame.__pos__ (arithmetic)")

    def __abs__(self):
        raise _unsupported("DataFrame.__abs__ (arithmetic)")

    # (comparisons of frames are M2's too)
    def __eq__(self, other):
        raise _unsupported("DataFrame.__eq__ (comparison)")

    def __ne__(self, other):
        raise _unsupported("DataFrame.__ne__ (comparison)")

    def __lt__(self, other):
        raise _unsupported("DataFrame.__lt__ (comparison)")

    def __le__(self, other):
        raise _unsupported("DataFrame.__le__ (comparison)")

    def __gt__(self, other):
        raise _unsupported("DataFrame.__gt__ (comparison)")

    def __ge__(self, other):
        raise _unsupported("DataFrame.__ge__ (comparison)")

    def __setitem__(self, key, value):
        if isinstance(key, DataFrame):
            raise _unsupported("DataFrame[DataFrame] = value (where)")
        if isinstance(key, slice) or X.is_bool_key(key):
            rows = X.getitem_slice_positions(self._pd_index, key) if isinstance(key, slice) \
                else X.mask_positions(key, len(self), self._pd_index)
            self._pd_set(rows, list(range(len(self._pd_cols))), value)
            return
        if X.is_list_like(key):
            raise _unsupported("DataFrame[list of labels] = value")
        self._pd_set_column(key, value)

    def _pd_set_column(self, label, value):
        """df[label] = value: replace (or add) the whole column."""
        n = len(self)
        if isinstance(value, DataFrame):
            raise _unsupported("DataFrame[label] = DataFrame")
        if isinstance(value, Series):
            s = value if value.index.equals(self._pd_index) else value._pd_reindex(self._pd_index)
            col = s._pd_col.copy()
        elif _is_scalar(value):
            col = column_from([value] * n)
        else:
            col = column_from(value)
            if not len(self._pd_cols) and not n:
                # (the first column of an empty frame sets its length)
                self._pd_index = default_index(len(col))
            elif len(col) != n:
                raise ValueError("Length of values (%d) does not match length of index (%d)" % (len(col), n))
        try:
            p = self._pd_columns._pd_positions(label)
        except KeyError:
            p = None
        if p is None:
            self._pd_cols.append(col)
            self._pd_columns = Index(self._pd_columns.tolist() + [label]) if len(self._pd_columns) or not isinstance(self._pd_columns, RangeIndex) else Index([label])
        elif isinstance(p, list):
            raise _unsupported("setting a duplicated column label")
        else:
            self._pd_cols[p] = col

    def _pd_set(self, rows, cols, value):
        """Set the cells rows x cols: value a scalar, a list per row (one
        column), a row (one row), or a list of rows."""
        nr, nc = len(rows), len(cols)
        if isinstance(value, DataFrame):
            raise _unsupported("setting cells from a DataFrame")
        if _is_scalar(value):
            for j in cols:
                self._pd_cols[j] = set_values(self._pd_cols[j], rows, [value] * nr)
            return
        vals = value.tolist() if isinstance(value, (Series, np.ndarray)) else list(value)
        if nc == 1:
            if len(vals) != nr:
                raise ValueError("Must have equal len keys and value when setting with an iterable")
            self._pd_cols[cols[0]] = set_values(self._pd_cols[cols[0]], rows, vals)
            return
        if nr == 1 and len(vals) == nc and not any(isinstance(v, (list, tuple)) for v in vals):
            for j, v in zip(cols, vals):
                self._pd_cols[j] = set_values(self._pd_cols[j], rows, [v])
            return
        if len(vals) == nr and all(isinstance(v, (list, tuple)) and len(v) == nc for v in vals):
            for k, j in enumerate(cols):
                self._pd_cols[j] = set_values(self._pd_cols[j], rows, [r[k] for r in vals])
            return
        raise ValueError("Must have equal len keys and value when setting with an iterable")

    def _pd_enlarge_row(self, label, value):
        """df.loc[new_label] = value: append a row."""
        nc = len(self._pd_cols)
        vals = _broadcast(value, nc) if not _is_scalar(value) else [value] * nc
        cols = []
        for c, v in zip(self._pd_cols, vals):
            old = c.tolist()
            d = c.dtype
            try:
                cols.append(column_from(old + [v], d if infer([v]) == d or (d == "float64" and infer([v]) == "int64") else None))
            except (TypeError, ValueError):
                cols.append(column_from(old + [v]))
        self._pd_cols = cols
        self._pd_index = Index(self._pd_index.tolist() + [label], name=self._pd_index.name)

    @property
    def loc(self):
        return _FrameLoc(self)

    @property
    def iloc(self):
        return _FrameILoc(self)

    # --- reprs -------------------------------------------------------------

    def __repr__(self):
        return _pd_repr.frame_repr(self)

    __str__ = __repr__

    def _repr_html_(self):
        return _pd_repr.frame_repr_html(self)

    def to_string(self, *args, **kwargs):
        if args or kwargs:
            raise _unsupported("DataFrame.to_string arguments")
        return _pd_repr.frame_repr(self)

    __hash__ = None


def _empty_columns():
    return RangeIndex(0, 0)


def _is_all(k):
    return isinstance(k, slice) and k.start is None and k.stop is None and k.step is None


def _split(key):
    if isinstance(key, tuple):
        if len(key) != 2:
            from .errors import IndexingError
            raise IndexingError("Too many indexers")
        return key[0], key[1]
    return key, slice(None)


class _FrameILoc(object):
    __slots__ = ("_pd_obj",)

    def __init__(self, obj):
        self._pd_obj = obj

    def __getitem__(self, key):
        f = self._pd_obj
        rk, ck = _split(key)
        rows, rs = X.iloc_positions(rk, len(f))
        cols, cs = X.iloc_positions(ck, len(f._pd_cols), axis=1)
        return f._pd_select(rows, rs, cols, cs)

    def __setitem__(self, key, value):
        f = self._pd_obj
        rk, ck = _split(key)
        rows, rs = X.iloc_positions(rk, len(f))
        cols, cs = X.iloc_positions(ck, len(f._pd_cols), axis=1)
        f._pd_set(rows, cols, value)


class _FrameLoc(object):
    __slots__ = ("_pd_obj",)

    def __init__(self, obj):
        self._pd_obj = obj

    def __getitem__(self, key):
        f = self._pd_obj
        rk, ck = _split(key)
        rows, rs = X.loc_positions(f._pd_index, rk)
        cols, cs = X.loc_positions(f._pd_columns, ck)
        return f._pd_select(rows, rs, cols, cs)

    def __setitem__(self, key, value):
        f = self._pd_obj
        rk, ck = _split(key)
        # (a new column label with all rows: added, as df[label] = value)
        if X.is_scalar_key(ck) and ck not in f._pd_columns:
            if _is_all(rk):
                f._pd_set_column(ck, value)
                return
            raise _unsupported("DataFrame.loc[rows, new_label] = value")
        if X.is_scalar_key(rk) and rk not in f._pd_index:
            if _is_all(ck):
                f._pd_enlarge_row(rk, value)
                return
            raise _unsupported("DataFrame.loc[new_label, columns] = value")
        rows, rs = X.loc_positions(f._pd_index, rk)
        cols, cs = X.loc_positions(f._pd_columns, ck)
        f._pd_set(rows, cols, value)
