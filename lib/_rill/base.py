"""Rill's builtins, A1.1's set (design/rill.md §4): arithmetic, comparison,
logic, `:`, `c`, `print`, `invisible` and `cat`.

The semantics and messages follow what R 4.5.3 does for rill-tests/core/:
integer arithmetic that overflows gives NA with a warning, `/` and `^` give
doubles, recycling warns when lengths don't divide, and character operands
are errors.  Every result's size is reserved before it is built (§8.5).
Each builtin is called as f(session, call, args) with args a list of
(name or None, value).
"""

import math

from . import fmt, mem
from .access import (as_character, as_complex, as_double, as_integer, as_logical, character_, complex_, dollar,
                     double_, index, integer_, is_character, is_complex, is_double, is_finite, is_infinite,
                     is_integer, is_logical, is_na, is_nan, is_null, is_numeric, is_vector, length_, logical_,
                     names_, options, refuse_raw)
from .args import DOTS, Closure, Primitive
from .eval import NotSupported, RError
from .values import NULL, RVector

INT_MAX = 2147483647
COLON_FUZZ = 2.0 ** -23  # `:`'s length allowance, single precision's epsilon (R 4.5.3, rill-tests/core/test_3.R)
RANK = {"logical": 0, "integer": 1, "double": 2, "complex": 3, "character": 4}


def _vec(v):
    """An operand as a RVector (NULL is a zero-length logical)."""
    if v is NULL:
        return RVector("logical", [])
    if isinstance(v, RVector):
        return v
    raise NotSupported("this operand type")


def _check_attrs(*vs):
    for v in vs:
        if v.attrs and set(v.attrs) != {"names"}:
            raise NotSupported("operands with attributes other than names")


def _result_attrs(n, x, y=None):
    """The names an operator's result keeps (R 4.5.3, rill-tests/access/): the longer operand's, or the first's
    when they are as long; none where that operand has none."""
    for v in (x, y):
        if v is not None and len(v.data) == n and v.attrs:
            return {"names": v.attrs["names"]}
    return None


def _lengths(x, y, call, sess):
    nx, ny = len(x.data), len(y.data)
    if nx == 0 or ny == 0:
        return 0
    n = max(nx, ny)
    if n % min(nx, ny):
        sess.warn("longer object length is not a multiple of shorter object length", call)
    return n


def as_double_scalar(e, t):
    if e is None:
        return None
    if t == "logical":
        return 1.0 if e else 0.0
    return float(e)


def num_to_str(x):
    """as.character() of a double: 15 significant digits (R 4.5.3: "1" == 1)."""
    return fmt.deparse_number(x)


def _dbl_to_str(e):
    s = fmt._special(e)
    return s if s is not None else num_to_str(e)


def coerce_elt(e, frm, to):
    if e is None:
        return None
    if frm == to:
        return e
    if to == "character":
        if frm == "logical":
            return "TRUE" if e else "FALSE"
        if frm == "integer":
            return str(e)
        if frm == "double":
            return _dbl_to_str(e)
        if frm == "complex":
            # (each part at 15 significant digits: R 4.5.3, "0.333333333333333+0i", "1e+15-0.5i")
            im = e.imag
            sign = "-" if (im < 0 or (im == 0 and math.copysign(1.0, im) < 0)) else "+"
            return _dbl_to_str(e.real) + sign + _dbl_to_str(abs(im)) + "i"
        raise NotSupported("coercing %s to character" % frm)
    if to == "complex":
        if frm == "character":
            raise NotSupported("coercing character to complex")
        return complex(as_double_scalar(e, frm), 0.0)
    if to == "double":
        return as_double_scalar(e, frm)
    if to == "integer":
        return int(e)
    raise NotSupported("coercing %s to %s" % (frm, to))


def coerce(v, to):
    if v.type == to:
        return v.data
    return [coerce_elt(e, v.type, to) for e in v.data]


# ---------------------------------------------------------------- arithmetic

def _int_op(op, a, b, flags):
    if op == "+":
        r = a + b
    elif op == "-":
        r = a - b
    elif op == "*":
        r = a * b
    elif op == "%%":
        if b == 0:
            return None
        return a % b
    elif op == "%/%":
        if b == 0:
            return None
        return a // b
    if -INT_MAX <= r <= INT_MAX:
        return r
    flags[0] = True
    return None


def _dbl_op(op, a, b):
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        if b == 0:
            if a == 0 or a != a:
                return math.nan
            return math.copysign(math.inf, a) * math.copysign(1.0, b)
        return a / b
    if op == "^":
        if a == 1 or b == 0:
            return 1.0
        if a != a or b != b:
            return math.nan
        if a < 0 and b != int(b) and not math.isinf(b):
            return math.nan
        try:
            return math.pow(a, b)
        except OverflowError:
            return math.inf if a > 0 or int(b) % 2 == 0 else -math.inf
        except ValueError:
            return math.inf if a == 0 else math.nan
    if op == "%%":
        if b == 0:
            return math.nan
        if math.isinf(a):
            return math.nan
        if math.isinf(b):
            return a if (a >= 0) == (b > 0) else b
        r = math.fmod(a, b)
        if r != 0 and (r < 0) != (b < 0):
            r += b  # the result takes the divisor's sign, as R's %% does
        return r
    if op == "%/%":
        if b == 0:
            if a == 0 or a != a:
                return math.nan
            return math.copysign(math.inf, a) * math.copysign(1.0, b)
        return math.floor(a / b)
    raise NotSupported("operator %s" % op)


def arith(sess, call, args):
    op = call.fn.name
    if len(args) == 1:
        return unary(sess, call, op, _vec(args[0][1]))
    x, y = _vec(args[0][1]), _vec(args[1][1])
    _check_attrs(x, y)
    if x.type == "character" or y.type == "character":
        raise RError("non-numeric argument to binary operator", call)
    if x.type == "complex" or y.type == "complex":
        if op in ("%%", "%/%"):
            raise RError("unimplemented complex operation")  # (R names no call here: rill-tests/print/)
        rtype = "complex"
    elif op in ("/", "^") or x.type == "double" or y.type == "double":
        rtype = "double"
    else:
        rtype = "integer"
    n = _lengths(x, y, call, sess)
    with mem.reserve(n, rtype, (len(x.data), rtype), (len(y.data), rtype)):
        nx, ny = len(x.data), len(y.data)
        out = [None] * n
        if rtype == "complex":
            xd, yd = coerce(x, "complex"), coerce(y, "complex")
            for i in range(n):
                a, b = xd[i % nx], yd[i % ny]
                out[i] = None if a is None or b is None else _cplx_op(op, a, b)
        elif rtype == "integer":
            flags = [False]
            xd = [None if e is None else int(e) for e in x.data]
            yd = [None if e is None else int(e) for e in y.data]
            for i in range(n):
                a, b = xd[i % nx], yd[i % ny]
                out[i] = None if a is None or b is None else _int_op(op, a, b, flags)
            if flags[0]:
                sess.warn("NAs produced by integer overflow", call)
        else:
            xd = [as_double_scalar(e, x.type) for e in x.data]
            yd = [as_double_scalar(e, y.type) for e in y.data]
            for i in range(n):
                a, b = xd[i % nx], yd[i % ny]
                if op == "^" and (a == 1 or b == 0):
                    out[i] = 1.0
                elif a is None or b is None:
                    out[i] = None
                else:
                    out[i] = _dbl_op(op, a, b)
        return RVector(rtype, out, _result_attrs(n, x, y))


def _cplx_op(op, a, b):
    """R's complex arithmetic (R 4.5.3, rill-tests/print/): division by zero gives each part's own quotient
    ((1+2i)/0 is Inf+Infi, 0i/0 NaN+NaNi), and a power with an integral exponent is repeated multiplication."""
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        if b == 0:
            return complex(_dbl_op("/", a.real, 0.0), _dbl_op("/", a.imag, 0.0))
        return a / b
    # ^
    if b.imag == 0 and b.real == int(b.real) and abs(b.real) <= 65536:
        k, r, base = int(abs(b.real)), complex(1.0, 0.0), a
        while k:
            if k & 1:
                r *= base
            base *= base
            k >>= 1
        return r if b.real >= 0 else (complex(1.0, 0.0) / r if r != 0 else complex(math.inf, 0.0))
    if a == 0:
        return complex(0.0, 0.0)
    return a ** b


def unary(sess, call, op, x):
    _check_attrs(x)
    if x.type == "character":
        raise RError("invalid argument to unary operator", call)
    rtype = "complex" if x.type == "complex" else ("integer" if x.type in ("logical", "integer") else "double")
    with mem.reserve(len(x.data), rtype, (len(x.data), rtype)):
        data = coerce(x, rtype)
        if op == "-":
            data = [None if e is None else -e for e in data]
        return RVector(rtype, list(data), _result_attrs(len(x.data), x))


# ---------------------------------------------------------------- comparison and logic

def _collate_key(s):
    """The order of strings in R's collation here: letters compare ignoring case
    first, then lower case before upper (R 4.5.3: "a" < "B")."""
    return (s.lower(), [c.isupper() for c in s])


# (only the operator asked for: complex numbers have == and != but no order)
# (lambdas, not the operator module: operator.py is in the core group, which Rill's start would then load, design/rill.md 6.1)
_COMPARE = {"==": lambda a, b: a == b, "!=": lambda a, b: a != b, "<": lambda a, b: a < b, ">": lambda a, b: a > b,
            "<=": lambda a, b: a <= b, ">=": lambda a, b: a >= b}


def compare(sess, call, args):
    op = call.fn.name
    x, y = _vec(args[0][1]), _vec(args[1][1])
    _check_attrs(x, y)
    t = max(x.type, y.type, key=RANK.get)
    if t == "complex" and op not in ("==", "!="):
        raise RError("invalid comparison with complex values", call)
    if t == "logical":
        t = "integer"
    n = _lengths(x, y, call, sess)
    with mem.reserve(n, "logical", (len(x.data), t), (len(y.data), t)):
        xd, yd = coerce(x, t), coerce(y, t)
        nx, ny = len(xd), len(yd)
        out = [None] * n
        for i in range(n):
            a, b = xd[i % nx], yd[i % ny]
            if a is None or b is None or (t in ("double", "complex") and (a != a or b != b)):
                continue
            if t == "character" and op not in ("==", "!="):
                a, b = _collate_key(a), _collate_key(b)
            out[i] = _COMPARE[op](a, b)
        return RVector("logical", out, _result_attrs(n, x, y))


def _logical_data(v):
    out = []
    for e in v.data:
        if e is None or (isinstance(e, float) and e != e):
            out.append(None)
        else:
            out.append(bool(e))
    return out


def logic(sess, call, args):
    op = call.fn.name
    if op == "!":
        x = _vec(args[0][1])
        _check_attrs(x)
        if x.type not in ("logical", "integer", "double"):
            raise RError("invalid argument type", call)
        with mem.reserve(len(x.data), "logical", (len(x.data), "logical")):
            return RVector("logical", [None if e is None else not e for e in _logical_data(x)],
                           _result_attrs(len(x.data), x))
    x, y = _vec(args[0][1]), _vec(args[1][1])
    _check_attrs(x, y)
    for v in (x, y):
        if v.type not in ("logical", "integer", "double"):
            raise RError("operations are possible only for numeric, logical or complex types", call)
    n = _lengths(x, y, call, sess)
    with mem.reserve(n, "logical", (len(x.data), "logical"), (len(y.data), "logical")):
        xd, yd = _logical_data(x), _logical_data(y)
        nx, ny = len(xd), len(yd)
        out = [None] * n
        for i in range(n):
            a, b = xd[i % nx], yd[i % ny]
            if op == "&":
                out[i] = False if (a is False or b is False) else (None if (a is None or b is None) else True)
            else:
                out[i] = True if (a is True or b is True) else (None if (a is None or b is None) else False)
        return RVector("logical", out, _result_attrs(n, x, y))


# ---------------------------------------------------------------- : and c

def _colon_end(v, call, sess):
    v = _vec(v)
    if not v.data:
        raise NotSupported("a zero-length argument of ':'")
    if len(v.data) > 1:
        sess.warn("numerical expression has %d elements: only the first used" % len(v.data), call)
    e = v.data[0]
    if v.type == "character":
        try:
            return float(e) if e is not None else None
        except ValueError:
            sess.warn("NAs introduced by coercion")
            return None
    return as_double_scalar(e, v.type)


def colon(sess, call, args):
    a = _colon_end(args[0][1], call, sess)
    b = _colon_end(args[1][1], call, sess)
    if a is None or b is None or a != a or b != b:
        raise RError("NA/NaN argument", call)
    n = int(math.floor(abs(b - a) + COLON_FUZZ)) + 1
    step = 1 if b >= a else -1
    last = a + step * (n - 1)
    as_int = a == int(a) and -INT_MAX <= a <= INT_MAX and -INT_MAX <= last <= INT_MAX
    rtype = "integer" if as_int else "double"
    with mem.reserve(n, rtype):
        if as_int:
            a = int(a)
            return RVector("integer", list(range(a, a + step * n, step)))
        return RVector("double", [a + step * i for i in range(n)])


def combine(sess, call, args):
    vals = []
    named = False
    for name, v in args:
        if v is NULL:
            continue
        if not isinstance(v, RVector):
            raise NotSupported("c() of this type")
        if v.attrs and set(v.attrs) != {"names"}:
            raise NotSupported("c() of values with attributes other than names")
        named = named or name is not None or bool(v.attrs)
        vals.append((name, v))
    if not vals:
        return NULL
    t = max((v.type for _, v in vals), key=RANK.get)
    n = sum(len(v.data) for _, v in vals)
    # (the result, the largest coerced operand, and the names when any: the whole peak, first: §8.5); the names
    # are n strings, one argument's list of them at a time, and the characters of the ones built from a tag, as
    # counted by a scan that builds nothing (astra's #999 SEC 1)
    widest = max(len(v.data) for _, v in vals)
    extra = [(n, "character"), (widest, "character")] if named else []
    chars = _c_name_chars(vals) if named else 0
    with mem.reserve(n, t, (widest, t), *extra, extra_bytes=NAME_CHAR_BYTES * chars):
        out = []
        for _, v in vals:
            out.extend(coerce(v, t))
        if not named:
            return RVector(t, out)
        names = []
        for tag, v in vals:
            names.extend(_c_names(tag, v))
        return RVector(t, out, {"names": RVector("character", names)})


# a Python string's widest storage for one character (UCS-4)
NAME_CHAR_BYTES = 4


def _digits_upto(k):
    """The digits in writing 1, 2, ..., k, in O(log k) steps."""
    total, lo, d = 0, 1, 1
    while lo <= k:
        total += (min(k, lo * 10 - 1) - lo + 1) * d
        lo, d = lo * 10, d + 1
    return total


def _c_name_chars(vals):
    """The characters of the names _c_names builds from a tag (a name it reuses costs none): tag.name, tagN."""
    chars = 0
    for tag, v in vals:
        if tag is None:
            continue
        inner = v.attrs.get("names").data if v.attrs else None
        k = len(v.data)
        if inner is not None:
            for i, nm in enumerate(inner):
                chars += len(tag) + (1 + len(nm) if nm else len(str(i + 1)))
        elif k > 1:
            chars += k * len(tag) + _digits_upto(k)
    return chars


def _c_names(tag, v):
    """The names c() gives v's elements under argument name `tag` (R 4.5.3: rill-tests/access/): its own names,
    prefixed "tag." where it has a tag; a tag alone on one element; tag1, tag2, ... on several."""
    inner = v.attrs.get("names").data if v.attrs else None
    k = len(v.data)
    if inner is not None:
        if tag is None:
            return list(inner)
        return [("%s.%s" % (tag, nm)) if nm else "%s%d" % (tag, i + 1) for i, nm in enumerate(inner)]
    if tag is None:
        return [""] * k
    if k == 1:
        return [tag]
    return ["%s%d" % (tag, i + 1) for i in range(k)]


# ---------------------------------------------------------------- printing

def print_(sess, call, args):
    # (each value by the formal it matched: print(digits = 3, x) is legal R; astra's #999 SEC 2)
    v, digits = NULL, None
    for name, a in args:
        if name == "x":
            v = a
        elif name == "digits":
            digits = _digits_option(a, call)
    print_value(sess, v, digits)
    sess.visible = False
    return v


def _digits_option(a, call):
    """A digits value, as options(digits =) and print(digits =) check it (R 4.5.3, rill-tests/args/)."""
    d = as_double_scalar(a.data[0], a.type) if isinstance(a, RVector) and len(a.data) == 1 and a.type != "character" else None
    if d is None or d != d or not 1 <= d <= 22:
        raise RError("invalid 'digits' parameter, allowed 1...22", call)
    return int(d)


def print_value(sess, v, digits=None):
    from .eval import is_language
    if is_language(v):
        sess.write_out(fmt.deparse(v) + "\n")
        return
    opts = fmt.Options(sess.options["digits"] if digits is None else digits, sess.options["scipen"], sess.options["width"])
    with _print_reservation(v):
        if fmt.print_value(v, sess.write_out, opts) is None:
            raise NotSupported("printing this value")


def _print_reservation(v):
    """print's peak, reserved first: an element string per element (each at most w characters: numbers 24,
    complex numbers 50, logicals 5, a string ten times its length plus its quotes, for escapes such as \\U{01fffe}),
    and the laid-out output, every element padded to the widest, with its line labels, held twice (the lines and
    their join).  A named vector adds its names, each up to ten times its length, as a second row per line.  The
    width is the widest element's bound, so a single long string pads every row (astra's R2)."""
    if not isinstance(v, RVector):
        return mem.reserve(0, "character")
    n = len(v.data)
    # (the widest element and the total, as running scalars: nothing proportional to the vector exists before
    # the reservation is admitted; astra's R2)
    if v.type == "character":
        w = total = 0
        for e in v.data:
            x = 2 if e is None else ESCAPE_BOUND * len(e) + 2
            total += x
            if x > w:
                w = x
    else:
        w = ({"logical": 5, "complex": 50}.get(v.type, 24)) if n else 0
        total = w * n
    names = v.attrs.get("names") if v.attrs else None
    rows = 1
    if names is not None:
        rows = 2
        for e in names.data:
            x = 4 if e is None else ESCAPE_BOUND * len(e)
            total += x
            if x > w:
                w = x
    label = len("[%d]" % n) + 1
    laid_out = rows * n * (w + 1) + n * label
    return mem.reserve(0, "character", (rows * n, "character"), extra_bytes=total + 2 * laid_out)


# the most characters print() writes for one character of a string: \\U{01fffe} (fmt.escape_string)
ESCAPE_BOUND = 10


def invisible(sess, call, args):
    v = args[0][1] if args else NULL
    sess.visible = False
    return v


def _cat_reservation(args, sep):
    """cat's peak: an element string per element (numbers at most 24 characters, strings their own length) and
    the output they are joined into, reserved before either is built (§8.5)."""
    count, chars = 0, 0
    for name, v in args:
        # (every argument but sep is printed: a named one went to `...`, e.g. cat(1, se = "-"))
        if name != "sep" and isinstance(v, RVector):
            count += len(v.data)
            chars += sum(len(e) for e in v.data if e is not None) if v.type == "character" else 24 * len(v.data)
    return mem.reserve(0, "character", (count, "character"), extra_bytes=chars + count * len(sep))


def cat(sess, call, args):
    sep = " "
    for name, v in args:
        if name == "sep" and isinstance(v, RVector) and v.type == "character" and len(v.data) == 1:
            sep = v.data[0]
    with _cat_reservation(args, sep):
        _cat(sess, args)
    sess.visible = False
    return NULL


def _cat(sess, args):
    sep = " "
    items = []
    for name, v in args:
        if name == "sep":
            if not (isinstance(v, RVector) and v.type == "character" and len(v.data) == 1):
                raise NotSupported("cat(sep =) other than one string")
            sep = v.data[0]
        elif v is not NULL:
            if not isinstance(v, RVector) or v.type == "complex":
                raise NotSupported("cat() of this type")
            for e in v.data:
                if e is None:
                    items.append("NA")
                elif v.type == "double":
                    items.append(fmt.format_real1(e, fmt.real_layout([e])))
                elif v.type == "logical":
                    items.append("TRUE" if e else "FALSE")
                else:
                    items.append(str(e))
    sess.write_out(sep.join(items))


# the shapes of calls Rill refuses, checked after R's matching (args.match: `plan`, the formal each actual
# matched, None for `...`) and before any argument is evaluated (Session._enter): a refusal never follows an
# argument's effect (astra's R1)
def _preflight_cat(call, plan):
    for formal in plan:
        if formal == "file":
            # gate: cat(file =) refused (a file route, until Rill's files go through the file gate: design §9)
            raise NotSupported("cat(file =)")
        if formal in ("fill", "labels", "append"):
            raise NotSupported("cat(%s =)" % formal)


def _preflight_print(call, plan):
    # (R dispatches print on x and reaches print.default, which evaluates digits = before it finds x missing:
    # rill-tests/access/#print-missing-x-first; Rill's print has no dispatch yet, so it refuses first, astra's R1)
    if "x" not in plan:
        raise NotSupported("print() without x")


def _preflight_raw(call, plan):
    # gate: raw vectors refused (before any argument runs; deferred: design §4, A1.2's scope note)
    raise NotSupported("raw vectors")


def _preflight_options(call, plan):
    # (the option a call names decides its refusal, so it comes before any value is evaluated)
    if not call.args:
        raise NotSupported("listing every option with options()")
    for name, _ in call.args:
        if name is None:
            raise NotSupported("options() with an unnamed argument")
        if name not in ("digits", "scipen"):
            raise NotSupported("options(%s =)" % name)


PREFLIGHT = {"cat": _preflight_cat, "print": _preflight_print}
PREFLIGHT["raw"] = _preflight_raw
PREFLIGHT["as.raw"] = _preflight_raw
PREFLIGHT["options"] = _preflight_options

# each builtin's signature for R's matching (args.py), as R declares it: a closure's formals, or a primitive's
# arity (the operators and c() take any arguments and aren't listed)
FORMALS = {
    "print": Closure("x", "digits", DOTS, required=("x",)),
    "cat": Closure(DOTS, "file", "sep", "fill", "labels", "append"),
    "invisible": Primitive("x", dots=False, least=0),
    "length": Primitive("x"),
    "names": Primitive("x"),
    "logical": Closure("length"),
    "integer": Closure("length"),
    "numeric": Closure("length"),
    "double": Closure("length"),
    "character": Closure("length"),
    "complex": Closure("length.out", "real", "imaginary", "modulus", "argument"),
    "is.vector": Closure("x", "mode", required=("x",)),
    "options": Closure(DOTS),
}
for _f in ("as.logical", "as.integer", "as.numeric", "as.double", "as.character", "as.complex"):
    FORMALS[_f] = Primitive("x", dots=True, least=0)
for _f in ("is.numeric", "is.character", "is.logical", "is.integer", "is.double", "is.complex", "is.null", "is.na",
           "is.nan", "is.finite", "is.infinite"):
    FORMALS[_f] = Primitive("x")

BUILTINS = {}
for _op in ("+", "-", "*", "/", "^", "%%", "%/%"):
    BUILTINS[_op] = arith
for _op in ("==", "!=", "<", ">", "<=", ">="):
    BUILTINS[_op] = compare
for _op in ("!", "&", "|"):
    BUILTINS[_op] = logic
BUILTINS[":"] = colon
BUILTINS["c"] = combine
BUILTINS["print"] = print_
BUILTINS["invisible"] = invisible
BUILTINS["cat"] = cat
# A1.2: atomic vectors' accessors, constructors, coercions and tests (access.py)
BUILTINS["length"] = length_
BUILTINS["names"] = names_
BUILTINS["["] = index
BUILTINS["$"] = dollar
BUILTINS["logical"] = logical_
BUILTINS["integer"] = integer_
BUILTINS["numeric"] = double_
BUILTINS["double"] = double_
BUILTINS["character"] = character_
BUILTINS["complex"] = complex_
BUILTINS["as.logical"] = as_logical
BUILTINS["as.integer"] = as_integer
BUILTINS["as.numeric"] = as_double
BUILTINS["as.double"] = as_double
BUILTINS["as.character"] = as_character
BUILTINS["as.complex"] = as_complex
BUILTINS["is.numeric"] = is_numeric
BUILTINS["is.character"] = is_character
BUILTINS["is.logical"] = is_logical
BUILTINS["is.integer"] = is_integer
BUILTINS["is.double"] = is_double
BUILTINS["is.complex"] = is_complex
BUILTINS["is.null"] = is_null
BUILTINS["is.na"] = is_na
BUILTINS["is.nan"] = is_nan
BUILTINS["is.finite"] = is_finite
BUILTINS["is.infinite"] = is_infinite
BUILTINS["is.vector"] = is_vector
BUILTINS["options"] = options
BUILTINS["raw"] = refuse_raw
BUILTINS["as.raw"] = refuse_raw
# base's constants (values, not functions)
VALUES = {"pi": RVector("double", [math.pi]), "T": RVector("logical", [True]), "F": RVector("logical", [False])}
