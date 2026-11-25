# where= for mean, std, var and the nan functions (#2088), as NumPy's: the kept elements counted (intp) and summed by
# NumPy's masked reduction, which adds each run of kept elements along its inner loop at once (pairwise for floats),
# in the order its iterator takes for the input, the result and the mask; var's deviations from the masked mean; the
# nan functions' NaNs as 0, then the same; and the masks checked in NumPy's order.
import numpy as np
import warnings
warnings.simplefilter("ignore")


def show(tag, f):
    try:
        r = f()
        a = np.asarray(r)
        print(tag, type(r).__name__, a.dtype, a.shape,
              [float(v).hex() if a.dtype.kind == "f" else (repr(complex(v)) if a.dtype.kind == "c" else v)
               for v in a.ravel().tolist()])
    except Exception as e:
        base = next(c for c in (TypeError, IndexError, ValueError, Exception) if isinstance(e, c))
        print(tag, "!!", base.__name__, e)


x = np.array([[1.0, 2.5, 4.0, 7.0], [3.0, 0.5, 9.0, 2.0], [6.0, 8.0, 1.5, 5.5]])
xn = x.copy()
xn[0, 1] = np.nan
xn[2, 3] = np.nan
w = np.array([[True, False, True, True], [False, True, True, False], [True, True, False, True]])
xi = np.arange(12).reshape(3, 4)
xc = x + 1j * x[::-1]
x32 = x.astype(np.float32)
for name in ("mean", "std", "var", "nanmean", "nanstd", "nanvar", "nansum", "nanprod", "nanmax", "nanmin", "sum", "prod"):
    f = getattr(np, name)
    kw = {"initial": -1.0} if name in ("nanmax",) else ({"initial": 100.0} if name == "nanmin" else {})
    for tag, arr in (("float", x), ("nan", xn), ("int", xi), ("complex", xc), ("float32", x32)):
        if name in ("nanmax", "nanmin") and tag == "complex":
            continue
        show(f"{name} {tag} where", lambda: f(arr, where=w, **kw))
        show(f"{name} {tag} where axis 0", lambda: f(arr, axis=0, where=w, **kw))
        show(f"{name} {tag} where axis 1 keepdims", lambda: f(arr, axis=1, where=w, keepdims=True, **kw))
    show(f"{name} where row", lambda: f(x, axis=1, where=np.array([True, False, True, False]), **kw))
    show(f"{name} where all False", lambda: f(x, axis=1, where=False, **kw))
    show(f"{name} where list", lambda: f(x, axis=0, where=[True, False, True, True], **kw))
    show(f"{name} where int array", lambda: f(x, axis=0, where=np.array([1, 0, 1, 1]), **kw))
    show(f"{name} where (3,)", lambda: f(x, axis=1, where=np.array([True, False, True]), **kw))
    show(f"{name} where 1", lambda: f(x, axis=1, where=1, **kw))
for name in ("std", "var", "nanstd", "nanvar"):
    f = getattr(np, name)
    show(f"{name} where ddof 1", lambda: f(x, axis=1, where=w, ddof=1))
    show(f"{name} where ddof 3", lambda: f(x, axis=1, where=w, ddof=3))
    show(f"{name} where mean=", lambda: f(x, axis=1, where=w, mean=np.mean(x, axis=1, where=w, keepdims=True))) if name in ("std", "var") else None
for name in ("mean", "std", "var", "nanmean"):
    f = getattr(np, name)
    show(f"{name} where dtype float32", lambda: f(xi, axis=1, where=w, dtype=np.float32))
    o = np.zeros(3)
    show(f"{name} where out", lambda: (f(x, axis=1, where=w, out=o), o)[1])
show("x.mean where", lambda: x.mean(axis=1, where=w))
show("x.std where", lambda: x.std(axis=0, where=w))
show("x.var where", lambda: x.var(where=w))
show("mean where empty", lambda: np.mean(np.zeros((0, 3)), axis=0, where=np.zeros((0, 3), bool)))
show("mean where 0-d", lambda: np.mean(np.array(3.0), where=False))
show("mean where tuple axis", lambda: np.mean(np.arange(24.0).reshape(2, 3, 4), axis=(0, 2), where=np.arange(24).reshape(2, 3, 4) % 3 > 0))
show("nanmean where tuple axis", lambda: np.nanmean(np.arange(24.0).reshape(2, 3, 4), axis=(0, 2), where=np.arange(24).reshape(2, 3, 4) % 3 > 0))

# (the masked sum's order: each run of kept elements summed pairwise and added; long runs, sparse and dense masks,
# each axis, a transposed operand with its own or a C-ordered mask, a broadcast mask, strided views, float32, ints,
# short complex runs; and the means and variances built on it)
rs = np.random.RandomState(7)
for n in (10, 100, 1000, 20000):
    a = rs.standard_normal(n) * 10 ** rs.uniform(-3, 3, n)
    for p in (0.0005, 0.05, 0.3, 0.9):
        m = rs.rand(n) > p
        show(f"sum {n} masked {p}", lambda: np.sum(a, where=m))
        show(f"mean {n} masked {p}", lambda: np.mean(a, where=m))
        show(f"var {n} masked {p}", lambda: np.var(a, where=m))
        show(f"sum {n} float32 masked {p}", lambda: np.sum(a.astype(np.float32), where=m))
    show(f"sum {n} all-True mask array", lambda: np.sum(a, where=np.ones(n, bool)))
    show(f"sum {n} [::-1] masked", lambda: np.sum(a[::-1], where=m))
    show(f"sum {n} [::3] masked", lambda: np.sum(a[::3], where=m[::3]))
for shape in ((30, 50), (50, 300), (3, 2000), (200, 9), (4, 5, 6)):
    a = rs.standard_normal(shape) * 10 ** rs.uniform(-3, 3, shape)
    m = rs.rand(*shape) > 0.3
    for ax in [None] + list(range(len(shape))) + ([(0, 2), (1, 2), (0, 1)] if len(shape) == 3 else []):
        show(f"sum {shape} axis {ax} masked", lambda: np.sum(a, axis=ax, where=m))
        show(f"sum {shape}.T axis {ax} its mask", lambda: np.sum(a.T, axis=ax, where=m.T))
        show(f"sum {shape}.T axis {ax} C mask", lambda: np.sum(a.T, axis=ax, where=np.ascontiguousarray(m.T)))
        show(f"mean {shape} axis {ax} masked", lambda: np.mean(a, axis=ax, where=m))
        show(f"std {shape}.T axis {ax} masked", lambda: np.std(a.T, axis=ax, where=m.T))
        show(f"sum {shape} axis {ax} broadcast row mask", lambda: np.sum(a, axis=ax, where=m[(0,) * (len(shape) - 1)]))
    show(f"sum {shape} int masked", lambda: np.sum((a * 1000).astype(np.int64), where=m))
    show(f"sum {shape} int axis 0 masked", lambda: np.sum((a * 1000).astype(np.int64), axis=0, where=m))
    show(f"sum {shape} int32 axis -1 masked", lambda: np.sum((a * 1000).astype(np.int32), axis=-1, where=m))
    show(f"mean {shape} int axis -1 masked", lambda: np.mean((a * 1000).astype(np.int64), axis=-1, where=m))
c3 = rs.standard_normal((5, 3)) + 1j * rs.standard_normal((5, 3))
show("sum complex rows of 3 masked", lambda: np.sum(c3, axis=1, where=[True, False, True]))
show("mean complex rows of 3 masked", lambda: np.mean(c3, axis=1, where=[True, True, False]))
show("var complex rows of 3 masked", lambda: np.var(c3, axis=1, where=[True, True, False]))

# (a ufunc's reduce takes where= for add, multiply, maximum and minimum)
y = np.arange(1.0, 13.0).reshape(3, 4)
for u in (np.add, np.multiply, np.maximum, np.minimum):
    show(f"{u.__name__}.reduce where", lambda: u.reduce(y, axis=1, where=w))
    show(f"{u.__name__}.reduce where initial", lambda: u.reduce(y, axis=1, where=w, initial=1.0))
    show(f"{u.__name__}.reduce where axis None", lambda: u.reduce(y, axis=None, where=w, initial=0.5))
    show(f"{u.__name__}.reduce where out", lambda: (u.reduce(y, axis=0, where=w, out=o4, initial=2.0), o4)[1])
o4 = np.zeros(4)

# (max and min with a mask: its conversion, the axes, its shape, then the identity, NumPy's order)
for name in ("max", "min", "nanmax", "nanmin"):
    f = getattr(np, name)
    for kw in ({}, {"initial": -1.0}):
        for wtag, wm in (("int array", np.array([1, 0, 1, 0])), ("(3,)", [True, False, True]),
                         ("(2, 3, 4)", np.ones((2, 3, 4), bool)), ("False", False), ("row", [True, False, True, True])):
            for ax in (None, 5, 1):
                show(f"{name} {kw} axis {ax} where {wtag}", lambda: f(x, axis=ax, where=wm, **kw))

# (mean's and var's count: the mask broadcast to the operand first, with broadcast_to's refusals; the nan functions'
# dtype and out refusals; ddof, correction and mean= for the nan forms; NaN where too few remain)
for name in ("mean", "var", "std", "nanmean", "nanvar", "nanstd"):
    f = getattr(np, name)
    show(f"{name} where (3,) axis 1", lambda: f(x, axis=1, where=[True, False, True]))
    show(f"{name} where (2, 3, 4)", lambda: f(x, where=np.ones((2, 3, 4), bool)))
    show(f"{name} where axis 5", lambda: f(x, axis=5, where=w))
    show(f"{name} where float array", lambda: f(x, where=np.ones((3, 4))))
    show(f"{name} where 0-d", lambda: f(x, axis=1, where=np.array(True)))
    show(f"{name} where np.True_", lambda: f(x, axis=0, where=np.True_))
    show(f"{name} where None", lambda: f(x, axis=0, where=None))
    show(f"{name} nan where axis None keepdims", lambda: f(xn, where=w, keepdims=True))
    show(f"{name} nan where axis (0, 1)", lambda: f(xn, axis=(0, 1), where=w))
    show(f"{name} 0-d where True array", lambda: f(np.array(2.5), where=np.array(True)))
    show(f"{name} empty where", lambda: f(np.zeros((2, 0)), axis=1, where=np.zeros((2, 0), bool)))
    show(f"{name} method-free list input where", lambda: f([[1.0, np.nan], [3.0, 4.0]], axis=1, where=[True, True]))
for name in ("nanmean", "nanvar", "nanstd"):
    f = getattr(np, name)
    show(f"{name} dtype int", lambda: f(xn, dtype=np.int64))
    show(f"{name} out int", lambda: f(xn, axis=1, out=np.zeros(3, np.int64)))
    show(f"{name} int input dtype int", lambda: f(xi, axis=1, dtype=np.int64, where=w))
    o3 = np.zeros(3, np.float32)
    show(f"{name} nan where out float32", lambda: (f(xn, axis=1, where=w, out=o3), o3)[1])
    show(f"{name} nan where dtype float32", lambda: f(xn, axis=1, where=w, dtype=np.float32))
    show(f"{name} float32 nan where", lambda: f(xn.astype(np.float32), axis=0, where=w))
for name in ("nanvar", "nanstd", "var", "std"):
    f = getattr(np, name)
    show(f"{name} nan where ddof 2", lambda: f(xn, axis=1, where=w, ddof=2))
    show(f"{name} nan where correction 1", lambda: f(xn, axis=0, where=w, correction=1))
    show(f"{name} nan where ddof 1 correction 1", lambda: f(xn, axis=0, where=w, ddof=1, correction=1))
    show(f"{name} nan where mean=", lambda: f(xn, axis=1, where=w, mean=np.nanmean(xn, axis=1, where=w, keepdims=True)))
    show(f"{name} nan mean= no mask", lambda: f(xn, axis=0, mean=np.nanmean(xn, axis=0, keepdims=True)))
    show(f"{name} nan where ddof float", lambda: f(xn, axis=1, where=w, ddof=0.5))
    show(f"{name} complex nan where", lambda: f(xc * np.where(np.isnan(xn), np.nan, 1), axis=1, where=w))
for name in ("nansum", "nanprod"):
    f = getattr(np, name)
    show(f"{name} nan where initial", lambda: f(xn, axis=1, where=w, initial=2.0))
    show(f"{name} nan initial", lambda: f(xn, axis=0, initial=2.0))
    show(f"{name} nan where out", lambda: (f(xn, axis=1, where=w, out=o3), o3)[1])
    show(f"{name} int where", lambda: f(xi, axis=0, where=w))
    show(f"{name} nan where initial=None", lambda: f(xn, where=w, initial=None))
    show(f"{name} nan initial=None", lambda: f(xn, initial=None))
for m in ("mean", "std", "var"):
    show(f"x.{m} where keepdims", lambda: getattr(xn, m)(axis=0, where=w, keepdims=True))
    show(f"x.{m} where dtype out", lambda: (getattr(x, m)(axis=1, where=w, dtype=np.float32, out=o3), o3)[1])
show("x.var mean= correction", lambda: x.var(axis=1, mean=x.mean(axis=1, keepdims=True), correction=1))
show("x.std where mean=", lambda: x.std(axis=0, where=w, mean=x.mean(axis=0, where=w, keepdims=True)))

# (a reduced block that coalesces for neither the operand nor the mask is buffered by NumPy: its runs end at chunks of
# as many whole innermost rows as fit in 8192 elements (one row if longer), again for each output; dense masks show it)
rs = np.random.RandomState(9)
for shape in ((3, 9000), (4, 20000), (100, 300), (2, 3, 5000), (7, 3000), (300, 100)):
    a = rs.standard_normal(shape) * 10 ** rs.uniform(-3, 3, shape)
    for p in (0.0, 0.0002):
        m = rs.rand(*shape) >= p
        show(f"sum {shape}.T C mask dense {p}", lambda: np.sum(a.T, where=np.ascontiguousarray(m.T)))
        show(f"sum {shape} F mask dense {p}", lambda: np.sum(a, where=np.asfortranarray(m)))
        show(f"sum {shape}.T own mask dense {p}", lambda: np.sum(a.T, where=m.T))
        show(f"mean {shape}.T C mask dense {p}", lambda: np.mean(a.T, where=np.ascontiguousarray(m.T)))
for K, R1, R2 in ((3, 50, 300), (2, 9, 1000), (2, 100, 100), (3, 4000, 3)):
    a = rs.standard_normal((K, R1, R2)) * 10 ** rs.uniform(-3, 3, (K, R1, R2))
    m = np.ascontiguousarray((rs.rand(K, R1, R2) >= 0.0001).transpose(0, 2, 1)).transpose(0, 2, 1)
    show(f"sum ({K}, {R1}, {R2}) axis (1, 2) blockwise-F mask", lambda: np.sum(a, axis=(1, 2), where=m))
    show(f"var ({K}, {R1}, {R2}) axis (1, 2) blockwise-F mask", lambda: np.var(a, axis=(1, 2), where=m))
# (two kept and two reduced axes, several layouts; and the variances of transposed operands, whose deviations NumPy
# lays out as the operand)
import itertools
a4 = rs.standard_normal((3, 4, 5, 6)) * 10 ** rs.uniform(-3, 3, (3, 4, 5, 6))
m4 = rs.rand(3, 4, 5, 6) > 0.2
for ltag, a, m in (("C", a4, m4), ("T", a4.T, m4.T), ("perm", a4.transpose(1, 3, 0, 2), m4.transpose(1, 3, 0, 2)),
                   ("T C mask", a4.T, np.ascontiguousarray(m4.T))):
    for ax in itertools.combinations(range(4), 2):
        show(f"sum 4-d {ltag} axis {ax} masked", lambda: np.sum(a, axis=ax, where=m))
    show(f"var 4-d {ltag} axis (0, 2) masked", lambda: np.var(a, axis=(0, 2), where=m))
    show(f"nanvar 4-d {ltag} axis (1, 3) masked", lambda: np.nanvar(a, axis=(1, 3), where=m))
    show(f"nanstd 4-d {ltag} axis None masked", lambda: np.nanstd(a, where=m))
    show(f"nanmean 4-d {ltag} axis 1 masked", lambda: np.nanmean(a, axis=1, where=m))
t2 = rs.standard_normal((40, 300)) * 10 ** rs.uniform(-3, 3, (40, 300))
t2[rs.rand(40, 300) < 0.05] = np.nan
m2 = rs.rand(40, 300) > 0.1
for name in ("nanvar", "nanstd", "nanmean", "nansum"):
    f = getattr(np, name)
    show(f"{name} transposed masked", lambda: f(t2.T, where=m2.T))
    show(f"{name} transposed axis 0 masked", lambda: f(t2.T, axis=0, where=m2.T))
    show(f"{name} transposed axis 1 C mask", lambda: f(t2.T, axis=1, where=np.ascontiguousarray(m2.T)))
# (a complex sum, masked or not, pairwise as NumPy sums a complex array: fewer than 4 elements in turn, up to 64 in
# four accumulators per part, longer ones split near the middle at a multiple of 4; complex64 rounded at each step)
for n in (1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 63, 64, 65, 100, 127, 128, 129, 257, 1000, 4097):
    c = (rs.standard_normal(n) + 1j * rs.standard_normal(n)) * 10 ** rs.uniform(-3, 3, n)
    cm = rs.rand(n) > 0.2
    show(f"sum complex {n}", lambda: np.sum(c))
    show(f"sum complex64 {n}", lambda: np.sum(c.astype(np.complex64)))
    show(f"sum complex {n} masked", lambda: np.sum(c, where=cm))
    show(f"mean complex {n} masked", lambda: np.mean(c, where=cm))
    show(f"sum complex {n} initial=None", lambda: np.sum(c, initial=None))
    show(f"sum complex [::2] {n}", lambda: np.sum(c[::2]))
c2 = (rs.standard_normal((6, 150)) + 1j * rs.standard_normal((6, 150))) * 10 ** rs.uniform(-3, 3, (6, 150))
m2c = rs.rand(6, 150) > 0.05
for ax in (None, 0, 1):
    show(f"sum complex (6, 150) axis {ax}", lambda: np.sum(c2, axis=ax))
    show(f"sum complex (6, 150) axis {ax} masked", lambda: np.sum(c2, axis=ax, where=m2c))
    show(f"sum complex (6, 150).T axis {ax} C mask", lambda: np.sum(c2.T, axis=ax, where=np.ascontiguousarray(m2c.T)))
    show(f"var complex (6, 150) axis {ax} masked", lambda: np.var(c2, axis=ax, where=m2c))
    show(f"mean complex (6, 150) axis {ax}", lambda: np.mean(c2, axis=ax))
# (a whole array whose axes coalesce in NumPy's order, C, F, transposed, a complex array's parts, is one pairwise run,
# masked or not; and the same views with a mask that broadcasts a single True, which takes no part in the order)
for shape in ((30, 40), (5, 6, 7), (200, 300)):
    a = rs.standard_normal(shape) * 10 ** rs.uniform(-3, 3, shape)
    for tag, v in (("C", a), ("F", np.asfortranarray(a)), ("T", a.T), ("rev", a[::-1]), ("step", a[::2]),
                   ("revlast", a[..., ::-1])):
        t = np.broadcast_to(True, v.shape)
        if tag in ("C", "F", "T"):
            show(f"sum {shape} {tag}", lambda: np.sum(v))
            show(f"mean {shape} {tag}", lambda: np.mean(v))
            show(f"sum {shape} {tag} initial=None", lambda: np.sum(v, initial=None))
        if tag == "C":
            # (C only: Sagebrush's elementwise results are C-ordered, where NumPy's keep an F operand's layout)
            show(f"sum complex {shape} {tag}", lambda: np.sum(v * (1 + 0.5j)))
        show(f"sum {shape} {tag} where broadcast True", lambda: np.sum(v, where=t))
        show(f"sum {shape} {tag} axis 0 where broadcast True", lambda: np.sum(v, axis=0, where=t))
        show(f"sum {shape} {tag} axis -1 where broadcast True", lambda: np.sum(v, axis=-1, where=t))
# (buffered chunks that start again at each step of the next dimension out: P * that dimension short of the block)
for shape in ((2, 9000, 3), (4, 5000, 2), (3, 3, 4000, 2)):
    a = rs.standard_normal(shape) * 10 ** rs.uniform(-3, 3, shape)
    m = rs.rand(*shape) >= 0.0002
    show(f"sum {shape}.T C mask dense", lambda: np.sum(a.T, where=np.ascontiguousarray(m.T)))
    show(f"sum {shape} F mask dense", lambda: np.sum(a, where=np.asfortranarray(m)))
# (whole-array sums of views that don't coalesce, with exact values: each element once, whatever the order)
g = np.arange(240.0).reshape(4, 6, 10)
for tag, v in (("[::2]", g[::2]), ("[::-1]", g[::-1]), ("[..., ::2]", g[..., ::2]), ("[:, ::-1]", g[:, ::-1]),
               ("T[1:]", g.T[1:]), ("[:, 1:]", g[:, 1:])):
    show(f"sum exact {tag}", lambda: np.sum(v))
    show(f"mean exact {tag}", lambda: np.mean(v))
    show(f"sum exact {tag} initial=None", lambda: np.sum(v, initial=None))
    show(f"sum exact complex {tag}", lambda: np.sum(v.astype(complex)))
# (mean into an out of another dtype: the sum computed in its own loop, converted into out, then divided there)
xm = rs.standard_normal((3, 50)) * 10 ** rs.uniform(-3, 3, (3, 50))
wm = rs.rand(3, 50) > 0.3
for odt in (np.int64, np.float32, np.complex128):
    oo = np.zeros(3, odt)
    show(f"mean where out {odt.__name__}", lambda: (np.mean(xm, axis=1, where=wm, out=oo), oo)[1])
    show(f"mean int where out {odt.__name__}", lambda: (np.mean((xm * 1e3).astype(np.int64), axis=1, where=wm, out=oo), oo)[1])
# (var and std about a given mean, not the masked one; nanvar of float32 data summed in float64: its deviations in
# float32, as NumPy subtracts into its float32 copy)
for name in ("var", "std", "nanvar", "nanstd"):
    f = getattr(np, name)
    show(f"{name} where mean=0", lambda: f(xn, axis=1, where=w, mean=np.zeros((3, 1))))
    show(f"{name} mean=1", lambda: f(xn, axis=0, mean=np.ones((1, 4))))
    show(f"{name} float32 nan dtype float64 where", lambda: f(xn.astype(np.float32) / 3, axis=1, where=w, dtype=np.float64))
# (a masked sum that converts its operand (float32 summed in float64, ints in a mean, float64 summed in float32):
# NumPy's buffer converts it 8192 elements at a time, a stretch or a row longer than that split; nothing to reduce
# gives the identity)
sa = np.zeros(8193, dtype=np.float32)
sa[0], sa[8191], sa[8192] = 2 ** 60, -(2 ** 60), 1
show("sum float32 as float64 masked, 8193", lambda: np.sum(sa, dtype=np.float64, where=np.ones(sa.shape, bool)))
show("sum float32 as float64, 8193", lambda: np.sum(sa, dtype=np.float64))
show("sum empty view where True array", lambda: np.sum(np.array([7.0])[:0], where=np.array(True)))
show("mean (3, 0) axis 1 where True array", lambda: np.mean(np.zeros((3, 0)), axis=1, where=np.array(True)))
show("sum (0, 3) axis 0 where mask", lambda: np.sum(np.ones((4, 3))[:0], axis=0, where=np.ones((0, 3), bool)))
show("nansum empty where True array", lambda: np.nansum(np.array([np.nan])[:0], where=np.array(True)))
for shape in ((20000,), (100, 300), (3, 9000), (9000, 3), (40, 500), (3, 20000)):
    xs = (rs.standard_normal(shape) * 10 ** rs.uniform(-3, 3, shape)).astype(np.float32)
    xi = (rs.standard_normal(shape) * 1e6).astype(np.int64)
    ms = rs.rand(*shape) >= 0.0002
    for tag, v, vi, mm in (("C", xs, xi, ms), ("T", xs.T, xi.T, ms.T), ("T C mask", xs.T, xi.T, np.ascontiguousarray(ms.T))):
        show(f"sum {shape} {tag} float32 as float64 masked", lambda: np.sum(v, dtype=np.float64, where=mm))
        show(f"sum {shape} {tag} float32 as float64 masked axis -1", lambda: np.sum(v, axis=-1, dtype=np.float64, where=mm))
        show(f"mean {shape} {tag} int masked", lambda: np.mean(vi, where=mm))
        show(f"mean {shape} {tag} int masked axis -1", lambda: np.mean(vi, axis=-1, where=mm))
    show(f"sum {shape} float64 as float32 masked", lambda: np.sum(xs.astype(np.float64) * 1.1, dtype=np.float32, where=ms))
# (and unmasked: a sum, mean or variance that converts its operand goes through the same buffer)
for shape in ((20000,), (100, 300), (9000, 3), (3, 20000)):
    xs = (rs.standard_normal(shape) * 10 ** rs.uniform(-3, 3, shape)).astype(np.float32)
    xi = (rs.standard_normal(shape) * 1e6).astype(np.int64)
    for tag, v, vi in (("C", xs, xi), ("T", xs.T, xi.T)):
        show(f"sum {shape} {tag} float32 as float64", lambda: np.sum(v, dtype=np.float64))
        show(f"sum {shape} {tag} float32 as float64 axis -1", lambda: np.sum(v, axis=-1, dtype=np.float64))
        show(f"sum {shape} {tag} float32 as float64 axis 0", lambda: np.sum(v, axis=0, dtype=np.float64))
        show(f"mean {shape} {tag} int", lambda: np.mean(vi))
        show(f"mean {shape} {tag} int axis -1", lambda: np.mean(vi, axis=-1))
        show(f"var {shape} {tag} int", lambda: np.var(vi))
        show(f"mean {shape} {tag} float32 dtype float64", lambda: np.mean(v, dtype=np.float64))
# (var's squares: a complex operand's parts squared in their own dtype, then added (complex64 rounds each); a real
# operand's deviations from a complex mean squared as complex numbers)
for dt in (np.complex64, np.complex128):
    # (made in complex128 and converted: a complex division by a real number is NumPy's Smith division, not yet
    # Sagebrush's)
    cz = ((rs.standard_normal((4, 30)) + 1j * rs.standard_normal((4, 30))) / 17).astype(dt)
    show(f"var {dt.__name__}", lambda: np.var(cz))
    show(f"var {dt.__name__} axis 1 masked", lambda: np.var(cz, axis=1, where=rs.rand(4, 30) > 0.3))
    show(f"var {dt.__name__} mean=", lambda: np.var(cz, axis=0, mean=np.mean(cz, axis=0, keepdims=True)))
    show(f"std {dt.__name__} axis 0", lambda: np.std(cz, axis=0))
    show(f"var {dt.__name__} transposed", lambda: np.var(cz.T, axis=1))
show("var real, complex mean=", lambda: np.var(np.array([1.0, 2.0]), mean=np.array([1j])))
show("var real, complex mean= where", lambda: np.var(np.array([1.0, 2.0, 5.0]), where=[True, True, False], mean=np.array([1j])))
show("var bool where", lambda: np.var(np.array([True, False, True, True]), where=[True, True, False, True]))
# (an unmasked float sum the runtime doesn't walk as NumPy does itself (another layout, other axes) is the masked sum
# with every element kept: 4-d layouts over each pair of axes, strided and reversed views, means and variances)
b4 = (1 + rs.standard_normal((3, 4, 5, 6)) / 3) * 1e3
for ltag, b in (("C", b4), ("T", b4.T), ("perm", b4.transpose(1, 3, 0, 2)), ("rev", b4[::-1, :, ::-1]),
                ("step", b4[:, ::2])):
    for ax in [None] + list(itertools.combinations(range(4), 2)) + [(0,), (1,), (2,), (3,), (0, 1, 3)]:
        show(f"sum 4-d {ltag} axis {ax}", lambda: np.sum(b, axis=ax))
    show(f"mean 4-d {ltag} axis (1, 2)", lambda: np.mean(b, axis=(1, 2)))
    show(f"var 4-d {ltag} axis (0, 3)", lambda: np.var(b, axis=(0, 3)))
    show(f"std 4-d {ltag}", lambda: np.std(b))
    show(f"sum 4-d {ltag} float32 axis (0, 2)", lambda: np.sum(b.astype(np.float32) if ltag == "C" else b, axis=(0, 2), dtype=np.float32))
# (a given mean that is a Python number stays a weak scalar: float32 data subtract it in float32; one that broadcasts
# the operand to a larger shape is subtracted as it is)
f1 = np.array([1.0, 3.0, 4.0], dtype=np.float32)
for name in ("var", "std", "nanvar", "nanstd"):
    f = getattr(np, name)
    show(f"{name} float32 mean= Python float", lambda: f(f1, mean=1.0 + 2.0 ** -24))
    show(f"{name} float32 mean= Python int", lambda: f(f1, mean=2))
    show(f"{name} float32 mean= np.float64", lambda: f(f1, mean=np.float64(1.0 + 2.0 ** -24)))
    show(f"{name} float32 where mean= Python float", lambda: f(f1, where=[True, False, True], mean=2.5))
show("var mean= broadcast larger", lambda: np.var(np.array([1.0, 3.0]), mean=np.array([[0.0, 0.0]])))
show("std mean= broadcast larger axis 0", lambda: np.std(np.array([1.0, 3.0]), axis=0, mean=np.array([[0.0, 0.0]])))
# (a float operand summed in an integer or bool dtype: each element converted before it is added, masked or not)
fa = np.array([1.75, 1.75, -2.5, 300.7])
for dt in (np.int8, np.int64, np.uint8, np.bool_, np.int32):
    show(f"sum floats as {dt.__name__}", lambda: np.sum(fa, dtype=dt))
    show(f"sum floats as {dt.__name__} where", lambda: np.sum(fa, dtype=dt, where=[True, True, True, False]))
    show(f"sum floats as {dt.__name__} axis 0", lambda: np.sum(fa.reshape(2, 2), axis=0, dtype=dt))
    show(f"sum floats as {dt.__name__} transposed axis 1", lambda: np.sum(fa.reshape(2, 2).T, axis=1, dtype=dt))
show("sum int32 as int8", lambda: np.sum(np.array([100, 100, 100], np.int32), dtype=np.int8))
show("sum bools", lambda: np.sum(np.array([True, True, False])))
show("sum floats as int64 where, large", lambda: np.sum(np.arange(20000) * 0.75, dtype=np.int64, where=np.arange(20000) % 3 > 0))
for dt in (np.int8, np.int64, np.uint8, np.bool_):
    show(f"sum floats as {dt.__name__} initial=None", lambda: np.sum(fa, dtype=dt, initial=None))
    show(f"nansum floats as {dt.__name__} initial=None", lambda: np.nansum(fa, dtype=dt, initial=None))
    show(f"sum floats as {dt.__name__} axis 1 initial=None", lambda: np.sum(fa.reshape(2, 2), axis=1, dtype=dt, initial=None))
# (the nan functions with out: a 0-d out with nothing kept (no kept element, or all NaN) holds NaN; into a wider out
# they sum in out's dtype, as NumPy's sum into out does (add.reduce), float32 squares summed in float64; std's root
# refused for an integer out in NumPy's class, UFuncTypeError, a TypeError)
for name in ("nanvar", "nanstd"):
    f = getattr(np, name)
    for desc, arr, kw in (("where=False", np.array([1.0, 2.0]), {"where": False}),
                          ("all NaN", np.array([np.nan, np.nan]), {}),
                          ("float32 where", np.array([1.0, 2.0, 4.0], np.float32), {"where": [True, True, True]}),
                          ("float32", np.array([1.0, 2.0, 4.0], np.float32), {}),
                          ("ddof past the count", np.array([1.0, np.nan, 3.0]), {"ddof": 2})):
        o77 = np.array(77.0)
        show(f"{name} {desc} into 0-d float64 out", lambda: (f(arr, out=o77, **kw), o77)[1])
    o2 = np.full(2, 77.0)
    show(f"{name} rows into out, one row empty", lambda: (f(np.array([[np.nan, np.nan], [1.0, 3.0]]), axis=1, out=o2), o2)[1])
for name in ("nanmean", "nansum"):
    f = getattr(np, name)
    o64 = np.array(0.0)
    show(f"{name} float32 into float64 out", lambda: (f(np.array([1e8, 1.0, 1.0, np.nan], np.float32), out=o64), o64)[1])
    o64w = np.array(0.0)
    show(f"{name} float32 where into float64 out", lambda: (f(np.array([1e8, 1.0, 1.0, 5.0], np.float32), where=[True, True, True, False], out=o64w), o64w)[1])


def std_int_out():
    try:
        np.std(np.array([1.0, 2.0]), where=[True, True], out=np.zeros((), np.int32))
    except TypeError as e:
        return type(e).__name__ + ": " + str(e)


show("std where into an int out", std_int_out)
show("nanstd int input into an int out", lambda: np.nanstd(np.array([1, 2, 4]), out=np.zeros((), np.int32)))
