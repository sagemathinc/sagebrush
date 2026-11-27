import zlib

import numpy as np

# np.unique of a 1-D float array and its signed zeros: with return_index NumPy keeps each group's first occurrence
# (its stable sort), and so does Sagebrush, here compared with NumPy. Without return_index NumPy keeps whichever zero
# its SIMD sort leaves first, which varies with the CPU; Sagebrush keeps the first occurrence there too (a stated
# divergence), checked against Sagebrush's own rule and printed the same under NumPy. equal_nan=False keeps each NaN


def bits(x):
    return zlib.crc32(np.ascontiguousarray(x).tobytes())


REAL = not hasattr(np, "_np")  # (Sagebrush's numpy has its core module as _np)
rs = np.random.RandomState(1923)
rule = True
for dt in (np.float64, np.float32):
    for n in (2, 5, 16, 17, 63, 64, 100, 5000):
        a = rs.choice(np.array([0.0, -0.0, 1.0, -1.0, 2.5, np.nan]), n).astype(dt)
        if n == 2:
            a = np.array([0.0, -0.0], dtype=dt)
        # compared with NumPy: the stable path, and everything but the zero's sign
        u, i, v, c = np.unique(a, return_index=True, return_inverse=True, return_counts=True)
        print(dt.__name__, n, u.shape, bits(u), bits(i), bits(v), bits(c), np.signbit(u).tolist()[:6])
        plain = np.unique(a)
        print(" plain", plain.shape, np.array_equal(plain, u, equal_nan=True), bits(np.unique(a, return_counts=True)[1]), bits(np.unique(a, return_inverse=True)[1]))
        # one kind of zero only: the same bits as NumPy's
        for z in (0.0, -0.0):
            b = np.where(a == 0, dt(z), a).astype(dt)
            print(" only", z, bits(np.unique(b)), bits(np.unique(b, return_counts=True)[0]))
        # Sagebrush's own rule: the kept zero is the first zero's, so unique(a) == unique(a, return_index=True)[0]
        # and unique(a, axis=0), bit for bit
        if not REAL:
            first = [x for x in a.tolist() if x == 0]
            zs = plain[plain == 0]
            ok = (not first or np.signbit(zs[0]) == np.signbit(dt(first[0])))
            ok = ok and bits(plain) == bits(u) and bits(np.unique(a, axis=0)) == bits(u)
            ok = ok and bits(np.unique(a, return_counts=True)[0]) == bits(u) and bits(np.unique(a, return_inverse=True)[0]) == bits(u)
            rule = rule and bool(ok)
print("each kept zero is the first occurrence's, in every path (Sagebrush; NumPy's plain path may keep another's)", rule)

# the examples from the issue: NumPy's own answers here are its sort's, so only the stable path is compared
for vals in ([0.0, -0.0], [-0.0, 0.0], [0.0, -0.0, 1.0], [3.0, 1.0, -0.0, 3.0, 0.0]):
    a = np.array(vals)
    u, i = np.unique(a, return_index=True)
    print(vals, np.signbit(u).tolist(), i.tolist(), np.unique(a, return_counts=True)[1].tolist())

# equal_nan=False: each NaN its own
nan = np.nan
for vals in ([nan, 1.0, nan, 1.0], [nan], [nan, nan, -0.0, 2.0], [1.0, 2.0]):
    a = np.array(vals)
    print("equal_nan False", vals, np.unique(a, equal_nan=False).tolist(), [x.tolist() for x in np.unique(a, equal_nan=False, return_counts=True)])
print("equal_nan False float32", np.unique(np.array([nan, 1, nan], dtype=np.float32), equal_nan=False).tolist())
