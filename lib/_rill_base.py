"""Rill: base-R builtins (arithmetic, vectors, indexing, strings, factors, apply family, matrices, data frames)."""

import math

import _rill as C
from _rill import (Vec, RList, NULL, Closure, Builtin, Sym, Call, Const, MISSING, RError, NA,
                   mk_chr, mk_int, mk_dbl, mk_lgl, getattr_, setattr_, names_of, classes, is_factor, is_df,
                   builtin, method, as_type, as_double, num1, int1, str1, match_spec, warn, shallow, copy_attrs)
import _rill_fmt as F

INT_MAX = 2147483647


# ---------------------------------------------------------------- helpers

def vlen(x):
    if x is NULL:
        return 0
    return len(x.v)


def rtype(*xs):
    r = -1
    for x in xs:
        if x is NULL:
            continue
        t = "character" if is_factor(x) else x.type
        r = max(r, C.RANK.get(t, 4))
    return {-1: "logical", 0: "logical", 1: "integer", 2: "double", 3: "character", 4: "list"}[r]


def keep_struct(res, a, b=None, keep_class=True):
    """names/dim/dimnames of an operand onto an elementwise result."""
    src = a
    if b is not None and vlen(b) > vlen(a):
        src = b
    attrs = {}
    for k in ("names", "dim", "dimnames"):
        v = getattr_(src, k)
        if v is NULL and b is not None and src is a:
            v = getattr_(b, k) if vlen(b) == vlen(a) else NULL
        if v is not NULL:
            attrs[k] = v
    if keep_class and src.attrs and not is_factor(src):
        for k, v in src.attrs.items():
            if k not in attrs:
                attrs[k] = v
    res.attrs = attrs or None
    return res


def fdiv(x, y):
    try:
        return x / y
    except ZeroDivisionError:
        if x == 0 or math.isnan(x):
            return math.nan
        return math.copysign(math.inf, x) * (1 if math.copysign(1, y) > 0 else -1)


def fpow(x, y):
    if x == 1 or y == 0:
        return 1.0
    try:
        r = x ** y
        if isinstance(r, complex):
            return math.nan
        return float(r)
    except ZeroDivisionError:
        return math.inf
    except OverflowError:
        return math.inf if x > 0 or float(y).is_integer() and int(y) % 2 == 0 else -math.inf


def fmod(x, y):
    if y == 0:
        return math.nan
    if math.isinf(y):
        return x if (x >= 0) == (y > 0) else y
    return x - math.floor(x / y) * y


def fidiv(x, y):
    if y == 0:
        return fdiv(x, y)
    return float(math.floor(x / y))


DOPS = {"+": lambda x, y: x + y, "-": lambda x, y: x - y, "*": lambda x, y: x * y, "/": fdiv,
        "^": fpow, "%%": fmod, "%/%": fidiv}


def int_op(op, x, y):
    if op == "+":
        r = x + y
    elif op == "-":
        r = x - y
    elif op == "*":
        r = x * y
    elif op == "%%":
        if y == 0:
            return None
        r = x % y
    elif op == "%/%":
        if y == 0:
            return None
        r = x // y
    if r > INT_MAX or r < -INT_MAX:
        warn("NAs produced by integer overflow")
        return None
    return r


def unclass_num(x, op):
    if is_factor(x):
        warn("'%s' not meaningful for factors" % op)
        return Vec("logical", [None] * len(x.v))
    if isinstance(x, Vec):
        if x.type == "character":
            raise RError("non-numeric argument to binary operator")
        return x
    if x is NULL:
        return Vec("double", [])
    if is_df(x):
        raise RError("non-numeric argument to binary operator")
    raise RError("non-numeric argument to binary operator")


def arith(op, a, b):
    a = unclass_num(a, op)
    b = unclass_num(b, op)
    la, lb = len(a.v), len(b.v)
    n = 0 if la == 0 or lb == 0 else max(la, lb)
    if n and (n % la or n % lb):
        warn("longer object length is not a multiple of shorter object length")
    ints = a.type in ("logical", "integer") and b.type in ("logical", "integer") and op not in ("/", "^")
    if ints:
        av, bv = as_type(a, "integer").v, as_type(b, "integer").v
        res = []
        for i in range(n):
            x, y = av[i % la], bv[i % lb]
            res.append(None if x is None or y is None else int_op(op, x, y))
        return keep_struct(Vec("integer", res), a, b)
    av, bv = as_double(a).v, as_double(b).v
    f = DOPS[op]
    res = []
    for i in range(n):
        x, y = av[i % la], bv[i % lb]
        if x is None or y is None:
            if op == "^" and ((x == 1) or (y == 0)):
                res.append(1.0)
            else:
                res.append(None)
        else:
            res.append(f(x, y))
    return keep_struct(Vec("double", res), a, b)


def make_arith(op):
    def fn(args, env):
        if len(args) == 1:
            x = args[0][1]
            if op == "-":
                x = unclass_num(x, op)
                if x.type in ("logical", "integer"):
                    return keep_struct(Vec("integer", [None if e is None else -int(e) for e in x.v]), x)
                return keep_struct(Vec("double", [None if e is None else -e for e in x.v]), x)
            return unclass_num(x, op)
        a, b = args[0][1], args[1][1]
        if (C.inherits(a, "Date") or C.inherits(b, "Date")) and op in "+-":
            r = arith(op, strip_class(a), strip_class(b))
            r = as_double(r)
            if op == "-" and C.inherits(a, "Date") and C.inherits(b, "Date"):
                return r
            r.attrs = {"class": mk_chr(["Date"])}
            return r
        return arith(op, a, b)
    return fn


def strip_class(x):
    if isinstance(x, Vec) and x.attrs and "class" in x.attrs:
        return Vec(x.type, x.v)
    return x


for _op in ("+", "-", "*", "/", "^", "%%", "%/%"):
    builtin(_op)(make_arith(_op))


def cmp_vals(op, x, y):
    if op == "==":
        return x == y
    if op == "!=":
        return x != y
    if op == "<":
        return x < y
    if op == ">":
        return x > y
    if op == "<=":
        return x <= y
    return x >= y


def str_key(s):
    """Collation like en_US: case-insensitive first, then lower before upper."""
    return (s.lower(), s.swapcase())


def compare(op, a, b):
    if (C.inherits(a, "ordered") or C.inherits(b, "ordered")) and op not in ("==", "!="):
        f = a if is_factor(a) else b
        lv = getattr_(f, "levels").v
        code = lambda x: Vec("integer", x.v) if is_factor(x) else Vec("integer", [None if s not in lv else lv.index(s) + 1 for s in as_type(x, "character").v])
        a, b = code(a), code(b)
    if is_factor(a):
        a = as_type(a, "character")
    if is_factor(b):
        b = as_type(b, "character")
    if a is NULL:
        a = Vec("logical", [])
    if b is NULL:
        b = Vec("logical", [])
    if not isinstance(a, Vec) or not isinstance(b, Vec):
        raise RError("comparison (%s) is possible only for atomic and list types" % op)
    la, lb = len(a.v), len(b.v)
    n = 0 if la == 0 or lb == 0 else max(la, lb)
    if n and (n % la or n % lb):
        warn("longer object length is not a multiple of shorter object length")
    t = rtype(a, b)
    if t == "character":
        av, bv = as_type(a, "character").v, as_type(b, "character").v
        key = str_key
    else:
        av, bv = as_double(a).v, as_double(b).v
        key = None
    res = []
    for i in range(n):
        x, y = av[i % la], bv[i % lb]
        if x is None or y is None or (key is None and (math.isnan(x) or math.isnan(y))):
            res.append(None)
        elif key is not None and op not in ("==", "!="):
            res.append(cmp_vals(op, key(x), key(y)))
        else:
            res.append(cmp_vals(op, x, y))
    return keep_struct(Vec("logical", res), a, b, keep_class=False)


for _op in ("==", "!=", "<", ">", "<=", ">="):
    builtin(_op)((lambda o: lambda args, env: compare(o, args[0][1], args[1][1]))(_op))


def logic(op, a, b):
    for x in (a, b):
        if isinstance(x, Vec) and x.type == "character":
            raise RError("operations are possible only for numeric, logical or complex types")
    av, bv = as_type(a, "logical").v, as_type(b, "logical").v
    la, lb = len(av), len(bv)
    n = 0 if la == 0 or lb == 0 else max(la, lb)
    res = []
    for i in range(n):
        x, y = av[i % la], bv[i % lb]
        if op == "&":
            res.append(False if (x is False or y is False) else (None if x is None or y is None else True))
        else:
            res.append(True if (x is True or y is True) else (None if x is None or y is None else False))
    return keep_struct(Vec("logical", res), a, b)


builtin("&")(lambda args, env: logic("&", args[0][1], args[1][1]))
builtin("|")(lambda args, env: logic("|", args[0][1], args[1][1]))


@builtin("!")
def _not(args, env):
    x = args[0][1]
    if isinstance(x, Vec) and x.type == "character":
        raise RError("invalid argument type")
    v = as_type(x, "logical").v
    return keep_struct(Vec("logical", [None if e is None else not e for e in v]), x)


@builtin("xor")
def _xor(args, env):
    a, b = as_type(args[0][1], "logical").v, as_type(args[1][1], "logical").v
    n = max(len(a), len(b))
    return mk_lgl([None if a[i % len(a)] is None or b[i % len(b)] is None else a[i % len(a)] != b[i % len(b)] for i in range(n)])


@builtin("isTRUE")
def _istrue(args, env):
    x = args[0][1]
    return mk_lgl([isinstance(x, Vec) and x.type == "logical" and len(x.v) == 1 and x.v[0] is True])


@builtin("isFALSE")
def _isfalse(args, env):
    x = args[0][1]
    return mk_lgl([isinstance(x, Vec) and x.type == "logical" and len(x.v) == 1 and x.v[0] is False])


# ---------------------------------------------------------------- math

def math1(name, f, keep_int=False, nan_warn=True):
    def fn(args, env):
        x = args[0][1]
        if is_df(x):
            raise RError("non-numeric argument to mathematical function")
        if isinstance(x, Vec) and x.type == "character" or is_factor(x):
            raise RError("non-numeric argument to mathematical function")
        if keep_int and isinstance(x, Vec) and x.type in ("integer", "logical"):
            return keep_struct(Vec("integer", [None if e is None else f(int(e)) for e in x.v]), x)
        v = as_double(x).v
        res = []
        nan = False
        for e in v:
            if e is None:
                res.append(None)
                continue
            try:
                r = f(e)
            except (ValueError, ZeroDivisionError):
                r = math.nan
            except OverflowError:
                r = math.inf
            if isinstance(r, float) and math.isnan(r) and not math.isnan(e):
                nan = True
            res.append(float(r))
        if nan and nan_warn:
            warn("NaNs produced", "%s(%s)" % (name, F.deparse(C.Const(x)) if len(v) == 1 else "x"))
        return keep_struct(Vec("double", res), x)
    builtin(name)(fn)


def _log(e):
    if e < 0:
        return math.nan
    if e == 0:
        return -math.inf
    if math.isinf(e):
        return e
    return math.log(e)


def _sqrt(e):
    if e < 0:
        return math.nan
    return math.sqrt(e) if not math.isinf(e) else e


def _gamma(e):
    if e == int(e) and e <= 0:
        return math.nan
    try:
        return math.gamma(e)
    except OverflowError:
        return math.inf


math1("sqrt", _sqrt)
math1("exp", lambda e: math.exp(e) if e < 709.8 else math.inf)
math1("abs", abs, keep_int=True)
math1("floor", lambda e: float(math.floor(e)) if not math.isinf(e) and not math.isnan(e) else e)
math1("ceiling", lambda e: float(math.ceil(e)) if not math.isinf(e) and not math.isnan(e) else e)
math1("trunc", lambda e: float(math.trunc(e)) if not math.isinf(e) and not math.isnan(e) else e)
math1("sin", math.sin)
math1("cos", math.cos)
math1("tan", math.tan)
math1("asin", math.asin)
math1("acos", math.acos)
math1("atan", math.atan)
math1("sinh", math.sinh)
math1("cosh", math.cosh)
math1("tanh", math.tanh)
math1("log10", lambda e: _log(e) / math.log(10) if e > 0 and not math.isinf(e) else _log(e))
math1("log2", lambda e: math.log2(e) if e > 0 and not math.isinf(e) else _log(e))
math1("log1p", lambda e: math.log1p(e) if e > -1 else (-math.inf if e == -1 else math.nan))
math1("expm1", math.expm1)
math1("gamma", _gamma)
math1("lgamma", lambda e: math.lgamma(e) if not (e == int(e) and e <= 0) else math.inf)
math1("factorial", lambda e: _gamma(e + 1))
math1("digamma", lambda e: __import__("scipy.special").special.digamma(e))


@builtin("log")
def _logf(args, env):
    m = match_spec(args, "x, base")
    x = m["x"]
    if isinstance(x, Vec) and x.type == "character":
        raise RError("non-numeric argument to mathematical function")
    v = as_double(x).v
    nan = any(e is not None and e < 0 for e in v)
    if "base" in m:
        b = num1(m["base"])
        res = [None if e is None else (_log(e) / math.log(b)) for e in v]
    else:
        res = [None if e is None else _log(e) for e in v]
    if nan:
        warn("NaNs produced", "log(%s)" % F.deparse(C.Const(x)))
    return keep_struct(Vec("double", res), x)


def r_round(x, d=0):
    if x is None or math.isnan(x) or math.isinf(x):
        return x
    if d == 0:
        return float(round(x))
    return float(round(x, d))


@builtin("round")
def _round(args, env):
    m = match_spec(args, "x, digits")
    x = m["x"]
    d = int1(m["digits"]) if "digits" in m else 0
    if isinstance(x, Vec) and x.type in ("integer", "logical") and d >= 0:
        return as_type(x, "integer", True)
    return keep_struct(Vec("double", [r_round(e, d) for e in as_double(x).v]), x)


@builtin("signif")
def _signif(args, env):
    m = match_spec(args, "x, digits")
    x = m["x"]
    d = max(1, int1(m["digits"]) if "digits" in m else 6)
    res = []
    for e in as_double(x).v:
        if e is None or math.isnan(e) or math.isinf(e) or e == 0:
            res.append(e)
        else:
            res.append(float("%.*g" % (d, e)))
    return keep_struct(Vec("double", res), x)


@builtin("choose")
def _choose(args, env):
    n, k = as_double(args[0][1]).v, as_double(args[1][1]).v
    L = max(len(n), len(k))
    res = []
    for i in range(L):
        a, b = n[i % len(n)], k[i % len(k)]
        b = round(b)
        if b < 0:
            res.append(0.0)
        elif a == int(a):
            res.append(float(math.comb(int(a), int(b))) if a >= 0 else float((-1) ** int(b) * math.comb(int(-a + b - 1), int(b))))
        else:
            r = 1.0
            for j in range(int(b)):
                r *= (a - j) / (j + 1)
            res.append(r)
    return mk_dbl(res)


@builtin("beta")
def _beta(args, env):
    a, b = num1(args[0][1]), num1(args[1][1])
    return mk_dbl([math.exp(math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b))])


def cumf(name, f, init):
    def fn(args, env):
        x = args[0][1]
        isint = x.type in ("integer", "logical") and name in ("cumsum", "cumprod") and name != "cumprod"
        v = as_type(x, "integer").v if isint else as_double(x).v
        res = []
        acc = init
        dead = False
        for e in v:
            if dead or e is None:
                dead = True
                res.append(None)
                continue
            acc = e if acc is None else f(acc, e)
            if isint and abs(acc) > INT_MAX:
                warn("integer overflow in 'cumsum'; use 'cumsum(as.numeric(.))'")
                dead = True
                res.append(None)
                continue
            res.append(acc)
        r = Vec("integer" if isint else "double", res)
        nm = getattr_(x, "names")
        if nm is not NULL:
            r.attrs = {"names": nm}
        return r
    builtin(name)(fn)


cumf("cumsum", lambda a, b: a + b, None)
cumf("cumprod", lambda a, b: a * b, None)
cumf("cummax", max, None)
cumf("cummin", min, None)


# ---------------------------------------------------------------- summaries

def flat_values(args, narm):
    vals = []
    t = "logical"
    for n, v in args:
        if n == "na.rm":
            continue
        if v is NULL:
            continue
        if is_factor(v):
            raise RError("'%s' not meaningful for factors" % "sum")
        if isinstance(v, RList):
            if is_df(v):
                for col in v.v:
                    vals.extend(col.v)
                    t = rtype(Vec(t, []), col)
                continue
            raise RError("invalid 'type' (list) of argument")
        if v.type == "character":
            t = "character"
        elif C.RANK[v.type] > C.RANK[t]:
            t = v.type
        vals.extend(coerce_list(v))
    return vals, t


def coerce_list(v):
    return v.v


def narm_of(args):
    for n, v in args:
        if n == "na.rm":
            return C.as_logical1(v)
    return False


@builtin("sum")
def _sum(args, env):
    narm = narm_of(args)
    t = "integer"
    acc_i = 0
    acc_d = 0.0
    na = False
    nan = False
    for n, v in args:
        if n == "na.rm" or v is NULL:
            continue
        if isinstance(v, Vec) and v.type == "character":
            raise RError("invalid 'type' (character) of argument")
        if is_factor(v):
            raise RError("'sum' not meaningful for factors")
        cols = v.v if is_df(v) else [v]
        for col in cols:
            if col.type == "double":
                t = "double"
            for e in col.v:
                if e is None:
                    if not narm:
                        na = True
                    continue
                if isinstance(e, float) and math.isnan(e):
                    if not narm:
                        nan = True
                    continue
                if col.type == "double":
                    acc_d += e
                else:
                    acc_i += int(e)
    if t == "integer":
        if na:
            return mk_int([None])
        if abs(acc_i) > INT_MAX:
            warn("integer overflow - use sum(as.numeric(.))")
            return mk_int([None])
        return mk_int([acc_i])
    if na:
        return mk_dbl([None])
    if nan:
        return mk_dbl([math.nan])
    return mk_dbl([acc_d + acc_i])


@builtin("prod")
def _prod(args, env):
    narm = narm_of(args)
    vals, t = flat_values(args, narm)
    r = 1.0
    for e in vals:
        if e is None:
            if narm:
                continue
            return mk_dbl([None])
        r *= e
    return mk_dbl([r])


def minmax(args, which):
    narm = narm_of(args)
    vals, t = flat_values(args, narm)
    name = "max" if which > 0 else "min"
    if t == "character":
        vals = [as_type(Vec("character", [e]) if isinstance(e, str) else C.scalar(e), "character").v[0] for e in vals]
    if any(e is None for e in vals):
        if not narm:
            return Vec("double" if t == "logical" else t, [None])
        vals = [e for e in vals if e is not None]
    if not vals:
        warn("no non-missing arguments to %s; returning %s" % (name, "-Inf" if which > 0 else "Inf"))
        return mk_dbl([-math.inf if which > 0 else math.inf])
    if t != "character" and any(isinstance(e, float) and math.isnan(e) for e in vals):
        return mk_dbl([math.nan])
    if t == "character":
        r = max(vals, key=str_key) if which > 0 else min(vals, key=str_key)
        return mk_chr([r])
    r = max(vals) if which > 0 else min(vals)
    if t in ("integer", "logical"):
        return mk_int([int(r)])
    return mk_dbl([float(r)])


builtin("max")(lambda args, env: minmax(args, 1))
builtin("min")(lambda args, env: minmax(args, -1))


@builtin("range")
def _range(args, env):
    a = minmax(args, -1)
    b = minmax(args, 1)
    return Vec(a.type, a.v + b.v)


def pminmax(args, which):
    narm = narm_of(args)
    vs = [as_double(v) for n, v in args if n != "na.rm"]
    n = max(len(v.v) for v in vs)
    res = []
    for i in range(n):
        col = [v.v[i % len(v.v)] for v in vs]
        if any(e is None for e in col):
            if not narm:
                res.append(None)
                continue
            col = [e for e in col if e is not None]
        res.append(max(col) if which > 0 else min(col))
    t = "integer" if all(v.type == "integer" for n2, v in args if n2 != "na.rm") else "double"
    return Vec(t, [None if e is None else (int(e) if t == "integer" else e) for e in res])


builtin("pmax")(lambda args, env: pminmax(args, 1))
builtin("pmin")(lambda args, env: pminmax(args, -1))


@builtin("any")
def _any(args, env):
    narm = narm_of(args)
    seen_na = False
    for n, v in args:
        if n == "na.rm":
            continue
        for e in as_type(v, "logical").v:
            if e is True:
                return mk_lgl([True])
            if e is None:
                seen_na = True
    return mk_lgl([None if seen_na and not narm else False])


@builtin("all")
def _all(args, env):
    narm = narm_of(args)
    seen_na = False
    for n, v in args:
        if n == "na.rm":
            continue
        for e in as_type(v, "logical").v:
            if e is False:
                return mk_lgl([False])
            if e is None:
                seen_na = True
    return mk_lgl([None if seen_na and not narm else True])


# ---------------------------------------------------------------- construction

def elt_names(n, v):
    """Names that c()/unlist() give to the elements of v under the argument name n."""
    nm = names_of(v) if isinstance(v, (Vec, RList)) else None
    L = vlen(v)
    if n:
        if L == 1:
            return [n if not nm or not nm[0] else n + "." + nm[0]]
        if nm:
            return [n + "." + s if s else n + str(i + 1) for i, s in enumerate(nm)]
        return [n + str(i + 1) for i in range(L)]
    if nm:
        return list(nm)
    return [""] * L


def combine(items, recursive=False):
    """c(...) over (name, value) pairs."""
    items = [(n, v) for n, v in items if v is not NULL]
    if not items:
        return NULL
    if all(is_factor(v) for n, v in items):
        levels = []
        for n, v in items:
            for l in getattr_(v, "levels").v:
                if l not in levels:
                    levels.append(l)
        codes = []
        for n, v in items:
            lv = getattr_(v, "levels").v
            codes.extend(None if i is None else levels.index(lv[i - 1]) + 1 for i in v.v)
        return Vec("integer", codes, {"levels": mk_chr(levels), "class": mk_chr(["factor"])})
    anynames = any(n or names_of(v) for n, v in items)
    if any(isinstance(v, RList) or not isinstance(v, Vec) for n, v in items) and not recursive:
        vals, nms = [], []
        for n, v in items:
            if isinstance(v, RList):
                vals.extend(v.v)
                nms.extend(elt_names(n, v))
            elif isinstance(v, Vec):
                vals.extend(Vec(v.type, [e]) for e in v.v)
                nms.extend(elt_names(n, v))
            else:
                vals.append(v)
                nms.append(n or "")
        return RList(vals, {"names": mk_chr(nms)} if anynames else None)
    if recursive:
        flat = []
        for n, v in items:
            if isinstance(v, RList):
                sub = combine(list(zip(elt_names(n, v), v.v)), True)
                if sub is not NULL:
                    flat.append((None, sub))
            else:
                flat.append((n, v))
        items = flat
        anynames = any(n or names_of(v) for n, v in items)
        if not items:
            return NULL
    t = rtype(*[v for n, v in items])
    vals, nms = [], []
    for n, v in items:
        if is_factor(v):
            v = as_type(v, "character") if t == "character" else Vec("integer", v.v)
        vals.extend(as_type(v, t).v)
        if anynames:
            nms.extend(elt_names(n, v))
    return Vec(t, vals, {"names": mk_chr(nms)} if anynames else None)


@builtin("c")
def _c(args, env):
    rec = False
    items = []
    for n, v in args:
        if n == "recursive":
            rec = C.as_logical1(v)
        elif n == "use.names":
            pass
        else:
            items.append((n, v))
    return combine(items, rec)


@builtin("unlist")
def _unlist(args, env):
    m = match_spec(args, "x, recursive, use.names")
    x = m["x"]
    usen = C.as_logical1(m["use.names"]) if "use.names" in m else True
    if not isinstance(x, RList):
        return x
    nm = names_of(x) or [""] * len(x.v)
    r = combine(list(zip(nm, x.v)), True)
    if not usen and r is not NULL:
        r = Vec(r.type, r.v, None) if isinstance(r, Vec) else r
    return r


@builtin("list")
def _list(args, env):
    vals = [v for n, v in args]
    if any(n for n, v in args):
        return RList(vals, {"names": mk_chr([n or "" for n, v in args])})
    return RList(vals)


def vec_ctor(t, init):
    def fn(args, env):
        n = int1(args[0][1]) if args else 0
        return Vec(t, [init] * n)
    return fn


builtin("numeric|double")(vec_ctor("double", 0.0))
builtin("integer")(vec_ctor("integer", 0))
builtin("character")(vec_ctor("character", ""))
builtin("logical")(vec_ctor("logical", False))


@builtin("vector")
def _vector(args, env):
    m = match_spec(args, "mode, length")
    mode = str1(m["mode"]) if "mode" in m else "logical"
    n = int1(m["length"]) if "length" in m else 0
    if mode == "list":
        return RList([NULL] * n)
    t = {"numeric": "double", "double": "double", "integer": "integer", "character": "character", "logical": "logical"}[mode]
    return Vec(t, [{"double": 0.0, "integer": 0, "character": "", "logical": False}[t]] * n)


@builtin(":")
def _colon(args, env):
    a, b = args[0][1], args[1][1]
    if vlen(a) == 0 or vlen(b) == 0:
        raise RError("argument of length 0")
    if is_factor(a):
        raise RError("unsupported")
    x, y = num1(a), num1(b)
    if x is None or y is None:
        raise RError("NA/NaN argument")
    n = int(math.floor(abs(y - x) + 1e-10)) + 1
    step = 1 if y >= x else -1
    if x == int(x) and abs(x) <= INT_MAX and abs(x + step * (n - 1)) <= INT_MAX:
        return mk_int([int(x) + step * i for i in range(n)])
    return mk_dbl([x + step * i for i in range(n)])


@builtin("seq")
def _seq(args, env):
    m = match_spec(args, "from, to, by, length.out, along.with, ...")
    if "along.with" in m:
        return mk_int(list(range(1, vlen(m["along.with"]) + 1)))
    has = lambda k: k in m and m[k] is not NULL
    if has("from") and not has("to") and not has("by") and not has("length.out"):
        f = m["from"]
        if vlen(f) == 1:
            n = num1(f)
            return _colon([(None, mk_int([1])), (None, f)], env) if n >= 1 else _colon([(None, mk_int([1])), (None, f)], env)
        return mk_int(list(range(1, vlen(f) + 1)))
    frm = num1(m["from"]) if has("from") else 1.0
    if has("length.out"):
        n = int(math.ceil(num1(m["length.out"])))
        if has("to") and has("from"):
            to = num1(m["to"])
            if n == 1:
                return mk_dbl([frm]) if not isint_val(frm) else mk_int([int(frm)])
            by = (to - frm) / (n - 1)
            vals = [frm + i * by for i in range(n)]
            if all(isint_val(v) for v in vals) and isint_val(frm) and m["from"].type == "integer":
                return mk_int([int(v) for v in vals])
            return mk_dbl(vals)
        by = num1(m["by"]) if has("by") else 1.0
        if has("to") and not has("from"):
            to = num1(m["to"])
            frm = to - (n - 1) * by
        vals = [frm + i * by for i in range(n)]
        if all(isint_val(v) for v in vals) and not has("by"):
            return mk_int([int(v) for v in vals])
        return mk_dbl(vals)
    to = num1(m["to"]) if has("to") else 1.0
    if not has("by"):
        r = _colon([(None, mk_dbl([frm])), (None, mk_dbl([to]))], env)
        return r
    by = num1(m["by"])
    if by == 0 and frm != to:
        raise RError("invalid '(to - from)/by' in seq(.)")
    if (to - frm) * by < 0:
        raise RError("wrong sign in 'by' argument")
    n = int(math.floor((to - frm) / by + 1e-10))
    intres = all(isinstance(m[k], Vec) and m[k].type == "integer" for k in ("from", "by") if has(k)) and has("from")
    if intres:
        return mk_int([int(frm + i * by) for i in range(n + 1)])
    return mk_dbl([frm + i * by for i in range(n + 1)])


def isint_val(v):
    return v == int(v)


@builtin("seq_len")
def _seq_len(args, env):
    return mk_int(list(range(1, int1(args[0][1]) + 1)))


@builtin("seq_along")
def _seq_along(args, env):
    return mk_int(list(range(1, vlen(args[0][1]) + 1)))


@builtin("rep")
def _rep(args, env):
    m = match_spec(args, "x, times, each, length.out")
    x = m["x"]
    each = int1(m["each"]) if "each" in m else 1
    fac = is_factor(x)
    vals = x.v if isinstance(x, (Vec, RList)) else []
    nm = names_of(x)
    idx = []
    for i in range(len(vals)):
        idx.extend([i] * each)
    if "times" in m:
        t = as_type(m["times"], "integer").v
        if len(t) == 1:
            idx = idx * t[0]
        else:
            if len(t) != len(idx):
                raise RError("invalid 'times' argument")
            idx = [i for i, k in zip(idx, t) for _ in range(k)]
    if "length.out" in m and m["length.out"] is not NULL:
        L = int1(m["length.out"])
        idx = [idx[i % len(idx)] for i in range(L)] if idx else []
    res = [vals[i] for i in idx]
    attrs = {}
    if nm is not None:
        attrs["names"] = mk_chr([nm[i] for i in idx])
    if fac:
        attrs["levels"] = getattr_(x, "levels")
        attrs["class"] = getattr_(x, "class")
    if isinstance(x, RList):
        return RList(res, attrs or None)
    return Vec(x.type, res, attrs or None)


@builtin("rep_len")
def _rep_len(args, env):
    return _rep([(None, args[0][1]), ("length.out", args[1][1])], env)


@builtin("rev")
def _rev(args, env):
    x = args[0][1]
    if x is NULL:
        return NULL
    attrs = None
    nm = names_of(x)
    if nm is not None:
        attrs = {"names": mk_chr(nm[::-1])}
    if is_factor(x):
        attrs = dict(attrs or {}, levels=getattr_(x, "levels"), **{"class": getattr_(x, "class")})
    d = getattr_(x, "dim")
    if d is not NULL and len(d.v) == 1:
        dn = getattr_(x, "dimnames")
        attrs = {"dim": d}
        if dn is not NULL:
            nd = RList([mk_chr(dn.v[0].v[::-1])], copy_attrs(dn.attrs))
            attrs["dimnames"] = nd
        if getattr_(x, "class") is not NULL:
            attrs["class"] = getattr_(x, "class")
    if isinstance(x, RList):
        return RList(x.v[::-1], attrs)
    return Vec(x.type, x.v[::-1], attrs)


@builtin("length")
def _length(args, env):
    x = args[0][1]
    if is_df(x):
        return mk_int([len(x.v)])
    if isinstance(x, (Vec, RList)):
        return mk_int([len(x.v)])
    if isinstance(x, Call):
        return mk_int([1 + len(x.args)])
    if x is NULL:
        return mk_int([0])
    return mk_int([1])


@builtin("length<-")
def _length_set(args, env):
    x, n = args[0][1], int1(args[-1][1])
    v = x.v[:n] + [None] * max(0, n - len(x.v))
    return Vec(x.type, v) if isinstance(x, Vec) else RList(v)


# ---------------------------------------------------------------- attributes

@builtin("names")
def _names(args, env):
    x = args[0][1]
    d = getattr_(x, "dim")
    if d is not NULL and len(d.v) == 1:
        dn = getattr_(x, "dimnames")
        return dn.v[0] if dn is not NULL else NULL
    return getattr_(x, "names")


@builtin("names<-")
def _names_set(args, env):
    x = shallow(args[0][1])
    v = args[-1][1]
    if v is NULL:
        setattr_(x, "names", NULL)
        return x
    nm = as_type(v, "character").v
    nm = nm + [None] * (len(x.v) - len(nm))
    setattr_(x, "names", mk_chr(nm[:len(x.v)]))
    return x


@builtin("attr")
def _attr(args, env):
    m = match_spec(args, "x, which, exact")
    return getattr_(m["x"], str1(m["which"]))


@builtin("attr<-")
def _attr_set(args, env):
    x = shallow(args[0][1])
    setattr_(x, str1(args[1][1]), args[-1][1])
    return x


@builtin("attributes")
def _attributes(args, env):
    x = args[0][1]
    a = getattr(x, "attrs", None)
    if not a:
        return NULL
    keys = [k for k in a if k != ".Environment"]
    return RList([a[k] for k in keys], {"names": mk_chr(keys)})


@builtin("structure")
def _structure(args, env):
    x = shallow(args[0][1])
    for n, v in args[1:]:
        if n == ".Names":
            n = "names"
        setattr_(x, n, v)
    return x


@builtin("class")
def _class(args, env):
    return mk_chr(classes(args[0][1]) if not (isinstance(args[0][1], Vec) and getattr_(args[0][1], "dim") is not NULL and len(getattr_(args[0][1], "dim").v) == 2 and getattr_(args[0][1], "class") is NULL) else ["matrix", "array"])


@builtin("oldClass")
def _oldclass(args, env):
    return getattr_(args[0][1], "class")


@builtin("class<-|oldClass<-")
def _class_set(args, env):
    x = shallow(args[0][1])
    v = args[-1][1]
    setattr_(x, "class", v if v is NULL else as_type(v, "character"))
    return x


@builtin("unclass")
def _unclass(args, env):
    x = shallow(args[0][1])
    if hasattr(x, "attrs"):
        setattr_(x, "class", NULL)
    return x


@builtin("inherits")
def _inherits(args, env):
    m = match_spec(args, "x, what, which")
    cl = classes(m["x"])
    return mk_lgl([any(w in cl for w in as_type(m["what"], "character").v)])


@builtin("levels")
def _levels(args, env):
    return getattr_(args[0][1], "levels")


@builtin("levels<-")
def _levels_set(args, env):
    x = shallow(args[0][1])
    setattr_(x, "levels", as_type(args[-1][1], "character"))
    return x


@builtin("nlevels")
def _nlevels(args, env):
    return mk_int([vlen(getattr_(args[0][1], "levels"))])


@builtin("dim")
def _dim(args, env):
    x = args[0][1]
    if is_df(x):
        return mk_int([F.df_nrow(x), len(x.v)])
    return getattr_(x, "dim")


@builtin("dim<-")
def _dim_set(args, env):
    x = shallow(args[0][1])
    v = args[-1][1]
    setattr_(x, "dim", v if v is NULL else as_type(v, "integer"))
    setattr_(x, "names", NULL)
    return x


def nrow_of(x):
    if is_df(x):
        return F.df_nrow(x)
    d = getattr_(x, "dim")
    return NULL if d is NULL else mk_int([d.v[0]])


@builtin("nrow")
def _nrow(args, env):
    x = args[0][1]
    if is_df(x):
        return mk_int([F.df_nrow(x)])
    d = getattr_(x, "dim")
    return NULL if d is NULL else mk_int([d.v[0]])


@builtin("ncol")
def _ncol(args, env):
    x = args[0][1]
    if is_df(x):
        return mk_int([len(x.v)])
    d = getattr_(x, "dim")
    return NULL if d is NULL else mk_int([d.v[1]])


@builtin("NROW")
def _NROW(args, env):
    x = args[0][1]
    r = _nrow(args, env)
    return r if r is not NULL else mk_int([vlen(x)])


@builtin("NCOL")
def _NCOL(args, env):
    r = _ncol(args, env)
    return r if r is not NULL else mk_int([1])


@builtin("dimnames")
def _dimnames(args, env):
    x = args[0][1]
    if is_df(x):
        return RList([mk_chr(F.df_rownames(x)), getattr_(x, "names")])
    return getattr_(x, "dimnames")


@builtin("dimnames<-")
def _dimnames_set(args, env):
    x = shallow(args[0][1])
    setattr_(x, "dimnames", args[-1][1])
    return x


@builtin("rownames|row.names")
def _rownames(args, env):
    x = args[0][1]
    if is_df(x):
        return mk_chr(F.df_rownames(x))
    dn = getattr_(x, "dimnames")
    return NULL if dn is NULL else dn.v[0]


@builtin("colnames")
def _colnames(args, env):
    x = args[0][1]
    if is_df(x):
        return getattr_(x, "names")
    dn = getattr_(x, "dimnames")
    return NULL if dn is NULL else dn.v[1]


@builtin("rownames<-|row.names<-")
def _rownames_set(args, env):
    x = shallow(args[0][1])
    v = args[-1][1]
    if is_df(x):
        setattr_(x, "row.names", as_type(v, "character") if v is not NULL else mk_int(list(range(1, F.df_nrow(x) + 1))))
        return x
    dn = getattr_(x, "dimnames")
    cols = dn.v[1] if dn is not NULL else NULL
    setattr_(x, "dimnames", RList([v if v is NULL else as_type(v, "character"), cols]))
    return x


@builtin("colnames<-")
def _colnames_set(args, env):
    x = shallow(args[0][1])
    v = args[-1][1]
    if is_df(x):
        setattr_(x, "names", as_type(v, "character"))
        return x
    dn = getattr_(x, "dimnames")
    rows = dn.v[0] if dn is not NULL else NULL
    setattr_(x, "dimnames", RList([rows, v if v is NULL else as_type(v, "character")]))
    return x


# ---------------------------------------------------------------- indexing

def resolve(idx, n, names, allow_extend=False):
    """Positions (0-based; None = NA; >= n = beyond the end) for an index vector, and new names."""
    if idx is MISSING:
        return list(range(n)), None
    if idx is NULL:
        return [], None
    if is_factor(idx):
        idx = as_type(idx, "character")
    if not isinstance(idx, Vec):
        raise RError("invalid subscript type '%s'" % idx.type)
    t = idx.type
    if t == "logical":
        L = max(n, len(idx.v))
        if not idx.v:
            return [], None
        out = []
        for i in range(L):
            e = idx.v[i % len(idx.v)]
            if e is None:
                out.append(None)
            elif e:
                out.append(i)
        return out, None
    if t == "character":
        out, new = [], []
        nm = names or []
        extra = []
        for s in idx.v:
            if s is not None and s in nm:
                out.append(nm.index(s))
            elif allow_extend:
                if s in extra:
                    out.append(n + extra.index(s))
                else:
                    extra.append(s)
                    out.append(n + len(extra) - 1)
            else:
                out.append(None)
        return out, extra
    v = as_double(idx).v
    pos = [e for e in v if e is not None and e > 0]
    neg = [e for e in v if e is not None and e < 0]
    if neg and (pos or any(e is None for e in v)):
        raise RError("can't mix positive and negative subscripts" if pos else "can't mix NAs and negative subscripts")
    if neg:
        drop = set(int(-e) - 1 for e in neg)
        return [i for i in range(n) if i not in drop], None
    out = []
    for e in v:
        if e is None:
            out.append(None)
        elif e >= 1:
            out.append(int(e) - 1)
    return out, None


def subset_vec(x, idx):
    n = len(x.v)
    nm = names_of(x)
    pos, _ = resolve(idx, n, nm)
    na = None
    vals = [na if (p is None or p >= n) else x.v[p] for p in pos]
    attrs = {}
    if nm is not None:
        attrs["names"] = mk_chr([("<NA>" if x.type != "list" else "<NA>") if p is None else (nm[p] if p < n else "<NA>") for p in pos])
        if isinstance(idx, Vec) and idx.type in ("integer", "double", "logical"):
            attrs["names"] = mk_chr([(nm[p] if p is not None and p < n else ("<NA>" if p is not None or True else "")) for p in pos])
    if is_factor(x):
        attrs["levels"] = getattr_(x, "levels")
        attrs["class"] = getattr_(x, "class")
    elif C.inherits(x, "Date"):
        attrs["class"] = getattr_(x, "class")
    if isinstance(x, RList):
        return RList([NULL if v is None else v for v in vals], attrs or None)
    return Vec(x.type, vals, attrs or None)


def drop_dims(x):
    return Vec(x.type, x.v) if isinstance(x, Vec) else x


def subset_matrix(x, i, j, drop=True):
    nr, nc = getattr_(x, "dim").v
    dn = getattr_(x, "dimnames")
    rn = dn.v[0].v if dn is not NULL and dn.v[0] is not NULL else None
    cn = dn.v[1].v if dn is not NULL and dn.v[1] is not NULL else None
    ri, _ = resolve(i, nr, rn)
    ci, _ = resolve(j, nc, cn)
    for p in ri + ci:
        if p is None:
            continue
    if any(p is not None and p >= nr for p in ri) or any(p is not None and p >= nc for p in ci):
        raise RError("subscript out of bounds")
    vals = [x.v[c * nr + r] for c in ci for r in ri]
    if drop and (len(ri) == 1 or len(ci) == 1):
        res = Vec(x.type, vals)
        if len(ci) == 1 and len(ri) > 1 and rn is not None:
            res.attrs = {"names": mk_chr([rn[r] for r in ri])}
        elif len(ri) == 1 and len(ci) > 1 and cn is not None:
            res.attrs = {"names": mk_chr([cn[c] for c in ci])}
        return res
    attrs = {"dim": mk_int([len(ri), len(ci)])}
    if dn is not NULL:
        attrs["dimnames"] = RList([mk_chr([rn[r] for r in ri]) if rn else NULL, mk_chr([cn[c] for c in ci]) if cn else NULL])
    return Vec(x.type, vals, attrs)


def df_new(cols, names, rownames=None):
    n = len(cols[0].v) if cols else 0
    attrs = {"names": mk_chr(names), "class": mk_chr(["data.frame"])}
    attrs["row.names"] = mk_chr(rownames) if rownames is not None else mk_int(list(range(1, n + 1)))
    return RList(cols, attrs)


def subset_df(df, i, j, drop=None):
    names = names_of(df)
    nrow = F.df_nrow(df)
    if j is MISSING and i is not MISSING and drop is None and getattr(i, "_single", False):
        pass
    ci, _ = resolve(j, len(names), names)
    if any(c is None or c >= len(names) for c in ci):
        raise RError("undefined columns selected")
    rnames = F.df_rownames(df)
    rn_is_int = getattr_(df, "row.names").type == "integer"
    if i is MISSING:
        ri = list(range(nrow))
    else:
        if isinstance(i, Vec) and i.type == "character":
            ri, _ = resolve(i, nrow, rnames)
        else:
            ri, _ = resolve(i, nrow, None)
    cols = []
    for c in ci:
        col = df.v[c]
        cols.append(subset_vec(col, mk_int([None if r is None else r + 1 for r in ri])) if i is not MISSING else col)
    if (drop is None and len(ci) == 1 and j is not MISSING) or drop is True and len(ci) == 1:
        col = cols[0]
        if isinstance(col, Vec) and col.attrs and "names" in col.attrs and not is_factor(col):
            col = Vec(col.type, col.v)
        return col
    newrn = [rnames[r] if r is not None else "NA" for r in ri]
    res = df_new(cols, [names[c] for c in ci])
    if i is not MISSING:
        if rn_is_int and newrn == [str(k + 1) for k in range(len(newrn))]:
            pass
        elif rn_is_int:
            res.attrs["row.names"] = mk_int([int(s) if s != "NA" else None for s in newrn])
        else:
            res.attrs["row.names"] = mk_chr(newrn)
    elif not rn_is_int:
        res.attrs["row.names"] = getattr_(df, "row.names")
    return res


@builtin("[", special=True)
def _subset(call, env):
    x = C.force(C.ev(call.args[0][1], env))
    rest = []
    drop = None
    for n, a in call.args[1:]:
        if n == "drop":
            drop = C.as_logical1(C.force(C.ev(a, env)))
            continue
        if n == "exact":
            continue
        if isinstance(a, Sym) and a.name == "...":
            rest.extend(C.force(p) for _, p in C.dots(env))
        else:
            rest.append(MISSING if a is MISSING else C.force(C.ev(a, env)))
    C.STATE["visible"] = True
    for cls in classes(x):
        f = C.S3_lookup("[", cls, env)
        if f is not None and isinstance(f, Closure):
            return C.call_fun(f, [(None, x)] + [(None, r) for r in rest], env)
    return do_subset(x, rest, drop)


def do_subset(x, rest, drop=None):
    if x is NULL:
        return NULL
    if is_df(x):
        if len(rest) == 1:
            return subset_df(x, MISSING, rest[0], drop=False)
        return subset_df(x, rest[0], rest[1], drop)
    d = getattr_(x, "dim")
    if len(rest) == 2:
        if d is NULL or len(d.v) != 2:
            raise RError("incorrect number of dimensions")
        return subset_matrix(x, rest[0], rest[1], drop if drop is not None else True)
    if not rest:
        return x
    if d is not NULL and len(d.v) == 1:
        dn = getattr_(x, "dimnames")
        nm = dn.v[0].v if dn is not NULL and dn.v[0] is not NULL else None
        pos, _ = resolve(rest[0], len(x.v), nm)
        attrs = {"dim": mk_int([len(pos)])}
        if nm is not None:
            nd = RList([mk_chr([nm[p] for p in pos])], copy_attrs(dn.attrs))
            attrs["dimnames"] = nd
        if getattr_(x, "class") is not NULL:
            attrs["class"] = getattr_(x, "class")
        return Vec(x.type, [x.v[p] for p in pos], attrs)
    if isinstance(x, (Vec, RList)):
        return subset_vec(x, rest[0])
    raise RError("object of type '%s' is not subsettable" % x.type)


def get2(x, i, exact=True):
    if is_df(x) or isinstance(x, RList):
        nm = names_of(x)
        if isinstance(i, Vec) and i.type == "character":
            s = i.v[0]
            if nm is None or s not in nm:
                if is_df(x) or isinstance(x, RList):
                    return NULL
            return x.v[nm.index(s)]
        k = int1(i)
        if k < 1 or k > len(x.v):
            raise RError("subscript out of bounds")
        return x.v[k - 1]
    if isinstance(x, Vec):
        if isinstance(i, Vec) and i.type == "character":
            nm = names_of(x)
            if nm is None or i.v[0] not in nm:
                raise RError("subscript out of bounds")
            k = nm.index(i.v[0])
        else:
            k = int1(i) - 1
        if k < 0 or k >= len(x.v):
            raise RError("subscript out of bounds")
        if is_factor(x):
            return Vec("integer", [x.v[k]], {"levels": getattr_(x, "levels"), "class": getattr_(x, "class")})
        return Vec(x.type, [x.v[k]])
    if x is NULL:
        return NULL
    raise RError("object of type '%s' is not subsettable" % x.type)


@builtin("[[")
def _subset2(args, env):
    x = args[0][1]
    idx = [v for n, v in args[1:] if n != "exact"]
    if is_df(x) and len(idx) == 2:
        col = get2(x, idx[1])
        return get2(col, idx[0])
    if isinstance(x, Vec) and getattr_(x, "dim") is not NULL and len(idx) == 2:
        return subset_matrix(x, idx[0], idx[1])
    return get2(x, idx[0])


@builtin("$", special=True)
def _dollar(call, env):
    x = C.force(C.ev(call.args[0][1], env))
    nm = call.args[1][1].name
    C.STATE["visible"] = True
    return dollar(x, nm)


def dollar(x, nm):
    if isinstance(x, RList):
        names = names_of(x) or []
        if nm in names:
            return x.v[names.index(nm)]
        c = [k for k, s in enumerate(names) if s.startswith(nm)]
        if len(c) == 1:
            return x.v[c[0]]
        return NULL
    if isinstance(x, C.Env):
        return C.force(x.vars.get(nm, NULL))
    if x is NULL:
        return NULL
    raise RError("$ operator is invalid for atomic vectors")


def assign_vec(x, idx, value):
    """x[idx] <- value for vectors and lists (copy on modify)."""
    if x is NULL:
        x = Vec("logical", []) if not isinstance(value, RList) else RList([])
    n = len(x.v)
    pos, extra = resolve(idx, n, names_of(x), allow_extend=True)
    if is_factor(x):
        lv = getattr_(x, "levels").v
        vv = as_type(value, "character").v if isinstance(value, Vec) else []
        codes = []
        for s in vv:
            if s is None:
                codes.append(None)
            elif s in lv:
                codes.append(lv.index(s) + 1)
            else:
                warn("invalid factor level, NA generated")
                codes.append(None)
        value = Vec("integer", codes)
        res = Vec("integer", list(x.v), copy_attrs(x.attrs))
    elif isinstance(x, RList) or isinstance(value, RList):
        res = RList(list(x.v) if isinstance(x, RList) else [Vec(x.type, [e]) for e in x.v], copy_attrs(x.attrs))
        if isinstance(value, Vec):
            value = RList([Vec(value.type, [e]) for e in value.v])
        elif value is NULL:
            keep = [k for k in range(n) if k not in set(p for p in pos if p is not None)]
            nm = names_of(res)
            out = RList([res.v[k] for k in keep], copy_attrs(res.attrs))
            if nm is not None:
                setattr_(out, "names", mk_chr([nm[k] for k in keep]))
            return out
    else:
        t = rtype(x, value)
        res = Vec(t, list(as_type(x, t).v), copy_attrs(x.attrs))
        value = as_type(value, t)
    vals = value.v
    if not vals and pos:
        raise RError("replacement has length zero")
    if pos and len(pos) % len(vals):
        warn("number of items to replace is not a multiple of replacement length")
    mx = max([p for p in pos if p is not None] + [n - 1])
    fill = NULL if isinstance(res, RList) else None
    if mx >= n:
        res.v.extend([fill] * (mx + 1 - n))
        nm = names_of(res)
        if nm is not None or extra:
            nm = list(nm or [""] * n) + [""] * (mx + 1 - n)
            for k, s in enumerate(extra or []):
                nm[n + k] = s
            setattr_(res, "names", mk_chr(nm))
    for k, p in enumerate(pos):
        if p is None:
            continue
        res.v[p] = vals[k % len(vals)]
    return res


def assign_matrix(x, i, j, value):
    nr, nc = getattr_(x, "dim").v
    dn = getattr_(x, "dimnames")
    rn = dn.v[0].v if dn is not NULL and dn.v[0] is not NULL else None
    cn = dn.v[1].v if dn is not NULL and dn.v[1] is not NULL else None
    ri, _ = resolve(i, nr, rn)
    ci, _ = resolve(j, nc, cn)
    t = rtype(x, value)
    res = Vec(t, list(as_type(x, t).v), copy_attrs(x.attrs))
    vals = as_type(value, t).v
    k = 0
    for c in ci:
        for r in ri:
            res.v[c * nr + r] = vals[k % len(vals)]
            k += 1
    return res


def df_set_col(df, name_or_pos, value):
    names = list(names_of(df))
    cols = list(df.v)
    n = F.df_nrow(df)
    if isinstance(name_or_pos, str):
        k = names.index(name_or_pos) if name_or_pos in names else None
    else:
        k = name_or_pos
    if value is NULL:
        if k is not None:
            del cols[k]
            del names[k]
    else:
        if len(value.v) != n and n > 0:
            if n % len(value.v):
                raise RError("replacement has %d rows, data has %d" % (len(value.v), n))
            value = do_rep(value, n)
        if k is None:
            cols.append(value)
            names.append(name_or_pos)
        else:
            cols[k] = value
    res = RList(cols, copy_attrs(df.attrs))
    res.attrs["names"] = mk_chr(names)
    return res


def do_rep(v, n):
    return Vec(v.type, [v.v[i % len(v.v)] for i in range(n)], {k: a for k, a in (v.attrs or {}).items() if k in ("levels", "class")} or None)


@builtin("[<-")
def _subassign(args, env):
    x = args[0][1]
    value = args[-1][1]
    idx = [v for n, v in args[1:-1]]
    if is_df(x):
        if len(idx) == 1:
            nm = str1(idx[0]) if idx[0].type == "character" else int1(idx[0]) - 1
            return df_set_col(x, nm, value)
        i, j = idx
        names = names_of(x)
        cpos, _ = resolve(j, len(names), names, allow_extend=True) if j is not MISSING else (list(range(len(names))), None)
        res = x
        for c in cpos:
            col = x.v[c] if c < len(names) else Vec("logical", [None] * F.df_nrow(x))
            newcol = assign_vec(col, i, value) if i is not MISSING else do_rep(value, F.df_nrow(x))
            res = df_set_col(res, c if c < len(names) else str1(j), newcol)
        return res
    if len(idx) == 2:
        return assign_matrix(x, idx[0], idx[1], value)
    return assign_vec(x, idx[0], value)


@builtin("[[<-")
def _subassign2(args, env):
    x = args[0][1]
    value = args[-1][1]
    i = args[1][1]
    if is_df(x):
        return df_set_col(x, str1(i) if i.type == "character" else int1(i) - 1, value)
    if isinstance(x, RList) or isinstance(value, (RList, Closure)) or (isinstance(value, Vec) and len(value.v) != 1) or x is NULL and not isinstance(value, Vec):
        if x is NULL:
            x = RList([])
        if isinstance(x, Vec):
            x = RList([Vec(x.type, [e]) for e in x.v], copy_attrs(x.attrs))
        n = len(x.v)
        names = names_of(x)
        if isinstance(i, Vec) and i.type == "character":
            s = i.v[0]
            k = names.index(s) if names and s in names else None
        else:
            k = int1(i) - 1
            s = None
        res = RList(list(x.v), copy_attrs(x.attrs))
        if value is NULL:
            if k is not None and k < n:
                del res.v[k]
                if names:
                    setattr_(res, "names", mk_chr(names[:k] + names[k + 1:]))
            return res
        if k is None:
            res.v.append(value)
            setattr_(res, "names", mk_chr(list(names or [""] * n) + [s]))
        else:
            while k >= len(res.v):
                res.v.append(NULL)
            res.v[k] = value
        return res
    return assign_vec(x, i, value)


@builtin("$<-")
def _dollar_assign(args, env):
    x = args[0][1]
    nm = str1(args[1][1])
    value = args[-1][1]
    if is_df(x):
        return df_set_col(x, nm, value)
    if isinstance(x, Vec) and x.v:
        raise RError("$ operator is invalid for atomic vectors")
    return _subassign2([(None, x if x is not NULL else RList([])), (None, mk_chr([nm])), ("value", value)], env)


# ---------------------------------------------------------------- vectors

@builtin("is.na")
def _isna(args, env):
    x = args[0][1]
    if isinstance(x, RList):
        return mk_lgl([isinstance(e, Vec) and len(e.v) == 1 and (e.v[0] is None or (isinstance(e.v[0], float) and math.isnan(e.v[0]))) for e in x.v])
    if x is NULL:
        return mk_lgl([])
    res = [e is None or (isinstance(e, float) and math.isnan(e)) for e in x.v]
    return keep_struct(Vec("logical", res), x)


@builtin("is.nan")
def _isnan(args, env):
    x = args[0][1]
    return keep_struct(Vec("logical", [isinstance(e, float) and math.isnan(e) for e in x.v]), x)


@builtin("is.finite")
def _isfinite(args, env):
    x = args[0][1]
    return keep_struct(Vec("logical", [e is not None and not (isinstance(e, float) and (math.isnan(e) or math.isinf(e))) and x.type != "character" for e in x.v]), x)


@builtin("is.infinite")
def _isinfinite(args, env):
    x = args[0][1]
    return keep_struct(Vec("logical", [isinstance(e, float) and math.isinf(e) for e in x.v]), x)


@builtin("ifelse")
def _ifelse(args, env):
    m = match_spec(args, "test, yes, no")
    test = as_type(m["test"], "logical")
    yes, no = m["yes"], m["no"]
    n = len(test.v)
    used = []
    if any(e is True for e in test.v):
        used.append(yes)
    if any(e is False for e in test.v):
        used.append(no)
    t = rtype(Vec("logical", []), *used) if used else "logical"
    yv = as_type(yes, t).v if yes in used else []
    nv = as_type(no, t).v if no in used else []
    res = []
    for i, e in enumerate(test.v):
        if e is None:
            res.append(None)
        elif e:
            res.append(yv[i % len(yv)])
        else:
            res.append(nv[i % len(nv)])
    out = Vec(t, res)
    for k in ("names", "dim", "dimnames"):
        if getattr_(m["test"], k) is not NULL:
            setattr_(out, k, getattr_(m["test"], k))
    return out


@builtin("which")
def _which(args, env):
    x = args[0][1]
    nm = names_of(x)
    idx = [i for i, e in enumerate(x.v) if e is True]
    r = mk_int([i + 1 for i in idx])
    if nm is not None:
        r.attrs = {"names": mk_chr([nm[i] for i in idx])}
    return r


def which_ext(args, best):
    x = args[0][1]
    v = as_double(x).v
    k = None
    for i, e in enumerate(v):
        if e is None or math.isnan(e):
            continue
        if k is None or (e > v[k] if best > 0 else e < v[k]):
            k = i
    if k is None:
        return mk_int([])
    r = mk_int([k + 1])
    nm = names_of(x)
    if nm is None and getattr_(x, "dim") is not NULL and len(getattr_(x, "dim").v) == 1 and getattr_(x, "dimnames") is not NULL:
        nm = getattr_(x, "dimnames").v[0].v
    if nm is not None:
        r.attrs = {"names": mk_chr([nm[k]])}
    return r


builtin("which.max")(lambda args, env: which_ext(args, 1))
builtin("which.min")(lambda args, env: which_ext(args, -1))


def sort_key_for(x):
    if x.type == "character":
        return str_key
    return lambda e: e


@builtin("sort")
def _sort(args, env):
    m = match_spec(args, "x, decreasing, na.last, ...")
    x = m["x"]
    dec = C.as_logical1(m["decreasing"]) if "decreasing" in m else False
    if is_factor(x):
        codes = sorted([e for e in x.v if e is not None], reverse=dec)
        return Vec("integer", codes, copy_attrs({k: v for k, v in x.attrs.items() if k in ("levels", "class")}))
    nm = names_of(x)
    items = [(e, i) for i, e in enumerate(x.v) if e is not None and not (isinstance(e, float) and math.isnan(e))]
    key = sort_key_for(x)
    items.sort(key=lambda p: key(p[0]), reverse=dec)
    res = Vec(x.type, [e for e, i in items])
    if nm is not None:
        res.attrs = {"names": mk_chr([nm[i] for e, i in items])}
    if getattr_(x, "dim") is not NULL and len(getattr_(x, "dim").v) == 1:
        dn = getattr_(x, "dimnames")
        res.attrs = {"dim": mk_int([len(items)]), "dimnames": RList([mk_chr([dn.v[0].v[i] for e, i in items])], copy_attrs(dn.attrs))}
        if getattr_(x, "class") is not NULL:
            res.attrs["class"] = getattr_(x, "class")
    return res


@builtin("order")
def _order(args, env):
    keys = [v for n, v in args if n is None]
    dec = False
    for n, v in args:
        if n == "decreasing":
            dec = C.as_logical1(v)
    n = len(keys[0].v)
    cols = []
    for k in keys:
        if is_factor(k):
            cols.append((Vec("integer", k.v), lambda e: e))
        else:
            cols.append((k, sort_key_for(k)))

    def kf(i):
        out = []
        for k, f in cols:
            e = k.v[i]
            out.append((1, 0) if e is None else (0, f(e)))
        return out
    idx = list(range(n))
    if dec:
        nonna = [i for i in idx if cols[0][0].v[i] is not None]
        na = [i for i in idx if cols[0][0].v[i] is None]
        nonna.sort(key=kf, reverse=True)
        # stable for ties under reverse: re-sort ties by index
        res = sorted(nonna, key=lambda i: (tuple(_neg(x) for x in kf(i)), i))
        return mk_int([i + 1 for i in res + na])
    idx.sort(key=kf)
    return mk_int([i + 1 for i in idx])


def _neg(x):
    flag, v = x
    if isinstance(v, (int, float)):
        return (flag, -v)
    return (flag, tuple(-ord(c) for c in v[0]) if isinstance(v, tuple) else v)


@builtin("rank")
def _rank(args, env):
    x = as_double(args[0][1]).v
    order = sorted(range(len(x)), key=lambda i: x[i])
    r = [0.0] * len(x)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and x[order[j + 1]] == x[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return mk_dbl(r)


@builtin("unique")
def _unique(args, env):
    x = args[0][1]
    if is_df(x):
        return x
    seen = []
    keys = set()
    for e in x.v:
        k = e if not isinstance(e, float) or not math.isnan(e) else "NaN"
        if isinstance(x, RList):
            k = id(e)
        if k not in keys:
            keys.add(k)
            seen.append(e)
    if is_factor(x):
        return Vec("integer", seen, {"levels": getattr_(x, "levels"), "class": getattr_(x, "class")})
    if isinstance(x, RList):
        return RList(seen)
    return Vec(x.type, seen)


@builtin("duplicated")
def _duplicated(args, env):
    x = args[0][1]
    keys = set()
    res = []
    for e in x.v:
        res.append(e in keys)
        keys.add(e)
    return mk_lgl(res)


@builtin("match")
def _match(args, env):
    m = match_spec(args, "x, table, nomatch, incomparables")
    x, t = m["x"], m["table"]
    if is_factor(x):
        x = as_type(x, "character")
    if is_factor(t):
        t = as_type(t, "character")
    ty = rtype(x, t)
    xv, tv = as_type(x, ty).v, as_type(t, ty).v
    pos = {}
    for i, e in enumerate(tv):
        pos.setdefault(e, i + 1)
    nomatch = int1(m["nomatch"]) if "nomatch" in m else None
    return mk_int([pos.get(e, nomatch) for e in xv])


@builtin("%in%")
def _in(args, env):
    r = _match([(None, args[0][1]), (None, args[1][1]), ("nomatch", mk_int([0]))], env)
    return mk_lgl([e > 0 for e in r.v])


builtin("is.element")(lambda args, env: _in(args, env))


@builtin("setdiff")
def _setdiff(args, env):
    x, y = args[0][1], args[1][1]
    t = rtype(x, y)
    yv = set(as_type(y, t).v)
    out = []
    for e in as_type(x, t).v:
        if e not in yv and e not in out:
            out.append(e)
    return Vec(t, out)


@builtin("union")
def _union(args, env):
    x, y = args[0][1], args[1][1]
    t = rtype(x, y)
    out = []
    for e in as_type(x, t).v + as_type(y, t).v:
        if e not in out:
            out.append(e)
    return Vec(t, out)


@builtin("intersect")
def _intersect(args, env):
    x, y = args[0][1], args[1][1]
    t = rtype(x, y)
    yv = as_type(y, t).v
    out = []
    for e in as_type(x, t).v:
        if e in yv and e not in out:
            out.append(e)
    return Vec(t, out)


@builtin("head")
def _head(args, env):
    m = match_spec(args, "x, n, ...")
    x = m["x"]
    n = int1(m["n"]) if "n" in m else 6
    if is_df(x):
        N = F.df_nrow(x)
        k = min(n, N) if n >= 0 else max(0, N + n)
        return subset_df(x, mk_int(list(range(1, k + 1))), MISSING)
    N = len(x.v)
    k = min(n, N) if n >= 0 else max(0, N + n)
    return subset_vec(x, mk_int(list(range(1, k + 1))))


@builtin("tail")
def _tail(args, env):
    m = match_spec(args, "x, n, ...")
    x = m["x"]
    n = int1(m["n"]) if "n" in m else 6
    if is_df(x):
        N = F.df_nrow(x)
        k = min(n, N) if n >= 0 else max(0, N + n)
        return subset_df(x, mk_int(list(range(N - k + 1, N + 1))), MISSING)
    N = len(x.v)
    k = min(n, N) if n >= 0 else max(0, N + n)
    return subset_vec(x, mk_int(list(range(N - k + 1, N + 1))))


@builtin("append")
def _append(args, env):
    m = match_spec(args, "x, values, after")
    x, v = m["x"], m["values"]
    after = int1(m["after"]) if "after" in m else vlen(x)
    a = combine([(None, subset_vec(x, mk_int(list(range(1, after + 1))))), (None, v),
                 (None, subset_vec(x, mk_int(list(range(after + 1, vlen(x) + 1)))))])
    return a


@builtin("diff")
def _diff(args, env):
    m = match_spec(args, "x, lag, differences, ...")
    x = m["x"]
    lag = int1(m["lag"]) if "lag" in m else 1
    t = "integer" if x.type in ("integer", "logical") else "double"
    v = as_type(x, t).v
    return Vec(t, [None if v[i + lag] is None or v[i] is None else v[i + lag] - v[i] for i in range(len(v) - lag)])


@builtin("prop.table|proportions")
def _proptable(args, env):
    x = args[0][1]
    v = as_double(x).v
    t = math.fsum(v)
    return Vec("double", [e / t for e in v], copy_attrs(x.attrs))


@builtin("complete.cases")
def _complete(args, env):
    cols = []
    for n, v in args:
        cols.extend(v.v if is_df(v) else [v])
    n = len(cols[0].v)
    return mk_lgl([all(c.v[i] is not None and not (isinstance(c.v[i], float) and math.isnan(c.v[i])) for c in cols) for i in range(n)])


@builtin("tabulate")
def _tabulate(args, env):
    m = match_spec(args, "bin, nbins")
    v = as_type(m["bin"], "integer").v
    nb = int1(m["nbins"]) if "nbins" in m else max([1] + [e for e in v if e is not None])
    res = [0] * nb
    for e in v:
        if e is not None and 1 <= e <= nb:
            res[e - 1] += 1
    return mk_int(res)


# ---------------------------------------------------------------- types

PRIMITIVES = set("c sum prod max min range length names dim attr class oldClass levels is.na is.null is.function "
                 "abs sqrt exp floor ceiling trunc round signif log cos sin tan cumsum cumprod cummax cummin "
                 "list unlist rep seq_len seq_along invisible as.numeric as.double as.integer as.character "
                 "as.logical any all xor ! & | + - * / ^ %% %/% == != < > <= >= : [ [[ $ <- = { ( if for while "
                 "repeat function return quote missing nargs UseMethod switch interactive".split())


@builtin("typeof")
def _typeof(args, env):
    x = args[0][1]
    if x is NULL:
        return mk_chr(["NULL"])
    if isinstance(x, Builtin):
        return mk_chr(["builtin" if x.name in PRIMITIVES else "closure"])
    return mk_chr([x.type])


@builtin("mode")
def _mode(args, env):
    x = args[0][1]
    t = x.type if x is not NULL else "NULL"
    return mk_chr([{"double": "numeric", "integer": "numeric", "closure": "function", "builtin": "function", "symbol": "name", "language": "call"}.get(t, t)])


def is_type(pred):
    return lambda args, env: mk_lgl([bool(pred(args[0][1]))])


builtin("is.numeric")(is_type(lambda x: isinstance(x, Vec) and x.type in ("integer", "double") and not is_factor(x)))
builtin("is.double")(is_type(lambda x: isinstance(x, Vec) and x.type == "double"))
builtin("is.integer")(is_type(lambda x: isinstance(x, Vec) and x.type == "integer" and not is_factor(x)))
builtin("is.character")(is_type(lambda x: isinstance(x, Vec) and x.type == "character"))
builtin("is.logical")(is_type(lambda x: isinstance(x, Vec) and x.type == "logical"))
builtin("is.function")(is_type(lambda x: isinstance(x, (Closure, Builtin))))
builtin("is.null")(is_type(lambda x: x is NULL))
builtin("is.list")(is_type(lambda x: isinstance(x, RList)))
builtin("is.data.frame")(is_type(is_df))
builtin("is.factor")(is_type(is_factor))
builtin("is.matrix")(is_type(lambda x: getattr_(x, "dim") is not NULL and len(getattr_(x, "dim").v) == 2))
builtin("is.vector")(is_type(lambda x: isinstance(x, (Vec, RList)) and not (x.attrs and any(k != "names" for k in x.attrs))))
builtin("is.atomic")(is_type(lambda x: isinstance(x, Vec)))


def as_fn(t):
    def fn(args, env):
        x = args[0][1]
        if x is NULL:
            return Vec(t, [])
        if is_factor(x) and t != "character":
            return Vec(t, as_type(Vec("integer", x.v), t).v)
        r = as_type(x, t)
        if r is x:
            r = Vec(t, x.v)
        return r
    return fn


builtin("as.numeric|as.double")(as_fn("double"))
builtin("as.integer")(as_fn("integer"))
builtin("as.character")(as_fn("character"))
builtin("as.logical")(as_fn("logical"))


@builtin("as.vector")
def _asvector(args, env):
    m = match_spec(args, "x, mode")
    x = m["x"]
    mode = str1(m["mode"]) if "mode" in m else "any"
    if is_factor(x):
        return as_type(x, "character")
    if mode == "list":
        return _aslist([(None, x)], env)
    if isinstance(x, Vec):
        if mode in ("numeric", "double"):
            return Vec("double", as_double(x).v)
        return Vec(x.type, x.v, {"names": getattr_(x, "names")} if names_of(x) and getattr_(x, "dim") is NULL else None)
    return x


@builtin("as.list")
def _aslist(args, env):
    x = args[0][1]
    if isinstance(x, RList):
        return RList(list(x.v), {"names": getattr_(x, "names")} if names_of(x) else None)
    if isinstance(x, C.Env):
        keys = sorted(x.vars)
        return RList([C.force(x.vars[k]) for k in keys], {"names": mk_chr(keys)})
    vals = [Vec(x.type, [e]) for e in x.v]
    return RList(vals, {"names": getattr_(x, "names")} if names_of(x) else None)


@builtin("identical")
def _identical(args, env):
    return mk_lgl([identical(args[0][1], args[1][1])])


def identical(a, b):
    if type(a) is not type(b):
        return False
    if a is NULL:
        return True
    if isinstance(a, Vec):
        if a.type != b.type or len(a.v) != len(b.v):
            return False
        for x, y in zip(a.v, b.v):
            if x != y and not (isinstance(x, float) and isinstance(y, float) and math.isnan(x) and math.isnan(y)):
                return False
        return attrs_identical(a, b)
    if isinstance(a, RList):
        return len(a.v) == len(b.v) and all(identical(x, y) for x, y in zip(a.v, b.v)) and attrs_identical(a, b)
    return a is b


def attrs_identical(a, b):
    ka, kb = a.attrs or {}, b.attrs or {}
    if set(ka) != set(kb):
        return False
    return all(identical(ka[k], kb[k]) for k in ka)


@builtin("all.equal")
def _allequal(args, env):
    m = match_spec(args, "target, current, tolerance, ...")
    a, b = m["target"], m["current"]
    tol = num1(m["tolerance"]) if "tolerance" in m else 1.5e-8
    if isinstance(a, Vec) and isinstance(b, Vec) and a.type in ("integer", "double") and b.type in ("integer", "double"):
        av, bv = as_double(a).v, as_double(b).v
        if len(av) != len(bv):
            return mk_chr(["Lengths (%d, %d) differ" % (len(av), len(bv))])
        num = sum(abs(x - y) for x, y in zip(av, bv))
        den = sum(abs(x) for x in av)
        d = num / den if den > 0 else num
        if d < tol:
            return mk_lgl([True])
        return mk_chr(["Mean relative difference: %s" % F.format_real([d])[0]])
    return mk_lgl([identical(a, b)])


@builtin("exists")
def _exists(args, env):
    nm = str1(args[0][1])
    return mk_lgl([env.find(nm) is not None])


@builtin("get")
def _get(args, env):
    return C.lookup(str1(args[0][1]), env)


@builtin("assign")
def _assignf(args, env):
    m = match_spec(args, "x, value, pos, envir")
    e = m.get("envir", env)
    e.vars[str1(m["x"])] = m["value"]
    C.STATE["visible"] = False
    return m["value"]


@builtin("environment")
def _environment(args, env):
    if args and isinstance(args[0][1], Closure):
        return args[0][1].env
    return env


@builtin("new.env")
def _newenv(args, env):
    return C.Env(env)


@builtin("globalenv")
def _globalenv(args, env):
    return C.GLOBAL


@builtin("nargs", special=True)
def _nargs(call, env):
    fe, fr = C.frame_of(env)
    return mk_int([len(fr.args)])


@builtin("stop")
def _stop(args, env):
    msg = "".join(cat_join(v) for n, v in args if n != "call.")
    callf = True
    for n, v in args:
        if n == "call.":
            callf = C.as_logical1(v)
    fe, fr = C.frame_of(env)
    raise RError(msg, F.deparse(fr.call) if (fr is not None and callf) else None)


def cat_join(v):
    if isinstance(v, RList) and C.inherits(v, "condition"):
        return str1(v.v[0])
    return "".join(F.cat_str(v))


@builtin("warning")
def _warning(args, env):
    msg = "".join(cat_join(v) for n, v in args if n != "call.")
    fe, fr = C.frame_of(env)
    warn(msg, F.deparse(fr.call) if fr is not None else None)
    C.STATE["visible"] = False
    return mk_chr([msg])


@builtin("message")
def _message(args, env):
    import sys
    sys.stdout.flush()
    sys.stderr.write("".join(cat_join(v) for n, v in args if n != "appendLF") + "\n")
    C.STATE["visible"] = False
    return NULL


@builtin("stopifnot", special=True)
def _stopifnot(call, env):
    for n, a in call.args:
        v = C.force(C.ev(a, env))
        if not (isinstance(v, Vec) and v.type == "logical" and all(e is True for e in v.v)):
            fe, fr = C.frame_of(env)
            raise RError("%s is not TRUE" % F.deparse(a) if len(v.v) <= 1 else "%s are not all TRUE" % F.deparse(a),
                         F.deparse(fr.call) if fr else None)
    C.STATE["visible"] = False
    return NULL


@builtin("conditionMessage")
def _condmsg(args, env):
    return args[0][1].v[0]


@builtin("Sys.time")
def _systime(args, env):
    import time
    return mk_dbl([time.time()], {"class": mk_chr(["POSIXct", "POSIXt"])})


@builtin("Sys.Date")
def _sysdate(args, env):
    import time
    return mk_dbl([float(int(time.time() // 86400))], {"class": mk_chr(["Date"])})


@builtin("as.Date")
def _asdate(args, env):
    import datetime
    x = args[0][1]
    res = []
    for s in as_type(x, "character").v:
        if s is None:
            res.append(None)
            continue
        d = datetime.date(int(s[0:4]), int(s[5:7]), int(s[8:10]))
        res.append(float((d - datetime.date(1970, 1, 1)).days))
    return mk_dbl(res, {"class": mk_chr(["Date"])})


def date_str(v):
    import datetime
    return None if v is None else (datetime.date(1970, 1, 1) + datetime.timedelta(days=int(v))).isoformat()


@method("format.Date")
def _format_date(args, env):
    return mk_chr([date_str(v) for v in args[0][1].v])


method("as.character.Date")(_format_date)


@method("print.Date")
def _print_date(args, env):
    F.print_plain(['"%s"' % date_str(v) for v in args[0][1].v], left=True)
    C.STATE["visible"] = False
    return args[0][1]


# ---------------------------------------------------------------- strings

def chr_args(v):
    if is_factor(v):
        return as_type(v, "character").v
    if isinstance(v, Vec):
        return as_type(v, "character").v
    if v is NULL:
        return []
    if isinstance(v, RList):
        return [F.deparse_value(e) if not (isinstance(e, Vec) and len(e.v) == 1) else as_type(e, "character").v[0] for e in v.v]
    raise RError("cannot coerce to character")


def paste_impl(args, sep):
    collapse = None
    parts = []
    for n, v in args:
        if n == "sep":
            sep = str1(v)
        elif n == "collapse":
            collapse = None if v is NULL else str1(v)
        else:
            parts.append(["NA" if s is None else s for s in chr_args(v)])
    parts = [p for p in parts if p]
    if not parts:
        res = []
    else:
        n = max(len(p) for p in parts)
        res = [sep.join(p[i % len(p)] for p in parts) for i in range(n)]
    if collapse is not None:
        return mk_chr([collapse.join(res)])
    return mk_chr(res)


builtin("paste")(lambda args, env: paste_impl(args, " "))
builtin("paste0")(lambda args, env: paste_impl(args, ""))


def str_map(name, f, out="character"):
    def fn(args, env):
        x = args[0][1]
        v = chr_args(x)
        r = Vec(out, [None if s is None else f(s) for s in v])
        if out == "integer" and isinstance(x, Vec) and x.type == "character":
            r.v = [2 if s is None else e for s, e in zip(v, r.v)]
        nm = getattr_(x, "names")
        if nm is not NULL:
            r.attrs = {"names": nm}
        return r
    builtin(name)(fn)


str_map("nchar", len, "integer")
str_map("toupper", lambda s: s.upper())
str_map("tolower", lambda s: s.lower())
str_map("trimws", lambda s: s.strip())


@builtin("substr")
def _substr(args, env):
    m = match_spec(args, "x, start, stop")
    v = chr_args(m["x"])
    st = as_type(m["start"], "integer").v
    sp = as_type(m["stop"], "integer").v
    return mk_chr([None if s is None else s[max(st[i % len(st)], 1) - 1:sp[i % len(sp)]] for i, s in enumerate(v)])


@builtin("substring")
def _substring(args, env):
    m = match_spec(args, "text, first, last")
    v = chr_args(m["text"])
    st = as_type(m["first"], "integer").v
    sp = as_type(m["last"], "integer").v if "last" in m else [1000000]
    n = max(len(v), len(st), len(sp))
    return mk_chr([v[i % len(v)][max(st[i % len(st)], 1) - 1:sp[i % len(sp)]] for i in range(n)])


def r_regex(pat, fixed=False, perl=False):
    import re
    if fixed:
        return re.compile(re.escape(pat))
    p = pat.replace("[[:space:]]", r"\s").replace("[[:digit:]]", r"\d").replace("[[:alpha:]]", "[A-Za-z]") \
        .replace("[[:upper:]]", "[A-Z]").replace("[[:lower:]]", "[a-z]").replace("[[:punct:]]", r"[!-/:-@\[-`{-~]") \
        .replace("[:space:]", r"\s").replace("[:digit:]", r"\d").replace("[:alpha:]", "A-Za-z").replace("[:alnum:]", "A-Za-z0-9")
    return re.compile(p)


def flag(m, k):
    return k in m and C.as_logical1(m[k])


@builtin("strsplit")
def _strsplit(args, env):
    m = match_spec(args, "x, split, fixed, perl, useBytes")
    v = chr_args(m["x"])
    sp = str1(m["split"])
    res = []
    for s in v:
        if sp == "":
            res.append(mk_chr(list(s)))
        else:
            parts = r_regex(sp, flag(m, "fixed")).split(s)
            if parts and parts[-1] == "":
                parts = parts[:-1]
            res.append(mk_chr(parts))
    nm = getattr_(m["x"], "names")
    return RList(res, {"names": nm} if nm is not NULL else None)


def sub_impl(args, count):
    m = match_spec(args, "pattern, replacement, x, ignore.case, perl, fixed, useBytes")
    rx = r_regex(str1(m["pattern"]), flag(m, "fixed"))
    rep = str1(m["replacement"])
    if not flag(m, "fixed"):
        import re
        rep = re.sub(r"\\(\d)", r"\\g<\1>", rep)
    v = chr_args(m["x"])
    return mk_chr([None if s is None else rx.sub(rep, s, count=count) for s in v])


builtin("sub")(lambda args, env: sub_impl(args, 1))
builtin("gsub")(lambda args, env: sub_impl(args, 0))


@builtin("grepl")
def _grepl(args, env):
    m = match_spec(args, "pattern, x, ignore.case, perl, fixed, useBytes")
    rx = r_regex(str1(m["pattern"]), flag(m, "fixed"))
    return mk_lgl([False if s is None else bool(rx.search(s)) for s in chr_args(m["x"])])


@builtin("grep")
def _grep(args, env):
    m = match_spec(args, "pattern, x, ignore.case, perl, value, fixed, useBytes, invert")
    rx = r_regex(str1(m["pattern"]), flag(m, "fixed"))
    v = chr_args(m["x"])
    hits = [i for i, s in enumerate(v) if s is not None and rx.search(s)]
    if flag(m, "value"):
        return mk_chr([v[i] for i in hits])
    return mk_int([i + 1 for i in hits])


@builtin("startsWith")
def _startswith(args, env):
    p = str1(args[1][1])
    return mk_lgl([None if s is None else s.startswith(p) for s in chr_args(args[0][1])])


@builtin("endsWith")
def _endswith(args, env):
    p = str1(args[1][1])
    return mk_lgl([None if s is None else s.endswith(p) for s in chr_args(args[0][1])])


# ---------------------------------------------------------------- factors

def sort_unique(v, t):
    vals = [e for e in v if e is not None and not (isinstance(e, float) and math.isnan(e))]
    u = []
    seen = set()
    for e in vals:
        if e not in seen:
            seen.add(e)
            u.append(e)
    if t == "character":
        u.sort(key=str_key)
    else:
        u.sort()
    return u


def make_factor(x, levels=None, labels=None, ordered=False, exclude_na=True):
    if is_factor(x):
        x = as_type(x, "character")
    if x is NULL:
        x = Vec("character", [])
    t = x.type
    if levels is None:
        lv = sort_unique(x.v, t)
        lvs = as_type(Vec(t, lv), "character").v
    else:
        lvs = as_type(levels, "character").v
    xs = as_type(x, "character").v
    pos = {s: i + 1 for i, s in enumerate(lvs)}
    codes = [None if s is None else pos.get(s) for s in xs]
    if labels is not None:
        lab = as_type(labels, "character").v
        if len(lab) == 1 and len(lvs) > 1:
            lab = [lab[0] + str(i + 1) for i in range(len(lvs))]
        lvs = lab
    attrs = {"levels": mk_chr(lvs), "class": mk_chr(["ordered", "factor"] if ordered else ["factor"])}
    nm = getattr_(x, "names")
    if nm is not NULL:
        attrs["names"] = nm
    return Vec("integer", codes, attrs)


@builtin("factor")
def _factor(args, env):
    m = match_spec(args, "x, levels, labels, exclude, ordered, nmax")
    x = m.get("x", Vec("character", []))
    return make_factor(x, m.get("levels"), m.get("labels"), flag(m, "ordered"))


@builtin("as.factor")
def _asfactor(args, env):
    x = args[0][1]
    return x if is_factor(x) else make_factor(x)


@builtin("ordered")
def _ordered(args, env):
    m = match_spec(args, "x, levels, labels")
    return make_factor(m["x"], m.get("levels"), m.get("labels"), True)


@builtin("droplevels")
def _droplevels(args, env):
    x = args[0][1]
    if is_df(x):
        return RList([_droplevels([(None, c)], env) if is_factor(c) else c for c in x.v], copy_attrs(x.attrs))
    lv = getattr_(x, "levels").v
    used = sorted(set(e for e in x.v if e is not None))
    newlv = [lv[i - 1] for i in used]
    remap = {old: k + 1 for k, old in enumerate(used)}
    return Vec("integer", [None if e is None else remap[e] for e in x.v], dict(x.attrs, levels=mk_chr(newlv)))


@builtin("relevel")
def _relevel(args, env):
    m = match_spec(args, "x, ref")
    x = m["x"]
    lv = getattr_(x, "levels").v
    ref = str1(m["ref"])
    newlv = [ref] + [l for l in lv if l != ref]
    return make_factor(as_type(x, "character"), mk_chr(newlv))


@builtin("cut")
def _cut(args, env):
    m = match_spec(args, "x, breaks, labels, include.lowest, right, dig.lab, ordered_result")
    x = as_double(m["x"]).v
    br = as_double(m["breaks"]).v
    right = C.as_logical1(m["right"]) if "right" in m else True
    incl = flag(m, "include.lowest")
    if len(br) == 1:
        k = int(br[0])
        lo, hi = min(e for e in x if e is not None), max(e for e in x if e is not None)
        d = (hi - lo)
        br = [lo + d * i / k for i in range(k + 1)]
        br[0] -= d / 1000
        br[-1] += d / 1000
    br = sorted(br)
    dig = int1(m["dig.lab"]) if "dig.lab" in m else 3

    def fb(b):
        for dd in range(dig, max(12, dig) + 1):
            s = "%.*g" % (dd, b)
            if all(("%.*g" % (dd, bb)) != ("%.*g" % (dd, b2)) for bb, b2 in zip(br[:-1], br[1:])):
                return s
        return "%.*g" % (dig, b)
    fl = [fb(b) for b in br]
    if "labels" in m and m["labels"] is not NULL and not (m["labels"].type == "logical"):
        labels = as_type(m["labels"], "character").v
    else:
        labels = []
        for i in range(len(br) - 1):
            if right:
                l = ("[" if incl and i == 0 else "(") + fl[i] + "," + fl[i + 1] + "]"
            else:
                l = "[" + fl[i] + "," + fl[i + 1] + ("]" if incl and i == len(br) - 2 else ")")
            labels.append(l)
    codes = []
    for e in x:
        c = None
        if e is not None:
            for i in range(len(br) - 1):
                lo, hi = br[i], br[i + 1]
                if right:
                    if (lo < e <= hi) or (incl and i == 0 and e == lo):
                        c = i + 1
                        break
                else:
                    if (lo <= e < hi) or (incl and i == len(br) - 2 and e == hi):
                        c = i + 1
                        break
        codes.append(c)
    return Vec("integer", codes, {"levels": mk_chr(labels), "class": mk_chr(["factor"])})


def label_of(node):
    if isinstance(node, Sym):
        return node.name
    return None


@builtin("table", special=True)
def _table(call, env):
    items = []
    for n, a in call.args:
        if isinstance(a, Sym) and a.name == "...":
            for dn, p in C.dots(env):
                items.append((dn, C.force(p), p.expr if isinstance(p, C.Promise) else None))
            continue
        v = C.force(C.ev(a, env))
        items.append((n, v, a))
    C.STATE["visible"] = True
    if len(items) == 1 and is_df(items[0][1]):
        df = items[0][1]
        items = [(nm, col, None) for nm, col in zip(names_of(df), df.v)]
    facs, dnn = [], []
    for n, v, a in items:
        f = v if is_factor(v) else make_factor(v)
        facs.append(f)
        dnn.append(n if n else (label_of(a) or "") if len(items) == 1 or True else "")
    if len(facs) == 1:
        f = facs[0]
        lv = getattr_(f, "levels").v
        counts = [0] * len(lv)
        for e in f.v:
            if e is not None:
                counts[e - 1] += 1
        dn = RList([mk_chr(lv)], {"names": mk_chr([dnn[0]])})
        return Vec("integer", counts, {"dim": mk_int([len(lv)]), "dimnames": dn, "class": mk_chr(["table"])})
    f1, f2 = facs[0], facs[1]
    l1, l2 = getattr_(f1, "levels").v, getattr_(f2, "levels").v
    counts = [0] * (len(l1) * len(l2))
    for a, b in zip(f1.v, f2.v):
        if a is not None and b is not None:
            counts[(b - 1) * len(l1) + (a - 1)] += 1
    dn = RList([mk_chr(l1), mk_chr(l2)], {"names": mk_chr(dnn[:2])})
    return Vec("integer", counts, {"dim": mk_int([len(l1), len(l2)]), "dimnames": dn, "class": mk_chr(["table"])})


# ---------------------------------------------------------------- apply family

def match_fun(f, env):
    if isinstance(f, (Closure, Builtin)):
        return f
    if isinstance(f, Vec) and f.type == "character":
        return C.find_fun(f.v[0], env)
    raise RError("'%s' is not a function, character or symbol" % "FUN")


def seq_items(x):
    if is_df(x):
        return list(x.v), names_of(x)
    if isinstance(x, RList):
        return list(x.v), names_of(x)
    if isinstance(x, Vec):
        if is_factor(x):
            x = as_type(x, "character")
        return [Vec(x.type, [e]) for e in x.v], names_of(x)
    if x is NULL:
        return [], None
    raise RError("bad X")


def simplify(res, names, higher=True):
    if not res:
        return RList([])
    if all(isinstance(r, Vec) and len(r.v) == 1 for r in res):
        out = combine([(None, Vec(r.type, r.v, {"levels": getattr_(r, "levels"), "class": getattr_(r, "class")} if is_factor(r) else None) if True else r) for r in res])
        if is_factor(out):
            out = as_type(out, "character")
        rnames = [names_of(r)[0] if names_of(r) else None for r in res]
        if names is not None:
            out.attrs = {"names": mk_chr(names)}
        elif all(rn is not None for rn in rnames):
            out.attrs = {"names": mk_chr(rnames)}
        else:
            out.attrs = None
        return out
    lens = set(len(r.v) if isinstance(r, (Vec, RList)) else -1 for r in res)
    if len(lens) == 1 and all(isinstance(r, Vec) for r in res) and list(lens)[0] > 1:
        k = list(lens)[0]
        out = combine([(None, Vec(r.type, r.v)) for r in res])
        rn = names_of(res[0])
        out.attrs = {"dim": mk_int([k, len(res)])}
        if rn is not None or names is not None:
            out.attrs["dimnames"] = RList([mk_chr(rn) if rn else NULL, mk_chr(names) if names else NULL])
        return out
    return RList(res, {"names": mk_chr(names)} if names is not None else None)


@builtin("lapply")
def _lapply(args, env):
    m = match_spec(args, "X, FUN, ...")
    f = match_fun(m["FUN"], env)
    items, names = seq_items(m["X"])
    res = [C.call_fun(f, [(None, it)] + m["..."], env) for it in items]
    return RList(res, {"names": mk_chr(names)} if names is not None else None)


@builtin("sapply")
def _sapply(args, env):
    m = match_spec(args, "X, FUN, ..., simplify, USE.NAMES")
    f = match_fun(m["FUN"], env)
    X = m["X"]
    items, names = seq_items(X)
    usen = C.as_logical1(m["USE.NAMES"]) if "USE.NAMES" in m else True
    if usen and names is None and isinstance(X, Vec) and X.type == "character":
        names = list(X.v)
    if not usen:
        names = None
    res = [C.call_fun(f, [(None, it)] + m["..."], env) for it in items]
    if "simplify" in m and not C.as_logical1(m["simplify"]):
        return RList(res, {"names": mk_chr(names)} if names is not None else None)
    if not items:
        return RList([])
    return simplify(res, names)


@builtin("vapply")
def _vapply(args, env):
    m = match_spec(args, "X, FUN, FUN.VALUE, ..., USE.NAMES")
    f = match_fun(m["FUN"], env)
    items, names = seq_items(m["X"])
    if names is None and isinstance(m["X"], Vec) and m["X"].type == "character":
        names = list(m["X"].v)
    res = [C.call_fun(f, [(None, it)] + m["..."], env) for it in items]
    fv = m["FUN.VALUE"]
    for r in res:
        if not isinstance(r, Vec) or len(r.v) != len(fv.v):
            raise RError("values must be length %d,\n but FUN(X[[1]]) result is length %d" % (len(fv.v), vlen(r)))
    if not res:
        return Vec(fv.type, [])
    out = simplify([as_type(r, fv.type, True) for r in res], names)
    return out


@builtin("mapply")
def _mapply(args, env):
    m = match_spec(args, "FUN, ..., MoreArgs, SIMPLIFY, USE.NAMES")
    f = match_fun(m["FUN"], env)
    lists = [(n, seq_items(v)[0], v) for n, v in m["..."]]
    n = max(len(l) for _, l, _ in lists) if lists else 0
    res = []
    for i in range(n):
        res.append(C.call_fun(f, [(nm, l[i % len(l)]) for nm, l, _ in lists], env))
    first = lists[0][2] if lists else NULL
    names = names_of(first)
    if names is None and isinstance(first, Vec) and first.type == "character":
        names = list(first.v)
    if "SIMPLIFY" in m and not C.as_logical1(m["SIMPLIFY"]):
        return RList(res, {"names": mk_chr(names)} if names else None)
    return simplify(res, names)


@builtin("Map")
def _Map(args, env):
    return _mapply([(None, args[0][1])] + args[1:] + [("SIMPLIFY", mk_lgl([False]))], env)


@builtin("Reduce")
def _Reduce(args, env):
    m = match_spec(args, "f, x, init, right, accumulate")
    f = match_fun(m["f"], env)
    items, _ = seq_items(m["x"])
    acc_all = flag(m, "accumulate")
    if "init" in m:
        acc = m["init"]
    else:
        acc, items = items[0], items[1:]
    trace = [acc]
    for it in items:
        acc = C.call_fun(f, [(None, acc), (None, it)], env)
        trace.append(acc)
    if acc_all:
        return simplify(trace, None)
    return acc


@builtin("Filter")
def _Filter(args, env):
    f = match_fun(args[0][1], env)
    x = args[1][1]
    items, _ = seq_items(x)
    keep = [i for i, it in enumerate(items) if C.as_logical1(C.call_fun(f, [(None, it)], env))]
    return do_subset(x, [mk_int([i + 1 for i in keep])])


@builtin("do.call")
def _docall(args, env):
    m = match_spec(args, "what, args, quote, envir")
    f = match_fun(m["what"], env)
    a = m.get("args", RList([]))
    nm = names_of(a) or [None] * len(a.v)
    return C.call_fun(f, [(n or None, v) for n, v in zip(nm, a.v)], env)


@builtin("match.fun")
def _matchfun(args, env):
    return match_fun(args[0][1], env)


@builtin("Recall", special=True)
def _recall(call, env):
    fe, fr = C.frame_of(env)
    return C.call_fun(fr.fun, C.eval_args(call.args, env), env)


@builtin("apply")
def _apply(args, env):
    m = match_spec(args, "X, MARGIN, FUN, ..., simplify")
    X = m["X"]
    if is_df(X):
        X = as_matrix_df(X)
    f = match_fun(m["FUN"], env)
    margin = int1(m["MARGIN"])
    nr, nc = getattr_(X, "dim").v
    dn = getattr_(X, "dimnames")
    res = []
    if margin == 1:
        for i in range(nr):
            row = Vec(X.type, [X.v[j * nr + i] for j in range(nc)])
            if dn is not NULL and dn.v[1] is not NULL:
                row.attrs = {"names": dn.v[1]}
            res.append(C.call_fun(f, [(None, row)] + m["..."], env))
        names = list(dn.v[0].v) if dn is not NULL and dn.v[0] is not NULL else None
    else:
        for j in range(nc):
            col = Vec(X.type, X.v[j * nr:(j + 1) * nr])
            if dn is not NULL and dn.v[0] is not NULL:
                col.attrs = {"names": dn.v[0]}
            res.append(C.call_fun(f, [(None, col)] + m["..."], env))
        names = list(dn.v[1].v) if dn is not NULL and dn.v[1] is not NULL else None
    return simplify(res, names)


def as_matrix_df(df):
    cols = df.v
    t = rtype(*cols)
    vals = []
    for c in cols:
        vals.extend(as_type(c, t).v)
    rn = F.df_rownames(df)
    rni = getattr_(df, "row.names").type == "integer"
    return Vec(t, vals, {"dim": mk_int([F.df_nrow(df), len(cols)]), "dimnames": RList([NULL if rni else mk_chr(rn), getattr_(df, "names")])})


@builtin("as.matrix")
def _asmatrix(args, env):
    x = args[0][1]
    if is_df(x):
        return as_matrix_df(x)
    if getattr_(x, "dim") is not NULL:
        return x
    nm = getattr_(x, "names")
    return Vec(x.type, x.v, {"dim": mk_int([len(x.v), 1]), **({"dimnames": RList([nm, NULL])} if nm is not NULL else {})})


@builtin("tapply")
def _tapply(args, env):
    m = match_spec(args, "X, INDEX, FUN, ..., default, simplify")
    X = m["X"]
    idx = m["INDEX"]
    if isinstance(idx, RList) and not is_factor(idx):
        idx = idx.v[0]
    f = idx if is_factor(idx) else make_factor(idx)
    lv = getattr_(f, "levels").v
    fun = match_fun(m["FUN"], env)
    res = []
    for k in range(len(lv)):
        sel = [i for i, c in enumerate(f.v) if c == k + 1]
        sub = subset_vec(X, mk_int([i + 1 for i in sel]))
        res.append(C.call_fun(fun, [(None, sub)] + m["..."], env))
    if all(isinstance(r, Vec) and len(r.v) == 1 for r in res):
        out = combine([(None, Vec(r.type, r.v)) for r in res])
        out.attrs = {"dim": mk_int([len(lv)]), "dimnames": RList([mk_chr(lv)])}
        return out
    return RList(res, {"dim": mk_int([len(lv)]), "dimnames": RList([mk_chr(lv)])})


@builtin("outer")
def _outer(args, env):
    m = match_spec(args, "X, Y, FUN, ...")
    X, Y = m["X"], m["Y"]
    fn = m.get("FUN", mk_chr(["*"]))
    f = match_fun(fn, env)
    nx, ny = len(X.v), len(Y.v)
    xs = Vec(X.type, [X.v[i] for j in range(ny) for i in range(nx)])
    ys = Vec(Y.type, [Y.v[j] for j in range(ny) for i in range(nx)])
    r = C.call_fun(f, [(None, xs), (None, ys)] + m["..."], env)
    r = Vec(r.type, r.v, {"dim": mk_int([nx, ny])})
    nmx, nmy = getattr_(X, "names"), getattr_(Y, "names")
    if nmx is not NULL or nmy is not NULL:
        r.attrs["dimnames"] = RList([nmx, nmy])
    return r


builtin("%o%")(lambda args, env: _outer(args, env))


# ---------------------------------------------------------------- matrices

@builtin("matrix")
def _matrix(args, env):
    m = match_spec(args, "data, nrow, ncol, byrow, dimnames")
    data = m.get("data", mk_lgl([None]))
    if is_df(data):
        data = as_matrix_df(data)
    v = data.v
    L = len(v)
    hasr, hasc = "nrow" in m, "ncol" in m
    if hasr and hasc:
        nr, nc = int1(m["nrow"]), int1(m["ncol"])
    elif hasr:
        nr = int1(m["nrow"])
        nc = int(math.ceil(L / nr))
    elif hasc:
        nc = int1(m["ncol"])
        nr = int(math.ceil(L / nc))
    else:
        nr, nc = L, 1
    n = nr * nc
    if L and n % L and L < n or (L > n and L % n):
        warn("data length [%d] is not a sub-multiple or multiple of the number of rows [%d]" % (L, nr))
    if flag(m, "byrow"):
        vals = [v[(i * nc + j) % L] for j in range(nc) for i in range(nr)]
    else:
        vals = [v[k % L] for k in range(n)] if L else [None] * n
    attrs = {"dim": mk_int([nr, nc])}
    if "dimnames" in m and m["dimnames"] is not NULL:
        attrs["dimnames"] = m["dimnames"]
    return Vec(data.type if not is_factor(data) else "character", vals, attrs)


def mat_parts(x):
    d = getattr_(x, "dim")
    if d is NULL:
        return len(x.v), 1
    return d.v[0], d.v[1]


@builtin("t")
def _t(args, env):
    x = args[0][1]
    if is_df(x):
        x = as_matrix_df(x)
    d = getattr_(x, "dim")
    if d is NULL:
        nm = getattr_(x, "names")
        return Vec(x.type, list(x.v), {"dim": mk_int([1, len(x.v)]), **({"dimnames": RList([NULL, nm])} if nm is not NULL else {})})
    nr, nc = d.v
    vals = [x.v[j * nr + i] for i in range(nr) for j in range(nc)]
    attrs = {"dim": mk_int([nc, nr])}
    dn = getattr_(x, "dimnames")
    if dn is not NULL:
        attrs["dimnames"] = RList([dn.v[1], dn.v[0]])
    return Vec(x.type, vals, attrs)


def to_rows(x):
    nr, nc = mat_parts(x)
    v = as_double(x).v
    return [[v[j * nr + i] for j in range(nc)] for i in range(nr)]


def from_rows(rows, dimnames=None):
    nr = len(rows)
    nc = len(rows[0]) if rows else 0
    attrs = {"dim": mk_int([nr, nc])}
    if dimnames is not None:
        attrs["dimnames"] = dimnames
    return Vec("double", [rows[i][j] for j in range(nc) for i in range(nr)], attrs)


@builtin("%*%")
def _matmul(args, env):
    a, b = args[0][1], args[1][1]
    da, db = getattr_(a, "dim"), getattr_(b, "dim")
    if da is NULL and db is NULL:
        av, bv = as_double(a).v, as_double(b).v
        if len(av) != len(bv):
            raise RError("non-conformable arguments")
        return from_rows([[sum(x * y for x, y in zip(av, bv))]])
    if da is NULL:
        a = Vec(a.type, a.v, {"dim": mk_int([1, len(a.v)] if len(a.v) == db.v[0] else [len(a.v), 1])})
    if db is NULL:
        b = Vec(b.type, b.v, {"dim": mk_int([len(b.v), 1] if len(b.v) == getattr_(a, "dim").v[1] else [1, len(b.v)])})
    A, B = to_rows(a), to_rows(b)
    if len(A[0]) != len(B):
        raise RError("non-conformable arguments")
    res = [[sum(A[i][k] * B[k][j] for k in range(len(B))) for j in range(len(B[0]))] for i in range(len(A))]
    if a.type in ("integer", "logical") and b.type in ("integer", "logical"):
        r = from_rows(res)
        r.type = "integer"
        r.v = [int(e) for e in r.v]
        return r
    return from_rows(res)


def lu_solve(A, B):
    """Gaussian elimination with partial pivoting: A X = B (lists of rows)."""
    n = len(A)
    M = [list(A[i]) + list(B[i]) for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-300:
            raise RError("Lapack routine dgesv: system is exactly singular: U[%d,%d] = 0" % (c + 1, c + 1))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                if f:
                    M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [[M[i][j] / M[i][i] for j in range(n, len(M[0]))] for i in range(n)]


@builtin("solve")
def _solve(args, env):
    a = args[0][1]
    A = to_rows(a)
    n = len(A)
    if len(args) > 1:
        b = args[1][1]
        B = to_rows(b) if getattr_(b, "dim") is not NULL else [[e] for e in as_double(b).v]
        X = lu_solve(A, B)
        if getattr_(b, "dim") is NULL:
            return mk_dbl([r[0] for r in X])
        return from_rows(X)
    X = lu_solve(A, [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)])
    dn = getattr_(a, "dimnames")
    return from_rows(X, RList([dn.v[1], dn.v[0]]) if dn is not NULL else None)


@builtin("det")
def _det(args, env):
    A = [list(r) for r in to_rows(args[0][1])]
    n = len(A)
    d = 1.0
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        if A[p][c] == 0:
            return mk_dbl([0.0])
        if p != c:
            A[c], A[p] = A[p], A[c]
            d = -d
        d *= A[c][c]
        for r in range(c + 1, n):
            f = A[r][c] / A[c][c]
            A[r] = [x - f * y for x, y in zip(A[r], A[c])]
    return mk_dbl([d])


@builtin("diag")
def _diag(args, env):
    x = args[0][1]
    d = getattr_(x, "dim")
    if d is not NULL:
        nr, nc = d.v
        return Vec(x.type, [x.v[i * nr + i] for i in range(min(nr, nc))])
    if len(x.v) == 1 and len(args) == 1:
        n = int1(x)
        return from_rows([[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)])
    v = as_double(x).v
    n = len(v)
    return from_rows([[v[i] if i == j else 0.0 for j in range(n)] for i in range(n)])


@builtin("crossprod")
def _crossprod(args, env):
    a = args[0][1]
    b = args[1][1] if len(args) > 1 else a
    return _matmul([(None, _t([(None, a)], env)), (None, b)], env)


def bind(args, env, by_col):
    items = []
    deparse_level_names = []
    for n, v in args:
        if n in ("deparse.level", "stringsAsFactors"):
            continue
        items.append((n, v))
    if any(is_df(v) for n, v in items):
        if by_col:
            cols, names = [], []
            for n, v in items:
                if is_df(v):
                    cols.extend(v.v)
                    names.extend(names_of(v))
                else:
                    cols.append(v)
                    names.append(n or "V%d" % (len(cols)))
            return df_new(cols, names)
        base = items[0][1]
        names = names_of(base)
        cols = []
        for j, nm in enumerate(names):
            parts = []
            for n, v in items:
                parts.append((None, v.v[j] if is_df(v) else (dollar(v, nm) if isinstance(v, RList) else Vec(v.type, [v.v[j]]))))
            cols.append(combine(parts))
        return df_new(cols, names)
    vecs = [(n, v) for n, v in items if v is not NULL]
    lens = []
    for n, v in vecs:
        d = getattr_(v, "dim")
        lens.append(d.v[0] if (d is not NULL and by_col) else (d.v[1] if d is not NULL else len(v.v)))
    L = max(lens)
    t = rtype(*[v for n, v in vecs])
    cols = []
    names = []
    other_names = None
    for (n, v), ln in zip(vecs, lens):
        d = getattr_(v, "dim")
        if d is not NULL:
            nr, nc = d.v
            vv = as_type(v, t).v
            dn = getattr_(v, "dimnames")
            if by_col:
                for j in range(nc):
                    cols.append(vv[j * nr:(j + 1) * nr])
                    names.append(dn.v[1].v[j] if dn is not NULL and dn.v[1] is not NULL else "")
            else:
                for i in range(nr):
                    cols.append([vv[j * nr + i] for j in range(nc)])
                    names.append(dn.v[0].v[i] if dn is not NULL and dn.v[0] is not NULL else "")
        else:
            vv = as_type(v, t).v
            cols.append([vv[i % len(vv)] for i in range(L)])
            names.append(n or "")
            if names_of(v) is not None and other_names is None:
                other_names = names_of(v)
    k = len(cols)
    if by_col:
        vals = [e for c in cols for e in c]
        dim = [L, k]
    else:
        vals = [cols[i][j] for j in range(L) for i in range(k)]
        dim = [k, L]
    attrs = {"dim": mk_int(dim)}
    if any(names) or other_names:
        nm = mk_chr(names) if any(names) else NULL
        on = mk_chr(other_names) if other_names else NULL
        attrs["dimnames"] = RList([on, nm] if by_col else [nm, on])
    return Vec(t, vals, attrs)


builtin("cbind")(lambda args, env: bind(args, env, True))
builtin("rbind")(lambda args, env: bind(args, env, False))


def margin_stat(args, env, by_row, mean):
    m = match_spec(args, "x, na.rm, dims")
    x = m["x"]
    narm = flag(m, "na.rm")
    if is_df(x):
        x = as_matrix_df(x)
    nr, nc = getattr_(x, "dim").v
    v = as_double(x).v
    res = []
    rng = range(nr) if by_row else range(nc)
    for k in rng:
        vals = [v[j * nr + k] for j in range(nc)] if by_row else v[k * nr:(k + 1) * nr]
        if narm:
            vals = [e for e in vals if e is not None]
        if any(e is None for e in vals):
            res.append(None)
            continue
        s = sum(vals)
        res.append(s / len(vals) if mean else s)
    dn = getattr_(x, "dimnames")
    r = mk_dbl(res)
    if dn is not NULL and dn.v[0 if by_row else 1] is not NULL:
        r.attrs = {"names": dn.v[0 if by_row else 1]}
    return r


builtin("rowSums")(lambda args, env: margin_stat(args, env, True, False))
builtin("colSums")(lambda args, env: margin_stat(args, env, False, False))
builtin("rowMeans")(lambda args, env: margin_stat(args, env, True, True))
builtin("colMeans")(lambda args, env: margin_stat(args, env, False, True))


# ---------------------------------------------------------------- data frames

@builtin("data.frame", special=True)
def _dataframe(call, env):
    items = []
    saf = False
    for n, a in call.args:
        if n == "stringsAsFactors":
            saf = C.as_logical1(C.force(C.ev(a, env)))
            continue
        if n == "check.names":
            continue
        if isinstance(a, Sym) and a.name == "...":
            for dn, p in C.dots(env):
                items.append((dn, C.force(p), p.expr if isinstance(p, C.Promise) else None))
            continue
        items.append((n, C.force(C.ev(a, env)), a))
    C.STATE["visible"] = True
    return make_df(items, saf)


def make_df(items, saf=False):
    cols, names = [], []
    rown = None
    for n, v, a in items:
        if is_df(v):
            cols.extend(v.v)
            names.extend(names_of(v))
            continue
        if isinstance(v, Vec) and getattr_(v, "dim") is not NULL and len(getattr_(v, "dim").v) == 2:
            nr, nc = getattr_(v, "dim").v
            dn = getattr_(v, "dimnames")
            for j in range(nc):
                cols.append(Vec(v.type, v.v[j * nr:(j + 1) * nr]))
                names.append(dn.v[1].v[j] if dn is not NULL and dn.v[1] is not NULL else "%s.%d" % (n or "X", j + 1))
            continue
        if isinstance(v, RList):
            for nm, e in zip(names_of(v) or [], v.v):
                cols.append(e)
                names.append(nm)
            continue
        if isinstance(v, Vec) and v.type == "character" and saf:
            v = make_factor(v)
        if isinstance(v, Vec) and names_of(v) is not None and not is_factor(v):
            if rown is None and len(set(names_of(v))) == len(v.v):
                rown = names_of(v)
            v = Vec(v.type, v.v)
        cols.append(v)
        names.append(n if n else (F.deparse(a) if a is not None else "V%d" % len(cols)))
    if cols:
        L = max(len(c.v) for c in cols)
        for i, c in enumerate(cols):
            if len(c.v) != L:
                if len(c.v) == 0 or L % len(c.v):
                    raise RError("arguments imply differing number of rows: %s" % ", ".join(sorted(set(str(len(x.v)) for x in cols), key=int, reverse=True)))
                cols[i] = do_rep(c, L)
    return df_new(cols, names, rown)


@builtin("as.data.frame")
def _asdf(args, env):
    x = args[0][1]
    if is_df(x):
        return x
    if C.inherits(x, "table"):
        dn = getattr_(x, "dimnames")
        dnn = names_of(dn) or ["Var1"]
        f = make_factor(dn.v[0], dn.v[0])
        return df_new([f, Vec("integer", list(x.v))], [dnn[0] or "Var1", "Freq"])
    if getattr_(x, "dim") is not NULL:
        nr, nc = getattr_(x, "dim").v
        dn = getattr_(x, "dimnames")
        cols = [Vec(x.type, x.v[j * nr:(j + 1) * nr]) for j in range(nc)]
        names = list(dn.v[1].v) if dn is not NULL and dn.v[1] is not NULL else ["V%d" % (j + 1) for j in range(nc)]
        return df_new(cols, names)
    return make_df([(None, x, Sym("x"))])


@builtin("with", special=True)
def _with(call, env):
    data = C.force(C.ev(call.args[0][1], env))
    e = data_env(data, env)
    return C.force(C.ev(call.args[1][1], e))


def data_env(data, parent):
    e = C.Env(parent)
    if isinstance(data, RList):
        for nm, v in zip(names_of(data) or [], data.v):
            e.vars[nm] = v
    return e


@builtin("subset", special=True)
def _subset_df(call, env):
    data = C.force(C.ev(call.args[0][1], env))
    cond = None
    select = None
    for n, a in call.args[1:]:
        if n == "select":
            select = a
        elif cond is None:
            cond = a
    C.STATE["visible"] = True
    if is_df(data):
        e = data_env(data, env)
        rows = MISSING
        if cond is not None:
            v = C.force(C.ev(cond, e))
            rows = mk_lgl([bool(x) for x in v.v])
        cols = MISSING
        if select is not None:
            names = names_of(data)
            se = C.Env(env)
            for k, nm in enumerate(names):
                se.vars[nm] = mk_int([k + 1])
            cols = C.force(C.ev(select, se))
        return subset_df(data, rows, cols, drop=False)
    v = C.force(C.ev(cond, env))
    return subset_vec(data, mk_lgl([bool(x) for x in v.v]))


@builtin("merge")
def _merge(args, env):
    raise RError("merge() is not in the Rill spike")


# ---------------------------------------------------------------- constants

def _init_constants():
    B = C.BASE.vars
    B["pi"] = mk_dbl([math.pi])
    B["T"] = mk_lgl([True])
    B["F"] = mk_lgl([False])
    B["letters"] = mk_chr([chr(97 + i) for i in range(26)])
    B["LETTERS"] = mk_chr([chr(65 + i) for i in range(26)])
    B["month.name"] = mk_chr(["January", "February", "March", "April", "May", "June", "July", "August",
                              "September", "October", "November", "December"])
    B["month.abb"] = mk_chr(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])
    B[".Machine"] = RList([mk_int([INT_MAX]), mk_dbl([2.220446049250313e-16]), mk_dbl([1.797693134862316e308])],
                          {"names": mk_chr(["integer.max", "double.eps", "double.xmax"])})


_init_constants()
