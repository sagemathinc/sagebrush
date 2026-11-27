import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A legend placed by bbox_to_anchor, as matplotlib's: its loc corner or side at a point (or inside a box) in axes
// fractions, borderaxespad (in the legend's 10-point font sizes) inside it, outside the axes as well. Shown in a
// notebook, the figure grows to show a legend outside it, as the inline backend's bbox_inches="tight" does;
// savefig's figure keeps its size, as matplotlib's does without bbox_inches.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("where the legend goes: its loc side at the anchor point or inside the anchor box, the pad inside", () => {
  const out = py(`
import re
from _graphics import Panel, Line, _Placed
P = _Placed(100, 50, 400, 300, 0, 1, 0, 1, False, False)   # (the axes: 400 x 300 px at (100, 50))
def box(**o):
    p = Panel([Line([0, 1], [0, 1], label="a"), Line([0, 1], [1, 0], label="b")], legend=True, **o)
    svg = p._legend_svg(P)
    x, y, w, h = [float(v) for v in re.search(r'<rect x="([-0-9.]+)" y="([-0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"', svg).groups()]
    return round(x, 3), round(y, 3), round(h, 3), "title" if ">species<" in svg else ""
print(box(legend_anchor=(1.05, 0.5), legend_loc="center left", legend_pad=0.0))
print(box(legend_anchor=(1.0, 1.0), legend_loc="upper left"))
print(box(legend_anchor=(0.0, 0.0, 1.0, 0.2), legend_loc="lower right", legend_pad=0.0))
print(box(legend_anchor=(0.5, 1.02), legend_loc="lower center", legend_pad=0.0, legend_title="species"))
print(box(legend_loc="upper right"))
`);
  // (two one-letter entries: 46.6 px wide, 2 * 18 + 8 = 44 px tall; with the title 62.2 wide, 62 tall; the default
  // pad 0.5 font sizes = 5 points = 6.944 px; the SVG's numbers at 2 decimals)
  assert.equal(out, [
    "(520.0, 178.0, 44.0, '')",
    "(506.94, 56.94, 44.0, '')",
    "(453.4, 306.0, 44.0, '')",
    "(268.9, -18.0, 62.0, 'title')",
    "(445.4, 58.0, 44.0, '')",
    "",
  ].join("\n"));
});

test("pyplot: borderaxespad in 10-point font sizes, and a shown figure grown left and up to a legend outside its top left", () => {
  const out = py(`
import re
import matplotlib.pyplot as plt
box = lambda svg: [float(v) for v in re.search(r'class="sb-legend"><rect x="([-0-9.]+)" y="([-0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"', svg).groups()]
view = lambda svg: [float(v) for v in re.search(r'viewBox="([^"]*)"', svg).group(1).split()]
fig = plt.figure()
plt.plot([0, 1], [0, 1], label="a")
plt.legend(bbox_to_anchor=(1, 1), loc="upper left", borderaxespad=0)
a = box(fig._repr_svg_())
plt.legend(bbox_to_anchor=(1, 1), loc="upper left", borderaxespad=1)
b = box(fig._repr_svg_())
print("pad", round(b[0] - a[0], 2), round(b[1] - a[1], 2))
plt.legend(bbox_to_anchor=(-0.5, 1.5), loc="lower right", borderaxespad=0)
svg = fig._repr_svg_()
x, y, w, h = box(svg)
x0, y0, vw, vh = view(svg)
print("origin", x0 < 0, y0 < 0, round(x - x0, 2), round(y - y0, 2), x0 + vw >= 640, y0 + vh >= 480)
`);
  // (1 font size = 10 points = 13.89 px at 100 dpi; the grown view box reaches 4 px past the legend)
  assert.equal(out, "pad 13.89 13.89\norigin True True 4.0 4.0 True True\n");
});

test("pyplot: bbox_to_anchor, borderaxespad and title; the shown figure grows to a legend outside it, savefig's doesn't", () => {
  const out = py(`
import os, re, tempfile
import matplotlib.pyplot as plt
fig = plt.figure()
plt.plot([0, 1], [0, 1], label="prey")
plt.plot([0, 1], [1, 0], label="predator")
plt.legend(bbox_to_anchor=(1.05, 0.5), loc='center left', borderaxespad=0.)
size = lambda svg: re.search(r'viewBox="([^"]*)"', svg).group(1)
print("shown", size(fig._repr_svg_()), "prey" in fig._repr_svg_())
f = os.path.join(tempfile.mkdtemp(), "f.svg")
fig.savefig(f)
print("saved", size(open(f).read()))
plt.legend(loc="upper left")
print("inside", size(fig._repr_svg_()))
plt.legend(title="species", bbox_to_anchor=(0, 1, 1, 0.1), loc="lower left", borderaxespad=1)
print("title", ">species<" in fig._repr_svg_())
for bad in ((1, 2, 3),):
    try:
        plt.legend(bbox_to_anchor=bad)
    except ValueError as e:
        print("ValueError", e)
try:
    plt.legend(ncols=2)
except NotImplementedError as e:
    print("NotImplementedError", e)
`);
  assert.match(out, /^shown 0 0 7\d\d\.\d+ 480 True\n/);
  assert.equal(out.split("\n").slice(1).join("\n"), [
    "saved 0 0 640 480",
    "inside 0 0 640 480",
    "title True",
    "ValueError Invalid bbox: (1, 2, 3)",
    "NotImplementedError legend(): ncols not supported by sagebrush's matplotlib",
    "",
  ].join("\n"));
});
