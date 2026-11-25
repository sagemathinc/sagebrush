# ndarray.fill into int64 and uint64 arrays: the value admitted as slice assignment admits it (NumPy's
# OverflowError for an int out of range, the exact int otherwise), not through a double first. The values are
# ones a double holds exactly (Sagebrush's int64 and uint64 are doubles, and it refuses the others, as slice
# assignment does).
import numpy as np


def run(dt, v, how):
    a = np.zeros(2, dtype=dt)
    try:
        if how == "fill":
            a.fill(v)
        else:
            a[:] = v
        return repr(a.tolist())
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)


values = [0, 1, -1, 2 ** 53, -2 ** 53, 2 ** 62, -2 ** 63, 2 ** 63, 2 ** 64 - 2048, 2 ** 63 - 1024, 2 ** 64, -2 ** 63 - 1,
          2 ** 70, -2 ** 70, True, 2.0, 2.5, np.int64(5), np.uint64(2 ** 63), np.int8(7), np.float64(3.0)]
for dt in ("int64", "uint64"):
    for v in values:
        print(dt, repr(v), "| fill", run(dt, v, "fill"), "| slice", run(dt, v, "slice"))
