"""Rill's summaries (design/rill.md A3): sum, prod, min, max and mean, as R
4.5.3 gives them (rill-tests/vec/, rill-tests/na/).

What R prints, observed:

- sum and prod accumulate doubles in extended precision (R's help: "extended-
  precision accumulators"): here a 64-bit significand, rounded to nearest
  even after each step (_LD), then once to a double.  An integer sum is exact,
  and a double when it leaves the integer range.  Of NA and NaN, the first one
  met is the result.
- min and max: NA if any element is NA, else NaN if any is NaN; integer for
  logical and integer arguments, double with any double, character (compared
  as strings) with any string.  No elements: Inf or -Inf, with R's warning.
- mean: the exact mean, rounded once; NA if any element is NA, else NaN.  R's
  mean is a function that dispatches to mean.default, which its errors and
  warnings name (Calls: mean -> mean.default).
"""

import fractions
import math

from . import mem
from .eval import NotSupported, RError
from .values import NULL, RVector

INT_MAX = 2147483647
RANK = {"logical": 0, "integer": 1, "double": 2, "complex": 3, "character": 4}


# ---------------------------------------------------------------- extended precision

class _LD:
    """A finite extended-precision value num * 2**exp, |num| < 2**64 (rounded to nearest, ties to even)."""
    __slots__ = ("num", "exp")
    BITS = 64

    def __init__(self, num=0, exp=0):
        self.num, self.exp = _round(num, exp, self.BITS)

    @staticmethod
    def of(x):
        m, e = math.frexp(x)
        return _LD(int(m * (1 << 53)), e - 53)

    def add(self, o):
        if self.num == 0:
            return o
        if o.num == 0:
            return self
        e = min(self.exp, o.exp)
        return _LD((self.num << (self.exp - e)) + (o.num << (o.exp - e)), e)

    def mul(self, o):
        return _LD(self.num * o.num, self.exp + o.exp)

    def to_double(self):
        v = fractions.Fraction(self.num) * (fractions.Fraction(2) ** self.exp)
        try:
            return float(v)
        except OverflowError:
            return math.inf if v > 0 else -math.inf


def _round(num, exp, bits):
    if num == 0:
        return 0, 0
    sign = -1 if num < 0 else 1
    a = abs(num)
    shift = a.bit_length() - bits
    if shift <= 0:
        return num, exp
    q, r = divmod(a, 1 << shift)
    half = 1 << (shift - 1)
    if r > half or (r == half and q & 1):
        q += 1
        if q.bit_length() > bits:
            q >>= 1
            shift += 1
    return sign * q, exp + shift


# ---------------------------------------------------------------- arguments

def _na_rm(args, call):
    for name, v in args:
        if name == "na.rm":
            if isinstance(v, RVector) and v.type == "logical" and len(v.data) == 1 and v.data[0] is not None:
                return v.data[0]
            raise NotSupported("na.rm = other than TRUE or FALSE")
    return False


def _values(args, what):
    """The `...` arguments' vectors (NULL skipped), refusing what isn't an atomic vector."""
    out = []
    for name, v in args:
        if name == "na.rm":
            continue
        if v is NULL:
            continue
        if not isinstance(v, RVector):
            raise NotSupported("%s() of this kind of value" % what)
        out.append(v)
    return out


def _is_na(e):
    return e is None or (isinstance(e, float) and e != e)


# ---------------------------------------------------------------- sum and prod

def _top(vs):
    return max((v.type for v in vs), key=RANK.get, default="integer")


def sum_(sess, call, args):
    na_rm = _na_rm(args, call)
    vs = _values(args, "sum")
    t = _top(vs)
    if t == "character":
        raise RError("invalid 'type' (character) of argument", call)
    if t in ("logical", "integer"):
        s = 0
        for v in vs:
            for e in v.data:
                if e is None:
                    if na_rm:
                        continue
                    return RVector("integer", [None])
                s += int(e)
        return RVector("integer", [s]) if -INT_MAX <= s <= INT_MAX else RVector("double", [float(s)])
    if t == "complex":
        re, im = [], []
        for v in vs:
            for e in v.data:
                if e is None:
                    if na_rm:
                        continue
                    return RVector("complex", [None])
                z = complex(e)
                re.append(z.real)
                im.append(z.imag)
        return RVector("complex", [complex(_ld_sum(re), _ld_sum(im))])
    xs = []
    for v in vs:
        for e in v.data:
            if _is_na(e):
                if na_rm:
                    continue
                # (of NA and NaN, the first one met)
                return RVector("double", [None if e is None else math.nan])
            xs.append(float(e))
    return RVector("double", [_ld_sum(xs)])


def _ld_sum(xs):
    pos = any(x == math.inf for x in xs)
    neg = any(x == -math.inf for x in xs)
    if any(x != x for x in xs) or (pos and neg):
        return math.nan
    if pos or neg:
        return math.inf if pos else -math.inf
    s = _LD()
    for x in xs:
        s = s.add(_LD.of(x))
    return s.to_double()


def prod(sess, call, args):
    na_rm = _na_rm(args, call)
    vs = _values(args, "prod")
    t = _top(vs)
    if t == "character":
        raise RError("invalid 'type' (character) of argument", call)
    if t == "complex":
        raise NotSupported("prod() of complex numbers")
    xs = []
    for v in vs:
        for e in v.data:
            if _is_na(e):
                if na_rm:
                    continue
                return RVector("double", [None if e is None else math.nan])
            xs.append(float(e))
    if any(math.isinf(x) for x in xs):
        if any(x == 0 for x in xs):
            return RVector("double", [math.nan])
        sign = -1 if sum(1 for x in xs if x < 0) % 2 else 1
        return RVector("double", [sign * math.inf])
    if any(x == 0 for x in xs):
        # (a zero: zero, signed by the parity of the factors' signs)
        neg = sum(1 for x in xs if math.copysign(1.0, x) < 0) % 2
        return RVector("double", [-0.0 if neg else 0.0])
    p = _LD(1, 0)
    for x in xs:
        p = p.mul(_LD.of(x))
    return RVector("double", [p.to_double()])


# ---------------------------------------------------------------- min and max

def _extreme(sess, call, args, which):
    na_rm = _na_rm(args, call)
    vs = _values(args, which)
    t = _top(vs)
    if t == "complex":
        raise RError("invalid 'type' (complex) of argument", call)
    if t == "character":
        from .base import _collate_key, num_to_str
        items = []
        for v in vs:
            for e in v.data:
                if _is_na(e):
                    if na_rm:
                        continue
                    return RVector("character", [None])
                items.append(e if v.type == "character" else num_to_str(e) if v.type != "logical" else ("TRUE" if e else "FALSE"))
        if not items:
            raise NotSupported("%s() of no strings" % which)
        f = min if which == "min" else max
        return RVector("character", [f(items, key=_collate_key)])
    xs, na, nan = [], False, False
    for v in vs:
        for e in v.data:
            if e is None:
                na = True
            elif isinstance(e, float) and e != e:
                nan = True
            else:
                xs.append(e)
    rtype = "double" if t == "double" else "integer"
    if not na_rm and na:
        return RVector(rtype, [None])
    if not na_rm and nan:
        return RVector("double", [math.nan])
    if not xs:
        inf = math.inf if which == "min" else -math.inf
        sess.warn("no non-missing arguments to %s; returning %s" % (which, "Inf" if inf > 0 else "-Inf"), call)
        return RVector("double", [inf])
    r = min(xs) if which == "min" else max(xs)
    return RVector(rtype, [float(r) if rtype == "double" else int(r)])


def min_(sess, call, args):
    return _extreme(sess, call, args, "min")


def max_(sess, call, args):
    return _extreme(sess, call, args, "max")


# ---------------------------------------------------------------- mean

def _method_call(call):
    from .values import Lang, sym
    return Lang(sym("mean.default"), call.args)


def mean(sess, call, args):
    x = None
    trim, na_rm = 0.0, False
    for name, v in args:
        if name == "x":
            x = v
        elif name == "trim":
            if not (isinstance(v, RVector) and v.type in ("integer", "double") and len(v.data) == 1 and v.data[0] is not None):
                raise NotSupported("mean(trim =) other than one number")
            trim = float(v.data[0])
        elif name == "na.rm":
            na_rm = _na_rm([(name, v)], call)
        else:
            raise NotSupported("mean() with other arguments")
    if not isinstance(x, RVector) or x.type == "character":
        if x is NULL or isinstance(x, RVector):
            sess.warn("argument is not numeric or logical: returning NA", _method_call(call))
            return RVector("double", [None])
        raise NotSupported("mean() of this kind of value")
    if trim < 0:
        raise NotSupported("mean() with a negative trim")
    data = x.data
    if na_rm:
        data = [e for e in data if not _is_na(e)]
    if x.type == "complex":
        if any(e is None for e in data):
            return RVector("complex", [None])
        if trim:
            raise NotSupported("a trimmed mean of complex numbers")
        if not data:
            return RVector("complex", [complex(math.nan, 0)])
        re = _exact_mean([complex(e).real for e in data])
        im = _exact_mean([complex(e).imag for e in data])
        return RVector("complex", [complex(re, im)])
    if any(e is None for e in data):
        return RVector("double", [None])
    xs = [float(e) for e in data]
    if any(e != e for e in xs):
        return RVector("double", [math.nan])
    if trim and xs:
        n = len(xs)
        with mem.reserve(n, "double"):
            xs = sorted(xs)
            if trim >= 0.5:
                return RVector("double", [_median(xs)])
            lo = int(math.floor(n * trim))
            xs = xs[lo:n - lo]
    return RVector("double", [_exact_mean(xs)])


def _median(xs):
    n = len(xs)
    if n % 2:
        return xs[n // 2]
    return _exact_mean([xs[n // 2 - 1], xs[n // 2]])


def _exact_mean(xs):
    if not xs:
        return math.nan
    pos = any(x == math.inf for x in xs)
    neg = any(x == -math.inf for x in xs)
    if pos and neg:
        return math.nan
    if pos or neg:
        return math.inf if pos else -math.inf
    s = sum((fractions.Fraction(x) for x in xs), fractions.Fraction(0)) / len(xs)
    return float(s)
