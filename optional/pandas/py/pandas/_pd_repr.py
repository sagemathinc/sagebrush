"""Text and HTML formatting of Series, DataFrame and Index, ported from
pandas 3.1.0 (BSD-3-Clause, see _pd_license.py and NOTICE.md):

- pandas/io/formats/format.py: SeriesFormatter, DataFrameFormatter,
  format_array and its array formatters, _make_fixed_width, the zero
  trimming, format_name;
- pandas/io/formats/string.py: StringFormatter (the frame layout, its dots
  and its fitting to the width);
- pandas/io/formats/printing.py: adjoin, pprint_thing, _pprint_seq,
  format_object_summary, _TextAdjustment;
- pandas/io/formats/html.py: HTMLFormatter and NotebookFormatter (no
  MultiIndex, no links, no col_space);
- pandas/core/indexes/base.py: Index.__repr__, _format_flat,
  _format_with_header and trim_front; pandas/core/indexes/range.py's.

Reduced to M1: the dtypes int64, float64, bool, str and object, flat
indexes, and the display options M1 has (the others at pandas' defaults:
show_dimensions 'truncate', colheader_justify 'right', expand_frame_repr,
max_seq_items 100, html.border 1, use_mathjax, no float_format, no
chop_threshold, no east-asian widths).  A terminal is 80 x 24, as
shutil.get_terminal_size() reports without a terminal.

Every label and value in the HTML is escaped with html.escape(quote=True)
(plan-pandas r7 §C5), where pandas escapes only &, < and >.
"""

import html as _html
import re

import numpy as np

from . import _pd_options
from ._pd_dtypes import STR, is_missing

__all__ = ["series_repr", "frame_repr", "frame_repr_html", "index_repr", "pprint_thing"]

_TERMINAL = (80, 24)
_MAX_SEQ_ITEMS = 100
_NEST_DEPTH = 3
_ESCAPES = ("\t", "\r", "\n")


def _opt(key):
    return _pd_options._pd_values["display." + key]


# --- printing.py ---------------------------------------------------------

def _justify(texts, max_len, mode="right"):
    if mode == "left":
        return [x.ljust(max_len) for x in texts]
    elif mode == "center":
        return [x.center(max_len) for x in texts]
    return [x.rjust(max_len) for x in texts]


def adjoin(space, *lists):
    newLists = []
    lengths = [max(map(len, x)) + space for x in lists[:-1]]
    lengths.append(max(map(len, lists[-1])))
    maxLen = max(map(len, lists))
    for i, lst in enumerate(lists):
        nl = _justify(lst, lengths[i], mode="left")
        nl = ([" " * lengths[i]] * (maxLen - len(lst))) + nl
        newLists.append(nl)
    return "\n".join("".join(lines) for lines in zip(*newLists))


def _is_float(x):
    return isinstance(x, (float, np.floating))


def _trim_zeros_single_float(str_float):
    str_float = str_float.rstrip("0")
    if str_float.endswith("."):
        str_float += "0"
    return str_float


def _is_scalar(x):
    return x is None or isinstance(x, (str, bytes, int, float, complex, bool, np.generic))


def _is_seq(x):
    from ._pd_index import Index
    from ._pd_series import Series
    from ._pd_frame import DataFrame
    return isinstance(x, (np.ndarray, list, tuple, set, frozenset, range, Index, Series, DataFrame))


def _pprint_seq(seq, _nest_lvl=0, max_seq_items=None, **kwds):
    from ._pd_index import Index
    if isinstance(seq, set):
        fmt = "{{{body}}}"
    elif isinstance(seq, frozenset):
        fmt = "frozenset()" if not seq else "frozenset({{{body}}})"
    else:
        # (pandas: '[...]' for a type with __setitem__: list, ndarray, Index,
        # Series, DataFrame; '(...)' for tuple and range)
        fmt = "({body})" if isinstance(seq, (tuple, range)) else "[{body}]"
    if max_seq_items is False:
        max_items = None
    else:
        max_items = max_seq_items or _MAX_SEQ_ITEMS or len(seq)
    r = []
    max_items_reached = False
    for i, item in enumerate(iter(seq)):
        if (max_items is not None) and (i >= max_items):
            max_items_reached = True
            break
        if _is_float(item) and not is_missing(item):
            precision = _opt("precision")
            item = _trim_zeros_single_float(format(item, ".%df" % precision))
        r.append(pprint_thing(item, _nest_lvl + 1, max_seq_items=max_seq_items, **kwds))
    body = ", ".join(r)
    if max_items_reached:
        body += ", ..."
    elif isinstance(seq, tuple) and len(seq) == 1:
        body += ","
    return fmt.format(body=body)


def _pprint_dict(seq, _nest_lvl=0, max_seq_items=None, **kwds):
    pairs = []
    if max_seq_items is False:
        nitems = len(seq)
    else:
        nitems = max_seq_items or _MAX_SEQ_ITEMS or len(seq)
    for k, v in list(seq.items())[:nitems]:
        pairs.append("%s: %s" % (
            pprint_thing(k, _nest_lvl + 1, max_seq_items=max_seq_items, **kwds),
            pprint_thing(v, _nest_lvl + 1, max_seq_items=max_seq_items, **kwds)))
    if nitems < len(seq):
        return "{" + ", ".join(pairs) + ", ...}"
    return "{" + ", ".join(pairs) + "}"


def _as_escaped_string(thing, escape_chars):
    translate = {"\t": r"\t", "\n": r"\n", "\r": r"\r", "'": r"\'"}
    if isinstance(escape_chars, dict):
        translate = escape_chars
        escape_chars = list(escape_chars.keys())
    else:
        escape_chars = escape_chars or ()
    result = str(thing)
    for c in escape_chars:
        result = result.replace(c, translate[c])
    return result


def pprint_thing(thing, _nest_lvl=0, escape_chars=None, quote_strings=False, max_seq_items=None):
    if _is_scalar(thing):
        result = _as_escaped_string(thing, escape_chars)
        if quote_strings and isinstance(thing, str):
            result = "'%s'" % result
    elif isinstance(thing, dict) and _nest_lvl < _NEST_DEPTH:
        result = _pprint_dict(thing, _nest_lvl, quote_strings=True, max_seq_items=max_seq_items)
    elif _is_seq(thing) and not (isinstance(thing, np.ndarray) and thing.ndim == 0) and _nest_lvl < _NEST_DEPTH:
        result = _pprint_seq(thing, _nest_lvl, escape_chars=escape_chars, quote_strings=quote_strings,
                             max_seq_items=max_seq_items)
    else:
        result = _as_escaped_string(thing, escape_chars)
    return result


def default_pprint(thing):
    return pprint_thing(thing, escape_chars=_ESCAPES, quote_strings=True)


def format_object_summary(obj, formatter, is_justify=True, name=None):
    display_width = _opt("width") or 80
    if name is None:
        name = type(obj).__name__
    name_len = len(name)
    space1 = "\n" + " " * (name_len + 1)
    space2 = "\n" + " " * (name_len + 2)
    n = len(obj)
    sep = ","
    max_seq_items = _MAX_SEQ_ITEMS or n
    is_truncated = n > max_seq_items

    def _extend_line(s, line, value, display_width, next_line_prefix):
        if len(line.rstrip()) + len(value.rstrip()) >= display_width:
            s += line.rstrip()
            line = next_line_prefix
        line += value
        return s, line

    def best_len(values):
        return max(len(x) for x in values) if values else 0

    close = ", "
    if n == 0:
        summary = "[]" + close
    elif n == 1:
        summary = "[%s]%s" % (formatter(obj[0]), close)
    else:
        if n > max_seq_items:
            n = min(max_seq_items // 2, 10)
            head = [formatter(obj[i]) for i in range(n)]
            tail = [formatter(obj[i]) for i in range(len(obj) - n, len(obj))]
        else:
            head = []
            tail = [formatter(obj[i]) for i in range(n)]
        if is_justify:
            if is_truncated or not (len(", ".join(head)) < display_width and len(", ".join(tail)) < display_width):
                max_length = max(best_len(head), best_len(tail))
                head = [x.rjust(max_length) for x in head]
                tail = [x.rjust(max_length) for x in tail]
        summary = ""
        line = space2
        for head_value in head:
            summary, line = _extend_line(summary, line, head_value + sep + " ", display_width, space2)
        if is_truncated:
            summary += line.rstrip() + space2 + "..."
            line = space2
        for tail_item in tail[:-1]:
            summary, line = _extend_line(summary, line, tail_item + sep + " ", display_width, space2)
        summary, line = _extend_line(summary, line, tail[-1], display_width - 2, space2)
        summary += line
        close = "]" + close.rstrip(" ")
        summary += close
        if len(summary) > display_width:
            summary += space1
        else:
            summary += " "
        summary = "[" + summary[len(space2):]
    return summary


# --- format.py: arrays ---------------------------------------------------

def _make_fixed_width(strings, justify="right", minimum=None, max_colwidth=True):
    if len(strings) == 0 or justify == "all":
        max_len = max(len(x) for x in strings) if strings else 0
        return strings, max_len
    max_len = max(len(x) for x in strings)
    if minimum is not None:
        max_len = max(minimum, max_len)
    conf_max = _opt("max_colwidth") if max_colwidth else None
    if conf_max is not None and max_len > conf_max:
        max_len = conf_max
    if conf_max is not None:
        keep = max(max_len - 3, 0)
        placeholder = "..."[: max_len - keep]
        strings = [x[:keep] + placeholder if len(x) > max_len else x for x in strings]
    return _justify(strings, max_len, mode=justify), max_len


_NUMBER_WITH_DECIMAL_RE = re.compile(r"^\s*[+-]?[0-9]+\.[0-9]*$")


def _trim_zeros_float(str_floats):
    is_number = [_NUMBER_WITH_DECIMAL_RE.match(x) is not None for x in str_floats]
    if not any(is_number):
        return list(str_floats)
    trimmed = list(str_floats)
    while True:
        if not all(x.endswith("0") for x, is_num in zip(trimmed, is_number) if is_num):
            break
        trimmed = [x[:-1] if is_num else x for x, is_num in zip(trimmed, is_number)]
    return [x + "0" if is_num and x.endswith(".") else x for x, is_num in zip(trimmed, is_number)]


def _generic_strings(values, na_rep, leading_space, quote=False):
    """_GenericArrayFormatter._format_strings, for a list of Python values
    (bool, str and object columns, and the str dtype's fallback)."""
    precision = _opt("precision")

    def float_format(x):
        return _trim_zeros_single_float(format(x, " .%df" % precision))

    def _format(x):
        if na_rep is not None and _is_scalar(x) and is_missing(x):
            if x is None:
                return "None"
            return na_rep
        return str(pprint_thing(x, escape_chars=_ESCAPES, quote_strings=quote))

    out = []
    for v in values:
        is_float_type = _is_float(v) and not is_missing(v)
        if not is_float_type and leading_space:
            out.append(" " + _format(v))
        elif is_float_type:
            out.append(float_format(v))
        else:
            out.append(_format(v) if leading_space is False else " " + _format(v))
    return out


def _float_strings(values, na_rep, leading_space, justify, digits):
    """FloatArrayFormatter.get_result_as_array, fixed width, no
    float_format and no chop threshold."""
    vals = [float(x) for x in values.tolist()] if isinstance(values, np.ndarray) else [float(x) for x in values]
    na = " " + na_rep if justify == "left" else na_rep

    def with_format(spec):
        out = [na if v != v else format(v, spec) for v in vals]
        return _trim_zeros_float(out)

    spec = (" .%df" if leading_space is True else ".%df") % digits
    formatted = with_format(spec)
    too_long = max(len(x) for x in formatted) > digits + 6 if formatted else False
    absv = [abs(v) for v in vals]
    has_large = any(a > 1e6 for a in absv)
    has_small = any(a < 10 ** (-digits) and a > 0 for a in absv)
    if has_small or (too_long and has_large):
        spec = (" .%de" if leading_space is True else ".%de") % digits
        formatted = with_format(spec)
    return formatted


def format_column(col, na_rep="NaN", justify="right", leading_space=True, max_colwidth=True):
    """format_array of one column: its values as fixed-width strings."""
    d = col.dtype
    digits = _opt("precision")
    if d == "float64":
        strs = _float_strings(col._pd_values, na_rep, leading_space, justify, digits)
    elif d == "int64":
        spec = "d" if leading_space is False else " d"
        strs = [format(x, spec) for x in col._pd_values.tolist()]
    elif d == "bool":
        strs = _generic_strings(col._pd_values.tolist(), na_rep, leading_space)
    else:
        strs = _generic_strings(col._pd_values, na_rep, leading_space)
    return _make_fixed_width(strs, justify, max_colwidth=max_colwidth)[0]


def format_name(name):
    if name is None:
        return ""
    if _is_float(name) and not is_missing(name):
        from ._pd_column import column_from
        return format_column(column_from([float(name)], "float64"), leading_space=False)[0]
    return pprint_thing(name, escape_chars=_ESCAPES)


def _trim_front(strings):
    if not strings:
        return strings
    smallest = min(len(x) - len(x.lstrip()) for x in strings)
    if smallest > 0:
        strings = [x[smallest:] for x in strings]
    return strings


def index_format_flat(index, include_name, max_colwidth=True):
    """Index._format_flat: the labels as strings, the name first if asked."""
    from ._pd_index import RangeIndex
    header = [format_name(index.name)] if include_name else []
    if isinstance(index, RangeIndex):
        r = range(index.start, index.stop, index.step)
        if not len(r):
            return header
        w = max(len(str(r[0])), len(str(r[-1])))
        return header + [str(x).ljust(w) for x in r]
    col = index._pd_column()
    justify = "all" if col.is_list else "left"
    return header + _trim_front(format_column(col, justify=justify, max_colwidth=max_colwidth))


def _has_names(index):
    return index.name is not None


# --- Index.__repr__ ------------------------------------------------------

def _dtype_str(dtype):
    return str(dtype)


def index_repr(index):
    from ._pd_index import RangeIndex
    klass_name = type(index).__name__
    if isinstance(index, RangeIndex):
        data = ""
        attrs = [("start", index.start), ("stop", index.stop), ("step", index.step)]
        if index.name is not None:
            attrs.append(("name", default_pprint(index.name)))
    else:
        col = index._pd_column()
        is_justify = not _inferred_string(col)
        data = format_object_summary(index, default_pprint, is_justify=is_justify)
        attrs = [("dtype", "'%s'" % _dtype_str(col.dtype))]
        if index.name is not None:
            attrs.append(("name", default_pprint(index.name)))
        if len(index) > _MAX_SEQ_ITEMS:
            attrs.append(("length", len(index)))
    display_width = _opt("width") or 80
    indent = len(klass_name) + 1
    indent_str = " " * indent
    if "\n" in data:
        line_len = len(data.rsplit("\n", 1)[-1])
    else:
        line_len = indent + len(data)
    parts = []
    num_attrs = len(attrs)
    for attr_idx, (key, val) in enumerate(attrs):
        attr = "%s=%s" % (key, val)
        attr_len = len(attr)
        comma = 1 if attr_idx < num_attrs - 1 else 0
        if not parts:
            if line_len + attr_len + comma > display_width:
                parts.append("\n" + indent_str + attr)
                line_len = indent + attr_len
            else:
                parts.append(attr)
                line_len += attr_len
        else:
            if line_len + 2 + attr_len + comma > display_width:
                parts.append(",\n" + indent_str + attr)
                line_len = indent + attr_len
            else:
                parts.append(", " + attr)
                line_len += 2 + attr_len
    prepr = "".join(parts)
    if prepr.startswith("\n"):
        data = data.rstrip()
    return "%s(%s%s)" % (klass_name, data, prepr)


def _inferred_string(col):
    # (Index.inferred_type == 'string': every value a str, NaN allowed)
    if col.dtype is STR:
        return True
    if col.dtype != "object":
        return False
    vals = [v for v in col._pd_values if not is_missing(v)]
    return bool(vals) and all(isinstance(v, str) for v in vals)


# --- Series --------------------------------------------------------------

def _series_repr_params():
    width, height = _TERMINAL
    max_rows_opt = _opt("max_rows")
    max_rows = height if max_rows_opt == 0 else max_rows_opt
    min_rows = height if max_rows_opt == 0 else _opt("min_rows")
    return max_rows, min_rows


def series_repr(s):
    max_rows, min_rows = _series_repr_params()
    n = len(s)
    truncated = bool(max_rows and n > max_rows)
    if truncated:
        if min_rows:
            max_rows = min(min_rows, max_rows)
        if max_rows == 1:
            row_num = max_rows
            positions = list(range(max_rows))
        else:
            row_num = max_rows // 2
            positions = list(range(row_num)) + list(range(n - row_num, n))
        col = s._pd_col.take(positions)
        index = s.index._pd_take(positions)
    else:
        row_num = None
        col = s._pd_col
        index = s.index
    footer = ""
    if s.name is not None:
        footer += "Name: %s" % format_name(s.name)
    if truncated:
        if footer:
            footer += ", "
        footer += "Length: %d" % n
    if footer:
        footer += ", "
    footer += "dtype: %s" % pprint_thing(_dtype_str(col.dtype))
    if n == 0:
        return "Series([], %s)" % footer
    have_header = _has_names(index)
    fmt_index = index_format_flat(index, include_name=True)
    fmt_values = format_column(col, leading_space=True)
    if truncated:
        width = len(fmt_values[row_num - 1])
        dot_str = "..." if width > 3 else ".."
        dot_str = dot_str.center(width)
        fmt_values.insert(row_num, dot_str)
        fmt_index.insert(row_num + 1, "")
    result = adjoin(3, fmt_index[1:], fmt_values)
    if have_header:
        result = fmt_index[0] + "\n" + result
    return result + "\n" + footer


# --- DataFrame -----------------------------------------------------------

class _FrameFormatter(object):
    """DataFrameFormatter, for repr and _repr_html_ at the options."""

    def __init__(self, frame, html=False):
        self.frame = frame
        self.html = html
        self.max_rows = _opt("max_rows")
        self.min_rows = _opt("min_rows")
        self.max_cols = _opt("max_columns")
        self.max_cols_fitted = self._calc_max_cols_fitted()
        self.max_rows_fitted = self._calc_max_rows_fitted()
        self.tr_frame = frame
        self.tr_col_num = None
        self.tr_row_num = None
        if self.is_truncated_horizontally:
            self._truncate_horizontally()
        if self.is_truncated_vertically:
            self._truncate_vertically()

    def _in_terminal(self):
        return bool(self.max_cols == 0 or self.max_rows == 0)

    def _calc_max_cols_fitted(self):
        if not self._in_terminal():
            return self.max_cols
        width = _TERMINAL[0]
        if self.max_cols == 0 and len(self.frame.columns) > width:
            return width
        return self.max_cols

    def _calc_max_rows_fitted(self):
        if self._in_terminal():
            height = _TERMINAL[1]
            if self.max_rows == 0:
                return height - self._aux_rows()
            if self.max_rows == 0 and len(self.frame) > height:
                max_rows = height
            else:
                max_rows = self.max_rows
        else:
            max_rows = self.max_rows
        if max_rows:
            if len(self.frame) > max_rows and self.min_rows:
                max_rows = min(self.min_rows, max_rows)
        return max_rows

    def _aux_rows(self):
        # (dot row, prompt row, the header; show_dimensions 'truncate' is
        # truthy, so the dimensions' three lines count, as pandas counts
        # "\n\n[n rows x m columns]".splitlines())
        return 1 + 1 + 3 + 1

    @property
    def is_truncated_horizontally(self):
        return bool(self.max_cols_fitted and (len(self.frame.columns) > self.max_cols_fitted))

    @property
    def is_truncated_vertically(self):
        return bool(self.max_rows_fitted and (len(self.frame) > self.max_rows_fitted))

    @property
    def is_truncated(self):
        return bool(self.is_truncated_horizontally or self.is_truncated_vertically)

    def _truncate_horizontally(self):
        col_num = self.max_cols_fitted // 2
        n = len(self.tr_frame.columns)
        if col_num >= 1:
            self.tr_frame = self.tr_frame._pd_take_cols(list(range(col_num)) + list(range(n - col_num, n)))
        else:
            col_num = self.max_cols
            self.tr_frame = self.tr_frame._pd_take_cols(list(range(min(col_num, n))))
        self.tr_col_num = col_num

    def _truncate_vertically(self):
        row_num = self.max_rows_fitted // 2
        n = len(self.tr_frame)
        if row_num >= 1:
            self.tr_frame = self.tr_frame._pd_take_rows(list(range(row_num)) + list(range(n - row_num, n)))
        else:
            row_num = self.max_rows
            self.tr_frame = self.tr_frame._pd_take_rows(list(range(min(row_num, n))))
        self.tr_row_num = row_num

    @property
    def show_row_idx_names(self):
        return _has_names(self.frame.index)

    @property
    def show_col_idx_names(self):
        return _has_names(self.frame.columns)

    def format_col(self, i, max_colwidth=True):
        return format_column(self.tr_frame._pd_cols[i], leading_space=True, max_colwidth=max_colwidth)

    def _column_labels(self):
        fmt_columns = index_format_flat(self.tr_frame.columns, include_name=False)
        # (pandas zips the shown labels with the whole frame's dtypes)
        dtypes = [c.dtype for c in self.frame._pd_cols]
        return [[" " + x if d in ("int64", "float64", "bool") else x]
                for x, d in zip(fmt_columns, dtypes)]

    def _strcols_without_index(self):
        strcols = []
        str_columns = self._column_labels()
        if self.show_row_idx_names:
            for x in str_columns:
                x.append("")
        for i in range(len(self.tr_frame.columns)):
            cheader = str_columns[i] if i < len(str_columns) else [""]
            header_colwidth = max(0, *(len(x) for x in cheader))
            fmt_values, max_len = _make_fixed_width(self.format_col(i), "right", minimum=header_colwidth)
            max_len = max(max_len, header_colwidth)
            cheader = _justify(cheader, max_len, mode="right")
            strcols.append(cheader + fmt_values)
        return strcols

    def _formatted_index(self):
        fmt_index = index_format_flat(self.tr_frame.index, include_name=self.show_row_idx_names)
        fmt_index = _make_fixed_width(fmt_index, justify="left", minimum=0)[0]
        adjoined = adjoin(1, fmt_index).split("\n")
        if self.show_col_idx_names:
            col_header = [format_name(self.frame.columns.name)]
        else:
            col_header = [""]
        return col_header + adjoined

    def get_strcols(self):
        strcols = self._strcols_without_index()
        strcols.insert(0, self._formatted_index())
        return strcols


def _insert_dots(fmt, strcols):
    index_length = len(strcols[0])
    if fmt.is_truncated_horizontally:
        strcols.insert(fmt.tr_col_num + 1, [" ..."] * index_length)
    if fmt.is_truncated_vertically:
        n_header_rows = index_length - len(fmt.tr_frame)
        row_num = fmt.tr_row_num
        for ix, col in enumerate(strcols):
            cwidth = len(col[row_num])
            is_dot_col = fmt.is_truncated_horizontally and ix == fmt.tr_col_num + 1
            dots = "..." if (cwidth > 3 or is_dot_col) else ".."
            if ix == 0:
                dot_mode = "left"
            elif is_dot_col:
                cwidth = 4
                dot_mode = "right"
            else:
                dot_mode = "right"
            col.insert(row_num + n_header_rows, _justify([dots], cwidth, mode=dot_mode)[0])
    return strcols


def _binify(cols, line_width):
    bins = []
    curr_width = 0
    i_last_column = len(cols) - 1
    for i, w in enumerate(cols):
        w_adjoined = w + 1
        curr_width += w_adjoined
        if i_last_column == i:
            wrap = curr_width + 1 > line_width and i > 0
        else:
            wrap = curr_width + 2 > line_width and i > 0
        if wrap:
            bins.append(i)
            curr_width = w_adjoined
    bins.append(len(cols))
    return bins


def _join_multiline(fmt, strcols, line_width):
    lwidth = line_width
    strcols = list(strcols)
    idx = strcols.pop(0)
    lwidth -= max(len(x) for x in idx) + 1
    col_widths = [max(len(x) for x in col) if len(col) > 0 else 0 for col in strcols]
    col_bins = _binify(col_widths, lwidth)
    nbins = len(col_bins)
    str_lst = []
    start = 0
    for i, end in enumerate(col_bins):
        row = strcols[start:end]
        row.insert(0, idx)
        if nbins > 1:
            nrows = len(row[-1])
            if end <= len(strcols) and i < nbins - 1:
                row.append([" \\"] + ["  "] * (nrows - 1))
            else:
                row.append([" "] * nrows)
        str_lst.append(adjoin(1, *row))
        start = end
    return "\n\n".join(str_lst)


def _fit_to_width(fmt, strcols):
    col_lens = [max(len(x) for x in col) if col else 0 for col in strcols]
    n_cols = len(col_lens)
    total_width = sum(col_lens) + n_cols - 1
    adj_dif = total_width - _TERMINAL[0] + 1
    if adj_dif <= 0:
        return adjoin(1, *strcols)
    adj_dif += 4 + 1
    while adj_dif > 0 and n_cols > 1:
        mid = int(round(n_cols / 2))
        adj_dif -= col_lens.pop(mid) + 1
        n_cols -= 1
    max_cols_fitted = max(n_cols - 1, 2)
    fmt.max_cols_fitted = max_cols_fitted
    num_data_cols = len(strcols) - 1
    if max_cols_fitted >= num_data_cols:
        return adjoin(1, *strcols)
    col_num = max_cols_fitted // 2
    kept = strcols[: col_num + 1] + strcols[-col_num:]
    row_count = len(kept[0]) if kept else 0
    kept.insert(col_num + 1, [" ..."] * row_count)
    return adjoin(1, *kept)


def _frame_empty(frame):
    return len(frame.index) == 0 or len(frame.columns) == 0


def frame_repr(frame):
    fmt = _FrameFormatter(frame)
    if _frame_empty(frame):
        text = "Empty DataFrame\nColumns: %s\nIndex: %s" % (pprint_thing(frame.columns), pprint_thing(frame.index))
    else:
        strcols = fmt.get_strcols()
        if fmt.is_truncated:
            strcols = _insert_dots(fmt, strcols)
        line_width = _opt("width") or _TERMINAL[0]
        if fmt.max_cols is None or fmt.max_cols > 0:
            text = _join_multiline(fmt, strcols, line_width)
        else:
            text = _fit_to_width(fmt, strcols)
    if fmt.is_truncated:
        text += "\n\n[%d rows x %d columns]" % (len(frame), len(frame.columns))
    return text


def _esc(s):
    return _html.escape(s, quote=True)


def frame_repr_html(frame):
    fmt = _FrameFormatter(frame, html=True)
    out = []

    def write(s, indent=0):
        out.append(" " * indent + s)

    def cell(kind, s, indent, tags=None):
        start = "<%s %s>" % (kind, tags) if tags is not None else "<%s>" % kind
        rs = _esc(pprint_thing(s)).strip().replace("  ", "&nbsp;&nbsp;")
        write("%s%s</%s>" % (start, rs, kind), indent)

    def write_tr(line, indent, header=False, align=None, nindex_levels=0):
        write("<tr>" if align is None else '<tr style="text-align: %s;">' % align, indent)
        for i, s in enumerate(line):
            if header or i < nindex_levels:
                cell("th", s, indent + 2)
            else:
                cell("td", s, indent + 2)
        write("</tr>", indent)

    write("<div>")
    write("<style scoped>\n"
          "    .dataframe tbody tr th:only-of-type {\n"
          "        vertical-align: middle;\n"
          "    }\n"
          "\n"
          "    .dataframe tbody tr th {\n"
          "        vertical-align: top;\n"
          "    }\n"
          "\n"
          "    .dataframe thead th {\n"
          "        text-align: right;\n"
          "    }\n"
          "</style>")
    write('<table border="1" class="dataframe">')
    ncols = len(fmt.tr_frame.columns)
    write("<thead>", 2)
    row = [format_name(frame.columns.name)]
    row.extend(index_format_flat(fmt.tr_frame.columns, include_name=False))
    if fmt.is_truncated_horizontally:
        row.insert(1 + fmt.tr_col_num, "...")
    write_tr(row, 4, header=True, align="right")
    if fmt.show_row_idx_names:
        row = [format_name(frame.index.name)] + [""] * (ncols + (1 if fmt.is_truncated_horizontally else 0))
        write_tr(row, 4, header=True)
    write("</thead>", 2)
    write("<tbody>", 2)
    fmt_values = [fmt.format_col(j) for j in range(ncols)]
    index_values = index_format_flat(fmt.tr_frame.index, include_name=False)
    row = []
    for i in range(len(fmt.tr_frame)):
        if fmt.is_truncated_vertically and i == fmt.tr_row_num:
            write_tr(["..."] * len(row), 4, nindex_levels=1)
        row = [index_values[i]]
        row.extend(fmt_values[j][i] for j in range(ncols))
        if fmt.is_truncated_horizontally:
            row.insert(fmt.tr_col_num + 1, "...")
        write_tr(row, 4, nindex_levels=1)
    write("</tbody>", 2)
    write("</table>")
    if fmt.is_truncated:
        write("<p>%d rows × %d columns</p>" % (len(frame), len(frame.columns)))
    write("</div>")
    return "\n".join(out)
