"""matplotlib's pixel marker (',') as savefig's PNG draws it: one pixel of the
image for each point, whatever its markersize and the dpi.  Run with CPython
and matplotlib (test/png_oracle_gen.py records its output in
test/png-oracle.json) and with Sagebrush (test/png.test.ts compares).

The axes fill the figure, without axis lines or ticks, and each point is at the
centre of a pixel, away from the edges.  Which pixel a centre falls in is a
question of the renderer's snapping (matplotlib's Agg puts it one to the right),
so the pixels are printed relative to the first point's."""
import io
import warnings

import matplotlib.pyplot as plt

W, H = 40, 30  # the figure's size in pixels at 100 dpi


def dark(fig, dpi):
    """the pixels drawn dark in fig's PNG at dpi: (row, column), sorted"""
    b = io.BytesIO()
    fig.savefig(b, format="png", dpi=dpi)
    b.seek(0)
    img = plt.imread(b)
    rows, cols = len(img), len(img[0])
    out = []
    for r in range(rows):
        row = img[r]
        for c in range(cols):
            if row[c][0] < 0.5:
                out.append((r, c))
    if out:
        r0, c0 = min(out)
        out = [(r - r0, c - c0) for r, c in out]
    return (rows, cols), out


def figure(points, w=W, h=H, **kw):
    fig = plt.figure(figsize=(w / 100, h / 100))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    xs = [x + 0.5 for x, y in points]
    ys = [y + 0.5 for x, y in points]
    ax.plot(xs, ys, ",", color="black", **kw)
    return fig


points = [(2, 2), (5, 3), (10, 10), (11, 10), (20, 15), (36, 26), (25, 7), (33, 21)]
for kw in ({}, {"markersize": 20}, {"ms": 0.5}):
    fig = figure(points, **kw)
    for dpi in (100, 200, 300):
        size, px = dark(fig, dpi)
        print("dpi", dpi, kw, size, len(px), px)
    plt.close(fig)
# (a line through them too: the markers are on it, the line drawn as well)
fig = figure(points, linestyle="-")
size, px = dark(fig, 100)
print("with a line: more than the points", len(px) > len(points))
plt.close(fig)
# (a wide figure at 300 dpi: the last points are thousands of pixels from the
# first, each still one pixel where it should be)
wide = [(1, 1), (7, 20), (500, 1), (1333, 27), (1998, 14)]
fig = figure(wide, w=2000, h=30)
size, px = dark(fig, 300)
print("wide, dpi 300", size, len(px), px)
plt.close(fig)
# scatter has no pixel marker: matplotlib's draws ',' as the square 's', with a warning
for m in (",", "s"):
    fig = figure([])
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        fig.axes[0].scatter([10.5, 25.5], [10.5, 20.5], marker=m, color="black")
    print("scatter", repr(m), [(w.category.__name__, str(w.message)) for w in caught])
    size, px = dark(fig, 100)
    if m == ",":
        comma = px
    else:
        print("scatter ',' draws as 's':", comma == px, len(px) > 2)
    plt.close(fig)
