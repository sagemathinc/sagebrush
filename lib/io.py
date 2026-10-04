"""In-memory streams and the io class hierarchy."""

import sys as _sys

SEEK_SET = 0
SEEK_CUR = 1
SEEK_END = 2
DEFAULT_BUFFER_SIZE = 8192


class UnsupportedOperation(OSError, ValueError):
    pass


class IOBase:
    closed = False

    def _unsupported(self, name):
        raise UnsupportedOperation(name)

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
        return list(self)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def __iter__(self):
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

    def write(self, b):
        self._check()
        if isinstance(b, str):
            raise TypeError("a bytes-like object is required, not 'str'")
        b = bytes(b)
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
        return True

    def readable(self):
        return True

    def writable(self):
        return True

    def close(self):
        self.closed = True


class StringIO(TextIOBase):
    def __init__(self, initial_value="", newline="\n"):
        self._parts = [initial_value] if initial_value else []
        self._pos = 0
        self.closed = False

    def _value(self):
        if len(self._parts) > 1:
            self._parts = ["".join(self._parts)]
        return self._parts[0] if self._parts else ""

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"string argument expected, got '{type(s).__name__}'")
        v = self._value()
        if self._pos == len(v):
            self._parts.append(s)
        else:
            self._parts = [v[: self._pos] + s + v[self._pos + len(s) :]]
        self._pos += len(s)
        return len(s)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def getvalue(self):
        return self._value()

    def read(self, size=-1):
        v = self._value()
        end = len(v) if size is None or size < 0 else self._pos + size
        s = v[self._pos : end]
        self._pos += len(s)
        return s

    def readline(self, size=-1):
        v = self._value()
        i = v.find("\n", self._pos)
        end = len(v) if i < 0 else i + 1
        if size is not None and size >= 0:
            end = min(end, self._pos + size)
        s = v[self._pos : end]
        self._pos = end
        return s

    def readlines(self):
        out = []
        while True:
            line = self.readline()
            if not line:
                return out
            out.append(line)

    def __iter__(self):
        return iter(self.readlines())

    def seek(self, pos, whence=0):
        self._pos = pos if whence == 0 else (self._pos + pos if whence == 1 else len(self._value()) + pos)
        return self._pos

    def tell(self):
        return self._pos

    def truncate(self, size=None):
        v = self._value()
        size = self._pos if size is None else size
        self._parts = [v[:size]]
        return size

    def close(self):
        self.closed = True

    def flush(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
