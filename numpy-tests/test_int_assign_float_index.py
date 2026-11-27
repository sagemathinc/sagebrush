# A float into an integer array's places: a Python float by int() wherever it goes, a NumPy float by int() into a
# basic index's places and cast (wrapping) into a fancy or mask index's, as NumPy's (#2149 meets this PR's admission).
import numpy as np
for v in (300.0, np.float64(300.0), np.float32(70000.0), 2.5, np.float64(-1.5), float('nan')):
    for k in ([0, 1], np.array([True, True]), slice(None), 0):
        for d in (np.int8, np.uint8, np.int32):
            a = np.zeros(2, d)
            try:
                a[k] = v; print(repr(v), type(k).__name__, d.__name__, a.tolist())
            except Exception as e:
                print(repr(v), type(k).__name__, d.__name__, type(e).__name__, e)
