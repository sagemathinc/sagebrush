"""Comments on a LaTeX document: the file format, its merge and the anchors, in Python, for the
latex_comments_* MCP tools (sagebrush/latex_comments_tools.py).  A port of web/latex/comments-core.mjs,
kept in step with it by the shared conformance vectors (web/latex/comments-vectors.json, made from the JS
core and checked by engine/py/test_latex_comments.py); the format is web/latex/COMMENTS-FORMAT.md.

The comments of paper.tex live beside it in paper.tex.comments.json.  Offsets are JavaScript string
indices: UTF-16 code units into the .tex text.  Internally a text is held as a str of its UTF-16 code
units (one character per unit; a character outside the BMP as its two surrogates), so that indexing,
slicing and searching count exactly as the page and the command-line tool do; strings stored in the
file are ordinary str again.  The JSON written is the same, byte for byte, as JSON.stringify's.
"""

import decimal
import hashlib
import json
import random
import re
import secrets
import struct
import time
from datetime import datetime, timezone

FORMAT = "sagebrush-latex-comments"
VERSION = 1
#: a range searched in a copy (a short one) (the page's step bound; here the same, so the work counts agree)
WINDOW = 1 << 17
#: the one admission and output contract (r3 §7.4, r4.1 §8, and PR 316's source limit: 2 Mi UTF-16 units)
LIMITS = {
    "sidecarBytes": 2 << 20, "newThreadBytes": 1835008, "threadBytes": 256 << 10, "sourceUnits": 2 << 20,
    "liveThreads": 2000, "threads": 4000, "messages": 200, "text": 8000, "author": 100, "id": 64,
    "quoteFull": 600, "quoteHead": 300, "context": 32, "shown": 300, "candidates": 64, "workBudget": 64 << 20,
    "listThreads": 200, "listBytes": 1 << 20, "summaryUnits": 500, "contextLines": 3, "contextLineUnits": 200,
    "changedWindow": 2000, "attempts": 5, "backoffMs": [50, 100, 200, 400], "deadlineMs": 10000,
}


class CommentsError(Exception):
    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def fail(code, msg, detail=None):
    raise CommentsError(code, msg, detail)


# ---- UTF-16 units, JSON and UTF-8 as JavaScript has them
_ASTRAL = re.compile("[\U00010000-\U0010FFFF]")
_LONE = re.compile("[\ud800-\udfff]")


def units(s):
    """A str as its UTF-16 code units, one character each."""
    if not _ASTRAL.search(s):
        return s
    b = s.encode("utf-16-le", "surrogatepass")
    return "".join(map(chr, struct.unpack("<%dH" % (len(b) // 2), b)))


def text_of(u):
    """Code units back to an ordinary str (pairs joined; a lone surrogate stays one)."""
    return u.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def utf8(s):
    """A str's UTF-8 bytes as TextEncoder makes them (a lone surrogate becomes U+FFFD)."""
    return _LONE.sub("�", s).encode("utf-8")


def _js_str(s):
    return _LONE.sub(lambda m: "\\u%04x" % ord(m.group()), json.dumps(s, ensure_ascii=False))


def js_num(x):
    """A number as JavaScript writes it (Number::toString, as JSON.stringify uses it): the shortest digits that
    read back to the same double, plain from 1e-6 up to 1e21 and in exponent form outside; NaN and infinities
    as null (JSON.stringify's)."""
    if isinstance(x, int) and -(1 << 53) < x < 1 << 53:
        return str(x)
    f = float(x)
    if f != f or f in (float("inf"), float("-inf")):
        return "null"
    if f == 0:
        return "0"
    sign, digits, exp = decimal.Decimal(repr(f)).as_tuple()
    ds = "".join(map(str, digits))
    stripped = ds.rstrip("0")
    exp += len(ds) - len(stripped)
    ds, k = stripped, len(stripped)
    n = exp + k  # (the value is 0.ds x 10^n)
    if k <= n <= 21:
        s = ds + "0" * (n - k)
    elif 0 < n <= 21:
        s = ds[:n] + "." + ds[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * -n + ds
    else:
        e = n - 1
        s = ds[0] + ("." + ds[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return ("-" if sign else "") + s


_INDEX = re.compile(r"(0|[1-9][0-9]*)\Z")


def js_keys(d):
    """A dict's keys in JavaScript's property order: array indices (canonical integers below 2^32 - 1, so at most
    10 digits: checked first, before any int()) ascending, then the other keys in insertion order."""
    idx = [k for k in d if len(k) <= 10 and _INDEX.match(k) and int(k) < 4294967295]
    if not idx:
        return list(d)
    seen = set(idx)
    return sorted(idx, key=int) + [k for k in d if k not in seen]


def js_json(v, indent=None):
    """JSON.stringify(v) (indent: JSON.stringify(v, null, indent)): the same text, numbers included."""
    def out(x, depth):
        if x is None:
            return "null"
        if x is True:
            return "true"
        if x is False:
            return "false"
        if isinstance(x, str):
            return _js_str(x)
        if isinstance(x, (int, float)):
            return js_num(x)
        nl, end = ("\n" + " " * (indent * (depth + 1)), "\n" + " " * (indent * depth)) if indent else ("", "")
        if isinstance(x, (list, tuple)):
            return "[" + ",".join(nl + out(e, depth + 1) for e in x) + end + "]" if x else "[]"
        if isinstance(x, dict):
            sep = ": " if indent else ":"
            return "{" + ",".join(nl + _js_str(k) + sep + out(x[k], depth + 1) for k in js_keys(x)) + end + "}" if x else "{}"
        raise TypeError("not JSON: %r" % type(x))
    return out(v, 0)


def _js_number(s):
    """A JSON number literal as JSON.parse reads it: one double, an integral one as the int of that double (so it
    indexes and compares as an integer; written back, js_num writes the double)."""
    f = float(s)
    return int(f) if f.is_integer() else f


def _no_constant(name):
    raise ValueError("not JSON: " + name)


def js_parse(text):
    """JSON.parse(text): strict JSON (no NaN or Infinity), every number a double as JavaScript has it."""
    return json.loads(text, parse_float=_js_number, parse_int=_js_number, parse_constant=_no_constant)


def u16key(s):
    """A str's order as JavaScript compares strings (by UTF-16 code units)."""
    return s.encode("utf-16-be", "surrogatepass")


def jslen(s):
    """A str's length as JavaScript counts it (UTF-16 units)."""
    return len(units(s))


def sha256(s):
    """The SHA-256 of a str's UTF-8 bytes (a units str is joined back first)."""
    return hashlib.sha256(utf8(text_of(s))).hexdigest()


# ---- ids, times, registers: {value, rev, time, by, op}, merged by the greatest (rev, time, by, op), then the
# value's JSON
_ID = "abcdefghijklmnopqrstuvwxyz0123456789"


def new_id(prefix):
    return prefix + "_" + "".join(secrets.choice(_ID) for _ in range(16))


def now():
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def reg(value, by, t=None, rev=0):
    return {"value": value, "rev": rev, "time": t or now(), "by": by, "op": new_id("o")}


def _later(a, b):
    if a["rev"] != b["rev"]:
        return a["rev"] > b["rev"]
    for k in ("time", "by", "op"):
        if a[k] != b[k]:
            return u16key(a[k]) > u16key(b[k])
    return u16key(js_json(a["value"])) > u16key(js_json(b["value"]))


def _pick(a, b):
    if not a:
        return b
    if not b:
        return a
    return b if _later(b, a) else a


def bump(r, value, by, t=None):
    """A register's next write: one rev above the one read."""
    return {"value": value, "rev": (r["rev"] if r else -1) + 1, "time": t or now(), "by": by, "op": new_id("o")}


def empty_doc(file=None):
    file = file or {}
    return {"format": FORMAT, "version": VERSION, "file": {"fid": file.get("fid"), "path": file.get("path")}, "threads": []}


# ---- admission: checked before anything is written; a refusal names the limit and the size
def _is_int(v):
    """Number.isInteger(v): an int, or a float with no fraction (past 2^53 a number is kept as a float)"""
    return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_bool(r):
    return isinstance(r["value"], bool)


def _str(v, mx, what):
    if not isinstance(v, str):
        fail("invalid", what + " must be a string")
    n = jslen(v)
    if n > mx:
        fail("limit", what + " is over " + str(mx), {"limit": what, "max": mx, "size": n})
    return v


def _is_reg(r):
    return (isinstance(r, dict) and _is_int(r.get("rev")) and r["rev"] >= 0 and isinstance(r.get("time"), str)
            and isinstance(r.get("by"), str) and isinstance(r.get("op"), str))


def _check_anchor(a):
    if not isinstance(a, dict):
        fail("invalid", "anchor")
    for k in ("start", "end"):
        if not _is_int(a.get(k)) or a[k] < 0:
            fail("invalid", "anchor." + k)
    if a["end"] < a["start"]:
        fail("invalid", "anchor.end < start")
    _str(a.get("quote"), LIMITS["quoteFull"], "anchor.quote")
    _str(a.get("prefix"), LIMITS["context"], "anchor.prefix")
    _str(a.get("suffix"), LIMITS["context"], "anchor.suffix")
    if "tail" in a:
        _str(a["tail"], LIMITS["quoteHead"], "anchor.tail")
        if not _is_int(a.get("length")) or not isinstance(a.get("sha"), str):
            fail("invalid", "a long anchor needs length and sha")
    if "shown" in a:
        _str(a["shown"], LIMITS["shown"], "anchor.shown")


def _live(t):
    return not t["deleted"]["value"]


def validate(doc):
    """The document checked against the format and every limit (CommentsError: invalid | limit | version), in the
    JS core's order."""
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        fail("invalid", "not a " + FORMAT + " document")
    v = doc.get("version")
    if not (_is_number(v) and v == VERSION):
        fail("version", "version %s is not supported (this reads %d)" % (js_json(v) if v is not None else "undefined", VERSION))
    ts = doc.get("threads")
    if not isinstance(ts, list):
        fail("invalid", "threads")
    if len(ts) > LIMITS["threads"]:
        fail("limit", "threads", {"limit": "threads", "max": LIMITS["threads"], "size": len(ts)})
    ids = set()
    for t in ts:
        if not isinstance(t, (dict, list)):
            fail("invalid", "thread")
        t = t if isinstance(t, dict) else {}
        _str(t.get("id"), LIMITS["id"], "thread.id")
        if t["id"] in ids:
            fail("invalid", "duplicate thread id " + t["id"])
        ids.add(t["id"])
        _str(t.get("created"), LIMITS["id"], "thread.created")
        if not (_is_reg(t.get("anchor")) and _is_reg(t.get("resolved")) and _is_reg(t.get("deleted"))
                and _is_bool(t["resolved"]) and _is_bool(t["deleted"])):
            fail("invalid", "thread " + t["id"] + " registers")
        _check_anchor(t["anchor"]["value"])
        ms = t.get("messages")
        if not isinstance(ms, list) or len(ms) > LIMITS["messages"]:
            fail("limit", "messages", {"limit": "messages", "max": LIMITS["messages"], "size": len(ms) if isinstance(ms, list) else None})
        for m in ms:
            if not isinstance(m, (dict, list)):
                fail("invalid", "message")
            m = m if isinstance(m, dict) else {}
            _str(m.get("id"), LIMITS["id"], "message.id")
            _str(m.get("author"), LIMITS["author"], "author")
            _str(m.get("time"), LIMITS["id"], "message.time")
            if not (_is_reg(m.get("text")) and _is_reg(m.get("deleted")) and _is_bool(m["deleted"])):
                fail("invalid", "message registers")
            _str(m["text"]["value"], LIMITS["text"], "text")
        tb = len(utf8(js_json(t)))
        if tb > LIMITS["threadBytes"]:
            fail("limit", "thread " + t["id"] + " is over 256 KiB", {"limit": "threadBytes", "max": LIMITS["threadBytes"], "size": tb})
    if sum(1 for t in ts if not t["deleted"]["value"]) > LIMITS["liveThreads"]:
        fail("limit", "live threads", {"limit": "liveThreads", "max": LIMITS["liveThreads"]})
    return doc


def parse(text, file=None):
    """The file's text parsed and validated (no file, None: an empty document)."""
    if text is None:
        return empty_doc(file)
    n = jslen(text)
    if n <= LIMITS["sidecarBytes"]:
        n = len(utf8(text))
    if n > LIMITS["sidecarBytes"]:
        fail("limit", "the comments file is over 2 MiB", {"limit": "sidecarBytes", "max": LIMITS["sidecarBytes"], "size": n})
    try:
        doc = js_parse(text)
    except ValueError:
        fail("invalid", "the comments file isn't JSON")
    return validate(doc)


def serialize(doc):
    """The document as the file's text (checked first: a document over the limits is never written)."""
    validate(doc)
    s = js_json(doc, 1) + "\n"
    if len(utf8(s)) > LIMITS["sidecarBytes"]:
        fail("limit", "the comments file would be over 2 MiB", {"limit": "sidecarBytes", "max": LIMITS["sidecarBytes"]})
    return s


# ---- anchors
def source_fits(u):
    """Comments are for a .tex of at most 2 Mi UTF-16 units: a longer one is refused, limit (u: units)."""
    if len(u) > LIMITS["sourceUnits"]:
        fail("limit", "comments are available for documents up to 2 MiB (this one is %.1f MiB)" % (len(u) / (1 << 20)),
             {"limit": "sourceUnits", "max": LIMITS["sourceUnits"], "size": len(u)})


def make_anchor(text, start, end, shown=None, text_sha=None):
    """An anchor for [start, end) of text (offsets in UTF-16 units): the whole span (up to 600 units), or its
    head, tail, length and sha."""
    u = units(text)
    source_fits(u)
    if not (_is_int(start) and _is_int(end) and 0 <= start <= end <= len(u)):
        fail("invalid", "a range inside the text")
    span = u[start:end]
    a = {"start": start, "end": end, "textSha": text_sha or sha256(u),
         "prefix": text_of(u[max(0, start - LIMITS["context"]):start]), "suffix": text_of(u[end:end + LIMITS["context"]])}
    if len(span) <= LIMITS["quoteFull"]:
        a["quote"] = text_of(span)
    else:
        a["quote"] = text_of(span[:LIMITS["quoteHead"]])
        a["tail"] = text_of(span[-LIMITS["quoteHead"]:])
        a["length"] = len(span)
        a["sha"] = sha256(span)
    sh = units((shown or "").strip())[:LIMITS["shown"]]
    if sh and sh != span:
        a["shown"] = text_of(sh)
    return a


class LineIndex:
    """Line starts of a units text; line and column 1-based, columns in UTF-16 units."""

    def __init__(self, u):
        self.u = u
        starts = [0]
        i = u.find("\n")
        while i >= 0:
            starts.append(i + 1)
            i = u.find("\n", i + 1)
        self.starts = starts
        self.lines = len(starts)

    def at(self, off):
        lo, hi = 0, len(self.starts) - 1
        while lo < hi:
            m = (lo + hi + 1) >> 1
            if self.starts[m] <= off:
                lo = m
            else:
                hi = m - 1
        return {"line": lo + 1, "col": off - self.starts[lo] + 1}

    def off(self, line, col):
        if not (1 <= line <= len(self.starts)):
            return -1
        return min(self.starts[line - 1] + col - 1, self.starts[line] - 1 if line < len(self.starts) else len(self.u))


def line_index(text):
    return LineIndex(units(text))


_OUT = object()
_UNRESOLVED = {"status": "unresolved", "reason": "budget"}


class Resolver:
    """Anchors re-found in one text, with one work budget for all of them, never exceeded (each step charged
    before it runs; an anchor whose next step doesn't fit is unresolved): the same statuses, offsets and work
    as comments-core.mjs's resolver."""

    def __init__(self, text, budget=None, text_sha=None):
        u = self.u = units(text)
        source_fits(u)
        self.budget = LIMITS["workBudget"] if budget is None else budget
        # (the first pass over the text, its hash and line index, admitted against the budget like every step)
        self.starved = 2 * len(u) > self.budget
        self.work = 0 if self.starved else 2 * len(u)
        self.text_sha = None if self.starved else (text_sha or sha256(u))
        self._lines = None

    @property
    def lines(self):
        if self._lines is None:
            self._lines = LineIndex(self.u)
        return self._lines

    def _can(self, n):
        return self.work + n <= self.budget

    def _find(self, s, frm=0, to=None):
        u, cand = self.u, LIMITS["candidates"]
        out = []
        if not s:
            return out
        end = min(len(u) if to is None else to, len(u))
        if end - frm <= WINDOW:
            # (its length checked and charged before the copy: no source work goes uncharged)
            pe = min(len(u), end + len(s) - 1)
            n = max(0, pe - frm)
            if not self._can(n):
                return _OUT
            self.work += n
            piece = u[frm:pe]
            i = piece.find(s)
            while i >= 0 and frm + i < end:
                out.append(frm + i)
                if len(out) > cand:
                    break
                i = piece.find(s, i + 1)
            return out
        at = frm
        while at < end and len(out) <= cand:
            rest = len(u) - at
            if not self._can(rest):
                return _OUT
            i = u.find(s, at)
            self.work += rest if i < 0 else i - at + len(s)
            if i < 0 or i >= end:
                break
            out.append(i)
            at = i + 1
        return out

    def _sha(self, a, b):
        h = hashlib.sha256()
        i = a
        while i < b:
            j = i + WINDOW
            if j < len(self.u) and (ord(self.u[j - 1]) & 0xFC00) == 0xD800:
                j += 1
            j = min(b, j)
            if not self._can(j - i):
                return _OUT
            self.work += j - i
            h.update(utf8(text_of(self.u[i:j])))
            i = j
        return h.hexdigest()

    def _span_at(self, a, i, quote_len):
        if "tail" not in a:
            return {"start": i, "end": i + quote_len}
        e = i + a["length"]
        tail = units(a["tail"])
        if not self._can(len(tail)):
            return _OUT
        self.work += len(tail)
        if not (e <= len(self.u) and self.u[e - len(tail):e] == tail):
            return None
        h = self._sha(i, e)
        if h is _OUT:
            return _OUT
        return {"start": i, "end": e} if h == a["sha"] else None

    def _ctx_exact(self, pre, suf, s, e):
        self.work += len(pre) + len(suf)
        return self.u[max(0, s - len(pre)):s] == pre and self.u[e:e + len(suf)] == suf

    def resolve(self, a):
        if self.starved:
            return dict(_UNRESOLVED)
        u = self.u
        if a.get("textSha") == self.text_sha and a["end"] <= len(u):
            return {"status": "exact", "start": a["start"], "end": a["end"]}
        quote, pre, suf = units(a.get("quote", "")), units(a.get("prefix", "")), units(a.get("suffix", ""))
        cand = LIMITS["candidates"]
        if quote:
            occ = self._find(quote)
            if occ is _OUT:
                return dict(_UNRESOLVED)
            if len(occ) > cand:
                return {"status": "ambiguous", "reason": "too many", "candidates": []}
            spans = []
            for i in occ:
                sp = self._span_at(a, i, len(quote))
                if sp is _OUT:
                    return dict(_UNRESOLVED)
                if sp:
                    spans.append(sp)
            if len(spans) == 1:
                return dict(status="moved", **spans[0])
            if len(spans) > 1:
                if not self._can(len(spans) * (len(pre) + len(suf))):
                    return dict(_UNRESOLVED)
                fit = [sp for sp in spans if self._ctx_exact(pre, suf, sp["start"], sp["end"])]
                if len(fit) == 1:
                    return dict(status="moved", **fit[0])
                return {"status": "ambiguous", "candidates": [{"start": x["start"], "end": x["end"]} for x in (fit or spans)]}
        starts = []
        if pre:
            f = self._find(pre)
            if f is _OUT:
                return dict(_UNRESOLVED)
            starts = [i + len(pre) for i in f]
        elif a["start"] == 0:
            starts = [0]
        if len(starts) > cand:
            return {"status": "ambiguous", "reason": "too many", "candidates": []}
        pairs = []
        for s in starts:
            ends = []
            if suf:
                f = self._find(suf, s, s + LIMITS["changedWindow"] + 1)
                if f is _OUT:
                    return dict(_UNRESOLVED)
                ends = f
            elif len(u) - s <= LIMITS["changedWindow"]:
                ends = [len(u)]
            if not self._can(len(ends)):
                return dict(_UNRESOLVED)
            self.work += len(ends)
            for e in ends:
                if e - s <= LIMITS["changedWindow"]:
                    pairs.append({"start": s, "end": e})
                if len(pairs) > cand:
                    return {"status": "ambiguous", "reason": "too many", "candidates": []}
        if not self._can(sum(p["end"] - p["start"] for p in pairs)):
            return dict(_UNRESOLVED)
        kept = []
        for p in pairs:
            self.work += p["end"] - p["start"]
            if text_of(u[p["start"]:p["end"]]).strip(" \t\n\r\f\v                 　﻿") != "":
                kept.append(p)
        if len(kept) == 1:
            return dict(status="changed", **kept[0])
        if len(kept) > 1:
            return {"status": "ambiguous", "candidates": kept}
        return {"status": "orphaned", "reason": "removed"} if pairs else {"status": "orphaned"}

    def context(self, s, e):
        if self.starved:
            return ""
        L = self.lines
        l0, l1 = L.at(s)["line"], L.at(e)["line"]
        frm, to = max(1, l0 - LIMITS["contextLines"]), min(L.lines, l1 + LIMITS["contextLines"])
        out = []
        for line in range(frm, to + 1):
            a = L.starts[line - 1]
            b = L.starts[line] - 1 if line < L.lines else len(self.u)
            pe = min(b, a + LIMITS["contextLineUnits"])
            if not self._can(pe - a):
                break
            self.work += pe - a
            out.append(text_of(self.u[a:pe]) + ("…" if b - a > LIMITS["contextLineUnits"] else ""))
        return "\n".join(out)


def resolver(text, budget=None, text_sha=None):
    return Resolver(text, budget, text_sha)


# ---- the operations: each returns a new document (the input never changed) and checks admission first
def _clone(d):
    return js_parse(js_json(d))


def _thread_of(doc, tid):
    for t in doc["threads"]:
        if t["id"] == tid:
            if t["deleted"]["value"]:
                break
            return t
    fail("gone", "no thread %s (deleted?)" % tid)


def _message(author, text, t):
    return {"id": new_id("m"), "author": _str(author, LIMITS["author"], "author"), "time": t,
            "text": reg(_str(text, LIMITS["text"], "text"), author, t), "deleted": reg(False, author, t)}


def _file_bytes(doc):
    return len(utf8(js_json(doc, 1))) + 1


def _thread_fits(t):
    b = len(utf8(js_json(t)))
    if b > LIMITS["threadBytes"]:
        fail("full", "this thread is full: start a new one", {"limit": "threadBytes", "max": LIMITS["threadBytes"], "size": b})


def add_thread(doc, anchor, text, author, t=None):
    """A new thread on anchor with a first message: (doc, id)."""
    t = t or now()
    _check_anchor(anchor)
    if sum(1 for x in doc["threads"] if _live(x)) >= LIMITS["liveThreads"]:
        fail("full", "too many comments: resolve or delete some", {"limit": "liveThreads", "max": LIMITS["liveThreads"]})
    if len(doc["threads"]) >= LIMITS["threads"]:
        fail("full", "this document has had too many comments; rename its comments file to start a new one", {"limit": "threads", "max": LIMITS["threads"]})
    if _file_bytes(doc) > LIMITS["newThreadBytes"]:
        fail("full", "the comments file is nearly full (1.75 MiB): resolve or delete some, or start a new comments file", {"limit": "newThreadBytes", "max": LIMITS["newThreadBytes"]})
    d, tid = _clone(doc), new_id("t")
    th = {"id": tid, "created": t, "anchor": reg(anchor, author, t), "resolved": reg(False, author, t),
          "deleted": reg(False, author, t), "messages": [_message(author, text, t)]}
    _thread_fits(th)
    d["threads"].append(th)
    return d, tid


def reply(doc, tid, text, author, t=None):
    t = t or now()
    d = _clone(doc)
    th = _thread_of(d, tid)
    if len(th["messages"]) >= LIMITS["messages"]:
        fail("full", "this thread is full: start a new one", {"limit": "messages", "max": LIMITS["messages"]})
    th["messages"].append(_message(author, text, t))
    _thread_fits(th)
    return d, tid


def set_resolved(doc, tid, value, author, t=None):
    d = _clone(doc)
    th = _thread_of(d, tid)
    th["resolved"] = bump(th["resolved"], bool(value), author, t)
    return d, tid


def delete_thread(doc, tid, author, t=None):
    t = t or now()
    d = _clone(doc)
    th = _thread_of(d, tid)
    th["deleted"] = bump(th["deleted"], True, author, t)
    for m in th["messages"]:
        m["text"] = bump(m["text"], "", author, t)
    th["anchor"] = bump(th["anchor"], {"start": 0, "end": 0, "quote": "", "prefix": "", "suffix": ""}, author, t)
    return d, tid


def reattach(doc, tid, anchor, author, t=None):
    _check_anchor(anchor)
    d = _clone(doc)
    th = _thread_of(d, tid)
    th["anchor"] = bump(th["anchor"], anchor, author, t)
    _thread_fits(th)
    return d, tid


# ---- merge: records by id (their union), registers by the greatest (rev, time, by, op), then the value
def merge(a, b):
    out = _clone(a)
    by_id = {t["id"]: t for t in out["threads"]}
    for t in b["threads"]:
        mine = by_id.get(t["id"])
        if mine is None:
            c = _clone(t)
            out["threads"].append(c)
            by_id[c["id"]] = c
            continue
        if u16key(t["created"]) < u16key(mine["created"]):
            mine["created"] = t["created"]
        for k in ("anchor", "resolved", "deleted"):
            mine[k] = _clone(_pick(mine[k], t[k]))
        ms = {m["id"]: m for m in mine["messages"]}
        for m in t["messages"]:
            x = ms.get(m["id"])
            if x is None:
                mine["messages"].append(_clone(m))
                continue
            x["text"] = _clone(_pick(x["text"], m["text"]))
            x["deleted"] = _clone(_pick(x["deleted"], m["deleted"]))
        mine["messages"].sort(key=lambda m: (u16key(m["time"]), u16key(m["id"])))
    out["threads"].sort(key=lambda t: (u16key(t["created"]), u16key(t["id"])))
    return out


# ---- writing with retries: io.read() -> (content or None, base); io.write(content, base) raising a
# CommentsError (or any exception with .code) "conflict" on a compare-and-swap miss.  Conflicts only are
# retried, 5 attempts in all, each re-reading, re-validating and re-applying op (doc -> (doc, id)), within one
# monotonic deadline; out of attempts or time: busy, the draft kept.  A failure that may have come after the
# write was done is reconciled against the file.
def update(io, op, file=None, draft=None, deadline_ms=None, sleep=time.sleep, clock=time.monotonic):
    """io: read(timeout) -> (content or None, base); write(content, base, timeout), raising an error with code
    "conflict" on a compare-and-swap miss. One monotonic deadline (10 s) covers every step, as in the JS core: each
    read and write is given the time left (the JS core's abort signal), so none can outlast it by more than its own
    overrun; a failure after it is "busy"."""
    end = clock() + (deadline_ms or LIMITS["deadlineMs"]) / 1000.0

    def busy(attempts, why):
        fail("busy", why + "; nothing was saved", {"draft": draft, "attempts": attempts})

    def left(attempts):
        t = end - clock()
        if t <= 0:
            busy(attempts, "out of time")
        return t

    attempt = 1
    while True:
        content, base = io.read(timeout=left(attempt - 1))
        doc, tid = op(parse(content, file))
        text = serialize(doc)
        try:
            io.write(text, base, timeout=left(attempt - 1))
            return {"doc": doc, "id": tid, "attempts": attempt}
        except Exception as e:
            if getattr(e, "code", None) == "busy":
                raise
            if getattr(e, "code", None) != "conflict":
                # (a failure but a conflict may have come after the write was done: the file is read once more, on
                #  its own short bound, and if it already holds everything this write had, it was saved)
                landed = _reconcile(io, doc, file)
                if landed is not None:
                    return {"doc": landed, "id": tid, "attempts": attempt, "reconciled": True}
                if clock() >= end:
                    busy(attempt, "out of time")
                raise
            if attempt >= LIMITS["attempts"]:
                busy(attempt, "the comments file kept changing (%d attempts)" % attempt)
            ms = round(LIMITS["backoffMs"][attempt - 1] * (0.75 + random.random() * 0.5))
            if clock() + ms / 1000.0 >= end:
                busy(attempt, "out of time")
            sleep(ms / 1000.0)
            attempt += 1


RECONCILE_S = 2.0  # (the JS core's reconcile bound)


def _reconcile(io, mine, file):
    try:
        content, _ = io.read(timeout=RECONCILE_S)
        cur = parse(content, file)
        return cur if js_json(merge(cur, mine)) == js_json(merge(cur, cur)) else None
    except Exception:
        return None


# ---- reading, for people and agents: list gives thread summaries, show one whole thread
def _cut(s, n):
    u = units(s)
    return text_of(u[:n]) + "…" if len(u) > n else s


def _msg_view(m):
    return {"id": m["id"], "author": m["author"], "agent": m["author"].startswith("agent:"), "time": m["time"], "text": m["text"]["value"]}


def _placed(R, t):
    a = t["anchor"]["value"]
    r = R.resolve(a)

    def rng(s, e):
        return {"start": R.lines.at(s), "end": R.lines.at(e)}

    out = {"status": r["status"]}
    if r.get("reason"):
        out["reason"] = r["reason"]
    if "start" in r:
        out["offsets"] = {"start": r["start"], "end": r["end"]}
        out["range"] = rng(r["start"], r["end"])
        out["context"] = R.context(r["start"], r["end"])
    if "candidates" in r:
        out["candidates"] = [{"offsets": c, "range": rng(c["start"], c["end"])} for c in r["candidates"]]
    return out


def _full_quote(a):
    return a["quote"] if "tail" not in a else a["quote"] + "…" + a["tail"]


def list_threads(doc, text, all=False, cursor=None, budget=None):
    """Summaries of the live threads (open; all: resolved too), in id order, at most 200 and 1 MiB a page; the
    cursor names the files' snapshot, stale if either changed."""
    snapshot = sha256(js_json(doc)) + ":" + sha256(units(text))
    if cursor and cursor.get("snapshot") != snapshot:
        fail("stale", "the comments or the file changed: list again from the start")
    R = resolver(text, budget)
    ts = sorted([t for t in doc["threads"] if _live(t) and (all or not t["resolved"]["value"])], key=lambda t: u16key(t["id"]))
    if cursor:
        ts = [t for t in ts if u16key(t["id"]) > u16key(cursor["after"])]
    out, nbytes, i = [], 0, 0
    while i < len(ts) and len(out) < LIMITS["listThreads"]:
        t = ts[i]
        ms = [m for m in t["messages"] if not m["deleted"]["value"]]
        a = t["anchor"]["value"]
        v = {"id": t["id"], "resolved": bool(t["resolved"]["value"])}
        v.update(_placed(R, t))
        v["quote"] = _cut(_full_quote(a), LIMITS["quoteHead"])
        v["messages"] = len(ms)
        authors = []
        for m in ms:
            if m["author"] not in authors:
                authors.append(m["author"])
        v["authors"] = authors
        v["first"] = dict(_msg_view(ms[0]), text=_cut(ms[0]["text"]["value"], LIMITS["summaryUnits"])) if ms else None
        v["last"] = dict(_msg_view(ms[-1]), text=_cut(ms[-1]["text"]["value"], LIMITS["summaryUnits"])) if len(ms) > 1 else None
        b = len(utf8(js_json(v)))
        if nbytes + b > LIMITS["listBytes"] and out:
            break
        nbytes += b
        out.append(v)
        i += 1
    more = i < len(ts)
    return {"threads": out, "more": more, "cursor": {"snapshot": snapshot, "after": out[-1]["id"]} if more else None, "work": R.work}


def show(doc, text, tid, budget=None):
    """One whole thread."""
    t = _thread_of(doc, tid)
    a = t["anchor"]["value"]
    R = resolver(text, budget)
    v = {"id": t["id"], "resolved": bool(t["resolved"]["value"])}
    v.update(_placed(R, t))
    v["quote"] = _full_quote(a)
    v["messages"] = [_msg_view(m) for m in t["messages"] if not m["deleted"]["value"]]
    return v


def locate_span(text, quote=None, occurrence=None, range=None):
    """A span named by a quote (exactly one occurrence, or the n-th, 1-based) or by a line/column range."""
    u = units(text)
    if range:
        L = LineIndex(u)
        s, e = L.off(range["start"]["line"], range["start"]["col"]), L.off(range["end"]["line"], range["end"]["col"])
        if s < 0 or e < s:
            fail("invalid", "a range inside the text")
        return {"start": s, "end": e}
    _str(quote if quote is not None else "", LIMITS["text"], "quote")
    if not quote:
        fail("invalid", "a quote or a range")
    q = units(quote)
    occ = []
    i = u.find(q)
    while i >= 0 and len(occ) <= LIMITS["candidates"]:
        occ.append(i)
        i = u.find(q, i + 1)
    if not occ:
        fail("missing", "the quote isn't in the file")
    if occurrence is not None:
        if not (_is_int(occurrence) and 1 <= occurrence <= len(occ)):
            fail("invalid", "there are %d occurrences" % len(occ))
        i = occ[occurrence - 1]
        return {"start": i, "end": i + len(q)}
    if len(occ) > 1:
        L = LineIndex(u)
        fail("ambiguous", "the quote occurs %d times: give --occurrence" % len(occ),
             {"candidates": [{"occurrence": k + 1, "range": {"start": L.at(i), "end": L.at(i + len(q))}} for k, i in enumerate(occ)]})
    return {"start": occ[0], "end": occ[0] + len(q)}
