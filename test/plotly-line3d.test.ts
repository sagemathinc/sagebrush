import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Sagebrush's own plotly: plotly.express.line_3d, from arrays or from a table's columns with color= splitting the
// rows, drawn in Sagebrush's 3D viewer. The traces' names, colors and points and the axis and legend titles below
// are what plotly 7.1 gives for the same calls.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("line_3d from arrays, and from columns with color=: plotly's traces, colors and titles", () => {
  const out = py(`
import numpy as np
import plotly
import plotly.express as px
t = np.linspace(0, 1, 5)
f = px.line_3d(x=t, y=t ** 2, z=t ** 3, labels=dict(x="time", y="sq", z="cube"))
s = f.layout.scene
print(plotly.__version__, [d.type for d in f.data], s.xaxis.title.text, s.yaxis.title.text, s.zaxis.title.text, f.data[0].line.color.lower(), repr(f.data[0].name), f.data[0].showlegend)
data = {"R": [0, 1, 2, 3], "J": [1, 0, 1, 0], "T": [0, 1, 2, 3], "color": ["a", "a", "b", "b"]}
g = px.line_3d(data, x="R", y="J", z="T", color="color")
print([(d.name, d.line.color.lower(), d.x) for d in g.data], g.layout.scene.xaxis.title.text, g.layout.legend.title.text)
print("array xyz", [round(v, 4) for v in f.data[0].x], [round(v, 4) for v in f.data[0].y], [round(v, 4) for v in f.data[0].z])
print("grouped xyz", [(d.name, d.x, d.y, d.z) for d in g.data])
h = px.line_3d(data, x="R", y="J", z="T", color="color", labels={"R": "rabbits"})
print(h.layout.scene.xaxis.title.text, h.layout.scene.yaxis.title.text)
print(g)
`);
  assert.equal(out, [
    "7.1.0 ['scatter3d'] time sq cube #636efa '' False",
    "[('a', '#636efa', [0.0, 1.0]), ('b', '#ef553b', [2.0, 3.0])] R color",
    "array xyz [0.0, 0.25, 0.5, 0.75, 1.0] [0.0, 0.0625, 0.25, 0.5625, 1.0] [0.0, 0.0156, 0.125, 0.4219, 1.0]",
    "grouped xyz [('a', [0.0, 1.0], [1.0, 0.0], [0.0, 1.0]), ('b', [2.0, 3.0], [1.0, 0.0], [2.0, 3.0])]",
    "rabbits J",
    "Figure(2 traces: Scatter3d(name='a', 2 points), Scatter3d(name='b', 2 points))",
    "",
  ].join("\n"));
});

test("show() draws it in the 3D viewer: a line per trace in its color, the axis titles, a name label per colored line", () => {
  const out = py(`
import json
import plotly.express as px
data = {"R": [0, 1, 2, 3], "J": [1, 0, 1, 0], "T": [0, 1, 2, 3], "color": ["a", "a", "b", "b"]}
b = px.line_3d(data, x="R", y="J", z="T", color="color")._repr_mimebundle_()
print(sorted(b))
scene = json.loads(b["application/vnd.sagebrush.scene3d+json"])
print(scene["labels"], [(o["type"], o["color"].lower()) for o in scene["objects"]])
d3 = {"R": [0, 1, 2, 3], "J": [10, 20, 30, 40], "T": [100, 200, 300, 400], "color": ["a", "a", "b", "b"]}
s3 = json.loads(px.line_3d(d3, x="R", y="J", z="T", color="color")._repr_mimebundle_()["application/vnd.sagebrush.scene3d+json"])
print("pos", [[float(v) for v in o["pos"]] for o in s3["objects"] if o["type"] == "lines"])
a3 = json.loads(px.line_3d(x=[1, 2], y=[30, 40], z=[500, 600])._repr_mimebundle_()["application/vnd.sagebrush.scene3d+json"])
print("pos", [[float(v) for v in o["pos"]] for o in a3["objects"] if o["type"] == "lines"])
print([o["text"] for o in scene["objects"] if o["type"] == "text"], b["text/plain"])
one = px.line_3d(x=[0, 1, 2], y=[0, 1, 0], z=[0, 0, 1])._repr_mimebundle_()
print([o["type"] for o in json.loads(one["application/vnd.sagebrush.scene3d+json"])["objects"]])
px.line_3d(x=[0, 1], y=[0, 1], z=[0, 1]).show()
`);
  const lines = out.split("\n");
  assert.equal(lines[0], "['application/vnd.sagebrush.scene3d+json', 'image/svg+xml', 'text/html', 'text/plain']");
  assert.equal(lines[1], "['R', 'J', 'T'] [('lines', '#636efa'), ('lines', '#ef553b'), ('text', '#636efa'), ('text', '#ef553b')]");
  // (each line's segments as x0, y0, z0, x1, y1, z1: x, y and z where the data put them)
  assert.equal(lines[2], "pos [[0.0, 10.0, 100.0, 1.0, 20.0, 200.0], [2.0, 30.0, 300.0, 3.0, 40.0, 400.0]]");
  assert.equal(lines[3], "pos [[1.0, 30.0, 500.0, 2.0, 40.0, 600.0]]");
  assert.equal(lines[4], "['a', 'b'] Figure(2 traces: Scatter3d(name='a', 2 points), Scatter3d(name='b', 2 points))");
  assert.equal(lines[5], "['lines']");
  // (shown by the CLI: the scene's file, or its text where none is written)
  assert.match(lines[6], /3D plot: curve through 2 points|^Graphics3d Object$/);
});

test("errors as plotly's; facets, and the rest of plotly, refused by name", () => {
  const out = py(`
import plotly
import plotly.express as px
data = {"R": [0, 1], "J": [1, 0], "T": [0, 1]}
for call in (lambda: px.line_3d(data, x="Q", y="J", z="T"), lambda: px.line_3d(x=[0, 1], y=[0], z=[0, 1])):
    try:
        call()
    except ValueError as e:
        print("ValueError", e)
for kw in ({"facet_col": "color"}, {"facet_row": "color"}, {"facet_col_wrap": 2}):
    try:
        px.line_3d({"R": [0, 1], "J": [1, 0], "T": [0, 1], "color": ["a", "b"]}, x="R", y="J", z="T", **kw)
    except NotImplementedError as e:
        print("NotImplementedError", e)
for name in ("scatter", "line"):
    try:
        getattr(px, name)
    except NotImplementedError as e:
        print("NotImplementedError", e)
try:
    plotly.graph_objects
except NotImplementedError as e:
    print("NotImplementedError", e)
`);
  assert.equal(out, [
    "ValueError Value of 'x' is not the name of a column in 'data_frame'. Expected one of ['R', 'J', 'T'] but received: Q",
    "ValueError All arguments should have the same length. The length of argument \`y\` is 1, whereas the length of previously-processed arguments ['x'] is 2",
    "NotImplementedError line_3d(facet_col=...): facets are not in Sagebrush's plotly",
    "NotImplementedError line_3d(facet_row=...): facets are not in Sagebrush's plotly",
    "NotImplementedError line_3d(facet_col_wrap=...): facets are not in Sagebrush's plotly",
    "NotImplementedError plotly.express.scatter is not in Sagebrush's plotly (it has line_3d)",
    "NotImplementedError plotly.express.line is not in Sagebrush's plotly (it has line_3d)",
    "NotImplementedError plotly.graph_objects is not in Sagebrush's plotly (it has plotly.express.line_3d)",
    "",
  ].join("\n"));
});
