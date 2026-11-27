"""Rill's vector operations (design/rill.md A3): which, which.max, which.min, range, cumsum, cumprod, cummax,
cummin, diff, unique, duplicated, any, all, %in%, match, sort and order, as R 4.5.3 gives them
(rill-tests/vec/).

What R does, observed:

- which keeps names and skips NA; which.max and which.min give the first position, ignoring NA.
- cumsum and cumprod accumulate in extended precision (summary._LD) and round each element; an NA makes the rest
  NA; an integer cumsum that overflows is NA from there, with R's warning.  cummax and cummin keep the type.
  All keep names.
- diff takes its names from the later elements.  R's diff dispatches to diff.default, which its errors name.
- unique drops names; NA matches NA, and NaN matches NaN.
- match and %in% compare in the higher of the two types (match("1", 1) is 1).
- sort drops NA unless na.last = TRUE and keeps names; order puts NA last.  Both are stable, decreasing too.
- any and all coerce a double or a string to logical with R's warning (integers silently).
"""

import math

from . import mem
from .eval import NotSupported, RError
from .values import NULL, RVector

ORDER = ("logical", "integer", "double", "complex", "character")
INT_MAX = 2147483647


def _arg(args, formal, default=None):
    for name, v in args:
        if name == formal:
            return v
    return default


def _vec(v, what):
    if v is NULL:
        return RVector("logical", [])
    if not isinstance(v, RVector):
        raise NotSupported("%s() of this kind of value" % what)
    return v


def _names(v):
    return v.attrs.get("names") if v.attrs else None


def _with(t, data, names):
    out = RVector(t, data)
    if names is not None:
        out.attrs = {"names": RVector("character", names)}
    return out


def _flag(v, what, call):
    """A logical scalar argument such as na.rm or decreasing."""
    if v is None:
        return False
    if isinstance(v, RVector) and v.type == "logical" and len(v.data) == 1 and v.data[0] is not None:
        return v.data[0]
    raise NotSupported("%s = other than TRUE or FALSE" % what)


def _is_na(e):
    return e is None or (isinstance(e, float) and e != e)


# ---------------------------------------------------------------- which

def which(sess, call, args):
    x = _vec(args[0][1], "which")
    if x.type != "logical":
        raise RError("argument to 'which' is not logical", call)
    nm = _names(x)
    with mem.reserve(len(x.data), "integer", *([(len(x.data), "character")] if nm is not None else [])):
        pos = [k for k, e in enumerate(x.data) if e]
        return _with("integer", [k + 1 for k in pos], [nm.data[k] for k in pos] if nm is not None else None)


def _which_extreme(args, which_, call):
    x = _vec(args[0][1], which_)
    if x.type not in ("logical", "integer", "double"):
        raise NotSupported("%s() of a %s vector" % (which_, x.type))
    best = None
    for k, e in enumerate(x.data):
        if _is_na(e):
            continue
        if best is None or (e > x.data[best] if which_ == "which.max" else e < x.data[best]):
            best = k
    if best is None:
        return RVector("integer", [])
    nm = _names(x)
    return _with("integer", [best + 1], [nm.data[best]] if nm is not None else None)


def which_max(sess, call, args):
    return _which_extreme(args, "which.max", call)


def which_min(sess, call, args):
    return _which_extreme(args, "which.min", call)


def range_(sess, call, args):
    from .summary import max_, min_
    before = len(sess.warnings)
    lo = min_(sess, call, args)
    hi = max_(sess, call, args)
    if len(sess.warnings) > before:
        # (R warns twice, from min and max: several warnings in one statement are refused for now)
        del sess.warnings[before:]
        raise NotSupported("range() with nothing to compare")
    t = lo.type if ORDER.index(lo.type) >= ORDER.index(hi.type) else hi.type
    return RVector(t, [lo.data[0], hi.data[0]])


# ---------------------------------------------------------------- cumulative

def _cumulative(sess, call, args, op):
    from .summary import _LD
    x = _vec(args[0][1], op)
    if x.type in ("character", "complex"):
        raise NotSupported("%s() of a %s vector" % (op, x.type))
    n = len(x.data)
    nm = _names(x)
    rtype = "double" if (x.type == "double" or op == "cumprod") else "integer"
    with mem.reserve(n, rtype, *([(n, "character")] if nm is not None else [])):
        out, acc, dead = [], None, False
        for e in x.data:
            if dead or e is None:
                dead = True
                out.append(None)
                continue
            if op in ("cummax", "cummin"):
                if isinstance(e, float) and e != e:
                    dead = True
                    out.append(math.nan)
                    continue
                acc = e if acc is None else (max(acc, e) if op == "cummax" else min(acc, e))
                out.append(float(acc) if rtype == "double" else int(acc))
            elif rtype == "integer":
                acc = int(e) + (acc or 0)
                if not -INT_MAX <= acc <= INT_MAX:
                    sess.warn("integer overflow in 'cumsum'; use 'cumsum(as.numeric(.))'")
                    dead = True
                    out.append(None)
                    continue
                out.append(acc)
            else:
                if isinstance(e, float) and (e != e or math.isinf(e)):
                    raise NotSupported("%s() of NaN or Inf" % op)
                v = _LD.of(float(e))
                acc = v if acc is None else (acc.add(v) if op == "cumsum" else acc.mul(v))
                out.append(acc.to_double())
        return _with(rtype, out, list(nm.data) if nm is not None else None)


def cumsum(sess, call, args):
    return _cumulative(sess, call, args, "cumsum")


def cumprod(sess, call, args):
    return _cumulative(sess, call, args, "cumprod")


def cummax(sess, call, args):
    return _cumulative(sess, call, args, "cummax")


def cummin(sess, call, args):
    return _cumulative(sess, call, args, "cummin")


def _int_arg(v, call):
    if isinstance(v, RVector) and v.type in ("integer", "double") and len(v.data) == 1 and v.data[0] is not None:
        e = v.data[0]
        if e == e and not math.isinf(e) and e == int(e) and e >= 1:
            return int(e)
    from .values import Lang, sym
    e = RError("'lag' and 'differences' must be integers >= 1", Lang(sym("diff.default"), call.args))
    e.frames = ("diff", "diff.default")
    raise e


def diff(sess, call, args):
    x = _vec(args[0][1], "diff")
    if x.type in ("character", "complex"):
        raise NotSupported("diff() of a %s vector" % x.type)
    lag = 1 if _arg(args, "lag") is None else _int_arg(_arg(args, "lag"), call)
    times = 1 if _arg(args, "differences") is None else _int_arg(_arg(args, "differences"), call)
    rtype = "double" if x.type == "double" else "integer"
    data = [None if e is None else (float(e) if rtype == "double" else int(e)) for e in x.data]
    nm = _names(x)
    names = list(nm.data) if nm is not None else None
    with mem.reserve(len(data), rtype):
        for _ in range(times):
            if len(data) <= lag:
                data, names = [], ([] if names is not None else None)
                break
            data = [None if (a is None or b is None) else b - a for a, b in zip(data, data[lag:])]
            if names is not None:
                names = names[lag:]
        if rtype == "integer" and any(e is not None and not -INT_MAX <= e <= INT_MAX for e in data):
            raise NotSupported("an integer diff() that overflows")
        return _with(rtype, data, names)


# ---------------------------------------------------------------- matching

def _key(e, t):
    """An element as a matching key: NA and NaN each match only themselves."""
    if e is None:
        return ("NA",)
    if isinstance(e, float) and e != e:
        return ("NaN",)
    if t == "double" and e == 0:
        return 0.0
    return e


def _common(x, table):
    from .base import coerce
    t = x.type if ORDER.index(x.type) >= ORDER.index(table.type) else table.type
    return t, coerce(x, t), coerce(table, t)


def _match_positions(x, table):
    t, xs, ts = _common(x, table)
    first = {}
    for k, e in enumerate(ts):
        first.setdefault(_key(e, t), k + 1)
    return [first.get(_key(e, t)) for e in xs]


def match(sess, call, args):
    x, table = _vec(args[0][1], "match"), _vec(_arg(args, "table", NULL) if len(args) > 1 else NULL, "match")
    nomatch = _arg(args, "nomatch")
    nm = None
    if nomatch is not None:
        if not (isinstance(nomatch, RVector) and nomatch.type in ("logical", "integer", "double") and len(nomatch.data) == 1):
            raise NotSupported("match(nomatch =) other than one number")
        nm = nomatch.data[0] if nomatch.data[0] is None else int(nomatch.data[0])
    for name, _ in args:
        if name not in ("x", "table", "nomatch"):
            raise NotSupported("match() with %s =" % name)
    with mem.reserve(len(x.data) + len(table.data), "integer"):
        return RVector("integer", [p if p is not None else nm for p in _match_positions(x, table)])


def in_(sess, call, args):
    x, table = _vec(args[0][1], "%in%"), _vec(args[1][1], "%in%")
    with mem.reserve(len(x.data) + len(table.data), "logical"):
        return RVector("logical", [p is not None for p in _match_positions(x, table)])


def duplicated(sess, call, args):
    x = _vec(args[0][1], "duplicated")
    seen = set()
    with mem.reserve(len(x.data), "logical", (len(x.data), x.type)):
        out = []
        for e in x.data:
            k = _key(e, x.type)
            out.append(k in seen)
            seen.add(k)
        return RVector("logical", out)


def unique(sess, call, args):
    x = args[0][1]
    if x is NULL:
        return NULL
    x = _vec(x, "unique")
    seen = set()
    with mem.reserve(len(x.data), x.type, (len(x.data), x.type)):
        out = []
        for e in x.data:
            k = _key(e, x.type)
            if k not in seen:
                seen.add(k)
                out.append(e)
        return RVector(x.type, out)


# ---------------------------------------------------------------- any and all

def _any_all(sess, call, args, which_):
    na_rm = _flag(_arg(args, "na.rm"), "na.rm", call)
    found_na = False
    for name, v in args:
        if name == "na.rm" or v is NULL:
            continue
        if not isinstance(v, RVector) or v.type == "complex":
            raise NotSupported("%s() of this kind of value" % which_)
        if v.type in ("double", "character"):
            sess.warn("coercing argument of type '%s' to logical" % v.type, call)
        for e in v.data:
            if v.type == "character":
                b = {"TRUE": True, "true": True, "T": True, "True": True, "FALSE": False, "false": False,
                     "F": False, "False": False}.get(e)
            elif _is_na(e):
                b = None
            else:
                b = e != 0
            if b is None:
                found_na = True
            elif b is (which_ == "any"):
                return RVector("logical", [b])
    if found_na and not na_rm:
        return RVector("logical", [None])
    return RVector("logical", [which_ == "all"])


def any_(sess, call, args):
    return _any_all(sess, call, args, "any")


def all_(sess, call, args):
    return _any_all(sess, call, args, "all")


# ---------------------------------------------------------------- sort and order

def _sort_key(t):
    if t == "character":
        from .base import _collate_key
        return _collate_key
    if t == "complex":
        return lambda z: (z.real, z.imag)
    return lambda e: e


def _order_of(x, decreasing):
    """Positions of x's non-NA elements in order (stable, decreasing too), then its NA positions."""
    key = _sort_key(x.type)
    good = [k for k, e in enumerate(x.data) if not _is_na(e)]
    bad = [k for k, e in enumerate(x.data) if _is_na(e)]
    good.sort(key=lambda k: key(x.data[k]), reverse=decreasing)
    return good, bad


def sort(sess, call, args):
    x = args[0][1]
    if x is NULL:
        return NULL
    x = _vec(x, "sort")
    decreasing = _flag(_arg(args, "decreasing"), "decreasing", call)
    na_last = _arg(args, "na.last")
    keep_na = False
    if na_last is not None:
        if not (isinstance(na_last, RVector) and na_last.type == "logical" and len(na_last.data) == 1):
            raise NotSupported("sort(na.last =) of this kind")
        if na_last.data[0] is False:
            raise NotSupported("sort(na.last = FALSE)")
        keep_na = na_last.data[0] is True
    nm = _names(x)
    with mem.reserve(len(x.data), x.type, (len(x.data), "integer"), *([(len(x.data), "character")] if nm is not None else [])):
        good, bad = _order_of(x, decreasing)
        pos = good + (bad if keep_na else [])
        return _with(x.type, [x.data[k] for k in pos], [nm.data[k] for k in pos] if nm is not None else None)


def order(sess, call, args):
    keys = [v for name, v in args if name is None]
    decreasing = _flag(_arg(args, "decreasing"), "decreasing", call)
    for name, _ in args:
        if name not in (None, "decreasing"):
            raise NotSupported("order() with %s =" % name)
    if not keys:
        return RVector("integer", [])
    vs = [_vec(v, "order") for v in keys]
    n = len(vs[0].data)
    if any(len(v.data) != n for v in vs):
        raise RError("argument lengths differ", call)
    if len(vs) == 1:
        with mem.reserve(n, "integer"):
            good, bad = _order_of(vs[0], decreasing)
            return RVector("integer", [k + 1 for k in good + bad])
    if any(_is_na(e) for v in vs for e in v.data):
        raise NotSupported("order() of several keys with NA")
    fs = [_sort_key(v.type) for v in vs]
    with mem.reserve(n, "integer"):
        idx = sorted(range(n), key=lambda k: tuple(f(v.data[k]) for f, v in zip(fs, vs)), reverse=decreasing)
        return RVector("integer", [k + 1 for k in idx])
