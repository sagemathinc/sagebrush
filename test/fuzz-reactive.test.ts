// The reactive notebook against plain Python (test/fuzz-lib.ts): the cases
// the fuzzer found, each a bug fixed, then a short random run.  Needs
// python3 (CPython runs the cells); skipped without it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Kernel, makeCase, runCase, shrink, show, type Case, type Op, type Stats } from "./fuzz-lib";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const cells = (codes: string[]) => codes.map((code, i) => ({ id: `c${i}`, stmts: [code] }));
const regression = (codes: string[], ops: Op[] = []): Case => ({ seed: 0, cells: cells(codes), ops });
const stats = (): Stats => ({ compared: 0, refused: 0, unclean: 0, steps: 0, uncovered: 0 });

// The cases that must run, not be refused: the reviews' controls (except
// those of a call running what it is given, now refused by design), and a
// plain definition made in a function declaring it global.
const MUST_RUN = (what: string) =>
  (/control/.test(what) && !/sorted|sum consumes|list consumes|generator consumed|list sort/.test(what)) || /definition made in a called function/.test(what);

export const REGRESSIONS: [string, Case][] = [
  ["`y += 4` redefines y from the definition above", regression(["K = 7", "y = K", "y += 4\nprint(y)"])],
  ["a class reads its own name's previous definition in its body", regression(["class D:\n    a = 6", "class D:\n    def m0(self, p=D.a):\n        return p\n    a = 1\nprint(D.a, D().m0())", "print(D.a)"])],
  ["`del y` then a new y in the same cell", regression(["y = 1", "del y\ny = 2\nprint(y)"])],
  ["a cell that deleted z, edited to read it: z's definer reruns", regression(["z = 5", "del z"], [{ kind: "edit", id: "c1", stmts: ["print(z - 4)"] }])],
  ["a reader inserted above a deleter", regression(["z = 7", "del z"], [{ kind: "insert", at: 1, id: "c2", stmts: ["print(z + 1)"] }])],
  ["a lambda in a class body reads the global, not the class's attribute", regression(["class D:\n    x = 9\n    y = (lambda: x)()\nprint(D.y)", "x = 0"], [{ kind: "move", id: "c1", to: 0 }])],
  ["`except E as x` deletes x; edited away, x's definer reruns", regression(["x = 5"], [
    { kind: "insert", at: 1, id: "c1", stmts: ["try:\n    1 // 0\nexcept ZeroDivisionError as x:\n    pass"] },
    { kind: "edit", id: "c1", stmts: ["print(x)"] },
  ])],
  ["a move that makes a cycle shows errors, not old outputs", regression(["y = 1", "print(y)\nclass C:\n    z = 1", "print(0 if y < 5 else C.z)\ny = 2"], [{ kind: "move", id: "c1", to: 2 }])],
  ["after `del z` in a class body, z is the global again", regression(["z = 9", "print(z)", "z = 30", "class D:\n    z = 1\n    del z\n    a = 3 * z\nprint(D.a)"])],
  ["a rename refused elsewhere: an error shown, not a NameError", regression(["K = 7", "z = K", "z += 1\nprint(z)", "z = 3\nclass D:\n    for z in range(1):\n        pass\n    z += 8"])],
  ["a deleter that gets an error (a cycle) no longer deletes", regression(["z = 10", "print(z)", "del z\nw = 1"], [
    { kind: "edit", id: "c1", stmts: ["print(z, w)"] },
    { kind: "insert", at: 3, id: "c3", stmts: ["print(z * 2)"] },
  ])],
  ["a cell redefining y reads the y above in a lambda it calls at once (y not deleted first)", regression([
    "K = 7", "class C:\n    b = (lambda: K)()\n    z = K\n    y = (2 if b > 3 else K)", "if True:\n    y = C.z",
  ], [
    { kind: "insert", at: 3, id: "c3", stmts: ["for y in range(1):\n    pass"] },
    { kind: "edit", id: "c3", stmts: ["y = (lambda q: q + sum([y for i in range(3)]))(8 - 9 * (lambda q: q + 2)(6))\nclass C:\n    a = y\n    for y in range(3):\n        pass\n    if True:\n        x = y"] },
  ])],
  ["a class body reads y before the cell redefines y below it", regression([
    "K = 7", "y, y = 6, K", "for y in range(2):\n    pass", "class D:\n    x = y\n    for y in range(3):\n        pass\n    def m2(self, p=y):\n        return p\ny = D.y",
  ])],
  ["a comprehension reads x before the cell redefines x", regression([
    "x = 9", "z = 6", "class D:\n    for x in range(1):\n        pass\n    z = x * (lambda q: q + 5)(6)\n    for x in range(1):\n        pass\nif True:\n    x = sum([x for i in range(3)])",
  ], [{ kind: "edit", id: "c1", stmts: ["y, x = 0, 5 - sum([sum([2 for i in range(3)]) for i in range(3)])"] }])],
  // (sagebrush-codex's review of the fuzzer's fixes)
  ["a redefined class's method and lambda read the class by name when called (REACT-F17)", regression([
    "class C:\n    a = 1", "class C:\n    a = 2\n    def m(self):\n        return C.a\n    f = lambda: C.a\nprint(C().m(), C.f())", "print(C.a)",
  ])],
  ["a lambda called where it is written, in a class body, reads the class's previous definition", regression([
    "class D:\n    a = 1", "class D:\n    a = (lambda: D.a)() + 1\n    def m(self):\n        return D.a\nprint(D.a, D().m())", "print(D.a)",
  ])],
  ["a `:=` in a default binds the notebook's x (REACT-F18)", regression(["x = 1", "def f(a=(x := 2)):\n    return a\nprint(x)", "print(x)"], [
    { kind: "edit", id: "c1", stmts: ["def f(a=(x := 3)):\n    return a\nprint(x)"] },
  ])],
  ["cells after one that raises in plain Python, not depending on it, are compared (FUZZ-F3)", regression([
    "1 // 0", "class C:\n    a = 1", "class C:\n    a = 2\n    def m(self):\n        return C.a\nprint(C().m())", "print(C.a)",
  ])],
  ["a generator stored in a class reads the new class when consumed (REACT-F20)", regression([
    "class C:\n    a = 1", "print(C.a)", "class C:\n    a = 2\n    g = (C.a for i in [0])\nprint(list(C.g))",
  ])],
  ["a generator in a default reads the new function when consumed (REACT-F20)", regression(["f = 1", "print(f)", "def f(g=(f for _ in [0])):\n    return next(g) is f\nprint(f())"])],
  ["a function called while its class is made: refused, not wrong (REACT-F21)", regression([
    "class C:\n    a = 1", "print(C.a)", "class C:\n    def f():\n        return C.a\n    a = f() + 1\nprint(C.a)",
  ])],
  ["a generator consumed while the class is made reads the previous class", regression([
    "class C:\n    a = 1", "print(C.a)", "class C:\n    a = 2\n    b = sum(C.a for i in [0])\n    def m(self):\n        return C.a\nprint(C.b, C().m())",
  ])],
  ["a `:=` in a default inside a function with `global x` binds the notebook's x (REACT-F22)", regression([
    "x = 1", "def g():\n    global x\n    def f(a=(x := 2)):\n        return a\n    return f()\ng()\nprint(x)", "print(x)",
  ], [{ kind: "edit", id: "c1", stmts: ["def g():\n    global x\n    def f(a=(x := 3)):\n        return a\n    return f()\ng()\nprint(x)"] }])],
  // (sagebrush-daybreak's review of 960105c)
  ["a lambda written before a new x, called after it, reads the new x (REACT-F23)", regression(["x = 1", "f = lambda: x\nx = 2\nprint(f())", "assert x"])],
  ["a function written before a new x, called after it, reads the new x (REACT-F23)", regression(["x = 1", "def f():\n    return x\nx = 2\nprint(f())", "assert x"])],
  ["a lambda called before and after a new x: refused, not wrong (REACT-F23)", regression(["x = 1", "f = lambda: x\nprint(f())\nx = 2\nprint(f())", "assert x"], [{ kind: "edit", id: "c0", stmts: ["x = 5"] }])],
  ["a generator that would bind x but never runs leaves x (REACT-F24)", regression(["x = 1", "g = ((x := 2) for _ in [0])\nprint(x)", "assert x"])],
  ["a function setting x that is never called leaves x (REACT-F24)", regression(["x = 1", "def setx():\n    global x\n    x = 2\nprint(x)", "assert x"])],
  ["a function setting x takes effect where it is called (REACT-F24)", regression(["x = 1", "def setx():\n    global x\n    x = 2\nprint(x)\nsetx()\nprint(x)", "print(x)"])],
  ["a renamed class and function keep their names (REACT-F25)", regression([
    "class C:\n    pass\ndef f():\n    pass", "class C:\n    def m(self):\n        pass\ndef f():\n    pass\nprint(C.__name__, C.__qualname__, C.m.__qualname__, f.__name__, f.__qualname__)", "print(C.__name__, f.__name__)",
  ])],
  ["annotations are read when asked for: the new definition (REACT-F26)", regression([
    "def F():\n    pass", "def F(a: F) -> F:\n    pass\nprint(F.__annotations__['a'] is F)", "assert F",
  ])],
  ["`except E as x` deletes x for the cells below it, as in plain Python", regression(["x = 1", "print(x)", "try:\n    1 // 0\nexcept ZeroDivisionError as x:\n    pass", "print(x)"])],
  ["a reader of a name an `except` cell with an error defines waits for it", regression([
    "K = 7", "z, y = K, 9", "x, x = (lambda q: q + 1)(4), 7 - 4", "y += sum([i for i in range(3)])", "h2 = lambda: x\nprint(h2())\nx = 6\nprint(h2())",
  ], [{ kind: "edit", id: "c2", stmts: ["x = K\ntry:\n    1 // 0\nexcept ZeroDivisionError as y:\n    print(type(y).__name__)"] }])],
  // (sagebrush-codex's review of 3bc474f)
  ["`global x` in a class body, with := in a method's default (REACT-3BC-1)", regression(["x = 1", "class C:\n    global x\n    def f(a=(x := 2)):\n        return a\nprint(x)", "print(x)"])],
  ["a lambda given to map runs when consumed: refused or right (REACT-3BC-2)", regression(["x = 1", "g = map(lambda _: x, [0])\nx = 2\nprint(next(g))", "print(x)"])],
  ["a generator given to iter runs when consumed: refused or right (REACT-3BC-2)", regression(["x = 1", "g = iter(x for _ in [0])\nx = 2\nprint(next(g))", "print(x)"])],
  ["a setter reading x before setting it, called once (REACT-3BC-3)", regression(["x = 1", "def bump():\n    global x\n    x = x + 1\nbump()\nprint(x)", "print(x)"])],
  ["a setter reading x before setting it, called twice: refused or right (REACT-3BC-4)", regression(["x = 1", "def setx():\n    global x\n    print(x)\n    x = 2\nsetx()\nsetx()\nprint(x)", "print(x)"])],
  ["a setter called under `if False`: x stays (REACT-3BC-5)", regression(["x = 1", "def setx():\n    global x\n    x = 2\nif False:\n    setx()\nprint(x)", "print(x)"])],
  ["a setter called after `False and`: x stays (REACT-3BC-5)", regression(["x = 1", "def setx():\n    global x\n    x = 2\nFalse and setx()\nprint(x)", "print(x)"])],
  ["a name a decorator chose is kept (REACT-3BC-6)", regression([
    "def f():\n    pass", "def deco(fn):\n    fn.__name__ = 'custom'\n    return fn\n@deco\ndef f():\n    pass\nprint(f.__name__)", "print(f.__name__)",
  ])],
  ["a decorator's result keeps its own name (REACT-3BC-6)", regression([
    "def f():\n    pass", "def deco(fn):\n    return lambda: 7\n@deco\ndef f():\n    pass\nprint(f.__name__, f())", "print(f())",
  ])],
  ["nested classes' and properties' qualified names (REACT-3BC-8)", regression([
    "class C:\n    pass", "class C:\n    class D:\n        def m(self):\n            pass\n    @property\n    def a(self):\n        return 1\nprint(C.D.m.__qualname__, C.D.__qualname__, C.a.fget.__qualname__)", "print(C.__name__)",
  ])],
  // (sagebrush-daybreak's interim review of 3bc474f)
  ["an async setter's call does not run it: x stays", regression(["x = 1", "async def setx():\n    global x\n    x = 2\nc = setx()\nprint(x)\nc.close()", "print(x)"])],
  ["a generator function's call does not run it: x stays", regression(["x = 1", "def setx():\n    global x\n    x = 2\n    yield\nsetx()\nprint(x)", "print(x)"])],
  ["a decorated setter may not run: refused or right", regression(["x = 1", "def deco(f):\n    return lambda: None\n@deco\ndef setx():\n    global x\n    x = 2\nsetx()\nprint(x)", "print(x)"])],
  ["a setter rebound before its call: refused or right", regression(["x = 1", "def setx():\n    global x\n    x = 2\nsetx = print\nsetx()\nprint(x)", "print(x)"])],
  ["a class decorator calling a method that reads the class: refused or right", regression([
    "class C:\n    a = 1", "def deco(c):\n    c.b = c().m()\n    return c\n@deco\nclass C:\n    a = 2\n    def m(self):\n        return C.a\nprint(C.b)", "print(C.a)",
  ])],
  ["an uncalled setter does not hide the cell's read of x: x edited, it reruns", regression(["x = 1", "def setx():\n    global x\n    x = 2\nprint(x)", "print(x)"], [{ kind: "edit", id: "c0", stmts: ["x = 5"] }])],
  ["two unconsumed walrus generators do not hide the read of x", regression(["x = 1", "g1 = ((x := 2) for _ in [0])\ng2 = ((x := 3) for _ in [0])\nprint(x)", "print(x)"], [{ kind: "edit", id: "c0", stmts: ["x = 5"] }])],
  ["a call in an annotation does not run", regression(["x = 1", "def setx():\n    global x\n    x = 2\ndef f(a: setx()):\n    pass\nprint(x)", "print(x)"])],
  // (sagebrush-daybreak's supplemental review of 3bc474f)
  ["an annotation asked for before the new x: refused or right (REACT-3BC-10)", regression(["x = 1", "def f(a: x):\n    pass\nprint(f.__annotations__['a'])\nx = 2", "assert x == 2"])],
  ["a type alias asked for before the new x: refused or right (REACT-3BC-10)", regression(["x = 1", "type A = x\nprint(A.__value__)\nx = 2", "assert x == 2"])],
  ["future annotations keep their text: refused or right (REACT-3BC-10)", regression(["x = 1", "from __future__ import annotations\ndef f(a: x):\n    pass\nx = 2\nprint(f.__annotations__['a'])", "assert x == 2"])],
  ["a parameter named like an internal name does not capture it (REACT-3BC-14)", regression(["x = 1", "x = 2", "def f(x\u02b92=99):\n    print(x)\nf()"])],
  ["an except target named like an internal name does not capture it (REACT-3BC-14)", regression(["x = 1", "x = 2", "try:\n    1 / 0\nexcept Exception as x\u02b92:\n    print(type(x).__name__)"])],
  ["global of a name in another script (REACT-3BC-15)", regression(["\u03b1 = 1", "def set\u03b1():\n    global \u03b1\n    \u03b1 = 2\nset\u03b1()\nprint(\u03b1)", "assert \u03b1 == 2"])],
  ["a global statement continued over lines (REACT-3BC-15)", regression(["x = 1", "def setx():\n    global y, \\\n        x\n    x = 2\nsetx()\nprint(x)", "assert x == 2"])],
  ["f\"{x=}\" shows x as written (REACT-3BC-16)", regression(["x = 1", "x = 2", "print(f\"{x=}\", f\"{x = }\", f\"{x=:>3}\")"])],
  ["a t-string's expression shows x as written (REACT-3BC-16)", regression(["x = 1", "x = 2", "q = t\"{x}\"\nprint(q.interpolations[0].expression, q.interpolations[0].value)"])],
  ["a metaclass sees no writes from the rename (REACT-3BC-17)", regression([
    "class C:\n    pass", "events = []\nclass M(type):\n    def __setattr__(cls, name, value):\n        events.append(name)\n        super().__setattr__(name, value)\nclass C(metaclass=M):\n    pass\nprint(events, C.__name__)", "print(C.__name__)",
  ])],
  ["code names and decorators see the name as written (REACT-3BC-17)", regression([
    "def f():\n    pass", "def deco(fn):\n    print(fn.__name__, fn.__code__.co_name)\n    return fn\n@deco\ndef f():\n    def g():\n        pass\n    return g\nprint(f.__code__.co_qualname, f().__qualname__)", "print(f.__name__)",
  ])],
  ["a definition made in a called function (global f) has its written name (REACT-3BC-17)", regression([
    "def f():\n    pass", "def make():\n    global f\n    def f():\n        pass\nmake()\nprint(f.__name__, f.__qualname__)", "print(f.__name__)",
  ])],
  ["a name only in a string does not make a rename (REACT-3BC-19)", regression(["def f():\n    pass", "def deco(fn):\n    print(fn.__name__)\n    return fn\n@deco\ndef f():\n    pass\nprint(\"f\")"])],
  ["a keyword's read after a starred argument's walrus reads the new x", regression(["x = 1", "def observe(v, k):\n    print(v, k)\nobserve(k=x, *[(x := 2)])\nprint(x)", "print(x)"])],
  ["an assignment's value reads the new x after its own := (as REACT-C199-1)", regression(["x = 1", "x = (x := 2) + x\nprint(x)", "print(x)"])],
  ["a for loop's iterable reads the new x after its own := (runs once): control", regression(["x = [1]", "for x in [(x := [2]), x]:\n    print(x)", "print(x)"])],
  ["an assignment's value before its own := reads the previous x: refused or right", regression(["x = 1", "x = x + (x := 2)\nprint(x)", "print(x)"])],
  ["a cell raising in plain Python raises here too (FUZZ-F4)", regression(["x = 1", "f = lambda: x\nx = 2\ndel x\nprint(f())", "print(x)"])],
];

// (sagebrush-codex's cases from its review of e555163, as it wrote them)
for (const c of JSON.parse(readFileSync(__dirname + "/../../test/fuzz-cases-e555163.json", "utf8")) as { name: string; codes: string[] }[]) REGRESSIONS.push([`${c.name} (review of e555163)`, regression(c.codes)]);
// (and of 87fd4d5, with the earlier reviews' cases it kept: `change` edits a cell)
for (const c of JSON.parse(readFileSync(__dirname + "/../../test/fuzz-cases-87fd4d5.json", "utf8")) as { name: string; codes: string[]; change?: [number, string] | null }[]) {
  REGRESSIONS.push([`${c.name} (review of 87fd4d5)`, regression(c.codes, c.change ? [{ kind: "edit", id: `c${c.change[0]}`, stmts: [c.change[1]] }] : [])]);
}
// (and of 98eb351, 6748f98, 75a84fb, 156cd6b, 321cff0, c199015, f813101 and feedd29)
for (const [pin, c] of ["98eb351", "6748f98", "75a84fb", "156cd6b", "321cff0", "c199015", "f813101", "feedd29"].flatMap((pin) => (JSON.parse(readFileSync(__dirname + `/../../test/fuzz-cases-${pin}.json`, "utf8")) as { name: string; codes: string[]; change?: [number, string] | null }[]).map((c) => [pin, c] as const))) {
  REGRESSIONS.push([`${c.name} (review of ${pin})`, regression(c.codes, c.change ? [{ kind: "edit", id: `c${c.change[0]}`, stmts: [c.change[1]] }] : [])]);
}

test("the reactive notebook computes what plain Python does: the fuzzer's cases", { skip: !hasPython && "no python3" }, async () => {
  const k = new Kernel();
  try {
    const failed: string[] = [];
    for (const [what, c] of REGRESSIONS) {
      const st = stats();
      const f = await runCase(k, c, st);
      if (f) failed.push(`${what}\n${show(c)}\n${f.why}, ${f.cell} after step ${f.step}\n${f.detail}`);
      // (a control must run: a refusal would pass the comparison unseen)
      else if (MUST_RUN(what) && st.refused) failed.push(`${what}: ${st.refused} cells refused, expected to run`);
    }
    assert.deepEqual(failed, []);
  } finally {
    k.close();
  }
});

test("the reactive notebook computes what plain Python does: 150 random notebooks", { skip: !hasPython && "no python3" }, async () => {
  const k = new Kernel();
  const s = stats();
  try {
    for (let seed = 1; seed <= 150; seed++) {
      const c = makeCase(seed, 6);
      const f = await runCase(k, c, s);
      assert.equal(f, null, `seed ${seed} (node dist/test/fuzz-reactive.js --seed ${seed} --cases 1 shrinks it)\n${show(c)}\n${f?.why}, ${f?.cell} after step ${f?.step}\n${f?.detail}`);
    }
  } finally {
    k.close();
  }
  assert.ok(s.compared > 1000, `${s.compared} outputs compared`);
});

test("the fuzzer fails loudly when its interpreter dies, and shrinking ends (FUZZ-F1, F2)", { skip: !hasPython && "no python3" }, async () => {
  const k = new Kernel();
  await k.call({ op: "reset" });
  (k as any).p.kill();
  // (the write may fail before the exit is seen: either is the interpreter's death)
  await assert.rejects(k.call({ op: "reset" }), /python( exited|'s stdin)/);
  assert.match(k.dead ?? "", /python( exited|'s stdin)/);
  const c = makeCase(1, 6);
  const [small] = await shrink(k, c, { step: -1, cell: "", why: "the harness threw", detail: "" });
  assert.equal(small, c);
});
