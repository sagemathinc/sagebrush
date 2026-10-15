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
# hex strictly (ASCII hex digits, 3, 4, 6 or 8 of them), gray levels,
# names in any case, the color cycle's C<n> (CORR-788-1, CORR-EE6-1)
for c in ['#abc', '#ABCD', '#abcdef', '#ABCDEF80', '#ff00-1', '#ff00+1', '#ff00 1', '#ff\n0000', '#ff0000\n', ' #ff0000', '#ab',
          '#abcde', '#abcdefa', '#abcdef801', '#gg0000', '#', 'ff0000', '#١٢٣', '#-ab', '#+abc', '#0x12',
          '0.5', ' 0.5', '0.5 ', '1.5', '-0.1', 'nan', 'inf', '1e-1', '0x1', '.5', '1', '0', '+0.5', '0_5',
          'red', 'Red', 'RED', ' red', 'red ', 'darkgrey', 'DarkGrey', 'grey', 'r', 'R', 'B', 'k', 'w', 'C0', 'C9', 'C10', 'C255', 'C00',
          'c0', 'C-1', 'C', 'C 1', 'C٣', 'tab:blue', 'TAB:BLUE', 'tab:Blue', 'tab:grey', 'Tab:gray', 'None', 'NONE', '']:
    try:
        print(repr(c), to_rgba(c))
    except ValueError as e:
        print(repr(c), "ValueError", e)
for c in ['#ff00-1', '#ff00 1', '#abc', '#abcd']:
    for where in ("plot", "savefig"):
        fig, ax = plt.subplots()
        try:
            if where == "plot":
                ax.plot([0, 1], [0, 1], color=c)
            b = io.StringIO()
            fig.savefig(b, format="svg", **({"facecolor": c} if where == "savefig" else {}))
            print(repr(c), where, "saved")
        except ValueError as e:  # (plot's message is Line2D's, which differs: its type)
            print(repr(c), where, "ValueError", e if where == "savefig" else "")
        plt.close("all")
# alpha given, (color, alpha) pairs, arrays, sequences of other lengths
import numpy as np
for args in [("r", 2), ("r", -0.1), ("r", 0.5), ("r", float("nan")), (("r", 0.3),), (("r", 0.3), 0.6), ((1, 0, 0, 0.5),),
             ((1, 0, 0, 0.5), None), (np.array([1, 0, 0]),), (np.array([1, 0, 0, 0.2]),), (np.array([[1, 0, 0]]),), (np.array([0.5]),),
             ([1, 0, 0],), (("#abc", 2),), (("#abcd", 0.5),), ("none", 0.5), ((1, 0, 0), 1), ("r", True), ((1, 0),), ([1, 0],),
             ((1, 0, 0, 0, 0),), (("r", "g", "b"),), ((1, 0, 0, 2),), ((1, 0, 0), 0.5), ("C12", 0.25), ("0.5", 1)]:
    try:
        print(repr(args), to_rgba(*args))
    except ValueError as e:
        print(repr(args), "ValueError", e)
