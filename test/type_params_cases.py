# PEP 695's type parameters and type aliases, and _typing's types, as
# CPython 3.14's: what they make, when their parts are evaluated, what they
# see (a class's namespace first, from a class body), and the errors a
# compiler and _typing raise. Its output is CPython 3.14.4's, written into
# test/type-params.test.ts. Generic classes need typing.py, which CPython's
# own C code imports for Generic[...]: a stand-in for it (below) answers
# those calls the same way under both, so the statements themselves are
# what is compared.
import sys
import types
from _typing import TypeVar, ParamSpec, TypeVarTuple, TypeAliasType, NoDefault, Generic, ParamSpecArgs, ParamSpecKwargs


def show(label, f):
    try:
        print(label, "->", repr(f()))
    except BaseException as e:
        print(label, "->", type(e).__name__ + ":", e)


def run(label, src):
    g = {"__name__": "case"}
    try:
        exec(src, g)
        print(label, "->", repr(g.get("out")))
    except SyntaxError as e:
        print(label, "-> SyntaxError:", e.msg, "(line %d)" % e.lineno)
    except BaseException as e:
        print(label, "->", type(e).__name__ + ":", e)


print("== generic functions")
def f[T, *Ts, **P](x: T) -> T:
    return x
show("type params", lambda: f.__type_params__)
show("kinds", lambda: [type(t).__name__ for t in f.__type_params__])
show("qualname, call", lambda: (f.__qualname__, f(3)))
show("annotations", lambda: f.__annotations__)
show("variance inferred, module", lambda: (f.__type_params__[0].__infer_variance__, f.__type_params__[0].__module__))
def g[T: int, U: (int, str) = str]():
    pass
T, U = g.__type_params__
show("bound, constraints, default", lambda: (T.__bound__, U.__constraints__, U.__default__, T.__default__, T.has_default(), U.has_default()))
show("evaluators", lambda: (T.evaluate_bound.__name__, T.evaluate_bound.__qualname__, T.evaluate_bound.__defaults__, U.evaluate_default.__qualname__, U.evaluate_constraints(1)))
show("evaluator formats", lambda: (T.evaluate_bound(1), T.evaluate_bound(2)))
show("evaluator format 3", lambda: T.evaluate_bound(3))
show("evaluator arity", lambda: T.evaluate_bound(1, 2))
show("no bound: evaluators", lambda: (U.evaluate_bound, g.__type_params__[0].evaluate_default))
def lazy[T: undefined_name]():
    pass
show("a bound is lazy", lambda: lazy.__type_params__[0].__name__)
show("an undefined bound, read", lambda: lazy.__type_params__[0].__bound__)
def rec[T](n):
    return n if n == 0 else rec(n - 1)
show("the def's name is the enclosing scope's", lambda: rec(3))
def defaults[T](a=[1], *, b=2):
    return a, b
show("defaults", lambda: (defaults(), defaults.__defaults__, defaults.__kwdefaults__))
def ts[*Ts = *tuple[int, str]]():
    pass
show("a starred default", lambda: ts.__type_params__[0].__default__)
def outer():
    Y = float
    def inner[T: Y](a: T) -> list[T]:
        return a
    return inner
show("in a function", lambda: (outer().__qualname__, outer().__type_params__[0].__bound__, outer().__annotations__))
def closure[T]():
    def g():
        return T
    return g()
show("a closure over a type parameter", lambda: closure() is closure.__type_params__[0])
def ps[**P](*args: P.args, **kwargs: P.kwargs):
    pass
show("ParamSpec annotations", lambda: ps.__annotations__)
order = []
def note(x):
    order.append(x if isinstance(x, str) else "decorated" if callable(x) else x)
    return x
@note
def ordered[T: note("bound")](a=note("default")):
    pass
show("evaluation order", lambda: (order, ordered.__type_params__[0].__bound__, order))

print("== type aliases")
type A = list[int]
show("alias", lambda: (A, type(A), A.__value__, A.__name__, A.__module__, A.__type_params__, A.__parameters__))
show("evaluate_value", lambda: (A.evaluate_value.__qualname__, A.evaluate_value(1), A.evaluate_value.__defaults__))
type B[K, V = int] = dict[K, V]
show("generic alias", lambda: (B[str, int], B.__type_params__, B.__parameters__, B.__value__))
show("not generic: subscript", lambda: A[int])
show("unions", lambda: (A | int, A | None, int | A, A | B))
type Lazy = undefined_name
show("a value is lazy", lambda: Lazy.__name__)
show("an undefined value, read", lambda: Lazy.__value__)
type WithBound[T: int = bool] = list[T]
show("bound and default", lambda: (WithBound.__type_params__[0].__bound__, WithBound.__type_params__[0].__default__))
show("reduce, repr", lambda: (A.__reduce__(), repr(B)))

print("== a class's namespace, seen first")
run("annotation sees the class's T", "class C:\n    T = int\n    def m[T](self, x: T): pass\nout = C.m.__annotations__")
run("bound sees the class", "class C:\n    U = int\n    def m[T: U](self): pass\nout = C.m.__type_params__[0].__bound__")
run("a class's global", "class C:\n    global G\n    G = 5\n    def m[T: G](self): pass\nG = str\nout = C.m.__type_params__[0].__bound__")
run("alias in a class", "X = 'module'\nclass C:\n    X = 'class'\n    type A = X\nout = C.A.__value__")
run("generic alias in a class", "X = 'module'\nclass C:\n    X = 'class'\n    type A[T] = (X, T)\nout = C.A.__value__")
run("alias in a class in a function", "def outer():\n    X = 'func'\n    class C:\n        type A = X\n    return C\nout = outer().A.__value__")
run("class first, then the function's", "def outer():\n    X = 'func'\n    class C:\n        X = 'class'\n        def m[T: X](self): pass\n    return C\nout = outer().m.__type_params__[0].__bound__")
run("qualnames in a class", "class C:\n    def m[T: int](self): pass\n    type A = int\nout = (C.m.__qualname__, C.m.__type_params__[0].evaluate_bound.__qualname__, C.A.evaluate_value.__qualname__)")
run("__class__ in a generic method", "class C:\n    def m[T](self): return __class__\nout = C.m(C()) is C")
run("private names", "class O:\n    def m[__U](self): return __U\nout = O().m().__name__")

print("== generic classes (a stand-in for typing)")
stand_in = types.ModuleType("typing")
calls = []
class StandInAlias:
    def __init__(self, origin, params):
        self.origin, self.params = origin, params
    def __repr__(self):
        return f"Alias({self.origin.__name__}, {self.params!r})"
    def __mro_entries__(self, bases):
        return (self.origin,)
def _GenericAlias(origin, params):
    calls.append(("_GenericAlias", origin.__name__, params))
    return StandInAlias(origin, params)
def _generic_init_subclass(cls, *args, **kwargs):
    calls.append(("_generic_init_subclass", cls.__name__, args, kwargs))
def _generic_class_getitem(cls, *args, **kwargs):
    calls.append(("_generic_class_getitem", cls.__name__, args))
    return (cls.__name__, args)
def Unpack():
    pass
class _Unpack:
    def __getitem__(self, x):
        return ("Unpack", x)
stand_in._GenericAlias = _GenericAlias
stand_in._generic_init_subclass = _generic_init_subclass
stand_in._generic_class_getitem = _generic_class_getitem
stand_in.Unpack = _Unpack()
saved_typing = sys.modules.get("typing")
sys.modules["typing"] = stand_in
try:
    class Box[T]:
        item: T
        def get(self) -> T:
            return self.item
    show("type params", lambda: Box.__type_params__)
    show("bases, mro", lambda: (Box.__bases__, [c.__name__ for c in Box.__mro__]))
    show("in its namespace", lambda: Box.__dict__["__type_params__"] is Box.__type_params__)
    show("calls", lambda: calls)
    calls.clear()
    show("subscript", lambda: (Box[int], calls))
    calls.clear()
    class Pair[K, *Vs](dict, metaclass=type):
        pass
    show("TypeVarTuple unpacked, bases", lambda: (calls, Pair.__bases__))
    calls.clear()
    class Outer:
        X = int
        class Inner[T: X](list):
            y = 1
    show("nested", lambda: (Outer.Inner.__qualname__, Outer.Inner.__type_params__[0].__bound__, Outer.Inner.__bases__))
    order.clear()
    @note
    class Ordered[T: note("bound")](note(dict), k=note("keyword")):
        def __init_subclass__(cls, **kw):
            pass
    show("evaluation order", lambda: order)
    class Mangled:
        class C[__T](list):
            y = __T
    show("a generic class's private names", lambda: (Mangled.C.__type_params__[0].__name__, Mangled.C.y.__name__))
    _C__X = int
    __X = str
    run("its bases' other private names unmangled", "_C__X = int\n__X = str\nclass O:\n    class C[__T: __X](list):\n        pass\nout = O.C.__type_params__[0].__bound__")
finally:
    if saved_typing is None:
        del sys.modules["typing"]
    else:
        sys.modules["typing"] = saved_typing

print("== the compiler's errors")
for label, src in [
    ("duplicate", "def f[T, T](): pass"),
    ("reserved", "def f[__classdict__](): pass"),
    ("non-default after default", "def f[T = int, U](): pass"),
    ("yield in a bound", "def f[T: (yield)](): pass"),
    ("walrus in a bound", "def f[T: (x := 1)](): pass"),
    ("yield in a default", "def f[T = (yield)](): pass"),
    ("yield in a TypeVarTuple default", "def f[*Ts = (yield)](): pass"),
    ("yield in a ParamSpec default", "def f[**P = (yield)](): pass"),
    ("yield in an alias", "type A = (yield)"),
    ("walrus in an alias", "type A = (x := 1)"),
    ("await in an alias", "async def g():\n    type A = await x"),
    ("await in a bound", "async def g():\n    def f[T: (await x)](): pass"),
    ("await in a generic's bases", "async def g():\n    class C[T](await x): pass"),
    ("nonlocal type parameter", "def f[T]():\n    nonlocal T"),
]:
    run(label, src)

print("== _typing")
show("names", lambda: [n for n in ("Generic", "NoDefault", "ParamSpec", "ParamSpecArgs", "ParamSpecKwargs", "TypeAliasType", "TypeVar", "TypeVarTuple", "Union", "_idfunc") if hasattr(sys.modules["_typing"], n)])
show("Union, _idfunc", lambda: (sys.modules["_typing"].Union is types.UnionType, sys.modules["_typing"]._idfunc(2)))
show("types' names", lambda: [repr(c) for c in (TypeVar, ParamSpec, TypeVarTuple, TypeAliasType, Generic, ParamSpecArgs, ParamSpecKwargs, type(NoDefault))])
T = TypeVar("T")
show("TypeVar", lambda: (repr(T), T.__name__, T.__module__, T.__bound__, T.__constraints__, T.__default__, T.has_default()))
show("variance", lambda: (repr(TypeVar("X", covariant=True)), repr(TypeVar("X", contravariant=True)), repr(TypeVar("X", infer_variance=True))))
show("constraints", lambda: TypeVar("X", int, str).__constraints__)
show("a single constraint", lambda: TypeVar("X", int))
show("bivariant", lambda: TypeVar("X", covariant=True, contravariant=True))
show("variance and infer", lambda: TypeVar("X", infer_variance=True, covariant=True))
show("name not str", lambda: TypeVar(1))
show("no name", lambda: TypeVar())
show("unknown keyword", lambda: TypeVar("T", foo=1))
show("default", lambda: (TypeVar("D", default=int).__default__, TypeVar("D", default=int).has_default(), TypeVar("D", default=None).__default__))
show("readonly", lambda: setattr(T, "__name__", "x"))
run("subclass TypeVar", "from _typing import TypeVar\nclass Z(TypeVar): pass")
run("subclass an instance", "from _typing import TypeVar\nclass Z(TypeVar('T')): pass")
show("reduce", lambda: (T.__reduce__(), ParamSpec("P").__reduce__(), TypeVarTuple("Ts").__reduce__(), NoDefault.__reduce__()))
show("equality", lambda: (T == T, T == TypeVar("T"), hash(T) == hash(T)))
show("an attribute", lambda: (setattr(T, "foo", 1), T.foo))
show("prepare subst", lambda: (T.__typing_prepare_subst__(types.SimpleNamespace(__parameters__=(T,)), (int,)), TypeVar("D", default=int).__typing_prepare_subst__(types.SimpleNamespace(__parameters__=(TypeVar("D", default=int),)), ())))
P = ParamSpec("P")
show("ParamSpec", lambda: (repr(P), P.__bound__, P.args, P.kwargs, P.args.__origin__ is P, P.args == P.args, P.args == P.kwargs, P.__default__))
show("ParamSpec positional", lambda: ParamSpec("P", 1))
show("ParamSpecArgs", lambda: (ParamSpecArgs(T), ParamSpecKwargs(T), ParamSpecArgs(T) == ParamSpecArgs(T)))
show("ParamSpecArgs hashable", lambda: type(P.args).__hash__)
show("ParamSpec default", lambda: ParamSpec("P", default=...).__default__)
Ts = TypeVarTuple("Ts")
show("TypeVarTuple", lambda: (repr(Ts), Ts.__name__, Ts.__default__, TypeVarTuple("Ts", default=int).__default__))
show("TypeVarTuple bound", lambda: TypeVarTuple("Ts", bound=int))
show("TypeVarTuple subst", lambda: Ts.__typing_subst__(int))
show("TypeAliasType", lambda: (TypeAliasType("Q", int), TypeAliasType("Q", int).__module__, TypeAliasType("Q", int, type_params=(T,)).__parameters__, TypeAliasType("Q", int, type_params=()).__type_params__))
show("TypeAliasType no value", lambda: TypeAliasType("A"))
show("TypeAliasType name not str", lambda: TypeAliasType(1, int))
show("TypeAliasType params not a tuple", lambda: TypeAliasType("A", int, type_params=[T]))
show("TypeAliasType params not params", lambda: TypeAliasType("A", int, type_params=(int,)))
show("TypeAliasType default order", lambda: TypeAliasType("A", int, type_params=(TypeVar("U", default=int), T)))
show("NoDefault", lambda: (repr(NoDefault), type(NoDefault)() is NoDefault, repr(type(NoDefault))))
show("NoDefault arguments", lambda: type(NoDefault)(1))
show("NoDefault pickled", lambda: __import__("pickle").loads(__import__("pickle").dumps(NoDefault)) is NoDefault)
ev = TypeVar("T", default=int).evaluate_default
show("constant evaluator", lambda: (repr(type(ev)), repr(ev), ev(1), ev(4)))
show("constant evaluator keywords", lambda: ev(format=1))
show("constant evaluator made", lambda: type(ev)(1))
show("constant evaluator strings", lambda: (TypeVar("T", int, str).evaluate_constraints(4), TypeAliasType("A", list[int]).evaluate_value(4), TypeAliasType("A", list[int]).evaluate_value(2)))
show("no default's evaluator", lambda: T.evaluate_default)
show("Generic", lambda: (Generic.__mro__, Generic.__module__, Generic.__doc__.splitlines()[0]))
show("docs", lambda: [c.__doc__.splitlines()[0] for c in (TypeVar, ParamSpec, TypeVarTuple, TypeAliasType, ParamSpecArgs, ParamSpecKwargs)])

print("== typing.Union")
u = int | str
show("its type", lambda: (type(u), types.UnionType, type(u).__name__, type(u).__module__))
show("an instance's names", lambda: (u.__module__, u.__name__, u.__qualname__, u.__origin__))
show("Union[...]", lambda: (types.UnionType[int, str], types.UnionType[int], types.UnionType[int, None, int], types.UnionType[int | str, bytes]))
show("|", lambda: (int | None, None | int, int | list[int], repr(int | list[int] | dict[str, int])))
show("equality, hash", lambda: ((int | str) == (str | int), hash(int | str) == hash(str | int), (int | str).__args__, (int | str).__parameters__))
show("no types", lambda: types.UnionType[()])
show("not a type", lambda: int | 1)
show("subscripted, no parameters", lambda: (int | str)[int])
show("isinstance", lambda: (isinstance(1, int | str), issubclass(bool, int | str), isinstance(1.0, int | str)))
run("subclassed", "class X(int | str): pass")
