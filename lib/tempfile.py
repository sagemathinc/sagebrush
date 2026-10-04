"""A small tempfile: gettempdir, mktemp, mkstemp, mkdtemp, NamedTemporaryFile,
TemporaryDirectory (names from os.urandom; no O_EXCL races handled)."""

import os

tempdir = None
template = "tmp"


def gettempdir():
    return tempdir or os.environ.get("TMPDIR") or "/tmp"


def _name(prefix, suffix, dir):
    return os.path.join(dir or gettempdir(), (prefix if prefix is not None else template) + os.urandom(6).hex() + (suffix or ""))


def mktemp(suffix="", prefix=template, dir=None):
    return _name(prefix, suffix, dir)


def mkstemp(suffix=None, prefix=None, dir=None, text=False):
    name = _name(prefix, suffix, dir)
    open(name, "x").close()
    return (-1, name)


def mkdtemp(suffix=None, prefix=None, dir=None):
    name = _name(prefix, suffix, dir)
    os.mkdir(name)
    return name


class NamedTemporaryFile:
    def __init__(self, mode="w+b", buffering=-1, encoding=None, newline=None, suffix=None, prefix=None, dir=None, delete=True, **kw):
        self.name = _name(prefix, suffix, dir)
        open(self.name, "x").close()
        self.file = open(self.name, mode.replace("x", "w").replace("w+", "r+") if os.path.exists(self.name) else mode, encoding=encoding) if "w" not in mode else open(self.name, mode.replace("+", ""), encoding=encoding)
        self.delete = delete

    def __getattr__(self, name):
        return getattr(self.file, name)

    def close(self):
        self.file.close()
        if self.delete and os.path.exists(self.name):
            os.remove(self.name)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class TemporaryDirectory:
    def __init__(self, suffix=None, prefix=None, dir=None, **kw):
        self.name = mkdtemp(suffix, prefix, dir)

    def cleanup(self):
        def rm(p):
            if os.path.isdir(p):
                for c in os.listdir(p):
                    rm(os.path.join(p, c))
                os.rmdir(p)
            else:
                os.remove(p)
        if os.path.exists(self.name):
            rm(self.name)

    def __enter__(self):
        return self.name

    def __exit__(self, *a):
        self.cleanup()
