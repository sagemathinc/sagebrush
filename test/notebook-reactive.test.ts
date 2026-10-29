import test from "node:test";
import assert from "node:assert/strict";
import { Reactive, SCOPE_SEP, setTestHooks, type CellInfo, type CellState } from "../src/notebook-reactive";
import type { CellError } from "../src/notebook-graph";
import { Budget, BUDGET } from "../src/remote-approval";
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
      for (const d of a.deleted) globals.delete(d);
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
  assert.equal(nb.r.staleSummary().untimed, 0);
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

test("an updater rerun automatically runs with its family (no change applied twice)", async () => {
  const nb = notebook(["v = []", "x = 1", "v.append(x)", "print(v)"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  nb.set(1, "x = 2");
  // x's change reaches the updater automatically: the definer of v reruns first
  assert.deepEqual((await nb.r.run(["c1"])).ran, ["c0", "c1", "c2", "c3"]);
});

test("a language change during a run waits for it (no crash)", async () => {
  const nb = notebook(["x = 1", "print(x)"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  const run = nb.r.runAll();
  const reset = nb.r.reset();
  const rep = await run;
  assert.deepEqual(rep.ran, ["c0", "c1"]);
  await reset;
  assert.deepEqual([...nb.r.stale].sort(), ["c0", "c1"]);
});

test("a cell's cancellation is inherited: run alone, a descendant still waits for the cell that raised (REACT-F12)", async () => {
  const nb = notebook(["x = 1", "y = x + 1", "print(y)"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  nb.set(0, "x = 1\nraise");
  const rep = await nb.r.run(["c0"]);
  assert.deepEqual(rep.cancelled, ["c1", "c2"]);
  const alone = await nb.r.run(["c2"]);
  assert.deepEqual(alone.cancelled, ["c2"]);
  assert.deepEqual(nb.states.get("c2"), { state: "cancelled", by: "c0", why: "exception" });
});

test("a cell run by hand that reads a deleted name runs its definer first, whatever the budget (REACT-F19)", async () => {
  const nb = notebook(["x = 5", "print(x)", "del x"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  assert.equal(nb.globals.has("x"), false);
  nb.r.budget = 0;
  const rep = await nb.r.run(["c1"]);
  assert.deepEqual(rep.ran.slice(0, 2), ["c0", "c1"]);
  assert.deepEqual(rep.failed, []);
  // an updater run by hand runs with its definer, whatever the budget
  const nb2 = notebook(["v = []", "v.append(1)", "print(v)"]);
  nb2.r.budget = Infinity;
  await nb2.r.load();
  await nb2.r.runAll();
  nb2.r.budget = 0;
  const rep2 = await nb2.r.run(["c1"]);
  assert.deepEqual(rep2.ran.slice(0, 2), ["c0", "c1"]);
});

test("the internal names' map is cleared when no cell needs renaming (REACT-3BC-18)", async () => {
  const nb = notebook(["def f(): pass", "def f(): pass", "print(f)"], [], true);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  assert.equal(nb.r.written("f\u02b92"), "f");
  // (one action: the other two cells go, the one left now uses fʹ2 itself)
  nb.set(1, "def f\u02b92(): pass");
  nb.del(2);
  nb.del(0);
  await nb.r.run(["c1"], { remove: ["c0", "c2"] });
  assert.equal(nb.r.written("f\u02b92"), "f\u02b92");
});

// Output keys and time from root (design/outputs.md)
import { createHash } from "node:crypto";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const keysOf = async (nb: ReturnType<typeof notebook>, mode = "python", seed = "s") => Object.fromEntries(await nb.r.keys({ mode, seed: (id) => seed + ":" + id, hash: sha }));

test("output keys change exactly when the cell or anything upstream does", async () => {
  const nb = notebook(["a = 1", "b = a + 1", "c = b + 1", "d = 5"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  const k0 = await keysOf(nb);
  assert.ok(Object.values(k0).every((k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k)));
  assert.equal(new Set(Object.values(k0)).size, 4);
  // the same notebook again: the same keys
  assert.deepEqual(await keysOf(nb), k0);
  // changing a: a, b, c change; d does not
  nb.set(0, "a = 2");
  await nb.r.run(["c0"]);
  const k1 = await keysOf(nb);
  for (const id of ["c0", "c1", "c2"]) assert.notEqual(k1[id], k0[id], id);
  assert.equal(k1.c3, k0.c3);
  // changing c: only c
  nb.set(2, "c = b + 2");
  await nb.r.run(["c2"]);
  const k2 = await keysOf(nb);
  assert.deepEqual([k2.c0, k2.c1, k2.c3], [k1.c0, k1.c1, k1.c3]);
  assert.notEqual(k2.c2, k1.c2);
  // the language and the seed are in every key
  const py = await keysOf(nb), sage = await keysOf(nb, "sage"), seeded = await keysOf(nb, "python", "t");
  for (const id of ["c0", "c1", "c2", "c3"]) {
    assert.notEqual(sage[id], py[id]);
    assert.notEqual(seeded[id], py[id]);
  }
});

test("output keys: a cell with an error, and what reads from it, have none", async () => {
  const nb = notebook(["a = (", "a = 1", "a = 2", "b = a + 1", "d = 5"]);
  await nb.r.load();
  const k = await keysOf(nb);
  assert.equal(k.c0, null);
  assert.equal(k.c1, null);
  assert.equal(k.c2, null);
  assert.equal(k.c3, null);
  assert.match(k.c4 ?? "", /^[0-9a-f]{64}$/);
});

test("time from root counts every cell it depends on, each once", async () => {
  // a diamond: d reads b and c, both read a
  const nb = notebook(["a = 1  # 1000 ms", "b = a  # 2000 ms", "c = a  # 3000 ms", "d = b + c  # 500 ms", "e = 1  # 7 ms"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  assert.deepEqual(nb.r.fromRoot("c3"), { ms: 0, untimed: 4 });
  await nb.r.runAll();
  assert.deepEqual(nb.r.fromRoot("c3"), { ms: 6500, untimed: 0 });
  assert.deepEqual(nb.r.fromRoot("c1"), { ms: 3000, untimed: 0 });
  assert.deepEqual(nb.r.fromRoot("c4"), { ms: 7, untimed: 0 });
});

test("cells run because a widget moved are marked, until a restart", async () => {
  const nb = notebook(["w = 1", "x = w + 1", "y = x + 1", "z = 2"]);
  nb.r.budget = Infinity;
  await nb.r.load();
  await nb.r.runAll();
  assert.equal(nb.r.widgetDriven.size, 0);
  await nb.r.namesChanged(["w"], ["c0"]);
  assert.deepEqual([...nb.r.widgetDriven].sort(), ["c1", "c2"]);
  nb.r.restarted();
  assert.equal(nb.r.widgetDriven.size, 0);
});

// --- remote approval's hooks: what the scheduler gives the host ---

function hooked(codes: string[], over: { notRun?: Map<string, "skip" | "wait">; prepare?: (p: { order: string[]; consent?: unknown; followUp: boolean }) => Promise<{ refuse?: string; skip?: Map<string, string> } | undefined>; rekey?: (units: number) => boolean; consent?: (stage: string) => void; analyze?: (code: string) => any } = {}) {
  const cells: CellInfo[] = codes.map((code, i) => ({ id: `c${i}`, code }));
  const states = new Map<string, CellState>();
  const events: string[] = [];
  const executed: { id: string; code: string; forget: string[]; scoped?: Record<string, string> }[] = [];
  const forgot: { names: string[]; cells?: string[] }[] = [];
  const r = new Reactive({
    cells: () => cells,
    analyze: async (code) => over.analyze?.(code) ?? analyzeCell(code),
    execute: async (id, code, forget, scoped) => {
      executed.push({ id, code, forget: [...forget], scoped });
      const nr = over.notRun?.get(id);
      return nr ? { ok: false, ms: 0, notRun: nr, note: `not run (${nr})` } : { ok: true, ms: 1 };
    },
    forget: async (names, cs) => {
      forgot.push({ names: [...names].sort(), cells: cs ? [...cs].sort() : undefined });
    },
    status: (id, s) => states.set(id, s),
    consent: (stage, c) => {
      events.push(`consent ${stage} ${String(c)}`);
      over.consent?.(stage);
    },
    ...(over.rekey ? { rekey: over.rekey } : {}),
    prepare: async (p) => {
      events.push(`prepare ${p.order.join(",")} consent=${String(p.consent)} followUp=${p.followUp}`);
      return over.prepare?.(p);
    },
    beginAction: () => events.push("begin"),
    endAction: () => events.push("end"),
  });
  r.budget = Infinity;
  return { r, cells, states, events, executed, forgot };
}

test("runSpec is exactly what execute passes the host; runOutput is it, frozen, the same object until the cell's own output changes", async () => {
  const h = hooked(["a = 1", "b = a + 1"]);
  await h.r.load();
  await h.r.run(["c0"]);
  for (const e of h.executed) {
    const s = h.r.runSpec(e.id)!;
    assert.deepEqual({ code: s.code, forget: s.forget, scoped: s.scoped }, { code: e.code, forget: e.forget, scoped: e.scoped ?? {} });
  }
  const o1 = h.r.runOutput("c1")!;
  assert.equal(h.r.runOutput("c1"), o1, "the same object");
  assert.ok(Object.isFrozen(o1) && Object.isFrozen(o1.forget) && Object.isFrozen(o1.scoped));
  const reg = h.r.registration("c1");
  await h.r.run(["c0"]); // (nothing in c1 changed, but the graph was registered again: a new epoch)
  assert.equal(h.r.registration("c1"), reg, "its registration is the same object");
  assert.equal(h.r.runOutput("c1"), o1, "re-derived in the new epoch, equal, so kept");
  h.cells[1] = { ...h.cells[1], code: "b = a + 2" };
  await h.r.run(["c1"]);
  assert.notEqual(h.r.registration("c1"), reg, "a new registration when its code changed");
  assert.notEqual(h.r.runOutput("c1"), o1);
  assert.equal(h.r.runOutput("c1")!.code, "b = a + 2");
});

test("runOutput: one epoch re-derive per cell, kept if equal (the counts); one edit replaces only that cell's", async () => {
  const codes = Array.from({ length: 20 }, (_, i) => `# ${"a".repeat(i + 1)}`);
  const h = hooked(codes);
  await h.r.load();
  await h.r.runAll();
  const before = codes.map((_, i) => h.r.runOutput(`c${i}`)!);
  await h.r.runAll(); // (a warm repeat: the graph is registered again)
  for (let i = 0; i < codes.length; i++) h.r.runOutput(`c${i}`);
  for (let i = 0; i < codes.length; i++) h.r.runOutput(`c${i}`); // (looked up again: no more re-derives)
  assert.deepEqual(h.r.counts, { rederives: 20, outputsKept: 20 });
  assert.ok(codes.every((_, i) => h.r.runOutput(`c${i}`) === before[i]));
  h.cells[10] = { ...h.cells[10], code: h.cells[10].code.replace("a", "b") };
  await h.r.runAll();
  for (let i = 0; i < codes.length; i++) h.r.runOutput(`c${i}`);
  assert.deepEqual(h.r.counts, { rederives: 20, outputsKept: 19 });
  assert.ok(codes.every((_, i) => (h.r.runOutput(`c${i}`) === before[i]) === (i !== 10)));
});

test("registrations are frozen, with a private read-only analysis; a new one when the text version changes, even with the same text", async () => {
  const v1 = Object.freeze({ text: "a = 1" });
  const h = hooked(["a = 1"]);
  h.cells[0] = { ...h.cells[0], version: v1 };
  await h.r.load();
  const reg = h.r.registration("c0")!;
  assert.ok(Object.isFrozen(reg));
  assert.equal(reg.version, v1);
  assert.throws(() => { (reg as any).code = "a = 2"; }, TypeError);
  assert.throws(() => (reg.analysis!.defs as any).add("z"), TypeError, "the analysis has no mutator");
  assert.throws(() => (h.r.graph.analysis("c0")!.refs as any).clear(), TypeError);
  assert.throws(() => (h.r.errors as any).set("c0", []), TypeError, "the errors: a read-only view");
  const v2 = Object.freeze({ text: "a = 1" });
  h.cells[0] = { ...h.cells[0], version: v2 };
  await h.r.run(["c0"]);
  assert.notEqual(h.r.registration("c0"), reg, "a new version: a new registration");
  assert.equal(h.r.registration("c0")!.version, v2);
  assert.equal(h.r.registration("c0")!.analysis, reg.analysis, "(not analyzed again)");
});

test("the graph's views: no mutators, frozen lists; setFiles copies; every change replaces the version", async () => {
  const h = hooked(["a = 1", "b = a + 1"]);
  await h.r.load();
  const g = h.r.graph;
  const v0 = g.version;
  assert.ok(Object.isFrozen(v0));
  for (const call of [
    () => (g.parents("c1") as any).add("x"), () => (g.children("c0") as any).delete("c1"), () => (g.errors as any).clear(),
    () => (g.definers as any).set("a", []), () => (g.updatersOf as any).set("a", []), () => (g.deletersOf as any).delete("a"),
  ]) assert.throws(call, TypeError);
  assert.throws(() => (g.definers.get("a") as string[]).push("c9"), TypeError, "a frozen list");
  const files = new Map<string, { reads: string[]; writes: string[] }>([["c0", { reads: [], writes: ["f"] }], ["c1", { reads: ["f"], writes: [] }]]);
  g.setFiles(files);
  const v1 = g.version;
  assert.notEqual(v1, v0);
  files.get("c1")!.reads.length = 0; // (the caller's map, changed afterwards)
  files.delete("c0");
  assert.equal(g.version, v1);
  assert.deepEqual(g.readersOf("f"), ["c1"], "the graph kept its own copy");
});

test("the errors are deep read-only: a filtered list (an unsubmitted cell's cycle), its entries, the status alias, and a registration's error with cells", async () => {
  const h = hooked(["x = 1", "y = x"]);
  await h.r.load();
  await h.r.run(["c0", "c1"]);
  h.cells[0] = { ...h.cells[0], code: "x = y" }; // (c0 now reads c1: a cycle, and c1 is not submitted)
  const rep = await h.r.run(["c0"]);
  const es = h.r.errors.get("c1")!;
  assert.ok(es && es.length > 0 && es.some((e) => e.kind === "cycle"), "(c1 has the cycle error)");
  const before = h.r.errors;
  const out = h.r.runOutput("c0");
  const writes: [string, () => unknown][] = [
    ["get", () => (h.r.errors.get("c1") as CellError[]).push({ kind: "syntax", message: "x" })],
    ["get, an entry", () => { (h.r.errors.get("c1")![0] as any).kind = "syntax"; }],
    ["get, an entry's cells", () => ((h.r.errors.get("c1")!.find((e) => e.kind === "cycle") as any).cells as string[]).push("q")],
    ["iteration", () => { for (const [, l] of h.r.errors) (l as CellError[]).splice(0, 1); }],
    ["values", () => { for (const l of h.r.errors.values()) (l as CellError[]).length = 0; }],
    ["forEach", () => h.r.errors.forEach((l) => (l as CellError[]).pop())],
    ["the status", () => ((h.states.get("c1") as { errors: CellError[] }).errors).push({ kind: "syntax", message: "x" })],
    ["the report", () => (rep.errors.c1 as CellError[]).push({ kind: "syntax", message: "x" })],
  ];
  for (const [what, w] of writes) assert.throws(w, TypeError, what);
  assert.equal(h.r.errors, before, "the errors view is the same");
  assert.deepEqual(h.r.errors.get("c1"), es, "and so is what it holds");
  assert.equal(h.r.runOutput("c0"), out, "the epoch is unchanged");
  // a registration's error with cells: a frozen copy, not the analyzer's object
  const cells = ["z"];
  const g = hooked(["BAD"], { analyze: (code) => (code === "BAD" ? { error: { kind: "cycle", cells } } : undefined) });
  await g.r.load();
  const e = g.r.registration("c0")!.error as { kind: "cycle"; cells: string[] };
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.cells) && e.cells !== cells);
  cells.push("q");
  assert.deepEqual(g.r.registration("c0")!.error, { kind: "cycle", cells: ["z"] }, "the analyzer's later change doesn't reach it");
  assert.throws(() => e.cells.push("q"), TypeError);
});

test("the run outputs are bounded: when full, what no action in progress uses goes; if all are in use, an output isn't kept (its identity then isn't stable: fail-closed)", async () => {
  // (lookups made in an action, from its prepare hook: each twice, to see whether the object is kept)
  let inAction: string[] = [];
  const seen: unknown[][] = [];
  const g = hooked(["a = 1", "b = 2", "c = 3", "d = 4"], { prepare: async () => { seen.push(inAction.map((id) => g.r.runOutput(id)), inAction.map((id) => g.r.runOutput(id))); return undefined; } });
  await g.r.load();
  g.r.outputsMax = 3;
  inAction = ["c0", "c1", "c2", "c3"];
  await g.r.runAll();
  const [first, second] = seen;
  assert.equal(g.r.outputsSize(), 3, "bounded");
  assert.ok(first.slice(0, 3).every((o, i) => o === second[i]), "the first three, kept: the same objects within the action");
  assert.notEqual(first[3], second[3], "the fourth, past the bound with every entry in use: not kept, a new object each time");
  inAction = ["c3"];
  seen.length = 0;
  await g.r.run(["c3"]);
  assert.equal(seen[0][0], seen[1][0], "the next action: entries it doesn't use make room, and c3 is kept");
  assert.ok(g.r.outputsSize() <= 3);
});

test("rekeyUnits: exactly at the limit, the output is kept; one unit more, a new output (never a refusal)", async () => {
  for (const over of [0, 1]) {
    const budget = new Budget();
    const h = hooked(["a = 1\nbb = 2", "z = a"], { rekey: (u: number) => (budget.fits("rekeyUnits", u) ? (budget.charge("rekeyUnits", u), true) : false) });
    await h.r.load();
    await h.r.run(["c0"]);
    const o = h.r.runOutput("c0")!;
    const units = o.forget.reduce((t, f) => t + f.length, 0);
    assert.equal(units, 3, "(forget: a, bb)");
    budget.used.rekeyUnits = BUDGET.rekeyUnits - units + over;
    await h.r.run(["c1"]); // (a new epoch for c0: re-derived and compared)
    const p = h.r.runOutput("c0")!;
    assert.equal(p === o, !over, `+${over}`);
    assert.deepEqual(p, o, "equal either way");
    assert.equal(budget.used.rekeyUnits, BUDGET.rekeyUnits - units + over + (over ? 0 : units), "charged only when compared");
  }
});

test("a registration taken for the old one, or a re-derive skipped: the output stays stale while runSpec is fresh", async () => {
  try {
    const h = hooked(["a = 1"]);
    await h.r.load();
    await h.r.run(["c0"]);
    const o = h.r.runOutput("c0")!;
    setTestHooks({ sameRegistration: () => true });
    h.cells[0] = { ...h.cells[0], code: "a = 2" };
    await h.r.run(["c0"]);
    assert.equal(h.r.runOutput("c0"), o, "the hook: the old output kept");
    assert.equal(h.r.runSpec("c0")!.code, "a = 2", "what execute is given is fresh");
    setTestHooks({ skipRederive: () => true });
    h.cells[0] = { ...h.cells[0], code: "a = 3" };
    await h.r.run(["c0"]);
    assert.equal(h.r.runOutput("c0"), o, "the hook: no re-derive");
    setTestHooks(null);
    assert.equal(h.r.runOutput("c0")!.code, "a = 3", "unhooked: re-derived");
  } finally {
    setTestHooks(null);
  }
});

test("the errors written into the old map: a lookup between registration and the errors' replacement keeps a stale forget; unhooked, re-derived", async () => {
  for (const hooked_ of [true, false]) {
    try {
      // c0 and c1 both define x (no reader: #1477), so c0's forget leaves x to c1; then a reader c2 is run
      // with c1: c1 gets the multiple-definition error (it is still a definer), c0 keeps no error
      let probe: (() => void) | null = null;
      const h = hooked(["x = 1", "x = 2"], { consent: () => probe?.() });
      await h.r.load();
      await h.r.run(["c0", "c1"]);
      assert.deepEqual(h.r.runSpec("c0")!.forget, []);
      if (hooked_) setTestHooks({ errorsInPlace: (old, fresh) => { old.clear(); for (const [k, v] of fresh) old.set(k, v); return old; } });
      probe = () => { h.r.runOutput("c0"); }; // (at the registered stage: registered, the errors not yet replaced)
      h.cells.push({ id: "c2", code: "y = x" });
      await h.r.run(["c1", "c2"], { consent: "cap" });
      assert.ok(h.r.errors.has("c1") && !h.r.errors.has("c0"), "(c1 has the error, c0 doesn't)");
      assert.deepEqual(h.r.runSpec("c0")!.forget, ["x"], "fresh: c1 has an error, so c0's x is deleted first");
      assert.deepEqual(h.r.runOutput("c0")!.forget, hooked_ ? [] : ["x"], hooked_ ? "hooked: stale" : "unhooked: re-derived");
    } finally {
      setTestHooks(null);
    }
  }
});

test("notRun: a cell not sent is stale (approval, or ancestor for a wait), not ran, failed or cancelled; what reads it is stale too", async () => {
  for (const kind of ["skip", "wait"] as const) {
    const h = hooked(["a = 1", "b = a + 1", "c = b + 1"], { notRun: new Map([["c1", kind]]) });
    await h.r.load();
    const rep = await h.r.run(["c0"]);
    assert.deepEqual(rep.ran, ["c0"], kind);
    assert.deepEqual(rep.failed, []);
    assert.deepEqual(rep.cancelled, []);
    assert.deepEqual([...rep.stale].sort(), ["c1", "c2"]);
    assert.deepEqual(h.states.get("c1"), { state: "stale", why: kind === "wait" ? "ancestor" : "approval", note: `not run (${kind})` });
    assert.equal((h.states.get("c2") as { why: string }).why, "ancestor");
    assert.deepEqual(h.executed.map((e) => e.id), ["c0", "c1"], "c2 not asked for");
  }
});

test("prepare: before anything runs, once per round; refuse: nothing is sent and every cell is stale with the note; skip: those are not sent", async () => {
  const refuse = hooked(["a = 1", "b = a + 1"], { prepare: async () => ({ refuse: "too large" }) });
  await refuse.r.load();
  const rep = await refuse.r.run(["c0"]);
  assert.deepEqual(rep.ran, []);
  assert.equal(refuse.executed.length, 0);
  assert.deepEqual(refuse.states.get("c0"), { state: "stale", why: "approval", note: "too large" });
  assert.deepEqual(refuse.states.get("c1"), { state: "stale", why: "approval", note: "too large" });
  const skip = hooked(["a = 1", "b = a + 1", "z = 3"], { prepare: async () => ({ skip: new Map([["c0", "changed"]]) }) });
  await skip.r.load();
  const rep2 = await skip.r.run(["c0", "c2"]);
  assert.deepEqual(rep2.ran, ["c2"]);
  assert.deepEqual(skip.states.get("c0"), { state: "stale", why: "approval", note: "changed" });
  assert.ok(!skip.executed.some((e) => e.id === "c0"));
});

test("consent: checked before registration and after it; prepare sees it once; each serial step is one action", async () => {
  const h = hooked(["a = 1", "b = a + 1"]);
  await h.r.load();
  h.events.length = 0;
  await h.r.run(["c0"], { consent: "cap1" });
  assert.deepEqual(h.events, ["begin", "consent beforeRegistration cap1", "consent registered cap1", "prepare c0,c1 consent=cap1 followUp=false", "end"]);
  h.events.length = 0;
  await h.r.run(["c0"]);
  assert.deepEqual(h.events, ["begin", "prepare c0,c1 consent=undefined followUp=false", "end"], "a run without consent (an agent's)");
  h.events.length = 0;
  await h.r.runAll({ consent: "cap2" });
  assert.equal(h.events.filter((e) => e.startsWith("consent")).length, 2);
  assert.ok(h.events.includes("prepare c0,c1 consent=cap2 followUp=false"));
});

test("forget: the host is told which cells defined the names", async () => {
  const h = hooked(["a = 1", "b = a + 1", "c = 3"]);
  await h.r.load();
  await h.r.run(["c0", "c1", "c2"]);
  h.cells.splice(2, 1); // (c2 deleted)
  await h.r.remove(["c2"]);
  assert.deepEqual(h.forgot.at(-1), { names: ["c"], cells: ["c2"] });
  h.cells[0] = { ...h.cells[0], code: "q = 1" }; // (c0 no longer defines a)
  await h.r.run(["c0"]);
  assert.ok(h.forgot.some((f) => f.names.includes("a") && f.cells?.includes("c0")));
});
