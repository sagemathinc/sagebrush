"""Sprig's parser: source text to expressions (design/sprig-mvp.md §3, §8.3).

An operator-precedence parser on explicit stacks, never host recursion: an
open bracket pushes a frame, and each frame has its own operand and
operator stacks.  Input nested 10^5 brackets deep is a list 10^5 frames long.
The operator table is the spike's, checked against the oracle's FullForm of
held input (sprig-tests/core/).

`parse(src)` gives the top-level statements.  A statement ends at a newline
when it is complete, as in a file.  A syntax error is SprigSyntaxError, with
its message tag (sntxf: a token that can't follow what came before; sntxi:
the input ended inside a statement; sntxb: a token that can't begin an
expression) and the text before and after the error.
"""

import re
import fractions

from . import mem
from .expr import Expr, Sym, NULL, LIST, num, name_of

Fraction = fractions.Fraction


class SprigSyntaxError(Exception):
    def __init__(self, tag, pos, before="", after=""):
        Exception.__init__(self, tag)
        self.tag = tag
        self.pos = pos
        self.before = before
        self.after = after


class NotYetSyntax(Exception):
    """Notation Sprig reads but doesn't support yet; `what` names it for General::notyet."""

    def __init__(self, what, pos):
        Exception.__init__(self, what)
        self.what = what
        self.pos = pos


_NAME = r"[A-Za-z$][A-Za-z0-9$]*"
_TOKEN = re.compile(r"""
  (?P<ws>[ \t\r]+)
 |(?P<nl>\n)
 |(?P<num>(?:\d+\.?\d*|\.\d+)(?:`[0-9.]*)?(?:\*\^-?\d+)?)
 |(?P<str>")
 |(?P<pat>(?:%(n)s)?_{1,3}(?:\.|%(n)s)?)
 |(?P<sym>(?:%(n)s`)*%(n)s)
 |(?P<slot>\#\#?\d*)
 |(?P<out>%%+|%%\d*)
 |(?P<op>===|=!=|//\.|@@@|\^:=|\^=|=\.(?!\d)|:=|:>|->|/\.|//|/@|@@|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|/=|<>|/;|;;|[-+*/^=<>!.,;()\[\]{}&@?|':])
""" % {"n": _NAME}, re.X)

# binding powers, as an infix or postfix operator; a right-associative operator continues at an equal power
INFIX = {
    ";": 10, "=": 40, ":=": 40, "^=": 40, "^:=": 40, "+=": 40, "-=": 40, "*=": 40, "/=": 40, "//": 70,
    "/.": 110, "//.": 110, "->": 120, ":>": 120, "/;": 130, ":": 150, "|": 160,
    "||": 215, "&&": 220, "==": 290, "!=": 290, "<": 290, ">": 290, "<=": 290, ">=": 290,
    "===": 290, "=!=": 290, ";;": 305, "+": 310, "-": 310, "*": 400, "/": 470, ".": 490,
    "^": 590, "<>": 600, "/@": 620, "@@": 620, "@@@": 620, "@": 640, "?": 680,
}
POSTFIX = {"&": 90, "=.": 670, "!": 610, "++": 660, "--": 660, "'": 670}
PREFIX = {"-": 480, "+": 480, "!": 230, "++": 660, "--": 660}
RIGHT = {"=", ":=", "^=", "^:=", "+=", "-=", "*=", "/=", "->", ":>", "^", "/@", "@@", "@@@", "@"}
IMPLICIT = 400
CALL = 1000
RELATIONS = {"==": "Equal", "!=": "Unequal", "<": "Less", ">": "Greater", "<=": "LessEqual",
             ">=": "GreaterEqual"}
REL_HEADS = set(RELATIONS.values())
FLAT = {"+": "Plus", "*": "Times", ".": "Dot", "&&": "And", "||": "Or", "|": "Alternatives",
        "<>": "StringJoin", "===": "SameQ", "=!=": "UnsameQ"}
SIMPLE = {"=": "Set", ":=": "SetDelayed", "^=": "UpSet", "^:=": "UpSetDelayed", "->": "Rule",
          ":>": "RuleDelayed", "/.": "ReplaceAll", "//.": "ReplaceRepeated", "/;": "Condition",
          "/@": "Map", "@@": "Apply", "?": "PatternTest", "+=": "AddTo", "-=": "SubtractFrom",
          "*=": "TimesBy", "/=": "DivideBy", ";;": "Span"}
STARTS = {"num", "str", "pat", "sym", "slot", "out"}
CONTEXTS = ("Global`", "System`")
TIMES, PLUS, POWER = Sym("Times"), Sym("Plus"), Sym("Power")


def _string(src, pos):
    """The string literal starting at src[pos] (a quote): (value, end), or None when it doesn't close."""
    out, i, n = [], pos + 1, len(src)
    while i < n:
        c = src[i]
        if c == '"':
            return "".join(out), i + 1
        if c == "\\" and i + 1 < n:
            d = src[i + 1]
            out.append({"n": "\n", "t": "\t", "r": "\r"}.get(d, d))
            i += 2
            continue
        out.append(c)
        i += 1
    return None


def _comment_end(src, pos):
    """The end of the comment starting at src[pos] ("(*"), comments nesting; None when it doesn't close."""
    depth, i, n = 0, pos, len(src)
    while i < n:
        if src.startswith("(*", i):
            depth += 1
            i += 2
        elif src.startswith("*)", i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
        else:
            i += 1
    return None


def tokenize(src):
    """[(kind, value, pos)], ending with ("eof", "", len(src)).  An unclosed string or comment is sntxi."""
    out, pos, n = [], 0, len(src)
    while pos < n:
        if src.startswith("(*", pos):
            end = _comment_end(src, pos)
            if end is None:
                raise SprigSyntaxError("sntxi", pos)
            pos = end
            continue
        m = _TOKEN.match(src, pos)
        if m is None:
            raise SprigSyntaxError("sntxf", pos, src[:pos].strip(), src[pos:].strip())
        k = m.lastgroup
        if k == "str":
            r = _string(src, pos)
            if r is None:
                raise SprigSyntaxError("sntxi", pos)
            out.append(("str", r[0], pos))
            pos = r[1]
            continue
        if k != "ws":
            out.append((k, m.group(), pos))
        pos = m.end()
    out.append(("eof", "", n))
    return out


def _symbol(v):
    for c in CONTEXTS:
        if v.startswith(c) and "`" not in v[len(c):]:
            return Sym(v[len(c):])
    return Sym(v)


def _pattern(v):
    m = re.match(r"(%s)?(_{1,3})(\.|%s)?$" % (_NAME, _NAME), v)
    name, blanks, h = m.groups()
    b = Expr(("Blank", "BlankSequence", "BlankNullSequence")[len(blanks) - 1], *([Sym(h)] if h and h != "." else []))
    p = Expr("Pattern", Sym(name), b) if name else b
    return Expr("Optional", p) if h == "." else p


BEYOND_MACHINE = "A real number beyond the machine range"
# (the machine range, exactly: the largest finite double and the smallest normal one)
MACHINE_MAX = fractions.Fraction(1.7976931348623157e308)
MACHINE_TINY = fractions.Fraction(2.2250738585072014e-308)


def _number(v, pos, literals=None):
    mant, _, ex = v.partition("*^")
    mant, mark, prec = mant.partition("`")
    if mark and prec:
        raise NotYetSyntax("A number with a stated precision", pos)
    if "." in mant or mark:
        # (a machine Real; past the machine range it would need arbitrary precision, S2's)
        x = float(mant)
        if ex and x != 0:
            e = int(ex)
            if len(ex) > 6 or not -400 < e < 400:
                raise NotYetSyntax(BEYOND_MACHINE, pos)
            exact = fractions.Fraction(mant) * fractions.Fraction(10) ** e
            if not MACHINE_TINY <= abs(exact) <= MACHINE_MAX:
                raise NotYetSyntax(BEYOND_MACHINE, pos)
            x = float(exact)
        if x in (float("inf"), float("-inf")):
            raise NotYetSyntax(BEYOND_MACHINE, pos)
        return x
    n = int(mant)
    if ex:
        # (an exact power of ten: its size is reserved before it is computed, so 1*^1000000000 is a refusal; the
        # charge stays with the program's literals, for as long as the parsed program lives, when there is one)
        e = int(ex)
        bits = n.bit_length() + abs(e) * 10 // 3 + 1
        if literals is not None:
            literals.grow(mem.int_bytes(bits), "An exact number of " + mem.count(bits, "bit"))
            return num(n * Fraction(10) ** e)
        with mem.reserve(mem.int_bytes(bits), "An exact number of " + mem.count(bits, "bit"), "Sprig"):
            return num(n * Fraction(10) ** e)
    return n


def _atom(tok, literals=None):
    k, v, pos = tok
    if k == "num":
        return _number(v, pos, literals)
    if k == "str":
        return v
    if k == "sym":
        return _symbol(v)
    if k == "pat":
        return _pattern(v)
    if k == "slot":
        if v.startswith("##"):
            return Expr("SlotSequence", int(v[2:] or 1))
        return Expr("Slot", int(v[1:] or 1))
    if v == "%":
        return Expr("Out")
    if v.count("%") == len(v):
        return Expr("Out", -len(v))
    return Expr("Out", int(v[1:]))


def _flat(head, a, b):
    """head[a, b], splicing an operand that is itself an unparenthesized head[...]."""
    args = []
    for x, paren in (a, b):
        if not paren and type(x) is Expr and x.head is head:
            args.extend(x.args)
        else:
            args.append(x)
    return Expr(head, *args)


def _negate(v):
    x, paren = v
    if not paren and type(x) in (int, Fraction, float):
        return -x
    return _flat(TIMES, (-1, False), v)


class _Frame:
    __slots__ = ("kind", "head", "items", "vals", "ops", "expect", "pos")

    def __init__(self, kind, pos, head=None):
        self.kind = kind          # "top", "(", "{", "[" (a call), "[[" (Part)
        self.head = head
        self.items = []           # the finished arguments of a call, list or Part
        self.vals = []            # (expr, parenthesized)
        self.ops = []             # (op, bp, "in" | "pre", pos)
        self.expect = True        # whether an operand comes next
        self.pos = pos


class Parser:
    def __init__(self, src, literals=None):
        """literals: the holder the program's expanded exact numbers are charged to while it lives (mem.Held)."""
        self.literals = literals
        self.src = src
        self.toks = tokenize(src)
        self.i = 0
        self.start = 0            # where the current statement began

    def error(self, tag, tok):
        pos = tok[2]
        before = self.src[self.start:pos].strip()
        end = self.src.find("\n", pos)
        after = self.src[pos:end if end >= 0 else len(self.src)].strip()
        return SprigSyntaxError(tag, pos, before, after)

    # --- reductions

    def _reduce(self, f):
        op, bp, kind, pos = f.ops.pop()
        if kind == "pre":
            v = f.vals.pop()
            if op == "-":
                f.vals.append((_negate(v), False))
            elif op == "+":
                f.vals.append(v)
            elif op == "!":
                f.vals.append((Expr("Not", v[0]), False))
            else:
                f.vals.append((Expr("PreIncrement" if op == "++" else "PreDecrement", v[0]), False))
            return
        b = f.vals.pop()
        a = f.vals.pop()
        f.vals.append((self._binary(op, a, b), False))

    def _binary(self, op, a, b):
        if op == "+":
            return _flat(PLUS, a, b)
        if op == "-":
            return _flat(PLUS, a, (_negate(b), False))
        if op == "*":
            return _flat(TIMES, a, b)
        if op == "/":
            return _flat(TIMES, a, (Expr(POWER, b[0], -1), False))
        if op == "^":
            return Expr(POWER, a[0], b[0])
        if op == ";":
            return _flat(Sym("CompoundExpression"), a, b)
        if op in FLAT:
            return _flat(Sym(FLAT[op]), a, b)
        if op in RELATIONS:
            h = Sym(RELATIONS[op])
            x, paren = a
            if not paren and type(x) is Expr and x.head is h:
                return Expr(h, *(x.args + (b[0],)))
            # (a chain of different relations, a < b > c, is Inequality[a, Less, b, Greater, c])
            if not paren and type(x) is Expr and name_of(x.head) in REL_HEADS and len(x.args) >= 2:
                items = []
                for i, y in enumerate(x.args):
                    if i:
                        items.append(x.head)
                    items.append(y)
                return Expr("Inequality", *(items + [h, b[0]]))
            if not paren and type(x) is Expr and x.head is Sym("Inequality") and len(x.args) % 2 == 1:
                return Expr("Inequality", *(x.args + (h, b[0])))
            return Expr(h, x, b[0])
        if op in SIMPLE:
            return Expr(SIMPLE[op], a[0], b[0])
        if op == "@@@":
            return Expr("Apply", a[0], b[0], Expr(LIST, 1))
        if op == "@":
            return Expr(a[0], b[0])
        if op == "//":
            return Expr(b[0], a[0])
        if op == ":":
            return Expr("Pattern", a[0], b[0]) if type(a[0]) is Sym else Expr("Optional", a[0], b[0])
        raise AssertionError(op)

    def _reduce_to(self, f, bp, right):
        while f.ops and (f.ops[-1][1] > bp or (f.ops[-1][1] == bp and not right)):
            self._reduce(f)

    def _finish(self, f):
        while f.ops:
            self._reduce(f)
        return f.vals.pop()

    # --- the statements

    def statements(self):
        out = []
        while True:
            s = self.statement()
            if s is None:
                return out
            out.append(s)

    def statement(self):
        """The next top-level statement, or None at the end of the input."""
        toks = self.toks
        while toks[self.i][0] == "nl":
            self.i += 1
        if toks[self.i][0] == "eof":
            return None
        self.start = toks[self.i][2]
        frames = [_Frame("top", self.start)]
        while True:
            f = frames[-1]
            tok = toks[self.i]
            k, v, pos = tok
            if f.expect:
                if k == "nl":
                    self.i += 1
                    continue
                if k == "eof":
                    raise self.error("sntxi", tok)
                self.i += 1
                if k in STARTS:
                    f.vals.append((_atom(tok, self.literals), False))
                    f.expect = False
                elif k == "op" and v in ("(", "{"):
                    frames.append(_Frame(v, pos))
                elif k == "op" and v in PREFIX:
                    f.ops.append((v, PREFIX[v], "pre", pos))
                elif k == "op" and not f.vals and not f.ops and not f.items and (f.kind, v) in (("[", "]"), ("{", "}")):
                    # (an empty call or list: f[], {})
                    self._close(frames, [])
                elif len(frames) == 1 and not f.ops:
                    # (nothing before it in the statement)
                    raise self.error("sntxb", tok)
                else:
                    raise self.error("sntxf", tok)
                continue
            # after an operand
            if k == "eof" or (k == "nl" and len(frames) == 1):
                if len(frames) > 1:
                    raise self.error("sntxi", tok)
                return self._finish(f)[0]
            if k == "nl":
                self.i += 1
                continue
            self.i += 1
            if k in STARTS or (k == "op" and v in ("(", "{")):
                # (juxtaposition is multiplication)
                self._reduce_to(f, IMPLICIT, False)
                f.ops.append(("*", IMPLICIT, "in", pos))
                f.expect = True
                self.i -= 1
                continue
            if k != "op":
                raise self.error("sntxf", tok)
            if v == "[":
                if toks[self.i][1] == "[" and toks[self.i][2] == pos + 1:
                    self.i += 1
                    head = f.vals.pop()[0]
                    frames.append(_Frame("[[", pos, head))
                else:
                    head = f.vals.pop()[0]
                    frames.append(_Frame("[", pos, head))
                f.expect = False
                continue
            if v in ("]", "}", ")", ","):
                self._close_or_next(frames, tok)
                continue
            if v == ";":
                self._reduce_to(f, INFIX[";"], False)
                nk, nv = toks[self.i][0], toks[self.i][1]
                if nk == "eof" or (nk == "nl" and len(frames) == 1) or nv in (")", "]", "}", ","):
                    f.vals.append((Expr("CompoundExpression", *self._compound_items(f.vals.pop(), NULL)), False))
                    continue
                f.ops.append((";", INFIX[";"], "in", pos))
                f.expect = True
                continue
            if v in POSTFIX:
                self._postfix(f, v, pos)
                continue
            if v in INFIX:
                bp = INFIX[v]
                self._reduce_to(f, bp, v in RIGHT)
                f.ops.append((v, bp, "in", pos))
                f.expect = True
                continue
            raise self.error("sntxf", tok)

    def _compound_items(self, v, last):
        x, paren = v
        if not paren and type(x) is Expr and x.head is Sym("CompoundExpression"):
            return x.args + (last,)
        return (x, last)

    def _postfix(self, f, v, pos):
        bp = POSTFIX[v]
        self._reduce_to(f, bp, False)
        x = f.vals.pop()[0]
        if v == "&":
            r = Expr("Function", x)
        elif v == "!":
            r = Expr("Factorial", x)
        elif v == "=.":
            r = Expr("Unset", x)
        elif v == "'":
            n = 1
            while self.toks[self.i][1] == "'":
                self.i += 1
                n += 1
            r = Expr(Expr("Derivative", n), x)
        else:
            r = Expr("Increment" if v == "++" else "Decrement", x)
        f.vals.append((r, False))

    def _close_or_next(self, frames, tok):
        f = frames[-1]
        v = tok[1]
        if f.kind == "top":
            raise self.error("sntxf", tok)
        item = self._finish(f)
        if v == ",":
            if f.kind == "(":
                raise self.error("sntxf", tok)
            f.items.append(item[0])
            f.expect = True
            return
        want = {"(": ")", "{": "}", "[": "]", "[[": "]"}[f.kind]
        if v != want:
            raise self.error("sntxf", tok)
        if f.kind == "[[":
            nt = self.toks[self.i]
            if nt[1] != "]":
                raise self.error("sntxf", nt if nt[0] != "eof" else nt)
            self.i += 1
        if f.kind == "(":
            frames.pop()
            p = frames[-1]
            p.vals.append((item[0], True))
            p.expect = False
            return
        f.items.append(item[0])
        self._close(frames, f.items)

    def _close(self, frames, items):
        f = frames.pop()
        p = frames[-1]
        if f.kind == "{":
            r = Expr(LIST, *items)
        elif f.kind == "[[":
            r = Expr("Part", f.head, *items)
        else:
            r = Expr(f.head, *items)
        p.vals.append((r, False))
        p.expect = False


def parse(src, literals=None):
    """The top-level statements of src (its expanded exact numbers charged to literals, if given, for as long as the
    caller keeps them)."""
    return Parser(src, literals).statements()


def is_incomplete(src):
    """Whether src needs more lines (it ends inside a statement, a bracket, a string or a comment)."""
    try:
        parse(src)
    except SprigSyntaxError as e:
        return e.tag == "sntxi"
    except NotYetSyntax:
        return False
    return False
