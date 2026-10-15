import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// matplotlib's invert_xaxis, invert_yaxis, xaxis_inverted and yaxis_inverted
// (test/mpl_invert_cases.py, against what CPython with matplotlib printed:
// test/mpl-oracle.json), and the AttributeError for a name of matplotlib's
// Axes, Figure or pyplot that Sagebrush lacks: it says so, and where to
// search (lib/matplotlib/_names.py, from test/mpl_names_gen.py).
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("axes invert as matplotlib's: set or autoscaled limits, data after, set_xlim/set_ylim after, imshow, bar (test/mpl_invert_cases.py)", () => {
  assert.equal(run([TEST + "mpl_invert_cases.py"]), oracle["mpl_invert_cases.py"]);
});

test("an inverted y axis is drawn so: its smallest tick at the top", () => {
  const svg = run(["-c", "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 10])\nax.invert_yaxis()\nprint(fig._svg())"]);
  const y = (label: string) => Number(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)" text-anchor="end"[^>]*>${label}</text>`).exec(svg)![1]);
  assert.ok(y("0") < y("10"), `0 at ${y("0")}, 10 at ${y("10")}`);
});

test("a name of matplotlib's that Sagebrush lacks: the AttributeError says so and where to search; another name: CPython's message", () => {
  const out = run([
    "-c",
    `import matplotlib.pyplot as plt
fig, ax = plt.subplots()
for o, n in ((ax, "set_facecolor"), (ax, "acorr"), (fig, "add_artist"), (plt, "xkcd"), (ax, "plott"), (fig, "plott"), (plt, "plott")):
    try:
        getattr(o, n)
        print(n, "is there")
    except AttributeError as e:
        print(e)
print(getattr(ax, "acorr", "default"), hasattr(ax, "acorr"), hasattr(plt, "xkcd"))`,
  ]).split("\n");
  const hint = (what: string, n: string) => `: matplotlib's ${what}.${n} is not in Sagebrush yet (to find what is: sagebrush --search ${n} --mode python, or the search box)`;
  const want = [
    ["'Axes' object has no attribute 'set_facecolor'", "Axes", "set_facecolor"],
    ["'Axes' object has no attribute 'acorr'", "Axes", "acorr"],
    ["'Figure' object has no attribute 'add_artist'", "Figure", "add_artist"],
    ["module 'matplotlib.pyplot' has no attribute 'xkcd'", "pyplot", "xkcd"],
  ];
  for (let i = 0; i < want.length; i++) {
    const [msg, what, n] = want[i];
    // (a name Sagebrush gains later is simply there)
    if (out[i] === n + " is there") continue;
    assert.equal(out[i], msg + hint(what, n));
  }
  assert.deepEqual(out.slice(4, 8), ["'Axes' object has no attribute 'plott'", "'Figure' object has no attribute 'plott'", "module 'matplotlib.pyplot' has no attribute 'plott'", "default False False"]);
});

test("the Python search lists matplotlib's pyplot, Axes and Figure, the new methods with their summaries", () => {
  const index = JSON.parse(run(["-m", "_python_docsearch", "--index"]));
  const byName = new Map(index.map((e: any) => [e.name, e]));
  for (const n of ["matplotlib.axes.Axes.invert_yaxis", "matplotlib.axes.Axes.invert_xaxis", "matplotlib.axes.Axes.yaxis_inverted", "matplotlib.axes.Axes.xaxis_inverted"]) {
    assert.ok(byName.has(n), n);
    assert.notEqual((byName.get(n) as any).summary, "", n);
  }
  for (const n of ["matplotlib.pyplot.subplots", "matplotlib.axes.Axes.plot", "matplotlib.figure.Figure.savefig"]) assert.ok(byName.has(n), n);
});
