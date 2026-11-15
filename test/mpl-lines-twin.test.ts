import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// matplotlib's legend titles, hlines and vlines, and twinx: what they return
// and the limits they make, against what CPython with matplotlib prints for
// the same program (test/mpl-oracle.json, from test/mpl_oracle_gen.py: CI
// has no matplotlib), and how they are drawn.
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });
const panels = (svg: string) => [...svg.matchAll(/<g class="sb-panel"[^>]*data-box="([^"]*)"/g)].map((m) => m[1]);
const texts = (s: string) => [...s.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test("legend titles, hlines, vlines and twinx print as matplotlib's (test/mpl_lines_twin_cases.py)", () => {
  assert.equal(run([TEST + "mpl_lines_twin_cases.py"]), oracle["mpl_lines_twin_cases.py"]);
});

test("a legend's title is drawn above its entries, centred; a title alone is a legend too", () => {
  const svg = run(["-c", `
import matplotlib.pyplot as plt
fig, axs = plt.subplots(1, 2)
axs[0].plot([0, 1], [0, 1], label="a")
axs[0].legend(title="Series")
axs[1].legend(title="Only")
print(fig._svg())
`]);
  const legends = svg.split('<g class="sb-legend">').slice(1).map((s) => s.slice(0, s.indexOf("</g>")));
  assert.equal(legends.length, 2);
  assert.deepEqual(texts(legends[0]), ["Series", "a"]);
  assert.match(legends[0], /<text [^>]*text-anchor="middle"[^>]*>Series<\/text>/);
  const y = (name: string) => Number(legends[0].match(new RegExp(`<text [^>]*y="([\\d.]+)"[^>]*>${name}</text>`))![1]);
  assert.equal(y("a") - y("Series"), 18);
  assert.deepEqual(texts(legends[1]), ["Only"]);
});

test("hlines and vlines: a line per segment, one legend entry, its style", () => {
  const svg = run(["-c", `
import matplotlib.pyplot as plt
plt.hlines([0.5, 1.0], 0, 2, colors="r", linestyles="dashed", label="levels")
plt.vlines([0.5, 1.5], 0, [1, 1.2], colors=["g", "b"])
plt.legend()
print(plt.gcf()._svg())
`]);
  assert.equal([...svg.matchAll(/stroke="#ff0000"[^>]*stroke-dasharray="6,4"/g)].length, 3); // (two lines and the swatch)
  assert.equal([...svg.matchAll(/stroke="#008000"/g)].length, 1);
  assert.equal([...svg.matchAll(/stroke="#0000ff"/g)].length, 1);
  const legend = svg.slice(svg.indexOf('<g class="sb-legend">'));
  assert.deepEqual(texts(legend.slice(0, legend.indexOf("</g>"))), ["levels"]);
});

test("twinx: the twin is drawn in its host's box, its y axis on the right, the x axis once", () => {
  const program = (more: string) => `
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([1, 2, 3], [1, 4, 9])
ax.set_ylabel("left")
ax2 = ax.twinx()
ax2.plot([1, 2, 3], [100, 50, 10], color="g")
ax2.set_ylabel("right")
${more}`;
  const svg = run(["-c", program("print(fig._svg())")]);
  const [host, twin] = panels(svg);
  assert.equal(twin, host);
  const twinPanel = svg.slice(svg.lastIndexOf('<g class="sb-panel"'));
  // (no x tick labels; the y tick labels to the right of the box, inside the figure)
  assert.equal([...twinPanel.matchAll(/<text [^>]*text-anchor="middle">/g)].length, 0);
  const [x, , w] = host.split(" ").map(Number);
  const right = [...twinPanel.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="start"[^>]*>(\d+)<\/text>/g)];
  assert.ok(right.length >= 4, String(right.length));
  for (const m of right) assert.ok(Number(m[1]) > x + w && Number(m[1]) < 600, m[0]);
  assert.match(svg, /<title>Plot: line through 3 points; [^<]*; right y axis: line through 3 points; x from 0\.9 to 3\.1, y \(right\) from/);
  // (saved as an image, matplotlib's white axes patch is its host's alone: a
  // twin's is invisible; the patches are those savefig puts under a PNG's axes)
  const saved = run(["-c", program("print(plt._axes_patches(fig._svg(background=False), fig.axes))")]);
  assert.equal([...saved.matchAll(/<rect [^>]*fill="#ffffff" stroke="none"\/>/g)].length, 1);
});
