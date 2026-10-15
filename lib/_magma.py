"""Magma's values, printing and intrinsics, for programs translated by
src/magma.ts.  Arithmetic and number theory reuse sage_all and the
Sagebrush engines; what differs is Magma's semantics (1-based sequences
with value semantics, sets, tuples, multiple return values, reference
arguments) and its printing, checked against Magma by magma-tests/.
"""

import math as _math
import re as _re
import sys as _sys
from fractions import Fraction as _Fraction

import sage_all as _sa
from sage_all import Rational as _Rational, _intdiv
import _sage_poly as _sp

__all__ = []  # filled at the end: every intrinsic

WIDTH = 80


class MagmaError(Exception):
    """A Magma runtime error; `where` names what failed, as in Magma's
    "Runtime error in assert: ...".  Magma follows most runtime errors with
    an empty line, but not those of assert, coercion (!) or a call with the
    wrong number of arguments (`blank`)."""

    def __init__(self, msg="", where=None, blank=True, pos=None):
        # (pyjs: exceptions take positional arguments only)
        super().__init__(msg)
        self.where = where
        self.blank = blank
        self.pos = pos  # (line, col) of the failing operation, if known


class _UserError(MagmaError):
    """Raised by Magma's `error` statement: reported without the source line."""


_pos = [0, 0]


def _here(line, col):
    _pos[0], _pos[1] = line, col


_src = ["<magma>", [], None]  # name, lines, mode


def _source(name, text, mode=None):
    """How errors behave (src/magma.ts Recover), checked against Magma 2.18:
    "session" (input from stdin, as Magma's interactive session reads it):
    every error is reported and the input goes on; "file": a runtime or
    syntax error stops it, an undeclared identifier does not; None (no
    recovery: notebook and kernel cells): every error stops it."""
    if mode not in (None, "file", "session"):
        raise ValueError("unknown mode %r" % (mode,))
    _src[0], _src[1], _src[2] = name, text.split("\n"), mode


def _where(line, col):
    """The source line with a caret under column `col`, after Magma's
    'In file' header (which a session leaves out)."""
    text = _src[1][line - 1] if 0 < line <= len(_src[1]) else ""
    head = "" if _src[2] == "session" else 'In file "%s", line %d, column %d:\n' % (_src[0], line, col)
    return "\n%s>> %s\n%s^\n" % (head, text, " " * (col + 2))


def _undeclared(name, line, col):
    """Where `name` is first used at or after (line, col), as Magma points at
    an undeclared identifier."""
    rx = _re.compile(r"(?<![A-Za-z0-9_'])%s(?![A-Za-z0-9_])" % _re.escape(name))
    for k in range(line - 1, len(_src[1])):
        start = col - 1 if k == line - 1 else 0
        m = rx.search(_src[1][k], start)
        if m:
            return k + 1, m.start() + 1
    return line, col


def _report(e, line, col):
    """A runtime error, reported as Magma does; then a file stops and a
    session goes on."""
    if isinstance(e, SystemExit):
        raise e
    m = _re.match(r"name '([A-Za-z_][A-Za-z0-9_]*)' is not defined", str(e)) if isinstance(e, NameError) else None
    if m:
        # Magma rejects a statement that uses an undeclared identifier
        # (before running it) and goes on, in a file too
        name = m.group(1)
        name = name[:-1] if name.endswith("_") else name
        line, col = _undeclared(name, line, col)
        _sys.stdout.write("%sUser error: Identifier '%s' has not been declared or assigned\n" % (_where(line, col), name))
        if _src[2] is None:
            raise SystemExit(1)  # no recovery: a cell stops, as before
        return
    if isinstance(e, _UserError):
        _sys.stdout.write("Runtime error: %s\n" % e)
    else:
        msg = str(e) if isinstance(e, MagmaError) else "%s: %s" % (type(e).__name__, e)
        where = getattr(e, "where", None)
        blank = "\n" if getattr(e, "blank", True) else ""
        line, col = getattr(e, "pos", None) or (line, col)
        # Magma wraps the message at 80 columns, as it prints values
        text = "Runtime error%s: %s" % (" in " + where if where else "", msg)
        _sys.stdout.write("%s%s\n%s" % (_where(line, col), _wrap(text, 0, 0), blank))
    if _src[2] != "session":
        raise SystemExit(1)


def _compile_error(line, col, msg):
    """A statement Magma rejects before running it ("User error: ..."):
    reported, and the next statement runs (in a file too); a cell (no
    recovery) stops."""
    _sys.stdout.write("%s%s\n" % (_where(line, col), _wrap("User error: " + msg, 0, 0)))
    if _src[2] is None:
        raise SystemExit(1)


def _syntax_error(line, col, detail):
    """A syntax error at (line, col) (line 0: at the end of the input), in
    Magma's words on stdout; the parser's reason goes to stderr."""
    if line:
        _sys.stdout.write("%sUser error: bad syntax\n" % _where(line, col))
    else:
        _sys.stdout.write("\nUser error: syntax error at end of input\n")
    _sys.stderr.write("sagebrush: bad syntax: %s (%s, line %d)\n" % (detail, _src[0], line or len(_src[1])))
    if _src[2] != "session" or not line:
        raise SystemExit(1)


def _quit():
    raise SystemExit(0)


def _error(args):
    raise _UserError(" ".join(_str(a) for a in args))


def _assert(c):
    if not _bool(c):
        raise MagmaError("Assertion failed", "assert", False)


# ------------------------------------------------------------------ return values

class Multi(tuple):
    """Several return values: the first in an expression, all when printed."""

    show = None  # how many to print (Factorization prints one)


def _multi(vals, show=None):
    m = Multi(vals)
    m.show = show
    return m


class Ref1:
    __slots__ = ("v",)

    def __init__(self, v):
        self.v = v


class RefK:
    __slots__ = ("vs",)

    def __init__(self, vs):
        self.vs = vs


def _first(v):
    return v[0] if isinstance(v, Multi) else v


def _values(v, n):
    if isinstance(v, Multi):
        if len(v) < n:
            raise MagmaError("too few return values (%d) for %d variables" % (len(v), n))
        return list(v[:n])
    if n == 1:
        return [v]
    raise MagmaError("the expression has one value, assigned to %d variables" % n)


def _ref1(r):
    # a user procedure returns Ref1; an intrinsic procedure, the new value
    return r.v if isinstance(r, Ref1) else r


def _refk(r, k):
    return r.vs[k]


def _named(f, name):
    f.__name__ = name
    return f


# ------------------------------------------------------------------ collections

class MSeq(list):
    """A Magma sequence: 1-based, printed [ 1, 2, 3 ]."""

    __slots__ = ("universe",)

    def __init__(self, it=(), universe=None):
        list.__init__(self, it)
        self.universe = universe

    def __repr__(self):
        return _str(self)


class MRange:
    """[a..b by c]: an arithmetic progression, printed [ a .. b by c ]."""

    __slots__ = ("a", "b", "c")

    def __init__(self, a, b, c=1):
        if c == 0:
            raise MagmaError("the step of a range must be nonzero")
        n = (b - a) // c + 1 if (b - a) * c >= 0 else 0
        self.a, self.c = a, c
        self.b = a + (n - 1) * c if n > 0 else a - c

    def __len__(self):
        return max(0, (self.b - self.a) // self.c + 1)

    def __iter__(self):
        return iter(range(self.a, self.b + (1 if self.c > 0 else -1), self.c))

    def __getitem__(self, i):
        return self.a + i * self.c

    def __eq__(self, other):
        return list(self) == list(other) if isinstance(other, (MSeq, MRange, list)) else NotImplemented

    def __hash__(self):
        return hash(tuple(self))

    def __repr__(self):
        return _str(self)


class MSet:
    """A Magma set (also indexed sets {@ @} and multisets {* *})."""

    __slots__ = ("items", "keys", "kind", "universe", "range")

    def __init__(self, it=(), kind="set", universe=None):
        self.items, self.keys, self.kind, self.universe, self.range = [], {}, kind, universe, None
        for x in it:
            self.add(x)

    def add(self, x):
        k = _key(x)
        if self.kind == "multi":
            if k in self.keys:
                self.keys[k][1] += 1
            else:
                self.keys[k] = [x, 1]
                self.items.append(x)
            return
        if k not in self.keys:
            self.keys[k] = x
            self.items.append(x)

    def remove(self, x):
        k = _key(x)
        if k in self.keys:
            if self.kind == "multi" and self.keys[k][1] > 1:
                self.keys[k][1] -= 1
                return
            del self.keys[k]
            self.items = [y for y in self.items if _key(y) != k]

    def __contains__(self, x):
        return _key(x) in self.keys

    def __len__(self):
        if self.kind == "multi":
            return sum(v[1] for v in self.keys.values())
        return len(self.items)

    def __iter__(self):
        if self.kind == "multi":
            for x in self.items:
                for _ in range(self.keys[_key(x)][1]):
                    yield x
            return
        yield from self.ordered()

    def ordered(self):
        if self.kind == "indexed":
            return list(self.items)
        try:
            return sorted(self.items, key=_sortkey)
        except TypeError:
            return list(self.items)

    def __eq__(self, other):
        return isinstance(other, MSet) and set(self.keys) == set(other.keys)

    def __hash__(self):
        return hash(frozenset(self.keys))

    def __repr__(self):
        return _str(self)


class MTuple(tuple):
    """A Magma tuple <a, b>: 1-based."""

    def __repr__(self):
        return _str(self)


def _key(x):
    if isinstance(x, (MSeq, MRange, list)):
        return ("seq",) + tuple(_key(y) for y in x)
    if isinstance(x, MTuple):
        return ("tup",) + tuple(_key(y) for y in x)
    if isinstance(x, MSet):
        return ("set", frozenset(x.keys))
    if isinstance(x, bool):
        return ("bool", x)
    return x


def _sortkey(x):
    # sets of numbers print sorted; others in the order they were built
    if isinstance(x, (int, _Fraction)) and not isinstance(x, bool):
        return (0, x)
    raise TypeError


def _seq(items, universe=None):
    return MSeq(items, universe)


def _set(items, universe=None):
    return MSet(items, "set", universe)


def _iset(items, universe=None):
    return MSet(items, "indexed", universe)


def _mset(items, universe=None):
    return MSet(items, "multi", universe)


def _range(a, b, c, open_):
    if open_ == "[":
        if isinstance(a, int) and isinstance(b, int) and isinstance(c, int):
            return MRange(a, b, c)
        return MSeq(_sa.srange(a, b + c if c > 0 else b - c, c) if False else _frange(a, b, c))
    s = MSet(MRange(a, b, c) if isinstance(a, int) and isinstance(b, int) else _frange(a, b, c), {"{": "set", "{@": "indexed", "{*": "multi"}[open_])
    if open_ == "{" and isinstance(a, int) and isinstance(b, int) and c == 1 and b >= a:
        s.range = (a, b)
    return s


def _frange(a, b, c):
    out, x = [], a
    while (x <= b) if c > 0 else (x >= b):
        out.append(x)
        x = x + c
    return out


def _own(v, name=None):
    """Value semantics: an assigned (or passed) container is a copy.  The
    name of the variable assigned lets some structures print it (2*C.1 = 0)."""
    if name is not None and hasattr(v, "_magma_assigned"):
        v._magma_assigned(name)
    if isinstance(v, MSeq):
        return MSeq((_own(x) for x in v), v.universe)
    if isinstance(v, MSet):
        s = MSet((), v.kind, v.universe)
        s.items = [_own(x) for x in v.items]
        s.keys = {k: (list(val) if v.kind == "multi" else val) for k, val in v.keys.items()}
        s.range = v.range
        return s
    if isinstance(v, MTuple):
        return MTuple(_own(x) for x in v)
    if isinstance(v, MRec):
        return v._copy()
    return v


def _iter(s):
    if isinstance(s, (MSeq, MRange, MTuple, list, tuple)):
        return iter(s)
    if isinstance(s, MSet):
        return iter(list(s))
    if isinstance(s, str):
        return iter(s)
    if hasattr(s, "__iter__"):
        return iter(s)
    raise MagmaError("cannot iterate over %s" % _str(s))


def _to(a, b, c):
    if c == 0:
        raise MagmaError("the step must be nonzero")
    return iter(range(a, b + 1, c)) if c > 0 else iter(range(a, b - 1, c))


def _check_index(n, i):
    if not isinstance(i, int) or isinstance(i, bool):
        raise MagmaError("Bad argument types\nArgument types given: %s" % Type(i))
    if i < 1 or i > n:
        raise MagmaError("Index %d (%d) should be in the range [1 .. %d]" % (abs(i), i, n) if i < 1 else "Sequence element %d not defined" % i)


def _index(s, i):
    if isinstance(s, (MSeq, MRange, MTuple, list)):
        if isinstance(i, (MSeq, MRange)):
            return MSeq(_index(s, j) for j in i)
        _check_index(len(s), i)
        v = s[i - 1]
        if v is _UNDEF:
            raise MagmaError("Sequence element %d not defined" % i)
        return v
    if isinstance(s, str):
        if isinstance(i, (MSeq, MRange)):
            return "".join(_index(s, j) for j in i)
        _check_index(len(s), i)
        return s[i - 1]
    if isinstance(s, MSet) and s.kind == "indexed":
        _check_index(len(s.items), i)
        return s.items[i - 1]
    if hasattr(s, "_magma_index"):
        return s._magma_index(i)
    if callable(s):
        return s(i)
    raise MagmaError("cannot index %s" % _str(s))


_UNDEF = object()
_DELETE = object()  # assigned along a path by `delete r`a`


def _assign_path(obj, path, val):
    """x[i][j] := v (sequences: also one past the end, filling undefined)."""
    if not path:
        return val if val is _DELETE else _own(val)
    kind, i = path[0][:2]
    pos = path[0][2] if len(path[0]) > 2 else None
    if kind == "attr":
        if isinstance(obj, MRec):
            if len(path) == 1:
                obj._set(i, val, pos)
            else:
                obj._set(i, _assign_path(obj._get(i, pos), path[1:], val), pos)
            return obj
        setattr(obj, i, _assign_path(getattr(obj, i, None), path[1:], val))
        return obj
    if isinstance(obj, MRange):
        obj = MSeq(obj)
    if obj is None:
        obj = MSeq()
    if isinstance(obj, MSeq):
        if not isinstance(i, int) or i < 1:
            raise MagmaError("Index %s should be positive" % _str(i))
        while len(obj) < i:
            obj.append(_UNDEF)
        obj[i - 1] = _assign_path(obj[i - 1] if obj[i - 1] is not _UNDEF else None, path[1:], val)
        return obj
    if isinstance(obj, MTuple):
        l = list(obj)
        _check_index(len(l), i)
        l[i - 1] = _assign_path(l[i - 1], path[1:], val)
        return MTuple(l)
    raise MagmaError("cannot assign into %s" % _str(obj))


def _getattr(x, name, pos=None):
    """x`name (and x``s, with s a string)."""
    if isinstance(x, MRec):
        return x._get(name, pos)
    if not isinstance(name, str):
        raise MagmaError("Bad argument types", "`", True, pos)
    return getattr(x, name)


def _assigned(x, name):
    """assigned x`name."""
    if isinstance(x, MRec):
        x._field(name, None)
        return name in x.vals
    return hasattr(x, name)


def _assigned_name(read):
    """assigned x, for a variable x."""
    try:
        read()
        return True
    except NameError:
        return False


# ------------------------------------------------------------------ records

def _magma_str(x):
    """A structure or category as Magma prints it where it must be read
    back (the fields of a record format): IntegerRing(), RationalField()."""
    if x is _ZZ:
        return "IntegerRing()"
    if x is _QQ:
        return "RationalField()"
    return _inline(x)


class MRecFormat:
    """recformat< n : Integers(), misc, seq : SeqEnum >: field names, each
    with an optional structure (values are coerced into it) or category
    (values must have it).  Behaviour from Magma's documentation (Records)
    and checked against Magma."""

    def __init__(self, fields):
        self.fields = [(n, c) for n, c in fields]
        self.names = [n for n, _ in fields]

    def __repr__(self):
        return "recformat<%s>" % ", ".join(n if c is None else "%s: %s" % (n, _magma_str(c)) for n, c in self.fields)

    def _constraint(self, name):
        for n, c in self.fields:
            if n == name:
                return c
        raise KeyError(name)


def _recformat(fields, pos=None):
    """recformat< ... >: each restriction must be a structure or a category
    (Magma's "Expression for field a is not a category or structure")."""
    for name, c in fields:
        if c is None or isinstance(c, _Cat) or c is _ZZ or c is _QQ:
            continue
        if isinstance(c, (MSeq, MSet, MRange)) or hasattr(c, "_magma_coerce") or hasattr(c, "_magma_contains"):
            # a structure, but its use (and printing) as a restriction isn't done
            raise MagmaError("this structure as the restriction of field %s is not supported yet" % name,
                             "recformat< ... >", True, pos)
        raise MagmaError("Expression for field %s is not a category or structure" % name, "elt< ... >", True, pos)
    return MRecFormat(fields)


def _global_name(obj):
    """The first (oldest) global variable that holds obj now, or None.
    Magma names structures this way where it prints them inside others
    (checked against Magma: after `B := X; A := X; delete X;` a record of
    format X prints rec<B | ...>)."""
    main = _sys.modules.get("__main__")
    for k, v in (vars(main).items() if main is not None else ()):
        if v is obj and not k.startswith("_"):
            return k[:-1] if k.endswith("_") and k[:-1] in _PYKW else k
    return None


def _format_name(fmt):
    """How a record prints its format."""
    return _global_name(fmt) or repr(fmt)


# Python keywords: a Magma name that is one gets a trailing _ (src/magma.ts pyName)
_PYKW = set(("False None True and as assert async await break class continue def del elif else except finally for from global "
             "if import in is lambda nonlocal not or pass raise return try while with yield print exec match case type").split())


class MRec:
    """A record: values for some of its format's fields."""

    def __init__(self, fmt, vals=None):
        self.fmt = fmt
        self.vals = dict(vals or {})

    def _field(self, name, pos):
        if not isinstance(name, str):
            raise MagmaError("Bad argument types", "`", True, pos)
        if name not in self.fmt.names:
            raise MagmaError("Field '%s' does not exist in this record" % name, "`", True, pos)
        return name

    def _get(self, name, pos=None):
        self._field(name, pos)
        if name not in self.vals:
            raise MagmaError("Field '%s' is not assigned" % name, "`", True, pos)
        return self.vals[name]

    def _check(self, name, v):
        """v as stored in field `name`, or None if it doesn't fit."""
        c = self.fmt._constraint(name)
        if c is None:
            return v
        if isinstance(c, _Cat):
            return v if Type(v) == c else None
        try:
            return _coerce(c, v)
        except Exception:
            return None

    def _set(self, name, v, pos=None):
        self._field(name, pos)
        if v is _DELETE:
            self.vals.pop(name, None)
            return
        w = self._check(name, v)
        if w is None:
            raise MagmaError("RHS value invalid for field '%s'" % name, ":=", False, pos)
        self.vals[name] = w

    def _copy(self):
        return MRec(self.fmt, {k: _own(v) for k, v in self.vals.items()})

    def _str(self, indent):
        head = "rec<%s | " % _format_name(self.fmt)
        names = [n for n in self.fmt.names if n in self.vals]
        if not names:
            return head + ">"
        pad = " " * (indent + 4)
        lines = []
        for n in names:
            start = "%s := " % n
            v = self.vals[n]
            # a record or a list of structures nests 4 deeper; a value that
            # wraps (a long sequence or string) continues 8 deeper
            deep = isinstance(v, MRec) or (isinstance(v, (MSeq, MSet)) and not all(_atomic(x) for x in v))
            lines.append(pad + start + _str(v, indent + (4 if deep else 8), indent + 4 + len(start)))
        return head + "\n" + ",\n".join(lines) + ">"


def _rec(fmt, assigns, pos=None):
    """rec< F | name := value, ... >."""
    try:
        return _make_rec(fmt, assigns)
    except MagmaError as e:
        e.pos = e.pos or pos
        raise


def _make_rec(fmt, assigns):
    if not isinstance(fmt, MRecFormat):
        raise MagmaError("Bad argument types", "rec< ... >")
    r = MRec(fmt)
    seen = set()
    for name, v in assigns:
        # in order, as Magma checks them: unknown, given twice, then the value
        if name not in fmt.names:
            raise MagmaError("Field '%s' is not in the format" % name, "rec< ... >")
        if name in seen:
            raise MagmaError("Field '%s' given more than once" % name, "rec< ... >")
        seen.add(name)
        w = r._check(name, v)
        if w is None:
            c = fmt._constraint(name)
            raise MagmaError("Value for field '%s' should have category %s" % (name, c) if isinstance(c, _Cat)
                             else "Value for field '%s' not in structure given by format" % name, "rec< ... >")
        r.vals[name] = _own(w)
    return r


def Names(x):
    """The field names of a record format or of a record."""
    if isinstance(x, MRec):
        x = x.fmt
    if isinstance(x, MRecFormat):
        return MSeq(list(x.names))
    raise MagmaError("Bad argument types", "'Names'")


def Format(r):
    """The format of a record."""
    if isinstance(r, MRec):
        return r.fmt
    raise MagmaError("Bad argument types", "'Format'")


# ------------------------------------------------------------------ maps

def _struct_name(S):
    """A map's domain or codomain as Magma prints it in the map: "RngInt: x"
    when a global variable x holds it, else the structure itself."""
    n = _global_name(S)
    return "%s: %s" % (Type(S), n) if n is not None else _inline(S)


class MMap:
    """A map made by map< A -> B | ... >, pmap< ... > or hom< ... > (rule
    forms), from Magma's documentation (Mappings) and checked against
    Magma: given by a rule x :-> e(x) (optionally with an inverse rule) or
    by its graph (pairs <x, y> or x -> y); also inverses and compositions."""

    def __init__(self, dom, cod, rule=None, inv=None, graph=None, partial=False, parts=None, inverse_of=None):
        self.dom, self.cod = dom, cod
        self.rule, self.inv, self.graph, self.partial = rule, inv, graph, partial
        self.parts = parts            # (f, g): the composition, f first
        self.inverse_of = inverse_of  # the map this is the inverse of

    def __repr__(self):
        head = "Mapping from: %s to %s" % (_struct_name(self.dom), _struct_name(self.cod))
        if self.parts is not None:
            f, g = self.parts
            return head + "\n" + _wrap("Composition of %r and" % f, 0, 0) + "\n" + repr(g)
        if self.graph is not None:
            return head + "".join("\n    " + _inline(MTuple([x, y])) for x, y in self.graph)
        if self.rule is not None:
            return head + " given by a rule" + ("" if self.inv is not None else " [no inverse]")
        return head

    def __call__(self, x):
        if isinstance(x, MSet) and not _in(x, self.dom):
            # the image of a set of elements
            return _set([self(y) for y in x.ordered()])
        if self.parts is not None:
            return self.parts[1](self.parts[0](x))
        if self.inverse_of is not None:
            return self.inverse_of._preimage(x, "map application")
        if self.graph is not None:
            for a, b in self.graph:
                if _eq(a, x):
                    return b
            raise MagmaError("Application of map failed", "map application")
        if not _in(x, self.dom):
            raise MagmaError("Element is not in the domain of the map", "map application")
        y = self.rule(x)
        if not _in(y, self.cod):
            raise MagmaError("Element is not in the codomain of the map", "map application")
        return _coerce(self.cod, y) if hasattr(self.cod, "_magma_coerce") else y

    def _preimage(self, y, where):
        """The preimage of y, as Magma computes it: through the inverses of
        the parts of a composition (the last part first); by the inverse
        rule, checking that y is in the codomain and the result in the
        domain (Magma's message is the same for both), and coercing it."""
        if self.parts is not None:
            f, g = self.parts
            return f._preimage(g._preimage(y, where), where)
        if self.inverse_of is not None:
            return self.inverse_of(y)
        if self.graph is not None:
            raise MagmaError("Map has no inverse", where)
        if self.inv is None:
            raise MagmaError("There is no rule for calculating the preimage", where)
        if not _in(y, self.cod):
            raise MagmaError("Element is not in the codomain of the map", where)
        x = self.inv(y)
        if not _in(x, self.dom):
            raise MagmaError("Element is not in the codomain of the map", where)
        return _coerce(self.dom, x) if hasattr(self.dom, "_magma_coerce") else x

    def __mul__(self, g):
        if not isinstance(g, MMap):
            return NotImplemented
        if not (g.dom is self.cod or _eq(g.dom, self.cod)):
            raise MagmaError("The codomain of the first map is not the domain of the second", "'*'")
        return MMap(self.dom, g.cod, parts=(self, g))

    def _inverse(self, where):
        if self.parts is not None:
            f, g = self.parts
            return MMap(self.cod, self.dom, parts=(g._inverse(where), f._inverse(where)))
        if self.inverse_of is not None:
            return self.inverse_of
        if self.graph is not None:
            raise MagmaError("Map has no inverse", where)
        return MMap(self.cod, self.dom, inverse_of=self)


def _map(kind, dom, cod, rule=None, inv=None, graph=None, pairs=None, pos=None):
    """map< A -> B | ... > (kind "map", "pmap" or "hom").  A graph gives at
    most one image for each element, and a map's (not a pmap's) gives one
    for every element of its domain, which must then be finite (Magma's
    errors, checked against Magma)."""
    where = "%s< ... >" % kind
    try:
        if pairs is not None:
            graph = [tuple(p) for p in pairs]
        elif graph is not None:
            items = graph.ordered() if isinstance(graph, MSet) else list(graph)
            if not all(isinstance(t, MTuple) and len(t) == 2 for t in items):
                raise MagmaError("argument 1 does not yield a pair or a set or sequence of pairs in the map's graph", where)
            graph = [tuple(t) for t in items]
        if graph is not None:
            for k, (a, b) in enumerate(graph):
                if any(_eq(a, a2) for a2, _ in graph[:k]):
                    raise MagmaError("More than one image is given for a single element of the domain", where)
            for a, b in graph:
                if not _in(a, dom) or not _in(b, cod):
                    raise MagmaError("argument 1 does not yield a pair or a set or sequence of pairs in the map's graph", where)
            if kind != "pmap":
                if dom is _ZZ or dom is _QQ:
                    raise MagmaError("Domain of map has no cardinality algorithm", where)
                if not isinstance(dom, (MSet, MSeq, MRange)):
                    raise MagmaError("a map given by a graph on this domain is not supported yet", where)
                if not all(any(_eq(a, x) for a, _ in graph) for x in _iter(dom)):
                    raise MagmaError("Not enough images given to constructor", where)
        return MMap(dom, cod, rule, inv, graph, kind == "pmap")
    except MagmaError as e:
        e.pos = e.pos or pos
        raise


def _preimage(f, y, pos=None):
    """y @@ f; an error points at the @@ (pos)."""
    try:
        if isinstance(f, MMap):
            return f._preimage(y, "'@@'")
        raise MagmaError("Bad argument types", "'@@'")
    except MagmaError as e:
        e.pos = e.pos or pos
        raise


def Domain(f):
    """The domain of a map."""
    return f.dom


def Codomain(f):
    """The codomain of a map."""
    return f.cod


def Inverse(f):
    """The inverse of a map (applying it needs an inverse rule)."""
    if isinstance(f, MMap):
        return f._inverse("'Inverse'")
    raise MagmaError("Bad argument types", "'Inverse'")


def Image(f):
    """The image of a map given by its graph."""
    if isinstance(f, MMap) and f.graph is not None:
        return _set([b for _, b in f.graph])
    raise MagmaError("Image of this map is not supported yet", "'Image'")


class _Unset:
    def __repr__(self):
        return "<unassigned>"


_UNSET = _Unset()  # a map rule's snapshot of a name not assigned then


_CAPTURED = set()  # the names map rules have captured


def _snap(read, name):
    """A map rule's snapshot of a free variable when the map is made: its
    value (copied, value semantics), or _UNSET if it is not assigned."""
    _CAPTURED.add(name)
    try:
        return _own(read())
    except NameError:
        return _UNSET


def _delete_check(name):
    """delete x: in Magma a map rule that captured x sees it unassigned
    afterwards (though a later assignment doesn't reach the rule); that
    isn't modelled, so deleting a captured variable is refused."""
    if name in _CAPTURED:
        raise MagmaError("deleting a variable that a map rule has captured is not supported yet")


def _val(v, name):
    """A captured variable read in a map rule: an error (as Magma's) only
    if it was not assigned when the map was made."""
    if v is _UNSET:
        raise MagmaError("Variable '%s' has not been initialized" % (name[:-1] if name.endswith("_") and name[:-1] in _PYKW else name))
    return v


def _enclosing_unset(name):
    """A map rule made inside another rule reads a name that is a local of
    the enclosing rule (tested there by `assigned` first), never assigned:
    Magma's error when the inner map is made."""
    raise MagmaError("Variable '%s' in enclosing environment has not been assigned to"
                     % (name[:-1] if name.endswith("_") and name[:-1] in _PYKW else name))


def _not_supported(what, pos=None):
    """Something the translator parses but Sagebrush doesn't do yet."""
    raise MagmaError("%s is not supported yet" % what, None, True, pos)


def _unsupported(name, pos=None):
    """A constructor name< ... > the translator parses but Sagebrush doesn't
    implement yet: an error, never a guess."""
    raise MagmaError("%s< ... > is not supported yet" % name, None, True, pos)


# ------------------------------------------------------------------ operators

def _bool(v):
    if isinstance(v, bool):
        return v
    raise MagmaError("Bad argument types: expected a boolean, got %s" % Type(v))


def _num(x):
    return isinstance(x, (int, _Fraction)) and not isinstance(x, bool)


def _div(a, b):
    if isinstance(a, int) and isinstance(b, int) and not isinstance(a, bool):
        return _intdiv(a, b)
    if isinstance(a, MReal) or isinstance(b, MReal):
        return MReal.of(a) / MReal.of(b)
    return a / b


def _idiv(a, b):
    if isinstance(a, int) and isinstance(b, int):
        if b == 0:
            raise MagmaError("Division by zero")
        return a // b
    if hasattr(a, "quo_rem"):
        return a.quo_rem(b)[0]
    return a // b


def _mod(a, b):
    if isinstance(a, int) and isinstance(b, int):
        if b == 0:
            raise MagmaError("Division by zero")
        return a % b
    if hasattr(a, "quo_rem"):
        return a.quo_rem(b)[1]
    return a % b


def _pow(a, b):
    if isinstance(a, int) and isinstance(b, int) and not isinstance(a, bool):
        if b < 0:
            return _intdiv(1, a ** -b)
        return a ** b
    if isinstance(a, MReal) or isinstance(b, MReal):
        return MReal.of(a) ** b
    return a ** b


def _eq(a, b):
    if isinstance(a, MRecFormat) or isinstance(b, MRecFormat):
        # Magma has no equality of record formats
        raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (Type(a), Type(b)), "'eq'")
    if isinstance(a, MReal) or isinstance(b, MReal):
        return MReal.of(a) == MReal.of(b)
    if isinstance(a, (MSeq, MRange)) and isinstance(b, (MSeq, MRange)):
        return list(a) == list(b)
    return a == b


def _ne(a, b):
    return not _eq(a, b)


def _lt(a, b):
    return a < b


def _le(a, b):
    return a <= b


def _gt(a, b):
    return a > b


def _ge(a, b):
    return a >= b


def _cmpeq(a, b):
    try:
        return _eq(a, b)
    except Exception:
        return False


def _cmpne(a, b):
    return not _cmpeq(a, b)


def _in(x, s):
    if hasattr(s, "_magma_contains"):
        return s._magma_contains(x)
    if isinstance(s, str):
        return x in s
    return any(_eq(x, y) for y in s) if isinstance(s, (MSeq, MRange, MTuple)) else x in s


def _notin(x, s):
    return not _in(x, s)


def _subset(a, b):
    return all(_in(x, b) for x in a)


def _notsubset(a, b):
    return not _subset(a, b)


def _card(s):
    if hasattr(s, "_magma_card"):
        return s._magma_card()
    return len(s)


def _cat(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a + b
    if isinstance(a, (MSeq, MRange)) and isinstance(b, (MSeq, MRange)):
        return MSeq(list(a) + list(b), getattr(a, "universe", None))
    raise MagmaError("Bad argument types for cat: %s, %s" % (Type(a), Type(b)))


def _join(a, b):
    return MSet(list(a) + list(b))


def _meet(a, b):
    return MSet(x for x in a if _in(x, b))


def _diff(a, b):
    return MSet(x for x in a if not _in(x, b))


def _sdiff(a, b):
    return MSet([x for x in a if not _in(x, b)] + [x for x in b if not _in(x, a)])


def _reduce(op, s):
    items = list(_iter(s))
    if not items:
        if op == "+":
            return 0
        if op == "*":
            return 1
        if op == "and":
            return True
        if op == "or":
            return False
        if op == "cat":
            return MSeq()
        raise MagmaError("Illegal null sequence")
    r = items[0]
    for x in items[1:]:
        if op == "+":
            r = r + x
        elif op == "*":
            r = r * x
        elif op == "cat":
            r = _cat(r, x)
        elif op == "and":
            r = r and x
        elif op == "or":
            r = r or x
        elif op == "join":
            r = _join(r, x)
        elif op == "meet":
            r = _meet(r, x)
        else:
            raise MagmaError("unknown reduction &%s" % op)
    return r


def _gen(R, i):
    if hasattr(R, "_magma_gen"):
        return R._magma_gen(i)
    return R.gen(i - 1)


def _coerce(R, x):
    if hasattr(R, "_magma_coerce"):
        return R._magma_coerce(x)
    return R(x)


def _apply(f, x):
    return f(x)


# ------------------------------------------------------------------ reals

class MReal:
    """A real number to `prec` significant decimal digits (RealField(prec)),
    printed as Magma prints it."""

    __slots__ = ("m", "e", "prec")  # value m * 10^e, |m| < 10^prec

    def __init__(self, m, e, prec=30):
        self.prec = prec
        if m == 0:
            self.m, self.e = 0, 0
            return
        # round m to prec significant digits
        digits = len(str(abs(m)))
        if digits > prec:
            drop = digits - prec
            q, r = divmod(abs(m), 10 ** drop)
            if 2 * r >= 10 ** drop:
                q += 1
            m = q if m > 0 else -q
            e += drop
            if len(str(abs(m))) > prec:
                m //= 10
                e += 1
        self.m, self.e = m, e

    @staticmethod
    def of(x, prec=None):
        if isinstance(x, MReal):
            return x if prec is None or prec == x.prec else MReal(x.m, x.e, prec)
        prec = prec or 30
        if isinstance(x, bool):
            raise MagmaError("cannot convert a boolean to a real")
        if isinstance(x, int):
            return MReal(x, 0, prec)
        if isinstance(x, _Fraction):
            return MReal._frac(_Fraction(x), prec)
        if isinstance(x, float):
            return MReal._frac(_Fraction(x), prec)
        raise MagmaError("cannot convert %s to a real" % Type(x))

    @staticmethod
    def _frac(f, prec):
        if f == 0:
            return MReal(0, 0, prec)
        # m / 10^k with prec + 5 digits, then rounded
        k = prec + 5 - (len(str(abs(f.numerator))) - len(str(f.denominator)))
        if k >= 0:
            m = _Fraction(f.numerator * 10 ** k, f.denominator)
        else:
            m = _Fraction(f.numerator, f.denominator * 10 ** (-k))
        q = round(m)
        return MReal(int(q), -k, prec)

    def frac(self):
        return _Fraction(self.m) * (_Fraction(10) ** self.e)

    def __float__(self):
        return float(self.frac())

    def _p(self, o):
        return min(self.prec, o.prec) if isinstance(o, MReal) else self.prec

    def __add__(self, o):
        return MReal._frac(self.frac() + MReal.of(o).frac(), self._p(o)) if _real_ok(o) else NotImplemented

    __radd__ = __add__

    def __sub__(self, o):
        return MReal._frac(self.frac() - MReal.of(o).frac(), self._p(o)) if _real_ok(o) else NotImplemented

    def __rsub__(self, o):
        return MReal._frac(MReal.of(o).frac() - self.frac(), self._p(o)) if _real_ok(o) else NotImplemented

    def __mul__(self, o):
        return MReal._frac(self.frac() * MReal.of(o).frac(), self._p(o)) if _real_ok(o) else NotImplemented

    __rmul__ = __mul__

    def __truediv__(self, o):
        d = MReal.of(o).frac()
        if d == 0:
            raise MagmaError("Division by zero")
        return MReal._frac(self.frac() / d, self._p(o))

    def __rtruediv__(self, o):
        return MReal.of(o, self.prec) / self

    def __pow__(self, n):
        if isinstance(n, int):
            return MReal._frac(self.frac() ** n, self.prec)
        return Exp(MReal.of(n, self.prec) * Log(self))

    def __neg__(self):
        return MReal(-self.m, self.e, self.prec)

    def __abs__(self):
        return MReal(abs(self.m), self.e, self.prec)

    def __eq__(self, o):
        return _real_ok(o) and self.frac() == MReal.of(o).frac()

    def __hash__(self):
        return hash(self.frac())

    def __lt__(self, o):
        return self.frac() < MReal.of(o).frac()

    def __le__(self, o):
        return self.frac() <= MReal.of(o).frac()

    def __gt__(self, o):
        return self.frac() > MReal.of(o).frac()

    def __ge__(self, o):
        return self.frac() >= MReal.of(o).frac()

    def __repr__(self):
        p = self.prec
        if self.m == 0:
            return "0." + "0" * p
        sign = "-" if self.m < 0 else ""
        d = str(abs(self.m))
        d = d + "0" * (p - len(d))  # exactly p significant digits
        e = self.e + len(str(abs(self.m))) - 1  # value = d[0].d[1:] * 10^e
        if 0 <= e < p:
            return sign + d[: e + 1] + "." + d[e + 1:]
        if e == -1:
            return sign + "0." + d
        return sign + d[0] + "." + d[1:] + "E" + str(e)


def _real_ok(o):
    return isinstance(o, (MReal, int, _Fraction, float)) and not isinstance(o, bool)


def _real(s):
    f = _Fraction(s)
    return MReal._frac(f, 30)


class RealField_:
    def __init__(self, prec=30):
        self.prec = prec

    def __repr__(self):
        return "Real field of precision %d" % self.prec

    def __call__(self, x):
        return MReal.of(x, self.prec)

    _magma_coerce = __call__

    def __eq__(self, other):
        return isinstance(other, RealField_) and other.prec == self.prec

    def __hash__(self):
        return hash(("RR", self.prec))


def RealField(prec=30):
    return RealField_(prec)


# ------------------------------------------------------------------ printing

def _atomic(v):
    if isinstance(v, (bool, int, str, _Fraction, MReal)):
        return True
    if isinstance(v, MTuple):
        return all(_atomic(x) for x in v)
    return False


def _inline(v, in_tuple=False):
    """v on one line (as inside a tuple)."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return '"' + v + '"' if in_tuple and not isinstance(v, _Cat) else v
    if isinstance(v, MTuple):
        return "<" + ", ".join(_inline(x, True) for x in v) + ">"
    if isinstance(v, MRange):
        return _range_str(v)
    if isinstance(v, (MSeq, MSet)):
        o, c = _brackets(v)
        items = _items(v)
        if not items:
            return o.replace(" ", "") + c.replace(" ", "")
        return o + ", ".join(items) + c
    if v is None:
        return "None"
    return repr(v)


def _range_str(v):
    if len(v) == 0:
        return "[]"
    return "[ %d .. %d%s ]" % (v.a, v.b, "" if v.c == 1 else " by %d" % v.c)


def _brackets(v):
    if isinstance(v, MSeq):
        return "[ ", " ]"
    return {"set": ("{ ", " }"), "indexed": ("{@ ", " @}"), "multi": ("{* ", " *}")}[v.kind]


def _items(v):
    if isinstance(v, MSet) and v.kind == "multi":
        out = []
        for x in sorted(v.items, key=_sortkey) if all(_num(x) for x in v.items) else v.items:
            n = v.keys[_key(x)][1]
            out.append(_inline(x) + ("^^%d" % n if n > 1 else ""))
        return out
    items = v.ordered() if isinstance(v, MSet) else list(v)
    return ["undef" if x is _UNDEF else _inline(x) for x in items]


def _str(v, indent=0, col=None):
    """Magma's printing of v (possibly over several lines), starting at
    column `col` (default: the indentation)."""
    col = indent if col is None else col
    if type(v).__name__ == "MList":
        if not v:
            return "[* *]"
        if all(_atomic(x) for x in v):
            return _wrap("[* " + ", ".join(_inline(x) for x in v) + " *]", indent, indent)
        if all(type(x).__name__ == "MList" for x in v):
            return "[* " + ", ".join(_str(x, indent) for x in v) + " *]"
        pad = " " * (indent + 4)
        return "[*\n" + ",\n".join(pad + _str(x, indent + 4) for x in v) + "\n" + " " * indent + "*]"
    if isinstance(v, MRange):
        return _range_str(v)
    if isinstance(v, MSet) and v.range is not None and v.kind == "set":
        return "{ %d .. %d }" % v.range
    if isinstance(v, (MSeq, MSet)):
        o, c = _brackets(v)
        raw = v.ordered() if isinstance(v, MSet) else list(v)
        if not raw:
            return o.strip() + c.strip()
        if all(_atomic(x) or x is _UNDEF for x in raw):
            items = _items(v)
            # wrapped at WIDTH: an item fits when the line (from the column
            # it starts at), it and ", " do
            lines, line = [], o
            for k, it in enumerate(items):
                piece = it + (", " if k < len(items) - 1 else c)
                start = col if not lines else indent
                if line.strip() and start + len(line) + len(it) + 2 > WIDTH:
                    lines.append(line)
                    line = ""
                line += piece
            lines.append(line)
            return "\n".join(l if i == 0 else " " * indent + l for i, l in enumerate(lines))
        pad = " " * (indent + 4)
        inner = [pad + _str(x, indent + 4) for x in raw]
        return o.strip() + "\n" + ",\n".join(inner) + "\n" + " " * indent + c.strip()
    if isinstance(v, MRec):
        return v._str(indent)
    if getattr(v, "_magma_nowrap", False):
        return _inline(v)
    return _wrap(_inline(v), col, indent + _extra(v), indent)


def _extra(v):
    """Continuation indent of a wrapped value: polynomials (and tuples
    holding one) indent 4 more, as Magma's polynomial printer does."""
    if isinstance(v, _sp.Polynomial):
        return 4
    if isinstance(v, MTuple):
        return max([_extra(x) for x in v] + [0])
    return 0


def _wrap(text, first_col, cont, indent=0):
    """Magma's line breaking at WIDTH columns, at spaces: a word fits when it
    does (the space after it only if there is room); continuation lines
    start at column `cont`.  The first line starts at `first_col` (its
    indentation already written)."""
    if "\n" in text:
        lines = text.split("\n")
        return "\n".join(_wrap(l, first_col if k == 0 else 0, cont if k == 0 else 0) for k, l in enumerate(lines))
    if first_col + len(text) <= WIDTH or " " not in text:
        return text
    words = text.split(" ")
    lines, line = [], ""
    for k, w in enumerate(words):
        start = first_col if not lines else cont
        if line and start + len(line) + len(w) > WIDTH:
            lines.append(line)
            line = ""
            start = cont
        line += w
        if k < len(words) - 1 and start + len(line) + 1 <= WIDTH:
            line += " "
    lines.append(line)
    return lines[0] + "".join("\n" + " " * cont + l for l in lines[1:])


def _print_line(vals):
    # values on one line, but a new line after a structure (sequence,
    # set, polynomial, ...), as Magma prints them
    out = ""
    for k, v in enumerate(vals):
        if k:
            out += " " if _atomic(vals[k - 1]) else "\n"
            if getattr(v, "_magma_block", False) and _atomic(vals[k - 1]):
                out += "\n"  # a group starts on its own line
        col = len(out) - (out.rfind("\n") + 1)
        out += _str(v, 0, col)
    _sys.stdout.write(out + "\n")


def _flat(vals):
    """a, b; prints every value of each (Maximum(S) is two)."""
    out = []
    for v in vals:
        if isinstance(v, Multi):
            out.extend(list(v) if v.show is None else list(v)[: v.show])
        else:
            out.append(v)
    return out


def _show_values(v):
    if v is None or isinstance(v, (Ref1, RefK)):
        return
    if isinstance(v, Multi):
        vals = list(v) if v.show is None else list(v)[: v.show]
        _print_line(vals)
        return
    _print_line([v])


def _sprintf(fmt, *args):
    out, k, i = [], 0, 0
    while i < len(fmt):
        c = fmt[i]
        if c == "%" and i + 1 < len(fmt):
            d = fmt[i + 1]
            i += 2
            if d == "%":
                out.append("%")
            elif d in "omh":
                out.append(_str(args[k]) if d != "h" else hex(args[k])[2:])
                k += 1
            else:
                # %3o and the like
                j = i - 1
                while j < len(fmt) and fmt[j].isdigit():
                    j += 1
                w = int(fmt[i - 1:j]) if j > i - 1 else 0
                out.append(_str(args[k]).rjust(w))
                k += 1
                i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _printf(fmt, *args):
    _sys.stdout.write(_sprintf(fmt, *args))


def _time_start():
    import time
    _pos.append(time.time())


def _time_end():
    import time
    t = time.time() - _pos.pop()
    _sys.stdout.write("Time: %.3f\n" % t)


# ------------------------------------------------------------------ structures

class _IntegerRing:
    def __repr__(self):
        return "Integer Ring"

    def __call__(self, x):
        return _coerce_int(x)

    _magma_coerce = __call__

    def _magma_contains(self, x):
        return isinstance(x, int) and not isinstance(x, bool) or isinstance(x, _Fraction) and x.denominator == 1

    def _magma_card(self):
        raise MagmaError("Cardinality of an infinite structure")


class _RationalField:
    def __repr__(self):
        return "Rational Field"

    def __call__(self, x):
        return _sa._q(_Fraction(x)) if not isinstance(x, int) else x

    _magma_coerce = __call__

    def _magma_contains(self, x):
        return isinstance(x, (int, _Fraction)) and not isinstance(x, bool)


_ZZ, _QQ = _IntegerRing(), _RationalField()


def _coerce_int(x):
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    if isinstance(x, _Fraction) and x.denominator == 1:
        return int(x)
    if isinstance(x, str):
        return int(x)
    raise MagmaError("Illegal coercion")


def Integers():
    return _ZZ


IntegerRing = Integers


def Rationals():
    return _QQ


RationalField = Rationals


def Parent(x):
    if hasattr(x, "_magma_parent"):
        return x._magma_parent()
    if isinstance(x, bool):
        raise MagmaError("Parent of a boolean")
    if isinstance(x, int):
        return _ZZ
    if isinstance(x, _Fraction):
        return _QQ
    if isinstance(x, MReal):
        return RealField_(x.prec)
    if isinstance(x, _sp.Polynomial):
        return x._ring
    if hasattr(x, "parent"):
        return x.parent()
    raise MagmaError("Parent: unknown structure")


class _Cat(str):
    """A category (the type of an object, as Type returns it): prints as its
    name, without quotes."""


# Categories bound as names (RngIntElt, SeqEnum, ...), for Type(x) eq
# RngIntElt and record formats such as recformat< n : RngIntElt >.
_CATEGORIES = ("BoolElt RngIntElt FldRatElt FldReElt MonStgElt SeqEnum SetEnum SetIndx SetMulti Tup "
               "List Rec RecFrmt RngUPolElt RngUPol RngInt FldRat Map").split()
for _c in _CATEGORIES:
    globals()[_c] = _Cat(_c)


def _type_name(x):
    if isinstance(x, _Cat):
        return "Cat"
    if isinstance(x, MRec):
        return "Rec"
    if isinstance(x, MRecFormat):
        return "RecFrmt"
    if isinstance(x, MMap):
        return "Map"
    if x is _ZZ:
        return "RngInt"
    if x is _QQ:
        return "FldRat"
    if type(x).__name__ == "MList":
        return "List"
    return None


def Type(x):
    return _Cat(_type_name(x) or _type(x))


def _type(x):
    if isinstance(x, bool):
        return "BoolElt"
    if isinstance(x, int):
        return "RngIntElt"
    if isinstance(x, _Fraction):
        return "FldRatElt"
    if isinstance(x, MReal):
        return "FldReElt"
    if isinstance(x, str):
        return "MonStgElt"
    if isinstance(x, (MSeq, MRange)):
        return "SeqEnum"
    if isinstance(x, MSet):
        return {"set": "SetEnum", "indexed": "SetIndx", "multi": "SetMulti"}[x.kind]
    if isinstance(x, MTuple):
        return "Tup"
    if isinstance(x, _sp.Polynomial):
        return "RngUPolElt"
    return type(x).__name__


# ------------------------------------------------------------------ polynomials

def PolynomialRing(R, n=1):
    """A new polynomial ring; its variable prints as $.1 until named."""
    base = _sp.ZZ if R is _ZZ else _sp.QQ if R is _QQ else None
    if base is None:
        raise MagmaError("PolynomialRing: only over Integers() and Rationals() so far")
    return _sp.PolynomialRing_(base, "$.1")


def AssignNames(R, names):
    # a procedure (AssignNames(~R, names)): returns R, the new value of ~R
    if isinstance(R, _sp.PolynomialRing_) and names:
        R._name = names[0]
    elif hasattr(R, "_magma_names"):
        R._magma_names(names)
    return R


def _poly_parts(f):
    return f


def Degree(f):
    if isinstance(f, _sp.Polynomial):
        return f.degree()
    if hasattr(f, "_magma_degree"):
        return f._magma_degree()
    raise MagmaError("Degree: bad argument")


def Coefficients(f):
    return MSeq(_m_num(c) for c in f.list())


def Coefficient(f, i):
    l = f.list()
    return _m_num(l[i]) if i < len(l) else 0


def LeadingCoefficient(f):
    return _m_num(f.leading_coefficient()) if isinstance(f, _sp.Polynomial) else f


def Evaluate(f, x):
    return f(x)


def Derivative(f):
    return f.derivative()


def Discriminant(f):
    if hasattr(f, "_magma_discriminant"):
        return f._magma_discriminant()
    return _m_num(f.discriminant())


def Resultant(f, g):
    return f.resultant(g)


def IsIrreducible(f):
    return f.is_irreducible()


def _m_num(c):
    if isinstance(c, _Fraction) and c.denominator == 1:
        return int(c)
    return c


def Roots(f, R=None):
    if not isinstance(f, _sp.Polynomial):
        raise MagmaError("Roots: bad argument")
    rs = f.roots()
    return MSeq(sorted((MTuple([_m_num(r), m]) for r, m in rs), key=lambda t: t[0]))


def _factorization(n):
    if isinstance(n, _sp.Polynomial):
        F = n.factor()
        R = n._ring
        consts, out = [], []
        for g, e in F:
            if not isinstance(g, _sp.Polynomial):
                if g != -1 and R._base is not _sp.QQ:
                    consts.append((abs(g), e))  # over Z: the content's primes
                continue
            if g.degree() == 0:
                continue
            out.append(MTuple([g, e]))
        if R._base is _sp.QQ:
            # monic factors over Q, the leading coefficient apart
            out = [MTuple([g.monic(), e]) for g, e in out]
        # by degree, then the coefficients from the top (Magma's order)
        out.sort(key=lambda t: (t[0].degree(), list(reversed(t[0].list()))))
        consts = [MTuple([R(p), e]) for p, e in sorted(consts)]
        return _multi([MSeq(consts + out), _m_num(n.leading_coefficient())], show=1)
    if isinstance(n, _Fraction) and not isinstance(n, int):
        raise MagmaError("Factorization of a rational")
    if n == 0:
        raise MagmaError("Factorization of 0")
    F = _sa.factor(abs(n))
    return _multi([MSeq(MTuple([p, e]) for p, e in F), 1 if n > 0 else -1], show=1)


Factorization = Factorisation = _factorization


# ------------------------------------------------------------------ integers

# (Proof is forwarded when given: true means proven or an error, as in
# Sage mode; by default a prime above 3.3e24 is a BPSW probable prime,
# not proven as Magma's default would promise: the systematic review's
# ASR-F1)
def IsPrime(n, Proof=None):
    return _sa.is_prime(n, proof=Proof)


def IsProbablePrime(n, Bases=None):
    return _sa.is_prime(n)


def NextPrime(n, Proof=None):
    return _sa.next_prime(n, proof=Proof)


def PreviousPrime(n, Proof=None):
    return _sa.previous_prime(n, proof=Proof)


def PrimesUpTo(n):
    return MSeq(_sa.prime_range(n + 1))


def PrimesInInterval(a, b):
    return MSeq(_sa.prime_range(a, b + 1))


def NthPrime(n):
    return _sa.nth_prime(n)


def PrimeDivisors(n):
    return MSeq(p for p, _ in _sa.factor(abs(n)))


def Divisors(n):
    return MSeq(_sa.divisors(abs(n)))


def NumberOfDivisors(n):
    return _sa.number_of_divisors(n)


def SumOfDivisors(n):
    return _sa.sigma(n)


def DivisorSigma(k, n):
    return _sa.sigma(n, k)


def EulerPhi(n):
    return _sa.euler_phi(n)


def MoebiusMu(n):
    return _sa.moebius(n)


def IsPrimePower(n):
    if n > 1:
        F = _sa.factor(n)
        if len(F) == 1:
            return _multi([True, F[0][0], F[0][1]])
    return False


def Gcd(*args):
    if len(args) == 1:
        args = tuple(args[0])
    if any(isinstance(a, _sp.Polynomial) for a in args):
        g = args[0]
        for a in args[1:]:
            g = g.gcd(a)
        return g
    return _sa.gcd(*args)


GCD = GreatestCommonDivisor = Gcd


def Lcm(*args):
    if len(args) == 1:
        args = tuple(args[0])
    return _sa.lcm(*args)


LCM = LeastCommonMultiple = Lcm


def Xgcd(a, b):
    g, s, t = _sa.xgcd(a, b)
    return _multi([g, s, t])


XGCD = ExtendedGreatestCommonDivisor = Xgcd


def Quotrem(a, b):
    return _multi([_idiv(a, b), _mod(a, b)])


def Modexp(a, k, m):
    return pow(a, k, m)


def Modinv(a, m):
    return _sa.inverse_mod(a, m)


InverseMod = Modinv


def Binomial(n, k):
    return _sa.binomial(n, k)


def Factorial(n):
    return _sa.factorial(n)


def Fibonacci(n):
    return _sa.fibonacci(n)


def IsSquare(n):
    if isinstance(n, int) and n >= 0:
        r = _math.isqrt(n)
        if r * r == n:
            return _multi([True, r])
        return False
    if isinstance(n, _Fraction) and n >= 0:
        a, b = _math.isqrt(n.numerator), _math.isqrt(n.denominator)
        if a * a == n.numerator and b * b == n.denominator:
            return _multi([True, _sa._q(_Fraction(a, b))])
        return False
    return False


def Isqrt(n):
    return _math.isqrt(n)


def Sqrt(x):
    if isinstance(x, MReal):
        return _rsqrt(x)
    return _rsqrt(MReal.of(x))


def _rsqrt(x):
    if x.m < 0:
        raise MagmaError("Sqrt of a negative real")
    p = x.prec
    f = x.frac()
    k = p + 5
    # floor(sqrt(f) * 10^k)
    num = f.numerator * 10 ** (2 * k)
    s = _math.isqrt(num // f.denominator)
    return MReal._frac(_Fraction(s, 10 ** k), p)


def Exp(x):
    x = MReal.of(x)
    p = x.prec
    f = x.frac()
    eps = _Fraction(1, 10 ** (p + 10))
    # e^f = (e^(f/2^s))^(2^s)
    s = 0
    while abs(f) > _Fraction(1, 2):
        f /= 2
        s += 1
    term, total, n = _Fraction(1), _Fraction(1), 1
    while abs(term) > eps:
        term = _Fraction(round(term * f / n * 10 ** (p + 15)), 10 ** (p + 15))
        total += term
        n += 1
    for _ in range(s):
        total = _Fraction(round(total * total * 10 ** (p + 15)), 10 ** (p + 15))
    return MReal._frac(total, p)


def Log(x, b=None):
    if b is not None:
        return Log(x) / Log(b)
    x = MReal.of(x)
    p = x.prec
    f = x.frac()
    if f <= 0:
        raise MagmaError("Log of a nonpositive number")
    # log f = 2 atanh((f-1)/(f+1)), after scaling f by powers of 2
    k = 0
    while f > 2:
        f /= 2
        k += 1
    while f < _Fraction(1, 2):
        f *= 2
        k -= 1
    z = (f - 1) / (f + 1)
    z2 = z * z
    eps = _Fraction(1, 10 ** (p + 10))
    term, total, n = z, z, 1
    while abs(term) > eps:
        term = _Fraction(round(term * z2 * 10 ** (p + 15)), 10 ** (p + 15))
        n += 2
        total += term / n
    total *= 2
    if k:
        total += k * _log2(p)
    return MReal._frac(total, p)


def _log2(p):
    z = _Fraction(1, 3)
    z2 = z * z
    eps = _Fraction(1, 10 ** (p + 10))
    term, total, n = z, z, 1
    while abs(term) > eps:
        term = term * z2
        n += 2
        total += term / n
    return 2 * total


def Pi(R=None):
    p = R.prec if isinstance(R, RealField_) else 30
    # Machin: pi = 16 atan(1/5) - 4 atan(1/239)
    def atan_inv(x):
        eps = _Fraction(1, 10 ** (p + 10))
        term = _Fraction(1, x)
        total, n, sign = term, 1, 1
        while term > eps:
            term = term / (x * x)
            n += 2
            sign = -sign
            total += sign * term / n
        return total
    return MReal._frac(16 * atan_inv(5) - 4 * atan_inv(239), p)


def IsEven(n):
    return n % 2 == 0


def IsOdd(n):
    return n % 2 == 1


def IsZero(x):
    return x == 0


def IsOne(x):
    return x == 1


def IsUnit(x):
    return x in (1, -1)


def Abs(x):
    return abs(x)


def Sign(x):
    return (x > 0) - (x < 0)


def Floor(x):
    return _math.floor(x.frac() if isinstance(x, MReal) else x)


def Ceiling(x):
    return _math.ceil(x.frac() if isinstance(x, MReal) else x)


def Round(x):
    f = x.frac() if isinstance(x, MReal) else _Fraction(x)
    # half away from zero
    return int(_math.floor(f + _Fraction(1, 2))) if f >= 0 else -int(_math.floor(-f + _Fraction(1, 2)))


def Truncate(x):
    f = x.frac() if isinstance(x, MReal) else _Fraction(x)
    return int(f)


def Max(*args):
    if len(args) == 1:
        return Maximum(args[0])
    return max(args)


def Min(*args):
    if len(args) == 1:
        return Minimum(args[0])
    return min(args)


def Maximum(s, *rest):
    if rest:
        return max((s,) + rest)
    items = list(_iter(s))
    m = max(items)
    return _multi([m, items.index(m) + 1]) if isinstance(s, (MSeq, MRange)) else m


def Minimum(s, *rest):
    if rest:
        return min((s,) + rest)
    items = list(_iter(s))
    m = min(items)
    return _multi([m, items.index(m) + 1]) if isinstance(s, (MSeq, MRange)) else m


def Valuation(n, p):
    if isinstance(n, _Fraction) and not isinstance(n, int):
        return _sa.valuation(n.numerator, p) - _sa.valuation(n.denominator, p)
    return _sa.valuation(n, p)


def Numerator(x):
    return x.numerator if isinstance(x, _Fraction) else x


def Denominator(x):
    return x.denominator if isinstance(x, _Fraction) else 1


def Intseq(n, b=10):
    return MSeq(_sa.digits(n, b))


def Seqint(s, b=10):
    r = 0
    for d in reversed(list(s)):
        r = r * b + d
    return r


def ChineseRemainderTheorem(a, m):
    a, m = list(a), list(m)
    x, M = a[0] % m[0], m[0]
    for ai, mi in zip(a[1:], m[1:]):
        x = _sa.crt(x, ai, M, mi)
        M = M * mi // _math.gcd(M, mi)
    return x


CRT = ChineseRemainderTheorem


def IntegerToString(n, b=10):
    if b == 10:
        return str(n)
    digs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    s, m = "", abs(n)
    while m:
        s = digs[m % b] + s
        m //= b
    return ("-" if n < 0 else "") + (s or "0")


def StringToInteger(s, b=10):
    return int(s, b)


def Sprint(x):
    return _str(x)


def Sprintf(fmt, *args):
    return _sprintf(fmt, *args)


# ------------------------------------------------------------------ sequences and sets

# Intrinsic procedures are functions here: Append(S, x) returns the new
# sequence, and the statement Append(~S, x) assigns it back to S.

def Append(s, x):
    s = MSeq(_own(MSeq(s)))
    s.append(x)
    return s


def Include(s, x):
    if isinstance(s, MSet):
        t = _own(s)
        t.add(x)
        return t
    s = _own(MSeq(s))
    if not any(_eq(x, y) for y in s):
        s.append(x)
    return s


def Exclude(s, x):
    if isinstance(s, MSet):
        t = _own(s)
        t.remove(x)
        return t
    s = _own(MSeq(s))
    for k, y in enumerate(s):
        if _eq(x, y):
            del s[k]
            break
    return s


def Remove(s, i):
    s = MSeq(s)
    _check_index(len(s), i)
    del s[i - 1]
    return s


def Insert(s, i, x):
    s = MSeq(s)
    s.insert(i - 1, x)
    return s


def Reverse(s):
    if isinstance(s, str):
        return s[::-1]
    return MSeq(reversed(list(s)))


class Perm(tuple):
    """A permutation of 1..n (images), printed in cycle notation."""

    def __repr__(self):
        seen, cycles = set(), []
        for i in range(1, len(self) + 1):
            if i in seen or self[i - 1] == i:
                continue
            c, j = [], i
            while j not in seen:
                seen.add(j)
                c.append(j)
                j = self[j - 1]
            cycles.append("(" + ", ".join(map(str, c)) + ")")
        return "".join(cycles) or "Id"


def Sort(s, f=None):
    items = list(s)
    if f is None:
        return MSeq(sorted(items))
    import functools
    order = sorted(range(len(items)), key=functools.cmp_to_key(lambda i, j: f(items[i], items[j])))
    # the permutation taking positions in the result to positions in s
    return _multi([MSeq(items[i] for i in order), Perm(i + 1 for i in order)])


def Index(s, x):
    for k, y in enumerate(_iter(s)):
        if _eq(x, y):
            return k + 1
    return 0


Position = Index


def IsEmpty(s):
    return len(s) == 0


def Seqset(s):
    return MSet(s)


def SetToSequence(s):
    return MSeq(s.ordered() if isinstance(s, MSet) else s)


Setseq = SetToSequence


def SequenceToSet(s):
    return MSet(s)


def Set(s):
    return MSet(s)


def Eltseq(x):
    if isinstance(x, _sp.Polynomial):
        return Coefficients(x)
    return MSeq(x)


def Universe(s):
    u = getattr(s, "universe", None)
    if u is not None:
        return u
    items = list(_iter(s))
    if all(isinstance(x, int) and not isinstance(x, bool) for x in items):
        return _ZZ
    if all(isinstance(x, (int, _Fraction)) for x in items):
        return _QQ
    return None


def Random(s):
    import random
    return random.choice(list(_iter(s)))


# ------------------------------------------------------------------ modular forms

import _sage_modular as _smod
from sagebrush import mf as _mf


_HECKE_RING = []


def _qx(name=None):
    """The polynomial ring of Magma's Hecke polynomials (one, cached): its
    variable prints as $.1 until the cuspidal machinery names it x."""
    if not _HECKE_RING:
        _HECKE_RING.append(_sp.PolynomialRing_(_sp.QQ, "$.1"))
    R = _HECKE_RING[0]
    if name and R._name == "$.1":
        R._name = name
    return R


class MGamma0:
    def __init__(self, N):
        self.N = N

    def __repr__(self):
        return "Gamma_0(%d)" % self.N


def Gamma0(N):
    return MGamma0(N)


def _level(N):
    return N.N if isinstance(N, MGamma0) else N


class MModSym:
    """A space of modular symbols for Gamma_0(N) (trivial character)."""

    def __init__(self, N, k, sign, kind="full", dim=None, poly=None):
        self.N, self.k, self.sign, self.kind = N, k, sign, kind
        self._dim, self._poly = dim, poly  # an orbit: its T-charpoly

    def _sage(self):
        return _smod.ModularSymbols(self.N, self.k, self.sign)

    def _dims(self):
        return _mf.dims(self.N, self.k)

    def _magma_dimension(self):
        if self._dim is not None:
            return self._dim
        d = self._dims()
        mult = 2 if self.sign == 0 else 1
        if self.kind == "full":
            return self._sage().dimension()
        if self.kind == "cuspidal":
            return mult * d["cusp"]
        if self.kind == "new":
            return mult * d["new"]
        raise MagmaError("dimension")

    def __repr__(self):
        head = "Full modular symbols space" if self.kind == "full" else "Modular symbols space"
        return "%s for Gamma_0(%d) of weight %d and dimension %d over Rational Field" % (head, self.N, self.k, self._magma_dimension())


def ModularSymbols(N, k=2, sign=0):
    return MModSym(_level(N), int(k), int(sign))


def Dimension(M):
    if hasattr(M, "_magma_dimension"):
        return M._magma_dimension()
    raise MagmaError("Dimension: bad argument")


def CuspidalSubspace(M):
    if M.kind not in ("full", "cuspidal"):
        return M
    return MModSym(M.N, M.k, M.sign, "cuspidal")


def NewSubspace(M):
    if M.kind == "full":
        raise MagmaError("The given space must be contained in the cuspidal subspace")
    return MModSym(M.N, M.k, M.sign, "new")


def _cusp_poly(M, p):
    # The charpoly of T_p on the cuspidal part of the full space.  For the
    # trivial character and p not dividing N, cuspidal eigenvalues are real
    # of absolute value at most 2 p^((k-1)/2) (T_p is self-adjoint; Deligne),
    # while Eisenstein ones chi(p) + chi^-1(p) p^(k-1) are non-real or
    # +-(1 + p^(k-1)).  So the irreducible factors with only real roots, all
    # inside that bound, are exactly the cuspidal ones.
    from fractions import Fraction
    from _sage_ec import _sturm_real_roots
    if M.N % p == 0:
        raise MagmaError("HeckePolynomial: p must not divide the level for a cuspidal space")
    f = M._sage().hecke_polynomial(p)
    x = f.parent().gen()
    g = f.parent()(1)
    lam = 1 + p ** (M.k - 1)
    for h, e in f.factor():
        c = [Fraction(int(a)) for a in h.list()]
        real = _sturm_real_roots(c) == len(c) - 1
        if real and not (len(c) == 2 and abs(c[0] / c[1]) == lam):
            g *= h ** e
    d = M._dims()["cusp"] * (2 if M.sign == 0 else 1)
    if g.degree() != d:
        raise ArithmeticError("HeckePolynomial: cuspidal part of degree %d, expected %d" % (g.degree(), d))
    return g


def HeckePolynomial(M, p):
    R = _qx("x" if M.kind != "full" else None)
    if M.kind == "full":
        f = M._sage().hecke_polynomial(p)
    elif M.kind == "cuspidal":
        f = _cusp_poly(M, p)
    else:
        raise MagmaError("HeckePolynomial on this space is not supported yet")
    return R(f.list())


class _HeckeOp:
    """T_p on a space, for its characteristic polynomial; its matrix isn't
    computed."""

    def __init__(self, M, p):
        self.M, self.p = M, p

    def __repr__(self):
        raise MagmaError("the matrix of a Hecke operator is not supported yet (CharacteristicPolynomial works)")


def HeckeOperator(M, p):
    return _HeckeOp(M, p)


def CharacteristicPolynomial(T):
    if isinstance(T, _HeckeOp):
        return HeckePolynomial(T.M, T.p)
    raise MagmaError("CharacteristicPolynomial: matrices are not supported yet")


def NewformDecomposition(M):
    if M.kind not in ("cuspidal", "new"):
        M = NewSubspace(CuspidalSubspace(M))
    if M.kind == "cuspidal":
        raise MagmaError("NewformDecomposition of a cuspidal space with old forms is not supported yet; use NewSubspace")
    nf = _mf.newforms(M.N, M.k, bound=10)["newforms"]
    mult = 2 if M.sign == 0 else 1
    return MSeq(MModSym(M.N, M.k, M.sign, "orbit", mult * o["dim"], o["charpoly"]) for o in sorted(nf, key=lambda o: o["dim"]))


def DimensionCuspFormsGamma0(N, k):
    return _mf.dims(N, k)["cusp"]


def DimensionNewCuspFormsGamma0(N, k):
    return _mf.dims(N, k)["new"]


class MModForms:
    def __init__(self, N, k, cusp=True, base="Integer Ring", dim=None):
        self.N, self.k, self.cusp, self.base, self.dim = N, k, cusp, base, dim

    def _magma_dimension(self):
        if self.dim is not None:
            return self.dim
        d = _mf.dims(self.N, self.k)
        return d["cusp"] if self.cusp else d["cusp"] + d["eisenstein"]

    def __repr__(self):
        return "Space of modular forms on Gamma_0(%d) of weight %d and dimension %d over %s." % (self.N, self.k, self._magma_dimension(), self.base)


def CuspForms(N, k=2):
    return MModForms(_level(N), int(k))


def ModularForms(N, k=2):
    return MModForms(_level(N), int(k), cusp=False)


class MNewform:
    def __init__(self, N, k, traces, parent, letter="a"):
        self.N, self.k, self.traces, self._parent, self._letter = N, k, traces, parent, letter

    def _known(self, n):
        # a_1..a_n, computing more when needed (unknown coefficients are not zero)
        if n > len(self.traces):
            nf = _mf.newforms(self.N, self.k, bound=max(2 * n, 100))["newforms"]
            self.traces = [o for o in nf if o["letter"] == self._letter][0]["traces"]
        return self.traces

    def __repr__(self):
        return _qexp(self._known(11), 12)

    def _magma_parent(self):
        return self._parent


class MList(list):
    """A list [* ... *]."""

    def __repr__(self):
        return _str(self)


def _qexp(a, prec):
    return _smod._qexp([int(t) for t in a], prec)


def Newforms(S):
    if not isinstance(S, MModForms):
        raise MagmaError("Newforms: a space of cusp forms")
    nf = _mf.newforms(S.N, S.k, bound=100)["newforms"]
    out = MList()
    for o in nf:
        # a newform's parent is the space of its Galois orbit
        parent = MModForms(S.N, S.k, True, "Rational Field", o["dim"])
        if o["dim"] != 1:
            raise MagmaError("Newforms with non-rational coefficients are not supported yet (use DimensionNewCuspFormsGamma0, NewformDecomposition)")
        out.append(MList([MNewform(S.N, S.k, o["traces"], parent, o["letter"])]))
    return out


def qExpansion(f, prec=12):
    if not isinstance(f, MNewform):
        raise MagmaError("qExpansion: a newform")
    return _PowerSeries(_qexp(f._known(prec - 1), prec))


class _PowerSeries(str):
    def __repr__(self):
        return str(self)


# ------------------------------------------------------------------ elliptic curves

def EllipticCurve(a, b=None):
    try:
        return _smod.EllipticCurve(list(a) if isinstance(a, (MSeq, MRange)) else a, b)
    except (ValueError, ArithmeticError) as e:
        raise MagmaError(str(e))


def TraceOfFrobenius(E, p):
    return E.ap(p)


def Conductor(E):
    return E.conductor()


def aInvariants(E):
    return MSeq(E.a_invariants())


def jInvariant(E):
    return _m_num(E.j_invariant())


def CremonaReference(E):
    return E.cremona_label()


class _AbGroup:
    _magma_block = True  # printed on a line of its own after other values

    def __init__(self, invs):
        # finite invariants > 1, and 0 for each copy of Z
        self.invs = [d for d in invs if d > 1] + [0 for d in invs if d == 0]
        self.name = "$"

    def _magma_assigned(self, name):
        self.name = name

    def _magma_card(self):
        if 0 in self.invs:
            return _sa.Infinity if hasattr(_sa, "Infinity") else float("inf")
        n = 1
        for d in self.invs:
            n *= d
        return n

    def __repr__(self):
        if not self.invs:
            return "Abelian Group of order 1"
        lines = ["Abelian Group isomorphic to " + " + ".join("Z/%d" % d if d else "Z" for d in self.invs),
                 "Defined on %d generator%s" % (len(self.invs), "s" if len(self.invs) > 1 else ""), "Relations:"]
        lines += ["    %d*%s.%d = 0" % (d, self.name, i + 1) for i, d in enumerate(self.invs) if d]
        return "\n".join(lines)


def TorsionSubgroup(E):
    n = E.torsion_order()
    # rational 2-torsion: the rational roots of 4x^3 + b2 x^2 + 2 b4 x + b6
    b2, b4, b6, _ = E.b_invariants()
    R = _sp.PolynomialRing(_sp.QQ, "x")
    x = R.gen()
    two = 1 + len((4 * x ** 3 + b2 * x ** 2 + 2 * b4 * x + b6).roots())
    if two == 4:
        return _AbGroup([2, n // 2])
    return _AbGroup([n])



# ------------------------------------------------------------------ number fields, matrices
# (engine/classgroup through _sage_nf and _sage_matrix, printed as Magma does)

import _sage_nf as _snf
import _sage_matrix as _smat


class _MNFElt(_snf.NumberFieldElement):
    __slots__ = ()

    def __repr__(self):
        # Magma: a common denominator in front, 1/2*(b^2 + b)
        c = self._c
        d = 1
        for x in c:
            d = d * x.denominator // _math.gcd(d, x.denominator)
        if d == 1 or sum(1 for x in c if x) <= 1:
            return _snf._repr_poly(c, self._K._name)
        num = [x * d for x in c]
        return "1/%d*(%s)" % (d, _snf._repr_poly(num, self._K._name))

    def _magma_parent(self):
        return self._K


class _MNumberField(_snf.NumberField_absolute):
    _element_class = _MNFElt
    _magma_block = True

    def __init__(self, f, quadratic=False):
        super().__init__(f, "$.1")
        self._quadratic = quadratic
        self._order = None

    def _magma_names(self, names):
        self._name = names[0]

    def _magma_gen(self, i):
        return self.gen()

    def _magma_degree(self):
        return self.degree()

    def _magma_discriminant(self):
        return self.discriminant()

    def _magma_coerce(self, x):
        return self(x)

    def __repr__(self):
        kind = "Quadratic Field" if self._quadratic else "Number Field"
        return "%s with defining polynomial %s over the Rational Field" % (kind, _snf._repr_poly(self._f, self._var))

    def _maximal_order(self):
        if self._order is None:
            self._order = _MOrder(self)
        return self._order


class _MOrder:
    _magma_block = True
    _magma_nowrap = True  # Magma prints the description on one line

    def __init__(self, K):
        self.K = K

    def __repr__(self):
        K = self.K
        f = _snf._repr_poly(K._f, K._var)
        if K._nfdata()["index"] == 1:
            return "Maximal Equation Order with defining polynomial %s over its ground order" % f
        return "Maximal Order of Equation Order with defining polynomial %s over its ground order" % f

    def _magma_degree(self):
        return self.K.degree()

    def _magma_discriminant(self):
        return self.K.discriminant()


def _field(x):
    if isinstance(x, _MOrder):
        return x.K
    if isinstance(x, _snf.NumberField_absolute):
        return x
    raise MagmaError("Bad argument types: a number field or its maximal order is expected")


def NumberField(f, Check=True):
    if not isinstance(f, _sp.Polynomial):
        raise MagmaError("NumberField: a polynomial is expected")
    try:
        return _MNumberField(f)
    except (ValueError, NotImplementedError) as e:
        raise MagmaError("NumberField: %s" % e)


def QuadraticField(d):
    d = int(d)
    if _sa.is_square(d):
        raise MagmaError("QuadraticField: the argument must not be a square")
    return _MNumberField([-d, 0, 1], quadratic=True)


def MaximalOrder(K):
    if isinstance(K, _MOrder):
        return K
    return _field(K)._maximal_order()


RingOfIntegers = IntegerRing_ = MaximalOrder


def Signature(K):
    r1, r2 = _field(K).signature()
    return _multi([r1, r2])


def IntegralBasis(K):
    """Magma's integral basis: lower triangular over 1, a, a^2, ... (the
    denominators at the high powers)."""
    F = _field(K)
    d = F._nfdata()
    rows = d["basis"]
    from sagebrush import nf as _nfm
    rev = _nfm.hermite_form([list(reversed(r)) for r in rows])
    rev = [list(reversed(r)) for r in rev]
    rev.reverse()
    return MSeq(F([_Fraction(c, d["den"]) for c in r]) for r in rev)


def ClassNumber(K):
    return _field(K).class_number()


class _ClassGroupMap:
    _magma_nowrap = True

    def __init__(self, G, O, ideals=True):
        self.G, self.O, self.ideals = G, O, ideals

    def __repr__(self):
        target = ("Set of ideals of %r" if self.ideals else "%r") % self.O
        return "Mapping from: %r to %s" % (self.G, target)


def ClassGroup(K, Bound=None, Proof=None):
    F = _field(K)
    # Proof (true or "Full") is forwarded: proven or an error ("GRH",
    # "Subgroup" or none: the GRH result)
    proof = True if Proof is True or (isinstance(Proof, str) and Proof.lower() in ("full", "bound")) else None
    G = _AbGroup(list(F.class_group(proof=proof).invariants()))
    return _multi([G, _ClassGroupMap(G, F._maximal_order())])


def UnitGroup(K):
    F = _field(K)
    G = _AbGroup([F.number_of_roots_of_unity()] + [0] * F.unit_rank())
    return _multi([G, _ClassGroupMap(G, F._maximal_order(), ideals=False)])


def Regulator(K):
    # the regulator as a decimal string; printed to the digits it has, less
    # two kept back for its rounding
    s = str(_field(K)._bnfdata()["regulator"])
    digits = len(_re.sub(r"[^0-9]", "", s).lstrip("0"))
    return MReal.of(_Fraction(s), max(digits - 2, 10))


def UnitRank(K):
    return _field(K).unit_rank()


class _MPrime:
    def __init__(self, P, O):
        self.P, self.O = P, O

    def __repr__(self):
        p, pi = self.P._p, self.P._pi
        return "Prime Ideal of O\nTwo element generators:\n    %s\n    %s" % (
            _vec_str([p] + [0] * (self.P._K.degree() - 1)), _vec_str(pi.list()))

    def _magma_norm(self):
        return self.P.norm()


def _vec_str(v):
    return "[" + ", ".join(repr(x) for x in v) + "]"


def Decomposition(O, p):
    F = _field(O)
    return MSeq(MTuple([_MPrime(P, F._maximal_order()), P.ramification_index()]) for P in F.primes_above(int(p)))


def Norm(x):
    if hasattr(x, "_magma_norm"):
        return x._magma_norm()
    if isinstance(x, _snf.NumberFieldElement):
        return _m_num(x.norm())
    return x * x


def Trace(x):
    if isinstance(x, _snf.NumberFieldElement):
        return _m_num(x.trace())
    if hasattr(x, "trace"):
        return x.trace()
    raise MagmaError("Trace: bad argument")


def MinimalPolynomial(x):
    if isinstance(x, _snf.NumberFieldElement):
        f = x.minpoly()
        R = _sp.PolynomialRing_(_sp.QQ, "$.1")
        return R(f.list())
    raise MagmaError("MinimalPolynomial: bad argument")


class _MMatrix(_smat.Matrix):
    __slots__ = ()
    _magma_block = True

    def _magma_index(self, i):
        _check_index(self.nrows(), i)
        return _MVector(self._rows[i - 1])


class _MVector(list):
    def _magma_index(self, i):
        _check_index(len(self), i)
        return self[i - 1]

    def __repr__(self):
        cells = [repr(x) for x in self]
        w = max(len(c) for c in cells) if cells else 0
        return "(" + " ".join(c.rjust(w) for c in cells) + ")"


def _mmat(M):
    return _MMatrix(M._base, M._rows)


def Matrix(*args):
    R = None
    if args and args[0] in (_ZZ, _QQ):
        R, args = args[0], args[1:]
    base = _sa.ZZ if R is _ZZ else _sa.QQ if R is _QQ else None
    if len(args) == 3:
        m, n, ent = args
        ent = list(ent)
        rows = [ent[i * n:(i + 1) * n] for i in range(m)]
    elif len(args) == 1:
        rows = [list(r) for r in args[0]]
    else:
        raise MagmaError("Matrix: bad arguments")
    M = _smat.matrix(base, rows) if base is not None else _smat.matrix(rows)
    return _mmat(M)


def HermiteForm(M):
    return _multi([_mmat(M.hermite_form())], show=1)


def EchelonForm(M):
    # over Z the Hermite form, over Q the reduced row echelon form
    return _multi([_mmat(M.echelon_form())], show=1)


def SmithForm(M):
    D, U, V = M.smith_form()
    return _multi([_mmat(D), _mmat(U), _mmat(V)])


def ElementaryDivisors(M):
    return MSeq(d for d in M.elementary_divisors() if d)


def LLL(M, Delta=None):
    return _multi([_mmat(M.LLL())], show=1)


def Determinant(M):
    return M.det()


def Transpose(M):
    return _mmat(M.transpose())


def NumberOfRows(M):
    return M.nrows()


def NumberOfColumns(M):
    return M.ncols()


Nrows, Ncols = NumberOfRows, NumberOfColumns


def Rank(x):
    if isinstance(x, _smat.Matrix):
        return x.rank()
    return x.rank()


__all__ = [n for n, v in list(globals().items())
           if not n.startswith("_") and (callable(v) or isinstance(v, type)) and getattr(v, "__module__", None) == __name__]
__all__ += _CATEGORIES
