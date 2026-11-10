"""Rill's formatting (design/rill.md §4, §5.3): numbers, vectors and deparse.

The layouts follow what R 4.5.3 prints (rill-tests/print/, rill-tests/core/):
`digits` significant digits (7), fixed notation unless scientific is narrower
by more than `scipen` (0), `width` 80, the `[k]` labels of ?print.default,
named vectors as a names row over a values row, and characters escaped and
padded as R does (lib/_rill/uchar.py, R's own widths and escapes).  A1.6 adds
lists, matrices and the rest.
"""

import math

from .values import MISSING, NULL, Formals, Lang, Missing, Placeholder, Sym, RVector


class Options:
    """The print options a printer reads: digits, scipen and width."""
    __slots__ = ("digits", "scipen", "width")

    def __init__(self, digits=7, scipen=0, width=80):
        self.digits = digits
        self.scipen = scipen
        self.width = width


DEFAULT = Options()


# ---------------------------------------------------------------- numbers

def _significant(x, digits):
    """(decimal exponent, significant digits needed) of a finite x at `digits` digits."""
    if x == 0:
        return 0, 1
    mant, e = ("%.*e" % (digits - 1, abs(x))).split("e")
    return int(e), max(1, len(mant.replace(".", "").rstrip("0")))


def _special(x):
    if x is None:
        return "NA"
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Inf" if x > 0 else "-Inf"
    return None


def real_layout(vals, digits=None, scipen=None):
    """R's common layout for doubles: ("f", decimals) or ("e", mantissa decimals)."""
    digits = digits or DEFAULT.digits
    scipen = DEFAULT.scipen if scipen is None else scipen
    left, right, sig, emax, emin, neg, any_fin = 1, 0, 1, -400, 400, 0, False
    # (one pass of running scalars: nothing proportional to the vector is built)
    for x in vals:
        if x is None or x != x or x in (math.inf, -math.inf):
            continue
        any_fin = True
        if x < 0:
            neg = 1
        e, ns = _significant(x, digits)
        if e >= 0:
            left = max(left, e + 1)
        right = max(right, ns - e - 1)
        sig = max(sig, ns)
        emax, emin = max(emax, e), min(emin, e)
    if not any_fin:
        return ("f", 0)
    width_f = neg + left + (right + 1 if right > 0 else 0)
    ew = 3 if max(abs(emax), abs(emin)) >= 100 else 2
    width_e = neg + (sig + 1 if sig > 1 else sig) + 2 + ew
    if width_f <= width_e + scipen:
        return ("f", right)
    return ("e", sig - 1)


def format_real1(x, layout):
    s = _special(x)
    if s is not None:
        return s
    kind, d = layout
    if kind == "f":
        r = "%.*f" % (d, x)
        if r.startswith("-") and float(r) == 0:
            r = r[1:]
        return r
    return "%.*e" % (d, x)


def format_real(vals, digits=None, scipen=None):
    layout = real_layout(vals, digits, scipen)
    return [format_real1(x, layout) for x in vals]


def format_complex(vals, opts=DEFAULT):
    """R's complex layout: the real parts in one layout, the imaginary parts (by magnitude) in another."""
    re_layout = real_layout([None if z is None else z.real for z in vals], opts.digits, opts.scipen)
    im_layout = real_layout([None if z is None else abs(z.imag) for z in vals], opts.digits, opts.scipen)
    out = []
    for z in vals:
        if z is None:
            out.append("NA")
            continue
        im = z.imag
        sign = "-" if (im < 0 or (im == 0 and math.copysign(1.0, im) < 0)) else "+"
        out.append(format_real1(z.real, re_layout) + sign + format_real1(abs(im), im_layout) + "i")
    return out


# ---------------------------------------------------------------- characters

def _escape_cp(cp):
    return ("\\u%04x" % cp) if cp < 0x10000 else ("\\U{%06x}" % cp)


def escape_string(s, quote='"'):
    """s as print() shows it inside quotes: R's escapes, and R's own escaping of the characters it doesn't print
    (lib/_rill/uchar.py)."""
    out = []
    uchar = None
    for c in s:
        o = ord(c)
        if c == "\\":
            out.append("\\\\")
        elif c == quote:
            out.append("\\" + c)
        elif c == "\n":
            out.append("\\n")
        elif c == "\t":
            out.append("\\t")
        elif c == "\r":
            out.append("\\r")
        elif o < 32 or o == 127:
            out.append({"\a": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v"}.get(c, "\\%03o" % o))
        elif o < 127:
            out.append(c)
        else:
            if uchar is None:
                from . import uchar
            out.append(_escape_cp(o) if uchar.klass(o) == 3 else c)
    return "".join(out)


def width(s):
    """The columns print() gives s (escaped text counts its own characters)."""
    if s.isascii():
        return len(s)
    from . import uchar
    w = 0
    for c in s:
        o = ord(c)
        w += 1 if o < 127 else min(uchar.klass(o), 2) if uchar.klass(o) != 3 else len(_escape_cp(o))
    return w


# ---------------------------------------------------------------- vectors

def format_elements(x, quote=True, opts=DEFAULT):
    """The element strings of an atomic vector, unpadded."""
    t = x.type
    if t == "double":
        return format_real(x.data, opts.digits, opts.scipen)
    if t == "integer":
        return ["NA" if e is None else str(e) for e in x.data]
    if t == "logical":
        return ["NA" if e is None else ("TRUE" if e else "FALSE") for e in x.data]
    if t == "complex":
        return format_complex(x.data, opts)
    if t == "character":
        if quote:
            return ["NA" if e is None else '"' + escape_string(e) + '"' for e in x.data]
        return ["NA" if e is None else e for e in x.data]
    return None


EMPTY = {"logical": "logical(0)", "integer": "integer(0)", "double": "numeric(0)",
         "complex": "complex(0)", "character": "character(0)"}


def _pad(s, w, left):
    gap = w - width(s)
    return s + " " * gap if left else " " * gap + s


def names_of(v):
    return v.attrs.get("names") if v.attrs else None


def print_value(v, write, opts=DEFAULT):
    """print(v) for an atomic vector or NULL; None for what Rill doesn't print yet (the caller says so)."""
    if v is NULL:
        write("NULL\n")
        return True
    if not isinstance(v, RVector) or (v.attrs and set(v.attrs) != {"names"}):
        return None
    if not v.data:
        write(EMPTY[v.type] + (("\n" if names_of(v) is None else "\n")))
        return True
    strs = format_elements(v, True, opts)
    names = names_of(v)
    if names is not None:
        _print_named(strs, names.data, write, opts)
        return True
    n = len(strs)
    w = max(width(s) for s in strs)
    labw = len("[%d]" % n)
    per = max(1, (opts.width - labw) // (w + 1))
    left = v.type == "character"
    for i in range(0, n, per):
        lab = ("[%d]" % (i + 1)).rjust(labw)
        write(lab + "".join(" " + _pad(s, w, left) for s in strs[i:i + per]) + "\n")
    return True


def _print_named(strs, names, write, opts):
    """A named vector: rows of names over rows of values, every column the widest name or value, right-justified,
    each followed by a space; as many columns as fit in `width`."""
    shown = ["<NA>" if nm is None else nm for nm in names]
    w = 0
    for s in strs:
        w = max(w, width(s))
    for s in shown:
        w = max(w, width(s))
    per = max(1, opts.width // (w + 1))
    for i in range(0, len(strs), per):
        write("".join(_pad(s, w, False) + " " for s in shown[i:i + per]) + "\n")
        write("".join(_pad(s, w, False) + " " for s in strs[i:i + per]) + "\n")


# ---------------------------------------------------------------- deparse

BINARY_SPACED = {"+", "-", "*", "/", "<-", "<<-", "=", "==", "!=", "<", ">", "<=", ">=", "&", "&&",
                 "|", "||", "~"}
BINARY_TIGHT = {"^", ":", "$", "@", "::", ":::"}
UNARY = {"-", "+", "!", "~"}
RESERVED = {"if", "else", "repeat", "while", "function", "for", "next", "break", "TRUE", "FALSE",
            "NULL", "Inf", "NaN", "NA", "NA_integer_", "NA_real_", "NA_character_", "in"}


def syntactic(name):
    if not name or name in RESERVED:
        return False
    if name == "...":
        return True
    c = name[0]
    if not (c.isalpha() or c == "."):
        return False
    if c == "." and len(name) > 1 and name[1].isdigit():
        return False
    return all(ch.isalnum() or ch in "._" for ch in name)


def deparse_symbol(name):
    return name if syntactic(name) else "`" + name.replace("\\", "\\\\").replace("`", "\\`") + "`"


def deparse_number(x, integer=False):
    if x is None:
        return "NA_integer_" if integer else "NA_real_"
    if integer:
        return "%dL" % x
    s = _special(x)
    if s is not None:
        return s
    return format_real1(x, real_layout([x], 15))


def deparse_constant(v):
    if v is NULL:
        return "NULL"
    if len(v.data) != 1 or v.attrs:
        return None
    x = v.data[0]
    if v.type == "logical":
        return "NA" if x is None else ("TRUE" if x else "FALSE")
    if v.type == "integer":
        return deparse_number(x, True)
    if v.type == "double":
        return deparse_number(x)
    if v.type == "character":
        return "NA_character_" if x is None else '"' + escape_string(x) + '"'
    if v.type == "complex":
        # (each part at 15 digits, R 4.5.3: 0+2i; parenthesized as an operator's operand, _operand)
        if x is None:
            return "complex(real=NA, imaginary=0)"
        im = x.imag
        sign = "-" if (im < 0 or (im == 0 and math.copysign(1.0, im) < 0)) else "+"
        return deparse_number(x.real) + sign + deparse_number(abs(im)) + "i"
    return None


def _operand(e):
    """An operator's operand: a complex constant in parentheses, as R deparses 1 + (0+2i) and -(0+2i)."""
    if isinstance(e, RVector) and e.type == "complex" and len(e.data) == 1 and e.data[0] is not None and not e.attrs:
        return "(" + deparse_constant(e) + ")"
    return e


# deparse breaks a line after an operator or a comma once it is longer than this (R 4.5.3: an error's call is the
# first line of its deparse, rill-tests/core/test_2.R)
DEPARSE_CUTOFF = 60
BREAK = object()       # a place deparse may break a line


def _pieces(e):
    """e's deparse as text pieces and BREAK marks, from an explicit stack (a call's tree can be thousands deep)."""
    out = []
    stack = [e]
    while stack:
        x = stack.pop()
        if isinstance(x, str) or x is BREAK:
            out.append(x)
            continue
        parts = _expand(x)
        if isinstance(parts, str):
            out.append(parts)
        else:
            stack.extend(reversed(parts))
    return out


def _expand(e):
    """One node: its text, or its parts (text, BREAK and child nodes) in order."""
    if isinstance(e, Sym):
        return deparse_symbol(e.name)
    if isinstance(e, Placeholder):
        return '"_"'
    if isinstance(e, Missing):
        return ""
    if isinstance(e, RVector) or e is NULL:
        c = deparse_constant(e)
        return c if c is not None else "<vector>"
    if not isinstance(e, Lang):
        return "<object>"
    fn, args = e.fn, e.args
    if isinstance(fn, Sym):
        f = fn.name
        n = len(args)
        if n == 2 and all(a[0] is None for a in args):
            a, b = args[0][1], args[1][1]
            if f in BINARY_SPACED or (f.startswith("%") and f.endswith("%") and len(f) > 1):
                return [_operand(a), " %s " % f, BREAK, _operand(b)]
            if f in BINARY_TIGHT:
                return [_operand(a), f, _operand(b)]
        if n == 1 and args[0][0] is None and f in UNARY:
            return [f, _operand(args[0][1])]
        if f == "(" and n == 1:
            return ["(", args[0][1], ")"]
        if f in ("[", "[[") and n >= 1:
            return [args[0][1], f] + _arg_parts(args[1:]) + ["]" if f == "[" else "]]"]
        if f == "if" and n in (2, 3):
            parts = ["if (", args[0][1], ") ", args[1][1]]
            return parts + ([" else ", args[2][1]] if n == 3 else [])
        if f == "function" and n >= 2 and isinstance(args[0][1], Formals):
            parts = ["function("]
            for i, (nm, d) in enumerate(args[0][1].items):
                if i:
                    parts += [", ", BREAK]
                parts += [nm] if d is MISSING else [nm, " = ", d]
            return parts + [") ", args[1][1]]
        head = deparse_symbol(f)
    else:
        head = fn
    return [head, "("] + _arg_parts(args) + [")"]


def _arg_parts(args):
    parts = []
    for i, (name, v) in enumerate(args):
        if i:
            parts += [", ", BREAK]
        if name is not None:
            parts += [deparse_symbol(name), " = "]
        parts.append(v)
    return parts


def deparse_lines(e, cutoff=DEPARSE_CUTOFF, first_only=False):
    """e's deparse as lines, broken as R breaks them (continuation lines indented by four spaces)."""
    lines, cur = [], []
    width = 0
    for p in _pieces(e):
        if p is BREAK:
            if width > cutoff:
                lines.append("".join(cur))
                if first_only:
                    return lines
                cur, width = ["    "], 4
            continue
        cur.append(p)
        width += len(p)
    lines.append("".join(cur))
    return lines


def deparse(e):
    """R source for a language object, its lines joined."""
    return "\n".join(deparse_lines(e))


def deparse_call_line(e):
    """The first line of a call's deparse: what R prints in "Error in <call> :" and "In <call> :"."""
    return deparse_lines(e, first_only=True)[0]
