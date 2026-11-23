"""pd.isna and pd.notna (plan-pandas-m1-r1 §0)."""

import numpy as np

from ._pd_dtypes import is_missing

__all__ = ["isna", "notna", "isnull", "notnull", "concat", "melt"]


def isna(obj):
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    from ._pd_index import Index
    if isinstance(obj, (Series, DataFrame)):
        return obj.isna()
    if isinstance(obj, Index):
        return obj._pd_column().isna()
    if isinstance(obj, np.ndarray):
        if str(obj.dtype) == "float64":
            return obj != obj
        return np.zeros(obj.shape, dtype=bool)
    if isinstance(obj, (list, tuple)):
        return np.array([is_missing(v) for v in obj], dtype=bool)
    return is_missing(obj)


def notna(obj):
    r = isna(obj)
    if isinstance(r, bool):
        return not r
    return ~r


isnull = isna
notnull = notna


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


# (concat's sort and copy when not given)
_NO_DEFAULT = object()


def _axis_number(axis):
    if axis in (0, "index", "rows"):
        return 0
    if axis in (1, "columns"):
        return 1
    raise ValueError("No axis named %s for object type DataFrame" % (axis,))


def concat(objs, *, axis=0, join="outer", ignore_index=False, keys=None, levels=None, names=None,
           verify_integrity=False, sort=_NO_DEFAULT, copy=_NO_DEFAULT, union_categories=False):
    """Series and DataFrames end to end (axis=0: their rows, the union of
    their columns, or the shared ones with join='inner') or side by side
    (axis=1: their columns, aligned on the union or the intersection of
    their row labels), with pandas 3.1's dtype rules (see _pd_combine)."""
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    if isinstance(objs, dict) or keys is not None or levels is not None or names is not None:
        raise _unsupported("concat(a dict, keys=, levels=, names=) (a MultiIndex)")
    if union_categories:
        raise _unsupported("concat(union_categories=)")
    if copy is not _NO_DEFAULT:
        import warnings
        from .errors import Pandas4Warning
        warnings.warn("The copy keyword is deprecated and will be removed in a future version. Copy-on-Write is active in "
                      "pandas since 3.0 which utilizes a lazy copy mechanism that defers copies until necessary. Use "
                      ".copy() to make an eager copy if necessary.", Pandas4Warning, stacklevel=2)
    if isinstance(objs, (Series, DataFrame, str)):
        raise TypeError('first argument must be an iterable of pandas objects, you passed an object of type "%s"' % type(objs).__name__)
    objs = list(objs)
    if not objs:
        raise ValueError("No objects to concatenate")
    objs = [o for o in objs if o is not None]
    if not objs:
        raise ValueError("All objects passed were None")
    for o in objs:
        if not isinstance(o, (Series, DataFrame)):
            raise TypeError("cannot concatenate object of type '%s'; only Series and DataFrame objs are valid" % (type(o),))
    ax = _axis_number(axis)
    if join not in ("inner", "outer"):
        raise ValueError("Only can inner (intersect) or outer (union) join the other axis")
    sort = False if sort is _NO_DEFAULT else bool(sort)
    if ax == 0:
        out = _concat_rows(objs, join, ignore_index, sort)
        if verify_integrity:
            _verify(out.index)
        return out
    out = _concat_columns(objs, join, ignore_index, sort)
    if verify_integrity:
        _verify(out.columns)
    return out


def _verify(index):
    from ._pd_index import Index
    seen, dups = {}, {}
    for lab in index.tolist():
        if lab in seen:
            dups[lab] = True
        seen[lab] = True
    if dups:
        raise ValueError("Indexes have overlapping values: %r" % (Index(list(dups)),))


def _concat_rows(objs, join, ignore_index, sort):
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    from ._pd_index import Index, default_index
    from . import _pd_combine as CB
    if all(isinstance(o, Series) for o in objs):
        col = CB.join_columns([o._pd_col for o in objs])
        index = default_index(len(col)) if ignore_index else CB.join_indexes([o.index for o in objs])
        names = [o.name for o in objs]
        return Series._pd_new(col, index, names[0] if all(n == names[0] for n in names[1:]) else None)
    # (a Series among frames is one column, named after it or 0)
    frames = [o if isinstance(o, DataFrame) else
              DataFrame._pd_new([o._pd_col.copy()], Index([0 if o.name is None else o.name]), o.index.copy()) for o in objs]
    labels = CB.join_labels([f.columns for f in frames], join, sort)
    if labels is None:
        columns = frames[0].columns.copy()
        cols = [CB.join_columns([f._pd_cols[j] for f in frames]) for j in range(len(frames[0]._pd_cols))]
    else:
        columns = labels
        cols = []
        for lab in labels.tolist():
            parts = []
            for f in frames:
                try:
                    p = f.columns._pd_positions(lab)
                except KeyError:
                    parts.append(len(f))
                    continue
                if isinstance(p, list):
                    raise _unsupported("concat of frames with a repeated column label")
                parts.append(f._pd_cols[p])
            cols.append(CB.join_columns(parts))
    n = sum(len(f) for f in frames)
    index = default_index(n) if ignore_index else CB.join_indexes([f.index for f in frames])
    return DataFrame._pd_new(cols, columns if isinstance(columns, Index) else Index(columns), index)


def _concat_columns(objs, join, ignore_index, sort):
    from ._pd_frame import DataFrame
    from ._pd_index import Index, default_index
    from . import _pd_combine as CB
    rows = CB.join_labels([o.index for o in objs], join, sort)
    index = objs[0].index.copy() if rows is None else rows
    cols, labels = [], []
    unnamed = 0
    for o in objs:
        if isinstance(o, DataFrame):
            pieces = [(lab, c) for lab, c in zip(o.columns.tolist(), o._pd_cols)]
        else:
            if o.name is None:
                lab, unnamed = unnamed, unnamed + 1
            else:
                lab = o.name
            pieces = [(lab, o._pd_col)]
        for lab, c in pieces:
            labels.append(lab)
            cols.append(c.copy() if rows is None else _aligned(c, o.index, index))
    columns = default_index(len(cols)) if ignore_index else Index(labels)
    return DataFrame._pd_new(cols, columns, index)


def _aligned(col, old, new):
    # (col, labelled by old, at the labels of new: missing values where old hasn't one)
    from ._pd_column import column_from
    positions = []
    for lab in new.tolist():
        try:
            p = old._pd_positions(lab)
        except KeyError:
            positions.append(None)
            continue
        if isinstance(p, list):
            from .errors import InvalidIndexError
            raise InvalidIndexError("Reindexing only valid with uniquely valued Index objects")
        positions.append(p)
    if all(p is not None for p in positions):
        return col.take(positions)
    return column_from([float("nan") if p is None else col.value(p) for p in positions])


def melt(frame, id_vars=None, value_vars=None, var_name=None, value_name="value", col_level=None, ignore_index=True):
    """pd.melt: DataFrame.melt of frame."""
    from ._pd_frame import DataFrame
    if not isinstance(frame, DataFrame):
        raise _unsupported("melt of a %s" % type(frame).__name__)
    return frame.melt(id_vars=id_vars, value_vars=value_vars, var_name=var_name, value_name=value_name,
                      col_level=col_level, ignore_index=ignore_index)
