# Colors as matplotlib checks them (CORR-788-1): an invalid one is a
# ValueError wherever pyplot takes it, savefig's facecolor too (whose SVG
# rectangle gets only a canonical #rrggbb and opacity), and
# matplotlib.colors' conversions.  CPython with matplotlib prints what
# test/png_oracle_gen.py records; Sagebrush must print the same
# (test/png.test.ts).
import io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
BAD = 'red"/><script>void 0</script><rect fill="red'
calls = {
    "plot": lambda ax, b: ax.plot([0, 1], [0, 1], color=b),
    "scatter": lambda ax, b: ax.scatter([0, 1], [0, 1], color=b),
    "scatter edge": lambda ax, b: ax.scatter([0, 1], [0, 1], edgecolors=b),
    "bar": lambda ax, b: ax.bar([0, 1], [1, 2], color=b),
    "bar edge": lambda ax, b: ax.bar([0, 1], [1, 2], edgecolor=b),
    "hist": lambda ax, b: ax.hist([1, 2], color=b),
    "fill_between": lambda ax, b: ax.fill_between([0, 1], [0, 1], color=b),
    "errorbar": lambda ax, b: ax.errorbar([0], [0], yerr=1, ecolor=b),
    "axhline": lambda ax, b: ax.axhline(0, color=b),
    "text": lambda ax, b: ax.text(0, 0, "t", color=b),
    "figure": lambda ax, b: plt.figure(facecolor=b),
}
for name, f in calls.items():
    for b in ("not-a-colour", BAD):
        fig, ax = plt.subplots()
        try:
            f(ax, b)
            fig.savefig(io.BytesIO(), format="png")
            print(name, "accepted")
        except Exception as e:
            print(name, type(e).__name__)
        plt.close("all")
for color in ["not-a-colour", 'red" onload="void 0', BAD, "#12345", (1, 0, 0, 2), "red", (1, 0, 0, 0.3), "C1", "0.5", "none"]:
    fig = plt.figure(figsize=(1, 1))
    b = io.StringIO()
    try:
        fig.savefig(b, format="svg", facecolor=color)
        print(repr(color), "saved", "<script" in b.getvalue(), "onload=" in b.getvalue())
    except Exception as e:
        print(repr(color), type(e).__name__, e)
    plt.close("all")
from matplotlib.colors import to_hex, to_rgb, to_rgba
for c in ["gray", "Gray", "C3", "r", "tab:orange", "0.25", (0.1, 0.2, 0.3), (0.1, 0.2, 0.3, 0.4), "#abcdef", "#abcdef80",
          "none", "lightgoldenrodyellow"]:
    print(repr(c), to_rgb(c), to_rgba(c), to_rgba(c, 0.5), to_hex(c))
print(to_rgba((float("nan"), 0, 0)))  # (nan passes the range check, as in matplotlib)
for c in ["notacolor", "#12345", (1, 2, 3), BAD]:
    try:
        to_rgba(c)
    except ValueError as e:
        print(type(e).__name__, e)
