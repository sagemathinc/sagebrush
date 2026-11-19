import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Figures as the Jupyter kernel shows them (src/kernel.ts: its host's figure_formats, "png"), and as %config
// InlineBackend.figure_formats changes them (lib/_pyjs_magic.py, lib/_graphics.py figure_formats), against IPython's own
// kernel: test/jupyter-figures.json, from ipykernel with matplotlib and matplotlib-inline (test/jupyter_figures_gen.py).
// The same formats for every case. Where Sagebrush differs on purpose, the case says so and checks Sagebrush's own:
//   - the PNG's size: ipykernel crops the figure to what is drawn (bbox_inches="tight"); Sagebrush draws the whole
//     figure, its figsize at 100 dpi, so its PNG is never smaller;
//   - "retina": ipykernel's PNG is drawn at twice the size; Sagebrush's at the figure's own size, said on stderr;
//   - a format neither shows ('bmp'): ipykernel takes it, and its next figure fails (ValueError); Sagebrush says so
//     on stderr and keeps the formats;
//   - another configurable: ipykernel takes it silently; Sagebrush says on stderr that it isn't used.

const oracle = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "jupyter-figures.json"), "utf8"));
const { notebookSession } = require("../src/notebook-session");
const { R } = require("../src/compile");

type Out = { stream?: string; error?: string; shown?: string[]; png?: [number, number] };

async function run(cells: string[], hostFormats: string | null, mode = "python"): Promise<Out[]> {
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  // (the kernel's host says "png"; the notebook page's, none: SVG)
  R.host.figure_formats = hostFormats === null ? undefined : () => hostFormats;
  // (each case afresh: no formats set by %config, no figure left open)
  await s.handle({ id: 1, code: "import _graphics\n_graphics.set_figure_formats(None)" });
  let id = 1;
  for (const code of cells) await s.handle({ id: ++id, code, ...(mode === "python" ? {} : { [mode]: true }) });
  const outs: Out[] = [];
  for (const m of msgs.filter((m) => m.id === id)) {
    if (m.stream === "stderr") outs.push({ stream: "stderr", ...(/Traceback/.test(m.text) ? { error: /(\w+Error)/.exec(m.text)?.[1] } : {}) });
    if (m.display || m.result) {
      const d = m.display ?? m.result;
      const o: Out = { shown: Object.keys(d).filter((k) => k.startsWith("image/")).sort() };
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

for (const c of oracle.cases) {
  test(`the Jupyter kernel's figures, as ipykernel's: ${c.name}`, async () => {
    const ours = await run(c.cells, "png");
    const theirs: any[] = c.outputs;
    const imgs = (o: any) => (o.mimes ?? []).filter((k: string) => k.startsWith("image/")).sort();
    if (c.name === "a format it can't show" || c.name === "another configurable") {
      assert.deepEqual(theirs, []);
      assert.deepEqual(ours, [{ stream: "stderr" }], "said on stderr, not an error");
      return;
    }
    if (c.name === "a format it can't show leaves the formats") {
      assert.deepEqual(theirs, [{ error: "ValueError" }]);
      assert.deepEqual(ours.map((o) => o.shown), [["image/svg+xml"]], "the formats set before are kept");
      return;
    }
    const shown = ours.filter((o) => o.shown);
    assert.deepEqual(shown.map((o) => o.shown), theirs.map(imgs), "the same formats");
    for (const [i, o] of shown.entries()) {
      if (!o.png) continue;
      assert.deepEqual(o.png, figsize(c.cells), "the whole figure, its figsize at 100 dpi");
      const [w, h] = theirs[i].png;
      if (c.name === "figure_format retina") {
        assert.ok(w > 1.5 * o.png[0], `(ipykernel's retina: about twice the figure: ${[w, h]})`);
        assert.ok(ours.some((x) => x.stream === "stderr"), "retina at the figure's own size is said");
      } else assert.ok(o.png[0] >= w && o.png[1] >= h, `never smaller than ipykernel's, cropped: ${o.png} vs ${[w, h]}`);
    }
  });
}

test("the notebook page's figures stay SVG (no host formats), and %config there changes them too", async () => {
  assert.deepEqual((await run(["import matplotlib.pyplot as plt\nplt.plot([1, 2, 3]);"], null)).map((o) => o.shown), [["image/svg+xml"]]);
  assert.deepEqual((await run(["import matplotlib.pyplot as plt", "%config InlineBackend.figure_formats = ['png']\nplt.plot([1, 2]);"], null)).map((o) => o.shown), [["image/png"]]);
});

test("Sage's and MATLAB's figures follow the formats; an animation stays SVG", async () => {
  const sage = async (code: string, formats: string | null) => (await run([code], formats, "sage")).map((o) => o.shown ?? o);
  assert.deepEqual(await sage("plot(sin(x), (x, 0, 3))", "png"), [["image/png"]]);
  assert.deepEqual(await sage("graphics_array([plot(sin(x)), plot(cos(x))])", "png"), [["image/png"]]);
  assert.deepEqual(await sage("animate([plot(sin(x + k)) for k in range(3)])", "png"), [["image/svg+xml"]], "an animation stays SVG");
  assert.deepEqual(await sage("plot(sin(x), (x, 0, 3))", null), [["image/svg+xml"]], "Sage on the notebook page: SVG");
  assert.deepEqual((await run(["x = 1:3;\nplot(x, x.^2)"], "png", "matlab")).map((o) => o.shown), [["image/png"]], "MATLAB under the kernel: PNG");
  assert.deepEqual((await run(["x = 1:3;\nplot(x, x.^2)"], null, "matlab")).map((o) => o.shown), [["image/svg+xml"]]);
});
