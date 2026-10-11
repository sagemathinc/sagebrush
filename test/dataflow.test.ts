import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeCell, ImportStarError, mangleLocals } from "../src/dataflow";
import { parse } from "../pyparse/src/index";

// src/dataflow.ts against marimo itself: test/dataflow-oracle.json is what
// marimo's compile_cell says of thousands of cells (test/marimo_oracle.py).
// DATAFLOW_ORACLE=file compares against another such file.

const oracle: { marimo: string; cases: { code: string; defs?: string[]; refs?: string[]; deleted?: string[]; error?: string }[] } = JSON.parse(
  readFileSync(process.env.DATAFLOW_ORACLE ?? __dirname + "/../../test/dataflow-oracle.json", "utf8"),
);

const sorted = (s: Set<string>) => [...s].sort();

test(`definitions and references agree with marimo ${oracle.marimo}`, () => {
  const wrong: string[] = [];
  for (const c of oracle.cases) {
    let got: any;
    try {
      const a = analyzeCell(c.code, "c1");
      got = { defs: sorted(a.defs), refs: sorted(a.refs), deleted: sorted(a.deleted) };
    } catch (e: any) {
      got = { error: e instanceof ImportStarError ? "ImportStarError" : `${e?.constructor?.name}: ${e?.message}` };
    }
    const want = c.error ? { error: c.error } : { defs: c.defs, refs: c.refs, deleted: c.deleted };
    try {
      assert.deepEqual(got, want);
    } catch {
      wrong.push(`${JSON.stringify(c.code).slice(0, 300)}\n  marimo: ${JSON.stringify(want)}\n  ours:   ${JSON.stringify(got)}`);
    }
  }
  assert.equal(wrong.length, 0, `${wrong.length} of ${oracle.cases.length} differ:\n${wrong.slice(0, 15).join("\n")}`);
});

test("marimo's documented examples", () => {
  const a = (code: string) => {
    const r = analyzeCell(code);
    return { defs: sorted(r.defs), refs: sorted(r.refs), deleted: sorted(r.deleted) };
  };
  // mutations are references, not definitions
  assert.deepEqual(a("v[1] = 5"), { defs: [], refs: ["v"], deleted: [] });
  assert.deepEqual(a("z.x = 10"), { defs: [], refs: ["z"], deleted: [] });
  // `_`-names are the cell's own
  assert.deepEqual(a("_t = f(x)\ny = _t + 1"), { defs: ["y"], refs: ["f", "x"], deleted: [] });
  // global in a function defines
  assert.deepEqual(a("def g():\n    global h\n    h = 1"), { defs: ["g", "h"], refs: [], deleted: [] });
  assert.deepEqual(a("del q"), { defs: [], refs: ["q"], deleted: ["q"] });
  // a capture defined later in the cell is not a reference
  assert.deepEqual(a("def f():\n    print(x)\nx = 0"), { defs: ["f", "x"], refs: ["print"], deleted: [] });
  assert.throws(() => analyzeCell("from m import *"), ImportStarError);
});

test("Sage var(): names of any script define; a private one with keywords is the cell's own", () => {
  assert.ok(analyzeCell("var('α')", "c", { mode: "sage" }).defs.has("α"));
  assert.ok(analyzeCell("var('α β', domain='real')", "c", { mode: "sage" }).defs.has("β"));
  for (const code of ["var('_x', domain='real')", "var('_x', latex_name='t')"]) {
    const tree: any = parse(code, "exec");
    mangleLocals(tree, "abc", { sage: true });
    const st = tree.body[0];
    assert.equal(st._type, "Assign");
    assert.equal(st.targets[0].id, "_cell_abc_x");
    assert.equal(st.value.func.attr, "var");
    assert.equal(st.value.keywords.length, 1);
  }
});
