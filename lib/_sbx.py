"""sbx, version 1: values from one language's code items to another's on a
board (D4, /scratch/sagebrush-reviews/board-interchange-design.md).

An exporting item's interpreter encodes each exported name with encode();
the encoded value, JSON data, is all that leaves it.  An importing item's
interpreter decodes it with decode(), as its own language's natural type.
No runtimes mix: each interpreter only sees its own values.

Every value is tagged.  Exact things are carried exactly, and nothing is
rounded silently: what a language can't hold exactly is an error that says
how to convert it, unless the importing item asks for a lossy conversion
(as_="double").  Anything else (symbolic expressions, finite fields,
functions, objects) is an error naming the nearest supported type.

    tag      JSON
    int      {"t": "int", "v": "123"}                  (a decimal string)
    rat      {"t": "rat", "v": "-3/4"}
    float    {"t": "float", "v": 1.5}                  ("inf", "-inf", "nan")
    complex  {"t": "complex", "re": 1.0, "im": 2.0}
    bool     {"t": "bool", "v": true}
    str      {"t": "str", "v": "..."}
    list     {"t": "list", "v": [...]}
    dict     {"t": "dict", "v": [["key", value], ...]}  (string keys, in order)
    array    {"t": "array", "dtype": "float64" | "int64" | "complex128" | "bool",
              "shape": [m, n, ...], "v": [...]}         (row-major; int64 as
              decimal strings, complex128 as [re, im])
    matrix   {"t": "matrix", "ring": "ZZ" | "QQ", "shape": [m, n] or [n],
              "v": ["1", "-3/4", ...]}                  (exact, row-major)
    poly     {"t": "poly", "ring": "ZZ" | "QQ", "vars": ["x", "y"],
              "v": "x^2 - 3/4*y"}

A poly's text is a sum of terms c*x^a*y^b, its coefficients integers or
rationals, its operators + - * ^ and the / of a coefficient: each language
reads it with the parser here, never with eval.

Modes: "python", "sage", "magma", "matlab".  This module runs in each
mode's interpreter (all four are Python), and under CPython for the
plain-Python oracle (test/sbx.test.ts).
"""

import json as _json
import math as _math
import re as _re
import sys as _sys
from fractions import Fraction as _Fraction

VERSION = 1
MODES = ("python", "sage", "magma", "matlab")
# an encoded value's bounds: its JSON (UTF-8 bytes), an array's or a matrix's
# elements, nesting, a string's characters, a polynomial's exponents, and
# an integer's decimal digits (each part of a rational, each matrix entry,
# each coefficient: CPython's own default bound for int <-> str, HARD-695-1)
LIMITS = {"bytes": 16 * 2 ** 20, "elements": 10 ** 7, "depth": 32, "string": 2 ** 20, "exponent": 10 ** 6, "digits": 4300}
# (the largest integer a double holds exactly, with every one below it)
_EXACT_DOUBLE = 2 ** 53
_NAME = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MATLAB_FIELD = _re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,62}$")


class SbxError(ValueError):
    """A value that can't be exported or imported, saying why and what to do."""


def _err(msg):
    return SbxError(msg)


# (the bits of the largest integer of LIMITS["digits"] digits, and one more)
_DIGIT_BITS = int(LIMITS["digits"] * 3.3219280948873626) + 1


def _too_many_digits():
    return _err("an integer of more than %d digits, more than sbx carries: export it as a string, str(n)" % LIMITS["digits"])


def _dtext(n):
    """an integer's decimal text, of at most LIMITS["digits"] digits (else refused, before it is made)"""
    n = int(n)
    if n.bit_length() > _DIGIT_BITS:
        raise _too_many_digits()
    try:
        t = str(n)
    except ValueError:
        raise _too_many_digits()
    if len(t) - (t[0] == "-") > LIMITS["digits"]:
        raise _too_many_digits()
    return t


def _digits_ok(t):
    """whether decimal text (an integer, or a rational's p/q) has at most LIMITS["digits"] digits in each part"""
    return all(len(part.lstrip("-")) <= LIMITS["digits"] for part in t.split("/"))


def _mod(name):
    """A module of the library if this interpreter has loaded it (a value
    of its type can only exist then): never imported here."""
    return _sys.modules.get(name)


def _modname(c):
    """a class's module name (a string: some built-in types here have none)"""
    m = getattr(c, "__module__", None)
    return m if isinstance(m, str) else "builtins"


def _tname(v):
    t = type(v)
    m = _modname(t)
    return t.__name__ if m in ("builtins", "__main__") else m.lstrip("_") + "." + t.__name__


# ------------------------------------------------------------------ encode


class _Budget:
    __slots__ = ("elements",)

    def __init__(self):
        self.elements = 0

    def take(self, n):
        self.elements += n
        if self.elements > LIMITS["elements"]:
            raise _err("the value has more than %d elements, more than sbx carries" % LIMITS["elements"])


def encode(value, mode="python"):
    """value, a value of `mode`'s, as sbx JSON data (a dict)."""
    if mode not in MODES:
        raise _err("no such mode: %r" % (mode,))
    return _enc(value, mode, 1, set(), _Budget())


def _ring_name(R):
    s = str(R)
    return "ZZ" if s == "Integer Ring" else "QQ" if s == "Rational Field" else None


def _int(v):
    return {"t": "int", "v": _dtext(v)}


def _rat(f):
    n, d = f.numerator, f.denominator
    return {"t": "rat", "v": _dtext(n) if d == 1 else "%s/%s" % (_dtext(n), _dtext(d))}


def _fl(x):
    x = float(x)
    if x != x:
        return "nan"
    if x in (_math.inf, -_math.inf):
        return "inf" if x > 0 else "-inf"
    return x


def _exact(x):
    """an int or a Fraction as an exact entry's text"""
    if isinstance(x, bool):
        raise _err("a matrix entry is a number, not a bool")
    if isinstance(x, int):
        return _dtext(x)
    if isinstance(x, _Fraction):
        return _dtext(x.numerator) if x.denominator == 1 else "%s/%s" % (_dtext(x.numerator), _dtext(x.denominator))
    raise _err("a matrix over ZZ or QQ has an entry of type %s" % _tname(x))


def _str(s):
    s = str(s)
    if len(s) > LIMITS["string"]:
        raise _err("a string of more than %d characters, more than sbx carries" % LIMITS["string"])
    return {"t": "str", "v": s}


def _enc(v, mode, depth, seen, budget):
    if depth > LIMITS["depth"]:
        raise _err("the value nests more than %d deep" % LIMITS["depth"])
    budget.take(1)
    t = type(v)
    # scalars
    if t is bool:
        return {"t": "bool", "v": v}
    if isinstance(v, bool):
        return {"t": "bool", "v": bool(v)}
    if isinstance(v, int):
        return _int(v)
    if isinstance(v, _Fraction):
        return _rat(v)
    if isinstance(v, float):
        return {"t": "float", "v": _fl(v)}
    if isinstance(v, complex):
        return {"t": "complex", "re": _fl(v.real), "im": _fl(v.imag)}
    if isinstance(v, Poly):
        return {"t": "poly", "ring": v.ring, "vars": list(v.vars), "v": _poly_text([(c, tuple(zip(v.vars, e))) for c, e in v.terms()])}
    if isinstance(v, str):
        return _str(v)
    np = _mod("numpy")
    if np is not None and isinstance(v, getattr(np, "generic", ())):
        return _enc(v.item(), mode, depth, seen, budget)
    if np is not None and isinstance(v, getattr(np, "ndarray", ())):
        return _array(v, mode, budget)
    # each mode's own types
    f = _MODE_ENC.get(mode)
    r = f(v, mode, depth, seen, budget) if f else None
    if r is not None:
        return r
    r = _enc_sage_like(v, mode, depth, seen, budget)
    if r is not None:
        return r
    # containers
    if isinstance(v, (list, tuple)):
        return {"t": "list", "v": _items(v, mode, depth, seen, budget)}
    if isinstance(v, dict):
        if id(v) in seen:
            raise _err("the value contains itself (a cycle)")
        seen.add(id(v))
        try:
            out = []
            for k, x in v.items():
                if not isinstance(k, str):
                    raise _err("a dict's keys are strings to be exported (this one has a key of type %s)" % _tname(k))
                _str(k)
                out.append([k, _enc(x, mode, depth + 1, seen, budget)])
            return {"t": "dict", "v": out}
        finally:
            seen.discard(id(v))
    raise _unsupported(v, mode)


def _items(v, mode, depth, seen, budget):
    if id(v) in seen:
        raise _err("the value contains itself (a cycle)")
    seen.add(id(v))
    try:
        return [_enc(x, mode, depth + 1, seen, budget) for x in v]
    finally:
        seen.discard(id(v))


def _unsupported(v, mode):
    name = _tname(v)
    low = name.lower()
    if v is None:
        return _err("None can't be exported: export a value")
    if "expr" in low or "symbolic" in low:
        return _err("a symbolic expression (%s) can't be exported: export its numerical value, float(e), or its polynomial, e.polynomial(QQ)" % name)
    if "integermod" in low or "_ff" in low or "finite" in low:
        return _err("a finite field's element (%s) can't be exported yet: export its integer lift, x.lift()" % name)
    if callable(v):
        return _err("a function (%s) can't be exported: export its values" % name)
    return _err("a value of type %s can't be exported: sbx carries numbers, strings, booleans, lists, dicts, arrays, matrices over ZZ and QQ, and polynomials over ZZ and QQ" % name)


_DTYPES = {"f": "float64", "i": "int64", "u": "int64", "c": "complex128", "b": "bool"}


def _array(a, mode, budget):
    """an ndarray: in MATLAB mode stored with its axes reversed (lib/_matlab.py), so read back in MATLAB's order"""
    np = _mod("numpy")
    k = a.dtype.kind
    dtype = _DTYPES.get(k)
    if dtype is None:
        raise _err("an array of dtype %s can't be exported: sbx carries float64, int64, complex128 and bool arrays" % a.dtype)
    if k == "f" and a.dtype.itemsize > 8:
        raise _err("an array of %s can't be exported exactly: convert it to float64 first, a.astype(float)" % a.dtype)
    if mode == "matlab":
        a = np.transpose(a)
    shape = [int(n) for n in a.shape]
    budget.take(int(a.size))
    flat = np.ascontiguousarray(a).reshape(-1).tolist()
    if dtype == "float64":
        v = [_fl(x) for x in flat]
    elif dtype == "int64":
        if k == "u" and any(x >= 2 ** 63 for x in flat):
            raise _err("an unsigned array with entries past 2^63 - 1 can't be exported as int64")
        v = [_dtext(x) for x in flat]
    elif dtype == "complex128":
        v = [[_fl(complex(x).real), _fl(complex(x).imag)] for x in flat]
    else:
        v = [bool(x) for x in flat]
    return {"t": "array", "dtype": dtype, "shape": shape, "v": v}


def _poly_text(terms):
    """terms [(coefficient, exponents)], the exponents a tuple per variable, as sbx's poly text"""
    out = []
    for c, exps in terms:
        if c == 0:
            continue
        mono = "*".join(("%s^%d" % (n, e) if e > 1 else n) for n, e in exps if e)
        a = abs(c)
        ct = _dtext(a.numerator) if a.denominator == 1 else "%s/%s" % (_dtext(a.numerator), _dtext(a.denominator))
        body = mono if (mono and a == 1) else (ct + "*" + mono if mono else ct)
        sign = "-" if c < 0 else "+"
        out.append((sign, body))
    if not out:
        return "0"
    s = ("-" if out[0][0] == "-" else "") + out[0][1]
    for sign, body in out[1:]:
        s += " %s %s" % (sign, body)
    return s


def _poly(p, budget):
    """a Sage (or Magma) polynomial over ZZ or QQ, or None if v is none"""
    ring = _ring_name(p.base_ring())
    if ring is None:
        raise _err("a polynomial over %s can't be exported: sbx carries polynomials over ZZ and QQ" % p.base_ring())
    names = list(p.parent().variable_names())
    for n in names:
        if not _NAME.match(n):
            raise _err("a polynomial whose variable is %r can't be exported: name the ring's variables (in Magma, P<x> := PolynomialRing(Rationals()))" % n)
    if hasattr(p, "dict"):
        # (keys: exponent tuples in several variables, an int exponent in
        # one, as in Sage)
        items = [(e if isinstance(e, tuple) else (int(e),), c) for e, c in p.dict().items()]
        terms = sorted(items, key=lambda kv: (-sum(kv[0]), [-e for e in kv[0]]))
        terms = [(_Fraction(c), tuple(zip(names, e))) for e, c in terms]
    else:
        coeffs = list(p.list())
        terms = [(_Fraction(c), ((names[0], k),)) for k, c in reversed(list(enumerate(coeffs)))]
    budget.take(len(terms))
    text = _poly_text(terms)
    if len(text) > LIMITS["string"]:
        raise _err("a polynomial of more than %d characters, more than sbx carries" % LIMITS["string"])
    return {"t": "poly", "ring": ring, "vars": names, "v": text}


def _enc_sage_like(v, mode, depth, seen, budget):
    """Sage's types (and Magma's, built on them): exact matrices and
    vectors, matrices over RDF and CDF, polynomials, RDF/CDF elements"""
    t = type(v)
    mro = {_modname(c) + "." + c.__name__ for c in t.__mro__}
    if "_sage_rdf.ComplexDoubleElement" in mro:
        return {"t": "complex", "re": _fl(v.real()), "im": _fl(v.imag())}
    if "_sage_matrix.Matrix" in mro:
        ring = _ring_name(v.base_ring())
        m, n = v.dimensions()
        budget.take(m * n)
        if ring is None:
            # (Magma's matrix of reals: an array of doubles, if each is one exactly)
            M = _mod("_magma")
            xs = v.list()
            if M is not None and xs and all(isinstance(x, M.MReal) for x in xs):
                return {"t": "array", "dtype": "float64", "shape": [m, n], "v": [_enc_magma(x, mode, depth, seen, budget)["v"] for x in xs]}
            raise _unsupported_ring("a matrix", v.base_ring())
        return {"t": "matrix", "ring": ring, "shape": [m, n], "v": [_exact(x) for x in v.list()]}
    if "_sage_ffmat.FFMatrix" in mro:
        m, n = v.dimensions()
        budget.take(m * n)
        return _float_array(v.base_ring(), [m, n], v.list(), "a matrix")
    if "_sage_matrix.Vector" in mro:
        n = len(v)
        budget.take(n)
        R = v.base_ring() if hasattr(v, "base_ring") else None
        ring = _ring_name(R) if R is not None else None
        if ring is None and R is not None and str(R) in ("Real Double Field", "Complex Double Field"):
            return _float_array(R, [n], list(v), "a vector")
        if ring is None:
            raise _unsupported_ring("a vector", R)
        return {"t": "matrix", "ring": ring, "shape": [n], "v": [_exact(x) for x in v]}
    if "_sage_ffmat.FFVector" in mro:
        xs = list(v.list()) if hasattr(v, "list") else list(v)
        budget.take(len(xs))
        return _float_array(v.base_ring(), [len(xs)], xs, "a vector")
    if "_sage_poly.Polynomial" in mro or "_sage_mpoly.MPolynomial" in mro:
        return _poly(v, budget)
    return None


def _unsupported_ring(what, R):
    s = str(R)
    if s == "Symbolic Ring":
        return _err("%s over the Symbolic Ring can't be exported: export it over QQ, change_ring(QQ), or numerically, change_ring(RDF)" % what)
    return _err("%s over %s can't be exported: sbx carries matrices over ZZ and QQ (exact) and over RDF and CDF (as arrays)" % (what, s))


def _float_array(R, shape, xs, what):
    s = str(R)
    if s == "Real Double Field":
        return {"t": "array", "dtype": "float64", "shape": shape, "v": [_fl(x) for x in xs]}
    if s == "Complex Double Field":
        return {"t": "array", "dtype": "complex128", "shape": shape, "v": [[_fl(x.real()), _fl(x.imag())] for x in xs]}
    raise _unsupported_ring(what, R)


def _enc_magma(v, mode, depth, seen, budget):
    M = _mod("_magma")
    if M is None:
        return None
    if isinstance(v, M.MReal):
        f = v.frac()
        x = float(f)
        # (exactly a double, or said: Magma's reals are more precise, and nothing is rounded silently)
        if _math.isfinite(x) and _Fraction(x) == f:
            return {"t": "float", "v": x}
        raise _err("a real of RealField(%d) that a double can't hold exactly: round it yourself, RealField(15)!x, or export it as a rational, BestApproximation(x, 10^15)" % v.prec)
    if isinstance(v, M.MSet):
        raise _err("a set can't be exported: export the sequence of its elements, Setseq(S)")
    return None


def _enc_matlab(v, mode, depth, seen, budget):
    L = _mod("_matlab")
    if L is None:
        return None
    t = type(v)
    if t is L.Char:
        rows = v.rows() if v.a.size else [""]
        if len(rows) != 1:
            raise _err("a char matrix of %d rows can't be exported: export a cell of its rows, cellstr(c)" % len(rows))
        return _str(rows[0])
    if t is L.Str:
        if v.s is None:
            raise _err("a missing string (<missing>) can't be exported")
        return _str(v.s)
    if t is L.StrArr:
        if sum(1 for n in v.shape if n != 1) > 1:
            raise _err("a string array of more than one dimension can't be exported: export it as a row, s(:)'")
        if any(s is None for s in v.a):
            raise _err("a string array with <missing> strings can't be exported")
        budget.take(len(v.a))
        return {"t": "list", "v": [_str(s) for s in v.a]}
    if t is L.Cell:
        if sum(1 for n in v.shape if n != 1) > 1:
            raise _err("a cell array of more than one dimension can't be exported: export it as a row, c(:)'")
        return {"t": "list", "v": _items(v.a, mode, depth, seen, budget)}
    if t is L.Struct:
        def one(d):
            return {"t": "dict", "v": [[k, _enc(d[k], mode, depth + 2, seen, budget)] for k in v.fields]}
        if list(v.shape) == [1, 1]:
            return one(v.a[0])
        if sum(1 for n in v.shape if n != 1) > 1:
            raise _err("a struct array of more than one dimension can't be exported: export it as a row, s(:)'")
        return {"t": "list", "v": [one(d) for d in v.a]}
    if t is L.Sparse:
        raise _err("a sparse matrix can't be exported: export full(S)")
    return None


_MODE_ENC = {"magma": _enc_magma, "matlab": _enc_matlab}

# ------------------------------------------------------------------ decode


def decode(data, mode="python", as_=None):
    """sbx JSON data as a value of `mode`'s; as_="double": exact numbers as doubles (the importing item asked)."""
    if mode not in MODES:
        raise _err("no such mode: %r" % (mode,))
    if as_ not in (None, "double"):
        raise _err('an import converts only "as": "double"')
    _check(data, 1, _Budget())
    try:
        if as_ == "double":
            data = _to_double(data)
        return _DEC[mode](data)
    except SbxError:
        raise
    except (ValueError, OverflowError, ArithmeticError) as e:
        # (anything the checks didn't foresee: refused as sbx refuses, never the interpreter's own error, HARD-695-1)
        raise _err("the value can't be read here: %s" % str(e)[:200])


def _num(x, what):
    if isinstance(x, bool) or not (isinstance(x, (int, float)) or x in ("inf", "-inf", "nan")):
        raise _err("not sbx: %s is a number" % what)
    return float(x)


_INT = _re.compile(r"^-?(0|[1-9][0-9]*)$")
_RAT = _re.compile(r"^-?(0|[1-9][0-9]*)(/[1-9][0-9]*)?$")


def _check(x, depth, budget):
    """that x is sbx v1 data, within its limits, before anything is made of it"""
    if depth > LIMITS["depth"] + 1:
        raise _err("not sbx: it nests more than %d deep" % LIMITS["depth"])
    if not isinstance(x, dict) or not isinstance(x.get("t"), str):
        raise _err("not sbx: a value is an object with a tag, t")
    budget.take(1)
    t = x["t"]
    if t in ("int", "rat"):
        if not isinstance(x.get("v"), str) or len(x["v"]) > LIMITS["string"] or not (_INT if t == "int" else _RAT).match(x["v"]):
            raise _err("not sbx: %s's v is its decimal text" % ("an int" if t == "int" else "a rat"))
        if not _digits_ok(x["v"]):
            raise _too_many_digits()
        if t == "rat" and "/" in x["v"]:
            n, d = x["v"].split("/")
            if _Fraction(int(n), int(d)).denominator != int(d):
                raise _err("not sbx: a rat is in lowest terms")
    elif t == "float":
        _num(x.get("v"), "a float")
    elif t == "complex":
        _num(x.get("re"), "a complex's re")
        _num(x.get("im"), "a complex's im")
    elif t == "bool":
        if not isinstance(x.get("v"), bool):
            raise _err("not sbx: a bool's v is true or false")
    elif t == "str":
        if not isinstance(x.get("v"), str) or len(x["v"]) > LIMITS["string"]:
            raise _err("not sbx: a str's v is a string of at most %d characters" % LIMITS["string"])
    elif t == "list":
        if not isinstance(x.get("v"), list):
            raise _err("not sbx: a list's v is a list")
        for y in x["v"]:
            _check(y, depth + 1, budget)
    elif t == "dict":
        if not isinstance(x.get("v"), list):
            raise _err("not sbx: a dict's v is a list of pairs")
        keys = set()
        for p in x["v"]:
            if not (isinstance(p, list) and len(p) == 2 and isinstance(p[0], str)) or len(p[0]) > LIMITS["string"]:
                raise _err("not sbx: a dict's pair is [a string, a value]")
            if p[0] in keys:
                raise _err("not sbx: a dict has the key %r twice" % p[0][:40])
            keys.add(p[0])
            _check(p[1], depth + 1, budget)
    elif t in ("array", "matrix"):
        shape = x.get("shape")
        if not isinstance(shape, list) or not all(isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= LIMITS["elements"] for n in shape):
            raise _err("not sbx: an %s's shape is a list of sizes" % t)
        if t == "matrix" and len(shape) not in (1, 2):
            raise _err("not sbx: a matrix's shape is [m, n] or [n]")
        size = 1
        for n in shape:
            size *= n
            if size > LIMITS["elements"]:
                raise _err("an %s of more than %d elements, more than sbx carries" % (t, LIMITS["elements"]))
        v = x.get("v")
        if not isinstance(v, list) or len(v) != size:
            raise _err("not sbx: an %s's v has as many entries as its shape says" % t)
        budget.take(size)
        if t == "matrix":
            if x.get("ring") not in ("ZZ", "QQ"):
                raise _err("not sbx: a matrix's ring is ZZ or QQ")
            pat = _INT if x["ring"] == "ZZ" else _RAT
            for e in v:
                if not isinstance(e, str) or len(e) > LIMITS["string"] or not pat.match(e):
                    raise _err("not sbx: a matrix over %s has entries like %s" % (x["ring"], "\"3\"" if x["ring"] == "ZZ" else "\"-3/4\""))
                if not _digits_ok(e):
                    raise _too_many_digits()
        else:
            dt = x.get("dtype")
            for e in v:
                if dt == "float64":
                    _num(e, "a float64 entry")
                elif dt == "int64":
                    # (20 characters at most, before int(): -9223372036854775808)
                    if not isinstance(e, str) or len(e) > 20 or not _INT.match(e) or not -2 ** 63 <= int(e) < 2 ** 63:
                        raise _err("not sbx: an int64 entry is the decimal text of a 64-bit integer")
                elif dt == "complex128":
                    if not (isinstance(e, list) and len(e) == 2):
                        raise _err("not sbx: a complex128 entry is [re, im]")
                    _num(e[0], "a complex128 entry's re")
                    _num(e[1], "a complex128 entry's im")
                elif dt == "bool":
                    if not isinstance(e, bool):
                        raise _err("not sbx: a bool entry is true or false")
                else:
                    raise _err("not sbx: an array's dtype is float64, int64, complex128 or bool")
    elif t == "poly":
        if x.get("ring") not in ("ZZ", "QQ") or not isinstance(x.get("vars"), list) or not x["vars"] or not all(isinstance(n, str) and _NAME.match(n) for n in x["vars"]) or len(set(x["vars"])) != len(x["vars"]):
            raise _err("not sbx: a poly has a ring, ZZ or QQ, and its variables' names")
        if not isinstance(x.get("v"), str) or len(x["v"]) > LIMITS["string"]:
            raise _err("not sbx: a poly's v is its text")
        budget.take(len(parse_poly(x["v"], x["vars"], x["ring"])))
    else:
        raise _err("not sbx v1: no tag %r" % t[:40])


def parse_poly(text, names, ring="QQ"):
    """sbx's poly text as terms [(Fraction, exponents tuple)], checked
    against its grammar: never eval'd.  A term's coefficient over ZZ is an integer."""
    tokens = _re.findall(r"\s*(?:(\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\S))", text)
    pos = [0]

    def peek():
        return tokens[pos[0]] if pos[0] < len(tokens) else None

    def take():
        tok = peek()
        pos[0] += 1
        return tok

    def bad(why):
        return _err("not sbx: a poly's text %s (%r)" % (why, text[:60]))

    index = {n: k for k, n in enumerate(names)}
    terms = {}
    first = True
    while True:
        tok = peek()
        sign = 1
        if tok is None:
            if first:
                raise bad("is empty")
            break
        if tok[2] in ("+", "-"):
            take()
            sign = -1 if tok[2] == "-" else 1
        elif not first:
            raise bad("has two terms with no + or - between them")
        first = False
        coef = _Fraction(1)
        exps = [0] * len(names)
        seen_factor = False
        # (a term is one factor or more, joined by *: a sign or a * with no factor after it is refused, never read as 1, CORR-695-1)
        need = True
        while True:
            tok = peek()
            if tok is None:
                break
            num, name, op = tok
            if num:
                take()
                if len(num) > LIMITS["digits"]:
                    raise _too_many_digits()
                if seen_factor:
                    raise bad("has a number after a variable in a term")
                c = _Fraction(int(num))
                if peek() is not None and peek()[2] == "/":
                    take()
                    d = take()
                    if d is not None and d[0] and len(d[0]) > LIMITS["digits"]:
                        raise _too_many_digits()
                    if d is None or not d[0] or int(d[0]) == 0:
                        raise bad("has a / not followed by a nonzero integer")
                    c = c / int(d[0])
                coef *= c
            elif name:
                take()
                if name not in index:
                    raise bad("names %s, not one of its variables" % name)
                e = 1
                if peek() is not None and peek()[2] == "^":
                    take()
                    d = take()
                    if d is None or not d[0]:
                        raise bad("has a ^ not followed by a whole number")
                    # (more digits than the bound's: past it, before int())
                    e = int(d[0]) if len(d[0]) <= 7 else LIMITS["exponent"] + 1
                exps[index[name]] += e
                if exps[index[name]] > LIMITS["exponent"]:
                    raise _err("a polynomial with an exponent over %d, more than sbx carries" % LIMITS["exponent"])
            else:
                raise bad("has %r where a number or a variable belongs" % op)
            seen_factor = seen_factor or bool(name)
            need = False
            tok = peek()
            if tok is not None and tok[2] == "*":
                take()
                need = True
                continue
            break
        if need:
            raise bad("has a + - or * with no number or variable after it")
        if ring == "ZZ" and coef.denominator != 1:
            raise bad("has a rational coefficient over ZZ")
        key = tuple(exps)
        terms[key] = terms.get(key, 0) + sign * coef
        tok = peek()
        if tok is not None and tok[2] not in ("+", "-"):
            raise bad("has %r where + or - belongs" % (tok[0] or tok[1] or tok[2]))
    return [(c, e) for e, c in terms.items() if c != 0]


def _to_double(x):
    """exact numbers as doubles, everywhere in x (the importing item asked for it)"""
    t = x["t"]
    if t in ("int", "rat"):
        f = _Fraction(x["v"])
        try:
            return {"t": "float", "v": float(f)}
        except OverflowError:
            raise _err("%s is too large for a double" % x["v"][:40])
    if t == "matrix":
        try:
            return {"t": "array", "dtype": "float64", "shape": x["shape"], "v": [float(_Fraction(e)) for e in x["v"]]}
        except OverflowError:
            raise _err("a matrix entry is too large for a double")
    if t == "array" and x["dtype"] == "int64":
        return {"t": "array", "dtype": "float64", "shape": x["shape"], "v": [float(int(e)) for e in x["v"]]}
    if t == "list":
        return {"t": "list", "v": [_to_double(y) for y in x["v"]]}
    if t == "dict":
        return {"t": "dict", "v": [[k, _to_double(y)] for k, y in x["v"]]}
    if t == "poly":
        raise _err("a polynomial has no double: import its coefficients")
    return x


def _float(v):
    return float(v)


def _rows(shape, flat):
    if len(shape) == 1:
        return [list(flat)]
    m, n = shape
    return [list(flat[i * n:(i + 1) * n]) for i in range(m)]


def _ndarray(x):
    """an array as a numpy ndarray, row-major as sent"""
    import numpy as np
    dt = x["dtype"]
    if dt == "float64":
        flat = [float(e) for e in x["v"]]
    elif dt == "int64":
        flat = [int(e) for e in x["v"]]
    elif dt == "complex128":
        flat = [complex(float(a), float(b)) for a, b in x["v"]]
    else:
        flat = list(x["v"])
    return np.array(flat, dtype={"float64": np.float64, "int64": np.int64, "complex128": np.complex128, "bool": bool}[dt]).reshape(tuple(x["shape"]))


class Poly(str):
    """A polynomial from another language, in Python: its text (str), its ring ("ZZ" or "QQ") and variables."""

    def __new__(cls, text, ring, names):
        s = str.__new__(cls, text)
        s.ring = ring
        s.vars = tuple(names)
        return s

    def terms(self):
        """[(coefficient, exponents)]: its terms, exponents in the order of vars"""
        return parse_poly(str(self), list(self.vars), self.ring)


def _dec_python(x):
    t = x["t"]
    if t == "int":
        return int(x["v"])
    if t == "rat":
        return _Fraction(x["v"])
    if t == "float":
        return _float(x["v"])
    if t == "complex":
        return complex(_float(x["re"]), _float(x["im"]))
    if t in ("bool", "str"):
        return x["v"]
    if t == "list":
        return [_dec_python(y) for y in x["v"]]
    if t == "dict":
        return {k: _dec_python(y) for k, y in x["v"]}
    if t == "array":
        return _ndarray(x)
    if t == "matrix":
        # (over QQ, rationals, 1 too: its entries are the ring's)
        es = [int(e) if x["ring"] == "ZZ" else _Fraction(e) for e in x["v"]]
        return es if len(x["shape"]) == 1 else _rows(x["shape"], es)
    if t == "poly":
        return Poly(x["v"], x["ring"], x["vars"])
    raise _err("no tag %r" % t)


def _sage():
    import sage_all
    return sage_all


def _sage_poly(S, x, base):
    names = x["vars"]
    R = S.PolynomialRing(base, ",".join(names)) if len(names) > 1 else S.PolynomialRing(base, names[0])
    gens = R.gens()
    p = R(0)
    for c, exps in parse_poly(x["v"], names, x["ring"]):
        term = R(base(c) if x["ring"] == "QQ" else int(c))
        for g, e in zip(gens, exps):
            if e:
                term = term * g ** e
        p = p + term
    return p


def _dec_sage(x):
    S = _sage()
    t = x["t"]
    if t == "int":
        return S.Integer(int(x["v"]))
    if t == "rat":
        return S.QQ(_Fraction(x["v"]))
    if t == "float":
        return S.RDF(_float(x["v"]))
    if t == "complex":
        return S.CDF(_float(x["re"]), _float(x["im"]))
    if t in ("bool", "str"):
        return x["v"]
    if t == "list":
        return [_dec_sage(y) for y in x["v"]]
    if t == "dict":
        return {k: _dec_sage(y) for k, y in x["v"]}
    if t == "array":
        dt, shape = x["dtype"], x["shape"]
        if dt == "bool" or len(shape) not in (1, 2):
            return _ndarray(x)
        R = {"float64": S.RDF, "int64": S.ZZ, "complex128": S.CDF}[dt]
        flat = [_float(e) for e in x["v"]] if dt == "float64" else [int(e) for e in x["v"]] if dt == "int64" else [complex(_float(a), _float(b)) for a, b in x["v"]]
        if dt == "complex128":
            flat = [S.CDF(z.real, z.imag) for z in flat]
        return S.vector(R, flat) if len(shape) == 1 else S.matrix(R, shape[0], shape[1], flat)
    if t == "matrix":
        R = S.ZZ if x["ring"] == "ZZ" else S.QQ
        flat = [int(e) for e in x["v"]] if x["ring"] == "ZZ" else [S.QQ(_Fraction(e)) for e in x["v"]]
        shape = x["shape"]
        return S.vector(R, flat) if len(shape) == 1 else S.matrix(R, shape[0], shape[1], flat)
    if t == "poly":
        return _sage_poly(S, x, S.ZZ if x["ring"] == "ZZ" else S.QQ)
    raise _err("no tag %r" % t)


# (a double's value in Magma: RealField(16), whose 54 bits hold every double exactly)
_MAGMA_DOUBLE_DIGITS = 16


def _dec_magma(x):
    import _magma as M
    S = _sage()
    t = x["t"]
    if t == "int":
        return int(x["v"])
    if t == "rat":
        return S.QQ(_Fraction(x["v"]))
    if t == "float":
        v = _float(x["v"])
        if not _math.isfinite(v):
            raise _err("%s has no Magma real: Magma's reals are finite" % x["v"])
        return M.MReal.of(v, _MAGMA_DOUBLE_DIGITS)
    if t == "complex":
        raise _err("a complex number can't be imported in Magma mode yet: import its real and imaginary parts")
    if t in ("bool", "str"):
        return x["v"]
    if t == "list":
        return _magma_list(x)
    if t == "dict":
        raise _err("a dict can't be imported in Magma mode yet: import its keys and values as two sequences")
    # (an array's or a matrix's shape checked by _check before this: at most
    # LIMITS["elements"] entries, and as many as it says, so each Matrix
    # made here is bounded)
    # (an empty matrix keeps its shape and parent in Magma, which Magma
    # mode's Matrix doesn't yet: refused, never made 0 x 0 or over the
    # integers, CORR-695-2)
    if t in ("array", "matrix") and len(x["shape"]) == 2 and 0 in x["shape"]:
        raise _err("an empty matrix (%d x %d) can't be imported in Magma mode yet" % tuple(x["shape"]))
    if t == "array":
        dt, shape = x["dtype"], x["shape"]
        if len(shape) not in (1, 2) or dt in ("complex128", "bool"):
            raise _err("an array of %s%s can't be imported in Magma mode yet" % (dt, "" if len(shape) in (1, 2) else " with %d dimensions" % len(shape)))
        if len(shape) == 1:
            return _magma_list(x)
        flat = [int(e) for e in x["v"]] if dt == "int64" else [_magma_real(e) for e in x["v"]]
        return M.Matrix(M.Integers(), _rows(shape, flat)) if dt == "int64" else M.Matrix(_rows(shape, flat))
    if t == "matrix":
        if len(x["shape"]) == 1:
            return _magma_list(x)
        flat = [int(e) for e in x["v"]] if x["ring"] == "ZZ" else [S.QQ(_Fraction(e)) for e in x["v"]]
        return M.Matrix(M.Integers() if x["ring"] == "ZZ" else M.Rationals(), _rows(x["shape"], flat))
    if t == "poly":
        if len(x["vars"]) != 1:
            raise _err("a polynomial in %d variables can't be imported in Magma mode yet: Magma mode's polynomial rings have one variable" % len(x["vars"]))
        R = M.PolynomialRing(M.Integers() if x["ring"] == "ZZ" else M.Rationals())
        M._assign_gen_names(R, [x["vars"][0]])
        g = R.gen()
        p = R(0)
        for c, (e,) in parse_poly(x["v"], x["vars"], x["ring"]):
            p = p + (int(c) if c.denominator == 1 else S.QQ(c)) * g ** e
        return p
    raise _err("no tag %r" % t)


# Magma's sequences, from sbx data already checked (_check): their
# universes found bottom-up once, each subtree's from its children's, then
# each node built once, top-down, coerced into its universe as it is built:
# linear in the checked tree (daybreak2's HARD-9B4-1).  A universe is a
# string ("Z", "Q", "R", "B", "S"), a small tuple for a matrix's or a
# polynomial's parent, or an int: a sequence's, interned with its
# elements' universe, so universes compare in constant time.
class _NoUniverse(Exception):
    pass


class _Universes:
    def __init__(self):
        self.seqs = {}     # element universe (None: empty) -> its sequence's int
        self.elem = {}     # a sequence's int -> its element universe
        self.unified = {}  # (a, b) -> a and b's common universe (or _NoUniverse)
        self.work = 0      # nodes visited, both passes (the tests' bound)

    def of_seq(self, u):
        n = self.seqs.get(u)
        if n is None:
            n = self.seqs[u] = len(self.seqs)
            self.elem[n] = u
        return n

    def unify2(self, a, b):
        if a == b:
            return a
        key = (a, b)
        if key in self.unified:
            r = self.unified[key]
            if r is _NoUniverse:
                raise _NoUniverse()
            return r
        try:
            if {a, b} == {"Z", "Q"}:
                r = "Q"
            elif isinstance(a, int) and isinstance(b, int):
                ea, eb = self.elem[a], self.elem[b]
                r = self.of_seq(eb if ea is None else ea if eb is None else self.unify2(ea, eb))
            else:
                raise _NoUniverse()
        except _NoUniverse:
            self.unified[key] = _NoUniverse
            raise
        self.unified[key] = r
        return r

    def of(self, x):
        """the universe of checked sbx data x, as Magma would put it in a sequence"""
        self.work += 1
        t = x["t"]
        if t in ("int", "rat", "float", "bool", "str"):
            return {"int": "Z", "rat": "Q", "float": "R", "bool": "B", "str": "S"}[t]
        if t == "list":
            u = None
            for y in x["v"]:
                v = self.of(y)
                u = v if u is None else self.unify2(u, v)
            return self.of_seq(u)
        if t in ("matrix", "array") and len(x["shape"]) == 1:
            self.work += len(x["v"])
            if t == "array" and x["dtype"] not in ("int64", "float64"):
                raise _err("an array of %s can't be imported in Magma mode yet" % x["dtype"])
            # (its universe its declared one, empty too, CORR-695-3)
            return self.of_seq(("Z" if x["ring"] == "ZZ" else "Q") if t == "matrix" else "Z" if x["dtype"] == "int64" else "R")
        if t in ("matrix", "array"):
            return (t, x.get("ring") or x.get("dtype"), tuple(x["shape"]))
        if t == "poly":
            return ("poly", x["ring"], tuple(x["vars"]))
        return (t,)

    def build(self, x, u):
        """x decoded in Magma, in universe u: an integer into Q exactly, a
        sequence's elements into its elements' universe, and each sequence
        with its universe recorded as Magma keeps it, an empty one's too"""
        self.work += 1
        t = x["t"]
        if t == "list":
            e = self.elem[u]
            return self.seq([self.build(y, e) for y in x["v"]], e)
        if t in ("matrix", "array") and len(x["shape"]) == 1:
            e = self.elem[u]
            self.work += len(x["v"])
            if t == "matrix" and x["ring"] == "QQ" or e == "Q":
                S = _sage()
                flat = [S.QQ(_Fraction(z)) for z in x["v"]]
            elif x.get("dtype") == "float64":
                flat = [_magma_real(z) for z in x["v"]]
            else:
                flat = [int(z) for z in x["v"]]
            return self.seq(flat, e)
        v = _dec_magma(x)
        if u == "Q" and t == "int":
            return _sage().QQ(v)
        return v

    def seq(self, items, e):
        """a Magma sequence of these items, whose elements' universe is e
        (None: no element, nor any known): its universe recorded as Magma
        mode's own [ ... ] records it (_inf), so Universe, Append and the
        rest see it; empty, with a universe it can't record, refused"""
        import _magma as M
        s = M.MSeq(items)
        inf = M._ZZ if e == "Z" else M._QQ if e == "Q" else None
        if not items:
            if e is None:
                s._null = True  # (as [ ]: no universe)
            elif inf is None:
                raise _err("an empty sequence of %s can't be imported in Magma mode yet: it can't keep that universe" % _universe_name(e, self))
            else:
                s._inf = inf
            return s
        s._inf = inf if inf is not None else M._infer_from(items)
        return s


def _universe_name(e, U):
    if isinstance(e, int):
        return "sequences"
    return {"R": "reals", "B": "booleans", "S": "strings"}.get(e, e[0] + "s" if isinstance(e, tuple) else str(e))


def _magma_real(z):
    import _magma as M
    v = _float(z)
    if not _math.isfinite(v):
        raise _err("%s has no Magma real: Magma's reals are finite" % z)
    return M.MReal.of(v, _MAGMA_DOUBLE_DIGITS)


def _magma_list(x):
    """a list as Magma makes a sequence: its elements in one universe,
    coerced exactly into it, or refused as Magma refuses them (CORR-695-3);
    linear in the checked data (HARD-9B4-1)"""
    global _magma_work
    U = _Universes()
    try:
        try:
            u = U.of(x)
        except _NoUniverse:
            raise _err("Could not find a valid universe for the sequence: its elements are of kinds Magma can't put in one sequence (or only by rounding exact values into reals)")
        return U.build(x, u)
    finally:
        _magma_work = U.work


# (the nodes the last Magma list visited, both passes: the tests' bound)
_magma_work = 0


def _dec_matlab(x):
    import numpy as np
    import _matlab as L
    t = x["t"]
    if t == "int":
        n = int(x["v"])
        if abs(n) > _EXACT_DOUBLE:
            raise _err("the integer %s is past 2^53, more than a MATLAB double holds exactly: import it with \"as\": \"double\" to round it" % x["v"][:40])
        return float(n)
    if t == "rat":
        raise _err("the rational %s has no exact MATLAB value: import it with \"as\": \"double\" to round it" % x["v"][:40])
    if t == "float":
        return _float(x["v"])
    if t == "complex":
        return complex(_float(x["re"]), _float(x["im"]))
    if t == "bool":
        return x["v"]
    if t == "str":
        return L.Char(x["v"])
    if t == "list":
        return L.Cell([_dec_matlab(y) for y in x["v"]], (1, len(x["v"])))
    if t == "dict":
        d = {}
        for k, y in x["v"]:
            if not _MATLAB_FIELD.match(k):
                raise _err("the key %r is not a MATLAB field name (a letter, then letters, digits and _, at most 63)" % k[:40])
            d[k] = _dec_matlab(y)
        return L.Struct([d], (1, 1), list(d.keys()))
    if t == "array":
        # (an int64 array: MATLAB's int64 class, which holds it exactly)
        a = _ndarray(x)
        if a.ndim == 0:
            return L._box(a.reshape((1, 1)))
        if a.ndim == 1:
            a = a.reshape((1, a.shape[0]))
        # (stored with the axes reversed, lib/_matlab.py)
        return L._box(np.ascontiguousarray(np.transpose(a)))
    if t == "matrix":
        raise _err("an exact matrix over %s has no MATLAB value: import it with \"as\": \"double\" to round its entries" % x["ring"])
    if t == "poly":
        raise _err("a polynomial has no MATLAB value: import its coefficients")
    raise _err("no tag %r" % t)


_DEC = {"python": _dec_python, "sage": _dec_sage, "magma": _dec_magma, "matlab": _dec_matlab}

# ------------------------------------------------------------------ text


def dumps(value, mode="python"):
    """value as sbx text: {"sbx": 1, "value": ...}, at most LIMITS["bytes"] as UTF-8"""
    s = _json.dumps({"sbx": VERSION, "value": encode(value, mode)}, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    if len(s.encode("utf-8")) > LIMITS["bytes"]:
        raise _err("the value is more than %d MB as sbx, more than it carries" % (LIMITS["bytes"] // 2 ** 20))
    return s


def loads(text, mode="python", as_=None):
    """sbx text as a value of `mode`'s"""
    # (in UTF-8 bytes, as dumps measures it: a character is 1 to 4 of them, HARD-695-2)
    if not isinstance(text, str):
        raise _err("not sbx: sbx is text")
    if len(text) > LIMITS["bytes"] or len(text.encode("utf-8", "surrogatepass")) > LIMITS["bytes"]:
        raise _err("more than %d MB of sbx" % (LIMITS["bytes"] // 2 ** 20))
    try:
        d = _json.loads(text)
    except ValueError:
        raise _err("not sbx: not JSON")
    if not isinstance(d, dict) or d.get("sbx") != VERSION or "value" not in d:
        raise _err("not sbx version %d" % VERSION)
    return decode(d["value"], mode, as_)
