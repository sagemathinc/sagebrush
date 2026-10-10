// .ipynb round trips keep what Sagebrush does not use (audit F8): notebook
// and cell metadata (widgets, tags, provenance), raw cells, attachments, the
// original kernelspec.  node web/test-ipynb.mjs
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// (an ES module the browser loads; a .mjs copy for node)
const copy = join(mkdtempSync(join(tmpdir(), "sb-ipynb-")), "ipynb.mjs");
copyFileSync(new URL("./notebook/ipynb.js", import.meta.url), copy);
const { fromFile, toIpynb, toScript } = await import(pathToFileURL(copy));

const original = {
  cells: [
    { cell_type: "code", id: "code1", metadata: { tags: ["parameters"], execution: { "iopub.status.busy": "2026-10-01T00:00:00Z" } }, source: ["x = 2"], execution_count: 1, outputs: [] },
    { cell_type: "raw", id: "raw1", metadata: { raw_mimetype: "text/latex" }, source: ["\\section{Results}"] },
    { cell_type: "markdown", id: "md1", metadata: {}, source: ["# Hi ![a](attachment:a.png)"], attachments: { "a.png": { "image/png": "iVBOR" } } },
    { cell_type: "code", id: "code2", metadata: {}, source: ["print(x)\n", "x"], execution_count: 2, outputs: [{ output_type: "stream", name: "stdout", text: ["2\n"] }] },
  ],
  metadata: {
    kernelspec: { name: "python3", display_name: "Python 3 (ipykernel)", language: "python" },
    language_info: { name: "python", version: "3.12.1" },
    widgets: { "application/vnd.jupyter.widget-state+json": { state: {}, version_major: 2 } },
    custom_provenance: { experiment: "keep this" },
  },
  nbformat: 4,
  nbformat_minor: 5,
};
let pass = 0;
const ok = (name, f) => { f(); pass++; console.log("ok", name); };

const doc = fromFile("t.ipynb", JSON.stringify(original));
ok("an unchanged notebook is written back exactly", () => assert.deepEqual(JSON.parse(toIpynb(doc)), original));
ok("raw cells stay raw", () => assert.equal(doc.cells[1].type, "raw"));
ok("a changed mode changes only the kernel", () => {
  const sage = JSON.parse(toIpynb({ ...doc, mode: "sage" }));
  assert.deepEqual(sage.metadata.kernelspec, { name: "sagemath", display_name: "SageMath", language: "sage" });
  assert.deepEqual(sage.metadata.language_info, { name: "sage" });
  assert.deepEqual(sage.metadata.widgets, original.metadata.widgets);
  assert.deepEqual(sage.metadata.custom_provenance, original.metadata.custom_provenance);
});
ok("edited cells keep their metadata", () => {
  const edited = { ...doc, cells: doc.cells.map((c) => (c.id === "code1" ? { ...c, code: "x = 3" } : c)) };
  const j = JSON.parse(toIpynb(edited));
  assert.deepEqual(j.cells[0].metadata, original.cells[0].metadata);
  assert.deepEqual(j.cells[0].source, ["x = 3"]);
});
ok("a new notebook gets Sagebrush's metadata", () => {
  const j = JSON.parse(toIpynb({ mode: "magma", cells: [{ id: "a", code: "1+1;" }] }));
  assert.deepEqual(j.metadata, { kernelspec: { name: "magma", display_name: "Magma", language: "magma" }, language_info: { name: "magma" } });
  assert.deepEqual(j.cells[0].metadata, {});
});
ok("nbformat 3 notebooks: headings become Markdown, prompt numbers kept", () => {
  const v3 = { nbformat: 3, metadata: {}, worksheets: [{ cells: [{ cell_type: "heading", level: 2, source: "Title" }, { cell_type: "code", input: "1+1", prompt_number: 4, outputs: [] }] }] };
  const d = fromFile("old.ipynb", JSON.stringify(v3));
  assert.deepEqual(d.cells.map((c) => [c.type ?? "code", c.code, c.n ?? null]), [["markdown", "## Title", null], ["code", "1+1", 4]]);
});
ok("a file that is not a notebook is an error, not an empty notebook", () => {
  assert.throws(() => fromFile("x.ipynb", "{}"), /not a Jupyter notebook/);
  assert.throws(() => fromFile("x.ipynb", "{\"cells\": [ "), SyntaxError);
});
ok("scripts keep raw cells (jupytext's [raw])", () => {
  const s = toScript(doc);
  assert.match(s, /# %% \[raw\]\n# \\section\{Results\}/);
  assert.deepEqual(fromFile("t.py", s).cells.map((c) => [c.type ?? "code", c.code]), doc.cells.map((c) => [c.type ?? "code", c.code]));
});
console.log(`${pass} passed`);
