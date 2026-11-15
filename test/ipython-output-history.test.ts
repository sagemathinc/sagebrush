import test from "node:test";
import assert from "node:assert/strict";
import { startKernel } from "./kernel-harness";

// IPython's output history in a notebook and the Jupyter kernel: _, __ and ___, the last three values shown ('' at
// first), and in the kernel _N and Out[N] by execution count. The expected values are IPython 9.15's (run_cell on
// CPython 3.14): None and Out itself are not recorded; once the user assigns _ the namespace's three are left
// alone; and a blank left as ___ in an expression fails as it does there, on the empty string.

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string, extra: object = {}) => {
    const n = ++id;
    await s.handle({ id: n, code, ...extra });
    const of = (stream: string) => msgs.filter((m) => m.id === n && m.stream === stream).map((m) => m.text).join("");
    return { out: of("stdout"), err: of("stderr") };
  };
}
const lastLine = (s: string) => s.trim().split("\n").pop();

test("a notebook: _, __ and ___ are '' at first, then the last three values shown; None is not one", async () => {
  const run = await session();
  assert.equal((await run("print(repr((_, __, ___)))")).out, "('', '', '')\n");
  await run("1");
  await run("2");
  await run("None");
  await run("3");
  assert.equal((await run("print(_, __, ___)")).out, "3 2 1\n");
  // (a script's or the REPL's _ stays CPython's: the history is the notebook's only)
  assert.equal((await run("import builtins\nprint('_' in builtins.__dict__)")).out, "False\n");
});

test("a notebook: once the user assigns _, the three are left as they are", async () => {
  const run = await session();
  await run("1");
  await run("2");
  await run("_ = 'mine'");
  await run("10");
  assert.equal((await run("print(repr(_), repr(__), repr(___))")).out, "'mine' 1 ''\n");
});

test("a notebook: a blank left as ___ fails as it does in IPython, on the empty string", async () => {
  const run = await session();
  assert.equal(lastLine((await run("x = ___ * 2.5")).err), "TypeError: can't multiply sequence by non-int of type 'float'");
  assert.equal(lastLine((await run("___.upper2()")).err), "AttributeError: 'str' object has no attribute 'upper2'");
  // (and so in the reactive notebook, whose cells keep their own _-names)
  assert.equal(lastLine((await run("y = ___ + 1", { mangle: "c7" })).err), 'TypeError: can only concatenate str (not "int") to str');
});

test("the Jupyter kernel: _, __, ___, _N and Out by execution count; a silent request records nothing", async () => {
  const k = await startKernel([]);
  const bound = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("no end within 30 s: " + k.out.stderr)), 30000))]);
  try {
    assert.ok(k.started, k.out.stderr);
    const ok = async (code: string, silent = false) => {
      const r = await bound(k.exec(code, silent));
      assert.equal(r.status, "ok", `${code}: ${r.ename}: ${r.evalue}`);
      return r;
    };
    // (execution counts 1-6: the assert cell itself is 1)
    await ok("assert (_, __, ___) == ('', '', ''), (_, __, ___)");
    await ok("1");
    await ok("2");
    await ok("None");
    await ok("3");
    await ok("assert (_, __, ___) == (3, 2, 1) and (_2, _3, _5) == (1, 2, 3) and sorted(Out) == [2, 3, 5] and Out is _oh, Out");
    // (Out shown is not recorded)
    await ok("Out");
    await ok("assert _ == 3, _");
    // (a silent request records nothing, nor counts: IPython runs it without the displayhook)
    await ok("4", true);
    await ok("assert (_, __, ___) == (3, 2, 1) and sorted(Out) == [2, 3, 5], (_, __, ___, Out)");
  } finally {
    k.close();
    await k.stop();
  }
});
