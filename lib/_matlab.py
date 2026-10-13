"""MATLAB's values, operators, printing and built-in functions, for programs
translated by src/matlab.ts (see design/matlab.md).

Values:
- a real double scalar is a Python float, a logical scalar a Python bool, a
  complex double scalar a Python complex;
- every other numeric or logical array is a numpy ndarray with its axes in
  reverse order: MATLAB's m-by-n array is stored with shape (n, m).  Then
  numpy's C order is MATLAB's column-major order, and numpy's broadcasting
  (which aligns trailing axes) is MATLAB's implicit expansion (which aligns
  leading dimensions).  It has at least 2 axes, and no leading axis of
  length 1 beyond those 2 (MATLAB drops trailing singleton dimensions);
- char arrays (Char), strings (Str), cell arrays (Cell), structs (Struct)
  and function handles (Anon, Handle, Function, Builtin) are classes here.

The transpose is taken at every boundary where an array leaves MATLAB's
semantics: display, linear algebra (_mat/_unmat), .mat files and plotting.

A value is never shared by two variables: assignment copies (cp) a value
read from a variable or a container, a function copies the arguments it
changes, and nothing here returns an argument's own array.  So an indexed
assignment may change an array in place.
"""

import math as _math
import sys as _sys

import numpy as np

__all__ = []

# ------------------------------------------------------------------ sentinels


class _Sentinel:
    __slots__ = ("name",)

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return self.name


NOVAL = _Sentinel("NOVAL")  # a call that returned no value
NOVAR = _Sentinel("NOVAR")  # (an anonymous function's capture) not a variable
COLON = _Sentinel("COLON")  # a bare `:` index


class Undef:
    """A variable of a function not assigned yet."""
    __slots__ = ("name",)

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return "<undefined %s>" % self.name


UNDEF = Undef("")

# ------------------------------------------------------------------ errors


class MatlabError(Exception):
    def __init__(self, message, identifier=""):
        Exception.__init__(self, message)
        self.message = message
        self.identifier = identifier


class ScriptReturn(BaseException):
    """`return` in a script: it stops, quietly."""


Catchable = Exception


def _err(msg, ident=""):
    return MatlabError(msg, ident)


def _undefined(name):
    return MatlabError("Unrecognized function or variable '%s'." % name, "MATLAB:UndefinedFunction")


def _message(e):
    if isinstance(e, MatlabError):
        return e.message
    if isinstance(e, NameError):
        s = str(e)
        i = s.find("'")
        j = s.find("'", i + 1)
        name = s[i + 1:j] if 0 <= i < j else s
        if name.startswith("_k_"):
            name = name[3:]
        return "Unrecognized function or variable '%s'." % name
    if isinstance(e, RecursionError):
        return "Maximum recursion limit of 500 reached."
    if isinstance(e, MemoryError):
        return "Out of memory."
    if isinstance(e, ZeroDivisionError):
        return "Division by zero."
    return "%s" % (e,) if str(e) else type(e).__name__


def _identifier(e):
    if isinstance(e, MatlabError):
        return e.identifier
    if isinstance(e, NameError):
        return "MATLAB:UndefinedFunction"
    return ""


_src = ["<matlab>", []]


def begin(name, text):
    _src[0] = name
    _src[1] = text.split("\n")


def _scriptname():
    n = _src[0]
    n = n.replace("\\", "/").split("/")[-1]
    return n[:-2] if n.endswith(".m") else n


def trace(e, fname, line):
    """A function's frame, on the way out of it (for the error report)."""
    if isinstance(e, (ScriptReturn, SystemExit, KeyboardInterrupt)):
        return e
    try:
        st = e.__dict__.get("_mstack") if hasattr(e, "__dict__") else None
        if st is None:
            st = []
            e._mstack = st
        st.append((fname, line))
    except Exception:
        pass
    return e


def report(e, line):
    """An error that stops the program, reported as MATLAB does (to stderr)."""
    if isinstance(e, ScriptReturn):
        return
    if isinstance(e, (SystemExit, KeyboardInterrupt)):
        raise e
    _sys.stdout.flush()
    out = [_message(e)]
    lines = _src[1]
    for fname, ln in list(getattr(e, "_mstack", None) or []) + [(_scriptname(), line)]:
        out.append("")
        out.append("Error in %s (line %d)" % (fname, ln))
        if 0 < ln <= len(lines):
            out.append(lines[ln - 1].strip())
    _sys.stderr.write("\n".join(out) + "\n")
    raise SystemExit(1)


def _write(s):
    _sys.stdout.write(s)

# ------------------------------------------------------------------ numeric arrays

_INTS = {
    "int8": (np.int8, -128, 127), "uint8": (np.uint8, 0, 255),
    "int16": (np.int16, -32768, 32767), "uint16": (np.uint16, 0, 65535),
    "int32": (np.int32, -2147483648, 2147483647), "uint32": (np.uint32, 0, 4294967295),
    "int64": (np.int64, -9223372036854775808, 9223372036854775807), "uint64": (np.uint64, 0, 18446744073709551615),
}


def _dtclass(dt):
    k = dt.kind
    if k == "f":
        return "double" if dt.itemsize == 8 else "single"
    if k == "c":
        return "double" if dt.itemsize == 16 else "single"
    if k == "b":
        return "logical"
    return dt.name


def _canon(a):
    """MATLAB drops trailing singleton dimensions: leading axes here."""
    while a.ndim > 2 and a.shape[0] == 1:
        a = a.reshape(a.shape[1:])
    return a


def _box(a):
    """An ndarray result as a MATLAB value: 1-by-1 doubles and logicals are Python scalars."""
    if a.ndim < 2:
        a = a.reshape((-1, 1)) if a.ndim == 1 else a.reshape((1, 1))
    k = a.dtype.kind
    if k == "c":
        if not np.any(a.imag):
            a = np.ascontiguousarray(a.real)
            k = "f"
    if a.size == 1:
        if k == "f" and a.dtype.itemsize == 8:
            return float(a.reshape(-1)[0])
        if k == "b":
            return bool(a.reshape(-1)[0])
        if k == "c" and a.dtype.itemsize == 16:
            return complex(a.reshape(-1)[0])
    return _canon(a)


def _stored(dims):
    """the storage shape of MATLAB dimensions"""
    d = list(dims)
    while len(d) > 2 and d[-1] == 1:
        d.pop()
    return tuple(reversed(d))


def _arr(v):
    """v as an ndarray (any MATLAB array value: numeric, logical, char)."""
    t = type(v)
    if t is np.ndarray:
        return v
    if t is float:
        return np.array([[v]])
    if t is bool:
        return np.array([[v]], dtype=bool)
    if t is complex:
        return np.array([[v]], dtype=np.complex128)
    if t is Char:
        return v.a
    if t is int:
        return np.array([[float(v)]])
    raise _err("Expected a numeric value, not %s." % class_(v))


def _farr(v, name="the operation"):
    """v as a float64 or complex128 ndarray, for arithmetic."""
    t = type(v)
    if t is float:
        return np.array([[v]])
    if t is np.ndarray:
        dt = v.dtype
        if (dt.kind == "f" and dt.itemsize == 8) or (dt.kind == "c" and dt.itemsize == 16):
            return v
        if dt.kind == "c":
            return v.astype(np.complex128)
        return v.astype(np.float64)
    if t is bool:
        return np.array([[1.0 if v else 0.0]])
    if t is complex:
        return np.array([[v]], dtype=np.complex128)
    if t is Char:
        return v.a
    if t is int:
        return np.array([[float(v)]])
    raise _optype(name, v)


def _optype(name, *vals):
    return _err("Undefined function '%s' for input arguments of type '%s'." % (name, class_(vals[0]) if vals else "?"), "MATLAB:UndefinedFunction")


def _isnumlike(v):
    t = type(v)
    return t is float or t is bool or t is complex or t is np.ndarray or t is Char or t is int


def _dims(v):
    t = type(v)
    if t is float or t is bool or t is complex or t is int:
        return (1, 1)
    if t is np.ndarray:
        return tuple(reversed(v.shape))
    if t is Char:
        return tuple(reversed(v.a.shape))
    if t is Cell or t is Struct or t is StrArr:
        return v.shape
    if isinstance(v, Undef):
        raise _undefined(v.name or "?")
    return (1, 1)


def _numel(v):
    t = type(v)
    if t is float or t is bool or t is complex:
        return 1
    if t is np.ndarray:
        return v.size
    if t is Char:
        return v.a.size
    if t is Cell or t is Struct or t is StrArr:
        return len(v.a)
    return 1


def _prod(xs):
    p = 1
    for x in xs:
        p *= x
    return p


def _isscalar(v):
    t = type(v)
    if t is float or t is bool or t is complex:
        return True
    return _numel(v) == 1


def _mat(v):
    """a 2-D value as a numpy matrix in MATLAB's orientation (a copy)"""
    a = _farr(v)
    if a.ndim > 2:
        raise _err("Arguments must be 2-D.")
    return np.array(a.T)


def _unmat(m):
    """a numpy matrix in MATLAB's orientation as a MATLAB value"""
    m = np.asarray(m)
    if m.ndim == 1:
        m = m.reshape((-1, 1))
    return _box(np.ascontiguousarray(m.T))


def _int_round(r, cls):
    """MATLAB's conversion to an integer class: round half away from zero, saturate, NaN is 0."""
    dt, lo, hi = _INTS[cls]
    r = np.asarray(r)
    if r.dtype.kind == "c":
        r = r.real
    if r.dtype.kind in "iu":
        return np.clip(r, lo, hi).astype(dt)
    r = np.where(np.isnan(r), 0.0, r)
    r = np.where(r >= 0, np.floor(r + 0.5), -np.floor(-r + 0.5))
    return np.clip(r, float(lo), float(hi)).astype(dt)


def _finish(r, cls):
    """an arithmetic result (float64/complex128) in the result class"""
    if cls == "double":
        return _box(r)
    if cls == "single":
        return _canon(r.astype(np.complex64 if r.dtype.kind == "c" else np.float32))
    if cls == "logical":
        return _box(r.astype(bool))
    return _canon(_int_round(r, cls))


def _arith_class(a, b, name):
    ca = class_(a)
    cb = class_(b)
    ia = ca in _INTS
    ib = cb in _INTS
    for c, v in ((ca, a), (cb, b)):
        if c in ("cell", "struct", "function_handle", "string"):
            raise _err("Operator '%s' is not supported for operands of type '%s'." % (_OPSYM.get(name, name), c), "MATLAB:UndefinedFunction")
    if ia or ib:
        if ia and ib and ca != cb:
            raise _err("Integers can only be combined with integers of the same class, or scalar doubles.", "MATLAB:mixedClasses")
        return ca if ia else cb
    if ca == "single" or cb == "single":
        return "single"
    return "double"


_OPSYM = {"plus": "+", "minus": "-", "times": ".*", "mtimes": "*", "rdivide": "./", "ldivide": ".\\", "mrdivide": "/",
          "mldivide": "\\", "power": ".^", "mpower": "^", "eq": "==", "ne": "~=", "lt": "<", "le": "<=", "gt": ">", "ge": ">=",
          "and": "&", "or": "|", "not": "~", "uminus": "-", "uplus": "+", "colon": ":"}


def _broadcast(f, A, B):
    try:
        return f(A, B)
    except (ValueError, IndexError):
        raise _err("Arrays have incompatible sizes for this operation.", "MATLAB:sizeDimensionsMustMatch")


def _elementwise(a, b, f, name):
    cls = _arith_class(a, b, name)
    r = _broadcast(f, _farr(a, name), _farr(b, name))
    return _finish(r, cls)


def _add(A, B):
    return A + B


def _sub(A, B):
    return A - B


def _mul(A, B):
    return A * B


def _div(A, B):
    with np.errstate(divide="ignore", invalid="ignore"):
        return A / B


def _pow(A, B):
    if A.dtype.kind != "c" and B.dtype.kind != "c":
        # a negative base to a fractional power is complex
        if np.any((A < 0) & (B != np.floor(B))):
            A = A.astype(np.complex128)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        return A ** B


def _scalar_div(a, b):
    if b == 0.0:
        if a != a or a == 0.0:
            return _math.nan
        return _math.copysign(_math.inf, a) * (_math.copysign(1.0, b))
    return a / b


def plus(a, b):
    if type(a) is float and type(b) is float:
        return a + b
    if type(a) is Str or type(b) is Str or type(a) is StrArr or type(b) is StrArr:
        return _str_plus(a, b)
    return _elementwise(a, b, _add, "plus")


def minus(a, b):
    if type(a) is float and type(b) is float:
        return a - b
    return _elementwise(a, b, _sub, "minus")


def times(a, b):
    if type(a) is float and type(b) is float:
        return a * b
    return _elementwise(a, b, _mul, "times")


def rdivide(a, b):
    if type(a) is float and type(b) is float:
        return _scalar_div(a, b)
    return _elementwise(a, b, _div, "rdivide")


def ldivide(a, b):
    return rdivide(b, a)


def power(a, b):
    if type(a) is float and type(b) is float:
        try:
            r = a ** b
        except ZeroDivisionError:
            return _math.inf
        except OverflowError:
            return _math.inf if a > 0 or b == _math.floor(b) and b % 2 == 0 else -_math.inf
        if type(r) is complex:
            return r if r.imag != 0 else r.real
        return r
    return _elementwise(a, b, _pow, "power")


def mtimes(a, b):
    if type(a) is float and type(b) is float:
        return a * b
    if _isscalar(a) or _isscalar(b):
        return _elementwise(a, b, _mul, "mtimes")
    cls = _arith_class(a, b, "mtimes")
    A = _farr(a, "mtimes")
    B = _farr(b, "mtimes")
    if A.ndim > 2 or B.ndim > 2:
        raise _err("Arguments must be 2-D, or at least one argument must be scalar. Use TIMES (.*) for elementwise multiplication.")
    if A.shape[0] != B.shape[1]:
        raise _err("Incorrect dimensions for matrix multiplication. Check that the number of columns in the first matrix matches the number of rows in the second matrix. To operate on each element of the matrix individually, use TIMES (.*) for elementwise multiplication.", "MATLAB:innerdim")
    # (stored transposed: (A B)^T = B^T A^T)
    return _finish(np.matmul(B, A), cls)


def _solve(A, B):
    """A \\ B for MATLAB-oriented numpy matrices"""
    m, n = A.shape
    if B.shape[0] != m:
        raise _err("Matrix dimensions must agree.", "MATLAB:dimagree")
    if m == n:
        try:
            if m and np.linalg.cond(A) > 1e16:
                raise np.linalg.LinAlgError("singular")
            return np.linalg.solve(A, B)
        except np.linalg.LinAlgError:
            warning_("Matrix is singular to working precision.")
            with np.errstate(divide="ignore", invalid="ignore"):
                return np.full((n, B.shape[1]), np.inf)
    return np.linalg.lstsq(A, B, rcond=None)[0]


def mldivide(a, b):
    if type(a) is float and type(b) is float:
        return _scalar_div(b, a)
    if _isscalar(a):
        return _elementwise(b, a, _div, "mldivide")
    cls = _arith_class(a, b, "mldivide")
    return _finish(_farr(_unmat(_solve(_mat(a), _mat(b)))), cls)


def mrdivide(a, b):
    if type(a) is float and type(b) is float:
        return _scalar_div(a, b)
    if _isscalar(b):
        return _elementwise(a, b, _div, "mrdivide")
    cls = _arith_class(a, b, "mrdivide")
    A = _mat(a)
    B = _mat(b)
    if A.shape[1] != B.shape[1]:
        raise _err("Matrix dimensions must agree.", "MATLAB:dimagree")
    return _finish(_farr(_unmat(_solve(B.T, A.T).T)), cls)


def mpower(a, b):
    if type(a) is float and type(b) is float:
        return power(a, b)
    if _isscalar(a) and _isscalar(b):
        return power(a, b)
    if not _isscalar(b):
        raise _err("Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.")
    cls = _arith_class(a, b, "mpower")
    A = _mat(a)
    if A.shape[0] != A.shape[1]:
        raise _err("Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.")
    p = _scalar(b)
    if p == _math.floor(p):
        p = int(p)
        if p < 0:
            A = _mat(_unmat(_solve(A, np.eye(A.shape[0]))))
            p = -p
        R = np.eye(A.shape[0], dtype=A.dtype)
        while p:
            if p & 1:
                R = R @ A
            A = A @ A
            p >>= 1
        return _finish(_farr(_unmat(R)), cls)
    w, V = np.linalg.eig(A)
    R = V @ np.diag(w.astype(np.complex128) ** p) @ np.linalg.inv(V)
    return _finish(_farr(_unmat(R)), cls)


def uminus(a):
    t = type(a)
    if t is float:
        return -a
    if t is bool:
        return -1.0 if a else -0.0
    if t is complex:
        return -a
    cls = _arith_class(a, 0.0, "uminus")
    return _finish(-_farr(a), cls)


def uplus(a):
    t = type(a)
    if t is float or t is complex:
        return a
    if t is bool:
        return 1.0 if a else 0.0
    if t is Char:
        return _box(a.a.copy())
    if t is np.ndarray:
        return a.copy() if a.dtype.kind != "b" else _box(a.astype(np.float64))
    return cp(a)


def _cmp(a, b, f, name):
    if type(a) is Str or type(b) is Str or type(a) is StrArr or type(b) is StrArr:
        return _str_cmp(a, b, f, name)
    for v in (a, b):
        c = class_(v)
        if c in ("cell", "struct", "function_handle"):
            raise _err("Operator '%s' is not supported for operands of type '%s'." % (_OPSYM[name], c), "MATLAB:UndefinedFunction")
    A = _farr(a, name)
    B = _farr(b, name)
    if "single" in (class_(a), class_(b)) and not (class_(a) in _INTS or class_(b) in _INTS):
        # (mixed single and double: computed in single)
        A = A.astype(np.complex64 if A.dtype.kind == "c" else np.float32)
        B = B.astype(np.complex64 if B.dtype.kind == "c" else np.float32)
    if A.dtype.kind == "c" or B.dtype.kind == "c":
        if name not in ("eq", "ne"):
            A = A.real
            B = B.real
    with np.errstate(invalid="ignore"):
        return _box(_broadcast(f, A, B))


def eq(a, b):
    if type(a) is float and type(b) is float:
        return a == b
    return _cmp(a, b, lambda x, y: x == y, "eq")


def ne(a, b):
    if type(a) is float and type(b) is float:
        return a != b
    return _cmp(a, b, lambda x, y: x != y, "ne")


def lt(a, b):
    if type(a) is float and type(b) is float:
        return a < b
    return _cmp(a, b, lambda x, y: x < y, "lt")


def le(a, b):
    if type(a) is float and type(b) is float:
        return a <= b
    return _cmp(a, b, lambda x, y: x <= y, "le")


def gt(a, b):
    if type(a) is float and type(b) is float:
        return a > b
    return _cmp(a, b, lambda x, y: x > y, "gt")


def ge(a, b):
    if type(a) is float and type(b) is float:
        return a >= b
    return _cmp(a, b, lambda x, y: x >= y, "ge")


def _logical_arr(v, name):
    t = type(v)
    if t is np.ndarray and v.dtype.kind == "b":
        return v
    A = _farr(v, name)
    if A.dtype.kind == "f" and np.any(np.isnan(A)):
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    return A != 0


def and_(a, b):
    if type(a) is bool and type(b) is bool:
        return a and b
    if type(a) is float and type(b) is float:
        return a != 0.0 and b != 0.0
    return _box(_broadcast(lambda x, y: x & y, _logical_arr(a, "and"), _logical_arr(b, "and")))


def or_(a, b):
    if type(a) is bool and type(b) is bool:
        return a or b
    if type(a) is float and type(b) is float:
        return a != 0.0 or b != 0.0
    return _box(_broadcast(lambda x, y: x | y, _logical_arr(a, "or"), _logical_arr(b, "or")))


def not_(a):
    t = type(a)
    if t is bool:
        return not a
    if t is float:
        if a != a:
            raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
        return a == 0.0
    return _box(~_logical_arr(a, "not"))


def sc(v):
    """an operand of && or ||: a logical scalar"""
    t = type(v)
    if t is bool:
        return v
    if t is float:
        if v != v:
            raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
        return v != 0.0
    if _isnumlike(v) and _numel(v) == 1:
        return bool(_logical_arr(v, "sc").reshape(-1)[0])
    raise _err("Operands to the logical AND (&&) and OR (||) operators must be convertible to logical scalar values. Use the ANY or ALL functions to reduce operands to logical scalar values.", "MATLAB:nonLogicalConditional")


def cond(v):
    """the condition of if and while: nonempty, and every element nonzero"""
    t = type(v)
    if t is bool:
        return v
    if t is float:
        if v != v:
            raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
        return v != 0.0
    if t is Str:
        raise _err("Conversion to logical from string is not possible.")
    if not _isnumlike(v):
        raise _err("Conversion to logical from %s is not possible." % class_(v))
    if _numel(v) == 0:
        return False
    A = _arr(v)
    if A.dtype.kind == "c":
        A = A.real
    if A.dtype.kind == "f" and np.any(np.isnan(A)):
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    return bool(np.all(A != 0))


def transpose(a):
    t = type(a)
    if t is float or t is bool or t is complex:
        return a
    if t is np.ndarray:
        if a.ndim > 2:
            raise _err("Transpose on ND array is not defined. Use PERMUTE instead.")
        return np.array(a.T)
    if t is Char:
        return Char(np.array(a.a.T))
    if t is Cell or t is Struct or t is StrArr:
        if len(a.shape) > 2:
            raise _err("Transpose on ND array is not defined. Use PERMUTE instead.")
        r, c = a.shape
        out = a._like([a.a[j * r + i] for i in range(r) for j in range(c)], (c, r))
        return out
    if t is Str:
        return a
    raise _optype("transpose", a)


def ctranspose(a):
    t = type(a)
    if t is float or t is bool:
        return a
    if t is complex:
        return a.conjugate()
    if t is np.ndarray and a.dtype.kind == "c":
        return _box(np.conj(transpose(a)))
    return transpose(a)

# ------------------------------------------------------------------ the colon operator


def _scalar(v, what="value"):
    """a numeric scalar as a Python float (the first element of an array)"""
    t = type(v)
    if t is float:
        return v
    if t is bool:
        return 1.0 if v else 0.0
    if t is int:
        return float(v)
    if t is complex:
        return v.real
    if _isnumlike(v):
        a = _arr(v)
        if a.size == 0:
            raise _err("Index exceeds the number of array elements. Index must not exceed 0.")
        x = a.reshape(-1)[0]
        return float(x.real) if a.dtype.kind == "c" else float(x)
    raise _err("Expected a numeric %s, not %s." % (what, class_(v)))


def _colon_values(a, d, b):
    """MATLAB's a:d:b, as its colon computes it (the second half counted
    back from the end point, so that a symmetric range is symmetric)"""
    if a != a or d != d or b != b:
        return [_math.nan]
    if d == 0 or (a < b and d < 0) or (b < a and d > 0):
        return []
    if _math.isinf(a) or _math.isinf(b) or _math.isinf(d):
        if _math.isinf(d) and not _math.isinf(a):
            return [a]
        raise _err("Maximum variable size allowed by the program is exceeded.")
    if a == _math.floor(a) and d == _math.floor(d):
        n = int(_math.floor((b - a) / d))
        return [a + k * d for k in range(n + 1)]
    tol = 2.0 * 2.220446049250313e-16 * max(abs(a), abs(b))
    n = int(round((b - a) / d))
    sig = 1.0 if d > 0 else -1.0
    if sig * (a + n * d - b) > tol:
        n -= 1
    last = a + n * d
    if abs(last - b) <= tol:
        last = b
    v = [0.0] * (n + 1)
    half = n // 2
    for k in range(half + 1):
        v[k] = a + k * d
        v[n - k] = last - k * d
    if n % 2 == 0:
        v[half] = (a + last) / 2
    return v


def colon(a, b, c=None):
    if c is None:
        start, step, stop = a, 1.0, b
    else:
        start, step, stop = a, b, c
    cls = "double"
    for v in (start, step, stop):
        k = class_(v)
        if k in _INTS:
            cls = k
        elif k == "single" and cls == "double":
            cls = "single"
    ischar = type(start) is Char and type(stop) is Char
    vals = _colon_values(_scalar(start), _scalar(step), _scalar(stop))
    arr = np.array(vals, dtype=np.float64).reshape((len(vals), 1))
    if ischar:
        return Char(arr)
    if cls != "double":
        return _finish(arr, cls)
    return _box(arr) if len(vals) == 1 else arr


def frange(a, b):
    """the values of a:b for a for loop (without making the array)"""
    a = _scalar(a)
    b = _scalar(b)
    if a == _math.floor(a) and _math.isfinite(a) and b == b:
        if b == _math.inf:
            raise _err("Maximum variable size allowed by the program is exceeded.")
        return map(float, range(int(a), int(_math.floor(b)) + 1)) if b >= a else iter(())
    return iter(_colon_values(a, 1.0, b))


def frange3(a, d, b):
    for x in _colon_values(_scalar(a), _scalar(d), _scalar(b)):
        yield x


def columns(v):
    """the values a for loop takes: the columns of v"""
    t = type(v)
    if t is float or t is bool or t is complex:
        yield v
        return
    d = _dims(v)
    if _numel(v) == 0:
        return
    r = d[0]
    ncol = _numel(v) // r if r else 0
    if t is np.ndarray or t is Char:
        flat = _arr(v).reshape(-1)
        for j in range(ncol):
            col = flat[j * r:(j + 1) * r].reshape((1, r)).copy()
            yield Char(col) if t is Char else _box(col)
        return
    if t is Cell or t is Struct or t is StrArr:
        for j in range(ncol):
            yield v._like([cp(x) for x in v.a[j * r:(j + 1) * r]], (r, 1))
        return
    yield v

# ------------------------------------------------------------------ char arrays and strings


class Char:
    """A char array: its character codes, stored as numeric arrays are."""
    __slots__ = ("a",)

    def __init__(self, s):
        if type(s) is str:
            n = len(s)
            if n == 0:
                self.a = np.zeros((0, 0))
            else:
                self.a = np.array([float(ord(c)) for c in s]).reshape((n, 1))
        else:
            a = np.asarray(s, dtype=np.float64)
            if a.ndim < 2:
                a = a.reshape((-1, 1))
            self.a = _canon(a)

    def text(self):
        """all of it as a Python string (column-major)"""
        return "".join([chr(int(c)) for c in self.a.reshape(-1)])

    def rows(self):
        d = _dims(self)
        r = d[0]
        c = _prod(d[1:])
        flat = self.a.reshape(-1)
        return ["".join([chr(int(flat[j * r + i])) for j in range(c)]) for i in range(r)]

    def __repr__(self):
        return "Char(%r)" % self.text()


def _rows_char(rows):
    """a char matrix from equal-length Python strings"""
    if not rows:
        return Char("")
    n = len(rows[0])
    a = np.zeros((n, len(rows)))
    for i, s in enumerate(rows):
        for j, ch in enumerate(s):
            a[j, i] = ord(ch)
    return Char(a)


class Str:
    """A string scalar ("abc")."""
    __slots__ = ("s",)

    def __init__(self, s):
        self.s = s

    def __repr__(self):
        return "Str(%r)" % self.s


class StrArr:
    """A string array (["a" "b"]): Python strings (None: <missing>), column-major."""
    __slots__ = ("shape", "a")

    def __init__(self, a, shape):
        self.a = a
        self.shape = tuple(shape)

    def _like(self, a, shape):
        return _strarr(a, shape)


def _strarr(a, shape):
    if _prod(shape) == 1:
        return Str(a[0])
    return StrArr(a, shape)


def _text(v, what="argument"):
    """a char row, string or cellstr element as a Python string"""
    t = type(v)
    if t is Char:
        return v.text() if v.a.shape[-1] <= 1 or v.a.ndim == 2 and v.a.shape[1] == 1 else "".join(v.rows())
    if t is Str:
        return v.s
    if t is StrArr and len(v.a) == 1:
        return v.a[0]
    raise _err("Expected a character vector or string %s, not %s." % (what, class_(v)))


def _istext(v):
    return type(v) is Char or type(v) is Str


def _str_plus(a, b):
    def s(v):
        if type(v) is Str:
            return v.s
        if type(v) is Char:
            return v.text()
        if type(v) is float or type(v) is bool or type(v) is np.ndarray and v.size == 1:
            return _num2str_g(_scalar(v))
        raise _err("Operator '+' is not supported for operands of type '%s'." % class_(v))
    if type(a) is StrArr or type(b) is StrArr:
        A = a if type(a) is StrArr else None
        B = b if type(b) is StrArr else None
        base = A or B
        out = []
        for k in range(len(base.a)):
            x = A.a[k] if A else s(a)
            y = B.a[k] if B else s(b)
            out.append(x + y)
        return StrArr(out, base.shape)
    return Str(s(a) + s(b))


def _str_cmp(a, b, f, name):
    def vals(v):
        if type(v) is Str:
            return [v.s], (1, 1)
        if type(v) is StrArr:
            return v.a, v.shape
        if type(v) is Char:
            return [v.text()], (1, 1)
        if type(v) is Cell:
            return [_text(x) for x in v.a], v.shape
        raise _err("Comparison between string and %s is not supported." % class_(v))
    A, da = vals(a)
    B, db = vals(b)
    if len(A) == 1:
        out = [f(A[0], y) for y in B]
        shape = db
    elif len(B) == 1:
        out = [f(x, B[0]) for x in A]
        shape = da
    else:
        if da != db:
            raise _err("Arrays have incompatible sizes for this operation.")
        out = [f(x, y) for x, y in zip(A, B)]
        shape = da
    return _box(np.array(out, dtype=bool).reshape(_stored(shape)))

# ------------------------------------------------------------------ cells and structs


class Cell:
    """A cell array: its elements in column-major order."""
    __slots__ = ("shape", "a")

    def __init__(self, a, shape):
        self.a = a
        self.shape = _canon_dims(shape)

    def _like(self, a, shape):
        return Cell(a, shape)


def _canon_dims(d):
    d = list(d)
    while len(d) > 2 and d[-1] == 1:
        d.pop()
    while len(d) < 2:
        d.append(1)
    return tuple(d)


def _empty_double():
    return np.zeros((0, 0))


class Struct:
    """A struct array: field names in order, and one dict per element (column-major)."""
    __slots__ = ("shape", "fields", "a")

    def __init__(self, a, shape, fields):
        self.a = a
        self.shape = _canon_dims(shape)
        self.fields = fields

    def _like(self, a, shape):
        return Struct(a, shape, list(self.fields))


def _struct1(d):
    return Struct([d], (1, 1), list(d.keys()))


class MException:
    """A caught error (try ... catch err)."""
    __slots__ = ("identifier", "message", "stack", "cause")

    def __init__(self, identifier, message):
        self.identifier = identifier
        self.message = message
        self.stack = Struct([], (0, 1), ["file", "name", "line"])
        self.cause = Cell([], (0, 1))


def caught(e):
    if isinstance(e, MatlabError) and getattr(e, "_mexc", None) is not None:
        return e._mexc
    return MException(_identifier(e), _message(e))


def cp(v):
    """a copy of a value another variable or container holds"""
    t = type(v)
    if t is float or t is bool or t is complex or t is Str:
        return v
    if t is np.ndarray:
        return v.copy()
    if t is Char:
        c = Char.__new__(Char)
        c.a = v.a.copy()
        return c
    if t is Cell:
        return Cell([cp(x) for x in v.a], v.shape)
    if t is Struct:
        return Struct([{k: cp(x) for k, x in d.items()} for d in v.a], v.shape, list(v.fields))
    if t is StrArr:
        return StrArr(list(v.a), v.shape)
    if t is dict:
        # (a struct array's element)
        return {k: cp(x) for k, x in v.items()}
    if isinstance(v, Undef):
        raise _undefined(v.name)
    return v

# ------------------------------------------------------------------ functions and handles


class Builtin:
    """A built-in function: f(nargout, *args)."""
    __slots__ = ("f", "name")

    def __init__(self, f, name):
        self.f = f
        self.name = name

    def call(self, nargout, args):
        return self.f(nargout, *args)

    def __repr__(self):
        return "<built-in %s>" % self.name


class Function:
    """A function defined in MATLAB code: f(nargout, *args)."""
    __slots__ = ("f", "name", "nin", "nout", "varargin", "varargout")

    def __init__(self, f, name, nin, nout, varargin, varargout):
        self.f = f
        self.name = name
        self.nin = nin
        self.nout = nout
        self.varargin = varargin
        self.varargout = varargout

    def call(self, nargout, args):
        if nargout > self.nout and not self.varargout and not (nargout == 1 and self.nout == 0):
            raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
        return self.f(nargout, *args)

    def __repr__(self):
        return "<function %s>" % self.name


class Anon:
    """An anonymous function @(x) ...: its parameters' count and its text."""
    __slots__ = ("f", "text", "n")

    def __init__(self, f, text, n):
        self.f = f
        self.text = text
        self.n = n

    def call(self, nargout, args):
        if len(args) > self.n:
            raise _err("Too many input arguments.", "MATLAB:TooManyInputs")
        return self.f(nargout, *args)


class Handle:
    """A handle to a named function (@sin): resolved when first called."""
    __slots__ = ("target", "name")

    def __init__(self, target, name):
        self.target = target
        self.name = name

    def call(self, nargout, args):
        if self.target is None:
            self.target = fn(self.name)
        return self.target.call(nargout, args)


def handle(name):
    return Handle(None, name)


_CALLABLE = (Builtin, Function, Anon, Handle)


def _iscallable(v):
    t = type(v)
    return t is Builtin or t is Function or t is Anon or t is Handle


def _call(f, args, nargout=1):
    """call a function value with Python arguments, for one result"""
    r = f.call(nargout, args)
    if nargout == 1 and r is NOVAL:
        raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
    return r


_B = {}  # the built-in functions, by name


def _bi(*names):
    """a built-in taking (nargout, *args)"""
    def deco(f):
        for n in names:
            _B[n] = Builtin(f, n)
        return f
    return deco


def _bs(*names):
    """a built-in of the arguments only, with one result"""
    def deco(f):
        def g(nargout, *args):
            r = f(*args)
            return NOVAL if r is None else r
        for n in names:
            _B[n] = Builtin(g, n)
        return f
    return deco


_main = [None]


def _workspace():
    m = _sys.modules.get("__main__")
    return m.__dict__ if m is not None else {}


def fn(name):
    """the function a name refers to, when the code runs"""
    ws = _workspace()
    v = ws.get(name)
    if type(v) is Function:
        return v
    b = _B.get(name)
    if b is not None:
        return b
    f = _from_path(name)
    if f is not None:
        return f
    raise _undefined(name)


_path_cache = {}


def _from_path(name):
    """a function in name.m in the program's folder (or on sys.path)"""
    if name in _path_cache:
        return _path_cache[name]
    _path_cache[name] = None
    host = _sys.modules.get("_matlab_files")
    if host is None:
        try:
            import _matlab_files as host
        except ImportError:
            return None
    f = host.load(name)
    _path_cache[name] = f
    return f


def val(v):
    """a name's value: a function named without arguments is called"""
    t = type(v)
    if t is Builtin or t is Function:
        return _call(v, [], 1)
    if isinstance(v, Undef):
        raise _undefined(v.name)
    return v


def capf(v, name):
    """a name an anonymous function captured: a value, or (NOVAR) a function"""
    if v is NOVAR:
        return fn(name)
    return v


def bare(v, name, show):
    """`name` alone as a statement: a workspace variable is displayed, a function called"""
    t = type(v)
    if t is Builtin or t is Function:
        return v.call(0, [])
    if show:
        display(name, v)
    return NOVAL


def paren(obj, args, nargout=1):
    """obj(args): a call, or indexing"""
    t = type(obj)
    if t is np.ndarray and nargout <= 1:
        # (fast paths: one element, by one or two scalar subscripts)
        n = len(args)
        if n == 1 and type(args[0]) is float:
            i = int(args[0])
            if i == args[0] and 0 < i <= obj.size:
                x = obj.item(i - 1)
                tx = type(x)
                if tx is float or tx is bool:
                    return x
                return _box1(x, obj)
        elif n == 2 and obj.ndim == 2 and type(args[0]) is float and type(args[1]) is float:
            i = int(args[0])
            j = int(args[1])
            if i == args[0] and j == args[1] and 0 < i <= obj.shape[1] and 0 < j <= obj.shape[0]:
                x = obj.item(j - 1, i - 1)
                tx = type(x)
                if tx is float or tx is bool:
                    return x
                return _box1(x, obj)
    if t is Builtin or t is Function or t is Anon or t is Handle:
        r = obj.call(nargout, args)
        if nargout == 1 and r is NOVAL:
            raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
        return r
    if nargout > 1:
        return [index(obj, args)] + [NOVAL] * (nargout - 1)
    return index(obj, args)


call = paren


def nout(r, n):
    """the n values of a multiple assignment"""
    if type(r) is list:
        if len(r) < n or any(x is NOVAL for x in r[:n]):
            raise _err("Insufficient number of outputs from right hand side of equal sign to satisfy assignment.", "MATLAB:needMoreRhsOutputs")
        return r
    if n == 1 and r is not NOVAL:
        return [r]
    raise _err("Insufficient number of outputs from right hand side of equal sign to satisfy assignment.", "MATLAB:needMoreRhsOutputs")


def inargs(a, names, varargin, name):
    if len(a) > len(names) and not varargin:
        raise _err("Too many input arguments.", "MATLAB:TooManyInputs")
    if len(names) == 0:
        return []
    out = list(a[:len(names)])
    for k in range(len(out), len(names)):
        out.append(Undef(names[k]))
    return out


def varargin_(a, n):
    return Cell(list(a[n:]), (1, len(a) - n))


def nargs(x):
    if type(x) is tuple or type(x) is list:
        return float(len(x))
    return float(x)


def ret(nargout, outs, name, varargout):
    """a function's outputs, for nargout of them"""
    if varargout:
        va = outs[-1]
        outs = outs[:-1]
        if isinstance(va, Undef):
            extra = []
        elif type(va) is Cell:
            extra = list(va.a)
        else:
            raise _err("The value assigned to output 'varargout' must be a cell array.")
        outs = outs + extra
    if nargout <= 1:
        if not outs:
            if nargout == 1:
                raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
            return NOVAL
        v = outs[0]
        if isinstance(v, Undef):
            if nargout == 0:
                return NOVAL
            raise _err("Output argument \"%s\" (and possibly others) not assigned a value in the execution with \"%s\" function." % (v.name, name), "MATLAB:unassignedOutputs")
        return v
    if len(outs) < nargout:
        raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
    for v in outs[:nargout]:
        if isinstance(v, Undef):
            raise _err("Output argument \"%s\" (and possibly others) not assigned a value in the execution with \"%s\" function." % (v.name, name), "MATLAB:unassignedOutputs")
    return list(outs[:nargout])

# ------------------------------------------------------------------ globals and persistents

_globals = {}
_persistents = {}


def global_get(name):
    if name not in _globals:
        _globals[name] = _empty_double()
    return _globals[name]


def global_set(name, v):
    _globals[name] = v


def persistent_get(fname, name):
    d = _persistents.setdefault(fname, {})
    if name not in d:
        d[name] = _empty_double()
    return d[name]


def persistent_set(fname, name, v):
    _persistents.setdefault(fname, {})[name] = v

# ------------------------------------------------------------------ indexing


def _bad_index(x):
    if x != x or (x != _math.floor(x)) or x < 1:
        if x == 0.0:
            return _err("Index in position 1 is invalid. Array indices must be positive integers or logical values.", "MATLAB:index:expected_positive_integer")
        return _err("Array indices must be positive integers or logical values.", "MATLAB:badsubscript")
    return None


def _ivec(arg, n, pos, grow):
    """an index argument as 0-based positions (int64 ndarray, in order) and the
    dimensions of the index (for the shape of a linear index's result)"""
    t = type(arg)
    if arg is COLON:
        return np.arange(n, dtype=np.int64), (n, 1), True
    if t is float:
        k = int(arg)
        if k != arg or k < 1:
            raise _bad_index(arg) or _err("Array indices must be positive integers or logical values.")
        if k > n and not grow:
            raise _oob(pos, n)
        return np.array([k - 1], dtype=np.int64), (1, 1), False
    if t is bool or (t is np.ndarray and arg.dtype.kind == "b"):
        m = _arr(arg).reshape(-1)
        idx = np.nonzero(m)[0].astype(np.int64)
        if idx.size and idx[-1] >= n and not grow:
            raise _oob(pos, n)
        d = _dims(arg)
        shape = (1, idx.size) if (len(d) == 2 and d[0] == 1) else (idx.size, 1)
        return idx, shape, False
    if t is Str or t is StrArr or t is Cell or t is Struct or _iscallable(arg):
        raise _err("Unable to use a value of type %s as an index." % class_(arg), "MATLAB:badsubscript")
    a = _arr(arg)
    if a.dtype.kind == "c":
        raise _err("Array indices must be positive integers or logical values.", "MATLAB:badsubscript")
    f = a.reshape(-1)
    if f.dtype.kind == "f":
        if f.size and (np.any(f != np.floor(f)) or np.any(f < 1)):
            bad = f[(f != np.floor(f)) | (f < 1)][0]
            raise _bad_index(float(bad)) or _err("Array indices must be positive integers or logical values.")
        idx = f.astype(np.int64) - 1
    else:
        if f.size and np.any(f < 1):
            raise _err("Array indices must be positive integers or logical values.", "MATLAB:badsubscript")
        idx = f.astype(np.int64) - 1
    if idx.size and not grow:
        mx = int(np.max(idx))
        if mx >= n:
            raise _oob(pos, n)
    return idx, _dims(arg), False


def _oob(pos, n):
    if pos < 0:
        return _err("Index exceeds the number of array elements. Index must not exceed %d." % n, "MATLAB:index:exceedsdims")
    return _err("Index in position %d exceeds array bounds. Index must not exceed %d." % (pos + 1, n), "MATLAB:index:exceedsdims")


def _positions(dims, args):
    """0-based linear positions (in the result's column-major order, as a
    stored-shape array) and the result's dimensions, for v(args)"""
    n = len(args)
    if n == 0:
        total = _prod(dims)
        return np.arange(total, dtype=np.int64).reshape(_stored(dims)), dims
    if n == 1:
        total = _prod(dims)
        idx, idims, colon_ = _ivec(args[0], total, -1, False)
        if colon_:
            out = (total, 1)
        else:
            src_vec = len(dims) == 2 and (dims[0] == 1 or dims[1] == 1)
            ivec = len(idims) == 2 and (idims[0] == 1 or idims[1] == 1)
            if src_vec and ivec and not (dims[0] == 1 and dims[1] == 1):
                out = (1, idx.size) if dims[0] == 1 else (idx.size, 1)
            else:
                out = idims
        return idx.reshape(_stored(out)), out
    d = list(dims)
    if len(d) < n:
        d = d + [1] * (n - len(d))
    elif len(d) > n:
        d = d[:n - 1] + [_prod(d[n - 1:])]
    vecs = []
    for k in range(n):
        idx, _, _ = _ivec(args[k], d[k], k, False)
        vecs.append(idx)
    out = tuple(v.size for v in vecs)
    pos = _combine(vecs, d)
    return pos, out


def _combine(vecs, d):
    """the linear positions of the subscript vectors' product (stored shape)"""
    n = len(vecs)
    stride = 1
    pos = None
    for k in range(n):
        shape = [1] * n
        shape[n - 1 - k] = vecs[k].size
        term = vecs[k].reshape(shape) * stride
        pos = term if pos is None else pos + term
        stride *= d[k]
    return _canon(np.ascontiguousarray(pos))


def index(obj, args):
    """obj(args)"""
    t = type(obj)
    # fast paths: one or two scalar subscripts of an array
    if t is np.ndarray and len(args) <= 2 and type(args[0]) is float and (len(args) == 1 or type(args[1]) is float):
        if len(args) == 1:
            k = int(args[0])
            if k == args[0] and 1 <= k <= obj.size:
                return _box1(obj.reshape(-1)[k - 1], obj)
        elif obj.ndim == 2:
            i = int(args[0])
            j = int(args[1])
            if i == args[0] and j == args[1] and 1 <= i <= obj.shape[1] and 1 <= j <= obj.shape[0]:
                return _box1(obj[j - 1, i - 1], obj)
    if t is float or t is bool or t is complex:
        for a in args:
            if not (a is COLON or (type(a) is float and a == 1.0) or a is True):
                break
        else:
            return obj
        pos, out = _positions((1, 1), args)
        return _box(np.array([obj] * pos.size, dtype=_arr(obj).dtype).reshape(_stored(out)))
    if t is np.ndarray or t is Char:
        a = _arr(obj)
        pos, out = _positions(_dims(obj), args)
        r = a.reshape(-1)[pos.reshape(-1)].reshape(_stored(out))
        if t is Char:
            return Char(r)
        return _box(r)
    if t is Cell or t is Struct or t is StrArr:
        pos, out = _positions(obj.shape, args)
        items = [cp(obj.a[int(k)]) for k in pos.reshape(-1)]
        return obj._like(items, out)
    if t is Str:
        pos, out = _positions((1, 1), args)
        if pos.size == 1:
            return obj
        return _strarr([obj.s] * pos.size, out)
    if t is MException:
        pos, out = _positions((1, 1), args)
        return obj
    if isinstance(obj, Undef):
        raise _undefined(obj.name)
    raise _err("Unable to index a value of type %s." % class_(obj))


def _box1(x, a):
    """one element of array a as a MATLAB value"""
    k = a.dtype.kind
    if k == "f" and a.dtype.itemsize == 8:
        return float(x)
    if k == "b":
        return bool(x)
    if k == "c" and a.dtype.itemsize == 16:
        z = complex(x)
        return z if z.imag != 0 else z.real
    return np.array([[x]], dtype=a.dtype)


def end(obj, k, n):
    """`end` in the k-th of n subscripts of obj"""
    if obj is None or isinstance(obj, Undef):
        return 0.0
    if _iscallable(obj):
        raise _err("'end' cannot be used with a function call.")
    d = _dims(obj)
    if n == 1:
        return float(_prod(d))
    if k < n - 1:
        return float(d[k]) if k < len(d) else 1.0
    return float(_prod(d[k:])) if k < len(d) else 1.0


def brace_cs(obj, args):
    """c{args}: the elements, as a list"""
    t = type(obj)
    if t is Cell:
        if len(args) == 1 and type(args[0]) is float:
            k = int(args[0])
            if k == args[0] and 1 <= k <= len(obj.a):
                return [obj.a[k - 1]]
        pos, out = _positions(obj.shape, args)
        return [obj.a[int(k)] for k in pos.reshape(-1)]
    if t is StrArr or t is Str:
        r = index(obj, args)
        return [Char(r.s)] if type(r) is Str else [Char(s) for s in r.a]
    if isinstance(obj, Undef):
        raise _undefined(obj.name)
    raise _err("Brace indexing is not supported for variables of this type.", "MATLAB:cellRefFromNonCell")


def brace(obj, args):
    if type(obj) is Cell and len(args) == 1 and type(args[0]) is float:
        k = int(args[0])
        if k == args[0] and 1 <= k <= len(obj.a):
            return obj.a[k - 1]
    vals = brace_cs(obj, args)
    if not vals:
        raise _err("Index exceeds the number of array elements. Index must not exceed %d." % _numel(obj), "MATLAB:index:exceedsdims")
    return vals[0]


def fieldname(v):
    return _text(v, "field name")


def field_cs(obj, name):
    t = type(obj)
    if t is Struct:
        if name not in obj.fields:
            raise _err("Unrecognized field name \"%s\"." % name, "MATLAB:nonExistentField")
        return [d[name] for d in obj.a]
    if t is MException:
        if name in ("identifier", "message", "stack", "cause"):
            v = getattr(obj, name)
            return [Char(v) if type(v) is str else v]
        raise _err("Unrecognized property \"%s\" for class \"MException\"." % name)
    if isinstance(obj, Undef):
        raise _undefined(obj.name)
    raise _err("Dot indexing is not supported for variables of this type.", "MATLAB:structRefFromNonStruct")


def field(obj, name):
    if type(obj) is Struct and len(obj.a) == 1:
        d = obj.a[0]
        if name in d:
            return d[name]
    vals = field_cs(obj, name)
    if not vals:
        raise _err("Expected one output from a curly brace or dot indexing expression, but there were 0 results.")
    return vals[0]


def cs_list(*vals):
    return list(vals)

# ------------------------------------------------------------------ assignment


def peek(base, path):
    """the value at a path (for `end` in an assignment's subscripts); [] if it is not there"""
    cur = base
    for kind, arg in path:
        if cur is None or isinstance(cur, Undef):
            return None
        try:
            if kind == "f":
                if type(cur) is not Struct or arg not in cur.fields:
                    return None
                cur = field(cur, arg)
            elif kind == "p":
                cur = index(cur, arg)
            else:
                cur = brace(cur, arg)
        except MatlabError:
            return None
    return cur


def assign(base, path, v):
    """base with the value at path set to v (path: ("f", name), ("p", args), ("b", args))"""
    if isinstance(base, Undef):
        base = None
    return _asg(base, path, 0, v)


def _asg(cur, path, i, v):
    kind, arg = path[i]
    last = i == len(path) - 1
    if kind == "f":
        s = _as_struct(cur)
        if len(s.a) != 1:
            if last and len(s.a) == 0:
                s = Struct([{f: _empty_double() for f in s.fields}], (1, 1), list(s.fields))
            else:
                raise _err("Scalar structure required for this assignment.")
        d = s.a[0]
        if arg not in d:
            s.fields.append(arg)
            for e in s.a:
                e[arg] = _empty_double()
        d[arg] = v if last else _asg(d[arg] if not _isempty_double(d[arg]) else None, path, i + 1, v)
        return s
    if kind == "p":
        if last:
            return _assign_paren(cur, arg, v)
        # x(i).f = v, x(i){...}: the element, changed, put back
        try:
            inner = index(cur, arg) if cur is not None else None
        except MatlabError:
            inner = None
        if inner is not None and _isempty_double(inner):
            inner = None
        nv = _asg(inner, path, i + 1, v)
        if cur is None and type(nv) is Struct:
            cur = Struct([], (0, 0), list(nv.fields))
        return _assign_paren(cur, arg, nv)
    # brace
    c = cur
    if c is None or _isempty_double(c):
        c = Cell([], (0, 0))
    if type(c) is not Cell:
        raise _err("Unable to perform assignment because brace indexing is not supported for variables of this type.", "MATLAB:cellAssToNonCell")
    if last:
        return _assign_paren(c, arg, Cell([v], (1, 1)), brace=True)
    try:
        inner = brace(c, arg)
    except MatlabError:
        inner = None
    if inner is not None and _isempty_double(inner):
        inner = None
    nv = _asg(inner, path, i + 1, v)
    return _assign_paren(c, arg, Cell([nv], (1, 1)), brace=True)


def set1(cur, i, v):
    """cur(i) = v"""
    if type(cur) is np.ndarray and type(i) is float and type(v) is float and cur.dtype == np.float64:
        k = int(i)
        if k == i:
            if 0 < k <= cur.size:
                cur.reshape(-1)[k - 1] = v
                return cur
            if k == cur.size + 1 and cur.ndim == 2:
                g = _grow1(cur, k, v)
                if g is not None:
                    return g
    return _assign_paren(None if isinstance(cur, Undef) else cur, [i], v)


def set2(cur, i, j, v):
    """cur(i, j) = v"""
    if type(cur) is np.ndarray and type(i) is float and type(j) is float and type(v) is float and cur.dtype == np.float64 and cur.ndim == 2:
        a = int(i)
        b = int(j)
        if a == i and b == j and 0 < a <= cur.shape[1] and 0 < b <= cur.shape[0]:
            cur[b - 1, a - 1] = v
            return cur
    return _assign_paren(None if isinstance(cur, Undef) else cur, [i, j], v)


def _isempty_double(v):
    return type(v) is np.ndarray and v.size == 0 and v.dtype == np.float64 and v.shape == (0, 0)


def _as_struct(cur):
    if cur is None or _isempty_double(cur):
        return Struct([{}], (1, 1), [])
    if type(cur) is Struct:
        return cur
    raise _err("Unable to perform assignment because dot indexing is not supported for variables of this type.", "MATLAB:dotAssignToNonStruct")


def _grow_dims(dims, args, vdims):
    """the dimensions after an assignment through args (grown as needed)"""
    n = len(args)
    if n == 1:
        a = args[0]
        total = _prod(dims)
        if a is COLON:
            return dims
        idx, _, _ = _ivec(a, total, -1, True)
        need = int(np.max(idx)) + 1 if idx.size else 0
        if need <= total:
            return dims
        if total == 0:
            if len(dims) == 2 and dims[1] == 0 and dims[0] > 1:
                return (need, 1)
            return (1, need)
        if len(dims) == 2 and dims[0] == 1:
            return (1, need)
        if len(dims) == 2 and dims[1] == 1:
            return (need, 1)
        raise _err("Attempt to grow array along ambiguous dimension.", "MATLAB:indexed_matrix_cannot_be_resized")
    d = list(dims)
    if len(d) < n:
        d = d + [1] * (n - len(d))
    elif len(d) > n:
        # (the last subscript spans the remaining dimensions: no growth there)
        d = d[:n - 1] + [_prod(d[n - 1:])]
        grown = list(d)
        for k in range(n):
            a = args[k]
            if a is COLON:
                continue
            idx, _, _ = _ivec(a, d[k], k, True)
            if idx.size and int(np.max(idx)) + 1 > d[k]:
                if k == n - 1:
                    raise _err("Attempt to grow array along ambiguous dimension.")
                grown[k] = int(np.max(idx)) + 1
        return tuple(list(grown[:n - 1]) + list(dims[n - 1:])) if grown[:n - 1] != d[:n - 1] else dims
    # vdims: the right side's non-singleton dimensions, for colons over empty dimensions
    vnon = [x for x in vdims if x != 1]
    for k in range(n):
        a = args[k]
        if a is COLON:
            if d[k] == 0 and _prod(dims) == 0:
                d[k] = vnon.pop(0) if vnon else 1
            elif vnon and d[k] == vnon[0]:
                vnon.pop(0)
            continue
        idx, _, _ = _ivec(a, d[k], k, True)
        if idx.size:
            need = int(np.max(idx)) + 1
            if need > d[k]:
                d[k] = need
        if idx.size > 1 and vnon and idx.size == vnon[0]:
            vnon.pop(0)
    return tuple(d)


def _resize(cur, dims):
    """cur (array, Char, Cell or Struct) padded to dims (with zeros, [], ...)"""
    old = _dims(cur)
    if tuple(old) == tuple(dims):
        return cur
    nd = max(len(old), len(dims))
    o = list(old) + [1] * (nd - len(old))
    nw = list(dims) + [1] * (nd - len(dims))
    t = type(cur)
    if t is np.ndarray or t is Char:
        a = _arr(cur)
        out = np.zeros(tuple(reversed(nw)), dtype=a.dtype)
        if a.size:
            src = a.reshape(tuple(reversed(o)))
            sl = tuple(slice(0, x) for x in reversed(o))
            out[sl] = src
        out = _canon(out)
        return Char(out) if t is Char else out
    # containers: positions of the old elements in the new layout
    fill = (lambda: _empty_double()) if t is Cell else None
    total = _prod(nw)
    if t is Struct:
        items = [{f: _empty_double() for f in cur.fields} for _ in range(total)]
    elif t is StrArr:
        items = [None] * total
    else:
        items = [_empty_double() for _ in range(total)]
    if cur.a:
        vecs = [np.arange(x, dtype=np.int64) for x in o]
        pos = _combine(vecs, nw).reshape(-1)
        for k, p in enumerate(pos):
            items[int(p)] = cur.a[k]
    return cur._like(items, tuple(nw))


def _assign_paren(cur, args, v, brace=False):
    """cur(args) = v (brace: v is a 1-by-1 Cell holding the value of cur{args} = v)"""
    if isinstance(cur, Undef):
        cur = None
    tv = type(v)
    # deletion: x(i) = []
    if not brace and tv is np.ndarray and v.size == 0 and v.shape == (0, 0) and v.dtype == np.float64 and cur is not None and not _isempty_double(cur) or (not brace and tv is np.ndarray and v.size == 0 and v.shape == (0, 0) and cur is not None and type(cur) is Cell):
        return _delete(cur, args)
    # fast path: a(k) = scalar, within bounds
    if cur is not None and type(cur) is np.ndarray and tv is float and cur.dtype == np.float64 and len(args) <= 2 and type(args[0]) is float:
        if len(args) == 1:
            k = int(args[0])
            if k == args[0] and 1 <= k <= cur.size:
                cur.reshape(-1)[k - 1] = v
                return cur
            if k == args[0] and k == cur.size + 1 and cur.ndim == 2:
                g = _grow1(cur, k, v)
                if g is not None:
                    return g
        elif type(args[1]) is float and cur.ndim == 2:
            i = int(args[0])
            j = int(args[1])
            if i == args[0] and j == args[1] and 1 <= i <= cur.shape[1] and 1 <= j <= cur.shape[0]:
                cur[j - 1, i - 1] = v
                return cur
    if cur is None or (_isempty_double(cur) and not brace):
        # ([] takes the class of what is assigned into it)
        cur = _empty_like(v)
    elif brace and type(cur) is not Cell:
        raise _err("Unable to perform assignment because brace indexing is not supported for variables of this type.")
    tc = type(cur)
    # scalars become arrays
    if tc is float or tc is bool or tc is complex:
        cur = _arr(cur).copy()
        tc = np.ndarray
    if tc is Str:
        cur = StrArr([cur.s], (1, 1))
        tc = StrArr
    vd = _dims(v)
    dims = _dims(cur)
    nd = _grow_dims(dims, args, vd)
    if tuple(nd) != tuple(dims):
        cur = _resize(cur, nd)
        dims = _dims(cur)
    pos, out = _positions(dims, args)
    pos = pos.reshape(-1)
    nv = _numel(v)
    if nv != 1 and nv != pos.size:
        raise _err("Unable to perform assignment because the indices on the left side are not compatible with the size of the right side.", "MATLAB:subsassigndimmismatch")
    if tc is np.ndarray or tc is Char:
        return _set_numeric(cur, pos, v)
    if tc is Cell:
        if type(v) is not Cell:
            raise _err("Conversion to cell from %s is not possible." % class_(v), "MATLAB:invalidConversion")
        items = v.a
        for k, p in enumerate(pos):
            cur.a[int(p)] = items[0 if nv == 1 else k]
        return cur
    if tc is Struct:
        if type(v) is not Struct:
            raise _err("Conversion to struct from %s is not possible." % class_(v), "MATLAB:invalidConversion")
        for f in v.fields:
            if f not in cur.fields:
                cur.fields.append(f)
                for e in cur.a:
                    e[f] = _empty_double()
        for k, p in enumerate(pos):
            src = v.a[0 if nv == 1 else k]
            if set(src.keys()) != set(cur.fields):
                if len(cur.a) > 1 or nv > 1:
                    if any(f not in src for f in cur.fields):
                        src = dict(src)
                        for f in cur.fields:
                            src.setdefault(f, _empty_double())
            cur.a[int(p)] = dict(src) if nv == 1 and pos.size > 1 else src
        return cur
    if tc is StrArr:
        vals = _strings_of(v)
        for k, p in enumerate(pos):
            cur.a[int(p)] = vals[0 if nv == 1 else k]
        return _strarr(cur.a, cur.shape)
    raise _err("Unable to perform indexed assignment on a value of type %s." % class_(cur))


# Vectors grown one element at a time (x(end+1) = v) are views of a buffer
# with room to spare, doubled when full, so that growing is not quadratic.
# Only buffers made here are grown into, and a value is never shared by two
# variables (cp), so the room past a view's end belongs to no other value.
_GROW = {}


def _grow1(cur, k, v):
    n = k - 1
    if cur.shape[1] == 1 or n == 0:
        shape = (k, 1)  # a row (or [] becoming one)
    elif cur.shape[0] == 1 and n > 1:
        shape = (1, k)  # a column
    else:
        return None
    base = cur.base
    buf = base if base is not None and _GROW.get(id(base)) is base and base.size >= k else None
    if buf is None:
        buf = np.zeros(max(16, 2 * k))
        if n:
            buf[:n] = cur.reshape(-1)
        _GROW[id(buf)] = buf
        if len(_GROW) > 64:
            del _GROW[next(iter(_GROW))]
    buf[n] = v
    return buf[:k].reshape(shape)


def _strings_of(v):
    if type(v) is Str:
        return [v.s]
    if type(v) is StrArr:
        return list(v.a)
    if type(v) is Char:
        return [v.text()]
    if type(v) is float:
        return [_num2str_g(v)]
    raise _err("Conversion to string from %s is not possible." % class_(v))


def _empty_like(v):
    t = type(v)
    if t is Cell:
        return Cell([], (0, 0))
    if t is Struct:
        return Struct([], (0, 0), list(v.fields))
    if t is Char:
        return Char("")
    if t is Str or t is StrArr:
        return StrArr([], (0, 0))
    if t is np.ndarray:
        return np.zeros((0, 0), dtype=v.dtype)
    if t is bool:
        return np.zeros((0, 0), dtype=bool)
    if t is complex:
        return np.zeros((0, 0), dtype=np.complex128)
    if _iscallable(v):
        raise _err("Unable to perform assignment: function handles cannot be in arrays; use a cell array.")
    return np.zeros((0, 0))


def _set_numeric(cur, pos, v):
    """the numeric (or char) array cur with elements pos set from v: the
    array keeps its class, the values are converted to it (as MATLAB does)"""
    tc = type(cur)
    a = _arr(cur)
    tv = type(v)
    if tv is Cell or tv is Struct or tv is Str or tv is StrArr or _iscallable(v):
        raise _err("Conversion to %s from %s is not possible." % (class_(cur), class_(v)), "MATLAB:invalidConversion")
    va = _arr(v)
    out = np.ascontiguousarray(a)
    k = out.dtype.kind
    if va.dtype.kind == "c":
        if np.any(va.imag) and k in "fc":
            if k == "f":
                out = out.astype(np.complex128 if out.dtype.itemsize == 8 else np.complex64)
        else:
            va = np.ascontiguousarray(va.real)
    flat_v = va.reshape(-1)
    k = out.dtype.kind
    if k in "iu":
        if flat_v.dtype.kind not in "iu":
            flat_v = _int_round(flat_v, _dtclass(out.dtype))
    elif k == "b":
        if flat_v.dtype.kind == "f" and np.any(np.isnan(flat_v)):
            raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
        flat_v = flat_v != 0
    flat = out.reshape(-1)
    if flat_v.size == 1:
        flat[pos] = flat_v[0]
    else:
        flat[pos] = flat_v
    if tc is Char:
        return Char(out)
    return _box(out) if out.size == 1 else out


def _delete(cur, args):
    """cur(args) = []"""
    dims = _dims(cur)
    n = len(args)
    total = _prod(dims)
    if n == 1:
        a = args[0]
        if a is COLON:
            keep = np.array([], dtype=np.int64)
        else:
            idx, _, _ = _ivec(a, total, -1, False)
            mask = np.ones(total, dtype=bool)
            mask[idx] = False
            keep = np.nonzero(mask)[0]
        out = (keep.size, 1) if (len(dims) == 2 and dims[1] == 1 and dims[0] != 1) else (1, keep.size)
        if a is COLON:
            out = (0, 0)
        return _take(cur, keep, out)
    d = list(dims) + [1] * max(0, n - len(dims))
    if len(d) > n:
        d = d[:n - 1] + [_prod(d[n - 1:])]
    which = [k for k in range(n) if not (args[k] is COLON or _covers(args[k], d[k]))]
    if len(which) == 0:
        out = list(d)
        out[0] = 0
        return _take(cur, np.array([], dtype=np.int64), tuple(out))
    if len(which) > 1:
        raise _err("A null assignment can have only one non-colon index.", "MATLAB:nullAssignmentNonColonIndex")
    k = which[0]
    idx, _, _ = _ivec(args[k], d[k], k, False)
    mask = np.ones(d[k], dtype=bool)
    mask[idx] = False
    vecs = [np.arange(x, dtype=np.int64) for x in d]
    vecs[k] = np.nonzero(mask)[0]
    pos = _combine(vecs, d).reshape(-1)
    out = list(d)
    out[k] = vecs[k].size
    return _take(cur, pos, tuple(out))


def _covers(a, n):
    try:
        idx, _, _ = _ivec(a, n, 0, False)
    except MatlabError:
        return False
    return idx.size >= n and np.array_equal(np.unique(idx), np.arange(n))


def _take(cur, pos, out):
    t = type(cur)
    if t is np.ndarray or t is Char or t is float or t is bool or t is complex:
        a = _arr(cur)
        r = a.reshape(-1)[pos].reshape(_stored(out))
        return Char(r) if t is Char else (_box(r) if r.size == 1 else _canon(r))
    return cur._like([cur.a[int(p)] for p in pos], out)

# ------------------------------------------------------------------ classes


def class_(v):
    t = type(v)
    if t is float or t is complex:
        return "double"
    if t is bool:
        return "logical"
    if t is np.ndarray:
        return _dtclass(v.dtype)
    if t is Char:
        return "char"
    if t is Str or t is StrArr:
        return "string"
    if t is Cell:
        return "cell"
    if t is Struct:
        return "struct"
    if t is Builtin or t is Function or t is Anon or t is Handle:
        return "function_handle"
    if t is MException:
        return "MException"
    if t is int:
        return "double"
    if isinstance(v, Undef):
        raise _undefined(v.name)
    return t.__name__

# ------------------------------------------------------------------ concatenation


def hcat(vals):
    """[a, b, ...]"""
    if not vals:
        return np.zeros((0, 0))
    n = len(vals)
    if n == 1:
        return cp(vals[0])
    allf = True
    for v in vals:
        if type(v) is not float:
            allf = False
            break
    if allf:
        return np.array(vals).reshape((n, 1))
    return _cat(vals, 2)


def vcat(rows):
    """[a; b; ...] (each already a row)"""
    if len(rows) == 1:
        return cp(rows[0])
    return _cat(rows, 1)


def _cat_class(vals):
    """the class of a concatenation"""
    classes = [class_(v) for v in vals]
    if "cell" in classes:
        return "cell"
    if "struct" in classes:
        return "struct"
    if "string" in classes:
        return "string"
    if "function_handle" in classes:
        raise _err("Nonscalar arrays of function handles are not allowed; use cell arrays instead.")
    for c in classes:
        if c in _INTS:
            return c
    if "char" in classes:
        return "char"
    if "single" in classes:
        return "single"
    if all(c == "logical" for c in classes):
        return "logical"
    return "double"


def _cat(vals, dim):
    """concatenation along MATLAB dimension dim (1 or more)"""
    cls = _cat_class(vals)
    # empty values do not take part (but count for the class)
    parts = [v for v in vals if _numel(v) != 0]
    if not parts:
        v = vals[0]
        if cls == "char":
            return Char("") if type(v) is not Char else v
        return v if cls != "cell" else Cell([], (0, 0))
    if cls == "cell":
        items = [v if type(v) is Cell else Cell([v], (1, 1)) for v in parts]
        return _cat_containers(items, dim, Cell)
    if cls == "struct":
        for v in parts:
            if type(v) is not Struct:
                raise _err("Concatenation of a struct with a value of another type is not possible.")
        f0 = parts[0].fields
        for v in parts[1:]:
            if set(v.fields) != set(f0):
                raise _err("Concatenation of structures requires that their fields be the same.", "MATLAB:catenate:structFieldBad")
        return _cat_containers(parts, dim, Struct)
    if cls == "string":
        items = [v if type(v) is StrArr else StrArr(_strings_of(v), (1, 1)) for v in parts]
        r = _cat_containers(items, dim, StrArr)
        return _strarr(r.a, r.shape)
    arrs = []
    for v in parts:
        a = _arr(v)
        arrs.append(a)
    nd = max(max(a.ndim for a in arrs), dim)
    arrs = [a.reshape((1,) * (nd - a.ndim) + a.shape) if a.ndim < nd else a for a in arrs]
    axis = nd - dim
    ref = arrs[0].shape
    for a in arrs[1:]:
        for ax in range(nd):
            if ax != axis and a.shape[ax] != ref[ax]:
                raise _err("Dimensions of arrays being concatenated are not consistent.", "MATLAB:catenate:dimensionMismatch")
    if cls == "char":
        out = np.concatenate([a.astype(np.float64) if a.dtype.kind != "c" else a.real for a in arrs], axis=axis)
        return Char(out)
    if cls in _INTS:
        conv = [_int_round(a, cls) if a.dtype.kind not in "iu" or a.dtype != _INTS[cls][0] else a for a in arrs]
        return _canon(np.concatenate(conv, axis=axis))
    if cls == "logical":
        return _box(np.concatenate(arrs, axis=axis))
    anyc = any(a.dtype.kind == "c" for a in arrs)
    dt = np.float32 if cls == "single" else np.float64
    if anyc:
        dt = np.complex64 if cls == "single" else np.complex128
    out = np.concatenate([a.astype(dt) for a in arrs], axis=axis)
    return _box(out) if cls == "double" else _canon(out)


def _cat_containers(parts, dim, kind):
    """cells, structs or string arrays joined along dim (through their element numbers)"""
    items = []
    idxs = []
    for v in parts:
        idxs.append(np.arange(len(items), len(items) + len(v.a), dtype=np.int64).reshape(_stored(v.shape)))
        items.extend(v.a)
    nd = max(max(a.ndim for a in idxs), dim)
    idxs = [a.reshape((1,) * (nd - a.ndim) + a.shape) if a.ndim < nd else a for a in idxs]
    axis = nd - dim
    ref = idxs[0].shape
    for a in idxs[1:]:
        for ax in range(nd):
            if ax != axis and a.shape[ax] != ref[ax]:
                raise _err("Dimensions of arrays being concatenated are not consistent.", "MATLAB:catenate:dimensionMismatch")
    pos = _canon(np.concatenate(idxs, axis=axis))
    shape = tuple(reversed(pos.shape))
    flat = [items[int(k)] for k in pos.reshape(-1)]
    if kind is Struct:
        return Struct(flat, shape, list(parts[0].fields))
    if kind is StrArr:
        return StrArr(flat, shape)
    return Cell(flat, shape)


def cell_lit(rows):
    """{a, b; c, d}: each value an element (a cell in it is nested, not joined)"""
    rows = [r for r in rows if r]
    if not rows:
        return Cell([], (0, 0))
    joined = []
    for r in rows:
        parts = [Cell([cp(v)], (1, 1)) for v in r]
        joined.append(_cat_containers(parts, 2, Cell) if len(parts) > 1 else parts[0])
    if len(joined) == 1:
        return joined[0]
    return _cat_containers(joined, 1, Cell)

# ------------------------------------------------------------------ display

_format = {"num": "short", "spacing": "loose"}
_WIDTH = 80


def _fmt_e(x, prec):
    s = "%.*e" % (prec, x)
    return s


def _isint_arr(F):
    return F.size == 0 or bool(np.all(F == np.floor(F)))


def _special(x):
    if x != x:
        return "NaN"
    return "Inf" if x > 0 else "-Inf"


class _NumFmt:
    """how the elements of a real double array print: format short (4
    decimals, fields 10 wide) or long (15 decimals, 20 wide); integers 6
    wide below 1000, else 12; a common scale factor (1.0e+03 *) for a
    matrix outside [0.001, 1000), e-notation for such a scalar"""

    def __init__(self, A, scalar, long_=False):
        F = A[np.isfinite(A)] if A.size else A
        self.scale = None
        self.long = long_
        maxabs = float(np.max(np.abs(F))) if F.size else 0.0
        if _isint_arr(F) and maxabs < 1e9:
            self.kind = "int"
            self.width = 6 if maxabs < 1000 else 12
            return
        self.dec = 15 if long_ else 4
        lo, hi = (1e-3, 100.0) if long_ else (1e-3, 1e3)
        fixw = 20 if long_ else 10
        if lo <= maxabs < hi or maxabs == 0:
            self.kind = "fix"
            self.width = fixw
            return
        if scalar:
            self.kind = "e"
            self.width = 25 if long_ else 13
            return
        ex = int(_math.floor(_math.log10(maxabs)))
        self.scale = 10.0 ** ex
        self.scale_text = "1.0e%+03d" % ex
        self.kind = "fix"
        self.width = fixw

    def fmt(self, x):
        if x != x or x in (_math.inf, -_math.inf):
            return _special(x)
        if self.kind == "int":
            return "%d" % x
        if x == 0:
            return "0"
        if self.scale is not None:
            x = x / self.scale
        if self.kind == "e":
            return "%.*e" % (self.dec, x)
        return "%.*f" % (self.dec, x)


def _fmt_complex_parts(A, scalar):
    """real and imaginary formats of a complex array (MATLAB prints both with decimals)"""
    R = A.real
    I = A.imag
    both = np.concatenate([R.reshape(-1), I.reshape(-1)])
    F = both[np.isfinite(both)]
    maxabs = float(np.max(np.abs(F))) if F.size else 0.0
    long_ = _format["num"] == "long"
    dec = 15 if long_ else 4
    allint = _isint_arr(F)
    if (1e-3 <= maxabs < 1e3) or maxabs == 0 or (allint and maxabs < 1e5):
        def f(x):
            if x != x or x in (_math.inf, -_math.inf):
                return _special(x)
            return "%.*f" % (dec, x)
        return f, None
    if scalar:
        def f(x):
            if x != x or x in (_math.inf, -_math.inf):
                return _special(x)
            return "%.*e" % (dec, x)
        return f, None
    ex = int(_math.floor(_math.log10(maxabs)))
    sc = 10.0 ** ex

    def f(x):
        if x != x or x in (_math.inf, -_math.inf):
            return _special(x)
        return "%.*f" % (dec, x / sc)
    return f, "1.0e%+03d" % ex


def _matrix_rows(cols_text, width, nrows, ncols):
    """the lines of a matrix whose elements are formatted (cols_text[j][i]),
    split into column groups that fit the window"""
    per = max(1, (_WIDTH - 1) // width) if width else ncols
    blocks = []
    if ncols <= per:
        blocks.append("\n".join("".join(cols_text[j][i].rjust(width) for j in range(ncols)) for i in range(nrows)))
        return blocks
    j0 = 0
    while j0 < ncols:
        j1 = min(ncols, j0 + per)
        if j1 - j0 == 1:
            blocks.append("  Column %d" % (j0 + 1))
        else:
            blocks.append("  Columns %d through %d" % (j0 + 1, j1))
        blocks.append("\n".join("".join(cols_text[j][i].rjust(width) for j in range(j0, j1)) for i in range(nrows)))
        j0 = j1
    return blocks


def _pages(v):
    """a value's 2-D pages: (suffix like '(:,:,2)', 2-D stored array)"""
    a = _arr(v)
    d = _dims(v)
    if len(d) <= 2:
        return [("", a)]
    out = []
    r, c = d[0], d[1]
    npages = _prod(d[2:])
    flat = a.reshape((npages, c, r))
    for p in range(npages):
        idx = []
        k = p
        for x in d[2:]:
            idx.append(k % x + 1)
            k //= x
        out.append(("(:,:,%s)" % ",".join(str(i) for i in idx), flat[p]))
    return out


def _numeric_blocks(v):
    """the display of a numeric or logical value: (header blocks, body blocks)"""
    a = _arr(v)
    d = _dims(v)
    cls = class_(v)
    head = []
    numel = a.size
    if numel == 0:
        if cls == "double" and d == (0, 0):
            return [], ["     []"]
        return [], ["  %s empty %s %s" % (_dimstr(d), cls, "matrix" if cls not in ("logical", "char") else "array")]
    if len(d) > 2:
        pages = _pages(v)
        # (every page in the same format)
        blocks = []
        for suffix, p in pages:
            blocks.append(None)
            blocks.append(suffix)
            blocks.extend(_numeric_blocks(_box(np.ascontiguousarray(p)) if p.dtype.kind in "fbc" and p.dtype.itemsize in (1, 8, 16) else p)[1])
        return head, [b for b in blocks if b is not None]
    rows, cols = d
    M = a.T  # MATLAB orientation
    scalar = numel == 1
    if cls == "logical":
        if scalar:
            head.append("  logical")
        else:
            head.append("  %s logical array" % _dimstr(d))
        texts = [["%d" % int(M[i, j]) for i in range(rows)] for j in range(cols)]
        return head, _matrix_rows(texts, 4, rows, cols)
    if cls in _INTS:
        if scalar:
            head.append("  " + cls)
        else:
            head.append("  %s %s %s" % (_dimstr(d), cls, _shape_word(d)))
        texts = [["%d" % int(M[i, j]) for i in range(rows)] for j in range(cols)]
        w = max(len(t) for col in texts for t in col) + 3
        return head, _matrix_rows(texts, w, rows, cols)
    if cls == "single":
        if scalar:
            head.append("  single")
        else:
            head.append("  %s single %s" % (_dimstr(d), _shape_word(d)))
    long_ = _format["num"] == "long"
    if a.dtype.kind == "c":
        f, scale = _fmt_complex_parts(M, scalar)
        parts = []
        for j in range(cols):
            col = []
            for i in range(rows):
                z = complex(M[i, j])
                im = z.imag
                sign = "-" if (im < 0 or (im == 0 and _math.copysign(1, im) < 0)) else "+"
                re_ = "0" if z.real == 0 else f(z.real)
                col.append((re_, sign, f(abs(im)) if im == im else "NaN"))
            parts.append(col)
        wr = max(9 if not long_ else 20, max(len(p[0]) for c in parts for p in c) + 2)
        wi = max(len(p[2]) for c in parts for p in c)
        texts = [["%s %s %si" % (p[0].rjust(wr), p[1], p[2].rjust(wi)) for p in c] for c in parts]
        w = wr + wi + 4
        body = []
        if scale:
            body.append("   %s *" % scale)
        body.extend(_matrix_rows(texts, w, rows, cols))
        return head, body
    A = M.astype(np.float64)
    nf = _NumFmt(A, scalar, long_)
    texts = [[nf.fmt(float(A[i, j])) for i in range(rows)] for j in range(cols)]
    w = nf.width
    longest = max(len(t) for c in texts for t in c)
    if longest + 2 > w:
        w = longest + 3 if nf.kind == "int" else longest + 2
    body = []
    if nf.scale is not None:
        body.append("   %s *" % nf.scale_text)
    body.extend(_matrix_rows(texts, w, rows, cols))
    return head, body


def _shape_word(d):
    if len(d) == 2 and d[0] == 1:
        return "row vector"
    if len(d) == 2 and d[1] == 1:
        return "column vector"
    if len(d) == 2:
        return "matrix"
    return "array"


def _dimstr(d):
    return "×".join(str(x) for x in d)


def _short_scalar(x):
    """a double in format short without its padding (struct fields, cells)"""
    if type(x) is complex:
        f, _ = _fmt_complex_parts(np.array([[x]]), True)
        return "%s %s %si" % (f(x.real), "-" if x.imag < 0 else "+", f(abs(x.imag)))
    nf = _NumFmt(np.array([[x]]), True, _format["num"] == "long")
    return nf.fmt(x)


def _g5(x):
    if x != x or x in (_math.inf, -_math.inf):
        return _special(x)
    if x == _math.floor(x) and abs(x) < 1e15:
        return "%d" % x
    return "%.5g" % x


def _brief(v, in_cell):
    """a value as one item of a struct's or a cell's display"""
    t = type(v)
    d = _dims(v)
    cls = class_(v)
    if t is Char:
        if len(d) == 2 and d[0] == 1:
            return "'%s'" % v.text()
        if d == (0, 0):
            return "0×0 char" if in_cell else "''"
        return "%s char" % _dimstr(d) if in_cell else "[%s char]" % _dimstr(d)
    if t is Str:
        return '"%s"' % v.s
    if t is Cell:
        return "%s cell" % _dimstr(d) if in_cell else "{%s cell}" % _dimstr(d)
    if t is Struct:
        return "%s struct" % _dimstr(d) if in_cell else "[%s struct]" % _dimstr(d)
    if _iscallable(v):
        return func2str_text(v)
    if _isnumlike(v):
        n = _numel(v)
        if n == 0:
            return "%s %s" % (_dimstr(d), cls) if in_cell else "[]"
        if n == 1:
            a = _arr(v).reshape(-1)[0]
            if cls == "logical":
                s = "%d" % int(a)
            elif cls in _INTS:
                s = "%d" % int(a)
            else:
                s = _short_scalar(complex(a) if a.dtype.kind == "c" else float(a)) if hasattr(a, "dtype") else _short_scalar(a)
            return "[%s]" % s if in_cell else s
        if len(d) == 2 and d[0] == 1 and n <= 10 and _arr(v).dtype.kind != "c" and cls not in ("logical",) and not in_cell:
            A = _arr(v).reshape(-1)
            return "[%s]" % " ".join(_g5(float(x)) for x in A)
        if len(d) == 2 and d[0] == 1 and n <= 10 and in_cell and _arr(v).dtype.kind != "c":
            A = _arr(v).reshape(-1)
            if cls == "logical" or cls in _INTS or _isint_arr(A.astype(np.float64)):
                return "[%s]" % " ".join("%d" % int(x) if np.isfinite(x) else _special(float(x)) for x in A)
            return "%s %s" % (_dimstr(d), cls)
        return "%s %s" % (_dimstr(d), cls) if in_cell else "[%s %s]" % (_dimstr(d), cls)
    if t is MException:
        return "[1×1 MException]" if not in_cell else "1×1 MException"
    return str(v)


def _cell_blocks(v):
    d = v.shape
    if len(v.a) == 0:
        return [], ["  %s empty cell array" % _dimstr(d)]
    head = ["  %s cell array" % _dimstr(d)]
    if len(d) > 2:
        return head, ["    " + "    ".join("{%s}" % _brief(x, True) for x in v.a)]
    rows, cols = d
    texts = [[_brief(v.a[j * rows + i], True) for i in range(rows)] for j in range(cols)]
    # (each column as wide as its widest element; text left-aligned in its braces)
    widths = [max(len(t) for t in col) for col in texts]
    lines_cols = []
    for j in range(cols):
        col = []
        for i in range(rows):
            t = texts[j][i]
            x = v.a[j * rows + i]
            pad = widths[j] - len(t)
            if type(x) is Char and t.startswith("'"):
                col.append("{" + t + " " * pad + "}")
            elif t.startswith("["):
                col.append("{" + "[" + " " * pad + t[1:] + "}")
            else:
                col.append("{" + t + "}" + " " * pad)
        lines_cols.append(col)
    per_w = [max(len(s) for s in c) + 4 for c in lines_cols]
    out = []
    j0 = 0
    blocks = []
    while j0 < cols:
        j1 = j0
        tot = 0
        while j1 < cols and (j1 == j0 or tot + per_w[j1] <= _WIDTH - 1):
            tot += per_w[j1]
            j1 += 1
        lines = ["".join("    " + lines_cols[j][i] for j in range(j0, j1)) for i in range(rows)]
        if j0 == 0 and j1 == cols:
            blocks.append("\n".join(lines))
        else:
            blocks.append("  Column %d" % (j0 + 1) if j1 - j0 == 1 else "  Columns %d through %d" % (j0 + 1, j1))
            blocks.append("\n".join(lines))
        j0 = j1
    return head, blocks


def _struct_fields_text(d, fields):
    if not fields:
        return ""
    w = max(len(f) for f in fields)
    return "\n".join("    %s: %s" % (f.rjust(w), _brief(d[f], False)) for f in fields)


def _struct_blocks(v):
    if len(v.a) == 1:
        if not v.fields:
            return ["  struct with no fields."], []
        return ["  struct with fields:"], [_struct_fields_text(v.a[0], v.fields)]
    d = v.shape
    if len(v.a) == 0:
        head = "  %s empty struct array with %s" % (_dimstr(d), "fields:" if v.fields else "no fields.")
    else:
        head = "  %s struct array with %s" % (_dimstr(d), "fields:" if v.fields else "no fields.")
    if not v.fields:
        return [head], []
    return [head], ["\n".join("    " + f for f in v.fields)]


def _blocks(v):
    """(header blocks, body blocks, object) of a value's display; object:
    MATLAB writes `x = ` with a space for objects (structs, strings)"""
    t = type(v)
    if t is float or t is bool or t is complex or t is np.ndarray:
        h, b = _numeric_blocks(v)
        return h, b, False
    if t is Char:
        d = _dims(v)
        if v.a.size == 0:
            if d == (0, 0):
                return [], ["  0×0 empty char array"], False
            return [], ["  %s empty char array" % _dimstr(d)], False
        if len(d) == 2 and d[0] == 1:
            return [], ["    '%s'" % v.text()], False
        if len(d) == 2:
            return ["  %s char array" % _dimstr(d)], ["\n".join("    '%s'" % r for r in v.rows())], False
        return ["  %s char array" % _dimstr(d)], ["    " + repr(v.text())], False
    if t is Str:
        return [], ['    "%s"' % v.s], True
    if t is StrArr:
        d = v.shape
        if not v.a:
            return [], ["  %s empty string array" % _dimstr(d)], True
        rows = d[0]
        cols = _prod(d[1:])
        texts = [['"%s"' % v.a[j * rows + i] if v.a[j * rows + i] is not None else "<missing>" for i in range(rows)] for j in range(cols)]
        w = [max(len(t) for t in c) for c in texts]
        lines = ["".join("    " + texts[j][i].ljust(w[j]) for j in range(cols)) for i in range(rows)]
        return ["  %s string array" % _dimstr(d)], ["\n".join(lines)], True
    if t is Cell:
        h, b = _cell_blocks(v)
        return h, b, False
    if t is Struct:
        h, b = _struct_blocks(v)
        return h, b, True
    if t is Anon or t is Handle or t is Function or t is Builtin:
        return ["  function_handle with value:"], ["    " + func2str_text(v)], False
    if t is MException:
        return ["  MException with properties:"], ["\n".join([
            "    identifier: '%s'" % v.identifier,
            "       message: '%s'" % v.message,
            "         cause: {}",
            "         stack: [0×1 struct]",
            "    Correction: []"])], True
    if isinstance(v, Undef):
        raise _undefined(v.name)
    return [], ["    %r" % (v,)], False


def display(name, v):
    head, body, obj = _blocks(v)
    blocks = head + body
    if _format["spacing"] == "loose":
        _write("\n%s =%s\n\n%s\n\n" % (name, " " if obj else "", "\n\n".join(blocks)))
    else:
        _write("%s =%s\n%s\n" % (name, " " if obj else "", "\n".join(blocks)))


def _disp_text(v):
    t = type(v)
    if t is Char:
        if v.a.size == 0:
            return ""
        return "\n".join(v.rows()) + "\n"
    if t is Str:
        return v.s + "\n"
    head, body, obj = _blocks(v)
    if t is Struct and len(v.a) != 1:
        body = head + body
    if _isnumlike(v) and _numel(v) == 0:
        return ""
    if t is Cell and not v.a:
        return ""
    sep = "\n\n" if _format["spacing"] == "loose" else "\n"
    return sep.join(body) + "\n"

# ------------------------------------------------------------------ function handles' text


def func2str_text(f):
    t = type(f)
    if t is Anon:
        return f.text
    if t is Handle or t is Function or t is Builtin:
        return "@" + f.name
    raise _err("Input must be a function handle.")

# ------------------------------------------------------------------ number formatting for strings


def _num2str_g(x):
    """a double as num2str prints it"""
    if x != x or x in (_math.inf, -_math.inf):
        return _special(x)
    if x == _math.floor(x) and abs(x) < 1e15:
        return "%d" % x
    dgt = int(_math.floor(_math.log10(abs(x)))) if x != 0 else 0
    ndgt = min(max(dgt + 5, 5), 16)
    return "%.*g" % (ndgt, x)


def _write_err(s):
    _sys.stderr.write(s)


def warning_(msg, ident=""):
    _write_err("Warning: %s\n" % msg)

# ================================================================== built-in functions


def _take_along(A, idx, axis):
    """numpy's take_along_axis"""
    A2 = np.moveaxis(A, axis, -1)
    I2 = np.moveaxis(idx, axis, -1)
    shp = I2.shape
    fa = A2.reshape((-1, A2.shape[-1]))
    fi = I2.reshape((-1, shp[-1]))
    rows = np.arange(fa.shape[0]).reshape((-1, 1))
    out = fa[rows, fi].reshape(shp)
    return np.ascontiguousarray(np.moveaxis(out, -1, axis))


def _fmod(A, B):
    """C's fmod (the sign of A), exactly: numpy's mod of the magnitudes"""
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.sign(A) * np.mod(np.abs(A), np.abs(B))

import re as _re


def _int_arg(v, what="argument"):
    x = _scalar(v, what)
    if x != _math.floor(x):
        raise _err("Size inputs must be integers." if what == "size" else "Expected an integer %s." % what)
    return int(x)


def _dimsarg(args, fname):
    """size arguments: (n), (m, n, ...), ([m n ...]); a trailing class name or 'like', x"""
    args = list(args)
    cls = None
    if len(args) >= 2 and _istext(args[-2]) and _text(args[-2]).lower() == "like":
        like = args.pop()
        args.pop()
        cls = class_(like)
    while args and _istext(args[-1]):
        cls = _text(args.pop()).lower()
    if not args:
        return (1, 1), cls
    if len(args) == 1:
        a = _arr(args[0]).reshape(-1)
        if a.size == 1:
            n = max(0, _int_arg(args[0], "size"))
            return (n, n), cls
        d = tuple(max(0, int(x)) for x in a)
        return _canon_dims(d), cls
    d = []
    for v in args:
        if _numel(v) == 0:
            d.append(1)
        else:
            d.append(max(0, _int_arg(v, "size")))
    return _canon_dims(d), cls


def _filled(dims, value, cls):
    cls = cls or "double"
    if cls == "double":
        return _box(np.full(_stored(dims), value, dtype=np.float64))
    if cls == "single":
        return _canon(np.full(_stored(dims), value, dtype=np.float32))
    if cls == "logical":
        return _box(np.full(_stored(dims), bool(value), dtype=bool))
    if cls in _INTS:
        return _canon(np.full(_stored(dims), value, dtype=_INTS[cls][0]))
    raise _err("Unknown class '%s'." % cls)


@_bs("zeros")
def zeros_(*args):
    d, cls = _dimsarg(args, "zeros")
    return _filled(d, 0, cls)


@_bs("ones")
def ones_(*args):
    d, cls = _dimsarg(args, "ones")
    return _filled(d, 1, cls)


@_bs("true")
def true_(*args):
    d, _ = _dimsarg(args, "true")
    return _filled(d, True, "logical")


@_bs("false")
def false_(*args):
    d, _ = _dimsarg(args, "false")
    return _filled(d, False, "logical")


@_bs("NaN", "nan")
def nan_(*args):
    d, cls = _dimsarg(args, "NaN")
    return _filled(d, _math.nan, cls)


@_bs("Inf", "inf")
def inf_(*args):
    d, cls = _dimsarg(args, "Inf")
    return _filled(d, _math.inf, cls)


@_bs("pi")
def pi_(*args):
    d, cls = _dimsarg(args, "pi")
    return _filled(d, _math.pi, cls)


@_bs("eps")
def eps_(*args):
    if len(args) == 1 and not _istext(args[0]):
        x = abs(_scalar(args[0]))
        if x != x or x == _math.inf:
            return _math.nan
        if x < 2.2250738585072014e-308:
            return 5e-324
        e = _math.frexp(x)[1]
        return _math.ldexp(1.0, e - 53)
    d, cls = _dimsarg(args, "eps")
    return _filled(d, 2.220446049250313e-16 if cls != "single" else 1.1920929e-07, cls)


@_bs("i", "j")
def imag_unit():
    return 1j


@_bs("realmax")
def realmax_(*a):
    return 1.7976931348623157e308


@_bs("realmin")
def realmin_(*a):
    return 2.2250738585072014e-308


@_bs("flintmax")
def flintmax_(*a):
    return 9007199254740992.0


@_bs("intmax")
def intmax_(cls=None):
    c = _text(cls) if cls is not None else "int32"
    return np.array([[_INTS[c][2]]], dtype=_INTS[c][0])


@_bs("intmin")
def intmin_(cls=None):
    c = _text(cls) if cls is not None else "int32"
    return np.array([[_INTS[c][1]]], dtype=_INTS[c][0])


@_bs("eye")
def eye_(*args):
    d, cls = _dimsarg(args, "eye")
    if len(d) > 2:
        raise _err("N-dimensional arrays are not supported.")
    m = np.eye(d[0], d[1])
    return _finish(np.ascontiguousarray(m.T), cls or "double")


# MATLAB's default generator: the Mersenne twister seeded with 5489, its
# doubles made of 53 random bits as numpy's legacy generator makes them, so
# rand gives MATLAB's numbers (randn and randi do not: MATLAB's algorithms
# for those are not numpy's)
_rng = [np.random.RandomState(5489)]


@_bi("rng")
def rng_(nargout, *args):
    if args:
        a = args[0]
        if _istext(a):
            s = _text(a)
            if s in ("default", "twister"):
                _rng[0] = np.random.RandomState(5489)
            elif s == "shuffle":
                import time
                _rng[0] = np.random.RandomState(int(time.time() * 1000) % 4294967296)
        else:
            seed = _int_arg(a)
            _rng[0] = np.random.RandomState(seed if seed != 0 else 5489)
    return NOVAL if nargout == 0 else _struct1({"Type": Char("twister"), "Seed": 0.0})


@_bs("rand")
def rand_(*args):
    d, cls = _dimsarg(args, "rand")
    n = _prod(d)
    v = _rng[0].random_sample(n) if n else np.zeros(0)
    return _finish(np.asarray(v, dtype=np.float64).reshape(_stored(d)), cls or "double")


@_bs("randn")
def randn_(*args):
    d, cls = _dimsarg(args, "randn")
    n = _prod(d)
    v = _rng[0].standard_normal(n) if n else np.zeros(0)
    return _finish(np.asarray(v, dtype=np.float64).reshape(_stored(d)), cls or "double")


@_bs("randi")
def randi_(r, *args):
    ra = _arr(r).reshape(-1)
    lo, hi = (1, int(ra[0])) if ra.size == 1 else (int(ra[0]), int(ra[1]))
    d, cls = _dimsarg(args, "randi") if args else ((1, 1), None)
    n = _prod(d)
    u = _rng[0].random_sample(n) if n else np.zeros(0)
    v = lo + np.floor(u * (hi - lo + 1))
    return _finish(np.asarray(v, dtype=np.float64).reshape(_stored(d)), cls or "double")


@_bs("randperm")
def randperm_(n, k=None):
    n = _int_arg(n)
    u = _rng[0].random_sample(n)
    p = np.argsort(u, kind="stable") + 1
    if k is not None:
        p = p[:_int_arg(k)]
    return np.asarray(p, dtype=np.float64).reshape((p.size, 1))


@_bs("linspace")
def linspace_(a, b, n=100.0):
    # (MATLAB's formula: d1 + k*(d2-d1)/(n-1), the ends exact)
    d1 = _scalar(a)
    d2 = _scalar(b)
    n = int(_math.floor(_scalar(n)))
    if n < 1:
        return np.zeros((0, 1))
    if n == 1:
        return d2
    n1 = n - 1
    k = np.arange(n, dtype=np.float64)
    y = d1 + k * (d2 - d1) / n1
    if d1 == d2:
        y[:] = d1
    else:
        y[0] = d1
        y[-1] = d2
    return y.reshape((n, 1))


@_bs("logspace")
def logspace_(a, b, n=50.0):
    y = linspace_(a, b, n)
    return _elementwise(10.0, y, _pow, "logspace")


@_bi("size")
def size_(nargout, x, *dims):
    d = list(_dims(x))
    if dims:
        if len(dims) == 1 and _numel(dims[0]) > 1:
            ks = [int(k) for k in _arr(dims[0]).reshape(-1)]
        else:
            ks = [_int_arg(k) for k in dims]
        vals = [float(d[k - 1]) if k <= len(d) else 1.0 for k in ks]
        if nargout <= 1:
            return vals[0] if len(vals) == 1 else np.array(vals).reshape((len(vals), 1))
        return vals[:nargout]
    if nargout <= 1:
        return np.array([float(v) for v in d]).reshape((len(d), 1))
    out = [float(v) for v in d[:nargout - 1]]
    out.append(float(_prod(d[nargout - 1:])) if len(d) >= nargout else 1.0)
    while len(out) < nargout:
        out.append(1.0)
    return out


@_bs("length")
def length_(x):
    d = _dims(x)
    return 0.0 if _prod(d) == 0 else float(max(d))


@_bs("numel")
def numel_(x, *idx):
    return float(_numel(x))


@_bs("ndims")
def ndims_(x):
    return float(len(_dims(x)))


@_bs("isempty")
def isempty_(x):
    return _numel(x) == 0


@_bs("isscalar")
def isscalar_(x):
    return _numel(x) == 1 and len(_dims(x)) == 2


@_bs("isvector")
def isvector_(x):
    d = _dims(x)
    return len(d) == 2 and (d[0] == 1 or d[1] == 1)


@_bs("isrow")
def isrow_(x):
    d = _dims(x)
    return len(d) == 2 and d[0] == 1


@_bs("iscolumn")
def iscolumn_(x):
    d = _dims(x)
    return len(d) == 2 and d[1] == 1


@_bs("ismatrix")
def ismatrix_(x):
    return len(_dims(x)) == 2


@_bs("issquare")
def issquare_(x):
    d = _dims(x)
    return len(d) == 2 and d[0] == d[1]

# ---- class tests and conversions


@_bs("class")
def class_b(x):
    return Char(class_(x))


@_bs("isa")
def isa_(x, name):
    n = _text(name)
    c = class_(x)
    if n == c:
        return True
    if n == "numeric":
        return c in _INTS or c in ("double", "single")
    if n == "float":
        return c in ("double", "single")
    if n == "integer":
        return c in _INTS
    return False


@_bs("isnumeric")
def isnumeric_(x):
    c = class_(x)
    return c in _INTS or c in ("double", "single")


@_bs("isfloat")
def isfloat_(x):
    return class_(x) in ("double", "single")


@_bs("isinteger")
def isinteger_(x):
    return class_(x) in _INTS


@_bs("ischar")
def ischar_(x):
    return type(x) is Char


@_bs("isstring")
def isstring_(x):
    return type(x) is Str or type(x) is StrArr


@_bs("islogical")
def islogical_(x):
    return class_(x) == "logical"


@_bs("iscell")
def iscell_(x):
    return type(x) is Cell


@_bs("iscellstr")
def iscellstr_(x):
    return type(x) is Cell and all(type(e) is Char for e in x.a)


@_bs("isstruct")
def isstruct_(x):
    return type(x) is Struct


@_bs("is_function_handle")
def is_fh(x):
    return _iscallable(x)


@_bs("isreal")
def isreal_(x):
    if type(x) is complex:
        return False
    if type(x) is np.ndarray:
        return x.dtype.kind != "c"
    return True


def _convert(x, cls):
    t = type(x)
    if t is Str and cls in ("double", "single"):
        return _B["str2double"].f(1, x)
    if t is Cell or t is Struct or t is Str or t is StrArr or _iscallable(x):
        raise _err("Conversion to %s from %s is not possible." % (cls, class_(x)), "MATLAB:invalidConversion")
    a = _arr(x)
    if cls == "double":
        if t is float or t is complex:
            return x
        if t is bool:
            return 1.0 if x else 0.0
        return _box(a.astype(np.complex128 if a.dtype.kind == "c" else np.float64))
    if cls == "single":
        return _canon(a.astype(np.complex64 if a.dtype.kind == "c" else np.float32))
    if cls == "logical":
        if a.dtype.kind == "c":
            raise _err("Conversion to logical from complex is not possible.")
        if a.dtype.kind == "f" and np.any(np.isnan(a)):
            raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
        return _box(a != 0)
    return _canon(_int_round(a.astype(np.float64) if a.dtype.kind == "b" else a, cls))


def _converter(c):
    return lambda nargout, x: _convert(x, c)


for _c in ("double", "single", "logical") + tuple(_INTS):
    _B[_c] = Builtin(_converter(_c), _c)


@_bs("char")
def char_(*args):
    if len(args) == 1:
        x = args[0]
        if type(x) is Char:
            return cp(x)
        if type(x) is Str:
            return Char(x.s)
        if type(x) is StrArr:
            return _pad_rows(list(x.a))
        if type(x) is Cell:
            return _pad_rows([_text(e) for e in x.a])
        a = _farr(x)
        return Char(np.ascontiguousarray(a.real if a.dtype.kind == "c" else a))
    rows = []
    for x in args:
        if type(x) is Cell:
            rows.extend(_text(e) for e in x.a)
        elif type(x) is Char:
            rows.extend(x.rows() if x.a.size else [""])
        elif type(x) is Str:
            rows.append(x.s)
        else:
            rows.append("".join(chr(int(c)) for c in _arr(x).reshape(-1)))
    return _pad_rows(rows)


def _pad_rows(rows):
    if not rows:
        return Char("")
    w = max(len(r) for r in rows)
    return _rows_char([r.ljust(w) for r in rows])


@_bs("string")
def string_(x):
    t = type(x)
    if t is Str or t is StrArr:
        return x
    if t is Char:
        d = _dims(x)
        if d[0] <= 1:
            return Str(x.text())
        return StrArr(x.rows(), (d[0], 1))
    if t is Cell:
        return _strarr([_text(e) for e in x.a], x.shape)
    if _isnumlike(x):
        a = _arr(x)
        return _strarr([_num2str_g(float(v)) if a.dtype.kind != "b" else ("true" if v else "false") for v in a.reshape(-1)], _dims(x))
    raise _err("Conversion to string from %s is not possible." % class_(x))


@_bs("strlength")
def strlength_(x):
    if type(x) is StrArr:
        return _box(np.array([float(len(s)) for s in x.a]).reshape(_stored(x.shape)))
    if type(x) is Cell:
        return _box(np.array([float(len(_text(s))) for s in x.a]).reshape(_stored(x.shape)))
    return float(len(_text(x)))


@_bs("cellstr")
def cellstr_(x):
    if type(x) is Cell:
        return cp(x)
    if type(x) is Char:
        rows = [r.rstrip(" ") for r in x.rows()] if x.a.size else [""]
        return Cell([Char(r) for r in rows], (len(rows), 1))
    if type(x) is Str:
        return Cell([Char(x.s)], (1, 1))
    if type(x) is StrArr:
        return Cell([Char(s) for s in x.a], x.shape)
    raise _err("Input must be a string, a character array or a cell array of character vectors.")

# ---- elementwise math


def _unary(name, f, complex_if=None, keep_int=False):
    """a math function on every element; complex_if(A): where the result is complex"""
    def g(nargout, x):
        if type(x) is float and (complex_if is None or not complex_if(np.array([x]))[0]):
            with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                return float(f(np.array([x]))[0])
        cls = class_(x)
        if cls in ("cell", "struct", "string", "function_handle"):
            raise _err("Undefined function '%s' for input arguments of type '%s'." % (name, cls), "MATLAB:UndefinedFunction")
        A = _farr(x, name)
        if complex_if is not None and A.dtype.kind != "c" and A.size and np.any(complex_if(A)):
            A = A.astype(np.complex128)
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            r = f(A)
        if cls in _INTS:
            if keep_int:
                return _finish(r, cls)
            raise _err("Undefined function '%s' for input arguments of type '%s'." % (name, cls), "MATLAB:UndefinedFunction")
        return _finish(r, "single" if cls == "single" else "double")
    _B[name] = Builtin(g, name)


def _vec_math(f, A, bad=_math.nan):
    out = np.empty(A.shape)
    flat = A.reshape(-1)
    o = out.reshape(-1)
    for k in range(flat.size):
        try:
            o[k] = f(float(flat[k]))
        except (ValueError, OverflowError):
            o[k] = bad
    return out


def _sind(A):
    r = np.sin(A * (_math.pi / 180))
    return np.where(np.mod(A, 180) == 0, 0.0, r)


def _cosd(A):
    r = np.cos(A * (_math.pi / 180))
    return np.where(np.mod(A - 90, 180) == 0, 0.0, r)


_unary("sqrt", np.sqrt, lambda A: A < 0)
_unary("exp", np.exp)
_unary("log", np.log, lambda A: A < 0)
_unary("log2", lambda A: np.log(A) / _math.log(2) if A.dtype.kind == "c" else np.log2(A), lambda A: A < 0)
_unary("log10", np.log10, lambda A: A < 0)
_unary("log1p", np.log1p, lambda A: A < -1)
_unary("expm1", np.expm1)
_unary("sin", np.sin)
_unary("cos", np.cos)
_unary("tan", np.tan)
_unary("asin", np.arcsin, lambda A: np.abs(A) > 1)
_unary("acos", np.arccos, lambda A: np.abs(A) > 1)
_unary("atan", np.arctan)
_unary("sinh", np.sinh)
_unary("cosh", np.cosh)
_unary("tanh", np.tanh)
_unary("asinh", np.arcsinh)
_unary("acosh", np.arccosh, lambda A: A < 1)
_unary("atanh", np.arctanh, lambda A: np.abs(A) > 1)
_unary("sec", lambda A: 1 / np.cos(A))
_unary("csc", lambda A: 1 / np.sin(A))
_unary("cot", lambda A: 1 / np.tan(A))
_unary("sind", _sind)
_unary("cosd", _cosd)
_unary("tand", lambda A: _sind(A) / _cosd(A))
_unary("gamma", lambda A: _vec_math(_math.gamma, A, _math.inf))
_unary("gammaln", lambda A: _vec_math(_math.lgamma, A, _math.inf))
_unary("erf", lambda A: _vec_math(_math.erf, A))
_unary("erfc", lambda A: _vec_math(_math.erfc, A))


def _round_half_away(A):
    return np.where(A >= 0, np.floor(A + 0.5), -np.floor(-A + 0.5))


def _round_c(A):
    if A.dtype.kind == "c":
        return _round_c(np.ascontiguousarray(A.real)) + 1j * _round_c(np.ascontiguousarray(A.imag))
    # (x + 0.5 rounds up for the largest double below 0.5)
    return np.where(np.abs(A) < 0.5, 0.0 * A, _round_half_away(A))


_unary("floor", lambda A: np.floor(A) if A.dtype.kind != "c" else np.floor(A.real) + 1j * np.floor(A.imag), keep_int=True)
_unary("ceil", lambda A: np.ceil(A) if A.dtype.kind != "c" else np.ceil(A.real) + 1j * np.ceil(A.imag), keep_int=True)
_unary("fix", lambda A: np.trunc(A) if A.dtype.kind != "c" else np.trunc(A.real) + 1j * np.trunc(A.imag), keep_int=True)
_unary("sign", lambda A: np.sign(A) if A.dtype.kind != "c" else np.where(A == 0, 0, A / np.abs(np.where(A == 0, 1, A))), keep_int=True)


@_bi("round")
def round_(nargout, x, n=None, kind=None):
    if n is None:
        if type(x) is float:
            if abs(x) < 0.5:
                return 0.0 * x
            return float(_math.floor(x + 0.5)) if x >= 0 else -float(_math.floor(-x + 0.5))
        cls = class_(x)
        if cls in _INTS:
            return cp(x)
        return _finish(_round_c(_farr(x)), "single" if cls == "single" else "double")
    d = _int_arg(n)
    A = _farr(x)
    if kind is not None and _text(kind) == "significant":
        with np.errstate(divide="ignore"):
            e = np.floor(np.log10(np.abs(np.where(A == 0, 1, A)))) + 1
        s = 10.0 ** (d - e)
        return _box(_round_c(A * s) / s)
    if d >= 0:
        s = 10.0 ** d
        return _box(_round_c(A * s) / s)
    s = 10.0 ** (-d)
    return _box(_round_c(A / s) * s)


@_bi("abs")
def abs_(nargout, x):
    if type(x) is float or type(x) is complex:
        return abs(x)
    cls = class_(x)
    if cls in _INTS:
        return _canon(np.abs(_arr(x)))
    A = _farr(x, "abs")
    return _finish(np.abs(A).astype(np.float64), "single" if cls == "single" else "double")


@_bs("real")
def real_(x):
    if type(x) is complex:
        return x.real
    A = _farr(x)
    return _box(np.ascontiguousarray(A.real) if A.dtype.kind == "c" else A.copy())


@_bs("imag")
def imag_(x):
    if type(x) is complex:
        return x.imag
    A = _farr(x)
    return _box(np.ascontiguousarray(A.imag) if A.dtype.kind == "c" else np.zeros(A.shape))


@_bs("conj")
def conj_(x):
    if type(x) is complex:
        return x.conjugate()
    A = _farr(x)
    return _box(np.conj(A) if A.dtype.kind == "c" else A.copy())


@_bs("angle")
def angle_(x):
    A = _farr(x)
    return _box(np.arctan2(A.imag, A.real) if A.dtype.kind == "c" else np.arctan2(np.zeros(A.shape), A))


@_bs("complex")
def complex_(a, b=0.0):
    r = _broadcast(lambda x, y: x + 1j * y, _farr(a), _farr(b))
    r = np.asarray(r, dtype=np.complex128)
    if r.size == 1:
        z = complex(r.reshape(-1)[0])
        return np.array([[z]], dtype=np.complex128) if z.imag == 0 else z
    return r


@_bs("isnan")
def isnan_(x):
    if type(x) is float:
        return x != x
    if not _isnumlike(x):
        raise _optype("isnan", x)
    A = _farr(x)
    return _box(np.isnan(A) if A.dtype.kind != "c" else np.isnan(A.real) | np.isnan(A.imag))


@_bs("isinf")
def isinf_(x):
    if type(x) is float:
        return x in (_math.inf, -_math.inf)
    A = _farr(x)
    return _box(np.isinf(A) if A.dtype.kind != "c" else np.isinf(A.real) | np.isinf(A.imag))


@_bs("isfinite")
def isfinite_(x):
    if type(x) is float:
        return _math.isfinite(x)
    A = _farr(x)
    return _box(np.isfinite(A) if A.dtype.kind != "c" else np.isfinite(A.real) & np.isfinite(A.imag))


def _binary_fn(name, f):
    def g(nargout, a, b):
        return _elementwise(a, b, f, name)
    _B[name] = Builtin(g, name)


def _mod(A, B):
    with np.errstate(divide="ignore", invalid="ignore"):
        q = np.where(B == 0, 1.0, B)
        r = _fmod(A, q)
        r = np.where((r != 0) & ((r < 0) != (q < 0)), r + q, r)
        r = np.where(B == 0, A, r)
        r = np.where(np.isinf(B) & np.isfinite(A), np.where((A == 0) | ((A > 0) == (B > 0)), A, B), r)
    return r


def _rem(A, B):
    with np.errstate(divide="ignore", invalid="ignore"):
        r = _fmod(A, np.where(B == 0, 1.0, B))
        r = np.where(B == 0, A, r)
        return np.where(np.isinf(B) & np.isfinite(A), A, r)


@_bi("mod")
def mod_(nargout, a, b):
    if type(a) is float and type(b) is float:
        if b == 0:
            return a
        if a != a or b != b or a in (_math.inf, -_math.inf):
            return _math.nan
        if b in (_math.inf, -_math.inf):
            return a if (a == 0 or (a > 0) == (b > 0)) else b
        r = _math.fmod(a, b)
        if r != 0 and (r < 0) != (b < 0):
            r += b
        return r
    return _elementwise(a, b, _mod, "mod")


@_bi("rem")
def rem_(nargout, a, b):
    if type(a) is float and type(b) is float:
        if b == 0:
            return a
        if a != a or b != b or a in (_math.inf, -_math.inf):
            return _math.nan
        if b in (_math.inf, -_math.inf):
            return a
        return _math.fmod(a, b)
    return _elementwise(a, b, _rem, "rem")


_binary_fn("atan2", lambda A, B: np.arctan2(A, B))
_binary_fn("hypot", lambda A, B: np.hypot(A, B))
_binary_fn("power", _pow)
_binary_fn("plus", _add)
_binary_fn("minus", _sub)
_binary_fn("times", _mul)
_binary_fn("rdivide", _div)
_B["ldivide"] = Builtin(lambda n, a, b: ldivide(a, b), "ldivide")
_B["mtimes"] = Builtin(lambda n, a, b: mtimes(a, b), "mtimes")
_B["mrdivide"] = Builtin(lambda n, a, b: mrdivide(a, b), "mrdivide")
_B["mldivide"] = Builtin(lambda n, a, b: mldivide(a, b), "mldivide")
_B["mpower"] = Builtin(lambda n, a, b: mpower(a, b), "mpower")
_B["uminus"] = Builtin(lambda n, a: uminus(a), "uminus")
_B["uplus"] = Builtin(lambda n, a: uplus(a), "uplus")
_B["transpose"] = Builtin(lambda n, a: transpose(a), "transpose")
_B["ctranspose"] = Builtin(lambda n, a: ctranspose(a), "ctranspose")
_B["eq"] = Builtin(lambda n, a, b: eq(a, b), "eq")
_B["ne"] = Builtin(lambda n, a, b: ne(a, b), "ne")
_B["lt"] = Builtin(lambda n, a, b: lt(a, b), "lt")
_B["le"] = Builtin(lambda n, a, b: le(a, b), "le")
_B["gt"] = Builtin(lambda n, a, b: gt(a, b), "gt")
_B["ge"] = Builtin(lambda n, a, b: ge(a, b), "ge")
_B["and"] = Builtin(lambda n, a, b: and_(a, b), "and")
_B["or"] = Builtin(lambda n, a, b: or_(a, b), "or")
_B["not"] = Builtin(lambda n, a: not_(a), "not")
_B["xor"] = Builtin(lambda n, a, b: _box(_broadcast(lambda x, y: x != y, _logical_arr(a, "xor"), _logical_arr(b, "xor"))), "xor")
_B["colon"] = Builtin(lambda n, *a: colon(*a), "colon")


@_bs("idivide")
def idivide_(a, b, opt=None):
    o = _text(opt) if opt is not None else "fix"
    cls = _arith_class(a, b, "idivide")
    with np.errstate(divide="ignore", invalid="ignore"):
        q = _farr(a) / _farr(b)
    f = {"fix": np.trunc, "floor": np.floor, "ceil": np.ceil, "round": _round_half_away}[o]
    return _finish(f(q), cls)


def _pairwise(a, b, f, name):
    A, B = np.broadcast_arrays(_farr(a), _farr(b))
    r = np.array([f(x, y) for x, y in zip(A.reshape(-1), B.reshape(-1))], dtype=np.float64).reshape(A.shape)
    return _finish(r, _arith_class(a, b, name))


def _gcd1(x, y):
    x, y = abs(int(x)), abs(int(y))
    while y:
        x, y = y, x % y
    return float(x)


@_bs("gcd")
def gcd_(a, b):
    return _pairwise(a, b, _gcd1, "gcd")


@_bs("lcm")
def lcm_(a, b):
    def l(x, y):
        x, y = abs(int(x)), abs(int(y))
        if x == 0 or y == 0:
            return 0.0
        return float(x // int(_gcd1(x, y)) * y)
    return _pairwise(a, b, l, "lcm")


@_bs("factorial")
def factorial_(n):
    A = _farr(n)
    out = np.array([float(_math.factorial(int(x))) if x <= 170 else _math.inf for x in A.reshape(-1)]).reshape(A.shape)
    return _box(out)


@_bs("nchoosek")
def nchoosek_(n, k):
    k = _int_arg(k)
    if _numel(n) == 1:
        return float(_math.comb(_int_arg(n), k))
    v = list(_arr(n).reshape(-1))
    import itertools
    combos = list(itertools.combinations(range(len(v)), k))
    out = np.array([[float(v[i]) for i in c] for c in combos], dtype=np.float64).reshape((len(combos), k))
    return _unmat(out)


@_bs("primes")
def primes_(n):
    n = int(_math.floor(_scalar(n)))
    if n < 2:
        return np.zeros((0, 1))
    s = [True] * (n + 1)
    s[0] = s[1] = False
    p = 2
    while p * p <= n:
        if s[p]:
            for m in range(p * p, n + 1, p):
                s[m] = False
        p += 1
    ps = [float(i) for i in range(n + 1) if s[i]]
    return np.array(ps).reshape((len(ps), 1)) if len(ps) != 1 else ps[0]


def _isprime1(x):
    if x != _math.floor(x) or x < 2:
        return False
    x = int(x)
    if x < 4:
        return True
    if x % 2 == 0:
        return False
    d = 3
    while d * d <= x:
        if x % d == 0:
            return False
        d += 2
    return True


@_bs("isprime")
def isprime_(x):
    A = _farr(x)
    return _box(np.array([_isprime1(float(v)) for v in A.reshape(-1)], dtype=bool).reshape(A.shape))


@_bs("factor")
def factor_(n):
    n = int(_scalar(n))
    out = []
    d = 2
    while d * d <= n:
        while n % d == 0:
            out.append(float(d))
            n //= d
        d += 1
    if n > 1 or not out:
        out.append(float(n))
    return np.array(out).reshape((len(out), 1)) if len(out) != 1 else out[0]

# ---- reductions


def _default_dim(d):
    for k, x in enumerate(d):
        if x != 1:
            return k + 1
    return 1


def _dim_arg(args, d):
    """(dim or 'all', flags) from a reduction's extra arguments"""
    dim = None
    flags = []
    for a in args:
        if _istext(a):
            s = _text(a).lower()
            if s == "all":
                dim = "all"
            else:
                flags.append(s)
        elif _numel(a) == 0:
            continue
        else:
            dim = _int_arg(a, "dimension")
    if dim is None:
        dim = _default_dim(d)
    return dim, flags


def _reduce(x, args, f, name, empty_value=0.0, out_cls=None):
    """f(A, axis) along MATLAB dimension dim of x (that dimension becomes 1)"""
    d = _dims(x)
    dim, flags = _dim_arg(args, d)
    cls = class_(x)
    A = _farr(x, name)
    # (MATLAB: double, except single stays single; 'native' keeps an integer class)
    oc = out_cls or ("single" if cls == "single" else "double")
    if "native" in flags and cls in _INTS:
        oc = cls
    if "double" in flags:
        oc = "double"
    if not [a for a in args if not _istext(a)] and d == (0, 0) and dim != "all":
        return _finish(np.array([[empty_value]]), oc)
    if dim == "all":
        A = A.reshape((1, -1))
        dim = 1
    nd = A.ndim
    if dim > nd:
        r = f(A.reshape((1,) + A.shape), 0)
        res = np.asarray(r).reshape(A.shape)
    else:
        axis = nd - dim
        r = f(A, axis)
        shp = list(A.shape)
        shp[axis] = 1
        res = np.asarray(r).reshape(shp)
    return _finish(np.ascontiguousarray(res), oc)


def _nan_flags(args):
    return any(_istext(a) and _text(a).lower() == "omitnan" for a in args)


@_bs("sum")
def sum_(x, *args):
    if type(x) is float and not args:
        return x
    if _nan_flags(args):
        return _reduce(x, args, lambda A, ax: np.sum(np.where(np.isnan(A), 0, A), axis=ax), "sum")
    return _reduce(x, args, lambda A, ax: np.sum(A, axis=ax), "sum")


@_bs("prod")
def prod_(x, *args):
    return _reduce(x, args, lambda A, ax: np.prod(A, axis=ax), "prod", 1.0)


def _nanfull(A, ax):
    shp = [s for i, s in enumerate(A.shape) if i != ax] or [1]
    return np.full(shp, _math.nan)


@_bs("mean")
def mean_(x, *args):
    if _dims(x) == (0, 0) and not args:
        return _math.nan
    cls = class_(x)
    omit = _nan_flags(args)

    def m(A, ax):
        if A.shape[ax] == 0:
            return _nanfull(A, ax)
        if omit:
            ok = ~np.isnan(A)
            return np.sum(np.where(ok, A, 0), axis=ax) / np.sum(ok, axis=ax)
        return np.sum(A, axis=ax) / A.shape[ax]
    return _reduce(x, args, m, "mean", out_cls="single" if cls == "single" else "double")


@_bs("median")
def median_(x, *args):
    if _dims(x) == (0, 0) and not args:
        return _math.nan

    def med(A, ax):
        n = A.shape[ax]
        if n == 0:
            return _nanfull(A, ax)
        S = np.sort(A, axis=ax)
        lo = np.take(S, (n - 1) // 2, axis=ax)
        hi = np.take(S, n // 2, axis=ax)
        r = lo + (hi - lo) / 2 if n % 2 == 0 else lo
        return np.where(np.any(np.isnan(A), axis=ax), _math.nan, r)
    return _reduce(x, args, med, "median", out_cls="double")


@_bs("mode")
def mode_(x, *args):
    def md(A, ax):
        A2 = np.moveaxis(A, ax, -1)
        shp = A2.shape[:-1]
        flat = A2.reshape((-1, A2.shape[-1]))
        out = []
        for row in flat:
            vals, counts = np.unique(row, return_counts=True)
            out.append(float(vals[np.argmax(counts)]) if vals.size else _math.nan)
        return np.array(out).reshape(shp if shp else (1,))
    return _reduce(x, args, md, "mode", out_cls="double")


def _var_impl(x, args, sq):
    w = 0
    rest = []
    if args:
        if _numel(args[0]) > 0 and not _istext(args[0]):
            w = _int_arg(args[0])
        rest = list(args[1:])
    if _dims(x) == (0, 0) and not rest:
        return _math.nan

    def v(A, ax):
        n = A.shape[ax]
        if n == 0:
            return _nanfull(A, ax)
        m = np.sum(A, axis=ax, keepdims=True) / n
        dev = np.abs(A - m) ** 2
        den = n - 1 if (w == 0 and n > 1) else n
        r = np.sum(dev, axis=ax) / den
        return np.sqrt(r) if sq else r
    return _reduce(x, rest, v, "var", out_cls="double")


@_bs("var")
def var_(x, *args):
    return _var_impl(x, args, False)


@_bs("std")
def std_(x, *args):
    return _var_impl(x, args, True)


def _logical_val(x):
    A = _arr(x)
    if A.dtype.kind == "c":
        return _box(A != 0)
    return x


@_bs("any")
def any_(x, *args):
    if type(x) is bool and not args:
        return x
    if not args and _dims(x) == (0, 0):
        return False
    return _reduce(_logical_val(x), args, lambda A, ax: np.any((A != 0) & ~np.isnan(A), axis=ax), "any", 0.0, out_cls="logical")


@_bs("all")
def all_(x, *args):
    if type(x) is bool and not args:
        return x
    if not args and _dims(x) == (0, 0):
        return True
    return _reduce(_logical_val(x), args, lambda A, ax: np.all(A != 0, axis=ax), "all", 1.0, out_cls="logical")


def _cum(x, args, f, name):
    d = _dims(x)
    dim, flags = _dim_arg(args, d)
    cls = class_(x)
    oc = "double" if cls in ("logical", "char") else cls
    A = _farr(x, name)
    if dim == "all" or dim > A.ndim:
        return _finish(A.copy(), oc)
    ax = A.ndim - dim
    if "reverse" in flags:
        r = np.flip(f(np.flip(A, axis=ax), ax), axis=ax)
    else:
        r = f(A, ax)
    return _finish(np.ascontiguousarray(r), oc)


@_bs("cumsum")
def cumsum_(x, *args):
    return _cum(x, args, lambda A, ax: np.cumsum(A, axis=ax), "cumsum")


@_bs("cumprod")
def cumprod_(x, *args):
    return _cum(x, args, lambda A, ax: np.cumprod(A, axis=ax), "cumprod")


@_bs("cummax")
def cummax_(x, *args):
    return _cum(x, args, lambda A, ax: np.maximum.accumulate(A, axis=ax), "cummax")


@_bs("cummin")
def cummin_(x, *args):
    return _cum(x, args, lambda A, ax: np.minimum.accumulate(A, axis=ax), "cummin")


@_bs("diff")
def diff_(x, n=1.0, dim=None):
    n = _int_arg(n)
    r = x
    for _ in range(n):
        d = _dims(r)
        dm = _int_arg(dim) if dim is not None else _default_dim(d)
        A = _farr(r)
        ax = A.ndim - dm
        if ax < 0 or A.shape[ax] <= 1:
            shp = list(A.shape)
            if ax >= 0:
                shp[ax] = 0
            return np.zeros(tuple(shp)) if ax >= 0 else np.zeros((0, 0))
        r = _box(np.ascontiguousarray(np.diff(A, axis=ax)))
    return r


def _minmax(nargout, args, which):
    """max/min: (x), (x, [], dim), (a, b), with [m, i] outputs"""
    big = which == "max"
    if len(args) >= 2 and _numel(args[1]) > 0:
        a, b = args[0], args[1]
        if type(a) is float and type(b) is float:
            if a != a:
                return b
            if b != b:
                return a
            return (a if a >= b else b) if big else (a if a <= b else b)
        cls = _arith_class(a, b, which)
        f = np.fmax if big else np.fmin
        return _finish(_broadcast(f, _farr(a), _farr(b)), cls)
    x = args[0]
    d = _dims(x)
    dim = None
    for a in args[2:]:
        if _istext(a):
            if _text(a).lower() == "all":
                dim = "all"
        else:
            dim = _int_arg(a)
    cls = class_(x)
    A = _farr(x, which)
    if dim is None:
        if d == (0, 0):
            e = np.zeros((0, 0))
            return e if nargout <= 1 else [e, e.copy()]
        dim = _default_dim(d)
    if dim == "all":
        A = A.reshape((1, -1))
        dim = 1
    if dim > A.ndim:
        A = A.reshape((1,) * (dim - A.ndim) + A.shape)
    ax = A.ndim - dim
    if A.shape[ax] == 0:
        shp = list(A.shape)
        shp[ax] = 0
        e = np.zeros(tuple(shp))
        return e if nargout <= 1 else [e, e.copy()]
    key = np.abs(A) if A.dtype.kind == "c" else A
    nan = np.isnan(key)
    filled = np.where(nan, -np.inf if big else np.inf, key)
    idx = np.argmax(filled, axis=ax) if big else np.argmin(filled, axis=ax)
    if A.dtype.kind == "c":
        # (equal magnitudes: the larger angle)
        pass
    idx = np.where(np.all(nan, axis=ax), 0, idx)
    vals = _take_along(A, np.expand_dims(idx, ax), axis=ax)
    shp = list(A.shape)
    shp[ax] = 1
    vals = _canon(np.ascontiguousarray(vals.reshape(shp)))
    oc = "double" if cls in ("logical", "char") else cls
    m = _finish(vals, oc)
    if nargout <= 1:
        return m
    return [m, _box(_canon(np.ascontiguousarray((idx + 1).astype(np.float64).reshape(shp))))]


@_bi("max")
def max_(nargout, *args):
    return _minmax(nargout, args, "max")


@_bi("min")
def min_(nargout, *args):
    return _minmax(nargout, args, "min")


@_bi("bounds")
def bounds_(nargout, x):
    return [min_(1, x), max_(1, x)]


@_bi("sort")
def sort_(nargout, x, *args):
    desc = False
    dim = None
    for a in args:
        if _istext(a):
            desc = _text(a).lower() == "descend"
        else:
            dim = _int_arg(a)
    if type(x) is Cell:
        strs = [_text(e) for e in x.a]
        order = sorted(range(len(strs)), key=lambda k: strs[k])
        if desc:
            order = sorted(range(len(strs)), key=lambda k: strs[k], reverse=True)
        r = Cell([cp(x.a[k]) for k in order], x.shape)
        if nargout <= 1:
            return r
        return [r, _box(np.array([float(k + 1) for k in order]).reshape(_stored(x.shape)))]
    d = _dims(x)
    if dim is None:
        dim = _default_dim(d)
    A = _arr(x)
    cls = class_(x)
    if dim > A.ndim or A.size == 0:
        return cp(x) if nargout <= 1 else [cp(x), _box(np.ones(A.shape))]
    ax = A.ndim - dim
    if A.dtype.kind == "c":
        key = np.abs(A)
    elif A.dtype.kind in "b":
        key = A.astype(np.float64)
    else:
        key = A
    if key.dtype.kind == "f":
        nanmask = np.isnan(key)
        # ascending: NaN last; descending: NaN first (stable among equals)
        k2 = np.where(nanmask, np.inf, key) if not desc else np.where(nanmask, -np.inf, -key)
        order = np.argsort(k2, axis=ax, kind="stable")
        if np.any(nanmask):
            nn = _take_along(nanmask, order, axis=ax).astype(np.float64)
            o2 = np.argsort(-nn if desc else nn, axis=ax, kind="stable")
            order = _take_along(order, o2, axis=ax)
    else:
        order = np.argsort(-key.astype(np.float64) if desc else key, axis=ax, kind="stable")
    s = np.ascontiguousarray(_take_along(A, order, axis=ax))
    sv = Char(s) if cls == "char" else _box(s)
    if nargout <= 1:
        return sv
    return [sv, _box(np.ascontiguousarray((order + 1).astype(np.float64)))]


@_bi("sortrows")
def sortrows_(nargout, x, col=None):
    M = _mat(x)
    cols = [int(c) for c in _arr(col).reshape(-1)] if col is not None else list(range(1, M.shape[1] + 1))
    idx = list(range(M.shape[0]))
    for c in reversed(cols):
        j = abs(c) - 1
        idx.sort(key=lambda r: M[r, j], reverse=c < 0)
    out = _unmat(M[idx])
    if type(x) is Char:
        out = Char(_arr(out))
    if nargout <= 1:
        return out
    return [out, np.array([float(i + 1) for i in idx]).reshape((1, -1))]


@_bi("find")
def find_(nargout, x, n=None, direction=None):
    A = _arr(x)
    flat = A.reshape(-1)
    nz = np.nonzero(flat != 0)[0]
    if n is not None:
        k = _int_arg(n)
        if direction is not None and _text(direction) == "last":
            nz = nz[nz.size - k:] if k else nz[:0]
        else:
            nz = nz[:k]
    d = _dims(x)
    row = len(d) == 2 and d[0] == 1 and d[1] != 1

    def shaped(v):
        v = v.astype(np.float64)
        return v.reshape((v.size, 1)) if row else v.reshape((1, v.size))
    if nargout <= 1:
        if d == (0, 0):
            return np.zeros((0, 0))
        return _box(shaped(nz + 1))
    rows = d[0]
    i = nz % rows + 1 if rows else nz
    j = nz // rows + 1 if rows else nz
    out = [_box(shaped(i)), _box(shaped(j))]
    if nargout >= 3:
        vals = flat[nz]
        out.append(_box(vals.reshape((vals.size, 1)) if row else vals.reshape((1, vals.size))))
    return out


@_bs("nnz")
def nnz_(x):
    return float(np.count_nonzero(_arr(x)))


def _isvec(v):
    d = _dims(v)
    return len(d) == 2 and (d[0] == 1 or d[1] == 1)


@_bs("cross")
def cross_(a, b):
    A = _farr(a).reshape(-1)
    B = _farr(b).reshape(-1)
    r = np.array([A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]])
    return _box(r.reshape(_arr(a).shape))


@_bs("dot")
def dot_(a, b, *dim):
    if _isvec(a) and _isvec(b):
        A = _farr(a).reshape(-1)
        B = _farr(b).reshape(-1)
        if A.size != B.size:
            raise _err("A and B must be same size.")
        return _box(np.array([[np.sum(np.conj(A) * B)]]))
    return sum_(times(conj_(a), b), *dim)


@_bs("kron")
def kron_(a, b):
    return _unmat(np.kron(_mat(a), _mat(b)))


@_bs("trapz")
def trapz_(*args):
    if len(args) == 1:
        x = None
        y = args[0]
    else:
        x, y = args[0], args[1]
    if _isvec(y):
        yv = _farr(y).reshape(-1)
        dx = np.diff(_farr(x).reshape(-1)) if x is not None else np.ones(yv.size - 1)
        return float(np.sum(dx * (yv[1:] + yv[:-1]) / 2))
    Y = _mat(y)
    dx = (np.diff(_farr(x).reshape(-1)) if x is not None else np.ones(Y.shape[0] - 1)).reshape((-1, 1))
    return _unmat(np.sum(dx * (Y[1:] + Y[:-1]) / 2, axis=0).reshape((1, -1)))

# ---- shapes


@_bs("reshape")
def reshape_(x, *args):
    n = _numel(x)
    if len(args) == 1:
        d = [int(v) for v in _arr(args[0]).reshape(-1)]
    else:
        d = []
        free = -1
        for k, v in enumerate(args):
            if _numel(v) == 0:
                free = k
                d.append(1)
            else:
                d.append(_int_arg(v, "size"))
        if free >= 0:
            rest = _prod(d)
            if rest == 0 or n % rest:
                raise _err("Product of known dimensions, %d, not divisible into total number of elements, %d." % (rest, n))
            d[free] = n // rest
    if _prod(d) != n:
        raise _err("Number of elements must not change. Use [] as one of the size inputs to automatically calculate the appropriate size for that dimension.", "MATLAB:getReshapeDims:notSameNumel")
    d = _canon_dims(d)
    t = type(x)
    if t is Cell or t is Struct or t is StrArr:
        return x._like([cp(e) for e in x.a], d)
    r = _arr(x).reshape(_stored(d)).copy()
    return Char(r) if t is Char else _box(r)


@_bs("squeeze")
def squeeze_(x):
    d = _dims(x)
    if len(d) <= 2:
        return cp(x)
    nd = [v for v in d if v != 1]
    while len(nd) < 2:
        nd.append(1)
    return reshape_(x, np.array([float(v) for v in nd]).reshape((len(nd), 1)))


@_bs("permute")
def permute_(x, order):
    o = [int(v) - 1 for v in _arr(order).reshape(-1)]
    nd = len(o)
    d = list(_dims(x)) + [1] * (nd - len(_dims(x)))
    a = _arr(x).reshape(tuple(reversed(d)))
    # (MATLAB dimension k is stored axis nd-1-k)
    axes = [nd - 1 - o[nd - 1 - ax] for ax in range(nd)]
    r = _canon(np.ascontiguousarray(np.transpose(a, axes)))
    return Char(r) if type(x) is Char else _box(r)


@_bs("repmat")
def repmat_(x, *args):
    if len(args) == 1:
        r = [int(v) for v in _arr(args[0]).reshape(-1)]
        if len(r) == 1:
            r = [r[0], r[0]]
    else:
        r = [_int_arg(v) for v in args]
    t = type(x)
    d = list(_dims(x))
    nd = max(len(d), len(r))
    d = d + [1] * (nd - len(d))
    r = r + [1] * (nd - len(r))
    reps = tuple(reversed(r))
    if t is Cell or t is Struct or t is StrArr:
        idx = np.arange(len(x.a), dtype=np.int64).reshape(tuple(reversed(d)))
        big = _canon(np.tile(idx, reps))
        return x._like([cp(x.a[int(k)]) for k in big.reshape(-1)], tuple(reversed(big.shape)))
    a = _arr(x).reshape(tuple(reversed(d)))
    out = _canon(np.ascontiguousarray(np.tile(a, reps)))
    return Char(out) if t is Char else _box(out)


@_bs("cat")
def cat_(dim, *args):
    return _cat(list(args), _int_arg(dim)) if args else np.zeros((0, 0))


@_bs("horzcat")
def horzcat_(*args):
    return _cat(list(args), 2) if args else np.zeros((0, 0))


@_bs("vertcat")
def vertcat_(*args):
    return _cat(list(args), 1) if args else np.zeros((0, 0))


def _flip(x, dim):
    t = type(x)
    if t is Cell or t is Struct or t is StrArr:
        idx = np.arange(len(x.a), dtype=np.int64).reshape(_stored(x.shape))
        ax = idx.ndim - dim
        if ax < 0:
            return cp(x)
        f = np.flip(idx, axis=ax)
        return x._like([cp(x.a[int(k)]) for k in f.reshape(-1)], x.shape)
    a = _arr(x)
    ax = a.ndim - dim
    if ax < 0:
        return cp(x)
    r = np.ascontiguousarray(np.flip(a, axis=ax))
    return Char(r) if t is Char else _box(r)


@_bs("fliplr")
def fliplr_(x):
    return _flip(x, 2)


@_bs("flipud")
def flipud_(x):
    return _flip(x, 1)


@_bs("flip")
def flip_(x, dim=None):
    return _flip(x, _int_arg(dim) if dim is not None else _default_dim(_dims(x)))


@_bs("rot90")
def rot90_(x, k=1.0):
    k = _int_arg(k) % 4
    r = cp(x)
    for _ in range(k):
        r = flipud_(transpose(r))
    return r


@_bs("circshift")
def circshift_(x, k, dim=None):
    a = _arr(x)
    ks = [int(v) for v in _arr(k).reshape(-1)]
    if dim is not None:
        dims = [_int_arg(dim)]
    elif len(ks) == 1:
        dims = [_default_dim(_dims(x))]
    else:
        dims = list(range(1, len(ks) + 1))
    r = a
    for s, dm in zip(ks, dims):
        ax = r.ndim - dm
        if ax >= 0:
            r = np.roll(r, s, axis=ax)
    r = np.ascontiguousarray(r)
    return Char(r) if type(x) is Char else _box(r)


@_bs("diag")
def diag_(x, k=0.0):
    k = _int_arg(k)
    M = _mat(x)
    cls = class_(x)
    oc = cls if cls not in ("logical", "char") else "double"
    if M.shape[0] == 1 or M.shape[1] == 1:
        v = M.reshape(-1)
        n = v.size + abs(k)
        out = np.zeros((n, n), dtype=v.dtype)
        for i in range(v.size):
            if k >= 0:
                out[i, i + k] = v[i]
            else:
                out[i - k, i] = v[i]
        return _finish(np.ascontiguousarray(out.T), oc)
    rows, cols = M.shape
    vals = [M[i, i + k] for i in range(rows) if 0 <= i + k < cols]
    return _finish(np.array(vals, dtype=M.dtype).reshape((1, len(vals))), oc)


@_bs("triu")
def triu_(x, k=0.0):
    return _unmat(np.triu(_mat(x), _int_arg(k)))


@_bs("tril")
def tril_(x, k=0.0):
    return _unmat(np.tril(_mat(x), _int_arg(k)))


@_bs("trace")
def trace_(x):
    M = _mat(x)
    s = sum(M[i, i] for i in range(min(M.shape)))
    return complex(s) if M.dtype.kind == "c" else float(s)


@_bi("meshgrid")
def meshgrid_(nargout, x, y=None, z=None):
    xv = _farr(x).reshape(-1)
    yv = _farr(y if y is not None else x).reshape(-1)
    X = np.tile(xv.reshape((1, -1)), (yv.size, 1))
    Y = np.tile(yv.reshape((-1, 1)), (1, xv.size))
    return _unmat(X) if nargout <= 1 else [_unmat(X), _unmat(Y)]


@_bi("ndgrid")
def ndgrid_(nargout, x, y=None):
    xv = _farr(x).reshape(-1)
    yv = _farr(y if y is not None else x).reshape(-1)
    X = np.tile(xv.reshape((-1, 1)), (1, yv.size))
    Y = np.tile(yv.reshape((1, -1)), (xv.size, 1))
    return _unmat(X) if nargout <= 1 else [_unmat(X), _unmat(Y)]

# ---- linear algebra


def _square(M):
    if M.shape[0] != M.shape[1]:
        raise _err("Matrix must be square.", "MATLAB:square")


@_bs("inv")
def inv_(x):
    M = _mat(x)
    _square(M)
    try:
        if M.size and np.linalg.cond(M) > 1e16:
            raise np.linalg.LinAlgError("singular")
        return _unmat(np.linalg.inv(M))
    except np.linalg.LinAlgError:
        warning_("Matrix is singular to working precision.")
        return _unmat(np.full(M.shape, np.inf))


@_bs("pinv")
def pinv_(x):
    return _unmat(np.linalg.pinv(_mat(x)))


@_bs("det")
def det_(x):
    M = _mat(x)
    _square(M)
    if M.size == 0:
        return 1.0
    if M.dtype.kind == "c":
        return complex(np.linalg.det(M))
    # (LU with partial pivoting, the multipliers by the pivot's reciprocal,
    # as LAPACK computes them: det(magic(3)) is -360 exactly)
    U = M.astype(np.float64).copy()
    n = U.shape[0]
    d = 1.0
    for k in range(n):
        p = k + int(np.argmax(np.abs(U[k:, k])))
        if U[p, k] == 0:
            return 0.0
        if p != k:
            U[[k, p], :] = U[[p, k], :]
            d = -d
        if k + 1 < n:
            l = U[k + 1:, k] * (1.0 / U[k, k])
            U[k + 1:, k + 1:] = U[k + 1:, k + 1:] - l.reshape((-1, 1)) * U[k, k + 1:].reshape((1, -1))
    for k in range(n):
        d = d * U[k, k]
    return float(d)


@_bs("rank")
def rank_(x, tol=None):
    M = _mat(x)
    if M.size == 0:
        return 0.0
    s = np.linalg.svd(M, compute_uv=False)
    t = _scalar(tol) if tol is not None else max(M.shape) * s[0] * 2.220446049250313e-16
    return float(np.sum(s > t))


@_bs("norm")
def norm_(x, p=None):
    M = _mat(x)
    vec = M.shape[0] == 1 or M.shape[1] == 1
    if p is not None and _istext(p):
        ps = _text(p)
        if ps == "fro":
            return float(np.sqrt(np.sum(np.abs(M) ** 2)))
        if ps.lower() == "inf":
            p = _math.inf
        else:
            raise _err("Unknown norm type.")
    pv = 2.0 if p is None else _scalar(p)
    if vec:
        v = np.abs(M.reshape(-1))
        if v.size == 0:
            return 0.0
        if pv == _math.inf:
            return float(np.max(v))
        if pv == -_math.inf:
            return float(np.min(v))
        if pv == 2:
            sc = float(np.max(v))
            if sc == 0 or not _math.isfinite(sc):
                return sc
            return float(sc * np.sqrt(np.sum((v / sc) ** 2)))
        if pv == 1:
            return float(np.sum(v))
        return float(np.sum(v ** pv) ** (1 / pv))
    if M.size == 0:
        return 0.0
    if pv == 2:
        return float(np.linalg.svd(M, compute_uv=False)[0])
    if pv == 1:
        return float(np.max(np.sum(np.abs(M), axis=0)))
    if pv == _math.inf:
        return float(np.max(np.sum(np.abs(M), axis=1)))
    raise _err("Only matrix norms 1, 2, Inf and 'fro' are supported.")


@_bs("cond")
def cond_(x, p=None):
    M = _mat(x)
    s = np.linalg.svd(M, compute_uv=False)
    return float(s[0] / s[-1]) if s[-1] != 0 else _math.inf


@_bi("eig")
def eig_(nargout, x, *args):
    M = _mat(x)
    _square(M)
    sym = M.dtype.kind != "c" and np.array_equal(M, M.T)
    herm = M.dtype.kind == "c" and np.array_equal(M, np.conj(M.T))
    if sym or herm:
        w, V = np.linalg.eigh(M)
    else:
        w, V = np.linalg.eig(M)
        if np.iscomplexobj(w) and not np.any(np.imag(w)):
            w = np.real(w)
            V = np.real(V)
    if nargout <= 1:
        return _unmat(np.asarray(w).reshape((-1, 1)))
    return [_unmat(V), _unmat(np.diag(w))]


@_bi("svd")
def svd_(nargout, x, *args):
    M = _mat(x)
    if nargout <= 1:
        return _unmat(np.linalg.svd(M, compute_uv=False).reshape((-1, 1)))
    econ = bool(args)
    U, s, Vh = np.linalg.svd(M, full_matrices=not econ)
    S = np.zeros((U.shape[1], Vh.shape[0]))
    for k in range(s.size):
        S[k, k] = s[k]
    return [_unmat(U), _unmat(S), _unmat(np.conj(Vh.T))]


@_bi("lu")
def lu_(nargout, x):
    A = _mat(x).astype(np.float64)
    n = A.shape[0]
    U = A.copy()
    L = np.eye(n)
    P = np.eye(n)
    for k in range(n - 1):
        p = int(np.argmax(np.abs(U[k:, k]))) + k
        if p != k:
            U[[k, p], :] = U[[p, k], :]
            P[[k, p], :] = P[[p, k], :]
            L[[k, p], :k] = L[[p, k], :k]
        if U[k, k] != 0:
            for i in range(k + 1, n):
                L[i, k] = U[i, k] / U[k, k]
                U[i, :] = U[i, :] - L[i, k] * U[k, :]
                U[i, k] = 0.0
    if nargout <= 1:
        return _unmat(U + L - np.eye(n))
    if nargout == 2:
        return [_unmat(P.T @ L), _unmat(U)]
    return [_unmat(L), _unmat(U), _unmat(P)]


@_bi("qr")
def qr_(nargout, x, *args):
    Q, R = np.linalg.qr(_mat(x), mode="reduced" if args else "complete")
    if nargout <= 1:
        return _unmat(R)
    return [_unmat(Q), _unmat(R)]


@_bi("chol")
def chol_(nargout, x, *args):
    L = np.linalg.cholesky(_mat(x))
    if args and _istext(args[0]) and _text(args[0]) == "lower":
        return _unmat(L)
    R = np.conj(L.T)
    return _unmat(R) if nargout <= 1 else [_unmat(R), 0.0]


@_bs("null")
def null_(x):
    M = _mat(x)
    U, s, Vh = np.linalg.svd(M)
    tol = max(M.shape) * (s[0] if s.size else 0) * 2.220446049250313e-16
    r = int(np.sum(s > tol))
    return _unmat(np.conj(Vh[r:].T))


@_bs("expm")
def expm_(x):
    M = _mat(x)
    n = M.shape[0]
    nrm = float(np.max(np.sum(np.abs(M), axis=0))) if n else 0.0
    s = max(0, int(_math.ceil(_math.log2(nrm))) + 1) if nrm > 0.5 else 0
    A = M / (2.0 ** s)
    E = np.eye(n)
    term = np.eye(n)
    for k in range(1, 25):
        term = term @ A / k
        E = E + term
    for _ in range(s):
        E = E @ E
    return _unmat(E)

# ---- polynomials, sets, interpolation


@_bs("polyval")
def polyval_(p, x):
    c = _farr(p).reshape(-1)
    X = _farr(x)
    y = np.zeros(X.shape, dtype=np.complex128 if X.dtype.kind == "c" or c.dtype.kind == "c" else np.float64)
    for a in c:
        y = y * X + a
    return _box(y)


@_bs("polyfit")
def polyfit_(x, y, n):
    xv = _farr(x).reshape(-1)
    yv = _farr(y).reshape(-1)
    n = _int_arg(n)
    V = np.array([[xi ** (n - k) for k in range(n + 1)] for xi in xv]).reshape((xv.size, n + 1))
    Q, R = np.linalg.qr(V)
    p = np.linalg.solve(R, Q.T @ yv)
    return _box(np.ascontiguousarray(p.reshape((-1, 1))))


@_bs("roots")
def roots_(p):
    c = _farr(p).reshape(-1)
    nz = np.nonzero(c)[0]
    if nz.size == 0:
        return np.zeros((0, 0))
    trailing = c.size - 1 - int(nz[-1])
    c = c[int(nz[0]):int(nz[-1]) + 1]
    n = c.size - 1
    if n < 1:
        r = np.zeros(0)
    else:
        C = np.zeros((n, n), dtype=c.dtype)
        C[0, :] = -c[1:] / c[0]
        for k in range(1, n):
            C[k, k - 1] = 1
        r = np.linalg.eigvals(C)
    r = np.concatenate([r, np.zeros(trailing)])
    if r.size == 0:
        return np.zeros((0, 1))
    return _unmat(r.reshape((-1, 1)))


@_bs("poly")
def poly_(r):
    v = _farr(r).reshape(-1)
    if not _isvec(r) and _numel(r) > 1:
        v = np.linalg.eigvals(_mat(r))
    c = np.array([1.0 + 0j])
    for z in v:
        c = np.concatenate([c, [0]]) - z * np.concatenate([[0], c])
    if not np.any(np.imag(c)):
        c = np.real(c)
    return _box(np.ascontiguousarray(c.reshape((-1, 1))))


@_bs("conv")
def conv_(a, b, shape=None):
    A = _farr(a).reshape(-1)
    B = _farr(b).reshape(-1)
    r = np.convolve(A, B)
    if shape is not None and _text(shape) == "same":
        st = B.size // 2
        r = r[st:st + A.size]
    col = _dims(a)[1] == 1 and _dims(a)[0] > 1
    return _box(r.reshape((1, -1)) if col else r.reshape((-1, 1)))


@_bi("deconv")
def deconv_(nargout, b, a):
    B = list(_farr(b).reshape(-1))
    A = list(_farr(a).reshape(-1))
    q = []
    r = B[:]
    for k in range(len(B) - len(A) + 1):
        c = r[k] / A[0]
        q.append(c)
        for j in range(len(A)):
            r[k + j] -= c * A[j]
    out = [_box(np.array(q).reshape((-1, 1))), _box(np.array(r).reshape((-1, 1)))]
    return out[0] if nargout <= 1 else out


@_bs("interp1")
def interp1_(x, y, xi, method=None, extrap=None):
    xv = _farr(x).reshape(-1)
    yv = _farr(y).reshape(-1)
    X = _farr(xi)
    order = np.argsort(xv, kind="stable")
    xv = xv[order]
    yv = yv[order]
    flat = X.reshape(-1)
    out = np.interp(flat, xv, yv)
    out = np.where((flat < xv[0]) | (flat > xv[-1]), _math.nan, out)
    return _box(out.reshape(X.shape))


def _uniq_keys(vals, stable):
    first = {}
    for k, v in enumerate(vals):
        if v not in first:
            first[v] = k
    keys = list(first) if stable else sorted(first)
    return keys, first


@_bi("unique")
def unique_(nargout, x, *opts):
    flags = [_text(o) for o in opts if _istext(o)]
    stable = "stable" in flags
    last = "last" in flags
    if type(x) is Cell:
        strs = [_text(e) for e in x.a]
        keys, first = _uniq_keys(strs, stable)
        if last:
            for k, s in enumerate(strs):
                first[s] = k
        r = Cell([Char(s) for s in keys], (1, len(keys)) if x.shape[0] == 1 else (len(keys), 1))
        if nargout <= 1:
            return r
        pos = {s: k for k, s in enumerate(keys)}
        return [r, _box(np.array([float(first[s] + 1) for s in keys]).reshape((1, -1))), _box(np.array([float(pos[s] + 1) for s in strs]).reshape((1, -1)))][:nargout]
    if "rows" in flags:
        M = _mat(x)
        rows = [tuple(float(v) for v in r) for r in M]
        keys, first = _uniq_keys(rows, stable)
        r = _unmat(np.array(keys, dtype=np.float64).reshape((len(keys), M.shape[1])))
        if nargout <= 1:
            return r
        pos = {s: k for k, s in enumerate(keys)}
        return [r, _box(np.array([float(first[s] + 1) for s in keys]).reshape((1, -1))), _box(np.array([float(pos[t] + 1) for t in rows]).reshape((1, -1)))][:nargout]
    A = _arr(x)
    flat = A.reshape(-1)
    cls = class_(x)
    vals = [complex(v) if A.dtype.kind == "c" else float(v) for v in flat]
    good = [v for v in vals if v == v]
    keys, first = _uniq_keys(good, stable)
    if last:
        for k, v in enumerate(vals):
            if v == v:
                first[v] = k
    nans = [k for k, v in enumerate(vals) if v != v]
    idx = [first[v] for v in keys] + nans
    d = _dims(x)
    row = len(d) == 2 and d[0] == 1
    arr = np.array([flat[k] for k in idx], dtype=A.dtype) if idx else np.zeros(0, dtype=A.dtype)
    shaped = arr.reshape((arr.size, 1)) if row else arr.reshape((1, arr.size))
    if d == (0, 0):
        shaped = np.zeros((0, 0), dtype=A.dtype)
    r = Char(shaped) if cls == "char" else _box(shaped)
    if nargout <= 1:
        return r
    pos = {v: k for k, v in enumerate(keys)}
    ic = []
    nk = 0
    for v in vals:
        if v != v:
            nk += 1
            ic.append(float(len(keys) + nk))
        else:
            ic.append(float(pos[v] + 1))
    return [r, _box(np.array([float(k + 1) for k in idx]).reshape((1, -1))), _box(np.array(ic).reshape((1, -1)))][:nargout]


def _setop(a, b, op, nargout, opts):
    stable = any(_istext(o) and _text(o) == "stable" for o in opts)
    if type(a) is Cell or type(b) is Cell:
        A = [_text(e) for e in (a.a if type(a) is Cell else [a])]
        B = [_text(e) for e in (b.a if type(b) is Cell else [b])]
        sb = set(B)
        vals = A + B if op == "union" else [s for s in A if (s in sb) == (op == "intersect")]
        keys, first = _uniq_keys(vals, stable)
        r = Cell([Char(s) for s in keys], (1, len(keys)))
        if nargout <= 1:
            return r
        out = [r, _box(np.array([float(A.index(s) + 1) for s in keys if s in A]).reshape((1, -1)))]
        if op == "intersect":
            out.append(_box(np.array([float(B.index(s) + 1) for s in keys]).reshape((1, -1))))
        return out
    la = [float(v) for v in _farr(a).reshape(-1)]
    lb = [float(v) for v in _farr(b).reshape(-1)]
    sb = set(lb)
    vals = la + lb if op == "union" else [v for v in la if (v in sb) == (op == "intersect")]
    keys, first = _uniq_keys(vals, stable)
    col = _iscolvec(a) and (op != "union" or _iscolvec(b))
    arr = np.array(keys, dtype=np.float64)
    r = _box(arr.reshape((1, arr.size)) if col else arr.reshape((arr.size, 1)))
    if nargout <= 1:
        return r
    out = [r, _box(np.array([float(la.index(v) + 1) for v in keys if v in la]).reshape((1, -1)))]
    if op == "intersect":
        out.append(_box(np.array([float(lb.index(v) + 1) for v in keys]).reshape((1, -1))))
    return out


def _iscolvec(v):
    d = _dims(v)
    return len(d) == 2 and d[1] == 1 and d[0] != 1


@_bi("union")
def union_(nargout, a, b, *opts):
    return _setop(a, b, "union", nargout, opts)


@_bi("intersect")
def intersect_(nargout, a, b, *opts):
    return _setop(a, b, "intersect", nargout, opts)


@_bi("setdiff")
def setdiff_(nargout, a, b, *opts):
    return _setop(a, b, "setdiff", nargout, opts)


@_bi("ismember")
def ismember_(nargout, a, s, *opts):
    if type(s) is Cell or type(a) is Cell:
        S = [_text(e) for e in (s.a if type(s) is Cell else [s])]
        if type(a) is Cell:
            tf = [(_text(e) in S) for e in a.a]
            loc = [float(S.index(_text(e)) + 1) if _text(e) in S else 0.0 for e in a.a]
            r = _box(np.array(tf, dtype=bool).reshape(_stored(a.shape)))
            return r if nargout <= 1 else [r, _box(np.array(loc).reshape(_stored(a.shape)))]
        t = _text(a)
        return (t in S) if nargout <= 1 else [t in S, float(S.index(t) + 1) if t in S else 0.0]
    A = _farr(a)
    pos = {}
    for k, v in enumerate(_farr(s).reshape(-1)):
        pos.setdefault(float(v), k + 1)
    tf = np.array([float(v) in pos for v in A.reshape(-1)], dtype=bool).reshape(A.shape)
    r = _box(tf)
    if nargout <= 1:
        return r
    return [r, _box(np.array([float(pos.get(float(v), 0)) for v in A.reshape(-1)]).reshape(A.shape))]


@_bs("histc")
def histc_(x, edges):
    X = _farr(x).reshape(-1)
    E = _farr(edges).reshape(-1)
    n = np.zeros(E.size)
    for v in X:
        k = int(np.searchsorted(E, v, side="right")) - 1
        if 0 <= k < E.size and (k < E.size - 1 or v == E[-1]):
            n[k] += 1
    return _box(n.reshape(_arr(edges).shape))


@_bs("accumarray")
def accumarray_(subs, vals, sz=None, func=None, fill=0.0):
    S = _mat(subs)
    V = _farr(vals).reshape(-1)
    if S.shape[1] == 1:
        idx = S.reshape(-1).astype(np.int64)
        n = int(np.max(idx)) if idx.size else 0
        if sz is not None and _numel(sz):
            n = int(_arr(sz).reshape(-1)[0])
        groups = [[] for _ in range(n)]
        for k, i in enumerate(idx):
            groups[i - 1].append(float(V[k] if V.size > 1 else V[0]))
        out = np.full(n, _scalar(fill))
        for i, g in enumerate(groups):
            if g:
                if func is None:
                    out[i] = sum(g)
                else:
                    out[i] = _scalar(_call(func, [np.array(g).reshape((1, len(g))) if len(g) > 1 else g[0]]))
        return _box(out.reshape((1, n)))
    m = int(np.max(S[:, 0]))
    n = int(np.max(S[:, 1]))
    out = np.zeros((m, n))
    for k in range(S.shape[0]):
        out[int(S[k, 0]) - 1, int(S[k, 1]) - 1] += V[k] if V.size > 1 else V[0]
    return _unmat(out)

# ---- printing


@_bi("disp")
def disp_(nargout, x):
    _write(_disp_text(x))
    return NOVAL


@_bi("display")
def display_b(nargout, x):
    display("ans", x)
    return NOVAL


_ESC = {"n": "\n", "t": "\t", "\\": "\\", "a": "\a", "r": "\r", "f": "\f", "v": "\v", "b": "\b", "'": "'", '"': '"'}


def _escapes(s):
    """the escape sequences of a format (\\n, \\t, \\x41, \\101)"""
    if "\\" not in s:
        return s
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            d = s[i + 1]
            if d in _ESC:
                out.append(_ESC[d])
                i += 2
                continue
            if d == "x":
                j = i + 2
                while j < n and j < i + 6 and s[j] in "0123456789abcdefABCDEF":
                    j += 1
                if j > i + 2:
                    out.append(chr(int(s[i + 2:j], 16)))
                    i = j
                    continue
            if d in "01234567":
                j = i + 1
                while j < n and j < i + 4 and s[j] in "01234567":
                    j += 1
                out.append(chr(int(s[i + 1:j], 8)))
                i = j
                continue
            out.append(d)
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


_SPEC = _re.compile(r"%(?P<flags>[-+ 0#]*)(?P<width>\*|\d+)?(?:\.(?P<prec>\*|\d+))?(?P<conv>[diouxXfFeEgGcsbt]|l[diouxX]|h[diouxX])")


def _parse_format(f):
    segs = []
    i = 0
    n = len(f)
    lit = []
    while i < n:
        c = f[i]
        if c == "%":
            if i + 1 < n and f[i + 1] == "%":
                lit.append("%")
                i += 2
                continue
            m = _SPEC.match(f, i)
            if m:
                if lit:
                    segs.append("".join(lit))
                    lit = []
                segs.append(m)
                i = m.end()
                continue
        lit.append(c)
        i += 1
    if lit:
        segs.append("".join(lit))
    return segs


def _fmt_items(args):
    items = []
    for a in args:
        t = type(a)
        if t is Char:
            items.append(a.text())
        elif t is Str:
            items.append(a.s)
        elif t is StrArr:
            items.extend(a.a)
        elif t is float:
            items.append(a)
        elif t is bool:
            items.append(1.0 if a else 0.0)
        elif t is complex:
            items.append(a.real)
            items.append(a.imag)
        elif t is np.ndarray:
            A = a.reshape(-1)
            if A.dtype.kind == "c":
                # (MATLAB prints the real parts, then... only the real parts)
                items.extend(float(v) for v in A.real)
            elif A.dtype.kind in "iu":
                items.extend(int(v) for v in A)
            else:
                items.extend(float(v) for v in A)
        elif t is Cell:
            raise _err("Function is not defined for 'cell' inputs.")
        elif t is Struct:
            raise _err("Function is not defined for 'struct' inputs.")
        elif _iscallable(a):
            raise _err("Function is not defined for 'function_handle' inputs.")
        else:
            items.append(a)
    return items


def _pyspec(m, conv, width=None, prec=None):
    flags = m.group("flags") or ""
    w = width if width is not None else (m.group("width") or "")
    p = prec if prec is not None else m.group("prec")
    return "%" + flags + str(w) + ("." + str(p) if p is not None and p != "" else "") + conv


def _nonfinite(x, m, width):
    s = "NaN" if x != x else ("Inf" if x > 0 else "-Inf")
    flags = m.group("flags") or ""
    if "+" in flags and x == _math.inf:
        s = "+Inf"
    w = width if width is not None else (m.group("width") or "")
    if w:
        s = s.ljust(int(w)) if "-" in flags else s.rjust(int(w))
    return s


def _conv(m, item, width, prec):
    conv = m.group("conv")[-1]
    if conv in "diuoxXc" and type(item) is str:
        return None  # (expanded by the caller)
    if conv == "s":
        if type(item) is str:
            return _pyspec(m, "s", width, prec) % item
        # (a number with %s: an integer as itself, else as %e)
        x = float(item)
        if x == _math.floor(x) and _math.isfinite(x):
            return _pyspec(m, "s", width, prec) % ("%d" % x)
        if not _math.isfinite(x):
            return _nonfinite(x, m, width)
        return _pyspec(m, "s", width, prec) % ("%e" % x)
    if conv == "c":
        x = item
        if type(x) is str:
            return x
        return _pyspec(m, "s", width, None) % chr(int(x))
    x = item
    if type(x) is int:
        if conv in "di":
            return _pyspec(m, "d", width, prec) % x
        if conv in "uoxX":
            return _pyspec(m, conv if conv != "u" else "d", width, prec) % x
        x = float(x)
    if conv in "diuoxX":
        if not _math.isfinite(x):
            return _nonfinite(x, m, width)
        if x != _math.floor(x):
            # (MATLAB: a non-integer with %d prints as %e)
            return _pyspec(m, "e", width, prec) % x
        if conv in "oxX":
            if x < 0:
                return _pyspec(m, "e", width, prec) % x
            return _pyspec(m, conv, width, prec) % int(x)
        return _pyspec(m, "d", width, prec) % int(x)
    if not _math.isfinite(x):
        return _nonfinite(x, m, width)
    return _pyspec(m, conv, width, prec) % x


def _sprintf(fmt, args):
    f = _escapes(fmt)
    segs = _parse_format(f)
    items = _fmt_items(args)
    specs = [s for s in segs if type(s) is not str]
    if not specs:
        return "".join(segs)
    out = []
    k = 0
    if not items:
        for s in segs:
            if type(s) is str:
                out.append(s)
            elif s.group("conv")[-1] in "s":
                out.append(_pyspec(s, "s") % "" if not s.group("width") or s.group("width") == "*" else " " * int(s.group("width")))
        return "".join(out)
    while True:
        consumed = False
        for s in segs:
            if type(s) is str:
                out.append(s)
                continue
            width = None
            prec = None
            if s.group("width") == "*":
                if k >= len(items):
                    return "".join(out)
                width = int(items[k])
                k += 1
            if s.group("prec") == "*":
                if k >= len(items):
                    return "".join(out)
                prec = int(items[k])
                k += 1
            if k >= len(items):
                return "".join(out)
            item = items[k]
            r = _conv(s, item, width, prec)
            if r is None:
                # a string with a numeric conversion: its characters, one by one
                codes = [float(ord(c)) for c in item]
                items[k:k + 1] = codes
                if not codes:
                    continue
                item = items[k]
                r = _conv(s, item, width, prec)
            out.append(r)
            k += 1
            consumed = True
        if k >= len(items) or not consumed:
            break
    return "".join(out)


@_bs("sprintf")
def sprintf_(fmt, *args):
    return Char(_sprintf(_text(fmt), args)) if type(fmt) is not Str else Str(_sprintf(fmt.s, args))


_files = {}


@_bi("fprintf")
def fprintf_(nargout, *args):
    fid = 1
    if args and not _istext(args[0]) and _isnumlike(args[0]):
        fid = _int_arg(args[0])
        args = args[1:]
    if not args:
        return NOVAL
    s = _sprintf(_text(args[0]), args[1:])
    if fid == 1:
        _write(s)
    elif fid == 2:
        _write_err(s)
    else:
        fh = _files.get(fid)
        if fh is None:
            raise _err("Invalid file identifier. Use fopen to generate a valid file identifier.")
        fh.write(s)
    return float(len(s)) if nargout >= 1 else NOVAL


def _num2str_scalar(x, prec=None):
    if type(x) is complex or (hasattr(x, "imag") and type(x) is not float and x.imag != 0):
        z = complex(x)
        re_ = _num2str_scalar(z.real, prec)
        im = _num2str_scalar(abs(z.imag), prec)
        return "%s%s%si" % (re_, "-" if z.imag < 0 else "+", im)
    x = float(x)
    if not _math.isfinite(x):
        return _special(x)
    if prec is not None:
        return "%.*g" % (prec, x)
    if x == _math.floor(x):
        return "%d" % x if abs(x) < 1e15 else "%.10g" % x
    return _num2str_g(x)


@_bs("num2str")
def num2str_(x, f=None):
    t = type(x)
    if t is Char:
        return cp(x)
    if t is Str:
        return Char(x.s)
    if not _isnumlike(x):
        raise _err("Input to num2str must be numeric.")
    if f is not None and _istext(f):
        A = _arr(x)
        M = A.T if A.ndim == 2 else A.reshape((-1, 1)).T
        rows = [_sprintf(_text(f), [_box(np.ascontiguousarray(M[i:i + 1, :].T))]) for i in range(M.shape[0])]
        # (num2str trims leading blanks, even with a field width)
        return _pad_rows(_trim_common(rows))
    prec = _int_arg(f) if f is not None else None
    A = _arr(x)
    cls = class_(x)
    if A.size == 1:
        v = A.reshape(-1)[0]
        if cls == "logical" or cls in _INTS:
            return Char("%d" % int(v))
        return Char(_num2str_scalar(complex(v) if A.dtype.kind == "c" else float(v), prec))
    if A.size == 0:
        return Char("")
    M = A.T if A.ndim == 2 else A.reshape((A.shape[0], -1)).T
    rows, cols = M.shape
    if A.dtype.kind == "c":
        strs = [[_num2str_scalar(complex(M[i, j]), prec) for j in range(cols)] for i in range(rows)]
        w = max(len(s) for r in strs for s in r)
        lines = ["  ".join(s.rjust(w) for s in r) for r in strs]
        return _pad_rows(_trim_common(lines))
    F = M.astype(np.float64)
    fin = F[np.isfinite(F)]
    if cls == "logical" or cls in _INTS or (_isint_arr(fin) and prec is None):
        mx = float(np.max(np.abs(fin))) if fin.size else 0.0
        d = len("%d" % mx) if mx else 1
        if np.any(~np.isfinite(F)):
            d = max(d, 3)
        w = d + 2
        lines = []
        for i in range(rows):
            parts = []
            for j in range(cols):
                v = F[i, j]
                s = "%d" % v if _math.isfinite(v) else _special(v)
                parts.append(s.rjust(w))
            lines.append("".join(parts))
        return _pad_rows(_trim_common(lines))
    if prec is None:
        mx = float(np.max(np.abs(fin))) if fin.size else 0.0
        dgt = int(_math.floor(_math.log10(mx))) if mx > 0 else 0
        ndgt = min(max(dgt + 5, 5), 16)
    else:
        ndgt = prec
        dgt = 0
    w = ndgt + 7
    lines = []
    for i in range(rows):
        parts = []
        for j in range(cols):
            v = F[i, j]
            s = ("%.*g" % (ndgt, v)) if _math.isfinite(v) else _special(v)
            parts.append(s.rjust(w))
        lines.append("".join(parts))
    return _pad_rows(_trim_common(lines))


def _trim_common(lines):
    """remove the leading blanks all lines have, and trailing blanks"""
    lines = [l.rstrip() for l in lines]
    lead = min((len(l) - len(l.lstrip(" ")) for l in lines if l.strip()), default=0)
    return [l[lead:] for l in lines]


@_bs("int2str")
def int2str_(x):
    return num2str_(round_(1, x))


def _mat2str_num(x, prec, cls):
    if cls == "logical":
        return "true" if x else "false"
    if type(x) is complex or isinstance(x, complex):
        z = complex(x)
        re_ = _mat2str_num(z.real, prec, "double")
        im = _mat2str_num(z.imag, prec, "double")
        if not im.startswith("-"):
            im = "+" + im
        return re_ + im + "i"
    x = float(x)
    if x != x:
        return "NaN"
    if x == _math.inf:
        return "Inf"
    if x == -_math.inf:
        return "-Inf"
    s = "%.*g" % (prec, x)
    return s


@_bs("mat2str")
def mat2str_(x, *opts):
    prec = 15
    withclass = False
    for o in opts:
        if _istext(o):
            withclass = _text(o) == "class"
        else:
            prec = _int_arg(o)
    t = type(x)
    if t is Char:
        rows = x.rows() if x.a.size else []
        if len(rows) == 1:
            return Char("'" + rows[0].replace("'", "''") + "'")
        if not rows:
            return Char("''")
        return Char("[" + ";".join("'" + r.replace("'", "''") + "'" for r in rows) + "]")
    if t is Str:
        return Char('"' + x.s + '"')
    if not _isnumlike(x):
        raise _err("Input argument must be a numeric, character, or logical array.")
    d = _dims(x)
    if len(d) > 2:
        raise _err("Input matrix must be 2-D.")
    cls = class_(x)
    A = _arr(x)
    M = A.T
    if A.size == 0:
        s = "zeros(%d,%d)" % d if d != (0, 0) else "[]"
        if cls == "logical":
            s = "false(%d,%d)" % d if d != (0, 0) else "false(0,0)"
        return Char(s if not withclass or cls == "double" else "%s(%s)" % (cls, s))
    rows = []
    for i in range(d[0]):
        rows.append(" ".join(_mat2str_num(complex(M[i, j]) if A.dtype.kind == "c" else (bool(M[i, j]) if cls == "logical" else float(M[i, j])), prec, cls) for j in range(d[1])))
    s = rows[0] if A.size == 1 else "[" + ";".join(rows) + "]"
    if withclass and cls not in ("double", "logical"):
        s = "%s(%s)" % (cls, s)
    return Char(s)


def _parse_number(s):
    """a number as str2double reads it, or None"""
    t = s.strip().replace(",", "")
    if not t:
        return None
    low = t.lower()
    sign = 1.0
    body = low
    if body[:1] in "+-":
        sign = -1.0 if body[0] == "-" else 1.0
        body = body[1:]
    if body in ("inf", "infinity"):
        return sign * _math.inf
    if body == "nan":
        return _math.nan
    m = _re.fullmatch(r"([-+]?(?:\d+\.?\d*|\.\d+)(?:[ed][-+]?\d+)?)?\s*(?:([-+])\s*((?:\d+\.?\d*|\.\d+)(?:[ed][-+]?\d+)?)?\s*\*?\s*([ij]))?", low)
    if not m or not m.group(0):
        return None
    re_s, sgn, im_s, unit = m.group(1), m.group(2), m.group(3), m.group(4)
    if unit is None:
        if re_s is None:
            return None
        return float(re_s.replace("d", "e"))
    re_v = float(re_s.replace("d", "e")) if re_s else 0.0
    im_v = float(im_s.replace("d", "e")) if im_s else 1.0
    if sgn == "-":
        im_v = -im_v
    return complex(re_v, im_v)


@_bs("str2double")
def str2double_(x):
    if type(x) is Cell or type(x) is StrArr:
        vals = []
        for e in x.a:
            v = _parse_number(_text(e) if type(e) is not str else e) if (type(e) is Char or type(e) is Str or type(e) is str) else None
            vals.append(_math.nan if v is None else (v if type(v) is float else v))
        return _box(np.array(vals).reshape(_stored(x.shape)))
    if not _istext(x):
        return _math.nan
    if type(x) is Char and x.a.ndim == 2 and _dims(x)[0] > 1:
        return _box(np.array([(_parse_number(r) if _parse_number(r) is not None else _math.nan) for r in x.rows()]).reshape((1, -1)))
    v = _parse_number(_text(x))
    return _math.nan if v is None else v


@_bi("str2num")
def str2num_(nargout, s):
    """str2num for numbers and matrices of numbers ([1 2; 3 4]) -- not general code"""
    t = _text(s).strip()
    if t.startswith("[") and t.endswith("]"):
        t = t[1:-1]
    rows = [r for r in _re.split(r"[;\n]", t) if r.strip()]
    vals = []
    for r in rows:
        parts = [p for p in _re.split(r"[,\s]+", r.strip()) if p]
        row = []
        for p in parts:
            v = _parse_number(p)
            if v is None:
                if p.lower() in ("true", "false"):
                    v = 1.0 if p.lower() == "true" else 0.0
                else:
                    out = np.zeros((0, 0))
                    return out if nargout <= 1 else [out, False]
            row.append(v)
        vals.append(row)
    if not vals:
        out = np.zeros((0, 0))
    else:
        w = len(vals[0])
        if any(len(r) != w for r in vals):
            out = np.zeros((0, 0))
            return out if nargout <= 1 else [out, False]
        out = _unmat(np.array(vals))
    return out if nargout <= 1 else [out, True]

# ---- text functions


def _textlike_map(x, f):
    """f on a char row, a string, or each element of a cell array of text"""
    t = type(x)
    if t is Cell:
        return Cell([_textlike_map(e, f) for e in x.a], x.shape)
    if t is Str:
        return Str(f(x.s))
    if t is StrArr:
        return StrArr([f(s) for s in x.a], x.shape)
    if t is Char:
        if _dims(x)[0] > 1:
            return _rows_char([f(r) for r in x.rows()])
        return Char(f(x.text()))
    return x


@_bs("upper")
def upper_(x):
    return _textlike_map(x, lambda s: s.upper())


@_bs("lower")
def lower_(x):
    return _textlike_map(x, lambda s: s.lower())


_WS = " \t\n\r\f\v\x00"


@_bs("strtrim")
def strtrim_(x):
    if type(x) is Char and _dims(x)[0] > 1:
        rows = _trim_common(x.rows())
        return _pad_rows([r.rstrip(_WS) for r in rows])
    return _textlike_map(x, lambda s: s.strip(_WS))


@_bs("deblank")
def deblank_(x):
    return _textlike_map(x, lambda s: s.rstrip(_WS))


@_bs("blanks")
def blanks_(n):
    return Char(" " * _int_arg(n))


@_bs("newline")
def newline_():
    return Char("\n")


@_bs("strcat")
def strcat_(*args):
    if any(type(a) is Cell for a in args):
        n = max(len(a.a) for a in args if type(a) is Cell)
        shape = next(a.shape for a in args if type(a) is Cell and len(a.a) == n)
        out = []
        for k in range(n):
            s = ""
            for a in args:
                if type(a) is Cell:
                    s += _text(a.a[k if len(a.a) > 1 else 0])
                else:
                    s += _text(a)
            out.append(Char(s))
        return Cell(out, shape)
    if any(type(a) is Str or type(a) is StrArr for a in args):
        return Str("".join(_text(a) for a in args))
    s = ""
    for a in args:
        if type(a) is Char:
            s += a.text().rstrip(" \t\n\r\f\v\x00")
        elif _isnumlike(a):
            s += "".join(chr(int(c)) for c in _arr(a).reshape(-1))
    return Char(s)


def _cmp_text(a, b, f, same_size=False):
    def items(v):
        if type(v) is Cell:
            return [(_text(e) if (type(e) is Char or type(e) is Str) else None) for e in v.a], v.shape
        if type(v) is StrArr:
            return list(v.a), v.shape
        if type(v) is Char:
            if _dims(v)[0] > 1:
                return [None], (1, 1)
            return [v.text()], None
        if type(v) is Str:
            return [v.s], None
        return [None], None
    A, sa = items(a)
    B, sb = items(b)
    if sa is None and sb is None:
        if same_size and type(a) is Char and type(b) is Char and _dims(a) != _dims(b) and not (_numel(a) == 0 and _numel(b) == 0):
            return False
        return A[0] is not None and B[0] is not None and f(A[0], B[0])
    if sa is None:
        A = A * len(B)
        sa = sb
    if sb is None:
        B = B * len(A)
    if len(A) != len(B):
        raise _err("Inputs must be the same size or either one can be a scalar.")
    return _box(np.array([x is not None and y is not None and f(x, y) for x, y in zip(A, B)], dtype=bool).reshape(_stored(sa)))


@_bs("strcmp")
def strcmp_(a, b):
    return _cmp_text(a, b, lambda x, y: x == y, True)


@_bs("strcmpi")
def strcmpi_(a, b):
    return _cmp_text(a, b, lambda x, y: x.lower() == y.lower(), True)


@_bs("strncmp")
def strncmp_(a, b, n):
    k = _int_arg(n)
    return _cmp_text(a, b, lambda x, y: len(x) >= k and len(y) >= k and x[:k] == y[:k])


@_bs("strncmpi")
def strncmpi_(a, b, n):
    k = _int_arg(n)
    return _cmp_text(a, b, lambda x, y: len(x) >= k and len(y) >= k and x[:k].lower() == y[:k].lower())


@_bs("strrep")
def strrep_(s, old, new):
    o = _text(old)
    nw = _text(new)
    return _textlike_map(s, lambda t: t.replace(o, nw) if o else t)


@_bs("strfind")
def strfind_(s, pat):
    if type(s) is Cell:
        return Cell([strfind_(e, pat) for e in s.a], s.shape)
    t = _text(s)
    p = _text(pat)
    idx = []
    k = t.find(p) if p else -1
    while k >= 0:
        idx.append(float(k + 1))
        k = t.find(p, k + 1)
    # (a row: 1-by-0 when there is no match)
    return _box(np.array(idx).reshape((len(idx), 1))) if idx else np.zeros((0, 1))


@_bs("strsplit")
def strsplit_(s, *args):
    t = _text(s)
    delims = None
    collapse = True
    rest = list(args)
    if rest and not (_istext(rest[0]) and _text(rest[0]).lower() == "collapsedelimiters"):
        d = rest.pop(0)
        delims = [_escapes(_text(e)) for e in d.a] if type(d) is Cell else [_escapes(_text(d))]
    while len(rest) >= 2:
        k = _text(rest.pop(0)).lower()
        v = rest.pop(0)
        if k == "collapsedelimiters":
            collapse = bool(cond(v))
    if delims is None:
        delims = [" ", "\f", "\n", "\r", "\t", "\v"]
    pat = "|".join(_re.escape(d) for d in sorted(delims, key=len, reverse=True))
    if collapse:
        pat = "(?:%s)+" % pat
    parts = _re.split(pat, t)
    return Cell([Char(p) for p in parts], (1, len(parts)))


@_bs("strjoin")
def strjoin_(c, delim=None):
    d = _escapes(_text(delim)) if delim is not None else " "
    return Char(d.join(_text(e) for e in c.a))


@_bs("join")
def join_(c, delim=None):
    d = _text(delim) if delim is not None else " "
    vals = [_text(e) if type(e) is not str else e for e in c.a]
    return Str(d.join(vals))


def _text_pred(name, f):
    def g(nargout, s, p, *opts):
        ic = len(opts) >= 2 and _text(opts[0]).lower() == "ignorecase" and cond(opts[1])
        pats = [_text(e) for e in p.a] if type(p) is Cell else ([v for v in p.a] if type(p) is StrArr else [_text(p)])
        def one(t):
            tt = t.lower() if ic else t
            return any(f(tt, q.lower() if ic else q) for q in pats)
        if type(s) is Cell or type(s) is StrArr:
            return _box(np.array([one(_text(e) if type(e) is not str else e) for e in s.a], dtype=bool).reshape(_stored(s.shape)))
        return one(_text(s))
    _B[name] = Builtin(g, name)


_text_pred("contains", lambda t, q: q in t)
_text_pred("startsWith", lambda t, q: t.startswith(q))
_text_pred("endsWith", lambda t, q: t.endswith(q))


def _char_pred(f):
    def g(nargout, s):
        if type(s) is not Char:
            if type(s) is Str:
                return _box(np.array([f(c) for c in s.s], dtype=bool).reshape((len(s.s), 1)))
            return _box(np.zeros(_arr(s).shape, dtype=bool))
        A = s.a
        return _box(np.array([f(chr(int(c))) for c in A.reshape(-1)], dtype=bool).reshape(A.shape))
    return g


_B["isspace"] = Builtin(_char_pred(lambda c: c in " \t\n\r\f\v"), "isspace")
_B["isletter"] = Builtin(_char_pred(lambda c: c.isalpha()), "isletter")


@_bs("isstrprop")
def isstrprop_(s, kind):
    k = _text(kind)
    f = {"alpha": str.isalpha, "digit": str.isdigit, "wspace": lambda c: c in " \t\n\r\f\v", "upper": str.isupper,
         "lower": str.islower, "alphanum": str.isalnum, "punct": lambda c: c.isprintable() and not c.isalnum() and not c.isspace()}[k]
    return _char_pred(f)(1, s)


def _regex(p):
    """MATLAB's regular expression syntax as Python's"""
    p = p.replace("(?<", "(?P<").replace("(?P<=", "(?<=").replace("(?P<!", "(?<!")
    return p


def _regex_rep(r):
    out = []
    i = 0
    while i < len(r):
        c = r[i]
        if c == "$" and i + 1 < len(r) and r[i + 1].isdigit():
            out.append("\\g<%s>" % r[i + 1])
            i += 2
            continue
        if c == "\\" and i + 1 < len(r):
            d = r[i + 1]
            out.append({"n": "\n", "t": "\t", "\\": "\\\\", "$": "$"}.get(d, "\\" + d))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


@_bs("regexprep")
def regexprep_(s, pat, rep, *opts):
    flags = 0
    count = 0
    for o in opts:
        t = _text(o).lower()
        if t == "ignorecase":
            flags |= _re.IGNORECASE
        elif t == "once":
            count = 1
    if type(s) is Cell:
        return Cell([regexprep_(e, pat, rep, *opts) for e in s.a], s.shape)
    rx = _re.compile(_regex(_text(pat)), flags)
    return Char(rx.sub(_regex_rep(_text(rep)), _text(s), count=count)) if type(s) is not Str else Str(rx.sub(_regex_rep(_text(rep)), s.s, count=count))


@_bi("regexp")
def regexp_(nargout, s, pat, *opts):
    return _regexp(nargout, s, pat, opts, 0)


@_bi("regexpi")
def regexpi_(nargout, s, pat, *opts):
    return _regexp(nargout, s, pat, opts, _re.IGNORECASE)


def _regexp(nargout, s, pat, opts, flags):
    t = _text(s)
    once = False
    wanted = []
    for o in opts:
        k = _text(o).lower()
        if k == "once":
            once = True
        elif k == "ignorecase":
            flags |= _re.IGNORECASE
        else:
            wanted.append(k)
    if not wanted:
        wanted = ["start", "end", "tokenextents", "match", "tokens", "names", "split"]
    rx = _re.compile(_regex(_text(pat)), flags)
    ms = list(rx.finditer(t))
    if once:
        ms = ms[:1]

    def row(vals):
        return Cell(vals, (1, len(vals)))

    def tokens(m):
        g = m.groups()
        if not g:
            return row([Char(m.group(0))])
        return row([Char(x if x is not None else "") for x in g])
    out = []
    for w in wanted:
        if w == "match":
            out.append(Char(ms[0].group(0)) if once and ms else (Char("") if once else row([Char(m.group(0)) for m in ms])))
        elif w == "tokens":
            out.append(tokens(ms[0]) if once and ms else (Cell([], (1, 0)) if once else row([tokens(m) for m in ms])))
        elif w == "start":
            v = [float(m.start() + 1) for m in ms]
            out.append(v[0] if once and v else _box(np.array(v).reshape((len(v), 1))) if v else np.zeros((0, 1)) if not once else np.zeros((0, 0)))
        elif w == "end":
            v = [float(m.end()) for m in ms]
            out.append(v[0] if once and v else _box(np.array(v).reshape((len(v), 1))) if v else np.zeros((0, 1)) if not once else np.zeros((0, 0)))
        elif w == "names":
            if ms and rx.groupindex:
                d = {k: Char(ms[0].group(k) or "") for k in rx.groupindex}
                out.append(_struct1(d))
            else:
                out.append(Struct([{}], (1, 1), []))
        elif w == "split":
            parts = []
            last = 0
            for m in ms:
                parts.append(Char(t[last:m.start()]))
                last = m.end()
            parts.append(Char(t[last:]))
            out.append(row(parts))
        elif w == "tokenextents":
            out.append(row([np.array([float(m.start() + 1), float(m.end())]).reshape((2, 1)) for m in ms]))
    if nargout <= 1:
        return out[0]
    return out[:nargout]


# ---- cells and structs


@_bs("cell")
def cell_(*args):
    d, _ = _dimsarg(args, "cell")
    return Cell([_empty_double() for _ in range(_prod(d))], d)


@_bs("struct")
def struct_(*args):
    if not args:
        return Struct([{}], (1, 1), [])
    if len(args) % 2:
        raise _err("Field and value input arguments must come in pairs.")
    names = []
    vals = []
    shape = (1, 1)
    n = 1
    for k in range(0, len(args), 2):
        names.append(_text(args[k]))
        v = args[k + 1]
        vals.append(v)
        if type(v) is Cell and len(v.a) != 1:
            if n != 1 and len(v.a) != n:
                raise _err("Array dimensions of input cell arrays must match.")
            n = len(v.a)
            shape = v.shape
    items = []
    for i in range(n):
        d = {}
        for name, v in zip(names, vals):
            if type(v) is Cell:
                d[name] = cp(v.a[i if len(v.a) > 1 else 0]) if v.a else _empty_double()
            else:
                d[name] = cp(v)
        items.append(d)
    if n == 0:
        return Struct([], shape, names)
    return Struct(items, shape, names)


@_bs("fieldnames")
def fieldnames_(s):
    if type(s) is MException:
        f = ["identifier", "message", "cause", "stack", "Correction"]
    elif type(s) is Struct:
        f = s.fields
    else:
        raise _err("Invalid input argument of type '%s'. Input must be a structure or a Java or COM object." % class_(s))
    return Cell([Char(n) for n in f], (len(f), 1))


@_bs("numfields")
def numfields_(s):
    return float(len(s.fields)) if type(s) is Struct else 0.0


@_bs("isfield")
def isfield_(s, name):
    if type(s) is not Struct:
        return False if type(name) is not Cell else _box(np.zeros(_stored(name.shape), dtype=bool))
    if type(name) is Cell:
        return _box(np.array([type(e) in (Char, Str) and _text(e) in s.fields for e in name.a], dtype=bool).reshape(_stored(name.shape)))
    return _text(name) in s.fields


@_bs("rmfield")
def rmfield_(s, name):
    names = [_text(e) for e in name.a] if type(name) is Cell else [_text(name)]
    for n in names:
        if n not in s.fields:
            raise _err("Unrecognized field name \"%s\"." % n)
    r = cp(s)
    for n in names:
        r.fields.remove(n)
        for d in r.a:
            del d[n]
    return r


@_bs("setfield")
def setfield_(s, name, v):
    return assign(cp(s), [("f", _text(name))], cp(v))


@_bs("getfield")
def getfield_(s, name):
    return cp(field(s, _text(name)))


@_bs("struct2cell")
def struct2cell_(s):
    if len(s.a) == 1:
        return Cell([cp(s.a[0][f]) for f in s.fields], (len(s.fields), 1))
    out = []
    for d in s.a:
        out.extend(cp(d[f]) for f in s.fields)
    return Cell(out, (len(s.fields),) + tuple(s.shape))


@_bs("cell2struct")
def cell2struct_(c, fields, dim=None):
    names = [_text(e) for e in fields.a] if type(fields) is Cell else [r.rstrip() for r in fields.rows()] if type(fields) is Char and _dims(fields)[0] > 1 else [_text(fields)]
    dm = _int_arg(dim) if dim is not None else 1
    r, k = c.shape[0], _prod(c.shape[1:])
    if dm == 1:
        items = [{names[i]: cp(c.a[j * r + i]) for i in range(r)} for j in range(k)]
        return Struct(items, (k, 1), names)
    items = [{names[j]: cp(c.a[j * r + i]) for j in range(k)} for i in range(r)]
    return Struct(items, (r, 1), names)


@_bs("orderfields")
def orderfields_(s):
    r = cp(s)
    r.fields = sorted(r.fields)
    return r


@_bs("num2cell")
def num2cell_(x):
    t = type(x)
    if t is Cell:
        return Cell([Cell([cp(e)], (1, 1)) for e in x.a], x.shape)
    if t is Struct:
        return Cell([Struct([dict(d)], (1, 1), list(x.fields)) for d in x.a], x.shape)
    a = _arr(x)
    return Cell([(_box1(v, a) if t is not Char else Char(chr(int(v)))) for v in a.reshape(-1)], _dims(x))


@_bs("cell2mat")
def cell2mat_(c):
    if type(c) is not Cell:
        raise _err("cell2mat: C must be a cell array.")
    if not c.a:
        return np.zeros((0, 0))
    rows, cols = c.shape[0], _prod(c.shape[1:])
    rowvals = []
    for i in range(rows):
        rowvals.append(_cat([c.a[j * rows + i] for j in range(cols)], 2) if cols > 1 else c.a[i])
    return _cat(rowvals, 1) if rows > 1 else rowvals[0] if type(rowvals[0]) is not np.ndarray else rowvals[0].copy()


def _fn_arg(f):
    if _istext(f):
        name = _text(f)
        return fn(name)
    if _iscallable(f):
        return f
    raise _err("Expected a function handle.")


def _uniform_opts(args):
    """(arrays, uniform, error handler) from cellfun's or arrayfun's arguments"""
    arrays = []
    uniform = True
    handler = None
    i = 0
    args = list(args)
    while i < len(args):
        a = args[i]
        if _istext(a) and i + 1 < len(args) and _text(a).lower() in ("uniformoutput", "errorhandler"):
            k = _text(a).lower()
            if k == "uniformoutput":
                uniform = bool(cond(args[i + 1]))
            else:
                handler = args[i + 1]
            i += 2
            continue
        arrays.append(a)
        i += 1
    return arrays, uniform, handler


def _apply_each(nargout, f, arrays, uniform, handler, elems, shape):
    """f on each element (elems(k) -> the arguments), collected"""
    n = _prod(shape)
    nout = max(1, nargout)
    results = [[] for _ in range(nout)]
    for k in range(n):
        argv = elems(k)
        try:
            r = f.call(nout, argv)
        except MatlabError as e:
            if handler is None:
                raise
            st = _struct1({"message": Char(e.message), "identifier": Char(e.identifier), "index": float(k + 1)})
            r = handler.call(nout, [st] + argv)
        if nout == 1:
            r = [r]
        for j in range(nout):
            results[j].append(r[j])
    outs = []
    for j in range(nout):
        vals = results[j]
        if uniform:
            for v in vals:
                if not _isnumlike(v) or _numel(v) != 1:
                    raise _err("Non-scalar in Uniform output. Set 'UniformOutput' to false.")
            if not vals:
                outs.append(np.zeros(_stored(shape)))
                continue
            cls = _cat_class(vals)
            if cls == "logical":
                arr = np.array([bool(_arr(v).reshape(-1)[0]) for v in vals], dtype=bool)
            elif cls == "char":
                arr = np.array([float(_arr(v).reshape(-1)[0]) for v in vals])
            elif cls in _INTS or cls == "single":
                arr = np.array([_arr(v).reshape(-1)[0] for v in vals]).astype(_INTS[cls][0] if cls in _INTS else np.float32)
            else:
                cvals = [_arr(v).reshape(-1)[0] for v in vals]
                arr = np.array([complex(v) for v in cvals]) if any(np.iscomplexobj(np.asarray(v)) for v in cvals) else np.array([float(v) for v in cvals])
            arr = arr.reshape(_stored(shape))
            outs.append(Char(arr) if cls == "char" else _box(arr) if cls in ("double", "logical") else _canon(arr))
        else:
            outs.append(Cell(vals, shape))
    return outs[0] if nargout <= 1 else outs


@_bi("cellfun")
def cellfun_(nargout, f, *args):
    arrays, uniform, handler = _uniform_opts(args)
    if _istext(f):
        name = _text(f)
        legacy = {"isempty": lambda e: _numel(e) == 0, "length": length_, "ndims": ndims_, "prodofsize": lambda e: float(_numel(e)),
                  "isreal": isreal_, "islogical": islogical_}
        if name in legacy and len(arrays) == 1:
            c = arrays[0]
            vals = [legacy[name](e) for e in c.a]
            dt = bool if name in ("isempty", "isreal", "islogical") else np.float64
            return _box(np.array(vals, dtype=dt).reshape(_stored(c.shape)))
    fh = _fn_arg(f)
    for a in arrays:
        if type(a) is not Cell:
            raise _err("cellfun: C must be a cell array.")
    shape = arrays[0].shape
    for a in arrays[1:]:
        if len(a.a) != len(arrays[0].a):
            raise _err("All of the input arguments must be of the same size and shape.")
    return _apply_each(nargout, fh, arrays, uniform, handler, lambda k: [a.a[k] for a in arrays], shape)


def _element(a, k):
    t = type(a)
    if t is Cell:
        return Cell([a.a[k]], (1, 1))
    if t is Struct:
        return Struct([a.a[k]], (1, 1), list(a.fields))
    if t is StrArr:
        return Str(a.a[k])
    if t is Str:
        return a
    A = _arr(a)
    v = A.reshape(-1)[k]
    if t is Char:
        return Char(chr(int(v)))
    return _box1(v, A)


@_bi("arrayfun")
def arrayfun_(nargout, f, *args):
    arrays, uniform, handler = _uniform_opts(args)
    fh = _fn_arg(f)
    shape = _dims(arrays[0])
    for a in arrays[1:]:
        if _numel(a) != _numel(arrays[0]):
            raise _err("All of the input arguments must be of the same size and shape.")
    return _apply_each(nargout, fh, arrays, uniform, handler, lambda k: [_element(a, k) for a in arrays], shape)


@_bi("structfun")
def structfun_(nargout, f, s, *args):
    _, uniform, handler = _uniform_opts(args)
    fh = _fn_arg(f)
    vals = [s.a[0][n] for n in s.fields]
    r = _apply_each(nargout, fh, [], uniform, handler, lambda k: [vals[k]], (len(vals), 1))
    if not uniform:
        out = r if nargout <= 1 else r[0]
        st = _struct1({n: out.a[k] for k, n in enumerate(s.fields)})
        return st
    return r


@_bs("func2str")
def func2str_(f):
    return Char(func2str_text(f))


@_bs("str2func")
def str2func_(s):
    t = _text(s).strip()
    if t.startswith("@"):
        host = _sys.modules.get("_matlab_files")
        if host is None:
            try:
                import _matlab_files as host
            except ImportError:
                host = None
        if host is not None and hasattr(host, "anonymous"):
            return host.anonymous(t)
        raise _err("str2func of an anonymous function's text is not supported here.")
    return Handle(None, t)


@_bi("feval")
def feval_(nargout, f, *args):
    fh = _fn_arg(f)
    return fh.call(nargout, list(args))


@_bi("deal")
def deal_(nargout, *args):
    n = max(1, nargout)
    if len(args) == 1:
        return cp(args[0]) if n == 1 else [cp(args[0]) for _ in range(n)]
    if len(args) != n:
        raise _err("The number of outputs should match the number of inputs.")
    return cp(args[0]) if n == 1 else [cp(a) for a in args]


def _isequal2(a, b, nan_equal):
    ta, tb = type(a), type(b)
    if ta is Cell or tb is Cell:
        if ta is not tb or a.shape != b.shape:
            return False
        return all(_isequal2(x, y, nan_equal) for x, y in zip(a.a, b.a))
    if ta is Struct or tb is Struct:
        if ta is not tb or a.shape != b.shape or set(a.fields) != set(b.fields):
            return False
        return all(_isequal2(x[f], y[f], nan_equal) for x, y in zip(a.a, b.a) for f in a.fields)
    if ta in (Str, StrArr) or tb in (Str, StrArr):
        try:
            sa = _strings_of(a) if ta is not Cell else None
            sb = _strings_of(b) if tb is not Cell else None
        except MatlabError:
            return False
        return _dims(a) == _dims(b) and sa == sb
    if _iscallable(a) or _iscallable(b):
        return a is b
    if not (_isnumlike(a) and _isnumlike(b)):
        return False
    if _dims(a) != _dims(b):
        return False
    A = _farr(a)
    B = _farr(b)
    if nan_equal:
        both = np.isnan(A) & np.isnan(B) if A.dtype.kind != "c" else np.zeros(A.shape, dtype=bool)
        return bool(np.all((A == B) | both))
    return bool(np.all(A == B))


@_bs("isequal")
def isequal_(a, b, *more):
    return all(_isequal2(a, x, False) for x in (b,) + more)


@_bs("isequaln")
def isequaln_(a, b, *more):
    return all(_isequal2(a, x, True) for x in (b,) + more)

# ---- errors


def _error_args(args):
    """(identifier, message) of error(...)/warning(...)"""
    if len(args) == 1 and type(args[0]) is Struct:
        d = args[0].a[0]
        return _text(d.get("identifier", Char(""))) if "identifier" in d else "", _text(d.get("message", Char("")))
    if not args:
        return "", ""
    first = _text(args[0])
    if len(args) == 1:
        return "", first
    ident = ""
    rest = list(args[1:])
    if _re.fullmatch(r"[A-Za-z][\w-]*(:[\w-]+)+", first) and rest:
        ident = first
        fmt = _text(rest.pop(0))
        return ident, _sprintf(fmt, rest) if rest or "%" in fmt or "\\" in fmt else _escapes(fmt)
    return ident, _sprintf(first, rest)


@_bi("error")
def error_(nargout, *args):
    ident, msg = _error_args(args)
    if not msg and not ident:
        return NOVAL
    raise MatlabError(msg, ident)


@_bi("warning")
def warning_b(nargout, *args):
    if args and _istext(args[0]) and _text(args[0]).lower() in ("on", "off", "query", "error"):
        return NOVAL
    ident, msg = _error_args(args)
    if msg:
        warning_(msg, ident)
    return NOVAL


@_bs("MException")
def mexception_(ident, fmt, *args):
    return MException(_text(ident), _sprintf(_text(fmt), args))


def _throw(err):
    if type(err) is MException:
        e = MatlabError(err.message, err.identifier)
        e._mexc = err
        raise e
    if type(err) is Struct:
        ident, msg = _error_args([err])
        raise MatlabError(msg, ident)
    raise _err("Input must be an MException object.")


@_bi("rethrow", "throw", "throwAsCaller")
def rethrow_(nargout, err):
    _throw(err)


@_bi("assert")
def assert_(nargout, c, *args):
    if not cond(c):
        if args:
            ident, msg = _error_args(args)
            raise MatlabError(msg, ident)
        raise MatlabError("Assertion failed.", "MATLAB:assertion:failed")
    return NOVAL


@_bi("getReport")
def getreport_(nargout, err, *a):
    return Char(err.message)

# ---- time, environment, output format

import time as _time

_tic = [None]


@_bi("tic")
def tic_(nargout):
    t = _time.time()
    _tic[0] = t
    if nargout >= 1:
        return np.array([[int(t * 1e6)]], dtype=np.uint64)
    return NOVAL


@_bi("toc")
def toc_(nargout, t0=None):
    start = (float(_arr(t0).reshape(-1)[0]) / 1e6) if t0 is not None else _tic[0]
    if start is None:
        raise _err("You must call TIC without an output argument before calling TOC without an input argument.")
    dt = _time.time() - start
    if nargout >= 1:
        return dt
    _write("Elapsed time is %f seconds.\n" % dt)
    return NOVAL


@_bs("clock")
def clock_():
    t = _time.localtime()
    return np.array([float(t.tm_year), float(t.tm_mon), float(t.tm_mday), float(t.tm_hour), float(t.tm_min), float(t.tm_sec)]).reshape((6, 1))


@_bs("cputime")
def cputime_():
    return _time.time()


def _noop(nargout, *args):
    return NOVAL


for _n in ("clc", "drawnow", "pause", "beep", "more", "commandwindow", "dbstop", "profile", "diary", "pkg", "graphics_toolkit"):
    _B[_n] = Builtin(_noop, _n)


@_bi("format")
def format_(nargout, *args):
    if not args:
        _format["num"] = "short"
        _format["spacing"] = "loose"
        return NOVAL
    for a in args:
        s = _text(a).lower()
        if s in ("compact", "loose"):
            _format["spacing"] = s
        elif s == "default":
            _format["num"] = "short"
            _format["spacing"] = "loose"
        elif s in ("short", "long"):
            _format["num"] = s
        elif s in ("shortg", "longg", "shorte", "longe", "rat", "bank", "hex", "+"):
            _format["num"] = "long" if s.startswith("long") else "short"
    return NOVAL


@_bs("ispc")
def ispc_():
    return False


@_bs("isunix")
def isunix_():
    return True


@_bs("ismac")
def ismac_():
    return False


@_bs("isdeployed")
def isdeployed_():
    return False


@_bs("usejava")
def usejava_(*a):
    return False


@_bs("version")
def version_(*a):
    return Char("9.14.0 (R2023a) (Sagebrush)")


@_bs("verLessThan")
def verlessthan_(*a):
    return False


@_bs("computer")
def computer_(*a):
    return Char("GLNXA64")


@_bs("isvarname")
def isvarname_(s):
    t = _text(s) if _istext(s) else ""
    return bool(_re.fullmatch(r"[A-Za-z]\w{0,62}", t)) and t not in _MKW


_MKW = set("break case catch classdef continue else elseif end for function global if otherwise parfor persistent return spmd switch try while".split())


@_bs("iskeyword")
def iskeyword_(s=None):
    if s is None:
        return Cell([Char(k) for k in sorted(_MKW)], (len(_MKW), 1))
    return _text(s) in _MKW


@_bs("nthroot")
def nthroot_(x, n):
    X = _farr(x)
    N = _farr(n)
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.sign(X) * np.abs(X) ** (1.0 / N)
        r = np.where((X < 0) & (np.mod(N, 2) == 0), _math.nan, r)
    return _box(r)


def _bitop(f):
    def g(nargout, a, b, *rest):
        cls = _arith_class(a, b, "bitand")
        A = _farr(a).astype(np.int64)
        B = _farr(b).astype(np.int64)
        return _finish(f(A, B).astype(np.float64), cls)
    return g


_B["bitand"] = Builtin(_bitop(lambda a, b: a & b), "bitand")
_B["bitor"] = Builtin(_bitop(lambda a, b: a | b), "bitor")
_B["bitxor"] = Builtin(_bitop(lambda a, b: a ^ b), "bitxor")
_B["bitshift"] = Builtin(_bitop(lambda a, b: np.where(b >= 0, a << np.maximum(b, 0), a >> np.maximum(-b, 0))), "bitshift")

# ---- the workspace


def _ws_vars(ns):
    out = []
    for k, v in ns.items():
        if k.startswith("_") and not k.startswith("_k_"):
            continue
        if isinstance(v, Undef) or type(v) is Function or type(v) is type(_math):
            continue
        if callable(v) and type(v) not in _CALLABLE and not isinstance(v, (Cell, Struct, Char, Str, StrArr)):
            continue
        out.append(k[3:] if k.startswith("_k_") else k)
    return out


def ws_call(name, ns, args, nargout):
    """functions that see the caller's variables"""
    if name in ("clear", "clearvars"):
        names = [_text(a) for a in args]
        flags = [n for n in names if n.startswith("-")]
        names = [n for n in names if not n.startswith("-")]
        if not names or names[0] in ("all", "variables", "-all"):
            if names and names[0] == "all":
                _globals.clear()
                _persistents.clear()
            names = _ws_vars(ns)
        elif names[0] in ("functions", "classes", "global", "import"):
            if names[0] == "global":
                _globals.clear()
            return NOVAL
        import fnmatch
        allv = _ws_vars(ns)
        for n in names:
            for v in allv:
                if fnmatch.fnmatchcase(v, n):
                    key = "_k_" + v if v in _PYKW else v
                    if key in ns:
                        try:
                            del ns[key]
                        except Exception:
                            ns[key] = Undef(v)
        return NOVAL
    if name == "exist":
        n = _text(args[0])
        kind = _text(args[1]) if len(args) > 1 else None
        key = "_k_" + n if n in _PYKW else n
        if (kind in (None, "var")) and key in ns and not isinstance(ns[key], Undef) and type(ns[key]) is not Function:
            return 1.0
        if kind == "var":
            return 0.0
        if kind in (None, "builtin") and n in _B:
            return 5.0
        if kind in (None, "file") and (type(ns.get(key)) is Function or _from_path(n) is not None):
            return 2.0
        if kind == "dir" or kind == "file" or kind is None:
            import os
            try:
                if os.path.isdir(n):
                    return 7.0
                if os.path.isfile(n):
                    return 2.0
            except Exception:
                pass
        return 0.0
    if name in ("who", "whos"):
        vs = sorted(_ws_vars(ns))
        if nargout >= 1:
            return Cell([Char(v) for v in vs], (len(vs), 1))
        if vs:
            _write("\nYour variables are:\n\n" + "  ".join(vs) + "  \n\n")
        return NOVAL
    if name in ("load", "save"):
        return _matfile(name, ns, args, nargout)
    raise _undefined(name)


_PYKW = set(("False None True and as assert async await break class continue def del elif else except finally for from global "
             "if import in is lambda nonlocal not or pass raise return try while with yield match case type globals locals print exec").split())


def _matfile(name, ns, args, nargout):
    raise _err("%s of .mat files is not available yet." % name)


def case_match(v, c):
    """whether switch value v matches case value c (a cell: any of its elements)"""
    if type(c) is Cell:
        for e in c.a:
            if case_match(v, e):
                return True
        return False
    if _istext(v) or _istext(c):
        return _istext(v) and _istext(c) and _text(v) == _text(c)
    if _isnumlike(v) and _isnumlike(c):
        if _numel(v) == 0 or _numel(c) == 0:
            return False
        if _numel(c) != 1:
            raise _err("SWITCH expression must be a scalar or a character vector.")
        return _scalar(v) == _scalar(c) and (type(v) is not complex or v == complex(_arr(c).reshape(-1)[0]))
    return False


@_bs("magic")
def magic_(n):
    """MATLAB's magic squares (odd, doubly even and singly even orders)"""
    n = _int_arg(n)
    if n < 1:
        return np.zeros((0, 0))
    if n == 2:
        return _unmat(np.array([[4.0, 3.0], [1.0, 2.0]]))
    M = np.zeros((n, n))
    if n % 2 == 1:
        # (MATLAB: J + 1 and I + 1 column/row shifts of the siamese method)
        for i in range(n):
            for j in range(n):
                a = (i + 1 + j + 1 - (n + 3) // 2) % n
                b = (i + 1 + 2 * (j + 1) - 2) % n
                M[i, j] = n * a + b + 1
    elif n % 4 == 0:
        for i in range(n):
            for j in range(n):
                v = i * n + j + 1
                keep = ((i + 1) % 4 // 2) == ((j + 1) % 4 // 2)
                M[i, j] = n * n + 1 - v if keep else v
    else:
        p = n // 2
        A = _mat(magic_(float(p)))
        M[:p, :p] = A
        M[p:, p:] = A + p * p
        M[:p, p:] = A + 2 * p * p
        M[p:, :p] = A + 3 * p * p
        k = (n - 2) // 4
        cols = list(range(k)) + list(range(n - k + 1, n))
        for i in range(p):
            for j in cols:
                M[i, j], M[i + p, j] = M[i + p, j], M[i, j]
        for j in (0, k):
            M[k, j], M[k + p, j] = M[k + p, j], M[k, j]
    return _unmat(M)
