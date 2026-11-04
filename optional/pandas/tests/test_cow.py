# Copy-on-Write (pandas 3): every derived object behaves as a copy, so
# setting through it never changes its parent (plan-pandas r7 §C3).
import numpy as np
import pandas as pd
from _cases import case


def df():
    return pd.DataFrame({"x": [1, 2, 3], "s": ["a", "b", "c"]})


def through(derive, change):
    parent = df()
    child = derive(parent)
    change(child)
    return parent


def chained():
    d = df()
    d["x"][0] = 99
    return d


def setcol(d):
    d["x"] = 0


case("column", lambda: through(lambda d: d["x"], lambda c: c.__setitem__(0, 42)))
case("columns", lambda: through(lambda d: d[["x"]], setcol))
case("loc-rows", lambda: through(lambda d: d.loc[0:1], setcol))
case("iloc-rows", lambda: through(lambda d: d.iloc[[0, 2]], setcol))
case("head", lambda: through(lambda d: d.head(2), setcol))
case("tail", lambda: through(lambda d: d.tail(2), setcol))
case("T", lambda: through(lambda d: d.T, lambda c: c.__setitem__(0, 0)))
case("copy", lambda: through(lambda d: d.copy(), setcol))
case("mask", lambda: through(lambda d: d[d.x > 1], setcol))
case("row", lambda: through(lambda d: d.loc[0], lambda c: c.__setitem__("x", 7)))
case("items", lambda: through(lambda d: dict(d.items())["x"], lambda c: c.__setitem__(1, 5)))
case("chained", chained)
case("series-head", lambda: (lambda p: (p.head(2).__setitem__(0, 9), p)[1])(pd.Series([1, 2, 3])))
case("index-shared-ok", lambda: (lambda p: (p.copy().__setattr__("index", ["a", "b", "c"]), p.index)[1])(df()))
case("nested-objects-shared", lambda: (lambda p, c: (c.iloc[0].append(9), p.iloc[0])[1])(*(lambda p: (p, p.copy(deep=True)))(pd.Series([[1, 2], "x"]))))
case("ndarray-default-copy", lambda: (lambda a: (lambda f: (a.__setitem__((0, 0), 5.0), f)[1])(pd.DataFrame(a)))(np.zeros((2, 2))))
case("ndarray-dict-copy", lambda: (lambda a: (lambda f: (a.__setitem__(0, 5), f)[1])(pd.DataFrame({"a": a})))(np.arange(3)))
case("series-ndarray-copy", lambda: (lambda a: (lambda s: (a.__setitem__(0, 5), s)[1])(pd.Series(a)))(np.arange(3)))
case("list-copy-false", lambda: (lambda l: (lambda s: (l.__setitem__(0, 5), s)[1])(pd.Series(l, copy=False)))([1, 2, 3]))
