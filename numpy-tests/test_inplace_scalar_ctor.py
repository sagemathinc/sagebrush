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
# a bool target squared refused (NumPy's square loop of bools is int8's); the cast checked before computing, so the
# refusal never depends on the values; the constructors' array-likes: a range, an object with __array__
for v in (2, np.int64(2), np.array(2), True, 3):
    def sq(v=v):
        a = np.array([True, False]); a **= v; return a
    show(f"bool **= {v!r}", sq)
for vals in ([False, True], [True, True]):
    for s in (np.uint64(1), np.int64(1), 1, np.float64(1.0)):
        def sub(vals=vals, s=s):
            a = np.array(vals); a -= s; return a
        show(f"bool {vals} -= {s!r}", sub)
class AL:
    def __array__(self, dtype=None, copy=None):
        return np.array([1, 2], dtype=dtype)
for T in (np.float64, np.float32, np.complex128, np.complex64):
    show(f"{T.__name__}(range(3))", lambda: T(range(3)))
    show(f"{T.__name__}(__array__)", lambda: T(AL()))
    show(f"{T.__name__}(range(0))", lambda: T(range(0)))
# the refusal's message, NumPy's ufunc names (divide, not true_divide)
for adt in (np.int8, np.int64, np.uint8, np.float32, np.bool_):
    for op in ("/=", "//=", "**=", "-=", "%=", "+=", "*="):
        for s in (2.5, np.float64(2.5), 1j):
            a = np.ones(2, adt)
            try:
                exec(f"a {op} s", {}, {"a": a, "s": s})
                print("in place", adt.__name__, op, repr(s), "| ok")
            except Exception as e:
                print("in place", adt.__name__, op, repr(s), "|", type(e).__name__, e)
# two arguments: each a real number (NumPy scalars too), else NumPy's TypeError and message
for T in (np.complex64, np.complex128):
    for args in ((1 + 1j, 2), (1, 2 + 0j), (1, 2), (1.5, -2.5), ("1", 2), (1, "2"), (np.float32(1), 2), (np.complex64(1), 0), (None, 1), (1, None), (True, 1)):
        try:
            print(f"{T.__name__}{args!r} |", repr(T(*args)))
        except Exception as e:
            print(f"{T.__name__}{args!r} |", type(e).__name__, e)
# a plain sequence object (__len__ and __getitem__) converted as NumPy's sequence protocol reads it
class Seq:
    def __len__(self): return 2
    def __getitem__(self, i):
        if i >= 2: raise IndexError
        return [1.5, 2.5][i]
for T in (np.float64, np.float32, np.complex128, np.complex64):
    show(f"{T.__name__}(Seq())", lambda: T(Seq()))
# complex64's repr and str in float32's digits
for v in (1 / 3 + 1j, 1j, -0.0 + 1j, 0j, 1 / 3, complex(float("nan"), 1), complex(float("inf"), -float("inf")), 1e20 + 1e-20j, -1 - 1j,
          123456789 + 0.1j, complex(-0.0, -0.0), 0.1 + 0.2j, complex(0.0, -0.0), complex(1, float("nan"))):
    for T in (np.complex64, np.complex128):
        print(f"{T.__name__}({v!r}) |", repr(T(v)), str(T(v)), repr(T(np.array(v))), repr(np.array([v], T)[0]))
# a scalar type never changes its argument: the value it was given keeps its own type (np.complex64(v) once retyped v)
for T, v in ((np.complex64, 1 / 3 + 1j), (np.complex128, 2 + 1j), (np.float64, 2.5), (np.float32, 2.5), (np.int64, 7), (np.int8, 7), (np.uint8, 7),
             (np.bool_, True), (np.complex128, 2.5), (np.float64, np.float32(1.5)), (np.complex64, np.complex128(1 + 2j)), (np.float64, np.float64(3.0))):
    before = (type(v).__name__, repr(v))
    r = T(v)
    print("argument kept", T.__name__, before, (type(v).__name__, repr(v)), r is v)
# two parts, as NumPy admits them: NumPy integer, floating and bool scalars too; an np.complex64 (its real part
# bringing both parts, its imaginary part only its real one); not np.complex128 or np.str_ (np.bytes_ Sagebrush lacks)
for T in (np.complex64, np.complex128):
    for p in (np.complex64(1), np.complex64(1 + 1j), np.complex128(1), np.complex128(1 + 2j), np.str_("1"), np.float32(2),
              np.float64(2), np.int8(3), np.uint64(4), np.bool_(True)):
        for args in ((p, 0), (0, p), (p, 2.5)):
            try:
                print(f"{T.__name__}{args!r} |", repr(T(*args)))
            except Exception as e:
                print(f"{T.__name__}{args!r} |", type(e).__name__, e)
    for a, b in ((np.complex64(1 + 1j), np.complex64(3 + 4j)), (2, np.complex64(3 + 4j)), (np.complex64(1 - 1j), np.float32(1))):
        print(f"{T.__name__}({a!r}, {b!r}) |", repr(T(a, b)))
# a plain sequence read until IndexError, its __len__ neither truncating nor extending it
class SeqN:
    def __init__(self, n, items): self.n, self.items = n, items
    def __len__(self): return self.n
    def __getitem__(self, i):
        if i >= len(self.items): raise IndexError
        return self.items[i]
for T in (np.float64, np.float32, np.complex128, np.complex64):
    for n, it in ((1, [1.5, 2.5, 3.5]), (5, [1.5, 2.5]), (0, [1.5]), (2, [1.5, 2.5]), (3, [])):
        show(f"{T.__name__}(SeqN(len={n}, {it}))", lambda: T(SeqN(n, it)))
# two parts' signed zeros kept (the imaginary part as given, no +0.0 seed), and complex64's parts rounded to float32,
# exact values as hex; a plain sequence with a negative __len__ is no sequence: NumPy's error for an unconvertible scalar
for T in (np.complex64, np.complex128):
    for a, b in ((0, -0.0), (-0.0, 0), (-0.0, -0.0), (0.0, 0.0), (np.complex64(1 + 0j), -0.0), (np.complex64(complex(1, -0.0)), -0.0),
                 (np.complex64(complex(1, -0.0)), 0.0), (np.complex64(1 + 0j), np.complex64(complex(-0.0, 1))), (0.1, 0.2), (1 / 3, 2 / 3),
                 (np.float64(0.1), np.float64(0.2)), (16777217, 0)):
        z = T(a, b)
        print(f"parts {T.__name__}({a!r}, {b!r}) |", repr(z), float(z.real).hex(), float(z.imag).hex())
    for v in (0.1 + 0.2j, 1 / 3 + 2j / 3, complex(16777217, -0.0)):
        z = T(v)
        print(f"one part {T.__name__}({v!r}) |", float(z.real).hex(), float(z.imag).hex())
class NegLen:
    def __len__(self): return -1
    def __getitem__(self, i):
        if i >= 2: raise IndexError
        return 1.5
for T in (np.float64, np.float32, np.complex128, np.complex64):
    try:
        print(f"{T.__name__}(NegLen()) |", repr(T(NegLen())))
    except Exception as e:
        print(f"{T.__name__}(NegLen()) |", type(e).__name__, e)
# a 0-d array as either part, as NumPy takes it: as the real part both its parts (an imaginary part added), as the
# imaginary part its float(); a larger array NumPy's TypeError; a subclass of complex64 rounds to float32 too
for T in (np.complex64, np.complex128):
    for p in (np.array(2.0), np.array(2), np.array(True), np.array(2.0, np.float32), np.array(1 + 1j), np.array(1 + 1j, np.complex64),
              np.array([2.0]), np.array("2"), np.array(-0.0)):
        for args in ((2, p), (p, 2), (p, p)):
            try:
                z = T(*args)
                print(f"0-d part {T.__name__}{args!r} |", type(z).__name__, repr(z), float(z.real).hex(), float(z.imag).hex())
            except Exception as e:
                print(f"0-d part {T.__name__}{args!r} |", type(e).__name__, e)
class C64(np.complex64): pass
class C128(np.complex128): pass
for nm, f in (("C64(1/3, 1/7)", lambda: C64(1 / 3, 1 / 7)), ("C64(1/3+1j/7)", lambda: C64(1 / 3 + 1j / 7)), ("C128(1/3, 1/7)", lambda: C128(1 / 3, 1 / 7))):
    z = f()
    print(f"subclass {nm} |", type(z).__name__, float(z.real).hex(), float(z.imag).hex())
print("float32 rounding |", float(np.complex64(0.1, 0.2).real), float(np.complex64(0.1, 0.2).imag))
# an object 0-d array as either part: its item as the real part through complex() (both its parts), as the imaginary
# part a NumPy complex scalar's real part, else its float(); subclasses too
class C64Child(C64): pass
for T in (np.complex64, np.complex128, C64, C64Child, C128):
    for it in (1.5, 2, True, 1 + 1j, np.float32(2.5), np.int8(3), np.complex64(1 + 1j), np.complex128(1 + 2j), "2", "1+2j", None, -0.0, [1.0]):
        o = np.empty((), dtype=object)
        o[()] = it
        for args in ((o, 2), (2, o)):
            try:
                z = T(*args)
                print(f"object part {T.__name__}{('obj ' + repr(it), args[1]) if args[0] is o else (args[0], 'obj ' + repr(it))} |", type(z).__name__, float(z.real).hex(), float(z.imag).hex())
            except Exception as e:
                print(f"object part {T.__name__}{('obj ' + repr(it), args[1]) if args[0] is o else (args[0], 'obj ' + repr(it))} |", type(e).__name__, e)
