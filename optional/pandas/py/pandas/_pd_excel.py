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


def _sheet_rows(z, path, strings, xfs, d1904):
    """The sheet's values as rows of Python values ("" for an empty cell, as
    pandas' openpyxl reader has them), trailing empties dropped."""
    rows = {}
    row_i = -1
    cell = None
    text = None
    for ev in events(_xml(z, path)):
        kind = ev[0]
        if kind == "start":
            n = local(ev[1])
            if n == "row":
                r = ev[2].get("r")
                row_i = int(r) - 1 if r else row_i + 1
                col = -1
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
                if val != "":
                    rows.setdefault(row_i, {})[col] = val
                cell = None
    if not rows:
        return []
    last = max(rows)
    out = []
    for i in range(last + 1):
        r = rows.get(i, {})
        out.append([r.get(j, "") for j in range(max(r) + 1)] if r else [])
    return out


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
    f = float(v)
    kind = xfs[c["s"]] if c["s"] < len(xfs) else None
    if kind:
        return _from_excel(f, d1904, kind)
    # (pandas' openpyxl reader: a number with no fraction is an int)
    i = int(f)
    return i if i == f else f


# --- pandas' Python parser, for typed values ---------------------------------

def _col_letters_range(spec):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if ":" in part:
            a, b = part.split(":")
            out.extend(range(_col_index(a.strip().upper()), _col_index(b.strip().upper()) + 1))
        else:
            out.append(_col_index(part.upper()))
    return out


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
    null = flt = num = False
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
                raise _subset("read_excel of a column of integers past int64 (pandas makes uint64 or object of it)")
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
    if nrows is not None:
        # (pandas asks the sheet for only the rows it needs, the header and nrows past the rows skipped: the width
        # is theirs)
        need = (0 if header is None else int(header) + 1) + int(nrows)
        if isinstance(skiprows, int) and not isinstance(skiprows, bool):
            rows = rows[:skiprows + need]
        elif skiprows is not None:
            drop, kept, cut = set(skiprows), 0, len(rows)
            for i in range(len(rows)):
                if i not in drop:
                    kept += 1
                    if kept == need:
                        cut = i + 1
                        break
            rows = rows[:cut]
        else:
            rows = rows[:need]
    width = max((len(r) for r in rows), default=0)
    rows = [r + [""] * (width - len(r)) for r in rows]
    if skiprows is not None:
        if isinstance(skiprows, int) and not isinstance(skiprows, bool):
            rows = rows[skiprows:]
        elif isinstance(skiprows, (list, tuple, range, set)):
            drop = set(skiprows)
            rows = [r for i, r in enumerate(rows) if i not in drop]
        else:
            raise _subset("read_excel(skiprows=%s)" % type(skiprows).__name__)
    if header is None:
        names = list(range(width))
        body = rows
    elif isinstance(header, int) and not isinstance(header, bool):
        if header >= len(rows):
            raise ValueError("Passed header=%d, len of %d, but only %d lines in file" % (header, len(rows), len(rows)))
        head = rows[header]
        body = rows[header + 1:]
        names, seen = [], {}
        for j, h in enumerate(head):
            if h == "":
                h = "Unnamed: %d" % j
            k = seen.get(h, 0)
            seen[h] = k + 1
            names.append(h if k == 0 else "%s.%d" % (h, k))
    else:
        raise _subset("read_excel(header=%r)" % (header,))
    if nrows is not None:
        body = body[:int(nrows)]
    js = list(range(width))
    if usecols is not None:
        if isinstance(usecols, str):
            want = _col_letters_range(usecols)
            js = [j for j in js if j in set(want)]
        elif isinstance(usecols, (list, tuple)):
            if all(isinstance(u, int) and not isinstance(u, bool) for u in usecols):
                js = [j for j in js if j in set(usecols)]
            else:
                js = [j for j in js if names[j] in set(usecols)]
        else:
            raise _subset("read_excel(usecols=%s)" % type(usecols).__name__)
    nan = float("nan")
    cols = [_infer_column([nan if r[j] == "" else r[j] for r in body]) for j in js]
    labels = [names[j] for j in js]
    index = RangeIndex(len(body))
    if index_col is not None:
        if not isinstance(index_col, int) or isinstance(index_col, bool):
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
    budget = _make_budget()
    z = ZipArchive(data, budget if budget.finite else None)
    sheets, d1904 = _workbook(z)
    strings = _shared_strings(z)
    xfs = _styles(z)

    def one(key):
        if isinstance(key, int) and not isinstance(key, bool):
            if not 0 <= key < len(sheets):
                raise ValueError("Worksheet index %d is invalid, %d worksheets found" % (key, len(sheets)))
            name, path = sheets[key]
        else:
            hit = [s for s in sheets if s[0] == key]
            if not hit:
                raise ValueError("Worksheet named '%s' not found" % key)
            name, path = hit[0]
        rows = _sheet_rows(z, path, strings, xfs, d1904)
        return _frame(rows, header, skiprows, nrows, usecols, index_col)

    if sheet_name is None:
        return {s[0]: one(i) for i, s in enumerate(sheets)}
    if isinstance(sheet_name, list):
        return {k: one(k) for k in sheet_name}
    return one(sheet_name)


def _read_bytes(io):
    if isinstance(io, (bytes, bytearray)):
        raise _subset("read_excel of bytes (pass a path or a file-like object)")
    if isinstance(io, str):
        with open(io, "rb") as f:
            return f.read()
    try:
        data = io.read()
    except AttributeError:
        raise _subset("read_excel(%s)" % type(io).__name__)
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("read_excel needs a binary file")
    return bytes(data)
