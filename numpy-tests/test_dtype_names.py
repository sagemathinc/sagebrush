# dtype.names and dtype.fields, as NumPy 2.5.1's: None for every plain (non-structured) dtype, the case a library
# such as tabulate tests before it reads column names (tabulate's test_numpy_2d_keys).
import numpy as np

# (float16 and bytes dtypes are left out: sagebrush has neither yet)
for spec in ("f8", "f4", "i8", "i4", "i2", "i1", "u8", "u1", "?", "c16", "c8", "U3", "U"):
    try:
        d = np.dtype(spec)
    except Exception as e:
        print(spec, "->", type(e).__name__)
        continue
    print(spec, "names", repr(d.names), "fields", repr(d.fields))
for a in (np.arange(6).reshape(2, 3), np.zeros((2, 2)), np.array(["ab", "c"]), np.array([True]), np.array(1.5)):
    print(a.dtype, "array dtype names", repr(a.dtype.names), "fields", repr(a.dtype.fields))
print("hasattr names", hasattr(np.dtype("f8"), "names"), "hasattr fields", hasattr(np.dtype("f8"), "fields"))
# (what tabulate does with headers="keys" on a 2-D array: names is None, so the column indices become the keys)
a = np.arange(6).reshape(2, 3)
names = a.dtype.names
print("keys", list(range(a.shape[1])) if names is None else list(names))
