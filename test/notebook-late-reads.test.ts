import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NotebookGraph, cycleText, type CycleStep } from "../src/notebook-graph";
import { analyzeCell } from "../src/dataflow";

// William's B1 (Nov 2): a name read only inside a function's or method's
// body is read when the function is called, not when its cell runs, so it
// doesn't order cells; a cell calling another cell's function is ordered
// after what that function reads. And a real cycle's message names the names.
const build = (cells: string[], opts: { strict?: boolean; mode?: "python" | "sage" } = {}) =>
  new NotebookGraph(cells.map((code, i) => ({ id: `c${i}`, code })), { strict: opts.strict, analyze: (code, id) => analyzeCell(code, id, opts) });
const label = (id: string) => `cell ${Number(id.slice(1)) + 1}`;
const cycle = (g: NotebookGraph, id: string) => g.errors.get(id)?.find((e) => e.kind === "cycle") as { cells: string[]; path?: CycleStep[] } | undefined;

test("B1's notebook (test/b1_cycle.ipynb, Sage): np read in a method's body is no cycle; cell 1 runs first", () => {
  const nb = JSON.parse(readFileSync(__dirname + "/../../test/b1_cycle.ipynb", "utf8"));
  const cells = nb.cells.filter((c: any) => c.cell_type === "code").map((c: any) => [].concat(c.source).join(""));
  const g = build(cells, { mode: "sage" });
  assert.equal(g.errors.size, 0, JSON.stringify([...g.errors]));
  assert.deepEqual(g.order(g.ids), ["c0", "c1"]);
  // (np, and Sage's RealNumber of the preparsed 0. and 1.: read when _cdf is called)
  assert.deepEqual([...g.analysis("c0")!.late!].sort(), ["RealNumber", "np"]);
  // (marimo's analysis, strict, still has the cycle)
  const s = build(cells, { mode: "sage", strict: true });
  assert.deepEqual(cycle(s, "c0")?.cells, ["c0", "c1"]);
});

test("what runs when the cell runs still orders: top-level code, class bodies, defaults, decorators", () => {
  for (const [code, why] of [
    ["x = np.pi", "top level"],
    ["class K:\n    v = np.pi", "a class body"],
    ["def f(v=np.pi):\n    return v", "a default"],
    ["@np.vectorize\ndef f(v):\n    return v", "a decorator"],
    ["class K(np.ndarray):\n    pass", "a base"],
    ["ys = [np.sqrt(k) for k in range(3)]", "a comprehension"],
    ["ys = sorted(range(3), key=lambda k: np.sin(k))", "a top-level lambda (mostly called at once, or given to a call)"],
  ]) {
    const g = build([code, "import numpy as np\nprint(f, K) if False else None\nz = " + (code.includes("def f") ? "f" : code.includes("class K") ? "K" : code.startsWith("ys") ? "ys" : "x")]);
    assert.deepEqual(cycle(g, "c0")?.cells, ["c0", "c1"], why);
  }
});

test("a function called by its own cell's top-level code reads its names now", () => {
  const g = build(["def f():\n    return y\nz = f()", "y = 1"]);
  assert.equal(g.errors.size, 0);
  assert.deepEqual(g.order(g.ids), ["c1", "c0"]);
  // (a class instantiated at the top level: its methods may run)
  const h = build(["class G:\n    def __init__(self):\n        self.v = y\ng = G()", "y = 1"]);
  assert.deepEqual(h.order(h.ids), ["c1", "c0"]);
  // (not called: no edge, so the page order)
  const k = build(["def f():\n    return y", "y = 1"]);
  assert.deepEqual(k.order(k.ids), ["c0", "c1"]);
  assert.deepEqual([...k.parents("c0")], []);
});

test("a cell using another cell's function runs after the definers of what it reads when called", () => {
  const g = build(["def f():\n    return g() + y", "def g():\n    return w", "print(f())", "y = 2", "w = 3"]);
  assert.equal(g.errors.size, 0);
  const order = g.order(g.ids);
  for (const before of ["c0", "c1", "c3", "c4"]) assert.ok(order.indexOf(before) < order.indexOf("c2"), `${before} before c2: ${order}`);
  // (and so a function whose late read comes from the caller's own reader is a real cycle)
  const h = build(["def f():\n    return y", "y = 1\nprint(f())", "q = y"]);
  assert.equal(h.errors.size, 0);
  const c = build(["def f():\n    return y", "v = f()", "y = v"]);
  assert.deepEqual(cycle(c, "c1")?.cells, ["c1", "c2"]);
  assert.equal(
    cycleText(cycle(c, "c1")!, label),
    "This cell is in a cycle:\n  cell 2 -> v -> cell 3\n  cell 3 -> y (used by f) -> cell 2\nTo resolve it, compute one of v and y without the others: a value can't depend on itself.",
  );
});

test("a real cycle's message: one line per link (as marimo's), then the concrete fix", () => {
  const g = build(["x = y + 1", "y = 2 * x"]);
  assert.deepEqual(cycle(g, "c0")?.path, [
    { from: "c0", to: "c1", kind: "uses", name: "x", def: "x = y + 1", defKind: "value" },
    { from: "c1", to: "c0", kind: "uses", name: "y", def: "y = 2 * x", defKind: "value" },
  ]);
  assert.equal(
    cycleText(cycle(g, "c0")!, label),
    "This cell is in a cycle:\n  cell 1 -> x -> cell 2\n  cell 2 -> y -> cell 1\nTo resolve it, compute one of x and y without the others: a value can't depend on itself.",
  );
  // (an import: move it, or repeat it)
  const h = build(["x = np.pi", "import numpy as np\ny = x"]);
  assert.equal(
    cycleText(cycle(h, "c0")!, label),
    "This cell is in a cycle:\n  cell 1 -> x -> cell 2\n  cell 2 -> np -> cell 1\nTo resolve it, move `import numpy as np` into a cell of its own above cell 1, or add it to cell 1 too (the same import may be in several cells).",
  );
  // (William's notebook under marimo's analysis, which keeps the cycle: the message he'd see)
  const nb = JSON.parse(readFileSync(__dirname + "/../../test/b1_cycle.ipynb", "utf8"));
  const w = build(nb.cells.map((c: any) => [].concat(c.source).join("")), { mode: "sage", strict: true });
  assert.equal(
    cycleText(cycle(w, "c1")!, label),
    "This cell is in a cycle:\n  cell 1 -> deterministic_gen -> cell 2\n  cell 2 -> np -> cell 1\nTo resolve it, move `import numpy as np` into a cell of its own above cell 1, or add it to cell 1 too (the same import may be in several cells).",
  );
  // (a def: it can move, its body read only when called; three items on a board)
  const k = build(["a = b", "b = c", "c = a"]);
  assert.equal(
    cycleText(cycle(k, "c0")!, (id) => `item ${Number(id.slice(1)) + 1}`, (n) => n, "item"),
    "This item is in a cycle:\n  item 1 -> a -> item 3\n  item 3 -> c -> item 2\n  item 2 -> b -> item 1\nTo resolve it, compute one of a, c and b without the others: a value can't depend on itself.",
  );
  const d = build(["class K(Base):\n    pass", "class Base:\n    k = K"]);
  assert.match(cycleText(cycle(d, "c0")!, label), /move `class K\(Base\):` \(with its body\) out of cell 1, into a cell of its own above cell 2\.$/);
  // (only the cells on the cycle have the error)
  const e = build(["x = y", "y = x", "z = 1"]);
  assert.deepEqual([...e.errors.keys()], ["c0", "c1"]);
});
