# Translucent shapes over each other in the pixels of a saved PNG: matplotlib
# draws each marker of a plot or scatter, each bar and each pixel marker with
# its alpha on its own, so where they overlap the color builds up; one line
# is drawn once, so where it crosses itself it does not.  A 1-inch figure
# whose axes fill it; the pixel (row, column) named, or the colors drawn
# (each channel within 1: Agg truncates where tiny-skia rounds when it
# blends).  CPython with matplotlib prints what test/png_oracle_gen.py
# records; Sagebrush must print the same (test/png.test.ts).
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


for k in (1, 2, 3, 4):
    print("plot o, %d on one spot" % k, pixels(lambda ax: ax.plot([0.5] * k, [0.5] * k, "o", ms=30, color="b", alpha=0.3), [(50, 50)]))
    print("scatter, %d on one spot" % k, pixels(lambda ax: ax.scatter([0.5] * k, [0.5] * k, s=900, color="b", alpha=0.3), [(50, 50)]))
# two bars of one call, overlapping between 0.4 and 0.6; each alone at 0.25 and 0.75
print("two bars overlapping", pixels(lambda ax: ax.bar([0.4, 0.6], [0.8, 0.8], width=0.4, color="g", alpha=0.5), [(50, 25), (50, 50), (50, 75)]))
# the pixel marker: k points in one pixel and one in another; which pixel a
# point is in is the renderer's snapping (Agg's is one to the right), so the
# colors of the pixels drawn are printed, with how many have each


def drawn(draw):
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
    seen = {}
    for row in a:
        for px in row:
            v = tuple(round(float(x) * 255) for x in px)
            if v != (255, 255, 255, 255):
                seen[v] = seen.get(v, 0) + 1
    return sorted(seen.items())


for k in (1, 2, 3):
    print("pixel marker, %d in one pixel" % k, drawn(lambda ax: ax.plot([0.505] * k + [0.205], [0.505] * k + [0.205], ",", color="b", alpha=0.3)))
# the color's own alpha does as alpha= does; alpha= wins over it; and an
# opaque color stays opaque, however many points
for k in (2, 3):
    print("pixel marker, RGBA color, %d in one pixel" % k, drawn(lambda ax: ax.plot([0.505] * k + [0.205], [0.505] * k + [0.205], ",", color=(0, 0, 1, 0.3))))
    print("pixel marker, #rrggbbaa color, %d in one pixel" % k, drawn(lambda ax: ax.plot([0.505] * k + [0.205], [0.505] * k + [0.205], ",", color="#0000ff4d")))
    print("pixel marker, #rgba color, %d in one pixel" % k, drawn(lambda ax: ax.plot([0.505] * k + [0.205], [0.505] * k + [0.205], ",", color="#00f4")))
print("pixel marker, RGBA color and alpha=0.6, 2 in one pixel", drawn(lambda ax: ax.plot([0.505] * 2 + [0.205], [0.505] * 2 + [0.205], ",", color=(0, 0, 1, 0.3), alpha=0.6)))
print("pixel marker, opaque, 3 in one pixel", drawn(lambda ax: ax.plot([0.505] * 3 + [0.205], [0.505] * 3 + [0.205], ",", color="b")))
# one line crossing itself at the center: drawn once, no darker there
print("a line crossing itself", pixels(lambda ax: ax.plot([0, 1, 1, 0], [0, 1, 0, 1], color="k", linewidth=12, alpha=0.5), [(50, 50), (25, 25)]))
