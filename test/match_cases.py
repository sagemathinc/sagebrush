# The match statement (PEP 634): every pattern kind, binding and guard
# rules, the runtime errors and the compile-time SyntaxErrors, compared with
# CPython 3.14 by test/match.test.ts
import collections
import collections.abc


def show(f):
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e)


# literals and singletons
def lit(v):
    match v:
        case None: return "None"
        case True: return "True"
        case False: return "False"
        case 0: return "zero"
        case -1: return "minus one"
        case 1.5: return "one and a half"
        case 1 + 2j: return "complex"
        case -2 - 1j: return "neg complex"
        case "s": return "str s"
        case b"b": return "bytes b"
        case "a" "b": return "concatenated"
        case _: return "other"


for v in [None, True, False, 0, 0.0, -1, 1.5, 1 + 2j, -2 - 1j, "s", b"b", "ab", 1, 2, [], "", b"s"]:
    print(repr(v), lit(v))


# value patterns: dotted names, looked up when the match reaches them
class Color:
    RED = "red"
    GREEN = "green"


class NS:
    inner = Color


log = []


class Eq:
    def __init__(self, name):
        self.name = name

    def __eq__(self, other):
        log.append(("eq", self.name, other))
        return other == "green"


def value(v):
    match v:
        case Color.RED: return "red"
        case NS.inner.GREEN: return "green"
        case _: return "other"


for v in ["red", "green", "blue", Eq("e")]:
    print(value(v))
print(log)


# captures, wildcards, as and or patterns
def caps(v):
    match v:
        case (1 | 2 | 3) as small: return ("small", small)
        case [x, _, _] | (x, _): return ("first", x)
        case {"a": (1 | 2) as a} | {"b": a}: return ("a or b", a)
        case str(s) | bytes(s): return ("text", s)
        case _: return "none"


for v in [1, 3, [9, 8, 7], (6, 5), {"a": 2}, {"b": "x"}, {"a": 5}, "t", b"u", 4.0]:
    print(caps(v))


# sequences: list, tuple, range, deque, a Sequence subclass, a registered
# one; not str, bytes, bytearray, iterators, sets or dicts
class MySeq(collections.abc.Sequence):
    def __init__(self, *items):
        self.items = items

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


class Registered:
    def __init__(self, *items):
        self.items = list(items)

    def __len__(self):
        return len(self.items)

    def __iter__(self):
        return iter(self.items)

    def __getitem__(self, i):
        return self.items[i]


collections.abc.Sequence.register(Registered)


def seq(v):
    match v:
        case []: return "empty"
        case [x]: return ("one", x)
        case [x, y]: return ("two", x, y)
        case [first, *middle, last]: return ("many", first, middle, last)
        case _: return "not a sequence"


for v in [[], [1], (1, 2), range(3), collections.deque([4, 5, 6, 7]), MySeq(8, 9), Registered(1, 2, 3), "ab", b"ab", bytearray(b"ab"),
          iter([1, 2]), {1, 2}, {1: 2}, memoryview(b"xyz"), (x for x in [1])]:
    print(type(v).__name__, seq(v))


def stars(v):
    match v:
        case [*_, "end"]: return "ends"
        case ["start", *rest]: return ("starts", rest)
        case [*all_]: return ("all", all_)


for v in [["a", "end"], ["start", 1, 2], ["start"], [1, 2], []]:
    print(stars(v))


# mappings: dict, a dict subclass, a Mapping, OrderedDict, defaultdict;
# extra keys allowed, get() looked up once and called with a default
class MyMap(collections.abc.Mapping):
    def __init__(self, d):
        self.d = d
        self.calls = []

    def __getitem__(self, k):
        return self.d[k]

    def __len__(self):
        return len(self.d)

    def __iter__(self):
        return iter(self.d)

    def get(self, k, default=None):
        self.calls.append(k)
        return self.d.get(k, default)


def mapping(v):
    match v:
        case {}: return ("any mapping", len(v))


def keys(v):
    match v:
        case {"x": 0, "y": y, **rest}: return ("xy", y, rest)
        case {"x": x}: return ("x", x)
        case {Color.RED: r}: return ("red key", r)
        case {1: one}: return ("int key", one)
        case _: return "no"


m = MyMap({"x": 0, "y": 5, "z": 6})
for v in [{"x": 0, "y": 1}, {"x": 0, "y": 1, "z": 2}, {"x": 3}, {"red": 4}, {1.0: "float key"}, {True: "true key"}, m,
          collections.OrderedDict(x=7), collections.defaultdict(int, x=8), [("x", 1)], "x"]:
    print(type(v).__name__, keys(v))
print(m.calls)
print(mapping({}), mapping({1: 2}), mapping(MyMap({})))
show(lambda: mapping([]))


# duplicate keys found when the keys are evaluated
class K:
    a = "z"
    b = "z"


def dupkeys(v):
    match v:
        case {K.a: 1, K.b: 2}: return "both"
        case _: return "no"


show(lambda: dupkeys({"z": 1, "w": 2}))
show(lambda: dupkeys({"z": 1}))


# classes: __match_args__, keywords, the builtins that match themselves
# (and their subclasses), ABCs, attributes missing or raising
class Point:
    __match_args__ = ("x", "y")

    def __init__(self, x, y):
        self.x, self.y = x, y


class Point3(Point):
    __match_args__ = ("x", "y", "z")

    def __init__(self, x, y, z):
        super().__init__(x, y)
        self.z = z


class MyInt(int):
    pass


class Prop:
    @property
    def missing(self):
        raise AttributeError("no")

    @property
    def broken(self):
        raise ValueError("broken")


def cls(v):
    match v:
        case Point3(0, 0, 0): return "origin 3"
        case Point(0, 0): return "origin"
        case Point(x=0, y=y): return ("on y axis", y)
        case Point(x, y=0): return ("on x axis", x)
        case Point(x, y): return ("point", x, y)
        case bool(b): return ("bool", b)
        case MyInt(n): return ("myint", n)
        case int(n): return ("int", n)
        case float(f) | str(f): return ("float or str", f)
        case list([*items]): return ("list", items)
        case dict(d): return ("dict", d)
        case collections.abc.Sized(): return ("sized", len(v))
        case Prop(missing=_): return "has missing"
        case _: return "other"


for v in [Point(0, 0), Point3(0, 0, 0), Point3(1, 0, 2), Point(0, 5), Point(3, 0), Point(1, 2), True, MyInt(4), 7, 2.5, "s", [1, 2], {1: 2}, {1, 2}, Prop(), None]:
    print(cls(v))


class NoArgs:
    pass


class ListArgs:
    __match_args__ = ["x"]


class IntArgs:
    __match_args__ = (1,)


class StrSubArgs:
    class S(str):
        pass
    __match_args__ = (S("x"),)
    x = "sub"


def errors(v, which):
    if which == 0:
        match v:
            case NoArgs(1): pass
    if which == 1:
        match v:
            case ListArgs(1): pass
    if which == 2:
        match v:
            case IntArgs(1): pass
    if which == 3:
        match v:
            case Point(1, 2, 3): pass
    if which == 4:
        match v:
            case int(1, 2): pass
    if which == 5:
        match v:
            case Point(1, x=1): pass
    if which == 6:
        f = len
        match v:
            case f(): pass
    if which == 7:
        match v:
            case Prop(broken=_): pass
    if which == 8:
        match v:
            case StrSubArgs(s): return s
    return "matched none"


for which, v in [(0, NoArgs()), (1, ListArgs()), (2, IntArgs()), (3, Point(1, 2)), (4, 1), (5, Point(1, 2)), (6, 1), (7, Prop()), (8, StrSubArgs()), (0, 5)]:
    show(lambda: errors(v, which))


# bindings: made only when the whole pattern matched; kept when a guard
# fails; or-patterns bind the same names
def bindings():
    out = []
    match (5, 2):
        case (a, 1): pass
        case _: pass
    try:
        a
        out.append("a bound")
    except NameError:
        out.append("a unbound")
    match (5, 2):
        case (b, c) if c == 9: pass
        case _: pass
    out.append(("guard failed", b, c))
    match [1, 2]:
        case [d, 2] | (d, 3): out.append(("or", d))
    return out


print(bindings())


# guards: evaluated after the bindings, in order; a falsy guard goes on
def guards(v):
    calls = []

    def g(name, r):
        calls.append(name)
        return r

    match v:
        case [x] if g("first", x > 5): r = "big"
        case [x] if g("second", x > 2): r = "medium"
        case [x]: r = "small"
        case _: r = "none"
    return r, calls


for v in [[7], [3], [1], []]:
    print(guards(v))


# subject evaluated once; __eq__ of the subject's type first
class Subject:
    def __init__(self):
        self.n = 0

    def __eq__(self, other):
        self.n += 1
        return other == 2


def once():
    calls = []

    def subj():
        calls.append(1)
        return 3

    match subj():
        case 1: pass
        case 2: pass
        case _: pass
    s = Subject()
    match s:
        case 1: r = "one"
        case 2: r = "two"
    return calls, s.n, r


print(once())


# in a class body, at module level, in generators and closures; mangled names
class InClass:
    match [1, 2]:
        case [__first, *_]: pass

    def get(self):
        return self._InClass__first


print(InClass().get(), [n for n in vars(InClass) if not n.startswith("__")])
match {"k": [1, (2, 3)]}:
    case {"k": [one, (two, three)]}: print("module level", one, two, three)
print(sorted(n for n in globals() if n in ("one", "two", "three")), [n for n in globals() if n.startswith("$")])


def gen(items):
    for it in items:
        match it:
            case int(n): yield n * 2
            case str(s): yield s.upper()


print(list(gen([1, "a", 2.0, 3])))


def closure(v):
    match v:
        case [x, y]: pass

    def inner():
        return x + y
    return inner()


print(closure([3, 4]))
match = "match is still a name"
case = [match]
print(match, case)


# compile-time SyntaxErrors, as CPython's compiler and grammar give them
for src in [
    "match x:\n case y: pass\n case 1: pass",
    "match x:\n case _: pass\n case 1: pass",
    "match x:\n case [a, a]: pass",
    "match x:\n case [a] | [b]: pass",
    "match x:\n case {'a': 1, 'a': 2}: pass",
    "match x:\n case {1: 1, 1.0: 2}: pass",
    "match x:\n case {1: 1, True: 2}: pass",
    "match x:\n case A(a=1, a=2): pass",
    "match x:\n case y | 1: pass",
    "match x:\n case (y as z) | 1: pass",
    "match x:\n case 1 | y: pass\n case 2: pass",
    "match x:\n case {1+2: 3}: pass",
    "match x:\n case f(): pass",
    "match x:\n case [*a, *b]: pass",
    "match x:\n case _ if x: pass\n case 1: pass",
    "match x:\n case {**_}: pass",
    "match x:\n case a.b(): pass\n case y: pass\n case z: pass",
    "match x:\n case [a, *a]: pass",
    "match x:\n case {'k': a, **a}: pass",
    "match x:\n case Point(a, y=a): pass",
    "match x:\n case (a as a): pass",
    "match x:\n case 1 as _: pass",
    "match x:\n case A(1, x=2, 3): pass",
    "match x:\n case -x: pass",
    "match x:\n case [x] | x: pass",
    "match x:\n case (x | y) as z: pass",
    "match x:\n case 1:\n  pass\n case [_, _] | (_ as w): pass\n case 3: pass",
    "match x:\n case f'{x}': pass",
]:
    try:
        compile(src, "<s>", "exec")
        print("ok")
    except SyntaxError as e:
        print("SyntaxError", e.msg, e.lineno, e.offset)
for src in ["match x:\n case {f'{x}': 1}: pass", "match x:\n case {'a': 1, **r}: pass", "class C:\n match 1:\n  case __p: pass"]:
    try:
        compile(src, "<s>", "exec")
        print("ok")
    except SyntaxError as e:
        print("SyntaxError", e.msg, e.lineno, e.offset)


# the front end's operations are no names: user locals with the builtins'
# names async for and async with once called don't change them
class ACM:
    async def __aenter__(self):
        return "entered"

    async def __aexit__(self, t, v, tb):
        print("exit", t.__name__ if t else None)
        return True


class AIt:
    def __init__(self):
        self.n = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.n += 1
        if self.n > 2:
            raise StopAsyncIteration
        return self.n


async def hygiene():
    type = BaseException = StopAsyncIteration = None
    out = []
    async with ACM() as e:
        out.append(e)
        raise KeyError("suppressed")
    async for v in AIt():
        out.append(v)
    return out


coro = hygiene()
try:
    coro.send(None)
except StopIteration as e:
    print(e.value)
import array
print(seq(array.array("i", [1, 2])), seq(array.array("b")), keys(collections.ChainMap({"x": 0, "y": 9})))
