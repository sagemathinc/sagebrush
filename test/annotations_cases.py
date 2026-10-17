# Lazy annotations (PEP 649/749) as CPython 3.14 has them: functions,
# classes and modules, __annotate__ and __annotations__, compared with CPython
# by test/annotations.test.ts
def t(f):
    try: print(repr(f()))
    except Exception as e: print(type(e).__name__, e)
def f(a: int, b: "str" = "x", /, c: list = None, *args: tuple, d: Undefined = 1, **kw: dict) -> float: pass
def g(a, b): pass
t(lambda: type(f.__annotate__).__name__)
t(lambda: f.__annotate__.__name__)
t(lambda: f.__annotate__.__qualname__)
t(lambda: f.__annotate__(1))
t(lambda: f.__annotate__(2))
t(lambda: f.__annotate__(3))
t(lambda: f.__annotate__(4))
t(lambda: f.__annotate__("1"))
t(lambda: f.__annotations__)
Undefined = "now defined"
t(lambda: f.__annotations__)
t(lambda: g.__annotate__)
t(lambda: g.__annotations__)
g.__annotations__ = {"a": 1}
t(lambda: (g.__annotations__, g.__annotate__))
f.__annotations__ = None
t(lambda: f.__annotations__)
del f.__annotations__
t(lambda: f.__annotations__)
def h(x: int): pass
h.__annotate__ = None
t(lambda: h.__annotations__)
t(lambda: (lambda: 0).__annotate__)
class C:
    x: int
    y: "str" = "a"
    z = 3
    def m(self) -> C: pass
t(lambda: C.__annotations__)
t(lambda: "__annotations__" in C.__dict__)
t(lambda: sorted(k for k in C.__dict__ if "annot" in k))
t(lambda: C.__annotate__(1))
t(lambda: C.m.__annotations__)
class D: pass
t(lambda: D.__annotations__)
t(lambda: D.__annotate__)
class E(C): pass
t(lambda: E.__annotations__)
t(lambda: E.__annotate__)
import sys
mod = sys.modules[__name__]
t(lambda: sorted(k for k in vars(mod) if "annot" in k))
t(lambda: mod.__annotate__ is not None)
x: int = 5
t(lambda: mod.__annotations__)
def outer():
    y: int = 1
    return y
t(lambda: outer.__annotations__)
def lazy(a: (print("evaluated"), int)[1]): pass
print("defined")
t(lambda: lazy.__annotations__)
t(lambda: lazy.__annotations__)
class F:
    T = int
    def m(self, a: T) -> T: pass
t(lambda: F.m.__annotations__)
t(lambda: (lambda x: x).__annotations__)

class C:
    if False:
        a: int
    b: str
    for i in range(2):
        c: float
    try:
        d: list
        raise ValueError
    except ValueError:
        e: dict
    __p: int
t(lambda: C.__annotations__)
t(lambda: sorted(k for k in C.__dict__ if "annot" in k))
t(lambda: C.__dict__.get("__conditional_annotations__"))
class D:
    x: int
t(lambda: type(D.__dict__["__annotate_func__"]).__name__)
t(lambda: D.__annotate__.__qualname__)
D.__annotations__ = {"y": 1}
t(lambda: (D.__annotations__, D.__annotate__, sorted(k for k in D.__dict__ if "annot" in k)))
class E:
    x: int
E.__annotate__ = None
t(lambda: E.__annotations__)
t(lambda: setattr(E, "__annotate__", 5))
class F:
    __annotations__ = {"explicit": 1}
    x: int
t(lambda: F.__annotations__)
def f(a: int): pass
t(lambda: setattr(f, "__annotate__", 5))
f.__annotate__ = lambda fmt: {"z": fmt}
t(lambda: f.__annotations__)
def g(a: int): pass
g.__annotations__
g.__annotate__ = lambda fmt: {"w": 1}
t(lambda: g.__annotations__)
def h(a: int): pass
h.__annotate__ = lambda fmt: [1]
t(lambda: h.__annotations__)
t(lambda: setattr(h, "__annotations__", 5))
import types
m = types.ModuleType("m")
t(lambda: m.__annotations__)
t(lambda: m.__annotate__)
src = "x: int = 1\nif False:\n    y: str\nz: list\n"
exec(src, m.__dict__)
t(lambda: sorted(k for k in m.__dict__ if "annot" in k))
t(lambda: m.__dict__["__conditional_annotations__"])
t(lambda: m.__annotations__)
t(lambda: m.__annotate__(1))
class G:
    def __init__(self):
        self.x: int = 1
t(lambda: G.__annotations__)
class H:
    x: undefined_name
t(lambda: H.__annotations__)
def k(*args: int, **kw: str): pass
t(lambda: k.__annotations__)
def l(a: "a" = 1, *, b: "b"): pass
t(lambda: l.__annotations__)
class I:
    def __m(self, __a: int) -> int: pass
t(lambda: I._I__m.__annotations__)
async def am(a: int) -> str: pass
t(lambda: am.__annotations__)
def gen(a: int): yield a
t(lambda: gen.__annotations__)
t(lambda: f.__annotate__.__defaults__)
def q(a: int): pass
t(lambda: q.__annotate__.__code__.co_varnames)
t(lambda: q.__annotate__.__module__)


# nested scopes: closures, methods' annotations seeing the class body
def outer2():
    T = list

    def inner(a: T) -> T: pass

    class K:
        U = dict

        def m(self, b: U, c: T) -> "K": pass
        v: U
    return inner, K


inner, K = outer2()
t(lambda: inner.__annotations__)
t(lambda: inner.__annotate__.__qualname__)
t(lambda: K.m.__annotations__)
t(lambda: K.m.__annotate__.__qualname__)
t(lambda: K.__annotations__)
t(lambda: K.__annotate__.__qualname__)
# a decorator sees the annotations, evaluated then
def deco(f):
    print("deco sees", f.__annotations__)
    return f


@deco
def decorated(x: int, *, y: str = "") -> None: pass


# an annotation raising: each access re-raises until it is fixed
def bad(a: missing_name): pass


t(lambda: bad.__annotations__)
missing_name = 1
t(lambda: bad.__annotations__)
t(lambda: bad.__annotations__ is bad.__annotations__)
# annotations of a lambda inside a function and of __annotate__ itself
t(lambda: f.__annotate__.__annotate__)
t(lambda: f.__annotate__.__defaults__)
