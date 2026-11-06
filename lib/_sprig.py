"""Sprig: a bracket-notation symbolic language mode (feasibility spike).

The language is parsed into expression trees (Expr: a head and arguments;
atoms are int, Fraction, float, str and Sym), evaluated by rewriting until
nothing changes, and its mathematics is done by Sage's symbolic layer
(lib/_sage_expr.py): a tree is converted to a symbolic expression (to_sr),
operated on, and converted back (from_sr).  This is a spike: the behaviour
is checked against Mathics3 run as a black box, never against its source.
"""

import re
from fractions import Fraction

import sage_all as S
from sage.symbolic.expression import Expression as SRExpr


# --- expressions

class Sym:
    __slots__ = ("name",)
    _table = {}

    def __new__(cls, name):
        s = cls._table.get(name)
        if s is None:
            s = object.__new__(cls)
            s.name = name
            cls._table[name] = s
        return s

    def __repr__(self):
        return self.name


class Expr:
    __slots__ = ("head", "args", "_h", "_paren")

    def __init__(self, head, *args):
        self.head = Sym(head) if isinstance(head, str) else head
        self.args = tuple(args)
        self._h = None
        self._paren = False

    def __eq__(self, o):
        return isinstance(o, Expr) and self.head == o.head and len(self.args) == len(o.args) and all(same(a, b) for a, b in zip(self.args, o.args))

    def __hash__(self):
        if self._h is None:
            self._h = hash((self.head, self.args))
        return self._h

    def __repr__(self):
        return form(self)

    def is_(self, name):
        return self.head is Sym(name)


class Graphic:
    """A Sage graphics object, shown as -Graphics- or -Graphics3D-."""

    def __init__(self, g, kind):
        self.g, self.kind = g, kind


def same(a, b):
    if type(a) is not type(b):
        return False
    if isinstance(a, float):
        return a == b
    return a is b or a == b


def H(e):
    """The head of e, as a name."""
    if isinstance(e, Expr):
        return e.head.name if isinstance(e.head, Sym) else None
    if isinstance(e, bool):
        return "Symbol"
    if isinstance(e, int):
        return "Integer"
    if isinstance(e, Fraction):
        return "Rational"
    if isinstance(e, float):
        return "Real"
    if isinstance(e, str):
        return "String"
    if isinstance(e, Sym):
        return "Symbol"
    if isinstance(e, Graphic):
        return e.kind
    return "Real"


def L(*items):
    return Expr("List", *items)


TRUE, FALSE, NULL = Sym("True"), Sym("False"), Sym("Null")


def num(v):
    if isinstance(v, Fraction) and v.denominator == 1:
        return int(v.numerator)
    return v


# --- parsing

class SprigSyntaxError(Exception):
    def __init__(self, msg, pos):
        Exception.__init__(self, msg)
        self.pos = pos


_TOKEN = re.compile(r"""
  (?P<ws>[ \t\r]+|\(\*(?:.|\n)*?\*\))
 |(?P<nl>\n)
 |(?P<num>(?:\d+\.?\d*|\.\d+)(?:`\d*\.?\d*)?(?:\*\^-?\d+)?)
 |(?P<str>"(?:[^"\\]|\\.)*")
 |(?P<pat>(?:[A-Za-z$][A-Za-z0-9$]*)?_{1,3}(?:\.|[A-Za-z$][A-Za-z0-9$]*)?)
 |(?P<sym>[A-Za-z$][A-Za-z0-9$]*)
 |(?P<slot>\#\#?\d*)
 |(?P<out>%+\d*)
 |(?P<op>===|=!=|//\.|@@@|\^:=|:=|:>|->|/\.|//|/@|@@|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|/=|<>|/;|;;|[-+*/^=<>!.,;()\[\]{}&@?|'~:])
""", re.X)


def tokenize(src):
    out, pos, depth = [], 0, 0
    while pos < len(src):
        m = _TOKEN.match(src, pos)
        if m is None:
            raise SprigSyntaxError("unexpected character %r" % src[pos], pos)
        k = m.lastgroup
        v = m.group()
        if k == "op" and v in "([{":
            depth += 1
        elif k == "op" and v in ")]}":
            depth -= 1
        if k == "nl":
            if depth <= 0:
                out.append(("nl", v, pos))
        elif k != "ws":
            out.append((k, v, pos))
        pos = m.end()
    out.append(("eof", "", pos))
    return out


# binding powers (left, as an infix or postfix operator)
_INFIX = {
    ";": 10, "=": 40, ":=": 40, "+=": 40, "-=": 40, "*=": 40, "/=": 40, "//": 70, "&": 90,
    "/.": 110, "//.": 110, "->": 120, ":>": 120, "/;": 130, "|": 160, ":": 150,
    "||": 215, "&&": 220, "==": 290, "!=": 290, "<": 290, ">": 290, "<=": 290, ">=": 290,
    "===": 290, "=!=": 290, "<>": 300, "+": 310, "-": 310, "*": 400, "/": 470, ".": 490,
    "^": 590, "!": 610, "/@": 620, "@@": 620, "@@@": 620, "@": 640, "++": 660, "--": 660,
    "'": 670, "?": 680, "[": 1000,
}
_RIGHT = {"=", ":=", "->", ":>", "^", "/@", "@@", "@@@", "@"}
_REL = {"==": "Equal", "!=": "Unequal", "<": "Less", ">": "Greater", "<=": "LessEqual", ">=": "GreaterEqual", "===": "SameQ", "=!=": "UnsameQ"}
_IMPLICIT = 400
_STARTS = {"num", "str", "pat", "sym", "slot", "out"}


def _pattern(v):
    m = re.match(r"([A-Za-z$][A-Za-z0-9$]*)?(_{1,3})(\.|[A-Za-z$][A-Za-z0-9$]*)?$", v)
    name, blanks, h = m.groups()
    b = Expr(("Blank", "BlankSequence", "BlankNullSequence")[len(blanks) - 1], *([Sym(h)] if h and h != "." else []))
    if h == ".":
        b = Expr("Optional", b)
    return Expr("Pattern", Sym(name), b) if name else b


def _number(v):
    v = v.split("`")[0]
    mant, _, ex = v.partition("*^")
    if "." in mant:
        f = float(mant) * (10.0 ** int(ex) if ex else 1.0)
        return f
    n = int(mant)
    if ex:
        n = n * Fraction(10) ** int(ex)
    return num(n)


class Parser:
    def __init__(self, src):
        self.src = src
        self.toks = tokenize(src)
        self.i = 0

    def peek(self):
        return self.toks[self.i]

    def next(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect(self, v):
        t = self.next()
        if t[1] != v or t[0] not in ("op",):
            raise SprigSyntaxError("expected %r, found %r" % (v, t[1] or "end of input"), t[2])
        return t

    def skip_nl(self):
        while self.peek()[0] == "nl":
            self.i += 1

    def statements(self):
        """The top-level expressions of a cell, one per line (a line ending
        in ; gives a CompoundExpression ending in Null, so no output)."""
        out = []
        while True:
            self.skip_nl()
            if self.peek()[0] == "eof":
                return out
            out.append(self.expr(0, toplevel=True))
            t = self.peek()
            if t[0] not in ("nl", "eof"):
                raise SprigSyntaxError("unexpected %r" % t[1], t[2])

    def expr(self, rbp, toplevel=False):
        left = self.nud(self.next())
        while True:
            t = self.peek()
            k, v = t[0], t[1]
            if k == "nl" or k == "eof":
                return left
            if k == "op" and v in _INFIX:
                lbp = _INFIX[v]
            elif k in _STARTS or (k == "op" and v in "({"):
                lbp = _IMPLICIT
                if lbp <= rbp:
                    return left
                left = self.flat("Times", left, self.expr(_IMPLICIT))
                continue
            else:
                return left
            if lbp <= rbp:
                return left
            self.next()
            left = self.led(t, left, lbp)

    def flat(self, head, a, b):
        args = []
        for x in (a, b):
            if isinstance(x, Expr) and x.is_(head) and not x._paren:
                args.extend(x.args)
            else:
                args.append(x)
        return Expr(head, *args)

    def nud(self, t):
        k, v, pos = t
        if k == "num":
            return _number(v)
        if k == "str":
            return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), v[1:-1])
        if k == "sym":
            return Sym(v)
        if k == "pat":
            return _pattern(v)
        if k == "slot":
            if v.startswith("##"):
                return Expr("SlotSequence", int(v[2:] or 1))
            return Expr("Slot", int(v[1:] or 1))
        if k == "out":
            return Expr("Out", -len(v)) if v.count("%") == len(v) else Expr("Out", int(v[1:]))
        if k == "op":
            if v == "(":
                self.skip_nl()
                e = self.expr(0)
                self.skip_nl()
                self.expect(")")
                if isinstance(e, Expr):
                    e = Expr(e.head, *e.args)
                    e._paren = True
                return e
            if v == "{":
                return Expr("List", *self.seq("}"))
            if v == "-":
                e = self.expr(480)
                if isinstance(e, (int, Fraction, float)):
                    return -e
                return self.flat("Times", -1, e)
            if v == "+":
                return self.expr(480)
            if v == "!":
                return Expr("Not", self.expr(230))
            if v == "++" or v == "--":
                return Expr("PreIncrement" if v == "++" else "PreDecrement", self.expr(660))
        raise SprigSyntaxError("unexpected %r" % (v or "end of input"), pos)

    def seq(self, close):
        args = []
        self.skip_nl()
        if self.peek()[1] == close:
            self.next()
            return args
        while True:
            self.skip_nl()
            args.append(self.expr(0))
            self.skip_nl()
            t = self.next()
            if t[1] == close:
                return args
            if t[1] != ",":
                raise SprigSyntaxError("expected ',' or %r, found %r" % (close, t[1] or "end of input"), t[2])

    def led(self, t, left, lbp):
        v = t[1]
        if v == "[":
            if self.peek()[1] == "[" and self.peek()[2] == t[2] + 1:
                self.next()
                args = self.seq("]")
                self.expect("]")
                return Expr("Part", left, *args)
            return Expr(left, *self.seq("]"))
        if v == "!":
            return Expr("Factorial", left)
        if v == "'":
            n = 1
            while self.peek()[1] == "'":
                self.next()
                n += 1
            return Expr(Expr("Derivative", n), left)
        if v == "&":
            return Expr("Function", left)
        if v == "++" or v == "--":
            return Expr("Increment" if v == "++" else "Decrement", left)
        if v == ";":
            nt = self.peek()
            if nt[0] in ("nl", "eof") or nt[1] in (")", "]", "}", ","):
                return self.flat("CompoundExpression", left, NULL)
            return self.flat("CompoundExpression", left, self.expr(lbp))
        rbp = lbp - 1 if v in _RIGHT else lbp
        self.skip_nl()
        right = self.expr(rbp)
        if v == "+":
            return self.flat("Plus", left, right)
        if v == "-":
            r = -right if isinstance(right, (int, Fraction, float)) else self.flat("Times", -1, right)
            return self.flat("Plus", left, r)
        if v == "*":
            return self.flat("Times", left, right)
        if v == "/":
            return self.flat("Times", left, Expr("Power", right, -1))
        if v == "^":
            return Expr("Power", left, right)
        if v == ".":
            return self.flat("Dot", left, right)
        if v in _REL:
            h = _REL[v]
            if isinstance(left, Expr) and left.is_(h) and not left._paren:
                return Expr(h, *(left.args + (right,)))
            return Expr(h, left, right)
        simple = {"=": "Set", ":=": "SetDelayed", "->": "Rule", ":>": "RuleDelayed", "/.": "ReplaceAll",
                  "//.": "ReplaceRepeated", "/;": "Condition", "/@": "Map", "@@": "Apply", "&&": "And",
                  "||": "Or", "|": "Alternatives", "<>": "StringJoin", "?": "PatternTest",
                  "+=": "AddTo", "-=": "SubtractFrom", "*=": "TimesBy", "/=": "DivideBy"}
        if v in ("&&", "||", "|", "<>"):
            return self.flat(simple[v], left, right)
        if v in simple:
            return Expr(simple[v], left, right)
        if v == "@@@":
            return Expr("Apply", left, right, L(1))
        if v == "@":
            return Expr(left, right)
        if v == "//":
            return Expr(right, left)
        if v == ":":
            return Expr("Pattern", left, right) if isinstance(left, Sym) else Expr("Optional", left, right)
        raise SprigSyntaxError("operator %r is not supported" % v, t[2])


def parse(src):
    """The top-level expressions of src."""
    return Parser(src).statements()


def is_incomplete(src):
    """Whether more lines are needed (an open bracket, string or comment)."""
    try:
        parse(src)
    except SprigSyntaxError as e:
        return e.pos >= len(src.rstrip())
    return False


# --- symbolic conversion

class NotSR(Exception):
    pass


_CONST_TO = {"Pi": "pi", "E": "e", "EulerGamma": "euler_gamma", "Infinity": "oo", "Degree": None}
# a name of the language -> a Sage function (one argument unless noted)
_FUNS = {
    "Sin": "sin", "Cos": "cos", "Tan": "tan", "Cot": "cot", "Sec": "sec", "Csc": "csc",
    "ArcSin": "arcsin", "ArcCos": "arccos", "ArcTan": "arctan", "ArcCot": "arccot",
    "Sinh": "sinh", "Cosh": "cosh", "Tanh": "tanh", "ArcSinh": "arcsinh", "ArcCosh": "arccosh", "ArcTanh": "arctanh",
    "Exp": "exp", "Log": "log", "Sqrt": "sqrt", "Abs": "abs", "Floor": "floor", "Ceiling": "ceil",
    "Gamma": "gamma", "Erf": "erf", "Factorial": "factorial", "Binomial": "binomial", "Sign": "sign",
}
_FROM_FUNS = {"sin": "Sin", "cos": "Cos", "tan": "Tan", "cot": "Cot", "sec": "Sec", "csc": "Csc",
              "arcsin": "ArcSin", "arccos": "ArcCos", "arctan": "ArcTan", "arccot": "ArcCot",
              "sinh": "Sinh", "cosh": "Cosh", "tanh": "Tanh", "arcsinh": "ArcSinh", "arccosh": "ArcCosh",
              "arctanh": "ArcTanh", "log": "Log", "abs": "Abs", "floor": "Floor", "ceil": "Ceiling",
              "gamma": "Gamma", "erf": "Erf", "factorial": "Factorial", "sign": "Sign", "exp": "Exp"}
_RELS = {"Equal": "__eq__", "Unequal": "__ne__", "Less": "__lt__", "Greater": "__gt__", "LessEqual": "__le__", "GreaterEqual": "__ge__"}
_SR_RELS = {"Eq": "Equal", "Ne": "Unequal", "Lt": "Less", "Gt": "Greater", "Le": "LessEqual", "Ge": "GreaterEqual"}

_vars = {}


def sr_var(name):
    v = _vars.get(name)
    if v is None:
        v = _vars[name] = S.var(name.replace("$", "_D_"))
    return v


def _var_name(n):
    return (n[4:] if n.startswith("sbw_") else n).replace("_D_", "$")


def to_sr(e):
    """e as a Sage symbolic expression (NotSR when it is not one)."""
    if isinstance(e, bool):
        raise NotSR(e)
    if isinstance(e, int):
        return S.SR(e)
    if isinstance(e, Fraction):
        return S.SR(e.numerator) / e.denominator
    if isinstance(e, float):
        return S.SR(e)
    if isinstance(e, Sym):
        if e.name in _CONST_TO:
            c = _CONST_TO[e.name]
            if c is None:
                return S.pi / 180
            return getattr(S, c) if c != "oo" else S.SR(S.oo)
        if e.name == "I":
            return S.SR(S.I)
        if e.name in ("True", "False", "Null", "List"):
            raise NotSR(e)
        return sr_var(e.name)
    if isinstance(e, SRExpr):
        return e
    if type(e).__name__ == "RealNumberMP":
        return S.SR(float(e))
    if not isinstance(e, Expr):
        try:
            return S.SR(e)
        except Exception:
            raise NotSR(e)
    h = e.head
    if isinstance(h, Sym):
        n = h.name
        if n == "Plus":
            r = S.SR(0)
            for a in e.args:
                r = r + to_sr(a)
            return r
        if n == "Times":
            r = S.SR(1)
            for a in e.args:
                r = r * to_sr(a)
            return r
        if n == "Power" and len(e.args) == 2:
            return to_sr(e.args[0]) ** to_sr(e.args[1])
        if n == "Complex":
            return to_sr(e.args[0]) + S.I * to_sr(e.args[1])
        if n == "Rational":
            return to_sr(e.args[0]) / to_sr(e.args[1])
        if n in _RELS and len(e.args) == 2:
            return getattr(to_sr(e.args[0]), _RELS[n])(to_sr(e.args[1]))
        if n == "Log" and len(e.args) == 2:
            return S.log(to_sr(e.args[1])) / S.log(to_sr(e.args[0]))
        if n == "ArcTan" and len(e.args) == 2:
            return S.arctan2(to_sr(e.args[1]), to_sr(e.args[0]))
        if n in _FUNS:
            return _sage_fn(_FUNS[n])(*[to_sr(a) for a in e.args])
        if n in BUILTINS or n in ("List", "Rule", "RuleDelayed", "Graphics", "SeriesData", "Slot", "Function"):
            raise NotSR(e)
        if len(e.args) == 0:
            raise NotSR(e)
        return S.function("sbw_" + n)(*[to_sr(a) for a in e.args])
    if isinstance(h, Expr) and isinstance(h.head, Expr) and h.head.is_("Derivative"):
        # Derivative[n][f][args]: f undefined, so the derivative of f as a symbolic function
        ns, f = h.head.args, h.args[0]
        if isinstance(f, Sym) and f.name not in BUILTINS:
            xs = [to_sr(a) for a in e.args]
            tmp = [sr_var("sbwArg%d" % i) for i in range(len(xs))]
            g = S.function("sbw_" + f.name)(*tmp)
            for i, k in enumerate(ns):
                for _ in range(int(k)):
                    g = S.diff(g, tmp[i])
            return g.subs({t: x for t, x in zip(tmp, xs)})
    raise NotSR(e)


def _num_s(s):
    """The number of the engine's encoding n<p>/<q>; ."""
    p, q = s[1:-1].split("/")
    return num(Fraction(int(p), int(q)))


def from_sr(x):
    """A tree for the Sage value x."""
    if isinstance(x, (bool,)):
        return TRUE if x else FALSE
    if isinstance(x, int):
        return x
    if isinstance(x, float):
        return x
    if not isinstance(x, SRExpr):
        t = type(x).__name__
        if t in ("Integer", "int"):
            return int(x)
        if t == "Rational":
            return num(Fraction(str(x)))
        if "Real" in t:
            return x  # an arbitrary-precision real: kept as it is (SR cannot hold one)
        try:
            return from_sr(S.SR(x))
        except Exception:
            return x
    op = x._op()
    tag = op[0]
    s = x._s
    if tag == "rational":
        return _num_s(s)
    if tag == "float":
        return float(x.pyobject())
    if tag == "complex":
        re_s, im_s = s[1:].split(";")[:2]
        re_v, im_v = _num_s("n" + re_s + ";"), _num_s("n" + im_s + ";")
        return Expr("Complex", re_v, im_v) if re_v != 0 or im_v != 1 else Sym("I")
    if tag == "constant":
        return {"cp": Sym("Pi"), "ce": Sym("E"), "cg": Sym("EulerGamma"), "c+": Sym("Infinity"),
                "c-": Expr("Times", -1, Sym("Infinity"))}.get(s, Sym("ComplexInfinity"))
    if tag == "symbol":
        return Sym(_var_name(s.split(":", 1)[1]))
    args = [from_sr(a) for a in x.operands()]
    if tag == "add":
        return Expr("Plus", *args)
    if tag == "mul":
        return Expr("Times", *args)
    if tag == "pow":
        return Expr("Power", *args)
    if tag.startswith("rel:"):
        return Expr(_SR_RELS[tag[4:]], *args)
    if tag.startswith("fun:"):
        name = tag[4:]
        if s.startswith("D"):
            # D<k>:<f><n>,<indices>,<nargs>: the n-th derivative of f
            m = re.match(r"D\d+:(.*?)(\d+),([\d,]*)", s)
            nm, k, rest = m.group(1), int(m.group(2)), m.group(3).split(",")
            idx, nargs = [int(i) for i in rest[:k]], int(rest[k]) if len(rest) > k else len(args)
            counts = [idx.count(i) for i in range(nargs)]
            return Expr(Expr(Expr("Derivative", *counts), Sym(_var_name(nm))), *args)
        if name == "sum" and len(args) == 4:
            return Expr("Sum", args[0], L(*args[1:]))
        if name == "integrate" and len(args) in (2, 4):
            return Expr("Integrate", args[0], args[1] if len(args) == 2 else L(*args[1:]))
        if name == "arctan2":
            return Expr("ArcTan", args[1], args[0])
        if name.startswith("sbw_"):
            return Expr(_var_name(name), *args)
        if name in _FROM_FUNS:
            return Expr(_FROM_FUNS[name], *args)
        return Expr(name[:1].upper() + name[1:], *args)
    return x


# --- evaluation

ATTRS = {
    "Set": {"HoldFirst"}, "SetDelayed": {"HoldAll"}, "RuleDelayed": {"HoldRest"}, "Hold": {"HoldAll"},
    "Table": {"HoldAll"}, "Sum": {"HoldAll"}, "Product": {"HoldAll"}, "Plot": {"HoldAll"}, "Plot3D": {"HoldAll"},
    "ParametricPlot": {"HoldAll"}, "ContourPlot": {"HoldAll"}, "Do": {"HoldAll"}, "If": {"HoldRest"},
    "Function": {"HoldAll"}, "Module": {"HoldAll"}, "Clear": {"HoldAll"}, "Condition": {"HoldAll"},
    "Pattern": {"HoldFirst"}, "CompoundExpression": {"HoldAll"}, "While": {"HoldAll"}, "For": {"HoldAll"},
    "AddTo": {"HoldFirst"}, "SubtractFrom": {"HoldFirst"}, "TimesBy": {"HoldFirst"}, "DivideBy": {"HoldFirst"},
    "Increment": {"HoldFirst"}, "Decrement": {"HoldFirst"}, "PreIncrement": {"HoldFirst"}, "PreDecrement": {"HoldFirst"},
    "And": {"HoldAll"}, "Or": {"HoldAll"}, "FullForm": set(), "HoldForm": {"HoldAll"}, "Timing": {"HoldAll"},
}
FLAT = {"Plus", "Times", "And", "Or", "Dot", "StringJoin"}
LISTABLE = {"Plus", "Times", "Power", "Sqrt", "Exp", "Log", "Abs", "Floor", "Ceiling", "Factorial", "Binomial",
            "Mod", "Prime", "PrimeQ", "N", "Round", "EvenQ", "OddQ", "Gamma", "Erf", "Sign", "Quotient"} | set(_FUNS)

OWN = {}    # symbol -> value (x = 3)
DOWN = {}   # symbol -> [(lhs, rhs, delayed)]
OUT = []    # the session's outputs (%)
MAXSTEPS = 4096


class SprigError(Exception):
    pass


def ev(e, depth=0):
    """The value of e: rewritten until nothing changes."""
    if depth > 256:
        raise SprigError("$RecursionLimit: recursion depth exceeded")
    for _ in range(MAXSTEPS):
        n = ev1(e, depth)
        if n is e or same(n, e):
            return n
        e = n
    raise SprigError("$IterationLimit: iteration limit exceeded")


def ev1(e, depth):
    if isinstance(e, Sym):
        v = OWN.get(e)
        return v if v is not None else e
    if not isinstance(e, Expr):
        return e
    h = ev(e.head, depth + 1)
    name = h.name if isinstance(h, Sym) else None
    attrs = ATTRS.get(name, ())
    args = []
    for i, a in enumerate(e.args):
        hold = "HoldAll" in attrs or ("HoldFirst" in attrs and i == 0) or ("HoldRest" in attrs and i > 0)
        a = a if hold else ev(a, depth + 1)
        if isinstance(a, Expr) and a.is_("Sequence"):
            args.extend(a.args)
        elif name in FLAT and isinstance(a, Expr) and a.head is h:
            args.extend(a.args)
        else:
            args.append(a)
    e = Expr(h, *args)
    if name in LISTABLE and any(isinstance(a, Expr) and a.is_("List") for a in args):
        n = None
        for a in args:
            if isinstance(a, Expr) and a.is_("List"):
                if n is not None and len(a.args) != n:
                    raise SprigError("Thread: objects of unequal length cannot be combined")
                n = len(a.args)
        return L(*[Expr(h, *[a.args[i] if isinstance(a, Expr) and a.is_("List") else a for a in args]) for i in range(n)])
    if isinstance(h, Expr) and h.is_("Function"):
        return apply_function(h, args)
    if isinstance(h, Expr) and isinstance(h.head, Expr) and h.head.is_("Derivative"):
        return derivative_of(h, args, depth)
    if name is not None:
        for lhs, rhs, delayed in DOWN.get(h, ()):
            b = match(lhs, e, {})
            if b is not None:
                return subst(rhs, b) if delayed else rhs
        f = BUILTINS.get(name)
        if f is not None:
            r = f(*args)
            if r is not None:
                return r
    return e


def apply_function(f, args):
    if len(f.args) == 1:
        def slot(x):
            if isinstance(x, Expr):
                if x.is_("Slot") and isinstance(x.args[0], int):
                    return args[x.args[0] - 1]
                if x.is_("Function"):
                    return x
                return Expr(slot(x.head), *[slot(a) for a in x.args])
            return x
        return slot(f.args[0])
    params = f.args[0]
    ps = params.args if isinstance(params, Expr) and params.is_("List") else (params,)
    return subst(f.args[1], dict(zip(ps, args)))


def derivative_of(h, args, depth):
    ns, f = h.head.args, h.args[0]
    if isinstance(f, Sym) and (f in DOWN or f.name in _FUNS):
        tmp = [Sym("sbwSlot%d" % i) for i in range(len(args))]
        g = ev(Expr(f, *tmp), depth + 1)
        for v, k in zip(tmp, ns):
            if k:
                g = ev(Expr("D", g, L(v, k)), depth + 1)
        return subst(g, dict(zip(tmp, args)))
    if isinstance(f, Expr) and f.is_("Function"):
        tmp = [Sym("sbwSlot%d" % i) for i in range(len(args))]
        g = ev(apply_function(f, tmp), depth + 1)
        for v, k in zip(tmp, ns):
            if k:
                g = ev(Expr("D", g, L(v, k)), depth + 1)
        return subst(g, dict(zip(tmp, args)))
    return Expr(h, *args)


def subst(e, b):
    """e with the pattern variables of b replaced by their values."""
    if isinstance(e, Sym):
        return b.get(e, e)
    if isinstance(e, Expr):
        if e.is_("Pattern") and e.args[0] in b:
            return b[e.args[0]]
        return Expr(subst(e.head, b), *[subst(a, b) for a in e.args])
    return e


def _blank_ok(p, e):
    return not p.args or H(e) == p.args[0].name


def match(p, e, b):
    """The bindings that make the pattern p match e (None if none)."""
    if isinstance(p, Expr):
        if p.is_("Pattern"):
            name = p.args[0]
            if name in b:
                return b if same(b[name], e) else None
            r = match(p.args[1], e, b)
            if r is None:
                return None
            r = dict(r)
            r[name] = e
            return r
        if p.is_("Blank"):
            return b if _blank_ok(p, e) else None
        if p.is_("Optional"):
            return match(p.args[0], e, b)
        if p.is_("Condition"):
            r = match(p.args[0], e, b)
            if r is not None and ev(subst(p.args[1], r)) is TRUE:
                return r
            return None
        if p.is_("PatternTest"):
            r = match(p.args[0], e, b)
            if r is not None and ev(Expr(p.args[1], e)) is TRUE:
                return r
            return None
        if p.is_("Alternatives"):
            for q in p.args:
                r = match(q, e, b)
                if r is not None:
                    return r
            return None
        if not isinstance(e, Expr):
            return None
        b = match(p.head, e.head, b)
        if b is None:
            return None
        return match_seq(list(p.args), list(e.args), b)
    return b if same(p, e) else None


def _seq_pat(p):
    if isinstance(p, Expr) and p.is_("Pattern"):
        q = p.args[1]
        if isinstance(q, Expr) and q.head.name in ("BlankSequence", "BlankNullSequence"):
            return p.args[0], q
    if isinstance(p, Expr) and p.head.name in ("BlankSequence", "BlankNullSequence"):
        return None, p
    return None


def match_seq(ps, es, b):
    if not ps:
        return b if not es else None
    p = ps[0]
    sp = _seq_pat(p)
    if sp is None:
        if not es:
            if isinstance(p, Expr) and (p.is_("Optional") or (p.is_("Pattern") and isinstance(p.args[1], Expr) and p.args[1].is_("Optional"))):
                return match_seq(ps[1:], es, b)
            return None
        r = match(p, es[0], b)
        return None if r is None else match_seq(ps[1:], es[1:], r)
    name, q = sp
    lo = 0 if q.head.name == "BlankNullSequence" else 1
    for k in range(lo, len(es) + 1):
        part = es[:k]
        if q.args and not all(H(x) == q.args[0].name for x in part):
            break
        r = dict(b)
        if name is not None:
            seq = Expr("Sequence", *part)
            if name in r and not same(r[name], seq):
                continue
            r[name] = seq
        r = match_seq(ps[1:], es[k:], r)
        if r is not None:
            return r
    return None


def replace(e, rules):
    """e /. rules: each subexpression replaced by the first rule that matches it."""
    for lhs, rhs, delayed in rules:
        b = match(lhs, e, {})
        if b is not None:
            return subst(rhs, b) if (delayed or b) else rhs
    if isinstance(e, Expr):
        return Expr(replace(e.head, rules), *[replace(a, rules) for a in e.args])
    return e


def rules_of(r):
    if isinstance(r, Expr) and r.head.name in ("Rule", "RuleDelayed"):
        return [(r.args[0], r.args[1], r.is_("RuleDelayed"))]
    if isinstance(r, Expr) and r.is_("List"):
        out = []
        for x in r.args:
            out.extend(rules_of(x))
        return out
    raise SprigError("ReplaceAll: %s is not a valid rule or list of rules" % form(r))


# --- built-in functions

BUILTINS = {}


def builtin(*names):
    def deco(f):
        for n in names:
            BUILTINS[n] = f
        return f
    return deco


def sr_or_none(*xs):
    try:
        return [to_sr(x) for x in xs]
    except NotSR:
        return None


def _arith(op):
    def f(*args):
        xs = sr_or_none(*args)
        if xs is None:
            return None
        return from_sr(op(xs))
    return f


def _fold_add(xs):
    r = xs[0]
    for x in xs[1:]:
        r = r + x
    return r


def _fold_mul(xs):
    r = xs[0]
    for x in xs[1:]:
        r = r * x
    return r


BUILTINS["Plus"] = _arith(_fold_add)
BUILTINS["Times"] = _arith(_fold_mul)
def _power(*a):
    try:
        return _arith(lambda xs: xs[0] ** xs[1])(*a)
    except ZeroDivisionError:
        print("Power::infy: Infinite expression %s encountered." % form(Expr("Power", *a)))
        return Sym("ComplexInfinity")


BUILTINS["Power"] = _power
def _sage_fn(name):
    return {"abs": abs}.get(name) or getattr(S, name)


for _n, _s in _FUNS.items():
    BUILTINS[_n] = (lambda fn: _arith(lambda xs: fn(*xs)))(_sage_fn(_s))


@builtin("Log")
def _log(*a):
    xs = sr_or_none(*a)
    if xs is None:
        return None
    return from_sr(S.log(xs[0]) if len(xs) == 1 else S.log(xs[1]) / S.log(xs[0]))


@builtin("ArcTan")
def _arctan(*a):
    xs = sr_or_none(*a)
    if xs is None:
        return None
    return from_sr(S.arctan(xs[0]) if len(xs) == 1 else S.arctan2(xs[1], xs[0]))


def _boolean(v):
    return TRUE if v else FALSE


def _constant_tree(e):
    """Whether e is a number or a numeric constant (Pi, Sqrt[2] + 1, E^2):
    only those relations are decided (x == y and y[0] == 1 stay)."""
    if _is_num(e):
        return True
    if isinstance(e, Sym):
        return e.name in _CONST_TO or e.name == "I"
    if isinstance(e, Expr) and isinstance(e.head, Sym) and (e.head.name in ("Plus", "Times", "Power", "Complex", "Rational") or e.head.name in _FUNS):
        return all(_constant_tree(a) for a in e.args)
    return False


def rel(name):
    def f(*args):
        if len(args) < 2:
            return TRUE
        if name in ("Equal", "Unequal") and all(isinstance(a, str) or a is TRUE or a is FALSE for a in args):
            eq = all(same(args[0], a) for a in args[1:])
            return _boolean(eq if name == "Equal" else not eq)
        xs = sr_or_none(*args) if all(_constant_tree(a) for a in args) else None
        if xs is None:
            if name in ("Equal", "Unequal") and all(same(args[0], a) for a in args[1:]):
                return _boolean(name == "Equal")
            return None
        if any(x.variables() for x in xs):
            if name in ("Equal", "Unequal") and all(same(args[0], a) for a in args[1:]):
                return _boolean(name == "Equal")
            return None
        out = True
        for a, c in zip(xs, xs[1:]):
            out = out and bool(getattr(a, _RELS[name])(c))
        return _boolean(out)
    return f


for _n in _RELS:
    BUILTINS[_n] = rel(_n)


@builtin("SameQ")
def _sameq(*a):
    return _boolean(all(same(a[0], x) for x in a[1:]))


@builtin("UnsameQ")
def _unsameq(*a):
    return _boolean(not all(same(a[0], x) for x in a[1:]))


@builtin("Not")
def _not(a):
    return FALSE if a is TRUE else TRUE if a is FALSE else None


@builtin("And")
def _and(*a):
    rest = []
    for x in a:
        v = ev(x)
        if v is FALSE:
            return FALSE
        if v is not TRUE:
            rest.append(v)
    return TRUE if not rest else rest[0] if len(rest) == 1 else (Expr("And", *rest) if len(rest) < len(a) else None)


@builtin("Or")
def _or(*a):
    rest = []
    for x in a:
        v = ev(x)
        if v is TRUE:
            return TRUE
        if v is not FALSE:
            rest.append(v)
    return FALSE if not rest else rest[0] if len(rest) == 1 else (Expr("Or", *rest) if len(rest) < len(a) else None)


@builtin("If")
def _if(c, a=NULL, b=NULL, *rest):
    if c is TRUE:
        return ev(a)
    if c is FALSE:
        return ev(b)
    return rest[0] if rest else None


@builtin("CompoundExpression")
def _compound(*a):
    r = NULL
    for x in a:
        r = ev(x)
    return r


def _lhs_symbol(lhs):
    while isinstance(lhs, Expr):
        lhs = lhs.head
    return lhs


def _specificity(lhs):
    """Rules without patterns go first (f[0] before f[n_])."""
    def has_pat(x):
        return isinstance(x, Expr) and (x.head.name in ("Pattern", "Blank", "BlankSequence", "BlankNullSequence") if isinstance(x.head, Sym) else False) or (isinstance(x, Expr) and any(has_pat(a) for a in x.args))
    return 1 if has_pat(lhs) else 0


def define(lhs, rhs, delayed):
    if isinstance(lhs, Sym):
        # (x := rhs keeps rhs unevaluated: it is evaluated at each use)
        OWN[lhs] = rhs
        return
    if isinstance(lhs, Expr) and lhs.is_("Part"):
        raise SprigError("Set: assigning to parts is not supported in the spike")
    s = _lhs_symbol(lhs)
    if not isinstance(s, Sym):
        raise SprigError("Set: cannot assign to %s" % form(lhs))
    if not isinstance(lhs.head, Sym):
        raise SprigError("Set: only f[args] definitions are supported in the spike")
    lhs = Expr(lhs.head, *[ev(a) if not _specificity(a) else a for a in lhs.args])
    rules = [r for r in DOWN.get(s, []) if not same(r[0], lhs)]
    rules.append((lhs, rhs, delayed))
    rules.sort(key=lambda r: _specificity(r[0]))
    DOWN[s] = rules


@builtin("Set")
def _set(lhs, rhs):
    if isinstance(lhs, Expr) and lhs.is_("List") and isinstance(rhs, Expr) and rhs.is_("List"):
        for a, b in zip(lhs.args, rhs.args):
            define(a, b, False)
        return rhs
    define(lhs, rhs, False)
    return rhs


@builtin("SetDelayed")
def _setdelayed(lhs, rhs):
    define(lhs, rhs, True)
    return NULL


@builtin("Clear", "ClearAll")
def _clear(*syms):
    for s in syms:
        if isinstance(s, Sym):
            OWN.pop(s, None)
            DOWN.pop(s, None)
    return NULL


def _update(op):
    def f(x, d=1):
        v = ev(Expr(op, ev(x), ev(d)))
        define(x, v, False)
        return v
    return f


BUILTINS["AddTo"] = _update("Plus")
BUILTINS["Increment"] = lambda x: (lambda old: (_update("Plus")(x), old)[1])(ev(x))
BUILTINS["PreIncrement"] = lambda x: _update("Plus")(x)
BUILTINS["SubtractFrom"] = lambda x, d: _update("Plus")(x, Expr("Times", -1, d))
BUILTINS["TimesBy"] = _update("Times")


@builtin("ReplaceAll")
def _replaceall(e, r):
    if isinstance(r, Expr) and r.is_("List") and r.args and all(isinstance(x, Expr) and x.is_("List") for x in r.args):
        return L(*[replace(e, rules_of(x)) for x in r.args])
    return replace(e, rules_of(r))


@builtin("ReplaceRepeated")
def _replacerepeated(e, r):
    rules = rules_of(r)
    for _ in range(MAXSTEPS):
        n = ev(replace(e, rules))
        if same(n, e):
            return n
        e = n
    raise SprigError("ReplaceRepeated: iteration limit exceeded")


@builtin("Module", "Block", "With")
def _module(vars_, body):
    b = {}
    for v in vars_.args if isinstance(vars_, Expr) else ():
        if isinstance(v, Expr) and v.is_("Set"):
            s = v.args[0]
            new = Sym("%s$%d" % (s.name, len(OWN) + len(DOWN) + id(v) % 9973))
            b[s] = new
            OWN[new] = ev(v.args[1])
        else:
            b[v] = Sym("%s$%d" % (v.name, id(v) % 99991))
    return ev(subst(body, b))


@builtin("Do")
def _do(body, *its):
    for b in iterate(its):
        ev(subst(body, b))
    return NULL


@builtin("While")
def _while(test, body=NULL):
    for _ in range(10 ** 6):
        if ev(test) is not TRUE:
            return NULL
        ev(body)
    raise SprigError("While: too many iterations for the spike")


@builtin("Print")
def _print(*a):
    print("".join(a_ if isinstance(a_, str) else form(a_) for a_ in a))
    return NULL


@builtin("Head")
def _head(e):
    return e.head if isinstance(e, Expr) else Sym(H(e))


@builtin("FullForm")
def _fullform(e):
    return None


@builtin("Hold", "HoldForm")
def _hold(*a):
    return None


@builtin("Out")
def _out(k):
    if not OUT:
        return NULL
    return OUT[k] if k < 0 and -k <= len(OUT) else OUT[k - 1] if 0 < k <= len(OUT) else NULL


# lists

def _iter_values(spec):
    """The values of an iterator {i, a, b, d} (or {n}, {i, n}, {i, {list}})."""
    a = [ev(x) for x in spec.args[1:]] if isinstance(spec, Expr) and spec.is_("List") else [ev(spec)]
    if isinstance(spec, Expr) and spec.is_("List") and len(spec.args) == 1:
        a = [ev(spec.args[0])]
    if len(a) == 1 and isinstance(a[0], Expr) and a[0].is_("List"):
        return list(a[0].args)
    if len(a) == 1:
        lo, hi, d = 1, a[0], 1
    elif len(a) == 2:
        lo, hi, d = a[0], a[1], 1
    else:
        lo, hi, d = a
    n = ev(Expr("Floor", Expr("Times", Expr("Plus", hi, Expr("Times", -1, lo)), Expr("Power", d, -1))))
    if not isinstance(n, int):
        raise SprigError("Table: the range of the iterator %s is not a number" % form(spec))
    return [ev(Expr("Plus", lo, Expr("Times", k, d))) for k in range(n + 1)]


def iterate(specs):
    if not specs:
        yield {}
        return
    spec = specs[0]
    var = spec.args[0] if isinstance(spec, Expr) and spec.is_("List") and len(spec.args) > 1 else None
    for v in _iter_values(spec):
        for b in iterate(specs[1:]):
            r = dict(b)
            if var is not None:
                r[var] = v
            yield r


@builtin("Table")
def _table(body, *specs):
    def rec(i, b):
        if i == len(specs):
            return ev(subst(body, b))
        spec = subst(specs[i], b)
        var = spec.args[0] if isinstance(spec, Expr) and spec.is_("List") and len(spec.args) > 1 else None
        out = []
        for v in _iter_values(spec):
            r = dict(b)
            if var is not None:
                r[var] = v
            out.append(rec(i + 1, r))
        return L(*out)
    return rec(0, {})


@builtin("Range")
def _range(*a):
    if not all(isinstance(x, (int, Fraction, float)) for x in a):
        return None
    return L(*_iter_values(L(Sym("sbwDummy"), *a) if len(a) > 1 else L(*a)))


def _is_list(e):
    return isinstance(e, Expr) and e.is_("List")


@builtin("Length")
def _length(e):
    return len(e.args) if isinstance(e, Expr) else 0


@builtin("Part")
def _part(e, *ix):
    for k in ix:
        if _is_list(k):
            return L(*[_part(e, j) for j in k.args])
        if not isinstance(k, int) or not isinstance(e, Expr):
            return None
        if k == 0:
            e = e.head
            continue
        if abs(k) > len(e.args):
            raise SprigError("Part: part %d of %s does not exist" % (k, form(e)))
        e = e.args[k - 1] if k > 0 else e.args[k]
    return e


BUILTINS["First"] = lambda e: _part(e, 1)
BUILTINS["Last"] = lambda e: _part(e, -1)
BUILTINS["Rest"] = lambda e: Expr(e.head, *e.args[1:]) if isinstance(e, Expr) else None
BUILTINS["Most"] = lambda e: Expr(e.head, *e.args[:-1]) if isinstance(e, Expr) else None
BUILTINS["Reverse"] = lambda e: Expr(e.head, *reversed(e.args)) if isinstance(e, Expr) else None
BUILTINS["Append"] = lambda e, x: Expr(e.head, *(e.args + (x,))) if isinstance(e, Expr) else None
BUILTINS["Prepend"] = lambda e, x: Expr(e.head, x, *e.args) if isinstance(e, Expr) else None
BUILTINS["Join"] = lambda *ls: L(*[a for l in ls for a in l.args]) if all(_is_list(l) for l in ls) else None
BUILTINS["Total"] = lambda e: Expr("Plus", *e.args) if _is_list(e) else None
BUILTINS["Map"] = lambda f, e: Expr(e.head, *[Expr(f, a) for a in e.args]) if isinstance(e, Expr) else e
BUILTINS["Select"] = lambda e, f: L(*[a for a in e.args if ev(Expr(f, a)) is TRUE]) if _is_list(e) else None
BUILTINS["Sort"] = lambda e: L(*sorted(e.args, key=order_key)) if _is_list(e) else None


@builtin("Apply")
def _apply(f, e, lev=None):
    if not isinstance(e, Expr):
        return e
    if lev is not None:
        return Expr(e.head, *[Expr(f, *a.args) if isinstance(a, Expr) else a for a in e.args])
    return Expr(f, *e.args)


@builtin("Flatten")
def _flatten(e):
    if not _is_list(e):
        return None
    out = []
    for a in e.args:
        if _is_list(a):
            out.extend(_flatten(a).args)
        else:
            out.append(a)
    return L(*out)


@builtin("Dimensions")
def _dims(e):
    d = []
    while _is_list(e):
        d.append(len(e.args))
        if not e.args:
            break
        e = e.args[0]
    return L(*d)


@builtin("Count")
def _count(e, p):
    return sum(1 for a in e.args if match(p, a, {}) is not None) if isinstance(e, Expr) else 0


# calculus and algebra (Sage's symbolic layer)

def _bound(e):
    """A limit of integration or summation: Sage's oo for Infinity."""
    if e is Sym("Infinity"):
        return S.oo
    if isinstance(e, Expr) and e.is_("Times") and e.args == (-1, Sym("Infinity")):
        return -S.oo
    return _sr1(e)


def _sr1(e):
    x = sr_or_none(e)
    if x is None:
        raise SprigError("%s is not an expression Sprig can do algebra on" % form(e))
    return x[0]


def _over_lists(f):
    """f threaded over a list first argument (lists of equations, matrices)."""
    def g(e, *rest):
        if _is_list(e):
            return L(*[g(a, *rest) for a in e.args])
        return f(e, *rest)
    return g


@builtin("D")
@_over_lists
def _d(f, *specs):
    r = _sr1(f)
    for s in specs:
        if _is_list(s):
            if len(s.args) != 2 or not isinstance(s.args[1], int):
                return None
            r = S.diff(r, _sr1(s.args[0]), s.args[1])
        else:
            r = S.diff(r, _sr1(s))
    return from_sr(r)


@builtin("Integrate")
@_over_lists
def _integrate(f, *specs):
    r = _sr1(f)
    for s in reversed(specs):
        if _is_list(s):
            x, a, b = _sr1(s.args[0]), _bound(s.args[1]), _bound(s.args[2])
            r = S.integrate(r, x, a, b)
        else:
            r = S.integrate(r, _sr1(s))
    return from_sr(r)


@builtin("NIntegrate")
def _nintegrate(f, s):
    x, a, b = (_sr1(t) for t in s.args)
    g = _sr1(f)
    return float(S.numerical_integral(g, a, b)[0]) if not g.variables() or g.variables() == (x,) else None


def _options(rest):
    out = {}
    for r in rest:
        if isinstance(r, Expr) and r.is_("Rule") and isinstance(r.args[0], Sym):
            out[r.args[0].name] = r.args[1]
    return out


@builtin("Limit")
@_over_lists
def _limit(f, r, *rest):
    if not (isinstance(r, Expr) and r.is_("Rule")):
        return None
    opts = _options(rest)
    d = opts.get("Direction")
    kw = {}
    if d is not None:
        d = form(d).strip('"')
        if d in ("FromAbove", "-1"):
            kw["dir"] = "+"
        elif d in ("FromBelow", "1"):
            kw["dir"] = "-"
    x, a = _sr1(r.args[0]), _bound(r.args[1])
    return from_sr(S.limit(_sr1(f), **dict({str(x): a}, **kw)))


@builtin("Series")
def _series(f, spec):
    x, a, n = spec.args
    if not isinstance(n, int):
        return None
    X, A = _sr1(x), _sr1(a)
    t = sr_var("sbwSeriesT")
    g = _sr1(f).subs({X: t + A})
    p = S.taylor(g, t, 0, n)
    coeffs = [from_sr(p.coefficient(t, k) if k else p.subs({t: 0})) for k in range(n + 1)]
    lo = 0
    while lo < len(coeffs) and coeffs[lo] == 0:
        lo += 1
    if lo == len(coeffs):
        return Expr("SeriesData", x, a, L(), n + 1, n + 1, 1)
    hi = len(coeffs)
    while coeffs[hi - 1] == 0:
        hi -= 1
    return Expr("SeriesData", x, a, L(*coeffs[lo:hi]), lo, n + 1, 1)


@builtin("Normal")
def _normal(e):
    if isinstance(e, Expr) and e.is_("SeriesData"):
        x, a, cs, lo = e.args[0], e.args[1], e.args[2].args, e.args[3]
        base = x if a == 0 else Expr("Plus", x, Expr("Times", -1, a))
        return Expr("Plus", *[Expr("Times", c, Expr("Power", base, lo + k)) for k, c in enumerate(cs)])
    return e


def _sum_like(prod):
    def g(f, *specs):
        r = f
        for s in reversed(specs):
            s = ev(s) if not _is_list(s) else L(s.args[0], *[ev(a) for a in s.args[1:]])
            bounds = s.args[1:]
            if all(isinstance(b, int) for b in bounds) or (len(s.args) == 2 and _is_list(s.args[1])):
                terms = [subst(r, b) for b in iterate((s,))]
                r = Expr("Times" if prod else "Plus", *terms) if terms else (1 if prod else 0)
            elif not prod and len(bounds) == 2:
                r = from_sr(S.sum(_sr1(ev(r)), _sr1(s.args[0]), _bound(bounds[0]), _bound(bounds[1])))
                if isinstance(r, Expr) and r.is_("Sum"):
                    return None  # (Sage left it unevaluated: so does Sprig)
            else:
                return None
            r = ev(r)
        return r
    return g


BUILTINS["Sum"] = _sum_like(False)
BUILTINS["Product"] = _sum_like(True)


def _eqs(e):
    xs = e.args if _is_list(e) else (e,)
    out = []
    for x in xs:
        if isinstance(x, Expr) and x.is_("And"):
            out.extend(_eqs(L(*x.args)))
        else:
            out.append(_sr1(x))
    return out


def _vars_of(v, eqs):
    if v is None:
        names = sorted({n for q in eqs for n in q.variables()}, key=str)
        return list(names)
    return [_sr1(a) for a in (v.args if _is_list(v) else (v,))]


@builtin("Solve")
def _solve(e, v=None, *rest):
    eqs = _eqs(e)
    xs = _vars_of(v, eqs)
    sols = S.solve(eqs, *xs, solution_dict=True)
    known = {str(n) for q in eqs for n in q.variables()}
    sols = [d for d in sols if all(str(n) in known for v in d.values() for n in S.SR(v).variables())]
    sols.sort(key=_root_key)
    out = []
    for s in sols:
        out.append(L(*[Expr("Rule", from_sr(k), from_sr(val)) for k, val in sorted(s.items(), key=lambda kv: str(kv[0]))]))
    return L(*out)


def _root_key(d):
    try:
        cs = [complex(S.SR(v).n()) for _, v in sorted(d.items(), key=lambda kv: str(kv[0]))]
        return [(abs(c.imag) > 1e-12, c.real, c.imag) for c in cs]
    except Exception:
        return []


@builtin("NSolve")
def _nsolve(e, v=None, *rest):
    s = _solve(e, v)
    return ev(Expr("N", s))


@builtin("FindRoot")
def _findroot(f, spec):
    x, x0 = spec.args[0], ev(spec.args[1])
    g = _sr1(f)
    if g.is_relational():
        g = g.lhs() - g.rhs()
    X = _sr1(x)
    dg = S.diff(g, X)
    t = float(_sr1(x0).n())
    for _ in range(100):
        fv = float(g.subs({X: t}).n())
        dv = float(dg.subs({X: t}).n())
        if dv == 0:
            break
        step = fv / dv
        t -= step
        if abs(step) <= 1e-15 * max(1.0, abs(t)):
            break
    return L(Expr("Rule", x, t))


@builtin("DSolve")
def _dsolve(eq, y, x):
    if not (isinstance(y, Expr) and isinstance(y.head, Sym)):
        return None
    ics = None
    if _is_list(eq):
        # {ode, y[x0] == y0, y'[x0] == y1}: Sage's ics [x0, y0, y1]
        ode, conds = eq.args[0], eq.args[1:]
        vals = {}
        for c in conds:
            l, r = c.args
            k = 1 if isinstance(l.head, Expr) else 0
            vals[k] = (l.args[0], r)
        x0 = vals[0][0]
        ics = [_sr1(x0)] + [_sr1(vals[k][1]) for k in sorted(vals)]
        eq = ode
    e = _sr1(eq)
    yx = _sr1(y)
    sol = S.desolve(e, yx, ivar=_sr1(x), ics=ics) if ics else S.desolve(e, yx, ivar=_sr1(x))
    r = from_sr(sol)
    r = replace(r, [(Sym("_C"), Expr("C", 1), False), (Sym("_K1"), Expr("C", 1), False), (Sym("_K2"), Expr("C", 2), False)])
    return L(L(Expr("Rule", y, r)))


def _alg(method, *args):
    def f(e, *rest):
        if _is_list(e):
            return L(*[f(a) for a in e.args])
        x = sr_or_none(e)
        if x is None:
            return None
        r = getattr(x[0], method)(*args)
        return from_sr(r)
    return f


@builtin("Simplify", "FullSimplify")
def _simplify(e, *rest):
    if _is_list(e):
        return L(*[_simplify(a) for a in e.args])
    x = sr_or_none(e)
    if x is None:
        return None
    x = x[0]
    if x.is_relational():
        d = (x.lhs() - x.rhs()).simplify_full()
        return TRUE if d == 0 else from_sr(x.lhs().simplify_full() == x.rhs().simplify_full())
    r = x.simplify_full()
    try:
        t = r.simplify_trig()
        if len(str(t)) < len(str(r)):
            r = t
    except Exception:
        pass
    return from_sr(r)


BUILTINS["Expand"] = _alg("expand")
BUILTINS["ExpandAll"] = _alg("expand")
BUILTINS["Factor"] = _alg("factor")
BUILTINS["Together"] = _alg("simplify_rational")
BUILTINS["Cancel"] = _alg("simplify_rational")
BUILTINS["TrigExpand"] = _alg("expand_trig")
BUILTINS["TrigReduce"] = _alg("reduce_trig")


@builtin("Collect")
def _collect(e, x):
    return from_sr(_sr1(e).expand().collect(_sr1(x)))


@builtin("Nest")
def _nest(f, x, n):
    for _ in range(n):
        x = ev(Expr(f, x))
    return x


@builtin("NestList")
def _nestlist(f, x, n):
    out = [x]
    for _ in range(n):
        x = ev(Expr(f, x))
        out.append(x)
    return L(*out)


BUILTINS["Mean"] = lambda l: Expr("Times", Expr("Plus", *l.args), Expr("Power", len(l.args), -1)) if _is_list(l) and l.args else None
BUILTINS["Variance"] = lambda l: (lambda n, m: Expr("Times", Expr("Plus", *[Expr("Power", Expr("Plus", a, Expr("Times", -1, m)), 2) for a in l.args]), Expr("Power", n - 1, -1)))(len(l.args), Expr("Mean", l)) if _is_list(l) and len(l.args) > 1 else None
BUILTINS["StandardDeviation"] = lambda l: Expr("Sqrt", Expr("Variance", l)) if _is_list(l) else None
BUILTINS["StringJoin"] = lambda *a: "".join(a) if all(isinstance(x, str) for x in a) else None
BUILTINS["StringLength"] = lambda a: len(a) if isinstance(a, str) else None


@builtin("Apart")
def _apart(e, v=None):
    x = _sr1(e)
    var = _sr1(v) if v is not None else (x.variables()[0] if x.variables() else None)
    return from_sr(x.partial_fraction(var)) if var is not None else e


@builtin("Coefficient")
def _coefficient(e, x, n=1):
    return from_sr(_sr1(Expr("Expand", e) if False else e).expand().coefficient(_sr1(x), _sr1(n)))


@builtin("N")
def _n(e, d=None):
    if isinstance(e, str) or e is TRUE or e is FALSE or e is NULL:
        return e
    if isinstance(e, Expr) and e.head.name in ("Rule", "List", "Equal"):
        return Expr(e.head, *[_n(a, d) if not (e.is_("Rule") and i == 0) else a for i, a in enumerate(e.args)])
    x = sr_or_none(e)
    if x is None:
        return None
    x = x[0]
    if x.variables():
        if d is None:
            return _n_inside(e)
        return None
    if d is None:
        v = x.n()
        try:
            return float(v)
        except TypeError:
            c = complex(v)
            return Expr("Complex", c.real, c.imag)
    return x.n(digits=int(d))


def _n_inside(e):
    if isinstance(e, (int, Fraction)):
        return float(e)
    if isinstance(e, Sym) and e.name in _CONST_TO:
        return float(to_sr(e).n())
    if isinstance(e, Expr):
        return Expr(e.head, *[_n_inside(a) for a in e.args])
    return e


# number theory

def _int_fn(f):
    def g(*a):
        if all(isinstance(x, int) and not isinstance(x, bool) for x in a):
            return f(*a)
        return None
    return g


BUILTINS["Prime"] = _int_fn(lambda n: int(S.nth_prime(n)))
BUILTINS["PrimeQ"] = lambda n: _boolean(isinstance(n, int) and n > 1 and bool(S.is_prime(n)))
BUILTINS["FactorInteger"] = _int_fn(lambda n: L(*[L(int(p), int(k)) for p, k in S.factor(n)]))
BUILTINS["GCD"] = _int_fn(lambda *a: int(S.gcd(list(a))) if len(a) > 2 else int(S.gcd(*a)))
BUILTINS["LCM"] = _int_fn(lambda *a: int(S.lcm(list(a))) if len(a) > 2 else int(S.lcm(*a)))
BUILTINS["Mod"] = _int_fn(lambda a, m: a % m)
BUILTINS["Quotient"] = _int_fn(lambda a, m: a // m)
BUILTINS["Divisors"] = _int_fn(lambda n: L(*[int(d) for d in S.divisors(n)]))
BUILTINS["EvenQ"] = lambda n: _boolean(isinstance(n, int) and n % 2 == 0)
BUILTINS["OddQ"] = lambda n: _boolean(isinstance(n, int) and n % 2 == 1)
BUILTINS["IntegerQ"] = lambda n: _boolean(isinstance(n, int) and not isinstance(n, bool))
BUILTINS["NumberQ"] = lambda n: _boolean(isinstance(n, (int, Fraction, float)) or (isinstance(n, Expr) and n.is_("Complex")))
BUILTINS["Round"] = lambda x: int(round(x)) if _is_num(x) else None


def _int_valued(name, f):
    sym = BUILTINS[name]

    def g(x):
        if _is_num(x):
            return int(f(x))
        return sym(x)
    return g


import math as _math
BUILTINS["Floor"] = _int_valued("Floor", _math.floor)
BUILTINS["Ceiling"] = _int_valued("Ceiling", _math.ceil)
BUILTINS["Max"] = lambda *a: max(a) if all(isinstance(x, (int, Fraction, float)) for x in a) else (BUILTINS["Max"](*a[0].args) if len(a) == 1 and _is_list(a[0]) else None)
BUILTINS["Min"] = lambda *a: min(a) if all(isinstance(x, (int, Fraction, float)) for x in a) else (BUILTINS["Min"](*a[0].args) if len(a) == 1 and _is_list(a[0]) else None)


# linear algebra: a matrix is a list of lists

def to_matrix(m):
    if not (_is_list(m) and m.args and all(_is_list(r) for r in m.args)):
        raise SprigError("%s is not a matrix" % form(m))
    if all(isinstance(a, (int, Fraction)) and not isinstance(a, bool) for r in m.args for a in r.args):
        return S.matrix(S.QQ, [[S.QQ(a.numerator) / a.denominator if isinstance(a, Fraction) else S.QQ(a) for a in r.args] for r in m.args])
    return S.matrix(S.SR, [[to_sr(a) for a in r.args] for r in m.args])


def _rows_sr(m):
    return [[to_sr(a) for a in r.args] for r in m.args]


def _zero(x):
    return bool(x.simplify_full() == 0)


def _nullspace_sr(rows):
    """A basis of {v : rows . v == 0}, by Gauss-Jordan elimination over SR:
    one vector per free column, that entry 1 (normalised as the oracle does)."""
    a = [list(r) for r in rows]
    n = len(a[0]) if a else 0
    piv, r = [], 0
    for c in range(n):
        p = next((i for i in range(r, len(a)) if not _zero(a[i][c])), None)
        if p is None:
            continue
        a[r], a[p] = a[p], a[r]
        pv = a[r][c]
        a[r] = [(x / pv).simplify_full() for x in a[r]]
        for i in range(len(a)):
            if i != r and not _zero(a[i][c]):
                f = a[i][c]
                a[i] = [(x - f * y).simplify_full() for x, y in zip(a[i], a[r])]
        piv.append(c)
        r += 1
    out = []
    for fc in [c for c in range(n) if c not in piv]:
        v = [S.SR(0)] * n
        v[fc] = S.SR(1)
        for i, pc in enumerate(piv):
            v[pc] = -a[i][fc]
        out.append(v)
    return out


def from_matrix(M):
    return L(*[L(*[from_sr(a) for a in r]) for r in M.rows()])


def from_vector(v):
    return L(*[from_sr(a) for a in v])


@builtin("Det")
def _det(m):
    return from_sr(to_matrix(m).det())


@builtin("Inverse")
def _inverse(m):
    return from_matrix(to_matrix(m).inverse())


@builtin("Transpose")
def _transpose(m):
    return L(*[L(*[r.args[j] for r in m.args]) for j in range(len(m.args[0].args))]) if _is_list(m) and m.args and all(_is_list(r) for r in m.args) else None


@builtin("Dot")
def _dot(*ms):
    if not all(_is_list(m) for m in ms):
        return None
    r = ms[0]
    for m in ms[1:]:
        a_mat, b_mat = _is_list(r.args[0]) if r.args else False, _is_list(m.args[0]) if m.args else False
        if not a_mat and not b_mat:
            r = Expr("Plus", *[Expr("Times", x, y) for x, y in zip(r.args, m.args)])
        elif a_mat and not b_mat:
            r = L(*[Expr("Plus", *[Expr("Times", x, y) for x, y in zip(row.args, m.args)]) for row in r.args])
        elif not a_mat and b_mat:
            r = L(*[Expr("Plus", *[Expr("Times", r.args[i], m.args[i].args[j]) for i in range(len(r.args))]) for j in range(len(m.args[0].args))])
        else:
            r = from_matrix(to_matrix(r) * to_matrix(m))
        r = ev(r)
    return r


@builtin("IdentityMatrix")
def _identity(n):
    return L(*[L(*[1 if i == j else 0 for j in range(n)]) for i in range(n)]) if isinstance(n, int) else None


def _eigenvalues_sr(m):
    rows = _rows_sr(m)
    t = S.var("sbwEigenT")
    n = len(rows)
    cp = S.matrix(S.SR, [[rows[i][j] - (t if i == j else 0) for j in range(n)] for i in range(n)]).det()
    vals = []
    for sol in S.solve(cp == 0, t):
        vals.append(sol.rhs())
    # (a repeated root once per multiplicity, decreasing absolute value as the oracle orders them)
    out = []
    for v in vals:
        k = 0
        q = cp
        while k < n and _zero(q.subs({t: v})):
            k += 1
            q = S.diff(q, t)
        out.extend([v] * max(k, 1))
    return sorted(out, key=_abs_key)


def _abs_key(v):
    try:
        return -abs(complex(v.n()))
    except Exception:
        return 0.0


@builtin("Eigenvalues")
def _eigenvalues(m):
    return L(*[from_sr(v.simplify_full()) for v in _eigenvalues_sr(m)])


@builtin("Eigenvectors")
def _eigenvectors(m):
    rows = _rows_sr(m)
    n = len(rows)
    out, seen = [], []
    for v in _eigenvalues_sr(m):
        if any(_zero(v - w) for w in seen):
            continue
        seen.append(v)
        shifted = [[rows[i][j] - (v if i == j else 0) for j in range(n)] for i in range(n)]
        for w in _nullspace_sr(shifted):
            out.append(L(*[from_sr(a.simplify_full()) for a in w]))
    return L(*out)


@builtin("CharacteristicPolynomial")
def _charpoly(m, x):
    rows = _rows_sr(m)
    X = _sr1(x)
    n = len(rows)
    return from_sr(S.matrix(S.SR, [[(rows[i][j] if i != j else rows[i][j] - X) for j in range(n)] for i in range(n)]).det().expand())


@builtin("RowReduce")
def _rowreduce(m):
    return from_matrix(to_matrix(m).rref())


@builtin("MatrixRank")
def _rank(m):
    return int(to_matrix(m).rank())


@builtin("NullSpace")
def _nullspace(m):
    return L(*[L(*[from_sr(a) for a in v]) for v in reversed(_nullspace_sr(_rows_sr(m)))])


@builtin("LinearSolve")
def _linsolve(m, b):
    # (b as a one-column matrix of the same ring: a QQ matrix and an SR vector
    # crash sagebrush/linalg.py's solve)
    v = to_matrix(m).solve_right(to_matrix(L(*[L(a) for a in b.args])))
    return L(*[from_sr(r[0]) for r in v.rows()])


@builtin("Tr")
def _tr(m):
    return from_sr(to_matrix(m).trace())


@builtin("Cross")
def _cross(a, b):
    if not (_is_list(a) and _is_list(b) and len(a.args) == 3 == len(b.args)):
        return None
    a1, a2, a3 = a.args
    b1, b2, b3 = b.args
    sub = lambda p, q: Expr("Plus", p, Expr("Times", -1, q))
    return L(sub(Expr("Times", a2, b3), Expr("Times", a3, b2)), sub(Expr("Times", a3, b1), Expr("Times", a1, b3)), sub(Expr("Times", a1, b2), Expr("Times", a2, b1)))


@builtin("Norm")
def _norm(v):
    return Expr("Sqrt", Expr("Plus", *[Expr("Power", Expr("Abs", a), 2) for a in v.args])) if _is_list(v) else Expr("Abs", v)


BUILTINS["MatrixForm"] = lambda m: m
BUILTINS["TableForm"] = lambda m: m


# plotting: Sage's plot functions; the result is a graphic

def _plot_fn(var, body):
    return _sr1(ev(body)), _sr1(var)


@builtin("Plot")
def _plot(f, spec, *opts):
    x, a, b = spec.args
    fs = ev(f)
    fs = fs.args if _is_list(fs) else (fs,)
    X = _sr1(x)
    g = None
    for i, h in enumerate(fs):
        p = S.plot(_sr1(h), (X, float(_sr1(ev(a)).n()), float(_sr1(ev(b)).n())), color=_COLORS[i % len(_COLORS)])
        g = p if g is None else g + p
    return Graphic(g, "Graphics")


_COLORS = ["#5e81b5", "#e19c24", "#8fb032", "#eb6235", "#8778b3"]


@builtin("Plot3D")
def _plot3d(f, sx, sy, *opts):
    X, Y = _sr1(sx.args[0]), _sr1(sy.args[0])
    rng = lambda s: (float(_sr1(ev(s.args[1])).n()), float(_sr1(ev(s.args[2])).n()))
    g = S.plot3d(_sr1(ev(f)), (X,) + rng(sx), (Y,) + rng(sy))
    return Graphic(g, "Graphics3D")


@builtin("ParametricPlot")
def _pplot(f, spec, *opts):
    t, a, b = spec.args
    fs = ev(f)
    T = _sr1(t)
    g = S.parametric_plot(tuple(_sr1(c) for c in fs.args), (T, float(_sr1(ev(a)).n()), float(_sr1(ev(b)).n())))
    return Graphic(g, "Graphics")


@builtin("ContourPlot")
def _cplot(f, sx, sy, *opts):
    X, Y = _sr1(sx.args[0]), _sr1(sy.args[0])
    rng = lambda s: (float(_sr1(ev(s.args[1])).n()), float(_sr1(ev(s.args[2])).n()))
    return Graphic(S.contour_plot(_sr1(ev(f)), (X,) + rng(sx), (Y,) + rng(sy)), "Graphics")


@builtin("ListPlot")
def _lplot(pts, *opts):
    ps = [(float(_sr1(p.args[0]).n()), float(_sr1(p.args[1]).n())) if _is_list(p) else (i + 1, float(_sr1(p).n())) for i, p in enumerate(pts.args)]
    return Graphic(S.list_plot(ps), "Graphics")


@builtin("Show")
def _show(*gs):
    g = None
    for x in gs:
        if isinstance(x, Graphic):
            g = x.g if g is None else g + x.g
    return Graphic(g, gs[0].kind) if g is not None else None


@builtin("Export")
def _export(path, g, *rest):
    if not isinstance(path, str) or not isinstance(g, Graphic):
        return None
    g.g.save(path)
    return path


@builtin("ToString")
def _tostring(e, *rest):
    return e if isinstance(e, str) else form(e)


@builtin("TeXForm")
def _texform(e):
    x = sr_or_none(e)
    if x is None:
        return None
    t = S.latex(x[0])
    return Expr("TeXForm", re.sub(r"\\mathrm\{sbw\}_\{(\w+)\}|\\mathit\{sbw\}_\{(\w+)\}", lambda m: m.group(1) or m.group(2), t))


# --- printing (InputForm-like)

PREC = {"CompoundExpression": 10, "Set": 40, "SetDelayed": 40, "Rule": 120, "RuleDelayed": 120,
        "ReplaceAll": 110, "Or": 215, "And": 220, "Not": 230, "Equal": 290, "Unequal": 290, "Less": 290,
        "Greater": 290, "LessEqual": 290, "GreaterEqual": 290, "Plus": 310, "Times": 400, "Dot": 490,
        "Power": 590, "Factorial": 610, "Condition": 130}
_INFIX_FORM = {"Rule": " -> ", "RuleDelayed": " :> ", "Equal": " == ", "Unequal": " != ", "Less": " < ",
               "Greater": " > ", "LessEqual": " <= ", "GreaterEqual": " >= ", "And": " && ", "Or": " || ",
               "ReplaceAll": " /. ", "Set": " = ", "SetDelayed": " := ", "Dot": ".", "Condition": " /; ",
               "CompoundExpression": "; "}


def _is_num(e):
    return isinstance(e, (int, Fraction, float)) and not isinstance(e, bool)


def _neg(e):
    """Whether e prints with a leading minus sign."""
    if _is_num(e):
        return e < 0
    if not (isinstance(e, Expr) and e.is_("Times") and e.args):
        return False
    c = e.args[0]
    if isinstance(c, Expr) and c.is_("Complex") and c.args[0] == 0:
        return _is_num(c.args[1]) and c.args[1] < 0
    return _is_num(c) and c < 0


def _base_key(b):
    if isinstance(b, Sym):
        return "1" + b.name.lower() + " " + b.name
    if isinstance(b, str):
        return "0" + b
    if isinstance(b, Expr):
        return "2" + (b.head.name if isinstance(b.head, Sym) else "~") + form(b)
    return "3" + str(b)


def _factor_key(f):
    if isinstance(f, Expr) and f.is_("Power") and len(f.args) == 2:
        ex = f.args[1]
        return (_base_key(f.args[0]), float(ex) if _is_num(ex) else 1e9)
    return (_base_key(f), 1.0)


def order_key(e):
    """A canonical order: numbers first; then products compared from their
    largest factor (symbols before compound expressions, a power by its base
    and then its exponent): 1 + x + x^2, x^2 + 2*x*y + y^2."""
    if _is_num(e):
        return (0, float(e), ())
    if isinstance(e, Expr) and e.is_("Complex"):
        return (0, 0.0, ())
    fs = [a for a in e.args if not _is_num(a)] if isinstance(e, Expr) and e.is_("Times") else [e]
    return (1, 0.0, tuple(sorted((_factor_key(f) for f in fs), reverse=True)))


def _num_form(e):
    if isinstance(e, float):
        r = repr(e)
        if "e" in r:
            m, ex = r.split("e")
            r = "%s*^%d" % (m, int(ex))
        return r
    if isinstance(e, Fraction):
        return "%d/%d" % (e.numerator, e.denominator)
    return str(e)


def form(e, prec=0):
    """e in input form (prec: the precedence of the surrounding operator)."""
    s, p = _form(e)
    return "(" + s + ")" if p < prec else s


def _form(e):
    if isinstance(e, bool):
        return ("True" if e else "False"), 1000
    if isinstance(e, Fraction):
        return _num_form(e), 470 if True else 1000
    if _is_num(e):
        return _num_form(e), (480 if e < 0 else 1000)
    if isinstance(e, str):
        return '"' + e.replace("\\", "\\\\").replace('"', '\\"') + '"', 1000
    if isinstance(e, Sym):
        return e.name, 1000
    if isinstance(e, Graphic):
        return "-%s-" % e.kind, 1000
    if not isinstance(e, Expr):
        return str(e), 1000
    h = e.head
    n = h.name if isinstance(h, Sym) else None
    a = e.args
    if n == "List":
        return "{" + ", ".join(form(x) for x in a) + "}", 1000
    if n == "Plus" and a:
        terms = sorted(a, key=order_key)
        out = form(terms[0], 310)
        for t in terms[1:]:
            if _neg(t):
                out += " - " + form(_negate(t), 311)
            else:
                out += " + " + form(t, 311)
        return out, 310
    if n == "Times" and a:
        return _times_form(a)
    if n == "Power" and len(a) == 2:
        b, x = a
        if x == Fraction(1, 2):
            return "Sqrt[" + form(b) + "]", 1000
        if _is_num(x) and x < 0:
            d = form(Expr("Power", b, -x)) if x != -1 else form(b, 471)
            if x == Fraction(-1, 2):
                d = "Sqrt[" + form(b) + "]"
            return "1/" + d if x == -1 or x == Fraction(-1, 2) else "1/" + form(Expr("Power", b, -x), 471), 470
        return form(b, 591) + "^" + form(x, 590), 590
    if n == "Complex" and len(a) == 2:
        re_, im = a
        im_s = "I" if im == 1 else "-I" if im == -1 else form(im, 400) + "*I"
        if re_ == 0:
            return im_s, 400
        return form(re_) + (" - " + im_s[1:] if im_s.startswith("-") else " + " + im_s), 310
    if n == "Factorial" and len(a) == 1:
        return form(a[0], 611) + "!", 610
    if n == "Not" and len(a) == 1:
        return "!" + form(a[0], 231), 230
    if n == "SeriesData" and len(a) == 6 and isinstance(a[3], int):
        return _series_form(a)
    if n == "TeXForm" and len(a) == 1 and isinstance(a[0], str):
        return a[0], 1000
    if n == "Slot" and len(a) == 1 and isinstance(a[0], int):
        return "#" + (str(a[0]) if a[0] != 1 else ""), 1000
    if n == "Function" and len(a) == 1:
        return form(a[0], 91) + " & ", 90
    if n == "Pattern" and len(a) == 2 and isinstance(a[1], Expr) and a[1].head.name in ("Blank", "BlankSequence", "BlankNullSequence"):
        bl = {"Blank": "_", "BlankSequence": "__", "BlankNullSequence": "___"}[a[1].head.name]
        return a[0].name + bl + (a[1].args[0].name if a[1].args else ""), 1000
    if n in _INFIX_FORM and len(a) >= 2:
        p = PREC[n]
        right = n in ("Rule", "RuleDelayed", "Set", "SetDelayed")
        parts = [form(x, p + (0 if right and i == len(a) - 1 else 1)) for i, x in enumerate(a)]
        return _INFIX_FORM[n].join(parts), p
    return form(h, 1000) + "[" + ", ".join(form(x) for x in a) + "]", 1000


def _negate(t):
    if _is_num(t):
        return -t
    c = t.args[0]
    c = Expr("Complex", 0, -c.args[1]) if isinstance(c, Expr) and c.is_("Complex") else -c
    rest = t.args[1:]
    if c == 1:
        return rest[0] if len(rest) == 1 else Expr("Times", *rest)
    return Expr("Times", c, *rest)


def _times_form(a):
    num_, den = [], []
    sign = ""
    xs = []
    for x in a:
        if isinstance(x, Expr) and x.is_("Complex") and x.args[0] == 0:
            xs.extend([x.args[1], Sym("I")])
        else:
            xs.append(x)
    for x in sorted(xs, key=order_key):
        if _is_num(x):
            if x < 0:
                sign = "-"
                x = -x
            if isinstance(x, Fraction):
                if x.numerator != 1:
                    num_.append(x.numerator)
                den.append(x.denominator)
            elif x != 1:
                num_.append(x)
        elif isinstance(x, Expr) and x.is_("Power") and len(x.args) == 2 and _is_num(x.args[1]) and x.args[1] < 0:
            den.append(Expr("Power", x.args[0], -x.args[1]) if x.args[1] != -1 else x.args[0])
        else:
            num_.append(x)
    ns = "*".join(form(x, 401) for x in num_) if num_ else "1"
    if not den:
        return sign + ns, (400 if not sign else 480)
    ds = form(den[0], 471) if len(den) == 1 else "(" + "*".join(form(x, 401) for x in den) + ")"
    return sign + ns + "/" + ds, 470 if not sign else 480


def _series_form(a):
    x, x0, cs, lo, hi, den = a
    terms = []
    base = x if x0 == 0 else Expr("Plus", Expr("Times", -1, x0), x)
    for k, c in enumerate(cs.args):
        if c == 0:
            continue
        terms.append(ev(Expr("Times", c, Expr("Power", base, lo + k))))
    s = " + ".join(form(t, 311) for t in terms).replace("+ -", "- ")
    o = "O[" + form(base) + "]^" + str(hi)
    return (s + " + " + o if s else o), 310


def display(e):
    """The text shown for a result (nothing for Null)."""
    if e is NULL:
        return None
    return form(e)


# --- sessions

def run(src, show=print):
    """Evaluate the cell src, showing each top-level result."""
    for stmt in parse(src):
        try:
            r = ev(stmt)
        except SprigError as err:
            show("Error: " + str(err))
            continue
        except Exception as err:
            # (a failure inside Sage's layer: reported, and the session goes on)
            show("Error: %s: %s" % (type(err).__name__, err))
            continue
        OUT.append(r)
        if isinstance(stmt, Expr) and stmt.is_("CompoundExpression") and stmt.args[-1] is NULL:
            continue
        t = display(r)
        if t is not None:
            show(t)
