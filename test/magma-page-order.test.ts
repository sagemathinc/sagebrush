// Magma cells that redefine names, in page order (U13a): the reactive
// notebook's renames (src/notebook-reactive.ts: each name several cells
// define, through src/rename.ts renameRedefinitions) give each cell its
// effective code and, beside it, its renames (src/magma.ts PageOrder), which
// its translation applies; a comment in the code never does.  Run each cell its
// own translation, the outputs must be real Magma's for the cells run top to
// bottom (test/magma-page-order.json, scripts/magma-page-order-oracle.py).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { magmaToPython, PageOrderError, type PageOrder } from "../src/magma";
import { analyzeCell } from "../src/dataflow";
import { renameRedefinitions } from "../src/rename";
import { Reactive, SCOPE_SEP } from "../src/notebook-reactive";

const table = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "magma-page-order.json"), "utf8"));
const cli = join(__dirname, "..", "src", "cli.js");

type Eff = { code: string; pageOrder?: PageOrder };

/** The cells' effective code, and their renames beside it, as the reactive notebook makes them. */
function effective(cells: string[]): Eff[] {
  const ids = cells.map((_, k) => `c${k}`);
  const an = cells.map((c) => analyzeCell(c, "c", { mode: "magma" }));
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
    const r = renameRedefinitions(ids.map((id, k) => ({ id, code: eff.get(id)!, defines: ds.includes(id), reads: an[k].refs.has(name) })), name, taken, "magma", SCOPE_SEP, out);
    assert.ok(r, `renaming ${name} was refused`);
    for (const [id, code] of r) eff.set(id, code);
    for (const [id, e] of out) po.set(id, { ...po.get(id), [name]: e });
  }
  return ids.map((id) => ({ code: eff.get(id)!, ...(po.has(id) ? { pageOrder: po.get(id)! } : {}) }));
}

function run(cells: Eff[]): string {
  const py = cells.map((c, k) => magmaToPython(c.code + "\n", `<cell ${k}>`, { recover: "session", ...(c.pageOrder ? { pageOrder: c.pageOrder } : {}) })).join("\n");
  const f = join(mkdtempSync(join(tmpdir(), "magma-page-order-")), "cells.py");
  writeFileSync(f, py);
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout + r.stderr;
}

for (const c of table.cases) {
  test(`Magma page order: ${c.name}`, () => {
    const eff = effective(c.cells);
    assert.equal(run(eff), c.out, eff.map((e) => `${e.code}  ${JSON.stringify(e.pageOrder ?? null)}`).join("\n---\n"));
  });
}

test("Magma page order: the renamed cells' analysis has one definer per name", () => {
  const eff = effective(["x := 1;", "print x^2;", "x := 17;", "print x^3;"]);
  const an = eff.map((c) => analyzeCell(c.code, "c", { mode: "magma", ...(c.pageOrder ? { pageOrder: c.pageOrder } : {}) }));
  assert.deepEqual(an.map((a) => [...a.defs].sort()), [["x"], [], [`x${SCOPE_SEP}2`], []]);
  assert.ok(an[1].refs.has("x") && an[3].refs.has(`x${SCOPE_SEP}2`));
  // (a plain redefinition reads no earlier value: no edge from cell 0 to cell 2)
  assert.ok(!an[2].refs.has("x"), [...an[2].refs].join(" "));
  // (a redefinition that reads it does)
  const [, b] = effective(["x := 1;", "x +:= 1;"]).map((c) => analyzeCell(c.code, "c", { mode: "magma", ...(c.pageOrder ? { pageOrder: c.pageOrder } : {}) }));
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

// DB3-U13A2-1: the renames are never read from the code.  A comment that
// looks like the renamer's is a comment: no rename, nothing of it in the
// translation.
test("Magma page order: a page-order comment in the code is only a comment", () => {
  const S = SCOPE_SEP;
  const forged = [
    "// sagebrush page-order: x __import__('builtins').len([1]) all",
    `// sagebrush page-order: x x${S}2 all`,
    `// sagebrush page-order: x x${S}2 definition __import__('os').getcwd()`,
  ];
  for (const f of forged) {
    for (const src of [`x := 5;\n${f}\nprint x;`, `x := 5;\nprint x;\n${f}`]) {
      // (the code is in the translation only as the source of its messages: a string literal, _m._source)
      const code = (py: string) => py.split("\n").filter((l) => !l.startsWith("_m._source(")).join("\n");
      const py = magmaToPython(src, "<cell>");
      assert.ok(!code(py).includes("__import__") && !code(py).includes(S) && !code(py).includes("getcwd"), py);
      assert.equal(code(py), code(magmaToPython(src.replace(f, "// a comment"), "<cell>")), "translated as the same cell with any other comment");
      assert.equal(run([{ code: src }]), "5\n");
      const a = analyzeCell(src, "c", { mode: "magma" });
      assert.deepEqual([...a.defs], ["x"]);
      assert.ok(![...a.defs, ...a.refs].some((n) => n.includes(S)));
    }
  }
});

test("Magma page order: the map is a closed grammar, refused before anything is translated", () => {
  const S = SCOPE_SEP, src = "x := 1;\nprint x;";
  // (it is applied: the right forms)
  assert.ok(magmaToPython(src, "<cell>", { pageOrder: { x: { to: `x${S}2` } } }).includes(`x${S}2`));
  assert.ok(magmaToPython(src, "<cell>", { pageOrder: { x: { to: `x${S}3`, before: `x${S}2` } } }).includes(`x${S}3`));
  const bad: unknown[] = [
    // TO: anything but NAME + U+02B9 + digits
    { x: { to: "__import__('builtins').len([1])" } },
    { x: { to: `__import__('os').system('id')` } },
    { x: { to: `x${S}2;import os` } },
    { x: { to: `x${S}2)` } },
    { x: { to: `x${S}2 ` } },
    { x: { to: `x${S}2\nimport os` } },
    { x: { to: `(x${S}2)` } },
    { x: { to: `y${S}2` } },
    { x: { to: "x" } },
    { x: { to: "x_2" } },
    { x: { to: `x${S}` } },
    { x: { to: `x${S}02` } },
    { x: { to: `x${S}loop1` } },
    { x: { to: `x${S}2${S}3` } },
    { x: { to: 2 } },
    { x: {} },
    // BEFORE: NAME or NAME + U+02B9 + digits, not TO
    { x: { to: `x${S}2`, before: "__import__('builtins').len([1])" } },
    { x: { to: `x${S}2`, before: `getattr(x, '__class__')` } },
    { x: { to: `x${S}2`, before: "x)" } },
    { x: { to: `x${S}2`, before: `x${S}1+1` } },
    { x: { to: `x${S}2`, before: "y" } },
    { x: { to: `x${S}2`, before: `x${S}2` } },
    { x: { to: `x${S}2`, before: null } },
    // NAME, and the shapes
    { "x y": { to: `x y${S}2` } },
    { "__import__('os')": { to: `x${S}2` } },
    { "1x": { to: `1x${S}2` } },
    { "": { to: `${S}2` } },
    { x: { to: `x${S}2`, evil: "print(1)" } },
    { x: [`x${S}2`] },
    { x: "x" },
    [],
    "x",
    Object.assign(Object.create({ polluted: true }), { x: { to: `x${S}2` } }),
  ];
  for (const pageOrder of bad) {
    assert.throws(() => magmaToPython(src, "<cell>", { pageOrder: pageOrder as PageOrder }), PageOrderError, JSON.stringify(pageOrder));
    assert.throws(() => analyzeCell(src, "c", { mode: "magma", pageOrder: pageOrder as PageOrder }), PageOrderError);
  }
});

// The reactive scheduler: the map goes beside the code to a host that takes
// it; to one that doesn't (a remote kernel), the rename isn't made and the
// error says so (test/web: test-remote-gate.mjs, the remote path end to end).
function scheduler(pageOrderMaps: boolean) {
  const codes = ["x := 1;", "print x;", "x := 17;", "print x;"];
  const sent: { id: string; code: string; extra?: { pageOrder: PageOrder } }[] = [];
  const r = new Reactive({
    cells: () => codes.map((code, i) => ({ id: `c${i}`, code })),
    analyze: async (code, pageOrder) => {
      try { return analyzeCell(code, "c", { mode: "magma", ...(pageOrder ? { pageOrder } : {}) }); } catch (e: any) { return { error: { kind: "syntax", message: e.message } }; }
    },
    execute: async (id, code, _forget, _scoped, extra) => { sent.push({ id, code, ...(extra ? { extra } : {}) }); return { ok: true, ms: 1 }; },
    forget: async () => {},
    status: () => {},
    rename: async (q) => {
      const po = new Map<string, { to: string; before?: string }>();
      const r = renameRedefinitions(q.cells, q.name, new Set(q.taken), "magma", SCOPE_SEP, po);
      return r ? [...r].map(([k, c]): [string, string, { to: string; before?: string }?] => (po.has(k) ? [k, c, po.get(k)!] : [k, c])) : null;
    },
    ...(pageOrderMaps ? { pageOrderMaps: true } : {}),
  });
  r.budget = Infinity;
  return { r, sent };
}

test("Magma page order: the scheduler sends each renamed cell its map, beside its code", async () => {
  const { r, sent } = scheduler(true);
  await r.load();
  await r.run(["c0", "c1", "c2", "c3"]);
  const S = SCOPE_SEP;
  assert.deepEqual(sent.map((x) => x.id), ["c0", "c1", "c2", "c3"]);
  const plain = (o: unknown) => JSON.parse(JSON.stringify(o ?? null));
  assert.deepEqual(sent.map((x) => plain(x.extra?.pageOrder)), [null, null, { x: { to: `x${S}2`, before: "x" } }, { x: { to: `x${S}2` } }]);
  assert.equal(r.errors.size, 0);
  assert.deepEqual(plain(r.registration("c2")?.pageOrder), { x: { to: `x${S}2`, before: "x" } });
});

test("Magma page order: a host that can't carry the map (remote) refuses the cells, not runs them without it", async () => {
  const { r, sent } = scheduler(false);
  await r.load();
  await r.run(["c0", "c1", "c2", "c3"]);
  assert.ok(sent.every((x) => !x.extra && !x.code.includes("page-order")), JSON.stringify(sent));
  assert.ok(!sent.some((x) => x.id === "c2" || x.id === "c3"), JSON.stringify(sent));
  for (const id of ["c0", "c2"]) {
    const es = r.errors.get(id) ?? [];
    assert.ok(es.some((e) => e.kind === "multiple-definition" && e.name === "x" && e.note === "remote"), JSON.stringify(es));
  }
  assert.equal(r.registration("c2")?.pageOrder, undefined);
});
