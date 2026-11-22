"""MATLAB's built-ins that MATLAB mode's start does not need, for lib/_matlab.py: fread and fwrite, containers.Map
and its functions (keys, values, isKey, remove), sinpi, cospi, reallog, realsqrt, num2hex, bsxfun, compose and
readmatrix.  Loaded lazily: lib/_matlab.py registers each name as a stub that imports this module the first time
one of them is called, so it is in the lazy matlab-more chunk (web/lib-chunks.mts); importing it registers the
real built-ins over the stubs.  The containers.Map object itself (MapObj) stays in lib/_matlab.py, where
indexing, display and size reach it.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import (Builtin, Cell, Char, MapObj, MatlabError, NOVAL, Str, StrArr, _B, _MAP_KEYTYPES,
    _MAP_VALUETYPES, _arr, _bi, _box, _box1, _bs, _dims, _err, _farr, _files, _finish, _int_arg, _isnumlike, _istext,
    _numel, _scalar, _text, class_, cp)
from _matlab_data import _cls, _md, _out

# ------------------------------------------------------------------ fread, fwrite

# (fread's and fwrite's precisions: the struct code, the element's bytes, and the class a '*' keeps)
_PRECISIONS = {
    "uint8": ("B", 1, "uint8"), "uchar": ("B", 1, "uint8"), "unsigned char": ("B", 1, "uint8"),
    "int8": ("b", 1, "int8"), "schar": ("b", 1, "int8"), "signed char": ("b", 1, "int8"), "integer*1": ("b", 1, "int8"),
    "uint16": ("H", 2, "uint16"), "ushort": ("H", 2, "uint16"), "int16": ("h", 2, "int16"), "short": ("h", 2, "int16"),
    "integer*2": ("h", 2, "int16"),
    "uint32": ("I", 4, "uint32"), "uint": ("I", 4, "uint32"), "ulong": ("I", 4, "uint32"),
    "int32": ("i", 4, "int32"), "int": ("i", 4, "int32"), "long": ("i", 4, "int32"), "integer*4": ("i", 4, "int32"),
    "uint64": ("Q", 8, "uint64"), "int64": ("q", 8, "int64"), "integer*8": ("q", 8, "int64"),
    "single": ("f", 4, "single"), "float32": ("f", 4, "single"), "float": ("f", 4, "single"), "real*4": ("f", 4, "single"),
    "double": ("d", 8, "double"), "float64": ("d", 8, "double"), "real*8": ("d", 8, "double"),
    "char": ("B", 1, "char"), "char*1": ("B", 1, "char"),
}


def _precision(p, default="uint8"):
    """a precision's (struct code, bytes, input class, output class): 'int16' reads int16 into double, '*int16' keeps
    int16, 'int16=>single' converts to single (MATLAB's fread page)"""
    t = (_text(p) if p is not None and not (_isnumlike(p) and _numel(p) == 0) else default).strip().lower()
    keep = t.startswith("*")
    t = t.lstrip("*").strip()
    out = None
    if "=>" in t:
        t, out = [u.strip() for u in t.split("=>", 1)]
    if t not in _PRECISIONS or (out is not None and out not in _PRECISIONS):
        raise _err("Invalid precision.", "MATLAB:fread:InvalidPrecision")
    code, size, cls = _PRECISIONS[t]
    if out is not None:
        ocls = _PRECISIONS[out][2]
    elif keep:
        ocls = cls
    else:
        ocls = "double"
    return code, size, cls, ocls


@_bi("fread")
def fread_(nargout, fid, size=None, precision=None, skip=None, machinefmt=None):
    """[A, count] = fread(fid, sizeA, precision, skip, machinefmt): binary data, read in column order. sizeA is Inf (a
    column of everything left, the default), n, [m n], or [m Inf]; a partial last column is padded with zeros"""
    h = _files.get(int(_scalar(fid)))
    if h is None:
        raise _err("Invalid file identifier.  Use fopen to generate a valid file identifier.", "MATLAB:FileIO:InvalidFid")
    import struct
    # (fread(fid, precision): the precision in sizeA's place, as fread(fid, '*char') is written)
    if size is not None and _istext(size):
        size, precision = None, size
    code, nbytes, cls, ocls = _precision(precision)
    big = h.big if machinefmt is None else _text(machinefmt).lower() in ("b", "ieee-be", "ieee-be.l64")
    gap = 0 if skip is None or _numel(skip) == 0 else _int_arg(skip)
    shape = None
    if size is None:
        want = None
    else:
        sz = [float(v) for v in _farr(size).reshape(-1)]
        if len(sz) == 1:
            want = None if sz[0] == _math.inf else int(sz[0])
        elif len(sz) == 2 and sz[0] != _math.inf:
            shape = (int(sz[0]), None if sz[1] == _math.inf else int(sz[1]))
            want = None if shape[1] is None else shape[0] * shape[1]
        else:
            raise _err("Invalid size argument.", "MATLAB:fread:InvalidSize")
    raw = h.fh.raw
    vals = []
    if cls == "char" and not gap:
        # (characters in UTF-8: as many as asked for, each of its bytes)
        while want is None or len(vals) < want:
            b = raw.read(1)
            if not b:
                break
            lead = b[0]
            more = 0 if lead < 0x80 else 1 if lead >> 5 == 6 else 2 if lead >> 4 == 14 else 3 if lead >> 3 == 30 else 0
            b += raw.read(more)
            vals.extend(ord(c) for c in b.decode("utf-8", "replace"))
        want = len(vals) if want is None else want
    while want is None or len(vals) < want:
        b = raw.read(nbytes)
        if len(b) < nbytes:
            break
        vals.append(struct.unpack((">" if big else "<") + code, b)[0])
        if gap:
            raw.seek(gap, 1)
    count = float(len(vals))
    # (stored as every array here is, MATLAB's transpose: a column of n is (1, n), an m-by-c matrix (c, m))
    if shape is not None:
        m = shape[0]
        cols = -(-len(vals) // m) if m else 0
        if shape[1] is not None:
            cols = min(cols, shape[1])
        vals = vals + [0] * (m * cols - len(vals))
        A = np.array(vals, dtype=np.float64).reshape((cols, m))
    elif vals:
        A = np.array(vals, dtype=np.float64).reshape((1, -1))
    else:
        A = np.zeros((0, 0))
    A = np.ascontiguousarray(A)
    if ocls == "char":
        out = Char(A)
    elif ocls == "double":
        out = _box(A)
    else:
        out = _finish(A, ocls)
    return out if nargout <= 1 else [out, count]


@_bi("fwrite")
def fwrite_(nargout, fid, A, precision=None, skip=None, machinefmt=None):
    """count = fwrite(fid, A, precision, skip, machinefmt): A's elements in column order, uint8 by default; an
    integer precision rounds and saturates, as MATLAB's does"""
    h = _files.get(int(_scalar(fid)))
    if h is None:
        raise _err("Invalid file identifier.  Use fopen to generate a valid file identifier.", "MATLAB:FileIO:InvalidFid")
    import struct
    code, nbytes, cls, _o = _precision(precision)
    big = h.big if machinefmt is None else _text(machinefmt).lower() in ("b", "ieee-be", "ieee-be.l64")
    gap = 0 if skip is None or _numel(skip) == 0 else _int_arg(skip)
    if type(A) is Char or type(A) is Str:
        vals = [float(b) for b in _text(A).encode("utf-8")] if type(A) is Str else [float(ord(c)) for c in "".join(_text(A))]
        if type(A) is Char:
            # (a char array's characters in column order)
            vals = [float(v) for v in _farr(A).T.reshape(-1)]
    else:
        vals = [float(v) for v in _farr(A, "fwrite").T.reshape(-1)]
    raw = h.fh.raw
    for v in vals:
        if code in "fd":
            b = struct.pack((">" if big else "<") + code, v)
        else:
            lo, hi = {"B": (0, 255), "b": (-128, 127), "H": (0, 65535), "h": (-32768, 32767), "I": (0, 4294967295),
                      "i": (-2147483648, 2147483647), "Q": (0, 2 ** 64 - 1), "q": (-2 ** 63, 2 ** 63 - 1)}[code]
            n = 0 if v != v else int(min(max(_math.floor(v + 0.5) if v >= 0 else -_math.floor(-v + 0.5), lo), hi)) if abs(v) != _math.inf else (hi if v > 0 else lo)
            b = struct.pack((">" if big else "<") + code, n)
        if gap:
            raw.seek(gap, 1)
        raw.write(b)
    return float(len(vals)) if nargout >= 1 else NOVAL


# ------------------------------------------------------------------ containers.Map

def _map_items(arg):
    """containers.Map's keys or values argument as a list: a cell array's elements, a char vector or a string as one,
    a numeric array's elements"""
    if type(arg) is Cell:
        return list(arg.a)
    if type(arg) is Char or type(arg) is Str:
        return [arg]
    if type(arg) is StrArr:
        return [Str(x) for x in arg.a]
    if _isnumlike(arg):
        A = _arr(arg)
        return [_box1(x, A) if A.dtype.kind != "f" else float(x) for x in A.reshape(-1)] if A.ndim else [arg]
    raise _err("containers.Map: the keys and values must be cell arrays, text or numeric arrays.")


def _map_new(nargout, *args):
    """containers.Map(), containers.Map('KeyType', kt, 'ValueType', vt), containers.Map(keys, values) and
    containers.Map(keys, values, 'UniformValues', tf)"""
    args = list(args)
    opts = {}
    while len(args) >= 2 and _istext(args[-2]) and _text(args[-2]).lower() in ("keytype", "valuetype", "uniformvalues"):
        opts[_text(args[-2]).lower()] = args[-1]
        args = args[:-2]
    if len(args) not in (0, 2):
        raise _err("containers.Map: the arguments are (keys, values) and the options 'KeyType', 'ValueType' and 'UniformValues'.")
    kt = _text(opts["keytype"]) if "keytype" in opts else None
    vt = _text(opts["valuetype"]) if "valuetype" in opts else None
    if kt is not None and kt not in _MAP_KEYTYPES:
        raise _err("Specified KeyType is not valid.", "MATLAB:Containers:Map:UnsupportedKeyType")
    if vt is not None and vt not in _MAP_VALUETYPES:
        raise _err("Specified ValueType is not valid.", "MATLAB:Containers:Map:UnsupportedValueType")
    if not args:
        return MapObj(kt or "char", vt or "any")
    ks, vs = _map_items(args[0]), _map_items(args[1])
    if len(ks) != len(vs):
        raise _err("The number of keys and values must be the same.", "MATLAB:Containers:Map:KeyValueMismatch")
    if kt is None:
        kt = "char" if all(_istext(k) for k in ks) else (class_(ks[0]) if ks and class_(ks[0]) in _MAP_KEYTYPES else "double")
    if vt is None:
        uniform = "uniformvalues" not in opts or bool(_scalar(opts["uniformvalues"]))
        if type(args[1]) is not Cell and _isnumlike(args[1]) and not _istext(args[1]):
            vt = class_(args[1]) if class_(args[1]) in _MAP_VALUETYPES else "any"
        elif uniform and vs and all(type(v) is Char and len(_dims(v)) == 2 and _dims(v)[0] <= 1 for v in vs):
            vt = "char"
        elif uniform and vs and all(_isnumlike(v) and not _istext(v) and _numel(v) == 1 and class_(v) == class_(vs[0]) for v in vs) \
                and class_(vs[0]) in _MAP_VALUETYPES:
            vt = class_(vs[0])
        else:
            vt = "any"
    m = MapObj(kt, vt)
    for k, v in zip(ks, vs):
        m.put(k, v)
    return m


_B["containers.Map"] = Builtin(_map_new, "containers.Map")


def _map_keylist(m, ks):
    return _map_items(ks) if type(ks) is Cell else [ks]


@_bs("keys")
def keys_(m):
    if not isinstance(m, MapObj):
        raise _err("Undefined function 'keys' for input arguments of type '%s'." % class_(m), "MATLAB:UndefinedFunction")
    ks = m.ordered()
    return Cell([m.keyval(k) for k in ks], (1, len(ks)))


@_bs("values")
def values_(m, ks=None):
    if not isinstance(m, MapObj):
        raise _err("Undefined function 'values' for input arguments of type '%s'." % class_(m), "MATLAB:UndefinedFunction")
    if ks is None:
        order = m.ordered()
        return Cell([cp(m.d[k]) for k in order], (1, len(order)))
    if type(ks) is not Cell:
        raise _err("Specified key type does not match the type expected for this container.", "MATLAB:Containers:TypeMismatch")
    return Cell([m.get(k) for k in ks.a], ks.shape)


@_bs("isKey")
def iskey_(m, ks):
    if not isinstance(m, MapObj):
        raise _err("Undefined function 'isKey' for input arguments of type '%s'." % class_(m), "MATLAB:UndefinedFunction")
    def has(k):
        try:
            return m.key(k) in m.d
        except MatlabError:
            return False
    if type(ks) is Cell:
        return _finish(np.array([has(k) for k in ks.a], dtype=bool).reshape(tuple(reversed(ks.shape))), "logical")
    return has(ks)


@_bs("remove")
def remove_(m, ks):
    if not isinstance(m, MapObj):
        raise _err("Undefined function 'remove' for input arguments of type '%s'." % class_(m), "MATLAB:UndefinedFunction")
    # (a key that is not there is passed over: remove(m, 'zz') is no error, observed MATLAB R2026b, 2026-11-21)
    for k in _map_keylist(m, ks):
        m.d.pop(m.key(k), None)
    return m


# ------------------------------------------------------------------ sinpi, cospi, reallog, realsqrt

def _real_float(x, fname):
    """x as a real float array in MATLAB's axis order, for the real-only elementary functions"""
    if _istext(x) or not _m._isnumlike(x):
        raise _err("%s: the input must be numeric." % fname)
    M = _md(x)
    if np.iscomplexobj(M):
        raise _err("%s: complex values are not supported in Sagebrush." % fname)
    # (in double, rounded once at the end for a single: sinpi(single(1/3)) is single(sinpi(1/3)), as MATLAB gives it)
    return np.asarray(M, dtype=np.float64)


def _pi_reduce(M):
    """x reduced exactly to r in [-1, 1] with x = r + 2k (fmod is exact): sin(pi x) = sin(pi r), cos(pi x) = cos(pi r)"""
    r = _m._fmod(M, 2.0)
    r = np.where(r > 1, r - 2, np.where(r < -1, r + 2, r))
    return r


@_bs("sinpi")
def sinpi_(x):
    """sin(pi*x), exact at the integers (a zero of x's sign: sinpi(-0) is -0, MATLAB's) and the half-integers (+-1)"""
    M = _real_float(x, "sinpi")
    with np.errstate(invalid="ignore"):
        r = _pi_reduce(M)
        a = np.abs(r)
        s = np.where(a <= 0.25, np.sin(np.pi * a), np.where(a <= 0.75, np.cos(np.pi * (a - 0.5)), np.sin(np.pi * (1 - a))))
        s = np.copysign(s, r)
    return _out(s, _cls(x))


@_bs("cospi")
def cospi_(x):
    """cos(pi*x), exact at the integers (+-1) and the half-integers (+0)"""
    M = _real_float(x, "cospi")
    with np.errstate(invalid="ignore"):
        a = np.abs(_pi_reduce(M))
        c = np.where(a <= 0.25, np.cos(np.pi * a), np.where(a <= 0.75, np.sin(np.pi * (0.5 - a)), -np.cos(np.pi * (1 - a))))
        c = np.where(c == 0, 0.0, c)
    return _out(c, _cls(x))


@_bs("reallog")
def reallog_(x):
    """the natural logarithm of a nonnegative real array; a negative element is MATLAB's error (its result would be
    complex)"""
    M = _real_float(x, "reallog")
    if np.any(M < 0):
        raise _err("Reallog produced complex result.", "MATLAB:reallog:complexResult")
    with np.errstate(divide="ignore", invalid="ignore"):
        return _out(np.log(M), _cls(x))


@_bs("realsqrt")
def realsqrt_(x):
    """the square root of a nonnegative real array; a negative element is MATLAB's error (its result would be complex);
    realsqrt(-0) is +0 and a complex input MATLAB's validator error, as an observed MATLAB R2026b run gives them"""
    if not _istext(x) and _m._isnumlike(x) and np.iscomplexobj(_md(x)):
        raise _err("Value must be real.", "MATLAB:validators:mustBeReal")
    M = _real_float(x, "realsqrt")
    if np.any(M < 0):
        raise _err("Realsqrt produced complex result.", "MATLAB:realsqrt:complexResult")
    with np.errstate(invalid="ignore"):
        return _out(np.where(M == 0, 0.0, np.sqrt(M)), _cls(x))


# ------------------------------------------------------------------ num2hex, bsxfun

@_bs("num2hex")
def num2hex_(x):
    """each element's IEEE 754 bits in hexadecimal, one row per element in column order: 16 digits for a double, 8
    for a single"""
    import struct
    cls = _m.class_(x)
    if cls not in ("double", "single"):
        raise _err("num2hex: the input must be of class double or single, not %s." % cls)
    M = _md(x)
    if np.iscomplexobj(M):
        raise _err("num2hex: complex values are not supported in Sagebrush.")
    flat = np.transpose(M).reshape(-1)
    vals = [float(v) for v in flat]
    neg = [bool(b) for b in np.signbit(flat)]
    # (MATLAB's NaN has its sign bit set: num2hex(NaN) is fff8000000000000 and num2hex(-NaN) 7ff8000000000000, observed
    # MATLAB R2026b, 2026-11-21, the reverse of this runtime's, so a NaN's sign bit is the reverse of its sign here;
    # the sign is read from the array, which keeps it, not from the Python float)
    def bits(v, sign, fmt):
        b = bytearray(struct.pack(fmt, abs(v) if v != v else v))
        if v != v and not sign:
            b[0] |= 0x80
        return bytes(b).hex()
    rows = [bits(v, n, ">f" if cls == "single" else ">d") for v, n in zip(vals, neg)]
    if not rows:
        # (an empty input is a 0-by-16 char, 0-by-8 for a single)
        return _m.Char(np.zeros((8 if cls == "single" else 16, 0)))
    w = len(rows[0])
    # (a char matrix, stored transposed as every array here is: its columns are the rows' characters)
    return _m.Char(np.array([[float(ord(c)) for c in r] for r in rows]).T.copy())


@_bi("bsxfun")
def bsxfun_(nargout, f, A, B):
    """bsxfun(fun, A, B): fun applied to A and B expanded along their singleton dimensions to a common size, as
    implicit expansion does; fun must work element by element, as MATLAB's page asks"""
    fh = _m._fn_arg(f)
    da, db = list(_m._dims(A)), list(_m._dims(B))
    n = max(len(da), len(db))
    da += [1] * (n - len(da))
    db += [1] * (n - len(db))
    for p, q in zip(da, db):
        if p != q and p != 1 and q != 1:
            raise _err("Non-singleton dimensions of the two input arrays must match each other.", "MATLAB:bsxfun:arrayDimensionsMustMatch")
    ra = [q if p == 1 else 1 for p, q in zip(da, db)]
    rb = [p if q == 1 else 1 for p, q in zip(da, db)]
    rep = _m._B["repmat"].f
    A2 = rep(1, A, _m._box(np.array([[float(v)] for v in ra]))) if any(v != 1 for v in ra) else A
    B2 = rep(1, B, _m._box(np.array([[float(v)] for v in rb]))) if any(v != 1 for v in rb) else B
    return _m._call(fh, [A2, B2], max(nargout, 1))


# ------------------------------------------------------------------ compose

@_bs("compose")
def compose_(fmt, *arrays):
    """compose(formatSpec, A1, ..., AN): formatSpec applied to each row of the arrays' values (side by side, in column
    order), once per output column: a row with more values than conversions adds output columns, and conversions
    left without a value stay as written; compose(txt) translates the escapes. A string array for a string
    formatSpec, a cell array of character vectors otherwise (MATLAB's compose page)"""
    if not _istext(fmt):
        raise _err("compose: the format must be text.")
    as_string = type(fmt) in (_m.Str, _m.StrArr)
    f = _m._escapes(_text(fmt))
    segs = _m._parse_format(f)
    specs = [s for s in segs if type(s) is not str]

    def render(vals):
        out, k = [], 0
        for s in segs:
            if type(s) is str:
                out.append(s)
            elif k < len(vals):
                out.append(_m._sprintf(s.group(0), [vals[k]]))
                k += 1
            else:
                out.append(s.group(0))
        return "".join(out)

    if not arrays:
        texts, shape = [render([])], (1, 1)
    elif all(_m._dims(a)[1] == 0 for a in arrays) if all(len(_m._dims(a)) == 2 for a in arrays) else False:
        # (data with no columns: the result is as large as it, empty, as compose('%d', []) is 0-by-0)
        texts, shape = [], tuple(_m._dims(arrays[0]))
    else:
        mats = []
        for a in arrays:
            if _m.class_(a) in ("cell", "struct"):
                raise _err("compose: the data must be numeric, logical or text arrays in Sagebrush.")
            d = _m._dims(a)
            if len(d) > 2:
                raise _err("compose: the data must be matrices.")
            mats.append(a)
        rows = _m._dims(mats[0])[0]
        if any(_m._dims(a)[0] != rows for a in mats):
            raise _err("compose: the data arrays must have the same number of rows.")

        def row_vals(a, i):
            if type(a) is _m.StrArr:
                d = _m._dims(a)
                return [_m.Str(a.a[i + j * d[0]]) for j in range(d[1])]
            if type(a) is _m.Str:
                return [a]
            M = np.transpose(_m._farr(a)) if _m.class_(a) != "char" else None
            if M is None:
                return [_m.Char(r) for r in [a.rows()[i]]]
            return [float(v) if not np.iscomplexobj(M) else complex(v) for v in M[i]]

        k = max(len(specs), 1)
        lines = [sum((row_vals(a, i) for a in mats), []) for i in range(rows)]
        cols = max([1] + [-(-len(v) // k) for v in lines]) if specs else max([1] + [len(v) for v in lines])
        texts = [None] * (rows * cols)
        for i, v in enumerate(lines):
            for c in range(cols):
                texts[i + c * rows] = render(v[c * k:(c + 1) * k]) if specs else render([])
        shape = (rows, cols)
    if as_string:
        return _m._strarr(texts, shape)
    return _m.Cell([_m.Char(t) for t in texts], shape)


# ------------------------------------------------------------------ readmatrix

@_bs("readmatrix")
def readmatrix_(filename, *args):
    """readmatrix(filename, 'Delimiter', d, 'NumHeaderLines', n, 'OutputType', t): a delimited text file's numbers
    as a matrix. The delimiter (comma, tab, semicolon, bar or spaces) and the header lines (leading lines that are
    not mostly numbers) are found when not given; an empty or non-numeric field is NaN, and short rows are padded
    with NaN"""
    import os
    name = _text(filename)
    if len(args) % 2:
        raise _err("readmatrix: the options come in name, value pairs.")
    delim, header, otype = None, None, "double"
    for k in range(0, len(args), 2):
        nm = _text(args[k]).lower() if _istext(args[k]) else ""
        val = args[k + 1]
        if nm == "delimiter":
            delim = {"comma": ",", "tab": "\t", "semi": ";", "bar": "|", "space": " "}.get(_text(val).lower(), _m._escapes(_text(val)))
        elif nm == "numheaderlines":
            header = _m._int_arg(val)
        elif nm == "outputtype":
            otype = _text(val).lower()
            if otype not in ("double", "single", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"):
                raise _err("readmatrix: the output type '%s' is not supported in Sagebrush." % _text(val))
        else:
            raise _err("readmatrix: the option '%s' is not supported in Sagebrush." % (_text(args[k]) if _istext(args[k]) else "?"))
    if os.path.splitext(name)[1].lower() in (".xls", ".xlsx", ".xlsm", ".xlsb", ".ods"):
        raise _err("readmatrix: spreadsheet files are not supported in Sagebrush; save the sheet as a .csv file.")
    try:
        with open(name, "rb") as fh:
            text = fh.read().decode("utf-8", "replace")
    except OSError:
        raise _err("Unable to find or open '%s'. Check the path and filename or file permissions." % name, "MATLAB:textio:textio:FileNotFound")
    lines = [l for l in text.splitlines() if l.strip()]

    def split(l, d):
        """the line's fields: double-quoted fields may hold the delimiter (a doubled quote is a quote in one)"""
        if d == " ":
            return l.split()
        out, cur, q, i = [], [], False, 0
        while i < len(l):
            c = l[i]
            if q:
                if c == '"' and i + 1 < len(l) and l[i + 1] == '"':
                    cur.append('"')
                    i += 1
                elif c == '"':
                    q = False
                else:
                    cur.append(c)
            elif c == '"':
                q = True
            elif c == d:
                out.append("".join(cur).strip())
                cur = []
            else:
                cur.append(c)
            i += 1
        out.append("".join(cur).strip())
        return out

    import re as _re
    NUM = _re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$")

    def number(f):
        """a field as a number: a decimal (1.5, -0, 1e3) or Inf/NaN; anything else (1,5 too: no thousands separators)
        is not one, as MATLAB's readmatrix reads them"""
        t = f.strip()
        if NUM.match(t):
            return float(t.replace("d", "e").replace("D", "e"))
        low = t.lower().lstrip("+")
        if low in ("inf", "-inf", "nan", "-nan"):
            return float(low)
        return None

    if delim is None:
        best = (" ", 0)
        for d in (",", "\t", ";", "|"):
            n = sum(1 for l in lines if d in l)
            if n > best[1]:
                best = (d, n)
        delim = best[0]
    nums = lambda l: [number(f) if f else None for f in split(l, delim)]
    if header is None:
        header = 0
        for l in lines:
            v = nums(l)
            if sum(1 for x in v if x is not None) * 2 >= len(v):
                break
            header += 1
    rows = [nums(l) for l in lines[header:]]
    width = max([0] + [len(r) for r in rows])
    M = np.full((len(rows), width), np.nan)
    for i, r in enumerate(rows):
        for j, x in enumerate(r):
            if x is not None:
                M[i, j] = x
    # (an integer type has no NaN: those fields are 0, as converting NaN to an integer gives)
    return _out(M if otype in ("double", "single") else np.where(np.isnan(M), 0, M), otype)
