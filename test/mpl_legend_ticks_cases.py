# matplotlib's legend entries and tick positions: which artists a legend
# lists, in which order, with which swatch (line, marker, patch) and color,
# and the ticks and limits of autoscaled axes for figure sizes, subplot
# grids and data ranges.  CPython with matplotlib prints what
# test/mpl_oracle_gen.py records; Sagebrush must print the same
# (test/mpl-legend-ticks.test.ts).
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import to_hex
import numpy as np


def _hex(c):
    return to_hex(c, keep_alpha=False)


def entries(ax):
    """[(label, swatch, color)] of ax's legend"""
    if hasattr(ax, "_panel"):  # (Sagebrush: its legend's entries)
        out = []
        for p, s in ax._opts.get("legend_entries", []):
            if p.options.get("hidden"):
                kind = "none"
            elif p.kind in ("line", "axline"):
                kind = "line+marker" if p.options.get("marker") else "line"
            elif p.kind == "points":
                kind = "marker"
            else:
                kind = "patch"
            out.append((s, kind, _hex(p.options.get("color"))))
        return out
    from matplotlib.lines import Line2D
    leg = ax.get_legend()
    out = []
    for h, t in zip(leg.legend_handles, leg.get_texts()):
        if isinstance(h, Line2D):
            line = h.get_linestyle() not in ("None", "")
            marker = h.get_marker() not in ("None", "", None)
            kind = ("none" if not h.get_visible() or not (line or marker) else
                    "line+marker" if line and marker else "line" if line else "marker")
            out.append((t.get_text(), kind, _hex(h.get_color())))
        elif hasattr(h, "get_segments"):  # (an errorbar's: a line with its bar)
            out.append((t.get_text(), "line", _hex(h.get_colors()[0])))
        elif hasattr(h, "get_offsets"):  # (a scatter's PathCollection)
            out.append((t.get_text(), "marker", _hex(h.get_facecolor()[0])))
        else:
            out.append((t.get_text(), "patch", _hex(h.get_facecolor())))
    return out


def show(label, ax, labels_only=False):
    shown = ax._opts.get("legend") if hasattr(ax, "_panel") else ax.get_legend() is not None
    e = entries(ax) if shown else "no legend"
    print(label, [t[0] for t in e] if shown and labels_only else e)


def legend_case(label, f, labels_only=False):
    fig, ax = plt.subplots()
    try:
        f(ax)
        show(label, ax, labels_only)
    except Exception as e:
        print(label, type(e).__name__, e)
    plt.close(fig)


x = np.linspace(0, 10, 11)
legend_case("lab", lambda ax: (ax.plot(x, x, label="S"), ax.plot(x, 2 * x, label="E"),
                               ax.axhline(y=10, color="gray", linestyle="--", label="Hospital Capacity"), ax.legend(loc="best")))
legend_case("order", lambda ax: (ax.bar([1, 2], [3, 4], label="bars"), ax.plot([0, 3], [0, 5], label="line"),
                                 ax.axhline(2.5, label="cap", color="r", ls="--"), ax.axvline(1.5, label="v"),
                                 ax.scatter([1], [1], label="pts"), ax.fill_between([0, 1], [0, 1], label="fill"),
                                 ax.hist([1, 2, 2], label="hist"), ax.plot([1], [1], "o", label="dots"),
                                 ax.plot([1, 2], [2, 3], "s-", label="both"), ax.axhline(1, label="_hidden"), ax.legend()))
legend_case("defaults", lambda ax: (ax.axhline(1, label="h"), ax.axvline(2, label="v", alpha=0.5),
                                    ax.axhline(0.5, xmin=0.25, xmax=0.75, label="part"), ax.legend()))
legend_case("labels", lambda ax: (ax.bar([1, 2], [3, 4]), ax.plot([0, 3], [0, 5]), ax.axhline(2.5),
                                  ax.errorbar([1], [1], yerr=[0.1], label="eb"), ax.plot([1], [2], label="after"),
                                  ax.legend(["a", "b", "c", "d"])))
legend_case("containers", lambda ax: (ax.errorbar([1, 2], [3, 4], yerr=0.1, capsize=2, label="e"), ax.plot([1], [2], label="after"),
                                      ax.axvline(1, label="v"), ax.legend()))
# (a stem's entry: matplotlib draws a little stem, Sagebrush its marker)
legend_case("stem", lambda ax: (ax.stem([1, 2], [3, 4], label="s"), ax.plot([1], [2], label="after"),
                                ax.errorbar([1, 2], [3, 4], yerr=0.1, label="e"), ax.legend()), labels_only=True)
legend_case("hist", lambda ax: (ax.hist([1, 2, 2, 3], bins=3, label="h"), ax.plot([1, 2], [1, 2]), ax.legend(["one", "two", "three"])))
legend_case("handles", lambda ax: (lambda l1, l2, h: ax.legend([h, l1], ["horizontal", "first"]))(
    ax.plot([0, 1], [0, 1], label="p")[0], ax.plot([0, 1], [1, 0])[0], ax.axhline(0.5, color="k")))
legend_case("handles-kw", lambda ax: (lambda l1, h: ax.legend(handles=[h, l1]))(
    ax.plot([0, 1], [0, 1], label="p")[0], ax.axhline(0.5, label="cap")))
legend_case("snapshot", lambda ax: (ax.plot([0, 1], [0, 1], label="before"), ax.legend(), ax.axhline(0.5, label="later")))
legend_case("pie", lambda ax: (ax.pie([1, 2], labels=["a", "b"], autopct="%1.0f%%"), ax.legend()))
legend_case("bad-kw", lambda ax: ax.axhline(1, foo=2))
legend_case("bad-ls", lambda ax: ax.axhline(1, linestyle="wavy"))
legend_case("artist-label", lambda ax: ax.legend([ax.plot([1, 2])[0]]))
# explicit handles: from other axes, hidden, without a line, labelled with _
# (the legend keeps them all, as matplotlib's; CORR-17C-1)
fig, axs = plt.subplots(1, 2)
h = axs[0].plot([0, 1], [0, 1], label="From left")[0]
axs[1].legend(handles=[h])
show("other axes", axs[1])
plt.close(fig)
legend_case("hidden", lambda ax: (ax.plot([0, 1]), ax.axhline(0.5, label="Hidden entry", visible=False),
                                  ax.axhline(0.2, label="No stroke", linestyle="none"), ax.legend()))
legend_case("underscore", lambda ax: (lambda h: ax.legend(handles=[h]))(ax.axhline(0.5, label="_explicit")))
legend_case("underscore plot", lambda ax: (lambda h: ax.legend(handles=[h]))(ax.plot([0, 1], label="_line")[0]))
legend_case("underscore auto", lambda ax: (ax.plot([0, 1], label="_line"), ax.plot([1, 0], label="shown"), ax.legend()))
# the patch cycle: used only by an artist colored from it (CORR-17C-3)
for name, first in [("scatter colors", lambda ax: ax.scatter([0, 1], [0, 1], c=["red", "blue"])),
                    ("scatter mapped", lambda ax: ax.scatter([0, 1], [0, 1], c=[0.2, 0.8])),
                    ("bar colors", lambda ax: ax.bar([0, 1], [1, 2], color=["red", "blue"])),
                    ("scatter red", lambda ax: ax.scatter([0], [0], color="red")),
                    ("bar red", lambda ax: ax.bar([0], [1], color="red"))]:
    legend_case("cycle after " + name, lambda ax: (first(ax), ax.scatter([0.5], [0.5], label="s"), ax.bar([2], [1], label="b"),
                                                   ax.plot([0, 1], label="p"), ax.legend()))

r = plt.axhline(3, xmin=0.2, xmax=0.6)
print("axhline data", [float(v) for v in r.get_xdata()], [float(v) for v in r.get_ydata()])
plt.close("all")


# (15 significant digits: tiny spans in full, but not the last bits that
# matplotlib's transforms add to an axvline's position)
def limits(ax):
    return tuple(float("%.15g" % v) for v in ax.get_xlim() + ax.get_ylim())


def ticks(ax):
    out = []
    for t, (lo, hi) in ((ax.get_xticks(), ax.get_xlim()), (ax.get_yticks(), ax.get_ylim())):
        lo, hi = min(lo, hi), max(lo, hi)
        tol = (hi - lo) * 1e-10
        out.append([float("%.15g" % v) for v in t if lo - tol <= v <= hi + tol])
    return out


def tick_case(label, data, figsize=None, grid=(1, 1), tweak=None):
    fig, axs = plt.subplots(*grid, figsize=figsize)
    ax = axs if grid == (1, 1) else axs[0] if 1 in grid else axs[0][0]
    (x0, x1), (y0, y1) = data
    ax.plot([x0, x1], [y0, y1])
    try:
        if tweak:
            tweak(ax)
        print(label, limits(ax), *ticks(ax))
    except ValueError as e:
        print(label, "ValueError", e)
    plt.close(fig)


for data in [((0, 200), (0, 1)), ((-3.7, 12.2), (1e-5, 3e-5)), ((1000, 1000.5), (-1e6, 5e6)), ((0, 7), (2.5, 2.5)),
             ((0, 1e-7), (-1, 1)), ((123456, 123789), (0.1, 0.9)), ((-2.5, -2.4), (0, 0)), ((0, 2 * np.pi), (-1, 1)),
             # tiny, negative tiny, constant tiny, offset (CORR-17C-2)
             ((1e-14, 2e-14), (1e-14, 2e-14)), ((-2e-14, -1e-14), (-3e-15, -3e-15)), ((1e-14, 1e-14), (0, 0)),
             ((1e12, 1e12 + 1e-3), (-1e-300, 1e-300)), ((1e-320, 2e-320), (1e300, 1.7e308)), ((1 - 1e-15, 1 + 1e-15), (5, 5))]:
    tick_case("data %s" % (data,), data)
for size in [(3, 2), (10, 3), (4, 8), (12, 9), (2, 2)]:
    tick_case("figsize %s" % (size,), ((0, 200), (0, 100)), figsize=size)
for grid in [(1, 2), (2, 2), (3, 1), (2, 3), (1, 4)]:
    tick_case("grid %s" % (grid,), ((0, 200), (-5, 37)), grid=grid)
tick_case("set_xlim", ((0, 200), (0, 1)), tweak=lambda ax: ax.set_xlim(0, 37))
for lim in [(1e12, 1e12 + 0.1), (2, 1), (1e-14, 2e-14), (-1e-14, -2e-14)]:
    tick_case("set_xlim %r" % (lim,), ((0, 200), (0, 1)), tweak=lambda ax: ax.set_xlim(*lim))
import warnings
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    tick_case("set_xlim (5, 5)", ((0, 200), (0, 1)), tweak=lambda ax: ax.set_xlim(5, 5))
    tick_case("set_ylim (0, 0)", ((0, 200), (0, 1)), tweak=lambda ax: ax.set_ylim(0, 0))
    print([str(x.message) for x in w])
tick_case("labelsize", ((0, 200), (0, 1)), tweak=lambda ax: ax.tick_params(labelsize=16))
tick_case("axhline", ((0, 1), (0, 1)), tweak=lambda ax: ax.axhline(5))
tick_case("axvline", ((0, 1), (0, 1)), tweak=lambda ax: ax.axvline(-3, ymin=0.5))
fig, ax = plt.subplots()
ax.axhline(3)
print("axhline only", limits(ax), *ticks(ax))
fig, ax = plt.subplots()
ax.axvline(2)
ax.axhline(3, xmin=0.25, xmax=0.5, alpha=0.5)
print("axvline and axhline", limits(ax), *ticks(ax))
fig = plt.figure(figsize=(6, 4))
ax = fig.add_axes([0.1, 0.1, 0.3, 0.8])
ax.plot([0, 200], [0, 50])
print("add_axes", limits(ax), *ticks(ax))
plt.close("all")
