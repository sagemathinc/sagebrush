"""Rill: formatting and printing (R's print layouts, from documentation and black-box comparison)."""

import math
import sys

import _rill as C
from _rill import (Vec, RList, NULL, Closure, Builtin, Sym, Call, Const, Formals, MISSING, RError,
                   mk_chr, mk_int, mk_dbl, mk_lgl, getattr_, names_of, classes, is_factor, is_df,
                   builtin, method, as_type, num1, int1, str1, match_spec)

WIDTH = 80
OPTS = {"digits": 7, "scipen": 0, "width": 80, "OutDec": "."}


def out(s):
    sys.stdout.write(s)


# ---------------------------------------------------------------- numbers

def _sig(x, digits):
    """(exponent, significant digits needed) of a finite x at `digits` significant digits."""
    if x == 0:
        return 0, 1
    s = "%.*e" % (digits - 1, abs(x))
    mant, e = s.split("e")
    kp = int(e)
    d = mant.replace(".", "").rstrip("0")
    return kp, max(1, len(d))


def _special(x):
    if x is None:
        return "NA"
    if isinstance(x, float):
        if math.isnan(x):
            return "NaN"
        if math.isinf(x):
            return "Inf" if x > 0 else "-Inf"
    return None


def real_layout(vals, digits=None, nsmall=0):
    """R's common format for a double vector: ('f', decimals) or ('e', mantissa digits)."""
    digits = digits or OPTS["digits"]
    fin = [x for x in vals if x is not None and not math.isnan(x) and not math.isinf(x)]
    if not fin:
        return ("f", 0, 0)
    neg = 1 if any(x < 0 for x in fin) else 0
    mxsl, rgt, mxns, mxe, mne = 1, 0, 1, -400, 400
    for x in fin:
        kp, ns = _sig(x, digits)
        if kp >= 0:
            mxsl = max(mxsl, kp + 1)
        rgt = max(rgt, ns - kp - 1)
        mxns = max(mxns, ns)
        mxe = max(mxe, kp)
        mne = min(mne, kp)
    rgt = max(rgt, nsmall, 0)
    wF = neg + mxsl + (rgt + 1 if rgt > 0 else 0)
    ew = 3 if max(abs(mxe), abs(mne)) >= 100 else 2
    wE = neg + (mxns + 1 if mxns > 1 else mxns) + 2 + ew
    if wF <= wE + OPTS["scipen"]:
        return ("f", rgt, wF)
    return ("e", mxns - 1, wE)


def fmt_real1(x, layout):
    s = _special(x)
    if s is not None:
        return s
    kind, d, _ = layout
    if kind == "f":
        r = "%.*f" % (d, x)
        if r.startswith("-") and float(r) == 0:
            r = r[1:] if x > -0.5 * 10 ** (-d) else r
        return r
    r = "%.*e" % (d, x)
    return r


def format_real(vals, digits=None, nsmall=0):
    lay = real_layout(vals, digits, nsmall)
    return [fmt_real1(x, lay) for x in vals]


def format_elems(x, digits=None, quote=False, na="NA", nsmall=0):
    """Element strings of an atomic vector (not padded)."""
    if is_factor(x):
        lv = getattr_(x, "levels").v
        return [("<NA>" if i is None else lv[i - 1]) for i in x.v]
    t = x.type
    if t == "double":
        return format_real(x.v, digits, nsmall)
    if t == "integer":
        return ["NA" if e is None else str(e) for e in x.v]
    if t == "logical":
        return ["NA" if e is None else ("TRUE" if e else "FALSE") for e in x.v]
    if t == "character":
        if quote:
            return [na if e is None else '"' + escape(e) + '"' for e in x.v]
        return [na if e is None else e for e in x.v]
    raise RError("cannot format type %s" % t)


def escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t")


def dispw(s):
    return len(s)


# ---------------------------------------------------------------- print.default

def print_generic(v, env, args=None):
    """print(x): user and internal S3 methods first, then the default."""
    for cls in classes(v):
        f = C.S3_lookup("print", cls, env)
        if f is not None:
            C.call_fun(f, [(None, v)] + (args or []), env)
            return
    print_default(v, env)


def print_default(v, env, quote=True, digits=None, gap=1, right=False):
    if v is NULL:
        out("NULL\n")
        return
    if isinstance(v, Vec):
        print_atomic(v, quote=quote, digits=digits, gap=gap, right=right)
        return
    if isinstance(v, RList):
        print_list(v, "", env)
        return
    if isinstance(v, (Closure, Builtin)):
        # never print a function's code (clean-room rule for built-ins; user code is the user's)
        if isinstance(v, Builtin):
            out("function (...) .Primitive(\"%s\")\n" % v.name)
        else:
            out(deparse_function(v) + "\n")
        return
    if isinstance(v, (Sym, Call)):
        if isinstance(v, Call) and C.inherits(v, "formula"):
            out(deparse(v) + "\n")
            return
        out(deparse(v) + "\n")
        return
    if isinstance(v, C.Env):
        out("<environment>\n")
        return
    out(repr(v) + "\n")


def empty_name(x):
    t = "numeric" if x.type == "double" else x.type
    return "%s(0)" % t


def print_atomic(x, quote=True, digits=None, gap=1, right=False):
    d = getattr_(x, "dim")
    if d is not NULL and len(d.v) == 2:
        print_matrix(x, quote=quote, digits=digits, right=right)
        return
    if d is not NULL and len(d.v) == 1:
        print_table1(x, quote=quote, digits=digits)
        return
    if is_factor(x):
        print_factor(x)
        return
    n = len(x.v)
    if n == 0:
        if is_factor(x):
            out("factor(0)\n")
        else:
            out(empty_name(x) + "\n")
        return
    strs = format_elems(x, digits, quote=quote)
    nm = names_of(x)
    if nm is not None:
        print_named(strs, nm, gap=gap)
        return
    left = x.type == "character" and not right
    print_plain(strs, left)


def print_plain(strs, left=False):
    n = len(strs)
    w = max(dispw(s) for s in strs)
    labw = len("[%d]" % n)
    per = max(1, (OPTS["width"] - labw) // (w + 1))
    lines = []
    for i in range(0, n, per):
        lab = ("[%d]" % (i + 1)).rjust(labw)
        cells = [(s.ljust(w) if left else s.rjust(w)) for s in strs[i:i + per]]
        lines.append(lab + "".join(" " + c for c in cells))
    out("\n".join(lines) + "\n")


def print_named(strs, names, gap=1):
    names = ["<NA>" if s is None else s for s in names]
    w = max([dispw(s) for s in strs] + [dispw(s) for s in names])
    per = max(1, OPTS["width"] // (w + gap))
    sep = " " * gap
    for i in range(0, len(strs), per):
        out("".join(s.rjust(w) + sep for s in names[i:i + per]) + "\n")
        out("".join(s.rjust(w) + sep for s in strs[i:i + per]) + "\n")


def print_factor(x, max_levels=None):
    lv = getattr_(x, "levels").v
    n = len(x.v)
    if n == 0:
        out("factor(0)\n")
    else:
        strs = format_elems(x)
        w = max(dispw(s) for s in strs)
        labw = len("[%d]" % n)
        per = max(1, (OPTS["width"] - labw) // (w + 1))
        lines = []
        for i in range(0, n, per):
            lab = ("[%d]" % (i + 1)).rjust(labw)
            lines.append(lab + "".join(" " + s.ljust(w) for s in strs[i:i + per]))
        out("\n".join(lines) + "\n")
    ordered = C.inherits(x, "ordered")
    sep = " < " if ordered else " "
    head = "Levels: "
    line = head + sep.join(lv)
    if len(line) <= OPTS["width"]:
        out(line + "\n")
    else:
        cur = head.rstrip()
        rows = []
        for l in lv:
            if len(cur) + 1 + len(l) > OPTS["width"]:
                rows.append(cur)
                cur = l
            else:
                cur = cur + " " + l
        rows.append(cur)
        out("\n".join(rows) + "\n")


def col_strings(x, j, nr, digits, quote):
    col = Vec(x.type, x.v[j * nr:(j + 1) * nr])
    return format_elems(col, digits, quote=quote)


def print_matrix(x, quote=True, digits=None, right=False, rowlab=None, collab=None):
    nr, nc = getattr_(x, "dim").v
    dn = getattr_(x, "dimnames")
    rn = cn = None
    if dn is not NULL:
        if dn.v[0] is not NULL:
            rn = list(dn.v[0].v)
        if dn.v[1] is not NULL:
            cn = list(dn.v[1].v)
    if rn is None:
        rn = ["[%d,]" % (i + 1) for i in range(nr)]
    if cn is None:
        cn = ["[,%d]" % (j + 1) for j in range(nc)]
    rw = max([dispw(s) for s in rn] + [0])
    if nc == 0:
        out(" " * rw + "\n" + "\n".join(rn) + "\n")
        return
    cols = []
    left = x.type == "character" and not right and quote
    for j in range(nc):
        if x.type == "list":
            s = [summ_cell(e) for e in x.v[j * nr:(j + 1) * nr]]
        else:
            s = col_strings(x, j, nr, digits, quote)
        w = max([dispw(e) for e in s] + [dispw(cn[j])])
        cols.append((s, w))
    # wrap columns at the line width
    j0 = 0
    while j0 < nc:
        tot = rw
        j1 = j0
        while j1 < nc and (j1 == j0 or tot + 1 + cols[j1][1] <= OPTS["width"]):
            tot += 1 + cols[j1][1]
            j1 += 1
        hdr = " " * rw
        for j in range(j0, j1):
            hdr += " " + (cn[j].ljust(cols[j][1]) if left else cn[j].rjust(cols[j][1]))
        out(hdr + "\n")
        for i in range(nr):
            line = rn[i].ljust(rw)
            for j in range(j0, j1):
                s, w = cols[j]
                line += " " + (s[i].ljust(w) if left else s[i].rjust(w))
            out(line + "\n")
        j0 = j1


def summ_cell(e):
    if isinstance(e, Vec) and len(e.v) == 1:
        return format_elems(e)[0]
    return "%s,%d" % (C.implicit_class(e)[0], len(e))


def print_table1(x, quote=False, digits=None):
    dn = getattr_(x, "dimnames")
    names = None
    head = None
    if dn is not NULL:
        names = list(dn.v[0].v) if dn.v[0] is not NULL else None
        dnn = getattr_(dn, "names")
        if dnn is not NULL:
            head = dnn.v[0]
    strs = format_elems(Vec(x.type, x.v), digits, quote=False)
    if head is not None:
        out(head + "\n")
    if names is None:
        print_plain(strs)
    else:
        if not strs:
            out("< table of extent 0 >\n")
            return
        print_named(strs, names)


def is_syntactic(nm):
    if not nm:
        return False
    if not (nm[0].isalpha() or nm[0] == "."):
        return False
    if nm[0] == "." and len(nm) > 1 and nm[1].isdigit():
        return False
    return all(c.isalnum() or c in "._" for c in nm) and nm not in C.KEYWORDS


def print_list(x, prefix, env):
    nm = names_of(x)
    if not x.v:
        if nm is not None:
            out("named list()\n")
        else:
            out("list()\n")
        return
    for i, e in enumerate(x.v):
        if nm is not None and nm[i]:
            tag = prefix + "$" + (nm[i] if is_syntactic(nm[i]) else "`" + nm[i] + "`")
        else:
            tag = prefix + "[[%d]]" % (i + 1)
        out(tag + "\n")
        if isinstance(e, RList) and not C.getattr_(e, "class") is not NULL:
            print_list(e, tag, env)
        else:
            print_generic(e, env)
            out("\n")


# ---------------------------------------------------------------- data frames

def df_nrow(df):
    rn = getattr_(df, "row.names")
    if rn is not NULL:
        return len(rn.v)
    return len(df.v[0]) if df.v else 0


def df_rownames(df):
    rn = getattr_(df, "row.names")
    if rn is NULL:
        return [str(i + 1) for i in range(df_nrow(df))]
    if rn.type == "integer":
        return [str(i) for i in rn.v]
    return list(rn.v)


def format_col(col, digits=None):
    if is_factor(col):
        return format_elems(col)
    if col.type == "character":
        return ["<NA>" if s is None else s for s in col.v]
    return format_elems(col, digits)


@method("print.data.frame")
def print_df(args, env):
    df = args[0][1]
    names = names_of(df) or []
    nr = df_nrow(df)
    if not names:
        out("data frame with 0 columns and %d rows\n" % nr)
        return NULL
    if nr == 0:
        out("[1] " + " ".join(n.ljust(max(len(x) for x in names)) for n in names) + "\n<0 rows> (or 0-length row.names)\n")
        return NULL
    rn = df_rownames(df)
    rw = max(len(s) for s in rn)
    cols = []
    for j, col in enumerate(df.v):
        s = format_col(col)
        w = max([len(e) for e in s] + [len(names[j])])
        cols.append((names[j], s, w))
    j0 = 0
    while j0 < len(cols):
        tot = rw
        j1 = j0
        while j1 < len(cols) and (j1 == j0 or tot + 1 + cols[j1][2] <= OPTS["width"]):
            tot += 1 + cols[j1][2]
            j1 += 1
        out(" " * rw + "".join(" " + c[0].rjust(c[2]) for c in cols[j0:j1]) + "\n")
        for i in range(nr):
            out(rn[i].ljust(rw) + "".join(" " + c[1][i].rjust(c[2]) for c in cols[j0:j1]) + "\n")
        j0 = j1
    C.STATE["visible"] = False
    return df


@method("print.factor")
def _print_factor(args, env):
    print_factor(args[0][1])
    C.STATE["visible"] = False
    return args[0][1]


@method("print.table")
def _print_table(args, env):
    x = args[0][1]
    d = getattr_(x, "dim")
    if d is not NULL and len(d.v) == 2:
        print_table2(x)
    else:
        print_table1(x)
    C.STATE["visible"] = False
    return x


def print_table2(x):
    nr, nc = getattr_(x, "dim").v
    dn = getattr_(x, "dimnames")
    rn = list(dn.v[0].v)
    cn = list(dn.v[1].v)
    dnn = getattr_(dn, "names")
    rh, ch = ("", "")
    if dnn is not NULL:
        rh, ch = dnn.v[0] or "", dnn.v[1] or ""
    strs = format_elems(Vec(x.type, x.v))
    rw = max([len(s) for s in rn] + [len(rh)])
    ws = [max([len(strs[j * nr + i]) for i in range(nr)] + [len(cn[j])]) for j in range(nc)]
    out(rh.ljust(rw) + " " + ch + "\n" if (rh or ch) else "")
    out(rh.ljust(rw) + "".join(" " + cn[j].rjust(ws[j]) for j in range(nc)) + "\n")
    for i in range(nr):
        out(rn[i].ljust(rw) + "".join(" " + strs[j * nr + i].rjust(ws[j]) for j in range(nc)) + "\n")


@method("print.noquote")
def _print_noquote(args, env):
    x = C.shallow(args[0][1])
    cl = [c for c in getattr_(x, "class").v if c != "noquote"]
    C.setattr_(x, "class", mk_chr(cl) if cl else NULL)
    print_default(x, env, quote=False)
    C.STATE["visible"] = False
    return args[0][1]


# ---------------------------------------------------------------- deparse

BIN_SPACED = {"+", "-", "*", "/", "<-", "<<-", "=", "==", "!=", "<", ">", "<=", ">=", "&", "&&", "|", "||", "~", "|>"}
BIN_TIGHT = {"^", ":", "$", "@"}


def deparse_num(x, t):
    if x is None:
        return "NA"
    if t == "integer":
        return "%dL" % x
    if t == "logical":
        return "TRUE" if x else "FALSE"
    if t == "character":
        return '"' + escape(x) + '"'
    if math.isinf(x):
        return "Inf" if x > 0 else "-Inf"
    if math.isnan(x):
        return "NaN"
    return C.num_to_str(x)


def deparse_value(v):
    if v is NULL:
        return "NULL"
    if isinstance(v, Vec):
        if is_factor(v):
            return "structure(...)"
        nm = names_of(v)
        if v.type == "integer" and len(v.v) > 1 and nm is None and all(e is not None for e in v.v) and \
                all(v.v[i + 1] - v.v[i] == 1 for i in range(len(v.v) - 1)):
            return "%d:%d" % (v.v[0], v.v[-1])
        items = [deparse_num(e, v.type) for e in v.v]
        if nm is not None:
            items = ["%s = %s" % (n if is_syntactic(n) else "`%s`" % n, s) for n, s in zip(nm, items)]
        if len(items) == 1 and nm is None:
            return items[0]
        if not items:
            return {"double": "numeric(0)", "integer": "integer(0)", "character": "character(0)", "logical": "logical(0)"}[v.type]
        return "c(" + ", ".join(items) + ")"
    if isinstance(v, RList):
        nm = names_of(v)
        items = [deparse_value(e) for e in v.v]
        if nm is not None:
            items = ["%s = %s" % (n, s) if n else s for n, s in zip(nm, items)]
        return "list(" + ", ".join(items) + ")"
    if isinstance(v, (Sym, Call)):
        return _dp(v)
    return "<value>"


def _dp(node):
    if isinstance(node, Const):
        return deparse_value(node.value)
    if isinstance(node, (Vec, RList)) or node is NULL:
        return deparse_value(node)
    if isinstance(node, Sym):
        return node.name if (is_syntactic(node.name) or node.name in ("...",)) else "`%s`" % node.name
    if node is MISSING:
        return ""
    if isinstance(node, Call):
        fn = node.fn
        a = node.args
        if isinstance(fn, Sym):
            f = fn.name
            if f in BIN_SPACED and len(a) == 2:
                return "%s %s %s" % (_dp(a[0][1]), f, _dp(a[1][1]))
            if (f in BIN_TIGHT or (f.startswith("%") and f.endswith("%"))) and len(a) == 2:
                if f.startswith("%"):
                    return "%s %s %s" % (_dp(a[0][1]), f, _dp(a[1][1]))
                return "%s%s%s" % (_dp(a[0][1]), f, _dp(a[1][1]))
            if f in ("-", "+", "!", "~") and len(a) == 1:
                return f + _dp(a[0][1])
            if f == "(":
                return "(" + _dp(a[0][1]) + ")"
            if f == "[":
                return _dp(a[0][1]) + "[" + ", ".join(deparse_arg(x) for x in a[1:]) + "]"
            if f == "[[":
                return _dp(a[0][1]) + "[[" + ", ".join(deparse_arg(x) for x in a[1:]) + "]]"
            if f == "{":
                return "{\n" + "".join("    " + _dp(x[1]) + "\n" for x in a) + "}"
            if f == "if":
                s = "if (%s) %s" % (_dp(a[0][1]), _dp(a[1][1]))
                if len(a) > 2:
                    s += " else " + _dp(a[2][1])
                return s
            if f == "for":
                return "for (%s in %s) %s" % (_dp(a[0][1]), _dp(a[1][1]), _dp(a[2][1]))
            if f == "while":
                return "while (%s) %s" % (_dp(a[0][1]), _dp(a[1][1]))
            if f == "function":
                return "function(" + ", ".join(n if d is None else "%s = %s" % (n, _dp(d)) for n, d in a[0][1].items) + ") " + _dp(a[1][1])
            head = _dp(fn)
        else:
            head = _dp(fn)
            if isinstance(fn, Call) and isinstance(fn.fn, Sym) and fn.fn.name == "function":
                head = "(" + head + ")"
        return head + "(" + (", " + BRK).join(deparse_arg(x) for x in a) + ")"
    if isinstance(node, Formals):
        return ""
    return str(node)


def deparse_arg(x):
    n, e = x
    if n is None:
        return _dp(e)
    nm = n if is_syntactic(n) else "`%s`" % n
    if e is MISSING:
        return nm + " = "
    if isinstance(e, C.Promise):
        e = e.expr if e.expr is not None else Const(e.value)
    if isinstance(e, (Vec, RList)) or e is NULL:
        return nm + " = " + deparse_value(e)
    return nm + " = " + _dp(e)


BRK = "\x01"


def deparse(node):
    return _dp(node).replace(BRK, "")


def deparse_lines(node, cutoff=60):
    """deparse with R's line breaking of long calls (break at an argument once a line passes the cutoff)."""
    parts = _dp(node).split(BRK)
    lines = [""]
    for p in parts:
        if len(lines[-1]) > cutoff:
            lines.append("    ")
        lines[-1] += p
    return "\n".join(lines)


def deparse_function(f):
    return "function(" + ", ".join(n if d is None else "%s = %s" % (n, deparse(d)) for n, d in f.formals) + ") " + deparse(f.body)


# ---------------------------------------------------------------- builtins: output

@builtin("print")
def _print(args, env):
    x = args[0][1]
    rest = args[1:]
    m = {n: v for n, v in rest if n}
    if "digits" in m and isinstance(x, Vec) and not is_factor(x) and getattr_(x, "class") is NULL:
        old = OPTS["digits"]
        OPTS["digits"] = int1(m["digits"])
        try:
            print_default(x, env)
        finally:
            OPTS["digits"] = old
    elif "quote" in m and isinstance(x, Vec) and getattr_(x, "class") is NULL:
        print_default(x, env, quote=C.as_logical1(m["quote"]))
    else:
        print_generic(x, env, rest)
    C.STATE["visible"] = False
    return x


@builtin("noquote")
def _noquote(args, env):
    x = C.shallow(args[0][1])
    C.setattr_(x, "class", mk_chr(["noquote"]))
    return x


def cat_str(v):
    if v is NULL:
        return []
    if isinstance(v, RList):
        out_ = []
        for e in v.v:
            out_.extend(cat_str(e))
        return out_
    if not isinstance(v, Vec):
        raise RError("argument 1 (type '%s') cannot be handled by 'cat'" % v.type)
    if is_factor(v):
        v = Vec("integer", v.v)
    if v.type == "double":
        return [format_real([e], OPTS["digits"])[0] for e in v.v]
    if v.type == "character":
        return ["NA" if e is None else e for e in v.v]
    return format_elems(v)


@builtin("cat")
def _cat(args, env):
    sep = " "
    fill = False
    items = []
    for n, v in args:
        if n == "sep":
            sep = str1(v)
        elif n == "fill":
            fill = C.as_logical1(v)
        elif n in ("file", "append", "labels"):
            pass
        else:
            items.extend(cat_str(v))
    s = ""
    for i, it in enumerate(items):
        s += it
        if i < len(items) - 1:
            s += sep
    if fill and not s.endswith("\n"):
        s += "\n"
    out(s)
    C.STATE["visible"] = False
    return NULL


@builtin("format")
def _format(args, env):
    x = args[0][1]
    m = {n: v for n, v in args[1:] if n}
    for cls in classes(x):
        f = C.S3_lookup("format", cls, env)
        if f is not None:
            return C.call_fun(f, args, env)
    nsmall = int1(m["nsmall"]) if "nsmall" in m else 0
    digits = int1(m["digits"]) if "digits" in m else None
    width = int1(m["width"]) if "width" in m else 0
    justify = str1(m["justify"]) if "justify" in m else "left"
    if x is NULL:
        return mk_chr([])
    if isinstance(x, RList):
        return mk_chr([", ".join(format_elems(e)) if isinstance(e, Vec) else "NULL" for e in x.v], C.copy_attrs({"names": getattr_(x, "names")} if names_of(x) else None))
    if is_factor(x):
        strs = format_elems(x)
    elif x.type == "character":
        strs = ["NA" if s is None else s for s in x.v]
    else:
        strs = format_elems(x, digits, nsmall=nsmall)
    w = max([len(s) for s in strs] + [width])
    if x.type == "character" and not is_factor(x):
        if justify == "left":
            strs = [s.ljust(w) for s in strs]
        elif justify == "right":
            strs = [s.rjust(w) for s in strs]
        elif justify == "centre":
            strs = [s.center(w) for s in strs]
    else:
        strs = [s.rjust(w) for s in strs]
    attrs = {}
    for k in ("names", "dim", "dimnames"):
        if getattr_(x, k) is not NULL:
            attrs[k] = getattr_(x, k)
    return mk_chr(strs, attrs or None)


def c_format(spec, conv, val):
    """One C-style conversion, as R's sprintf/formatC do."""
    if conv in "di":
        if isinstance(val, float):
            if val != int(val):
                raise RError("invalid format '%s'; use format %%f, %%e, %%g or %%a for numeric objects" % ("%" + spec + conv))
            val = int(val)
        return ("%" + spec + "d") % val
    if conv in "feEgG":
        if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
            s = "NaN" if math.isnan(val) else ("Inf" if val > 0 else "-Inf")
            w = "".join(ch for ch in spec if ch.isdigit() or ch == ".").split(".")[0]
            return s.rjust(int(w)) if w else s
        return ("%" + spec + conv) % float(val)
    if conv == "s":
        return ("%" + spec + "s") % val
    if conv == "x" or conv == "X" or conv == "o":
        return ("%" + spec + conv) % int(val)
    raise RError("unrecognised format specification '%s'" % ("%" + spec + conv))


def sprintf_one(fmt, vals):
    outp = []
    i = 0
    k = 0
    n = len(fmt)
    while i < n:
        c = fmt[i]
        if c != "%":
            outp.append(c)
            i += 1
            continue
        if i + 1 < n and fmt[i + 1] == "%":
            outp.append("%")
            i += 2
            continue
        j = i + 1
        while j < n and fmt[j] in "-+ #0123456789.*":
            j += 1
        spec, conv = fmt[i + 1:j], fmt[j]
        v = vals[k]
        k += 1
        if v is None:
            w = "".join(ch for ch in spec if ch.isdigit() or ch == ".").split(".")[0]
            outp.append("NA".rjust(int(w)) if w else "NA")
        else:
            if conv == "s" and not isinstance(v, str):
                v = cat_str(scalar_of(v))[0] if not isinstance(v, bool) else ("TRUE" if v else "FALSE")
            outp.append(c_format(spec, conv, v))
        i = j + 1
    return "".join(outp)


def scalar_of(v):
    return C.scalar(v)


@builtin("sprintf")
def _sprintf(args, env):
    m = match_spec(args, "fmt, ...")
    fmt = as_type(m["fmt"], "character").v
    vals = []
    for _, v in m["..."]:
        if is_factor(v):
            v = as_type(v, "character")
        vals.append(v.v if isinstance(v, Vec) else [])
    if any(len(v) == 0 for v in vals):
        return mk_chr([])
    n = max([len(fmt)] + [len(v) for v in vals])
    res = []
    for i in range(n):
        res.append(sprintf_one(fmt[i % len(fmt)], [v[i % len(v)] for v in vals]))
    return mk_chr(res)


@builtin("formatC")
def _formatC(args, env):
    m = match_spec(args, "x, width, digits, format, flag, mode, big.mark")
    x = m["x"]
    width = int1(m["width"]) if "width" in m else 0
    digits = int1(m["digits"]) if "digits" in m and m["digits"] is not NULL else None
    flag = str1(m["flag"]) if "flag" in m else ""
    fmt = str1(m["format"]) if "format" in m else ("d" if x.type == "integer" else ("s" if x.type == "character" else "g"))
    res = []
    for v in x.v:
        if fmt == "d":
            v = int(round(v)) if isinstance(v, float) else v
            spec = flag + (str(width) if width else "")
            res.append(("%" + spec + "d") % v)
        elif fmt in "feEgG":
            spec = flag + (str(width) if width else "") + ("." + str(digits) if digits is not None else "")
            res.append(("%" + spec + fmt) % float(v))
        else:
            res.append(("%" + flag + (str(width) if width else "") + "s") % v)
    return mk_chr(res)


@builtin("toString")
def _tostring(args, env):
    m = match_spec(args, "x, sep, ...")
    x = m["x"]
    s = ", ".join(cat_str(x) if not isinstance(x, Vec) or x.type != "double" else [C.num_to_str(e) for e in x.v])
    return mk_chr([s])


# ---------------------------------------------------------------- str()

def str_vec_head(x, n=10):
    if is_factor(x):
        lv = getattr_(x, "levels").v
        return 'Factor w/ %d level%s %s: %s' % (len(lv), "" if len(lv) == 1 else "s",
                                              ",".join('"%s"' % l for l in lv[:5]) + ("" if len(lv) <= 5 else ",.."),
                                              " ".join("NA" if i is None else str(i) for i in x.v[:n]) + (" ..." if len(x.v) > n else ""))
    t = {"double": "num", "integer": "int", "character": "chr", "logical": "logi"}[x.type]
    vals = x.v[:n]
    if x.type == "double":
        strs = [format_real([e], 3)[0] for e in vals]
    elif x.type == "character":
        strs = ['"%s"' % e if e is not None else "NA" for e in vals]
    else:
        strs = format_elems(Vec(x.type, vals))
    dims = "" if len(x.v) == 1 else " [1:%d]" % len(x.v)
    return "%s%s %s%s" % (t, dims, " ".join(strs), " ..." if len(x.v) > n else "")


@builtin("str")
def _str(args, env):
    x = args[0][1]
    if is_df(x):
        names = names_of(x) or []
        out("'data.frame':\t%d obs. of  %d variable%s:\n" % (df_nrow(x), len(names), "" if len(names) == 1 else "s"))
        for nm, col in zip(names, x.v):
            h = str_vec_head(col)
            if not is_factor(col):
                h = h.replace(" [1:%d]" % len(col.v), " ", 1) if len(col.v) != 1 else h
            out(" $ %s: %s\n" % (nm.ljust(max(len(n) for n in names)), h))
    elif isinstance(x, RList):
        names = names_of(x) or [""] * len(x.v)
        out("List of %d\n" % len(x.v))
        w = max([len(n) for n in names] + [0])
        for nm, e in zip(names, x.v):
            out(" $ %s: %s\n" % (nm.ljust(w), str_vec_head(e) if isinstance(e, Vec) else "NULL"))
    elif isinstance(x, Vec):
        out(" " + str_vec_head(x) + "\n")
    elif x is NULL:
        out(" NULL\n")
    C.STATE["visible"] = False
    return NULL
