import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Graph.plot (lib/_sage_graph.py): named graphs at their positions, others
// at lib/_graph_spring.py's layout (web/graph/spring.ts's, bit for bit),
// scaled; arrows that stop at their head's marker; Sage's colour options;
// every option it does not have refused (test/graph_plot_cases.sage
// asserts the rest).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("Graph.plot: positions, the spring layout, colours, arrows; other options, and graphs and option streams past the caps, refused", () => {
  const out = execFileSync(process.execPath, [CLI, "--sage", TEST + "graph_plot_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "Graphics object consisting of 9 graphics primitives",
    "{'xmin': 0.0, 'xmax': 1.0, 'ymin': 0.0, 'ymax': 1.0}",
    "Graphics object consisting of 10 graphics primitives",
    "Graphics object consisting of 7 graphics primitives",
    "Graphics object consisting of 4 graphics primitives",
    "Graphics object consisting of 7 graphics primitives",
    "refused: Graph.plot option 'vertex_shape' is not supported in Sagebrush",
    "refused: Graph.plot layout 'planar' is not supported in Sagebrush (only 'spring' and 'circular')",
    "refused: Graph.plot option 'edge_labels_background' is not supported in Sagebrush",
    "refused: Graph.plot option 'by_component' is not supported in Sagebrush",
    "ValueError: edge_style must be 'solid', 'dashed', 'dotted' or 'dashdot', not 'wavy'",
    "refused: Graph.show3d is not supported in Sagebrush",
    "refused: a picture of a graph this large is not supported in Sagebrush (at most 1500 vertices and 20000 edges)",
    "refused: a picture of a graph this large is not supported in Sagebrush (at most 1500 vertices and 20000 edges)",
    "refused: a picture of a graph this large is not supported in Sagebrush (at most 1500 vertices and 20000 edges)",
    "refused (stored positions): a picture of a graph this large is not supported in Sagebrush (at most 1500 vertices and 20000 edges)",
    "refused: Graph.plot: edge_colors of more than 20000 items is not supported in Sagebrush",
    "refused: Graph.plot: partition of more than 1500 items is not supported in Sagebrush",
    "refused: Graph.plot: partition of more than 1500 items is not supported in Sagebrush",
    "refused: Graph.plot: vertex_colors of more than 1500 items is not supported in Sagebrush",
    "refused: Graph.plot: edge_colors of more than 20000 items is not supported in Sagebrush",
    "Graphics object consisting of 7 graphics primitives",
    "ok",
  ]);
});
