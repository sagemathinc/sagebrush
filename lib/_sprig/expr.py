"""Sprig's expressions (design/sprig-mvp.md §4).

An expression is an atom or an `Expr`, a head applied to arguments.  The
atoms are Python values: `int` (Integer), `Fraction` (Rational, never with
denominator 1), `float` (Real, machine precision), `str` (String) and `Sym`
(Symbol; True, False and Null are symbols too).  Python's `bool` is never an
atom.

Every walk over an expression is iterative (design §8.3): an `Expr` computes
its hash and its depth from its arguments' when it is built, so hashing is
O(1), and equality and the canonical order use explicit stacks.  A tree 10^5
levels deep is ordinary data.

Symbols are only Sprig data: a symbol's name is a key in Sprig's own tables
and never reaches a Python attribute, global, import or builtin (§9).
"""

import fractions

Fraction = fractions.Fraction


class Sym:
    """A symbol, interned by name: `Sym("x") is Sym("x")`.  The names made while Sprig loads (its builtins and
    constants) are in one table every session shares, frozen once Sprig has loaded; any other name is interned in the
    active session's own table (Session.symbols), so a session's names go with it.  Outside a session (direct library
    use) they go in a table of their own, _loose."""
    __slots__ = ("name",)
    _table = {}
    _frozen = False
    _local = None
    _loose = {}

    def __new__(cls, name):
        s = cls._table.get(name)
        if s is not None:
            return s
        t = cls._table if not cls._frozen else (cls._local if cls._local is not None else cls._loose)
        s = t.get(name)
        if s is None:
            s = object.__new__(cls)
            s.name = name
            t[name] = s
        return s

    def __repr__(self):
        return self.name

    def __reduce__(self):
        return (Sym, (self.name,))


class Expr:
    """head[args...].  Immutable; its hash and depth are computed once, from its parts'."""
    __slots__ = ("head", "args", "_hash", "depth", "size")

    def __init__(self, head, *args):
        self.head = Sym(head) if isinstance(head, str) else head
        self.args = args
        h = hash_of(self.head) & 0xFFFFFFFFFFFFFFF
        d = depth_of(self.head)
        n = 1 + size_of(self.head)
        for a in args:
            # (masked each step: an unmasked hash grows by 20 bits per argument, quadratic for a wide expression)
            h = ((h * 1000003) ^ hash_of(a)) & 0xFFFFFFFFFFFFFFF
            if type(a) is Expr:
                if a.depth > d:
                    d = a.depth
                n += a.size
            else:
                n += size_of(a)
        self._hash = h & 0x7FFFFFFFFFFF
        self.depth = d + 1
        # (nodes, counting a long string or integer by its length: what the printers and the ledger charge for)
        self.size = n

    def __hash__(self):
        return self._hash

    def __eq__(self, other):
        return same(self, other)

    def __ne__(self, other):
        return not same(self, other)

    def __repr__(self):
        from .fmt import full_form
        return full_form(self)

    def has_head(self, name):
        return self.head is Sym(name)


def hash_of(e):
    if type(e) is Expr:
        return e._hash
    # (the type is in the hash: 1, 1.0 and "1" are different expressions)
    return hash((type(e).__name__, e))


def size_of(e):
    t = type(e)
    if t is Expr:
        return e.size
    if t is str:
        return 1 + len(e) // 16
    if t is int:
        return 1 + e.bit_length() // 128
    if t is Fraction:
        return 1 + (e.numerator.bit_length() + e.denominator.bit_length()) // 128
    return 1


def depth_of(e):
    return e.depth if type(e) is Expr else 0


def mk(head, args):
    """head[args] from a list or tuple of arguments."""
    return Expr(head, *args)


def same(a, b):
    """Structural identity (SameQ): the same types and the same values, compared iteratively."""
    stack = [(a, b)]
    while stack:
        x, y = stack.pop()
        if x is y:
            continue
        tx = type(x)
        if tx is not type(y):
            return False
        if tx is Expr:
            if x._hash != y._hash or len(x.args) != len(y.args) or x.depth != y.depth:
                return False
            stack.append((x.head, y.head))
            stack.extend(zip(x.args, y.args))
        elif tx is Sym:
            return False
        elif x != y:
            return False
    return True


TRUE, FALSE, NULL = Sym("True"), Sym("False"), Sym("Null")
LIST = Sym("List")
FAILED = Sym("$Failed")


def L(*items):
    return Expr(LIST, *items)


def boolean(v):
    return TRUE if v else FALSE


def is_number(e):
    t = type(e)
    return t is int or t is Fraction or t is float


def is_exact(e):
    t = type(e)
    return t is int or t is Fraction


def num(v):
    """A rational as Sprig's atom: an int when its denominator is 1."""
    if type(v) is Fraction and v.denominator == 1:
        return int(v.numerator)
    return v


def name_of(h):
    """A head's name when it is a symbol, else None."""
    return h.name if type(h) is Sym else None


def head_name(e):
    """The name of e's head as Head[e] gives it, for an atom; None for an Expr with a compound head."""
    t = type(e)
    if t is Expr:
        return e.head.name if type(e.head) is Sym else None
    if t is int:
        return "Integer"
    if t is Fraction:
        return "Rational"
    if t is float:
        return "Real"
    if t is str:
        return "String"
    return "Symbol"


def head_of(e):
    if type(e) is Expr:
        return e.head
    return Sym(head_name(e))


def is_list(e):
    return type(e) is Expr and e.head is LIST


# --- the canonical order (design §5.3): Sprig's own total order, stable and documented

_RANK_NUMBER, _RANK_STRING, _RANK_SYMBOL, _RANK_EXPR = 0, 1, 2, 3


def _rank(e):
    t = type(e)
    if t is int or t is Fraction or t is float:
        return _RANK_NUMBER
    if t is str:
        return _RANK_STRING
    if t is Sym:
        return _RANK_SYMBOL
    return _RANK_EXPR


def _atom_cmp(x, y):
    """-1, 0 or 1 for two atoms of the same rank."""
    if type(x) is Sym:
        a, b = x.name, y.name
        # (alphabetical, case folded first, so a < B < b < c; then the exact name)
        ka, kb = (a.lower(), a), (b.lower(), b)
        return -1 if ka < kb else (1 if ka > kb else 0)
    if type(x) is str:
        return -1 if x < y else (1 if x > y else 0)
    # numbers by value; an exact number before an equal Real
    if x < y:
        return -1
    if x > y:
        return 1
    tx, ty = type(x) is float, type(y) is float
    return (1 if tx else -1) if tx != ty else 0


def _power_base(e):
    """(base, exponent) for the order: a power sorts by its base, then its exponent; anything else is e^1."""
    if type(e) is Expr and e.head is POWER and len(e.args) == 2:
        return e.args[0], e.args[1]
    return e, 1


POWER = Sym("Power")
TIMES = Sym("Times")


def _coeff_term(e):
    """(term, coefficient) for the order of a sum's terms: 3 x sorts with x."""
    if type(e) is Expr and e.head is TIMES and len(e.args) >= 2 and is_number(e.args[0]):
        rest = e.args[1:]
        return (rest[0] if len(rest) == 1 else Expr(TIMES, *rest)), e.args[0]
    return e, None


def compare(a, b):
    """Sprig's canonical order: -1, 0 or 1.  Numbers first (by value), then strings, then symbols
    (alphabetically), then compound expressions; a power sorts by its base, a product with a numeric
    coefficient by the rest; compound expressions by head, then arguments in order, then length.  Iterative."""
    stack = [(a, b, 0)]
    while stack:
        x, y, phase = stack.pop()
        if phase == 1:
            # the tie-breaker pushed under a pair: a nonzero result decides
            if x != 0:
                return x
            continue
        if x is y:
            continue
        x1, cx = _coeff_term(x)
        y1, cy = _coeff_term(y)
        if cx is not None or cy is not None:
            stack.append((_atom_cmp(1 if cx is None else cx, 1 if cy is None else cy), None, 1))
            stack.append((x1, y1, 0))
            continue
        bx, ex = _power_base(x)
        by, ey = _power_base(y)
        if bx is not x or by is not y:
            stack.append((ex, ey, 0))
            stack.append((bx, by, 0))
            continue
        # (a product sorts by its factors, as a list against a lone factor: a b before c, x before x y)
        tx = type(x) is Expr and x.head is TIMES
        ty = type(y) is Expr and y.head is TIMES
        if tx != ty:
            fx = x.args if tx else (x,)
            fy = y.args if ty else (y,)
            nx, ny = len(fx), len(fy)
            stack.append((-1 if nx < ny else (1 if nx > ny else 0), None, 1))
            for i in range(min(nx, ny) - 1, -1, -1):
                stack.append((fx[i], fy[i], 0))
            continue
        rx, ry = _rank(x), _rank(y)
        if rx != ry:
            return -1 if rx < ry else 1
        if rx != _RANK_EXPR:
            c = _atom_cmp(x, y)
            if c:
                return c
            continue
        if x._hash == y._hash and same(x, y):
            continue
        nx, ny = len(x.args), len(y.args)
        stack.append((-1 if nx < ny else (1 if nx > ny else 0), None, 1))
        for i in range(min(nx, ny) - 1, -1, -1):
            stack.append((x.args[i], y.args[i], 0))
        stack.append((x.head, y.head, 0))
    return 0


class OrderKey:
    """A sort key for `compare`."""
    __slots__ = ("e",)

    def __init__(self, e):
        self.e = e

    def __lt__(self, other):
        return compare(self.e, other.e) < 0


def sort_canonical(args):
    return sorted(args, key=OrderKey)
