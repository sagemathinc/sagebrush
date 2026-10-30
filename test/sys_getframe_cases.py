# sys._getframe and sys._getframemodulename: the chain of frames above a
# call, each one's co_name, f_globals' __name__ and f_lineno, through every
# kind of frame (functions, lambdas, methods, generators, comprehensions,
# class bodies, exec'd code, another module), and the depth argument's
# conversion.  Each line is compared with CPython's (test/sys-getframe.test.ts).
import sys, os, gc, tempfile, pickle, functools


def chain(depth=1):
    out = []
    f = sys._getframe(depth)
    while f is not None:
        out.append((f.f_code.co_name, f.f_globals.get("__name__"), f.f_lineno))
        f = f.f_back
    return out


def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__ + ":", e)


# ---- functions, lambdas, nesting, methods
def g():
    return chain()
t("def", g)
t("lambda", lambda: chain())
def outer():
    def inner():
        return chain()
    return inner()
t("nested", outer)
class C:
    r = chain()
    def m(self):
        return chain()
    @staticmethod
    def s():
        return chain()
    @classmethod
    def c(cls):
        return chain()
    @property
    def p(self):
        return chain()
    def __eq__(self, other):
        C.eq = chain()
        return True
    def __getattr__(self, name):
        return chain()
t("class body", lambda: C.r)
t("method", lambda: C().m())
t("staticmethod", C.s)
t("classmethod", C.c)
t("property", lambda: C().p)
t("dunder", lambda: (C() == 1, C.eq)[1])
t("__getattr__", lambda: C().missing)
t("recursion", lambda: (lambda f: f(f, 5))(lambda f, n: chain() if n == 0 else f(f, n - 1)))

# ---- the class statement's own calls: the body's frame has returned
class Meta(type):
    def __new__(mcls, name, bases, ns):
        Meta.r = chain()
        return super().__new__(mcls, name, bases, ns)
    @classmethod
    def __prepare__(mcls, name, bases):
        Meta.p = chain()
        return {}
class K(metaclass=Meta):
    pass
t("metaclass __new__", lambda: Meta.r)
t("metaclass __prepare__", lambda: Meta.p)
class Base:
    def __init_subclass__(cls):
        Base.r = chain()
class D(Base):
    pass
t("__init_subclass__", lambda: Base.r)
class Named:
    def __set_name__(self, owner, name):
        Named.r = chain()
class H:
    x = Named()
t("__set_name__", lambda: Named.r)
def in_function():
    class Local:
        r = chain()
    return Local.r
t("class body in a function", in_function)

# ---- comprehensions (PEP 709: list, set and dict ones have no frame) and
# generator expressions (which do)
t("listcomp", lambda: [chain() for _ in [0]][0])
t("setcomp", lambda: {tuple(chain()) for _ in [0]})
t("dictcomp", lambda: {0: chain() for _ in [0]}[0])
t("genexpr", lambda: list(chain() for _ in [0])[0])
t("genexpr in sum", lambda: sum(len(chain()) for _ in [0]))
t("nested comprehensions", lambda: [[chain() for _ in [0]] for _ in [0]][0][0])
t("genexpr in a listcomp", lambda: [list(chain() for _ in [0]) for _ in [0]][0][0])
# (a def of a comprehension's or the module's name keeps its frame)
def listcomp(): return chain()
def setcomp(): return chain()
def dictcomp(): return chain()
def genexpr(): return chain()
def module(): return chain()
for f in [listcomp, setcomp, dictcomp, genexpr, module]:
    n = f.__name__
    t(n, f)
    t(n + " in a listcomp", lambda: [f() for _ in [0]][0])
    t(n + " in a setcomp", lambda: {tuple(f()) for _ in [0]})
    t(n + " in a dictcomp", lambda: {0: f() for _ in [0]}[0])
    t(n + " in a genexpr", lambda: next(f() for _ in [0]))
def listcomp_calling(): return [chain() for _ in [0]][0]
def genexpr_calling(): return next(chain() for _ in [0])
t("a listcomp in a def", listcomp_calling)
t("a genexpr in a def", genexpr_calling)

# ---- generators and coroutines
def gen():
    yield chain()
    yield chain()
t("generator", lambda: next(gen()))
it = gen()
next(it)
def resume():
    return next(it)
t("generator resumed elsewhere", resume)
t("yield from", lambda: next((lambda: (yield from gen()))()))
async def coro():
    return chain()
async def await_it():
    return await coro()
def run_coro():
    c = await_it()
    try:
        c.send(None)
    except StopIteration as e:
        return e.value
t("coroutine driven by send", run_coro)

# ---- through builtins and the standard library
seen = []
t("sorted key", lambda: (sorted([2, 1], key=lambda x: seen.append(chain()) or x), seen[0])[1])
t("map", lambda: list(map(lambda x: chain(), [0]))[0])
t("functools.wraps", lambda: functools.wraps(g)(lambda: chain())())

# ---- exec and eval: each run's frames have its own globals
ns = {"chain": chain, "__name__": "zz"}
exec("def h(): return chain()\nr = h()", ns)
t("exec", lambda: ns["r"])
t("eval", lambda: eval("chain()", {"chain": chain, "__name__": "ev"}))
t("exec with locals", lambda: (exec("r = chain()", {"chain": chain, "__name__": "gl"}, loc := {}), loc["r"])[1])
code = compile("import sys\ndef who(): return sys._getframe(0).f_globals['tag']\n", "<shared>", "exec")
a, b = {"tag": "a"}, {"tag": "b"}
exec(code, a)
exec(code, b)
t("one code object, two globals", lambda: (a["who"](), b["who"](), a["who"](), b["who"]()))
t("f_globals is __globals__", lambda: (a["who"].__globals__ is a, sys._getframe(0).f_globals is globals()))
def from_dead_exec():
    d = {}
    exec("import sys\ndef f(): return sys._getframe(0).f_globals", d)
    return d["f"]
kept = from_dead_exec()
gc.collect()
t("a function outliving its exec", lambda: kept() is kept.__globals__ and sorted(k for k in kept() if not k.startswith("__")))
def frame_of_dead_exec():
    d = {"x": 1}
    exec("import sys\nfr = sys._getframe(0)", d)
    return d["fr"]
fr = frame_of_dead_exec()
gc.collect()
t("a frame keeps its globals", lambda: (fr.f_globals["x"], fr.f_code.co_name, fr.f_lineno))

# ---- mutation: f_globals is the live dict
def mutate():
    sys._getframe(1).f_globals["made_by_frame"] = 42
mutate()
t("f_globals written", lambda: made_by_frame)
global_name = 1
def reads():
    return sys._getframe(0).f_globals["global_name"]
global_name = 2
t("f_globals read now", reads)
def _try(f):
    try:
        f()
    except Exception as e:
        return e
for attr in ["f_lineno", "f_globals", "f_back", "f_code"]:
    def setit(attr=attr):
        setattr(sys._getframe(0), attr, None)
    t("set " + attr, lambda: type(_try(setit)).__name__)
t("frame type", lambda: (type(sys._getframe()).__name__, type(sys._getframe()).__module__, type(sys._getframe().f_code).__name__))
t("make a frame", lambda: type(sys._getframe())())

# ---- another module
d = tempfile.mkdtemp()
with open(os.path.join(d, "frame_mod.py"), "w") as fh:
    fh.write("import sys\n"
             "def where(f):\n"
             "    return f()\n"
             "def caller_module():\n"
             "    return sys._getframemodulename(1), sys._getframemodulename(0)\n"
             "def chain_here():\n"
             "    out = []\n"
             "    f = sys._getframe(0)\n"
             "    while f is not None:\n"
             "        out.append((f.f_code.co_name, f.f_globals.get('__name__')))\n"
             "        f = f.f_back\n"
             "    return out\n")
sys.path.insert(0, d)
import frame_mod
t("across modules", lambda: frame_mod.where(lambda: chain()))
t("called from another module", lambda: frame_mod.chain_here())
t("_getframemodulename", frame_mod.caller_module)
# (one file run as two modules: each run's functions keep their own globals)
os.mkdir(os.path.join(d, "pkg"))
open(os.path.join(d, "pkg", "__init__.py"), "w").close()
with open(os.path.join(d, "pkg", "twice.py"), "w") as fh:
    fh.write("import sys\ndef g(): return sys._getframe(0).f_globals['__name__'], sys._getframemodulename()\n")
sys.path.insert(0, os.path.join(d, "pkg"))
import twice, pkg.twice
t("one file, two modules", lambda: (twice.g(), pkg.twice.g(), twice.g(), twice.g.__globals__ is pkg.twice.g.__globals__))

# ---- the depth argument, as CPython's (a C int; a negative one is 0)
class Idx:
    def __index__(self):
        return 0
    def __repr__(self):
        return "Idx()"
class MyInt(int):
    pass
for depth in [0, 1, -1, -5, True, False, MyInt(0), Idx(), 2**31 - 1, 2**31, -2**31, -2**31 - 1, 2**100, 1.5, "0", None]:
    t("depth %r" % (depth,), lambda: sys._getframe(depth).f_code.co_name)
    t("modulename depth %r" % (depth,), lambda: sys._getframemodulename(depth))
t("past the stack", lambda: sys._getframe(10000))
t("modulename past the stack", lambda: sys._getframemodulename(10000))
t("keyword", lambda: sys._getframe(depth=0))
t("modulename keyword", lambda: sys._getframemodulename(depth=0))
t("modulename other keyword", lambda: sys._getframemodulename(level=0))
t("modulename both", lambda: sys._getframemodulename(0, depth=0))
t("too many", lambda: sys._getframe(0, 1))
t("modulename too many", lambda: sys._getframemodulename(0, 1))
t("module level", lambda: (sys._getframe(1).f_code.co_name, sys._getframemodulename(1)))

# ---- the standard library's callers: namedtuple's and Enum's module, pickled
from collections import namedtuple
import enum
P = namedtuple("P", "x y")
E = enum.Enum("E", "A B")
F = enum.IntFlag("F", "X Y")
t("namedtuple", lambda: (P.__module__, pickle.loads(pickle.dumps(P(1, 2)))))
t("Enum", lambda: (E.__module__, pickle.loads(pickle.dumps(E.A)), F.__module__))
nsx = {"namedtuple": namedtuple, "enum": enum, "__name__": "made_in_exec"}
exec("Q = namedtuple('Q', 'a')\nG = enum.Enum('G', 'A')", nsx)
t("in exec", lambda: (nsx["Q"].__module__, nsx["G"].__module__))
t("in another module", lambda: frame_mod.where(lambda: namedtuple("R", "a").__module__))
t("explicit module", lambda: namedtuple("S", "a", module="elsewhere").__module__)
