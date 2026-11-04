# Exports and ownership under Copy-on-Write (plan-pandas r7 §C3's measured
# table): the result's type, whether a write to it succeeds, and whether
# the parent changes.  The rows M1 rejects are in test_unsupported.
import numpy as np
import pandas as pd
from _cases import case


def write(a, parent):
    try:
        if a.ndim == 1:
            a[0] = 99
        else:
            a[0, 0] = 99
        ok = "write ok"
    except Exception as e:
        ok = "!! %s: %s" % (type(e).__name__, e)
    return (type(a).__name__, str(a.dtype), ok, parent.iloc[0] if isinstance(parent, pd.Series) else parent.iloc[0, 0])


for name, mk in [("int64", lambda: pd.Series([1, 2])), ("float64", lambda: pd.Series([1.5, 2.5])),
                 ("bool", lambda: pd.Series([True, False]))]:
    case("series-%s.to_numpy" % name, lambda mk=mk: (lambda s: write(s.to_numpy(), s))(mk()))
    case("series-%s.values" % name, lambda mk=mk: (lambda s: write(s.values, s))(mk()))
    case("series-%s.to_numpy-copy" % name, lambda mk=mk: (lambda s: write(s.to_numpy(copy=True), s))(mk()))
    case("series-%s.asarray" % name, lambda mk=mk: (lambda s: write(np.asarray(s), s))(mk()))
for name, mk in [("int64", lambda: pd.DataFrame({"a": [1, 2], "b": [3, 4]})),
                 ("float64", lambda: pd.DataFrame({"a": [1.5, 2.5], "b": [3.5, 4.5]})),
                 ("bool", lambda: pd.DataFrame({"a": [True, False]})),
                 ("int-float", lambda: pd.DataFrame({"a": [1, 2], "b": [1.5, 2.5]}))]:
    case("frame-%s.to_numpy" % name, lambda mk=mk: (lambda d: write(d.to_numpy(), d))(mk()))
    case("frame-%s.values" % name, lambda mk=mk: (lambda d: write(d.values, d))(mk()))
    case("frame-%s.to_numpy-copy" % name, lambda mk=mk: (lambda d: write(d.to_numpy(copy=True), d))(mk()))
case("frame-int-float.values-dtype", lambda: str(pd.DataFrame({"a": [1, 2], "b": [1.5, np.nan]}).values.dtype))
case("frame.values-shape", lambda: pd.DataFrame({"a": [1, 2], "b": [3, 4]}).values.shape)
case("frame.values-tolist", lambda: pd.DataFrame({"a": [1, 2], "b": [1.5, 4]}).values.tolist())
case("ndarray-mutated-after", lambda: (lambda a: (lambda s: (a.__setitem__(0, 7), s.tolist())[1])(pd.Series(a)))(np.array([1, 2, 3])))
case("ndarray-2d-mutated-after", lambda: (lambda a: (lambda d: (a.__setitem__((0, 0), 7), d.iloc[0, 0])[1])(pd.DataFrame(a)))(np.zeros((2, 2), dtype="int64")))
