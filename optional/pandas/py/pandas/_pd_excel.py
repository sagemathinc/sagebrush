"""read_excel for Sagebrush's pandas (design-pandas-xlsx-timeseries r1, PR
B): .xlsx and .xlsm workbooks, read as pandas 3.1 reads them with openpyxl
(its read-only, values-only reader) and its Python parser.

The workbook is a zip archive (_pd_zip, bounded) of XML parts (_pd_xml, a
closed grammar): the workbook (its sheets and its date system), its
relationships, the shared strings, the styles (which number formats are
dates) and each sheet.  A cell is a number, a shared or inline string, a
boolean, an error (NaN, as pandas makes it) or a formula's cached value; no
formula is evaluated.  A number whose format is a date is a datetime (the
1900 system with Excel's leap-year bug, or the 1904 system), a time-only
format below a day is a time, and a number with no fraction is an int.
Then, as pandas: trailing empty cells and rows are dropped, rows padded,
skiprows, the header row, nrows, usecols and index_col applied, and each
column's dtype inferred.

Anything else (.xls, an encrypted workbook, dtype=, converters=, parse_dates=,
a callable usecols) raises NotImplementedError, as every other gap in the
subset does.
"""

import re
from datetime import datetime, time, timedelta

import numpy as np

from .errors import ParserError
from ._pd_zip import ZipArchive
from ._pd_xml import events, local

__all__ = ["read_excel"]


def _subset(what):
    return NotImplementedError("pandas: %s is not in Sagebrush's pandas 0.x subset" % what)


# --- the workbook's parts ---------------------------------------------------

def _xml(z, name):
    return z.read(name).decode("utf-8")


def _workbook(z):
    """[(sheet name, its part's path)] in order, and the 1904 flag."""
    rels = {}
    if "xl/_rels/workbook.xml.rels" in z:
        for ev in events(_xml(z, "xl/_rels/workbook.xml.rels")):
            if ev[0] == "start" and local(ev[1]) == "Relationship":
                t = ev[2].get("Target", "")
                t = t.lstrip("/") if t.startswith("/") else "xl/" + t
                rels[ev[2].get("Id")] = t
    sheets, d1904 = [], False
    for ev in events(_xml(z, "xl/workbook.xml")):
        if ev[0] != "start":
            continue
        name = local(ev[1])
        if name == "workbookPr":
            d1904 = ev[2].get("date1904", "0").lower() in ("1", "true")
        elif name == "sheet":
            rid = next((v for k, v in ev[2].items() if local(k) == "id"), None)
            sheets.append((ev[2].get("name"), rels.get(rid)))
    return sheets, d1904


def _shared_strings(z):
    if "xl/sharedStrings.xml" not in z:
        return []
    out, cur, in_t, skip = [], None, False, 0
    for ev in events(_xml(z, "xl/sharedStrings.xml")):
        kind = ev[0]
        if kind == "start":
            n = local(ev[1])
            if n == "si":
                cur = []
            elif n in ("rPh", "phoneticPr"):
                skip += 1
            elif n == "t" and not skip:
                in_t = True
        elif kind == "end":
            n = local(ev[1])
            if n == "si":
                out.append("".join(cur))
                cur = None
            elif n in ("rPh", "phoneticPr"):
                skip -= 1
            elif n == "t":
                in_t = False
        elif in_t and cur is not None:
            cur.append(ev[1])
    return out


_DATE_IDS = set(range(14, 23)) | {45, 46, 47}
_TIME_IDS = {18, 19, 20, 21, 45, 46, 47}
_QUOTED = re.compile(r'"[^"]*"|\[[^\]]*\]|\\.|_.|\*.')


def _is_date_format(code):
    # (openpyxl's is_date_format: the code's literals, colors and conditions removed, any of d m y h s left)
    if code is None:
        return False
    c = _QUOTED.sub("", code.split(";")[0])
    return bool(re.search(r"[dmyhs]", c, re.I)) and c.lower() != "general"


def _is_time_only(code):
    c = _QUOTED.sub("", (code or "").split(";")[0])
    return bool(re.search(r"[hs]", c, re.I)) and not re.search(r"[dy]", c, re.I)


def _styles(z):
    """For each cellXfs index: None, "date" or "time"."""
    if "xl/styles.xml" not in z:
        return []
    custom, xfs, in_cellxfs = {}, [], False
    for ev in events(_xml(z, "xl/styles.xml")):
        if ev[0] == "start":
            n = local(ev[1])
            if n == "numFmt":
                custom[int(ev[2].get("numFmtId", "0"))] = ev[2].get("formatCode", "")
            elif n == "cellXfs":
                in_cellxfs = True
            elif n == "xf" and in_cellxfs:
                i = int(ev[2].get("numFmtId", "0"))
                if i in custom:
                    kind = ("time" if _is_time_only(custom[i]) else "date") if _is_date_format(custom[i]) else None
                else:
                    kind = ("time" if i in _TIME_IDS and i not in (22,) else "date") if i in _DATE_IDS else None
                xfs.append(kind)
        elif ev[0] == "end" and local(ev[1]) == "cellXfs":
            in_cellxfs = False
    return xfs


_EPOCH_1900 = datetime(1899, 12, 30)
_EPOCH_1904 = datetime(1904, 1, 1)


def _from_excel(v, d1904, kind):
    # (openpyxl's from_excel: the 1900 system's serials before 60 a day later, Excel's 29 February 1900)
    if kind == "time" and 0 <= v < 1:
        us = int(round(v * 86400e6))
        return (datetime.min + timedelta(microseconds=us)).time()
    if d1904:
        return _EPOCH_1904 + timedelta(days=v)
    if 0 < v < 60:
        v += 1
    return _EPOCH_1900 + timedelta(days=v)


_REF = re.compile(r"([A-Z]{1,3})([0-9]+)")


def _col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


# The fast path for a sheet's cells: sheetData scanned by one pattern of rows and cells, whose matches must
# cover it exactly (whitespace between them aside), each cell's attributes in the strict form Excel and openpyxl
# write; the rest of the document is checked by the scanner (events), sheetData left out.  Anything else, a
# prefix, a gap, an attribute in another form, falls back to the scanner for the whole sheet, so a malformed
# part is refused exactly as there.  A cell holding more than one <v>, or a formula, an inline string or a
# reference, is read by the scanner too, and so is the sheet when a row's or a cell's attribute holds a
# reference ("&"), which only the scanner's grammar decides.  sheetData is found by find and rfind (the first
# opening tag, the last closing one), linear in the text.
_SD_OPEN, _SD_CLOSE = "<sheetData>", "</sheetData>"
_HAS_R = re.compile(r"\sr\s*=")
_ATTRS = r'((?:\s+[A-Za-z_][\w.\-]*="[^"<]*")*)\s*'
_ROW_CELL = re.compile(r"\s*(?:<row" + _ATTRS + r"(/?)>|</row>|<c" + _ATTRS + r"(?:/>|>(.*?)</c>))", re.S)
# (the common cell, as Excel writes it: r, then s and t if any, then one plain <v>; its groups read directly)
_PLAIN_CELL = re.compile(r'\s*<c r="([A-Z]{1,3})([0-9]+)"(?: s="([0-9]+)")?(?: t="([a-z]+)")?>(?:<v>([^<&]*)</v>)?</c>')
_ATTR_R = re.compile(r'\sr="([A-Z]{1,3})([0-9]+)"')
_ATTR_RR = re.compile(r'\sr="([0-9]+)"')
_ATTR_T = re.compile(r'\st="([^"]*)"')
_ATTR_S = re.compile(r'\ss="([0-9]+)"')


def _fast_rows(text, strings, xfs, d1904):
    """The sheet's cells as {row: {col: value}}, or None (the scanner reads it)."""
    start = text.find(_SD_OPEN)
    if start < 0:
        return None
    end = text.rfind(_SD_CLOSE)
    if end < start + len(_SD_OPEN):
        return None
    body = text[start + len(_SD_OPEN):end]
    # (the document's structure, sheetData's content left out, by the scanner: it refuses what it refuses)
    for _ in events(text[:start] + "<sheetData/>" + text[end + len(_SD_CLOSE):]):
        pass
    rows = {}
    pos, n = 0, len(body)
    row_i, col, open_row = -1, -1, False
    match = _ROW_CELL.match
    plain = _PLAIN_CELL.match
    cols = {}
    row = None
    nx = len(xfs)
    nxt, dropped = 0, False
    while pos < n:
        q = plain(body, pos) if open_row else None
        if q is not None:
            if int(q.group(2)) - 1 != row_i:
                return None
            letters = q.group(1)
            col = cols.get(letters)
            if col is None:
                col = cols[letters] = _col_index(letters)
            pos = q.end()
            v = q.group(5)
            if v is None or dropped:
                continue
            ct = q.group(4)
            if ct is None or ct == "n":
                st = q.group(3)
                kind = xfs[int(st)] if st is not None and int(st) < nx else None
                if kind or "." in v or "e" in v or "E" in v:
                    f = float(v)
                    if kind:
                        val = _from_excel(f, d1904, kind)
                    else:
                        i = int(f)
                        val = i if i == f else f
                else:
                    val = int(v)
            elif ct == "s":
                val = strings[int(v)]
            else:
                val = _cell_value({"t": ct, "s": int(q.group(3) or 0), "v": v, "is": []}, strings, xfs, d1904)
            if val != "":
                if row is None:
                    row = rows.setdefault(row_i, {})
                row[col] = val
            continue
        t = match(body, pos)
        if t is None or t.end() == pos:
            if body[pos:].strip():
                return None
            break
        pos = t.end()
        tok = t.group(0).lstrip()
        if tok.startswith("<row"):
            if open_row:
                return None
            ra = t.group(1) or ""
            if "&" in ra:
                return None
            r = _ATTR_RR.search(ra)
            if r is None and _HAS_R.search(ra):
                return None
            row_i = int(r.group(1)) - 1 if r else row_i + 1
            col = -1
            row = None
            open_row = not t.group(2)
            # (openpyxl's reader: a row whose number is below the next one expected is not read)
            dropped = row_i < nxt
            if not dropped:
                nxt = row_i + 1
            continue
        if tok == "</row>":
            if not open_row:
                return None
            open_row = False
            continue
        if not open_row:
            return None
        attrs, inner = t.group(3), t.group(4)
        if "&" in attrs:
            return None
        ref = _ATTR_R.search(attrs)
        if ref:
            if int(ref.group(2)) - 1 != row_i:
                return None
            col = _col_index(ref.group(1))
        elif _HAS_R.search(attrs):
            return None
        else:
            col += 1
        tt = _ATTR_T.search(attrs)
        ss = _ATTR_S.search(attrs)
        cell = {"t": tt.group(1) if tt else "n", "s": int(ss.group(1)) if ss else 0, "v": None, "is": []}
        if inner:
            if inner.startswith("<v>") and inner.endswith("</v>") and inner.count("<") == 2 and "&" not in inner:
                cell["v"] = inner[3:-4]
            else:
                # (anything else in the cell: the scanner's events for it, as the slow path reads them)
                text_ = None
                for ev in events("<c>" + inner + "</c>"):
                    if ev[0] == "start":
                        nm = local(ev[1])
                        if nm in ("v", "t"):
                            text_ = []
                    elif ev[0] == "text":
                        if text_ is not None:
                            text_.append(ev[1])
                    else:
                        nm = local(ev[1])
                        if nm == "v" and text_ is not None:
                            cell["v"] = "".join(text_)
                            text_ = None
                        elif nm == "t" and text_ is not None:
                            cell["is"].append("".join(text_))
                            text_ = None
        val = _cell_value(cell, strings, xfs, d1904)
        if val != "" and not dropped:
            rows.setdefault(row_i, {})[col] = val
    if open_row:
        return None
    return rows


# (Excel's sheet: 1,048,576 rows of 16,384 columns; a cell past them is refused, whatever the budget)
_MAX_ROWS = 1048576
_MAX_COLS = 16384
# (the dense rows' charge, per row: its list (and its padded copy's); per cell, at the peak: its slot in the
# sheet's row, in _frame's padded row and in its column's values)
_ROW_BYTES = 128
_CELL_BYTES = 24


def _sheet_rows(z, path, strings, xfs, d1904, budget, file_rows):
    """The sheet's values as rows of Python values ("" for an empty cell, as
    pandas' openpyxl reader has them), trailing empties dropped; with
    file_rows, only the sheet's first file_rows rows (at least one), as
    pandas asks openpyxl for them."""
    text = _xml(z, path)
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    rows = _fast_rows(text, strings, xfs, d1904)
    if rows is None:
        rows = _scan_rows(text, strings, xfs, d1904)
    if file_rows is not None:
        cut = max(file_rows, 1)
        rows = {i: r for i, r in rows.items() if i < cut}
    if not rows:
        return []
    # (the dense size, from the highest row and column: bounded, then charged, before any row is made)
    last = max(rows)
    width = max(max(r) for r in rows.values()) + 1
    if last >= _MAX_ROWS or width > _MAX_COLS:
        raise ValueError("read_excel: the sheet has a cell past Excel's %d rows and %d columns (row %d, column %d)"
                         % (_MAX_ROWS, _MAX_COLS, last + 1, width))
    budget.charge((last + 1) * (_ROW_BYTES + _CELL_BYTES * width), "the sheet's %d x %d cells" % (last + 1, width))
    out = []
    for i in range(last + 1):
        r = rows.get(i, {})
        out.append([r.get(j, "") for j in range(max(r) + 1)] if r else [])
    return out


def _scan_rows(doc, strings, xfs, d1904):
    """The sheet's cells as {row: {col: value}}, by the scanner's events."""
    rows = {}
    nxt, dropped = 0, False
    row_i = -1
    cell = None
    text = None
    for ev in events(doc):
        kind = ev[0]
        if kind == "start":
            n = local(ev[1])
            if n == "row":
                r = ev[2].get("r")
                row_i = int(r) - 1 if r else row_i + 1
                col = -1
                # (openpyxl's reader: a row whose number is below the next one expected is not read)
                dropped = row_i < nxt
                if not dropped:
                    nxt = row_i + 1
            elif n == "c":
                ref = ev[2].get("r")
                if ref:
                    m = _REF.fullmatch(ref)
                    col = _col_index(m.group(1)) if m else col + 1
                else:
                    col += 1
                cell = {"t": ev[2].get("t", "n"), "s": int(ev[2].get("s", "0")), "v": None, "is": []}
            elif n in ("v", "t") and cell is not None:
                text = []
        elif kind == "text":
            if text is not None:
                text.append(ev[1])
        else:
            n = local(ev[1])
            if n == "v" and cell is not None and text is not None:
                cell["v"] = "".join(text)
                text = None
            elif n == "t" and cell is not None and text is not None:
                cell["is"].append("".join(text))
                text = None
            elif n == "c" and cell is not None:
                val = _cell_value(cell, strings, xfs, d1904)
                if val != "" and not dropped:
                    rows.setdefault(row_i, {})[col] = val
                cell = None
    return rows


def _cell_value(c, strings, xfs, d1904):
    t, v = c["t"], c["v"]
    if t == "inlineStr":
        return "".join(c["is"])
    if v is None:
        return ""
    if t == "s":
        return strings[int(v)]
    if t in ("str", "e"):
        return float("nan") if t == "e" else v
    if t == "b":
        return v.strip() == "1"
    kind = xfs[c["s"]] if c["s"] < len(xfs) else None
    # (openpyxl's _cast_number: text with no point or exponent an int, exactly; otherwise a float, which pandas'
    # openpyxl reader makes an int when it has no fraction)
    if not kind and "." not in v and "e" not in v and "E" not in v:
        return int(v)
    f = float(v)
    if kind:
        return _from_excel(f, d1904, kind)
    i = int(f)
    return i if i == f else f


# --- pandas' Python parser, for typed values ---------------------------------

def _excel2num(x):
    # (pandas' _excel2num: letters only, any case; "" is -1)
    index = 0
    for c in x.upper().strip():
        cp = ord(c)
        if cp < 65 or cp > 90:
            raise ValueError("Invalid column name: %s" % x)
        index = index * 26 + cp - 64
    return index - 1


def _range2cols(areas):
    # (pandas' _range2cols: "A,C,Z:AB" as positions)
    cols = []
    for rng in areas.split(","):
        if ":" in rng:
            rngs = rng.split(":")
            cols.extend(range(_excel2num(rngs[0]), _excel2num(rngs[1]) + 1))
        else:
            cols.append(_excel2num(rng))
    return cols


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


_USECOLS_MSG = "'usecols' must either be list-like of all strings, all unicode, all integers or a callable."


# (pandas' parser on read_excel's values: its default NA strings, its true and false strings, and the numbers
# maybe_convert_numeric reads in text: surrounding whitespace, a sign, digits, a point, an exponent, inf)
_NA = frozenset(["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN", "<NA>",
                 "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"])
_TRUE = frozenset(["True", "TRUE", "true"])
_FALSE = frozenset(["False", "FALSE", "false"])
_INT_TEXT = re.compile(r"[+-]?[0-9]+\Z")
_FLOAT_TEXT = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z|[+-]?(?:inf|infinity)\Z", re.I)
_INT64 = 1 << 63


def _numeric(vals):
    """maybe_convert_numeric: the column as numbers (bool, int64 or float64), or None when a value isn't one."""
    out = []
    null = flt = num = big = False
    for v in vals:
        if isinstance(v, str):
            if v in _NA:
                out.append(None)
                null = True
                continue
            t = v.strip(" \t\n\r\f\v")
            if _INT_TEXT.match(t):
                v = int(t)
            elif _FLOAT_TEXT.match(t):
                v = float(t)
            else:
                return None
        if isinstance(v, bool):
            out.append(v)
        elif isinstance(v, int):
            if not -_INT64 <= v < _INT64:
                big = True
            num = True
            out.append(v)
        elif isinstance(v, float):
            if v != v:
                null = True
                out.append(None)
            else:
                flt = True
                out.append(v)
        else:
            return None
    if null or flt:
        return "float64", [float("nan") if v is None else float(v) for v in out]
    if big:
        # (all integers, one past int64: pandas makes uint64 or object of it)
        raise _subset("read_excel of a column of integers past int64 (pandas makes uint64 or object of it)")
    if num:
        return "int64", [int(v) for v in out]
    return "bool", out


def _infer_column(vals):
    """pandas' dtype for a column of the reader's values (NaN for empties): its parser's inference (_infer_types)."""
    from ._pd_column import column_from, Column
    from ._pd_datetime import DT, to_us
    if not vals:
        # (a header with no rows under it: pandas' empty column is object)
        return column_from([], dtype=object)
    present = [v for v in vals if not (isinstance(v, float) and v != v)]
    if not present:
        return Column("float64", np.array([float("nan")] * len(vals), dtype=np.float64))
    if all(isinstance(v, datetime) for v in present):
        return Column(DT, np.array([to_us(None if isinstance(v, float) else v) for v in vals], dtype=np.int64))
    r = _numeric(vals)
    if r is not None:
        kind, xs = r
        if kind == "float64":
            return Column("float64", np.array(xs, dtype=np.float64))
        return column_from(xs)
    # (not numbers: the NA strings are NaN, the rest as they are; then all true or false strings and bools: bool)
    vals = [float("nan") if isinstance(v, str) and v in _NA else v for v in vals]
    if all(isinstance(v, bool) or (isinstance(v, str) and (v in _TRUE or v in _FALSE)) for v in vals):
        return column_from([v if isinstance(v, bool) else v in _TRUE for v in vals])
    return column_from(vals)


def _frame(rows, header, skiprows, nrows, usecols, index_col):
    from ._pd_frame import DataFrame
    from ._pd_index import Index, RangeIndex
    # (a sheet with no rows at all: pandas' read_excel gives DataFrame() for it, before its parser)
    if not rows:
        return DataFrame()
    if nrows is not None and skiprows is not None and not _is_int(skiprows):
        # (pandas' read-ahead past the header then decides which rows count: not followed here; the sheet's
        # rows were already cut to what pandas asks openpyxl for, _file_rows)
        raise _subset("read_excel(skiprows=<a list>, nrows=)")
    width = max((len(r) for r in rows), default=0)
    rows = [r + [""] * (width - len(r)) for r in rows]
    if skiprows is not None:
        if _is_int(skiprows):
            # (a negative count skips nothing, as range(skiprows) is empty)
            rows = rows[max(skiprows, 0):]
        elif isinstance(skiprows, (list, tuple, range, set)):
            drop = set(skiprows)
            rows = [r for i, r in enumerate(rows) if i not in drop]
        elif callable(skiprows):
            raise _subset("read_excel(skiprows=%s)" % type(skiprows).__name__)
        else:
            raise TypeError("'%s' object is not iterable" % type(skiprows).__name__)
    if not rows:
        # (every row skipped: pandas' parser finds no data, and read_excel gives DataFrame())
        return DataFrame()
    if header is None:
        names = list(range(width))
        body = rows
    elif _is_int(header):
        if header >= len(rows):
            raise ValueError("Passed header=[%d], len of 1, but only %d lines in file" % (header, len(rows)))
        head = rows[header]
        body = rows[header + 1:]
        names = ["Unnamed: %d" % j if h == "" else h for j, h in enumerate(head)]
        # (pandas' Python parser: duplicates numbered, the named columns before the unnamed ones, a number taken
        # only if no column has that name already)
        unnamed = [j for j, h in enumerate(head) if h == ""]
        counts = {}
        for j in [j for j in range(len(names)) if head[j] != ""] + unnamed:
            col = old = names[j]
            cur = counts.get(col, 0)
            while cur > 0:
                counts[old] = cur + 1
                col = "%s.%d" % (old, cur)
                cur = cur + 1 if col in names else counts.get(col, 0)
            names[j] = col
            counts[col] = cur + 1
    else:
        raise _subset("read_excel(header=%r)" % (header,))
    if nrows is not None:
        body = body[:int(nrows)]
    js = list(range(width))
    if usecols is not None:
        # (a letter range is positions by now, _range2cols; then pandas' parser: all positions or all names)
        if callable(usecols):
            raise _subset("read_excel(usecols=%s)" % type(usecols).__name__)
        if not isinstance(usecols, (list, tuple, set, range)):
            raise ValueError(_USECOLS_MSG)
        want = set(usecols)
        if not want:
            raise _subset("read_excel(usecols=) selecting no column")
        if all(_is_int(u) for u in want):
            missing = sorted(u for u in want if u >= width)
            if missing:
                raise ParserError("Defining usecols with out-of-bounds indices is not allowed. %s are out-of-bounds." % missing)
            if min(want) < 0:
                raise _subset("read_excel(usecols=) with a negative position")
            js = [j for j in js if j in want]
        elif all(isinstance(u, str) for u in want):
            missing = [u for u in usecols if u not in names]
            if missing:
                raise ValueError("Usecols do not match columns, columns expected but not found: %r" % (missing,))
            js = [j for j in js if names[j] in want]
        else:
            raise ValueError(_USECOLS_MSG)
    nan = float("nan")
    cols = [_infer_column([nan if r[j] == "" else r[j] for r in body]) for j in js]
    labels = [names[j] for j in js]
    index = RangeIndex(len(body))
    if index_col is not None:
        if isinstance(index_col, bool):
            raise ValueError("The value of index_col couldn't be '%s'" % (index_col,))
        if not _is_int(index_col):
            raise _subset("read_excel(index_col=%r)" % (index_col,))
        index = Index(cols[index_col], name=labels[index_col])
        del cols[index_col], labels[index_col]
    return DataFrame._pd_new(cols, Index(labels) if header is not None else RangeIndex(len(labels)) if usecols is None else Index(labels), index)


def read_excel(io, sheet_name=0, *, header=0, names=None, index_col=None, usecols=None, dtype=None, engine=None,
               converters=None, true_values=None, false_values=None, skiprows=None, nrows=None, na_values=None,
               keep_default_na=True, na_filter=True, verbose=False, parse_dates=False, date_format=None,
               thousands=None, decimal=".", comment=None, skipfooter=0, storage_options=None,
               dtype_backend=None, engine_kwargs=None):
    """pandas.read_excel for .xlsx and .xlsm workbooks (see the module's note)."""
    if engine not in (None, "openpyxl"):
        raise _subset("read_excel(engine=%r)" % (engine,))
    for name, v, default in (("names", names, None), ("dtype", dtype, None), ("converters", converters, None),
                             ("true_values", true_values, None), ("false_values", false_values, None),
                             ("na_values", na_values, None), ("parse_dates", parse_dates, False),
                             ("date_format", date_format, None), ("thousands", thousands, None),
                             ("comment", comment, None), ("skipfooter", skipfooter, 0),
                             ("storage_options", storage_options, None), ("dtype_backend", dtype_backend, None),
                             ("engine_kwargs", engine_kwargs, None)):
        if v is not default and v != default:
            raise _subset("read_excel(%s=)" % name)
    if not keep_default_na or not na_filter or decimal != ".":
        raise _subset("read_excel(keep_default_na=, na_filter=, decimal=)")
    data = _read_bytes(io)
    if data[:4] != b"PK\x03\x04":
        if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise _subset("an .xls workbook (only .xlsx and .xlsm are read)")
        raise ValueError("Excel file format cannot be determined, you must specify an engine manually.")
    from ._pd_csv import _make_budget
    budget = _make_budget("read_excel")
    z = ZipArchive(data, budget if budget.finite else None)
    sheets, d1904 = _workbook(z)
    strings = _shared_strings(z)
    xfs = _styles(z)
    # (pandas' ExcelFile.parse: header and nrows checked first)
    _check_header(header)
    nrows = _check_nrows(nrows)
    file_rows = _file_rows(header, skiprows, nrows)
    if isinstance(usecols, str):
        usecols = _range2cols(usecols)
    elif _is_int(usecols):
        raise ValueError("Passing an integer for `usecols` is no longer supported.  "
                         "Please pass in a list of int from 0 to `usecols` inclusive instead.")

    def one(key):
        # (a str is a name; anything else an index into the sheets, as a list's: -1 the last)
        if isinstance(key, str):
            hit = [s for s in sheets if s[0] == key]
            if not hit:
                raise ValueError("Worksheet named '%s' not found" % key)
            name, path = hit[0]
        else:
            if key >= len(sheets):
                raise ValueError("Worksheet index %d is invalid, %d worksheets found" % (key, len(sheets)))
            name, path = sheets[key]
        rows = _sheet_rows(z, path, strings, xfs, d1904, budget, file_rows)
        try:
            return _frame(rows, header, skiprows, nrows, usecols, index_col)
        except NotImplementedError:
            raise
        except Exception as err:
            # (pandas' _parse_sheet names the sheet in its parser's errors)
            if err.args:
                err.args = ("%s (sheet: %s)" % (err.args[0], key),) + tuple(err.args[1:])
            raise

    if sheet_name is None:
        return {s[0]: one(s[0]) for s in sheets}
    if isinstance(sheet_name, list):
        keys = list(dict.fromkeys(sheet_name))
        if not keys:
            raise ValueError("Sheet name is an empty list")
        return {k: one(k) for k in keys}
    return one(sheet_name)


def _check_header(header):
    # (pandas' validate_header_arg)
    if header is None:
        return
    if _is_int(header):
        if header < 0:
            raise ValueError("Passing negative integer to header is invalid. For no header, use header=None instead")
        return
    if isinstance(header, (list, tuple)):
        if not all(_is_int(h) for h in header):
            raise ValueError("header must be integer or list of integers")
        return
    if isinstance(header, bool):
        raise TypeError("Passing a bool to header is invalid. Use header=None for no header or header=int or "
                        "list-like of ints to specify the row(s) making up the column names")
    raise ValueError("header must be integer or list of integers")


def _check_nrows(nrows):
    # (pandas' validate_integer("nrows", nrows): an integral float is its int)
    if nrows is None:
        return None
    msg = "'nrows' must be an integer >=0"
    if isinstance(nrows, float):
        if int(nrows) != nrows:
            raise ValueError(msg)
        nrows = int(nrows)
        if nrows < 0:
            raise _subset("read_excel(nrows=) a negative float")
    elif not (_is_int(nrows) and nrows >= 0):
        raise ValueError(msg)
    return nrows


def _file_rows(header, skiprows, nrows):
    # (pandas' _calc_rows: the rows it asks openpyxl for, with nrows; None for all of them, as with a list or a
    # function of skiprows, which _frame refuses with nrows)
    if nrows is None or not (header is None or _is_int(header)):
        return None
    header_rows = 1 if header is None else 1 + header
    if skiprows is None:
        return header_rows + nrows
    if _is_int(skiprows):
        return header_rows + nrows + skiprows
    return None


def _read_bytes(io):
    if isinstance(io, (bytes, bytearray)):
        # (pandas' own errors for what isn't a path or a file)
        raise TypeError("Expected file path name or file-like object, got %r type" % type(io))
    if isinstance(io, str):
        # (as read_csv: pandas fetches a URL itself; here the file must be in the project first, nothing fetched)
        if re.match(r"(?i)(https?|ftp|s3|gs)://", io):
            raise NotImplementedError("read_excel from a URL isn't supported; download the file into the project first")
        with open(io, "rb") as f:
            return f.read()
    try:
        read = io.read
    except AttributeError:
        raise ValueError("Invalid file path or buffer object type: %r" % type(io)) from None
    data = read()
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("read_excel needs a binary file")
    return bytes(data)
