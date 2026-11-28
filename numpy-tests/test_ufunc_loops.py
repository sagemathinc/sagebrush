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
