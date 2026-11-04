"""pd.isna and pd.notna (plan-pandas-m1-r1 §0)."""

import numpy as np

from ._pd_dtypes import is_missing

__all__ = ["isna", "notna", "isnull", "notnull"]


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
