# String arrays (dtype '<Un'): creation, astype to and from numbers, shape and indexing,
# comparisons, sort, argsort, unique, where, isin, full and the *_like functions, and printing,
# each printed as NumPy prints it. (test_string_walk.py checks every other operation is NumPy's
# or refused.)
import numpy as np

n = 0


def raised(f):
    try:
        f()
    except Exception as e:
        return e


def t(f):
    global n
    n += 1
    try:
        r = f()
        print("%03d" % n, repr(r))
    except Exception as e:
        print("%03d ERR %s: %s" % (n, type(e).__name__, e))


# dtypes
d = np.dtype("U3")
t(lambda: (d, str(d), d.name, d.kind, d.char, d.itemsize, d.str, d.type))
t(lambda: (np.dtype(str), np.dtype("U"), np.dtype("<U5"), np.dtype("=U2"), np.dtype("|U2"), np.dtype("U 3"), np.dtype(np.str_)))
t(lambda: (str(np.dtype("U")), np.dtype("U").name, np.dtype("U").itemsize))
t(lambda: (d == "U3", d == "<U3", d == np.dtype("U3"), d == "U4", d == str, np.dtype(str) == str, d != "U3", d == "f8", np.dtype("f8") == d))
t(lambda: hash(np.dtype("U3")) == hash(np.dtype("<U3")))
t(lambda: (np.issubdtype(d, np.str_), np.issubdtype(d, np.character), np.issubdtype(d, np.flexible), np.issubdtype(d, np.generic), np.issubdtype(d, np.number), np.issubdtype(np.float64, np.str_)))
t(lambda: np.dtype("u3"))
t(lambda: np.dtype("U-1"))
t(lambda: np.dtype("U536870912"))
t(lambda: np.dtype("U536870911").itemsize)

# np.str_
s = np.str_("ab")
t(lambda: (s, str(s), s + "c", type(s + "c"), s == "ab", len(s), s.dtype, s.item(), type(s.item()), isinstance(s, str)))
t(lambda: (np.str_("").dtype, np.str_("\U0001F600").dtype))
t(lambda: (int(np.str_("12")), float(np.str_("2.5")), complex(np.str_("1+2j"))))
t(lambda: int(np.str_("1.5")))
t(lambda: float(np.str_("x")))

# creation
u = np.array(["a", "bc"])
t(lambda: u)
t(lambda: (u.dtype, u.shape, u.ndim, u.size, u.itemsize, u.nbytes, u.strides))
t(lambda: np.array([["a", "bc"], ["def", "g"]]))
t(lambda: np.array([[["a"], ["b"]], [["c"], ["dd"]]]))
t(lambda: np.array("abc"))
t(lambda: np.array([], dtype=str))
t(lambda: np.array([""]))
t(lambda: np.array(["a", 1]))
t(lambda: np.array(["a", 1.5]))
t(lambda: np.array(["a", True]))
t(lambda: np.array(["a", 1 + 2j]))
t(lambda: np.array(["a", np.float32(0.1)]))
t(lambda: np.array(["a", np.int8(5)]))
t(lambda: np.array([np.str_("x"), "yy"]))
t(lambda: np.array([1, 2], dtype=str))
t(lambda: np.array([1.5, 2, 1e-5, 1e20], dtype=str))
t(lambda: np.array([True, False], dtype="U"))
t(lambda: np.array([1.5, 2], dtype="U2"))
t(lambda: np.array(["abc", "de"], dtype="U2"))
t(lambda: np.array(["abc"], dtype="U5"))
t(lambda: np.array(["a\x00", "\x00b", "c\x00\x00"]))
t(lambda: np.array(["\U0001F600x", "é"]))
t(lambda: np.array(["\U0001F600\U0001F601"], dtype="U1"))
t(lambda: np.array([np.array(["a", "bb"]), np.array(["c", "d"])]))
t(lambda: np.array([np.array(["a"]), np.array([1])]))
t(lambda: np.array(["a", ["b"]]))
t(lambda: np.array(["1", "2"], dtype=int))
t(lambda: np.array(["1.5", "2"], dtype=float))
t(lambda: np.array([np.str_("abc")], dtype=float))
t(lambda: np.array([np.str_("2.5")], dtype=float))
t(lambda: np.array(np.array(["a", "bc"]), dtype="U1"))
t(lambda: np.array(np.array([1, 22]), dtype=str))
t(lambda: np.array(u, ndmin=3).shape)
t(lambda: np.asarray(u) is u)
t(lambda: np.asarray(u, dtype="U2") is u)
t(lambda: np.asarray(["x", "yz"]))
t(lambda: np.asarray([1, 2], dtype="U"))
t(lambda: np.array(u) is u)

# full, zeros, ones, empty and the *_like functions
t(lambda: np.zeros(2, dtype="U2"))
t(lambda: np.zeros((2, 2), dtype=str))
t(lambda: np.empty(3, dtype="U"))
t(lambda: np.ones(2, dtype="U3"))
t(lambda: np.ones(2, dtype=str))
t(lambda: np.full(2, "ab"))
t(lambda: np.full((2, 2), "x", dtype="U3"))
t(lambda: np.full(2, 5, dtype="U3"))
t(lambda: np.full(2, 5, dtype=str))
t(lambda: np.full(3, np.array(["p", "qq", "r"])))
t(lambda: np.full(2, "abc", dtype="U2"))
t(lambda: np.full_like(u, "xyz"))
t(lambda: np.full_like(u, 7))
t(lambda: np.full_like(np.array([1, 2]), "5"))
t(lambda: np.empty_like(u))
t(lambda: np.zeros_like(u))
t(lambda: np.ones_like(u))
t(lambda: np.zeros_like(u, dtype="U5"))
t(lambda: np.full_like(u, "q", shape=(2, 3)))

# astype
t(lambda: np.array([1, -22]).astype(str))
for dt in ["bool", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "complex64", "complex128"]:
    t(lambda: np.zeros(1, dt).astype(str).dtype)
t(lambda: np.array([0.1 + 0.2, 1e16, 1e-7, -0.0, np.nan, np.inf, -np.inf, 123456789.0, 1e22, 0.5]).astype(str))
t(lambda: np.array([0.1, 1e16, 1e-7, 3.4e38, 16777216.0, 1e6, 0.5, 2.5e-5], np.float32).astype(str))
t(lambda: np.array([1j, -1 - 0j, 1.5 + 2.5j, complex(np.nan, 1), complex(1, -np.inf), 0j]).astype(str))
t(lambda: np.array([0.1 + 0.2j, 1 + 2j, 1e7 + 1j, 1e-5 + 0.5j, 123456.7, 1e16 - 2j, complex(0, -0.0), complex(-0.0, 1), complex(1, np.nan)], np.complex64).astype(str))
t(lambda: np.array([2 ** 53, -5, 0]).astype(str))
t(lambda: np.array([255, 0], np.uint8).astype("U"))
t(lambda: np.array([True, False]).astype(str))
t(lambda: np.array([123, 45]).astype("U2"))
t(lambda: np.array([[1.5, 2.25]]).astype("U3"))
t(lambda: np.array(["1", " 2 ", "-3", "+4", "1_000"]).astype(int))
t(lambda: np.array(["1.5"]).astype(int))
t(lambda: np.array(["x"]).astype(int))
t(lambda: np.array(["1.5", "inf", "nan", "1e3", " 2 ", "-0", "1_0.5"]).astype(float))
t(lambda: np.array(["x"]).astype(float))
t(lambda: np.array(["0.1"]).astype(np.float32))
t(lambda: np.array(["", "a", "False", "0", " "]).astype(bool))
t(lambda: np.array(["1+2j", "3", "-1j"]).astype(complex))
t(lambda: np.array(["1+2j"]).astype(np.complex64))
t(lambda: np.array(["x"]).astype(complex))
t(lambda: np.array(["300"]).astype(np.uint8))
t(lambda: np.array(["-1"]).astype(np.uint8))
t(lambda: np.array(["127", "-128"]).astype(np.int8))
t(lambda: np.array(["128"]).astype(np.int8))
t(lambda: np.array(["99999999999999999999"]).astype(int))
t(lambda: np.array(["9007199254740992"]).astype(np.uint64))
t(lambda: np.array(["ab", "c"]).astype("U1"))
t(lambda: np.array(["ab", "c"]).astype("U5"))
t(lambda: np.array(["ab", "c"]).astype(str))
t(lambda: np.array([["1", "2"], ["3", "4"]]).T.astype(int))

# shape operations
m = np.array([["a", "bb", "c"], ["dd", "e", "fff"]])
t(lambda: m.T)
t(lambda: m.reshape(3, 2))
t(lambda: m.reshape(-1))
t(lambda: m.T.reshape(6))
t(lambda: m.ravel())
t(lambda: m.T.ravel())
t(lambda: m.flatten())
t(lambda: m.transpose(1, 0))
t(lambda: m.swapaxes(0, 1))
t(lambda: np.transpose(m))
t(lambda: np.reshape(m, (6, 1)))
t(lambda: np.ravel(m.T))
t(lambda: np.squeeze(np.array([["a"], ["b"]])))
t(lambda: np.expand_dims(u, 0))
t(lambda: np.atleast_2d(u))
t(lambda: np.broadcast_to(u, (2, 2)))


def bwrite():
    b = np.broadcast_to(np.array(["a", "b", "c"]), (2, 3))
    try:
        b[0] = "z"
    except ValueError as e:
        print("   ", e)
    return b


t(bwrite)
t(lambda: np.moveaxis(m, 0, 1))
t(lambda: m.view())
t(lambda: m.copy())
t(lambda: m.T.copy().flags["C_CONTIGUOUS"])
t(lambda: (m.T.base is m, m.reshape(6).base is m, m.flags["C_CONTIGUOUS"], m.T.flags["F_CONTIGUOUS"]))
t(lambda: list(m.flat))
t(lambda: np.concatenate([u, np.array(["xyz"])]))
t(lambda: np.concatenate([m, m], axis=1))
t(lambda: np.concatenate([m, m], axis=None))
t(lambda: np.concatenate([u, ["q"]]))
t(lambda: np.concatenate([u, np.array([1])]))
t(lambda: np.stack([u, u]))
t(lambda: np.vstack([u, u]))
t(lambda: np.hstack([u, u]))

def _shp():
    v = m.copy()
    v.shape = (3, 2)
    return v
t(_shp)

# indexing
t(lambda: (u[0], u[-1], type(u[0])))
t(lambda: m[1, 2])
t(lambda: m[1])
t(lambda: m[:, 1])
t(lambda: m[::-1, ::2])
t(lambda: m[[1, 0, 1]])
t(lambda: m[[0, 1], [2, 0]])
t(lambda: m[m > "c"])
t(lambda: m[None, 0])
t(lambda: m[..., 0])
t(lambda: np.array("x")[()])
t(lambda: np.array("x")[...])
t(lambda: u[2])
t(lambda: u["a"])
t(lambda: u.item(1))
t(lambda: np.array(["x"]).item())
t(lambda: m.item(1, 2))
t(lambda: u.item())
t(lambda: m.tolist())
t(lambda: np.array("z").tolist())
t(lambda: list(u))
t(lambda: [list(r) for r in m])
t(lambda: len(m))
t(lambda: "bb" in m)
t(lambda: "q" in m)
t(lambda: np.take(u, 1))
t(lambda: np.take(m, [0, 2], axis=1))
# item: each index bounded and made non-negative by its own axis, the tuple form (grader's F1, probe2 I1-I7)
q = np.array([["a", "b"], ["c", "d"]])
for c in [(0, 3), (1, -1), (-1, 0), (0, -1), (2, 0), (-1,), ((1, 0),), ((1,),), (0, 0, 0), (1.5,), (4,), (-5,), ()]:
    t(lambda: q.item(*c))
t(lambda: np.array(["a", "b"]).item(-3))
t(lambda: q.T.item(0, 1))
t(lambda: q[:, ::-1].item(1))
t(lambda: np.array("z").item(()))


def setv(a, k, v):
    a = a.copy()
    a[k] = v
    return a


t(lambda: setv(u, 0, "xyz"))
t(lambda: setv(u, 0, 7))
t(lambda: setv(u, 1, 2.5))
t(lambda: setv(u, slice(None), ["p", "qqq"]))
t(lambda: setv(u, slice(None), [1.5, True]))
t(lambda: setv(m, 0, "z"))
t(lambda: setv(m, (slice(None), 1), np.array(["1", "2"])))
t(lambda: setv(m, m == "e", "E"))
t(lambda: setv(m, [0, 1], np.array([["x"], ["y"]])))
t(lambda: setv(np.array(["aaaaaa", "b"]), 0, np.float32(0.1)))
t(lambda: setv(u, Ellipsis, "w"))


def shift():
    a = np.array(["a", "b", "c", "d"])
    a[1:] = a[:-1]
    return a


t(shift)


def fill(v):
    a = m.copy()
    a.fill(v)
    return a


t(lambda: fill("xy"))
t(lambda: fill(12345))


def ro():
    a = u.copy()
    a.flags.writeable = False
    a[0] = "q"


t(ro)
t(lambda: bool(np.array([""])))
t(lambda: bool(np.array(["a"])))
t(lambda: bool(u))

# comparisons
t(lambda: u == "a")
t(lambda: u != "a")
t(lambda: u < "b")
t(lambda: u <= "bc")
t(lambda: u > "a")
t(lambda: u >= "bc")
t(lambda: "a" < u)
t(lambda: "bc" == u)
t(lambda: u == np.array(["a", "x"]))
t(lambda: m == np.array(["a", "e", "z"]))
t(lambda: m[:, :1] < m[0])
t(lambda: u == ["a", "a"])
t(lambda: u == [1, "a"])
t(lambda: u == 1)
t(lambda: u != 1)
t(lambda: u == None)
t(lambda: u == np.array([1, 2]))
t(lambda: u == 1.5)
t(lambda: isinstance(raised(lambda: u < 1), TypeError))
t(lambda: isinstance(raised(lambda: u < None), TypeError))
t(lambda: np.array("abc") == "abc")
t(lambda: np.array("abc") < "b")
t(lambda: np.array(["a", "\U0001F600", "￿", "", "퟿"]) < "\U0001F600")
t(lambda: np.array(["ab", "a", "abc", ""]) < "ab")
# (lone surrogates are code points of their own, a valid pair one code point: daybreak3's case first)
sur = np.array(["\ud800", "\ue000"])
t(lambda: (sur < "\ue000", np.argsort(sur), np.unique(sur)))
# (Sagebrush's strings can't hold a high surrogate followed by a low one other than as the
# character they make: the runtime refuses it; real astral characters are written with \U)
sw = np.array(["\ue000", "\ud800", "\U0001F600", "\ud83d", "\ud83dx", "\udc00", "\U0001F600a", "a\ud800", "a", "\uffff", "\ud7ff", "\U0001F400"])
t(lambda: (np.sort(sw), np.argsort(sw), np.unique(sw), sw < "\ud83d", sw >= "\U0001F600", [len(x) for x in sw]))
sv = np.array(["\ud800y", "\ud800x", "\U00010000", "\ud800", "\ud800\ue000", "\U000103ff", "\ud801", "\udc00\ud800"])
t(lambda: (np.sort(sv), np.argsort(sv), sv < "\ud800y", sv == "\ud800", np.unique(sv)))
t(lambda: np.array(["\U0001F600\ud800"], dtype="U2"))
t(lambda: np.array(["\ud800\U0001F600x"], dtype="U2"))
t(lambda: np.array(["a\x00"]) == "a")
t(lambda: np.equal(u, "a"))
t(lambda: np.less(u, ["b", "b"]))

# sort, argsort, unique, where, isin
w = np.array(["b", "a", "\U0001F600", "￿", "ab", "", "a", "B"])
t(lambda: np.sort(w))
t(lambda: np.argsort(w))
t(lambda: np.sort(m, axis=0))
t(lambda: np.sort(m, axis=None))
t(lambda: np.argsort(m))
t(lambda: np.argsort(m, axis=0))
t(lambda: np.argsort(m, axis=None))


def msort():
    a = w.copy()
    a.sort()
    return a


t(msort)
t(lambda: w.argsort())
t(lambda: np.unique(w))
t(lambda: np.unique(m))
t(lambda: np.unique(["b", "a", "b"]))
t(lambda: np.unique(w, return_index=True, return_inverse=True, return_counts=True))
t(lambda: np.unique(np.array([], dtype="U3")))
t(lambda: np.where(u == "a", u, "zzz"))
t(lambda: np.where([True, False], "x", "yy"))
t(lambda: np.where(m > "c", m, np.array(["0", "1", "2"])))
t(lambda: np.where([True, False], ["a", "b"], ["cc", "d"]))
t(lambda: isinstance(raised(lambda: np.where([True, False], u, 5)), TypeError))
t(lambda: isinstance(raised(lambda: np.concatenate([u, 1], axis=None)), TypeError))
t(lambda: isinstance(raised(lambda: np.union1d(u, 2)), TypeError))
t(lambda: np.union1d(u, ["zz", "a"]))
t(lambda: np.equal("a", u))
t(lambda: np.greater("b", u))
t(lambda: np.where(u == "a"))
t(lambda: np.isin(u, ["a"]))
t(lambda: np.isin(m, ["a", "e", "q"]))
t(lambda: np.isin(m, ["a"], invert=True))
t(lambda: np.isin(u, [1]))
t(lambda: np.isin(["a", "x"], u))
t(lambda: np.searchsorted(np.array(["a", "c", "e"]), "d"))
t(lambda: np.searchsorted(np.array(["a", "c", "e"]), ["b", "e"], side="right"))

# printing
t(lambda: np.array(["it's", 'a"b', "x\ny", "\t", "\\", "é\U0001F600"]))
t(lambda: np.array(["word%d" % i for i in range(30)]))
t(lambda: np.array([["w%d" % (i * 7 + j) for j in range(7)] for i in range(5)]))
t(lambda: np.array(["w%d" % i for i in range(2000)]))
t(lambda: np.array([["a"] * 3] * 400))
t(lambda: np.zeros((2, 0), dtype="U2"))
t(lambda: np.zeros((0,), dtype="U3"))
t(lambda: np.array(["a" * 100, "b"]))
print(u)
print(m)
print(np.array("abc"))
print(np.array([], dtype=str))
print(np.array(["a" * 40, "b" * 40]))
t(lambda: str(np.array(["x y", "z"])))
t(lambda: repr(np.array(["x"]).astype("U10")))
t(lambda: np.array2string(m))
t(lambda: np.array2string(u, separator=", "))
t(lambda: np.array_repr(u))
t(lambda: np.array_str(m))
t(lambda: f"{np.array('ab')}")
np.set_printoptions(formatter={"numpystr": lambda x: "<" + x + ">"})
t(lambda: u)
np.set_printoptions(formatter={"all": lambda x: "*"})
t(lambda: u)
np.set_printoptions(formatter={"str_kind": lambda x: x.upper()})
t(lambda: m)
np.set_printoptions(formatter=None)
np.set_printoptions(threshold=3, edgeitems=1)
t(lambda: np.array(["a", "b", "c", "d"]))
np.set_printoptions(threshold=1000, edgeitems=3, linewidth=20)
t(lambda: np.array(["aaaa", "bbbb", "cccc", "dddd", "eeee"]))
np.set_printoptions(linewidth=75)
