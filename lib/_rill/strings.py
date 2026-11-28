"""Rill's string functions (design/rill.md A3): paste, paste0, nchar, toupper,
tolower, substr, sprintf, format and formatC, as R 4.5.3 behaves
(rill-tests/str/).

Memory (design §8.5): each one reserves its whole peak before it builds its
result: the result's elements, and the characters of its strings at
CHAR_BYTES each.  Where the strings' length isn't known in advance (sprintf,
format, formatC, substr), it is measured first, one element at a time, and
nothing is kept until the reservation holds.  What isn't implemented yet is
refused in words (NotSupported), never approximated.

Names: nchar, toupper, tolower, substr, format and formatC keep x's names;
paste and sprintf drop them (R 4.5.3).
"""

import math
import re

from . import fmt, mem
from .eval import NotSupported, RError
from .values import MISSING, NULL, RVector

# the bytes reserved for each character of a string built here, as for the names c() builds (base.py): a string's
# character takes up to 4 bytes in the host
CHAR_BYTES = 4


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
    """The bytes reserved for the characters of strings (mem.reserve's extra_bytes)."""
    return CHAR_BYTES * sum(len(s) for s in strings if s is not None)


def _measured(n, make):
    """[make(0), ..., make(n - 1)] (each a str or None), its whole peak reserved first: the strings are measured one
    at a time and dropped, then n strings and their characters are reserved, then they are built."""
    total = 0
    for i in range(n):
        s = make(i)
        if s is not None:
            total += len(s)
    return mem.reserve(n, "character", extra_bytes=CHAR_BYTES * total), lambda: [make(i) for i in range(n)]


# ---------------------------------------------------------------- paste

def _paste(sess, call, args, sep):
    collapse = None
    parts = []
    for name, v in args:
        if name == "sep" and sep is not None:
            continue
        if name == "collapse":
            if v is not NULL:
                collapse = _string1(v, "paste(collapse =)", call)
            continue
        if name == "recycle0":
            if not (isinstance(v, RVector) and v.type == "logical" and v.data == [False]):
                raise NotSupported("paste(recycle0 = TRUE)")
            continue
        # (an NA element is "NA": R 4.5.3)
        parts.append(["NA" if s is None else s for s in _as_chars(v, "paste()")])
    sep = "" if sep is None else sep
    # (R 4.5.3: when every argument is zero-length the result is too, paste(character(0)) is character(0); otherwise
    # a zero-length argument, NULL included, is "", paste("a", NULL, "b") is "a  b")
    n = max((len(p) for p in parts), default=0)
    parts = [p or [""] for p in parts]
    width = len(sep) * (len(parts) - 1) if parts else 0
    total = sum(sum(len(p[i % len(p)]) for p in parts) + width for i in range(n))
    if collapse is None:
        with mem.reserve(n, "character", extra_bytes=CHAR_BYTES * total):
            return RVector("character", [sep.join(p[i % len(p)] for p in parts) for i in range(n)])
    # (the n strings, then the one joined from them: both held at once)
    joined = total + len(collapse) * max(0, n - 1)
    with mem.reserve(1, "character", (n, "character"), extra_bytes=CHAR_BYTES * (total + joined)):
        return RVector("character", [collapse.join(sep.join(p[i % len(p)] for p in parts) for i in range(n))])


def paste(sess, call, args):
    sep = _arg(args, "sep", None)
    return _paste(sess, call, args, " " if sep is None else _string1(sep, "paste(sep =)", call))


def paste0(sess, call, args):
    # (paste0 has no sep formal: a sep = argument is one of its strings, paste0("a", sep = "b") is "ab")
    return _paste(sess, call, args, None)


# ---------------------------------------------------------------- nchar, case, substr

def nchar(sess, call, args):
    for f in ("type", "allowNA", "keepNA"):
        if _arg(args, f) is not MISSING:
            raise NotSupported("nchar(%s =)" % f)
    x = _arg(args, "x")
    data = _as_chars(x, "nchar()")
    with mem.reserve(len(data), "integer"):
        return _keep_names("integer", [None if s is None else len(s) for s in data], x)


# the characters whose full uppercase mapping is several characters but whose simple one is a single other character:
# the Greek letters with ypogegrammeni, each to its prosgegrammeni form (Unicode's case data; R 4.5.3: toupper of
# "ᾀ" is "ᾈ", of "ᾳ" "ᾼ"); every other one maps to itself (toupper("straße") is "STRAßE")
_SIMPLE_UPPER = {c: c + 8 for b in (0x1F80, 0x1F90, 0x1FA0) for c in range(b, b + 8)}
_SIMPLE_UPPER.update({0x1FB3: 0x1FBC, 0x1FC3: 0x1FCC, 0x1FF3: 0x1FFC})


def _upper1(c):
    # (R 4.5.3 maps one character to one, by Unicode's simple mapping; Python's is the full one, sometimes longer)
    u = c.upper()
    if len(u) == 1:
        return u
    return chr(_SIMPLE_UPPER.get(ord(c), ord(c)))


def _lower1(c):
    # (only U+0130 has a longer full lowercase mapping; its simple one is "i": R 4.5.3, tolower("İ") is "i")
    u = c.lower()
    return u if len(u) == 1 else u[0]


def _case(f):
    def case(sess, call, args):
        x = _arg(args, "x")
        data = _as_chars(x, "case conversion")
        # (one character for one: the result's characters are the input's, known before anything is built)
        with mem.reserve(len(data), "character", extra_bytes=_chars_bytes(data)):
            return _keep_names("character", [None if s is None else "".join(map(f, s)) for s in data], x)
    return case


toupper = _case(_upper1)
tolower = _case(_lower1)


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

    def make(i):
        s, a, b = data[i], start[i % len(start)], stop[i % len(stop)]
        return None if s is None or a is None or b is None else s[max(a, 1) - 1:max(b, 0)]
    held, build = _measured(n, make)
    with held:
        return _keep_names("character", build(), x)


# ---------------------------------------------------------------- sprintf

# a conversion: flags, width, precision and its letter (positional %n$ and * widths are refused below)
_SPEC = re.compile(r"%(?P<flags>[-+ 0#]*)(?P<width>\d*)(?:\.(?P<prec>\d*))?(?P<conv>[a-zA-Z%])")


def _field(word, flags, width):
    """A word (NA, NaN, Inf) in a conversion's field: right-justified, or left with the - flag."""
    w = int(width) if width else 0
    return word.ljust(w) if "-" in flags else word.rjust(w)


def _whole(v, e, spec, call):
    """e (of v) as an int for %d, %i, %x, %X and %o, with R's error for a fraction or a character value."""
    if v.type == "double":
        if e != int(e):
            raise RError("invalid format '%s'; use format %%f, %%e, %%g or %%a for numeric objects" % spec.group(0),
                         call)
    elif v.type not in ("integer", "logical"):
        raise RError("invalid format '%s'; use format %%s for character objects" % spec.group(0), call)
    return int(e)


def _sprintf1(spec, v, i, call):
    """One conversion of element i of v (an RVector, recycled)."""
    flags, width, prec, conv = spec.group("flags"), spec.group("width"), spec.group("prec"), spec.group("conv")
    e = v.data[i % len(v.data)]
    head = "%" + flags + width + ("." + prec if prec is not None else "")
    na = e is None or (isinstance(e, float) and e != e)
    if conv in "dixXo":
        if na or (isinstance(e, float) and abs(e) == math.inf):
            if v.type == "character":
                _whole(v, e, spec, call)
            # (NA in the field's width, as a string: R 4.5.3, sprintf("%5d", NA_integer_), sprintf("%x", NA_integer_))
            return _field("NA", flags, width)
        k = _whole(v, e, spec, call)
        if conv in "di":
            return (head + "d") % k
        # (an integer's bits, as C's unsigned conversions show them: R 4.5.3, sprintf("%x", -1L) is "ffffffff")
        k &= 0xFFFFFFFF
        if conv == "o" and "#" in flags:
            # (C's alternate octal form is a leading 0, Python's "0o": R 4.5.3, sprintf("%#o", 8L) is "010")
            digits = ("%" + ("." + prec if prec is not None else "") + "o") % k
            digits = digits if digits.startswith("0") else "0" + digits
            w = int(width) if width else 0
            if "-" in flags:
                return digits.ljust(w)
            return digits.rjust(w, "0" if "0" in flags and prec is None else " ")
        return (head + conv) % k
    if conv in "feEgG":
        if v.type not in ("integer", "double", "logical"):
            raise RError("invalid format '%s'; use format %%s for character objects" % spec.group(0), call)
        if na:
            return _field("NA" if e is None else "NaN", flags, width)
        x = float(e)
        if abs(x) == math.inf:
            return _field("Inf" if x > 0 else "-Inf", flags, width)
        return (head + conv) % x
    if conv == "s":
        s = _as_chars(RVector(v.type, [e]), "sprintf()")[0]
        s = "NA" if s is None else s
        # (a string's width and precision count its bytes, as C's do: R 4.5.3, sprintf("[%3s]", "é") is "[ é]")
        b = s.encode("utf-8")
        if prec is not None and int(prec or 0) < len(b):
            try:
                s = b[:int(prec or 0)].decode("utf-8")
            except UnicodeDecodeError:
                raise NotSupported("sprintf()'s %s precision inside a multibyte character")
            b = s.encode("utf-8")
        pad = " " * max(0, (int(width) if width else 0) - len(b))
        return s + pad if "-" in flags else pad + s
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
    # (every argument recycles to the longest only if its length divides it: R 4.5.3, sprintf("%d:%d", 1:2, 1:3))
    if any(n % k for k in lens):
        raise RError("arguments cannot be recycled to the same length", call)
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

    def make(i):
        ps = parsed[i % len(parsed)]
        if ps is None:
            return None
        k, buf = 0, []
        for p in ps:
            if isinstance(p, str):
                buf.append(p)
            elif p.group("conv") == "%":
                buf.append("%")
            else:
                buf.append(_sprintf1(p, vals[k], i, call))
                k += 1
        return "".join(buf)
    held, build = _measured(n, make)
    with held:
        return RVector("character", build())


# ---------------------------------------------------------------- format and formatC

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
        raw = lambda e: fmt.format_real1(e, (kind, d))
    elif x.type == "integer":
        raw = lambda e: "NA" if e is None else str(e)
    elif x.type == "logical":
        raw = lambda e: "NA" if e is None else ("TRUE" if e else "FALSE")
    elif x.type == "character":
        raw = lambda e: "NA" if e is None else e
    else:
        raise NotSupported("format() of %s" % x.type)
    n = len(x.data)
    # (the common width, measured one element at a time: every string is padded to it)
    w = width
    for e in x.data:
        w = max(w, len(raw(e)))
    left = x.type == "character"
    if trim:
        make = lambda i: raw(x.data[i])
    else:
        make = lambda i: raw(x.data[i]).ljust(w) if left else raw(x.data[i]).rjust(w)
    held, build = _measured(n, make)
    with held:
        return _keep_names("character", build(), x)


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

    def make(i):
        e = x.data[i]
        if e is None or (isinstance(e, float) and e != e):
            # (NA as "NA", right-justified to the width unless flag has "-": R 4.5.3, formatC(c(1L, NA), width = 4))
            word = "NA" if e is None else "NaN"
            return word.ljust(width) if "-" in flag else word.rjust(width)
        if isinstance(e, float) and abs(e) == math.inf:
            word = "Inf" if e > 0 else "-Inf"
            return word.ljust(width) if "-" in flag else word.rjust(width)
        if form == "d":
            return (spec + "d") % int(e)
        if form == "s":
            return (spec + "s") % e
        return (spec + form) % float(e)
    held, build = _measured(len(x.data), make)
    with held:
        return _keep_names("character", build(), x)


# ---------------------------------------------------------------- base's character constants

letters = RVector("character", [chr(c) for c in range(ord("a"), ord("z") + 1)])
LETTERS = RVector("character", [chr(c) for c in range(ord("A"), ord("Z") + 1)])
MONTH_NAME = RVector("character", ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                                   "October", "November", "December"])
