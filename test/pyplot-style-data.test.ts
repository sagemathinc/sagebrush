// matplotlib's styles in Sagebrush (style PR2): the 20 style files shipped
// (lib/matplotlib/style/_library.py, matplotlib 3.11.1's data), the 16 old
// seaborn names kept as aliases (project policy: a name upstream removed
// for no functional reason is still accepted, with a warning), and each
// style drawn: its colors, cycle and grid reach the SVG.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

const STYLES = ["bmh", "classic", "fivethirtyeight", "ggplot", "seaborn-v0_8", "seaborn-v0_8-bright", "seaborn-v0_8-colorblind",
  "seaborn-v0_8-dark", "seaborn-v0_8-dark-palette", "seaborn-v0_8-darkgrid", "seaborn-v0_8-deep", "seaborn-v0_8-muted",
  "seaborn-v0_8-notebook", "seaborn-v0_8-paper", "seaborn-v0_8-pastel", "seaborn-v0_8-poster", "seaborn-v0_8-talk",
  "seaborn-v0_8-ticks", "seaborn-v0_8-white", "seaborn-v0_8-whitegrid"];

test("available is the 20 styles shipped; the old seaborn names are aliases, not listed", () => {
  const out = run(`
import matplotlib.pyplot as plt
print(plt.style.available)
print(sorted(plt.style.library) == plt.style.available)
print(sorted(plt.style.ALIASES.items()))
print(any(a in plt.style.available or a in plt.style.library for a in plt.style.ALIASES))
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "[" + STYLES.map((s) => `'${s}'`).join(", ") + "]");
  assert.equal(lines[1], "True");
  // (the 16 names matplotlib 3.6 and 3.7 accepted: pinned)
  const old = ["seaborn", "seaborn-bright", "seaborn-colorblind", "seaborn-dark", "seaborn-dark-palette", "seaborn-darkgrid",
    "seaborn-deep", "seaborn-muted", "seaborn-notebook", "seaborn-paper", "seaborn-pastel", "seaborn-poster", "seaborn-talk",
    "seaborn-ticks", "seaborn-white", "seaborn-whitegrid"];
  assert.equal(lines[2], "[" + old.map((a) => `('${a}', '${a === "seaborn" ? "seaborn-v0_8" : a.replace("seaborn-", "seaborn-v0_8-")}')`).join(", ") + "]");
  assert.equal(lines[3], "False");
});

test("an old seaborn name applies its seaborn-v0_8 style with a MatplotlibDeprecationWarning naming it; other names are matplotlib's OSError", () => {
  const out = run(`
import warnings
import matplotlib as mpl
import matplotlib.pyplot as plt
for old, new in sorted(plt.style.ALIASES.items()):
    plt.style.use("default")
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        plt.style.use(old)
    a = dict(mpl.rcParams)
    dep = [x for x in w if issubclass(x.category, mpl.MatplotlibDeprecationWarning)]
    plt.style.use("default")
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        plt.style.use(new)
    print(old, a == dict(mpl.rcParams), len(dep), str(dep[0].message) if dep else None)
try:
    plt.style.use("seaborn-nosuch")
except OSError as e:
    print("OSError", e)
`);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 17);
  for (const line of lines.slice(0, 16)) {
    const [old] = line.split(" ");
    const target = old === "seaborn" ? "seaborn-v0_8" : old.replace("seaborn-", "seaborn-v0_8-");
    assert.equal(line, `${old} True 1 '${old}': use '${target}' (matplotlib renamed it in 3.6 and removed the old name in 3.8; Sagebrush still accepts it for older teaching material)`);
  }
  assert.equal(lines[16], "OSError 'seaborn-nosuch' is not a valid package style, path of style file, URL of style file, or library style name (library styles are listed in `style.available`)");
});

test("each style is drawn: its axes facecolor, edge color, cycle colors and grid reach the SVG; one warning names what is not drawn", () => {
  const out = run(`
import re, warnings
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.pyplot import to_color
D = mpl.rcParamsDefault
for name in plt.style.available:
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        with plt.style.context(name):
            fig, ax = plt.subplots()
            for i in range(3):
                ax.plot([0, 1, 2], [i, i + 1, i])
            ax.set_title("t")
            st = plt.style.library[name]
    svg = fig._repr_svg_()
    plt.close(fig)
    ok = []
    fc = st.get("axes.facecolor")
    if fc is not None and fc != D["axes.facecolor"]:
        ok.append(('fill="%s" stroke="none"' % to_color(fc)) in svg)
    ec = st.get("axes.edgecolor")
    if ec is not None and ec != D["axes.edgecolor"]:
        ok.append(('stroke="%s"' % to_color(ec)) in svg)
    cyc = st.get("axes.prop_cycle")
    if cyc is not None:
        cols = [to_color(c) for c in cyc.by_key()["color"]][:3]
        ok.append(all(('stroke="%s"' % c) in svg for c in cols))
    lw = st.get("lines.linewidth")
    if lw is not None:
        ok.append(('stroke-width="%s"' % ("%.2f" % (lw * 100 / 72)).rstrip("0").rstrip(".")) in svg)
    if st.get("axes.grid"):
        ok.append("stroke-opacity" in svg or "stroke-dasharray" in svg or 'stroke="' + to_color(st.get("grid.color", D["grid.color"])) + '"' in svg)
    undrawn = [x for x in w if "does not draw" in str(x.message)]
    print(name, len(ok), all(ok), len(undrawn) <= 1)
`);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 20);
  for (const line of lines) {
    const [name, checks, ok, oneWarning] = line.split(" ");
    assert.ok(Number(checks) >= 1, line);
    assert.equal(ok, "True", line);
    assert.equal(oneWarning, "True", line);
    assert.ok(STYLES.includes(name), line);
  }
});
