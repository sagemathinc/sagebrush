# x ** y for float arrays as NumPy's: its float power loop, given one
# exponent for the whole loop (a scalar or an array of one element),
# computes 1 / x, 1, sqrt(x), x and x * x for -1, 0, 0.5, 1 and 2, whose
# last bits differ from pow's in about one element in 1,000; any other
# exponent, and an array of exponents, is pow. Each result as its dtype,
# shape and a digest of its bytes, compared line by line with CPython's
# NumPy (test/numpy-power-exponent.test.ts).
import numpy as np

x = np.linspace(-10.0, 10.0, 20001) * 1.0000001
x[::97] = np.exp(np.linspace(-700.0, 700.0, len(x[::97])))
x[1::101] = np.exp(np.linspace(-745.0, -708.0, len(x[1::101])))  # subnormals
x[:8] = [0.0, -0.0, np.inf, -np.inf, np.nan, 1.0, -1.0, 5e-324]
f = np.linspace(-10.0, 10.0, 4001).astype(np.float32) * np.float32(1.0000001)
M = x[:20000].reshape(200, 100)


def digest(r):
    r = np.asarray(r)
    # (NaNs as one NaN here, their signs below)
    r = np.where(np.isnan(r), r.dtype.type(np.nan), r)
    # (the bytes as one integer, modulo a Mersenne prime: exact in both engines)
    return f"{r.dtype} {r.shape} {int.from_bytes(np.ascontiguousarray(r).tobytes(), 'little') % (2**61 - 1):016x}"


def show(label, fn):
    with np.errstate(all="ignore"):
        try:
            print(label, digest(fn()))
        except Exception as e:
            print(label, type(e).__name__, e)


for k in [2, -1, 0, 1, 2.0, -1.0, 0.5, 0.0, -0.0, 1.0, 3, -2, 0.25, -0.5, 1.5, True, False]:
    show(f"x ** {k!r}", lambda: x ** k)
    show(f"np.power(x, {k!r})", lambda: np.power(x, k))
    if k in (2, -1, 0, 1, 0.5, True, False):  # (others: NumPy's powf, not pow)
        show(f"f ** {k!r}", lambda: f ** k)
    show(f"M.T ** {k!r}", lambda: M.T ** k)
    show(f"x[::3] ** {k!r}", lambda: x[::3] ** k)
for name, e in [("np.float64(2)", np.float64(2)), ("np.float32(2)", np.float32(2)), ("np.int64(2)", np.int64(2)),
                ("np.array(2.0)", np.array(2.0)), ("np.array([2.0])", np.array([2.0])), ("np.array([[0.5]])", np.array([[0.5]])),
                ("np.array([-1])", np.array([-1])), ("np.full(20001, 2.0)", np.full(20001, 2.0)),
                ("np.full((200, 1), 2.0)", np.full((200, 1), 2.0)), ("np.full((1, 100), 0.5)", np.full((1, 100), 0.5))]:
    base = M if np.ndim(e) == 2 else x
    show(f"base ** {name}", lambda: base ** e)
    show(f"np.power(base, {name})", lambda: np.power(base, e))
# integer and bool bases, a float exponent: a float64 loop
show("arange ** 2.0", lambda: np.arange(-50, 50) ** 2.0)
show("arange ** 0.5", lambda: np.arange(0, 100) ** 0.5)
show("bool ** -1.0", lambda: np.array([True, False]) ** -1.0)
# out=, in place, where=
o = np.empty_like(x)
show("np.power(x, 2, out=o)", lambda: np.power(x, 2, out=o))
y = x.copy()
with np.errstate(all="ignore"):
    y **= 2
show("y **= 2", lambda: y)
z = x.copy()
with np.errstate(all="ignore"):
    z **= 0.5
show("z **= 0.5", lambda: z)
show("where", lambda: np.power(x, 2, where=x > 0, out=np.zeros_like(x)))
# NumPy scalars and 0-d arrays as bases
for v in [1.0000001, 3.3, 1e-160, 7e200, -2.5]:
    for k in [2, -1, 0.5]:
        show(f"np.float64({v}) ** {k}", lambda: np.float64(v) ** k)
        show(f"np.array({v}) ** {k}", lambda: np.array(v) ** k)
        show(f"np.array([{v}]) ** {k}", lambda: np.array([v]) ** k)
# The signs of NaN results (read from the bytes): pow's invalid case is glibc's 0 / 0, sqrt's the
# hardware's, both negative on x86; NaN operands keep theirs
with np.errstate(all="ignore"):
    neg = np.array([-2.5, -1e-300, -7e200, -np.inf, np.nan, -np.nan])
    for k in [0.5, 0.25, -0.5, 1.5, 2, -1, 0, 1, np.nan, -np.nan]:
        for label, r in [("array", neg ** k), ("power", np.power(neg, np.full(6, k)))]:
            print("sign", label, k, [b >> 7 for b in r.tobytes()[7::8]], np.isnan(r).astype(int).tolist())
    for v in [-2.5, -1e-300]:
        print("sign scalar", v, [b >> 7 for b in np.array(np.float64(v) ** 0.5).tobytes()[7:]], [b >> 7 for b in np.array(np.float64(v) ** 1.5).tobytes()[7:]])
