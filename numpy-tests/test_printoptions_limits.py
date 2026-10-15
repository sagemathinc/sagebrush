# Dragon4's limits and argument checks, the print options' extreme values,
# nextafter's dtype rules and operator.index (review of python-numpy-printing).
import operator
import warnings
import numpy as np

fp, fs = np.format_float_positional, np.format_float_scientific


def digest(s):
    h = 0
    for i, c in enumerate(s):
        h = (h * 31 + ord(c) + i) % (2 ** 61 - 1)
    return h


def show(r):
    if isinstance(r, str) and len(r) > 60:
        return (len(r), r[:24], r[-24:], digest(r))
    return r


def name_of(v):
    return repr(v) if type(v) in (int, float, type(None)) else type(v).__name__ + "()"


def t(label, fn):
    try:
        r = show(fn())
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(label, repr(r))


# -------------------------------------------------- the 16384-char buffer
for x in [1.25, -1.25, 0.0, -0.0, 1e300, -1e300, 5e-324, 2.2250738585072014e-308, 1 / 3, 123456.789]:
    for p in [16379, 16380, 16381, 16382, 16383, 16384, 20000, 2 ** 31 - 1]:
        for trim in "k.0-":
            t("pos %r p=%d %s" % (x, p, trim), lambda: fp(x, precision=p, unique=False, trim=trim))
            t("pos %r p=%d %s sign" % (x, p, trim), lambda: fp(x, precision=p, unique=False, trim=trim, sign=True))
            t("sci %r p=%d %s" % (x, p, trim), lambda: fs(x, precision=p, unique=False, trim=trim))
        t("pos total %r p=%d" % (x, p), lambda: fp(x, precision=p, unique=False, fractional=False))
        t("pos unique %r p=%d" % (x, p), lambda: fp(x, precision=p))
        t("sci unique %r p=%d" % (x, p), lambda: fs(x, precision=p))
for x in [1.25, -1.25, 1e300, 5e-324, 0.1]:
    for n in [16378, 16379, 16380, 16381, 16382, 16383, 16384, 16390]:
        for trim in "k.0-":
            t("pos %r pad_left=%d %s" % (x, n, trim), lambda: fp(x, pad_left=n, trim=trim))
            t("pos %r pad_right=%d %s" % (x, n, trim), lambda: fp(x, pad_right=n, trim=trim))
            t("sci %r pad_left=%d %s" % (x, n, trim), lambda: fs(x, pad_left=n, trim=trim, sign=True))
            t("pos %r min_digits=%d %s" % (x, n, trim), lambda: fp(x, min_digits=n, trim=trim))
            t("sci %r min_digits=%d %s" % (x, n, trim), lambda: fs(x, min_digits=n, trim=trim))
        t("pos total %r min_digits=%d" % (x, n), lambda: fp(x, min_digits=n, fractional=False))
        t("sci %r pad_left=%d p=%d" % (x, n, n), lambda: fs(x, pad_left=n, precision=20, unique=False))
for x in [1.25, 1.25e5, 1.25e-5, 1.25e300, 1.25e-300, 0.0, 5e-324]:
    for ed in range(0, 8):
        t("sci %r exp_digits=%d" % (x, ed), lambda: fs(x, exp_digits=ed))
for x in [float("nan"), float("inf"), -float("inf")]:
    t("pos %r pads" % x, lambda: fp(x, pad_left=5, pad_right=5, sign=True))
    t("sci %r pads" % x, lambda: fs(x, pad_left=5, exp_digits=4, precision=20000, unique=False))
    t("pos %r huge" % x, lambda: fp(x, precision=20000, pad_left=20000, unique=False))

# -------------------------------------------------- argument checks
class IntOverride(int):
    def __index__(self):
        return 9


class RetTrue:
    def __index__(self):
        return True


class RetFloat:
    def __index__(self):
        return 2.5


class Idx:
    def __index__(self):
        return 3

    def __lt__(self, other):
        return False


bad = [-1, 0, 1, True, 1.5, 2.0, -0.5, 2 ** 31 - 1, 2 ** 31, 2 ** 63 - 1, 2 ** 63, 10 ** 100, -10 ** 100, None,
       IntOverride(1), RetFloat(), Idx()]
for name in ["precision", "pad_left", "pad_right", "min_digits"]:
    for v in bad:
        t("pos %s=%s" % (name, name_of(v)), lambda: fp(1.25, **{name: v}))
        t("pos nonunique %s=%s" % (name, name_of(v)), lambda: fp(1.25, unique=False, **{name: v, "precision": v if name == "precision" else 3}))
for name in ["precision", "pad_left", "exp_digits", "min_digits"]:
    for v in bad:
        t("sci %s=%s" % (name, name_of(v)), lambda: fs(1.25, **{name: v}))
t("trim and precision", lambda: fp(1.25, trim="x", precision=1.5))
t("trim and negative", lambda: fp(1.25, trim="x", precision=-1))
t("trim and none", lambda: fp(1.25, trim="x", unique=False))
t("none and float pad", lambda: fp(1.25, unique=False, pad_left=1.5))
t("none and negative pad", lambda: fs(1.25, unique=False, pad_left=-1))
t("fractional and float", lambda: fp(1.25, precision=0.0, fractional=False))
t("min_digits over precision", lambda: fp(1.25, precision=2, min_digits=3))
t("min_digits over precision 0", lambda: fp(1.25, precision=0, min_digits=3))
t("min_digits over precision sci", lambda: fs(1.25, precision=2, min_digits=3))
t("min_digits float over precision", lambda: fs(1.25, precision=2, min_digits=2.5))
t("precision obj 2.5", lambda: fp(1.25, precision=RetFloat()))
t("precision IntOverride", lambda: fp(1.25, precision=IntOverride(1), unique=False))
t("precision RetTrue", lambda: fp(1.25, precision=Idx(), unique=False))

# -------------------------------------------------- print options at their extremes
a = np.array([1.25, -2.5, 1 / 3])
for k, v in [("precision", 16380), ("precision", 20000), ("precision", 2 ** 31 - 1), ("precision", 2 ** 31),
             ("precision", 2 ** 63 - 1), ("precision", 2 ** 63), ("precision", 10 ** 100), ("linewidth", 10 ** 100),
             ("linewidth", -5), ("linewidth", 0), ("edgeitems", 10 ** 100), ("threshold", 10 ** 100),
             ("threshold", 2 ** 64 - 1), ("threshold", -10 ** 100), ("threshold", 2 ** 63)]:
    def go():
        with np.printoptions(**{k: v}):
            return "|".join([repr(np.arange(5)), str(np.array([True, False])), str(np.array([np.nan, np.inf])),
                             str(np.array([], dtype=float)), repr(a)])
    t("%s=%r" % (k, v), go)
    for mode in ["fixed", "unique", "maxprec_equal"]:
        def go2():
            with np.printoptions(floatmode=mode, **{k: v}):
                return repr(a)
        t("%s=%r %s" % (k, v, mode), go2)
for p in [16379, 16380, 16381, 20000]:
    for arr in [np.array([1.25, 2.5]), np.array([1e-20, 1.0]), np.array([-1e300, 1.0]), np.array([1 + 2j])]:
        for mode in ["fixed", "maxprec", "maxprec_equal", "unique"]:
            t("array2string p=%d %s %r" % (p, mode, arr[0]), lambda: np.array2string(arr, precision=p, floatmode=mode))
            t("array2string p=%d %s sign %r" % (p, mode, arr[0]), lambda: np.array2string(arr, precision=p, floatmode=mode, sign="+"))

# -------------------------------------------------- edgeitems <= 0
shapes = [(10,), (4, 6), (3, 1, 4), (2, 3, 5), (1,), (2,), (7, 1)]
for e in [-4, -3, -1, 0, 1, 2]:
    for th in [0, 5]:
        np.set_printoptions(edgeitems=e, threshold=th)
        for sh in shapes:
            n = int(np.prod(sh))
            x = np.arange(n).reshape(sh)
            t("edge %d th %d %r int" % (e, th, sh), lambda: (str(x), repr(x)))
            t("edge %d th %d %r float" % (e, th, sh), lambda: (str(x / 7), repr(x * 1e5 / 7)))
            t("edge %d th %d %r neg" % (e, th, sh), lambda: str(x - n // 2))
            t("edge %d th %d %r bool" % (e, th, sh), lambda: str(x % 3 == 0))
            t("edge %d th %d %r complex" % (e, th, sh), lambda: str(x / 3 + 1j * (n - x)))
        calls = []

        def fmt(v):
            calls.append(int(v))
            return "<%d>" % v
        t("edge %d th %d formatter" % (e, th), lambda: (np.array2string(np.arange(12).reshape(3, 4), formatter={"int": fmt}), calls))
        t("edge %d th %d strided" % (e, th), lambda: str(np.arange(40.)[::3] ** 2))
np.set_printoptions(edgeitems=3, threshold=1000)

# -------------------------------------------------- nextafter (NumPy 2 weak Python scalars)
f32a = np.array([1, -1, 0], dtype=np.float32)
cases = [(np.float32(1), 2.0), (2.0, np.float32(1)), (np.float32(1), 2), (2, np.float32(1)), (f32a, 2.0), (2.0, f32a),
         (f32a, 0), (np.int16(1), np.float32(2)), (np.int8(1), np.float32(2)), (np.float32(2), np.int8(1)),
         (np.int16(1), 2), (2, np.int16(1)), (np.uint16(1), 2), (np.int32(1), 2), (np.uint32(1), 2), (np.int64(1), 2.0),
         (np.int16(1), 2.0), (1, 2), (1.0, 2), (True, 2.0), (2.0, True), (True, 2), (np.bool(True), 2.5),
         (np.float64(1), np.float32(2)), (np.float32(1), np.float64(2)), (np.array([1, 2], np.int16), np.float32(3)),
         (np.array([1, 2], np.int16), np.array([3], np.uint16)), (np.array([1], np.int16), np.array([3], np.int32)),
         ([1, 2], 2.0), ([1.0], np.float32(2)), (np.float32(0), -1.0), (np.float32(np.inf), 0.0),
         (np.float32(3.4028235e38), np.inf), (np.float32(np.nan), 1.0), (1j, 2), (np.complex64(1), 2.0),
         (np.float32(1), 1j), (np.int16(1), 70000), (np.int32(1), 2 ** 40)]
for c in cases:
    t("nextafter %r" % (c,), lambda: (lambda r: (repr(r), str(r.dtype)))(np.nextafter(*c)))

# -------------------------------------------------- operator.index
class RetSub:
    def __index__(self):
        return IntOverride(4)


class NoIndex:
    pass


class RetNpBool:
    def __index__(self):
        return np.True_


for v in [IntOverride(3), True, False, RetTrue(), RetFloat(), RetSub(), 5, -2 ** 70, 2.0, NoIndex(), "3", None,
          np.True_, np.int8(-3), np.uint64(2 ** 64 - 1), RetNpBool()]:
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        t("index %s" % type(v).__name__, lambda: (lambda r: (r, type(r).__name__))(operator.index(v)))
    print("   warnings:", [(x.category.__name__, str(x.message)) for x in w])
t("printoptions precision IntOverride", lambda: (np.set_printoptions(precision=IntOverride(2)), np.get_printoptions()["precision"],
                                                  type(np.get_printoptions()["precision"]).__name__)[1:])
t("printoptions precision RetFloat", lambda: np.set_printoptions(precision=RetFloat()))
t("printoptions precision np.True_", lambda: np.set_printoptions(precision=np.True_))
t("printoptions precision 2.0", lambda: np.set_printoptions(precision=2.0))
np.set_printoptions(precision=8)

# -------------------------------------------------- argument conversion order and the value's type
for kw in [dict(trim="x", pad_left=1.5), dict(trim="x", precision=1.5), dict(trim="x", unique=False),
           dict(trim="x", min_digits=1.5), dict(trim=5), dict(trim=None), dict(trim=b"k"), dict(trim="ab" * 60),
           dict(unique=None), dict(unique=1.5), dict(unique=""), dict(unique=[]), dict(unique=2), dict(unique=-1, precision=2),
           dict(unique=2 ** 31), dict(unique=2 ** 70), dict(sign=2), dict(sign=None), dict(sign=0.0), dict(fractional=-1, precision=2),
           dict(fractional="", precision=0), dict(fractional=None, precision=2), dict(unique=np.int8(0), precision=1),
           dict(pad_left=-2 ** 31 - 1), dict(pad_left=2 ** 40), dict(unique=np.bool(False), precision=1),
           dict(sign=np.True_), dict(precision=np.True_), dict(pad_left=np.int8(3)), dict(min_digits=np.uint16(3))]:
    t("pos %r" % sorted(kw.items()), lambda: fp(1.25, **kw))
    kw2 = {k: v for k, v in kw.items() if k != "fractional"}
    t("sci %r" % sorted(kw2.items()), lambda: fs(1.25, **kw2))


class F:
    def __float__(self):
        return 2.5


class I:
    def __index__(self):
        return 7


from fractions import Fraction
for x in [Fraction(1, 3), np.int64(3), np.uint64(2 ** 64 - 1), np.int8(-3), np.uint8(200), np.bool(True), F(), I(),
          np.float32(0.1), np.array(0.1, np.float32), np.array(True), np.array(3), np.float64(0.1), 3, True, 10 ** 400,
          None, [1.5], (1.5,), "1.5", 1j, np.array([1.5]), np.array([[1.5]]), np.array([])]:
    t("x %s" % name_of(x), lambda: (fp(x), fs(x), fp(x, precision=20, unique=False)))
t("x before args", lambda: fp("a", precision=1.5))
t("x before trim", lambda: fp("a", trim="x"))
