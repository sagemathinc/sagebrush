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
