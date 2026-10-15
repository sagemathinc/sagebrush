# Runtime behaviour found while writing Python mode's search examples
# (test/python-runtime.test.ts compares this program's output under
# Sagebrush with CPython's).
import io
import math
import random
import sys

# print writes to sys.stdout as it is now: a StringIO, an object with write,
# or nothing at all for None
buf = io.StringIO()
sys.stdout = buf
print("captured", 1, sep="-")
sys.stdout = sys.__stdout__
print(repr(buf.getvalue()))


def in_function():
    old, sys.stdout = sys.stdout, io.StringIO()
    try:
        print("inside a function")
        return sys.stdout.getvalue()
    finally:
        sys.stdout = old


print(repr(in_function()))


class Writer:
    def __init__(self):
        self.parts = []

    def write(self, s):
        self.parts.append(s)


w = Writer()
sys.stdout = w
print("a", "b", end="!")
sys.stdout = None
print("nothing")
sys.stdout = sys.__stdout__
print(w.parts)

# sum of floats with Neumaier's compensation (CPython 3.12), and of complex
# numbers (3.14); subclasses and big ints are added as they are
cases = [[0.1] * 10, [1e100, 1.0, -1e100], [1, 0.1, 0.2, 0.3], [0.1, 2 ** 70, 0.1], [float("inf"), 1.0],
         [float("inf"), -float("inf")], [1e308, 1e308], [-0.0, -0.0], [0.1j] * 10, [0.1 + 0.1j] * 10, [0.1, True, 0.2],
         [1e16, 1.0, 1.0], [0.1, 0.1j, 0.1j, 0.2], [1j, 2 ** 70, 0.1]]


class F(float):
    pass


class I(int):
    pass


cases += [[F(0.1)] * 10, [0.1, F(0.2), 0.3], [0.1, I(3), 0.2]]
for c in cases:
    print(repr(sum(c)), repr(sum(c, 0.0)), repr(sum(c, -0.0)), repr(sum(x for x in c)))
print(repr(sum([], -0.0)), repr(sum([0.5, 0.25], 1)), repr(sum([0.1] * 10, 1j)), repr(sum(0.1 for _ in range(10))))

# sum takes the items one at a time, adding each as it comes, as CPython: a
# generator's next() and the additions interleave (also in sum(genexpr),
# which the compiler runs as a loop), through every path (int, float,
# complex, anything) (CORR-97B-2)
state = [1]
log = []


class Item:
    def __init__(self, n):
        self.n = n

    def __radd__(self, other):
        state[0] *= 2
        log.append(("add", self.n))
        return other + self.n


def items(first=()):
    yield from first
    for k in range(3):
        log.append(("yield", k))
        yield Item(state[0])


for first in [(), (1, 2), (0.5, 0.25), (1, 0.5, 1j), (2 ** 70,)]:
    state[0] = 1
    del log[:]
    a = sum(x for x in items(first))
    log1 = log[:]
    state[0] = 1
    del log[:]
    print(repr(a), repr(sum(items(first))), log1 == log, log)


def endless():
    k = 0
    while True:
        log.append(k)
        yield 0.5 if k < 3 else "x"
        k += 1


del log[:]
for f in (lambda: sum(endless()), lambda: sum(v for v in endless())):
    try:
        f()
    except TypeError as e:
        print(type(e).__name__, e, log)
    del log[:]

# round() of int and float subclasses (int.__round__, float.__round__)
for v in [F(2.5), F(2.567), I(15), True, 3.5]:
    for nd in [None, 1, -1]:
        r = round(v) if nd is None else round(v, nd)
        print(repr(v), nd, repr(r), type(r).__name__)
print(float.__round__(2.675, 2), int.__round__(25, -1))

# math.gamma and math.lgamma, CPython's own Lanczos approximation
random.seed(7)
xs = [5.5, 100, 0.5, 1e-21, 170.5, 171.7, 141.5, 139.9, 201, 1e-5, 2.0000001, 3.7, 23, 24, 25.5]
xs += [random.uniform(0, 180) for _ in range(400)] + [math.exp(random.uniform(-40, 6)) for _ in range(300)]
for x in xs:
    out = []
    for f in (math.gamma, math.lgamma):
        try:
            out.append(repr(f(x)))
        except (ValueError, OverflowError) as e:
            out.append(type(e).__name__)
    print(*out)

# += and *= on a subclass of list: its own __iadd__/__imul__ when it defines
# them (a vector that adds entrywise), list's in-place extension otherwise
class Vec(list):
    def __add__(self, o):
        return Vec(a + b for a, b in zip(self, o))

    def __mul__(self, k):
        return Vec(a * k for a in self)

    def __iadd__(self, o):
        return self + o

    def __imul__(self, k):
        return self * k


class Plain(list):
    pass


v = Vec([1, 2]); w = v
v += v
print(v, type(v).__name__, w, v is w)
v = Vec([1, 2]); v *= 3
print(v, type(v).__name__)
p = Plain([1, 2]); q = p
p += [3]
p *= 2
print(p, type(p).__name__, p is q)
l = [1]; m = l
l += (2, 3)
l *= 2
print(l, l is m)

# A special method set to None, or to a callable that is not a function:
# None raises TypeError ('NoneType' object is not callable; for __contains__
# and __iter__ the operation is unavailable), a callable instance is called
# without self, as CPython does
class Called:
    def __call__(self, *a):
        return ("called", len(a))


class Dunders:
    __add__ = Called()
    __iadd__ = Called()
    __neg__ = Called()


class Nones(list):
    __iadd__ = None
    __imul__ = None


class NoneOps:
    __add__ = None
    __isub__ = None
    __neg__ = None
    __eq__ = None
    __lt__ = None
    __len__ = None
    __contains__ = None
    __iter__ = None

    def __getitem__(self, i):
        return i


def attempt(f):
    try:
        return f()
    except TypeError as e:
        return "TypeError: %s" % e


def iadd(a, b):
    a += b
    return a


def imul(a, b):
    a *= b
    return a


def isub(a, b):
    a -= b
    return a


d = Dunders()
print(d + 1, iadd(Dunders(), 1), -d)
n = NoneOps()
for f in (lambda: iadd(Nones([1]), [2]), lambda: imul(Nones([1]), 2), lambda: n + 1, lambda: isub(NoneOps(), 1),
          lambda: -n, lambda: n == 1, lambda: n < 1, lambda: len(n), lambda: 1 in n, lambda: list(n)):
    print(attempt(f))

# (review) reflected priority sees an inherited None or shared callable as
# not overridden; descriptors are looked up at each call; getters and
# __call__ are called as Python calls objects
class Hook:
    def __call__(self, other):
        return "right"


class LeftNone:
    def __add__(self, other):
        return 42

    def __mul__(self, other):
        return 43

    __radd__ = None
    __rmul__ = None


class RightNone(LeftNone):
    pass


class LeftHook:
    def __add__(self, other):
        return "left"

    __radd__ = Hook()


class RightHook(LeftHook):
    pass


class RightOwn(LeftHook):
    __radd__ = Hook()


print(LeftNone() + RightNone(), LeftNone() * RightNone(), LeftHook() + RightHook(), LeftHook() + RightOwn())


class Desc:
    def __get__(self, obj, cls):
        return lambda other: "old"


class UsesDesc:
    __add__ = Desc()


u = UsesDesc()
seen = [u + 1]
Desc.__get__ = lambda self, obj, cls: lambda other: "new"
seen.append(u + 1)
del Desc.__get__
seen.append(attempt(lambda: u + 1))
Desc.__get__ = lambda self, obj, cls: lambda other: "added"
seen.append(u + 1)
print(seen)


class Getter:
    def __call__(self, desc, obj, cls):
        return lambda other: 99


class G1:
    __get__ = Getter()


class G2:
    __get__ = staticmethod(lambda desc, obj, cls: lambda other: 98)


class G3:
    __get__ = None


class UsesG:
    __add__ = G1()
    __sub__ = G2()
    __mul__ = G3()


g = UsesG()
print(g + 1, g - 1, attempt(lambda: g * 1))


class CallNone:
    __call__ = None


class UsesCallNone:
    __neg__ = CallNone()


class BoolNone:
    __bool__ = None


print(attempt(lambda: -UsesCallNone()), attempt(lambda: bool(BoolNone())), attempt(lambda: abs(object())), attempt(lambda: -object()))

# (review) the override test is CPython's optional class-attribute lookup
# (an AttributeError from a class-level __get__ means absent; a metaclass
# __getattribute__ is used), it runs before the methods are fetched, and a
# non-function __call__ is bound through its own __get__
class Hidden:
    def __get__(self, obj, cls):
        if obj is None:
            raise AttributeError("hidden")
        return lambda other: 99


class HA:
    def __add__(self, other):
        return 42


class HB(HA):
    __radd__ = Hidden()


class MetaNone(type):
    def __getattribute__(cls, name):
        if name == "__radd__":
            return None
        return type.__getattribute__(cls, name)


class MA(metaclass=MetaNone):
    def __add__(self, other):
        return "left"

    def __radd__(self, other):
        return "base"


class MB(MA):
    def __radd__(self, other):
        return "right"


class Swap:
    def __call__(self, other):
        return "right"

    def __ne__(self, other):
        SA.__add__ = lambda self, other: "new"
        return False


class SA:
    __radd__ = Swap()

    def __add__(self, other):
        return "old"


class SB(SA):
    __radd__ = Swap()


print(HA() + HB(), MA() + MB(), SA() + SB())


class CallClass:
    __call__ = classmethod(lambda cls, *a, **k: (cls.__name__, a, k))


class CallProp:
    __call__ = property(lambda self: lambda *a, **k: ("prop", a, k))


class CallStatic:
    __call__ = staticmethod(lambda *a, **k: ("static", a, k))


print(CallClass()(1, k=2), CallProp()(1, k=2), CallStatic()(1, k=2), staticmethod(lambda **k: k)(k=3))


# sagebrush-astra on 866d675: __get__ added to the attribute's type after
# the override test has seen it (CORR-866-1: distinct, shared, inherited
# attributes), and a metaclass __getattribute__/__getattr__ that is not a
# plain function, bound through its __get__ (CORR-866-2).
def _rget(label, f):
    try:
        return f()
    except Exception as e:
        return label + ":" + type(e).__name__


class GHook:
    def __call__(self, other):
        return "raw right"


class GA:
    __radd__ = GHook()

    def __add__(self, other):
        return "left"


class GB(GA):
    __radd__ = GHook()


class GHook2:
    def __call__(self, other):
        return "raw right"

    def __eq__(self, other):
        return False

    def __ne__(self, other):
        return True

    __hash__ = object.__hash__


_gh = GHook2()


class GC:
    __radd__ = _gh

    def __add__(self, other):
        return "left"


class GD(GC):
    __radd__ = _gh


class GHook3:
    def __call__(self, other):
        return "raw right"


class GE:
    __radd__ = GHook3()

    def __add__(self, other):
        return "left"


class GF(GE):
    pass


_before = [GA() + GB(), GC() + GD(), GE() + GF()]
GHook.__get__ = lambda self, obj, cls: (lambda other: "bound right") if obj is not None else None
GHook2.__get__ = lambda self, obj, cls: (lambda other: "bound right") if obj is not None else self
GHook3.__get__ = lambda self, obj, cls: (lambda other: "bound right") if obj is not None else object()
_after = [GA() + GB(), GC() + GD(), GE() + GF()]
del GHook.__get__
print(_before, _after, GA() + GB())


def _meta_pair(hook, name="__getattribute__", base=type):
    class Meta(base):
        pass

    class A(metaclass=Meta):
        def __add__(self, other):
            return "left"

        def __radd__(self, other):
            return "base right"

    class B(A):
        def __radd__(self, other):
            return "right"

    setattr(Meta, name, hook)
    return _rget("meta", lambda: A() + B())


class _NoAttrMeta(type):
    def __getattribute__(cls, name):
        raise AttributeError(name)


_seen = []


class _Getter:
    def __call__(self, *a):
        _seen.append(len(a))
        return object()


print(
    _meta_pair(staticmethod(lambda name: object())),
    _meta_pair(classmethod(lambda mcls, name: _seen.append(mcls.__name__) or object())),
    _meta_pair(_Getter()),
    _meta_pair(staticmethod(lambda name: "same"), "__getattr__", _NoAttrMeta),
    _seen,
)


# A metaclass with only __getattr__ (type's own __getattribute__): the
# override test falls back to it, and an error other than AttributeError
# propagates (astra's category (b) on 866d675).
def _getattr_only(mode):
    log = []

    class Meta(type):
        def __getattr__(cls, name):
            if name == "__radd__":
                log.append(cls.__name__)
                if mode == "hide":
                    raise AttributeError(name)
                if mode == "value":
                    raise ValueError("visible")
                if mode == "mutation":
                    A.__add__ = lambda s, o: "new left"
                return cls.__name__
            raise AttributeError(name)

    class A(metaclass=Meta):
        def __add__(self, other):
            return "left"

    class B(A):
        pass

    return _rget(mode, lambda: A() + B()), log


print([_getattr_only(m) for m in ["different", "hide", "value", "mutation"]])
