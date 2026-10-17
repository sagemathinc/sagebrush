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

# ------------------------------------------------------------------ astra's CORR-9C4-1..5
# (a str or bytes subclass's payload taken as it is where CPython's C
# converters take it: no override of it runs)
class Slice(str):
    def __getitem__(self, key):
        raise RuntimeError("slice hook")


class Falsy(str):
    def __bool__(self):
        return False


class Decode(bytes):
    def decode(self, *a, **kw):
        raise RuntimeError("decode hook")


for f in ["exists", "lexists", "isfile", "isdir", "islink"]:
    show("%s(S('/dev/null'))" % f, lambda: getattr(os.path, f)(S("/dev/null")))
    show("%s(Decode(b'/dev/null'))" % f, lambda: getattr(os.path, f)(Decode(b"/dev/null")))
    show("%s(B(b'/dev/null'))" % f, lambda: getattr(os.path, f)(B(b"/dev/null")))
show("normpath(Slice('/a/../b'))", lambda: os.path.normpath(Slice("/a/../b")))
show("splitroot(Slice('//a/b'))", lambda: os.path.splitroot(Slice("//a/b")))
show("normpath(Falsy('/a/../b'))", lambda: os.path.normpath(Falsy("/a/../b")))
show("normpath(Falsy(''))", lambda: os.path.normpath(Falsy("")))
show("normpath type of S", lambda: type(os.path.normpath(S("a//b"))).__name__)
show("normpath type of B", lambda: type(os.path.normpath(B(b"a//b"))).__name__)
show("fspath keeps S", lambda: type(os.fspath(S("a"))).__name__)


# (a descriptor __fspath__: bound to the object once, as a special method)
trace = []


class Des:
    def __get__(self, obj, owner):
        trace.append(obj is None)
        return lambda: "/dev/null"


class DP:
    __fspath__ = Des()


class SM:
    __fspath__ = staticmethod(lambda: "/dev/null")


class CM:
    @classmethod
    def __fspath__(cls):
        return "/dev/" + "null"


class Inst:
    pass


inst = Inst()
inst.__fspath__ = lambda: "/dev/null"
for label, o in [("Des", DP()), ("staticmethod", SM()), ("classmethod", CM()), ("instance attribute", inst)]:
    for f in ["normpath", "splitroot", "exists", "islink", "isabs", "basename"]:
        show("%s(%s)" % (f, label), lambda: getattr(os.path, f)(o))
    show("fspath(%s)" % label, lambda: os.fspath(o))
    show("join(%s, 'x')" % label, lambda: os.path.join(o, "x"))
print("descriptor trace", trace)


# (what __fspath__ raises: OSError and ValueError mean False in the five
# predicates; anything else propagates)
class Raises:
    def __init__(self, e):
        self.e = e

    def __fspath__(self):
        raise self.e


for e in [ValueError("path conversion"), FileNotFoundError(2, "no"), OSError("plain"), UnicodeEncodeError("utf-8", "x", 0, 1, "no"), TypeError("t"), RuntimeError("r"), KeyError("k")]:
    for f in ["exists", "lexists", "isfile", "isdir", "islink"]:
        show("%s(Raises(%s))" % (f, type(e).__name__), lambda: getattr(os.path, f)(Raises(e)))
    show("normpath(Raises(%s))" % type(e).__name__, lambda: os.path.normpath(Raises(e)))


# (stat takes a file descriptor first: an int or an object with __index__,
# before any __fspath__; lstat takes none)
class IntPath(int):
    def __fspath__(self):
        return "/dev/null"


class IndexPath:
    def __index__(self):
        return -1

    def __fspath__(self):
        return "/dev/null"


class IndexOnly:
    def __index__(self):
        return -1


class BigIndex:
    def __index__(self):
        return 2 ** 40


class BadIndex:
    def __index__(self):
        return "x"


for label, o in [("IntPath(-1)", IntPath(-1)), ("IndexPath", IndexPath()), ("IndexOnly", IndexOnly()), ("-1", -1), ("-2**31", -2 ** 31),
                 ("2**40", 2 ** 40), ("-2**40", -2 ** 40), ("BigIndex", BigIndex()), ("BadIndex", BadIndex()), ("2**70", 2 ** 70)]:
    for f in ["exists", "lexists", "isfile", "isdir", "islink"]:
        show("%s(%s)" % (f, label), lambda: getattr(os.path, f)(o))
for label, o in [("IntPath(-1)", IntPath(-1)), ("IndexPath", IndexPath()), ("IndexOnly", IndexOnly())]:
    show("normpath(%s)" % label, lambda: os.path.normpath(o))

# (realpath's strict: False as before; anything else is refused, apart)
show("realpath strict=False", lambda: os.path.realpath("/a/../b", strict=False))
show("realpath strict=0", lambda: os.path.realpath("/a/../b", strict=0))


# ------------------------------------------------------------------ astra's CORR-E51-1
# (a str or bytes subclass is a path, whatever __index__ it has: CPython never
# asks it; a returned subclass the same. astra's battery)
trace = []


def tshow(label, f):
    trace.clear()
    try:
        print(label, repr(f()), trace)
    except Exception as e:
        print(label, type(e).__name__, str(e).split("\n")[0], trace)


class IS(str):
    def __index__(self):
        trace.append("index")
        return -1

    def __fspath__(self):
        trace.append("fspath")
        return "/nope"


class IB(bytes):
    def __index__(self):
        trace.append("index")
        return -1

    def __fspath__(self):
        trace.append("fspath")
        return b"/nope"


class NoneIndex(str):
    __index__ = None


class BadIndex2(str):
    def __index__(self):
        raise RuntimeError("index")


class Returned:
    def __init__(self, v):
        self.v = v

    def __fspath__(self):
        trace.append("fspath")
        return self.v


for label, x in [("IS", IS("/dev/null")), ("IB", IB(b"/dev/null")), ("NoneIndex", NoneIndex("/dev/null")), ("BadIndex2", BadIndex2("/dev/null")),
                 ("Returned IS", Returned(IS("/dev/null"))), ("Returned IB", Returned(IB(b"/dev/null")))]:
    for f in ("exists", "isfile", "isdir", "lexists", "islink", "normpath", "splitroot"):
        tshow("%s %s" % (label, f), lambda: getattr(os.path, f)(x))


class IntOverride(int):
    def __index__(self):
        raise RuntimeError("int override")


for x in [IntOverride(-1), IntOverride(-2 ** 31), IntOverride(2 ** 63)]:
    tshow("IntOverride %d exists" % x, lambda: os.path.exists(x))
