"""Rill (a feasibility spike): an intro-statistics R-language mode for Sagebrush.

Clean room: written from the R language documentation (R Language Definition,
help pages) and black-box comparison of outputs with real R. No R source code
(C, Fortran or R-level) was read.

Layout: values and coercion; lexer and parser; evaluator; formatting and
printing; builtins; statistics and models. run(src) evaluates a program and
auto-prints visible top-level values as R does.
"""

import math
import sys

# ---------------------------------------------------------------- values

NA = None  # NA in every atomic type (NaN stays a float)


class RError(Exception):
    def __init__(self, msg, call=None):
        Exception.__init__(self, msg)
        self.msg = msg
        self.call = call


class _Null:
    attrs = None

    def __repr__(self):
        return "NULL"

    def __len__(self):
        return 0


NULL = _Null()

TYPES = ("logical", "integer", "double", "character")
RANK = {"logical": 0, "integer": 1, "double": 2, "character": 3, "list": 4}


class Vec:
    """An atomic vector: type is logical/integer/double/character."""

    __slots__ = ("type", "v", "attrs")

    def __init__(self, type, v, attrs=None):
        self.type = type
        self.v = v
        self.attrs = attrs

    def __len__(self):
        return len(self.v)

    def __repr__(self):
        return "Vec(%s, %r, %r)" % (self.type, self.v, self.attrs)


class RList:
    __slots__ = ("v", "attrs")
    type = "list"

    def __init__(self, v, attrs=None):
        self.v = v
        self.attrs = attrs

    def __len__(self):
        return len(self.v)


class Closure:
    type = "closure"

    def __init__(self, formals, body, env):
        self.formals = formals  # list of (name, default node or None)
        self.body = body
        self.env = env
        self.attrs = None


class Builtin:
    type = "builtin"

    def __init__(self, name, fn, special=False):
        self.name = name
        self.fn = fn
        self.special = special  # receives (call, env) unevaluated
        self.attrs = None


class Env:
    __slots__ = ("vars", "parent")
    type = "environment"
    attrs = None

    def __init__(self, parent=None):
        self.vars = {}
        self.parent = parent

    def find(self, name):
        e = self
        while e is not None:
            if name in e.vars:
                return e
            e = e.parent
        return None


class Promise:
    __slots__ = ("expr", "env", "value", "forced")

    def __init__(self, expr, env):
        self.expr = expr
        self.env = env
        self.value = None
        self.forced = False


def force(p):
    if isinstance(p, Promise):
        if not p.forced:
            p.value = force(ev(p.expr, p.env))
            p.forced = True
            p.env = None
        return p.value
    return p


# language objects ----------------------------------------------------------

class Sym:
    __slots__ = ("name",)
    type = "symbol"
    attrs = None

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return "Sym(%s)" % self.name


class Call:
    __slots__ = ("fn", "args", "attrs")
    type = "language"

    def __init__(self, fn, args):
        self.fn = fn  # node
        self.args = args  # list of (name or None, node or None)
        self.attrs = None

    def __repr__(self):
        return "Call(%r, %r)" % (self.fn, self.args)


class Const:
    __slots__ = ("value", "text")

    def __init__(self, value, text=None):
        self.value = value
        self.text = text


class Formals:
    def __init__(self, items):
        self.items = items  # list of (name, node or None)


MISSING = object()  # an empty argument, as in m[, 1]


def mk_lgl(v, attrs=None):
    return Vec("logical", v, attrs)


def mk_int(v, attrs=None):
    return Vec("integer", v, attrs)


def mk_dbl(v, attrs=None):
    return Vec("double", v, attrs)


def mk_chr(v, attrs=None):
    return Vec("character", v, attrs)


def scalar(x):
    if isinstance(x, bool):
        return mk_lgl([x])
    if isinstance(x, int):
        return mk_int([x])
    if isinstance(x, float):
        return mk_dbl([x])
    if isinstance(x, str):
        return mk_chr([x])
    if x is None:
        return mk_lgl([None])
    raise TypeError(x)


def getattr_(x, name):
    a = getattr(x, "attrs", None)
    if a is None:
        return NULL
    return a.get(name, NULL)


def setattr_(x, name, value):
    if value is NULL:
        if x.attrs and name in x.attrs:
            del x.attrs[name]
            if not x.attrs:
                x.attrs = None
        return
    if x.attrs is None:
        x.attrs = {}
    x.attrs[name] = value


def copy_attrs(a):
    return dict(a) if a else None


def shallow(x):
    if isinstance(x, Vec):
        return Vec(x.type, list(x.v), copy_attrs(x.attrs))
    if isinstance(x, RList):
        return RList(list(x.v), copy_attrs(x.attrs))
    return x


def names_of(x):
    n = getattr_(x, "names")
    return None if n is NULL else n.v


def classes(x):
    c = getattr_(x, "class")
    if c is not NULL:
        return list(c.v)
    return implicit_class(x)


def implicit_class(x):
    if isinstance(x, Vec):
        d = getattr_(x, "dim")
        if d is not NULL:
            base = ["matrix", "array"] if len(d.v) == 2 else ["array"]
        else:
            base = []
        t = {"logical": "logical", "integer": "integer", "double": "numeric", "character": "character"}[x.type]
        if base:
            return base + ([t] if t != "numeric" else ["double", "numeric"])
        return [t]
    if isinstance(x, RList):
        return ["list"]
    if x is NULL:
        return ["NULL"]
    if isinstance(x, (Closure, Builtin)):
        return ["function"]
    if isinstance(x, Sym):
        return ["name"]
    if isinstance(x, Call):
        return ["call"]
    if isinstance(x, Env):
        return ["environment"]
    return ["unknown"]


def inherits(x, cls):
    c = getattr_(x, "class")
    return c is not NULL and cls in c.v


def is_factor(x):
    return isinstance(x, Vec) and x.type == "integer" and inherits(x, "factor")


def is_df(x):
    return isinstance(x, RList) and inherits(x, "data.frame")


# coercion ----------------------------------------------------------------------

def num_to_str(x):
    """as.character for a double: 15 significant digits, R style."""
    if x is None:
        return None
    if isinstance(x, bool):
        return "TRUE" if x else "FALSE"
    if isinstance(x, int):
        return str(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Inf" if x > 0 else "-Inf"
    if x == int(x) and abs(x) < 1e15:
        return str(int(x))
    s = "%.15g" % x
    if "e" in s:
        m, e = s.split("e")
        ei = int(e)
        s = m + "e" + ("-" if ei < 0 else "+") + ("%02d" % abs(ei))
    return s


def coerce_elt(x, frm, to):
    if x is None:
        return None
    if to == frm:
        return x
    if to == "logical":
        if frm == "character":
            return {"TRUE": True, "true": True, "T": True, "True": True,
                    "FALSE": False, "false": False, "F": False, "False": False}.get(x)
        if frm == "double" and math.isnan(x):
            return None
        return x != 0
    if to == "integer":
        if frm == "logical":
            return int(x)
        if frm == "double":
            if math.isnan(x) or math.isinf(x):
                return None
            return int(x)
        if frm == "character":
            try:
                return int(float(x))
            except ValueError:
                return None
    if to == "double":
        if frm in ("logical", "integer"):
            return float(x)
        if frm == "character":
            try:
                return float(x.strip())
            except ValueError:
                t = x.strip()
                return {"Inf": math.inf, "-Inf": -math.inf, "NaN": math.nan}.get(t)
    if to == "character":
        if frm == "logical":
            return "TRUE" if x else "FALSE"
        if frm == "integer":
            return str(x)
        if frm == "double":
            return num_to_str(x)
    raise RError("cannot coerce")


def as_type(x, to, keep_attrs=False):
    if x is NULL:
        return Vec(to, [])
    if isinstance(x, RList):
        out = []
        for e in x.v:
            e = as_type(e, to)
            if len(e.v) != 1:
                raise RError("(list) object cannot be coerced to type '%s'" % to)
            out.append(e.v[0])
        return Vec(to, out)
    if not isinstance(x, Vec):
        raise RError("cannot coerce type '%s' to vector of type '%s'" % (x.type, to))
    if is_factor(x) and to == "character":
        lv = getattr_(x, "levels").v
        return Vec(to, [None if i is None else lv[i - 1] for i in x.v])
    if x.type == to:
        return x if keep_attrs else Vec(to, x.v)
    warned = [False]
    out = []
    for e in x.v:
        c = coerce_elt(e, x.type, to)
        if c is None and e is not None and not (x.type == "double" and to in ("logical",)):
            warned[0] = True
        out.append(c)
    if warned[0] and x.type == "character" and to in ("double", "integer", "logical") and to != "logical":
        warn("NAs introduced by coercion")
    attrs = None
    if keep_attrs and x.attrs:
        attrs = {k: v for k, v in x.attrs.items() if k in ("names", "dim", "dimnames")}
    return Vec(to, out, attrs or None)


def as_double(x):
    return as_type(x, "double")


def as_logical1(x, what="argument"):
    if isinstance(x, Vec) and len(x.v) >= 1:
        v = coerce_elt(x.v[0], x.type, "logical") if x.type != "character" else coerce_elt(x.v[0], "character", "logical")
        if v is None:
            raise RError("missing value where TRUE/FALSE needed")
        return v
    if isinstance(x, Vec) or x is NULL:
        raise RError("argument is of length zero")
    raise RError("argument is not interpretable as logical")


def num1(x):
    x = as_double(x)
    if not x.v:
        raise RError("argument of length 0")
    return x.v[0]


def str1(x):
    x = as_type(x, "character")
    return x.v[0] if x.v else None


def int1(x):
    v = num1(x)
    return None if v is None else int(v)


# warnings ------------------------------------------------------------------------

WARNINGS = []


def warn(msg, call=None):
    WARNINGS.append((msg, call))


# ---------------------------------------------------------------- lexer

class Tok:
    __slots__ = ("k", "v", "line", "nl_before")

    def __init__(self, k, v, line):
        self.k = k
        self.v = v
        self.line = line
        self.nl_before = False

    def __repr__(self):
        return "Tok(%s,%r)" % (self.k, self.v)


KEYWORDS = {"if", "else", "for", "while", "repeat", "function", "break", "next",
            "TRUE", "FALSE", "NULL", "NA", "NA_integer_", "NA_real_", "NA_character_",
            "Inf", "NaN", "in"}

OPS = ["<<-", "->>", "%%", "|>", "<-", "->", "<=", ">=", "==", "!=", "&&", "||", "::",
       "[[", "+", "-", "*", "/", "^", "<", ">", "!", "&", "|", "~", "?", ":", "=", "$", "@",
       "(", ")", "{", "}", "[", "]", ",", ";", "\\"]


def lex(src):
    toks = []
    i, n, line = 0, len(src), 1
    stack = []  # bracket kinds: ( [ [[ {
    nl = False
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            if not stack or stack[-1] == "{":
                nl = True
            continue
        if c in " \t\r\f":
            i += 1
            continue
        if c == "#":
            while i < n and src[i] != "\n":
                i += 1
            continue
        start_line = line
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            j = i
            if src.startswith(("0x", "0X"), i):
                j = i + 2
                while j < n and (src[j].isdigit() or src[j] in "abcdefABCDEF"):
                    j += 1
                val = float(int(src[i + 2:j], 16))
            else:
                while j < n and (src[j].isdigit() or src[j] == "."):
                    j += 1
                if j < n and src[j] in "eE":
                    k = j + 1
                    if k < n and src[k] in "+-":
                        k += 1
                    if k < n and src[k].isdigit():
                        j = k
                        while j < n and src[j].isdigit():
                            j += 1
                val = float(src[i:j])
            text = src[i:j]
            if j < n and src[j] == "L":
                t = Tok("num", int(val), start_line)
                j += 1
            else:
                t = Tok("num", val, start_line)
            t.k = "num"
            toks.append(t)
            t.nl_before, nl = nl, False
            i = j
            continue
        if c.isalpha() or c == ".":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "._"):
                j += 1
            w = src[i:j]
            t = Tok("kw" if w in KEYWORDS else "id", w, start_line)
            toks.append(t)
            t.nl_before, nl = nl, False
            i = j
            continue
        if c in "\"'":
            j = i + 1
            buf = []
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                    e = src[j]
                    if e == "n":
                        buf.append("\n")
                    elif e == "t":
                        buf.append("\t")
                    elif e == "\\":
                        buf.append("\\")
                    elif e == "0":
                        buf.append("\0")
                    elif e == "u" or e == "x":
                        k = j + 1
                        if k < n and src[k] == "{":
                            m = src.index("}", k)
                            buf.append(chr(int(src[k + 1:m], 16)))
                            j = m
                        else:
                            m = k
                            lim = 4 if e == "u" else 2
                            while m < n and m - k < lim and src[m] in "0123456789abcdefABCDEF":
                                m += 1
                            buf.append(chr(int(src[k:m], 16)))
                            j = m - 1
                    else:
                        buf.append(e)
                else:
                    if src[j] == "\n":
                        line += 1
                    buf.append(src[j])
                j += 1
            if j >= n:
                raise RError("unexpected INCOMPLETE_STRING")
            t = Tok("str", "".join(buf), start_line)
            toks.append(t)
            t.nl_before, nl = nl, False
            i = j + 1
            continue
        if c == "`":
            j = src.index("`", i + 1)
            t = Tok("id", src[i + 1:j], start_line)
            toks.append(t)
            t.nl_before, nl = nl, False
            i = j + 1
            continue
        if c == "%":
            j = src.find("%", i + 1)
            if j < 0:
                raise RError("unexpected input")
            t = Tok("op", src[i:j + 1], start_line)
            toks.append(t)
            t.nl_before, nl = nl, False
            i = j + 1
            continue
        for op in OPS:
            if src.startswith(op, i):
                break
        else:
            raise RError("unexpected input")
        if op == "[[":
            stack.append("[[")
        elif op in "([{":
            stack.append(op)
        elif op in ")}":
            if stack:
                stack.pop()
        elif op == "]":
            if stack and stack[-1] == "[[":
                # the first ] of ]] closes the inner pair
                if src.startswith("]]", i):
                    stack.pop()
                    t = Tok("op", "]]", start_line)
                    toks.append(t)
                    t.nl_before, nl = nl, False
                    i += 2
                    continue
                stack.pop()
            elif stack:
                stack.pop()
        t = Tok("op", op, start_line)
        toks.append(t)
        t.nl_before, nl = nl, False
        i += len(op)
    t = Tok("eof", None, line)
    t.nl_before = True
    toks.append(t)
    return toks


# ---------------------------------------------------------------- parser

# binding powers (left, right); right-assoc ops have right < left
BINARY = {
    "?": (1, 2),
    "=": (3, 2), "<-": (5, 4), "<<-": (5, 4),
    "->": (6, 7), "->>": (6, 7),
    "~": (8, 9),
    "||": (10, 11), "|": (10, 11),
    "&&": (12, 13), "&": (12, 13),
    "==": (16, 17), "!=": (16, 17), "<": (16, 17), ">": (16, 17), "<=": (16, 17), ">=": (16, 17),
    "+": (18, 19), "-": (18, 19),
    "*": (20, 21), "/": (20, 21),
    "%": (22, 23), "|>": (22, 23),
    ":": (24, 25),
    "^": (29, 28),
}
UNARY_BP = {"-": 26, "+": 26, "!": 14, "~": 9}
POSTFIX_BP = 32


class Incomplete(RError):
    pass


class Parser:
    def __init__(self, src):
        self.toks = lex(src)
        self.i = 0
        self.brace = 0

    def peek(self):
        return self.toks[self.i]

    def next(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect(self, v):
        t = self.next()
        if t.v != v or t.k not in ("op", "kw"):
            if t.k == "eof":
                raise Incomplete("unexpected end of input")
            raise RError("unexpected '%s'" % (t.v,))
        return t

    def program(self):
        out = []
        while True:
            t = self.peek()
            if t.k == "eof":
                return out
            if t.k == "op" and t.v == ";":
                self.next()
                continue
            e = self.expr(0)
            out.append(e)
            t = self.peek()
            if t.k == "eof":
                return out
            if t.k == "op" and t.v == ";":
                self.next()
                continue
            if not t.nl_before:
                raise RError("unexpected %s" % self.describe(t))

    def describe(self, t):
        if t.k == "num":
            return "numeric constant"
        if t.k == "str":
            return "string constant"
        if t.k == "id":
            return "symbol"
        if t.k == "kw" and t.v == "else":
            return "'else'"
        return "'%s'" % t.v

    def skipnl(self):
        pass  # newlines are marked on tokens; prefix positions ignore them

    def expr(self, rbp):
        t = self.next()
        left = self.prefix(t)
        while True:
            t = self.peek()
            if t.nl_before:
                return left
            if t.k != "op":
                return left
            op = t.v
            if op in ("(", "[", "[[", "$", "@", "::"):
                if POSTFIX_BP <= rbp:
                    return left
                self.next()
                left = self.postfix(op, left)
                continue
            key = "%" if (op.startswith("%") and len(op) > 1 and op != "%%") or op == "%%" else op
            if key not in BINARY:
                return left
            lbp, nbp = BINARY[key]
            if lbp <= rbp:
                return left
            self.next()
            right = self.expr(nbp)
            if op == "->":
                left = Call(Sym("<-"), [(None, right), (None, left)])
            elif op == "->>":
                left = Call(Sym("<<-"), [(None, right), (None, left)])
            elif op == "|>":
                if not isinstance(right, Call):
                    raise RError("The pipe operator requires a function call as RHS")
                left = Call(right.fn, [(None, left)] + right.args)
            else:
                left = Call(Sym(op), [(None, left), (None, right)])

    def postfix(self, op, left):
        if op == "(":
            return Call(left, self.args(")"))
        if op == "[":
            return Call(Sym("["), [(None, left)] + self.args("]"))
        if op == "[[":
            return Call(Sym("[["), [(None, left)] + self.args("]]"))
        if op in ("$", "@"):
            t = self.next()
            if t.k == "str":
                nm = t.v
            elif t.k in ("id", "kw"):
                nm = t.v
            elif t.k == "op" and t.v == "(":
                raise RError("unexpected '('")
            else:
                raise Incomplete("unexpected end of input") if t.k == "eof" else RError("unexpected %s" % self.describe(t))
            return Call(Sym(op), [(None, left), (None, Sym(nm))])
        if op == "::":
            t = self.next()
            return Sym(t.v)  # pkg::name -> name (base and stats are attached)

    def args(self, close):
        out = []
        have = False  # the current argument slot is filled
        after_comma = False
        while True:
            t = self.peek()
            if t.k == "eof":
                raise Incomplete("unexpected end of input")
            if t.k == "op" and t.v == close:
                self.next()
                if after_comma:
                    out.append((None, MISSING))
                return out
            if t.k == "op" and t.v == ",":
                self.next()
                if not have:
                    out.append((None, MISSING))
                have, after_comma = False, True
                continue
            if have:
                raise RError("unexpected %s" % self.describe(t))
            name = None
            nt = self.toks[self.i + 1]
            if t.k in ("id", "str") and nt.k == "op" and nt.v == "=":
                name = t.v
                self.next()
                self.next()
                t2 = self.peek()
                if t2.k == "op" and t2.v in (",", close):
                    out.append((name, MISSING))
                    have, after_comma = True, False
                    continue
            out.append((name, self.expr(3)))
            have, after_comma = True, False

    def prefix(self, t):
        k, v = t.k, t.v
        if k == "num":
            if isinstance(v, int):
                return Const(mk_int([v]))
            return Const(mk_dbl([v]))
        if k == "str":
            return Const(mk_chr([v]))
        if k == "id":
            return Sym(v)
        if k == "eof":
            raise Incomplete("unexpected end of input")
        if k == "kw":
            if v == "TRUE":
                return Const(mk_lgl([True]))
            if v == "FALSE":
                return Const(mk_lgl([False]))
            if v == "NULL":
                return Const(NULL)
            if v == "NA":
                return Const(mk_lgl([None]))
            if v == "NA_integer_":
                return Const(mk_int([None]))
            if v == "NA_real_":
                return Const(mk_dbl([None]))
            if v == "NA_character_":
                return Const(mk_chr([None]))
            if v == "Inf":
                return Const(mk_dbl([math.inf]))
            if v == "NaN":
                return Const(mk_dbl([math.nan]))
            if v == "function":
                return self.function()
            if v == "if":
                self.expect("(")
                cond = self.expr(0)
                self.expect(")")
                body = self.expr(2)
                t2 = self.peek()
                if t2.k == "kw" and t2.v == "else" and (not t2.nl_before or self.brace > 0):
                    self.next()
                    alt = self.expr(2)
                    return Call(Sym("if"), [(None, cond), (None, body), (None, alt)])
                return Call(Sym("if"), [(None, cond), (None, body)])
            if v == "for":
                self.expect("(")
                var = self.next()
                self.expect("in")
                seq = self.expr(0)
                self.expect(")")
                body = self.expr(2)
                return Call(Sym("for"), [(None, Sym(var.v)), (None, seq), (None, body)])
            if v == "while":
                self.expect("(")
                cond = self.expr(0)
                self.expect(")")
                body = self.expr(2)
                return Call(Sym("while"), [(None, cond), (None, body)])
            if v == "repeat":
                return Call(Sym("repeat"), [(None, self.expr(2))])
            if v == "break":
                return Call(Sym("break"), [])
            if v == "next":
                return Call(Sym("next"), [])
            raise RError("unexpected '%s'" % v)
        if k == "op":
            if v == "(":
                e = self.expr(0)
                self.expect(")")
                return Call(Sym("("), [(None, e)])
            if v == "{":
                self.brace += 1
                body = []
                while True:
                    t2 = self.peek()
                    if t2.k == "eof":
                        raise Incomplete("unexpected end of input")
                    if t2.k == "op" and t2.v == "}":
                        self.next()
                        break
                    if t2.k == "op" and t2.v == ";":
                        self.next()
                        continue
                    body.append((None, self.expr(0)))
                    t2 = self.peek()
                    if not (t2.nl_before or (t2.k == "op" and t2.v in (";", "}"))):
                        raise RError("unexpected %s" % self.describe(t2))
                self.brace -= 1
                return Call(Sym("{"), body)
            if v == "\\":
                return self.function()
            if v in UNARY_BP:
                e = self.expr(UNARY_BP[v])
                return Call(Sym(v), [(None, e)])
            raise RError("unexpected '%s'" % v)
        raise RError("unexpected input")

    def function(self):
        self.expect("(")
        items = []
        while True:
            t = self.next()
            if t.k == "op" and t.v == ")":
                break
            if t.k == "op" and t.v == ",":
                continue
            if t.k == "eof":
                raise Incomplete("unexpected end of input")
            name = t.v
            default = None
            t2 = self.peek()
            if t2.k == "op" and t2.v == "=":
                self.next()
                default = self.expr(2)
            items.append((name, default))
        body = self.expr(2)
        return Call(Sym("function"), [(None, Formals(items)), (None, body)])


def parse(src):
    return Parser(src).program()


def is_incomplete(src):
    try:
        parse(src)
        return False
    except Incomplete:
        return True
    except RError:
        return False


# ---------------------------------------------------------------- evaluator

class Frame:
    """What a closure call knows about itself (sys.call, match.call, UseMethod)."""
    __slots__ = ("call", "args", "fun", "callenv", "missing", "generic")

    def __init__(self, call, args, fun, callenv):
        self.call = call
        self.args = args
        self.fun = fun
        self.callenv = callenv
        self.missing = set()
        self.generic = None


FRAMES = {}  # id(env) -> Frame


class BreakEx(Exception):
    pass


class NextEx(Exception):
    pass


class ReturnEx(Exception):
    def __init__(self, value):
        Exception.__init__(self)
        self.value = value


class MissingArg:
    pass


MISSING_ARG = MissingArg()

BUILTINS = {}
STATE = {"visible": True}
GLOBAL = None
BASE = Env()


def builtin(name, special=False):
    def deco(fn):
        for nm in ([name] if name in ("|", "||") else name.split("|")):
            BASE.vars[nm] = Builtin(nm, fn, special)
        return fn
    return deco


def lookup(name, env):
    e = env
    while e is not None:
        if name in e.vars:
            v = e.vars[name]
            if v is MISSING_ARG:
                raise RError('argument "%s" is missing, with no default' % name)
            return force(v)
        e = e.parent
    raise RError("object '%s' not found" % name)


def find_fun(name, env):
    e = env
    while e is not None:
        if name in e.vars:
            v = e.vars[name]
            if v is not MISSING_ARG:
                v = force(v)
                if isinstance(v, (Closure, Builtin)):
                    return v
        e = e.parent
    raise RError('could not find function "%s"' % name)


def ev(node, env):
    if isinstance(node, Const):
        STATE["visible"] = True
        return node.value
    if isinstance(node, Sym):
        STATE["visible"] = True
        return lookup(node.name, env)
    if isinstance(node, Call):
        fn = node.fn
        if isinstance(fn, Sym):
            f = find_fun(fn.name, env)
        else:
            f = force(ev(fn, env))
            if not isinstance(f, (Closure, Builtin)):
                raise RError("attempt to apply non-function")
        if isinstance(f, Builtin):
            if f.special:
                return f.fn(node, env)
            args = eval_args(node.args, env)
            STATE["visible"] = True
            return f.fn(args, env)
        return apply_closure(f, promise_args(node.args, env), env, node)
    if isinstance(node, (Vec, RList)) or node is NULL:
        return node
    if isinstance(node, Formals):
        return NULL
    raise RError("cannot evaluate %r" % (node,))


def dots(env):
    e = env.find("...")
    if e is None:
        raise RError("'...' used in an incorrect context")
    return e.vars["..."]


def eval_args(args, env):
    out = []
    for name, a in args:
        if isinstance(a, Sym) and a.name == "...":
            for nm, p in dots(env):
                out.append((nm, force(p)))
        elif a is MISSING:
            out.append((name, MISSING))
        else:
            out.append((name, force(ev(a, env))))
    return out


def promise_args(args, env):
    out = []
    for name, a in args:
        if isinstance(a, Sym) and a.name == "...":
            out.extend(dots(env))
        elif a is MISSING:
            out.append((name, MISSING_ARG))
        elif isinstance(a, Const):
            out.append((name, a.value))
        else:
            out.append((name, Promise(a, env)))
    return out


def match_formals(names, args, fname="function"):
    """R's argument matching: exact names, partial names (before ...), positional."""
    res = {}
    rest = []
    has_dots = "..." in names
    dpos = names.index("...") if has_dots else len(names)
    used = [False] * len(args)
    for i, (nm, v) in enumerate(args):
        if nm is not None and nm in names and nm != "...":
            if nm in res:
                raise RError("formal argument \"%s\" matched by multiple actual arguments" % nm)
            res[nm] = v
            used[i] = True
    for i, (nm, v) in enumerate(args):
        if used[i] or nm is None or nm == "":
            continue
        cands = [f for f in names[:dpos] if f.startswith(nm) and f not in res]
        if len(cands) == 1:
            res[cands[0]] = v
            used[i] = True
        elif len(cands) > 1:
            raise RError("argument %d matches multiple formal arguments" % (i + 1))
    pos = [f for f in names[:dpos] if f not in res]
    k = 0
    for i, (nm, v) in enumerate(args):
        if used[i]:
            continue
        if nm is None or nm == "":
            if k < len(pos):
                res[pos[k]] = v
                k += 1
                continue
        if has_dots:
            rest.append((nm, v))
        else:
            if nm:
                raise RError("unused argument (%s = %s)" % (nm, "..."))
            raise RError("unused argument")
    if has_dots:
        res["..."] = rest
    return res


def apply_closure(f, args, callenv, call):
    env = Env(f.env)
    names = [n for n, _ in f.formals]
    m = match_formals(names, args)
    fr = Frame(call, args, f, callenv)
    for name, default in f.formals:
        if name in m and m[name] is not MISSING_ARG:
            env.vars[name] = m[name]
        elif name == "...":
            env.vars["..."] = []
        elif default is not None:
            env.vars[name] = Promise(default, env)
            fr.missing.add(name)
        else:
            env.vars[name] = MISSING_ARG
            fr.missing.add(name)
    FRAMES[id(env)] = fr
    try:
        return force(ev(f.body, env))
    except ReturnEx as r:
        return r.value
    finally:
        del FRAMES[id(env)]


def call_fun(f, args, env, call=None):
    """Call an R function value with already-evaluated (name, value) args."""
    if isinstance(f, Builtin):
        if f.special:
            node = Call(Sym(f.name), [(n, Const(v)) for n, v in args])
            return f.fn(node, env)
        return f.fn(args, env)
    if call is None:
        call = Call(Sym("FUN"), [(n, Const(v)) for n, v in args])
    return apply_closure(f, args, env, call)


def frame_of(env):
    e = env
    while e is not None:
        fr = FRAMES.get(id(e))
        if fr is not None:
            return e, fr
        e = e.parent
    return None, None


def match_spec(args, spec, fname=""):
    """Match evaluated builtin args to a spec 'x, y, na.rm, ...'; returns a dict (... -> list)."""
    names = [s.strip() for s in spec.split(",") if s.strip()]
    m = match_formals(names, [(n, v) for n, v in args if v is not MISSING], fname)
    return m


def S3_lookup(generic, cls, env):
    name = generic + "." + cls
    e = env
    while e is not None and e is not BASE:
        if name in e.vars:
            v = force(e.vars[name])
            if isinstance(v, Closure):
                return v
        e = e.parent
    return METHODS.get(name)


METHODS = {}


def method(name):
    def deco(fn):
        METHODS[name] = Builtin(name, fn)
        return fn
    return deco


def dispatch(generic, x, args, env, default=None):
    """Internal S3 dispatch from a builtin generic (user methods first)."""
    for cls in classes(x) + ["default"]:
        f = S3_lookup(generic, cls, env)
        if f is not None:
            return call_fun(f, args, env)
    if default is None:
        raise RError("no applicable method for '%s' applied to an object of class \"%s\"" % (generic, classes(x)[0]))
    return default(args, env)


# assignment -----------------------------------------------------------------------

def assign(target, value, env, superassign=False):
    if isinstance(target, Const) and isinstance(target.value, Vec) and target.value.type == "character":
        target = Sym(target.value.v[0])
    if isinstance(target, Sym):
        if superassign:
            e = env.parent.find(target.name) if env.parent else None
            (e or GLOBAL).vars[target.name] = value
        else:
            env.vars[target.name] = value
        return
    if isinstance(target, Call):
        fn = target.fn
        fname = fn.name if isinstance(fn, Sym) else None
        if fname is None or not target.args:
            raise RError("invalid assignment target")
        inner = target.args[0][1]
        if isinstance(inner, Sym):
            try:
                cur = lookup(inner.name, env if not superassign else env.parent)
            except RError:
                if fname in ("[", "[[", "$"):
                    cur = NULL
                else:
                    raise
        else:
            cur = force(ev(inner, env))
        rest = eval_args(target.args[1:], env) if fname not in ("$", "@") else [(None, mk_chr([target.args[1][1].name]))]
        rf = find_fun(fname + "<-", env)
        new = call_fun(rf, [(None, cur)] + rest + [("value", value)], env)
        assign(inner, new, env, superassign)
        return
    raise RError("invalid (do_set) left-hand side to assignment")


# specials ---------------------------------------------------------------------------

@builtin("<-|=")
def _assign(call, env):
    target, rhs = call.args[0][1], call.args[1][1]
    v = force(ev(rhs, env))
    assign(target, v, env)
    STATE["visible"] = False
    return v


_assign_fn = BASE.vars["<-"]
_assign_fn.special = True
BASE.vars["="].special = True


@builtin("<<-", special=True)
def _superassign(call, env):
    v = force(ev(call.args[1][1], env))
    assign(call.args[0][1], v, env, True)
    STATE["visible"] = False
    return v


@builtin("{", special=True)
def _brace(call, env):
    v = NULL
    STATE["visible"] = True
    for _, e in call.args:
        v = force(ev(e, env))
    return v


@builtin("(", special=True)
def _paren(call, env):
    v = force(ev(call.args[0][1], env))
    STATE["visible"] = True
    return v


@builtin("if", special=True)
def _if(call, env):
    c = force(ev(call.args[0][1], env))
    if isinstance(c, Vec) and len(c.v) > 1:
        raise RError("the condition has length > 1")
    if as_logical1(c):
        return force(ev(call.args[1][1], env))
    if len(call.args) > 2:
        return force(ev(call.args[2][1], env))
    STATE["visible"] = False
    return NULL


def elements(x):
    if isinstance(x, Vec):
        if is_factor(x):
            x = as_type(x, "character")
        return [Vec(x.type, [e]) for e in x.v]
    if isinstance(x, RList):
        return list(x.v)
    if x is NULL:
        return []
    raise RError("invalid for() loop sequence")


@builtin("for", special=True)
def _for(call, env):
    var = call.args[0][1].name
    seq = force(ev(call.args[1][1], env))
    for item in elements(seq):
        env.vars[var] = item
        try:
            ev(call.args[2][1], env)
        except BreakEx:
            break
        except NextEx:
            continue
    STATE["visible"] = False
    return NULL


@builtin("while", special=True)
def _while(call, env):
    while as_logical1(force(ev(call.args[0][1], env))):
        try:
            ev(call.args[1][1], env)
        except BreakEx:
            break
        except NextEx:
            continue
    STATE["visible"] = False
    return NULL


@builtin("repeat", special=True)
def _repeat(call, env):
    while True:
        try:
            ev(call.args[0][1], env)
        except BreakEx:
            break
        except NextEx:
            continue
    STATE["visible"] = False
    return NULL


@builtin("break", special=True)
def _break(call, env):
    raise BreakEx()


@builtin("next", special=True)
def _next(call, env):
    raise NextEx()


@builtin("return", special=True)
def _return(call, env):
    v = force(ev(call.args[0][1], env)) if call.args else NULL
    raise ReturnEx(v)


@builtin("function", special=True)
def _function(call, env):
    STATE["visible"] = True
    return Closure(call.args[0][1].items, call.args[1][1], env)


@builtin("quote", special=True)
def _quote(call, env):
    return lang_value(call.args[0][1])


def lang_value(node):
    if isinstance(node, Const):
        return node.value
    return node


@builtin("&&", special=True)
def _andand(call, env):
    a = force(ev(call.args[0][1], env))
    av = scalar_lgl(a, "&&")
    if av is False:
        STATE["visible"] = True
        return mk_lgl([False])
    b = scalar_lgl(force(ev(call.args[1][1], env)), "&&")
    STATE["visible"] = True
    if b is False:
        return mk_lgl([False])
    if av is None or b is None:
        return mk_lgl([None])
    return mk_lgl([True])


@builtin("||", special=True)
def _oror(call, env):
    av = scalar_lgl(force(ev(call.args[0][1], env)), "||")
    if av is True:
        STATE["visible"] = True
        return mk_lgl([True])
    b = scalar_lgl(force(ev(call.args[1][1], env)), "||")
    STATE["visible"] = True
    if b is True:
        return mk_lgl([True])
    if av is None or b is None:
        return mk_lgl([None])
    return mk_lgl([False])


def scalar_lgl(x, op):
    if not isinstance(x, Vec) or len(x.v) != 1:
        if isinstance(x, Vec) and len(x.v) > 1:
            raise RError("'length = %d' in coercion to 'logical(1)'" % len(x.v))
        raise RError("invalid 'x' type in 'x %s y'" % op)
    if x.type == "character":
        raise RError("invalid 'x' type in 'x %s y'" % op)
    return coerce_elt(x.v[0], x.type, "logical")


@builtin("missing", special=True)
def _missing(call, env):
    nm = call.args[0][1].name
    fr = FRAMES.get(id(env))
    v = env.vars.get(nm)
    return mk_lgl([bool(fr and nm in fr.missing) or v is MISSING_ARG])


@builtin("substitute", special=True)
def _substitute(call, env):
    node = call.args[0][1]
    return lang_value(subst(node, env))


def subst(node, env):
    if isinstance(node, Sym):
        if env is GLOBAL:
            return node
        v = env.vars.get(node.name)
        if isinstance(v, Promise):
            return v.expr if not v.forced or v.env is not None else (v.expr if v.expr is not None else Const(v.value))
        if v is not None and v is not MISSING_ARG and not isinstance(v, (Closure, Builtin)) and env is not GLOBAL:
            if isinstance(v, (Vec, RList)):
                return Const(v)
        return node
    if isinstance(node, Call):
        args = []
        for n, a in node.args:
            if isinstance(a, Sym) and a.name == "..." and "..." in env.vars:
                for dn, p in env.vars["..."]:
                    args.append((dn, p.expr if isinstance(p, Promise) else Const(p)))
            elif a is MISSING:
                args.append((n, a))
            else:
                args.append((n, subst(a, env)))
        return Call(subst(node.fn, env), args)
    return node


@builtin("~", special=True)
def _tilde(call, env):
    f = Call(Sym("~"), list(call.args))
    f.attrs = {"class": mk_chr(["formula"]), ".Environment": env}
    STATE["visible"] = True
    return f


@builtin("switch", special=True)
def _switch(call, env):
    e = force(ev(call.args[0][1], env))
    alts = call.args[1:]
    if isinstance(e, Vec) and e.type == "character":
        key = e.v[0]
        for i, (n, a) in enumerate(alts):
            if n == key:
                j = i
                while alts[j][1] is MISSING:
                    j += 1
                return force(ev(alts[j][1], env))
        for n, a in alts:
            if n is None:
                return force(ev(a, env))
        STATE["visible"] = False
        return NULL
    k = int1(e)
    if 1 <= k <= len(alts):
        return force(ev(alts[k - 1][1], env))
    STATE["visible"] = False
    return NULL


@builtin("UseMethod", special=True)
def _usemethod(call, env):
    generic = str1(force(ev(call.args[0][1], env)))
    fenv, fr = frame_of(env)
    if len(call.args) > 1:
        obj = force(ev(call.args[1][1], env))
    else:
        first = fr.fun.formals[0][0]
        obj = lookup(first, fenv) if first != "..." else force(fenv.vars["..."][0][1])
    for cls in classes(obj) + ["default"]:
        f = S3_lookup(generic, cls, fr.callenv)
        if f is not None:
            args = [(n, v) for n, v in fr.args]
            if isinstance(f, Builtin):
                args = [(n, force(v)) for n, v in args]
            raise ReturnEx(call_fun(f, args, fr.callenv, fr.call))
    raise RError("no applicable method for '%s' applied to an object of class \"%s\"" % (generic, classes(obj)[0]))


@builtin("invisible")
def _invisible(args, env):
    v = args[0][1] if args else NULL
    STATE["visible"] = False
    return v


@builtin("sys.call|match.call", special=True)
def _syscall(call, env):
    fenv, fr = frame_of(env)
    if fr is None:
        return NULL
    if call.fn.name == "match.call":
        return matched_call(fr)
    return fr.call


def matched_call(fr):
    names = [n for n, _ in fr.fun.formals]
    exprs = []
    for n, a in fr.call.args:
        exprs.append((n, a))
    m = match_formals(names, exprs)
    args = []
    for n in names:
        if n == "...":
            args.extend(m.get("...", []))
        elif n in m:
            args.append((n, m[n]))
    return Call(fr.call.fn, args)


@builtin("tryCatch", special=True)
def _trycatch(call, env):
    expr = None
    handlers = {}
    fin = None
    for n, a in call.args:
        if n is None and expr is None:
            expr = a
        elif n == "finally":
            fin = a
        elif n == "expr":
            expr = a
        else:
            handlers[n] = a
    try:
        try:
            return force(ev(expr, env))
        except RError as e:
            h = handlers.get("error")
            if h is None:
                raise
            cond = make_condition(e.msg, e.call, "error")
            return call_fun(force(ev(h, env)), [(None, cond)], env)
    finally:
        if fin is not None:
            ev(fin, env)


def make_condition(msg, call, kind):
    return RList([mk_chr([msg]), call if call is not None else NULL],
                 {"names": mk_chr(["message", "call"]), "class": mk_chr(["simpleError", "error", "condition"]) if kind == "error" else mk_chr(["simpleWarning", "warning", "condition"])})


# ---------------------------------------------------------------- top level

def new_global():
    global GLOBAL
    GLOBAL = Env(BASE)
    return GLOBAL


def call_label(call):
    try:
        return deparse(call)
    except Exception:
        return None


def run(src, out=None):
    """Evaluate an R program the way Rscript does: auto-print visible values."""
    import _rill_fmt  # noqa
    env = GLOBAL or new_global()
    w = out or sys.stdout
    try:
        exprs = parse(src)
    except RError as e:
        sys.stderr.write("Error: %s\n" % e.msg)
        return 1
    for e in exprs:
        del WARNINGS[:]
        try:
            STATE["visible"] = True
            v = force(ev(e, env))
            if STATE["visible"]:
                print_value(v, env)
        except RError as err:
            flush_warnings()
            sys.stdout.flush()
            if err.call is not None:
                sys.stderr.write("Error in %s : %s\n" % (err.call, err.msg))
            else:
                sys.stderr.write("Error: %s\n" % err.msg)
            sys.stderr.write("Execution halted\n")
            return 1
        except (BreakEx, NextEx):
            sys.stderr.write("Error: no loop for break/next, jumping to top level\nExecution halted\n")
            return 1
        except ReturnEx as r:
            pass
        flush_warnings()
    return 0


def flush_warnings():
    if WARNINGS:
        sys.stdout.flush()
        if len(WARNINGS) == 1:
            msg, call = WARNINGS[0]
            if call:
                sys.stderr.write("Warning message:\nIn %s : %s\n" % (call, msg))
            else:
                sys.stderr.write("Warning message:\n%s \n" % msg)
        else:
            sys.stderr.write("Warning messages:\n")
            for i, (msg, call) in enumerate(WARNINGS):
                sys.stderr.write("%d: %s\n" % (i + 1, msg if not call else "In %s : %s" % (call, msg)))
        del WARNINGS[:]


def print_value(v, env):
    import _rill_fmt
    _rill_fmt.print_generic(v, env)


def deparse(node, prec=0):
    import _rill_fmt
    return _rill_fmt.deparse(node)


import _rill_fmt  # noqa: E402  (registers print/format builtins)
import _rill_base  # noqa: E402
import _rill_stats  # noqa: E402
