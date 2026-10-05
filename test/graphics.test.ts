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
