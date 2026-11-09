# A compiled function's call errors and its code object's signature fields, as CPython 3.14.10's (sage2's #912
# findings): the function named by its __qualname__; every missing argument listed ("'a', 'b', and 'c'"); "takes from
# 1 to 2 positional arguments" with defaults, "(and 1 keyword-only argument)" when some were given; the keywords'
# errors first, then too many, then the missing positional, then the missing keyword-only ones; a generator's and a
# coroutine's arguments checked at the call; co_varnames in CPython's order (positional, keyword-only, *args, **kwargs:
# a function's other locals are not recorded, so the functions here have none) and co_flags' CO_GENERATOR and
# CO_COROUTINE. test/call_errors_cases.out is CPython 3.14.10's output (python3 -I).
def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


def f1(a, b=2, *args, c, d=4, **kw):
    pass
def f2(a, /, b, *, c):
    pass
def f3(*args):
    pass
def f4(a, b, c=3):
    pass
class K:
    def m(self, a, *rest, k=0):
        pass
def g():
    yield 1
async def co():
    pass


for f in (f1, f2, f3, f4, K.m, g, co):
    c = f.__code__
    print(f.__qualname__, c.co_varnames, c.co_argcount, c.co_posonlyargcount, c.co_kwonlyargcount, hex(c.co_flags))
print(t(lambda: f4()))
print(t(lambda: f4(1)))
print(t(lambda: f4(1, 2, 3, 4)))
print(t(lambda: f4(1, 2, c=3, d=4)))
print(t(lambda: f4(1, 2, a=1)))
print(t(lambda: f2(a=1, b=2, c=3)))
print(t(lambda: f2(1, 2, 3)))
print(t(lambda: f2(1, 2)))
print(t(lambda: f1()))
print(t(lambda: f1(1)))
print(t(lambda: K().m()))
print(t(lambda: K().m(1, 2, j=3)))
print(t(lambda: f3(x=1)))
print(t(lambda: (lambda x: x)()))
print(t(lambda: f4(1, 2, 3, 4, 5)))
def g4(a, b, c, d): pass
def g1(a): pass
def k(a, b=1, *, c, d, e=5): pass
def kv(a, *r, c, d): pass
def o(a, /, b): pass
class C:
    def m(self, x): pass
    @staticmethod
    def s(x, y): pass
    class D:
        def n(self, *, q): pass
print(t(lambda: g4()))
print(t(lambda: g4(1)))
print(t(lambda: g1(1, 2)))
print(t(lambda: g1()))
print(t(lambda: k(1, 2, 3)))
print(t(lambda: k(1, 2, 3, c=1)))
print(t(lambda: k(1, 2, 3, c=1, d=2)))
print(t(lambda: k(1, 2, 3, 4, c=1, d=2, e=3)))
print(t(lambda: k(1)))
print(t(lambda: k(1, c=1)))
print(t(lambda: k()))
print(t(lambda: k(b=2)))
print(t(lambda: k(1, 2, 3, z=1)))
print(t(lambda: kv(1)))
print(t(lambda: kv()))
print(t(lambda: o(a=1, b=2)))
print(t(lambda: o(b=2)))
print(t(lambda: C().m()))
print(t(lambda: C().m(1, 2)))
print(t(lambda: C.m()))
print(t(lambda: C.s(1)))
print(t(lambda: C.D().n()))
print(t(lambda: C.D().n(1)))
print(t(lambda: C.D().n(q=1, r=2)))
def defs(a, b=1): pass
defs.__defaults__ = None
print(t(lambda: defs(1)))
defs.__qualname__ = "renamed"
print(t(lambda: defs()))
def gen(a, b):
    yield a
print(t(lambda: gen(1)))
print(t(lambda: gen(1, 2, 3)))
async def coro(a):
    pass
print(t(lambda: coro()))
def gk(a, *, k):
    yield a
print(t(lambda: gk(1)))
print(t(lambda: (lambda *, k: k)()))


# (CPython 3.14's static flags: CO_NESTED, CO_METHOD, CO_HAS_DOCSTRING)
class A:
    f = lambda self: 0
    def m(self):
        "doc"
    class B:
        def h(self):
            yield 1
    def outer(self):
        def inner():
            "d"
        return inner
    async def ac(self):
        pass
def top():
    return lambda: 0
def nodoc():
    x = "not a docstring"
for fn in (A.f, A.m, A.B.h, A().outer(), A.ac, top(), top, nodoc):
    print(fn.__qualname__, hex(fn.__code__.co_flags))
