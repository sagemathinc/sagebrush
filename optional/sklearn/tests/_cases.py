# The tests' one helper, run by both Sagebrush and the oracle (CPython with
# scikit-learn 1.9.1): each case prints its id, then its result or its
# exception, and one case's exception never ends the file.
import hashlib


def show(value):
    try:
        import pandas as pd
        if isinstance(value, (pd.Series, pd.DataFrame)):
            return "\n" + repr(value)
    except ImportError:
        pass
    return repr(value)


def case(cid, fn):
    print("== " + cid)
    try:
        value = fn()
    except Exception as e:
        print("!! %s: %s" % (type(e).__name__, e))
        return
    print(show(value))


def digest(a):
    """An array's dtype, shape and the sha256 of its C-order bytes."""
    import numpy as np
    a = np.ascontiguousarray(a)
    return (str(a.dtype), a.shape, hashlib.sha256(a.tobytes()).hexdigest()[:16])
