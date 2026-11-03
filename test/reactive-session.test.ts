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
  { name: "daybreak3's #3: a function reading a name redefined later", cells: ["x = 1", "def f():\n    return x", "x = 2", "print(f())"] },
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

test("reactive-session: only a cell asked for runs, with its stale ancestors, not unrelated cells", async () => {
  const interp = await startInterpreter({ mode: "python", entry: CLI });
  try {
    const out = new Map<string, string>();
    const cells = [{ key: "a", code: "base = 40" }, { key: "b", code: "print('unrelated')" }, { key: "c", code: "print(base + 2)" }];
    const r = await runCells(interp, cells, { mode: "python", seedOf: () => "0".repeat(64), timeoutMs: 20_000, only: ["c"], onMessage: (k, m) => { if (m.stream === "stdout") out.set(k, (out.get(k) ?? "") + m.text); } });
    assert.equal(out.get("c"), "42\n");
    assert.equal(out.get("b"), undefined, "the unrelated cell wasn't run");
    assert.equal(r.reactive.outcome.get("a"), "ok", "its ancestor ran first");
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
