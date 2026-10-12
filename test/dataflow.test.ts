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

test("ours (not strict): marimo's analysis, plus the reads of a name's previous value that marimo does not count", () => {
  // Where we differ from marimo on purpose, as Python does (found by
  // test/fuzz-reactive.ts): what runs before the cell binds a name reads its
  // previous value (a default, a comprehension's first iterable, `x += 1`,
  // a function at the top level called before the definition below it), so
  // it is a reference.  On marimo's oracle: the same definitions and
  // deletions, and the same references plus some of names the cell defines.
  let n = 0, bare = 0, unevaluated = 0;
  // (an annotation alone, `x: int`, binds nothing: marimo counts it as a
  // definition, we do not, REACT-44C5-1)
  const annotated = (code: string) => new Set<string>((parse(code, "exec") as any).body.filter((st: any) => st._type === "AnnAssign" && !st.value && st.target._type === "Name").map((st: any) => st.target.id));
  for (const c of oracle.cases) {
    if (c.error) continue;
    const a = analyzeCell(c.code, "c1");
    const missing = (c.defs ?? []).filter((d) => !a.defs.has(d));
    const only = missing.length ? missing.filter((d) => annotated(c.code).has(d)) : [];
    if (only.length) bare++;
    assert.deepEqual([sorted(a.defs), sorted(a.deleted)], [(c.defs ?? []).filter((d) => !only.includes(d)), c.deleted], c.code);
    const extra = sorted(a.refs).filter((r) => !(c.refs ?? []).includes(r));
    // (marimo counts names in annotations Python never evaluates, in a
    // function or of a target that is not a simple name: we do not, REACT-3A97-1)
    const lost = (c.refs ?? []).filter((r) => !a.refs.has(r));
    if (lost.length) {
      unevaluated++;
      const inAnnotations = new Set<string>();
      const scan = (n: any, inAnn: boolean): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach((x) => scan(x, inAnn));
        if (n._type === "Name" && inAnn) inAnnotations.add(n.id);
        for (const k of Object.keys(n)) if (k !== "_type") scan(n[k], inAnn || (n._type === "AnnAssign" && k === "annotation"));
      };
      scan(parse(c.code, "exec"), false);
      assert.deepEqual(lost.filter((r) => !inAnnotations.has(r)), [], c.code);
    }
    assert.deepEqual(extra.filter((r) => !a.defs.has(r)), [], c.code);
    if (extra.length) n++;
  }
  assert.equal(n, 23);
  assert.equal(bare, 22);
  assert.equal(unevaluated, 2);
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
  // (a function at the top level may be called before the definition below it)
  assert.deepEqual(refs("def f():\n    return x\nx = 0"), ["x"]);
  assert.deepEqual(refs("def f():\n    def g():\n        return x\n    x = 0"), []);
  assert.deepEqual(refs("def g():\n    global h\n    h = 1"), []);
  assert.deepEqual([...(analyzeCell("try:\n    1 // 0\nexcept ZeroDivisionError as x:\n    pass").unbinds ?? [])], ["x"]);
});

test("marimo's documented examples", () => {
  const a = (code: string) => {
    const r = analyzeCell(code, "c", { strict: true });
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
