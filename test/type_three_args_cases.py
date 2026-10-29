# type(name, bases, ns) without keywords, as CPython's type_call and
# type_new: the most derived metaclass's own __new__ is called directly
# (never through its metaclass's __call__) with the caller's dict, unchanged;
# then the result's type's __init__ if the result is a class.  The argument
# errors in CPython's order.  Compared with CPython by test/type-keywords.test.ts.


def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__, e)


NS = None


class MM(type):
    def __call__(cls, *a, **k):
        print("MM.__call__ (must not run for type())")
        return 17


class N(type, metaclass=MM):
    def __new__(mcls, name, bases, ns, **kw):
        print("N.__new__", name, sorted(kw), "same dict:", ns is NS, sorted(ns))
        return type.__new__(mcls, name, bases, ns)

    def __init__(cls, name, bases, ns, **kw):
        print("N.__init__", name, sorted(kw), "same dict:", ns is NS)


NA = type.__call__(N, "NA", (), {})
NS = {"x": 1}
t("winner's __new__ directly", lambda: (type("NB", (NA,), NS).__name__, sorted(NS)))
NS = {}
t("empty dict", lambda: (type(type("NC", (NA,), NS)).__name__, sorted(NS)))


class InitOnly(type):
    def __init__(cls, name, bases, ns, **kw):
        print("InitOnly.__init__", name, sorted(k for k in ns if not k.startswith("__")))


class IA(metaclass=InitOnly):
    pass


t("winner with only __init__", lambda: type(type("IB", (IA,), {"y": 2})).__name__)


class NonClass(type):
    def __new__(mcls, name, bases, ns, **kw):
        print("NonClass.__new__", name)
        return 5

    def __init__(cls, *a, **kw):
        print("NonClass.__init__ (must not run on 5)")


NCA = type.__new__(NonClass, "NCA", (), {})
t("__new__ returning a non-class", lambda: type("NCB", (NCA,), {}))

# type's own: the dict copied into the class, the caller's left as it was
D = {"a": 1, "f": lambda self: 2}
C = type("C", (), D)
print("plain", C.__name__, C.__qualname__, C.__module__, C.a, C().f(), sorted(D))
D2 = {"__qualname__": "Outer.Q", "__module__": "elsewhere", "__doc__": "doc"}
Q = type("Q", (), D2)
print("qualname, module and doc from the dict", Q.__qualname__, Q.__module__, Q.__doc__, sorted(D2))
print("bases", type("E", (C,), {}).__mro__[1] is C, type("F", (int,), {})(3) + 1)


class S:
    def __init_subclass__(cls, **kw):
        print("init_subclass", cls.__name__, sorted(kw))


t("__init_subclass__ without keywords", lambda: type("T", (S,), {}).__name__)

# the argument errors, CPython's order: name, bases, dict
t("bad name", lambda: type(5, (), {}))
t("bad bases", lambda: type("a", [], {}))
t("bad dict", lambda: type("a", (), 5))
t("all bad", lambda: type(5, 6, 7))
t("2 arguments", lambda: type("a", ()))
t("4 arguments", lambda: type("a", (), {}, 4))
t("0 arguments", lambda: type())
t("non-type base", lambda: type("a", (5,), {}))


class M2(type):
    pass


class C2(metaclass=M2):
    pass


t("metaclass conflict", lambda: type("X", (NA, C2), {}))

# one argument: the type, as before
print("type(x)", type(1), type(C), type(NA), type(type))
