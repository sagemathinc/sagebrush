import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Graphics bounds as drawn (lib/sage_plot.py, lib/_sage_graph.py): a range set
// with set_axes_range or xmin(v) is the drawn x range (the SVG's data-xr), not
// only the getters'; a graph's picture drawn before a range change redraws its
// SVG after it, without the canvas view; a graph's picture keeps the margin
// range its plot set (test/graphics_bounds_cases.sage).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("Graphics bounds: the set range is the drawn range, a graph's picture redraws after a range change and keeps its plot's range", () => {
  const out = execFileSync(process.execPath, [CLI, "--sage", TEST + "graphics_bounds_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "plain 0.0 2.0",
    "set_axes_range(xmin=-5) -5.0 2.0",
    "xmin(-5) -5.0 2.0",
    "graph range set True",
    "graph view before True",
    "graph view after xmin(-5) False -5.0",
  ]);
});
