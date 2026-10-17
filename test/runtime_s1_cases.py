# The runtime differences html's and importlib's cases found, compared with
# CPython 3.14 by test/stdlib-html-importlib.test.ts: unpacking's count,
# `in` without __contains__, re's subject, startswith and endswith of str
# and bytes, ImportError's keywords and attributes, keywords to an
# exception's constructor, and None in sys.modules.
import collections
import re
import sys


def show(label, f):
    try:
        print(label, "->", ascii(f()))
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


class L(list):
    pass


class T2(tuple):
    pass


class S(str):
    pass


def one(v):
    (a,) = v
    return a


def two(v):
    a, b = v
    return a, b


for v in [[1, 2], (1, 2), {1: 0, 2: 0}, "ab", {1, 2}, iter([1, 2]), L([1, 2]), T2((1, 2)), range(2), b"ab",
          collections.deque([1, 2]), {1: 0, 2: 0}.keys(), frozenset({1, 2}), collections.OrderedDict(a=1, b=2)]:
    show("unpack 1 from %s" % type(v).__name__, lambda: one(v))
for v in [[1], (1,), "a", iter([1]), {1: 0}, L([1])]:
    show("unpack 2 from %s" % type(v).__name__, lambda: two(v))


class NoIter:
    pass


class IterRaises:
    def __iter__(self):
        raise TypeError("my own")


class IterNotIterator:
    def __iter__(self):
        return 5


for c in [None, 5, 1.5, NoIter(), IterRaises(), IterNotIterator(), len]:
    show("'a' in %s" % type(c).__name__, lambda: "a" in c)
show("in a list", lambda: (2 in [1, 2], 3 in (1, 2)))

for x in [5, None, 1.5, ["a"], b"aa", bytearray(b"aa"), memoryview(b"aa"), "aa", S("aa")]:
    show("re.sub str pattern on %s" % type(x).__name__, lambda: re.sub("a", "b", x))
    show("re.sub bytes pattern on %s" % type(x).__name__, lambda: re.sub(b"a", b"b", x))
show("re on a str subclass", lambda: (re.match("a", S("ab")).group(), type(re.match("a", S("ab")).string).__name__,
                                      re.findall("a", S("aba")), re.split("b", S("aba"))))
show("re.sub with a str subclass template", lambda: re.sub("a", S(r"<\g<0>>"), "aa"))

for p in ["x", S("x"), ("q", "x"), ("x", 5), ("q", 5), (5,), (), ["x"], 5, b"x", None]:
    show("'xy'.startswith(%s)" % ascii(p), lambda: "xy".startswith(p))
    show("'xy'.endswith(%s)" % ascii(p), lambda: "xy".endswith(p))
for p in [b"x", bytearray(b"x"), memoryview(b"x"), (b"q", b"x"), (b"x", "s"), (b"q", "s"), (5,), (), [b"x"], "x", 5, None]:
    name = "memoryview" if isinstance(p, memoryview) else ascii(p)
    show("b'xy'.startswith(%s)" % name, lambda: b"xy".startswith(p))
    show("b'xy'.endswith(%s)" % name, lambda: b"xy".endswith(p))
    show("bytearray(b'xy').startswith(%s)" % name, lambda: bytearray(b"xy").startswith(p))
show("bytes start and end", lambda: (b"xy".startswith(b"y", 1), b"xyz".endswith((b"q", b"y"), 0, 2), b"xy".startswith(b"", 5)))
show("bytes start not an index", lambda: b"xy".startswith(b"x", "a"))


# slice indices, as _PyEval_SliceIndex: None, an int or anything with
# __index__ (an int subclass by its own value), clamped; else TypeError
class Ix:
    def __index__(self):
        return 1


class IxRaises:
    def __index__(self):
        raise TypeError("my own __index__")


class I(int):
    def __index__(self):
        return 0


seq = [10, 20, 30, 40]
for v in [None, 1, -1, True, 2**100, -(2**100), Ix(), I(2), "a", 1.5, 1.0, IxRaises(), [1]]:
    name = type(v).__name__ if isinstance(v, (Ix, I, IxRaises)) else ascii(v)
    show("list[%s:]" % name, lambda: seq[v:])
    show("list[:%s]" % name, lambda: seq[:v])
    show("list[::%s]" % name, lambda: seq[::v] if v != 0 else None)
    show("str[%s:]" % name, lambda: "abcd"[v:])
    show("'xyx'.find('x', %s)" % name, lambda: "xyx".find("x", v))
    show("'xyx'.count('x', None, %s)" % name, lambda: "xyx".count("x", None, v))
    show("'xyx'.index('x', %s)" % name, lambda: "xyx".index("x", v))
    show("'xyx'.startswith('y', %s)" % name, lambda: "xyx".startswith("y", v))
    show("b'xyx'.find(b'x', %s)" % name, lambda: b"xyx".find(b"x", v))
    show("b'xyx'.endswith(b'x', 0, %s)" % name, lambda: b"xyx".endswith(b"x", 0, v))
show("slice indices method", lambda: (slice(1, None, 2).indices(10), slice(-(2**100), 2**100).indices(5)))
show("slice indices method, a str", lambda: slice("a").indices(5))

for args, kw in [(("m",), {"name": "n", "path": "p"}), ((), {}), (("a", "b"), {}), ((5,), {}), ((), {"name": 1, "path": 2, "name_from": 3}),
                 (("m", "x"), {"path": "p"}), (("m",), {"foo": 1})]:
    def make():
        e = ImportError(*args, **kw)
        return repr(e), str(e), e.msg, e.name, e.path, e.name_from, e.args
    show("ImportError(%s, %s)" % (args, kw), make)
show("ModuleNotFoundError keywords", lambda: (lambda e: (repr(e), e.name, e.msg, str(e)))(ModuleNotFoundError("x", name="y")))
show("ModuleNotFoundError unknown keyword", lambda: ModuleNotFoundError(foo=1))


def reinit():
    e = ImportError("m", name="n")
    e.__init__("q")
    return e.name, e.msg, e.args


show("ImportError __init__ again", reinit)


def msg_changed():
    e = ImportError("m")
    e.msg = "changed"
    return str(e), e.args


show("ImportError msg changed", msg_changed)


class E(Exception):
    def __init__(self, *a, **k):
        self.k = k


class SubImport(ImportError):
    pass


show("Exception subclass with keywords", lambda: (E(1, z=2).k, E(1, z=2).args))
show("ImportError subclass", lambda: (repr(SubImport("q", name="w")), SubImport("q", name="w").name))
show("ValueError with a keyword", lambda: ValueError(x=1))
show("Exception with a keyword", lambda: Exception("a", y=2))
show("KeyError with a keyword", lambda: KeyError(1, k=3))
try:
    import no_such_module_for_cases
except ImportError as e:
    print("missing module:", type(e).__name__, ascii(e.name), ascii(e.msg), ascii(e.path))

sys.modules["blocked_cases_mod"] = None


def imp_stmt():
    import blocked_cases_mod
    return blocked_cases_mod


def from_imp():
    from blocked_cases_mod import x
    return x


def child_of_blocked():
    import blocked_cases_mod.child
    return 1


show("import statement, None in sys.modules", imp_stmt)
show("from-import, None in sys.modules", from_imp)
show("import a child of a blocked module", child_of_blocked)
show("__import__, None in sys.modules", lambda: __import__("blocked_cases_mod"))
try:
    import blocked_cases_mod
except ModuleNotFoundError as e:
    print("halted:", ascii(e.name), ascii(e.msg))
sys.modules["json.blocked_child"] = None
show("a blocked submodule of a real package", lambda: __import__("json.blocked_child"))


# astra's CORR-5E9-1: slice.indices and range slices are exact; a concrete
# container's slice clamps its step, as PySlice_Unpack does
for step in [2**54, -2**54, 2**100, -2**100, 2**63, -2**63 - 1]:
    show("slice(None, None, %d).indices(10)" % step, lambda: slice(None, None, step).indices(10))
    show("range(10)[::%d]" % step, lambda: (lambda r: (r, r[0], type(r.step).__name__, list(r), len(r)))(range(10)[::step]))
    show("list[::%d]" % step, lambda: [1, 2, 3][::step])
    show("str[::%d]" % step, lambda: "abc"[::step])
    show("bytes[::%d]" % step, lambda: b"abc"[::step])
show("slice indices, big bounds", lambda: slice(-(2**100), 2**100, -3).indices(7))
show("slice indices, big length", lambda: slice(None, None, 2).indices(2**80))
show("range(2**70)[::2**60]", lambda: (lambda r: (r, len(r), r[3]))(range(2**70)[::2**60]))
show("range(2**70)[2**69:]", lambda: range(2**70)[2**69:])
show("range(10)[1.5:]", lambda: range(10)[1.5:])
show("range big [1.5:]", lambda: range(2**70)[1.5:])
show("slice indices negative length", lambda: slice(1).indices(-1))


# astra's CORR-5E9-2: start and end converted once, before the prefix is
# looked at, whatever the tuple holds
class Moving:
    def __init__(self):
        self.n = -1

    def __index__(self):
        self.n += 1
        return self.n


class Counting:
    def __init__(self, v):
        self.v, self.calls = v, 0

    def __index__(self):
        self.calls += 1
        return self.v


for subj, alts, empty, bad in [("xy", ("q", "x"), (), 5), (b"xy", (b"q", b"x"), (), 5), (bytearray(b"xy"), (b"q", b"x"), (), 5)]:
    kind = type(subj).__name__
    show("%s.startswith(alts, Moving())" % kind, lambda: subj.startswith(alts, Moving()))
    show("%s.endswith(alts, None, Moving())" % kind, lambda: subj.endswith(alts[::-1], None, Moving()))
    show("%s.startswith((), 1.5)" % kind, lambda: subj.startswith(empty, 1.5))
    show("%s.endswith((), None, 'a')" % kind, lambda: subj.endswith(empty, None, "a"))
    show("%s.startswith(5, 1.5)" % kind, lambda: subj.startswith(bad, 1.5))

    def counted():
        a, b = Counting(0), Counting(1)
        r = subj.startswith((alts[0], alts[0]), a, b)
        return r, a.calls, b.calls

    show("%s conversions per call" % kind, counted)


# astra's CORR-5E9-3: a callable replacement is called, a str subclass
# included; a replacement of the other kind fails only when joined
class Repl(str):
    def __call__(self, m):
        calls.append(m.group())
        return "CALL"


class ReplB(str):
    def __call__(self, m):
        calls.append(m.group())
        return b"CB"


class SS(str):
    pass


for pat, subj in [("a", "aba"), ("q", "aba"), ("b", "abc"), (b"a", b"aba"), (b"q", b"aba"), (b"b", b"abc")]:
    for name, repl in [("Repl", Repl("T")), ("ReplB", ReplB("T")), ("SS", SS("X")), ("str", "X"), ("bytes", b"X"),
                       ("bytearray", bytearray(b"X")), ("memoryview", memoryview(b"X")), ("int", 5), ("None", None),
                       ("lambda None", lambda m: None), ("lambda int", lambda m: 5), ("template", SS(r"<\g<0>>"))]:
        calls = []
        show("re.sub(%r, %s, %r)" % (pat, name, subj), lambda: (re.sub(pat, repl, subj), calls))
        calls = []
        show("re.subn(%r, %s, %r)" % (pat, name, subj), lambda: (re.compile(pat).subn(repl, subj), calls))


# astra's CORR-5E9-4: a failed __init__ sets args and keeps the rest
def reinit_bad():
    e = ImportError("old", name="n", path="p", name_from="f")
    try:
        e.__init__("new", bad=1)
    except TypeError as x:
        print("reinit refused:", x)
    return e.args, e.msg, e.name, e.path, e.name_from


show("ImportError __init__ with a bad keyword", reinit_bad)


def reinit_good():
    e = ImportError("old", name="n", path="p", name_from="f")
    e.__init__("new", path="q")
    return e.args, e.msg, e.name, e.path, e.name_from


show("ImportError __init__ again with keywords", reinit_good)


# a template of the other kind: parsed all the same; its first matched group
# refused by its place among its pieces, an unmatched one passed over
for pat, subj, repl in [(b"(x)?a", b"aba", r"<\1>"), (b"(x)?a", b"aba", r"\1"), (b"(a)", b"aba", r"\1\1"), (b"(a)", b"aba", r"<<\g<1>"),
                        ("(x)?a", "aba", rb"<\1>"), ("(a)", "aba", rb"[\1]"), ("(a)", "aba", rb"\n\1"), ("(a)", "qqq", rb"\1"),
                        ("(x)?(a)", "a", rb"\1\2"), ("(x)?(a)", "a", rb"\1x\2"), ("(x)?(a)", "a", rb"\2\1\2"), ("(x)?(y)?(a)", "a", rb"\1\2\3"),
                        ("(a)", "a", rb"\1\1\1"), ("(a)", "a", rb"ab\1cd\1")]:
    show("re.sub(%r, %r, %r)" % (pat, repl, subj), lambda: re.sub(pat, repl, subj))
