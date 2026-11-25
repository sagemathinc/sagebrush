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
