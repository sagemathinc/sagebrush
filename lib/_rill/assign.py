"""Rill's replacement builtins for atomic vectors (design/rill.md §8.3): `[<-`, `[[<-` and `names<-`, the
functions eval.py's replacement path (`f(x, ...) <- value`) calls, as R 4.5.3 gives them (rill-tests/vec/).

Each builds a new vector: the old one is never changed, so another variable holding it keeps its values (R's
copy on modify), and a refusal leaves the variable as it was.  What R does, observed:

- `x[i] <- value`: positive, negative, logical and character subscripts, an empty one for all of x; positions
  past the end grow x with NA (and "" names when x has names); a name not in x's names adds an element under
  that name; the value is recycled, with R's warning when the positions aren't a multiple of its length; the
  result's type is the higher of x's and the value's.
- `x[[i]] <- value`: one position or name, one value.
- `names(x) <- value`: as character, padded with NA; NULL removes them.

Lists are r3's (lists.py): their branches go on top of these.
"""

import math

from . import mem
from .access import _positions
from .eval import NotSupported, RError
from .values import MISSING, NULL, RVector

ORDER = ("logical", "integer", "double", "complex", "character")


def _higher(a, b):
    return a if ORDER.index(a) >= ORDER.index(b) else b


def _coerce(v, to):
    """v's elements as type `to` (base.coerce's rules)."""
    from .base import coerce
    return v.data if v.type == to else coerce(v, to)


def _target(x, call):
    if x is NULL:
        return RVector("logical", [])
    if not isinstance(x, RVector):
        raise NotSupported("replacing in this kind of value")
    return x


def _value(v, call):
    if v is NULL or (isinstance(v, RVector) and not v.data):
        raise RError("replacement has length zero", call)
    if not isinstance(v, RVector):
        raise NotSupported("replacing with this kind of value")
    return v


def _names(x):
    return x.attrs.get("names") if x.attrs else None


def _assign_positions(i, x, call):
    """The 0-based positions `x[i] <- v` writes (None: an NA subscript), and the new names it adds (for
    positions past the end reached by name)."""
    if i is MISSING:
        return list(range(len(x.data))), {}
    if isinstance(i, RVector) and i.type == "character":
        nm = _names(x)
        where = {}
        if nm is not None:
            for k, s in enumerate(nm.data):
                if s is not None and s not in where:
                    where[s] = k
        out, added, n = [], {}, len(x.data)
        for s in i.data:
            if s is None:
                raise NotSupported("an NA name in a replacement")
            if s not in where:
                where[s] = n + len(added)
                added[where[s]] = s
            out.append(where[s])
        return out, added
    if isinstance(i, RVector) and i.type in ("logical", "integer", "double"):
        return _positions(i, x, call), {}
    if isinstance(i, RVector) or i is NULL:
        return _positions(i, x, call), {}
    raise RError("invalid subscript type '%s'" % _kind(i), call)


def _kind(v):
    from .values import Lang, Sym
    if isinstance(v, Sym):
        return "symbol"
    if isinstance(v, Lang):
        return "language"
    return "list"


def subassign(sess, call, args):
    """`[<-`(x, i, value)."""
    if len(args) > 3:
        raise NotSupported("[<- with %d subscripts" % (len(args) - 2))
    x = _target(args[0][1], call)
    # (x[] <- v: no subscript, all of x)
    i = args[1][1] if len(args) == 3 else MISSING
    value = _value(args[-1][1], call)
    n = len(x.data)
    bound = max(n, len(i.data) if isinstance(i, RVector) else n)
    with mem.reserve(bound, "integer"):
        pos, added = _assign_positions(i, x, call)
    if any(p is None for p in pos):
        if len(value.data) > 1:
            raise RError("NAs are not allowed in subscripted assignments", call)
        pos = [p for p in pos if p is not None]
    m = len(value.data)
    if pos and len(pos) % m:
        sess.warn("number of items to replace is not a multiple of replacement length", call)
    rtype = _higher(x.type, value.type)
    size = max([n] + [p + 1 for p in pos])
    nm = _names(x)
    extra = [(size, "character")] if (nm is not None or added) else []
    with mem.reserve(size, rtype, *extra):
        data = list(_coerce(x, rtype)) + [None] * (size - n)
        vals = _coerce(value, rtype)
        for k, p in enumerate(pos):
            data[p] = vals[k % m]
        out = RVector(rtype, data)
        if nm is not None or added:
            names = (list(nm.data) if nm is not None else [""] * n) + [""] * (size - n)
            for p, s in added.items():
                names[p] = s
            out.attrs = {"names": RVector("character", names)}
        return out


def subassign2(sess, call, args):
    """`[[<-`(x, i, value): one element."""
    if len(args) != 3:
        raise NotSupported("[[<- with these arguments")
    x = _target(args[0][1], call)
    i, value = args[1][1], args[2][1]
    if value is NULL or (isinstance(value, RVector) and not value.data):
        raise RError("replacement has length zero", call)
    if not isinstance(value, RVector):
        raise NotSupported("[[<- with this kind of value")
    if len(value.data) > 1:
        raise RError("more elements supplied than there are to replace", call)
    if not isinstance(i, RVector) or len(i.data) != 1:
        raise NotSupported("[[<- with this subscript")
    if i.type in ("integer", "double"):
        e = i.data[0]
        if e is None or (isinstance(e, float) and (e != e or math.isinf(e))):
            raise NotSupported("[[<- with an NA subscript")
        if int(e) < 1:
            raise RError("attempt to select less than one element in OneIndex <real>" if i.type == "double"
                         else "attempt to select less than one element in OneIndex", call)
    elif i.type != "character":
        raise NotSupported("[[<- with a %s subscript" % i.type)
    return subassign(sess, call, [args[0], (None, i), ("value", value)])


def names_assign(sess, call, args):
    """`names<-`(x, value)."""
    x, value = args[0][1], args[1][1]
    if not isinstance(x, RVector):
        raise NotSupported("names<- of this kind of value")
    n = len(x.data)
    attrs = dict(x.attrs) if x.attrs else {}
    if value is NULL:
        attrs.pop("names", None)
        return RVector(x.type, x.data, attrs or None)
    if not isinstance(value, RVector):
        raise NotSupported("names<- with this kind of value")
    if len(value.data) > n:
        raise RError("'names' attribute [%d] must be the same length as the vector [%d]" % (len(value.data), n), call)
    with mem.reserve(n, "character"):
        names = list(_coerce(value, "character")) + [None] * (n - len(value.data))
        attrs["names"] = RVector("character", names)
        return RVector(x.type, x.data, attrs)
