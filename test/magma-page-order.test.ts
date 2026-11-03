// Magma cells that redefine names, in page order (U13a): the reactive
// notebook's renames (src/notebook-reactive.ts: each name several cells
// define, through src/rename.ts renameRedefinitions) make each cell's code
// the effective code src/magma.ts translates (PAGE_ORDER).  Run each cell its
// own translation, the outputs must be real Magma's for the cells run top to
// bottom (test/magma-page-order.json, scripts/magma-page-order-oracle.py).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { magmaToPython } from "../src/magma";
import { analyzeCell } from "../src/dataflow";
import { renameRedefinitions } from "../src/rename";
import { SCOPE_SEP } from "../src/notebook-reactive";

const table = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "magma-page-order.json"), "utf8"));
const cli = join(__dirname, "..", "src", "cli.js");

/** The cells' effective code, as the reactive notebook makes it. */
function effective(cells: string[]): string[] {
  const ids = cells.map((_, k) => `c${k}`);
  const an = cells.map((c) => analyzeCell(c, "c", { mode: "magma" }));
  const eff = new Map(ids.map((id, k) => [id, cells[k]]));
  const definers = new Map<string, string[]>(), taken = new Set<string>();
  an.forEach((a, k) => {
    for (const n of a.defs) (definers.get(n) ?? definers.set(n, []).get(n)!).push(ids[k]);
    for (const n of [...a.defs, ...a.refs]) taken.add(n);
  });
  for (const c of cells) for (const m of c.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) taken.add(m[0]);
  for (const [name, ds] of [...definers].filter(([, ds]) => ds.length > 1).sort()) {
    const r = renameRedefinitions(ids.map((id, k) => ({ id, code: eff.get(id)!, defines: ds.includes(id), reads: an[k].refs.has(name) })), name, taken, "magma", SCOPE_SEP);
    assert.ok(r, `renaming ${name} was refused`);
    for (const [id, code] of r) eff.set(id, code);
  }
  return ids.map((id) => eff.get(id)!);
}

function run(cells: string[]): string {
  const py = cells.map((c, k) => magmaToPython(c + "\n", `<cell ${k}>`, { recover: "session" })).join("\n");
  const f = join(mkdtempSync(join(tmpdir(), "magma-page-order-")), "cells.py");
  writeFileSync(f, py);
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout + r.stderr;
}

for (const c of table.cases) {
  test(`Magma page order: ${c.name}`, () => {
    const eff = effective(c.cells);
    assert.equal(run(eff), c.out, eff.join("\n---\n"));
  });
}

test("Magma page order: the renamed cells' analysis has one definer per name", () => {
  const eff = effective(["x := 1;", "print x^2;", "x := 17;", "print x^3;"]);
  const an = eff.map((c) => analyzeCell(c, "c", { mode: "magma" }));
  assert.deepEqual(an.map((a) => [...a.defs].sort()), [["x"], [], [`x${SCOPE_SEP}2`], []]);
  assert.ok(an[1].refs.has("x") && an[3].refs.has(`x${SCOPE_SEP}2`));
  // (a plain redefinition reads no earlier value: no edge from cell 0 to cell 2)
  assert.ok(!an[2].refs.has("x"), [...an[2].refs].join(" "));
  // (a redefinition that reads it does)
  const [, b] = effective(["x := 1;", "x +:= 1;"]).map((c) => analyzeCell(c, "c", { mode: "magma" }));
  assert.ok(b.refs.has("x") && b.defs.has(`x${SCOPE_SEP}2`), JSON.stringify([[...b.defs], [...b.refs]]));
});

test("Magma page order: refused where names are made at run time", () => {
  const r = renameRedefinitions([
    { id: "a", code: "x := 1;", defines: true, reads: false },
    { id: "b", code: 'x := eval "2";', defines: true, reads: false },
  ], "x", new Set(["x"]), "magma", SCOPE_SEP);
  assert.equal(r, null);
});

test("Magma page order: a renamed name is said as written in messages", () => {
  const eff = effective(["x := 1;", "x := 2; print y;", "print x;"]);
  const out = run(eff);
  assert.ok(!out.includes(SCOPE_SEP), out);
  assert.match(out, /Identifier 'y' has not been declared or assigned/);
});
