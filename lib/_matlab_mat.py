"""MATLAB's .mat files (Level 5, as save writes up to -v7) for load and save
in MATLAB programs (lib/_matlab.py): MATLAB values in and out, without the
translation to Python containers that scipy.io makes.

The format is MathWorks' "MAT-File Format" (Level 5): a 128-byte header, then
one data element per variable, each a tag (type, size) and data padded to 8
bytes; -v7 compresses each variable with zlib (miCOMPRESSED).  Arrays are
stored column-major, which is the C order of lib/_matlab.py's arrays (their
axes are reversed), so data needs no transposing at this boundary.

Not supported: MATLAB 7.3 files (HDF5) and objects (strings, tables, ...).
Sparse matrices are read and written as sparse (single ones are written as
double).
"""

import struct
import time
import zlib

import numpy as np

import _matlab as _m

miINT8, miUINT8, miINT16, miUINT16, miINT32, miUINT32, miSINGLE, miDOUBLE = 1, 2, 3, 4, 5, 6, 7, 9
miINT64, miUINT64, miMATRIX, miCOMPRESSED, miUTF8, miUTF16, miUTF32 = 12, 13, 14, 15, 16, 17, 18

_MI_FMT = {miINT8: ("b", 1), miUINT8: ("B", 1), miINT16: ("h", 2), miUINT16: ("H", 2), miINT32: ("i", 4),
           miUINT32: ("I", 4), miSINGLE: ("f", 4), miDOUBLE: ("d", 8), miINT64: ("q", 8), miUINT64: ("Q", 8)}
# array classes: (dtype, the MAT-file type of their data)
_CLASS = {6: (np.float64, miDOUBLE), 7: (np.float32, miSINGLE), 8: (np.int8, miINT8), 9: (np.uint8, miUINT8),
          10: (np.int16, miINT16), 11: (np.uint16, miUINT16), 12: (np.int32, miINT32), 13: (np.uint32, miUINT32),
          14: (np.int64, miINT64), 15: (np.uint64, miUINT64)}
_CLASS_OF = {"double": 6, "single": 7, "int8": 8, "uint8": 9, "int16": 10, "uint16": 11, "int32": 12,
             "uint32": 13, "int64": 14, "uint64": 15, "logical": 9}


class MatError(Exception):
    pass


# A .mat file is untrusted input: the most decompressed data one file may
# expand to (a small compressed element can expand without bound), and the
# most nonzeros a sparse matrix in it may reserve.
MAX_INFLATED = 1 << 28
MAX_NZMAX = 1 << 27
try:
    import os as _os
    MAX_INFLATED = int(_os.environ.get("SAGEBRUSH_MAT_MAX_INFLATED", MAX_INFLATED))  # (lower for tests)
except Exception:
    pass


def _inflate(payload, budget):
    """a miCOMPRESSED element's data: one complete zlib stream, nothing after it,
    at most budget bytes"""
    data = bytes(payload)
    try:
        if hasattr(zlib, "_decompress_limited"):
            out, end = zlib._decompress_limited(data, budget)
        else:  # (CPython)
            d = zlib.decompressobj()
            out = d.decompress(data, budget + 1)
            if len(out) > budget:
                raise MatError("the file's compressed data expands to more than %d bytes" % MAX_INFLATED)
            if not d.eof:
                raise MatError("a compressed variable is truncated")
            end = len(data) - len(d.unused_data)
    except zlib.error as e:
        if "more than" in str(e):
            raise MatError("the file's compressed data expands to more than %d bytes" % MAX_INFLATED)
        raise MatError("a compressed variable is corrupt (%s)" % e)
    if end != len(data):
        raise MatError("unexpected data after a compressed variable")
    return out


# ------------------------------------------------------------------ reading


class _Reader:
    def __init__(self, data, pos, end):
        self.d = data
        self.p = pos
        self.end_ = end

    def done(self):
        return self.end_ - self.p < 8

    def element(self):
        """(type, payload bytes) of the next data element"""
        if self.end_ - self.p < 8:
            raise MatError("the file ends inside a data element")
        t, n = struct.unpack_from(self.e + "II", self.d, self.p)
        if t >> 16:
            # small data element: the type in the low half, the size in the high half
            n = t >> 16
            t &= 0xFFFF
            if n > 4:
                raise MatError("a malformed small data element")
            data = self.d[self.p + 4:self.p + 4 + n]
            self.p += 8
            return t, data
        start = self.p + 8
        if n > self.end_ - start:
            raise MatError("a data element runs past the end of the file")
        data = self.d[start:start + n]
        self.p = start + n + ((-n) % 8 if t != miCOMPRESSED else 0)
        return t, data


def _numbers(t, raw, e):
    if t in (miUTF8,):
        return [ord(c) for c in bytes(raw).decode("utf-8")]
    if t == miUTF16:
        # (by hand: the runtime has no utf-16 codec) code units, surrogate pairs joined
        units = list(struct.unpack_from("%s%dH" % (e, len(raw) // 2), raw, 0))
        out = []
        k = 0
        while k < len(units):
            u = units[k]
            if 0xD800 <= u < 0xDC00 and k + 1 < len(units) and 0xDC00 <= units[k + 1] < 0xE000:
                out.append(0x10000 + ((u - 0xD800) << 10) + (units[k + 1] - 0xDC00))
                k += 2
                continue
            out.append(u)
            k += 1
        return out
    if t == miUTF32:
        return list(struct.unpack_from("%s%dI" % (e, len(raw) // 4), raw, 0))
    if t not in _MI_FMT:
        raise MatError("unknown MAT-file data type %d" % t)
    f, size = _MI_FMT[t]
    n = len(raw) // size
    return list(struct.unpack_from("%s%d%s" % (e, n, f), raw, 0))


def _stored(dims):
    d = list(dims)
    while len(d) > 2 and d[-1] == 1:
        d.pop()
    return tuple(reversed(d))


def _count(r):
    """the number of data elements left in a reader (without reading them)"""
    q = _Reader(r.d, r.p, r.end_)
    q.e = r.e
    k = 0
    while not q.done():
        q.element()
        k += 1
    return k


def _matrix(payload, e):
    """a miMATRIX element's (name, value, global)"""
    if len(payload) == 0:
        return "", np.zeros((0, 0)), False
    r = _Reader(payload, 0, len(payload))
    r.e = e
    t, raw = r.element()
    w, w2 = struct.unpack_from(e + "II", raw, 0)
    cls = w & 0xFF
    flags = (w >> 8) & 0xFF
    is_complex, is_global, is_logical = bool(flags & 0x08), bool(flags & 0x04), bool(flags & 0x02)
    t, raw = r.element()
    dims = [int(v) for v in _numbers(t, raw, e)]
    t, raw = r.element()
    name = bytes(raw).decode("latin1")
    n = 1
    for d in dims:
        n *= d
    if cls == 9 and is_logical and _count(r) >= 3:
        # (a logical sparse matrix as Octave writes one: class uint8, then ir, jc and pr,
        # where a full array has its data alone)
        cls = 5
    if cls in _CLASS:
        dt = _CLASS[cls][0]
        t, raw = r.element()
        re_ = np.array(_numbers(t, raw, e), dtype=np.float64 if dt in (np.float64, np.float32) else dt)
        if dt not in (np.float64, np.float32, np.int64, np.uint64):
            re_ = re_.astype(dt)
        if is_complex:
            t, raw = r.element()
            im = np.array(_numbers(t, raw, e), dtype=np.float64)
            z = np.zeros(n, dtype=np.complex128)
            z.real = re_.astype(np.float64)
            z.imag = im
            re_ = z.astype(np.complex64) if dt == np.float32 else z
        elif dt == np.float32:
            re_ = re_.astype(np.float32)
        a = re_.reshape(_stored(dims)) if n else np.zeros(_stored(dims), dtype=re_.dtype)
        if is_logical:
            a = a != 0
        return name, (_m._box(a) if a.dtype.kind in "fbc" and a.dtype.itemsize in (1, 8, 16) else _m._canon(a)), is_global
    if cls == 4:  # char
        codes = []
        if not r.done():
            t, raw = r.element()
            codes = _numbers(t, raw, e)
        a = np.array([float(c) for c in codes]).reshape(_stored(dims)) if n else np.zeros(_stored(dims))
        return name, _m.Char(a), is_global
    if cls == 1:  # cell
        items = []
        for _ in range(n):
            t, raw = r.element()
            items.append(_matrix(raw, e)[1])
        return name, _m.Cell(items, dims), is_global
    if cls == 2:  # struct
        t, raw = r.element()
        flen = int(_numbers(t, raw, e)[0])
        t, raw = r.element()
        raw = bytes(raw)
        names = [raw[i:i + flen].split(b"\0")[0].decode("latin1") for i in range(0, len(raw), flen)] if flen else []
        elems = []
        for _ in range(n):
            d = {}
            for f in names:
                t, raw = r.element()
                d[f] = _matrix(raw, e)[1]
            elems.append(d)
        return name, _m.Struct(elems, dims, names), is_global
    if cls == 5:  # sparse: ir (nzmax row indices), jc (column starts), pr and pi (the nonzeros)
        return (name,) + (_sparse(r, e, dims, w2, is_complex, is_logical),) + (is_global,)
    raise MatError("variable '%s' is an object (class %d), which Sagebrush cannot load" % (name, cls))


def _sparse(r, e, dims, nzmax, is_complex, is_logical):
    """a sparse matrix's subelements, every invariant checked before anything
    is allocated from them (they are untrusted)"""
    import _matlab_sparse as sp
    bad = lambda what: MatError("a malformed sparse matrix: %s" % what)
    if len(dims) != 2 or dims[0] < 0 or dims[1] < 0 or dims[0] >= 2 ** 31 or dims[1] >= 2 ** 31:
        raise bad("its size")
    m, n = dims
    parts = []
    for _ in range(4 if is_complex else 3):
        if r.done():
            break
        parts.append(r.element())
    if len(parts) < 3 or (is_complex and len(parts) < 4):
        raise bad("missing data")
    (ti, ri), (tj, rj), (tr, rr) = parts[:3]
    if ti not in (miINT32, miUINT32, miINT16, miUINT16, miINT8, miUINT8) or tj not in (miINT32, miUINT32, miINT16, miUINT16, miINT8, miUINT8):
        raise bad("its index types")
    jc = np.array(_numbers(tj, rj, e), dtype=np.int64)  # (as long as the data that holds it)
    if jc.size != n + 1:
        raise bad("its column starts")
    if jc.size and (jc[0] != 0 or np.any(np.diff(jc) < 0)):
        raise bad("its column starts")
    nz = int(jc[-1])
    ir = np.array(_numbers(ti, ri, e), dtype=np.int64)
    if nz > ir.size:
        raise bad("more nonzeros than row indices")
    ir = ir[:nz]
    if nz and (np.any(ir < 0) or np.any(ir >= m)):
        raise bad("a row index out of range")
    cols = np.repeat(np.arange(n, dtype=np.int64), np.diff(jc))
    if nz > 1 and np.any((cols[1:] == cols[:-1]) & (ir[1:] <= ir[:-1])):
        raise bad("row indices out of order")
    if tr not in _MI_FMT:
        raise bad("its value type")
    re_ = _numbers(tr, rr, e)
    if len(re_) < nz:
        raise bad("fewer values than nonzeros")
    single = tr == miSINGLE
    vals = np.array(re_[:nz], dtype=np.float64)
    if is_complex:
        tm, rm = parts[3]
        if tm not in _MI_FMT:
            raise bad("its value type")
        im = _numbers(tm, rm, e)
        if len(im) < nz:
            raise bad("fewer imaginary parts than nonzeros")
        vals = _m._cplx(vals, np.array(im[:nz], dtype=np.float64))
    if is_logical:
        vals = vals != 0
    elif single:
        vals = vals.astype(np.complex64 if is_complex else np.float32)
    S = sp.make(m, n, ir, cols, vals)
    if nzmax < nz or nzmax > MAX_NZMAX:
        nzmax = nz
    S.cap = int(min(nzmax, max(ir.size, nz)))
    return S


def read(data):
    """the variables of a .mat file: [(name, value, global)]"""
    if data[:8] == b"\x89HDF\r\n\x1a\n" or data[512:520] == b"\x89HDF\r\n\x1a\n":
        raise MatError("MATLAB 7.3 files (HDF5) are not supported: save with -v7")
    if len(data) < 128:
        raise MatError("not a MAT-file")
    if data[126:128] == b"IM":
        e = "<"
    elif data[126:128] == b"MI":
        e = ">"
    else:
        raise MatError("not a Level 5 MAT-file")
    r = _Reader(data, 128, len(data))
    r.e = e
    out = []
    budget = MAX_INFLATED
    while not r.done():
        t, payload = r.element()
        if t == miCOMPRESSED:
            inner = _inflate(payload, budget)
            budget -= len(inner)
            ir = _Reader(inner, 0, len(inner))
            ir.e = e
            t, payload = ir.element()
            if ir.p < len(inner):
                raise MatError("a compressed variable holds more than one data element")
        if t == miMATRIX:
            out.append(_matrix(payload, e))
    return out


# ------------------------------------------------------------------ writing


def _elem(t, payload):
    payload = bytes(payload)
    n = len(payload)
    if 0 < n <= 4:
        # small data element
        return struct.pack("<HH", t, n) + payload + b"\0" * (4 - n)
    return struct.pack("<II", t, n) + payload + b"\0" * ((-n) % 8)


def _pack(fmt, values):
    return struct.pack("<%d%s" % (len(values), fmt), *values)


def _array(name, v):
    """a miMATRIX element for a MATLAB value"""
    t = type(v)
    dims = list(_m._dims(v))
    flags = 0
    if t is _m.Str or t is _m.StrArr:
        _m.warning_("'%s' is a string: saved as a char array (strings are MATLAB objects in a MAT-file)" % name)
        v = _m.char_n(v)
        t = _m.Char
        dims = list(_m._dims(v))
    head = lambda cls, fl: _elem(miUINT32, struct.pack("<II", cls | (fl << 8), 0)) + _elem(miINT32, _pack("i", dims)) + _elem(miINT8, name.encode("latin1"))
    if t is _m.Char:
        codes = [int(c) for c in v.a.reshape(-1)]
        return _elem(miMATRIX, head(4, 0) + (_elem(miUINT16, _pack("H", codes)) if codes else _elem(miUINT16, b"")))
    if t is _m.Cell:
        body = head(1, 0)
        for x in v.a:
            body += _array("", x)
        return _elem(miMATRIX, body)
    if t is _m.Struct:
        fields = list(v.fields)
        flen = max([len(f) for f in fields] + [0]) + 1
        flen = max(flen, 8)
        names = b"".join(f.encode("latin1").ljust(flen, b"\0") for f in fields)
        body = head(2, 0) + _elem(miINT32, struct.pack("<i", flen)) + _elem(miINT8, names)
        for d in v.a:
            for f in fields:
                body += _array("", d[f])
        return _elem(miMATRIX, body)
    if t is _m.Sparse:
        import _matlab_sparse as sp
        nzmax = min(sp.nzmax(v), max(MAX_NZMAX, sp.nnz(v)))
        fl = (0x02 if sp.islogical(v) else 0) | (0x08 if v.pr.dtype.kind == "c" else 0)
        body = (_elem(miUINT32, struct.pack("<II", 5 | (fl << 8), nzmax)) + _elem(miINT32, _pack("i", dims))
                + _elem(miINT8, name.encode("latin1")))
        ir = [int(x) for x in v.ir] + [0] * (nzmax - v.ir.size)
        body += _elem(miINT32, _pack("i", ir)) + _elem(miINT32, _pack("i", [int(x) for x in v.jc]))
        vals = v.pr.astype(np.float64) if v.pr.dtype.kind == "b" else v.pr
        if vals.dtype.kind == "c":
            body += _elem(miDOUBLE, _pack("d", [float(x) for x in vals.real])) + _elem(miDOUBLE, _pack("d", [float(x) for x in vals.imag]))
        else:
            body += _elem(miDOUBLE, _pack("d", [float(x) for x in vals]))
        return _elem(miMATRIX, body)
    if _m._iscallable(v):
        raise MatError("function handles cannot be saved")
    if not _m._isnumlike(v):
        raise MatError("a value of class %s cannot be saved" % _m.class_(v))
    a = _m._arr(v)
    cls_name = _m.class_(v)
    cls = _CLASS_OF[cls_name]
    if cls_name == "logical":
        flags |= 0x02
        a = a.astype(np.uint8)
    complex_ = a.dtype.kind == "c"
    if complex_:
        flags |= 0x08
    dt, mi = _CLASS[cls]
    f = _MI_FMT[mi][0]
    flat = a.reshape(-1)
    if complex_:
        re_ = [float(x) for x in flat.real]
        im = [float(x) for x in flat.imag]
        data = _elem(mi, _pack(f, re_)) + _elem(mi, _pack(f, im))
    else:
        vals = [float(x) for x in flat] if f in "fd" else [int(x) for x in flat]
        data = _elem(mi, _pack(f, vals))
    return _elem(miMATRIX, head(cls, flags) + data)


def header():
    # (no date: the same values give the same file)
    text = "MATLAB 5.0 MAT-file, Platform: GLNXA64, Created by: Sagebrush"
    return text.encode("latin1")[:116].ljust(116, b" ") + b"\0" * 8 + struct.pack("<H", 0x0100) + b"IM"


def write(variables, compress=True):
    """a .mat file's bytes: variables is [(name, value)]"""
    parts = [header()]
    for name, v in variables:
        try:
            el = _array(name, v)
        except MatError as e:
            _m.warning_("Variable '%s' not saved: %s." % (name, e))
            continue
        if compress:
            z = zlib.compress(el)
            el = struct.pack("<II", miCOMPRESSED, len(z)) + z
        parts.append(el)
    return b"".join(parts)
