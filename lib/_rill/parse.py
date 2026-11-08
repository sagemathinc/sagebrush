"""Rill's parser: tokens to R's language objects (design/rill.md §4).

A Pratt parser over R's operator table (?Syntax), one top-level statement
at a time, as Rscript reads a file: the statements before a syntax error
run, then the error stops the script.  The texts of syntax errors, and the
statement context R quotes in them, follow what R 4.5.3 prints for
rill-tests/parse/.

`=` is an assignment only where R's grammar allows one: a statement, a
braced or parenthesized expression, or the body of `if`, `for`, `while` and
`function`; not in a condition or an argument.  `->` and `->>` become `<-`
and `<<-` calls, and `|>` becomes the call it stands for, as R's parser
does.
"""

from .lex import lex
from .values import (MISSING, NULL, Formals, Lang, Placeholder, Sym, Vector, chr_, cplx, dbl, int_,
                     lgl, sym)

# binding powers (?Syntax, lowest first); a left-associative operator stops at an
# equal power, a right-associative one continues
BINARY = {
    "?": (10, "left"),
    "EQ_ASSIGN": (20, "right"),
    "LEFT_ASSIGN": (30, "right"),
    "RIGHT_ASSIGN": (40, "left"),
    "~": (50, "left"),
    "||": (60, "left"), "|": (60, "left"),
    "&&": (70, "left"), "&": (70, "left"),
    "==": (90, "left"), "!=": (90, "left"), "<": (90, "left"), ">": (90, "left"),
    "<=": (90, "left"), ">=": (90, "left"),
    "+": (100, "left"), "-": (100, "left"),
    "*": (110, "left"), "/": (110, "left"),
    "SPECIAL": (120, "left"), "PIPE": (120, "left"),
    ":": (130, "left"),
    "^": (150, "right"),
}
UNARY = {"?": 10, "~": 50, "!": 80, "-": 140, "+": 140}
POSTFIX = 160          # ( [ [[ $ @
# R's parser stack holds 9998 units (rill-tests/parse/test_5.R)
PARSER_CAPACITY = 9998
NAMESPACE = 170        # :: :::
LOWEST = 0

KEYWORD_CONSTANTS = {
    "TRUE": lambda: lgl([True]), "FALSE": lambda: lgl([False]), "NA": lambda: lgl([None]),
    "NA_integer_": lambda: int_([None]), "NA_real_": lambda: dbl([None]),
    "NA_character_": lambda: chr_([None]), "Inf": lambda: dbl([float("inf")]),
    "NaN": lambda: dbl([float("nan")]),
}


class ParseError(Exception):
    """A syntax error, as Rscript reports it: "Error: <message>", or, with a
    call, "Error in <call> : <message>" (the pipe's errors)."""

    def __init__(self, message, call=None):
        Exception.__init__(self, message)
        self.message = message
        self.call = call


class Incomplete(ParseError):
    """The input ended inside a statement: R's "unexpected end of input", and
    the REPL's cue to read another line."""

    def __init__(self):
        ParseError.__init__(self, "unexpected end of input")


def _located(message, line, col):
    return "%s (<input>:%d:%d)" % (message, line, col)


class Parser:
    def __init__(self, src):
        self.src = src
        self.toks = lex(src)
        self.i = 0
        self.stmt_start = self._line_start(self.toks[0].start)
        self.warnings = []   # the literal warnings (1.5L) of the statement just read
        self.units = 0       # R's parser-stack units pending (see expr)

    # ---------------------------------------------------------------- tokens

    def peek(self):
        return self.toks[self.i]

    def take(self):
        t = self.toks[self.i]
        if t.kind != "EOF":
            self.i += 1
        return t

    def _line_start(self, k):
        return self.src.rfind("\n", 0, k) + 1

    def unexpected(self, t):
        """The error R gives at token t, quoting the statement so far."""
        if t.kind == "EOF":
            return Incomplete()
        if t.kind == "ERROR" and t.error:
            return ParseError(_located(*t.error))
        return self._context_error(t.describe(), t.end)

    def _context_error(self, what, end):
        text = self.src[self.stmt_start:end]
        lines = text.split("\n")
        if len(lines) > 1:
            return ParseError('unexpected %s in:\n"%s"' % (what, "\n".join(lines[-2:])))
        return ParseError('unexpected %s in "%s"' % (what, text))

    def push(self, units):
        """Hold `units` more of R's parser stack, refusing as R does before passing its capacity: the check is
        the leaf's (the units plus the operand still to come), made before the frame grows (daybreak3)."""
        if self.units + units + 1 > PARSER_CAPACITY:
            raise ParseError("out of memory while parsing")
        self.units += units

    def expect(self, text):
        """The punctuation the grammar needs next.  A statement-ending newline
        before it is R's "unexpected end of line" (as after a lone `\\`)."""
        t = self.peek()
        if t.nl and t.ctx in (None, "{"):
            raise self._context_error("end of line", self.toks[self.i - 1].end)
        if t.is_op(text):
            return self.take()
        raise self.unexpected(t)

    # ---------------------------------------------------------------- statements

    def statement(self):
        """The next top-level statement, or None at the end of the input."""
        self.warnings = []
        t = self.peek()
        if t.kind == "EOF":
            if t.ctx is not None:
                raise Incomplete()
            return None
        if t.nl:
            self.stmt_start = self._line_start(t.start)
        e = self.expr(LOWEST, True)
        t = self.peek()
        if t.kind == "EOF" or t.nl:
            pass
        elif t.is_op(";"):
            self.take()
            self.stmt_start = t.end
            nxt = self.peek()
            if nxt.nl:
                self.stmt_start = self._line_start(nxt.start)
        else:
            raise self.unexpected(t)
        _check_placeholders(e, None)
        return e

    def statements(self):
        """Every statement (for tests and tools; running code reads them one at a time)."""
        out = []
        while True:
            e = self.statement()
            if e is None:
                return out
            out.append(e)

    # ---------------------------------------------------------------- expressions

    def expr(self, rbp, eq_ok):
        """An expression whose operators bind tighter than rbp.  Operator chains and
        keyword constructs (if, for, while, repeat, function) are frames on an
        explicit stack, not host recursion (design §8.4); only brackets recurse, and
        the lexer stops them at R's 50 levels.  The pending frames are counted in R's
        parser-stack units, and passing R's capacity is its "out of memory while
        parsing" (rill-tests/parse/test_5.R pins each construct's boundary)."""
        base = self.units
        frames = []
        while True:
            # ---- an operand; prefix operators and keywords push a frame and loop
            t = self.take()
            k = t.kind
            if t.kind == "OP" and t.text in UNARY:
                self.push(1)
                frames.append(("unary", t, rbp, eq_ok))
                rbp = UNARY[t.text]
                continue
            if k in ("IF", "WHILE"):
                self.push(2)
                self.expect("(")
                cond = self.expr(LOWEST, False)
                self.expect(")")
                frames.append((k.lower(), cond, rbp, eq_ok))
                rbp, eq_ok = LOWEST, True
                continue
            if k == "FOR":
                self.push(4)
                self.expect("(")
                var = self.peek()
                if var.kind != "SYMBOL":
                    raise self.unexpected(var)
                self.take()
                if self.peek().kind != "IN":
                    raise self.unexpected(self.peek())
                self.take()
                seq = self.expr(LOWEST, False)
                self.expect(")")
                self.units -= 2
                frames.append(("for", (sym(var.text), seq), rbp, eq_ok))
                rbp, eq_ok = LOWEST, True
                continue
            if k == "REPEAT":
                self.push(1)
                frames.append(("repeat", None, rbp, eq_ok))
                rbp, eq_ok = LOWEST, True
                continue
            if k == "FUNCTION" or t.is_op("\\"):
                self.push(2)
                formals = self.formals()
                self.push(3)
                frames.append(("function", formals, rbp, eq_ok))
                rbp, eq_ok = LOWEST, True
                continue
            left = self.atom(t)
            if self.units + 1 > PARSER_CAPACITY:
                raise ParseError("out of memory while parsing")
            # ---- continue with postfix and binary operators, reducing frames as they end
            while True:
                t = self.peek()
                if not (t.kind == "EOF" or t.nl):
                    if t.kind == "OP" and t.text in ("(", "[", "[[", "$", "@") and POSTFIX > rbp:
                        self.take()
                        left = self.postfix(t, left)
                        continue
                    if t.kind == "OP" and t.text in ("::", ":::"):
                        self.take()
                        left = self.namespace(t, left)
                        continue
                    key = t.kind if t.kind in BINARY else (t.text if t.kind == "OP" and t.text in BINARY else None)
                    if key is not None and not (key == "EQ_ASSIGN" and not eq_ok):
                        power, assoc = BINARY[key]
                        if not (power < rbp or (power == rbp and assoc == "left")):
                            self.take()
                            self.push(2)
                            frames.append(("binary", (t, left, self.peek()), rbp, eq_ok))
                            rbp = power if assoc == "left" else power - 1
                            break
                if not frames:
                    self.units = base
                    return left
                kind, data, rbp, eq_ok = frames.pop()
                if kind == "unary":
                    left = Lang(sym(data.text), [(None, left)])
                    self.units -= 1
                elif kind == "binary":
                    op, lhs, first = data
                    left = self.binary(op, lhs, left, first)
                    self.units -= 2
                elif kind == "if":
                    t2 = self.peek()
                    if t2.kind == "ELSE" and (not t2.nl or t2.ctx == "{"):
                        self.take()
                        self.push(2)
                        frames.append(("else", (data, left), rbp, eq_ok))
                        rbp, eq_ok = LOWEST, True
                        break
                    left = Lang(sym("if"), [(None, data), (None, left)])
                    self.units -= 2
                elif kind == "else":
                    cond, body = data
                    left = Lang(sym("if"), [(None, cond), (None, body), (None, left)])
                    self.units -= 4
                elif kind == "for":
                    var, seq = data
                    left = Lang(sym("for"), [(None, var), (None, seq), (None, left)])
                    self.units -= 2
                elif kind == "while":
                    left = Lang(sym("while"), [(None, data), (None, left)])
                    self.units -= 2
                elif kind == "repeat":
                    left = Lang(sym("repeat"), [(None, left)])
                    self.units -= 1
                else:
                    left = Lang(sym("function"), [(None, data), (None, left)])
                    self.units -= 5

    def binary(self, t, left, right, first):
        if t.kind == "RIGHT_ASSIGN":
            return Lang(sym("<-" if t.text == "->" else "<<-"), [(None, right), (None, left)])
        if t.kind == "PIPE":
            return self.pipe(left, right, first.line, first.col)
        return Lang(sym(t.text), [(None, left), (None, right)])

    def pipe(self, lhs, rhs, line, col):
        """`lhs |> rhs` as the call it stands for; errors are located at rhs's start."""
        if not isinstance(rhs, Lang):
            raise ParseError(_located("The pipe operator requires a function call as RHS", line, col), rhs)
        head = _extraction_head(rhs)
        if head is not None:
            head.args[0] = (None, lhs)
            return rhs
        named = [k for k, (name, v) in enumerate(rhs.args) if isinstance(v, Placeholder) and name is not None]
        if any(isinstance(v, Placeholder) and name is None for name, v in rhs.args):
            raise ParseError(_located("pipe placeholder can only be used as a named argument", line, col), rhs)
        if len(named) > 1:
            raise ParseError(_located("pipe placeholder may only appear once", line, col), rhs)
        if named:
            args = list(rhs.args)
            args[named[0]] = (args[named[0]][0], lhs)
            return Lang(rhs.fn, args)
        return Lang(rhs.fn, [(None, lhs)] + rhs.args)

    def atom(self, t):
        """An operand that isn't an operator or keyword construct."""
        k = t.kind
        if k == "NUM_CONST":
            return self.constant(t)
        if k == "STR_CONST":
            return chr_([t.value[1]])
        if k == "SYMBOL":
            if t.text == "" and t.value is not None:
                raise ParseError("attempt to use zero-length variable name")
            return sym(t.text)
        if k == "NULL_CONST":
            return NULL
        if k == "PLACEHOLDER":
            return Placeholder(t.line, 0)
        if k in ("BREAK", "NEXT"):
            return Lang(sym(t.text), [])
        if t.is_op("("):
            self.push(1)
            e = self.expr(LOWEST, True)
            self.expect(")")
            self.units -= 1
            return Lang(sym("("), [(None, e)])
        if t.is_op("{"):
            self.push(1)
            e = self.braces()
            self.units -= 1
            return e
        if k == "EOF":
            raise Incomplete()
        self.i -= 1
        raise self.unexpected(t)

    def constant(self, t):
        kind, v, warning = t.value
        if warning:
            self.warnings.append(warning)
        if kind == "keyword":
            return KEYWORD_CONSTANTS[v]()
        if kind == "integer":
            return int_([v])
        if kind == "complex":
            return cplx([v])
        return dbl([v])

    def braces(self):
        body = []
        while True:
            t = self.peek()
            if t.is_op("}"):
                self.take()
                return Lang(sym("{"), body)
            if t.kind == "EOF":
                raise Incomplete()
            body.append((None, self.expr(LOWEST, True)))
            t = self.peek()
            if t.is_op(";"):
                self.take()
            elif not (t.nl or t.is_op("}") or t.kind == "EOF"):
                raise self.unexpected(t)

    def formals(self):
        """`(x, y = 2, ...)` after `function` or `\\`."""
        self.expect("(")
        items = []
        seen = set()
        while True:
            a = self.peek()
            if a.is_op(")") and not items:
                self.take()
                return Formals(items)
            if a.kind != "SYMBOL":
                raise self.unexpected(a)
            self.take()
            if a.text in seen:
                raise ParseError(_located("repeated formal argument '%s'" % a.text, a.line, a.col))
            seen.add(a.text)
            default = MISSING
            if self.peek().kind == "EQ_ASSIGN":
                self.take()
                default = self.expr(LOWEST, False)
            items.append((a.text, default))
            nxt = self.peek()
            if nxt.is_op(","):
                self.take()
                continue
            if nxt.is_op(")"):
                self.take()
                return Formals(items)
            raise self.unexpected(nxt)

    def postfix(self, t, left):
        op = t.text
        if op in ("(", "[", "[["):
            self.push(2)
            args = self.args({"(": ")", "[": "]", "[[": "]]"}[op])
            self.units -= 2
            return Lang(left, args) if op == "(" else Lang(sym(op), [(None, left)] + args)
        nt = self.peek()
        if nt.kind == "SYMBOL":
            self.take()
            name = sym(nt.text)
        elif nt.kind == "STR_CONST":
            self.take()
            name = chr_([nt.value[1]])
        else:
            raise self.unexpected(nt)
        return Lang(sym(op), [(None, left), (None, name)])

    def namespace(self, t, left):
        if not isinstance(left, Sym) and not _is_string(left):
            raise self.unexpected(t)
        nt = self.peek()
        if nt.kind == "SYMBOL":
            self.take()
            name = sym(nt.text)
        elif nt.kind == "STR_CONST":
            self.take()
            name = chr_([nt.value[1]])
        else:
            raise self.unexpected(nt)
        return Lang(sym(t.text), [(None, left), (None, name)])

    def args(self, close):
        """A call's or index's arguments up to `close`: (name or None, value) pairs,
        an empty slot being MISSING (f(1, ) has two arguments)."""
        out = []
        filled = False
        while True:
            t = self.peek()
            if t.kind == "EOF":
                raise Incomplete()
            if t.is_op(close):
                self.take()
                if out and not filled:
                    out.append((None, MISSING))
                return out
            if t.is_op(","):
                self.take()
                if not filled:
                    out.append((None, MISSING))
                filled = False
                continue
            if filled:
                raise self.unexpected(t)
            name = None
            nt = self.toks[self.i + 1] if self.i + 1 < len(self.toks) else t
            if t.kind in ("SYMBOL", "STR_CONST", "NULL_CONST") and nt.kind == "EQ_ASSIGN":
                name = t.text if t.kind == "SYMBOL" else ("NULL" if t.kind == "NULL_CONST" else t.value[1])
                self.take()
                self.take()
                after = self.peek()
                if after.is_op(",") or after.is_op(close):
                    out.append((name, MISSING))
                    filled = True
                    continue
            out.append((name, self.expr(LOWEST, False)))
            filled = True


def _is_string(x):
    return isinstance(x, Vector) and x.type == "character"


def _extraction_head(rhs):
    """For `x |> _$a$b`, the innermost extraction whose object is the placeholder."""
    node = rhs
    while isinstance(node, Lang) and isinstance(node.fn, Sym) and node.fn.name in ("$", "[[", "[", "@") and node.args:
        first = node.args[0][1]
        if isinstance(first, Placeholder):
            return node
        node = first
    return None


def _check_placeholders(root, parent):
    """A placeholder left after the pipes were rewritten is R's "invalid use"
    (an explicit stack: a statement's tree can be thousands of levels deep)."""
    stack = [(root, parent)]
    while stack:
        e, parent = stack.pop()
        if isinstance(e, Placeholder):
            raise ParseError(_located("invalid use of pipe placeholder", e.line, 0), parent if parent is not None else e)
        if isinstance(e, Lang):
            stack.append((e.fn, e))
            stack.extend((v, e) for _, v in e.args)
        elif isinstance(e, Formals):
            stack.extend((v, parent) for _, v in e.items)


def parse(src):
    """Every statement of src; raises ParseError (or Incomplete) at the first error."""
    return Parser(src).statements()


def is_incomplete(src):
    """Whether src ends inside a statement (the REPL then reads another line)."""
    try:
        parse(src)
    except Incomplete:
        return True
    except ParseError:
        return False
    return False
