import test from "node:test";
import assert from "node:assert/strict";
import { magmaToPython, MagmaSyntaxError } from "../src/magma";

// a wall-clock limit or a child process's timeout, scaled by
// SAGEBRUSH_TIME_SCALE where the machine or engine is slower than the test
// VMs (GitHub's test job sets 2, its engine job, a fresh wasm with overflow
// checks, 3); the memory caps are not scaled
const WALL = (ms: number) => ms * (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1);

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
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: `K := QuadraticField(${n});\nQuadraticField(12);\n`, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, "it must not run on");
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, new RegExp(`QuadraticField: the squarefree part of ${n} was not found within the limit \\(its prime factors above 100000 are not known\\); this is not supported yet`));
  assert.match(flat, /Quadratic Field with defining polynomial x\^2 - 3 over the Rational Field/);
  // more than 1024 bits: refused before any of the work, a prime too (HARD-4A9-1)
  const t0 = Date.now();
  const big = spawnSync(process.execPath, [cli, "--magma"], { input: "K := QuadraticField(2^44497 - 1);\nK := QuadraticField(2^1279 - 1);\nK := QuadraticField(-2^1100);\n1;\n", encoding: "utf8", timeout: WALL(60000) });
  assert.equal(big.signal, null);
  // (the message wraps at 80 columns, so whitespace is flattened)
  assert.equal((big.stdout.replace(/\s+/g, " ").match(/QuadraticField of an integer of more than 1024 bits is not supported yet/g) ?? []).length, 3, big.stdout);
  assert.match(big.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < WALL(30000));
});

test("what Sagebrush lacks is refused in words, never a Python exception, class or function", () => {
  // (the coverage run's 38 Handbook programs where Python's TypeError,
  // AttributeError or IndexError reached the user; /scratch/coverage/magma)
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const src = [
    "Integers(1);",
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
    "Runtime error in 'Integers': Integers(1), the zero ring, is not supported yet",
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
  const run = (input: string) => spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input, encoding: "utf8", timeout: WALL(60000) });
  const t0 = Date.now();
  const big = run("F := GF(2, 1000000000);\nF := GF(2, 1025);\nF := GF(2^1100);\nF := GF(2^1100 + 1);\nF := GF(3, 1000);\nF := GF(2^44497 - 1, 2);\n1;\n");
  assert.equal(big.signal, null);
  assert.equal((big.stdout.replace(/\s+/g, " ").match(/GF of a field of more than 1024 bits is not supported yet/g) ?? []).length, 6, big.stdout);
  assert.match(big.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < WALL(30000));
  const r = run("F := GF(1000003);\nx := Random(F);\nx in F, Parent(x) eq F;\nexists(t){ y : y in F | y^2 eq 4 }; t;\nRandom([1..10^30]) le 10^30;\nRandom([]);\nRandom({* 7, 7, 7 *});\n");
  assert.equal(r.signal, null, r.stderr);
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, /true true true 2 /);
  assert.match(flat, /Runtime error in 'Random': Argument 1 is not non-empty 7 $/);
});

test("comprehensions by bounded work: at most 10^6 elements (fewer in a small heap), x, y in S admitted before iterating (HARD-FCC-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  // under a 96 MB heap, as in the review
  const run = (input: string) => spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input, encoding: "utf8", timeout: WALL(120000) });
  // (a 96 MiB heap admits what its free part allows, less after the modules
  // are loaded: about 37000 elements in October 2026, never more than the
  // earlier 96 MiB / 2048 = 49152; one bound in all the refusals of a run)
  const refusal = /a comprehension of more than (\d+) elements is not supported yet/g;
  // above the limit: #S^2 refused at once without a condition (each kind of
  // collection); with one, or several clauses, by the collector at 10^6 + 1
  const t0 = Date.now();
  const above = run(
    "S := [1..20000];\nT := [ <x,y> : x,y in S ];\nT := { x : x, y in [1..1001] };\nT := {@ x : x, y in {1..1001} @};\nT := {* x : x, y, z in [1..101] *};\n" +
      "T := [ x : x, y in [1..1001] | true ];\nT := [ x : x in [1..1000], y in [1..1001] ];\n1;\n",
  );
  assert.equal(above.signal, null, above.stderr);
  const bounds = [...above.stdout.replace(/\s+/g, " ").matchAll(refusal)].map((m) => Number(m[1]));
  assert.equal(bounds.length, 6, above.stdout);
  assert.ok(bounds.every((b) => b === bounds[0]) && bounds[0] >= 16384 && bounds[0] <= 49152, above.stdout);
  assert.match(above.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < WALL(60000));
  // within the limit: 140^2 elements are built in 96 MiB
  const at = run("#[ x : x, y in [1..140] ];\n#[ y : x in [1..140], y in [1..140] | true ];\n#{ x*y : x, y in [1..140] };\n#[ <x, [x, x+1], x/3> : x in [1..16384] ];\n");
  assert.equal(at.signal, null, at.stderr);
  assert.match(at.stdout, /^19600\n19600\n\d+\n16384\n$/);
  // and 10^6 in an ordinary heap
  const big = spawnSync(process.execPath, [cli, "--magma"], { input: "#[ x : x, y in [1..1000] ];\n", encoding: "utf8", timeout: WALL(120000) });
  assert.equal(big.stdout, "1000000\n", big.stderr);
});

test("the comprehension bound leaves a tenth of the heap: at the bound in a heap 10% smaller, a clean refusal, never V8's out of memory (HARD-FCC-1 on GitHub)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  // (the bound is taken for a 96 MiB heap, NODE_OPTIONS's, which Sagebrush
  // reads after the command line, while V8 has the command line's 86 MiB,
  // which Node lets win; the comprehension with a condition builds its
  // elements, triples <x, [x, x+1], x/3>, the tests' costliest, one by one
  // up to the bound before it refuses: the most the bound lets a script hold)
  const r = spawnSync(process.execPath, ["--max-old-space-size=86", cli, "--magma"], {
    input: '#[ <x, [x, x+1], x/3> : x in [1..10^6] | true ];\n"end";\n', encoding: "utf8", timeout: WALL(120000),
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=96" },
  });
  assert.equal(r.signal, null, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /heap out of memory|FATAL ERROR/);
  const m = /a comprehension of more than (\d+) elements is not supported yet/.exec(r.stdout.replace(/\s+/g, " "));
  assert.ok(m && Number(m[1]) >= 16384 && Number(m[1]) <= 49152, r.stdout + r.stderr);
  assert.match(r.stdout, /\nend\n$/);
});

test("taking the live heap leaves gc exposure as it was: no context made later gets gc, and a host started with --expose-gc keeps it (astra CORR-341-1)", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const cli = join(__dirname, "..", "src", "cli.js");
  // (a preload reports gc in the root and in a fresh vm context, before
  // Magma mode loads and takes the live heap, and at exit)
  const pre = join(mkdtempSync(join(tmpdir(), "magma-gc-")), "gc-state.cjs");
  writeFileSync(pre, [
    "const vm = require('node:vm'), fs = require('node:fs');",
    "const report = (phase) => fs.writeSync(2, phase + ' root=' + typeof global.gc + ' fresh=' + vm.runInNewContext('typeof gc') + '\\n');",
    "report('before'); process.on('exit', () => report('after'));",
    "",
  ].join("\n"));
  const run = (flags: string[]) => spawnSync(process.execPath, [...flags, "--require", pre, cli, "--magma"], { input: "1;\n", encoding: "utf8", timeout: WALL(60000) });
  const plain = run([]);
  assert.equal(plain.stdout, "1\n", plain.stderr);
  assert.match(plain.stderr, /before root=undefined fresh=undefined\nafter root=undefined fresh=undefined\n/, plain.stderr);
  const exposed = run(["--expose-gc"]);
  assert.equal(exposed.stdout, "1\n", exposed.stderr);
  assert.match(exposed.stderr, /before root=function fresh=function\nafter root=function fresh=function\n/, exposed.stderr);
});

test("a long integer is laid out in lines of 79 digits and a backslash, in time linear in its length", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: "10^20000;\n", encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const lines = r.stdout.split("\n").filter((l: string) => l);
  // 20001 digits: 253 full lines of 79 digits, each ending in a backslash, and 14 more
  assert.equal(lines.length, 254);
  assert.ok(lines.slice(0, -1).every((l: string) => l.length === 80 && l.endsWith("\\")));
  assert.equal(lines.map((l: string) => l.replace(/\\$/, "")).join(""), "1" + "0".repeat(20000));
  assert.ok(Date.now() - t0 < WALL(30000));
});

test("printing a value nested deeper than 100 is refused in Magma's form, not a host RecursionError (HARD-133-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const run = (input: string) => spawnSync(process.execPath, [cli, "--magma"], { input, encoding: "utf8", timeout: WALL(60000) });
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
  // (only the refusal is timed, the point of the test: about 9.5 s on the
  // test VMs, 3 s of it starting up; GitHub's runners have taken 2.4 times
  // as long, so 40 s leaves headroom. Without the admission the doubled
  // value exhausts the 96 MiB heap or reaches the 60 s spawn timeout)
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input: "x := 1; for i in [1..40] do x := [x, x]; end for;\n1;\n", encoding: "utf8", timeout: WALL(60000) });
  const took = Date.now() - t0;
  assert.equal(r.signal, null, r.stderr);
  assert.match(r.stdout.replace(/\s+/g, " "), /a value of more than 50000 sequences, sets, tuples and records \(a record counting as 8\) is not supported yet/);
  assert.match(r.stdout, /\n1\n$/);
  assert.ok(took < 40000, `${took} ms`);
  // (a value of 40000 sequences is copied as before; at the default heap,
  // since each copy of it costs tens of megabytes; untimed, under its own
  // spawn timeout only)
  const c = spawnSync(process.execPath, [cli, "--magma"], { input: "y := [ [i, i^2] : i in [1..40000] ]; z := y; #z;\n", encoding: "utf8", timeout: WALL(120000) });
  assert.equal(c.signal, null, c.stderr);
  assert.equal(c.stdout, "40000\n", c.stderr);
});

test("records nested deep or sharing their parts are bounded when copied too (HARD-319-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], {
    input: "R := recformat< a, b >;\nx := 1; for i in [1..5000] do x := rec< R | a := x >; end for;\ny := 1; for i in [1..40] do y := rec< R | a := y, b := y >; end for;\nw := rec< R | a := [rec< R | a := 1 >] >; v := w; v`a[1]`a;\n",
    encoding: "utf8",
    timeout: WALL(60000),
  });
  assert.equal(r.signal, null, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /RecursionError|Traceback/);
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, /a value nested more than 100 deep is not supported yet/);
  assert.match(flat, /a value of more than 50000 sequences, sets, tuples and records \(a record counting as 8\) is not supported yet/);
  assert.match(r.stdout, /\n1\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("index selections are admitted before they are taken, and a long chain of indexes is refused in words (HARD-A57-1, HARD-A57-2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const run = (input: string) => spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input, encoding: "utf8", timeout: WALL(60000) });
  const t0 = Date.now();
  const sel = run('S := [1..10000000]; T := S[1..10000000];\nT := S[5..10^30];\nw := "abc"; w[2..10^20];\nT := S[10^6..2*10^6 - 1];\nT := S[10^6..10^6 + 19999]; #T;\n');
  assert.equal(sel.signal, null, sel.stderr);
  const flat = sel.stdout.replace(/\s+/g, " ");
  // (the limit in a 96 MiB heap, from its free part: at most 49152 elements,
  // HARD-A57-1; a selection of 10^6 aborted V8 there on Node 24)
  const selBounds = [...flat.matchAll(/a selection of more than (\d+) elements is not supported yet/g)].map((m) => Number(m[1]));
  assert.ok(selBounds.length === 2 && selBounds[0] === selBounds[1] && selBounds[0] <= 49152, sel.stdout);
  assert.match(flat, /T := S\[5\.\.10\^30\]; \^ Runtime error in '\[\]': Sequence element not defined/);
  assert.match(flat, /Index 3 \(4\) should be in the range \[1 \.\. 3\]/);
  assert.match(sel.stdout, /\n20000\n$/);
  assert.ok(Date.now() - t0 < WALL(30000));
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
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: 'S := {@2,5@}; T := S[[]]; Include(~T, 1/2);\nA := [2/3]; A[3] := 5/4; B := A[[]]; Append(~B, "x");\nC := [2,5]; D := C[[1]]; Append(~D, 1/2);\n1;\n', encoding: "utf8", timeout: WALL(60000) });
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
    timeout: WALL(60000),
  });
  assert.equal(r.stdout, "Rational Field\nInteger Ring\nRational Field\nRational Field\nInteger Ring\n", r.stderr);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("Append into a fixed universe refuses what doesn't go in, a range's too (CORR-D689-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: "I := [2,5]; Append(~I, 1/2);\nI;\nR := [1..3]; Append(~R, 1/2);\nR;\n", encoding: "utf8", timeout: WALL(60000) });
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
    // a child emptied of its elements keeps its universe (CORR-9348-FU1)
    ["Z := [[\"q\"]]; Remove(~Z[1], 1); Append(~Z, [3]);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["K := GF(11); Af := [K|4,6]; Append(~Af, 1/11);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    // an empty selection keeps the universe of what it was selected from
    ["Ss := [<2/3,\"q\">]; Ss[1] := <4,\"r\">; W := Ss[[]]; Append(~W, <5,6>);", "Runtime error in 'Append': Cannot coerce element into the universe"],
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
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma", "-c", src], { encoding: "utf8", timeout: WALL(15000) });
  assert.equal(r.stdout, "1001000\n", r.stderr);
  assert.ok(Date.now() - t0 < WALL(15000));
});

test("admitting a value refuses past 100 deep in words, whatever bounds its callers have (HARD-934-1)", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const f = join(mkdtempSync(join(tmpdir(), "magma-like-")), "check.py");
  writeFileSync(f, [
    "import _magma as m",
    "def deep(n, mk):",
    "    x = 1",
    "    for _ in range(n):",
    "        x = mk(x)",
    "    return x",
    "no = lambda: m.MagmaError('refused')",
    "for mk in (lambda x: m.MSeq([x]), lambda x: m.MTuple([x])):",
    "    for n in (98, 99, 5000):",
    "        try:",
    "            m._like(mk(deep(n, mk)), mk(deep(n, mk)), no)",
    "            print(n, 'admitted')",
    "        except m.MagmaError as e:",
    "            print(n, e)",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), f], { encoding: "utf8", timeout: WALL(60000) });
  // (an element is at level 2: 99 sequences around 1 make it 100 deep)
  const said = "a value nested more than 100 deep is not supported yet";
  assert.equal(r.stdout, `98 admitted\n99 ${said}\n5000 ${said}\n`.repeat(2), r.stderr);
});

test("a range with a huge real endpoint, or a set of a huge range, is refused in words before it is made (HARD-1CD-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], {
    input: "[1.0 .. 1e100000000];\n[1.0 .. (1e10000)^20];\n{1 .. 100000000};\n{@ 1 .. 100000000 @};\n{* 1 .. 100000000 *};\n[1.0 .. 1e-100000000];\n[1.0 .. (1e-10000)^20];\n#[1 .. 100000000];\n\"end\";\n",
    encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  assert.equal((out.match(/a real literal with an exponent of more than 10000 is not supported yet/g) ?? []).length, 2, r.stdout);
  assert.match(out, /a range endpoint of more than 100000 digits is not supported yet/);
  const setBounds = [...out.matchAll(/a set of more than (\d+) elements is not supported yet/g)].map((m) => Number(m[1]));
  assert.ok(setBounds.length === 3 && setBounds.every((b) => b === setBounds[0] && b <= 49152), r.stdout);
  assert.match(out, /Sequence range does not consist of integers/);
  // (a sequence's range stays lazy: its size is known at once)
  assert.match(r.stdout, /\n100000000\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("a rational with huge parts made a real is refused in words, before any decimal conversion (HARD-C68-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const src = "x := (2^2000000 + 1)/3; y := 3/(2^2000000 + 1);\nRealField()!x;\nRealField()!y;\nx^(1/2);\n2^y;\nExp(y);\nLog(x);\n\"end\";\n";
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /ValueError|Traceback|SystemError/);
  const said = /a real from a rational with a numerator or denominator of more than 1000000 bits is not supported yet/g;
  assert.equal((r.stdout.replace(/\s+/g, " ").match(said) ?? []).length, 6, r.stdout.slice(0, 2000));
  assert.match(r.stdout, /\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("integer intrinsics refuse arguments as Magma does, in its words, not with a plausible answer or Python's error", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // [input, intrinsic, Magma 2.18's message] (its caret is at the call, which Sagebrush doesn't say yet)
  const cases: [string, string, string][] = [
    ["NextPrime(-5);", "NextPrime", "Argument 1 (-5) should be >= 0"],
    ["PreviousPrime(2);", "PreviousPrime", "Argument 1 (2) should be >= 3"],
    ["PrimesUpTo(0);", "PrimesUpTo", "Limit must be positive"],
    ["PrimesInInterval(0, 10);", "PrimesInInterval", "Lower limit must be positive"],
    ["PrimesInInterval(10, 5);", "PrimesInInterval", "Upper limit < Lower Limit !"],
    ["NthPrime(-1);", "NthPrime", "Argument 1 (-1) should be >= 0"],
    ["Factorization(0);", "Factorization", "Argument 1 is not non-zero"],
    ["Factorization(7/2);", "Factorization", "Bad argument types\nArgument types given: FldRatElt"],
    ["Divisors(-12);", "Divisors", "Argument 1 (-12) should be >= 1"],
    ["PrimeDivisors(0);", "PrimeDivisors", "Argument 1 is not non-zero"],
    ["NumberOfDivisors(0);", "NumberOfDivisors", "Argument 1 is not positive"],
    ["SumOfDivisors(-12);", "SumOfDivisors", "Argument 1 is not positive"],
    ["MoebiusMu(0);", "MoebiusMu", "Argument 1 (0) should be >= 1"],
    ["IsPrimePower(1);", "IsPrimePower", "Argument 1 (1) should be >= 2"],
    ["Gcd(12, 18, 8);", "Gcd", "Bad argument types\nArgument types given: RngIntElt, RngIntElt, RngIntElt"],
    ["Lcm(4, 6, 10);", "Lcm", "Bad argument types\nArgument types given: RngIntElt, RngIntElt, RngIntElt"],
    ["Modexp(2, 10, 1);", "Modexp", "Argument 3 (1) should be >= 2"],
    ["Modexp(2, 3, -7);", "Modexp", "Argument 3 (-7) should be >= 2"],
    ["Modinv(3, -7);", "Modinv", "Argument 2 (-7) should be >= 1"],
    ["Modinv(2, 4);", "Modinv", "Argument 1 is not a unit mod argument 2"],
    ["Factorial(-1);", "Factorial", "Argument 1 (-1) should be >= 0"],
    ["EulerPhi(0);", "EulerPhi", "Argument 1 is not positive"],
    ["Isqrt(-1);", "Isqrt", "Argument 1 is not non-negative"],
    ["Seqint([1, -1]);", "Seqint", "Sequence digit 2 should be >= 0 and < 10"],
    ["ChineseRemainderTheorem([1, 2], [0, 5]);", "ChineseRemainderTheorem", "Element of second argument (moduli M) is zero"],
    ["Valuation(24, 4);", "Valuation", "Argument 2 (4) should be prime"],
    ["Valuation(24, -2);", "Valuation", "Argument 2 is not positive"],
    ["Max([]);", "Max", "Argument 1 is not non-empty"],
    ["Minimum([]);", "Minimum", "Argument 1 is not non-empty"],
    ["StringToInteger(\"12a\");", "StringToInteger", "String \"12a\" does not represent an number in base 10"],
    ["StringToInteger(\"1_2\");", "StringToInteger", "String \"1_2\" does not represent an number in base 10"],
    ["StringToInteger(\"12\", 37);", "StringToInteger", "Argument 2 (37) should be in the range [2 .. 36]"],
    ["ChineseRemainderTheorem([], []);", "ChineseRemainderTheorem", "Sequence argument 1 must be non-empty"],
    ["Modinv(3/2, 1);", "Modinv", "Bad argument types\nArgument types given: FldRatElt, FldRatElt"],
    ["StringToInteger(\" \");", "StringToInteger", "String \" \" does not represent an number in base 10"],
  ];
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"],
    { input: cases.map((c) => c[0]).join("\n") + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  // (Magma wraps a long message at 80 columns; compared unwrapped)
  const flat = out.replace(/ ?\n(?!>>|Runtime|Argument types|\n|end)/g, " ");
  for (const [src, name, said] of cases)
    assert.ok(flat.includes(`Runtime error in '${name}': ${said}\n`), `${src}\n${out}`);
  assert.doesNotMatch(out, /Error:|Traceback|UserWarning/);
  assert.match(out, /\nend\n$/);
});

test("polynomial, finite field and real intrinsics refuse arguments as Magma does, and roots are never sought in a ring they weren't asked for", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // [input, intrinsic, Magma 2.18's message] (its caret is at the call, which Sagebrush doesn't say yet)
  const cases: [string, string, string][] = [
    ["Roots(P!0);", "Roots", "Argument 1 is not non-zero"],
    ["Roots(t^2 - 1/4, Integers());", "Roots", "Argument 1 cannot be coerced to be over argument 2"],
    ["Coefficient(x^2, -1);", "Coefficient", "Argument 2 (-1) should be >= 0"],
    ["LeadingCoefficient(P!0);", "LeadingCoefficient", "Argument 1 is not non-zero"],
    ["Derivative(x^2, -1);", "Derivative", "Argument 2 (-1) should be >= 0"],
    ["Discriminant(P!3);", "Discriminant", "Degree of argument is less than 1"],
    ["IsIrreducible(P!0);", "IsIrreducible", "Argument 1 is not non-zero"],
    ["Factorization(Q!0);", "Factorization", "Argument 1 is not non-zero"],
    ["GF(1);", "GF", "Argument 1 (1) should be >= 2"],
    ["Order(GF(7)!0);", "Order", "Can not take order of zero element"],
    ["Log(0.0);", "Log", "Argument 1 is not positive"],
    ["Log(1.0, 5.0);", "Log", "Base for logarithm should not be 1"],
    ["Log(-2.0, 8.0);", "Log", "Argument 1 is not positive"],
    ["Log(2.0, -8.0);", "Log", "Argument 2 is not positive"],
  ];
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"],
    { input: "P<x> := PolynomialRing(Integers()); Q<t> := PolynomialRing(Rationals());\n" + cases.map((c) => c[0]).join("\n") +
      "\nRoots(x^2 - 2, RealField(10));\nSqrt(-4);\n\"end\";\n", encoding: "utf8" }).stdout as string;
  for (const [src, name, said] of cases)
    assert.ok(out.includes(`Runtime error in '${name}': ${said}\n`), `${src}\n${out}`);
  // (Magma's answers are real or complex numbers, which these don't give: refused in words)
  // (long messages wrap at 80 columns, as Magma's do: compared unwrapped)
  const flat = out.replace(/\s+/g, " ");
  assert.ok(flat.includes("Runtime error in 'Roots': Roots in a ring other than the integers or the rationals is not supported yet "), out);
  assert.ok(flat.includes("Runtime error in 'Sqrt': Sqrt of a negative number (a complex number in Magma) is not supported yet "), out);
  assert.doesNotMatch(out, /Error:|Traceback/);
  assert.match(out, /\nend\n$/);
});

test("prime enumeration is admitted by the heap before any sieve, and a narrow window near 10^12 is sieved alone (HARD-3BE-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const t0 = Date.now();
  const src = "PrimesUpTo(10^12);\nPrimesInInterval(1, 10^13);\nPrimesInInterval(10^12, 10^12 + 10^9);\nNthPrime(10^9);\n" +
    "PrimesInInterval(10^12, 10^12 + 100);\n\"end\";\n";
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  for (const name of ["PrimesUpTo", "PrimesInInterval"])
    assert.equal(out.split(`Runtime error in '${name}': ${name} up to `).length - 1, name === "PrimesUpTo" ? 1 : 2, out);
  assert.equal(out.split("needs more memory than Sagebrush has: not supported yet").length - 1, 4, out);
  assert.ok(out.includes("Runtime error in 'NthPrime': NthPrime(1000000000) needs more memory"), out);
  assert.match(r.stdout, /\[ 1000000000039, 1000000000061, 1000000000063, 1000000000091 \]\nend\n$/);
  // (the shared sieve: Sage mode's prime_range too)
  const sage = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "-c",
    "import sage_all as S\nprint(S.prime_range(10**12, 10**12 + 100))\ntry:\n    S.prime_range(10**12)\nexcept MemoryError as e:\n    print('MemoryError', e)\n" +
    "try:\n    S.nth_prime(10**9)\nexcept MemoryError as e:\n    print('MemoryError', e)\nprint(S.nth_prime(10000), S.primes_first_n(5))\n"], { encoding: "utf8", timeout: WALL(60000) });
  assert.equal(sage.signal, null, sage.stderr);
  assert.match(sage.stdout, /^\[1000000000039, 1000000000061, 1000000000063, 1000000000091\]\nMemoryError prime_range over \[2, 1000000000000\) is not supported in Sagebrush/);
  assert.match(sage.stdout, /\nMemoryError nth_prime over \[2, \d+\) is not supported in Sagebrush[^\n]*\n104729 \[2, 3, 5, 7, 11\]\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("a real field of a huge precision is refused in words before any of its numbers is made (HARD-762-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const src = "R := RealField(100000000); R!1;\nRealField(1001);\nprintf \"%.100000000o\\n\", 1.5;\n" +
    "S := RealField(1000); x := S!2; y := Sqrt(x); z := Exp(S!1); w := Log(x); #Sprint(y); #Sprint(z); #Sprint(w);\n\"end\";\n";
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  assert.equal((out.match(/a real field of precision more than 1000 is not supported yet/g) ?? []).length, 2, r.stdout.slice(0, 2000));
  assert.match(out, /printf's precision \(%\.100000000o\) for this real is not supported yet/);
  // (Magma's own refusals of a precision; its caret is at the call, which
  // Sagebrush doesn't say yet)
  const bad = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"],
    { input: "RealField(0);\nRealField(-3);\nRealField(3/2);\nRealField(2.0);\n", encoding: "utf8" }).stdout;
  assert.equal(bad.split("Runtime error in 'RealField': Argument 1 is not positive\n").length, 3, bad);
  assert.ok(bad.includes("Runtime error in 'RealField': Bad argument types\nArgument types given: FldRatElt\n"), bad);
  assert.ok(bad.includes("Runtime error in 'RealField': Bad argument types\nArgument types given: FldReElt\n"), bad);
  // (precision 1000 itself still works, quickly: its numbers print 1000 digits, with a point)
  assert.match(r.stdout, /\n100[1-9]\n100[1-9]\n100[1-9]\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("a real power too large to make is refused in words, quickly (CORR-C682-2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], {
    input: "10.0^(2^29);\n0.1^(2^29);\n1.0001^(2^29) gt 1;\n\"end\";\n", encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /Error:|Traceback/);
  assert.equal((r.stdout.replace(/\s+/g, " ").match(/a real with a binary exponent of more than 1000000 is not supported yet/g) ?? []).length, 2, r.stdout);
  // (within the bound: about 10^23316, made in 29 squarings)
  assert.match(r.stdout, /\ntrue\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("intrinsics taking integers refuse a rational, an integral one too (CORR-765-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const session = (src: string) =>
    spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { encoding: "utf8", input: src }).stdout as string;
  // Magma's words (checked against Magma); their caret is said at the call
  const one = ["Factorial", "IsEven", "IsOdd", "Factorization", "Divisors", "NextPrime", "Isqrt", "Fibonacci",
    "PrimeDivisors", "PreviousPrime", "NumberOfDivisors", "PrimesUpTo", "IsProbablePrime"];
  const out = session("a := 12/3;\n" + one.map((f) => `${f}(a);`).join("\n") + "\nBinomial(a, 2);\nGcd(a, 6);\n\"end\";\n");
  for (const f of one) assert.ok(out.includes(`Runtime error in '${f}': Bad argument types\nArgument types given: FldRatElt\n`), `${f}\n${out}`);
  assert.ok(out.includes("Runtime error in 'Binomial': Bad argument types\nArgument types given: FldRatElt, RngIntElt\n"), out);
  assert.ok(out.includes("Runtime error in 'Gcd': Bad argument types\nArgument types given: FldRatElt, FldRatElt\n"), out);
  assert.match(out, /\nend\n$/);
  // integers still work
  assert.equal(session("Factorial(4); IsEven(4); Gcd(4, 6); Binomial(4, 2);\n"), "24\ntrue\n2\n6\n");
});

test("a constructor not implemented yet is refused in words (the signature registry's helper doesn't shadow it)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"],
    { input: "G := Graph<4 | [ {1, 2}, {2, 3} ]>;\n\"end\";\n", encoding: "utf8" }).stdout as string;
  assert.ok(out.includes("Graph< ... > is not supported yet"), out);
  assert.doesNotMatch(out, /AssertionError|Traceback|Error: /);
  assert.match(out, /\nend\n$/);
});

test("vectors keep their ring, residue collections their universe, permutations their degree: Magma's refusals (CORR-DFC-1..4)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // [input, where, Magma 2.18's message] (its caret is at the operation, which Sagebrush doesn't say yet)
  const cases: [string, string, string][] = [
    ["u + w;", "'+'", "Bad argument types\nArgument types given: ModTupRngElt[RngInt], ModTupFldElt[FldRat]"],
    ["u eq Vector(Rationals(), [1, 2]);", "'eq'", "Bad argument types\nArgument types given: ModTupRngElt[RngInt], ModTupFldElt[FldRat]"],
    ["u * Matrix(Rationals(), 2, 2, [1, 0, 0, 1]);", "'*'", "Arguments have incompatible coefficient rings"],
    ["(1/2) * u;", "'*'", "Arguments are not compatible\nArgument types given: FldRatElt, ModTupRngElt[RngInt]"],
    ["u * (1/2);", "'*'", "Arguments are not compatible\nArgument types given: ModTupRngElt[RngInt], FldRatElt"],
    ["Solution(Matrix(Integers(), 2, 2, [2, 0, 0, 2]), Vector(Rationals(), [1, 1]));", "'Solution'", "Arguments have incompatible coefficient rings"],
    ["Sym(1)![true];", "'!'", "Illegal coercion\nLHS: GrpPerm\nRHS: [BoolElt]"],
    ["Sym(3)![2/1, 3/1, 1/1];", "'!'", "Illegal coercion\nLHS: GrpPerm\nRHS: [FldRatElt]"],
    ["Sym(3)![2.0, 3.0, 1.0];", "'!'", "Illegal coercion\nLHS: GrpPerm\nRHS: [FldReElt]"],
    ["Sym(3)!(1, 2) eq Sym(4)!(1, 2);", "'eq'", "Arguments are not compatible\nArgument types given: GrpPermElt, GrpPermElt"],
    ["Integers(5)!(Integers(12)!7);", "'!'", "Illegal coercion\nLHS: RngIntRes\nRHS: RngIntResElt"],
    ["Intseq(7, 2, 3/1);", "'Intseq'", "Bad argument types\nArgument types given: RngIntElt, RngIntElt, FldRatElt"],
  ];
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { encoding: "utf8",
    input: "u := Vector(Integers(), [1, 2]); w := Vector(Rationals(), [1/2, 1]);\n" + cases.map((c) => c[0]).join("\n") + "\n\"end\";\n" }).stdout as string;
  for (const [src, where, said] of cases)
    assert.ok(out.includes(`Runtime error in ${where}: ${said}\n`), `${src}\n${out}`);
  assert.doesNotMatch(out, /Error: |Traceback|Fraction\(/);
  assert.match(out, /\nend\n$/);
});

test("Vector, Subsets and Solution are admitted before they copy or compute (HARD-DFC-1, -2, -3)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const t0 = Date.now();
  const src = "v := Vector([1..10^9]);\nv := Vector(Integers(), [1..10^9]);\nS := {1..300}; T := Subsets(S, 299);\nT := Subsets({1..40});\n#Subsets(S, 300); #Subsets({1..8});\n" +
    // (many small subsets: their sets are charged with their elements)
    "U := {1..30000}; T := Subsets(U, 1);\nT := Subsets(U, 0); #T; #Subsets({1..300}, 1);\n" +
    "Solution(Matrix(Rationals(), 80, 80, [i eq j select 1 else 0 : i, j in [1..80]]), Vector(Rationals(), [1 : i in [1..80]]));\n\"end\";\n";
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  assert.equal((out.match(/a vector of more than \d+ entries is not supported yet/g) ?? []).length, 2, r.stdout);
  assert.equal((out.match(/a set of subsets holding more than \d+ elements in all is not supported yet/g) ?? []).length, 3, r.stdout);
  assert.match(out, /Solution of a system of more than 200000 \(rows times columns times the smaller\) steps is not supported yet/);
  assert.match(r.stdout, /\n1\n256\n/);
  assert.match(r.stdout, /\n1\n300\n/);
  assert.match(r.stdout, /\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("the intrinsics agents reached for refuse as Magma does, and a missing one names the catalog's alternative", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  // [input, where, Magma 2.18's message] (its caret is at the call, which Sagebrush doesn't say yet)
  const cases: [string, string, string][] = [
    ["(R!4)^-1;", "'^'", "Can not take negative power of non-unit"],
    ["(R!4) / 2;", "'/'", "Tried to divide by non-unit (2)"],
    ["R!(1/2);", "'!'", "Denominator is not a unit\nLHS: RngIntRes\nRHS: FldRatElt"],
    ["R!3 + Integers(7)!1;", "'+'", "Arguments are not compatible\nArgument types given: RngIntResElt, RngIntResElt"],
    ["R!3 + 1/2;", "'+'", "Bad argument types\nArgument types given: RngIntResElt, FldRatElt"],
    ["Modexp(R!5, 3, 12);", "'Modexp'", "Bad argument types\nArgument types given: RngIntResElt, RngIntElt, RngIntElt"],
    ["Order(R!0);", "'Order'", "Can not take order of zero element"],
    ["Submatrix(M, 2, 2, 3, 3);", "'Submatrix'", "Argument 4 (3) should be in the range [0 .. 2]"],
    ["Submatrix(M, 0, 1, 1, 1);", "'Submatrix'", "Argument 2 (0) should be in the range [1 .. 4]"],
    ["Solution(Matrix(Rationals(), 2, 2, [1, 2, 2, 4]), Vector(Rationals(), [1, 3]));", "'Solution'", "No solution exists"],
    ["Subsets([1, 2]);", "'Subsets'", "Bad argument types\nArgument types given: SeqEnum[RngIntElt]"],
    ["Subsets({1, 2}, -1);", "'Subsets'", "Argument 2 (-1) should be >= 0"],
    ["Sym(0);", "'Sym'", "Argument 1 (0) should be >= 1"],
    ["G!(1, 5);", "elt< ... >", "Bad arguments to cycle or commutator construction"],
    ["G![2, 2, 3, 4];", "'!'", "Illegal coercion\nLHS: GrpPerm\nRHS: [RngIntElt]"],
    ["5^(G!(1, 2));", "'^'", "Cannot apply permutation to this object"],
    ["#Vector([1, 2]);", "'#'", "Bad argument types\nArgument types given: ModTupRngElt[RngInt]"],
    ["Intseq(5, 2, -1);", "'Intseq'", "Argument 3 (-1) is not small and non-negative"],
  ];
  const run = (src: string) => spawnSync(process.execPath, [cli, "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  const out = run("R := Integers(12); M := Matrix(Integers(), 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9]); G := Sym(4);\n" + cases.map((c) => c[0]).join("\n") + "\n\"end\";\n");
  for (const [src, where, said] of cases)
    assert.ok(out.includes(`Runtime error in ${where}: ${said}\n`), `${src}\n${out}`);
  assert.doesNotMatch(out, /Error: |Traceback/);
  assert.match(out, /\nend\n$/);
  // Sagebrush's own refusals, in words
  const own = run("Integers(1);\nSolution(Matrix(Rationals(), 2, 2, [1, 2, 2, 4]), Vector(Rationals(), [1, 2]));\n" +
    "G := Graph<3 | [ {1, 2} ]>;\nLegendreSymbol(3, 7);\n\"end\";\n");
  // (long messages wrap at 80 columns: compared unwrapped)
  assert.ok(own.replace(/\s+/g, " ").includes("Integers(1), the zero ring, is not supported yet"), own);
  assert.ok(own.replace(/\s+/g, " ").includes("Solution of a system with more than one solution is not supported yet"), own);
  // (a missing function's refusal names what to use instead: agents read refusals)
  assert.ok(own.replace(/\s+/g, " ").includes("Graph< ... > is not supported yet; instead: Sage mode's Graph"), own);
  assert.ok(own.replace(/\s+/g, " ").includes("'LegendreSymbol' is a Magma intrinsic not implemented in Sagebrush; instead: Modexp(n, (m - 1) div 2, m)"), own);
  assert.match(own, /\nend\n$/);
});

test("polynomials over a finite field refuse what Magma refuses, in its words, and what Sagebrush doesn't do yet, in words", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // [statement, where, what Magma says] (checked against Magma 2.18)
  const cases = [
    ["x + y;", "'+'", "Arguments are not compatible\nArgument types given: RngUPolElt[FldFin], RngUPolElt[FldFin]"],
    ["f div 0;", "'div'", "Division by zero"],
    ["x/0;", "'/'", "Argument 2 is not a unit"],
    ["Roots(R!0);", "'Roots'", "Argument 1 is not non-zero"],
    ["Factorization(R!0);", "'Factorization'", "Argument 1 is not non-zero"],
    ["x + GF(5)!1;", "'+'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], FldFinElt"],
    ["x^-1;", "'^'", "Argument 2 (-1) should be >= 0"],
    ["#R;", "'#'", "Cardinality is infinite or not feasibly computable"],
    ["x + 0.5;", "'+'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], FldReElt"],
    ["x^(1/2);", "'^'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], RngUPolElt[FldFin]"],
    ["x + 1/7;", "'+'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], FldRatElt"],
    ["f(3);", "'@'", "Bad argument types\nArgument types given: RngIntElt, RngUPolElt[FldFin]"],
    ["Evaluate(f, GF(5)!1);", "'Evaluate'", "Incompatible rings"],
    ["Evaluate(f, 1/2);", "'Evaluate'", "Incompatible rings"],
    ["LeadingCoefficient(R!0);", "'LeadingCoefficient'", "Argument 1 is not non-zero"],
    ["R.2;", "'.'", "Value for name index (2) should be in the range [1..1]"],
    ["1/2 in R;", "'in'", "Bad argument types"],
    ["x eq GF(5)!1;", "'eq'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], FldFinElt"],
    ["2^x;", "'^'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], RngUPolElt[FldFin]"],
    // (every argument's type checked, nested ones too: CORR-53E-1, -2, -4, -5)
    ["Coefficient(x, 1/1);", "'Coefficient'", "Bad argument types\nArgument types given: RngUPolElt[FldFin], FldRatElt"],
    ["LeadingCoefficient(R);", "'LeadingCoefficient'", "Bad argument types\nArgument types given: RngUPol[FldFin]"],
    ["IsZero(R);", "'IsZero'", "Bad argument types\nArgument types given: RngUPol[FldFin]"],
    ["Coefficients(R);", "'Coefficients'", "Bad argument types\nArgument types given: RngUPol[FldFin]"],
    ["#x;", "'#'", "Bad argument types\nArgument types given: RngUPolElt[FldFin]"],
    ["Gcd(<x>);", "'Gcd'", "Bad argument types\nArgument types given: Tup"],
    ["PolynomialRing(GF(5)) eq PolynomialRing(GF(7));", "'eq'", "Arguments are not compatible\nArgument types given: RngUPol[FldFin], RngUPol[FldFin]"],
    ["PolynomialRing(GF(5)) eq PolynomialRing(GF(25));", "'eq'", "Arguments are not compatible\nArgument types given: RngUPol[FldFin], RngUPol[FldFin]"],
    ["x eq y;", "'eq'", "Arguments are not compatible\nArgument types given: RngUPolElt[FldFin], RngUPolElt[FldFin]"],
    ["[x, 1/2];", "[ ... ]", "No valid universe containing all elements"],
    // (AssignNames: a procedure of one name, checked: CORR-53E-1)
    ["AssignNames(~R, [\"t\", \"u\"]);", "'AssignNames'", "Argument 2 must have length 1"],
    ["AssignNames(~R, []);", "'AssignNames'", "Argument 2 must have length 1"],
    ["AssignNames(~R, [1]);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, SeqEnum[RngIntElt]"],
    ["AssignNames(R, [\"t\"]);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin], SeqEnum[MonStgElt]"],
    // (whatever the container, whichever argument is a reference, however
    // the procedure is reached: checked as the call is made, CORR-53E-1)
    ["AssignNames(~R, <\"t\">);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, Tup"],
    ["AssignNames(~R, 1);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, RngIntElt"],
    // (the generic checks mark references too; types before lengths)
    ["AssignNames(~R, \"t\");", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, MonStgElt"],
    ["AssignNames(~R, true);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, BoolElt"],
    ["AssignNames(~R, [\"t\"], 1);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, SeqEnum[MonStgElt], RngIntElt"],
    ["AssignNames(~R, [1, 2]);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, SeqEnum[RngIntElt]"],
    ["AssignNames(~R);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~"],
    ["Gcd([RngIntElt]);", "'Gcd'", "Bad argument types\nArgument types given: SeqEnum[Cat]"],
    ["Gcd(RngIntElt);", "'Gcd'", "Bad argument types\nArgument types given: Cat[RngIntElt]"],
    ["Gcd(5);", "'Gcd'", "Bad argument types\nArgument types given: RngIntElt"],
    ["Gcd([1, 2], 3);", "'Gcd'", "Bad argument types\nArgument types given: SeqEnum[RngIntElt], RngIntElt"],
    ["Lcm([RngIntElt]);", "'Lcm'", "Bad argument types\nArgument types given: SeqEnum[Cat]"],
    // (of nothing, no Gcd or Lcm: Magma's error, never 0 or 1)
    ["Gcd([]);", "'Gcd'", "Illegal null set/sequence"],
    ["Gcd({});", "'Gcd'", "Illegal null set/sequence"],
    ["Lcm([]);", "'Lcm'", "Illegal null set/sequence"],
    ["Lcm({});", "'Lcm'", "Illegal null set/sequence"],

    ["AssignNames(~R, {\"t\"});", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, SetEnum[MonStgElt]"],
    ["names := [\"t\"]; AssignNames(R, ~names);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin], SeqEnum[MonStgElt] ~"],
    ["AssignNames(~R, ~names);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin] ~, SeqEnum[MonStgElt] ~"],
    ["an := AssignNames; an(R, [\"t\"]);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin], SeqEnum[MonStgElt]"],
    ["(AssignNames)(R, [\"t\"]);", "'AssignNames'", "Bad argument types\nArgument types given: RngUPol[FldFin], SeqEnum[MonStgElt]"],
  ];
  // what Sagebrush doesn't do yet: refused in words, never computed wrongly
  const own = [
    ["x lt x^2;", "ordering of polynomials and matrices is not supported yet"],
    ["x/(x+1);", "dividing polynomials over a finite field (rational functions) is not supported yet"],
    ["x + z;", "arithmetic of a polynomial over a finite field and a RngUPolElt is not supported yet"],
    ["Discriminant(f);", "Discriminant of a polynomial over a finite field (or its ring) is not supported yet"],
    ["Resultant(f, x);", "Resultant of a polynomial over a finite field (or its ring) is not supported yet"],
    ["{x};", "a set of polynomials over a finite field (or of their rings) is not supported yet"],
    ["T<u> := PolynomialRing(GF(49)); x + u;", "arithmetic of polynomials over two finite fields of one characteristic is not supported yet"],
    ["IsSquare([x]);", "IsSquare of a polynomial over a finite field (or its ring) is not supported yet"],
    ["Sort([x, x^2]);", "Sort of a polynomial over a finite field (or its ring) is not supported yet"],
    // (wherever they are in the arguments: CORR-53E-2)
    ["IsSquare([[], [x]]);", "IsSquare of a polynomial over a finite field (or its ring) is not supported yet"],
    ["IsSquare([<1>, <x>]);", "IsSquare of a polynomial over a finite field (or its ring) is not supported yet"],
    ["IsSquare([[[[[[[[[[x]]]]]]]]]]);", "IsSquare of a polynomial over a finite field (or its ring) is not supported yet"],
    ["RF := recformat<v>; r := rec<RF | v := x>; IsSquare(r);", "IsSquare of a polynomial over a finite field (or its ring) is not supported yet"],
    ["Gcd([[], [x]]);", "Gcd of a polynomial over a finite field (or its ring) is not supported yet"],
    ["IsZero([x]);", "IsZero of a polynomial over a finite field (or its ring) is not supported yet"],
    ["d := x; for i in [1..40] do d := [d]; end for; IsSquare(d);", "IsSquare of a value too large or too deep for Sagebrush to check"],
    ["Evaluate(x, d);", "Evaluate of a value too large or too deep for Sagebrush to check"],
    ["Gcd(x, d);", "Gcd of a value too large or too deep for Sagebrush to check"],
  ];
  const src = "R<x> := PolynomialRing(GF(7)); S<y> := PolynomialRing(GF(5)); Z<z> := PolynomialRing(Integers()); f := x^2 + 1;\n" +
    [...cases.map((c) => c[0]), ...own.map((c) => c[0])].join("\n") + "\nType(names); x;\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (the refused AssignNames left x's name, and names a sequence)
  assert.match(out, /\nSeqEnum\nx\nend\n$/);
  assert.doesNotMatch(out, /_FFUnseen/);
  // (long messages wrap at 80 columns: compared unwrapped)
  const flat = out.replace(/\s+/g, " ");
  for (const [stmt, where, said] of cases)
    assert.ok(flat.includes(`Runtime error in ${where}: ${said.replace(/\s+/g, " ")}`), `${stmt}\n${out}`);
  for (const [stmt, said] of own)
    assert.ok(flat.includes(said), `${stmt}\n${out}`);
  assert.doesNotMatch(out, /TypeError|Traceback|AttributeError/);
  assert.match(out, /\nend\n$/);
});

test("matrices over a finite field refuse what Magma refuses, in its words, and what Sagebrush doesn't do yet, in words", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // [statement, where, what Magma says] (checked against Magma 2.18)
  const cases = [
    ["A + B;", "'+'", "Bad argument types\nArgument types given: AlgMatElt[FldFin], ModMatFldElt[FldFin]"],
    ["B * A;", "'*'", "Arguments have incompatible degrees"],
    ["S^-1;", "'^'", "Argument 1 is not invertible"],
    ["Matrix(F, 2, 2, [1, 2, 3, 1/5]);", "'Matrix'", "Cannot coerce sequence element 4 into the coefficient ring"],
    ["Matrix(F, 2, 2, [1, 2, 3]);", "'Matrix'", "Sequence should have length 4"],
    ["Matrix(F, [[1, 2], [3]]);", "'Matrix'", "Element 2 of sequence does not have length 2"],
    ["A + Matrix(GF(7), 2, 2, [1, 2, 3, 4]);", "'+'", "Arguments are not compatible\nArgument types given: AlgMatElt[FldFin], AlgMatElt[FldFin]"],
    ["A * GF(7)!1;", "'*'", "Arguments are not compatible\nArgument types given: AlgMatElt[FldFin], FldFinElt"],
    ["A * 0.5;", "'*'", "Arguments are not compatible\nArgument types given: AlgMatElt[FldFin], FldReElt"],
    ["A^(1/2);", "'^'", "Bad argument types\nArgument types given: AlgMatElt[FldFin], AlgMatElt[FldFin]"],
    ["A eq B;", "'eq'", "Arguments have incompatible degrees"],
    ["A[1,2] := 1/5;", ":=", "RHS cannot be coerced into the coefficient ring"],
    ["A[3,1] := 1;", ":=", "Matrix row index is not in the range [1 .. 2]"],
    ["A[1,3] := 1;", ":=", "Matrix column index is not in the range [1 .. 2]"],
    ["A[<1,2>] := 1;", ":=", "Bad matrix row index type"],
    ["A[3,1];", "'[]'", "Index 1 (3) should be in the range [1 .. 2]"],
    ["Determinant(B);", "'Determinant'", "Argument 1 is not square"],
    // (every argument's type checked, nested ones too; collections take one
    // universe: CORR-53E-1 .. -5)
    ["#A[1];", "'#'", "Bad argument types\nArgument types given: ModTupFldElt[FldFin]"],
    ["#A;", "'#'", "Bad argument types\nArgument types given: AlgMatElt[FldFin]"],
    ["Reverse(A[1]);", "'Reverse'", "Bad argument types\nArgument types given: ModTupFldElt[FldFin]"],
    ["[A, 1/2];", "[ ... ]", "No valid universe containing all elements"],
    ["[A, Matrix(GF(7), 2, 2, [1, 2, 3, 4])];", "[ ... ]", "No valid universe containing all elements"],
    ["[A, Matrix(F, 1, 2, [1, 2])];", "[ ... ]", "No valid universe containing all elements"],
    ["A eq Matrix(GF(7), 2, 2, [1, 2, 3, 4]);", "'eq'", "Arguments are not compatible\nArgument types given: AlgMatElt[FldFin], AlgMatElt[FldFin]"],
    ["Parent(A) eq Parent(Matrix(GF(7), 2, 2, [1, 2, 3, 4]));", "'eq'", "Arguments are not compatible\nArgument types given: AlgMat[FldFin], AlgMat[FldFin]"],
  ];
  const own = [
    ["A + Matrix(Integers(), 2, 2, [1, 2, 3, 4]);", "arithmetic of a matrix over a finite field and a AlgMatElt is not supported yet"],
    ["Matrix(F, 0, 0, []);", "a matrix with no rows or no columns is not supported yet"],
    ["ElementaryDivisors(A);", "ElementaryDivisors of a matrix or vector over a finite field is not supported yet"],
    ["EchelonForm(A);", "EchelonForm of a matrix or vector over a finite field is not supported yet"],
    ["{A};", "a set of matrices or vectors over a finite field is not supported yet"],
    ["A lt A;", "ordering of polynomials and matrices is not supported yet"],
    ["Matrix(GF(1031, 2), 1, 2, [1, 2]);", "Matrix over a finite field of more than 1048576 elements, not a prime field, is not supported yet"],
    ["A[1] * B[1];", "this arithmetic of vectors over a finite field is not supported yet"],
    ["Determinant(A[1]);", "Determinant of a matrix or vector over a finite field is not supported yet"],
    ["Trace(A[1]);", "Trace of a matrix or vector over a finite field is not supported yet"],
    ["Gcd([A]);", "Gcd of a matrix or vector over a finite field is not supported yet"],
    ["[Parent(A) | 1, 2];", "a collection over a matrix or vector space over a finite field is not supported yet"],
    ["<A, 1>;", "printing a tuple or record holding a matrix over a finite field is not supported yet"],
    ["RF := recformat<v>; r := rec<RF | v := A>; r;", "printing a tuple or record holding a matrix over a finite field is not supported yet"],
    ["IsSquare([[], [A]]);", "IsSquare of a matrix or vector over a finite field is not supported yet"],
    ["IsZero([A]);", "IsZero of a matrix or vector over a finite field is not supported yet"],
  ];
  const src = "F := GF(5); A := Matrix(F, 2, 2, [1, 2, 3, 4]); B := Matrix(F, 2, 3, [1, 2, 3, 4, 5, 6]); S := Matrix(F, 2, 2, [1, 2, 2, 4]);\n" +
    [...cases.map((c) => c[0]), ...own.map((c) => c[0])].join("\n") + "\nA;\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  const flat = out.replace(/\s+/g, " ");
  for (const [stmt, where, said] of cases)
    assert.ok(flat.includes(`Runtime error in ${where}: ${said.replace(/\s+/g, " ")}`), `${stmt}\n${out}`);
  for (const [stmt, said] of own)
    assert.ok(flat.includes(said), `${stmt}\n${out}`);
  assert.doesNotMatch(out, /TypeError|Traceback|AttributeError/);
  // (the refused writes left A as it was)
  assert.match(out, /\n\[1 2\]\n\[3 4\]\nend\n$/);
});

test("matrix arithmetic over a finite field is admitted before it computes, under 96 MiB", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const t0 = Date.now();
  const src = "F := GF(5); Matrix(F, 300, 300, [1..90000]);\nMatrix(F, 2, 2, [1..10^12]);\nr := [1..30000]; Matrix(F, [r : i in [1..30000]]);\nM := Matrix(F, 150, 150, [1..22500]);\nN := M * M;\nDeterminant(M);\nRank(M);\n" +
    "M^(10^100);\nCharacteristicPolynomial(M);\nK<w> := GF(9); P := Matrix(K, 80, 80, [w : i in [1..6400]]); Q := P * P;\nNrows(M); Rank(Matrix(F, 20, 20, [1..400]));\n\"end\";\n";
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  // (the 300 x 300 shape bounded before any entry, HARD-DE1-1; the 30000
  // rows of 30000, fewer rows than the bound, by their entries)
  assert.equal((out.match(/a matrix of more than \d+ entries, rows or columns is not supported yet/g) ?? []).length, 1, r.stdout);
  assert.equal((out.match(/a matrix of more than \d+ entries is not supported yet/g) ?? []).length, 1, r.stdout);
  assert.match(out, /Runtime error in 'Matrix': Sequence should have length 4/);
  assert.equal((out.match(/a product of matrices over a finite field of more than 2000000 entry products is not supported yet/g) ?? []).length, 2, r.stdout);
  for (const what of ["Determinant", "Rank", "a power", "CharacteristicPolynomial"])
    assert.ok(out.includes(`${what} of matrices over a finite field of more than 2000000 entry products is not supported yet`), what + r.stdout);
  assert.doesNotMatch(out, /TypeError|Traceback|AttributeError/);
  assert.match(r.stdout, /\n150\n1\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("Gcd and Lcm of an empty collection: of the integers 0 and 1, of nothing Magma's error", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (checked against Magma 2.18: a range, a declared universe and a
  // sequence emptied of its integers keep the integers; [] and {} have none)
  // (made empty otherwise, by Setseq, Sort, join, meet or diff, the
  // integers' too: CORR-A1A-1)
  const src = "Gcd([1..0]); Lcm([1..0]); Gcd([Integers() | ]); Lcm([Integers() | ]); Gcd({Integers() | });\n" +
    "S := [1]; Exclude(~S, 1); Gcd(S); Lcm(S);\n" +
    "Gcd(Setseq({Integers() | })); Lcm(Seqset([Integers() | ])); Gcd(Sort([Integers() | ])); Lcm({Integers() | } join {Integers() | });\n" +
    "Gcd({Integers() | } meet {Integers() | }); Lcm({1} diff {1});\n" +
    "Gcd([]);\nLcm({});\nGcd([ x : x in [1..5] | x gt 9 ]);\nLcm({ x : x in [1..5] | x gt 9 });\n" +
    "Gcd([Rationals() | ]);\nLcm([GF(5) | ]);\nP<t> := PolynomialRing(Integers()); Gcd([P | ]);\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  assert.match(out, /^0\n1\n0\n1\n0\n0\n1\n0\n1\n0\n1\n0\n1\n/);
  assert.equal(out.split("Runtime error in 'Gcd': Illegal null set/sequence").length - 1, 2, out);
  assert.equal(out.split("Runtime error in 'Lcm': Illegal null set/sequence").length - 1, 2, out);
  assert.ok(out.includes("Runtime error in 'Gcd': GCD not defined for field"), out);
  assert.ok(out.includes("Runtime error in 'Lcm': LCM not defined for field"), out);
  assert.ok(out.replace(/\s+/g, " ").includes("Gcd of an empty collection of polynomials is not supported yet"), out);
  assert.match(out, /\nend\n$/);
});

test("an empty collection keeps what is known of its universe through copies, conversions and set operations (Gcd, Lcm)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (checked against Magma 2.18: values first, then Magma's null refusals)
  // (one element too: Gcd([-5]) and Lcm([-5]) are 5, never a Python error)
  const values = ["Gcd([1] cat []);", "S2 := []; Append(~S2, 1); Exclude(~S2, 1); Gcd(S2);", "Gcd([1, 2][[]]);",
    "V := {}; Include(~V, 3); Exclude(~V, 3); Lcm(V);", "Gcd({1} diff {});", "Gcd({} join {Integers() | });",
    "Gcd({Integers() | } join {});", "Gcd({1} sdiff {1});", "Gcd([] cat [Integers() | ]);", "Gcd([Integers() | ] cat []);",
    "Gcd([-5]);", "Lcm([-5]);", "Lcm({7});", "Lcm([0]);", "Gcd([-4, 6]);", "Lcm([-4, 6]);"];
  const nulls = ["Gcd(Setseq({}));", "Gcd(Seqset([]));", "Gcd(Sort([]));", "Gcd(Reverse([]));", "Gcd([] cat []);",
    "Gcd({} join {});", "Gcd({} meet {1});", "S := []; Gcd(S);", "T := [x : x in [1..3] | x gt 5]; Gcd(T);",
    "U := [[]]; Gcd(U[1]);", "Gcd([][[]]);", "Gcd({1} meet {});", "Gcd({} diff {1});", "Gcd({} sdiff {});",
    "Gcd({Integers() | } meet {});"];
  const src = values.join("\n") + "\n" + nulls.join("\n") + "\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  assert.match(out, /^1\n0\n0\n1\n1\n0\n0\n0\n0\n0\n5\n5\n7\n0\n2\n12\n/);
  assert.equal(out.split("Runtime error in 'Gcd': Illegal null set/sequence").length - 1, nulls.length, out);
  assert.doesNotMatch(out, /doesn't know/);
  assert.match(out, /\nend\n$/);
});

test("an empty collection made with one of another or an unknown universe is never taken as the integers' (Gcd, Lcm refuse)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (a known field's among them: Magma's "GCD not defined for field";
  // an unknown one: refused in words; never 0 or 1, astra2 CORR-76F-1)
  const cases = ["Gcd({Rationals() | } join {Integers() | });", "Lcm({Rationals() | } join {Integers() | });",
    "Gcd({Integers() | } diff {Rationals() | });", "Gcd({Integers() | } meet {GF(7) | });",
    "Gcd({Integers() | } sdiff {Rationals() | });",
    "Gcd(Seqset(Sort([Rationals() | ])) join {Integers() | });", "Gcd({} join {Rationals() | });",
    "Gcd(Setseq({Rationals() | }));", "Gcd([GF(7) | ] cat []);", "Gcd({Rationals() | } diff {});"];
  const nulls = ["Gcd({Rationals() | } meet {});", "Gcd({} diff {Rationals() | });"];
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: [...cases, ...nulls].join("\n") + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const flat = out.replace(/\s+/g, " ");
  assert.equal((flat.match(/Runtime error in '(Gcd|Lcm)': (GCD|LCM) not defined for field/g) ?? []).length, cases.length, out);
  assert.equal(out.split("Runtime error in 'Gcd': Illegal null set/sequence").length - 1, nulls.length, out);
  assert.doesNotMatch(out, /^[01]$/m);
  assert.match(out, /\nend\n$/);
  // (no arguments: Magma's Bad argument types, never 0 or 1)
  const none = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: "Gcd();\nLcm();\n\"end\";\n", encoding: "utf8" }).stdout as string;
  for (const name of ["Gcd", "Lcm"])
    assert.ok(none.includes(`Runtime error in '${name}': Bad argument types\nArgument types given:\n`), none);
  assert.doesNotMatch(none, /^[01]$/m);
});

test("a collection made from one over a field stays over that field when integers are put in and taken out (Gcd, Lcm, set operations)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  // (Magma's "GCD not defined for field" after an integer is put in and
  // taken out, never 0 or 1; nonempty too, astra2 on 0f235472)
  const fields: string[] = [];
  for (const F of ["Rationals()", "GF(7)"])
    for (const f of ["Gcd", "Lcm"])
      fields.push(`S:=Setseq({${F}|});Append(~S,1);Remove(~S,1);${f}(S);`, `S:=Seqset([${F}|]);Include(~S,1);Exclude(~S,1);${f}(S);`,
        `S:=Sort([${F}|]);S[1]:=1;Remove(~S,1);${f}(S);`, `S:=Setseq({${F}|});Append(~S,2);${f}(S);`);
  fields.push("Gcd([1/2, 1/3]);", "Gcd([GF(7) | 1, 2]);", "Gcd({Rationals() | } join {4, 6});",
    "X:={Integers()|} join {Rationals()|};Include(~X,1);Exclude(~X,1);Gcd(X);");
  const out = run(fields.join("\n")), flat = out.replace(/\s+/g, " ");
  assert.equal((flat.match(/Runtime error in '(Gcd|Lcm)': (GCD|LCM) not defined for field/g) ?? []).length, fields.length, out);
  assert.doesNotMatch(out, /^\d+$/m);
  assert.match(out, /\nend\n$/);
  // (what is put in goes into the field, as Magma's)
  const universes = run("S:=Setseq({GF(7)|}); Append(~S,2); S[1]+5;\nS:=Sort([GF(7)|]);S[1]:=10;S;\n" +
    "S:=Sort([Rationals()|]); S[1]:=4; Universe(S);\nT:={Rationals()|} join {Integers()|}; Include(~T,2); Universe(T);\n" +
    "T:={GF(7)|} meet {Integers()|}; Include(~T,2); Universe(T);\nX:={GF(7)|} join {4,11}; X, Universe(X);\n" +
    "X:={4,11} diff {GF(7)|}; X;\nX:={@ GF(7)| @} join {@ 9, 2, 3 @}; X;\nX:={Integers()|} join {1/2}; Universe(X);\n" +
    "X:={Integers()|} join {Integers()|}; Include(~X,6); Include(~X,4); Gcd(X);");
  assert.match(universes, /^0\n\[ 3 \]\nRational Field\nRational Field\nFinite field of size 7\n\{ 4 \}\nFinite field of size 7\n\{ 4 \}\n\{@ 2, 3 @\}\nRational Field\n2\nend\n$/, universes);
  // (two fields, or the rationals and a finite field, meet in none: Magma's error)
  // (an emptied one keeps the universe inferred for it: E's is the
  // rationals', CORR-148-1)
  const E = "E:={1/2}; Exclude(~E,1/2); ";
  const clash = ["{GF(7)|} join {GF(5)|};", "{Rationals()|} meet {GF(7)|};", "{GF(7)|} diff {Rationals()|};", "{GF(7)|} join {1/2};",
    "Gcd({Rationals()|} join {GF(7)|});", E + "Universe(E join {GF(7)|2});", E + "Universe({GF(7)|2} join E);",
    E + "Universe(E sdiff {GF(7)|2});", E + "Characteristic(Universe({GF(7)|2} diff E));",
    "E:=[1/2]; Exclude(~E,1/2); F:=Seqset(E); Universe(F join {GF(7)|2});"];
  const c = run(clash.join("\n")).replace(/\s+/g, " ");
  assert.equal((c.match(/Runtime error in '(join|meet|diff|sdiff)': No valid universe containing all elements/g) ?? []).length, clash.length, c);
  assert.doesNotMatch(c, /Finite field of size 7|^7$/m);
  // (with the integers' it goes into the rationals; an empty one only
  // written empty, or of the integers, into the field)
  const u = run(E + "Universe(E join {Integers()|2});\nE:={4}; Exclude(~E,4); Universe(E join {GF(7)|2});\nUniverse({} join {GF(7)|2});");
  assert.match(u, /^Rational Field\nFinite field of size 7\nFinite field of size 7\nend\n$/, u);
});

test("GCD, GreatestCommonDivisor, LCM, LeastCommonMultiple, XGCD and ExtendedGreatestCommonDivisor name themselves in their errors; Xgcd takes integers or polynomials", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const src = ["GCD();", "GreatestCommonDivisor([]);", "LCM({Rationals()|});", "LeastCommonMultiple(\"a\");", "GCD(1/2, 3);",
    "LeastCommonMultiple([1/2]);", "GreatestCommonDivisor(12, 18), LCM(4, 6), LeastCommonMultiple([4, 6]), GCD({12, 18});",
    "x := [4,6]; GCD(~x);", "a := 4; Gcd(~a, 6);", "x := [1/2]; LCM(~x);", "a := 4; Xgcd(~a, 6);",
    "Xgcd(1/2, 3);", "XGCD(\"a\", 3);", "ExtendedGreatestCommonDivisor(1/2, 3);", "Xgcd(4/1, 6);", "Xgcd(4);",
    "Xgcd(12, 18);", "Xgcd(0, 0);", "Xgcd(-4, 6);"].join("\n") + "\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (each as Magma 2.18 has it: the name it was called by, "~" for an
  // argument by reference, never a value for rationals)
  for (const want of ["'GCD': Bad argument types\nArgument types given:\n", "'GreatestCommonDivisor': Illegal null set/sequence",
    "'LCM': LCM not defined for field", "'LeastCommonMultiple': Bad argument types\nArgument types given: MonStgElt",
    "'GCD': Bad argument types\nArgument types given: FldRatElt, FldRatElt", "'LeastCommonMultiple': LCM not defined for field",
    "6 12 12 6\n", "'GCD': Bad argument types\nArgument types given: SeqEnum[RngIntElt] ~",
    "'Gcd': Bad argument types\nArgument types given: RngIntElt ~, RngIntElt", "'LCM': Bad argument types\nArgument types given: SeqEnum[FldRatElt] ~",
    "'Xgcd': Bad argument types\nArgument types given: RngIntElt ~, RngIntElt", "'XGCD': Bad argument types\nArgument types given: MonStgElt, RngIntElt",
    "'ExtendedGreatestCommonDivisor': Bad argument types\nArgument types given: FldRatElt, FldRatElt", "'Xgcd': Bad argument types\nArgument types given: RngIntElt\n",
    "6 -1 1\n0 0 0\n2 1 1\nend\n"])
    assert.ok(out.includes(want), want + "\n---\n" + out);
  assert.equal(out.split("'Xgcd': Bad argument types\nArgument types given: FldRatElt, FldRatElt").length - 1, 2, out);
  assert.doesNotMatch(out, /1\/2 1 0|TypeError|Traceback/);
});

test("the image of a set under a map is over the map's codomain, empty or not (Universe, Gcd)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const f = "f:=map<Integers()->Rationals()|x:->x>; ";
  const src = [f + "S:=f({Integers()|}); Universe(S);", f + "S:=f({Integers()|}); Universe(S join {Integers()|});",
    f + "S:=f({Integers()|}); Universe(S join {Integers()|2});", f + "S:=f({1,2}); Universe(S);",
    "g:=map<Integers()->Integers()|x:->2*x>; S:=g({Integers()|}); Universe(S), Gcd(S), Lcm(S);",
    "h:=map<Integers()->GF(7)|x:->x>; S:=h({1,8}); S, Universe(S);", "h:=map<Integers()->GF(7)|x:->x>; S:=h({Integers()|}); Universe(S join {Integers()|});",
    f + "S:=f({}); Universe(S);", f + "S:=f({Integers()|}); Include(~S,3); Universe(S);",
    f + "S:=f({1,2}); Gcd(S join {Integers()|});", f + "S:=Setseq(f({Integers()|})); Append(~S,2); Gcd(S);"].join("\n") + "\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (as Magma 2.18 has them: never the integers' for a map into the rationals)
  assert.ok(out.startsWith("Rational Field\nRational Field\nRational Field\nRational Field\nInteger Ring\n0 1\n{ 1 }\nFinite field of size 7\n" +
    "Finite field of size 7\nRational Field\nRational Field\n"), out);
  assert.equal((out.match(/Runtime error in 'Gcd': GCD not defined for field/g) ?? []).length, 2, out);
  assert.match(out, /\nend\n$/);
});

test("an image under a map whose codomain gives no universe Sagebrush has is refused when made; conversions keep a declared universe (CORR-3FA-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const q = "f:=map<Integers()->{Rationals()|1,2,3}|x:->x>; ", r = "R<x>:=PolynomialRing(GF(7)); f:=map<Integers()->R|a:->R!a>; ";
  // (each as Magma 2.18 has it: a nonempty image into a set is over the
  // set's universe; what is put in later goes into it, never the integers)
  const out = run([q + "S:=f({1,2}); Universe(S);", "f:=map<Integers()->{1,2,3}|x:->x>; S:=f({1,2}); Universe(S), Gcd(S);",
    r + "S:=Setseq(f({})); Append(~S,2); S[1]+5;",
    "S:=Setseq({Integers(5)|}); Append(~S,7); S;", "S:=Sort([GF(7)|]); Append(~S,9); S;", "S:=Seqset([Integers(5)|]); Include(~S,6); S;",
    "S:=[Integers(5)|]; Append(~S,7); S;", "T:={Integers(5)|}; Include(~T,6); T;"].join("\n"));
  assert.match(out, /^Rational Field\nInteger Ring\n1\n0\n\[ 2 \]\n\[ 2 \]\n\{ 1 \}\n\[ 2 \]\n\{ 1 \}\nend\n$/, out);
  // (a set of polynomials over a finite field is refused, never Gcd 2)
  const poly = run(r + "S:=f({}); Include(~S,2); Gcd(S);");
  assert.match(poly.replace(/\s+/g, " "), /a set of polynomials over a finite field \(or of their rings\) is not supported yet/, poly);
  assert.doesNotMatch(poly, /^2$/m);
  const field = run(q + "S:=f({1,2}); Gcd(S);\n" + "S:=Setseq({Rationals()|1,2}); Gcd(S);");
  assert.equal((field.match(/Runtime error in 'Gcd': GCD not defined for field/g) ?? []).length, 2, field);
  // (an empty image into a set is over the set itself in Magma, and an
  // image into strings over the string structure: neither a universe
  // Sagebrush has, refused where the image is made, never left to infer)
  const refused = run([q + "S:=f({}); Include(~S,2); Gcd(S);", "f:=map<Integers()->{\"a\",\"b\"}|x:->\"a\">; S:=f({1,2}); S;"].join("\n"));
  assert.equal((refused.replace(/\s+/g, " ").match(/the image of a set under a map to this codomain is not supported yet/g) ?? []).length, 2, refused);
  assert.doesNotMatch(refused, /Integer Ring|^2$/m);
  // (the image's elements are the universe's, never integers labelled
  // with the rationals, CORR-CBA-1; a sort by a comparison keeps the
  // declared universe as the default sort does, CORR-CBA-2)
  const els = run([q + "S:=Setseq(f({1,2})); Type(S[1]);", "g:=map<Integers()->{1/2,1}|x:->1>; S:=Setseq(g({1,2})); Universe(S); Type(S[1]);",
    "h:=map<Integers()->Rationals()|x:->x>; S:=h({1,2}); Type(Setseq(S)[1]);",
    r + "S:=Sort(Setseq(f({})),func<a,b|0>); Append(~S,2); S[1]+5;", "S:=Sort([Integers(5)|],func<a,b|0>); Append(~S,7); S;",
    "S:=Sort([Rationals()|],func<a,b|a-b>); Append(~S,2); Type(S[1]);"].join("\n"));
  assert.match(els, /^FldRatElt\nRational Field\nFldRatElt\nFldRatElt\n0\n\[ 2 \]\nFldRatElt\nend\n$/, els);
  // (and the other functions making a sequence from one, as Magma's)
  const audit = run(["S:=Reverse([Integers(5)|]); Append(~S,7); S;", "T:=[Integers(5)|1,2]; S:=T[2..1]; Append(~S,7); S;",
    "S:=Exclude([Integers(5)|3],3); Append(~S,7); S;", "S:=Remove([Integers(5)|3],1); Append(~S,7); S;"].join("\n"));
  assert.match(audit, /^\[ 2 \]\n\[ 2 \]\n\[ 2 \]\n\[ 2 \]\nend\n$/, audit);
  const div = run(q + "S:=Setseq(f({1,2})); S[1] div 2;");
  assert.ok(div.includes("Runtime error in 'div': Bad argument types\nArgument types given: FldRatElt, FldRatElt"), div);
});

test("a number put in a collection over Q[x] or Z[x] is a constant polynomial, as Magma's", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const q = "U:=PolynomialRing(Rationals()); ", z = "U:=PolynomialRing(Integers()); ";
  const src = [q + "f:=map<Integers()->U|x:->x>; S:=Setseq(f({2})); Type(S[1]); S[1] div 3;", q + "S:=[U|]; Append(~S,2); Type(S[1]); S[1] div 3;",
    z + "S:=[U|]; Append(~S,2); Type(S[1]);", q + "S:={U|}; Include(~S,2); Type(Setseq(S)[1]);", q + "S:=[U|2]; Type(S[1]); S[1] div 3;",
    z + "S:=[U|2]; Type(S[1]);", q + "S:=[U|]; Append(~S,1/2); S[1]*2;", "P<t>:=PolynomialRing(Rationals()); S:=[P|t]; Append(~S,3); Index(S,3);",
    z + "S:=[U|]; Append(~S,1/2);", z + "S:=[U|1/2];"].join("\n") + "\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (each as Magma 2.18 has it; 1/2 doesn't go into Z[x])
  assert.ok(out.startsWith("RngUPolElt\n2/3\nRngUPolElt\n2/3\nRngUPolElt\nRngUPolElt\nRngUPolElt\n2/3\nRngUPolElt\n1\n2\n"), out);
  assert.match(out.replace(/\s+/g, " "), /Runtime error in 'Append': Cannot coerce element into the universe/);
  assert.match(out.replace(/\s+/g, " "), /Coerce failed for sequence element/);
  assert.match(out, /\nend\n$/);
});

test("a number put in a collection over a number field, a real field or a matrix space takes the universe's type, as Magma's (astra2 WA-012..014)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const nf = "P<t>:=PolynomialRing(Rationals()); U<a>:=NumberField(t^2-2); ", re = "U:=RealField(30); ";
  const mz = "A:=Matrix(Integers(),2,2,[1,2,3,4]); U:=Parent(A); ", mq = "A:=Matrix(Rationals(),2,2,[1,2,3,4]); U:=Parent(A); ";
  const src = [nf + "S:=[U|2]; Type(S[1]); Parent(S[1]) eq U;", nf + "S:=[U|]; Append(~S,1/2); Type(S[1]); S[1]*a;",
    nf + "S:={U|}; Include(~S,-3); Type(Setseq(S)[1]);", nf + "S:=Sort([U|a]); Remove(~S,1); Append(~S,3); Type(S[1]);",
    re + "S:=[U|2]; Type(S[1]);", re + "S:=[U|]; Append(~S,1/2); Type(S[1]);", re + "S:={U|-3}; Type(Setseq(S)[1]);",
    mz + "S:=[U|2]; Type(S[1]); S[1];", mz + "S:=[U|]; Append(~S,0); S[1];", mq + "S:=[U|1/2]; S[1];",
    mz + "S:=[U|1/2];", "A:=Matrix(Integers(),2,3,[1,2,3,4,5,6]); U:=Parent(A); S:=[U|2];"].join("\n") + "\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (each as Magma 2.18 has it; 1/2 doesn't go into integer matrices, a
  // number into no non-square matrix space)
  assert.ok(out.startsWith("FldNumElt\ntrue\nFldNumElt\n1/2*a\nFldNumElt\nFldNumElt\nFldReElt\nFldReElt\nFldReElt\nAlgMatElt\n[2 0]\n[0 2]\n" +
    "[0 0]\n[0 0]\n[1/2   0]\n[  0 1/2]\n"), out);
  assert.equal((out.match(/Coerce failed for sequence element/g) ?? []).length, 2, out);
  assert.match(out, /\nend\n$/);
  // (and where the universe comes from an element: the number takes the
  // element's parent, Append and S[i] := alike)
  const el = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: [nf + "S:=[a]; Append(~S,2); Type(S[2]); S[2]*a;",
    nf + "S:=[a]; S[2]:=1/2; Type(S[2]);", "P<x>:=PolynomialRing(Rationals()); S:=[x]; Append(~S,2); Type(S[2]); S[2] div 3;",
    "P<x>:=PolynomialRing(Rationals()); S:=[x]; S[2]:=2; Type(S[2]);", "A:=Matrix(Integers(),2,2,[1,2,3,4]); S:=[A]; Append(~S,2); S[2];",
    "A:=Matrix(Integers(),2,2,[1,2,3,4]); S:=[A]; S[2]:=3; S[2];", "S:=[RealField(30)!1]; Append(~S,2); Type(S[2]);",
    nf + "S:=[a]; Index(S, a), Position([U|1,2], 2);"].join("\n") + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  assert.equal(el, "FldNumElt\n2*a\nFldNumElt\nRngUPolElt\n2/3\nRngUPolElt\n[2 0]\n[0 2]\n[3 0]\n[0 3]\nFldReElt\n1 2\nend\n", el);
  // (a real field's precision is kept, and an emptied collection keeps its
  // element universe, through Sort, Reverse, Setseq and Seqset too: astra2
  // on de17ca12)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const r10 = "U:=RealField(10); ";
  const prec = run([r10 + "S:=[U|1/3]; Parent(S[1]) eq U; S[1];", r10 + "S:=[U|]; Append(~S,1/3); S[1];", r10 + "S:={U|2/3}; Setseq(S)[1];",
    "S:=[RealField(10)!1]; Append(~S,1/3); S[2];", "S:=[RealField(10)!1]; S[2]:=2/3; S[2];", "S:=[RealField(10)!1]; Remove(~S,1); Append(~S,1/3); S[1];"].join("\n"));
  assert.equal(prec, "true\n0.3333333333\n0.3333333333\n0.6666666667\n0.3333333333\n0.6666666667\n0.3333333333\nend\n", prec);
  const em = run([nf + "S:=[a]; Remove(~S,1); Append(~S,2); Type(S[1]);", nf + "S:=[a]; Remove(~S,1); S:=Sort(S); Append(~S,2); Type(S[1]);",
    nf + "S:=[a]; Exclude(~S,a); Append(~S,2); Type(S[1]);", nf + "S:={a}; Exclude(~S,a); Include(~S,2); Type(Setseq(S)[1]);",
    nf + "S:={a}; Exclude(~S,a); T:=Setseq(S); Append(~T,2); Type(T[1]);", nf + "S:=[a]; Remove(~S,1); T:=Seqset(S); Include(~T,2); Type(Setseq(T)[1]);",
    nf + "S:=[a]; Remove(~S,1); S:=Reverse(S); Append(~S,2); Type(S[1]);", "A:=Matrix(Integers(),2,2,[1,2,3,4]); S:=[A]; Remove(~S,1); Append(~S,2); S[1];",
    "P<x>:=PolynomialRing(Rationals()); S:=[x]; Remove(~S,1); Append(~S,2); Type(S[1]);"].join("\n"));
  assert.equal(em, "FldNumElt\nFldNumElt\nFldNumElt\nFldNumElt\nFldNumElt\nFldNumElt\nFldNumElt\n[2 0]\n[0 2]\nRngUPolElt\nend\n", em);
  // (a written empty {} with no universe drops it, in a meet or first in
  // a diff; every other set operation keeps it: checked against Magma
  // 2.18, astra2 on 0118f5a5)
  const ops = ["S meet {}", "{} meet S", "{} diff S", "S diff {}", "S meet {1}", "{1} meet S", "S diff {1}", "S meet {Integers()|}",
    "{Integers()|} diff S", "S join {}", "{} join S", "S sdiff {}", "{} sdiff S"];
  const so = run(ops.map((e) => nf + `S:={a}; Exclude(~S,a); T:=${e}; Include(~T,2); Type(Setseq(T)[1]);`).join("\n"));
  assert.equal(so, "RngIntElt\nRngIntElt\nRngIntElt\n" + "FldNumElt\n".repeat(10) + "end\n", so);
  // (the three that drop it, over six universes: astra2's grid, CORR-0118-1)
  const us = [nf + "x:=a;", "x:=RealField(10)!1;", "P<t>:=PolynomialRing(Integers()); x:=t;", "P<t>:=PolynomialRing(Rationals()); x:=t;",
    "x:=Matrix(Integers(),2,2,[1,2,3,4]);", "x:=GF(7)!3;"];
  const grid = run(us.flatMap((u) => ["S meet {}", "{} meet S", "{} diff S"].map((e) => u + ` S:={x}; Exclude(~S,x); T:=${e}; Include(~T,2); v:=Setseq(T)[1]; Type(v); v div 3;`)).join("\n"));
  assert.equal(grid, "RngIntElt\n0\n".repeat(18) + "end\n", grid);
  // (two emptied sets of different number fields, or one and a set Magma
  // finds no universe with, are Magma's error, never the left one's field;
  // integers and rationals go into it; a mix Magma resolves by a larger
  // structure, Z[u] with Q[t], refused, not guessed: astra CORR-011-1)
  const two = "P<t>:=PolynomialRing(Rationals()); K<a>:=NumberField(t^2-2); L<b>:=NumberField(t^2-3); S:={a}; T:={b}; Exclude(~S,a); Exclude(~T,b); ";
  const bad = ["join", "meet", "diff", "sdiff"].flatMap((op) => [`R:=S ${op} T;`, `R:=T ${op} S;`]).concat(["R:=S join {b};", "R:={b} diff S;", "R:=S meet {b};", "R:=S join {GF(7)|};"]);
  for (const e of bad) {
    const o = run(two + e).replace(/\s+/g, " ");
    assert.ok(/Runtime error in '(join|meet|diff|sdiff)': No valid universe containing all elements/.test(o) && o.endsWith("end "), e + o);
  }
  const good = run(["R:=S join S; Include(~R,2); Type(Setseq(R)[1]);", "R:=S join {1}; Include(~R,2); Type(Setseq(R)[1]);", "R:=S join {1/2}; Type(Setseq(R)[1]);",
    "R:=T sdiff {1}; Type(Setseq(R)[1]);"].map((e) => two + e).join("\n"));
  assert.equal(good, "FldNumElt\nFldNumElt\nFldNumElt\nFldNumElt\nend\n", good);
  const mix = run("Z<u>:=PolynomialRing(Integers()); P<t>:=PolynomialRing(Rationals()); S:={u}; T:={t}; Exclude(~S,u); Exclude(~T,t); R:=S join T;");
  assert.ok(mix.replace(/\s+/g, " ").includes("a set operation on an emptied set of a structure's elements and this other set is not supported yet"), mix);
  // (a declared empty universe that is the witness's own structure, and
  // rationals into a real field or Q[y], keep it, as Magma's: checked
  // against Magma 2.18, astra2's narrowing on a4d77d7b)
  const own = ["P<y>:=PolynomialRing(Rationals()); U<c>:=NumberField(y^2-5); x:=c+1;", "U:=RealField(15); x:=U!2/7;", "U<y>:=PolynomialRing(Integers()); x:=y^2;",
    "U<y>:=PolynomialRing(Rationals()); x:=y/3;", "x:=Matrix(Rationals(),3,3,[1..9]); U:=Parent(x);", "U:=GF(11); x:=U!5;"];
  const types = ["FldNumElt", "FldReElt", "RngUPolElt", "RngUPolElt", "AlgMatElt", "FldFinElt"];
  const decl = run(own.flatMap((u) => ["S join {U|}", "{U|} meet S", "S diff {U|}", "{U|} sdiff S"].map((e) => u + ` S:={x}; Exclude(~S,x); R:=${e}; Include(~R,3); v:=Setseq(R)[1]; Type(v); Parent(v) eq U;`)).join("\n"));
  assert.equal(decl, types.map((t) => `${t}\ntrue\n`.repeat(4)).join("") + "end\n", decl);
  const rat = run(["U:=RealField(15); x:=U!2/7; S:={x}; Exclude(~S,x); R:=S meet {2/3}; Include(~R,3); v:=Setseq(R)[1]; Type(v); Parent(v) eq U;",
    "U<y>:=PolynomialRing(Rationals()); x:=y/3; S:={x}; Exclude(~S,x); R:=S join {2/3}; v:=Setseq(R)[1]; Type(v); Parent(v) eq U;",
    "U<y>:=PolynomialRing(Rationals()); x:=y/3; S:={x}; Exclude(~S,x); R:={2/3} diff S; v:=Setseq(R)[1]; Type(v); v;"].join("\n"));
  assert.equal(rat, "FldReElt\ntrue\nRngUPolElt\ntrue\nRngUPolElt\n2/3\nend\n", rat);
});

test("Matrix checks its shape in Magma's words before it builds anything: no Python error, no silently shortened matrix", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const src = ["Matrix(Integers(),2,2,[1,2,3]);", "Matrix(Integers(),2,2,[1,2,3,4,5]);", "Matrix(2,2,[1,2,3]);", "Matrix(Rationals(),2,3,[1,2]);",
    "Matrix([[1,2],[3]]);", "Matrix(Integers(),[[1,2],[3]]);", "Matrix([[1,2],[3,4],[5]]);", "Matrix(GF(7),2,2,[1,2,3]);", "Matrix(GF(7),2,2,[1,2,3,4,5]);",
    "Matrix(GF(7),[[1,2],[3]]);", "Matrix(2,3,[]);", "Matrix(Integers(),2,2,[1/2,1,1,1]);"].join("\n") + "\n\"end\";\n";
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (each as Magma 2.18 has it)
  const want = ["Sequence should have length 4", "Sequence should have length 4", "Sequence should have length 4", "Sequence should have length 6",
    "Element 2 of sequence does not have length 2", "Element 2 of sequence does not have length 2", "Element 3 of sequence does not have length 2",
    "Sequence should have length 4", "Sequence should have length 4", "Element 2 of sequence does not have length 2", "Illegal null sequence",
    "Cannot coerce sequence element 1 into the coefficient ring"];
  // (a message longer than the line wraps, as Magma's does)
  const got = out.split("Runtime error in 'Matrix': ").slice(1).map((m) => m.split("\n\n")[0].replace(/\s+/g, " ").trim());
  assert.deepEqual(got, want, out);
  assert.doesNotMatch(out, /ValueError|TypeError|Traceback/);
  // (an empty sequence with a ring is the zero matrix, a finite field's too)
  const z = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: "Matrix(Integers(),2,2,[]);\nMatrix(GF(7),2,2,[]);\nMatrix(2,2,[1,2,3,4]);\n", encoding: "utf8" }).stdout as string;
  assert.equal(z, "[0 0]\n[0 0]\n[0 0]\n[0 0]\n[1 2]\n[3 4]\n", z);
  // (rows and columns are bounded too, before any row is made: a matrix
  // with no columns has no entries but a row for each, HARD-DE1-1)
  const t0 = Date.now();
  const big = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: "Matrix(Integers(),10^12,0,[]);\nMatrix(Rationals(),0,10^12,[]);\nMatrix(GF(7),10^12,0,[]);\nMatrix(GF(7),0,10^12,[]);\n\"end\";\n", encoding: "utf8", timeout: WALL(60000) });
  assert.equal(big.signal, null, big.stderr);
  assert.equal((big.stdout.replace(/\s+/g, " ").match(/a matrix of more than \d+ entries, rows or columns is not supported yet/g) ?? []).length, 4, big.stdout);
  assert.ok(Date.now() - t0 < WALL(20000), `${Date.now() - t0} ms`);
  // (a matrix with no rows or no columns keeps both numbers, and prints
  // as Magma's, astra2 WA-024)
  const zw = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: "M:=Matrix(Integers(),0,3,[]); Nrows(M), Ncols(M); M;\nM:=Matrix(Integers(),3,0,[]); Nrows(M), Ncols(M); M;\nM:=Matrix(Rationals(),0,0,[]); M;\nNcols(Matrix(GF(7),0,3,[]));\nMatrix(Integers(),1,0,[]);\nMatrix(Rationals(),0,1,[]);\n", encoding: "utf8" }).stdout as string;
  // (over a finite field Magma has 3 columns too; not modelled, refused)
  assert.ok(zw.startsWith("0 3\nMatrix with 0 rows and 3 columns\n3 0\nMatrix with 3 rows and 0 columns\nMatrix with 0 rows and 0 columns\n"), zw);
  assert.ok(zw.replace(/\s+/g, " ").includes("a matrix with no rows or no columns is not supported yet"), zw);
  assert.ok(zw.endsWith("Matrix with 1 row and 0 columns\nMatrix with 0 rows and 1 column\n"), zw);
});

test("polynomial arithmetic over a finite field is admitted before it computes, under 96 MiB", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const t0 = Date.now();
  const src = "R<x> := PolynomialRing(GF(7)); K<w> := GF(9); S<y> := PolynomialRing(K);\n" +
    "(x+1)^100000;\nx^(10^20);\n(R!3)^(10^20);\nFactorization(x^1001 + 1);\nFactorization(y^70 + w);\nIsIrreducible(y^70 + w);\n" +
    "f := x^3000 + 3*x + 1; g := f * f;\nh := y^400 + w; k := h * h;\nEvaluate(f, f);\nGCD(f, f);\nDerivative(x^30000 + x, 29999);\n" +
    // (each step within the allowance, the fold past it: HARD-53E-1)
    "a := x^500 + 1; GCD([a, a, a, a, a, a]);\nLCM([x^300 + 1, x^300 + 2, x^300 + 3, x^300 + 4]);\n" +
    "Degree(x^30000); #Factorization(x^200 + x + 1);\n\"end\";\n";
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  assert.equal((out.match(/a polynomial of degree more than \d+ is not supported yet/g) ?? []).length, 3, r.stdout);
  assert.match(out, /Factorization of a polynomial over a finite field of degree more than 1000 is not supported yet/);
  assert.match(out, /Factorization of a polynomial of degree 70 over this finite field is not supported yet/);
  assert.match(out, /IsIrreducible of a polynomial of degree 70 over this finite field is not supported yet/);
  for (const what of ["a product", "a Gcd", "a derivative", "a Lcm"])
    assert.ok(out.includes(`${what} of polynomials over a finite field of more than 1000000 coefficient products is not supported yet`), what + r.stdout);
  assert.doesNotMatch(out, /TypeError|Traceback|AttributeError/);
  assert.match(r.stdout, /\n30000\n\d+\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("the argument guard for finite fields' polynomials and matrices walks within a budget for a call and one for the run, under 96 MiB", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (split from the polynomial arithmetic test above, which with these took
  // about 30 s on GitHub's runners: HARD-F42-1's two budgets)
  const t0 = Date.now();
  const src = "R<x> := PolynomialRing(GF(7)); K<w> := GF(9); S<y> := PolynomialRing(K);\n" +
    "S := [[\"a\" : i in [1..30]] : j in [1..10000]]; IsEmpty(S); Gcd(S, S, S, S);\n" +
    "T := [[\"a\" : i in [1..1000]] : j in [1..40]]; for k in [1..300] do b := IsEmpty(T); end for;\n\"end\";\n";
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: WALL(60000) });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  assert.doesNotMatch(out, /TypeError|Traceback|AttributeError/);
  assert.match(r.stdout, /^false\n/);
  assert.ok(out.includes("Gcd of a value too large or too deep for Sagebrush to check"), r.stdout);
  assert.ok(out.includes("IsEmpty: Sagebrush's checks of arguments for polynomials and matrices over finite fields reached their limit for this run"), r.stdout);
  assert.match(r.stdout, /\nend\n$/);
  assert.ok(Date.now() - t0 < WALL(30000), `${Date.now() - t0} ms`);
});

test("an intrinsic of several signatures refuses in words those Magma has and Sagebrush doesn't yet, and the index has an entry for each", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const cli = join(__dirname, "..", "src", "cli.js");
  const src = "P<x> := PolynomialRing(Integers());\nTrace(x^2 + 1);\nF<z> := GF(9);\nTrace(z, GF(3));\n" +
    "K<w> := QuadraticField(7);\nTrace(w, Rationals());\nE := EllipticCurve([0, -1, 1, -10, -20]);\nTrace(E);\n" +
    "ISA(Mtrx, MtrxS);\nISA(1, RngIntElt);\n\"end\";\n";
  const out = spawnSync(process.execPath, [cli, "--magma"], { input: src, encoding: "utf8" }).stdout as string;
  // (Magma has these signatures: not Bad argument types)
  assert.ok(out.includes("Runtime error in 'Trace': Trace of a RngUPolElt is not supported yet"), out);
  assert.ok(out.includes("Runtime error in 'Trace': Trace of a FldFinElt, FldFin is not supported yet"), out);
  assert.ok(out.includes("Runtime error in 'Trace': Trace of a FldQuadElt, FldRat is not supported yet"), out);
  // (a value whose type the signatures don't know)
  assert.ok(out.includes("Runtime error in 'Trace': Trace with these arguments is not supported yet"), out);
  assert.doesNotMatch(out, /Runtime error in 'Trace': Bad argument types/);
  // (ISA of a type outside the table is not guessed)
  assert.ok(out.includes("ISA(Mtrx, MtrxS) is not supported yet"), out);
  assert.ok(out.includes("Runtime error in 'ISA': Bad argument types\nArgument types given: RngIntElt, Cat[RngIntElt]\n"), out);
  assert.match(out, /\nend\n$/);
  // arguments no signature takes: Magma's words (checked against Magma)
  const bad = spawnSync(process.execPath, [cli, "--magma"], { encoding: "utf8",
    input: "Trace(Matrix(Rationals(), 2, 3, [1/2, 0, 1, 5, -4, 7]));\nTrace(2.5);\nTrace(\"abc\");\nTrace(false);\nTrace([3, 4]);\nTrace({1});\nTrace(3, 4);\nTrace();\n" }).stdout as string;
  for (const said of ["Argument 1 is not square\n", "Bad argument types\nArgument types given: FldReElt\n", "Bad argument types\nArgument types given: MonStgElt\n",
    "Bad argument types\nArgument types given: BoolElt\n", "Bad argument types\nArgument types given: SeqEnum[RngIntElt]\n",
    "Bad argument types\nArgument types given: SetEnum[RngIntElt]\n", "Bad argument types\nArgument types given: RngIntElt, RngIntElt\n",
    "Bad argument types\nArgument types given:\n"])
    assert.ok(bad.includes("Runtime error in 'Trace': " + said), said + "\n" + bad);
  // one index entry for each signature Sagebrush implements, with its own summary
  const index = JSON.parse(spawnSync(process.execPath, [cli, "-m", "_magma_docsearch", "--index"], { encoding: "utf8" }).stdout);
  const trace = index.filter((e: any) => e.name === "Trace");
  assert.deepEqual(trace.map((e: any) => e.signature),
    ["(<RngIntElt> x) -> RngIntElt", "(<FldRatElt> x) -> FldRatElt", "(<FldFinElt> x) -> FldFinElt", "(<FldAlgElt> x) -> RngElt", "(<MtrxS> a) -> RngElt"]);
  assert.equal(new Set(trace.map((e: any) => e.summary)).size, 5);
  assert.match(trace[4].summary, /square matrix/);
  assert.match(trace[4].doc, /The signatures of Trace:\n\n[\s\S]*Trace\(<RngUPolElt> x1\) -> RngUPolElt    \(not supported yet\)/);
  // an intrinsic prints as Magma prints one, with Sagebrush's signatures and words
  const shown = spawnSync(process.execPath, [cli, "--magma"], { input: "Trace;\nFactorial;\n#Sprint(Trace) gt 0;\n", encoding: "utf8" }).stdout as string;
  assert.ok(shown.startsWith("Intrinsic 'Trace'\n\nSignatures:\n\n    (<RngIntElt> x) -> RngIntElt\n\n        An integer is its own trace.\n\n"), shown);
  assert.ok(shown.includes("    (<MtrxS> a) -> RngElt\n\n        The trace of a square matrix: the sum of its diagonal entries.\n"), shown);
  assert.ok(shown.includes("    (<RngUPolElt> x1) -> RngUPolElt\n\n        Not supported yet in Sagebrush.\n"), shown);
  assert.ok(shown.includes("Intrinsic 'Factorial'\n\nSignatures:\n\n    (n)\n\n        "), shown);
  assert.doesNotMatch(shown, /function|0x/);
  assert.match(shown, /true\n$/);
});

test("a matrix's entry A[i, j] is read and assigned as Magma does, also of a matrix arithmetic made", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  const out = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { encoding: "utf8",
    input: "A := Matrix(Rationals(), 2, 2, [2, 1, 5, 3]); B := A^-1;\nA[3,1];\nA[1,0];\nB[1,3];\nA[1,1,1];\nA[<1,1>];\n" +
      "C := Matrix(Integers(), 2, 2, [1, 2, 3, 4]); C[1,2] := 1/2;\nC[<1,2>] := 9;\nt := <1,2>; C[t] := 9;\nC[3,1] := 1;\nC[1,3] := 1;\n" +
      "C[1,2,3] := 1;\nC[1,\"a\"] := 1;\nC;\nF := Matrix(GF(5), 2, 2, [1, 2, 3, 4]);\nB[<2,1>] := 9;\nB[2,1];\n\"end\";\n" }).stdout as string;
  // Magma's words (checked against Magma; its caret is at the "[", which Sagebrush doesn't say yet)
  for (const said of ["Runtime error in '[]': Index 1 (3) should be in the range [1 .. 2]\n", "Runtime error in '[]': Index 2 (0) should be in the range [1 .. 2]\n",
    "Runtime error in '[]': Index 2 (3) should be in the range [1 .. 2]\n", "Runtime error in '[]': Bad argument types\n"])
    assert.ok(out.includes(said), said + out);
  assert.equal(out.split("Runtime error in '[]': Bad argument types").length - 1, 2, out);
  assert.ok(out.includes("Runtime error in :=: RHS cannot be coerced into the coefficient ring"), out);
  // a tuple is one index, never A[i, j] (CORR-67F-1); assignment says its own words
  for (const [said, n] of [["Bad matrix row index type", 3], ["Matrix row index is not in the range [1 .. 2]", 1],
    ["Matrix column index is not in the range [1 .. 2]", 1], ["Illegal number of indices", 1], ["Bad matrix column index type", 1]] as const)
    assert.equal(out.split("Runtime error in :=: " + said + "\n").length - 1, n, said + out);
  assert.ok(out.includes("[1 2]\n[3 4]\n"), out);  // (unchanged by the refused writes)
  // (an entry is one number: it printed the whole matrix before)
  assert.match(out, /\n-5\nend\n$/);
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

test("a multiset printed one element to a line shows each element's multiplicity, as Magma's", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's: {* a^^2, a + 1 *} one to a line;
  // it printed {* a, a + 1 *}, @sagebrush's finding on e65af60e)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["P<t>:=PolynomialRing(Rationals()); K<a>:=NumberField(t^2-2); {* a, a, a+1 *}; S:={* a, a *}; #S;", "{* [1,2], [1,2], [3] *};", "M:=Matrix(Integers(),2,2,[1,2,3,4]); {* M, M *}; [M, M];", "P<x>:=PolynomialRing(Integers()); {* x, x, x+1 *};", "P<t>:=PolynomialRing(Rationals()); K<a>:=NumberField(t^2-2); [ {* a, a *} ];", "{* <1,2>, <1,2> *}; {* 3, 3, 1 *};"].join("\n"));
  assert.equal(ok, "{*\n    a^^2,\n    a + 1\n*}\n2\n{*\n    [ 1, 2 ]^^2,\n    [ 3 ]\n*}\n{*\n    [1 2]\n    [3 4]^^2\n*}\n[\n    [1 2]\n    [3 4],\n\n    [1 2]\n    [3 4]\n]\n{*\n    x^^2,\n    x + 1\n*}\n[\n    {*\n        a^^2\n    *}\n]\n{* <1, 2>^^2 *}\n{* 1, 3^^2 *}\nend\n", ok);
});

test("BaseRing, CoefficientRing, CyclotomicField and a number field's Basis, as Magma's", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's for these lines; a cyclotomic field
  // is one for each n, so a name given to it holds for every handle)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8", timeout: 60000 }).stdout as string;
  const ok = run(["BaseRing(PolynomialRing(Integers())); BaseRing(PolynomialRing(GF(7))); BaseRing(Rationals());", "P<x>:=PolynomialRing(Rationals()); K<a>:=NumberField(x^3-2); BaseRing(K); CoefficientRing(K);", "BaseRing(Matrix(Integers(),2,3,[1..6])); BaseRing(MaximalOrder(QuadraticField(5))); CoefficientRing(Matrix(GF(5),2,2,[1,2,3,4]));", "P<x>:=PolynomialRing(Integers()); BaseRing(x^2+1); BaseRing(Parent(Matrix(Rationals(),2,2,[1,2,3,4])));", "K<z>:=CyclotomicField(5); K; z^5; z^4; Type(z); Type(K); BaseRing(K);", "K:=CyclotomicField(1); K; K.1; Degree(K); K:=CyclotomicField(2); K.1; Basis(K);", "K<z>:=CyclotomicField(5); L<w>:=CyclotomicField(5); z; K eq L;", "K:=CyclotomicField(9); K.1^3; K:=CyclotomicField(12); K; K.1^4;", "K<z>:=CyclotomicField(5); z^-1; (1+z)^-1; 1/2 + z; Norm(z+1); Eltseq(z^2+3);", "K<z>:=CyclotomicField(5); Basis(K);", "P<x>:=PolynomialRing(Rationals()); K<a>:=NumberField(x^3-2); Basis(K); Eltseq(a^2/3+1);", "P<x>:=PolynomialRing(Rationals()); K:=NumberField(x^3-2); Basis(K); K.1^2+1;", "K:=QuadraticField(5); Basis(K); [K.1, K.1+1]; Eltseq(K.1+1/2);", "K<a>:=QuadraticField(-3); Basis(K);", "K<z>:=CyclotomicField(4); z^2; [z, 1/2];"].join("\n"));
  assert.equal(ok, "Integer Ring\nFinite field of size 7\nRational Field\nRational Field\nRational Field\nInteger Ring\nInteger Ring\nFinite field of size 5\nInteger Ring\nRational Field\nCyclotomic Field of order 5 and degree 4\n1\n-z^3 - z^2 - z - 1\nFldCycElt\nFldCyc\nRational Field\nCyclotomic Field of order 1 and degree 1\n1\n1\n-1\n[\n    1\n]\nw\ntrue\nzeta_9^3\nCyclotomic Field of order 12 and degree 4\nzeta_12^2 - 1\n-z^3 - z^2 - z - 1\n-z^3 - z\n1/2*(2*z + 1)\n1\n[ 3, 0, 1, 0 ]\n[\n    1,\n    z,\n    z^2,\n    z^3\n]\n[\n    1,\n    a,\n    a^2\n]\n[ 1, 0, 1/3 ]\n[\n    1,\n    K.1,\n    K.1^2\n]\nK.1^2 + 1\n[ 1, K.1 ]\n[ K.1, K.1 + 1 ]\n[ 1/2, 1 ]\n[ 1, a ]\n-1\n[\n    z,\n    1/2\n]\nend\n", ok);
  // (Magma's errors, each line on its own)
  const P = "P<t>:=PolynomialRing(Rationals()); L<b>:=NumberField(t^2-3); K<z>:=CyclotomicField(5); ";
  const errs: [string, string][] = [
    ["BaseRing(GF(9));", "Runtime error in 'BaseRing': Bad argument types Argument types given: FldFin"],
    ["BaseRing(Integers(6));", "Runtime error in 'BaseRing': Bad argument types Argument types given: RngIntRes"],
    ["BaseRing(3);", "Runtime error in 'BaseRing': Bad argument types Argument types given: RngIntElt"],
    ["CoefficientRing(RealField(10));", "Runtime error in 'CoefficientRing': Bad argument types Argument types given: FldRe"],
    [P + "BaseRing(b);", "Runtime error in 'BaseRing': Bad argument types Argument types given: FldNumElt[FldRat]"],
    [P + "CoefficientRing(z);", "Runtime error in 'CoefficientRing': Bad argument types Argument types given: FldCycElt[FldRat]"],
    ["CyclotomicField(0);", "Runtime error in 'CyclotomicField': Argument 1 (0) is not small and positive"],
    ["CyclotomicField(2^30);", "Runtime error in 'CyclotomicField': Argument 1 (1073741824) is not small and positive"],
    ["CyclotomicField(1/2);", "Runtime error in 'CyclotomicField': Bad argument types Argument types given: FldRatElt"],
    ["Basis(3);", "Runtime error in 'Basis': Bad argument types Argument types given: RngIntElt"],
    [P + "z+b;", "Runtime error in '+': Bad argument types Argument types given: FldCycElt[FldRat], FldNumElt[FldRat]"],
    [P + "[z, b];", "Runtime error in [ ... ]: No valid universe containing all elements"],
    [P + "z/0;", "Runtime error in '/': Argument 2 is not non-zero"],
    [P + "z^2 div z;", "Runtime error in 'div': Bad argument types Argument types given: FldCycElt[FldRat], FldCycElt[FldRat]"],
    [P + "Coefficients(z^2+3);", "Runtime error in 'Coefficients': Bad argument types Argument types given: FldCycElt[FldRat]"],
    [P + "K!b;", "Runtime error in '!': Illegal coercion LHS: FldCyc RHS: FldNumElt"],
    // (refused: Magma computes these in a larger cyclotomic field, or a
    // field beyond the degree bound)
    ["CyclotomicField(97);", "CyclotomicField of degree more than 24 is not supported yet"],
    [P + "M<w>:=CyclotomicField(7); z+w;", "of a cyclotomic field's element and an element of another cyclotomic field is not supported yet"],
    [P + "M<w>:=CyclotomicField(7); [z, w];", "a collection of a cyclotomic field's elements and another cyclotomic field's element is not supported yet"],
    [P + "M<w>:=CyclotomicField(7); z eq w;", "of a cyclotomic field's element and an element of another cyclotomic field is not supported yet"],
    ["Basis(MaximalOrder(QuadraticField(5)));", "Basis of a RngQuad is not supported yet"],
    ["ClassNumber(CyclotomicField(17));", "the class group or units of a cyclotomic field of degree more than 12 are not supported yet"],
  ];
  for (const [e, m] of errs) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end ") && !/Traceback|TypeError|ZeroDivision/.test(o), e + " => " + o);
  }
});

test("a collection over a number field coerces its items as Magma's, declared or inferred, another cyclotomic field's where its field embeds (CORR-E65-1, CORR-E65-2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's; astra2 on e65af60e)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["K<z>:=CyclotomicField(5); Type([z,1][2]); Type([z,1/2][2]); Type(Setseq({z,1})[1]); [z, 1/2];", "K<z>:=CyclotomicField(5); N<y>:=CyclotomicField(10); x:=[K|y]; x; Parent(x[1]) eq K;", "K<z>:=CyclotomicField(4); M<w>:=CyclotomicField(8); x:=[M|z]; x; Parent(x[1]) eq M;", "K<z>:=CyclotomicField(3); M<w>:=CyclotomicField(6); [M|z]; [K|w];", "K<z>:=CyclotomicField(5); M<w>:=CyclotomicField(1); [K|w]; Parent([K|w][1]) eq K;", "K<z>:=CyclotomicField(15); M<w>:=CyclotomicField(10); [K|w, w^2+1/2];", "P<t>:=PolynomialRing(Rationals()); L<b>:=NumberField(t^2-3); Type([b,1][2]); [b, 1/2]; [L|1, b];"].join("\n"));
  assert.equal(ok, "FldCycElt\nFldCycElt\nFldCycElt\n[\n    z,\n    1/2\n]\n[\n    -z^3\n]\ntrue\n[\n    w^2\n]\ntrue\n[\n    w - 1\n]\n[\n    z + 1\n]\n[\n    1\n]\ntrue\n[\n    -z^7 + z^6 + z^3 - z^2 + 1,\n    1/2*(2*z^3 + 1)\n]\nFldNumElt\n[\n    b,\n    1/2\n]\n[\n    1,\n    b\n]\nend\n", ok);
  const P = "P<t>:=PolynomialRing(Rationals()); L<b>:=NumberField(t^2-3); J<c>:=NumberField(t^2-5); K<z>:=CyclotomicField(5); M<w>:=CyclotomicField(7); ";
  const errs: [string, string][] = [["x:=[K|w];", "Runtime error in [ ... ]: Coerce failed for sequence element"],
    ["x:={K|w};", "Runtime error in { ... }: Cannot coerce argument 1 into the universe"], ["x:={@K|w@};", "Runtime error in {@ ... @}: Cannot coerce argument 1 into the universe"],
    ["x:={*K|w*};", "Runtime error in sub< ... >: Cannot coerce argument 1 into the universe"], ["x:=[K|b];", "Runtime error in [ ... ]: Coerce failed for sequence element"],
    ["x:=[L|c];", "Runtime error in [ ... ]: Coerce failed for sequence element"], ["x:=[L|z];", "Runtime error in [ ... ]: Coerce failed for sequence element"],
    ["x:=[b, z];", "Runtime error in [ ... ]: No valid universe containing all elements"],
    ["N<y>:=CyclotomicField(15); x:=[K|y];", "Runtime error in [ ... ]: Coerce failed for sequence element"]];
  for (const [e, m] of errs) {
    const o = run(P + e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end "), e + " => " + o);
  }
});

test("a zero cyclotomic element still decides a literal's universe; another field's element of rational value goes into a declared number field as that rational", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's; astra2 on e3d3d0e1)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["P<t>:=PolynomialRing(Rationals()); L<b>:=NumberField(t^2-3); K<z>:=CyclotomicField(5); M<w>:=CyclotomicField(7); x:=[K|L!3]; x; Parent(x[1]) eq K; y:=[K|M!(1/2)]; y; Parent(y[1]) eq K; u:=[L|K!2]; u; Parent(u[1]) eq L;"].join("\n"));
  assert.equal(ok, "[\n    3\n]\ntrue\n[\n    1/2\n]\ntrue\n[\n    2\n]\ntrue\nend\n", ok);
  const P = "P<t>:=PolynomialRing(Rationals()); L<b>:=NumberField(t^2-3); K<z>:=CyclotomicField(5); ";
  for (const [e, m] of [["x:=[b, K!0];", "Runtime error in [ ... ]: No valid universe containing all elements"],
    ["x:=[K!0, b];", "Runtime error in [ ... ]: No valid universe containing all elements"],
    ["x:=[z, L!3];", "Runtime error in [ ... ]: No valid universe containing all elements"],
    ["x:=[K | L!3, b];", "Runtime error in [ ... ]: Coerce failed for sequence element"]]) {
    const o = run(P + e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end "), e + " => " + o);
  }
});

test("&+ and &* of an empty collection: its universe's zero and one, Magma's error with none (WA-027)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (checked against Magma 2.18: a declared universe's, the integers', an
  // emptied one's; written empty, Magma's error; astra2's WA-027)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["S:=[RealField(15)|]; x:=&+S; x; Type(x); Parent(x);", "S:=[RealField(15)|]; x:=&*S; x;", "S:={RealField(15)|}; Type(&+S);",
    "P<y>:=PolynomialRing(Rationals()); K<c>:=NumberField(y^2-5); S:=[K|]; x:=&+S; x; Type(x); Parent(x) eq K; Type(&*S);",
    "P<y>:=PolynomialRing(Rationals()); S:=[P|]; Type(&+S); &*S;", "S:=[Rationals()|]; Type(&+S);", "S:=[GF(5)|]; x:=&*S; x; Type(x);",
    "M:=Matrix(Integers(),2,3,[1..6]); S:=[Parent(M)|]; &+S;", "M:=Matrix(Integers(),2,2,[1..4]); S:=[Parent(M)|]; &*S;",
    "S:=[RealField(15)!1]; Remove(~S,1); x:=&+S; x;", "P<y>:=PolynomialRing(Rationals()); K<c>:=NumberField(y^2-5); S:=[c]; Remove(~S,1); Type(&+S);",
    "S:=[Integers(6)|]; Type(&+S);", "S:=[1/2]; Remove(~S,1); Type(&+S);", "&+[Integers()|]; &*[1..0]; S:=[1]; Remove(~S,1); &+S;"].join("\n"));
  assert.equal(ok, "0.000000000000000\nFldReElt\nReal field of precision 15\n1.00000000000000\nFldReElt\n0\nFldNumElt\ntrue\nFldNumElt\n" +
    "RngUPolElt\n1\nFldRatElt\n1\nFldFinElt\n[0 0 0]\n[0 0 0]\n[1 0]\n[0 1]\n0.000000000000000\nFldNumElt\nRngIntResElt\nFldRatElt\n0\n1\n0\nend\n", ok);
  const bad = run(["&+[];", "&*{};", "&+[x : x in [1..0]];", "M:=Matrix(Integers(),2,3,[1..6]); S:=[Parent(M)|]; x:=&*S;"].join("\n")).replace(/\s+/g, " ");
  for (const m of ["Runtime error in '&+': Illegal null sequence", "Runtime error in '&*': Illegal null set", "Runtime error in '&*': Universe has no one element"])
    assert.ok(bad.includes(m), m + bad);
  assert.equal(bad.split("Illegal null sequence").length - 1, 2, bad);
});

test("a multiset operation whose coerced elements would coincide is refused, not miscounted (WA-028)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (Magma 2.18: GF(5)'s emptied {* *} join {* 1, 6, 11 *} is {* 1 *}, a
  // count Sagebrush doesn't model: refused; without such a coincidence
  // the counts are Magma's; astra2's WA-028)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  for (const e of ["F:=GF(5); S:={*F!2*}; Exclude(~S,F!2); T:={*1,6,11*}; R:=S join T;", "F:=GF(5); T:={*1,6,11*}; R:={*F|*} join T;",
    "F:=GF(5); S:={*F!2*}; Exclude(~S,F!2); T:={*1,6,11*}; R:=S sdiff T;", "F:=GF(5); S:={*F!2*}; Exclude(~S,F!2); T:={*1,6,11*}; R:=T diff S;"]) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes("a multiset operation where different elements coincide in the universe is not supported yet") && o.endsWith("end "), e + o);
  }
  const ok = run(["F:=GF(5); S:={*F!2*}; Exclude(~S,F!2); T:={*1,1*}; R:=S join T; #R;", "P<x>:=PolynomialRing(Rationals()); K<c>:=NumberField(x^2-5); S:={*c*}; Exclude(~S,c); T:={*1,1*}; R:=S join T; #R;",
    "R:={*1,1*} join {*1*}; #R;"].join("\n"));
  assert.equal(ok, "2\n2\n3\nend\n", ok);
});

test("a square product of matrices not square is of a module of matrices, as Magma's (WA-026)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's: ModMatRngElt for A * Transpose(A)
  // and what Magma keeps there; with an algebra's matrix a sum is the
  // algebra's; astra2's WA-026)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); Type(B); Parent(B); B; Type(Transpose(A)*A);", "A:=Matrix(Rationals(),2,3,[1..6]); B:=A*Transpose(A); Type(B); Parent(B); Type(B^-1);", "A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); I:=Matrix(Integers(),2,2,[1,0,0,1]); Type(B*B); Type(B+B); Type(B-B); Type(B^2); Type(B^0); Type(-B); Type(2*B); Type(B*2);", "A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); I:=Matrix(Integers(),2,2,[1,0,0,1]); Type(Transpose(B)); Type(B*I); Type(I*B); Type(B+I); Type(I-B); Determinant(B); B eq Matrix(Integers(),2,2,[14,32,32,77]);", "A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); Type(HermiteForm(B)); Type(EchelonForm(B)); Type(Matrix(Integers(),3,3,[1..9])*Transpose(A)*A);", "Type(Matrix(Integers(),2,2,[1..4])*Matrix(Integers(),2,2,[1..4])); B:=Matrix(Integers(),1,2,[1,2]); Type(B*Transpose(B)); Type(Matrix(Integers(),1,1,[2]));"].join("\n"));
  assert.equal(ok, "ModMatRngElt\nFull RMatrixSpace of 2 by 2 matrices over Integer Ring\n[14 32]\n[32 77]\nModMatRngElt\nModMatFldElt\nFull KMatrixSpace of 2 by 2 matrices over Rational Field\nModMatFldElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nModMatRngElt\nAlgMatElt\nAlgMatElt\n54\ntrue\nModMatRngElt\nModMatRngElt\nModMatRngElt\nAlgMatElt\nModMatRngElt\nAlgMatElt\nend\n", ok);
  // (over a finite field, and SmithForm and LLL of one: refused)
  for (const [e, m] of [["A:=Matrix(GF(5),2,3,[1..6]); B:=A*Transpose(A);", "a square product of matrices over a finite field not square is not supported yet"],
    ["A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); X:=SmithForm(B);", "SmithForm of a matrix of a module of matrices (a product of matrices not square) is not supported yet"]]) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end "), e + o);
  }
});

test("a power of an integer or rational matrix is admitted by the size of its entries before it computes (HARD-CA8-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (repeated squaring bounds the number of products, not their size:
  // [2 0; 0 2]^(10^9) has entries of 10^9 bits; refused before any
  // squaring, a negative power too; small powers as Magma's)
  const t0 = Date.now();
  const src = "M:=Matrix(Integers(),2,2,[2,0,0,2]); X:=M^(10^9);\nX:=M^(-10^9);\nN:=Matrix(Rationals(),3,3,[1/2,1,2,3,5/3,8,13,21,34]); X:=N^(10^7);\n" +
    "M:=Matrix(Integers(),2,2,[1,1,1,0]); (M^100)[1][1]; (M^-3)[1][1]; Type(M^100);\nA:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); Type(B^3); (B^3)[1][1];\n\"end\";\n";
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src, encoding: "utf8", timeout: 60000 });
  assert.equal(r.signal, null, r.stderr);
  const out = r.stdout.replace(/\s+/g, " ");
  assert.equal((out.match(/a power of a \d by \d matrix whose entries could have more than 2097152 bits \(8388608 in all\)/g) ?? []).length, 3, r.stdout);
  assert.ok(r.stdout.endsWith("573147844013817084101\n-1\nAlgMatElt\nModMatRngElt\n110264\nend\n"), r.stdout);
  assert.ok(Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
});

test("a negative power of an integer matrix needs a unit determinant and stays integral; a module of matrices has a zero but no one (CORR-CA8-1, CORR-CA8-2)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's; astra2 on ca8e1e20)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["A:=Matrix(Integers(),2,3,[1,0,0,0,1,0]); B:=A*Transpose(A); X:=B^-1; Type(X); X;", "M:=Matrix(Integers(),2,2,[1,1,0,1]); X:=M^-1; X; Type(X); Parent(X);", "M:=Matrix(Rationals(),2,2,[1,2,3,4]); M^-1;", "A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); S:=[B]; Remove(~S,1); Type(&+S); &+S;", "A:=Matrix(Rationals(),2,3,[1..6]); B:=A*Transpose(A); S:=[B]; Remove(~S,1); Type(&+S);"].join("\n"));
  assert.equal(ok, "ModMatRngElt\n[1 0]\n[0 1]\n[ 1 -1]\n[ 0  1]\nAlgMatElt\nFull Matrix Algebra of degree 2 over Integer Ring\n[  -2    1]\n[ 3/2 -1/2]\nModMatRngElt\n[0 0]\n[0 0]\nModMatFldElt\nend\n", ok);
  for (const [e, m] of [["A:=Matrix(Integers(),2,3,[1..6]); B:=A*Transpose(A); X:=B^-1;", "Runtime error in '^': Argument 1 is not invertible"],
    ["M:=Matrix(Integers(),2,2,[2,0,0,1]); X:=M^-2;", "Runtime error in '^': Argument 1 is not invertible"],
    ["M:=Matrix(Rationals(),2,2,[1,2,2,4]); X:=M^-1;", "Runtime error in '^': Argument 1 is not invertible"],
    ["A:=Matrix(Rationals(),2,3,[1..6]); B:=A*Transpose(A); S:=[B]; Remove(~S,1); X:=&*S;", "Runtime error in '&*': Universe has no one element"]]) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end "), e + o);
  }
});

test("DihedralGroup as Magma's: its printing, generators, order, membership, equality and errors", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's for the same lines: DihedralGroup(3)
  // is Sym(3), printed without its generators until one is asked for)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  const ok = run(["G:=DihedralGroup(4); G; #G; Order(G); Type(G);", "G:=DihedralGroup(3); G; #G; G.1; G.2; G;", "G:=DihedralGroup(5); G.1; G.2; G.1*G.2; Order(G.1); Order(G.2);", "G:=DihedralGroup(4); G eq DihedralGroup(4); G eq Sym(4); G ne DihedralGroup(4); DihedralGroup(3) eq Sym(3); Sym(3) eq DihedralGroup(3);", "G:=DihedralGroup(4); G.0; G.1^-1; G.2^-1;", "G:=DihedralGroup(4); x:=G.1*Sym(4)!(1,2); x; Parent(x);", "G:=DihedralGroup(4); G.1 eq Sym(4)!(1,2,3,4); G.1 in Sym(4); Sym(4)!G.1; Sym(4)!(1,2) in G; Sym(4)!(1,3) in G;", "G:=DihedralGroup(4); Order(G.1); Identity(G); G.1^G.2; G.2^2; Parent(G.1) eq G;", "G:=DihedralGroup(4); G!(1,2,3,4); 1^G.1; 2^G.2; Identity(G);", "G:=DihedralGroup(6); G; #G; Type(G.1); G.1*G.2;", "DihedralGroup(4);", "G:=DihedralGroup(4); x:=G.1; y:=DihedralGroup(4).1; x*y;", "G:=DihedralGroup(12); G;"].join("\n"));
  assert.equal(ok, "Permutation group G acting on a set of cardinality 4\nOrder = 8 = 2^3\n    (1, 2, 3, 4)\n    (1, 4)(2, 3)\n8\n8\nGrpPerm\nSymmetric group G acting on a set of cardinality 3\nOrder = 6 = 2 * 3\n6\n(1, 2, 3)\n(1, 2)\nSymmetric group G acting on a set of cardinality 3\nOrder = 6 = 2 * 3\n    (1, 2, 3)\n    (1, 2)\n(1, 2, 3, 4, 5)\n(1, 5)(2, 4)\n(1, 4)(2, 3)\n5\n2\ntrue\nfalse\nfalse\ntrue\ntrue\nId(G)\n(1, 4, 3, 2)\n(1, 4)(2, 3)\n(2, 3, 4)\nSymmetric group acting on a set of cardinality 4\nOrder = 24 = 2^3 * 3\ntrue\ntrue\n(1, 2, 3, 4)\nfalse\ntrue\n4\nId(G)\n(1, 4, 3, 2)\nId(G)\ntrue\n(1, 2, 3, 4)\n2\n3\nId(G)\nPermutation group G acting on a set of cardinality 6\nOrder = 12 = 2^2 * 3\n    (1, 2, 3, 4, 5, 6)\n    (1, 6)(2, 5)(3, 4)\n12\nGrpPermElt\n(1, 5)(2, 4)\nPermutation group acting on a set of cardinality 4\nOrder = 8 = 2^3\n    (1, 2, 3, 4)\n    (1, 4)(2, 3)\n(1, 3)(2, 4)\nPermutation group G acting on a set of cardinality 12\nOrder = 24 = 2^3 * 3\n    (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)\n    (1, 12)(2, 11)(3, 10)(4, 9)(5, 8)(6, 7)\nend\n", ok);
  const errs: [string, string][] = [
    ["X:=DihedralGroup(1);", "Runtime error in 'DihedralGroup': Argument 1 (1) should be >= 3"],
    ["X:=DihedralGroup(2);", "Runtime error in 'DihedralGroup': Argument 1 (2) should be >= 3"],
    ["X:=DihedralGroup(-1);", "Runtime error in 'DihedralGroup': Argument 1 (-1) should be >= 3"],
    ["X:=DihedralGroup(1/2);", "Runtime error in 'DihedralGroup': Bad argument types Argument types given: FldRatElt"],
    ["G:=DihedralGroup(4); x:=G.3;", "Runtime error in '.': Argument 2 (3) should be in the range [-2 .. 2]"],
    ["G:=DihedralGroup(4); x:=G!(1,2);", "Runtime error in '!': Illegal coercion LHS: GrpPerm RHS: GrpPermElt"],
    ["x:=DihedralGroup(4) eq DihedralGroup(5);", "Runtime error in 'eq': Could not find a covering group"],
    // (refused: Magma's element order, and its wrapping of a long generator)
    ["G:=DihedralGroup(4); x:=[g : g in G];", "iterating over a dihedral group is not supported yet"],
    ["G:=DihedralGroup(30); G;", "printing a dihedral group whose generators are longer than a line is not supported yet"],
  ];
  for (const [e, m] of errs) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end "), e + " => " + o);
  }
});

test("a dihedral group too wide to print is refused before either generator is rendered (LIMIT-714-1)", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  // (the refusal is decided by counting, at most about a line's worth of
  // steps: no permutation is printed for DihedralGroup(10^4); and the count
  // agrees with the generators' printed lengths where they are printed)
  const f = join(mkdtempSync(join(tmpdir(), "magma-dihedral-")), "check.py");
  writeFileSync(f, [
    "import _magma as m",
    "calls = [0]",
    "orig = m._MPerm.__repr__",
    "def spy(self):",
    "    calls[0] += 1",
    "    return orig(self)",
    "m._MPerm.__repr__ = spy",
    "try:",
    "    repr(m.DihedralGroup(10 ** 4))",
    "    print('printed')",
    "except m.MagmaError as e:",
    "    print('refused', calls[0])",
    "bad = [n for n in range(3, 60) if m._MDihedralGroup(n)._gens_fit(m.WIDTH - 5) != all(len(orig(g)) <= m.WIDTH - 5 for g in m._MDihedralGroup(n)._gens())]",
    "print('disagree', bad)",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), f], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.stdout, "refused 0\ndisagree []\n", r.stdout + r.stderr);
});

test("DihedralGroup(3) is Sym(3) in a set, and groups meet in collections as Magma's (CORR-DG-1)", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's for the same lines: one element for
  // DihedralGroup(3) and Sym(3), false for groups of two degrees)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  assert.equal(run("D := DihedralGroup(3); S := Sym(3); #{D, S}; #{S, D}; D in {S}; S in {D}; D notin {S}; #{@ S, D @}; #{* D, S *}; S in {@ D @}; D in [S];\n#{DihedralGroup(4), Sym(4)}; #{DihedralGroup(4), Sym(5)}; #{DihedralGroup(4), DihedralGroup(4)}; #{Sym(3), Sym(4)};\nDihedralGroup(4) in {Sym(4)}; DihedralGroup(4) in {Sym(5)}; DihedralGroup(4) in [Sym(4), DihedralGroup(4)]; Index([Sym(4), DihedralGroup(4)], DihedralGroup(4)); Sym(5) in [DihedralGroup(4)];\n#Append([Sym(4)], DihedralGroup(5)); #Include({Sym(3)}, DihedralGroup(3)); #Include({Sym(4)}, DihedralGroup(4)); #Exclude({Sym(3)}, DihedralGroup(3)); Index([Sym(4)], Sym(5)); Position([DihedralGroup(3)], Sym(3));\nD := DihedralGroup(3); S := Sym(3); Index([D], S); Index([S], D); Position([S, D], D);\n#Insert([Sym(4)], 1, Sym(3)); #([Sym(4)] cat [DihedralGroup(6)]);"), "1\n1\ntrue\ntrue\nfalse\n1\n2\ntrue\ntrue\n2\n2\n1\n2\nfalse\nfalse\ntrue\n2\nfalse\n2\n1\n2\n0\n0\n1\n1\n1\n1\n2\n2\nend\n");
  const errs: [string, string][] = [
    // (refused: Magma's order of the groups in a set, and its naming of them)
    ["X:={DihedralGroup(4), Sym(4)}; X;", "printing a set of permutation groups is not supported yet"],
    ["D:=DihedralGroup(3); S:=Sym(3); X:={D, S}; X;", "printing a set of permutation groups is not supported yet"],
    ["X:={DihedralGroup(4), Sym(4)}; Y:=[G : G in X];", "the order of a set of permutation groups is not supported yet"],
  ];
  for (const [e, m] of errs) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end "), e + " => " + o);
  }
});

test("VectorSpace, KSpace and RSpace as Magma's: unit vectors, coercion, membership, equality, Basis, Generators and Zero", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's for the same lines, and so are the
  // errors; then Sagebrush's refusals: Magma's order of a set of vectors,
  // vectors of degree 0, other rings, and the size bounds)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  assert.equal(run("V := VectorSpace(Rationals(), 3); V; Type(V); Dimension(V); Degree(V);\nV.1; V.3; Type(V.1); Parent(V.1); Basis(V);\nv := V![1,2,3]; v; v in V; V!0; Zero(V); V![1/2, 0, 1]; 2*V.1 - V.3;\nW := RSpace(Integers(), 2); W; Type(W); Basis(W); W.1 + W.2; W![4,5]; Zero(W); RSpace(Integers(),3)!V.1;\nK := KSpace(Rationals(), 2); K; K eq VectorSpace(Rationals(), 2); RSpace(Rationals(), 2);\nV eq VectorSpace(Rationals(), 3); V ne V; Type(V) eq ModTupFld; Type(W) eq ModTupRng;\nVector([1,2,3]) in RSpace(Integers(), 3); Vector(Rationals(), [1,2,3]) eq v; V!Vector([1,2,3]); Type(V!Vector([1,2,3]));\n#Generators(V); V.2 in Generators(V); Generators(V) eq {V.1, V.2, V.3}; Generators(VectorSpace(Rationals(), 1));\nX := VectorSpace(Rationals(), 0); X; Basis(X); Dimension(X); Generators(X);\nZero(Integers()); Zero(Rationals()); Eltseq(V.2); Universe(Eltseq(V.2)); Universe(Eltseq(W.1));\n[V| [1,2,3], 0]; {Vector([1,0])};"), "Full Vector space of degree 3 over Rational Field\nModTupFld\n3\n3\n(1 0 0)\n(0 0 1)\nModTupFldElt\nFull Vector space of degree 3 over Rational Field\n[\n    (1 0 0),\n    (0 1 0),\n    (0 0 1)\n]\n(1 2 3)\ntrue\n(0 0 0)\n(0 0 0)\n(1/2   0   1)\n( 2  0 -1)\nFull RSpace of degree 2 over Integer Ring\nModTupRng\n[\n    (1 0),\n    (0 1)\n]\n(1 1)\n(4 5)\n(0 0)\n(1 0 0)\nFull Vector space of degree 2 over Rational Field\ntrue\nFull Vector space of degree 2 over Rational Field\ntrue\nfalse\ntrue\ntrue\ntrue\ntrue\n(1 2 3)\nModTupFldElt\n3\ntrue\ntrue\n{\n    (1)\n}\nFull Vector space of degree 0 over Rational Field\n[]\n0\n{}\n0\n0\n[ 0, 1, 0 ]\nRational Field\nInteger Ring\n[\n    (1 2 3),\n    (0 0 0)\n]\n{\n    (1 0)\n}\nend\n");
  // (a collection over a vector space: each element coerced into it, as V!x,
  // when made, appended, included, assigned, and for in and Index)
  assert.equal(run("V := VectorSpace(Rationals(), 3); [V| [1,2,3], 0]; [V| ]; {V| [1,2,3]}; {@V| [1,2,3], V.1 @};\nS := [V| V.1]; Append(S, [1,2,3]); Append(~S, 0); S; Include({V| V.1}, [0,1,0]) eq {V.1, V.2};\nS := [V| V.1]; [1,2,3] in S; V.1 in S; V.2 in S; [1,0,0] in S; 0 in S; Vector([1,0,0]) in S; Index(S, V.1); Position(S, [1,0,0]); Index(S, 0);\nT := {V| V.1}; [1,0,0] in T; Vector([1,0,0]) in T; [1,0,0] notin T;\n[1,0,0] in Basis(V); [1,0,0] in Generators(V); Universe(Basis(V)); Universe(Generators(V)); Index(Basis(V), [0,0,1]);\nS := [V| V.1]; S[2] := [1,2,3]; S;\nW := RSpace(Integers(), 2); [W| [4,5], W.2];"), "[\n    (1 2 3),\n    (0 0 0)\n]\n[]\n{\n    (1 2 3)\n}\n{@\n    (1 2 3),\n    (1 0 0)\n@}\n[\n    (1 0 0),\n    (1 2 3)\n]\n[\n    (1 0 0),\n    (0 0 0)\n]\ntrue\nfalse\ntrue\nfalse\ntrue\nfalse\ntrue\n1\n1\n0\ntrue\ntrue\nfalse\ntrue\ntrue\nFull Vector space of degree 3 over Rational Field\nFull Vector space of degree 3 over Rational Field\n3\n[\n    (1 0 0),\n    (1 2 3)\n]\n[\n    (4 5),\n    (0 1)\n]\nend\n");
  // (conversions keep the vector space: what goes in later is coerced, astra
  // CORR-7E2-1; astra's five cases)
  assert.equal(run("V := VectorSpace(Rationals(),2); S := Setseq({V|}); Append(~S,[1,2]); S;\nV := VectorSpace(Rationals(),2); S := Seqset([V|]); Include(~S,[1,2]); S;\nV := VectorSpace(Rationals(),2); S := Setseq({V|V.1}); [1,0] in S;\nV := VectorSpace(Rationals(),2); S := Eltseq([V|]); Append(~S,[1,2]); S;\nV := VectorSpace(Rationals(),2); S := Set([V|]); Include(~S,[1,2]); S;\nV := VectorSpace(Rationals(),2); Universe(Setseq({V|V.1})); Universe(Seqset([V| V.2])); Universe(Eltseq([V| V.1]));\nV := VectorSpace(Rationals(),2); Eltseq(Basis(V)); Eltseq([V| V.1, V.2]);"), "[\n    (1 2)\n]\n{\n    (1 2)\n}\ntrue\n[\n    (1 2)\n]\n{\n    (1 2)\n}\nFull Vector space of degree 2 over Rational Field\nFull Vector space of degree 2 over Rational Field\nFull Vector space of degree 2 over Rational Field\n[\n    (1 0),\n    (0 1)\n]\n[\n    (1 0),\n    (0 1)\n]\nend\n");
  const errs: [string, string][] = [
    ["V := VectorSpace(Rationals(), 3); x := V.4;", "Runtime error in '.': Argument 2 (4) should be in the range [1 .. 3]"],
    ["V := VectorSpace(Rationals(), 3); x := V.0;", "Runtime error in '.': Argument 2 (0) should be in the range [1 .. 3]"],
    ["V := VectorSpace(Rationals(), 0); x := V.1;", "Runtime error in '.': Argument 2 (1) should be in the range [1 .. 0]"],
    ["V := VectorSpace(Rationals(), -1);", "Runtime error in 'VectorSpace': Argument 2 (-1) should be >= 1"],
    ["V := RSpace(Integers(), -1);", "Runtime error in 'RSpace': Argument 2 (-1) should be >= 1"],
    ["V := VectorSpace(Integers(), 2);", "Runtime error in 'VectorSpace': Argument 1 is not a field"],
    ["V := KSpace(Integers(), 2);", "Runtime error in 'KSpace': Argument 1 is not a field"],
    ["V := RSpace(Integers(), 1/2);", "Runtime error in 'RSpace': Bad argument types Argument types given: RngInt, FldRatElt"],
    ["V := VectorSpace(5, 2);", "Runtime error in 'VectorSpace': Bad argument types Argument types given: RngIntElt, RngIntElt"],
    ["V := VectorSpace(Rationals());", "Runtime error in 'VectorSpace': Bad argument types Argument types given: FldRat"],
    ["V := VectorSpace(Rationals(), true);", "Runtime error in 'VectorSpace': Bad argument types Argument types given: FldRat, BoolElt"],
    ["V := VectorSpace(Rationals(), 2, 3);", "Runtime error in 'VectorSpace': Bad argument types Argument types given: FldRat, RngIntElt, RngIntElt"],
    ["V := VectorSpace(Rationals(), 3); x := V![1,2];", "Runtime error in '!': Sequence argument length (2) should be 3 to be coerced into a matrix or vector"],
    ["V := VectorSpace(Rationals(), 2); x := V![];", "Runtime error in '!': Sequence argument length (0) should be 2 to be coerced into a matrix or vector"],
    ["V := VectorSpace(Rationals(), 3); x := #V;", "Runtime error in '#': Cardinality is infinite or not feasibly computable"],
    ["W := RSpace(Integers(), 2); x := #W;", "Runtime error in '#': Cardinality is infinite or not feasibly computable"],
    ["W := RSpace(Integers(), 2); x := W![1/2, 1];", "Runtime error in '!': Cannot coerce sequence element 1 into the coefficient ring"],
    ["V := VectorSpace(Rationals(), 2); x := V![\"a\", \"b\"];", "Runtime error in '!': Cannot coerce sequence element 1 into the coefficient ring"],
    ["V := VectorSpace(Rationals(), 3); x := V!(1/2);", "Runtime error in '!': Illegal coercion LHS: ModTupFld RHS: FldRatElt"],
    ["W := RSpace(Integers(), 2); x := W!1;", "Runtime error in '!': Illegal coercion LHS: ModTupRng RHS: RngIntElt"],
    ["V := VectorSpace(Rationals(), 3); x := V!\"a\";", "Runtime error in '!': Illegal coercion LHS: ModTupFld RHS: MonStgElt"],
    ["V := VectorSpace(Rationals(), 3); x := V!true;", "Runtime error in '!': Illegal coercion LHS: ModTupFld RHS: BoolElt"],
    ["V := VectorSpace(Rationals(), 3); x := V!Vector([1,2]);", "Runtime error in '!': Arguments have incompatible degrees LHS: ModTupFld RHS: ModTupRngElt"],
    ["V := VectorSpace(Rationals(), 3); x := RSpace(Integers(),3)!(V.1/2);", "Runtime error in '!': Cannot coerce element from source coefficent ring into the destination coefficient ring"],
    ["V := VectorSpace(Rationals(), 3); x := Vector([1,2,3]) in V;", "Runtime error in 'in': Arguments are not compatible"],
    ["V := VectorSpace(Rationals(), 3); x := Vector(Rationals(), [1,2]) in V;", "Runtime error in 'in': Arguments are not compatible"],
    ["V := VectorSpace(Rationals(), 3); x := 1 in V;", "Runtime error in 'in': Bad argument types"],
    ["V := VectorSpace(Rationals(), 3); x := V eq VectorSpace(Rationals(), 2);", "Runtime error in 'eq': Arguments are not compatible Argument types given: ModTupFld[FldRat], ModTupFld[FldRat]"],
    ["V := VectorSpace(Rationals(), 3); x := V eq RSpace(Integers(), 3);", "Runtime error in 'eq': Arguments are not compatible Argument types given: ModTupRng[FldRat], ModTupRng[RngInt]"],
    ["x := RSpace(Integers(), 2) eq RSpace(Integers(), 3);", "Runtime error in 'eq': Arguments are not compatible Argument types given: ModTupRng[RngInt], ModTupRng[RngInt]"],
    ["x := RSpace(Integers(), 2) eq VectorSpace(Rationals(), 2);", "Runtime error in 'eq': Arguments are not compatible Argument types given: ModTupRng[RngInt], ModTupRng[FldRat]"],
    ["V := VectorSpace(Rationals(), 2); x := V eq 1;", "Runtime error in 'eq': Bad argument types Argument types given: ModTupFld[FldRat], RngIntElt"],
    ["V := VectorSpace(Rationals(), 2); x := V eq Rationals();", "Runtime error in 'eq': Bad argument types Argument types given: ModTupFld[FldRat], FldRat"],
    ["x := Zero(5);", "Runtime error in 'Zero': Bad argument types Argument types given: RngIntElt"],
    ["x := Basis(Sym(3));", "Runtime error in 'Basis': Bad argument types Argument types given: GrpPerm"],
    ["V := VectorSpace(Rationals(), 3); Generators(V);", "the order of a set of vectors is not supported yet"],
    ["X := {Vector([1,0]), Vector([0,1])}; X;", "the order of a set of vectors is not supported yet"],
    ["V := VectorSpace(Rationals(), 2); for v in Generators(V) do v; end for;", "the order of a set of vectors is not supported yet"],
    ["x := Zero(VectorSpace(Rationals(), 0));", "a vector of degree 0 is not supported yet"],
    ["x := VectorSpace(Rationals(), 0)!0;", "a vector of degree 0 is not supported yet"],
    ["x := VectorSpace(GF(5), 2);", "VectorSpace over a ring other than the integers or the rationals is not supported yet"],
    ["x := VectorSpace(Rationals(), 10^9);", "a vector space of degree more than"],
    ["x := Basis(VectorSpace(Rationals(), 10^4));", "Basis of a vector space of degree more than"],
    ["x := Generators(RSpace(Integers(), 10^4));", "Generators of a vector space of degree more than"],
    ["x := Generators(Sym(3));", "Generators of a GrpPerm is not supported yet"],
    ["V := VectorSpace(Rationals(), 2); x := V![true, false];", "coercion of a sequence of these elements into a vector space is not supported yet"],
    ["V := VectorSpace(Rationals(), 3); x := [V| [1,2]];", "Runtime error in [ ... ]: Coerce failed for sequence element"],
    ["W := RSpace(Integers(), 2); x := [W| [1/2, 1]];", "Runtime error in [ ... ]: Coerce failed for sequence element"],
    ["V := VectorSpace(Rationals(), 3); x := {V| [1,2]};", "Runtime error in { ... }: Cannot coerce argument 1 into the universe"],
    ["V := VectorSpace(Rationals(), 3); x := {@V| 1/2 @};", "Runtime error in {@ ... @}: Cannot coerce argument 1 into the universe"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := Append(S, [1,2]);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := Append(S, 1/2);", "Runtime error in 'Append': Cannot coerce element into the universe"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := Index(S, [1,2]);", "Runtime error in 'Index': Cannot coerce element into the universe"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := 1 in S;", "Runtime error in 'in': No valid universe containing all elements"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := (1/2) in S;", "Runtime error in 'in': No valid universe containing all elements"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := \"a\" in S;", "Runtime error in 'in': No valid universe containing all elements"],
    ["V := VectorSpace(Rationals(), 3); S := [V| V.1]; x := Vector(Rationals(), [1,0]) in S;", "Runtime error in 'in': No valid universe containing all elements"],
    ["V := VectorSpace(Rationals(), 3); x := [V| V.1] cat [V| V.2];", "concatenating sequences over a vector space is not supported yet"],
    ["V := VectorSpace(Rationals(), 10^4); v := V.1; x := [V| v : i in [1..101]];", "a collection of vectors with more than"],
    // (astra CORR-7E2-2: a multiset's enumeration, Sprint, a set in a tuple)
    ["V := VectorSpace(Rationals(),2); for v in {* V.1,V.2 *} do v; end for;", "the order of a set of vectors is not supported yet"],
    ["V := VectorSpace(Rationals(),2); for v in {* V.2,V.1 *} do v; end for;", "the order of a set of vectors is not supported yet"],
    ["V := VectorSpace(Rationals(),2); Sprint({V.1,V.2});", "the order of a set of vectors is not supported yet"],
    ["V := VectorSpace(Rationals(),2); <{V.1,V.2}>;", "the order of a set of vectors is not supported yet"],
    ["V := VectorSpace(Rationals(),2); {* V.2, V.1 *};", "the order of a set of vectors is not supported yet"],
    // (Eltseq of a set of vectors, or of the space: Magma's error, astra CORR-5C2-1)
    ["V := VectorSpace(Rationals(),2); S := Eltseq({V|});", "Runtime error in 'Eltseq': Bad argument types Argument types given: SetEnum[ModTupFldElt[FldRat]]"],
    ["V := VectorSpace(Rationals(),2); S := Eltseq({@V|V.1@});", "Runtime error in 'Eltseq': Bad argument types Argument types given: SetIndx[ModTupFldElt[FldRat]]"],
    ["V := VectorSpace(Rationals(),2); S := Eltseq({*V|*});", "Runtime error in 'Eltseq': Bad argument types Argument types given: SetMulti[ModTupFldElt[FldRat]]"],
    ["W := RSpace(Integers(),2); S := Eltseq({W|});", "Runtime error in 'Eltseq': Bad argument types Argument types given: SetEnum[ModTupRngElt[RngInt]]"],
    ["V := VectorSpace(Rationals(),2); S := Eltseq(Generators(V));", "Runtime error in 'Eltseq': Bad argument types Argument types given: SetEnum[ModTupFldElt[FldRat]]"],
    ["S := Eltseq({Vector([1,2])});", "Runtime error in 'Eltseq': Bad argument types Argument types given: SetEnum[ModTupRngElt[RngInt]]"],
    ["V := VectorSpace(Rationals(),2); S := Eltseq(V);", "Runtime error in 'Eltseq': Bad argument types Argument types given: ModTupFld[FldRat]"]
  ];
  for (const [e, m] of errs) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end ") && !/Traceback|TypeError|AttributeError/.test(o), e + " => " + o);
  }
});

test("a collection over a vector space is admitted by its total entries before any vector is coerced or keyed (daybreak2 on 7e2a1348)", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  // (degree 10^4 and just enough items to pass the bound on entries: each
  // refusal comes before the first coercion or set key; one item fewer is
  // admitted, every item coerced)
  const f = join(mkdtempSync(join(tmpdir(), "magma-vspace-")), "check.py");
  writeFileSync(f, [
    "import _magma as m",
    "calls = [0]",
    "coerce, key = m._MVectorSpace._magma_coerce, m._key",
    "def spy_coerce(self, x):",
    "    calls[0] += 1",
    "    return coerce(self, x)",
    "def spy_key(x):",
    "    if isinstance(x, m._MVector):",
    "        calls[0] += 1",
    "    return key(x)",
    "m._MVectorSpace._magma_coerce = spy_coerce",
    "m._key = spy_key",
    "n = 10 ** 4",
    "V = m.VectorSpace(m._QQ, n)",
    "v = V._unit(0)",
    "k = m._COLLECT_MAX // n + 1",
    "def attempt(label, f):",
    "    calls[0] = 0",
    "    try:",
    "        f()",
    "        print(label, 'admitted', calls[0])",
    "    except m.MagmaError as e:",
    "        print(label, 'refused' if 'entries in all' in str(e) else str(e), calls[0])",
    "attempt('seq', lambda: m._into_universe([v] * k, V, 'seq'))",
    "attempt('set', lambda: m._into_universe([v] * k, V, 'set'))",
    "S = m.MSeq([v] * (k - 1), V)",
    "attempt('append', lambda: m._lift('Append', S, v))",
    "attempt('include', lambda: m._lift('Include', S, v))",
    "attempt('insert', lambda: m._lift('Insert', S, v))",
    "attempt('index', lambda: m._lift('Index', S, v))",
    "attempt('assign', lambda: m._assign_path(m.MSeq([v], V), [('idx', k, None)], v))",
    "attempt('fewer', lambda: m._into_universe([v] * (k - 1), V, 'seq'))",
    "print('k-1', k - 1)",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), f], { encoding: "utf8", timeout: WALL(60000) });
  const lines = r.stdout.trim().split("\n");
  const k1 = Number(lines.pop()!.split(" ")[1]);
  assert.deepEqual(lines, ["seq refused 0", "set refused 0", "append refused 0", "include refused 0", "insert refused 0", "index admitted 1", "assign refused 0", "fewer admitted " + k1], r.stdout + r.stderr);
});

test("IsIsomorphic as Magma's for quadratic fields and the symmetric and dihedral groups; its isomorphism refused", () => {
  const { spawnSync } = require("node:child_process");
  const { join } = require("node:path");
  // (the expected text is Magma 2.18's for the same lines; with false there is
  // no second value, as Magma's; with true Magma prints the isomorphism,
  // which Sagebrush refuses, so a true result is assigned before it is shown)
  const run = (src: string) => spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--magma"], { input: src + "\n\"end\";\n", encoding: "utf8" }).stdout as string;
  assert.equal(run("IsIsomorphic(QuadraticField(2), QuadraticField(3));\nb := IsIsomorphic(QuadraticField(5), QuadraticField(45)); b;\nb := IsIsomorphic(QuadraticField(-1), QuadraticField(-4)); b;\nP<x> := PolynomialRing(Rationals());\nb := IsIsomorphic(NumberField(x^2 - 5), QuadraticField(5)); b;\nb := IsIsomorphic(NumberField(x^2 + x + 1), QuadraticField(-3)); b;\nb := IsIsomorphic(NumberField(x^2 - 12), QuadraticField(3)); b;\nb := IsIsomorphic(NumberField(x^2 - 12), QuadraticField(2)); b;\nb := IsIsomorphic(CyclotomicField(4), QuadraticField(-1)); b;\nb := IsIsomorphic(CyclotomicField(3), QuadraticField(-3)); b;\nb := IsIsomorphic(CyclotomicField(6), CyclotomicField(3)); b;\nb := IsIsomorphic(CyclotomicField(3), CyclotomicField(4)); b;\nb := IsIsomorphic(NumberField(x^3 - 2), QuadraticField(2)); b;\nIsIsomorphic(CyclotomicField(5), QuadraticField(5));\nIsIsomorphic(Sym(4), Sym(5));\nIsIsomorphic(DihedralGroup(4), DihedralGroup(5));\nIsIsomorphic(Sym(4), DihedralGroup(12));\nIsIsomorphic(Sym(5), DihedralGroup(60));\nIsIsomorphic(Sym(3), DihedralGroup(4));\nb := IsIsomorphic(Sym(3), DihedralGroup(3)); b;\nb := IsIsomorphic(DihedralGroup(3), Sym(3)); b;\nb := IsIsomorphic(DihedralGroup(7), DihedralGroup(7)); b;\nb := IsIsomorphic(Sym(4), Sym(4)); b;\nb, f := IsIsomorphic(Sym(4), Sym(5)); b;\nb := IsIsomorphic(CyclotomicField(2), CyclotomicField(1)); b;\nIsIsomorphic(CyclotomicField(1), QuadraticField(2));"), "false\ntrue\ntrue\ntrue\ntrue\ntrue\nfalse\ntrue\ntrue\ntrue\nfalse\nfalse\nfalse\nfalse\nfalse\nfalse\nfalse\nfalse\ntrue\ntrue\ntrue\ntrue\nfalse\ntrue\nfalse\nend\n");
  const errs: [string, string][] = [
    ["x := IsIsomorphic(QuadraticField(2), Sym(3));", "Runtime error in 'IsIsomorphic': Bad argument types Argument types given: FldQuad[FldRat], GrpPerm"],
    ["x := IsIsomorphic(Rationals(), QuadraticField(2));", "Runtime error in 'IsIsomorphic': Bad argument types Argument types given: FldRat, FldQuad[FldRat]"],
    ["x := IsIsomorphic(Rationals(), Rationals());", "Runtime error in 'IsIsomorphic': Bad argument types Argument types given: FldRat, FldRat"],
    ["x := IsIsomorphic(Integers(), Integers());", "Runtime error in 'IsIsomorphic': Bad argument types Argument types given: RngInt, RngInt"],
    ["x := IsIsomorphic(2, 3);", "Runtime error in 'IsIsomorphic': Bad argument types Argument types given: RngIntElt, RngIntElt"],
    ["x := IsIsomorphic(GF(4), GF(4));", "Runtime error in 'IsIsomorphic': Bad argument types Argument types given: FldFin, FldFin"],
    ["b, f := IsIsomorphic(QuadraticField(2), QuadraticField(3)); b; f;", "User error: Identifier 'f' has not been declared or assigned"],
    ["IsIsomorphic(Sym(3), DihedralGroup(3));", "the isomorphism IsIsomorphic returns (its second value, and printing a true result) is not supported yet"],
    ["b, f := IsIsomorphic(Sym(3), Sym(3));", "the isomorphism IsIsomorphic returns (its second value, and printing a true result) is not supported yet"],
    ["IsIsomorphic(QuadraticField(5), QuadraticField(20));", "the isomorphism IsIsomorphic returns (its second value, and printing a true result) is not supported yet"],
    ["P<x> := PolynomialRing(Rationals()); y := IsIsomorphic(NumberField(x^3-2), NumberField(x^3-2));", "IsIsomorphic of number fields of degree more than 2 is not supported yet"],
    ["y := IsIsomorphic(VectorSpace(Rationals(),2), VectorSpace(Rationals(),2));", "IsIsomorphic of a ModTupFld and a ModTupFld is not supported yet"],
    // (Magma lowers a linear NumberField to the rationals: refused in both orders, astra CORR-530-1)
    ["P<x> := PolynomialRing(Rationals()); y := IsIsomorphic(NumberField(x-1), QuadraticField(2));", "IsIsomorphic of a number field of degree 1 (Magma's rational field) is not supported yet"],
    ["P<x> := PolynomialRing(Rationals()); y := IsIsomorphic(QuadraticField(2), NumberField(x-1));", "IsIsomorphic of a number field of degree 1 (Magma's rational field) is not supported yet"],
    ["P<x> := PolynomialRing(Rationals()); y := IsIsomorphic(NumberField(x-1), NumberField(x-1));", "IsIsomorphic of a number field of degree 1 (Magma's rational field) is not supported yet"],
    ["P<x> := PolynomialRing(Rationals()); y := IsIsomorphic(NumberField(x-1), Sym(3));", "IsIsomorphic of a number field of degree 1 (Magma's rational field) is not supported yet"]
  ];
  for (const [e, m] of errs) {
    const o = run(e).replace(/\s+/g, " ");
    assert.ok(o.includes(m) && o.endsWith("end ") && !/Traceback|TypeError|AttributeError/.test(o), e + " => " + o);
  }
});
