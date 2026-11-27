"""Rill's sequences and repetition (design/rill.md A3): seq, seq_len, seq_along,
rep, rep_len and rev, as R 4.5.3 gives them (rill-tests/vec/).

What R prints, observed:

- seq(from, to, by): from + i*by for i = 0 .. n, n = floor((to - from)/by +
  1e-10) (a last step short of `to` by at most 1e-10 of a step is taken), and
  that last element is `to` itself when it overshoots; integer when from, to
  and by are all integers, else double.
- seq(..., length.out =): evenly spaced, from + i*by, the last element `to`
  itself when both ends are given; double, except seq(length.out = n) and an
  empty result, which are integer.
- seq(from, to) is from:to; seq(x) alone is 1:x for one number, else
  seq_along(x).
- seq's errors name seq.default, as R's seq is a function that dispatches to
  that method (Calls: seq -> seq.default).
"""

import math

from . import mem
from .eval import NotSupported, RError
from .values import NULL, RVector

BY_FUZZ = 1e-10


def _arg(args, formal, default=None):
    for name, v in args:
        if name == formal:
            return v
    return default


def _len_of(v):
    return 0 if v is NULL else len(v.data) if isinstance(v, RVector) else None


def _scalar(v, what, call):
    """A seq end or step: one finite number (R's "'from' must be a finite number")."""
    if isinstance(v, RVector) and v.type in ("logical", "integer", "double") and len(v.data) == 1:
        e = v.data[0]
        if e is not None and e == e and not math.isinf(e):
            return float(e)
        raise _framed(RError("'%s' must be a finite number" % what, call))
    if isinstance(v, RVector) and len(v.data) != 1:
        raise _framed(RError("'%s' must be of length 1" % what, call))
    raise NotSupported("seq() with a %s of this type" % what)


def _is_int(v):
    return isinstance(v, RVector) and v.type == "integer"


def _method_call(call, name):
    """R's header for an error in a method: the call as written, under the method's name (seq.default(1, ...))."""
    from .values import Lang, sym
    return Lang(sym(name), call.args)


def _framed(e):
    e.frames = ("seq", "seq.default")
    return e


def _seq_error(message, call):
    return _framed(RError(message, _method_call(call, "seq.default")))


def _out(rtype, values):
    with mem.reserve(len(values), rtype):
        return RVector(rtype, values)


def _ints(a, n):
    with mem.reserve(n, "integer"):
        return RVector("integer", list(range(a, a + n)))


def _length_out(v, call):
    """length.out: one non-negative number, rounded up (R: seq(1, 10, length.out = 2.5) has 3 elements)."""
    if isinstance(v, RVector) and v.type in ("logical", "integer", "double") and len(v.data) == 1:
        e = v.data[0]
        if e is not None and e == e and not math.isinf(e) and e >= 0:
            return int(math.ceil(e))
    raise _seq_error("'length.out' must be a non-negative number", call)


def seq(sess, call, args):
    from_, to, by = _arg(args, "from"), _arg(args, "to"), _arg(args, "by")
    lo, along = _arg(args, "length.out"), _arg(args, "along.with")
    for name, _ in args:
        if name not in ("from", "to", "by", "length.out", "along.with"):
            raise NotSupported("seq() with other arguments")
    n = None
    if along is not None:
        n = _len_of(along)
        if n is None:
            raise NotSupported("seq(along.with =) of this kind of value")
    elif lo is not None and lo is not NULL:
        n = _length_out(lo, call)
    given = [x is not None for x in (from_, to, by)]
    if all(given) and n is not None:
        raise _seq_error("too many arguments", call)
    if n is None:
        if from_ is not None and to is None and by is None:
            # seq(x): 1:x for one number, else along x
            if isinstance(from_, RVector) and len(from_.data) == 1 and from_.type in ("logical", "integer", "double"):
                from .base import colon
                return colon(sess, call, [(None, RVector("integer", [1])), (None, from_)])
            k = _len_of(from_)
            if k is None:
                raise NotSupported("seq() of this kind of value")
            return _ints(1, k)
        if by is None:
            # seq(from, to): from:to, each end checked as seq.default checks it (a missing end is 1)
            from .base import colon
            ends = []
            for v, what in ((from_, "from"), (to, "to")):
                if v is not None:
                    _scalar(v, what, _method_call(call, "seq.default"))
                ends.append((None, v if v is not None else RVector("integer", [1])))
            return colon(sess, call, ends)
        return _seq_by(from_, to, by, call)
    return _seq_length(from_, to, by, n, call)


def _seq_by(from_, to, by, call):
    mc = _method_call(call, "seq.default")
    a = 1.0 if from_ is None else _scalar(from_, "from", mc)
    b = 1.0 if to is None else _scalar(to, "to", mc)
    s = _scalar(by, "by", mc)
    as_int = _is_int(from_) and _is_int(to) and _is_int(by)
    delta = b - a
    if delta == 0:
        return _out("integer" if as_int else "double", [int(a) if as_int else a])
    if s == 0:
        raise _seq_error("invalid '(to - from)/by'", call)
    q = delta / s
    if q < 0:
        raise _seq_error("wrong sign in 'by' argument", call)
    n = int(math.floor(q + BY_FUZZ))
    if as_int:
        a, s = int(a), int(s)
        return _out("integer", [a + i * s for i in range(n + 1)])
    with mem.reserve(n + 1, "double"):
        xs = [a + i * s for i in range(n + 1)]
        # (the last element never passes `to`: it is `to` itself)
        if (s > 0 and xs[-1] > b) or (s < 0 and xs[-1] < b):
            xs[-1] = b
        return RVector("double", xs)


def _seq_length(from_, to, by, n, call):
    mc = _method_call(call, "seq.default")
    if n == 0:
        return RVector("integer", [])
    has_from, has_to, has_by = from_ is not None, to is not None, by is not None
    if not (has_from or has_to or has_by):
        return _ints(1, n)
    if has_from and has_to:
        a, b = _scalar(from_, "from", mc), _scalar(to, "to", mc)
        if n == 1:
            return _out("double", [a])
        s = (b - a) / (n - 1)
        with mem.reserve(n, "double"):
            xs = [a + i * s for i in range(n)]
            xs[-1] = b
            return RVector("double", xs)
    s = 1.0 if not has_by else _scalar(by, "by", mc)
    if has_to and not has_from:
        b = _scalar(to, "to", mc)
        return _out("double", [b - (n - 1 - i) * s for i in range(n)])
    a = 1.0 if not has_from else _scalar(from_, "from", mc)
    return _out("double", [a + i * s for i in range(n)])


def _count(v):
    """seq_len's length: the first element (a warning when there are more), at least 0."""
    if isinstance(v, RVector) and v.type in ("logical", "integer", "double", "character") and v.data:
        e = v.data[0]
        if v.type == "character":
            try:
                e = float(e) if e is not None else None
            except ValueError:
                e = None
        if e is not None and e == e and not math.isinf(e) and e >= 0:
            return int(e)
    return None


def seq_len(sess, call, args):
    v = args[0][1]
    n = _count(v)
    if n is None:
        raise RError("argument must be coercible to non-negative integer", call)
    if len(v.data) > 1:
        sess.warn("first element used of 'length.out' argument", call)
    return _ints(1, n)


def seq_along(sess, call, args):
    k = _len_of(args[0][1])
    if k is None:
        raise NotSupported("seq_along() of this kind of value")
    return _ints(1, k)


# ---------------------------------------------------------------- rep

def _counts(v, what, call):
    """rep's times or each: non-negative whole counts (2.9 is 2), R's "invalid 'times' argument" otherwise."""
    if not isinstance(v, RVector) or v.type not in ("logical", "integer", "double") or not v.data:
        raise RError("invalid '%s' argument" % what, call)
    out = []
    for e in v.data:
        if e is None or e != e or math.isinf(e) or e < 0:
            raise RError("invalid '%s' argument" % what, call)
        out.append(int(e))
    return out


def _names(v):
    return v.attrs.get("names") if v.attrs else None


def rep(sess, call, args):
    x = args[0][1] if args and args[0][0] == "x" else None
    for name, _ in args:
        if name not in ("x", "times", "each", "length.out"):
            raise NotSupported("rep() with other arguments")
    if x is None or x is NULL:
        return NULL
    if not isinstance(x, RVector):
        raise NotSupported("rep() of this kind of value")
    times, each, lo = _arg(args, "times"), _arg(args, "each"), _arg(args, "length.out")
    k = 1
    if each is not None:
        c = _counts(each, "each", call)
        if len(c) > 1:
            raise NotSupported("rep() with several 'each' counts")
        k = c[0]
    nm = _names(x)
    data = x.data
    names = nm.data if nm is not None else None
    # (each first, then times or length.out: one element index list, sized before anything is built)
    base = [i for i in range(len(data)) for _ in range(k)] if k != 1 else list(range(len(data)))
    out_len = None
    if lo is not None and not (isinstance(lo, RVector) and len(lo.data) == 1 and lo.data[0] is None):
        c = _counts(lo, "length.out", call)
        out_len = c[0]
    if out_len is not None:
        idx = [base[i % len(base)] for i in range(out_len)] if base else []
    elif times is not None:
        c = _counts(times, "times", call)
        if len(c) == 1:
            total = c[0] * len(base)
            with mem.reserve(total, "integer"):
                idx = base * c[0]
        elif len(c) == len(base):
            total = sum(c)
            with mem.reserve(total, "integer"):
                idx = [i for i, t in zip(base, c) for _ in range(t)]
        else:
            raise RError("invalid 'times' argument", call)
    else:
        idx = base
    extra = [(len(idx), "character")] if names is not None else []
    with mem.reserve(len(idx), x.type, *extra):
        out = RVector(x.type, [data[i] for i in idx])
        if names is not None:
            out.attrs = {"names": RVector("character", [names[i] for i in idx])}
        return out


def rep_len(sess, call, args):
    x, lo = args[0][1], args[1][1]
    n = None
    if isinstance(lo, RVector) and len(lo.data) == 1 and lo.type in ("logical", "integer", "double"):
        e = lo.data[0]
        if e is not None and e == e and not math.isinf(e) and e >= 0:
            n = int(e)
    if n is None:
        raise RError("invalid 'length.out' value", call)
    if x is NULL:
        return NULL
    if not isinstance(x, RVector):
        raise NotSupported("rep_len() of this kind of value")
    if not x.data and n:
        raise NotSupported("rep_len() of a zero-length vector")
    # (no names: rep_len drops them, R 4.5.3)
    with mem.reserve(n, x.type):
        return RVector(x.type, [x.data[i % len(x.data)] for i in range(n)])


def rev(sess, call, args):
    x = args[0][1]
    if x is NULL:
        return NULL
    if not isinstance(x, RVector):
        raise NotSupported("rev() of this kind of value")
    nm = _names(x)
    extra = [(len(x.data), "character")] if nm is not None else []
    with mem.reserve(len(x.data), x.type, *extra):
        out = RVector(x.type, x.data[::-1])
        if nm is not None:
            out.attrs = {"names": RVector("character", nm.data[::-1])}
        return out
