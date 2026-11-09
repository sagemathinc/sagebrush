// ci: web-runner order=371 runner=bun
// nbformat.js: a notebook written as Jupyter's nbformat (as agents write one, the agent sim's F1) made Sagebrush's
// (fromNbformat), the same cells as reading the same .ipynb file (ipynb.js fromFile); Sagebrush's own documents, and
// anything not a notebook, left exactly as they are; a document's mode from its kernel (kernelMode).
//   bun web/notebook/test-nbformat.mjs
import { fromNbformat, kernelMode, cellOf } from "./nbformat.js";
import { fromFile, toIpynb } from "./ipynb.js";

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 600)); };
const J = JSON.stringify;

const nb = {
  cells: [
    { cell_type: "markdown", metadata: {}, source: ["# Title\n", "text"] },
    { cell_type: "code", id: "c-1", execution_count: 2, metadata: { sagebrush: { ms: 12 }, tags: ["x"] }, outputs: [{ output_type: "execute_result", data: { "text/plain": "4" } }], source: "2 + 2" },
    { cell_type: "raw", id: "r", metadata: {}, source: "raw text" },
    { cell_type: "code", source: 7 },
  ],
  metadata: { kernelspec: { name: "python3", language: "python" } }, nbformat: 4, nbformat_minor: 5,
};
const got = fromNbformat(nb);
check(J(got.cells.map((c) => [c.type ?? "code", c.code])) === J([["markdown", "# Title\ntext"], ["code", "2 + 2"], ["raw", "raw text"], ["code", "7"]]), "each nbformat cell made Sagebrush's: its type and its text (a list of lines joined, a number as text)", got.cells);
check(got.cells.every((c) => typeof c.code === "string" && c.cell_type === undefined && c.source === undefined && /^[a-zA-Z0-9_-]{1,64}$/.test(c.id)), "…no nbformat field left on a cell, and each with an id", got.cells);
check(got.cells[1].id === "c-1" && got.cells[1].n === 2 && got.cells[1].ms === 12 && J(got.cells[1].metadata) === J({ tags: ["x"] }) && got.cells[1].outputs[0].data["text/plain"] === "4", "…a code cell's id, count, run time, metadata and outputs kept", got.cells[1]);
check(got.nbformat === undefined && got.nbformat_minor === undefined && got.metadata.kernelspec.name === "python3", "the document: nbformat's version fields dropped, its metadata kept", got);
check(J(fromNbformat({ ...nb, nbformat_minor: 9 }).nbformat_minor) === "9", "…a minor past 5 kept, as fromFile keeps it", null);

// (the same cells as the file read: fromFile is the oracle, ids aside where the file has none)
const file = fromFile("x.ipynb", J(nb));
const noId = (cs) => cs.map(({ id: _i, ...c }) => c);
check(J(noId(got.cells.slice(0, 3))) === J(noId(file.cells.slice(0, 3))) && got.cells[1].id === file.cells[1].id, "the same cells as reading the same .ipynb file (fromFile)", { got: got.cells.slice(0, 3), file: file.cells.slice(0, 3) });

// (Sagebrush's own: the same object, untouched; a cell in each shape: only the nbformat one converted)
const own = { cells: [{ id: "a", code: "x", outputs: [] }, { id: "b", type: "markdown", code: "*y*" }], mode: "sage" };
check(fromNbformat(own) === own, "a document in Sagebrush's shape: returned as it is", null);
const mixed = fromNbformat({ cells: [{ id: "a", code: "x" }, { cell_type: "markdown", source: "m" }] });
check(J(mixed.cells[0]) === J({ id: "a", code: "x" }) && mixed.cells[1].type === "markdown" && mixed.cells[1].code === "m", "a cell in each shape: only the nbformat one converted", mixed.cells);
// (ids: one nbformat doesn't allow (a space, 65 characters) is replaced by a new one; a valid one is kept: grader's N9)
const ids = fromNbformat({ cells: [{ cell_type: "code", id: "a b", source: "1" }, { cell_type: "code", id: "x".repeat(65), source: "2" }, { cell_type: "code", id: "ok_id-1", source: "3" }] }).cells.map((c) => c.id);
check(ids[0] !== "a b" && ids[1] !== "x".repeat(65) && ids.every((i) => /^[a-zA-Z0-9_-]{1,64}$/.test(i)) && ids[2] === "ok_id-1", "an id nbformat doesn't allow (a space, 65 characters) gets a new one; a valid one is kept", ids);
// (a cell already Sagebrush's (its code text) stays exactly as given, even carrying nbformat's fields too: grader's N4)
const both = { code: "x", type: "markdown", cell_type: "markdown", source: "y" };
const mix = fromNbformat({ cells: [both, { cell_type: "code", source: "z" }] });
check(mix.cells[0] === both && mix.cells[0].code === "x" && mix.cells[1].code === "z", "a cell with its code text stays as given (code x), whatever nbformat fields it also carries; the nbformat one beside it is converted", mix.cells);
const empty = fromNbformat({ cells: [], nbformat: 4, nbformat_minor: 5, metadata: {} });
check(J(empty) === J({ cells: [], metadata: {} }), "no cells, but nbformat's fields: still nbformat's, its fields dropped", empty);
for (const v of [null, undefined, 5, "x", [], { cells: "no" }, { title: "a board", nodes: [] }]) check(fromNbformat(v) === v, `not a notebook (${J(v)}): as it is`, null);
// (a cell whose code isn't text, but with nbformat's source: nbformat's)
check(cellOf({ source: "s" }).type === "raw" && fromNbformat({ cells: [{ source: "s", code: 5 }] }).cells[0].code === "s", "a cell with source and no code text: nbformat's (raw when it names no kind)", null);

// (nbformat 3's heading cells: a level 1 to 6 (none given, 1), anything else refused before any text is made, by fromFile
// and the workspace alike: astra's NBF928-1)
const head = (level) => fromNbformat({ cells: [{ cell_type: "heading", source: "T", ...(level === undefined ? {} : { level }) }] }).cells[0];
check(head(undefined).type === "markdown" && head(undefined).code === "# T" && head(3).code === "### T" && head(6).code === "###### T", "a heading cell: Markdown, its level's #s (none given: 1)", [head(undefined), head(3)]);
const refused = (f) => { try { f(); return false; } catch (e) { return e instanceof Error && /^a heading cell's level is 1 to 6, not /.test(e.message); } };
check(head(null).code === "# T", "…a level of null (JSON's none): 1", head(null));
for (const level of [NaN, Infinity]) check(refused(() => fromNbformat({ cells: [{ cell_type: "heading", source: "T", level }] })), `a heading level of ${level} (not in JSON, but in a page's own call): refused`, null);
for (const level of [0, 7, 1e9, -1, 2.5, "3"]) {
  check(refused(() => fromNbformat({ cells: [{ cell_type: "heading", source: "T", level }] })) && refused(() => fromFile("h.ipynb", JSON.stringify({ worksheets: [{ cells: [{ cell_type: "heading", source: "T", level }] }], nbformat: 3 }))),
    `a heading level of ${String(level)}${typeof level === "string" ? " (text)" : ""}: refused, by the workspace's conversion and fromFile alike`, null);
}

// (the mode a kernel names, or none; round trip: written as .ipynb, read back as the same cells)
check(kernelMode(nb) === "python" && kernelMode({ metadata: { kernelspec: { name: "sagemath" } } }) === "sage" && kernelMode({ metadata: { language_info: { name: "octave" } } }) === "matlab" && kernelMode({ metadata: {} }) === undefined && kernelMode({ cells: [] }) === undefined && kernelMode(null) === undefined,
  "kernelMode: the mode a document's kernel names (sage, matlab, python), none when it names none", null);
const back = fromNbformat(JSON.parse(toIpynb({ ...got, mode: "python" })));
check(J(back.cells.map((c) => [c.id, c.type ?? "code", c.code])) === J(got.cells.map((c) => [c.id, c.type ?? "code", c.code])), "written as .ipynb (toIpynb) and made Sagebrush's again: the same cells", back.cells);

const bad = results.filter(([ok]) => !ok);
if (bad.length) { console.log(`FAIL: ${bad.length} of ${results.length}`); process.exit(1); }
console.log(`ok: nbformat.js, ${results.length} checks`);
