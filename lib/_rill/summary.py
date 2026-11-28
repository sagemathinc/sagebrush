"""Rill's summaries (design/rill.md A3): sum, prod, min, max and mean, as R
4.5.3 gives them (rill-tests/vec/, rill-tests/na/).

What R prints, observed:

- sum and prod accumulate doubles in extended precision (R's help: "extended-
  precision accumulators"): an 80-bit value (_LD: a 64-bit significand, an
  exponent range to 2**16384, gradual underflow to 2**-16445), rounded to
  nearest even after each step, then once to a double; so prod(c(rep(1e300,
  17), rep(1e-300, 17))) is Inf and the reversed order 0.  Each argument is
  summed (or multiplied) on its own and the results combined in double, so
  sum(0.1, 0.2, 0.3) is not sum(c(0.1, 0.2, 0.3)).  An integer sum is exact;
  it is a double once the running total, checked after each argument, has
  left the integer range (so sum(-5L, c(2147483647L, 1L)) is integer but
  sum(c(2147483647L, 1L), -5L) is double, as is an NA met after that).
- NA and NaN: arithmetic keeps the first one met (an NaN made on the way, as
  Inf - Inf, included), except that sum gives NA for an NA in any logical or
  integer argument; mean, min and max give NA if any element is NA, else NaN.
  With na.rm, a complex element is dropped when either part is NA or NaN.
- min and max: integer for logical and integer arguments, double with any
  double; with any string, character: the running result and each argument's
  own extreme are compared as numbers while both are numbers, as strings
  (a number printed to 7 significant digits) once either is a string.  No
  elements: Inf or -Inf, or NA for strings, with R's warning.
- mean: the extended-precision sum divided by n, corrected by the mean of the
  residuals (also in extended precision), then rounded once (an infinite
  first mean is the result); trim takes floor(n * trim) from each end of the
  sorted values (0.5 or more: the median), an NA or NaN giving NA, and is an
  error for complex numbers.  R's mean is a function that dispatches to
  mean.default, which its errors and warnings name (Calls: mean ->
  mean.default).

Memory (design §8.5): each reserves its whole peak before it computes: the
one-element result, and for a trimmed mean the sorted copy of x.
"""

import fractions
import math

from . import mem
from .eval import NotSupported, RError
from .values import NULL, RVector

INT_MAX = 2147483647
RANK = {"logical": 0, "integer": 1, "double": 2, "complex": 3, "character": 4}


# ---------------------------------------------------------------- extended precision

BITS = 64
# the exponent of the least significant bit of the smallest subnormal, and the power of two that overflows
# (x87's 80-bit format: minimum exponent -16382, 64-bit significand; R 4.5.3's prod underflows and
# overflows there)
LOW_EXP = -16445
HIGH_EXP = 16384


class _LD:
    """An 80-bit extended value: kind "num" (num * 2**exp, |num| < 2**64; a zero carries its sign in neg),
    "inf" (signed by neg), "na" or "nan" (R's two kinds of missing double, kept apart)."""
    __slots__ = ("kind", "num", "exp", "neg")

    def __init__(self, num=0, exp=0, neg=False):
        _set(self, num, exp, neg)

    @staticmethod
    def special(kind, neg=False):
        r = _LD.__new__(_LD)
        r.kind, r.num, r.exp, r.neg = kind, 0, 0, neg
        return r

    @staticmethod
    def of(x):
        """A double element (None is NA)."""
        if x is None:
            return _LD.special("na")
        x = float(x)
        if x != x:
            return _LD.special("nan")
        if math.isinf(x):
            return _LD.special("inf", x < 0)
        if x == 0:
            return _LD(0, 0, math.copysign(1.0, x) < 0)
        m, e = math.frexp(x)
        return _LD(int(m * (1 << 53)), e - 53)

    def missing(self):
        return self.kind in ("na", "nan")

    def add(self, o):
        if self.missing():
            return self
        if o.missing():
            return o
        if self.kind == "inf" or o.kind == "inf":
            if self.kind == "inf" and o.kind == "inf" and self.neg != o.neg:
                return _LD.special("nan")
            return self if self.kind == "inf" else o
        if self.num == 0 and o.num == 0:
            return _LD(0, 0, self.neg and o.neg)
        if self.num == 0:
            return o
        if o.num == 0:
            return self
        e = min(self.exp, o.exp)
        return _LD((self.num << (self.exp - e)) + (o.num << (o.exp - e)), e)

    def mul(self, o):
        if self.missing():
            return self
        if o.missing():
            return o
        neg = self.negative() != o.negative()
        if self.kind == "inf" or o.kind == "inf":
            if (self.kind == "num" and self.num == 0) or (o.kind == "num" and o.num == 0):
                return _LD.special("nan")
            return _LD.special("inf", neg)
        if self.num == 0 or o.num == 0:
            return _LD(0, 0, neg)
        return _LD(self.num * o.num, self.exp + o.exp)

    def negative(self):
        return self.num < 0 if self.kind == "num" and self.num else self.neg

    def neg_(self):
        if self.missing():
            return self
        if self.kind == "inf":
            return _LD.special("inf", not self.neg)
        return _LD(-self.num, self.exp, not self.neg)

    def div_int(self, n):
        """self / n (n a positive integer), rounded once."""
        if self.kind != "num" or self.num == 0:
            return self
        k = BITS + 2 + n.bit_length()
        q, r = divmod(abs(self.num) << k, n)
        # (a sticky bit below the quotient's: an inexact quotient never looks like a tie)
        m = (q << 1) | (1 if r else 0)
        return _LD(-m if self.num < 0 else m, self.exp - k - 1)

    def to_double(self):
        """The nearest double (None for NA)."""
        if self.kind == "na":
            return None
        if self.kind == "nan":
            return math.nan
        if self.kind == "inf":
            return -math.inf if self.neg else math.inf
        if self.num == 0:
            return -0.0 if self.neg else 0.0
        v = fractions.Fraction(self.num) * (fractions.Fraction(2) ** self.exp)
        try:
            return float(v)
        except OverflowError:
            return math.inf if v > 0 else -math.inf


def _set(r, num, exp, neg):
    """r := num * 2**exp rounded to the 80-bit format (ties to even), to a signed zero below the smallest
    subnormal or to an infinity at 2**HIGH_EXP; neg signs a zero num."""
    r.kind, r.neg = "num", neg
    if num == 0:
        r.num, r.exp = 0, 0
        return
    negative = num < 0
    a = -num if negative else num
    quantum = max(exp + a.bit_length() - BITS, LOW_EXP)
    if quantum > exp:
        shift = quantum - exp
        q, rem = a >> shift, a & ((1 << shift) - 1)
        half = 1 << (shift - 1)
        if rem > half or (rem == half and q & 1):
            q += 1
            if q.bit_length() > BITS:
                q >>= 1
                quantum += 1
        a, exp = q, quantum
    r.neg = negative
    if a == 0:
        r.num, r.exp = 0, 0
    elif a.bit_length() + exp > HIGH_EXP:
        r.kind, r.num, r.exp = "inf", 0, 0
    else:
        r.num, r.exp = (-a if negative else a), exp


def _double(x):
    """A double from an integer (an infinity past the largest double)."""
    try:
        return float(x)
    except OverflowError:
        return math.inf if x > 0 else -math.inf


def _first(total, x, op):
    """total op x in double, an NA or NaN met first kept (None is NA)."""
    if total is None or total != total:
        return total
    if x is None:
        return None
    return op(total, x)


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


def _complex_na(e):
    """A complex element is.na() counts: NA, or a part NaN."""
    return e is None or e.real != e.real or e.imag != e.imag


def _top(vs):
    return max((v.type for v in vs), key=RANK.get, default="integer")


# ---------------------------------------------------------------- sum and prod

def sum_(sess, call, args):
    """Each argument summed on its own (exactly for integers, in extended precision for doubles), then the
    arguments' sums added in a double, or as integers while every running total fits (R 4.5.3:
    sum(0.1, 0.2, 0.3) is not 0.6, sum(1L, 2147483647L, -5L) is a double)."""
    na_rm = _na_rm(args, call)
    vs = _values(args, "sum")
    t = _top(vs)
    if t == "character":
        raise RError("invalid 'type' (character) of argument", call)
    # (the whole peak is the one-element result; an integer sum may end as a double)
    with mem.reserve(1, "complex" if t == "complex" else "double"):
        if t in ("logical", "integer"):
            return _sum_integers(vs, na_rm)
        if t == "complex":
            return _sum_complex(vs, na_rm)
        return _sum_doubles(vs, na_rm)


def _sum_integers(vs, na_rm):
    total, wide = 0, False
    # (the total is checked after each argument: once outside the integer range, the result is double,
    # an NA included; within an argument the sum is exact)
    for v in vs:
        for e in v.data:
            if e is None:
                if na_rm:
                    continue
                return RVector("double" if wide else "integer", [None])
            total += int(e)
        if not -INT_MAX <= total <= INT_MAX:
            wide = True
    return RVector("double", [_double(total)]) if wide else RVector("integer", [total])


def _sum_doubles(vs, na_rm):
    total = 0.0
    for v in vs:
        if v.type in ("logical", "integer"):
            s = 0
            for e in v.data:
                if e is None:
                    if na_rm:
                        continue
                    # (an NA in a logical or integer argument is the result, whatever came before)
                    return RVector("double", [None])
                s += int(e)
            x = _double(s)
        else:
            acc = _LD()
            for e in v.data:
                if na_rm and _is_na(e):
                    continue
                acc = acc.add(_LD.of(e))
            x = acc.to_double()
        total = _first(total, x, lambda a, b: a + b)
    return RVector("double", [total])


def _sum_complex(vs, na_rm):
    re = im = 0.0
    for v in vs:
        acc_re, acc_im = _LD(), _LD()
        for e in v.data:
            if na_rm and (_complex_na(e) if v.type == "complex" else _is_na(e)):
                continue
            if e is None:
                return RVector("complex", [None])
            if v.type != "complex":
                e = complex(float(e), 0.0)
            acc_re, acc_im = acc_re.add(_LD.of(e.real)), acc_im.add(_LD.of(e.imag))
        re, im = re + acc_re.to_double(), im + acc_im.to_double()
    return RVector("complex", [complex(re, im)])


def prod(sess, call, args):
    """Each argument's product on its own, in extended precision, then the arguments' products multiplied in a
    double (R 4.5.3: prod(1e200, 1e200, 1e-200) is Inf)."""
    na_rm = _na_rm(args, call)
    vs = _values(args, "prod")
    t = _top(vs)
    if t == "character":
        raise RError("invalid 'type' (character) of argument", call)
    if t == "complex":
        raise NotSupported("prod() of complex numbers")
    with mem.reserve(1, "double"):
        total = 1.0
        for v in vs:
            acc = _LD(1, 0)
            for e in v.data:
                if na_rm and _is_na(e):
                    continue
                acc = acc.mul(_LD.of(e))
            total = _first(total, acc.to_double(), lambda a, b: a * b)
        return RVector("double", [total])


# ---------------------------------------------------------------- min and max

def _num_str(x, vtype):
    """A number as min and max compare it with strings: R's printed form, 7 significant digits (TRUE is "1")."""
    if vtype in ("logical", "integer"):
        return str(int(x))
    from . import fmt
    return fmt.format_real([x])[0]


def _extreme(sess, call, args, which):
    na_rm = _na_rm(args, call)
    vs = _values(args, which)
    t = _top(vs)
    if t == "complex":
        raise RError("invalid 'type' (complex) of argument", call)
    from .base import _collate_key
    rtype = t if t in ("double", "character") else "integer"
    with mem.reserve(1, rtype):
        # cur: the running result, ("num", x, its type) or ("str", s); an NA anywhere is the result
        cur = None
        for v in vs:
            got = _arg_extreme(v, which, na_rm, _collate_key)
            if got == "na":
                return RVector(rtype, [None])
            if got is not None:
                cur = got if cur is None else _better(cur, got, which, _collate_key)
        if cur is None:
            if t == "character":
                sess.warn("no non-missing arguments, returning NA", call)
                return RVector("character", [None])
            inf = math.inf if which == "min" else -math.inf
            sess.warn("no non-missing arguments to %s; returning %s" % (which, "Inf" if inf > 0 else "-Inf"), call)
            return RVector("double", [inf])
        if t == "character":
            return RVector("character", [cur[1] if cur[0] == "str" else _num_str(cur[1], cur[2])])
        return RVector(rtype, [float(cur[1]) if rtype == "double" else int(cur[1])])


def _arg_extreme(v, which, na_rm, key):
    """One argument's own extreme: ("num", x, type) or ("str", s), None when it has no elements left, or "na"."""
    best, nan = None, False
    if v.type == "character":
        best_key = None
        for e in v.data:
            if e is None:
                if na_rm:
                    continue
                return "na"
            k = key(e)
            if best is None or (k < best_key if which == "min" else k > best_key):
                best, best_key = e, k
        return None if best is None else ("str", best)
    for e in v.data:
        if e is None or (v.type == "double" and e != e):
            if na_rm:
                continue
            if e is None:
                return "na"
            nan = True
            continue
        if best is None or (e < best if which == "min" else e > best):
            best = e
    if nan:
        return ("num", math.nan, "double")
    return None if best is None else ("num", best, v.type)


def _better(cur, new, which, key):
    """The running result after one more argument's extreme: compared as numbers while both are numbers (NaN
    sticks), else as strings; the earlier one kept on a tie (max(-0, 0) is -0)."""
    if cur[0] == "num" and new[0] == "num":
        if cur[1] != cur[1]:
            return cur
        if new[1] != new[1]:
            return new
        wins = new[1] < cur[1] if which == "min" else new[1] > cur[1]
        if not wins:
            return cur
        return new if new[2] == "double" or cur[2] != "double" else ("num", new[1], "double")
    a = cur[1] if cur[0] == "str" else _num_str(cur[1], cur[2])
    b = new[1] if new[0] == "str" else _num_str(new[1], new[2])
    ka, kb = key(a), key(b)
    return ("str", b) if (kb < ka if which == "min" else kb > ka) else ("str", a)


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
    if trim != trim or trim < 0:
        raise NotSupported("mean() with a negative trim")
    data = x.data
    cplx = x.type == "complex"
    if cplx:
        dropped = _complex_na if na_rm else (lambda e: False)
    else:
        dropped = _is_na if na_rm else (lambda e: False)
    n = sum(1 for e in data if not dropped(e))
    rtype = "complex" if cplx else "double"
    trimmed = trim > 0 and n > 0
    # (the whole peak: the result, and for a trimmed mean the sorted copy of x)
    with mem.reserve(1, rtype, *([(n, "double")] if trimmed and not cplx else [])):
        if trimmed and cplx:
            raise RError("trimmed means are not defined for complex data", call)
        if any(e is None for e in data if not dropped(e)):
            return RVector(rtype, [None])
        if cplx:
            def part(f):
                return lambda: (f(e) for e in data if not dropped(e))
            re = _ld_mean(part(lambda e: e.real), n)
            im = _ld_mean(part(lambda e: e.imag), n)
            return RVector("complex", [complex(re, im)])
        if trimmed:
            xs = [float(e) for e in data if not dropped(e)]
            if any(e != e for e in xs):
                # (a trimmed mean of an NaN is NA, R 4.5.3)
                return RVector("double", [None])
            xs.sort()
            if trim >= 0.5:
                return RVector("double", [_median(xs)])
            lo = int(math.floor(n * trim))
            return RVector("double", [_ld_mean(lambda: (xs[i] for i in range(lo, n - lo)), n - 2 * lo)])
        return RVector("double", [_ld_mean(lambda: (float(e) for e in data if not dropped(e)), n)])


def _median(xs):
    n = len(xs)
    if n % 2:
        return xs[n // 2]
    return _ld_mean(lambda: iter((xs[n // 2 - 1], xs[n // 2])), 2)


def _ld_mean(values, n):
    """R's mean of n doubles, values() iterating them afresh: the extended-precision sum divided by n, then
    corrected by the extended-precision mean of the residuals (R 4.5.3: mean(c(1e20, 1, -1e20)) is 0); an
    infinite or NaN first mean is the result."""
    if n == 0:
        return math.nan
    s = _LD()
    for x in values():
        s = s.add(_LD.of(x))
    s = s.div_int(n)
    if s.kind != "num":
        return s.to_double()
    t = _LD()
    for x in values():
        t = t.add(_LD.of(x).add(s.neg_()))
    return s.add(t.div_int(n)).to_double()
