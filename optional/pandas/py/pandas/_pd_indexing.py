"""Resolving keys to positions for [], .loc and .iloc (plan-pandas-m1-r1
§0), with pandas 3.1.0's rules as measured on the oracle:

- [] on a Series: a scalar is a label (never a position, pandas 3); a slice
  of ints is positional, unless the index is float64; a bool list, array or
  Series is a mask; a list is labels.
- .loc: labels, label slices including both ends, masks.
- .iloc: positions, slices, masks, with IndexError out of bounds.

Each resolver returns (positions, scalar): a list of ints, and whether the
key selected one item (so the result drops that axis).
"""

import bisect

import numpy as np

from ._pd_dtypes import is_missing

__all__ = ["is_list_like", "is_bool_key", "iloc_positions", "loc_positions", "getitem_slice_positions"]


def _ns():
    from ._pd_index import Index
    from ._pd_series import Series
    return Index, Series


def is_list_like(key):
    Index, Series = _ns()
    return isinstance(key, (list, np.ndarray, Index, Series, range))


def _bool_values(key):
    """The mask's values as a list of bool, or None if key isn't a mask."""
    Index, Series = _ns()
    if isinstance(key, Series):
        if key.dtype != "bool":
            return None
        return key._pd_col.tolist()
    if isinstance(key, np.ndarray):
        return key.tolist() if str(key.dtype) == "bool" else None
    if isinstance(key, list) and key and all(isinstance(k, (bool, np.bool_)) for k in key):
        return [bool(k) for k in key]
    return None


def is_bool_key(key):
    return _bool_values(key) is not None


def mask_positions(key, n, index=None, what="Item"):
    """The positions a bool mask selects; a Series mask must have index."""
    Index, Series = _ns()
    if isinstance(key, Series) and index is not None and not key.index.equals(index):
        raise NotImplementedError("pandas: a boolean Series indexer with a different index is not in Sagebrush's pandas 0.x subset")
    vals = _bool_values(key)
    if len(vals) != n:
        if isinstance(key, Series) or what == "Item":
            raise ValueError("Item wrong length %d instead of %d." % (len(vals), n))
        raise IndexError("Boolean index has wrong length: %d instead of %d" % (len(vals), n))
    return [i for i, b in enumerate(vals) if b]


def _is_int(k):
    return isinstance(k, (int, np.integer)) and not isinstance(k, (bool, np.bool_))


def iloc_positions(key, n, axis=0):
    """Positions for .iloc[key] on an axis of length n (axis 1: a frame's
    columns, whose out-of-bounds message is numpy's)."""
    if isinstance(key, tuple):
        from .errors import IndexingError
        raise IndexingError("Too many indexers")
    if _is_int(key):
        k = int(key)
        if k < -n or k >= n:
            if axis == 1:
                raise IndexError("index %d is out of bounds for axis 0 with size %d" % (k, n))
            raise IndexError("single positional indexer is out-of-bounds")
        return [k % n if k < 0 else k], True
    if isinstance(key, slice):
        for part in (key.start, key.stop, key.step):
            if part is not None and not _is_int(part):
                raise TypeError("cannot do positional indexing on RangeIndex with these indexers [%s] of type %s"
                                % (part, type(part).__name__))
        return list(range(*key.indices(n))), False
    if is_bool_key(key):
        Index, Series = _ns()
        if isinstance(key, Series):
            raise ValueError("iLocation based boolean indexing cannot use an indexable as a mask")
        return mask_positions(key, n, what="iloc"), False
    if is_list_like(key):
        Index, Series = _ns()
        vals = key.tolist() if isinstance(key, (np.ndarray, Index, Series)) else list(key)
        out = []
        for k in vals:
            if not _is_int(k):
                raise IndexError(".iloc requires numeric indexers, got %r" % (vals,))
            k = int(k)
            if k < -n or k >= n:
                raise IndexError("positional indexers are out-of-bounds")
            out.append(k % n if k < 0 else k)
        return out, False
    raise TypeError("Cannot index by location index with a non-integer key")


def _label_list(index, labels):
    out = []
    missing = []
    for lab in labels:
        try:
            p = index._pd_positions(lab)
        except KeyError:
            missing.append(lab)
            continue
        if isinstance(p, list):
            out.extend(p)
        else:
            out.append(p)
    if missing:
        raise KeyError("%r not in index" % (missing,))
    return out


def _slice_bound(index, label, side):
    """The position of a label slice's start (side 'left') or its end + 1
    (side 'right')."""
    try:
        p = index._pd_positions(label)
    except KeyError:
        p = None
    if isinstance(p, list):
        if p != list(range(p[0], p[-1] + 1)):
            raise KeyError("Cannot get %s slice bound for non-unique label: %r" % (side, label))
        return p[0] if side == "left" else p[-1] + 1
    if p is not None:
        return p if side == "left" else p + 1
    # (a missing label: by sorted position on a monotonic index, increasing
    # or decreasing, else KeyError)
    vals = index.tolist()
    try:
        increasing = all(vals[i] <= vals[i + 1] for i in range(len(vals) - 1))
        decreasing = not increasing and all(vals[i] >= vals[i + 1] for i in range(len(vals) - 1))
    except TypeError:
        increasing = decreasing = False
    if not increasing and not decreasing:
        raise KeyError("Cannot get %s slice bound for non-monotonic index with a missing label %r. "
                       "Either sort the index or specify an existing label." % (side, label))
    try:
        if increasing:
            return bisect.bisect_left(vals, label) if side == "left" else bisect.bisect_right(vals, label)
        # (decreasing: the start is the first label below `label`, the end
        # is after the last label above it, as pandas' searchsorted on the
        # reversed index gives)
        up = vals[::-1]
        return len(vals) - (bisect.bisect_right(up, label) if side == "left" else bisect.bisect_left(up, label))
    except TypeError:
        raise TypeError("cannot do slice indexing on %s with these indexers [%s] of type %s"
                        % (type(index).__name__, label, type(label).__name__)) from None


def label_slice_positions(index, key):
    if key.step is not None and (not _is_int(key.step) or key.step != 1):
        raise NotImplementedError("pandas: a label slice with a step is not in Sagebrush's pandas 0.x subset")
    start = 0 if key.start is None else _slice_bound(index, key.start, "left")
    stop = len(index) if key.stop is None else _slice_bound(index, key.stop, "right")
    return list(range(start, max(start, stop)))


def loc_positions(index, key):
    """Positions for .loc[key] on an axis with this index."""
    Index, Series = _ns()
    if isinstance(key, slice):
        return label_slice_positions(index, key), False
    if is_bool_key(key):
        return mask_positions(key, len(index), index, what="loc"), False
    if is_list_like(key):
        vals = key.tolist() if isinstance(key, (np.ndarray, Index, Series)) else list(key)
        return _label_list(index, vals), False
    if isinstance(key, tuple):
        raise NotImplementedError("pandas: a tuple label is not in Sagebrush's pandas 0.x subset")
    p = index._pd_positions(key)
    if isinstance(p, list):
        return p, False
    return [p], True


def getitem_slice_positions(index, key):
    """Series[a:b] and DataFrame[a:b]: positional for ints (and None),
    unless the index is float64; by label otherwise."""
    parts = [x for x in (key.start, key.stop, key.step) if x is not None]
    if all(_is_int(x) for x in parts) and str(index.dtype) != "float64":
        return list(range(*key.indices(len(index))))
    return label_slice_positions(index, key)


def is_scalar_key(key):
    Index, Series = _ns()
    return not isinstance(key, (slice, list, tuple, np.ndarray, Index, Series, range, dict, set))


def missing(v):
    return is_missing(v)
