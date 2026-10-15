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
  assert.match(session, /_m\._add\(x, 1, \(3, 3\)\)/);
  assert.match(session, /_m\._add\(x, 2, \(5, 3\)\)/);
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

test("maps: rules, graphs, arrow pairs and preimages", () => {
  assert.match(py("f := map< A -> B | x :-> x^2 >;"), /_m\._map\("map", A, B, rule=lambda x: _m\._pow\(x, 2, \(1, 27\)\), inv=None, pos=\(1, 9\)\)/);
  assert.match(py("f := map< A -> B | x :-> x + 1, y :-> y - 1 >;"), /inv=lambda y: _m\._sub\(y, 1, \(1, 41\)\)/);
  assert.match(py("f := pmap< A -> B | [ <1, 2> ] >;"), /_m\._map\("pmap", A, B, graph=_m\._seq\(\[_m\.MTuple\(\[1, 2\]\)\]/);
  assert.match(py("f := map< A -> B | [ 1 -> 2, 3 -> 4 ] >;"), /graph=_m\._seq\(\[_m\.MTuple\(\[1, 2\]\), _m\.MTuple\(\[3, 4\]\)\]/);
  assert.match(py("f := map< A -> B | 1 -> 2, 3 -> 4 >;"), /pairs=\[\(1, 2\), \(3, 4\)\]/);
  // hom< > by the images of generators depends on the domain: not yet
  assert.match(py("h := hom< A -> B | [ 1, 2 ] >;"), /_m\._unsupported\("hom"/);
  assert.match(py("y @@ f;"), /_m\._preimage\(f, y, \(1, 3\)\)/);
  // a rule takes its free variables' values when the map is made
  assert.match(py("f := map< A -> B | x :-> x + a >;"), /rule=lambda x, a=_m\._snap\(lambda: a, "a"\): _m\._add\(x, _m\._val\(a, "a"\), \(1, 28\)\)/);
  // ... but not the variables it binds itself, nor field names or named arguments
  const r = py("f := map< A -> B | x :-> #[ j : j in S | j gt x ] + r`n + Foo(x : Bar := 1) >;");
  assert.match(r, /rule=lambda x, S=_m\._snap\(lambda: S, "S"\), r=_m\._snap\(lambda: r, "r"\), Foo=_m\._snap\(lambda: Foo, "Foo"\): /);
  assert.doesNotMatch(r, /j=_m|n=_m|Bar=_m|\u0000/);
  // by scope: a comprehension's j shadows only inside it; a func's parameter is its own
  assert.match(py("f := map< A -> B | x :-> j + &+[ j : j in [1..x] ] >;"), /rule=lambda x, j=_m\._snap\(lambda: j, "j"\): _m\._add\(_m\._val\(j, "j"\), /);
  assert.match(py("f := map< A -> B | x :-> (func<j | j + 1>)(x) >;"), /rule=lambda x: /);
  // `assigned a` first makes a the rule's own local, never assigned: nothing
  // is captured, the test is false, and a read is the unassigned error
  assert.match(py("f := map< A -> B | x :-> assigned a select a else 0 >;"), /rule=lambda x: \(_m\._val\(_m\._UNSET, "a"\) if _m\._bool\(False\) else 0\)/);
  // a read first imports a, and a later `assigned a` is rejected
  assert.match(py("f := map< A -> B | x :-> a + (assigned a select 1 else 0) >;"), /^_m\._compile_error\(1, 31, "Imported environment value 'a' cannot be used as a local"\)$/m);
  assert.match(py("delete a;"), /_m\._delete_check\("a"\)\n\s*del a/);
  // a function expression would be hoisted out of the rule: refused
  assert.match(py("f := map< A -> B | x :-> (function(y) return y; end function)(x) >;"), /_m\._not_supported\("a function expression inside a map rule"/);
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

test("notebook session: an exit status is an integer or not by its Python type (CORR-588-1)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = ["import sys\nsys.exit(-2.5)", "import sys\nsys.exit(2**100)", "import sys\nsys.exit(0.0)", "import sys\nsys.exit(True)", "import sys\nsys.exit(False)",
    "import sys\nclass Code(int): pass\nsys.exit(Code(3))", "import sys\nclass Code(int): pass\nsys.exit(Code(0))",
    // (an int subclass's __bool__ is not asked: its integer as stored is the status, CORR-AD9-1)
    "import sys\nclass Lie(int):\n    def __bool__(self): return not int(self)\nsys.exit(Lie(3))", "import sys\nclass Lie(int):\n    def __bool__(self): return not int(self)\nsys.exit(Lie(0))",
    "import sys\nclass Bad(int):\n    def __bool__(self): raise RuntimeError('no')\nsys.exit(Bad(0))"];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i] });
  const err = (id: number) => msgs.filter((m) => m.id === id && m.stream === "stderr").map((m) => m.text).join("");
  const failed = (id: number) => !!msgs.find((m) => m.id === id && m.done)?.error;
  // (as CPython: a float is no integer status, written; an integer, however large, is not written; True is 1, False 0)
  assert.deepEqual(cells.map((_, i) => [failed(i + 1), err(i + 1)]), [[true, "-2.5\n"], [true, ""], [true, "0.0\n"], [true, ""], [false, ""], [true, ""], [false, ""], [true, ""], [false, ""], [false, ""]]);
});

test("intrinsics refuse strings and booleans where Python would read \"7\" as 7 and true as 1", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const session = (src: string) =>
    spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { encoding: "utf8", input: src }).stdout as string;
  // each refused call is an error, and the session goes on to the next one
  const refused: [string, string][] = [
    ["IsPrime(\"13\");", "Runtime error in 'IsPrime': Bad argument types\nArgument types given: MonStgElt"],
    ["IsPrime(13, true);", "Runtime error in 'IsPrime': Bad argument types\nArgument types given: RngIntElt, BoolElt"],
    ["Gcd(false, 6);", "Runtime error in 'Gcd': Bad argument types\nArgument types given: BoolElt, RngIntElt"],
    ["EulerPhi(\"10\");", "Runtime error in 'EulerPhi': Bad argument types"],
    ["Factorial(true);", "Runtime error in 'Factorial': Bad argument types"],
    ["Seqset(\"ab\");", "Runtime error in 'Seqset': Bad argument types\nArgument types given: MonStgElt"],
    ["Max(\"a\", \"b\");", "Runtime error in 'Max': Bad argument types\nArgument types given: MonStgElt, MonStgElt"],
    ["Append(\"ab\", 1);", "Runtime error in 'Append': Bad argument types"],
    ["EllipticCurve(2, 3);", "Runtime error in 'EllipticCurve': Bad argument types\nArgument types given: RngIntElt, RngIntElt"],
    ["Integers()!\"5\";", "Runtime error in '!': Illegal coercion\nLHS: RngInt\nRHS: MonStgElt"],
    ["Rationals()!true;", "Runtime error in '!': Illegal coercion\nLHS: FldRat\nRHS: BoolElt"],
    ["Intseq(9, 1);", "Runtime error in 'Intseq': Argument 2 (1) should be >= 2"],
    ["Intseq(-9, 2);", "Runtime error in 'Intseq': Argument 1 (-9) should be >= 0"],
    ["IntegerToString(9, true);", "Runtime error in 'IntegerToString': Bad argument types"],
    ["IntegerToString(9, 40);", "Runtime error in 'IntegerToString': Argument 2 (40) should be in the range [2 ..\n36]"],
    ["Seqint([1, 0], 0);", "Runtime error in 'Seqint': Argument 2 (0) should be >= 2"],
    ["[c : c in \"abc\"];", "Runtime error in for: Iteration is not possible over this object"],
  ];
  const out = session(refused.map(([src]) => src).join("\n") + "\n\"end\";\n");
  for (const [src, msg] of refused) assert.ok(out.includes(msg), `${src}\n${out}`);
  assert.ok(out.endsWith("end\n"), out);
  // named parameters: their types, unknown names, and options not modelled
  const params: [string, string][] = [
    ["IsPrime(13 : Proof := \"y\");", "Runtime error in 'IsPrime': Bad type for parameter 'Proof'\nArgument types given: RngIntElt"],
    ["NextPrime(13 : Proof := 0);", "Runtime error in 'NextPrime': Bad type for parameter 'Proof'"],
    ["IsProbablePrime(13 : Bases := true);", "Runtime error in 'IsProbablePrime': Bad type for parameter 'Bases'"],
    ["IsProbablePrime(13 : Bases := -2);", "Runtime error in 'IsProbablePrime': Value for 'Bases' must be small and positive"],
    ["IsPrime(13 : Bar := 1);", "Runtime error in 'IsPrime': Parameter 'Bar' is not defined for this function\nArgument types given: RngIntElt"],
    ["LLL(Matrix(Integers(), 2, 2, [2, 1, 1, 3]) : Delta := \"y\");", "Runtime error in 'LLL': Bad type for parameter 'Delta'\nArgument types given: AlgMatElt[RngInt]"],
    ["LLL(Matrix(Integers(), 2, 2, [2, 1, 1, 3]) : Delta := 0.8);", "LLL with the parameter Delta is not supported yet"],
    ["Index([\"5\"], 5);", "Runtime error in 'Index': Cannot coerce element into the universe"],
    ["Position([5], \"5\");", "Runtime error in 'Position': Cannot coerce element into the universe"],
    ["Include([\"5\"], 5);", "Runtime error in 'Include': Cannot lift element into sequence"],
    ["Exclude({\"5\"}, 5);", "Runtime error in 'Exclude': Illegal coercion"],
    // an empty sequence or set keeps the universe it was made with
    ["Index([ Integers() | ], \"5\");", "Runtime error in 'Index': Cannot coerce element into the universe"],
    ["Position([ Integers() | ], \"5\");", "Runtime error in 'Position': Cannot coerce element into the universe"],
    ["Include([ Integers() | ], \"5\");", "Runtime error in 'Include': Cannot lift element into sequence"],
    ["Include([ Integers() | ], 1/2);", "Runtime error in 'Include': Cannot lift element into sequence"],
    ["Exclude([ Integers() | ], \"5\");", "Runtime error in 'Exclude': Cannot lift element into sequence"],
    ["Include({ Integers() | }, \"5\");", "Runtime error in 'Include': Illegal coercion"],
    ["Exclude({ Integers() | }, \"5\");", "Runtime error in 'Exclude': Illegal coercion"],
  ];
  const pout = session(params.map(([src]) => src).join("\n") + "\n");
  for (const [src, msg] of params) assert.ok(pout.includes(msg), `${src}\n${pout}`);
  // the valid ones, and 1 as the empty string in a universe of strings
  assert.equal(session("IsPrime(13 : Proof := false);\nIsProbablePrime(2047 : Bases := 1);\nIndex([\"\", \"b\"], 1);\nIndex([\"a\", \"b\"], \"b\");\nExclude([\"a\"], 1);\n"),
    "true\nfalse\n1\n2\n[ a ]\n");
  // Magma's parameters are named only: IsPrime(13, 13) has no Proof := 13
  assert.match(session("IsPrime(13, 13);\n"), /error/);
  assert.equal(session("IsPrime(13 : Proof := false);\nNextPrime(13 : Proof := true);\n"), "true\n17\n");
  // where Magma takes strings and booleans, they still work
  assert.equal(
    session("Append([\"a\"], \"b\");\nIndex(\"abcd\", \"cd\");\nPosition([true, false], false);\nReverse(\"abc\");\nSprint(true);\nType(\"a\");\nInclude({\"a\"}, \"b\") eq {\"a\", \"b\"};\nStringToInteger(\"12\");\nIntseq(9, 2);\nIntegerToString(255, 16);\n"),
    "[ a, b ]\n3\n2\ncba\ntrue\nMonStgElt\ntrue\n12\n[ 1, 0, 0, 1 ]\nFF\n",
  );
});

test("every intrinsic goes through the argument guard, and help still shows its own signature", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const f = join(mkdtempSync(join(tmpdir(), "magma-guard-")), "check.py");
  writeFileSync(f, [
    "import _magma, _pyjs_help",
    "bare = [n for n in _magma.__all__ if n[:1].isupper() and not n.endswith('_') and type(getattr(_magma, n)) is type(_magma._iter)",
    "        and not hasattr(getattr(_magma, n), '__wrapped__')]",
    "print('bare', bare)",
    "print(_pyjs_help.signature(_magma.IsPrime), _pyjs_help.signature(_magma.Roots))",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), f], { encoding: "utf8" });
  assert.equal(r.stdout, "bare []\n(n, *, Proof=None) (f, R=None)\n", r.stderr);
});

test("membership in a set is a keyed lookup: a large set costs as much as a small one", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const f = join(mkdtempSync(join(tmpdir(), "magma-in-")), "time.py");
  // 10^5 lookups in a set of 10^4 elements and in one of 10 elements
  writeFileSync(f, [
    "import time, _magma as m",
    "def t(s):",
    "    t0 = time.time()",
    "    for i in range(100000):",
    "        m._in(i % 20000, s)",
    "    return time.time() - t0",
    "big, small = t(m.MSet(range(10000))), t(m.MSet(range(10)))",
    "print('ok' if big < 3 * small + 0.5 else 'slow %.3f %.3f' % (big, small))",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), f], { encoding: "utf8" });
  assert.equal(r.stdout, "ok\n", r.stderr);
});
