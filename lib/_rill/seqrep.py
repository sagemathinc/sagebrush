"""Rill's sequences and repetition (design/rill.md A3): seq, seq_len, seq_along,
rep, rep_len and rev, as R 4.5.3 gives them (rill-tests/vec/).

What R prints, observed:

- seq(from, to, by): from + i*by for i = 0 .. n, n = floor((to - from)/by +
  1e-10) (a last step short of `to` by at most 1e-10 of a step is taken), and
  that last element is `to` itself when it overshoots; where to - from
  overflows, the same at half scale (seq(-1e308, 1e308, by = 1e308) is
  -1e308 0 1e308).  A span under 100 * 2^-52 of the larger end gives `from`;
  (to - from)/by past 2^31 - 1 is R's "'by' argument is much too small".
  Integer when from, to and by are all integer or logical, else double.
- seq(..., length.out =): evenly spaced, from + i*by, the last element `to`
  itself when both ends are given; equal ends give length.out copies.
  Integer when the ends given and by are integer or logical, and the values
  fit: with no by, length.out must be integer too, and with both ends the
  step a whole number; else double.  seq(length.out = n) is 1:n.
- seq(from, to) is from:to; seq(x) alone is 1:x for one number, else
  seq_along(x) (a logical too: seq(FALSE) is 1).
- seq's errors name seq.default, as R's seq is a function that dispatches to
  that method (Calls: seq -> seq.default).
- rep: arguments matched by name, as for a closure (rep(times = 2, x = 1:3));
  each first, then length.out (when it is given and not NA) or times, one
  count or one per element; a zero-length x filled with NA to length.out;
  NULL stays NULL.  An NA or empty each is 1, an NA length.out is ignored,
  and only their first elements are used (with R's warning).

Memory (design §8.5): each reserves its result (and its names) before
building anything; rep computes its length from the counts first and reads
each element's source position from them, so no index list is built.
"""

import math

from . import mem
from .eval import NotSupported, RError
from .values import NULL, Lang, RVector, sym

BY_FUZZ = 1e-10
INT_MAX = 2147483647
# (R 4.5.3: seq(1, 1 + 2.2e-14, by = 1e-15) is 1, with 2.25e-14 it is the sequence)
TINY_SPAN = 100 * 2.0 ** -52
ORDER = ("logical", "integer", "double")


def _arg(args, formal, default=None):
    for name, v in args:
        if name == formal:
            return v
    return default


def _len_of(v):
    return 0 if v is NULL else len(v.data) if isinstance(v, RVector) else None


def _scalar(v, what, call):
    """A seq end or step: one finite number (R's "'from' must be a finite number")."""
    if isinstance(v, RVector) and v.type in ORDER and len(v.data) == 1:
        e = v.data[0]
        if e is not None and e == e and not math.isinf(e):
            return float(e)
        raise _framed(RError("'%s' must be a finite number" % what, call))
    if isinstance(v, RVector) and len(v.data) != 1:
        raise _framed(RError("'%s' must be of length 1" % what, call))
    raise NotSupported("seq() with a %s of this type" % what)


def _int_like(v):
    return isinstance(v, RVector) and v.type in ("integer", "logical")


def _method_call(call, name):
    """R's header for an error in a method: the call as written, under the method's name (seq.default(1, ...))."""
    return Lang(sym(name), call.args)


def _framed(e):
    e.frames = ("seq", "seq.default")
    return e


def _seq_error(message, call):
    return _framed(RError(message, _method_call(call, "seq.default")))


def _ints(a, n):
    with mem.reserve(n, "integer"):
        return RVector("integer", list(range(a, a + n)))


def _length_out(sess, v, call):
    """length.out: a non-negative number, rounded up (R: seq(1, 10, length.out = 2.5) has 3 elements); its
    first element, with R's warning when there are more."""
    if isinstance(v, RVector) and v.type in ORDER and v.data:
        e = v.data[0]
        if e is not None and e == e and not math.isinf(e) and e >= 0:
            if len(v.data) > 1:
                sess.warn("first element used of 'length.out' argument", call)
            return int(math.ceil(e))
    if isinstance(v, RVector) and not v.data:
        raise NotSupported("seq() with an empty length.out")
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
        n = _length_out(sess, lo, call)
    given = [x is not None for x in (from_, to, by)]
    if all(given) and n is not None:
        raise _seq_error("too many arguments", call)
    mc = _method_call(call, "seq.default")
    if n is None:
        if from_ is not None and to is None and by is None:
            # seq(x): 1:x for one number, else along x
            if isinstance(from_, RVector) and len(from_.data) == 1 and from_.type in ("integer", "double"):
                _scalar(from_, "from", mc)
                return _colon(sess, from_, RVector("integer", [1]), from_, call)
            k = _len_of(from_)
            if k is None:
                raise NotSupported("seq() of this kind of value")
            return _ints(1, k)
        if by is None:
            # seq(from, to): from:to, each end checked as seq.default checks it (a missing end is 1)
            for v, what in ((from_, "from"), (to, "to")):
                if v is not None:
                    _scalar(v, what, mc)
            one = RVector("integer", [1])
            return _colon(sess, None, from_ if from_ is not None else one, to if to is not None else one, call)
        return _seq_by(from_, to, by, call)
    return _seq_length(from_, to, by, lo if along is None else None, n, call)


def _colon(sess, x, a, b, call):
    """a:b for seq, an error in it under R's header (seq(x) writes 1:x's header as seq's, seq(from, to) as
    from:to's)."""
    from .base import colon
    where = call if x is not None else Lang(sym(":"), [(None, sym("from")), (None, sym("to"))])
    try:
        return colon(sess, where, [(None, a), (None, b)])
    except RError as e:
        if e.call is where and x is None:
            _framed(e)
        raise


def _seq_by(from_, to, by, call):
    mc = _method_call(call, "seq.default")
    a = 1.0 if from_ is None else _scalar(from_, "from", mc)
    b = 1.0 if to is None else _scalar(to, "to", mc)
    s = _scalar(by, "by", mc)
    as_int = _int_like(from_) and _int_like(to) and _int_like(by)
    if a == b:
        return _one("integer" if as_int else "double", a)
    delta = b - a
    half = math.isinf(delta)
    if not half and abs(delta) < TINY_SPAN * max(abs(a), abs(b)):
        return _one("double", a)
    if s == 0:
        raise _seq_error("invalid '(to - from)/by'", call)
    # (where to - from overflows, at half scale: exact, as halving a double is)
    q = 2 * ((b / 2 - a / 2) / s) if half else delta / s
    if q != q or math.isinf(q):
        raise _seq_error("invalid '(to - from)/by'", call)
    if q < 0:
        raise _seq_error("wrong sign in 'by' argument", call)
    if q > INT_MAX:
        raise _seq_error("'by' argument is much too small", call)
    n = int(math.floor(q + BY_FUZZ))
    if as_int:
        a, s = int(a), int(s)
        with mem.reserve(n + 1, "integer"):
            return RVector("integer", [a + i * s for i in range(n + 1)])
    with mem.reserve(n + 1, "double"):
        if half:
            a2, s2 = a / 2, s / 2
            xs = [2 * (a2 + i * s2) for i in range(n + 1)]
        else:
            xs = [a + i * s for i in range(n + 1)]
        # (the last element never passes `to`: it is `to` itself)
        if (s > 0 and xs[-1] > b) or (s < 0 and xs[-1] < b):
            xs[-1] = b
        return RVector("double", xs)


def _one(rtype, a):
    with mem.reserve(1, rtype):
        return RVector(rtype, [int(a) if rtype == "integer" else a])


def _seq_length(from_, to, by, lo, n, call):
    """seq with n elements (length.out or along.with); lo is length.out's value, None for along.with."""
    mc = _method_call(call, "seq.default")
    if n == 0:
        return _ints(1, 0)
    has_from, has_to, has_by = from_ is not None, to is not None, by is not None
    if not (has_from or has_to or has_by):
        return _ints(1, n)
    lo_int = lo is None or _int_like(lo)
    if has_from and has_to:
        a, b = _scalar(from_, "from", mc), _scalar(to, "to", mc)
        if a == b:
            # (equal ends: n copies, of the higher of the ends' types; seq(TRUE, TRUE, length.out = 2) is logical)
            rtype = max(from_.type, to.type, key=ORDER.index)
            e = bool(a) if rtype == "logical" else int(a) if rtype == "integer" else a
            with mem.reserve(n, rtype):
                return RVector(rtype, [e] * n)
        half = math.isinf(b - a)
        step = 0.0 if n == 1 else (b / 2 - a / 2) / (n - 1) if half else (b - a) / (n - 1)
        as_int = _int_like(from_) and _int_like(to) and lo_int and (half is False and step == int(step))
        if as_int:
            ia, istep = int(a), int(step)
            with mem.reserve(n, "integer"):
                return RVector("integer", [ia + i * istep if i < n - 1 else int(b) for i in range(n)] if n > 1 else [ia])
        with mem.reserve(n, "double"):
            if half:
                xs = [2 * (a / 2 + i * step) for i in range(n)]
            else:
                xs = [a + i * step for i in range(n)]
            if n > 1:
                xs[-1] = b
            return RVector("double", xs)
    s = 1.0 if not has_by else _scalar(by, "by", mc)
    # (with by given, its type and the end's decide; without it, length.out's too)
    step_int = _int_like(by) if has_by else lo_int
    if has_to and not has_from:
        b = _scalar(to, "to", mc)
        first = b - (n - 1) * s
        if _int_like(to) and step_int and -INT_MAX <= first <= INT_MAX:
            ib, istep = int(b), int(s)
            with mem.reserve(n, "integer"):
                return RVector("integer", [ib - (n - 1 - i) * istep for i in range(n)])
        with mem.reserve(n, "double"):
            return RVector("double", [b - (n - 1 - i) * s for i in range(n)])
    a = 1.0 if not has_from else _scalar(from_, "from", mc)
    last = a + (n - 1) * s
    if has_from and _int_like(from_) and step_int and -INT_MAX <= last <= INT_MAX:
        ia, istep = int(a), int(s)
        with mem.reserve(n, "integer"):
            return RVector("integer", [ia + i * istep for i in range(n)])
    with mem.reserve(n, "double"):
        return RVector("double", [a + i * s for i in range(n)])


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

def _number(e):
    """A count's element as a number, None for NA or NaN."""
    if e is None or e != e:
        return None
    return e


def _counts_ok(v, what, call):
    """rep's times: non-negative counts (2.9 is 2), R's "invalid 'times' argument" otherwise; checked without
    copying them."""
    if not isinstance(v, RVector) or v.type not in ORDER or not v.data:
        if isinstance(v, RVector) and v.type == "character":
            raise NotSupported("rep() with character counts")
        raise RError("invalid '%s' argument" % what, call)
    for e in v.data:
        e = _number(e)
        if e is None or math.isinf(e) or e < 0:
            raise RError("invalid '%s' argument" % what, call)


def _first_count(sess, v, what, call):
    """each or length.out: the first element, truncated (None for NA or none), R's warning for more or none;
    a negative one is R's "invalid '<what>' argument"."""
    if not isinstance(v, RVector) or v.type not in ORDER:
        raise NotSupported("rep() with this %s" % what)
    if len(v.data) != 1:
        sess.warn("first element used of '%s' argument" % what, call)
    if not v.data:
        return None
    e = _number(v.data[0])
    if e is None:
        return None
    if math.isinf(e):
        raise NotSupported("rep() with an infinite %s" % what)
    if e < 0:
        raise RError("invalid '%s' argument" % what, call)
    return int(e)


def _names(v):
    return v.attrs.get("names") if v.attrs else None


def rep(sess, call, args):
    for name, _ in args:
        if name not in ("x", "times", "each", "length.out"):
            raise NotSupported("rep() with other arguments")
    x = _arg(args, "x")
    if x is None:
        raise NotSupported("rep() without x")
    times, each, lo = _arg(args, "times"), _arg(args, "each"), _arg(args, "length.out")
    out_len = None
    if lo is not None:
        out_len = _first_count(sess, lo, "length.out", call)
    if x is NULL:
        if out_len:
            sess.warn("'x' is NULL so the result will be NULL", call)
        return NULL
    if not isinstance(x, RVector):
        raise NotSupported("rep() of this kind of value")
    k = 1
    if each is not None:
        c = _first_count(sess, each, "each", call)
        k = 1 if c is None else c
    m = len(x.data) * k
    # (each first, then length.out or times: the result's length from the counts, before anything is built)
    per = None
    if out_len is not None:
        n = out_len
    elif times is not None:
        _counts_ok(times, "times", call)
        if len(times.data) == 1:
            n = int(times.data[0]) * m
        elif len(times.data) == m:
            per = times.data
            n = sum(int(t) for t in per)
        else:
            raise RError("invalid 'times' argument", call)
    else:
        n = m
    nm = _names(x)
    extra = [(n, "character")] if nm is not None else []
    def positions():
        # (each result element's position in x, computed as it is read: no index list)
        if per is not None:
            for p, t in enumerate(per):
                for _ in range(int(t)):
                    yield p // k
        else:
            for j in range(n):
                yield (j % m) // k
    with mem.reserve(n, x.type, *extra):
        if not m and n:
            # (a zero-length x to a positive length: NA, as x[1] is; names "")
            out = RVector(x.type, [None] * n)
            if nm is not None:
                out.attrs = {"names": RVector("character", [""] * n)}
            return out
        out = RVector(x.type, [x.data[i] for i in positions()])
        if nm is not None:
            out.attrs = {"names": RVector("character", [nm.data[i] for i in positions()])}
        return out


def rep_len(sess, call, args):
    x, lo = _arg(args, "x"), _arg(args, "length.out")
    n = None
    if isinstance(lo, RVector) and len(lo.data) == 1 and lo.type in ORDER:
        e = _number(lo.data[0])
        if e is not None and not math.isinf(e) and e >= 0:
            n = int(e)
    elif isinstance(lo, RVector) and lo.type == "character":
        raise NotSupported("rep_len() with a character length.out")
    if n is None:
        raise RError("invalid 'length.out' value", call)
    if x is NULL:
        if n:
            raise RError("cannot replicate NULL to a non-zero length", call)
        return NULL
    if not isinstance(x, RVector):
        raise NotSupported("rep_len() of this kind of value")
    m = len(x.data)
    # (no names: rep_len drops them, R 4.5.3; a zero-length x gives NA)
    with mem.reserve(n, x.type):
        return RVector(x.type, [x.data[i % m] for i in range(n)] if m else [None] * n)


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
