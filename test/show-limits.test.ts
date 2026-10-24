// LIMIT-SHOW87-1/2 (daybreak2, PR #87): show() and latex() are built within
// one display's budget, the one the text of a value already has
// (lib/_display_budget.py, LIMIT-PR57-1): every piece is charged (steps and
// characters) before it is added, a list is walked to the length it had
// when the walk began, a container inside itself or nested past the
// recursion depth raises RecursionError (as Sage's latex()), and past the
// budget MemoryError is raised before the output exists: no display is
// posted, and the session goes on.  The limits are lowered here to keep the
// test short (2000 steps, 65536 characters), and restored after.
import test from "node:test";
import assert from "node:assert/strict";

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code, sage: true });
    const mine = msgs.filter((m) => m.id === n);
    return {
      out: mine.filter((m) => m.stream === "stdout").map((m) => m.text).join(""),
      err: mine.filter((m) => m.stream === "stderr").map((m) => m.text).join(""),
      displays: mine.filter((m) => m.display).length,
    };
  };
}

const LIMIT = /MemoryError: displaying this value takes more than Sagebrush's limit of 2000 steps or 65536 characters/;

test("show() and latex() stay within the display's budget; the session goes on", async () => {
  const run = await session();
  await run("import _display_budget as B\nSAVED = dict(B.LIMITS)\nB.LIMITS['steps'] = 2000\nB.LIMITS['chars'] = 1 << 16");

  // a _latex_ that adds to its list: followed, as before (CORR-SHOW87-1):
  // a finite addition is rendered whole, as Sage renders it; endless
  // growth meets the budget and is refused, never a partial rendering
  let r = await run("class Once:\n    def _latex_(self):\n        if len(V) == 1:\n            V.append(2)\n        return 'g'\nV = [Once()]\nprint(latex(V))");
  assert.equal(r.err, "");
  assert.equal(r.out, "\\left[g, 2\\right]\n");
  r = await run("class Grow:\n    def _latex_(self):\n        W.append(Grow())\n        return 'g'\nW = [Grow()]\nshow(W)");
  assert.match(r.err, LIMIT);
  assert.equal(r.displays, 0);

  // a _latex_ that returns a number, and list subclasses with their own
  // __iter__ or __getitem__: as before (CORR-SHOW87-2/3)
  r = await run([
    "class Seven:\n    def _latex_(self):\n        return 7",
    "class IterList(list):\n    def __iter__(self):\n        return iter([7, 8])",
    "class IndexList(list):\n    def __getitem__(self, i):\n        return 99",
    "print(latex(Seven()), latex([Seven()]), latex(IterList([1])), latex(IndexList([1, 2])))",
  ].join("\n"));
  assert.equal(r.err, "");
  assert.equal(r.out, "7 \\left[7\\right] \\left[7, 8\\right] \\left[1, 2\\right]\n");

  // one past the step budget (2 steps an entry, 1 the list), and the characters'
  // (32 charged beside the string's own, for the brackets, a separator and
  // \\text{\\texttt{}}: 3 more than the 29 they take, a conservative charge)
  r = await run("print(len(latex(list(range(999)))))");
  assert.equal(r.err, "");
  r = await run("latex(list(range(1000)))");
  assert.match(r.err, LIMIT);
  r = await run("print(len(latex(['x' * 65504])))");
  assert.equal(r.out, "65533\n");
  r = await run("latex(['x' * 65505])");
  assert.match(r.err, LIMIT);

  // a string of several lines, charged whole at its exact length before any
  // line of it is made (LIMIT-SHOW87-3): lines of 100 characters cost 119
  // each and the array 26 (550 lines: 65476, at the limit; 551 over); many
  // short lines one step each (2000 at the limit, 2001 over); a string of
  // newlines only (1999 newlines: 2000 lines)
  r = await run("s = '\\n'.join(['y' * 100] * 550)\nprint(len(latex(s)))");
  assert.equal(r.err, "");
  assert.equal(r.out, "65476\n");
  r = await run("latex('\\n'.join(['y' * 100] * 551))");
  assert.match(r.err, LIMIT);
  r = await run("print(len(latex('\\n'.join(['a'] * 2000))))");
  assert.equal(r.out, String(20 * 2000 + 26) + "\n");
  r = await run("latex('\\n'.join(['a'] * 2001))");
  assert.match(r.err, LIMIT);
  r = await run("print(len(latex('\\n' * 1999)))");
  assert.equal(r.out, String(29 + 3 * 1999) + "\n");
  r = await run("latex('\\n' * 2000)");
  assert.match(r.err, LIMIT);
  r = await run("show('\\n' * 2000)");
  assert.match(r.err, LIMIT);
  assert.equal(r.displays, 0);

  // show() past the budget: refused before its display exists; at the budget, shown
  r = await run("class Big:\n    def __repr__(self):\n        return 'b' * 100\nshow([Big()] * 1000)");
  assert.match(r.err, LIMIT);
  assert.equal(r.displays, 0, "no display is posted past the budget");
  assert.equal(r.out, "");
  r = await run("show([Big()] * 100)");
  assert.equal(r.err, "");
  assert.equal(r.displays, 1);

  // a dict whose _latex_ adds a key: the iterator's RuntimeError
  r = await run("class Key:\n    def _latex_(self):\n        D[len(D)] = Key()\n        return 'k'\nD = {0: Key()}\nlatex(D)");
  assert.match(r.err, /RuntimeError: dictionary changed size during iteration/);

  // a container inside itself, and nesting past the depth: RecursionError, as Sage
  r = await run("L = [1]\nL.append(L)\nlatex(L)");
  assert.match(r.err, /RecursionError: maximum recursion depth exceeded/);
  r = await run("M = []\nfor _ in range(5000):\n    M = [M]\nshow(M)");
  assert.match(r.err, /RecursionError: maximum recursion depth exceeded/);
  assert.equal(r.displays, 0);

  // the session goes on, and a new display starts a new count
  r = await run("show(2/3)\nprint(1 + 1)");
  assert.equal(r.err, "");
  assert.equal(r.displays, 1);
  assert.equal(r.out, "2\n");
  r = await run("B.LIMITS.update(SAVED)\nprint(B.LIMITS)");
  assert.equal(r.out, "{'steps': 8388608, 'chars': 67108864}\n");
});
