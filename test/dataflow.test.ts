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

// Where we differ from marimo on purpose, as Python does: what is evaluated
// before the cell binds a name (a default, a comprehension's first iterable,
// the target of `x += 1`) reads the name's previous value, so it is a
// reference (found by test/fuzz-reactive.ts).  Each: a fragment of the cell
// (or, for the short ones, all of it), and the extra refs.
const DIVERGES: [string, string[]][] = [
  ["x += 5", ["x"]],
  ["count += 1", ["count"]],
  ["x = {x: x**3 for x in x}", ["x"]],
  ["def uses_offset(x: int = offset())", ["offset"]],
  ["one: int = first(),", ["first", "second"]],
  ["def a(x: int = b()) -> int:", ["b", "c"]],
];

test(`definitions and references agree with marimo ${oracle.marimo}`, () => {
  const wrong: string[] = [];
  for (const c of oracle.cases) {
    let got: any;
    try {
      const a = analyzeCell(c.code, "c1", { strict: true });
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

test("ours (not strict): marimo's analysis, corrected where Python reads a name marimo does not count", () => {
  let n = 0;
  for (const c of oracle.cases) {
    if (c.error) continue;
    const extra = DIVERGES.find(([frag]) => (frag.length < 12 ? c.code.trim() === frag : c.code.includes(frag)))?.[1] ?? [];
    const a = analyzeCell(c.code, "c1");
    assert.deepEqual({ defs: sorted(a.defs), refs: sorted(a.refs), deleted: sorted(a.deleted) }, { defs: c.defs, refs: [...new Set([...(c.refs ?? []), ...extra])].sort(), deleted: c.deleted }, c.code);
    if (extra.length) n++;
  }
  assert.equal(n, 8);
  // a class's names are not seen from the bodies inside it; defaults and the
  // first iterable are evaluated in it; `del` in a class body; `x += 1`
  const refs = (code: string) => sorted(analyzeCell(code).refs);
  assert.deepEqual(refs("class D:\n    x = 1\n    y = (lambda: x)()"), ["x"]);
  assert.deepEqual(refs("class D:\n    x = 1\n    ys = [x for i in range(2)]"), ["range", "x"]);
  assert.deepEqual(refs("class D:\n    x = [1]\n    ys = [i for i in x]"), []);
  assert.deepEqual(refs("class D:\n    x = 1\n    def m(self, p=x):\n        return x"), ["x"]);
  assert.deepEqual(refs("class D:\n    def m(self, p=y):\n        return p\n    y = 5"), ["y"]);
  assert.deepEqual(refs("class D:\n    z = 1\n    del z\n    a = z"), ["z"]);
  assert.deepEqual(refs("class A[T]:\n    def hello(self, x: T) -> T:\n        T"), []);
  assert.deepEqual(refs("y += 4"), ["y"]);
  assert.deepEqual(refs("def f():\n    return x\nx = 0"), []);
  assert.deepEqual([...(analyzeCell("try:\n    1 // 0\nexcept ZeroDivisionError as x:\n    pass").unbinds ?? [])], ["x"]);
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
