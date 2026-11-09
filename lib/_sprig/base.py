"""Sprig's builtins, S1.1's part (design/sprig-mvp.md §3, §5, §9).

Exact arithmetic is Python's integers and fractions, and machine reals are
floats; Sage's symbolic layer enters with S2's mathematics (math.py).  Each
builtin is registered by name in BUILTINS (one assignment of a function to
a quoted name per line, or a loop over a tuple of names) and its attributes
in ATTRIBUTES, the spellings scripts/sprig-gates.mjs reads.

The functions that would reach files, the network or other programs are
refused before any argument is evaluated, with Sprig's message (§5.6, §9).
"""

import re
import fractions

from . import mem
from .eval import Tail
from .expr import (Expr, Sym, TRUE, FALSE, NULL, LIST, FAILED, boolean, is_number, is_exact, num, head_of,
                   same, compare, _coeff_term)
from .fmt import input_form

Fraction = fractions.Fraction

PLUS, TIMES, POWER = Sym("Plus"), Sym("Times"), Sym("Power")
DIRECTED_INFINITY = Sym("DirectedInfinity")
COMPLEX_INFINITY = Expr(DIRECTED_INFINITY)
INDETERMINATE = Sym("Indeterminate")
NAME = re.compile(r"(?:[A-Za-z$][A-Za-z0-9$]*`)*[A-Za-z$][A-Za-z0-9$]*\Z")

BUILTINS = {}
ATTRIBUTES = {}
MESSAGES = {
    ("Power", "infy"): "Infinite expression `1` encountered.",
    ("Power", "indet"): "Indeterminate expression `1` encountered.",
    ("Infinity", "indet"): "Indeterminate expression `1` encountered.",
    ("Set", "wrsym"): "Symbol `1` is Protected.",
    ("Symbol", "symname"): "The string `1` cannot be used for a symbol name.",
    ("Syntax", "sntxf"): "\"`1`\" cannot be followed by \"`2`\" (line `3` of \"`4`\").",
    ("Syntax", "sntxi"): "Incomplete expression; more input is needed (line `1` of \"`2`\").",
    ("Syntax", "sntxb"): "Expression cannot begin with \"`1`\" (line `2` of \"`3`\").",
    # Sprig's own sentences, word for word (design §5.6)
    ("General", "nesting"): "The evaluation is nested too deeply to continue here.",
    ("General", "nonetwork"): "`1` can't reach the network: it is off for documents.",
    ("General", "noprocess"): "`1` can't start a program: Sprig doesn't run programs.",
    ("General", "memory"): "`1` needs more memory than this session allows: `2`.",
    ("General", "notyet"): "`1` isn't available in Sprig yet.",
}


def _is_cinf(x):
    return type(x) is Expr and x.head is DIRECTED_INFINITY and not x.args


def _bits(x):
    if type(x) is int:
        return x.bit_length()
    if type(x) is Fraction:
        return x.numerator.bit_length() + x.denominator.bit_length()
    return 64


def _with_int_reservation(bits, name, f):
    """f(), with an exact result of about `bits` bits reserved first."""
    with mem.reserve(mem.int_bytes(bits), "An exact number of %d bits" % bits, name):
        return f()


# ---------------------------------------------------------------- arithmetic

def _plus(sess, e):
    args = e.args
    if any(x is INDETERMINATE for x in args):
        return INDETERMINATE
    infs = [x for x in args if _is_cinf(x)]
    if infs:
        if len(infs) > 1:
            sess.message("Infinity", "indet", "ComplexInfinity + ComplexInfinity")
            return INDETERMINATE
        return COMPLEX_INFINITY
    total = 0
    has_number = False
    terms = {}
    order = []
    for x in args:
        if is_number(x):
            total = total + x
            has_number = True
            continue
        t, c = _coeff_term(x)
        if c is None:
            c = 1
        if t in terms:
            terms[t] = terms[t] + c
        else:
            terms[t] = c
            order.append(t)
    items = []
    if has_number and (total != 0 or type(total) is float and not order):
        items.append(num(total))
    for t in order:
        c = terms[t]
        if c == 0 and type(c) is not float:
            continue
        if c == 1 and type(c) is not float:
            items.append(t)
        elif type(t) is Expr and t.head is TIMES:
            items.append(Expr(TIMES, num(c), *t.args))
        else:
            items.append(Expr(TIMES, num(c), t))
    if not items:
        return num(total) if has_number else 0
    if len(items) == 1:
        return items[0]
    return Expr(PLUS, *_sorted(items))


def _sorted(items):
    from .expr import sort_canonical
    return sort_canonical(items)


def _power_parts(f):
    if type(f) is Expr and f.head is POWER and len(f.args) == 2:
        return f.args[0], f.args[1]
    return f, 1


def _times(sess, e):
    args = e.args
    if any(x is INDETERMINATE for x in args):
        return INDETERMINATE
    coeff = 1
    bits = 0
    rest = []
    for x in args:
        if is_number(x):
            bits += _bits(x)
            if bits > 1 << 20:
                coeff = _with_int_reservation(bits, "Times", lambda: coeff * x)
            else:
                coeff = coeff * x
        else:
            rest.append(x)
    infs = [x for x in rest if _is_cinf(x)]
    if infs:
        if coeff == 0:
            sess.message("Infinity", "indet", "0 ComplexInfinity")
            return INDETERMINATE
        return COMPLEX_INFINITY
    if coeff == 0:
        return num(coeff) if type(coeff) is not float else 0.0
    bases = {}
    order = []
    for x in rest:
        b, ex = _power_parts(x)
        if b in bases:
            prev = bases[b]
            bases[b] = prev + ex if is_number(prev) and is_number(ex) else Expr(PLUS, prev, ex)
        else:
            bases[b] = ex
            order.append(b)
    items = []
    for b in order:
        ex = bases[b]
        if is_number(ex) and ex == 0 and type(ex) is not float:
            continue
        if is_number(ex) and ex == 1 and type(ex) is not float:
            items.append(b)
        else:
            items.append(Expr(POWER, b, num(ex) if is_number(ex) else ex))
    coeff = num(coeff)
    if not items:
        return coeff
    if coeff == 1 and type(coeff) is not float:
        if len(items) == 1:
            return items[0]
        return Expr(TIMES, *_sorted(items))
    return Expr(TIMES, coeff, *_sorted(items))


def _iroot(n, q):
    """The integer q-th root of n >= 0 when n is a perfect q-th power, else None."""
    if n < 2:
        return n
    lo, hi = 1, 1 << (n.bit_length() // q + 1)
    while lo <= hi:
        mid = (lo + hi) // 2
        p = mid ** q
        if p == n:
            return mid
        if p < n:
            lo = mid + 1
        else:
            hi = mid - 1
    return None


def _exact_root(b, p, q):
    """b^(p/q) for an exact b > 0 when b's q-th root is exact, else None."""
    if type(b) is int:
        r = _iroot(b, q)
        return None if r is None else Expr(POWER, r, p)
    rn, rd = _iroot(b.numerator, q), _iroot(b.denominator, q)
    if rn is None or rd is None:
        return None
    return Expr(POWER, Fraction(rn, rd), p)


def _power(sess, e):
    if len(e.args) != 2:
        return None
    b, ex = e.args
    if ex is INDETERMINATE or b is INDETERMINATE:
        return INDETERMINATE
    if is_number(ex) and ex == 1 and type(ex) is not float:
        return b
    if is_number(ex) and ex == 0 and type(ex) is not float:
        if is_number(b) and b == 0:
            sess.message("Power", "indet", "0 ^ 0")
            return INDETERMINATE
        return 1
    if b == 1 and type(b) is int:
        return 1
    if is_number(b) and is_number(ex):
        return _numeric_power(sess, b, ex)
    if type(b) is Expr and b.head is POWER and len(b.args) == 2 and type(ex) is int:
        inner = b.args[1]
        if is_number(inner):
            return Expr(POWER, b.args[0], num(inner * ex))
        return Expr(POWER, b.args[0], Expr(TIMES, inner, ex))
    if type(b) is Expr and b.head is TIMES and type(ex) is int:
        return Expr(TIMES, *[Expr(POWER, f, ex) for f in b.args])
    return None


def _numeric_power(sess, b, ex):
    if type(ex) is int:
        if b == 0 and ex < 0:
            sess.message("Power", "infy", "1 / 0" if ex == -1 else "1 / 0^%d" % -ex)
            return COMPLEX_INFINITY
        if type(b) is float:
            return b ** ex
        bits = _bits(b) * abs(ex)
        r = _with_int_reservation(bits, "Power", lambda: Fraction(b) ** ex)
        return num(r)
    if type(ex) is Fraction:
        if type(b) is float:
            return b ** float(ex) if b >= 0 else None
        if b == 0:
            if ex < 0:
                sess.message("Power", "infy", "1 / 0^%s" % input_form(-ex))
                return COMPLEX_INFINITY
            return 0
        if b < 0:
            return None
        whole, frac = divmod(ex.numerator, ex.denominator)
        if whole:
            # b^(w + f/q) = b^w b^(f/q), so a perfect power shows its root (8^(3/2) = 8 Sqrt[8])
            return Expr(TIMES, Expr(POWER, b, whole), Expr(POWER, b, Fraction(frac, ex.denominator)))
        return _exact_root(b, ex.numerator, ex.denominator)
    # a Real exponent
    if b < 0:
        return None
    if b == 0:
        return 0.0 if ex > 0 else None
    return float(b) ** ex


def _sqrt(sess, e):
    if len(e.args) == 1:
        return Expr(POWER, e.args[0], Fraction(1, 2))
    return None


BUILTINS["Plus"] = _plus
BUILTINS["Times"] = _times
BUILTINS["Power"] = _power
BUILTINS["Sqrt"] = _sqrt
ATTRIBUTES["Plus"] = ("Flat", "Listable", "NumericFunction", "OneIdentity", "Orderless", "Protected")
ATTRIBUTES["Times"] = ("Flat", "Listable", "NumericFunction", "OneIdentity", "Orderless", "Protected")
ATTRIBUTES["Power"] = ("Listable", "NumericFunction", "OneIdentity", "Protected")
ATTRIBUTES["Sqrt"] = ("Listable", "NumericFunction", "Protected")


# ---------------------------------------------------------------- comparison and logic

def _numbers(args):
    return all(is_number(x) for x in args)


def _equal(sess, e):
    a = e.args
    if len(a) < 2:
        return TRUE
    if _numbers(a):
        return boolean(all(a[i] == a[i + 1] for i in range(len(a) - 1)))
    if all(same(a[i], a[i + 1]) for i in range(len(a) - 1)):
        return TRUE
    if all(type(x) is str for x in a) or all(x in (TRUE, FALSE) for x in a):
        return FALSE
    return None


def _unequal(sess, e):
    a = e.args
    if len(a) != 2:
        return None
    r = _equal(sess, Expr("Equal", *a))
    return None if r is None else boolean(r is FALSE)


def _order(test):
    def f(sess, e):
        a = e.args
        if len(a) < 2:
            return TRUE
        if _numbers(a):
            return boolean(all(test(a[i], a[i + 1]) for i in range(len(a) - 1)))
        return None
    return f


def _sameq(sess, e):
    a = e.args
    return boolean(all(same(a[i], a[i + 1]) for i in range(len(a) - 1)))


def _unsameq(sess, e):
    a = e.args
    return boolean(not all(same(a[i], a[i + 1]) for i in range(len(a) - 1)))


def _not(sess, e):
    if len(e.args) == 1:
        if e.args[0] is TRUE:
            return FALSE
        if e.args[0] is FALSE:
            return TRUE
    return None


def _and(sess, e):
    """And, evaluating its arguments in order until one is False."""
    left = []
    for x in e.args:
        v = yield ("eval", x)
        if v is FALSE:
            return FALSE
        if v is not TRUE:
            left.append(v)
    if not left:
        return TRUE
    return left[0] if len(left) == 1 else Expr("And", *left)


def _or(sess, e):
    """Or, evaluating its arguments in order until one is True."""
    left = []
    for x in e.args:
        v = yield ("eval", x)
        if v is TRUE:
            return TRUE
        if v is not FALSE:
            left.append(v)
    if not left:
        return FALSE
    return left[0] if len(left) == 1 else Expr("Or", *left)


BUILTINS["Equal"] = _equal
BUILTINS["Unequal"] = _unequal
_less = _order(lambda x, y: x < y)
_greater = _order(lambda x, y: x > y)
_less_equal = _order(lambda x, y: x <= y)
_greater_equal = _order(lambda x, y: x >= y)
BUILTINS["Less"] = _less
BUILTINS["Greater"] = _greater
BUILTINS["LessEqual"] = _less_equal
BUILTINS["GreaterEqual"] = _greater_equal
BUILTINS["SameQ"] = _sameq
BUILTINS["UnsameQ"] = _unsameq
BUILTINS["Not"] = _not
BUILTINS["And"] = _and
BUILTINS["Or"] = _or
for _n in ("Equal", "Unequal", "Less", "Greater", "LessEqual", "GreaterEqual", "SameQ", "UnsameQ", "Not"):
    ATTRIBUTES[_n] = ("Protected",)
ATTRIBUTES["And"] = ("Flat", "HoldAll", "OneIdentity", "Protected")
ATTRIBUTES["Or"] = ("Flat", "HoldAll", "OneIdentity", "Protected")


# ---------------------------------------------------------------- structure

def _head(sess, e):
    if len(e.args) == 1:
        return head_of(e.args[0])
    return None


def _length(sess, e):
    if len(e.args) == 1:
        x = e.args[0]
        return len(x.args) if type(x) is Expr else 0
    return None


BUILTINS["Head"] = _head
BUILTINS["Length"] = _length
ATTRIBUTES["Head"] = ("Protected",)
ATTRIBUTES["Length"] = ("Protected",)
ATTRIBUTES["Hold"] = ("HoldAll", "Protected")
ATTRIBUTES["HoldForm"] = ("HoldAll", "Protected")
ATTRIBUTES["FullForm"] = ("Protected",)
ATTRIBUTES["InputForm"] = ("Protected",)
ATTRIBUTES["List"] = ("Locked", "Protected")
ATTRIBUTES["Sequence"] = ("Protected",)


def _range(sess, e):
    a = e.args
    if not 1 <= len(a) <= 3 or not all(is_exact(x) for x in a):
        return None
    lo, hi, step = (1, a[0], 1) if len(a) == 1 else (a[0], a[1], a[2] if len(a) == 3 else 1)
    if step == 0:
        return None
    n = (hi - lo) // step + 1
    n = max(0, int(n))
    with mem.reserve(n * mem.NODE_BYTES, "A list of %d numbers" % n, "Range"):
        items = []
        x = Fraction(lo)
        for _ in range(n):
            items.append(num(x))
            x += step
        return Expr(LIST, *items)


BUILTINS["Range"] = _range
ATTRIBUTES["Range"] = ("Listable", "Protected")


# ---------------------------------------------------------------- evaluation control

def _compound(sess, e):
    """a; b; c: each in turn; the last in the call's place."""
    a = e.args
    if not a:
        return NULL
    for x in a[:-1]:
        yield ("eval", x)
    return Tail(a[-1])


PROTECTED_SYMBOLS = {"True", "False", "Null", "Indeterminate", "Pi", "E", "I", "Infinity", "ComplexInfinity"}


def _protected(sym):
    n = sym.name
    return n in BUILTINS or n in ATTRIBUTES or n in PROTECTED_SYMBOLS or n in REFUSED


def _set(sess, e):
    if len(e.args) != 2:
        return None
    lhs, rhs = e.args
    if type(lhs) is not Sym:
        sess.message("Set", "notyet", "Defining a function by Set")
        return FAILED
    if _protected(lhs):
        sess.message("Set", "wrsym", lhs.name)
        return rhs
    sess.own[lhs] = rhs
    return rhs


def _setdelayed(sess, e):
    if len(e.args) != 2:
        return None
    lhs, rhs = e.args
    if type(lhs) is not Sym:
        sess.message("SetDelayed", "notyet", "Defining a function by SetDelayed")
        return FAILED
    if _protected(lhs):
        sess.message("SetDelayed", "wrsym", lhs.name)
        return FAILED
    sess.own[lhs] = rhs
    return NULL


BUILTINS["CompoundExpression"] = _compound
BUILTINS["Set"] = _set
BUILTINS["SetDelayed"] = _setdelayed
ATTRIBUTES["CompoundExpression"] = ("HoldAll", "Protected")
ATTRIBUTES["Set"] = ("HoldFirst", "Protected", "SequenceHold")
ATTRIBUTES["SetDelayed"] = ("HoldAll", "Protected", "SequenceHold")


# ---------------------------------------------------------------- printing and strings

def text_of(x):
    """Print's text of x: a string as itself, anything else as InputForm (S1.3 gives OutputForm)."""
    if type(x) is str:
        return x
    with mem.reserve((x.size if type(x) is Expr else 1) * mem.FORMAT_BYTES_PER_NODE, "Formatting an expression", "Print"):
        return input_form(x)


def _print(sess, e):
    sess.write_out("".join(text_of(x) for x in e.args) + "\n")
    return NULL


def _symbol(sess, e):
    if len(e.args) == 1 and type(e.args[0]) is str:
        s = e.args[0]
        if NAME.match(s):
            from . import parse
            return parse._symbol(s)
        sess.message("Symbol", "symname", s)
    return None


def _toexpression(sess, e):
    """ToExpression["text"]: the text parsed and evaluated as Sprig, statement by statement (only ever Sprig: §9)."""
    if len(e.args) != 1 or type(e.args[0]) is not str:
        return None
    from . import parse
    src = e.args[0]
    with mem.reserve(len(src) * mem.PARSE_BYTES_PER_CHAR, "Parsing %d characters" % len(src), "ToExpression"):
        try:
            stmts = parse.parse(src)
        except parse.SprigSyntaxError as err:
            syntax_message(sess, err, src, "<string>")
            return FAILED
        except parse.NotYetSyntax as err:
            sess.message("ToExpression", "notyet", err.what)
            return FAILED
    if not stmts:
        return NULL
    for s in stmts[:-1]:
        yield ("eval", s)
    return Tail(stmts[-1])


def syntax_message(sess, err, src, where):
    line = src.count("\n", 0, err.pos) + 1
    if err.tag == "sntxf":
        sess.message("Syntax", "sntxf", err.before, err.after, str(line), where)
    elif err.tag == "sntxb":
        sess.message("Syntax", "sntxb", err.after, str(line), where)
    else:
        sess.message("Syntax", "sntxi", str(line), where)


BUILTINS["Print"] = _print
BUILTINS["Symbol"] = _symbol
BUILTINS["ToExpression"] = _toexpression
ATTRIBUTES["Print"] = ("Protected",)
ATTRIBUTES["Symbol"] = ("Protected",)
ATTRIBUTES["ToExpression"] = ("Protected",)


# ---------------------------------------------------------------- files, network and processes (design §9)

# Refused before any argument is evaluated (they hold all their arguments), with the session unchanged.  Files come
# through Sagebrush's Python file layer when S1.4 gates them; until then every file function is refused too.
FILES = ("Get", "Import", "ReadList", "FileExistsQ", "Put", "PutAppend", "Export", "DeleteFile", "RenameFile",
         "CopyFile", "CreateDirectory", "DeleteDirectory", "SetDirectory", "OpenRead", "OpenWrite", "OpenAppend",
         "FileNames", "ReadString", "WriteString", "Read", "Write", "Directory", "Needs", "Install")
NETWORK = ("URLRead", "URLFetch", "URLExecute", "URLDownload", "URLSubmit", "SendMail", "SocketConnect",
           "SocketOpen")
PROCESSES = ("Run", "RunProcess", "StartProcess", "KillProcess", "Environment", "SetEnvironment", "LinkLaunch",
             "Exit", "Quit")
REFUSED = set(FILES) | set(NETWORK) | set(PROCESSES)


def _refuse(kind):
    def f(sess, e):
        name = e.head.name
        if kind == "nonetwork":
            sess.message(name, "nonetwork", name)
        elif kind == "noprocess":
            sess.message(name, "noprocess", name)
        else:
            a = e.args[0] if e.args else None
            # (a command pipe, "!cmd", is a process; a URL is the network)
            if type(a) is str and a.startswith("!"):
                sess.message(name, "noprocess", name)
            elif type(a) is str and re.match(r"(?i)[a-z][a-z0-9+.-]*://", a):
                sess.message(name, "nonetwork", name)
            else:
                sess.message(name, "notyet", name)
        return FAILED
    return f


for _n in FILES:
    BUILTINS[_n] = _refuse("files")
    ATTRIBUTES[_n] = ("HoldAll", "Protected")
for _n in NETWORK:
    BUILTINS[_n] = _refuse("nonetwork")
    ATTRIBUTES[_n] = ("HoldAll", "Protected")
for _n in PROCESSES:
    BUILTINS[_n] = _refuse("noprocess")
    ATTRIBUTES[_n] = ("HoldAll", "Protected")


# ---------------------------------------------------------------- Inequality

_REL_TESTS = {"Less": lambda x, y: x < y, "Greater": lambda x, y: x > y, "LessEqual": lambda x, y: x <= y,
              "GreaterEqual": lambda x, y: x >= y, "Equal": lambda x, y: x == y, "Unequal": lambda x, y: x != y}


def _inequality(sess, e):
    """Inequality[a, Less, b, Greater, c]: decided when its terms are numbers, else the And of its relations."""
    a = e.args
    if len(a) < 3 or len(a) % 2 == 0 or not all(type(a[i]) is Sym and a[i].name in _REL_TESTS
                                                  for i in range(1, len(a), 2)):
        return None
    terms = a[0::2]
    if _numbers(terms):
        return boolean(all(_REL_TESTS[a[i].name](a[i - 1], a[i + 1]) for i in range(1, len(a), 2)))
    return Expr("And", *[Expr(a[i], a[i - 1], a[i + 1]) for i in range(1, len(a), 2)])


BUILTINS["Inequality"] = _inequality
ATTRIBUTES["Inequality"] = ("Protected",)
