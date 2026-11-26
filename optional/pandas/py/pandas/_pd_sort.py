"""sort_values: the order of rows by one or more columns.

Every sort here is stable: equal keys keep their original order.  pandas'
default kind='quicksort' isn't stable, so for tied keys pandas' order is
unspecified there and this one is a valid answer; with kind='stable' or
'mergesort', and for several keys (pandas sorts those lexicographically,
stably), it is pandas' order exactly.

Several keys are sorted as numpy's lexsort is: one stable pass per key, from
the last key to the first.  In each pass the missing values of that key go
last (or first, na_position='first') whatever its direction, in their
current order, and a descending key keeps equal values in their current
order too, as pandas does.
"""

from ._pd_datetime import DT

__all__ = ["sort_positions", "check_na_position", "check_ascending"]

_KINDS = ("quicksort", "mergesort", "heapsort", "stable")


def check_na_position(na_position):
    if na_position not in ("last", "first"):
        raise ValueError("invalid na_position: %s" % (na_position,))


def check_ascending(ascending):
    """ascending as a list of bools (pandas' validate_ascending)."""
    flags = list(ascending) if isinstance(ascending, (list, tuple)) else [ascending]
    for a in flags:
        if not isinstance(a, bool) and not (isinstance(a, int) and a in (0, 1)):
            raise ValueError('For argument "ascending" expected type bool, received type %s.' % type(a).__name__)
    return [bool(a) for a in flags]


def check_kind(kind):
    if kind not in _KINDS:
        raise ValueError("sort kind must be one of 'quick', 'heap', or 'stable' (got '%s')" % (kind,))


def _keys(col):
    """The sort key of each row (Python values) and which rows are missing."""
    missing = col.isna().tolist()
    if col.dtype is DT or not col.is_list:
        return col._pd_values.tolist(), missing
    return list(col._pd_values), missing


def sort_positions(cols, ascending, na_position):
    """The row positions that sort the columns `cols` (the keys, first one
    first), each ascending or not (one flag per key)."""
    n = len(cols[0]) if cols else 0
    order = list(range(n))
    for col, asc in reversed(list(zip(cols, ascending))):
        values, missing = _keys(col)
        present = [p for p in order if not missing[p]]
        absent = [p for p in order if missing[p]]
        # (sorted is stable, and reverse=True keeps equal values in their current order)
        present = sorted(present, key=lambda p: values[p], reverse=not asc)
        order = present + absent if na_position == "last" else absent + present
    return order
