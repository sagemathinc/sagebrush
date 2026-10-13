import test from "node:test";
import assert from "node:assert/strict";
import { matlabToPython, MatlabSyntaxError, looksLikeMagma, lex, unparse } from "../src/matlab";

// the translation, without the line that records the source text
const py = (src: string) => matlabToPython(src).split("\n").filter((l) => !l.includes("_m.begin(")).join("\n");

test(".m files: Magma assigns with :=, MATLAB never does", () => {
  assert.equal(looksLikeMagma("x := 5;\nprint x;"), true);
  assert.equal(looksLikeMagma("R<x> := PolynomialRing(Rationals());\nFactorization(x^2-1);"), true);
  assert.equal(looksLikeMagma("x = 5;\ndisp(x)"), false);
  assert.equal(looksLikeMagma("function y = f(x)\n  y = x';\nend"), false);
  // := only in a MATLAB comment or string: MATLAB
  assert.equal(looksLikeMagma("% in Magma one writes x := 5\nx = 5;"), false);
  assert.equal(looksLikeMagma("s = 'x := 5';\ndisp(s)"), false);
  assert.equal(looksLikeMagma('s = "a := b";'), false);
  assert.equal(looksLikeMagma("%{\nx := 1\n%}\ny = 2;"), false);
  // a transpose is not the start of a string
  assert.equal(looksLikeMagma("y = x'; z = y';"), false);
  // := only in a Magma comment or string: still Magma if the code has one
  assert.equal(looksLikeMagma('// x = 5\nx := 5;'), true);
  assert.equal(looksLikeMagma('print "no := here";\nx := 1;'), true);
});

test("a quote is a transpose after a value, else a character vector", () => {
  const kinds = (s: string) => lex(s).filter((t) => t.t !== "eof" && t.t !== "nl").map((t) => (t.t === "str" ? `str:${t.v}` : t.v));
  assert.deepEqual(kinds("a'"), ["a", "'"]);
  assert.deepEqual(kinds("a''"), ["a", "'", "'"]);
  assert.deepEqual(kinds("x = 'it''s'"), ["x", "=", "str:it's"]);
  assert.deepEqual(kinds("[a' b']"), ["[", "a", "'", "b", "'", "]"]);
  assert.deepEqual(kinds("[a 'b']"), ["[", "a", "str:b", "]"]);
  assert.deepEqual(kinds("x(1)'"), ["x", "(", "1", ")", "'"]);
  assert.deepEqual(kinds("x.'"), ["x", ".'"]);
  assert.deepEqual(kinds("1./x"), ["1", "./", "x"]);
  assert.deepEqual(kinds("1.5e3i"), ["1.5e3i"]);
});

test("in brackets, whitespace separates elements", () => {
  const elems = (s: string) => {
    const code = py(`v = ${s};`);
    const m = /v = _m\.hcat\(\[(.*)\]\)/.exec(code);
    return m ? m[1] : code;
  };
  assert.equal(elems("[1 -2]"), "1.0, (-2.0)");
  assert.equal(elems("[1 - 2]"), "_m.minus(1.0, 2.0)");
  assert.equal(elems("[1 -2 + 3]"), "1.0, _m.plus((-2.0), 3.0)");
  assert.equal(elems("[a' b']").match(/_m\.ctranspose\(/g)?.length, 2);
  assert.match(elems("[f (1)]"), /^_m\.val\(.*\), 1\.0$/);
  assert.match(elems("[f(1)]"), /^_m\.paren\(/);
});

test("command syntax: format long, hold on", () => {
  assert.match(py("format long"), /_m\.Char\("long"\)/);
  assert.match(py("disp hello"), /_m\.Char\("hello"\)/);
  // not commands: assignments, operators, calls
  assert.doesNotMatch(py("x = 1"), /Char/);
  assert.doesNotMatch(py("x(2)"), /Char/);
  assert.doesNotMatch(py("x - 1"), /Char/);
});

test("end in an index is the size along that subscript", () => {
  assert.match(py("A = 1; A(end, 2)"), /_m\.end\(A, 0, 2\)/);
  assert.match(py("A = 1; A(2, end)"), /_m\.end\(A, 1, 2\)/);
  assert.match(py("A = 1; A(end)"), /_m\.end\(A, 0, 1\)/);
  assert.match(py("A = 1; A([1 end])"), /_m\.end\(A, 0, 1\)/);
});

test("precedence: ^ before unary minus, left-associative ^, ranges below +", () => {
  assert.match(py("x = -2 ^ 2;"), /x = _m\.uminus\(_m\.mpower\(2\.0, 2\.0\)\)|x = \(-_m\.mpower/);
  assert.match(py("x = 2 ^ 3 ^ 2;"), /_m\.mpower\(_m\.mpower\(2\.0, 3\.0\), 2\.0\)/);
  assert.match(py("x = 1:n+1;"), /_m\.colon\(1\.0, _m\.plus\(/);
  assert.match(py("x = 2 ^ -1;"), /_m\.mpower\(2\.0, \(-1\.0\)\)/);
});

test("statements end at a newline, ';' or ','", () => {
  assert.match(py("x = 1, y = 2;"), /_m\.display\("x", x\)/);
  assert.doesNotMatch(py("y = 2;"), /display/);
  assert.match(py("if true, x = 1, end"), /if _m\.cond\(/);
  assert.throws(() => matlabToPython("x = = 1"), MatlabSyntaxError);
  assert.throws(() => matlabToPython("for k = 1:3\n  x = k;"), MatlabSyntaxError);
});

test("function handles print as MATLAB writes them back", () => {
  const anon = (s: string) => {
    const m = /_m\.Anon\(lambda [^:]*: .*, ("[^"]*"), \d+\)/.exec(py(`f = ${s};`));
    return m ? JSON.parse(m[1]) : null;
  };
  assert.equal(anon("@(x) x.^2 + 1"), "@(x)x.^2+1");
  assert.equal(anon("@(x, y) (x + y) * 2"), "@(x,y)(x+y)*2");
  assert.equal(anon("@() disp('hi')"), "@()disp('hi')");
  assert.equal(unparse({ k: "bin", op: "-", l: { k: "num", v: "1" }, r: { k: "bin", op: "-", l: { k: "num", v: "2" }, r: { k: "num", v: "3" } } }), "1-(2-3)");
});

test("the translation is Python only: program text appears only in string literals", () => {
  const code = py("s = 'a\"); import os; (\"';\ndisp(s)");
  assert.match(code, /_m\.Char\("a\\"\); import os; \(\\""\)/);
  // Python keywords as MATLAB names
  assert.match(py("lambda = 3;\nclass = 2;"), /_k_lambda = 3\.0/);
});

test("the CLI runs a .m file as Magma or as MATLAB, as looksLikeMagma says; --magma and --matlab decide", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sb-mfile-"));
  const cli = join(__dirname, "..", "src", "cli.js");
  const run = (name: string, src: string, ...flags: string[]) => {
    const f = join(dir, name);
    writeFileSync(f, src);
    return spawnSync(process.execPath, [cli, ...flags, f], { encoding: "utf8" }).stdout;
  };
  // Magma: x := 2; x^10; prints 1024
  assert.equal(run("a.m", "x := 2;\nx^10;\n"), "1024\n");
  // MATLAB, with := only in a comment and in a string
  assert.equal(run("b.m", "% Magma would say x := 2\nx = 2;\ns = 'x := 2';\nfprintf('%d %s\\n', x^10, s);\n"), "1024 x := 2\n");
  // the flags override the guess
  assert.equal(run("c.m", "fprintf('%d\\n', 6 * 7);\n", "--matlab"), "42\n");
  assert.equal(run("d.mag", "print 6 * 7;\n"), "42\n");
});

test("name=value arguments are \"name\", value", () => {
  assert.match(py("plot(x, y, LineWidth=2)"), /_m\.Str\("LineWidth"\), 2\.0/);
  // (an assignment inside parentheses is never name=value: x(1) = 2 is assignment)
  assert.doesNotMatch(py("x = 1; x(1) = 2;"), /_m\.Str/);
});

test("arguments blocks: defaults, conversions, validators, name-value options", () => {
  const code = py(`function r = f(a, b, opts)
  arguments
    a double
    b (1,:) {mustBeNumeric} = [1 2]
    opts.Scale (1,1) double {mustBePositive} = 1
  end
  r = a;
end`);
  assert.match(code, /_m\.split_nv\(_a, 2, \["Scale"\]\)/);
  assert.match(code, /if isinstance\(b, _m\.Undef\): b = _m\.hcat\(\[1\.0, 2\.0\]\)/);
  assert.match(code, /_m\.arg_check\(a, None, "double", 1\)/);
  assert.match(code, /_m\.arg_check\(b, \[1, None\], None, 2\)/);
  assert.match(code, /_m\.validate\(lambda: _m\.call\(_m\.fn\("mustBePositive"\), \[_t\], 0\), "Scale"\)/);
  // (no command syntax inside the block: `a double` is a declaration)
  assert.doesNotMatch(code, /_m\.Char\("double"\)/);
});

test("hex and binary literals are integers (0x87u32, 0b101)", () => {
  assert.match(py("x = 0x87u32;"), /_m\.intlit\("87", 16, "uint32"\)/);
  assert.match(py("x = 0b101;"), /_m\.intlit\("101", 2, ""\)/);
  assert.match(py("x = 0xFFs8;"), /_m\.intlit\("FF", 16, "int8"\)/);
});
