"""Rill's lexer: R source text to tokens (design/rill.md §4).

The rules follow R's documentation (?Syntax, ?Quotes, ?NumericConstants,
?Reserved) and, for the texts of errors and warnings, what R 4.5.3 prints
for the cases in rill-tests/parse/.  A token remembers where it starts and
ends, so the parser can quote the statement's text in "unexpected ..."
messages as R does, and whether a newline that ends a statement came before
it (a newline counts at the top level and directly inside braces, not
inside parentheses or brackets).

A lexical error doesn't stop the statements before it: it becomes an ERROR
token at its place (followed by EOF), so Rscript's statement-at-a-time loop
still runs what comes first.
"""

KEYWORDS = {
    "if": "IF", "else": "ELSE", "repeat": "REPEAT", "while": "WHILE", "function": "FUNCTION",
    "for": "FOR", "in": "IN", "next": "NEXT", "break": "BREAK",
    "TRUE": "NUM_CONST", "FALSE": "NUM_CONST", "NULL": "NULL_CONST", "Inf": "NUM_CONST",
    "NaN": "NUM_CONST", "NA": "NUM_CONST", "NA_integer_": "NUM_CONST", "NA_real_": "NUM_CONST",
    "NA_character_": "NUM_CONST",
}

# operators, longest first ("**" is "^": ?Arithmetic)
OPERATORS = [
    ":::", "<<-", "->>",
    "|>", "<-", "->", "<=", ">=", "==", "!=", "&&", "||", "::", ":=", "[[", "**",
    "+", "-", "*", "/", "^", "<", ">", "!", "&", "|", "~", "?", ":", "=", "$", "@",
    "(", ")", "{", "}", "[", "]", ",", ";", "\\",
]
# operators that begin a longer one: R's lexer ends them by reading the next character, and gives it back
# (it shows in an "unexpected" message's window: rill-tests/parse/test_6.R)
EXTENDABLE = frozenset(op for op in OPERATORS if any(o != op and o.startswith(op) for o in OPERATORS))
OP_KIND = {"<-": "LEFT_ASSIGN", "<<-": "LEFT_ASSIGN", ":=": "LEFT_ASSIGN", "->": "RIGHT_ASSIGN",
           "->>": "RIGHT_ASSIGN", "=": "EQ_ASSIGN", "|>": "PIPE"}

# how R names a token in "unexpected ..." (recorded: rill-tests/parse/test_2.R, test_3.R)
DESCRIBE = {"NUM_CONST": "numeric constant", "STR_CONST": "string constant", "SYMBOL": "symbol",
            "NULL_CONST": "'NULL'", "LEFT_ASSIGN": "assignment", "RIGHT_ASSIGN": "'->'",
            "SPECIAL": "SPECIAL", "PLACEHOLDER": "input", "ERROR": "input", "EOF": "end of input",
            "NEWLINE": "end of line"}

INT_MAX = 2147483647
# R's lexer holds 50 open brackets; the 51st is "contextstack overflow" (rill-tests/parse/test_4.R)
CONTEXT_DEPTH = 50
HEX = "0123456789abcdefABCDEF"


class Tok:
    __slots__ = ("kind", "text", "value", "start", "end", "line", "col", "nl", "ctx", "error")

    def __init__(self, kind, text, start, end, line, col):
        self.kind = kind      # NUM_CONST, STR_CONST, SYMBOL, OP, a keyword's kind, ...
        self.text = text      # the operator or keyword itself; a symbol's name; the source text otherwise
        self.value = None     # a constant's value, for the parser
        self.start = start
        self.end = end
        self.line = line
        self.col = col
        self.nl = False       # a statement-ending newline came before it
        self.ctx = None       # the innermost open bracket: None, "{", "(", "[" or "[["
        self.error = None     # an ERROR token's (message, line, col); None for "unexpected input"

    def describe(self):
        if self.kind in DESCRIBE:
            return DESCRIBE[self.kind]
        if self.text == "\\":
            return "'\\\\'"  # R doubles a lone backslash here
        return "'%s'" % self.text

    def lookahead(self, src):
        """How many characters past this token R's lexer read to end it (0 or 1): a name, keyword or number
        (but not one ending in L or i), or an operator that begins a longer one; never past the source's end."""
        # (reads the token's first and last characters only: a token may be long; operators are at most 3)
        if self.end >= len(src) or self.kind in ("STR_CONST", "SPECIAL", "PLACEHOLDER", "ERROR", "EOF"):
            return 0
        last = src[self.end - 1]
        if src[self.start] == "`" or (self.kind == "NUM_CONST" and last in "Li"):
            return 0
        if _ident_char(last):
            return 1
        return 1 if self.end - self.start <= 3 and src[self.start:self.end] in EXTENDABLE else 0

    def is_op(self, text):
        return self.kind not in ("SYMBOL", "STR_CONST", "NUM_CONST", "ERROR", "EOF") and self.text == text

    def __repr__(self):
        return "Tok(%s %r)" % (self.kind, self.text)


def _ident_start(c):
    return c.isalpha() or c == "."


def _ident_char(c):
    return c.isalnum() or c in "._"


class _Lexer:
    def __init__(self, src):
        self.src = src
        self.toks = []
        self.line = 1
        self.line_start = 0
        self.stack = []
        self.nl = False

    def add(self, kind, text, start, end, line, col):
        t = Tok(kind, text, start, end, line, col)
        t.nl, self.nl = self.nl, False
        t.ctx = (self.stack[-1] if self.stack[-1] != "[[i" else "[[") if self.stack else None
        self.toks.append(t)
        return t

    def advance_lines(self, i, j):
        """Account for newlines inside a token spanning src[i:j]."""
        k = self.src.count("\n", i, j)
        if k:
            self.line += k
            self.line_start = self.src.rindex("\n", i, j) + 1

    def where(self, k):
        """The (line, column) of src[k], columns from 1."""
        nl = self.src.rfind("\n", 0, k)
        return self.src.count("\n", 0, k) + 1, k - (nl + 1) + 1

    def eof(self, incomplete=False):
        n = len(self.src)
        t = self.add("EOF", "", n, n, self.line, n - self.line_start + 1)
        if incomplete:
            t.ctx = '"'  # inside an unterminated string: the statement isn't complete
        return self.toks

    def error(self, start, end, err):
        t = self.add("ERROR", self.src[start:end], start, end, *self.where(start))
        t.error = err
        return self.eof()

    def run(self):
        src = self.src
        n = len(src)
        i = 0
        while i < n:
            c = src[i]
            if c == "\n":
                if not self.stack or self.stack[-1] == "{":
                    self.nl = True
                i += 1
                self.line, self.line_start = self.line + 1, i
                continue
            if c in " \t\r\f\v":
                i += 1
                continue
            if c == "#":
                while i < n and src[i] != "\n":
                    i += 1
                continue
            line, col = self.line, i - self.line_start + 1
            if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
                j, value = number(src, i)
                if value is None:
                    return self.error(i, j, None)
                self.add("NUM_CONST", src[i:j], i, j, line, col).value = value
                i = j
                continue
            if c in "rR" and i + 1 < n and src[i + 1] in "\"'":
                j, value, err = raw_string(src, i)
                if err == "incomplete":
                    return self.eof(True)
                if err:
                    return self.error(i, j, (err,) + self.where(j))
                self.add("STR_CONST", src[i:j], i, j, line, col).value = ("character", value, None)
                self.advance_lines(i, j)
                i = j
                continue
            if _ident_start(c):
                j = i
                while j < n and _ident_char(src[j]):
                    j += 1
                w = src[i:j]
                t = self.add(KEYWORDS.get(w, "SYMBOL"), w, i, j, line, col)
                if t.kind == "NUM_CONST":
                    t.value = ("keyword", w, None)
                i = j
                continue
            if c in "\"'":
                j, value, err = string(src, i)
                if err == "incomplete":
                    return self.eof(True)
                if err:
                    msg, k = err
                    return self.error(i, j, (msg,) + self.where(k))
                self.add("STR_CONST", src[i:j], i, j, line, col).value = ("character", value, None)
                self.advance_lines(i, j)
                i = j
                continue
            if c == "`":
                j = i + 1
                buf = []
                while j < n and src[j] != "`":
                    if src[j] == "\\" and j + 1 < n:
                        j += 1
                    buf.append(src[j])
                    j += 1
                if j >= n:
                    return self.eof(True)
                self.add("SYMBOL", "".join(buf), i, j + 1, line, col).value = ("backtick", None, None)
                self.advance_lines(i, j)
                i = j + 1
                continue
            if c == "%":
                j = i + 1
                while j < n and src[j] not in "%\n":
                    j += 1
                if j >= n or src[j] != "%":
                    return self.error(i, j, None)
                self.add("SPECIAL", src[i:j + 1], i, j + 1, line, col)
                i = j + 1
                continue
            if c == "_":
                self.add("PLACEHOLDER", "_", i, i + 1, line, col)
                i += 1
                continue
            op = None
            for o in OPERATORS:
                if src.startswith(o, i):
                    op = o
                    break
            if op is None:
                return self.error(i, i + 1, None)
            if op == "]" and self.stack and self.stack[-1] == "[[i":
                # `[[` opens two levels: the first `]` closes the inner one and makes
                # no token, the second makes `]]` (so x[[1] is still incomplete, as in R)
                self.stack.pop()
                i += 1
                continue
            if op == "]" and self.stack and self.stack[-1] == "[[":
                self.stack.pop()
                self.add("OP", "]]", i, i + 1, line, col)
                i += 1
                continue
            self.add(OP_KIND.get(op, "OP"), "^" if op == "**" else op, i, i + len(op), line, col)
            if op in ("(", "{", "[", "[["):
                if sum(1 for b in self.stack if b != "[[i") >= CONTEXT_DEPTH:
                    self.toks.pop()
                    return self.error(i, i + len(op), ("contextstack overflow",) + self.where(i))
            if op == "[[":
                self.stack += ["[[", "[[i"]
            elif op in ("(", "{", "["):
                self.stack.append(op)
            elif op in (")", "}", "]") and self.stack:
                self.stack.pop()
            i += len(op)
        return self.eof()


def lex(src):
    """All of src's tokens, ending with EOF (after an ERROR token, if any)."""
    return _Lexer(src).run()


def number(src, i):
    """The numeric constant at i: (end, value), where value is (type, python value,
    warning or None), or None for malformed input (R's "unexpected input")."""
    n = len(src)
    j = i
    hexnum = src.startswith(("0x", "0X"), i)
    if hexnum:
        j = i + 2
        k = j
        while j < n and src[j] in HEX:
            j += 1
        mant = src[k:j]
        frac = ""
        if j < n and src[j] == ".":
            j += 1
            k = j
            while j < n and src[j] in HEX:
                j += 1
            frac = src[k:j]
        if not mant and not frac:
            return j, None
        exp = 0
        if j < n and src[j] in "pP":
            k = j + 1
            if k < n and src[k] in "+-":
                k += 1
            if not (k < n and src[k].isdigit()):
                return k, None
            e0 = j + 1
            j = k
            while j < n and src[j].isdigit():
                j += 1
            exp = int(src[e0:j])
        val = (int(mant or "0", 16) + (int(frac, 16) / 16 ** len(frac) if frac else 0)) * 2.0 ** exp
        has_dot = False
    else:
        while j < n and src[j].isdigit():
            j += 1
        if j < n and src[j] == ".":
            j += 1
            while j < n and src[j].isdigit():
                j += 1
        if j < n and src[j] in "eE":
            k = j + 1
            if k < n and src[k] in "+-":
                k += 1
            if not (k < n and src[k].isdigit()):
                return k, None
            j = k
            while j < n and src[j].isdigit():
                j += 1
        val = float(src[i:j])
        has_dot = "." in src[i:j]
    if j < n and src[j] == "L":
        text = src[i:j + 1]
        finite = val == val and val not in (float("inf"), float("-inf"))
        integral = finite and val == int(val)
        if integral and abs(val) <= INT_MAX:
            if has_dot:
                return j + 1, ("integer", int(val), "integer literal %s contains unnecessary decimal point" % text)
            return j + 1, ("integer", int(val), None)
        if has_dot and not integral:
            return j + 1, ("double", float(val), "integer literal %s contains decimal; using numeric value" % text)
        return j + 1, ("double", float(val), "non-integer value %s qualified with L; using numeric value" % text)
    if j < n and src[j] == "i":
        return j + 1, ("complex", complex(0, val), None)
    return j, ("double", float(val), None)


ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "a": "\a", "f": "\f", "v": "\v",
           "\\": "\\", "'": "'", '"': '"', "`": "`", " ": " ", "\n": "\n"}


def string(src, i):
    """The quoted string at i: (end, value, error), where error is None,
    "incomplete", or (message, offset) with the offset R's location names."""
    n = len(src)
    q = src[i]
    j = i + 1
    buf = []
    unicode_used = octhex_used = False
    while j < n and src[j] != q:
        c = src[j]
        if c != "\\":
            buf.append(c)
            j += 1
            continue
        j += 1
        if j >= n:
            return n, None, "incomplete"
        e = src[j]
        if e in ESCAPES:
            buf.append(ESCAPES[e])
            j += 1
        elif e in "01234567":
            k = j
            while k < n and k - j < 3 and src[k] in "01234567":
                k += 1
            v = int(src[j:k], 8)
            if v == 0:
                return k, None, ("nul character not allowed", j)
            buf.append(chr(v))
            octhex_used = True
            j = k
        elif e == "x":
            k = j + 1
            while k < n and k - j - 1 < 2 and src[k] in HEX:
                k += 1
            if k == j + 1:
                return k, None, ("'\\x' used without hex digits in character string", j)
            v = int(src[j + 1:k], 16)
            if v == 0:
                return k, None, ("nul character not allowed", j)
            buf.append(chr(v))
            octhex_used = True
            j = k
        elif e in "uU":
            lim = 4 if e == "u" else 8
            k = j + 1
            braced = k < n and src[k] == "{"
            if braced:
                k += 1
            d0 = k
            while k < n and k - d0 < lim and src[k] in HEX:
                k += 1
            if k == d0:
                return k, None, ("'\\%s' used without hex digits in character string" % e, j)
            digits = src[d0:k]
            if braced and (k >= n or src[k] != "}"):
                return k, None, ("invalid \\%s{%s} sequence" % (e, "x" * lim), k)
            v = int(digits, 16)
            if v > 0x10FFFF:
                return k, None, ("invalid \\%s{%s} value %s" % (e, "x" * lim, digits), k)
            if 0xD800 <= v <= 0xDFFF:
                # R 4.5.3 keeps the bytes, with two warnings (rill-tests/parse/test_6.R): refused when reached
                from .eval import NotSupported
                return k, None, (NotSupported("an unpaired surrogate escape"), j)
            if v == 0:
                return k, None, ("nul character not allowed", j)
            buf.append(chr(v))
            unicode_used = True
            j = k + 1 if braced else k
        else:
            return j + 1, None, ("'\\%s' is an unrecognized escape in character string" % e, j)
    if j >= n:
        return n, None, "incomplete"
    if unicode_used and octhex_used:
        return j + 1, None, ("mixing Unicode and octal/hex escapes in a string is not allowed", j)
    return j + 1, "".join(buf), None


def raw_string(src, i):
    """r"(...)", with optional dashes (?Quotes): (end, value, error)."""
    n = len(src)
    q = src[i + 1]
    j = i + 2
    while j < n and src[j] == "-":
        j += 1
    dashes = j - (i + 2)
    if j >= n:
        return n, None, "incomplete"
    closer = {"(": ")", "[": "]", "{": "}"}.get(src[j])
    if closer is None:
        return j, None, "malformed raw string literal"
    end = closer + "-" * dashes + q
    k = src.find(end, j + 1)
    if k < 0:
        return n, None, "incomplete"
    return k + len(end), src[j + 1:k], None
