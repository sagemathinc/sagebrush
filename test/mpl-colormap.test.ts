import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// matplotlib's custom colormaps (test/mpl_colormap_cases.py, against what CPython with matplotlib printed:
// test/mpl-oracle.json): ListedColormap and LinearSegmentedColormap.from_list from named, hex and RGBA colors, their
// table's lookup (floats, integer indices, out of range, NaN), bytes, alpha, the colors' own alpha and the input's
// shape, N and gamma; and a plot drawn with one.
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("custom colormaps as matplotlib's: named colors, table lookup, bytes, alpha, shape, N, gamma (test/mpl_colormap_cases.py)", () => {
  assert.equal(run([TEST + "mpl_colormap_cases.py"]), oracle["mpl_colormap_cases.py"]);
});

test("points drawn with a custom colormap of named colors take its table's colors", () => {
  const out = run(["-c", `import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap, LinearSegmentedColormap
import re
for cm in (ListedColormap(['red', 'blue']), LinearSegmentedColormap.from_list('m', ['red', 'blue'], N=3)):
    fig, ax = plt.subplots()
    ax.scatter([0, 1, 2], [0, 1, 2], c=[0.0, 0.5, 1.0], cmap=cm)
    print(sorted(set(c.lower() for c in re.findall(r'#[0-9a-fA-F]{6}', fig._svg()))))`]);
  // (0.5 is entry floor(0.5 N): the second of two colors; the middle of three, (0.5, 0, 0.5) as a byte each)
  assert.equal(out, "['#0000ff', '#ff0000']\n['#0000ff', '#800080', '#ff0000']\n");
});

test("points drawn with a custom colormap keep its colors' alpha", () => {
  const out = run(["-c", `import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
import re
fig, ax = plt.subplots()
ax.scatter([0, 1], [0, 1], c=[0.0, 1.0], cmap=ListedColormap([(1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.5)]))
print(sorted(set(re.findall(r'fill="(rgba[^"]*)"', fig._svg()))))`]);
  // (a transparent red and a half-transparent blue, not opaque)
  assert.equal(out, "['rgba(0, 0, 255, 0.5)', 'rgba(255, 0, 0, 0)']\n");
});

test("points drawn with a colormap of segment data take its segments' colors, not viridis'", () => {
  const out = run(["-c", `import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import re
cd = {'red': [(0, 0, 0), (0.5, 1, 1), (1, 1, 1)], 'green': [(0, 0, 0), (0.25, 0, 0), (0.75, 1, 1), (1, 1, 1)],
      'blue': [(0, 0, 0), (0.5, 0, 1), (1, 0.5, 0.5)]}
fig, ax = plt.subplots()
ax.scatter([0, 1, 2], [0, 1, 2], c=[0.0, 0.5, 1.0], cmap=LinearSegmentedColormap('s', cd))
print(sorted(set(c.lower() for c in re.findall(r'fill="(#[0-9a-fA-F]{6})"', fig._svg()))))`]);
  // (matplotlib's to_hex of the map at 0, 0.5 and 1: blue's jump at 0.5 taken)
  assert.equal(out, "['#000000', '#ff80fe', '#ffff80']\n");
});
