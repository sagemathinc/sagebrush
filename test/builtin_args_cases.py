# Builtins' argument checks as CPython 3.14's: @sagebrush-astra3's sweep
# (/scratch/sagebrush-reviews/sweeps/python-wrong-answers-astra3.md,
# A01-A14) and the inputs around each; compared with CPython by
# test/builtin-args.test.ts


def t(label, f):
    try:
        r = f()
        print(label, repr(r))
    except Exception as e:
        print(label, type(e).__name__, str(e).split("\n")[0])


class I(int):
    pass


class F(float):
    pass


# A01: comparison dunders take only their own kind
for n in ("__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__"):
    t("A01 int." + n, lambda n=n: [getattr(int, n)(1, x) for x in (1, 1.0, True, I(1), F(1.0), 2**70, "1", None, 1j)])
    t("A01 bool." + n, lambda n=n: [getattr(bool, n)(True, x) for x in (1, 1.0, True)])
    t("A01 float." + n, lambda n=n: [getattr(float, n)(1.0, x) for x in (1, 1.0, True, I(1), F(1.0), 2**70, "1", None, 1j)])
t("A01 ops", lambda: (1 == 1.0, 1 < 2.0, 2.0 > 1, True == 1.0, I(1) == 1.0, 2**70 == 2.0**70, 1 == 1j))
for n in ("__add__", "__sub__", "__mul__", "__truediv__", "__floordiv__", "__mod__", "__divmod__", "__pow__", "__radd__", "__rpow__", "__lshift__", "__and__"):
    t("A01 int." + n, lambda n=n: [getattr(int, n)(3, x) for x in (2, 2.0, True)])

# A02: the z flag is for floats
for s in ("z", "z5", "zd", "z,", "z_d", "zx", "zn", "zc", "z.2f", "z.2"):
    t("A02 int " + s, lambda s=s: [format(x, s) for x in (1, 0, -1, 10**30, True)])
    t("A02 float " + s, lambda s=s: format(-0.0, s))

# A03: round's precision is an integer (__index__)
class Ix:
    def __index__(self):
        return 1

    def __repr__(self):
        return "Ix()"


for nd in (1.5, 1.0, "1", None, Ix(), True, -1, 10**30, -10**30, 2**63, I(2)):
    # (an int with a huge negative precision: CPython computes 10**-nd)
    if not (isinstance(nd, int) and nd < -400):
        t("A03 round(1, %r)" % (nd,), lambda nd=nd: round(1, nd))
    t("A03 round(1.25, %r)" % (nd,), lambda nd=nd: round(1.25, nd))
    t("A03 round(0.0, %r)" % (nd,), lambda nd=nd: round(0.0, nd))
    t("A03 round(inf, %r)" % (nd,), lambda nd=nd: round(float("inf"), nd))
    t("A03 round(nan, %r)" % (nd,), lambda nd=nd: round(float("nan"), nd))
t("A03 round kw", lambda: (round(1.25, ndigits=1), round(5, ndigits=None), round(number=2.5)))

# A04, A05: non-finite floats through the whole format spec
specs = ["", "d", "b", "c", "x", "#x", "o", "X", "n", "s", "f", "F", "e", "E", "g", "G", "%", ".3%", "10", "<10", "^10G", "=+10", "010", "+", " ", "z", "#", ",", "_", ".2", "10.2E", "#g", "0=10", "*^9F", ",.2f", "_e"]
for x in ("inf", "-inf", "nan"):
    for s in specs:
        t("A04 %s %r" % (x, s), lambda x=x, s=s: format(float(x), s))
for s in ("d", "b", "c", "x", "s", "%c"):
    t("A04 1.5 %r" % s, lambda s=s: format(1.5, s))

# A06, A07: complex formatting: width over the whole, its own forbidden specs
cspecs = ["", ">12", "<12", "^12", "*^14", "12", "z", "08", "%", "=10", "+", " ", "-", ".2", ".2f", "e", "E", "g", "G", "n", "f", "F", "10.3e", "d", "x", "c", "s", ",", "_", ",.2f", "#", "#g", ".0", "z.1f", "+.3g", ">20.2f"]
for c in (1 + 2j, 1j, -0.0 - 1j, 0j, -1j, complex(-0.0, 0.0), 1.5 + 0j, complex("inf+nanj"), complex(-0.0, -0.0), 1e20 + 1e-20j, 12345.678 - 9j):
    for s in cspecs:
        t("A06 %r %r" % (c, s), lambda c=c, s=s: format(c, s))

# A08: the fill character is checked whatever the width
for m in ("ljust", "rjust", "center"):
    for args in ((2, 4), (2, "ab"), (2, ""), (5, "*"), (2, "*"), (-1, 4), (5, b"*"), (2, None)):
        t("A08 str.%s%r" % (m, args), lambda m=m, args=args: getattr("abc", m)(*args))
        t("A08 bytes.%s%r" % (m, args), lambda m=m, args=args: getattr(b"abc", m)(*args))
        t("A08 bytearray.%s%r" % (m, args), lambda m=m, args=args: getattr(bytearray(b"abc"), m)(*args))
    t("A08 str.%s fill kw" % m, lambda m=m: getattr("abc", m)(2, fillchar=4))
    t("A08 bytes.%s bytearray fill" % m, lambda m=m: getattr(b"abc", m)(6, bytearray(b"-")))
t("A08 zfill", lambda: ("ab".zfill(1), b"ab".zfill(1)))

# A09: removeprefix/removesuffix check their argument
for m in ("removeprefix", "removesuffix"):
    for a in (1, None, b"a", "a", "", bytearray(b"a"), memoryview(b"a"), "abc", "x"):
        lab = "memoryview(b'a')" if isinstance(a, memoryview) else repr(a)
        t("A09 str.%s(%s)" % (m, lab), lambda m=m, a=a: getattr("abc", m)(a))
        t("A09 bytes.%s(%s)" % (m, lab), lambda m=m, a=a: getattr(b"abc", m)(a))
        t("A09 bytearray.%s(%s)" % (m, lab), lambda m=m, a=a: getattr(bytearray(b"abc"), m)(a))

# (and the other str and bytes methods' arguments)
ARGS = {
    "split": [(1,), (None,), ("b",), (b"b",), ("b", 1.5), ("b", "1"), ("b", None)],
    "rsplit": [(1,), (None, 1)],
    "strip": [(1,), (None,), ("a",), (b"a",), (memoryview(b"a"),)],
    "lstrip": [(1,)], "rstrip": [(1,)],
    "partition": [(1,), (None,), ("",), (b"",), ("b",), (b"b",)],
    "rpartition": [(1,)],
    "replace": [(1, "x"), ("a", 1), ("a", "x", 1.5), ("a", "x", "1"), (b"a", b"x"), ("a", "x", None)],
    "find": [(1,), (None,), ("b", 1.5), ("b", None, None), (b"b",), (98,)],
    "count": [(1,), ("b", "1")], "index": [(1,)], "rfind": [(1,)],
    "startswith": [(1,), ((1,),), ("a", 1.5)], "endswith": [(1,)],
    "zfill": [(1.5,), ("5",), (None,)],
    "expandtabs": [(1.5,), ("4",), (None,)],
    "center": [(1.5,), ("5",)],
    "join": [([1],), ([b"a"],), (["a"],), ([bytearray(b"a"), memoryview(b"b")],)],
    "splitlines": [(1.5,), ("x",), (None,)],
    "count2": [],
}
for m, cases in ARGS.items():
    for args in cases:
        for subj in ("abc", b"abc", bytearray(b"abc")):
            lab = ", ".join("memoryview(b'%s')" % bytes(a).decode() if isinstance(a, memoryview) else ("[...]" if isinstance(a, list) and any(isinstance(y, memoryview) for y in a) else repr(a)) for a in args)
            t("A09+ %s.%s(%s)" % (type(subj).__name__, m, lab), lambda m=m, args=args, subj=subj: getattr(subj, m)(*args))

# A10: min/max: default only with one iterable
for f in (min, max):
    n = f.__name__
    t("A10 %s(1, 2, default=3)" % n, lambda f=f: f(1, 2, default=3))
    t("A10 %s(1, 2, key=None, default=3)" % n, lambda f=f: f(1, 2, key=None, default=3))
    t("A10 %s([], default=3)" % n, lambda f=f: f([], default=3))
    t("A10 %s([1, 2], default=3)" % n, lambda f=f: f([1, 2], default=3))
    t("A10 %s(1, 2)" % n, lambda f=f: f(1, 2))
    t("A10 %s(1)" % n, lambda f=f: f(1))
    t("A10 %s()" % n, lambda f=f: f())
    t("A10 %s(default=1)" % n, lambda f=f: f(default=1))
    t("A10 %s([])" % n, lambda f=f: f([]))
    t("A10 %s(1, 2, foo=3)" % n, lambda f=f: f(1, 2, foo=3))
    t("A10 %s([3, 1], key=len)" % n, lambda f=f: f(["ccc", "a"], key=len))
    t("A10 %s(1, 2, key=3)" % n, lambda f=f: f(1, 2, key=3))

# A11: str()'s encoding and errors are str, for any object
for args in ((1, 2), (1, "utf-8"), (b"a", 2), (b"a", "utf-8", 3), (1, None), (b"a", None), ("a", "utf-8"), (1, "utf-8", "strict"), (bytearray(b"a"), "ascii"), (memoryview(b"a"), "ascii"), (b"\xff", "utf-8", "replace")):
    lab = "(memoryview(b'a'), 'ascii')" if isinstance(args[0], memoryview) else repr(args)
    t("A11 str%s" % lab, lambda args=args: str(*args))
t("A11 str kw", lambda: (str(object=1), str(b"a", encoding="ascii"), str(b"a", errors="strict")))
t("A11 str kw bad", lambda: str(1, errors=2))
t("A11 str kw bad2", lambda: str(object=1, encoding=2))
t("A11 map", lambda: list(map(str, [1], [2])))

# A12: enumerate's start is an integer (__index__)
for s in (1.0, 1, True, "1", None, Ix(), 2**70, -5, I(3)):
    t("A12 enumerate(%r)" % (s,), lambda s=s: list(enumerate(["x", "y"], s)))
t("A12 enumerate kw", lambda: list(enumerate(["x"], start=2)))
t("A12 enumerate kw float", lambda: list(enumerate(["x"], start=2.0)))

# A13: three-argument pow
for args in ((2.0, 3, 5), (2, 3.0, 5), (2, 3, 5.0), (2.0, 0, 5), (2.0, -1, 5), (2.0, 3, -5), (2.0, 3, 0), (2, 3, 5), (2, -1, 5), (2, 3, 0), (1j, 2, 3), (2, 3, None), (2.0, 3, None), (True, 2, 3), (2, 3, True), (I(2), 3, 5), (F(2.0), 3, 5), ("a", 2, 3), (2, "a", 3), (2, 3, "a")):
    t("A13 pow%r" % (args,), lambda args=args: pow(*args))
t("A13 float.__pow__", lambda: float.__pow__(2.0, 3, 5))
t("A13 float.__pow__ None", lambda: float.__pow__(2.0, 3, None))
t("A13 int.__pow__", lambda: int.__pow__(2, 3, 5.0))
t("A13 int.__pow__ 2", lambda: int.__pow__(2, 3.0, 5))
t("A13 float.__rpow__", lambda: float.__rpow__(2.0, 3, 5))

# A14: %c and format 'c' code points
for v in (-1, 10**30, 0x110000, 0x10FFFF, 65, 0, True, -(10**30), 2**63):
    t("A14 format(%r, 'c')" % (v,), lambda v=v: format(v, "c"))
    t("A14 '%%c' %% %r" % (v,), lambda v=v: "%c" % v)
    t("A14 chr(%r)" % (v,), lambda v=v: chr(v))
t("A14 '%c' float", lambda: "%c" % 65.0)
t("A14 '%c' str", lambda: ("%c" % "a", "%c" % "ab"))
t("A14 b'%c'", lambda: (b"%c" % 65, b"%c" % 256, b"%c" % -1, b"%c" % b"a"))


# @sagebrush-astra's review probe of 3c703280 (CORR-3C7-1..5)
def show(label, f):
    try: print(label, repr(f()))
    except Exception as e: print(label, type(e).__name__, str(e))

for kind in (bytes, bytearray):
    for name in ('find', 'rfind', 'index', 'rindex', 'count'):
        events = []
        class Index:
            def __init__(self, label, value): self.label, self.value = label, value
            def __index__(self):
                events.append(self.label)
                return self.value
        show(kind.__name__ + '.' + name, lambda: getattr(kind(b'abca'), name)(b'a', Index('start', 1), Index('end', 4)))
        print('events', events)

class Changing:
    def __init__(self): self.n = 0
    def __index__(self):
        self.n += 1
        return self.n - 1
show('changing find index', lambda: b'abc'.find(b'a', Changing()))

events = []
class Start:
    def __index__(self): events.append('index'); return 3
class Iterable:
    def __iter__(self): events.append('iter'); return iter(['x'])
show('enumerate order', lambda: list(enumerate(Iterable(), Start())))
print('enumerate events', events)
show('enumerate None kw', lambda: list(enumerate(['x'], start=None)))
show('enumerate None pos', lambda: list(enumerate(['x'], None)))

for value in ('abc', b'abc', bytearray(b'abc')):
    for name, args in [('ljust',(-10**100,)), ('zfill',(-10**100,)), ('expandtabs',(2**32+1,)), ('split',(None,10**100)), ('replace',(value[:1],value[1:2],10**100))]:
        show(type(value).__name__+'.'+name+' bound',lambda value=value,name=name,args=args:getattr(value,name)(*args))

class R:
    def __rpow__(self, base, mod=None): return ('reflected',base,mod)
show('pow exponent reflected',lambda:pow(2,R(),5))
class A:
    def __pow__(self, other, mod=None): return NotImplemented
class B(A):
    def __rpow__(self, other, mod=None): return ('subtype reflected',mod)
show('pow subtype reflected',lambda:pow(A(),B(),5))
class F(float):
    def __pow__(self, other, mod=None): return ('float custom',other,mod)
show('pow float subtype',lambda:pow(F(2),3,5))
show('pow ordinary',lambda:pow(2,3,5))
show('pow float refusal',lambda:pow(2.0,3,5))

old=bytearray(b'a')
class Mutate:
    def __index__(self): old[0]=98; return 1
show('replace mutable old during count',lambda:b'abc'.replace(old,b'x',Mutate()))
new=bytearray(b'x')
class MutateNew:
    def __index__(self): new[0]=121; return 1
show('replace mutable new during count',lambda:b'abc'.replace(b'a',new,MutateNew()))

for spec in ('z', 'z.2f', '+#c', '.2d', 'G', '%'):
    show('format int '+spec,lambda spec=spec:format(1,spec))
for spec in ('0<10', '0^10', '#', '+12', 'z', 'z.2f'):
    show('format complex '+spec,lambda spec=spec:format(complex(-0.0,1.25),spec))


# (daybreak2's HARD-3C7-1: Py_ssize_t and C int arguments within their
# bounds, CPython's OverflowError past them, promptly; a width past what can
# be allocated a MemoryError (bytes: "byte string is too large" at the
# Py_ssize_t limit), never a host error or a hang)
class Big:
    def __init__(self, v):
        self.v = v

    def __index__(self):
        return self.v


for s in ("x", b"x", bytearray(b"x")):
    n = type(s).__name__
    for v in (10**100, -10**100, 2**63, 2**63 - 1, -2**63, -2**63 - 1, 2**62, 2**40):
        for m in ("ljust", "rjust", "center", "zfill"):
            t("HARD %s.%s(%d)" % (n, m, v), lambda s=s, v=v, m=m: getattr(s, m)(v))
        t("HARD %s.ljust(Big(%d))" % (n, v), lambda s=s, v=v: s.ljust(Big(v)))
    for v in (2**31, 2**31 - 1, -2**31, -2**31 - 1, 10**100):
        t("HARD %s.expandtabs(%d)" % (n, v), lambda s=s, v=v: s.expandtabs(v))
        t("HARD %s.expandtabs(Big(%d))" % (n, v), lambda s=s, v=v: s.expandtabs(Big(v)))
    for v in (10**100, 2**63, -2**63 - 1, 2**63 - 1, -2**63, -10**100):
        t("HARD %s.split(%d)" % (n, v), lambda s=s, v=v: s.split(None, v))
        t("HARD %s.rsplit(%d)" % (n, v), lambda s=s, v=v: s.rsplit(None, v))
        t("HARD %s.replace(%d)" % (n, v), lambda s=s, v=v: s.replace(s[:1], s[:1], v))
# (daybreak2's LIMIT-3C7-2: a very long fill refused without walking it)
t("LIMIT long fill", lambda: "x".ljust(5, "ab" * 10**6))
t("LIMIT long fill str", lambda: "x".center(1, "\U0001f600" * 10**6))
t("LIMIT one astral fill", lambda: "x".center(3, "\U0001f600"))
