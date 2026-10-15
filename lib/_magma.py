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


_ARITY = _re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\(\) (takes|missing|got an unexpected keyword argument '([A-Za-z_][A-Za-z0-9_]*)'|got multiple values)")


def _unsupported_call(e):
    """A Python exception that says Sagebrush lacks something, in those
    words, or None.  An intrinsic called with arguments or a parameter
    its Python function doesn't take (Random(1, 4), Newforms(I, S),
    Order(G : Strategy := "Easy")) is a form Sagebrush doesn't have yet,
    not a Python TypeError; so is a NotImplementedError, and the
    curve-table LookupError.  (Python's message names the function: this
    runtime has no traceback to tell a call's boundary.)"""
    if isinstance(e, NotImplementedError):
        return "not supported yet: %s" % e if str(e) else "not supported yet"
    if type(e) is LookupError:
        return "not supported yet: %s" % e
    if isinstance(e, TypeError):
        m = _ARITY.match(str(e))
        if m and not m.group(1).startswith("_") and callable(globals().get(m.group(1))):
            if m.group(3):
                return "%s with the parameter %s is not supported yet" % (m.group(1), m.group(3))
            return "%s with these arguments is not supported yet" % m.group(1)
    return None


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
        line, col = getattr(e, "_mpos", None) or _undeclared(name, line, col)
        if name in ("SetSeed", "GetSeed"):
            _SEEDED.append(True)
        if _is_intrinsic_name(name):
            # one of Magma's intrinsics that Sagebrush doesn't have: said so,
            # not as an undeclared name (Magma has it)
            _sys.stdout.write("%sUser error: '%s' is a Magma intrinsic not implemented in Sagebrush\n" % (_where(line, col), name))
        else:
            _sys.stdout.write("%sUser error: Identifier '%s' has not been declared or assigned\n" % (_where(line, col), name))
        if _src[2] is None:
            raise SystemExit(1)  # no recovery: a cell stops, as before
        return
    if isinstance(e, _UserError):
        _sys.stdout.write("Runtime error: %s\n" % e)
    else:
        um = _re.search(r"local variable '([A-Za-z_][A-Za-z0-9_]*)'", str(e)) if isinstance(e, UnboundLocalError) else None
        if um:
            # a function's local read before it is assigned: Magma's words
            v = um.group(1)
            msg = "Variable '%s' has not been initialized" % (v[:-1] if v.endswith("_") and v[:-1] in _PYKW else v)
        else:
            msg = str(e) if isinstance(e, MagmaError) else _unsupported_call(e) or "%s: %s" % (type(e).__name__, e)
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


class _NoValue:
    """A missing return value (return x, _;): a variable assigned it by a
    multiple assignment becomes unassigned, and printing leaves it out."""

    def __repr__(self):
        return "_"


_NOVAL = _NoValue()


def _present(v):
    """A value assigned to an element or a field: not a missing one."""
    if v is _NOVAL:
        raise MagmaError("assigning a missing return value (_) to an element or field is not supported yet")
    return v


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


class _Undeclared:
    """What a function, func< > or map rule captures for a free name that is
    one of Magma's intrinsics Sagebrush doesn't have (Magma accepts the
    definition).  It never acts as a value: every read of the name in the
    body checks for it and is the error "'X' is a Magma intrinsic not
    implemented in Sagebrush" (src/magma.ts, `x if x is not _mU else
    _m._missing(...)`; map rules: _val); a nested definition's capture
    passes it on.  Its own operations fail too, should it be reached any
    other way (CORR-55A-1)."""

    __slots__ = ()

    def _fail(self, *args, **kw):
        raise MagmaError("a Magma intrinsic not implemented in Sagebrush was used")

    __call__ = __getitem__ = __iter__ = __len__ = __bool__ = __eq__ = __ne__ = __hash__ = _fail
    __repr__ = __str__ = __neg__ = __pos__ = __lt__ = __le__ = __gt__ = __ge__ = _fail
    __add__ = __radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __truediv__ = __rtruediv__ = _fail
    __pow__ = __rpow__ = __mod__ = __rmod__ = __floordiv__ = __rfloordiv__ = _fail

    def __getattr__(self, attr):
        self._fail()


_UNDECLARED = _Undeclared()


def _missing(name, pos=None):
    """A read of a captured name that is an intrinsic Sagebrush doesn't
    have: the error, where it is read (_report says what it is)."""
    e = NameError("name '%s' is not defined" % name)
    e._mpos = pos
    raise e


_INTRINSIC_NAMES = None


def _is_intrinsic_name(name):
    """Whether name is one of Magma's intrinsics (the names its Handbook
    documents; lib/_magma_names.py, loaded the first time it is needed)."""
    global _INTRINSIC_NAMES
    if _INTRINSIC_NAMES is None:
        import _magma_names
        _INTRINSIC_NAMES = frozenset(_magma_names.NAMES.split())
    return name in _INTRINSIC_NAMES


def _capture(read, name, pos=None):
    """A function's, func< >'s or map rule's capture of a free name, when
    it is made: its value (copied).  A name not bound then is
    - one of Magma's intrinsics that Sagebrush doesn't have yet:
      _UNDECLARED, an error where it is read (Magma accepts the
      definition);
    - anything else: Magma rejects the definition (the undeclared-identifier
      error, at the name's first read), so it is not made.
    This is decided when the definition runs, so an assignment that was
    skipped or failed, or a delete in another cell, counts as Magma counts
    it."""
    try:
        v = read()
        # (an enclosing definition's capture of it: passed on)
        if v is _UNDECLARED:
            return v
        v = _own(v)
    except NameError:
        if _is_intrinsic_name(name[:-1] if name.endswith("_") and name[:-1] in _PYKW else name):
            return _UNDECLARED
        e = NameError("name '%s' is not defined" % name)
        e._mpos = pos
        raise e
    # an unresolved forward (declared in another input): called from the
    # body, as a call from a body is in Magma
    return _CellCall(v) if isinstance(v, _Cell) else v


class _CellCall:
    """A function's capture of an unresolved forward cell."""

    __slots__ = ("cell",)

    def __init__(self, cell):
        self.cell = cell

    def __call__(self, *args, **kw):
        return self.cell.get()(*args, **kw)

    def __repr__(self):
        return repr(self.cell)


class _Cell:
    """forward f: the cell a function made before f's definition reads f
    from when it is called.  Each execution of the forward statement makes
    a new one; the next definition of f fills it (later ones don't)."""

    __slots__ = ("name", "value")

    def __init__(self, name):
        self.name, self.value = name, None

    def get(self):
        """The function, from inside a function's body."""
        if self.value is None:
            raise MagmaError("Illegal call of unresolved forward declared user program")
        return self.value

    def set(self, f):
        self.value = f

    def __call__(self, *args, **kw):
        # called through the name (also from a function made in a later
        # input, which captured the cell as the name's value)
        if self.value is None:
            raise MagmaError("Illegal call of unresolved forward declared user program", "procedure call")
        return self.value(*args, **kw)

    def __repr__(self):
        return "Unresolved forward declared user program %s" % self.name


def _define_top(g, name, f):
    """A top-level definition of f fills the unresolved forward the name
    holds, if it holds one (from a forward in this input or an earlier
    one); a local definition never does."""
    c = g.get(name)
    if isinstance(c, _Cell) and c.value is None:
        c.value = f


# ------------------------------------------------------------------ collections

class MSeq(list):
    """A Magma sequence: 1-based, printed [ 1, 2, 3 ]."""

    __slots__ = ("universe", "sample")

    def __init__(self, it=(), universe=None, sample=None):
        list.__init__(self, it)
        self.universe = universe
        # an element that stands for the universe when none is declared, kept
        # when the sequence is emptied (Magma's sequence keeps its universe)
        self.sample = sample if sample is not None or not len(self) else self[0]

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
        if not isinstance(other, MSet):
            return False
        if self.kind == "multi" or other.kind == "multi":
            # a multiset counts its elements
            return self.kind == other.kind and {k: v[1] for k, v in self.keys.items()} == {k: v[1] for k, v in other.keys.items()}
        return set(self.keys) == set(other.keys)

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
    if isinstance(x, _smat.Matrix):
        return ("mat", x.nrows(), x.ncols(), tuple(_m_num(v) for v in x.list()))
    return x


def _sortkey(x):
    # sets of numbers print sorted; others in the order they were built
    if isinstance(x, (int, _Fraction)) and not isinstance(x, bool):
        return (0, x)
    raise TypeError


def _seq(items, universe=None):
    return MSeq(items, universe)


def _set_universe(items):
    """Magma refuses a set of values with no hashing algorithm (records,
    Rationals(), real fields, polynomial rings)."""
    for x in items:
        if isinstance(x, (MRec, _RationalField, RealField_, _sp.PolynomialRing_)):
            raise MagmaError("Invalid set universe (no hashing algorithm)", "{ ... }")
    return items


def _set(items, universe=None):
    return MSet(_set_universe(list(items)), "set", universe)


def _iset(items, universe=None):
    return MSet(_set_universe(list(items)), "indexed", universe)


def _mset(items, universe=None):
    return MSet(_set_universe(list(items)), "multi", universe)


def _still_range(v):
    """Whether a set made by a range still has exactly the range's elements
    (Include, Exclude and the like change its elements, not its range)."""
    lo, hi, step = v.range
    n = (hi - lo) // step + 1
    return len(v.items) == n and all(isinstance(x, int) and not isinstance(x, bool) and lo <= x <= hi and (x - lo) % step == 0 for x in v.items)


def _range(a, b, c, open_, universe=None, pos=None):
    if universe is not None and universe is not _ZZ:
        # (a range's elements are integers: Magma refuses another universe)
        if open_ == "[":
            raise MagmaError("Invalid sequence universe", "[ ... ]", True, pos)
        if open_ == "{":
            raise MagmaError("Invalid set universe (no hashing algorithm)", "{ ... }", True, pos)
        raise MagmaError("a range with a universe in %s ... is not supported yet" % open_)
    if open_ == "[":
        if isinstance(a, int) and isinstance(b, int) and isinstance(c, int):
            return MRange(a, b, c)
        return MSeq(_sa.srange(a, b + c if c > 0 else b - c, c) if False else _frange(a, b, c))
    s = MSet(MRange(a, b, c) if isinstance(a, int) and isinstance(b, int) else _frange(a, b, c), {"{": "set", "{@": "indexed", "{*": "multi"}[open_])
    if open_ == "{" and all(isinstance(v, int) and not isinstance(v, bool) for v in (a, b, c)) and c != 0:
        # printed as Magma prints a range set, { 2 .. 6 by 2 } (lowest to
        # highest), while its elements are still that range (_str checks)
        n = len(range(a, b + (1 if c > 0 else -1), c))
        if n >= 2:
            lo, hi = (a, a + (n - 1) * c) if c > 0 else (a + (n - 1) * c, a)
            s.range = (lo, hi, abs(c))
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
    if v is _UNDECLARED:
        v._fail()
    if name is not None and hasattr(v, "_magma_assigned"):
        v._magma_assigned(name)
    if isinstance(v, MSeq):
        return MSeq((_own(x) for x in v), v.universe, getattr(v, "sample", None))
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
        raise MagmaError("Iteration is not possible over this object", "for")
    if hasattr(s, "__iter__"):
        return iter(s)
    raise MagmaError("cannot iterate over %s" % _str(s))


def _to(a, b, c):
    if c == 0:
        raise MagmaError("the step must be nonzero")
    return iter(range(a, b + 1, c)) if c > 0 else iter(range(a, b - 1, c))


def _check_index(n, i):
    if not isinstance(i, int) or isinstance(i, bool):
        raise MagmaError("Bad argument types\nArgument types given: %s" % _type_of(i))
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
        raise _no_attributes(i, pos)
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
    # (never Python's attributes: x`__class__, 5`real)
    raise _no_attributes(name, pos)


def _no_attributes(name, pos=None):
    return MagmaError("the attribute %s of this object (not a record) is not supported yet" % name, "`", True, pos)


def _assigned(x, name):
    """assigned x`name."""
    if isinstance(x, MRec):
        x._field(name, None)
        return name in x.vals
    raise _no_attributes(name)


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
# Python's builtins (CPython 3.14's), which src/magma.ts's pyName also
# renames (PY_BUILTINS): a Magma name is never Python's ord, len or list
_PYBUILTINS = set((
    "ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup "
    "BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError "
    "ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError "
    "DeprecationWarning EOFError Ellipsis EncodingWarning EnvironmentError Exception "
    "ExceptionGroup False FileExistsError FileNotFoundError FloatingPointError FutureWarning "
    "GeneratorExit IOError ImportError ImportWarning IndentationError IndexError "
    "InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError "
    "ModuleNotFoundError NameError None NotADirectoryError NotImplemented NotImplementedError "
    "OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError "
    "PythonFinalizationError RecursionError ReferenceError ResourceWarning RuntimeError "
    "RuntimeWarning StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError "
    "SystemExit TabError TimeoutError True TypeError UnboundLocalError UnicodeDecodeError "
    "UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning "
    "ValueError Warning ZeroDivisionError abs aiter all anext any ascii bin bool breakpoint "
    "bytearray bytes callable chr classmethod compile complex copyright credits delattr dict "
    "dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr "
    "hash help hex id input int isinstance issubclass iter len license list locals map max "
    "memoryview min next object oct open ord pow print property quit range repr reversed round "
    "set setattr slice sorted staticmethod str sum super tuple type vars zip "
).split())
_PYKW |= _PYBUILTINS


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
            return v if _type_of(v) == c else None
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
    return "%s: %s" % (_type_of(S), n) if n is not None else _inline(S)


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


def _snap(read, name, pos=None):
    """A map rule's snapshot of a free variable when the map is made: its
    value (copied, value semantics; a later delete doesn't reach it); for
    a name not bound then, as _capture."""
    return _capture(read, name, pos)


def _val(v, name, pos=None):
    """A captured variable read in a map rule: an error (as Magma's) only
    if it was not assigned when the map was made."""
    if v is _UNSET:
        raise MagmaError("Variable '%s' has not been initialized" % (name[:-1] if name.endswith("_") and name[:-1] in _PYKW else name))
    if v is _UNDECLARED:
        _missing(name, pos)
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
    raise MagmaError("Bad argument types: expected a boolean, got %s" % _type_of(v))


def _num(x):
    return isinstance(x, (int, _Fraction)) and not isinstance(x, bool)


# Values Python's operators give a meaning Magma's don't ("ab" * 3,
# [1] + [2], true + 1): arithmetic on them is Magma's error, never a value.
_NOARITH = (bool, str, list, tuple, set, frozenset, dict, MSet, MRange)


def _int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _arith(op, args, pos):
    o = op[:-2] if op.endswith(":=") else op
    if len(args) == 2:
        a, b = args
        if isinstance(a, MTuple) and isinstance(b, MTuple) and o == "+":
            raise MagmaError("arithmetic of tuples is not supported yet", "'%s'" % o, True, pos)
        if o == "*" and isinstance(b, MSeq) and not len(b) and not isinstance(a, (bool, str, MSeq, MSet, MTuple, MRange)):
            if _value_base(a) in ("Z", "Q") and not isinstance(a, _snf.NumberFieldElement):
                raise MagmaError("a number times the empty sequence is not supported yet", "'*'", True, pos)
            k = _ak(a)
            if k is not None and (k[0] in ("N", "P", "F") or (k[0] == "M" and k[1] == k[2])):
                raise MagmaError("Argument 1 must be an integer, rational", "'*'", True, pos)
    for a in args:
        if isinstance(a, _NOARITH):
            raise _bad_types(op, args, pos)
    if len(args) == 2:
        _arith_rule(op, args[0], args[1], pos)


def _ak(x):
    """An operand of arithmetic, as Magma's rules see it: ("N", base) for a
    number (base Z, Q or R; a rational element of a number field counts as
    its value), ("P", base) a polynomial over Z or Q, ("F", field) a
    number field element, ("M", rows, columns, base) a matrix, ("S", x) a
    structure, ("map",); None for anything else."""
    if isinstance(x, bool):
        return None
    if isinstance(x, int):
        return ("N", "Z")
    if isinstance(x, _Fraction):
        return ("N", "Q")
    if isinstance(x, MReal):
        return ("N", "R")
    if isinstance(x, _sp.Polynomial):
        b = _base(x.parent().base_ring())
        return ("P", b) if b else None
    if isinstance(x, _snf.NumberFieldElement):
        return ("F", id(x.parent()))
    if isinstance(x, _smat.Matrix):
        return ("M", x.nrows(), x.ncols(), _base(x.base_ring()))
    if _is_struct(x):
        return ("S", x)
    if isinstance(x, MMap):
        return ("map",)
    return None


def _value_base(x):
    """The smallest of Z, Q a number lies in, by value (2/1 and K!1 are
    integers), or R."""
    v = _rational(x) if isinstance(x, _snf.NumberFieldElement) else x
    if isinstance(v, MReal):
        return "R"
    if isinstance(v, (int, _Fraction)):
        return "Z" if _Fraction(v).denominator == 1 else "Q"
    return None


def _arith_rule(op, a, b, pos):
    """Raises Magma's error for a op b (op one of + - * / div mod ^ and
    their op-assignments), if Magma has one; checked against Magma 2.18 pair
    by pair (test/magma-compare.test.ts).  What Magma computes but Sagebrush
    doesn't model is refused ("not supported yet")."""
    o = op[:-2] if op.endswith(":=") else op
    A, B = _ak(a), _ak(b)
    err = lambda code: _incompatible(code, o, a, b, pos)
    unsupported = lambda what: MagmaError("%s is not supported yet" % what, "'%s'" % o, True, pos)
    if A is None or B is None:
        if isinstance(a, (MTuple, MRec)) or isinstance(b, (MTuple, MRec)):
            raise err("B")
        return  # parents these rules don't model (points, ideals, groups): the operation decides
    ka, kb = A[0], B[0]
    if ka == "map" or kb == "map":
        if o == "*" and ka == kb == "map":
            return
        if o == "^" and ka == "map" and kb == "N" and _value_base(b) == "Z":
            raise unsupported("a power of a map")
        raise err("B")
    if ka == "S" or kb == "S":
        if ka == kb == "S":
            ca, cb = _struct_cat(A[1]), _struct_cat(B[1])
            if ca == cb == "RngUPol":
                if _base(A[1].base_ring()) != _base(B[1].base_ring()):
                    if o == "/":
                        raise MagmaError("Incompatible arguments", "'/'", True, pos)
                    raise err("C" if o in ("+", "*") else "B")
                if o in ("+", "*") or (o == "/" and _base(A[1].base_ring()) == "Q"):
                    raise unsupported("arithmetic of polynomial rings")
                if o == "/":
                    raise MagmaError("Illegal coercion", "quo< ... >", True, pos)
            if ca == cb == "ModMat":
                if A[1].nrows() == B[1].nrows() and A[1].ncols() == B[1].ncols() and \
                        _base(A[1].base_ring()) != _base(B[1].base_ring()) and o in ("+", "*", "/"):
                    raise err("C")
                if _struct_eq_quiet(A[1], B[1]):
                    if o == "/" and _base(A[1].base_ring()) == "Z":
                        raise MagmaError("Coefficient ring of argument 1 is not a field", "'/'", True, pos)
                    if o in ("+", "*", "/"):
                        raise unsupported("arithmetic of matrix spaces")
            if ca == cb == "RngInt" and o in ("+", "*", "/"):
                raise unsupported("arithmetic of the ring of integers (ideals)")
        if ka == "S" and kb == "N" and o == "^" and _struct_cat(A[1]) == "RngInt" and _value_base(b) == "Z":
            raise unsupported("powers of the ring of integers (modules)")
        if ka == "N" and kb == "S" and o == "*" and _struct_cat(B[1]) == "RngInt" and _value_base(a) == "Z":
            raise unsupported("ideals of the integers")
        raise err("B")
    if o in ("+", "-"):
        _rule_add(A, B, a, b, err, unsupported)
    elif o == "*":
        _rule_mul(A, B, a, b, err, pos, unsupported)
    elif o == "/":
        _rule_div(A, B, a, b, err, pos, unsupported)
    elif o in ("div", "mod"):
        _rule_quo(o, A, B, a, b, err, pos, unsupported)
    elif o == "^":
        _rule_pow(A, B, a, b, err, pos, unsupported)


def _sq(M):
    return M[1] == M[2]


def _rule_add(A, B, a, b, err, unsupported):
    for X, Y in ((A, B), (B, A)):
        kx, ky = X[0], Y[0]
        if kx == "N" and ky == "P" and X[1] == "Q" and Y[1] == "Z":
            raise err("B")
        if kx == "N" and ky == "F" and X[1] == "R":
            raise err("B")
        if kx == "P" and ky == "F":
            raise err("B")
        if ky == "M" and kx != "M":
            if not _sq(Y):
                raise err("B")
            if kx == "P" and X[1] == "Z" and Y[3] == "Q":
                raise err("C")
    if A[0] == B[0] == "F" and A[1] != B[1]:
        raise err("C")
    if A[0] == B[0] == "M" and (A[1], A[2]) != (B[1], B[2]):
        raise err("C" if _sq(A) and _sq(B) else "B")
    if (A[0] == "M") != (B[0] == "M"):
        raise unsupported("adding a scalar to a matrix")
    _poly_rings(A, B, a, b, unsupported)


def _poly_rings(A, B, a, b, unsupported):
    """Refused: polynomials of two rings (Magma maps generator to
    generator) and polynomials with real numbers (over the reals)."""
    if A[0] == B[0] == "P" and a.parent() is not b.parent() and a.parent() != b.parent():
        raise unsupported("arithmetic of polynomials of two rings")
    if {A[0], B[0]} == {"P", "N"} and "R" in (A[1], B[1]):
        raise unsupported("polynomials over the real numbers")


def _rule_mul(A, B, a, b, err, pos, unsupported):
    for X, Y, x in ((A, B, a), (B, A, b)):
        kx, ky = X[0], Y[0]
        if kx == "N" and ky == "P" and X[1] == "Q" and Y[1] == "Z":
            raise err("B")
        if kx == "N" and ky == "F" and X[1] == "R":
            raise err("B")
        if kx == "P" and ky == "F":
            raise err("B")
        if ky == "M" and kx != "M":
            if kx == "P" and X[1] == "Z" and Y[3] == "Q":
                raise err("C")
            if not _sq(Y):
                # a scalar of the matrix's base ring (by value) only
                vb = _value_base(x)
                if vb is None or (vb == "Q" and Y[3] == "Z") or vb == "R":
                    raise err("C")
    if A[0] == B[0] == "F" and A[1] != B[1]:
        raise err("C")
    if A[0] == B[0] == "M":
        if A[2] == B[1]:
            if A[3] != B[3] and not (_sq(A) and _sq(B)):
                raise MagmaError("Arguments have incompatible coefficient rings", "'*'", True, pos)
            return
        if A[3] != B[3] and not (_sq(A) and _sq(B)):
            raise MagmaError("Arguments have incompatible coefficient rings", "'*'", True, pos)
        raise err("C" if _sq(A) and _sq(B) else "G")
    _poly_rings(A, B, a, b, unsupported)


def _rule_div(A, B, a, b, err, pos, unsupported):
    ka, kb = A[0], B[0]
    if kb == "M":
        raise err("C" if _sq(B) else "B")
    if ka == "M":
        vb = _value_base(b) if kb in ("N", "F") else None
        if vb == "Z" and A[3] == "Z" and _rational(b) not in (1, -1):
            raise MagmaError("Argument 2 is not a unit", "'/'", True, pos)
        if vb in ("Z",) or (vb == "Q" and A[3] == "Q"):
            raise unsupported("dividing a matrix by a scalar")
        raise err("C")
    if ka == "N" and kb == "N":
        return
    if "F" in (ka, kb):
        if ka == kb == "F":
            if A[1] != B[1]:
                raise err("C")
            return
        other = B if ka == "F" else A
        if other[0] == "P":
            if kb == "F" and _value_base(b) in ("Z", "Q"):
                raise unsupported("dividing a polynomial by a number field element")
            raise err("B") if kb == "P" else err("C")
        if other[0] == "N" and other[1] == "R":
            raise err("B")
        return
    # numbers and polynomials
    if "N" in (ka, kb) and "R" in (A[1], B[1]):
        raise MagmaError("Cannot create rational function field over ring with no exact polynomial GCD algorithm",
                         "'/'", True, pos)
    if ka == "N" and kb == "P" and A[1] == "Q" and B[1] == "Z":
        raise err("B")
    _poly_rings(A, B, a, b, unsupported)
    if ka == "P" and kb == "N":
        vb = _value_base(b)
        if B[1] == "Q" and A[1] == "Z" and vb == "Q":
            raise err("C")
        if A[1] == "Z" and _rational(b) not in (1, -1):
            raise MagmaError("Argument 2 is not a unit", "'/'", True, pos)


def _rule_quo(o, A, B, a, b, err, pos, unsupported):
    ka, kb = A[0], B[0]
    if o == "div" and (ka == "M" or kb == "M"):
        if kb == "M" and not _sq(B):
            raise err("B")
        if ka == "M" and A[3] == "Q" and ((kb == "F" and _value_base(b) is not None) or (kb == "N" and _value_base(b) == "Q")):
            raise MagmaError("Division failed: Runtime error in 'div': Bad argument types\n"
                             "Argument types given: FldRatElt, FldRatElt", "'div'", True, pos)
        if ka == "M" and kb in ("N", "F") and _value_base(b) == "Z":
            if A[3] == "Q":
                raise MagmaError("Coefficient ring must be Z", "'div'", True, pos)
            raise unsupported("div of a matrix")
        if ka == "M" and kb == "M":
            raise MagmaError("Scalar not in base ring of matrix", "'div'", True, pos)
        if kb == "M" and ka == "P" and B[3] == "Q" and A[1] == "Z":
            raise err("B")
        raise MagmaError("Scalar not in base ring of matrix", "'div'", True, pos)
    if ka in ("M", "F") or kb in ("M", "F"):
        raise err("B")
    if ka == kb == "N":
        if A[1] != "Z" or B[1] != "Z":
            raise err("B")
        return
    # numbers and polynomials: integers, rationals into Q[x], reals refused
    for X, Y in ((A, B), (B, A)):
        if X[0] == "N" and X[1] == "Q" and Y[0] == "P" and Y[1] == "Z":
            raise err("B")
        if X[0] == "N" and X[1] == "R":
            raise unsupported("%s with a real number and a polynomial" % o)
    _poly_rings(A, B, a, b, unsupported)
    # what is modelled: polynomials of one ring, a polynomial over Q by a number
    if ka == "N":
        raise unsupported("%s of a number by a polynomial" % o)
    if kb == "N" and A[1] == "Z":
        raise unsupported("%s of a polynomial over the integers by a number" % o)


def _rule_pow(A, B, a, b, err, pos, unsupported):
    ka, kb = A[0], B[0]
    if ka == "N":
        if kb != "N":
            raise err("B")
        return
    if kb != "N" or B[1] != "Z":
        if ka == "P" and kb == "M":
            # Magma's errors, by the matrix's shape (checked against Magma)
            if A[1] == "Z" and B[3] == "Q" and min(B[1], B[2]) >= 2:
                raise MagmaError("Bad argument types\nArgument types given: FldRatElt, RngMPolElt", "'*'", True, pos)
            if B[2] == 1 or B[1] == 1:
                raise MagmaError("Index %d (2) should be in the range [1 .. 1]" % (2 if B[2] == 1 else 1), "'[]'", True, pos)
            raise unsupported("a polynomial to the power of a matrix")
        raise err("B")
    if ka == "M" and not _sq(A):
        raise MagmaError("Argument 1 is not square", "'^'", True, pos)



def _add(a, b, pos=None, op="+"):
    if type(a) is int and type(b) is int:
        return a + b
    _arith(op, (a, b), pos)
    try:
        return a + b
    except TypeError:
        raise _bad_types(op, (a, b), pos)


def _sub(a, b, pos=None, op="-"):
    if type(a) is int and type(b) is int:
        return a - b
    _arith(op, (a, b), pos)
    try:
        return a - b
    except TypeError:
        raise _bad_types(op, (a, b), pos)


def _mul(a, b, pos=None, op="*"):
    if type(a) is int and type(b) is int:
        return a * b
    if type(a) is str and type(b) is str:
        return a + b  # Magma's * joins strings
    _arith(op, (a, b), pos)
    try:
        return a * b
    except TypeError:
        raise _bad_types(op, (a, b), pos)


def _uplus(a, pos=None):
    """+a: numbers and the elements of structures (matrices too)."""
    if _eq_kind(a) != "elt":
        raise _bad_types("+", (a,), pos)
    return a


def _neg(a, pos=None):
    if type(a) is int:
        return -a
    _arith("-", (a,), pos)
    try:
        return -a
    except TypeError:
        raise _bad_types("-", (a,), pos)


def _div(a, b, pos=None, op="/"):
    if _int(a) and _int(b):
        return _intdiv(a, b)
    _arith(op, (a, b), pos)
    if isinstance(a, _sp.Polynomial) and _num(b) and b not in (1, -1) and a.parent().base_ring() == _sp.ZZ:
        # over the integers a number divides only if it is a unit
        raise MagmaError("Argument 2 is not a unit", "'%s'" % op, True, pos)
    if isinstance(a, MReal) or isinstance(b, MReal):
        return MReal.of(a) / MReal.of(b)
    return a / b


def _idiv(a, b, pos=None):
    if _int(a) and _int(b):
        if b == 0:
            raise MagmaError("Division by zero", "'div'")
        return a // b
    _arith("div", (a, b), pos)
    if hasattr(a, "quo_rem"):
        return a.quo_rem(b)[0]
    return a // b


def _mod(a, b, pos=None):
    if _int(a) and _int(b):
        if b == 0:
            raise MagmaError("Division by zero", "'mod'")
        return a % b
    _arith("mod", (a, b), pos)
    if hasattr(a, "quo_rem"):
        return a.quo_rem(b)[1]
    return a % b


def _pow(a, b, pos=None, op="^"):
    if _int(a) and _int(b):
        if b < 0:
            return _intdiv(1, a ** -b)
        return a ** b
    if type(a) is str and type(b) is int:
        # Magma's s^n repeats a string
        if b < 0:
            raise MagmaError("Argument 2 (%d) should be >= 0" % b, "'%s'" % op, True, pos)
        return a * b
    _arith(op, (a, b), pos)
    if isinstance(a, MReal) or isinstance(b, MReal):
        return MReal.of(a) ** b
    return a ** b


def _is_struct(x):
    """A structure (a ring or field, a polynomial ring, a matrix space)."""
    return isinstance(x, (_IntegerRing, _RationalField, RealField_, _sp.PolynomialRing_, _snf.NumberField_absolute,
                          _smat.MatrixSpace_))


def _struct_cat(x):
    """A structure's category: structures of one category go in one
    sequence, and compare by their defining data."""
    for cls, cat in ((_IntegerRing, "RngInt"), (_RationalField, "FldRat"), (RealField_, "FldRe"),
                     (_sp.PolynomialRing_, "RngUPol"), (_snf.NumberField_absolute, "FldNum"),
                     (_smat.MatrixSpace_, "ModMat")):
        if isinstance(x, cls):
            return cat
    return None


def _eq_kind(x):
    """What x can be compared with or coerced to: only values of the same
    kind.  "elt": numbers and the elements of structures, whose parents
    decide (_desc, _common); a value of no known kind only meets its own
    type."""
    if isinstance(x, bool):
        return "bool"
    if isinstance(x, (int, _Fraction, MReal)):
        return "elt"
    if isinstance(x, _Cat):
        return "cat"
    if isinstance(x, str):
        return "str"
    if isinstance(x, (MSeq, MRange)):
        return "seq"
    if isinstance(x, MSet):
        return "mset" if x.kind == "multi" else "set"
    if isinstance(x, MTuple):
        return "tup"
    if isinstance(x, MRec):
        return "rec"
    if isinstance(x, MMap):
        return "map"
    if _is_struct(x):
        return "struct"
    if hasattr(x, "parent"):
        return "elt"
    return "other " + type(x).__name__


# ---- parents and Magma's coercions between them (checked against Magma
# 2.18 pair by pair: magma-tests/test_stdin_compare.m)

_BASES = ("Z", "Q", "R")


def _base(b):
    return "Z" if b == _sp.ZZ else "Q" if b == _sp.QQ else None


def _desc(x):
    """The parent of an element, as the coercion rules see it: ("Z",),
    ("Q",), ("R",), ("ZX",)/("QX",) (polynomials over Z or Q), ("NF", id)
    (a number field), ("Mat", rows, columns, base), ("Str",), ("Bool",);
    None for a value that is not an element."""
    if isinstance(x, bool):
        return ("Bool",)
    if isinstance(x, _Cat):
        return None
    if isinstance(x, str):
        return ("Str",)
    if isinstance(x, int):
        return ("Z",)
    if isinstance(x, _Fraction):
        return ("Q",)
    if isinstance(x, MReal):
        return ("R",)
    if isinstance(x, _sp.Polynomial):
        b = _base(x.parent().base_ring())
        return ("ZX",) if b == "Z" else ("QX",) if b == "Q" else ("poly", id(x.parent()))
    if isinstance(x, _snf.NumberFieldElement):
        return ("NF", id(x.parent()))
    if isinstance(x, _smat.Matrix):
        return ("Mat", x.nrows(), x.ncols(), _base(x.base_ring()))
    if _eq_kind(x) == "elt":
        return ("elt", type(x).__name__)
    return None


def _udesc(u):
    """The parent descriptor of the elements of the structure u (a
    universe), or None."""
    if u is _ZZ:
        return ("Z",)
    if u is _QQ:
        return ("Q",)
    if isinstance(u, RealField_):
        return ("R",)
    if isinstance(u, _sp.PolynomialRing_):
        b = _base(u.base_ring())
        return ("ZX",) if b == "Z" else ("QX",) if b == "Q" else None
    if isinstance(u, _snf.NumberField_absolute):
        return ("NF", id(u))
    if isinstance(u, _smat.MatrixSpace_):
        return ("Mat", u.nrows(), u.ncols(), _base(u.base_ring()))
    return None


def _common(d, e):
    """Whether elements with parents d and e meet in a structure Magma's
    coercions reach: None if they do, else Magma's error, "B" (bad argument
    types), "C" (not compatible) or "G" (incompatible degrees)."""
    if d == e:
        return None
    for p, q in ((d, e), (e, d)):
        a, b = p[0], q[0]
        if a in _BASES and b in _BASES:
            return None
        if a in _BASES and b == "ZX":
            return None if a != "Q" else "B"
        if a in _BASES and b == "QX":
            return None
        if a in ("ZX", "QX") and b in ("ZX", "QX"):
            return None
        if a in ("Z", "Q") and b == "NF":
            return None
        if a == "NF" and b == "NF":
            return "C"
        if b == "Mat":
            n, m = q[1], q[2]
            if a == "Mat":
                if (p[1], p[2]) == (n, m):
                    return None
                return "C" if p[1] == p[2] and n == m else "G"
            if n != m:
                return "B"
            if a in _BASES or a in ("QX", "NF"):
                return None
            if a == "ZX":
                return None if q[3] == "Z" else "B"
    return "B"


def _scalar(x):
    """x as a number, if it is one (a constant polynomial, a rational
    element of a number field), else None."""
    if isinstance(x, (int, _Fraction, MReal)) and not isinstance(x, bool):
        return x
    if isinstance(x, _sp.Polynomial):
        c = list(x.list())
        return (_m_num(c[0]) if c else 0) if len(c) <= 1 else None
    if isinstance(x, _snf.NumberFieldElement):
        c = list(x.list())
        return _m_num(c[0]) if all(v == 0 for v in c[1:]) else None
    return None


def _num_eq(a, b):
    if isinstance(a, MReal) or isinstance(b, MReal):
        return MReal.of(a) == MReal.of(b)
    return a == b


def _elt_eq(a, b):
    """Equality of elements whose parents meet (_common)."""
    m = a if isinstance(a, _smat.Matrix) else b if isinstance(b, _smat.Matrix) else None
    if m is not None:
        o = b if m is a else a
        if isinstance(o, _smat.Matrix):
            return m == o
        # a scalar matrix equals its scalar
        s = _scalar(o)
        if s is None:
            return False
        rows = [list(r) for r in m.rows()]
        n = len(rows)
        return all(_num_eq(_m_num(rows[i][j]), s if i == j else 0) for i in range(n) for j in range(n))
    if isinstance(a, _sp.Polynomial) and isinstance(b, _sp.Polynomial):
        # one univariate ring coerces into the other, generator to generator
        return list(a.list()) == list(b.list())
    if isinstance(a, _sp.Polynomial) or isinstance(b, _sp.Polynomial):
        sa, sb = _scalar(a), _scalar(b)
        return sa is not None and sb is not None and _num_eq(sa, sb)
    if isinstance(a, MReal) or isinstance(b, MReal):
        sa, sb = _scalar(a), _scalar(b)
        return sa is not None and sb is not None and _num_eq(sa, sb)
    return a == b


def _incompatible(code, op, a, b, pos):
    if code == "C":
        return MagmaError("Arguments are not compatible\nArgument types given: %s, %s" % (_ext_type(a), _ext_type(b)),
                          "'%s'" % op, True, pos)
    if code == "G":
        return MagmaError("Arguments have incompatible degrees", "'%s'" % op, True, pos)
    return _bad_types(op, (a, b), pos)


def _struct_eq(a, b, op, pos):
    """Equality of structures: by category and defining data, as Magma."""
    ca, cb = _struct_cat(a), _struct_cat(b)
    if a is b:
        return True
    if ca == cb:
        if ca == "FldRe":
            return a.prec == b.prec
        if ca == "RngUPol":
            if _base(a.base_ring()) == _base(b.base_ring()):
                return True
            raise _incompatible("C", op, a, b, pos)
        if ca == "ModMat":
            if (a.nrows(), a.ncols(), _base(a.base_ring())) == (b.nrows(), b.ncols(), _base(b.base_ring())):
                return True
            raise _incompatible("C", op, a, b, pos)
        if ca == "FldNum" and getattr(a, "_quadratic", False) and getattr(b, "_quadratic", False):
            # (QuadraticField(5) eq QuadraticField(45): Magma's quadratic
            # fields are the same field for the same squarefree part)
            return list(a._f) == list(b._f)
        return False  # number fields made apart differ
    if {ca, cb} in ({"RngInt", "FldRat"}, {"FldRat", "FldNum"}):
        return False
    raise _bad_types(op, (a, b), pos)


def _eq(a, b, pos=None, op="eq"):
    if isinstance(a, MRecFormat) or isinstance(b, MRecFormat):
        # Magma has no equality of record formats
        raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (_type_of(a), _type_of(b)), "'%s'" % op, True, pos)
    da, db = _desc(a), _desc(b)
    if da is not None and db is not None:
        code = _common(da, db)
        if code:
            raise _incompatible(code, op, a, b, pos)
        return _elt_eq(a, b)
    ka, kb = _eq_kind(a), _eq_kind(b)
    if ka != kb:
        # 1 eq "1", [1] eq 1, {1} eq {* 1 *}, 1 eq Integers(): Magma's error
        raise _bad_types(op, (a, b), pos)
    if ka == "rec":
        # Magma has no equality of records, not even r eq r
        raise _bad_types(op, (a, b), pos)
    if ka == "struct":
        return _struct_eq(a, b, op, pos)
    if ka == "map":
        if a is b:
            return True
        raise MagmaError("Cannot test equality for those maps", "'%s'" % op, True, pos)
    if ka == "tup":
        # tuples of one length whose entries compare
        if len(a) != len(b) or any(_eq_kind(x) != _eq_kind(y) for x, y in zip(a, b)):
            raise MagmaError("Arguments are not compatible\nArgument types given: Tup, Tup", "'%s'" % op, True, pos)
        return all(_eq(x, y) for x, y in zip(a, b))
    if ka == "seq":
        if len(a) and len(b):
            d, e = _desc(a[0]), _desc(b[0])
            if (d is None) != (e is None) or (d is not None and _common(d, e)) or (d is None and _eq_kind(a[0]) != _eq_kind(b[0])):
                raise MagmaError("Incompatible sequences", "'%s'" % op, True, pos)
        return len(a) == len(b) and all(_cmpeq(x, y) for x, y in zip(a, b))
    return a == b


def _ne(a, b, pos=None):
    return not _eq(a, b, pos, "ne")


def _order(a, b, op, pos):
    """-1, 0 or 1: a against b, where Magma orders them (numbers with
    numbers, strings, booleans, sequences lexicographically, tuples of one
    length, Integers() with itself); Magma's error where it has none.  The
    orders Magma has on polynomials and matrices are not modelled: refused."""
    da, db = _desc(a), _desc(b)
    num = ("Z", "Q", "R")
    if da is not None and db is not None and da[0] in num and db[0] in num:
        fa, fb = (MReal.of(a), MReal.of(b)) if "R" in (da[0], db[0]) else (a, b)
        return (fa > fb) - (fa < fb)
    if da == db == ("Str",) or da == db == ("Bool",):
        return (a > b) - (a < b)
    if da is not None and db is not None:
        if da[0] == db[0] == "Mat" and (da[1], da[2]) != (db[1], db[2]):
            raise MagmaError("Arguments have incompatible degrees", "'%s'" % op, True, pos)
        code = _common(da, db)
        if code:
            raise _incompatible(code, op, a, b, pos)
        if "NF" in (da[0], db[0]) and "Mat" not in (da[0], db[0]):
            raise MagmaError("No comparison algorithm exists for given objects", "'%s'" % op, True, pos)
        if da[0] == db[0] == "Mat" and (da[1], da[2]) != (db[1], db[2]):
            raise MagmaError("Arguments have incompatible degrees", "'%s'" % op, True, pos)
        raise MagmaError("ordering of polynomials and matrices is not supported yet", "'%s'" % op, True, pos)
    ka, kb = _eq_kind(a), _eq_kind(b)
    if op == "ge" and ka == "tup" and type(b) is int:
        raise _UserError("")
    if ka == kb == "seq":
        if len(a) and len(b):
            d, e = _desc(a[0]), _desc(b[0])
            if (d is None) != (e is None) or (d is not None and _common(d, e)):
                raise MagmaError("Incompatible sequences", "'%s'" % op, True, pos)
        for x, y in zip(a, b):
            c = _order(x, y, op, pos)
            if c:
                return c
        return (len(a) > len(b)) - (len(a) < len(b))
    if ka == kb == "tup":
        if len(a) != len(b):
            raise MagmaError("Arguments are not compatible\nArgument types given: Tup, Tup", "'%s'" % op, True, pos)
        for x, y in zip(a, b):
            c = _order(x, y, op, pos)
            if c:
                return c
        return 0
    if ka == kb == "struct" and a is _ZZ and b is _ZZ:
        return 0
    if ka == kb == "struct":
        if _struct_cat(a) == _struct_cat(b):
            if _struct_cat(a) in ("RngUPol", "ModMat") and not _struct_eq_quiet(a, b):
                raise _incompatible("C", op, a, b, pos)
            raise MagmaError("No comparison algorithm exists for given objects", "'%s'" % op, True, pos)
    if ka == kb and ka in ("set", "rec", "map"):
        raise MagmaError("No comparison algorithm exists for given objects", "'%s'" % op, True, pos)
    if ka == kb == "mset":
        raise MagmaError("ordering of multisets is not supported yet", "'%s'" % op, True, pos)
    raise _bad_types(op, (a, b), pos)


def _struct_eq_quiet(a, b):
    try:
        return _struct_eq(a, b, "eq", None)
    except MagmaError:
        return False


def _lt(a, b, pos=None):
    return _order(a, b, "lt", pos) < 0


def _le(a, b, pos=None):
    return _order(a, b, "le", pos) <= 0


def _gt(a, b, pos=None):
    return _order(a, b, "gt", pos) > 0


def _ge(a, b, pos=None):
    return _order(a, b, "ge", pos) >= 0


def _cmpeq(a, b):
    try:
        return _eq(a, b)
    except Exception:
        return False


def _cmpne(a, b):
    return not _cmpeq(a, b)


_NOCOERCE = object()


def _universe(s):
    """What decides the universe of the sequence or set s: ("struct", u)
    for one made with a structure ([ Integers() | ]), ("elt", y) for a
    first element y, None when empty.  One element is looked at, not the
    whole collection."""
    u = getattr(s, "universe", None)
    if u is not None and _is_struct(u):
        return ("struct", u)
    if isinstance(s, MRange):
        return ("elt", s.a) if len(s) else None
    if isinstance(s, MSet):
        return ("elt", s.items[0]) if s.items else None
    if len(s):
        return ("elt", s[0])
    sample = getattr(s, "sample", None)
    return ("elt", sample) if sample is not None else None


def _rational(x):
    """A rational element of a number field as the number it is (Magma
    coerces such an element by value); anything else unchanged."""
    if isinstance(x, _snf.NumberFieldElement):
        v = _scalar(x)
        if v is not None:
            return int(v) if _Fraction(v).denominator == 1 else _Fraction(v)
    return x


def _meets(x, s):
    """Whether x and the elements of the sequence or set s have a common
    universe, as `in` and Index need: None if so, "U" (no valid universe)
    or "N" (records: no equality) if not."""
    w = _universe(s)
    if w is None:
        return None
    dx = _desc(x)
    if w[0] == "struct":
        if dx and dx[0] == "NF" and _udesc(w[1]) != dx:
            dx = _desc(_rational(x))
        dy = _udesc(w[1])
    else:
        y = w[1]
        if isinstance(y, MRec):
            return "N"
        dy = _desc(y)
        if dx and dx[0] == "NF" and dy != dx:
            dx = _desc(_rational(x))
        if dy is None:
            # not elements: structures of one category, sets of any kind,
            # maps; sequences whose elements compare
            if dx is not None:
                return "U"
            kx, ky = _eq_kind(x), _eq_kind(y)
            if kx == "struct" and ky == "struct":
                return None if _struct_cat(x) == _struct_cat(y) else "U"
            if {kx, ky} <= {"set", "mset"} or kx == ky == "map":
                return None
            if kx == ky == "tup":
                return None if len(x) == len(y) else "U"
            if kx == ky == "seq":
                try:
                    _eq(x, y)
                except MagmaError:
                    return "U"
                return None
            return None if kx == ky else "U"
    if dx is None or dy is None:
        return "U"
    if dy == ("Str",) and type(x) is int and x == 1:
        return None  # 1 is the empty string in a universe of strings
    return None if _common(dx, dy) is None else "U"


def _in(x, s, pos=None, op="in"):
    if hasattr(s, "_magma_contains"):
        return s._magma_contains(x)
    if isinstance(s, str):
        return x in s
    if isinstance(s, MTuple):
        raise _bad_types(op, (x, s), pos)
    if isinstance(s, (MSeq, MRange, MSet)):
        code = _meets(x, s)
        if code == "N":
            raise MagmaError("No equality algorithm for sequence elements", "'%s'" % op, True, pos)
        if code:
            raise MagmaError("No valid universe containing all elements", "'%s'" % op, True, pos)
        w = _universe(s)
        if w and w[0] == "elt" and _desc(w[1]) == ("Str",) and type(x) is int and x == 1:
            x = ""
        if isinstance(x, _smat.Matrix) and w and w[0] == "elt" and not isinstance(w[1], _smat.Matrix):
            return False  # Magma: a matrix is never in a collection of scalars
        if isinstance(s, MSet) and _desc(x) in (("Z",), ("Str",), ("Bool",), None):
            return x in s  # a keyed lookup
        return any(_cmpeq(x, y) for y in s)
    return x in s


def _notin(x, s, pos=None):
    return not _in(x, s, pos, "notin")


def _compatible(x, y):
    """Whether values x and y can be elements of one sequence or set (a
    common universe, without the membership coercion of 1 into strings)."""
    dx, dy = _desc(x), _desc(y)
    if dx is not None and dy is not None:
        return _common(dx, dy) is None
    if (dx is None) != (dy is None):
        return False
    kx, ky = _eq_kind(x), _eq_kind(y)
    if kx != ky:
        return False
    if kx == "struct":
        return _struct_cat(x) == _struct_cat(y)
    if kx == "tup":
        return len(x) == len(y) and all(_compatible(u, v) for u, v in zip(x, y))
    if kx == "seq":
        return not (len(x) and len(y)) or _compatible(x[0], y[0])
    return True


def _set_pair(op, a, b, pos, message):
    """The operands of a set operation: two sets (a multiset only with a
    multiset) of compatible universes (Magma's errors: "Bad argument
    types", then `message`)."""
    if not isinstance(a, MSet) or not isinstance(b, MSet) or (a.kind == "multi") != (b.kind == "multi"):
        raise _bad_types(op, (a, b), pos)
    if a.items and b.items and not _compatible(a.items[0], b.items[0]):
        if op == "join" and _eq_kind(a.items[0]) == "set" and _eq_kind(b.items[0]) == "mset":
            raise MagmaError("joining sets of sets with sets of multisets is not supported yet", "'join'", True, pos)
        raise MagmaError(message, "'%s'" % op, True, pos)


def _subset(a, b, pos=None, op="subset"):
    _set_pair(op, a, b, pos, "Arguments 1 and 2 have incompatible universal sets")
    return all(_cmpeq_in(x, b) for x in a)


def _notsubset(a, b, pos=None):
    return not _subset(a, b, pos, "notsubset")


def _cmpeq_in(x, s):
    """x in the set s, both of one universe."""
    return x in s or any(_cmpeq(x, y) for y in s.items)


def _card(s):
    if hasattr(s, "_magma_card"):
        return s._magma_card()
    return len(s)


def _cat(a, b, pos=None):
    if isinstance(a, str) and isinstance(b, str):
        return a + b
    if isinstance(a, (MSeq, MRange)) and isinstance(b, (MSeq, MRange)):
        ua, ub = _universe(a), _universe(b)
        if ua and ub:
            if ua[0] == "elt" and ub[0] == "elt":
                ok = _compatible(ua[1], ub[1])
            elif ua[0] == ub[0] == "struct":
                ok = _udesc(ua[1]) == _udesc(ub[1])
            else:
                e, u = (ua[1], ub[1]) if ua[0] == "elt" else (ub[1], ua[1])
                d, du = _desc(e), _udesc(u)
                ok = d is not None and du is not None and _common(d, du) is None
            if not ok:
                raise MagmaError("Incompatible sequences", "'cat'", True, pos)
        return MSeq(list(a) + list(b), getattr(a, "universe", None) or getattr(b, "universe", None),
                    getattr(a, "sample", None) or getattr(b, "sample", None))
    raise _bad_types("cat", (a, b), pos)


def _join(a, b, pos=None):
    _set_pair("join", a, b, pos, "No valid universe containing all elements")
    k = a.kind if a.kind == b.kind else "set"
    return MSet(list(a) + list(b), k)


def _meet(a, b, pos=None):
    _set_pair("meet", a, b, pos, "No valid universe containing all elements")
    return MSet((x for x in a if _cmpeq_in(x, b)), a.kind if a.kind == b.kind else "set")


def _diff(a, b, pos=None):
    _set_pair("diff", a, b, pos, "No valid universe containing all elements")
    return MSet((x for x in a if not _cmpeq_in(x, b)), a.kind if a.kind == b.kind else "set")


def _sdiff(a, b, pos=None):
    _set_pair("sdiff", a, b, pos, "No valid universe containing all elements")
    return MSet([x for x in a if not _cmpeq_in(x, b)] + [x for x in b if not _cmpeq_in(x, a)],
                a.kind if a.kind == b.kind else "set")


def _reduce(op, s, pos=None):
    items = list(_iter(s))
    if op in ("and", "or") and not all(isinstance(x, bool) for x in items):
        raise _bad_types("&" + op, (s,), pos)
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
        if op in ("+", "*"):
            for y in (r, x):
                if isinstance(y, _NOARITH):
                    raise MagmaError("Operation not defined on elements of type %s" % _type(y), "'&%s'" % op, True, pos)
            r = _add(r, x, pos, "&+") if op == "+" else _mul(r, x, pos, "&*")
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
    if not callable(getattr(R, "gen", None)):
        # (not a Python AttributeError)
        raise MagmaError("generators of this structure (its .i) are not supported yet")
    return R.gen(i - 1)


def _coerce(R, x, pos=None):
    try:
        if hasattr(R, "_magma_coerce"):
            return R._magma_coerce(x)
        if isinstance(R, _sp.PolynomialRing_) and isinstance(x, (MSeq, MRange)):
            # P ! [c0, c1, ...]: each coefficient coerced into the base
            # ring as ! would (Q ! [1, 2] is 1/2)
            K = _ZZ if R.base_ring() is _sp.ZZ else _QQ
            cs = []
            for k, c in enumerate(x):
                try:
                    cs.append(_coerce(K, c, pos))
                except MagmaError:
                    raise MagmaError("Cannot coerce sequence element %d into the coefficient ring" % (k + 1), "'!'", True, pos)
            return R(cs)
        if not callable(R):
            raise MagmaError("coercion (!) into this structure is not supported yet", "'!'")
        return R(x)
    except MagmaError as e:
        # (a coercion's error is at its !, as Magma shows it)
        if e.pos is None and e.where == "'!'":
            e.pos = pos
        raise


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
        raise MagmaError("cannot convert %s to a real" % _type_of(x))

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
        if -4 <= e <= -1:
            # (Magma: 0.0005000000000 in RealField(10), 5.000000000E-5)
            return sign + "0." + "0" * (-e - 1) + d
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
    if isinstance(v, _smat.MatrixSpace_):
        # (a matrix's parent: Magma's matrix algebra or R/KMatrixSpace, not
        # Sage's "Full MatrixSpace of ... dense matrices")
        R = v.base_ring()
        name = "Integer Ring" if R == _sp.ZZ else "Rational Field" if R == _sp.QQ else None
        if name is None:
            raise MagmaError("printing this matrix space is not supported yet")
        if v.nrows() == v.ncols():
            return "Full Matrix Algebra of degree %d over %s" % (v.nrows(), name)
        return "Full %sMatrixSpace of %d by %d matrices over %s" % ("R" if R == _sp.ZZ else "K", v.nrows(), v.ncols(), name)
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
    if isinstance(v, MSet) and v.range is not None and v.kind == "set" and _still_range(v):
        lo, hi, step = v.range
        return "{ %d .. %d }" % (lo, hi) if step == 1 else "{ %d .. %d by %d }" % (lo, hi, step)
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
            out.extend(x for x in (list(v) if v.show is None else list(v)[: v.show]) if x is not _NOVAL)
        else:
            out.append(v)
    return out


def _show_values(v):
    if v is None or isinstance(v, (Ref1, RefK)):
        return
    if isinstance(v, Multi):
        vals = list(v) if v.show is None else list(v)[: v.show]
        _print_line([x for x in vals if x is not _NOVAL])
        return
    _print_line([v])


def _fixed(x, n):
    """x (a real) with n digits after the point, as printf's %.no prints it,
    or None where Sagebrush can't be sure of Magma's digits.  Magma's reals
    are binary: a value at a rounding tie (0.125, 0.25) rounds by its binary
    form, which Sagebrush's decimal reals don't have.  Under 1, past 10^20,
    or when rounding adds a digit (99.999 to 100.00), Magma may print
    1.E2-style; and with no digit after the point its rules differ again.
    Those are refused rather than guessed."""
    if n < 1 or x.m == 0:
        return None
    v = _Fraction(x.m) * _Fraction(10) ** x.e
    a = abs(v)
    if not (1 <= a < 10 ** 20):
        return None
    q, r = divmod(a * 10 ** n, 1)
    # (a tie, within the real's own precision: its binary value decides)
    if abs(r - _Fraction(1, 2)) * 10 ** x.prec <= a * 10 ** (n + 2):
        return None
    q = int(q) + (1 if r > _Fraction(1, 2) else 0)
    digits = str(q).rjust(n + 1, "0")
    whole, frac = digits[:-n], digits[-n:]
    if len(whole) != len(str(int(a))):
        return None
    return ("-" if v < 0 else "") + whole + "." + frac


def _sprintf(fmt, *args, where="printf"):
    """printf's and Sprintf's format: %o (an object, default printing), %O
    (in the printing level the next argument names), %m (Magma's level),
    %h (an integer in hexadecimal), %%; a field width after the %, digits
    (negative: left-justified) or * (the next argument); a precision .n
    for a real (n digits after the point).  As Magma 2.18's Handbook says
    and Magma does, with its words for a bad format."""
    blank = where != "printf"  # (Magma follows Sprintf's errors with an empty line, not printf's)

    def bad(msg):
        return MagmaError(msg, where, blank)

    if not isinstance(fmt, str):
        raise bad("Argument 1 should be a format string")
    out, k, i = [], 0, 0

    def take(what="% conversions"):
        nonlocal k
        if k >= len(args):
            raise bad("Not enough arguments for %s" % what)
        k += 1
        return args[k - 1]

    while i < len(fmt):
        c = fmt[i]
        if c != "%":
            out.append(c)
            i += 1
            continue
        i += 1
        if fmt[i:i + 1] == "%":
            out.append("%")
            i += 1
            continue
        # the field width: -digits, digits or *
        width = 0
        if fmt[i:i + 1] == "*":
            w = take()
            if not isinstance(w, int) or isinstance(w, bool) or abs(w) >= 2 ** 30:
                raise bad("Argument %d for * is not a small integer" % (k + 1))
            width, i = w, i + 1
        else:
            j = i + 1 if fmt[i:i + 1] == "-" else i
            while j < len(fmt) and fmt[j].isdigit():
                j += 1
            if j > i and fmt[i:j] != "-":
                width = int(fmt[i:j])
                i = j
        prec = None
        if fmt[i:i + 1] == "." and fmt[i + 1:i + 2].isdigit():
            j = i + 1
            while j < len(fmt) and fmt[j].isdigit():
                j += 1
            prec, i = int(fmt[i + 1:j]), j
        d = fmt[i:i + 1]
        if d not in ("o", "O", "m", "h"):
            raise bad("Bad percent character '%s' in format string" % d)
        i += 1
        x = take()
        if d == "h":
            # (a field width doesn't apply to %h)
            if not isinstance(x, int) or isinstance(x, bool):
                raise bad("Non-integer argument for %h")
            out.append(("-" if x < 0 else "") + "0x" + format(abs(x), "X"))
            continue
        if d == "O":
            level = take("%O conversion")
            if level not in ("Default", "Minimal", "Maximal", "Magma"):
                raise bad("Bad print level for %O conversion")
            if level != "Default":
                raise MagmaError("printing in the level %s (%%O) is not supported yet" % level, where, blank)
        elif d == "m":
            raise MagmaError("printing in the level Magma (%m) is not supported yet", where, blank)
        if prec is not None and isinstance(x, MReal):
            t = _fixed(x, prec)
            if t is None:
                raise MagmaError("printf's precision (%%.%do) for this real is not supported yet" % prec, where, blank)
        else:
            t = _str(x)
        out.append(t.ljust(-width) if width < 0 else t.rjust(width))
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
        if isinstance(x, (bool, str)):
            raise MagmaError("Illegal coercion\nLHS: FldRat\nRHS: %s" % _type(x), "'!'", False)
        if isinstance(x, int):
            return x
        if isinstance(x, (MSeq, MRange)):
            # Q ! [n, d] is n/d (Magma's words for the rest)
            rhs = "[%s]" % _elt_type(x)
            v = list(x)
            if len(v) != 2:
                raise MagmaError("Sequence must have length 2 to lift into this field\nLHS: FldRat\nRHS: %s" % rhs, "'!'", False)
            if not all(isinstance(c, int) and not isinstance(c, bool) for c in v):
                raise MagmaError("Should be a sequence of integers\nLHS: FldRat\nRHS: %s" % rhs, "'!'", False)
            if v[1] == 0:
                raise MagmaError("Division by zero\nLHS: FldRat\nRHS: %s" % rhs, "'!'", False)
            return _m_num(_sa._q(_Fraction(v[0], v[1])))
        try:
            return _sa._q(_Fraction(x))
        except (TypeError, ValueError):
            raise MagmaError("coercion of a %s into the rationals is not supported yet" % _type_of(x), "'!'", False)

    _magma_coerce = __call__

    def _magma_contains(self, x):
        return isinstance(x, (int, _Fraction)) and not isinstance(x, bool)


_ZZ, _QQ = _IntegerRing(), _RationalField()


def _coerce_int(x):
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    if isinstance(x, _Fraction) and x.denominator == 1:
        return int(x)
    if isinstance(x, (bool, str)):
        # Python would read "7" as 7 and true as 1
        raise MagmaError("Illegal coercion\nLHS: RngInt\nRHS: %s" % _type(x), "'!'", False)
    raise MagmaError("Illegal coercion")


def Integers(K=None):
    """Integers(): the ring of integers; Integers(K): K's maximal order."""
    if K is None:
        return _ZZ
    if isinstance(K, (_MNumberField, _MOrder)):
        return MaximalOrder(K)
    if isinstance(K, int) and not isinstance(K, bool):
        raise MagmaError("Integers(m), the integers modulo m, is not supported yet", "'Integers'")
    raise MagmaError("Integers of a %s is not supported yet" % _type_of(K), "'Integers'")


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
    # (number fields: Magma 2.18's names; a field made by QuadraticField is
    # its own type, with its own order and elements)
    if isinstance(x, _MNumberField):
        return "FldQuad" if x._quadratic else "FldNum"
    if isinstance(x, _MOrder):
        return "RngQuad" if x.K._quadratic else "RngOrd"
    if isinstance(x, _MNFElt):
        return "FldQuadElt" if getattr(x.parent(), "_quadratic", False) else "FldNumElt"
    return None


def _type_of(x):
    """x's type, for messages; Python's name for a type Magma mode doesn't
    name yet."""
    return _Cat(_type_name(x) or _type(x))


def Type(x):
    t = _type_name(x) or _type(x)
    if t == type(x).__name__:
        # (not a Magma type's name, but Python's: never given as a value)
        raise MagmaError("Type of this object is not supported yet", "'Type'")
    return _Cat(t)


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


def _ext_type(x):
    """x's type as Magma's "Argument types given" shows it: a sequence or
    set with the type of its elements (SeqEnum[RngIntElt], SeqEnum[Any]
    when empty), a polynomial with its coefficient ring."""
    if isinstance(x, (MSeq, MRange, MSet)):
        return "%s[%s]" % (_type(x), _elt_type(x))
    if isinstance(x, _sp.Polynomial):
        return "RngUPolElt[%s]" % _ring_cat(x.parent().base_ring())
    if isinstance(x, _smat.Matrix):
        return "%s[%s]" % ("AlgMatElt" if x.is_square() else "ModMatRngElt", _ring_cat(x.base_ring()))
    if isinstance(x, _Cat):
        return "Cat[%s]" % x
    if isinstance(x, _MNumberField):
        return "FldNum[FldRat]"
    if isinstance(x, _sp.PolynomialRing_):
        return "RngUPol[%s]" % _ring_cat(x.base_ring())
    if isinstance(x, MMap):
        return "Map[%s, %s]" % (_ext_type(x.dom), _ext_type(x.cod))
    if isinstance(x, MRec):
        return "Rec"
    return str(_type_of(x))


def _ring_cat(b):
    return "RngInt" if b == _sp.ZZ else "FldRat" if b == _sp.QQ else "Any"


def _elt_type(s):
    u = getattr(s, "universe", None)
    if isinstance(s, MRange) or u is _ZZ:
        return "RngIntElt"
    if u is _QQ:
        return "FldRatElt"
    types = []
    for y in _iter(s):
        t = _ext_type(y)
        if t not in types:
            types.append(t)
    if not types:
        return "Any"
    if len(types) == 1:
        return types[0]
    return "FldRatElt" if set(types) <= {"RngIntElt", "FldRatElt"} else "Any"


def _bad_types(name, args, pos=None):
    """Magma's error for arguments no signature of `name` accepts."""
    if name.endswith(":="):
        # x +:= y: Magma doesn't list the types
        return MagmaError("Bad argument types", "'%s'" % name, True, pos)
    return MagmaError("Bad argument types\nArgument types given: " + ", ".join(_ext_type(a) for a in args),
                      "'%s'" % name, True, pos)


# ------------------------------------------------------------------ polynomials

def PolynomialRing(R, n=1):
    """A new polynomial ring; its variable prints as $.1 until named."""
    # (one variable only: PolynomialRing(Q, 3) is not a univariate ring)
    if n != 1 or isinstance(n, bool):
        raise MagmaError("PolynomialRing in more than one variable (or with weights) is not supported yet", "'PolynomialRing'")
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
def IsPrime(n, *, Proof=None):
    return _sa.is_prime(n, proof=Proof)


def IsProbablePrime(n, *, Bases=None):
    if Bases is not None and Bases <= 0:
        raise MagmaError("Value for 'Bases' must be small and positive", "'IsProbablePrime'")
    # the exact answer: a prime passes for any bases, and Magma's bases are
    # not the first primes (strong pseudoprimes to those, such as 2047
    # with Bases := 1 or 3215031751 with Bases := 4, are composite there)
    return _sa.is_prime(n)


def NextPrime(n, *, Proof=None):
    return _sa.next_prime(n, proof=Proof)


def PreviousPrime(n, *, Proof=None):
    return _sa.previous_prime(n, proof=Proof)


def PrimesUpTo(n):
    return MSeq(_sa.prime_range(n + 1))


def PrimesInInterval(a, b):
    return MSeq(_sa.prime_range(a, b + 1))


def NthPrime(n):
    return _sa.nth_prime(n)


def _int_arg(name, n):
    if not isinstance(n, int) or isinstance(n, bool):
        raise MagmaError("%s of a %s is not supported yet" % (name, _type_of(n)), "'%s'" % name)
    return n


def PrimeDivisors(n):
    return MSeq(p for p, _ in _sa.factor(abs(_int_arg("PrimeDivisors", n))))


def Divisors(n):
    return MSeq(_sa.divisors(abs(_int_arg("Divisors", n))))


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
    if b < 2:
        raise MagmaError("Argument 2 (%d) should be >= 2" % b, "'Intseq'")
    if n < 0:
        raise MagmaError("Argument 1 (%d) should be >= 0" % n, "'Intseq'")
    return MSeq(_sa.digits(n, b))


def Seqint(s, b=10):
    if b < 2:
        raise MagmaError("Argument 2 (%d) should be >= 2" % b, "'Seqint'")
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
    if not 2 <= b <= 36:
        raise MagmaError("Argument 2 (%d) should be in the range [2 .. 36]" % b, "'IntegerToString'")
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
    return _sprintf(fmt, *args, where="'Sprintf'")


# ------------------------------------------------------------------ sequences and sets

# Intrinsic procedures are functions here: Append(S, x) returns the new
# sequence, and the statement Append(~S, x) assigns it back to S.

def Append(s, x):
    x = _lift("Append", s, x, "Cannot coerce element into the universe")
    s = _own(s) if isinstance(s, MSeq) else MSeq(s)
    s.append(x)
    return s


def _into(x, d, ring):
    """x converted into the parent d (of ring, the universe or a sample
    element's parent), as Include and Exclude need: Magma's coercion, by
    value (3/4 doesn't go into the integers, 2/1 does); _NOCOERCE if not."""
    if _desc(x) != d and d != ("Str",):
        x = _rational(x)  # a rational element of a number field goes in by value
    dx = _desc(x)
    if dx is None:
        return _NOCOERCE
    t = d[0]
    num = isinstance(x, (int, _Fraction)) and not isinstance(x, bool)
    if t == "Z":
        return int(x) if num and _Fraction(x).denominator == 1 else _NOCOERCE
    if t == "Q":
        return x if num else _NOCOERCE
    if t == "R":
        return MReal.of(x) if num or isinstance(x, MReal) else _NOCOERCE
    if t in ("ZX", "QX"):
        if num:
            return x if t == "QX" or _Fraction(x).denominator == 1 else _NOCOERCE
        if isinstance(x, _sp.Polynomial) and dx[0] in ("ZX", "QX"):
            c = [_m_num(v) for v in x.list()]
            if t == "ZX" and any(_Fraction(v).denominator != 1 for v in c):
                return _NOCOERCE
            return ring(c) if ring is not None and hasattr(ring, "gen") else x
        return _NOCOERCE
    if t == "NF":
        if num:
            return x
        return x if dx == d else _NOCOERCE
    if t == "Mat":
        n, m, base = d[1], d[2], d[3]
        if dx[0] == "Mat":
            if (dx[1], dx[2]) != (n, m):
                return _NOCOERCE
            if dx[3] == base or dx[3] == "Z":
                return x
            # rational entries go into the integers when they are integers
            rows = [[_m_num(v) for v in r] for r in x.rows()]
            if all(_Fraction(v).denominator == 1 for r in rows for v in r):
                return x.change_ring(_sp.ZZ)
            return _NOCOERCE
        if num and n == m and (base == "Q" or _Fraction(x).denominator == 1):
            return _smat.identity_matrix(_sp.QQ if base == "Q" else _sp.ZZ, n) * x
        return _NOCOERCE
    if t == "Str":
        if isinstance(x, str):
            return x
        return "" if type(x) is int and x == 1 else _NOCOERCE
    return x if dx == d else _NOCOERCE


def _lift(name, s, x, cannot="Cannot lift element into sequence"):
    """x converted into the universe of s, for Include, Exclude, Append and
    Insert (the declared universe, else that of an element); Magma's
    errors if not."""
    w = _universe(s)
    if w is None:
        return x
    if w[0] == "struct":
        y = _into(x, _udesc(w[1]) or ("?",), w[1])
    else:
        e = w[1]
        if isinstance(e, MRec):
            if name in ("Append", "Insert"):
                if isinstance(x, MRec):
                    return x
                raise MagmaError(cannot, "'%s'" % name)
            raise MagmaError("No equality algorithm for sequence elements", "'%s'" % name)
        if isinstance(s, MSeq) and not len(s) and isinstance(e, MSeq) and not len(e):
            # the universe of a sequence emptied of [] takes anything
            if isinstance(x, MRec) and name in ("Include", "Exclude"):
                raise MagmaError("No equality algorithm for sequence elements", "'%s'" % name)
            return x
        de = _desc(e)
        if de is not None:
            y = _into(x, de, e.parent() if hasattr(e, "parent") and isinstance(e, _sp.Polynomial) else None)
        else:
            kx, ke = _eq_kind(x), _eq_kind(e)
            ok = ((kx == ke == "struct" and _struct_cat(x) == _struct_cat(e))
                  or (kx in ("set", "mset") and ke in ("set", "mset") and not (kx == "mset" and ke == "set"))
                  or (kx == ke == "map")
                  or (kx == ke == "tup" and len(x) == len(e)))
            if ke == "seq" and not len(e) and name == "Index" and not (kx == "seq" and not len(x)):
                raise MagmaError(cannot, "'%s'" % name)
            if ke == "seq" and kx != "seq" and not len(e):
                raise MagmaError("Sequence mutation failed", "'%s'" % name)
            if kx in ("set", "mset") and ke in ("set", "mset") and ok:
                y = MSet(list(x), e.kind)  # into the kind of set the elements are
            elif kx == ke == "seq":
                # a sequence goes in if its elements go into the element's universe
                try:
                    y = MSeq([_lift(name, e, v) for v in x]) if len(e) else x
                    ok = True
                except MagmaError:
                    ok = False
            elif not (kx in ("set", "mset") and ke in ("set", "mset")):
                y = x
            if not ok:
                y = _NOCOERCE
    if y is _NOCOERCE:
        if isinstance(s, MSet):
            raise MagmaError("Illegal coercion", "'%s'" % name, False)
        raise MagmaError(cannot, "'%s'" % name)
    return y


def Include(s, x):
    x = _lift("Include", s, x)
    if isinstance(s, MSet):
        t = _own(s)
        t.add(x)
        return t
    s = _own(MSeq(s))
    if not any(_cmpeq(x, y) for y in s):
        s.append(x)
    return s


def Exclude(s, x):
    x = _lift("Exclude", s, x)
    if isinstance(s, MSet):
        t = _own(s)
        t.remove(x)
        return t
    s = _own(MSeq(s))
    for k, y in enumerate(s):
        if _cmpeq(x, y):
            del s[k]
            break
    return s


def Remove(s, i):
    s = _own(s) if isinstance(s, MSeq) else MSeq(s)
    _check_index(len(s), i)
    del s[i - 1]
    return s


def Insert(s, i, x):
    x = _lift("Insert", s, x, "Cannot coerce element into the universe")
    s = _own(s) if isinstance(s, MSeq) else MSeq(s)
    s.insert(i - 1, x)
    return s


def Reverse(s):
    if isinstance(s, str):
        return s[::-1]
    return MSeq(reversed(list(s)), getattr(s, "universe", None), getattr(s, "sample", None))


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


def _index_of(name, s, x):
    if isinstance(s, str):
        # in a string: where the substring x first starts (0: nowhere)
        if not isinstance(x, str):
            raise _bad_types(name, (s, x))
        return s.find(x) + 1
    x = _lift(name, s, x, "Cannot coerce element into the universe")
    for k, y in enumerate(_iter(s)):
        if _cmpeq(x, y):
            return k + 1
    return 0


def Index(s, x):
    return _index_of("Index", s, x)


def Position(s, x):
    return _index_of("Position", s, x)


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
    if not items:
        if isinstance(s, (MSeq, MRange)):
            raise MagmaError("Illegal null sequence", "'Universe'")
        raise MagmaError("Universe of an empty set is not supported yet", "'Universe'")
    if all(isinstance(x, int) and not isinstance(x, bool) for x in items):
        return _ZZ
    if all(isinstance(x, (int, _Fraction)) and not isinstance(x, bool) for x in items):
        return _QQ
    # (never None, which printed nothing: a set of sets is Magma's "Set of
    # subsets of Integer Ring", which Sagebrush doesn't model)
    raise MagmaError("Universe of this %s is not supported yet" % _type_of(s), "'Universe'")


# Magma's random generator can't be reproduced: a program that uses SetSeed
# or GetSeed (intrinsics Sagebrush doesn't have; _report notes them) expects
# Magma's numbers, so from then on Random refuses rather than give others
_SEEDED = []


def Random(s, b=None):
    import random
    if _SEEDED:
        raise MagmaError("Random after SetSeed or GetSeed is not supported yet: Sagebrush can't reproduce Magma's random numbers", "'Random'")
    if b is None:
        return random.choice(list(_iter(s)))
    # Random(a, b): an integer in [a, b]
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (s, b)):
        raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (_type_of(s), _type_of(b)), "'Random'")
    if s > b:
        raise MagmaError("Random(a, b) with a > b is not supported yet", "'Random'")
    return random.randint(s, b)


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
    if isinstance(N, MGamma0):
        return N.N
    if not isinstance(N, int) or isinstance(N, bool):
        raise MagmaError("a space of modular forms or symbols from a %s is not supported yet" % _type_of(N))
    return N


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
    return MModSym(_level(N), _int_arg("ModularSymbols", k), _int_arg("ModularSymbols", sign))


def Dimension(M):
    if hasattr(M, "_magma_dimension"):
        return M._magma_dimension()
    raise MagmaError("Dimension: bad argument")


def CuspidalSubspace(M):
    if not isinstance(M, MModSym):
        raise MagmaError("CuspidalSubspace of a %s is not supported yet" % _type_of(M), "'CuspidalSubspace'")
    if M.kind not in ("full", "cuspidal"):
        return M
    return MModSym(M.N, M.k, M.sign, "cuspidal")


def NewSubspace(M):
    if not isinstance(M, MModSym):
        raise MagmaError("NewSubspace of a %s is not supported yet" % _type_of(M), "'NewSubspace'")
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


def _msym(name, M):
    """M, a space of modular symbols: what these functions handle so far."""
    if not isinstance(M, MModSym):
        raise MagmaError("%s of a %s (not a space of modular symbols) is not supported yet" % (name, _type_of(M)), "'%s'" % name)
    return M


def HeckePolynomial(M, p):
    _msym("HeckePolynomial", M)
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
    return _HeckeOp(_msym("HeckeOperator", M), p)


def CharacteristicPolynomial(T):
    if isinstance(T, _HeckeOp):
        return HeckePolynomial(T.M, T.p)
    raise MagmaError("CharacteristicPolynomial: matrices are not supported yet")


def NewformDecomposition(M):
    _msym("NewformDecomposition", M)
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
    return MModForms(_level(N), _int_arg("CuspForms", k))


def ModularForms(N, k=2):
    return MModForms(_level(N), _int_arg("ModularForms", k), cusp=False)


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
    if b is not None and (isinstance(a, str) or _num(a) and _num(b)):
        # a label is one argument, and a curve's coefficients come in a sequence
        raise _bad_types("EllipticCurve", (a, b))
    if isinstance(a, (MSeq, MRange)):
        bad = next((c for c in a if not (isinstance(c, (int, _Fraction)) and not isinstance(c, bool))), None)
        if bad is not None:
            # (over the rationals only, so far)
            raise MagmaError("EllipticCurve with a coefficient in a %s is not supported yet" % _type_of(bad), "'EllipticCurve'")
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
        # (Magma lists the invariants from the smallest, Z/2 + Z/2 + Z/10,
        # where Sage's class group lists them from the largest; every group
        # made here is in that form, each dividing the next)
        self.invs = sorted(d for d in invs if d > 1) + [0 for d in invs if d == 0]
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
        # Magma's Discriminant(K) is its defining polynomial's (its equation
        # order's), not the maximal order's: 729 for x^3 - 9*x - 9, whose
        # maximal order's is 81; but a field made by QuadraticField (FldQuad)
        # gives the field's, 5 for QuadraticField(5) (checked against Magma
        # 2.18)
        if self._quadratic:
            # Q(sqrt(s)), s squarefree: s or 4s, without the general route
            # (which could factor s again)
            s = -int(self._f[0])
            return s if s % 4 == 1 else 4 * s
        return _m_num(self.polynomial().discriminant())

    def _magma_coerce(self, x):
        try:
            return self(x)
        except TypeError as e:
            if isinstance(x, _MNFElt) and x.parent() is not self:
                # (an element of another number field: Magma's words)
                raise MagmaError("Arguments are not compatible\nLHS: %s\nRHS: %s" % (_type_of(self), _type_of(x)), "'!'", False)
            raise MagmaError("coercion of a %s into this number field is not supported yet" % _type_of(x), "'!'", False)

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
        # (a quadratic field's maximal order: its field's, s or 4s)
        return self.K._magma_discriminant() if self.K._quadratic else self.K.discriminant()


def _field(x):
    if isinstance(x, _MOrder):
        return x.K
    if isinstance(x, _snf.NumberField_absolute):
        return x
    raise MagmaError("Bad argument types: a number field or its maximal order is expected")


def NumberField(f, *, Check=True):
    if not isinstance(f, _sp.Polynomial):
        raise MagmaError("NumberField: a polynomial is expected")
    try:
        return _MNumberField(f)
    except (ValueError, NotImplementedError) as e:
        raise MagmaError("NumberField: %s" % e)


# (the squarefree part's work: trial division by the primes up to this,
# then what is left must be decided without factoring it, HARD-731-1)
_SQUAREFREE_TRIAL = 10 ** 5


def _squarefree_part(d):
    """The squarefree part of the integer d, with its sign (0 for 0), by
    bounded work: trial division by the primes up to _SQUAREFREE_TRIAL,
    then the cofactor m, all of whose primes are larger, is decided when it
    is 1, a square, a prime, or below the bound cubed (then a product of two
    different primes); else refused rather than factored without a bound
    (a 78-digit semiprime would take ECM minutes; Magma 2.18 also tries to
    factor it)."""
    if d == 0:
        return 0
    s, m = (-1 if d < 0 else 1), abs(d)
    for p in _sa.prime_range(2, _SQUAREFREE_TRIAL + 1):
        if p * p > m:
            break
        e = 0
        while m % p == 0:
            m //= p
            e += 1
        if e % 2:
            s *= p
    if m == 1:
        return s
    r = _math.isqrt(m)
    if r * r == m:
        return s
    if m < _SQUAREFREE_TRIAL ** 3 or _sa.is_prime(m):
        # (no prime below the bound left: m is a prime, or below the bound
        # cubed, two different primes, as it isn't a square)
        return s * m
    raise MagmaError("QuadraticField: the squarefree part of %d was not found within the limit (its prime factors above %d are not known); this is not supported yet" % (d, _SQUAREFREE_TRIAL), "'QuadraticField'")


def QuadraticField(d):
    # (an integer only: int() would take 25/7 as 3)
    if isinstance(d, bool) or not isinstance(d, int):
        raise MagmaError("Bad argument types\nArgument types given: %s" % _type_of(d), "'QuadraticField'")
    # Magma's field is Q(sqrt(s)), s the squarefree part of d: x^2 - 3 for 12
    s = _squarefree_part(d)
    if s in (0, 1):
        raise MagmaError("QuadraticField of a square (Magma's rational field) is not supported yet")
    return _MNumberField([-s, 0, 1], quadratic=True)


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


def ClassGroup(K, *, Bound=None, Proof=None):
    if isinstance(Proof, str) and Proof.lower() not in ("full", "grh", "bound", "subgroup", "current"):
        raise MagmaError("Bad value for parameter 'Proof' (%s)\nArgument types given: %s" % (Proof, _ext_type(K)), "'ClassGroup'")
    if Bound is not None:
        # Magma's bound for the generators isn't modelled
        raise MagmaError("ClassGroup with the parameter Bound is not supported yet")
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


def LLL(M, *, Delta=None):
    if Delta is not None:
        # the reduced basis depends on Delta, which isn't passed on
        raise MagmaError("LLL with the parameter Delta is not supported yet")
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


# ------------------------------------------------------------------ argument guard

# Python and Sage read the string "7" as 7 and true as 1, where Magma's
# intrinsics have no signature for them: every intrinsic refuses a string
# or a boolean argument with Magma's error, except in the positions listed
# here (None: any position).  Checked against Magma.
_STR_ARGS = {"Sprint": None, "Sprintf": None, "Type": None, "Parent": None, "Index": None, "Position": None,
             "Append": {1}, "Include": {1}, "Exclude": {1}, "Insert": {2},
             "Reverse": {0}, "StringToInteger": {0}, "EllipticCurve": {0}}
_BOOL_ARGS = {"Sprint": None, "Sprintf": None, "Type": None, "Parent": None,
              "Append": {1}, "Include": {1}, "Exclude": {1}, "Insert": {2}, "Index": {1}, "Position": {1}}


# Magma's named parameters (intrinsic(x : Param := v)): the type each
# takes, and what else is checked; as Magma 2.18 reports them.
def _param_bool(v):
    return isinstance(v, bool)


def _param_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _param_real(v):
    return _num(v) or isinstance(v, MReal)


_PARAMS = {
    "IsPrime": {"Proof": _param_bool}, "NextPrime": {"Proof": _param_bool}, "PreviousPrime": {"Proof": _param_bool},
    "IsProbablePrime": {"Bases": _param_int}, "NumberField": {"Check": _param_bool},
    "ClassGroup": {"Proof": lambda v: isinstance(v, str), "Bound": _param_int}, "LLL": {"Delta": _param_real},
}


def _check_params(name, f, args, kw):
    known = f.__code__.co_varnames[f.__code__.co_argcount:f.__code__.co_argcount + f.__code__.co_kwonlyargcount]
    types = ", ".join(_ext_type(a) for a in args)
    for p, v in kw.items():
        if p not in known:
            raise MagmaError("Parameter '%s' is not defined for this function\nArgument types given: %s" % (p, types),
                             "'%s'" % name)
        check = _PARAMS.get(name, {}).get(p)
        if check is None or not check(v):
            raise MagmaError("Bad type for parameter '%s'\nArgument types given: %s" % (p, types), "'%s'" % name)


def _guarded(name, f):
    strs, bools = _STR_ARGS.get(name, ()), _BOOL_ARGS.get(name, ())

    def intrinsic(*args, **kw):
        for i, a in enumerate(args):
            if isinstance(a, bool):
                if bools is not None and i not in bools:
                    raise _bad_types(name, args)
            elif isinstance(a, str) and strs is not None and i not in strs:
                raise _bad_types(name, args)
        if kw:
            _check_params(name, f, args, kw)
        return f(*args, **kw)

    intrinsic.__name__ = f.__name__
    intrinsic.__doc__ = f.__doc__
    intrinsic.__wrapped__ = f  # for help: the signature and source are f's
    return intrinsic


for _n, _f in list(globals().items()):
    if _n[:1].isupper() and not _n.endswith("_") and type(_f) is type(_guarded) \
            and getattr(_f, "__module__", None) == __name__:
        globals()[_n] = _guarded(_n, _f)


__all__ = [n for n, v in list(globals().items())
           if not n.startswith("_") and (callable(v) or isinstance(v, type)) and getattr(v, "__module__", None) == __name__]
__all__ += _CATEGORIES
