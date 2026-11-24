"""Geometry cases for Sagebrush's seaborn against seaborn 0.13.2: what each plot draws (points, bars, cells,
lines, their colors and sizes, the axes' limits, ticks and labels), never pixels.  The data are made up here.
test/seaborn_oracle_gen.py runs CASES under CPython with seaborn (ORACLE_PRELUDE reads matplotlib's artists)
into test/seaborn-oracle.json; test/seaborn-geometry.test.ts runs them on Sagebrush (OURS_PRELUDE reads the
primitives each Axes draws) and compares.  Each case's code leaves its result in `out`."""

DATA = r'''
TIPS = pd.DataFrame({
    "day": ["Thu", "Fri", "Sat", "Sun", "Thu", "Fri", "Sat", "Sun", "Sat", "Sun", "Thu", "Sat"],
    "sex": ["M", "F", "M", "F", "F", "M", "M", "F", "F", "M", "M", "F"],
    "bill": [10.5, 22.25, 15.0, 30.75, 12.0, 8.5, 25.0, 19.5, 17.25, 28.0, 14.5, 21.0],
    "tip": [1.5, 3.0, 2.25, 5.0, 2.0, 1.0, 4.5, 3.5, 2.75, 4.0, 2.5, 3.25],
    "size": [2, 3, 2, 4, 2, 1, 4, 3, 2, 4, 2, 3],
})
LINE = pd.DataFrame({"x": [1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3], "y": [0.3, 1.7, 2.2, 5.0, 4.1, 3.3, 2.0, 1.1, 7.0, 6.1, 6.9]})
'''

ORACLE_PRELUDE = r'''
import numpy as np, pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
plt.close("all")
matplotlib.rcdefaults()

def rgba(cs):
    return [[float(v) for v in c] for c in np.asarray(cs, dtype=float).reshape(-1, 4)]
def coll(c):
    return {"offsets": np.asarray(c.get_offsets(), dtype=float).tolist(), "face": rgba(c.get_facecolors()),
            "edge": rgba(c.get_edgecolors()), "sizes": [float(s) for s in c.get_sizes()],
            "lw": [float(w) for w in c.get_linewidths()]}
def rect(p):
    return [float(p.get_x()), float(p.get_y()), float(p.get_width()), float(p.get_height())]
def lines(ax):
    return [{"x": np.asarray(l.get_xdata(), dtype=float).tolist(), "y": np.asarray(l.get_ydata(), dtype=float).tolist(),
             "color": [float(v) for v in matplotlib.colors.to_rgba(l.get_color())], "lw": float(l.get_linewidth())}
            for l in ax.lines]
def frame(ax):
    return {"xlim": [float(v) for v in ax.get_xlim()], "ylim": [float(v) for v in ax.get_ylim()],
            "xlabel": ax.get_xlabel(), "ylabel": ax.get_ylabel(),
            "xticks": [float(v) for v in ax.get_xticks()], "yticks": [float(v) for v in ax.get_yticks()],
            "xticklabels": [t.get_text() for t in ax.get_xticklabels()],
            "yticklabels": [t.get_text() for t in ax.get_yticklabels()]}
def legend(ax):
    lg = ax.get_legend()
    if lg is None:
        return None
    return {"title": lg.get_title().get_text(), "texts": [t.get_text() for t in lg.get_texts()]}
def scat(ax):
    return {"coll": [coll(c) for c in ax.collections], "frame": frame(ax), "legend": legend(ax)}
def linegeom(ax):
    return {"lines": [{"x": np.asarray(l.get_xdata(), dtype=float).tolist(), "y": np.asarray(l.get_ydata(), dtype=float).tolist(),
                       "color": [float(v) for v in matplotlib.colors.to_rgba(l.get_color())], "lw": float(l.get_linewidth()),
                       "marker": str(l.get_marker()), "ms": float(l.get_markersize()), "label": "" if l.get_label().startswith("_") else l.get_label()} for l in ax.lines],
            "frame": frame(ax), "legend": legend(ax)}
def histgeom(ax):
    return {"rects": [rect(p) for p in ax.patches], "face": [[float(v) for v in p.get_facecolor()] for p in ax.patches],
            "edge": [[float(v) for v in p.get_edgecolor()] for p in ax.patches], "frame": frame(ax)}
def stripgeom(ax):
    return {"coll": [{"y": np.asarray(c.get_offsets(), dtype=float)[:, 1].tolist(),
                      "x": np.asarray(c.get_offsets(), dtype=float)[:, 0].tolist(),
                      "face": rgba(c.get_facecolors()), "sizes": [float(v) for v in c.get_sizes()]} for c in ax.collections],
            "frame": frame(ax)}
def heat(ax):
    q = ax.collections[0]
    arr = np.ma.asarray(q.get_array()).ravel()
    keep = ~np.ma.getmaskarray(arr)
    face = rgba(q.cmap(q.norm(arr)))
    # (each drawn cell's rectangle, row by row: a masked cell isn't drawn, so it isn't listed)
    co = np.asarray(q.get_coordinates(), dtype=float)
    nr, nc = co.shape[0] - 1, co.shape[1] - 1
    cells = [[float(co[i, j, 0]), float(co[i, j, 1]), float(co[i + 1, j + 1, 0] - co[i, j, 0]),
              float(co[i + 1, j + 1, 1] - co[i, j, 1])] for i in range(nr) for j in range(nc)]
    return {"values": [float(v) for v, k in zip(arr.filled(np.nan), keep) if k], "clim": [float(v) for v in q.get_clim()],
            "cells": [c for c, k in zip(cells, keep) if k],
            "face": [f for f, k in zip(face, keep) if k], "frame": frame(ax), "naxes": len(ax.figure.axes),
            "texts": [[t.get_text(), float(t.get_position()[0]), float(t.get_position()[1]),
                       [float(v) for v in matplotlib.colors.to_rgba(t.get_color())]] for t in ax.texts],
            "edge": rgba(q.get_edgecolors()) if float(np.max(q.get_linewidths())) > 0 else []}
def band(ax):
    out = []
    for c in ax.collections:
        v = np.asarray(c.get_paths()[0].vertices, dtype=float)
        d = {}
        for x, y in v.tolist():
            d.setdefault(x, []).append(y)
        out.append(sorted([x, min(ys), max(ys)] for x, ys in d.items()))
    return {"band": out, "line": [[float(v) for v in l.get_ydata()] for l in ax.lines]}
def pair(g):
    cells = []
    for row in g.axes:
        r = []
        for a in row:
            if a is None:
                r.append(None)
                continue
            r.append({"coll": [{k: v for k, v in coll(c).items() if k in ("offsets", "face", "sizes")} for c in a.collections
                               if type(c).__name__ == "PathCollection" and len(c.get_offsets())],
                      "lim": [float(v) for v in a.get_xlim() + a.get_ylim()],
                      "xlabel": a.get_xlabel() if a.xaxis.label.get_visible() else "",
                      "ylabel": a.get_ylabel() if a.yaxis.label.get_visible() else ""})
        cells.append(r)
    diag = []
    for a in (g.diag_axes if g.diag_axes is not None else []):
        ps = [p for p in a.patches if rect(p) != [0.0, 0.0, 0.0, 0.0]]
        diag.append({"rects": [rect(p) for p in ps],
                     "curves": [[round(float(v), 9) for v in np.asarray(c.get_paths()[0].vertices, dtype=float)[202:402][::-1][::25, 1]]
                                for c in a.collections if type(c).__name__ == "FillBetweenPolyCollection"]})
    return {"shape": list(g.axes.shape), "cells": cells, "diag": diag,
            "legend": [t.get_text() for t in g._legend.get_texts()] if getattr(g, "_legend", None) else None}
def bars(ax):
    ps = [p for p in ax.patches if rect(p) != [0.0, 0.0, 0.0, 0.0]]  # (not the legend's empty handles)
    return {"rects": [rect(p) for p in ps], "face": [[float(v) for v in p.get_facecolor()] for p in ps],
            "lines": lines(ax), "frame": frame(ax), "legend": legend(ax)}
'''

OURS_PRELUDE = r'''
import json, math
import numpy as np, pandas as pd
import matplotlib
import matplotlib.pyplot as plt
import seaborn as sns
plt.close("all")
matplotlib.rcdefaults()
PT = 100 / 72
def _rgba(c):
    return [float(v) for v in matplotlib.colors.to_rgba(c)]
def _kind(ax, k):
    return [p for p in ax._prims if type(p).__name__ == k]
def coll(p):
    o = p.options
    cols = o.get("colors") or [o.get("color")]
    sizes = [(2 * r / PT) ** 2 for r in o["sizes"]] if o.get("sizes") else [(2 * o.get("size", 3.5) / PT) ** 2]
    ew = o.get("edgewidth")
    return {"offsets": [[x, y] for x, y in zip(p.xs, p.ys)], "face": [_rgba(c) for c in cols],
            "edge": [_rgba(o["edgecolor"])] if o.get("edgecolor") else [], "sizes": sizes,
            "lw": [ew / PT] if ew is not None else []}
def frame(ax):
    return {"xlim": [float(v) for v in ax.get_xlim()], "ylim": [float(v) for v in ax.get_ylim()],
            "xlabel": ax.get_xlabel(), "ylabel": ax.get_ylabel(),
            "xticks": [float(v) for v in ax.get_xticks()], "yticks": [float(v) for v in ax.get_yticks()],
            "xticklabels": [t.get_text() for t in ax.get_xticklabels()],
            "yticklabels": [t.get_text() for t in ax.get_yticklabels()]}
def legend(ax):
    if not ax._opts.get("legend"):
        return None
    return {"title": ax._opts.get("legend_title") or "", "texts": [s for _, s in ax._opts.get("legend_entries", [])]}
def _line(p):
    o = p.options
    return {"x": list(p.xs), "y": list(p.ys), "color": _rgba(o.get("color")), "lw": o.get("thickness", 1.5 * PT) / PT,
            "marker": str(o.get("marker", "None")), "ms": 2 * o.get("markersize", 3) / PT if o.get("marker") else 6.0,
            "label": o.get("label_given") or o.get("label") or ""}
def linegeom(ax):
    return {"lines": [_line(p) for p in _kind(ax, "Line")], "frame": frame(ax), "legend": legend(ax)}
def histgeom(ax):
    rs = [r for p in _kind(ax, "Rects") for r in p.rects]
    cols = [c for p in _kind(ax, "Rects") for c in (p.options.get("colors") or [p.options.get("color")] * len(p.rects))]
    edges = [c for p in _kind(ax, "Rects") for c in [p.options.get("edgecolor")] * len(p.rects)]
    alphas = [p.options.get("alpha") for p in _kind(ax, "Rects") for _ in p.rects]
    face = [_rgba(c)[:3] + [1.0 if a is None else float(a)] for c, a in zip(cols, alphas)]
    return {"rects": [list(r) for r in rs], "face": face, "edge": [_rgba(c) if c else [0, 0, 0, 0] for c in edges],
            "frame": frame(ax)}
def stripgeom(ax):
    out = []
    for p in _kind(ax, "Points"):
        c = coll(p)
        out.append({"y": [v[1] for v in c["offsets"]], "x": [v[0] for v in c["offsets"]], "face": c["face"], "sizes": c["sizes"]})
    return {"coll": out, "frame": frame(ax)}
def heat(ax):
    r = _kind(ax, "Rects")[0]
    cells = sorted(zip(r.rects, r.options["colors"]), key=lambda t: (t[0][1], t[0][0]))
    vals = None
    texts = [[t.string, t.x, t.y, _rgba(t.options.get("color"))] for t in _kind(ax, "Text")]
    return {"cells": [list(r) for r, _ in cells], "face": [_rgba(c) for _, c in cells], "frame": frame(ax),
            "naxes": len(ax.figure.axes), "texts": texts, "edge": [_rgba(r.options["edgecolor"])] if r.options.get("edgecolor") else []}
def bars(ax):
    h = histgeom(ax)
    return {"rects": h["rects"], "face": h["face"], "lines": [{k: l[k] for k in ("x", "y", "color", "lw")} for l in linegeom(ax)["lines"]],
            "frame": frame(ax), "legend": legend(ax)}
def band(ax):
    out = []
    for p in _kind(ax, "Polygon"):
        d = {}
        for x, y in zip(p.xs, p.ys):
            d.setdefault(float(x), []).append(float(y))
        out.append(sorted([x, min(ys), max(ys)] for x, ys in d.items()))
    return {"band": out, "line": [[float(v) for v in p.ys] for p in _kind(ax, "Line")]}
def pair(g):
    cells = []
    for row in g.axes:
        r = []
        for a in row:
            if a is None:
                r.append(None)
                continue
            r.append({"coll": [{k: v for k, v in coll(p).items() if k in ("offsets", "face", "sizes")} for p in _kind(a, "Points") if p.xs],
                      "lim": [float(v) for v in tuple(a.get_xlim()) + tuple(a.get_ylim())],
                      "xlabel": a.get_xlabel(), "ylabel": a.get_ylabel()})
        cells.append(r)
    diag = []
    for a in g.diag_axes:
        rs = [list(r) for p in _kind(a, "Rects") for r in p.rects]
        diag.append({"rects": rs, "curves": [[round(float(v), 9) for v in p.ys[::25]] for p in _kind(a, "Line")]})
    leg = g._legend
    return {"shape": list(g.axes.shape), "cells": cells, "diag": diag,
            "legend": [s for _, s in leg._opts.get("legend_entries", [])] if leg is not None else None}
def scat(ax):
    return {"coll": [coll(p) for p in _kind(ax, "Points")], "frame": frame(ax), "legend": legend(ax)}
'''

CASES = [
    ('scatter-xy', r'''
ax = sns.scatterplot(data=TIPS, x="bill", y="tip")
out = scat(ax)
'''),
    ('scatter-hue-cat', r'''
ax = sns.scatterplot(data=TIPS, x="bill", y="tip", hue="day")
out = scat(ax)
'''),
    ('scatter-vectors-s-color', r'''
ax = sns.scatterplot(x=[1.0, 2.0, 3.0, 4.0], y=[4.0, 1.0, 3.0, 2.0], s=80, color="red")
out = scat(ax)
'''),
    ('scatter-hue-num', r'''
ax = sns.scatterplot(data=TIPS, x="bill", y="tip", hue="size")
out = scat(ax)
'''),
    ('scatter-palette-nan', r'''
d = TIPS.copy(); d.loc[3, "tip"] = np.nan
ax = sns.scatterplot(data=d, x="bill", y="tip", hue="sex", palette="muted")
out = scat(ax)
'''),
    ('line-xy-marker', r'''
ax = sns.lineplot(data=TIPS, x="bill", y="tip", marker="o", color="green", label="tips")
out = linegeom(ax)
'''),
    ('line-vectors', r'''
ax = sns.lineplot(x=[0.0, 1.0, 2.0, 3.0], y=[1.0, 3.0, 2.0, 5.0])
out = linegeom(ax)
'''),
    ('line-two-labels', r'''
ax = sns.lineplot(x=[1.0, 2.0, 3.0], y=[1.0, 4.0, 9.0], label="squares", marker="s")
sns.lineplot(x=[1.0, 2.0, 3.0], y=[1.0, 2.0, 3.0], label="identity", ax=ax)
out = linegeom(ax)
'''),
    ('line-band-ci-s0', r'''
ax = sns.lineplot(data=LINE, x="x", y="y", seed=0)
out = band(ax)
'''),
    ('line-band-ci-s7-odd', r'''
ax = sns.lineplot(data=LINE, x="x", y="y", seed=7, n_boot=200)
out = band(ax)
'''),
    ('line-band-sd', r'''
ax = sns.lineplot(data=LINE, x="x", y="y", errorbar="sd")
out = band(ax)
'''),
    ('line-band-se', r'''
ax = sns.lineplot(data=LINE, x="x", y="y", errorbar="se")
out = band(ax)
'''),
    ('line-band-pi50', r'''
ax = sns.lineplot(data=LINE, x="x", y="y", errorbar=("pi", 50))
out = band(ax)
'''),
    ('hist-x', r'''
ax = sns.histplot(data=TIPS, x="bill")
out = histgeom(ax)
'''),
    ('hist-x-bins', r'''
ax = sns.histplot(data=TIPS, x="tip", bins=5)
out = histgeom(ax)
'''),
    ('hist-hue', r'''
ax = sns.histplot(data=TIPS, x="bill", hue="sex")
out = histgeom(ax)
out["legend"] = legend(ax)
'''),
    ('kde-hue', r'''
ax = sns.kdeplot(data=TIPS, x="bill", hue="sex")
out = linegeom(ax)
for l in out["lines"]:
    l["y"] = [round(v, 9) for v in l["y"][::20]]; l["x"] = [round(v, 9) for v in l["x"][::20]]
'''),
    ('strip-nojitter-h', r'''
ax = sns.stripplot(data=TIPS, x="bill", y="day", orient="h", s=4, jitter=False)
out = stripgeom(ax)
'''),
    ('strip-nojitter-v', r'''
ax = sns.stripplot(data=TIPS, x="day", y="tip", jitter=False)
out = stripgeom(ax)
'''),
    ('bar-mean-ci-seed', r'''
ax = sns.barplot(data=TIPS, x="day", y="tip", seed=0)
out = bars(ax)
'''),
    ('bar-sd', r'''
ax = sns.barplot(data=TIPS, x="day", y="bill", errorbar="sd")
out = bars(ax)
'''),
    ('bar-none-order', r'''
ax = sns.barplot(data=TIPS, x="day", y="tip", errorbar=None, order=["Sun", "Sat", "Fri", "Thu"])
out = bars(ax)
'''),
    ('bar-horizontal', r'''
ax = sns.barplot(data=TIPS, y="day", x="tip", errorbar=None)
out = bars(ax)
'''),
    ('bar-hue', r'''
ax = sns.barplot(data=TIPS, x="day", y="tip", hue="sex", errorbar=None)
out = bars(ax)
'''),
    ('bar-wide', r'''
ax = sns.barplot(data=TIPS[["bill", "tip"]], errorbar=None)
out = bars(ax)
'''),
    ('bar-capsize-seed', r'''
ax = sns.barplot(data=TIPS, x="sex", y="tip", seed=7, n_boot=200, capsize=0.2)
out = bars(ax)
'''),
    ('bar-numeric-x', r'''
ax = sns.barplot(data=TIPS, x="size", y="tip", errorbar=None)
out = bars(ax)
'''),
    ('heat-basic-viridis', r'''
ax = sns.heatmap(np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.5], [0.5, -1.0, 2.0]]), cmap="viridis")
out = heat(ax)
'''),
    ('heat-frame-annot', r'''
df = pd.DataFrame([[1, 20, 3], [4, 5, 60]], index=["r1", "r2"], columns=["a", "b", "c"])
ax = sns.heatmap(df, annot=True, fmt="d", cmap="viridis", cbar=False, linewidths=0.5)
out = heat(ax)
'''),
    ('heat-center-vmin', r'''
ax = sns.heatmap(np.array([[-2.0, 0.5], [1.0, 3.0]]), center=0, vmin=-3, vmax=3, annot=True, cmap="coolwarm")
out = heat(ax)
'''),
    ('heat-pivot-fmt', r'''
m = pd.DataFrame({"Fri": [2.0, 3.0], "Sat": [3.375, 3.0], "Sun": [4.0, 4.25]}, index=["F", "M"])
ax = sns.heatmap(m, annot=True, fmt=".1f", cmap="Blues")
out = heat(ax)
'''),
    ('heat-robust-mask', r'''
v = np.arange(30, dtype=float).reshape(5, 6); v[2, 3] = 500.0
mk = np.zeros((5, 6), dtype=bool); mk[0, 0] = True
ax = sns.heatmap(v, robust=True, mask=mk, cmap="magma", annot=True)
out = heat(ax)
'''),
    ('heat-many-rows-auto', r'''
ax = sns.heatmap(np.arange(120, dtype=float).reshape(40, 3), cmap="viridis")
out = heat(ax)
'''),
    ('heat-default-rocket', r'''
ax = sns.heatmap(np.array([[1.0, 2.0], [3.0, 4.0]]))
out = heat(ax)
'''),
    ('pair-basic', r'''
g = sns.pairplot(TIPS[["bill", "tip", "size"]])
out = pair(g)
'''),
    ('pair-hue', r'''
g = sns.pairplot(TIPS[["bill", "tip", "sex"]], hue="sex")
out = pair(g)
'''),
    ('pair-vars-corner', r'''
g = sns.pairplot(TIPS, vars=["bill", "tip"], corner=True, diag_kind="hist", height=2)
out = pair(g)
'''),
]
