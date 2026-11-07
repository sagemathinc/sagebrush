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
