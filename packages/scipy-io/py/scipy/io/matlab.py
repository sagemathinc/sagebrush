"""MATLAB level 5 .mat files (the format of MATLAB's save up to -v7):
loadmat and savemat as in scipy.io, for numeric arrays, logical and char
arrays, structs and cell arrays.  Compressed variables (-v7) are inflated
with zlib.  MATLAB 7.3 files are HDF5 and are not supported.

Arrays come back as numpy arrays of the shape MATLAB stores (at least 2-D,
as scipy returns them); char arrays as strings in a list, cells as lists
of lists, structs as dicts.
"""

import struct
import zlib
import numpy as np

__all__ = ["loadmat", "savemat", "whosmat", "MatReadError"]


class MatReadError(Exception):
    pass


# data types of the tags
_MI = {1: "i1", 2: "u1", 3: "i2", 4: "u2", 5: "i4", 6: "u4", 7: "f4", 9: "f8", 12: "i8", 13: "u8"}
miMATRIX, miCOMPRESSED, miUTF8, miUTF16, miUTF32 = 14, 15, 16, 17, 18
# array classes
_CLASS = {6: "f8", 7: "f4", 8: "i1", 9: "u1", 10: "i2", 11: "u2", 12: "i4", 13: "u4", 14: "i8", 15: "u8"}
_NP = {"i1": "int8", "u1": "uint8", "i2": "int16", "u2": "uint16", "i4": "int32", "u4": "uint32",
       "f4": "float32", "f8": "float64", "i8": "int64", "u8": "uint64"}


class _Reader:
    def __init__(self, data, pos, little):
        self.d, self.p, self.e = data, pos, "<" if little else ">"

    def tag(self):
        """(type, nbytes, data start, next element)."""
        t, n = struct.unpack_from(self.e + "II", self.d, self.p)
        if t >> 16:  # small data element: up to 4 bytes in the tag
            return t & 0xFFFF, t >> 16, self.p + 4, self.p + 8
        start = self.p + 8
        nxt = start + n
        if t != miCOMPRESSED:
            nxt += (-n) % 8
        return t, n, start, nxt

    def element(self):
        """(type, payload) of the next element; a compressed element is
        inflated and its element read."""
        t, n, start, nxt = self.tag()
        self.p = nxt
        if t == miCOMPRESSED:
            inner = zlib.decompress(self.d[start:start + n])
            return _Reader(inner, 0, self.e == "<").element()
        return t, self.d[start:start + n]

    def done(self):
        return self.p >= len(self.d)


def _numbers(t, raw, e):
    if t == miUTF8:
        return bytes(raw).decode("utf-8")
    if t == miUTF16:
        return bytes(raw).decode("utf-16-le" if e == "<" else "utf-16-be")
    if t == miUTF32:
        return bytes(raw).decode("utf-32-le" if e == "<" else "utf-32-be")
    code = _MI.get(t)
    if code is None:
        raise MatReadError("unsupported data type %d" % t)
    return np.frombuffer(raw, dtype=e + code)


def _matrix(payload, e, little, mat_dtype=False):
    """A miMATRIX element: (name, value).  Numbers keep the type they were
    stored with (MATLAB saves small integers of a double array compactly),
    as scipy does, unless mat_dtype."""
    r = _Reader(payload, 0, little)
    if r.done():
        return "", np.zeros((0, 0))
    t, raw = r.element()
    flags = struct.unpack_from(e + "II", raw, 0)
    cls = flags[0] & 0xFF
    is_complex, is_logical = bool(flags[0] & 0x0800), bool(flags[0] & 0x0200)
    t, raw = r.element()
    dims = [int(v) for v in _numbers(t, raw, e).tolist()]
    t, raw = r.element()
    name = bytes(raw).decode("latin1")
    n = 1
    for d in dims:
        n *= d
    if cls in _CLASS:
        t, raw = r.element()
        re_ = _numbers(t, raw, e)
        if mat_dtype:
            re_ = re_.astype(_NP[_CLASS[cls]])
        if is_complex:
            t, raw = r.element()
            part = "float32" if cls == 7 else "float64"  # single: complex64
            im = _numbers(t, raw, e).astype(part)
            z = np.empty(re_.shape, dtype="complex64" if cls == 7 else "complex128")
            z.real = re_.astype(part)
            z.imag = im
            re_ = z
        if is_logical:
            re_ = re_.astype(bool)
        return name, _shape(re_, dims)
    if cls == 4:  # char
        if n == 0:
            return name, []
        t, raw = r.element()
        v = _numbers(t, raw, e)
        chars = v if isinstance(v, str) else "".join(chr(c) for c in v.tolist())
        rows = dims[0]
        cols = n // rows if rows else 0
        # column-major: row i is chars[i], chars[i + rows], ...
        return name, ["".join(chars[i + j * rows] for j in range(cols)) for i in range(rows)]
    if cls == 1:  # cell
        items = []
        for _ in range(n):
            t, raw = r.element()
            items.append(_matrix(raw, e, little)[1] if t == miMATRIX else None)
        rows = dims[0] if dims else 1
        cols = n // rows if rows else 0
        return name, [[items[i + j * rows] for j in range(cols)] for i in range(rows)]
    if cls == 2:  # struct
        t, raw = r.element()
        flen = int(_numbers(t, raw, e)[0])
        t, raw = r.element()
        raw = bytes(raw)
        names = [raw[i:i + flen].split(b"\0")[0].decode("latin1") for i in range(0, len(raw), flen)]
        recs = []
        for _ in range(n):
            rec = {}
            for fname in names:
                t, raw = r.element()
                rec[fname] = _matrix(raw, e, little)[1] if t == miMATRIX else None
            recs.append(rec)
        return name, recs[0] if n == 1 else recs
    if cls == 5:
        raise NotImplementedError("sparse MATLAB matrices are not supported yet")
    raise NotImplementedError("MATLAB array class %d (objects) is not supported" % cls)


def _shape(flat, dims):
    """MATLAB's column-major data as an array of shape dims."""
    if len(dims) == 1:
        dims = dims + [1]
    return flat.reshape(tuple(reversed(dims))).transpose()


def _read(f, appendmat):
    if isinstance(f, (bytes, bytearray)):
        data = bytes(f)
    elif hasattr(f, "read"):
        data = f.read()
    else:
        name = str(f)
        if appendmat and not name.endswith(".mat"):
            try:
                open(name, "rb").close()
            except OSError:
                name = name + ".mat"
        with open(name, "rb") as fh:
            data = fh.read()
    if data[:8] == b"\x89HDF\r\n\x1a\n" or data[512:520] == b"\x89HDF\r\n\x1a\n":
        raise NotImplementedError("MATLAB 7.3 (HDF5) files are not supported: save with -v7 instead")
    if len(data) < 128:
        raise MatReadError("not a MATLAB 5 file")
    little = data[126:128] == b"IM"
    if not little and data[126:128] != b"MI":
        raise MatReadError("MATLAB 4 files are not supported (not a level 5 file)")
    return data, little


def loadmat(file_name, mdict=None, appendmat=True, variable_names=None, squeeze_me=False, mat_dtype=False, **kwargs):
    """The variables of a .mat file: {name: value}, with scipy's
    __header__, __version__ and __globals__ entries."""
    if kwargs.get("chars_as_strings", True) is False or kwargs.get("simplify_cells", False):
        raise NotImplementedError("loadmat: chars_as_strings=False and simplify_cells=True are not supported")
    if isinstance(variable_names, str):
        variable_names = [variable_names]  # one exact name, not substrings
    data, little = _read(file_name, appendmat)
    e = "<" if little else ">"
    out = {"__header__": data[:116].rstrip(b" \0"), "__version__": "1.0", "__globals__": []}
    r = _Reader(data, 128, little)
    while len(data) - r.p >= 8:
        t, payload = r.element()
        if t != miMATRIX:
            continue
        name, value = _matrix(payload, e, little, mat_dtype)
        if variable_names is not None and name not in variable_names:
            continue
        if squeeze_me and isinstance(value, np.ndarray):
            value = value.squeeze()
            if value.ndim == 0:
                value = value.item()
        out[name] = value
    if mdict is not None:
        mdict.update(out)
        return mdict
    return out


def whosmat(file_name, **kwargs):
    """[(name, shape, class)] of the variables."""
    out = []
    cls = {"float64": "double", "float32": "single", "complex128": "double", "complex64": "single", "bool": "logical"}
    for k, v in loadmat(file_name).items():
        if k.startswith("__"):
            continue
        if isinstance(v, np.ndarray):
            out.append((k, tuple(v.shape), cls.get(v.dtype.name, v.dtype.name)))
        elif isinstance(v, dict):
            out.append((k, (1, 1), "struct"))
        elif isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            out.append((k, (1, len(v)), "struct"))
        elif isinstance(v, list) and all(isinstance(x, str) for x in v):
            out.append((k, (len(v),), "char"))  # (as SciPy reports a char array)
        elif isinstance(v, list):
            out.append((k, (len(v), len(v[0]) if v else 0), "cell"))
        else:
            out.append((k, (1, 1), type(v).__name__))
    return out


def _elem(t, payload):
    pad = (-len(payload)) % 8
    return struct.pack("<II", t, len(payload)) + payload + b"\0" * pad


def savemat(file_name, mdict, appendmat=True, format="5", do_compression=False, oned_as="row", **kwargs):
    """Write numeric arrays (real or complex) and strings as a MATLAB 5 file."""
    if str(format) != "5":
        raise ValueError("format must be '5' (MATLAB 4 files are not supported)" if str(format) == "4" else "format must be '4' or '5'")
    if oned_as not in ("row", "column"):
        raise ValueError("oned_as must be 'row' or 'column'")
    unknown = set(kwargs) - {"long_field_names"}
    if unknown:
        raise TypeError("savemat() got unexpected keyword arguments %s" % ", ".join(sorted(unknown)))
    head = b"MATLAB 5.0 MAT-file, Platform: sagebrush, Created by: sagebrush scipy.io".ljust(116)
    parts = [head + b"\0" * 8 + struct.pack("<H", 0x0100) + b"IM"]
    codes = {"float64": (6, 9), "float32": (7, 7), "int8": (8, 1), "uint8": (9, 2), "int16": (10, 3),
             "uint16": (11, 4), "int32": (12, 5), "uint32": (13, 6), "int64": (14, 12), "uint64": (15, 13),
             "bool": (9, 2)}
    for name, v in mdict.items():
        logical = False
        imag = None
        if isinstance(v, str):
            arr = np.array([ord(c) for c in v], dtype="uint16").reshape((1, len(v)))
            cls, mi = 4, 4
        else:
            arr = np.asarray(v)
            if arr.ndim == 0:
                arr = arr.reshape((1, 1))
            elif arr.ndim == 1:
                arr = arr.reshape((1, -1) if oned_as == "row" else (-1, 1))
            logical = arr.dtype.name == "bool"
            if logical:
                arr = arr.astype("uint8")
            if arr.dtype.kind == "c":
                # a complex array: the complex flag, then real and imaginary parts
                part = "float32" if arr.dtype.name == "complex64" else "float64"
                imag = np.ascontiguousarray(arr.imag).astype(part)
                arr = np.ascontiguousarray(arr.real).astype(part)
            if arr.dtype.name not in codes:
                if arr.dtype.kind not in "fiu":
                    raise TypeError("savemat: cannot save an array of dtype %s" % arr.dtype)
                arr = arr.astype("float64")
            cls, mi = codes[arr.dtype.name]
        flags = struct.pack("<II", cls | (0x0200 if logical else 0) | (0x0800 if imag is not None else 0), 0)
        dims = struct.pack("<%di" % arr.ndim, *arr.shape)
        body = (_elem(6, flags) + _elem(5, dims) + _elem(1, name.encode("latin1"))
                + _elem(mi, arr.tobytes(order="F")))
        if imag is not None:
            body += _elem(mi, imag.tobytes(order="F"))
        el = _elem(miMATRIX, body)
        if do_compression:
            z = zlib.compress(el)
            el = struct.pack("<II", miCOMPRESSED, len(z)) + z
        parts.append(el)
    data = b"".join(parts)
    if hasattr(file_name, "write"):
        file_name.write(data)
        return
    name = str(file_name)
    if appendmat and not name.endswith(".mat"):
        name += ".mat"
    with open(name, "wb") as fh:
        fh.write(data)
