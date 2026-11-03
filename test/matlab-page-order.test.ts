// MATLAB cells that redefine names, in page order (as Magma's, U13a): the
// reactive notebook's renames (src/notebook-reactive.ts: each name several
// cells define, through src/rename.ts renameRedefinitions) give each cell its
// effective code and, beside it, its renames (src/page-order.ts), which its
// translation applies at the top level (src/matlab.ts).  Run in a notebook
// session cell by cell, the outputs must be those of the cells run top to
// bottom as one script by GNU Octave (test/matlab-page-order.json,
// scripts/matlab-page-order-oracle.py; the cases print with fprintf).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matlabToPython } from "../src/matlab";
import { PageOrderError, type PageOrder } from "../src/page-order";
import { analyzeCell } from "../src/dataflow";
import { renameRedefinitions } from "../src/rename";
import { SCOPE_SEP } from "../src/notebook-reactive";

const table = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "matlab-page-order.json"), "utf8"));
const S = SCOPE_SEP;

type Eff = { code: string; pageOrder?: PageOrder };

/** The cells' effective code, and their renames beside it, as the reactive notebook makes them. */
function effective(cells: string[]): Eff[] {
  const ids = cells.map((_, k) => `c${k}`);
  const an = cells.map((c) => analyzeCell(c, "c", { mode: "matlab" }));
  const eff = new Map(ids.map((id, k) => [id, cells[k]]));
  const po = new Map<string, Record<string, { to: string; before?: string }>>();
  const definers = new Map<string, string[]>(), taken = new Set<string>();
  an.forEach((a, k) => {
    for (const n of a.defs) (definers.get(n) ?? definers.set(n, []).get(n)!).push(ids[k]);
    for (const n of [...a.defs, ...a.refs]) taken.add(n);
  });
  for (const c of cells) for (const m of c.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) taken.add(m[0]);
  for (const [name, ds] of [...definers].filter(([, ds]) => ds.length > 1).sort()) {
    const out = new Map<string, { to: string; before?: string }>();
    const r = renameRedefinitions(ids.map((id, k) => ({ id, code: eff.get(id)!, defines: ds.includes(id), reads: an[k].refs.has(name) })), name, taken, "matlab", SCOPE_SEP, out);
    assert.ok(r, `renaming ${name} was refused`);
    for (const [id, code] of r) eff.set(id, code);
    for (const [id, e] of out) po.set(id, { ...po.get(id), [name]: e });
  }
  return ids.map((id) => ({ code: eff.get(id)!, ...(po.has(id) ? { pageOrder: po.get(id)! } : {}) }));
}

/** A notebook session (src/notebook-session.ts): run cells (by index, in the order given), each cell's stdout and stderr. */
async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (cell: Eff) => {
    const me = ++id;
    await s.handle({ id: me, code: cell.code, matlab: true, ...(cell.pageOrder ? { pageOrder: cell.pageOrder } : {}) });
    const text = (stream: string) => msgs.filter((m) => m.id === me && m.stream === stream).map((m) => m.text).join("");
    return { out: text("stdout"), err: text("stderr") };
  };
}

for (const c of table.cases) {
  test(`MATLAB page order: ${c.name}`, async () => {
    const eff = effective(c.cells);
    // (the case is one of page order: some name is renamed)
    assert.ok(eff.some((e) => e.pageOrder), "no rename");
    const run = await session();
    let out = "", err = "";
    for (const e of eff) {
      const r = await run(e);
      out += r.out;
      err += r.err;
    }
    assert.equal(err, "", eff.map((e) => e.code).join("\n---\n"));
    assert.equal(out, c.out, eff.map((e) => `${e.code}  ${JSON.stringify(e.pageOrder ?? null)}`).join("\n---\n"));
  });
}

test("MATLAB page order: running an earlier definition again leaves the later cells' value", async () => {
  const eff = effective(["x = 1;", "fprintf('%d\\n', x^2)", "x = 17;", "fprintf('%d\\n', x^3)"]);
  const run = await session();
  for (const e of eff) await run(e);
  await run(eff[0]);
  assert.equal((await run(eff[3])).out, "4913\n");
  assert.equal((await run(eff[1])).out, "1\n");
});

test("MATLAB page order: the renamed cells' analysis has one definer per name", () => {
  const eff = effective(["x = 1;", "disp(x^2)", "x = 17;", "disp(x^3)"]);
  const an = eff.map((c) => analyzeCell(c.code, "c", { mode: "matlab", ...(c.pageOrder ? { pageOrder: c.pageOrder } : {}) }));
  assert.deepEqual(an.map((a) => [...a.defs].sort()), [["x"], [], [`x${S}2`], []]);
  assert.ok(an[1].refs.has("x") && an[3].refs.has(`x${S}2`));
  // (a plain redefinition reads no earlier value; one that reads it does)
  assert.ok(!an[2].refs.has("x"), [...an[2].refs].join(" "));
  const [, b] = effective(["x = 1;", "x = x + 1;"]).map((c) => analyzeCell(c.code, "c", { mode: "matlab", ...(c.pageOrder ? { pageOrder: c.pageOrder } : {}) }));
  assert.ok(b.refs.has("x") && b.defs.has(`x${S}2`), JSON.stringify([[...b.defs], [...b.refs]]));
});

test("MATLAB page order: a renamed name is said as written in messages", async () => {
  const eff = effective(["x = 1;", "x = 2; y = undefined_thing;", "x(5)"]);
  const run = await session();
  let all = "";
  for (const e of eff) { const r = await run(e); all += r.out + r.err; }
  assert.ok(!all.includes(S), all);
  assert.match(all, /Unrecognized function or variable 'undefined_thing'/);
});

test("MATLAB page order: refused where names are made or read at run time, and for ans", () => {
  for (const code of ["x = 2; clear y", "eval('x = 2;')", "x = 2; exist('x')", "global x\nx = 2;", "x = 2; who", "load('f.mat')", "assignin('base', 'x', 2)"]) {
    const r = renameRedefinitions([
      { id: "a", code: "x = 1;", defines: true, reads: false },
      { id: "b", code, defines: true, reads: false },
    ], "x", new Set(["x"]), "matlab", SCOPE_SEP);
    assert.equal(r, null, code);
  }
  assert.equal(renameRedefinitions([
    { id: "a", code: "3 + 4", defines: true, reads: false },
    { id: "b", code: "5", defines: true, reads: false },
  ], "ans", new Set(["ans"]), "matlab", SCOPE_SEP), null);
});

test("MATLAB page order: the translator checks the map (src/page-order.ts) and refuses what it can't apply", () => {
  const ok = { x: { to: `x${S}2` } };
  assert.ok(matlabToPython("x = 1;", "<cell>", { cell: true, pageOrder: ok }).includes(`x${S}2 = `));
  // (a comment in the code is only a comment)
  const forged = `x = 1;\n% sagebrush page-order: x x${S}2 all\ndisp(x)`;
  assert.ok(!matlabToPython(forged, "<cell>", { cell: true }).split("\n").filter((l) => !l.startsWith("_m.begin(")).join("\n").includes(S));
  const bad: unknown[] = [{ x: { to: "__import__('os').system('id')" } }, { x: { to: `x${S}2`, before: "getattr(x, '__class__')" } }, { x: { to: `y${S}2` } }, { "x y": { to: `x y${S}2` } }, []];
  for (const pageOrder of bad) {
    assert.throws(() => matlabToPython("x = 1;", "<cell>", { cell: true, pageOrder: pageOrder as PageOrder }), PageOrderError, JSON.stringify(pageOrder));
  }
  // (names at run time, and a whole script rather than a cell: refused)
  assert.throws(() => matlabToPython("x = 1; clear y", "<cell>", { cell: true, pageOrder: ok }), PageOrderError);
  assert.throws(() => matlabToPython("x = 1;", "<script>", { pageOrder: ok }), PageOrderError);
  // (a function's workspace is its own: its x is not renamed)
  const py = matlabToPython("function y = f(x)\n  y = x + 1;\nend\nx = f(2);", "<cell>", { cell: true, pageOrder: ok });
  assert.ok(py.includes(`x, = _m.inargs(_a, ["x"]`) && py.includes("y = _m.plus(x, 1.0)") && py.includes(`x${S}2 = _m.paren(f, [2.0], 1)`), py);
});

// MATPO-SEM-1: page order renames variables only.  A cell defining a function
// of the name isn't renamed (the name keeps its multiple-definition error), and
// a map naming one of the cell's functions is refused by the translator.
test("MATLAB page order: a function defined again in a later cell is not renamed", () => {
  const cells = ["function r = f()\n  r = 1;\nend", "fprintf('%d\\n', f())", "function r = f()\n  r = 2;\nend", "fprintf('%d\\n', f())"];
  const an = cells.map((c) => analyzeCell(c, "c", { mode: "matlab" }));
  assert.deepEqual(an.map((a) => a.defs.has("f")), [true, false, true, false]);
  const r = renameRedefinitions(cells.map((code, k) => ({ id: `c${k}`, code, defines: an[k].defs.has("f"), reads: an[k].refs.has("f") })), "f", new Set(["f", "r"]), "matlab", SCOPE_SEP);
  assert.equal(r, null);
  // (the forms of a function line)
  for (const def of ["function f", "function f()", "function y = f(x)", "function [a, b] = f(x)", "  function y=f(x) % f"]) {
    assert.equal(renameRedefinitions([{ id: "a", code: "f = 1;", defines: true, reads: false }, { id: "b", code: `${def}\nend`, defines: true, reads: false }], "f", new Set(["f"]), "matlab", SCOPE_SEP), null, def);
  }
  // (a function whose name only starts so, or a variable f in a cell with another function: renamed)
  assert.ok(renameRedefinitions([{ id: "a", code: "f = 1;", defines: true, reads: false }, { id: "b", code: "f = 2;\nfunction y = fg(x)\n  y = x;\nend", defines: true, reads: false }], "f", new Set(["f"]), "matlab", SCOPE_SEP));
  assert.throws(() => matlabToPython(cells[2], "<cell>", { cell: true, pageOrder: { f: { to: `f${S}2`, before: "f" } } }), PageOrderError);
});

// MATPO-SEM-2: a script-level return may end the cell before a plain
// definition, which is then not sure: the earlier value stays.
test("MATLAB page order: a return before the definition keeps the earlier value", async () => {
  const eff = effective(["x = 1;", "if true\n  return\nend\nx = 2;", "fprintf('%d\\n', x)", "return\nx = 3;", "fprintf('%d\\n', x)"]);
  assert.ok(eff[1].pageOrder && eff[3].pageOrder, JSON.stringify(eff));
  const run = await session();
  let out = "", err = "";
  for (const e of eff) { const r = await run(e); out += r.out; err += r.err; }
  assert.equal(err, "");
  assert.equal(out, "1\n1\n");
  assert.match(matlabToPython(eff[3].code, "<cell>", { cell: true, pageOrder: eff[3].pageOrder }), new RegExp(`if "x${S}2" in globals\\(\\): x${S}3 = _m\\.cp\\(x${S}2\\)`));
});
