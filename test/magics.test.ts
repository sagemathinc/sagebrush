import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { magicSyntax, classCellReport } from "../src/magic-syntax";
import { analyzeCell } from "../src/dataflow";
import { needsMore } from "../src/interactive";

// IPython's magics: src/magic-syntax.ts (the syntax, and the code %time and
// %timeit run expanded into the cell) and lib/_pyjs_magic.py (the magics;
// every one Sagebrush does not have is an error).

// (outputs with the times taken replaced)
const untimed = (s: string) => s
  .replace(/Wall time: [\d.]+ (s|ms|µs|ns)\n/g, "WALL\n")
  .replace(/The slowest run took [\d.]+ times longer[^\n]*\n/g, "")
  .replace(/[\d.]+ (s|ms|µs|ns) ± [\d.]+ (s|ms|µs|ns) per loop/g, "T per loop");

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 1000 * Math.floor(Math.random() * 1000);
  return {
    async run(code: string, extra: object = {}) {
      const n = ++id;
      await s.handle({ id: n, code, ...extra });
      const out = msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join("");
      const err = msgs.filter((m) => m.id === n && m.stream === "stderr").map((m) => m.text).join("");
      return { out: untimed(out), err, failed: !!msgs.find((m) => m.id === n && m.done)?.error };
    },
  };
}

test("magic syntax: %line, %%cell and !shell lines at a statement's start become calls", () => {
  assert.equal(magicSyntax("%matplotlib inline"), '__pyjs_magic__("matplotlib", "inline")');
  assert.equal(magicSyntax("%reload_ext autoreload\n%autoreload 2\nx = 1"),
    '__pyjs_magic__("reload_ext", "autoreload")\n__pyjs_magic__("autoreload", "2")\nx = 1');
  assert.equal(magicSyntax("for i in range(3):\n    %time f(i)"), 'for i in range(3):\n    __pyjs_magic__("time", "f(i)")');
  assert.equal(magicSyntax("!pip install numpy"), '__pyjs_magic__("system", "pip install numpy")');
  // %%time and %%timeit: the body stays code, on its lines; other cell magics' bodies are text
  assert.equal(magicSyntax("%%time\nx = 1\ny = 2"), '__pyjs_cell_magic__("time", "")\nx = 1\ny = 2');
  assert.equal(magicSyntax("\n%%timeit -n 3 a = 1\na + 1"), '\n__pyjs_cell_magic__("timeit", "-n 3 a = 1")\na + 1');
  assert.equal(magicSyntax("%%time --bad\nx = 1"), '__pyjs_cell_magic__("time", "--bad", "x = 1")');
  assert.equal(magicSyntax("%%capture\nprint(1)"), '__pyjs_cell_magic__("capture", "", "print(1)")');
  // a magic's line is opaque: an unbalanced quote in it does not hide the next line
  assert.equal(magicSyntax("!echo it's\n%time 1"), '__pyjs_magic__("system", "echo it\'s")\n__pyjs_magic__("time", "1")');
  // not at a statement's start: modulo, strings, brackets, backslashes, comments
  for (const src of ["x = 5 %3", "s = '''\n%time x\n'''", "f(1,\n  %2)", "y = 1 + \\\n%2", "a != b", "x = 1  # %time", "s = '%d' % 3"]) assert.equal(magicSyntax(src), src);
  assert.equal(magicSyntax("s = '%d' % 3\n%time s"), "s = '%d' % 3\n__pyjs_magic__(\"time\", \"s\")");
});

test("magic syntax never changes valid Python: 400 generated cells with %, %% and ! lines in strings, f-string fields and brackets", async () => {
  // (test/magic_syntax_gen.py: each case compiled by CPython, with its output)
  const corpus: [string, string][] = JSON.parse(readFileSync(__dirname + "/../../test/magic-syntax-corpus.json", "utf8"));
  for (const [src] of corpus) assert.equal(magicSyntax(src), src);
  // and running them in a notebook prints what CPython printed
  const s = await session();
  for (const [src, want] of corpus.slice(0, 120)) {
    const r = await s.run(src);
    assert.equal(r.out, want, src);
  }
  // astra's cases (CORR-725-1)
  for (const [src, want] of [
    ['s = "prefix\\\n%time suffix"\nprint(s)', "prefix%time suffix\n"],
    ["s = f\"{'''a\n%time literal\n'''}\"\nprint(repr(s))", "'a\\n%time literal\\n'\n"],
    ['s = f"""{"""a\n%time x\n"""}"""\nprint(repr(s))', "'a\\n%time x\\n'\n"],
    ['s = rb"a\\\n%time"\nprint(s)', "b'a\\\\\\n%time'\n"],
  ]) {
    assert.equal(magicSyntax(src), src);
    assert.equal((await s.run(src)).out, want);
  }
});

test("the reactive notebook's analysis: %time's code is the cell's, %timeit's is its own function's", () => {
  const a = analyzeCell("%reload_ext autoreload\n%time y = f(x)\n%timeit -n 3 g(y)\n!ls\n");
  assert.deepEqual([...a.defs], ["y"]);
  assert.ok(["f", "x", "g"].every((n) => a.refs.has(n)));
  const b = analyzeCell("%%time\nz = w + 1");
  assert.deepEqual([[...b.defs], b.refs.has("w")], [["z"], true]);
  // timeit's assignments are not the notebook's (CORR-725-3)
  assert.deepEqual([...analyzeCell("%timeit -n 1 -r 1 newvar=7").defs], []);
  const c = analyzeCell("%%timeit -n 1 -r 1 a=3\nb=a+outside");
  assert.deepEqual([[...c.defs], c.refs.has("outside"), c.refs.has("a")], [[], true, false]);
  // a refused %%time line: nothing in it, nor its body, is the cell's code
  assert.deepEqual([...analyzeCell("%%time q = 1\nr = 2").defs], []);
  // %time's expression is in the cell's scope: a walrus defines (CORR-725-2)
  assert.deepEqual([...analyzeCell("answer = 1\n%time (answer := 9)").defs], ["answer"]);
  // the fresh names of %timeit's function are no definitions
  assert.deepEqual([...analyzeCell("%timeit -n 1 -r 1 -q 1").defs], []);
});

test("notebook session: %time and %timeit run in the cell: renamed names, a function's locals, Sage", async () => {
  const s = await session();
  // the reactive notebook's cell-private names (CORR-725-2)
  assert.deepEqual(await s.run("_x = 3\n%time _x+1", { mangle: "c1" }), { out: "WALL\n4\n", err: "", failed: false });
  assert.equal((await s.run("_x = 3\n%timeit -n 1 -r 1 _x+1", { mangle: "c2" })).out, "T per loop (mean ± std. dev. of 1 run, 1 loop each)\n");
  assert.equal((await s.run("%time _x = 8\nprint(_x)", { mangle: "c3" })).out, "WALL\n8\n");
  // a function's locals, as IPython
  assert.equal((await s.run("def inner():\n    z = 11\n    %time print(z)\ninner()")).out, "11\nWALL\n");
  // an expression keeps its scope: a walrus, locals(), a class body (CORR-725-2)
  assert.equal((await s.run("answer = 1\n%time (answer := 9)\nprint(answer)")).out, "WALL\n9\n");
  assert.equal((await s.run("def ff():\n    x = 7\n    %time print(locals().get('x', 'missing'))\nff()")).out, "7\nWALL\n");
  assert.equal((await s.run("class A:\n    x = 8\n    %time print(x)")).out, "8\nWALL\n");
  assert.equal((await s.run("%time 6 * 7")).out, "WALL\n42\n");
  // %timeit's own names collide with nothing (CORR-776-1)
  assert.equal((await s.run("_pyjs_timeit = 17\n%timeit -n 1 -r 1 -q 1\nprint(_pyjs_timeit)")).out, "17\n");
  assert.equal((await s.run("_pyjs_i = 17\n%timeit -n 1 -r 1 -q print(_pyjs_i)")).out, "17\n");
  assert.equal((await s.run("_pyjs_it = 3\n_pyjs_clock = 4\n_pyjs_t0 = 5\n%timeit -n 2 -r 1 -q print(_pyjs_it + _pyjs_clock + _pyjs_t0)\nprint(sorted(k for k in globals() if k.startswith('_pyjs')))")).out, "12\n12\n['_pyjs_clock', '_pyjs_i', '_pyjs_it', '_pyjs_t0', '_pyjs_timeit']\n");
  // line magics in a %%time body
  assert.equal((await s.run("%%time\n%time 1 + 1\nprint('body')")).out, "WALL\nbody\nWALL\n");
  assert.equal((await s.run("%%time\n%time 2 + 2")).out, "WALL\nWALL\n4\n");
  assert.equal((await s.run("w = 1\n%%timeit -n 1 -r 1 -q\n%time (w := 5)\nprint(w)")).failed, true);  // (%%timeit must be first)
  assert.deepEqual([...analyzeCell("%%time\n%time (q := 3)").defs], ["q"]);
  assert.equal((await s.run("%time for i in range(2): print(i)")).out, "0\n1\nWALL\n");
  assert.equal((await s.run("%time x = 41\nx + 1")).out, "WALL\n42\n");
  // %%time shows the last value; anything on its line is refused, the body not run (CORR-725-5)
  assert.equal((await s.run("%%time\nq = 6\nq * 7")).out, "WALL\n42\n");
  for (const code of ["%%time --bad-option\nprint('body-ran')", "%%time print('ignored')\nprint('body-ran')"]) {
    const r = await s.run(code);
    assert.equal(r.out, "");
    assert.match(r.err, /UsageError: Can't use statement directly after '%%time'!/);
  }
  // %timeit's assignments are its own; nothing is left behind
  await s.run("x = 5");
  assert.equal((await s.run("%timeit -n 1 -r 1 x = 7\nprint(x, [k for k in globals() if k.startswith('_pyjs_timeit_')])")).out, "T per loop (mean ± std. dev. of 1 run, 1 loop each)\n5 []\n");
  assert.equal((await s.run("%%timeit -n 2 -r 3 a = [0]\na[0] += x\nprint(a[0] >= 5)")).out.split("\n").filter((l) => l === "True").length, 6);
  // Sage's syntax
  assert.equal((await s.run("%time 2^10", { sage: true })).out, "WALL\n1024\n");
  assert.equal((await s.run("%%timeit -q -n 2 -r 1 a = 3^2\nassert a == 9", { sage: true })).failed, false);
  // code that does not parse: Python's SyntaxError
  assert.match((await s.run("%time 1 +")).err, /SyntaxError/);
});

test("notebook session: the supported magics run; every other is an error", async () => {
  const s = await session();
  assert.deepEqual(await s.run("%matplotlib inline\n%reload_ext autoreload\n%autoreload 2\nprint('ok')"), { out: "ok\n", err: "", failed: false });
  // (under load a run may be much slower than another: the warning, then the line)
  assert.match((await s.run("%timeit -n 3 -r 2 sum(range(10))")).out, /^T per loop \(mean ± std\. dev\. of 2 runs, 3 loops each\)\n$/);
  assert.equal((await s.run("res = get_ipython().run_line_magic('timeit', '-q -o -n 2 -r 3 pass')\nprint(res.loops, res.repeat, len(res.all_runs))")).out, "2 3 3\n");
  assert.equal((await s.run("r = %timeit -o pass")).failed, true);   // (not a magic line: a syntax error)
  for (const [code, msg] of [
    ["%pwd", /UsageError: shell commands are not available in Sagebrush/],
    ["!ls", /UsageError: shell commands are not available in Sagebrush/],
    ["%%bash\necho hi", /UsageError: shell commands are not available in Sagebrush/],
    ["%pip install pandas", /UsageError: packages cannot be installed in Sagebrush/],
    ["%matplotlib widget", /UsageError: %matplotlib widget is not supported in Sagebrush/],
    ["%%capture\nprint(1)", /UsageError: Cell magic `%%capture` not found \(Sagebrush has %%time, %%timeit\)/],
    ["%autoreload 3", /UsageError: %autoreload 3 \(complete\) is not supported in Sagebrush/],
    ["%timeit -x 1", /UsageError: %timeit: option -x is not supported in Sagebrush/],
    ["%who", /UsageError: Line magic function `%who` not found/],
  ] as [string, RegExp][]) {
    const r = await s.run(code);
    assert.ok(r.failed, code);
    assert.match(r.err, msg);
    assert.equal(r.out, "");
    // (one line, as IPython prints a UsageError: no frames of the magic's machinery)
    assert.doesNotMatch(r.err, /Traceback|__pyjs_magic__|_pyjs_magic\.py/, code);
    assert.equal(r.err.trimEnd().split("\n").length, 1, code);
  }
});

test("notebook session: importing a module Sagebrush does not include says so, after the traceback", async () => {
  const s = await session();
  const hint = /Sagebrush runs Python in this page, compiled to JavaScript: .*packages cannot be installed\. 'pandas' is not included \(yet\)\.\n$/;
  const r = await s.run("import pandas as pd");
  assert.ok(r.failed);
  assert.match(r.err, /^Traceback \(most recent call last\):\n/);
  assert.match(r.err, /ModuleNotFoundError: No module named 'pandas'\n/);
  assert.match(r.err, hint);
  // a submodule that is not included, of a package that is
  assert.match((await s.run("import scipy.no_such_submodule")).err, /'scipy\.no_such_submodule' is not included \(yet\)\.\n$/);
  // included modules import as before; a ModuleNotFoundError raised by the code itself, without a name, has no hint
  assert.deepEqual(await s.run("import math, json, numpy\nprint(math.pi > 3)"), { out: "True\n", err: "", failed: false });
  const own = await s.run("raise ModuleNotFoundError('mine')");
  assert.match(own.err, /ModuleNotFoundError: mine\n$/);
  assert.doesNotMatch(own.err, /Sagebrush runs Python/);
});

test("autoreload's check: which top-level classes may be updated (no __class__ cell), from the parsed source", () => {
  const rep = (src: string) => { const r = classCellReport(src); return r === null ? null : { ...r }; };
  // astra's three layouts (CORR-725-4): a class header over lines, a comment at column 0, a method header over lines
  assert.deepEqual(rep("class Child(\n    Base,\n):\n    def value(self):\n        return super().value() + 1\n"), { Child: false });
  assert.deepEqual(rep("class Child(Base):\n# a comment at column 0\n    def value(self):\n        return super().value() + 1\n"), { Child: false });
  assert.deepEqual(rep("class Child(Base):\n    def value(\nself):\n        return super().value() + 1\n"), { Child: false });
  // every spelling of super, __class__, f-strings, a lambda, a nested class's
  for (const body of ["super().v()", "super( # c\n).v()", "(super)().v()", "s = super", "super(C).v()", "super(*a)", "__class__", "f'{super().v()}'", "(lambda: super().v())()"]) {
    assert.deepEqual(rep(`class C(B):\n    def v(self):\n        ${body}\n`), { C: false }, body);
  }
  assert.deepEqual(rep("class Outer:\n    class Inner(B):\n        def v(self):\n            return super().v()\n"), { Outer: false });
  // what the kept class satisfies: super(Name, obj), and obj.__class__ (an attribute, not the cell)
  assert.deepEqual(rep("class C(B):\n    def v(self):\n        return super(C, self).v() + super(mod.C, self).w() + len(self.__class__.__name__)\n"), { C: true });
  // classes in if/try at the top level count; in a function they do not; two statements of one name are not safe
  assert.deepEqual(rep("if X:\n    class A:\n        pass\ntry:\n    class B:\n        pass\nexcept E:\n    class B:\n        pass\ndef f():\n    class F:\n        pass\n"), { A: true, B: false });
  // source that does not parse: no class is updated
  assert.equal(rep("class C(:\n"), null);
});

test("notebook session: %autoreload 2 reloads changed modules; existing instances follow every edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-autoreload-"));
  const mod = join(dir, "sbar_mod.py");
  let mtime = 1000;
  const write = (src: string) => { writeFileSync(mod, src); utimesSync(mod, (mtime += 1000), mtime); };
  // (Zero, Comment and Paren call super() without arguments, in three spellings)
  const others = (v: number) => `class Zero(Base):\n    def value(self):\n        return super().value() + 1\nclass Comment(Base):\n    def value(self):\n        return super( # explanatory comment\n        ).value() + ${v}\nclass Paren(Base):\n    def value(self):\n        return (super)().value() + ${v}\nclass Multi(\n    Base,\n):\n# a comment at column 0\n    def value(\nself):\n        return super().value() + ${v}\nclass Named(Base):\n    def value(self):\n        return super(Named, self).value() + ${v}\nNamed.__name__ = "Renamed"\n`;
  write("def f():\n    return 1\nclass C:\n    def value(self):\n        return 1\nclass Base:\n    def value(self):\n        return 1\nclass Child(Base):\n    def value(self):\n        return super(Child, self).value() + 1\n" + others(1));
  const s = await session();
  // (without the extension, %autoreload is unknown, as in IPython; tests in
  // one process share the runtime, so unload it first)
  assert.match((await s.run("%unload_ext autoreload\n%autoreload 2")).err, /Line magic function `%autoreload` not found \(load it first: %load_ext autoreload\)/);
  assert.equal((await s.run(`import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\n%load_ext autoreload\n%autoreload 2\nimport sbar_mod\nfrom sbar_mod import f, C, Child, Zero, Comment, Paren\nc, ch, z, cm, pa = C(), Child(), Zero(), Comment(), Paren()\nprint(f(), c.value(), ch.value(), z.value(), cm.value(), pa.value())`)).out, "1 1 2 2 2 2\n");
  // three edits (CORR-725-4): the existing instance follows each one
  for (const v of [2, 3, 4]) {
    write(`def f():\n    return ${v}\nclass C:\n    def value(self):\n        return ${v}\nclass Base:\n    def value(self):\n        return ${10 * v}\nclass Child(Base):\n    def value(self):\n        return super(Child, self).value() + ${v}\n` + others(v));
    const r = await s.run("print(f(), c.value(), C().value(), sbar_mod.C().value(), ch.value(), Child().value(), isinstance(c, sbar_mod.C), C is sbar_mod.C)\nprint(z.value(), cm.value(), pa.value(), Comment().value(), Paren().value())");
    // (the classes autoreload cannot update keep their old code, and their old base: Base's first version)
    assert.equal(r.out, `${v} ${v} ${v} ${v} ${11 * v} ${11 * v} True True\n${10 * v + 1} ${10 * v + 1} ${10 * v + 1} ${11 * v} ${11 * v}\n`);
    // super() without arguments, in any spelling: said, not silently half-done
    for (const k of ["Zero", "Comment", "Paren", "Multi"]) assert.match(r.err, new RegExp(`\\[autoreload of sbar_mod: class ${k} uses super\\(\\) without arguments`));
    // a class whose name is not its statement's (astra on 1427376): not tied, so not updated
    assert.match(r.err, /\[autoreload of sbar_mod: class Named cannot be tied to a class statement of sbar_mod/);
  }
  // %autoreload 0: no more reloading; %autoreload now: once
  await s.run("%autoreload 0");
  write("def f():\n    return 9\n");
  assert.equal((await s.run("print(f())")).out, "4\n");
  assert.equal((await s.run("%autoreload now\nprint(sbar_mod.f(), f())")).out, "9 9\n");
});

test("the prompt: a cell magic takes the lines after it; get_ipython() is there", () => {
  assert.deepEqual([needsMore("%%time"), needsMore("%%time\nprint(1)"), needsMore("%%time\nprint(1)\n"), needsMore("%time 1")], [true, true, false, false]);
  const r = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "-i", "-q"], {
    input: '%%time\nprint("body")\n\nprint(get_ipython() is not None)\n',
    encoding: "utf8",
  });
  assert.equal(untimed(r.stdout).replace(/(>>> |\.\.\. )/g, ""), "body\nWALL\nTrue\n");
});
