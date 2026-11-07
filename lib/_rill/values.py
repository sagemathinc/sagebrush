"""Rill's values (design/rill.md §4): R's vectors, NULL, symbols and calls.

A1.1 holds what the parser and the first evaluator need: atomic vectors
(logical, integer, double, complex, character) with attributes, NULL,
symbols, calls and the empty argument.  A1.2 adds coercion and the rest of
R's vector semantics here, and §8.3's ownership rule lives in this module
only, so every transition can be audited in one place.

NA is None in a vector's data, in every type; a double's NaN is a float
NaN, distinct from NA, as in R.
"""

TYPES = ("logical", "integer", "double", "complex", "character")


class RNull:
    """R's NULL (one object)."""
    __slots__ = ()

    def __repr__(self):
        return "NULL"


NULL = RNull()


class Vector:
    """An atomic vector: its type, its elements (None is NA) and its attributes."""
    __slots__ = ("type", "data", "attrs")

    def __init__(self, type, data, attrs=None):
        self.type = type
        self.data = data
        self.attrs = attrs

    def __len__(self):
        return len(self.data)

    def __repr__(self):
        return "Vector(%s, %r)" % (self.type, self.data)


def lgl(data, attrs=None):
    return Vector("logical", data, attrs)


def int_(data, attrs=None):
    return Vector("integer", data, attrs)


def dbl(data, attrs=None):
    return Vector("double", data, attrs)


def cplx(data, attrs=None):
    return Vector("complex", data, attrs)


def chr_(data, attrs=None):
    return Vector("character", data, attrs)


class Sym:
    """A symbol (R's "name"); one object per name."""
    __slots__ = ("name",)
    _table = {}

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return "Sym(%s)" % self.name


def sym(name):
    s = Sym._table.get(name)
    if s is None:
        s = Sym._table[name] = Sym(name)
    return s


class Lang:
    """A call: its function (usually a symbol) and its arguments, each a
    (name or None, value) pair."""
    __slots__ = ("fn", "args")

    def __init__(self, fn, args):
        self.fn = fn
        self.args = args

    def __repr__(self):
        return "Lang(%r, %r)" % (self.fn, self.args)


def call(name, *args):
    return Lang(sym(name), [(None, a) for a in args])


class Missing:
    """The empty argument, as in x[, 1] or f(a = )."""
    __slots__ = ()

    def __repr__(self):
        return "MISSING"


MISSING = Missing()


class Formals:
    """A function's formal arguments: (name, default or MISSING) pairs.  The
    parser puts it first in a `function` call, as R's pairlist of formals."""
    __slots__ = ("items",)

    def __init__(self, items):
        self.items = items

    def __repr__(self):
        return "Formals(%r)" % (self.items,)


class Placeholder:
    """The pipe placeholder `_` (R 4.2), legal only as a named argument in a
    pipe's right-hand side; R shows it as "_" in its errors."""
    __slots__ = ("line", "col")

    def __init__(self, line, col):
        self.line = line
        self.col = col

    def __repr__(self):
        return "Placeholder"
