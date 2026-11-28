# An in-place operator stores its result into the target by NumPy's same_kind rule: a NumPy float64 or int64 scalar
# (not weak, NEP 50) computes in float64 or int64, then float32 -= np.float64(x) and int8 += np.int64(3) cast back, a
# float into an int target or a complex into a float one refused. And the scalar constructors as NumPy's:
# np.float64(0-d array) its scalar, np.complex128 of a sequence an array.
import numpy as np, warnings
warnings.simplefilter("ignore")
def show(tag, f):
    try:
        r = f(); print(tag, "|", (r.dtype.name, r.tolist()) if isinstance(r, np.ndarray) else (type(r).__name__, repr(r)))
    except Exception as e:
        print(tag, "| !!", type(e).__name__)
ops = ["+=", "-=", "*=", "/=", "//=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>="]
for adt in (np.float32, np.float64, np.int8, np.int32, np.int64, np.uint8, np.uint64, np.complex64, np.bool_):
    for s in (np.float64(2.5), np.float32(2.5), np.int64(3), np.int8(3), np.uint8(2), np.complex128(1 + 1j), 2.5, 3, True,
              np.array(2.0), np.array([1, 2], np.int64), np.array([1., 2.])):
        for op in ops:
            def f(op=op):
                a = np.array([4, 6], adt) if adt is not np.bool_ else np.array([True, False])
                ns = {"a": a, "s": s}
                exec(f"a {op} s", {}, ns)
                return ns["a"]
            show(f"{adt.__name__} {op} {s!r}", f)
a = np.array([4., 6.], np.float32)
b = a
b -= np.float64(1.5)
show("in place, same object", lambda: (b is a, a.dtype.name, a.tolist()))
for T in (np.float64, np.float32, np.int64, np.int32, np.int8, np.uint8, np.uint64, np.complex128, np.complex64, np.bool_):
    for nm, v in (("0d f", np.array(2.5)), ("0d i", np.array(3)), ("0d f32", np.array(2.5, np.float32)), ("0d b", np.array(True)),
                  ("1d", np.array([1.5, 2.5])), ("1-elem", np.array([7])), ("2d", np.array([[1, 2]])), ("list", [1, 2]), ("tuple", (0, 3)),
                  ("scalar", np.float32(1.5))):
        # (not here: np.bool_ of a sequence, an array in NumPy; Sagebrush's numpy uses bool() for truth inside)
        if T is np.bool_ and nm in ("1d", "1-elem", "2d", "list", "tuple"):
            continue
        show(f"{T.__name__}({nm})", lambda: T(v))
for T in (np.complex128, np.complex64):
    show(f"{T.__name__}()", lambda: T())
    show(f"{T.__name__}(1, 2)", lambda: T(1, 2))
    show(f"{T.__name__}('1+2j')", lambda: T("1+2j"))
for T in (np.float64, np.float32):
    show(f"{T.__name__}('1.5')", lambda: T("1.5"))
    show(f"{T.__name__} of a 0-d array is a scalar", lambda: isinstance(T(np.array(2.5)), np.generic))
