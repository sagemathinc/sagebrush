import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Figure.subplots_adjust and pyplot.subplots_adjust: the grid's Axes where
// matplotlib puts them (test/mpl_adjust_cases.py, against what CPython with
// matplotlib printed: test/mpl-oracle.json), and drawn there: each Axes'
// plot area, its clip box in the SVG, is its position times the figure's size.
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("subplots_adjust moves the grid's Axes as matplotlib's: all six parameters, one at a time, before the Axes, twice; the parameters refused (test/mpl_adjust_cases.py)", () => {
  assert.equal(run([TEST + "mpl_adjust_cases.py"]), oracle["mpl_adjust_cases.py"]);
});

test("after subplots_adjust each Axes' plot area is drawn at its position, whatever its labels' widths", () => {
  const out = run(["-c", `
import re, matplotlib.pyplot as plt
fig, axs = plt.subplots(2, 2, figsize=(6.4, 4.8))
for k, ax in enumerate(axs.flat):
    ax.plot([0, 1], [0, 10 ** (3 * k)])
    ax.set_title("t%d" % k)
    ax.set_ylabel("y")
fig.subplots_adjust(left=0.2, right=0.95, bottom=0.1, top=0.9, wspace=0.4, hspace=0.5)
s = fig._svg(background=False)
clips = re.findall(r'<clipPath id="[^"]*"><rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"', s)
for ax, c in zip(fig.axes, clips):
    b = ax.get_position()
    want = (b.x0 * 640, (1 - b.y1) * 480, b.width * 640, b.height * 480)
    print(all(abs(float(a) - w) < 0.01 for a, w in zip(c, want)))
print(len(clips))
`]);
  assert.deepEqual(out.trim().split("\n"), ["True", "True", "True", "True", "4"]);
});
