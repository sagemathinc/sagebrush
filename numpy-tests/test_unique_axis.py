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

# an axis out of range: an IndexError (NumPy's AxisError is one) with NumPy's message
for ax in (2, -3):
    try:
        np.unique(a, axis=ax)
        print("axis", ax, "no error")
    except IndexError as e:
        print("axis", ax, "IndexError:", e)
