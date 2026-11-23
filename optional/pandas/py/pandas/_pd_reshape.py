"""fillna and rename's helpers: one column's missing values
filled, and an axis' labels mapped."""

import numpy as np

from ._pd_column import Column
from ._pd_dtypes import STR
from ._pd_datetime import DT, as_us, is_time

__all__ = ["fill_column", "fill_mapped", "fill_positions", "relabel", "hashable", "NO_VALUE"]

# (fillna's value when none is given: pandas' own message then)
NO_VALUE = object()


def _number(v):
    return isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, (bool, np.bool_))


def _incompatible(value, dtype):
    import warnings
    from .errors import Pandas4Warning
    warnings.warn("'%s' is not supported as a fill value for %s dtype. In a future version, calling fillna with an "
                  "incompatible value will raise. Explicitly cast to a common dtype before filling." % (type(value).__name__, dtype),
                  Pandas4Warning, stacklevel=5)


def fill_column(col, value):
    """col with its missing values replaced by value (a new column); value
    None leaves them (see fill_positions)."""
    if value is None:
        return col.copy()
    return fill_positions(col, dict((p, value) for p, m in enumerate(col.isna().tolist()) if m))


def fill_mapped(col, labels, mapping):
    """col with each missing value whose label is in mapping replaced by the
    mapped value (a Series' fillna with a dict)."""
    fills = {}
    for p, (lab, m) in enumerate(zip(labels, col.isna().tolist())):
        if m and hashable(lab) and lab in mapping and mapping[lab] is not None:
            fills[p] = mapping[lab]
    return fill_positions(col, fills)


def fill_positions(col, fills):
    """col with the values `fills` (position -> value) set, as a new
    column: the dtype kept where every value fits it, else object (with
    pandas 3.1's Pandas4Warning for the first value that doesn't fit)."""
    if not fills:
        return col.copy()
    d = col.dtype
    vals = list(fills.values())
    if (d == "float64" or d == "float32") and all(_number(v) for v in vals):
        v = col._pd_values.copy()
        for p, x in fills.items():
            v[p] = float(x)
        return Column(d, v)
    if d is STR and all(isinstance(v, str) for v in vals):
        out = list(col._pd_values)
        for p, x in fills.items():
            out[p] = x
        return Column(STR, out)
    if d is DT:
        if not all(is_time(v) for v in vals):
            raise NotImplementedError("pandas: fillna of a datetime64[us] column with a value that isn't a time is not in Sagebrush's pandas 0.x subset")
        v = col._pd_values.copy()
        for p, x in fills.items():
            v[p] = as_us(x)
        return Column(DT, v)
    if d != "object":
        bad = [v for v in vals if not ((d in ("float64", "float32") and _number(v)) or (d is STR and isinstance(v, str)))]
        _incompatible(bad[0], "str" if d is STR else d)
    out = col.tolist()
    for p, x in fills.items():
        out[p] = x
    return Column("object", out)


def relabel(index, mapper, errors, owner):
    """index's labels through mapper (a dict: labels it doesn't have kept;
    or a function of each label), as a new Index with the same name."""
    from ._pd_index import Index
    labels = index.tolist()
    if isinstance(mapper, dict):
        if errors == "raise":
            missing = [k for k in mapper if k not in labels]
            if missing:
                raise KeyError("%r not found in axis" % (missing,))
        new = [mapper.get(lab, lab) if hashable(lab) else lab for lab in labels]
    elif callable(mapper):
        new = [mapper(lab) for lab in labels]
    else:
        raise NotImplementedError("pandas.%s with a %s mapper is not in Sagebrush's pandas 0.x subset" % (owner, type(mapper).__name__))
    return Index(new, name=index.name)


def hashable(v):
    try:
        hash(v)
    except TypeError:
        return False
    return True
