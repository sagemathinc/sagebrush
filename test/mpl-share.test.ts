import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// matplotlib's shared axes: subplots(sharex=, sharey=) with True, 'all',
// 'row', 'col' and 'none'; add_subplot and subplot with sharex=/sharey=;
// Axes.sharex/sharey.  Shared Axes autoscale over all their data and share
// set limits, scale and direction (test/mpl_share_cases.py, against what
// CPython with matplotlib printed: test/mpl-oracle.json).  subplots leaves the
// tick labels of a shared axis to the bottom row and the first column, as
// matplotlib's label_outer, and tick_params(labelbottom=, labelleft=) shows or
// hides them.
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("shared axes have matplotlib's limits: one autoscale of all their data, set limits, scale and direction shared (test/mpl_share_cases.py)", () => {
  assert.equal(run([TEST + "mpl_share_cases.py"]), oracle["mpl_share_cases.py"]);
});

// each Axes' panel drawn alone: how many x tick labels (middle-anchored text)
// and y tick labels (end-anchored), and tick marks, it has
const COUNT = `
import re, _graphics
def counts(fig):
    out = []
    for ax in fig.axes:
        s = _graphics.render_svg([(ax._panel(), (0, 0, 1, 1))], 400, 300)
        x = len(re.findall(r'<text x="[^"]*" y="[^"]*" text-anchor="middle"( dominant-baseline="central" transform="[^"]*")?>', s))
        y = len(re.findall(r'<text x="[^"]*" y="[^"]*" text-anchor="end" dominant-baseline="middle">', s))
        ticks = len(re.findall(r'v4', s))
        out.append((x > 0, y > 0, ticks))
    return out
`;

test("subplots' shared axes show their tick labels where matplotlib's label_outer leaves them: the bottom row, the first column", () => {
  const out = run(["-c", COUNT + `
import matplotlib.pyplot as plt
for sx, sy in ((True, True), ("col", "row"), ("row", "col"), (False, False), ("all", "none")):
    fig, axs = plt.subplots(2, 3, sharex=sx, sharey=sy)
    for k, ax in enumerate(axs.flat):
        ax.plot([k, k + 1], [0, k + 1])
    c = counts(fig)
    print(sx, sy, "x", "".join("1" if a else "0" for a, _, _ in c), "y", "".join("1" if b else "0" for _, b, _ in c))
    plt.close(fig)
`]);
  // (the Axes in reading order; matplotlib 3.11.1: labelbottom off above the
  // last row when x is shared by 'all' or 'col', labelleft off right of the
  // first column when y is shared by 'all' or 'row')
  assert.deepEqual(out.trim().split("\n"), [
    "True True x 000111 y 100100",
    "col row x 000111 y 100100",
    "row col x 111111 y 111111",
    "False False x 111111 y 111111",
    "all none x 000111 y 111111",
  ]);
});

test("tick_params(labelbottom=False, labelleft=False) hides the tick labels, rotated ones too, and keeps the ticks", () => {
  const out = run(["-c", COUNT + `
import matplotlib.pyplot as plt
fig, axs = plt.subplots(1, 3)
for ax in axs:
    ax.plot([0, 10], [0, 5])
axs[1].tick_params(labelbottom=False)
axs[2].tick_params(axis="x", labelrotation=45)
axs[2].tick_params(labelbottom=False, labelleft=False)
print(counts(fig))
axs[1].tick_params(labelbottom=True)
print(counts(fig)[1][:2])
`]);
  const [first, second] = out.trim().split("\n");
  const c = JSON.parse(first.replace(/\(/g, "[").replace(/\)/g, "]").replace(/True/g, "true").replace(/False/g, "false"));
  assert.deepEqual(c.map((v: any[]) => v.slice(0, 2)), [[true, true], [false, true], [false, false]]);
  assert.ok(c[1][2] === c[0][2] && c[2][2] === c[0][2], `the ticks stay: ${first}`);
  assert.equal(second, "(True, True)");
});
