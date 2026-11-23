"""DataFrame.info, Series.info and memory_usage, ported from pandas 3.1.0's
pandas/io/formats/info.py (BSD-3-Clause, see _pd_license.py and NOTICE.md).

memory_usage counts what pandas counts without deep=True: a numeric
column's array bytes, 8 bytes a value for str, object and datetime columns
(pandas' object pointers and int64 times), and a RangeIndex as
sys.getsizeof of its range and three ints on CPython 3.14. deep=True would
measure each Python object, which only CPython's sizes give: it is refused
where it would differ (str or object data)."""

import sys

from ._pd_dtypes import STR
from ._pd_datetime import DT, fmt_times
from ._pd_repr import pprint_thing

__all__ = ["frame_info", "series_info", "column_nbytes", "index_nbytes", "check_deep"]

# (pandas' display.max_info_columns and display.max_info_rows, which this
# subset doesn't let one set)
_MAX_INFO_COLUMNS = 100
_MAX_INFO_ROWS = 1690785

_ITEMSIZE = {"bool": 1, "int8": 1, "uint8": 1, "int16": 2, "uint16": 2, "int32": 4, "uint32": 4, "int64": 8, "float64": 8}


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def column_nbytes(col):
    return len(col) * _ITEMSIZE.get(col.dtype, 8) if col.dtype not in (STR, DT) else len(col) * 8


def _int_size(x):
    # (sys.getsizeof of an int on CPython 3.14: 24 bytes and 4 a 30-bit digit, at least one)
    return 24 + 4 * max(1, (abs(x).bit_length() + 29) // 30)


def index_nbytes(index):
    from ._pd_index import RangeIndex
    if isinstance(index, RangeIndex):
        return 48 + sum(_int_size(x) for x in (index.start, index.stop, index.step))
    return column_nbytes(index._pd_column())


def _is_list_index(index):
    from ._pd_index import RangeIndex
    return not isinstance(index, RangeIndex) and index._pd_column().is_list


def check_deep(what, cols, index):
    """deep=True: the same bytes as without it for numeric data; refused for
    str and object data (the sizes of its Python objects)."""
    if any(c.is_list for c in cols) or (index is not None and _is_list_index(index)):
        raise _unsupported("%s of str or object data (the sizes of its Python objects)" % what)


def _sizeof_fmt(num, size_qualifier):
    for x in ["bytes", "KB", "MB", "GB", "TB"]:
        if num < 1024.0:
            return "%3.1f%s %s" % (num, size_qualifier, x)
        num /= 1024.0
    return "%3.1f%s PB" % (num, size_qualifier)


def _label_text(index, i):
    # (a label as pandas' f-string shows it; a time as the index's repr does)
    from ._pd_index import RangeIndex
    if not isinstance(index, RangeIndex) and index._pd_column().dtype is DT:
        return fmt_times(index._pd_column()._pd_values.tolist())[i]
    return "%s" % (index[i],)


def _summary(index, name=None):
    n = len(index)
    span = ", %s to %s" % (_label_text(index, 0), _label_text(index, n - 1)) if n else ""
    return "%s: %d entries%s" % (name if name is not None else type(index).__name__, n, span)


def _dtype_counts(cols):
    from ._pd_series import dtype_object
    counts = {}
    for c in cols:
        k = str(dtype_object(c.dtype))
        counts[k] = counts.get(k, 0) + 1
    return counts


def _dtypes_line(counts):
    return "dtypes: %s" % ", ".join("%s(%d)" % (k, counts[k]) for k in sorted(counts))


def _memory_line(owner, cols, index, memory_usage, counts):
    if memory_usage == "deep":
        check_deep("%s.info(memory_usage='deep')" % owner, cols, index)
    qualifier = ""
    if memory_usage != "deep" and ("object" in counts or _is_list_index(index)):
        qualifier = "+"
    total = index_nbytes(index) + sum(column_nbytes(c) for c in cols)
    return "memory usage: %s\n" % _sizeof_fmt(total, qualifier)


def _table(headers, rows):
    widths = [max([len(h)] + [len(r[k]) for r in rows]) for k, h in enumerate(headers)]
    lines = ["  ".join(h.ljust(w) for h, w in zip(headers, widths)),
             "  ".join(("-" * len(h)).ljust(w) for h, w in zip(headers, widths))]
    lines.extend("  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in rows)
    return lines


def _write(lines, buf):
    (sys.stdout if buf is None else buf).write("\n".join(lines))


def _check_memory_usage(memory_usage):
    if memory_usage is None:
        return True
    return memory_usage


def frame_info(frame, verbose, buf, max_cols, memory_usage, show_counts):
    """DataFrame.info: the class, the index's span, a row a column (its
    label, non-null count and dtype) or one summary line past max_cols
    columns, the dtype counts and the memory usage."""
    from ._pd_series import dtype_object
    memory_usage = _check_memory_usage(memory_usage)
    cols, index = frame._pd_cols, frame._pd_index
    lines = ["<class 'pandas.DataFrame'>", _summary(index)]
    if not cols:
        lines.append("Empty DataFrame\n")
        _write(lines, buf)
        return None
    if max_cols is None:
        max_cols = _MAX_INFO_COLUMNS
    exceeds = len(cols) > max_cols
    if show_counts is None:
        show_counts = not exceeds and not len(frame) > _MAX_INFO_ROWS
    counts = _dtype_counts(cols)
    if verbose or (verbose is None and not exceeds):
        lines.append("Data columns (total %d columns):" % len(cols))
        headers = [" # ", "Column"] + (["Non-Null Count"] if show_counts else []) + ["Dtype"]
        rows = []
        for j, (c, lab) in enumerate(zip(cols, frame._pd_columns.tolist())):
            cells = [" %d" % j, pprint_thing(lab)]
            if show_counts:
                cells.append("%d non-null" % (len(c) - int(c.isna().sum())))
            cells.append(pprint_thing(dtype_object(c.dtype)))
            rows.append(cells)
        lines.extend(_table(headers, rows))
    else:
        lines.append(_summary(frame._pd_columns, "Columns"))
    lines.append(_dtypes_line(counts))
    if memory_usage:
        lines.append(_memory_line("DataFrame", cols, index, memory_usage, counts))
    _write(lines, buf)
    return None


def series_info(s, verbose, buf, max_cols, memory_usage, show_counts):
    """Series.info: as DataFrame.info for its one column, with its name."""
    from ._pd_series import dtype_object
    if max_cols is not None:
        raise ValueError("Argument `max_cols` can only be passed in DataFrame.info, not Series.info")
    memory_usage = _check_memory_usage(memory_usage)
    col, index = s._pd_col, s._pd_index
    counts = _dtype_counts([col])
    lines = ["<class 'pandas.Series'>", _summary(index)]
    if verbose or verbose is None:
        lines.append("Series name: %s" % (s.name,))
        headers = (["Non-Null Count"] if show_counts else []) + ["Dtype"]
        cells = (["%d non-null" % (len(col) - int(col.isna().sum()))] if show_counts else []) + [pprint_thing(dtype_object(col.dtype))]
        lines.extend(_table(headers, [cells]))
    lines.append(_dtypes_line(counts))
    if memory_usage:
        lines.append(_memory_line("Series", [col], index, memory_usage, counts))
    _write(lines, buf)
    return None
