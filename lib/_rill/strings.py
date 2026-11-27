"""Rill's string functions (design/rill.md A3): paste, paste0, nchar, toupper,
tolower, substr, sprintf, format and formatC, as R 4.5.3 behaves
(rill-tests/str/).

Each one sizes its result before building it and reserves it (mem.reserve):
the result's elements, and the characters of its strings.  What isn't
implemented yet is refused in words (NotSupported), never approximated.

Names: nchar, toupper, tolower, substr, format and formatC keep x's names;
paste and sprintf drop them (R 4.5.3).
"""

import math
import re

from . import fmt, mem
from .eval import NotSupported, RError
from .values import MISSING, NULL, RVector


def _as_chars(v, what):
    """v's elements as as.character() gives them (None for NA): a list of str or None."""
    from .base import coerce
    if v is NULL:
        return []
    if not isinstance(v, RVector):
        raise NotSupported("%s of this kind of value" % what)
    if v.type == "character":
        return v.data
    return coerce(v, "character")


def _names(v):
    return v.attrs.get("names") if isinstance(v, RVector) and v.attrs else None


def _keep_names(t, data, x):
    nm = _names(x)
    return RVector(t, data, {"names": nm} if nm is not None else None)


def _arg(args, formal, default=MISSING):
    for name, v in args:
        if name == formal:
            return v
    return default


def _string1(v, what, call):
    """A one-string argument (sep =, collapse =)."""
    if isinstance(v, RVector) and v.type == "character" and len(v.data) == 1 and v.data[0] is not None:
        return v.data[0]
    raise NotSupported("%s other than one string" % what)


def _int1(v, what):
    if isinstance(v, RVector) and v.type in ("integer", "double") and len(v.data) == 1 and v.data[0] is not None:
        x = v.data[0]
        if x == x and abs(x) != math.inf:
            return int(x)
    raise NotSupported("%s other than one number" % what)


def _chars_bytes(strings):
    """The characters of the result's strings, one byte each at least (mem.reserve's extra_bytes)."""
    return sum(len(s) for s in strings if s is not None)


# ---------------------------------------------------------------- paste

def _paste(sess, call, args, sep):
    collapse = None
    parts = []
    for name, v in args:
        if name == "sep":
            continue
        if name == "collapse":
            if v is not NULL:
                collapse = _string1(v, "paste(collapse =)", call)
            continue
        if name == "recycle0":
            if not (isinstance(v, RVector) and v.type == "logical" and v.data == [False]):
                raise NotSupported("paste(recycle0 = TRUE)")
            continue
        # (R: an NA element is "NA"; a zero-length argument, NULL included, is "": R 4.5.3, paste("a", NULL, "b"))
        parts.append(["NA" if s is None else s for s in _as_chars(v, "paste()")] or [""])
    if not parts:
        n = 0
    else:
        # (any zero-length argument was made "", so every part has at least one element)
        n = max(len(p) for p in parts)
    width = len(sep) * (len(parts) - 1) if parts else 0
    total = sum(sum(len(p[i % len(p)]) for p in parts) + width for i in range(n))
    if collapse is None:
        with mem.reserve(n, "character", extra_bytes=total):
            return RVector("character", [sep.join(p[i % len(p)] for p in parts) for i in range(n)])
    total += len(collapse) * max(0, n - 1)
    with mem.reserve(1, "character", (n, "character"), extra_bytes=2 * total):
        return RVector("character", [collapse.join(sep.join(p[i % len(p)] for p in parts) for i in range(n))])


def paste(sess, call, args):
    sep = _arg(args, "sep", None)
    return _paste(sess, call, args, " " if sep is None else _string1(sep, "paste(sep =)", call))


def paste0(sess, call, args):
    return _paste(sess, call, args, "")


# ---------------------------------------------------------------- nchar, case, substr

def nchar(sess, call, args):
    for f in ("type", "allowNA", "keepNA"):
        if _arg(args, f) is not MISSING:
            raise NotSupported("nchar(%s =)" % f)
    x = _arg(args, "x")
    data = _as_chars(x, "nchar()")
    with mem.reserve(len(data), "integer"):
        return _keep_names("integer", [None if s is None else len(s) for s in data], x)


def _case(f):
    def case(sess, call, args):
        x = _arg(args, "x")
        data = _as_chars(x, "case conversion")
        with mem.reserve(len(data), "character", extra_bytes=_chars_bytes(data)):
            return _keep_names("character", [None if s is None else f(s) for s in data], x)
    return case


toupper = _case(str.upper)
tolower = _case(str.lower)


def _ints(v, what):
    """A numeric argument's elements as Python ints (None for NA), truncated toward zero as R's coercion does."""
    if not isinstance(v, RVector) or v.type not in ("logical", "integer", "double"):
        raise NotSupported("%s of this kind of value" % what)
    out = []
    for e in v.data:
        if e is None or (isinstance(e, float) and e != e):
            out.append(None)
        elif isinstance(e, float) and abs(e) == math.inf:
            raise NotSupported("%s with an infinite position" % what)
        else:
            out.append(int(e))
    return out


def substr(sess, call, args):
    x = _arg(args, "x")
    data = _as_chars(x, "substr()")
    start = _ints(_arg(args, "start"), "substr(start =)")
    stop = _ints(_arg(args, "stop"), "substr(stop =)")
    n = len(data)
    if n and (not start or not stop):
        raise RError("invalid substring arguments", call)
    with mem.reserve(n, "character", extra_bytes=_chars_bytes(data)):
        out = []
        for i, s in enumerate(data):
            a, b = start[i % len(start)], stop[i % len(stop)]
            if s is None or a is None or b is None:
                out.append(None)
            else:
                out.append(s[max(a, 1) - 1:max(b, 0)])
        return _keep_names("character", out, x)


# ---------------------------------------------------------------- sprintf

# a conversion: flags, width, precision and its letter (positional %n$ and * widths are refused below)
_SPEC = re.compile(r"%(?P<flags>[-+ 0#]*)(?P<width>\d*)(?:\.(?P<prec>\d*))?(?P<conv>[a-zA-Z%])")


def _sprintf1(spec, v, i, call):
    """One conversion of element i of v (an RVector, recycled)."""
    flags, width, prec, conv = spec.group("flags"), spec.group("width"), spec.group("prec"), spec.group("conv")
    e = v.data[i % len(v.data)]
    head = "%" + flags + width + ("." + prec if prec is not None else "")
    if conv in "di":
        if v.type == "double":
            if e is not None and e == e and abs(e) != math.inf and e != int(e):
                raise RError("invalid format '%s'; use format %%f, %%e, %%g or %%a for numeric objects"
                             % spec.group(0), call)
        elif v.type not in ("integer", "logical"):
            raise RError("invalid format '%s'; use format %%s for character objects" % spec.group(0), call)
        if e is None or (isinstance(e, float) and e != e):
            # (NA in the field's width, as a string: R 4.5.3, sprintf("%5.1f", NA))
            return ("%" + ("-" if "-" in flags else "") + width + "s") % "NA"
        return (head + "d") % int(e)
    if conv in "feEgG":
        if v.type not in ("integer", "double", "logical"):
            raise RError("invalid format '%s'; use format %%s for character objects" % spec.group(0), call)
        if e is None or (isinstance(e, float) and e != e):
            word = "NA" if e is None else "NaN"
            return ("%" + ("-" if "-" in flags else "") + width + "s") % word
        x = float(e)
        if abs(x) == math.inf:
            return ("%" + ("-" if "-" in flags else "") + width + "s") % ("Inf" if x > 0 else "-Inf")
        return (head + conv) % x
    if conv == "s":
        s = _as_chars(RVector(v.type, [e]), "sprintf()")[0]
        return (head + "s") % ("NA" if s is None else s)
    if conv in "xXo":
        if v.type not in ("integer", "logical") or e is None:
            raise NotSupported("sprintf('%%%s') of this value" % conv)
        return (head + conv) % int(e)
    raise NotSupported("sprintf()'s %%%s" % conv)


def sprintf(sess, call, args):
    fmt_v = _arg(args, "fmt")
    if not (isinstance(fmt_v, RVector) and fmt_v.type == "character"):
        raise NotSupported("sprintf(fmt =) other than character")
    vals = [v for name, v in args if name != "fmt"]
    for v in vals:
        if not isinstance(v, RVector):
            raise NotSupported("sprintf() of this kind of value")
    lens = [len(fmt_v.data)] + [len(v.data) for v in vals]
    if min(lens) == 0:
        return RVector("character", [])
    n = max(lens)
    # (each format's pieces, parsed once)
    parsed = []
    for f in fmt_v.data:
        if f is None:
            parsed.append(None)
            continue
        if "*" in f or re.search(r"%\d+\$", f):
            raise NotSupported("sprintf() with * widths or numbered arguments")
        pieces, at = [], 0
        for m in _SPEC.finditer(f):
            pieces.append(f[at:m.start()])
            pieces.append(m)
            at = m.end()
        pieces.append(f[at:])
        parsed.append(pieces)
    used = max((sum(1 for p in ps if not isinstance(p, str) and p.group("conv") != "%") for ps in parsed if ps), default=0)
    if used > len(vals):
        raise RError("too few arguments", call)
    out = []
    with mem.reserve(n, "character"):
        for i in range(n):
            ps = parsed[i % len(parsed)]
            if ps is None:
                out.append(None)
                continue
            k, buf = 0, []
            for p in ps:
                if isinstance(p, str):
                    buf.append(p)
                elif p.group("conv") == "%":
                    buf.append("%")
                else:
                    buf.append(_sprintf1(p, vals[k], i, call))
                    k += 1
            out.append("".join(buf))
    with mem.reserve(n, "character", extra_bytes=_chars_bytes(out)):
        return RVector("character", out)


# ---------------------------------------------------------------- format and formatC

def _pad(strings, width, left):
    w = max([width] + [len(s) for s in strings])
    return [s.ljust(w) if left else s.rjust(w) for s in strings]


def format_(sess, call, args):
    for name, _ in args:
        if name not in ("x", "nsmall", "width", "trim"):
            raise NotSupported("format(%s =)" % name if name else "format() with more arguments")
    x = _arg(args, "x")
    nsmall = _arg(args, "nsmall")
    nsmall = 0 if nsmall is MISSING else _int1(nsmall, "format(nsmall =)")
    width = _arg(args, "width")
    width = 0 if width is MISSING else _int1(width, "format(width =)")
    trim = _arg(args, "trim")
    trim = False if trim is MISSING else (isinstance(trim, RVector) and trim.type == "logical" and trim.data == [True])
    if not isinstance(x, RVector):
        raise NotSupported("format() of this kind of value")
    if x.type == "double":
        kind, d = fmt.real_layout(x.data)
        if kind == "f":
            d = max(d, nsmall)
        strings = [fmt.format_real1(e, (kind, d)) for e in x.data]
    elif x.type == "integer":
        strings = ["NA" if e is None else str(e) for e in x.data]
    elif x.type == "logical":
        strings = ["NA" if e is None else ("TRUE" if e else "FALSE") for e in x.data]
    elif x.type == "character":
        strings = ["NA" if e is None else e for e in x.data]
    else:
        raise NotSupported("format() of %s" % x.type)
    if not trim:
        strings = _pad(strings, width, left=x.type == "character")
    with mem.reserve(len(strings), "character", extra_bytes=_chars_bytes(strings)):
        return _keep_names("character", strings, x)


def formatC(sess, call, args):
    for name, _ in args:
        if name not in ("x", "width", "digits", "format", "flag"):
            raise NotSupported("formatC(%s =)" % name if name else "formatC() with more arguments")
    x = _arg(args, "x")
    if not isinstance(x, RVector):
        raise NotSupported("formatC() of this kind of value")
    if x.type not in ("integer", "double", "character"):
        raise RError("unsupported type ", call)
    width = _arg(args, "width")
    width = 0 if width is MISSING else _int1(width, "formatC(width =)")
    digits = _arg(args, "digits")
    digits = None if digits is MISSING or digits is NULL else _int1(digits, "formatC(digits =)")
    form = _arg(args, "format")
    form = None if form is MISSING or form is NULL else _string1(form, "formatC(format =)", call)
    flag = _arg(args, "flag")
    flag = "" if flag is MISSING else _string1(flag, "formatC(flag =)", call)
    if any(c not in "-0 +#" for c in flag):
        raise NotSupported("formatC(flag =) other than '-', '0', ' ', '+' and '#'")
    if form is None:
        form = {"integer": "d", "double": "g", "character": "s"}[x.type]
    if form not in ("d", "f", "e", "E", "g", "G", "s"):
        raise NotSupported("formatC(format = \"%s\")" % form)
    if form == "s" and x.type != "character" or form != "s" and x.type == "character":
        raise NotSupported("formatC() of %s with format \"%s\"" % (x.type, form))
    if form == "d" and x.type == "double":
        raise NotSupported("formatC(format = \"d\") of doubles")
    # (a double's precision is 4 when digits isn't given, in every format: R 4.5.3, formatC(3.14159) is "3.142",
    # formatC(1/3, format = "f") "0.3333", format = "e" "3.3333e-01")
    if x.type == "double" and digits is None:
        digits = 4
    spec = "%" + flag + (str(width) if width else "") + ("." + str(digits) if digits is not None and form != "s" else "")
    out = []
    for e in x.data:
        if e is None or (isinstance(e, float) and e != e):
            # (NA as "NA", right-justified to the width unless flag has "-": R 4.5.3, formatC(c(1L, NA), width = 4))
            word = "NA" if e is None else "NaN"
            out.append(word.ljust(width) if "-" in flag else word.rjust(width))
        elif isinstance(e, float) and abs(e) == math.inf:
            word = "Inf" if e > 0 else "-Inf"
            out.append(word.ljust(width) if "-" in flag else word.rjust(width))
        elif form == "d":
            out.append((spec + "d") % int(e))
        elif form == "s":
            out.append((spec + "s") % e)
        else:
            out.append((spec + form) % float(e))
    with mem.reserve(len(out), "character", extra_bytes=_chars_bytes(out)):
        return _keep_names("character", out, x)


# ---------------------------------------------------------------- base's character constants

letters = RVector("character", [chr(c) for c in range(ord("a"), ord("z") + 1)])
LETTERS = RVector("character", [chr(c) for c in range(ord("A"), ord("Z") + 1)])
MONTH_NAME = RVector("character", ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                                   "October", "November", "December"])
