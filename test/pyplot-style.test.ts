// pyplot's style settings (rcParams set by the program, rc, or a style):
// the colors, grid and line widths Sagebrush draws, and matplotlib.style's
// use / context / available.  Theme rule: a key at its default draws in the
// page's text color (currentColor: light and dark themes alike); a key set
// to another value draws in exactly that color, whatever the theme.
// Messages are matplotlib 3.11.1's.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

test("theme rule: defaults follow the page (currentColor), and rcdefaults/style 'default'/update(rcParamsDefault) give the same SVG back", () => {
  const out = run(`
import matplotlib as mpl
import matplotlib.pyplot as plt
import re
def svg():
    fig, ax = plt.subplots()
    ax.plot([1, 2, 3], [1, 4, 9])
    ax.set_title("t"); ax.set_xlabel("x")
    # (each figure's clip-paths have their own ids)
    s = re.sub(r"sbclip[0-9]+", "sbclip", fig._repr_svg_())
    plt.close(fig)
    return s
base = svg()
print("currentColor frame", 'stroke="currentColor" stroke-width="0.8"' in base, "no face", "<rect x=\\"0\\" y=\\"0\\"" not in base)
mpl.rcParams["axes.edgecolor"] = "red"
print("set differs", svg() != base)
mpl.rcdefaults(); print("rcdefaults", svg() == base)
mpl.rcParams["axes.edgecolor"] = "red"; plt.style.use("default"); print("style default", svg() == base)
mpl.rcParams["axes.edgecolor"] = "red"; mpl.rcParams.update(mpl.rcParamsDefault); print("update defaults", svg() == base)
mpl.rcParams["axes.edgecolor"] = "black"; print("set to default value", svg() == base)
`);
  assert.deepEqual(out.trim().split("\n"), [
    "currentColor frame True no face True",
    "set differs True",
    "rcdefaults True",
    "style default True",
    "update defaults True",
    "set to default value True",
  ]);
});

test("each drawn key: facecolor, edgecolor and linewidth, grid, tick, label, title and text colors, cycle, lines.linewidth, figsize", () => {
  const out = run(`
import matplotlib as mpl
import matplotlib.pyplot as plt
import re
def svg(**rc):
    with mpl.rc_context(rc):
        fig, ax = plt.subplots()
        ax.plot([1, 2, 3], [1, 4, 9]); ax.plot([1, 2], [2, 3])
        ax.set_title("T"); ax.set_xlabel("X"); ax.set_ylabel("Y"); ax.text(1.5, 5, "hello")
    s = fig._repr_svg_()
    plt.close(fig)
    return s
def has(label, s, *parts):
    print(label, all(p in s for p in parts))
has("facecolor", svg(**{"axes.facecolor": "#E5E5E5"}), 'fill="#E5E5E5" stroke="none"')
has("edgecolor", svg(**{"axes.edgecolor": "white", "axes.linewidth": 2}), 'fill="none" stroke="white" stroke-width="2"')
g = svg(**{"axes.grid": True, "grid.color": "#cccccc", "grid.linestyle": "--", "grid.linewidth": 0.5, "grid.alpha": 0.5})
has("grid", g, 'stroke="#cccccc" stroke-opacity="0.5" stroke-width="0.5" stroke-dasharray=')
has("grid on, theme", svg(**{"axes.grid": True}), 'stroke="currentColor" stroke-opacity="0.15" stroke-width="1"')
has("tick colors", svg(**{"xtick.color": "red", "ytick.color": "blue"}), 'stroke="red" stroke-width="0.8"', 'stroke="blue" stroke-width="0.8"', 'fill="red"', 'fill="blue"')
has("label color", svg(**{"axes.labelcolor": "green"}), 'fill="green">X<', 'fill="green">Y<')
has("title color", svg(**{"axes.titlecolor": "purple"}), 'fill="purple">T<')
has("text color", svg(**{"text.color": "orange"}), "orange")
c = svg(**{"axes.prop_cycle": mpl.cycler(color=["#123456", "#654321"])})
has("cycle", c, 'stroke="#123456"', 'stroke="#654321"')
with mpl.rc_context({"axes.prop_cycle": mpl.cycler(color=["#123456", "#654321"])}):
    print("C1", mpl.colors.to_hex("C1"), mpl.colors.to_hex("C2"))
print("C1 default", mpl.colors.to_hex("C1"))
w = [float(x) for x in re.findall(r'stroke-width="([0-9.]+)"', svg(**{"lines.linewidth": 4}))]
print("lines.linewidth", round(4 * 100 / 72, 2) in [round(x, 2) for x in w])
with mpl.rc_context({"figure.figsize": (3, 2)}):
    print("figsize", plt.figure()._size)
plt.close("all")
`);
  assert.deepEqual(out.trim().split("\n"), [
    "facecolor True", "edgecolor True", "grid True", "grid on, theme True", "tick colors True", "label color True",
    "title color True", "text color True", "cycle True", "C1 #654321 #123456", "C1 default #ff7f0e", "lines.linewidth True",
    "figsize (3.0, 2.0)",
  ]);
});

test("style.use and style.context: names, dicts, lists; warnings and errors as matplotlib's; a style stays with the plots made under it", () => {
  const out = run(`
import warnings
import matplotlib as mpl
import matplotlib.pyplot as plt
def t(label, f):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            r = f()
            print(label, repr(r), [str(x.message) for x in w])
        except Exception as e:
            print(label, type(e).__name__, str(e))
t("available", lambda: plt.style.available)
t("unknown", lambda: plt.style.use("nosuch"))
t("old seaborn name", lambda: plt.style.use("seaborn-whitegrid"))
t("blacklisted", lambda: (plt.style.use({"backend": "Agg", "font.size": 13}), mpl.rcParams["font.size"])[1])
t("undrawn", lambda: plt.style.use({"axes.spines.top": False, "legend.frameon": False, "axes.grid": True}))
t("bad key", lambda: plt.style.use({"nosuch.key": 1}))
t("None", lambda: plt.style.use(None))
t("list", lambda: (plt.style.use(["default", {"font.size": 7}]), mpl.rcParams["font.size"])[1])
plt.style.use("default")
before = dict(mpl.rcParams)
try:
    with plt.style.context({"axes.facecolor": "#E5E5E5", "font.size": 20}):
        fig, ax = plt.subplots(); ax.plot([1, 2])
        raise ValueError("x")
except ValueError:
    pass
print("restored", dict(mpl.rcParams) == before)
print("kept with its plot", 'fill="#E5E5E5"' in fig._repr_svg_())
t("bad values", lambda: [mpl.rcParams.__setitem__(k, v) for k, v in [("axes.facecolor", "nosuchcolor")]])
for k, v in [("lines.linewidth", "abc"), ("axes.grid", "maybe"), ("grid.linestyle", "wiggly"), ("axes.axisbelow", "x"),
             ("axes.prop_cycle", ["r"]), ("axes.prop_cycle", mpl.cycler(color=["C1"]))]:
    t("bad %s" % k, lambda: mpl.rcParams.__setitem__(k, v))
for k, v in [("axes.grid", "yes"), ("grid.linewidth", "1.5"), ("figure.figsize", "3,2"), ("axes.prop_cycle", "cycler('color', ['r', 'g'])")]:
    t("ok %s" % k, lambda: (mpl.rcParams.__setitem__(k, v), mpl.rcParams[k])[1])
`);
  const lines = out.trim().split("\n");
  assert.deepEqual(lines, [
    "available [] []",
    "unknown OSError 'nosuch' is not a valid package style, path of style file, URL of style file, or library style name (library styles are listed in `style.available`)",
    "old seaborn name OSError 'seaborn-whitegrid' is not a valid package style, path of style file, URL of style file, or library style name (library styles are listed in `style.available`)",
    "blacklisted 13.0 [\"Style includes a parameter, 'backend', that is not related to style.  Ignoring this parameter.\"]",
    "undrawn None [\"Sagebrush does not draw 2 of this style's settings yet (they are kept in rcParams): axes.spines.top, legend.frameon\"]",
    "bad key KeyError \"'nosuch.key' is not a valid value for rcParam.\"",
    "None TypeError 'NoneType' object is not iterable",
    "list 7.0 []",
    "restored True",
    "kept with its plot True",
    "bad values ValueError Key axes.facecolor: 'nosuchcolor' does not look like a color arg",
    "bad lines.linewidth ValueError Key lines.linewidth: Could not convert 'abc' to float",
    "bad axes.grid ValueError Key axes.grid: Cannot convert 'maybe' to bool",
    "bad grid.linestyle ValueError Key grid.linestyle: linestyle 'wiggly' is not a valid on-off ink sequence.",
    "bad axes.axisbelow ValueError Key axes.axisbelow: 'x' cannot be interpreted as True, False, or \"line\"",
    "bad axes.prop_cycle ValueError Key axes.prop_cycle: Object is not a string or Cycler instance: ['r']",
    "bad axes.prop_cycle ValueError Key axes.prop_cycle: Cannot put cycle reference ('C1') in prop_cycler",
    "ok axes.grid True []",
    "ok grid.linewidth 1.5 []",
    "ok figure.figsize [3.0, 2.0] []",
    "ok axes.prop_cycle cycler('color', ['r', 'g']) []",
  ]);
});

// The shared renderer's new options are pyplot's only: Sage mode's SVG is
// byte for byte what it was before them (the sha256 and size of this
// program's output on master fe52515e).
test("Sage mode's plots are unchanged by the style options (byte-identical SVG)", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", `
p1 = plot(sin(x), (x, 0, 6), frame=True, gridlines=True, axes_labels=['x', 'y'], title='t')
p2 = plot(cos(x), (x, -3, 3)) + point((1, 1), color='red') + text('hi', (0, 0.5))
print(p1._repr_svg_())
print(p2._repr_svg_())
`], { encoding: "utf8" });
  assert.equal(Buffer.byteLength(out), 9911);
  assert.equal(createHash("sha256").update(out).digest("hex").slice(0, 16), "66241ac9635ec66c");
});

test("importing pyplot does not import warnings or contextlib (they would join every scientific start's code); style's warnings and context still work", () => {
  const out = run(`
import sys
import matplotlib.pyplot as plt
print("imported", "warnings" in sys.modules, "contextlib" in sys.modules)
import warnings
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    plt.style.use({"backend": "agg"})
print("warned", [x.category.__name__ for x in w])
with plt.style.context({"lines.linewidth": 3}):
    print("in context", plt.rcParams["lines.linewidth"])
print("after", plt.rcParams["lines.linewidth"])
`);
  assert.deepEqual(out.trim().split("\n"), ["imported False False", "warned ['UserWarning']", "in context 3.0", "after 1.5"]);
});
