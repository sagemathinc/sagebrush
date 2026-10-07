import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("Sage plotting: composable Graphics, SVG with a description", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbplot-"));
  const out = cli("--sage", "-c", `
g = plot(sin(x^2), (x, 0, 2*pi), color='red', legend_label='s', title='T') + point((1, 0), size=30)
print(g)
g.save('${dir}/a.svg')
print(g.description())
print(len(plot(lambda t: 1/t, -1, 1)[0].xs) > 200)
print(sin(x^2)/x, (x + 1)^2, 2*pi)
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "Graphics object consisting of 2 graphics primitives");
  assert.match(lines[1], /^Plot: "T"; line "s" through \d+ points, 1 point; x from 0 to 6\.283/);
  assert.equal(lines[2], "True");
  assert.equal(lines[3], "sin(x^2)/x (x + 1)^2 2*pi");
  const svg = readFileSync(join(dir, "a.svg"), "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /role="img" aria-label="Plot: &quot;T&quot;/);
  assert.match(svg, /class="sb-panel" data-xr="0.0 6.28318/);
});

test("rendering is deterministic", () => {
  const prog = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [3, 1, 2], 'o-')\nprint(plt.gcf()._repr_svg_())";
  assert.equal(cli("-c", prog), cli("-c", prog));
});

test("matplotlib.pyplot subset", () => {
  const out = cli("-c", `
import matplotlib.pyplot as plt
fig, axs = plt.subplots(1, 2, figsize=(8, 3))
axs[0].bar(['a', 'b'], [3, 5])
axs[1].hist([1, 2, 2, 3, 3, 3], bins=3)
axs[1].set_yscale('log')
print(fig)
print(fig.description())
l, = plt.plot([0, 1], [0, 1], 'r--', label='diag')
print(l.get_label(), type(l).__name__)
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "<Figure size 800x300 with 2 Axes>");
  assert.match(lines[1], /^Figure with 2 plots: 2 bars; .* \| 3 bars; .*log scale$/);
  assert.equal(lines[2], "diag Line2D");
});

test("show() on the command line writes an SVG file", () => {
  const out = cli("-c", "import matplotlib.pyplot as plt\nplt.plot([1, 4, 9])\nplt.show()");
  const m = /Saved (\S+\.svg) \(Plot: line through 3 points/.exec(out);
  assert.ok(m, out);
  assert.match(readFileSync(m![1], "utf8"), /<svg /);
});

test("interact runs once with its defaults without a notebook", () => {
  const out = cli("--sage", "-c", "@interact\ndef f(n=slider(1, 9, 1, 4), c=['a', 'b'], ok=True, r=(0, 10)):\n    print(n, c, ok, r)");
  assert.equal(out, "4 a True 5\n");
  const out2 = cli("-c", "from ipywidgets import interact\n@interact(k=(0.0, 1.0))\ndef g(k=0.3, n=5):\n    print(k, n)");
  assert.equal(out2, "0.3 5\n");
});

test("animations: Sage animate and matplotlib FuncAnimation give animated SVG", () => {
  const out = cli("--sage", "-c", `
a = animate([plot(sin(x + k), (x, 0, 2*pi)) for k in srange(0, 2*pi, 0.5)])
print(a, a[0], (a * a), a + point((0, 0)))
s = a._repr_svg_()
print(s.count('class="sb-frame"'), 'data-delay="200"' in s, '@keyframes' in s)
print(a.description()[:40])
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "Animation with 13 frames Graphics object consisting of 1 graphics primitive Animation with 26 frames Animation with 13 frames");
  assert.equal(lines[1], "13 True True");
  assert.equal(lines[2], "Animation of 13 frames, 0.2 s each; firs");
  const mpl = cli("-c", `
import math
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
fig, ax = plt.subplots()
line, = ax.plot([], [])
def update(k):
    line.set_data([0, 1, 2], [0, k, 2 * k])
ani = FuncAnimation(fig, update, frames=4, interval=50)
s = ani._repr_svg_()
print(s.count('class="sb-frame"'), 'data-delay="50"' in s)
`);
  assert.equal(mpl, "4 True\n");
});

test("3D graphics: SVG and a scene for the WebGL viewer; .html saves the viewer", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbplot3d-"));
  const out = cli("--sage", "-c", `
y, z = var('y z')
g = plot3d(sin(x*y), (x, -3, 3), (y, -3, 3)) + point3d((0, 0, 1), color='red')
print(g, len(g))
print(g.description())
b = g._repr_mimebundle_()
print(sorted(b))
import json
s = json.loads(b['application/vnd.sagebrush.scene3d+json'])
print(s['objects'][0]['type'], len(s['objects'][0]['idx']) // 3, s['lo'], s['hi'])
h = implicit_plot3d(x^2 + y^2 + z^2 == 1, (x, -1.2, 1.2), (y, -1.2, 1.2), (z, -1.2, 1.2), plot_points=12)
print(h.description())
g.save('${dir}/a.svg'); g.save('${dir}/a.html')
print(g._svg() == g._svg())
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "Graphics3d Object 2");
  assert.equal(lines[1], "3D plot: surface z = sin(x*y) of 1600 polygons, 1 point; x from -3 to 3; y from -3 to 3; z from -1 to 1");
  assert.equal(lines[2], "['application/vnd.sagebrush.scene3d+json', 'image/svg+xml', 'text/html', 'text/plain']");
  assert.match(lines[3], /^mesh 3200 \[-3\.0, -3\.0, -0\.99\d*\] \[3\.0, 3\.0, 1\.0\]$/);
  assert.match(lines[4], /^3D plot: implicit surface of \d+ polygons; x from -1 to 1/);
  assert.equal(lines[5], "True");
  assert.match(readFileSync(join(dir, "a.svg"), "utf8"), /^<svg [^>]*aria-label="3D plot: surface z = sin\(x\*y\)/);
  const html = readFileSync(join(dir, "a.html"), "utf8");
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /SagebrushViewer3d\.mount\(document\.getElementById\("sb3d-/);
});

test("3D: Platonic solids, translate, rotate and scale", () => {
  const out = cli("--sage", "-c", `
g = icosahedron(color='orange', opacity=0.5).translate((0, 0, 1)) + tetrahedron()
print(g.description())
print([len(s()[0].faces) for s in (tetrahedron, cube, octahedron, dodecahedron, icosahedron)])
print(sorted(set(len(f) for f in dodecahedron()[0].faces)), [round(v, 6) for v in cube(size=2).bounding_box()[1]])
print([round(v, 6) for v in cube().rotateZ(pi/4).scale(1, 1, 3).translate(1, 0, 0).bounding_box()[1]])
import json
s = json.loads(g._repr_mimebundle_()['application/vnd.sagebrush.scene3d+json'])
print([(o['color'], o['opacity'], o.get('flat'), len(o['idx']) // 3) for o in s['objects']])
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "3D plot: icosahedron of 20 polygons, tetrahedron of 4 polygons; x from -0.8507 to 0.9428; y from -0.8507 to 0.8507; z from -0.3333 to 1.851");
  assert.equal(lines[1], "[4, 6, 8, 12, 20]");
  assert.equal(lines[2], "[5] [1.0, 1.0, 1.0]");
  assert.equal(lines[3], "[1.707107, 0.707107, 1.5]");
  assert.equal(lines[4], "[('#ffa500', 0.5, True, 20), ('#0000ff', 1.0, True, 4)]");
});

test("LaTeX of polynomials and factorizations", () => {
  const out = cli("--sage", "-c", `
R.<x> = QQ[]
print(latex(x^20 - 1/2*x + 3))
print(latex((x^4 - 1).factor()))
print(latex(ModularSymbols(11, 2).hecke_operator(2).charpoly().factor()))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "x^{20} - \\frac{1}{2} x + 3",
    "\\left(x - 1\\right) \\cdot \\left(x + 1\\right) \\cdot \\left(x^{2} + 1\\right)",
    "\\left(x - 3\\right) \\cdot \\left(x + 2\\right)^{2}",
  ]);
});

test("contour, density, implicit, region, vector and slope field plots", () => {
  const out = cli("--sage", "-c", `
y = var('y')
for g in [contour_plot(x^2 - y^2, (x, -2, 2), (y, -2, 2)), density_plot(sin(x*y), (x, -3, 3), (y, -3, 3)),
          implicit_plot(x^2 + y^2 == 1, (x, -2, 2), (y, -2, 2)), region_plot(x^2 + y^2 < 1, (x, -2, 2), (y, -2, 2)),
          plot_vector_field((-y, x), (x, -2, 2), (y, -2, 2)), plot_slope_field(x - y, (x, -3, 3), (y, -3, 3))]:
    print(g.description())
`);
  const lines = out.trim().split("\n");
  assert.match(lines[0], /^Plot: contour plot of x\^2 - y\^2 with 7 levels, .*; x from -2 to 2, y from -2 to 2$/);
  assert.match(lines[1], /^Plot: density plot of sin\(x\*y\), from -0\.99\d+ to 0\.99\d+; x from -3 to 3, y from -3 to 3$/);
  assert.match(lines[2], /^Plot: line through \d+ points; x from -2 to 2, y from -2 to 2$/);
  assert.match(lines[3], /^Plot: region where x\^2 \+ y\^2 < 1; x from -2 to 2, y from -2 to 2$/);
  assert.match(lines[4], /^Plot: vector field \(-y, x\) at 400 points; x from -2 to 2, y from -2 to 2$/);
  assert.match(lines[5], /^Plot: slope field of y' = x - y at 400 points; x from -3 to 3, y from -3 to 3$/);
});
