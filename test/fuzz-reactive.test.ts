// The reactive notebook against plain Python (test/fuzz-lib.ts): the cases
// the fuzzer found, each a bug fixed, then a short random run.  Needs
// python3 (CPython runs the cells); skipped without it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Kernel, makeCase, runCase, show, type Case, type Op, type Stats } from "./fuzz-lib";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const cells = (codes: string[]) => codes.map((code, i) => ({ id: `c${i}`, stmts: [code] }));
const regression = (codes: string[], ops: Op[] = []): Case => ({ seed: 0, cells: cells(codes), ops });
const stats = (): Stats => ({ compared: 0, refused: 0, unclean: 0, steps: 0 });

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
];

test("the reactive notebook computes what plain Python does: the fuzzer's cases", { skip: !hasPython && "no python3" }, async () => {
  const k = new Kernel();
  try {
    const failed: string[] = [];
    for (const [what, c] of REGRESSIONS) {
      const f = await runCase(k, c, stats());
      if (f) failed.push(`${what}\n${show(c)}\n${f.why}, ${f.cell} after step ${f.step}\n${f.detail}`);
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
