import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// matplotlib's legends (which artists, their order, swatches and colors,
// axhline and axvline among them) and its ticks and limits, against what
// CPython with matplotlib prints for the same program (test/mpl-oracle.json,
// from test/mpl_oracle_gen.py: CI has no matplotlib).
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));
const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("legends and ticks print as matplotlib's (test/mpl_legend_ticks_cases.py)", () => {
  assert.equal(run([TEST + "mpl_legend_ticks_cases.py"]), oracle["mpl_legend_ticks_cases.py"]);
});

test("the drawing: an axhline's legend entry is a dashed line, and the ticks drawn are the locator's", () => {
  // (Lab 1's cell 35, shortened: the legend left out the axhline)
  const svg = run(["-c", `
import matplotlib.pyplot as plt
import numpy as np
t = np.linspace(0, 200, 50)
plt.plot(t, t * 40, label="S")
plt.axhline(y=1000, color="gray", linestyle="--", label="Hospital Capacity")
plt.legend(loc="best")
print(plt.gcf()._svg())
`]);
  const legend = svg.slice(svg.indexOf('<g class="sb-legend">'));
  assert.match(legend, /<path d="M[\d.]+ [\d.]+h22" stroke="gray" stroke-width="[\d.]+" stroke-dasharray="6,4"\/><text [^>]*>Hospital Capacity<\/text>/);
  assert.match(legend, /stroke="#1f77b4"[^>]*\/><text [^>]*>S<\/text>/);
  // x ticks every 25 from 0 to 200 (matplotlib's), not every 50
  const labels = [...svg.matchAll(/<text [^>]*text-anchor="middle"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  for (const v of ["0", "25", "50", "75", "100", "125", "150", "175", "200"]) assert.ok(labels.includes(v), v + " in " + labels);
});
