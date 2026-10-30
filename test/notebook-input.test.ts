import test from "node:test";
import assert from "node:assert/strict";

// input() in a notebook (src/runtime/index.ts's builtin, src/notebook-session.ts's
// stdin option; the browser worker's side is web/worker.ts).

async function session(stdin?: (req: any) => any) {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true, ...(stdin ? { stdin } : {}) });
  await s.ready;
  let id = 1000 * Math.floor(Math.random() * 1000);
  return {
    async run(code: string) {
      const n = ++id;
      await s.handle({ id: n, code });
      const out = msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join("");
      const err = msgs.filter((m) => m.id === n && m.stream === "stderr").map((m) => m.text).join("");
      return { out, err, failed: !!msgs.find((m) => m.id === n && m.done)?.error };
    },
  };
}

test("input() with no way to ask: the prompt, then EOFError, as CPython with no stdin (no longer a TypeError)", async () => {
  const s = await session();
  const r = await s.run("name = input('Your name? ')");
  assert.equal(r.out, "Your name? ");
  assert.match(r.err, /EOFError: EOF when reading a line\n$/);
  assert.doesNotMatch(r.err, /TypeError/);
  const r2 = await s.run("input()");
  assert.equal(r2.out, "");
  assert.match(r2.err, /EOFError: EOF when reading a line\n$/);
  // CPython's arity and its error
  assert.match((await s.run("input('a', 'b')")).err, /TypeError: input expected at most 1 argument, got 2\n$/);
});

test("input() asks the host: the line is returned, and the prompt with the line is the cell's output", async () => {
  const asked: any[] = [];
  const answers = ["Ada", "", "héllo wörld"];
  const s = await session((req: any) => (asked.push(req), answers.shift() ?? null));
  const r = await s.run("print('before')\nname = input('Your name? ')\nprint('hi', name)\nprint(repr(input()))\nprint(repr(input(42)))");
  assert.equal(r.failed, false, r.err);
  // (what was printed before the question came first: flushed before it was asked)
  assert.equal(r.out, "before\nYour name? Ada\nhi Ada\n\n''\n42héllo wörld\n'héllo wörld'\n");
  assert.deepEqual(asked.map((q) => q.prompt), ["Your name? ", "", "42"]);
  assert.ok(asked.every((q) => typeof q.id === "number" && q.target === null));
});

test("input() answered with end of input raises EOFError; a Stop while it waits raises KeyboardInterrupt", async () => {
  let answer: any = null;
  const s = await session(() => answer);
  const r = await s.run("x = input('? ')");
  assert.ok(r.failed);
  assert.match(r.err, /EOFError: EOF when reading a line\n$/);
  answer = { interrupted: true };
  const k = await s.run("try:\n    input('? ')\nexcept KeyboardInterrupt:\n    print('stopped')");
  assert.deepEqual(k, { out: "stopped\n", err: "", failed: false });
  // the session goes on, its variables kept
  answer = "7";
  assert.deepEqual(await s.run("n = int(input('n? '))\nprint(n * 6)"), { out: "n? 7\n42\n", err: "", failed: false });
});
