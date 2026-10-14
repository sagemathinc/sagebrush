import test from "node:test";
import assert from "node:assert/strict";
import { magmaToPython, MagmaSyntaxError } from "../src/magma";

// the translation, without the line that records the source text
const py = (src: string) => magmaToPython(src).split("\n").filter((l) => !l.includes("_m._source(")).join("\n");

test("a statement's ';' may be left off at the end of a line or of the input", () => {
  assert.equal(py("a := 10"), py("a := 10;"));
  assert.equal(py("a := 10\nb := 5\nFactorization(a*b)"), py("a := 10;\nb := 5;\nFactorization(a*b);"));
  assert.equal(py("for i in [1..3] do\n  print i\nend for"), py("for i in [1..3] do\n  print i;\nend for;"));
  // an expression continued on the next line is still one statement
  assert.equal(py("x := 1 +\n  2\nx"), py("x := 1 +\n  2;\nx;"));
  // two statements on one line still need the ';' between them
  assert.throws(() => magmaToPython("a := 10 b := 5;"), MagmaSyntaxError);
});

test("syntax errors: a file runs up to the first one, a session drops the line and goes on", () => {
  const src = "x := 1;\ny := (2 + ; x;\nx + 1;\nz := 3 $ 4;\nx + 2;\n";
  // without recovery nothing runs, as before
  assert.throws(() => magmaToPython(src), MagmaSyntaxError);
  assert.throws(() => magmaToPython("z := 3 $ 4;"), MagmaSyntaxError);
  const file = magmaToPython(src, "f.m", { recover: "file" });
  assert.match(file, /_m\._syntax_error\(2, 11, "unexpected ';'"\)\n$/);
  assert.doesNotMatch(file.split("\n").filter((l) => !l.includes("_m._source(")).join("\n"), /x \+ 1/);
  const session = magmaToPython(src, "<stdin>", { recover: "session" });
  assert.match(session, /_m\._source\("<stdin>", .*, "session"\)/);
  assert.match(file, /_m\._source\("f\.m", .*, "file"\)/);
  assert.equal(session.match(/_m\._syntax_error\(/g)?.length, 2);
  assert.match(session, /\(x \+ 1\)/);
  assert.match(session, /\(x \+ 2\)/);
  // the rest of the line with the error is dropped: its `x;` never runs
  assert.equal(session.match(/_m\._show_values\(x\)/g), null);
  // an incomplete statement at the end of the input
  assert.match(magmaToPython("x := 1;\ny := (1 +\n", "<stdin>", { recover: "session" }), /_m\._syntax_error\(0, \d+, "unexpected end of input"\)\n$/);
});

test("a notebook or kernel cell (no recovery) still stops at its first error, an undeclared name too", () => {
  // run the cell's translation as the notebook does, as Python on lib/_magma.py
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const cli = join(__dirname, "..", "src", "cli.js");
  const dir = mkdtempSync(join(tmpdir(), "magma-cell-"));
  const run = (src: string) => {
    const f = join(dir, "cell.py");
    writeFileSync(f, magmaToPython(src, "<cell>"));
    return spawnSync(process.execPath, [cli, f], { encoding: "utf8" });
  };
  const undeclared = run("1;\nFoo;\n2;\n");
  assert.equal(undeclared.status, 1);
  assert.match(undeclared.stdout, /^1\n[\s\S]*Identifier 'Foo' has not been declared or assigned\n$/);
  assert.doesNotMatch(undeclared.stdout, /\n2\n/);
  const runtime = run("1;\nerror \"stop\";\n2;\n");
  assert.equal(runtime.status, 1);
  assert.equal(runtime.stdout, "1\nRuntime error: stop\n");
});

test("constructors name< ... > parse; those not implemented yet raise at run time", () => {
  // Magma has no `<` operator: an identifier followed by `<` starts a constructor
  for (const src of [
    "H := sub< G | x, y >;",
    "Q, f := quo< G | H >;",
    "G<a, b> := Group< a, b | a^2 = b^3, (a*b)^5 >;",
    "P := PermutationGroup< 5 | (1,2,3)(4,5), (1,2) >;",
    "f := map< A -> B | x :-> x^2 >;",
    "h := hom< A -> B | <1, 2>, <2, 4> >;",
    "I := ideal< R | x^2 - y, sub< S | 1 > >;",
  ]) {
    const out = py(src);
    assert.match(out, /_m\._unsupported\("[A-Za-z]+", \(1, \d+\)\)/, src);
  }
  assert.match(py("r := rec< F | a := 1, b := <2, 3> >;"), /_m\._rec\(F, \[\("a", 1\), \("b", _m\.MTuple\(\[2, 3\]\)\)\], \(1, 6\)\)/);
  assert.match(py("F := recformat< a : Integers(), b >;"), /_m\._recformat\(\[\("a", Integers\(\)\), \("b", None\)\], \(1, 6\)\)/);
  // statements Magma rejects before running them: only the rejection is emitted
  assert.match(py("F := recformat< a, a >;"), /^_m\._compile_error\(1, 20, "Field 'a' is repeated"\)$/m);
  assert.doesNotMatch(py("F := recformat< a, a >;"), /_recformat/);
  assert.match(py("assigned s[2];"), /_m\._compile_error\(1, 1, "Argument to 'assigned' should be identifier, record field, or attribute"\)/);
  assert.match(py("delete s[2];"), /_m\._compile_error\(1, 9, "Bad delete argument"\)/);
  assert.doesNotMatch(py("delete s[2];"), /_DELETE/);
  // fields: x`f, x``s, assigned, delete
  assert.match(py("r``s;"), /_m\._getattr\(r, s, \(1, 2\)\)/);
  assert.match(py("assigned r`a;"), /_m\._assigned\(r, "a"\)/);
  assert.match(py("delete r`a;"), /_m\._assign_path\(r, \[\("attr", "a", \(1, 9\)\)\], _m\._DELETE\)/);
});

test("notebook session: a Magma cell's error fails its cell, said as Magma says it; quit, and Python's sys.exit() or sys.exit(0), only end theirs", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells: [string, object][] = [
    ["x := 6 * 7;\nprint x;", { magma: true }],
    ["print NotAnIntrinsic(7);", { magma: true }],
    ['error "no";', { magma: true }],
    ["y := 1 div 0;", { magma: true }],
    ["print x +;", { magma: true }],
    ["print x + 1;\nquit;\nprint 0;", { magma: true }],
    ["import sys\nprint('before')\nsys.exit()", {}],
    ["import sys\nsys.exit(0)", {}],
    ["import sys\nsys.exit(1)", {}],
    ["import sys\nsys.exit('a message')", {}],
    ["print x;", { magma: true }],
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i][0], ...cells[i][1] });
  const out = (id: number, stream: string) => msgs.filter((m) => m.id === id && m.stream === stream).map((m) => m.text).join("");
  const failed = (id: number) => !!msgs.find((m) => m.id === id && m.done)?.error;
  assert.deepEqual(cells.map((_, i) => failed(i + 1)), [false, true, true, true, true, false, false, false, true, true, false]);
  assert.equal(out(1, "stdout"), "42\n");
  assert.match(out(2, "stdout"), /User error: Identifier 'NotAnIntrinsic' has not been declared or assigned/);
  assert.match(out(3, "stdout"), /Runtime error: no/);
  assert.match(out(4, "stdout"), /Runtime error/);
  assert.match(out(5, "stderr"), /User error: bad syntax/);
  assert.equal(out(6, "stdout"), "43\n");
  assert.equal(out(7, "stdout"), "before\n");
  assert.equal(out(10, "stderr"), "a message\n");
  // (the session goes on, x as it was)
  assert.equal(out(11, "stdout"), "42\n");
});

test("notebook session: an exit status as text is at most 4096 characters, and one that can't be text still ends its cell, failed (HARD-8E4-1, CORR-8E4-2)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  await s.handle({ id: 1, code: "import sys\nsys.exit('x' * 1000000)" });
  await s.handle({ id: 2, code: "import sys\nclass Bad:\n    def __str__(self):\n        raise RuntimeError('string failed')\nsys.exit(Bad())" });
  await s.handle({ id: 3, code: "print('after')" });
  const out = (id: number, stream: string) => msgs.filter((m) => m.id === id && m.stream === stream).map((m) => m.text).join("");
  const done = (id: number) => msgs.find((m) => m.id === id && m.done);
  assert.equal(out(1, "stderr"), "x".repeat(4096) + "… (995904 more characters)\n");
  assert.ok(done(1)?.error);
  assert.equal(out(2, "stderr"), "(an exit status that could not be written as text)\n");
  assert.ok(done(2)?.error, "it ends, failed");
  assert.equal(out(3, "stdout"), "after\n");
});
