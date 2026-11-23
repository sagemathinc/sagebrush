# The edges of bars in the pixels of a saved PNG, as matplotlib draws them:
# edgecolor= (ec=) and linewidth= (lw=), one for all the bars or one per
# bar, with alpha on the edge as on the face; a width with no edge color
# draws no edge.  A 1-inch figure whose axes fill it; the pixels (row,
# column) named are wholly inside or outside an edge (an edge's own
# boundary is anti-aliased differently by Agg and tiny-skia, and Agg snaps
# a bar to whole pixels); each channel within 1.  CPython with matplotlib
# prints what test/png_oracle_gen.py records; Sagebrush must print the same
# (test/png.test.ts).
import io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def pixels(draw, at):
    fig = plt.figure(figsize=(1, 1), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    draw(ax)
    b = io.BytesIO()
    fig.savefig(b, format="png")
    plt.close(fig)
    a = plt.imread(io.BytesIO(b.getvalue()))
    return [[round(float(v) * 255) for v in a[r, c]] for r, c in at]


# a bar from x 0.2 to 0.8, 0 to 0.8 high: its face (50, 50), its left edge
# over the face (50, 21) and outside it (50, 18); an 8-point edge is 11 pixels
AT = [(50, 50), (50, 21), (50, 18)]
print("bar, edge and width", pixels(lambda ax: ax.bar([0.5], [0.8], width=0.6, color="r", edgecolor="b", linewidth=8), AT))
print("bar, edge and width, alpha 0.5", pixels(lambda ax: ax.bar([0.5], [0.8], width=0.6, color="r", edgecolor="b", linewidth=8, alpha=0.5), AT))
print("bar, ec= and lw=", pixels(lambda ax: ax.bar([0.5], [0.8], width=0.6, color="r", ec="g", lw=8), AT))
print("bar, a width with no edge color", pixels(lambda ax: ax.bar([0.5], [0.8], width=0.6, color="r", linewidth=8), AT))
print("bar, edgecolor none", pixels(lambda ax: ax.bar([0.5], [0.8], width=0.6, color="r", edgecolor="none", linewidth=8), AT))
# barh: from y 0.2 to 0.8 (rows 20 to 80), 0 to 0.8 long: its top edge
print("barh, edge and width", pixels(lambda ax: ax.barh([0.5], [0.8], height=0.6, color="r", edgecolor="b", linewidth=8), [(50, 50), (21, 50), (18, 50)]))
# two bars, an edge color and a width each: x 0.1-0.4 and 0.6-0.9
two = [(50, 25), (50, 11), (50, 8), (50, 61), (50, 58)]
print("bars, edge colors per bar", pixels(lambda ax: ax.bar([0.25, 0.75], [0.8, 0.8], width=0.3, color="w", edgecolor=["r", "b"], linewidth=8), two))
# (a 2-point edge is under 3 pixels wide: at x 0.1 it covers neither column
# 6 nor 13, where an 8-point one at x 0.6 covers both 56 and 64)
print("bars, widths per bar", pixels(lambda ax: ax.bar([0.25, 0.75], [0.8, 0.8], width=0.3, color="w", edgecolor="k", linewidth=[2, 8]),
                                     [(50, 25), (50, 13), (50, 6), (50, 64), (50, 56)]))
# hist: one bin from 0.2 to 0.8, 8 points high (the y limit 10)
print("hist, edge and width", pixels(lambda ax: (ax.set_ylim(0, 10), ax.hist([0.3] * 8, bins=1, range=(0.2, 0.8), color="r", edgecolor="b", linewidth=8)), AT))
