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
  // one of Magma's intrinsics that Sagebrush lacks: said so, also when a
  // function reads it (where the function reads it), and never run
  const lacking = run("function f(E) return HyperellipticCurve(E); end function;\nf(1);\n");
  assert.equal(lacking.status, 1);
  assert.match(lacking.stdout, /^\nIn file "<cell>", line 1, column 22:\n>> function f\(E\) return HyperellipticCurve\(E\); end function;\n {24}\^\nUser error: 'HyperellipticCurve' is a Magma intrinsic not implemented in Sagebrush\n$/);
  const runtime = run("1;\nerror \"stop\";\n2;\n");
  assert.equal(runtime.status, 1);
  assert.equal(runtime.stdout, "1\nRuntime error: stop\n");
});

test("QuadraticField's squarefree part by bounded work: a hard 78-digit semiprime is refused at once (HARD-731-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const n = "463168356949264781694283940034751674351099985030800860588560112898177302183821";
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: `K := QuadraticField(${n});\nQuadraticField(12);\n`, encoding: "utf8", timeout: 60000 });
  assert.equal(r.signal, null, "it must not run on");
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, new RegExp(`QuadraticField: the squarefree part of ${n} was not found within the limit \\(its prime factors above 100000 are not known\\); this is not supported yet`));
  assert.match(flat, /Quadratic Field with defining polynomial x\^2 - 3 over the Rational Field/);
  // more than 1024 bits: refused before any of the work, a prime too (HARD-4A9-1)
  const t0 = Date.now();
  const big = spawnSync(process.execPath, [cli, "--magma"], { input: "K := QuadraticField(2^44497 - 1);\nK := QuadraticField(2^1279 - 1);\nK := QuadraticField(-2^1100);\n1;\n", encoding: "utf8", timeout: 60000 });
  assert.equal(big.signal, null);
  // (the message wraps at 80 columns, so whitespace is flattened)
  assert.equal((big.stdout.replace(/\s+/g, " ").match(/QuadraticField of an integer of more than 1024 bits is not supported yet/g) ?? []).length, 3, big.stdout);
  assert.match(big.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < 30000);
});

test("what Sagebrush lacks is refused in words, never a Python exception, class or function", () => {
  // (the coverage run's 38 Handbook programs where Python's TypeError,
  // AttributeError or IndexError reached the user; /scratch/coverage/magma)
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const src = [
    "Integers(7);",
    "P<a, b, c> := PolynomialRing(Rationals(), 3);",
    "K := Integers(); K`__class__;",
    "x := 5; x`real;",
    "assigned x`real;",
    "x`f := 1;",
    "Newforms(1, 2);",
    "Divisors([1]);",
    "CuspidalSubspace(ModularForms(11, 2));",
    "HeckePolynomial(CuspForms(11, 2), 2);",
    "Zx<z> := PolynomialRing(Integers()); F<w> := NumberField(z^2 - 5);",
    "E := EllipticCurve([0, w]);",
    "CremonaReference(EllipticCurve([0, 0, 0, 0, 1000003]));",
    "Integers(F);",
    "SetSeed(1);",
    "Random(1, 4);",
    "Universe({ {1} });",
    "H<h> := GF(9); J<j> := GF(81); h + j;",
  ].join("\n") + "\n";
  const out = spawnSync(process.execPath, [cli, "--magma"], { input: src, encoding: "utf8" }).stdout;
  // (messages are wrapped at 80 columns, as Magma's are)
  const flat = out.replace(/\s+/g, " ");
  for (const said of [
    "Runtime error in 'Integers': Integers(m), the integers modulo m, is not supported yet",
    "Runtime error in 'PolynomialRing': PolynomialRing in more than one variable (or with weights) is not supported yet",
    "Runtime error in `: the attribute __class__ of this object (not a record) is not supported yet",
    "Runtime error in `: the attribute real of this object (not a record) is not supported yet",
    "Runtime error in `: the attribute f of this object (not a record) is not supported yet",
    "Runtime error: Newforms with these arguments is not supported yet",
    "Runtime error in 'Divisors': Divisors of a SeqEnum is not supported yet",
    "Runtime error in 'CuspidalSubspace': CuspidalSubspace of a",
    "Runtime error in 'HeckePolynomial': HeckePolynomial of a",
    "Runtime error in 'EllipticCurve': EllipticCurve with a coefficient in a FldNumElt is not supported yet",
    "Runtime error: not supported yet: this curve is not in sagebrush's table",
    "User error: 'SetSeed' is a Magma intrinsic not implemented in Sagebrush",
    "Runtime error in 'Random': Random after SetSeed or GetSeed is not supported yet",
    "Runtime error in 'Universe': Universe of this SetEnum is not supported yet",
    "Runtime error in '+': arithmetic of two finite fields of characteristic 3, neither the prime field, is not supported yet",
  ]) assert.ok(flat.includes(said), said + "\n" + out);
  // Integers(F) is F's maximal order
  assert.match(flat, /Maximal Equation Order with defining polynomial z\^2 - 5 over its ground order|Maximal Order/);
  assert.doesNotMatch(out, /[A-Z][a-z]+Error: |Traceback|<class |<built-in|object has no attribute/);
});

test("printf's precision on a real: Magma's digits where they are sure, else refused (its reals are binary)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const run = (src: string) => spawnSync(process.execPath, [cli, "--magma"], { input: src, encoding: "utf8" }).stdout.replace(/\s+/g, " ");
  // (Magma 2.18: 53.211, 123.20, 65.556, 3.142)
  assert.equal(run('printf "%.3o %.2o %.3o %.3o\\n", 53.211, 123.2, 0.53211 * 123.2, 3.14159;\n').trim(), "53.211 123.20 65.556 3.142");
  // a tie (0.125 is binary's: Magma gives 0.12, but 0.25 gives 0.3), under 1, no digit
  // after the point, a digit added by rounding, past 10^20: refused
  for (const [v, n] of [["1.125", 2], ["0.5", 2], ["2.5", 0], ["99.999", 2], ["1.0e25", 2]] as [string, number][])
    assert.match(run(`printf "%.${n}o\\n", ${v};\n`), new RegExp(`Runtime error in printf: printf's precision \\(%\\.${n}o\\) for this real is not supported yet`), v);
  assert.match(run('printf "%m\\n", 5;\n'), /printing in the level Magma \(%m\) is not supported yet/);
  assert.match(run('printf "%O\\n", 5, "Maximal";\n'), /printing in the level Maximal \(%O\) is not supported yet/);
});

test("Magma syntax Sagebrush doesn't have is named, not called bad syntax (coverage run: 254 Handbook programs)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const cases: [string, string][] = [
    ["x := 5; x; $1;", "$1 (the values printed last)"],
    ["f := func< n | n le 2 select 1 else $$(n-1) + $$(n-2) >;", "$$ in func< >"],
    ["P<[X]> := PolynomialRing(Rationals(), 2);", "P<[...]> (generator names in a sequence)"],
    ["S := {1}; S join:= {2};", "join:= (an assignment with join)"],
    ["for x, y in [1, 2] do x; end for;", "for x, y in S (several loop variables)"],
    ["M := {* 1^^4, 2^^5 *};", "a^^n (a multiplicity in a multiset)"],
    ["x := 255; x: Hex;", "x: Hex (a printing level)"],
    ["y := x where x is 10;", "where x is ... (a definition after an expression)"],
    ["x := eval \"1+1\";", "eval"],
    ["try x := 1; catch e x := 2; end try;", "try ... catch"],
    ["f := function(x, ...) return x; end function;", "... (a function with a variable number of arguments)"],
    ["z := case< 1 | 1: 2, default: 3 >;", "case< ... >"],
    ["G := [1, 2]; i := 2; G.i;", "G.i (a generator by a variable's index)"],
    ["y := Integers()!!3;", "!! (a coercion that may change the structure)"],
    ["load galpols;", "load (Magma's library files)"],
    ["for i in [1..3], j in [i+1..4] do i; end for;", "for i in S, j in T (several loops in one for)"],
    ["G := 1; G.-1;", "G.-1 (a generator's inverse by its index)"],
    ["B := 1; B.<3,1>;", "B.<...> (an element by its indices)"],
    ["x := 2; r := x = 3;", "= (an equation, as in a relation)"],
    ["F<x, y>, f := FPGroup(G);", "F<...>, ... := (generator names with other values)"],
  ];
  for (const [src, name] of cases) {
    const out = spawnSync(process.execPath, [cli, "--magma"], { input: src + "\n", encoding: "utf8" }).stdout;
    assert.match(out.replace(/\s+/g, " "), new RegExp(`User error: ${name.replace(/[$^.*+?()[\]{}|\\]/g, "\\$&")} is not supported yet`), src + "\n" + out);
    assert.doesNotMatch(out, /bad syntax/, src);
  }
  // the session goes on with the next line, as after a syntax error
  const next = spawnSync(process.execPath, [cli, "--magma"], { input: "S := {1}; S join:= {2};\n7;\n", encoding: "utf8" }).stdout;
  assert.match(next, /join:= \(an assignment with join\) is not supported yet\n7\n$/);
  // a cell (no recovery: the kernel's) says it too
  const { magmaToPython, MagmaSyntaxError } = require("../src/magma");
  assert.throws(() => magmaToPython("y := x where x is 10;\n", "<cell>"), (e: any) => e instanceof MagmaSyntaxError && /where x is \.\.\. \(a definition after an expression\) is not supported yet/.test(e.message));
});

test("finite fields: GF(p, n)'s arguments and Log's base, in Magma's words (CORR-581-1, CORR-581-5)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const out = spawnSync(process.execPath, [cli, "--magma"], { input: "G := GF(4, 2);\nG := GF(2, 0);\nG := GF(2, -1);\nF := GF(9);\nLog(F!0, F!1);\n", encoding: "utf8" }).stdout;
  for (const said of ["Runtime error in 'GF': Argument 1 (4) should be prime", "Runtime error in 'GF': Argument 2 (0) should be >= 1", "Runtime error in 'GF': Argument 2 (-1) should be >= 1", "Runtime error in 'Log': Base argument 1 must be non-zero"])
    assert.ok(out.includes(said), said + "\n" + out);
});

test("finite fields by bounded work: GF of more than 1024 bits refused before its power; Random and iteration of a large field without all its elements (HARD-581-1, HARD-581-2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  // under a 96 MB heap, as in the review
  const run = (input: string) => spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input, encoding: "utf8", timeout: 60000 });
  const t0 = Date.now();
  const big = run("F := GF(2, 1000000000);\nF := GF(2, 1025);\nF := GF(2^1100);\nF := GF(2^1100 + 1);\nF := GF(3, 1000);\nF := GF(2^44497 - 1, 2);\n1;\n");
  assert.equal(big.signal, null);
  assert.equal((big.stdout.replace(/\s+/g, " ").match(/GF of a field of more than 1024 bits is not supported yet/g) ?? []).length, 6, big.stdout);
  assert.match(big.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < 30000);
  const r = run("F := GF(1000003);\nx := Random(F);\nx in F, Parent(x) eq F;\nexists(t){ y : y in F | y^2 eq 4 }; t;\nRandom([1..10^30]) le 10^30;\nRandom([]);\nRandom({* 7, 7, 7 *});\n");
  assert.equal(r.signal, null, r.stderr);
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, /true true true 2 /);
  assert.match(flat, /Runtime error in 'Random': Argument 1 is not non-empty 7 $/);
});

test("comprehensions by bounded work: at most 10^6 elements, x, y in S admitted before iterating (HARD-FCC-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  // under a 96 MB heap, as in the review
  const run = (input: string) => spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input, encoding: "utf8", timeout: 120000 });
  const refusal = /a comprehension of more than 1000000 elements is not supported yet/g;
  // above the limit: #S^2 refused at once without a condition (each kind of
  // collection); with one, or several clauses, by the collector at 10^6 + 1
  const t0 = Date.now();
  const above = run(
    "S := [1..20000];\nT := [ <x,y> : x,y in S ];\nT := { x : x, y in [1..1001] };\nT := {@ x : x, y in {1..1001} @};\nT := {* x : x, y, z in [1..101] *};\n" +
      "T := [ x : x, y in [1..1001] | true ];\nT := [ x : x in [1..1000], y in [1..1001] ];\n1;\n",
  );
  assert.equal(above.signal, null, above.stderr);
  assert.equal((above.stdout.replace(/\s+/g, " ").match(refusal) ?? []).length, 6, above.stdout);
  assert.match(above.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < 60000);
  // just at the limit: 10^6 elements are built
  const at = run("#[ x : x, y in [1..1000] ];\n#[ y : x in [1..1000], y in [1..1000] | true ];\n#{ x*y : x, y in [1..1000] };\n");
  assert.equal(at.signal, null, at.stderr);
  assert.match(at.stdout, /^1000000\n1000000\n248083\n$/);
});

test("a long integer is laid out in lines of 79 digits and a backslash, in time linear in its length", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: "10^20000;\n", encoding: "utf8", timeout: 60000 });
  assert.equal(r.signal, null, r.stderr);
  const lines = r.stdout.split("\n").filter((l: string) => l);
  // 20001 digits: 253 full lines of 79 digits, each ending in a backslash, and 14 more
  assert.equal(lines.length, 254);
  assert.ok(lines.slice(0, -1).every((l: string) => l.length === 80 && l.endsWith("\\")));
  assert.equal(lines.map((l: string) => l.replace(/\\$/, "")).join(""), "1" + "0".repeat(20000));
  assert.ok(Date.now() - t0 < 30000);
});

test("printing a value nested deeper than 100 is refused in Magma's form, not a host RecursionError (HARD-133-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const run = (input: string) => spawnSync(process.execPath, [cli, "--magma"], { input, encoding: "utf8", timeout: 60000 });
  // (built in a loop, a value is copied as it is assigned: refused there)
  const deep = run("x := 1; for i in [1..5000] do x := [x]; end for;\nt := 1; for i in [1..5000] do t := <t>; end for;\n1;\n");
  assert.equal(deep.signal, null, deep.stderr);
  assert.equal((deep.stdout.match(/Runtime error: a value nested more than 100 deep is not supported yet/g) ?? []).length, 2, deep.stdout.slice(0, 2000));
  assert.doesNotMatch(deep.stdout + deep.stderr, /RecursionError|Traceback/);
  assert.match(deep.stdout, /\n1\n$/);
  // 100 deep still prints (at that indentation the innermost [ 1 ] is
  // laid out a chunk a line): 100 brackets each way, no error
  const ok = run("x := 1; for i in [1..100] do x := [x]; end for;\nx;\n");
  assert.equal((ok.stdout.match(/\[/g) ?? []).length, 100, ok.stdout.slice(0, 500));
  assert.equal((ok.stdout.match(/\]/g) ?? []).length, 100);
  assert.doesNotMatch(ok.stdout, /error/);
  // a tuple counts once too (CORR-90E-1): 100 deep prints, in a session and
  // by Sprintf, mixed with sequences and records; 101 deep is refused
  const t = run("v := 1; for i in [1..100] do v := <v>; end for;\n#Sprint(v) gt 0;\n#Sprintf(\"%o\", v) gt 0;\n" +
    "w := [4]; for i in [1..98] do w := [w]; end for; w := <w>; #Sprint(w) gt 0;\n" +
    "F := recformat< a >; r := <5>; for i in [1..99] do r := rec< F | a := r >; end for; #Sprint(r) gt 0;\n" +
    "u := 1; for i in [1..101] do u := <u>; end for;\n");
  assert.match(t.stdout, /^true\ntrue\ntrue\ntrue\n/, t.stdout.slice(0, 500));
  assert.equal((t.stdout.match(/a value nested more than 100 deep is not supported yet/g) ?? []).length, 1, t.stdout.slice(0, 2000));
  assert.doesNotMatch(t.stdout, /printing a value nested/);
});

test("a copy of a value that shares its parts is admitted before it is made: x := [x, x] doubled is refused quickly (HARD-756-1, _own)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input: "x := 1; for i in [1..40] do x := [x, x]; end for;\n1;\n", encoding: "utf8", timeout: 60000 });
  assert.equal(r.signal, null, r.stderr);
  assert.match(r.stdout.replace(/\s+/g, " "), /a value of more than 100000 sequences, sets, tuples and records \(a record counting as 8\) is not supported yet/);
  assert.match(r.stdout, /\n1\n$/);
  // (a value of 50000 sequences is copied as before; at the default heap,
  // since each copy of it costs tens of megabytes)
  const c = spawnSync(process.execPath, [cli, "--magma"], { input: "y := [ [i, i^2] : i in [1..50000] ]; z := y; #z;\n", encoding: "utf8", timeout: 60000 });
  assert.equal(c.stdout, "50000\n", c.stderr);
  assert.ok(Date.now() - t0 < 30000, `${Date.now() - t0} ms`);
});

test("records nested deep or sharing their parts are bounded when copied too (HARD-319-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], {
    input: "R := recformat< a, b >;\nx := 1; for i in [1..5000] do x := rec< R | a := x >; end for;\ny := 1; for i in [1..40] do y := rec< R | a := y, b := y >; end for;\nw := rec< R | a := [rec< R | a := 1 >] >; v := w; v`a[1]`a;\n",
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.signal, null, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /RecursionError|Traceback/);
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, /a value nested more than 100 deep is not supported yet/);
  assert.match(flat, /a value of more than 100000 sequences, sets, tuples and records \(a record counting as 8\) is not supported yet/);
  assert.match(r.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < 30000, `${Date.now() - t0} ms`);
});

test("index selections are admitted before they are taken, and a long chain of indexes is refused in words (HARD-A57-1, HARD-A57-2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const run = (input: string) => spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input, encoding: "utf8", timeout: 60000 });
  const t0 = Date.now();
  const sel = run('S := [1..10000000]; T := S[1..10000000];\nT := S[5..10^30];\nw := "abc"; w[2..10^20];\nT := S[10^6..2*10^6 - 1]; #T;\n');
  assert.equal(sel.signal, null, sel.stderr);
  const flat = sel.stdout.replace(/\s+/g, " ");
  assert.match(flat, /a selection of more than 1000000 elements is not supported yet/);
  assert.match(flat, /T := S\[5\.\.10\^30\]; \^ Runtime error in '\[\]': Sequence element not defined/);
  assert.match(flat, /Index 3 \(4\) should be in the range \[1 \.\. 3\]/);
  assert.match(sel.stdout, /\n1000000\n$/);
  assert.ok(Date.now() - t0 < 30000);
  // 5000 links: refused before running; 64 still work
  const long = run("S := [1];\nS" + "[1]".repeat(5000) + ";\n1;\n");
  assert.doesNotMatch(long.stdout + long.stderr, /RecursionError|Traceback/);
  assert.match(long.stdout, /User error: a chain of more than 64 calls or indexes is not supported yet/);
  assert.match(long.stdout, /\n1\n$/);
  const ok = run("x := 7; for i in [1..64] do x := [x]; end for;\nx" + "[1]".repeat(64) + ";\n");
  assert.equal(ok.stdout, "7\n");
});

test("a selection keeps its source's universe, so what doesn't belong is refused later (CORR-927-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: 'S := {@2,5@}; T := S[[]]; Include(~T, 1/2);\nA := [2/3]; A[3] := 5/4; B := A[[]]; Append(~B, "x");\nC := [2,5]; D := C[[1]]; Append(~D, 1/2);\n1;\n', encoding: "utf8", timeout: 60000 });
  const flat = r.stdout.replace(/\s+/g, " ");
  // (refused; Magma's words here are "Rational argument is not a whole
  // integer", Sagebrush's "Illegal coercion": a follow-up of Include's)
  assert.match(flat, /Runtime error in 'Include': /, r.stdout);
  assert.equal((flat.match(/Runtime error in 'Append': Cannot coerce element into the universe/g) ?? []).length, 2, r.stdout);
  assert.match(r.stdout, /\n1\n$/);
});

test("a selection's inferred universe is found once per source, not per selection (HARD-927-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  // 200000 elements, the rational last; 300 selections; and Magma's rule
  // that the inferred universe is fixed when the sequence is made and only
  // widens: K keeps the rationals after K[1] := 4, and after Remove
  const r = spawnSync(process.execPath, [cli, "--magma"], {
    input: "S := [1..200000] cat [1/2]; for i in [1..300] do T := S[[1]]; end for; Universe(T);\nI := [1..200000]; for i in [1..300] do T := I[[1]]; end for; Universe(T);\nK := [2/3, 5]; K[1] := 4; Universe(K[[]]);\nM := [2/3, 5]; Remove(~M, 1); Universe(M[[]]);\nL := [2, 5]; L[4] := 3; Universe(L[[]]);\n",
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.stdout, "Rational Field\nInteger Ring\nRational Field\nRational Field\nInteger Ring\n", r.stderr);
  assert.ok(Date.now() - t0 < 30000, `${Date.now() - t0} ms`);
});

test("Append into a fixed universe refuses what doesn't go in, a range's too (CORR-D689-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: "I := [2,5]; Append(~I, 1/2);\nI;\nR := [1..3]; Append(~R, 1/2);\nR;\n", encoding: "utf8", timeout: 60000 });
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.equal((flat.match(/Runtime error in 'Append': Cannot coerce element into the universe/g) ?? []).length, 2, r.stdout);
  assert.match(r.stdout, /\[ 2, 5 \]\n[\s\S]*\[ 1 \.\. 3 \]\n$/);
});

test("functions take the values of their free variables when they are defined", () => {
  // a capture is a keyword-only default argument: taken once, when the def runs
  // (an unbound name is decided when the def runs: lib/_magma.py _capture)
  assert.match(py("function f(n) return n + a; end function;"), /def _mf\d+\(n, \*, a=_m\._capture\(lambda: a, "a", \(1, 26\)\)\):/);
  assert.match(py("function f(n) return n + a; end function;"), /return _m\._add\(n, \(a if a is not _mU else _m\._missing\("a", \(1, 26\)\)\), \(1, 24\)\)/);
  assert.match(py("function f(n) return n + a; end function;"), /^\s*_m\._named\((_mf\d+), "f"\)\n[\s\S]*^\s*f = \1$/m);
  // the function's own name is the function itself; parameters and locals are not captured
  const rec = py("function f(n) x := n; return f(x - 1); end function;");
  assert.match(rec, /def (_mf\d+)\(n\):[\s\S]*\1\(/);
  // forward: each execution binds the name to a new cell (an unresolved
  // forward); f captures it through the name; g's top-level definition
  // fills the cell the name holds; inside a function, the cell of the
  // forward in that scope
  const fw = py("forward g;\nfunction f(n) return g(n); end function;\nfunction g(n) return n; end function;");
  assert.match(fw, /_mfw\d+ = g = _m\._Cell\("g"\)/);
  assert.match(fw, /def _mf\d+\(n, \*, g=_m\._capture\(lambda: g, "g", \(2, \d+\)\)\):/);
  assert.match(fw, /_m\._define_top\(globals\(\), "g", (_mf\d+)\)\n[\s\S]*g = \1/);
  const inner = py("function B()\n  forward w;\n  function v(n) return w(n); end function;\n  function w(n) return n; end function;\n  return v;\nend function;");
  assert.match(inner, /(_mfw\d+) = w = _m\._Cell\("w"\)[\s\S]*\1\.set\(_mf\d+\)/);
  assert.doesNotMatch(inner, /_define_top\(globals\(\), "w"/);
  // local and delete make a function's own variable
  assert.match(py("function f() delete x; return 1; end function;"), /^_m\._compile_error\(1, 21, "Identifier 'x' has not been declared or assigned"\)$/m);
  assert.throws(() => magmaToPython("function f() t := 1; local x; return t; end function;"), MagmaSyntaxError);
  assert.throws(() => magmaToPython("local x;"), MagmaSyntaxError);
  // func< > likewise
  assert.match(py("h := func< t | t + c >;\nc := 2;"), /\(lambda t, \*, c=_m\._capture\(lambda: c, "c", \(1, 20\)\): _m\._add\(t, \(c if c is not _mU else _m\._missing\("c", \(1, 20\)\)\), \(1, 18\)\)\)/);
  // assigned of a global is false; read first, then assigned: rejected
  assert.match(py("function f() return assigned a; end function;"), /return _m\._first\(False\)|return False/);
  assert.match(py("function f() x := a; a := 1; return x; end function;"), /^_m\._compile_error\(1, 22, "Imported environment value 'a' cannot be used as a local"\)$/m);
  assert.match(py("function f() s[1] := 0; return s; end function;"), /^_m\._compile_error\(1, 15, "Identifier 's' has not been declared or assigned"\)$/m);
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
  assert.match(py("F := recformat< a : Integers(), b >;"), /_m\._recformat\(\[\("a", _m\._first\(Integers\(\)\)\), \("b", None\)\], \(1, 6\)\)/);
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
  assert.match(py("f := map< A -> B | x :-> x + a >;"), /rule=lambda x, a=_m\._snap\(lambda: a, "a", \(1, \d+\)\): _m\._add\(x, _m\._val\(a, "a", \(1, \d+\)\), \(1, 28\)\)/);
  // ... but not the variables it binds itself, nor field names or named arguments
  const r = py("f := map< A -> B | x :-> #[ j : j in S | j gt x ] + r`n + Foo(x : Bar := 1) >;");
  assert.match(r, /rule=lambda x, S=_m\._snap\(lambda: S, "S", \(1, \d+\)\), r=_m\._snap\(lambda: r, "r", \(1, \d+\)\), Foo=_m\._snap\(lambda: Foo, "Foo", \(1, \d+\)\): /);
  assert.doesNotMatch(r, /j=_m|n=_m|Bar=_m|\u0000/);
  // by scope: a comprehension's j shadows only inside it; a func's parameter is its own
  assert.match(py("f := map< A -> B | x :-> j + &+[ j : j in [1..x] ] >;"), /rule=lambda x, j=_m\._snap\(lambda: j, "j", \(1, \d+\)\): _m\._add\(_m\._val\(j, "j", \(1, \d+\)\), /);
  assert.match(py("f := map< A -> B | x :-> (func<j | j + 1>)(x) >;"), /rule=lambda x: /);
  // `assigned a` first makes a the rule's own local, never assigned: nothing
  // is captured, the test is false, and a read is the unassigned error
  assert.match(py("f := map< A -> B | x :-> assigned a select a else 0 >;"), /rule=lambda x: \(_m\._val\(_m\._UNSET, "a"\) if _m\._bool\(False\) else 0\)/);
  // a read first imports a, and a later `assigned a` is rejected
  assert.match(py("f := map< A -> B | x :-> a + (assigned a select 1 else 0) >;"), /^_m\._compile_error\(1, 31, "Imported environment value 'a' cannot be used as a local"\)$/m);
  // a later delete doesn't reach a map's snapshot (value semantics)
  assert.match(py("delete a;"), /^\s*del a$/m);
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

test("notebook session: a witness left unassigned stays unassigned in later cells, compiled on their own, as in Magma (CORR-39D-1)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  // each line a cell; Magma 2.18, run on these as one session, says what's expected
  const cells = [
    "w := 99; exists(w){x:x in [1..3]|false}; assigned w;",
    "w;",
    "S := [w]; #S;",
    "assigned w;",
    "w := 17; w;",
    "forall(w){x:x in [1..3]|true}; assigned w;",
    "w;",
    "exists(u, v){<a, b> : a, b in [1..2] | false}; assigned u, assigned v;",
    "u;",
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], magma: true });
  const out = (id: number) => msgs.filter((m) => m.id === id && m.stream === "stdout").map((m) => m.text).join("");
  const failed = (id: number) => !!msgs.find((m) => m.id === id && m.done)?.error;
  assert.deepEqual(cells.map((_, i) => failed(i + 1)), [false, true, true, false, false, false, true, false, true]);
  assert.equal(out(1), "false\nfalse\n");
  for (const [id, name] of [[2, "w"], [3, "w"], [7, "w"], [9, "u"]] as [number, string][])
    assert.match(out(id), new RegExp(`User error: Identifier '${name}' has not been declared or assigned`), out(id));
  assert.equal(out(4), "false\n");
  assert.equal(out(5), "17\n");
  assert.equal(out(6), "true\nfalse\n");
  assert.equal(out(8), "false\nfalse false\n");
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

test("a value added to a collection is made like its elements, all the way down (CORR-400-1/2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const session = (src: string) =>
    spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { encoding: "utf8", input: src }).stdout as string;
  // Magma's refusals (checked against Magma); their caret is said at the call
  const refused: [string, string][] = [
    ["A := [<2,\"p\">]; Append(~A, <1/5,\"r\">);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["A := [<2,\"p\">]; Include(~A, <1/5,\"r\">);", "Runtime error in 'Include': Cannot lift element into sequence"],
    ["B := [{2,3}]; Include(~B, {7/2});", "Runtime error in 'Include': Cannot lift element into sequence"],
    ["C := [{@ 4 @}]; Append(~C, {9/4});", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["E := [[[3]]]; Append(~E, [[2/7]]);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["E := [[[3]]]; Include(~E, [[2/7]]);", "Runtime error in 'Include': Cannot lift element into sequence"],
    ["H := [{* 2 *}]; Include(~H, {* 1/9 *});", "Runtime error in 'Include': Cannot lift element into sequence"],
    // after leading holes, the first defined element fixes the universe
    ["S := []; S[3] := \"x\"; Append(~S, 4);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["T := []; T[2] := <1,\"a\">; Include(~T, <2,3>);", "Runtime error in 'Include': Cannot lift element into sequence"],
  ];
  // (each refusal is an error, and the session goes on to the next one;
  // a refused Append changes nothing)
  const out = session(refused.map(([src]) => src).join("\n") + "\nA;\n");
  for (const [src, msg] of refused) assert.ok(out.includes(msg), `${src}\n${out}`);
  assert.match(out, /\[ <2, "p"> \]\n$/);
  // elements Sagebrush knows no parent for: a value of another type is
  // refused in words, never written unchecked
  const f = session("f := map< {1} -> {1} | x :-> x >; A := [f]; A[1] := 3;\nA;\n");
  assert.match(f, /not supported yet/);
  assert.doesNotMatch(f, /\[ 3 \]/);
});

test("writes after a million leading holes don't each scan them (HARD-400-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const src = "S := []; S[1000000] := \"x\";\nfor j in [1..1000] do S[1000000+j] := \"y\"; end for; print #S;\n";
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma", "-c", src], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.stdout, "1001000\n", r.stderr);
  assert.ok(Date.now() - t0 < 15000);
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

test("an intrinsic Sagebrush lacks, captured by a function, never acts as a value: every intrinsic and every construct refuses it (CORR-55A-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const names: string[] = JSON.parse(spawnSync(process.execPath, [cli, "-c", "import json, _magma_docsearch as D; print(json.dumps(D.bound_names()))"], { encoding: "utf8" }).stdout);
  assert.ok(names.length > 100);
  const X = "HyperellipticCurve";
  // (each use in a function of its own, called; a marker before each)
  const uses = [
    ...names.flatMap((n) => [`${n}(${X})`, `${n}(1, ${X})`]),
    `[${X}]`, `{${X}}`, `{@ ${X} @}`, `{* ${X} *}`, `<${X}, 1>`, `#[${X}]`, `${X} eq 1`, `${X} ne 1`, `${X} cmpeq 1`, `${X} cmpne 1`,
    `"a" cat ${X}`, `${X} select 1 else 2`, `true select ${X} else 2`, `rec< recformat< u > | u := ${X} >`, `func< | ${X} >()`, `${X}`,
  ];
  const prog = [
    ...uses.map((u, k) => `function F${k}() return ${u}; end function;\nprint "@@${k}";\nF${k}();`),
    `function P() print ${X}; end function;\nprint "@@print";\nP();`,
    `function N() return func< | ${X} >; end function;\nprint "@@nested";\ng := N(); g();`,
    `print "@@end";`,
  ].join("\n") + "\n";
  const out = spawnSync(process.execPath, [cli, "--magma"], { input: prog, encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
  const parts = out.split(/^@@(\S+)\n/m).slice(1);
  const bad: string[] = [];
  for (let i = 0; i < parts.length - 2; i += 2) {
    const [mark, text] = [parts[i], parts[i + 1]];
    const said = text.match(/is a Magma intrinsic not implemented in Sagebrush/g)?.length ?? 0;
    const other = text.split("\n").filter((l) => l.trim() && !/^>>|^\s*\^$|is a Magma intrinsic not implemented in Sagebrush/.test(l));
    if (said !== 1 || other.length) bad.push(`${mark === "print" || mark === "nested" ? mark : uses[Number(mark)]}: ${JSON.stringify(text.slice(0, 200))}`);
  }
  assert.equal(parts.length / 2 - 1, uses.length + 2);
  assert.deepEqual(bad, []);
});
