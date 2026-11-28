# fill of an integer array with a float, as NumPy's: a Python float by int() (NaN a ValueError, infinity and a value
# past the dtype an OverflowError, a fraction truncated), for int64 and uint64 as for the small integers; a NumPy float
# likewise, except into uint64 (cast; not here: a negative one there needs uint64 values past 2**53).
import numpy as np

for d in (np.int64, np.uint64, np.int8, np.int32):
    for v in (float("nan"), float("inf"), -float("inf"), 1e20, -1e20, 2.0**63, 2.0**64, -1.0, 2.5, -2.5, np.float64("nan"), np.float64(1e20), np.float32(2.5), np.float64(2.0**63), np.float64(-1.0)):
        if d is np.uint64 and isinstance(v, np.floating) and v < 0:
            continue
        a = np.zeros(2, d)
        try:
            a.fill(v)
            print("fill", d.__name__, repr(v), a.tolist())
        except Exception as e:
            print("fill", d.__name__, repr(v), type(e).__name__, e)
