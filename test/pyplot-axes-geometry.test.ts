// matplotlib Axes geometry as matplotlib 3.11.1 gives it (each expected line
// is matplotlib's own output for the same program): set_aspect with
// adjustable 'box' (the limits kept, the Axes box shrunk) and 'datalim' (the
// limits moved when the figure is drawn), axis('equal' / 'scaled' /
// 'square'), get_position() as a Bbox (subplot parameters, grids, add_axes,
// set_position), set_xticks widening the view, tick labels (named, rotated,
// bar tick_label, the locator's), plt.xticks(); and the clip box of an Axes
// (friction W04, W41, W50, W51).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

test("aspect (box, datalim), axis modes, get_position, tick-widened views: matplotlib 3.11.1's values (W04, W41, W50)", () => {
  const out = run("import matplotlib\nmatplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\n\n\ndef r(v):\n    if isinstance(v, (tuple, list)):\n        return \"(\" + \", \".join(r(x) for x in v) + \")\"\n    if isinstance(v, float):\n        return \"%.6g\" % v\n    return str(v)\n\n\ndef show(label, f):\n    try:\n        print(label, \"=>\", r(f()))\n    except Exception as e:\n        print(label, \"!!\", type(e).__name__, str(e)[:100])\n\n\ndef pos(ax):\n    p = ax.get_position()\n    return (p.x0, p.y0, p.width, p.height)\n\n\n# W04: equal aspect with explicit limits\nfor adj in (\"box\", \"datalim\", None):\n    fig, ax = plt.subplots(figsize=(6, 3))\n    ax.scatter([0, 1], [0, 1])\n    ax.set_xlim(-2, 2)\n    ax.set_ylim(-2, 2)\n    if adj is None:\n        ax.set_aspect(\"equal\")\n    else:\n        ax.set_aspect(\"equal\", adjustable=adj)\n    fig.canvas.draw()\n    show(\"W04 %s xlim\" % adj, ax.get_xlim)\n    show(\"W04 %s ylim\" % adj, ax.get_ylim)\n    show(\"W04 %s aspect\" % adj, ax.get_aspect)\n    show(\"W04 %s adjustable\" % adj, ax.get_adjustable)\n    show(\"W04 %s position\" % adj, lambda: pos(ax))\n    plt.close(fig)\nfor arg in (\"equal\", \"scaled\", \"square\"):\n    fig, ax = plt.subplots(figsize=(6, 3))\n    ax.plot([0, 3], [0, 1])\n    ax.axis(arg)\n    fig.canvas.draw()\n    show(\"axis(%s) xlim\" % arg, ax.get_xlim)\n    show(\"axis(%s) ylim\" % arg, ax.get_ylim)\n    show(\"axis(%s) adjustable\" % arg, ax.get_adjustable)\n    plt.close(fig)\nfig, ax = plt.subplots(figsize=(6, 3))\nax.plot([0, 3], [0, 1])\nax.set_aspect(2)\nfig.canvas.draw()\nshow(\"aspect 2 xlim\", ax.get_xlim)\nshow(\"aspect 2 ylim\", ax.get_ylim)\nshow(\"aspect 2 get\", ax.get_aspect)\nplt.close(fig)\nfig, ax = plt.subplots()\nshow(\"default aspect\", ax.get_aspect)\nshow(\"default adjustable\", ax.get_adjustable)\nplt.close(fig)\n\n# W41: ticks set outside the data range expand it\nfig, ax = plt.subplots()\nax.bar(range(4), [4, 0, 0, 0])\nax.set_yticks([-1, 0, 1, 4])\nshow(\"W41 bar ylim\", ax.get_ylim)\nplt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xticks([-2, 0, 3])\nshow(\"W41 xticks xlim\", ax.get_xlim)\nshow(\"W41 xticks ylim\", ax.get_ylim)\nplt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xticks([0.25, 0.5])\nshow(\"W41 inner xticks xlim\", ax.get_xlim)\nplt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xlim(0, 1)\nax.set_xticks([-1, 2])\nshow(\"W41 fixed xlim then ticks\", ax.get_xlim)\nplt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 10], [0, 1])\nax.set_xticks([0, 5, 10], [\"a\", \"b\", \"c\"])\nshow(\"W41 named labels\", lambda: [t.get_text() for t in ax.get_xticklabels()])\nplt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 10], [0, 1])\nax.set_yticks([0, 0.5, 2])\nshow(\"W41 yticks above ylim\", ax.get_ylim)\nplt.close(fig)\n\n# W50: get_position\nfig, ax = plt.subplots()\np = ax.get_position()\nshow(\"W50 type\", lambda: type(p).__name__)\nshow(\"W50 bounds\", lambda: p.bounds)\nshow(\"W50 x0 y0 x1 y1\", lambda: (p.x0, p.y0, p.x1, p.y1))\nshow(\"W50 width height\", lambda: (p.width, p.height))\nplt.close(fig)\nfig, axs = plt.subplots(2, 2)\nshow(\"W50 grid [0,0]\", lambda: pos(axs[0, 0]))\nshow(\"W50 grid [1,1]\", lambda: pos(axs[1, 1]))\nplt.close(fig)\nfig = plt.figure()\na = fig.add_axes([0.2, 0.3, 0.5, 0.4])\nshow(\"W50 add_axes\", lambda: pos(a))\na.set_position([0.1, 0.1, 0.3, 0.3])\nshow(\"W50 set_position\", lambda: pos(a))\nplt.close(fig)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "W04 box xlim => (-2, 2)",
    "W04 box ylim => (-2, 2)",
    "W04 box aspect => 1",
    "W04 box adjustable => box",
    "W04 box position => (0.32, 0.11, 0.385, 0.77)",
    "W04 datalim xlim => (-2, 2)",
    "W04 datalim ylim => (-0.993548, 0.993548)",
    "W04 datalim aspect => 1",
    "W04 datalim adjustable => datalim",
    "W04 datalim position => (0.125, 0.11, 0.775, 0.77)",
    "W04 None xlim => (-2, 2)",
    "W04 None ylim => (-2, 2)",
    "W04 None aspect => 1",
    "W04 None adjustable => box",
    "W04 None position => (0.32, 0.11, 0.385, 0.77)",
    "axis(equal) xlim => (-0.15, 3.15)",
    "axis(equal) ylim => (-0.319677, 1.31968)",
    "axis(equal) adjustable => datalim",
    "axis(scaled) xlim => (-0.15, 3.15)",
    "axis(scaled) ylim => (-0.05, 1.05)",
    "axis(scaled) adjustable => box",
    "axis(square) xlim => (-0.15, 3.15)",
    "axis(square) ylim => (-0.05, 3.25)",
    "axis(square) adjustable => box",
    "aspect 2 xlim => (-0.15, 3.15)",
    "aspect 2 ylim => (-0.05, 1.05)",
    "aspect 2 get => 2",
    "default aspect => auto",
    "default adjustable => box",
    "W41 bar ylim => (-1, 4.2)",
    "W41 xticks xlim => (-2, 3)",
    "W41 xticks ylim => (-0.05, 1.05)",
    "W41 inner xticks xlim => (-0.05, 1.05)",
    "W41 fixed xlim then ticks => (-1, 2)",
    "W41 named labels => (a, b, c)",
    "W41 yticks above ylim => (-0.05, 2)",
    "W50 type => Bbox",
    "W50 bounds => (0.125, 0.11, 0.775, 0.77)",
    "W50 x0 y0 x1 y1 => (0.125, 0.11, 0.9, 0.88)",
    "W50 width height => (0.775, 0.77)",
    "W50 grid [0,0] => (0.125, 0.53, 0.352273, 0.35)",
    "W50 grid [1,1] => (0.547727, 0.11, 0.352273, 0.35)",
    "W50 add_axes => (0.2, 0.3, 0.5, 0.4)",
    "W50 set_position => (0.1, 0.1, 0.3, 0.3)"
  ]);
});

test("set_xticks widens the view now and new data autoscales again, as matplotlib 3.11.1 (W41)", () => {
  const out = run("import matplotlib\nmatplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\n\n\ndef r(v):\n    if isinstance(v, (tuple, list)):\n        return \"(\" + \", \".join(r(x) for x in v) + \")\"\n    if isinstance(v, float):\n        return \"%.6g\" % v\n    return str(v)\n\n\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xticks([-2, 3])\nax.plot([5], [5])\nprint(\"a ticks then more data:\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xticks([-2, 3])\nax.set_xlim(0, 1)\nprint(\"b ticks then set_xlim:\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.set_xticks([-2, 3])\nax.plot([0, 1], [0, 1])\nprint(\"c ticks before data:\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xticks([0.2, 0.4])\nax.set_xticks([-1, 0.5])\nprint(\"d ticks twice:\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xticks([-2, 3])\nax.autoscale()\nprint(\"e ticks then autoscale():\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xlim(0, 1)\nax.set_xticks([0.5, 2])\nprint(\"f set_xlim then a tick above:\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xlim(1, 0)\nax.set_xticks([-1, 0.5])\nprint(\"g inverted then ticks:\", r(ax.get_xlim()))\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_aspect(\"equal\")\nprint(\"i get_aspect equal:\", r(ax.get_aspect()), type(ax.get_aspect()).__name__)\nax.set_aspect(\"auto\")\nprint(\"j get_aspect auto:\", r(ax.get_aspect()))\nax.set_adjustable(\"datalim\")\nprint(\"k set_adjustable:\", ax.get_adjustable())\nax.set_aspect(2)\nprint(\"l get_aspect 2:\", r(ax.get_aspect()), type(ax.get_aspect()).__name__)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "a ticks then more data: (-0.25, 5.25)",
    "b ticks then set_xlim: (0, 1)",
    "c ticks before data: (-0.05, 1.05)",
    "d ticks twice: (-1, 1.05)",
    "e ticks then autoscale(): (-0.05, 1.05)",
    "f set_xlim then a tick above: (0, 2)",
    "g inverted then ticks: (1, -1)",
    "i get_aspect equal: 1 float",
    "j get_aspect auto: auto",
    "k set_adjustable: datalim",
    "l get_aspect 2: 2 float"
  ]);
});

test("tick labels: named, bar tick_label and categories, rotation, the locator's, plt.xticks() (W41)", () => {
  const out = run("import io, re\nimport matplotlib\nmatplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\n\n\ndef svg(fig):\n    b = io.StringIO()\n    fig.savefig(b, format=\"svg\")\n    plt.close(fig)\n    return b.getvalue()\n\n\ndef has_text(s, t):\n    # (matplotlib draws text as glyph paths with the string in a comment or\n    # an id; Sagebrush as <text>: either way the string is in the file)\n    return t in s\n\n\nfig, ax = plt.subplots()\nax.plot([0, 10], [0, 1])\nax.set_xticks([0, 5, 10], [\"alpha\", \"beta\", \"gamma\"])\nprint(\"named labels:\", [t.get_text() for t in ax.get_xticklabels()])\ns = svg(fig)\nprint(\"named labels drawn:\", all(has_text(s, w) for w in (\"alpha\", \"beta\", \"gamma\")))\n\nfig, ax = plt.subplots()\nax.bar([0, 1, 2], [3, 1, 2], tick_label=[\"one\", \"two\", \"three\"])\nprint(\"bar tick_label:\", [t.get_text() for t in ax.get_xticklabels()])\ns = svg(fig)\nprint(\"bar tick_label drawn:\", all(has_text(s, w) for w in (\"one\", \"two\", \"three\")))\n\nfig, ax = plt.subplots()\nax.bar([\"one\", \"two\", \"three\"], [3, 1, 2])\nprint(\"bar categories:\", [t.get_text() for t in ax.get_xticklabels()])\n\nfig, ax = plt.subplots()\nax.plot([0, 10], [0, 1])\nax.set_xticks([0, 5, 10])\nax.set_xticklabels([\"p\", \"q\", \"r\"], rotation=45)\nprint(\"rotation:\", [t.get_rotation() for t in ax.get_xticklabels()])\n\nfig, ax = plt.subplots()\nax.plot([0, 10], [0, 1])\nax.tick_params(axis=\"x\", labelrotation=30)\nprint(\"tick_params rotation:\", sorted({t.get_rotation() for t in ax.get_xticklabels()}))\n\nfig, ax = plt.subplots()\nax.plot([0, 10], [0, 1])\nprint(\"default labels:\", [t.get_text() for t in ax.get_xticklabels()])\nprint(\"default ylabels:\", [t.get_text() for t in ax.get_yticklabels()])\nprint(\"repr:\", ax.get_xticklabels()[1])\n\nplt.figure()\nplt.plot([0, 10], [0, 1])\nplt.xticks([0, 5, 10], [\"a\", \"b\", \"c\"], rotation=90)\nprint(\"plt.xticks:\", [(t.get_text(), t.get_rotation()) for t in plt.gca().get_xticklabels()])\nlocs, labels = plt.xticks()\nprint(\"plt.xticks() locs:\", list(locs))\n");
  assert.deepEqual(out.trim().split("\n"), [
    "named labels: ['alpha', 'beta', 'gamma']",
    "named labels drawn: True",
    "bar tick_label: ['one', 'two', 'three']",
    "bar tick_label drawn: True",
    "bar categories: ['one', 'two', 'three']",
    "rotation: [45.0, 45.0, 45.0]",
    "tick_params rotation: [30.0]",
    "default labels: ['−2', '0', '2', '4', '6', '8', '10', '12']",
    "default ylabels: ['−0.2', '0.0', '0.2', '0.4', '0.6', '0.8', '1.0', '1.2']",
    "repr: Text(0.0, 0, '0')",
    "plt.xticks: [('a', 90.0), ('b', 90.0), ('c', 90.0)]",
    "plt.xticks() locs: [np.int64(0), np.int64(5), np.int64(10)]"
  ]);
});

test("an Axes clips to its own box, as matplotlib (a line just past ylim leaves the margins alone, W51)", () => {
  const out = run(`
import re
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(4, 3)); ax.set_xlim(0, 1); ax.set_ylim(0, 1)
ax.plot([0, 1], [1.01, 1.01], color="#fe0000", linewidth=3)
s = fig._repr_svg_()
box = re.search(r'data-box="([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+)"', s).groups()
clip = re.search(r'<clipPath id="[^"]*"><rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"', s).groups()
print(box == clip)
`);
  assert.equal(out.trim(), "True");
});

const runIn = (program: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-axes-"));
  try {
    return execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// (the grader's survivors of #797's first pin: each line matplotlib 3.11.1's
// own output for the same program; the boxes as drawn, read from the SVG
// here and from the Axes' window extent there)
test("subplot spacing, given rects, datalim before and after drawing, log aspects, which limits datalim moves, inverted views, rotations, log tick labels, refusals, autoscale off, Bbox: matplotlib 3.11.1's", () => {
  const out = runIn("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nfrom matplotlib.transforms import Bbox\nimport re\n\n\ndef r(v):\n    if isinstance(v, (tuple, list)):\n        return \"(\" + \", \".join(r(x) for x in v) + \")\"\n    if isinstance(v, float):\n        return \"%.6g\" % v\n    return str(v)\n\n\ndef show(label, f):\n    try:\n        print(label, \"=>\", r(f()))\n    except Exception as e:\n        print(label, \"!!\", type(e).__name__, str(e)[:120])\n\n\ndef pos(ax):\n    p = ax.get_position()\n    return (p.x0, p.y0, p.width, p.height)\n\n\ndef drawn(fig, ax):\n    \"\"\"the Axes' box as drawn, in figure fractions (x0, y0, w, h), and its drawn x and y limits\"\"\"\n    if REAL:\n        fig.canvas.draw()\n        b = ax.get_window_extent()\n        W, H = fig.get_size_inches() * fig.dpi\n        return (round(b.x0 / W, 4), round(b.y0 / H, 4), round(b.width / W, 4), round(b.height / H, 4)), tuple(ax.get_xlim()), tuple(ax.get_ylim())\n    fig.savefig('t_surv.svg')\n    svg = open('t_surv.svg').read()\n    W, H = (float(v) for v in re.search(r'viewBox=\"0 0 ([0-9.]+) ([0-9.]+)\"', svg).groups())\n    m = re.search(r'data-xr=\"([^ ]+) ([^\"]+)\" data-yr=\"([^ ]+) ([^\"]+)\" data-box=\"([^ ]+) ([^ ]+) ([^ ]+) ([^\"]+)\"', svg)\n    x0, x1, y0, y1, bl, bt, bw, bh = (float(v) for v in m.groups())\n    return (round(bl / W, 4), round(1 - (bt + bh) / H, 4), round(bw / W, 4), round(bh / H, 4)), (x0, x1), (y0, y1)\n\n\ndef rot_svg(fig):\n    \"\"\"the rotation of the x tick labels as written in the saved SVG\"\"\"\n    if REAL:\n        matplotlib.rcParams['svg.fonttype'] = 'none'\n    fig.savefig('t_surv.svg')\n    svg = open('t_surv.svg').read()\n    return sorted(set(re.findall(r'rotate\\((-?[0-9.]+)', svg)))\n\n\n# A1: subplot spacing from rcParams\nplt.rcParams['figure.subplot.hspace'] = 0.5\nplt.rcParams['figure.subplot.wspace'] = 0.1\nfig, axs = plt.subplots(2, 2)\nshow(\"A1 grid [0,0]\", lambda: pos(axs[0, 0]))\nshow(\"A1 grid [1,1]\", lambda: pos(axs[1, 1]))\nplt.close(fig)\nplt.rcdefaults()\n\n# A3, A4, A28: given rects\nfig = plt.figure()\nax = fig.add_axes([0.2, 0.1, 0.5, 0.3])\nshow(\"A4 add_axes bounds\", lambda: repr(tuple(float(v) for v in ax.get_position().bounds)))\nax.set_position([0.1, 0.1, 0.8, 0.7])\nshow(\"A3 set_position bounds\", lambda: repr(tuple(float(v) for v in ax.get_position().bounds)))\nshow(\"A28 set_position drawn box\", lambda: drawn(fig, ax)[0])\nplt.close(fig)\n\n# A6, P2: datalim leaves the box\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.plot([0, 3], [0, 1])\nax.set_aspect('equal', adjustable='datalim')\nshow(\"A6 datalim position before drawing\", lambda: pos(ax))\nshow(\"P2 datalim drawn box\", lambda: drawn(fig, ax)[0])\nshow(\"A6 datalim position after drawing\", lambda: pos(ax))\nplt.close(fig)\n\n# A7, G3: box aspect on a log axis\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.plot([1, 100], [1, 2])\nax.set_xscale('log')\nax.set_aspect('equal')\nshow(\"A7 log equal position\", lambda: (fig.canvas.draw(), pos(ax))[1] if REAL else pos(ax))\nshow(\"G3 log equal drawn box\", lambda: drawn(fig, ax)[0])\nplt.close(fig)\n\n# A8: a numeric box aspect on non-square limits; A9: a non-square figure\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.set_xlim(0, 4); ax.set_ylim(0, 1)\nax.set_aspect(2)\nshow(\"A8 aspect 2 position\", lambda: pos(ax))\nshow(\"A8 aspect 2 drawn box\", lambda: drawn(fig, ax)[0])\nplt.close(fig)\nfig = plt.figure(figsize=(8, 4))\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.set_xlim(0, 1); ax.set_ylim(0, 1)\nax.set_aspect('equal')\nshow(\"A9 wide figure position\", lambda: pos(ax))\nshow(\"A9 wide figure drawn box\", lambda: drawn(fig, ax)[0])\nplt.close(fig)\n\n# A12, A14, A15: which limits datalim moves\nfor label, xs, ys, size in [(\"A12 wide data\", [0, 10], [0, 1], None), (\"A12 tall data\", [0, 1], [0, 10], None),\n                            (\"A14 square data, tall figure\", [0, 1], [0, 1], (3, 6)), (\"A14 tall data, wide figure\", [0, 1], [0, 3], (8, 3))]:\n    fig, ax = plt.subplots(figsize=size) if size else plt.subplots()\n    ax.plot(xs, ys)\n    ax.set_aspect('equal', adjustable='datalim')\n    show(label + \" drawn limits\", lambda: drawn(fig, ax)[1:])\n    show(label + \" get limits\", lambda: (ax.get_xlim(), ax.get_ylim()))\n    plt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 3], [0, 1])\nax.invert_yaxis()\nax.set_aspect('equal', adjustable='datalim')\nshow(\"A15 inverted datalim drawn\", lambda: drawn(fig, ax)[1:])\nshow(\"A15 inverted ylim\", ax.get_ylim)\nshow(\"A15 yaxis_inverted\", ax.yaxis_inverted)\nplt.close(fig)\n\n# A19, P5: widened views of inverted axes\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xlim(1, 0)\nax.set_xticks([-1, 2])\nshow(\"A19 xlim\", ax.get_xlim)\nshow(\"A19 xaxis_inverted\", ax.xaxis_inverted)\nshow(\"P5 drawn xlim\", lambda: drawn(fig, ax)[1])\nplt.close(fig)\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.invert_xaxis()\nax.set_xticks([-1, 0.5])\nshow(\"P5 autoscaled inverted xlim\", ax.get_xlim)\nshow(\"P5 autoscaled inverted drawn xlim\", lambda: drawn(fig, ax)[1])\nplt.close(fig)\n\n# A20, P3, P4, G4: rotations\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.tick_params(axis='y', labelrotation=45)\nshow(\"A20 y label rotation\", lambda: ax.get_yticklabels()[0].get_rotation())\nshow(\"A20 x label rotation\", lambda: ax.get_xticklabels()[0].get_rotation())\nplt.close(fig)\nfor rot in ['vertical', 'horizontal', 450, -45, 45]:\n    fig, ax = plt.subplots()\n    ax.plot([0, 1], [0, 1])\n    plt.xticks(rotation=rot)\n    show(\"P3/P4 xticks(rotation=%r)\" % (rot,), lambda: ax.get_xticklabels()[0].get_rotation())\n    if rot == 45:\n        show(\"G4 the SVG turns the labels by -45 (counterclockwise), never +45\", lambda: ('-45' in rot_svg(fig), '45' in rot_svg(fig)))\n    plt.close(fig)\n\n# A21: a log axis' labels\nfor lo, hi, a in [(1, 1000, 'y'), (1e-10, 1e10, 'y'), (1, 5, 'y'), (1, 1e30, 'x'), (2, 3, 'x'), (1, 1e5, 'x')]:\n    fig, ax = plt.subplots()\n    ax.plot([0, 1], [lo, hi]) if a == 'y' else ax.plot([lo, hi], [0, 1])\n    (ax.set_yscale if a == 'y' else ax.set_xscale)('log')\n    fig.canvas.draw()\n    labs = ax.get_yticklabels() if a == 'y' else ax.get_xticklabels()\n    show(\"A21 log %s labels %g..%g\" % (a, lo, hi), lambda: [t.get_text() for t in labs])\n    plt.close(fig)\n\n# A23, A24: refused values\nfig, ax = plt.subplots()\nshow(\"A23 set_aspect(inf)\", lambda: ax.set_aspect(float('inf')))\nshow(\"A23 set_aspect(0)\", lambda: ax.set_aspect(0))\nshow(\"A23 set_aspect(-1)\", lambda: ax.set_aspect(-1))\nshow(\"A23 set_aspect('bogus')\", lambda: ax.set_aspect('bogus'))\nshow(\"A24 set_adjustable('bogus')\", lambda: ax.set_adjustable('bogus'))\nplt.close(fig)\n\n# A25: autoscale off\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.get_xlim(), ax.get_ylim()  # (the limits worked out, as matplotlib works them out lazily)\nax.autoscale(False)\nax.plot([0, 5], [0, 5])\nshow(\"A25 limits after new data\", lambda: (ax.get_xlim(), ax.get_ylim()))\nax.autoscale(True)\nshow(\"A25 limits after autoscale(True)\", lambda: (ax.get_xlim(), ax.get_ylim()))\nplt.close(fig)\n\n# P6: datalim on a log axis\nfig, ax = plt.subplots()\nax.plot([1, 100], [1, 2])\nax.set_xscale('log')\nax.set_aspect('equal', adjustable='datalim')\nshow(\"P6 log datalim drawn limits\", lambda: drawn(fig, ax)[1:])\nplt.close(fig)\n\n# T2, T3, T4: Bbox\nfig, ax = plt.subplots()\nshow(\"T2 bounds types\", lambda: [type(v).__name__ for v in ax.get_position().bounds])\nplt.close(fig)\na, b = Bbox.from_bounds(0, 0, 1, 1), Bbox.from_bounds(0, 0, 1, 2)\nshow(\"T3 equal boxes ==\", lambda: a == Bbox.from_bounds(0, 0, 1, 1))\nshow(\"T3 different boxes ==\", lambda: a == b)\nshow(\"T3 different boxes !=\", lambda: a != b)\nc = Bbox.from_extents(1, 0, 0, 1)\nshow(\"T4 x0 > x1: x0 x1 xmin xmax width\", lambda: (c.x0, c.x1, c.xmin, c.xmax, c.width))\n");
  assert.deepEqual(out.trim().split("\n"), [
    "A1 grid [0,0] => (0.125, 0.572, 0.369048, 0.308)",
    "A1 grid [1,1] => (0.530952, 0.11, 0.369048, 0.308)",
    "A4 add_axes bounds => (0.2, 0.1, 0.49999999999999994, 0.30000000000000004)",
    "A3 set_position bounds => (0.1, 0.1, 0.8, 0.7)",
    "A28 set_position drawn box => (0.1, 0.1, 0.8, 0.7)",
    "A6 datalim position before drawing => (0.125, 0.11, 0.775, 0.77)",
    "P2 datalim drawn box => (0.125, 0.11, 0.775, 0.77)",
    "A6 datalim position after drawing => (0.125, 0.11, 0.775, 0.77)",
    "A7 log equal position => (0.125, 0.236667, 0.775, 0.516667)",
    "G3 log equal drawn box => (0.125, 0.2367, 0.775, 0.5167)",
    "A8 aspect 2 position => (0.125, 0.236667, 0.775, 0.516667)",
    "A8 aspect 2 drawn box => (0.125, 0.2367, 0.775, 0.5167)",
    "A9 wide figure position => (0.32, 0.11, 0.385, 0.77)",
    "A9 wide figure drawn box => (0.32, 0.11, 0.385, 0.77)",
    "A12 wide data drawn limits => ((-0.5, 10.5), (-3.59839, 4.59839))",
    "A12 wide data get limits => ((-0.5, 10.5), (-3.59839, 4.59839))",
    "A12 tall data drawn limits => ((-6.88095, 7.88095), (-0.5, 10.5))",
    "A12 tall data get limits => ((-6.88095, 7.88095), (-0.5, 10.5))",
    "A14 square data, tall figure drawn limits => ((-0.05, 1.05), (-0.592903, 1.5929))",
    "A14 square data, tall figure get limits => ((-0.05, 1.05), (-0.592903, 1.5929))",
    "A14 tall data, wide figure drawn limits => ((-3.92857, 4.92857), (-0.15, 3.15))",
    "A14 tall data, wide figure get limits => ((-3.92857, 4.92857), (-0.15, 3.15))",
    "A15 inverted datalim drawn => ((-0.15, 3.15), (1.72952, -0.729516))",
    "A15 inverted ylim => (1.72952, -0.729516)",
    "A15 yaxis_inverted => True",
    "A19 xlim => (2, -1)",
    "A19 xaxis_inverted => True",
    "P5 drawn xlim => (2, -1)",
    "P5 autoscaled inverted xlim => (1.05, -1)",
    "P5 autoscaled inverted drawn xlim => (1.05, -1)",
    "A20 y label rotation => 45",
    "A20 x label rotation => 0",
    "P3/P4 xticks(rotation='vertical') => 90",
    "P3/P4 xticks(rotation='horizontal') => 0",
    "P3/P4 xticks(rotation=450) => 90",
    "P3/P4 xticks(rotation=-45) => 315",
    "P3/P4 xticks(rotation=45) => 45",
    "G4 the SVG turns the labels by -45 (counterclockwise), never +45 => (True, False)",
    "A21 log y labels 1..1000 => ($\\mathdefault{10^{-1}}$, $\\mathdefault{10^{0}}$, $\\mathdefault{10^{1}}$, $\\mathdefault{10^{2}}$, $\\mathdefault{10^{3}}$, $\\mathdefault{10^{4}}$)",
    "A21 log y labels 1e-10..1e+10 => ($\\mathdefault{10^{-14}}$, $\\mathdefault{10^{-11}}$, $\\mathdefault{10^{-8}}$, $\\mathdefault{10^{-5}}$, $\\mathdefault{10^{-2}}$, $\\mathdefault{10^{1}}$, $\\mathdefault{10^{4}}$, $\\mathdefault{10^{7}}$, $\\mathdefault{10^{10}}$, $\\mathdefault{10^{13}}$)",
    "A21 log y labels 1..5 => ($\\mathdefault{10^{-1}}$, $\\mathdefault{10^{0}}$, $\\mathdefault{10^{1}}$)",
    "A21 log x labels 1..1e+30 => ($\\mathdefault{10^{-5}}$, $\\mathdefault{10^{-1}}$, $\\mathdefault{10^{3}}$, $\\mathdefault{10^{7}}$, $\\mathdefault{10^{11}}$, $\\mathdefault{10^{15}}$, $\\mathdefault{10^{19}}$, $\\mathdefault{10^{23}}$, $\\mathdefault{10^{27}}$, $\\mathdefault{10^{31}}$, $\\mathdefault{10^{35}}$)",
    "A21 log x labels 2..3 => ($\\mathdefault{10^{0}}$, $\\mathdefault{10^{1}}$)",
    "A21 log x labels 1..100000 => ($\\mathdefault{10^{-1}}$, $\\mathdefault{10^{0}}$, $\\mathdefault{10^{1}}$, $\\mathdefault{10^{2}}$, $\\mathdefault{10^{3}}$, $\\mathdefault{10^{4}}$, $\\mathdefault{10^{5}}$, $\\mathdefault{10^{6}}$)",
    "A23 set_aspect(inf) !! ValueError aspect must be finite and positive ",
    "A23 set_aspect(0) !! ValueError aspect must be finite and positive ",
    "A23 set_aspect(-1) !! ValueError aspect must be finite and positive ",
    "A23 set_aspect('bogus') !! ValueError could not convert string to float: 'bogus'",
    "A24 set_adjustable('bogus') !! ValueError 'bogus' is not a valid value for adjustable. Supported values are 'box', 'datalim'",
    "A25 limits after new data => ((-0.05, 1.05), (-0.05, 1.05))",
    "A25 limits after autoscale(True) => ((-0.25, 5.25), (-0.25, 5.25))",
    "P6 log datalim drawn limits => ((0.794328, 125.893), (0.680323, 2.31968))",
    "T2 bounds types => (float64, float64, float64, float64)",
    "T3 equal boxes == => False",
    "T3 different boxes == => False",
    "T3 different boxes != => True",
    "T4 x0 > x1: x0 x1 xmin xmax width => (1, 0, 0, 1, -1)",
  ]);
});

// (matplotlib's rotated labels: centred on their ticks, their tops in line;
// its centres (102.55, 452.68), (328, 451.54), (553.45, 451.38) in SVG
// pixels, the y within 2 px here, which places by estimated text widths)
test("rotated x tick labels: centred on their ticks, at matplotlib 3.11.1's heights within 2 px", () => {
  const out = runIn("import matplotlib.pyplot as plt\nimport re\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.plot([0, 1], [0, 1])\nax.set_xticks([0, 0.5, 1], ['zero', 'half', 'one'])\nplt.xticks(rotation=45)\nfig.savefig('g5.svg')\nfor m in re.finditer(r'<text x=\"([-0-9.]+)\" y=\"([-0-9.]+)\"[^>]*rotate\\(-45[^>]*>([^<]*)</text>', open('g5.svg').read()):\n    print(m.group(3), m.group(1), m.group(2))\n").trim().split("\n").map((l) => l.split(" "));
  const want: [string, number, number][] = [["zero", 102.55, 452.68], ["half", 328, 451.54], ["one", 553.45, 451.38]];
  assert.equal(out.length, 3);
  for (const [i, [s, x, y]] of want.entries()) {
    assert.equal(out[i][0], s);
    assert.equal(Number(out[i][1]), x);
    assert.ok(Math.abs(Number(out[i][2]) - y) <= 2, `${s}: y ${out[i][2]} vs ${y}`);
  }
});

// (#797's second tests round, each line matplotlib 3.11.1's own for the same
// program: datalim's margins rule, a given inversion kept, a log axis moved
// in decades (and past the largest float, matplotlib's ValueError), a log
// axis' data at or below 0 clipped as its transform clips it; LogLocator's
// middle tick and how many decades fit the axes; a datalim axes drawn in its
// plain box; colorbars' axes and their parents, make_axes' geometry; x
// moved where the margins rule doesn't apply; an inversion through
// set_xticks and autoscale(False))
test("datalim, log ticks, colorbar positions and inversions: matplotlib 3.11.1's (#797 r3)", () => {
  const out = runIn("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nimport re\nimport warnings\nwarnings.simplefilter('ignore')\n\n\ndef r(v):\n    if isinstance(v, (tuple, list)):\n        return \"(\" + \", \".join(r(x) for x in v) + \")\"\n    if isinstance(v, float):\n        return \"%.6g\" % v\n    return str(v)\n\n\ndef show(label, f):\n    try:\n        print(label, \"=>\", r(f()))\n    except Exception as e:\n        print(label, \"!!\", type(e).__name__, str(e)[:100])\n\n\ndef lims(fig, ax):\n    fig.canvas.draw()\n    return tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim())\n\n\ndef drawn(fig, ax):\n    \"\"\"the Axes' box as drawn (figure fractions) and its x limits, left to right\"\"\"\n    if REAL:\n        fig.canvas.draw()\n        b = ax.get_window_extent()\n        W, H = fig.get_size_inches() * fig.dpi\n        return (round(b.x0 / W, 4), round(b.y0 / H, 4), round(b.width / W, 4), round(b.height / H, 4)), tuple(float(v) for v in ax.get_xlim())\n    fig.savefig('pins797.svg')\n    svg = open('pins797.svg').read()\n    W, H = (float(v) for v in re.search(r'viewBox=\"0 0 ([0-9.]+) ([0-9.]+)\"', svg).groups())\n    m = re.search(r'data-xr=\"([^ ]+) ([^\"]+)\" data-yr=\"[^\"]+\" data-box=\"([^ ]+) ([^ ]+) ([^ ]+) ([^\"]+)\"', svg)\n    x0, x1, bl, bt, bw, bh = (float(v) for v in m.groups())\n    return (round(bl / W, 4), round(1 - (bt + bh) / H, 4), round(bw / W, 4), round(bh / H, 4)), (x0, x1)\n\n\ndef bounds(ax):\n    return tuple(float(v) for v in ax.get_position().bounds)\n\n\n# A12b: the 5% margins decide which pair datalim moves\nfig, ax = plt.subplots()\nax.plot([0, 1.45], [0, 1])\nax.set_aspect('equal', adjustable='datalim')\nshow(\"A12b datalim, data 1.45 x 1\", lambda: lims(fig, ax))\nplt.close(fig)\n\n# A15b: the moved pair keeps its given inversion\nfor xs, ys, inv in (([0, 3], [0, 1], 'y'), ([0, 1], [0, 3], 'x')):\n    fig, ax = plt.subplots()\n    ax.plot(xs, ys)\n    if inv == 'y':\n        ax.set_ylim(max(ys) + 0.1, min(ys) - 0.1)\n    else:\n        ax.set_xlim(max(xs) + 0.1, min(xs) - 0.1)\n    ax.set_aspect('equal', adjustable='datalim')\n    show(\"A15b datalim, %slim given inverted, data %s\" % (inv, r(tuple(xs + ys))), lambda: lims(fig, ax))\n    plt.close(fig)\n\n# L2: datalim moving a log axis' limits (in decades), and past the largest float\nfor xs, ys in (([1, 3], [0, 1]), ([1, 10], [0, 3]), ([1, 2], [1, 1000])):\n    fig, ax = plt.subplots()\n    ax.plot(xs, ys)\n    ax.set_xscale('log')\n    ax.set_aspect('equal', adjustable='datalim')\n    show(\"L2 datalim, log x, data %s\" % r(tuple(xs + ys)), lambda: lims(fig, ax))\n    plt.close(fig)\n\n# L3: a log axis' data at or below 0, its limits given (clipped to -1000 decades)\nfor xs, ys, xl, yl in (([0, 10], [1, 2], (1, 100), (0, 3)), ([-5, 10], [0, 4], (1, 1000), (0, 4))):\n    fig, ax = plt.subplots()\n    ax.plot(xs, ys)\n    ax.set_xscale('log')\n    ax.set_xlim(*xl)\n    ax.set_ylim(*yl)\n    ax.set_aspect('equal', adjustable='datalim')\n    show(\"L3 datalim, log x, data %s, limits %s %s\" % (r(tuple(xs + ys)), r(xl), r(yl)), lambda: lims(fig, ax))\n    plt.close(fig)\n\n# L5: LogLocator's one tick near the middle, of a view with one decade inside\nfig, ax = plt.subplots()\nax.set_xscale('log')\nax.set_xlim(10 ** 2.2, 10 ** 3.4)\nfig.canvas.draw()\nshow(\"L5 log x 10^2.2..10^3.4: tick locations\", lambda: [float(t.get_position()[0]) for t in ax.get_xticklabels()])\nplt.close(fig)\n\n# L9, L10, L11: how many log decades are labelled, by the axes' size\nfor size in ((2, 1.5), (8, 2), (2, 8), (1, 1), (0.6, 0.6)):\n    fig, ax = plt.subplots(figsize=size)\n    ax.set_xscale('log'); ax.set_yscale('log')\n    ax.set_xlim(1, 1e20); ax.set_ylim(1, 1e20)\n    fig.canvas.draw()\n    show(\"L9-L11 figsize %s: x ticks\" % r(size), lambda: [float(t.get_position()[0]) for t in ax.get_xticklabels()])\n    show(\"L9-L11 figsize %s: y ticks\" % r(size), lambda: [float(t.get_position()[1]) for t in ax.get_yticklabels()])\n    plt.close(fig)\n\n# P2: a datalim axes is drawn in the box it has without the aspect\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 3])\nplain = drawn(fig, ax)[0]\nax.set_aspect('equal', adjustable='datalim')\nshow(\"P2 datalim drawn in the plain box\", lambda: drawn(fig, ax)[0] == plain)\nplt.close(fig)\n\n# A4: colorbar axes and their parents (matplotlib's make_axes geometry)\nfor kw in (dict(), dict(location='left'), dict(location='top'), dict(orientation='horizontal'),\n           dict(fraction=0.3, pad=0.1), dict(shrink=0.5), dict(aspect=10)):\n    fig, ax = plt.subplots()\n    im = ax.imshow([[1, 2], [3, 4]])\n    cb = fig.colorbar(im, **kw)\n    show(\"A4 colorbar %s: its axes\" % r(sorted(kw.items())), lambda: bounds(cb.ax))\n    show(\"A4 colorbar %s: the parent\" % r(sorted(kw.items())), lambda: bounds(ax))\n    fig.canvas.draw()\n    show(\"A4 colorbar %s, drawn: its axes\" % r(sorted(kw.items())), lambda: bounds(cb.ax))\n    plt.close(fig)\nfig, (a1, a2) = plt.subplots(2, 1)\ncb = fig.colorbar(a1.imshow([[1, 2], [3, 4]]), ax=a1)\nshow(\"A4 2x1, colorbar on the top one: its axes\", lambda: bounds(cb.ax))\nshow(\"A4 2x1, colorbar on the top one: the parent\", lambda: bounds(a1))\nshow(\"A4 2x1, colorbar on the top one: the other\", lambda: bounds(a2))\nplt.close(fig)\nfig = plt.figure()\nax = fig.add_axes([0.1, 0.2, 0.6, 0.5])\ncb = fig.colorbar(ax.scatter([0, 1], [0, 1], c=[0, 1]), ax=ax)\nshow(\"A4 add_axes parent: colorbar axes\", lambda: bounds(cb.ax))\nshow(\"A4 add_axes parent: the parent\", lambda: bounds(ax))\nplt.close(fig)\nfig, ax = plt.subplots()\nm = ax.scatter([0, 1], [0, 1], c=[0, 1])\nc1, c2 = fig.colorbar(m), fig.colorbar(m)\nshow(\"A4 two colorbars: the first\", lambda: bounds(c1.ax))\nshow(\"A4 two colorbars: the second\", lambda: bounds(c2.ax))\nshow(\"A4 two colorbars: the parent\", lambda: bounds(ax))\nfig.canvas.draw()\nshow(\"A4 two colorbars, drawn: the second\", lambda: bounds(c2.ax))\nplt.close(fig)\n\n# A14: x must expand where the margins rule doesn't apply (limits given tight)\nfor ys in ([0, 3], [0, 10]):\n    fig, ax = plt.subplots()\n    ax.plot([0, 1], ys)\n    ax.set_xlim(0, 1); ax.set_ylim(*ys)\n    ax.set_aspect('equal', adjustable='datalim')\n    show(\"A14 datalim, limits given (0, 1) %s\" % r(tuple(ys)), lambda: lims(fig, ax))\n    plt.close(fig)\n\n# A19: inverted by invert_xaxis, set_xticks widening, then set_xlim again\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xlim(0, 1)\nax.invert_xaxis()\nax.set_xticks([-1, 2])\nshow(\"A19 widened\", lambda: (tuple(float(v) for v in ax.get_xlim()), ax.xaxis_inverted()))\nax.set_xlim(0, 1)\nshow(\"A19 set_xlim(0, 1) after\", lambda: (tuple(float(v) for v in ax.get_xlim()), ax.xaxis_inverted()))\nshow(\"A19 drawn\", lambda: drawn(fig, ax)[1])\nplt.close(fig)\n\n# A19: inverted while autoscaled, the limits fixed by autoscale(False), then set_xticks widening\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.invert_xaxis()\nax.autoscale(False)\nax.set_xticks([-1, 2])\nshow(\"A19 invert_xaxis, autoscale(False), set_xticks widening\", lambda: (tuple(float(v) for v in ax.get_xlim()), ax.xaxis_inverted()))\nshow(\"A19 ... drawn\", lambda: drawn(fig, ax)[1])\nplt.close(fig)\n\n# A4: an Axes on a GridSpec cell (add_subplot(gs[i, j])): its position\nfig = plt.figure()\ngs = fig.add_gridspec(2, 1)\ntop, bottom = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[1, 0])\nshow(\"A4 add_subplot(gs[0, 0]) of 2x1\", lambda: bounds(top))\nshow(\"A4 add_subplot(gs[1, 0]) of 2x1\", lambda: bounds(bottom))\nplt.close(fig)\n\n# A19: one limit given, invert_xaxis, set_xticks widening\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nax.set_xlim(left=0)\nax.invert_xaxis()\nax.set_xticks([-1, 2])\nshow(\"A19 set_xlim(left=0), invert_xaxis, set_xticks widening\", lambda: (tuple(float(v) for v in ax.get_xlim()), ax.xaxis_inverted()))\nshow(\"A19 ... drawn\", lambda: drawn(fig, ax)[1])\nplt.close(fig)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "A12b datalim, data 1.45 x 1 => ((-0.0725, 1.5225), (-0.0942661, 1.09427))",
    "A15b datalim, ylim given inverted, data (0, 3, 0, 1) => ((-0.15, 3.15), (1.72952, -0.729516))",
    "A15b datalim, xlim given inverted, data (0, 1, 0, 3) => ((2.71429, -1.71429), (-0.15, 3.15))",
    "L2 datalim, log x, data (1, 3, 0, 1) => ((0.316567, 9.47667), (-0.05, 1.05))",
    "L2 datalim, log x, data (1, 10, 0, 3) => ((0.019307, 517.947), (-0.15, 3.15))",
    "L2 datalim, log x, data (1, 2, 1, 1000) !! ValueError Axis limits cannot be NaN or Inf",
    "L3 datalim, log x, data (0, 10, 1, 2), limits (1, 100) (0, 3) => ((0.0970539, 1030.36), (0, 3))",
    "L3 datalim, log x, data (-5, 10, 0, 4), limits (1, 1000) (0, 4) => ((0.0654662, 15275.1), (0, 4))",
    "L5 log x 10^2.2..10^3.4: tick locations => (100, 1000, 10000)",
    "L9-L11 figsize (2, 1.5): x ticks => (1e-10, 1, 1e+10, 1e+20, 1e+30)",
    "L9-L11 figsize (2, 1.5): y ticks => (1e-06, 1, 1e+06, 1e+12, 1e+18, 1e+24)",
    "L9-L11 figsize (8, 2): x ticks => (0.001, 1, 1000, 1e+06, 1e+09, 1e+12, 1e+15, 1e+18, 1e+21)",
    "L9-L11 figsize (8, 2): y ticks => (1e-05, 1, 100000, 1e+10, 1e+15, 1e+20, 1e+25)",
    "L9-L11 figsize (2, 8): x ticks => (1e-10, 1, 1e+10, 1e+20, 1e+30)",
    "L9-L11 figsize (2, 8): y ticks => (0.001, 1, 1000, 1e+06, 1e+09, 1e+12, 1e+15, 1e+18, 1e+21)",
    "L9-L11 figsize (1, 1): x ticks => (1e-20, 1, 1e+20, 1e+40)",
    "L9-L11 figsize (1, 1): y ticks => (1e-20, 1, 1e+20, 1e+40)",
    "L9-L11 figsize (0.6, 0.6): x ticks => (1e-20, 1, 1e+20, 1e+40)",
    "L9-L11 figsize (0.6, 0.6): y ticks => (1e-20, 1, 1e+20, 1e+40)",
    "P2 datalim drawn in the plain box => True",
    "A4 colorbar (): its axes => (0.78375, 0.11, 0.11625, 0.77)",
    "A4 colorbar (): the parent => (0.1675, 0.11, 0.5775, 0.77)",
    "A4 colorbar (), drawn: its axes => (0.78375, 0.11, 0.028875, 0.77)",
    "A4 colorbar ((location, left)): its axes => (0.125, 0.11, 0.11625, 0.77)",
    "A4 colorbar ((location, left)): the parent => (0.31875, 0.11, 0.5775, 0.77)",
    "A4 colorbar ((location, left)), drawn: its axes => (0.212375, 0.11, 0.028875, 0.77)",
    "A4 colorbar ((location, top)): its axes => (0.125, 0.7645, 0.775, 0.1155)",
    "A4 colorbar ((location, top)): the parent => (0.2815, 0.11, 0.462, 0.616)",
    "A4 colorbar ((location, top)), drawn: its axes => (0.125, 0.7645, 0.775, 0.0516667)",
    "A4 colorbar ((orientation, horizontal)): its axes => (0.125, 0.11, 0.775, 0.1155)",
    "A4 colorbar ((orientation, horizontal)): the parent => (0.310375, 0.341, 0.40425, 0.539)",
    "A4 colorbar ((orientation, horizontal)), drawn: its axes => (0.125, 0.173833, 0.775, 0.0516667)",
    "A4 colorbar ((fraction, 0.3), (pad, 0.1)): its axes => (0.6675, 0.11, 0.2325, 0.77)",
    "A4 colorbar ((fraction, 0.3), (pad, 0.1)): the parent => (0.125, 0.185, 0.465, 0.62)",
    "A4 colorbar ((fraction, 0.3), (pad, 0.1)), drawn: its axes => (0.6675, 0.11, 0.028875, 0.77)",
    "A4 colorbar ((shrink, 0.5)): its axes => (0.78375, 0.3025, 0.11625, 0.385)",
    "A4 colorbar ((shrink, 0.5)): the parent => (0.1675, 0.11, 0.5775, 0.77)",
    "A4 colorbar ((shrink, 0.5)), drawn: its axes => (0.78375, 0.3025, 0.0144375, 0.385)",
    "A4 colorbar ((aspect, 10)): its axes => (0.78375, 0.11, 0.11625, 0.77)",
    "A4 colorbar ((aspect, 10)): the parent => (0.1675, 0.11, 0.5775, 0.77)",
    "A4 colorbar ((aspect, 10)), drawn: its axes => (0.78375, 0.11, 0.05775, 0.77)",
    "A4 2x1, colorbar on the top one: its axes => (0.78375, 0.53, 0.11625, 0.35)",
    "A4 2x1, colorbar on the top one: the parent => (0.4825, 0.53, 0.2625, 0.35)",
    "A4 2x1, colorbar on the top one: the other => (0.125, 0.11, 0.775, 0.35)",
    "A4 add_axes parent: colorbar axes => (0.61, 0.2, 0.09, 0.5)",
    "A4 add_axes parent: the parent => (0.1, 0.2, 0.48, 0.5)",
    "A4 two colorbars: the first => (0.78375, 0.11, 0.11625, 0.77)",
    "A4 two colorbars: the second => (0.652, 0.11, 0.093, 0.77)",
    "A4 two colorbars: the parent => (0.125, 0.11, 0.496, 0.77)",
    "A4 two colorbars, drawn: the second => (0.652, 0.11, 0.028875, 0.77)",
    "A14 datalim, limits given (0, 1) (0, 3) => ((-1.51299, 2.51299), (0, 3))",
    "A14 datalim, limits given (0, 1) (0, 10) => ((-6.20996, 7.20996), (0, 10))",
    "A19 widened => ((2, -1), True)",
    "A19 set_xlim(0, 1) after => ((0, 1), False)",
    "A19 drawn => (0, 1)",
    "A19 invert_xaxis, autoscale(False), set_xticks widening => ((2, -1), True)",
    "A19 ... drawn => (2, -1)",
    "A4 add_subplot(gs[0, 0]) of 2x1 => (0.125, 0.53, 0.775, 0.35)",
    "A4 add_subplot(gs[1, 0]) of 2x1 => (0.125, 0.11, 0.775, 0.35)",
    "A19 set_xlim(left=0), invert_xaxis, set_xticks widening => ((2, -1), True)",
    "A19 ... drawn => (2, -1)",
  ]);
});

// (a colorbar on an Axes of a GridSpec cell, its room taken from the cell
// it was given; datalim moving a linear pair past the largest float:
// matplotlib's ValueError; each line matplotlib 3.11.1's own)
test("a colorbar on a GridSpec cell; datalim limits past the largest float: matplotlib 3.11.1's (#797 r3)", () => {
  const out = runIn("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt, warnings\nwarnings.simplefilter('ignore')\ndef r(v):\n    if isinstance(v, (tuple, list)):\n        return \"(\" + \", \".join(r(x) for x in v) + \")\"\n    if isinstance(v, float):\n        return \"%.6g\" % v\n    return str(v)\ndef show(label, f):\n    try:\n        print(label, \"=>\", r(f()))\n    except Exception as e:\n        print(label, \"!!\", type(e).__name__, str(e)[:100])\nb = lambda ax: tuple(float(v) for v in ax.get_position().bounds)\nfig = plt.figure()\ngs = fig.add_gridspec(2, 2)\nax = fig.add_subplot(gs[0, 1])\ncb = fig.colorbar(ax.scatter([0, 1], [0, 1], c=[0, 1]), ax=ax)\nshow(\"CB12 add_subplot(gs[0, 1]) of 2x2: colorbar axes\", lambda: b(cb.ax))\nshow(\"CB12 add_subplot(gs[0, 1]) of 2x2: the parent\", lambda: b(ax))\nplt.close(fig)\nfor ys in ([-1.5e308, 1.5e308], [-1e308, 1e308], [0, 1.7e308]):\n    fig, ax = plt.subplots()\n    ax.plot([0, 1], ys)\n    ax.set_aspect('equal', adjustable='datalim')\n    def lims():\n        fig.canvas.draw()\n        return tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim())\n    show(\"L2v datalim, data (0, 1) %s\" % r(tuple(ys)), lims)\n    plt.close(fig)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "CB12 add_subplot(gs[0, 1]) of 2x2: colorbar axes => (0.847159, 0.53, 0.0528409, 0.35)",
    "CB12 add_subplot(gs[0, 1]) of 2x2: the parent => (0.547727, 0.53, 0.281818, 0.35)",
    "L2v datalim, data (0, 1) (-1.5e+308, 1.5e+308) !! ValueError Axis limits cannot be NaN or Inf",
    "L2v datalim, data (0, 1) (-1e+308, 1e+308) !! ValueError Axis limits cannot be NaN or Inf",
    "L2v datalim, data (0, 1) (0, 1.7e+308) !! ValueError Axis limits cannot be NaN or Inf",
  ]);
});
