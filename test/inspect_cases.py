# inspect (lib/inspect.py, CPython 3.14's): what CPython prints for these, line for line (test/inspect-threading.test.ts).
# Builtins are left out: Sagebrush's carry no __text_signature__, so signature() of one is a ValueError here.
import functools
import inspect
import types


def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", type(e).__name__ + ":", e)


def f(a, /, b: int = 2, *c, d, e=5, **g) -> str:
    "f's doc"


class A:
    """A's doc,
       indented."""

    def __init__(self, x, y=1):
        pass

    def m(self, z, *, w=3):
        pass

    @classmethod
    def cm(cls, q):
        pass

    @staticmethod
    def sm(r=0):
        pass

    @property
    def p(self):
        return 1


class B:
    pass


class C(B):
    def __new__(cls, k, *a):
        return super().__new__(cls)


class M(type):
    def __call__(cls, u, v=0):
        pass


class D(metaclass=M):
    pass


class Callable:
    def __call__(self, s, t=1):
        pass


def gen():
    yield 1


async def coro():
    pass


@functools.wraps(f)
def wrapped(*args, **kwargs):
    return f(*args, **kwargs)


lam = lambda x, *y, **z: 0

for label, obj in [("f", f), ("A", A), ("A(1).m", A(1).m), ("A.m", A.m), ("A.cm", A.cm), ("A.sm", A.sm),
                   ("B", B), ("C", C), ("D", D), ("Callable()", Callable()), ("lam", lam), ("gen", gen),
                   ("partial(f, 1, d=3)", functools.partial(f, 1, d=3)), ("partial(lam, 1)", functools.partial(lam, 1)),
                   ("wrapped", wrapped)]:
    show("signature(%s)" % label, lambda: str(inspect.signature(obj)))
show("signature(wrapped, follow_wrapped=False)", lambda: str(inspect.signature(wrapped, follow_wrapped=False)))
show("signature(5)", lambda: inspect.signature(5))

s = inspect.signature(f)
show("repr", lambda: repr(s))
show("parameters", lambda: [(p.name, p.kind.name, p.kind.description, repr(p.default), repr(p.annotation)) for p in s.parameters.values()])
show("return_annotation", lambda: s.return_annotation)
show("replace", lambda: str(s.replace(return_annotation=inspect.Signature.empty)))
show("bind", lambda: repr(s.bind(1, 2, 3, d=4, z=9)))
show("bind arguments", lambda: s.bind(1, 2, 3, d=4, z=9).arguments)
show("bind args/kwargs", lambda: (s.bind(1, 2, 3, d=4).args, s.bind(1, 2, 3, d=4).kwargs))
show("bind()", lambda: s.bind())
show("bind(1, 2, b=3)", lambda: s.bind(1, 2, b=3, d=0))
show("bind(a=1)", lambda: s.bind(a=1, d=0))
show("bind_partial(1)", lambda: repr(s.bind_partial(1)))
ba = s.bind(1, d=4)
ba.apply_defaults()
show("apply_defaults", lambda: repr(ba))
show("Parameter ==", lambda: s.parameters["b"] == inspect.Parameter("b", inspect.Parameter.POSITIONAL_OR_KEYWORD, default=2, annotation=int))
show("Parameter str", lambda: [str(p) for p in s.parameters.values()])
show("Parameter bad name", lambda: inspect.Parameter("1x", inspect.Parameter.POSITIONAL_ONLY))
show("Parameter keyword", lambda: inspect.Parameter("def", inspect.Parameter.KEYWORD_ONLY))
show("Signature order", lambda: inspect.Signature([inspect.Parameter("k", inspect.Parameter.KEYWORD_ONLY), inspect.Parameter("p", inspect.Parameter.POSITIONAL_ONLY)]))
show("Signature dup", lambda: inspect.Signature([inspect.Parameter("p", inspect.Parameter.POSITIONAL_ONLY)] * 2))
show("Signature(...) str", lambda: str(inspect.Signature([inspect.Parameter("p", inspect.Parameter.POSITIONAL_ONLY), inspect.Parameter("q", inspect.Parameter.KEYWORD_ONLY, default=None)])))
f2 = lambda: 0
f2.__signature__ = inspect.signature(lam)
show("__signature__", lambda: str(inspect.signature(f2)))
show("getfullargspec(f)", lambda: inspect.getfullargspec(f))
show("getfullargspec(A.m)", lambda: inspect.getfullargspec(A.m))
show("predicates f", lambda: [inspect.isfunction(f), inspect.ismethod(f), inspect.isclass(f), inspect.isroutine(f), inspect.isgeneratorfunction(f), inspect.iscoroutinefunction(f)])
show("predicates A(1).m", lambda: [inspect.isfunction(A(1).m), inspect.ismethod(A(1).m), inspect.isroutine(A(1).m)])
show("predicates gen/coro", lambda: [inspect.isgeneratorfunction(gen), inspect.iscoroutinefunction(coro), inspect.isgenerator(gen()), inspect.ismodule(inspect)])
show("predicates A", lambda: [inspect.isclass(A), inspect.isabstract(A), inspect.isdatadescriptor(A.__dict__["p"]), inspect.ismethoddescriptor(A.__dict__["sm"])])
show("getdoc(A)", lambda: inspect.getdoc(A))
show("getdoc(f)", lambda: inspect.getdoc(f))
show("cleandoc", lambda: inspect.cleandoc("  a\n    b\n  c"))
show("unwrap", lambda: inspect.unwrap(wrapped) is f)
show("getattr_static", lambda: (inspect.getattr_static(A, "p") is A.__dict__["p"], inspect.getattr_static(A(1), "missing", "dflt")))
show("getmembers", lambda: [n for n, _ in inspect.getmembers(A) if not n.startswith("__")])
show("getmro", lambda: [c.__name__ for c in inspect.getmro(C)])
show("formatannotation", lambda: [inspect.formatannotation(x) for x in (int, list[int], "str", None, types.ModuleType)])
show("Parameter.empty", lambda: inspect.Parameter.empty is inspect.Signature.empty)
show("CO_ flags", lambda: (inspect.CO_VARARGS, inspect.CO_VARKEYWORDS, inspect.CO_GENERATOR, inspect.CO_COROUTINE))


# getattr_static on instances: a plain instance's own attribute, a class's __dict__ descriptor (its owner and name),
# no __getattr__ or property run by a static lookup, a shadowed __dict__, and __slots__
class P:
    pass


p = P()
p.x = 7
show("getattr_static instance", lambda: inspect.getattr_static(p, "x", "ABSENT"))
dd = P.__dict__["__dict__"]
show("P.__dict__['__dict__']", lambda: (repr(dd), dd.__name__, dd.__qualname__, dd.__objclass__ is P, P.__dict__["__dict__"] is dd))
calls = []


class Hooked:
    def __getattr__(self, name):
        calls.append(("getattr", name))
        return 1

    @property
    def prop(self):
        calls.append("prop")
        return 2


h = Hooked()
h.y = 3
show("getattr_static no hooks", lambda: (inspect.getattr_static(h, "y"), type(inspect.getattr_static(h, "prop")).__name__, inspect.getattr_static(h, "zzz", "ABSENT"), calls))


class Shadow:
    @property
    def __dict__(self):
        return {"x": "shadow"}


sh = Shadow()
show("getattr_static shadowed __dict__", lambda: inspect.getattr_static(sh, "x", "ABSENT"))


class Slotted:
    __slots__ = ("a",)


sl = Slotted()
sl.a = 5
show("getattr_static __slots__", lambda: (type(inspect.getattr_static(sl, "a")).__name__, inspect.getattr_static(sl, "b", "ABSENT")))


class Sub(P):
    pass


q = Sub()
q.z = 9
show("getattr_static subclass", lambda: (inspect.getattr_static(q, "z", "ABSENT"), "__dict__" in Sub.__dict__))
