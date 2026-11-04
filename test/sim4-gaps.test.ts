import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agent simulation run 4's engine gaps (/scratch/sim/run4/RUN4.md):
// np.add.at (ufunc.at), matplotlib's semilogy (and semilogx, loglog), a Sage
// polygon's facecolor and GraphicsArray.show(figsize). The Sage side is
// sage-tests/test_sim4_plot_options.sage, compared with Sage 10.9.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";

test("ufunc.at: unbuffered, in place, cast to the array's dtype, with NumPy's errors (NumPy 2.5.1)", () => {
  const name = "sim4_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [CLI, TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// (CI's python3 has no matplotlib: what matplotlib 3.11.1 prints for it)
test("semilogx, semilogy and loglog make the axis a log one, then plot, as matplotlib's", () => {
  const out = execFileSync(process.execPath, [CLI, TEST + "sim4_mpl_cases.py"], { encoding: "utf8" });
  assert.equal(out, ["['Line2D'] linear log", "['Line2D'] log linear", "['Line2D', 'Line2D'] log log", "['Line2D'] linear log", "1 log log", "1 log log", ""].join("\n"));
});

test("a log axis of another base than 10 is refused, not labeled wrongly", () => {
  const code = "import matplotlib.pyplot as plt\nfor f in (lambda: plt.semilogy([1, 2], [1, 4], base=2), lambda: plt.gca().set_xscale('log', base=2)):\n    try:\n        f()\n    except NotImplementedError as e:\n        print(e)";
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" });
  assert.equal(out, "a log y axis of base 2 is not supported by sagebrush's matplotlib (base 10 is)\na log x axis of base 2 is not supported by sagebrush's matplotlib (base 10 is)\n");
});

test("GraphicsArray.show and save take figsize (the grid's, in inches) and each graphics' options, as Sage's", () => {
  const dir = mkdtempSync(join(tmpdir(), "ga-"));
  const code = [
    "G = graphics_array([plot(sin, 0, 1), plot(cos, 0, 1)])",
    `G.save('${dir}/a.svg', figsize=[8, 3])`,
    `G.save('${dir}/b.svg', figsize=5, axes_labels=['$x$', '$y$'])`,
    "G.show(figsize=[8, 3], axes_labels=['$t$', '$y$'])",
  ].join("\n");
  const out = execFileSync(process.execPath, [CLI, "--sage", "-c", code], { encoding: "utf8" });
  const size = (p: string) => readFileSync(p, "utf8").match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/)!.slice(1).map(Number);
  assert.deepEqual(size(dir + "/a.svg"), [800, 300]);
  assert.deepEqual(size(dir + "/b.svg"), [500, 375]);
  rmSync(dir, { recursive: true });
  assert.match(out, /^Saved \S+\.svg \(.*x \(\$t\$\).*x \(\$t\$\)/m);
});
