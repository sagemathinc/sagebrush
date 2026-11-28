# matplotlib's custom colormaps as matplotlib's (the Codex audit R02b): ListedColormap and
# LinearSegmentedColormap.from_list from named, hex and RGBA colors; their lookup of floats, integer indices, values
# out of range and NaN; bytes, alpha, the source colors' alpha and the input's shape; N (cycled or cut) and gamma.
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
show("listed N=5", lambda: ListedColormap(["red", "blue"], N=5)(np.array([0, 1, 2, 3, 4])))
show("listed N=2", lambda: ListedColormap(["red", "blue", "green"], N=2)(np.linspace(0, 1, 4)))

# from_list: each channel interpolated at linspace(0, 1, N) ** gamma
for label, colors, kw in [("named", ["red", "blue"], {}), ("three", ["red", "#00ff00", (0.0, 0.0, 1.0)], {}),
                          ("N=4", ["red", "blue"], {"N": 4}), ("N=1", ["red", "blue"], {"N": 1}),
                          ("gamma 2", ["red", "blue"], {"N": 5, "gamma": 2.0}), ("rgba", [(1.0, 0.0, 0.0, 0.5), "blue"], {"N": 3})]:
    m = LinearSegmentedColormap.from_list("m", colors, **kw)
    show("from_list %s N" % label, lambda: m.N)
    show("from_list %s floats" % label, lambda: m(np.array([0.0, 0.3, 0.5, 0.7, 1.0])))
    show("from_list %s ints" % label, lambda: m(np.array([0, 1, 2])))
    show("from_list %s nan" % label, lambda: m(float("nan")))
    show("from_list %s bytes" % label, lambda: m(0.25, bytes=True))
