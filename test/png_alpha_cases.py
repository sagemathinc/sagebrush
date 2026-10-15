# Colors' alpha and "none" in the pixels of a saved PNG (CORR-3D8-1): a
# filled area and a thick line across a 1-inch figure whose axes fill it,
# with colors given as (color, alpha) pairs, arrays, tuples with alpha,
# "#rrggbbaa", "none" in any case, and with alpha= too; the pixel at the
# center, where both draw solidly (each channel within 1: Agg truncates
# where tiny-skia rounds when it blends).  CPython with matplotlib prints what
# test/png_oracle_gen.py records; Sagebrush must print the same
# (test/png.test.ts).
import io
from fractions import Fraction
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def center(draw):
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
    return [round(float(v) * 255) for v in a[50, 50]]


colors = [("r", 0.5), ("C1", 0.25), np.array([0, 0, 1, 0.5]), (1, 0, 0, 0.5), "#ff000080", "#f008", (Fraction(1, 2), 0, 0),
          "NONE", "NoNe", "none", "red"]
for c in colors:
    print("fill", repr(c), center(lambda ax: ax.fill_between([0, 1], [0, 0], [1, 1], color=c, linewidth=0)))
    print("line", repr(c), center(lambda ax: ax.plot([0, 1], [0.5, 0.5], color=c, linewidth=40)))
for c, alpha in [((1, 0, 0, 0.5), 0.8), ("#ff000080", 1.0), (("r", 0.5), 0.3)]:
    print("fill alpha", repr(c), alpha, center(lambda ax: ax.fill_between([0, 1], [0, 0], [1, 1], color=c, alpha=alpha, linewidth=0)))
    print("line alpha", repr(c), alpha, center(lambda ax: ax.plot([0, 1], [0.5, 0.5], color=c, alpha=alpha, linewidth=40)))
# set_alpha and set_color afterwards: the alpha set replaces the color's
# while it is set, and the color's own comes back with set_alpha(None)
# (CORR-F02-1)


def mutate(steps):
    def draw(ax):
        line = ax.plot([0, 1], [0.5, 0.5], color=(1, 0, 0, 0.2), linewidth=40)[0]
        for name, v in steps:
            getattr(line, name)(v)
    return draw


for steps in [[("set_alpha", 0.6)], [("set_alpha", 0.6), ("set_alpha", None)], [("set_alpha", 0.8), ("set_color", (1, 0, 0, 0.4))],
              [("set_color", (0, 0, 1, 0.4))], [("set_alpha", 0.8), ("set_color", "#00ff0066"), ("set_alpha", None)],
              [("set_color", "blue"), ("set_alpha", 0.5)]]:
    print("line", steps, center(mutate(steps)))
