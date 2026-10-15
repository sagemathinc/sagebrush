# Printing options and float formatting: np.set_printoptions (sign,
# floatmode, nanstr/infstr, formatter, override_repr), np.printoptions,
# array2string/array_repr/array_str with their arguments,
# format_float_positional/format_float_scientific (Dragon4: shortest digits,
# or exact ones rounded half to even), isscalar, nextafter, operator.index.
import operator
import numpy as np


def t(label, f):
    try:
        r = f()
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(label, r if isinstance(r, str) else repr(r))


def reset():
    np.set_printoptions(precision=8, threshold=1000, edgeitems=3, linewidth=75, suppress=False, nanstr="nan",
                        infstr="inf", sign="-", floatmode="maxprec", formatter=None, override_repr=None)


f = np.format_float_positional
s = np.format_float_scientific
cases = {
    "p1": lambda: f(5), "p2": lambda: f(np.int64(5)), "p3": lambda: f(1.5, unique=False),
    "p4": lambda: f(1.5, precision=2, min_digits=3), "p5": lambda: f(1.5, precision=3, min_digits=2, unique=False),
    "p6": lambda: f(np.nan, sign=True), "p7": lambda: f(-np.inf, pad_left=6), "p8": lambda: f(np.inf, pad_right=3),
    "p8b": lambda: f(np.inf, sign=True), "p9": lambda: f(1e20, fractional=False, precision=3),
    "p10": lambda: f(123.456, fractional=False, precision=2), "p11": lambda: f(0.000123456, fractional=False, precision=2),
    "p11b": lambda: f(1.5, fractional=False, precision=4, unique=False), "p11c": lambda: f(0.0, fractional=False, precision=3, unique=False),
    "p11d": lambda: f(123.0, fractional=False, precision=5, unique=False), "p11e": lambda: f(0.00123, fractional=False, precision=4, unique=False),
    "p12": lambda: f(-0.0, sign=True), "p13": lambda: f(5.0, sign=True, pad_left=4, pad_right=2),
    "p14": lambda: f(0.1, precision=30, unique=False), "p15": lambda: f(np.float32(0.1)),
    "p16": lambda: f(np.float32(0.1), precision=10, unique=False), "p18": lambda: f(1 / 3, precision=3, trim="-"),
    "p19": lambda: f(2.0, precision=3, unique=False, trim="-"), "p20": lambda: f(2.0, precision=3, unique=False, trim="0"),
    "p21": lambda: f(2.0, precision=3, unique=False, trim="."), "p22": lambda: f(2.5, precision=0, unique=False),
    "p23": lambda: f(3.5, precision=0, unique=False), "p24": lambda: f(2 ** -9, precision=8), "p25": lambda: f(1e-320),
    "p26": lambda: f(1.0, min_digits=2, trim="-"), "p27": lambda: f(1.25, precision=1), "p28": lambda: f(9.96, precision=1),
    "p29": lambda: f(0.05, precision=0, unique=False), "p30": lambda: f(1.0, trim="0"), "p31": lambda: f(1.0, trim="-"),
    "p32": lambda: f(123456789.0, precision=2, unique=False), "p33": lambda: f(5e-324, precision=3), "p34": lambda: f(1.7976931348623157e308),
    "s1": lambda: s(1.5e10), "s2": lambda: s(1.5e10, exp_digits=3), "s3": lambda: s(-0.0), "s4": lambda: s(np.float32(0.1)),
    "s5": lambda: s(0.1, precision=3, unique=False), "s6": lambda: s(1e-300, pad_left=3), "s7": lambda: s(123.456, precision=4, min_digits=4),
    "s8": lambda: s(123.456, precision=2, min_digits=5), "s9": lambda: s(0.125, precision=1, unique=False),
    "s10": lambda: s(1.0, precision=3, unique=False, trim="-"), "s11": lambda: s(1.0, trim="k"), "s12": lambda: s(5, sign=True),
    "s13": lambda: s(np.inf), "s14": lambda: s(1e300, exp_digits=1), "s15": lambda: s(9.999, precision=2, unique=False),
    "s16": lambda: s(1.5, unique=False), "s17": lambda: s(1e-320), "s18": lambda: s(1.5, min_digits=3),
    "s19": lambda: s(2.5e-5, precision=0, unique=False), "s20": lambda: s(6.02214076e23, precision=3), "s21": lambda: s(-1.5, sign=True, pad_left=4),
}
for k, fn in cases.items():
    t(k, fn)

for kw in [dict(sign="x"), dict(floatmode="bad"), dict(precision=1.5), dict(threshold="a")]:
    t("set %r" % kw, lambda: np.set_printoptions(**kw))
    reset()
np.set_printoptions(sign=" ")
print(np.array([1., 2.]), np.array([-1., 2.]), np.array([1, 2]), np.array([-1, 2]), np.array([1 + 1j]), np.array([np.nan, 1.]), repr(np.array([3.])))
np.set_printoptions(sign="+")
print(np.array([1., 2.]), np.array([-1., 2.]), np.array([1, 2]), np.array([np.inf, 1.]), np.array([np.nan]), np.array([1e10, 1.]), np.array([0j]))
np.set_printoptions(sign="-", floatmode="fixed", precision=3)
print(np.array([1., 2.5]), np.array([1e10, 1.]), np.array([0.1 + 2j]), np.array([np.nan, 1.]))
np.set_printoptions(floatmode="unique", precision=3)
print(np.array([1 / 3, 2.5]), np.array([1e-10, 1 / 3]))
np.set_printoptions(floatmode="maxprec_equal", precision=3)
print(np.array([1 / 3, 2.5, 1]), np.array([1.5, 2.25]), np.array([1e10, 1.5e10]))
np.set_printoptions(floatmode="maxprec", precision=8, nanstr="NaN", infstr="Inf")
print(np.array([np.nan, -np.inf, 1.5]), repr(np.array([np.nan])), np.array([np.inf]), np.array([complex(np.nan, np.inf)]))
np.set_printoptions(nanstr="nan", infstr="inf", formatter={"float": lambda x: f"<{x:.2f}>", "int": lambda x: hex(x)})
print(np.array([1.5, 2]), np.array([10, 255]), repr(np.array([1.5])), np.array([1 + 1j]), np.array([True]), np.array(1.5), repr(np.array([1.5, 2], dtype=np.float32)))
np.set_printoptions(formatter={"all": lambda x: "X"})
print(np.array([1.5, 2]), np.array([1, 2]), np.array([True, False]), np.array([1j]), repr(np.array([[1, 2], [3, 4]])))
np.set_printoptions(formatter={"float_kind": lambda x: "%.1f" % x, "complex_kind": lambda x: "C", "int_kind": lambda x: "I", "bool": lambda x: "B"})
print(np.array([1.25]), np.array([1j]), np.array([3]), np.array([True]), np.array([1.5], dtype=np.float32))
np.set_printoptions(formatter={"float": None, "int": lambda x: "i%d" % x})
print(np.array([1.25]), np.array([3]))
np.set_printoptions(formatter=None, override_repr=lambda a: "ARR")
print(repr(np.array([1])), str(np.array([1])), [np.array([2])])
reset()
print(np.get_printoptions())
with np.printoptions(precision=2) as o:
    print(o["precision"], np.array([1 / 3]), sorted(o))
print(np.get_printoptions()["precision"], np.array([1 / 3]))
print(np.array([2 ** -9, 1.0]), np.array([0.125, 0.375]), str(np.array(1 / 3)), repr(np.array(1 / 3)), str(np.array(2.5, dtype=np.float32)))
t("a2s1", lambda: np.array2string(np.array([1 / 3, 2]), precision=3, separator=", ", prefix="xx", suffix=")"))
t("a2s2", lambda: np.array2string(np.array([[1., 2.], [3, 4]]), prefix="abc("))
t("a2s3", lambda: np.array2string(np.array(2.5)))
t("a2s4", lambda: np.array2string(np.array([1., 2.]), sign="+", floatmode="fixed", precision=2))
t("a2s5", lambda: np.array2string(np.arange(2000), threshold=10, edgeitems=2, max_line_width=30))
t("a2s6", lambda: np.array2string(np.array([1.5]), formatter={"float": lambda x: "F"}))
t("a2s7", lambda: np.array2string(np.array([])))
t("a2s10", lambda: np.array2string(np.array([1e-9, 1.]), suppress_small=True))
t("a2s11", lambda: np.array2string(np.arange(12.).reshape(3, 4), separator=", ", max_line_width=20))
t("ar1", lambda: np.array_repr(np.array([1 / 3]), precision=2))
t("ar2", lambda: np.array_str(np.array([1 / 3]), precision=2))
t("ar3", lambda: np.array_repr(np.arange(30.), max_line_width=40))
t("ar4", lambda: np.array_str(np.array([1e-9, 1.]), suppress_small=True))
t("ar5", lambda: np.array_repr(np.array([1, 2], dtype=np.int8), max_line_width=10))
print(np.get_printoptions() == {"edgeitems": 3, "threshold": 1000, "floatmode": "maxprec", "precision": 8, "suppress": False, "linewidth": 75,
                                "nanstr": "nan", "infstr": "inf", "sign": "-", "formatter": None, "legacy": False, "override_repr": None})

print(np.isscalar(1), np.isscalar(1.5), np.isscalar(np.float64(1)), np.isscalar(np.array(1)), np.isscalar([1]), np.isscalar("a"),
      np.isscalar(None), np.isscalar(1j), np.isscalar(b"x"), np.isscalar(np.int8(3)))
print(repr(np.nextafter(1.0, 2.0)), repr(np.nextafter([1.0, 0.0], [0.0, -1.0])), repr(np.nextafter(np.float32(1), np.float32(2))),
      repr(np.nextafter(0.0, 1.0)), repr(np.nextafter(1, 2)), repr(np.nextafter(np.array([[1.0], [2.0]]), [0.0, 3.0])),
      repr(np.nextafter(np.float32(0), np.float32(-1))), repr(np.nextafter(np.inf, 0.0)), repr(np.nextafter(np.nan, 0.0)), repr(np.nextafter(2.0, 2.0)))
for v in [1.5, "3", None, True, 7, np.int64(4)]:
    t("index %r" % (v,), lambda: operator.index(v))
