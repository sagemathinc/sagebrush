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
from .eval import NotSupported, RError
from .values import NULL, Vector

INT_MAX = 2147483647
RANK = {"logical": 0, "integer": 1, "double": 2, "complex": 3, "character": 4}


def _vec(v):
    """An operand as a Vector (NULL is a zero-length logical)."""
    if v is NULL:
        return Vector("logical", [])
    if isinstance(v, Vector):
        return v
    raise NotSupported("this operand type")


def _check_attrs(*vs):
    for v in vs:
        if v.attrs:
            raise NotSupported("operands with attributes")


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
            s = fmt._special(e)
            return s if s is not None else num_to_str(e)
        raise NotSupported("coercing %s to character" % frm)
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
        raise NotSupported("complex arithmetic")
    if op in ("/", "^") or x.type == "double" or y.type == "double":
        rtype = "double"
    else:
        rtype = "integer"
    n = _lengths(x, y, call, sess)
    with mem.reserve(n, rtype, (len(x.data), rtype), (len(y.data), rtype)):
        nx, ny = len(x.data), len(y.data)
        out = [None] * n
        if rtype == "integer":
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
        return Vector(rtype, out)


def unary(sess, call, op, x):
    _check_attrs(x)
    if x.type == "character":
        raise RError("invalid argument to unary operator", call)
    if x.type == "complex":
        raise NotSupported("complex arithmetic")
    rtype = "integer" if x.type in ("logical", "integer") else "double"
    with mem.reserve(len(x.data), rtype, (len(x.data), rtype)):
        data = coerce(x, rtype)
        if op == "-":
            data = [None if e is None else -e for e in data]
        return Vector(rtype, list(data))


# ---------------------------------------------------------------- comparison and logic

def _collate_key(s):
    """The order of strings in R's collation here: letters compare ignoring case
    first, then lower case before upper (R 4.5.3: "a" < "B")."""
    return (s.lower(), [c.isupper() for c in s])


def compare(sess, call, args):
    op = call.fn.name
    x, y = _vec(args[0][1]), _vec(args[1][1])
    _check_attrs(x, y)
    if "complex" in (x.type, y.type):
        raise NotSupported("comparing complex numbers")
    t = max(x.type, y.type, key=RANK.get)
    if t == "logical":
        t = "integer"
    n = _lengths(x, y, call, sess)
    with mem.reserve(n, "logical", (len(x.data), t), (len(y.data), t)):
        xd, yd = coerce(x, t), coerce(y, t)
        nx, ny = len(xd), len(yd)
        out = [None] * n
        for i in range(n):
            a, b = xd[i % nx], yd[i % ny]
            if a is None or b is None or (t == "double" and (a != a or b != b)):
                continue
            if t == "character" and op not in ("==", "!="):
                a, b = _collate_key(a), _collate_key(b)
            out[i] = {"==": a == b, "!=": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]
        return Vector("logical", out)


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
            return Vector("logical", [None if e is None else not e for e in _logical_data(x)])
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
        return Vector("logical", out)


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
    n = int(math.floor(abs(b - a) + 1e-10)) + 1
    step = 1 if b >= a else -1
    last = a + step * (n - 1)
    as_int = a == int(a) and -INT_MAX <= a <= INT_MAX and -INT_MAX <= last <= INT_MAX
    rtype = "integer" if as_int else "double"
    with mem.reserve(n, rtype):
        if as_int:
            a = int(a)
            return Vector("integer", list(range(a, a + step * n, step)))
        return Vector("double", [a + step * i for i in range(n)])


def combine(sess, call, args):
    vals = []
    for name, v in args:
        if v is NULL:
            continue
        if not isinstance(v, Vector):
            raise NotSupported("c() of this type")
        if v.attrs:
            raise NotSupported("c() of values with attributes")
        vals.append(v)
    if not vals:
        return NULL
    t = max((v.type for v in vals), key=RANK.get)
    n = sum(len(v.data) for v in vals)
    with mem.reserve(n, t, (max(len(v.data) for v in vals), t)):
        out = []
        for v in vals:
            out.extend(coerce(v, t))
        return Vector(t, out)


# ---------------------------------------------------------------- printing

def print_(sess, call, args):
    v = args[0][1]
    print_value(sess, v)
    sess.visible = False
    return v


def print_value(sess, v):
    from .eval import is_language
    if is_language(v):
        sess.write_out(fmt.deparse(v) + "\n")
        return
    with _print_reservation(v):
        if fmt.print_value(v, sess.write_out) is None:
            raise NotSupported("printing this value")


def _print_reservation(v):
    """print's peak, reserved first: an element string per element (each at most w characters: numbers 24,
    logicals 5, a string four times its length plus its quotes, for escapes), and the laid-out output, every
    element padded to the widest, with its line labels, held twice (the lines and their join).  The width is
    the widest element's bound, so a single long string pads every row (astra's R2)."""
    if not isinstance(v, Vector):
        return mem.reserve(0, "character")
    n = len(v.data)
    # (the widest element and the total, as running scalars: nothing proportional to the vector exists before
    # the reservation is admitted; astra's R2)
    if v.type == "character":
        w = total = 0
        for e in v.data:
            x = 2 if e is None else 4 * len(e) + 2
            total += x
            if x > w:
                w = x
    else:
        w = (5 if v.type == "logical" else 24) if n else 0
        total = w * n
    label = len("[%d]" % n) + 1
    laid_out = n * (w + 1) + n * label
    return mem.reserve(0, "character", (n, "character"), extra_bytes=total + 2 * laid_out)


def invisible(sess, call, args):
    v = args[0][1] if args else NULL
    sess.visible = False
    return v


def _cat_reservation(args, sep):
    """cat's peak: an element string per element (numbers at most 24 characters, strings their own length) and
    the output they are joined into, reserved before either is built (§8.5)."""
    count, chars = 0, 0
    for name, v in args:
        if name is None and isinstance(v, Vector):
            count += len(v.data)
            chars += sum(len(e) for e in v.data if e is not None) if v.type == "character" else 24 * len(v.data)
    return mem.reserve(0, "character", (count, "character"), extra_bytes=chars + count * len(sep))


def cat(sess, call, args):
    sep = " "
    for name, v in args:
        if name == "sep" and isinstance(v, Vector) and v.type == "character" and len(v.data) == 1:
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
            if not (isinstance(v, Vector) and v.type == "character" and len(v.data) == 1):
                raise NotSupported("cat(sep =) other than one string")
            sep = v.data[0]
        elif v is not NULL:
            if not isinstance(v, Vector) or v.type == "complex":
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


# the shapes of calls A1.1 refuses, checked before any argument is evaluated (Session._enter): a refusal never
# follows an argument's effect (astra's R1)
def _preflight_cat(call):
    for name, _ in call.args:
        if name == "file":
            # gate: cat(file =) refused (a file route, until Rill's files go through the file gate: design §9)
            raise NotSupported("cat(file =)")
        if name not in (None, "sep"):
            raise NotSupported("cat(%s =)" % name)


def _preflight_print(call):
    if len(call.args) != 1 or call.args[0][0] is not None:
        raise NotSupported("print() with these arguments")


def _preflight_c(call):
    if any(name is not None for name, _ in call.args):
        raise NotSupported("c() with names")


PREFLIGHT = {"cat": _preflight_cat, "print": _preflight_print, "c": _preflight_c}

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

# base's constants (values, not functions)
VALUES = {"pi": Vector("double", [math.pi]), "T": Vector("logical", [True]), "F": Vector("logical", [False])}
