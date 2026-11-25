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
    if dtype is None or dtype is bool or dtype == "bool":
        return "bool"
    if dtype is int or dtype in ("int64", "int"):
        return "int64"
    if dtype is float or dtype in ("float64", "float"):
        return "float64"
    raise _unsupported("dtype=%r" % (dtype,))


def _categories_and_codes(col):
    from . import _pd_category as CT
    enc = col if isinstance(col, CT.CatColumn) else CT.column_to_category(col)
    return enc.dtype.categories.tolist(), enc._pd_codes.tolist()


def _label(prefix, sep, value):
    if prefix is None:
        return value
    return "%s%s%s" % (prefix, sep, "nan" if is_missing(value) else value)


def _encode(col, prefix, sep, dummy_na, drop_first, d):
    cats, codes = _categories_and_codes(col)
    n = len(codes)
    labels, cols = [], []
    for k, cat in enumerate(cats):
        labels.append(_label(prefix, sep, cat))
        cols.append(np.array([c == k for c in codes], dtype=bool))
    if dummy_na:
        labels.append(_label(prefix, sep, float("nan")))
        cols.append(np.array([c < 0 for c in codes], dtype=bool))
    if drop_first:
        labels, cols = labels[1:], cols[1:]
    return labels, [Column(d, a.astype(d) if d != "bool" else a) for a in cols]


def get_dummies(data, prefix=None, prefix_sep="_", dummy_na=False, columns=None, sparse=False, drop_first=False,
                dtype=None):
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    from ._pd_index import Index, default_index
    from . import _pd_category as CT
    if sparse:
        raise _unsupported("sparse=True")
    if not isinstance(prefix_sep, str):
        raise _unsupported("prefix_sep of a %s" % type(prefix_sep).__name__)
    d = _out_dtype(dtype)
    if isinstance(data, DataFrame):
        f = data
        names = f.columns.tolist()
        if columns is None:
            js = [j for j, c in enumerate(f._pd_cols) if c.dtype is STR or c.dtype == "object"
                  or isinstance(c, CT.CatColumn)]
        else:
            if isinstance(columns, str) or not isinstance(columns, (list, tuple, Index)):
                raise TypeError("Input must be a list-like for parameter `columns`")
            want = list(columns)
            js = []
            for lab in want:
                if lab not in names:
                    raise KeyError("None of [Index(%r, dtype='object')] are in the [columns]" % (want,))
                js.append(names.index(lab))
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
        keep = [j for j in range(len(f._pd_cols)) if j not in js]
        labels = [names[j] for j in keep]
        cols = [f._pd_cols[j].copy() for j in keep]
        for j, p in zip(js, prefixes):
            ls, cs = _encode(f._pd_cols[j], p, prefix_sep, dummy_na, drop_first, d)
            labels += ls
            cols += cs
        return DataFrame._pd_new(cols, Index(labels) if labels else Index([], dtype=object), f._pd_index.copy())
    if columns is not None:
        raise _unsupported("columns= of a Series")
    if isinstance(data, Series):
        col, index = data._pd_col, data._pd_index.copy()
    else:
        col = column_from(data)
        index = default_index(len(col))
    if isinstance(prefix, (list, tuple, dict)):
        raise _unsupported("a list or dict prefix of a Series")
    labels, cols = _encode(col, prefix, prefix_sep, dummy_na, drop_first, d)
    return DataFrame._pd_new(cols, Index(labels) if labels else Index([], dtype=object), index)
