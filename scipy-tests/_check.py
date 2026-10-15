"""check(): print numbers that must agree with SciPy's within a tolerance
(scipy-tests/run.py compares these lines numerically, the others exactly)."""
import json
import numpy as np


def check(name, values, rtol, atol=0.0):
    vals = [float(v) for v in np.asarray(values, dtype=float).ravel().tolist()]
    print("CHECK " + json.dumps({"name": name, "rtol": rtol, "atol": atol,
                                 "values": [v if v == v else None for v in vals]}))
