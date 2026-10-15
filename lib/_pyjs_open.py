"""open() for the pyjs runtime: whole-file reads, writes on flush/close.

Without reference counting a file object is not closed when the last
reference goes (`open(f, "w").write(s)`), so files with unwritten data are
remembered and _flush_all() writes them: after each notebook cell and when a
program ends."""

import io
import _fs

_unwritten = {}


def _flush_all():
    for f in list(_unwritten.values()):
        try:
            f.flush()
        except Exception:
            _unwritten.pop(id(f), None)


class _Mixin:
    def _setup(self, name, mode, append):
        self.name = name
        self.mode = mode
        self._append = append
        self._dirty = False

    def flush(self):
        if self._dirty:
            data = self.getvalue()
            if isinstance(data, str):
                data = data.encode(self.encoding)
            _fs.write(self.name, data, self._append)
            if self._append:
                self._reset()
            self._dirty = False
        _unwritten.pop(id(self), None)

    def _write(self, s):
        self._dirty = True
        _unwritten[id(self)] = self
        return super().write(s)

    def close(self):
        if not self.closed:
            self.flush()
            super().close()

    def _r(self):
        return "r" in self.mode or "+" in self.mode

    def _w(self):
        return "r" not in self.mode or "+" in self.mode

    # (readable() and writable() answer False for what the mode does not
    # allow, closed or not, and refuse on a closed file otherwise, as CPython's)
    def readable(self):
        if not self._r():
            return False
        self._closed_check(_PLAIN)
        return True

    def writable(self):
        if not self._w():
            return False
        self._closed_check(_PLAIN)
        return True

    def seekable(self):
        self._closed_check(_PLAIN)
        return True

    def isatty(self):
        self._closed_check(_PLAIN)
        return False

    def _closed_check(self, msg=None):
        if self.closed:
            raise ValueError(msg or _DOT)

    def __iter__(self):
        self._closed_check()
        return self

    def __enter__(self):
        self._closed_check()
        return self

    def __exit__(self, *exc):
        self.close()

    def readlines(self, hint=None):
        self._closed_check()
        return io._readlines(self, hint, False, "argument should be integer or None, not '%s'")

    def writelines(self, lines):
        self._closed_check()
        for line in lines:
            self.write(line)

    def __repr__(self):
        return "<_io.%s name=%r mode=%r>" % ("TextIOWrapper" if isinstance(self, io.TextIOBase) else "BufferedReader", self.name, self.mode)

    def __del__(self):
        pass


# What a closed file says (CPython's TextIOWrapper, BufferedReader/Writer):
# test/closed_io_cases.py
_DOT = "I/O operation on closed file."
_PLAIN = "I/O operation on closed file"


class TextFile(_Mixin, io.StringIO):
    # (a text file: closed first, then what the mode allows)
    def _readcheck(self):
        self._closed_check()
        if not self._r():
            raise io.UnsupportedOperation("not readable")

    def read(self, size=-1):
        self._readcheck()
        return super().read(size)

    def readline(self, size=-1):
        self._readcheck()
        return super().readline(size)

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def write(self, s):
        # (the argument first, as CPython's TextIOWrapper)
        if not isinstance(s, str):
            raise TypeError("write() argument must be str, not %s" % ("None" if s is None else type(s).__name__))
        self._closed_check()
        if not self._w():
            raise io.UnsupportedOperation("not writable")
        return self._write(s)

    def seek(self, pos, whence=0):
        self._closed_check()
        return super().seek(pos, whence)

    def tell(self):
        self._closed_check()
        return super().tell()

    def truncate(self, size=None):
        self._closed_check()
        return super().truncate(size)

    def flush(self):
        self._closed_check()
        _Mixin.flush(self)

    def __init__(self, name, mode, initial, append, encoding):
        io.StringIO.__init__(self, initial)
        self.encoding = encoding or "utf-8"
        self._setup(name, mode, append)
        if append:
            self._reset()
        elif "a" not in mode:
            self.seek(0)

    def _reset(self):
        io.StringIO.__init__(self, "")


class BinaryFile(_Mixin, io.BytesIO):
    # (a binary file: what the mode allows first, then closed, in the
    # buffered classes' own words)
    def _readcheck(self, what):
        if not self._r():
            raise io.UnsupportedOperation("read")
        self._closed_check(what + " of closed file")

    def read(self, size=-1):
        self._readcheck("read")
        return super().read(size)

    read1 = read

    def readinto(self, b):
        self._readcheck("readinto")
        return super().readinto(b)

    def readline(self, size=-1):
        self._readcheck("readline")
        return super().readline(size)

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def write(self, b):
        if not self._w():
            raise io.UnsupportedOperation("write")
        b = io._bytes_like(b)  # (then closed, as CPython's BufferedWriter)
        self._closed_check("write to closed file")
        return self._write(b)

    def seek(self, pos, whence=0):
        self._closed_check("seek of closed file")
        return super().seek(pos, whence)

    def tell(self):
        self._closed_check(_PLAIN)
        return super().tell()

    def truncate(self, size=None):
        self._closed_check("truncate of closed file")
        return super().truncate(size)

    def flush(self):
        self._closed_check("flush of closed file" if self._w() else None)
        _Mixin.flush(self)

    def __init__(self, name, mode, initial, append):
        io.BytesIO.__init__(self, initial)
        self.encoding = None
        self._setup(name, mode, append)
        if append:
            self._reset()

    def _reset(self):
        io.BytesIO.__init__(self, b"")


def open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
    if not isinstance(file, str):
        file = getattr(file, "__fspath__", lambda: file)()
    if not isinstance(mode, str) or not set(mode) <= set("rwxabt+"):
        raise ValueError("invalid mode: %r" % (mode,))
    binary = "b" in mode
    # unwritten data of an unclosed file object of the same path is written
    # first, so open(f, "w").write(s) followed by a read sees s (as in CPython)
    for f in list(_unwritten.values()):
        if getattr(f, "name", None) == file:
            try:
                f.flush()
            except Exception:
                pass
    if "x" in mode and _fs.exists(file):
        raise FileExistsError(17, "File exists", file)
    if "r" in mode:
        data = _fs.read(file)
    else:
        if _fs.isdir(file):
            raise IsADirectoryError(21, "Is a directory", file)
        data = b""
        if "w" in mode or "x" in mode:
            _fs.write(file, b"", False)
    append = "a" in mode
    if binary:
        return BinaryFile(file, mode, data, append)
    text = data.decode(encoding or "utf-8", errors or "strict")
    if newline is None:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    return TextFile(file, mode, text, append, encoding)
