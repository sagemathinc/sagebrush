"""A3's factors (design/rill.md §4): factor, ordered, levels, nlevels, is.factor, is.ordered, droplevels,
as.vector and cut, and what a factor means to `[`, the as.* coercions and the is.* tests (access.py) and to
print (base.py).  What each returns, prints and refuses is R 4.5.3's (rill-tests/fac/); each result's whole peak
is reserved before it is built (§8.5).

A factor is an integer vector of codes (1 is the first level, NA a missing value) with two attributes: "levels",
a character vector, and "class", "factor" (or "ordered", "factor"); its names, when it has them, come first.
Levels are ordered as R orders them: numbers by value, strings by R's collation (collate.py).

Each builtin is called as f(session, call, args), args being (formal or name, value) after R's matching.
"""

import math

from . import collate, mem
from .eval import NotSupported, RError
from .values import MISSING, NULL, RVector


def is_factor(v):
    return isinstance(v, RVector) and bool(v.attrs) and "factor" in _class(v)


def _class(v):
    c = v.attrs.get("class") if isinstance(v, RVector) and v.attrs else None
    return c.data if c is not None else []


def levels_of(f):
    return f.attrs["levels"].data


def labels_of(f):
    """A factor's values as strings (None where NA): each code's level."""
    lev = levels_of(f)
    return [None if c is None else lev[c - 1] for c in f.data]


def make(codes, levels, ordered=False, names=None):
    attrs = {}
    if names is not None:
        attrs["names"] = names
    attrs["levels"] = RVector("character", levels)
    attrs["class"] = RVector("character", ["ordered", "factor"] if ordered else ["factor"])
    return RVector("integer", codes, attrs)


def _arg(args, formal, default=MISSING):
    for name, v in args:
        if name == formal:
            return v
    return default


def _flag(v, what):
    if isinstance(v, RVector) and v.type == "logical" and len(v.data) == 1 and v.data[0] is not None and not v.attrs:
        return v.data[0]
    raise NotSupported("%s other than TRUE or FALSE" % what)


def _strings(v, what):
    """An atomic vector's elements as R's as.character makes them (None: NA)."""
    from .base import coerce_elt
    if is_factor(v):
        return labels_of(v)
    if not isinstance(v, RVector) or v.type == "complex" or (v.attrs and set(v.attrs) != {"names"}):
        raise NotSupported("%s of this kind of value" % what)
    return [coerce_elt(e, v.type, "character") for e in v.data]


def _sorted_unique(x):
    """x's distinct non-NA values in R's order (numbers by value, strings by R's collation), as level strings."""
    from .base import coerce_elt
    seen = set()
    vals = []
    nan = False
    for e in x.data:
        if e is None:
            continue
        if x.type == "double" and e != e:
            # (NaN isn't NA: it is a level of its own, after every number, R 4.5.3)
            nan = True
            continue
        if e in seen:
            continue
        seen.add(e)
        vals.append(e)
    if x.type == "character":
        vals.sort(key=collate.key)
    else:
        vals.sort()
    return [coerce_elt(e, x.type, "character") for e in vals] + (["NaN"] if nan else [])


# ---------------------------------------------------------------- factor and ordered

def factor(sess, call, args, force_ordered=False):
    """factor(x = character(), levels, labels = levels, exclude = NA, ordered = is.ordered(x)); ordered() is
    factor() with ordered TRUE, whatever x is (R 4.5.3: ordered(factor("x")) is ordered)."""
    x = _arg(args, "x")
    if x is MISSING or x is NULL:
        x = RVector("character", [])
    if not isinstance(x, RVector) or x.type == "complex":
        raise NotSupported("factor() of this kind of value")
    was_factor = is_factor(x)
    if x.attrs and not was_factor and set(x.attrs) != {"names"}:
        raise NotSupported("factor() of a vector with attributes other than names")
    n = len(x.data)
    names = x.attrs.get("names") if x.attrs else None
    o = _arg(args, "ordered")
    if force_ordered:
        ordered = True
    else:
        ordered = "ordered" in _class(x) if o is MISSING else _flag(o, "ordered =")
    if _arg(args, "nmax") is not MISSING:
        raise NotSupported("factor(nmax =)")
    with mem.reserve(n, "integer", (n, "character"), (n, "character")):
        values = _strings(x, "factor()")
        lv = _arg(args, "levels")
        if lv is MISSING:
            if was_factor:
                used = {c for c in x.data if c is not None}
                levels = [l for k, l in enumerate(levels_of(x)) if k + 1 in used]
            else:
                levels = _sorted_unique(x)
        else:
            levels = _strings(lv, "factor(levels =)")
            if any(l is None for l in levels):
                raise NotSupported("factor() with NA among the levels")
        ex = _arg(args, "exclude")
        if ex is not MISSING and not (isinstance(ex, RVector) and ex.type == "logical" and ex.data == [None]):
            drop = set(s for s in _strings(ex, "factor(exclude =)") if s is not None)
            levels = [l for l in levels if l not in drop]
        if len(set(levels)) != len(levels):
            raise NotSupported("factor() with duplicated levels")
        where = {l: k + 1 for k, l in enumerate(levels)}
        codes = [None if s is None else where.get(s) for s in values]
        lab = _arg(args, "labels")
        if lab is not MISSING:
            labels = _strings(lab, "factor(labels =)")
            k = len(levels)
            if len(labels) == k:
                if len(set(labels)) != k or any(l is None for l in labels):
                    raise NotSupported("factor() with duplicated or NA labels")
                levels = labels
            elif len(labels) == 1:
                # (one prefix, pasted to each level's position: an NA prefix is "NA", R 4.5.3)
                prefix = "NA" if labels[0] is None else labels[0]
                levels = ["%s%d" % (prefix, i + 1) for i in range(k)]
            else:
                raise RError("invalid 'labels'; length %d should be 1 or %d" % (len(labels), k), call)
        return make(codes, levels, ordered, RVector("character", list(names.data)) if names is not None else None)


def ordered(sess, call, args):
    return factor(sess, call, args, force_ordered=True)


# ---------------------------------------------------------------- levels, nlevels, is.factor, is.ordered

def levels(sess, call, args):
    x = args[0][1]
    lev = x.attrs.get("levels") if isinstance(x, RVector) and x.attrs else None
    if lev is None:
        return NULL
    return RVector("character", list(lev.data))


def nlevels(sess, call, args):
    x = args[0][1]
    lev = x.attrs.get("levels") if isinstance(x, RVector) and x.attrs else None
    return RVector("integer", [0 if lev is None else len(lev.data)])


def is_factor_(sess, call, args):
    return RVector("logical", [is_factor(args[0][1])])


def is_ordered(sess, call, args):
    return RVector("logical", ["ordered" in _class(args[0][1])])


def droplevels(sess, call, args):
    """droplevels(x): a factor without the levels no element has, the rest in their order."""
    x = _arg(args, "x")
    if not is_factor(x):
        raise NotSupported("droplevels() of this kind of value")
    if len(args) > 1:
        raise NotSupported("droplevels() with more arguments")
    n = len(x.data)
    with mem.reserve(n, "integer", (len(levels_of(x)), "character")):
        used = sorted({c for c in x.data if c is not None})
        new = {c: k + 1 for k, c in enumerate(used)}
        lev = levels_of(x)
        names = x.attrs.get("names")
        return make([None if c is None else new[c] for c in x.data], [lev[c - 1] for c in used], "ordered" in _class(x),
                    names)


# ---------------------------------------------------------------- as.vector

def as_vector(sess, call, args):
    """as.vector(x) (mode "any"): a factor's labels as strings; an atomic vector without its attributes."""
    x = _arg(args, "x")
    mode = _arg(args, "mode")
    if mode is not MISSING and not (isinstance(mode, RVector) and mode.type == "character" and mode.data == ["any"]):
        raise NotSupported("as.vector() with a mode other than \"any\"")
    if x is NULL:
        return NULL
    if not isinstance(x, RVector):
        raise NotSupported("as.vector() of this kind of value")
    n = len(x.data)
    if is_factor(x):
        with mem.reserve(n, "character"):
            return RVector("character", labels_of(x))
    if x.attrs and set(x.attrs) != {"names"}:
        raise NotSupported("as.vector() of a vector with these attributes")
    with mem.reserve(n, x.type):
        return RVector(x.type, list(x.data))


# ---------------------------------------------------------------- cut

# the most significant digits cut's labels are written with (R reduces dig.lab past this, with a warning), and the
# most intervals a number of breaks may ask for (R's integer range less one: its breaks are one more)
MAX_DIG = 50
MAX_INTERVALS = 2 ** 31 - 2


def cut(sess, call, args):
    """cut(x, breaks, labels = NULL, include.lowest = FALSE, right = TRUE, dig.lab = 3, ordered_result = FALSE):
    each number's interval among the breaks, as a factor of labels "(a,b]" (or "[a,b)" with right = FALSE).  A
    single number of breaks divides the range into that many equal intervals, its outer limits moved out by 0.1%
    of the range (?cut)."""
    x = _arg(args, "x")
    if isinstance(x, RVector) and x.type == "logical":
        # (R stops: 'x' must be numeric, its message naming the S3 method cut.default, A1.3)
        raise NotSupported("cut() of a logical vector")
    if not (isinstance(x, RVector) and x.type in ("integer", "double")) or (x.attrs and set(x.attrs) != {"names"}):
        raise NotSupported("cut() of this kind of value")
    br = _arg(args, "breaks")
    if not (isinstance(br, RVector) and br.type in ("integer", "double") and br.data):
        raise NotSupported("cut() with these breaks")
    right = True if _arg(args, "right") is MISSING else _flag(_arg(args, "right"), "cut(right =)")
    lowest = False if _arg(args, "include.lowest") is MISSING else _flag(_arg(args, "include.lowest"), "cut(include.lowest =)")
    ordered = False if _arg(args, "ordered_result") is MISSING else _flag(_arg(args, "ordered_result"), "cut(ordered_result =)")
    dl = _arg(args, "dig.lab")
    dig = 3
    if dl is not MISSING:
        if not (isinstance(dl, RVector) and dl.type in ("integer", "double") and len(dl.data) == 1 and dl.data[0] is not None):
            raise NotSupported("cut(dig.lab =) other than a number")
        d = dl.data[0]
        # (R: NA, NaN and Inf are errors; a fraction steps from itself, 2.5 to 11.5, to labels Rill doesn't model;
        # past 50 digits R warns and uses 50)
        if not math.isfinite(d) or d != int(d):
            raise NotSupported("cut(dig.lab =) other than a whole number")
        if d > MAX_DIG:
            raise NotSupported("cut(dig.lab =) past %d" % MAX_DIG)
        dig = int(d)
    n = len(x.data)
    if len(br.data) == 1:
        nb = br.data[0]
        # (R: fewer than 2, NA or -Inf is "invalid number of intervals" from the S3 method; Inf, or more than an
        # integer holds, an error from seq.int; a fraction is truncated; all refused, A1.3)
        if nb is None or not math.isfinite(nb) or nb != int(nb) or not 2 <= nb <= MAX_INTERVALS:
            raise NotSupported("cut() with this number of breaks")
        k = int(nb)
    else:
        k = len(br.data) - 1
    # (the whole peak, before any of it is built: the numbers as doubles, the breaks, the codes and the labels)
    with mem.reserve(n, "integer", (n, "double"), (k + 1, "double"), (k, "character")):
        xs = [None if e is None or (x.type == "double" and e != e) else float(e) for e in x.data]
        if len(br.data) == 1:
            lo = hi = None
            for e in xs:
                if e is None:
                    continue
                if math.isinf(e):
                    # (R stops: the range's end isn't finite, its message naming seq.int, A1.3)
                    raise NotSupported("cut() into intervals of a range with an infinite end")
                lo = e if lo is None or e < lo else lo
                hi = e if hi is None or e > hi else hi
            if lo is None:
                raise NotSupported("cut() of no finite values")
            dx = hi - lo
            if dx == 0:
                raise NotSupported("cut() of values that are all equal")
            step = dx / k
            breaks = [lo + j * step for j in range(k + 1)]
            breaks[0], breaks[-1] = lo - dx / 1000, hi + dx / 1000
        else:
            breaks = sorted(float(e) for e in br.data if e is not None)
            if len(breaks) != len(br.data) or any(math.isinf(b) or b != b for b in breaks):
                raise NotSupported("cut() with NA or infinite breaks")
            if len(set(breaks)) != len(breaks):
                raise RError("'breaks' are not unique", call)
        lab = _arg(args, "labels")
        if lab is MISSING or lab is NULL:
            levels = _interval_labels(breaks, dig, right, lowest)
        elif isinstance(lab, RVector) and lab.type == "logical" and lab.data == [False]:
            levels = None
        else:
            levels = _strings(lab, "cut(labels =)")
            if len(levels) != k or len(set(levels)) != k or any(l is None for l in levels):
                raise NotSupported("cut() with these labels")
        codes = []
        for e in xs:
            codes.append(None if e is None else _interval(e, breaks, right, lowest))
        if levels is None:
            return RVector("integer", codes)
        return make(codes, levels, ordered)


def _interval(e, breaks, right, lowest):
    """The 1-based interval holding e, or None (outside, or on an excluded end)."""
    k = len(breaks) - 1
    for i in range(k):
        a, b = breaks[i], breaks[i + 1]
        if right:
            if a < e <= b or (lowest and i == 0 and e == a):
                return i + 1
        else:
            if a <= e < b or (lowest and i == k - 1 and e == b):
                return i + 1
    return None


def _interval_labels(breaks, dig, right, lowest):
    """"(a,b]" labels, each break written with `dig` significant digits, more until neighbours differ (?cut's
    dig.lab), up to 12.  Where neighbours are still equal at 12, every interval is "Range_k" instead (R 4.5.3)."""
    k = len(breaks) - 1
    # (a negative dig.lab writes every break as formatC's default, 6 significant digits, so the negative steps are
    # one try; then 0 up to 12, R 4.5.3)
    for d in ([6] if dig < 0 else []) + list(range(max(dig, 0), max(12, dig) + 1)):
        s = [_g(b, d) for b in breaks]
        if all(s[i] != s[i + 1] for i in range(k)):
            break
    else:
        return ["Range_%d" % (i + 1) for i in range(k)]
    out = []
    for i in range(k):
        lo_b = "(" if right and not (lowest and i == 0) else "["
        hi_b = "]" if right or (lowest and i == k - 1) else ")"
        out.append("%s%s,%s%s" % (lo_b, s[i], s[i + 1], hi_b))
    return out


def _g(x, d):
    """x written with d significant digits, as C's %g does (formatC's default)."""
    s = "%.*g" % (d, x + 0.0)  # (0 + breaks, as R writes them: a negative zero is "0")
    if "e" in s:
        mant, ex = s.split("e")
        s = "%se%s%02d" % (mant, ex[0], abs(int(ex)))
    return s
