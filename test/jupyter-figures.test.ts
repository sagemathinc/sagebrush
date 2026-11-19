import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// How figures are shown (lib/_graphics.py figures; the Jupyter kernel's --figures or SAGEBRUSH_FIGURES, src/kernel.ts),
// in every language, against IPython's own kernel where Jupyter's %config InlineBackend.figure_format(s) asks the
// same: test/jupyter-figures.json, from ipykernel with matplotlib and matplotlib-inline (test/jupyter_figures_gen.py).
// Where Sagebrush differs on purpose, the case says so and checks Sagebrush's own:
//   - the default: ipykernel's is a PNG at the figure's dpi; Sagebrush's is "auto", the figure's SVG (sharp at any
//     zoom), unless that would be over 1 MB: then a PNG, as below, with a line under it saying so;
//   - a PNG is always drawn at twice the figure's dpi with its size at once in the display's metadata (ipykernel's
//     "retina"), so it is sharp on a high-density screen: also for 'png';
//   - the PNG's size: ipykernel crops the figure to what is drawn (bbox_inches="tight"); Sagebrush draws the whole
//     figure, its figsize at 100 dpi (twice that in pixels), so its PNG is never smaller;
//   - a format neither shows ('bmp'): ipykernel takes it, and its next figure fails (ValueError); Sagebrush says so
//     on stderr and keeps how figures are shown;
//   - another configurable: ipykernel takes it silently; Sagebrush says on stderr that it isn't used.

const oracle = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "jupyter-figures.json"), "utf8"));
const { notebookSession } = require("../src/notebook-session");
const { R } = require("../src/compile");

type Out = { stream?: string; text?: string; error?: string; shown?: string[]; png?: [number, number]; metadata?: any };

// cells run in a fresh session whose host says how figures are shown (the kernel's --figures; null: none, "auto"),
// with no setting left by an earlier case; the last cell's outputs, in order
async function run(cells: string[], hostFigures: string | null, mode = "python"): Promise<Out[]> {
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  R.host.figures = hostFigures === null ? undefined : () => hostFigures;
  await s.handle({ id: 1, code: "import _graphics\n_graphics.figures('reset')\nimport matplotlib.pyplot as plt\nplt.close('all')" });
  let id = 1;
  for (const code of cells) await s.handle({ id: ++id, code, ...(mode === "python" ? {} : { [mode]: true }) });
  const outs: Out[] = [];
  for (const m of msgs.filter((m) => m.id === id)) {
    if (m.stream) outs.push({ stream: m.stream, text: m.text, ...(/Traceback/.test(m.text) ? { error: /(\w+Error)/.exec(m.text)?.[1] } : {}) });
    if (m.display || m.result) {
      const d = m.display ?? m.result;
      const o: Out = { shown: Object.keys(d).filter((k) => k.startsWith("image/")).sort(), metadata: m.metadata ?? {} };
      if (d["image/png"]) {
        const b = Buffer.from(d["image/png"], "base64");
        assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG");
        o.png = [b.readUInt32BE(16), b.readUInt32BE(20)];
      }
      outs.push(o);
    }
  }
  return outs;
}

const figsize = (cells: string[]) => {
  const m = /figsize=\((\d+), (\d+)\)/.exec(cells.join("\n"));
  return m ? [Number(m[1]) * 100, Number(m[2]) * 100] : [640, 480];
};
const imgs = (o: any) => (o.mimes ?? []).filter((k: string) => k.startsWith("image/")).sort();
const DEFAULT = ["a figure shown at the cell's end", "a figure of its own size", "a figure as the cell's value"];

for (const c of oracle.cases) {
  test(`figures, as ipykernel shows them: ${c.name}`, async () => {
    const ours = await run(c.cells, null);
    const theirs: any[] = c.outputs;
    if (c.name === "a format it can't show" || c.name === "another configurable") {
      assert.deepEqual(theirs, []);
      assert.deepEqual(ours.map((o) => o.stream), ["stderr"], "said on stderr, not an error");
      return;
    }
    if (c.name === "a format it can't show leaves the formats") {
      assert.deepEqual(theirs, [{ error: "ValueError" }]);
      assert.deepEqual(ours.map((o) => o.shown), [["image/svg+xml"]], "how figures are shown is kept");
      return;
    }
    const shown = ours.filter((o) => o.shown);
    const [fw, fh] = figsize(c.cells);
    if (DEFAULT.includes(c.name)) {
      // (ipykernel's default is a PNG; Sagebrush's "auto", an SVG for a figure this small)
      assert.deepEqual(theirs.map(imgs), [["image/png"]]);
      assert.deepEqual(shown.map((o) => o.shown), [["image/svg+xml"]], "an SVG by default");
      assert.deepEqual(shown[0].metadata, {});
      return;
    }
    assert.deepEqual(shown.map((o) => o.shown), theirs.map(imgs), "the same formats");
    for (const [i, o] of shown.entries()) {
      if (!o.png) {
        assert.deepEqual(o.metadata, theirs[i].metadata, "no metadata for an SVG, as ipykernel's");
        continue;
      }
      // (twice the size, shown at once: ipykernel's "retina", whose metadata has these keys; its 'png' has none)
      if (/retina/.test(c.name)) assert.deepEqual(Object.keys(theirs[i].metadata["image/png"]).sort(), ["height", "width"], "(ipykernel's retina)");
      else assert.deepEqual(theirs[i].metadata, {}, "(ipykernel's png: no metadata)");
      assert.deepEqual(o.png, [2 * fw, 2 * fh], "drawn at twice the figure's size in pixels");
      assert.deepEqual(o.metadata, { "image/png": { width: fw, height: fh } }, "shown at the figure's size");
      const [w, h] = theirs[i].png;
      assert.ok(o.png[0] >= w && o.png[1] >= h, `never smaller than ipykernel's, cropped: ${o.png} vs ${[w, h]}`);
    }
  });
}

// a scatter whose SVG is over 1 MB (about 30,000 markers), and a figure far under it
const BIG = "import numpy as np\nimport matplotlib.pyplot as plt\nrng = np.random.default_rng(1)\nfig, ax = plt.subplots()\nax.plot(rng.random(30000), rng.random(30000), 'k.', ms=1);";
const SMALL = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3]);";

test("auto: a figure is its SVG; one whose SVG would be over 1 MB is a sharp PNG, said in a line under it", async () => {
  assert.deepEqual((await run([SMALL], null)).map((o) => o.shown), [["image/svg+xml"]]);
  const big = await run([BIG], null);
  assert.deepEqual(big.map((o) => o.shown ?? o.stream), [["image/png"], "stdout"], "the PNG, then the line");
  assert.deepEqual(big[0].png, [1280, 960]);
  assert.deepEqual(big[0].metadata, { "image/png": { width: 640, height: 480 } });
  assert.match(big[1].text!, /^Shown as a PNG: its SVG would be 1\.\d MB\. For an SVG anyway: sagebrush\.figures\('svg'\) \(in MATLAB or Magma: sagebrush_figures\('svg'\)\)\.\n$/);
});

test("the setting forces each way, in Python: sagebrush.figures, and %config as its alias", async () => {
  const shown = async (cells: string[]) => (await run(cells, null)).map((o) => o.shown ?? o.stream);
  assert.deepEqual(await shown(["import sagebrush\nsagebrush.figures('svg')", BIG]), [["image/svg+xml"]], "svg: even a big one, and nothing said");
  assert.deepEqual(await shown(["import sagebrush\nsagebrush.figures('png')", SMALL]), [["image/png"]], "png: even a small one");
  assert.deepEqual(await shown(["import sagebrush\nsagebrush.figures('both')", SMALL]), [["image/png", "image/svg+xml"]]);
  assert.deepEqual(await shown(["%config InlineBackend.figure_format = 'png'", SMALL]), [["image/png"]]);
  assert.deepEqual(await shown(["import sagebrush\nsagebrush.figures('png')", "sagebrush.figures('reset')", SMALL]), [["image/svg+xml"]], "reset: auto again");
  assert.match((await run(["import sagebrush\nsagebrush.figures('jpeg')"], null))[0].text!, /ValueError: figures: 'jpeg' is not a way to show figures/);
});

test("the setting forces each way in a MATLAB notebook too (sagebrush_figures), and Sage's figures follow it", async () => {
  const matlab = async (cells: string[], host: string | null = null) => (await run(cells, host, "matlab")).map((o) => o.shown ?? o.stream);
  assert.deepEqual(await matlab(["x = 1:3;\nplot(x, x.^2)"]), [["image/svg+xml"]], "auto: an SVG");
  assert.deepEqual(await matlab(["sagebrush_figures('png');", "x = 1:3;\nplot(x, x.^2)"]), [["image/png"]]);
  assert.deepEqual(await matlab(["sagebrush_figures(\"png\");", "sagebrush_figures('svg');", "x = 1:3;\nplot(x, x.^2)"]), [["image/svg+xml"]]);
  const png = (await run(["sagebrush_figures('png');", "plot(1:3)"], null, "matlab"))[0];
  assert.deepEqual(png.metadata, { "image/png": { width: 560, height: 420 } }, "a MATLAB figure's size, at once");
  assert.deepEqual(png.png, [1120, 840]);
  const sage = async (cells: string[]) => (await run(cells, null, "sage")).map((o) => o.shown ?? o.stream);
  assert.deepEqual(await sage(["plot(sin(x), (x, 0, 3))"]), [["image/svg+xml"]]);
  assert.deepEqual(await sage(["import sagebrush\nsagebrush.figures('png')", "plot(sin(x), (x, 0, 3))"]), [["image/png"]]);
  assert.deepEqual(await sage(["import sagebrush\nsagebrush.figures('png')", "animate([plot(sin(x + k)) for k in range(3)])"]), [["image/svg+xml"]], "an animation stays its SVG");
});

test("the kernel's --figures sets the default, which the notebook's code can still change", async () => {
  assert.deepEqual((await run([SMALL], "png")).map((o) => o.shown), [["image/png"]]);
  assert.deepEqual((await run([BIG], "svg")).map((o) => o.shown ?? o.stream), [["image/svg+xml"]]);
  assert.deepEqual((await run(["import sagebrush\nsagebrush.figures('svg')", SMALL], "png")).map((o) => o.shown), [["image/svg+xml"]]);
  assert.deepEqual((await run(["x = 1:3;\nplot(x, x)"], "png", "matlab")).map((o) => o.shown), [["image/png"]]);
});
