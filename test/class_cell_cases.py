# __class__ and zero-argument super() in every kind of code, against CPython
# 3.14 (test/class-cell.test.ts runs this with python3 and with sagebrush).
import types


def t(label, fn):
    try:
        r = fn()
    except BaseException as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(label, r)


class A:
    def v(self):
        return 10

    @classmethod
    def cv(cls):
        return "A.cv"


class B(A):
    # super()
    def plain(self):
        return super().v() + 1

    def nested(self):
        def g():
            return super().v() + 2
        return g()

    def nested_arg(self):
        def g(x):
            return super().v() + 3
        return g(self)

    def lam(self):
        return (lambda: super().v())()

    def lam_arg(self):
        return (lambda s: super().v() + 4)(self)

    def listcomp(self):
        return [super().v() + i for i in range(2)]

    def dictcomp(self):
        return {k: super().v() for k in "a"}

    def setcomp(self):
        return {super().v() for _ in "ab"}

    def genexp(self):
        return list(super().v() for _ in range(1))

    def genexp_sum(self):
        return sum(super().v() for _ in range(1))

    def gen(self):
        yield super().v()

    async def co(self):
        return super().v()

    @classmethod
    def cm(cls):
        return super().cv()

    @staticmethod
    def sm():
        return super()

    @staticmethod
    def sm_arg(x):
        return super().v()

    @staticmethod
    def sm_type(x):
        return super().cv()

    def kwonly(*, self=None):
        return super()

    def star(*args):
        return super().v()

    def posonly(self, /):
        return super().v()

    def reassign(self):
        self = 5
        return super().v()

    def reassign_ok(self):
        self = B()
        return super().v()

    def deleted(self):
        del self
        return super().v()

    def captured(self):
        f = lambda: self
        return super().v() + (f() is self)

    def local_class_name(self):
        __class__ = 5
        return super()

    def between(self):
        __class__ = 5

        def g(s):
            return super()
        return g(self)

    def between_unbound(self):
        def g(s):
            return super()
        r = g(self)
        __class__ = 5
        return r

    # bare __class__
    def bare(self):
        return __class__.__name__

    def bare_nested(self):
        def g():
            return __class__.__name__
        return g()

    def bare_lambda(self):
        return (lambda: __class__.__name__)()

    def bare_comp(self):
        return [__class__.__name__ for _ in "ab"]

    def bare_genexp(self):
        return list(__class__.__name__ for _ in "a")

    @staticmethod
    def bare_static():
        return __class__.__name__

    @classmethod
    def bare_cm(cls):
        return __class__ is cls

    def shadow(self):
        __class__ = "shadow"
        return __class__

    def shadow_inner(self):
        def g():
            return __class__
        __class__ = "outer"
        return g()

    def shadow_inner_unbound(self):
        def g():
            return __class__
        r = g()
        __class__ = "late"
        return r

    lam_attr = lambda self: __class__.__name__

    def default(self, c=lambda: __class__.__name__):
        return c()

    def gen_bare(self):
        yield __class__.__name__


b = B()
for name in ["plain", "nested", "nested_arg", "lam", "lam_arg", "listcomp", "dictcomp", "setcomp", "genexp", "genexp_sum",
             "reassign", "reassign_ok", "deleted", "captured", "local_class_name", "between", "between_unbound", "bare",
             "bare_nested", "bare_lambda", "bare_comp", "bare_genexp", "shadow", "shadow_inner", "shadow_inner_unbound",
             "lam_attr", "default", "posonly", "star"]:
    t(name, getattr(b, name))
t("gen", lambda: list(b.gen()))
t("gen_bare", lambda: list(b.gen_bare()))
t("cm", B.cm)
t("sm", B.sm)
t("sm_arg", lambda: B.sm_arg(b))
t("sm_arg wrong", lambda: B.sm_arg(3))
t("sm_arg type", lambda: B.sm_type(B))
t("kwonly", lambda: B.kwonly(self=b))
t("bare_static", B.bare_static)
t("bare_cm", B.bare_cm)


def run(c):
    try:
        c.send(None)
    except StopIteration as e:
        return e.value


t("co", lambda: run(b.co()))

# Code that is not in a class
t("module super", lambda: super())


def free(self):
    return super()


def free0():
    return super()


def free_class():
    return __class__


t("free function", lambda: free(1))
t("free function no args", free0)
t("free __class__", free_class)
try:
    class C1:
        x = super()
except BaseException as e:
    print("class body super", type(e).__name__, e)
try:
    class C2:
        y = __class__
except BaseException as e:
    print("class body __class__", type(e).__name__, e)


# Classes inside functions, nested classes, an outer function binding __class__
def make(base):
    class Local(base):
        def v(self):
            return super().v() + 100

        def who(self):
            return __class__.__name__
    return Local


L1, L2 = make(A), make(A)
t("local classes", lambda: (L1().v(), L1().who(), L1 is not L2, L2().v()))


def outer():
    __class__ = "outer function"

    class Inner:
        def m(self):
            return __class__.__name__

        def n(self):
            return super().__repr__ is not None
    return Inner


t("class nearer than function", lambda: (outer()().m(), outer()().n()))


class Outer:
    def m(self):
        return __class__.__name__

    class Mid:
        def m(self):
            return __class__.__name__

        class In(A):
            def m(self):
                return (__class__.__name__, super().v())

    def make(self):
        class Made:
            def m(self):
                return __class__.__name__
        return Made().m(), __class__.__name__


t("nested classes", lambda: (Outer().m(), Outer.Mid().m(), Outer.Mid.In().m(), Outer().make()))

# exec'd classes
ns = {"A": A}
exec("class E(A):\n    def v(self): return super().v() + 5\n    def k(self): return __class__.__name__\n", ns)
t("exec", lambda: (ns["E"]().v(), ns["E"]().k()))


# A function attached after the class has no __class__
def outside(self):
    return super().v()


class F(A):
    pass


F.o = outside
t("attached later", lambda: F().o())


# The cell is set when type.__new__ makes the class: before __set_name__,
# __init_subclass__ and a metaclass's __init__, not while the metaclass's
# __new__ prepares the namespace
class Meta(type):
    def __new__(m, name, bases, ns):
        print("ns keys", [k for k in ns if k not in ("__static_attributes__", "__classdictcell__")])
        if name == "Drop":
            ns.pop("__classcell__")
        if name == "Early":
            t("early __class__", lambda: ns["probe"](None))
            t("early super", lambda: ns["sup"](None))
        if name == "Bad":
            ns["__classcell__"] = 5
        if name == "Swap":
            ns["__classcell__"] = types.CellType()
        c = super().__new__(m, name, bases, ns)
        print("dict has classcell", "__classcell__" in c.__dict__)
        return c

    def __init__(cls, name, bases, ns):
        super().__init__(name, bases, ns)
        if name == "G":
            print("meta init", cls.hello())


class Plain(metaclass=Meta):
    def m(self):
        return 1


class G(A, metaclass=Meta):
    @classmethod
    def hello(cls):
        return "hello " + __class__.__name__ + " " + super().cv()


for name in ["Drop", "Bad", "Swap"]:
    try:
        exec("class %s(metaclass=Meta):\n    def m(self): return __class__\n" % name)
    except BaseException as e:
        print(name, type(e).__name__, e)


class Early(metaclass=Meta):
    def probe(self):
        return __class__

    def sup(self):
        return super()


class Dropper(type):
    def __new__(m, name, bases, ns):
        return super().__new__(m, name, bases, {k: v for k, v in ns.items() if k != "__classcell__"})


try:
    class Dropped(metaclass=Dropper):
        def m(self):
            return super()
except BaseException as e:
    print("Dropped", type(e).__name__, e)


class Desc:
    def __set_name__(self, owner, name):
        print("set_name", owner.probe())


class H:
    @classmethod
    def probe(cls):
        return __class__.__name__
    d = Desc()


class Base:
    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        print("init_subclass", __class__.__name__, cls.__name__, cls.who())


class Sub(Base):
    @classmethod
    def who(cls):
        return __class__.__name__


try:
    class Sub2(Base, foo=1):
        pass
except TypeError as e:
    print("Sub2", e)
try:
    class Sub3(foo=1):
        pass
except TypeError as e:
    print("Sub3", e)
t("object.__init_subclass__", lambda: (object.__init_subclass__(), A.__init_subclass__()))
t("object.__init_subclass__ kw", lambda: object.__init_subclass__(x=1))
t("object.__init_subclass__ arg", lambda: object.__init_subclass__(1))


class NoUse(metaclass=Meta):
    def m(self):
        return self.__class__.__name__


t("obj.__class__ is an attribute", lambda: NoUse().m())

# types.CellType
c = types.CellType()
t("empty cell", lambda: c.cell_contents)
c.cell_contents = 3
t("cell", lambda: (c.cell_contents, types.CellType(4).cell_contents, type(c).__name__))
t("cell args", lambda: types.CellType(1, 2))

# super() with arguments
t("super instance", lambda: super(int, "x"))
t("super type", lambda: repr(super(B, B)))
t("super type wrong", lambda: super(B, A))
t("super 1 arg", lambda: repr(super(int)))
t("super 3 args", lambda: super(int, 1, 2))
t("super kw", lambda: super(type=int))
t("super not a type", lambda: super(1, 2))
