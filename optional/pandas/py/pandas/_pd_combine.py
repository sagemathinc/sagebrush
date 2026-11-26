"""concat, melt, drop and value_counts' helpers: columns and indexes joined
end to end with pandas 3.1's concat rules, the labels drop keeps, and the
counts of one column's values."""

import numpy as np

from ._pd_column import Column
from ._pd_dtypes import INTS, FLOATS
from ._pd_datetime import DT, NAT_INT
from . import _pd_indexing as X

__all__ = ["join_dtype", "join_columns", "join_indexes", "join_labels", "keep_positions", "kept_index", "count_values"]


def join_dtype(dtypes, gap):
    """The dtype of columns joined end to end, as pandas 3.1's concat gives
    it; gap: some rows have none of the column (missing values there), which
    makes an integer column float64 and a bool one object."""
    if not dtypes:
        return "float64" if gap else "object"
    d0 = dtypes[0]
    if all(d == d0 for d in dtypes):
        d = d0
    elif all(d in INTS or d in FLOATS for d in dtypes):
        # (numpy's promotion: uint8 with int8 is int16, any integer with float64 float64)
        d = str(np.result_type(*dtypes))
    else:
        d = "object"
    if gap and d in INTS:
        return "float64"
    if gap and d == "bool":
        return "object"
    return d


def join_columns(parts):
    """One column of parts end to end: each part a Column, or an int (that
    many missing values, for an object that hasn't the column)."""
    gap = any(not isinstance(p, Column) and p > 0 for p in parts)
    d = join_dtype([p.dtype for p in parts if isinstance(p, Column)], gap)
    if d in INTS or d in FLOATS or d == "bool":
        arrays = [p._pd_values.astype(d) if isinstance(p, Column) else np.full(p, np.nan, dtype=d) for p in parts if not isinstance(p, int) or p]
        return Column(d, np.concatenate(arrays) if arrays else np.array([], dtype=d))
    if d is DT:
        arrays = [p._pd_values if isinstance(p, Column) else np.full(p, NAT_INT, dtype=np.int64) for p in parts]
        return Column(DT, np.concatenate(arrays) if arrays else np.array([], dtype=np.int64))
    out = []
    for p in parts:
        out.extend(p.tolist() if isinstance(p, Column) else [float("nan")] * p)
    return Column(d, out)


def _joined_range(indexes):
    # (pandas' RangeIndex._concat: ranges that continue one another stay a
    # range; None where they don't)
    start = step = next_ = None
    nonempty = [ix for ix in indexes if len(ix)]
    for ix in nonempty:
        r = range(ix.start, ix.stop, ix.step)
        if start is None:
            start = r.start
            if step is None and len(r) > 1:
                step = r.step
        elif step is None:
            if r.start == start:
                return None
            step = r.start - start
        if (step != r.step and len(r) > 1) or (next_ is not None and r.start != next_):
            return None
        if step is not None:
            next_ = r[-1] + step
    if not nonempty:
        return (0, 0, 1)
    stop = nonempty[-1].stop if next_ is None else next_
    if len(nonempty) == 1:
        step = nonempty[0].step
    return (start, stop, step if step is not None else 1)


def _as_range(values, step):
    # (pandas' RangeIndex._shallow_copy: integer labels evenly spaced are a
    # range again; one label a range of the first index's step)
    if len(values) == 1:
        return (values[0], values[0] + step, step)
    if not values:
        return (0, 0, 1)
    d = values[1] - values[0]
    if d != 0 and all(values[i + 1] - values[i] == d for i in range(len(values) - 1)):
        return (values[0], values[-1] + d, d)
    return None


def _common_name(indexes):
    names = [ix.name for ix in indexes]
    return names[0] if all(n == names[0] for n in names[1:]) else None


def join_indexes(indexes):
    """The indexes end to end, named when all share one name: an Index of
    their labels (concat's dtype rules), but a RangeIndex as pandas' after a
    first RangeIndex: where all are ranges that continue one another, or
    where some aren't ranges and the integer labels are evenly spaced."""
    from ._pd_index import Index, RangeIndex
    name = _common_name(indexes)
    first = indexes[0]
    if isinstance(first, RangeIndex) and len(indexes) == 1:
        return first.copy(name=name)
    if isinstance(first, RangeIndex) and all(isinstance(ix, RangeIndex) for ix in indexes):
        r = _joined_range(indexes)
        if r is not None:
            return RangeIndex(r[0], r[1], r[2], name=name)
        return Index(join_columns([ix._pd_column() for ix in indexes]), name=name)
    col = join_columns([ix._pd_column() for ix in indexes])
    if isinstance(first, RangeIndex) and col.dtype in INTS and not col.dtype.startswith("u"):
        r = _as_range(col._pd_values.tolist(), first.step)
        if r is not None:
            return RangeIndex(r[0], r[1], r[2], name=name)
    return Index(col, name=name)


def join_labels(indexes, how, sort):
    """The labels of the other axis: the union of indexes in order of first
    appearance (how='outer') or the labels every index has, in the first
    one's order (how='inner'); sorted if sort and they differ. None when all
    are equal (the first is kept as it is)."""
    from ._pd_index import Index
    first = indexes[0]
    if all(ix.equals(first) for ix in indexes[1:]):
        return None
    if how == "inner":
        others = [set(_keys(ix)) for ix in indexes[1:]]
        labels = [lab for lab in first.tolist() if all(lab in o for o in others)]
    else:
        seen = {}
        for ix in indexes:
            for lab in ix.tolist():
                if lab not in seen:
                    seen[lab] = True
        labels = list(seen)
    if sort:
        try:
            labels = sorted(labels)
        except TypeError:
            pass
    return Index(labels, name=_common_name(indexes))


def _keys(index):
    return index.tolist()


def keep_positions(index, labels, errors):
    """The positions drop keeps: all but those of labels (a label or a list
    of them; every position of a repeated one). A label the index hasn't
    raises pandas' KeyError unless errors='ignore'."""
    labs = list(labels) if X.is_list_like(labels) else [labels]
    gone = set()
    missing = []
    for lab in labs:
        try:
            p = index._pd_positions(lab)
        except KeyError:
            missing.append(lab)
            continue
        gone.update(p if isinstance(p, list) else [p])
    if missing and errors != "ignore":
        raise KeyError("%r not found in axis" % (missing,))
    return [i for i in range(len(index)) if i not in gone]


def kept_index(index, positions):
    """The index at positions (increasing) after a drop: a RangeIndex keeps
    the rows it keeps as a slice of its range where they are one (pandas'
    delete, Python's range slicing: range(6) without 1, 3 and 5 is range(0, 6, 2)),
    else as a take."""
    from ._pd_index import RangeIndex
    if isinstance(index, RangeIndex):
        r = range(index.start, index.stop, index.step)
        s = None
        if not positions:
            s = r[0:0]
        elif len(positions) == 1:
            s = r[positions[0]:positions[0] + 1]
        else:
            d = positions[1] - positions[0]
            if all(positions[i + 1] - positions[i] == d for i in range(len(positions) - 1)):
                # (pandas' maybe_indices_to_slice: the slice runs one step past the last row kept)
                s = r[positions[0]:positions[-1] + d:d]
        if s is not None:
            return RangeIndex(s.start, s.stop, s.step, name=index.name)
    return index._pd_take(positions)


def count_values(col, dropna):
    """Each distinct value's first position and count, in order of first
    appearance; the missing values counted as one (where dropna is False)."""
    raw = col._pd_values if col.is_list else col._pd_values.tolist()
    missing = col.isna().tolist()
    first, counts, slot = [], [], {}
    na_slot = None
    for i, (v, m) in enumerate(zip(raw, missing)):
        if m:
            if dropna:
                continue
            if na_slot is None:
                na_slot = len(first)
                first.append(i)
                counts.append(0)
            counts[na_slot] += 1
            continue
        k = slot.get(v)
        if k is None:
            k = slot[v] = len(first)
            first.append(i)
            counts.append(0)
        counts[k] += 1
    return first, counts
