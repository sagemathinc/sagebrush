# NumPy scalars' tobytes() (np.float64 had none): compared with CPython's
# NumPy (test/numpy-scalar-tobytes.test.ts).
import numpy as np

for v in [np.float64(1.5), np.float64(-0.0), np.float64(np.nan), np.float64(-np.nan), np.float64(np.inf), np.float32(1.5),
          np.float32(-np.nan), np.int64(-3), np.int32(7), np.int8(-1), np.uint8(200), np.uint64(2**53 - 5), np.bool_(True),
          np.bool_(False), np.complex128(1 + 2j), np.complex64(-1.5j)]:
    print(type(v).__name__, v.tobytes().hex(), v.tobytes(order="F").hex(), v.tobytes() == np.array(v).tobytes())

# the order argument, read and refused as NumPy's, for arrays and scalars
a = np.arange(6, dtype=np.int8).reshape(2, 3)
for name, v in {"C-contiguous": a, "a.T": a.T, "asfortranarray": np.asfortranarray(a), "a[:, ::2]": a[:, ::2], "a.T[::2]": a.T[::2], "a.T[:, ::-1]": a.T[:, ::-1], "int32 scalar": np.int32(7)}.items():
    row = []
    for o in ["C", "F", "A", "K", "c", "f", "a", "k", None, b"C", b"F", 3, 1.5, "", "X", "CF", b"X", b""]:
        try:
            row.append(f"{o!r}:{v.tobytes(order=o).hex()}")
        except Exception as e:
            row.append(f"{o!r}:{type(e).__name__}:{e}")
    print(name, " ".join(row))
