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

    def write(self, s):
        if "r" in self.mode and "+" not in self.mode:
            raise io.UnsupportedOperation("not writable")
        self._dirty = True
        _unwritten[id(self)] = self
        return super().write(s)

    def close(self):
        if not self.closed:
            self.flush()
            super().close()

    def readable(self):
        return "r" in self.mode or "+" in self.mode

    def writable(self):
        return "r" not in self.mode or "+" in self.mode

    def __repr__(self):
        return "<_io.%s name=%r mode=%r>" % ("TextIOWrapper" if isinstance(self, io.TextIOBase) else "BufferedReader", self.name, self.mode)

    def __del__(self):
        pass


class TextFile(_Mixin, io.StringIO):
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
