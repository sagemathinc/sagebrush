"""A1.2's builtins on atomic vectors (design/rill.md §4): length and names,
the read-only `[`, `$`'s error, the constructors, the as.* coercions, the is.*
tests and options().  What each prints, warns and refuses is R 4.5.3's
(rill-tests/access/, rill-tests/args/, rill-tests/print/); each result's
whole peak is reserved before it is built (§8.5).  Atomic vectors only:
lists, attributes but names, classes and raw are later PRs' (A1.6), refused.

Each is called as f(session, call, args), args being (formal or name, value)
after R's matching (args.py; base.FORMALS holds their signatures).
"""

import math
import re

from . import mem
from .eval import NotSupported, RError
from .values import MISSING, NULL, RVector

INT_MAX = 2147483647
TYPES = ("logical", "integer", "double", "complex", "character")


def _atomic(v, what):
    if v is NULL or isinstance(v, RVector):
        return v
    raise NotSupported("%s of this kind of value" % what)


def _arg(args, formal, default=MISSING):
    for name, v in args:
        if name == formal:
            return v
    return default


def _names(v):
    return v.attrs.get("names") if isinstance(v, RVector) and v.attrs else None


def _with_names(t, data, names):
    return RVector(t, data, {"names": names} if names is not None else None)


# ---------------------------------------------------------------- length and names

def length_(sess, call, args):
    v = _atomic(args[0][1], "length()")
    return RVector("integer", [0 if v is NULL else len(v.data)])


def names_(sess, call, args):
    v = _atomic(args[0][1], "names()")
    nm = _names(v)
    if nm is None:
        return NULL
    with mem.reserve(len(nm.data), "character"):
        return RVector("character", list(nm.data))


# ---------------------------------------------------------------- [ and $

def index(sess, call, args):
    """x[i], read-only (`[<-` is A1.5's)."""
    if len(args) > 2:
        raise RError("incorrect number of dimensions", call)
    x = _atomic(args[0][1], "`[`")
    if x is NULL:
        return NULL
    i = args[1][1] if len(args) > 1 else MISSING
    if i is MISSING:
        return x
    n = len(x.data)
    names = _names(x)
    # (the whole peak, before any position is computed: no index takes more than max(n, length(i)) positions,
    # and the result and its names are as long; §8.5, astra's subset masks)
    bound = max(n, len(i.data)) if isinstance(i, RVector) else 0
    extra = [(bound, "character")] if names is not None else []
    with mem.reserve(bound, x.type, (bound, "integer"), *extra):
        picks = _positions(i, x, call)
        data = [x.data[p] if p is not None and p < n else None for p in picks]
        if names is not None:
            nm = [names.data[p] if p is not None and p < n else None for p in picks]
            return _with_names(x.type, data, RVector("character", nm))
        return RVector(x.type, data)


def _positions(i, x, call):
    """The 0-based positions x[i] takes (None: NA), by R's rules for logical, numeric and character indices."""
    n = len(x.data)
    if i is NULL:
        return []
    if not isinstance(i, RVector):
        raise NotSupported("this kind of index")
    if i.type == "logical":
        m = max(n, len(i.data))
        if not i.data:
            return []
        out = []
        for k in range(m):
            f = i.data[k % len(i.data)]
            if f is None:
                out.append(None)
            elif f:
                out.append(k)
        return out
    if i.type in ("integer", "double"):
        pos, neg, has_na = [], set(), False
        for e in i.data:
            if e is None or (isinstance(e, float) and e != e):
                has_na = True
                pos.append(None)
                continue
            k = int(e)  # (toward zero: 2.9 is 2)
            if k > 0:
                pos.append(k - 1)
            elif k < 0:
                neg.add(-k - 1)
        if neg and (any(p is not None for p in pos) or has_na):
            raise RError("only 0's may be mixed with negative subscripts", call)
        if neg:
            return [k for k in range(n) if k not in neg]
        return pos
    if i.type == "character":
        names = _names(x)
        where = {}
        if names is not None:
            for k, nm in enumerate(names.data):
                if nm is not None and nm not in where:
                    where[nm] = k
        return [where.get(s) if s is not None else None for s in i.data]
    raise NotSupported("a %s index" % i.type)


def dollar(sess, call, args):
    x = args[0][1]
    if x is NULL:
        return NULL
    if isinstance(x, RVector):
        raise RError("$ operator is invalid for atomic vectors", call)
    raise NotSupported("$ on this kind of value")


# ---------------------------------------------------------------- constructors

def _length_arg(v, call):
    """A constructor's length: one number (a string is read as one), at least 0 (R 4.5.3)."""
    if isinstance(v, RVector) and len(v.data) == 1 and v.type in ("integer", "double", "character"):
        e = v.data[0]
        if v.type == "character":
            e = _parse_number(e)
        if e is not None and e == e and not math.isinf(e) and e >= 0:
            return int(e)
    raise RError("invalid 'length' argument", call)


ZERO = {"logical": False, "integer": 0, "double": 0.0, "complex": complex(0.0, 0.0), "character": ""}


def _constructor(rtype):
    def make(sess, call, args):
        v = _arg(args, "length", None)
        n = 0 if v is None else _length_arg(v, call)
        with mem.reserve(n, rtype):
            return RVector(rtype, [ZERO[rtype]] * n)
    return make


def complex_(sess, call, args):
    out_len = _arg(args, "length.out", None)
    n0 = 0 if out_len is None else _length_arg(out_len, call)
    polar = _arg(args, "modulus", None) is not None or _arg(args, "argument", None) is not None
    pairs = (("modulus", 1.0), ("argument", 0.0)) if polar else (("real", 0.0), ("imaginary", 0.0))
    given = [_arg(args, formal, None) for formal, _ in pairs]
    for v in given:
        if v is not None and (not isinstance(v, RVector) or v.type in ("character", "complex")):
            raise NotSupported("complex() with character or complex parts")
    n = max([n0] + [len(v.data) for v in given if v is not None])
    # (the result and both parts as doubles: the whole peak, before either part is converted: §8.5)
    with mem.reserve(n, "complex", (n, "double"), (n, "double")):
        parts = [[default] if v is None or not v.data else _doubles(v) for v, (_, default) in zip(given, pairs)]
        out = []
        for k in range(n):
            a, b = parts[0][k % len(parts[0])], parts[1][k % len(parts[1])]
            if a is None or b is None:
                out.append(None)
            elif polar:
                out.append(complex(a * math.cos(b), a * math.sin(b)))
            else:
                out.append(complex(a, b))
        return RVector("complex", out)


def _doubles(v):
    return [None if e is None else float(e) for e in v.data]


# ---------------------------------------------------------------- coercions

# (R's number syntax for as.numeric: decimal or hex, with exponent; Inf, NaN; spaces around. The string "NA"
# isn't one: as.numeric("NA") warns, R 4.5.3)
_NUMBER = re.compile(r"^\s*[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+|Inf|inf|NaN)\s*$")


def _parse_number(s):
    """A string as R reads a number (None: NA; a float otherwise), or False where it isn't one."""
    if s is None:
        return None
    if not _NUMBER.match(s):
        return False
    t = s.strip().lstrip("+")
    neg = t.startswith("-")
    body = t[1:] if neg else t
    if body in ("Inf", "inf"):
        x = math.inf
    elif body == "NaN":
        x = math.nan
    elif body[:2] in ("0x", "0X"):
        x = float(int(body, 16))
    else:
        x = float(body)
    return -x if neg else x


def _to(v, to, call, sess):
    """v's elements as type `to`, with R's warnings (NAs introduced by coercion [to integer range])."""
    frm = v.type
    bad = [False, False]
    out = []
    for e in v.data:
        out.append(_elt(e, frm, to, bad))
    if bad[0]:
        sess.warn("NAs introduced by coercion")
    if bad[1]:
        sess.warn("NAs introduced by coercion to integer range")
    return out


def _elt(e, frm, to, bad):
    from .base import coerce_elt
    if e is None:
        return None
    if frm == "character" and to in ("integer", "double", "complex"):
        x = _parse_number(e)
        if x is False and to == "complex" and "i" in e:
            # (R reads complex syntax such as "1+2i" here; a string without an i that isn't a number is NA, recorded)
            raise NotSupported("coercing this string to complex")
        if x is False:
            bad[0] = True
            return None
        if x is None:
            return None
        e, frm = x, "double"
    if frm == "complex" and to in ("integer", "double", "logical"):
        raise NotSupported("coercing complex to %s" % to)
    if to == "integer":
        if frm == "double":
            if e != e:
                return None
            if math.isinf(e) or abs(e) >= INT_MAX + 1:
                bad[1] = True
                return None
            return int(e)
        return int(e)
    if to == "logical":
        if frm == "character":
            return {"TRUE": True, "true": True, "T": True, "True": True,
                    "FALSE": False, "false": False, "F": False, "False": False}.get(e)
        if frm == "double" and e != e:
            return None
        return bool(e)
    return coerce_elt(e, frm, to)


def _coercion(to):
    def conv(sess, call, args):
        if not args:
            return RVector(to, [])
        v = _atomic(args[0][1], "as.%s()" % to)
        if v is NULL:
            return RVector(to, [])
        with mem.reserve(len(v.data), to):
            data = list(v.data) if v.type == to else _to(v, to, call, sess)
            return RVector(to, data)
    return conv


# ---------------------------------------------------------------- tests

def _type_test(test):
    def f(sess, call, args):
        return RVector("logical", [test(args[0][1])])
    return f


def _is_type(*types):
    return _type_test(lambda v: isinstance(v, RVector) and v.type in types)


def _elementwise(test):
    """is.na and kin: one logical per element, names kept (R 4.5.3)."""
    def f(sess, call, args):
        v = _atomic(args[0][1], "this is.*() test")
        if v is NULL:
            return RVector("logical", [])
        with mem.reserve(len(v.data), "logical"):
            return RVector("logical", [test(e, v.type) for e in v.data], {"names": _names(v)} if _names(v) else None)
    return f


def _na(e, t):
    return e is None or (t == "double" and e != e) or (t == "complex" and (e.real != e.real or e.imag != e.imag))


def _nan(e, t):
    return e is not None and ((t == "double" and e != e) or (t == "complex" and (e.real != e.real or e.imag != e.imag)))


def _finite(e, t):
    if e is None or t == "character":
        return False
    if t == "complex":
        return math.isfinite(e.real) and math.isfinite(e.imag)
    return t in ("logical", "integer") or math.isfinite(e)


def _infinite(e, t):
    if e is None or t not in ("double", "complex"):
        return False
    if t == "complex":
        return math.isinf(e.real) or math.isinf(e.imag)
    return math.isinf(e)


def is_vector(sess, call, args):
    x = _arg(args, "x")
    if x is MISSING:
        raise RError('argument "x" is missing, with no default', call)
    mode = _arg(args, "mode", None)
    m = "any" if mode is None else (mode.data[0] if isinstance(mode, RVector) and mode.type == "character" and len(mode.data) == 1 else None)
    if m is None:
        raise RError("invalid 'mode' argument", call)
    if not isinstance(x, RVector) or (x.attrs and set(x.attrs) != {"names"}):
        return RVector("logical", [False])
    want = {"any": TYPES, "numeric": ("integer", "double"), "double": ("double",), "integer": ("integer",),
            "logical": ("logical",), "character": ("character",), "complex": ("complex",)}.get(m, ())
    return RVector("logical", [x.type in want])


# ---------------------------------------------------------------- options

def options(sess, call, args):
    """options(name = value, ...): sets digits and scipen, as R checks them; returns the old values invisibly
    (printing that list is A1.6's)."""
    if not args:
        raise NotSupported("listing every option with options()")
    from .base import _digits_option
    for name, v in args:
        if name is None:
            raise NotSupported("options() with an unnamed argument")
        if name == "digits":
            sess.options["digits"] = _digits_option(v, call)
        elif name == "scipen":
            if not (isinstance(v, RVector) and len(v.data) == 1 and v.type in ("logical", "integer", "double")
                    and v.data[0] is not None and v.data[0] == v.data[0]):
                raise RError("invalid 'scipen'", call)
            sess.options["scipen"] = int(v.data[0])
        else:
            raise NotSupported("options(%s =)" % name)
    sess.visible = False
    return OLD_OPTIONS


class _OldOptions:
    """options()'s result: a list, which Rill doesn't print until A1.6."""
    __slots__ = ()


OLD_OPTIONS = _OldOptions()


def refuse_raw(sess, call, args):
    # gate: raw vectors refused (deferred: design §4, A1.2's scope note)
    raise NotSupported("raw vectors")


# ---------------------------------------------------------------- the functions base.py registers, by name

logical_ = _constructor("logical")
integer_ = _constructor("integer")
double_ = _constructor("double")
character_ = _constructor("character")
as_logical = _coercion("logical")
as_integer = _coercion("integer")
as_double = _coercion("double")
as_character = _coercion("character")
as_complex = _coercion("complex")
is_numeric = _is_type("integer", "double")
is_character = _is_type("character")
is_logical = _is_type("logical")
is_integer = _is_type("integer")
is_double = _is_type("double")
is_complex = _is_type("complex")
is_null = _type_test(lambda v: v is NULL)
is_na = _elementwise(_na)
is_nan = _elementwise(_nan)
is_finite = _elementwise(_finite)
is_infinite = _elementwise(_infinite)
