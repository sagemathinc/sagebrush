# matplotlib's custom colormaps as matplotlib's (the Codex audit R02b): ListedColormap and
# LinearSegmentedColormap.from_list from named, hex and RGBA colors; their lookup of floats, integer indices, values
# out of range and NaN; bytes, alpha, the source colors' alpha and the input's shape; N (cycled or cut) and gamma;
# LinearSegmentedColormap from segment data (rows or callables), with its errors.
# test/mpl-oracle.json records what CPython with matplotlib prints (test/mpl_oracle_gen.py), which
# test/mpl-colormap.test.ts compares Sagebrush's with.
import warnings
import numpy as np
from matplotlib.colors import ListedColormap, LinearSegmentedColormap

warnings.simplefilter("ignore")


def show(label, f):
    try:
        r = f()
    except Exception as e:
        print(label, type(e).__name__, e)
        return
    a = np.asarray(r)
    vals = [round(float(v), 12) for v in a.ravel().tolist()]
    print(label, type(r).__name__ if not isinstance(r, np.ndarray) else "ndarray", a.dtype, list(a.shape), vals)


# named CSS colors, hex, RGB and RGBA tuples
for label, colors in [("named", ["red", "blue", "green"]), ("hex", ["#ff0000", "#00ff00", "#0000ff"]),
                      ("rgb tuples", [(1.0, 0.0, 0.0), (0.0, 0.5, 1.0)]), ("rgba", [(1.0, 0.0, 0.0, 0.25), "blue"]),
                      ("array", np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]))]:
    c = ListedColormap(colors)
    show("listed %s N" % label, lambda: c.N)
    for x in (0.0, 0.5, 0.999, 1.0, -0.5, 1.5, float("nan"), 0, 1, 2, -1, 7):
        show("listed %s %r" % (label, x), lambda: c(x))
    show("listed %s bytes" % label, lambda: c(0.0, bytes=True))
    show("listed %s alpha" % label, lambda: c(0.0, alpha=0.5))
    show("listed %s nan alpha" % label, lambda: c(float("nan"), alpha=0.5))
    show("listed %s shape" % label, lambda: c([[0.0, 1.0], [0.4, 0.6]]))
    show("listed %s ints" % label, lambda: c(np.array([0, 1, 2])))
# (alpha clipped to [0, 1]; a bool an index, True the second entry, not the last as 1.0 would be)
three = ListedColormap(["red", "#00ff00", "blue"])
show("alpha 2", lambda: three(0.5, alpha=2))
show("alpha -1", lambda: three(0.5, alpha=-1))
show("True", lambda: three(True))
show("False", lambda: three(False))
show("bools", lambda: three(np.array([True, False])))
show("listed N=5", lambda: ListedColormap(["red", "blue"], N=5)(np.array([0, 1, 2, 3, 4])))
show("listed N=2", lambda: ListedColormap(["red", "blue", "green"], N=2)(np.linspace(0, 1, 4)))

# from_list: each channel interpolated at linspace(0, 1, N) ** gamma
for label, colors, kw in [("named", ["red", "blue"], {}), ("three", ["red", "#00ff00", (0.0, 0.0, 1.0)], {}),
                          ("N=4", ["red", "blue"], {"N": 4}), ("N=1", ["red", "blue"], {"N": 1}),
                          ("gamma 2", ["red", "blue"], {"N": 5, "gamma": 2.0}), ("rgba", [(1.0, 0.0, 0.0, 0.5), "blue"], {"N": 3}),
                          ("rgba gamma 2", [(1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 1.0, 1.0)], {"N": 3, "gamma": 2.0}),
                          ("rgba gamma 0.5", [(1.0, 0.0, 0.0, 0.2), (0.0, 1.0, 0.0, 0.9), "blue"], {"N": 6, "gamma": 0.5})]:
    m = LinearSegmentedColormap.from_list("m", colors, **kw)
    show("from_list %s N" % label, lambda: m.N)
    show("from_list %s floats" % label, lambda: m(np.array([0.0, 0.3, 0.5, 0.7, 1.0])))
    show("from_list %s ints" % label, lambda: m(np.array([0, 1, 2])))
    show("from_list %s nan" % label, lambda: m(float("nan")))
    show("from_list %s bytes" % label, lambda: m(0.25, bytes=True))

# LinearSegmentedColormap from segment data: rows (x, y0, y1), a value between x[i-1] and x[i] interpolated from
# y1[i-1] to y0[i] (a jump where y0 and y1 differ), or a callable; red, green and blue at linspace(0, 1, N) ** gamma,
# alpha at gamma 1 (1 without one)
CD = {"red": [(0.0, 0.0, 0.0), (0.5, 1.0, 1.0), (1.0, 1.0, 1.0)],
      "green": [(0.0, 0.0, 0.0), (0.25, 0.0, 0.0), (0.75, 1.0, 1.0), (1.0, 1.0, 1.0)],
      "blue": [(0.0, 0.0, 0.0), (0.5, 0.0, 1.0), (1.0, 0.5, 0.5)]}
CDA = dict(CD, alpha=[(0.0, 1.0, 1.0), (1.0, 0.2, 0.2)])
CDF = {"red": lambda x: x ** 2, "green": lambda x: 1 - x, "blue": np.array([(0.0, 0.3, 0.3), (1.0, 0.7, 0.7)])}
X9 = np.linspace(0, 1, 9)
for N in (1, 2, 5, 256):
    for g in (1.0, 2.0, 0.5):
        for label, cd in (("rows", CD), ("alpha", CDA), ("callables", CDF)):
            show("segments %s N=%d gamma %g" % (label, N, g), lambda: LinearSegmentedColormap("s", cd, N, g)(X9))
seg = LinearSegmentedColormap("s", CDA, 5)
show("segments scalar", lambda: seg(0.4))
show("segments bytes", lambda: seg(np.array([0.1, 0.9]), bytes=True))
show("segments alpha=", lambda: seg(np.array([0.1, 0.9]), alpha=0.5))
show("segments monochrome", lambda: seg.monochrome)
# (the data checked when the table is first made, with matplotlib's errors)
for label, rows in [("two columns", [[0, 1], [1, 0]]), ("not ending at 1", [[0, 0, 0], [0.5, 1, 1]]),
                    ("not starting at 0", [[0.1, 0, 0], [1, 1, 1]]),
                    ("decreasing", [[0, 0, 0], [0.6, 1, 1], [0.4, 0, 0], [1, 1, 1]]), ("a string", "abc")]:
    show("segments %s" % label, lambda: LinearSegmentedColormap("b", dict(CD, red=rows))(0.5))
show("segments missing green", lambda: LinearSegmentedColormap("b", {"red": CD["red"]})(0.5))
show("segments None", lambda: LinearSegmentedColormap("b", None)(0.5))

# from_list of (value, color) pairs, and its errors
show("from_list pairs", lambda: LinearSegmentedColormap.from_list("p", [(0.0, "red"), (0.3, "green"), (1.0, "blue")], N=8)(X9))
show("from_list pairs not increasing", lambda: LinearSegmentedColormap.from_list("p", [(0.0, "red"), (0.5, "green"), (0.3, "blue")]))
show("from_list not iterable", lambda: LinearSegmentedColormap.from_list("p", 5))
print("listed name", ListedColormap(["red"]).name)

