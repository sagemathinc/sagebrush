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
  // (block comments nest, as the lexer reads them: := in the outer one after an inner %} is still a comment)
  assert.equal(looksLikeMagma("%{\nouter\n%{\ninner\n%}\n:= only in the outer comment\n%}\nx=1;"), false);
  assert.equal(looksLikeMagma("%{\n%{\n%}\n%}\nx := 1;"), true);
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

test("notebook session: MATLAB cells share variables and functions; an error fails its cell only", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = ["x = 3;\ny = x * 2", "z = y + undefined_thing", "function r = f(a)\n  r = a + 1;\nend", "f(y)",
    "format long\npi", "pi", "x = [1 2", "plot(1:3)", "disp(z)"];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  const out = (id: number, stream: string) => msgs.filter((m) => m.id === id && m.stream === stream).map((m) => m.text).join("");
  const failed = (id: number) => !!msgs.find((m) => m.id === id && m.done)?.error;
  assert.equal(out(1, "stdout"), "\ny =\n\n     6\n\n");
  assert.equal(out(2, "stderr"), "Unrecognized function or variable 'undefined_thing'.\n");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(failed), [false, true, false, false, false, false, true, false, true]);
  assert.equal(out(4, "stdout"), "\nans =\n\n     7\n\n");
  // (format long stays for the next cell, as in a MATLAB session)
  assert.equal(out(6, "stdout"), "\nans =\n\n   3.141592653589793\n\n");
  assert.match(out(7, "stderr"), /^line 1\nunexpected end of input\n/);
  assert.ok(msgs.some((m) => m.id === 8 && m.display && m.display["image/svg+xml"]));
  // (z was never assigned: cell 2 failed)
  assert.match(out(9, "stderr"), /Unrecognized function or variable 'z'/);
});

test("reactive notebook: a MATLAB cell's definitions and references (src/dataflow.ts); no renaming", () => {
  const { analyzeCell } = require("../src/dataflow");
  const { renameInCell, forwardRefers } = require("../src/rename");
  const names = (src: string) => {
    const a = analyzeCell(src, "c", { mode: "matlab" });
    return [[...a.defs].sort(), [...a.refs].sort()];
  };
  assert.deepEqual(names("x = 3;\ny = x * 2"), [["x", "y"], []]);
  assert.deepEqual(names("z = y + w;\nplot(z)"), [["z"], ["plot", "w", "y"]]);
  // (a function's body sees its own workspace only: q is not the notebook's)
  assert.deepEqual(names("function r = f(a)\n  r = a + q;\nend"), [["f"], []]);
  // (ans is every bare expression's: no cell's to share)
  assert.deepEqual(names("f(y)\n3 + 4\nans"), [[], ["f", "y"]]);
  assert.deepEqual(names("for k = 1:n\n  s = s + k;\nend"), [["k", "s"], ["n", "s"]]);
  assert.throws(() => analyzeCell("x = [1 2", "c", { mode: "matlab" }), MatlabSyntaxError);
  assert.equal(renameInCell("x = 1", "x", "x_2", { mode: "matlab" }), null);
  assert.equal(forwardRefers("x = 1", "x", "matlab"), false);
});

test("MATLAB consoles wait for the end of an open block (is_complete, the session's check)", async () => {
  const { matlabIsIncomplete } = require("../src/matlab");
  for (const t of ["if true", "for k = 1:3\n  disp(k)", "x = [1 2", "x = 1 + ...", "%{\na note", "while x < 3\n  if x",
    "x = 1 ...", "disp(1) ... % continue", "x = 1 ...\n"]) assert.equal(matlabIsIncomplete(t), true, t);
  for (const t of ["x = 1", "if true\n  x = 1;\nend", "x = 1 +* 2", "x = )", "%{\n%}\nx = 1", "x = 1 ...\n+ 2"]) assert.equal(matlabIsIncomplete(t), false, t);
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  await s.handle({ id: 1, check: "if true", matlab: true });
  await s.handle({ id: 2, check: "if true\n  x = 1;\nend", matlab: true });
  await s.handle({ id: 3, check: "x = 1 ...", matlab: true });
  await s.handle({ id: 4, check: "disp(1) ... % continue", matlab: true });
  assert.deepEqual([1, 2, 3, 4].map((id) => msgs.find((m) => m.id === id).more), [true, false, true, true]);
});

test("a .m file whose outer block comment holds := runs as MATLAB (the CLI's guess)", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const f = join(mkdtempSync(join(tmpdir(), "sb-mfile-")), "nested.m");
  writeFileSync(f, "%{\nouter\n%{\ninner\n%}\n:= only in the outer comment\n%}\nx = 6 * 7\n");
  assert.equal(execFileSync(process.execPath, [__dirname + "/../src/cli.js", f], { encoding: "utf8" }), "\nx =\n\n    42\n\n");
});

test("sparse single matrices stay single when a result is empty; whos marks sparse and complex", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sparse-"));
  writeFileSync(join(dir, "s.m"), [
    "S = sparse(single(zeros(2, 3))); T = sparse(single([0 2; 0 0]));",
    "c = {class(S), class(S.'), class(T), class(T(1,1)), class(T(1,:)), class(T([], :)), class(repmat(S, 2, 2)), class(T(:, []))};",
    "fprintf('%s ', c{:}); fprintf('\\n');",
    "C = sparse([1 2], [1 2], [1i 2]); B = sparse(1e6, 1e6);",
    "whos B C",
  ].join("\n"));
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "s.m")], { encoding: "utf8" });
  const lines = out.split("\n");
  assert.equal(lines[0], "single single single single single single single single ");
  assert.match(out, /\n  B +1000000x1000000 +8000024  double +sparse\n/);
  assert.match(out, /\n  C +2x2 +72  double +sparse, complex\n/);
});

test("sparse matrices in .mat files: logical ones saved and loaded, and read as Octave writes them", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sparse-mat-"));
  writeFileSync(join(dir, "s.m"), [
    "L = sparse([1 0 1; 0 0 1]) > 0; A = spalloc(4, 4, 6); A(2, 3) = 7;",
    "f = [tempname '.mat']; save(f, 'L', 'A'); clear L A; load(f);",
    "fprintf('%d %d %d %d %d %d\\n', issparse(L), islogical(L), issparse(A), nzmax(A), nnz(A), full(A(2, 3)));",
    "disp(mat2str(full(L)));",
    `load('${join(__dirname, "..", "..", "matlab-tests", "data", "octave_sparse_logical.mat")}');`,
    "fprintf('%d %d\\n', issparse(spl), islogical(spl)); disp(mat2str(full(spl)));",
    `S = load('${join(__dirname, "..", "..", "matlab-tests", "data", "octave_sparse_nzmax.mat")}');`,
    "fprintf('%d %d %d\\n', nzmax(S.A), nnz(S.A), full(S.A(2, 3)));",
  ].join("\n"));
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "s.m")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), ["1 1 1 6 1 7", "[true false true;false false true]", "1 1", "[true false true;false false true]", "6 1 7"]);
});

test(".mat files are untrusted: decompression is bounded, sparse metadata is checked before use", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const zlib = require("node:zlib");
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  const header = Buffer.alloc(128, 32);
  header.write("MATLAB 5.0 MAT-file", 0);
  header.writeUInt16LE(0x0100, 124);
  header.write("IM", 126);
  const el = (t: number, p: Buffer) => {
    const pad = (8 - (p.length % 8)) % 8;
    const b = Buffer.alloc(8 + p.length + pad);
    b.writeUInt32LE(t, 0);
    b.writeUInt32LE(p.length, 4);
    p.copy(b, 8);
    return b;
  };
  const ints = (a: number[]) => { const b = Buffer.alloc(4 * a.length); a.forEach((v, k) => b.writeInt32LE(v, 4 * k)); return b; };
  const dbls = (a: number[]) => { const b = Buffer.alloc(8 * a.length); a.forEach((v, k) => b.writeDoubleLE(v, 8 * k)); return b; };
  const sngs = (a: number[]) => { const b = Buffer.alloc(4 * a.length); a.forEach((v, k) => b.writeFloatLE(v, 4 * k)); return b; };
  const flags = (cls: number, nzmax: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(cls, 0); b.writeUInt32LE(nzmax >>> 0, 4); return b; };
  const sparse = (m: number, n: number, ir: number[], jc: number[], pr: Buffer, prType = 9, nzmax = ir.length) =>
    el(14, Buffer.concat([el(6, flags(5, nzmax)), el(5, ints([m, n])), el(1, Buffer.from("S")), el(5, ints(ir)), el(5, ints(jc)), el(prType, pr)]));
  const file = (name: string, ...els: Buffer[]) => { writeFileSync(join(dir, name), Buffer.concat([header, ...els])); return name; };
  const compressed = (b: Buffer) => el(15, zlib.deflateSync(b)).subarray(0, 8 + zlib.deflateSync(b).length);
  const ok = sparse(2, 2, [0, 1], [0, 1, 2], dbls([1, 2]));
  const files = [
    file("bomb.mat", compressed(Buffer.alloc(2 * 1048576))),
    file("junk.mat", compressed(Buffer.alloc(65536))),
    file("trailing.mat", el(15, Buffer.concat([zlib.deflateSync(ok), Buffer.from("junk")]))),
    file("row.mat", sparse(1, 1, [5000000], [0, 1], dbls([1]))),
    file("jc.mat", sparse(1, 1, [0], [0], dbls([1]))),
    file("nz.mat", sparse(3, 1, [0], [0, 3], dbls([1, 2, 3]))),
    file("order.mat", sparse(3, 1, [2, 0], [0, 2], dbls([1, 2]))),
    file("nzmax.mat", sparse(2, 2, [0, 1], [0, 1, 2], dbls([1, 2]), 9, 0xffffffff)),
    file("short.mat", ok.subarray(0, ok.length - 12)),
    file("single.mat", sparse(2, 2, [0, 1], [0, 1, 2], sngs([1.25, 2]), 7)),
    file("fine.mat", compressed(ok)),
  ];
  const lines = files.map((f) => `try, S = load('${join(dir, f)}'); x = S.S; fprintf('${f}: %s %d %d %g\\n', class(x), issparse(x), nzmax(x), full(sum(x(:)))); save('${join(dir, "out.mat")}', 'x'); catch e, fprintf('${f}: %s\\n', e.message); end`);
  writeFileSync(join(dir, "t.m"), lines.join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")],
    { encoding: "utf8", timeout: 120000, env: { ...process.env, SAGEBRUSH_MAT_MAX_INFLATED: String(1048576) } });
  const msg = (f: string) => out.split("\n").find((l: string) => l.startsWith(f + ":"))!.replace(/Unable to read MAT-file \S+: /, "");
  assert.equal(msg("bomb.mat"), "bomb.mat: the file's compressed data expands to more than 1048576 bytes.");
  assert.equal(msg("junk.mat"), "junk.mat: a compressed variable holds more than one data element.");
  assert.equal(msg("trailing.mat"), "trailing.mat: unexpected data after a compressed variable.");
  assert.equal(msg("row.mat"), "row.mat: a malformed sparse matrix: a row index out of range.");
  assert.equal(msg("jc.mat"), "jc.mat: a malformed sparse matrix: its column starts.");
  assert.equal(msg("nz.mat"), "nz.mat: a malformed sparse matrix: more nonzeros than row indices.");
  assert.equal(msg("order.mat"), "order.mat: a malformed sparse matrix: row indices out of order.");
  assert.equal(msg("nzmax.mat"), "nzmax.mat: double 1 2 3");
  assert.equal(msg("short.mat"), "short.mat: a data element runs past the end of the file.");
  assert.equal(msg("single.mat"), "single.mat: single 1 2 3.25");
  assert.equal(msg("fine.mat"), "fine.mat: double 1 2 3");
});

test("sparse: single kept by spdiags and cast-like; 'like', cast, normest, condest and large solves never expand; sprandsym's density", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sparse-"));
  writeFileSync(join(dir, "s.m"), [
    "A = sparse(single([1 0; 0 2])); [B, d] = spdiags(A); fprintf('%s %s\\n', class(A), class(B));",
    "x = sparse(single([1 0 2])); y = cast(x, 'like', sparse(single(1i))); fprintf('%s %d %d\\n', class(y), issparse(y), ~isreal(y));",
    "y = cast(sparse([1 0 2]), 'like', single(1)); fprintf('%s %d\\n', class(y), issparse(y));",
    "S = sparse(1e5, 1e5); Z = zeros(2, 2, 'like', S); O = ones(1, 3, 'like', sparse(1i));",
    "fprintf('%s %d %d %d | %d %d\\n', class(Z), issparse(Z), size(Z), issparse(O), ~isreal(O));",
    "C = cast(S, 'like', sparse(1)); fprintf('%d %d\\n', issparse(C), nnz(C));",
    "E = speye(1e5); fprintf('%g %g\\n', normest(E), condest(E));",
    "[n, c] = normest(sparse(3, 3)); fprintf('%g %g\\n', n, c);",
    "rng(1); R = sprandsym(1000, 0.2); fprintf('%d %.3f\\n', isequal(R, R'), nnz(R) / 1e6);",
    "rng(1); R = sprandsym(200, 1); fprintf('%d %d\\n', isequal(R, R'), nnz(R));",
    "n = 20000; A = speye(n); A(1, n) = -0.5; A(n, 2) = -0.5; fprintf('%g\\n', condest(A));",
    "b = (1:n)'; x = A \\ b; y = A' \\ b; fprintf('%.3g %.3g\\n', max(abs(A * x - b)), max(abs(A' * y - b)));",
  ].join("\n"));
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "s.m")], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), ["single single", "single 1 1", "single 0", "double 1 2 2 | 1 1", "1 0", "1 1", "0 0", "1 0.200", "1 40000", "2.625", "0 0"]);
});

test("what is not implemented is refused, never answered approximately: linsolve options, funm of a defective matrix, interp2's grids and methods", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "refuse-"));
  const cases = [
    "linsolve([1 2; 3 4], [1; 2], struct('FOO', true))",
    "linsolve([1 2; 3 4], [1; 2], struct('SYM', true))",
    "linsolve([1 2; 3 4], [1; 2], struct('LT', true, 'UT', true))",
    "funm([1 1; 0 1], @(x) x.^2)",
    "interp2([1 2 4 5], 1:4, magic(4), 2, 2, 'cubic')",
    "interp2(1e12 + [0 1 3 4], 1:4, magic(4), 1e12 + 2, 2.5, 'cubic')",
    "funm([1 1; 0 1], @exp)",
    "interp2([1 3 2], 1:3, magic(3), 2, 2)",
    "interp2(magic(3), 2, 2, 'makima')",
    "median([1 2], 'foo')", "sum([1 2], 'foo')", "mode([1 2], 'omitnan')", "any([1 0], 'omitnan')", "max([1 2], [], 'foo')",
    "diff([1 2 4], 1, 'foo')", "sort([1 2], 'foo')", "sort([3 NaN 1], 'MissingPlacement', 'first')",
    "histcounts([1 2 3], 'foo')", "histcounts([1 2 3], 'BinMethod', 'nosuchmethod')",
  ];
  // (funm's @exp is the local exp below, not the built-in)
  writeFileSync(join(dir, "t.m"), cases.map((c) => `try, ${c}; disp('answered'); catch e, disp('refused'); end`).join("\n") + "\n" + [
    "V = magic(4); a = interp2(0:3, 1:4, V, 1.3, 2.5, 'cubic'); b = interp2(1e12 + (0:3), 1:4, V, 1e12 + 1.3, 2.5, 'cubic');",
    "fprintf('%d %d\\n', abs(a - b) < 1e-3, isequal(funm([1 0; 0 2], @exp), [1 0; 0 4]));",
    "function y = exp(x)", "  y = x.^2;", "end",
  ].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), [...cases.map(() => "refused"), "1 1"]);
});

test("format's two-word forms (format long g) are its one-word ones; an unknown option is an error", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "format-"));
  writeFileSync(join(dir, "t.m"), [
    "format longG", "disp(pi)", "format long g", "disp(pi)", "format short e", "disp(pi)", "format shortE", "disp(pi)", "format",
    "try, format foo, catch e, disp(e.message), end", "try, format longEng, catch e, disp('refused'), end",
  ].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")], { encoding: "utf8" });
  const lines = out.split("\n");
  assert.equal(lines[0], lines[1]);
  assert.equal(lines[2], lines[3]);
  assert.notEqual(lines[0], lines[2]);
  assert.deepEqual(lines.slice(4, 6), ["Invalid format option 'foo'.", "refused"]);
});

test("data functions where Octave differs from MATLAB: prctile down a column vector, mov* with a numeric Endpoints fill, sprand's places, corrcoef's range and conjugate", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "data-"));
  writeFileSync(join(dir, "t.m"), [
    "disp(mat2str(prctile([3 1 4 1 5 9 2 6]', [10 90])))",
    "disp(mat2str(prctile(7, [10 50 90])))",
    "disp(mat2str(movmax([4 8 6 -1 -2 -3 -1 3 4 5], 4, 'Endpoints', 0)))",
    "rng default; a = nnz(sprand(500, 1000, 0.1)); rng default; b = nnz(sprandn(500, 1000, 0.1)); fprintf('%d %d\\n', a, b);",
    "x = [1 2 3 4]'; R = corrcoef(x, 2*x); fprintf('%.17g %.17g\\n', R(1, 2), R(2, 1));",
    "R = corrcoef([1+1i 2 3-1i; 2 1i 1; 0 1 2]); fprintf('%.4f %.4f\\n', real(R(1, 3)), imag(R(1, 3)));",
    "disp(mat2str([corrcoef(5) corrcoef(1, 2) corrcoef(1, 1)])); disp(mat2str(corrcoef([5 5 5])));",
  ].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")], { encoding: "utf8" });
  // (corrcoef: the documented range, |r| <= 1, where Octave gives 1.0000000000000002; and the
  // documented conj(A - mean A) .* (B - mean B), where Octave's entry is the conjugate; and its
  // documented one-observation cases: corrcoef(5) NaN, corrcoef(1, 2) 1, corrcoef(1, 1) NaN)
  assert.deepEqual(out.trim().split("\n"), ["[1;8.1]", "[7;7;7]", "[0 0 8 8 6 -1 3 4 5 0]", "47663 47663", "1 1", "-0.6250 -0.3750", "[NaN 1 NaN]", "1"]);
});

test("normest, from its documentation and the power method on S'S: the published examples' estimates, complex matrices, a matrix that annihilates the start", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "normest-"));
  writeFileSync(join(dir, "t.m"), [
    "d = sqrt((1:6).*(6:-1:1)); S = diag(d,1) + diag(d,-1); fprintf('%.4f\\n', normest(S));",
    "fprintf('%.4f\\n', normest(sparse(1:5,1:5,1:5))); rng default; S = rand(1000); fprintf('%.4f\\n', normest(S, 1e-4));",
    "fprintf('%.6f %.4f %.4f\\n', normest([1 2i; 3 4]), normest(sparse([1 -1; 1 -1])), normest(zeros(3)));",
  ].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), ["6.0000", "5.0000", "500.4856", "5.305935 2.0000 0.0000"]);
});

test("histcounts' automatic edges follow Sagebrush's own stated rules (Scott's width to Heckbert's nice numbers; a given count; BinLimits, BinWidth and the documented BinMethods)", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  writeFileSync(join(dir, "t.m"), [
    "rng default; [N, e] = histcounts(randn(100,1)); disp(mat2str(N)); disp(mat2str(e));",
    "[N, e] = histcounts([2 3 5 7 11 13 17 19 23 29], 6); disp(mat2str(N)); disp(mat2str(e, 4));",
    "[N, e] = histcounts(primes(100)); disp(mat2str(N)); disp(mat2str(e));",
    "[N, e] = histcounts([5 5 5]); disp(mat2str(N)); disp(mat2str(e));",
    "[N, e] = histcounts([5 5 5], 4); disp(mat2str(N)); disp(mat2str(e));",
    "[N, e] = histcounts(primes(100), 'BinLimits', [0 30]); disp(mat2str(N)); disp(mat2str(e));",
    "[N, e] = histcounts(primes(100), 'BinWidth', 7); disp(mat2str(e));",
    "[~, e] = histcounts(primes(100), 'BinMethod', 'sturges'); disp(mat2str(e));",
    "[~, e] = histcounts(primes(100), 'BinMethod', 'sqrt'); disp(mat2str(e));",
    "[~, e] = histcounts(primes(100), 'BinMethod', 'fd'); disp(mat2str(e));",
    "[~, e] = histcounts([-3 1 2 7], 'BinMethod', 'integers'); disp(mat2str(e));"
  ].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), [
    "[2 17 28 32 16 3 2]",
    "[-3 -2 -1 0 1 2 3 4]",
    "[3 1 2 2 1 1]",
    "[2 6.5 11 15.5 20 24.5 29]",
    "[15 10]",
    "[0 50 100]",
    "3",
    "[4.5 5.5]",
    "[0 0 3 0]",
    "[4.5 4.75 5 5.25 5.5]",
    "[4 4 2]",
    "[0 10 20 30]",
    "[0 7 14 21 28 35 42 49 56 63 70 77 84 91 98]",
    "[0 20 40 60 80 100]",
    "[0 20 40 60 80 100]",
    "[0 50 100]",
    "[-3.5 -2.5 -1.5 -0.5 0.5 1.5 2.5 3.5 4.5 5.5 6.5 7.5]"
  ]);
});
