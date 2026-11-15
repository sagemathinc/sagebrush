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

// (expected values from IPython 9.15's InteractiveShell, the same cells run with store_history)
test("the Jupyter kernel: a full output cache drops its oldest entries, Out[N] and _N, with IPython's warning; size 0 keeps none", async () => {
  const k = await startKernel([]);
  const bound = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("no end within 30 s: " + k.out.stderr)), 30000))]);
  try {
    assert.ok(k.started, k.out.stderr);
    const ok = async (code: string) => {
      const r = await bound(k.exec(code));
      assert.equal(r.status, "ok", `${code}: ${r.ename}: ${r.evalue}`);
    };
    // (execution count 1: the cache made small, and warnings kept to be read)
    await ok("seen = []\nimport warnings\nwarnings.showwarning = lambda m, *a, **k: seen.append(str(m))\nget_ipython().displayhook.cache_size = 4");
    for (const v of ["10", "11", "12", "13", "14"]) await ok(v);
    await ok("assert sorted(Out) == [4, 5, 6] and [n for n in ('_2', '_3', '_4', '_5', '_6') if n in globals()] == ['_4', '_5', '_6'] and (_4, _6) == (12, 14), (sorted(Out), _4, _6)\nassert seen == ['Output cache limit (currently 4 entries) hit.\\nFlushing oldest 2 entries.'], seen");
    await ok("get_ipython().displayhook.cache_size = 0");
    await ok("99");
    await ok("assert _ == 14 and 99 not in Out.values() and sorted(Out) == [4, 5, 6], (_, sorted(Out))");
  } finally {
    k.close();
    await k.stop();
  }
});

// (expected values from IPython 9.15's InteractiveShell: run_cell with store_history=False records under the last
// count, 0 before any, replacing its entries)
test("the Jupyter kernel: a request that doesn't count records under the last count, replacing it, as IPython's displayhook does", async () => {
  const k = await startKernel([]);
  const bound = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("no end within 30 s: " + k.out.stderr)), 30000))]);
  try {
    assert.ok(k.started, k.out.stderr);
    const ok = async (code: string, storeHistory = true) => {
      const r = await bound(k.exec(code, false, storeHistory));
      assert.equal(r.status, "ok", `${code}: ${r.ename}: ${r.evalue}`);
      return r.execution_count;
    };
    assert.equal(await ok("7", false), 0);
    assert.equal(await ok("1"), 1);
    assert.equal(await ok("9", false), 1);
    await ok("assert dict(Out) == {0: 7, 1: 9} and (_0, _1, _) == (7, 9, 9), (dict(Out), _)", false);
  } finally {
    k.close();
    await k.stop();
  }
});
