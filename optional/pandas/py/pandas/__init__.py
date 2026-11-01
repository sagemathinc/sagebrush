"""Sagebrush's pandas 0.x (plan-pandas-m1-r1, r7): Series, DataFrame,
Index, read_csv, indexing, reprs and options, a subset of pandas 3.1.0's
API.  Every name outside the subset raises NotImplementedError."""

from ._pd_dtypes import StringDtype as _StringDtype
from ._pd_index import Index, RangeIndex
from ._pd_series import Series
from ._pd_frame import DataFrame
from ._pd_options import get_option, set_option, reset_option, option_context, options, describe_option
from ._pd_csv import read_csv
from ._pd_toplevel import isna, notna, isnull, notnull
from . import errors

__version__ = "0.1.0"

__all__ = [
    "Index", "RangeIndex", "Series", "DataFrame", "read_csv",
    "get_option", "set_option", "reset_option", "option_context", "options", "describe_option",
    "isna", "notna", "isnull", "notnull", "errors",
]


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError("module 'pandas' has no attribute '%s'" % name)
    raise NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % name)
