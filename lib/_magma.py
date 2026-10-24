"""Magma's values, printing and intrinsics, for programs translated by
src/magma.ts.  Arithmetic and number theory reuse sage_all and the
Sagebrush engines; what differs is Magma's semantics (1-based sequences
with value semantics, sets, tuples, multiple return values, reference
arguments) and its printing, checked against Magma by magma-tests/.
"""

import collections as _collections
import itertools as _itertools
import math as _math
import re as _re
import sys as _sys
from fractions import Fraction as _Fraction

import sage_all as _sa
from sage_all import Rational as _Rational, _intdiv
import _sage_poly as _sp
import _sage_ff as _sff
import _sage_ffsub as _ffsub
import _sage_frac as _sfrac

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


_ABSENT = []  # [name -> alternative], from the catalog, once


def _absent_alternative(name):
    """The alternative the Magma catalog gives for an intrinsic Sagebrush
    doesn't have (an entry of status absent), or None.  (Read once; no
    catalog, no alternatives: the message is as before.)"""
    if not _ABSENT:
        table = {}
        try:
            import _catalog
            for _, e in _catalog.load("magma"):
                if e.get("status") == "absent" and e.get("alternative") and e["name"] not in table:
                    table[e["name"]] = e["alternative"]
        except Exception:
            table = {}
        _ABSENT.append(table)
    return _ABSENT[0].get(name)


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
            # (Sagebrush's own message, which Magma doesn't print: one line,
            # with the catalog's alternative where it has one, as agents
            # read refusals)
            alt = _absent_alternative(name)
            _sys.stdout.write("%sUser error: '%s' is a Magma intrinsic not implemented in Sagebrush%s\n"
                              % (_where(line, col), name, "; instead: " + alt if alt else ""))
        else:
            # (wrapped at 80 columns, as Magma wraps it)
            _sys.stdout.write("%s%s\n" % (_where(line, col), _wrap("User error: Identifier '%s' has not been declared or assigned" % name, 0, 0)))
        if _src[2] is None:
            raise SystemExit(1)  # no recovery: a cell stops, as before
        return
    if isinstance(e, _UserError):
        _sys.stdout.write("%s\n" % _wrap("Runtime error: %s" % e, 0, 0))
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


def _syntax_error(line, col, detail, unsupported=False):
    """A syntax error at (line, col) (line 0: at the end of the input), in
    Magma's words on stdout; the parser's reason goes to stderr.  A
    construct of Magma's that Sagebrush doesn't have yet (unsupported) is
    said so on stdout, not called bad syntax."""
    if line and unsupported:
        _sys.stdout.write("%sUser error: %s\n" % (_where(line, col), detail))
    elif line:
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


def _values(v, n, pos=None):
    """a, b := e: e's first n values (Magma's words, at the :=, when it has fewer)."""
    m = len(v) if isinstance(v, Multi) else 1
    if m < n:
        raise MagmaError("Expected to assign %d value(s) but only computed %d value(s)" % (n, m), ":=", False, pos)
    if isinstance(v, Multi):
        for x in v[:n]:
            if isinstance(x, _IsoNotModelled):
                x._refuse()  # (a value Sagebrush doesn't model: refused at the :=)
        return list(v[:n])
    return [v]


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

    __slots__ = ("universe", "sample", "_inf", "_wit", "_null")

    def __init__(self, it=(), universe=None, sample=None):
        list.__init__(self, it)
        self.universe = universe
        # (_inf, the universe Magma infers for it, and _wit, its first
        # defined element, are set only once known: unset, they cost a
        # sequence nothing, as a large copy needs, HARD-756-1)
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
        return self.size()

    def size(self):
        # (len() of a range of more than 2^63 elements overflows: this doesn't)
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

    __slots__ = ("items", "keys", "kind", "universe", "range", "_inf", "_null", "_wit")

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
            self._check_order()  # (a multiset hands out its items in order too, astra CORR-7E2-2)
            for x in self.items:
                for _ in range(self.keys[_key(x)][1]):
                    yield x
            return
        yield from self.ordered()

    def ordered(self):
        if self.kind == "indexed":
            return list(self.items)
        self._check_order()
        try:
            return sorted(self.items, key=_sortkey)
        except TypeError:
            return list(self.items)

    def _check_order(self):
        """Refused where Magma's order of the elements is its own and not
        modelled: two or more groups, or vectors (their printing and
        enumeration both come here)."""
        if len(self.keys) > 1 and any(isinstance(x, (_MSymGroup, _MDihedralGroup)) for x in self.items):
            # (Magma's order of the groups in a set is its own: not modelled)
            raise MagmaError("the order of a set of permutation groups is not supported yet")
        if len(self.keys) > 1 and any(isinstance(x, _MVector) for x in self.items):
            # (nor of vectors: {(1 0), (0 1)} prints (0 1) first)
            raise MagmaError("the order of a set of vectors is not supported yet")

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

    def __call__(self, *args):
        # (1, 2)(3, 4): a product of cycles, for G!(1, 2)(3, 4) (the
        # translator reads (1, 2) as a tuple and the next one as a call)
        return _MCycles([self, MTuple(args)])


class _MCycles(list):
    """A product of cycles written (a, b)(c, d): only a permutation group's
    coercion takes one."""

    def __call__(self, *args):
        return _MCycles(list(self) + [MTuple(args)])

    def __repr__(self):
        raise MagmaError("a product of cycles outside G!( ... ) is not supported yet")


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
    if isinstance(x, (_MFFPoly, _MFFPolyRing)):
        # (Magma lists a set of them in an order of its own, not modelled)
        raise MagmaError("a set of polynomials over a finite field (or of their rings) is not supported yet")
    if isinstance(x, _FFLINALL):
        raise MagmaError("a set of matrices or vectors over a finite field is not supported yet")
    return x


def _sortkey(x):
    # sets of numbers print sorted; others in the order they were built
    if isinstance(x, (int, _Fraction)) and not isinstance(x, bool):
        return (0, x)
    raise TypeError


def _ff_universe(items, where):
    """Finite fields' elements in one collection (CORR-581-4), at any depth:
    each slot's elements (a tuple coordinate's, or the collection's own) go
    into the smallest field containing them, before the items are keyed,
    as Magma does ([a, c] = [ d^21, d^9 ] for a in GF(4), c in GF(8) and
    GF(64)<d>; {P!1, F!1} is over GF(4); #{{a}, {b^5}} = 1): _ff_norm,
    under one budget.  Another characteristic in one slot has no common
    universe, as Magma says."""
    r = _ff_norm(items, "a collection", where, None, "No valid universe containing all elements")
    return items if r is None else r


def _ff_into(U, x, budget=None):
    """x coerced into the finite field U (a declared universe), or None
    where Magma's coercion fails: an integer, a rational with a denominator
    prime to p, an element of U, of a subfield of U, or of a field over U
    lying in U (checked against Magma: [F | E!1] fails for fields neither
    in the other)."""
    if isinstance(x, bool):
        return None
    if isinstance(x, int):
        return U.K(x)
    if isinstance(x, _Fraction):
        if x.denominator % U.p == 0:
            return None
        return U.K(x.numerator) / U.K(x.denominator)
    if _is_ff(x):
        if x.parent() is U.K:
            return x
        Kx = _ffwrap(x.parent())
        if Kx.p != U.p:
            return None
        if Kx.n == 1:
            return U.K(int(x))
        # (as U!x: up from a subfield, down by value, else none, even an
        # element of the prime field from a field neither in the other)
        refuse = _ff_refuse("coercion", Kx, U, "'!'")
        if budget is None:
            budget = [_ffsub.WORK]
        if U.n % Kx.n == 0:
            return _ff_up(x, U, budget, refuse)
        if U.n == 1:
            v = _ffsub.prime_value(x)
            return None if v is None else U.K(v)
        if Kx.n % U.n == 0:
            return _ff_down(x, U, budget, refuse)
        return None
    if isinstance(x, (MSeq, MSet, MTuple, MRange, list, tuple)):
        raise MagmaError("a collection in a collection over a finite field is not supported yet")
    return None


def _ff_into_cost(U, x, seen, where, hits=None):
    """The cops _ff_into(U, x) takes (_ffsub.into_cost), for the aggregate
    admission of a collection before its first element goes in; refused
    here for fields past F1's bounds, as _ff_into would be."""
    if not _is_ff(x) or x.parent() is U.K:
        return 0
    return _ffsub.into_cost(U.K, x, seen, hits, _ff_refuse("coercion", _ffwrap(x.parent()), U, where))


def _ff_into_cost_n(U, W, k, seen, hits, where):
    """An upper bound on the cops of _ff_into(U, x) for k elements x of the
    field W (_ffsub.into_cost_n), for admission from counts alone."""
    return _ffsub.into_cost_n(U.K, W.K, k, seen, hits, _ff_refuse("coercion", W, U, where))


# where Magma reports a failed coercion into a declared universe, by kind
_UNIVERSE_FAIL = {"seq": "[ ... ]", "set": "{ ... }", "indexed": "{@ ... @}", "multi": "sub< ... >"}


def _into_universe(items, universe, kind):
    """A collection's items with a declared universe: coerced into a finite
    field; a finite field's elements into the integers (those of the prime
    field) or the rationals (none), as Magma does (CORR-A6D-1).  Other
    universes keep their items as before."""
    if isinstance(universe, _MResRing) or (universe is None and any(isinstance(x, _MResElt) for x in items)):
        return _res_items(items, universe, kind)
    if isinstance(universe, (_MFFMatSpace, _MFFVecSpace)):
        raise MagmaError("a collection over a matrix or vector space over a finite field is not supported yet", _UNIVERSE_FAIL[kind])
    if isinstance(universe, _snf.NumberField_absolute) and any(_num(x) or isinstance(x, _MNFElt) for x in items):
        # (each item coerced as Magma's: [K | w] of another field's w is
        # its error, or w in K where its field is in K; astra2 CORR-E65-1)
        return _nf_items(items, universe, kind)
    if isinstance(universe, (_MFFPolyRing, _MVectorSpace)):
        # (a polynomial ring over a finite field, or a full vector space:
        # each item coerced, as R!x; Sagebrush's refusals stay refusals)
        if isinstance(universe, _MVectorSpace):
            _vspace_admit(universe, len(items), _UNIVERSE_FAIL[kind])
        out = []
        for k, x in enumerate(items):
            try:
                out.append(x if x is _UNDEF else universe._magma_coerce(x))
            except MagmaError as e:
                if "not supported yet" in str(e):
                    raise
                raise MagmaError("Coerce failed for sequence element" if kind == "seq" else "Cannot coerce argument %d into the universe" % (k + 1), _UNIVERSE_FAIL[kind])
        return out
    if isinstance(universe, (_sp.PolynomialRing_, RealField_, _snf.NumberField_absolute, _smat.MatrixSpace_)) and any(_num(x) for x in items):
        # (a number in [Q[x] | 2] is a constant polynomial, as Magma's; one
        # not integral doesn't go into Z[x]; in a real field a real, in a
        # number field the field's element, in a square matrix space the
        # scalar matrix, astra2 WA-012..014; a non-square one takes none)
        d, out = _udesc(universe), []
        for k, x in enumerate(items):
            y = _into(x, d, universe) if d is not None and _num(x) else x
            if y is _NOCOERCE:
                raise MagmaError("Coerce failed for sequence element" if kind == "seq" else "Cannot coerce argument %d into the universe" % (k + 1), _UNIVERSE_FAIL[kind])
            out.append(y)
        return out
    ff = isinstance(universe, _MFinField)
    if not ff and not ((universe is _ZZ or universe is _QQ) and any(_is_ff(x) for x in items)):
        # (the rationals' elements are rationals, the integral ones too)
        return [_qelt(x) for x in items] if universe is _QQ and all(_num(x) for x in items) else items
    out = []
    if ff:
        # (the whole collection's embeddings and descents admitted under one
        # budget before the first element goes in, then paid from it)
        seen, hits = set(), set()
        total = sum(_ff_into_cost(universe, x, seen, _UNIVERSE_FAIL[kind], hits) for x in items)
        first = next((_ffwrap(x.parent()) for x in items if _is_ff(x)), universe)
        _ffsub.charge([_ffsub.WORK], total, _ff_refuse("a collection", first, universe, _UNIVERSE_FAIL[kind]))
        _ffsub.keep(hits)
        paid = [total]
    for k, x in enumerate(items):
        if ff:
            y = _ff_into(universe, x, paid)
        elif not _is_ff(x):
            y = _qelt(x) if universe is _QQ and _num(x) else x
        elif universe is _ZZ and _ffwrap(x.parent()).n == 1:
            y = int(x)
        elif universe is _ZZ and _ffsub.prime_value(x) is not None:
            y = _ffsub.prime_value(x)
        else:
            y = None
        if y is None:
            raise MagmaError("Coerce failed for sequence element" if kind == "seq" else "Cannot coerce argument %d into the universe" % (k + 1), _UNIVERSE_FAIL[kind])
        out.append(y)
    return out


def _res_items(items, R, kind):
    """A collection's items in Integers(m): its declared universe R, or,
    with none, the ring of the residues among them, into which integers
    (and rationals with a unit denominator) are coerced, as Magma does
    ({R!1, 7} is one element, CORR-DFC-1).  Residues of different moduli,
    or other values among residues, are refused in words."""
    where = _UNIVERSE_FAIL[kind]
    if R is None:
        rings = {x.R for x in items if isinstance(x, _MResElt)}
        if len(rings) > 1:
            raise MagmaError("a collection of residues modulo different integers is not supported yet", where)
        R = rings.pop()
    out = []
    for k, x in enumerate(items):
        if x is _UNDEF:
            out.append(x)
            continue
        if not (isinstance(x, (_MResElt, _Fraction)) or (isinstance(x, int) and not isinstance(x, bool))):
            raise MagmaError("a collection of residues and other values is not supported yet", where)
        try:
            out.append(R._magma_coerce(x))
        except MagmaError:
            raise MagmaError("Coerce failed for sequence element" if kind == "seq" else "Cannot coerce argument %d into the universe" % (k + 1), where)
    return out


def _cyc_items(items, where):
    """A literal with a cyclotomic field's elements: with integers,
    rationals and elements of that field only; Magma's error with another
    number field's or a polynomial in a sequence (as seen in Magma
    2.18); else refused (another cyclotomic field's: Magma makes a larger
    one)."""
    # (a cyclotomic element first, even a zero one, which is falsy: astra2
    # on e3d3d0e1)
    c = next((x for x in items if _cyc_elt(x)), None)
    if c is None:
        c = next((x for x in items if isinstance(x, _MNFElt)), None)
    if c is None:
        return items
    if not _cyc_elt(c):
        # (another number field's elements with integers and rationals:
        # those coerced into it, as Magma's [b, 1]; with anything else as
        # they were)
        if all(x is _UNDEF or _num(x) or (isinstance(x, _MNFElt) and x.parent() is c.parent()) for x in items):
            return _nf_items(items, c.parent(), "seq")
        return items
    for x in items:
        if x is _UNDEF or (isinstance(x, (int, _Fraction)) and not isinstance(x, bool)) or (_cyc_elt(x) and x.parent() is c.parent()):
            continue
        if where == "[ ... ]" and ((isinstance(x, _MNFElt) and not _cyc_elt(x)) or isinstance(x, _sp.Polynomial)):
            raise MagmaError("No valid universe containing all elements", "[ ... ]")
        what = "another cyclotomic field's element" if _cyc_elt(x) else "a %s" % _type_of(x)
        raise MagmaError("a collection of a cyclotomic field's elements and %s is not supported yet" % what, where)
    # (the integers and rationals among them are the field's, as Magma's
    # [z, 1]: astra2 CORR-E65-2)
    return _nf_items(items, c.parent(), "seq")


def _seq(items, universe=None):
    items = list(items)
    if universe is None:
        items = _cyc_items(items, "[ ... ]")
    if universe is None and any(isinstance(x, _MResElt) for x in items):
        items = _res_items(items, None, "seq")
    if universe is None:
        items = _ff_universe(items, "[ ... ]")
        if any(isinstance(x, _MFFPoly) for x in items):
            items = _ffp_items(items)
        elif any(isinstance(x, _FFLIN) for x in items):
            items = _ffm_items(items)
    else:
        items = _into_universe(items, universe, "seq")
    inf = _infer_from(items) if universe is None else None
    t = MSeq(_as_inferred(items, inf), universe)
    if universe is None:
        t._inf = inf  # (Magma fixes it as the sequence is made)
        if not items:
            t._null = True  # (written empty, [] or an empty comprehension: no universe)
    return t


def _as_inferred(items, inf):
    """The items of a collection whose universe Magma infers as inf: in
    the rationals, its integers are rationals (CORR-765-1)."""
    if inf is _QQ:
        return [x if x is _UNDEF else _qelt(x) for x in items]
    return items


def _set_universe(items):
    """Magma refuses a set of values with no hashing algorithm (records,
    Rationals(), real fields, polynomial rings)."""
    items = _ff_universe(items, "{ ... }")
    for x in items:
        if isinstance(x, (MRec, _RationalField, RealField_, _sp.PolynomialRing_)):
            raise MagmaError("Invalid set universe (no hashing algorithm)", "{ ... }")
    return items


def _set(items, universe=None, derived=False):
    items = list(items)
    if universe is None:
        items = _cyc_items(items, "{ ... }")
    items = _into_universe(list(items), universe, "set")
    inf = _infer_from(items) if universe is None else None
    m = MSet(_set_universe(_as_inferred(items, inf)), "set", universe)
    if universe is None:
        m._inf = inf
        if not items and not derived:
            m._null = True  # (written empty, {} or an empty comprehension: no universe)
    return m


def _iset(items, universe=None, derived=False):
    items = list(items)
    if universe is None:
        items = _cyc_items(items, "{@ ... @}")
    items = _into_universe(list(items), universe, "indexed")
    inf = _infer_from(items) if universe is None else None
    m = MSet(_set_universe(_as_inferred(items, inf)), "indexed", universe)
    if universe is None:
        m._inf = inf
        if not items and not derived:
            m._null = True  # (written empty, {} or an empty comprehension: no universe)
    return m


def _mset(items, universe=None, derived=False):
    items = list(items)
    if universe is None:
        items = _cyc_items(items, "{* ... *}")
    items = _into_universe(list(items), universe, "multi")
    inf = _infer_from(items) if universe is None else None
    m = MSet(_set_universe(_as_inferred(items, inf)), "multi", universe)
    if universe is None:
        m._inf = inf
        if not items and not derived:
            m._null = True  # (written empty, {} or an empty comprehension: no universe)
    return m


def _still_range(v):
    """Whether a set made by a range still has exactly the range's elements
    (Include, Exclude and the like change its elements, not its range)."""
    lo, hi, step = v.range
    n = (hi - lo) // step + 1
    return len(v.items) == n and all(isinstance(x, int) and not isinstance(x, bool) and lo <= x <= hi and (x - lo) % step == 0 for x in v.items)


# a comprehension ([ e : x in S ], { ... }, {@ ... @}, {* ... *}), a
# selection S[I], a set of a range or a sequence made from one builds at
# most _COLLECT_MAX elements (HARD-FCC-1, HARD-A57-1): 10^6, or fewer in a
# small heap.  The heap a script has is the limit less what is already in
# use when Magma mode has loaded (its compiled modules: about 59 MB of a
# 96 MiB heap in October 2026), so the bound is the least of
#   - 10^6;
#   - limit // 2048, the earlier bound, which this one never exceeds;
#   - free // _COLLECT_COST, free = limit - used.
# used is sys._sagebrush_heap_used() (V8's used heap, Node only), rounded
# up to a whole MiB so that one script gets one bound run after run, and
# taken once, when this module has finished importing (the end of the
# file): the bound never changes within a session.  Where the host has no
# heap statistics (the browser, Bun, Deno; CPython), used is the fixed
# _COLLECT_RESERVE instead.  (Measured in a 96 MiB heap on Node 24 and 26:
# 49152 triples <x, [x, x+1], x/3>, the costliest element of the tests,
# need a heap of 84 to 88 MiB, about 540 bytes each above the loaded
# 59 MB; at _COLLECT_COST each, the bound there is about 37000, which peaks
# near 80 MB, under 90% of the heap.)
_COLLECT_COST = 1024
_COLLECT_RESERVE = 64 << 20


def _collect_max():
    n = getattr(_sys, "_sagebrush_heap_limit", None)
    # (CPython, or a host that cannot say: a nominal 1 GiB)
    limit = int(n) if n else 1 << 30
    used = None
    f = getattr(_sys, "_sagebrush_heap_used", None)
    if callable(f):
        try:
            used = f()
        except Exception:
            used = None
    mib = 1 << 20
    used = _COLLECT_RESERVE if used is None else -(-int(used) // mib) * mib
    return min(10 ** 6, limit // 2048, max(0, limit - used) // _COLLECT_COST)


def _collect_refusal():
    return MagmaError("a comprehension of more than %d elements is not supported yet" % _COLLECT_MAX)


def _collect(gen):
    """A comprehension's elements, refused once there are more than
    _COLLECT_MAX of them, before the collection is built (HARD-FCC-1)."""
    v = []
    for x in gen:
        if len(v) == _COLLECT_MAX:
            raise _collect_refusal()
        v.append(x)
    return v


def _admit_power(s, k):
    """x1, ..., xk in S in a comprehension without a condition: #S^k
    elements, refused before any is built when there are too many (S of a
    known size; otherwise _collect bounds it) (HARD-FCC-1)."""
    if isinstance(s, MRange):
        n = s.size()
    elif isinstance(s, (MSeq, MSet, MTuple, list, tuple)):
        n = len(s)
    elif isinstance(s, _MFinField):
        n = s.q
    else:
        return s
    if n > 1 and (n > _COLLECT_MAX or n ** k > _COLLECT_MAX):
        raise _collect_refusal()
    return s


def _witness(gen):
    """The first of a generator (exists(t){ ... }'s witness, in a 1-tuple), or None."""
    return next(iter(gen), None)


# A range's endpoint from a real has at most this many digits (HARD-1CD-1)
_RANGE_DIGITS = 10 ** 5


def _range_int(v, open_, pos):
    """A range's endpoint or step as the integer it is (2/1 or 3.0 too, as
    Magma takes it), or Magma's refusal of one that is not."""
    if isinstance(v, bool) or not (isinstance(v, (int, _Fraction)) or isinstance(v, MReal)):
        return v  # (another type: its own errors, as before)
    if isinstance(v, MReal):
        # (decided from its bits m and exponent e, value m * 2^e, before
        # any expansion: a huge exponent is never made into a huge integer,
        # HARD-1CD-1)
        m, e = v.m, v.e
        if m and e >= 0:
            # (10^_RANGE_DIGITS has fewer bits than this; past it, refused
            # unexpanded; nearer, by its digits)
            if abs(m).bit_length() + e > 4 * _RANGE_DIGITS or len(str(abs(m) << e)) > _RANGE_DIGITS:
                raise MagmaError("a range endpoint of more than %d digits is not supported yet" % _RANGE_DIGITS)
            return m << e
        if not m:
            return 0
        # (|m| < 2^-e: not an integer; else one when 2^-e divides m)
        f = _Fraction(m >> -e) if -e < abs(m).bit_length() and not abs(m) & ((1 << -e) - 1) else _Fraction(1, 2)
    else:
        f = _Fraction(v)
    if f.denominator != 1:
        what = "Sequence" if open_ == "[" else "Set"
        where = "[ ... ]" if open_ == "[" else "%s ... %s" % (open_, {"{": "}", "{@": "@}", "{*": "*}"}[open_])
        raise MagmaError("%s range does not consist of integers" % what, where, True, pos)
    return int(f.numerator)


def _range(a, b, c, open_, universe=None, pos=None):
    if universe is not None and universe is not _ZZ:
        # (a range's elements are integers: Magma refuses another universe)
        if open_ == "[":
            raise MagmaError("Invalid sequence universe", "[ ... ]", True, pos)
        if open_ == "{":
            raise MagmaError("Invalid set universe (no hashing algorithm)", "{ ... }", True, pos)
        raise MagmaError("a range with a universe in %s ... is not supported yet" % open_)
    # (the universe first, as Magma checks it, CORR-1CD-1)
    a, b, c = (_range_int(v, open_, pos) for v in (a, b, c))
    if isinstance(c, int) and c == 0 and isinstance(a, int) and isinstance(b, int):
        raise MagmaError("Set/Sequence constructor: step must be non-zero", "[ ... ]" if open_ == "[" else "{ ... }", True, pos)
    if open_ != "[" and all(isinstance(v, int) and not isinstance(v, bool) for v in (a, b, c)) \
            and MRange(a, b, c).size() > _COLLECT_MAX:
        # (a set of a range is made element by element: bounded first, as a
        # sequence's range, which stays lazy, needn't be; HARD-1CD-1)
        raise MagmaError("a set of more than %d elements is not supported yet" % _COLLECT_MAX)
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


# a container nested deeper than this is refused when it is copied (value
# semantics), below the host's recursion limit (HARD-133-1)
_NEST_MAX = 100
# and a copy that would make more containers than this (a value sharing
# its parts, x := [x, x], copies to a tree of them) is refused before it
# starts; with what it copies from, the largest copy admitted fits a 96 MB
# heap (measured: about 90000 small sequences fit, HARD-756-1)
_OWN_CONTAINERS_MAX = 5 * 10 ** 4
_OWN_RECORD_WEIGHT = 8


def _is_copied(x):
    """Whether _own copies x part by part (records too: HARD-319-1)."""
    return isinstance(x, (MSeq, MSet, MTuple, MRec))


def _copied_parts(v):
    return v.items if isinstance(v, MSet) else v.vals.values() if isinstance(v, MRec) else v


def _own_size(v, memo, depth=0):
    """How many containers a copy of v makes, counted once per shared
    part (memo, by identity), capped just past _OWN_CONTAINERS_MAX; one
    nested past _NEST_MAX counts as too many."""
    if not _is_copied(v):
        return 0
    if depth >= _NEST_MAX:
        return 1  # (_own refuses it for its depth)
    got = memo.get(id(v))
    if got is not None:
        return got[1]
    memo[id(v)] = (v, _OWN_CONTAINERS_MAX + 1)  # (in progress: a cycle is too many)
    # (a record, with its fields' dictionary, costs several times a small
    # sequence: it counts as _OWN_RECORD_WEIGHT, so that a refused copy
    # still fits a 96 MB heap)
    n = _OWN_RECORD_WEIGHT if isinstance(v, MRec) else 1
    for x in _copied_parts(v):
        if _is_copied(x):
            n += _own_size(x, memo, depth + 1)
            if n > _OWN_CONTAINERS_MAX:
                break
    n = min(n, _OWN_CONTAINERS_MAX + 1)
    memo[id(v)] = (v, n)
    return n


def _own(v, name=None, depth=0):
    """Value semantics: an assigned (or passed) container is a copy.  The
    name of the variable assigned lets some structures print it (2*C.1 = 0)."""
    if v is _UNDECLARED:
        v._fail()
    if name is not None and hasattr(v, "_magma_assigned"):
        v._magma_assigned(name)
    if _is_copied(v) and depth >= _NEST_MAX:
        raise MagmaError("a value nested more than %d deep is not supported yet" % _NEST_MAX)
    if depth == 0 and _is_copied(v) and any(_is_copied(x) for x in _copied_parts(v)):
        # (a value with containers in it: the size of its copy first)
        if _own_size(v, {}) > _OWN_CONTAINERS_MAX:
            raise MagmaError("a value of more than %d sequences, sets, tuples and records (a record counting as %d) is not supported yet" % (_OWN_CONTAINERS_MAX, _OWN_RECORD_WEIGHT))
    if isinstance(v, MSeq):
        t = MSeq([_own(x, None, depth + 1) for x in v], v.universe, getattr(v, "sample", None))
        _keep_inf(t, v, v[0] if len(v) else _UNDEF)
        return t
    if isinstance(v, MSet):
        s = MSet((), v.kind, v.universe)
        _keep_inf(s, v, v.items[0] if v.items else _UNDEF)
        s.items = [_own(x, None, depth + 1) for x in v.items]
        s.keys = {k: (list(val) if v.kind == "multi" else val) for k, val in v.keys.items()}
        s.range = v.range
        return s
    if isinstance(v, MTuple):
        return MTuple([_own(x, None, depth + 1) for x in v])
    if isinstance(v, MRec):
        return v._copy(depth)
    return v


def _keep_inf(t, v, first):
    """The copy t keeps what v knows of its universe: its first defined
    element (_wit) whenever it was looked for, since it stands for the
    universe fixed for the elements when the present ones may not (a
    rational part of a tuple replaced by an integer, CORR-47D-1); its
    inferred universe (_inf) where finding it again would cost more than
    a look at its first element: the integers or rationals (a scan), and
    anything after leading holes.  (_wit is set only by a write, so a
    large copy of a value made by literals keeps no attributes and fits
    its heap, HARD-756-1.)"""
    inf = getattr(v, "_inf", None)
    if inf is not None and (inf is not _NOINF or first is _UNDEF):
        t._inf = inf
    wit = getattr(v, "_wit", None)
    if wit is not None:
        t._wit = wit
    if getattr(v, "_null", False):
        t._null = v._null  # (written empty with no universe, or a field's: the copy is too)


def _remember(s):
    """s is about to lose elements: one of them is kept (_wit) when it is
    an element of a structure the collection's universe isn't otherwise
    known by (a number field, a real field, a polynomial ring, a matrix
    space, a finite field, Integers(m)), so that s emptied keeps its
    universe, as Magma's: S := [a]; Remove(~S, 1); Append(~S, 2) puts in
    a number field element (astra2 on de17ca12)."""
    if getattr(s, "universe", None) is not None or getattr(s, "_wit", None) is not None:
        return
    for y in (s.items if isinstance(s, MSet) else s):
        if y is _UNDEF:
            continue
        if isinstance(y, (_snf.NumberFieldElement, MReal, _sp.Polynomial, _MFFPoly, _smat.Matrix, _MResElt) + _FFLIN) or _is_ff(y):
            s._wit = y
        return


def _carry(t, *srcs, mode="any"):
    """t, a collection made from srcs (a conversion, a sort, a selection, a
    cat or a set operation), keeping what they know of an empty one's
    universe, as Magma's (checked against Magma 2.18): by default the
    integers' if any has it (a range, a declared or fixed universe), else
    written empty with no universe (_null) if all were ({} join
    {Integers() | } has the integers, {} join {} none); "meet": none if
    any had none ({Integers() | } meet {} has none); "first": none if the
    first had none (diff: {} diff {1} has none, {1} diff {1} the
    integers).  Only when every source is known (the integers' or written
    empty): with another or an unknown universe among them t stays
    unknown.  Only an empty
    t takes them: a nonempty one infers its own.  Gcd and Lcm read them
    (_null_int_collection)."""
    if not len(t) and getattr(t, "_wit", None) is None:
        # (an emptied source's element, which stands for its universe,
        # goes with the empty result: Sort, Setseq, Seqset of it, _remember;
        # but not past a written empty {} with no universe, in a meet or
        # first in a diff: S meet {}, {} meet S, {} diff S have none, as
        # Magma's; {Integers() | } diff S, S meet {1} keep it, astra2 on
        # 0118f5a5)
        blank = lambda x: getattr(x, "_wit", None) is None and _provenance(x) == "null"
        if not ((mode == "meet" and any(blank(x) for x in srcs)) or (mode == "first" and srcs and blank(srcs[0]))):
            for x in srcs:
                if getattr(x, "_wit", None) is not None:
                    t._wit = x._wit
                    break
    if len(t) or getattr(t, "universe", None) is not None or getattr(t, "_inf", None) is not None:
        return t
    # (every source must be known, the integers' or written empty: one
    # of unknown or another universe, {Rationals() | } join
    # {Integers() | }, leaves t unknown, refused by Gcd and Lcm, never
    # taken as the integers', astra2 on 76f3cb21)
    ks = [_provenance(x) for x in srcs]
    if not ks or any(k is None for k in ks):
        return t
    if mode == "meet" and "null" in ks:
        t._null = True
    elif mode == "first" and ks[0] == "null":
        t._null = True
    elif "field" in ks:
        # (the field itself, as Magma's result has it: what is put in later
        # goes into it, and it stays a field's, astra2 on 0f235472; two
        # different fields, or one not known, only the mark: refused)
        f = _one_field([x for x, k in zip(srcs, ks) if k == "field"])
        if f is _QQ and all(getattr(x, "universe", None) is None for x in srcs):
            t._inf = _QQ
        elif f is not None:
            t.universe = f
        else:
            t._null = "field"  # (a field's elements: Magma's "GCD not defined for field")
    elif "int" in ks:
        t._inf = _ZZ
    else:
        t._null = True
    return t


def _provenance(s):
    """What is known of the universe of the (empty) collection s: "int",
    "field", "null" (written empty, no universe), or None."""
    if isinstance(s, MRange):
        return "int"
    u, inf = getattr(s, "universe", None), getattr(s, "_inf", None)
    mark = getattr(s, "_null", False)
    if mark == "field":
        return "field"  # (before what its integers inferred: a field's still)
    if u is _ZZ or (u is None and inf is _ZZ):
        return "int"
    if u is _QQ or isinstance(u, _MFinField) or (u is None and inf is _QQ):
        return "field"
    if u is None and inf is None and mark is True:
        return "null"
    return None


def _one_field(srcs):
    """The field (the rationals or a finite field) of the collections srcs,
    each of a field's provenance, if they have one and it is known, else
    None."""
    f = None
    for s in srcs:
        u = getattr(s, "universe", None)
        g = u if u is _QQ or isinstance(u, _MFinField) else _QQ if u is None and getattr(s, "_inf", None) is _QQ else None
        if g is None:
            return None
        if f is not None and not (g is f or (isinstance(g, _MFinField) and isinstance(f, _MFinField) and g.q == f.q)):
            return None
        f = g
    return f


def _keep_wit(t, s):
    """t, a selection from s, keeping the element that stands for s's
    universe (CORR-765-2: S[1..1] after S[1] := <4,"r"> in a sequence of
    <rational, string> tuples still takes <1/3,"s">)."""
    wit = getattr(s, "_wit", None)
    if wit is not None:
        t._wit = wit
    return t


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


def _read_index(n, i, pos, seq):
    """s[i]'s checks, in Magma's words at the "[" (checked against Magma):
    an index outside [1 .. n] is "Index 1 (i) should be in the range
    [1 .. n]", but any index of an empty sequence is "Sequence element i
    not defined"."""
    if not isinstance(i, int) or isinstance(i, bool):
        raise MagmaError("Bad argument types", "'[]'", True, pos)
    if i < 1 or i > n:
        if seq and n == 0:
            raise MagmaError("Sequence element %d not defined" % i, "'[]'", True, pos)
        raise MagmaError("Index 1 (%d) should be in the range [1 .. %d]" % (i, n), "'[]'", True, pos)


def _int_index(j):
    return isinstance(j, int) and not isinstance(j, bool)


def _first_outside(r, n):
    """The first place k (1-based) and member j of the range r outside
    [1 .. n], from its ends without walking it (HARD-A57-1), or None."""
    size = r.size()
    if size == 0:
        return None
    if not 1 <= r.a <= n:
        return 1, r.a
    last = r.a + (size - 1) * r.c
    if 1 <= last <= n:
        return None
    # the first member past n (going up) or below 1 (going down)
    k = (n - r.a) // r.c + 2 if r.c > 0 else (r.a - 1) // (-r.c) + 2
    return k, r.a + (k - 1) * r.c


def _admit_selection(i, n, pos, outside):
    """An index list's checks before any element is taken: a range's
    members outside [1 .. n] from its ends (outside(k, j) says it), then
    the result's size against _COLLECT_MAX (HARD-A57-1)."""
    if isinstance(i, MRange):
        bad = _first_outside(i, n)
        if bad is not None:
            raise outside(*bad)
        if i.size() > _COLLECT_MAX:
            raise MagmaError("a selection of more than %d elements is not supported yet" % _COLLECT_MAX, "'[]'", True, pos)


_NOINF = object()  # (an inferred universe that is neither the integers nor the rationals)


def _infer_from(items):
    """The universe Magma infers for these elements: the integers, the
    rationals with a rational among them, _NOINF for anything else, None for
    none at all (undefined elements don't count)."""
    u, frac = None, False
    for x in items:
        if x is _UNDEF:
            continue
        if isinstance(x, bool) or not isinstance(x, (int, _Fraction)):
            return _NOINF
        u = _ZZ
        frac = frac or isinstance(x, _Fraction)
    return _QQ if frac else u


def _settle(s):
    """s has no known universe yet (it was empty, or only undefined): its
    universe is fixed from its first defined elements, as Magma fixes it,
    even after holes (CORR-BCFD-2).  Once known it never changes: Magma
    doesn't widen it, it refuses what doesn't go in (CORR-D689-1).  (Found
    once: while nothing is defined a scan finds only holes.)"""
    if getattr(s, "_inf", None) is None:
        s._inf = _infer_from(s.items if isinstance(s, MSet) else s)
    if s._inf is not None and getattr(s, "_null", False) is True:
        s._null = False  # (its elements fixed a universe: no longer null)
    # (a field's mark stays: an integer put in doesn't make it the
    # integers', astra2 on 0f235472; Gcd and Lcm refuse it)


def _admit_element(obj, val, pos):
    """val as an element of the sequence obj, coerced into obj's fixed
    universe, or refused before anything is written ("Sequence mutation
    failed", CORR-D689-1).  A sequence of sequences: its element universe
    is a sequence universe with its own universe, so a whole new element
    must be a sequence whose elements go into the other elements' universe,
    and it takes that universe (CORR-BCFD-3)."""
    refuse = lambda: MagmaError("Sequence mutation failed", ":=", False, pos)
    _settle(obj)  # (one made elsewhere: its universe fixed from what it holds)
    w = _universe(obj, True)
    # (the universe fixed for it: declared, a finite field too, or inferred)
    u = w[1] if w is not None and w[0] == "struct" else obj.universe
    if u is not None:
        y = _coerce_struct(val, u)
        if y is _NOCOERCE:
            raise refuse()
        if y is not None:
            return y
    # (its first defined element says what its elements are: Magma fixed
    # them all in one universe)
    c = _first_defined(obj)
    if c is None and u is not None:
        raise MagmaError("an element of a sequence over %s is not supported yet" % _str(u))
    return val if c is None else _like(c, val, refuse)


def _coerce_struct(x, u):
    """x coerced into the structure u, as Magma coerces into a fixed
    universe: _NOCOERCE where it can't, None where Sagebrush doesn't know
    u's elements (the caller then refuses, CORR-9348-1).  A finite field
    takes integers, rationals prime to p and its subfields' elements
    (_ff_into); the integers take a prime field's elements, the rationals
    none (as Magma does, CORR-A6D-1)."""
    if isinstance(u, _MFinField):
        y = _ff_into(u, x)
        return _NOCOERCE if y is None else y
    if isinstance(u, (_MResRing, _MFFPolyRing, _MVectorSpace)):
        try:
            return u._magma_coerce(x)
        except MagmaError as e:
            if isinstance(u, _MVectorSpace) and "not supported yet" in str(e):
                raise  # (a refusal of Sagebrush's, not Magma's error)
            return _NOCOERCE
    if (u is _ZZ or u is _QQ) and _is_ff(x):
        W = _ffwrap(x.parent())
        if u is _ZZ and W.n == 1:
            return int(x)
        if u is _ZZ and _ffsub.prime_value(x) is not None:
            return _ffsub.prime_value(x)
        return _NOCOERCE
    d = _udesc(u)
    return None if d is None else _into(x, d, u)


def _elt_ring(c):
    """The structure the element c belongs to, for _into: a polynomial's
    or a number field element's parent, a real's field (its precision);
    None for others."""
    if isinstance(c, (_sp.Polynomial, _snf.NumberFieldElement)):
        return c.parent()
    if isinstance(c, MReal):
        return RealField_(c.prec)
    return None


def _elt_into(x, c):
    """x as an element of the parent of the element c, or _NOCOERCE; None
    where Sagebrush doesn't know how Magma coerces into it."""
    if _is_ff(c):
        return _coerce_struct(x, _ffwrap(c.parent()))
    if isinstance(c, _MFFPoly):
        return _coerce_struct(x, c.R)
    if isinstance(c, _FFLIN):
        y = _ffm_like(c, x)
        return _NOCOERCE if y is None else y
    d = _desc(c)
    if d is not None and d[0] != "elt":
        if (d[0] == "Z" or d[0] == "Q") and _is_ff(x):
            return _coerce_struct(x, _ZZ if d[0] == "Z" else _QQ)
        return _into(x, d, _elt_ring(c))
    if type(x) is type(c) and (not hasattr(c, "parent") or x.parent() is c.parent()):
        return x
    return None


def _first_defined(s):
    """The first defined element of the sequence s, which stands for the
    universe Magma fixed for its elements; found once and kept, since that
    universe never changes (HARD-400-1: a write after many holes doesn't
    scan them each time).  None while s has none."""
    w = getattr(s, "_wit", None)
    if w is None:
        w = next((x for x in s if x is not _UNDEF), None)
        s._wit = w
    return w


def _fixed_universe(c):
    """The universe fixed for the collection c, declared or inferred (the
    integers or the rationals), or None."""
    if c.universe is not None:
        return c.universe
    inf = getattr(c, "_inf", None)
    return inf if inf is _ZZ or inf is _QQ else None


_LIKE_DEPTH_MAX = 100


def _like(c, val, refuse, depth=2):
    """val made an element of the same universe as c (the first defined
    element of the collection val goes into), all the way down, or
    refused: Magma fixed one universe for the collection's elements
    (CORR-BCFD-3, CORR-400-1, CORR-400-2).
    - c a sequence or a set of any kind: val a collection of c's kind (a
      set becomes c's kind of set), its elements coerced into c's fixed
      universe or, when that isn't a known structure, each made like c's
      first defined element; it keeps c's declared and fixed universe;
    - c a tuple: val a tuple of its length, each part made like c's;
    - c a scalar: val coerced into c's parent when Sagebrush knows it, else
      of c's own type; anything else is refused as not supported (Magma
      may convert it), never written unchecked.
    depth is val's level in the value it goes into (an element of a
    sequence is at level 2): past 100 it is refused in words, before the
    host's recursion limit, whatever bounds the caller has (HARD-934-1)."""
    if depth > _LIKE_DEPTH_MAX and isinstance(val, (MSeq, MSet, MTuple, MRange)):
        raise MagmaError("a value nested more than %d deep is not supported yet" % _LIKE_DEPTH_MAX)
    if isinstance(c, (MSeq, MSet)):
        if not isinstance(val, (MSeq, MRange) if isinstance(c, MSeq) else MSet):
            raise refuse()
        if isinstance(c, MSet) and val.kind == "multi" and c.kind != "multi":
            raise refuse()  # (a multiset doesn't go into a set's universe)
        if isinstance(val, MRange) and val.size() > _COLLECT_MAX:
            # (a range becomes a sequence of its elements: bounded first)
            raise MagmaError("a sequence of more than %d elements is not supported yet" % _COLLECT_MAX)
        u = _fixed_universe(c)
        known = u is not None and (_udesc(u) is not None or isinstance(u, _MFinField))
        # (else the elements are made like c's first defined element; an
        # emptied c keeps its sample, CORR-9348-FU1)
        inner = None
        if not known:
            inner = _first_defined(c) if isinstance(c, MSeq) else next(iter(c.items), None)
            if inner is None and isinstance(c, MSeq):
                inner = c.sample
        out = []
        for x in list(val):  # (a multiset's elements as often as they occur)
            if x is _UNDEF:
                out.append(x)
            elif known:
                y = _coerce_struct(x, u)
                if y is _NOCOERCE:
                    raise refuse()
                out.append(y)
            elif inner is not None:
                out.append(_like(inner, x, refuse, depth + 1))
            elif u is not None:
                raise MagmaError("an element of a collection over %s is not supported yet" % _str(u))
            else:
                out.append(x)  # (c empty, with no universe: anything goes in)
        if isinstance(c, MSeq):
            t = MSeq(out, c.universe, getattr(c, "sample", None))
        else:
            t = MSet(out, c.kind, c.universe)
        inf = getattr(c, "_inf", None)
        if inf is not None:
            t._inf = inf
        return t
    if isinstance(c, MTuple):
        if not isinstance(val, MTuple) or len(val) != len(c):
            raise refuse()
        return MTuple([_like(p, q, refuse, depth + 1) for p, q in zip(c, val)])
    if isinstance(val, (MSeq, MSet, MTuple, MRange)):
        raise refuse()
    y = _elt_into(val, c)
    if y is _NOCOERCE:
        raise refuse()
    if y is not None:
        return y
    raise MagmaError("putting a %s among elements of type %s is not supported yet" % (_ext_type(val), _ext_type(c)))


def _as_seq(s):
    """A sequence copy of s, keeping its declared universe, sample and fixed
    universe (a range's being the integers), for the intrinsics that make a
    new sequence from an old one (CORR-D689-2)."""
    t = MSeq(s, getattr(s, "universe", None), getattr(s, "sample", None))
    inf = _ZZ if isinstance(s, MRange) else getattr(s, "_inf", None)
    if inf is not None:
        t._inf = inf
    wit = getattr(s, "_wit", None)
    if wit is not None:
        t._wit = wit  # (CORR-47D-1)
    mark = getattr(s, "_null", False)
    if mark == "field" or (mark and inf is None):
        t._null = mark  # (a field's mark even once integers are in it)
    return t


def _inferred(s, items):
    """s's inferred universe: kept on s from when it was made (Magma fixes
    it then, widening only), or found once from its elements and kept
    (HARD-927-1: a selection doesn't scan s each time)."""
    u = getattr(s, "_inf", None)
    if u is None:
        u = _infer_from(items)
        if u is None:
            return None
        s._inf = u
    return None if u is _NOINF else u


def _selection_universe(s, items):
    """The universe a selection from s keeps: s's declared one, or the one
    Magma infers for s, the integers, or the rationals with a rational among
    them (CORR-451-1, CORR-927-1; Universe of {@ 2, 5/2 @}[[1]] is the
    Rational Field, of {@ 2, 5 @}[[]] the Integer Ring)."""
    u = getattr(s, "universe", None)
    if u is not None:
        return u
    if isinstance(s, MRange):
        return _ZZ
    return _inferred(s, items)


def _index(s, i, pos=None):
    """s[i], with Magma's rules and words for each kind of s (checked
    against Magma): an integer index; a sequence of them (a range too)
    for a sequence, a string or an indexed set; never a tuple (s[i, j] is
    _index_multi's)."""
    bad = lambda: MagmaError("Bad argument types", "'[]'", True, pos)
    if isinstance(s, (MSeq, MRange, MTuple, list)):
        if isinstance(i, (MSeq, MRange)):
            # S[[i, j, ...]], S[a..b]: a sequence (not of a tuple); an
            # index outside S, or an undefined element, is said without it,
            # but S[a..b] (step 1) keeps undefined elements, except at the
            # end (a sequence ends at its last one)
            if isinstance(s, MTuple):
                raise bad()
            n = s.size() if isinstance(s, MRange) else len(s)
            universe = _selection_universe(s, s) if isinstance(s, (MSeq, MRange)) else None
            if n == 0:
                if (i.size() if isinstance(i, MRange) else len(i)) == 0:
                    return _carry(_keep_wit(MSeq([], universe), s), s)
                if getattr(s, "universe", None) is None and isinstance(s, MSeq):
                    # (only an untyped empty sequence: for an empty range or
                    # an empty sequence with a universe, the selection is
                    # outside it, CORR-451-2)
                    raise MagmaError("Illegal null sequence", "'[]'", True, pos)
            _admit_selection(i, n, pos, lambda k, j: MagmaError("Sequence element not defined", "'[]'", True, pos))
            holes = isinstance(i, MRange) and i.c == 1
            out = []
            for j in i:
                if not _int_index(j):
                    raise bad()
                if not 1 <= j <= n or (s[j - 1] is _UNDEF and not holes):
                    raise MagmaError("Sequence element not defined", "'[]'", True, pos)
                out.append(s[j - 1])
            while out and out[-1] is _UNDEF:
                out.pop()
            return _carry(_keep_wit(MSeq(out, universe), s), s)
        # (any index of an untyped empty sequence is "not defined"; a typed
        # one's is out of its range)
        _read_index(s.size() if isinstance(s, MRange) else len(s), i, pos, isinstance(s, (MSeq, list)) and getattr(s, "universe", None) is None)
        v = s[i - 1]
        if v is _UNDEF:
            raise MagmaError("Sequence element %d not defined" % i, "'[]'", True, pos)
        return v
    if isinstance(s, str):
        if isinstance(i, (MSeq, MRange)):
            # (an index outside the string is named by its place in the list)
            _admit_selection(i, len(s), pos, lambda k, j: MagmaError("Index %d (%d) should be in the range [1 .. %d]" % (k, j, len(s)), "'[]'", True, pos))
            out = []
            for k, j in enumerate(i):
                if not _int_index(j):
                    raise bad()
                if not 1 <= j <= len(s):
                    raise MagmaError("Index %d (%d) should be in the range [1 .. %d]" % (k + 1, j, len(s)), "'[]'", True, pos)
                out.append(s[j - 1])
            return "".join(out)
        _read_index(len(s), i, pos, False)
        return s[i - 1]
    if isinstance(s, MSet) and s.kind == "indexed":
        if isinstance(i, (MSeq, MRange)):
            if not s.items and s.universe is None and (i.size() if isinstance(i, MRange) else len(i)):
                raise MagmaError("Illegal null indexed set", "'[]'", True, pos)
            _admit_selection(i, len(s.items), pos, lambda k, j: MagmaError("Sequence element not defined", "'[]'", True, pos))
            out = []
            for j in i:
                if not _int_index(j):
                    raise bad()
                if not 1 <= j <= len(s.items):
                    raise MagmaError("Sequence element not defined", "'[]'", True, pos)
                out.append(s.items[j - 1])
            return MSet(out, "indexed", _selection_universe(s, s.items))
        if not _int_index(i):
            raise bad()
        if not s.items and s.universe is None:
            raise MagmaError("Illegal null indexed set", "'[]'", True, pos)
        _read_index(len(s.items), i, pos, False)
        return s.items[i - 1]
    if isinstance(s, _smat.Matrix):
        # A[i]: the i-th row, for every matrix (one that arithmetic made
        # too, which isn't the _MMatrix wrapper); A[<i, j>] is Magma's Bad
        # argument types
        if not _int_index(i):
            raise bad()
        return _MMatrix._magma_index(s if isinstance(s, _MMatrix) else _mmat(s), i)
    if hasattr(s, "_magma_index"):
        return s._magma_index(i)
    if callable(s):
        return s(i)
    raise MagmaError("cannot index %s" % _str(s))


def _matrix_entry(M, idx, pos):
    """A[i, j]: the entry in row i, column j, with Magma's errors (checked
    against Magma: "Index 2 (3) should be in the range [1 .. 2]")."""
    if len(idx) != 2 or not all(_int_index(k) for k in idx):
        raise MagmaError("Bad argument types", "'[]'", True, pos)
    for k, (v, n) in enumerate(zip(idx, (M.nrows(), M.ncols())), 1):
        if not 1 <= v <= n:
            raise MagmaError("Index %d (%d) should be in the range [1 .. %d]" % (k, v, n), "'[]'", True, pos)
    return M._rows[idx[0] - 1][idx[1] - 1]


def _index_multi(s, idx, pos=None):
    """S[i, j, ...] as written: for a sequence, string, tuple or indexed set
    S[i][j]...; an element that can't be indexed is Magma's "Bad argument
    types".  Anything else (a matrix) takes the indices together."""
    if isinstance(s, _smat.Matrix):
        return _matrix_entry(s, idx, pos)  # (A[i, j]: an entry)
    if isinstance(s, _MFFMat):
        return _matrix_entry(s.M, idx, pos)
    if not isinstance(s, (MSeq, MRange, MTuple, list, str, MSet)):
        return _index(s, MTuple(idx), pos)
    for j in idx:
        if not isinstance(s, (MSeq, MRange, MTuple, list, str)) and not (isinstance(s, MSet) and s.kind == "indexed"):
            raise MagmaError("Bad argument types", "'[]'", True, pos)
        s = _index(s, j, pos)
    return s


_UNDEF = object()
_DELETE = object()  # assigned along a path by `delete r`a`


def _assign_path(obj, path, val):
    """x[i][j] := v (sequences: also one past the end, filling undefined)."""
    if not path:
        return val if val is _DELETE else _own(val)
    kind, i = path[0][:2]
    pos = path[0][2] if len(path[0]) > 2 else None
    if kind == "midx" and not isinstance(obj, (_smat.Matrix, _MFFMat)):
        # S[i, j] := v is S[i][j] := v (a matrix takes the indices together)
        return _assign_path(obj, [("idx", j, pos) for j in i] + list(path[1:]), val)
    if kind == "attr":
        if isinstance(obj, MRec):
            if len(path) == 1:
                obj._set(i, val, pos)
            else:
                obj._set(i, _assign_path(obj._get(i, pos), path[1:], val), pos)
            return obj
        raise _no_attributes(i, pos)
    if isinstance(obj, MRange):
        obj = _as_seq(obj)
    if obj is None:
        obj = MSeq()
    if isinstance(obj, MSeq):
        if not isinstance(i, int) or i < 1:
            raise MagmaError("Index %s should be positive" % _str(i))
        # (everything is checked, and the deeper parts assigned, before obj
        # grows or changes: a refused write leaves the whole path as it
        # was, CORR-BCFD-1)
        if len(path) == 1:
            if val is not _DELETE and isinstance(obj.universe, _MVectorSpace):
                _vspace_admit(obj.universe, max(len(obj), i), ":=")  # (its length after the write)
            new = val if val is _DELETE else _own(_admit_element(obj, val, pos))
        else:
            child = obj[i - 1] if i <= len(obj) else _UNDEF
            if child is _UNDEF and path[1][0] != "attr":
                # (an index into an element that isn't there: Magma's words)
                empty = not len(obj) and obj.universe is None
                raise MagmaError("Sequence mutation failed" if empty else "Bad indexed assign", ":=", False, pos)
            try:
                new = _assign_path(None if child is _UNDEF else child, path[1:], val)
            except MagmaError as e:
                if e.where == ":=" and pos is not None:
                    e.pos = pos  # (said at the first "[", as Magma says it)
                raise
        while len(obj) < i:
            obj.append(_UNDEF)
        obj[i - 1] = new
        _settle(obj)
        return obj
    if isinstance(obj, MTuple):
        l = list(obj)
        _check_index(len(l), i)
        l[i - 1] = _assign_path(l[i - 1], path[1:], val)
        return MTuple(l)
    if isinstance(obj, _smat.Matrix):
        return _matrix_assign(obj, path, val, pos)
    if isinstance(obj, _MFFMat):
        return _ffmat_assign(obj, path, val, pos)
    raise MagmaError("cannot assign into %s" % _str(obj))


def _matrix_assign(M, path, val, pos):
    """A[i, j] := v and A[i][j] := v: a new matrix (value semantics) with v
    coerced into A's ring, as Magma's ("RHS cannot be coerced into the
    coefficient ring" otherwise).  Checked before anything changes, in
    Magma's words (checked against Magma): A[<1, 2>] := v is "Bad matrix
    row index type", A[3, 1] := v "Matrix row index is not in the range
    [1 .. 2]", A[1, 2, 3] := v "Illegal number of indices"."""
    kind, i = path[0][:2]
    if kind == "midx" and len(path) == 1:
        idx = list(i)
        if len(idx) != 2:
            raise MagmaError("Illegal number of indices", ":=", False, pos)
    elif kind == "idx" and len(path) == 2 and path[1][0] == "idx":
        idx = [i, path[1][1]]
    elif kind == "idx" and len(path) == 1 and _int_index(i):
        raise MagmaError("assigning a row of a matrix is not supported yet", ":=", False, pos)
    elif kind == "idx" and not _int_index(i):
        raise MagmaError("Bad matrix row index type", ":=", False, pos)
    else:
        raise MagmaError("assigning a row or a block of a matrix is not supported yet", ":=", False, pos)
    for v, n, what in zip(idx, (M.nrows(), M.ncols()), ("row", "column")):
        if not _int_index(v):
            raise MagmaError("Bad matrix %s index type" % what, ":=", False, pos)
        if not 1 <= v <= n:
            raise MagmaError("Matrix %s index is not in the range [1 .. %d]" % (what, n), ":=", False, pos)
    if isinstance(val, bool) or not isinstance(val, (int, _Fraction)) or \
            (M._base is _sa.ZZ and _Fraction(val).denominator != 1):
        raise MagmaError("RHS cannot be coerced into the coefficient ring", ":=", False, pos)
    rows = [list(r) for r in M._rows]
    rows[idx[0] - 1][idx[1] - 1] = M._base(val)
    return _MMatrix(M._base, rows)


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
    """assigned x, for a variable x (unassigned too when a witness search
    found none: _NOVAL)."""
    try:
        return read() is not _NOVAL
    except NameError:
        return False


def _unset(g, names):
    """After a top-level statement with exists(t){ } or forall(t){ }: a
    witness it left unassigned is unbound, so that a later cell, compiled
    without the witness's read checks, finds it unassigned too, as Magma
    does (CORR-39D-1)."""
    for n in names:
        if g.get(n) is _NOVAL:
            del g[n]


def _wread(v, name, pos, local):
    """A read of a name exists(t){ } or forall(t){ } may have unassigned
    (_NOVAL): Magma's error for an unassigned name, a local's in a function."""
    if v is _NOVAL:
        if local:
            raise UnboundLocalError("cannot access local variable '%s' where it is not associated with a value" % name)
        e = NameError("name '%s' is not defined" % name)
        e._mpos = pos
        raise e
    return v


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

    def _copy(self, depth=0):
        # (its fields one level deeper, for _own's depth bound: HARD-319-1)
        return MRec(self.fmt, {k: _own(v, None, depth + 1) for k, v in self.vals.items()})

    def _str(self, indent, tail=""):
        """Printed over lines at `indent`, its closing ">" added after its
        last field is laid out (_close), then `tail` (a sequence's comma)."""
        head = "rec<%s | " % _format_name(self.fmt)
        names = [n for n in self.fmt.names if n in self.vals]
        if not names:
            return head + ">" + tail
        # (no indentation in a string Sprint or printf makes)
        step = 0 if _SPRINT[0] is not None else 4
        pad = " " * (indent + step)
        lines = []
        for n in names:
            start = "%s := " % n
            v = self.vals[n]
            # a record, a list of structures or a tuple of one nests 4
            # deeper; a value that wraps (a long sequence or string)
            # continues 8 deeper
            deep = isinstance(v, MRec) or (isinstance(v, (MSeq, MSet, MTuple)) and _multiline(v))
            if isinstance(v, MTuple) and deep:
                # (its structure 4 deeper, its continuation 8, CORR-4F1-2)
                lines.append(pad + start + _nested(v, _tuple_str, v, indent + step, indent + step + len(start), "", indent + 2 * step))
            else:
                lines.append(pad + start + _str(v, indent + (step if deep else 2 * step), indent + step + len(start)))
        return _close(head + "\n" + ",\n".join(lines), ">", indent + step) + tail


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
# Map vocabulary (stored attributes retain their existing names):
# dom/cod: domain/codomain; rule/inv: forward/inverse callables.
# graph: ordered (source, target) pairs, with at most one target per source.
# parts=(first, second): composition applies first, then second.
# inverse_of: a view delegating to the original map's preimage operation.
# universe: the structure holding a set's elements, including an empty set.
# partial: a graph need not cover its domain; application still needs a pair.

def _struct_name(S):
    """A map's domain or codomain as Magma prints it in the map: "RngInt: x"
    when a global variable x holds it, else the structure itself."""
    global_name = _global_name(S)
    return "%s: %s" % (_type_of(S), global_name) if global_name is not None else _inline(S)


def _image_universe(cod, empty):
    """Choose the universe for f(S), or None if it cannot be represented.

    A supported structural codomain is itself the universe, even for an
    empty image. A set codomain supplies its declared universe for a
    nonempty image; without one, only integer/rational inference is used.
    An empty image into a set would have that set itself as its universe
    in Magma. Sagebrush cannot represent this and refuses it. This does
    not prevent empty images into structural codomains.
    """
    supported = lambda universe: _is_struct(universe) or isinstance(universe, (_MFinField, _MResRing, _MFFPolyRing))
    if supported(cod):
        return cod
    if isinstance(cod, MSet) and not empty:
        # A declared universe is authoritative: refuse unsupported ones
        # here. Inference below runs only when no universe was declared.
        if cod.universe is not None:
            return cod.universe if supported(cod.universe) else None
        inferred = getattr(cod, "_inf", None)
        inferred = _infer_from(cod.items) if inferred is None else inferred
        if inferred is _ZZ or inferred is _QQ:
            return inferred
    return None


def _map_set_image(mapping, source_set):
    """Apply first, then choose and enforce the codomain's image universe.

    Keep the stages in this order: every recursive application, in the
    set's ordered traversal, precedes universe selection and conversion.
    The payloads must match the universe: an integer image into rationals
    becomes a rational element, not an integer with a rational label.
    """
    images = [mapping(element) for element in source_set.ordered()]
    universe = _image_universe(mapping.cod, not images)
    if universe is None:
        raise MagmaError("the image of a set under a map to this codomain is not supported yet", "map application")
    converted_images = []
    for image in images:
        converted = _coerce_struct(image, universe)
        if converted is None or converted is _NOCOERCE:
            raise MagmaError("the image of a set under a map to this codomain is not supported yet", "map application")
        converted_images.append(converted)
    image_set = _set(converted_images, derived=True)
    image_set.universe = universe
    return image_set


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
            first, second = self.parts
            return head + "\n" + _wrap("Composition of %r and" % first, 0, 0) + "\n" + repr(second)
        if self.graph is not None:
            return head + "".join("\n    " + _inline(MTuple([x, y])) for x, y in self.graph)
        if self.rule is not None:
            return head + " given by a rule" + ("" if self.inv is not None else " [no inverse]")
        return head

    def __call__(self, x):
        # A set that is itself in dom is one scalar argument. Otherwise
        # lift the map over its elements, including for an empty set.
        if isinstance(x, MSet) and not _in(x, self.dom):
            return _map_set_image(self, x)
        if self.parts is not None:
            return self.parts[1](self.parts[0](x))
        if self.inverse_of is not None:
            return self.inverse_of._preimage(x, "map application")
        if self.graph is not None:
            for source, target in self.graph:
                if _eq(source, x):
                    return target
            raise MagmaError("Application of map failed", "map application")
        # Rule application: domain admission, rule, codomain admission,
        # then coercion. Neither failed admission runs the next stage.
        if not _in(x, self.dom):
            raise MagmaError("Element is not in the domain of the map", "map application")
        image = self.rule(x)
        if not _in(image, self.cod):
            raise MagmaError("Element is not in the codomain of the map", "map application")
        return _coerce(self.cod, image) if hasattr(self.cod, "_magma_coerce") else image

    def _preimage(self, y, where):
        """The preimage of y, as Magma computes it: through the inverses of
        the parts of a composition (the last part first); by the inverse
        rule, checking that y is in the codomain and the result in the
        domain (Magma's message is the same for both), and coercing it."""
        if self.parts is not None:
            first, second = self.parts
            return first._preimage(second._preimage(y, where), where)
        if self.inverse_of is not None:
            return self.inverse_of(y)
        if self.graph is not None:
            raise MagmaError("Map has no inverse", where)
        if self.inv is None:
            raise MagmaError("There is no rule for calculating the preimage", where)
        if not _in(y, self.cod):
            raise MagmaError("Element is not in the codomain of the map", where)
        preimage = self.inv(y)
        if not _in(preimage, self.dom):
            raise MagmaError("Element is not in the codomain of the map", where)
        return _coerce(self.dom, preimage) if hasattr(self.dom, "_magma_coerce") else preimage

    def __mul__(self, g):
        """Store f * g as g(f(x)); constructing it does not run either rule."""
        if not isinstance(g, MMap):
            return NotImplemented
        if not (g.dom is self.cod or _eq(g.dom, self.cod)):
            raise MagmaError("The codomain of the first map is not the domain of the second", "'*'")
        return MMap(self.dom, g.cod, parts=(self, g))

    def _inverse(self, where):
        """Build an inverse view, without requiring an inverse rule yet.

        A missing rule fails on application. A graph, even a bijective
        one, fails here; compositions recursively build both inverses.
        Inverting a view returns the original map, with no extra layer.
        """
        if self.parts is not None:
            first, second = self.parts
            return MMap(self.cod, self.dom, parts=(second._inverse(where), first._inverse(where)))
        if self.inverse_of is not None:
            return self.inverse_of
        if self.graph is not None:
            raise MagmaError("Map has no inverse", where)
        return MMap(self.cod, self.dom, inverse_of=self)


def _normalize_map_graph(graph, pairs, where):
    """Normalize the two syntax forms; explicit arrow pairs take precedence."""
    if pairs is not None:
        graph = [tuple(pair) for pair in pairs]
    elif graph is not None:
        items = graph.ordered() if isinstance(graph, MSet) else list(graph)
        if not all(isinstance(pair, MTuple) and len(pair) == 2 for pair in items):
            raise MagmaError("argument 1 does not yield a pair or a set or sequence of pairs in the map's graph", where)
        graph = [tuple(pair) for pair in items]
    return graph


def _validate_map_graph(graph, kind, domain, codomain, where):
    """Check duplicates, membership, then coverage, in that error order.

    Even identical repeated pairs are duplicates. Partial graphs skip
    only coverage, retaining uniqueness and domain/codomain admission.
    Use the existing equality and traversal order for each check.
    """
    for index, (source, target) in enumerate(graph):
        if any(_eq(source, earlier) for earlier, _ in graph[:index]):
            raise MagmaError("More than one image is given for a single element of the domain", where)
    for source, target in graph:
        if not _in(source, domain) or not _in(target, codomain):
            raise MagmaError("argument 1 does not yield a pair or a set or sequence of pairs in the map's graph", where)
    if kind != "pmap":
        if domain is _ZZ or domain is _QQ:
            raise MagmaError("Domain of map has no cardinality algorithm", where)
        if not isinstance(domain, (MSet, MSeq, MRange)):
            raise MagmaError("a map given by a graph on this domain is not supported yet", where)
        if not all(any(_eq(source, element) for source, _ in graph) for element in _iter(domain)):
            raise MagmaError("Not enough images given to constructor", where)


def _map(kind, dom, cod, rule=None, inv=None, graph=None, pairs=None, pos=None):
    """map< A -> B | ... > (kind "map", "pmap" or "hom").  A graph gives at
    most one image for each element, and a map's (not a pmap's) gives one
    for every element of its domain, which must then be finite (Magma's
    errors, checked against Magma)."""
    where = "%s< ... >" % kind
    try:
        graph = _normalize_map_graph(graph, pairs, where)
        if graph is not None:
            _validate_map_graph(graph, kind, dom, cod, where)
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
    """The stored graph targets as a derived set; other map forms refuse.

    Unlike f(S), this does not apply a rule or select/coerce through the
    codomain's universe. The derived set infers from the stored targets.
    """
    if isinstance(f, MMap) and f.graph is not None:
        return _set([b for _, b in f.graph], derived=True)
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
    alt = _absent_alternative(name)
    raise MagmaError("%s< ... > is not supported yet%s" % (name, "; instead: " + alt if alt else ""), None, True, pos)


# ------------------------------------------------------------------ operators

def _bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, Multi):
        # an intrinsic with several values (IsSquare): its first counts
        return _bool(v[0])
    raise MagmaError("Bad argument types: expected a boolean, got %s" % _type_of(v))


def _num(x):
    return isinstance(x, (int, _Fraction)) and not isinstance(x, bool)


def _qelt(x):
    """The integer or rational x as an element of the rational field: a
    Rational even when it is integral, so that its type and parent are
    FldRatElt and the Rational Field, as Magma's (it prints, compares and
    hashes as the integer; CORR-765-1)."""
    if isinstance(x, _sa.Rational):
        return x
    if isinstance(x, _Fraction):
        # (by its parts: Fraction(q) of a Rational with big parts reads its
        # numerator() method, which fails on the host, CORR-56E-1)
        return _sa.Rational._from_coprime_ints(x._numerator, x._denominator)
    return _sa.Rational._from_coprime_ints(int(x), 1)


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
        # (a vector is a list underneath, but has arithmetic: _MVector)
        if isinstance(a, _NOARITH) and not isinstance(a, _MVector):
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


def _ff_operands(a, b, op=None, pos=None):
    """a and b, a finite field's element's partner coerced into its field
    (a rational, or the prime field's element into an extension), once
    _ff_check has let them meet; others as they are."""
    fa, fb = _is_ff(a), _is_ff(b)
    if not (fa or fb):
        return a, b
    if fa and fb:
        if a.parent() is b.parent():
            return a, b
        Ka, Kb = _ffwrap(a.parent()), _ffwrap(b.parent())
        if 1 in (Ka.n, Kb.n):
            return (Kb.K(int(a)), b) if Ka.n == 1 else (a, Ka.K(int(b)))  # (the prime field's element)
        a, b = _ff_promote([a, b], "arithmetic", "'%s'" % op if op else None, pos)[0]
        return a, b
    if fa and isinstance(b, _Fraction):
        return a, _ffwrap(a.parent())._magma_coerce(b)
    if fb and isinstance(a, _Fraction):
        return _ffwrap(b.parent())._magma_coerce(a), b
    return a, b


def _ff_eq(a, b, op="eq", pos=None):
    """a eq b for a finite field's element and what it meets (_ff_check):
    in the smallest field containing both (never by descent)."""
    x, y = (a, b) if _is_ff(a) else (b, a)
    if _is_ff(y) and x.parent() is not y.parent():
        Kx, Ky = _ffwrap(x.parent()), _ffwrap(y.parent())
        if 1 in (Kx.n, Ky.n):
            return (Ky.K(int(x)) == y) if Kx.n == 1 else (x == Kx.K(int(y)))
        x, y = _ff_promote([x, y], "a comparison", "'%s'" % op, pos)[0]
        return x == y
    return x == _ffwrap(x.parent())._magma_coerce(y)


def _ff_check(op, a, b, pos):
    """Magma's rules for a finite field's element with another value (an
    operation or a comparison), checked against Magma 2.18: True if they
    meet (the operation goes ahead), False if neither is such an element;
    else Magma's error, or "not supported yet" for what Magma computes but
    Sagebrush doesn't.  An integer meets any finite field, and a rational
    one whose denominator is prime to p; the same field, or the prime field
    with an extension of it, meet; another characteristic is "not
    compatible"; reals, polynomials over Z or Q and number fields don't
    meet them."""
    fa, fb = _is_ff(a), _is_ff(b)
    if not (fa or fb):
        return False
    x, y = (a, b) if fa else (b, a)
    o = op[:-2] if op.endswith(":=") else op
    # (Magma coerces the other operand into the field first, and has no div
    # or mod there, and no power but by an integer: CORR-581-2)
    ff2 = lambda: MagmaError("Bad argument types\nArgument types given: FldFinElt, FldFinElt", "'%s'" % o, True, pos)
    if o in ("div", "mod"):
        raise ff2()
    if o == "^" and not (fa and isinstance(b, int) and not isinstance(b, bool)):
        raise ff2()
    Kx = _ffwrap(x.parent())
    if _is_ff(y):
        Ky = _ffwrap(y.parent())
        if x.parent() is y.parent() or (Kx.p == Ky.p and 1 in (Kx.n, Ky.n)):
            return True
        if Kx.p != Ky.p:
            raise _incompatible("C", o, a, b, pos)
        # (Magma computes in the smallest field containing both: admitted
        # here, made before the operation goes ahead)
        what = "a comparison" if o in ("eq", "ne") else "arithmetic"
        # (structural only: the field, its Conway search and the embeddings
        # come in the operation itself, under its one budget, _ff_promote)
        _ff_cover([Kx, Ky], _ff_refuse(what, Kx, Ky, "'%s'" % o, pos))
        return True
    if isinstance(y, int) and not isinstance(y, bool):
        return True
    if isinstance(y, _Fraction):
        if y.denominator % Kx.p == 0:
            raise _bad_types(o, (a, b), pos)
        return True
    if isinstance(y, _smat.Matrix):
        raise MagmaError("arithmetic of a finite field's element and a matrix is not supported yet", "'%s'" % o, True, pos)
    if isinstance(y, (bool, str, MReal, _sp.Polynomial, _snf.NumberFieldElement)):
        raise _bad_types(o, (a, b), pos)
    return False


def _arith_rule(op, a, b, pos):
    """Raises Magma's error for a op b (op one of + - * / div mod ^ and
    their op-assignments), if Magma has one; checked against Magma 2.18 pair
    by pair (test/magma-compare.test.ts).  What Magma computes but Sagebrush
    doesn't model is refused ("not supported yet")."""
    o = op[:-2] if op.endswith(":=") else op
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_check(op, a, b, pos)
    if isinstance(a, _FFLIN) or isinstance(b, _FFLIN):
        return _ffmat_check(op, a, b, pos)
    if _ff_check(op, a, b, pos):
        return
    if _cyc_elt(a) or _cyc_elt(b):
        _cyc_check(o, a, b, pos)
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
    if isinstance(a, _MFunRatElt) or isinstance(b, _MFunRatElt):
        return _fun_binary("+", a, b, pos)
    _arith(op, (a, b), pos)
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_op("+", a, b, pos)
    if isinstance(a, _FFLIN) or isinstance(b, _FFLIN):
        return _ffmat_op("+", a, b, pos)
    a, b = _ff_operands(a, b, "+", pos)
    try:
        return _mod_result(a + b, "+", a, b)
    except TypeError:
        raise _bad_types(op, (a, b), pos)


def _sub(a, b, pos=None, op="-"):
    if type(a) is int and type(b) is int:
        return a - b
    if isinstance(a, _MFunRatElt) or isinstance(b, _MFunRatElt):
        return _fun_binary("-", a, b, pos)
    _arith(op, (a, b), pos)
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_op("-", a, b, pos)
    if isinstance(a, _FFLIN) or isinstance(b, _FFLIN):
        return _ffmat_op("-", a, b, pos)
    a, b = _ff_operands(a, b, "-", pos)
    try:
        return _mod_result(a - b, "-", a, b)
    except TypeError:
        raise _bad_types(op, (a, b), pos)


def _mul(a, b, pos=None, op="*"):
    if type(a) is int and type(b) is int:
        return a * b
    if type(a) is str and type(b) is str:
        return a + b  # Magma's * joins strings
    if isinstance(a, _MFunRatElt) or isinstance(b, _MFunRatElt):
        return _fun_binary("*", a, b, pos)
    _arith(op, (a, b), pos)
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_op("*", a, b, pos)
    if isinstance(a, _FFLIN) or isinstance(b, _FFLIN):
        return _ffmat_op("*", a, b, pos)
    a, b = _ff_operands(a, b, "*", pos)
    try:
        return _mod_result(a * b, "*", a, b)
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
    if isinstance(a, _MFunRatElt):
        return _fun_unary("-", a, pos)
    _arith("-", (a,), pos)
    try:
        return _mod_result(-a, "-", a)
    except TypeError:
        raise _bad_types("-", (a,), pos)


def _div(a, b, pos=None, op="/"):
    if _int(a) and _int(b):
        return _intdiv(a, b)
    if isinstance(a, _MFunRatElt) or isinstance(b, _MFunRatElt):
        return _fun_binary("/", a, b, pos)
    _arith(op, (a, b), pos)
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_op("/", a, b, pos)
    if isinstance(a, _FFLIN) or isinstance(b, _FFLIN):
        return _ffmat_op("/", a, b, pos)
    if isinstance(a, _sp.Polynomial) and _num(b) and b not in (1, -1) and a.parent().base_ring() == _sp.ZZ:
        # over the integers a number divides only if it is a unit
        raise MagmaError("Argument 2 is not a unit", "'%s'" % op, True, pos)
    if isinstance(a, MReal) or isinstance(b, MReal):
        a, b = _real_pair(a, b)
        return a / b
    a, b = _ff_operands(a, b, "/", pos)
    return _mod_result(a / b, "/", a, b)


def _idiv(a, b, pos=None):
    if _int(a) and _int(b):
        if b == 0:
            raise MagmaError("Division by zero", "'div'")
        return a // b
    _no_rationals("div", a, b, pos)
    _arith("div", (a, b), pos)
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_op("div", a, b, pos)
    if hasattr(a, "quo_rem"):
        return a.quo_rem(b)[0]
    return a // b


def _mod(a, b, pos=None):
    if _int(a) and _int(b):
        if b == 0:
            raise MagmaError("Division by zero", "'mod'")
        return a % b
    _no_rationals("mod", a, b, pos)
    _arith("mod", (a, b), pos)
    if isinstance(a, _MFFPoly) or isinstance(b, _MFFPoly):
        return _ffpoly_op("mod", a, b, pos)
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
    if isinstance(a, _MFunRatElt):
        return _fun_power(a, b, pos)
    _arith(op, (a, b), pos)
    if isinstance(a, _MFFPoly):
        return _ffpoly_op("^", a, b, pos)
    if isinstance(a, _FFLIN):
        return _ffmat_op("^", a, b, pos)
    if _num(a) and isinstance(b, _Fraction):
        return _rat_pow(a, b, op, pos)
    if isinstance(a, MReal) or isinstance(b, MReal):
        if isinstance(a, MReal) and isinstance(b, int):
            if abs(b) >= 1 << 30:
                raise MagmaError("Argument 2 (%d) is too large" % b, "'%s'" % op, True, pos)
            return a ** b  # (exactly, rounded once)
        if isinstance(b, MReal) and not isinstance(a, MReal):
            a = MReal.of(a, b.prec)  # (in the exponent's field, CORR-C682-1)
        return MReal.of(a) ** b
    if isinstance(a, _smat.Matrix) and isinstance(b, int) and not isinstance(b, bool) and b < 0 and a._base in (_sa.ZZ, _sa.QQ) \
            and a.nrows() == a.ncols():
        # (a negative power exists only for a unit determinant, over the
        # integers 1 or -1, and stays over the matrix's ring, as Magma's:
        # the inverse below is over the rationals; astra2's CORR-CA8-1)
        a._pow_admit(b)
        d = a.det()
        if d == 0 or (a._base is _sa.ZZ and d not in (1, -1)):
            raise MagmaError("Argument 1 is not invertible", "'%s'" % op, True, pos)
        r = a ** b
        if a._base is _sa.ZZ:
            r = _MMatrix(_sa.ZZ, [[int(x) for x in row] for row in r._rows], r.ncols())
        return _mod_result(r, "^", a, b)
    return _mod_result(a ** b, "^", a, b)


def _rat_pow(a, b, op, pos):
    """a^b for a rational exponent b, an integral one too: a real, as
    Magma's (2^(8/2) is 16.000..., (-8)^(1/3) is -2.000...; checked against
    Magma, CORR-765-1)."""
    p, q = int(b._numerator), int(b._denominator)
    if q == 1:
        return MReal.of(a) ** p
    if a == 0:
        if p < 0:
            raise MagmaError("a negative power of zero is not supported yet", "'%s'" % op, True, pos)
        return MReal.of(0)
    # (through Exp and Log, with guard digits, then to the default precision)
    g = 40
    if a < 0:
        if q % 2 == 0:
            raise MagmaError("an even root of a negative number is not supported yet", "'%s'" % op, True, pos)
        r = MReal.of(MReal.of(-a, g) ** MReal.of(b, g), 30)
        return -r if p % 2 else r
    return MReal.of(MReal.of(a, g) ** MReal.of(b, g), 30)


def _is_struct(x):
    """A structure (a ring or field, a polynomial ring, a matrix space)."""
    return isinstance(x, (_IntegerRing, _RationalField, RealField_, _sp.PolynomialRing_, _snf.NumberField_absolute,
                          _smat.MatrixSpace_, _MFunRat))


def _struct_cat(x):
    """A structure's category: structures of one category go in one
    sequence, and compare by their defining data."""
    for cls, cat in ((_IntegerRing, "RngInt"), (_RationalField, "FldRat"), (RealField_, "FldRe"),
                     (_sp.PolynomialRing_, "RngUPol"), (_snf.NumberField_absolute, "FldNum"),
                     (_smat.MatrixSpace_, "ModMat"), (_MFunRat, "FldFunRat")):
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
    if isinstance(x, (_MSymGroup, _MDihedralGroup)):
        return "grp"  # (permutation groups: one set or sequence holds any)
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
    if any(p[0] == "NF" and p[1] in _CYC_IDS for p in (d, e)):
        # (a cyclotomic field's elements with integers and rationals; with
        # another cyclotomic field's Magma finds a larger one, with others
        # its errors not modelled: refused)
        if d[0] in ("Z", "Q") or e[0] in ("Z", "Q"):
            return None
        raise MagmaError("a cyclotomic field's elements together with these other values are not supported yet")
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
        a, b = _real_pair(a, b)
        return a == b
    return a == b


def _real_pair(a, b):
    """A real and a number: the number coerced into the real's own field,
    as Magma does (not at the default precision, CORR-C682-1)."""
    if isinstance(a, MReal) and not isinstance(b, MReal):
        return a, MReal.of(b, a.prec)
    if isinstance(b, MReal) and not isinstance(a, MReal):
        return MReal.of(a, b.prec), b
    if isinstance(a, MReal) and isinstance(b, MReal) and a.prec != b.prec:
        p = min(a.prec, b.prec)  # (two reals meet at the lower precision)
        return MReal.of(a, p), MReal.of(b, p)
    return a, b


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
    if isinstance(a, _MFunRatElt) or isinstance(b, _MFunRatElt):
        return _fun_equal(a, b, pos)
    if _cyc_elt(a) or _cyc_elt(b):
        _cyc_check(op, a, b, pos)
    if isinstance(a, _MModSpace) or isinstance(b, _MModSpace):
        raise MagmaError("comparison of a module of matrices is not supported yet", "'%s'" % op, True, pos)
    pg = (_MSymGroup, _MDihedralGroup)
    if isinstance(a, pg) and isinstance(b, pg):
        # (permutation groups: of two degrees Magma's error; DihedralGroup(3)
        # is Sym(3), another dihedral group not Sym(n), as Magma's)
        if a.n != b.n:
            raise MagmaError("Could not find a covering group", "'%s'" % op, True, pos)
        return type(a) is type(b) or a.n == 3
    if isinstance(a, _MVectorSpace) or isinstance(b, _MVectorSpace):
        # (full vector spaces: equal of one ring and degree; another is
        # Magma's error, which names both ModTupRng when the rings differ)
        if not (isinstance(a, _MVectorSpace) and isinstance(b, _MVectorSpace)):
            raise _bad_types(op, (a, b), pos)
        if a.base is b.base and a.n == b.n:
            return True
        names = (_ext_type(a), _ext_type(b)) if a.base is b.base else tuple("ModTupRng[%s]" % _ring_cat(x.base) for x in (a, b))
        raise MagmaError("Arguments are not compatible\nArgument types given: %s, %s" % names, "'%s'" % op, True, pos)
    if isinstance(a, (_MFFPoly, _MFFPolyRing)) or isinstance(b, (_MFFPoly, _MFFPolyRing)):
        return _ffpoly_eq(a, b, op, pos)
    if isinstance(a, _FFLINALL) or isinstance(b, _FFLINALL):
        return _ffmat_eq(a, b, op, pos)
    for x, y in ((a, b), (b, a)):
        if isinstance(x, (_MVector, _MPerm)):
            return x._magma_eq(y, op)
    if isinstance(a, _MResElt) or isinstance(b, _MResElt):
        # (a residue meets its own ring's residues and the integers)
        x, y = (a, b) if isinstance(a, _MResElt) else (b, a)
        return x._magma_eq(y, op)
    if isinstance(a, MRecFormat) or isinstance(b, MRecFormat):
        # Magma has no equality of record formats
        raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (_type_of(a), _type_of(b)), "'%s'" % op, True, pos)
    if _ff_check(op, a, b, pos):
        return _ff_eq(a, b, op, pos)
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
    if ka == "set" and isinstance(a, MSet) and isinstance(b, MSet):
        a, b = _ff_sets(a, b, op, pos, "Arguments 1 and 2 have incompatible universal sets")
    return a == b


def _ne(a, b, pos=None):
    return not _eq(a, b, pos, "ne")


def _order(a, b, op, pos):
    """-1, 0 or 1: a against b, where Magma orders them (numbers with
    numbers, strings, booleans, sequences lexicographically, tuples of one
    length, Integers() with itself); Magma's error where it has none.  The
    orders Magma has on polynomials and matrices are not modelled: refused."""
    if isinstance(a, (_MFFPoly, _MFFPolyRing) + _FFLINALL) or isinstance(b, (_MFFPoly, _MFFPolyRing) + _FFLINALL):
        raise MagmaError("ordering of polynomials and matrices is not supported yet", "'%s'" % op, True, pos)
    if isinstance(a, _MResElt):
        return a._magma_cmp(b, op)
    if isinstance(b, _MResElt):
        return -b._magma_cmp(a, op)
    da, db = _desc(a), _desc(b)
    num = ("Z", "Q", "R")
    if da is not None and db is not None and da[0] in num and db[0] in num:
        fa, fb = _real_pair(a, b)
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


def _universe(s, fixed=False):
    """What decides the universe of the sequence or set s: ("struct", u)
    for one made with a structure ([ Integers() | ]), ("elt", y) for a
    first element y, None when empty.  One element is looked at, not the
    whole collection."""
    u = getattr(s, "universe", None)
    if u is not None and (_is_struct(u) or isinstance(u, _MVectorSpace)):
        return ("struct", u)
    # (fixed: for what goes into s, the universe fixed when it was made,
    # the integers or the rationals: what Magma coerces into, not the first
    # element's, CORR-D689-2)
    inf = getattr(s, "_inf", None)
    if fixed and u is None and (inf is _ZZ or inf is _QQ):
        return ("struct", inf)
    if isinstance(s, MRange):
        return ("struct", _ZZ) if fixed else (("elt", s.a) if len(s) else None)
    if isinstance(s, MSet):
        if s.items:
            return ("elt", s.items[0])
        wit = getattr(s, "_wit", None)  # (an emptied set's, _remember)
        return ("elt", wit) if wit is not None else None
    if len(s):
        y = s[0] if s[0] is not _UNDEF or not isinstance(s, MSeq) else _first_defined(s)
        if y is not None:
            return ("elt", y)
    sample = getattr(s, "sample", None)
    if sample is None:
        sample = getattr(s, "_wit", None)  # (an empty selection's, CORR-765-2)
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
        try:
            return s._magma_contains(x)
        except MagmaError as e:
            if e.pos is None and e.where == "'in'":
                e.pos = pos  # (at the in, as Magma shows it)
            raise
    if isinstance(s, str):
        return x in s
    if isinstance(s, MTuple):
        raise _bad_types(op, (x, s), pos)
    if isinstance(s, (MSeq, MRange, MSet)) and isinstance(getattr(s, "universe", None), _MVectorSpace):
        # (over a declared vector space: x coerced into it first, as V!x,
        # then compared; one that doesn't go in is Magma's error)
        y = _coerce_struct(x, s.universe)
        if y is _NOCOERCE:
            raise MagmaError("No valid universe containing all elements", "'%s'" % op, True, pos)
        return any(_cmpeq(y, z) for z in (s.items if isinstance(s, MSet) else s))  # (in any order)
    if (_is_ff(x) or (isinstance(x, (int, _Fraction)) and not isinstance(x, bool))) and isinstance(s, (MSeq, MSet)):
        # (a finite field's element is coerced into the collection's field
        # first, as Magma does: false where it doesn't go in, even if equal
        # in a larger field (GF(4)!1 in {GF(8)!1}); astra CORR-PR45-1)
        w = _universe(s)
        U = w[1] if w and w[0] == "struct" and isinstance(w[1], _MFinField) else (
            _ffwrap(w[1].parent()) if w and w[0] == "elt" and _is_ff(w[1]) else None)
        # (an integer, or a rational prime to p, goes into the field too: 1 in {E!1})
        if U is not None and not (_is_ff(x) and x.parent() is U.K):
            if (_is_ff(x) and _ffwrap(x.parent()).p != U.p) or (isinstance(x, _Fraction) and x.denominator % U.p == 0):
                raise MagmaError("No valid universe containing all elements", "'%s'" % op, True, pos)
            x = _ff_into(U, x)
            if x is None:
                return False
    if isinstance(x, (MSet, MSeq, MTuple)) and isinstance(s, (MSeq, MSet)):
        # (a collection of finite fields' elements in a collection of them:
        # its elements coerced, slot by slot, into the field of the same
        # slot of the collection's elements, as Magma does: {a} in {{b^5}}
        # and <a,c> in {<b^5,c>} are true, {F!1} in {{E!1}} false; CORR-PR45-2.
        # The walks checked and the coercions admitted whole before anything
        # is made, LIMIT-PR45-3)
        w = _universe(s)
        y = w[1] if w and w[0] == "elt" and isinstance(w[1], (MSet, MSeq, MTuple)) else None
        if y is not None:
            # (the evidence of every member, not just the first, which may
            # be empty: {a} in {{}, {b^5}}; astra CORR-PR45-2)
            intern = {}  # (one slot numbering for both)
            ny, fy, _, _ = _ff_nest_scan(_ff_walk(s), intern)
            nx, fx, cx, _ = _ff_nest_scan([x], intern)
            if cx:
                refuse = lambda: MagmaError("membership of collections this large is not supported yet", "'%s'" % op, True, pos)
                if nx > _COLLECT_MAX or ny > _COLLECT_MAX:
                    raise refuse()
                budget = [_ffsub.WORK]
                _ffsub.charge(budget, nx + ny, refuse)
                Us = {sl: next(iter(f.values())) for sl, f in fy.items() if len(f) == 1}
                seen, hits, total = set(), set(), 0
                for (sl, k), c in cx.items():
                    U = Us.get(sl)
                    if U is None:
                        continue
                    W = fx[sl][k]
                    if W.p != U.p:
                        raise MagmaError("No valid universe containing all elements", "'%s'" % op, True, pos)
                    total += _ff_into_cost_n(U, W, c, seen, hits, "'%s'" % op)
                _ffsub.charge(budget, total, refuse)
                _ffsub.keep(hits)
                paid, lx = [total], []
                _ff_leaves([x], lx, intern)
                conv = [v if sl not in Us else _ff_into(Us[sl], v, paid) for v, sl in lx]
                if any(c is None for c in conv):
                    return False
                x = _ff_rebuild(x, iter(conv), {}, intern)
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
    x, y = (a.items[0], b.items[0]) if a.items and b.items else (None, None)
    # (finite fields' elements of one characteristic meet in a common field:
    # _ff_sets puts them there)
    same_ff = _is_ff(x) and _is_ff(y) and _ffwrap(x.parent()).p == _ffwrap(y.parent()).p
    if a.items and b.items and not same_ff and not _compatible(x, y):
        if op == "join" and _eq_kind(a.items[0]) == "set" and _eq_kind(b.items[0]) == "mset":
            raise MagmaError("joining sets of sets with sets of multisets is not supported yet", "'join'", True, pos)
        raise MagmaError(message, "'%s'" % op, True, pos)


def _ff_walk(x):
    """The members of x, lazily, in the order _ff_scan, _ff_leaves and
    _ff_rebuild all use: a multiset's with their multiplicities."""
    if isinstance(x, MSet):
        return iter(x) if x.kind == "multi" else iter(x.items)
    return iter(x)


_FF_SCAN_END = object()


def _ff_slot(intern, parent, i):
    """The slot of coordinate i of a tuple in the slot parent: a small
    integer, interned in intern (parent-linked, O(1) per distinct slot, so
    no path is ever copied; the top slot is 0)."""
    k = (parent, i)
    s = intern.get(k)
    if s is None:
        s = intern[k] = len(intern) + 1
    return s


def _ff_nest_scan(xs, intern):
    """The preflight of nested collections (LIMIT-PR45-3/4): an iterative
    walk (an explicit stack, never recursion) over the list xs and its sets,
    sequences and tuples, allocating nothing but O(1) per node: per-slot
    field counts and the interned slots (_ff_slot).  An element's slot is
    that of the tuple coordinate it is in (sets and sequences share their
    elements' slot: each tuple coordinate has its own universe, as in
    Magma); a set's or sequence's declared finite-field universe counts in
    its elements' slot.  A collection deeper than _NEST_MAX is never pushed:
    the walk refuses in words there and then, whatever it holds (fail
    closed), so the stack holds at most _NEST_MAX + 1 entries.  It stops
    after _COLLECT_MAX + 1 nodes.  Returns (nodes, {slot: {id: field}},
    {(slot, id): number of elements}, the tallest stack)."""
    fields, counts, nodes, tallest = {}, {}, 0, 1
    stack = [(iter(xs), 1, 0, False)]
    while stack:
        it, d, slot, tup = stack[-1]
        x = next(it, _FF_SCAN_END)
        if x is _FF_SCAN_END:
            stack.pop()
            continue
        if tup:
            i, x = x
            here = _ff_slot(intern, slot, i)
        else:
            here = slot
        nodes += 1
        if nodes > _COLLECT_MAX:
            break
        if _is_ff(x):
            k = id(x.parent())
            fields.setdefault(here, {}).setdefault(k, _ffwrap(x.parent()))
            counts[(here, k)] = counts.get((here, k), 0) + 1
        elif isinstance(x, (MSet, MSeq, MTuple)):
            if d > _NEST_MAX:
                raise MagmaError("a value nested more than %d deep is not supported yet" % _NEST_MAX)
            u = getattr(x, "universe", None)
            if isinstance(u, _MFinField):
                fields.setdefault(here, {}).setdefault(id(u.K), u)
            stack.append((iter(enumerate(x)), d + 1, here, True) if isinstance(x, MTuple) else (_ff_walk(x), d + 1, here, False))
            tallest = max(tallest, len(stack))
    return nodes, fields, counts, tallest


def _ff_leaves(xs, out, intern, slot=0):
    """The finite fields' elements in the list xs, at any depth of sets,
    sequences and tuples, appended to out with their slots, in order (only
    after _ff_nest_scan has checked the depth: at most _NEST_MAX)."""
    for x in xs:
        if _is_ff(x):
            out.append((x, slot))
        elif isinstance(x, MTuple):
            for i, y in enumerate(x):
                _ff_leaves([y], out, intern, _ff_slot(intern, slot, i))
        elif isinstance(x, (MSet, MSeq)):
            _ff_leaves(_ff_walk(x), out, intern, slot)


def _ff_rebuild(x, it, Us, intern, slot=0):
    """x with its finite fields' elements replaced, in _ff_leaves's order, by
    those of it; a declared finite-field universe becomes its slot's common
    field (Us[slot]) when there is one."""
    if _is_ff(x):
        return next(it)
    if isinstance(x, MSet):
        u = Us.get(slot, x.universe) if isinstance(x.universe, _MFinField) else x.universe
        return MSet([_ff_rebuild(y, it, Us, intern, slot) for y in _ff_walk(x)], x.kind, u)
    if isinstance(x, MSeq):
        u = Us.get(slot, x.universe) if isinstance(x.universe, _MFinField) else x.universe
        return MSeq([_ff_rebuild(y, it, Us, intern, slot) for y in x], u)
    if isinstance(x, MTuple):
        return MTuple(_ff_rebuild(y, it, Us, intern, _ff_slot(intern, slot, i)) for i, y in enumerate(x))
    return x


def _ff_norm(xs, what, where, pos, message):
    """The values xs (a collection's items, or a set operation's operands)
    with the finite fields' elements of each slot (_ff_nest_scan) put into the
    smallest field containing that slot's fields, as Magma does ({{a},
    {b^5}} has one element; {<a,h>} eq {<b^5,h>}; {F|a} eq {K|b^5}; astra
    CORR-PR45-2), or None when no slot holds two fields.  Under one budget
    (LIMIT-PR45-3): the walk checked first (each node one cop, at most
    _COLLECT_MAX nodes, nesting at most _NEST_MAX deep, refused in words,
    never a RecursionError), then every slot's work reserved, then their
    cold Conway searches, and only then are elements collected, promoted and
    the collections rebuilt.  A slot holding two characteristics is
    `message`.  Values with no finite field's element are as they were,
    whatever their size."""
    intern = {}
    nodes, fields, counts, _ = _ff_nest_scan(xs, intern)
    if not counts:
        return None
    budget = [_ffsub.WORK]
    size = lambda: MagmaError("%s of collections this large is not supported yet" % what, where, True, pos)
    if nodes > _COLLECT_MAX:
        raise size()
    todo = {sl: list(f.values()) for sl, f in fields.items() if len(f) >= 2}
    if not todo:
        return None
    for Ws in todo.values():
        if len({W.p for W in Ws}) > 1:
            raise MagmaError(message, where, True, pos)
    _ffsub.charge(budget, nodes, size)
    plans, total = {}, 0
    for sl, Ws in todo.items():
        refuse = _ff_refuse(what, Ws[0], Ws[1] if len(Ws) > 1 else Ws[0], where, pos)
        L, cost, hits = _ffsub.reserve({k: c for (t, k), c in counts.items() if t == sl}, [W.K for W in Ws], refuse)
        plans[sl] = (L, cost, hits, refuse, Ws)
        total += cost
    _ffsub.charge(budget, total, next(iter(plans.values()))[3])
    Us = {sl: _ffwrap(_ffsub.common_field([W.K for W in pl[4]], pl[0], budget, pl[3])) for sl, pl in plans.items()}
    for pl in plans.values():
        _ffsub.keep(pl[2])
    paid, leaves = [total], []
    _ff_leaves(xs, leaves, intern)
    it = iter([_ff_up(x, Us[sl], paid, plans[sl][3]) if sl in Us else x for x, sl in leaves])
    return [_ff_rebuild(x, it, Us, intern) for x in xs]


def _ff_sets(a, b, op, pos, message):
    """The sets a and b with their finite fields' elements in common fields,
    slot by slot (_ff_norm): Magma compares and combines them there.
    Multisets as before."""
    if a.kind == "multi" or b.kind == "multi":
        return a, b
    r = _ff_norm([a, b], "a set operation", "'%s'" % op, pos, message)
    return (a, b) if r is None else (r[0], r[1])


def _same_struct(u, v):
    return u is v or (isinstance(u, _MFinField) and isinstance(v, _MFinField) and u.q == v.q) or (
        _udesc(u) is not None and _udesc(u) == _udesc(v))


def _pair_universe(op, a, b, pos, message):
    """The universe of the result of a set operation on a and b, at least
    one made with a structure ({Rationals() | }), as Magma's (checked
    against Magma 2.18): the one structure both go into, the integers going
    into the rationals and a finite field ({Integers() | } join {GF(7) | }
    is over GF(7)), elements of one made without going into the other's
    ({GF(7) | } join {4, 11} is { 4 } over GF(7), {Integers() | } join
    {1/2} over the rationals); two fields, or rationals and a finite field,
    meet in none: Magma's error.  None where Sagebrush doesn't know it (the
    result then is as it was, its universe from its elements)."""
    da, db = (getattr(x, "universe", None) for x in (a, b))
    da, db = (d if d is not None and (_is_struct(d) or isinstance(d, _MFinField)) else None for d in (da, db))
    if da is None and db is None:
        return None
    field = lambda d: d is _QQ or isinstance(d, _MFinField)
    if da is not None and db is not None:
        if _same_struct(da, db):
            return da
        if field(da) and field(db):
            raise MagmaError(message, "'%s'" % op, True, pos)
        if da is _ZZ and field(db) or db is _ZZ and field(da):
            return db if da is _ZZ else da
        return None
    d, other = (da, b) if da is not None else (db, a)
    # (the other's universe as fixed when it was made, an emptied one's
    # too: E := {1/2}; Exclude(~E, 1/2) is still the rationals', and E join
    # {GF(7) | 2} Magma's error, CORR-148-1; with none known, empty and not
    # written empty, nothing is certified)
    w = getattr(other, "_inf", None)
    if w is None:
        if other.items:
            w = _infer_from(other.items)
        else:
            k = _provenance(other)
            if k == "int":
                w = _ZZ
            elif k != "null":
                return None
    if w is None or w is _ZZ:
        return d
    if w is _QQ:
        if d is _ZZ or d is _QQ:
            return _QQ
        if isinstance(d, _MFinField):
            raise MagmaError(message, "'%s'" % op, True, pos)
    return None


def _wit_key(x):
    """What identifies the structure of the element x, for comparing the
    witnesses of emptied sets: a polynomial ring or number field itself, a
    real field's precision, else how its parent prints."""
    if isinstance(x, (_sp.Polynomial, _snf.NumberFieldElement)):
        return ("P", id(x.parent()))
    if isinstance(x, MReal):
        return ("R", x.prec)
    try:
        return ("S", repr(Parent(x)))
    except MagmaError:
        return None


def _wit_set_result(t, op, a, b, pos, message, mode):
    """t, the set a op b, when a or b is an emptied set keeping its
    universe by a witness element (_remember): Magma's error where the
    other operand's universe is incompatible with it; the witness's
    universe where every other operand is of it, holds integers only, is
    the integers', or is written empty {}; anything else refused, not
    guessed (checked against Magma 2.18, astra and astra2 on 0118f5a5).
    None when neither has one."""
    wa, wb = (getattr(x, "_wit", None) if not x.items else None for x in (a, b))
    if wa is None and wb is None:
        return None
    nf = lambda x: isinstance(x, _snf.NumberFieldElement)

    def incompatible(w, r):
        # (only what Magma was seen to reject: another number field, a
        # polynomial or real with a number field, finite fields of two
        # characteristics)
        if nf(w) and nf(r):
            return w.parent() is not r.parent()
        if nf(w) or nf(r):
            return isinstance(r if nf(w) else w, (_sp.Polynomial, MReal))
        return _is_ff(w) and _is_ff(r) and _ffwrap(w.parent()).p != _ffwrap(r.parent()).p

    def fits(w, r):
        # (an element the witness's universe certainly takes: an integer,
        # one of its own structure, a rational into a number field, a real
        # field or polynomials over the rationals)
        if isinstance(r, int) and not isinstance(r, bool):
            return True
        if isinstance(r, _Fraction) and (nf(w) or isinstance(w, MReal) or (
                isinstance(w, _sp.Polynomial) and w.parent().base_ring() == _sp.QQ)):
            return True
        k = _wit_key(w)
        return k is not None and k == _wit_key(r)

    def own(w, d):
        # (a declared universe that is the witness's own structure: {K | }
        # for an emptied set of K's elements; a real field of its precision)
        if isinstance(w, MReal):
            return isinstance(d, RealField_) and d.prec == w.prec
        try:
            p = Parent(w)
        except MagmaError:
            return False
        return p is d or _same_struct(p, d)

    unsupported = lambda: MagmaError("a set operation on an emptied set of a structure's elements and this other set is not supported yet", "'%s'" % op, True, pos)
    w = wa if wa is not None else wb
    for x, wx in ((a, wa), (b, wb)):
        r = wx
        if wx is None:
            if x.items:
                for y in x.items:
                    if incompatible(w, y):
                        raise MagmaError(message, "'%s'" % op, True, pos)
                    if not fits(w, y):
                        raise unsupported()
                continue
            d = getattr(x, "universe", None)
            if d is not None and not (d is _ZZ):
                if nf(w) and isinstance(d, _MFinField):
                    raise MagmaError(message, "'%s'" % op, True, pos)
                if own(w, d):
                    continue
                raise unsupported()
            if d is None and _provenance(x) not in ("null", "int"):
                raise unsupported()
            continue
        if incompatible(w, r):
            raise MagmaError(message, "'%s'" % op, True, pos)
        if not fits(w, r):
            raise unsupported()
    blank = lambda x: not x.items and getattr(x, "_wit", None) is None and _provenance(x) == "null"
    if (mode == "meet" and (blank(a) or blank(b))) or (mode == "first" and blank(a)):
        return None  # (S meet {}, {} diff S: no universe, as Magma's; _carry)
    if not len(t):
        t._wit = w
        return t
    if t.kind == "multi" and _multi_collides((a, b), lambda o: _elt_into(o, w)):
        raise MagmaError("a multiset operation where different elements coincide in the universe is not supported yet", "'%s'" % op, True, pos)
    items = []
    for y in (list(t) if t.kind == "multi" else t.items):
        z = _elt_into(y, w)
        if z is None or z is _NOCOERCE:
            raise unsupported()
        items.append(z)
    return MSet(items, t.kind)


def _multi_collides(srcs, coerce):
    """Whether two different elements of one of the multisets srcs become
    one element coerced (coerce, as the set operation coerces them): Magma
    then keeps a count Sagebrush doesn't model (GF(5)'s {* *} join
    {* 1, 6, 11 *} is {* 1 *}, with {* 1, 1 *} over a number field
    {* 1^^2 *}: astra2's WA-028).  One pass, by hashing."""
    for x in srcs:
        if getattr(x, "kind", None) != "multi":
            continue
        seen = {}
        for o in x.items:
            c = coerce(o)
            if c is None or c is _NOCOERCE:
                continue
            try:
                p = seen.setdefault(c, o)
            except TypeError:
                return True  # (not hashable: not certified)
            if p is not o and not (type(p) is type(o) and p == o):
                return True
    return False


def _set_result(t, op, a, b, pos, message, mode="any"):
    """t, the set a op b, over the universe Magma's has (_pair_universe),
    its elements coerced into it; an empty one keeps what is known of its
    universe as _carry has it."""
    r = _wit_set_result(t, op, a, b, pos, message, mode)
    if r is not None:
        return r
    u = _pair_universe(op, a, b, pos, message)
    if not len(t) or u is None:
        return _carry(t, a, b, mode=mode)
    if t.kind == "multi" and _multi_collides((a, b), lambda o: _coerce_struct(o, u)):
        raise MagmaError("a multiset operation where different elements coincide in the universe is not supported yet", "'%s'" % op, True, pos)
    items = []
    for x in (list(t) if t.kind == "multi" else t.items):
        y = _coerce_struct(x, u)
        if y is None:
            return t  # (elements Sagebrush can't coerce into it: as they are)
        if y is _NOCOERCE:
            raise MagmaError(message, "'%s'" % op, True, pos)
        items.append(y)
    return MSet(items, t.kind, u)


def _subset(a, b, pos=None, op="subset"):
    _set_pair(op, a, b, pos, "Arguments 1 and 2 have incompatible universal sets")
    a, b = _ff_sets(a, b, op, pos, "Arguments 1 and 2 have incompatible universal sets")
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
        if any(w and isinstance(w[1], _MVectorSpace) for w in (ua, ub)):
            raise MagmaError("concatenating sequences over a vector space is not supported yet", "'cat'", True, pos)
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
        return _carry(MSeq(list(a) + list(b), getattr(a, "universe", None) or getattr(b, "universe", None),
                           getattr(a, "sample", None) or getattr(b, "sample", None)), a, b)
    raise _bad_types("cat", (a, b), pos)


def _join(a, b, pos=None):
    _set_pair("join", a, b, pos, "No valid universe containing all elements")
    a, b = _ff_sets(a, b, "join", pos, "No valid universe containing all elements")
    k = a.kind if a.kind == b.kind else "set"
    return _set_result(MSet(list(a) + list(b), k), "join", a, b, pos, "No valid universe containing all elements")


def _meet(a, b, pos=None):
    _set_pair("meet", a, b, pos, "No valid universe containing all elements")
    a, b = _ff_sets(a, b, "meet", pos, "No valid universe containing all elements")
    return _set_result(MSet((x for x in a if _cmpeq_in(x, b)), a.kind if a.kind == b.kind else "set"), "meet", a, b, pos,
                       "No valid universe containing all elements", mode="meet")


def _diff(a, b, pos=None):
    _set_pair("diff", a, b, pos, "No valid universe containing all elements")
    a, b = _ff_sets(a, b, "diff", pos, "No valid universe containing all elements")
    return _set_result(MSet((x for x in a if not _cmpeq_in(x, b)), a.kind if a.kind == b.kind else "set"), "diff", a, b, pos,
                       "No valid universe containing all elements", mode="first")


def _sdiff(a, b, pos=None):
    _set_pair("sdiff", a, b, pos, "No valid universe containing all elements")
    a, b = _ff_sets(a, b, "sdiff", pos, "No valid universe containing all elements")
    return _set_result(MSet([x for x in a if not _cmpeq_in(x, b)] + [x for x in b if not _cmpeq_in(x, a)],
                            a.kind if a.kind == b.kind else "set"), "sdiff", a, b, pos, "No valid universe containing all elements")


def _reduce(op, s, pos=None):
    items = list(_iter(s))
    if op in ("and", "or") and not all(isinstance(x, bool) for x in items):
        raise _bad_types("&" + op, (s,), pos)
    if not items:
        if op in ("+", "*"):
            return _empty_identity(op, s, pos)
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


def _empty_identity(op, s, pos):
    """&+ and &* of the empty collection s: the zero or the one of its
    universe, as Magma's (checked against Magma 2.18, astra2's WA-027): of
    a declared one ([RealField(15) | ] gives 0.000000000000000, [K | ] K's
    0), of the integers (a range, [Integers() | ], one emptied of its
    integers), of the rationals one emptied of its rationals, of an emptied
    one's witness (_remember); Magma's "Illegal null sequence" (set) for a
    written empty one ([], {}, an empty comprehension); else refused."""
    k = 0 if op == "+" else 1
    where = "'&%s'" % op
    unsupported = lambda: MagmaError("&%s of an empty collection of this universe is not supported yet" % op, where, True, pos)
    if isinstance(s, MRange):
        return k
    u = getattr(s, "universe", None)
    if u is _ZZ:
        return k
    if u is not None:
        if u is _QQ:
            return _qelt(k)
        if isinstance(u, (RealField_, _snf.NumberField_absolute, _sp.PolynomialRing_)):
            return u(k)
        if isinstance(u, (_MFinField, _MFFPolyRing, _MResRing)):
            return _coerce(u, k, pos)
        if isinstance(u, _smat.MatrixSpace_):
            m, n = u.nrows(), u.ncols()
            if k and m != n:
                raise MagmaError("Universe has no one element", where, True, pos)
            return _MMatrix(u.base_ring(), [[k if i == j else 0 for j in range(n)] for i in range(m)], n)
        raise unsupported()
    w = getattr(s, "_wit", None)
    if isinstance(w, _MModMat):
        # (a module of matrices has a zero but no one, square or not, as
        # Magma's: astra2's CORR-CA8-2)
        if k:
            raise MagmaError("Universe has no one element", where, True, pos)
        n = w.nrows()
        return _MModMat(w._base, [[0] * n for _ in range(n)], n)
    if w is not None:
        z = _elt_into(k, w)
        if z is None or z is _NOCOERCE:
            raise unsupported()
        return z
    p = _provenance(s)
    if p == "int":
        return k
    if p == "field" and getattr(s, "_inf", None) is _QQ:
        return _qelt(k)
    if p == "null" and getattr(s, "kind", None) != "multi":
        raise MagmaError("Illegal null set" if isinstance(s, MSet) else "Illegal null sequence", where, True, pos)
    raise unsupported()


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

def _iround(f):
    """The rational f rounded to an integer (halves away from zero) in
    integers only: round() of a Fraction with a big numerator or
    denominator went through a JS number (CORR-56E-1)."""
    n, d = int(f._numerator), int(f._denominator)
    q = (2 * abs(n) + d) // (2 * d)
    return q if n >= 0 else -q


# A rational made a real has parts of at most this many bits (about 301000
# decimal digits): decided from bit lengths, before any decimal conversion
# (HARD-C68-1)
_REAL_PART_BITS = 10 ** 6


def _admit_real_parts(n, d):
    if abs(n).bit_length() > _REAL_PART_BITS or d.bit_length() > _REAL_PART_BITS:
        raise MagmaError("a real from a rational with a numerator or denominator of more than %d bits is not supported yet" % _REAL_PART_BITS)


def _shown(prec):
    """The significant digits a real of RealField(prec) prints: prec, but
    never fewer than 2 (RealField(1)!(5/2) is 2.5, 1/3 there is 0.34, 0 is
    0.00; checked against Magma 2.18)."""
    return max(prec, 2)


# A real field's precision is at most this many digits: a higher one is
# refused before any of its numbers, or 10^prec, is made (HARD-762-1)
_REAL_PREC_MAX = 1000


def _admit_prec(prec):
    if prec > _REAL_PREC_MAX:
        raise MagmaError("a real field of precision more than %d is not supported yet" % _REAL_PREC_MAX)


_BITS = {}


def _bits(prec):
    """The bits of RealField(prec)'s numbers: the least b with 2^b >= 10^prec
    (Magma's: 100 for 30 digits, 167 for 50, 34 for 10, measured as the
    least k with 1 + 2^-k eq 1; CORR-C682-2)."""
    b = _BITS.get(prec)
    if b is None:
        _admit_prec(prec)
        b = _BITS[prec] = (10 ** prec).bit_length()
    return b


def _pow_pair(m, e, n, bits):
    """(m * 2^e)^n for m > 0 and n >= 0, as a pair (m', e'): exactly while
    it stays small, else by squaring, each step rounded to `bits` bits (64
    more than the real's, so that the one rounding to the real's own bits
    is Magma's but in a vanishing few cases); never a huge integer, so that
    a large n costs only its bits' steps."""
    if n * m.bit_length() <= 4 * bits:
        return m ** n, e * n

    def close(m, e):
        if m.bit_length() > bits:
            q, k = _round_bits(m, 1, bits)
            return q, e + k
        return m, e

    r, b = (1, 0), close(m, e)
    while n:
        if n & 1:
            r = close(r[0] * b[0], r[1] + b[1])
        n >>= 1
        if n:
            b = close(b[0] * b[0], 2 * b[1])
    return r


# A real's binary exponent is at most this (about 10^301030): past it, the
# number is refused rather than made (its digits would be huge)
_REAL_EXP_BITS = 10 ** 6


def _round_bits(n, d, bits):
    """The positive rational n/d rounded to `bits` significant bits, to
    nearest with ties to even, as (m, e): m * 2^e, 2^(bits-1) <= m < 2^bits."""
    k = bits - (n.bit_length() - d.bit_length())
    while True:
        N, D = (n << k, d) if k >= 0 else (n, d << -k)
        q, r = divmod(N, D)
        if q >> bits:
            k -= 1
        elif not q >> (bits - 1):
            k += 1
        else:
            break
    if 2 * r > D or (2 * r == D and q & 1):
        q += 1
        if q >> bits:
            q >>= 1
            k -= 1
    return q, -k


class MReal:
    """A real number of RealField(prec): a binary number of _bits(prec)
    significant bits, as Magma's, every operation rounded once to nearest
    (ties to even) from its exact result, and printed to `prec` significant
    decimal digits as Magma prints it (CORR-C682-1, CORR-C682-2)."""

    __slots__ = ("m", "e", "prec")  # value m * 2^e, |m| < 2^_bits(prec)

    def __init__(self, m, e, prec=30):
        self.prec = prec
        if m == 0:
            self.m, self.e = 0, 0
            return
        bits = _bits(prec)
        if abs(m).bit_length() > bits:
            q, k = _round_bits(abs(m), 1, bits)
            m, e = (q if m > 0 else -q), e + k
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
            return MReal._frac(x, prec)
        if isinstance(x, float):
            return MReal._frac(_Fraction(x), prec)
        raise MagmaError("cannot convert %s to a real" % _type_of(x))

    @staticmethod
    def _frac(f, prec):
        """The rational f rounded once into RealField(prec).  (By its parts,
        in integers: a Fraction or Rational with big parts went through a JS
        number, CORR-56E-1.)"""
        n, d = int(f._numerator), int(f._denominator)
        if n == 0:
            return MReal(0, 0, prec)
        _admit_real_parts(n, d)
        q, e = _round_bits(abs(n), d, _bits(prec))
        r = MReal(0, 0, prec)
        r.m, r.e = (q if n > 0 else -q), e
        return r

    def frac(self):
        return _Fraction(self.m << self.e) if self.e >= 0 else _Fraction(self.m, 1 << -self.e)

    def __float__(self):
        return float(self.frac())

    def _p(self, o):
        return min(self.prec, o.prec) if isinstance(o, MReal) else self.prec

    def _o(self, o):
        """The other operand's value: an exact one coerced into this real's
        own field first, as Magma does (not at the default precision:
        RealField(50)!(10^40+1) - (10^40+1) is 0, CORR-C682-1); a real of
        a higher precision reduced to this one's (CORR-0C6-1)."""
        return MReal.of(o, min(self.prec, o.prec) if isinstance(o, MReal) else self.prec).frac()

    def _s(self, o):
        """This real's value, reduced to the other's precision where that
        is lower: two reals meet in the field of the lower (CORR-0C6-1)."""
        if isinstance(o, MReal) and o.prec < self.prec:
            return MReal.of(self, o.prec).frac()
        return self.frac()

    def __add__(self, o):
        return MReal._frac(self._s(o) + self._o(o), self._p(o)) if _real_ok(o) else NotImplemented

    __radd__ = __add__

    def __sub__(self, o):
        return MReal._frac(self._s(o) - self._o(o), self._p(o)) if _real_ok(o) else NotImplemented

    def __rsub__(self, o):
        return MReal._frac(self._o(o) - self._s(o), self._p(o)) if _real_ok(o) else NotImplemented

    def __mul__(self, o):
        return MReal._frac(self._s(o) * self._o(o), self._p(o)) if _real_ok(o) else NotImplemented

    __rmul__ = __mul__

    def __truediv__(self, o):
        d = self._o(o)
        if d == 0:
            raise MagmaError("Division by zero")
        return MReal._frac(self._s(o) / d, self._p(o))

    def __rtruediv__(self, o):
        return MReal.of(o, self.prec) / self

    def __pow__(self, n):
        if isinstance(n, int):
            if self.m == 0:
                if n < 0:
                    raise MagmaError("Division by zero")
                return MReal(0 if n else 1, 0, self.prec)
            bits = _bits(self.prec)
            m, e = _pow_pair(abs(self.m), self.e, abs(n), bits + 64)
            if n < 0:
                q, k = _round_bits(1, m, bits)
                m, e = q, k - e
            else:
                q, k = _round_bits(m, 1, bits)
                m, e = q, e + k
            if abs(e) > _REAL_EXP_BITS:
                raise MagmaError("a real with a binary exponent of more than %d is not supported yet" % _REAL_EXP_BITS)
            r = MReal(0, 0, self.prec)
            r.m, r.e = (-m if self.m < 0 and n % 2 else m), e
            return r
        return Exp(MReal.of(n, self.prec) * Log(self))

    def __neg__(self):
        return MReal(-self.m, self.e, self.prec)

    def __abs__(self):
        return MReal(abs(self.m), self.e, self.prec)

    def __eq__(self, o):
        return _real_ok(o) and self._s(o) == self._o(o)

    def __hash__(self):
        return hash(self.frac())

    def __lt__(self, o):
        return self._s(o) < self._o(o)

    def __le__(self, o):
        return self._s(o) <= self._o(o)

    def __gt__(self, o):
        return self._s(o) > self._o(o)

    def __ge__(self, o):
        return self._s(o) >= self._o(o)

    def _dec(self):
        """The value to prec significant decimal digits: (m, e) with value
        about m * 10^e, 10^(prec-1) <= |m| < 10^prec (rounded to nearest)."""
        p = _shown(self.prec)
        f = abs(self.frac())
        n, d = f.numerator, f.denominator
        e = len(str(n)) - len(str(d)) - p
        while True:
            N, D = (n, d * 10 ** e) if e >= 0 else (n * 10 ** -e, d)
            q, r = divmod(N, D)
            if q >= 10 ** p:
                e += 1
            elif q < 10 ** (p - 1):
                e -= 1
            else:
                break
        if 2 * r > D or (2 * r == D and q % 2):  # (a tie to even, CORR-0C6-2)
            q += 1
            if q == 10 ** p:
                q //= 10
                e += 1
        return (q if self.m > 0 else -q), e

    def __repr__(self):
        p = _shown(self.prec)
        if self.m == 0:
            return "0." + "0" * p
        sign = "-" if self.m < 0 else ""
        dm, de = self._dec()
        d = str(abs(dm))
        e = de + len(d) - 1  # value = d[0].d[1:] * 10^e
        if 0 <= e < p:
            return sign + d[: e + 1] + "." + d[e + 1:]
        if -4 <= e <= -1:
            # (Magma: 0.0005000000000 in RealField(10), 5.000000000E-5)
            return sign + "0." + "0" * (-e - 1) + d
        return sign + d[0] + "." + d[1:] + "E" + str(e)


def _real_ok(o):
    return isinstance(o, (MReal, int, _Fraction, float)) and not isinstance(o, bool)


# A real literal with more significant digits, or a larger exponent once
# its leading and trailing zeros are folded in, is refused
_REAL_LITERAL_DIGITS = 10000
_REAL_LITERAL_EXP = 10000


def _real(s):
    """A real literal (1.5, 2., 3e10, 1.5e-3) as a real of the default
    field, converted exactly as Fraction(s) is: its insignificant zeros
    are folded into the exponent first, and a literal still out of
    bounds is refused, so 1e100000000 is never expanded (HARD-1CD-1)
    and no literal is rounded another way (CORR-9FA-1, CORR-54E-1)."""
    m = _re.fullmatch(r"(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?", s)
    if not m:
        return MReal._frac(_Fraction(s), 30)
    whole, frac, e = m.group(1) or "", m.group(2) or "", m.group(3) or "0"
    digits = (whole + frac).lstrip("0")
    stripped = digits.rstrip("0")
    if not stripped:
        return MReal(0, 0, 30)
    if len(stripped) > _REAL_LITERAL_DIGITS:
        raise MagmaError("a real literal of more than %d significant digits is not supported yet" % _REAL_LITERAL_DIGITS)
    big = len(e.lstrip("+-").lstrip("0")) > len(str(_REAL_LITERAL_EXP)) + 1
    exp = 0 if big else int(e) - len(frac) + len(digits) - len(stripped)
    if big or abs(exp) > _REAL_LITERAL_EXP:
        raise MagmaError("a real literal with an exponent of more than %d is not supported yet" % _REAL_LITERAL_EXP)
    return MReal._frac(_Fraction(int(stripped)) * _Fraction(10) ** exp, 30)


class RealField_:
    def __init__(self, prec=30):
        _admit_prec(prec)
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
    # (as Magma checks it: an integer, positive; Magma's own bound is far
    # above ours, which RealField_ applies, HARD-762-1)
    if not isinstance(prec, int) or isinstance(prec, bool):
        raise _bad_types("RealField", [prec])
    if prec <= 0:
        raise MagmaError("Argument 1 is not positive", "'RealField'", True)
    return RealField_(prec)


# ------------------------------------------------------------------ printing

# Printing descends into nested values; a value nested deeper than this is
# refused before the host's recursion limit, in Magma's form (HARD-133-1)
_PRINT_DEPTH_MAX = 100
_print_depth = [0]
_print_at = [None]  # the container the depth was last charged for


def _nested(v, f, *args):
    """f(*args) one level deeper into the container v being printed (only
    containers come here, so a long flat sequence pays nothing).  Each
    container is charged once: _str, _inline and _atomic on the same v
    are one level (CORR-90E-1)."""
    if v is _print_at[0]:
        return f(*args)
    d, at = _print_depth[0], _print_at[0]
    if d >= _PRINT_DEPTH_MAX:
        raise MagmaError("printing a value nested more than %d deep is not supported yet" % _PRINT_DEPTH_MAX)
    _print_depth[0], _print_at[0] = d + 1, v
    try:
        return f(*args)
    finally:
        _print_depth[0], _print_at[0] = d, at


def _container(v):
    return isinstance(v, (MTuple, MSeq, MSet, MRec)) or type(v).__name__ == "MList"


def _atomic(v):
    if isinstance(v, (bool, int, str, _Fraction, MReal, _MResElt)) or _is_ff(v):
        return True
    if isinstance(v, _MNFElt) and v.parent()._quadratic:
        # (a quadratic field's, as Magma prints them: [ 1, K.1 ]; another
        # number field's one to a line)
        return True
    if isinstance(v, MTuple):
        return _nested(v, lambda: all(_atomic(x) for x in v))
    return False


def _inline(v, in_tuple=False):
    """v on one line (as inside a tuple)."""
    return _nested(v, _inline1, v, in_tuple) if _container(v) else _inline1(v, in_tuple)


def _inline1(v, in_tuple):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return '"' + v + '"' if in_tuple and not isinstance(v, _Cat) else v
    if isinstance(v, MTuple):
        return "<" + ", ".join(_inline(x, True) for x in v) + ">"
    if isinstance(v, MRange):
        return _range_str(v)
    if isinstance(v, MRec):
        return v._str(0)  # (one without fields: rec<F | >)
    if isinstance(v, (MSeq, MSet)):
        o, c = _brackets(v)
        items = _items(v)
        if not items:
            return o.replace(" ", "") + c.replace(" ", "")
        return o + ", ".join(items) + c
    if v is None:
        return "None"
    if _is_ff(v):
        return _ff_str(v)
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


# While Sprint or Sprintf makes a string (the value it was given, in a
# tuple), not session output: Magma lays a value given that way out
# without the 80-column layout at any depth, keeping a nested value's
# line breaks, its elements a line each without indentation (checked
# against Magma 2.18, the string's characters themselves, CORR-173-1)
_SPRINT = [None]


_NOMOVE = [False]


def _sprint_str(v, nowidth=True, col=None):
    """v as Sprint and Sprintf's %o make it a string; nowidth=False: as
    printf's %o writes it, without indentation but laid out on 80 columns
    (checked against Magma 2.18)."""
    old = _SPRINT[0]
    _SPRINT[0] = (v, nowidth)
    _NOMOVE[0] = not nowidth and bool(col)
    try:
        return _str(v, 0, col)
    finally:
        _SPRINT[0] = old
        _NOMOVE[0] = False


def _making_string():
    """Whether a string is being made: no width layout anywhere in it."""
    return _SPRINT[0] is not None and _SPRINT[0][1]


def _str(v, indent=0, col=None, tail=""):
    """Magma's printing of v (possibly over several lines), starting at
    column `col` (default: the indentation), followed by `tail` (the comma
    after an element of a sequence printed one element a line), which is
    laid out with v's last chunk, as Magma's printer does."""
    s, used = _nested(v, _str1, v, indent, col, tail) if _container(v) else _str1(v, indent, col, tail)
    return s if used else s + tail


def _str1(v, indent, col, tail):
    col = indent if col is None else col
    if callable(v) and getattr(v, "__wrapped__", None) is not None and globals().get(getattr(v, "__name__", None)) is v:
        # an intrinsic, as Magma prints one: its signatures, each with
        # Sagebrush's summary (not a Python function's repr)
        import _magma_docsearch
        return _magma_docsearch.intrinsic_text(v.__name__), False
    if isinstance(v, _smat.Matrix) and (v.nrows() == 0 or v.ncols() == 0):
        m, n = v.nrows(), v.ncols()
        return "Matrix with %d row%s and %d column%s" % (m, "" if m == 1 else "s", n, "" if n == 1 else "s"), False  # (as Magma prints one)
    if isinstance(v, _smat.Matrix) and indent:
        # (inside a collection: each row at the element's indentation, as
        # Magma prints [M, M]; at the top level as before)
        return ("\n" + " " * indent).join(_inline(v).split("\n")) + tail, True
    if isinstance(v, _smat.MatrixSpace_):
        # (a matrix's parent: Magma's matrix algebra or R/KMatrixSpace, not
        # Sage's "Full MatrixSpace of ... dense matrices")
        R = v.base_ring()
        name = "Integer Ring" if R == _sp.ZZ else "Rational Field" if R == _sp.QQ else None
        if name is None:
            raise MagmaError("printing this matrix space is not supported yet")
        if v.nrows() == v.ncols():
            return "Full Matrix Algebra of degree %d over %s" % (v.nrows(), name), False
        return "Full %sMatrixSpace of %d by %d matrices over %s" % ("R" if R == _sp.ZZ else "K", v.nrows(), v.ncols(), name), False
    if type(v).__name__ == "MList":
        if not v:
            return "[* *]", False
        if all(_atomic(x) for x in v):
            t = "[* " + ", ".join(_inline(x) for x in v) + " *]"
            return (t if _making_string() else _wrap(t, indent, indent)), False
        if all(type(x).__name__ == "MList" for x in v):
            return "[* " + ", ".join(_str(x, indent) for x in v) + " *]", False
        pad = " " * (indent + 4)
        return "[*\n" + ",\n".join(pad + _str(x, indent + 4) for x in v) + "\n" + " " * indent + "*]", False
    if isinstance(v, MRange):
        return _range_str(v), False
    if isinstance(v, MSet) and v.range is not None and v.kind == "set" and _still_range(v):
        lo, hi, step = v.range
        return "{ %d .. %d }" % (lo, hi) if step == 1 else "{ %d .. %d by %d }" % (lo, hi, step), False
    if isinstance(v, MSet) and any(isinstance(x, (_MSymGroup, _MDihedralGroup)) for x in v.items):
        # (Magma lists a set of groups in an order of its own, and names
        # DihedralGroup(3) and Sym(3) as one group: not modelled)
        raise MagmaError("printing a set of permutation groups is not supported yet")
    if isinstance(v, (MSeq, MSet)):
        o, c = _brackets(v)
        raw = v.ordered() if isinstance(v, MSet) else list(v)
        if not raw:
            # [] and {}, but {@ @} and {* *}, as Magma prints them
            return o.strip() + c.strip() if isinstance(v, MSeq) or v.kind == "set" else o + c.strip(), False
        if all(_atomic(x) or x is _UNDEF for x in raw):
            items = _items(v)
            # the opening bracket, each item with its comma, and the closing
            # bracket, laid out as Magma's printer does (_flow)
            # (an item with spaces, such as a tuple or a string, breaks at
            # them too, its comma on its last word)
            chunks = [(o.strip(), True)]
            for k, it in enumerate(items):
                words = (it + ("," if k < len(items) - 1 else "")).split(" ")
                chunks += [(w, True) for w in words]
            chunks.append((c.strip() + tail, False))
            if _making_string():
                return "".join(t + (" " if sp else "") for t, sp in chunks), True
            return _flow(chunks, col, indent), True
        step = 0 if _SPRINT[0] is not None else 4
        pad = " " * (indent + step)
        # (an undefined element prints as undef, as in a one-line sequence)
        # (a multiset's element with its multiplicity after its last line,
        # before the comma, as Magma prints {* a^^2, a + 1 *} one to a line)
        mult = (lambda x: "^^%d" % v.keys[_key(x)][1] if v.keys[_key(x)][1] > 1 else "") if isinstance(v, MSet) and v.kind == "multi" else (lambda x: "")
        inner = [pad + ("undef" + ("," if k < len(raw) - 1 else "") if x is _UNDEF else _str(x, indent + step, None, mult(x) + ("," if k < len(raw) - 1 else ""))) for k, x in enumerate(raw)]
        # (a matrix is followed by an empty line, as
        # Magma prints a sequence of them)
        body = "".join(t + ("\n\n" if isinstance(raw[k], (_MFFMat, _smat.Matrix)) else "\n") for k, t in enumerate(inner[:-1])) + inner[-1]
        return o.strip() + "\n" + body + "\n" + " " * indent + c.strip(), False
    if isinstance(v, MRec) and any(isinstance(p, _MFFMat) for p in v.vals.values()):
        raise MagmaError("printing a tuple or record holding a matrix over a finite field is not supported yet")
    if isinstance(v, MRec):
        return v._str(indent, tail), True
    if isinstance(v, _MFFMat):
        # (its rows under one another, at the indentation it is printed at)
        return ("\n" + " " * indent).join(repr(v).split("\n")) + tail, True
    if isinstance(v, (MTuple, MRec)) and any(isinstance(p, _MFFMat) for p in (v if isinstance(v, MTuple) else v.vals.values())):
        raise MagmaError("printing a tuple or record holding a matrix over a finite field is not supported yet")
    if getattr(v, "_magma_nowrap", False):
        return _inline(v), False
    if isinstance(v, MTuple) and any(_multiline(p) for p in v):
        return _tuple_str(v, indent, col, tail), True
    if _making_string():
        return _inline(v) + tail, True
    return _wrap(_inline(v) + tail, col, indent + _extra(v), indent), True


def _multiline(v, depth=0):
    """Whether v prints over several lines: a sequence or set of
    structures, a record with fields, a tuple holding one."""
    if depth > _PRINT_DEPTH_MAX:
        return False
    if isinstance(v, MRec):
        return any(n in v.vals for n in v.fmt.names)
    if isinstance(v, (MSeq, MSet)):
        raw = v.ordered() if isinstance(v, MSet) else list(v)
        return bool(raw) and not all(_atomic(x) or x is _UNDEF for x in raw)
    if isinstance(v, MTuple):
        return any(_multiline(p, depth + 1) for p in v)
    return False


def _close(text, closer, pad):
    """text (a record printed over lines) with its closer added as Magma's
    record printer adds it, after its last field is laid out: at the end
    of the last line if it ends before column 79; else the line's last
    word moves to a new line at the record's field indentation `pad` when
    _flow would move it (as "8>>>"), or the closer goes there after a
    backslash (checked against Magma 2.18, CORR-4F1-2)."""
    if _making_string():
        return text + closer
    nl = text.rfind("\n")
    line = text[nl + 1:]
    c = len(line)
    if c < WIDTH - 1:
        return text + closer
    s = line.rfind(" ") + 1
    if s > pad and (2 * (s - pad) > WIDTH - pad and s > 2 * pad or s >= WIDTH - 1):
        return text[:nl + 1] + line[:s] + "\n" + " " * pad + line[s:] + closer
    return text + "\\\n" + " " * pad + closer


def _tuple_str(v, indent, col, tail, cont=None):
    """A tuple with a part printed over several lines, as Magma prints it:
    its text, and the opening line of that part ("[", "rec<F | "), laid out
    as chunks on 80 columns (_flow: a chunk that doesn't fit moves to the
    next line, CORR-4F1-1), continued at `cont` (the indentation, or 8
    deeper as a record's field, CORR-4F1-2); the rest of that part at the
    tuple's indentation, `indent` (checked against Magma 2.18)."""
    cont = indent if cont is None else cont
    out, c, text = [], col if col is not None else indent, "<"

    def flush(text, opener, c):
        if _making_string():
            t = text + opener
        else:
            words = text.split(" ")
            chunks = [(w, k < len(words) - 1) for k, w in enumerate(words)]
            if opener:
                chunks.append((opener, False))
            t = _flow(chunks, c, cont, indent)
        out.append(t)
        return len(t) - t.rfind("\n") - 1 if "\n" in t else c + len(t)

    for k, p in enumerate(v):
        sep = ">" + tail if k == len(v) - 1 else ", "
        if _multiline(p):
            # (made before the text before it is laid out: printf's first
            # chunk flag kept for that text, _sprint_str)
            keep, _NOMOVE[0] = _NOMOVE[0], False
            first, rest = _str(p, indent).split("\n", 1)
            _NOMOVE[0] = keep
            c = flush(text, first, c)
            out.append("\n" + rest)
            c = len(rest) - rest.rfind("\n") - 1 if "\n" in rest else len(rest)
            text = sep
        else:
            text += _inline(p, True) + sep
    flush(text, "", c)
    return "".join(out)


def _extra(v):
    """Continuation indent of a wrapped value: polynomials (and tuples
    holding one) indent 4 more, as Magma's polynomial printer does."""
    if isinstance(v, (_sp.Polynomial, _MFFPoly, _MFunRatElt)):
        return 4
    if isinstance(v, MTuple):
        return max([_extra(x) for x in v] + [0])
    return 0


def _flow(chunks, first_col, cont, indent=None):
    """Magma's layout of chunks (text, space after it) on lines of WIDTH
    columns, the first starting at first_col (its text already written),
    the others at cont.  A chunk that doesn't fit within WIDTH starts a new
    line when it would start past the middle of the line counted from the
    structure's indentation (column c with c - indent > (WIDTH - indent)/2)
    and moving it gains more than the indentation (c - indent > indent), or
    when only column 80 is left; otherwise (and on a new line) it is written
    up to column 79 and continued on the next line after a backslash in
    column 80 (thresholds measured at indentations 0 to 48).  A space is written only where
    the line has room.  Measured against Magma 2.18 as a black box
    (integers, rationals, strings, reals and polynomials of any length, in
    sequences, nested sequences, tuples and print lines)."""
    indent = cont if indent is None else indent
    out, c = [], first_col
    for text, space in chunks:
        # (the first chunk of a value printf writes after its own text is
        # split where it doesn't fit, never moved: _sprint_str)
        nomove, _NOMOVE[0] = _NOMOVE[0], False
        if text:
            if not nomove and (2 * (c - indent) > WIDTH - indent and c > 2 * indent or c >= WIDTH - 1) and c > cont:
                if c + len(text) <= WIDTH:
                    out.append(text)
                    c += len(text)
                    text = ""
                else:
                    out.append("\n" + " " * cont)
                    c = cont
            # (by offsets: no copy of the rest of a long chunk for each line)
            i, n = 0, len(text)
            while i < n and c + n - i > WIDTH - 1:
                k = WIDTH - 1 - c
                if k <= 0:
                    # (just the backslash when the line is full and the
                    # next has room, as after printf's own text; else at
                    # least one character, so that deep lines progress)
                    k = 0 if c == WIDTH - 1 and cont < WIDTH - 1 else 1
                out.append(text[i:i + k] + "\\\n" + " " * cont)
                i, c = i + k, cont
            out.append(text[i:])
            c += n - i
        if space and c < WIDTH:
            out.append(" ")
            c += 1
    return "".join(out)


def _wrap(text, first_col, cont, indent=0):
    """Magma's line breaking at WIDTH columns, at spaces, a word that is too
    long split with a backslash (_flow); continuation lines start at column
    `cont`.  The first line starts at `first_col` (its indentation already
    written)."""
    if "\n" in text:
        lines = text.split("\n")
        return "\n".join(_wrap(l, first_col if k == 0 else 0, cont if k == 0 else 0) for k, l in enumerate(lines))
    if first_col + len(text) < WIDTH:
        return text
    words = text.split(" ")
    return _flow([(w, k < len(words) - 1) for k, w in enumerate(words)], first_col, cont, indent)


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
    if n < 1 or n > _REAL_PREC_MAX or x.m == 0:
        return None
    v = x.frac()
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


def _sprintf(fmt, *args, where="printf", string=False):
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

    col = [0]

    def put(t, literal=False):
        # (printf's own text is broken as Magma's session output breaks a
        # line: a character that would be the 80th starts a new line after
        # a backslash; Sprintf makes a string, never broken)
        if literal and not string and t != "\n" and col[0] >= WIDTH - 1:
            out.append("\\\n")
            col[0] = 0
        out.append(t)
        col[0] = len(t) - t.rfind("\n") - 1 if "\n" in t else col[0] + len(t)

    while i < len(fmt):
        c = fmt[i]
        if c != "%":
            put(c, True)
            i += 1
            continue
        i += 1
        if fmt[i:i + 1] == "%":
            put("%", True)
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
            put(("-" if x < 0 else "") + "0x" + format(abs(x), "X"))
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
            # (Sprintf makes a string: no session layout; printf writes
            # without indentation, _sprint_str)
            # (from the column printf's line has got to, CORR-4F1 follow-up)
            t = _sprint_str(x, string, None if string else col[0])
        put(t.ljust(-width) if width < 0 else t.rjust(width))
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
        if isinstance(x, _MResElt):
            return x.v  # (a residue's integer, 0 .. m - 1, as Magma's)
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
            return _qelt(x)
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
            return _qelt(_Fraction(v[0], v[1]))
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
    if _is_ff(x) and _ffwrap(x.parent()).n == 1:
        return int(x)
    if isinstance(x, _Fraction) and x.denominator == 1:
        return int(x)
    if isinstance(x, (bool, str)):
        # Python would read "7" as 7 and true as 1
        raise MagmaError("Illegal coercion\nLHS: RngInt\nRHS: %s" % _type(x), "'!'", False)
    raise MagmaError("Illegal coercion")


# Order of a residue modulo m factors m and phi(m): m is bounded
_RES_ORDER_BITS = 128


class _MResRing:
    """Integers(m): the ring of integers modulo m, as Magma has it
    (RngIntRes): elements print as 0 .. m - 1."""

    def __init__(self, m):
        self.m = m

    def __repr__(self):
        return "Residue class ring of integers modulo %d" % self.m

    def __eq__(self, other):
        return isinstance(other, _MResRing) and other.m == self.m

    def __hash__(self):
        return hash(("Zmod", self.m))

    def _magma_card(self):
        return self.m

    def __iter__(self):
        if self.m > _COLLECT_MAX:
            raise MagmaError("iterating over more than %d residues is not supported yet" % _COLLECT_MAX)
        return (_MResElt(v, self) for v in range(self.m))

    def _magma_contains(self, x):
        if isinstance(x, int) and not isinstance(x, bool):
            return True
        if isinstance(x, _MResElt):
            return x.R == self
        raise MagmaError("Bad argument types", "'in'", True)

    def _magma_coerce(self, x):
        if isinstance(x, _MResElt):
            # (from Z/nZ to Z/mZ when m divides n, as Magma's)
            if x.R.m % self.m == 0:
                return _MResElt(x.v, self)
            raise MagmaError("Illegal coercion\nLHS: RngIntRes\nRHS: RngIntResElt", "'!'", True)
        if isinstance(x, bool):
            raise MagmaError("Illegal coercion\nLHS: RngIntRes\nRHS: BoolElt", "'!'", True)
        if isinstance(x, int):
            return _MResElt(x, self)
        if isinstance(x, _Fraction):
            n, d = x.numerator, x.denominator
            if _math.gcd(d, self.m) != 1:
                raise MagmaError("Denominator is not a unit\nLHS: RngIntRes\nRHS: FldRatElt", "'!'", True)
            return _MResElt(n * pow(d, -1, self.m), self)
        raise MagmaError("coercion of a %s into Integers(m) is not supported yet" % _type_of(x), "'!'", True)


class _MResElt:
    """An element of Integers(m) (RngIntResElt): v in 0 .. m - 1."""

    __slots__ = ("v", "R")

    def __init__(self, v, R):
        self.v, self.R = v % R.m, R

    def __repr__(self):
        return str(self.v)

    def parent(self):
        return self.R

    def _magma_parent(self):
        return self.R

    def __hash__(self):
        return hash((self.R.m, self.v))

    def _meet(self, o, op):
        """o as a residue of this ring, for a op b (an integer is one)."""
        if isinstance(o, _MResElt):
            if o.R != self.R:
                raise MagmaError("Arguments are not compatible\nArgument types given: RngIntResElt, RngIntResElt", "'%s'" % op, True)
            return o.v
        if isinstance(o, int) and not isinstance(o, bool):
            return o
        raise _bad_types(op, (self, o))

    def __add__(self, o):
        return _MResElt(self.v + self._meet(o, "+"), self.R)

    def __radd__(self, o):
        return _MResElt(self._meet(o, "+") + self.v, self.R)

    def __sub__(self, o):
        return _MResElt(self.v - self._meet(o, "-"), self.R)

    def __rsub__(self, o):
        return _MResElt(self._meet(o, "-") - self.v, self.R)

    def __mul__(self, o):
        return _MResElt(self.v * self._meet(o, "*"), self.R)

    def __rmul__(self, o):
        return _MResElt(self._meet(o, "*") * self.v, self.R)

    def __neg__(self):
        return _MResElt(-self.v, self.R)

    def _inverse(self):
        if _math.gcd(self.v, self.R.m) != 1:
            return None
        return pow(self.v, -1, self.R.m)

    def __truediv__(self, o):
        d = _MResElt(self._meet(o, "/"), self.R)
        inv = d._inverse()
        if inv is None:
            raise MagmaError("Tried to divide by non-unit (%d)" % d.v, "'/'", True)
        return _MResElt(self.v * inv, self.R)

    def __rtruediv__(self, o):
        return _MResElt(self._meet(o, "/"), self.R) / self

    def __pow__(self, n):
        if not isinstance(n, int) or isinstance(n, bool):
            raise _bad_types("^", (self, n))
        if n < 0:
            inv = self._inverse()
            if inv is None:
                raise MagmaError("Can not take negative power of non-unit", "'^'", True)
            return _MResElt(pow(inv, -n, self.R.m), self.R)
        return _MResElt(pow(self.v, n, self.R.m), self.R)

    def __eq__(self, o):
        return isinstance(o, _MResElt) and o.R == self.R and o.v == self.v

    def _magma_eq(self, o, op):
        return self.v == _MResElt(self._meet(o, op), self.R).v

    def _magma_cmp(self, o, op):
        w = _MResElt(self._meet(o, op), self.R).v
        return (self.v > w) - (self.v < w)

    def _magma_order(self):
        """The multiplicative order: 0 for a non-unit, as Magma's."""
        if self.v == 0:
            raise _arg_error("Order", "Can not take order of zero element")
        m = self.R.m
        if _math.gcd(self.v, m) != 1:
            return 0
        # (it divides the group's order, phi(m): each prime of phi(m) taken
        # out while the power stays 1; m is factored, so bounded)
        if m.bit_length() > _RES_ORDER_BITS:
            raise MagmaError("Order in Integers(m) for m of more than %d bits is not supported yet" % _RES_ORDER_BITS, "'Order'")
        k = int(_sa.euler_phi(m))
        for p, _ in _sa.factor(k):
            p = int(p)
            while k % p == 0 and pow(self.v, k // p, m) == 1:
                k //= p
        return k


def Integers(K=None):
    """Integers(): the ring of integers; Integers(K): K's maximal order."""
    if K is None:
        return _ZZ
    if isinstance(K, _MFunRat):
        return K._integer_ring
    if isinstance(K, (_MNumberField, _MOrder)):
        return MaximalOrder(K)
    if isinstance(K, int) and not isinstance(K, bool):
        if K < 1:
            raise _arg_error("Integers", "Argument 1 (%d) should be >= 2" % K)
        if K == 1:
            # (Magma's prints with a map, as a ring of one element)
            raise MagmaError("Integers(1), the zero ring, is not supported yet", "'Integers'")
        return _MResRing(K)
    if isinstance(K, _MFinField):
        raise MagmaError("Bad argument types\nArgument types given: FldFin", "'Integers'")
    raise MagmaError("Integers of a %s is not supported yet" % _type_of(K), "'Integers'")


IntegerRing = Integers


def Rationals():
    return _QQ


RationalField = Rationals


def Parent(x):
    if hasattr(x, "_magma_parent"):
        return x._magma_parent()
    if _is_ff(x):
        return _ffwrap(x.parent())
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
               "List Rec RecFrmt RngUPolElt RngUPol RngInt FldRat Map FldFin FldFinElt "
               # (and those of signatures: ISA(AlgMatElt, MtrxS))
               "GrpPermElt GrpPerm RngIntResElt RngIntRes ModTupRngElt ModTupFldElt ModTupRng ModTupFld AlgMatElt ModMatRngElt ModMatFldElt MtrxS Mtrx RngElt FldElt FldAlgElt FldNumElt FldQuadElt "
               "FldNum FldQuad FldCyc FldCycElt FldAlg FldRe FldFunRat FldFunRatUElt FldFunRatElt RngOrd RngQuad Rng Fld Str Cat Any").split()
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
    if _is_ff(x):
        return "FldFinElt"
    if isinstance(x, _MFinField):
        return "FldFin"
    if isinstance(x, _MFunRat):
        return "FldFunRat"
    if isinstance(x, _MFunRatElt):
        return "FldFunRatUElt"
    if x is _ZZ:
        return "RngInt"
    if x is _QQ:
        return "FldRat"
    if isinstance(x, RealField_):
        return "FldRe"
    if type(x).__name__ == "MList":
        return "List"
    # (number fields: Magma 2.18's names; a field made by QuadraticField is
    # its own type, with its own order and elements)
    if isinstance(x, _MCycField):
        return "FldCyc"
    if isinstance(x, _MNumberField):
        return "FldQuad" if x._quadratic else "FldNum"
    if isinstance(x, _MOrder):
        return "RngQuad" if x.K._quadratic else "RngOrd"
    if isinstance(x, _MNFElt):
        if isinstance(x.parent(), _MCycField):
            return "FldCycElt"
        return "FldQuadElt" if getattr(x.parent(), "_quadratic", False) else "FldNumElt"
    if isinstance(x, _MVector):
        return "ModTupFldElt" if x._base is _sa.QQ else "ModTupRngElt"
    if isinstance(x, _MVectorSpace):
        return x._cat()
    if isinstance(x, _MResElt):
        return "RngIntResElt"
    if isinstance(x, _MFFPoly):
        return "RngUPolElt"
    if isinstance(x, _MFFPolyRing):
        return "RngUPol"
    if isinstance(x, _MFFMat):
        return "AlgMatElt" if x.is_square() else "ModMatFldElt"
    if isinstance(x, _MFFVec):
        return "ModTupFldElt"
    if isinstance(x, _MPerm):
        return "GrpPermElt"
    if isinstance(x, (_MSymGroup, _MDihedralGroup)):
        return "GrpPerm"
    if isinstance(x, _MResRing):
        return "RngIntRes"
    if isinstance(x, _MModMat):
        return "ModMatFldElt" if x._base is _sa.QQ else "ModMatRngElt"
    if isinstance(x, _MModSpace):
        return "ModMatFld" if x.base is _sa.QQ else "ModMatRng"
    if isinstance(x, _smat.Matrix) and (x._base is _sa.ZZ or x._base is _sa.QQ):
        # (a matrix Magma mode made, or one its arithmetic returned: A + A
        # is the underlying matrix class, CORR-803-1)
        # (Magma's: a square matrix is an element of a matrix algebra,
        # another of a module of matrices, over a field or a ring)
        if x.nrows() == x.ncols():
            return "AlgMatElt"
        return "ModMatFldElt" if x._base is _sa.QQ else "ModMatRngElt"
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
    if isinstance(x, _sp.PolynomialRing_):
        return "RngUPol"
    return type(x).__name__


def _ext_type(x):
    """x's type as Magma's "Argument types given" shows it: a sequence or
    set with the type of its elements (SeqEnum[RngIntElt], SeqEnum[Any]
    when empty), a polynomial with its coefficient ring."""
    if isinstance(x, (MSeq, MRange, MSet)):
        return "%s[%s]" % (_type(x), _elt_type(x))
    if isinstance(x, _sp.Polynomial):
        return "RngUPolElt[%s]" % _ring_cat(x.parent().base_ring())
    if isinstance(x, _MFFPoly):
        return "RngUPolElt[FldFin]"
    if isinstance(x, _MFFPolyRing):
        return "RngUPol[FldFin]"
    if isinstance(x, _MFunRat):
        return "FldFunRat"
    if isinstance(x, _MFunRatElt):
        return "FldFunRatUElt[%s]" % ("RngInt" if x.F._ground is _ZZ else "FldRat" if x.F._ground is _QQ else "FldFin")
    if isinstance(x, (_MFFMat, _MFFVec)):
        return "%s[FldFin]" % _type_name(x)
    if isinstance(x, _MVector):
        return "%s[%s]" % (_type_name(x), _ring_cat(x._base))
    if isinstance(x, _MVectorSpace):
        return "%s[%s]" % (x._cat(), _ring_cat(x.base))
    if isinstance(x, _MModMat):
        return "%s[%s]" % (_type_name(x), _ring_cat(x.base_ring()))
    if isinstance(x, _smat.Matrix):
        return "%s[%s]" % ("AlgMatElt" if x.is_square() else "ModMatRngElt", _ring_cat(x.base_ring()))
    if isinstance(x, _Cat):
        return "Cat[%s]" % x
    if isinstance(x, _MCycField):
        return "FldCyc[FldRat]"
    if isinstance(x, _MNFElt):
        return "%s[FldRat]" % _type_name(x)
    if isinstance(x, _MNumberField):
        return "FldQuad[FldRat]" if x._quadratic else "FldNum[FldRat]"
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
        # (a category in a sequence is Cat, its own type Cat[RngIntElt]:
        # SeqEnum[Cat], as Magma's)
        t = "Cat" if isinstance(y, _Cat) else _ext_type(y)
        if t not in types:
            types.append(t)
    if not types:
        return "Any"
    if len(types) == 1:
        return types[0]
    return "FldRatElt" if set(types) <= {"RngIntElt", "FldRatElt"} else "Any"


def _no_rationals(name, a, b, pos=None):
    """Integers only, as div, mod and Gcd take them: with a rational (an
    integral one too), Magma's error names both as rationals, the common
    universe it found (checked against Magma, CORR-765-1)."""
    if _num(a) and _num(b) and (isinstance(a, _Fraction) or isinstance(b, _Fraction)):
        raise MagmaError("Bad argument types\nArgument types given: FldRatElt, FldRatElt", "'%s'" % name, True, pos)


def _bad_types(name, args, pos=None):
    """Magma's error for arguments no signature of `name` accepts."""
    if name.endswith(":="):
        # x +:= y: Magma doesn't list the types
        return MagmaError("Bad argument types", "'%s'" % name, True, pos)
    # (an argument given by reference, f(~x), is marked "~", as Magma's:
    # the procedure call being made is that intrinsic's, _refcall)
    rc = _REFCALL[0]
    refs = rc[1] if rc is not None and rc[0] is globals().get(name) else ()
    # (no arguments: "Argument types given:" ends the line, as Magma's)
    return MagmaError("Bad argument types\nArgument types given:" + "".join(
        (", " if i else " ") + _ext_type(a) + (" ~" if i in refs else "") for i, a in enumerate(args)), "'%s'" % name, True, pos)


# ------------------------------------------------------------------ signatures
#
# A Magma intrinsic is one name over many signatures: Trace of a matrix,
# of a number field element and of a finite field element are different
# functions, chosen by the types of the arguments.  An intrinsic converted
# to this form registers each signature it implements (_signature) and is
# bound to a dispatcher that picks the most specific one, as Magma does;
# arguments no signature accepts get Magma's "Bad argument types".

# The types each of Magma's types is also, as Magma's ISA answers (checked
# against Magma 2.18 with ISA): only those of the values Sagebrush makes.
_ISA_UP = {t: frozenset(s.split()) for t, s in {
    "RngIntElt": "RngElt", "FldRatElt": "FldElt RngElt", "FldReElt": "FldElt RngElt",
    "FldFinElt": "FldElt RngElt", "FldNumElt": "FldAlgElt FldElt RngElt",
    "FldFunRatUElt": "FldFunRatElt FldElt RngElt", "FldFunRatElt": "FldElt RngElt",
    "FldQuadElt": "FldNumElt FldAlgElt FldElt RngElt", "RngUPolElt": "RngElt",
    "AlgMatElt": "MtrxS Mtrx RngElt", "ModMatRngElt": "MtrxS Mtrx", "ModMatFldElt": "ModMatRngElt MtrxS Mtrx",
    "ModTupRngElt": "Mtrx", "ModTupFldElt": "ModTupRngElt Mtrx",
    "RngIntResElt": "RngElt", "RngIntRes": "Rng Str",
    "GrpPermElt": "", "GrpPerm": "Str",
    "BoolElt": "", "MonStgElt": "", "Tup": "", "List": "", "Rec": "", "Cat": "", "RecFrmt": "",
    "SeqEnum": "Str", "SetEnum": "Str", "SetIndx": "Str", "SetMulti": "Str", "Map": "Str",
    "RngInt": "Rng Str", "FldRat": "Fld Rng Str", "FldRe": "Fld Rng Str", "FldFin": "Fld Rng Str",
    "FldNum": "FldAlg Fld Rng Str", "FldQuad": "FldNum FldAlg Fld Rng Str", "FldFunRat": "Fld Rng Str",
    "RngOrd": "Rng Str", "RngQuad": "RngOrd Rng Str", "RngUPol": "Rng Str",
}.items()}
# (every type the table names: ISA of another is not known here)
_ISA_KNOWN = frozenset(_ISA_UP) | frozenset().union(*_ISA_UP.values()) | {"Any"}


def _isa(t, s):
    return s == "Any" or t == s or s in _ISA_UP.get(t, ())


def ISA(t, s):
    """Whether the type t is also the type s (ISA(FldQuadElt, FldNumElt))."""
    if not isinstance(t, _Cat) or not isinstance(s, _Cat):
        raise _bad_types("ISA", [t, s])
    if t not in _ISA_UP or s not in _ISA_KNOWN:
        raise MagmaError("ISA(%s, %s) is not supported yet" % (t, s), "'ISA'")
    return _isa(t, s)


# name -> [(types, implementation or None, result type)], in registration
# order; None: a signature Magma has that Sagebrush doesn't implement yet
_SIGNATURES = {}


def _signature(name, *types, ret="Any"):
    """Registers the decorated function as name's implementation for
    arguments of these Magma types (each type or one it ISA)."""
    for t in types:
        assert t in _ISA_KNOWN, t

    def register(f):
        _SIGNATURES.setdefault(name, []).append((types, f, ret))
        return f
    return register


def _unimplemented_signature(name, *types, ret="Any"):
    """A signature of Magma's that Sagebrush doesn't implement yet: such
    arguments are refused in words, not with Bad argument types."""
    _SIGNATURES.setdefault(name, []).append((types, None, ret))


def _dispatch_type(x):
    return _type_name(x) or _type(x)


def _dispatcher(name):
    sigs = _SIGNATURES[name]

    def intrinsic(*args):
        ts = [_dispatch_type(a) for a in args]
        fits = [s for s in sigs if len(s[0]) == len(ts) and all(_isa(t, u) for t, u in zip(ts, s[0]))]
        if not fits:
            if any(t not in _ISA_UP for t in ts):
                # (a value whose type the table doesn't know: its
                # signatures may exist in Magma, so not Bad argument types)
                raise MagmaError("%s with these arguments is not supported yet" % name, "'%s'" % name)
            # (at the call's "(", as Magma points)
            raise _bad_types(name, args, _call_pos(name))
        # (the most specific: each of its types ISA those of every other fit)
        best = [s for s in fits if all(all(_isa(a, b) for a, b in zip(s[0], o[0])) for o in fits)]
        if len(best) != 1:
            raise MagmaError("%s: more than one signature fits %s" % (name, ", ".join(ts)), "'%s'" % name)
        f = best[0][1]
        if f is None:
            raise MagmaError("%s of a %s is not supported yet" % (name, ", ".join(ts)), "'%s'" % name)
        return f(*args)

    intrinsic.__name__ = name
    intrinsic.__qualname__ = name
    intrinsic._magma_signatures = sigs
    return intrinsic


# ------------------------------------------------------------------ one-variable rational function fields

# R0a's public admission limits.  These are deliberately repeated here,
# beside every allocation site they govern, rather than being implicit in
# the (larger) limits of the polynomial implementations underneath.
_FUN_WORK_MAX = 1 << 26
_FUN_LIVE_MAX = 16 << 20
_FUN_INPUT_COEFFS_MAX = 32768
_FUN_Q_INPUT_DEG = 512
_FUN_Q_RESULT_DEG = 1024
_FUN_FP_INPUT_DEG = 2048
_FUN_FP_RESULT_DEG = 4096
_FUN_EXP_MAX = 4096
_FUN_PF_FACTORS_MAX = 1024
_FUN_PF_TERMS_MAX = 4096
_FUN_Q_COEFF_BITS = 1 << 16
_FUN_Q_TOTAL_BITS = 1 << 23


class _FunBudget:
    """One non-resetting R0a work/live ledger for a public operation."""

    __slots__ = ("work", "live")

    def __init__(self):
        self.work = 0
        self.live = 0

    def charge(self, work=0, live=0, what="operation"):
        work, live = int(work), int(live)
        if work < 0 or live < 0 or self.work + work > _FUN_WORK_MAX or self.live + live > _FUN_LIVE_MAX:
            raise MagmaError("%s exceeds the rational-function R0a work or memory limit" % what,
                             "'FunctionField'", True)
        self.work += work
        self.live += live


def _fun_coeff_bits(c):
    """Allocation-free coefficient size used by R0a admission."""
    if _is_ff(c):
        return 1
    try:
        q = _Fraction(c)
        return max(1, abs(int(q.numerator)).bit_length(), int(q.denominator).bit_length())
    except (TypeError, ValueError, AttributeError):
        return 1


def _fun_scalar_cost(F, bits):
    """The approved scalar-cost model C_Q(B) or C_{p,1}."""
    if F._char == 0:
        return (1 + (max(1, int(bits)) + 29) // 30) ** 2
    return 2 * (1 + (max(1, int(F._char).bit_length()) + 29) // 30) ** 2


def _fun_check_output_bits(F, degree, bits, what):
    """Refuse a conservative Q result envelope before its allocation."""
    if F._char != 0:
        return
    degree, bits = max(0, int(degree)), max(1, int(bits))
    if bits > _FUN_Q_COEFF_BITS or 2 * (degree + 1) * bits > _FUN_Q_TOTAL_BITS:
        raise MagmaError("%s has a rational coefficient envelope beyond the R0a bit limit" % what,
                         "'FunctionField'", True)


def _fun_mul_envelope(d1, b1, d2, b2):
    """The allocation-free product envelope M from the approved plan."""
    m = 1 + min(max(0, d1), max(0, d2))
    return max(0, d1) + max(0, d2), max(1, b1) + max(1, b2) + (m - 1).bit_length() + 2


def _fun_norm_bits(degree, bits):
    """Conservative cleared/subresultant normalization coefficient bound."""
    degree, bits = max(0, int(degree)), max(1, int(bits))
    return (degree + 1) * (bits + (degree + 1).bit_length() + 3)


def _fun_poly_meta(p):
    # Every polynomial admitted by R0a is one of the two dense Sagebrush
    # polynomial implementations and exposes its already-normalized backing
    # coefficients.  Inspect that storage directly: calling list() here
    # would allocate a second, unadmitted dense copy merely to measure it.
    cs = getattr(p, "_c", ())
    if not cs:
        return -1, 1, 1, 1
    return int(p.degree()), len(cs), max(_fun_coeff_bits(c) for c in cs), sum(_fun_coeff_bits(c) for c in cs)


def _fun_presentation_meta(F, v):
    """Closed envelope for the two public numerator/denominator polynomials."""
    dn, _, bn, tn = _fun_poly_meta(v.numerator())
    dd, _, bd, td = _fun_poly_meta(v.denominator())
    B = max(bn, bd)
    if F._ground is _ZZ:
        # Clearing all coefficient denominators uses an lcm whose bit length
        # is at most their summed bit lengths; multiplication adds B bits.
        B += tn + td + 1
    return max(0, dn, dd), B


def _fun_poly_live(degree, bits):
    """Reviewed live reservation for one dense polynomial and its copies."""
    n = max(1, int(degree) + 1)
    total = n * max(1, int(bits))
    return 4 * (64 * n + (total + 7) // 8)


def _fun_preflight_result(F, degree, bits, budget, what, work=0, copies=1, extra_live=0):
    """Admit a closed result envelope before arithmetic materializes it."""
    degree, bits = max(0, int(degree)), max(1, int(bits))
    cap = _FUN_Q_RESULT_DEG if F._char == 0 else _FUN_FP_RESULT_DEG
    if degree > cap:
        raise MagmaError("%s x-degree envelope %d exceeds the R0a limit of %d" % (what, degree, cap),
                         "'FunctionField'", True)
    _fun_check_output_bits(F, degree, bits, what)
    # A normalized fraction has two dense polynomials.  ``copies`` covers
    # simultaneous old/new derivative states or another proved transient.
    live = int(copies) * 2 * _fun_poly_live(degree, bits) + int(extra_live)
    budget.charge(work=work, live=live, what=what)


def _fun_admit_poly(F, p, result, budget, what, charge_live=True):
    d, n, b, total = _fun_poly_meta(p)
    cap = (_FUN_Q_RESULT_DEG if result else _FUN_Q_INPUT_DEG) if F._char == 0 else (
        _FUN_FP_RESULT_DEG if result else _FUN_FP_INPUT_DEG)
    if d > cap:
        raise MagmaError("%s of x-degree %d exceeds the rational-function R0a limit of %d" % (what, d, cap),
                         "'FunctionField'", True)
    if n > _FUN_INPUT_COEFFS_MAX:
        raise MagmaError("%s has more than %d dense coefficients" % (what, _FUN_INPUT_COEFFS_MAX),
                         "'FunctionField'", True)
    if F._char == 0 and (b > _FUN_Q_COEFF_BITS or total > _FUN_Q_TOTAL_BITS):
        raise MagmaError("%s has rational coefficients beyond the R0a bit limit" % what,
                         "'FunctionField'", True)
    # Four copies cover the input/output polynomial, normalization work and
    # reply conversion.  This is intentionally pessimistic.
    if charge_live:
        budget.charge(live=4 * (64 * n + (total + 7) // 8), what=what)
    return max(0, d), n, b


def _fun_admit_fraction(F, v, result, budget, what, normalize=True, charge_live=True):
    dn, nn, bn = _fun_admit_poly(F, v.numerator(), result, budget, what + " numerator", charge_live)
    dd, nd, bd = _fun_admit_poly(F, v.denominator(), result, budget, what + " denominator", charge_live)
    D = max(dn, dd)
    if nn + nd > _FUN_INPUT_COEFFS_MAX:
        raise MagmaError("%s has more than %d dense coefficients" % (what, _FUN_INPUT_COEFFS_MAX),
                         "'FunctionField'", True)
    if normalize:
        B = max(1, bn, bd)
        budget.charge(work=8 * (D + 1) ** 3 * _fun_scalar_cost(F, B), what=what + " normalization")
    return D


def _fun_base_key(k):
    if k is _QQ:
        return ("Q",)
    if k is _ZZ:
        return ("Z",)
    if isinstance(k, _MFinField) and k.n == 1:
        return ("Fp", k.p)
    return None


# A 64-entry/4 MiB strong LRU plus weak live identity registry.  Eviction
# drops only the derived strong retention: a live alias still resolves to
# the same canonical parent and mutable generator name.
import weakref as _weakref
_FUN_LIVE = _weakref.WeakValueDictionary()
_FUN_CACHE = {}
_FUN_LRU = []
_FUN_CACHE_BYTES_MAX = 4 << 20
_FUN_CACHE_ENTRY_BYTES = 1 << 16  # reviewed reservation for one R0a parent
_FUN_CACHE_COUNT = min(64, _FUN_CACHE_BYTES_MAX // _FUN_CACHE_ENTRY_BYTES)
_FUN_POLY_BY_BASE = _weakref.WeakValueDictionary()
_FUN_POLY_LRU = []


def _fun_remember_poly(key, ring):
    """Remember at most 64 source presentations, without retaining values."""
    _FUN_POLY_LRU[:] = [k for k in _FUN_POLY_LRU if k in _FUN_POLY_BY_BASE and k != key]
    while len(_FUN_POLY_LRU) >= _FUN_CACHE_COUNT:
        _FUN_POLY_BY_BASE.pop(_FUN_POLY_LRU.pop(0), None)
    _FUN_POLY_BY_BASE[key] = ring
    _FUN_POLY_LRU.append(key)


def _fun_cache_get(key):
    F = _FUN_LIVE.get(key)
    if F is not None:
        # A live identity may have outlived its strong-LRU slot.  Re-retain
        # it through the same bounded insertion path, including eviction.
        _fun_cache_put(key, F)
    return F


def _fun_cache_put(key, F):
    # Commit only after F is complete.  A failure before here publishes no
    # parent, cache entry or generator-name mutation.
    while key not in _FUN_CACHE and len(_FUN_CACHE) >= _FUN_CACHE_COUNT:
        old = _FUN_LRU.pop(0)
        _FUN_CACHE.pop(old, None)
    _FUN_LIVE[key] = F
    _FUN_CACHE[key] = F
    if key in _FUN_LRU:
        _FUN_LRU.remove(key)
    _FUN_LRU.append(key)


class _MFunRat:
    """Magma's FldFunRat presentation over Q, Z, or an admitted GF(p)."""

    def __init__(self, ground, source=None):
        self._ground = ground
        self._char = ground.p if isinstance(ground, _MFinField) else 0
        self._name = "$.1"
        if ground is _ZZ:
            self._backend_ring = _sp.PolynomialRing_(_sp.QQ, self._name)
            self._integer_ring = source or _sp.PolynomialRing_(_sp.ZZ, "$.1")
        elif ground is _QQ:
            self._backend_ring = _sp.PolynomialRing_(_sp.QQ, self._name)
            self._integer_ring = source or _sp.PolynomialRing_(_sp.QQ, "$.1")
        else:
            self._backend_ring = _sff.PolynomialRing_ff(ground.K, self._name)
            self._integer_ring = source or _MFFPolyRing(ground)
        self._frac = _sfrac.FractionField_(self._backend_ring)

    def __repr__(self):
        base = "Integer Ring" if self._ground is _ZZ else "Rational Field" if self._ground is _QQ else _gf_name(self._ground)
        return "Univariate rational function field over %s\nVariables: %s" % (base, self._name)

    def _magma_names(self, names):
        if len(names) != 1:
            raise _arg_error("AssignNames", "Argument 2 must have length 1")
        name = str(names[0])
        # The private arithmetic ring, never the public source ring, follows
        # the field generator.  Commit both only after validation.
        self._name = name
        self._backend_ring._name = name

    def _magma_gen(self, i):
        if i != 1:
            raise MagmaError("Value for name index (%d) should be in the range [1..1]" % i, "'.'", True)
        budget = _FunBudget()
        _fun_preflight_result(self, 1, 1, budget, "generator result")
        return self._wrap(self._frac.gen(), budget, "generator", normalize=False, prepaid=True)

    def _magma_eq(self, o, op):
        if isinstance(o, _MFunRat):
            return self is o
        raise _bad_types(op, (self, o))

    def _magma_coerce(self, x):
        budget = _FunBudget()
        try:
            return self._wrap(self._coerce_value(x, budget), budget,
                              "coercion", normalize=False, prepaid=True)
        except ZeroDivisionError:
            raise MagmaError("Division by zero", "'!'", False)
        except MagmaError:
            raise
        except (TypeError, ValueError, ArithmeticError):
            raise MagmaError("Illegal coercion", "'!'", False)

    def _coerce_poly(self, x, budget):
        if isinstance(x, _sp.Polynomial):
            _fun_admit_poly(self, x, False, budget, "coercion source polynomial")
            return self._backend_ring(x._c)
        if isinstance(x, _MFFPoly) and isinstance(self._ground, _MFinField) and x.R.F is self._ground:
            _fun_admit_poly(self, x.p, False, budget, "coercion source polynomial")
            return self._backend_ring(x.p._c)
        if hasattr(x, "parent") and x.parent() is self._backend_ring:
            return x
        return None

    def _coerce_value(self, x, budget):
        if isinstance(x, _MFunRatElt):
            if x.F is not self:
                raise MagmaError("Arguments are not compatible", "'!'", True)
            return x.v
        if isinstance(x, (MSeq, MRange)):
            if len(x) > _FUN_INPUT_COEFFS_MAX:
                raise MagmaError("coercion sequence has more than %d entries" % _FUN_INPUT_COEFFS_MAX,
                                 "'!'", True)
            if isinstance(x, MRange):
                # Reserve the dense conversion before making it.  An MSeq is
                # already dense and can be inspected without a second copy.
                budget.charge(live=64 * len(x), what="coercion sequence")
                a = list(x)
            else:
                a = x
            if len(a) == 2:
                n = self._coerce_value(a[0], budget)
                d = self._coerce_value(a[1], budget)
                if not d:
                    raise ZeroDivisionError("division by zero")
                Dn = _fun_admit_fraction(self, n, False, budget, "coercion numerator", normalize=False)
                Dd = _fun_admit_fraction(self, d, False, budget, "coercion denominator", normalize=False)
                Bn = max(_fun_poly_meta(n.numerator())[2], _fun_poly_meta(n.denominator())[2])
                Bd = max(_fun_poly_meta(d.numerator())[2], _fun_poly_meta(d.denominator())[2])
                Dout, Bout = _fun_mul_envelope(Dn, Bn, Dd, Bd)
                Bout = _fun_norm_bits(Dout, Bout)
                work = 8 * (Dout + 1) ** 3 * _fun_scalar_cost(self, Bout)
                _fun_preflight_result(self, Dout, Bout, budget, "coercion result", work=work)
                return n / d
            # First pass validates and sizes without building the converted
            # coefficient vector or backend polynomial.  Their entire live
            # envelope is charged before the second pass materializes them.
            B, total = 1, 0
            for c in a:
                if isinstance(c, bool) or isinstance(c, (_sp.Polynomial, _MFFPoly, _MFunRatElt)):
                    raise MagmaError("Illegal coercion", "'!'", False)
                self._constant(c)  # validate one scalar; do not retain it
                cb = _fun_coeff_bits(c)
                B, total = max(B, cb), total + cb
            D = max(0, len(a) - 1)
            cap = _FUN_Q_INPUT_DEG if self._char == 0 else _FUN_FP_INPUT_DEG
            if D > cap:
                raise MagmaError("coercion polynomial of x-degree %d exceeds the rational-function R0a limit of %d" % (D, cap),
                                 "'FunctionField'", True)
            if self._char == 0 and (B > _FUN_Q_COEFF_BITS or total > _FUN_Q_TOTAL_BITS):
                raise MagmaError("coercion polynomial has rational coefficients beyond the R0a bit limit",
                                 "'FunctionField'", True)
            # A dense coefficient sequence becomes a polynomial over 1; no
            # gcd/content normalization can grow its coefficients.
            Bout = B
            work = 8 * (D + 1) ** 3 * _fun_scalar_cost(self, B)
            _fun_preflight_result(self, D, Bout, budget, "coercion result", work=work,
                                  extra_live=64 * len(a))
            cs = [self._constant(c) for c in a]
            p = self._backend_ring(cs)
            _fun_admit_poly(self, p, False, budget, "coercion polynomial", charge_live=False)
            return self._frac(p)
        p = self._coerce_poly(x, budget)
        if p is not None:
            D, _, B = _fun_admit_poly(self, p, False, budget, "coercion polynomial")
            work = 8 * (D + 1) ** 3 * _fun_scalar_cost(self, B)
            _fun_preflight_result(self, D, B, budget,
                                  "coercion result", work=work)
            return self._frac(p)
        if isinstance(x, bool):
            raise MagmaError("Illegal coercion", "'!'", False)
        B = _fun_coeff_bits(x)
        if self._char == 0 and B > _FUN_Q_COEFF_BITS:
            raise MagmaError("coercion constant has rational coefficients beyond the R0a bit limit",
                             "'FunctionField'", True)
        work = 8 * _fun_scalar_cost(self, B)
        _fun_preflight_result(self, 0, B, budget,
                              "coercion result", work=work)
        p = self._backend_ring([self._constant(x)])
        _fun_admit_poly(self, p, False, budget, "coercion constant", charge_live=False)
        return self._frac(p)

    def _constant(self, x):
        if self._ground is _QQ or self._ground is _ZZ:
            if _is_ff(x) or isinstance(x, (_MFinField, MReal, str)):
                raise TypeError("not a rational constant")
            return _Rational(x)
        return self._ground._magma_coerce(x)

    def _wrap(self, v, budget, what="result", normalize=True, prepaid=False):
        if not isinstance(v, _sfrac.FractionFieldElement):
            v = self._frac(v)
        _fun_admit_fraction(self, v, True, budget, what, normalize, charge_live=not prepaid)
        return _MFunRatElt(self, v)

    def _display(self, v):
        """Print Z-ground values using Magma's integral presentation."""
        if self._ground is not _ZZ:
            return repr(v)
        budget = _FunBudget()
        D, B = _fun_presentation_meta(self, v)
        _fun_preflight_result(self, D, B, budget, "printed integral presentation")
        n, d = self._parts(v)
        # Re-home only the presentation coefficients in the private ring so
        # the live field name is used without renaming the source Z[u].
        n = self._backend_ring(n._c)
        d = self._backend_ring(d._c)
        if d == 1:
            return repr(n)
        ns, ds = repr(n), repr(d)
        if "+" in ns[1:] or "-" in ns[1:]:
            ns = "(" + ns + ")"
        if any(c in ds[1:] for c in "+-*/"):
            ds = "(" + ds + ")"
        return ns + "/" + ds

    def _poly_out(self, p):
        if self._ground is _ZZ:
            return self._integer_ring([int(_Fraction(c)) for c in p.list()])
        if self._ground is _QQ:
            return self._integer_ring(p.list())
        return _MFFPoly(self._integer_ring, self._integer_ring.P(p.list()))

    def _parts(self, v):
        n, d = v.numerator(), v.denominator()
        if self._ground is not _ZZ:
            return self._poly_out(n), self._poly_out(d)
        qs = [_Fraction(c) for c in n.list()] + [_Fraction(c) for c in d.list()]
        L = 1
        for q in qs:
            L = L * int(q.denominator) // _math.gcd(L, int(q.denominator))
        ni = self._integer_ring([int(_Fraction(c) * L) for c in n.list()])
        di = self._integer_ring([int(_Fraction(c) * L) for c in d.list()])
        return ni, di


class _MFunRatElt:
    __slots__ = ("F", "v")

    def __init__(self, F, v):
        self.F, self.v = F, v

    def __repr__(self):
        return self.F._display(self.v)

    __str__ = __repr__

    def _magma_parent(self):
        return self.F

    def __bool__(self):
        return bool(self.v)

    def __neg__(self):
        return _fun_unary("-", self)

    def __add__(self, o):
        return _fun_binary("+", self, o)

    __radd__ = __add__

    def __sub__(self, o):
        return _fun_binary("-", self, o)

    def __rsub__(self, o):
        return _fun_binary("-", o, self)

    def __mul__(self, o):
        return _fun_binary("*", self, o)

    __rmul__ = __mul__

    def __truediv__(self, o):
        return _fun_binary("/", self, o)

    def __rtruediv__(self, o):
        return _fun_binary("/", o, self)

    def __pow__(self, n):
        return _fun_power(self, n)

    def __eq__(self, o):
        try:
            return _fun_equal(self, o)
        except MagmaError:
            return False


def _fun_parent_from(a, b=None):
    fs = [x.F for x in (a, b) if isinstance(x, _MFunRatElt)]
    if not fs:
        return None
    if any(F is not fs[0] for F in fs[1:]):
        raise MagmaError("Arguments are not compatible", "'+'", True)
    return fs[0]


def _fun_binary(op, a, b, pos=None, budget=None):
    F = _fun_parent_from(a, b)
    if F is None:
        return None
    budget = budget or _FunBudget()
    try:
        av, bv = F._coerce_value(a, budget), F._coerce_value(b, budget)
        Da = _fun_admit_fraction(F, av, False, budget, "left operand", normalize=False)
        Db = _fun_admit_fraction(F, bv, False, budget, "right operand", normalize=False)
        Ba = max(_fun_poly_meta(av.numerator())[2], _fun_poly_meta(av.denominator())[2])
        Bb = max(_fun_poly_meta(bv.numerator())[2], _fun_poly_meta(bv.denominator())[2])
        Dout, Bout = _fun_mul_envelope(Da, Ba, Db, Bb)
        if op in ("+", "-"):
            Bout += 1
        Bout = _fun_norm_bits(Dout, Bout)
        work = 8 * (Dout + 1) ** 3 * _fun_scalar_cost(F, Bout)
        _fun_preflight_result(F, Dout, Bout, budget,
                              "rational-function %s result" % op, work=work)
        if op == "+":
            v = av + bv
        elif op == "-":
            v = av - bv
        elif op == "*":
            v = av * bv
        else:
            if not bv:
                raise MagmaError("Division by zero", "'/'", True, pos)
            v = av / bv
        return F._wrap(v, budget, "result", normalize=False, prepaid=True)
    except ZeroDivisionError:
        raise MagmaError("Division by zero", "'%s'" % op, True, pos)
    except MagmaError:
        raise
    except (TypeError, ValueError, ArithmeticError):
        raise _bad_types(op, (a, b), pos)


def _fun_unary(op, a, pos=None):
    budget = _FunBudget()
    D = _fun_admit_fraction(a.F, a.v, False, budget, "operand", normalize=False)
    B = max(_fun_poly_meta(a.v.numerator())[2], _fun_poly_meta(a.v.denominator())[2])
    _fun_preflight_result(a.F, D, B, budget, "unary result")
    return a.F._wrap(-a.v, budget, "result", normalize=False, prepaid=True)


def _fun_power(a, n, pos=None):
    if not isinstance(n, int) or isinstance(n, bool):
        raise _bad_types("^", (a, n), pos)
    if abs(n) > _FUN_EXP_MAX:
        raise MagmaError("Argument 2 (%d) exceeds the rational-function exponent limit of %d" % (n, _FUN_EXP_MAX), "'^'", True, pos)
    budget = _FunBudget()
    D = _fun_admit_fraction(a.F, a.v, False, budget, "power operand", normalize=False)
    B = max(_fun_poly_meta(a.v.numerator())[2], _fun_poly_meta(a.v.denominator())[2])
    Dout = D * abs(n)
    Bout = 1 if n == 0 else abs(n) * B + max(0, abs(n) - 1) * ((D + 1).bit_length() + 2)
    steps = max(1, abs(n).bit_length() + bin(abs(n)).count("1") - 1)
    work = steps * 8 * (Dout + 1) ** 2 * _fun_scalar_cost(a.F, Bout)
    _fun_preflight_result(a.F, Dout, Bout, budget, "power result", work=work)
    try:
        return a.F._wrap(a.v ** n, budget, "power result", normalize=False, prepaid=True)
    except ZeroDivisionError:
        raise MagmaError("Division by zero", "'^'", True, pos)


def _fun_equal(a, b, pos=None):
    F = _fun_parent_from(a, b)
    if F is None:
        return False
    budget = _FunBudget()
    try:
        av, bv = F._coerce_value(a, budget), F._coerce_value(b, budget)
    except (TypeError, ValueError, ArithmeticError):
        raise _bad_types("eq", (a, b), pos)
    Da = _fun_admit_fraction(F, av, False, budget, "left operand", normalize=False)
    Db = _fun_admit_fraction(F, bv, False, budget, "right operand", normalize=False)
    budget.charge(work=2 * (Da + 1) * (Db + 1), what="rational-function comparison")
    return av == bv


def _fun_field(ground, source=None, name="FunctionField"):
    key = _fun_base_key(ground)
    if key is None:
        if isinstance(ground, _MFinField):
            raise MagmaError("%s over a non-prime finite field waits for R0b" % name, "'%s'" % name, True)
        raise MagmaError("%s of a %s is not supported yet" % (name, _type_of(ground)), "'%s'" % name, True)
    if source is None:
        source = _FUN_POLY_BY_BASE.get(key)
    F = _fun_cache_get(key)
    if F is None:
        F = _MFunRat(ground, source)
        _fun_cache_put(key, F)
    elif source is not None:
        # A source-ring presentation affects IntegerRing/Numerator but never
        # the private arithmetic variable or the source ring's own name.
        F._integer_ring = source
    return F


def FunctionField(k, n=None):
    if n is not None:
        raise MagmaError("FunctionField in more than one variable waits for the separate RM stage", "'FunctionField'", True)
    return _fun_field(k, name="FunctionField")


def RationalFunctionField(k, n=None):
    if n is not None:
        raise MagmaError("RationalFunctionField in more than one variable waits for the separate RM stage", "'RationalFunctionField'", True)
    return _fun_field(k, name="RationalFunctionField")


def FieldOfFractions(R):
    if isinstance(R, _sp.PolynomialRing_):
        k = _ZZ if R.base_ring() is _sp.ZZ else _QQ if R.base_ring() is _sp.QQ else None
    elif isinstance(R, _MFFPolyRing):
        k = R.F
    else:
        k = None
    if k is None:
        raise MagmaError("FieldOfFractions of a %s is not supported yet" % _type_of(R), "'FieldOfFractions'", True)
    return _fun_field(k, R, "FieldOfFractions")


FractionField = FieldOfFractions


# ------------------------------------------------------------------ polynomials

def PolynomialRing(R, n=1):
    """A new polynomial ring; its variable prints as $.1 until named."""
    # (one variable only: PolynomialRing(Q, 3) is not a univariate ring)
    if n != 1 or isinstance(n, bool):
        raise MagmaError("PolynomialRing in more than one variable (or with weights) is not supported yet", "'PolynomialRing'")
    if isinstance(R, _MFinField):
        out = _ffpoly_ring(R)
        key = _fun_base_key(R)
        if key is not None:
            _fun_remember_poly(key, out)
        return out
    base = _sp.ZZ if R is _ZZ else _sp.QQ if R is _QQ else None
    if base is None:
        raise MagmaError("PolynomialRing over a %s (not the integers, the rationals or a finite field) is not supported yet" % _type_of(R), "'PolynomialRing'")
    out = _sp.PolynomialRing_(base, "$.1")
    _fun_remember_poly(_fun_base_key(R), out)
    return out


# The procedure call being made with reference arguments (f(~x, y)), as the
# translator emits it: (the callee, the positions passed by reference),
# for the procedures that check them (AssignNames).
_REFCALL = [None]


def _refcall(f, refs, *args, **kw):
    """f(*args) called as a procedure statement, the arguments at refs by
    reference."""
    old = _REFCALL[0]
    _REFCALL[0] = (f, tuple(refs))
    try:
        return f(*args, **kw)
    finally:
        _REFCALL[0] = old


def _assign_gen_names(R, names):
    """R<x, ...> := ...: the generators' names (a list of strings)."""
    if isinstance(R, _sp.PolynomialRing_) and names:
        R._name = names[0]
    elif hasattr(R, "_magma_names"):
        R._magma_names(names)
    return R


def AssignNames(*args):
    """AssignNames(~R, names): a procedure, R by reference (checked as the
    call is made, whatever the procedure's name there, before any effect:
    called as a function, or with another argument by reference, it is
    Magma's Bad argument types); over a finite field one name, a string.
    Checked against Magma 2.18."""
    rc = _REFCALL[0]
    me = globals().get("AssignNames")
    refs = rc[1] if rc is not None and rc[0] is me else ()
    bad = lambda: MagmaError("Bad argument types\nArgument types given: " + ", ".join(
        _ext_type(a) + (" ~" if k in refs else "") for k, a in enumerate(args)), "'AssignNames'", True)
    if refs != (0,) or len(args) != 2:
        raise bad()
    R, names = args
    if isinstance(R, _MFFPolyRing):
        # (a sequence of strings, then of one: [1, 2] is Bad argument types,
        # ["t", "u"] and [] "must have length 1", as Magma's)
        if not isinstance(names, MSeq) or any(not isinstance(c, str) or isinstance(c, _Cat) for c in names):
            raise bad()
        if len(names) != 1:
            raise _arg_error("AssignNames", "Argument 2 must have length 1")
        return _assign_gen_names(R, [names[0]])
    return _assign_gen_names(R, names)


def _poly_parts(f):
    return f


def Degree(f):
    if isinstance(f, _MFunRatElt):
        if not f.v:
            return -1
        return max(f.v.numerator().degree(), f.v.denominator().degree())
    if isinstance(f, _sp.Polynomial):
        return f.degree()
    if hasattr(f, "_magma_degree"):
        return f._magma_degree()
    raise MagmaError("Degree: bad argument")


def _nonzero_poly(name, f):
    if isinstance(f, _sp.Polynomial) and f.is_zero():
        raise _arg_error(name, "Argument 1 is not non-zero")


def Coefficients(f):
    if _cyc_elt(f):
        raise _bad_types("Coefficients", (f,))
    if isinstance(f, _MFFPoly):
        return MSeq(f.p._c)
    # (the zero polynomial's are [], as Magma's)
    return MSeq(_m_num(c) for c in ([] if f.is_zero() else f.list()))


def Coefficient(f, i):
    if i < 0:
        raise _arg_error("Coefficient", "Argument 2 (%d) should be >= 0" % i)
    if isinstance(f, _MFFPoly):
        return f.p._c[i] if i < len(f.p._c) else f.R.F.K(0)
    l = f.list()
    return _m_num(l[i]) if i < len(l) else 0


def LeadingCoefficient(f):
    if isinstance(f, _MFFPoly):
        if not f.p._c:
            raise _arg_error("LeadingCoefficient", "Argument 1 is not non-zero")
        return f.p._c[-1]
    _nonzero_poly("LeadingCoefficient", f)
    return _m_num(f.leading_coefficient()) if isinstance(f, _sp.Polynomial) else f


def Evaluate(f, x):
    if isinstance(f, _MFunRatElt):
        budget = _FunBudget()
        D = _fun_admit_fraction(f.F, f.v, False, budget, "evaluation input", normalize=False)
        B = max(_fun_poly_meta(f.v.numerator())[2], _fun_poly_meta(f.v.denominator())[2])
        try:
            xv = f.F._coerce_value(x, budget)
            Dx = _fun_admit_fraction(f.F, xv, False, budget, "evaluation argument", normalize=False)
            Bx = max(_fun_poly_meta(xv.numerator())[2], _fun_poly_meta(xv.denominator())[2])
            structured = isinstance(x, (_MFunRatElt, _sp.Polynomial, _MFFPoly))
            Dout = D * Dx if structured else 0
            Bout = (D + 1) * (B + Bx + (Dout + 1).bit_length() + 3)
            work = 8 * (D + 1) * (Dx + 1) ** 2 * _fun_scalar_cost(f.F, Bout)
            if structured:
                _fun_preflight_result(f.F, Dout, Bout, budget, "evaluation result", work=work)
            else:
                budget.charge(work=work, what="rational-function evaluation")
            y = f.v(xv if structured else x)
            return f.F._wrap(y, budget, "evaluation result", normalize=False, prepaid=True) if structured else y
        except ZeroDivisionError:
            raise MagmaError("Evaluated denominator is not invertible", "'Evaluate'", True)
    if isinstance(f, _MFFPoly):
        return _ffp_eval(f, x, "'Evaluate'")
    return f(x)


def Derivative(f, k=1):
    """The k-th derivative of a polynomial (the first by default)."""
    if not isinstance(k, int) or isinstance(k, bool):
        raise _bad_types("Derivative", [f, k])
    if k < 0:
        raise _arg_error("Derivative", "Argument 2 (%d) should be >= 0" % k)
    if isinstance(f, _MFunRatElt):
        budget = _FunBudget()
        v = f.v
        D = _fun_admit_fraction(f.F, v, False, budget, "derivative input", normalize=False)
        B = max(_fun_poly_meta(v.numerator())[2], _fun_poly_meta(v.denominator())[2])
        if k > D and v.denominator().degree() <= 0:
            _fun_preflight_result(f.F, 0, 1, budget, "derivative result")
            return f.F._wrap(f.F._frac(0), budget, "derivative result", normalize=False, prepaid=True)
        Dout = D if v.denominator().degree() <= 0 else (k + 1) * D
        Bout = B + k * (B + (Dout + 1).bit_length() + 3)
        work = max(1, k) * 8 * (Dout + 1) ** 2 * _fun_scalar_cost(f.F, Bout)
        _fun_preflight_result(f.F, Dout, Bout, budget, "derivative result",
                              work=work, copies=2)
        for _ in range(k):
            v = v.derivative()
        return f.F._wrap(v, budget, "derivative result", normalize=False, prepaid=True)
    if isinstance(f, _MFFPoly):
        return _ffp_derivative(f, k)
    for _ in range(k):
        if f.is_zero():
            break  # (the rest are 0 too: a huge k costs the degree)
        f = f.derivative()
    return f


def Discriminant(f):
    if hasattr(f, "_magma_discriminant"):
        return f._magma_discriminant()
    if isinstance(f, _sp.Polynomial) and f.degree() < 1:
        raise _arg_error("Discriminant", "Degree of argument is less than 1")
    return _m_num(f.discriminant())


def Resultant(f, g):
    return f.resultant(g)


def IsIrreducible(f):
    if isinstance(f, _MFFPoly):
        return _ffp_is_irreducible(f)
    _nonzero_poly("IsIrreducible", f)
    if isinstance(f, _sp.Polynomial) and f.degree() < 1:
        return False  # (a constant polynomial is not, as Magma has it)
    return f.is_irreducible()


def _m_num(c):
    if isinstance(c, _Fraction) and c.denominator == 1:
        return int(c)
    return c


def Roots(f, R=None):
    if isinstance(f, _MFFPoly):
        return _ffp_roots(f, R)
    if not isinstance(f, _sp.Polynomial):
        raise MagmaError("Roots: bad argument")
    _nonzero_poly("Roots", f)
    # (in the coefficient ring, or in R: the integers or the rationals;
    # roots in another ring are refused, never the rational ones given)
    base = _ZZ if f._ring._base is _sp.ZZ else _QQ
    R = base if R is None else R
    if R is not _ZZ and R is not _QQ:
        raise MagmaError("Roots in a ring other than the integers or the rationals is not supported yet", "'Roots'")
    if R is _ZZ and base is _QQ and any(_Fraction(c).denominator != 1 for c in f.list()):
        raise _arg_error("Roots", "Argument 1 cannot be coerced to be over argument 2")
    if base is _ZZ and R is _QQ:
        f = _sp.PolynomialRing_(_sp.QQ, "$.1")(f.list())
    rs = [(r, m) for r, m in f.roots() if R is _QQ or _Fraction(r).denominator == 1]
    return MSeq(sorted((MTuple([_m_num(r), m]) for r, m in rs), key=lambda t: t[0]))


def _factorization(n):
    if isinstance(n, _MFFPoly):
        return _ffp_factorization(n)
    if isinstance(n, _sp.Polynomial):
        _nonzero_poly("Factorization", n)
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
    if isinstance(n, bool) or not isinstance(n, (int, _Fraction)) or not _Fraction(n).denominator == 1:
        raise _bad_types("Factorization", [n])
    if n == 0:
        raise _arg_error("Factorization", "Argument 1 is not non-zero")
    F = _sa.factor(abs(n))
    return _multi([MSeq(MTuple([p, e]) for p, e in F), 1 if n > 0 else -1], show=1)


Factorization = Factorisation = _factorization


# ------------------------------------------------------------------ polynomials over finite fields

# The work one operation on polynomials over a finite field may take, in
# products of coefficients (one over an extension field counting as
# _FFPOLY_EXT of them), admitted before it starts: a product's degrees
# multiplied, a power's result degree squared (over 2), a division's
# quotient and divisor degrees multiplied.
_FFPOLY_WORK = 10 ** 6
_FFPOLY_EXT = 8
# Factorization, Roots and IsIrreducible: through the engine's
# factorization (a prime field of p < 2^32) a degree of at most this; else
# (Python's Cantor-Zassenhaus and Rabin's test, powering x^q modulo f)
# degree^3 times the bits of q at most _FFPOLY_WORK.
_FFPOLY_FACTOR_DEG = 1000


def _gf_name(F):
    """A finite field as Magma names it inside a structure's name."""
    return "GF(%d)" % F.p if F.n == 1 else "GF(%d^%d)" % (F.p, F.n)


class _MFFPolyRing:
    """PolynomialRing(GF(q)) in Magma mode: Magma's names, printing and
    coercions over the polynomials of lib/_sage_ff.py, which do the
    arithmetic.  From Magma's documentation (Univariate Polynomial Rings)
    and checked against Magma 2.18."""

    def __init__(self, F):
        self.F = F
        self.P = _sff.PolynomialRing_ff(F.K, "x")
        self.name = None

    def _var(self):
        if self.name is not None:
            return self.name
        v = _global_name(self)
        return "%s.1" % v if v is not None else "$.1"

    def __repr__(self):
        if self.name is None:
            return "Univariate Polynomial Ring over %s" % _gf_name(self.F)
        return "Univariate Polynomial Ring in %s over %s" % (self.name, _gf_name(self.F))

    def _magma_names(self, names):
        if names:
            self.name = names[0]

    def _magma_gen(self, i):
        if i != 1:
            raise MagmaError("Value for name index (%d) should be in the range [1..1]" % i, "'.'", True)
        return _MFFPoly(self, self.P.gen())

    def _magma_card(self):
        raise MagmaError("Cardinality is infinite or not feasibly computable", "'#'", True)

    def _magma_eq(self, o, op):
        if isinstance(o, _MFFPolyRing):
            # (one ring for each field; those of two fields are not
            # compatible, as Magma says, GF(5)'s and GF(25)'s too)
            if o is self:
                return True
            raise MagmaError("Arguments are not compatible\nArgument types given: RngUPol[FldFin], RngUPol[FldFin]", "'%s'" % op, True)
        raise MagmaError("comparison of a polynomial ring over a finite field with this is not supported yet", "'%s'" % op, True)

    def _const(self, x):
        """x as an element of the coefficient field, or None: an integer,
        an element of the field or of its prime field, a rational whose
        denominator is prime to p."""
        F = self.F
        if isinstance(x, bool):
            return None
        if isinstance(x, int):
            return F.K(x)
        if isinstance(x, _Fraction):
            return None if x.denominator % F.p == 0 else F._magma_coerce(x)
        if _is_ff(x):
            Kx = _ffwrap(x.parent())
            if x.parent() is F.K:
                return x
            if Kx.n == 1 and Kx.p == F.p:
                return F.K(int(x))
        return None

    def _lift(self, x):
        """x as a polynomial of lib/_sage_ff.py over the field, or None."""
        if isinstance(x, _MFFPoly):
            return x.p if x.R is self else None
        c = self._const(x)
        return None if c is None else self.P([c])

    def _magma_contains(self, x):
        # (checked against Magma: an integer, the field's elements and the
        # ring's polynomials are in it; a rational, another field's element
        # is "Bad argument types")
        if isinstance(x, _MFFPoly):
            if x.R is self:
                return True
            raise MagmaError("membership of a polynomial of another ring is not supported yet", "'in'")
        if not isinstance(x, _Fraction) and self._const(x) is not None:
            return True
        if isinstance(x, (bool, str, MReal, _Fraction)) or _is_ff(x):
            raise MagmaError("Bad argument types", "'in'", True)
        raise MagmaError("membership of a %s in a polynomial ring over a finite field is not supported yet" % _type_of(x), "'in'")

    def _magma_coerce(self, x):
        if isinstance(x, (MSeq, MRange)):
            # R ! [c0, c1, ...]: each coefficient coerced into the field
            v = list(x)
            cs = []
            for k, c in enumerate(v):
                try:
                    cs.append(self.F._magma_coerce(c))
                except MagmaError:
                    raise MagmaError("Cannot coerce sequence element %d into the coefficient ring" % (k + 1), "'!'", True)
            return _MFFPoly(self, self.P(cs))
        if isinstance(x, _MFFPoly) and x.R is not self:
            raise MagmaError("coercion of a polynomial of another ring is not supported yet", "'!'")
        p = self._lift(x)
        if p is None:
            raise MagmaError("Illegal coercion", "'!'")
        return _MFFPoly(self, p)


def _ffpoly_ring(F):
    """PolynomialRing(F): one ring for each finite field, as Magma's (two
    calls give the identical ring, and naming its variable again renames
    it everywhere; CharacteristicPolynomial's is it too)."""
    R = getattr(F, "_polyring", None)
    if R is None:
        R = F._polyring = _MFFPolyRing(F)
    return R


def _ffp_ext(R):
    return 1 if R.F.n == 1 else _FFPOLY_EXT


def _ffp_admit(work, R, what, op):
    if work * _ffp_ext(R) > _FFPOLY_WORK:
        raise MagmaError("%s of polynomials over a finite field of more than %d coefficient products is not supported yet"
                         % (what, _FFPOLY_WORK), "'%s'" % op, True)


class _MFFPoly:
    """An element of PolynomialRing(GF(q)): Magma's printing and rules over
    a polynomial of lib/_sage_ff.py (_ffpoly_check decides what meets it)."""

    __slots__ = ("R", "p")

    def __init__(self, R, p):
        self.R, self.p = R, p

    def _magma_parent(self):
        return self.R

    def _magma_degree(self):
        return self.p.degree()

    def _magma_card(self):
        raise _bad_types("#", [self])

    def __repr__(self):
        c = self.p._c
        if not c:
            return "0"
        F, v = self.R.F, self.R._var()
        terms = []
        for i in range(len(c) - 1, -1, -1):
            if not c[i]:
                continue
            s = _ff_str(c[i])
            mon = v if i == 1 else "%s^%d" % (v, i)
            if i == 0:
                terms.append(s)
            elif s == "1":
                terms.append(mon)
            else:
                # (a coefficient that is a sum, in a large extension field:
                # in parentheses, as Magma prints it)
                terms.append(("(%s)" % s if " + " in s else s) + "*" + mon)
        return " + ".join(terms)

    def __neg__(self):
        return _MFFPoly(self.R, -self.p)

    def __eq__(self, o):
        q = self.R._lift(o)
        return q is not None and q._c == self.p._c

    def __ne__(self, o):
        return not self == o

    __hash__ = None

    def __call__(self, x):
        # (f(x) is Magma's map application: a polynomial isn't a map, for
        # any x; Evaluate(f, x) evaluates)
        raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (_ext_type(x), _ext_type(self)), "'@'", True)

    def quo_rem(self, b):
        return _ffpoly_op("div", self, b, None), _ffpoly_op("mod", self, b, None)


def _ffp_items(items):
    """The elements of a sequence holding polynomials over a finite field:
    all in their ring (integers and the field's elements coerced into it,
    as Magma's universe takes them); another ring's are refused."""
    R = next(x.R for x in items if isinstance(x, _MFFPoly))
    out = []
    for x in items:
        if x is _UNDEF or (isinstance(x, _MFFPoly) and x.R is R):
            out.append(x)
            continue
        if isinstance(x, _MFFPoly) and x.R.F.p != R.F.p:
            raise MagmaError("No valid universe containing all elements", "[ ... ]")
        if isinstance(x, _Fraction):
            # (Magma's universe of polynomials takes no rationals)
            raise MagmaError("No valid universe containing all elements", "[ ... ]")
        p = None if isinstance(x, _MFFPoly) else R._lift(x)
        if p is None:
            raise MagmaError("a sequence of polynomials over a finite field and a %s is not supported yet" % _type_of(x), "[ ... ]")
        out.append(_MFFPoly(R, p))
    return out


def _ffp_ring(a, b):
    return a.R if isinstance(a, _MFFPoly) else b.R


def _ffpoly_check(op, a, b, pos):
    """Magma's rules for a polynomial over a finite field with another value
    (in an operation), checked against Magma 2.18: nothing if they meet, else
    Magma's error, or "not supported yet" for what Magma computes but
    Sagebrush doesn't.  The same ring's polynomials, integers, the field's
    elements (and its prime field's), and rationals whose denominators are
    prime to p meet; another characteristic's polynomials are "not
    compatible", its elements and reals "Bad argument types"."""
    o = op[:-2] if op.endswith(":=") else op
    left = isinstance(a, _MFFPoly)
    x, y = (a, b) if left else (b, a)
    R, F = x.R, x.R.F
    unsupported = lambda what: MagmaError("%s is not supported yet" % what, "'%s'" % o, True, pos)
    if o == "^":
        if not left:
            # (2^x: Magma coerces 2 into the ring first, then has no power)
            if R._lift(y) is not None:
                raise MagmaError("Bad argument types\nArgument types given: RngUPolElt[FldFin], RngUPolElt[FldFin]", "'%s'" % o, True, pos)
            raise _bad_types(op, (a, b), pos)
        if _int(y):
            if y < 0:
                raise MagmaError("Argument 2 (%d) should be >= 0" % y, "'%s'" % o, True, pos)
            return
        if isinstance(y, _Fraction):
            # (Magma names the exponent a polynomial: it coerced it first)
            raise MagmaError("Bad argument types\nArgument types given: RngUPolElt[FldFin], RngUPolElt[FldFin]", "'%s'" % o, True, pos)
        raise _bad_types(op, (a, b), pos)
    if isinstance(y, _MFFPoly):
        if y.R is R:
            if o == "/":
                raise unsupported("dividing polynomials over a finite field (rational functions)")
            return
        if y.R.F.p != F.p:
            raise _incompatible("C", o, a, b, pos)
        raise unsupported("arithmetic of polynomials over two finite fields of one characteristic")
    if o == "/" and not left:
        raise unsupported("dividing by a polynomial over a finite field (rational functions)")
    if _int(y):
        return
    if isinstance(y, _Fraction):
        if y.denominator % F.p == 0:
            raise _bad_types(op, (a, b), pos)
        if o in ("div", "mod"):
            raise unsupported("div and mod of a polynomial over a finite field and a rational")
        return
    if _is_ff(y):
        Ky = _ffwrap(y.parent())
        if y.parent() is F.K or (Ky.n == 1 and Ky.p == F.p):
            return
        if Ky.p != F.p:
            raise _bad_types(op, (a, b), pos)
        raise unsupported("arithmetic of a polynomial over a finite field and an element of another field")
    if isinstance(y, (bool, str, MReal)):
        raise _bad_types(op, (a, b), pos)
    raise unsupported("arithmetic of a polynomial over a finite field and a %s" % _type_of(y))


def _ffpoly_op(o, a, b, pos):
    """a o b (o one of + - * / div mod ^), one of them a polynomial over a
    finite field, once _ffpoly_check has let them meet."""
    R = _ffp_ring(a, b)
    if o == "^":
        f, e = a.p, b
        if f.degree() < 1:
            return _MFFPoly(R, R.P([f._c[0] ** e]) if f._c else (R.P([R.F.K(1)]) if e == 0 else f))
        d = f.degree() * e
        if d > _COLLECT_MAX:
            raise MagmaError("a polynomial of degree more than %d is not supported yet" % _COLLECT_MAX, "'^'", True, pos)
        if not any(f._c[:-1]):
            # (a monomial c*x^k: c^e x^(k e), made directly)
            z = R.F.K(0)
            return _MFFPoly(R, R.P([z] * d + [f._c[-1] ** e]))
        _ffp_admit(d * d // 2, R, "a power", "^")
        return _MFFPoly(R, f ** e)
    f, g = R._lift(a), R._lift(b)
    if o == "+":
        return _MFFPoly(R, f + g)
    if o == "-":
        return _MFFPoly(R, f - g)
    if o == "*":
        _ffp_admit(max(f.degree(), 0) * max(g.degree(), 0), R, "a product", "*")
        return _MFFPoly(R, f * g)
    if not g._c:
        if o == "/":
            raise MagmaError("Argument 2 is not a unit", "'/'", True, pos)
        raise MagmaError("Division by zero", "'%s'" % o, True, pos)
    if o == "/":
        # (by a scalar only: _ffpoly_check refuses rational functions)
        return _MFFPoly(R, f * R.P([1 / g._c[0]]))
    _ffp_admit(max(f.degree() - g.degree() + 1, 0) * max(g.degree(), 1), R, "a division", o)
    q, r = f.quo_rem(g)
    return _MFFPoly(R, q if o == "div" else r)


def _ffpoly_eq(a, b, op, pos):
    """a eq b, one of them a polynomial over a finite field or its ring."""
    if isinstance(a, _MFFPolyRing) or isinstance(b, _MFFPolyRing):
        x, y = (a, b) if isinstance(a, _MFFPolyRing) else (b, a)
        return x._magma_eq(y, op)
    x, y = (a, b) if isinstance(a, _MFFPoly) else (b, a)
    if isinstance(y, _MFFPoly) and y.R is not x.R:
        if y.R.F.p != x.R.F.p:
            raise _incompatible("C", op, a, b, pos)
        raise MagmaError("comparison of polynomials over two finite fields of one characteristic is not supported yet", "'%s'" % op, True, pos)
    q = x.R._lift(y)
    if q is not None:
        return q._c == x.p._c
    if isinstance(y, (bool, str, MReal)) or isinstance(y, _Fraction) or _is_ff(y):
        raise _bad_types(op, (a, b), pos)
    raise MagmaError("comparison of a polynomial over a finite field with a %s is not supported yet" % _type_of(y), "'%s'" % op, True, pos)


def _ffp_eval(f, x, where):
    """Evaluate(f, x): x an integer, an element of f's field (or its prime
    field), or a polynomial of f's ring (f composed with it); a rational or
    another field's element is Magma's "Incompatible rings"."""
    R = f.R
    if isinstance(x, _MFFPoly):
        if x.R is not R:
            raise MagmaError("composition of polynomials of two polynomial rings is not supported yet", where, True)
        d = max(f.p.degree(), 0) * max(x.p.degree(), 0)
        if d > _COLLECT_MAX:
            raise MagmaError("a polynomial of degree more than %d is not supported yet" % _COLLECT_MAX, where, True)
        _ffp_admit(d * d // 2, R, "a composition", "Evaluate")
        return _MFFPoly(R, f.p(x.p))
    c = None if isinstance(x, _Fraction) else R._const(x)
    if c is None:
        if _is_ff(x) or isinstance(x, _Fraction):
            raise MagmaError("Incompatible rings", where, True)
        if isinstance(x, (bool, str, MReal)):
            raise _bad_types("Evaluate", (f, x))
        raise MagmaError("evaluating a polynomial over a finite field at a %s is not supported yet" % _type_of(x), where, True)
    return f.p(c)


def _ff_key(c):
    """Magma's order of a finite field's elements (as Factorization and
    Roots list them, checked against Magma 2.18): a prime field's as
    integers; an extension field's 0 first, then by the power of the
    generator.  None where not known (fields of more than 2^20 elements)."""
    F = _ffwrap(c.parent())
    if F.n == 1:
        return int(c)
    if not c:
        return -1
    if F.q > _FF_POWERS_MAX:
        return None
    return int(c.log(F.K.gen()))


def _ffp_sorted(items, key, what):
    keys = [key(t) for t in items]
    if len(items) > 1 and any(k is None for k in keys):
        raise MagmaError("%s over a finite field of more than %d elements is not supported yet" % (what, _FF_POWERS_MAX), "'%s'" % what)
    return [t for _, t in sorted(zip(keys, items), key=lambda kt: kt[0])] if len(items) > 1 else items


def _ffp_factor(f, what):
    """The factorization of the nonzero polynomial f (monic irreducibles,
    with exponents), admitted first."""
    R, n = f.R, f.p.degree()
    engine = R.F.n == 1 and R.F.p < 2 ** 32
    if engine:
        if n > _FFPOLY_FACTOR_DEG:
            raise MagmaError("%s of a polynomial over a finite field of degree more than %d is not supported yet"
                             % (what, _FFPOLY_FACTOR_DEG), "'%s'" % what)
    elif n ** 3 * R.F.q.bit_length() > _FFPOLY_WORK:
        raise MagmaError("%s of a polynomial of degree %d over this finite field is not supported yet" % (what, n), "'%s'" % what)
    return [] if n < 1 else list(f.p.factor())


def _ffp_factorization(f):
    if not f.p._c:
        raise _arg_error("Factorization", "Argument 1 is not non-zero")
    items = [(g, e) for g, e in _ffp_factor(f, "Factorization")]
    # (by degree, then the coefficients from the top, in Magma's order of
    # the field's elements)
    def key(t):
        ks = [_ff_key(c) for c in reversed(t[0]._c)]
        return None if None in ks else (t[0].degree(), ks)
    items = _ffp_sorted(items, key, "Factorization")
    return _multi([MSeq(MTuple([_MFFPoly(f.R, g), e]) for g, e in items), f.p._c[-1]], show=1)


def _ffp_roots(f, R=None):
    if R is not None and R is not f.R.F:
        raise MagmaError("Roots in a ring other than the coefficient field is not supported yet", "'Roots'")
    if not f.p._c:
        raise _arg_error("Roots", "Argument 1 is not non-zero")
    rs = [(-g._c[0] / g._c[1], e) for g, e in _ffp_factor(f, "Roots") if g.degree() == 1]
    rs = _ffp_sorted(rs, lambda t: _ff_key(t[0]), "Roots")
    return MSeq(MTuple([r, e]) for r, e in rs)


def _ffp_is_irreducible(f):
    if not f.p._c:
        raise _arg_error("IsIrreducible", "Argument 1 is not non-zero")
    if f.p.degree() < 1:
        return False
    F = _ffp_factor(f, "IsIrreducible")
    return len(F) == 1 and F[0][1] == 1


def _ffp_gcd(args, lcm=False, name=None):
    """Gcd (or Lcm) of polynomials of one ring over a finite field (integers
    and the field's elements among them): monic, as Magma's.  name: the
    one it was called by (GCD, LeastCommonMultiple, ...)."""
    R = next(a.R for a in args if isinstance(a, _MFFPoly))
    canon = "Lcm" if lcm else "Gcd"
    name = name or canon
    ps = []
    for a in args:
        p = R._lift(a)
        if p is None:
            raise _bad_types(name, args)
        ps.append(p)
    # (the whole fold admitted at once, before any step: a Gcd's running
    # degree never exceeds the first's, an Lcm's the sum so far, HARD-53E-1)
    work, run = 0, max(ps[0].degree(), 1)
    for p in ps[1:]:
        d = max(p.degree(), 1)
        work += run * d * (2 if lcm else 1)
        if lcm:
            run += d
    _ffp_admit(work, R, "a %s" % canon, name)
    g = ps[0]
    for p in ps[1:]:
        if lcm:
            if not g._c or not p._c:
                g = R.P([])
                continue
            g = (g * p).quo_rem(g.gcd(p))[0]
        else:
            g = g.gcd(p)
    return _MFFPoly(R, g.monic() if g._c else g)


def _ffp_derivative(f, k):
    n = max(f.p.degree(), 0)
    _ffp_admit(n * min(k, n), f.R, "a derivative", "Derivative")
    p = f.p
    for _ in range(k):
        if not p._c:
            break
        p = p.derivative()
    return _MFFPoly(f.R, p)


# ------------------------------------------------------------------ integers

# (Proof is forwarded when given: true means proven or an error, as in
# Sage mode; by default a prime above 3.3e24 is a BPSW probable prime,
# not proven as Magma's default would promise: the systematic review's
# ASR-F1)
def _arg_error(name, msg):
    """Magma's refusal of an argument by an intrinsic (its own words)."""
    return MagmaError(msg, "'%s'" % name, True)


def IsPrime(n, *, Proof=None):
    if isinstance(n, _Fraction):
        return False  # (a rational, an integral one too: as Magma, no warning)
    # (Magma's: -7 is prime, as 7 is)
    return _sa.is_prime(abs(n), proof=Proof)


def IsProbablePrime(n, *, Bases=None):
    if Bases is not None and Bases <= 0:
        raise MagmaError("Value for 'Bases' must be small and positive", "'IsProbablePrime'")
    # the exact answer: a prime passes for any bases, and Magma's bases are
    # not the first primes (strong pseudoprimes to those, such as 2047
    # with Bases := 1 or 3215031751 with Bases := 4, are composite there)
    return _sa.is_prime(abs(n))


def NextPrime(n, *, Proof=None):
    if n < 0:
        raise _arg_error("NextPrime", "Argument 1 (%d) should be >= 0" % n)
    return _sa.next_prime(n, proof=Proof)


def PreviousPrime(n, *, Proof=None):
    if n < 3:
        raise _arg_error("PreviousPrime", "Argument 1 (%d) should be >= 3" % n)
    return _sa.previous_prime(n, proof=Proof)


# Prime enumeration is admitted before any sieve is made, by the heap the
# shared sieve may take (sage_all.prime_range, segmented: a narrow window
# near 10^12 is cheap; HARD-3BE-1)
def _admit_primes(name, start, stop, what=None):
    if not _sa._prime_sieve_admits(start, stop):
        raise MagmaError("%s needs more memory than Sagebrush has: not supported yet" % (what or "%s up to %d" % (name, stop - 1)), "'%s'" % name)


def PrimesUpTo(n):
    if n < 1:
        raise _arg_error("PrimesUpTo", "Limit must be positive")
    _admit_primes("PrimesUpTo", 2, n + 1)
    return MSeq(_sa.prime_range(n + 1))


def PrimesInInterval(a, b):
    if a < 1:
        raise _arg_error("PrimesInInterval", "Lower limit must be positive")
    if b < a:
        raise _arg_error("PrimesInInterval", "Upper limit < Lower Limit !")
    _admit_primes("PrimesInInterval", a, b + 1)
    return MSeq(_sa.prime_range(a, b + 1))


def NthPrime(n):
    if n < 0:
        raise _arg_error("NthPrime", "Argument 1 (%d) should be >= 0" % n)
    if n == 0:
        return 1  # (Magma's NthPrime(0) is 1)
    _admit_primes("NthPrime", 2, _sa._nth_prime_bound(n) + 1, "NthPrime(%d)" % n)
    return _sa.nth_prime(n)


def _int_arg(name, n):
    if not isinstance(n, int) or isinstance(n, bool):
        raise MagmaError("%s of a %s is not supported yet" % (name, _type_of(n)), "'%s'" % name)
    return n


def PrimeDivisors(n):
    if _int_arg("PrimeDivisors", n) == 0:
        raise _arg_error("PrimeDivisors", "Argument 1 is not non-zero")
    return MSeq(p for p, _ in _sa.factor(abs(n)))


def Divisors(n):
    if _int_arg("Divisors", n) < 1:
        raise _arg_error("Divisors", "Argument 1 (%d) should be >= 1" % n)
    return MSeq(_sa.divisors(n))


def NumberOfDivisors(n):
    if n < 1:
        raise _arg_error("NumberOfDivisors", "Argument 1 is not positive")
    return _sa.number_of_divisors(n)


def SumOfDivisors(n):
    if n < 1:
        raise _arg_error("SumOfDivisors", "Argument 1 is not positive")
    return _sa.sigma(n)


def DivisorSigma(k, n):
    return _sa.sigma(n, k)


def EulerPhi(n):
    if n < 1:
        raise _arg_error("EulerPhi", "Argument 1 is not positive")
    return _sa.euler_phi(n)


def MoebiusMu(n):
    if n < 1:
        raise _arg_error("MoebiusMu", "Argument 1 (%d) should be >= 1" % n)
    return _sa.moebius(n)


def IsPrimePower(n):
    if n < 2:
        raise _arg_error("IsPrimePower", "Argument 1 (%d) should be >= 2" % n)
    F = _sa.factor(n)
    if len(F) == 1:
        return _multi([True, F[0][0], F[0][1]])
    return False


def _null_int_collection(name, given):
    """An empty collection given to Gcd or Lcm, as Magma's (checked against
    Magma 2.18): of the integers (a range, a declared universe, one emptied)
    its Gcd is 0 and Lcm 1; written empty with no universe ([], {}, an
    empty comprehension) "Illegal null set/sequence"; over the rationals or
    a finite field "GCD (LCM) not defined for field"; of polynomials
    refused in words.  An empty one made otherwise (Setseq, Sort, join, ...,
    ...) keeps what its sources knew (_carry); where nothing is known it is
    refused in words, never 0 or 1."""
    s = given[0]
    if isinstance(s, MRange):
        return
    u, inf = getattr(s, "universe", None), getattr(s, "_inf", None)
    mark = getattr(s, "_null", False)
    _field_collection(name, s)
    if u is _ZZ or inf is _ZZ:
        return
    if u is None and mark is True:
        raise _arg_error(name, "Illegal null set/sequence")
    if u is _QQ or inf is _QQ or isinstance(u, _MFinField) or mark == "field":
        raise _arg_error(name, "%s not defined for field" % _gcd_word(name))
    if isinstance(u, (_sp.PolynomialRing_, _MFFPolyRing)):
        raise MagmaError("%s of an empty collection of polynomials is not supported yet" % name, "'%s'" % name)
    if u is None:
        raise MagmaError("%s of an empty collection whose universe Sagebrush doesn't know is not supported yet" % name, "'%s'" % name)
    raise _bad_types(name, given)


def _gcd_word(name):
    """GCD or LCM, as Magma's field error has it whichever name the
    intrinsic was called by (LeastCommonMultiple: "LCM not defined for
    field")."""
    return "LCM" if name in ("Lcm", "LCM", "LeastCommonMultiple") else "GCD"


def _field_collection(name, s):
    """A collection over a field (the rationals or a finite field, declared
    or carried: what is put in later stays the field's) given to Gcd or
    Lcm, empty or not: Magma's "GCD (LCM) not defined for field" (checked
    against Magma 2.18), never a fold of integers put in it."""
    u = getattr(s, "universe", None)
    if u is _QQ or isinstance(u, _MFinField) or getattr(s, "_null", False) == "field" or (
            u is None and not isinstance(s, MRange) and _infer_from(s.items if isinstance(s, MSet) else s) is _QQ):
        raise _arg_error(name, "%s not defined for field" % _gcd_word(name))  # (inferred too: Gcd([1/2, 1/3]))


def _function_only(name, args):
    """An intrinsic that is a function only, called as a procedure with an
    argument by reference (GCD(~x);): Magma's Bad argument types, that
    argument marked "~" (checked against Magma 2.18), never the function's
    value or its other errors."""
    rc = _REFCALL[0]
    if rc is not None and rc[1] and rc[0] is globals().get(name):
        raise _bad_types(name, args)


def _gcd(name, args):
    _function_only(name, args)
    given = args
    if len(args) > 2 or not args:
        raise _bad_types(name, args)  # (two arguments, or one sequence; none is Magma's error, never 0)
    if len(args) == 2:
        _no_rationals(name, *args)
    if len(args) == 1:
        if not isinstance(args[0], (MSeq, MRange, MSet)):
            raise _bad_types(name, given)
        if (args[0].size() if isinstance(args[0], MRange) else len(args[0])) == 0:
            _null_int_collection(name, given)
            return 0
        _field_collection(name, args[0])
        args = tuple(args[0])
    if any(isinstance(a, _MFFPoly) for a in args):
        return _ffp_gcd(args, name=name)
    if any(isinstance(a, _sp.Polynomial) for a in args):
        g = args[0]
        for a in args[1:]:
            g = g.gcd(a)
        return g
    if not all(_int(a) for a in args):
        # (integers only, as Magma's: [RngIntElt] is SeqEnum[Cat], never a
        # Python error)
        raise _bad_types(name, given)
    # (a fold over the integers: one of them too, Gcd([-5]) is 5, never a
    # Python error, as Magma's)
    g = 0
    for a in args:
        g = _math.gcd(g, int(a))
    return g


def Gcd(*args):
    return _gcd("Gcd", args)


def GCD(*args):
    return _gcd("GCD", args)


def GreatestCommonDivisor(*args):
    return _gcd("GreatestCommonDivisor", args)


def _lcm(name, args):
    _function_only(name, args)
    given = args
    if len(args) > 2 or not args:
        raise _bad_types(name, args)  # (none is Magma's error, never 1)
    if len(args) == 1:
        if not isinstance(args[0], (MSeq, MRange, MSet)):
            raise _bad_types(name, given)
        if (args[0].size() if isinstance(args[0], MRange) else len(args[0])) == 0:
            _null_int_collection(name, given)
            return 1
        _field_collection(name, args[0])
        args = tuple(args[0])
    if any(isinstance(a, _MFFPoly) for a in args):
        return _ffp_gcd(args, lcm=True, name=name)
    if not all(_int(a) or isinstance(a, _sp.Polynomial) for a in args):
        raise _bad_types(name, given)
    if any(isinstance(a, _sp.Polynomial) for a in args):
        return _sa.lcm(*args)
    # (a fold, nonnegative, 0 with a 0 among them, as Magma's: Lcm([-5]) is 5)
    l = 1
    for a in args:
        a = abs(int(a))
        l = 0 if (l == 0 or a == 0) else l * a // _math.gcd(l, a)
    return l


def Lcm(*args):
    return _lcm("Lcm", args)


def LCM(*args):
    return _lcm("LCM", args)


def LeastCommonMultiple(*args):
    return _lcm("LeastCommonMultiple", args)


def _xgcd(name, args):
    """Xgcd(a, b) of two integers or polynomials, as Magma's: a rational
    among them (an integral one too) is Magma's Bad argument types naming
    both FldRatElt, as anything else not an integer or a polynomial
    (checked against Magma 2.18), never a value; of a sequence (Magma's
    other signature) refused in words."""
    _function_only(name, args)
    if len(args) == 1 and isinstance(args[0], (MSeq, MSet, MRange)):
        raise MagmaError("%s of a sequence is not supported yet" % name, "'%s'" % name)
    if len(args) != 2:
        raise _bad_types(name, args)
    a, b = args
    _no_rationals(name, a, b)
    if not all(_int(x) or isinstance(x, _sp.Polynomial) for x in args):
        raise _bad_types(name, args)
    g, s, t = _sa.xgcd(a, b)
    return _multi([g, s, t])


def Xgcd(*args):
    return _xgcd("Xgcd", args)


def XGCD(*args):
    return _xgcd("XGCD", args)


def ExtendedGreatestCommonDivisor(*args):
    return _xgcd("ExtendedGreatestCommonDivisor", args)


def Quotrem(a, b):
    return _multi([_idiv(a, b), _mod(a, b)])


def Modexp(a, k, m):
    if any(isinstance(x, bool) or not isinstance(x, int) for x in (a, k, m)):
        raise _bad_types("Modexp", (a, k, m))
    if m < 2:
        raise _arg_error("Modexp", "Argument 3 (%d) should be >= 2" % m)
    return pow(a, k, m)


def Modinv(a, m):
    _no_rationals("Modinv", a, m)  # (before m == 1's 0: Modinv(3/2, 1) is refused, CORR-3BE-2)
    if m < 1:
        raise _arg_error("Modinv", "Argument 2 (%d) should be >= 1" % m)
    if m == 1:
        return 0
    if _math.gcd(a, m) != 1:
        raise _arg_error("Modinv", "Argument 1 is not a unit mod argument 2")
    return pow(a, -1, m)


InverseMod = Modinv


def Binomial(n, k):
    return _sa.binomial(n, k)


def Factorial(n):
    if n < 0:
        raise _arg_error("Factorial", "Argument 1 (%d) should be >= 0" % n)
    return _sa.factorial(n)


def Fibonacci(n):
    return _sa.fibonacci(n)


def IsSquare(n):
    if _is_ff(n):
        return _multi([True, _ff_sqrt(n)]) if n.is_square() else False
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
    if n < 0:
        raise _arg_error("Isqrt", "Argument 1 is not non-negative")
    return _math.isqrt(n)


def _ff_sqrt(x):
    """The square root of a square x that Magma returns (measured against
    Magma 2.18):
    - in characteristic 2 the root is unique;
    - in GF(p^n), n > 1, the root with the smaller logarithm to the
      generator (every square tested, in fields up to 3^12 elements);
    - in GF(p), p = 3 mod 4, x^((p+1)/4), the root that is itself a square
      (Lagrange's formula; every square tested for p < 1100);
    - in GF(p), p = 1 mod 4, Magma's choice follows no rule found (neither
      Tonelli-Shanks with the least non-residue nor the smaller logarithm
      to PrimitiveElement), so Sagebrush returns the root whose integer
      representative is smaller: a correct root, possibly not Magma's."""
    if not x:
        return x
    F = _ffwrap(x.parent())
    if F.p == 2:
        return x.sqrt()
    if F.n > 1:
        r = x.sqrt()
        return min((r, -r), key=lambda y: int(y.log(F.K.gen())))
    if F.p % 4 == 3:
        return x ** ((F.p + 1) // 4)
    r = int(x.sqrt())
    return F.K(min(r, F.p - r))


def Sqrt(x):
    if _is_ff(x):
        if not x.is_square():
            raise MagmaError("Argument must be a square", "'Sqrt'")
        return _ff_sqrt(x)
    if isinstance(x, MReal):
        return _rsqrt(x)
    return _rsqrt(MReal.of(x))


# Finite-field intrinsics of plan-finite-fields F2 (PrimeField, Generator,
# DefiningPolynomial, IsSubfield, Embed, Trace, Norm, MinimalPolynomial,
# CharacteristicPolynomial, Root, ext< >): the math, its budgets and its
# refusal points are the shared core's, lib/_sage_ffsub.py (Sage mode's
# trace, norm, minpoly, charpoly, nth_root and extension call the same);
# here only Magma's signatures, words (checked against Magma 2.18) and
# objects.

def _call_pos(name):
    """Where Magma points at an error of the intrinsic `name`: the "(" of its
    first call at or after the current statement's start (line, col),
    outside string literals and comments (astra on dae43019: not a "Root("
    in a string), or None (the statement's start, as before)."""
    line, col = _pos[0], _pos[1]
    text = _src[1][line - 1] if 0 < line <= len(_src[1]) else ""
    rx = _re.compile(r"%s\s*\(" % _re.escape(name))
    i, n = max(0, col - 1), len(text)
    while i < n:
        c = text[i]
        if c == '"':
            # (a string literal, its escapes skipped)
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            continue
        if text.startswith("//", i):
            return None
        if text.startswith("/*", i):
            k = text.find("*/", i + 2)
            if k < 0:
                return None
            i = k + 2
            continue
        if c.isalpha() or c == "_":
            k = i
            while k < n and (text[k].isalnum() or text[k] in "_'"):
                k += 1
            if text[i:k] == name:
                m = rx.match(text, i)
                if m:
                    return (line, m.end())
            i = k
            continue
        i += 1
    return None


def _fferr(msg, name):
    """Magma's error `msg` in the intrinsic `name`, at its call."""
    return MagmaError(msg, "'%s'" % name, True, _call_pos(name))


def _ff_work(what, x):
    """The refusal past the one-call budget (WORK), in words."""
    return lambda: _fferr("%s of an element of a finite field of degree %d is not supported yet (work)"
                          % (what, _ffsub.pnq(x.parent())[1]), what)


def _ff_poly(K, coeffs):
    """The polynomial with these coefficients (constant first: ints or
    elements of the field K) in PolynomialRing(K), Magma's one ring per
    field."""
    R = _ffpoly_ring(_ffwrap(K))
    return _MFFPoly(R, R.P([K(c) for c in coeffs]))


# ChangeRing (plan-finite-fields F3) of a univariate polynomial ring over
# the integers, the rationals or a finite field, or of one of its
# polynomials, to another of these rings, as Magma's (black-box against
# Magma 2.18):
#   - ChangeRing(P, R) is Magma's one univariate ring over R (the integers'
#     and the rationals' the one PolynomialRing made last, as Magma's
#     global ring; a finite field's its own) and the map from P to it;
#   - ChangeRing(f, R) is f with each coefficient coerced into R, or
#     Magma's "Polynomial is not coercible" when one isn't (a zero
#     polynomial goes anywhere): a rational with a denominator to the
#     integers, or one divisible by p to GF(p^n); an element of a finite
#     field to the integers only from its prime field, never to the
#     rationals; between finite fields by section 2B's rules (another
#     characteristic, or neither field containing the other: nothing
#     nonzero), through the shared core's change() into an overfield or a
#     subfield (F1's embedding and descent, of at most 2^20 elements);
#   - its whole work, from the number and the sizes of the coefficients,
#     is charged to one budget of _ffsub.WORK before any coefficient is
#     coerced (the core's change_cost between finite fields; its
#     rationals_cost for rationals, a coefficient of b bits reduced mod p,
#     ceil(b/30) w(p), and made an element of GF(p^n), n; a scan of n words
#     for each coefficient going to the integers), else refused in words;
#     between finite fields of more than 2^20 elements, refused first.
# Integers(m), the reals and other rings are refused in words, as are
# matrices and the other structures Magma's ChangeRing takes.

def _cr_ring(R):
    """Magma's univariate polynomial ring over R (Z, Q or a finite field)."""
    if isinstance(R, _MFinField):
        return _ffpoly_ring(R)
    key = _fun_base_key(R)
    S = _FUN_POLY_BY_BASE.get(key)
    if S is None:
        S = _sp.PolynomialRing_(_sp.ZZ if R is _ZZ else _sp.QQ, "$.1")
        _fun_remember_poly(key, S)
    return S


def _cr_base(R):
    """R when ChangeRing goes to it (Z, Q or a finite field), else the
    refusal in words."""
    if R is _ZZ or R is _QQ or isinstance(R, _MFinField):
        return R
    raise _fferr("ChangeRing to a %s is not supported yet" % _type_of(R), "ChangeRing")


def _cr_poly(f, R):
    """ChangeRing(f, R): f's coefficients coerced into R (Z, Q or a finite
    field), admitted whole first."""
    R = _cr_base(R)
    S = _cr_ring(R)
    budget = [_ffsub.WORK]
    fail = lambda x=None: _fferr("Polynomial is not coercible", "ChangeRing")
    if isinstance(f, _MFFPoly):
        xs, W = list(f.p._c), f.R.F
        refuse = lambda: _fferr("ChangeRing of a polynomial of degree %d to this field is not supported yet (work)" % (len(xs) - 1), "ChangeRing")
        if R is _QQ or (isinstance(R, _MFinField) and R.p != W.p):
            if any(xs):
                raise fail()
            return S([]) if R is _QQ else _MFFPoly(S, S.P([]))
        if R is _ZZ:
            _ffsub.charge(budget, len(xs) * W.n, refuse)
            vs = [_ffsub.prime_value(x) for x in xs]
            if any(v is None for v in vs):
                raise fail()
            return S(vs)
        wn, un = W.n, R.n
        if xs and 1 < wn != un > 1 and (un % wn == 0 or wn % un == 0) and not (
                _ffsub.embeddable(W.K, R.K) if un % wn == 0 else _ffsub.descendable(W.K, R.K)):
            # (F1's bound on the larger field, before anything is moved)
            raise _fferr("ChangeRing between finite fields of more than 2^20 elements is not supported yet", "ChangeRing")
        return _MFFPoly(S, S.P(_ffsub.change(xs, R.K, budget, refuse, fail)))
    cs = [_Fraction(c) for c in f._c]
    if R is _ZZ:
        if any(c.denominator != 1 for c in cs):
            raise fail()
        return S([int(c) for c in cs])
    if R is _QQ:
        return S(cs)
    refuse = lambda: _fferr("ChangeRing of a polynomial of degree %d to this field is not supported yet (work)" % (len(cs) - 1), "ChangeRing")
    return _MFFPoly(S, S.P(_ffsub.from_rationals(cs, R.K, budget, refuse, fail)))


class _MChangeRingMap(MMap):
    """The map ChangeRing(P, R) returns with its ring: f :-> ChangeRing(f,
    R), printed as Magma's (its domain and codomain only)."""

    def __init__(self, dom, cod, base):
        MMap.__init__(self, dom, cod, rule=lambda f: _cr_poly(f, base))

    def __repr__(self):
        return "Mapping from: %s to %s" % (_struct_name(self.dom), _struct_name(self.cod))


def _cr_source_ok(X):
    """Whether X is a polynomial ring (or a polynomial) over the integers,
    the rationals or a finite field, the ones ChangeRing takes here."""
    if isinstance(X, (_MFFPolyRing, _MFFPoly)):
        return True
    ring = X if isinstance(X, _sp.PolynomialRing_) else getattr(X, "_ring", None)
    return type(ring) is _sp.PolynomialRing_ and (ring._base is _sp.ZZ or ring._base is _sp.QQ)


@_signature("ChangeRing", "RngUPol", "Rng", ret="RngUPol")
def _change_ring_ring(P, R):
    if not _cr_source_ok(P):
        raise _fferr("ChangeRing of this polynomial ring is not supported yet", "ChangeRing")
    base = _cr_base(R)
    S = _cr_ring(base)
    return _multi([S, _MChangeRingMap(P, S, base)])


@_signature("ChangeRing", "RngUPolElt", "Rng", ret="RngUPolElt")
def _change_ring_poly(f, R):
    if not _cr_source_ok(f):
        raise _fferr("ChangeRing of this polynomial is not supported yet", "ChangeRing")
    return _cr_poly(f, R)


_unimplemented_signature("ChangeRing", "Mtrx", "Rng", ret="Mtrx")


def _ff_absolute(what, x):
    """Trace, Norm, MinimalPolynomial or CharacteristicPolynomial of x over
    its prime field."""
    p = _ffsub.pnq(x.parent())[0]
    P = _sff.GF(p)
    refuse = _ff_work(what, x)
    if what == "Trace":
        return P(_ffsub.trace(x, [_ffsub.WORK], refuse))
    if what == "Norm":
        return P(_ffsub.norm(x, [_ffsub.WORK], refuse))
    f = (_ffsub.minpoly if what == "MinimalPolynomial" else _ffsub.charpoly)(x, [_ffsub.WORK], refuse)
    return _ff_poly(P, f)


def _ff_relative(what, x, F, name=None):
    """The same over F, a subfield of x's field (Magma's error otherwise);
    over a proper subfield bounded as F1's descent.  (name: the intrinsic
    said in a refusal, when not `what`.)"""
    name = name or what
    if not isinstance(F, _MFinField):
        raise _bad_types(name, (x, F), _call_pos(name))
    K = x.parent()
    if not _ffsub.is_subfield(F.K, K):
        raise _fferr("Argument 2 is not a subfield of the parent of argument 1", name)
    kind = {"Trace": "trace", "Norm": "norm", "MinimalPolynomial": "minpoly"}.get(what, "charpoly")
    r = _ffsub.relative(kind, x, F.K, [_ffsub.WORK], _ff_refuse(name, _ffwrap(K), F, "'%s'" % name, _call_pos(name)))
    return _ff_poly(F.K, r) if isinstance(r, list) else r


def PrimeField(F):
    if isinstance(F, _MFinField):
        return _ffwrap(_sff.GF(F.p))
    if F is _ZZ:
        raise _bad_types("PrimeField", (F,), _call_pos("PrimeField"))
    raise _fferr("PrimeField of this argument is not supported yet", "PrimeField")


def Generator(F, sub=None):
    """F.1 (1 in a prime field, as Magma's: not the primitive element);
    with sub, a subfield of F (Magma's error otherwise), the same."""
    if not isinstance(F, _MFinField) or (sub is not None and not isinstance(sub, _MFinField)):
        raise _fferr("Generator of this argument is not supported yet", "Generator")
    if sub is not None and not _ffsub.is_subfield(sub.K, F.K):
        raise _fferr("Argument 2 is not a subfield of argument 1", "Generator")
    return F.K(1) if F.n == 1 else F.K.gen()


def DefiningPolynomial(F, sub=None):
    """The defining polynomial of F over GF(p): its Conway polynomial, and
    X - 1 for GF(p) itself ($.1 + (p - 1), as Magma's, whose generator
    there is 1); with sub, a subfield of F (Magma's error otherwise), the
    minimal polynomial of F.1 over sub."""
    if not isinstance(F, _MFinField) or (sub is not None and not isinstance(sub, _MFinField)):
        raise _fferr("DefiningPolynomial of this argument is not supported yet", "DefiningPolynomial")
    P = _sff.GF(F.p)
    if sub is not None and not _ffsub.is_subfield(sub.K, F.K):
        raise _fferr("Argument 2 is not a subfield of argument 1", "DefiningPolynomial")
    if F.n == 1:
        return _ff_poly(P if sub is None else sub.K, [F.p - 1, 1])
    if sub is None or sub.n == 1:
        return _ff_poly(P if sub is None else sub.K, F.K._f)
    return _ff_relative("MinimalPolynomial", F.K.gen(), sub, "DefiningPolynomial")


def IsSubfield(F, K):
    if isinstance(F, _MFinField) and isinstance(K, _MFinField):
        return _ffsub.is_subfield(F.K, K.K)
    raise _fferr("IsSubfield of these arguments is not supported yet", "IsSubfield")


def Embed(F, K, x=None):
    """Embed(F, K[, x]), a procedure: every subfield of a finite field is
    already embedded (Conway-compatibly), so Magma's checks only."""
    if not (isinstance(F, _MFinField) and isinstance(K, _MFinField)):
        raise _fferr("Embed of these arguments is not supported yet", "Embed")
    if F.p != K.p:
        raise _fferr("Arguments 1 and 2 have different characteristics", "Embed")
    if K.n % F.n:
        raise _fferr("Degree of argument 1 does not divide degree of argument 2", "Embed")
    if x is not None:
        raise _fferr("Argument 1 is already a subfield of argument 2", "Embed")
    return None


# Root(x, 2) takes Magma's choice of square root where it is verified
# (black-box against Magma 2.18: Root(x, 2) eq Sqrt(x) for every square of
# GF(q) for q < 1000; _ff_sqrt's rule for GF(p^n), n > 1, every square up
# to 3^12 elements; x^((p + 1)/4) in GF(p), p = 3 mod 4); elsewhere refused.
_ROOT2_MAX = 3 ** 12


def _root2_cost(x):
    """The closed-form cops of Magma's square root of x (odd p) where its
    choice is verified, or None where it isn't (refused).  In GF(p),
    p = 3 mod 4: x^((p + 1)/4).  In GF(p^n), n > 1, q <= _ROOT2_MAX:
    x.sqrt() (the generator's primitivity check, omega(q - 1) + 1 powers;
    is_square, one power; Tonelli-Shanks' three powers and at most
    S (2 S + 3) products, q - 1 = 2^S Q) and one discrete log (D(q, n),
    the trial factoring included)."""
    K = x.parent()
    p, n, q = _ffsub.pnq(K)
    if n == 1:
        return _ffsub.prime_pow_cost((p + 1) // 4, p) if p % 4 == 3 else None
    if q > _ROOT2_MAX:
        return None
    S = (q - 1 & -(q - 1)).bit_length() - 1
    M = _ffsub.mn(p, n)
    return ((len(_sff._factor_int(q - 1)) + 5) * _ffsub.pow_bound(q, M) + S * (2 * S + 3) * M
            + _ffsub.dlog_cost(K))


def _root2(x):
    """Magma's square root of the square x (odd p, nonzero, _root2_cost not
    None), its cost already charged with the rest of Root's (one budget)."""
    K = x.parent()
    p, n, q = _ffsub.pnq(K)
    if n == 1:
        return x ** ((p + 1) // 4)
    r = x.sqrt()
    k = _sff._dlog(r, K.gen(), None, q - 1, lambda u, v: u * v, K.one())
    # (_ff_sqrt's choice: of r and -r, the one with the smaller logarithm;
    # log(-r) = log(r) + (q - 1)/2)
    return r if k < (q - 1) // 2 else -r


def Root(x, k):
    """A k-th root of x in its finite field, Magma's: the unique one when
    gcd(k, q - 1) = 1 (or x = 0), Magma's square root for k = 2 where its
    choice is verified, "No solution exists" when there is none; other
    roots (several, Magma's choice unverified) and exponents of more than
    1024 bits (Magma takes them) are refused.  ONE budget: the shared
    root()'s cost and, for k = 2, the square root's, charged together
    before any power (astra CORR-FF2-3)."""
    if not _is_ff(x) or not isinstance(k, int) or isinstance(k, bool):
        raise _fferr("Root of these arguments is not supported yet", "Root")
    if k <= 0:
        # (Magma's own words, its argument number included)
        raise _fferr("Argument 85 is not positive", "Root")
    sq = _root2_cost(x) if k == 2 and _ffsub.pnq(x.parent())[0] != 2 else None
    st, r = _ffsub.root(x, k, [_ffsub.WORK],
                        lambda: _fferr("Root of an exponent of more than %d bits is not supported yet" % _ffsub.ROOT_BITS, "Root"),
                        _ff_work("Root", x), extra=sq or 0)
    if st == "unique":
        return r
    if st == "none":
        raise _fferr("No solution exists", "Root")
    if sq is None:
        raise _fferr("Root of degree %d in this finite field is not supported yet" % k, "Root")
    return _root2(x)


class _MExtMap(MMap):
    """The second value of ext<F | k>: the embedding of F in the extension,
    printed as Magma's (no rule shown)."""

    def __repr__(self):
        # (a field no global variable holds is GF(q) here, as Magma's)
        name = lambda F: _struct_name(F) if _global_name(F) is not None else _gf_name(F)
        return "Mapping from: %s to %s" % (name(self.dom), name(self.cod))


def _ext(F, args, pos):
    """ext<F | k>: GF(p^(m k)) (its Conway field, as Magma's), and the
    embedding of F; the construction bounded as GF's (its bit size, then the
    shared Conway budget).  ext<F | f> by a polynomial is refused."""
    where = "ext< ... >"
    if len(args) != 1:
        raise MagmaError("Rhs arity (%d) should be 1" % len(args), where, True, pos)
    k = args[0]
    if not isinstance(F, _MFinField):
        raise MagmaError("ext< ... > of this structure is not supported yet", where, True, pos)
    if not isinstance(k, int) or isinstance(k, bool):
        raise MagmaError("ext< ... > by a polynomial or anything but a degree is not supported yet", where, True, pos)
    if k <= 0:
        raise MagmaError("Extension degree should be a small integer greater than 0", where, True, pos)
    try:
        G = GF(F.p, F.n * k)
    except MagmaError as e:
        raise MagmaError(str(e), where, True, pos)
    return _multi([G, _MExtMap(F, G, rule=lambda y: _coerce(G, y))])


def _rsqrt(x):
    if x.m < 0:
        # (a complex number in Magma, which Sagebrush doesn't have)
        raise MagmaError("Sqrt of a negative number (a complex number in Magma) is not supported yet", "'Sqrt'")
    if x.m == 0:
        return MReal(0, 0, x.prec)
    # sqrt(m * 2^e), scaled to its own magnitude (CORR-0C6-3): s =
    # floor(sqrt(m * 2^(2k))) with at least bits + 2 bits, and s + 1/2
    # where the root isn't exact, so that the one rounding is correct
    bits = _bits(x.prec)
    m, e = x.m, x.e
    if e % 2:
        m, e = m << 1, e - 1
    k = max(0, bits + 2 - m.bit_length() // 2)
    N = m << (2 * k)
    s = _math.isqrt(N)
    h = e // 2 - k  # value = s * 2^h
    f = _Fraction(s) if s * s == N else _Fraction(2 * s + 1, 2)
    f = f * (_Fraction(1 << h) if h >= 0 else _Fraction(1, 1 << -h))
    return MReal._frac(f, x.prec)


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
        term = _Fraction(_iround(term * f / n * 10 ** (p + 15)), 10 ** (p + 15))
        total += term
        n += 1
    for _ in range(s):
        total = _Fraction(_iround(total * total * 10 ** (p + 15)), 10 ** (p + 15))
    return MReal._frac(total, p)


def Log(x, b=None):
    if _is_ff(x):
        # Log(x): to the primitive element; Log(b, x): to the base b
        base, y = (x, b) if b is not None else (PrimitiveElement(_ffwrap(x.parent())), x)
        if b is not None and not base:
            raise MagmaError("Base argument 1 must be non-zero", "'Log'")  # (CORR-581-5)
        if not y:
            raise MagmaError("Can not take log of zero element", "'Log'")
        try:
            return int(y.log(base))
        except ValueError:
            return -1  # as Magma: Log(w^2, w) is -1 in GF(9)
    if b is not None:
        # Log(b, x): the logarithm of x to the base b (Magma's order), with
        # guard digits before the one rounding
        base, y = MReal.of(x), MReal.of(b)
        if base.m <= 0:
            raise _arg_error("Log", "Argument 1 is not positive")
        if y.m <= 0:
            raise _arg_error("Log", "Argument 2 is not positive")
        if base.frac() == 1:
            raise _arg_error("Log", "Base for logarithm should not be 1")
        # (two reals of different precisions meet in the default field, as
        # Magma's Log(b, x) does: Log(RealField(10)!2, RealField(40)!32) has
        # 30 digits)
        p = base.prec if base.prec == y.prec else 30
        g = p + min(10, _REAL_PREC_MAX - p)
        return MReal.of(Log(MReal.of(y, g)) / Log(MReal.of(base, g)), p)
    x = MReal.of(x)
    p = x.prec
    f = x.frac()
    if f <= 0:
        raise _arg_error("Log", "Argument 1 is not positive")
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
        term = _Fraction(_iround(term * z2 * 10 ** (p + 15)), 10 ** (p + 15))
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
    if isinstance(x, _MResElt):
        return x.v == 0
    return x == 0


def IsOne(x):
    if isinstance(x, _MResElt):
        return x.v == 1 % x.R.m
    return x == 1


def IsUnit(x):
    if isinstance(x, _MResElt):
        return _math.gcd(x.v, x.R.m) == 1
    if _is_ff(x):
        return bool(x)  # (every nonzero element of a field)
    return x in (1, -1)


def Abs(x):
    return abs(x)


def Sign(x):
    if isinstance(x, _MPerm):
        return x._sign()
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


def _extreme(s, f, name):
    """The largest (f = max) or least element of s, with its position for a
    sequence, as Magma's Max and Maximum return them."""
    items = list(_iter(s))
    if not items:
        raise _arg_error(name, "Argument 1 is not non-empty")
    m = f(items)
    return _multi([m, items.index(m) + 1]) if isinstance(s, (MSeq, MRange)) else m


def Max(*args):
    if len(args) == 1:
        return _extreme(args[0], max, "Max")
    return max(args)


def Min(*args):
    if len(args) == 1:
        return _extreme(args[0], min, "Min")
    return min(args)


def Maximum(s, *rest):
    if rest:
        return max((s,) + rest)
    return _extreme(s, max, "Maximum")


def Minimum(s, *rest):
    if rest:
        return min((s,) + rest)
    return _extreme(s, min, "Minimum")


def Valuation(n, p):
    if isinstance(p, int) and not isinstance(p, bool):
        if p < 1:
            raise _arg_error("Valuation", "Argument 2 is not positive")
        if not _sa.is_prime(p):
            raise _arg_error("Valuation", "Argument 2 (%d) should be prime" % p)
    if n == 0:
        # (Magma's is Infinity, which Sagebrush doesn't have)
        raise MagmaError("Valuation of 0 (Infinity in Magma) is not supported yet", "'Valuation'")
    if isinstance(n, _Fraction) and not isinstance(n, int):
        return _sa.valuation(n.numerator, p) - _sa.valuation(n.denominator, p)
    return _sa.valuation(n, p)


def Numerator(x):
    if isinstance(x, _MFunRatElt):
        budget = _FunBudget()
        D, B = _fun_presentation_meta(x.F, x.v)
        _fun_preflight_result(x.F, D, B, budget, "numerator presentation")
        return x.F._parts(x.v)[0]
    return x.numerator if isinstance(x, _Fraction) else x


def Denominator(x):
    if isinstance(x, _MFunRatElt):
        budget = _FunBudget()
        D, B = _fun_presentation_meta(x.F, x.v)
        _fun_preflight_result(x.F, D, B, budget, "denominator presentation")
        return x.F._parts(x.v)[1]
    return x.denominator if isinstance(x, _Fraction) else 1


def _fun_factor_key(item):
    g, e = item
    try:
        cs = list(reversed(g.list()))
        return (g.degree(), tuple(int(c) if _is_ff(c) else _Fraction(c) for c in cs), e)
    except Exception:
        return (g.degree(), repr(g), e)


def _fun_pf_data(f, budget):
    """Polynomial part and primary numerators, using one caller budget."""
    F, v = f.F, f.v
    D = _fun_admit_fraction(F, v, False, budget, "partial-fraction input", normalize=False)
    B = max(_fun_poly_meta(v.numerator())[2], _fun_poly_meta(v.denominator())[2])
    if D > _FUN_PF_FACTORS_MAX:
        raise MagmaError("partial fractions have more than %d possible factors" % _FUN_PF_FACTORS_MAX,
                         "'PartialFractionDecomposition'", True)
    Bout = _fun_norm_bits(D, B)
    _fun_check_output_bits(F, D, Bout, "partial-fraction output")
    budget.charge(work=16 * (D + 1) ** 3 * _fun_scalar_cost(F, Bout),
                  live=128 * (D + 1) * (D + 1),
                  what="partial-fraction factorization, xgcd and output")
    q, r = v.numerator().quo_rem(v.denominator())
    fac = [(g, int(e)) for g, e in v.denominator().factor()
           if hasattr(g, "degree") and g.degree() > 0]
    fac.sort(key=_fun_factor_key)
    if len(fac) > _FUN_PF_FACTORS_MAX or sum(e for _, e in fac) > _FUN_PF_TERMS_MAX:
        raise MagmaError("partial-fraction output exceeds the R0a factor or term limit",
                         "'PartialFractionDecomposition'", True)
    primary = []
    powers = [g ** e for g, e in fac]
    for k, ((g, e), pk) in enumerate(zip(fac, powers)):
        other = F._backend_ring(1)
        for j, pj in enumerate(powers):
            if j != k:
                other = other * pj
        inv = _sfrac._inverse_mod(other % pk, pk)
        a = (r * inv) % pk
        primary.append((g, e, a))
    return q, primary


def _fun_z_term(F, g, e, n):
    """Clear a Q[x] term n/g^e into Magma's Z[x] presentation."""
    L = 1
    for c in list(g.list()) + list(n.list()):
        q = _Fraction(c)
        L = L * int(q.denominator) // _math.gcd(L, int(q.denominator))
    G = F._integer_ring([int(_Fraction(c) * L) for c in g.list()])
    N = F._integer_ring([int(_Fraction(c) * (L ** e)) for c in n.list()])
    return G, N


def _fun_term_out(F, g, e, n):
    if F._ground is _ZZ:
        G, N = _fun_z_term(F, g, e, n)
    else:
        G, N = F._poly_out(g), F._poly_out(n)
    return MTuple([G, e, N])


def PartialFractionDecomposition(f):
    if not isinstance(f, _MFunRatElt):
        raise _bad_types("PartialFractionDecomposition", (f,))
    budget = _FunBudget()
    q, primary = _fun_pf_data(f, budget)
    out = []
    if q:
        one = f.F._backend_ring(1)
        out.append(_fun_term_out(f.F, one, 1, q))
    for g, e, a in primary:
        # g-adic digits: a/g^e = sum_j n_j/g^j, deg(n_j)<deg(g).
        digits = []
        h = a
        for j in range(e, 0, -1):
            h, n = h.quo_rem(g)
            digits.append((j, n))
        for j, n in reversed(digits):
            if n:
                out.append(_fun_term_out(f.F, g, j, n))
    if len(out) > _FUN_PF_TERMS_MAX:
        raise MagmaError("partial-fraction output exceeds the R0a term limit",
                         "'PartialFractionDecomposition'", True)
    return MSeq(out)


def SquarefreePartialFractionDecomposition(f):
    if not isinstance(f, _MFunRatElt):
        raise _bad_types("SquarefreePartialFractionDecomposition", (f,))
    budget = _FunBudget()
    q, primary = _fun_pf_data(f, budget)
    out = []
    if q:
        out.append(_fun_term_out(f.F, f.F._backend_ring(1), 1, q))
    for e in sorted(set(e for _, e, _ in primary)):
        group = [(g, a) for g, ee, a in primary if ee == e]
        G = f.F._backend_ring(1)
        for g, _ in group:
            G = G * g
        # For factors of this exact denominator multiplicity, combine equal
        # g-adic layers.  Thus an exact-multiplicity-2 group contributes both
        # <G,1,...> and <G,2,...>, as Magma's squarefree decomposition does.
        layers = [f.F._backend_ring(0) for _ in range(e + 1)]
        for g, a in group:
            h = a
            for j in range(e, 0, -1):
                h, n = h.quo_rem(g)
                if n:
                    layers[j] = layers[j] + n * ((G // g) ** j)
        # Canonical base-G digits: reduce the numerator of G^-j modulo G
        # and carry its quotient into the next lower layer.
        for j in range(e, 1, -1):
            carry, layers[j] = layers[j].quo_rem(G)
            layers[j - 1] = layers[j - 1] + carry
        for j in range(1, e + 1):
            if layers[j]:
                out.append(_fun_term_out(f.F, G, j, layers[j]))
    if len(out) > _FUN_PF_TERMS_MAX:
        raise MagmaError("partial-fraction output exceeds the R0a term limit",
                         "'SquarefreePartialFractionDecomposition'", True)
    return MSeq(out)


def Intseq(n, b=10, s=None):
    """The base b digits of n >= 0, least significant first; with s, padded
    with zeros to at least s digits (never cut)."""
    if b < 2:
        raise MagmaError("Argument 2 (%d) should be >= 2" % b, "'Intseq'")
    if n < 0:
        raise MagmaError("Argument 1 (%d) should be >= 0" % n, "'Intseq'")
    d = list(_sa.digits(n, b))
    if s is not None:
        if isinstance(s, bool) or not isinstance(s, int):
            raise _bad_types("Intseq", [n, b, s])
        if s < 0:
            raise MagmaError("Argument 3 (%d) is not small and non-negative" % s, "'Intseq'", True)
        if s > _COLLECT_MAX:
            raise MagmaError("a sequence of more than %d elements is not supported yet" % _COLLECT_MAX, "'Intseq'")
        d += [0] * (s - len(d))
    return MSeq(d)


def Seqint(s, b=10):
    if b < 2:
        raise MagmaError("Argument 2 (%d) should be >= 2" % b, "'Seqint'")
    s = list(s)
    for i, d in enumerate(s):
        if not 0 <= d < b:
            raise _arg_error("Seqint", "Sequence digit %d should be >= 0 and < %d" % (i + 1, b))
    r = 0
    for d in reversed(s):
        r = r * b + d
    return r


def ChineseRemainderTheorem(a, m):
    """The least x >= 0 with x = a[i] mod m[i] for each i, or -1 when the
    congruences have no common solution (Magma's answer then)."""
    a, m = list(a), list(m)
    if not a:
        raise _arg_error("ChineseRemainderTheorem", "Sequence argument 1 must be non-empty")
    if len(a) != len(m):
        raise _arg_error("ChineseRemainderTheorem", "Lengths of sequence arguments should be the same")
    if any(mi == 0 for mi in m):
        raise _arg_error("ChineseRemainderTheorem", "Element of second argument (moduli M) is zero")
    x, M = 0, 1
    for ai, mi in zip(a, m):
        mi = abs(mi)
        g = _math.gcd(M, mi)
        if (ai - x) % g:
            return -1
        t = ((ai - x) // g * pow(M // g, -1, mi // g)) % (mi // g) if mi // g > 1 else 0
        x, M = x + M * t, M // g * mi
        x %= M
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
    if not 2 <= b <= 36:
        raise _arg_error("StringToInteger", "Argument 2 (%d) should be in the range [2 .. 36]" % b)
    # (Magma's form: whitespace around it and after the sign, but not
    # within the digits, and not Python's underscores, CORR-3BE-3)
    m = _re.fullmatch(r"\s*([+-]?)\s*([0-9A-Za-z]+)\s*", s)
    if not m or any(int(c, 36) >= b for c in m.group(2)):
        raise _arg_error("StringToInteger", 'String "%s" does not represent an number in base %d' % (s, b))
    return int(m.group(1) + m.group(2), b)


def Sprint(x):
    return _sprint_str(x)


def Sprintf(fmt, *args):
    return _sprintf(fmt, *args, where="'Sprintf'", string=True)


# ------------------------------------------------------------------ finite fields

def _is_ff(x):
    """An element of a finite field (lib/_sage_ff.py)."""
    if isinstance(x, _sff.FiniteFieldElement):
        return True
    return isinstance(x, _sff.IntegerMod) and getattr(x.parent(), "_prime", False)


_FF = {}  # id(_sage_ff field) -> its _MFinField

# Magma prints the nonzero elements of a field with at most this many
# elements as powers of its generator, and of larger fields as polynomials
# in it (checked against Magma: GF(2^20) and GF(1021^2) by powers,
# GF(1031^2) and GF(3^13) by polynomials).
_FF_POWERS_MAX = 2 ** 20
# (a cold search for the Conway polynomial of GF(p^n) by GF(q) is bounded by
# the shared _sage_ff.CONWAY_WORK, as in Sage mode)
# GF(q) and GF(p, n) of more bits are refused before any work on q (its
# power, its prime-power test, its tables) (HARD-581-1)
_FF_BITS = 1024


class _MFinField:
    """GF(q) in Magma mode: Magma's names, printing, iteration and
    coercions over the field of lib/_sage_ff.py, which does the arithmetic.
    Like Magma's, GF(q) is one object: naming its generator (F<w> := GF(9))
    names it everywhere.  From Magma's documentation (Finite Fields) and
    checked against Magma."""

    def __init__(self, K):
        self.K = K
        self.q, self.p, self.n = int(K.order()), int(K.characteristic()), int(K.degree())
        self.name = None  # the generator's name, once assigned

    def __repr__(self):
        return "Finite field of size %d" % self.p if self.n == 1 else "Finite field of size %d^%d" % (self.p, self.n)

    def _gen_name(self):
        if self.name is not None:
            return self.name
        v = _global_name(self)
        return "%s.1" % v if v is not None else "$.1"

    def _magma_names(self, names):
        if names:
            self.name = names[0]

    def _magma_gen(self, i):
        if i != 1:
            raise MagmaError("Bad argument types", "'.'")
        return self.K.gen()

    def _magma_card(self):
        return self.q

    def _magma_degree(self):
        return self.n

    def _magma_contains(self, x):
        # x in F by value, as Magma (CORR-581-3): an integer; an element of
        # F, or of its prime field; F's element lying in the prime field P
        # (x^p = x) for x in P
        if isinstance(x, bool):
            raise MagmaError("Bad argument types", "'in'")
        if isinstance(x, int):
            return True
        if _is_ff(x):
            Kx = _ffwrap(x.parent())
            if x.parent() is self.K:
                return True
            if Kx.p != self.p:
                raise MagmaError("Arguments have no covering structure", "'in'")
            if Kx.n == 1 or self.n % Kx.n == 0:
                return True  # (x's field lies in F)
            if self.n == 1:
                return _ffsub.prime_value(x) is not None
            if Kx.n % self.n == 0:
                # (F lies in x's field: by value; fields neither in the
                # other: false, even for 0 or 1, as Magma)
                return _ff_in_sub(x, self, [_ffsub.WORK], _ff_refuse("membership", Kx, self, "'in'"))
            return False
        if isinstance(x, (_Fraction, MReal)):
            raise MagmaError("Bad argument types", "'in'")
        raise MagmaError("membership of a %s in a finite field is not supported yet" % _type_of(x), "'in'")

    def _magma_coerce(self, x):
        if _is_ff(x):
            if x.parent() is self.K:
                return x
            # (Magma's rules, section 2B of the plan: up from a subfield,
            # down by value from a field over F, else no embedding: fields
            # neither in the other, another characteristic)
            Kx = _ffwrap(x.parent())
            y = None
            if Kx.p == self.p:
                refuse, budget = _ff_refuse("coercion", Kx, self, "'!'"), [_ffsub.WORK]
                if Kx.n == 1:
                    y = self.K(int(x))  # from the prime field
                elif self.n % Kx.n == 0:
                    y = _ff_up(x, self, budget, refuse)
                elif self.n == 1:
                    v = _ffsub.prime_value(x)
                    y = None if v is None else self.K(v)
                elif Kx.n % self.n == 0:
                    y = _ff_down(x, self, budget, refuse)
            if y is None:
                raise MagmaError("No embedding known into LHS field\nLHS: FldFin\nRHS: FldFinElt", "'!'", False)
            return y
        if isinstance(x, bool):
            raise MagmaError("Illegal coercion")
        if isinstance(x, int):
            return self.K(x)
        if isinstance(x, _Fraction):
            if x.denominator % self.p == 0:
                raise MagmaError("Illegal coercion")
            return self.K(x.numerator) / self.K(x.denominator)
        if isinstance(x, (MSeq, MRange)):
            # (CORR-581-4) the coefficients on the power basis (Eltseq):
            # integers or the prime field's elements; a sequence of F's own
            # (or other fields') elements lifts only one; Magma's words else
            v, rhs = list(x), "[%s]" % _elt_type(x)
            # (a declared universe other than the integers or a prime field
            # of p: Magma's words, not its items' (CORR-A6D-1))
            u = getattr(x, "universe", None)
            if u is not None and u is not _ZZ and not (isinstance(u, _MFinField) and (u.n == 1 and u.p == self.p or u is self)):
                raise MagmaError("Illegal coercion\nLHS: FldFin\nRHS: %s" % rhs, "'!'", False)
            coeff = lambda c: (isinstance(c, int) and not isinstance(c, bool)) or (_is_ff(c) and _ffwrap(c.parent()).n == 1 and _ffwrap(c.parent()).p == self.p)
            if v and all(coeff(c) for c in v) and (self.n > 1 or len(v) == 1):
                if len(v) == self.n or self.n == 1:
                    return sum((self.K(int(c)) * self.K.gen() ** i for i, c in enumerate(v)), self.K(0))
                raise MagmaError("coercion of a sequence of %d coefficients into a field of degree %d is not supported yet" % (len(v), self.n), "'!'", False)
            if v and any(_is_ff(c) for c in v) and all(_is_ff(c) or (isinstance(c, int) and not isinstance(c, bool)) for c in v):
                # (a sequence of finite fields' elements, integers among them:
                # its universe a finite field)
                if len(v) != 1:
                    raise MagmaError("Sequence must have length 1 to lift into this finite field\nLHS: FldFin\nRHS: [FldFinElt]", "'!'", False)
                return self._magma_coerce(v[0])
            raise MagmaError("Illegal coercion\nLHS: FldFin\nRHS: %s" % rhs, "'!'", False)
        raise MagmaError("Illegal coercion")

    def __iter__(self):
        # Magma's order: 0, 1, ..., p - 1 for a prime field; else 1, w,
        # w^2, ..., w^(q-2) and then 0
        if self.n == 1:
            # (lazily: the first elements without all p (HARD-581-2))
            return (self.K(i) for i in range(self.p))
        def powers():
            g, x = self.K.gen(), self.K(1)
            for _ in range(self.q - 1):
                yield x
                x = x * g
            yield self.K(0)
        return powers()


def _ffwrap(K):
    w = _FF.get(id(K))
    if w is None:
        w = _FF[id(K)] = _MFinField(K)
    return w


# Subfields and common fields (design/plan-finite-fields F1): the math, its
# budgets and the one image cache are shared with Sage mode in
# lib/_sage_ffsub.py (William's rule: nothing nontrivial Magma-only); here
# only Magma's words and its field objects (_MFinField, whose K is the
# shared field).


def _ff_refuse(what, A, B, where, pos=None):
    """The refusal (a function making it) for subfield work past F1's
    bounds: fields of more than 2^20 elements, or the work."""
    return lambda: MagmaError("%s of elements of %s and %s is not supported yet (subfields are computed here only in fields of at most 2^20 elements, within a bounded amount of work)" % (what, _ff_desc(A), _ff_desc(B)), where, where != "'!'", pos)


def _ff_desc(W):
    return "GF(%d)" % W.p if W.n == 1 else "GF(%d^%d)" % (W.p, W.n)


def _ff_cover(Ws, refuse):
    return _ffsub.cover([W.K for W in Ws], refuse)


def _ff_up(x, U, budget, refuse):
    return _ffsub.up(x, U.K, budget, refuse)


def _ff_down(x, S, budget, refuse):
    return _ffsub.down(x, S.K, budget, refuse)


def _ff_in_sub(x, S, budget, refuse):
    return _ffsub.in_sub(x, S.K, budget, refuse)


def _ff_promote(xs, what, where, pos=None):
    """xs with their finite fields' elements put into the smallest field
    containing them all, and that field (_ffsub.promote: one budget,
    admitted whole first), refused in Magma's words."""
    Ws = list({id(x.parent()): _ffwrap(x.parent()) for x in xs if _is_ff(x)}.values())
    refuse = _ff_refuse(what, Ws[0], Ws[1] if len(Ws) > 1 else Ws[0], where, pos)
    out, U = _ffsub.promote(xs, refuse)
    return out, _ffwrap(U)


def GF(q, n=None):
    """GF(q) or GF(p, n): the finite field with q = p^n elements, defined
    (as in Magma) by the Conway polynomial."""
    q = _coerce_int(q)
    if n is None and q < 2:
        raise _arg_error("GF", "Argument 1 (%d) should be >= 2" % q)
    if n is not None:
        # GF(p, n): a prime, and a degree of at least 1 (CORR-581-1)
        n = _coerce_int(n)
        # (the base's size first: no primality test of a huge one (HARD-E6A-1))
        if q.bit_length() > _FF_BITS:
            raise MagmaError("GF of a field of more than %d bits is not supported yet" % _FF_BITS, "'GF'")
        if not _sa.is_prime(q):
            raise MagmaError("Argument 1 (%d) should be prime" % q, "'GF'")
        if n < 1:
            raise MagmaError("Argument 2 (%d) should be >= 1" % n, "'GF'")
        # p^n has at least n * (bits of p - 1) + 1 bits: refused before
        # the power is computed (HARD-581-1)
        if n > _FF_BITS or n * (q.bit_length() - 1) >= _FF_BITS:
            raise MagmaError("GF of a field of more than %d bits is not supported yet" % _FF_BITS, "'GF'")
        q = q ** n
    if q.bit_length() > _FF_BITS:
        raise MagmaError("GF of a field of more than %d bits is not supported yet" % _FF_BITS, "'GF'")
    if q < 2 or _sff._is_prime_power(q) is None:
        raise MagmaError("Argument 1 (%d) is not a prime power" % q, "'GF'")
    try:
        pn = _sff._is_prime_power(q)
        if pn[1] > 1:
            # (the cold search's work bounded by CONWAY_WORK, before GF(q)
            # is made; a cache hit is free)
            _sff._conway(pn[0], pn[1])
        K = _sff.GF(q)
    except _sff.ConwayBudgetExceeded:
        raise MagmaError("GF(%d): the search for its Conway polynomial is beyond the work allowed here, and is not supported yet" % q, "'GF'")
    except NotImplementedError:
        # Magma uses other polynomials beyond its tables: not known yet
        raise MagmaError("GF(%d): the defining polynomial of this field is not supported yet" % q, "'GF'")
    return _ffwrap(K)


FiniteField = GaloisField = GF


def _ff_str(x):
    """A finite field element as Magma prints it: an integer in a prime
    field; else 0, an element of the prime field as an integer, a power of
    the generator (fields of at most 2^20 elements), or a polynomial in
    it."""
    F = _ffwrap(x.parent())
    if F.n == 1:
        return str(int(x))
    c = [int(a) for a in x.list()]
    if not any(c[1:]):
        return str(c[0])
    name = F._gen_name()
    if F.q <= _FF_POWERS_MAX:
        k = int(x.log(F.K.gen()))
        return name if k == 1 else "%s^%d" % (name, k)
    terms = []
    for i in range(len(c) - 1, -1, -1):
        if c[i]:
            mon = "1" if i == 0 else name if i == 1 else "%s^%d" % (name, i)
            terms.append(mon if c[i] == 1 and i else ("%d" % c[i] if i == 0 else "%d*%s" % (c[i], mon)))
    return " + ".join(terms)


def _ff_field(x, what):
    if isinstance(x, _MFinField):
        return x
    raise MagmaError("Bad argument types", "'%s'" % what)


def Characteristic(F):
    """The characteristic of a ring."""
    if isinstance(F, _MFunRat):
        return F._char
    if isinstance(F, _MFinField):
        return F.p
    if isinstance(F, _MResRing):
        return F.m
    if isinstance(F, _MFFPolyRing):
        return F.F.p
    if F is _ZZ or F is _QQ:
        return 0
    raise MagmaError("Bad argument types", "'Characteristic'")


def PrimitiveElement(F):
    """A generator of the multiplicative group of a finite field (for
    GF(p^n): its generator, a root of the Conway polynomial)."""
    F = _ff_field(F, "PrimitiveElement")
    return F.K.multiplicative_generator()


def Order(x):
    """The multiplicative order of a nonzero finite field element."""
    if _is_ff(x):
        if not x:
            raise _arg_error("Order", "Can not take order of zero element")
        return int(x.multiplicative_order())
    if isinstance(x, _MResElt):
        return x._magma_order()
    if isinstance(x, _MPerm):
        return x._order()
    if isinstance(x, (_MSymGroup, _MDihedralGroup)):
        return x._magma_card()  # (a group's order, #G)
    raise MagmaError("Order of this argument is not supported yet", "'Order'")


def IsPrimitive(x):
    """Whether a finite field element generates the multiplicative group."""
    if _is_ff(x):
        return bool(x) and int(x.multiplicative_order()) == int(x.parent().order()) - 1
    raise MagmaError("IsPrimitive of this argument is not supported yet", "'IsPrimitive'")


# ------------------------------------------------------------------ sequences and sets

# Intrinsic procedures are functions here: Append(S, x) returns the new
# sequence, and the statement Append(~S, x) assigns it back to S.

def Append(s, x):
    x = _lift("Append", s, x, "Cannot coerce element into the universe")
    s = _own(s) if isinstance(s, MSeq) else _as_seq(s)
    s.append(x)
    _settle(s)
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
        return _qelt(x) if num else _NOCOERCE
    if t == "R":
        # (at the field's precision: [RealField(10) | 1/3] holds a real of
        # 10 digits, never the default 30, astra2 on de17ca12)
        prec = ring.prec if isinstance(ring, RealField_) else None
        return MReal.of(x, prec) if num or isinstance(x, MReal) else _NOCOERCE
    if t in ("ZX", "QX"):
        if num:
            if t == "ZX" and _Fraction(x).denominator != 1:
                return _NOCOERCE
            # (a constant of the ring, as Magma's: 2 put in a sequence over
            # Q[x] is a polynomial, and S[1] div 3 is 2/3, never 0)
            # (without the ring to build it in: refused, never the number)
            return ring(x) if isinstance(ring, _sp.PolynomialRing_) else _NOCOERCE
        if isinstance(x, _sp.Polynomial) and dx[0] in ("ZX", "QX"):
            c = [_m_num(v) for v in x.list()]
            if t == "ZX" and any(_Fraction(v).denominator != 1 for v in c):
                return _NOCOERCE
            return ring(c) if ring is not None and hasattr(ring, "gen") else x
        return _NOCOERCE
    if t == "NF":
        if num:
            # (an element of the field, as Magma's: 2 in [K | 2] is a
            # FldNumElt, never an integer, astra2 WA-012)
            # (without the field to build it in: refused, never the number)
            return ring(_qelt(x)) if isinstance(ring, _snf.NumberField_absolute) else _NOCOERCE
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


class _Refused(Exception):
    """A value _like refused, for callers with their own error."""


def _lift(name, s, x, cannot="Cannot lift element into sequence"):
    """x converted into the universe of s, for Include, Exclude, Append and
    Insert (the declared universe, else that of an element); Magma's
    errors if not."""
    w = _universe(s, True)
    if isinstance(getattr(s, "universe", None), (_MFinField, _MFFPolyRing, _MResRing)):
        # (declared, and known to _coerce_struct: Integers(5) too, so that 7
        # appended is 2, never 7, CORR-3FA-1)
        w = ("struct", s.universe)
    if w is None:
        return x
    if w[0] == "struct":
        if isinstance(w[1], _MVectorSpace) and name in ("Append", "Insert", "Include"):
            _vspace_admit(w[1], len(s) + 1, "'%s'" % name)  # (the collection it grows into)
        y = _coerce_struct(x, w[1])
        if y is None:
            y = _into(x, ("?",), w[1])
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
        if _is_ff(e) or isinstance(e, (_MFFPoly,) + _FFLIN) or (_is_ff(x) and de in (("Z",), ("Q",))):
            # (a finite field's elements: Magma's coercion, CORR-9348-1)
            y = _elt_into(x, e)
            if y is None:
                y = _NOCOERCE
        elif de is not None:
            y = _into(x, de, _elt_ring(e))
        else:
            kx, ke = _eq_kind(x), _eq_kind(e)
            ok = ((kx == ke == "struct" and _struct_cat(x) == _struct_cat(e))
                  or (kx in ("set", "mset") and ke in ("set", "mset") and not (kx == "mset" and ke == "set"))
                  or (kx == ke == "map") or (kx == ke == "grp")
                  or (kx == ke == "tup" and len(x) == len(e)))
            if ke == "seq" and not len(e) and name == "Index" and not (kx == "seq" and not len(x)):
                raise MagmaError(cannot, "'%s'" % name)
            if ke == "seq" and kx != "seq" and not len(e):
                raise MagmaError("Sequence mutation failed", "'%s'" % name)
            if ok and ke in ("set", "mset", "tup") or kx == ke == "seq":
                # a collection goes in made like the elements, all the way
                # down: into their kind of set, their universes (CORR-400-2)
                try:
                    y = _like(e, x, _Refused)
                    ok = True
                except _Refused:
                    ok = False
            elif not (kx in ("set", "mset") and ke in ("set", "mset")):
                y = x
            if not ok:
                y = _NOCOERCE
    if y is _NOCOERCE:
        if isinstance(s, MSet):
            u = w[1] if w[0] == "struct" else (_ffwrap(w[1].parent()) if _is_ff(w[1]) else None)
            if _is_ff(x) and isinstance(u, _MFinField) and u.p == _ffwrap(x.parent()).p:
                # (a field's element into a set over a field it doesn't go
                # into: Magma's words for K!x, Include({E!1}, a))
                raise MagmaError("No embedding known into LHS field", "'%s'" % name, False)
            raise MagmaError("Illegal coercion", "'%s'" % name, False)
        raise MagmaError(cannot, "'%s'" % name)
    return y


def Include(s, x):
    x = _lift("Include", s, x)
    if isinstance(s, MSet):
        t = _own(s)
        t.add(x)
        _settle(t)
        return t
    s = _own(_as_seq(s))
    if not any(_cmpeq(x, y) for y in s):
        s.append(x)
        _settle(s)
    return s


def Exclude(s, x):
    x = _lift("Exclude", s, x)
    if isinstance(s, MSet):
        t = _own(s)
        _remember(t)
        t.remove(x)
        return t
    s = _own(_as_seq(s))
    _remember(s)
    for k, y in enumerate(s):
        if _cmpeq(x, y):
            del s[k]
            break
    return s


def Remove(s, i):
    s = _own(s) if isinstance(s, MSeq) else MSeq(s)
    _check_index(len(s), i)
    _remember(s)
    del s[i - 1]
    return s


def Insert(s, i, x):
    x = _lift("Insert", s, x, "Cannot coerce element into the universe")
    s = _own(s) if isinstance(s, MSeq) else _as_seq(s)
    s.insert(i - 1, x)
    _settle(s)
    return s


def Reverse(s):
    if isinstance(s, str):
        return s[::-1]
    t = _as_seq(s)
    t.reverse()
    return t


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
        return _carry(MSeq(sorted(items), _declared(s)), s)
    import functools
    order = sorted(range(len(items)), key=functools.cmp_to_key(lambda i, j: f(items[i], items[j])))
    # the permutation taking positions in the result to positions in s
    # (keeping a declared universe as the default sort does, CORR-CBA-2)
    return _multi([_carry(MSeq((items[i] for i in order), _declared(s)), s), Perm(i + 1 for i in order)])


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
    return _carry(MSet(s, universe=_declared(s)), s)


@_signature("Subsets", "SetEnum", ret="SetEnum")
def _subsets_all(S):
    """The set of all subsets of the set S."""
    return _subsets(S, None)


@_signature("Subsets", "SetEnum", "RngIntElt", ret="SetEnum")
def _subsets_k(S, k):
    """The set of the subsets of the set S with k elements."""
    if k < 0:
        raise _arg_error("Subsets", "Argument 2 (%d) should be >= 0" % k)
    return _subsets(S, k)


def _subsets(S, k):
    """(admitted by their number before any is made)"""
    items = S.ordered()
    n = len(items)
    count = 2 ** n if k is None else (_math.comb(n, k) if k <= n else 0)
    # (charged together with the elements copied into them: n * 2^(n-1) in
    # all subsets, k * C(n, k) in those of k elements; a subset's own set
    # counts as 4 elements, so many small subsets are bounded too, HARD-DFC-2)
    cells = (n * 2 ** (n - 1) if n else 0) if k is None else k * count
    if 4 * count + cells > _COLLECT_MAX:
        raise MagmaError("a set of subsets holding more than %d elements in all is not supported yet" % _COLLECT_MAX, "'Subsets'")
    sizes = range(n + 1) if k is None else [k]
    return MSet(MSet(c) for r in sizes for c in _itertools.combinations(items, r))


def SetToSequence(s):
    return _carry(MSeq(s.ordered() if isinstance(s, MSet) else s, _declared(s)), s)


Setseq = SetToSequence


def SequenceToSet(s):
    return _carry(MSet(s, universe=_declared(s)), s)


def Set(s):
    return _carry(MSet(s, universe=_declared(s)), s)


def _declared(s):
    """The universe s was made with (a structure, as {R | } or an image
    under a map has it), which a conversion of it keeps, as Magma's:
    Setseq(f({})) for f into a polynomial ring over GF(7) is that ring's
    sequence, what is appended goes into it (CORR-3FA-1); None for none."""
    u = getattr(s, "universe", None)
    return u if u is not None and (_is_struct(u) or isinstance(u, (_MFinField, _MResRing, _MFFPolyRing, _MVectorSpace))) else None


def Eltseq(x):
    if isinstance(x, _sp.Polynomial):
        return Coefficients(x)
    if _is_ff(x):
        # coefficients on the power basis, in the prime field
        F = _ffwrap(x.parent())
        if F.n == 1:
            return MSeq([x])
        P = _sff.GF(F.p)
        return MSeq([P(int(c)) for c in x.list()])
    if isinstance(x, _MNFElt):
        # (its rational coefficients on 1, a, ..., a^(d-1), in the
        # rationals as Magma's)
        c = list(x._c)
        c += [0] * (x.parent().degree() - len(c))
        return MSeq([_qelt(_Fraction(q)) for q in c], _QQ)
    if isinstance(x, MSeq) and isinstance(x.universe, _MVectorSpace):
        return _carry(MSeq(x, x.universe), x)  # (its vector space kept, astra CORR-7E2-1)
    if isinstance(x, MSet):
        # (a set of vectors, of any kind, or one over a vector space: Magma's
        # error, which names the vectors' type; astra CORR-5C2-1)
        u = x.universe if isinstance(x.universe, _MVectorSpace) else None
        v = next((y for y in x.items if isinstance(y, _MVector)), None)
        if u is not None or v is not None:
            et = "%sElt[%s]" % (u._cat(), _ring_cat(u.base)) if u is not None else _ext_type(v)
            raise MagmaError("Bad argument types\nArgument types given: %s[%s]" % (_type(x), et), "'Eltseq'", True)
    if isinstance(x, _MVectorSpace):
        raise _bad_types("Eltseq", (x,))
    return MSeq(x)


def Universe(s):
    u = getattr(s, "universe", None)
    if u is not None:
        return u
    inf = getattr(s, "_inf", None)
    if inf is _ZZ or inf is _QQ:
        return inf
    items = list(_iter(s))
    if not items:
        if isinstance(s, (MSeq, MRange)):
            raise MagmaError("Illegal null sequence", "'Universe'")
        raise MagmaError("Universe of an empty set is not supported yet", "'Universe'")
    if all(isinstance(x, int) and not isinstance(x, bool) for x in items):
        return _ZZ
    if all(isinstance(x, (int, _Fraction)) and not isinstance(x, bool) for x in items):
        return _QQ
    # (finite fields' elements, integers among them: their one field, the
    # smallest containing them all, which a literal's items were put in)
    fields = {id(x.parent()): x.parent() for x in items if _is_ff(x)}
    if len(fields) == 1 and all(_is_ff(x) or (isinstance(x, int) and not isinstance(x, bool)) for x in items):
        return _ffwrap(fields.popitem()[1])
    # (never None, which printed nothing: a set of sets is Magma's "Set of
    # subsets of Integer Ring", which Sagebrush doesn't model)
    raise MagmaError("Universe of this %s is not supported yet" % _type_of(s), "'Universe'")


# Magma's random generator can't be reproduced: a program that uses SetSeed
# or GetSeed (intrinsics Sagebrush doesn't have; _report notes them) expects
# Magma's numbers, so from then on Random refuses rather than give others
_SEEDED = []


# Random(S) of a collection without a known size enumerates at most this
# many elements (HARD-581-2)
_RANDOM_ENUM_MAX = 10 ** 6


def _random_elt(s, random):
    """Random(S): an element of S, chosen without enumerating S when its
    size is known: a finite field by its coefficients, a range by its
    index (HARD-581-2)."""
    if isinstance(s, _MFinField):
        if s.n == 1:
            return s.K(random.randrange(s.p))
        g = s.K.gen()
        return sum((s.K(random.randrange(s.p)) * g ** i for i in range(s.n)), s.K(0))
    if isinstance(s, MRange):
        n = s.size()
        if not n:
            raise MagmaError("Argument 1 is not non-empty", "'Random'")
        return s[random.randrange(n)]
    if isinstance(s, MSet) and s.kind == "multi":
        # (each element as often as its multiplicity)
        k = random.randrange(len(s))
        for x in s.items:
            k -= s.keys[_key(x)][1]
            if k < 0:
                return x
    if isinstance(s, MSet):
        v = s.items
    elif isinstance(s, (MSeq, MTuple, list, tuple)):
        v = s
    else:
        v = []
        for x in _iter(s):
            if len(v) == _RANDOM_ENUM_MAX:
                raise MagmaError("Random of a structure of more than %d elements is not supported yet" % _RANDOM_ENUM_MAX, "'Random'")
            v.append(x)
    v = list(v) if not isinstance(v, (list, tuple)) else v
    if not v:
        raise MagmaError("Argument 1 is not non-empty", "'Random'")
    return random.choice(v)


def Random(s, b=None):
    import random
    if _SEEDED:
        raise MagmaError("Random after SetSeed or GetSeed is not supported yet: Sagebrush can't reproduce Magma's random numbers", "'Random'")
    if b is None:
        return _random_elt(s, random)
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


def CharacteristicPolynomial(T, sub=None):
    if _is_ff(T):
        return _ff_absolute("CharacteristicPolynomial", T) if sub is None else _ff_relative("CharacteristicPolynomial", T, sub)
    if sub is not None:
        raise MagmaError("CharacteristicPolynomial of these arguments is not supported yet", "'CharacteristicPolynomial'")
    if isinstance(T, _MFFMat):
        # (in a new polynomial ring, its variable unnamed: $.1, as Magma's)
        _ffm_square(T, "CharacteristicPolynomial")
        _ffm_elim(T, "CharacteristicPolynomial")
        R = _ffpoly_ring(T.F)
        return _MFFPoly(R, R.P(T.M.charpoly()))
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
import _sage_ffmat as _sffmat


class _MNFElt(_snf.NumberFieldElement):
    __slots__ = ()

    def __repr__(self):
        # Magma: a common denominator in front, 1/2*(b^2 + b)
        c = self._c
        d = 1
        for x in c:
            d = d * x.denominator // _math.gcd(d, x.denominator)
        v = self._K._magma_var()
        if d == 1 or sum(1 for x in c if x) <= 1:
            return _snf._repr_poly(c, v)
        num = [x * d for x in c]
        return "1/%d*(%s)" % (d, _snf._repr_poly(num, v))

    def _magma_parent(self):
        return self._K


class _MNumberField(_snf.NumberField_absolute):
    _element_class = _MNFElt
    _magma_block = True

    def __init__(self, f, quadratic=False, irreducible=False):
        super().__init__(f, "$.1", irreducible=irreducible)
        self._quadratic = quadratic
        self._order = None

    def _magma_names(self, names):
        self._name = names[0]

    def _magma_var(self):
        # (its generator unnamed: K.1 for the variable K holding the field,
        # as Magma prints it, $.1 when none does)
        if self._name != "$.1":
            return self._name
        v = _global_name(self)
        return "%s.1" % v if v is not None else "$.1"

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
# then what is left must be decided without factoring it, HARD-731-1; and
# no more than this many bits at all, checked before any of it: the
# primality test and isqrt of a 44497-bit integer took 30 s, HARD-4A9-1)
_SQUAREFREE_TRIAL = 10 ** 5
_SQUAREFREE_BITS = 1024


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
    if abs(d).bit_length() > _SQUAREFREE_BITS:
        raise MagmaError("QuadraticField of an integer of more than %d bits is not supported yet" % _SQUAREFREE_BITS, "'QuadraticField'")
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


# (the degree of a cyclotomic field built: Phi_n is made in O(2^k d) steps
# (k <= 9 primes of n, d its degree), never factored; but invariants of the
# field (its maximal order, class group) cost far more with the degree)
_CYCLO_DEGREE_MAX = 24
# (Magma's own bound: "not small", checked against Magma 2.18, 2^30 is)
_CYCLO_SMALL = 1 << 30
# (its class group and units, by the engine's search, only up to this
# degree, measured on the test VMs: of degree 12 (orders 13, 21, 28, 36)
# 7 to 8 s; of degree 16 CyclotomicField(17)'s more than 60 s, of degree
# 18 about 40 s, of degree 20 and 24 more than 60 s; Magma 2.18 took more
# than 60 s for CyclotomicField(23) and those of degree 24)
_CYCLO_CLASS_MAX = 12


class _MCycField(_MNumberField):
    """CyclotomicField(n): Q(zeta_n), defined by the n-th cyclotomic
    polynomial, its generator printed zeta_n until named; one field for
    each n, as Magma's (a name given to one is the generator's of every
    CyclotomicField(n)).  Checked against Magma 2.18."""

    def __init__(self, n, f):
        super().__init__(f, irreducible=True)
        self._cyclotomic_order = n
        self._name = "zeta_%d" % n

    def _magma_gen(self, i):
        # (of degree 1, n = 1 or 2, the generator is the root, 1 or -1)
        return self(-self._f[0]) if self._n == 1 else self.gen()

    def __repr__(self):
        return "Cyclotomic Field of order %d and degree %d" % (self._cyclotomic_order, self._n)

    def _class_admit(self):
        if self._n > _CYCLO_CLASS_MAX:
            raise MagmaError("the class group or units of a cyclotomic field of degree more than %d are not supported yet" % _CYCLO_CLASS_MAX)

    def _bnfdata(self):
        self._class_admit()
        return super()._bnfdata()

    def _proven_bnf(self, what):
        self._class_admit()
        return super()._proven_bnf(what)

    def _magma_coerce(self, x):
        if isinstance(x, _MNFElt) and x.parent() is not self:
            if isinstance(x.parent(), _MCycField):
                # (Magma's has it where zeta_m is in Q(zeta_n))
                raise MagmaError("coercion of an element of another cyclotomic field is not supported yet", "'!'", False)
            raise MagmaError("Illegal coercion\nLHS: FldCyc\nRHS: %s" % _type_of(x), "'!'", False)
        return super()._magma_coerce(x)


_CYC = {}
_CYC_IDS = set()


def _cyc_elt(x):
    return isinstance(x, _MNFElt) and isinstance(x.parent(), _MCycField)


def _cyc_embed(x, K):
    """x, an element of Q(zeta_m), in the cyclotomic field K = Q(zeta_n)
    when Q(zeta_m) is in it, else None: with m' and n' the even ones of m,
    2m and n, 2n (Q(zeta_m) is Q(zeta_2m) for m odd), when m' divides n';
    zeta_m is zeta_n'^(n'/m'), and for n odd zeta_2n is -zeta_n^((n+1)/2).
    As Magma's ([Q(zeta_5) | zeta_10] is -z^3; checked against Magma
    2.18)."""
    m, n = x.parent()._cyclotomic_order, K._cyclotomic_order
    mp = m if m % 2 == 0 else 2 * m
    N = n if n % 2 == 0 else 2 * n
    if N % mp:
        return None
    e = (N // m) % N
    z = K._magma_gen(1)
    img = z ** e if N == n else (-1) ** e * z ** (e * (n + 1) // 2)
    r, p = K(0), K(1)
    for c in x._c:
        r = r + p * K(c)
        p = p * img
    return r


def _nf_items(items, K, kind):
    """The items of a collection whose universe is the number field K, as
    Magma coerces them: integers and rationals into K, K's own elements as
    they are, another cyclotomic field's element when its field is in K
    (_cyc_embed); else Magma's error (another number field's element, a
    cyclotomic field's not in K); else refused."""
    fail = lambda k: MagmaError("Coerce failed for sequence element" if kind == "seq" else "Cannot coerce argument %d into the universe" % (k + 1), _UNIVERSE_FAIL[kind])
    out = []
    for k, x in enumerate(items):
        if x is _UNDEF or (isinstance(x, _MNFElt) and x.parent() is K):
            out.append(x)
        elif _num(x):
            y = _into(x, _udesc(K), K)
            if y is _NOCOERCE:
                raise fail(k)
            out.append(y)
        elif isinstance(x, _MNFElt):
            y = _cyc_embed(x, K) if _cyc_elt(x) and isinstance(K, _MCycField) else None
            if y is None and all(q == 0 for q in list(x._c)[1:]):
                # (another field's element of rational value goes in as that
                # rational, as Magma's [K | L!3]: astra2 on e3d3d0e1)
                c0 = list(x._c)[:1]
                y = _into(_m_num(_Fraction(c0[0]) if c0 else 0), _udesc(K), K)
                y = None if y is _NOCOERCE else y
            if y is None:
                raise fail(k)
            out.append(y)
        else:
            raise MagmaError("a collection over a number field holding a %s is not supported yet" % _type_of(x), _UNIVERSE_FAIL[kind])
    return out


def _cyclotomic_poly(n, ps):
    """Phi_n, constant first, n > 2 with the distinct primes ps: the product
    of (1 - x^d)^mu(n/d) over the divisors d of n, as power series to its
    degree (each factor a pass over the coefficients)."""
    D = n
    for p in ps:
        D = D // p * (p - 1)
    c = [1] + [0] * D
    for mask in range(1 << len(ps)):
        m, k = 1, 0
        for i, p in enumerate(ps):
            if mask >> i & 1:
                m *= p
                k += 1
        d = n // m
        if d > D:
            continue
        if k % 2 == 0:
            # (times 1 - x^d)
            for i in range(D, d - 1, -1):
                c[i] -= c[i - d]
        else:
            # (divided by 1 - x^d: times 1 + x^d + x^2d + ...)
            for i in range(d, D + 1):
                c[i] += c[i - d]
    return c


def CyclotomicField(n):
    if isinstance(n, bool) or not isinstance(n, int):
        raise _bad_types("CyclotomicField", (n,))
    if n <= 0 or n >= _CYCLO_SMALL:
        raise _arg_error("CyclotomicField", "Argument 1 (%d) is not small and positive" % n)
    K = _CYC.get(n)
    if K is not None:
        return K
    ps, m, p = [], n, 2
    while p * p <= m:
        if m % p == 0:
            ps.append(p)
            while m % p == 0:
                m //= p
        p += 1
    if m > 1:
        ps.append(m)
    d = n
    for p in ps:
        d = d // p * (p - 1)
    if d > _CYCLO_DEGREE_MAX:
        raise MagmaError("CyclotomicField of degree more than %d is not supported yet" % _CYCLO_DEGREE_MAX, "'CyclotomicField'")
    f = [-1, 1] if n == 1 else [1, 1] if n == 2 else _cyclotomic_poly(n, ps)
    K = _CYC[n] = _MCycField(n, f)
    _CYC_IDS.add(id(K))
    return K


def _cyc_check(o, a, b, pos):
    """a o b, one of them a cyclotomic field's element (o an arithmetic
    operator, eq or ne): returns where the number field rules compute it as
    Magma does (with an integer or rational, or an element of the same
    field; a power by an integer); Magma's error where it was seen (checked
    against Magma 2.18); else refused: Magma computes with another
    cyclotomic field's elements in a larger one, with matrices, ..."""
    ca = _cyc_elt(a)
    x, y = (a, b) if ca else (b, a)
    num = lambda v: isinstance(v, (int, _Fraction)) and not isinstance(v, bool)
    own = num(y) or (_cyc_elt(y) and y.parent() is x.parent())
    both = lambda: MagmaError("Bad argument types\nArgument types given: FldCycElt[FldRat], FldCycElt[FldRat]", "'%s'" % o, True, pos)
    if o == "^":
        if ca and isinstance(b, int) and not isinstance(b, bool):
            return
        if ca and own:
            raise both()
    elif o in ("div", "mod"):
        if own:
            raise both()
    elif o in ("+", "-", "*", "/", "eq", "ne"):
        if own:
            if o == "/" and y is b and (b == 0):
                raise MagmaError("Argument 2 is not non-zero", "'/'", True, pos)
            return
        # (Magma's words for these, as seen: a polynomial added, a real
        # multiplied, a finite field's element added)
        if (o == "+" and (isinstance(y, _sp.Polynomial) or _is_ff(y))) or (o == "*" and isinstance(y, MReal)):
            raise _bad_types(o, (a, b), pos)
        if isinstance(y, _MNFElt) and not _cyc_elt(y) and o != "ne":
            ext = lambda v: ("FldQuadElt[FldRat]" if v.parent()._quadratic else "FldNumElt[FldRat]") if not _cyc_elt(v) else "FldCycElt[FldRat]"
            raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (ext(a), ext(b)), "'%s'" % o, True, pos)
    raise MagmaError("'%s' of a cyclotomic field's element and %s is not supported yet" % (o, "an element of another cyclotomic field" if _cyc_elt(y) else "a %s" % _type_of(y)), "'%s'" % o, True, pos)


def _base_ring(name, x):
    """BaseRing(x) and CoefficientRing(x): the ring of a polynomial ring,
    of a matrix, vector or matrix space, of a polynomial; the rationals of
    the rationals and of a number field; the integers of its maximal order
    (BaseRing).  Magma's Bad argument types for what it has none of, as
    seen; refused for anything else.  Checked against Magma 2.18."""
    zq = lambda R: _ZZ if R == _sp.ZZ else _QQ if R == _sp.QQ else None
    r = None
    if isinstance(x, _MFunRat):
        r = x._ground
    elif isinstance(x, _sp.PolynomialRing_):
        r = zq(x.base_ring())
    elif isinstance(x, _sp.Polynomial):
        r = zq(x.parent().base_ring())
    elif isinstance(x, (_MFFPolyRing, _MFFMat, _MFFMatSpace)):
        r = x.F
    elif isinstance(x, _MFFPoly):
        r = x.R.F
    elif x is _QQ or isinstance(x, _snf.NumberField_absolute):
        r = _QQ
    elif isinstance(x, _MOrder):
        r = _ZZ
    elif isinstance(x, (_smat.Matrix, _smat.MatrixSpace_)):
        r = zq(x.base_ring())
    elif isinstance(x, _MVector):
        r = zq(x._base)
    if r is not None:
        return r
    if x is _ZZ or isinstance(x, (_MFinField, _MResRing, RealField_, _MResElt, _Fraction, MSeq, MRange)) or _is_ff(x) or (
            isinstance(x, int) and not isinstance(x, bool)) or isinstance(x, _MNFElt):
        if isinstance(x, _MNFElt):
            t = "FldCycElt" if _cyc_elt(x) else "FldQuadElt" if x.parent()._quadratic else "FldNumElt"
            raise MagmaError("Bad argument types\nArgument types given: %s[FldRat]" % t, "'%s'" % name, True)
        raise _bad_types(name, (x,))
    raise MagmaError("%s of a %s is not supported yet" % (name, _type_of(x)), "'%s'" % name)


def BaseRing(x):
    return _base_ring("BaseRing", x)


def CoefficientRing(x):
    return _base_ring("CoefficientRing", x)


def BaseField(x):
    if isinstance(x, _MFunRat):
        if x._ground is _ZZ:
            raise MagmaError("Rational function field is not defined over a field", "'BaseField'", True)
        return x._ground
    raise _bad_types("BaseField", (x,))


def Basis(K):
    """Basis(K), K a number field: 1, a, ..., a^(d-1) for its generator a,
    as Magma's (checked against Magma 2.18); of an integer Magma's error;
    of anything else refused (an order's prints in names Sagebrush doesn't
    give)."""
    if isinstance(K, _snf.NumberField_absolute):
        g = K._magma_gen(1)
        out, y = [], K(1)
        for i in range(K.degree()):
            out.append(y)
            y = y * g
        return MSeq(out)
    if isinstance(K, _MVectorSpace):
        # (its unit vectors, in order, as Magma's)
        return MSeq(_unit_vectors("Basis", K), K)
    if isinstance(K, (int, _MSymGroup, _MDihedralGroup)) and not isinstance(K, bool):
        raise _bad_types("Basis", (K,))
    raise MagmaError("Basis of a %s is not supported yet" % _type_of(K), "'Basis'")


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


def Norm(x, sub=None):
    if sub is not None:
        if not _is_ff(x):
            raise MagmaError("Norm of these arguments is not supported yet", "'Norm'")
        return _ff_relative("Norm", x, sub)
    if hasattr(x, "_magma_norm"):
        return x._magma_norm()
    if _is_ff(x):
        return _ff_absolute("Norm", x)
    if isinstance(x, _snf.NumberFieldElement):
        return _m_num(x.norm())
    return x * x


@_signature("Trace", "FldRatElt", ret="FldRatElt")
@_signature("Trace", "RngIntElt", ret="RngIntElt")
def _trace_rational(x):
    return x


@_signature("Trace", "FldFinElt", ret="FldFinElt")
def _trace_ff(x):
    return _ff_absolute("Trace", x)


@_signature("Trace", "FldFinElt", "FldFin", ret="FldFinElt")
def _trace_ff_relative(x, F):
    return _ff_relative("Trace", x, F)


@_signature("Trace", "FldAlgElt", ret="RngElt")
def _trace_nf(x):
    return _m_num(x.trace())


@_signature("Trace", "MtrxS", ret="RngElt")
def _trace_matrix(a):
    if a.nrows() != a.ncols():
        raise MagmaError("Argument 1 is not square", "'Trace'", True)
    return a.trace()


_unimplemented_signature("Trace", "RngUPolElt", ret="RngUPolElt")
_unimplemented_signature("Trace", "RngOrdElt", ret="RngElt")
_unimplemented_signature("Trace", "FldAlgElt", "Rng", ret="RngElt")
_unimplemented_signature("Trace", "RngOrdElt", "Rng", ret="RngElt")


def MinimalPolynomial(x, sub=None):
    if _is_ff(x):
        return _ff_absolute("MinimalPolynomial", x) if sub is None else _ff_relative("MinimalPolynomial", x, sub)
    if sub is not None:
        raise MagmaError("MinimalPolynomial of these arguments is not supported yet", "'MinimalPolynomial'")
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
        return _MVector(self._rows[i - 1], self._base)


class _MModMat(_MMatrix):
    """A square matrix of a module of matrices, Magma's RMatrixSpace or
    KMatrixSpace, not its matrix algebra: a product of matrices one of
    which is not square (A * Transpose(A)), and what Magma keeps there
    (checked against Magma 2.18, astra2's WA-026)."""
    __slots__ = ()

    def _magma_parent(self):
        return _MModSpace(self._base, self.nrows())


class _MModSpace:
    """The parent of an _MModMat (printed only)."""

    def __init__(self, base, n):
        self.base, self.n = base, n

    def __repr__(self):
        if self.base is _sa.QQ:
            return "Full KMatrixSpace of %d by %d matrices over Rational Field" % (self.n, self.n)
        return "Full RMatrixSpace of %d by %d matrices over Integer Ring" % (self.n, self.n)


def _mod_like(M, r):
    """r, made from M by Transpose, HermiteForm or EchelonForm: of M's
    module of matrices when M is (as Magma's)."""
    return _MModMat(r._base, r._rows, r.ncols()) if isinstance(M, _MModMat) and r.is_square() else r


def _mod_result(r, op, a, b=None):
    """r = a op b (b None: -a), a square matrix result kept in a module of
    matrices as Magma's (checked against Magma 2.18): a product with a
    factor not square, or with one of a module (the other a matrix or a
    scalar); a sum or difference of two of a module (with an algebra's
    matrix it is the algebra's); -B, B^n, B / c of one."""
    if not isinstance(r, _smat.Matrix) or r.nrows() != r.ncols():
        return r
    ma, mb = isinstance(a, _MModMat), isinstance(b, _MModMat)
    if op == "*" and isinstance(a, _smat.Matrix) and isinstance(b, _smat.Matrix):
        mod = ma or mb or a.nrows() != a.ncols() or b.nrows() != b.ncols()
    elif op == "*":
        mod = ma or mb
    elif op in ("+", "-") and b is not None:
        mod = ma and mb
    else:
        mod = ma
    return _MModMat(r._base, r._rows, r.ncols()) if mod else r


class _MVectorSpace:
    """The parent of a vector: Magma's full vector space (over the
    rationals) or RSpace (over the integers) of a degree (ModTupFld,
    ModTupRng), made by VectorSpace, KSpace and RSpace too.  V.i is its
    i-th unit vector; V!x, x in V, #V and Dimension(V) as Magma's (checked
    against Magma 2.18)."""

    def __init__(self, base, n):
        self.base, self.n = base, n

    def __repr__(self):
        if self.base is _sa.QQ:
            return "Full Vector space of degree %d over Rational Field" % self.n
        return "Full RSpace of degree %d over Integer Ring" % self.n

    def __eq__(self, other):
        return isinstance(other, _MVectorSpace) and (other.base, other.n) == (self.base, self.n)

    def __hash__(self):
        return hash((self.n, self.base is _sa.QQ))

    def _cat(self):
        return "ModTupFld" if self.base is _sa.QQ else "ModTupRng"

    def _vector(self, items):
        # (a vector of degree 0 prints as Magma's empty matrix: not modelled)
        if not self.n:
            raise MagmaError("a vector of degree 0 is not supported yet")
        return _MVector(items, self.base)

    def _magma_dimension(self):
        return self.n

    def _magma_degree(self):
        return self.n

    def _magma_card(self):
        raise MagmaError("Cardinality is infinite or not feasibly computable", "'#'", True)

    def _magma_gen(self, i):
        if isinstance(i, bool) or not isinstance(i, int):
            raise _bad_types(".", (self, i))
        if not 1 <= i <= self.n:
            raise MagmaError("Argument 2 (%d) should be in the range [1 .. %d]" % (i, self.n), "'.'", True)
        return self._unit(i - 1)

    def _unit(self, k):
        return self._vector([1 if j == k else 0 for j in range(self.n)])

    def _magma_contains(self, x):
        if isinstance(x, _MVector):
            if x._base is not self.base or len(x) != self.n:
                raise MagmaError("Arguments are not compatible", "'in'", True)
            return True
        if isinstance(x, (_MFFVec, _MFFMat, _smat.Matrix)):
            raise MagmaError("membership of this in a vector space is not supported yet", "'in'", True)
        raise MagmaError("Bad argument types", "'in'", True)

    def _magma_coerce(self, x):
        R = _QQ if self.base is _sa.QQ else _ZZ
        if isinstance(x, _MVector):
            if x._base is self.base and len(x) == self.n:
                return x  # (already V's: not copied; vectors are never changed in place)
            if len(x) != self.n:
                raise MagmaError("Arguments have incompatible degrees\nLHS: %s\nRHS: %s" % (self._cat(), _type_name(x)), "'!'", True)
            if self.base is _sa.ZZ and any(_Fraction(a).denominator != 1 for a in x):
                raise MagmaError("Cannot coerce element from source coefficent ring into the destination coefficient ring", "'!'", True)
            return self._vector([int(a) for a in x] if self.base is _sa.ZZ else list(x))
        if isinstance(x, (MSeq, MRange)):
            # V![a, b, ...]: a vector of the sequence's elements, each in
            # the coefficient ring
            n = x.size() if isinstance(x, MRange) else len(x)
            if n != self.n:
                raise MagmaError("Sequence argument length (%d) should be %d to be coerced into a matrix or vector" % (n, self.n), "'!'", True)
            out = []
            for k, a in enumerate(x):
                if isinstance(a, bool):
                    y = None
                elif isinstance(a, (int, _Fraction)):
                    y = _coerce_struct(a, R)
                else:
                    y = _NOCOERCE if isinstance(a, str) else None  # (a string: Magma's words)
                if y is None:
                    raise MagmaError("coercion of a sequence of these elements into a vector space is not supported yet", "'!'", True)
                if y is _NOCOERCE:
                    raise MagmaError("Cannot coerce sequence element %d into the coefficient ring" % (k + 1), "'!'", True)
                out.append(y)
            return self._vector(out)
        if isinstance(x, int) and not isinstance(x, bool) and x == 0:
            return self._vector([0] * self.n)
        if isinstance(x, (int, _Fraction, str)):
            # (a boolean, a string too: Magma's words)
            raise MagmaError("Illegal coercion\nLHS: %s\nRHS: %s" % (self._cat(), _type(x)), "'!'", True)
        raise MagmaError("coercion of a %s into a vector space is not supported yet" % _type_of(x), "'!'", True)


class _MVector(list):
    """A vector of Magma's (a row), over the integers or the rationals:
    printed (1 2 3), added, negated, scaled, and multiplied by a matrix on
    the right, v * A, as Magma does."""

    def __init__(self, items=(), base=None):
        items = list(items)
        if base is None:
            base = _sa.QQ if any(isinstance(x, _Fraction) and not isinstance(x, int) for x in items) else _sa.ZZ
        # (a rational vector's entries are rationals, the integral ones too:
        # FldRatElt, as Magma's; CORR-DFC-2)
        list.__init__(self, [_qelt(x) if base is _sa.QQ else x for x in items])
        self._base = base

    def _magma_index(self, i):
        _check_index(len(self), i)
        return self[i - 1]

    def _magma_parent(self):
        return _MVectorSpace(self._base, len(self))

    def _magma_card(self):
        raise _bad_types("#", [self])

    def __repr__(self):
        cells = [_inline(x) for x in self]
        w = max(len(c) for c in cells) if cells else 0
        return "(" + " ".join(c.rjust(w) for c in cells) + ")"

    def _with(self, o, op, name):
        # (vectors of one length over one ring: a Z-vector and a Q-vector
        # don't meet, as Magma's, CORR-DFC-3)
        if not isinstance(o, _MVector) or len(o) != len(self) or o._base is not self._base:
            raise _bad_types(name, [self, o])
        return _MVector((op(a, b) for a, b in zip(self, o)), self._base)

    def _magma_eq(self, o, op):
        if not isinstance(o, _MVector) or o._base is not self._base:
            raise _bad_types(op, [self, o])
        if len(o) != len(self):
            raise MagmaError("Arguments are not compatible\nArgument types given: %s, %s" % (_ext_type(self), _ext_type(o)), "'%s'" % op, True)
        return all(a == b for a, b in zip(self, o))

    def __truediv__(self, o):
        if self._base is not _sa.QQ or isinstance(o, bool) or not isinstance(o, (int, _Fraction)):
            raise MagmaError("dividing a vector over the integers, or by this, is not supported yet", "'/'", True)
        if o == 0:
            raise MagmaError("Division by zero", "'/'", True)
        return _MVector((a / o for a in self), self._base)

    def __add__(self, o):
        return self._with(o, lambda a, b: a + b, "+")

    def __sub__(self, o):
        return self._with(o, lambda a, b: a - b, "-")

    def __neg__(self):
        return _MVector((-a for a in self), self._base)

    def __mul__(self, o, left=False):
        if isinstance(o, _smat.Matrix):
            # v * A: the row vector times the matrix, over one ring (CORR-DFC-3)
            if o._base is not self._base:
                raise MagmaError("Arguments have incompatible coefficient rings", "'*'", True)
            if o.nrows() != len(self):
                raise _bad_types("*", [self, o])
            return _MVector((sum((a * r[j] for a, r in zip(self, o._rows)), 0) for j in range(o.ncols())), self._base)
        if isinstance(o, (int, _Fraction)) and not isinstance(o, bool):
            # (a rational scalar times an integral vector only when it is
            # an integer, as Magma's)
            if self._base is _sa.ZZ and _Fraction(o).denominator != 1:
                types = ("FldRatElt", _ext_type(self)) if left else (_ext_type(self), "FldRatElt")
                raise MagmaError("Arguments are not compatible\nArgument types given: %s, %s" % types, "'*'", True)
            return _MVector((a * (int(o) if self._base is _sa.ZZ else o) for a in self), self._base)
        raise _bad_types("*", [self, o])

    def __rmul__(self, o):
        if isinstance(o, (int, _Fraction)) and not isinstance(o, bool):
            return self.__mul__(o, left=True)  # (o on the left: its words name it first)
        raise _bad_types("*", [o, self])

    def __eq__(self, o):
        return isinstance(o, _MVector) and list.__eq__(self, o)

    def __ne__(self, o):
        return not self == o

    __hash__ = None


def _vector_items(Q):
    """Q's elements, its size admitted first: a lazy range is never
    expanded past the collection bound (HARD-DFC-1)."""
    n = Q.size() if isinstance(Q, MRange) else len(Q)
    if n > _COLLECT_MAX:
        raise MagmaError("a vector of more than %d entries is not supported yet" % _COLLECT_MAX, "'Vector'")
    return list(Q)


def _vector_base(R):
    if R is _ZZ:
        return _sa.ZZ
    if R is _QQ:
        return _sa.QQ
    raise MagmaError("Vector over a ring other than the integers or the rationals is not supported yet", "'Vector'")


@_signature("Vector", "SeqEnum", ret="ModTupRngElt")
def _vector_seq(Q):
    """A vector of the elements of Q, over their universe (the integers, or
    the rationals with a rational among them)."""
    items = _vector_items(Q)
    if any(isinstance(x, bool) or not isinstance(x, (int, _Fraction)) for x in items):
        raise MagmaError("Vector of these elements is not supported yet: only integers and rationals", "'Vector'")
    if not items:
        raise MagmaError("Vector of an empty sequence is not supported yet", "'Vector'")
    # (over the sequence's universe: the rationals when declared, inferred,
    # or holding a rational, CORR-DFC-2)
    q = getattr(Q, "universe", None) is _QQ or getattr(Q, "_inf", None) is _QQ or \
        any(isinstance(x, _Fraction) and not isinstance(x, int) for x in items)
    return _MVector(items, _sa.QQ if q else _sa.ZZ)


def _vector_space(name, args, field):
    """VectorSpace(K, n), KSpace(K, n) (field) and RSpace(R, n): the full
    space of degree n over the rationals (or, RSpace, the integers), as
    Magma's; the degree at most _COLLECT_MAX, since V.i makes n entries."""
    if len(args) != 2 or isinstance(args[1], bool) or not isinstance(args[1], int) or \
            not (args[0] is _ZZ or args[0] is _QQ or _is_struct(args[0]) or isinstance(args[0], _MFinField)):
        raise _bad_types(name, args)
    R, n = args
    if field and R is _ZZ:
        raise _arg_error(name, "Argument 1 is not a field")
    if R is not _ZZ and R is not _QQ:
        raise MagmaError("%s over a ring other than the integers or the rationals is not supported yet" % name, "'%s'" % name)
    if n < 0:
        raise _arg_error(name, "Argument 2 (%d) should be >= 1" % n)
    if n > _COLLECT_MAX:
        raise MagmaError("a vector space of degree more than %d is not supported yet" % _COLLECT_MAX, "'%s'" % name)
    return _MVectorSpace(_sa.QQ if R is _QQ else _sa.ZZ, n)


def VectorSpace(*args):
    return _vector_space("VectorSpace", args, True)


def KSpace(*args):
    return _vector_space("KSpace", args, True)


def RSpace(*args):
    return _vector_space("RSpace", args, False)


def _unit_vectors(name, V):
    # (n vectors of n entries: admitted by n^2, the entries made)
    if V.n * V.n > _COLLECT_MAX:
        raise MagmaError("%s of a vector space of degree more than %d is not supported yet" % (name, _math.isqrt(_COLLECT_MAX)), "'%s'" % name)
    return [V._unit(k) for k in range(V.n)]


def _vspace_admit(V, count, where):
    """A collection of count vectors over the declared vector space V,
    admitted by its total entries, count * n <= _COLLECT_MAX, before any
    vector is coerced, copied or keyed (daybreak2's limits review: m items
    and the degree n are each bounded, their product was not)."""
    if count * V.n > _COLLECT_MAX:
        raise MagmaError("a collection of vectors with more than %d entries in all is not supported yet" % _COLLECT_MAX, where)


def Generators(V):
    """The unit vectors of a full vector space, as a set (Magma lists them
    in an order of its own: a set of two or more is not printed)."""
    if not isinstance(V, _MVectorSpace):
        raise MagmaError("Generators of a %s is not supported yet" % _type_of(V), "'Generators'")
    return MSet(_unit_vectors("Generators", V), "set", V)


def Zero(R):
    """The zero of the integers, the rationals or a full vector space."""
    if R is _ZZ:
        return 0
    if R is _QQ:
        return _qelt(0)
    if isinstance(R, _MVectorSpace):
        return R._vector([0] * R.n)
    if isinstance(R, int) and not isinstance(R, bool):
        raise _bad_types("Zero", (R,))
    raise MagmaError("Zero of a %s is not supported yet" % _type_of(R), "'Zero'")


@_signature("Vector", "Rng", "SeqEnum", ret="ModTupRngElt")
def _vector_ring(R, Q):
    """A vector over R (the integers or the rationals) of the elements of Q."""
    base = _vector_base(R)
    items = _vector_items(Q)
    out = []
    for x in items:
        y = _coerce_struct(x, R)
        if y is _NOCOERCE or y is None:
            raise MagmaError("Vector: an element can't be coerced into the ring", "'Vector'")
        out.append(y)
    return _MVector(out, base)


# Solution's exact elimination: at most this many entry operations (about
# a 58 by 58 system; its rational entries grow as it goes)
_SOLVE_WORK = 2 * 10 ** 5


@_signature("Solution", "MtrxS", "ModTupRngElt", ret="ModTupRngElt")
def _solution(A, w):
    """The vector v with v * A = w: the unique solution, over A's ring."""
    m, n = A.nrows(), A.ncols()
    if A._base is not w._base:
        raise MagmaError("Arguments have incompatible coefficient rings", "'Solution'", True)
    if len(w) != n:
        raise _bad_types("Solution", [A, w])
    # (exact elimination takes about m * n * min(m, n) rational operations,
    # whose entries grow: admitted before the system is copied, HARD-DFC-3)
    if m * n * min(m, n) > _SOLVE_WORK:
        raise MagmaError("Solution of a system of more than %d (rows times columns times the smaller) steps is not supported yet"
                         % _SOLVE_WORK, "'Solution'")
    # the system sum_i v_i A[i][j] = w_j: rows are the equations (one for
    # each column j), columns the unknowns v_i, then the right-hand side
    rows = [[_Fraction(A._rows[i][j]) for i in range(m)] + [_Fraction(w[j])] for j in range(n)]
    piv, r = [], 0
    for c in range(m):
        k = next((k for k in range(r, n) if rows[k][c] != 0), None)
        if k is None:
            continue
        rows[r], rows[k] = rows[k], rows[r]
        lead = rows[r][c]
        rows[r] = [x / lead for x in rows[r]]
        for k2 in range(n):
            if k2 != r and rows[k2][c] != 0:
                f = rows[k2][c]
                rows[k2] = [a - f * b for a, b in zip(rows[k2], rows[r])]
        piv.append(c)
        r += 1
    if any(row[m] != 0 for row in rows[r:]):
        raise _arg_error("Solution", "No solution exists")
    if r < m:
        # (more than one solution: Magma returns a particular one of its
        # own choosing, which Sagebrush doesn't reproduce)
        raise MagmaError("Solution of a system with more than one solution is not supported yet", "'Solution'")
    v = [rows[piv.index(c)][m] for c in range(m)]
    base = _sa.QQ if (A._base is _sa.QQ or w._base is _sa.QQ) else _sa.ZZ
    if base is _sa.ZZ and any(x.denominator != 1 for x in v):
        raise _arg_error("Solution", "No solution exists")
    return _MVector((x if base is _sa.QQ else int(x) for x in v), base)


@_signature("Submatrix", "Mtrx", "RngIntElt", "RngIntElt", "RngIntElt", "RngIntElt", ret="Mtrx")
def _submatrix(A, i, j, p, q):
    """The p by q submatrix of A whose top left entry is A[i][j]."""
    m, n = A.nrows(), A.ncols()
    for k, (v, lo, hi) in enumerate([(i, 1, m + 1), (j, 1, n + 1)], 2):
        if not lo <= v <= hi:
            raise _arg_error("Submatrix", "Argument %d (%d) should be in the range [%d .. %d]" % (k, v, lo, hi))
    for k, (v, hi) in enumerate([(p, m - i + 1), (q, n - j + 1)], 4):
        if not 0 <= v <= hi:
            raise _arg_error("Submatrix", "Argument %d (%d) should be in the range [0 .. %d]" % (k, v, hi))
    if p == 0 or q == 0:
        raise MagmaError("Submatrix with no rows or no columns is not supported yet", "'Submatrix'")
    return _MMatrix(A._base, [r[j - 1:j - 1 + q] for r in A._rows[i - 1:i - 1 + p]])


def _mmat(M):
    # (its number of columns too: a matrix with no rows keeps it, WA-024)
    return _MMatrix(M._base, M._rows, M.ncols())


def Matrix(*args):
    R = None
    if args and isinstance(args[0], _MFinField):
        return _ffm_matrix(args[0], args[1:])
    if args and args[0] in (_ZZ, _QQ):
        R, args = args[0], args[1:]
    base = _sa.ZZ if R is _ZZ else _sa.QQ if R is _QQ else None
    # (the shape checked before any entry is used, in Magma's words, never
    # a Python error or a silently shortened matrix: checked against Magma
    # 2.18)
    err = lambda msg: MagmaError(msg, "'Matrix'", True)
    size = lambda r: r.size() if isinstance(r, MRange) else len(r)
    if len(args) == 3:
        m, n, ent = args
        if not (_int(m) and _int(n)) or not isinstance(ent, (MSeq, MRange, list)):
            raise _bad_types("Matrix", ((R,) if R is not None else ()) + tuple(args))
        if m < 0 or n < 0:
            raise MagmaError("a matrix with a negative number of rows or columns is not supported yet", "'Matrix'")
        if m * n > _COLLECT_MAX or max(m, n) > _COLLECT_MAX:
            # (rows and columns bounded too: a matrix with no columns has no
            # entries but still a row for each, HARD-DE1-1)
            raise MagmaError("a matrix of more than %d entries, rows or columns is not supported yet" % _COLLECT_MAX, "'Matrix'")
        k = size(ent)
        if k == 0:
            # (an empty sequence: with a ring, the zero matrix; without
            # one, Magma's null sequence error)
            if R is None:
                raise err("Illegal null sequence")
            ent = [0] * (m * n)
        elif k != m * n:
            raise err("Sequence should have length %d" % (m * n))
        else:
            ent = list(ent)
        rows = [ent[i * n:(i + 1) * n] for i in range(m)]
        if m == 0 or n == 0:
            # (no rows or no columns: both numbers kept, as Magma's,
            # Matrix(Integers(), 0, 3, []) has 3 columns, astra2 WA-024)
            return _MMatrix(base if base is not None else _sa.ZZ, rows, n)
    elif len(args) == 1 and isinstance(args[0], (MSeq, list)):
        Q = args[0]
        if len(Q) > _COLLECT_MAX:
            raise MagmaError("a matrix of more than %d entries, rows or columns is not supported yet" % _COLLECT_MAX, "'Matrix'")
        if any(not isinstance(r, (MSeq, MRange, list)) for r in Q):
            raise _bad_types("Matrix", ((R,) if R is not None else ()) + tuple(args))
        w = size(Q[0]) if len(Q) else 0
        for k, r in enumerate(Q):
            if size(r) != w:
                raise err("Element %d of sequence does not have length %d" % (k + 1, w))
        if len(Q) * w > _COLLECT_MAX:
            raise MagmaError("a matrix of more than %d entries is not supported yet" % _COLLECT_MAX, "'Matrix'")
        rows = [list(r) for r in Q]
    else:
        raise MagmaError("Matrix with these arguments is not supported yet", "'Matrix'")
    if R is _ZZ:
        for k, x in enumerate(e for r in rows for e in r):
            if not _int(x) and not (isinstance(x, _Fraction) and x.denominator == 1):
                raise err("Cannot coerce sequence element %d into the coefficient ring" % (k + 1))
    M = _smat.matrix(base, rows) if base is not None else _smat.matrix(rows)
    return _mmat(M)


# ------------------------------------------------------------------ matrices over finite fields

# The work one operation on matrices over a finite field may take, in
# products of entries (one over an extension field counting as
# _FFPOLY_EXT of them), admitted before it starts: a product's m n p, an
# elimination's (Determinant, Rank, an inverse) n^3, a power's n^3 for each
# squaring and multiplication.
_FFMAT_WORK = 2 * 10 ** 6


def _ffm_admit(work, F, what, where):
    if work * (1 if F.n == 1 else _FFPOLY_EXT) > _FFMAT_WORK:
        raise MagmaError("%s of matrices over a finite field of more than %d entry products is not supported yet"
                         % (what, _FFMAT_WORK), where, True)


class _MFFMatSpace:
    """The parent of a matrix over a finite field: Magma's full matrix
    algebra (square) or KMatrixSpace."""

    def __init__(self, F, m, n):
        self.F, self.m, self.n = F, m, n

    def __repr__(self):
        if self.m == self.n:
            return "Full Matrix Algebra of degree %d over %s" % (self.m, _gf_name(self.F))
        return "Full KMatrixSpace of %d by %d matrices over %s" % (self.m, self.n, _gf_name(self.F))

    def _magma_eq(self, o, op):
        if isinstance(o, _MFFMatSpace):
            if o.F is self.F:
                return (o.m, o.n) == (self.m, self.n)
            if o.F.p != self.F.p and self.m == self.n and o.m == o.n:
                raise MagmaError("Arguments are not compatible\nArgument types given: AlgMat[FldFin], AlgMat[FldFin]", "'%s'" % op, True)
            raise MagmaError("comparison of matrix spaces over two finite fields is not supported yet", "'%s'" % op, True)
        raise MagmaError("comparison of a matrix space over a finite field with this is not supported yet", "'%s'" % op, True)


class _MFFVecSpace:
    def __init__(self, F, n):
        self.F, self.n = F, n

    def __repr__(self):
        return "Full Vector space of degree %d over %s" % (self.n, _gf_name(self.F))

    def _magma_eq(self, o, op):
        if isinstance(o, _MFFVecSpace):
            if o.F is not self.F:
                raise MagmaError("comparison of vector spaces over two finite fields is not supported yet", "'%s'" % op, True)
            return o.n == self.n
        raise MagmaError("comparison of a vector space over a finite field with this is not supported yet", "'%s'" % op, True)


def _cells(F, entries):
    """Entries printed in one width, as Magma's matrices and vectors over a
    finite field print them: that of the field's widest element, whatever
    the entries (checked against Magma 2.18: GF(101)'s [  1   2], p - 1
    having 3 digits; GF(9)'s [  1   w], w^7 having 3 characters)."""
    w = len(str(F.p - 1))
    if F.n > 1:
        w = max(w, len("%s^%d" % (F._gen_name(), F.q - 2)))
    return [_ff_str(c).rjust(w) for c in entries]


class _MFFVec:
    """A vector over a finite field (a row of a matrix): printed (1 2),
    indexed, compared, added, scaled and multiplied by a matrix on the
    right, as Magma's."""

    __slots__ = ("F", "v")

    def __init__(self, F, v):
        self.F, self.v = F, list(v)

    def __repr__(self):
        return "(" + " ".join(_cells(self.F, self.v)) + ")"

    def _magma_index(self, i):
        if not _int_index(i):
            raise MagmaError("Bad argument types", "'[]'", True)
        _check_index(len(self.v), i)
        return self.v[i - 1]

    def __neg__(self):
        return _MFFVec(self.F, [-t for t in self.v])

    def _magma_parent(self):
        return _MFFVecSpace(self.F, len(self.v))

    def _magma_card(self):
        raise _bad_types("#", [self])

    __hash__ = None


class _MFFMat:
    """Matrix(GF(q), ...) in Magma mode: Magma's printing, indexing and
    rules over a matrix of lib/_sage_ffmat.py, which does the linear
    algebra.  Checked against Magma 2.18."""

    __slots__ = ("F", "M")
    _magma_block = True  # (printed on a line of its own after other values)

    def __init__(self, F, M):
        self.F, self.M = F, M

    def nrows(self):
        return self.M.nrows()

    def ncols(self):
        return self.M.ncols()

    def is_square(self):
        return self.M.nrows() == self.M.ncols()

    def trace(self):
        return self.M.trace()

    def __repr__(self):
        m, n = self.nrows(), self.ncols()
        cells = _cells(self.F, [c for r in self.M._rows for c in r])
        return "\n".join("[" + " ".join(cells[i * n:(i + 1) * n]) + "]" for i in range(m))

    def _magma_parent(self):
        return _MFFMatSpace(self.F, self.nrows(), self.ncols())

    def _magma_card(self):
        raise _bad_types("#", [self])

    def _magma_index(self, i):
        if not _int_index(i):
            raise MagmaError("Bad argument types", "'[]'", True)
        _check_index(self.nrows(), i)
        return _MFFVec(self.F, self.M._rows[i - 1])

    def __neg__(self):
        return _MFFMat(self.F, -self.M)

    __hash__ = None


def _ffm_like(c, x):
    """x as an element of the parent of c (a matrix or vector over a finite
    field), or None: one of its shape over its field; for a square
    matrix, a scalar as the scalar matrix (Magma coerces 1 into the
    identity)."""
    if isinstance(c, _MFFMat):
        if isinstance(x, _MFFMat):
            return x if x.F is c.F and (x.nrows(), x.ncols()) == (c.nrows(), c.ncols()) else None
        k = None if isinstance(x, _FFLIN) else _ffm_scalar(c.F, x)
        if k is None or not c.is_square():
            return None
        n, z = c.nrows(), c.F.K(0)
        return _ffm_new(c.F, [[k if i == j else z for j in range(n)] for i in range(n)])
    if isinstance(x, _MFFVec) and x.F is c.F and len(x.v) == len(c.v):
        return x
    return None


def _ffm_items(items):
    """The elements of a sequence holding matrices or vectors over a finite
    field: all of one shape over one field (scalars made scalar matrices),
    as Magma's universe takes them; anything else refused in words."""
    c = next(x for x in items if isinstance(x, _FFLIN))
    out = []
    for x in items:
        if isinstance(x, _Fraction):
            raise MagmaError("No valid universe containing all elements", "[ ... ]")
        y = x if x is _UNDEF else _ffm_like(c, x)
        if y is None and type(x) is type(c) and (x.F.p != c.F.p or x.F is c.F):
            # (another characteristic, or another shape: no common universe)
            raise MagmaError("No valid universe containing all elements", "[ ... ]")
        if y is None:
            raise MagmaError("a sequence of matrices or vectors over a finite field and a %s (another shape, field or type) is not supported yet"
                             % _type_of(x), "[ ... ]")
        out.append(y)
    return out


_FFLIN = (_MFFMat, _MFFVec)
_FFLINALL = (_MFFMat, _MFFVec, _MFFMatSpace, _MFFVecSpace)


def _ffm_new(F, rows):
    return _MFFMat(F, _sffmat.FFMatrix(F.K, rows))


def _ffm_matrix(F, args):
    """Matrix(F, m, n, Q) and Matrix(F, Q) (Q a sequence of rows), F a
    finite field: each entry coerced into F, as Magma's (its words)."""
    err = lambda msg: MagmaError(msg, "'Matrix'", True)
    if F.n > 1 and F.q > _FF_POWERS_MAX:
        # (Magma prints their entries as polynomials in the generator, in
        # widths not modelled)
        raise MagmaError("Matrix over a finite field of more than %d elements, not a prime field, is not supported yet" % _FF_POWERS_MAX, "'Matrix'")
    if len(args) == 3:
        m, n, Q = args
        if not (_int(m) and _int(n)) or not isinstance(Q, (MSeq, MRange, list)):
            raise _bad_types("Matrix", (F,) + tuple(args))
        if m < 0 or n < 0:
            raise err("Argument %d (%d) should be >= 0" % ((2, m) if m < 0 else (3, n)))
        if m * n > _COLLECT_MAX or max(m, n) > _COLLECT_MAX:
            # (rows and columns bounded too: a matrix with no columns has no
            # entries but still a row for each, HARD-DE1-1)
            raise MagmaError("a matrix of more than %d entries, rows or columns is not supported yet" % _COLLECT_MAX, "'Matrix'")
        # (its length first: a long range is never expanded)
        k = Q.size() if isinstance(Q, MRange) else len(Q)
        if k != m * n and k != 0:
            raise err("Sequence should have length %d" % (m * n))
        # (an empty sequence is the zero matrix, as Magma's)
        ent = list(Q) if k else [0] * (m * n)
        rows = [ent[i * n:(i + 1) * n] for i in range(m)]
    elif len(args) == 1 and isinstance(args[0], (MSeq, list)):
        # (the rows' lengths read, and their total admitted, before any row
        # is copied: one long row shared by many costs nothing until then,
        # HARD-53E-2)
        Q = args[0]
        if any(not isinstance(r, (MSeq, MRange, list)) for r in Q):
            raise _bad_types("Matrix", (F,) + tuple(args))
        size = lambda r: r.size() if isinstance(r, MRange) else len(r)
        if len(Q) > _COLLECT_MAX:
            raise MagmaError("a matrix of more than %d entries, rows or columns is not supported yet" % _COLLECT_MAX, "'Matrix'")
        n = size(Q[0]) if len(Q) else 0
        for k, r in enumerate(Q):
            if size(r) != n:
                raise err("Element %d of sequence does not have length %d" % (k + 1, n))
        if len(Q) * n > _COLLECT_MAX:
            raise MagmaError("a matrix of more than %d entries is not supported yet" % _COLLECT_MAX, "'Matrix'")
        rows = [list(r) for r in Q]
        m = len(rows)
    else:
        raise MagmaError("Matrix over a finite field with these arguments is not supported yet", "'Matrix'")
    if m == 0 or n == 0:
        raise MagmaError("a matrix with no rows or no columns is not supported yet", "'Matrix'")
    out = []
    for i, r in enumerate(rows):
        row = []
        for j, c in enumerate(r):
            try:
                row.append(F._magma_coerce(c))
            except MagmaError:
                raise err("Cannot coerce sequence element %d into the coefficient ring" % (i * n + j + 1))
        out.append(row)
    return _ffm_new(F, out)


def _ffm_scalar(F, y):
    """y as an element of F (an integer, F's or its prime field's element, a
    rational prime to p), or None."""
    if isinstance(y, bool):
        return None
    if isinstance(y, int):
        return F.K(y)
    if isinstance(y, _Fraction):
        return None if y.denominator % F.p == 0 else F._magma_coerce(y)
    if _is_ff(y):
        Ky = _ffwrap(y.parent())
        if y.parent() is F.K:
            return y
        if Ky.n == 1 and Ky.p == F.p:
            return F.K(int(y))
    return None


def _ffmat_check(op, a, b, pos):
    """Magma's rules for a matrix or vector over a finite field with another
    value (in an operation), checked against Magma 2.18: nothing if they
    meet, else Magma's error, or "not supported yet"."""
    o = op[:-2] if op.endswith(":=") else op
    mats = (_MFFMat, _MFFVec)
    left = isinstance(a, mats)
    x, y = (a, b) if left else (b, a)
    F = x.F
    unsupported = lambda what: MagmaError("%s is not supported yet" % what, "'%s'" % o, True, pos)
    if isinstance(x, _MFFVec) or isinstance(y, _MFFVec):
        # vectors: v + w, v - w, c * v, v * c, v * A, over one field
        u, w = (a, b)
        if o in ("+", "-") and isinstance(u, _MFFVec) and isinstance(w, _MFFVec):
            if u.F is not w.F:
                raise unsupported("arithmetic of vectors over two finite fields")
            if len(u.v) != len(w.v):
                raise _bad_types(op, (a, b), pos)
            return
        if o == "*" and isinstance(u, _MFFVec) and isinstance(w, _MFFMat):
            if u.F is not w.F:
                raise unsupported("arithmetic of a vector and a matrix over two finite fields")
            if len(u.v) != w.nrows():
                raise MagmaError("Arguments have incompatible degrees", "'*'", True, pos)
            return
        if o == "*" and _ffm_scalar(F, w if left else u) is not None:
            return
        raise unsupported("this arithmetic of vectors over a finite field")
    if o == "^":
        if not left:
            raise _bad_types(op, (a, b), pos)
        if not x.is_square():
            raise _bad_types(op, (a, b), pos)
        if _int(y):
            return
        if isinstance(y, _Fraction):
            raise MagmaError("Bad argument types\nArgument types given: %s, %s" % (_ext_type(x), _ext_type(x)), "'^'", True, pos)
        raise _bad_types(op, (a, b), pos)
    if isinstance(y, _MFFMat):
        if y.F is not F:
            if y.F.p != F.p:
                raise _incompatible("C", o, a, b, pos)
            raise unsupported("arithmetic of matrices over two finite fields")
        if o in ("+", "-"):
            if (a.nrows(), a.ncols()) != (b.nrows(), b.ncols()):
                raise _bad_types(op, (a, b), pos)
            return
        if o == "*":
            if a.ncols() != b.nrows():
                raise MagmaError("Arguments have incompatible degrees", "'*'", True, pos)
            return
        raise unsupported("%s of matrices over a finite field" % ("division" if o == "/" else o))
    c = _ffm_scalar(F, y)
    if c is None:
        if _is_ff(y) or isinstance(y, MReal):
            raise _incompatible("C", o, a, b, pos)
        if isinstance(y, _Fraction) or isinstance(y, (bool, str)):
            raise _bad_types(op, (a, b), pos)
        raise unsupported("arithmetic of a matrix over a finite field and a %s" % _type_of(y))
    if o == "*":
        return
    if o == "/" and left:
        if not c:
            raise MagmaError("Division by zero", "'/'", True, pos)
        return
    if o in ("+", "-") and x.is_square():
        return  # (the scalar times the identity, as Magma's)
    raise unsupported("this arithmetic of a matrix over a finite field and a scalar")


def _ffmat_op(o, a, b, pos):
    """a o b, one of them a matrix or vector over a finite field, once
    _ffmat_check has let them meet."""
    if isinstance(a, _MFFVec) or isinstance(b, _MFFVec):
        if isinstance(a, _MFFVec) and isinstance(b, _MFFVec):
            return _MFFVec(a.F, [s + t if o == "+" else s - t for s, t in zip(a.v, b.v)])
        if isinstance(a, _MFFVec) and isinstance(b, _MFFMat):
            _ffm_admit(len(a.v) * b.ncols(), a.F, "a product", "'*'")
            rows = b.M._rows
            z = a.F.K(0)
            return _MFFVec(a.F, [sum((a.v[i] * rows[i][j] for i in range(len(a.v))), z) for j in range(b.ncols())])
        u = a if isinstance(a, _MFFVec) else b
        c = _ffm_scalar(u.F, b if u is a else a)
        return _MFFVec(u.F, [c * t for t in u.v])
    x = a if isinstance(a, _MFFMat) else b
    F = x.F
    if o == "^":
        n, e = x.nrows(), b
        steps = 2 * max(abs(e), 1).bit_length()
        _ffm_admit(n ** 3 * (steps + (1 if e < 0 else 0)), F, "a power", "'^'")
        if e < 0:
            try:
                return _MFFMat(F, x.M.inverse() ** (-e))
            except (ZeroDivisionError, ArithmeticError, ValueError):
                raise MagmaError("Argument 1 is not invertible", "'^'", True, pos)
        return _MFFMat(F, x.M ** e)
    if isinstance(a, _MFFMat) and isinstance(b, _MFFMat):
        if o == "*":
            _ffm_admit(a.nrows() * a.ncols() * b.ncols(), F, "a product", "'*'")
            if a.nrows() == b.ncols() and (a.nrows() != a.ncols() or b.nrows() != b.ncols()):
                # (Magma's is a square matrix of a KMatrixSpace, ModMatFldElt,
                # not of the matrix algebra: not modelled over a finite
                # field, WA-026)
                raise MagmaError("a square product of matrices over a finite field not square is not supported yet", "'*'", True)
            return _MFFMat(F, a.M * b.M)
        return _MFFMat(F, a.M + b.M if o == "+" else a.M - b.M)
    c = _ffm_scalar(F, b if x is a else a)
    if o == "*":
        return _MFFMat(F, x.M * c)
    if o == "/":
        return _MFFMat(F, x.M * (1 / c))
    # (x + c and x - c: c times the identity)
    n = x.nrows()
    I = _sffmat.FFMatrix(F.K, [[c if i == j else F.K(0) for j in range(n)] for i in range(n)])
    if o == "+":
        return _MFFMat(F, x.M + I)
    return _MFFMat(F, x.M - I if x is a else I - x.M)


def _ffmat_eq(a, b, op, pos):
    """a eq b, one of them a matrix, vector or space over a finite field."""
    spaces = (_MFFMatSpace, _MFFVecSpace)
    if isinstance(a, spaces) or isinstance(b, spaces):
        x, y = (a, b) if isinstance(a, spaces) else (b, a)
        return x._magma_eq(y, op)
    if isinstance(a, _MFFVec) and isinstance(b, _MFFVec):
        if a.F is not b.F:
            raise MagmaError("comparison of vectors over two finite fields is not supported yet", "'%s'" % op, True, pos)
        if len(a.v) != len(b.v):
            raise MagmaError("Arguments are not compatible\nArgument types given: %s, %s" % (_ext_type(a), _ext_type(b)), "'%s'" % op, True, pos)
        return a.v == b.v
    if isinstance(a, _MFFMat) and isinstance(b, _MFFMat):
        if a.F is not b.F:
            if a.F.p != b.F.p:
                raise _incompatible("C", op, a, b, pos)
            # (Magma compares them in a field containing both)
            raise MagmaError("comparison of matrices over two finite fields is not supported yet", "'%s'" % op, True, pos)
        if (a.nrows(), a.ncols()) != (b.nrows(), b.ncols()):
            raise MagmaError("Arguments have incompatible degrees", "'%s'" % op, True, pos)
        return a.M._rows == b.M._rows
    x, y = (a, b) if isinstance(a, _MFFMat) else (b, a)
    if isinstance(x, _MFFMat):
        c = _ffm_scalar(x.F, y)
        if c is not None and x.is_square():
            # (a scalar matrix equals its scalar, as Magma has it)
            z = x.F.K(0)
            return all(x.M._rows[i][j] == (c if i == j else z) for i in range(x.nrows()) for j in range(x.ncols()))
    raise MagmaError("comparison of a matrix or vector over a finite field with a %s is not supported yet" % _type_of(y), "'%s'" % op, True, pos)


def _ffmat_assign(M, path, val, pos):
    """A[i, j] := v and A[i][j] := v over a finite field: a new matrix with v
    coerced into the field (7 is 2 in GF(5)), as Magma's."""
    kind, i = path[0][:2]
    if kind == "midx" and len(path) == 1:
        idx = list(i)
        if len(idx) != 2:
            raise MagmaError("Illegal number of indices", ":=", False, pos)
    elif kind == "idx" and len(path) == 2 and path[1][0] == "idx":
        idx = [i, path[1][1]]
    elif kind == "idx" and not _int_index(i):
        raise MagmaError("Bad matrix row index type", ":=", False, pos)
    else:
        raise MagmaError("assigning a row or a block of a matrix is not supported yet", ":=", False, pos)
    for v, n, what in zip(idx, (M.nrows(), M.ncols()), ("row", "column")):
        if not _int_index(v):
            raise MagmaError("Bad matrix %s index type" % what, ":=", False, pos)
        if not 1 <= v <= n:
            raise MagmaError("Matrix %s index is not in the range [1 .. %d]" % (what, n), ":=", False, pos)
    c = _ffm_scalar(M.F, val)
    if c is None:
        raise MagmaError("RHS cannot be coerced into the coefficient ring", ":=", False, pos)
    rows = [list(r) for r in M.M._rows]
    rows[idx[0] - 1][idx[1] - 1] = c
    return _ffm_new(M.F, rows)


def _ffm_square(A, name):
    if not A.is_square():
        raise _arg_error(name, "Argument 1 is not square")


def _ffm_elim(A, name):
    n, m = A.nrows(), A.ncols()
    _ffm_admit(n * m * min(n, m), A.F, name, "'%s'" % name)


# ------------------------------------------------------------------ finite fields' structures at intrinsics

_FFALL = (_MFFPoly, _MFFPolyRing, _MFFMat, _MFFVec, _MFFMatSpace, _MFFVecSpace)


# The guard's walk through an intrinsic's arguments for these values, once
# for each call (its result serves the signatures and the refusal's words):
# at most _FF_SCAN_NODES values visited for one call, all its arguments
# together, and _FF_SCAN_RUN in a whole run (a loop calling an intrinsic on
# the same large nested collection is bounded too); at most _FF_SCAN_DEPTH
# deep.  Past a bound the call is refused in words: what the walk didn't
# see it doesn't certify absent (CORR-53E-2, HARD-F42-1).
_FF_SCAN_NODES = 10 ** 6
_FF_SCAN_RUN = [10 ** 7]
_FF_SCAN_DEPTH = 32


_SCAN_ATOMS = (int, str, _Fraction)


class _FFUnseen(Exception):
    """The guard's walk ran past a bound ("call" or "run")."""


def _ff_scan(args):
    """For each argument, the polynomial, matrix or vector over a finite
    field (or such a structure) it is or holds, or None: itself, or anywhere
    in its sequences, tuples, records and lists.  A sequence whose universe
    is the integers, the rationals or a finite field holds none and isn't
    walked (sets hold none: their keys refuse them).  _FFUnseen past the
    bounds."""
    left = [_FF_SCAN_NODES]

    def walk(x, d):
        if isinstance(x, _FFALL):
            return x
        rec = isinstance(x, MRec)
        if not (rec or isinstance(x, (MSeq, MTuple)) or type(x).__name__ == "MList"):
            return None
        if isinstance(x, MSeq):
            u, inf = x.universe, getattr(x, "_inf", None)
            if u is _ZZ or u is _QQ or inf is _ZZ or inf is _QQ or isinstance(u, _MFinField):
                return None
        if d >= _FF_SCAN_DEPTH:
            raise _FFUnseen("call")
        items = x.vals.values() if rec else x
        n = len(items)
        left[0] -= n
        _FF_SCAN_RUN[0] -= n
        if left[0] < 0:
            raise _FFUnseen("call")
        if _FF_SCAN_RUN[0] < 0:
            raise _FFUnseen("run")
        for y in items:
            if isinstance(y, _SCAN_ATOMS):
                continue  # (numbers and strings, without a call each)
            h = walk(y, d + 1)
            if h is not None:
                return h
        return None

    return [walk(a, 0) for a in args]


# The scan of the call being admitted (_ff_admit_args): one per argument.
_FF_CUR = [None]


def _held(k):
    h = _FF_CUR[0]
    return h[k] if h is not None and k < len(h) else None


def _ff_scalar(a):
    return _int(a) or _is_ff(a) or isinstance(a, _Fraction)


def _ff_poly_or_scalars(args):
    """Gcd, Lcm and Quotrem: polynomials and scalars, a polynomial among
    them; or (Gcd, Lcm) one sequence of polynomials."""
    if len(args) == 1 and isinstance(args[0], MSeq):
        return isinstance(_first_defined(args[0]), _MFFPoly)
    return len(args) == 2 and all(isinstance(a, _MFFPoly) or _ff_scalar(a) for a in args) and any(isinstance(a, _MFFPoly) for a in args)


def _ff_collection(args):
    return bool(args) and (isinstance(args[0], (MSeq, MSet, MRange)) or type(args[0]).__name__ == "MList")


_P1 = lambda a: len(a) == 1 and isinstance(a[0], _MFFPoly)
# (a vector given where a matrix goes: Magma reads it as a matrix of one
# row, Determinant(A[1]) is "not square", not modelled: refused in words)
_M1 = lambda a: (len(a) == 1 and isinstance(a[0], _MFFMat)) or (None if any(isinstance(x, _MFFVec) for x in a) else False)
# Each intrinsic taught these structures, with what it takes: True if the
# arguments are of a signature it has, False if Magma has none for them
# ("Bad argument types"), None if Magma has one Sagebrush doesn't (refused
# in words).  An intrinsic not listed refuses them in words.
_FF_SIGS = {
    "Degree": _P1, "Coefficients": _P1, "LeadingCoefficient": _P1, "IsIrreducible": _P1,
    "Factorization": _P1, "Factorisation": _P1,
    "Coefficient": lambda a: len(a) == 2 and isinstance(a[0], _MFFPoly) and _int(a[1]),
    "Derivative": lambda a: 1 <= len(a) <= 2 and isinstance(a[0], _MFFPoly) and (len(a) == 1 or _int(a[1])),
    "Evaluate": lambda a: (len(a) == 2 and isinstance(a[0], _MFFPoly) and (isinstance(a[1], _MFFPoly) or _held(1) is None)) or None,
    "Roots": lambda a: (1 <= len(a) <= 2 and isinstance(a[0], _MFFPoly) and (len(a) == 1 or _held(1) is None)) or None,
    "Quotrem": _ff_poly_or_scalars,
    # (of a matrix, or of a sequence of them, Magma has these: refused in words)
    "IsZero": lambda a: _P1(a) or (None if any(isinstance(x, _FFLIN + (MSeq, MTuple)) for x in a) else False),
    "IsOne": lambda a: _P1(a) or (None if any(isinstance(x, _FFLIN + (MSeq, MTuple)) for x in a) else False),
    "Characteristic": lambda a: (len(a) == 1 and isinstance(a[0], _MFFPolyRing)) or None,
    "FieldOfFractions": lambda a: len(a) == 1 and isinstance(a[0], _MFFPolyRing),
    "AssignNames": lambda a: len(a) == 2 and isinstance(a[0], _MFFPolyRing),
    "Determinant": _M1, "Rank": _M1, "Transpose": _M1, "NumberOfRows": _M1, "NumberOfColumns": _M1,
    "Nrows": _M1, "Ncols": _M1, "CharacteristicPolynomial": _M1, "Trace": lambda a: _M1(a) or None,
    # (of a polynomial or its ring: its signatures check the rest; of a
    # matrix, Magma has one: refused in words)
    "ChangeRing": lambda a: (len(a) >= 1 and isinstance(a[0], (_MFFPoly, _MFFPolyRing))) or None,
}
for _n in ("Gcd", "GCD", "GreatestCommonDivisor", "Lcm", "LCM", "LeastCommonMultiple"):
    # (of matrices Magma says its ring has no Gcd: refused in words)
    _FF_SIGS[_n] = lambda a: _ff_poly_or_scalars(a) or (None if any(isinstance(x, (_MFFPoly,) + _FFLIN) or
                                                                 (isinstance(x, MSeq) and _held(k) is not None) for k, x in enumerate(a)) else False)
for _n in ("Parent", "Type", "ISA", "Sprint", "Sprintf"):
    _FF_SIGS[_n] = lambda a: True
for _n in ("BaseRing", "CoefficientRing"):
    _FF_SIGS[_n] = lambda a: len(a) == 1 and isinstance(a[0], (_MFFPolyRing, _MFFPoly, _MFFMat, _MFFMatSpace))
for _n in ("Append", "Include", "Exclude", "Insert", "Index", "Position", "Reverse"):
    _FF_SIGS[_n] = _ff_collection


# Intrinsics that take any values, whatever they hold, and those that only
# move a collection's elements: the guard looks at their own arguments, not
# inside them (an Append in a loop doesn't walk the sequence each time).
_FF_PLAIN = frozenset("Parent Type ISA Sprint Sprintf Append Include Exclude Insert Index Position Reverse".split())


def _ff_admit_args(name, args, kw):
    """The argument guard for polynomials, matrices and vectors over finite
    fields (and their structures), wherever they are in the arguments."""
    sig = _FF_SIGS.get(name)
    ok = sig(args) if sig is not None and not kw else None
    if ok:
        return
    if ok is False:
        raise _bad_types(name, args)
    held = [h for h in (_FF_CUR[0] or []) if h is not None]
    if not any(isinstance(h, _FFALL[2:]) for h in held):
        raise MagmaError("%s of a polynomial over a finite field (or its ring) is not supported yet" % name, "'%s'" % name)
    raise MagmaError("%s of a matrix or vector over a finite field is not supported yet" % name, "'%s'" % name)


def HermiteForm(M):
    return _multi([_mod_like(M, _mmat(M.hermite_form()))], show=1)


def EchelonForm(M):
    # over Z the Hermite form, over Q the reduced row echelon form
    return _multi([_mod_like(M, _mmat(M.echelon_form()))], show=1)


def _no_module(M, name):
    if isinstance(M, _MModMat):
        raise MagmaError("%s of a matrix of a module of matrices (a product of matrices not square) is not supported yet" % name, "'%s'" % name)


def SmithForm(M):
    _no_module(M, "SmithForm")
    D, U, V = M.smith_form()
    return _multi([_mmat(D), _mmat(U), _mmat(V)])


def ElementaryDivisors(M):
    return MSeq(d for d in M.elementary_divisors() if d)


def LLL(M, *, Delta=None):
    if Delta is not None:
        # the reduced basis depends on Delta, which isn't passed on
        raise MagmaError("LLL with the parameter Delta is not supported yet")
    _no_module(M, "LLL")
    return _multi([_mmat(M.LLL())], show=1)


def Determinant(M):
    if isinstance(M, _MFFMat):
        _ffm_square(M, "Determinant")
        _ffm_elim(M, "Determinant")
        return M.M.det()
    return M.det()


def Transpose(M):
    if isinstance(M, _MFFMat):
        return _MFFMat(M.F, M.M.transpose())
    return _mod_like(M, _mmat(M.transpose()))


def NumberOfRows(M):
    return M.nrows()


def NumberOfColumns(M):
    return M.ncols()


Nrows, Ncols = NumberOfRows, NumberOfColumns


def Rank(x):
    if isinstance(x, _MFFMat):
        _ffm_elim(x, "Rank")
        return x.M.rank()
    if isinstance(x, _smat.Matrix):
        return x.rank()
    return x.rank()


# ------------------------------------------------------------------ permutation groups

def _order_text(n):
    """Order = 24 = 2^3 * 3, as Magma prints a group's order."""
    if n == 1:
        return "Order = 1"
    f = " * ".join(str(p) if e == 1 else "%d^%d" % (p, e) for p, e in _sa.factor(n))
    return "Order = %d" % n if f == str(n) else "Order = %d = %s" % (n, f)


class _MSymGroup:
    """Sym(n): the symmetric group on 1 .. n (GrpPerm), its elements the
    permutations, composed left to right as Magma's: i^(p*q) = (i^p)^q."""

    def __init__(self, n):
        self.n = n

    def __repr__(self):
        name = _global_name(self)
        return "Symmetric group %sacting on a set of cardinality %d\n%s" % (name + " " if name else "", self.n, _order_text(_math.factorial(self.n)))

    def __eq__(self, other):
        # (DihedralGroup(3) is Sym(3): one element of a set, as Magma's)
        if isinstance(other, _MDihedralGroup):
            return other == self
        return isinstance(other, _MSymGroup) and other.n == self.n

    def __hash__(self):
        return hash(("Sym", self.n))

    def _magma_card(self):
        return _math.factorial(self.n)

    def __iter__(self):
        # (every permutation, in a fixed order of Sagebrush's: lexicographic
        # in the images, which is not Magma's order)
        if _math.factorial(self.n) > _COLLECT_MAX:
            raise MagmaError("iterating over a group of more than %d elements is not supported yet" % _COLLECT_MAX)
        for images in _itertools.permutations(range(1, self.n + 1)):
            yield _MPerm(self, images)

    def _identity(self):
        return _MPerm(self, tuple(range(1, self.n + 1)))

    def _magma_contains(self, x):
        return isinstance(x, _MPerm) and x.G.n == self.n

    def _magma_coerce(self, x):
        if isinstance(x, _MPerm):
            if x.G == self:
                return x
            if x.G.n == self.n:
                return _MPerm(self, x.images)  # (a dihedral group's, of degree n)
            raise MagmaError("Illegal coercion\nLHS: GrpPerm\nRHS: GrpPermElt", "'!'", True)
        if isinstance(x, (MSeq, MRange)):
            # G![images]: the permutation i -> images[i], integers only
            # (CORR-DFC-4)
            images = tuple(x)
            bad = next((y for y in images if isinstance(y, bool) or not isinstance(y, int)), None)
            if bad is not None:
                raise MagmaError("Illegal coercion\nLHS: GrpPerm\nRHS: [%s]" % _type_of(bad), "'!'", True)
            if len(images) != self.n or sorted(images) != list(range(1, self.n + 1)):
                raise MagmaError("Illegal coercion\nLHS: GrpPerm\nRHS: [RngIntElt]", "'!'", True)
            return _MPerm(self, images)
        cycles = [x] if isinstance(x, MTuple) else list(x) if isinstance(x, _MCycles) else None
        if cycles is None:
            raise MagmaError("coercion of a %s into a permutation group is not supported yet" % _type_of(x), "'!'", True)
        images = list(range(1, self.n + 1))
        p = self._identity()
        for c in cycles:
            pts = list(c)
            if not pts or len(set(pts)) != len(pts) or any(isinstance(a, bool) or not isinstance(a, int) or not 1 <= a <= self.n for a in pts):
                raise MagmaError("Bad arguments to cycle or commutator construction", "elt< ... >", True)
            img = list(range(1, self.n + 1))
            for k, a in enumerate(pts):
                img[a - 1] = pts[(k + 1) % len(pts)]
            p = p * _MPerm(self, tuple(img))
        return p


class _MPerm:
    """A permutation of 1 .. n, an element of Sym(n) (GrpPermElt)."""

    __slots__ = ("G", "images")

    def __init__(self, G, images):
        self.G, self.images = G, tuple(images)

    def parent(self):
        return self.G

    def _magma_parent(self):
        return self.G

    def __hash__(self):
        return hash(self.images)

    def __eq__(self, o):
        return isinstance(o, _MPerm) and o.images == self.images

    def _magma_eq(self, o, op):
        if not isinstance(o, _MPerm) or (o.G != self.G and o.G.n != self.G.n):
            raise MagmaError("Arguments are not compatible\nArgument types given: GrpPermElt, %s" % _ext_type(o), "'%s'" % op, True)
        return o.images == self.images

    def _cycles(self):
        seen, out = set(), []
        for i in range(1, self.G.n + 1):
            if i in seen or self.images[i - 1] == i:
                continue
            c, j = [], i
            while j not in seen:
                seen.add(j)
                c.append(j)
                j = self.images[j - 1]
            out.append(c)
        return out

    def __repr__(self):
        cs = self._cycles()
        if not cs:
            return "Id(%s)" % (_global_name(self.G) or "$")
        return "".join("(" + ", ".join(str(a) for a in c) + ")" for c in cs)

    def __mul__(self, o):
        if not isinstance(o, _MPerm):
            raise _bad_types("*", (self, o))
        G = self.G
        if o.G != G:
            if o.G.n != G.n:
                raise MagmaError("Arguments are not compatible\nArgument types given: GrpPermElt, GrpPermElt", "'*'", True)
            # (of two groups on one set, a dihedral group's and Sym(n)'s: in
            # Sym(n), as Magma's)
            G = _MSymGroup(G.n)
        # (left to right: i^(p*q) = (i^p)^q)
        return _MPerm(G, tuple(o.images[self.images[i] - 1] for i in range(G.n)))

    def _inverse(self):
        inv = [0] * self.G.n
        for i, j in enumerate(self.images):
            inv[j - 1] = i + 1
        return _MPerm(self.G, tuple(inv))

    def __pow__(self, k):
        if isinstance(k, _MPerm):
            # p^q: conjugation q^-1 p q
            return k._inverse() * self * k
        if not isinstance(k, int) or isinstance(k, bool):
            raise _bad_types("^", (self, k))
        b = self if k >= 0 else self._inverse()
        r, k = self.G._identity(), abs(k) % max(self._order(), 1)
        while k:
            if k & 1:
                r = r * b
            b = b * b
            k >>= 1
        return r

    def __rpow__(self, i):
        # i^p: the image of the point i
        if isinstance(i, int) and not isinstance(i, bool) and 1 <= i <= self.G.n:
            return self.images[i - 1]
        raise MagmaError("Cannot apply permutation to this object", "'^'", True)

    def _order(self):
        o = 1
        for c in self._cycles():
            o = o * len(c) // _math.gcd(o, len(c))
        return o

    def _sign(self):
        return -1 if sum(len(c) - 1 for c in self._cycles()) % 2 else 1


@_signature("Sym", "RngIntElt", ret="GrpPerm")
def _sym(n):
    """The symmetric group on 1 .. n."""
    if n < 1:
        raise _arg_error("Sym", "Argument 1 (%d) should be >= 1" % n)
    if n > _SYM_MAX:
        raise MagmaError("Sym(n) for n above %d is not supported yet" % _SYM_MAX, "'Sym'")
    return _MSymGroup(n)


# the largest n of Sym(n): its permutations are tuples of n points
_SYM_MAX = 10 ** 4


class _MDihedralGroup:
    """DihedralGroup(n), n >= 3: the symmetries of an n-gon as permutations
    of 1 .. n (GrpPerm), generated by the rotation (1, 2, ..., n) and the
    reflection i -> n + 1 - i ((1, 2) for n = 3, where Magma's is Sym(3)
    and prints as one). Checked against Magma 2.18."""

    def __init__(self, n):
        self.n = n
        # (DihedralGroup(3) is Magma's Sym(3), printed without its
        # generators until one has been asked for, G.1 or G.2)
        self._shown = n != 3

    def _gens(self):
        n = self.n
        r = tuple(list(range(2, n + 1)) + [1])
        s = (2, 1, 3) if n == 3 else tuple(n + 1 - i for i in range(1, n + 1))
        return _MPerm(self, r), _MPerm(self, s)

    def _gens_fit(self, limit):
        """Whether both generators print in at most `limit` characters,
        counted without building them, stopping as soon as one is longer:
        at most about `limit` steps whatever n is (LIMIT-714-1)."""
        n = self.n
        w = 1  # (1, 2, ..., n)
        for i in range(1, n + 1):
            w += len(str(i)) + (2 if i > 1 else 0)
            if w + 1 > limit:
                return False
        w = 0  # (1, n)(2, n - 1)... ((1, 2) for n = 3)
        for i in range(1, n // 2 + 1):
            w += len(str(i)) + len(str(2 if n == 3 else n + 1 - i)) + 4
            if w > limit:
                return False
        return True

    def __repr__(self):
        name = _global_name(self)
        if self._shown and not self._gens_fit(WIDTH - 5):
            # (Magma wraps a long generator, in a layout not modelled;
            # decided before either is made)
            raise MagmaError("printing a dihedral group whose generators are longer than a line is not supported yet")
        g = [repr(x) for x in self._gens()] if self._shown else []
        kind = "Symmetric group" if self.n == 3 else "Permutation group"
        return "%s %sacting on a set of cardinality %d\n%s%s" % (kind, name + " " if name else "", self.n, _order_text(2 * self.n),
                                                                 "".join("\n    " + t for t in g))

    def __eq__(self, other):
        if isinstance(other, _MSymGroup):
            return self.n == 3 and other.n == 3
        return isinstance(other, _MDihedralGroup) and other.n == self.n

    def __hash__(self):
        return hash(("Sym", 3) if self.n == 3 else ("Dihedral", self.n))

    def _magma_card(self):
        return 2 * self.n

    def __iter__(self):
        # (Magma lists its elements in an order of its own)
        raise MagmaError("iterating over a dihedral group is not supported yet")

    def _identity(self):
        return _MPerm(self, tuple(range(1, self.n + 1)))

    def _magma_gen(self, i):
        if isinstance(i, bool) or not isinstance(i, int) or not -2 <= i <= 2:
            raise MagmaError("Argument 2 (%s) should be in the range [-2 .. 2]" % i, "'.'", True)
        self._shown = True
        if i == 0:
            return self._identity()
        g = self._gens()[abs(i) - 1]
        return g if i > 0 else g._inverse()

    def _has(self, images):
        # (a rotation i -> i + a - 1 or a reflection i -> a + 1 - i, mod n)
        n = self.n
        if n == 3:
            return True
        a = images[0]
        rot = all(images[i - 1] == (i + a - 2) % n + 1 for i in range(1, n + 1))
        ref = all(images[i - 1] == (a - i) % n + 1 for i in range(1, n + 1))
        return rot or ref

    def _magma_contains(self, x):
        return isinstance(x, _MPerm) and x.G.n == self.n and self._has(x.images)

    def _magma_coerce(self, x):
        # (cycles or images made a permutation as Sym(n)'s, then admitted
        # only if it is the group's: G!(1, 2) is Magma's Illegal coercion)
        p = x if isinstance(x, _MPerm) else _MSymGroup(self.n)._magma_coerce(x)
        if p.G.n == self.n and self._has(p.images):
            return _MPerm(self, p.images)
        raise MagmaError("Illegal coercion\nLHS: GrpPerm\nRHS: GrpPermElt", "'!'", True)


def DihedralGroup(n):
    """The dihedral group of order 2n as permutations of 1 .. n."""
    if isinstance(n, bool) or not isinstance(n, int):
        raise _bad_types("DihedralGroup", (n,))
    if n < 3:
        raise _arg_error("DihedralGroup", "Argument 1 (%d) should be >= 3" % n)
    if n > _SYM_MAX:
        raise MagmaError("DihedralGroup(n) for n above %d is not supported yet" % _SYM_MAX, "'DihedralGroup'")
    return _MDihedralGroup(n)


class _IsoNotModelled:
    """The isomorphism IsIsomorphic returns with true: Magma prints it (a
    map of fields, or of groups by their generators' images) in a form not
    modelled, so printing it, assigning it or using it is refused."""

    def _refuse(self, *args):
        raise MagmaError("the isomorphism IsIsomorphic returns (its second value, and printing a true result) is not supported yet", "'IsIsomorphic'")

    __repr__ = __str__ = __call__ = _refuse


def _iso_result(b):
    # (false: no second value, as Magma's: b, f := ... leaves f unassigned;
    # true: the isomorphism, refused)
    return _multi([b, _IsoNotModelled() if b else _NOVAL])


def _quadratic_disc(K):
    """The discriminant of a degree 2 field's defining polynomial, a rational."""
    c = [_Fraction(_m_num(x)) for x in list(K._f)[:3]]
    return c[1] * c[1] - 4 * c[0] * c[2]


def _rational_square(q):
    q = _Fraction(q)
    if q < 0:
        return False
    a, b = q.numerator, q.denominator
    return _math.isqrt(a) ** 2 == a and _math.isqrt(b) ** 2 == b


def IsIsomorphic(A, B):
    """Whether A and B are isomorphic, for what Sagebrush can decide exactly,
    as Magma's (checked against Magma 2.18):
    - number fields: of two degrees, false; of degree 2 (QuadraticField,
      NumberField of a quadratic, CyclotomicField(3), (4), (6)), whether the
      discriminants' quotient is a rational square, Q(sqrt(d1)) = Q(sqrt(d2));
      of a higher degree, refused;
    - Sym(n) and DihedralGroup(n): groups of two orders, false; of one type
      and degree, true; DihedralGroup(3) and Sym(3), true; DihedralGroup(n!/2)
      and Sym(n), n >= 4, false (its rotation has order n!/2, more than any
      element of Sym(n)).
    The second value, the isomorphism, is refused; with false there is none."""
    groups = (_MSymGroup, _MDihedralGroup)
    if isinstance(A, groups) and isinstance(B, groups):
        order = lambda G: _math.factorial(G.n) if isinstance(G, _MSymGroup) else 2 * G.n
        if order(A) != order(B):
            return _iso_result(False)
        if type(A) is type(B):
            return _iso_result(A.n == B.n)
        S = A if isinstance(A, _MSymGroup) else B
        return _iso_result(S.n == 3)
    for x in (A, B):
        if isinstance(x, _MNumberField) and not isinstance(x, _MCycField) and x.degree() == 1:
            # (Magma makes NumberField of a linear polynomial the rationals,
            # FldRat, which IsIsomorphic refuses as Bad argument types; this
            # field is kept as one of degree 1: refused, whatever the other
            # argument, astra CORR-530-1)
            raise MagmaError("IsIsomorphic of a number field of degree 1 (Magma's rational field) is not supported yet", "'IsIsomorphic'")
    if isinstance(A, _MNumberField) and isinstance(B, _MNumberField):
        if A.degree() != B.degree():
            return _iso_result(False)
        if A.degree() == 1:
            return _iso_result(True)  # (CyclotomicField(1) and (2): both the rationals)
        if A.degree() != 2:
            raise MagmaError("IsIsomorphic of number fields of degree more than 2 is not supported yet", "'IsIsomorphic'")
        return _iso_result(_rational_square(_quadratic_disc(A) * _quadratic_disc(B)))
    known = (int, _Fraction, _IntegerRing, _RationalField, _MFinField, _MNumberField) + groups
    if all(isinstance(x, known) and not isinstance(x, bool) for x in (A, B)):
        raise _bad_types("IsIsomorphic", (A, B))
    raise MagmaError("IsIsomorphic of a %s and a %s is not supported yet" % (_type_of(A), _type_of(B)), "'IsIsomorphic'")


@_signature("Identity", "GrpPerm", ret="GrpPermElt")
def _identity(G):
    """The identity element of the group G."""
    return G._identity()


# ------------------------------------------------------------------ argument guard

# Python and Sage read the string "7" as 7 and true as 1, where Magma's
# intrinsics have no signature for them: every intrinsic refuses a string
# or a boolean argument with Magma's error, except in the positions listed
# here (None: any position).  Checked against Magma.
_STR_ARGS = {"Sprint": None, "Sprintf": None, "Type": None, "Parent": None, "ISA": None, "Index": None, "Position": None,
             "Append": {1}, "Include": {1}, "Exclude": {1}, "Insert": {2},
             "Reverse": {0}, "StringToInteger": {0}, "EllipticCurve": {0}}
# Intrinsics taking integers only, at these positions: a rational there,
# an integral one too (Rationals()!4, 8/2), is Magma's "Bad argument types"
# (checked against Magma, CORR-765-1).
_INT_ARGS = {"Factorial": {0}, "Binomial": {0, 1}, "IsEven": {0}, "IsOdd": {0}, "Factorization": {0},
             "Divisors": {0}, "PrimeDivisors": {0}, "NumberOfDivisors": {0}, "NextPrime": {0},
             "PreviousPrime": {0}, "IsProbablePrime": {0}, "Isqrt": {0}, "Fibonacci": {0}, "PrimesUpTo": {0}}
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
    ints = _INT_ARGS.get(name, ())

    def intrinsic(*args, **kw):
        if name not in _FF_PLAIN:
            try:
                held = _ff_scan(args)
            except _FFUnseen as e:
                if e.args and e.args[0] == "run":
                    raise MagmaError("%s: Sagebrush's checks of arguments for polynomials and matrices over finite fields reached their "
                                     "limit for this run; this call is not supported" % name, "'%s'" % name)
                raise MagmaError("%s of a value too large or too deep for Sagebrush to check (for polynomials and matrices over finite "
                                 "fields) is not supported yet" % name, "'%s'" % name)
        else:
            held = [a if isinstance(a, _FFALL) else None for a in args]
        if any(h is not None for h in held):
            _FF_CUR[0] = held
            try:
                _ff_admit_args(name, args, kw)
            finally:
                _FF_CUR[0] = None
        for i, a in enumerate(args):
            if i in ints and isinstance(a, _Fraction):
                raise _bad_types(name, args)
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


# an intrinsic of registered signatures is its dispatcher (_signature)
for _n in _SIGNATURES:
    assert _n not in globals(), _n
    globals()[_n] = _dispatcher(_n)


for _n, _f in list(globals().items()):
    if _n[:1].isupper() and not _n.endswith("_") and type(_f) is type(_guarded) \
            and getattr(_f, "__module__", None) == __name__:
        globals()[_n] = _guarded(_n, _f)


__all__ = [n for n, v in list(globals().items())
           if not n.startswith("_") and (callable(v) or isinstance(v, type)) and getattr(v, "__module__", None) == __name__]
__all__ += _CATEGORIES


# (the comprehension bound, taken once, now that this module and all it
# imports are loaded: see _collect_max)
_COLLECT_MAX = _collect_max()
