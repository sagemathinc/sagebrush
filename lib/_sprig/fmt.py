"""Sprig's printers: FullForm and InputForm text (design/sprig-mvp.md §5.3).

Both are iterative emitters (design §8.3): a stack of pieces still to
write, where a piece is a string or an expression with the least binding
power it may have unparenthesized.  Expanding an expression pushes its
parts; nothing recurses, so a tree 10^5 levels deep prints in linear time.
The layout follows the oracle's text for sprig-tests/core/.
"""

import fractions

from .expr import Expr, Sym, LIST, is_number, name_of

Fraction = fractions.Fraction

PLUS, TIMES, POWER = Sym("Plus"), Sym("Times"), Sym("Power")


def real_text(x):
    """A machine Real as the oracle writes it: up to 16 significant digits, a final "." when it has no
    fraction, and d.ddd*^n when its power of ten is outside -5 to 5."""
    if x != x:
        return "Indeterminate"
    if x in (float("inf"), float("-inf")):
        return "Infinity" if x > 0 else "-Infinity"
    sign = "-" if x < 0 or (x == 0 and str(x).startswith("-")) else ""
    m, _, ex = ("%.15e" % abs(x)).partition("e")
    digits = (m[0] + m[2:]).rstrip("0") or "0"
    p = int(ex)
    if x == 0:
        return sign + "0."
    if -5 <= p <= 5:
        if p >= 0:
            whole, frac = digits[:p + 1].ljust(p + 1, "0"), digits[p + 1:]
        else:
            whole, frac = "0", "0" * (-p - 1) + digits
        return sign + whole + "." + frac
    return sign + digits[0] + "." + digits[1:] + "*^" + str(p)


def string_text(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t") + '"'


def _atom_full(e):
    t = type(e)
    if t is int:
        return str(e)
    if t is Fraction:
        return "Rational[%d, %d]" % (e.numerator, e.denominator)
    if t is float:
        return real_text(e) + "`"
    if t is str:
        return string_text(e)
    return e.name


def _emit(e, expand, minprec=0):
    """Run the emitter: expand(x, minprec) gives (parts, prec), parts a list of strings and (expr, minprec)."""
    out = []
    stack = [(e, minprec)]
    while stack:
        item = stack.pop()
        if type(item) is str:
            out.append(item)
            continue
        x, need = item
        parts, prec = expand(x, need)
        if prec < need:
            parts = ["("] + parts + [")"]
        for p in reversed(parts):
            stack.append(p)
    return "".join(out)


def _full_parts(x, need):
    if type(x) is not Expr:
        return [_atom_full(x)], 1000
    parts = []
    if x.head is LIST:
        parts.append("{")
    else:
        parts.append((x.head, 0))
        parts.append("[")
    for i, a in enumerate(x.args):
        if i:
            parts.append(", ")
        parts.append((a, 0))
    parts.append("}" if x.head is LIST else "]")
    return parts, 1000


def full_form(e):
    return _emit(e, _full_parts)


# --- InputForm

def _neg_number(x):
    return is_number(x) and x < 0


def _atom_input(x):
    t = type(x)
    if t is int:
        return [str(x)], (480 if x < 0 else 1000)
    if t is Fraction:
        return ["%d/%d" % (x.numerator, x.denominator)], (470 if x > 0 else 470)
    if t is float:
        s = real_text(x)
        return [s], (480 if s.startswith("-") else 1000)
    if t is str:
        return [string_text(x)], 1000
    return [x.name], 1000


INFIX_TEXT = {
    "Equal": (" == ", 290), "Unequal": (" != ", 290), "Less": (" < ", 290), "Greater": (" > ", 290),
    "LessEqual": (" <= ", 290), "GreaterEqual": (" >= ", 290), "SameQ": (" === ", 290),
    "UnsameQ": (" =!= ", 290), "And": (" && ", 220), "Or": (" || ", 215), "Alternatives": (" | ", 160),
    "StringJoin": (" <> ", 600), "Dot": (" . ", 490), "CompoundExpression": (" ; ", 10),
}
BINARY_TEXT = {
    "Rule": (" -> ", 120, "right"), "RuleDelayed": (" :> ", 120, "right"), "Set": (" = ", 40, "right"),
    "SetDelayed": (" := ", 40, "right"), "ReplaceAll": (" /. ", 110, "left"),
    "ReplaceRepeated": (" //. ", 110, "left"), "Condition": (" /; ", 130, "left"),
    "Map": (" /@ ", 620, "right"), "Apply": (" @@ ", 620, "right"), "PatternTest": (" ? ", 680, "left"),
    "Span": (" ;; ", 305, "left"), "Optional": (" : ", 140, "left"), "AddTo": (" += ", 40, "right"),
    "SubtractFrom": (" -= ", 40, "right"), "TimesBy": (" *= ", 40, "right"), "DivideBy": (" /= ", 40, "right"),
    "UpSet": (" ^= ", 40, "right"), "UpSetDelayed": (" ^:= ", 40, "right"),
}
POSTFIX_TEXT = {"Factorial": ("!", 610), "Increment": ("++", 660), "Decrement": ("--", 660), "Unset": ("=.", 670)}
# heads whose wrapper the oracle's InputForm leaves out
TRANSPARENT = {"HoldForm", "InputForm"}


def _times_parts(args):
    """InputForm of Times[args]: a sign, the numerator's factors joined by *, and /denominator."""
    coeff = 1
    rest = list(args)
    if rest and is_number(rest[0]):
        coeff = rest.pop(0)
    num, den = [], []
    neg = False
    if type(coeff) is Fraction:
        neg = coeff < 0
        p, q = abs(coeff.numerator), coeff.denominator
        if p != 1:
            num.append(p)
        den.append(q)
    elif coeff != 1:
        if coeff == -1:
            neg = True
        elif type(coeff) is int and coeff < 0 and rest:
            neg = True
            num.append(-coeff)
        else:
            num.append(coeff)
    for f in rest:
        if type(f) is Expr and f.head is POWER and len(f.args) == 2 and _neg_number(f.args[1]):
            e = -f.args[1]
            den.append(f.args[0] if e == 1 else Expr(POWER, f.args[0], e))
        else:
            num.append(f)
    parts = []
    if neg:
        parts.append("-")
    if not num:
        parts.append("1")
    for i, f in enumerate(num):
        if i:
            parts.append("*")
        parts.append((f, 400 if not (neg and i == 0 and len(num) == 1 and not den) else 480))
    if den:
        parts.append("/")
        if len(den) == 1:
            parts.append((den[0], 590))
        else:
            parts.append("(")
            for i, f in enumerate(den):
                if i:
                    parts.append("*")
                parts.append((f, 400))
            parts.append(")")
    return parts, (470 if den else 400)


def _plus_parts(args):
    parts = []
    for i, t in enumerate(args):
        if i:
            if _neg_number(t):
                parts.append(" - ")
                parts.append((-t, 311))
                continue
            if type(t) is Expr and t.head is TIMES and t.args and _neg_number(t.args[0]):
                c = -t.args[0]
                parts.append(" - ")
                parts.append((Expr(TIMES, *t.args[1:]) if c == 1 and len(t.args) > 2 else
                              (t.args[1] if c == 1 else Expr(TIMES, c, *t.args[1:])), 311))
                continue
            parts.append(" + ")
        parts.append((t, 311 if i else 310))
    return parts, 310


def _input_parts(x, need):
    if type(x) is not Expr:
        return _atom_input(x)
    h = x.head
    a = x.args
    if type(h) is Sym:
        n = h.name
        if n in TRANSPARENT and len(a) == 1:
            return [(a[0], need)], 1000
        if h is LIST:
            parts = ["{"]
            for i, y in enumerate(a):
                if i:
                    parts.append(", ")
                parts.append((y, 0))
            parts.append("}")
            return parts, 1000
        if h is PLUS and len(a) >= 2:
            return _plus_parts(a)
        if h is TIMES and len(a) >= 2:
            return _times_parts(a)
        if h is POWER and len(a) == 2:
            b, e = a
            if e == Fraction(1, 2):
                return ["Sqrt[", (b, 0), "]"], 1000
            if _neg_number(e):
                return _times_parts((x,))
            return [(b, 591), "^", (e, 590)], 590
        if n in INFIX_TEXT and len(a) >= 2:
            sep, prec = INFIX_TEXT[n]
            parts = []
            for i, y in enumerate(a):
                if i:
                    parts.append(sep)
                parts.append((y, prec + 1))
            return parts, prec
        if n in BINARY_TEXT and len(a) == 2:
            sep, prec, assoc = BINARY_TEXT[n]
            return [(a[0], prec + (0 if assoc == "left" else 1)), sep, (a[1], prec + (1 if assoc == "left" else 0))], prec
        if n == "Not" and len(a) == 1:
            return ["!", (a[0], 231)], 230
        if n == "Pattern" and len(a) == 2 and type(a[0]) is Sym and type(a[1]) is Expr and \
                name_of(a[1].head) in ("Blank", "BlankSequence", "BlankNullSequence") and \
                all(type(y) is Sym for y in a[1].args):
            return [a[0].name, (a[1], 0)], 1000
        if n in ("Blank", "BlankSequence", "BlankNullSequence") and all(type(y) is Sym for y in a):
            return [{"Blank": "_", "BlankSequence": "__", "BlankNullSequence": "___"}[n]] + [y.name for y in a], 1000
        if n in ("Slot", "SlotSequence") and len(a) == 1 and type(a[0]) is int:
            return [("#" if n == "Slot" else "##") + str(a[0])], 1000
        if n == "Optional" and len(a) == 1:
            return ["(", (a[0], 1000), ".)"], 1000
        if n in POSTFIX_TEXT and len(a) == 1:
            sym, prec = POSTFIX_TEXT[n]
            return [(a[0], prec + 1), sym], prec
        if n in ("PreIncrement", "PreDecrement") and len(a) == 1:
            return ["++" if n == "PreIncrement" else "--", (a[0], 661)], 660
        if n == "DirectedInfinity" and not a:
            return ["ComplexInfinity"], 1000
        if n == "Inequality" and len(a) >= 3 and len(a) % 2 == 1:
            pass
        if n == "Function" and len(a) == 1:
            return [(a[0], 91), "&"], 90
    parts = [(h, 1000), "["]
    for i, y in enumerate(a):
        if i:
            parts.append(", ")
        parts.append((y, 0))
    parts.append("]")
    return parts, 1000


def input_form(e):
    return _emit(e, _input_parts)
