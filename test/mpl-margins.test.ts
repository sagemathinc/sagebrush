import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A grid of subplots lines up: each panel takes the widest left and right
// margins of the panels in its grid column, and the tallest top and bottom
// margins of those in its row, so stacked axes share their x position and
// width, and a row its top and height, whatever each panel's tick labels,
// axis labels and title (the room for them is kept, so none is clipped).
// Figures that call subplots_adjust are placed exactly by matplotlib's
// positions instead (test/mpl-adjust.test.ts).
const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

// each Axes' plot area (its clip box) in the figure's SVG, in fig.axes order
const AREAS = `
import re
def areas(fig):
    s = fig._svg(background=False)
    return [tuple(float(v) for v in m) for m in re.findall(r'<clipPath id="[^"]*"><rect x="([-0-9.]+)" y="([-0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"', s)]
`;

test("stacked panels share their plot area's x position and width, whatever their y tick labels", () => {
  const out = run(AREAS + `
import matplotlib.pyplot as plt
fig, axs = plt.subplots(3, 1, sharex=True)
axs[0].plot([0, 1], [0, 123456789])
axs[1].plot([0, 1], [0, 1])
axs[2].plot([0, 1], [-5, 5])
axs[1].set_ylabel("a label")
a = areas(fig)
print(len(a), len({(x, w) for x, y, w, h in a}), all(a[i][1] < a[i + 1][1] for i in range(2)))
`);
  assert.equal(out.trim(), "3 1 True");
});

test("a grid: each column one x position and width, each row one y position and height, with titles and labels in some cells", () => {
  const out = run(AREAS + `
import matplotlib.pyplot as plt
fig, axs = plt.subplots(2, 3)
for k, ax in enumerate(axs.flat):
    ax.plot([0, 1], [0, 10 ** (2 * k)])
axs[0][1].set_title("a title")
axs[1][0].set_xlabel("an x label")
axs[1][2].set_ylabel("a y label")
a = areas(fig)
cols = [{(a[r * 3 + c][0], a[r * 3 + c][2]) for r in range(2)} for c in range(3)]
rows = [{(a[r * 3 + c][1], a[r * 3 + c][3]) for c in range(3)} for r in range(2)]
print(len(a), [len(s) for s in cols], [len(s) for s in rows])
`);
  assert.equal(out.trim(), "6 [1, 1, 1] [1, 1]");
});

test("two grids in one figure each line up on their own; a figure that calls subplots_adjust keeps matplotlib's positions", () => {
  const out = run(AREAS + `
import matplotlib.pyplot as plt
fig = plt.figure()
top = fig.add_subplot(2, 1, 1)
bl = fig.add_subplot(2, 2, 3)
br = fig.add_subplot(2, 2, 4)
top.plot([0, 1], [0, 1])
bl.plot([0, 1], [0, 1e6])
br.plot([0, 1], [0, 1])
bl.set_title("a title")
a = areas(fig)
print(len(a), a[1][1] == a[2][1] and a[1][3] == a[2][3])
fig, axs = plt.subplots(2, 1)
axs[0].plot([0, 1], [0, 1e6])
axs[1].plot([0, 1], [0, 1])
fig.subplots_adjust(left=0.2)
b = areas(fig)
print([round(v / 640, 4) for v in (b[0][0], b[1][0])], [round(ax.get_position().x0, 4) for ax in fig.axes])
`);
  assert.deepEqual(out.trim().split("\n"), ["3 True", "[0.2, 0.2] [0.2, 0.2]"]);
});
