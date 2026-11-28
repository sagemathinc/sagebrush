import zlib

import numpy as np

# np.unique with an axis: the distinct sub-arrays along it, sorted lexicographically (NaN last), with index,
# inverse and counts referring to those sub-arrays; a sub-array holding a NaN equals no other


def show(name, f):
    try:
        r = f()
        rs = r if isinstance(r, tuple) else (r,)
        print(name, "->", " | ".join(f"{x.tolist()!r} {x.dtype} {x.shape}" for x in rs))
    except (ValueError, IndexError, TypeError) as e:
        print(name, type(e).__name__, str(e))


a = np.array([[1, 0, 0], [1, 0, 0], [2, 3, 4]])
for ax in (0, 1, -1, -2):
    show(f"2-d axis {ax}", lambda: np.unique(a, axis=ax))
    show(f"2-d axis {ax} all", lambda: np.unique(a, axis=ax, return_index=True, return_inverse=True, return_counts=True))
show("index only", lambda: np.unique(a, axis=0, return_index=True))
show("inverse only", lambda: np.unique(a, axis=1, return_inverse=True))
show("counts only", lambda: np.unique(a, axis=0, return_counts=True))

c = np.arange(24).reshape(2, 3, 4) % 3
for ax in (0, 1, 2, -1):
    show(f"3-d axis {ax}", lambda: np.unique(c, axis=ax, return_index=True, return_inverse=True, return_counts=True))
show("3-d reconstruct", lambda: np.take(*np.unique(c, axis=1, return_inverse=True), axis=1))

# order: lexicographic over the flattened sub-arrays, numbers before NaN; equal rows merged, the first kept
f = np.array([[1.0, np.nan], [1.0, np.nan], [0.0, 2.0], [1.0, -1.0], [np.nan, 0.0], [1.0, -1.0], [-1.5, 9.0]])
show("float rows with NaN", lambda: np.unique(f, axis=0, return_index=True, return_inverse=True, return_counts=True))
show("float rows equal_nan False", lambda: np.unique(f, axis=0, equal_nan=False))
show("float columns", lambda: np.unique(f.T, axis=1))
show("negative zero", lambda: np.unique(np.array([[0.0, 1.0], [-0.0, 1.0]]), axis=0, return_index=True))
show("complex rows", lambda: np.unique(np.array([[1 + 1j, 2], [1 + 0j, 3], [1 + 1j, 2], [0.5 + 9j, 0]]), axis=0, return_counts=True))
show("complex NaN parts", lambda: np.unique(np.array([[complex(1, np.nan)], [complex(np.nan, 0)], [1 + 1j], [complex(1, np.nan)]]), axis=0))
show("bool rows", lambda: np.unique(np.array([[True, False], [False, True], [True, False]]), axis=0, return_inverse=True))
show("string rows", lambda: np.unique(np.array([["b", "a"], ["a", "c"], ["b", "a"], ["a", "b"]]), axis=0))
show("int8 rows", lambda: np.unique(np.array([[-1, 2], [3, 4], [-1, 2]], dtype=np.int8), axis=0))
show("uint64 columns", lambda: np.unique(np.array([[5, 1, 5], [2, 0, 2]], dtype=np.uint64), axis=1))

# the shapes: an empty axis, empty sub-arrays, one row, a 1-d array (the plain path)
show("no rows", lambda: np.unique(np.zeros((0, 3)), axis=0, return_index=True, return_inverse=True, return_counts=True))
show("empty sub-arrays", lambda: np.unique(np.zeros((3, 0)), axis=0, return_inverse=True, return_counts=True))
show("one row", lambda: np.unique(np.array([[4, 5]]), axis=0, return_inverse=True))
show("1-d axis 0", lambda: np.unique(np.array([3, 1, np.nan, 3, np.nan]), axis=0, return_inverse=True))
show("1-d axis -1", lambda: np.unique(np.array([3, 1, 3]), axis=-1, return_counts=True))
show("list input", lambda: np.unique([[1, 2], [1, 2], [0, 0]], axis=0))

# a larger case, compared by checksum: rows from a small alphabet, many repeats
rs = np.random.RandomState(7)
big = rs.randint(0, 3, size=(500, 4)).astype(np.float64)
big[rs.randint(0, 500, 20), rs.randint(0, 4, 20)] = np.nan
for ax in (0, 1):
    u, i, v, n = np.unique(big, axis=ax, return_index=True, return_inverse=True, return_counts=True)
    print("big", ax, u.shape, zlib.crc32(np.ascontiguousarray(u).tobytes()), zlib.crc32(i.tobytes()), zlib.crc32(v.tobytes()), zlib.crc32(n.tobytes()))

# an axis out of range: an IndexError (NumPy's AxisError is one) with NumPy's message; a 1-d array's axis is
# checked too, before its plain path, and a 0-d array has no axis at all
for name, arr, ax in [("2-d", a, 2), ("2-d", a, -3), ("1-d", [3, 1, 3], 1), ("1-d", [3, 1, 3], 2), ("1-d", [3, 1, 3], -2),
                      ("1-d with extras", np.array([3.0, 1.0]), 1), ("0-d", np.float64(2.0), 0)]:
    try:
        r = np.unique(arr, axis=ax, return_counts=name.endswith("extras"))
        print(name, "axis", ax, "no error", r)
    except IndexError as e:
        print(name, "axis", ax, "IndexError:", e)

# signed zeros in rows that compare equal, past insertion-sort sizes: the distinct rows, counts and inverse are
# NumPy's; with return_index, the kept rows are NumPy's too (its stable sort). Without return_index NumPy's sort is
# unstable and may keep another member's zeros: Sagebrush keeps the first occurrence's, a stated divergence, so
# that line is checked against Sagebrush's own rule (each kept row is the first occurrence's bits) and printed
# the same under NumPy
REAL = not hasattr(np, "_np")  # (Sagebrush's numpy has its core module as _np)
rs = np.random.RandomState(9)
B = np.round(rs.standard_normal((2000, 2)), 0)
B[::7, 0] = -0.0
u = np.unique(B, axis=0)
ui, idx, inv, cnt = np.unique(B, axis=0, return_index=True, return_inverse=True, return_counts=True)
print("signed zeros", u.shape, np.array_equal(u, ui), zlib.crc32(idx.tobytes()), zlib.crc32(inv.tobytes()), zlib.crc32(cnt.tobytes()))
print("signed zeros with return_index: the kept rows' bits", zlib.crc32(np.ascontiguousarray(ui).tobytes()), np.array_equal(np.signbit(ui), np.signbit(B[idx])))
first = REAL or (np.array_equal(np.signbit(u), np.signbit(B[idx])) and np.array_equal(np.signbit(np.unique(B, axis=0, return_counts=True)[0]), np.signbit(B[idx])))
print("signed zeros without return_index: each kept row is the first occurrence's (Sagebrush; NumPy may keep another's)", first)
