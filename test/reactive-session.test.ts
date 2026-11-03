import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startInterpreter, runCells, type Interpreter } from "../src/reactive-session";

// src/reactive-session.ts (plan L1b r4b, step 2a): a document's code run as the reactive notebook runs it, in one
// interpreter. Until `sagebrush board run` adopts it (step 2c), the shared semantics fixtures run through BOTH hosts,
// this one and board run's, and must give the same output in every cell (@sagebrush's condition): redefinition in
// page order, the frozen constructs (daybreak3's #3 case, decorators, defaults, class bodies, comprehensions, a stored
// nested function, an immediately called lambda), and a failure cancelling only what reads it.
const CLI = __dirname + "/../src/cli.js";
const FIXTURES: { name: string; cells: string[]; want?: string[] }[] = [
  { name: "redefinition, each reader the nearest earlier", cells: ["x = 1", "print(x)", "x = 2", "print(x)"], want: ["", "1\n", "", "2\n"] },
  // (notebook semantics, not linear: f reads the x defined above it, page-order scoping; a linear run would print 2)
  { name: "daybreak3's #3: a function reading a name redefined later", cells: ["x = 1", "def f():\n    return x", "x = 2", "print(f())"], want: ["", "", "", "1\n"] },
  { name: "a decorator", cells: ["def deco(g):\n    return lambda: g() + 1", "@deco\ndef h():\n    return 1", "print(h())"], want: ["", "", "2\n"] },
  { name: "a default argument, redefined after", cells: ["k = 3", "def g(a=k):\n    return a", "k = 4", "print(g())"] },
  { name: "a class body", cells: ["n = 5", "class C:\n    v = n", "print(C.v)"], want: ["", "", "5\n"] },
  { name: "a comprehension", cells: ["m = 2", "print([m * i for i in range(3)])"], want: ["", "[0, 2, 4]\n"] },
  { name: "a stored nested function, its name redefined after", cells: ["y = 1", "def outer():\n    def inner():\n        return y\n    return inner", "keep = outer()", "y = 9", "print(keep())"] },
  { name: "an immediately called lambda", cells: ["z = 7", "print((lambda: z)())"], want: ["", "7\n"] },
  { name: "a failure: what reads it isn't run, the rest is", cells: ["a = 1 / 0", "print(a)", "print('independent')"], want: ["", "", "independent\n"] },
];

// (through board run: one board, its items in one column, in order)
function viaBoard(cells: string[]): string[] {
  const doc = { format: "sagebrush-board", version: 1, title: "T", nodes: cells.map((code, i) => ({ id: "c" + i, x: 0, y: i * 300, w: 300, text: "", code })) };
  const r = spawnSync(process.execPath, [CLI, "board", "run", "-", "--json", "--timeout", "20"], { encoding: "utf8", input: JSON.stringify(doc), timeout: 180_000 });
  const rep = JSON.parse(r.stdout);
  return cells.map((_, i) => rep.items.find((it: any) => it.id === "c" + i)?.stdout ?? "");
}

// (through this module)
async function viaSession(interp: Interpreter, cells: string[]): Promise<{ out: string[]; failed: string[]; cancelled: string[] }> {
  const out = new Map<string, string>();
  const keys = cells.map((_, i) => "c" + i);
  // (each fixture in its own names: the interpreter is shared, the cells' keys are not)
  const tag = "f" + Math.random().toString(36).slice(2, 8);
  const r = await runCells(interp, cells.map((code, i) => ({ key: tag + keys[i], code })), {
    mode: "python", seedOf: (k) => "0".repeat(64) + k, timeoutMs: 20_000,
    onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + String(m.text ?? "")); },
  });
  return { out: keys.map((k) => out.get(tag + k) ?? ""), failed: [...r.failed], cancelled: [...r.cancelled] };
}

test("reactive-session: the shared semantics fixtures give the same output through board run and this module", async () => {
  // (a fresh interpreter for each fixture, as board run has: names don't carry from one fixture to the next)
  for (const f of FIXTURES) {
    const interp = await startInterpreter({ mode: "python", entry: CLI });
    try {
      assert.equal(interp.dead(), null, "the interpreter started: " + interp.err.join(""));
      const mine = await viaSession(interp, f.cells), theirs = viaBoard(f.cells);
      assert.deepEqual(mine.out, theirs, `${f.name}: the same output in each cell as board run's`);
      if (f.want) assert.deepEqual(mine.out, f.want, `${f.name}: the expected output`);
    } finally { await interp.close(); }
  }
});

test("reactive-session: only a cell asked for runs, with its stale ancestors; not unrelated cells, not its descendants", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const out = new Map<string, string>();
    const cells = [{ key: "a", code: "base = 40" }, { key: "b", code: "print('unrelated')" }, { key: "c", code: "total = base + 2\nprint(total)" }, { key: "d", code: "print('descendant', total)" }];
    const r = await runCells(interp, cells, { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 20_000, only: ["c"], onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + m.text); } });
    assert.equal(out.get("c"), "42\n");
    assert.equal(out.get("b"), undefined, "the unrelated cell wasn't run");
    assert.equal(r.reactive.outcome.get("a"), "ok", "its ancestor ran first");
    assert.equal(out.get("d"), undefined, "its descendant wasn't run (the default budget is 0)");
    assert.equal(r.reactive.outcome.has("d"), false);
  } finally { await interp.close(); }
});

test("reactive-session: the editor's Run: N, its ancestors, then its descendants within the budget; a slower one left stale", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const out = new Map<string, string>();
    const cells = [{ key: "a", code: "base = 40" }, { key: "c", code: "total = base + 2" }, { key: "fast", code: "print('fast', total)" }, { key: "slow", code: "print('slow', total)" }];
    // (their last measured times: fast 10 ms, slow 5 s, over a 2 s budget)
    const r = await runCells(interp, cells, { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 20_000, only: ["c"], descendantsWithinMs: 2000, lastMs: new Map([["fast", 10], ["slow", 5000]]), onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + m.text); } });
    assert.equal(r.reactive.outcome.get("a"), "ok", "its ancestor ran");
    assert.equal(out.get("fast"), "fast 42\n", "a descendant within the budget ran");
    assert.equal(out.get("slow"), undefined, "a descendant over the budget didn't run");
    assert.equal(r.states.get("slow")?.state, "stale", "…and is stale");
  } finally { await interp.close(); }
});

test("reactive-session: the editor's Run: an optional descendant out of time stays stale; independent ones after it still run (daybreak3's DB3-RS-3)", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const out = new Map<string, string>();
    const cells = [{ key: "root", code: "r = 1" }, { key: "slow", code: "import time\nwhile True:\n    time.sleep(0.05)\ns = r" }, { key: "afterslow", code: "print('reads slow', s)" }, { key: "fast", code: "print('fast', r)" }];
    const r = await runCells(interp, cells, { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 1000, only: ["root"], descendantsWithinMs: 5000, lastMs: new Map([["slow", 1], ["afterslow", 1], ["fast", 1]]), onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + m.text); } });
    assert.ok(r.timedOut.has("slow"), "the slow descendant ran out of time");
    assert.equal(out.get("fast"), "fast 1\n", "the independent descendant after it still ran");
    assert.equal(out.get("afterslow"), undefined, "what reads the slow one didn't");
    assert.equal(interp.dead(), null);
  } finally { await interp.close(); }
});

test("reactive-session: the editor's Run: one budget for the whole Run, retries included (daybreak3's DB3-RS-3)", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const out = new Map<string, string>();
    // (before 3000 ms and after 3000 ms can't both fit 5000 ms: before runs, slow (1 ms) runs out of time, after is left)
    const cells = [{ key: "root", code: "r = 1" }, { key: "before", code: "print('before', r)" }, { key: "slow", code: "import time\nwhile True:\n    time.sleep(0.05)\ns = r" }, { key: "after", code: "print('after', r)" }];
    const r = await runCells(interp, cells, { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 1000, only: ["root"], descendantsWithinMs: 5000, lastMs: new Map([["before", 3000], ["slow", 1], ["after", 3000]]), onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + m.text); } });
    assert.equal(out.get("before"), "before 1\n");
    assert.ok(r.timedOut.has("slow"));
    assert.equal(out.get("after"), undefined, "after didn't run: the budget was spent");
  } finally { await interp.close(); }
});

test("reactive-session: a cell over its time is interrupted; what reads it isn't run; others are", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const out = new Map<string, string>();
    const cells = [{ key: "slow", code: "import time\nwhile True:\n    time.sleep(0.05)\nv = 1" }, { key: "reads", code: "print(v)" }, { key: "other", code: "print('ran')" }];
    const r = await runCells(interp, cells, { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 1000, onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + m.text); } });
    assert.ok(r.timedOut.has("slow"));
    assert.equal(out.get("reads"), undefined);
    assert.equal(out.get("other"), "ran\n");
    assert.equal(interp.dead(), null, "interrupted, not killed");
  } finally { await interp.close(); }
});

test("reactive-session: a cycle is the notebook's error, in the document's word for its cells", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const r = await runCells(interp, [{ key: "p", code: "a = b + 1" }, { key: "q", code: "b = a + 1" }], { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 5000, noun: "block", label: (k) => "block " + k, onMessage: () => {} });
    assert.match(r.errors.get("p") ?? "", /block p and block q depend on each other in a cycle/);
  } finally { await interp.close(); }
});
