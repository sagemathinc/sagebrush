# Long statements as CPython takes them (test/long-statements.test.ts): calls
# of 2,048 arguments or more (the array form), temporaries live at the same
# time, long operator chains, deep nesting's error and many hoisted constants.
# Every statement here is built as source text and run with exec, so that the
# compiler sees it whole; the sizes are ones CPython itself compiles.
import operator

BIG = 2048
log = []


def note(x):
    log.append(x)
    return x


def run(src, **ns):
    exec(src, ns)
    return ns


def show(label, thunk):
    try:
        print(label, thunk())
    except BaseException as e:
        print(label, type(e).__name__, e)


def star(*a):
    return len(a), a[0], a[-1]


def args(n, fmt="%d"):
    # (n arguments, each fmt with every %d its index)
    return ", ".join(fmt.replace("%d", str(i)) for i in range(n))


# --- temporaries live at the same time (a temporary reused too early gives a
# wrong value, not a crash)
def g():
    return note(1)


def h():
    return note(2)


def f(*a):
    return a


print("walrus in args", f((a := g()), ((b := h()) + a), a, b), log)
print("walrus in a comprehension in an argument", f([(y := i * 2) for i in range(3)], y))
print("list", [(p := 1), (q := p + 1), p + q, [(r := q * 3), r + p]])
print("set", sorted({(p := 3), (q := p * 2), p + q}))
print("dict", {(k := "a"): (v := k * 2), (k2 := k + "b"): v + k2, k: (v := v + "!")}, v)
print("tuple", ((p := 5), (q := (p, (r := p + 1))), (p, q, r)))


# (a temporary taken twice through nested lists must be pooled once: a dict
# whose values are lists of calls, then a pair of two calls compared)
def same(x, y):
    return x == y


def compare(x, y):
    return (x > y) - (x < y)


def hash_of(x):
    return x * 7


class W:
    depth = 9


a, b, c, w = 1, 1, 2, W()
print("nested lists' temporaries", {"same": same(a, b), "depth": w.depth, "eq": [same(a, b), same(a, c), a == b],
                                    "cmp": [compare(a, c), compare(c, a), compare(a, b)], "hash": hash_of(a) == hash_of(b), "held": w.depth})


def g2(i, w):
    return i * 10 + w


ns = run("r = f(" + args(3000, "g2(%d, (w := %d))") + ")\nr = (len(r), r[0], r[1500], r[-1], w)", f=f, g2=g2)
print("big call of small calls with temporaries", ns["r"])
ns = run("r = f(" + ", ".join("f(" + args(3000, "(z := %d)") + ")" if i == 1 else "g2(%d, (z := %d))" % (i, i) for i in range(3)) + ")\nr = (len(r), r[0], len(r[1]), r[1][-1], r[2], z)", f=f, g2=g2)
print("small call holding a big call", ns["r"])
ns = run("r = [" + args(3000, "(t := (%d, [%d, (u := %d)]))") + "]\nr = (len(r), r[7], r[-1], t, u)")
print("big list of nested walrus", ns["r"])


# --- the array path's order and errors: the callee, or the receiver, first;
# the arguments left to right; the first error stops the rest
def boom(i):
    raise ValueError("boom at %d" % i)


def getf():
    note("callee")
    return f


class O:
    def m(self, *a):
        return len(a)


def geto():
    note("receiver")
    return O()


for n in (BIG - 1, BIG, 3000):
    log.clear()
    src = "r = getf()(" + ", ".join("boom(%d)" % i if i == n // 2 else "note(%d)" % i for i in range(n)) + ")"
    show("plain call, %d args, raising in the middle:" % n, lambda: run(src, getf=getf, note=note, boom=boom)["r"])
    print("  log:", len(log), log[:2], log[-1])
    log.clear()
    src = "r = geto().m(" + ", ".join("boom(%d)" % i if i == n // 2 else "note(%d)" % i for i in range(n)) + ")"
    show("method call, %d args, raising in the middle:" % n, lambda: run(src, geto=geto, note=note, boom=boom)["r"])
    print("  log:", len(log), log[:2], log[-1])
    log.clear()
    src = "r = geto().m(" + ", ".join("note(%d)" % i for i in range(n)) + ")"
    show("method call, %d args:" % n, lambda: (run(src, geto=geto, note=note)["r"], len(log), log[:2], log[-1]))



# --- a big call site run more than once (its cached paths after the first
# call): the receiver kept, the arguments passed as an array each time; an
# instance's method, a staticmethod through its class, a builtin's method
class Many:
    def m(self, *a):
        return len(a), a[-1], self is many

    @staticmethod
    def s(*a):
        return len(a), a[-1]


many = Many()
src = "r = []\nfor _ in range(3):\n    r.append((o.m(%s), O.s(%s), '{}'.format(%s)))" % (args(3000), args(3000), args(3000))
print("big call sites run 3 times:", run(src, o=many, O=Many)["r"])

# --- calls the array form doesn't take: keywords, *args, **kwargs
def kw(*a, k=0, **more):
    return len(a), a[-1], k, len(more)


show("3000 positional and a keyword", lambda: run("r = kw(" + args(3000) + ", k=7)", kw=kw)["r"])
show("3000 positional and **", lambda: run("r = kw(" + args(3000) + ", **{'x': 1})", kw=kw)["r"])
show("*args of 3000 and more", lambda: run("r = kw(*range(3000), " + args(BIG) + ")", kw=kw)["r"])
show("3000 keywords", lambda: run("r = kw(" + ", ".join("k%d=%d" % (i, i) for i in range(3000)) + ")", kw=kw)["r"])


# --- each kind of callable on either side of BIG
class Ctor:
    def __init__(self, *a):
        self.n = len(a)


class Callable:
    def __call__(self, *a):
        return len(a)


class Meth:
    def m(self, *a):
        return len(a)


def two(a, b):
    return a + b


bound = Meth().m
kinds = [("compiled *args", star), ("compiled two params", two), ("bound method value", bound),
         ("class", lambda *a: Ctor(*a).n), ("__call__ instance", Callable()), ("max", max), ("min", min),
         ("operator.add", operator.add)]
for n in (BIG - 1, BIG):
    for name, fn in kinds:
        # (a TypeError's type only: operator's builtins word their count
        # message unlike CPython's, apart from what is pinned here)
        show("%s, %d args:" % (name, n), lambda: run("try:\n    r = fn(" + args(n) + ")\nexcept TypeError:\n    r = 'TypeError'", fn=fn)["r"])
    show("class direct, %d args:" % n, lambda: run("r = Ctor(" + args(n) + ").n", Ctor=Ctor)["r"])


# --- operator chains: the tree and the order kept
show("+ chain of 10,000", lambda: run("r = " + " + ".join(str(i) for i in range(10000)))["r"])
show("- chain", lambda: run("r = " + " - ".join(str(i) for i in range(1, 5000)))["r"])
show("/ chain", lambda: run("r = " + " / ".join(["1e300"] + ["2.0"] * 300))["r"])
show("** right-associative", lambda: run("r = 2 ** 3 ** 2")["r"])
show("** on the left spine", lambda: run("r = " + "(" * 25 + "2" + " ** 1)" * 25)["r"])
show("mixed precedence", lambda: run("r = " + " - ".join("%d + %d * %d" % (i, i, i + 1) for i in range(2000)))["r"])
show("% and // in a chain", lambda: run("r = 10 ** 30 " + " ".join(("// 3" if i % 2 else "% 1000003") for i in range(500)))["r"])
show("string chain", lambda: (lambda s: (len(s), s[:12], s[-5:]))(run("r = " + " + ".join("'%d'" % (i % 10) for i in range(3000)))["r"]))
show("walrus in chain terms", lambda: (lambda ns: (ns["r"], ns["c"]))(run("r = " + " + ".join("(c := %d)" % i if i % 1000 == 7 else str(i) for i in range(3000)))))
log.clear()
show("an operand raising mid-chain", lambda: run("r = " + " + ".join("boom(%d)" % i if i == 400 else "note(%d)" % i for i in range(1000)), note=note, boom=boom)["r"])
print("  log:", len(log), log[-1])
show("tuple + chain", lambda: len(run("r = " + " + ".join("(%d,)" % i for i in range(2000)))["r"]))
# a fresh array's chain: the first operand a name, so never written in place
show("a chain from an array named a", lambda: (lambda ns: (ns["a"].tolist(), ns["b"].tolist()))(run("import numpy as np\na = np.zeros(3) * 1\nb = a + " + " + ".join(["1"] * 70))))
# two errors in one chain: the first in source order is reported
for n in (4, 70):
    terms = ["(await a)" if i == 1 else "(await b)" if i == n - 1 else str(i) for i in range(n)]
    src = "def f():\n    return (" + " +\n        ".join(terms) + ")\n"
    try:
        compile(src, "<await>", "exec")
        print("two awaits compiled")
    except SyntaxError as e:
        print("two awaits, %d terms:" % n, e.msg, e.lineno)


# --- deep nesting: CPython's tokenizer refuses the 201st bracket
for src in ("x = " + "[" * 201 + "]" * 201, "x = " + "f(" * 201 + ")" * 201, "x = " + "[({" * 67 + "1" + "})]" * 67):
    try:
        compile(src, "<nested>", "exec")
        print("nesting compiled")
    except SyntaxError as e:
        print("nesting:", type(e).__name__, e.msg, e.lineno, e.offset)


# --- a tokenizer error after brackets nested past where the parser's stack
# may run out first (test/long-statements.test.ts runs this file at 250 KB
# too): the tokenizer's error, as CPython's, whatever the parser did first
deep = "x = " + "[" * 170
for label, src in [("unterminated string", deep + '"abc'), ("never closed", deep),
                   ("line continuation", "x = " + "[" * 40 + "]" * 40 + " \\ y\n"),
                   ("tabs and spaces", "if 1:\n" + "        x = " + "[" * 40 + "1" + "]" * 40 + "\n\tpass\n"),
                   ("unindent", "if 1:\n    if 1:\n        x = " + "[" * 40 + "1" + "]" * 40 + "\n      y = 1\n")]:
    try:
        compile(src, "<lex>", "exec")
        print("lexical:", label, "compiled")
    except (SyntaxError, MemoryError) as e:
        print("lexical:", label, type(e).__name__, getattr(e, "msg", e), getattr(e, "lineno", None), getattr(e, "offset", None))


# --- deep recursion in Python code keeps its own RecursionError text
def deep_recursion(n):
    return deep_recursion(n + 1)


try:
    deep_recursion(0)
except RecursionError as e:
    print("recursion:", e)


# --- many hoisted constants (more than 8,192 make a table): the same values,
# in order, of every kind
for n in (8191, 8192, 8193, 8300):
    items = []
    for i in range(n):
        k = i % 6
        items.append(["%d.0" % i, "-0.0", "0.0", "%dj" % i, "'s%d'" % i, "1e400"][k])
    ns = run("x = [" + ", ".join(items) + "]\nr = (len(x), x[:7], x[-3:], [str(v) for v in x[1000:1010]])")
    print("hoisted %d:" % n, ns["r"])
# a site called through the table: 8,300 constants, then attribute calls
src = "x = [" + ", ".join("%d.0" % i for i in range(8300)) + "]\nr = [o.m(1, 2), o.m(3), o.n(), sum(x)]"


class Sites:
    def m(self, *a):
        return a

    def n(self):
        return self is o


o = Sites()
print("sites through the table:", run(src, o=o)["r"])


# --- class bases with temporaries (the bases are evaluated after the class
# builder is fetched; a temporary of theirs must not be reused before)
def mk():
    note("mk")
    return Base


class Base:
    pass


def other(x):
    note(("other", x))
    return Mixin


class Mixin:
    pass


log.clear()
ns = run("class C((b := mk()), other(x := 2)):\n    pass\nr = ([k.__name__ for k in C.__mro__], b.__name__, x)", mk=mk, other=other)
print("class bases with temporaries:", ns["r"], log)


class generic:
    pass


ns = run("class number(generic):\n    pass\nr = [k.__name__ for k in number.__mro__]", generic=generic)
print("class with a global base:", ns["r"])
