import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { magicSyntax } from "../src/magic-syntax";
import { analyzeCell } from "../src/dataflow";

// IPython's magics: src/magic-syntax.ts (the syntax) and lib/_pyjs_magic.py
// (the magics; every one Sagebrush does not have is an error).

test("magic syntax: %line, %%cell and !shell lines become calls; strings, brackets and continuations are left alone", () => {
  assert.equal(magicSyntax("%matplotlib inline"), '__pyjs_magic__("matplotlib", "inline")');
  assert.equal(magicSyntax("%reload_ext autoreload\n%autoreload 2\nx = 1"),
    '__pyjs_magic__("reload_ext", "autoreload")\n__pyjs_magic__("autoreload", "2")\nx = 1');
  assert.equal(magicSyntax("for i in range(3):\n    %time f(i)"), 'for i in range(3):\n    __pyjs_magic__("time", "f(i)")');
  assert.equal(magicSyntax("!pip install numpy"), '__pyjs_magic__("system", "pip install numpy")');
  assert.equal(magicSyntax("%%time\nx = 1\ny = 2"), '__pyjs_cell_magic__("time", "", "\\nx = 1\\ny = 2")');
  assert.equal(magicSyntax("\n%%timeit -n 3 a = 1\na + 1"), '\n__pyjs_cell_magic__("timeit", "-n 3 a = 1", "\\n\\na + 1")');
  // not at a statement's start: modulo, in strings, in brackets, after a backslash
  for (const src of ["x = 5 %3", "s = '''\n%time x\n'''", 'f(1,\n  %2)', "y = 1 + \\\n%2", "a != b", "x = 1  # %time"]) assert.equal(magicSyntax(src), src);
  // a string that ends on the line does not hide the next line's magic
  assert.equal(magicSyntax("s = '%d' % 3\n%time s"), "s = '%d' % 3\n__pyjs_magic__(\"time\", \"s\")");
  // in Sage mode, the code %time runs is Sage's
  assert.equal(magicSyntax("%time 2^10\n%autoreload 2", { sage: true }), '__pyjs_magic__("time", "2^10", True)\n__pyjs_magic__("autoreload", "2")');
  // for the reactive notebook's analysis, that code itself
  assert.equal(magicSyntax("%time f(x)\n%timeit -n 10 -r 2 g(y)\n%matplotlib inline", { analysis: true }),
    'f(x)\ng(y)\n__pyjs_magic__("matplotlib", "inline")');
  assert.equal(magicSyntax("%%time\nz = w + 1", { analysis: true }), "pass\nz = w + 1");
});

test("the reactive notebook's analysis sees the code %time, %timeit and %%time run", () => {
  const a = analyzeCell("%reload_ext autoreload\n%time y = f(x)\n%timeit -n 3 g(y)\n!ls\n");
  assert.deepEqual([...a.defs], ["y"]);
  assert.ok(["f", "x", "g"].every((n) => a.refs.has(n)));
  const b = analyzeCell("%%time\nz = w + 1");
  assert.deepEqual([[...b.defs], [...b.refs]], [["z"], ["w"]]);
});

test("notebook session: the supported magics run; every other is an error", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = [
    "%matplotlib inline\n%reload_ext autoreload\n%autoreload 2\nprint('ok')",          // 1: Lab 1's first lines
    "%time sum(range(1000))",                                                              // 2
    "%timeit -n 3 -r 2 sum(range(10))",                                                    // 3
    "r = %timeit -o pass",                                                                 // 4: not a magic line: a syntax error
    "%%time\nq = 6 * 7\nprint(q)",                                                         // 5
    "%pwd",                                                                                // 6
    "!ls",                                                                                 // 7
    "%pip install pandas",                                                                 // 8
    "%matplotlib widget",                                                                  // 9
    "%%capture\nprint(1)",                                                                 // 10
    "res = get_ipython().run_line_magic('timeit', '-q -o -n 2 -r 3 pass')\nprint(res.loops, res.repeat, len(res.all_runs))", // 11
    "%autoreload 3",                                                                       // 12
    "%timeit -x 1",                                                                        // 13
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i] });
  const out = (id: number, stream: string) => msgs.filter((m) => m.id === id && m.stream === stream).map((m) => m.text).join("");
  const failed = (id: number) => !!msgs.find((m) => m.id === id && m.done)?.error;
  assert.deepEqual(cells.map((_, i) => failed(i + 1)), [false, false, false, true, false, true, true, true, true, true, false, true, true]);
  assert.equal(out(1, "stdout"), "ok\n");
  // (the value: displayed, here as text)
  assert.match(out(2, "stdout"), /^Wall time: [\d.]+ (s|ms|µs|ns)\n499500\n$/);
  assert.match(out(3, "stdout"), /^[\d.]+ (s|ms|µs|ns) ± [\d.]+ (s|ms|µs|ns) per loop \(mean ± std\. dev\. of 2 runs, 3 loops each\)\n$/);
  assert.match(out(5, "stdout"), /^42\nWall time: /);
  assert.match(out(6, "stderr"), /UsageError: shell commands are not available in Sagebrush/);
  assert.match(out(7, "stderr"), /UsageError: shell commands are not available in Sagebrush/);
  assert.match(out(8, "stderr"), /UsageError: packages cannot be installed in Sagebrush/);
  assert.match(out(9, "stderr"), /UsageError: %matplotlib widget is not supported in Sagebrush/);
  assert.match(out(10, "stderr"), /UsageError: Cell magic `%%capture` not found \(Sagebrush has %%time, %%timeit\)/);
  assert.equal(out(11, "stdout"), "2 3 3\n");
  assert.match(out(12, "stderr"), /UsageError: %autoreload 3 \(complete\) is not supported in Sagebrush/);
  assert.match(out(13, "stderr"), /UsageError: %timeit: option -x is not supported in Sagebrush/);
  // a Sage cell: %time runs Sage's code
  await s.handle({ id: 14, code: "%time 2^10", sage: true });
  assert.match(out(14, "stdout"), /^Wall time: .*\n1024\n$/);
  await s.handle({ id: 16, code: "%%bash\necho hi" });
  assert.match(out(16, "stderr"), /UsageError: shell commands are not available in Sagebrush/);
  await s.handle({ id: 15, code: "%%timeit -q -o -n 1 -r 1 a = 3^2\nassert a == 9", sage: true });
  assert.equal(failed(15), false);
});

test("notebook session: %autoreload 2 reloads a changed module before the next cell, updating classes in place", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const dir = mkdtempSync(join(tmpdir(), "sb-autoreload-"));
  const mod = join(dir, "sbar_mod.py");
  writeFileSync(mod, "def f():\n    return 1\nclass C:\n    def m(self):\n        return 'old'\n");
  utimesSync(mod, 1000, 1000);
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const run = async (id: number, code: string) => { await s.handle({ id, code }); return msgs.filter((m) => m.id === id && m.stream).map((m) => m.text).join(""); };
  // (without the extension, %autoreload is unknown, as in IPython; the
  // test before loaded it in this process's runtime)
  assert.match(await run(1, "%unload_ext autoreload\n%autoreload 2"), /Line magic function `%autoreload` not found \(load it first: %load_ext autoreload\)/);
  assert.equal(await run(2, `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\n%load_ext autoreload\n%autoreload 2\nimport sbar_mod\nfrom sbar_mod import f, C\nc = C()\nprint(f(), c.m())`), "1 old\n");
  writeFileSync(mod, "def f():\n    return 2\nclass C:\n    def m(self):\n        return 'new'\n    def extra(self):\n        return 'added'\n");
  utimesSync(mod, 2000, 2000);
  assert.equal(await run(3, "print(f(), sbar_mod.f(), c.m(), c.extra(), isinstance(c, C))"), "2 2 new added True\n");
  // %autoreload 0: no more reloading
  await run(4, "%autoreload 0");
  writeFileSync(mod, "def f():\n    return 3\n");
  utimesSync(mod, 3000, 3000);
  assert.equal(await run(5, "print(f())"), "2\n");
  assert.equal(await run(6, "%autoreload now\nprint(sbar_mod.f(), f())"), "3 3\n");
});
