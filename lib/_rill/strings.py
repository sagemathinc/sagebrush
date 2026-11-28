"""Rill's string functions (design/rill.md A3): paste, paste0, nchar, toupper,
tolower, substr, sprintf, format and formatC, as R 4.5.3 behaves
(rill-tests/str/).

Memory (design §8.5): each one reserves its whole peak before it builds its
result: the result's elements, and the characters of its strings at
CHAR_BYTES each.  Where the strings' length isn't known in advance (sprintf,
format, formatC, substr), each string is first measured as its pieces (text,
runs of padding, slices of strings that exist), and nothing is built until the
reservation holds.  What isn't implemented yet is
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


# A string to build is a list of pieces, measured before anything is built (design §8.5): a str (bounded, or one
# that already exists), (count, ch) for ch repeated count times, or (s, a, b) for s[a:b] of an existing s.

def _piece_len(p):
    if isinstance(p, str):
        return len(p)
    return p[0] if len(p) == 2 else p[2] - p[1]


def _piece(p):
    if isinstance(p, str):
        return p
    return p[1] * p[0] if len(p) == 2 else p[0][p[1]:p[2]]


def _pieces_len(ps):
    return sum(_piece_len(p) for p in ps)


def _built(n, pieces):
    """The strings whose pieces are pieces(0), ..., pieces(n - 1) (each a list, or None for NA), their whole peak
    reserved first: the strings are measured, then n strings and their characters are reserved (and the longest one
    again, held as its pieces while it is joined), then they are built."""
    total = longest = 0
    for i in range(n):
        ps = pieces(i)
        if ps is not None:
            k = _pieces_len(ps)
            total += k
            longest = max(longest, k)
    held = mem.reserve(n, "character", extra_bytes=CHAR_BYTES * (total + longest))

    def build():
        out = []
        for i in range(n):
            ps = pieces(i)
            out.append(None if ps is None else "".join(_piece(p) for p in ps))
        return out
    return held, build


def _padded(ps, width, left, fill=" "):
    """ps in a field width characters wide: padded on the right when left, else on the left."""
    pad = max(0, width - _pieces_len(ps))
    return ps + [(pad, fill)] if left else [(pad, fill)] + ps


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

    def pieces(i):
        s, a, b = data[i], start[i % len(start)], stop[i % len(stop)]
        if s is None or a is None or b is None:
            return None
        a, b = max(a, 1) - 1, min(max(b, 0), len(s))
        return [(s, a, b)] if a < b else []
    held, build = _built(n, pieces)
    with held:
        return _keep_names("character", build(), x)


# ---------------------------------------------------------------- sprintf

# a conversion: flags, width, precision and its letter (positional %n$ and * widths are refused below)
_SPEC = re.compile(r"%(?P<flags>[-+ 0#]*)(?P<width>\d*)(?:\.(?P<prec>\d*))?(?P<conv>[a-zA-Z%])")

# (R 4.5.3's words for a value its conversion doesn't take, by the value's type)
_USE = {"double": "use format %f, %e, %g or %a for numeric objects",
        "integer": "use format %d, %i, %o, %x or %X for integer objects",
        "logical": "use format %d or %i for logical objects",
        "character": "use format %s for character objects"}

# the precision past which a double's digits are all zeros: %f shows a double exactly in at most 1074 decimals, %e and
# %g in at most 767 significant digits; the zeros past these are counted, not formatted
_EXACT = {"f": 1100, "e": 800, "E": 800, "g": 800, "G": 800}

_INT_MAX = 2147483647


def _word(word, flags, width):
    """A word (NA, NaN, Inf) in a conversion's field: right-justified, or left with the - flag."""
    return _padded([word], width, "-" in flags)


def _int_pieces(k, flags, width, prec, conv):
    """C's %d, %i, %x, %X or %o of the integer k: R 4.5.3, sprintf("%08.3x", 1L) is "     001", "%+x" "1", "%#5x"
    of 255L " 0xff", "%#.3o" of 8L "010", "%.0d" of 0L ""."""
    if conv in "di":
        a = abs(k)
        digits = str(a)
        sign = "-" if k < 0 else "+" if "+" in flags else " " if " " in flags else ""
    else:
        # (an integer's bits, as C's unsigned conversions show them: sprintf("%x", -1L) is "ffffffff")
        a = k & 0xFFFFFFFF
        digits = ("%" + conv) % a
        sign = ""
    if prec == 0 and a == 0:
        digits = ""
    zeros = max(0, prec - len(digits)) if prec is not None else 0
    if "#" in flags:
        if conv == "o" and zeros == 0 and not digits.startswith("0"):
            zeros = 1
        elif conv in "xX" and a:
            sign = "0" + conv
    ps = [sign, (zeros, "0"), digits]
    if "0" in flags and "-" not in flags and prec is None:
        return [sign, (max(0, width - _pieces_len(ps)) + zeros, "0"), digits]
    return _padded(ps, width, "-" in flags)


def _float_pieces(x, flags, width, prec, conv):
    """C's %f, %e, %E, %g or %G of the finite double x."""
    p = 6 if prec is None else prec
    q = min(p, _EXACT[conv])
    core = ("%" + "".join(c for c in "+ #" if c in flags) + "." + str(q) + conv) % x
    # (the zeros a precision past the exact digits adds, before any exponent; %g without # drops them)
    tail = p - q if conv in "feE" or "#" in flags else 0
    at = len(core)
    if tail and conv != "f":
        e = core.find("e" if conv in "eg" else "E")
        at = e if e >= 0 else at
    head, exp = core[:at], core[at:]
    ps = [head, (tail, "0"), exp]
    if "0" in flags and "-" not in flags:
        s = 1 if head[:1] in ("+", "-", " ") else 0
        return [head[:s], (max(0, width - _pieces_len(ps)), "0"), head[s:], (tail, "0"), exp]
    return _padded(ps, width, "-" in flags)


def _utf8_len(c):
    o = ord(c)
    return 1 if o < 0x80 else 2 if o < 0x800 else 3 if o < 0x10000 else 4


def _str_pieces(s, flags, width, prec):
    """C's %s of s, its width and precision counting bytes: R 4.5.3, sprintf("[%3s]", "é") is "[ é]"."""
    end, nbytes = len(s), 0
    for j, c in enumerate(s):
        k = _utf8_len(c)
        if prec is not None and nbytes + k > prec:
            if nbytes < prec:
                raise NotSupported("sprintf()'s %s precision inside a multibyte character")
            end = j
            break
        nbytes += k
    pad = (max(0, width - nbytes), " ")
    ps = [(s, 0, end)]
    return ps + [pad] if "-" in flags else [pad] + ps


class _Arg:
    """An argument of sprintf(), as its conversions see it.  R 4.5.3 converts an argument once, for the first
    element's conversion of it, and every other element's conversion takes it as converted or errs: sprintf("%x", 2)
    is "2" but sprintf(c("%f", "%d"), c(1, 2)) is an error, and sprintf(c("%s", "%d"), 1:2) too."""

    def __init__(self, v):
        self.v, self.type = v, v.type

    def convert(self, sess, call, spec, conv):
        v = self.v
        if conv in "dixXo" and self.type == "double":
            # (a double for an integer conversion is taken if every element is NA or a whole number of integer range,
            # -2^31 being NA with a warning: sprintf("%d", 2147483648) errs, sprintf("%d", -2147483648) is "NA")
            low = False
            for e in v.data:
                if e is None:
                    continue
                if e != e or abs(e) == math.inf or e != int(e) or e > _INT_MAX or e < -_INT_MAX - 1:
                    raise RError("invalid format '%s'; %s" % (spec, _USE["double"]), call)
                low = low or e == -_INT_MAX - 1
            if low:
                sess.warn("NAs introduced by coercion to integer range", call)
            self.type = "integer"
        elif conv in "feEgG" and self.type in ("integer", "logical"):
            self.type = "double"
        elif conv == "s" and self.type != "character":
            self.type = "character"

    def pieces(self, i, spec, call):
        flags, width, prec, conv = spec.group("flags"), spec.group("width"), spec.group("prec"), spec.group("conv")
        width = int(width) if width else 0
        prec = None if prec is None else int(prec or 0)
        e = self.v.data[i % len(self.v.data)]
        t = self.type
        if conv in "dixXo":
            if t != "integer" and not (t == "logical" and conv in "di"):
                raise RError("invalid format '%s'; %s" % (spec.group(0), _USE[t]), call)
            if e is None or (self.v.type == "double" and e == -_INT_MAX - 1):
                # (NA as %s writes it, the sign and 0 flags dropped but the precision kept: R 4.5.3, sprintf("%05d",
                # NA) is "   NA", "%5.1d" "    N", "%08.0d" eight spaces)
                return _str_pieces("NA", flags, width, prec)
            return _int_pieces(int(e), flags, width, prec, conv)
        if conv in "feEgG":
            if t != "double":
                raise RError("invalid format '%s'; %s" % (spec.group(0), _USE[t]), call)
            if e is None:
                return _word("NA", flags, width)
            x = float(e)
            if x != x:
                # (R 4.5.3: sprintf("% f", NaN) is " NaN", "%+f" "NaN", "%+f" of Inf "+Inf", "% f" " Inf")
                return _word((" " if " " in flags and "+" not in flags else "") + "NaN", flags, width)
            if abs(x) == math.inf:
                sign = "-" if x < 0 else "+" if "+" in flags else " " if " " in flags else ""
                return _word(sign + "Inf", flags, width)
            return _float_pieces(x, flags, width, prec, conv)
        if conv == "s":
            if t != "character":
                raise RError("invalid format '%s'; %s" % (spec.group(0), _USE[t]), call)
            s = e if self.v.type == "character" else _as_chars(RVector(self.v.type, [e]), "sprintf()")[0]
            return _str_pieces("NA" if s is None else s, flags, width, prec)
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
    sargs = [_Arg(v) for v in vals]
    first = [True]

    def pieces(i):
        ps = parsed[i % len(parsed)]
        if ps is None:
            # (an NA format gives the string "NA": R 4.5.3, sprintf(c(NA, "%d"), 1:2) is "NA" "2")
            return ["NA"]
        k, out = 0, []
        for p in ps:
            if isinstance(p, str):
                out.append(p)
            elif p.group("conv") == "%":
                out.append("%")
            else:
                if first[0] and i == 0:
                    sargs[k].convert(sess, call, p.group(0), p.group("conv"))
                out.extend(sargs[k].pieces(i, p, call))
                k += 1
        if i == 0:
            first[0] = False
        return out
    held, build = _built(n, pieces)
    with held:
        return RVector("character", build())


# ---------------------------------------------------------------- format and formatC

def format_(sess, call, args):
    for name, _ in args:
        if name not in ("x", "nsmall", "width", "trim"):
            raise NotSupported("format(%s =)" % name if name else "format() with more arguments")
    x = _arg(args, "x")
    nsmall = _arg(args, "nsmall")
    if nsmall is MISSING:
        nsmall = 0
    else:
        # (R 4.5.3 takes 0 to 20 decimals, truncated toward zero: format(1, nsmall = 2.5) is "1.00", nsmall = -0.5
        # "1", nsmall = 21 an error)
        k = nsmall.data[0] if isinstance(nsmall, RVector) and nsmall.type in ("logical", "integer", "double") \
            and len(nsmall.data) == 1 else MISSING
        if k is MISSING:
            raise NotSupported("format(nsmall =) other than one number")
        if k is not None and k == k and (abs(k) == math.inf or not -_INT_MAX <= int(k) <= _INT_MAX):
            # (R 4.5.3 makes it an integer first: format(1, nsmall = Inf) warns "NAs introduced by coercion to
            # integer range" before its error)
            sess.warn("NAs introduced by coercion to integer range", call)
            k = None
        if k is None or k != k or not 0 <= int(k) <= 20:
            raise RError("invalid 'nsmall' argument", call)
        nsmall = int(k)
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

    def pieces(i):
        r = raw(x.data[i])
        return [r] if trim else _padded([r], w, left)
    held, build = _built(n, pieces)
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
    width = None if width is MISSING or width is NULL else _int1(width, "formatC(width =)")
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
    if form in ("f", "e", "E", "g", "G") and digits is None:
        # (an integer's too: R 4.5.3, formatC(12345L, format = "g") is "1.234e+04", format = "f" "12345.0000")
        digits = 4
    if digits is not None and digits < 0:
        # (a negative digits is C's default precision, 6: R 4.5.3, formatC(1/3, digits = -1) is "0.333333", and
        # the width digits + 1 below is 7, formatC(2, digits = -1) "      2")
        digits = 6
    if digits is not None and form != "s":
        # (R 4.5.3 shows at most 324 decimals in format "f" and 50 digits in the others, with a warning:
        # formatC(1/3, format = "e", digits = 900) is formatC(1/3, format = "e", digits = 50))
        most = 324 if form == "f" else 50
        if digits > most:
            sess.warn("'digits' reduced to %d" % most, call)
            digits = most
    if form != "s":
        # (a number's width comes from its digits (2 for an integer when not given) unless given: with digits and no
        # width it is digits + 1, and a width of 0 is digits, which must not be 0 (R 4.5.3, formatC(c(2, 1/3),
        # digits = 10) is "          2" "0.3333333333", formatC(2L, width = 0) " 2", formatC(2, digits = 0,
        # width = 0) an error); a string's is only its own (formatC("x", digits = 3) is "x")
        d = 2 if digits is None else digits
        if width is None:
            given = _arg(args, "digits")
            width = d + 1 if given is not MISSING and given is not NULL else 0
        elif width == 0:
            if d == 0:
                raise RError("width cannot be zero", call)
            width = d
    width = width or 0
    if width < 0:
        flag, width = flag + "-", -width
    # (format "d" doesn't take digits: R 4.5.3, formatC(22L, width = 3, digits = 3, format = "d") is " 22")
    prec = digits if form not in ("s", "d") else None

    def pieces(i):
        e = x.data[i]
        if e is None or (isinstance(e, float) and e != e):
            # (NA as "NA", right-justified to the width unless flag has "-": R 4.5.3, formatC(c(1L, NA), width = 4))
            return _word("NA" if e is None else "NaN", flag, width)
        if isinstance(e, float) and abs(e) == math.inf:
            return _word("Inf" if e > 0 else "-Inf", flag, width)
        if form == "d":
            return _int_pieces(int(e), flag, width, prec, "d")
        if form == "s":
            return _padded([e], width, "-" in flag)
        return _float_pieces(float(e), flag, width, prec, form)
    held, build = _built(len(x.data), pieces)
    with held:
        return _keep_names("character", build(), x)


# ---------------------------------------------------------------- base's character constants

letters = RVector("character", [chr(c) for c in range(ord("a"), ord("z") + 1)])
LETTERS = RVector("character", [chr(c) for c in range(ord("A"), ord("Z") + 1)])
MONTH_NAME = RVector("character", ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                                   "October", "November", "December"])
