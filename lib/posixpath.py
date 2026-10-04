"""os.path for POSIX paths (a subset of CPython's posixpath)."""

import _fs

sep = "/"
curdir = "."
pardir = ".."
extsep = "."
pathsep = ":"
defpath = "/bin:/usr/bin"
altsep = None
devnull = "/dev/null"


def _s(p):
    if hasattr(p, "__fspath__"):
        p = p.__fspath__()
    return p


def isabs(s):
    return _s(s).startswith("/")


def join(a, *p):
    path = _s(a)
    for b in map(_s, p):
        if b.startswith("/"):
            path = b
        elif not path or path.endswith("/"):
            path += b
        else:
            path += "/" + b
    return path


def split(p):
    p = _s(p)
    i = p.rfind("/") + 1
    head, tail = p[:i], p[i:]
    if head and head != "/" * len(head):
        head = head.rstrip("/")
    return head, tail


def splitext(p):
    p = _s(p)
    sep_i = p.rfind("/")
    dot_i = p.rfind(".")
    if dot_i > sep_i:
        filename_i = sep_i + 1
        while filename_i < dot_i:
            if p[filename_i] != ".":
                return p[:dot_i], p[dot_i:]
            filename_i += 1
    return p, p[:0]


def basename(p):
    p = _s(p)
    return p[p.rfind("/") + 1:]


def dirname(p):
    p = _s(p)
    i = p.rfind("/") + 1
    head = p[:i]
    if head and head != "/" * len(head):
        head = head.rstrip("/")
    return head


def normpath(path):
    path = _s(path)
    if not path:
        return "."
    initial = 1 if path.startswith("/") else 0
    if initial and path.startswith("//") and not path.startswith("///"):
        initial = 2
    comps = path.split("/")
    new = []
    for comp in comps:
        if comp in ("", "."):
            continue
        if comp != ".." or (not initial and not new) or (new and new[-1] == ".."):
            new.append(comp)
        elif new:
            new.pop()
    path = "/".join(new)
    if initial:
        path = "/" * initial + path
    return path or "."


def abspath(path):
    import os
    path = _s(path)
    if not isabs(path):
        path = join(os.getcwd(), path)
    return normpath(path)


realpath = abspath


def exists(path):
    return _fs.exists(_s(path))


lexists = exists


def isdir(path):
    return _fs.isdir(_s(path))


def isfile(path):
    return _fs.exists(_s(path)) and not _fs.isdir(_s(path))


def islink(path):
    return False


def getsize(path):
    import os
    return os.stat(path).st_size


def expanduser(path):
    import os
    path = _s(path)
    if path == "~" or path.startswith("~/"):
        return os.environ.get("HOME", "/") + path[1:]
    return path


def relpath(path, start=None):
    start = abspath(start or ".")
    path = abspath(path)
    s = [x for x in start.split("/") if x]
    p = [x for x in path.split("/") if x]
    i = 0
    while i < min(len(s), len(p)) and s[i] == p[i]:
        i += 1
    rel = [".."] * (len(s) - i) + p[i:]
    return join(*rel) if rel else "."


def commonprefix(m):
    if not m:
        return ""
    s1, s2 = min(m), max(m)
    for i, c in enumerate(s1):
        if c != s2[i]:
            return s1[:i]
    return s1
