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

# (MATLAB has no limit on an integer's digits: CPython's 4300 is lifted;
# the only other bound is memory, admitted first: src/runtime/format.ts)
_sys.set_int_max_str_digits(0)

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


# (the function catalog's absent entries, catalog/matlab: name -> what to use instead)
_ABSENT = [None]


def _absent_alternative(name):
    """what the catalog says to use instead of a MATLAB function Sagebrush lacks, or None
    (containers.Map is found by its first word too, the name MATLAB reports undefined)"""
    if _ABSENT[0] is None:
        table = {}
        try:
            import _catalog
            for _, e in _catalog.load("matlab"):
                if isinstance(e, dict) and e.get("status") == "absent" and e.get("alternative"):
                    table[e["name"]] = (e["name"], e["alternative"])
                    table.setdefault(e["name"].split(".")[0], (e["name"], e["alternative"]))
        except Exception:
            pass
        _ABSENT[0] = table
    return _ABSENT[0].get(name)


def _undefined_message(name):
    """MATLAB's message for a name that is no variable or function, with the catalog's
    alternative when the name is a MATLAB function Sagebrush lacks: an agent reads the
    error, so the error says what to use"""
    msg = "Unrecognized function or variable '%s'." % name
    alt = _absent_alternative(name)
    if alt is not None:
        msg += " %s is not in Sagebrush; instead: %s" % (alt[0], alt[1])
    return msg


def _undefined(name):
    return MatlabError(_undefined_message(name), "MATLAB:UndefinedFunction")


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
        return _undefined_message(name)
    if isinstance(e, RecursionError):
        return "Maximum recursion limit of 500 reached."
    if isinstance(e, MemoryError):
        # (a memory guard's refusal says what needed how much, and where to
        # run with more: item D; any other is MATLAB's own words)
        if type(e).__name__ == "SagebrushMemoryError" and type(e).__module__ == "_memguard":
            return str(e)
        return "Out of memory."
    if isinstance(e, ZeroDivisionError):
        return "Division by zero."
    return "%s" % (e,) if str(e) else type(e).__name__


def _identifier(e):
    if isinstance(e, MatlabError):
        return e.identifier
    if isinstance(e, NameError):
        return "MATLAB:UndefinedFunction"
    if isinstance(e, MemoryError):
        # (a memory guard's refusal, or the session's own: MATLAB's out of memory)
        return "MATLAB:nomem"
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
    try:
        end_program()
    except Exception:
        pass
    _sys.stdout.flush()
    if _os.environ.get("SAGEBRUSH_MATLAB_TRACEBACK") and not isinstance(e, MatlabError):
        # (for debugging the runtime: where in Python an internal error came from)
        import traceback
        traceback.print_exception(type(e), e, e.__traceback__)
    st = list(getattr(e, "_mstack", None) or [])
    out = [_message(e)]
    if getattr(e, "_using", False) and st:
        # (error() or argument validation in a function: MATLAB names the function first)
        out = ["Error using %s" % st[0][0], _message(e)]
    lines = _src[1]
    for fname, ln in list(getattr(e, "_mstack", None) or []) + [(_scriptname(), line)]:
        out.append("")
        out.append("Error in %s (line %d)" % (fname, ln))
        if 0 < ln <= len(lines):
            out.append(lines[ln - 1].strip())
    _sys.stderr.write("\n".join(out) + "\n")
    raise SystemExit(1)


_cell_failed = [False]
# (the last cell's error text, and whether the host shows it itself, as a Jupyter error)
_cell_error = [None, False]


def report_cell(e, line):
    """An error that stops a notebook cell: reported as in report(), without the
    cell's own frame and without ending the session (cell_failed() tells the
    session the cell failed)."""
    if isinstance(e, ScriptReturn):
        return
    if isinstance(e, (SystemExit, KeyboardInterrupt)):
        raise e
    try:
        end_program()
    except Exception:
        pass
    _sys.stdout.flush()
    if _os.environ.get("SAGEBRUSH_MATLAB_TRACEBACK") and not isinstance(e, MatlabError):
        import traceback
        traceback.print_exception(type(e), e, e.__traceback__)
    st = list(getattr(e, "_mstack", None) or [])
    out = [_message(e)]
    if getattr(e, "_using", False) and st:
        out = ["Error using %s" % st[0][0], _message(e)]
    for fname, ln in st:
        out.append("")
        out.append("Error in %s (line %d)" % (fname, ln))
    text = "\n".join(out) + "\n"
    if _cell_error[1]:
        _cell_error[0] = text
    else:
        _sys.stderr.write(text)
    _cell_failed[0] = True


def cell_failed():
    """whether the last cell stopped on an error (and forget it)"""
    f = _cell_failed[0]
    _cell_failed[0] = False
    return f


def host_shows_errors():
    """a cell's error is kept for cell_error() rather than written to stderr (the Jupyter kernel)"""
    _cell_error[1] = True


def cell_error():
    """the last cell's error message, or None (and forget it)"""
    t = _cell_error[0]
    _cell_error[0] = None
    _cell_failed[0] = False
    return t


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


def _contig(a):
    """a C-contiguous array with a's values (a copy: Sagebrush's numpy's
    ascontiguousarray can return a view whose reshape(-1) is a copy)"""
    return np.array(a)


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
            a = _contig(a.real)
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
    if t is Sparse:
        return _sp.full_arr(v)
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
    if t is Sparse:
        return _farr(_sp.full(v), name)
    raise _optype(name, v)


def _optype(name, *vals):
    return _err("Undefined function '%s' for input arguments of type '%s'." % (name, class_(vals[0]) if vals else "?"), "MATLAB:UndefinedFunction")


def _isnumlike(v):
    t = type(v)
    return t is float or t is bool or t is complex or t is np.ndarray or t is Char or t is int or t is Sparse


def _dims(v):
    t = type(v)
    if t is float or t is bool or t is complex or t is int:
        return (1, 1)
    if t is np.ndarray:
        return tuple(reversed(v.shape))
    if t is Char:
        return tuple(reversed(v.a.shape))
    if t is Cell or t is Struct or t is StrArr or t is HandleArr:
        return v.shape
    if t is Sparse:
        return (v.m, v.n)
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
    if t is Cell or t is Struct or t is StrArr or t is HandleArr:
        return len(v.a)
    if t is Sparse:
        return v.m * v.n
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
    return _box(_contig(m.T))


def _int_round(r, cls):
    """MATLAB's conversion to an integer class: round half away from zero, saturate, NaN is 0."""
    dt, lo, hi = _INTS[cls]
    r = np.asarray(r)
    if r.dtype.kind == "c":
        # (a complex integer array is not represented: refused rather than its imaginary part dropped;
        # a zero imaginary part leaves a real array)
        if np.any(r.imag != 0):
            raise _err("Complex %s values are not supported in Sagebrush." % cls)
        r = r.real
    if r.dtype.kind in "iu":
        # (the bounds inside the source class's own range, which clip needs)
        _, slo, shi = _INTS[_dtclass(r.dtype)]
        # (an integer source holding -2^63 holds it exactly: intmin, or saturation to it)
        return _int64_exact(np.clip(r, max(lo, slo), min(hi, shi)).astype(dt), cls, True)
    r = np.where(np.isnan(r), 0.0, r)
    # (a double of magnitude 2^52 or more is already an integer: adding 0.5 there would round
    # it up, uint64(2^53 - 1) becoming 2^53)
    r = np.where(np.abs(r) >= 2.0 ** 52, r, np.where(r >= 0, np.floor(r + 0.5), -np.floor(-r + 0.5)))
    # (-2^63 from a double is exact only when it saturates a value strictly below it: a
    # double equal to -2^63 may be a rounded -2^63 + k, intmin('int64') + 1 among them)
    low = r < -(2.0 ** 63)
    return _int64_exact(np.clip(r, float(lo), float(hi)).astype(dt), cls, low)


def _int64_exact(a, cls, exact_low=False):
    """a, if an int64 or uint64 result Sagebrush holds exactly: its 64-bit integers keep 53
    bits, as doubles do, so a value of 2^53 or more in magnitude (int64(2)^62, uint64(2^53) + 1,
    computed as 2^53, a saturated limit) is refused rather than shown rounded; -2^63 is kept
    where exact_low says it is exact (saturation from below, or an integer source)"""
    if cls in ("int64", "uint64") and a.size:
        m = np.abs(a.astype(np.float64))
        # (2^53 itself too: a double result there may be a rounded 2^53 + 1, while one below
        # it is exact for integer operands)
        bad = (m >= 2.0 ** 53) & ~((a.astype(np.float64) == -(2.0 ** 63)) & exact_low)
        if np.any(bad):
            v = float(a.reshape(-1)[np.flatnonzero(bad)[0]])
            raise _err("%s values of 2^53 or more in magnitude (here about %.17g) are not supported: Sagebrush's 64-bit integers are not exact there." % (cls, v))
    return a


def _finish(r, cls):
    """an arithmetic result (float64/complex128) in the result class"""
    if cls == "double":
        return _box(r)
    if cls == "single":
        if r.dtype.kind == "c" and not np.any(r.imag):
            # (a computed complex result with no imaginary part is real, as _box makes doubles)
            r = r.real
        return _canon(r.astype(np.complex64 if r.dtype.kind == "c" else np.float32))
    if cls == "logical":
        return _box(r.astype(bool))
    return _canon(_int_round(r, cls))


def _single_values(M):
    """M's values rounded to single, kept as a double (or complex double) array"""
    if M.dtype.kind == "c":
        return M.astype(np.complex64).astype(np.complex128)
    return M.astype(np.float32).astype(np.float64)


def _single_scalar(z):
    """a real or complex number rounded to single (each part), as a Python number"""
    if isinstance(z, (complex, np.complexfloating)):
        a, b = np.array([z.real, z.imag], dtype=np.float32).tolist()
        return complex(a, b)
    return np.array([z], dtype=np.float32).tolist()[0]


# (the most element steps conv, polyval or interp1 may do in single arithmetic: conv's
# products, polyval's coefficients times points, interp1's queries times columns)
_SINGLE_STEPS_WORK = 20_000_000


def _float_class(*xs):
    """the class of a floating result computed from xs: single when any of them is, else double"""
    return "single" if any(class_(x) == "single" for x in xs) else "double"


def _arith_class(a, b, name):
    ca = class_(a)
    cb = class_(b)
    ia = ca in _INTS
    ib = cb in _INTS
    for c, v in ((ca, a), (cb, b)):
        if c in ("cell", "struct", "function_handle", "string"):
            raise _err("Operator '%s' is not supported for operands of type '%s'." % (_OPSYM.get(name, name), c), "MATLAB:UndefinedFunction")
    if ia or ib:
        if (ia and ib and ca != cb) or "single" in (ca, cb):
            # (an integer combines only with its own class or with double: int8(3) + single(1.5)
            # is an error in MATLAB, though Octave computes it)
            raise _err("Integers can only be combined with integers of the same class, or scalar doubles.", "MATLAB:mixedClasses")
        # (an integer with a double array is computed elementwise, as Octave does; MATLAB's page on
        # integer arithmetic names only a scalar double, so a MATLAB-confirmed check may revisit it)
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
    if f is _mul and cls == "single" and "double" not in (class_(a), class_(b)):
        # (single by single: single arithmetic at each step. With a double operand, MATLAB
        # converts the single to double, computes in double and makes the result single, so the
        # product's parts are rounded once, by _finish)
        f = _mul_single
    r = _broadcast(f, _farr(a, name), _farr(b, name))
    return _finish(r, cls)


def _add(A, B):
    return A + B


def _sub(A, B):
    return A - B


def _mul(A, B, single=False):
    if (A.dtype.kind == "c") != (B.dtype.kind == "c"):
        # (a real times a complex: each part on its own, so that a zero part stays zero)
        R, Z = (A, B) if B.dtype.kind == "c" else (B, A)
        with np.errstate(invalid="ignore"):
            re_ = np.where(Z.real == 0, 0.0, R * Z.real)
            im = np.where(Z.imag == 0, 0.0, R * Z.imag)
        return _cplx(re_, im)
    if A.dtype.kind == "c":
        # (two complex values: four products and two sums, as compiled complex arithmetic does)
        return _cmul_arr(A, B, single)
    return A * B


def _mul_single(A, B):
    """_mul for a single result: complex products rounded to single at each step (one real
    product rounds once, so the real cases need nothing more)"""
    return _mul(A, B, True)


def _cplx(re_, im):
    """a complex array from its parts (re + 1j*im would turn an infinite or NaN part into NaN + ...)"""
    re_, im = np.broadcast_arrays(re_, im)
    out = np.zeros(re_.shape, dtype=np.complex128)
    out.real = re_
    out.imag = im
    return out


def _div(A, B):
    if A.dtype.kind == "c" and B.dtype.kind != "c":
        # (a complex divided by a real: each part on its own, a zero part stays zero)
        with np.errstate(divide="ignore", invalid="ignore"):
            re_ = np.where(A.real == 0, 0.0, A.real / B)
            im = np.where(A.imag == 0, 0.0, A.imag / B)
        return _cplx(re_, im)
    with np.errstate(divide="ignore", invalid="ignore"):
        return A / B


def _cpow_int(A, B, r):
    """a complex base to a nonzero integer power below 100 in magnitude, as Octave
    gives it: binary powering from 1 (and 1 / that for a negative power), not numpy's
    power, whose square a a has the imaginary part a b + b a (-0 for -3+0i, where
    Octave has 9+0i); other elements keep r. (An exponent with a zero imaginary part
    counts as real.) Returns the result and the mask of the elements it computed"""
    real = np.ones(np.shape(B), bool)
    if B.dtype.kind == "c":
        real, B = B.imag == 0, B.real
    B = B.astype(np.float64)
    m = real & (B == np.floor(B)) & (np.abs(B) < 100) & (B != 0) & (A != 0)
    if not np.any(m):
        return r, m
    A, B, m, r = np.broadcast_arrays(A, B, m, r)
    n = np.where(m, np.abs(B), 0).astype(np.int64)
    acc, p = np.ones(A.shape, np.complex128), A.astype(np.complex128)
    while np.any(n):
        acc = np.where(n & 1, acc * p, acc)
        p = p * p
        n = n >> 1
    if np.any(m & (B < 0)):
        # 1 / acc by Smith's algorithm dividing by the denominator (numpy's divide
        # multiplies by its reciprocal, which rounds differently)
        c, d = acc.real, acc.imag
        big = np.abs(c) >= np.abs(d)
        q = np.where(big, d / c, c / d)
        den = np.where(big, c + d * q, c * q + d)
        re = np.where(big, (1.0 + 0.0 * q) / den, (1.0 * q + 0.0) / den)
        im = np.where(big, (0.0 - 1.0 * q) / den, (0.0 * q - 1.0) / den)
        zero = (c == 0) & (d == 0)
        re, im = np.where(zero, np.inf, re), np.where(zero, np.nan, im)
        inv = np.empty(acc.shape, np.complex128)
        inv.real, inv.imag = re, im  # (re + 1j * im would lose a -0 imaginary part)
        acc = np.where(B < 0, inv, acc)
    return np.where(m, acc, r), m


def _pow(A, B):
    if A.dtype.kind != "c" and B.dtype.kind != "c":
        # a negative base to a fractional power is complex
        if np.any((A < 0) & (B != np.floor(B))):
            A = A.astype(np.complex128)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        r = A ** B
        if A.dtype.kind == "c" or B.dtype.kind == "c":
            r, ints = _cpow_int(A, B, r)
            if np.any((A == 0) | ~np.isfinite(r) | (np.abs(r) >= 2.0 ** 1000)):
                # (a zero base to a power MATLAB leaves undefined, or a result past the
                # floating-point range: _matlab_cpow refuses or recomputes those elements)
                import _matlab_cpow
                _matlab_cpow.zero_base(A, B, True)
                r = _matlab_cpow.rescue(A, B, r, ints)
    # (1.^NaN and NaN.^0 are NaN in MATLAB, as power's IEEE table says, not IEEE's 1)
    odd = ((A == 1) & np.isnan(B)) | (np.isnan(A) & (B == 0))
    if np.any(odd):
        r = np.where(odd, np.nan, r)
    return r


def _scalar_div(a, b):
    if b == 0.0:
        if a != a or a == 0.0:
            return _math.nan
        return _math.copysign(_math.inf, a) * (_math.copysign(1.0, b))
    return a / b


def plus(a, b):
    if type(a) is float and type(b) is float:
        return a + b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("plus", a, b)
    if type(a) is Str or type(b) is Str or type(a) is StrArr or type(b) is StrArr:
        return _str_plus(a, b)
    return _elementwise(a, b, _add, "plus")


def minus(a, b):
    if type(a) is float and type(b) is float:
        return a - b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("minus", a, b)
    return _elementwise(a, b, _sub, "minus")


def times(a, b):
    if type(a) is float and type(b) is float:
        return a * b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("times", a, b)
    return _elementwise(a, b, _mul, "times")


def rdivide(a, b):
    if type(a) is float and type(b) is float:
        return _scalar_div(a, b)
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("rdivide", a, b)
    return _elementwise(a, b, _div, "rdivide")


def ldivide(a, b):
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("ldivide", a, b)
    return rdivide(b, a)


def power(a, b):
    if type(a) is float and type(b) is float:
        if (a == 1 and b != b) or (a != a and b == 0):
            return _math.nan
        try:
            r = a ** b
        except ZeroDivisionError:
            return _math.inf
        except OverflowError:
            return _math.inf if a > 0 or b == _math.floor(b) and b % 2 == 0 else -_math.inf
        if type(r) is complex:
            return r if r.imag != 0 else r.real
        return r
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("power", a, b)
    return _elementwise(a, b, _pow, "power")


def _matprod_finite(*vals):
    """refuse a matrix product (not a scalar's) of values that include Inf or NaN: where Inf and
    NaN appear in such a product depends on how it is computed (the order of its terms, and which
    zero terms are skipped), which MathWorks documents as varying between implementations, and
    for complex values numpy's differs from Octave's. Every matrix product calls this: dense,
    sparse or mixed, and mpower's. A product without terms (an empty result, or an inner
    dimension of 0) computes nothing, so it is not refused"""
    if len(vals) == 2:
        (m, k), (k2, n) = _dims(vals[0])[:2], _dims(vals[1])[:2]
        if m == 0 or k == 0 or n == 0:
            return
    for v in vals:
        x = v.pr if type(v) is Sparse else _farr(v, "mtimes")
        if not np.all(np.isfinite(x)):
            raise _err("Matrix multiplication of values that include Inf or NaN is not supported in Sagebrush: "
                       "where Inf and NaN appear in the result depends on how the product is computed. "
                       "Multiply finite values, or write the sums out with .* and sum.")


def mtimes(a, b):
    if type(a) is float and type(b) is float:
        return a * b
    if type(a) is Sparse or type(b) is Sparse:
        if not (_isscalar(a) or _isscalar(b)):
            _matprod_finite(a, b)
        return _sp.binop("mtimes", a, b)
    if _isscalar(a) or _isscalar(b):
        return _elementwise(a, b, _mul, "mtimes")
    cls = _arith_class(a, b, "mtimes")
    A = _farr(a, "mtimes")
    B = _farr(b, "mtimes")
    if A.ndim > 2 or B.ndim > 2:
        raise _err("Arguments must be 2-D, or at least one argument must be scalar. Use TIMES (.*) for elementwise multiplication.")
    if A.shape[0] != B.shape[1]:
        raise _err("Incorrect dimensions for matrix multiplication. Check that the number of columns in the first matrix matches the number of rows in the second matrix. To operate on each element of the matrix individually, use TIMES (.*) for elementwise multiplication.", "MATLAB:innerdim")
    _matprod_finite(A, B)
    # (stored transposed: (A B)^T = B^T A^T)
    return _finish(np.matmul(B, A), cls)


def _lu_factors(A):
    """(L, U) with P A = L U by Gaussian elimination with partial pivoting (the
    first largest pivot in each column), or None if a pivot is zero"""
    n = A.shape[0]
    U = np.array(A, dtype=np.complex128 if A.dtype.kind == "c" else np.float64)
    L = np.eye(n, dtype=U.dtype)
    for k in range(n):
        p = int(np.argmax(np.abs(U[k:, k]))) + k
        if U[p, k] == 0:
            return None
        if p != k:
            U[[k, p], :] = U[[p, k], :]
            L[[k, p], :k] = L[[p, k], :k]
        if k + 1 < n:
            l = U[k + 1:, k] / U[k, k]
            L[k + 1:, k] = l
            U[k + 1:, k:] -= l.reshape((-1, 1)) * U[k, k:].reshape((1, -1))
            U[k + 1:, k] = 0
    return L, U


def _tri_solve(T, b, lower, transpose=False):
    """T x = b (or T' x = b, conjugated) for triangular T"""
    n = T.shape[0]
    M = np.conj(T.T) if transpose else T
    low = lower != transpose
    x = np.array(b, dtype=np.result_type(M.dtype, b.dtype))
    order = range(n) if low else range(n - 1, -1, -1)
    for i in order:
        if low:
            s_ = x[i] - np.dot(M[i, :i], x[:i])
        else:
            s_ = x[i] - np.dot(M[i, i + 1:], x[i + 1:])
        x[i] = s_ / M[i, i]
    return x


def _rcond_estimate(A):
    """the 1-norm reciprocal condition number, estimated as rcond and the
    "close to singular" warning document it: 1/(||A||_1 est), est Higham's
    estimate of ||A^-1||_1 (N. J. Higham, "FORTRAN codes for estimating the
    one-norm of a real or complex matrix", ACM TOMS 14, 1988, Algorithm 674;
    as LAPACK's dgecon uses it), from the LU factors: ||A^-1||_1 is the
    1-norm of U^-1 L^-1, the row permutation aside; 0 if A is singular"""
    n = A.shape[0]
    anorm = float(np.max(np.sum(np.abs(A), axis=0)))
    if anorm == 0:
        return 0.0
    f = _lu_factors(A)
    if f is None:
        return 0.0
    L, U = f
    cplx = U.dtype.kind == "c"

    def B(x):
        return _tri_solve(U, _tri_solve(L, x, True), False)

    def Bt(x):
        return _tri_solve(L, _tri_solve(U, x, False, True), True, True)

    def sgn(x):
        if cplx:
            a = np.abs(x)
            return np.where(a == 0, 1.0, x / np.where(a == 0, 1.0, a))
        return np.where(x >= 0, 1.0, -1.0)
    with np.errstate(all="ignore"):
        x = B(np.full(n, 1.0 / n, dtype=U.dtype))
        est = float(np.sum(np.abs(x)))
        if n > 1 and np.isfinite(est):
            xi = sgn(x)
            x = Bt(xi)
            j = int(np.argmax(np.abs(x)))
            it = 2
            while True:
                e = np.zeros(n, dtype=U.dtype)
                e[j] = 1.0
                x = B(e)
                old = est
                est = float(np.sum(np.abs(x)))
                new = sgn(x)
                if (not cplx and np.all(new == xi)) or est <= old:
                    break
                xi = new
                x = Bt(xi)
                last = j
                j = int(np.argmax(np.abs(x)))
                if np.real(x[last]) == np.abs(x[j]) or it >= 5:
                    break
                it += 1
            # (Higham's extra estimate from the alternating vector 1, -(1 + 1/(n-1)), ...)
            alt = np.array([(-1.0) ** i * (1.0 + i / (n - 1)) for i in range(n)], dtype=U.dtype)
            t = 2.0 * float(np.sum(np.abs(B(alt)))) / (3.0 * n)
            est = max(est, t)
    if not np.isfinite(est) or est == 0:
        return 0.0
    return (1.0 / est) / anorm


def _rcond_warning(A, Ainv=None):
    """the warning when A is close to singular: the estimated rcond
    (_rcond_estimate) between 0 and eps, the threshold MATLAB's mldivide
    documentation states ("When rcond is between 0 and eps, MATLAB issues a
    nearly singular warning").  (Only for matrices of up to 500 rows.)"""
    n = A.shape[0]
    if n == 0 or n > 500:
        return
    rc = _rcond_estimate(A)
    if 0 < rc < 2.220446049250313e-16:
        warning_("Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND =  %e." % rc, "MATLAB:nearlySingularMatrix")


def _lu_solve_through(A, B, report=False):
    """A \\ B by elimination with partial pivoting that, as LAPACK's does,
    goes on past a zero pivot: the back substitution then divides by it, so
    the result has the Inf and NaN that MATLAB's has"""
    n = A.shape[0]
    cplx = A.dtype.kind == "c" or B.dtype.kind == "c"
    U = np.array(A, dtype=np.complex128 if cplx else np.float64)
    X = np.array(B, dtype=np.complex128 if cplx else np.float64)
    singular = False
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        for k in range(n):
            p = int(np.argmax(np.abs(U[k:, k]))) + k
            if p != k:
                U[[k, p]] = U[[p, k]]
                X[[k, p]] = X[[p, k]]
            if U[k, k] == 0:
                singular = True
            elif k + 1 < n:
                l = U[k + 1:, k] / U[k, k]
                U[k + 1:, k:] -= l.reshape((-1, 1)) * U[k, k:].reshape((1, -1))
                X[k + 1:] -= l.reshape((-1, 1)) * X[k].reshape((1, -1))
        for k in range(n - 1, -1, -1):
            if k + 1 < n:
                X[k] -= (U[k, k + 1:].reshape((-1, 1)) * X[k + 1:]).sum(axis=0)
            X[k] = X[k] / U[k, k]
    return (X, singular) if report else X


def _solve(A, B):
    """A \\ B for MATLAB-oriented numpy matrices: square ones by LU with
    MATLAB's warnings (its results when singular), others by least squares"""
    m, n = A.shape
    if B.shape[0] != m:
        raise _err("Matrix dimensions must agree.", "MATLAB:dimagree")
    if m == n and n > 1 and not np.any(A - np.diag(np.diag(A))):
        # (a diagonal A: each row divided by its diagonal element, singular or not, as mldivide's
        # page shows: [1 0; 0 0] \ [1; 1] is [1; Inf], where elimination would give NaN for 1)
        d = np.diag(A).reshape((-1, 1))
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            X = B / d
        if np.any(d == 0):
            warning_("Matrix is singular to working precision.", "MATLAB:singularMatrix")
        else:
            _rcond_warning(A)
        return X
    if m == n:
        if A.dtype.kind == "c" or B.dtype.kind == "c":
            # (numpy.linalg here is real only: this LU takes complex matrices)
            X, singular = _lu_solve_through(A, B, True)
            if singular:
                warning_("Matrix is singular to working precision.", "MATLAB:singularMatrix")
            elif A.dtype.kind == "c":
                if n <= 500:
                    _rcond_warning(A, _lu_solve_through(A, np.eye(n)))
            else:
                _rcond_warning(A)
            return X
        try:
            X = np.linalg.solve(A, B)
        except np.linalg.LinAlgError:
            warning_("Matrix is singular to working precision.", "MATLAB:singularMatrix")
            return _lu_solve_through(A, B)
        _rcond_warning(A)
        return X
    return _qr_solve(A, B)


# LAPACK's safe minimum over eps (dlamch('S') / dlamch('E')), and its reciprocal
_SAFMIN = 2.2250738585072014e-308 / 1.1102230246251565e-16
_RSAFMIN = 1.0 / _SAFMIN


def _col_norms(M):
    """the 2-norm of each column, scaled by its largest magnitude (as LAPACK's
    dnrm2), so neither overflowing near 1e154 nor underflowing near 1e-154"""
    a = np.abs(M)
    if not a.shape[0]:
        return np.zeros(a.shape[1])
    s = np.max(a, axis=0)
    t = np.where(s > 0, s, 1.0)
    return s * np.sqrt(np.sum((a / t.reshape((1, -1))) ** 2, axis=0))


def _qr_solve(A, B):
    """A \\ B for a rectangular A: Householder QR with column pivoting
    (Golub and Van Loan, "Matrix Computations", 5.4.1; the reflectors with
    LAPACK's dlarfg conventions), and the basic solution, the free variables
    0.  The rank is the number of |R(k,k)| above max(m,n) eps |R(1,1)|.
    This formula and the basic solution were in the original
    implementation; they are not documented, but three published examples'
    "Rank deficient" warnings print exactly this tolerance (ones(3) by QR,
    [1 2]/[1 0; 2 0; 1 0], and magic(8)'s first six columns), and the
    latter two's published solutions are the basic ones Sagebrush gives"""
    m, n = A.shape
    cplx = A.dtype.kind == "c" or B.dtype.kind == "c"
    dt = np.complex128 if cplx else np.float64
    if A.size and not np.all(np.isfinite(A)):
        # (NaN or Inf in A: no meaningful factorization, so NaN, never a
        # plausible zero)
        return np.full((n, B.shape[1]), _math.nan, dtype=dt)
    R = np.array(A, dtype=dt)
    Y = np.array(B, dtype=dt)
    perm = np.arange(n)
    k = min(m, n)
    norms = _col_norms(R)
    for j in range(k):
        # (the remaining column of largest norm first; norms within 1e-12 relative of the
        # largest count as tied, and the first is taken, as LAPACK's idamax takes the first
        # maximum: columns of equal norm in exact arithmetic, such as magic(8)'s fifth and
        # sixth after two steps, must not be told apart by rounding in hypot)
        if j < n - 1:
            mx = float(np.max(norms[j:]))
            q = j + int(np.argmax(norms[j:] >= mx * (1 - 1e-12)))
            if q != j:
                R[:, [j, q]] = R[:, [q, j]]
                perm[[j, q]] = perm[[q, j]]
                norms[[j, q]] = norms[[q, j]]
        x = R[j:, j].copy()
        alpha = x[0]
        xnorm = float(_col_norms(x[1:].reshape((-1, 1)))[0]) if x.size > 1 else 0.0
        if xnorm == 0 and (not cplx or alpha.imag == 0):
            continue
        beta = -_math.copysign(_math.hypot(abs(alpha), xnorm), alpha.real)
        knt = 0
        while abs(beta) < _SAFMIN and knt < 20:
            # (dlarfg: a tiny column rescaled, so v and tau keep their precision)
            knt += 1
            x = x * _RSAFMIN
            alpha = x[0]
            beta = beta * _RSAFMIN
        if knt:
            xnorm = float(_col_norms(x[1:].reshape((-1, 1)))[0]) if x.size > 1 else 0.0
            beta = -_math.copysign(_math.hypot(abs(alpha), xnorm), alpha.real)
        tau = (beta - alpha) / beta
        v = x / (alpha - beta)
        v[0] = 1.0
        beta = beta * _SAFMIN ** knt
        # (apply I - tau v v^H to R's remaining columns and to the right side)
        R[j:, j:] -= np.conj(tau) * np.outer(v, np.conj(v) @ R[j:, j:]) if cplx else tau * np.outer(v, v @ R[j:, j:])
        Y[j:] -= np.conj(tau) * np.outer(v, np.conj(v) @ Y[j:]) if cplx else tau * np.outer(v, v @ Y[j:])
        R[j, j] = beta
        R[j + 1:, j] = 0
        if j + 1 < n:
            norms[j + 1:] = _col_norms(R[j + 1:, j + 1:])
    d = np.abs(np.diag(R[:k, :k])) if k else np.zeros(0)
    tol = max(m, n) * 2.220446049250313e-16 * (float(d[0]) if d.size else 0.0)
    r = int(np.sum(d > tol))
    if r < min(m, n):
        # (two spaces before tol's value, as the published examples show: tol =  1.332268e-15)
        warning_("Rank deficient, rank = %d, tol =  %e." % (r, tol))
    Z = np.zeros((n, Y.shape[1]), dtype=dt)
    for i in range(r - 1, -1, -1):
        s_ = Y[i] - (R[i, i + 1:r].reshape((-1, 1)) * Z[i + 1:r]).sum(axis=0) if i + 1 < r else Y[i]
        Z[i] = s_ / R[i, i]
    X = np.zeros((n, Y.shape[1]), dtype=dt)
    X[perm] = Z
    return X


_NONFINITE_SOLVE = ("%s of values that include Inf or NaN is not supported in Sagebrush: "
                    "its result for them is not certified. Solve with finite values.")


def _solve_finite(name, *vals, rows=1, cols=1):
    """refuse a linear solve or inverse (a non-scalar coefficient matrix) of values that include Inf
    or NaN: no implementation's answer for them is certified, as for matrix products. A solve whose
    result (rows by cols) is empty computes nothing, so it is not refused"""
    if rows == 0 or cols == 0:
        return
    for v in vals:
        x = v.pr if type(v) is Sparse else _farr(v, name)
        if not np.all(np.isfinite(x)):
            raise _err(_NONFINITE_SOLVE % name)


def mldivide(a, b):
    if type(a) is float and type(b) is float:
        return _scalar_div(b, a)
    if not _isscalar(a):
        _solve_finite("A linear solve (\\)", a, b, rows=_dims(a)[1], cols=_dims(b)[1])
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("mldivide", a, b)
    if _isscalar(a):
        return _elementwise(b, a, _div, "mldivide")
    cls = _arith_class(a, b, "mldivide")
    return _finish(_farr(_unmat(_solve(_mat(a), _mat(b)))), cls)


def mrdivide(a, b):
    if type(a) is float and type(b) is float:
        return _scalar_div(a, b)
    if not _isscalar(b):
        _solve_finite("A linear solve (/)", a, b, rows=_dims(a)[0], cols=_dims(b)[0])
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("mrdivide", a, b)
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
    if type(b) is Sparse and _isscalar(b) and not _isscalar(a):
        # (a sparse scalar exponent is its value: A^sparse(2) is A^2, with A^2's checks)
        b = _sp.full(b)
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("mpower", a, b)
    if _isscalar(a) and _isscalar(b):
        return power(a, b)
    if not _isscalar(b):
        raise _err("Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.")
    cls = _arith_class(a, b, "mpower")
    A = _mat(a)
    if A.shape[0] != A.shape[1]:
        raise _err("Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.")
    p = _scalar(b)
    if p == 1:
        # (A^1 is A itself, Inf and NaN included: not eye(n) * A)
        return _finish(_farr(_unmat(A)), cls)
    if p == _math.floor(p):
        p = int(p)
        if p < 0:
            # (A^-1 is inv(A), as mpower's page says: inv's result, singular warning included.
            # inv's answer for Inf or NaN parts is not certified, so such powers are refused)
            if not np.all(np.isfinite(A)):
                raise _err("A negative matrix power of values that include Inf or NaN is not supported in Sagebrush: "
                           "it is inv(A), whose result for them is not certified.")
            if A.dtype.kind == "c":
                # (inv refuses a complex matrix here, as numpy.linalg does: an invertible one's
                # inverse is the solve the parent took, a singular one gets inv's answer)
                if _lu_factors(A) is None:
                    warning_("Matrix is singular to working precision.", "MATLAB:singularMatrix")
                    A = np.full(A.shape, np.inf, dtype=A.dtype)
                else:
                    A = _mat(_unmat(_solve(A, np.eye(A.shape[0]))))
            else:
                A = _mat(inv_(_unmat(A)))
            p = -p
        if cls == "single":
            # (a chain of * on singles holds single values, so each product's operands are checked
            # as the singles they would be: an overflow (or an inverse past single's range) is
            # refused as the chain refuses it. The arithmetic itself keeps the values as they are)
            rnd = lambda M: M.astype(np.complex64 if M.dtype.kind == "c" else np.float32)
        else:
            rnd = lambda M: M

        def mul(X, Y):
            _matprod_finite(rnd(X), rnd(Y))
            return X @ Y
        # (by squaring; the first factor is taken as it is, so that A^1 is A and A^-1 is inv(A).
        # Each product is refused for Inf or NaN as mtimes's is, so an Inf in A, in a singular A's
        # inverse or from an overflowing square stops it)
        R = None
        while p:
            if p & 1:
                R = A if R is None else mul(R, A)
            p >>= 1
            if p:
                A = mul(A, A)
        if R is None:
            R = np.eye(A.shape[0], dtype=A.dtype)
        return _finish(_farr(_unmat(R)), cls)
    # (a fractional power is a product of A's eigenvectors, so it is refused as products are)
    _matprod_finite(A)
    w, V = np.linalg._eig(A)
    R = V @ np.diag(w.astype(np.complex128) ** p) @ np.linalg.inv(V)
    return _finish(_farr(_unmat(R)), cls)


def uminus(a):
    t = type(a)
    if t is Sparse:
        return _sp.unop("uminus", a)
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
    if t is Sparse:
        return _sp.unop("uplus", a)
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
    # (MATLAB compares numeric values without losing precision to a conversion, as eq's and lt's
    # pages say: a single is compared as the double it exactly is, so single(0.1) == 0.1 is
    # false. Every other class is exact in double too: Sagebrush refuses int64 and uint64 values
    # of 2^53 or more, so those it holds are)
    A = _farr(a, name)
    B = _farr(b, name)
    if A.dtype.kind == "c" or B.dtype.kind == "c":
        if name not in ("eq", "ne"):
            A = A.real
            B = B.real
    with np.errstate(invalid="ignore"):
        return _box(_broadcast(f, A, B))


def eq(a, b):
    if type(a) is float and type(b) is float:
        return a == b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("eq", a, b)
    return _cmp(a, b, lambda x, y: x == y, "eq")


def ne(a, b):
    if type(a) is float and type(b) is float:
        return a != b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("ne", a, b)
    return _cmp(a, b, lambda x, y: x != y, "ne")


def lt(a, b):
    if type(a) is float and type(b) is float:
        return a < b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("lt", a, b)
    return _cmp(a, b, lambda x, y: x < y, "lt")


def le(a, b):
    if type(a) is float and type(b) is float:
        return a <= b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("le", a, b)
    return _cmp(a, b, lambda x, y: x <= y, "le")


def gt(a, b):
    if type(a) is float and type(b) is float:
        return a > b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("gt", a, b)
    return _cmp(a, b, lambda x, y: x > y, "gt")


def ge(a, b):
    if type(a) is float and type(b) is float:
        return a >= b
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("ge", a, b)
    return _cmp(a, b, lambda x, y: x >= y, "ge")


def _logical_arr(v, name):
    t = type(v)
    if t is np.ndarray and v.dtype.kind == "b":
        return v
    A = _farr(v, name)
    if A.dtype.kind in "fc" and np.any(np.isnan(A)):
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    return A != 0


def and_(a, b):
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("and", a, b)
    if type(a) is bool and type(b) is bool:
        return a and b
    if type(a) is float and type(b) is float:
        return a != 0.0 and b != 0.0
    return _box(_broadcast(lambda x, y: x & y, _logical_arr(a, "and"), _logical_arr(b, "and")))


def or_(a, b):
    if type(a) is Sparse or type(b) is Sparse:
        return _sp.binop("or", a, b)
    if type(a) is bool and type(b) is bool:
        return a or b
    if type(a) is float and type(b) is float:
        return a != 0.0 or b != 0.0
    return _box(_broadcast(lambda x, y: x | y, _logical_arr(a, "or"), _logical_arr(b, "or")))


def not_(a):
    t = type(a)
    if t is Sparse:
        return _sp.unop("not", a)
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


def _flag_arg(v, opt):
    """an option's true or false: a real numeric or logical scalar"""
    if _istext(v) or not _isnumlike(v) or _numel(v) != 1 or _arr(v).dtype.kind == "c" or _scalar(v) != _scalar(v):
        raise _err("The value of '%s' must be a logical scalar (true or false)." % opt)
    return bool(_scalar(v))


def _isinstance_num(p):
    """a real numeric or logical scalar"""
    return type(p) is not complex and _isnumlike(p) and not _istext(p) and _numel(p) == 1 and _arr(p).dtype.kind != "c"


def _need_float(x, name):
    """refuse an input whose page lists only single and double"""
    if class_(x) not in ("double", "single"):
        raise _err("%s: the input must be of class double or single, not %s." % (name, class_(x)))


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
    if t is Sparse:
        return _sp.truth(v)
    if _numel(v) == 0:
        return False
    A = _arr(v)
    if A.dtype.kind in "fc" and np.any(np.isnan(A)):
        # (a NaN in either part of a complex value)
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    if A.dtype.kind == "c":
        A = A.real
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
    if t is Sparse:
        return _sp.transpose(a)
    raise _optype("transpose", a)


def ctranspose(a):
    t = type(a)
    if t is float or t is bool:
        return a
    if t is complex:
        return a.conjugate()
    if t is np.ndarray and a.dtype.kind == "c":
        return _box(np.conj(transpose(a)))
    if t is Sparse:
        return _sp.transpose(a, conj=True)
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
    """a:d:b.  This is the original implementation, unchanged, and its
    details were not taken from a published source.  One part is consistent
    with MATLAB's observed output: the second half of the elements is
    counted back from the end point ((0:0.1:0.5)(4) is exactly 0.3 in
    MATLAB, where 0 + 3*0.1 is 0.30000000000000004).  The count's tolerance
    (2 eps max(|a|, |b|)), snapping the last element to b within it, and the
    exact middle element (a + last)/2 are not sourced and need not be
    MATLAB's"""
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
    if not ischar and (type(start) is Char or type(stop) is Char):
        # (colon's page lists char operands but not the class of a mixed range)
        raise _err("A colon range with one char end point and one numeric one is not supported in Sagebrush; convert with double().")
    vals = _colon_values(_scalar(start), _scalar(step), _scalar(stop))
    arr = np.array(vals, dtype=np.float64).reshape((len(vals), 1))
    if ischar:
        return Char(arr)
    if cls != "double":
        return _finish(arr, cls)
    return _box(arr) if len(vals) == 1 else arr


def frange(a, b):
    """the values of a:b for a for loop (without making the array)"""
    if (type(a) is Char) != (type(b) is Char):
        raise _err("A colon range with one char end point and one numeric one is not supported in Sagebrush; convert with double().")
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
    if t is Sparse:
        yield from _sp.columns(v)
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


class Sparse:
    """A sparse matrix (double or logical): lib/_matlab_sparse.py.  m-by-n,
    compressed sparse column (jc, ir, pr), as MATLAB stores it; immutable."""
    __slots__ = ("m", "n", "jc", "ir", "pr", "cap")  # (cap: the capacity spalloc reserved, for nzmax)

    def __repr__(self):
        return "<%dx%d sparse, %d nonzeros>" % (self.m, self.n, self.pr.size)


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
    if t is HandleArr:
        return HandleArr(list(v.a), v.shape)
    if t is dict:
        # (a struct array's element)
        return {k: cp(x) for k, x in v.items()}
    if isinstance(v, Undef):
        raise _undefined(v.name)
    return v

# ------------------------------------------------------------------ functions and handles


def _arity(f, skip):
    """(fewest, most) positional arguments of the Python function f, less skip leading ones
    (nargout); most is None with *args"""
    try:
        c = f.__code__
    except AttributeError:
        return 0, None
    n = c.co_argcount - skip
    nd = len(f.__defaults__ or ())
    return max(0, n - nd), (None if c.co_flags & 4 else max(0, n))


class Builtin:
    """A built-in function: f(nargout, *args)."""
    __slots__ = ("f", "name", "lo", "hi")

    def __init__(self, f, name, arity=None):
        self.f = f
        self.name = name
        # (how many inputs its Python function takes: more is a form Sagebrush does not implement,
        # an explicit refusal rather than Python's TypeError; fewer is MATLAB's own error)
        self.lo, self.hi = arity if arity is not None else _arity(f, 1)

    def call(self, nargout, args):
        if self.hi is not None and len(args) > self.hi:
            raise _err("%s with %d inputs is not supported in Sagebrush (it takes at most %d here)." % (self.name, len(args), self.hi))
        if len(args) < self.lo:
            raise _err("Not enough input arguments.", "MATLAB:minrhs")
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
        g.__doc__ = f.__doc__  # (its documentation: the search box's, _matlab_docsearch)
        ar = _arity(f, 0)
        for n in names:
            _B[n] = Builtin(g, n, ar)
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
    if t is Sparse:
        return _ivec(_sp.full(arg), n, pos, grow)
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
    return _canon(_contig(pos))


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
    if t is Cell or t is Struct or t is StrArr or t is HandleArr:
        pos, out = _positions(obj.shape, args)
        items = [cp(obj.a[int(k)]) for k in pos.reshape(-1)]
        return obj._like(items, out)
    if t is Sparse:
        return _sp.index(obj, args)
    if isinstance(obj, HandleObj):
        pos, out = _positions((1, 1), args)
        return obj if pos.size == 1 else HandleArr([obj] * pos.size, out)
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


def end_chain(obj, k, n, *outer):
    """`end` in an index that may be a function call, x(min(end, 5)): the innermost index
    whose base is not a function, from outer's (base, k, n) triples, the base made on
    demand; MATLAB's error when every one is a call"""
    while _iscallable(obj):
        if not outer:
            raise _err("'end' cannot be used with a function call.")
        obj, k, n = outer[0](), outer[1], outer[2]
        outer = outer[3:]
    return end(obj, k, n)


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
    if type(obj) is Builtin or type(obj) is Function:
        return [field(obj, name)]
    if isinstance(obj, HandleObj):
        return [obj.mget(name)]
    if type(obj) is HandleArr:
        return [o.mget(name) for o in obj.a]
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
    if type(obj) is Builtin or type(obj) is Function:
        if obj.name in _CLASSES:
            return _class_static(obj.name, name)
        obj = val(obj)
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


# the most values a comma-separated list on the left of an assignment ([S(i,j).f] = ..., [C{i,j}] = ...)
# takes: repeated subscripts multiply (S(I,I) with n-element I selects n^2 elements, even of a
# scalar S), so the count is admitted before the positions or the right side's outputs are made
_CS_MAX = 100000


def _cs_cardinality(dims, args):
    """how many elements v(args) selects, from the subscripts alone (no positions are built):
    their product, as _positions forms it"""
    n = len(args)
    if n == 0:
        return _prod(dims)
    if n == 1:
        return int(_ivec(args[0], _prod(dims), -1, False)[0].size)
    d = list(dims)
    if len(d) < n:
        d = d + [1] * (n - len(d))
    elif len(d) > n:
        d = d[:n - 1] + [_prod(d[n - 1:])]
    k = 1
    for j in range(n):
        k *= int(_ivec(args[j], d[j], j, False)[0].size)
    return k


def _cs_admit(k, what):
    if k > _CS_MAX:
        raise _err("%s with %d comma-separated outputs is beyond Sagebrush's limit of %d." % (what, k, _CS_MAX))


def cs_positions(v, subs=None):
    """the linear indices (1-based) of the elements [v.f] = ... or [v(subs).f] = ... sets: all of a
    struct array's, or those subs selects, their count admitted first; None for a value that is not
    a struct array (one output). The assignment reuses them."""
    if type(v) is not Struct:
        return None
    n = _numel(v)
    if subs is None:
        return list(range(1, n + 1))
    _cs_admit(_cs_cardinality(_dims(v), list(subs)), "[S(...).f] = ...")
    lin = _box(np.arange(1, n + 1, dtype=np.float64).reshape(_stored(_dims(v))))
    return [int(x) for x in _farr(index(lin, list(subs))).reshape(-1)]


def cs_count(pos):
    """how many values [v.f] = ... or [v(subs).f] = ... takes, from cs_positions"""
    return max(len(pos), 1) if pos is not None else 1


def cs_brace_positions(c, subs):
    """the linear indices (1-based) of the cells [c{subs}] = ... sets, their count admitted first
    (as cs_positions); None for a value that is not a cell array (one output)"""
    if type(c) is not Cell:
        return None
    try:
        k = _cs_cardinality(_dims(c), list(subs))
    except MatlabError:
        raise _err("[C{...}] = ... beyond the end of C (growing it) is not supported in Sagebrush.")
    _cs_admit(k, "[C{...}] = ...")
    lin = _box(np.arange(1, _numel(c) + 1, dtype=np.float64).reshape(_stored(_dims(c))))
    return [int(x) for x in _farr(index(lin, list(subs))).reshape(-1)]


def set_brace_cs(c, vals, subs, pos=None):
    """[c{subs}] = vals: each selected cell set to the next value (pos: cs_brace_positions)"""
    vals = list(vals)
    if type(c) is not Cell or pos is None:
        return assign(c, [("b", list(subs))], cp(vals[0]))
    for k, v in zip(pos, vals):
        c = assign(c, [("b", [float(k)])], cp(v))
    return c


def set_field_cs(s, f, vals, subs=None, pos=None):
    """[s.f] = vals or [s(subs).f] = vals: each selected element's field f set to the next value
    (pos: cs_positions of s and subs)"""
    vals = list(vals)
    if type(s) is not Struct or pos is None or (subs is None and _numel(s) <= 1):
        return assign(s, [("p", list(subs)), ("f", f)] if subs is not None else [("f", f)], cp(vals[0]))
    for k, v in zip(pos, vals):
        s = assign(s, [("p", [float(k)]), ("f", f)], cp(v))
    return s


def assign(base, path, v):
    """base with the value at path set to v (path: ("f", name), ("p", args), ("b", args))"""
    if isinstance(base, Undef):
        base = None
    return _asg(base, path, 0, v)


def _asg(cur, path, i, v):
    kind, arg = path[i]
    last = i == len(path) - 1
    if kind == "f" and isinstance(cur, HandleObj):
        # (a handle: its property is set, every variable holding it sees the change)
        if last:
            cur.mset(arg, v)
        else:
            inner = cur.mget(arg)
            nv = _asg(inner, path, i + 1, v)
            if nv is not inner:
                cur.mset(arg, nv)
        return cur
    if kind == "f" and type(cur) is HandleArr:
        if not last:
            raise _err("Dot indexing into an array of handles is not supported: index one first.")
        for o in cur.a:
            o.mset(arg, v)
        return cur
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
            if 0 < k <= cur.size and cur.ndim == 2:
                cur[(k - 1) // cur.shape[1], (k - 1) % cur.shape[1]] = v
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
    if t is HandleArr:
        raise _err("Unable to grow an array of graphics objects with gaps: assign every element in order.")
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
    if type(cur) is Sparse and not brace:
        if tv is np.ndarray and v.size == 0 and v.shape == (0, 0) and v.dtype == np.float64:
            return _sp.delete(cur, args)
        return _sp.assign(cur, args, v)
    # deletion: x(i) = []
    if not brace and tv is np.ndarray and v.size == 0 and v.shape == (0, 0) and v.dtype == np.float64 and cur is not None and not _isempty_double(cur) or (not brace and tv is np.ndarray and v.size == 0 and v.shape == (0, 0) and cur is not None and type(cur) is Cell):
        return _delete(cur, args)
    # fast path: a(k) = scalar, within bounds
    if cur is not None and type(cur) is np.ndarray and tv is float and cur.dtype == np.float64 and len(args) <= 2 and type(args[0]) is float:
        if len(args) == 1:
            k = int(args[0])
            if k == args[0] and 1 <= k <= cur.size and cur.ndim == 2:
                cur[(k - 1) // cur.shape[1], (k - 1) % cur.shape[1]] = v
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
    if isinstance(cur, HandleObj):
        cur = HandleArr([cur], (1, 1))
        tc = HandleArr
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
    if tc is HandleArr:
        items = _handles(v)
        for k, p in enumerate(pos):
            cur.a[int(p)] = items[0 if nv == 1 else k]
        return cur._like(cur.a, cur.shape) if len(cur.a) == 1 else cur
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
    if isinstance(v, HandleObj) or t is HandleArr:
        return HandleArr([], (0, 0))
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
    out = _contig(a)
    k = out.dtype.kind
    if va.dtype.kind == "c":
        if np.any(va.imag) and k in "fc":
            if k == "f":
                out = out.astype(np.complex128 if out.dtype.itemsize == 8 else np.complex64)
        else:
            va = _contig(va.real)
    flat_v = va.reshape(-1)
    out = np.array(out)  # (a fresh contiguous array: its reshape(-1) is a view)
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
    if isinstance(v, HandleObj):
        return v._mclass
    if t is HandleArr:
        return v.a[0]._mclass if v.a else "matlab.graphics.Graphics"
    if t is int:
        return "double"
    if t is Sparse:
        return _sp.class_(v)
    if isinstance(v, Undef):
        raise _undefined(v.name)
    return t.__name__

# ------------------------------------------------------------------ concatenation


def hcat(vals, narrow=True):
    """[a, b, ...] (narrow false for a row of a matrix literal, which vcat finishes)"""
    if not vals:
        return np.zeros((0, 0))
    n = len(vals)
    if n == 1:
        v = vals[0]
        if narrow and type(v) is np.ndarray and v.dtype.kind == "c" and not np.any(v.imag):
            # ([complex(1, 0)] is real: a literal of one complex value is made real as any is)
            r = _contig(v.real)
            return _box(r) if r.dtype == np.float64 else _canon(r)
        return cp(v)
    allf = True
    for v in vals:
        if type(v) is not float:
            allf = False
            break
    if allf:
        return np.array(vals).reshape((n, 1))
    return _cat(vals, 2, narrow)


def vcat(rows):
    """[a; b; ...] (each already a row)"""
    if len(rows) == 1:
        return cp(rows[0])
    return _cat(rows, 1)


def _cat_class(vals):
    """the class of a concatenation"""
    if any(isinstance(v, HandleObj) or type(v) is HandleArr for v in vals):
        return "handle"
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


def _cat(vals, dim, narrow=True):
    """concatenation along MATLAB dimension dim (1 or more); a complex result with no nonzero
    imaginary part is made real unless narrow is false"""
    for v in vals:
        if type(v) is Sparse:
            r = _sp.cat(vals, dim)
            if r is not None:
                return r
            break
    cls = _cat_class(vals)
    # empty values do not take part (but count for the class)
    parts = [v for v in vals if _numel(v) != 0]
    if not parts:
        v = vals[0]
        if cls == "char":
            return Char("") if type(v) is not Char else v
        return v if cls != "cell" else Cell([], (0, 0))
    if cls == "handle":
        items = [v if type(v) is HandleArr else HandleArr([v], (1, 1)) for v in parts]
        r = _cat_containers(items, dim, Cell)
        return HandleArr(r.a, r.shape)
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
    if anyc and not np.any(out.imag):
        if not narrow:
            # (a row of a matrix literal: it stays complex until the whole literal is joined,
            # so that the signs of its zero imaginary parts survive in a complex result)
            return _canon(out)
        if cls == "single":
            # (a finished join with no nonzero imaginary part is real, single as double)
            return _canon(_contig(out.real))
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
_FORMAT_NAMES = {k.lower(): k for k in ("short", "long", "shortG", "longG", "shortE", "longE", "rat", "bank", "hex", "+")}


def _long():
    """whether the format is long (long, longG or longE)"""
    return _format["num"].startswith("long")
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


def _scale_exponent(maxabs):
    """the exponent of a matrix's common scale factor: the largest element
    shows as 1.xxxx (from 1000 up) or 0.xxxx (below 0.001)"""
    l = _math.log10(maxabs)
    return int(_math.floor(l)) if maxabs >= 1 else int(_math.ceil(l))


class _NumFmt:
    """how the elements of a real double array print: format short (4
    decimals, fields 10 wide) or long (15 decimals, 20 wide); integers 6
    wide below 1000, else 12; a common scale factor (1.0e+03 *) for a
    matrix outside [0.001, 1000), e-notation for such a scalar"""

    def __init__(self, A, scalar, long_=False, single=False):
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
        if single and long_:
            # (format long shows a single to 7 decimals)
            self.dec, fixw = 7, 12
        if lo < maxabs < hi or maxabs == 0:
            self.kind = "fix"
            self.width = fixw
            return
        if scalar:
            self.kind = "e"
            self.width = 26 if long_ else 13
            return
        ex = _scale_exponent(maxabs)
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
    ex = _scale_exponent(maxabs)
    sc = 10.0 ** ex

    def f(x):
        if x != x or x in (_math.inf, -_math.inf):
            return _special(x)
        return "%.*f" % (dec, x / sc)
    return f, "1.0e%+03d" % ex


def _matrix_rows(cols_text, width, nrows, ncols):
    """the lines of a matrix whose elements are formatted (cols_text[j][i]),
    split into column groups that fit the window"""
    per = max(1, (_WIDTH - 1) // width) if width and not _doc_layout() else ncols
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
        # (a numeric empty: "1×0 ... row vector", "0×1 ... column vector", other 2-D sizes
        # "matrix", as the documentation's examples show them; logical, char and N-D "array")
        kind = ("array" if cls in ("logical", "char") or len(d) != 2 else "row vector" if d == (1, 0)
                else "column vector" if d == (0, 1) else "matrix")
        return [], ["  %s empty %s %s" % (_dimstr(d), cls, kind)]
    if len(d) > 2:
        pages = _pages(v)
        # (every page in the same format)
        blocks = []
        for suffix, p in pages:
            blocks.append(None)
            blocks.append(suffix)
            blocks.extend(_numeric_blocks(_box(_contig(p)) if p.dtype.kind in "fbc" and p.dtype.itemsize in (1, 8, 16) else p)[1])
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
        if _format["num"] == "hex":
            # (format hex: each integer's bytes, two's complement)
            nb = a.dtype.itemsize
            texts = [["%0*x" % (2 * nb, int(M[i, j]) % (1 << (8 * nb))) for i in range(rows)] for j in range(cols)]
            return head, _matrix_rows(texts, 2 * nb + 3, rows, cols)
        texts = [["%d" % int(M[i, j]) for i in range(rows)] for j in range(cols)]
        # (the widest magnitude, a column for a minus sign if there is one, and 3)
        w = max(len(t.lstrip("-")) for col in texts for t in col) + (1 if any(t.startswith("-") for col in texts for t in col) else 0) + 3
        return head, _matrix_rows(texts, w, rows, cols)
    if cls == "single":
        if scalar:
            head.append("  single")
        else:
            head.append("  %s single %s" % (_dimstr(d), _shape_word(d)))
    long_ = _format["num"] == "long"
    alt = _alt_blocks(M, a, cls, scalar, rows, cols)
    if alt is not None:
        return head, alt
    if a.dtype.kind == "c":
        f, scale = _fmt_complex_parts(M, scalar)
        parts = []
        for j in range(cols):
            col = []
            for i in range(rows):
                z = complex(M[i, j])
                im = z.imag
                sign = "-" if im < 0 else "+"
                re_ = f(z.real + 0.0)  # (-0 prints as 0)
                col.append((re_, sign, f(abs(im)) if im == im else "NaN"))
            parts.append(col)
        wr = max(9 if not long_ else 19, max(len(p[0]) for c in parts for p in c) + 2)
        # (the imaginary part's field: at least a one-digit number and a space)
        wi = max(max(len(p[2]) for c in parts for p in c), len(f(1.0)) + 1)
        texts = [["%s %s%si" % (p[0].rjust(wr), p[1], p[2].rjust(wi)) for p in c] for c in parts]
        w = wr + wi + 3
        body = []
        if scale:
            body.append(("%s *" % scale).rjust(12))
        body.extend(_matrix_rows(texts, w, rows, cols))
        return head, body
    A = M.astype(np.float64)
    nf = _NumFmt(A, scalar, long_, single=cls == "single")
    texts = [[nf.fmt(float(A[i, j])) for i in range(rows)] for j in range(cols)]
    w = nf.width
    longest = max(len(t) for c in texts for t in c)
    if longest + 2 > w:
        w = longest + 3 if nf.kind == "int" else longest + 2
    body = []
    if nf.scale is not None:
        # (right-aligned in 12: "   1.0e+03 *", "  1.0e+100 *")
        body.append(("%s *" % nf.scale_text).rjust(12))
    body.extend(_matrix_rows(texts, w, rows, cols))
    return head, body


def _hex_double(x, single=False):
    """a value's bits in hex (MATLAB's NaN, as its own constant, has the sign bit set)"""
    import struct as _struct
    if x != x:
        return "fff80000"[:8] if single else "fff8000000000000"
    if single:
        return _struct.pack(">f", x).hex()
    return _struct.pack(">d", x).hex()


def _round_away(v):
    """MATLAB's round: half away from zero, as an exact integer"""
    return int(_math.floor(v + 0.5)) if v >= 0 else -int(_math.floor(-v + 0.5))


def _rat1(x, tol=None):
    """MATLAB's rat of one value: the continued fraction of nearest-integer
    steps, until within tol (1e-6 |x|, as format rat uses); (n, d), d >= 0"""
    if x != x:
        return 0, 0
    if x in (_math.inf, -_math.inf):
        return (1 if x > 0 else -1), 0
    if tol is None:
        tol = 1e-6 * abs(x)
    lastn, lastd = 1, 0
    n, d = _round_away(x), 1
    frac = x - n
    for _ in range(64):
        if abs(x - n / d) < tol or frac == 0:
            break
        flip = 1.0 / frac
        step = _round_away(flip)
        frac = flip - step
        n, lastn = n * step + lastn, n
        d, lastd = d * step + lastd, d
    if d < 0:
        n, d = -n, -d
    return n, d


def _alt_blocks(M, a, cls, scalar, rows, cols):
    """the body of a double or single matrix (MATLAB-oriented M) under format
    shortG, longG, shortE, longE, bank or hex; None under short and long (and rat)"""
    mode = _format["num"]
    if mode not in ("shortG", "longG", "shortE", "longE", "bank", "hex", "rat") or cls not in ("double", "single"):
        return None
    single = cls == "single"
    cplx = a.dtype.kind == "c"
    R = M.real.astype(np.float64) if cplx else M.astype(np.float64)
    I = M.imag.astype(np.float64) if cplx else None

    def special(x):
        return _special(x) if (x != x or x in (_math.inf, -_math.inf)) else None
    if mode == "rat":
        # (each element its own approximation: numerator right-aligned in 8, /denominator left in 7)
        def part(x):
            n, d = _rat1(x)
            return str(n), ("" if d == 1 else "/%d" % d)
        if cplx:
            texts = []
            for j in range(cols):
                col = []
                for i in range(rows):
                    rn, rd = part(float(R[i, j]))
                    im = float(I[i, j])
                    inum, iden = part(abs(im))
                    col.append(rn.rjust(8) + rd.ljust(7) + " " + ("-" if im < 0 else "+") + inum.rjust(5) + (iden + "i").ljust(7))
                texts.append(col)
        else:
            texts = [[(lambda p: p[0].rjust(8) + p[1].ljust(7))(part(float(R[i, j]))) for i in range(rows)] for j in range(cols)]
        return _matrix_rows(texts, max(len(t) for c in texts for t in c) if rows and cols else 0, rows, cols)
    if mode == "hex":
        if cplx:
            texts = [["   %s   %si" % (_hex_double(float(R[i, j]), single), _hex_double(float(I[i, j]), single)) for i in range(rows)] for j in range(cols)]
            return _matrix_rows(texts, len(texts[0][0]) if rows and cols else 0, rows, cols)
        texts = [[_hex_double(float(R[i, j]), single) for i in range(rows)] for j in range(cols)]
        return _matrix_rows(texts, (8 if single else 16) + 3, rows, cols)
    if mode == "bank":
        # (two decimals, a complex number's real part alone; 0 itself as 0)
        def b(x):
            return special(x) or ("0" if x == 0 else "%.2f" % x)
        texts = [[b(float(R[i, j])) for i in range(rows)] for j in range(cols)]
        w = max([14] + [len(t) + 1 for c in texts for t in c])
        return _matrix_rows(texts, w, rows, cols)
    F = np.concatenate([R.reshape(-1)] + ([I.reshape(-1)] if cplx else []))
    fin = F[np.isfinite(F)]
    if not cplx and _isint_arr(fin) and (float(np.max(np.abs(fin))) if fin.size else 0.0) < 1e9:
        return None  # (integers: as format short shows them)
    long_ = mode.startswith("long")
    g = mode.endswith("G")
    if single and long_:
        prec, w = 7, 16
    else:
        prec, w = (15 if long_ else (5 if g else 4)), (26 if long_ else 13)
    if single and mode == "shortE":
        w = 12
    spec = "%%.%d%s" % (prec, "g" if g else "e")

    def f(x):
        return special(x) or ("0" if x == 0 else spec % (x + 0.0))
    if cplx:
        wr = w + 1 if long_ else w
        wi = (21 if long_ else 10) if g else 0
        texts = [["%s %s %si" % (f(float(R[i, j])).rjust(wr), "-" if I[i, j] < 0 else "+", f(abs(float(I[i, j]))).rjust(wi))
                  for i in range(rows)] for j in range(cols)]
        width = max(len(t) for c in texts for t in c)
        return _matrix_rows(texts, width, rows, cols)
    texts = [[f(float(R[i, j])) for i in range(rows)] for j in range(cols)]
    width = max([w] + [len(t) + 1 for c in texts for t in c])
    return _matrix_rows(texts, width, rows, cols)


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
    mode = _format["num"]
    if mode in ("bank", "hex", "shortG", "longG", "shortE", "longE") and type(x) is not complex:
        return _alt_scalar(x)
    nf = _NumFmt(np.array([[x]]), True, _format["num"] == "long")
    return nf.fmt(x)


def _alt_scalar(x):
    """a double in format bank, hex, shortG, longG, shortE or longE, without padding"""
    mode = _format["num"]
    if mode == "hex":
        return _hex_double(x)
    if x != x or x in (_math.inf, -_math.inf):
        return _special(x)
    if mode == "bank":
        return "0" if x == 0 else "%.2f" % x
    if x == _math.floor(x) and abs(x) < 1e9:
        return "%d" % x
    prec = 15 if mode.startswith("long") else (5 if mode.endswith("G") else 4)
    return ("%%.%d%s" % (prec, "g" if mode.endswith("G") else "e")) % x


def _g5(x):
    if x != x or x in (_math.inf, -_math.inf):
        return _special(x)
    if x == _math.floor(x) and abs(x) < 1e15:
        return "%d" % x
    return "%.5g" % x


def _newlines_shown(s):
    """text as a struct's field or a string array's element shows it: each
    newline as the sign ↵, as MATLAB's published displays show them (the
    message of lasterror's structure; extract's 2-by-1 string array of
    lines)"""
    return s.replace("\n", "\u21b5")


def _brief(v, in_cell):
    """a value as one item of a struct's or a cell's display"""
    t = type(v)
    d = _dims(v)
    cls = class_(v)
    if t is Char:
        if len(d) == 2 and d[0] == 1:
            return "'%s'" % (v.text() if in_cell else _newlines_shown(v.text()))
        if d == (0, 0):
            return "0×0 char" if in_cell else "''"
        return "%s char" % _dimstr(d) if in_cell else "[%s char]" % _dimstr(d)
    if t is Str:
        if v.s is None:
            # (a missing string: <missing>, unquoted, as a string array shows it)
            return "[<missing>]" if in_cell else "<missing>"
        return '["%s"]' % v.s if in_cell else '"%s"' % _newlines_shown(v.s)
    if t is StrArr:
        # (as a table's or cell's element shows a string array: {5×1 string})
        return "%s string" % _dimstr(d) if in_cell else "[%s string]" % _dimstr(d)
    if t is Cell:
        if (not in_cell and len(d) == 2 and d[0] == 1 and len(v.a) > 1
                and all(type(e) is Char and len(_dims(e)) == 2 and _dims(e)[0] == 1 for e in v.a)):
            # (a struct's field holding a row of character vectors: them, as length's page shows
            # Month: {'Jan'  'Feb'  'Mar'}, when they fit)
            text = "{%s}" % "  ".join("'%s'" % e.text() for e in v.a)
            if _doc_layout() or len(text) <= _WIDTH - 12:
                return text
        if not in_cell and len(v.a) == 1 and _isnumlike(v.a[0]) and _numel(v.a[0]) == 1:
            # (a struct's field holding a 1-by-1 cell of a scalar: its element, b: {[1]})
            return "{%s}" % _brief(v.a[0], True)
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
        if len(d) == 2 and d[0] == 1 and _arr(v).dtype.kind != "c" and not in_cell:
            # (a struct's row vector field: as much of it as fits, each element as a scalar shows
            # in format short, then "… ]", as MATLAB shows them since R2021b (the struct page's
            # version history); the documentation's layout, as wide as the Live Editor, shows all)
            A = _arr(v).reshape(-1)
            if cls == "logical" or cls in _INTS:
                items = ["%d" % int(x) for x in A]
            else:
                items = [_short_scalar(float(x)) for x in A]
            if _doc_layout():
                return "[%s]" % " ".join(items)
            # (the width it may take: about the window's less the field name; MATLAB's exact rule
            # for where it stops is not documented, the documentation's layout is not cut)
            budget = _WIDTH - 12
            out, used = [], 1
            for k, it in enumerate(items):
                if used + len(it) + 1 > budget and k > 0:
                    return "[%s … ]" % " ".join(out)
                out.append(it)
                used += len(it) + 1
            return "[%s]" % " ".join(out)
        # (a cell's row vector: its elements, up to 10 of them, or any number in the documentation's
        # layout, as the Live Editor shows {[0 0 0 1 0 0 0 0 0 1 0 0 0]})
        if len(d) == 2 and d[0] == 1 and (n <= 10 or _doc_layout()) and in_cell and _arr(v).dtype.kind != "c":
            A = _arr(v).reshape(-1)
            if cls == "double" and _format["num"] == "bank":
                return "[%s]" % " ".join(_alt_scalar(float(x)) for x in A)
            if _format["num"] == "hex":
                return "%s %s" % (_dimstr(d), cls)
            if cls == "logical" or cls in _INTS or _isint_arr(A.astype(np.float64)):
                return "[%s]" % " ".join("%d" % int(x) if np.isfinite(x) else _special(float(x)) for x in A)
            if cls == "double":
                # (format short, the row's common format, when it needs no scale factor)
                nf = _NumFmt(A.reshape((1, -1)).astype(np.float64), False, _format["num"] == "long")
                if nf.scale is None:
                    # (an integer element without decimals: [1.5000 2.2500 3])
                    return "[%s]" % " ".join("%d" % x if np.isfinite(x) and x == np.floor(x) else nf.fmt(float(x)) for x in A)
            return "%s %s" % (_dimstr(d), cls)
        return "%s %s" % (_dimstr(d), cls) if in_cell else "[%s %s]" % (_dimstr(d), cls)
    if t is MException:
        return "[1×1 MException]" if not in_cell else "1×1 MException"
    if isinstance(v, HandleObj):
        n = v._mclass.split(".")[-1]
        return "1×1 %s" % n if in_cell else "[1×1 %s]" % n
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
            if t.startswith('["') and t.endswith('"]'):
                # (a string left-aligned in its brackets, as MATLAB shows {["highs"]} over {["lows" ]})
                col.append("{" + t[:-1] + " " * pad + "]}")
            elif t.startswith("["):
                # (numbers right-aligned in their brackets; the rest padded before the brace)
                col.append("{" + "[" + " " * pad + t[1:] + "}")
            else:
                col.append("{" + t + " " * pad + "}")
        lines_cols.append(col)
    per_w = [max(len(s) for s in c) + 4 for c in lines_cols]
    out = []
    j0 = 0
    blocks = []
    while j0 < cols:
        j1 = j0
        tot = 0
        # (in the documentation's layout, as the Live Editor shows it, the columns are not split)
        while j1 < cols and (j1 == j0 or _doc_layout() or tot + per_w[j1] <= _WIDTH - 1):
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
    if t is Sparse:
        h, b = _sp.blocks(v)
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
        texts = [['"%s"' % _newlines_shown(v.a[j * rows + i]) if v.a[j * rows + i] is not None else "<missing>"
                  for i in range(rows)] for j in range(cols)]
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
    if isinstance(v, HandleObj):
        h, b = _handle_blocks(v)
        return h, b, True
    if t is HandleArr:
        # (objects of different classes: a "graphics array", as MATLAB calls it)
        kinds = set(o._mclass for o in v.a)
        name = class_(v).split(".")[-1] if len(kinds) == 1 else "graphics"
        return ["  %s %s array:" % (_dimstr(v.shape), name)], ["\n".join("    %s" % o._mclass.split(".")[-1] for o in v.a)], False
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


# SAGEBRUSH_MATLAB_DISPLAY=doc: the layout of MATLAB's documentation (and
# the Live Editor): `name = 1×3` then the values, no blank lines.  Used by
# matlab-tests/docs.py to compare with the documentation's examples.
_DOC_LAYOUT = []


def _doc_layout():
    if not _DOC_LAYOUT:
        import os
        _DOC_LAYOUT.append(os.environ.get("SAGEBRUSH_MATLAB_DISPLAY", "") == "doc")
    return _DOC_LAYOUT[0]


def _nd_pages(v):
    """an N-D numeric, logical, char, cell or string array's pages: [(index text, 2-D value)]"""
    out = []
    if type(v) is Cell or type(v) is StrArr:
        d = v.shape
        r, c = d[0], d[1]
        for p in range(_prod(d[2:])):
            idx, k = [], p
            for x in d[2:]:
                idx.append(k % x + 1)
                k //= x
            page = v.a[p * r * c:(p + 1) * r * c]
            out.append(("(:,:,%s)" % ",".join(str(i) for i in idx), Cell(page, (r, c)) if type(v) is Cell else _strarr(page, (r, c))))
        return out
    for suffix, p in _pages(v):
        pv = Char(_contig(p)) if type(v) is Char else _box(_contig(p))
        out.append((suffix, pv))
    return out


def _is_nd(v):
    t = type(v)
    if t is Cell or t is StrArr:
        return len(v.shape) > 2 and len(v.a) > 0
    return (t is np.ndarray or t is Char) and _arr(v).ndim > 2 and _numel(v) > 0


def display(name, v):
    if _is_nd(v):
        # A(:,:,1) = ... page by page (logical and integer arrays: their class first)
        cls = class_(v)
        pre = ("  %s %s array" % (_dimstr(_dims(v)), cls)) if cls not in ("double", "char") else None
        if _doc_layout():
            out = ["%s = %s" % (name, pre.strip() if pre else "")]
            for suffix, pv in _nd_pages(v):
                out.append("%s%s =" % (name, suffix))
                out.extend(_blocks(pv)[1])
            _write("\n".join(out) + "\n")
            return
        loose = _format["spacing"] == "loose"
        if pre:
            _write(("\n%s =\n\n%s\n" if loose else "%s =\n%s\n") % (name, pre))
        for suffix, pv in _nd_pages(v):
            body = "\n\n".join(_blocks(pv)[1]) if loose else "\n".join(_blocks(pv)[1])
            _write(("\n%s%s =\n\n%s\n\n" if loose else "%s%s =\n%s\n") % (name, suffix, body))
        return
    head, body, obj = _blocks(v)
    if _doc_layout():
        t = type(v)
        if head:
            h = head[0].strip()
        elif (t is np.ndarray or t is complex) and _numel(v) > 1 and _format["num"] != "rat":
            # (with format rat the documentation's heading has no size: beta's, log2's, rat's pages)
            h = _dimstr(_dims(v)) + (" complex" if _arr(v).dtype.kind == "c" else "")
        else:
            h = ""
        _write("%s = %s\n%s\n" % (name, h, "\n".join(head[1:] + body)))
        return
    blocks = head + body
    if _format["spacing"] == "loose":
        _write("\n%s =%s\n\n%s\n\n" % (name, " " if obj else "", "\n\n".join(blocks)))
    elif type(v) is Struct and len(v.a) == 1 and v.fields:
        # (format compact still separates a struct's header from its fields)
        _write("%s = \n%s\n\n%s\n" % (name, "\n".join(head), "\n".join(body)))
    else:
        _write("%s =%s\n%s\n" % (name, " " if obj else "", "\n".join(blocks)))


def _disp_text(v):
    t = type(v)
    if _is_nd(v):
        loose = _format["spacing"] == "loose"
        return "".join(("%s =\n\n%s\n\n" if loose else "%s =\n%s\n") % (suffix, "\n".join(_blocks(pv)[1])) for suffix, pv in _nd_pages(v))
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
    if t is Sparse and sep == "\n\n":
        return sep.join(body) + "\n\n"
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


# the last warning's message and identifier, for lastwarn
_lastwarn = ["", ""]


# the warnings' states, as warning's page describes them: "all", then the identifiers set since
_warn_all = ["on"]
_warn_ids = {}
# (and the display modes, their defaults as warning's page gives them)
_warn_modes = {"backtrace": "on", "verbose": "off"}


def _warn_enabled(ident):
    return _warn_ids.get(ident, _warn_all[0]) == "on" if ident else _warn_all[0] == "on"


# (the warnings shown at most once per key until re-armed, {identifier: {key}}:
# warning('on', id), warning('on', 'all') and a fresh session re-arm them)
_warn_once = {}


def warning_once(msg, ident, key):
    """warning_(msg, ident), shown once per key: a repeat sets lastwarn only"""
    seen = _warn_once.setdefault(ident, set())
    if key in seen:
        _lastwarn[0], _lastwarn[1] = msg, ident
        return
    if _warn_enabled(ident):
        seen.add(key)
    warning_(msg, ident)


def warning_(msg, ident="", note=False):
    if note:
        # (a note of Sagebrush's own, which MATLAB would not print: on stderr, and not lastwarn's)
        _write_err("Warning: %s\n" % msg)
        return
    # (lastwarn is set even for a disabled warning, as the lastwarn page's example shows)
    _lastwarn[0], _lastwarn[1] = msg, ident
    if not _warn_enabled(ident):
        return
    # (on stderr, as MATLAB's -batch mode writes them; in the documentation's layout
    # in line with the output, as the Command Window and the documentation show them)
    (_write if _doc_layout() else _write_err)("Warning: %s\n" % msg)

# ================================================================== built-in functions


def _take_along(A, idx, axis):
    """numpy's take_along_axis"""
    A2 = np.moveaxis(A, axis, -1)
    I2 = np.moveaxis(idx, axis, -1)
    shp = I2.shape
    # (explicit row counts: with an empty last axis, -1 is ambiguous)
    fa = A2.reshape((int(np.prod(A2.shape[:-1])), A2.shape[-1]))
    fi = I2.reshape((int(np.prod(shp[:-1])), shp[-1]))
    rows = np.arange(fa.shape[0]).reshape((-1, 1))
    out = fa[rows, fi].reshape(shp)
    return _contig(np.moveaxis(out, -1, axis))


def _fmod(A, B):
    """C's fmod (the sign of A), exactly: numpy's mod of the magnitudes"""
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.sign(A) * np.mod(np.abs(A), np.abs(B))

import re as _re


def _real_scalar(v, what="argument"):
    """a real numeric scalar as a Python float: refused, not truncated or
    taken from its first element, when v has another number of elements,
    an imaginary part, or is NaN or infinite (sizes, dimensions, counts)"""
    if not _isnumlike(v) and type(v) is not int:
        raise _err("Expected a numeric %s, not %s." % (what, class_(v)))
    if _numel(v) != 1:
        raise _err("Size inputs must be scalars." if what == "size" else "Expected a scalar %s, not an array of %d elements." % (what, _numel(v)))
    a = _arr(v) if type(v) is not int else np.array([[float(v)]])
    x = a.reshape(-1)[0]
    if a.dtype.kind == "c":
        if x.imag != 0:
            raise _err("Size inputs must be real." if what == "size" else "Expected a real %s, not a complex number." % what)
        x = x.real
    x = float(x)
    if not _math.isfinite(x):
        raise _err("Size inputs must be finite." if what == "size" else "Expected a finite %s." % what)
    return x


def _int_arg(v, what="argument"):
    """an integer argument (a size, dimension, count): a real, finite,
    integer-valued scalar, else an error"""
    x = _real_scalar(v, what)
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
    if cls is None and args and _istext(args[-1]):
        cls = _text(args.pop()).lower()
        if not cls:
            raise _err("Unknown class ''.")
    if any(_istext(a) for a in args):
        raise _err("%s: the size inputs must be numeric." % fname)
    if not args:
        return (1, 1), cls
    if len(args) == 1:
        if _numel(args[0]) == 0:
            # (an empty size vector: a 0-by-0 array)
            return (0, 0), cls
        a = _farr(args[0])
        if a.size == 1:
            n = max(0, _int_arg(args[0], "size"))
            return (n, n), cls
        # (a size vector: a row or column of integers)
        if a.dtype.kind == "c" or sum(1 for k in _dims(args[0]) if k != 1) > 1 or not np.all(np.isfinite(a)) or not np.all(a == np.floor(a)):
            raise _err("Size vector must be a row vector of integers.")
        d = tuple(max(0, int(x)) for x in a.reshape(-1))
        return _canon_dims(d), cls
    d = []
    for v in args:
        if _numel(v) != 1:
            raise _err("Size inputs must be scalars.")
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


def _like_proto(args):
    """the prototype of a trailing 'like', p: its class comes from _dimsarg, and with this its
    complexity, as zeros(..., "like", p) and eps("like", p) clone it (its sparsity: _like_fn)"""
    if len(args) >= 2 and _istext(args[-2]) and _text(args[-2]).lower() == "like":
        return args[-1]
    return None


def _as_like(r, p):
    """r made complex as the prototype p is"""
    if p is None:
        return r
    if _isnumlike(p) and _arr(p).dtype.kind == "c":
        # (complex, even with no imaginary part, as a prototype's complexity is kept: not _box,
        # which makes such results real as arithmetic does)
        A = _arr(r)
        if A.dtype.kind == "f":
            C = A.astype(np.complex64 if A.dtype == np.float32 else np.complex128)
            r = complex(C.reshape(-1)[0]) if C.size == 1 and C.dtype == np.complex128 else _canon(_contig(C))
    # (a sparse prototype is the sparse module's: _like_fn)
    return r


@_bs("zeros")
def zeros_(*args):
    d, cls = _dimsarg(args, "zeros")
    return _as_like(_filled(d, 0, cls), _like_proto(args))


@_bs("ones")
def ones_(*args):
    d, cls = _dimsarg(args, "ones")
    return _as_like(_filled(d, 1, cls), _like_proto(args))


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
    return _as_like(_filled(d, 2.220446049250313e-16 if cls != "single" else 1.1920929e-07, cls), _like_proto(args))


@_bs("i", "j")
def imag_unit():
    return 1j


def _float_limit(name, a, dbl, sgl):
    """realmax, realmin and flintmax: of double, or of the class named or of 'like', p's class
    (with p's complexity and sparsity)"""
    d, cls = _dimsarg(a, name)
    if cls not in (None, "double", "single"):
        raise _err("%s: the class must be 'double' or 'single'." % name)
    return _as_like(_filled(d, sgl if cls == "single" else dbl, cls), _like_proto(a))


@_bs("realmax")
def realmax_(*a):
    return _float_limit("realmax", a, 1.7976931348623157e308, 3.4028234663852886e38)


@_bs("realmin")
def realmin_(*a):
    return _float_limit("realmin", a, 2.2250738585072014e-308, 1.1754943508222875e-38)


@_bs("flintmax")
def flintmax_(*a):
    return _float_limit("flintmax", a, 9007199254740992.0, 16777216.0)


def _int_limit(name, a, k):
    """intmax and intmin: of int32, the integer class named, or of "like", p's class"""
    if len(a) == 2 and _istext(a[0]) and _text(a[0]).lower() == "like":
        c = class_(a[1])
        if c not in _INTS:
            raise _err("%s: the prototype p of \"like\", p must be an integer." % name)
        if _isnumlike(a[1]) and _arr(a[1]).dtype.kind == "c":
            raise _err("%s(\"like\", p) for a complex integer p is not supported in Sagebrush." % name)
    elif len(a) == 1 and _istext(a[0]):
        c = _text(a[0])
    elif not a:
        c = "int32"
    else:
        raise _err("%s: specify the name of an integer class, or \"like\", p." % name)
    if c not in _INTS:
        raise _err("%s: the class must be the name of an integer class, not '%s'." % (name, c))
    v = _INTS[c][k]
    if float(v) != v:
        # (a 64-bit limit Sagebrush's double-backed 64-bit integers can't hold exactly,
        # 2^63 - 1 or 2^64 - 1, is refused rather than rounded: intmax('uint64') showed
        # 18446744073709551616; intmin('int64'), -2^63, is exact)
        form = "%s(\"like\", p)" % name if len(a) == 2 else "%s('%s')" % (name, c)
        raise _err("%s for %s is not supported: Sagebrush's 64-bit integers are not exact at %d." % (form, c, v))
    return np.array([[v]], dtype=_INTS[c][0])


@_bs("intmax")
def intmax_(*a):
    return _int_limit("intmax", a, 2)


@_bs("intmin")
def intmin_(*a):
    return _int_limit("intmin", a, 1)


@_bs("eye")
def eye_(*args):
    if args and not _istext(args[0]) and _numel(args[0]) > 2:
        raise _err("N-dimensional arrays are not supported.")
    d, cls = _dimsarg(args, "eye")
    if len(d) > 2:
        raise _err("N-dimensional arrays are not supported.")
    m = np.eye(d[0], d[1])
    return _as_like(_finish(_contig(m.T), cls or "double"), _like_proto(args))


# MATLAB's default generator: the Mersenne twister seeded with 5489, its
# doubles made of 53 random bits as numpy's legacy generator makes them, so
# rand gives MATLAB's numbers, and so do randi and randperm(n), which are
# made of them.  randn (_randn) is MATLAB's ziggurat on the same stream.
_rng = [np.random.RandomState(5489)]

# The ziggurat (Marsaglia and Tsang's, 256 layers): x[0] is the base strip's
# width v/f(r), x[1] = r = 3.6541528853610088, x[i] the right edge of layer
# i, to 15 significant digits as MATLAB's generator has them; x[256] = 0.
_ZX = np.array([
    3.91075795952492, 3.65415288536101, 3.44927829856143, 3.32024473383983, 3.2245750520478, 3.147889289518,
    3.08352613200214, 3.02783779176959, 2.97860327988184, 2.93436686720889, 2.89412105361341, 2.85713873087322,
    2.82287739682644, 2.79092117400193, 2.76094400527999, 2.73268535904401, 2.70593365612306, 2.68051464328574,
    2.65628303757674, 2.63311639363158, 2.61091051848882, 2.58957598670829, 2.56903545268184, 2.54922155032478,
    2.53007523215985, 2.51154444162669, 2.49358304127105, 2.47614993967052, 2.4592083743347, 2.44272531820036,
    2.42667098493715, 2.41101841390112, 2.39574311978193, 2.38082279517208, 2.36623705671729, 2.35196722737914,
    2.33799614879653, 2.32430801887113, 2.31088825060137, 2.29772334890286, 2.28480080272449, 2.27210899022838,
    2.25963709517379, 2.24737503294739, 2.23531338492992, 2.22344334009251, 2.21175664288416, 2.20024554661128,
    2.18890277162636, 2.17772146774029, 2.16669518035431, 2.15581781987674, 2.14508363404789, 2.13448718284602,
    2.12402331568952, 2.11368715068665, 2.10347405571488, 2.09337963113879, 2.0833996939983, 2.07353026351874,
    2.06376754781173, 2.05410793165065, 2.04454796521753, 2.03508435372962, 2.02571394786385, 2.0164337349062,
    2.00724083056053, 1.99813247135842, 1.98910600761744, 1.98015889690048, 1.97128869793366, 1.96249306494436,
    1.95376974238465, 1.94511656000868, 1.93653142827569, 1.92801233405266, 1.91955733659319, 1.91116456377125,
    1.90283220855043, 1.8945585256707, 1.88634182853678, 1.878180486293, 1.87007292107127, 1.86201760539967,
    1.8540130597602, 1.84605785028518, 1.83815058658281, 1.83028991968276, 1.82247454009388, 1.81470317596628,
    1.80697459135082, 1.79928758454972, 1.79164098655216, 1.78403365954944, 1.77646449552452, 1.76893241491127,
    1.76143636531891, 1.75397532031767, 1.74654827828172, 1.73915426128591, 1.73179231405296, 1.72446150294804,
    1.71716091501782, 1.7098896570713, 1.70264685479992, 1.69543165193456, 1.68824320943719, 1.68108070472517,
    1.67394333092612, 1.66683029616166, 1.65974082285818, 1.65267414708306, 1.64562951790478, 1.63860619677555,
    1.63160345693487, 1.62462058283303, 1.61765686957301, 1.61071162236983, 1.60378415602609, 1.59687379442279,
    1.58997987002419, 1.58310172339603, 1.57623870273591, 1.56939016341512, 1.56255546753104, 1.55573398346918,
    1.54892508547417, 1.542128153229, 1.53534257144151, 1.52856772943771, 1.521803020761, 1.51504784277671,
    1.50830159628131, 1.50156368511546, 1.49483351578049, 1.48811049705745, 1.48139403962819, 1.47468355569786,
    1.46797845861808, 1.46127816251028, 1.45458208188841, 1.44788963128058, 1.44120022484872, 1.43451327600589,
    1.42782819703026, 1.42114439867531, 1.41446128977547, 1.4077782768464, 1.40109476367925, 1.39441015092814,
    1.38772383568998, 1.38103521107586, 1.37434366577317, 1.36764858359748, 1.36094934303328, 1.35424531676263,
    1.34753587118059, 1.3408203658964, 1.33409815321936, 1.32736857762793, 1.32063097522106, 1.31388467315022,
    1.30712898903073, 1.30036323033084, 1.29358669373695, 1.28679866449324, 1.27999841571382, 1.27318520766536,
    1.26635828701823, 1.25951688606371, 1.2526602218949, 1.24578749554863, 1.23889789110569, 1.23199057474614,
    1.22506469375653, 1.21811937548548, 1.2111537262437, 1.20416683014438, 1.19715774787944, 1.19012551542669,
    1.18306914268269, 1.17598761201545, 1.16887987673083, 1.16174485944561, 1.15458145035993, 1.14738850542085,
    1.14016484436815, 1.13290924865253, 1.12562045921553, 1.11829717411934, 1.11093804601357, 1.10354167942464,
    1.09610662785202, 1.08863139065398, 1.0811144097034, 1.07355406579244, 1.06594867476212, 1.05829648333067,
    1.05059566459093, 1.04284431314415, 1.03504043983344, 1.02718196603564, 1.01926671746548, 1.01129241744,
    1.00325667954467, 0.99515699963509, 0.986990747099062, 0.978755155294224, 0.970447311064224, 0.96206414322304,
    0.953602409881086, 0.945058684468165, 0.936429340286575, 0.927710533401999, 0.91889818364959, 0.909987953496718,
    0.900975224461221, 0.891855070732941, 0.882622229585165, 0.87327106808886, 0.863795545553308, 0.854189171008163,
    0.844444954909153, 0.834555354086381, 0.824512208752291, 0.814306670135215, 0.80392911698997, 0.793369058840623,
    0.782615023307232, 0.771654424224568, 0.760473406430107, 0.749056662017815, 0.737387211434295, 0.725446140909999,
    0.713212285190975, 0.700661841106814, 0.687767892795788, 0.674499822837293, 0.660822574244419, 0.646695714894993,
    0.63207223638606, 0.61689699000775, 0.601104617755991, 0.584616766106378, 0.567338257053817, 0.549151702327164,
    0.529909720661557, 0.50942332960209, 0.487443966139235, 0.46363433679088, 0.43751840220787, 0.408389134611989,
    0.375121332878378, 0.335737519214422, 0.286174591792068, 0.215241895984875,
    0.0])
_ZR = np.concatenate([_ZX[1:] / _ZX[:-1], [0.0]])  # (the fast test: |u| < x[i+1]/x[i])
_ZF = np.exp(-0.5 * _ZX * _ZX)


def _randn(n):
    """n standard normals as MATLAB's randn makes them.  Each draw is two 32-bit
    words a, b: the layer i = 255 - (b >> 24), and u = 2w/2^53 - 1 with w the 53
    bits (a >> 3) and the low 24 bits of b.  Mostly u x[i] (|u| < x[i+1]/x[i]);
    otherwise a wedge, accepted when f(x[i]) + U (f(x[i+1]) - f(x[i])) < f(u x[i])
    with U one more uniform (two words, as rand's), else another draw; in the
    base strip, beyond r, the tail of Marsaglia's method.  Every step takes
    whole pairs of words, so the draws are found by pairs, vectorized, and only
    the few slow ones are followed one by one."""
    rs = _rng[0]
    out = np.empty(n)
    k = 0
    while k < n:
        st = rs.get_state()
        m = n - k
        P = m + m // 16 + 8  # (pairs: the draws, and room for the slow ones' extra uniforms)
        w = rs.randint(0, 4294967296, size=2 * P, dtype=np.uint32).astype(np.int64)
        a = w[0::2]
        b = w[1::2]
        lay = 255 - b // 16777216
        u = 2.0 * (((a // 8) * 16777216 + b % 16777216) / 9007199254740992.0) - 1.0
        val = u * _ZX[lay]
        fast = (lay < 255) & (np.abs(u) < _ZR[lay])
        slow = np.nonzero(~fast)[0]
        pos = 0  # the next pair
        si = 0
        done = False
        while k < n:
            while si < len(slow) and slow[si] < pos:
                si += 1
            nxt = int(slow[si]) if si < len(slow) else P
            take = min(nxt - pos, n - k)
            if take > 0:
                out[k:k + take] = val[pos:pos + take]
                k += take
                pos += take
            if k == n or pos >= P:
                break
            # a slow draw at pair pos: it needs further pairs, which must be in the buffer
            i = int(lay[pos])
            uu = float(u[pos])
            q = pos + 1
            if i == 0:
                res = None
                while q + 1 < P:
                    u1 = (int(a[q]) // 32 * 67108864 + int(b[q]) // 64) / 9007199254740992.0
                    u2 = (int(a[q + 1]) // 32 * 67108864 + int(b[q + 1]) // 64) / 9007199254740992.0
                    q += 2
                    x = -_math.log(u1) / 3.6541528853610088
                    y = -_math.log(u2)
                    if y + y >= x * x:
                        res = 3.6541528853610088 + x
                        break
                if res is None:
                    break
                out[k] = res if uu >= 0 else -res
                k += 1
                pos = q
                continue
            if q >= P:
                break
            U2 = (int(a[q]) // 32 * 67108864 + int(b[q]) // 64) / 9007199254740992.0
            x = uu * float(_ZX[i])
            f0 = float(_ZF[i])
            f1 = float(_ZF[i + 1])
            pos = q + 1
            if f0 + U2 * (f1 - f0) < _math.exp(-0.5 * x * x):
                out[k] = x
                k += 1
        # (the stream: back to where it was, then on by the words used)
        rs.set_state(st)
        if pos:
            rs.randint(0, 4294967296, size=2 * pos, dtype=np.uint32)
    return out


def _rand_class(args, fname, classes):
    """the class rand, randn or randi makes, from a class name or 'like' prototype: one of
    classes; a complex or sparse prototype is refused (MATLAB makes complex numbers like a
    complex one, in an order of the stream Sagebrush doesn't reproduce)"""
    if len(args) >= 2 and _istext(args[-2]) and _text(args[-2]).lower() == "like":
        p = args[-1]
        if not isreal_(p):
            raise _err("%s(..., 'like', p) with a complex p is not supported in Sagebrush." % fname)
        if type(p).__name__ == "Sparse":
            raise _err("%s(..., 'like', p) with a sparse p is not supported in Sagebrush." % fname)
    d, cls = _dimsarg(args, fname)
    if cls is not None and cls not in classes:
        raise _err("%s: the class '%s' is not supported; it makes %s values." % (fname, cls, ", ".join(classes)))
    return d, cls


@_bs("rand")
def rand_(*args):
    d, cls = _rand_class(args, "rand", ("double", "single"))
    n = _prod(d)
    v = _rng[0].random_sample(n) if n else np.zeros(0)
    return _finish(np.asarray(v, dtype=np.float64).reshape(_stored(d)), cls or "double")


@_bs("randn")
def randn_(*args):
    d, cls = _rand_class(args, "randn", ("double", "single"))
    n = _prod(d)
    v = _randn(n) if n else np.zeros(0)
    return _finish(np.asarray(v, dtype=np.float64).reshape(_stored(d)), cls or "double")


@_bs("randi")
def randi_(r, *args):
    ra = _farr(r).reshape(-1)
    if ra.size not in (1, 2) or not np.all(np.isfinite(ra)) or not np.all(ra == np.floor(ra)):
        raise _err("randi: the range must be an integer imax, or [imin imax] with integers.")
    lo, hi = (1, int(ra[0])) if ra.size == 1 else (int(ra[0]), int(ra[1]))
    if hi < lo:
        raise _err("randi: the range must have imin <= imax (imax >= 1 for randi(imax)).")
    d, cls = _rand_class(args, "randi", ("double", "single", "int8", "uint8", "int16", "uint16", "int32", "uint32", "logical")) if args else ((1, 1), None)
    # (the range's integers sampled exactly, in double, then converted to the class, which
    # saturates as the page says: past 2^53, or single's 2^24, they aren't exact)
    top = 2.0 ** 24 if cls == "single" else 2.0 ** 53
    if abs(lo) > top or abs(hi) > top:
        raise _err("randi: the range [%d %d] is past the integers %s holds exactly: not supported in Sagebrush." % (lo, hi, "single" if cls == "single" else "a double"))
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
    """linspace(x1, x2, n) as MATLAB documents it: n points from x1 to x2,
    both included, spaced (x2 - x1)/(n - 1), so x1 + k h with the last point
    x2 itself; 100 points by default; for n = 1, x2; for n <= 0 a 1-by-0
    row; a non-integer n rounded down; NaN for n NaN; complex x1 and x2 too"""
    if class_(a) in _INTS or class_(b) in _INTS:
        # (the page's endpoints are single or double: an integer class's result is not guessed)
        raise _err("linspace with integer-class endpoints is not supported in Sagebrush; convert them with double().")
    if _numel(n) != 1 or _istext(n):
        raise _err("linspace: N must be a scalar.")
    nv = _scalar(n)
    if nv != nv:
        return _math.nan
    if _math.isinf(nv):
        raise _err("Maximum variable size allowed by the program is exceeded.")
    n = int(_math.floor(nv))
    A, B = _farr(a).reshape(-1), _farr(b).reshape(-1)
    if A.size != 1 or B.size != 1:
        raise _err("Inputs must be scalars.")
    if not (np.all(np.isfinite(A)) and np.all(np.isfinite(B))):
        # (the page leaves infinite and NaN endpoints open: refused, not guessed)
        raise _err("linspace with an infinite or NaN endpoint is not supported in Sagebrush.")
    cplx = A.dtype.kind == "c" or B.dtype.kind == "c"
    x1 = complex(A[0]) if cplx else float(A[0])
    x2 = complex(B[0]) if cplx else float(B[0])
    cls = "single" if "single" in (class_(a), class_(b)) else "double"
    if n < 1:
        return _finish(np.zeros((0, 1), dtype=np.complex128 if cplx else np.float64), cls)
    if n == 1:
        return _finish(np.array([[x2]]), cls)
    h = (x2 - x1) / (n - 1)
    y = x1 + np.arange(n, dtype=np.float64) * h
    y[-1] = x2
    return _finish(y.reshape((n, 1)), cls)


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
        return Char(_contig(a.real if a.dtype.kind == "c" else a))
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


_REAL_FIX = {}  # (name: real_fix, for _complex_fallback too)


def _apply_real_fix(fix, A, r):
    """fix(A, r) for a real A; for a complex A, at its elements with a zero imaginary part,
    which MATLAB's examples treat as the real numbers (acos([2 -3 1+2i]) starts 0 + 1.3170i)"""
    if A.dtype.kind != "c":
        return fix(A, r)
    return np.where(A.imag == 0, fix(A.real, r), r)


def _unary(name, f, complex_if=None, keep_int=False, real_fix=None):
    """a math function on every element; complex_if(A): where the result is complex;
    real_fix(A, r): the result r adjusted for a real A made complex (MATLAB's own
    convention for real arguments outside the real domain)"""
    if real_fix is not None:
        _REAL_FIX[name] = real_fix
    def g(nargout, x):
        if type(x) is float and (complex_if is None or not complex_if(np.array([x]))[0]):
            with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                return float(f(np.array([x]))[0])
        cls = class_(x)
        if cls in ("cell", "struct", "string", "function_handle"):
            raise _err("Undefined function '%s' for input arguments of type '%s'." % (name, cls), "MATLAB:UndefinedFunction")
        A = _farr(x, name)
        A0 = None
        if complex_if is not None and A.dtype.kind != "c" and A.size and np.any(complex_if(A)):
            A0 = A
            A = A.astype(np.complex128)
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            r = f(A)
            if real_fix is not None:
                r = _apply_real_fix(real_fix, A0 if A0 is not None else A, r)
            if A0 is not None:
                # (a real array made complex for some of its elements: the others, in the real
                # domain (a NaN, or -0 for log2), keep their real result and a zero imaginary
                # part, as each would alone; log2([-0 -1]) gave -0 the imaginary part of -1)
                real = ~np.asarray(complex_if(A0), dtype=bool)
                if np.any(real):
                    r = np.array(r, dtype=np.complex128)
                    r[real] = f(A0[real]).astype(np.complex128)
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


def _sincosd(A):
    """sind and cosd of a real array: the angle reduced exactly in degrees (fmod by 360, then
    to the nearest multiple of 90 and a remainder of at most 45) before it is converted to
    radians, so a quarter turn's multiples are exact zeros and nearby angles keep their
    digits (cotd(180 - eps(180)) is -2.0159e15); -0 results are 0"""
    if A.dtype.kind == "c":
        raise _err("Complex arguments to sind, cosd and the other degree functions are not supported in Sagebrush.")
    r = np.array(A, dtype=np.float64)
    big = (np.abs(r) >= 360) & np.isfinite(r)
    if np.any(big):
        # (math.fmod is exact; the runtime's numpy has no fmod)
        idx = np.flatnonzero(big)
        r.flat[idx] = [_math.fmod(float(r.flat[i]), 360.0) for i in idx]
    q = np.round(r / 90.0)
    d = (r - 90.0 * q) * (_math.pi / 180)
    q = np.mod(q, 4)
    sd, cd = np.sin(d), np.cos(d)
    s = np.select([q == 0, q == 1, q == 2], [sd, cd, -sd], -cd)
    c = np.select([q == 0, q == 1, q == 2], [cd, -sd, -cd], sd)
    return np.where(s == 0, 0.0, s), np.where(c == 0, 0.0, c)


def _tand(A):
    """tand: tan of the angle reduced exactly to [-90, 90] (fmod by 180, then the nearest
    multiple of 180), within 15 degrees of a pole by the reciprocal of its exact complement;
    0 and ±Inf exactly at the multiples of 90 (tand(60) is tan(60*pi/180), as Octave's;
    near 180 and near 90 the angle's distance keeps its digits)"""
    if A.dtype.kind == "c":
        raise _err("Complex arguments to sind, cosd and the other degree functions are not supported in Sagebrush.")
    r = np.array(A, dtype=np.float64)
    big = (np.abs(r) >= 180) & np.isfinite(r)
    if np.any(big):
        idx = np.flatnonzero(big)
        r.flat[idx] = [_math.fmod(float(r.flat[i]), 180.0) for i in idx]
    t = r - 180.0 * np.round(r / 180.0)
    out = np.tan(t * (_math.pi / 180))
    # (near a pole, |t| > 75: the complement 90 - |t|, exact in degrees, so the distance to
    # the pole keeps its digits: tand(90 - eps(90)) is 1/tan of eps(90) degrees)
    near = np.abs(t) > 75
    if np.any(near):
        with np.errstate(divide="ignore"):
            out = np.where(near, np.sign(t) / np.tan((90.0 - np.abs(t)) * (_math.pi / 180)), out)
    out = np.where(t == 0, 0.0, out)
    out = np.where(t == 90, _math.inf, out)
    return np.where(t == -90, -_math.inf, out)


def _sind(A):
    return _sincosd(A)[0]


def _cosd(A):
    return _sincosd(A)[1]


# (+ 0.0: sqrt(-0) is +0 in MATLAB, as its page says, not IEEE's -0)
_unary("sqrt", lambda A: np.sqrt(A) + 0.0, lambda A: A < 0)
_unary("exp", np.exp)
_unary("log", np.log, lambda A: A < 0)
# (a complex log divided part by part: log2 of a complex 0 or Inf keeps a zero imaginary part)
_unary("log2", lambda A: _div(np.log(A), np.float64(_math.log(2))) if A.dtype.kind == "c" else np.log2(A), lambda A: A < 0)
_unary("log10", np.log10, lambda A: A < 0)
_unary("log1p", np.log1p, lambda A: A < -1)
_unary("expm1", np.expm1)
_unary("sin", np.sin)
_unary("cos", np.cos)
_unary("tan", np.tan)
# (for real x > 1, MATLAB's asin and acos take the conjugate of the C library's value at x + 0i,
# as their pages' examples show: acos(2) = 0 + 1.3170i, asin(2) = 1.5708 - 1.3170i; for x < -1
# they agree: acos(-3) = 3.1416 - 1.7627i)
_unary("asin", np.arcsin, lambda A: np.abs(A) > 1, real_fix=lambda A, r: np.where(A > 1, np.conj(r), r))
_unary("acos", np.arccos, lambda A: np.abs(A) > 1, real_fix=lambda A, r: np.where(A > 1, np.conj(r), r))
_unary("atan", np.arctan)
_unary("sinh", np.sinh)
_unary("cosh", np.cosh)
_unary("tanh", np.tanh)
_unary("asinh", np.arcsinh)
_unary("acosh", np.arccosh, lambda A: A < 1)
# (for real x outside [-1, 1], MATLAB's atanh is odd: atanh(-3) = -0.3466 - 1.5708i, the
# conjugate of what the complex -3 + 0i gives)
_unary("atanh", np.arctanh, lambda A: np.abs(A) > 1, real_fix=lambda A, r: np.where(A < -1, np.conj(r), r))
_unary("sec", lambda A: 1 / np.cos(A))
_unary("csc", lambda A: 1 / np.sin(A))
_unary("cot", lambda A: 1 / np.tan(A))
_unary("sind", _sind)
_unary("cosd", _cosd)
_unary("tand", lambda A: _tand(A))
# (from sind and cosd, which are exactly 0 at their zeros: secd(90) and cscd(180) are Inf, cotd(90) 0)
_unary("secd", lambda A: 1 / _cosd(A))
_unary("cscd", lambda A: 1 / _sind(A))
_unary("cotd", lambda A: np.divide(*reversed(_sincosd(A))))


def _recip_inverse(name, base):
    """asec, acsc, acot and the hyperbolic three: the base inverse function of 1./X, as
    their pages define them (asec(X) is acos(1./X)), so the complex results of real
    arguments outside the domain follow the base function's conventions"""
    def g(nargout, x):
        cls = class_(x)
        if cls in ("cell", "struct", "string", "function_handle") or cls in _INTS:
            raise _err("Undefined function '%s' for input arguments of type '%s'." % (name, cls), "MATLAB:UndefinedFunction")
        A = _farr(x, name)
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            R = 1 / A
        if R.dtype.kind == "c":
            # (a zero imaginary part as +0: 1/(-3+0i) is -1/3 - 0i, which would put the base
            # function on the other side of its branch cut from the real -1/3)
            R = R.copy()
            R.imag = np.where(R.imag == 0, 0.0, R.imag)
            # (a complex zero's reciprocal as a real zero's, ±Inf + 0i, not Inf + NaNi: acsch of
            # complex(0, 0) is Inf, as its page's numeric example shows)
            zero = (A.real == 0) & (A.imag == 0)
            if np.any(zero):
                R.real = np.where(zero, np.copysign(np.inf, A.real), R.real)
                R.imag = np.where(zero, 0.0, R.imag)
        return _B[base].f(nargout, _finish(R, "single" if cls == "single" else "double"))
    _B[name] = Builtin(g, name)


for _n, _b in (("asec", "acos"), ("acsc", "asin"), ("acot", "atan"), ("asech", "acosh"), ("acsch", "asinh"), ("acoth", "atanh")):
    _recip_inverse(_n, _b)


def _in_degrees(name, base):
    """asind, acosd, atand and the reciprocal three: the radian function's result times
    180/pi, a complex result too, in its class (asind(2) is 90 - 75.4561i)"""
    def g(nargout, x):
        r = _B[base].f(nargout, x)
        cls = class_(r)
        R = _farr(r, name)
        k = 180 / _math.pi
        if R.dtype.kind == "c":
            # (each part scaled on its own, a zero part kept zero: a complex Inf times 180/pi
            # would put NaN into the other part)
            R = _cplx(np.where(R.real == 0, 0.0, R.real * k), np.where(R.imag == 0, 0.0, R.imag * k))
        else:
            R = R * k
        return _finish(R, "single" if cls == "single" else "double")
    _B[name] = Builtin(g, name)


for _n in ("asin", "acos", "atan", "asec", "acsc", "acot"):
    _in_degrees(_n + "d", _n)


def _gamma(x):
    """MATLAB's gamma: exact (x-1)! at the integers up to 171, Inf at the negative integers (as
    MathWorks' gamma page has it), and at 0 the infinity of the zero's sign (-Inf at -0, as the C
    library's tgamma and Octave give); gamma(-Inf), which the page does not give, is refused"""
    if x != x:
        return _math.nan
    if x == -_math.inf:
        raise _err("gamma of -Inf is not supported in Sagebrush: it has no limit there.")
    if x == _math.floor(x):
        if x == 0:
            return _math.copysign(_math.inf, x)
        if x < 0:
            return _math.inf
        return float(_math.factorial(int(x) - 1)) if x <= 171 else _math.inf
    # (the C library's, as Octave's; math.gamma is CPython's own)
    return _math._libm_gamma(x)


def _lgamma(x):
    if x != x:
        return _math.nan
    if x <= 0 and x == _math.floor(x):
        return _math.inf
    return _math._libm_lgamma(x)


_unary("gamma", lambda A: _vec_math(_gamma, A, _math.inf))
_unary("gammaln", lambda A: _vec_math(_lgamma, A, _math.inf))
_unary("erf", lambda A: _vec_math(_math.erf, A))
_unary("erfc", lambda A: _vec_math(_math.erfc, A))


def _round_half_away(A):
    return np.where(A >= 0, np.floor(A + 0.5), -np.floor(-A + 0.5))


def _round_c(A):
    if A.dtype.kind == "c":
        return _round_c(_contig(A.real)) + 1j * _round_c(_contig(A.imag))
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
            if x != x or x in (_math.inf, -_math.inf):
                return x  # (NaN and Inf round to themselves)
            return float(_math.floor(x + 0.5)) if x >= 0 else -float(_math.floor(-x + 0.5))
        cls = class_(x)
        if cls in _INTS:
            return cp(x)
        return _finish(_round_c(_farr(x)), "single" if cls == "single" else "double")
    if _istext(n):
        # (round(x, 'TieBreaker', ...) and other name-value options: not supported)
        raise _err("round: the option '%s' is not supported in Sagebrush." % _text(n))
    d = _int_arg(n)
    t = _text(kind).lower() if kind is not None and _istext(kind) else ("decimals" if kind is None else None)
    if t not in ("decimals", "significant"):
        raise _err("round: the rounding type must be 'decimals' or 'significant'.")
    cls = class_(x)
    if cls not in ("double", "single"):
        # (round's page: with N, X is single or double)
        raise _err("round: with a number of digits, X must be single or double, not %s." % cls)
    A = _farr(x)
    if t == "significant":
        with np.errstate(divide="ignore"):
            e = np.floor(np.log10(np.abs(np.where(A == 0, 1, A)))) + 1
        s = 10.0 ** (d - e)
        r = _round_c(A * s) / s
    elif d >= 0:
        s = 10.0 ** d
        r = _round_c(A * s) / s
    else:
        s = 10.0 ** (-d)
        r = _round_c(A / s) * s
    # (the input's class, as round's page says: single stays single)
    return _finish(r, cls)


@_bi("abs")
def abs_(nargout, x):
    if type(x) is float or type(x) is complex:
        return abs(x)
    cls = class_(x)
    if cls in _INTS:
        # (in double and back through the class's rounding: abs of the minimum saturates, as
        # abs(int8(-128)) is 127, where the integer abs wraps to the minimum; int64's
        # 2^63 is refused there, Sagebrush's 64-bit integers not being exact)
        return _finish(np.abs(_farr(x)), cls)
    A = _farr(x, "abs")
    return _finish(np.abs(A).astype(np.float64), "single" if cls == "single" else "double")


@_bs("real")
def real_(x):
    if type(x) is complex:
        return x.real
    A = _farr(x)
    return _box(_contig(A.real) if A.dtype.kind == "c" else A.copy())


@_bs("imag")
def imag_(x):
    if type(x) is complex:
        return x.imag
    A = _farr(x)
    return _box(_contig(A.imag) if A.dtype.kind == "c" else np.zeros(A.shape))


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
    ca, cb = class_(a), class_(b)
    if ca in _INTS or cb in _INTS:
        # (complex integers, as complex(uint8(1), uint8(2)) makes in MATLAB, are not
        # represented: refused rather than made double)
        raise _err("complex of %s values is not supported in Sagebrush: complex integers are not represented." % (ca if ca in _INTS else cb))
    # (the parts set separately: x + 1j*y would add +0 to a -0 imaginary part, losing its sign,
    # and with it the side of a branch cut log, sqrt and angle take)
    def parts(x, y):
        x, y = np.broadcast_arrays(x, y)
        z = np.empty(x.shape, dtype=np.complex128)
        z.real = x
        z.imag = y
        return z
    r = np.asarray(_broadcast(parts, _farr(a), _farr(b)), dtype=np.complex128)
    if "single" in (ca, cb):
        return _canon(_contig(r.astype(np.complex64)))
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
    return r


def _rem(A, B):
    with np.errstate(divide="ignore", invalid="ignore"):
        r = _fmod(A, np.where(B == 0, 1.0, B))
        return np.where(B == 0, _math.nan, r)


@_bi("mod")
def mod_(nargout, a, b):
    if type(a) is float and type(b) is float:
        if b == 0:
            return a
        if a != a or b != b or a in (_math.inf, -_math.inf):
            return _math.nan
        if b in (_math.inf, -_math.inf):
            # (mod's page gives mod(a, 0) but not an infinite divisor, where its formula
            # a - m.*floor(a./m) is NaN: refused, not guessed)
            raise _err("mod with an infinite divisor is not supported in Sagebrush.")
        r = _math.fmod(a, b)
        if r != 0 and (r < 0) != (b < 0):
            r += b
        return r
    if not isreal_(a) or not isreal_(b):
        raise _err("mod: complex arguments are not supported; the arguments must be real.")
    if np.any(np.isinf(_farr(b))):
        raise _err("mod with an infinite divisor is not supported in Sagebrush.")
    return _elementwise(a, b, _mod, "mod")


@_bi("rem")
def rem_(nargout, a, b):
    # (rem's page: rem(a, 0) is NaN; an infinite divisor, which the page leaves open, is refused)
    if type(a) is float and type(b) is float:
        if b in (_math.inf, -_math.inf):
            raise _err("rem with an infinite divisor is not supported in Sagebrush.")
        if b == 0 or a != a or b != b or a in (_math.inf, -_math.inf):
            return _math.nan
        return _math.fmod(a, b)
    if isreal_(b) and np.any(np.isinf(_farr(b))):
        raise _err("rem with an infinite divisor is not supported in Sagebrush.")
    if not isreal_(a) or not isreal_(b):
        raise _err("rem: complex arguments are not supported; the arguments must be real.")
    return _elementwise(a, b, _rem, "rem")


# (MathWorks' atan2 page, IEEE compliance: atan2(0, -0) and atan2(-0, -0) are 0, where IEEE
# arithmetic gives pi and -pi)
_binary_fn("atan2", lambda A, B: np.where((A == 0) & (B == 0) & np.signbit(B), 0.0, np.arctan2(A, B)))
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
    cls = class_(n)
    flat = A.reshape(-1)
    if np.any(np.isnan(flat)):
        raise _err("factorial of NaN is not supported in Sagebrush.")
    if np.any((flat < 0) | ((flat != np.floor(flat)) & np.isfinite(flat))):
        raise _err("N must be a matrix of non-negative integers.", "MATLAB:factorial:NNegativeInt")
    if cls in _INTS:
        # (an integer class: exact, saturating at its largest value, the class's exact limit;
        # 21! passes every class's, so larger N are not multiplied out. Sagebrush's 64-bit
        # integers hold 53 bits, as doubles do: a result they would round is refused)
        hi = _INTS[cls][2]
        vals = [min(_math.factorial(int(x)), hi) if x <= 20 else hi for x in flat]
        if cls in ("int64", "uint64"):
            vals = [_exact_int(v) for v in vals]
        return _canon(np.array(vals, dtype=_INTS[cls][0]).reshape(A.shape))
    out = np.array([float(_math.factorial(int(x))) if x <= 170 else _math.inf for x in flat]).reshape(A.shape)
    return _finish(out, cls) if cls == "single" else _box(out)


@_bs("nchoosek")
def nchoosek_(n, k):
    kcls = class_(k)
    k = _int_arg(k)
    if _numel(n) == 1:
        ncls = class_(n)
        # (the classes first: an error that depends on them only comes before any work)
        if ncls != kcls and "double" not in (ncls, kcls):
            raise _err("nchoosek: N and K must be the same class, or one of them double.")
        nn = _int_arg(n)
        if not 0 <= k <= nn:
            raise _err("nchoosek: K must be an integer between 0 and N.")
        # (a single or integer n or k gives that class, as nchoosek's page says; an integer
        # class's result past its range, or past the 53 bits Sagebrush's 64-bit integers
        # keep, is refused rather than saturated or rounded)
        cls = ncls if ncls != "double" else kcls
        # (a lower bound on the result's size before the exact binomial is computed: with
        # j = min(K, N - K), C(N, K) >= (N/j)^j, so j*log2(N/j) bits past the class's range,
        # with 8 to spare for rounding, is refused unbuilt. Below it j <= 1032 and N is
        # bounded too, so the exact product is small; K = 1 and K = N - 1 stay exact)
        j = min(k, nn - k)
        if j > 0:
            bits = j * (_math.log2(nn) - _math.log2(j))
            if not bits <= (64 if cls in _INTS else 128 if cls == "single" else 1024) + 8:
                raise _err("nchoosek: the result, at least 2^%d, is outside %s's range: not supported in Sagebrush." % (int(min(bits, 1e9)), cls))
        c = _math.comb(nn, j)
        if cls in _INTS:
            if c > _INTS[cls][2]:
                raise _err("nchoosek: the result %d is outside %s's range: not supported in Sagebrush." % (c, cls))
            return _canon(np.array([[_exact_int(c) if cls in ("int64", "uint64") else c]], dtype=_INTS[cls][0]))
        try:
            f = float(c)
        except OverflowError:
            raise _err("nchoosek: the result, about 2^%d, is outside %s's range: not supported in Sagebrush." % (c.bit_length() - 1, cls))
        return _finish(np.array([[f]]), "single") if cls == "single" else f
    v = list(_arr(n).reshape(-1))
    import itertools
    combos = list(itertools.combinations(range(len(v)), k))
    out = np.array([[float(v[i]) for i in c] for c in combos], dtype=np.float64).reshape((len(combos), k))
    # (the combinations of v's elements keep v's class: nchoosek(uint16([10 20 30]), 2) is uint16)
    cls = class_(n)
    return _convert(_unmat(out), cls) if cls in _INTS or cls == "single" else _unmat(out)


@_bi("rat")
def rat_(nargout, x, tol=None):
    """[N, D] = rat(X) as its page describes: each element as N./D by continued fraction
    expansion (each term rounded to the nearest integer), stopped once abs(X - N./D) is
    within tol, by default 1e-6*norm(X(:), 1); D is positive; Inf is 1/0 (or -1/0) and
    NaN 0/0. The one-output form, the expansion as text, is refused"""
    if nargout < 2:
        raise _err("rat with one output (the continued fraction as text) is not supported in Sagebrush; use [N, D] = rat(X), which gives X as N./D.")
    cls = class_(x)
    if cls not in ("double", "single"):
        raise _err("rat: X must be double or single.")
    A = _farr(x)
    if A.dtype.kind == "c":
        raise _err("rat of complex values is not supported in Sagebrush.")
    flat = A.reshape(-1)
    fin = flat[np.isfinite(flat)]
    if tol is not None and (_istext(tol) or _numel(tol) != 1 or not isreal_(tol) or not _scalar(tol) >= 0):
        raise _err("rat: tol must be a real nonnegative scalar.")
    t = 1e-6 * float(np.sum(np.abs(fin))) if tol is None else float(_scalar(tol))
    N = np.zeros(flat.size)
    D = np.zeros(flat.size)
    for i, v in enumerate(flat):
        v = float(v)
        if v != v:
            continue
        if v in (_math.inf, -_math.inf):
            N[i], D[i] = (1.0 if v > 0 else -1.0), 0.0
            continue
        n, d = float(round(v)), 1.0
        ln, ld = 1.0, 0.0
        frac = v - round(v)
        k = 0
        while abs(v - n / d) >= t and frac != 0 and k < 64:
            flip = 1.0 / frac
            step = float(round(flip))
            frac = flip - step
            n, ln = n * step + ln, n
            d, ld = d * step + ld, d
            k += 1
        if d < 0:
            n, d = -n, -d
        # (a tolerance the expansion can't reach, such as 0 for pi: refused, not missed)
        if abs(v - n / d) > t:
            raise _err("rat: the tolerance %g cannot be reached for %.17g (the closest ratio found is %.17g/%.17g)." % (t, v, n, d))
        N[i], D[i] = n, d
    shape = A.shape
    return [_finish(N.reshape(shape), cls), _finish(D.reshape(shape), cls)] + [NOVAL] * (nargout - 2)


# (the most perms makes: bytes of its result, whose indexing and copy take about three
# times that; n! rows of n, so 8 doubles' or chars' permutations, or 9 of an 8-bit class)
_PERMS_BYTES_MAX = 8 << 20


def _lex_perms(n):
    """the permutations of 0..n-1 in lexicographic order, rows of an int8 array, built
    from those of n-1 (each first element, then the others in order) without tuples"""
    P = np.zeros((1, 0), dtype=np.int8)
    for k in range(1, n + 1):
        m = P.shape[0]
        blocks = []
        for first in range(k):
            rest = (P + (P >= first)).astype(np.int8)
            blocks.append(np.concatenate([np.full((m, 1), first, dtype=np.int8), rest], axis=1))
        P = np.concatenate(blocks, axis=0)
    return P


@_bs("perms")
def perms_(v):
    """perms(v) as its page says: every permutation of the elements of v, one per row, in
    reverse lexicographic order of their positions (perms(1:3) starts [3 2 1]), in v's class"""
    t = type(v)
    if t in (Cell, Struct, StrArr) or _iscallable(v):
        raise _err("perms of a %s is not supported in Sagebrush; use it on an index vector, C(perms(1:numel(C)))." % class_(v))
    if t is Str:
        raise _err("perms of a string scalar is not supported in Sagebrush.")
    n = _numel(v)
    flat = _arr(v).reshape(-1)
    # (the result's size before any of it is made; past 12 elements, before n! is computed)
    if n > 12 or _math.factorial(n) * n * flat.dtype.itemsize > _PERMS_BYTES_MAX:
        raise _err("perms of %d elements is not supported in Sagebrush: its result is limited to %d bytes (8 elements of a double vector); loop over the permutations instead." % (n, _PERMS_BYTES_MAX))
    if n == 0:
        return _box(np.zeros((0, 1), dtype=flat.dtype)) if t is not Char else Char(np.zeros((0, 1), dtype=flat.dtype))
    rows = _lex_perms(n)[::-1]
    out = _canon(_contig(flat[rows.astype(np.int64)].T))
    if t is Char:
        return Char(out)
    return _box(out) if out.dtype == np.float64 else out


@_bs("primes")
def primes_(n):
    # (in the class of n: primes(uint16(12)) is uint16)
    if _numel(n) != 1:
        raise _err("N must be a scalar.")
    cls = class_(n)
    if cls in _INTS or cls == "single":
        r = primes_(float(_scalar(n)))
        return _convert(r, cls)
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


# the options of each reduction ('all' aside); another is refused
_OUTTYPE = ("double", "native", "default")
_NANFLAG = ("omitnan", "includenan")
_REDUCE_FLAGS = {
    "sum": _OUTTYPE + _NANFLAG, "prod": _OUTTYPE + _NANFLAG, "mean": _OUTTYPE + _NANFLAG,
    "median": _NANFLAG, "var": _NANFLAG, "mode": (), "any": (), "all": (),
    "cumsum": _NANFLAG + ("reverse", "forward"), "cumprod": _NANFLAG + ("reverse", "forward"),
    "cummax": _NANFLAG + ("reverse", "forward"), "cummin": _NANFLAG + ("reverse", "forward"),
}


def _dim_arg(args, d, name=None):
    """(dim or 'all', flags) from a reduction's extra arguments; with the
    reduction's name, an option it does not take is refused"""
    dim = None
    flags = []
    for a in args:
        if _istext(a):
            s = _text(a).lower()
            s = {"omitmissing": "omitnan", "includemissing": "includenan"}.get(s, s)
            if s == "all":
                dim = "all"
            elif name is not None and s not in _REDUCE_FLAGS.get(name, ()):
                raise _err("%s: invalid option '%s'." % (name, _text(a)))
            else:
                flags.append(s)
        elif _numel(a) == 0:
            # (an empty dimension is none of the pages' forms)
            raise _err("%s: the dimension must be a positive integer, not empty." % (name or "the reduction"))
        elif _numel(a) > 1:
            # (a vector of positive integer dimensions)
            v = _farr(a)
            ad = _dims(a)
            if v.dtype.kind == "c" or sum(1 for k in ad if k != 1) > 1 or not np.all(v == np.floor(v)) or not np.all(v >= 1):
                raise _err("%s: the dimensions must be a vector of positive integers." % (name or "the reduction"))
            dim = sorted(set(int(k) for k in v.reshape(-1)))
        else:
            dim = _int_arg(a, "dimension")
            if dim < 1:
                raise _err("%s: the dimension must be a positive integer." % (name or "the reduction"))
    if dim is None:
        dim = _default_dim(d)
    return dim, flags


def _collapse(A, dims):
    """A (stored) with MATLAB dimensions dims merged into its last axis: (B, result shape)"""
    nd = max(A.ndim, max(dims))
    A = A.reshape((1,) * (nd - A.ndim) + A.shape)
    axes = [nd - k for k in dims]
    others = [ax for ax in range(nd) if ax not in axes]
    B = np.transpose(A, others + axes)
    B = np.array(B).reshape(tuple(A.shape[ax] for ax in others) + (-1,))
    shape = tuple(1 if ax in axes else A.shape[ax] for ax in range(nd))
    return B, shape


def _reduce(x, args, f, name, empty_value=0.0, out_cls=None):
    """f(A, axis) along MATLAB dimension dim of x (that dimension becomes 1)"""
    d = _dims(x)
    dim, flags = _dim_arg(args, d, name)
    cls = class_(x)
    A = _farr(x, name)
    # (MATLAB: double, except single stays single; 'native' keeps an integer class)
    oc = out_cls or ("single" if cls == "single" else "double")
    if "native" in flags and cls in _INTS:
        oc = cls
    if "native" in flags and cls in ("logical", "char"):
        # (sum's page: 'native' keeps the input's type, a logical sum being logical; char is
        # not supported; prod keeps logical too, and mean's logical 'native' is refused)
        if cls == "char" or name not in ("sum", "prod"):
            raise _err("%s: 'native' is not supported for %s input." % (name, cls))
        oc = "logical"
    if "double" in flags:
        oc = "double"
    if not [a for a in args if not _istext(a)] and d == (0, 0) and dim != "all":
        return _finish(np.array([[empty_value]]), oc)
    if oc == "single" and name in ("sum", "prod"):
        # (a single sum or product accumulates in single, as MATLAB's native single arithmetic
        # does: sum(single([1e8 1 -1e8])) is 0, the 1 lost to rounding)
        A = _single_work(A)
    if dim == "all":
        A = A.reshape((1, -1))
        dim = 1
    if type(dim) is list:
        B, shape = _collapse(A, dim)
        return _finish(_canon(_contig(np.asarray(f(B, B.ndim - 1)).reshape(shape))), oc)
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
    return _finish(_contig(res), oc)


def _nan_flags(args):
    return any(_istext(a) and _text(a).lower() in ("omitnan", "omitmissing") for a in args)


@_bs("sum")
def sum_(x, *args):
    if type(x) is float and not args:
        return x
    if _nan_flags(args):
        return _reduce(x, args, lambda A, ax: np.sum(np.where(np.isnan(A), 0, A), axis=ax), "sum")
    return _reduce(x, args, lambda A, ax: np.sum(A, axis=ax), "sum")


def _single_work(A):
    """A as single-precision working values (complex64 for complex)"""
    return A.astype(np.complex64 if A.dtype.kind == "c" else np.float32)


def _cmul(z, w, single):
    """z*w as compiled complex multiplication does it: four real products and two sums, each
    rounded to single for single values, and when both parts come out NaN, the C standard's
    (Annex G) recovery of an infinite operand or an overflowed product"""
    if single:
        # (a double product of two singles is exact, and so a double sum of two singles
        # correctly rounds to single: rounding the double result is single arithmetic)
        rnd = lambda *xs: np.array(xs, dtype=np.float32).tolist()
    else:
        rnd = lambda *xs: list(xs)
    a, b, c, d = z.real, z.imag, w.real, w.imag
    ac, bd, ad, bc = rnd(a * c, b * d, a * d, b * c)
    x, y = rnd(ac - bd, ad + bc)
    if x != x and y != y:
        inf = _math.inf
        box = lambda t: _math.copysign(1.0 if _math.isinf(t) else 0.0, t)
        zero = lambda t: _math.copysign(0.0, t) if t != t else t
        again = False
        if _math.isinf(a) or _math.isinf(b):
            a, b, c, d = box(a), box(b), zero(c), zero(d)
            again = True
        if _math.isinf(c) or _math.isinf(d):
            c, d, a, b = box(c), box(d), zero(a), zero(b)
            again = True
        if not again and any(_math.isinf(t) for t in (ac, bd, ad, bc)):
            a, b, c, d = zero(a), zero(b), zero(c), zero(d)
            again = True
        if again:
            ac, bd, ad, bc = rnd(a * c, b * d, a * d, b * c)
            x, y = rnd(ac - bd, ad + bc)
            x, y = rnd(inf * x, inf * y)
    return complex(x, y)


def _prod_axis(A, ax):
    """the product along axis ax, complex values multiplied one at a time by _cmul (in single
    for complex64 values)"""
    if A.dtype == np.float32:
        # (single values multiplied in single, each step rounded: the last running product, as
        # cumprod rounds; an empty product is 1)
        if A.shape[ax] == 0:
            return np.ones([n for i, n in enumerate(A.shape) if i != ax], dtype=np.float32)
        return np.take(np.cumprod(A, axis=ax), -1, axis=ax)
    if A.dtype.kind != "c":
        return np.prod(A, axis=ax)
    one = A.dtype == np.complex64
    B = np.moveaxis(A, ax, -1)
    # (an explicit row count: with an empty axis, -1 is ambiguous)
    flat = B.reshape((int(np.prod(B.shape[:-1])), B.shape[-1]))
    out = []
    for row in flat:
        z = complex(1.0)
        for v in row:
            z = _cmul(z, complex(v), one)
        out.append(z)
    return np.array(out, dtype=np.complex128).reshape(B.shape[:-1])


def _cumprod_axis(A, ax):
    """the running products along axis ax: complex values multiplied one at a time by _cmul (in
    single for complex64 values), each running product starting from the first value itself"""
    if A.dtype.kind != "c":
        return np.cumprod(A, axis=ax)
    one = A.dtype == np.complex64
    B = np.moveaxis(A, ax, -1)
    flat = B.reshape((int(np.prod(B.shape[:-1])), B.shape[-1]))
    out = np.empty(flat.shape, dtype=np.complex128)
    for r in range(flat.shape[0]):
        z = None
        for k in range(flat.shape[1]):
            v = complex(flat[r, k])
            z = v if z is None else _cmul(z, v, one)
            out[r, k] = z
    return np.moveaxis(out.reshape(B.shape), -1, ax)


def _cmul_arr(A, B, single):
    """A .* B for complex arrays, each element as _cmul multiplies it: the four products and two
    sums vectorized (rounded to single for single values), and the elements whose parts both
    come out NaN redone one at a time by _cmul for the C standard's recovery"""
    A, B = np.broadcast_arrays(A, B)
    if single:
        rnd = lambda t: t.astype(np.float32).astype(np.float64)
    else:
        rnd = lambda t: t
    a, b, c, d = (np.asarray(t, dtype=np.float64) for t in (A.real, A.imag, B.real, B.imag))
    with np.errstate(invalid="ignore", over="ignore"):
        ac, bd, ad, bc = rnd(a * c), rnd(b * d), rnd(a * d), rnd(b * c)
        x, y = rnd(ac - bd), rnd(ad + bc)
    lost = np.isnan(x) & np.isnan(y)
    if np.any(lost):
        x, y = x.copy(), y.copy()
        for i in zip(*np.nonzero(lost)):
            z = _cmul(complex(A[i]), complex(B[i]), single)
            x[i], y[i] = z.real, z.imag
    return _cplx(x, y)


@_bs("prod")
def prod_(x, *args):
    if _nan_flags(args):
        return _reduce(x, args, lambda A, ax: _prod_axis(np.where(np.isnan(A), 1, A), ax), "prod", 1.0)
    return _reduce(x, args, lambda A, ax: _prod_axis(A, ax), "prod", 1.0)


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


def _csort(A, ax):
    """complex A sorted along ax as MATLAB's sort orders complex numbers: by magnitude, then by
    phase angle in (-pi, pi]; NaN last"""
    import cmath as _cm
    B = np.moveaxis(A, ax, -1)
    shp = B.shape
    flat = B.reshape((-1, shp[-1]))

    def key(z):
        if z != z:
            return (1, 0.0, 0.0)
        ph = _cm.phase(z)
        return (0, abs(z), _math.pi if ph == -_math.pi else ph)
    out = np.array([sorted((complex(z) for z in row), key=key) for row in flat], dtype=np.complex128).reshape(shp)
    return np.moveaxis(out, -1, ax)


@_bs("median")
def median_(x, *args):
    if class_(x) == "char":
        # (median's page does not list char input)
        raise _err("median of a char array is not supported in Sagebrush; convert it with double().")
    if _dims(x) == (0, 0) and not args:
        return _math.nan

    omit = _nan_flags(args)

    def med(A, ax):
        n = A.shape[ax]
        if n == 0:
            return _nanfull(A, ax)
        if omit:
            # (each slice's own count of numbers; the NaN sort last)
            m = np.sum(~np.isnan(A), axis=ax, keepdims=True)
            # (complex numbers in sort's order, by magnitude: median's middle values)
            S = _csort(A, ax) if A.dtype.kind == "c" else np.sort(np.where(np.isnan(A), np.inf, A), axis=ax)
            hi = _take_along(S, np.maximum(m // 2, 0), ax)
            lo = _take_along(S, np.maximum((m - 1) // 2, 0), ax)
            with np.errstate(invalid="ignore"):
                r = np.where(m % 2 == 0, lo + (hi - lo) / 2, lo)
            return np.squeeze(np.where(m == 0, _math.nan, r), axis=ax)
        S = _csort(A, ax) if A.dtype.kind == "c" else np.sort(A, axis=ax)
        lo = np.take(S, (n - 1) // 2, axis=ax)
        hi = np.take(S, n // 2, axis=ax)
        r = lo + (hi - lo) / 2 if n % 2 == 0 else lo
        return np.where(np.any(np.isnan(A), axis=ax), _math.nan, r)
    # (natively in the class of A, as median's page says: median(int8(1:4)) is int8(3), the mean of
    # the middle two rounded; logical too, where the middle values agree; char gives double)
    cls = class_(x)
    r = _reduce(x, args, med, "median", out_cls=cls if cls in _INTS or cls == "single" else "double")
    if cls == "logical":
        R = _arr(r)
        if not np.all((R == 0) | (R == 1)):
            raise _err("median of logical values whose middle values differ, or of an empty array, is not supported in Sagebrush.")
        return _finish(R != 0, "logical")
    return r


@_bi("mode")
def mode_(nargout, x, *args):
    """[M, F, C] = mode(A, dim): as mode's page says, NaN is ignored, the smallest of equally
    frequent values is M, F counts it (double), C holds every value as frequent, sorted, as a
    column; M keeps A's class"""
    if _arr(x).dtype.kind == "c":
        raise _err("mode of complex numbers is not supported in Sagebrush.")
    if class_(x) == "char":
        raise _err("mode of a char array is not supported in Sagebrush; convert it with double().")
    store = []

    def slices(A, ax):
        A2 = np.moveaxis(A, ax, -1)
        res = []
        for row in A2.reshape((int(np.prod(A2.shape[:-1])), A2.shape[-1])):
            row = row[~np.isnan(row)]
            vals, counts = np.unique(row, return_counts=True)
            if vals.size:
                top = counts.max()
                res.append((float(vals[np.argmax(counts)]), float(top), vals[counts == top]))
            else:
                res.append((_math.nan, 0.0, None))
        return A2.shape[:-1] or (1,), res

    def part(k):
        def f(A, ax):
            shp, res = slices(A, ax)
            if k < 2:
                return np.array([r[k] for r in res]).reshape(shp)
            out = []
            for r in res:
                out.append(len(store))
                store.append(r[2])
            return np.array(out, dtype=float).reshape(shp)
        return f
    cls = class_(x)
    # (M keeps A's class: integer, single or logical; F is double)
    M = _reduce(x, args, part(0), "mode", empty_value=_math.nan, out_cls=cls if cls in _INTS or cls in ("single", "logical") else "double")
    if nargout < 2:
        return M
    F = _reduce(x, args, part(1), "mode", out_cls="double")
    if nargout < 3:
        return [M, F]
    I = _reduce(x, args, part(2), "mode", empty_value=-1.0, out_cls="double")
    cells = []
    for i in np.asarray(_arr(I), dtype=float).reshape(-1):
        v = store[int(i)] if i >= 0 else None
        if v is None:
            raise _err("mode: C for values that are all NaN, or for no values, is not supported in Sagebrush.")
        cells.append(_finish(_contig(np.asarray(v, dtype=float).reshape((1, -1))), class_(M)))
    return [M, F, Cell(cells, _dims(I))]


def _var_impl(x, args, sq):
    _need_float(x, "std" if sq else "var")
    w = 0
    rest = list(args)
    if args and not _istext(args[0]):
        if _numel(args[0]) > 0:
            a0 = args[0]
            # (w is 0 or 1, the normalization, or a vector of weights, which
            # Sagebrush does not compute: refused, not read as a scalar)
            if _numel(a0) != 1 or not _isnumlike(a0) or _arr(a0).dtype.kind == "c" or _scalar(a0) not in (0.0, 1.0):
                raise _err("%s: Sagebrush computes w = 0 or w = 1 only; weighted %s (a vector of weights) are not supported yet."
                           % ("std" if sq else "var", "standard deviations" if sq else "variances"))
            w = int(_scalar(a0))
            rest = list(args[1:])
        else:
            # (no weight: var(A, "omitnan") keeps its flag; an empty w, var(A, [], dim), is the default)
            rest = list(args[1:]) if _numel(args[0]) == 0 and not _istext(args[0]) else list(args)
    if _dims(x) == (0, 0) and not rest:
        return _math.nan
    omit = _nan_flags(rest)

    def v(A, ax):
        n = A.shape[ax]
        if n == 0:
            return _nanfull(A, ax)
        if omit:
            ok = ~np.isnan(A)
            c = np.sum(ok, axis=ax, keepdims=True)
            with np.errstate(invalid="ignore", divide="ignore"):
                m = np.sum(np.where(ok, A, 0), axis=ax, keepdims=True) / c
                dev = np.where(ok, np.abs(A - m) ** 2, 0)
                den = np.where((w == 0) & (c > 1), c - 1, c)
                r = np.sum(dev, axis=ax, keepdims=True) / den
            r = np.squeeze(np.where(c == 0, _math.nan, r), axis=ax)
            return np.sqrt(r) if sq else r
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
    dim, flags = _dim_arg(args, d, name)
    if dim == "all" or type(dim) is list:
        # (the cumulative functions' dim is one positive integer: no 'all', no vecdim)
        raise _err("%s: the dimension must be one positive integer." % name)
    cls = class_(x)
    oc = "double" if cls in ("logical", "char") else cls
    A = _farr(x, name)
    if cls == "single":
        # (running sums and products of single accumulate in single, as sum and prod do)
        A = _single_work(A)
    if "omitnan" in flags:
        A = np.where(np.isnan(A), 1.0 if name == "cumprod" else 0.0, A)
    if dim > A.ndim:
        return _finish(A.copy(), oc)
    ax = A.ndim - dim
    if "reverse" in flags:
        r = np.flip(f(np.flip(A, axis=ax), ax), axis=ax)
    else:
        r = f(A, ax)
    return _finish(_contig(r), oc)


# ------------------------------------------------------------------ fft

def _fft1(A, n, ax, inverse):
    """numpy's transform along stored axis ax, length n; for real data, the
    half that numpy's rfft computes and its mirror image, conjugated, so the
    result is exactly conjugate-symmetric (as FFTW makes MATLAB's)"""
    if A.dtype.kind != "c" and not inverse:
        h = np.fft.rfft(A, n=n, axis=ax)
        A2 = np.moveaxis(h, ax, -1)
        full = np.zeros(A2.shape[:-1] + (n,), dtype=np.complex128)
        m = A2.shape[-1]
        full[..., :m] = A2
        # (the DC and Nyquist terms of real data are real)
        full[..., 0] = full[..., 0].real
        if n % 2 == 0:
            full[..., n // 2] = full[..., n // 2].real
        if n > 1:
            k = np.arange(m, n)
            full[..., m:] = np.conj(A2[..., n - k])
        # (a zero imaginary part is +0, as FFTW's)
        full = _cplx(full.real, np.where(full.imag == 0, 0.0, full.imag))
        return np.moveaxis(full, -1, ax)
    return np.fft.ifft(A, n=n, axis=ax) if inverse else np.fft.fft(A, n=n, axis=ax)


def _fft_call(x, args, inverse, name):
    args = list(args)
    symmetric = False
    if args and _istext(args[-1]):
        flag = _text(args[-1]).lower()
        if flag == "symmetric":
            symmetric = True
        elif flag != "nonsymmetric":
            raise _err("Invalid option.")
        args.pop()
    A = _farr(x, name)
    d = _dims(x)
    n = None if not args or _numel(args[0]) == 0 else args[0]
    dim = _default_dim(d) if len(args) < 2 else _int_arg(args[1], "dimension")
    if n is not None:
        n = _scalar(n)
        if n != _math.floor(n) or n < 0:
            raise _err("N must be a positive integer scalar.")
        n = int(n)
    if dim > A.ndim:
        # (along a trailing singleton dimension: a length-1 transform)
        A = A.reshape((1,) * (dim - A.ndim) + A.shape)
    ax = A.ndim - dim
    length = A.shape[ax] if n is None else n
    if length == 0:
        shape = list(A.shape)
        shape[ax] = 0
        return _canon(np.zeros(tuple(shape)))
    if inverse and not symmetric and A.dtype.kind == "c" and A.shape[ax] == length:
        # (MATLAB's ifft is real when X is exactly conjugate-symmetric along dim)
        B = np.moveaxis(A, ax, -1)
        k = np.arange(length)
        symmetric = bool(np.all(B == np.conj(B[..., (length - k) % length])))
    elif inverse and A.dtype.kind != "c":
        symmetric = symmetric or bool(np.all(A == np.take(A, (length - np.arange(A.shape[ax])) % A.shape[ax], axis=ax))) and A.shape[ax] == length
    if symmetric and inverse:
        # (ifft(X, 'symmetric'): the first half, as if conjugate-symmetric; real)
        r = np.fft.irfft(np.take(A, np.arange(min(A.shape[ax], length // 2 + 1)), axis=ax), n=length, axis=ax)
        return _box(_contig(r))
    r = _fft1(A, length, ax, inverse)
    if not inverse and A.dtype.kind != "c":
        r = _conj_symmetric(r, ax)
    if class_(x) == "single":
        return _canon(r.astype(np.complex64))
    return _box(_contig(r))


def _conj_symmetric(r, ax):
    """the transform of real data made exactly conjugate-symmetric along ax, its second half the
    conjugates of its first, as MATLAB's fft of real data is (ifft of it is then real, exactly)"""
    n = r.shape[ax]
    if n < 3:
        return r
    r = np.array(r, dtype=np.complex128)
    B = np.moveaxis(r, ax, -1)
    k = np.arange(n // 2 + 1, n)
    B[..., k] = np.conj(B[..., n - k])
    B[..., 0] = B[..., 0].real
    if n % 2 == 0:
        B[..., n // 2] = B[..., n // 2].real
    return np.moveaxis(B, -1, ax)


@_bs("fft")
def fft_(x, *args):
    return _fft_call(x, args, False, "fft")


@_bs("ifft")
def ifft_(x, *args):
    return _fft_call(x, args, True, "ifft")


def _fft_sizes(sizes):
    """the transform sizes as ints: each a positive integer, as the pages specify; anything
    else refused, not truncated or made empty (the sparse fft2 and others check them before
    making X full, so a large sparse X with a bad size is refused at once)"""
    if _istext(sizes):
        raise _err("Invalid number of FFT data points: a text size is not supported.")
    sz = [float(v) for v in _arr(sizes).reshape(-1)]
    for v in sz:
        # (finiteness first: floor(Inf) has no integer)
        if not (v == v and abs(v) != _math.inf and v >= 1 and v == _math.floor(v)):
            shown = ("NaN" if v != v else "Inf" if v > 0 else "-Inf") if v != v or abs(v) == _math.inf \
                else int(v) if v == _math.floor(v) else v
            raise _err("Invalid number of FFT data points (%s) specified." % shown)
    return [int(v) for v in sz]


def _fftn_call(x, sizes, inverse, name, nd=None, symmetric=False):
    """the transform in X's class: single stays single (computed in double, then rounded)"""
    r = _fftn_core(x, sizes, inverse, name, nd, symmetric)
    return _finish(_farr(r), "single") if class_(x) == "single" else r


def _fftn_core(x, sizes, inverse, name, nd=None, symmetric=False):
    """fft2, fftn and their inverses: the transform over MATLAB's first nd dimensions (all of
    them for fftn), each page beyond them apart, X padded or cut to sizes first"""
    dims = len(_dims(x)) if nd is None else nd
    sz = sizes  # (parsed and checked by _fft_parse)
    # (X made dense only after the sizes are checked: an invalid size is refused at once)
    A = _farr(x, name)
    while A.ndim < dims:
        A = A.reshape((1,) + A.shape)
    axes = [A.ndim - d for d in range(1, dims + 1)]
    ns = [A.shape[ax] if sz is None or d > len(sz) else sz[d - 1] for d, ax in enumerate(axes, 1)]
    for ax, n in zip(axes, ns):
        if n < A.shape[ax]:
            A = np.take(A, np.arange(n), axis=ax)
        elif n > A.shape[ax]:
            pad = [(0, 0)] * A.ndim
            pad[ax] = (0, n - A.shape[ax])
            A = np.pad(A, pad)
    if A.size == 0:
        return _canon(np.zeros(A.shape))
    if not inverse:
        r = np.fft.fftn(A, axes=axes)
        if A.dtype.kind != "c":
            # (the transform of real data, exactly conjugate-symmetric, as MATLAB's is)
            r = _hermitian(r, axes)
            # (a zero imaginary part is +0, as FFTW's)
            r = _cplx(r.real, np.where(r.imag == 0, 0.0, r.imag))
        return _box(_contig(r))
    if not symmetric:
        # (ifft2/ifftn of conjugate-symmetric data is real, as their pages say)
        symmetric = _is_hermitian(A, axes)
    if symmetric:
        # ('symmetric': the second half ignored, as if it were the first's conjugate)
        r = np.ascontiguousarray(np.fft.ifftn(_hermitian(A, axes), axes=axes).real)
    else:
        r = np.fft.ifftn(A, axes=axes)
    return _box(_contig(r))


def _mirror(A, axes):
    """A[-k mod n] along each of the stored axes at once"""
    for ax in axes:
        A = np.take(A, (-np.arange(A.shape[ax])) % A.shape[ax], axis=ax)
    return A


def _is_hermitian(A, axes):
    """A[k] == conj(A[-k mod n]) over the axes, in every page, exactly"""
    return bool(np.all(A == np.conj(_mirror(A, axes))))


def _hermitian(A, axes):
    """A made exactly conjugate-symmetric over the stored axes, each page apart: an element whose
    mirror (-k mod n over the axes) comes first in MATLAB's element order is that mirror's
    conjugate, an element that is its own mirror its real part. The first half is kept as it is,
    and nothing is computed, so nothing overflows."""
    T = sorted(axes)
    lead = A.ndim - len(T)
    B = np.moveaxis(np.asarray(A, dtype=np.complex128), T, list(range(lead, A.ndim)))
    tshape = B.shape[lead:]
    # (the stored order is MATLAB's transposed: C order over the stored axes is MATLAB's order)
    lin = np.arange(int(np.prod(tshape))).reshape(tshape)
    mlin = _mirror(lin, range(len(tshape)))
    mB = np.conj(_mirror(B, range(lead, B.ndim)))
    out = np.where(mlin < lin, mB, B)
    out = np.where(mlin == lin, out.real + 0j, out)
    return np.moveaxis(out, list(range(lead, A.ndim)), T)


def _fft_parse(name, rest):
    """fft2, ifft2, fftn and ifftn's arguments after X, parsed and checked as a whole: how
    many sizes (none or two scalars for fft2 and ifft2, none or one vector for fftn and
    ifftn), each size, and the inverses' flag, 'symmetric' or 'nonsymmetric', only
    last; any other text is refused rather than ignored. Returns (sizes, symmetric):
    sizes the transform sizes as ints, or None. The dense functions and the sparse forms
    both call it first, so a sparse X is made full only for a valid call, and the two
    can't disagree"""
    rest = list(rest)
    sym = False
    if name in ("ifft2", "ifftn") and rest and _istext(rest[-1]):
        flag = _text(rest[-1]).lower()
        if flag not in ("symmetric", "nonsymmetric"):
            raise _err("%s: the option '%s' is not supported." % (name, _text(rest[-1])))
        sym = flag == "symmetric"
        rest.pop()
    if len(rest) > (2 if name in ("fft2", "ifft2") else 1):
        raise _err("Too many input arguments.", "MATLAB:TooManyInputs")
    if not rest:
        return None, sym
    if name in ("fft2", "ifft2") and len(rest) == 1:
        # (the pages' forms are (X) and (X, m, n))
        raise _err("Not enough input arguments.", "MATLAB:minrhs")
    if len(rest) == 2:
        # (fft2(X, m, n): two scalars)
        m, n = (_fft_sizes(v) for v in rest)
        if len(m) != 1 or len(n) != 1:
            raise _err("%s(X, m, n): m and n must be scalars." % name)
        return m + n, sym
    return _fft_sizes(rest[0]), sym


def _fft_entry(name, inverse, nd):
    def f(x, *rest):
        sizes, sym = _fft_parse(name, rest)
        return _fftn_call(x, sizes, inverse, name, nd, sym)
    _bs(name)(f)


_fft_entry("fft2", False, 2)
_fft_entry("ifft2", True, 2)
_fft_entry("fftn", False, None)
_fft_entry("ifftn", True, None)


def _fftshift_call(x, dim, inverse):
    """the zero frequency to the middle (fftshift: each axis rolled by floor(n/2)) or back"""
    A = _arr(x)
    axes = range(A.ndim) if dim is None else [A.ndim - _int_arg(dim, "dimension")]
    r = A
    for ax in axes:
        if 0 <= ax < r.ndim:
            n = r.shape[ax]
            r = np.roll(r, -(n // 2) if inverse else n // 2, axis=ax)
    if type(x) is Char:
        return Char(_contig(r))
    return _box(_contig(r)) if r.dtype.kind in "fbc" else _canon(_contig(r))


@_bs("fftshift")
def fftshift_(x, dim=None):
    return _fftshift_call(x, dim, False)


@_bs("ifftshift")
def ifftshift_(x, dim=None):
    return _fftshift_call(x, dim, True)


@_bs("cumsum")
def cumsum_(x, *args):
    return _cum(x, args, lambda A, ax: np.cumsum(A, axis=ax), "cumsum")


@_bs("cumprod")
def cumprod_(x, *args):
    return _cum(x, args, _cumprod_axis, "cumprod")


@_bs("cummax")
def cummax_(x, *args):
    return _cum(x, args, lambda A, ax: np.maximum.accumulate(A, axis=ax), "cummax")


@_bs("cummin")
def cummin_(x, *args):
    return _cum(x, args, lambda A, ax: np.minimum.accumulate(A, axis=ax), "cummin")


@_bs("diff")
def diff_(x, n=1.0, dim=None):
    if _istext(n) or _istext(dim):
        raise _err("diff: the order and dimension must be numbers.")
    n = _int_arg(n)
    cls = class_(x)
    cls = cls if cls in _INTS or cls == "single" else "double"
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
            return _finish(np.zeros(tuple(shp)) if ax >= 0 else np.zeros((0, 0)), cls)
        # (each order's differences in the input's class, an integer class saturating as its
        # arithmetic does: diff(uint8([1 0])) is 0)
        r = _finish(_contig(np.diff(A, axis=ax)), cls)
    return r


def _minmax(nargout, args, which):
    """max/min: (x), (x, [], dim or vecdim or 'all'), (a, b); flags 'linear',
    'omitnan' (the default) and 'includenan'; [m, i] outputs"""
    big = which == "max"
    flags = [_text(a).lower() for a in args[1:] if _istext(a)]
    for fl in flags:
        if fl not in ("omitnan", "includenan", "omitmissing", "includemissing", "linear", "all"):
            raise _err("%s: the option '%s' is not supported in Sagebrush." % (which, fl))
    nums = [a for a in args[1:] if not _istext(a)]
    # (numbers come first: max(A, B), max(A, [], dim); then 'all' in dim's place, then flags)
    pos = [k for k, a in enumerate(args[1:]) if not _istext(a)]
    if pos and pos != list(range(len(pos))):
        raise _err("%s: the arrays and the dimension must come before the options." % which)
    if "all" in flags and not (len(args) >= 3 and not _istext(args[1]) and _numel(args[1]) == 0
                               and _istext(args[2]) and _text(args[2]).lower() == "all"):
        raise _err("%s: 'all' must be the third argument, after []: %s(A, [], 'all')." % (which, which))
    include = "includenan" in flags or "includemissing" in flags
    if len(args) == 2 and not _istext(args[1]) and _numel(nums[0]) == 0:
        raise _err("%s(A, []) needs a dimension: %s(A, [], dim)." % (which, which))
    if nums and _numel(nums[0]) > 0:
        if len(nums) > 1:
            raise _err("%s with two matrices to compare and a working dimension is not supported." % which.upper())
        a, b = args[0], nums[0]
        if type(a) is float and type(b) is float and not include:
            if a != a:
                return b
            if b != b:
                return a
            return (a if a >= b else b) if big else (a if a <= b else b)
        if _farr(a).dtype.kind == "c" or _farr(b).dtype.kind == "c":
            raise _err("%s of two arrays with complex values is not supported in Sagebrush." % which)
        cls = "logical" if class_(a) == "logical" and class_(b) == "logical" else _arith_class(a, b, which)
        f = (np.maximum if big else np.minimum) if include else (np.fmax if big else np.fmin)
        return _finish(_broadcast(f, _farr(a), _farr(b)), cls)
    x = args[0]
    d = _dims(x)
    dim = None
    if "all" in flags:
        dim = "all"
    elif len(nums) > 1:
        dv = nums[1]
        v = _farr(dv)
        if (v.size == 0 or v.dtype.kind == "c" or sum(1 for k in _dims(dv) if k != 1) > 1
                or not np.all(v == np.floor(v)) or not np.all(v >= 1)):
            raise _err("%s: the dimension must be a positive integer or a vector of them." % which)
        dim = sorted(set(int(k) for k in v.reshape(-1))) if v.size > 1 else _int_arg(dv)
    cls = class_(x)
    A = _farr(x, which)
    if dim is None:
        if d == (0, 0):
            e = np.zeros((0, 0))
            return e if nargout <= 1 else [e, e.copy()]
        dim = _default_dim(d)
    full = A
    if dim == "all":
        dim = list(range(1, len(d) + 1))
    if type(dim) is list:
        B, shape = _collapse(A, dim)
        # (linear indices into x: the merged axis's positions map back through an index array)
        P, _ = _collapse(np.arange(A.size, dtype=np.float64).reshape(A.shape), dim)
        A2 = B
        ax = A2.ndim - 1
    else:
        if dim > A.ndim:
            A = A.reshape((1,) * (dim - A.ndim) + A.shape)
        ax = A.ndim - dim
        A2 = A
        shape = list(A.shape)
        shape[ax] = 1
        P = None
    if A2.shape[ax] == 0:
        shp = list(A2.shape)
        shp[ax] = 0
        e = np.zeros(tuple(shp))
        return e if nargout <= 1 else [e, e.copy()]
    key = np.abs(A2) if A2.dtype.kind == "c" else A2
    nan = np.isnan(key)
    filled = np.where(nan, -np.inf if big else np.inf, key)
    idx = np.argmax(filled, axis=ax) if big else np.argmin(filled, axis=ax)
    if A2.dtype.kind == "c":
        # (complex values compare by magnitude, then by phase angle in (-pi, pi], as sort orders
        # them: of the elements tied for the extreme magnitude, the extreme angle)
        best = _take_along(filled, np.expand_dims(idx, ax), ax)
        ang = np.angle(A2)
        ang = np.where(ang == -np.pi, np.pi, ang)
        # (a NaN, filled with an infinity, is never one of the tied values)
        ang = np.where((filled == best) & ~nan, ang, -np.inf if big else np.inf)
        idx = np.argmax(ang, axis=ax) if big else np.argmin(ang, axis=ax)
    if include:
        anynan = np.any(nan, axis=ax)
        firstnan = np.argmax(nan, axis=ax)
        idx = np.where(anynan, firstnan, idx)
    idx = np.where(np.all(nan, axis=ax), 0, idx)
    vals = _take_along(A2, np.expand_dims(idx, ax), ax)
    vals = _canon(_contig(vals.reshape(shape)))
    # (logical stays logical, as in MATLAB; char gives double)
    oc = "double" if cls == "char" else cls
    m = _finish(vals, oc)
    if nargout <= 1:
        return m
    if P is not None:
        lin = _take_along(P, np.expand_dims(idx, ax), ax).reshape(shape) + 1
    elif "linear" in flags:
        # (the position along the axis, as a linear index into x)
        pos = np.arange(A2.size, dtype=np.float64).reshape(A2.shape)
        lin = _take_along(pos, np.expand_dims(idx, ax), ax).reshape(shape) + 1
    else:
        lin = (idx + 1).astype(np.float64).reshape(shape)
    return [m, _box(_canon(_contig(lin)))]


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
    method = "auto"
    placement = "auto"
    args = list(args)
    while args:
        a = args.pop(0)
        if _istext(a):
            t = _text(a).lower()
            if t in ("ascend", "descend"):
                desc = t == "descend"
            elif t == "comparisonmethod" and args:
                method = _text(args.pop(0)).lower()
                if method not in ("auto", "abs", "real"):
                    raise _err("Invalid 'ComparisonMethod' value.")
            elif t == "missingplacement" and args:
                placement = _text(args.pop(0)).lower()
            else:
                raise _err("sort: the option '%s' is not supported in Sagebrush." % _text(a))
        else:
            dim = _int_arg(a)
    # (NaN go last ascending and first descending: the other placement is not implemented)
    if placement not in ("auto", "last" if not desc else "first"):
        raise _err("sort: 'MissingPlacement', '%s' is not supported in Sagebrush." % placement)
    if method == "real" and _isnumlike(x) and _arr(x).dtype.kind == "c" and not _isvec(x):
        raise _err("sort: 'ComparisonMethod', 'real' is supported only for vectors in Sagebrush.")
    if method == "real" and _isnumlike(x) and _arr(x).dtype.kind == "c" and _isvec(x):
        vals = list(_arr(x).reshape(-1))
        order = sorted(range(len(vals)), key=lambda k: (vals[k].real, vals[k].imag), reverse=desc)
        r = _box(np.array([vals[k] for k in order]).reshape(_arr(x).shape))
        return r if nargout <= 1 else [r, _box(np.array([float(k + 1) for k in order]).reshape(_arr(x).shape))]
    if type(x) is Cell or type(x) is StrArr or type(x) is Str:
        if type(x) is Str:
            return x if nargout <= 1 else [x, 1.0]
        strs = [_text(e) if type(x) is Cell else e for e in x.a]
        d = tuple(x.shape)
        # (along a dimension, the first non-singleton by default: each column of a string matrix on
        # its own, as sort's page shows; the elements are in column-major order)
        sdim = dim if dim is not None else _default_dim(d)
        if len(d) != 2 or sdim not in (1, 2):
            raise _err("sort: Sagebrush sorts cell and string arrays of at most 2 dimensions, along dimension 1 or 2.")
        nr, nc = d
        lines = [[i + j * nr for i in range(nr)] for j in range(nc)] if sdim == 1 else [[i + j * nr for j in range(nc)] for i in range(nr)]
        new = [None] * len(strs)
        pos = [0.0] * len(strs)
        for line in lines:
            order = sorted(range(len(line)), key=lambda k: strs[line[k]], reverse=desc)
            for slot, k in zip(line, order):
                new[slot] = cp(x.a[line[k]])
                pos[slot] = float(k + 1)
        r = x._like(new, x.shape)
        if nargout <= 1:
            return r
        return [r, _box(np.array(pos).reshape(_stored(x.shape)))]
    d = _dims(x)
    if dim is None:
        dim = _default_dim(d)
    A = _arr(x)
    cls = class_(x)
    if dim > A.ndim or A.size == 0:
        return cp(x) if nargout <= 1 else [cp(x), _box(np.ones(A.shape))]
    ax = A.ndim - dim
    pre = None
    if A.dtype.kind == "c":
        # (complex numbers by magnitude, then by phase angle in (-pi, pi]: first a stable sort by
        # phase, then a stable sort by magnitude of that order)
        ph = np.angle(A)
        ph = np.where(np.isnan(ph), 0.0, np.where(ph == -np.pi, np.pi, ph))
        pre = np.argsort(-ph if desc else ph, axis=ax, kind="stable")
        A = _take_along(A, pre, axis=ax)
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
    s = _contig(_take_along(A, order, axis=ax))
    if pre is not None:
        order = _take_along(pre, order, axis=ax)
    sv = Char(s) if cls == "char" else _box(s)
    if nargout <= 1:
        return sv
    return [sv, _box(_contig((order + 1).astype(np.float64)))]


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
        d = "first" if direction is None else _text(direction).lower()
        if d not in ("first", "last"):
            raise _err('Invalid search direction. Use "first" or "last".', "MATLAB:find:InvalidDirection")
        if d == "last":
            nz = nz[nz.size - k:] if k else nz[:0]
        else:
            nz = nz[:k]
    d = _dims(x)
    row = len(d) == 2 and d[0] == 1 and d[1] != 1

    def shaped(v):
        v = v.astype(np.float64)
        if d == (1, 1) and v.size == 0:
            # (a scalar zero gives [], as for an empty x)
            return np.zeros((0, 0))
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
        out.append(_box(shaped(vals) if vals.size == 0 else vals.reshape((vals.size, 1)) if row else vals.reshape((1, vals.size))))
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
    if not args:
        raise _err("Not enough input arguments.")
    if len(args) == 1:
        # (a size vector: two or more nonnegative integers)
        v = _farr(args[0])
        if v.dtype.kind == "c" or v.size < 2 or sum(1 for k in _dims(args[0]) if k != 1) > 1 or not np.all(np.isfinite(v)) or not np.all(v == np.floor(v)) or not np.all(v >= 0):
            raise _err("Size vector must have at least two elements, each a nonnegative integer.")
        d = [int(k) for k in v.reshape(-1)]
    else:
        d = []
        free = -1
        for k, v in enumerate(args):
            if _numel(v) == 0 and not _istext(v):
                if free >= 0:
                    raise _err("Only one size input can be [].")
                free = k
                d.append(1)
            else:
                m = _int_arg(v, "size")
                if m < 0:
                    raise _err("Size arguments must be nonnegative integers.")
                d.append(m)
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
    r = _canon(_contig(np.transpose(a, axes)))
    return Char(r) if type(x) is Char else _box(r)


# (the most repmat makes: bytes of a numeric, logical or char result, whose tiling and
# copy take about three times that; elements of a cell, struct or string array, which
# are Python objects and cost more)
_REPMAT_BYTES_MAX = 8 << 20
_REPMAT_OBJECT_MAX = 200_000


@_bs("repmat")
def repmat_(x, *args):
    # (the replication factors: integers, a negative one counting as 0, as repmat's page says)
    if len(args) == 1:
        v = _farr(args[0]).reshape(-1)
        if v.dtype.kind == "c" or not np.all(np.isfinite(v)) or not np.all(v == np.floor(v)):
            raise _err("Replication factors must be a row vector of integers or integer scalars.")
        r = [int(k) for k in v]
        if len(r) == 1:
            r = [r[0], r[0]]
    else:
        r = [_int_arg(v) for v in args]
    r = [max(0, k) for k in r]
    if type(x) is Str:
        # (a string scalar as a one-element string array, so it is repeated like one)
        x = StrArr([x.s], (1, 1))
    t = type(x)
    d = list(_dims(x))
    nd = max(len(d), len(r))
    d = d + [1] * (nd - len(d))
    r = r + [1] * (nd - len(r))
    reps = tuple(reversed(r))
    # (the result's size from the factors, admitted before anything is made)
    total = 1
    for a, b in zip(d, r):
        total *= a * b
    if t in (Cell, Struct, StrArr):
        if total > _REPMAT_OBJECT_MAX:
            raise _err("repmat: a result of %d elements is not supported in Sagebrush: at most %d for a %s array." % (total, _REPMAT_OBJECT_MAX, class_(x)))
    else:
        size = _arr(x).dtype.itemsize
        if total * size > _REPMAT_BYTES_MAX:
            raise _err("repmat: a result of %d elements (%d bytes) is not supported in Sagebrush: at most %d bytes." % (total, total * size, _REPMAT_BYTES_MAX))
    if 0 in r or 0 in d:
        # (an empty result, of the input's kind and the product of the sizes)
        out_d = tuple(a * b for a, b in zip(d, r))
        if t is Cell or t is Struct or t is StrArr:
            return x._like([], out_d)
        z = np.zeros(tuple(reversed(out_d)), dtype=_arr(x).dtype)
        return Char(_canon(z)) if t is Char else _box(_canon(z))
    if t is Cell or t is Struct or t is StrArr:
        idx = np.arange(len(x.a), dtype=np.int64).reshape(tuple(reversed(d)))
        big = _canon(np.tile(idx, reps))
        return x._like([cp(x.a[int(k)]) for k in big.reshape(-1)], tuple(reversed(big.shape)))
    a = _arr(x).reshape(tuple(reversed(d)))
    out = _canon(_contig(np.tile(a, reps)))
    return Char(out) if t is Char else _box(out)


@_bs("repelem")
def repelem_(x, *args):
    """repelem as documented: repelem(v, n) repeats each element of the
    scalar or vector v n times, or v(k) n(k) times for a vector n as long as
    v (the result oriented as v, a row for a scalar); repelem(A, r1, ..., rN)
    repeats the elements of A along dimension k r_k times each, r_k a scalar
    or one count per index of that dimension"""
    if not args:
        raise _err("Not enough input arguments.")
    if type(x) is Str:
        x = StrArr([x.s], (1, 1))
    t = type(x)
    d = list(_dims(x))

    def counts(v, size):
        # (integer-valued numeric scalars or vectors, as documented: not
        # char, logical or a matrix)
        if class_(v) not in ("double", "single") and class_(v) not in _INTS:
            raise _err("Replication factors must be numeric.")
        if not (_numel(v) == 1 or _isvec(v)):
            raise _err("Replication factors must be scalars or vectors.")
        c = _farr(v).reshape(-1)
        if c.dtype.kind == "c" or not np.all(np.isfinite(c)) or np.any(c < 0) or np.any(c != np.floor(c)):
            raise _err("Replication factors must be nonnegative integers.")
        c = [int(e) for e in c]
        if len(c) == 1:
            return c * size
        if len(c) != size:
            raise _err("A vector of replication factors must have one for each element along its dimension.")
        return c
    if len(args) == 1:
        if not (_isvec(x) or _numel(x) <= 1):
            raise _err("For two input arguments, the first must be a scalar or a vector.")
        n = _numel(x)
        idx = np.repeat(np.arange(n, dtype=np.int64), counts(args[0], n))
        col = len(d) == 2 and d[1] == 1 and d[0] != 1
        shape = (idx.size, 1) if col else (1, idx.size)
    else:
        nd = max(len(d), len(args))
        d = d + [1] * (nd - len(d))
        idx = np.arange(int(np.prod(d)), dtype=np.int64).reshape(tuple(reversed(d)))
        for k in range(nd):
            idx = np.repeat(idx, counts(args[k] if k < len(args) else 1, d[k]), axis=nd - 1 - k)
        shape = tuple(reversed(idx.shape))
    flat = idx.reshape(-1)
    if t is Cell or t is Struct or t is StrArr:
        return x._like([cp(x.a[int(k)]) for k in flat], shape)
    out = _arr(x).reshape(-1)[flat].reshape(tuple(reversed(shape)))
    out = _canon(_contig(out))
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
    r = _contig(np.flip(a, axis=ax))
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
    r = _contig(r)
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
        return _finish(_contig(out.T), oc)
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
def ndgrid_(nargout, *vs):
    """[X1,...,Xn] = ndgrid(x1,...,xn): Xk varies along dimension k (one vector: used n times)"""
    if not vs:
        raise _err("Not enough input arguments.")
    if len(vs) == 1:
        vs = vs * max(2, nargout)
    vecs = [_farr(v).reshape(-1) for v in vs]
    if len(vecs) == 2:
        xv, yv = vecs
        X = np.tile(xv.reshape((-1, 1)), (1, yv.size))
        Y = np.tile(yv.reshape((1, -1)), (xv.size, 1))
        return _unmat(X) if nargout <= 1 else [_unmat(X), _unmat(Y)]
    dims = [v.size for v in vecs]
    nd = len(dims)
    shape = tuple(reversed(dims))
    out = []
    for k, v in enumerate(vecs):
        # (MATLAB's dimension k is the stored array's axis nd-1-k)
        ax = nd - 1 - k
        a = v.reshape(tuple(dims[k] if i == ax else 1 for i in range(nd)))
        out.append(_box(np.tile(a, tuple(1 if i == ax else shape[i] for i in range(nd)))))
    return out[0] if nargout <= 1 else out[:nargout]

# ---- linear algebra


def _square(M):
    if M.shape[0] != M.shape[1]:
        raise _err("Matrix must be square.", "MATLAB:square")


@_bs("inv")
def inv_(x):
    _need_float(x, "inv")
    if type(x) is complex:
        return 1.0 / x
    M = _mat(x)
    _square(M)
    if M.size > 1 and not np.all(np.isfinite(M)):
        raise _err(_NONFINITE_SOLVE % "inv")
    try:
        Mi = np.linalg.inv(M)
    except np.linalg.LinAlgError:
        # (MATLAB's: Inf throughout)
        warning_("Matrix is singular to working precision.", "MATLAB:singularMatrix")
        if M.shape == (1, 1):
            # (a zero scalar: 1/x, whose sign follows the zero's)
            return _unmat(np.full(M.shape, _math.copysign(_math.inf, float(M[0, 0].real)), dtype=M.dtype))
        return _unmat(np.full(M.shape, np.inf))
    _rcond_warning(M, Mi)
    return _unmat(Mi)


@_bs("pinv")
def pinv_(x):
    return _unmat(np.linalg.pinv(_mat(x)))


@_bs("det")
def det_(x):
    if type(x) is complex:
        return x
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
    _need_float(x, "norm")
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
    if p is not None and not _isinstance_num(p):
        raise _err("norm: p must be a real scalar: 1, 2, Inf, -Inf, a positive number or 'fro'.")
    pv = 2.0 if p is None else _scalar(p)
    if not (pv > 0 or pv == -_math.inf):
        # (the page's p: a positive real number, Inf or -Inf)
        raise _err("norm: p must be a positive real number, Inf or -Inf.")
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
    """eig as its documentation page describes it: e = eig(A), [V, D] and
    [V, D, W] (W's columns the left eigenvectors, W'*A = D*W'), eig(A, B)
    for A*V = B*V*D (and W'*A = D*W'*B), the balanceOption, the algorithm
    "chol" and the outputForm "vector" or "matrix".  Real matrices: the
    symmetric eigenproblem (tred2 and tql2) or the general one (orthes and
    hqr2), from JAMA, in Sagebrush's numpy; the general one balances A first,
    as the page's default "balance" does, and "nobalance" turns it off.  eig(A, B) with a
    symmetric A and a symmetric positive definite B is the page's "chol"
    algorithm: the symmetric problem of L^-1 A L^-T, B = L L', V B-normalized
    as the page says.  Otherwise, for lack of QZ, it is the eigenproblem of
    B \\ A.  W comes from the transposed problem, each vector matched to its
    eigenvalue; W = V for the real symmetric standard problem and on the
    Cholesky path.  Single inputs give single outputs, computed in double.

    Sagebrush's own choices: W for the standard nonsymmetric problem, and V
    and W from B \\ A, have columns of 2-norm 1 (the page leaves the
    generalized ones' norms open), while the Cholesky path has W = V with
    V'*B*V = I; "chol" is refused unless A and B are symmetric and B is
    positive definite (chol(B) succeeds), rather than falling back to
    B \\ A when it was asked for; "qz" is refused; a singular B is
    refused, since its pencil may have infinite eigenvalues, which need QZ;
    a nonsingular but badly
    conditioned B is refused too, for accuracy, by Sagebrush's rule
    cond(B)*eps > 1e-8; complex matrices are refused, Sagebrush's numpy
    having no complex eigenvalue routines yet"""
    _need_float(x, "eig")
    A = _mat(x)
    _square(A)
    B, form, algo = None, None, None
    for a in args:
        if _istext(a):
            t = _text(a).lower()
            if t in ("vector", "matrix") and form is None:
                form = t
            elif t in ("balance", "nobalance") and B is None and algo is None:
                algo = t
            elif t in ("chol", "qz") and B is not None and algo is None:
                algo = t
            else:
                raise _err("eig: invalid option '%s'." % _text(a))
        elif _isnumlike(a) and B is None and algo is None and form is None:
            B = _mat(a)
            if B.shape != A.shape:
                raise _err("eig: A and B must be square matrices of the same size.")
        else:
            raise _err("eig: invalid input.")
    if nargout > 3:
        raise _err("Too many output arguments.")
    if A.dtype.kind == "c" or (B is not None and B.dtype.kind == "c"):
        raise _err("eig: complex matrices are not supported in Sagebrush.")
    if A.size and not np.all(np.isfinite(A)) or (B is not None and B.size and not np.all(np.isfinite(B))):
        raise _err("eig: the input must not contain Inf or NaN.")
    single = class_(x) == "single" or any(_isnumlike(a) and not _istext(a) and class_(a) == "single" for a in args)
    A = A.astype(float)
    n = A.shape[0]
    W = None
    if B is None:
        if np.array_equal(A, A.T):
            w, V = np.linalg.eigh(A)
            W = V
        else:
            w, V = np.linalg._eig(A, algo != "nobalance")
    else:
        B = B.astype(float)
        if algo == "qz":
            raise _err("eig: the QZ algorithm is not supported in Sagebrush.")
        L = None
        if np.array_equal(A, A.T) and np.array_equal(B, B.T):
            try:
                L = np.linalg.cholesky(B)
            except Exception:
                L = None
        if algo == "chol" and L is None:
            raise _err("eig: the \"chol\" algorithm needs a symmetric A and a symmetric positive definite B; "
                       "Sagebrush does not fall back to another algorithm when it is asked for.")
        if L is not None:
            Li = np.linalg.inv(L)
            C = Li @ A @ Li.T
            w, Y = np.linalg.eigh((C + C.T) / 2)
            V = Li.T @ Y
            W = V
        else:
            c = np.linalg.cond(B) if n else 1.0
            if n and not _math.isfinite(c):
                raise _err("eig: B is singular, so the pencil may have infinite eigenvalues, which need the QZ "
                           "algorithm; it is not supported in Sagebrush.")
            if n and c * _EPS_D > 1e-8:
                raise _err("eig: B is badly conditioned (cond(B)*eps > 1e-8, Sagebrush's limit for solving through "
                           "B \\ A), and the QZ algorithm it needs is not supported in Sagebrush.")
            w, V = np.linalg._eig(np.linalg.solve(B, A) if n else A)
    if np.iscomplexobj(w) and not np.any(np.imag(w)):
        w = np.real(w)
        V = np.real(V)
    if nargout == 3 and W is None:
        W = _left_vectors(A, B, w, algo != "nobalance")
    def out1(a):
        r = _unmat(np.asarray(a))
        return _B["single"].f(1, r) if single else r
    if nargout <= 1:
        e = np.asarray(w).reshape((-1, 1))
        return out1(np.diag(np.asarray(w)) if form == "matrix" else e)
    D = np.asarray(w).reshape((-1, 1)) if form == "vector" else np.diag(np.asarray(w))
    out = [out1(V), out1(D)]
    if nargout == 3:
        out.append(out1(W))
    return out


_EPS_D = 2.220446049250313e-16


def _left_vectors(A, B, w, balance=True):
    """left eigenvectors: for each eigenvalue w(k), a vector u with
    u' A = w(k) u' B (B the identity when None), from the eigenvectors of
    the transposed problem A.' z = mu B.' z (u = conj(z)), each matched to
    the nearest unused mu, of 2-norm 1"""
    At = A.T if B is None else np.linalg.solve(B.T, A.T)
    mu, Z = np.linalg._eig(At, balance)
    mu, Z = np.asarray(mu), np.asarray(Z)
    used = [False] * len(mu)
    cols = []
    for lam in np.asarray(w):
        j = min((i for i in range(len(mu)) if not used[i]), key=lambda i: abs(mu[i] - lam))
        used[j] = True
        z = np.conj(Z[:, j])
        cols.append(z / np.linalg.norm(z) if np.linalg.norm(z) else z)
    U = np.array(cols).T
    if np.iscomplexobj(U) and not np.any(np.imag(U)):
        U = np.real(U)
    return U


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
def lu_(nargout, x, *args):
    """lu as documented for an m-by-n matrix, real or complex: Gaussian
    elimination with partial pivoting (the first largest magnitude in the
    column), in single precision for a single A.  As reference LAPACK's
    dgetf2 forms them, the multipliers are by the pivot's reciprocal when
    the pivot is at least the smallest normal number, and by division below
    it, where the reciprocal would overflow.  Y = lu(A) holds U and L's
    multipliers in one matrix;
    [L, U] = lu(A) has L = P'*L, so that A = L*U; [L, U, P] = lu(A) has
    P*A = L*U, and with outputForm 'vector' P is the vector with
    A(P,:) = L*U.  The sparse forms with a column permutation Q, a scaling
    D or pivoting thresholds are refused."""
    form = "matrix"
    for o in args:
        if _istext(o) and _text(o).lower() in ("vector", "matrix"):
            form = _text(o).lower()
        else:
            raise _err("lu: pivoting thresholds are not supported in Sagebrush.")
    if nargout > 3:
        raise _err("lu: the column permutation Q and the scaling D are not supported in Sagebrush.")
    A = _mat(x)
    single = class_(x) == "single"
    dt = (np.complex64 if single else np.complex128) if A.dtype.kind == "c" else (np.float32 if single else np.float64)
    # (the smallest normal number of the precision: LAPACK's sfmin)
    sfmin = 1.1754943508222875e-38 if single else 2.2250738585072014e-308
    m, n = A.shape
    k = min(m, n)
    U = np.array(A, dtype=dt)
    L = np.zeros((m, k), dtype=dt)
    perm = list(range(m))
    for j in range(k):
        p = int(np.argmax(np.abs(U[j:, j]))) + j
        if p != j:
            U[[j, p], :] = U[[p, j], :]
            L[[j, p], :j] = L[[p, j], :j]
            perm[j], perm[p] = perm[p], perm[j]
        L[j, j] = 1.0
        if U[j, j] != 0:
            recip = abs(U[j, j]) >= sfmin
            r = (np.ones(1, dtype=dt) / U[j, j])[0] if recip else None
            for i in range(j + 1, m):
                L[i, j] = U[i, j] * r if recip else U[i, j] / U[j, j]
                U[i, j + 1:] = U[i, j + 1:] - L[i, j] * U[j, j + 1:]
                U[i, j] = 0.0
    U = U[:k, :]
    if nargout <= 1:
        Y = np.zeros((m, n), dtype=dt)
        Y[:k, :] = U
        for j in range(k):
            Y[j + 1:, j] = L[j + 1:, j]
        return _unmat(Y)
    P = np.eye(m)[perm, :]
    if nargout == 2:
        # (P'*L, by moving L's rows: exact, and in L's precision)
        PL = np.zeros_like(L)
        PL[perm, :] = L
        return [_unmat(PL), _unmat(U)]
    Pout = _box(np.array([float(i + 1) for i in perm]).reshape((m, 1))) if form == "vector" else _unmat(P)
    return [_unmat(L), _unmat(U), Pout]


def _qr_econ_flag(v):
    """qr's economy flag: the scalar 0 itself (a complex scalar is zero only
    with both its parts zero, so qr(S, 2i) has the right side 2i)"""
    if _istext(v) or _numel(v) != 1:
        return False
    z = _farr(v).reshape(-1)[0]
    return complex(z) == 0


@_bi("qr")
def qr_(nargout, x, *args):
    """qr as documented: R = qr(A), [Q, R] = qr(A) with A = Q*R, "econ" (or
    0) for the first n columns of Q and rows of R when m > n, and
    [C, R] = qr(S, B) with C = Q'*B, from which X = R\\C solves S*X = B in
    the least-squares sense.  The column permutation P is refused."""
    args = list(args)
    B = None
    if args and not _istext(args[0]) and not _qr_econ_flag(args[0]):
        B = args.pop(0)
    econ = False
    for o in args:
        if _istext(o) and _text(o).lower() == "econ":
            econ = True
        elif _istext(o) and _text(o).lower() in ("vector", "matrix"):
            # (the form of the permutation P, which is refused)
            raise _err("qr: the outputForm argument needs the column permutation P, which is not supported in Sagebrush.")
        elif _qr_econ_flag(o):
            econ = True
        else:
            raise _err("qr: the option is not supported in Sagebrush.")
    if nargout >= 3:
        raise _err("qr: the column permutation P is not supported in Sagebrush.")
    M = _mat(x)
    Q, R = np.linalg.qr(M, mode="reduced" if econ else "complete")
    if B is not None:
        Bm = _mat(B)
        if Bm.shape[0] != M.shape[0]:
            raise _err("A and B must have the same number of rows.")
        if nargout < 2:
            raise _err("qr(S, B) returns C and R: call it with two outputs.")
        return [_unmat(np.conj(Q.T) @ Bm), _unmat(R)]
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


@_bi("polyval")
def polyval_(nargout, p, x, S=None, mu=None):
    """polyval(p, x), and polyval(p, x, [], mu) at (x - mu(1))/mu(2) as its page says; the error
    estimate delta is not computed"""
    if nargout >= 2:
        raise _err("[y, delta] = polyval(...): the error estimate delta is not supported in Sagebrush.")
    if sum(1 for k in _dims(p) if k != 1) > 1:
        raise _err("polyval: p must be a vector of coefficients.")
    for v in (p, x):
        if class_(v) not in ("double", "single", "logical"):
            raise _err("polyval of %s input is not supported; it takes double or single values." % class_(v))
    c = _farr(p).reshape(-1)
    X = _farr(x)
    cls = _float_class(p, x)
    xs = class_(x) == "single"
    if cls == "single" and c.size * X.size > _SINGLE_STEPS_WORK:
        raise _err("polyval of a single polynomial with %d coefficients at %d points is not supported "
                   "in Sagebrush: too much work." % (c.size, X.size))
    if mu is not None:
        m = _farr(mu).reshape(-1)
        if m.size != 2:
            raise _err("polyval: centerScale must be a two-element vector.")
        if cls == "single":
            # ((x - mu(1)) / mu(2), each step single when an operand is)
            ms = class_(mu) == "single"
            X = X - m[0]
            if xs or ms:
                X = _single_values(X)
            X = X / m[1]
            xs = xs or ms
            if xs:
                X = _single_values(X)
        else:
            X = (X - m[0]) / m[1]
    cplx = X.dtype.kind == "c" or c.dtype.kind == "c"
    y = np.zeros(X.shape, dtype=np.complex128 if cplx else np.float64)
    if cls == "single":
        # (single arithmetic at each step of Horner's rule, each step as the operators compute it:
        # single by single in single, an operand that is double used at its own value and the
        # step's result made single, so polyval of singles is the single Horner sum)
        ps = class_(p) == "single"
        if c.size:
            y = y + c[0]
            for a in c[1:]:
                y = _single_values(_mul(y, X, ps and xs))
                y = _single_values(y + a)
                ps = True
        return _finish(y, "single")
    if c.size:
        # (Horner's rule from the leading coefficient: polyval([1 0 -1], Inf) is Inf)
        y = y + c[0]
        for a in c[1:]:
            y = y * X + a
    return _finish(y, cls)


@_bi("polyfit")
def polyfit_(nargout, x, y, n, *opts):
    """p (highest power first); [p,S]: S.R, S.df, S.normr; [p,S,mu]: fitted on (x - mu(1))/mu(2),
    with Normalize=true (the default with three outputs), mu = [0 1] with Normalize=false"""
    _need_float(x, "polyfit")
    _need_float(y, "polyfit")
    xv = _farr(x).reshape(-1)
    yv = _farr(y).reshape(-1)
    n = _int_arg(n)
    if n < 0:
        raise _err("polyfit: the degree n must be a nonnegative integer.")
    normalize = nargout >= 3
    if len(opts) % 2:
        raise _err("polyfit: name-value arguments must come in pairs.")
    for k in range(0, len(opts), 2):
        if not (_istext(opts[k]) and _text(opts[k]).lower() == "normalize"):
            raise _err("polyfit: the option %s is not supported in Sagebrush." % (_text(opts[k]) if _istext(opts[k]) else "given"))
        normalize = _flag_arg(opts[k + 1], "Normalize")
    mu = None
    if nargout >= 3 and not normalize:
        mu = (0.0, 1.0)
    if normalize:
        m = float(np.mean(xv))
        sd = float(np.sqrt(np.sum((xv - m) ** 2) / max(1, xv.size - 1)))
        mu = (m, sd)
        xv = (xv - m) / sd
    if n + 1 > xv.size:
        # (MATLAB warns that the polynomial is not unique and returns one of them; which one is not
        # documented, so it is refused)
        raise _err("polyfit with degree n of at least the number of points is not supported in Sagebrush: the polynomial is not unique.")
    V = np.array([[xi ** (n - k) for k in range(n + 1)] for xi in xv]).reshape((xv.size, n + 1))
    Q, R = np.linalg.qr(V)
    p = np.linalg.solve(R, Q.T @ yv)
    # (single x or y gives single p and S.normr; S.R, the factor of the Vandermonde matrix of x,
    # and mu are single when x is: MathWorks' polyfit page takes single data; Sagebrush computes
    # in double and rounds once, as its eig does)
    single = "single" in (class_(x), class_(y))
    xsingle = class_(x) == "single"
    P = _finish(_contig(p.reshape((-1, 1))), "single" if single else "double")
    if nargout <= 1:
        return P
    r = yv - V @ p
    normr = float(np.sqrt(np.sum(r * r)))
    S = _struct1({"R": _finish(_farr(_unmat(np.array(R))), "single") if xsingle else _unmat(np.array(R)),
                  "df": float(max(0, xv.size - (n + 1))),
                  "normr": _finish(np.array([[normr]]), "single") if single else normr})
    out = [P, S]
    if mu is not None:
        M = np.array([mu[0], mu[1]]).reshape((1, 2))
        out.append(_finish(M, "single") if xsingle else _box(M))
    return out[:nargout]


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
        r = np.linalg._eigvals(C)
        # (the trailing zeros are removed, so the constant term is not 0 and 0 is not a root:
        # an eigenvalue of exactly 0 is one the eigensolver lost)
        if np.any(np.asarray(r) == 0):
            raise _err("roots: a root of this polynomial could not be computed accurately in "
                       "Sagebrush (its coefficients are too widely scaled).")
    r = np.concatenate([r, np.zeros(trailing)])
    if r.size == 0:
        # (a column with no roots, 0-by-1: MathWorks' roots page returns the roots as a column)
        return _unmat(np.zeros((0, 1)))
    return _unmat(r.reshape((-1, 1)))


@_bs("poly")
def poly_(r):
    v = _farr(r).reshape(-1)
    if not _isvec(r) and _numel(r) > 1:
        v = np.linalg._eigvals(_mat(r))
    c = np.array([1.0 + 0j])
    for z in v:
        c = np.concatenate([c, [0]]) - z * np.concatenate([[0], c])
    if not np.any(np.imag(c)):
        c = np.real(c)
    return _box(_contig(c.reshape((-1, 1))))


@_bs("conv")
def conv_(a, b, shape=None):
    A = _farr(a).reshape(-1)
    B = _farr(b).reshape(-1)
    if _float_class(a, b) == "single" and A.size and B.size:
        # (in single at each step: each output sums its products from the last of a's to the
        # first, as a filter by a does; a product or sum is single when an operand is)
        if A.size * B.size > _SINGLE_STEPS_WORK:
            raise _err("conv of single vectors of %d and %d elements is not supported in Sagebrush: "
                       "too much work." % (A.size, B.size))
        both = class_(a) == "single" and class_(b) == "single"
        cplx = A.dtype.kind == "c" or B.dtype.kind == "c"
        r = np.zeros(A.size + B.size - 1, dtype=np.complex128 if cplx else np.float64)
        # (over the shorter vector: b's terms first to last add each output's products in the
        # same order as a's terms last to first)
        if B.size <= A.size:
            for j in range(B.size):
                prod = _single_values(_mul(A, B[j:j + 1], both))
                r[j:j + A.size] = _single_values(r[j:j + A.size] + prod)
        else:
            for i in range(A.size - 1, -1, -1):
                prod = _single_values(_mul(A[i:i + 1], B, both))
                r[i:i + B.size] = _single_values(r[i:i + B.size] + prod)
    else:
        r = np.convolve(A, B) if A.size and B.size else np.zeros(max(A.size + B.size - 1, 0))
    s = "full" if shape is None else (_text(shape).lower() if _istext(shape) else None)
    if s == "same":
        st = B.size // 2
        r = r[st:st + A.size]
    elif s == "valid":
        r = r[B.size - 1:A.size] if A.size >= B.size else np.zeros(0)
    elif s != "full":
        raise _err("SHAPE must be 'full', 'same', or 'valid'.")
    col = _dims(a)[1] == 1 and _dims(a)[0] > 1
    return _finish(_contig(r.reshape((1, -1)) if col else r.reshape((-1, 1))), _float_class(a, b))


# (the most multiply-adds one xcorr may do, lengths times lags, and the most lags)
_XCORR_WORK = 20_000_000
_XCORR_LAGS_MAX = 1_000_000


@_bi("xcorr")
def xcorr_(nargout, x, *args):
    """xcorr as its page describes for vectors: r(m) = sum over n of x(n+m) conj(y(n)), the
    shorter vector padded with zeros, at lags -maxlag..maxlag (N - 1 by default, N the
    longer length), with scaleopt 'none', 'biased' (r/N), 'unbiased' (r/(N - |m|)) or
    'normalized' (or 'coeff': r over the zero-lag autocorrelations' geometric mean, so an
    autocorrelation is 1 at lag 0); [r, lags] gives the lags too. r is oriented as x"""
    args = list(args)
    scale = "none"
    if args and _istext(args[-1]):
        scale = _text(args.pop()).lower()
        scale = {"coeff": "normalized"}.get(scale, scale)
        if scale not in ("none", "biased", "unbiased", "normalized"):
            raise _err("xcorr: scaleopt must be 'none', 'biased', 'unbiased' or 'normalized'.")
    y = None
    maxlag = None
    if args and _numel(args[0]) > 1 or (args and len(args) == 2):
        y = args.pop(0)
    if args:
        maxlag = _int_arg(args.pop(0), "maximum lag")
        if maxlag < 0:
            raise _err("xcorr: the maximum lag must be a nonnegative integer.")
    if args:
        raise _err("xcorr: too many input arguments.")
    for v in (x, y):
        if v is None:
            continue
        c = class_(v)
        if c not in ("double", "single", "logical"):
            raise _err("xcorr of %s input is not supported; it takes double or single vectors." % c)
        d = _dims(v)
        if len(d) > 2 or (d[0] > 1 and d[1] > 1):
            raise _err("xcorr of a matrix (the correlations of all its columns) is not supported in Sagebrush; give it vectors.")
    X = _farr(x).reshape(-1).astype(np.complex128 if _farr(x).dtype.kind == "c" else np.float64)
    Y = X if y is None else _farr(y).reshape(-1)
    if Y.dtype.kind == "c" and X.dtype.kind != "c":
        X = X.astype(np.complex128)
    N = max(X.size, Y.size)
    if scale != "none" and y is not None and X.size != Y.size:
        raise _err("xcorr: with scaleopt '%s', x and y must have the same length." % scale)
    if N == 0:
        raise _err("xcorr of empty vectors is not supported in Sagebrush.")
    L = N - 1 if maxlag is None else maxlag
    if 2 * L + 1 > _XCORR_LAGS_MAX:
        raise _err("xcorr at %d lags is not supported in Sagebrush: at most %d." % (2 * L + 1, _XCORR_LAGS_MAX))
    if N * (2 * min(L, N) + 1) > _XCORR_WORK:
        raise _err("xcorr of vectors of %d elements is not supported in Sagebrush: too much work." % N)
    Xp = np.concatenate([X, np.zeros(N - X.size, dtype=X.dtype)])
    Yp = np.concatenate([Y, np.zeros(N - Y.size, dtype=Y.dtype)])
    if scale == "normalized":
        # (normalized: x and y each scaled by its largest magnitude first, so that the
        # scale cancels exactly and the energies can't overflow or underflow)
        sx = float(np.max(np.abs(Xp)))
        sy = float(np.max(np.abs(Yp)))
        if sx == 0 or sy == 0 or not (_math.isfinite(sx) and _math.isfinite(sy)):
            raise _err("xcorr: 'normalized' needs vectors that are finite and not all zero.")
        Xp = Xp / sx
        Yp = Yp / sy
    cplx = Xp.dtype.kind == "c" or Yp.dtype.kind == "c"
    out = np.zeros(2 * L + 1, dtype=np.complex128 if cplx else np.float64)
    for j, m in enumerate(range(-L, L + 1)):
        if abs(m) >= N:
            continue
        if m >= 0:
            s_ = np.sum(Xp[m:] * np.conj(Yp[:N - m]))
        else:
            s_ = np.sum(Xp[:N + m] * np.conj(Yp[-m:]))
        out[j] = s_
    if scale == "biased":
        out = out / N
    elif scale == "unbiased":
        lags_abs = np.abs(np.arange(-L, L + 1))
        out = np.where(lags_abs < N, out / np.maximum(N - lags_abs, 1), 0)
    elif scale == "normalized":
        out = out / _math.sqrt(float(np.sum(np.abs(Xp) ** 2)) * float(np.sum(np.abs(Yp) ** 2)))
    if out.dtype.kind == "c" and not np.any(out.imag):
        out = out.real
    cls = "single" if "single" in (class_(x), class_(y) if y is not None else "double") else "double"
    col = _dims(x)[1] == 1 and _dims(x)[0] > 1
    r = _finish(out.reshape((1, -1)) if col else out.reshape((-1, 1)), cls)
    lags = _box(np.arange(-L, L + 1, dtype=np.float64).reshape((-1, 1)))
    return [r, lags] if nargout >= 2 else r


@_bi("deconv")
def deconv_(nargout, y, h, *args):
    """deconv as documented: [x, r] = deconv(y, h) by polynomial long
    division, with y = conv(x, h) + r; with Method="least-squares" (and a
    shape, "full", "same" or "valid", of the convolution y holds) the x that
    minimizes norm(r)^2 + norm(alpha*x)^2 for RegularizationFactor alpha
    (default 0), and of those the one of least norm.  x and r are oriented
    as y, single if y or h is; for the full convolution with h longer than
    y, x = 0 and r = y."""
    args = list(args)
    shape = "full"
    if args and _istext(args[0]) and _text(args[0]).lower() in ("full", "same", "valid"):
        shape = _text(args.pop(0)).lower()
    if len(args) % 2:
        raise _err("Name-value arguments must come in pairs.")
    method, alpha = "long-division", 0.0
    for k in range(0, len(args), 2):
        name = _text(args[k]).lower() if _istext(args[k]) else None
        if name == "method":
            method = _text(args[k + 1]).lower() if _istext(args[k + 1]) else None
            if method not in ("long-division", "least-squares"):
                raise _err("Method must be \"long-division\" or \"least-squares\".")
        elif name == "regularizationfactor":
            v = args[k + 1]
            # (one real number, double or single, as documented)
            if class_(v) not in ("double", "single") or _numel(v) != 1 or not isreal_(v):
                raise _err("RegularizationFactor must be a real number.")
            alpha = _scalar(v)
        else:
            raise _err("deconv: the option '%s' is not supported." % (_text(args[k]) if name else "?"))
    if method == "long-division" and shape != "full":
        raise _err("The shape must be \"full\" when Method is \"long-division\".")
    if method == "long-division" and alpha != 0:
        raise _err("RegularizationFactor must be 0 when Method is \"long-division\".")
    cls = "single" if "single" in (class_(y), class_(h)) else "double"
    Y = _farr(y).reshape(-1)
    H = _farr(h).reshape(-1)
    cplx = Y.dtype.kind == "c" or H.dtype.kind == "c"
    dt = np.complex128 if cplx else np.float64
    Y, H = Y.astype(dt), H.astype(dt)
    # (MathWorks' deconv page gives no results for Inf or NaN coefficients, and long division
    # spreads them in ways no rule fixes: refused, as the solves are)
    if not (np.all(np.isfinite(Y)) and np.all(np.isfinite(H))):
        raise _err("deconv of values that include Inf or NaN is not supported in Sagebrush: its result "
                   "for them is not certified. Divide finite values.")
    col = _dims(y)[1] == 1 and _dims(y)[0] > 1

    def orient(v):
        v = np.array(v, dtype=dt)
        return _finish(v.reshape((1, -1)) if col else v.reshape((-1, 1)), cls)
    if shape == "full" and H.size > Y.size:
        out = [orient([0.0]), orient(Y)]
    elif method == "long-division":
        if H.size == 0 or H[0] == 0:
            raise _err("First coefficient of h must be non-zero.")
        q = []
        r = list(Y)
        for k in range(len(Y) - len(H) + 1):
            c = r[k] / H[0]
            q.append(c)
            for j in range(len(H)):
                r[k + j] -= c * H[j]
        out = [orient(q), orient(r)]
    elif H.size == 0:
        # (as documented, with an empty h a "valid" y is as long as x, and so is
        # a "same" one: the convolution is 0, so x = 0 and r = y; a full
        # convolution with an empty h has no defined length)
        if shape == "full":
            raise _err("h must not be empty for the \"full\" shape.")
        out = [orient(np.zeros(Y.size)), orient(Y)]
    else:
        nh = H.size
        nx = {"full": Y.size - nh + 1, "same": Y.size, "valid": Y.size + nh - 1}[shape]
        # (the convolution's matrix: column j is conv(e_j, h), then the rows the shape keeps)
        F = np.zeros((nx + nh - 1, nx), dtype=dt)
        for j in range(nx):
            F[j:j + nh, j] = H
        if shape == "same":
            F = F[nh // 2:nh // 2 + nx, :]
        elif shape == "valid":
            F = F[nh - 1:nx, :]
        M, rhs = F, Y
        if alpha != 0:
            M = np.concatenate([F, alpha * np.eye(nx, dtype=dt)], axis=0)
            rhs = np.concatenate([Y, np.zeros(nx, dtype=dt)])
        # (the least-squares solution of least norm, by the SVD)
        x = np.linalg.lstsq(M, rhs, rcond=None)[0]
        out = [orient(x), orient(Y - F @ x)]
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
    _write(_strip_links(_disp_text(x)))
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


_SPEC = _re.compile(r"%(?:(?P<pos>[1-9]\d*)\$)?(?P<flags>[-+ 0#]*)(?P<width>\*|\d+)?(?:\.(?P<prec>\*|\d+))?(?P<conv>[diouxXfFeEgGcsbt]|l[diouxX]|h[diouxX])")


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
            # (a % that begins no conversion of the formatting page's: refused, not printed)
            raise _err("Invalid format: '%s' is not a conversion Sagebrush supports." % f[i:i + 3].rstrip())
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
            # (the formatting page: numeric conversions print only the real part)
            items.append(a.real)
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


def _char_code(x):
    """the character of an integer code under %s or %c; a value that is no character code is refused"""
    if not 0 <= x <= 65535:
        raise _err("A text conversion (%%s or %%c) of %d, which is not a character code, is not supported in Sagebrush." % x)
    return chr(int(x))


def _is_code(item):
    """whether a format item is a number that %s prints as a character (an integer code)"""
    if type(item) is str:
        return False
    x = float(item)
    return _math.isfinite(x) and x == _math.floor(x) and 0 <= x <= 65535


def _conv(m, item, width, prec):
    conv = m.group("conv")[-1]
    if conv in "bt":
        raise _err("The %%b and %%t conversion subtypes are not supported in Sagebrush.")
    if conv in "diuoxXcfFeEgG" and type(item) is str:
        return None  # (expanded by the caller: a text's character codes under a numeric conversion)
    if conv == "s":
        if type(item) is str:
            return _pyspec(m, "s", width, prec) % item
        # (a number with %s, as the formatting page says: a character code as its character,
        # and a non-integer, which a text conversion doesn't fit, as %e)
        x = float(item)
        if not _math.isfinite(x):
            return _nonfinite(x, m, width)
        if x == _math.floor(x):
            return _pyspec(m, "s", width, prec) % _char_code(x)
        return _pyspec(m, "s", width, prec) % ("%e" % x)
    if conv == "c":
        x = item
        if type(x) is str:
            return x
        x = float(x)
        if not _math.isfinite(x):
            return _nonfinite(x, m, width)
        if x != _math.floor(x):
            return _pyspec(m, "s", width, None) % ("%e" % x)
        return _pyspec(m, "s", width, None) % _char_code(x)
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
    items = []
    # (the input argument each item comes from: one %s takes successive codes of one argument only)
    owner = []
    for j, a in enumerate(args):
        its = _fmt_items([a])
        items.extend(its)
        owner.extend([j] * len(its))
    specs = [s for s in segs if type(s) is not str]
    if not specs:
        return "".join(segs)
    out = []
    k = 0
    if any(s.group("pos") for s in specs):
        # (identifiers, n$: each operator formats input argument n, a scalar or a text, once through
        # the format, as the formatting operators' description gives: ('%3$s %2$s %1$s %2$s','A','B','C')
        # is 'C B A B')
        for s in segs:
            if type(s) is str:
                out.append(s)
                continue
            if not s.group("pos"):
                raise _err("Invalid format: an operator with an identifier (n$) cannot be mixed with one without.")
            j = int(s.group("pos")) - 1
            if j >= len(args):
                continue
            if _numel(args[j]) > 1 and not _istext(args[j]):
                raise _err("Invalid format: with an identifier (n$), the input argument must be a scalar or a text, not an array.")
            item = _fmt_items([args[j]])
            if not item:
                continue
            r = _conv(s, item[0], None, None)
            if r is None:
                r = "".join(_conv(s, float(ord(c)), None, None) for c in item[0])
            out.append(r)
        return "".join(out)
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
            if s.group("conv") == "s" and _is_code(item):
                # (one %s prints successive character codes, as long as they are codes)
                j = k
                while j < len(items) and owner[j] == owner[k] and _is_code(items[j]):
                    j += 1
                out.append(_pyspec(s, "s", width, prec) % "".join(chr(int(float(v))) for v in items[k:j]))
                k = j
                consumed = True
                continue
            r = _conv(s, item, width, prec)
            if r is None:
                # a string with a numeric conversion: its characters, one by one
                codes = [float(ord(c)) for c in item]
                items[k:k + 1] = codes
                owner[k:k + 1] = [owner[k]] * len(codes)
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
    if type(fmt) is Str:
        return Str(_sprintf(fmt.s, args))
    if not _istext(fmt):
        raise _err("sprintf: the format must be text.")
    r = _sprintf(_text(fmt), args)
    # (nothing written: a 1-by-0 character vector, as sprintf gives)
    return Char(r) if r else Char(np.zeros((0, 1)))


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
        _write(_strip_links(s))
    elif fid == 2:
        _write_err(s)
    else:
        h = _files.get(fid)
        if h is None:
            raise _err("Invalid file identifier.  Use fopen to generate a valid file identifier.", "MATLAB:FileIO:InvalidFid")
        h.fh.write(s)
    # (the number of bytes written)
    return float(len(s.encode("utf-8"))) if nargout >= 1 else NOVAL


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
        rows = [_sprintf(_text(f), [_box(_contig(M[i:i + 1, :].T))]) for i in range(M.shape[0])]
        # (num2str trims leading blanks, even with a field width)
        return _pad_rows(_trim_common(rows))
    prec = _int_arg(f) if f is not None else None
    if prec is not None and prec < 1:
        raise _err("num2str: the precision must be a positive integer.")
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
    logical = True
    for r in rows:
        parts = [p for p in _re.split(r"[,\s]+", r.strip()) if p]
        row = []
        for p in parts:
            v = _parse_number(p)
            if v is None:
                if p.lower() in ("true", "false"):
                    v = 1.0 if p.lower() == "true" else 0.0
                else:
                    # (str2num evaluates its text: an expression, 2+3, is 5 in MATLAB; only
                    # numbers and true/false are read here, so anything else is refused
                    # rather than given as [])
                    raise _err("str2num of '%s' is not supported in Sagebrush: only numbers and true/false are read." % t[:40])
            else:
                logical = False
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
        if logical:
            # (true and false only: a logical array, as MATLAB's evaluation gives)
            out = _box(_arr(out).astype(bool)) if type(out) is not float else bool(out)
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
    for a in args:
        if not (_istext(a) or type(a) in (Char, Cell, StrArr)):
            raise _err("strcat of a %s is not supported; its inputs are character arrays, cell arrays of character vectors or string arrays." % class_(a))
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
        # (element by element, scalars expanded; a character vector's trailing whitespace removed,
        # a string's kept, as strcat's page says)
        parts, shape = [], None
        for a in args:
            if type(a) is StrArr:
                if shape is not None and tuple(a.shape) != shape:
                    raise _err("strcat: the string arrays must be the same size.")
                shape = tuple(a.shape)
                parts.append(list(a.a))
            elif type(a) is Str:
                parts.append([a.s])
            elif type(a) is Char and _dims(a)[0] <= 1:
                parts.append([a.text().rstrip(" \t\n\r\f\v\x00")])
            else:
                raise _err("strcat of a string array and a %s is not supported in Sagebrush." % class_(a))
        n = _prod(shape) if shape is not None else 1
        out = []
        for k in range(n):
            vs = [p[k] if len(p) > 1 else p[0] for p in parts]
            out.append(None if None in vs else "".join(vs))
        return _strarr(out, shape if shape is not None else (1, 1))
    if any(type(a) is Char and _dims(a)[0] > 1 for a in args):
        # (character matrices: each row concatenated with the others' same row; MATLAB
        # strips trailing whitespace, which would leave rows of different lengths, so a
        # row ending in whitespace, or a different row count, is refused)
        rows = [a.rows() if type(a) is Char else None for a in args]
        if any(r is None for r in rows) or len({len(r) for r in rows}) != 1:
            raise _err("strcat: character arrays must have the same number of rows.")
        ws = " \t\n\r\f\v\x00"
        if any(r and r[-1] in ws for rs in rows for r in rs):
            raise _err("strcat: rows of a character array that end in whitespace are not supported.")
        return _pad_rows(["".join(rs[i] for rs in rows) for i in range(len(rows[0]))])
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
                # (a character matrix against a cell or string array: its rows, as a
                # column, exactly as stored, padding blanks included, as MATLAB does)
                rows = v.rows()
                return rows, (len(rows), 1)
            return [v.text()], None
        if type(v) is Str:
            return [v.s], None
        return [None], None
    multi = [type(v) is Char and _dims(v)[0] > 1 for v in (a, b)]
    if any(multi):
        if type(a) is Char and type(b) is Char:
            # (two character arrays: compared whole, as before; a prefix of a matrix is refused)
            if not same_size:
                raise _err("Comparing the first characters of a character matrix is not supported.")
            return _dims(a) == _dims(b) and f(a.text(), b.text())
        other = b if multi[0] else a
        if type(other) is not Cell and type(other) is not StrArr:
            raise _err("Comparing a character matrix with this argument is not supported.")
    A, sa = items(a)
    B, sb = items(b)
    if sa is None and sb is None:
        if same_size and type(a) is Char and type(b) is Char and _dims(a) != _dims(b) and not (_numel(a) == 0 and _numel(b) == 0):
            return False
        return A[0] is not None and B[0] is not None and f(A[0], B[0])
    # (a text scalar, or a one-element cell or string array, against each element of the
    # other; else both the same size)
    def key(d):
        d = [int(x) for x in d]
        while len(d) > 2 and d[-1] == 1:
            d.pop()
        return tuple(d)
    one_a, one_b = sa is None or len(A) == 1, sb is None or len(B) == 1
    if not one_a and not one_b and key(sa) != key(sb):
        raise _err("Inputs must be the same size or either one can be a scalar.")
    if one_a and not one_b:
        A, shape = A * len(B), sb
    elif one_b and not one_a:
        B, shape = B * len(A), sa
    else:
        shape = sa if sa is not None else sb
    return _box(np.array([x is not None and y is not None and f(x, y) for x, y in zip(A, B)], dtype=bool).reshape(_stored(shape)))


@_bs("strcmp")
def strcmp_(a, b):
    return _cmp_text(a, b, lambda x, y: x == y, True)


@_bs("strcmpi")
def strcmpi_(a, b):
    return _cmp_text(a, b, lambda x, y: x.lower() == y.lower(), True)


@_bs("strncmp")
def strncmp_(a, b, n):
    # (the first n characters, or as many as there are: equal text shorter than n is
    # equal; a negative n counts as zero, as MATLAB's page says)
    k = max(0, _int_arg(n))
    return _cmp_text(a, b, lambda x, y: x[:k] == y[:k])


@_bs("strncmpi")
def strncmpi_(a, b, n):
    k = max(0, _int_arg(n))
    return _cmp_text(a, b, lambda x, y: x[:k].lower() == y[:k].lower())


# (the characters text functions may build in one call, their outputs together: past it,
# refused before anything is built)
_TEXT_MAX = 10_000_000


def _text_admit(n, what):
    if n > _TEXT_MAX:
        raise _err("%s would build %d characters, beyond Sagebrush's limit of %d." % (what, n, _TEXT_MAX))


def _strrep_text(t, o, nw, budget=None):
    """strrep's replacement, which counts overlapping matches, as its page shows: every place
    where old starts gives one copy of new, and the characters of a match are dropped (strrep of
    '222' with '22' -> '*' is '**', where replace and regexprep give '*2'). The result's length
    is counted against budget (a one-element list of characters left) before it is built"""
    if not o:
        return t
    budget = budget if budget is not None else [_TEXT_MAX]
    # (a quick lower bound first: the non-overlapping matches alone, each giving a copy of new)
    if t.count(o) * len(nw) > budget[0]:
        _text_admit(_TEXT_MAX - budget[0] + t.count(o) * len(nw), "strrep")
    starts = set()
    k = t.find(o)
    while k >= 0:
        starts.add(k)
        k = t.find(o, k + 1)
    if starts:
        # (its exact length: a copy of new per start, and the characters no match covers)
        kept, covered = 0, -1
        for i in sorted(starts):
            kept += max(0, i - covered - 1)
            covered = max(covered, i + len(o) - 1)
        size = len(starts) * len(nw) + kept + (len(t) - covered - 1)
        if size > budget[0]:
            _text_admit(_TEXT_MAX - budget[0] + size, "strrep")
        budget[0] -= size
    out = []
    covered = -1
    for i, c in enumerate(t):
        if i in starts:
            out.append(nw)
            covered = max(covered, i + len(o) - 1)
        elif i > covered:
            out.append(c)
    return "".join(out)


@_bs("strrep")
def strrep_(s, old, new):
    for a in (s, old, new):
        if not (_istext(a) or type(a) in (Char, Cell, StrArr)):
            raise _err("strrep of a %s is not supported; its inputs are text." % class_(a))
        if type(a) is Cell and not all(type(e) is Char for e in a.a):
            raise _err("strrep: a cell input must hold character vectors.")
    if type(old) is not Cell and type(new) is not Cell and type(old) is not StrArr and type(new) is not StrArr:
        o = _text(old)
        nw = _text(new)
        return _textlike_map(s, lambda t: _strrep_text(t, o, nw))
    # (OLD or NEW an array: each element of STR with the corresponding OLD and NEW, a
    # scalar going with every element; the page asks for "compatible sizes" without
    # saying more, so only scalars and equal sizes are taken, and only cells of
    # character vectors, the form its example shows)
    args = (s, old, new)
    if any(type(a) is StrArr or type(a) is Str for a in args):
        raise _err("strrep: string arrays with array-valued OLD or NEW are not supported.")
    if any(type(a) is Char and _dims(a)[0] > 1 for a in args):
        raise _err("strrep: character matrices with array-valued OLD or NEW are not supported.")
    arrays = [a for a in args if type(a) is Cell and len(a.a) != 1]
    shape = arrays[0].shape if arrays else next(a.shape for a in args if type(a) is Cell)
    if any(_text_size_key(a.shape) != _text_size_key(shape) for a in arrays):
        raise _err("strrep: STR, OLD and NEW must be the same size or scalars.")
    n = _prod(shape)
    # (the texts read, all elements together, admitted from their sizes before any is
    # converted; then the results, each counted before it is built, against one budget)
    _text_admit(_numel(s) * n if type(s) is not Cell else sum(_numel(e) for e in s.a) * (n if len(s.a) == 1 else 1), "strrep")
    fixed = {id(a): _text(a) for a in args if type(a) is not Cell}  # (a scalar text, converted once)
    def item(a, k):
        if type(a) is Cell:
            e = a.a[k if len(a.a) != 1 else 0]
            if type(e) is not Char or _dims(e)[0] > 1:
                raise _err("strrep: cell arrays must contain character vectors.")
            return e.text()
        return fixed[id(a)]
    budget = [_TEXT_MAX]
    out = []
    for k in range(n):
        t, o, nw = item(s, k), item(old, k), item(new, k)
        out.append(Char(_strrep_text(t, o, nw, budget)))
    return Cell(out, shape)


def _text_size_key(d):
    """a size without trailing singleton dimensions past the second, to compare sizes"""
    d = [int(x) for x in d]
    while len(d) > 2 and d[-1] == 1:
        d.pop()
    return tuple(d)


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
    # (a row; [], 0-by-0, when there is no match, as strfind's page says)
    return _box(np.array(idx).reshape((len(idx), 1))) if idx else np.zeros((0, 0))


@_bs("strsplit")
def strsplit_(s, *args):
    t = _text(s)
    delims = None
    collapse = True
    rest = list(args)
    if rest and not (_istext(rest[0]) and _text(rest[0]).lower() in ("collapsedelimiters", "delimitertype")):
        d = rest.pop(0)
        delims = [_text(e) for e in d.a] if type(d) is Cell else [_text(d)]
    # (its page's options, CollapseDelimiters and DelimiterType; another is refused)
    if len(rest) % 2:
        raise _err("strsplit: options must come in name-value pairs.")
    while rest:
        name = rest.pop(0)
        k = _text(name).lower() if _istext(name) else None
        v = rest.pop(0)
        if k == "collapsedelimiters":
            collapse = _flag_arg(v, "CollapseDelimiters")
        elif k == "delimitertype" and _istext(v) and _text(v).lower() == "simple":
            pass
        elif k == "delimitertype" and _istext(v) and _text(v).lower() == "regularexpression":
            # (a regular expression's matching has no bound on its work in Sagebrush: refused,
            # with regexp's 'split' for the cases a caller accepts that for)
            raise _err("strsplit: 'DelimiterType', 'RegularExpression' is not supported in Sagebrush; use regexp(str, expression, 'split').")
        else:
            raise _err("strsplit: the option '%s' is not supported." % (k if k is not None else "?"))
    if delims is None:
        delims = [" ", "\f", "\n", "\r", "\t", "\v"]
    else:
        delims = [_escapes(e) for e in delims]
        if any(d == "" for d in delims):
            raise _err("strsplit: an empty delimiter is not supported.")
    pat = "|".join(_re.escape(d) for d in sorted(delims, key=len, reverse=True))
    if collapse:
        pat = "(?:%s)+" % pat
    parts = _re.split(pat, t)
    return Cell([Char(p) for p in parts], (1, len(parts)))


@_bs("strjoin")
def strjoin_(c, delim=None):
    """strjoin(C, delimiter), as its page says: a character delimiter with its escape sequences, or
    one fewer delimiters than C (a cell or string array), as literal text; a string scalar of a
    string array C"""
    if type(c) is Cell:
        items = [_text(e) for e in c.a]
    elif type(c) in (Str, StrArr):
        items = _strings_of(c)
        if None in items:
            raise _err("strjoin of a string array with missing elements is not supported in Sagebrush.")
    else:
        raise _err("strjoin: the first input must be a cell array of character vectors or a string array.")
    if type(delim) is Cell or type(delim) is StrArr:
        ds = [_text(e) for e in delim.a] if type(delim) is Cell else list(delim.a)
        if len(ds) != max(len(items) - 1, 0):
            raise _err("strjoin: the delimiter must have one fewer element than C.")
        out = "".join(x + d for x, d in zip(items, ds + [""]))
    else:
        out = (_escapes(_text(delim)) if delim is not None else " ").join(items)
    return Str(out) if type(c) in (Str, StrArr) else Char(out)


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
        if type(s) is Cell or type(s) is StrArr:
            return Cell([g(1, Char(_text(e)) if type(e) is not str else Char(e)) for e in s.a], s.shape)
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
    # (numbers are Unicode code points, as isstrprop's page describes: isstrprop([77 65], 'alpha') is true)
    if type(s) not in (Char, Str, StrArr, Cell) and _isnumlike(s) and not islogical_(s):
        s = Char(np.array(_farr(s), dtype=np.float64))
    return _char_pred(f)(1, s)


def _group_names(p, freespacing=False):
    """[(group number, name)] of a MATLAB pattern's named capturing groups, in order: a name may
    appear more than once, in different alternatives ('(?<day>\\d+)-...|...(?<day>\\d+)').
    Comments are skipped: (?#...), and with freespacing (the compiled flags: the option or any
    inline flag group containing x, such as (?ix)) a
    # to the end of the line"""
    out = []
    i, n, k = 0, len(p), 0
    while i < n:
        c = p[i]
        if c == "\\":
            i += 2
            continue
        if p.startswith("(?#", i):
            e = p.find(")", i)
            i = n if e < 0 else e + 1
            continue
        if p.startswith("(?x)", i):
            freespacing = True
            i += 4
            continue
        if freespacing and c == "#":
            e = p.find("\n", i)
            i = n if e < 0 else e + 1
            continue
        if c == "[":
            j = i + 1
            if j < n and p[j] == "^":
                j += 1
            if j < n and p[j] == "]":
                j += 1
            while j < n and p[j] != "]":
                j += 2 if p[j] == "\\" else 1
            i = j + 1
            continue
        if c == "(":
            if p.startswith("(?<", i) or p.startswith("(?P<", i):
                j = i + (3 if p[i + 2] == "<" else 4)
                if j < n and p[j] not in "=!":
                    e = p.find(">", j)
                    k += 1
                    out.append((k, p[j:e]))
            elif not p.startswith("(?", i):
                k += 1
        i += 1
    return out


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
        elif t != "matchcase":
            # ('preservecase', 'emptymatch', a match number and the rest change the result:
            # refused rather than ignored)
            raise _err("regexprep: the option '%s' is not supported in Sagebrush." % _text(o))
    if "${" in _text(rep) or "(??@" in _text(pat) or "(?@" in _text(pat):
        # (dynamic expressions run MATLAB code on each match: not supported, and not left as text)
        raise _err("regexprep: dynamic expressions ($" + "{...}, (??@...), (?@...)) are not supported in Sagebrush.")
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


def _regexp_row(e):
    """a text or expression of regexp's cell forms as a character vector; a character matrix
    is outside its page's character-vector inputs, so it is refused rather than its rows joined"""
    if type(e) is Char and _dims(e)[0] > 1:
        raise _err("regexp: character matrices are not supported; use a cell array of character vectors.")
    return Char(_text(e))


# (the slots a regexp call may use, its matches times their groups and outputs; a call
# over the elements of a cell array shares one budget, _RX_BUDGET, between them)
_MATCH_SLOTS = 200_000
_RX_BUDGET = [None]


def _regexp(nargout, s, pat, opts, flags):
    if type(pat) is StrArr or (type(pat) is Cell and (type(s) is StrArr or type(s) is Str)):
        # (string arrays of expressions give string outputs whose exact forms the page
        # doesn't spell out: refused rather than guessed)
        raise _err("regexp: string arrays of expressions are not supported; use a cell array of character vectors.")
    if type(pat) is Cell:
        # (a cell array of expressions: each with STR, or with STR's corresponding
        # element when both are cell arrays, which must then have the same dimensions)
        # (each expression searches its text: the texts searched, together, admitted from their
        # sizes before any is converted)
        if type(s) is Cell:
            if _text_size_key(s.shape) != _text_size_key(pat.shape):
                raise _err("regexp: STR and EXPRESSION must have the same dimensions when both are arrays.")
            _text_admit(sum(_numel(e) for e in s.a), "regexp with a cell array of expressions (the texts searched)")
        else:
            _text_admit(_numel(s) * len(pat.a), "regexp with a cell array of expressions (the texts searched)")
        pats = [_regexp_row(e) for e in pat.a]
        if type(s) is Cell:
            strs = [_regexp_row(e) for e in s.a]
        else:
            strs = [_regexp_row(s)] * len(pats)
        per = [_regexp(max(1, nargout), t, p, opts, flags) for t, p in zip(strs, pats)]
        if nargout <= 1:
            return Cell(per, pat.shape)
        return [Cell([q[k] for q in per], pat.shape) for k in range(nargout)]
    if type(s) is Cell or type(s) is StrArr:
        # (each element: a cell of results; the elements share one match budget)
        owner = _RX_BUDGET[0] is None
        if owner:
            _RX_BUDGET[0] = _MATCH_SLOTS
        try:
            per = [_regexp(max(1, nargout), Char(_text(e)) if type(e) is not str else Char(e), pat, opts, flags) for e in s.a]
        finally:
            if owner:
                _RX_BUDGET[0] = None
        if nargout <= 1:
            return Cell(per, s.shape)
        return [Cell([p[k] for p in per], s.shape) for k in range(nargout)]
    t = _text(s)
    once = False
    force_cell = False
    empty_ok = False
    wanted = []
    # (the options of regexp's page: '.' matches newlines by default (dotall), zero-length
    # matches are left out by default (noemptymatch))
    flags |= _re.DOTALL
    for o in opts:
        k = _text(o).lower()
        if k == "once":
            once = True
        elif k == "ignorecase":
            flags |= _re.IGNORECASE
        elif k == "matchcase":
            flags &= ~_re.IGNORECASE
        elif k == "dotexceptnewline":
            flags &= ~_re.DOTALL
        elif k == "dotall":
            flags |= _re.DOTALL
        elif k == "lineanchors":
            flags |= _re.MULTILINE
        elif k == "stringanchors":
            flags &= ~_re.MULTILINE
        elif k == "freespacing":
            flags |= _re.VERBOSE
        elif k == "literalspacing":
            flags &= ~_re.VERBOSE
        elif k == "emptymatch":
            empty_ok = True
        elif k == "noemptymatch":
            empty_ok = False
        elif k in ("warnings", "nowarnings"):
            pass
        elif k == "forcecelloutput":
            force_cell = True
        elif k in ("start", "end", "tokenextents", "match", "tokens", "names", "split"):
            wanted.append(k)
        else:
            raise _err("regexp: the option '%s' is not supported in Sagebrush." % _text(o))
    if not wanted:
        wanted = ["start", "end", "tokenextents", "match", "tokens", "names", "split"]
    rx = _re.compile(_regex(_text(pat)), flags)
    # (the matches kept, and per match the outputs asked for, admitted as they are found:
    # each match holds its groups, start and end a number each, match and split a char
    # array, tokens, tokenExtents and names one entry per group; past _MATCH_SLOTS the call
    # is refused rather than run out of memory. 'once' stops at the first)
    ms = []
    g = rx.groups
    cost = {"start": 1, "end": 1, "match": 2, "split": 2, "tokens": 1 + g, "tokenextents": 1 + g, "names": 1 + g}
    slots = (g + 1) + sum(cost[w] for w in wanted[:max(1, nargout)])

    def stepwise():
        # (one match at a time, for an input that could pass the limit: the runtime's
        # finditer may find them all before the first is seen)
        pos = 0
        while pos <= len(t):
            m = rx.search(t, pos)
            if m is None:
                return
            yield m
            pos = m.end() + 1 if m.end() == m.start() else m.end()

    for m in (stepwise() if (len(t) + 1) * slots > _MATCH_SLOTS else rx.finditer(t)):
        if empty_ok or m.end() > m.start():
            ms.append(m)
            if once:
                break
            if len(ms) * slots > (_RX_BUDGET[0] if _RX_BUDGET[0] is not None else _MATCH_SLOTS):
                raise _err("regexp: more than %d matches are not supported in Sagebrush for this pattern (%d groups) and these %d outputs." % (_MATCH_SLOTS // slots, rx.groups, min(len(wanted), max(1, nargout))))
    if _RX_BUDGET[0] is not None:
        _RX_BUDGET[0] -= len(ms) * slots

    def row(vals):
        return Cell(vals, (1, len(vals)))

    # (MATLAB's pages don't say what a pattern without capturing groups gives as tokens,
    # so that is refused rather than guessed; nor where an unmatched group's extent goes)
    def no_groups(w):
        if rx.groups == 0:
            raise _err("regexp: '%s' of a pattern without capturing groups is not supported." % ("tokenExtents" if w == "tokenextents" else w))

    def tokens(m):
        return row([Char(x if x is not None else "") for x in m.groups()])

    def extents(m):
        n = rx.groups
        e = np.zeros((2, n))
        for i in range(n):
            if m.start(i + 1) < 0:
                raise _err("regexp: 'tokenExtents' of a token that did not match is not supported.")
            e[0, i], e[1, i] = m.start(i + 1) + 1, m.end(i + 1)
        return e
    out = []
    for w in wanted[:max(1, nargout)]:
        if w in ("tokens", "tokenextents"):
            no_groups(w)
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
                # (a 1-by-n structure array, one element per match, as regexp's page says; 'once' one.
                # The fields in the order the names first appear; a name used in several
                # alternatives takes the group that took part in the match)
                groups = _group_names(_text(pat), bool(rx.flags & _re.VERBOSE))
                # (each name's groups found once, so a match costs O(groups); the fields built,
                # matches times names, admitted first)
                cands = {}
                for g, x in groups:
                    if g <= rx.groups:
                        cands.setdefault(x, []).append(g)
                names = list(dict.fromkeys(nm for _, nm in groups))
                fields = (1 if once else len(ms)) * len(names)
                if fields > _CS_MAX:
                    raise _err("regexp 'names' would build %d fields (%d matches, %d names), beyond Sagebrush's limit of %d." % (fields, len(ms), len(names), _CS_MAX))
                def value(m, nm):
                    for g in cands.get(nm, ()):
                        v = m.group(g)
                        if v is not None:
                            return v
                    return ""
                items = [{k: Char(value(m, k)) for k in names} for m in (ms[:1] if once else ms)]
                out.append(_struct1(items[0]) if once or len(items) == 1 else Struct(items, (1, len(items)), names))
            elif not ms:
                # (no match: a 0-by-0 structure array, with the expression's names as fields)
                names = list(dict.fromkeys(nm for _, nm in _group_names(_text(pat), bool(rx.flags & _re.VERBOSE)))) if rx.groupindex else []
                out.append(Struct([], (0, 0), names))
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
            out.append((extents(ms[0]) if ms else np.zeros((2, 0))) if once else row([extents(m) for m in ms]))
    if force_cell:
        # ('forceCellOutput': each output a scalar cell)
        out = [Cell([v], (1, 1)) for v in out]
    if nargout <= 1:
        return out[0]
    return out[:nargout]


# ---- cells and structs


@_bs("cell")
def cell_(*args):
    if any(_istext(a) for a in args):
        raise _err("cell takes sizes only: a text argument is not supported.")
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
    # (isfield's page: false when S is not a structure, whatever FIELD is; a name that is no
    # text is no field)
    if type(s) is not Struct:
        return False
    if type(name) is Cell:
        return _box(np.array([type(e) in (Char, Str) and _text(e) in s.fields for e in name.a], dtype=bool).reshape(_stored(name.shape)))
    if not _istext(name):
        return False
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
    # (field names: a cell array of them, a string array, a char matrix's rows, or one name)
    names = ([_text(e) for e in fields.a] if type(fields) is Cell else [e for e in fields.a] if type(fields) is StrArr
             else [r.rstrip() for r in fields.rows()] if type(fields) is Char and _dims(fields)[0] > 1 else [_text(fields)])
    if type(c) is not Cell:
        raise _err("cell2struct: CELLARRAY must be a cell array.")
    dm = _int_arg(dim, "dimension") if dim is not None else 1
    d = list(c.shape)
    # (a dimension past the cell array's: refused rather than guessed)
    if dm < 1 or dm > len(d):
        raise _err("cell2struct: DIM must be a valid dimension of the cell array.")
    if d[dm - 1] != len(names):
        raise _err("cell2struct: number of FIELDS does not match dimension")
    # the cells along dimension dm are one structure's fields; the structure array has
    # the cell array's other dimensions (a single one as a column)
    # (column-major strides: structure j's other subscripts, then field i along dm)
    strides = [_prod(d[:k]) for k in range(len(d))]
    other = [k for k in range(len(d)) if k != dm - 1]
    rest = [d[k] for k in other]
    items = []
    for j in range(_prod(rest)):
        base, q = 0, j
        for k in other:
            base += (q % d[k]) * strides[k]
            q //= d[k]
        items.append({names[i]: cp(c.a[base + i * strides[dm - 1]]) for i in range(len(names))})
    shape = rest + [1] if len(rest) == 1 else rest
    while len(shape) > 2 and shape[-1] == 1:
        shape.pop()
    return Struct(items, tuple(shape), names)


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
                uniform = _flag_arg(args[i + 1], "UniformOutput")
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


def _str_cells(v):
    """a string array as a cell array of its elements' character vectors"""
    items = _strings_of(v)
    if None in items:
        raise _err("cellfun of a string array with missing elements is not supported in Sagebrush.")
    return Cell([Char(x) for x in items], v.shape if type(v) is StrArr else (1, 1))


@_bi("cellfun")
def cellfun_(nargout, f, *args):
    arrays, uniform, handler = _uniform_opts(args)
    # (a string array: each element as though it were a character vector, as cellfun's page says)
    arrays = [_str_cells(a) if type(a) in (Str, StrArr) else a for a in arrays]
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
        if _size_key(a.shape) != _size_key(shape):
            raise _err("All of the input arguments must be of the same size and shape.")
    return _apply_each(nargout, fh, arrays, uniform, handler, lambda k: [a.a[k] for a in arrays], shape)


def _size_key(d):
    """a size without trailing singleton dimensions past the second, to compare sizes"""
    d = [int(x) for x in d]
    while len(d) > 2 and d[-1] == 1:
        d.pop()
    return tuple(d)


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
        if _size_key(_dims(a)) != _size_key(shape):
            raise _err("All of the input arguments must be of the same size and shape.")
    return _apply_each(nargout, fh, arrays, uniform, handler, lambda k: [_element(a, k) for a in arrays], shape)


@_bi("structfun")
def structfun_(nargout, f, s, *args):
    _, uniform, handler = _uniform_opts(args)
    fh = _fn_arg(f)
    # (MATLAB's structfun takes one structure: a structure array is refused, not read
    # at its first element)
    if type(s) is not Struct or _numel(s) != 1:
        raise _err("structfun: S must be a scalar structure.")
    vals = [s.a[0][n] for n in s.fields]
    r = _apply_each(nargout, fh, [], uniform, handler, lambda k: [vals[k]], (len(vals), 1))
    if not uniform:
        # (each output a structure with S's fields)
        outs = [r] if nargout <= 1 else r
        sts = [_struct1({n: o.a[k] for k, n in enumerate(s.fields)}) for o in outs]
        return sts[0] if nargout <= 1 else sts
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
        # (a character vector compares with a string as the string of its text: isequal("foo",'foo') is true)
        if ta is Char and len(_dims(a)) == 2 and _dims(a)[0] <= 1:
            a, ta = Str(_text(a)), Str
        if tb is Char and len(_dims(b)) == 2 and _dims(b)[0] <= 1:
            b, tb = Str(_text(b)), Str
        try:
            sa = _strings_of(a) if ta is not Cell else None
            sb = _strings_of(b) if tb is not Cell else None
        except MatlabError:
            return False
        return _dims(a) == _dims(b) and sa == sb
    if _iscallable(a) or _iscallable(b) or isinstance(a, HandleObj) or isinstance(b, HandleObj):
        return a is b
    if not (_isnumlike(a) and _isnumlike(b)):
        return False
    if _dims(a) != _dims(b):
        return False
    # (a single is compared as the double it exactly is)
    A = _farr(a)
    B = _farr(b)
    if nan_equal:
        # (isequaln compares numeric values part by part, a NaN equal to a NaN in the same part:
        # complex(1, NaN) equals complex(1, NaN), and a real value's imaginary part is 0)
        same = lambda X, Y: (X == Y) | (np.isnan(X) & np.isnan(Y))
        return bool(np.all(same(np.real(A), np.real(B)) & same(np.imag(A), np.imag(B))))
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
    raise _using(MatlabError(msg, ident))


def _warn_struct(items):
    """the warning states [(identifier, state)] as warning's structure array, n-by-1"""
    return Struct([{"identifier": Char(i), "state": Char(st)} for i, st in items], (len(items), 1), ["identifier", "state"])


def _warn_states():
    return [("all", _warn_all[0])] + list(_warn_ids.items())


def _warn_show():
    """warning with no arguments: the states, as warning's page shows them"""
    if not _warn_ids:
        _write('All warnings have the state "%s".\n' % _warn_all[0])
        return
    _write('The default warning state is "%s". Warnings not set to the default are\n\n' % _warn_all[0])
    _write("State  Warning Identifier\n\n")
    for i, st in _warn_ids.items():
        _write("%7s  %s\n" % (st, i))
    _write("\n")


def _warn_mode(mode, st):
    """set a display mode. Sagebrush's warnings have no stack trace, so either backtrace state shows
    the same text; the verbose mode's extra line is not implemented, so it is refused"""
    if mode == "verbose" and st == "on":
        raise _err("warning: the \"verbose\" display mode is not supported in Sagebrush.")
    _warn_modes[mode] = st


def _warn_set(st):
    for e in st.a:
        i, v = _text(e.get("identifier", Char(""))), _text(e.get("state", Char("on"))).lower()
        if i == "all":
            _warn_all[0] = v
            _warn_ids.clear()
            if v == "on":
                _warn_once.clear()
        elif i.lower() in _warn_modes:
            _warn_mode(i.lower(), v)
        elif i:
            _warn_ids[i] = v
            if v == "on":
                _warn_once.pop(i, None)


@_bi("warning")
def warning_b(nargout, *args):
    # (warning states: warning(state), warning(state, id), s = warning, warning(s); "error" is not supported)
    if not args:
        if nargout >= 1:
            return _warn_struct(_warn_states())
        _warn_show()
        return NOVAL
    if len(args) == 1 and type(args[0]) is Struct:
        _warn_set(args[0])
        return NOVAL
    if _istext(args[0]) and _text(args[0]).lower() in ("on", "off", "query"):
        st = _text(args[0]).lower()
        ident = _text(args[1]) if len(args) > 1 else "all"
        if ident.lower() in _warn_modes:
            mode = ident.lower()
            prev = Struct([{"identifier": Char(mode), "state": Char(_warn_modes[mode])}], (1, 1), ["identifier", "state"])
            if st == "query" and nargout < 1:
                raise _err("warning: displaying the %s mode's state is not supported in Sagebrush; "
                           "s = warning('query', '%s') returns it." % (mode, mode))
            if st != "query":
                _warn_mode(mode, st)
            return prev if nargout >= 1 else NOVAL
        prev = _warn_struct(_warn_states() if ident == "all" else [(ident, _warn_ids.get(ident, _warn_all[0]))])
        if st == "query":
            if nargout >= 1:
                return prev
            if ident == "all":
                _warn_show()
            else:
                _write('The state of warning \'%s\' is \'%s\'.\n' % (ident, _warn_ids.get(ident, _warn_all[0])))
            return NOVAL
        if ident == "all":
            _warn_all[0] = st
            _warn_ids.clear()
            if st == "on":
                _warn_once.clear()
        else:
            _warn_ids[ident] = st
            if st == "on":
                _warn_once.pop(ident, None)
        return prev if nargout >= 1 else NOVAL
    if _istext(args[0]) and _text(args[0]).lower() == "error":
        raise _err("warning: the \"error\" state (warnings as errors) is not supported in Sagebrush.")
    ident, msg = _error_args(args)
    if msg:
        warning_(msg, ident)
    return NOVAL


@_bi("lastwarn")
def lastwarn_(nargout, *args):
    """[msg, id] = lastwarn; lastwarn(msg) and lastwarn(msg, id) set them"""
    out = [Char(_lastwarn[0]), Char(_lastwarn[1])]
    if args:
        _lastwarn[0] = _text(args[0])
        _lastwarn[1] = _text(args[1]) if len(args) > 1 else ""
    return out if nargout > 1 else out[0]


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
    words = [_text(a).lower() for a in args]
    k = 0
    while k < len(words):
        s = words[k]
        # (the older two-word forms: format long g, format short e)
        if s in ("short", "long") and k + 1 < len(words) and words[k + 1] in ("g", "e", "eng"):
            k += 1
            s += words[k]
        if s in ("compact", "loose"):
            _format["spacing"] = s
        elif s == "default":
            _format["num"] = "short"
            _format["spacing"] = "loose"
        elif s in _FORMAT_NAMES:
            _format["num"] = _FORMAT_NAMES[s]
        elif s in ("shorteng", "longeng"):
            raise _err("format %s is not supported in Sagebrush." % ("shortEng" if s == "shorteng" else "longEng"))
        else:
            raise _err("Invalid format option '%s'." % _text(args[k]))
        k += 1
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
    """functions that see the caller's variables; one that gives no value where one is
    asked for (x = save) is MATLAB's error"""
    r = _ws_call(name, ns, args, nargout)
    if nargout == 1 and r is NOVAL:
        raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
    return r


def _ws_call(name, ns, args, nargout):
    if name in ("clear", "clearvars"):
        tokens = [_text(a) for a in args]
        if "__name__" not in ns:
            # (a function's locals() is a copy, which can't delete its variables: the
            # compiler handles clear in functions; anything reaching here is refused)
            raise _err("This form of %s inside a function is not supported." % name)
        if name == "clear" and tokens in (["all"], ["-all"]) and "all" not in _ws_vars(ns):
            _globals.clear()
            _persistents.clear()
        if name == "clear" and tokens == ["global"] and "global" not in _ws_vars(ns):
            _globals.clear()
            return NOVAL
        for v in clear_select(name, tokens, _ws_vars(ns)):
            key = "_k_" + v if v in _PYKW else v
            if key in ns:
                try:
                    del ns[key]
                except Exception:
                    ns[key] = Undef(v)
        return NOVAL
    if name == "exist":
        if not args:
            raise _err("Not enough input arguments.", "MATLAB:minrhs")
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
        want = [_text(a) for a in args if not _text(a).startswith("-")]
        if want:
            chosen = set(_glob_select(want, vs))
            vs = [v for v in vs if v in chosen]
        if name == "who":
            if nargout >= 1:
                return Cell([Char(v) for v in vs], (len(vs), 1))
            if vs:
                _write("\nYour variables are:\n\n" + "  ".join(vs) + "  \n\n")
            return NOVAL
        vals = [(v, ns["_k_" + v if v in _PYKW else v]) for v in vs]
        if nargout >= 1:
            return Struct([{"name": Char(v), "size": _box(np.array([float(x) for x in _dims(x)]).reshape((-1, 1))),
                            "bytes": float(_bytes(x)), "class": Char(class_(x))} for v, x in vals], (len(vals), 1),
                          ["name", "size", "bytes", "class"])
        if vals:
            w = max(4, max(len(v) for v in vs))
            # (the size column as wide as the widest size, 14 at least)
            sw = max([14] + [len("x".join(str(d) for d in _dims(x))) + 1 for v, x in vals])
            lines = ["  %s      %sBytes  Class     Attributes" % ("Name".ljust(w), "Size".ljust(sw + 2)), ""]
            for v, x in vals:
                size = "x".join(str(d) for d in _dims(x)).ljust(sw)
                attrs = ", ".join(a for a, on in (("sparse", type(x) is Sparse), ("complex", _isnumlike(x) and not _sp.isreal(x))) if on)
                lines.append(("  %s      %-14s%7d  %-10s%s" % (v.ljust(w), size, _bytes(x), class_(x), attrs)).rstrip() if attrs else
                             "  %s      %-14s%7d  %-10s" % (v.ljust(w), size, _bytes(x), class_(x)))
            _write("\n".join(lines) + "\n\n")
        return NOVAL
    if name in ("load", "save"):
        return _matfile(name, ns, args, nargout)
    raise _undefined(name)


_PYKW = set(("False None True and as assert async await break class continue def del elif else except finally for from global "
             "if import in is lambda nonlocal not or pass raise return try while with yield match case type globals locals print exec").split())


def _matfile_unused(name, ns, args, nargout):
    pass



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
    """magic squares by the classical constructions: de la Loubere's
    (siamese) method for odd n, from the middle of the top row stepping up
    and to the right, wrapping, and down one where a cell is taken; for n a
    multiple of 4, 1..n^2 in rows with each cell on the diagonals of its 4-by-4
    block replaced by n^2 + 1 - itself; for other even n, Strachey's method
    (W. W. Rouse Ball, "Mathematical Recreations and Essays"): an odd square
    A of order p = n/2 in quadrants [A, A + 2p^2; A + 3p^2, A + p^2], then
    the leftmost k = (n-2)/4 columns exchanged between the top and bottom
    halves (in the middle row, the k columns from the second), and the
    rightmost k - 1 columns too"""
    n = _int_arg(n)
    if n < 1:
        return np.zeros((0, 0))
    if n == 2:
        return _unmat(np.array([[4.0, 3.0], [1.0, 2.0]]))
    M = np.zeros((n, n))
    if n % 2 == 1:
        i, j = 0, n // 2
        for v in range(1, n * n + 1):
            M[i, j] = v
            ni, nj = (i - 1) % n, (j + 1) % n
            if M[ni, nj]:
                ni, nj = (i + 1) % n, j
            i, j = ni, nj
        return _unmat(M)
    if n % 4 == 0:
        for i in range(n):
            for j in range(n):
                v = i * n + j + 1
                on_diagonal = (i % 4 == j % 4) or (i % 4 + j % 4 == 3)
                M[i, j] = n * n + 1 - v if on_diagonal else v
        return _unmat(M)
    p = n // 2
    A = _mat(magic_(float(p)))
    M[:p, :p] = A
    M[p:, p:] = A + p * p
    M[:p, p:] = A + 2 * p * p
    M[p:, :p] = A + 3 * p * p
    k = (n - 2) // 4
    for i in range(p):
        cols = list(range(1, k + 1)) if i == p // 2 else list(range(k))
        cols += list(range(n - k + 1, n))
        for j in cols:
            M[i, j], M[i + p, j] = M[i + p, j], M[i, j]
    return _unmat(M)


# ------------------------------------------------------------------ arguments blocks (function argument validation)

# Vocabulary used by the generated function prologue:
#   pos: one-based positional index, or a canonical name-value option name.
#   cls: declared MATLAB class, not the Python storage type. Numeric classes
#        include complex-valued arrays; realness is a separate validator.
#   dims: requested MATLAB dimensions (storage axes are reversed); None in a
#         dimension is a wildcard, while dims=None disables the size check.
#   NOVAL: successful validator with no MATLAB output, not a truth value.
# Binding keeps name-value pairs in order. Class conversion precedes size
# conversion; validate() then wraps only MatlabError from a validator call.


def split_nv(a, npos, names):
    """Split positional arguments and canonical, ordered name-value pairs.

    A known textual name starts the pairs only if a following value exists.
    Otherwise positional scanning continues up to len(a) or npos. Matching is
    case-insensitive; duplicate names remain here and nv_get uses the last.
    """
    lower_names = [name.lower() for name in names]
    positional_count = 0
    while (positional_count < len(a) and positional_count < npos and not (
            _istext(a[positional_count]) and
            _text(a[positional_count]).lower() in lower_names and
            positional_count + 1 < len(a))):
        positional_count += 1
    positional = tuple(a[:positional_count])
    remaining = a[positional_count:]
    if len(remaining) % 2:
        raise _err("Invalid argument list. Check for wrong number of positional arguments or placement of positional arguments after name-value arguments.", "MATLAB:TooManyInputs")
    pairs = []
    for index in range(0, len(remaining), 2):
        name = remaining[index]
        if not _istext(name):
            raise _err("Invalid argument list. Check for wrong number of positional arguments or placement of positional arguments after name-value arguments.")
        text = _text(name)
        if text.lower() not in lower_names:
            raise _err("Invalid name-value argument '%s'. Valid names are: %s." % (text, ", ".join("'%s'" % name for name in names)), "")
        pairs.append((names[lower_names.index(text.lower())], remaining[index + 1]))
    return positional, pairs


def nv_has(pairs, name):
    return any(pair_name == name for pair_name, _ in pairs)


def nv_get(pairs, name):
    """Copy the last matching option value; split_nv already canonicalized names."""
    value = None
    for pair_name, pair_value in pairs:
        if pair_name == name:
            value = pair_value
    return cp(value)


def _arg_prefix(pos):
    if type(pos) is str:
        return "Invalid name-value argument '%s'. " % pos
    return "Invalid argument at position %d. " % pos


def _numeric_class(c):
    return c in _INTS or c in ("double", "single")


def arg_check(v, dims, cls, pos):
    """Convert class first, then size; matching classes/sizes need no conversion."""
    if cls:
        v = _convert_argument_class(v, cls, pos)
    if dims is not None:
        v = _convert_argument_size(v, dims, pos)
    return v


def _convert_argument_class(value, declared_class, position):
    """Apply the argument declaration's admission rule before general conversion.

    In particular, numeric/logical declarations accept numeric, logical and char
    sources, not string sources, even where _convert itself could parse strings.
    A matching class skips conversion. Only MatlabError is replaced with the
    prefixed type error; unrelated exceptions keep propagating.
    """
    source_class = class_(value)
    if source_class != declared_class:
        convertible = True
        try:
            if declared_class in ("double", "single", "logical") or declared_class in _INTS:
                if not (_numeric_class(source_class) or source_class in ("logical", "char")):
                    convertible = False
                else:
                    value = _convert(value, declared_class)
            elif declared_class == "char":
                if source_class == "string":
                    value = Char(_text(value)) if type(value) is Str else char_(value)
                elif _numeric_class(source_class):
                    value = char_(value)
                else:
                    convertible = False
            elif declared_class == "string":
                if source_class in ("char", "cell") or _numeric_class(source_class) or source_class == "logical":
                    value = string_(value)
                else:
                    convertible = False
            elif declared_class in ("cell", "struct", "function_handle"):
                convertible = False
            # Other declarations (enumerations/objects) are not checked here.
        except MatlabError:
            convertible = False
        if not convertible:
            raise _using(_arg_prefix(position) + "Value must be of type %s or be convertible to %s." % (declared_class, declared_class))
    return value


def _convert_argument_size(value, declared_dims, position):
    """Keep matching shapes; otherwise try scalar expansion, then vector reshape.

    Compare trailing-one-padded MATLAB dimensions, treating None as a wildcard.
    Expansion and reshape are reached only on mismatch. Their errors remain
    outside the class-conversion error handler.
    """
    actual_dims = list(_dims(value))
    requested_dims = list(declared_dims)
    rank = max(len(actual_dims), len(requested_dims))
    actual_padded = actual_dims + [1] * (rank - len(actual_dims))
    requested_padded = requested_dims + [1] * (rank - len(requested_dims))
    if not all(requested is None or requested == actual
               for requested, actual in zip(requested_padded, actual_padded)):
        fixed_dims = [dim for dim in requested_dims]
        element_count = _numel(value)
        if element_count == 1 and all(dim is not None for dim in fixed_dims):
            value = repmat_(value, *[float(dim) for dim in fixed_dims])
        elif _argument_vector_reshape_allowed(actual_dims, requested_dims, element_count):
            value = reshape_(value,
                             float(requested_dims[0] if requested_dims[0] is not None else element_count),
                             float(requested_dims[1] if requested_dims[1] is not None else element_count))
        else:
            size_spec = "×".join(":" if dim is None else str(dim) for dim in requested_dims)
            raise _using(_arg_prefix(position) + "Value must be of size %s." % size_spec)
    return value


def _argument_vector_reshape_allowed(actual, requested, element_count):
    """A 2-D row/column request with one unit axis and the existing element count."""
    return (len(actual) == 2 and (actual[0] == 1 or actual[1] == 1) and
            len(requested) == 2 and (requested[0] in (1, None) or requested[1] in (1, None)) and
            ((requested[0] == 1 and requested[1] in (None, element_count)) or
             (requested[1] == 1 and requested[0] in (None, element_count))))


def _using(e):
    e = e if isinstance(e, MatlabError) else MatlabError(str(e))
    e._using = True
    return e


def validate(thunk, pos):
    """Discard a successful validator result; prefix only MatlabError failures.

    Keep the identifier and mark _using so the caller formats the argument
    error as an 'Error using' message. Other exception types pass through.
    """
    try:
        thunk()
    except MatlabError as e:
        raise _using(MatlabError(_arg_prefix(pos) + e.message, e.identifier))


def _vfail(msg, ident):
    raise MatlabError(msg, "MATLAB:validators:" + ident)


def _vnum(v):
    return _isnumlike(v) and type(v) is not Char


def _velems(v):
    values = _farr(v)
    return values


@_bi("mustBeNumeric")
def mustBeNumeric_(nargout, v):
    if not (_numeric_class(class_(v))):
        _vfail("Value must be numeric.", "mustBeNumeric")
    return NOVAL


@_bi("mustBeNumericOrLogical")
def mustBeNumericOrLogical_(nargout, v):
    if not (_numeric_class(class_(v)) or class_(v) == "logical"):
        _vfail("Value must be numeric or logical.", "mustBeNumericOrLogical")
    return NOVAL


@_bi("mustBeReal")
def mustBeReal_(nargout, v):
    # _isnumlike includes logical/char values. Complex storage is allowed when
    # all imaginary components are zero; dtype alone does not decide realness.
    if not _isnumlike(v) or (_arr(v).dtype.kind == "c" and np.any(_arr(v).imag)):
        _vfail("Value must be real.", "mustBeReal")
    return NOVAL


def _pred_validator(name, msg, pred, numeric=True):
    """Register an elementwise validator; admitted empty arrays skip pred.

    The default class check includes numeric, logical and char. Conversion to
    _farr still happens on empty input; only the predicate call is conditional.
    Successful validators return NOVAL, while _vfail supplies the identifier.
    """
    def g(nargout, v):
        if numeric and not (_numeric_class(class_(v)) or class_(v) in ("logical", "char")):
            _vfail(msg, name[0].lower() + name[1:])
        values = _farr(v)
        if values.size and not bool(np.all(pred(values))):
            _vfail(msg, name)
        return NOVAL
    _B[name] = Builtin(g, name)


_pred_validator("mustBeFinite", "Value must be finite.", lambda A: np.isfinite(A))
_pred_validator("mustBeNonNan", "Value must not be NaN.", lambda A: ~np.isnan(A))
_pred_validator("mustBePositive", "Value must be positive.", lambda A: A > 0)
_pred_validator("mustBeNonnegative", "Value must be nonnegative.", lambda A: A >= 0)
_pred_validator("mustBeNegative", "Value must be negative.", lambda A: A < 0)
_pred_validator("mustBeNonpositive", "Value must not be positive.", lambda A: A <= 0)
_pred_validator("mustBeNonzero", "Value must not be zero.", lambda A: A != 0)
_pred_validator("mustBeInteger", "Value must be integer.", lambda A: np.isfinite(A) & (A == np.floor(A)))


@_bi("mustBeNonempty")
def mustBeNonempty_(nargout, v):
    if _numel(v) == 0:
        _vfail("Value must not be empty.", "mustBeNonempty")
    return NOVAL


@_bi("mustBeScalarOrEmpty")
def mustBeScalarOrEmpty_(nargout, v):
    if _numel(v) > 1:
        _vfail("Value must be scalar or empty.", "mustBeScalarOrEmpty")
    return NOVAL


@_bi("mustBeVector")
def mustBeVector_(nargout, v, *opt):
    # This check uses only whether an option was supplied; it does not parse
    # an option spelling. An empty value must still have a vector shape.
    if not _isvec(v) or (_numel(v) == 0 and not opt):
        _vfail("Value must be a 1-by-n vector or an n-by-1 vector.", "mustBeVector")
    return NOVAL


def _cmp_validator(name, text, f):
    """Register a comparison with broadcast bounds, requiring every result true."""
    def g(nargout, v, c):
        values = _farr(v)
        bounds = _farr(c)
        if values.size and not bool(np.all(_broadcast(f, values, bounds))):
            _vfail("Value must be %s %s." % (text, _num2str_g(_scalar(c))), name)
        return NOVAL
    _B[name] = Builtin(g, name)


_cmp_validator("mustBeGreaterThan", "greater than", lambda a, c: a > c)
_cmp_validator("mustBeGreaterThanOrEqual", "greater than or equal to", lambda a, c: a >= c)
_cmp_validator("mustBeLessThan", "less than", lambda a, c: a < c)
_cmp_validator("mustBeLessThanOrEqual", "less than or equal to", lambda a, c: a <= c)


@_bi("mustBeInRange")
def mustBeInRange_(nargout, v, lo, hi, *opt):
    """Inclusive scalar bounds unless textual flags exclude an endpoint.

    Non-text/unknown options have no effect. Empty values skip the final
    failure check, but value/bound conversions and comparisons still execute.
    """
    values = _farr(v)
    lower_bound = _scalar(lo)
    upper_bound = _scalar(hi)
    flags = [_text(option).lower() for option in opt if _istext(option)]
    lower_allowed = values > lower_bound if ("exclusive" in flags or "exclude-lower" in flags) else values >= lower_bound
    upper_allowed = values < upper_bound if ("exclusive" in flags or "exclude-upper" in flags) else values <= upper_bound
    if values.size and not bool(np.all(lower_allowed & upper_allowed)):
        _vfail("Value must be within the range specified by %s and %s." % (_num2str_g(lower_bound), _num2str_g(upper_bound)), "mustBeInRange")
    return NOVAL


@_bi("mustBeMember")
def mustBeMember_(nargout, v, s):
    membership = ismember_(1, v, s)
    if not cond(membership if _numel(membership) else True):
        items = [_text(element) for element in s.a] if type(s) is Cell else ([str(element) for element in s.a] if type(s) is StrArr else [_num2str_g(float(element)) for element in _farr(s).reshape(-1)])
        quote_items = type(s) is Cell or type(s) is StrArr
        _vfail("Value must be a member of this set:\n" + "\n".join("    " + ("'%s'" % item if quote_items else item) for item in items), "mustBeMember")
    return NOVAL


@_bi("mustBeText")
def mustBeText_(nargout, v):
    # Text representations are checked here, not their length or Char shape.
    if not (type(v) is Char or type(v) is Str or type(v) is StrArr or (type(v) is Cell and all(type(e) is Char for e in v.a))):
        _vfail("Value must be a character vector, string array, or cell array of character vectors.", "mustBeText")
    return NOVAL


@_bi("mustBeTextScalar")
def mustBeTextScalar_(nargout, v):
    # A Char with at most one row or a Str scalar; not StrArr or Cell storage.
    if not (type(v) is Str or (type(v) is Char and _dims(v)[0] <= 1)):
        _vfail("Value must be a character vector or string scalar.", "mustBeTextScalar")
    return NOVAL


@_bi("mustBeNonzeroLengthText")
def mustBeNonzeroLengthText_(nargout, v):
    # Nonempty Str/Char or a nonempty Cell of nonempty Char. No StrArr branch.
    if not ((type(v) is Str and v.s) or (type(v) is Char and v.a.size) or (type(v) is Cell and v.a and all(type(e) is Char and e.a.size for e in v.a))):
        _vfail("Value must be text with one or more characters.", "mustBeNonzeroLengthText")
    return NOVAL


@_bi("mustBeA")
def mustBeA_(nargout, v, classes):
    names = [_text(e) for e in classes.a] if type(classes) is Cell else ([s for s in classes.a] if type(classes) is StrArr else [_text(classes)])
    if not any(isa_(v, Char(n)) for n in names):
        _vfail("Value must be one of the following types: %s." % " or ".join("'%s'" % n for n in names), "mustBeA")
    return NOVAL


@_bi("mustBeUnderlyingType")
def mustBeUnderlyingType_(nargout, v, t):
    names = [_text(e) for e in t.a] if type(t) is Cell else [_text(t)]
    if class_(v) not in names:
        _vfail("Value must have one of these underlying types: %s." % ", ".join(names), "mustBeUnderlyingType")
    return NOVAL


@_bi("mustBeNonsparse")
def mustBeNonsparse_(nargout, v):
    return NOVAL


@_bi("mustBeNonmissing")
def mustBeNonmissing_(nargout, v):
    if _isnumlike(v) and np.any(np.isnan(_farr(v).real)):
        _vfail("Value must not have missing data.", "mustBeNonmissing")
    if type(v) is StrArr and any(x is None for x in v.a):
        _vfail("Value must not have missing data.", "mustBeNonmissing")
    return NOVAL


@_bi("mustBeValidVariableName")
def mustBeValidVariableName_(nargout, v):
    names = [_text(e) for e in v.a] if type(v) in (Cell, StrArr) and type(v) is not StrArr else ([s for s in v.a] if type(v) is StrArr else [_text(v)])
    bad = [n for n in names if not isvarname_(Char(n))]
    if bad:
        _vfail("These are not valid variable names: %s." % ", ".join("'%s'" % n for n in bad), "mustBeValidVariableName")
    return NOVAL


@_bi("mustBeFile")
def mustBeFile_(nargout, v):
    import os
    if not os.path.isfile(_text(v)):
        _vfail("The following files do not exist: '%s'." % _text(v), "mustBeFile")
    return NOVAL


@_bi("mustBeFolder")
def mustBeFolder_(nargout, v):
    import os
    if not os.path.isdir(_text(v)):
        _vfail("The following folders do not exist: '%s'." % _text(v), "mustBeFolder")
    return NOVAL


# ------------------------------------------------------------------ more outputs and small functions (from the documentation's examples)

import cmath as _cmath

_CMATH = {"sqrt": _cmath.sqrt, "exp": _cmath.exp, "log": _cmath.log, "log10": _cmath.log10,
          "log2": lambda z: _cmath.log(z) / _math.log(2), "log1p": lambda z: _cmath.log(1 + z), "expm1": lambda z: _cmath.exp(z) - 1,
          "sin": _cmath.sin, "cos": _cmath.cos, "tan": _cmath.tan, "asin": _cmath.asin, "acos": _cmath.acos, "atan": _cmath.atan,
          "sinh": _cmath.sinh, "cosh": _cmath.cosh, "tanh": _cmath.tanh, "asinh": _cmath.asinh, "acosh": _cmath.acosh,
          "atanh": _cmath.atanh, "sec": lambda z: 1 / _cmath.cos(z), "csc": lambda z: 1 / _cmath.sin(z), "cot": lambda z: 1 / _cmath.tan(z)}


def _cmath_log(f):
    """a complex logarithm, -Inf + 0i at 0 (cmath raises there)"""
    def g(z):
        return complex(-_math.inf, 0.0) if z == 0 else f(z)
    return g


for _n in ("log", "log10", "log2"):
    _CMATH[_n] = _cmath_log(_CMATH[_n])
# (a real entry > -1 of a complex array by the real log1p, which keeps a small x's digits)
_CMATH["log1p"] = lambda z: complex(-_math.inf, 0.0) if z == -1 else \
    complex(_math.log1p(z.real), 0.0) if z.imag == 0 and z.real > -1 else _cmath.log(1 + z)
# (the poles, where cmath raises: atanh(±1) = ±Inf, atan(±1i) = ±Inf i, as MATLAB gives)
_CMATH["atanh"] = lambda z: complex(_math.copysign(_math.inf, z.real), 0.0) if z.imag == 0 and abs(z.real) == 1 else _cmath.atanh(z)
_CMATH["atan"] = lambda z: complex(0.0, _math.copysign(_math.inf, z.imag)) if z.real == 0 and abs(z.imag) == 1 else _cmath.atan(z)


def _complex_fallback(name):
    """the elementwise math function for complex arrays numpy here lacks"""
    old = _B[name].f
    f = _CMATH[name]

    def g(nargout, x):
        try:
            return old(nargout, x)
        except (TypeError, ValueError, NotImplementedError) as e:
            if "complex" not in str(e):
                raise
            A0 = _farr(x)
            A = A0.astype(np.complex128)
            out = np.array([f(complex(z)) for z in A.reshape(-1)], dtype=np.complex128).reshape(A.shape)
            if name in _REAL_FIX:
                out = _apply_real_fix(_REAL_FIX[name], A0, out)
            if A0.dtype.kind != "c":
                # (a real NaN of a real array made complex stays NaN with a zero imaginary part, as
                # it is alone: asin([NaN 2]) gave NaN + NaNi)
                nan = np.isnan(A0)
                if np.any(nan):
                    out[nan] = complex(_math.nan, 0.0)
            return _finish(out, "single" if class_(x) == "single" else "double")
    _B[name] = Builtin(g, name)


for _n in _CMATH:
    if _n in _B:
        _complex_fallback(_n)


def _log2_parts():
    """[F, E] = log2(X): X = F.*2.^E with 0.5 <= abs(F) < 1 (C's frexp); zeros give F = E = 0,
    Inf and NaN themselves in F with E = 0, as log2's page says; complex X is an error there"""
    old = _B["log2"].f

    def g(nargout, x):
        if nargout < 2:
            return old(nargout, x)
        A = _arr(x)
        if A.dtype.kind == "c":
            raise _err("log2: the two-output syntax does not accept complex input.")
        if class_(x) != "double":
            raise _err("[F, E] = log2(X) for a %s X is not supported in Sagebrush." % class_(x))
        A = _farr(x)
        fe = [_math.frexp(float(v)) for v in A.reshape(-1)]
        F = np.array([f for f, _ in fe], dtype=float).reshape(A.shape)
        E = np.array([float(e) for _, e in fe], dtype=float).reshape(A.shape)
        return [_box(_contig(F)), _box(_contig(E))]
    _B["log2"] = Builtin(g, "log2")


_log2_parts()


def _real_cut(name, fix):
    """name, except at real x outside [-1, 1], where fix(x) gives the value on the side MATLAB takes,
    as its real and imaginary parts
    (numpy's and cmath's branch there is the limit from above for both signs of x)"""
    old = _B[name].f

    def g(nargout, x):
        r = old(nargout, x)
        if _isnumlike(x) and not islogical_(x):
            # (real x, or elements of a complex array with no imaginary part, as atanh's page
            # shows for [2 -3 1+2i])
            X = _farr(x)
            if X.dtype.kind == "c":
                m = (X.imag == 0) & (np.abs(X.real) > 1)
                X = X.real
            else:
                m = np.abs(X) > 1
            if np.any(m):
                R = np.array(_farr(r), dtype=np.complex128)
                # (real and imaginary parts set apart, so an infinite one leaves the other finite)
                re, im = fix(X[m])
                R.real[m] = re
                R.imag[m] = im
                return _finish(R, "single" if class_(x) == "single" else "double")
        return r
    _B[name] = Builtin(g, name)


# (asin and acos of a real x beyond 1, as Octave gives them: asin(2) = pi/2 - acosh(2) i, odd in x;
# acos(2) = acosh(2) i and acos(-2) = pi - acosh(2) i; atanh as atanh's page shows: atanh(2) =
# atanh(1/2) + pi/2 i and atanh(-3) = atanh(-1/3) - pi/2 i, odd in x)
_real_cut("asin", lambda x: (np.sign(x) * (np.pi / 2), -np.sign(x) * np.arccosh(np.abs(x))))
_real_cut("acos", lambda x: (np.where(x > 0, 0.0, np.pi), np.sign(x) * np.arccosh(np.abs(x))))
_real_cut("atanh", lambda x: (np.arctanh(1 / x), np.sign(x) * (np.pi / 2)))


def _bezout(a, b):
    """g = gcd(a, b) = u a + v b"""
    a, b = int(a), int(b)
    u0, v0, u1, v1 = 1, 0, 0, 1
    x, y = abs(a), abs(b)
    while y:
        q = x // y
        x, y = y, x - q * y
        u0, u1 = u1, u0 - q * u1
        v0, v1 = v1, v0 - q * v1
    return x, u0 * (1 if a >= 0 else -1), v0 * (1 if b >= 0 else -1)


@_bi("gcd")
def gcd_n(nargout, a, b):
    if nargout <= 1:
        return _pairwise(a, b, _gcd1, "gcd")
    A, B = np.broadcast_arrays(_farr(a), _farr(b))
    res = [_bezout(x, y) for x, y in zip(A.reshape(-1), B.reshape(-1))]
    cls = _arith_class(a, b, "gcd")
    outs = [_finish(np.array([float(r[k]) for r in res]).reshape(A.shape), cls) for k in range(3)]
    return outs[:nargout]


@_bi("histc")
def histc_n(nargout, x, edges, *rest):
    X = _farr(x).reshape(-1)
    E = _farr(edges).reshape(-1)
    n = np.zeros(E.size)
    ind = np.zeros(X.size)
    for i, v in enumerate(X):
        k = int(np.searchsorted(E, v, side="right")) - 1
        if 0 <= k < E.size and (k < E.size - 1 or v == E[-1]):
            n[k] += 1
            ind[i] = k + 1
    d = _dims(x)
    if len(d) == 2 and d[0] > 1 and d[1] > 1:
        # (a matrix: each column's counts, length(edges)-by-columns, and each element's bin)
        M = _mat(x)
        C = np.zeros((E.size, M.shape[1]))
        I = np.zeros(M.shape)
        for j in range(M.shape[1]):
            for i, v in enumerate(M[:, j]):
                k = int(np.searchsorted(E, v, side="right")) - 1
                if 0 <= k < E.size and (k < E.size - 1 or v == E[-1]):
                    C[k, j] += 1
                    I[i, j] = k + 1
        return _unmat(C) if nargout <= 1 else [_unmat(C), _unmat(I)]
    # (a vector x: the counts in x's orientation, a column for a column x, as the histc page shows)
    counts = _box(n.reshape((n.size, 1)) if d[0] == 1 else n.reshape((1, n.size)))
    if nargout <= 1:
        return counts
    return [counts, _box(ind.reshape(_arr(x).shape))]


@_bi("meshgrid")
def meshgrid_n(nargout, x, y=None, z=None):
    # (each grid is copies of its own coordinate vector, so of that vector's class, single or
    # an integer class, as MathWorks' meshgrid page has it: meshgrid(uint8(255)) + 1 saturates)
    y = y if y is not None else x
    def kept(v, a):
        c = class_(v)
        return _finish(_farr(a), c) if c == "single" or c in _INTS else a
    xv = _farr(x).reshape(-1)
    yv = _farr(y).reshape(-1)
    if nargout <= 2 and z is None:
        X = kept(x, _unmat(np.tile(xv.reshape((1, -1)), (yv.size, 1))))
        Y = kept(y, _unmat(np.tile(yv.reshape((-1, 1)), (1, xv.size))))
        return X if nargout <= 1 else [X, Y]
    z = z if z is not None else x
    zv = _farr(z).reshape(-1)
    # MATLAB size: numel(y)-by-numel(x)-by-numel(z); stored with the axes reversed
    shape = (zv.size, xv.size, yv.size)
    X = np.broadcast_to(xv.reshape((1, -1, 1)), shape)
    Y = np.broadcast_to(yv.reshape((1, 1, -1)), shape)
    Z = np.broadcast_to(zv.reshape((-1, 1, 1)), shape)
    return [kept(x, _box(np.array(X))), kept(y, _box(np.array(Y))), kept(z, _box(np.array(Z)))][:max(1, nargout)]


def _setop2(nargout, a, b, op, opts):
    r = _setop(a, b, op, 1, opts)
    if nargout <= 1:
        return r
    if type(a) is Cell or type(b) is Cell:
        A = [_text(e) for e in (a.a if type(a) is Cell else [a])]
        B = [_text(e) for e in (b.a if type(b) is Cell else [b])]
        C = [_text(e) for e in r.a]
    else:
        A = [float(v) for v in _farr(a).reshape(-1)]
        B = [float(v) for v in _farr(b).reshape(-1)]
        C = [float(v) for v in _farr(r).reshape(-1)] if _numel(r) else []
    stable = any(_istext(o) and _text(o) == "stable" for o in opts)

    def last(seq, v):
        return len(seq) - seq[::-1].index(v)

    def first(seq, v):
        return seq.index(v) + 1

    pick = first if stable else last
    col = lambda vals: _box(np.array(vals, dtype=np.float64).reshape((1, len(vals)))) if vals else np.zeros((1, 0))
    if op == "union":
        ia = [pick(A, v) for v in C if v in A]
        ib = [pick(B, v) for v in C if v not in A]
        return [r, col(ia), col(ib)][:nargout]
    if op == "intersect":
        return [r, col([pick(A, v) for v in C]), col([pick(B, v) for v in C])][:nargout]
    return [r, col([pick(A, v) for v in C])][:nargout]


@_bi("union")
def union_n(nargout, a, b, *opts):
    return _setop2(nargout, a, b, "union", opts)


@_bi("intersect")
def intersect_n(nargout, a, b, *opts):
    return _setop2(nargout, a, b, "intersect", opts)


@_bi("setdiff")
def setdiff_n(nargout, a, b, *opts):
    return _setop2(nargout, a, b, "setdiff", opts)


@_bi("bounds")
def bounds_n(nargout, x, *args):
    out = [min_(1, x, np.zeros((0, 0)), *args), max_(1, x, np.zeros((0, 0)), *args)] if args else [min_(1, x), max_(1, x)]
    return out if nargout > 1 else out[0]


@_bs("getfield")
def getfield_n(s, *path):
    cur = s
    for p in path:
        if type(p) is Cell:
            cur = index(cur, list(p.a))
        else:
            cur = field(cur, _text(p))
    return cp(cur)


@_bs("setfield")
def setfield_n(s, *args):
    *path, v = args
    steps = [("p", list(p.a)) if type(p) is Cell else ("f", _text(p)) for p in path]
    return assign(cp(s), steps, cp(v))


@_bs("orderfields")
def orderfields_n(s, order=None):
    r = cp(s)
    if order is None:
        r.fields = sorted(r.fields)
        return r
    # (another structure's field order, every name once, or a permutation of the
    # positions: anything else would drop or repeat fields, so it is refused)
    if type(order) is Struct:
        new = list(order.fields)
        if sorted(new) != sorted(s.fields):
            raise _err("orderfields: S1 and S2 do not have the same fields.")
    elif type(order) in (Cell, StrArr):
        new = [_text(e) for e in order.a] if type(order) is Cell else [str(e) for e in order.a]
        if sorted(new) != sorted(s.fields):
            raise _err("orderfields: the cell array must list each field of S1 exactly once.")
    else:
        v = _farr(order).reshape(-1)
        n = len(s.fields)
        if len(v) != n or not all(k == _math.floor(k) and 1 <= k <= n for k in v) or len(set(int(k) for k in v)) != n:
            raise _err("orderfields: the permutation vector must be a permutation of 1:%d." % n)
        new = [s.fields[int(k) - 1] for k in v]
    r.fields = new
    return r


@_bs("num2cell")
def num2cell_n(x, dims=None):
    if dims is None:
        return num2cell_(x)
    # the dimensions listed go into each cell
    ds = sorted(int(k) for k in _arr(dims).reshape(-1))
    d = list(_dims(x))
    nd = max(len(d), max(ds))
    d = d + [1] * (nd - len(d))
    outer = [1 if (k + 1) in ds else d[k] for k in range(nd)]
    cells = []
    for lin in range(_prod(outer)):
        sub = []
        rem = lin
        for k in range(nd):
            sub.append(rem % outer[k])
            rem //= outer[k]
        args = [COLON if (k + 1) in ds else float(sub[k] + 1) for k in range(nd)]
        cells.append(index(x, args))
    return Cell(cells, outer)


@_bs("trapz")
def trapz_n(*args):
    """trapz(Y), trapz(X, Y), trapz(Y, dim), trapz(X, Y, dim): the trapezoidal rule along dim
    (the first non-singleton by default), X a scalar spacing or the points along dim"""
    args = list(args)
    dim = None
    if len(args) == 3:
        dim = _int_arg(args.pop(), "dimension")
    elif len(args) == 2 and _numel(args[1]) == 1 and _numel(args[0]) > 1:
        dim = _int_arg(args.pop(), "dimension")
    x, y = (None, args[0]) if len(args) == 1 else (args[0], args[1])
    d = _dims(y)
    if len(d) > 2:
        raise _err("trapz: Sagebrush integrates arrays of at most 2 dimensions.")
    if dim is None:
        dim = _default_dim(d)
    Y = _mat(y).astype(np.complex128 if _arr(y).dtype.kind == "c" else np.float64)
    if dim > 2:
        return _unmat(np.zeros(Y.shape))
    A = Y if dim == 1 else Y.T
    n = A.shape[0]
    if x is not None and _numel(x) != 1 and _numel(x) != n:
        raise _err("Point spacing must be a scalar specifying uniform spacing or a vector of x-coordinates with length equal to the size of Y along the integration dimension.")
    ys = class_(y) == "single"
    xs = x is not None and class_(x) == "single"
    if (ys or xs) and n > 1:
        # (the single steps run one row of pair sums at a time: their work is admitted first)
        if (n - 1) * A.shape[1] > _SINGLE_STEPS_WORK:
            raise _err("trapz of single values with %d points for %d columns is not supported in Sagebrush: "
                       "too much work." % (n, A.shape[1]))
        q = _trapz_single(A, x, n, ys, xs)
    elif n > 1:
        if x is None or _numel(x) == 1:
            # (the halved sum of the pair sums, trapz(Y), times X: a scalar X gives X*trapz(Y) on
            # MathWorks' trapz page, finite where X times a pair sum would overflow, and nonzero
            # where X / 2 would underflow)
            q = np.sum(A[1:] + A[:-1], axis=0) / 2
            if x is not None:
                q = _scalar(x) * q
        else:
            dx = np.diff(_farr(x).reshape(-1)).reshape((-1, 1))
            q = np.sum(dx * (A[1:] + A[:-1]) / 2, axis=0)
    else:
        q = np.zeros(A.shape[1])
    q = q.reshape((1, -1)) if dim == 1 else q.reshape((-1, 1))
    r = _unmat(q)
    return _finish(_farr(r), "single") if ys or xs else r


def _trapz_single(A, x, n, ys, xs):
    """trapz in single at each step (a step single when an operand is, a double operand at its
    own value): the pair sums y(k) + y(k+1); for a scalar spacing d, their sum, first to last,
    halved, times d; for points x, the sum, first to last, of diff(x)(k) times each pair sum,
    halved. MathWorks' trapz page does not give the order of the steps (only that a scalar X
    gives X*trapz(Y), which fixes where d multiplies); this one alone matched Octave's
    results on single inputs chosen so that the orders tried (the spacing factored out or not;
    summed first to last, last to first or pairwise) all differ"""
    R = _single_values
    S = R(A[1:] + A[:-1]) if ys else A[1:] + A[:-1]
    if x is None or _numel(x) == 1:
        acc = S[0]
        for k in range(1, n - 1):
            acc = R(acc + S[k]) if ys else acc + S[k]
        half = R(acc / 2) if ys else acc / 2
        # (d times the halved sum, trapz(Y): MathWorks' trapz page makes trapz(X, Y) X*trapz(Y)
        # for a scalar X, finite where d times the sum would overflow, and nonzero where d / 2
        # would underflow)
        return half if x is None else R(_scalar(x) * half)
    dx = np.diff(_farr(x).reshape(-1)).reshape((-1, 1))
    if xs:
        dx = R(dx)
    T = R(dx * S)
    acc = T[0]
    for k in range(1, n - 1):
        acc = R(acc + T[k])
    return R(acc / 2)


_CLEAR_ITEMTYPES = ("all", "classes", "functions", "global", "import", "java", "mex", "variables")


def clear_select(fn, tokens, defined, protected=()):
    """the variables clear or clearvars removes, of those defined (holding a value):
    - clear WORD alone, WORD an ItemType: the variable WORD if it exists (MATLAB's clear
      page), else the keyword (all, variables, classes, java: every variable; the others
      none here);
    - names and wildcards (* ?), or after -regexp regular expressions;
    - clearvars: its words are always names; with -except, the variables matched after
      it are kept.
    protected: names that may not be removed (a function's globals and persistents,
    which Sagebrush can't unlink exactly): one selected is refused."""
    tokens = [t if type(t) is str else _text(t) for t in tokens]
    defined = list(defined)
    if fn == "clear":
        flags = [t for t in tokens if t.startswith("-")]
        words = [t for t in tokens if not t.startswith("-")]
        if any(f.lower() not in ("-regexp", "-all") for f in flags):
            raise _err("clear: the option '%s' is not supported." % next(f for f in flags if f.lower() not in ("-regexp", "-all")))
        if tokens and tokens[0].lower() == "-all":
            words = ["all"] + words[0:]
            tokens = tokens[1:]
        if len(words) == 1 and words[0] in _CLEAR_ITEMTYPES and not flags:
            w = words[0]
            if w in defined:
                chosen = [w]
            elif w in ("all", "variables", "classes", "java"):
                chosen = defined + [p for p in protected if p not in defined]
            elif w == "global":
                # (clear global: the global variables go, from the global store and from
                # this workspace; a function's own links to them can't be undone exactly,
                # so a function that declares a global or persistent is refused)
                if protected:
                    raise _err("clear global inside a function that declares global or persistent variables is not supported.")
                _globals.clear()
                chosen = []
            else:
                chosen = []
        elif any(w in _CLEAR_ITEMTYPES for w in words) and not flags:
            raise _err("clear: an ItemType word (%s) among other names is not supported." % next(w for w in words if w in _CLEAR_ITEMTYPES))
        elif not tokens:
            chosen = defined + [p for p in protected if p not in defined]
        else:
            chosen = _clear_match(tokens, defined + list(protected))
    else:
        if any(t.lower() == "-global" for t in tokens):
            raise _err("clearvars -global is not supported.")
        lower = [t.lower() for t in tokens]
        cut = lower.index("-except") if "-except" in lower else len(tokens)
        targets, keep = tokens[:cut], tokens[cut + 1:]
        if any(t.startswith("-") and t.lower() != "-regexp" for t in targets + keep):
            raise _err("clearvars: the option '%s' is not supported." % next(t for t in targets + keep if t.startswith("-") and t.lower() != "-regexp"))
        everything = defined + [p for p in protected if p not in defined]
        budget = [0]  # (the -regexp work of the targets and -except together)
        chosen = _clear_match(targets, everything, budget) if [t for t in targets if not t.startswith("-")] else everything
        if keep:
            kept = set(_clear_match(keep, everything, budget))
            chosen = [v for v in chosen if v not in kept]
    bad = [v for v in chosen if v in protected]
    if bad:
        raise _err("Clearing the global or persistent variable '%s' inside a function is not supported." % bad[0])
    return [v for v in chosen if v in defined]


def _clear_match(tokens, names, budget=None):
    """names matched by tokens: wildcards (* ?), and regular expressions after -regexp
    (a match anywhere in the name, as regexp finds it). Each expression's weight
    (_regex_linearish) times the number of names counts against 4,000,000, with budget
    carrying the count between clearvars' targets and -except, so many expressions
    over a large workspace are refused as many wildcards are"""
    if "-regexp" in [t.lower() for t in tokens]:
        k = [t.lower() for t in tokens].index("-regexp")
        plain, rx = tokens[:k], tokens[k + 1:]
    else:
        plain, rx = tokens, []
    chosen = set(_glob_select(plain, names)) if plain else set()
    weights = []
    for r in rx:
        w = _regex_linearish(r)
        if not w:
            raise _err("The -regexp pattern '%s' repeats a repetition or an alternation (it could take exponential time to match): not supported." % r)
        weights.append(w)
    budget = budget if budget is not None else [0]
    budget[0] += sum(weights) * len(names)
    if budget[0] > 4000000:
        raise _err("Too many -regexp patterns, or patterns too complex, for this workspace: not supported.")
    for r in rx:
        pat = _re.compile(_regex(r))
        chosen.update(n for n in names if pat.search(n))
    return [n for n in names if n in chosen]


def _regex_linearish(p):
    """The pattern's weight, or 0 for a pattern that could backtrack badly. Each repetition has a weight, the
    number of lengths it can take on a name of at most 63 characters (? two, {m,n}
    min(n,63)-m+1, *, + and {m,} sixty-four); a sequence's weight is the product of its
    parts', an alternation's the sum of its branches'. Past 10^5 the pattern is refused,
    which bounds the backtracking paths per start position (at most 63 of them): the
    regular expression engine can't be interrupted, so such patterns are refused rather
    than run. A repeated group that itself holds a repetition or an alternation ((a+)+,
    (a|aa)*) and a backreference are refused too"""
    limit = 10 ** 5
    # (per open group: [product of the current branch, sum of finished branches, holds a repetition])
    stack = [[1, 0, False]]
    i, n = 0, len(p)
    while i < n:
        c = p[i]
        weight = 1
        group = None
        if c == "\\":
            if i + 1 < n and p[i + 1].isdigit():
                return 0
            i += 2
        elif c == "[":
            j = i + 1
            if j < n and p[j] == "^":
                j += 1
            if j < n and p[j] == "]":
                j += 1
            while j < n and p[j] != "]":
                j += 2 if p[j] == "\\" else 1
            i = j + 1
        elif c == "(":
            stack.append([1, 0, False])
            i += 1
            continue
        elif c == ")":
            if len(stack) > 1:
                group = stack.pop()
                weight = group[0] + group[1]
            i += 1
        elif c == "|":
            stack[-1][1] += stack[-1][0]
            stack[-1][0] = 1
            i += 1
            continue
        else:
            i += 1
        # (a quantifier after this atom)
        if i < n and p[i] in "*+?{":
            if p[i] == "{":
                j = p.find("}", i)
                body = [t.strip() for t in p[i + 1:j].split(",")] if j > 0 else []
                if not 1 <= len(body) <= 2 or not body[0].isdigit() or len(body) == 2 and body[1] and not body[1].isdigit():
                    i += 1  # (a literal brace)
                    stack[-1][0] *= weight
                    continue
                lo = int(body[0])
                hi = lo if len(body) == 1 else int(body[1]) if body[1] else 63
                times = max(1, min(hi, 63) - min(lo, 63) + 1)
                i = j + 1
            else:
                times = 2 if p[i] == "?" else 64
                i += 1
            if i < n and p[i] in "?+":
                i += 1
            if group is not None and (group[2] or weight > 1):
                return 0
            weight *= times
            stack[-1][2] = True
        elif group is not None and group[2]:
            stack[-1][2] = True
        stack[-1][0] *= weight
        if stack[-1][0] > limit:
            return 0
    weight = stack[0][0] + stack[0][1]
    return weight if weight <= limit else 0


def _glob_select(pats, names):
    """the names any of the wildcard patterns (* and ?) match, in names' order: exact
    names by a set lookup and the patterns as one expression, so the cost is about
    len(pats) + len(names), not their product"""
    exact = {p for p in pats if "*" not in p and "?" not in p}
    wild = [p for p in pats if p not in exact]
    rx = None
    if wild:
        # (each pattern is tried for each name: past a few million comparisons, refused)
        if len(wild) * len(names) > 4000000:
            raise _err("Too many wildcard patterns for this workspace: use exact names.")
        rx = _re.compile("|".join("(?:" + "".join(".*" if c == "*" else "." if c == "?" else _re.escape(c) for c in p) + ")" for p in wild))
    return [v for v in names if v in exact or (rx is not None and rx.fullmatch(v) is not None)]


def _glob_match(pat, s):
    """a wildcard pattern (* and ?) against a name"""
    rx = "^" + "".join(".*" if c == "*" else "." if c == "?" else _re.escape(c) for c in pat) + "$"
    return _re.match(rx, s) is not None


def _civil(t):
    """(year, month, day, hour, minute, second) of a Unix time (UTC)"""
    days = int(t // 86400)
    secs = t - days * 86400
    z = days + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    return (y + (1 if m <= 2 else 0), m, d, int(secs // 3600), int(secs % 3600 // 60), secs % 60)


@_bs("clock")
def clock_n():
    import time
    return _box(np.array([float(v) for v in _civil(time.time())]).reshape((6, 1)))


_rng_states = {}
_rng_seed = [0.0]
# (the generator states rng's outputs name, the most recent ones: an older one is forgotten)
_RNG_STATES_MAX = 1000


def _rng_generator(g):
    """rng's generator argument: Mersenne Twister only; another is refused, not substituted"""
    t = _text(g).lower() if _istext(g) else None
    if t not in ("twister", "default"):
        raise _err("rng: the generator '%s' is not supported in Sagebrush; 'twister' is." % (_text(g) if _istext(g) else class_(g)))


def _rng_seed_arg(a):
    x = _scalar(a) if not _istext(a) and _numel(a) == 1 else None
    if x is None or x != x or x != _math.floor(x) or not 0 <= x < 4294967296:
        raise _err("rng: the seed must be a nonnegative integer less than 2^32.")
    return int(x)


@_bi("rng")
def rng_n(nargout, *args):
    prev = None
    if nargout >= 1:
        st = _rng[0].get_state()
        key = float(max(_rng_states, default=0.0) + 1)
        _rng_states[key] = st
        while len(_rng_states) > _RNG_STATES_MAX:
            del _rng_states[min(_rng_states)]
        prev = _struct1({"Type": Char("twister"), "Seed": _rng_seed[0], "State": key})
    if len(args) > 2:
        raise _err("rng: too many input arguments.")
    if args:
        a = args[0]
        if type(a) is Struct:
            if len(args) > 1:
                raise _err("rng: a settings structure takes no other argument.")
            d = a.a[0] if len(a.a) == 1 else {}
            key = d.get("State")
            if key is None or _numel(key) != 1 or _scalar(key) not in _rng_states:
                raise _err("rng: these generator settings are not ones this session's rng returned, or are too old to restore.")
            _rng[0].set_state(_rng_states[_scalar(key)])
            _rng_seed[0] = float(_scalar(d.get("Seed", 0.0)))
            return prev if prev is not None else NOVAL
        if len(args) > 1:
            _rng_generator(args[1])
        if _istext(a):
            s = _text(a).lower()
            if s == "default":
                if len(args) > 1:
                    raise _err("rng: 'default' takes no generator.")
                seed = 0
            elif s == "shuffle":
                import time
                seed = int(time.time() * 1000) % 4294967296
            else:
                # (a generator named alone is rng(0, generator), as rng's page says; only twister)
                _rng_generator(a)
                seed = 0
        else:
            seed = _rng_seed_arg(a)
        _rng[0] = np.random.RandomState(seed if seed != 0 else 5489)
        _rng_seed[0] = float(seed)
    return prev if prev is not None else NOVAL


@_bi("format")
def format_n(nargout, *args):
    prev = _struct1({"NumericFormat": Char(_format["num"]), "LineSpacing": Char(_format["spacing"])}) if nargout >= 1 else None
    if args and type(args[0]) is Struct:
        d = args[0].a[0]
        _format["num"] = _text(d.get("NumericFormat", Char("short")))
        _format["spacing"] = _text(d.get("LineSpacing", Char("loose")))
    elif args or nargout == 0:
        format_(0, *args)
    return prev if prev is not None else NOVAL


def _class_static(cls, name):
    """uint8.empty, double.empty(0,5): a class's static methods"""
    if name == "empty":
        def empty(nargout, *dims):
            if not dims:
                d = (0, 0)
            else:
                d, _ = _dimsarg(dims, "empty")
                if _prod(d) != 0:
                    raise _err("At least one dimension must be zero.")
            if cls == "cell":
                return Cell([], d)
            if cls == "char":
                return Char(np.zeros(_stored(d)))
            return _filled(d, 0, cls)
        return Builtin(empty, cls + ".empty")
    raise _err("The class %s has no Constant property or Static method named '%s'." % (cls, name))


_CLASSES = ("double", "single", "logical", "char", "cell") + tuple(_INTS)


# ------------------------------------------------------------------ set functions (as their documentation says)
# C is a row vector when the input(s) are row vectors (union and intersect:
# both; setdiff and unique: A), else a column; index outputs are columns;
# 'rows' works on the rows of matrices; NaNs are all distinct; 'stable'
# keeps the order of appearance, else C is sorted.


def _set_items(v, rows):
    """(kind, items) of a set function's input: items are hashable keys"""
    t = type(v)
    if t is Cell:
        return "cell", [_text(e) for e in v.a]
    if t is StrArr or t is Str:
        return "string", list(v.a) if t is StrArr else [v.s]
    if rows:
        M = _mat(v)
        return "rows", [tuple(float(x) for x in r) for r in M]
    A = _arr(v).reshape(-1)
    if A.dtype.kind == "c":
        return "num", [complex(x) for x in A]
    return "num", [float(x) for x in A]


def _is_nan_key(k):
    return k != k if type(k) is float else (type(k) is tuple and any(x != x for x in k))


def _sort_keys(keys):
    if keys and type(keys[0]) is complex:
        return sorted(keys, key=lambda z: (abs(z), _math.atan2(z.imag, z.real)))
    return sorted(keys)


def _set_result(keys, kind, like, row, ncols=None):
    """the set function's C from its keys, in the input's class"""
    n = len(keys)
    if kind == "cell":
        return Cell([Char(k) for k in keys], (1, n) if row else (n, 1))
    if kind == "string":
        return _strarr(keys, (1, n) if row else (n, 1)) if n else StrArr([], (1, 0) if row else (0, 1))
    if kind == "rows":
        M = np.array(keys, dtype=np.float64).reshape((n, ncols))
        out = _unmat(M)
        return _finish(_farr(out), class_(like)) if class_(like) not in ("double", "char", "logical") else (Char(_arr(out)) if class_(like) == "char" else out)
    a = _arr(like)
    arr = np.array(keys, dtype=a.dtype if a.dtype.kind != "b" else np.float64) if n else np.zeros(0, dtype=a.dtype)
    shaped = arr.reshape((n, 1)) if row else arr.reshape((1, n))
    if type(like) is Char:
        return Char(shaped.astype(np.float64))
    if a.dtype.kind == "b":
        return _box(shaped.astype(bool))
    return _box(shaped) if a.dtype.kind in "fc" else _canon(shaped)


def _colvec(vals):
    return _box(np.array([float(v) for v in vals]).reshape((1, len(vals)))) if vals else np.zeros((1, 0))


def _setfn(nargout, op, a, b, opts):
    # (the options these functions take; another word, or a name=value they don't have,
    # is refused rather than ignored)
    flags = []
    distinct = True
    missing_opt = False
    o = list(opts)
    i = 0
    while i < len(o):
        if _istext(o[i]):
            t = _text(o[i]).lower()
            if t == "treatmissingasdistinct" and op == "unique" and i + 1 < len(o):
                missing_opt = True
                v = o[i + 1]
                distinct = _text(v).lower() == "true" if _istext(v) else bool(np.all(_farr(v) != 0))
                i += 2
                continue
            if t not in ("rows", "stable", "sorted", "legacy") + (("first", "last") if op == "unique" else ()):
                raise _err("%s: unsupported option '%s'." % (op, _text(o[i])))
            flags.append(t)
        else:
            raise _err("%s: options must be text; a %s option is not supported." % (op, class_(o[i])))
        i += 1
    if missing_opt and "legacy" in flags:
        # (unique's page: TreatMissingAsDistinct is not supported with 'legacy')
        raise _err("unique: TreatMissingAsDistinct cannot be used with 'legacy'.")
    rows = "rows" in flags
    stable = "stable" in flags
    ka, A = _set_items(a, rows)
    kb, B = _set_items(b, rows) if b is not None else (ka, [])
    kind = ka if ka in ("cell", "string") else (kb if kb in ("cell", "string") else ka)
    def char_rows(v):
        # (a char array with a cell array: each of its rows, trailing blanks removed)
        return [r.rstrip(" ") for r in v.rows()] if type(v) is Char and v.a.size else [_text(v)]
    if kind in ("cell", "string") and (ka != kind or kb != kind) and b is not None:
        A = char_rows(a) if ka not in ("cell", "string") else A
        B = char_rows(b) if kb not in ("cell", "string") else B
    sb = set(B)
    sa = set(A)
    first_a = {}
    for i, k in enumerate(A):
        first_a.setdefault(k, i)
    last_a = {k: i for i, k in enumerate(A)}
    first_b = {}
    for i, k in enumerate(B):
        first_b.setdefault(k, i)
    last_b = {k: i for i, k in enumerate(B)}
    # (the first occurrence, as since R2013a; 'legacy': the last)
    legacy = "legacy" in flags
    pick_a = last_a if legacy else first_a
    pick_b = last_b if legacy else first_b
    nans_a = [i for i, k in enumerate(A) if _is_nan_key(k)]
    nans_b = [i for i, k in enumerate(B) if _is_nan_key(k)]
    if op == "union":
        keys = [k for k in dict.fromkeys(A + B) if not _is_nan_key(k)]
        if stable:
            order = keys
        else:
            order = _sort_keys(keys)
        if legacy:
            # (R2012b's union: a value in both comes from B, each at its last occurrence)
            ia = [pick_a[k] for k in order if k not in sb]
            ib = [pick_b[k] for k in order if k in sb]
        else:
            ia = [pick_a[k] for k in order if k in sa]
            ib = [pick_b[k] for k in order if k not in sa]
        # NaNs: every one, A's then B's
        order = order + [A[i] for i in nans_a] + [B[i] for i in nans_b]
        ia += nans_a
        ib += nans_b
        if not stable:
            # (indices follow C's order)
            pass
        row = _set_isrow(a) and _set_isrow(b)
        outs = [order, ia, ib]
    elif op == "intersect":
        keys = [k for k in dict.fromkeys(A) if k in sb and not _is_nan_key(k)]
        order = keys if stable else _sort_keys(keys)
        outs = [order, [pick_a[k] for k in order], [pick_b[k] for k in order]]
        row = _set_isrow(a) and _set_isrow(b)
    elif op == "setdiff":
        keys = [k for k in dict.fromkeys(A) if k not in sb and not _is_nan_key(k)]
        order = keys if stable else _sort_keys(keys)
        order = order + [A[i] for i in nans_a]
        outs = [order, [pick_a[k] for k in order if not _is_nan_key(k)] + nans_a]
        row = _set_isrow(a)
    else:  # unique
        last = "last" in flags
        if kind in ("num", "rows") and not (A and type(A[0]) is complex):
            # (each element or row a key in which NaN sorts after every number, as sort and
            # sortrows place it; with TreatMissingAsDistinct false the NaNs are equal, so rows
            # match on their other entries, else each NaN is its own key, in place when stable)
            def ukey(i, k):
                base = tuple((1, 0.0) if x != x else (0, x) for x in (k if type(k) is tuple else (k,)))
                return base + ((i,),) if distinct and _is_nan_key(k) else base
            cks = [ukey(i, k) for i, k in enumerate(A)]
            first_c, last_c = {}, {}
            for i, c in enumerate(cks):
                first_c.setdefault(c, i)
                last_c[c] = i
            order_c = list(dict.fromkeys(cks))
            if not stable:
                order_c.sort()
            pick = last_c if (last or legacy) else first_c
            ia = [pick[c] for c in order_c]
            pos = {c: j for j, c in enumerate(order_c)}
            ic = [pos[c] for c in cks]
            order = [A[i] for i in ia]
        else:
            keys = [k for k in dict.fromkeys(A) if not _is_nan_key(k)]
            order = keys if stable else _sort_keys(keys)
            pick = last_a if (last or legacy) else first_a
            if nans_a and not distinct:
                nans_a = [nans_a[-1] if (last or legacy) else nans_a[0]]
            ia = [pick[k] for k in order] + nans_a
            pos = {k: j for j, k in enumerate(order)}
            ic = []
            nk = 0
            for k in A:
                if _is_nan_key(k):
                    ic.append(len(order) + (nk if distinct else 0))
                    nk += 1
                else:
                    ic.append(pos[k])
            order = order + [A[i] for i in nans_a]
        outs = [order, ia, ic]
        d = _dims(a)
        row = len(d) == 2 and d[0] == 1 and not rows
        if d == (0, 0) and kind == "num":
            empty = _empty_like(a) if type(a) is not np.ndarray else np.zeros((0, 0), dtype=_arr(a).dtype)
            return empty if nargout <= 1 else [empty, np.zeros((0, 1)), np.zeros((0, 1))][:nargout]
    if rows:
        row = False
    ncols = _dims(a)[1] if rows else None
    like = a if kind == ka else b
    C = _set_result(outs[0], kind, like, row, ncols)
    if nargout <= 1:
        return C
    if legacy:
        # (R2012b's index vectors follow the inputs: rows for row vectors, else columns; stored
        # transposed, as every 2-D array here: a MATLAB row is an (n, 1) array)
        shp = (lambda n: (n, 1)) if row else (lambda n: (1, n))
        return [C] + [_box(np.array([float(i + 1) for i in v]).reshape(shp(len(v)))) if v else np.zeros(shp(0)) for v in outs[1:nargout]]
    return [C] + [_colvec([i + 1 for i in v]) for v in outs[1:nargout]]


def _set_isrow(v):
    d = _dims(v)
    return len(d) == 2 and d[0] == 1 and _numel(v) > 0 or (type(v) is Char and d[0] == 1)


@_bi("union")
def union_s(nargout, a, b, *opts):
    return _setfn(nargout, "union", a, b, opts)


@_bi("intersect")
def intersect_s(nargout, a, b, *opts):
    return _setfn(nargout, "intersect", a, b, opts)


@_bi("setdiff")
def setdiff_s(nargout, a, b, *opts):
    return _setfn(nargout, "setdiff", a, b, opts)


@_bi("unique")
def unique_s(nargout, a, *opts):
    return _setfn(nargout, "unique", a, None, opts)


@_bi("ismember")
def ismember_s(nargout, a, s, *opts):
    rows = any(_istext(o) and _text(o).lower() == "rows" for o in opts)
    if type(a) in (Cell, StrArr, Str) or type(s) in (Cell, StrArr, Str) or (type(a) is Char and type(s) is not Char and type(s) is not np.ndarray):
        S = [_text(e) if type(e) is not str else e for e in (s.a if type(s) in (Cell, StrArr) else [s])]
        pos = {}
        for i, k in enumerate(S):
            pos.setdefault(k, i + 1)
        if type(a) in (Cell, StrArr):
            keys = [_text(e) if type(e) is not str else e for e in a.a]
            tf = _box(np.array([k in pos for k in keys], dtype=bool).reshape(_stored(a.shape)))
            loc = _box(np.array([float(pos.get(k, 0)) for k in keys]).reshape(_stored(a.shape)))
        else:
            k = _text(a)
            tf, loc = k in pos, float(pos.get(k, 0))
        return tf if nargout <= 1 else [tf, loc]
    if rows:
        A = [tuple(float(x) for x in r) for r in _mat(a)]
        B = [tuple(float(x) for x in r) for r in _mat(s)]
        pos = {}
        for i, k in enumerate(B):
            pos.setdefault(k, i + 1)
        tf = _box(np.array([k in pos for k in A], dtype=bool).reshape((1, len(A))))
        loc = _box(np.array([float(pos.get(k, 0)) for k in A]).reshape((1, len(A))))
        return tf if nargout <= 1 else [tf, loc]
    A = _farr(a)
    # (Locb: the lowest index, or with "legacy" the highest, as R2012b gave; NaN is a member of nothing)
    legacy = any(_istext(o) and _text(o).lower() == "legacy" for o in opts)
    pos = {}
    for i, v in enumerate(_farr(s).reshape(-1)):
        k = complex(v) if np.iscomplexobj(v) else float(v)
        if k != k:
            continue
        if legacy:
            pos[k] = i + 1
        else:
            pos.setdefault(k, i + 1)
    keys = [complex(v) if A.dtype.kind == "c" else float(v) for v in A.reshape(-1)]
    # (NaN equals nothing, so it is never a member: ismember([5 NaN], [5 NaN]) is [1 0])
    tf = _box(np.array([k == k and k in pos for k in keys], dtype=bool).reshape(A.shape))
    if nargout <= 1:
        return tf
    return [tf, _box(np.array([float(pos.get(k, 0)) if k == k else 0.0 for k in keys]).reshape(A.shape))]


# ------------------------------------------------------------------ accumarray, bitshift, interp1, cond, ... (from the documentation's examples)


@_bi("accumarray")
def accumarray_n(nargout, subs, vals, sz=None, func=None, fill=None, issparse=None):
    S = _mat(subs)
    if S.shape[0] == 1 and _numel(vals) != 1 and S.shape[1] == _numel(vals):
        S = S.T
    S = S.astype(np.int64)
    V = vals
    n = S.shape[0]
    nd = S.shape[1]
    if sz is not None and _numel(sz):
        dims = [int(x) for x in _arr(sz).reshape(-1)]
    else:
        dims = [int(np.max(S[:, k])) for k in range(nd)] if n else [0] * nd
    if nd == 1:
        dims = [dims[0], 1]
    # the groups: subscripts -> the values, in the order given
    groups = {}
    order = []
    vflat = list(_arr(V).reshape(-1)) if _numel(V) != 1 else None
    for i in range(n):
        key = tuple(int(x) for x in S[i])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(i)
    total = _prod(dims)
    use_cell = False
    results = {}
    cls = class_(V)
    for key in order:
        idx = groups[key]
        if func is None or _numel(func) == 0:
            if vflat is None:
                r = _scalar(V) * len(idx)
            else:
                r = sum(float(vflat[i]) for i in idx)
            results[key] = r
        else:
            # (the group's values as a column, in their order)
            col = index(V, [np.array([float(i + 1) for i in idx]).reshape((1, len(idx)))]) if vflat is not None else _filled((len(idx), 1), _scalar(V), "double")
            if _isvec(col) and _dims(col)[0] == 1 and len(idx) > 1:
                col = transpose(col)
            r = _call(func, [col])
            if type(r) is Cell:
                use_cell = True
            results[key] = r
    lin = lambda key: sum((key[k] - 1) * _prod(dims[:k]) for k in range(len(key))) if nd > 1 else key[0] - 1
    if use_cell:
        items = [np.zeros((0, 0)) for _ in range(total)]
        for key, r in results.items():
            items[lin(key)] = r.a[0] if type(r) is Cell and len(r.a) == 1 else r
        return Cell(items, dims)
    fillv = _scalar(fill) if fill is not None and _numel(fill) else 0.0
    out = np.full(total, fillv)
    for key, r in results.items():
        out[lin(key)] = _scalar(r)
    shaped = out.reshape(_stored(dims))
    rcls = class_(next(iter(results.values()))) if results and func is not None and _numel(func) else ("double" if cls in ("logical", "char") else cls)
    return _finish(_canon(shaped), rcls if rcls in _INTS or rcls in ("single", "double") else "double")


@_bi("bitshift")
def bitshift_n(nargout, a, k, assumedtype=None):
    cls = _text(assumedtype) if assumedtype is not None else class_(a)
    if cls not in _INTS:
        cls = "uint64" if cls == "double" else cls
    bits = int(cls.lstrip("uint")) if cls in _INTS else 53
    A, K = np.broadcast_arrays(_farr(a), _farr(k))
    signed = not cls.startswith("u")
    out = []
    for x, s in zip(A.reshape(-1), K.reshape(-1)):
        x = int(x)
        s = int(s)
        r = x << s if s >= 0 else x >> -s
        # (the bits shifted out are lost: masked to the type's width)
        r &= (1 << bits) - 1
        if signed and r >= 1 << (bits - 1):
            r -= 1 << bits
        out.append(float(r))
    r = np.array(out).reshape(A.shape)
    if class_(a) in _INTS:
        return _finish(r, class_(a))
    return _box(r)


def _pchip_slopes(x, y):
    """Fritsch-Carlson slopes (the shape-preserving piecewise cubic)"""
    n = len(x)
    h = [x[k + 1] - x[k] for k in range(n - 1)]
    delta = [(y[k + 1] - y[k]) / h[k] for k in range(n - 1)]
    d = [0.0] * n
    if n == 2:
        return [delta[0], delta[0]]
    for k in range(1, n - 1):
        if delta[k - 1] * delta[k] > 0:
            w1 = 2 * h[k] + h[k - 1]
            w2 = h[k] + 2 * h[k - 1]
            d[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k])
        else:
            d[k] = 0.0

    def end(h0, h1, d0, d1):
        s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
        if (s > 0) != (d0 > 0) or s == 0 and False:
            return 0.0
        if (d0 > 0) != (d1 > 0) and abs(s) > abs(3 * d0):
            return 3 * d0
        return s
    d[0] = end(h[0], h[1], delta[0], delta[1])
    d[-1] = end(h[-1], h[-2], delta[-1], delta[-2])
    return d


def _spline_slopes(x, y, dense=None):
    """the not-a-knot cubic spline's first derivatives (dense(), when given, is called before a
    dense solve, to admit its work)"""
    n = len(x)
    if n == 2:
        s = (y[1] - y[0]) / (x[1] - x[0])
        return [s, s]
    if n == 3:
        # (the parabola through the points)
        h0, h1 = x[1] - x[0], x[2] - x[1]
        d0, d1 = (y[1] - y[0]) / h0, (y[2] - y[1]) / h1
        c = (d1 - d0) / (h0 + h1)
        return [d0 - c * h0, d0 + c * h0, d1 + c * h1]
    h = [x[k + 1] - x[k] for k in range(n - 1)]
    delta = [(y[k + 1] - y[k]) / h[k] for k in range(n - 1)]
    sub, diag, sup, r = [0.0] * n, [0.0] * n, [0.0] * n, [0.0] * n
    diag[0], sup[0] = h[1], h[0] + h[1]
    r[0] = ((h[0] + 2 * (h[0] + h[1])) * h[1] * delta[0] + h[0] ** 2 * delta[1]) / (h[0] + h[1])
    for k in range(1, n - 1):
        sub[k], diag[k], sup[k] = h[k], 2 * (h[k - 1] + h[k]), h[k - 1]
        r[k] = 3 * (h[k] * delta[k - 1] + h[k - 1] * delta[k])
    sub[n - 1], diag[n - 1] = h[-1] + h[-2], h[-2]
    r[n - 1] = (h[-1] ** 2 * delta[-2] + (2 * (h[-2] + h[-1]) + h[-1]) * h[-2] * delta[-1]) / (h[-2] + h[-1])
    # (the system is tridiagonal: solved in its band, with numpy.linalg.solve's values, unless
    # an entry is not finite, whose dense results are kept)
    if all(_math.isfinite(v) for band in (sub, diag, sup) for v in band):
        import _matlab_numeric
        return _matlab_numeric._tridiag_solve(sub, diag, sup, r)
    if dense is not None:
        dense()
    A = np.zeros((n, n))
    A[0, 0], A[0, 1] = diag[0], sup[0]
    for k in range(1, n - 1):
        A[k, k - 1], A[k, k], A[k, k + 1] = sub[k], diag[k], sup[k]
    A[n - 1, n - 2], A[n - 1, n - 1] = sub[n - 1], diag[n - 1]
    return list(np.linalg.solve(A, np.array(r)))


def _hermite(x, y, d, q, k=None):
    """the piecewise cubic with values y and slopes d at q (extrapolating with the end pieces);
    k, when given, is q's piece"""
    if k is None:
        n = len(x)
        k = int(np.searchsorted(np.array(x), q, side="right")) - 1
        k = min(max(k, 0), n - 2)
    h = x[k + 1] - x[k]
    t = (q - x[k]) / h
    h00 = (1 + 2 * t) * (1 - t) ** 2
    h10 = t * (1 - t) ** 2
    h01 = t * t * (3 - 2 * t)
    h11 = t * t * (t - 1)
    return h00 * y[k] + h10 * h * d[k] + h01 * y[k + 1] + h11 * h * d[k + 1]


# (the most queries times columns interp1's cubic methods evaluate, one point at a time, and
# the most samples times columns they set up slopes for; and the most n^3 times columns, for n
# samples, of the spline's dense solves, made only when its system has an entry that is not
# finite)
_INTERP1_CUBIC_POINTS = 1_000_000
_INTERP1_SPLINE_WORK = 1_000_000_000
# (and the most samples times columns of a spline, whose setup and banded solve are slower)
_INTERP1_SPLINE_SETUP = 200_000


@_bs("interp1")
def interp1_n(*args):
    args = list(args)
    method = "linear"
    extrap = None
    # (trailing options: a method name, 'extrap' or a value outside the domain)
    methods = []
    while args and (_istext(args[-1]) or (len(args) >= 4 and not _istext(args[-1]) and _istext(args[-2]))):
        a = args.pop()
        if _istext(a):
            t = _text(a).lower()
            if t == "extrap":
                extrap = "extrap"
            elif t == "makima":
                raise _err("interp1: the 'makima' method is not supported in Sagebrush; for double values, 'pchip' and 'spline' are.")
            elif t == "pp":
                raise _err("interp1: the piecewise polynomial form, interp1(..., 'pp'), is not supported in Sagebrush.")
            elif t in ("linear", "nearest", "next", "previous", "pchip", "cubic", "spline", "*linear", "*cubic"):
                methods.append({"*linear": "linear", "cubic": "pchip", "*cubic": "pchip"}.get(t, t))
            else:
                raise _err("interp1: invalid interpolation method '%s'." % _text(a))
        else:
            if _numel(a) != 1 or class_(a) not in ("double", "single") or _arr(a).dtype.kind == "c":
                # (the page's extrapolation value is a real scalar)
                raise _err("interp1: the extrapolation value must be a real double or single scalar in Sagebrush.")
            extrap = a
    if len(methods) > 1:
        raise _err("interp1: only one interpolation method may be given.")
    if methods:
        method = methods[0]
    for a in args[:3]:
        if class_(a) not in ("double", "single"):
            raise _err("interp1 of %s input is not supported; x, v and xq are double or single, as its page says." % class_(a))
    single = _float_class(*args[:3]) == "single"
    # (which of x, v and xq are single: a step of the linear formula is single when an operand is)
    x_single, v_single, q_single = (False, class_(args[0]) == "single", class_(args[1]) == "single") \
        if len(args) == 2 else tuple(class_(a) == "single" for a in args[:3])
    if single and method in ("pchip", "spline", "makima"):
        raise _err("interp1's '%s' method with single values is not supported in Sagebrush: its slopes would "
                   "have to be computed in single arithmetic at each step." % method)
    if len(args) == 2:
        v, xq = args
        n = _dims(v)[0] if not _isvec(v) else _numel(v)
        x = np.arange(1.0, n + 1)
    else:
        x, v, xq = args[0], args[1], args[2]
        x = _farr(x).reshape(-1)
    X = list(float(t) for t in x)
    vec = _isvec(v)
    V = _mat(v)
    if vec:
        V = V.reshape((-1, 1))
    # (the sample points: one per value, at least two, distinct and not NaN, as the page requires)
    if len(X) != V.shape[0]:
        raise _err("interp1: the sample points and the values must have the same length.")
    if len(X) < 2:
        raise _err("interp1: at least two sample points are required.")
    if any(t != t for t in X):
        raise _err("interp1: the sample points must not be NaN.")
    order = sorted(range(len(X)), key=lambda k: X[k])
    X = [X[k] for k in order]
    V = V[order]
    if any(X[k] == X[k + 1] for k in range(len(X) - 1)):
        raise _err("interp1: the grid vectors must contain unique points.")
    Q = _farr(xq)
    if Q.dtype.kind == "c":
        raise _err("interp1 at complex query points is not supported in Sagebrush.")
    qs = Q.reshape(-1).astype(np.float64)
    if single and qs.size * V.shape[1] > _SINGLE_STEPS_WORK:
        raise _err("interp1 at %d query points for %d column%s of values is not supported in Sagebrush: "
                   "too much work." % (qs.size, V.shape[1], "s" * (V.shape[1] != 1)))
    cubic = method in ("pchip", "spline", "makima")
    if cubic:
        # (the slopes are set up one sample at a time, a complex column as two real ones; a
        # spline's tridiagonal system is solved in its band, but densely when an entry is not
        # finite: n^2 entries and about n^3 steps for n samples, admitted by dense() below)
        cols = V.shape[1] * (2 if V.dtype.kind == "c" else 1)
        if qs.size * V.shape[1] > _INTERP1_CUBIC_POINTS:
            raise _err("interp1's '%s' method at %d query points for %d column%s of values is not supported "
                       "in Sagebrush: too much work." % (method, qs.size, V.shape[1], "s" * (V.shape[1] != 1)))
        if len(X) * cols > (_INTERP1_SPLINE_SETUP if method == "spline" else _INTERP1_CUBIC_POINTS):
            raise _err("interp1's '%s' method with %d sample points for %d column%s of values is not "
                       "supported in Sagebrush: too much work." % (method, len(X), V.shape[1], "s" * (V.shape[1] != 1)))

    def dense():
        # (a spline whose system has an entry that is not finite is solved densely: its work)
        if len(X) ** 3 * cols > _INTERP1_SPLINE_WORK:
            raise _err("interp1's 'spline' method with %d sample points for %d column%s of values is not "
                       "supported in Sagebrush: its dense solve would be too much work." % (len(X), V.shape[1], "s" * (V.shape[1] != 1)))
    out = np.zeros((qs.size, V.shape[1]), dtype=V.dtype if V.dtype.kind == "c" else np.float64)
    lo, hi = X[0], X[-1]
    Xa = np.array(X)
    nanq = qs != qs
    outside = (qs < lo) | (qs > hi) | nanq
    if extrap is not None and extrap != "extrap":
        fill, fv = outside, _scalar(extrap)
    else:
        fill, fv = (outside if extrap != "extrap" and not cubic else np.zeros(qs.size, dtype=bool)), _math.nan
    # (a NaN query that is not filled gives NaN; the rest are interpolated)
    nan_left = nanq & ~fill
    live = ~(fill | nan_left)
    k = np.clip(np.searchsorted(Xa, qs, side="right") - 1, 0, len(X) - 2)
    xk, xk1 = Xa[k], Xa[k + 1]
    def lin(y0, y1):
        if single:
            # (the piece's slope times the query's distance from the piece's start, plus the
            # start value; each step single when an operand is. Of the usual forms, this one
            # alone matched Octave's results on queries chosen so that the forms all differ)
            R = lambda z, on: _single_values(z) if on else z
            sl = R(R(y1 - y0, v_single) / R(xk1 - xk, x_single), v_single or x_single)
            dq = R(qs - xk, q_single or x_single)
            return R(R(sl * dq, True) + y0, True)
        t = (qs - xk) / (xk1 - xk)
        return y0 + t * (y1 - y0)

    # (every query is computed, and the filled ones replaced afterwards)
    with np.errstate(all="ignore"):
        for j in range(V.shape[1]):
            col = V[:, j]
            if cubic:
                y = [col[t] for t in range(len(X))]
                if V.dtype.kind == "c":
                    dr = _pchip_slopes(X, [z.real for z in y]) if method == "pchip" else _spline_slopes(X, [z.real for z in y], dense)
                    di = _pchip_slopes(X, [z.imag for z in y]) if method == "pchip" else _spline_slopes(X, [z.imag for z in y], dense)
                    d = [complex(a, b) for a, b in zip(dr, di)]
                else:
                    d = _pchip_slopes(X, [float(t) for t in y]) if method == "pchip" else _spline_slopes(X, [float(t) for t in y], dense)
                vals = np.zeros(qs.size, dtype=out.dtype)
                for i in np.flatnonzero(live):
                    vals[i] = _hermite(X, y, d, float(qs[i]), int(k[i]))
            else:
                yk, yk1 = col[k], col[k + 1]
                if method == "nearest":
                    vals = np.where((qs - xk) < (xk1 - qs), yk, yk1)
                elif method == "previous":
                    vals = np.where(qs >= xk1, yk1, yk)
                elif method == "next":
                    vals = np.where(qs <= xk, yk, yk1)
                elif V.dtype.kind == "c":
                    # (a complex v is interpolated in its real and imaginary parts separately, x
                    # and xq being real: an Inf or NaN in one part leaves the other part as it is)
                    vals = np.empty(qs.size, dtype=np.complex128)
                    vals.real = lin(yk.real, yk1.real)
                    vals.imag = lin(yk.imag, yk1.imag)
                else:
                    vals = lin(yk, yk1)
            out[:, j] = np.where(fill, fv, np.where(nan_left, _math.nan, vals))
    r = _box(out.reshape(-1).reshape(Q.shape)) if vec else _unmat(out)
    # (a matrix of values: one column per column of v, a row per query; single if an input is)
    return _finish(_farr(r), "single") if single else r


@_bs("cond")
def cond_n(x, p=None):
    if p is None or (not _istext(p) and _scalar(p) == 2):
        M = _mat(x)
        s = np.linalg.svd(M, compute_uv=False)
        return float(s[0] / s[-1]) if s[-1] != 0 else _math.inf
    return norm_(x, p) * norm_(inv_(x), p)


@_bs("char")
def char_n(*args):
    if len(args) == 1:
        return char_(*args)
    rows = []
    for x in args:
        if type(x) is Cell:
            rows.extend(_text(e) for e in x.a)
        elif type(x) is Char:
            rows.extend(x.rows() if x.a.size else [""])
        elif type(x) is Str:
            rows.append(x.s)
        elif type(x) is StrArr:
            rows.extend(x.a)
        else:
            # (a numeric matrix: one row of characters per row)
            M = _mat(x)
            rows.extend("".join(chr(int(c)) for c in r) for r in M)
    return _pad_rows(rows)


def func2str_text2(f):
    if type(f) is Anon:
        return f.text
    return f.name


@_bs("func2str")
def func2str_n(f):
    # (a named handle's text is its name: func2str(@cos) is 'cos')
    if not _iscallable(f):
        raise _err("Input argument must be a function handle.")
    return Char(func2str_text2(f))


def _class_value(name, dbl, sgl):
    def g(nargout, *args):
        cls = _text(args[0]) if args and _istext(args[0]) else "double"
        if cls == "single":
            return _canon(np.array([[sgl]], dtype=np.float32))
        return dbl
    _B[name] = Builtin(g, name)


# (realmax, realmin and flintmax: _float_limit, with the class names and 'like')

_eps_old = _B["eps"].f


def _eps_n(nargout, *args):
    if args and _istext(args[0]) and _text(args[0]) == "single":
        return _canon(np.array([[1.1920928955078125e-07]], dtype=np.float32))
    if args and class_(args[0]) == "single":
        x = abs(float(_arr(args[0]).reshape(-1)[0]))
        e = _math.frexp(x)[1] if x else -125
        return _canon(np.array([[_math.ldexp(1.0, e - 24)]], dtype=np.float32))
    return _eps_old(nargout, *args)


_B["eps"] = Builtin(_eps_n, "eps")


@_bs("factor")
def factor_n(n):
    cls = class_(n)
    m = int(_scalar(n))
    out = []
    d = 2
    while d * d <= m:
        while m % d == 0:
            out.append(float(d))
            m //= d
        d += 1
    if m > 1 or not out:
        out.append(float(m))
    r = np.array(out).reshape((len(out), 1))
    return _finish(r, cls) if cls in _INTS or cls == "single" else _box(r)


_HREF = _re.compile(r'<a\s+href\s*=\s*"[^"]*"\s*>(.*?)</a>', _re.S)


def _strip_links(s):
    """MATLAB's hyperlinks (<a href="...">text</a>) as their text, as a terminal shows them"""
    return _HREF.sub(lambda m: m.group(1), s) if "<a" in s else s


def intlit(digits, radix, cls):
    """a hex or binary literal (0x87u32): an integer of the smallest unsigned type that holds it"""
    v = int(digits, radix)
    if not cls:
        bits = len(digits) * (4 if radix == 16 else 1)
        cls = "uint8" if bits <= 8 else "uint16" if bits <= 16 else "uint32" if bits <= 32 else "uint64"
    elif cls.startswith("int"):
        # (a signed suffix: the bits as a two's complement number)
        w = int(cls[3:])
        if v >= 1 << (w - 1):
            v -= 1 << w
    return np.array([[_exact_int(v)]], dtype=_INTS[cls][0])


def _exact_int(v):
    """v, if Sagebrush's 64-bit integers hold it exactly (they keep 53 bits, as doubles
    do); a value they would round is refused, not changed"""
    if float(v) != v:
        raise _err("Integers beyond 2^53 in magnitude (here %d) are not supported: Sagebrush's 64-bit integers are not exact there." % v)
    return v


def declit(text, cls):
    """int64 or uint64 of a decimal integer literal: its exact value (saturated), not the
    nearest double's"""
    lo, hi = (-(1 << 63), (1 << 63) - 1) if cls == "int64" else (0, (1 << 64) - 1)
    return np.array([[_exact_int(min(max(int(text), lo), hi))]], dtype=_INTS[cls][0])


_BYTES = {"double": 8, "single": 4, "logical": 1, "char": 2, "int8": 1, "uint8": 1, "int16": 2, "uint16": 2,
          "int32": 4, "uint32": 4, "int64": 8, "uint64": 8}


def _bytes(v):
    if type(v) is Sparse:
        return _sp.nbytes(v)
    c = class_(v)
    if c in _BYTES:
        return _numel(v) * _BYTES[c] * (2 if _isnumlike(v) and _arr(v).dtype.kind == "c" else 1)
    if type(v) is Cell:
        return sum(_bytes(e) + 112 for e in v.a)
    if type(v) is Struct:
        return sum(_bytes(x) + 112 for d in v.a for x in d.values()) + 64 * len(v.fields)
    if type(v) in (Str, StrArr):
        return 150 + sum(2 * len(x or "") for x in (v.a if type(v) is StrArr else [v.s]))
    return 8


# ------------------------------------------------------------------ load and save (.mat files: lib/_matlab_mat.py; text with -ascii)


def _matfile(name, ns, args, nargout):
    import _matlab_mat as mat
    words = [_text(a) for a in args]
    flags = [w.lower() for w in words if w.startswith("-")]
    rest = [w for w in words if not w.startswith("-")]
    if name == "load":
        return _load(mat, ns, rest, flags, nargout)
    return _save(mat, ns, rest, flags, args)


def _mat_path(f, must_exist):
    import os
    if os.path.splitext(f)[1] == "" and not (must_exist and os.path.exists(f)):
        return f + ".mat"
    return f


def _load(mat, ns, rest, flags, nargout):
    import os
    if not rest:
        rest = ["matlab.mat"]
    fname = rest[0]
    names = rest[1:]
    path = _mat_path(fname, True)
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        raise _err("Unable to find file or directory '%s'." % fname, "MATLAB:load:couldNotReadFile")
    ascii_ = "-ascii" in flags or (not data[126:128] in (b"IM", b"MI") and "-mat" not in flags and not path.endswith(".mat"))
    if ascii_:
        rows = []
        for line in data.decode("latin1").splitlines():
            line = line.split("%")[0].strip()
            if not line:
                continue
            rows.append([float(x) for x in _re.split(r"[\s,]+", line) if x])
        if rows and any(len(r) != len(rows[0]) for r in rows):
            raise _err("Number of columns on line %d of ASCII file %s must be the same as previous lines." % (2, fname))
        value = _unmat(np.array(rows, dtype=np.float64)) if rows else np.zeros((0, 0))
        if nargout >= 1:
            return value
        var = _re.sub(r"\W", "_", os.path.splitext(os.path.basename(fname))[0])
        if not var or not var[0].isalpha():
            var = "X" + var
        _ws_set(ns, var, value)
        return NOVAL
    try:
        variables = mat.read(data)
    except mat.MatError as e:
        raise _err("Unable to read MAT-file %s: %s." % (fname, e), "MATLAB:load:unableToReadMatFile")
    if names:
        variables = [x for x in variables if any(_glob_match(n, x[0]) for n in names)]
        for n in names:
            if "*" not in n and not any(x[0] == n for x in variables):
                warning_("Variable '%s' not found." % n)
    if nargout >= 1:
        return _struct1({n: v for n, v, _ in variables})
    for n, v, g in variables:
        if g:
            global_set(n, v)
        _ws_set(ns, n, v)
    return NOVAL


def _ws_set(ns, name, v):
    key = "_k_" + name if name in _PYKW else name
    if ns is not _workspace_globals_check(ns):
        raise _err("load can only create variables in a script or the Command Window here: use S = load(...) in a function.")
    ns[key] = v


def _workspace_globals_check(ns):
    # (a function's locals() is a copy: assignments to it do not reach its variables)
    return ns if "__name__" in ns else None


def _save(mat, ns, rest, flags, args):
    import os
    fname = rest[0] if rest else "matlab.mat"
    names = rest[1:]
    if "-struct" in flags:
        # save(f, '-struct', 's' [, fields]): the fields of s as variables
        sname = names[0]
        s = ns.get("_k_" + sname if sname in _PYKW else sname)
        if type(s) is not Struct or len(s.a) != 1:
            raise _err("The argument to -STRUCT must be the name of a scalar structure variable.")
        fields = names[1:] or s.fields
        variables = [(f, s.a[0][f]) for f in fields]
    else:
        allv = _ws_vars(ns)
        if names:
            chosen = []
            for n in names:
                hit = [v for v in allv if _glob_match(n, v)]
                if not hit:
                    raise _err("Variable '%s' not found." % n, "MATLAB:save:couldNotWriteFile")
                chosen.extend(h for h in hit if h not in chosen)
        else:
            chosen = allv
        variables = [(v, ns["_k_" + v if v in _PYKW else v]) for v in chosen]
        variables = [(n, v) for n, v in variables if not _iscallable(v) or type(v) in (Anon, Handle)]
    if "-ascii" in flags:
        digits = 16 if "-double" in flags else 8
        sep = "\t" if "-tabs" in flags else "   "
        lines = []
        for n, v in variables:
            if not _isnumlike(v):
                warning_("Attempt to write an unsupported data type to an ASCII file. Variable '%s' not written to file." % n)
                continue
            M = _mat(v)
            for row in M:
                lines.append("".join(sep + ("% .*e" % (digits - 1, float(x))) for x in row))
        with open(fname, "w") as fh:
            fh.write("\n".join(lines) + ("\n" if lines else ""))
        return NOVAL
    if "-v7.3" in flags:
        raise _err("Saving -v7.3 (HDF5) files is not supported: use -v7.")
    path = _mat_path(fname, False)
    existing = []
    if "-append" in flags and os.path.exists(path):
        with open(path, "rb") as fh:
            existing = [(n, v) for n, v, _ in mat.read(fh.read()) if n not in {x[0] for x in variables}]
    data = mat.write(existing + variables, compress="-v6" not in flags and "-v4" not in flags)
    with open(path, "wb") as fh:
        fh.write(data)
    return NOVAL


# ------------------------------------------------------------------ files and folders

import os as _os


@_bs("filesep")
def filesep_():
    return Char("/")


@_bs("pathsep")
def pathsep_():
    return Char(":")


@_bs("fullfile")
def fullfile_(*parts):
    names = []
    for p in parts:
        t = _text(p) if _istext(p) else None
        if t is None:
            raise _err("All inputs must be strings, character vectors, or cell arrays of character vectors.")
        if t:
            names.append(t)
    if not names:
        return Char("")
    out = names[0]
    for t in names[1:]:
        out = out.rstrip("/") + "/" + t.lstrip("/") if out else t
    out = _re.sub(r"/+", "/", out)
    return Str(out) if any(type(p) is Str for p in parts) else Char(out)


@_bi("fileparts")
def fileparts_(nargout, f):
    if type(f) is StrArr:
        # (a string array: each element's parts, three string arrays of its size)
        if None in f.a:
            raise _err("fileparts of a string array with missing elements is not supported in Sagebrush.")
        parts = [[_text(x) for x in fileparts_(3, Str(e))] for e in f.a]
        out = [StrArr([p[k] for p in parts], f.shape) for k in range(3)]
        return out[0] if nargout <= 1 else out[:nargout]
    t = _text(f)
    d, base = (t.rsplit("/", 1) if "/" in t else ("", t))
    if "/" in t and d == "":
        d = "/"
    # (the extension starts at the last "."; a dotfile, "/home/jsmith/.cshrc", is all extension, as its page shows)
    name, ext = (base.rsplit(".", 1) if "." in base else (base, None))
    ext = "." + ext if ext is not None else ""
    mk = (lambda s: Str(s)) if type(f) is Str else (lambda s: Char(s))
    out = [mk(d), mk(name), mk(ext)]
    return out[0] if nargout <= 1 else out[:nargout]


@_bs("tempdir")
def tempdir_():
    d = _os.environ.get("TMPDIR", "/tmp")
    return Char(d.rstrip("/") + "/")


_tmp_count = [0]


@_bs("tempname")
def tempname_(d=None):
    import random
    _tmp_count[0] += 1
    base = _text(d) if d is not None else _os.environ.get("TMPDIR", "/tmp")
    return Char(base.rstrip("/") + "/tp%08x_%d" % (random.getrandbits(32), _tmp_count[0]))


@_bs("pwd")
def pwd_():
    return Char(_os.getcwd())


@_bi("cd")
def cd_(nargout, d=None):
    old = _os.getcwd()
    if d is not None:
        t = _text(d)
        try:
            _os.chdir(_os.path.expanduser(t))
        except OSError:
            raise _err("Cannot CD to %s (Name is nonexistent or not a directory)." % t, "MATLAB:cd:NonExistentFolder")
    return Char(old) if nargout >= 1 or d is None else NOVAL


def _path_test(f, test):
    """test on a name, or element by element on a string or cell array of names"""
    if type(f) in (StrArr, Cell):
        return _box(np.array([test(_text(e) if type(e) is not str else e) for e in f.a], dtype=bool).reshape(_stored(f.shape)))
    return test(_text(f))


@_bs("isfile")
def isfile_(f):
    return _path_test(f, _os.path.isfile)


@_bs("isfolder")
def isfolder_(f):
    return _path_test(f, _os.path.isdir)


@_bi("mkdir")
def mkdir_(nargout, *args):
    path = "/".join(_text(a) for a in args)
    existed = _os.path.isdir(path)
    try:
        _os.makedirs(path, exist_ok=True)
        ok = True
    except OSError:
        ok = False
    if existed and nargout == 0:
        warning_("Directory already exists.", "MATLAB:MKDIR:DirectoryExists")
    return [ok, Char("Directory already exists." if existed else ""), Char("MATLAB:MKDIR:DirectoryExists" if existed else "")][:nargout] if nargout > 1 else (ok if nargout == 1 else NOVAL)


@_bi("rmdir")
def rmdir_(nargout, d, *opts):
    import shutil
    t = _text(d)
    try:
        if opts and _text(opts[0]) == "s":
            shutil.rmtree(t)
        else:
            _os.rmdir(t)
        ok = True
    except OSError:
        ok = False
        if nargout == 0:
            raise _err("No directories were removed.")
    return ok if nargout >= 1 else NOVAL


@_bi("delete")
def delete_(nargout, *files):
    for f in files:
        if isinstance(f, HandleObj) or type(f) is HandleArr:
            for o in _handles(f):
                o.delete()
            continue
        t = _text(f)
        if "*" in t or "?" in t:
            d, pat = (t.rsplit("/", 1) if "/" in t else (".", t))
            for name in _os.listdir(d):
                if _glob_match(pat, name):
                    _os.remove(_os.path.join(d, name))
            continue
        try:
            _os.remove(t)
        except OSError:
            warning_("File '%s' not found." % t)
    return NOVAL


@_bi("type")
def type_(nargout, *names):
    """type filename: the file's contents, as type's page describes it; a name without an extension
    that does not exist is tried as .m (Sagebrush does not read .mlx and .mlapp files)"""
    for f in names:
        t = _text(f)
        path = t
        if not _os.path.isfile(path) and not _os.path.splitext(t)[1]:
            for ext in (".mlx", ".mlapp", ".m"):
                if _os.path.isfile(t + ext):
                    path = t + ext
                    break
        if _os.path.splitext(path)[1] in (".mlx", ".mlapp") and _os.path.isfile(path):
            raise _err("type: Sagebrush does not read %s files (Live Scripts and apps) yet." % _os.path.splitext(path)[1])
        if not _os.path.isfile(path):
            raise _err("File '%s' not found." % t)
        with open(path, errors="replace") as fh:
            text = fh.read()
        _write(text if text.endswith("\n") or not text else text + "\n")
    return NOVAL


@_bs("fileread")
def fileread_(f, *opts):
    t = _text(f)
    try:
        with open(t) as fh:
            return Char(fh.read())
    except OSError:
        raise _err("Could not open file %s. No such file or directory." % t, "MATLAB:fileread:cannotOpenFile")


class _MFile:
    __slots__ = ("fh", "name", "mode")


_next_fid = [3]


@_bi("fopen")
def fopen_(nargout, f, mode=None, *rest):
    # (fopen(fid): a file's name; a file name, which as a char array is numlike too, opens it)
    if not _istext(f) and _isnumlike(f) and _scalar(f) == _math.floor(_scalar(f)):
        fid = int(_scalar(f))
        h = _files.get(fid)
        return Char(h.name) if h else Char("")
    t = _text(f)
    m = _text(mode) if mode is not None else "r"
    # (text mode: fprintf and fgetl work on text)
    pm = m.replace("t", "").replace("b", "") or "r"
    try:
        fh = open(t, pm)
    except OSError as e:
        # (the system's message, without Python's "[Errno 2]" and file name)
        if nargout >= 2:
            return [-1.0, Char(e.strerror or "Cannot open file.")]
        return -1.0
    fid = _next_fid[0]
    _next_fid[0] += 1
    mf = _MFile()
    mf.fh = fh
    mf.name = t
    mf.mode = m
    _files[fid] = mf
    return float(fid) if nargout <= 1 else [float(fid), Char("")]


@_bi("fclose")
def fclose_(nargout, fid):
    if _istext(fid) and _text(fid) == "all":
        for k in list(_files):
            _files[k].fh.close()
            del _files[k]
        return 0.0 if nargout else NOVAL
    k = int(_scalar(fid))
    h = _files.pop(k, None)
    if h is None:
        raise _err("Invalid file identifier.  Use fopen to generate a valid file identifier.", "MATLAB:FileIO:InvalidFid")
    h.fh.close()
    return 0.0 if nargout else NOVAL


def _fh(fid):
    h = _files.get(int(_scalar(fid)))
    if h is None:
        raise _err("Invalid file identifier.  Use fopen to generate a valid file identifier.", "MATLAB:FileIO:InvalidFid")
    return h.fh


@_bs("fgetl")
def fgetl_(fid):
    line = _fh(fid).readline()
    if not line:
        return -1.0
    return Char(line.rstrip("\n").rstrip("\r"))


@_bs("fgets")
def fgets_(fid, *n):
    line = _fh(fid).readline()
    return Char(line) if line else -1.0


@_bs("feof")
def feof_(fid):
    fh = _fh(fid)
    pos = fh.tell()
    c = fh.read(1)
    if not c:
        return True
    fh.seek(pos)
    return False


@_bs("frewind")
def frewind_(fid):
    _fh(fid).seek(0)


# ------------------------------------------------------------------ handle objects (graphics: lib/_matlab_plot.py)


class HandleObj:
    """A MATLAB handle object: properties by name (case-insensitive), shared
    by every variable that holds it (no copy on assignment)."""
    _mclass = "handle"

    def __init__(self):
        self.props = {}
        self.valid = True

    def _key(self, name):
        low = name.lower()
        for k in self.props:
            if k.lower() == low:
                return k
        raise _err("Unrecognized property '%s' for class '%s'." % (name, self._mclass), "MATLAB:class:InvalidProperty")

    def mget(self, name):
        return self.props[self._key(name)]

    def mset(self, name, value):
        self.props[self._key(name)] = value


class HandleArr:
    """An array of handle objects (plot(Y) returns one)."""
    __slots__ = ("shape", "a")

    def __init__(self, a, shape):
        self.a = a
        self.shape = _canon_dims(shape)

    def _like(self, a, shape):
        if _prod(shape) == 1:
            return a[0]
        return HandleArr(a, shape)


def _handles(v):
    """the objects of a handle value (one, or an array)"""
    if isinstance(v, HandleObj):
        return [v]
    if type(v) is HandleArr:
        return list(v.a)
    if _isnumlike(v) and _numel(v) == 0:
        return []
    raise _err("Invalid or deleted object.", "MATLAB:class:InvalidHandle")


def _plot_module():
    import _matlab_plot
    return _matlab_plot


def _lazy_plot(name):
    def g(nargout, *args):
        return _plot_module().call(name, nargout, args)
    return Builtin(g, name)


_PLOT_FNS = ("figure gcf gca groot clf cla close hold ishold subplot plot plot3 semilogx semilogy loglog line scatter bar barh "
             "histogram hist stairs stem area errorbar fill patch pie imagesc image imshow colorbar colormap caxis spy clim "
             "contour contourf surf mesh title subtitle sgtitle xlabel ylabel zlabel legend grid box axis xlim ylim zlim "
             "xticks yticks xticklabels yticklabels text set get drawnow print saveas exportgraphics xline yline view "
             "isgraphics ishandle ishghandle shg refresh rotate3d zoom pan linkaxes daspect pbaspect "
             "parula jet hot gray cool spring summer autumn winter bone copper pink hsv turbo lines tiledlayout nexttile peaks "
             "sphere cylinder contourc clabel scatter3 stem3 pcolor shading axes colororder findobj fplot quiver "
             "histcounts discretize zticks zticklabels camlight lighting material light").split()
for _n in _PLOT_FNS:
    _B[_n] = _lazy_plot(_n)


def _keep_single(name, data=(0,), keep=()):
    """a built-in whose results are single when an input is single (as these functions' pages
    say: a single input gives single output): when a data argument (the positions in data, not
    an option such as norm's p, var's weight or ifft's n) is single, each double result, of one
    output or several, made single, except the outputs at the positions in keep; other classes
    (logical, integer, cell) are left as they are"""
    b = _B[name]
    f = b.f

    def single(v):
        return _finish(_farr(v), "single") if _isnumlike(v) and not _istext(v) and class_(v) == "double" else v

    def g(nargout, *args):
        r = f(nargout, *args)
        if any(k < len(args) and _isnumlike(args[k]) and not _istext(args[k]) and class_(args[k]) == "single" for k in data):
            return [v if k in keep else single(v) for k, v in enumerate(r)] if type(r) is list else single(r)
        return r
    g.__doc__ = getattr(f, "__doc__", None)
    _B[name] = Builtin(g, name, (b.lo, b.hi))


# (the data arguments only: options such as norm(x, p), var(x, w, dim), ifft(x, n, dim),
# svd(A, 0), pinv(A, tol) and dot(a, b, dim) do not decide the class)
for _n in ("det", "inv", "norm", "real", "imag", "conj", "angle", "trace", "svd", "qr", "pinv", "ifft"):
    _keep_single(_n)
# (var's and std's weight w is data, as Octave has it, var([1 3], single(0)) being single; their dim
# is not)
for _n in ("dot", "cross", "kron", "eig", "var", "std"):
    _keep_single(_n, data=(0, 1))
# (chol's failure index p stays double)
_keep_single("chol", keep=(1,))
# (lu's permutation P stays double, as Octave gives it: lu's page does not give P's class)
_keep_single("lu", keep=(2,))


def end_program():
    """after a program (or a notebook cell): show the figures it drew or changed"""
    mod = _sys.modules.get("_matlab_plot")
    if mod is not None:
        mod.flush()


# (a new session's display format, as the runtime starts)
_FRESH_FORMAT = dict(_format)


def fresh_session():
    """a new session's state, for a catalog example (lib/_matlab_examples.py run): no
    globals or persistent variables, the display format, generator and warnings a
    session starts with, and no failed cell"""
    _globals.clear()
    _persistents.clear()
    _format.clear()
    _format.update(_FRESH_FORMAT)
    _rng[0] = np.random.RandomState(5489)
    if "_rng_seed" in globals():
        globals()["_rng_seed"][0] = 0.0
    _lastwarn[:] = ["", ""]
    _warn_all[0] = "on"
    _warn_ids.clear()
    _warn_once.clear()
    _cell_failed[0] = False
    _cell_error[0] = None


# ---- handle values in the rest of the runtime


def _handle_blocks(v):
    """the display of a handle object: its class and main properties"""
    name = v._mclass.split(".")[-1]
    if name == "Figure":
        name = "Figure (%d)" % int(_scalar(v.props.get("Number", 1.0)))
    keys = list(v.props)[:12]
    w = max([len(k) for k in keys] + [0])
    lines = ["    %s: %s" % (k.rjust(w), _brief(v.props[k], False) if v.props[k] is not None else "[]") for k in keys]
    return ["  %s with properties:" % name], ["\n".join(lines)] if lines else []

# ------------------------------------------------------------------ sparse matrices (lib/_matlab_sparse.py)

import _matlab_sparse as _sp  # noqa: E402  (it registers its built-ins)
import _matlab_numeric  # noqa: E402,F401  (more numerical built-ins)
import _matlab_data  # noqa: E402,F401  (data analysis and signal functions)
import _matlab_ode  # noqa: E402,F401  (odeset, odeget, ode45, ode23, deval)
import _matlab_funfun  # noqa: E402,F401  (function functions: optimization options and solvers)
import _matlab_eigs  # noqa: E402,F401  (eigs)
import _matlab_special  # noqa: E402,F401  (special functions)
import _matlab_more  # noqa: E402,F401  (split, replace, dec2bin and the others, sub2ind, ind2sub, mat2cell)
