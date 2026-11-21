import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NotebookGraph } from "../src/notebook-graph";
import { analyzeCell } from "../src/dataflow";

// src/notebook-graph.ts against marimo's own graph: test/notebook-graph-oracle.json
// (test/marimo_graph_oracle.py) has random notebooks and marimo's example
// notebooks, with marimo's parents, errors and run orders.

const oracle: {
  marimo: string;
  cases: { cells: string[]; parents: Record<string, string[]>; errors: Record<string, string[]>; order: string[]; runs: Record<string, string[]> }[];
} = JSON.parse(readFileSync(process.env.GRAPH_ORACLE ?? __dirname + "/../../test/notebook-graph-oracle.json", "utf8"));

const build = (cells: string[], strict: boolean) => new NotebookGraph(cells.map((code, i) => ({ id: `c${i}`, code })), { strict, analyze: (code, id) => analyzeCell(code, id, { strict }) });

function errorKinds(g: NotebookGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, es] of g.errors) out[id] = [...new Set(es.map((e) => (e.kind === "multiple-definition" ? "multiple:" + e.name : e.kind)))].sort();
  return out;
}

// marimo records one cycle per edge closing one, so it can miss cells that
// are on a cycle (src/notebook-graph.ts).  Ours: every cell of a strongly
// connected component.  So compare cycle errors as: marimo's cells are among
// ours, and each component we report has a cell marimo reports.
function reconcileCycles(g: NotebookGraph, want: Record<string, string[]>): Record<string, string[]> {
  const marimo = new Set(Object.keys(want).filter((id) => want[id].includes("cycle")));
  const out: Record<string, string[]> = {};
  for (const [id, kinds] of Object.entries(errorKinds(g))) {
    const scc = (g.errors.get(id)!.find((e) => e.kind === "cycle") as { cells: string[] } | undefined)?.cells;
    const keep = kinds.filter((k) => k !== "cycle" || marimo.has(id) || !scc!.some((x) => marimo.has(x)));
    if (keep.length) out[id] = keep;
  }
  return out;
}

test(`the graph agrees with marimo ${oracle.marimo} (strict)`, () => {
  const wrong: string[] = [];
  let extra = 0;
  for (const c of oracle.cases) {
    const g = build(c.cells, true);
    const errors = reconcileCycles(g, c.errors);
    if (JSON.stringify(errors) !== JSON.stringify(errorKinds(g))) extra++;
    const got = {
      parents: Object.fromEntries(g.ids.map((id) => [id, [...g.parents(id)].sort()])),
      errors,
      order: g.order(g.ids),
      runs: Object.fromEntries(g.ids.map((id) => [id, g.order(g.closure([id]))])),
    };
    const want = { parents: c.parents, errors: c.errors, order: c.order, runs: c.runs };
    try {
      assert.deepEqual(got, want);
    } catch {
      const diff = Object.keys(want).filter((k) => JSON.stringify((got as any)[k]) !== JSON.stringify((want as any)[k]));
      wrong.push(`${JSON.stringify(c.cells).slice(0, 400)}\n  ${diff.map((k) => `${k}: marimo ${JSON.stringify((want as any)[k])} ours ${JSON.stringify((got as any)[k])}`).join("\n  ")}`);
    }
  }
  assert.equal(wrong.length, 0, `${wrong.length} of ${oracle.cases.length} differ:\n${wrong.slice(0, 8).join("\n")}`);
  // (in 70 of the 3,198 notebooks, marimo misses cells on a cycle)
  assert.ok(extra < oracle.cases.length / 20, `${extra} notebooks with cycle cells marimo misses`);
});

test("#1477: several cells may define a name no cell reads", () => {
  const g = build(["for i in range(3):\n    pass", "for i in range(5):\n    pass", "fig = 1", "fig = 2"], false);
  assert.equal(g.errors.size, 0);
  assert.deepEqual(g.definers.get("i"), ["c0", "c1"]);
  // ... until a cell reads it
  const h = build(["for i in range(3):\n    pass", "for i in range(5):\n    pass", "print(i)"], false);
  assert.deepEqual([...h.errors.keys()].sort(), ["c0", "c1", "c2"]);
  assert.deepEqual(h.errors.get("c2"), [{ kind: "multiple-definition", name: "i", cells: ["c0", "c1"], reading: true }]);
  assert.deepEqual(h.errors.get("c0"), [{ kind: "multiple-definition", name: "i", cells: ["c1"] }]);
  // `df = clean(df)` reads df: still an error
  const k = build(["df = 1", "df = df + 1"], false);
  assert.deepEqual([...k.errors.keys()].sort(), ["c0", "c1"]);
});

test("cycles, import *, syntax errors", () => {
  const g = build(["a = b", "b = c", "c = a", "d = a", "from m import *", "x = ("], false);
  assert.deepEqual(g.errors.get("c0"), [{ kind: "cycle", cells: ["c0", "c1", "c2"] }]);
  assert.equal(g.errors.has("c3"), false);
  assert.equal(g.errors.get("c4")![0].kind, "import-star");
  assert.equal(g.errors.get("c5")![0].kind, "syntax");
  // a definition below its use runs first
  const h = build(["print(y)", "y = 1"], false);
  assert.deepEqual(h.order(h.ids), ["c1", "c0"]);
});

test("updaters: cells mutating another cell's object run between its definer and readers", () => {
  const g = build(["print(v)", "v = [1]", "v.append(2)", "v[0] = 5", "z = len(v)"], false);
  assert.deepEqual(g.updatersOf.get("v"), ["c2", "c3"]);
  assert.deepEqual(g.order(g.ids), ["c1", "c2", "c3", "c0", "c4"]);
  assert.equal(g.errors.size, 0);
  // strict (marimo): no such edges
  const h = build(["print(v)", "v = [1]", "v.append(2)"], true);
  assert.deepEqual(h.order(h.ids), ["c1", "c0", "c2"]);
});

test("the same import in several cells is not a multiple definition", () => {
  const g = build(["import numpy as np", "import numpy as np\nx = np.zeros(3)", "print(np.pi)"], false);
  assert.equal(g.errors.size, 0);
  const h = build(["import numpy as np", "import math as np", "print(np.pi)"], false);
  assert.deepEqual([...h.errors.keys()].sort(), ["c0", "c1", "c2"]);
  const k = build(["from math import pi", "from math import pi\npi = 3", "print(pi)"], false);
  assert.deepEqual([...k.errors.keys()].sort(), ["c0", "c1", "c2"]);
});

test("output names: a cell reading _, __, ___ runs after the 1st, 2nd, 3rd nearest cell above that showed a value", () => {
  const g = build(["10", "x = 1", "20", "_", "(_, __, ___)", "30", "_N = 1\n_N"], false);
  // (no run yet: nothing showed a value, so no edges)
  assert.deepEqual([...g.parents("c3")], []);
  g.setShown(["c0", "c2", "c3"]);
  // c3 reads _: c2 (c1 showed nothing)
  assert.deepEqual([...g.parents("c3")], ["c2"]);
  // c4 reads all three: c3, c2, c0
  assert.deepEqual([...g.parents("c4")].sort(), ["c0", "c2", "c3"]);
  // c6 binds nothing of the three (its _N is its own): no edge; c5 reads none
  assert.deepEqual([...g.parents("c6")], []);
  assert.deepEqual([...g.parents("c5")], []);
  // the facts change: c1 shows, c2 doesn't; c3's _ is c1 now, and c4's ___ has none above
  g.setShown(["c0", "c1", "c3"]);
  assert.deepEqual([...g.parents("c3")], ["c1"]);
  assert.deepEqual([...g.parents("c4")].sort(), ["c0", "c1", "c3"]);
  // (a reader's output parents are only cells above it, so they never close a cycle)
  const h = build(["1", "y = _", "y"], false);
  h.setShown(["c0", "c2"]);
  assert.deepEqual([...h.parents("c1")], ["c0"]);
  assert.deepEqual(h.order(h.ids), ["c0", "c1", "c2"]);
  // (setShown with the same facts doesn't rebuild: the version is kept)
  const v = h.version;
  h.setShown(new Set(["c2", "c0"]));
  assert.equal(h.version, v);
});


test("output names: after any sequence of setShown calls, the graph is the one a full build gives for the last (its edges, its providers, its errors); a change no reader sees keeps the version", () => {
  // (a seeded generator: the same cases every run)
  let seed = 1473;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const kinds = ["10", "_", "__ + 1", "(_, __, ___)", "x = 1", "y = x + _", "print(1)", "___", "z = y", "del x"];
  const state = (g: NotebookGraph) => JSON.stringify({
    parents: g.ids.map((id) => [id, [...g.parents(id)].sort()]),
    children: g.ids.map((id) => [id, [...g.children(id)].sort()]),
    providers: [...g.outputProviders()].sort(),
    errors: [...g.errors].map(([id, es]) => [id, es.map((e) => e.kind)]),
  });
  for (let c = 0; c < 60; c++) {
    const cells = Array.from({ length: 3 + rnd(12) }, () => kinds[rnd(kinds.length)]);
    const g = build(cells, false);
    for (let step = 0; step < 12; step++) {
      const shown = g.ids.filter(() => rnd(2) === 0);
      const before = state(g), v = g.version;
      g.setShown(shown);
      // (the reference: a fresh graph with the same facts, built in full)
      const ref = build(cells, false);
      ref.setShown(shown);
      ref.set(cells.map((code, i) => ({ id: `c${i}`, code })));
      assert.equal(state(g), state(ref), `case ${c}, step ${step}: ${JSON.stringify(cells)} shown ${JSON.stringify(shown)}`);
      if (state(g) === before) assert.equal(g.version, v, "nothing a reader sees changed: the same version");
    }
  }
  // (a notebook no cell of which reads _, __ or ___: showing values never builds it again)
  const big = build(Array.from({ length: 300 }, (_, i) => `v${i} = ${i}`), false);
  const v = big.version;
  for (let i = 0; i < 300; i++) big.setShown(big.ids.slice(0, i + 1));
  assert.equal(big.version, v);
});
