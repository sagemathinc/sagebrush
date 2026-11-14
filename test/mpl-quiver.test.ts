import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// matplotlib's quiver: a field of arrows. The scales, widths and axis limits below are what CPython with
// matplotlib 3.11 prints for the same programs; the arrows' geometry is checked on the primitive, with a known
// mapping from data to pixels.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("quiver's autoscaling, shaft widths and axis limits, as matplotlib's", () => {
  const out = py(`
import numpy as np
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
q = ax.quiver(1, 2, 3, 0, angles="xy", scale_units="xy", scale=1)
print("xy", q.N, q.scale, [round(float(v), 4) for v in ax.get_xlim()], [round(float(v), 4) for v in ax.get_ylim()])
for n in (3, 9, 30):
    x = np.linspace(0, 1, n)
    X, Y = np.meshgrid(x, x)
    fig, ax = plt.subplots()
    q = ax.quiver(X, Y, np.sin(3 * X), np.cos(2 * Y))
    print(n, q.N, round(float(q.scale), 6), round(float(q.width), 6), [round(float(v), 4) for v in ax.get_xlim()])
fig, ax = plt.subplots()
q = ax.quiver([1, 2, 3], [4, 5, 6])
print("uv only", q.N, round(float(q.scale), 6), [round(float(v), 4) for v in ax.get_xlim()])
x = np.linspace(-2, 2, 7)
X, Y = np.meshgrid(x, x)
q = plt.quiver(x, x, -Y, X, np.hypot(X, Y), cmap="viridis", pivot="mid")
print("grid from 1-d", q.N, round(q.scale, 6), round(q.width, 6))
`);
  assert.equal(out, [
    "xy 1 1.0 [0.945, 1.055] [1.89, 2.11]",
    "3 9 15.183799 0.0075 [-0.05, 1.05]",
    "9 81 16.012702 0.006667 [-0.05, 1.05]",
    "30 900 49.095674 0.0024 [-0.05, 1.05]",
    "uv only 3 97.298846 [-0.1, 2.1]",
    "grid from 1-d 49 31.829951 0.0075",
    "",
  ].join("\n"));
});

test("the arrows: tail at the point, length |(u, v)| / scale axes widths or (u, v) in data units, matplotlib's head", () => {
  const out = py(`
import re
from _graphics import Quiver, _Placed
P = _Placed(0, 0, 500, 300, 0, 5, 0, 3, False, False)   # (x 0..5 over 500 px, y 0..3 over 300 px)
def outline(q):
    return [[(round(float(a), 3), round(float(b), 3)) for a, b in zip(*[iter(re.findall(r"-?[0-9.]+", d))] * 2)]
            for d in re.findall(r'd="([^"]*)"', q.svg(P))]
# (angles and scale units "xy", scale 1: from (1, 2) to (4, 2), as the data says)
a, = outline(Quiver([1], [2], [3], [0], 1.0, 0.01, angles="xy", scale_units="xy"))
print("xy tail", a[0], a[-1], "tip", a[3])
# (angles "uv": (0, 1) points up the screen; 1 / scale = 0.1 axes widths = 50 px long; shaft 5 px; the head 15 px wide, 25 px long, meeting the shaft 22.5 px from the tip)
b, = outline(Quiver([2.5], [1.5], [0], [1], 10.0, 0.01))
print("uv", b)
# (shorter than its head: the whole arrow shrinks; shorter than a shaft width: a dot, six points)
c, = outline(Quiver([0], [0], [1], [0], 100.0, 0.01))
d, = outline(Quiver([0], [0], [0.05], [0], 100.0, 0.01))
print("short", c[3], len(c), "dot", len(d))
`);
  assert.equal(out, [
    "xy tail (100.0, 97.5) (100.0, 102.5) tip (400.0, 100.0)",
    "uv [(247.5, 150.0), (247.5, 122.5), (242.5, 125.0), (250.0, 100.0), (257.5, 125.0), (252.5, 122.5), (252.5, 150.0)]",
    "short (5.0, 300.0) 7 dot 6",
    "",
  ].join("\n"));
});

test("quiver's colors, labels and arguments", () => {
  const out = py(`
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
q = ax.quiver([0, 1], [0, 0], [1, 0], [0, 1], color="g", label="Vector Field")
ax.legend()
import os, tempfile
f = os.path.join(tempfile.mkdtemp(), "q.svg")
fig.savefig(f)
svg = open(f).read()
print("ok", q.N, round(q.scale, 6), "Vector Field" in svg, svg.count('fill="#008000"') >= 1)
for bad in ((1,), (1, 2, 3, 4, 5, 6)):
    try:
        plt.quiver(*bad)
    except TypeError as e:
        print("TypeError", e)
try:
    plt.quiver([0, 1, 2], [0, 1], [1, 1], [1, 1])
except ValueError as e:
    print("ValueError", str(e)[:23])
try:
    plt.quiver(1, 1, units="inches")
except NotImplementedError as e:
    print("NotImplementedError", str(e)[:30])
`);
  assert.equal(out, [
    "ok 2 18.0 True True",
    "TypeError quiver() takes from 2 to 5 positional arguments but 1 were given",
    "TypeError quiver() takes from 2 to 5 positional arguments but 6 were given",
    "ValueError Argument U has a size 2",
    "NotImplementedError quiver(units='inches'): Sagebr",
    "",
  ].join("\n"));
});
