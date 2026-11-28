# A list axis refused where NumPy refuses it (its C reductions, sort, argsort, squeeze, diff, concatenate, a ufunc's
# reduce, the array methods; average takes one), and prod's where= (#1944): its mask by NumPy's safe rule, broadcast to
# the operand without stretching it, the masked elements taking no part (a complex product folded as NumPy folds it).
import numpy as np


def show(tag, f):
    try:
        r = f()
        a = np.asarray(r)
        print(tag, type(r).__name__, a.dtype, a.shape,
              [float(v).hex() if a.dtype.kind == "f" else (repr(complex(v)) if a.dtype.kind == "c" else v)
               for v in a.ravel().tolist()])
    except Exception as e:
        # (the base class: NumPy's AxisError isn't Sagebrush's yet)
        base = next(c for c in (TypeError, IndexError, ValueError, Exception) if isinstance(e, c))
        print(tag, "!!", base.__name__, e)


x = np.arange(1.0, 7.0).reshape(2, 3)
for name in ("sum", "prod", "mean", "std", "var", "max", "min", "amax", "amin", "any", "all", "ptp", "argmax",
             "argmin", "cumsum", "cumprod", "nansum", "nanprod", "nanmean", "nanstd", "nanvar", "nanmax", "nanmin",
             "count_nonzero", "sort", "argsort", "diff", "trapezoid"):
    f = getattr(np, name)
    show(f"{name} axis=[0]", lambda: f(x, axis=[0]))
    show(f"{name} axis=[0, 1]", lambda: f(x, axis=[0, 1]))
    show(f"{name} axis=(0,)", lambda: f(x, axis=(0,)))
show("squeeze axis=[0]", lambda: np.squeeze(np.ones((1, 3)), axis=[0]))
show("squeeze axis=(0,)", lambda: np.squeeze(np.ones((1, 3)), axis=(0,)))
show("concatenate axis=[0]", lambda: np.concatenate([x, x], axis=[0]))
show("concatenate axis=(0,)", lambda: np.concatenate([x, x], axis=(0,)))
show("concatenate axis=np.int64(1)", lambda: np.concatenate([x, x], axis=np.int64(1)))
show("sort axis=np.int64(0)", lambda: np.sort(x, axis=np.int64(0)))
show("sort axis=1.5", lambda: np.sort(x, axis=1.5))
show("argsort axis=1.5", lambda: np.argsort(x, axis=1.5))
show("concatenate axis=1.5", lambda: np.concatenate([x, x], axis=1.5))
show("diff axis=1.5", lambda: np.diff(x, axis=1.5))
show("diff axis=np.True_", lambda: np.diff(x, axis=np.True_))
show("diff axis=True", lambda: np.diff(x, axis=True))
show("diff axis=np.int64(0)", lambda: np.diff(x, axis=np.int64(0)))
show("x.sum axis=[0]", lambda: x.sum(axis=[0]))
show("x.mean axis=[0]", lambda: x.mean(axis=[0]))
show("x.max axis=[1]", lambda: x.max(axis=[1]))
show("x.sort axis=[0]", lambda: np.sort(x.copy(), axis=[0]))
show("add.reduce axis=[0]", lambda: np.add.reduce(x, axis=[0]))
show("average axis=[0]", lambda: np.average(x, axis=[0]))
show("average axis=[1], weights", lambda: np.average(x, axis=[1], weights=np.ones((2, 3))))
w = np.array([[True, False, True], [False, True, True]])
xi = np.arange(1, 7).reshape(2, 3)
xc = x + 1j * x[::-1, ::-1]
for tag, arr in (("float", x), ("int", xi), ("complex", xc), ("float32", x.astype(np.float32))):
    show(f"prod where {tag}", lambda: np.prod(arr, where=w))
    show(f"prod where {tag} axis 0", lambda: np.prod(arr, axis=0, where=w))
    show(f"prod where {tag} axis 1", lambda: np.prod(arr, axis=1, where=w))
    show(f"prod where {tag} keepdims", lambda: np.prod(arr, axis=1, where=w, keepdims=True))
    show(f"prod where {tag} initial", lambda: np.prod(arr, axis=1, where=w, initial=10))
    show(f"prod where {tag} all False", lambda: np.prod(arr, axis=1, where=False))
    show(f"{tag}.prod where", lambda: arr.prod(axis=0, where=w))
show("prod where broadcast row", lambda: np.prod(x, axis=1, where=np.array([True, False, True])))
show("prod where (1, 3)", lambda: np.prod(x, axis=1, where=np.array([[True, False, True]])))
show("prod where list", lambda: np.prod(x, axis=1, where=[True, False, True]))
show("prod where None", lambda: np.prod(x, axis=1, where=None))
show("prod where dtype float32", lambda: np.prod(xi, axis=1, where=w, dtype=np.float32))
show("prod where dtype complex", lambda: np.prod(x, axis=1, where=w, dtype=complex))
show("prod where (2,)", lambda: np.prod(x, axis=1, where=np.array([True, False])))
show("prod where (2, 2, 3)", lambda: np.prod(x, axis=1, where=np.ones((2, 2, 3), bool)))
show("prod where int array", lambda: np.prod(x, axis=1, where=np.array([1, 0, 1])))
show("prod where float array", lambda: np.prod(x, axis=1, where=np.array([1.0, 0.0, 1.0])))
show("prod where tuple axis", lambda: np.prod(np.arange(1.0, 25.0).reshape(2, 3, 4), axis=(0, 2),
                                              where=np.arange(24).reshape(2, 3, 4) % 3 != 0))
z = np.array([complex(-0.0, -0.0), complex(2.0, -0.0), complex(np.inf, 1.0), complex(1.0, np.inf)])
show("prod where complex zeros and inf", lambda: np.prod(z, where=np.array([True, True, False, False])))
show("prod where complex inf kept", lambda: np.prod(z, where=np.array([False, True, True, False])))
show("prod where complex signed zero", lambda: np.prod(np.array([complex(3.0, -0.0), complex(1.0, 2.0)]),
                                                       where=np.array([True, False])))
show("sum where (2,)", lambda: np.sum(x, axis=1, where=np.array([True, False])))
show("sum where int array", lambda: np.sum(x, axis=1, where=np.array([1, 0, 1])))
show("sum where (2, 2, 3)", lambda: np.sum(x, axis=1, where=np.ones((2, 2, 3), bool)))
show("sum where", lambda: np.sum(x, axis=1, where=w))
# (an axis checked as the unmasked product checks it; masks converted as NumPy converts them; 0-d and empty operands)
c2 = np.ones((2, 3), complex) * (1 + 1j)
show("prod where complex axis 2", lambda: np.prod(c2, axis=2, where=False))
show("prod where complex axis -3", lambda: np.prod(c2, axis=-3, where=np.ones((2, 3), bool)))
show("prod where complex axis (0, 0)", lambda: np.prod(c2, axis=(0, 0), where=np.ones((2, 3), bool)))
show("prod where complex axis [0]", lambda: np.prod(c2, axis=[0], where=False))
show("prod where complex axis ()", lambda: np.prod(c2, axis=(), where=np.array([[True, False, True], [False, True, True]])))
for ax in (None, 0, -1, ()):
    show(f"prod where complex 0-d axis {ax} False", lambda: np.prod(np.array(2 + 1j), axis=ax, where=False))
    show(f"prod where complex 0-d axis {ax} True", lambda: np.prod(np.array(2 + 1j), axis=ax, where=np.array(True)))
show("prod where complex empty kept", lambda: np.prod(np.empty((0, 3), complex), axis=1, where=False))
show("prod where complex empty reduced", lambda: np.prod(np.empty((2, 0), complex), axis=1, where=np.empty((2, 0), bool)))
show("prod where complex empty axis ()", lambda: np.prod(np.empty((0, 3), complex), axis=(), where=False))
for tag, wv in (("1", 1), ("0.0", 0.0), ("[1, 0, 1]", [1, 0, 1]), ("[1.0, 0.0, 1.0]", [1.0, 0.0, 1.0]),
                ("np.int64(1)", np.int64(1)), ("np.float64(0)", np.float64(0)), ("np.array(1)", np.array(1)),
                ("'x'", "x"), ("(True, False, True)", (True, False, True))):
    show(f"sum where={tag}", lambda: np.sum(x, axis=1, where=wv))
    show(f"prod where={tag}", lambda: np.prod(x, axis=1, where=wv))
show("sum 0-d where False", lambda: np.sum(np.array(2.0), where=False))
show("sum 0-d keepdims where", lambda: np.sum(np.array(2.0), keepdims=True, where=np.array(False)))
show("prod 0-d where False", lambda: np.prod(np.array(2.0), where=False))
show("prod 0-d axis () where False", lambda: np.prod(np.array(2.0), axis=(), where=False))
show("prod 0-d keepdims where", lambda: np.prod(np.array(2.0), keepdims=True, where=np.array(True)))
show("prod 0-d axis (0,) where", lambda: np.prod(np.array(2.0), axis=(0,), where=np.array(True)))
show("diff n=0 axis [0]", lambda: np.diff(np.ones((2, 3)), n=0, axis=[0]))
show("diff n=0 axis 1.5", lambda: np.diff(np.ones((2, 3)), n=0, axis=1.5))
show("diff n=0 list input", lambda: np.diff([1, 2, 4], n=0))
show("diff n=-1", lambda: np.diff(np.ones((2, 3)), n=-1, axis=[0]))
show("diff 0-d", lambda: np.diff(np.array(1.0), axis=[0]))
# (an axis named twice, as itself or by its negative: refused)
for name in ("sum", "prod", "max", "any", "mean", "std", "var", "nansum", "nanmean", "count_nonzero", "ptp"):
    for ax in ((0, 0), (0, -2), (1, -1, 0)):
        show(f"{name} axis={ax}", lambda: getattr(np, name)(x, axis=ax))
show("x.sum axis=(1, -1)", lambda: x.sum(axis=(1, -1)))
show("add.reduce axis=(0, 0)", lambda: np.add.reduce(x, axis=(0, 0)))
show("sum axis=(0, 5)", lambda: np.sum(x, axis=(0, 5)))
# (the masked product's order: NumPy's iterator over the input, the result and the mask, so a transposed operand with a
# mask of its own layout folds in memory order and with a C-ordered mask in C order; the factors make the order show)
tr = np.array([[1e200, 1e200], [1e-200, 1e-200]])
for tag, arr in (("float", tr.T), ("complex", tr.astype(complex).T)):
    for mtag, mk in (("its layout", np.ones((2, 2), bool).T), ("C", np.ones((2, 2), bool)), ("a row", np.ones(2, bool)),
                     ("True array", np.array(True))):
        show(f"prod where {tag} transposed, mask {mtag}", lambda: np.prod(arr, where=mk))
        show(f"prod where {tag} transposed axis 0, mask {mtag}", lambda: np.prod(arr, axis=0, where=mk))
    show(f"prod {tag} transposed, no mask", lambda: np.prod(arr))
show("sum where range(3)", lambda: np.sum(np.array([2, 3, 5]), where=range(3)))
show("prod where range(3)", lambda: np.prod(np.array([2.0, 3.0, 5.0]), where=range(3)))
# (a mask that isn't all True, on transposed operands, folded over every axis: each kept element its own)
t2 = np.arange(1.0, 7.0).reshape(2, 3).T
m2 = (np.arange(6).reshape(2, 3) % 3 != 1).T
for tag, arr in (("float", t2), ("complex", (np.arange(1.0, 7.0).reshape(2, 3) * (1 + 2j)).T),
                 ("int", np.arange(1, 7).reshape(2, 3).T)):
    show(f"prod where {tag} transposed, uneven mask", lambda: np.prod(arr, where=m2))
    show(f"prod where {tag} transposed, uneven C mask", lambda: np.prod(arr, where=np.ascontiguousarray(m2)))
    show(f"prod where {tag} transposed axis 1, uneven mask", lambda: np.prod(arr, axis=1, where=m2))
# (a mixed sequence: each element's own truth value)
show("sum where [False, 'False']", lambda: np.sum(np.array([2.0, 3.0]), where=[False, "False"]))
show("prod where [False, 'False']", lambda: np.prod(np.array([2.0, 3.0]), where=[False, "False"]))
show("prod where [[True], [False]]", lambda: np.prod(np.array([2.0, 3.0]), where=[[True], [False]]))
show("prod where ([1, 0], [0, 1])", lambda: np.prod(np.arange(1.0, 5.0).reshape(2, 2), axis=1, where=([1, 0], [0, 1])))
# (an explicit initial=None isn't an omitted one: the reduction then has no identity, so any mask but True is refused,
# after the axes and the mask are checked, and so is a reduction over an empty axis; omitted, the identity serves)
z0 = np.zeros((0, 3))
for name in ("sum", "prod"):
    f = getattr(np, name)
    for itag, kw in (("initial=None", {"initial": None}), ("initial omitted", {})):
        show(f"{name} where=False {itag}", lambda: f(np.array([2, 3]), where=False, **kw))
        show(f"{name} where=np.array(True) {itag}", lambda: f(np.array([2, 3]), where=np.array(True), **kw))
        show(f"{name} where=np.True_ {itag}", lambda: f(np.array([2, 3]), where=np.True_, **kw))
        show(f"{name} where=True {itag}", lambda: f(np.array([2, 3]), where=True, **kw))
        show(f"{name} where=[True, False] {itag}", lambda: f(np.array([2.0, 3.0]), where=[True, False], **kw))
        show(f"{name} complex where=[True, False] {itag}",
             lambda: f(np.array([2 + 1j, 3]), where=[True, False], **kw))
        show(f"{name} [] {itag}", lambda: f(np.array([]), **kw))
        show(f"{name} (0, 3) axis 0 {itag}", lambda: f(z0, axis=0, **kw))
        show(f"{name} (0, 3) axis 1 {itag}", lambda: f(z0, axis=1, **kw))
        show(f"{name} (0, 0) axis 0 {itag}", lambda: f(np.zeros((0, 0)), axis=0, **kw))
        show(f"{name} (2, 0) axis () {itag}", lambda: f(np.zeros((2, 0)), axis=(), **kw))
        show(f"{name} (2, 0) axis 1 keepdims {itag}", lambda: f(np.zeros((2, 0)), axis=1, keepdims=True, **kw))
        show(f"{name} 0-d {itag}", lambda: f(np.array(5), **kw))
        show(f"{name} 0-d where=False {itag}", lambda: f(np.array(5), where=False, **kw))
        show(f"{name} axis 5 where=False {itag}", lambda: f(np.array([2, 3]), axis=5, where=False, **kw))
        show(f"{name} bad mask shape {itag}", lambda: f(np.array([2, 3]), where=[True, False, True], **kw))
        show(f"{name} float mask {itag}", lambda: f(np.array([2, 3]), where=np.array([1.0, 0.0]), **kw))
        show(f"{name} method where [True, False] {itag}",
             lambda: getattr(np.array([2.0, 3.0]), name)(where=[True, False], **kw))
        show(f"{name} method [] {itag}", lambda: getattr(np.array([]), name)(**kw))
        show(f"{name} dtype=float where [True, False] {itag}",
             lambda: f(np.array([2, 3]), dtype=float, where=[True, False], **kw))
# (a sum over an empty leading axis of a C-ordered array: the identity, not a first row that isn't there)
for dt in ("float64", "float32", "complex128", "int64"):
    show(f"sum (0, 3) axis 0 {dt}", lambda: np.sum(np.zeros((0, 3), dt), axis=0))
    show(f"sum (0, 2, 3) axis (0, 1) {dt}", lambda: np.sum(np.zeros((0, 2, 3), dt), axis=(0, 1)))
    show(f"sum (2, 0, 3) axis (0, 1) {dt}", lambda: np.sum(np.zeros((2, 0, 3), dt), axis=(0, 1)))
    show(f"mean (0, 3) axis 0 {dt}", lambda: np.mean(np.zeros((0, 3), dt), axis=0))
    show(f"add.reduce (0, 3) axis 0 {dt}", lambda: np.add.reduce(np.zeros((0, 3), dt), axis=0))
show("cumsum (0, 3) axis 0", lambda: np.cumsum(np.zeros((0, 3)), axis=0))
show("nansum (0, 3) axis 0", lambda: np.nansum(np.zeros((0, 3)), axis=0))
# (a ufunc's reduce: an explicit initial=None leaves it without an identity too, whatever the ufunc)
for u in (np.add, np.multiply, np.maximum, np.logical_and, np.logical_or):
    n = u.__name__
    for itag, kw in (("initial=None", {"initial": None}), ("initial omitted", {})):
        show(f"{n}.reduce where=[True, False] {itag}", lambda: u.reduce(np.array([2, 3]), where=[True, False], **kw)
             if kw else "where unsupported")
        show(f"{n}.reduce where=np.True_ {itag}", lambda: u.reduce(np.array([2, 3]), where=np.True_, **kw)
             if kw else "where unsupported")
        show(f"{n}.reduce where=True {itag}", lambda: u.reduce(np.array([2, 3]), where=True, **kw))
        show(f"{n}.reduce (0, 3) axis 1 {itag}", lambda: u.reduce(np.zeros((0, 3), int), axis=1, **kw))
        show(f"{n}.reduce (2, 3) axis None {itag}", lambda: u.reduce(np.ones((2, 3), int), axis=None, **kw))
        show(f"{n}.reduce bad mask {itag}", lambda: u.reduce(np.array([2, 3]), where=[True, False, True], **kw)
             if kw else "where unsupported")
        show(f"{n}.reduce axis 5 where=False {itag}", lambda: u.reduce(np.array([2, 3]), axis=5, where=False, **kw)
             if kw else "where unsupported")
    show(f"{n}.reduce [] initial=None", lambda: u.reduce(np.array([], int), initial=None))
    show(f"{n}.reduce (0, 3) axis 0 initial=None", lambda: u.reduce(np.zeros((0, 3), int), axis=0, initial=None))
show("add.reduce 0-d where=False initial=None", lambda: np.add.reduce(np.array(5.0), initial=None, where=False))
show("add.reduce 0-d axis (0,) initial=None", lambda: np.add.reduce(np.array(5.0), axis=(0,), initial=None))
show("sum 0-d axis 0 initial=None", lambda: np.sum(np.array(5.0), axis=0, initial=None))
show("sum 0-d axis -1 initial=None", lambda: np.sum(np.array(5.0), axis=-1, initial=None))
show("multiply.reduce [[2, 3]] axis 1 where all True initial=None",
     lambda: np.multiply.reduce([[2, 3]], axis=1, initial=None, where=[[True, True]]))
show("add.reduce dtype=int [] initial=None", lambda: np.add.reduce(np.zeros(0), initial=None, dtype=int))
# (squeeze's axes: a bool refused, each an index, in bounds and not repeated, checked one by one; a 0-d array takes the
# single axis 0 or -1 as none)
s3 = np.ones((1, 1, 3))
for ax in ((0, 0), (0, -3), (5,), (0, 5), (5, 5), (5, 0, 0), (0, 0, 5), (5, 1.0), (0, 1.0), (True,), (np.True_,), True,
           np.True_, 5, -4, 1.0, "a", ("a",), (None,), (0, None), np.int64(1), (np.int8(1),), np.array(0),
           (np.array(1),), np.array([0, 1]), (2,), (0, 2), (0, 1), (-1 + 1, -2), ()):
    show(f"squeeze {ax!r}", lambda: np.squeeze(s3, axis=ax))
    show(f"x.squeeze {ax!r}", lambda: s3.squeeze(axis=ax))
z5 = np.array(5.0)
for ax in (0, -1, 1, -2, (0,), (0, 0), (1,), True, (True,), 1.0, np.int64(0), None, ()):
    show(f"squeeze 0-d {ax!r}", lambda: np.squeeze(z5, axis=ax))
show("x.squeeze 0-d 0", lambda: z5.squeeze(axis=0))
# (without an identity a sum starts from each result's first element, then adds the rest, pairwise along a contiguous
# run: a -0.0 sum stays -0.0, and the grouping of the additions changes the last bits)
rs = np.random.RandomState(5)
big = rs.standard_normal(1000) * 10 ** rs.uniform(-3, 3, 1000)
g2 = rs.standard_normal((50, 37))
for itag, kw in (("initial=None", {"initial": None}), ("initial omitted", {})):
    show(f"sum [-0.0] {itag}", lambda: np.sum(np.array([-0.0]), **kw))
    show(f"sum [-0.0] * 9 {itag}", lambda: np.sum(np.full(9, -0.0), **kw))
    show(f"sum (2, 2) of -0.0 axis 0 {itag}", lambda: np.sum(np.full((2, 2), -0.0), axis=0, **kw))
    show(f"sum (2, 2) of -0.0 axis 1 {itag}", lambda: np.sum(np.full((2, 2), -0.0), axis=1, **kw))
    show(f"sum (3, 1, 2) of -0.0 axis (0, 1) {itag}", lambda: np.sum(np.full((3, 1, 2), -0.0), axis=(0, 1), **kw))
    show(f"sum complex -0.0 {itag}", lambda: np.sum(np.array([complex(-0.0, -0.0)]), **kw))
    show(f"sum float32 -0.0 {itag}", lambda: np.sum(np.array([-0.0], np.float32), **kw))
    show(f"sum 1000 {itag}", lambda: np.sum(big, **kw))
    show(f"sum 1000 float32 {itag}", lambda: np.sum(big.astype(np.float32), **kw))
    # (a complex run under four elements: NumPy sums a longer one's parts in blocks of its own, not yet Sagebrush's)
    show(f"sum 3 complex {itag}", lambda: np.sum(big[:3] + 1j * big[3:6], **kw))
    show(f"sum (50, 37) {itag}", lambda: np.sum(g2, **kw))
    show(f"sum (50, 37) axis 0 {itag}", lambda: np.sum(g2, axis=0, **kw))
    show(f"sum (50, 37) axis 1 {itag}", lambda: np.sum(g2, axis=1, **kw))
    show(f"sum (50, 37) axis 1 keepdims {itag}", lambda: np.sum(g2, axis=1, keepdims=True, **kw))
    show(f"sum (50, 37)[:, ::2] axis 1 {itag}", lambda: np.sum(g2[:, ::2], axis=1, **kw))
    show(f"sum (50, 37) axis () {itag}", lambda: np.sum(g2[:2, :2], axis=(), **kw))
    show(f"x.sum (50, 37) axis 1 {itag}", lambda: g2.sum(axis=1, **kw))
    show(f"add.reduce (50, 37) axis 1 {itag}", lambda: np.add.reduce(g2, axis=1, **kw))
    show(f"add.reduce 1000 axis None {itag}", lambda: np.add.reduce(big, axis=None, **kw))
    show(f"add.reduce [-0.0] {itag}", lambda: np.add.reduce(np.array([-0.0]), **kw))
    show(f"add.reduce [-0.0] out {itag}", lambda: np.add.reduce(np.array([-0.0, -0.0]), out=np.zeros(()), **kw))
    show(f"sum int {itag}", lambda: np.sum(np.array([2, 3]), **kw))
    show(f"sum dtype=float32 {itag}", lambda: np.sum(big[:20], dtype=np.float32, **kw))
    show(f"prod [-0.0] {itag}", lambda: np.prod(np.array([-0.0]), **kw))
    show(f"multiply.reduce [-0.0] {itag}", lambda: np.multiply.reduce(np.array([-0.0]), **kw))
# (NumPy's order: the mask's conversion, then the axes, then the mask's shape)
for name in ("sum", "prod"):
    f = getattr(np, name)
    for itag, kw in (("initial=None", {"initial": None}), ("initial omitted", {}), ("initial=1", {"initial": 1})):
        for wtag, w in (("[True, False]", [True, False]), ("(1, 1) mask", np.array([[True]])),
                        ("(2, 2) mask", np.ones((2, 2), bool)), ("int mask", np.array([1])),
                        ("(1, 1) int mask", np.array([[1]]))):
            show(f"{name} axis 99 where {wtag} {itag}", lambda: f(np.array([1]), axis=99, where=w, **kw))
        show(f"{name} axis [0] float mask {itag}", lambda: f(np.array([1.0]), axis=[0], where=np.array([1.0]), **kw))
        show(f"{name} 0-d axis 0 where (2,) {itag}", lambda: f(np.array(5.0), axis=0, where=[True, False], **kw))
        show(f"{name} 0-d axis 1 where (2,) {itag}", lambda: f(np.array(5.0), axis=1, where=[True, False], **kw))
for ax in (2 ** 31, -2 ** 31 - 1, 2 ** 31 - 1, -2 ** 31, (2 ** 32,), (0, 2 ** 32)):
    show(f"squeeze {ax!r}", lambda: np.squeeze(np.ones((1, 1)), axis=ax))
# (a bool axis refused first by the C reductions, alone or in a tuple, before a 0-d operand's 0 or -1 and the masks;
# squeeze's axes beyond a C long overflow, and beyond a C int are refused, before their bounds)
for ax in (False, True, np.False_, (False,), (0, True)):
    for kw in ({"initial": None}, {"initial": None, "where": False}, {"where": False}, {"where": [True]}):
        show(f"sum 0-d axis={ax!r} {kw}", lambda: np.sum(np.array(1.0), axis=ax, **kw))
        show(f"prod 0-d axis={ax!r} {kw}", lambda: np.prod(np.array(1.0), axis=ax, **kw))
    show(f"add.reduce 0-d axis={ax!r} initial=None", lambda: np.add.reduce(np.array(1.0), axis=ax, initial=None))
    show(f"sum (2,) axis={ax!r} initial=None where=False",
         lambda: np.sum(np.ones(2), axis=ax, initial=None, where=False))
for ax in (10 ** 100, (10 ** 100,), 2 ** 63, 2 ** 63 - 1, -2 ** 63, -2 ** 63 - 1, (0, 2 ** 63)):
    show(f"squeeze {ax!r}", lambda: np.squeeze(np.ones((1, 1)), axis=ax))
# (the C reductions' axes read in turn, a float in Python's words, alone or in a tuple, with or without a mask; and
# NumPy's own path, without one, for comparison)
for kw in ({}, {"initial": None}, {"where": [[True]]}, {"initial": None, "where": [[True]]}):
    for ax in (1.0, 0.0, "a", (0.5, True), (True, 0.5), (0.5, 5), (5, 0.5), (0, 0.5), (1.0,), (None,), (0, None),
               (0, 0, 5), (5, 0, 0), (0, -2, 5), (1, 0, 1), [0]):
        show(f"sum (1, 1) axis={ax!r} {kw}", lambda: np.sum(np.ones((1, 1)), axis=ax, **kw))
        show(f"prod (1, 1) axis={ax!r} {kw}", lambda: np.prod(np.ones((1, 1)), axis=ax, **kw))
    show(f"sum 0-d axis=0.0 {kw}", lambda: np.sum(np.array(1.0), axis=0.0, **kw))
    show(f"sum 0-d axis=(0, 0) {kw}", lambda: np.sum(np.array(1.0), axis=(0, 0), **kw))
