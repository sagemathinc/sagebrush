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
