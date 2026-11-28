# A builtin bool, float or complex on the left of a NumPy scalar: NumPy's scalars are no int (or float)
# subclasses there, so the builtin's method declines them and the scalar's reflected method answers. Printed as
# "case | type repr", compared with NumPy 2.5.5's output in test/numpy-scalar-builtin-left.test.ts.
import numpy as np
def show(tag, f):
    try:
        r = f(); print(tag, "|", type(r).__name__, repr(r))
    except Exception as e:
        print(tag, "| !!", type(e).__name__)
for tn in ["int8", "uint8", "int16", "uint32", "int64", "bool_", "float32", "float64"]:
    t = getattr(np, tn)
    v = t(3) if tn != "bool_" else t(True)
    for ln, left in (("True", True), ("False", False), ("1.5", 1.5), ("2j", 2j)):
        for on, f in (("+", lambda a, b: a + b), ("-", lambda a, b: a - b), ("*", lambda a, b: a * b),
                      ("/", lambda a, b: a / b), ("//", lambda a, b: a // b), ("%", lambda a, b: a % b),
                      ("**", lambda a, b: a ** b), ("&", lambda a, b: a & b), ("<<", lambda a, b: a << b)):
            if ln == "2j" and on in ("//", "%"):
                continue
            if ln == "2j" and tn == "float32" and on == "/":
                continue  # (complex64's repr prints double digits here: #2378, not this test's)
            show(f"{ln} {on} {tn}", lambda: f(left, v))
show("True - uint8(3)", lambda: True - np.uint8(3))
show("True + bool_", lambda: True + np.bool_(True))
show("True - bool_", lambda: True - np.bool_(True))
show("3 - uint8(5)", lambda: 3 - np.uint8(5))
show("True + 1", lambda: True + 1)
show("1.5 + 2", lambda: 1.5 + 2)
