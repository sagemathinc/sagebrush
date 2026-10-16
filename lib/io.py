"""In-memory streams and the io class hierarchy."""

import sys as _sys

SEEK_SET = 0
SEEK_CUR = 1
SEEK_END = 2
DEFAULT_BUFFER_SIZE = 8192


class UnsupportedOperation(OSError, ValueError):
    pass


# (a closed stream's ValueError: CPython's messages differ between the C
# methods, without a full stop, and IOBase's, with one)
_CLOSED = "I/O operation on closed file."


def _bytes_like(b):
    """b's bytes, for a write: a bytes-like object (one that exports a buffer,
    as memoryview takes: bytes, bytearray, memoryview, an array), or
    CPython's TypeError.  A method named tobytes is no buffer (CORR-50F-1)."""
    if isinstance(b, (bytes, bytearray)):
        return bytes(b)
    if isinstance(b, (str, int, float, complex, list, tuple, dict, set)) or b is None:
        raise TypeError("a bytes-like object is required, not '%s'" % type(b).__name__)
    try:
        view = memoryview(b)
    except TypeError:
        raise TypeError("a bytes-like object is required, not '%s'" % type(b).__name__) from None
    return view.tobytes()


_SSIZE_MAX = (1 << 63) - 1


def _ssize(v):
    if not -_SSIZE_MAX - 1 <= v <= _SSIZE_MAX:
        raise OverflowError("Python int too large to convert to C ssize_t")
    return v


def _index_hint(hint, msg):
    """StringIO's and a file's readlines hint, as CPython's
    _Py_convert_optional_to_ssize_t: None, or an index (an int's own value;
    else its type's __index__, whose result must be an int), in ssize_t
    range"""
    if hint is None:
        return None
    if isinstance(hint, int):
        v = int.__index__(hint)
    else:
        f = getattr(type(hint), "__index__", None)
        if f is None:
            raise TypeError(msg % type(hint).__name__)
        v = f(hint)
        if not isinstance(v, int):
            raise TypeError("__index__ returned non-int (type %s)" % type(v).__name__)
        v = int.__index__(v)
    if not -_SSIZE_MAX - 1 <= v <= _SSIZE_MAX:
        raise OverflowError("cannot fit '%s' into an index-sized integer" % type(hint).__name__)
    return v


def _int_hint(hint, msg):
    """BytesIO's readlines size: None or an int (its own value), else
    CPython's TypeError"""
    if hint is None:
        return None
    if not isinstance(hint, int):
        raise TypeError(msg % type(hint).__name__)
    return _ssize(int.__index__(hint))


def _readlines(f, hint, stop_at_hint, text):
    """f's lines, as CPython's readlines(hint): all of them for a hint that is
    None, 0 or negative; else up to the line after which their total length
    exceeds the hint (or, stop_at_hint, reaches it, as BytesIO's).  The hint
    is already converted; a text line's length is in characters (Sagebrush's
    strings count one beyond U+FFFF as two)."""
    out = []
    total = 0
    while True:
        line = f.readline()
        if not line:
            return out
        out.append(line)
        total += len(list(line)) if text else len(line)
        if hint is not None and hint > 0 and (total >= hint if stop_at_hint else total > hint):
            return out


class IOBase:
    closed = False

    def _unsupported(self, name):
        raise UnsupportedOperation(name)

    def _checkClosed(self, msg=_CLOSED):
        if self.closed:
            raise ValueError(msg)

    def seek(self, pos, whence=0):
        self._unsupported("seek")

    def tell(self):
        return self.seek(0, 1)

    def truncate(self, pos=None):
        self._unsupported("truncate")

    def flush(self):
        if self.closed:
            raise ValueError("I/O operation on closed file.")

    def close(self):
        if not self.closed:
            try:
                self.flush()
            finally:
                self.closed = True

    def seekable(self):
        return False

    def readable(self):
        return False

    def writable(self):
        return False

    def isatty(self):
        self._checkClosed()
        return False

    def fileno(self):
        self._unsupported("fileno")

    def __enter__(self):
        if self.closed:
            raise ValueError("I/O operation on closed file.")
        return self

    def __exit__(self, *args):
        self.close()

    def readline(self, size=-1):
        res = bytearray()
        while size is None or size < 0 or len(res) < size:
            b = self.read(1)
            if not b:
                break
            res += b
            if res.endswith(b"\n"):
                break
        return bytes(res)

    def readlines(self, hint=None):
        hint = _index_hint(hint, "argument should be integer or None, not '%s'")
        self._checkClosed()
        return _readlines(self, hint, False, isinstance(self, TextIOBase))

    def writelines(self, lines):
        self._checkClosed()
        for line in lines:
            self.write(line)

    def __iter__(self):
        self._checkClosed()
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def __del__(self):
        pass


class RawIOBase(IOBase):
    def read(self, size=-1):
        if size is None or size < 0:
            return self.readall()
        b = bytearray(size)
        n = self.readinto(b)
        if n is None:
            return None
        return bytes(b[:n])

    def readall(self):
        res = bytearray()
        while True:
            data = self.read(DEFAULT_BUFFER_SIZE)
            if not data:
                break
            res += data
        return bytes(res)


class BufferedIOBase(IOBase):
    pass


class TextIOBase(IOBase):
    encoding = "utf-8"
    errors = "strict"
    newlines = None


class BytesIO(BufferedIOBase):
    def __init__(self, initial_bytes=b""):
        self._buf = bytearray(initial_bytes)
        self._pos = 0
        self.closed = False

    def _check(self):
        if self.closed:
            raise ValueError("I/O operation on closed file.")

    def getvalue(self):
        self._check()
        return bytes(self._buf)

    def flush(self):
        self._check()

    def __iter__(self):
        return self  # (CPython's BytesIO: even closed; next() then refuses)

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def getbuffer(self):
        return self._buf

    def read(self, size=-1):
        self._check()
        end = len(self._buf) if size is None or size < 0 else self._pos + size
        b = bytes(self._buf[self._pos:end])
        self._pos += len(b)
        return b

    read1 = read

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)

    def readline(self, size=-1):
        self._check()
        i = self._buf.find(b"\n", self._pos)
        end = len(self._buf) if i < 0 else i + 1
        if size is not None and size >= 0:
            end = min(end, self._pos + size)
        b = bytes(self._buf[self._pos:end])
        self._pos += len(b)
        return b

    def readlines(self, size=None):
        # (closed first, then the size, as CPython's)
        self._checkClosed()
        return _readlines(self, _int_hint(size, "integer argument expected, got '%s'"), True, False)

    def write(self, b):
        b = _bytes_like(b)  # (the argument first, then closed, as CPython's)
        self._check()
        n = len(b)
        if self._pos > len(self._buf):
            self._buf += bytes(self._pos - len(self._buf))
        self._buf[self._pos:self._pos + n] = b
        self._pos += n
        return n

    def seek(self, pos, whence=0):
        self._check()
        if whence == 0:
            if pos < 0:
                raise ValueError("negative seek value %d" % pos)
            self._pos = pos
        elif whence == 1:
            self._pos = max(0, self._pos + pos)
        elif whence == 2:
            self._pos = max(0, len(self._buf) + pos)
        else:
            raise ValueError("invalid whence (%r, should be 0, 1 or 2)" % whence)
        return self._pos

    def tell(self):
        self._check()
        return self._pos

    def truncate(self, size=None):
        self._check()
        size = self._pos if size is None else size
        del self._buf[size:]
        return size

    def seekable(self):
        self._check()
        return True

    def readable(self):
        self._check()
        return True

    def writable(self):
        self._check()
        return True

    def close(self):
        self.closed = True


class StringIO(TextIOBase):
    def __init__(self, initial_value="", newline="\n"):
        self._parts = [initial_value] if initial_value else []
        self._pos = 0
        self.closed = False

    def _check(self):
        if self.closed:
            raise ValueError("I/O operation on closed file")

    def _value(self):
        if len(self._parts) > 1:
            self._parts = ["".join(self._parts)]
        return self._parts[0] if self._parts else ""

    def write(self, s):
        # (the argument first, then closed, as CPython's, CORR-606-4)
        if not isinstance(s, str):
            raise TypeError(f"string argument expected, got '{type(s).__name__}'")
        self._check()
        v = self._value()
        if self._pos == len(v):
            self._parts.append(s)
        else:
            self._parts = [v[: self._pos] + s + v[self._pos + len(s) :]]
        self._pos += len(s)
        return len(s)

    def writelines(self, lines):
        self._checkClosed()
        for line in lines:
            self.write(line)

    def getvalue(self):
        self._check()
        return self._value()

    def read(self, size=-1):
        self._check()
        v = self._value()
        end = len(v) if size is None or size < 0 else self._pos + size
        s = v[self._pos : end]
        self._pos += len(s)
        return s

    def readline(self, size=-1):
        self._check()
        v = self._value()
        i = v.find("\n", self._pos)
        end = len(v) if i < 0 else i + 1
        if size is not None and size >= 0:
            end = min(end, self._pos + size)
        s = v[self._pos : end]
        self._pos = end
        return s

    def readlines(self, hint=None):
        # (the hint first, then closed, as CPython's)
        hint = _index_hint(hint, "argument should be integer or None, not '%s'")
        self._checkClosed()
        return _readlines(self, hint, False, True)

    def __iter__(self):
        self._checkClosed()
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def seek(self, pos, whence=0):
        self._check()
        self._pos = pos if whence == 0 else (self._pos + pos if whence == 1 else len(self._value()) + pos)
        return self._pos

    def tell(self):
        self._check()
        return self._pos

    def truncate(self, size=None):
        self._check()
        v = self._value()
        size = self._pos if size is None else size
        self._parts = [v[:size]]
        return size

    def readable(self):
        self._check()
        return True

    def writable(self):
        self._check()
        return True

    def seekable(self):
        self._check()
        return True

    def close(self):
        self.closed = True

    def flush(self):
        pass

    def __enter__(self):
        self._checkClosed()
        return self

    def __exit__(self, *exc):
        self.close()
