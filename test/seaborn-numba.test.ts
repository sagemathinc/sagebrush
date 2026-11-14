import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// seaborn's common plots over Sagebrush's matplotlib, and numba's decorators accepted with the code run as written.
// The statistics below (histogram bins and heights, the kernel density curves) are what seaborn 0.13.2 with NumPy
// 2.5 and SciPy 1.17 computes for the same data, to 6 decimals.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("numba: njit and jit, bare or with options or a signature, give back the function; prange is range", () => {
  const out = py(`
import numpy as np
from numba import njit, jit, prange, vectorize, float64, int64, types, typed
import numba

@njit(parallel=True)
def total(a):
    s = 0.0
    for i in prange(len(a)):
        s += a[i]
    return s

@njit
def inc(x):
    return x + 1

@jit(nopython=True, cache=True)
def twice(x):
    return 2 * x

@njit(float64(float64[:]))
def first(a):
    return a[0]

@njit("int64(int64)")
def sq(n):
    return n * n

@vectorize([float64(float64)])
def half(x):
    return x / 2

print(total(np.arange(5.0)), inc(1), twice(3), first(np.array([2.5, 1.0])), sq(7), half(3.0))
print(prange is range, inc.__name__, numba.get_num_threads(), types.int32, float64[:], int64(int64, int64))
d = typed.Dict.empty(key_type=types.unicode_type, value_type=float64)
d["a"] = 1.0
print(d, list(typed.List([1, 2])))
`);
  assert.equal(out, ["10.0 2 6 2.5 49 1.5", "True inc 1 int32 array(float64) int64(int64, int64)", "{'a': 1.0} [1, 2]", ""].join("\n"));
});

test("seaborn's statistics: numpy's auto bins, Scott's Gaussian kernel density, as seaborn computes them", () => {
  const out = py(`
import numpy as np
import seaborn as sns
for data in ([1, 2, 2, 3, 3, 3, 4, 4, 5, 9], [0.5, 1.25, 1.5, 2.0, 2.75, 3.5, 3.6, 4.1, 5.0, 6.25, 7.5, 8.0]):
    v = [float(x) for x in data]
    edges = sns._auto_edges(v)
    print([round(x, 6) for x in edges], np.histogram(np.array(v), bins=np.array(edges))[0].tolist())
    gx, gy = sns._kde_curve(v, cut=0)
    print(len(gy), round(gx[0], 6), round(gx[-1], 6), [round(gy[i], 6) for i in (0, 50, 100, 199)])
    gx, gy = sns._kde_curve(v)
    print(len(gy), round(gx[0], 6), round(gx[-1], 6), [round(gy[i], 6) for i in (0, 50, 100, 199)])
`);
  assert.equal(out, [
    "[1.0, 2.6, 4.2, 5.8, 7.4, 9.0] [3, 5, 1, 0, 1]",
    "200 1.0 9.0 [0.109693, 0.19424, 0.108919, 0.029059]",
    "200 -3.204279 13.204279 [0.000379, 0.104516, 0.107598, 0.000316]",
    "[0.5, 2.0, 3.5, 5.0, 6.5, 8.0] [3, 2, 3, 2, 2]",
    "200 0.5 8.0 [0.08731, 0.138643, 0.121981, 0.058832]",
    "200 -3.970794 12.470794 [0.000331, 0.073206, 0.121493, 0.000337]",
    "",
  ].join("\n"));
});

test("seaborn: the theme, and each plot drawn from a list, wide data and long data with hue", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-seaborn-"));
  try {
    const out = py(`
import numpy as np
import matplotlib as mpl
import matplotlib.pyplot as plt
import seaborn as sns
print(sns.color_palette()[0] == mpl.colors.to_rgb("C0"), mpl.rcParams["axes.grid"])
sns.set(style="whitegrid")
print([round(c, 6) for c in sns.color_palette()[0]], mpl.rcParams["axes.grid"], len(sns.color_palette("muted", 3)))
rng = np.random.default_rng(1)
a, b = rng.normal(10, 2, 50), rng.normal(12, 3, 30)
long = {"group": ["a"] * 6 + ["b"] * 6, "value": [1, 2, 2, 3, 4, 5, 3, 4, 4, 5, 6, 8]}
fig, axs = plt.subplots(3, 3, figsize=(9, 9))
r = [
    sns.histplot(a, kde=True, stat="density", color="skyblue", linewidth=0, ax=axs[0, 0]),
    sns.histplot(data=long, x="value", hue="group", ax=axs[0, 1]),
    sns.kdeplot(a, fill=True, ax=axs[0, 2]),
    sns.stripplot(data=[a, b], ax=axs[1, 0]),
    sns.swarmplot(data=list(a), orient="vertical", ax=axs[1, 1]),
    sns.boxplot(data={"a": a, "b": b}, ax=axs[1, 2]),
    sns.violinplot(data=long, x="group", y="value", ax=axs[2, 0]),
    sns.lineplot(x=[1, 1, 2, 2, 3, 3], y=[1, 2, 2, 4, 3, 5], seed=0, ax=axs[2, 1]),
    sns.lineplot(data=list(a[:10]), ax=axs[2, 2]),
]
print(all(x is ax for x, ax in zip(r, [axs[i, j] for i in range(3) for j in range(3)])))
print([t.get_text() for t in axs[1, 2].get_xticklabels()])
fig.savefig(${JSON.stringify(join(dir, "grid.svg"))})
g = sns.displot(b, kde=True, height=4, aspect=1.5)
g.set_axis_labels("value", "count")
g.figure.savefig(${JSON.stringify(join(dir, "dis.svg"))})
j = sns.jointplot(x=a[:30], y=b)
j.figure.savefig(${JSON.stringify(join(dir, "joint.svg"))})
print(type(g).__name__, type(j).__name__, plt.gca() is j.ax_joint)
for name in ("heatmap", "pairplot"):
    try:
        getattr(sns, name)()
    except NotImplementedError as e:
        print(e)
try:
    sns.histplot(a, stat="weird")
except ValueError as e:
    print(e)
`);
    assert.equal(out, [
      "True False",
      "[0.298039, 0.447059, 0.690196] True 3",
      "True",
      "['a', 'b']",
      "FacetGrid JointGrid True",
      "seaborn.heatmap is not in Sagebrush's seaborn yet",
      "seaborn.pairplot is not in Sagebrush's seaborn yet",
      "The \`stat\` parameter for \`Hist\` must be one of 'count', 'density', 'percent', 'probability' or 'frequency'; not 'weird'.",
      "",
    ].join("\n"));
    for (const f of ["grid.svg", "dis.svg", "joint.svg"]) {
      const svg = readFileSync(join(dir, f), "utf8");
      assert.match(svg, /^<\?xml|^<svg/);
      assert.ok(svg.length > 5000, `${f} draws something`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
