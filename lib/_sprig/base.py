"""Sprig's builtins, S1.1's part (design/sprig-mvp.md §3, §5, §9).

Exact arithmetic is Python's integers and fractions, and machine reals are
floats; Sage's symbolic layer enters with S2's mathematics (math.py).  Each
builtin is registered by name in BUILTINS (one assignment of a function to
a quoted name per line, or a loop over a tuple of names) and its attributes
in ATTRIBUTES, the spellings scripts/sprig-gates.mjs reads.

The functions that would reach files, the network or other programs are
refused before any argument is evaluated, with Sprig's message (§5.6, §9).
"""

import math
import re
import fractions

from . import mem
from .eval import Tail
from .expr import (Expr, Sym, TRUE, FALSE, NULL, LIST, FAILED, boolean, is_number, is_exact, num, head_of,
                   same, compare, _coeff_term, size_of)
from .fmt import input_form

Fraction = fractions.Fraction

PLUS, TIMES, POWER = Sym("Plus"), Sym("Times"), Sym("Power")
DIRECTED_INFINITY = Sym("DirectedInfinity")
COMPLEX_INFINITY = Expr(DIRECTED_INFINITY)
INDETERMINATE = Sym("Indeterminate")
CONDITION = Sym("Condition")
NAME = re.compile(r"(?:[A-Za-z$][A-Za-z0-9$]*`)*[A-Za-z$][A-Za-z0-9$]*\Z")

BUILTINS = {}
ATTRIBUTES = {}
MESSAGES = {
    ("Power", "infy"): "Infinite expression `1` encountered.",
    ("Power", "indet"): "Indeterminate expression `1` encountered.",
    ("Infinity", "indet"): "Indeterminate expression `1` encountered.",
    ("Set", "wrsym"): "Symbol `1` is Protected.",
    ("General", "wrsym"): "Symbol `1` is Protected.",
    ("General", "write"): "Tag `1` in `2` is Protected.",
    ("$RecursionLimit", "reclim"): "Recursion depth of `1` exceeded.",
    ("General", "optx"): "`1` is not a supported option for `2`[].",
    ("General", "limset"): "Cannot set `1` to `2`; value must be an integer between 20 and Infinity.",
    ("$IterationLimit", "itlim"): "Iteration limit of `1` exceeded.",
    ("Unset", "norep"): "Assignment on `1` for `2` not found.",
    ("Thread", "tdlen"): "Objects of unequal length cannot be combined.",
    ("Symbol", "symname"): "The string `1` cannot be used for a symbol name. A symbol name must start with a letter "
                           "followed by letters and numbers.",
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


# (an exact result past this many bits is reserved before it is computed; below it, the allocation is smaller than
# one continuation chunk)
RESERVE_BITS = 4096
MACHINE_MAX = 1.7976931348623157e308
MACHINE_TINY = 2.2250738585072014e-308
BEYOND_MACHINE = "A real number beyond the machine range"


class _BeyondMachine(Exception):
    """A machine Real result past the machine range (arbitrary precision is S2's): the call stays unevaluated."""


def _to_machine(v):
    """v as a machine Real, or _BeyondMachine when it is outside the machine range."""
    if type(v) is float:
        return v
    if v == 0:
        return 0.0
    if not MACHINE_TINY <= abs(v) <= MACHINE_MAX:
        raise _BeyondMachine()
    return float(v)


def _finite(x, nonzero):
    """x, a machine Real result, unless it overflowed, or underflowed to 0 from nonzero operands."""
    if x != x or x in (float("inf"), float("-inf")) or (nonzero and x == 0):
        raise _BeyondMachine()
    return x


def _parts(x):
    """(numerator bits, denominator bits) of an exact number; an integer's denominator counts 0."""
    if type(x) is int:
        return x.bit_length(), 0
    return x.numerator.bit_length(), x.denominator.bit_length()


def result_bits(op, a, b):
    """A bound on the bits of a + b or a * b, exact, numerator and denominator together, and on its intermediates:
    for integers, a sum's is the larger operand's + 1; p/q + r/s = (ps + rq)/qs has a numerator of at most
    p + q + r + s + 1 bits over qs, q + s; p/q * r/s = pr/qs has at most all four parts' bits."""
    if op == "+" and type(a) is int and type(b) is int:
        return max(a.bit_length(), b.bit_length()) + 1
    p, q = _parts(a)
    r, s = _parts(b)
    if op == "+":
        return (p + q + r + s + 1) + (q + s)
    return p + q + r + s + 1


def _arith(op, a, b, name):
    """a + b or a * b: exactly, reserving a large result first; or as machine Reals, inside the machine range."""
    if type(a) is not float and type(b) is not float:
        bits = result_bits(op, a, b)
        if bits > RESERVE_BITS:
            return _with_int_reservation(bits, name, lambda: a + b if op == "+" else a * b)
        return a + b if op == "+" else a * b
    x, y = _to_machine(a), _to_machine(b)
    if op == "+":
        return _finite(x + y, False)
    return _finite(x * y, x != 0 and y != 0)


def _machine_power(b, ex):
    """b^ex for machine Reals b > 0 (or b < 0 with an integer ex), inside the machine range."""
    if b == 0:
        return 0.0 if ex > 0 else None
    lg = ex * math.log2(abs(b))
    if lg > 1023.999999 or lg < -1074:
        raise _BeyondMachine()
    return _finite(b ** ex, True)


def _with_int_reservation(bits, name, f):
    """f(), with an exact result of about `bits` bits reserved first."""
    with mem.produce(mem.int_bytes(bits), "An exact number of " + mem.count(bits, "bit"), name):
        return f()


# ---------------------------------------------------------------- arithmetic

def _plus(sess, e):
    args = e.args
    # (Indeterminate stays a term of the sum, as the oracle's does: 1 + Indeterminate, x + Indeterminate)
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
    reals = []
    for x in args:
        if is_number(x):
            # (exact numbers are summed exactly first, then with the machine Reals: 1.5 + 10^400 - 10^400 is 1.5)
            if type(x) is float:
                reals.append(x)
            else:
                total = _arith("+", total, x, "Plus")
            has_number = True
            continue
        t, c = _coeff_term(x)
        if c is None:
            c = 1
        if t in terms:
            try:
                terms[t] = _arith("+", terms[t], c, "Plus")
            except _BeyondMachine:
                sess.message("Plus", "notyet", BEYOND_MACHINE)
                return None
        else:
            terms[t] = c
            order.append(t)
    try:
        for x in reals:
            total = _arith("+", total, x, "Plus")
    except _BeyondMachine:
        sess.message("Plus", "notyet", BEYOND_MACHINE)
        return None
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
    rest = []
    reals = []
    for x in args:
        if type(x) is float:
            reals.append(x)
        elif is_number(x):
            coeff = _arith("*", coeff, x, "Times")
        else:
            rest.append(x)
    try:
        for x in reals:
            coeff = _arith("*", coeff, x, "Times")
    except _BeyondMachine:
        sess.message("Times", "notyet", BEYOND_MACHINE)
        return None
    infs = [x for x in rest if _is_cinf(x)]
    if infs:
        if coeff == 0:
            sess.message("Infinity", "indet", "0 ComplexInfinity")
            return INDETERMINATE
        return COMPLEX_INFINITY
    if coeff == 0 and (type(coeff) is not float or not rest):
        return num(coeff) if type(coeff) is not float else 0.0
    bases = {}
    order = []
    for x in rest:
        b, ex = _power_parts(x)
        if b in bases:
            prev = bases[b]
            if is_number(prev) and is_number(ex):
                try:
                    bases[b] = _arith("+", prev, ex, "Times")
                except _BeyondMachine:
                    sess.message("Times", "notyet", BEYOND_MACHINE)
                    return None
            else:
                bases[b] = Expr(PLUS, prev, ex)
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
    """b^(p/q) for an exact b > 0 when b's q-th root is exact, else None.  The search's trial powers are at most
    twice b's size, reserved first; a q past b's bit length can have no root but 1."""
    if q > _bits(b):
        return Expr(POWER, 1, p) if b == 1 else None
    with mem.produce(mem.int_bytes(2 * _bits(b)), "An exact number of " + mem.count(2 * _bits(b), "bit"), "Power"):
        return _exact_root_now(b, p, q)


def _exact_root_now(b, p, q):
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
        try:
            return _numeric_power(sess, b, ex)
        except _BeyondMachine:
            sess.message("Power", "notyet", BEYOND_MACHINE)
            return None
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
            return _machine_power(b, ex)
        bits = _bits(b) * abs(ex)
        r = _with_int_reservation(bits, "Power", lambda: Fraction(b) ** ex)
        return num(r)
    if type(ex) is Fraction:
        if type(b) is float:
            return _machine_power(b, float(ex)) if b >= 0 else None
        if b == 0:
            if ex < 0:
                sess.message("Power", "infy", "1 / 0^%s" % input_form(-ex))
                return COMPLEX_INFINITY
            return 0
        if b < 0:
            return None
        # (an exact root only; radicals, Sqrt[8] = 2 Sqrt[2], are S2's)
        return _exact_root(b, ex.numerator, ex.denominator)
    # a Real exponent
    if b < 0:
        return None
    return _machine_power(_to_machine(b), ex)


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
    with mem.produce((n + 1) * mem.NODE_BYTES, "A list of " + mem.count(n, "number"), "Range"):
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
    """a; b; c: each in turn, the last too, as a nested evaluation whose value is the call's: so a definition whose body
    ends a compound expression nests a level each time it recurses, and the language limit stops it, as the oracle's
    does (f[n_] := (a; f[n - 1]) reaches $RecursionLimit)."""
    a = e.args
    if not a:
        return NULL
    # (each part's value dropped once it is evaluated; the last one's kept, with its charge, as the call's)
    for x in a[:-1]:
        yield ("eval", x)
        mem.drop_received()
    v = yield ("eval", a[-1])
    mem.made.take(mem.receive("CompoundExpression"))
    return v


PROTECTED_SYMBOLS = {"True", "False", "Null", "Indeterminate", "Pi", "E", "I", "Infinity", "ComplexInfinity"}


def _protected(sym):
    n = sym.name
    return n in BUILTINS or n in ATTRIBUTES or n in PROTECTED_SYMBOLS or n in REFUSED


def _is_protected(sess, sym):
    return "Protected" in sess.attrs(sym) or (sym not in sess.user_attrs and _protected(sym))


def _define(sess, e, name, value_of):
    """Set and SetDelayed: lhs a symbol (its own value), or head[args] with a symbol head (a down value of the head,
    its arguments evaluated first as the call's would be, patterns staying patterns).  A generator; value_of(rhs) is
    what the assignment returns."""
    if len(e.args) != 2:
        return None
    lhs, rhs = e.args
    if type(lhs) is Sym and lhs.name in LIMITS:
        return _set_limit(sess, lhs, rhs, value_of)
    if type(lhs) is Sym:
        if _is_protected(sess, lhs):
            sess.message(name, "wrsym", lhs.name)
            return value_of(rhs, True)
        sess.define(lhs, rhs, name)
        return value_of(rhs, False)
    # (lhs /; cond := rhs: a definition with a condition on the whole of its lhs, kept with it)
    cond = None
    if type(lhs) is Expr and lhs.head is CONDITION and len(lhs.args) == 2:
        lhs, cond = lhs.args
    h = lhs.head if type(lhs) is Expr else None
    if type(h) is not Sym:
        sess.message(name, "notyet", "An assignment to " + input_form(e.args[0]))
        return FAILED
    if _is_protected(sess, h):
        sess.message(name, "write", h.name, input_form(lhs))
        return value_of(rhs, True)
    held = sess._held(h, lhs.args)
    # (the argument list, the lhs made from it and its condition's node, reserved first; held across the yields)
    work = mem.Held("An assignment to " + mem.count(len(lhs.args), "argument"), name)
    try:
        work.grow(2 * mem.NODE_BYTES + 2 * len(lhs.args) * mem.SLOT_BYTES)
        args = list(lhs.args)
        for i, a in enumerate(args):
            if held == "all" or (held is not None and i in held) or type(a) is not Expr:
                continue
            args[i] = yield ("eval", a)
        new = Expr(h, *args)
        sess.define_down(h, new if cond is None else Expr(CONDITION, new, cond), rhs, name)
        args = new = None
    finally:
        work.release()
    return value_of(rhs, False)


# The language's limits (design §5.2), kept on the Session (recursion_limit, iteration_limit: an int, or None for
# Infinity).  Sprig evaluates on its own stack, so either can be raised to Infinity; the memory guard bounds what is
# then reachable.
LIMITS = ("$RecursionLimit", "$IterationLimit")
LIMIT_MIN = 20


def _limit_value(x):
    """A limit's new value: an int at least LIMIT_MIN, or None for Infinity; False when x is neither."""
    if type(x) is int and x >= LIMIT_MIN:
        return x
    if x is Sym("Infinity") or (type(x) is Expr and x.head is DIRECTED_INFINITY and x.args == (1,)):
        return None
    return False


def _set_limit(sess, sym, rhs, value_of):
    v = _limit_value(rhs)
    if v is False:
        sess.message(sym.name, "limset", sym.name, input_form(rhs))
        return value_of(rhs, False)
    _store_limit(sess, sym.name, v)
    return value_of(rhs, False)


def _store_limit(sess, name, v):
    if name == "$RecursionLimit":
        sess.recursion_limit = v
    else:
        sess.iteration_limit = v


def limit_symbol_value(sess, sym):
    """$RecursionLimit's or $IterationLimit's value as Sprig reads it."""
    v = sess.recursion_limit if sym.name == "$RecursionLimit" else sess.iteration_limit
    return Sym("Infinity") if v is None else v


def _set(sess, e):
    # (the value is evaluated again in the call's place, as any changed result is: x = x + 1 recurses to the limit)
    return (yield from _define(sess, e, "Set", lambda rhs, refused: Tail(rhs)))


def _setdelayed(sess, e):
    return (yield from _define(sess, e, "SetDelayed", lambda rhs, refused: FAILED if refused else NULL))


def _unset(sess, e):
    """lhs =. : the definition removed."""
    if len(e.args) != 1:
        return None
    lhs = e.args[0]
    if type(lhs) is Sym and lhs.name in LIMITS:
        from .eval import RECURSION_LIMIT, ITERATION_LIMIT
        _store_limit(sess, lhs.name, RECURSION_LIMIT if lhs.name == "$RecursionLimit" else ITERATION_LIMIT)
        return NULL
    if type(lhs) is Sym:
        o = sess.own.pop(lhs, None)
        if o is not None:
            o[1].release()
        return NULL
    h = lhs.head if type(lhs) is Expr else None
    if type(h) is Sym:
        # (the argument list and the lhs made from it, reserved first; held across the yields)
        work = mem.Held("A removal of " + mem.count(len(lhs.args), "argument"), "Unset")
        try:
            work.grow(mem.NODE_BYTES + 2 * len(lhs.args) * mem.SLOT_BYTES)
            args = list(lhs.args)
            held = sess._held(h, args)
            for i, a in enumerate(args):
                if held == "all" or (held is not None and i in held) or type(a) is not Expr:
                    continue
                args[i] = yield ("eval", a)
            if sess.undefine_down(h, Expr(h, *args)):
                return NULL
            args = None
        finally:
            work.release()
    sess.message("Unset", "norep", (h.name if type(h) is Sym else input_form(lhs)), input_form(lhs))
    return FAILED


def _symbols_of(sess, e):
    """Clear's and ClearAll's arguments: symbols, or strings naming them."""
    out = []
    for a in e.args:
        if type(a) is Sym:
            out.append(a)
        elif type(a) is str and NAME.match(a):
            out.append(Sym(a))
    return out


def _clear(sess, e):
    for s in _symbols_of(sess, e):
        if _is_protected(sess, s):
            sess.message("Clear", "wrsym", s.name)
            continue
        sess.clear(s)
    return NULL


def _clearall(sess, e):
    for s in _symbols_of(sess, e):
        if s not in sess.user_attrs and _protected(s):
            sess.message("ClearAll", "wrsym", s.name)
            continue
        sess.clear(s)
        sess.user_attrs.pop(s, None)
    return NULL


BUILTINS["CompoundExpression"] = _compound
BUILTINS["Set"] = _set
BUILTINS["SetDelayed"] = _setdelayed
BUILTINS["Unset"] = _unset
BUILTINS["Clear"] = _clear
BUILTINS["ClearAll"] = _clearall
ATTRIBUTES["CompoundExpression"] = ("HoldAll", "Protected", "ReadProtected")
ATTRIBUTES["Set"] = ("HoldFirst", "Protected", "SequenceHold")
ATTRIBUTES["SetDelayed"] = ("HoldAll", "Protected", "SequenceHold")
ATTRIBUTES["Unset"] = ("HoldFirst", "Listable", "Protected", "ReadProtected")
ATTRIBUTES["Clear"] = ("HoldAll", "Protected")
ATTRIBUTES["ClearAll"] = ("HoldAll", "Protected")


# ---------------------------------------------------------------- attributes

ATTRIBUTE_NAMES = ("Constant", "Flat", "HoldAll", "HoldAllComplete", "HoldFirst", "HoldRest", "Listable", "Locked",
                   "NHoldAll", "NHoldFirst", "NHoldRest", "NumericFunction", "OneIdentity", "Orderless", "Protected",
                   "ReadProtected", "SequenceHold", "Stub", "Temporary")
# (the attributes S1.2's matcher doesn't honour in patterns yet: their definitions are refused, not wrong; S3 has them)
NOT_YET_ATTRIBUTES = ("Flat", "Orderless", "OneIdentity")


def _attr_list(sess, a):
    names = a.args if type(a) is Expr and a.head is LIST else (a,)
    out = []
    for x in names:
        if type(x) is not Sym or x.name not in ATTRIBUTE_NAMES:
            return None
        out.append(x.name)
    return out


def _setattributes(sess, e):
    if len(e.args) != 2:
        return None
    syms = e.args[0].args if type(e.args[0]) is Expr and e.args[0].head is LIST else (e.args[0],)
    names = _attr_list(sess, e.args[1])
    if names is None or not all(type(s) is Sym for s in syms):
        return None
    for n in names:
        if n in NOT_YET_ATTRIBUTES:
            sess.message("SetAttributes", "notyet", "The attribute " + n)
            return FAILED
    for s in syms:
        if s not in sess.user_attrs and _protected(s):
            sess.message("SetAttributes", "wrsym", s.name)
            continue
        cur = list(sess.attrs(s))
        for n in names:
            if n not in cur:
                cur.append(n)
        sess.user_attrs[s] = tuple(sorted(cur))
    return NULL


def _clearattributes(sess, e):
    if len(e.args) != 2:
        return None
    syms = e.args[0].args if type(e.args[0]) is Expr and e.args[0].head is LIST else (e.args[0],)
    names = _attr_list(sess, e.args[1])
    if names is None or not all(type(s) is Sym for s in syms):
        return None
    for s in syms:
        if s not in sess.user_attrs and _protected(s):
            sess.message("ClearAttributes", "wrsym", s.name)
            continue
        sess.user_attrs[s] = tuple(n for n in sess.attrs(s) if n not in names)
    return NULL


def _attributes(sess, e):
    if len(e.args) != 1:
        return None
    s = e.args[0]
    if type(s) is str and NAME.match(s):
        s = Sym(s)
    if type(s) is not Sym:
        return None
    return Expr(LIST, *[Sym(n) for n in sorted(sess.attrs(s))])


BUILTINS["SetAttributes"] = _setattributes
BUILTINS["ClearAttributes"] = _clearattributes
BUILTINS["Attributes"] = _attributes
ATTRIBUTES["SetAttributes"] = ("HoldFirst", "Protected")
ATTRIBUTES["ClearAttributes"] = ("HoldFirst", "Protected")
ATTRIBUTES["Attributes"] = ("HoldAll", "Listable", "Protected")


# ---------------------------------------------------------------- patterns and rules

def _replace_all(sess, e):
    """expr /. rules: each subexpression, outermost first, by the first rule that matches it."""
    if len(e.args) != 2:
        return None
    from . import pattern
    rules = pattern.rule_list(e.args[1])
    if rules is None:
        return None
    r, _ = yield from pattern.replace_all(sess, e.args[0], rules, mem.made)
    return Tail(r)


# (ReplaceRepeated's limit on passes, MaxIterations' recorded default: one of the language limits, §5.2; the oracle
# stops there without a message)
MAX_ITERATIONS = 65535


MAX_ITERATIONS_SYM = Sym("MaxIterations")
# (the options a builtin takes, as Options[f] gives them)
OPTIONS = {"ReplaceRepeated": (Expr("RuleDelayed", MAX_ITERATIONS_SYM, MAX_ITERATIONS),)}


def _options(sess, e):
    """Options[f]: the options f takes, {} for a symbol with none."""
    if len(e.args) != 1 or type(e.args[0]) is not Sym:
        return None
    return Expr(LIST, *OPTIONS.get(e.args[0].name, ()))


def _max_iterations(sess, opts):
    """ReplaceRepeated's MaxIterations from its options: an int, None for Infinity, or False when an argument isn't
    an option.  An option it doesn't take is reported (optx) and ignored, as the oracle does."""
    n = MAX_ITERATIONS
    for o in opts:
        if not (type(o) is Expr and type(o.head) is Sym and o.head.name in ("Rule", "RuleDelayed") and len(o.args) == 2):
            return False
        if o.args[0] is not MAX_ITERATIONS_SYM:
            sess.message("ReplaceRepeated", "optx", input_form(o), "ReplaceRepeated")
            continue
        v = o.args[1]
        if type(v) is int and v >= 0:
            n = v
        elif v is Sym("Infinity") or (type(v) is Expr and v.head is DIRECTED_INFINITY and v.args == (1,)):
            n = None
        else:
            return False
    return n


def _replace_repeated(sess, e):
    """expr //. rules: /. again until nothing changes, at most MaxIterations passes (65535 by default; Infinity has
    no bound but Stop and the memory guard)."""
    if len(e.args) < 2:
        return None
    from . import pattern
    rules = pattern.rule_list(e.args[1])
    limit = _max_iterations(sess, e.args[2:])
    if rules is None or limit is False:
        return None
    # (x the current value, y its replacement, z y evaluated: each held while it is referred to, the three at once at
    # a pass's peak; the next held before the one it replaces is given back)
    x = e.args[0]
    xh = mem.Held("A value", "ReplaceRepeated")
    yh = zh = None
    try:
        passes = 0
        while limit is None or passes < limit:
            passes += 1
            yh = mem.Held("A replacement's result", "ReplaceRepeated")
            y, changed = yield from pattern.replace_all(sess, x, rules, yh)
            if not changed:
                y = None
                break
            z = yield ("eval", y)
            zh = mem.receive("ReplaceRepeated")
            y = None
            yh.release()
            if same(z, x):
                z = None
                break
            x, z = z, None
            xh.release()
            xh, zh = zh, None
        mem.made.take(xh)
        return Tail(x)
    finally:
        xh.release()
        for h in (yh, zh):
            if h is not None:
                h.release()


def _replace(sess, e):
    """Replace[expr, rules]: the first rule that matches the whole expression, at level 0."""
    if len(e.args) != 2:
        return None
    from . import pattern
    rules = pattern.rule_list(e.args[1])
    if rules is None:
        return None
    for r in rules:
        keep = mem.Held("A pattern match", "Replace")
        try:
            b = yield from pattern.match(sess, r.args[0], e.args[0], keep)
            if b is not None:
                return Tail(pattern.substitute(r.args[1], b, mem.made))
        finally:
            b = None
            keep.release()
    return Tail(e.args[0])


def _matchq(sess, e):
    if len(e.args) != 2:
        return None
    from . import pattern
    keep = mem.Held("A pattern match", "MatchQ")
    try:
        b = yield from pattern.match(sess, e.args[1], e.args[0], keep)
        return boolean(b is not None)
    finally:
        b = None
        keep.release()


def _nest(sess, e):
    """Nest[f, x, n]: f applied n times, each application evaluated in turn on the evaluator's stack (a sequence of
    evaluations, never a nesting of them)."""
    if len(e.args) != 3 or type(e.args[2]) is not int or e.args[2] < 0:
        return None
    f, x, n = e.args
    # (the current value held, the next held before it is given back; each call made under produce, the evaluator
    # taking it with its charge)
    xh = mem.Held("A value", "Nest")
    try:
        for _ in range(n):
            x = yield ("eval", _nest_call(f, x))
            h = mem.receive("Nest")
            xh.release()
            xh = h
        mem.made.take(xh)
        return x
    finally:
        xh.release()


def _nest_call(f, x):
    with mem.produce(mem.NODE_BYTES + 2 * mem.SLOT_BYTES, "A call", "Nest"):
        return Expr(f, x)


def _map(sess, e):
    """Map[f, expr], f /@ expr: f applied to each of expr's arguments (level 1)."""
    if len(e.args) != 2:
        return None
    f, x = e.args
    if type(x) is not Expr:
        return x
    k = len(x.args)
    with mem.produce((k + 1) * (size_of(f) + 1) * mem.NODE_BYTES, "A list of " + mem.count(k, "element"), "Map"):
        return Expr(x.head, *[Expr(f, a) for a in x.args])


BUILTINS["Nest"] = _nest
BUILTINS["Map"] = _map
ATTRIBUTES["Nest"] = ("Protected",)
ATTRIBUTES["Map"] = ("Protected",)


# ---------------------------------------------------------------- predicates (what pattern tests, x_?f, ask)

# each predicate's test of its argument; the sign tests are decided only for a number (a symbol's sign is unknown, so
# Positive[x] stays as it is)
PREDICATES = {
    "NumberQ": is_number,
    "IntegerQ": lambda x: type(x) is int,
    "EvenQ": lambda x: type(x) is int and x % 2 == 0,
    "OddQ": lambda x: type(x) is int and x % 2 == 1,
    "AtomQ": lambda x: type(x) is not Expr,
    "StringQ": lambda x: type(x) is str,
}
SIGN_PREDICATES = {
    "Positive": lambda x: x > 0,
    "Negative": lambda x: x < 0,
    "NonNegative": lambda x: x >= 0,
}


def _predicate(sess, e):
    if len(e.args) != 1:
        return None
    name, x = e.head.name, e.args[0]
    if name in SIGN_PREDICATES:
        return boolean(SIGN_PREDICATES[name](x)) if is_number(x) else None
    return boolean(PREDICATES[name](x))


TYPE_TESTS = ("NumberQ", "IntegerQ", "AtomQ", "StringQ")
# (Listable, as the oracle's are: EvenQ[{1, 2}] is {False, True})
LISTABLE_TESTS = ("EvenQ", "OddQ", "Positive", "Negative", "NonNegative")
for _n in TYPE_TESTS:
    BUILTINS[_n] = _predicate
    ATTRIBUTES[_n] = ("Protected",)
for _n in LISTABLE_TESTS:
    BUILTINS[_n] = _predicate
    ATTRIBUTES[_n] = ("Listable", "Protected")
BUILTINS["Options"] = _options
ATTRIBUTES["Options"] = ("Protected",)


BUILTINS["ReplaceAll"] = _replace_all
BUILTINS["ReplaceRepeated"] = _replace_repeated
BUILTINS["Replace"] = _replace
BUILTINS["MatchQ"] = _matchq
ATTRIBUTES["ReplaceAll"] = ("Protected",)
ATTRIBUTES["ReplaceRepeated"] = ("Protected",)
ATTRIBUTES["Replace"] = ("Protected",)
ATTRIBUTES["MatchQ"] = ("Protected",)
ATTRIBUTES["Rule"] = ("Protected", "SequenceHold")
ATTRIBUTES["RuleDelayed"] = ("HoldRest", "Protected", "SequenceHold")
ATTRIBUTES["Pattern"] = ("HoldFirst", "Protected")
ATTRIBUTES["Blank"] = ("Protected",)
ATTRIBUTES["BlankSequence"] = ("Protected",)
ATTRIBUTES["BlankNullSequence"] = ("Protected",)
ATTRIBUTES["Alternatives"] = ("Protected",)
ATTRIBUTES["Condition"] = ("HoldRest", "Protected")
ATTRIBUTES["PatternTest"] = ("Protected",)
ATTRIBUTES["Optional"] = ("Protected",)
ATTRIBUTES["HoldPattern"] = ("HoldAll", "Protected")


# ---------------------------------------------------------------- printing and strings

def text_of(x):
    """Print's text of x: a string as itself, anything else as InputForm (S1.3 gives OutputForm).  The caller has
    reserved its formatting (format_bytes)."""
    if type(x) is str:
        return x
    return input_form(x)


def format_bytes(items):
    """The peak of formatting items and joining their text: per unit of each one's size, a long number or string
    counted by its length (size_of)."""
    return (1 + sum(size_of(x) for x in items)) * mem.FORMAT_BYTES_PER_NODE


def _print(sess, e):
    # (the whole line's peak, every argument's text and the joined line, reserved once and held through the write)
    n = len(e.args)
    with mem.reserve(format_bytes(e.args), "Formatting " + mem.count(n, "item"), "Print"):
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
    # (the parse's tokens and tree are held while its statements are evaluated, so its charge is held as long: across
    # the yields, given back at the end, or by evaluate() if Stop ends it there)
    r = mem.reserve(len(src) * mem.PARSE_BYTES_PER_CHAR, "Parsing " + mem.count(len(src), "character"), "ToExpression")
    r.acquire()
    sess.hold(r)
    # (and its expanded exact numbers, charged as the parser makes them, held as long)
    literals = mem.Held("A program's numbers", "ToExpression")
    sess.hold(literals)
    try:
        stmts = parse.parse(src, literals)
    except parse.SprigSyntaxError as err:
        sess.unhold(r)
        sess.unhold(literals)
        syntax_message(sess, err, src, "<string>")
        return FAILED
    except parse.NotYetSyntax as err:
        sess.unhold(r)
        sess.unhold(literals)
        sess.message("ToExpression", "notyet", err.what)
        return FAILED
    if not stmts:
        sess.unhold(r)
        sess.unhold(literals)
        return NULL
    for s in stmts[:-1]:
        yield ("eval", s)
        mem.drop_received()
    value = yield ("eval", stmts[-1])
    mem.made.take(mem.receive("ToExpression"))
    sess.unhold(r)
    sess.unhold(literals)
    return value


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

# Refused before any argument is evaluated (they hold all their arguments), with the session unchanged.  FILES are
# design §9's file functions, which S1.4 routes through Sagebrush's Python file layer; until then each is refused
# with General::notyet.  A function Sprig doesn't know stays unevaluated, an inert expression that reaches nothing.
FILES = ("Get", "Import", "ReadList", "FileExistsQ", "Put", "PutAppend", "Export", "DeleteFile", "RenameFile",
         "CreateDirectory", "SetDirectory")
NETWORK = ("URLRead", "URLFetch", "URLExecute", "URLDownload", "URLSubmit", "SendMail", "SocketConnect",
           "SocketOpen")
PROCESSES = ("Run", "RunProcess", "StartProcess", "KillProcess", "LinkLaunch")
# (design §9 names OpenRead only as a command pipe, OpenRead["!cmd"]: that is refused; any other OpenRead stays an inert,
# held expression)
PIPES = ("OpenRead",)
REFUSED = set(FILES) | set(NETWORK) | set(PROCESSES) | set(PIPES)


def _refuse(kind):
    def f(sess, e):
        name = e.head.name
        if kind == "pipe":
            a = e.args[0] if e.args else None
            if type(a) is str and a.startswith("!"):
                sess.message(name, "noprocess", name)
                return FAILED
            return None
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
for _n in PIPES:
    BUILTINS[_n] = _refuse("pipe")
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
