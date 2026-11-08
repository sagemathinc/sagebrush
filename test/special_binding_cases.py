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

print("-- hash() and dict keys through the per-class lookup (None, object's, a metaclass's, builtins)")


class HN:
    __hash__ = None


class HO:
    pass


class HM(type):
    def __hash__(cls):
        return 12


class HC(metaclass=HM):
    pass


class HD(dict):
    pass


class HI(int):
    pass


import builtins


class HB:
    __hash__ = builtins.hash  # a builtin function: called without self


hr = Rec(9)
HRB = type("HRB", (), {"__hash__": hr.m})
print(t(lambda: hash(HN())), t(lambda: {HN(): 1}))
ho = HO()
print(t(lambda: hash(ho) == hash(ho) == object.__hash__(ho)), t(lambda: len({HO(): 1, HO(): 2})))
print(t(lambda: hash(HC)), t(lambda: {HC: 1}[HC]))
print(t(lambda: hash(HD())), t(lambda: hash(HI(5))), t(lambda: {HI(5): 1}[5]))
print(t(lambda: hash(HB())), t(lambda: {HB(): 1}))
print(t(lambda: hash(HRB())), t(lambda: len({HRB(): 1})), hr.calls)
HN.__hash__ = lambda self: 3
print("after HN.__hash__ is set:", t(lambda: hash(HN())))
del HN.__hash__
hn = HN()
print("after it is deleted:", t(lambda: hash(hn) == object.__hash__(hn)))

print("-- __call__ = None and a later __call__")


class CN:
    __call__ = None


print(t(lambda: CN()()))
CN.__call__ = len
print(t(lambda: CN()([1, 2])))

print("-- r2: %-format, int's float format, %(key) mappings, reversed() and __reduce_ex__, each a bound method")
rf = Rec(2.5)
PF = type("PF", (), {"__float__": rf.m})
print(t(lambda: "%f|%e|%g" % (PF(), PF(), PF())), rf.calls)
ri = Rec(7)
PI = type("PI", (), {"__index__": ri.m})
print(t(lambda: "%f %d %x %o %c" % (PI(), PI(), PI(), PI(), PI())), ri.calls)
rn = Rec(9)
PN = type("PN", (), {"__int__": rn.m})
print(t(lambda: "%d" % PN()), t(lambda: "%f" % PN()), rn.calls)
rfi = Rec(1.25)
IF = type("IF", (int,), {"__float__": rfi.m})
print(t(lambda: format(IF(2), "f")), t(lambda: format(IF(2), ".1%")), t(lambda: format(IF(2), "d")), rfi.calls)
MG = type("MG", (), {"__getitem__": {"x": "ok", "y": 2}.__getitem__})
print(t(lambda: "%(x)s %(y)d" % MG()), t(lambda: "%(z)s" % MG()))
rm = Rec("v")
MR = type("MR", (), {"__getitem__": rm.m})
print(t(lambda: "%(a)s-%(b)s" % MR()), rm.calls)
rg = Rec(lambda i: "abc"[i])
RV = type("RV", (), {"__getitem__": rg.m, "__len__": [1, 2, 3].__len__})
print(t(lambda: list(reversed(RV()))), rg.calls)
rgn = Rec((1, 2))
GN = type("GN", (), {"__getnewargs__": rgn.m})
print(t(lambda: GN().__reduce_ex__(2)[1][1:]), rgn.calls)
rgx = Rec(((3,), {}))
GX = type("GX", (), {"__getnewargs_ex__": rgx.m})
print(t(lambda: GX().__reduce_ex__(2)[1][1:]), rgx.calls)
rgk = Rec(((3,), {"k": 4}))
GK = type("GK", (), {"__getnewargs_ex__": rgk.m})
print(t(lambda: GK().__reduce_ex__(2)[1][1:]), rgk.calls)
rs = Rec({"s": 1})
GS = type("GS", (), {"__getstate__": rs.m})
print(t(lambda: GS().__reduce_ex__(2)[2]), t(lambda: GS().__reduce_ex__(4)[2]), rs.calls)
import copy, pickle


class GA:
    def __init__(self, *a):
        self.a = a


rga = Rec((1, 2))
GA.__getnewargs__ = rga.m
GA.__module__ = "__main__"
print(t(lambda: copy.copy(GA()).a), t(lambda: copy.copy(GS()).__dict__), t(lambda: pickle.loads(pickle.dumps(GA())).a), rga.calls)

print("-- r2 (grader's gaps): each path with a bound method as its special method")
# isinstance()/issubclass() with an instance (not a type) as the class: its type's checks
ric = Rec(True)
rsc = Rec(False)
ICK = type("ICK", (), {"__instancecheck__": ric.m, "__subclasscheck__": rsc.m})
print(t(lambda: isinstance(1, ICK())), t(lambda: issubclass(int, ICK())), ric.calls, rsc.calls)
# repr() of a class whose metaclass's __repr__ is a bound method
rmr = Rec("<MR>")
MRM = type("MRM", (type,), {"__repr__": rmr.m})
CMR = MRM("CMR", (), {})
print(t(lambda: repr(CMR)), t(lambda: str(CMR)), rmr.calls)
# str() inside print, %s and !s
rst = Rec("S!")
ST = type("ST", (), {"__str__": rst.m})
print(ST(), t(lambda: "%s" % ST()), t(lambda: f"{ST()!s}"), t(lambda: "{}".format(ST())), rst.calls)
# b"%b" with __bytes__
rby = Rec(b"by")
BY = type("BY", (), {"__bytes__": rby.m})
print(t(lambda: b"[%b]" % BY()), t(lambda: bytes(BY())), rby.calls)
# a class attribute set and deleted through the metaclass's data descriptor
rds = Rec(None)
rdd = Rec(None)
DD = type("DD", (), {"__get__": lambda self, o, t=None: "dd", "__set__": rds.m, "__delete__": rdd.m})
MD = type("MD", (type,), {"x": DD()})
CD = MD("CD", (), {})


def _cd_set():
    CD.x = 5
    return CD.x


def _cd_del():
    del CD.x
    return CD.x


print(t(_cd_set), t(_cd_del), rds.calls, rdd.calls)
# __new__ returning an instance of a subclass whose __init__ is a bound method
rsi = Rec(None)


class NA:
    def __new__(cls, *a):
        return object.__new__(NB)


NB = type("NB", (NA,), {"__init__": rsi.m})
print(t(lambda: type(NA(1, 2)).__name__), t(lambda: type(NA(3)).__name__), rsi.calls)
# __getattr__ after a property raises AttributeError
rga2 = Rec("from getattr")


def _no(self):
    raise AttributeError("p")


PG = type("PG", (), {"p": property(_no), "__getattr__": rga2.m})
print(t(lambda: PG().p), t(lambda: PG().q), rga2.calls)
# a metaclass's __getattr__ for a missing class attribute
rmg = Rec("meta getattr")
MGA = type("MGA", (type,), {"__getattr__": rmg.m})
CGA = MGA("CGA", (), {})
print(t(lambda: CGA.missing), t(lambda: getattr(CGA, "other", "dflt")), rmg.calls)
# __length_hint__, asked by list() and bytearray() of an iterator (ops.lengthHint)
rlh = Rec(4)


class LHIt:
    def __init__(self):
        self.n = 0

    def __iter__(self):
        return self

    def __next__(self):
        self.n += 1
        if self.n > 2:
            raise StopIteration
        return self.n


LH = type("LH", (LHIt,), {"__length_hint__": rlh.m})
print(t(lambda: list(LH())), t(lambda: bytearray(LH())), rlh.calls)
# the 3-argument type call through a metaclass whose __init__ is a bound method
rmi = Rec(None)
MI = type("MI", (type,), {"__init__": rmi.m})
print(t(lambda: type(MI("CMI", (), {})).__name__), t(lambda: MI("CMJ", (), {}, kw=1)), rmi.calls)

print("-- r2: a class as a special method, its metaclass's __get__ binding it (lookup_maybe_method)")


class MGT(type):
    def __get__(cls, obj, owner=None):
        return lambda *a: ("got", type(obj).__name__, len(a))


class GT(metaclass=MGT):
    pass


CG = type("CG", (), {"__call__": GT, "__getitem__": GT})
print(t(lambda: CG()(1, 2)), t(lambda: CG()[0]))

print("-- r2: a bound method as __init__ and __call__, called with 3000 arguments (past the spread limit)")
rbi = Rec(None)
BI = type("BI", (), {"__init__": rbi.m})
rbc = Rec(5)
BC = type("BC", (), {"__call__": rbc.m})
print(t(lambda: type(BI(*range(3000))).__name__), t(lambda: BC()(*range(3000))), rbi.calls, rbc.calls)

print("-- r2: daybreak3's pins: a metaclass __get__ returning lambda: 17 (W1); 200000 arguments through a bound __init__ (W3)")


class Meta17(type):
    def __get__(cls, obj, owner=None):
        return lambda: 17


class Hook(metaclass=Meta17):
    pass


class A17:
    __len__ = Hook


print(t(lambda: len(A17())))


class MKW(type):
    def __get__(cls, obj, owner=None):
        return lambda *a, **k: ("kw", type(obj).__name__, len(a), sorted(k.items()))


class HKW(metaclass=MKW):
    pass


rkw = []


class MKI(type):
    def __get__(cls, obj, owner=None):
        return lambda *a, **k: rkw.append((type(obj).__name__, len(a), sorted(k.items())))


class HKI(metaclass=MKI):
    pass


CKW = type("CKW", (), {"__call__": HKW, "__init__": HKI})
print(t(lambda: CKW(1, x=2) and None), t(lambda: CKW()(3, y=4)), t(lambda: CKW()(**{"z": 5})), rkw)


class Rec200:
    def __init__(self):
        self.n = []

    def m(*a):
        a[0].n.append(len(a))


r200 = Rec200()
B200 = type("B200", (), {"__init__": r200.m})
print(t(lambda: type(B200(*range(200000))).__name__), r200.n)

print("-- r2 TESTS pins (grader): P166, T140, R1c, R7b, R6b, R1b (__float__ called once)")


class GRG:
    def ga(self, name):
        print("P166 meta __getattr__", name)
        raise AttributeError(name)


grgx = GRG()


class GM1(type):
    __getattr__ = grgx.ga


class GA1(metaclass=GM1):
    def __add__(self, o):
        return "A.__add__"


class GB1(GA1):
    def __radd__(self, o):
        return "B.__radd__"


print("P166", t(lambda: GA1() + GB1()))
gri = Rec(None)


class GM2(type):
    __init__ = gri.m


class GB2(metaclass=GM2):
    pass


gri.calls.clear()
print("T140", t(lambda: type(type("GC2", (GB2,), {})).__name__), gri.calls)


class GCall:
    def __init__(self, v):
        self.v = v

    def __call__(self, *a):
        return self.v


GPX = type("GPX", (), {"__index__": GCall(7)})
print("R1c", t(lambda: "%f" % GPX()))
GPY = type("GPY", (), {"__float__": GCall(2.5)})
print("R7b", t(lambda: "%f" % GPY()), t(lambda: format(type("GIY", (int,), {"__float__": GCall(1.5)})(2), "f")))
grgk, grst = Rec(((3,), {"k": 4})), Rec({"s": 1})
GKS = type("GKS", (), {"__getnewargs_ex__": grgk.m, "__getstate__": grst.m})
print("R6b", t(lambda: GKS().__reduce_ex__(2)[2]), grst.calls)


class GFS(float):
    pass


grfs = Rec(GFS(2.5))
GPZ = type("GPZ", (), {"__float__": grfs.m})
import warnings

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    # (a float subclass result: fv accepts it, so this is one call either way; the non-float
    # results below pin "called once")
    print("R1b", t(lambda: "%f" % GPZ()), t(lambda: "%e" % GPZ()), grfs.calls)

print("-- %-format's conversion results, as CPython checks them (PyFloat_AsDouble, mainformatlong, byte_converter)")
import warnings


def tw(f):
    try:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            r = repr(f())
        return r + ("" if not w else " W:" + w[0].category.__name__ + ":" + str(w[0].message)[:60])
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


class PFS(float):
    pass


class PIS(int):
    pass


rpc = []


def pmk(name, val):
    def m(self):
        rpc.append(name)
        return val

    return type("P_" + type(val).__name__, (), {name: m})()


for name in ("__float__", "__index__", "__int__"):
    for val in (3, 2.5, PFS(1.5), True, PIS(4), "s", None):
        o = pmk(name, val)
        rpc.clear()
        print(name, type(val).__name__, "|", tw(lambda: "%f" % o), "|", tw(lambda: "%d" % o), "|", tw(lambda: "%x" % o), "|", tw(lambda: "%c" % o), "| calls", len(rpc))
        rpc.clear()
        print(name, type(val).__name__, "bytes |", tw(lambda: b"%f" % o), "|", tw(lambda: b"%d" % o), "|", tw(lambda: b"%c" % o), "| calls", len(rpc))


class PBig:
    def __index__(self):
        return 10 ** 400


class PTE:
    def __index__(self):
        raise TypeError("inner")


class PVE:
    def __index__(self):
        raise ValueError("inner")


for o in (PBig(), PTE(), PVE()):
    n = type(o).__name__
    print(n, "|", tw(lambda: "%f" % o), "|", tw(lambda: len("%d" % o)), "|", tw(lambda: "%c" % o))
    print(n, "bytes |", tw(lambda: b"%f" % o), "|", tw(lambda: len(b"%d" % o)), "|", tw(lambda: b"%c" % o))
for o in (True, 3, 3.5, "s", b"x", b"xy", b"", bytearray(b"x"), bytearray(b"xy"), 300, -1, PIS(7), [1]):
    print(type(o).__name__, repr(o), "|", tw(lambda: b"%c" % o), "|", tw(lambda: b"%f" % o))
print("object |", tw(lambda: b"%c" % object()), "|", tw(lambda: b"%f" % object()))

print("-- #860 r2 (daybreak3's pins): bytes %f replaces BaseException too; an int subclass's own __float__")


class K:
    def __float__(self):
        raise KeyboardInterrupt("k")


def tb(f):
    try:
        return repr(f())
    except BaseException as e:
        return type(e).__name__ + ": " + str(e)


print(tb(lambda: "%f" % K()))
print(tb(lambda: b"%f" % K()))


class KS:
    def __float__(self):
        raise SystemExit("s")


print(tb(lambda: "%f" % KS()), tb(lambda: b"%f" % KS()))
calls = []


class I(int):
    def __float__(self):
        calls.append(0)
        return 9.5


print("%f" % I(2))
print(b"%f" % I(2))
print(calls)
fcalls = []


class FSub(float):
    def __float__(self):
        fcalls.append(0)
        return 9.5


print("%f" % FSub(2.0), b"%f" % FSub(2.0), "%e" % FSub(2.0), fcalls)
print("-- int and float subclasses overriding each conversion, and BaseExceptions in each, str and bytes")
xcalls = []


def xsub(base, name, val):
    def m(self):
        xcalls.append(name)
        return val

    return type(base.__name__ + "_" + name, (base,), {name: m})


for base, name, val in ((int, "__float__", 9.5), (int, "__index__", 7), (int, "__int__", 8), (float, "__float__", 9.5), (float, "__index__", 7)):
    xo = xsub(base, name, val)(2)
    for fmt in ("%f", "%d", "%x", "%c", "%e"):
        xcalls.clear()
        a = tw(lambda: fmt % xo)
        ca = list(xcalls)
        xcalls.clear()
        b = tw(lambda: fmt.encode() % xo)
        print(base.__name__, name, fmt, "|", a, ca, "|", b, list(xcalls))
for exc in (KeyboardInterrupt, SystemExit, GeneratorExit, StopIteration, MemoryError, RecursionError):
    for name in ("__float__", "__index__"):
        def xm(self, exc=exc):
            raise exc("x")

        xo = type("XK", (), {name: xm})()
        print(exc.__name__, name, "|", " | ".join(tb(lambda: f % xo) for f in ("%f", "%d", "%c")), "| bytes", " | ".join(tb(lambda: f % xo) for f in (b"%f", b"%d", b"%c")))
print("-- bytes %c's range (grader's C5): 255, 256 and -1, as ints and through __index__")
for k in (255, 256, -1):
    print(k, tb(lambda: b"%c" % k), tb(lambda: b"%c" % type("CI", (), {"__index__": lambda self: k})()))
print("-- #860 r3: a None slot (astra), and %d's PyNumber_Long order (__int__ before __index__)")
for nbase in (int, float, object):
    for nname in ("__float__", "__index__", "__int__"):
        NC = type(nbase.__name__ + "N" + nname, (nbase,), {nname: None})
        no = NC(2) if nbase is not object else NC()
        print(nbase.__name__, nname, "|", " | ".join(tb(lambda: f % no) for f in ("%f", "%d", "%x", "%c", "%e")), "| bytes", " | ".join(tb(lambda: f % no) for f in (b"%f", b"%d", b"%c")), "| format", tb(lambda: format(no, "f")), tb(lambda: format(no, "d")) if nbase is int else "")
for nbase in (object, float):
    for iv, xv in ((7, 8), ("s", 8), (7, "s"), (None, 8), (7, None)):
        nd = {"__int__": None if iv is None else (lambda self, v=iv: v), "__index__": None if xv is None else (lambda self, v=xv: v)}
        no = type("NB", (nbase,), nd)(*((2.5,) if nbase is float else ()))
        print(nbase.__name__, repr(iv), repr(xv), "|", " | ".join(tb(lambda: f % no) for f in ("%d", "%i", "%u", "%x", "%o", "%c", "%f")), "| bytes", " | ".join(tb(lambda: f % no) for f in (b"%d", b"%x", b"%c", b"%f")))
no = type("NP", (float,), {})(2.5)
print("plain float subclass |", " | ".join(tb(lambda: f % no) for f in ("%f", "%d", "%x", "%c")), "| bytes", " | ".join(tb(lambda: f % no) for f in (b"%d", b"%c")))
