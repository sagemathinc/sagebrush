# matplotlib's legend titles, hlines and vlines, and twinx: what the legend
# returns, the segments, colors and widths of the lines, the limits they
# autoscale to, and the shared x axis and own color cycle of a twin.
# CPython with matplotlib prints what test/mpl_oracle_gen.py records;
# Sagebrush must print the same (test/mpl-lines-twin.test.ts).
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import to_hex
import numpy as np


def lim(t):
    return tuple(round(float(v), 10) for v in t)


def color(line):
    if hasattr(line, "_prim"):  # (Sagebrush: its line's color)
        return to_hex(line._prim.options["color"])
    return to_hex(line.get_color())


def segs(lc):
    return [[[float(v) for v in pt] for pt in s.tolist()] for s in lc.get_segments()]


def colors(lc):
    return [[round(float(v), 6) for v in c] for c in lc.get_colors().tolist()]


def case(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__)
    plt.close("all")


# ---- the rows of the gaps first seen in published notebooks
def legend_title():
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="a")
    leg = ax.legend(title="Series")
    return leg.get_title().get_text() == "Series"
case("legend(title=)", legend_title)


def hlines_row():
    plt.figure()
    lc = plt.hlines([0.5, 1.0], 0, 2, colors="r", linestyles="dashed")
    return len(lc.get_segments()) == 2
case("pyplot.hlines", hlines_row)


def twinx_row():
    fig, ax = plt.subplots()
    ax.plot([1, 2, 3], [1, 4, 9])
    ax2 = ax.twinx()
    ax2.plot([1, 2, 3], [100, 50, 10], color="g")
    return ax2 is not ax
case("Axes.twinx", twinx_row)


# ---- legends
def legend_object():
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="a")
    ax.plot([0, 1], [1, 0], label="b")
    leg = ax.legend(title="Series")
    out = [str(leg), leg is ax.get_legend(), [t.get_text() for t in leg.get_texts()]]
    leg.set_title("New")
    out.append(leg.get_title().get_text())
    out.append(repr(ax.legend().get_title().get_text()))  # (a legend without a title: "")
    return out
case("legend object", legend_object)


def legend_title_only():
    import warnings
    fig, ax = plt.subplots()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        leg = ax.legend(title="Only")
    return [t.get_text() for t in leg.get_texts()], leg.get_title().get_text()
case("legend title only", legend_title_only)


case("get_legend before", lambda: plt.subplots()[1].get_legend())


# ---- hlines and vlines
def hlines_basic():
    plt.figure()
    lc = plt.hlines([0.5, 1.0], 0, 2, colors="r", linestyles="dashed")
    ax = plt.gca()
    return type(lc).__name__, segs(lc), colors(lc), lim(ax.get_xlim()), lim(ax.get_ylim())
case("hlines", hlines_basic)


def vlines_colors():
    plt.figure()
    lc = plt.vlines([3, 4], [0, 1], [2, 4], colors=["g", "b"], label="v")
    ax = plt.gca()
    return segs(lc), colors(lc), lc.get_label(), lim(ax.get_xlim()), lim(ax.get_ylim())
case("vlines colors", vlines_colors)


def hlines_broadcast():
    fig, ax = plt.subplots()
    lc = ax.hlines(y=np.array([1, 2, 3]), xmin=[0, 1, 2], xmax=5, label="h")
    ax.plot([0, 1], [0, 1], label="p")
    ax.legend()
    return (segs(lc), colors(lc), [float(w) for w in lc.get_linewidth()], lim(ax.get_xlim()), lim(ax.get_ylim()),
            [t.get_text() for t in ax.get_legend().get_texts()])
case("hlines broadcast", hlines_broadcast)


def vlines_scalar():
    fig, ax = plt.subplots()
    lc = ax.vlines(2.5, -1, 1, linewidth=3)
    return segs(lc), [float(w) for w in lc.get_linewidth()], lim(ax.get_xlim()), lim(ax.get_ylim())
case("vlines scalar", vlines_scalar)


def vlines_mismatch():
    fig, ax = plt.subplots()
    ax.vlines(3, [0, 1], [2, 4])
case("vlines mismatch", vlines_mismatch)


def hlines_repr():
    fig, ax = plt.subplots()
    return repr(ax.hlines(1, 0, 1)).split(" object at ")[0]
case("hlines repr", hlines_repr)


# ---- twinx
def twinx_limits():
    fig, ax = plt.subplots()
    ax.plot([1, 2, 3], [1, 4, 9])
    ax2 = ax.twinx()
    l2, = ax2.plot([1, 2, 3], [100, 50, 10])
    l3, = ax2.plot([1, 2, 3], [1, 5, 10])
    return (len(fig.axes), plt.gca() is ax2, color(l2), color(l3), lim(ax.get_xlim()), lim(ax2.get_xlim()),
            lim(ax.get_ylim()), lim(ax2.get_ylim()), [float(v) for v in ax2.get_xticks()],
            [float(v) for v in ax2.get_yticks()])
case("twinx limits", twinx_limits)


def twinx_shared():
    fig, ax = plt.subplots()
    ax.plot([1, 2, 3], [1, 4, 9])
    ax2 = ax.twinx()
    ax2.plot([0, 10], [5, 5])
    out = [lim(ax.get_xlim()), lim(ax2.get_xlim())]
    ax.set_xlim(0, 4)
    out.append(lim(ax2.get_xlim()))
    ax2.set_xlim(-1, 2)
    out.append(lim(ax.get_xlim()))
    return out
case("twinx shared x", twinx_shared)


def pyplot_twinx():
    plt.figure()
    plt.plot([1, 2])
    t = plt.twinx()
    return t is plt.gca(), len(plt.gcf().axes), repr(t)
case("pyplot.twinx", pyplot_twinx)


def twinx_subplot():
    # (pyplot.subplot of the host's place is the host, not its twin)
    plt.figure()
    ax = plt.subplot(1, 2, 1)
    ax.twinx()
    return plt.subplot(1, 2, 1) is ax
case("twinx subplot", twinx_subplot)
