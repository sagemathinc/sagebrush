# [] on Series and DataFrame: labels (never positions, pandas 3), slices,
# masks and lists (plan-pandas-m1-r1 §0).
import numpy as np
import pandas as pd
from _cases import case

s = pd.Series([10, 20, 30], index=["a", "b", "c"])
si = pd.Series([10, 20, 30], index=[2, 1, 0])
sf = pd.Series([1, 2, 3], index=[0.5, 1.5, 2.5])
sd = pd.Series([1, 2, 3, 4], index=["a", "b", "a", "c"])
df = pd.DataFrame({"x": [1, 2, 3], "y": [1.5, 2.5, 3.5], "z": ["p", "q", "r"]})

case("s.label", lambda: s["b"])
case("s.int-on-str-index", lambda: s[1])
case("s.int-slice", lambda: s[1:3])
case("s.label-slice", lambda: s["a":"b"])
case("s.label-list", lambda: s[["a", "c"]])
case("s.label-list-missing", lambda: s[["a", "z"]])
case("s.bool-list", lambda: s[[True, False, True]])
case("s.bool-list-short", lambda: s[[True, False]])
case("s.mask", lambda: s[s > 15])
case("s.mask-ndarray", lambda: s[np.array([False, True, True])])
case("s.int-index-label", lambda: si[1])
case("s.int-index-slice", lambda: si[0:2])
case("s.int-index-missing", lambda: si[5])
case("s.missing", lambda: s["z"])
case("s.float-index-slice", lambda: sf[1:2.6])
case("s.float-index-label", lambda: sf[1.5])
case("s.dup-label", lambda: sd["a"])
case("s.dup-slice", lambda: sd["b":"c"])
case("s.neg-slice", lambda: s[-2:])
case("s.step-slice", lambda: s[::2])
case("s.empty-slice", lambda: s[5:])
case("s.compare-eq", lambda: s == 20)
case("s.compare-series", lambda: s >= pd.Series([10, 25, 30], index=["a", "b", "c"]))
case("s.compare-misaligned", lambda: s == pd.Series([1, 2, 3]))
case("s.and-or", lambda: ((s > 10) & (s < 30), (s < 15) | (s > 25), ~(s > 15)))
case("s.str-compare", lambda: pd.Series(["a", "b", None]) == "a")
case("s.str-lt", lambda: pd.Series(["a", "b", None]) < "b")
case("s.nan-compare", lambda: pd.Series([1.0, np.nan]) > 0)
case("s.nan-ne", lambda: pd.Series([1.0, np.nan]) != 1.0)

case("df.column", lambda: df["x"])
case("df.columns-list", lambda: df[["x", "z"]])
case("df.missing", lambda: df["w"])
case("df.missing-in-list", lambda: df[["x", "w"]])
case("df.slice", lambda: df[1:3])
case("df.mask", lambda: df[df.x > 1])
case("df.mask-and", lambda: df[(df.x > 1) & (df.z != "r")])
case("df.int-label", lambda: df[0])
case("df.bool-short", lambda: df[[True, False]])
case("df.bool-list", lambda: df[[True, False, True]])
case("df.int-columns", lambda: pd.DataFrame([[1, 2], [3, 4]])[1])
case("df.label-slice", lambda: pd.DataFrame({"v": [1, 2, 3]}, index=["a", "b", "c"])["b":])
case("df.column-name", lambda: df["y"].name)

# reversed and stepped Index slices (astra's PD626-1: indices' -1 stop, "before position 0")
case("idx.reversed", lambda: pd.Index([10, 20, 30])[::-1].tolist())
case("idx.reversed-str", lambda: pd.Index(["a", "b", "c"])[::-1].tolist())
case("idx.reversed-from", lambda: pd.Index([10, 20, 30])[1::-1].tolist())
case("idx.reversed-step2", lambda: pd.Index([10, 20, 30, 40, 50])[::-2].tolist())
case("idx.reversed-to", lambda: pd.Index([10, 20, 30])[:0:-1].tolist())
case("idx.reversed-empty", lambda: pd.Index([])[::-1].tolist())
case("idx.reversed-singleton", lambda: pd.Index([7])[::-1].tolist())
case("idx.range-reversed", lambda: pd.RangeIndex(3)[::-1].tolist())
case("idx.columns-reversed", lambda: pd.DataFrame({"a": [1, 2]}).columns[::-1].tolist())
case("idx.columns-reversed-2", lambda: pd.DataFrame({"a": [1], "b": [2]}).columns[::-1].tolist())
# before-the-beginning negative starts (astra's PD626-1 r2)
case("idx.neg-start-before-reversed", lambda: pd.Index([0, 1, 2])[-10::-1].tolist())
case("idx.neg-start-before-range", lambda: pd.RangeIndex(3)[-10::-1].tolist())
case("idx.neg-start-before-str", lambda: pd.Index(["a", "b", "c"])[-4::-1].tolist())
case("idx.neg-start-before-singleton", lambda: pd.Index([7])[-2::-1].tolist())


# every slice of small indexes: start and stop in -5..5 or None, step in
# -3..3 (not 0) or None; one line per index, each slice's labels in order
def sweep(ix):
    bounds = [None] + list(range(-5, 6))
    out = []
    for a in bounds:
        for b in bounds:
            for c in [None, -3, -2, -1, 1, 2, 3]:
                out.append(ix[slice(a, b, c)].tolist())
    return out


for n in range(4):
    case("idx.sweep-int-%d" % n, lambda n=n: sweep(pd.Index(list(range(10, 10 + 10 * n, 10)), dtype="int64")))
    case("idx.sweep-range-%d" % n, lambda n=n: sweep(pd.RangeIndex(n)))
case("idx.sweep-str-3", lambda: sweep(pd.Index(["a", "b", "c"])))
