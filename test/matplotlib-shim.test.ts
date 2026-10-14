import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";

// lib/matplotlib against matplotlib itself: the expected values below are what
// CPython's matplotlib 3.11.1 prints for the same programs.
const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

/** the RGBA rows of a data: URL PNG as lib/matplotlib writes it (filter 0 rows; RGBA or a palette) */
function png(url: string): number[][][] {
  const b = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  let i = 8, w = 0, h = 0, kind = 0, plte: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (i < b.length) {
    const n = b.readUInt32BE(i), t = b.toString("latin1", i + 4, i + 8), d = b.subarray(i + 8, i + 8 + n);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); kind = d[9]; }
    if (t === "PLTE") plte = d;
    if (t === "tRNS") trns = d;
    if (t === "IDAT") idat.push(d);
    i += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat)), bpp = kind === 3 ? 1 : 4, rows: number[][][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[][] = [];
    for (let x = 0; x < w; x++) {
      const o = y * (w * bpp + 1) + 1 + x * bpp;
      row.push(kind === 3 ? [plte![3 * raw[o]], plte![3 * raw[o] + 1], plte![3 * raw[o] + 2], trns ? trns[raw[o]] : 255] : [...raw.subarray(o, o + 4)]);
    }
    rows.push(row);
  }
  return rows;
}

test("imshow: limits, extent and clim as matplotlib's; row 0 at the top with origin='upper'", () => {
  const out = run(`
import matplotlib.pyplot as plt
import numpy as np
A = np.array([[0.0, 1.0, 2.0], [3.0, 4.0, np.nan]])
for kw in [{}, {"origin": "lower"}, {"extent": [0, 10, 0, 5]}, {"extent": [0, 10, 5, 0], "origin": "lower"}, {"aspect": "auto"}]:
    fig, ax = plt.subplots()
    im = ax.imshow(A, **kw)
    print(kw, tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim()), [float(v) for v in im.get_extent()], tuple(float(v) for v in im.get_clim()))
fig, ax = plt.subplots()
im = ax.imshow(np.zeros((2, 3, 3), dtype=np.uint8))
print("rgb", tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim()))
for origin in ["upper", "lower"]:
    fig, ax = plt.subplots()
    ax.imshow(np.array([[0, 0], [0, 9]]), cmap="gray", origin=origin)
    print(fig._repr_svg_())
`);
  const lines = out.split("\n");
  assert.deepEqual(lines.slice(0, 6), [
    "{} (-0.5, 2.5) (1.5, -0.5) [-0.5, 2.5, 1.5, -0.5] (0.0, 4.0)",
    "{'origin': 'lower'} (-0.5, 2.5) (-0.5, 1.5) [-0.5, 2.5, -0.5, 1.5] (0.0, 4.0)",
    "{'extent': [0, 10, 0, 5]} (0.0, 10.0) (0.0, 5.0) [0.0, 10.0, 0.0, 5.0] (0.0, 4.0)",
    "{'extent': [0, 10, 5, 0], 'origin': 'lower'} (0.0, 10.0) (5.0, 0.0) [0.0, 10.0, 5.0, 0.0] (0.0, 4.0)",
    "{'aspect': 'auto'} (-0.5, 2.5) (1.5, -0.5) [-0.5, 2.5, 1.5, -0.5] (0.0, 4.0)",
    "rgb (-0.5, 2.5) (1.5, -0.5)",
  ]);
  // the picture: the white cell (9) is row 1; with origin 'upper' it is drawn at the bottom
  // (the PNG as stored, not flipped), with 'lower' at the top (the PNG flipped vertically)
  const svgs = lines.slice(6).join("\n").split("</svg>").slice(0, 2);
  for (const [k, svg] of svgs.entries()) {
    const m = /<image href="(data:image\/png;base64,[^"]+)"[^>]*?(transform="matrix\(([^)]*)\)")?\/>/.exec(svg)!;
    assert.ok(m, "an image");
    const rows = png(m[1]);
    assert.deepEqual(rows[0][0], [0, 0, 0, 255]);
    assert.deepEqual(rows[1][1], [255, 255, 255, 255]);
    const flipped = m[3] !== undefined && m[3].split(" ")[3] === "-1";
    assert.equal(flipped, k === 1);
  }
});

test("contourf: matplotlib's levels and limits; bands end where Z crosses a level, not at the grid's points", () => {
  const out = run(`
import matplotlib.pyplot as plt
import numpy as np
x = np.linspace(-3, 3, 7); y = np.linspace(-2, 2, 5)
X, Y = np.meshgrid(x, y)
for Z in [X**2 + Y**2, np.sin(X) * Y * 10]:
    fig, ax = plt.subplots()
    cs = ax.contourf(X, Y, Z)
    print([float(v) for v in cs.levels], tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim()))
fig, ax = plt.subplots()
cs = ax.contourf(X**2 + Y**2, 5)
print([float(v) for v in cs.levels], tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim()))
x = np.array([0.0, 1.0, 2.0]); y = np.array([0.0, 1.0])
X, Y = np.meshgrid(x, y)
fig, ax = plt.subplots()
ax.contourf(X, Y, X * 2.0, levels=[0, 1, 3, 4], cmap="gray")
print(fig._repr_svg_())
`);
  const lines = out.split("\n");
  assert.deepEqual(lines.slice(0, 3), [
    "[0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0] (-3.0, 3.0) (-2.0, 2.0)",
    "[-20.0, -15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0, 20.0] (-3.0, 3.0) (-2.0, 2.0)",
    "[0.0, 2.5, 5.0, 7.5, 10.0, 12.5, 15.0] (0.0, 6.0) (0.0, 4.0)",
  ]);
  // Z = 2x on a 3-point grid crosses the levels 1 and 3 at x = 0.5 and 1.5: a quarter
  // and three quarters of the way across (matplotlib draws the bands there too)
  const url = /<image href="(data:image\/png;base64,[^"]+)"/.exec(lines.slice(3).join("\n"))![1];
  const row = png(url)[0];
  const edges: number[] = [];
  for (let i = 1; i < row.length; i++) if (row[i].join() !== row[i - 1].join()) edges.push(i / row.length);
  assert.equal(edges.length, 2);
  assert.ok(Math.abs(edges[0] - 0.25) < 0.01 && Math.abs(edges[1] - 0.75) < 0.01, String(edges));
});

test("errorbar: scalar, 1-D and (2, N) errors as matplotlib's (limits, errors); fmt '' a line", () => {
  const out = run(`
import matplotlib.pyplot as plt
import numpy as np
import re
x = np.array([1.0, 2.0, 3.0]); y = np.array([2.0, 4.0, 3.0])
for kw in [{"yerr": 0.5}, {"yerr": [0.1, 0.2, 0.3]}, {"yerr": [[0.1, 0.2, 0.3], [1.0, 2.0, 3.0]]}, {"xerr": [[0.5, 0.5, 0.5], [0.1, 0.1, 2.0]], "yerr": 0.2},
           {"yerr": np.array([[1.0, 1.0, 1.0], [0.0, 0.0, 0.0]])}]:
    fig, ax = plt.subplots()
    ax.errorbar(x, y, fmt="o", **kw)
    print(tuple(round(float(v), 6) for v in ax.get_xlim()), tuple(round(float(v), 6) for v in ax.get_ylim()))
fig, ax = plt.subplots()
for kw in [{"yerr": [[1, 2], [3, 4]]}, {"yerr": [-1, 0, 1]}, {"xerr": [[0.1, 0.2, 0.3]] * 3}]:
    try:
        ax.errorbar([1, 2, 3], [1, 2, 3], **kw)
    except ValueError as e:
        print(e)
fig, ax = plt.subplots()
ax.errorbar([1, 2, 3], [2, 4, 3], yerr=[[0.1, 0.2, 0.3], [1, 2, 3]], capsize=3)
print(re.search(r'aria-label="([^"]*)"', fig._repr_svg_()).group(1))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "(0.9, 3.1) (1.35, 4.65)",
    "(0.9, 3.1) (1.785, 4.315)",
    "(0.9, 3.1) (1.695, 6.205)",
    "(0.275, 5.225) (1.68, 4.32)",
    "(0.9, 3.1) (0.85, 4.15)",
    "'yerr' (shape: (2, 2)) must be a scalar or a 1D or (2, n) array-like whose shape matches 'y' (shape: (3,))",
    "'yerr' must not contain negative values",
    "'xerr' (shape: (3, 3)) must be a scalar or a 1D or (2, n) array-like whose shape matches 'x' (shape: (3,))",
    // (the bars, their lower and their upper caps, as matplotlib's two caplines, and the data as a line)
    "Plot: line through 6 points, 3 points, 3 points, line through 3 points; x from 0.9 to 3.1, y from 1.695 to 6.205",
  ]);
});

test("colorbar of any mappable: images, scatters colored by values, ScalarMappable, contour sets; pyplot's current image", () => {
  const out = run(`
import matplotlib.pyplot as plt
import matplotlib.cm as cm
from matplotlib.colors import Normalize
import numpy as np
fig, ax = plt.subplots()
ax.imshow(np.array([[0.0, 1.0], [3.0, 4.0]]))
try:
    plt.colorbar()
except RuntimeError as e:
    print("ax.imshow is not current:", e)
fig = plt.figure()
plt.imshow(np.array([[0.0, 1.0], [3.0, 4.0]]))
cb = plt.colorbar()
print("imshow", tuple(float(v) for v in cb.ax.get_ylim()))
fig = plt.figure()
plt.scatter([1, 2], [1, 2], c=[2.0, 3.0])
plt.plot([1, 2])
cb = plt.colorbar()
print("plt.scatter", tuple(float(v) for v in cb.ax.get_ylim()))
fig, ax = plt.subplots()
sc = ax.scatter([1, 2, 3], [1, 2, 3], c=[5.0, 7.0, 9.0], cmap="plasma")
cb = fig.colorbar(sc, ax=ax)
print("scatter", tuple(float(v) for v in cb.ax.get_ylim()))
fig, ax = plt.subplots()
sc = ax.scatter([1, 2, 3], [1, 2, 3], c=[5.0, 7.0, 9.0], vmin=0, vmax=20)
cb = fig.colorbar(sc)
print("scatter vmin", tuple(float(v) for v in cb.ax.get_ylim()))
fig, ax = plt.subplots()
sm = cm.ScalarMappable(norm=Normalize(0, 10), cmap="viridis")
cb = fig.colorbar(sm, ax=ax)
print("sm", tuple(float(v) for v in cb.ax.get_ylim()), sm.get_clim())
fig, ax = plt.subplots()
cs = ax.contourf(np.array([[0.0, 1.0], [2.0, 3.0]]), levels=[0, 1, 2, 3])
cb = plt.colorbar(cs)
print("contourf", tuple(float(v) for v in cb.ax.get_ylim()))
fig, ax = plt.subplots()
ax.plot([1, 2])
try:
    plt.colorbar()
except RuntimeError as e:
    print(e)
`);
  const none = "No mappable was found to use for colorbar creation. First define a mappable such as an image (with imshow) or a contour set (with contourf).";
  assert.deepEqual(out.trim().split("\n"), [
    "ax.imshow is not current: " + none,
    "imshow (0.0, 4.0)",
    "plt.scatter (2.0, 3.0)",
    "scatter (5.0, 9.0)",
    "scatter vmin (0.0, 20.0)",
    "sm (0.0, 10.0) (0.0, 10.0)",
    "contourf (0.0, 3.0)",
    none,
  ]);
});

test("imshow takes a norm's vmin and vmax each, the data's range for the one it leaves None", () => {
  const out = run(`
import matplotlib.pyplot as plt
from matplotlib.colors import Normalize
import numpy as np
for kw in [{"vmax": 10}, {"vmin": -3}, {"vmin": -3, "vmax": 10}, {}]:
    fig, ax = plt.subplots()
    im = ax.imshow(np.array([[0.0, 1.0]]), norm=Normalize(**kw))
    print(kw, tuple(float(v) for v in im.get_clim()))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "{'vmax': 10} (0.0, 10.0)",
    "{'vmin': -3} (-3.0, 1.0)",
    "{'vmin': -3, 'vmax': 10} (-3.0, 10.0)",
    "{} (0.0, 1.0)",
  ]);
});

test("clearing the axes of pyplot's current image clears it; another axes' cla does not", () => {
  const out = run(`
import matplotlib.pyplot as plt
import numpy as np
A = np.array([[0.0, 1.0]])
none = lambda: plt.gci() is None
plt.figure()
plt.imshow(A)
plt.cla()
print("plt.cla", none())
try:
    plt.colorbar()
except RuntimeError as e:
    print("colorbar:", e)
fig = plt.figure()
ax = fig.gca()
plt.imshow(A)
ax.clear()
print("ax.clear", none())
fig, (a, b) = plt.subplots(1, 2)
im = plt.imshow(A)
a.cla()
print("another axes' cla", plt.gci() is im)
b.cla()
print("its own axes' cla", none())
`);
  assert.deepEqual(out.trim().split("\n"), [
    "plt.cla True",
    "colorbar: No mappable was found to use for colorbar creation. First define a mappable such as an image (with imshow) or a contour set (with contourf).",
    "ax.clear True",
    "another axes' cla True",
    "its own axes' cla True",
  ]);
});

test("a colorbar of a ScalarMappable with no limits is 0 to 1, as matplotlib's; set_array still scales it", () => {
  const out = run(`
import matplotlib.pyplot as plt
import matplotlib.cm as cm
from matplotlib.colors import Normalize
for name, sm in [("default", cm.ScalarMappable()), ("vmin only", cm.ScalarMappable(norm=Normalize(vmin=2))), ("set_array", cm.ScalarMappable())]:
    if name == "set_array":
        sm.set_array([2.0, 5.0])
    fig, ax = plt.subplots()
    cb = fig.colorbar(sm, ax=ax)
    print(name, tuple(float(v) for v in cb.ax.get_ylim()), tuple(float(v) for v in sm.get_clim()))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "default (0.0, 1.0) (0.0, 1.0)",
    "vmin only (0.0, 1.0) (0.0, 1.0)",
    "set_array (2.0, 5.0) (2.0, 5.0)",
  ]);
});

test("errorbar returns matplotlib's ErrorbarContainer: (data line or None, caplines, barlinecols), fmt='none' too", () => {
  const out = run(`
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
c = ax.errorbar([1], [2], fmt="none")
print(type(c).__name__, len(c), c[0], len(c[1]), len(c[2]))
c = plt.errorbar([1, 2], [2, 3], yerr=[0.5, 0.5], fmt="none")
print(type(c).__name__, len(c), c[0], len(c[1]), len(c[2]))
c = ax.errorbar([1, 2], [2, 3], yerr=0.5, capsize=2)
print(type(c).__name__, len(c), c[0] is not None, len(c[1]), len(c[2]))
c = ax.errorbar([1, 2], [2, 3], xerr=0.1, yerr=0.5, capsize=2)
print(type(c).__name__, len(c), c[0] is not None, len(c[1]), len(c[2]), c.has_xerr, c.has_yerr)
`);
  assert.deepEqual(out.trim().split("\n"), [
    "ErrorbarContainer 3 None 0 0",
    "ErrorbarContainer 3 None 0 1",
    "ErrorbarContainer 3 True 2 1",
    "ErrorbarContainer 3 True 4 2 True True",
  ]);
});
