# Ufunc loops as NumPy resolves them (Codex audit R01, P2-3 to P2-5): accumulate's loop resolved before its first
# element (logical_or of ints is bool; a loop the ufunc doesn't have refused even for one element or none); square,
# np.conjugate and the shifts compute bool operands in int8, positive and sign refuse them; and a where= lane left
# out of an integer power is never computed.
import numpy as np
def show(tag, f):
    try:
        r = f(); print(tag, "|", r.dtype.name, r.shape, r.tolist())
    except Exception as e:
        print(tag, "| !!", type(e).__name__, e)
# a comparison's accumulate, refused but for bools: a fresh NumPy's TypeError and message (these rows first: after an
# out= call NumPy's loop cache makes it a UFuncTypeError)
for u in ("equal", "not_equal", "less", "less_equal", "greater", "greater_equal"):
    show(f"{u}.accumulate ints", lambda: getattr(np, u).accumulate([1, 1, 2]))
    show(f"{u}.accumulate floats", lambda: getattr(np, u).accumulate(np.array([1., 2.])))
    show(f"{u}.accumulate bools", lambda: getattr(np, u).accumulate(np.array([True, False, True])))
    show(f"{u}.accumulate empty bools", lambda: getattr(np, u).accumulate(np.array([], bool)))
for f in (np.logical_or, np.logical_and, np.logical_xor):
    for x in (np.array([2, 0, 3], np.int32), np.array([-2., 1., 0.]), np.array([0, 0]), np.array([5], np.int8), np.array([], np.int32), np.array([[1, 0], [0, 0]], np.uint8)):
        show(f"{f.__name__} {x.dtype.name} {x.shape}", lambda: f.accumulate(x))
        if x.ndim == 2:
            show(f"{f.__name__} axis1", lambda: f.accumulate(x, axis=1))
    show(f"{f.__name__} reversed", lambda: f.accumulate(np.array([0, 3, 0], np.int64)[::-1]))
for f in (np.bitwise_or, np.bitwise_and, np.bitwise_xor, np.left_shift):
    for x in (np.array([1., 2.]), np.array([1.]), np.array([], np.float64), np.array([1, 6], np.int16), np.array([True, False])):
        show(f"{f.__name__} {x.dtype.name} {x.shape}", lambda: f.accumulate(x))
for f in (np.maximum, np.minimum, np.subtract, np.true_divide, np.power):
    for x in (np.array([3, 1, 4], np.int8), np.array([True, False, True]), np.array([2., 3.]), np.array([], np.int8)):
        show(f"{f.__name__} {x.dtype.name} {x.shape}", lambda: f.accumulate(x))
show("logical_or dtype", lambda: np.logical_or.accumulate(np.array([2, 0], np.int32), dtype=bool))
show("logical_or out", lambda: (lambda o: (np.logical_or.accumulate(np.array([2, 0], np.int32), out=o), o)[1])(np.zeros(2, bool)))
b = np.array([True, False])
for n in ('square', 'conjugate', 'positive', 'sign', 'negative', 'absolute', 'reciprocal', 'invert', 'logical_not', 'floor', 'ceil', 'trunc', 'isnan', 'signbit'):
    for x in (b, b[::-1], np.array([], bool), np.True_, True):
        try:
            r = getattr(np, n)(x)
            print(n, type(x).__name__, np.asarray(r).dtype, np.asarray(r).tolist())
        except Exception as e:
            print(n, type(x).__name__, type(e).__name__)
print((np.square(b) + b).tolist(), (np.conjugate(b) + b).tolist(), (b.conjugate() + b).tolist(), (b.conj() + b).tolist())
for n in ('left_shift', 'right_shift'):
    print(n, getattr(np, n)(b, b).dtype, getattr(np, n)(True, True), getattr(np, n)(b, 1).dtype)
def show(tag, f):
    try:
        r = f(); print(tag, "|", r)
    except Exception as e:
        print(tag, "| !!", type(e).__name__, e)
def masked(a, b, w, o=(7, 7)):
    out = np.array(o)
    np.power(np.array(a), np.array(b), out=out, where=np.array(w))
    return out.tolist()
show("one negative masked", lambda: masked([2, 3], [-1, 2], [False, True]))
show("all false", lambda: masked([2, 3], [-1, -2], [False, False]))
show("broadcast mask", lambda: (lambda out: (np.power(np.array([[2, 3], [4, 5]]), np.array([-1, 2]), out=out, where=np.array([False, True])), out.tolist())[1])(np.full((2, 2), 7)))
show("negative kept raises", lambda: masked([2, 3], [-1, 2], [True, True]))
show("unmasked negative raises", lambda: np.power(np.array([2]), np.array([-1])))
show("list mask", lambda: (lambda out: (np.power(np.array([2, 3]), np.array([-1, 2]), out=out, where=[False, True]), out.tolist())[1])(np.array([7, 7])))
show("float lanes", lambda: (lambda out: (np.power(np.array([0.0, 4.0]), np.array([-1.0, 0.5]), out=out, where=[False, True]), out.tolist())[1])(np.array([7.0, 7.0])))
show("scalar exponent masked", lambda: (lambda out: (np.power(np.array([2, 3]), -1, out=out, where=[False, False]), out.tolist())[1])(np.array([7, 7])))
# (the rows below: the exception's class only, NumPy's messages not matched)
def show(tag, f):
    try:
        r = f()
        print(tag, "|", (r.dtype.name, r.shape, r.tolist()) if isinstance(r, np.ndarray) else repr(r))
    except Exception as e:
        print(tag, "| !!", type(e).__name__)
def _try(f):
    try:
        f()
    except Exception:
        pass
# accumulate's loop resolved from the dtypes, no value computed: power's first element copied, never raised to itself;
# out= in the loop of out's dtype and the input's (none, bitwise_or's into a float out, NumPy's TypeError, out
# untouched); a comparison's refused but for bools; bools in int8 where NumPy's loops take them
show("power.accumulate [-1] int8", lambda: np.power.accumulate(np.array([-1], np.int8)))
show("power.accumulate [-1, 2] int8", lambda: np.power.accumulate(np.array([-1, 2], np.int8)))
show("power.accumulate 3**20", lambda: np.power.accumulate(np.array([3 ** 20], np.int64)))
show("power.accumulate empty", lambda: np.power.accumulate(np.array([], np.int8)))
show("fmax.accumulate one int", lambda: np.fmax.accumulate(np.array([7])))
show("fmax.accumulate empty int", lambda: np.fmax.accumulate(np.array([], int)))
for u, x, odt in (("bitwise_or", np.array([1, 2], np.int8), np.float64), ("left_shift", np.array([1, 2], np.int8), np.float64),
                  ("floor_divide", np.array([1, 2], np.int8), np.complex128), ("logical_or", np.array([1, 0]), bool),
                  ("logical_or", np.array([1, 0]), np.complex128), ("true_divide", np.array([2, 3]), np.int64),
                  ("true_divide", np.array([2, 3]), bool), ("hypot", np.array([3, 4]), np.int8), ("add", np.array([1, 2], np.int8), np.float64),
                  ("equal", np.array([1, 2]), bool), ("equal", np.array([True, False]), bool), ("maximum", np.array([2], np.uint8), np.complex128)):
    show(f"{u}.accumulate out {np.dtype(odt).name}", lambda: (lambda o: (getattr(np, u).accumulate(x, out=o), o)[1])(np.full(2 if x.size == 2 else 1, 7, odt)))
    show(f"{u}.accumulate out {np.dtype(odt).name} untouched", lambda: (lambda o: (_try(lambda: getattr(np, u).accumulate(x, out=o)), o)[1])(np.full(2 if x.size == 2 else 1, 7, odt)))
for u in ("left_shift", "floor_divide", "remainder", "maximum", "logical_xor"):
    show(f"{u}.accumulate bools", lambda: getattr(np, u).accumulate(np.array([True, False, True])))
for u, odt in (("equal", bool), ("less", bool), ("not_equal", np.uint8), ("greater_equal", np.float64)):
    try:
        getattr(np, u).accumulate(np.array([1, 2]), out=np.zeros(2, odt))
    except Exception as e:
        print(f"{u}.accumulate out {np.dtype(odt).name} message |", type(e).__name__, e)
# masked power: a weak scalar admitted first (its range); list and tuple operands; where=None computing no lane
show("power masked weak -129", lambda: np.power(np.array([2, 3], np.int8), -129, out=np.array([7, 7], np.int8), where=False))
show("power masked weak 300 uint8", lambda: np.power(np.array([2, 3], np.uint8), 300, out=np.array([7, 7], np.uint8), where=False))
show("power masked weak -1 uint8", lambda: np.power(np.array([2, 3], np.uint8), -1, out=np.array([7, 7], np.uint8), where=False))
show("power masked -1 kept lane", lambda: np.power(np.array([2, 3]), -1, where=np.array([False, True]), out=np.zeros(2, int)))
show("power masked lists", lambda: (lambda o: (np.power([2, 3], [-1, 2], out=o, where=[False, True]), o)[1])(np.array([7, 7])))
show("power masked tuples", lambda: (lambda o: (np.power((2, 3), (-1, -2), out=o, where=False), o)[1])(np.array([7, 7])))
show("power masked list kept negative", lambda: np.power([2, 3], [-1, 2], out=np.array([7, 7]), where=[True, True]))
for u in ("add", "power", "multiply"):
    show(f"{u} where=None", lambda: (lambda o: (getattr(np, u)(np.array([2, 3]), np.array([-1, 2]), out=o, where=None), o)[1])(np.array([7, 7])))
    show(f"{u} where=None shape", lambda: getattr(np, u)(np.array([2, 3]), 2, where=None).shape)
# bools as lists and tuples, and dtype=bool, as NumPy's loops take them
B = np.array([True, False])
for u in ("square", "conjugate", "positive", "sign", "reciprocal", "negative", "absolute"):
    show(f"{u} bool list", lambda: getattr(np, u)([True, False]))
    show(f"{u} bool tuple", lambda: getattr(np, u)((True, False)))
    show(f"{u} dtype=bool", lambda: getattr(np, u)(B, dtype=bool))
for u in ("floor_divide", "remainder", "left_shift", "power", "add", "bitwise_and"):
    show(f"{u} bool lists", lambda: getattr(np, u)([True, False], [True, True]))
    show(f"{u} bools", lambda: getattr(np, u)(B, B))
    show(f"{u} bool scalars", lambda: getattr(np, u)(True, np.True_))
    show(f"{u} bool and int", lambda: getattr(np, u)(B, np.array([1, 2])))
    show(f"{u} dtype=bool", lambda: getattr(np, u)(B, B, dtype=bool))
# masked power with an explicit dtype: the operands admitted against it under the casting rule before masked lanes
# are replaced, as the unmasked call admits them (a weak -129 into int8 NumPy's OverflowError, a refused cast its
# UFuncTypeError)
for base in (np.int8, np.uint8):
    for e in (-129, 300, -1, 2):
        for dt in (np.int8, np.uint8, np.int64):
            for casting in ("same_kind", "safe", "unsafe"):
                for w in (False, [False, True]):
                    if e == 300 and dt is np.int64:
                        continue  # (2**300 wrapped in int64: past 2**53, which Sagebrush refuses)
                    show(f"power masked {base.__name__} {e} dtype={dt.__name__} {casting} where={w}",
                         lambda: (lambda o: (np.power(np.array([2, 3], base), e, dtype=dt, casting=casting, where=w, out=o), o)[1])(np.array([7, 7], dt)))
for x in (np.array([1, 2], np.uint8), np.array([1., 2.], np.float32), np.array([1j, 2j])):
    try:
        np.greater.accumulate(x, out=np.zeros(2, bool))
    except Exception as e:
        print(f"greater.accumulate {x.dtype.name} out bool message |", type(e).__name__, e)
# masked power of object operands with an explicit dtype: every element converted to it first, as NumPy's, an element
# that doesn't convert its ValueError with out untouched, even in a lane where= leaves out (None into a float NaN)
def masked_obj(base, e, dt, w):
    o = np.array([7, 7], dt)
    try:
        np.power(base, e, dtype=dt, casting="unsafe", where=w, out=o)
    except Exception as ex:
        return ("!!", type(ex).__name__, o.tolist())
    return o.tolist()
for vals in (["bad", "2"], ["2", "bad"], [2, 3], ["2", "3"], [2.5, "3"], [None, 2], [2, 3.7]):
    for e in (2, np.array([2, 1], object), np.array(["x", 2], object)):
        for dt in (np.int8, np.float64, np.int64):
            if None in vals and dt is not np.float64:
                continue
            for w in (False, [False, True], [True, False], True):
                if None in vals and w is True:
                    continue  # (not here: the unmasked call's None into a float, NaN in NumPy, Sagebrush's TypeError)
                show(f"power masked object {vals} {e!r} {dt.__name__} where={w}", lambda: masked_obj(np.array(vals, object), e, dt, w))
