"""read_csv (plan-pandas-m1-r1 §3, r7 §E): a streaming tokenizer with
typed column builders, and the decoded-memory budget.

The tokenizer reimplements pandas/_libs/src/parser/tokenizer.c's state
machine for the options M1 has (sep, quotechar with doubled quotes, \\n,
\\r\\n and \\r line ends, quoted fields spanning lines, blank lines
skipped), reading 64 KiB blocks.  The builders replace
pandas/_libs/parsers.pyx's type inference, as measured on the oracle:

- a column is int64 while every value is an integer, float64 once a value
  is a float or missing, bool while every value is True/true/TRUE or
  False/false/FALSE (object with a missing value), and str otherwise, with
  every value's original text (spaces included);
- '' and pandas' default NA strings are missing (keep_default_na), plus
  na_values;
- an integer outside int64 (pandas' uint64 or object) is NotImplementedError.

The builders keep only the parsed numbers, plus the original text of a
value whose text a number doesn't reproduce ('007', ' 4', '1e5'), so a
column that becomes str shows pandas' text.

The budget (r7 §E 1a): when sagebrush.limit("pandas.decoded_bytes") is
finite, every growth is preflighted (its charge computed before the
allocation and checked against the limit), and a refusal is a ValueError
raised before the growth.  The limit is read at each read_csv call (set it
before the first: reading it fixes all of Sagebrush's limits).  The input
cap (32 MiB) applies only under a finite limit; the 1 MiB field cap always.
"""

import array
import re

import numpy as np

from .errors import EmptyDataError, ParserError
from ._pd_column import Column
from ._pd_dtypes import STR, resolve_dtype
from ._pd_index import Index, RangeIndex, default_index

__all__ = ["read_csv"]

_BLOCK = 65536
_FIELD_CAP = 1 << 20
_INPUT_CAP = 32 << 20
_LIMIT_KEY = "pandas.decoded_bytes"

_DEFAULT_NA = frozenset([
    "", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan",
    "1.#IND", "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a",
    "nan", "null",
])
_TRUE = frozenset(["True", "true", "TRUE"])
_FALSE = frozenset(["False", "false", "FALSE"])

_INT_RE = re.compile(r"[ \t]*[+-]?[0-9]+[ \t]*")
_FLOAT_RE = re.compile(r"[ \t]*[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|inf|infinity)[ \t]*", re.I)
_INTS_RE = re.compile(r"[ \t]*[+-]?[0-9]+[ \t]*(?:\n[ \t]*[+-]?[0-9]+[ \t]*)*")
_FLOATS_RE = re.compile(r"[ \t]*[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|inf|infinity)[ \t]*"
                        r"(?:\n[ \t]*[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|inf|infinity)[ \t]*)*", re.I)
_LINE_RE = re.compile(r"\r\n|\r|\n")
_LINE_END_RE = re.compile(r"(\r\n|\r|\n)")

_I64_MIN, _I64_MAX = -(2 ** 63), 2 ** 63 - 1
_EXACT = 2 ** 53

_SUPPORTED = frozenset(["sep", "header", "names", "index_col", "usecols", "na_values",
                        "keep_default_na", "dtype", "nrows", "skiprows", "quotechar", "parse_dates"])


def _unsupported(what):
    return NotImplementedError("pandas.read_csv(%s) is not in Sagebrush's pandas 0.x subset" % what)


# --- the budget ------------------------------------------------------------

class _NoBudget(object):
    """The default: no limit, so nothing is counted."""

    __slots__ = ()
    finite = False

    def charge(self, n, what):
        pass

    def release(self, n):
        pass


class _Budget(object):
    """A finite decoded budget: charge() preflights, release() returns."""

    __slots__ = ("limit", "used")
    finite = True

    def __init__(self, limit):
        self.limit = limit
        self.used = 0

    def charge(self, n, what):
        if self.used + n > self.limit:
            raise ValueError(
                "read_csv: the decoded-memory budget would be exceeded by %s (%d B more, %d B in use, "
                "limit %d B: Sagebrush's limit %r)" % (what, n, self.used, self.limit, _LIMIT_KEY))
        self.used += n

    def release(self, n):
        self.used -= n


def _string_charge(n):
    # (r7 §E 1a: a string of n code points, before it is created)
    return 64 + 4 * n


def _list_charge(n):
    # (CPython's list_resize for a list grown to length n, unrounded)
    return 8 * (n + (n >> 3) + 6) if n else 0


def _list_capacity(n):
    return (n + (n >> 3) + 6) & ~3 if n else 0


def _array_capacity(length, cap):
    # (CPython 3.14's array_resize growing to length + 1)
    n = length + 1
    return n + (n >> 4) + (3 if length < 8 else 7)


_RAW_ENTRY = 100        # (a retained original text's dict entry, as the index map's label)


def _make_budget():
    import sagebrush
    lim = sagebrush.limit(_LIMIT_KEY)
    if lim == float("inf"):
        return _NoBudget()
    return _Budget(int(lim))


# --- column builders -------------------------------------------------------

class _Builder(object):
    """One column's values while parsing: 'empty' (only missing so far),
    'int', 'float', 'bool' or 'str'; or a forced dtype."""

    __slots__ = ("state", "n", "nums", "cap", "charged", "raw", "widen_at", "lst", "lcap",
                 "lcharged", "has_na", "na_before", "budget", "forced", "j", "big", "chunks")

    def __init__(self, budget, forced, j):
        self.state = "empty" if forced is None else "forced"
        self.n = 0
        self.nums = None        # array('q') or array('d')
        self.cap = 0            # its modelled capacity
        self.charged = 0        # its charge
        self.raw = None         # {position: original text}
        self.widen_at = 0       # (positions below were ints, in a float column)
        self.lst = None         # str/bool/forced values
        self.lcap = 0
        self.lcharged = 0
        self.has_na = False
        self.na_before = 0
        self.budget = budget
        self.forced = forced
        self.j = j
        self.big = None         # (an integer outside int64, while no text has come)
        self.chunks = None      # [(position, joined original texts)] of non-canonical chunks

    # (growth, preflighted)
    def _num_append(self, v):
        if self.n == self.cap:
            new = 8 * 2 * max(self.cap, 4)
            self.budget.charge(new, "a numeric column's growth")
            self.nums.append(v)
            self.budget.release(self.charged)
            self.charged = new
            self.cap = _array_capacity(self.n, self.cap)
        else:
            self.nums.append(v)
        self.n += 1

    def _list_append(self, v):
        k = len(self.lst)
        if k == self.lcap:
            new = _list_charge(k + 1)
            self.budget.charge(new, "a column's list growth")
            self.lst.append(v)
            self.budget.release(self.lcharged)
            self.lcharged = new
            self.lcap = _list_capacity(k + 1)
        else:
            self.lst.append(v)
        self.n += 1

    def _keep_raw(self, pos, text):
        self.budget.charge(_string_charge(len(text)) + _RAW_ENTRY, "a value's original text")
        if self.raw is None:
            self.raw = {}
        self.raw[pos] = text

    def _new_str(self, text):
        self.budget.charge(_string_charge(len(text)), "a string")
        return text

    def add(self, text, na):
        """Add one field (text, and whether it is a missing value)."""
        st = self.state
        if st == "int":
            if na:
                self._to_float()
                self._num_append(float("nan"))
                return
            if _INT_RE.fullmatch(text):
                v = int(text)
                if _I64_MIN <= v <= _I64_MAX:
                    if str(v) != text:
                        self._keep_raw(self.n, text)
                    self._num_append(v)
                    return
                self._big_int(text)
                return
            if _FLOAT_RE.fullmatch(text):
                self._to_float()
                self._add_float(text)
                return
            self._to_str()
            self._list_append(self._new_str(text))
            return
        if st == "float":
            if na:
                self._num_append(float("nan"))
            elif _FLOAT_RE.fullmatch(text):
                self._add_float(text)
            else:
                self._to_str()
                self._list_append(self._new_str(text))
            return
        if st == "str":
            if self.big is not None and not na and not _FLOAT_RE.fullmatch(text):
                self.big = None
            self._list_append(float("nan") if na else self._new_str(text))
            return
        if st == "bool":
            if na:
                self.has_na = True
                self._list_append(float("nan"))
            elif text in _TRUE or text in _FALSE:
                if text != "True" and text != "False":
                    self._keep_raw(self.n, text)
                self._list_append(text in _TRUE)
            else:
                self._bool_to_str()
                self._list_append(self._new_str(text))
            return
        if st == "forced":
            self._add_forced(text, na)
            return
        # (empty: only missing values so far)
        if na:
            self.na_before += 1
            self.n += 1
            return
        if _INT_RE.fullmatch(text) and not self.na_before:
            self.state = "int"
            self.nums = array.array("q")
            self.add(text, na)
        elif _INT_RE.fullmatch(text) or _FLOAT_RE.fullmatch(text):
            self._start_float_after_na()
            self._add_float(text)
        elif text in _TRUE or text in _FALSE:
            self.state = "bool"
            self._start_list_after_na()
            self.has_na = self.na_before > 0
            self.add(text, na)
        else:
            self.state = "str"
            self._start_list_after_na()
            self.add(text, na)

    def _big_int(self, text):
        # (pandas makes the column uint64 or object unless text follows,
        # when it is str: so str, provisionally)
        if self.state in ("int", "float"):
            self._to_str()
        elif self.state == "empty":
            self.state = "str"
            self._start_list_after_na()
        self.big = text.strip()
        self._list_append(self._new_str(text))

    def _add_float(self, text):
        v = float(text)
        if repr(v) != text:
            self._keep_raw(self.n, text)
        self._num_append(v)

    def _start_float_after_na(self):
        k = self.na_before
        self.state = "float"
        self.nums = array.array("d")
        self.n = 0
        for _ in range(k):
            self._num_append(float("nan"))

    def _start_list_after_na(self):
        k = self.na_before
        self.lst = []
        self.n = 0
        for _ in range(k):
            self._list_append(float("nan"))

    def _to_float(self):
        """int -> float: a new array('d') of the values, preflighted with
        the int array still live; an int beyond 2**53 keeps its text."""
        old = self.nums
        k = len(old)
        new_charge = 8 * 2 * max(k, 4)
        self.budget.charge(new_charge, "widening a column to float64")
        for i, v in enumerate(old):
            if (v > _EXACT or v < -_EXACT) and (self.raw is None or i not in self.raw):
                self._keep_raw(i, str(v))
        self.nums = array.array("d", old)
        self.budget.release(self.charged)
        self.charged = new_charge
        self.cap = k
        self.widen_at = k
        self.state = "float"

    def _num_text(self, i, v, int_state):
        if self.raw is not None and i in self.raw:
            return self.raw[i]
        if int_state:
            return str(v)
        if v != v:
            return None
        return str(int(v)) if i < self.widen_at else repr(v)

    def _to_str(self):
        """int/float -> str, preflighted as one step (r7 §E 1a): the
        target list, one string per value converted, the chunks' texts and
        the scratch (the numeric builder and the original texts are charged
        already)."""
        nums, n = self.nums, self.n
        int_state = self.state == "int"
        charge = _list_charge(n + 1) + 8 * n
        for i in range(n):
            t = self._num_text(i, nums[i], int_state)
            if t is not None:
                charge += _string_charge(len(t))
        for start, joined in self.chunks or ():
            charge += 64 * (joined.count("\n") + 1) + 4 * len(joined)
        self.budget.charge(charge, "widening a column to str")
        lst = []
        for i in range(n):
            t = self._num_text(i, nums[i], int_state)
            lst.append(float("nan") if t is None else t)
        for start, joined in self.chunks or ():
            parts = joined.split("\n")
            lst[start:start + len(parts)] = parts
        self.budget.release(8 * n)
        self.lst = lst
        self.lcap = _list_capacity(n + 1)
        self.lcharged = _list_charge(n + 1)
        self.nums = None
        self.budget.release(self.charged)
        self.charged = 0
        self.raw = None
        self.chunks = None
        self.state = "str"

    def _bool_to_str(self):
        lst = self.lst
        charge = 0
        for i, v in enumerate(lst):
            if v == v and not (self.raw is not None and i in self.raw):
                charge += _string_charge(5)
        self.budget.charge(charge, "widening a column to str")
        for i, v in enumerate(lst):
            if v != v:
                continue
            lst[i] = self.raw[i] if self.raw is not None and i in self.raw else ("True" if v else "False")
        self.raw = None
        self.state = "str"

    def _add_forced(self, text, na):
        d = self.forced
        if self.lst is None:
            self.lst = []
        if d is STR or d == "object":
            self._list_append(float("nan") if na else self._new_str(text))
        elif d == "float64":
            if na:
                self._list_append(float("nan"))
            else:
                try:
                    self._list_append(float(text))
                except ValueError:
                    raise ValueError("could not convert string to float: %r" % text) from None
        elif d == "int64":
            if na:
                raise ValueError("Integer column has NA values in column %d" % self.j)
            if not _INT_RE.fullmatch(text):
                raise ValueError("invalid literal for int() with base 10: %r" % text)
            v = int(text)
            if not _I64_MIN <= v <= _I64_MAX:
                raise OverflowError("Python int too large to convert to C long")
            self._list_append(v)
        elif d == "bool":
            if na:
                raise ValueError("Bool column has NA values in column %d" % self.j)
            if text in _TRUE or text.strip() == "1":
                self._list_append(True)
            elif text in _FALSE or text.strip() == "0":
                self._list_append(False)
            else:
                raise _unsupported("dtype=bool with the value %r" % text)

    # (a chunk of one column's fields at once: one regex over the joined
    # texts, then map(); any chunk it can't decide goes value by value)
    def add_many(self, texts, na):
        st = self.state
        if not texts:
            return
        if not na.isdisjoint(texts) or st in ("bool", "forced") or self.big is not None:
            for t in texts:
                self.add(t, t in na)
            return
        if st == "int" or (st == "empty" and not self.na_before):
            joined = "\n".join(texts)
            if joined.count("\n") == len(texts) - 1 and _INTS_RE.fullmatch(joined):
                vals = list(map(int, texts))
                if _I64_MIN <= min(vals) and max(vals) <= _I64_MAX:
                    if st == "empty":
                        self.state = "int"
                        self.nums = array.array("q")
                    self._keep_chunk(joined, "\n".join(map(str, vals)) == joined)
                    self._num_extend(vals)
                    return
        elif st == "float" or st == "empty":
            joined = "\n".join(texts)
            if joined.count("\n") == len(texts) - 1 and _FLOATS_RE.fullmatch(joined):
                vals = list(map(float, texts))
                if st == "empty":
                    self._start_float_after_na()
                self._keep_chunk(joined, "\n".join(map(repr, vals)) == joined)
                self._num_extend(vals)
                return
        elif st == "str":
            self.budget.charge(64 * len(texts) + 4 * sum(map(len, texts)), "strings")
            self._list_extend(texts)
            return
        for t in texts:
            self.add(t, False)

    def _keep_chunk(self, joined, canonical):
        # (a chunk whose numbers don't reproduce its texts keeps them, joined:
        # one string, as pandas' token buffer keeps every text)
        if canonical:
            return
        self.budget.charge(_string_charge(len(joined)) + 72, "a chunk's original texts")
        if self.chunks is None:
            self.chunks = []
        self.chunks.append((self.n, joined))

    def _num_extend(self, vals):
        """Append vals, preflighting the growth: every resize array.extend
        makes on the way, the last two live together (r7 §E 1a)."""
        target = self.n + len(vals)
        cap, length = self.cap, self.n
        charges = []
        while cap < target:
            charges.append(8 * 2 * max(cap, 4))
            length = cap
            cap = _array_capacity(length, cap)
        if charges:
            peak = charges[-1] + (charges[-2] if len(charges) > 1 else 0)
            self.budget.charge(peak, "a numeric column's growth")
            self.nums.extend(vals)
            self.budget.release(self.charged + peak - charges[-1])
            self.charged = charges[-1]
            self.cap = cap
        else:
            self.nums.extend(vals)
        self.n = target

    def _list_extend(self, vals):
        k = len(self.lst) + len(vals)
        if k > self.lcap:
            new = _list_charge(k)
            self.budget.charge(new, "a column's list growth")
            self.lst.extend(vals)
            self.budget.release(self.lcharged)
            self.lcharged = new
            self.lcap = _list_capacity(k)
        else:
            self.lst.extend(vals)
        self.n += len(vals)

    def finish(self):
        """The column; charges the output and the one conversion copy,
        then releases the builder."""
        st, n, b = self.state, self.n, self.budget
        if n == 0:
            return Column("object", [])
        if st == "empty":
            b.charge(16 * n, "a column's output")
            col = Column("float64", np.full(n, float("nan")))
            b.release(8 * n)
            return col
        if st in ("int", "float"):
            dt = "int64" if st == "int" else "float64"
            b.charge(16 * n, "a column's output")
            col = Column(dt, np.frombuffer(memoryview(self.nums), dtype=dt).copy())
            self.nums = None
            b.release(self.charged + 8 * n)
            self.charged = 0
            return col
        if st == "bool":
            if self.has_na:
                return self._finish_list("object")
            b.charge(2 * n, "a column's output")
            col = Column("bool", np.array(self.lst, dtype=bool))
            b.release(self.lcharged + n)
            self.lst = None
            return col
        if st == "str":
            if self.big is not None:
                raise NotImplementedError("pandas.read_csv: the integer %s is outside int64 (pandas makes uint64 or object), not in Sagebrush's pandas 0.x subset" % self.big)
            return self._finish_list(STR)
        d = self.forced
        if d in ("float64", "int64", "bool"):
            item = 1 if d == "bool" else 8
            b.charge(2 * item * n, "a column's output")
            col = Column(d, np.array(self.lst, dtype=d))
            b.release(self.lcharged + item * n)
            self.lst = None
            return col
        return self._finish_list(d)

    def _finish_list(self, dtype):
        # (the list itself becomes the column: no copy)
        return Column(dtype, self.lst)


# --- the tokenizer ---------------------------------------------------------

class _Reader(object):
    """Rows of field texts, a block of lines at a time.

    A line without the quote character is split on sep; a line with it is
    matched by a regex of quoted and unquoted fields, and a quoted field that
    continues on the next line goes through tokenizer.c's state machine.
    batch() returns (rows, line numbers), the numbers 1-based physical
    lines."""

    def __init__(self, read, sep, quotechar, budget):
        self.read = read
        self.sep = sep
        self.q = quotechar
        self.budget = budget
        self.pending = ""
        self.pending_charge = 0
        self.eof = False
        self.lines = []
        self.pos = 0
        self.line = 0          # (physical lines consumed)
        self.total = 0
        self.first = True
        self.block_charge = 0
        self.quoted_block = False
        self.ends = []
        qe, se = re.escape(quotechar), re.escape(sep)
        self.field_re = re.compile(
            "(?:%s((?:[^%s]|%s%s)*)%s([^%s]*)|([^%s]*))(?:%s|$)" % (qe, qe, qe, qe, qe, se, se, se))
        budget.charge(_BLOCK * 4 + _FIELD_CAP * 4, "the parser's buffers")

    def _block(self):
        s = self.read(_BLOCK)
        if not isinstance(s, str):
            raise _unsupported("a binary file object")
        if not s:
            self.eof = True
            return ""
        if self.first:
            self.first = False
            if s.startswith("﻿"):
                s = s[1:]
        self.total += len(s)
        if self.budget.finite and self.total > _INPUT_CAP:
            raise ValueError("read_csv: the input is larger than %d bytes, the cap under Sagebrush's limits (%r is finite)" % (_INPUT_CAP, _LIMIT_KEY))
        return s

    def _refill(self):
        """The next block's complete lines; False at the end."""
        b = self.budget
        b.release(self.block_charge)
        self.block_charge = 0
        self.lines = []
        self.pos = 0
        while True:
            if self.eof and not self.pending:
                return False
            if not self.eof:
                s = self._block()
                if s:
                    # (the text pending is a string about to be created)
                    new = _string_charge(len(self.pending) + len(s))
                    b.charge(new, "the parser's pending text")
                    self.pending += s
                    b.release(self.pending_charge)
                    self.pending_charge = new
            text = self.pending
            if self.eof:
                complete, rest = text, ""
            else:
                # (up to the last line end, but not a final \r: a \n may
                # follow it in the next block)
                end = len(text) - 1 if text.endswith("\r") else len(text)
                k = max(text.rfind("\n", 0, end), text.rfind("\r", 0, end))
                if k < 0:
                    continue
                complete, rest = text[:k + 1], text[k + 1:]
            # (the block's tokens, before they are created: its lines, its
            # fields and their lists, bounded by its separators and length)
            nlines = complete.count("\n") + complete.count("\r") + 1
            nfields = complete.count(self.sep) + nlines
            charge = 64 * (2 * nlines + 2 * nfields) + 8 * len(complete) + 16 * nfields
            b.charge(charge, "a block's fields")
            self.block_charge = charge
            self.quoted_block = self.q in complete
            if self.quoted_block:
                # (with each line's end: a quoted field keeps the ends it spans)
                parts = _LINE_END_RE.split(complete)
                lines, ends = parts[0::2], parts[1::2]
                if len(lines) > len(ends) and lines[-1] == "":
                    lines.pop()
                self.ends = ends
            else:
                lines = _LINE_RE.split(complete)
                if lines and lines[-1] == "":
                    lines.pop()
            self.pending = rest
            self.lines = lines
            if lines:
                return True
            if self.eof:
                return False

    def _next_line(self):
        if self.pos >= len(self.lines):
            # (a quoted field continues past the block)
            if not self._refill():
                return None
        line = self.lines[self.pos]
        self.pos += 1
        self.line += 1
        return line

    def batch(self):
        """(rows, line numbers) of the next block, or None at the end."""
        if self.pos >= len(self.lines) and not self._refill():
            return None
        sep = self.sep
        if not self.quoted_block:
            seg = self.lines[self.pos:] if self.pos else self.lines
            self.pos = len(self.lines)
            first = self.line + 1
            self.line += len(seg)
            rows = [line.split(sep) for line in seg]
            if self.total and len(seg) and max(map(len, seg)) > _FIELD_CAP:
                for r in rows:
                    _check_fields(r)
            return rows, range(first, first + len(seg))
        rows, nums = [], []
        q = self.q
        while self.pos < len(self.lines):
            line = self.lines[self.pos]
            self.pos += 1
            self.line += 1
            nums.append(self.line)
            if q in line:
                rows.append(self._quoted(line))
            else:
                r = line.split(sep)
                if len(line) > _FIELD_CAP:
                    _check_fields(r)
                rows.append(r)
        return rows, nums

    def _quoted(self, line):
        fields = self._match(line)
        if fields is not None:
            return fields
        return self._machine(line)

    def _match(self, line):
        """The fields of a line whose quoted fields all close on it, by
        regex; None for the state machine."""
        q = self.q
        out = []
        pos = 0
        n = len(line)
        m = self.field_re
        while True:
            r = m.match(line, pos)
            if r is None:
                return None
            quoted, after, plain = r.group(1), r.group(2), r.group(3)
            if quoted is not None:
                out.append(quoted.replace(q + q, q) + after)
            else:
                if plain.startswith(q):
                    return None
                out.append(plain)
            pos = r.end()
            if pos >= n:
                # (a separator ending the line: one more, empty field)
                if r.group(0).endswith(self.sep):
                    out.append("")
                break
        for f in out:
            if len(f) > _FIELD_CAP:
                _check_fields(out)
        return out

    def _machine(self, line):
        """tokenizer.c's state machine, for a line with a quoted field that
        may continue on the next lines."""
        q, sep = self.q, self.sep
        start_row = self.line - 1
        fields = []
        cur = []
        size = 0
        state = 0        # 0 start of field, 1 in field, 2 in quotes, 3 quote in quotes
        while True:
            for c in line:
                if state == 0:
                    if c == q:
                        state = 2
                    elif c == sep:
                        fields.append("")
                    else:
                        cur.append(c)
                        size += 1
                        state = 1
                elif state == 1:
                    if c == sep:
                        fields.append("".join(cur))
                        cur = []
                        size = 0
                        state = 0
                    else:
                        cur.append(c)
                        size += 1
                elif state == 2:
                    if c == q:
                        state = 3
                    else:
                        cur.append(c)
                        size += 1
                else:
                    if c == q:
                        cur.append(q)
                        size += 1
                        state = 2
                    elif c == sep:
                        fields.append("".join(cur))
                        cur = []
                        size = 0
                        state = 0
                    else:
                        cur.append(c)
                        size += 1
                        state = 1
                if size > _FIELD_CAP:
                    raise ValueError("read_csv: a field is longer than %d characters, Sagebrush's field cap" % _FIELD_CAP)
            if state != 2:
                break
            # (a quoted field continues on the next line, with the line end)
            end = self.ends[self.pos - 1] if self.pos - 1 < len(self.ends) else ""
            line = self._next_line()
            if line is None:
                raise ParserError("Error tokenizing data. C error: EOF inside string starting at row %d" % start_row)
            cur.append(end)
            size += len(end)
        fields.append("".join(cur))
        return fields

    def close(self):
        self.budget.release(self.block_charge + self.pending_charge)
        self.block_charge = self.pending_charge = 0


def _check_fields(fields):
    for f in fields:
        if len(f) > _FIELD_CAP:
            raise ValueError("read_csv: a field is longer than %d characters, Sagebrush's field cap" % _FIELD_CAP)


def _is_blank_row(r):
    return len(r) == 1 and not r[0].strip(" \t")


# --- read_csv --------------------------------------------------------------

def _mangle(labels):
    out = []
    seen = {}
    for i, lab in enumerate(labels):
        if lab == "" or lab is None:
            lab = "Unnamed: %d" % i
        if lab in seen:
            k = seen[lab]
            new = "%s.%d" % (lab, k)
            while new in seen:
                k += 1
                new = "%s.%d" % (lab, k)
            seen[lab] = k + 1
            seen[new] = 1
            lab = new
        else:
            seen[lab] = 1
        out.append(lab)
    return out


def _open(src):
    if isinstance(src, str):
        if re.match(r"(?i)(https?|ftp|s3|gs)://", src):
            raise NotImplementedError("read_csv from a URL isn't supported; download the file into the project first")
        f = open(src, "r", encoding="utf-8", newline="")
        return f.read, f.close
    try:
        read = src.read
    except AttributeError:
        raise _unsupported("filepath_or_buffer of type %s" % type(src).__name__) from None
    return read, None


def read_csv(filepath_or_buffer, *, sep=",", header="infer", names=None, index_col=None, usecols=None,
             na_values=None, keep_default_na=True, dtype=None, nrows=None, skiprows=None,
             quotechar='"', parse_dates=False, **kwargs):
    for k in kwargs:
        raise _unsupported(k + "=")
    if not isinstance(sep, str) or len(sep) != 1 or sep in ('"', "\n", "\r"):
        raise _unsupported("sep=%r (only a one-character separator)" % (sep,))
    if not isinstance(quotechar, str) or len(quotechar) != 1 or quotechar == sep:
        raise _unsupported("quotechar=%r" % (quotechar,))
    if parse_dates is not False:
        raise _unsupported("parse_dates=%r" % (parse_dates,))
    if header == "infer":
        header = None if names is not None else 0
    if header is not None and (not isinstance(header, int) or isinstance(header, bool) or header < 0):
        raise _unsupported("header=%r" % (header,))
    if names is not None:
        names = list(names)
        if len(set(names)) != len(names):
            raise ValueError("Duplicate names are not allowed.")
    if nrows is not None and (not isinstance(nrows, int) or nrows < 0):
        raise ValueError("'nrows' must be an integer >=0")
    if skiprows is None:
        skip = frozenset()
        skip_n = 0
    elif isinstance(skiprows, int) and not isinstance(skiprows, bool):
        skip, skip_n = frozenset(), skiprows
    elif isinstance(skiprows, (list, tuple, set, range)):
        skip, skip_n = frozenset(skiprows), 0
    else:
        raise _unsupported("skiprows=%r" % (skiprows,))
    na = set(_DEFAULT_NA) if keep_default_na else set()
    if na_values is not None:
        if isinstance(na_values, str):
            na.add(na_values)
        elif isinstance(na_values, (list, tuple, set)):
            na.update(str(v) for v in na_values)
        else:
            raise _unsupported("na_values of type %s" % type(na_values).__name__)
    if index_col is not None and index_col is not False and (isinstance(index_col, bool) or not isinstance(index_col, (int, str))):
        raise _unsupported("index_col=%r (only one column)" % (index_col,))
    if index_col is False:
        index_col = None
    if dtype is not None and not isinstance(dtype, dict):
        resolve_dtype(dtype)

    budget = _make_budget()
    read, close = _open(filepath_or_buffer)
    try:
        return _parse(read, sep, quotechar, header, names, index_col, usecols, na, dtype, nrows,
                      skip, skip_n, budget)
    finally:
        if close is not None:
            close()


def _parse(read, sep, quotechar, header, names, index_col, usecols, na, dtype, nrows, skip, skip_n, budget):
    reader = _Reader(read, sep, quotechar, budget)
    try:
        return _parse_rows(reader, header, names, index_col, usecols, na, dtype, nrows, skip, skip_n, budget)
    finally:
        reader.close()


class _Rows(object):
    """The rows that aren't skipped or blank, a batch at a time, with their
    line numbers; next_row() takes one."""

    def __init__(self, reader, skip, skip_n):
        self.reader = reader
        self.skip = skip
        self.skip_n = skip_n
        self.rows = []
        self.nums = []
        self.pos = 0

    def _filter(self, rows, nums):
        skip, skip_n = self.skip, self.skip_n
        if skip_n and nums[0] - 1 < skip_n:
            keep = [i for i, n in enumerate(nums) if n - 1 >= skip_n]
            rows, nums = [rows[i] for i in keep], [nums[i] for i in keep]
        if skip:
            keep = [i for i, n in enumerate(nums) if (n - 1) not in skip]
            rows, nums = [rows[i] for i in keep], [nums[i] for i in keep]
        if rows and min(map(len, rows)) == 1:
            keep = [i for i, r in enumerate(rows) if not _is_blank_row(r)]
            if len(keep) != len(rows):
                rows, nums = [rows[i] for i in keep], [nums[i] for i in keep]
        return rows, nums

    def batch(self):
        """The rest of the current batch, or the next one; None at the end."""
        if self.pos < len(self.rows):
            rows, nums = self.rows[self.pos:], self.nums[self.pos:]
            self.rows, self.nums, self.pos = [], [], 0
            return rows, nums
        while True:
            b = self.reader.batch()
            if b is None:
                return None
            rows, nums = self._filter(b[0], list(b[1]))
            if rows:
                return rows, nums

    def next_row(self):
        if self.pos >= len(self.rows):
            b = self.batch()
            if b is None:
                return None, None
            self.rows, self.nums, self.pos = b[0], b[1], 0
        r, n = self.rows[self.pos], self.nums[self.pos]
        self.pos += 1
        return r, n


def _parse_rows(reader, header, names, index_col, usecols, na, dtype, nrows, skip, skip_n, budget):
    src = _Rows(reader, skip, skip_n)

    # the header
    first = fline = None
    if header is not None:
        for _ in range(header):
            f, _l = src.next_row()
            if f is None:
                break
        hdr, hline = src.next_row()
        if hdr is None:
            raise EmptyDataError("No columns to parse from file")
        labels = list(names) if names is not None else _mangle(list(hdr))
    else:
        first, fline = src.next_row()
        if first is None:
            if names is None:
                raise EmptyDataError("No columns to parse from file")
            labels = list(names)
        else:
            labels = list(names) if names is not None else list(range(len(first)))
    width = len(labels)
    for lab in labels:
        budget.charge(1024 + (_string_charge(len(lab)) if isinstance(lab, str) else 0), "a column")

    # usecols: which positions to keep
    if usecols is None:
        keep = list(range(width))
    else:
        uc = list(usecols)
        if all(isinstance(u, int) and not isinstance(u, bool) for u in uc):
            if [u for u in uc if u >= width or u < 0]:
                raise _unsupported("usecols positions outside the columns")
            keep = sorted(set(uc))
        elif all(isinstance(u, str) for u in uc):
            missing = [u for u in uc if u not in labels]
            if missing:
                raise ValueError("Usecols do not match columns, columns expected but not found: %r" % (missing,))
            keep = sorted(labels.index(u) for u in set(uc))
        else:
            raise _unsupported("usecols mixing names and positions")
    kept_labels = [labels[j] for j in keep]

    def forced_for(j):
        if dtype is None:
            return None
        if isinstance(dtype, dict):
            lab = labels[j]
            if lab in dtype:
                return resolve_dtype(dtype[lab])
            return None
        return resolve_dtype(dtype)

    builders = [_Builder(budget, forced_for(j), j) for j in keep]
    count = 0
    all_cols = keep == list(range(width))

    def add_rows(rows, nums):
        lens = set(map(len, rows))
        if max(lens) > width:
            for i, r in enumerate(rows):
                if len(r) > width:
                    if count == 0 and i == 0 and len(r) == width + 1 and index_col is None:
                        raise _unsupported("an implicit index column (a first row with one more field than the header)")
                    raise ParserError("Error tokenizing data. C error: Expected %d fields in line %d, saw %d\n" % (width, nums[i], len(r)))
        if lens == {width}:
            cols = list(zip(*rows)) if width else []
            for k, j in enumerate(keep):
                builders[k].add_many(cols[j], na)
            return
        # (short rows: the missing fields are missing values)
        for k, j in enumerate(keep):
            b = builders[k]
            for r in rows:
                if j < len(r):
                    t = r[j]
                    b.add(t, t in na)
                else:
                    b.add("", True)

    if first is not None:
        if nrows is None or nrows > 0:
            add_rows([first], [fline])
            count = 1
    while nrows is None or count < nrows:
        b = src.batch()
        if b is None:
            break
        rows, nums = b
        if nrows is not None and count + len(rows) > nrows:
            rows, nums = rows[:nrows - count], nums[:nrows - count]
        add_rows(rows, nums)
        count += len(rows)

    cols = [b.finish() for b in builders]
    builders = None
    if count == 0:
        cols = [Column("object", []) for _ in keep]

    index = default_index(count)
    if index_col is not None:
        if isinstance(index_col, int):
            if not 0 <= index_col < len(kept_labels):
                raise IndexError("list index out of range")
            pos = index_col
        else:
            if index_col not in kept_labels:
                raise ValueError("Index %s invalid" % index_col)
            pos = kept_labels.index(index_col)
        index = Index.__new__(Index)
        Index.__init__(index, None, name=kept_labels[pos])
        index._pd_col = cols[pos]
        index._pd_budget = budget
        del cols[pos]
        del kept_labels[pos]
    from ._pd_frame import DataFrame
    if header is None and names is None and all_cols and index_col is None:
        columns = RangeIndex(0, width)
    else:
        columns = Index(kept_labels) if kept_labels else RangeIndex(0, 0)
    return DataFrame._pd_new(cols, columns, index)
