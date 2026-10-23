import test from "node:test";
import assert from "node:assert/strict";

// Sage's display (lib/sage_all.py: matrices side by side, dicts with their
// keys sorted) is for Sage code only: Sage code calls its own hook
// (__pyjs_sage_displayhook__, src/compile.ts), which sage_all sets. Before,
// sage_all replaced the hook all code calls, for the whole process, so once
// a Sage cell had run, Python cells in every session showed Sage's display:
// a dict sorted, and a dict inside itself a RecursionError.

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string, sage = false) => {
    const n = ++id;
    await s.handle({ id: n, code, sage });
    const of = (stream: string) => msgs.filter((m) => m.id === n && m.stream === stream).map((m) => m.text).join("");
    return { out: of("stdout"), err: of("stderr") };
  };
}

const PY: [string, string][] = [
  ["{2: 1, 1: 2}", "{2: 1, 1: 2}"],
  ["D = {1: 2}\nD[3] = D\nD", "{1: 2, 3: {...}}"],
  ["[{'b': 1, 'a': 2}]", "[{'b': 1, 'a': 2}]"],
];

async function pythonCells(run: (code: string, sage?: boolean) => Promise<{ out: string; err: string }>) {
  for (const [code, want] of PY) {
    const { out, err } = await run(code);
    assert.equal(err, "", code);
    assert.equal(out, want + "\n", code);
  }
  // (a Python list's elements: each __repr__ once, not Sage's side-by-side
  // check first)
  await run("class R:\n    n = 0\n    def __repr__(self):\n        R.n += 1\n        return 'R'");
  assert.equal((await run("[R(), R()]")).out, "[R, R]\n");
  assert.equal((await run("R.n")).out, "2\n");
}

test("after a Sage cell, Python cells keep Python's display, in its session and the next", async () => {
  // (sessions in one process run one after another: the newest has the
  // streams)
  const a = await session();
  // (a Sage cell first: sage_all loaded, its display set)
  assert.equal((await a("{2: 1, 1: 2}", true)).out, "{1: 2, 2: 1}\n");
  await pythonCells(a);
  // (Sage cells keep Sage's)
  assert.equal((await a("{'b': 1, 'a': 2}", true)).out, "{'a': 2, 'b': 1}\n");
  const b = await session();
  await pythonCells(b);
  assert.equal((await b("{2: 1, 1: 2}", true)).out, "{1: 2, 2: 1}\n");
  assert.equal((await b("{2: 1, 1: 2}")).out, "{2: 1, 1: 2}\n");
});

test("a Sage cell shows a dict inside itself as {...}, sorted, not a RecursionError", async () => {
  const run = await session();
  const { out, err } = await run("D = {2: 1}\nD[1] = D\nD", true);
  assert.equal(err, "");
  assert.equal(out, "{1: {...}, 2: 1}\n");
  const nested = await run("E = {2: {4: 0, 3: 0}}\nE[2][1] = E\nE", true);
  assert.equal(nested.err, "");
  assert.equal(nested.out, "{2: {1: {...}, 3: 0, 4: 0}}\n");
});
