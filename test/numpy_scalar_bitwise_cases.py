# NumPy's integer and bool scalars under the bitwise operators, ~ and **, and the integer kernels that wrap
# (power, square and 32-bit multiply); printed as "case | type repr", compared with NumPy 2.5.5's output in
# test/numpy-scalar-bitwise.test.ts. (Results past 2**53 in int64 and uint64 are left out: refused here.)
import numpy as np, operator as op
def show(tag, f):
    try:
        r = f(); print(tag, "|", type(r).__name__, repr(r))
    except Exception as e:
        print(tag, "| !!", type(e).__name__)
ops = {"lshift": op.lshift, "rshift": op.rshift, "and": op.and_, "or": op.or_, "xor": op.xor, "pow": op.pow}
skip = {"int64 pow ps", "uint64 pow ps", "uint64 inv"}
for tn in ["int8", "uint8", "int16", "uint32", "int64", "uint64", "bool_"]:
    t = getattr(np, tn)
    a, b = (t(100), t(3)) if tn != "bool_" else (t(True), t(True))
    for on, f in ops.items():
        for k, g in (("ss", lambda: f(a, b)), ("sp", lambda: f(a, 3)), ("ps", lambda: f(3, a))):
            if f"{tn} {on} {k}" not in skip:
                show(f"{tn} {on} {k}", g)
    if f"{tn} inv" not in skip:
        show(f"{tn} inv", lambda: ~a)
show("int8 64 << 1", lambda: np.int8(64) << np.int8(1))
show("int8 3 ** 100", lambda: 3 ** np.int8(100))
show("int16 3 ** 100", lambda: 3 ** np.int16(100))
show("uint32 3 ** 100", lambda: 3 ** np.uint32(100))
for dt in ["int8", "int16", "int32", "uint8", "uint32"]:
    show(f"{dt} array ** 100", lambda: np.array([3], dt) ** 100)
show("uint8 array ** uint8 200", lambda: np.array([3], np.uint8) ** np.array([200], np.uint8))
show("int32 array ** 2", lambda: np.array([2**31 - 1], np.int32) ** 2)
show("uint32 array ** 2", lambda: np.array([4294967295], np.uint32) ** 2)
show("uint32 array ** 3", lambda: np.array([4294967295], np.uint32) ** 3)
show("int32 square", lambda: np.square(np.array([2**31 - 1, -2**31, 46341], np.int32)))
show("int32 multiply", lambda: np.array([2**31 - 1, 65537], np.int32) * np.int32(2**31 - 1))
show("uint32 multiply", lambda: np.array([4294967295], np.uint32) * np.uint32(4294967295))
show("int32 multiply strided", lambda: np.array([[1, 2], [3, 4]], np.int32)[:, ::-1] * np.int32(2**30 + 1))
show("bool left_shift", lambda: np.left_shift(np.array([True, False]), np.array([True, True])))
show("bool right_shift", lambda: np.right_shift(np.True_, np.True_))
# (shift counts below 0 or at least the width: 0 for <<, 0 or -1 by the sign for >>, as NumPy's npy_lshift and
# npy_rshift give them, for scalars and arrays)
for dt in ["int8", "int16", "int32", "uint8", "uint32"]:
    t = getattr(np, dt)
    bits = 8 * np.dtype(dt).itemsize
    for c in ([-1, bits, bits + 1, 2 * bits] if dt.startswith("int") else [bits, bits + 1]):
        show(f"{dt} 5 << {c}", lambda: t(5) << t(c))
        show(f"{dt} 5 >> {c}", lambda: t(5) >> t(c))
        if dt.startswith("int"):
            show(f"{dt} -7 >> {c}", lambda: t(-7) >> t(c))
show("int8 -7 >> -1 (int)", lambda: np.int8(-7) >> -1)
show("3 >> int8 -7", lambda: 3 >> np.int8(-7))
show("-1 >> int32 max", lambda: -1 >> np.int32(2**31 - 1))
show("int8 array >> -1", lambda: np.right_shift(np.array([5, -7, -1, 100], np.int8), -1))
show("int8 array << -1", lambda: np.left_shift(np.array([5, -7, -1, 100], np.int8), -1))
show("int16 array >> 16", lambda: np.array([5, -7], np.int16) >> np.array([16, 17], np.int16))
# (no float or complex loop for the bitwise ufuncs and the shifts: NumPy's TypeError, also where the integer
# types promote to a float, int8 with uint64)
show("int8 << 1.5", lambda: np.int8(3) << 1.5)
show("1.5 >> int8", lambda: 1.5 >> np.int8(1))
show("int8 & 1.0", lambda: np.int8(3) & 1.0)
show("int8 & uint64", lambda: np.int8(3) & np.uint64(2))
show("uint64 | int16", lambda: np.uint64(1) | np.int16(2))
show("int8 ^ 1j", lambda: np.int8(3) ^ 1j)
show("uint8 | float32", lambda: np.uint8(1) | np.float32(1))
show("bool_ ^ 1.0", lambda: np.True_ ^ 1.0)
show("float64 << int8", lambda: np.float64(2.0) << np.int8(1))
show("~float64", lambda: ~np.float64(1.5))
