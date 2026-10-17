# os.path (lib/posixpath.py) as CPython 3.14's posixpath gives it, compared
# line by line (test/stdlib-posixpath.test.ts): each function over str,
# bytes, os.PathLike objects and what is none of those; str and bytes
# together; and, in the directory PP_DIR the test made (a file, a directory,
# symbolic links to each, a dangling one, a FIFO), the file system's answers.
import os
import os.path
import posixpath


def name(e):
    return type(e).__qualname__


def show(label, f):
    try:
        r = f()
    except BaseException as e:
        print(label, "!!", name(e), str(e)[:200], "| context:", name(e.__context__) if e.__context__ is not None else None)
    else:
        print(label, "->", repr(r))


class P:
    def __init__(self, p):
        self.p = p

    def __fspath__(self):
        return self.p


class S(str):
    pass


class B(bytes):
    pass


def lbl(v):
    if isinstance(v, P):
        return "P(%r)" % (v.p,)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(lbl(x) for x in v) + "]"
    if isinstance(v, memoryview):
        return "memoryview"
    return repr(v)


print("same module", os.path is posixpath)
VALUES = ["", "/", "//", "///", "a", "/a", "//a", "///a", "a/b", "a//b", "a/./b", "a/../b", "/a/../..", "../a", "a/..",
          "a/b/", ".", "..", "/..", "a.b", ".a", "a/.b", "a.b.c", "a/b.c/d", "..a", "a..", "~", "~/x", "~x/y",
          "\ud800/x", "a\x00b",
          b"", b"/", b"//a", b"a/b/", b"a/../b", b"a.b", b"~/x", b"\xff/x",
          P("a/b"), P(b"a/b"), S("a/b"), B(b"a/b"), P(5), P(None), 5, None, 1.5, ["a"], bytearray(b"a"), memoryview(b"a")]
FUNCS = ["isabs", "split", "splitext", "splitdrive", "splitroot", "basename", "dirname", "normpath", "normcase"]
for f in FUNCS:
    for v in VALUES:
        show("%s(%s)" % (f, lbl(v)), lambda: getattr(os.path, f)(v))

for args in [("a", "b"), ("a", "/b"), ("a/", "b"), ("", "b"), ("a", ""), ("a", "b", "/c", "d"), (b"a", b"b"), (P("a"), "b"),
             ("a", P("b")), ("a", b"b"), (b"a", "b"), ("a", 5), (5, "a"), (b"a", 5), ("a", None), ("a",), (),
             (S("a"), "b"), (B(b"a"), b"b"), ("a", P(b"b")), ("a", bytearray(b"b"))]:
    show("join%s" % lbl(args), lambda: os.path.join(*args))

os.environ["HOME"] = "/home/someone/"
for v in ["~", "~/x", "~x/y", "x~", b"~", b"~/x", "", P("~/x"), 5]:
    show("expanduser(%s)" % lbl(v), lambda: os.path.expanduser(v))
os.environ["HOME"] = ""
show("expanduser empty HOME", lambda: (os.path.expanduser("~"), os.path.expanduser("~/x")))

cwd = os.getcwd()
for v in ["a", "/a/../b", "", b"a", b"/x/../y", P("a"), 5]:
    show("abspath(%s) relative to cwd" % lbl(v), lambda: (lambda r: r.replace(cwd, "<cwd>") if isinstance(r, str) else r.replace(cwd.encode(), b"<cwd>"))(os.path.abspath(v)))
for args in [("/a/b/c", "/a"), ("/a", "/a/b/c"), ("/a/b", "/c/d"), ("/a", "/a"), (b"/a/b", b"/a"), ("/a/b", b"/a"), (b"/a", "/a"),
             ("", "/a"), ("/a", None), ("/a", 5), (5, "/a"), (P("/a/b"), P("/a"))]:
    show("relpath%s" % lbl(args), lambda: os.path.relpath(*args))
for args in [["/a/b", "/a/c"], ["a/b", "a/c"], ["/a", "a"], [], ["/a/b"], [b"/a/b", b"/a/c"], ["/a", b"/a"], [5], ["a/./b", "a/b/c"], [P("/a/b"), "/a"]]:
    show("commonpath(%s)" % lbl(args), lambda: os.path.commonpath(args))
for args in [["abc", "abd"], [], ["a"], [b"ab", b"ac"], [["a", "b"], ["a", "c"]], ["a", b"a"], [P("ab"), "ac"]]:
    show("commonprefix(%s)" % lbl(args), lambda: os.path.commonprefix(args))

d = os.environ.get("PP_DIR")
if d:
    paths = {"file": d + "/file", "dir": d + "/dir", "link-file": d + "/link-file", "link-dir": d + "/link-dir",
             "dangling": d + "/dangling", "fifo": d + "/fifo", "missing": d + "/missing", "nul": d + "/a\x00b",
             "surrogate": d + "/\udcff", "lone surrogate": d + "/\ud800", "file/x": d + "/file/x"}
    for label, p in paths.items():
        for f in ["exists", "lexists", "isfile", "isdir", "islink"]:
            show("%s(%s)" % (f, label), lambda: getattr(os.path, f)(p))
            if label in ("file", "dir", "link-dir", "nul"):
                show("%s(bytes %s)" % (f, label), lambda: getattr(os.path, f)(p.encode("utf-8", "surrogateescape")))
                show("%s(P %s)" % (f, label), lambda: getattr(os.path, f)(P(p)))
    for f in ["exists", "lexists", "isfile", "isdir", "islink"]:
        for v in [None, 1.5, P(5), "", b""]:
            show("%s(%r)" % (f, v if not isinstance(v, P) else "P(5)"), lambda: getattr(os.path, f)(v))
