# type(name, bases, ns, **kw), as CPython's type_new: the keywords go to the
# most derived metaclass's __new__ and __init__, or with type's own to
# __init_subclass__; metaclass= is an ordinary keyword there.  Compared with
# CPython by test/type-keywords.test.ts.


def t(label, f):
    try: print(label, f())
    except Exception as e: print(label, "ERR", type(e).__name__, e)
class M(type):
    def __new__(mcls, name, bases, ns, **kw):
        print("M.__new__", mcls.__name__, name, sorted(kw))
        return super().__new__(mcls, name, bases, ns)
    def __init__(cls, name, bases, ns, **kw):
        print("M.__init__", name, sorted(kw))
class A(metaclass=M): pass
t("type kw via winner", lambda: type("B", (A,), {}, x=1).__name__)
t("type(M) of it", lambda: type(type("B2", (A,), {})).__name__)
class S:
    def __init_subclass__(cls, **kw):
        print("init_subclass", cls.__name__, sorted(kw))
t("type kw init_subclass", lambda: type("T", (S,), {}, flag=True).__name__)
t("type kw plain", lambda: type("U", (), {}, y=2))
t("type 1 arg kw", lambda: type(1, y=2))
t("type 2 args", lambda: type("a", ()))
t("M direct kw", lambda: M("V", (), {}, z=3).__name__)
t("type.__new__ kw", lambda: type.__new__(type, "W", (S,), {}, q=1).__name__)
t("conflict", lambda: type("X", (A, type("Y", (), {}).__class__("Z", (), {})), {}))
class M2(type): pass
class C2(metaclass=M2): pass
t("metaclass conflict", lambda: type("Q", (A, C2), {}))
t("0 kw", lambda: type(y=2))
t("2 kw", lambda: type("a", (), y=2))
t("4 kw", lambda: type("a", (), {}, 4, y=2))
t("3 kw bad ns", lambda: type("a", (), 5, y=2))
t("3 kw bad name", lambda: type(5, (), {}, y=2))
t("3 kw bad bases", lambda: type("a", 5, {}, y=2))
t("metaclass kw", lambda: type("a", (), {}, metaclass=type))
t("metaclass kw M", lambda: type("a", (), {}, metaclass=M))
t("kw name=", lambda: type(name="a", bases=(), dict={}))
t("module in ns", lambda: type("Z", (S,), {"__module__": "mm"}, k=1).__module__)
t("qualname", lambda: type("Z", (S,), {}, k=1).__qualname__)
t("M subclass type kw", lambda: M2("N", (), {}, k=1))


# As type_new: the winner's own __new__ is called directly (never through
# its metaclass's __call__) with the caller's dict, unchanged, and the
# keywords; then the result's type's __init__, if the result is a class.
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
NS = None
NA = type.__call__(N, "NA", (), {})
NS = {"x": 1}
t("winner's __new__ directly", lambda: (type("NB", (NA,), NS, flag=1).__name__, sorted(k for k in NS)))
NS = {}
t("empty dict", lambda: type(type("NC", (NA,), NS, flag=2)).__name__)
class InitOnly(type):
    def __init__(cls, name, bases, ns, **kw):
        print("InitOnly.__init__", name, sorted(kw))
class IA(metaclass=InitOnly): pass
t("winner with only __init__", lambda: type("IB", (IA,), {}, k=3).__name__)
class NonClass(type):
    def __new__(mcls, name, bases, ns, **kw):
        print("NonClass.__new__", name, sorted(kw))
        return 5
    def __init__(cls, *a, **kw):
        print("NonClass.__init__ (must not run on 5)")
NCA = type.__new__(NonClass, "NCA", (), {})
t("__new__ returning a non-class", lambda: type("NCB", (NCA,), {}, k=4))
class Other(type):
    def __init__(cls, *a, **kw):
        print("Other.__init__", a[0], sorted(kw))
class OtherNew(type):
    def __new__(mcls, name, bases, ns, **kw):
        return Other(name + "X", (), {})
ONA = type.__new__(OtherNew, "ONA", (), {})
t("__new__ returning another metaclass's class", lambda: type(type("ONB", (ONA,), {}, k=5)).__name__)


# the result's __init__ must return None, as for any instance
class R5(type):
    def __new__(mcls, name, bases, ns, **kw):
        return type.__new__(mcls, name, bases, ns)
    def __init__(cls, *a, **kw):
        return 5
R5A = type.__new__(R5, "R5A", (), {})
t("__init__ returning 5", lambda: type("R5B", (R5A,), {}, k=6))
