import test from "node:test";
import assert from "node:assert/strict";
import { Reactive, SCOPE_SEP, type CellInfo, type CellState } from "../src/notebook-reactive";
import { analyzeCell } from "../src/dataflow";
import { renameRedefinitions } from "../src/rename";

// The reactive scheduler (src/notebook-reactive.ts) with a toy interpreter:
// running a cell sets the names it defines (to "cell@n") after checking the
// ones it reads are there or builtins (else NameError); `raise`
// raises; `# 3000 ms` says how long it takes.

const BUILTINS = new Set(["print", "range", "len"]);

function notebook(codes: string[], manual: number[] = [], scoped = false) {
  let cells: CellInfo[] = codes.map((code, i) => ({ id: `c${i}`, code, manual: manual.includes(i) }));
  const globals = new Map<string, string>();
  const states = new Map<string, CellState>();
  const log: string[] = [];
  let n = 0;
  const r = new Reactive({
    cells: () => cells,
    analyze: async (code) => {
      try {
        return analyzeCell(code);
      } catch (e: any) {
        return { error: { kind: e.name === "ImportStarError" ? "import-star" : "syntax", message: e.message } };
      }
    },
    execute: async (id, code, forget) => {
      for (const k of forget) globals.delete(k);
      log.push(id);
      const a = analyzeCell(code);
      const ms = +(/# (\d+) ms/.exec(code)?.[1] ?? 1);
      for (const ref of a.refs) if (!BUILTINS.has(ref) && !globals.has(ref)) return { ok: false, ms };
      if (/\braise\b/.test(code)) return { ok: false, ms };
      for (const d of a.defs) globals.set(d, `${id}@${++n}`);
      return { ok: true, ms };
    },
    forget: async (names) => {
      for (const k of names) globals.delete(k);
      log.push("forget:" + [...names].sort().join(","));
    },
    status: (id, s) => states.set(id, s),
    ...(scoped ? { rename: async (q: any) => { const r = renameRedefinitions(q.cells, q.name, new Set(q.taken), "python", SCOPE_SEP); return r ? [...r] : null; } } : {}),
  });
  return {
    r, globals, states, log,
    set(i: number, code: string) { cells[i] = { ...cells[i], code }; },
    del(i: number) { const id = cells[i].id; cells = cells.filter((_, j) => j !== i); return id; },
    move(i: number, j: number) { const c = cells.splice(i, 1)[0]; cells.splice(j, 0, c); },
  };
}

test("running a cell runs its descendants, in order", async () => {
  const nb = notebook(["a = 1", "b = a + 1", "c = b + 1", "print(a)"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  assert.deepEqual([...nb.r.stale].sort(), ["c0", "c1", "c2", "c3"]);
  const rep = await nb.r.run(["c0"]);
  assert.deepEqual(rep.ran, ["c0", "c1", "c2", "c3"]);
  assert.equal(nb.r.stale.size, 0);
  // a definition below its use runs first
  const nb2 = notebook(["print(y)", "y = 1"]);
  await nb2.r.load();
  assert.deepEqual((await nb2.r.run(["c0"])).ran, ["c1", "c0"]);
});

test("lazy (budget 0): descendants go stale; running one runs its stale ancestors", async () => {
  const nb = notebook(["a = 1", "b = a + 1", "c = b + 1"]);
  nb.r.budget = 0;
  await nb.r.load();
  assert.deepEqual((await nb.r.run(["c0"])).ran, ["c0"]);
  assert.deepEqual([...nb.r.stale].sort(), ["c1", "c2"]);
  assert.deepEqual((await nb.r.run(["c2"])).ran, ["c1", "c2"]);
  assert.equal(nb.r.stale.size, 0);
});

test("the budget: a slow descendant waits, with what is below it", async () => {
  const nb = notebook(["a = 1", "b = a + 1  # 3000 ms", "c = b + 1", "d = a"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.run(["c0"]);
  nb.r.budget = 2000;
  const rep = await nb.r.run(["c0"]);
  // the cheap one runs; the slow one waits, with the one below it
  assert.deepEqual(rep.ran, ["c0", "c3"]);
  assert.deepEqual(rep.stale.sort(), ["c1", "c2"]);
  assert.equal(nb.r.staleSummary().ms, 3001);
  assert.deepEqual(nb.states.get("c1"), { state: "stale", why: "budget" });
  assert.deepEqual(nb.states.get("c2"), { state: "stale", why: "ancestor" });
  // an explicit run of what is stale
  assert.deepEqual((await nb.r.run(["c2"])).ran, ["c1", "c2"]);
});

test("an exception cancels the descendants; they wait for it", async () => {
  const nb = notebook(["a = 1", "b = a\nraise", "c = b", "d = a"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  const rep = await nb.r.run(["c0"]);
  assert.deepEqual(rep.ran, ["c0", "c1", "c3"]);
  assert.deepEqual(rep.failed, ["c1"]);
  assert.deepEqual(rep.cancelled, ["c2"]);
  assert.deepEqual(nb.states.get("c2"), { state: "cancelled", by: "c1", why: "exception" });
  // running it later still waits for the failed cell
  assert.deepEqual((await nb.r.run(["c2"])).cancelled, ["c2"]);
  nb.set(1, "b = a");
  assert.deepEqual((await nb.r.run(["c1"])).ran, ["c1", "c2"]);
});

test("a second definition is an error on the new cell, not the old one (no action at a distance)", async () => {
  const nb = notebook(["x = 1", "y = x + 1", "pass"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.run(["c0"]);
  nb.set(2, "x = 2");
  const rep = await nb.r.run(["c2"]);
  assert.deepEqual(Object.keys(rep.errors), ["c2"]);
  assert.equal(nb.globals.get("x")?.startsWith("c0@"), true);
  assert.equal(nb.r.errors.has("c1"), false);
  // running the reader now: x is ambiguous
  assert.deepEqual((await nb.r.run(["c1"])).errors.c1, [{ kind: "multiple-definition", name: "x", cells: ["c0", "c2"], reading: true }]);
  // running the old cell again submits it: then both definers have the error (as in marimo)
  assert.deepEqual(Object.keys((await nb.r.run(["c0"])).errors).sort(), ["c0", "c1", "c2"]);
  // the fix: the new cell defines something else; both errors go, and the old cell and its reader rerun
  nb.set(2, "x2 = 2");
  const fixed = await nb.r.run(["c2"]);
  assert.deepEqual(fixed.errors, {});
  assert.deepEqual(fixed.ran, ["c0", "c1", "c2"]);
});

test("#1477: write-only names may be defined by several cells; a reader makes it an error", async () => {
  const nb = notebook(["for i in range(3):\n    pass", "for i in range(5):\n    pass", "pass"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  assert.deepEqual((await nb.r.run(["c0", "c1"])).errors, {});
  // the cell that starts reading it has the error; the definers stay valid
  nb.set(2, "print(i)");
  const rep = await nb.r.run(["c2"]);
  assert.deepEqual(Object.keys(rep.errors), ["c2"]);
  assert.deepEqual(rep.errors.c2, [{ kind: "multiple-definition", name: "i", cells: ["c0", "c1"], reading: true }]);
  // deleting one definer: the other is the only one, and reruns
  const gone = nb.del(1);
  const rep2 = await nb.r.remove([gone]);
  assert.deepEqual(rep2.errors, {});
  assert.deepEqual(rep2.ran, ["c0", "c2"]);
});

test("deleting a cell deletes its names; its readers rerun and fail", async () => {
  const nb = notebook(["a = 1", "b = a"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.run(["c0"]);
  const rep = await nb.r.remove([nb.del(0)]);
  assert.equal(nb.globals.has("a"), false);
  assert.deepEqual(rep.ran, ["c1"]);
  assert.deepEqual(rep.failed, ["c1"]);
});

test("a definition removed from a cell's code disappears", async () => {
  const nb = notebook(["a = 1\nz = 5", "print(z)"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.run(["c0"]);
  assert.equal(nb.globals.has("z"), true);
  nb.set(0, "a = 1");
  const rep = await nb.r.run(["c0"]);
  assert.equal(nb.globals.has("z"), false);
  // its old reader reran (it was a child of the old code) and fails
  assert.deepEqual(rep.ran, ["c0", "c1"]);
  assert.deepEqual(rep.failed, ["c1"]);
});

test("manual cells never run automatically, nor what is below them", async () => {
  const nb = notebook(["a = 1", "b = a", "c = b", "d = a"], [1]);
  nb.r.budget = Infinity;
  await nb.r.load();
  const rep = await nb.r.run(["c0"]);
  assert.deepEqual(rep.ran, ["c0", "c3"]);
  assert.deepEqual(rep.stale.sort(), ["c1", "c2"]);
  assert.deepEqual(nb.states.get("c1"), { state: "stale", why: "manual" });
  // run explicitly
  assert.deepEqual((await nb.r.run(["c2"])).ran, ["c1", "c2"]);
});

test("ties follow the page order", async () => {
  const nb = notebook(["a = 1", "print(a, 1)", "print(a, 2)"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  assert.deepEqual((await nb.r.run(["c0"])).ran, ["c0", "c1", "c2"]);
  nb.move(2, 1);
  nb.r.reordered();
  assert.deepEqual((await nb.r.run(["c0"])).ran, ["c0", "c2", "c1"]);
});

test("cycles and syntax errors", async () => {
  const nb = notebook(["a = b", "b = a", "x = (", "c = 1"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  const rep = await nb.r.runAll();
  assert.deepEqual(Object.keys(rep.errors).sort(), ["c0", "c1", "c2"]);
  assert.deepEqual(rep.ran, ["c3"]);
});

test("mutation tracking: an updater runs with its family, and the readers after it", async () => {
  const nb = notebook(["v = [1]", "print(len(v))", "v.append(2)", "v.append(3)", "w = 1"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  // the reader runs after the updaters, though it is above them
  assert.deepEqual((await nb.r.run(["c0"])).ran, ["c0", "c2", "c3", "c1"]);
  // running one updater reruns the definer and every updater (never appending twice), then the reader
  assert.deepEqual((await nb.r.run(["c3"])).ran, ["c0", "c2", "c3", "c1"]);
  // deleting an updater undoes its mutation: the family reruns
  assert.deepEqual((await nb.r.remove([nb.del(2)])).ran, ["c0", "c3", "c1"]);
  // an updater's code changed to mutate nothing: the same
  nb.set(2, "pass");
  assert.deepEqual((await nb.r.run(["c3"])).ran, ["c0", "c1", "c3"]);
});

test("page-order scoping: a cell reads the nearest definition above it", async () => {
  const nb = notebook(["x = 1", "y = x", "x = 2", "z = x", "w = x + y"], [], true);
  nb.r.budget = Infinity;
  await nb.r.load();
  const rep = await nb.r.runAll();
  assert.deepEqual(rep.errors, {});
  assert.equal(nb.r.effective("c2"), "x\u02b92 = 2");
  assert.equal(nb.r.effective("c4"), "w = x\u02b92 + y");
  assert.equal(nb.r.submitted("c2"), "x = 2");
  // y read the first x; z and w the second
  assert.ok(nb.globals.get("y")!.startsWith("c1@"));
  assert.ok(nb.globals.has("x") && nb.globals.has("x\u02b92"));
  // editing the first definition reruns only what reads it
  nb.set(0, "x = 10");
  assert.deepEqual((await nb.r.run(["c0"])).ran, ["c0", "c1", "c4"]);
  // deleting the second definition: the cells below now read the first, and rerun
  const gone = nb.del(2);
  const r2 = await nb.r.remove([gone]);
  assert.equal(nb.r.effective("c3"), "z = x");
  assert.deepEqual(r2.ran.sort(), ["c3", "c4"]);
  assert.equal(nb.globals.has("x\u02b92"), false);
});

test("page-order scoping: moving a definition changes what the cells below read", async () => {
  const nb = notebook(["x = 1", "x = 2", "print(x)"], [], true);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  assert.equal(nb.r.effective("c2"), "print(x\u02b92)");
  nb.move(1, 2); // x = 1, print(x), x = 2
  const rep = await nb.r.reordered();
  assert.equal(nb.r.effective("c2"), "print(x)");
  assert.ok(rep.ran.includes("c2"));
});
