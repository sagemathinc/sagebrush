"""jsonencode and jsondecode for MATLAB programs (lib/_matlab.py), loaded on
their first call (stubs in lib/_matlab.py).  Written from MATLAB's
documentation of both functions and checked against Octave 11.1's where
they agree:

- jsonencode: a scalar becomes a JSON number, boolean or string; a vector a
  flat array; a matrix or N-d array nested arrays, its first dimension
  outermost (eye(2) is [[1,0],[0,1]]); a cell array a flat array of its
  elements in column-major order; a struct an object, a struct array an
  array of objects, nested as a numeric array is; Inf and NaN null unless
  ConvertInfAndNaN is false; PrettyPrint indents by two spaces.
- jsondecode: null is [] (NaN inside an array of numbers); a number a
  double; a boolean a logical; a string a character vector; an object a
  struct, its names made valid as matlab.lang.makeValidName makes them; an
  array of numbers (and nulls) a column vector, of booleans a logical one,
  of numeric (or of logical) arrays of one size an array one dimension
  more; an array of objects with the same names in the same order a struct
  array; any other array a cell array.

The JSON text is untrusted input: before it is parsed it is refused over
MAX_CHARS characters, with more than MAX_VALUES values, with a run of more
than MAX_DIGITS consecutive digits, or nested more than MAX_DEPTH deep.  The
checks are string methods and regular expressions over text of at most
MAX_CHARS characters, then a loop over its brackets once their number is
bounded by MAX_VALUES, which also bounds what parsing builds (each value a
Python object, then a MATLAB one).  Integers are read as doubles, as MATLAB
reads them, never as arbitrary-precision integers.
"""

import json
import re

import numpy as np

import _matlab as _m

# (the longest JSON text jsondecode reads, the most values it holds, the longest number and the deepest nesting)
MAX_CHARS = 1 << 22
MAX_VALUES = 1 << 18
MAX_DIGITS = 1000
MAX_DEPTH = 200
try:
    import os as _os
    # (lower for tests, never higher)
    MAX_CHARS = min(MAX_CHARS, max(1, int(_os.environ.get("SAGEBRUSH_JSON_MAX_CHARS", MAX_CHARS))))
except Exception:
    pass

# ------------------------------------------------------------------ encoding


def _num(x, nan_null):
    """a number's JSON text: an integer as an integer, anything else as the shortest text that reads back as it"""
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        if nan_null:
            return "null"
        return "NaN" if x != x else ("Infinity" if x > 0 else "-Infinity")
    if x == int(x) and abs(x) < 1e15:
        return "%d" % int(x)
    r = repr(x)
    if "e" in r:
        mant, exp = r.split("e")
        r = "%se%d" % (mant, int(exp))
    return r


def _string(s):
    return json.dumps(s, ensure_ascii=False)


def _shaped(dims, items, leaf):
    """items (MATLAB's column-major order) of an array of dims as JSON: a vector flat, more nested arrays, the first
    dimension outermost"""
    n = len(items)
    if n == 0:
        return ("raw", "[]")
    if len(dims) == 2 and min(dims) == 1:
        return ("list", [leaf(x) for x in items])
    dims = [int(d) for d in dims]
    strides = [1]
    for d in dims[:-1]:
        strides.append(strides[-1] * d)

    def rec(k, base):
        if k == len(dims) - 1:
            return ("list", [leaf(items[base + i * strides[k]]) for i in range(dims[k])])
        return ("list", [rec(k + 1, base + i * strides[k]) for i in range(dims[k])])
    return rec(0, 0)


def _tree(v, nan_null):
    """a value as a JSON tree: ("raw", text), ("list", items) or ("obj", [(name, tree)])"""
    t = type(v)
    if t is bool or (t is np.ndarray and v.dtype.kind == "b" and v.size == 1 and v.ndim == 0):
        return ("raw", "true" if v else "false")
    if t is float or t is int:
        return ("raw", _num(v, nan_null))
    if t is complex or (t is np.ndarray and v.dtype.kind == "c"):
        raise _m._err("jsonencode does not support complex numbers.", "MATLAB:jsonencode:UnsupportedComplex")
    if t is _m.Sparse:
        raise _m._err("jsonencode does not support sparse arrays.", "MATLAB:jsonencode:UnsupportedSparse")
    if t is np.ndarray:
        dims = _m._dims(v)
        kind = v.dtype.kind
        flat = list(v.reshape(-1))
        if kind == "b":
            leaf = lambda x: ("raw", "true" if x else "false")
        elif kind in "iu":
            leaf = lambda x: ("raw", "%d" % int(x))
        else:
            leaf = lambda x: ("raw", _num(x, nan_null))
        if len(flat) == 1:
            return leaf(flat[0])
        return _shaped(dims, flat, leaf)
    if t is _m.Char:
        rows = v.rows()
        if len(_m._dims(v)) > 2:
            raise _m._err("jsonencode does not support N-dimensional character arrays.")
        if len(rows) <= 1:
            return ("raw", _string(rows[0] if rows else ""))
        return ("list", [("raw", _string(r)) for r in rows])
    if t is _m.Str:
        return ("raw", "null" if v.s is None else _string(v.s))
    if t is _m.StrArr:
        return _shaped(_m._dims(v), list(v.a), lambda s: ("raw", "null" if s is None else _string(s)))
    if t is _m.Cell:
        return ("list", [_tree(x, nan_null) for x in v.a])
    if t is _m.Struct:
        def one(d):
            return ("obj", [(f, _tree(d[f], nan_null)) for f in v.fields])
        if len(v.a) == 1:
            return one(v.a[0])
        return _shaped(_m._dims(v), list(v.a), one)
    if hasattr(v, "_cdef"):
        # (an object of a class: its public properties, as a struct's fields)
        return ("obj", [(k, _tree(x, nan_null)) for k, x in v.props.items()])
    raise _m._err("jsonencode does not support values of class '%s'." % _m.class_(v), "MATLAB:jsonencode:UnsupportedType")


def _write(node, pretty, out, indent=""):
    kind, val = node
    if kind == "raw":
        out.append(val)
        return
    if not val:
        out.append("[]" if kind == "list" else "{}")
        return
    inner = indent + "  "
    out.append("[" if kind == "list" else "{")
    for k, item in enumerate(val):
        if k:
            out.append(",")
        if pretty:
            out.append("\n" + inner)
        if kind == "obj":
            name, item = item
            out.append(_string(name) + (": " if pretty else ":"))
        _write(item, pretty, out, inner)
    if pretty:
        out.append("\n" + indent)
    out.append("]" if kind == "list" else "}")


def _options(args, names):
    """name-value options (case-insensitive names) given as logical values"""
    if len(args) % 2:
        raise _m._err("Name-value arguments must come in pairs.", "MATLAB:jsonencode:NameValuePairs")
    out = {}
    for k in range(0, len(args), 2):
        name = _m._text(args[k]) if _m._istext(args[k]) else None
        key = next((n for n in names if name is not None and n.lower() == name.lower()), None)
        if key is None:
            raise _m._err("'%s' is not a recognized parameter. For a list of valid name-value pair arguments, see the "
                          "documentation for this function." % (name if name is not None else "?"), "MATLAB:jsonencode:InvalidParameter")
        out[key] = bool(_m.cond(args[k + 1]))
    return out


@_m._bs("jsonencode")
def jsonencode_(data, *args):
    o = _options(args, ("ConvertInfAndNaN", "PrettyPrint"))
    out = []
    _write(_tree(data, o.get("ConvertInfAndNaN", True)), o.get("PrettyPrint", False), out)
    return _m.Char("".join(out))

# ------------------------------------------------------------------ decoding


_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*\Z")
_KEYWORDS = set("break case catch classdef continue else elseif end for function global if otherwise parfor persistent "
                "return spmd switch try while".split())


def make_valid_name(s):
    """matlab.lang.makeValidName: whitespace removed, the letter after it capitalized; other invalid characters
    replaced by underscores; a name not starting with a letter, or a keyword, prefixed with x; at most 63
    characters"""
    if _NAME.match(s) and s not in _KEYWORDS and len(s) <= 63:
        return s
    if s in _KEYWORDS:
        return ("x" + s[:1].upper() + s[1:])[:63]
    s = re.sub(r"\s+(\S)", lambda m: m.group(1).upper(), s.strip())
    s = re.sub(r"[^A-Za-z0-9_]", "_", s)
    if not s or not s[0].isalpha() or not s[0].isascii():
        s = "x" + s
    return s[:63]


def _admit(text):
    """refuse a text with too many values, too long a number or too deep a nesting (its strings left out, as one
    character each), before it is parsed"""
    bare = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    # (every value but the first follows a comma or opens an array or object: an upper bound on their number)
    values = bare.count(",") + bare.count("[") + bare.count("{") + 1
    if values > MAX_VALUES:
        raise _m._err("jsondecode: the JSON text holds more than %d values." % MAX_VALUES, "MATLAB:jsondecode:TooLarge")
    if re.search(r"[0-9]{%d}" % (MAX_DIGITS + 1), bare):
        raise _m._err("jsondecode: the JSON text has a run of more than %d consecutive digits." % MAX_DIGITS, "MATLAB:jsondecode:TooLarge")
    depth = 0
    for c in re.sub(r"[^\[\]{}]", "", bare):
        if c in "[{":
            depth += 1
            if depth > MAX_DEPTH:
                raise _m._err("jsondecode: the JSON text is nested more than %d levels deep." % MAX_DEPTH,
                              "MATLAB:jsondecode:TooDeep")
        else:
            depth -= 1


class _Obj(list):
    """an object's (name, value) pairs, in order"""


def _value(v):
    if v is None:
        return np.zeros((0, 0))
    if v is True or v is False:
        return v
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        return _m.Char(v)
    if isinstance(v, _Obj):
        return _struct([v])
    return _array(v)


def _struct(objs):
    names = [make_valid_name(k) for k, _ in objs[0]]
    fields = list(dict.fromkeys(names))
    elems = []
    for o in objs:
        d = {}
        for (k, x) in o:
            d[make_valid_name(k)] = _value(x)
        elems.append(d)
    return _m.Struct(elems, (len(elems), 1) if len(elems) != 1 else (1, 1), fields)


def _column(vals, dtype):
    return _m._box(np.array(vals, dtype=dtype).reshape((1, len(vals))))


def _array(items):
    n = len(items)
    if n == 0:
        return np.zeros((0, 0))
    if all(x is None or (isinstance(x, (int, float)) and not isinstance(x, bool)) for x in items):
        return _column([float("nan") if x is None else float(x) for x in items], np.float64)
    if all(x is True or x is False for x in items):
        return _column(items, np.bool_)
    if all(isinstance(x, _Obj) for x in items):
        keys = [[make_valid_name(k) for k, _ in o] for o in items]
        if all(k == keys[0] for k in keys):
            return _struct(items)
    if all(isinstance(x, list) and not isinstance(x, _Obj) and x for x in items):
        parts = [_array(x) for x in items]
        stacked = _stack(parts)
        if stacked is not None:
            return stacked
        return _m.Cell(parts, (n, 1))
    return _m.Cell([_value(x) for x in items], (n, 1))


def _stack(parts):
    """arrays of the same size and kind (numeric or logical) as one array a dimension more, the parts along the
    first: or None"""
    kinds = set()
    shapes = set()
    mats = []
    for p in parts:
        if type(p) is float or type(p) is bool:
            return None
        if type(p) is not np.ndarray or p.size == 0:
            return None
        kinds.add(p.dtype.kind)
        m = p.transpose()  # (MATLAB's index order)
        d = _m._dims(p)
        if len(d) == 2 and d[1] == 1:
            m = m.reshape(-1)
        shapes.add(m.shape)
        mats.append(m)
    if len(kinds) != 1 or len(shapes) != 1:
        return None
    m = np.stack(mats)
    return _m._box(np.ascontiguousarray(m.transpose())) if m.dtype.kind in "fb" else _m._canon(np.ascontiguousarray(m.transpose()))


@_m._bs("jsondecode")
def jsondecode_(txt):
    if not _m._istext(txt):
        raise _m._err("The input must be a character vector or string scalar containing JSON text.", "MATLAB:jsondecode:InvalidInput")
    text = _m._text(txt)
    if len(text) > MAX_CHARS:
        raise _m._err("jsondecode: the JSON text is %d characters, over the limit of %d." % (len(text), MAX_CHARS),
                      "MATLAB:jsondecode:TooLarge")
    _admit(text)
    try:
        # (parsed and converted inside one catch: each nesting level is a few Python calls, in the parser and in the
        # conversion, and a smaller host stack than the CLI's must still give MATLAB's error, never Python's)
        return _value(json.loads(text, object_pairs_hook=_Obj, parse_int=float))
    except ValueError as e:
        line, col = getattr(e, "lineno", None), getattr(e, "colno", None)
        where = " (line %d, column %d)" % (line, col) if line is not None else ""
        raise _m._err("jsondecode: the text is not valid JSON%s: %s." % (where, getattr(e, "msg", str(e))),
                      "MATLAB:jsondecode:ParseError")
    except RecursionError:
        raise _m._err("jsondecode: the JSON text is nested too deeply.", "MATLAB:jsondecode:TooDeep")
