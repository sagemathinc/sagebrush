"""pd.get_dummies, as pandas 3.1 encodes: one indicator column per category
(the distinct values present, sorted, or a category column's own
categories, unused ones too), named by the value, or prefix + prefix_sep +
value; dummy_na adds one for missing values, drop_first drops the first;
bool by default, or dtype=int/float. A frame encodes its str, object and
category columns (or `columns`), after the others, in their order."""

import numpy as np

from ._pd_column import Column, column_from
from ._pd_dtypes import STR, is_missing


def _unsupported(what):
    return NotImplementedError("pandas.get_dummies(%s) is not in Sagebrush's pandas 0.x subset" % what)


def _out_dtype(dtype):
    if dtype is object or (isinstance(dtype, str) and dtype in ("object", "O")) or \
            (isinstance(dtype, np.dtype) and dtype.kind == "O"):
        raise ValueError("dtype=object is not a valid dtype for get_dummies")
    if dtype is None or dtype is bool or dtype == "bool":
        return "bool"
    if dtype is int or dtype in ("int64", "int"):
        return "int64"
    if dtype is float or dtype in ("float64", "float"):
        return "float64"
    raise _unsupported("dtype=%r" % (dtype,))


def _categories_and_codes(col):
    # (a category column's own categories; otherwise the distinct values present, sorted as pandas sorts them, of
    # any dtype: float32, smaller ints and times too)
    from . import _pd_category as CT
    if isinstance(col, CT.CatColumn):
        return col.dtype.categories.tolist(), col._pd_codes.tolist()
    values = col.tolist()
    cats = CT.sorted_unique(values)
    pos = dict((v, k) for k, v in enumerate(cats))
    return cats, [-1 if is_missing(v) else pos[v] for v in values]


def _label(prefix, sep, value):
    if prefix is None:
        return value
    from ._pd_datetime import NaT
    # (a time column's missing value is NaT, and its label says so)
    return "%s%s%s" % (prefix, sep, "NaT" if value is NaT else "nan" if is_missing(value) else value)


def _encode(col, prefix, sep, dummy_na, drop_first, d):
    """The labels, the indicator columns, and the labels before drop_first
    (whose types give the label Index its dtype)."""
    from ._pd_datetime import DT, NaT
    cats, codes = _categories_and_codes(col)
    labels, cols = [], []
    for k, cat in enumerate(cats):
        labels.append(_label(prefix, sep, cat))
        cols.append(np.array([c == k for c in codes], dtype=bool))
    if dummy_na:
        labels.append(_label(prefix, sep, NaT if col.dtype == DT else float("nan")))
        cols.append(np.array([c < 0 for c in codes], dtype=bool))
    full = labels
    if drop_first:
        labels, cols = labels[1:], cols[1:]
    return labels, [Column(d, a.astype(d) if d != "bool" else a) for a in cols], full


# (the dtypes an Index holds in the subset: a source of another dtype, int8 or float32, labels the columns with an
# Index of its own dtype in pandas)
_LABEL_DTYPES = ("int64", "float64", "bool", "object")


def _label_index(col, labels, full, prefix):
    """The columns' Index of a Series' or list's dummies, as pandas types it."""
    from ._pd_index import Index, default_index
    from ._pd_datetime import DT
    from . import _pd_category as CT
    if not labels:
        return default_index(0)
    if prefix is not None:
        return Index(labels)
    if col.dtype == "object" and not all(is_missing(v) for v in full):
        # (an object column's values: an object Index, as pandas' categories of it are)
        return Index(labels, dtype=object)
    if isinstance(col, CT.CatColumn):
        # (pandas makes a CategoricalIndex, of the categories' own values: int categories stay ints beside a nan)
        if len(full) > len(col.dtype.categories) and col.dtype.categories.dtype == "int64":
            return Index(labels, dtype=object)
    elif not (col.dtype is STR or col.dtype == DT or str(col.dtype) in _LABEL_DTYPES):
        raise NotImplementedError("pandas: get_dummies of a Series of dtype %s without a prefix is not in Sagebrush's "
                                  "pandas 0.x subset" % col.dtype)
    return Index(labels, dtype=Index(full).dtype)


def get_dummies(data, prefix=None, prefix_sep="_", dummy_na=False, columns=None, sparse=False, drop_first=False,
                dtype=None):
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    from ._pd_index import Index, default_index
    from . import _pd_category as CT
    if sparse:
        raise _unsupported("sparse=True")
    d = _out_dtype(dtype)
    if isinstance(data, DataFrame):
        f = data
        if not f._pd_cols:
            # (pandas concatenates the frame's parts, of which there are none)
            raise ValueError("No objects to concatenate")
        names = f.columns.tolist()
        if columns is None:
            js = [j for j, c in enumerate(f._pd_cols) if c.dtype is STR or c.dtype == "object"
                  or isinstance(c, CT.CatColumn)]
        else:
            if isinstance(columns, str) or not isinstance(columns, (list, tuple, Index)):
                raise TypeError("Input must be a list-like for parameter `columns`")
            want = list(columns)
            absent = [lab for lab in want if lab not in names]
            if absent and len(absent) == len(want):
                raise KeyError("None of [%r] are in the [columns]" % (Index(want),))
            if absent:
                raise KeyError("%r not in index" % (absent,))
            # (every column with a label given: repeated labels are all encoded, as pandas selects them)
            js = [j for lab in want for j, name in enumerate(names) if name == lab]
        for what, given in (("prefix", prefix), ("prefix_sep", prefix_sep)):
            # (a list or dict per encoded column: its length checked first, as pandas checks it)
            if isinstance(given, (list, tuple, dict)) and len(given) != len(js):
                raise ValueError("Length of '%s' (%d) did not match the length of the columns being encoded (%d)."
                                 % (what, len(given), len(js)))
        if isinstance(prefix_sep, (list, tuple)):
            if len(prefix_sep) != len(js):
                raise ValueError("Length of 'prefix_sep' (%d) did not match the length of the columns being encoded "
                                 "(%d)." % (len(prefix_sep), len(js)))
            seps = list(prefix_sep)
        elif isinstance(prefix_sep, dict):
            seps = [prefix_sep[names[j]] for j in js]
        elif isinstance(prefix_sep, str):
            seps = [prefix_sep] * len(js)
        else:
            raise TypeError("'%s' object is not iterable" % type(prefix_sep).__name__)
        if isinstance(prefix, (list, tuple)):
            if len(prefix) != len(js):
                raise ValueError("Length of 'prefix' (%d) did not match the length of the columns being encoded (%d)."
                                 % (len(prefix), len(js)))
            prefixes = list(prefix)
        elif isinstance(prefix, dict):
            prefixes = [prefix[names[j]] for j in js]
        elif isinstance(prefix, str):
            prefixes = [prefix] * len(js)
        elif prefix is None:
            prefixes = [names[j] for j in js]
        else:
            raise _unsupported("prefix of a %s" % type(prefix).__name__)
        keep = [j for j in range(len(f._pd_cols)) if j not in set(js)]
        labels = [names[j] for j in keep]
        cols = [f._pd_cols[j].copy() for j in keep]
        for j, p, sep in zip(js, prefixes, seps):
            ls, cs, full = _encode(f._pd_cols[j], p, sep, dummy_na, drop_first, d)
            labels += ls
            cols += cs
        return DataFrame._pd_new(cols, Index(labels) if labels else default_index(0), f._pd_index.copy())
    # (columns= means nothing for a Series: pandas ignores it)
    if isinstance(data, Series):
        col, index = data._pd_col, data._pd_index.copy()
    else:
        col = column_from(data)
        index = default_index(len(col))
    if isinstance(prefix, (list, tuple, dict)) or not isinstance(prefix_sep, str):
        # (pandas pastes such a prefix's or separator's text into the labels)
        raise _unsupported("a list or dict prefix or prefix_sep of a Series")
    labels, cols, full = _encode(col, prefix, prefix_sep, dummy_na, drop_first, d)
    return DataFrame._pd_new(cols, _label_index(col, labels, full, prefix), index)
