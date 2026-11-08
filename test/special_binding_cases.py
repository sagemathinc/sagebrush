# Special methods that are not descriptors (the .out is CPython 3.14.10's): a
# class attribute found by an implicit special-method call (next(), for, len(),
# x[i], x(), repr(), +, with, ...) is bound to the instance only when its type
# is a descriptor (a Python function, a builtin type's method). A bound method,
# a builtin function or a type stored as a dunder is called without self.

def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


class Rec:
    """A bound method that records how many arguments each call received."""

    def __init__(self, ret):
        self.ret = ret
        self.calls = []

    def m(self, *a):
        self.calls.append(len(a))
        return self.ret(*a) if callable(self.ret) else self.ret


class Ctx:
    pass


# (name, the value the dunder returns, how the instance is used)
OPS = [
    ("__len__", 3, lambda o: len(o)),
    ("__bool__", False, lambda o: bool(o)),
    ("__hash__", 7, lambda o: hash(o)),
    ("__repr__", "r!", lambda o: repr(o)),
    ("__str__", "s!", lambda o: str(o)),
    ("__format__", "f!", lambda o: format(o, "x")),
    ("__int__", 4, lambda o: int(o)),
    ("__float__", 1.5, lambda o: float(o)),
    ("__index__", 2, lambda o: [10, 20, 30][o]),
    ("__complex__", 1j, lambda o: complex(o)),
    ("__neg__", "neg", lambda o: -o),
    ("__pos__", "pos", lambda o: +o),
    ("__abs__", "abs", lambda o: abs(o)),
    ("__invert__", "inv", lambda o: ~o),
    ("__round__", "rnd", lambda o: round(o)),
    ("__add__", "add", lambda o: o + 1),
    ("__radd__", "radd", lambda o: 1 + o),
    ("__iadd__", "iadd", lambda o: _iadd(o)),
    ("__mul__", "mul", lambda o: o * 2),
    ("__eq__", "eq", lambda o: o == 5),
    ("__lt__", "lt", lambda o: o < 5),
    ("__contains__", True, lambda o: 1 in o),
    ("__getitem__", "gi", lambda o: o[0]),
    ("__setitem__", None, lambda o: _setitem(o)),
    ("__delitem__", None, lambda o: _delitem(o)),
    ("__iter__", None, lambda o: list(o)),
    ("__next__", None, lambda o: next(o)),
    ("__call__", "called", lambda o: o(1, 2)),
    ("__getattr__", "ga", lambda o: o.missing),
    ("__length_hint__", 5, lambda o: list(o)),
    ("__reversed__", None, lambda o: list(reversed(o))),
    ("__enter__", "entered", lambda o: _with(o)),
    ("__fspath__", "/p", lambda o: __import__("os").fspath(o)),
]


def _iadd(o):
    o += 1
    return o


def _setitem(o):
    o[0] = 1
    return "set"


def _delitem(o):
    del o[0]
    return "deleted"


def _with(o):
    with o as v:
        return v


def ret_for(name, value):
    if name == "__iter__":
        return lambda *a: iter([1, 2])
    if name == "__next__":
        return lambda *a: 9
    if name == "__reversed__":
        return lambda *a: iter([2, 1])
    return value


print("-- a recorder's bound method as each dunder (CPython: called without self)")
for name, value, use in OPS:
    rec = Rec(ret_for(name, value))
    ns = {name: rec.m}
    if name == "__enter__":
        ns["__exit__"] = Rec(None).m
    if name == "__length_hint__":
        ns["__iter__"] = lambda self: iter([1, 2])
    C = type("C", (), ns)
    print(name, t(lambda: use(C())), rec.calls)

print("-- a plain function as each dunder (the control: called with self)")
for name, value, use in OPS:
    seen = []
    r = ret_for(name, value)

    def f(self, *a, _r=r, _seen=seen):
        _seen.append((type(self).__name__, len(a)))
        return _r(*a) if callable(_r) else _r

    ns = {name: f}
    if name == "__enter__":
        ns["__exit__"] = lambda self, *a: None
    if name == "__length_hint__":
        ns["__iter__"] = lambda self: iter([1, 2])
    C = type("C", (), ns)
    print(name, t(lambda: use(C())), seen)


def gen():
    yield 1
    yield 2


print("-- the seven shapes")
g = gen()
It = type("It", (), {"__next__": g.__next__, "__iter__": lambda self: self})
print("gen.__next__ as __next__", t(lambda: next(It())), t(lambda: list(It())))
L = type("L", (), {"__len__": [1, 2, 3].__len__})
print("[].__len__ as __len__", t(lambda: len(L())))


class Obj:
    def m(self, *a):
        return ("m", a)


B = type("B", (), {"__len__": Obj().m})
print("bound Python method as __len__", t(lambda: len(B())))
B2 = type("B2", (), {"__call__": Obj().m})
print("bound Python method as __call__", t(lambda: B2()(1)))
G = type("G", (), {"__getitem__": {0: "x", 1: "y"}.__getitem__})
print("dict.__getitem__ bound as __getitem__", t(lambda: G()[1]), t(lambda: list(G())))
R = type("R", (), {"__repr__": "fixed".__str__})
print("str.__str__ bound as __repr__", t(lambda: repr(R())), t(lambda: str(R())), t(lambda: f"{R()!r}"))
H = type("H", (), {"__call__": len})
print("len as __call__", t(lambda: H()([1, 2, 3])), t(lambda: H()()))
S = type("S", (), {"__contains__": {1, 2}.__contains__})
print("set.__contains__ bound as __contains__", t(lambda: 1 in S()), t(lambda: 3 in S()))

print("-- a type as a dunder (not a descriptor: called without self)")
T1 = type("T1", (), {"__call__": list})
print("list as __call__", t(lambda: T1()("ab")))
T2 = type("T2", (), {"__iter__": list})
print("list as __iter__", t(lambda: iter(T2())))
T3 = type("T3", (), {"__repr__": str})
print("str as __repr__", t(lambda: repr(T3())))
T4 = type("T4", (), {"__len__": int})
print("int as __len__", t(lambda: len(T4())))

print("-- iterparse's shape: a class body holding gen.__next__, an Iterator subclass")
import collections.abc


def iterparse_like():
    g = gen()

    class IterParseIterator(collections.abc.Iterator):
        __next__ = g.__next__

    return IterParseIterator()


it = iterparse_like()
print(t(lambda: next(it)), t(lambda: list(it)), t(lambda: next(it)))

print("-- set and replaced after the class is made (the per-class cache)")
D = type("D", (), {})
d = D()
D.__len__ = [1].__len__
print(t(lambda: len(d)))
D.__len__ = lambda self: 4
print(t(lambda: len(d)))
D.__len__ = [1, 2, 3, 4, 5].__len__
print(t(lambda: len(d)))
del D.__len__
print(t(lambda: len(d)))

print("-- inherited by a subclass")
P = type("P", (), {"__len__": [1, 2].__len__, "__getitem__": "abc".__getitem__})
Q = type("Q", (P,), {})
print(t(lambda: len(Q())), t(lambda: Q()[2]))

print("-- a metaclass's dunder as a bound method (called on the class)")
M = type("M", (type,), {"__len__": [1, 2, 3, 4, 5, 6].__len__, "__getitem__": {"k": "v"}.__getitem__})
K = M("K", (), {})
print(t(lambda: len(K)), t(lambda: K["k"]))

print("-- staticmethod and classmethod stay descriptors")
SM = type("SM", (), {"__len__": staticmethod(lambda: 11), "__getitem__": classmethod(lambda cls, k: (cls.__name__, k))})
print(t(lambda: len(SM())), t(lambda: SM()[3]))

print("-- more call sites, each dunder a recorder's bound method")
import math


def _with2(C):
    with C():
        raise ValueError("swallowed")
    return "after"


def _set(o):
    o.x = 1
    return "set"


def _del(o):
    del o.x
    return "deleted"


def _assign(o):
    o.a = 5
    return "assigned"


def _delete(o):
    del o.a
    return "deleted"


def more(name, value, use, extra=None, base=()):
    rec = Rec(value)
    ns = {name: rec.m}
    if extra:
        ns.update(extra)
    C = type("C", base, ns)
    print(name, t(lambda: use(C)), rec.calls)


more("__bytes__", b"b", lambda C: bytes(C()))
more("__trunc__", 3, lambda C: math.trunc(C()))
more("__floor__", 3, lambda C: math.floor(C()))
more("__ceil__", 3, lambda C: math.ceil(C()))
more("__divmod__", (1, 2), lambda C: divmod(C(), 3))
more("__pow__", "pow", lambda C: C() ** 2)
more("__rpow__", "rpow", lambda C: 2 ** C())
more("__matmul__", "mm", lambda C: C() @ 1)
more("__truediv__", "td", lambda C: C() / 1)
more("__and__", "and", lambda C: C() & 1)
more("__lshift__", "ls", lambda C: C() << 1)
more("__ne__", "ne", lambda C: C() != 1)
more("__ge__", "ge", lambda C: C() >= 1)
more("__missing__", "miss", lambda C: C()["k"], base=(dict,))
more("__dir__", ["b", "a"], lambda C: dir(C()))
more("__index__", 2, lambda C: range(C()))
more("__index__", 2, lambda C: hex(C()))
more("__bool__", False, lambda C: "yes" if C() else "no")
more("__len__", 0, lambda C: "yes" if C() else "no")
more("__iter__", lambda *a: iter("xy"), lambda C: [*C()])
more("__iter__", lambda *a: iter("xy"), lambda C: (lambda a, b: a + b)(*C()))
more("__contains__", False, lambda C: 1 not in C())
more("__getitem__", lambda *a: "xyz"[a[-1]] if a[-1] < 3 else (_ for _ in ()).throw(IndexError), lambda C: list(C()))
more("__exit__", True, lambda C: _with2(C), extra={"__enter__": lambda self: self})
more("__init__", None, lambda C: type(C()).__name__)
more("__getattribute__", "gab", lambda C: C().anything)
more("__setattr__", None, lambda C: _set(C()))
more("__delattr__", None, lambda C: _del(C()))
more("__set_name__", None, lambda C: type("Owner", (), {"x": C()}).__name__)


print("-- the descriptor protocol's own dunders as bound methods")
for dname, use in [
    ("__get__", lambda D: type("O", (), {"a": D()})().a),
    ("__set__", lambda D: _assign(type("O", (), {"a": D()})())),
    ("__delete__", lambda D: _delete(type("O", (), {"a": D()})())),
]:
    rec = Rec("got")
    ns = {dname: rec.m}
    if dname != "__get__":
        ns["__get__"] = lambda self, o, t=None: "g"
    D = type("D", (), ns)
    print(dname, t(lambda: use(D)), rec.calls)


print("-- a metaclass's checks as bound methods")
recI = Rec(True)
MI = type("MI", (type,), {"__instancecheck__": recI.m, "__subclasscheck__": recI.m})
KI = MI("KI", (), {})
print(t(lambda: isinstance(1, KI)), t(lambda: issubclass(int, KI)), recI.calls)
recC = Rec(lambda *a: "made")
MC = type("MC", (type,), {"__call__": recC.m})
KC = MC("KC", (), {})
print(t(lambda: KC(1, 2)), recC.calls)

print("-- async dunders as bound methods")


class _Awaitable:
    def __await__(self):
        return iter(())


def _arun(co):
    # (the coroutine driven by hand: nothing here suspends)
    try:
        while True:
            co.send(None)
    except StopIteration as e:
        return e.value
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


recA = Rec(lambda *a: _Awaitable().__await__())
AW = type("AW", (), {"__await__": recA.m})


async def _await():
    return await AW()


print(repr(_arun(_await())), recA.calls)
recE = Rec(lambda *a: _Done())


class _Done:
    def __await__(self):
        if False:
            yield
        return "entered"


AC = type("AC", (), {"__aenter__": recE.m, "__aexit__": Rec(lambda *a: _Done()).m})


async def _awith():
    async with AC() as v:
        return v


print(repr(_arun(_awith())), recE.calls)
recI2 = Rec(lambda *a: AI2())


class _Stop:
    def __await__(self):
        if False:
            yield
        raise StopAsyncIteration


AI2 = type("AI2", (), {"__aiter__": recI2.m, "__anext__": lambda self: _Stop()})


async def _afor():
    out = []
    async for x in AI2():
        out.append(x)
    return out


print(repr(_arun(_afor())), recI2.calls)

print("-- keywords through a bound method as __init__ and __call__")


class RK:
    def __init__(self, ret=None):
        self.ret = ret
        self.calls = []

    def m(self, *a, **k):
        self.calls.append((a, sorted(k.items())))
        return self.ret


rk = RK()
KI = type("KI", (), {"__init__": rk.m})
print(t(lambda: type(KI(1, x=2)).__name__), rk.calls)
rk2 = RK("c")
KC2 = type("KC2", (), {"__call__": rk2.m})
print(t(lambda: KC2()(1, y=3)), t(lambda: KC2()(**{"z": 4})), rk2.calls)
rk3 = RK("made")
MK = type("MK", (type,), {"__call__": rk3.m})
KK = MK("KK", (), {})
print(t(lambda: KK(5, w=6)), rk3.calls)
rk4 = RK("ok")
KF = type("KF", (), {"__format__": rk4.m})
print(t(lambda: f"{KF():>3}"), rk4.calls)
