import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeCell } from "../src/dataflow";

// web/notebook/marimo.js (marimo's .py notebook format) against marimo's own
// parser: test/marimo-format-oracle.json (test/marimo_format_oracle.py) has
// marimo's examples and each cell's code as marimo reads it.

const oracle: { marimo: string; cases: { path: string; text: string; cells: string[] }[] } = JSON.parse(readFileSync(__dirname + "/../../test/marimo-format-oracle.json", "utf8"));
// (an ES module the browser loads: a .mjs copy for node, imported for real, as tsc would make import() a require)
const copy = join(mkdtempSync(join(tmpdir(), "sb-marimo-")), "marimo.mjs");
copyFileSync(__dirname + "/../../web/notebook/marimo.js", copy);
const load = () => new Function("u", "return import(u)")(pathToFileURL(copy).href);
let n = 0;
const newId = () => `c${n++}`;

test(`reading marimo notebooks agrees with marimo ${oracle.marimo}`, async () => {
  const { fromMarimo, isMarimo } = await load();
  const wrong: string[] = [];
  let cells = 0, md = 0;
  for (const c of oracle.cases) {
    if (!isMarimo(c.text)) { wrong.push(`${c.path}: not recognized`); continue; }
    const doc = fromMarimo(c.path, c.text, newId, { keepMo: true });
    if (doc.cells.length !== c.cells.length) { wrong.push(`${c.path}: ${doc.cells.length} cells, marimo ${c.cells.length}`); continue; }
    doc.cells.forEach((x: any, i: number) => {
      cells++;
      const want = c.cells[i].trim();
      if (x.type === "markdown") {
        md++;
        if (!/^mo\.md\(/.test(want)) wrong.push(`${c.path} cell ${i}: Markdown here, marimo: ${JSON.stringify(want.slice(0, 80))}`);
      } else if (x.code.trim() !== want) wrong.push(`${c.path} cell ${i}:\n  ours   ${JSON.stringify(x.code.slice(0, 200))}\n  marimo ${JSON.stringify(want.slice(0, 200))}`);
    });
  }
  assert.equal(wrong.length, 0, `${wrong.length} differ (of ${cells} cells, ${md} Markdown):\n${wrong.slice(0, 10).join("\n")}`);
});

test("writing a marimo notebook and reading it back", async () => {
  const { fromMarimo, toMarimo, isMarimo } = await load();
  const doc = { mode: "python", cells: [{ id: "a", type: "markdown", code: "# Title\n\nSome $x^2$ text" }, { id: "b", code: "x = 1\n_t = 2\ny = x + _t" }, { id: "c", code: "print(y)" }] };
  const analysis = (code: string) => { const a = analyzeCell(code); return { defs: a.defs, refs: a.refs }; };
  const text = toMarimo(doc, analysis);
  assert.ok(isMarimo(text));
  assert.match(text, /@app\.cell\ndef _\(x\):|@app\.cell\ndef _\(\):\n    x = 1/);
  assert.match(text, /def _\(\):\n    x = 1\n    _t = 2\n    y = x \+ _t\n    return \(x, y,\)/);
  assert.match(text, /def _\(y\):\n    print\(y\)\n    return/);
  const back = fromMarimo("n.py", text, newId);
  assert.deepEqual(back.cells.map((c: any) => [c.type ?? "code", c.code]), doc.cells.map((c: any) => [c.type ?? "code", c.code]));
});
