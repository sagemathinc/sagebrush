# The object dtype (dtype=object): creation, printing, indexing, the
# comparisons, sort, unique, astype and the shape operations, as NumPy's.
# Arithmetic and the other ufuncs on object arrays aren't in Sagebrush's
# numpy yet: test/numpy-object.test.ts checks that they refuse.
import numpy as np


def show(name, f):
    try:
        r = f()
        print(name, "->", repr(r))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


o = np.array(["setosa", "versicolor", "virginica"], dtype=object)
m = np.array([1, "a", None, 2.5, True], dtype=object)
for name, f in [
    # creation and printing
    ("repr", lambda: o), ("repr-mixed", lambda: m), ("repr-2d", lambda: np.array([["a", 1], [None, 2.5]], dtype=object)),
    ("repr-empty", lambda: np.array([], dtype=object)), ("repr-0d", lambda: np.array(5, dtype=object)), ("str", lambda: str(o)),
    ("str-0d", lambda: str(np.array("x", dtype=object))), ("str-2d", lambda: str(np.array([[1, None], ["b", 2.5]], dtype=object))),
    ("repr-long", lambda: np.array(["x" * 30] * 4, dtype=object)), ("repr-many", lambda: np.array(list(range(1200)), dtype=object)),
    ("repr-nested", lambda: np.array([[1, 2], [3]], dtype=object)), ("repr-dicts", lambda: np.array([{"a": 1}, {"b": 2}])),
    ("asarray-None", lambda: np.asarray(None)), ("array-list-None", lambda: np.array([None, None])),
    ("array-num-None", lambda: np.array([1, None])), ("array-str-None", lambda: np.array(["a", None])),
    ("array-mixed-default", lambda: np.array([1, "a"])), ("array-from-obj", lambda: np.array(o)),
    ("array-from-ints", lambda: np.array(np.arange(3), dtype=object)), ("array-tuple", lambda: np.array((1, "b"), dtype=object)),
    ("asarray-same", lambda: np.asarray(o) is o), ("array-copy", lambda: np.array(o) is o),
    ("full-None", lambda: np.full(3, None)), ("full-obj", lambda: np.full((2, 2), "z", dtype=object)),
    ("empty-obj", lambda: np.empty(2, dtype=object)), ("zeros-obj", lambda: np.zeros(2, dtype=object)), ("ones-obj", lambda: np.ones(2, dtype=object)),
    # the dtype
    ("dtype", lambda: (o.dtype, o.dtype.kind, o.dtype.name, o.dtype.str, o.dtype.char, o.dtype.itemsize)),
    ("dtype-eq", lambda: (o.dtype == object, o.dtype == np.dtype("O"), o.dtype == "O", o.dtype == float, np.dtype(float) == object, o.dtype != object)),
    ("dtype-repr", lambda: (repr(np.dtype(object)), str(np.dtype(object)), np.dtype("O").type is np.object_)),
    ("object_", lambda: (np.object_(5), np.object_("a"), np.object_())),
    # indexing
    ("item", lambda: o[0]), ("type-item", lambda: type(o[0]).__name__), ("slice", lambda: o[1:]), ("neg", lambda: o[-1]),
    ("fancy", lambda: o[np.array([2, 0, 0])]), ("bool-mask", lambda: o[np.array([True, False, True])]), ("take", lambda: o.take([1, 1])),
    ("np-take", lambda: np.take(o, np.array([0, 2, 1]))), ("2d-index", lambda: np.array([[1, "a"], [None, 2]], dtype=object)[1, 0]),
    ("2d-row", lambda: np.array([[1, "a"], [None, 2]], dtype=object)[0]), ("ellipsis", lambda: np.array(7, dtype=object)[...]),
    ("setitem", lambda: (lambda a: (a.__setitem__(0, 42), a)[1])(o.copy())), ("setitem-list", lambda: (lambda a: (a.__setitem__(1, [1, 2]), a)[1])(o.copy())),
    ("setitem-slice", lambda: (lambda a: (a.__setitem__(slice(0, 2), ["p", "q"]), a)[1])(o.copy())), ("setitem-mask", lambda: (lambda a: (a.__setitem__(a == "setosa", None), a)[1])(o.copy())),
    ("fill", lambda: (lambda a: (a.fill("k"), a)[1])(o.copy())), ("tolist", lambda: m.tolist()), ("item-method", lambda: o.item(1)),
    ("len-shape", lambda: (len(o), o.shape, o.ndim, o.size)), ("iter", lambda: list(o)), ("bool-1", lambda: bool(np.array([0], dtype=object))),
    ("float-0d", lambda: float(np.array("2.5", dtype=object))), ("int-0d", lambda: int(np.array(7.9, dtype=object))),
    ("float-1d", lambda: float(np.array(["2.5"], dtype=object))),
    # shape operations
    ("reshape", lambda: m[:4].reshape(2, 2)), ("ravel", lambda: m[:4].reshape(2, 2).ravel()), ("T", lambda: m[:4].reshape(2, 2).T),
    ("flatten", lambda: m[:4].reshape(2, 2).flatten()), ("np-reshape", lambda: np.reshape(m[:4], (4, 1))), ("copy", lambda: o.copy()),
    ("flat", lambda: m[:4].reshape(2, 2).T.flat[:]),
    ("concat", lambda: np.concatenate([o, np.array([7], dtype=object)])), ("concat-mixed", lambda: np.concatenate([o, np.arange(2)])),
    ("concat-str", lambda: np.concatenate([np.array(["u"]), o])), ("concat-none", lambda: np.concatenate([o.reshape(3, 1), o.reshape(3, 1)], axis=None)),
    ("where", lambda: np.where([True, False, True], o, "z")), ("where-num", lambda: np.where([True, False], np.array([1, 2], dtype=object), 0.5)),
    # comparisons
    ("eq-scalar", lambda: o == "versicolor"), ("eq-array", lambda: o == np.array(["setosa", "x", "virginica"], dtype=object)),
    ("eq-str-array", lambda: o == np.array(["setosa", "x", "virginica"])), ("str-array-eq", lambda: np.array(["setosa", "x", "virginica"]) == o),
    ("eq-list", lambda: o == ["setosa", "x", "virginica"]), ("ne", lambda: o != "setosa"), ("eq-mixed", lambda: m == 1),
    ("num-array-eq", lambda: np.array([1, 2, 3]) == np.array([1, "2", 3.0], dtype=object)),
    ("lt", lambda: o < "w"), ("ge", lambda: np.array([1, 5, 3], dtype=object) >= 3), ("lt-mixed", lambda: m < 2), ("eq-0d", lambda: np.array("a", dtype=object) == "a"),
    ("eq-broadcast", lambda: np.array([[1], [2]], dtype=object) == np.array([1, 2], dtype=object)), ("np-equal", lambda: np.equal(o, "setosa")), ("np-less-flip", lambda: np.less("t", o)),
    # sort and unique
    ("sort", lambda: np.sort(o[[2, 0, 1]])), ("argsort", lambda: np.argsort(o[[2, 0, 1]])), ("sort-mixed", lambda: np.sort(m)),
    ("sort-2d", lambda: np.sort(np.array([["b", "a"], ["d", "c"]], dtype=object), axis=0)), ("argsort-ties", lambda: np.argsort(np.array([2, 1, 2, 1, 1], dtype=object))),
    ("unique", lambda: np.unique(o[[2, 0, 2, 1]])), ("unique-inv", lambda: np.unique(o[[2, 0, 2, 1]], return_inverse=True)),
    ("unique-idx", lambda: np.unique(o[[2, 0, 2, 1]], return_index=True, return_counts=True)), ("unique-mixed", lambda: np.unique(m)),
    ("unique-ints", lambda: np.unique(np.array([3, 1, 3], dtype=object))), ("unique-equal-kinds", lambda: np.unique(np.array([1, 1.0, 2], dtype=object))),
    ("isin", lambda: np.isin(o, ["setosa"])), ("searchsorted", lambda: np.searchsorted(o, "versicolor")),
    # astype
    ("astype-obj-from-str", lambda: np.array(["a", "b"]).astype(object)), ("astype-obj-from-int", lambda: np.arange(3).astype(object)),
    ("astype-obj-from-float", lambda: np.array([1.5, 2.0]).astype(object)), ("astype-obj-from-bool", lambda: np.array([True, False]).astype(object)),
    ("types-after", lambda: [type(v).__name__ for v in np.array([1, 2.5, True]).astype(object)] + [type(np.arange(2).astype(object)[0]).__name__]),
    ("astype-str", lambda: o.astype(str)), ("astype-U3", lambda: o.astype("U3")), ("astype-str-mixed", lambda: m.astype(str)),
    ("astype-float", lambda: np.array([1, 2.5, "3"], dtype=object).astype(float)), ("astype-int", lambda: np.array([1, 2.7], dtype=object).astype(int)),
    ("astype-bool", lambda: np.array([0, "", "x", None], dtype=object).astype(bool)), ("astype-int-bad", lambda: o.astype(int)),
    ("astype-object", lambda: o.astype(object) is o), ("asarray-float", lambda: np.asarray(np.array([1, 2], dtype=object), dtype=float)),
    # the scalar type
    ("object_-int", lambda: np.object_(5)), ("object_-str", lambda: np.object_("a")), ("object_-none", lambda: np.object_()),
    ("object_-list", lambda: np.object_([1, 2])), ("object_-tuple", lambda: np.object_((1, 2))), ("object_-array", lambda: np.object_(np.array([1, 2]))),
    ("object_-0d", lambda: np.object_(np.array(3))), ("object_-ragged", lambda: np.object_([[1], [2, 3]])), ("object_-type", lambda: np.dtype(object).type is np.object_),
]:
    show(name, f)


# nesting deeper than NumPy's 64 dimensions: with dtype=object what lies deeper stays an element (a list that
# contains itself included); without a dtype, or as an operand, it is NumPy's error
def nest(d, leaf=0):
    x = leaf
    for _ in range(d):
        x = [x]
    return x


rec = []
rec.append(rec)


def deep(x):
    return (x.shape == (1,) * x.ndim, x.ndim, type(x[(0,) * x.ndim]).__name__)


for name, f in [
    ("deep-recursive", lambda: (deep(np.array(rec, dtype=object)), np.array(rec, dtype=object)[(0,) * 64] is rec)),
    ("deep-63", lambda: deep(np.array(nest(63), dtype=object))), ("deep-64", lambda: deep(np.array(nest(64), dtype=object))),
    ("deep-65", lambda: deep(np.array(nest(65), dtype=object))), ("deep-100", lambda: (deep(np.array(nest(100), dtype=object)), len(repr(np.array(nest(100), dtype=object)[(0,) * 64])))),
    ("deep-pair", lambda: np.array([nest(70), nest(70)], dtype=object).shape[:3]), ("deep-asarray", lambda: np.asarray(rec, dtype=object).ndim),
    ("deep-nodtype-int", lambda: np.array(nest(70))), ("deep-nodtype-recursive", lambda: np.array(rec)), ("deep-nodtype-none", lambda: np.array(nest(70, None))),
    ("deep-nodtype-none-64", lambda: deep(np.array(nest(64, None)))), ("deep-nodtype-str", lambda: np.array(nest(70, "a"))),
    ("deep-eq", lambda: np.array([1, 2], dtype=object) == nest(70)), ("deep-where", lambda: np.where([True], np.array([1], dtype=object), [rec])),
    ("deep-concat", lambda: np.concatenate([np.array([1], dtype=object), [rec]])), ("deep-eq-63", lambda: (np.array([1], dtype=object) == nest(63, None)).ndim),
    # ragged data: an element with an object dtype given, NumPy's inhomogeneous-shape error without one
    ("ragged-none", lambda: np.array([None, [0]])), ("ragged-none-2d", lambda: np.array([[None, 1], [2]])),
    ("ragged-deeper", lambda: np.array([[None, [1]], [2, 3]])), ("ragged-array", lambda: np.array([None, np.arange(2)])),
    ("ragged-eq", lambda: np.array([1, 2], dtype=object) == [None, [1]]), ("ragged-given", lambda: np.array([None, [0]], dtype=object)),
]:
    show(name, f)

# sort's tie order: NumPy's default sort of objects is an introsort (not stable), so equal elements of
# different types (0, 0.0, False) come out in its order; kind="stable" keeps positions
rs = np.random.RandomState(1)
ties = np.array([[0, 0.0, False, 1, 1.0, True, 2, 2.0][i] for i in rs.randint(0, 8, 60)], dtype=object)
kinds = lambda r: "".join(type(v).__name__[0] for v in r.tolist())
for name, f in [
    ("ties-sort", lambda: kinds(np.sort(ties))), ("ties-argsort", lambda: np.argsort(ties).tolist()),
    ("ties-heapsort", lambda: np.argsort(ties, kind="heapsort").tolist()), ("ties-stable", lambda: np.argsort(ties, kind="stable").tolist()),
    ("ties-mergesort", lambda: np.argsort(ties, kind="mergesort").tolist()), ("ties-stable-kw", lambda: np.argsort(ties, stable=True).tolist()),
    ("ties-method", lambda: (lambda c: (c.sort(), kinds(c))[1])(ties.copy())), ("ties-method-stable", lambda: (lambda c: (c.sort(kind="stable"), kinds(c))[1])(ties.copy())),
    ("ties-argsort-method", lambda: ties.argsort().tolist()[:20]), ("ties-2d", lambda: (np.argsort(ties.reshape(6, 10), axis=0).tolist(), np.argsort(ties.reshape(6, 10), axis=1).tolist())),
    ("ties-small", lambda: np.argsort(ties[:16]).tolist()), ("ties-17", lambda: np.argsort(ties[:17]).tolist()),
    ("ties-nan", lambda: kinds(np.sort(np.array([1, float("nan"), 0.5, 1.0, True, float("nan"), 0] * 5, dtype=object)))),
    ("ties-unique", lambda: kinds(np.unique(ties))), ("ties-unique-index", lambda: (lambda u: (kinds(u[0]), u[1].tolist()))(np.unique(ties, return_index=True))),
    ("ties-unique-inverse", lambda: (lambda u: (kinds(u[0]), u[1].tolist()))(np.unique(ties, return_inverse=True))),
    ("ties-unique-counts", lambda: (lambda u: (kinds(u[0]), u[1].tolist()))(np.unique(ties, return_counts=True))),
]:
    show(name, f)


# McIlroy's adversary (values decided as they are compared) drives the sort as deep as it goes, into its
# heapsort fallback; the log of every comparison call shows the same steps as NumPy's
class Adversary:
    __slots__ = ("i",)

    def __init__(self, i):
        self.i = i

    def __lt__(self, o):
        return adversary("lt", self.i, o.i) < 0

    def __gt__(self, o):
        return adversary("gt", self.i, o.i) > 0


def adversary(op, x, y):
    st = state
    st["log"].append((op, x, y))
    val = st["val"]
    if x not in val and y not in val:
        val[x if x == st["cand"] else y] = st["solid"]
        st["solid"] += 1
    if x not in val:
        st["cand"] = x
    elif y not in val:
        st["cand"] = y
    return val.get(x, st["gas"]) - val.get(y, st["gas"])


def adversary_run(n, arg):
    global state
    state = {"gas": n, "val": {}, "cand": None, "solid": 0, "log": []}
    a = np.empty(n, dtype=object)
    for i in range(n):
        a[i] = Adversary(i)
    r = np.argsort(a).tolist() if arg else [k.i for k in np.sort(a).tolist()]
    log = state["log"]
    return len(log), sum((k + 1) * (x * 7 + y * 3 + (op == "gt")) for k, (op, x, y) in enumerate(log)) % 1000003, r[:12]


for n in (20, 300):
    show("adversary-argsort-%d" % n, lambda: adversary_run(n, True))
    show("adversary-sort-%d" % n, lambda: adversary_run(n, False))

# np.full with a sequence fill (broadcast elementwise), count_nonzero by truth, result_type with object,
# Python ints beyond int64 and uint64 (an object array), and setitem with the target's object dtype
cnz = np.empty(7, dtype=object)
cnz[:] = [0, None, 1, "a", "", [], 0.0]
for name, f in [
    ("full-list", lambda: np.full(2, [1, 2], dtype=object)), ("full-2d", lambda: np.full((2, 2), [1, 2], dtype=object)),
    ("full-tuple", lambda: np.full(3, (7,), dtype=object)), ("full-ragged", lambda: np.full(2, [1, [2]], dtype=object)),
    ("full-bad", lambda: np.full(3, [1, 2], dtype=object)), ("full-none-list", lambda: np.full(2, [None, 1])),
    ("full-array", lambda: np.full((2, 2), np.array([1.5, 2]), dtype=object)), ("full-str", lambda: np.full(2, "ab", dtype=object)),
    ("full-nested", lambda: np.full(2, [[1, 2]], dtype=object)), ("full-0d", lambda: np.full((), [1], dtype=object)),
    ("full-recursive", lambda: np.full(1, rec, dtype=object)),
    ("count_nonzero", lambda: np.count_nonzero(cnz)), ("count_nonzero-none", lambda: np.count_nonzero(np.array([None, None], dtype=object))),
    ("count_nonzero-axis", lambda: np.count_nonzero(np.array([[0, 1], [None, "x"]], dtype=object), axis=0)),
    ("count_nonzero-keepdims", lambda: np.count_nonzero(np.array([[0, 1], [None, "x"]], dtype=object), axis=1, keepdims=True)),
    ("result_type-float32", lambda: np.result_type(np.array([1], dtype=object), np.float32)),
    ("result_type-int8", lambda: np.result_type(np.array([1], dtype=object), np.int8)), ("result_type-dtype", lambda: np.result_type(object, np.float64)),
    ("result_type-weak", lambda: np.result_type(np.array([1], dtype=object), 1)), ("result_type-str", lambda: np.result_type(np.array([1], dtype=object), "U3")),
    ("result_type-alone", lambda: np.result_type(np.array([None]))), ("promote_types", lambda: np.promote_types(object, np.float64)),
    ("promote_types-str", lambda: np.promote_types("O", "U2")), ("can_cast-from", lambda: np.can_cast(object, np.float64)), ("can_cast-to", lambda: np.can_cast(np.float64, object)),
    ("bigint", lambda: np.array([2**80, 1])), ("bigint-negative", lambda: np.array([-2**70])), ("bigint-past-uint64", lambda: np.array([2**64])),
    ("bigint-below-int64", lambda: np.array([-2**63 - 1])), ("int64-min", lambda: np.array([-2**63])), ("bigint-float", lambda: np.array([2**80, 1.5])),
    ("bigint-bool", lambda: np.array([2**80, True])), ("bigint-str", lambda: np.array([2**80, "a"])), ("bigint-2d", lambda: np.array([[2**80], [1]])),
    ("bigint-0d", lambda: np.array(2**80)), ("bigint-asarray", lambda: np.asarray([2**100])), ("bigint-complex", lambda: np.array([2**80, 1j])),
    ("bigint-none", lambda: np.array([2**80, None])), ("bigint-eq", lambda: np.array([1, 2]) == 2**80), ("bigint-tolist", lambda: np.array([2**80]).tolist()),
    ("set-mixed", lambda: cnz), ("set-ragged", lambda: (lambda a: (a.__setitem__(slice(None), [[1], [2, 3]]), a)[1])(np.empty(2, dtype=object))),
    ("set-ragged-bad", lambda: (lambda a: (a.__setitem__(slice(None), [[1], [2, 3]]), a)[1])(np.empty(3, dtype=object))),
    ("set-one-list", lambda: (lambda a: (a.__setitem__(0, [1, 2]), a)[1])(np.empty(2, dtype=object))),
    ("set-recursive", lambda: (lambda a: (a.__setitem__(slice(None), rec), a.shape, a[0] is rec)[1:])(np.empty(1, dtype=object))),
    ("set-2d", lambda: (lambda a: (a.__setitem__(slice(None), [[1, [2]], [3, 4]]), a)[1])(np.empty((2, 2), dtype=object))),
]:
    show(name, f)

# arrays inside the data that fit the result's shape, or that stay whole elements (a ragged level at them)
z = np.zeros
for name, f in [
    ("arrays-ragged", lambda: np.array([z(2), z(3)], dtype=object)), ("arrays-ragged-2d", lambda: np.array([z((2, 2)), z((3, 2))], dtype=object)),
    ("arrays-and-scalar", lambda: np.array([z(1), 5], dtype=object)), ("list-and-array", lambda: np.array([[1, 2], z(3)], dtype=object)),
    ("array-and-ragged-list", lambda: np.array([z(2), [1, [2]]], dtype=object)), ("arrays-fit", lambda: np.array([z((2, 2)), z((2, 2))], dtype=object).shape),
    ("array-63-in-list", lambda: (lambda a: (a.__setitem__(Ellipsis, "e"), np.array([a], dtype=object).ndim)[1])(np.empty((1,) * 62 + (2,), dtype=object))),
]:
    show(name, f)


# an element whose repr has several lines (an array): each further line indented to where it began, as NumPy's
def holding(*vs):
    a = np.empty(len(vs), dtype=object)
    for i, v in enumerate(vs):
        a[i] = v
    return a


for name, f in [
    ("repr-arrays", lambda: holding(np.zeros((3, 3)), 1, "a")), ("str-arrays", lambda: str(holding(np.arange(30).reshape(3, 10), np.arange(4)))),
    ("repr-arrays-wrap", lambda: holding(*[np.zeros((2, 2))] * 6)),
]:
    show(name, f)
