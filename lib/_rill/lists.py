"""A3's lists (design/rill.md §4): list(), is.list, the list forms of length, names, `[`, `[[` and `$`, `[[` on
atomic vectors, and unlist.  What each returns, prints and refuses is R 4.5.3's (rill-tests/list/); each result's
whole peak is reserved before it is built (§8.5).  A list shares its elements, never copies them: values are not
changed in place (replacement is later work), so a slot is one reference.

Nested lists can be as deep as the evaluator nests calls (options(expressions)), so everything that walks one
(unlist, printing) keeps its own stack, never host recursion (§8.4).

Each builtin is called as f(session, call, args), args being (formal or name, value) after R's matching.
"""

import math

from . import mem
from .eval import NotSupported, RError
from .values import MISSING, NULL, RList, RVector, Sym

RANK = {"logical": 0, "integer": 1, "double": 2, "complex": 3, "character": 4}


def names_of(v):
    return v.attrs.get("names") if isinstance(v, (RVector, RList)) and v.attrs else None


def _only_names(v, what):
    if v.attrs and set(v.attrs) != {"names"}:
        raise NotSupported("%s of a list with attributes other than names" % what)


# ---------------------------------------------------------------- list() and is.list

def list_(sess, call, args):
    """list(...): the values as given, each tagged by its argument's name; names only when one has a tag."""
    n = len(args)
    named = any(name is not None for name, _ in args)
    with mem.reserve(n, "list", *([(n, "character")] if named else [])):
        data = [v for _, v in args]
        for v in data:
            if not (v is NULL or isinstance(v, (RVector, RList))):
                raise NotSupported("a list of this kind of value")
        if not named:
            return RList(data)
        return RList(data, {"names": RVector("character", ["" if name is None else name for name, _ in args])})


def is_list(sess, call, args):
    return RVector("logical", [isinstance(args[0][1], RList)])


# ---------------------------------------------------------------- [ on a list

def index_list(x, i, call):
    """x[i] for a list: the elements at the positions `[`'s rules pick, each a NULL where the position is past
    the end or NA, named <NA> there when x has names or the index is by name (R 4.5.3)."""
    from .access import _positions
    _only_names(x, "`[`")
    if i is MISSING:
        return x
    n = len(x.data)
    names = names_of(x)
    bound = max(n, len(i.data)) if isinstance(i, RVector) else 0
    with mem.reserve(bound, "list", (bound, "integer"), *([(bound, "character")] if names is not None else [])):
        picks = _positions(i, x, call)
        data = [x.data[p] if p is not None and p < n else NULL for p in picks]
        if names is None:
            # (no names, so none in the result, even by name: list(1, 2)["z"] is [[1]] NULL, R 4.5.3)
            return RList(data)
        nm = [names.data[p] if p is not None and p < n else None for p in picks]
        return RList(data, {"names": RVector("character", nm)})


# ---------------------------------------------------------------- [[

def double_bracket(sess, call, args):
    """x[[i]] (and x[[i, exact = FALSE]]): one element, by a single position or name, of a list or an atomic
    vector; R 4.5.3's errors and NULLs (rill-tests/list/)."""
    exact = True
    rest = []
    for name, v in args:
        if name == "exact":
            if not (isinstance(v, RVector) and v.type == "logical" and len(v.data) == 1 and v.data[0] is not None):
                raise NotSupported("[[ with this exact =")
            exact = v.data[0]
        elif name is not None:
            raise NotSupported("[[ with a named argument other than exact")
        else:
            rest.append(v)
    if len(rest) != 2:
        raise NotSupported("[[ with %s" % ("no subscript" if len(rest) < 2 else "several dimensions"))
    x, i = rest
    if x is NULL:
        return NULL
    if not isinstance(x, (RVector, RList)):
        raise NotSupported("[[ on this kind of value")
    if isinstance(i, RList):
        raise RError("invalid subscript type 'list'", call)
    if not isinstance(i, RVector) or not i.data:
        raise NotSupported("[[ with this subscript")
    if len(i.data) > 1:
        # (several subscripts: R's recursive indexing on a list, an error on an atomic vector; refused until a case
        # needs them)
        raise NotSupported("[[ with several subscripts")
    is_list = isinstance(x, RList)
    if is_list:
        _only_names(x, "[[")
    elif x.attrs and set(x.attrs) != {"names"}:
        raise NotSupported("[[ on a vector with attributes other than names")
    n = len(x.data)
    e = i.data[0]
    if i.type == "logical" and e is None:
        # (a bare NA: NULL from a list, an error from an atomic vector, R 4.5.3)
        if is_list:
            return NULL
        raise RError("subscript out of bounds", call)
    if i.type in ("integer", "double"):
        if e is None or (i.type == "double" and e != e):
            if is_list:
                return NULL
            raise RError("subscript out of bounds", call)
        if i.type == "double" and math.isinf(e):
            raise NotSupported("[[ with an infinite subscript")
        k = int(e)  # (toward zero: 1.9 is 1)
        if k < 0:
            raise NotSupported("[[ with a negative subscript")
        if k == 0:
            where = "integerOneIndex" if i.type == "integer" else "get1index <real>"
            raise RError("attempt to select less than one element in %s" % where, call)
        if k > n:
            raise RError("subscript out of bounds", call)
        return _element(x, k - 1)
    if i.type == "character":
        if e is None:
            raise NotSupported("[[ with an NA name")
        names = names_of(x)
        pos = _match_name(names.data if names is not None else [], e, exact)
        if pos is None:
            if is_list:
                return NULL
            raise RError("subscript out of bounds", call)
        return _element(x, pos)
    raise NotSupported("[[ with a %s subscript" % i.type)


def _element(x, k):
    """x's element k: a list's value itself, or an atomic vector's element as a length-one vector (no names)."""
    if isinstance(x, RList):
        return x.data[k]
    return RVector(x.type, [x.data[k]])


def _match_name(names, s, exact):
    """The position of name s: the first exact match; with exact False, else the only name s begins."""
    for k, nm in enumerate(names):
        if nm == s:
            return k
    if exact:
        return None
    hits = [k for k, nm in enumerate(names) if nm is not None and nm.startswith(s)]
    return hits[0] if len(hits) == 1 else None


# ---------------------------------------------------------------- $

def dollar_list(x, call):
    """x$name for a list: the element of that name, else the one name it uniquely begins, else NULL (R's $ on a
    list matches partially, silently)."""
    _only_names(x, "$")
    f = call.args[1][1]
    if isinstance(f, Sym):
        name = f.name
    elif isinstance(f, RVector) and f.type == "character" and len(f.data) == 1 and f.data[0] is not None:
        name = f.data[0]
    else:
        raise NotSupported("$ with this name")
    names = names_of(x)
    pos = _match_name(names.data if names is not None else [], name, False)
    return NULL if pos is None else x.data[pos]


# ---------------------------------------------------------------- unlist

def unlist_(sess, call, args):
    """unlist(x, recursive = TRUE, use.names = TRUE): a list's atomic elements, at any depth, as one vector of
    their highest type, named as c() names its arguments' elements, nested tags joined by "." (R 4.5.3)."""
    x = args[0][1]
    use_names = True
    for name, v in args[1:]:
        flag = v.data[0] if isinstance(v, RVector) and v.type == "logical" and len(v.data) == 1 else None
        if name == "use.names" and flag is not None:
            use_names = flag
        elif name == "recursive" and flag is True:
            pass
        else:
            raise NotSupported("unlist() with %s" % ("recursive = FALSE" if name == "recursive" else "this argument"))
    if not isinstance(x, RList):
        if x is NULL or isinstance(x, RVector):
            return x
        raise NotSupported("unlist() of this kind of value")
    leaves, total, top, any_name, chars = _leaves(x)
    if not leaves:
        return NULL
    named = use_names and any_name
    # (the result, a coerced copy of the largest leaf, and the names with their characters: the whole peak, first)
    widest = max(len(v.data) for _, v in leaves)
    from .base import NAME_CHAR_BYTES, coerce
    with mem.reserve(total, top, (widest, top), *([(total, "character")] if named else []),
                     extra_bytes=NAME_CHAR_BYTES * chars if named else 0):
        out = []
        for _, v in leaves:
            out.extend(coerce(v, top))
        if not named:
            return RVector(top, out)
        return RVector(top, out, {"names": RVector("character", _unlist_names(x))})


def _leaves(x):
    """x's atomic leaves in order, as (path of tags, vector), by an explicit stack; their total length, their
    highest type, whether any tag or name is present, and a bound on the names' characters."""
    leaves, total, top, any_name, chars = [], 0, "logical", False, 0
    stack = [(x, 0, 0)]  # (list, next element, the characters of the tags above it)
    while stack:
        lst, i, depth_chars = stack.pop()
        if i >= len(lst.data):
            continue
        stack.append((lst, i + 1, depth_chars))
        _only_names(lst, "unlist()")
        v = lst.data[i]
        names = names_of(lst)
        tag = names.data[i] if names is not None else None
        tag_chars = depth_chars + (len(tag) + 1 if tag else 0)
        if tag:
            any_name = True
        if v is NULL:
            continue
        if isinstance(v, RList):
            stack.append((v, 0, tag_chars))
            continue
        if not isinstance(v, RVector):
            raise NotSupported("unlist() of this kind of value")
        if v.attrs and set(v.attrs) != {"names"}:
            raise NotSupported("unlist() of a vector with attributes other than names")
        if v.attrs:
            any_name = True
        leaves.append((None, v))
        k = len(v.data)
        total += k
        if RANK[v.type] > RANK[top]:
            top = v.type
        inner = names_of(v)
        chars += k * (tag_chars + len(str(k)))
        if inner is not None:
            chars += sum(len(nm) for nm in inner.data if nm)
    return leaves, total, top, any_name, chars


def _unlist_names(x):
    """The names unlist gives x's leaves (R 4.5.3, rill-tests/list/; fitted to the oracle).  An element with a tag
    names its leaves as c() names its arguments' elements (base._c_names); a leaf from an untagged vector keeps
    its own name, empty if it has none.  A nested list under tag T then names its leaves: T.name for a named one;
    T and the leaf's position under T for an empty name from a named vector; and, for leaves with no name at all,
    T alone when there is just one such leaf under T, else T and its position.  By an explicit stack."""
    from .base import _c_names
    # each frame: [list, next element, items gathered (name, nameless), its tag in its parent]
    stack = [[x, 0, [], None]]
    while True:
        frame = stack[-1]
        lst, i, acc, tag = frame
        if i < len(lst.data):
            frame[1] = i + 1
            v = lst.data[i]
            names = names_of(lst)
            t = names.data[i] if names is not None else None
            t = t if t else None
            if v is NULL:
                continue
            if isinstance(v, RList):
                stack.append([v, 0, [], t])
                continue
            if t is not None:
                acc.extend((nm, False) for nm in _c_names(t, v))
            else:
                inner = names_of(v)
                if inner is not None:
                    acc.extend((nm, False) for nm in inner.data)
                else:
                    acc.extend(("", True) for _ in v.data)
            continue
        stack.pop()
        if not stack:
            return [nm for nm, _ in acc]
        if tag is None:
            stack[-1][2].extend(acc)
            continue
        nameless = sum(1 for _, free in acc if free)
        out = []
        for k, (nm, free) in enumerate(acc):
            if nm:
                out.append(("%s.%s" % (tag, nm), False))
            elif free and nameless == 1:
                out.append((tag, False))
            else:
                out.append(("%s%d" % (tag, k + 1), False))
        stack[-1][2].extend(out)
