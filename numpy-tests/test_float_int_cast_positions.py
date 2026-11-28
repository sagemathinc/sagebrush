# Sagebrush's float-to-integer cast is the same for every element and every layout (#2149): the same value at every
# position of a contiguous or strided array, of each length 1 to 9, gives the same result and the same warning
# decision. (NumPy's vectorized uint32 loop gives some contiguous elements other values, so this program prints only
# whether each array is uniform and which warnings came, which NumPy prints too wherever it agrees with itself.)
import numpy as np
import warnings

for d in ("int8", "int16", "int32", "uint8", "uint16", "bool"):
    for v in (float("nan"), float("inf"), -float("inf"), -3e9, 4.3e9, 70000.0, 300.7, -1.5):
        seen = set()
        for n in range(1, 10):
            for strided in (False, True):
                a = np.full(2 * n, v)[::2] if strided else np.full(n, v)
                with warnings.catch_warnings(record=True) as w:
                    warnings.simplefilter("always")
                    r = a.astype(d).tolist()
                seen.add((tuple(sorted(set(r))), len(w)))
        print(d, repr(v), sorted(seen))
