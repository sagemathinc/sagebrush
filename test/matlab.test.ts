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

test("3-D figures: the interactive view's scene (MATLAB's axes, colors and view) with the SVG; other figures the SVG alone", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = [
    "[X,Y] = meshgrid(-3:3);\nsurf(X,Y,peaks(X,Y))\ntitle(\"Original Sampling\")",
    "mesh(peaks(5))",
    "t = 0:0.5:5; plot3(sin(t), cos(t), t, 'r-o'); xlabel('x'); view(30, 20)",
    "subplot(1,2,1); surf(peaks(5)); subplot(1,2,2); plot(1:3)",
    "surf(peaks(5)); legend('p')",
    "surf(peaks(300))",
    "plot(1:3); set(gcf, 'Color', [0.94 0.94 0.94])",
    "plot(1:2); title(\"currentColor label\")",
    // (250,000 vertices given, 4.5 million drawn as the viewer's tubes)
    "t = linspace(0, 1, 125001); plot3(t, t, t, 'LineWidth', 2)",
    "plot3([0 1], [0 1], [0 1]); view([1 1 1]); [caz, cel] = view; fprintf('%.4f %.4f\\n', caz, cel); [caz, cel] = view([-5 -2 5]); fprintf('%.4f %.4f\\n', caz, cel); view(gca, 2); [caz, cel] = view(gca); fprintf('%g %g\\n', caz, cel); try, v = view; catch e, disp(e.message), end; try, view, catch e, disp(e.message), end",
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  const shown = (id: number) => msgs.find((m) => m.id === id && m.display)?.display;
  const scene = (id: number) => {
    const t = shown(id)?.["application/vnd.sagebrush.scene3d+json"];
    return t ? JSON.parse(t) : null;
  };
  const a = scene(1);
  assert.ok(a && shown(1)["image/svg+xml"], "surf: a scene and its SVG");
  assert.deepEqual([a.lo, a.hi, a.azimuth, a.elevation, a.projection, a.background, a.title], [[-3, -3, -5], [3, 3, 10], -127.5, 30, "orthographic", "#ffffff", "Original Sampling"]);
  assert.deepEqual(a.box.ticks[2], [-5, 0, 5, 10]);
  const mesh = a.objects.find((o: any) => o.type === "mesh");
  // (36 faces, flat colors: 4 vertices each, unlit, under black edges)
  assert.deepEqual([mesh.pos.length / 3, mesh.lit, mesh.offset], [144, false, true]);
  assert.deepEqual(a.objects.filter((o: any) => o.type === "lines").map((o: any) => [o.color, o.pos.length / 6]), [["#000000", 84]]);
  // (mesh: white faces under edges colored by the colormap)
  const b = scene(2);
  assert.equal(new Set(b.objects.find((o: any) => o.type === "mesh").colors).size, 1);
  assert.ok(b.objects.filter((o: any) => o.type === "lines").length > 1);
  const c = scene(3);
  assert.deepEqual([c.azimuth, c.elevation, c.labels[0]], [-60, 20, "x"]);
  assert.deepEqual(c.objects.map((o: any) => [o.type, o.color, o.pos.length / 3]), [["lines", "#ff0000", 20], ["points", "#ff0000", 11]]);
  // (view(v): [x y z] toward the camera, as the documented example's angles; [caz, cel] = view(...); view(ax, 2);
  // one output, not the documented [caz, cel], refused)
  assert.equal(msgs.filter((m) => m.id === 10 && m.stream).map((m) => m.text).join(""), "135.0000 35.2644\n-68.1986 42.8760\n0 90\n" + "view: one output is not supported; use [caz, cel] = view.\n".repeat(2));
  for (const id of [4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(shown(id)["image/svg+xml"] && !scene(id), "cell " + id + ": the SVG only");
  }
  // (the figure's Color behind the SVG; MATLAB's dark gray, not the page's color)
  assert.match(shown(1)["image/svg+xml"], /^<svg[^>]*><rect width="100%" height="100%" fill="#ffffff"\/>/);
  assert.match(shown(7)["image/svg+xml"], /<rect width="100%" height="100%" fill="#f0f0f0"\/>/);
  // (the ink: the root's color, for the shim's currentColor; the text itself untouched)
  for (const id of [1, 7]) assert.match(shown(id)["image/svg+xml"], /^<svg [^>]*style="color:#262626;--sb-legend-bg:#ffffff"/);
  assert.match(shown(8)["image/svg+xml"], />currentColor label</);
  assert.match(shown(8)["image/svg+xml"], /aria-label="[^"]*currentColor label/);
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

test("data functions: prctile in p's orientation, mov* padding with a numeric Endpoints fill (as Octave, STAT-1016); where Octave differs: sprand's published nonzero count, corrcoef's range and conjugate", () => {
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
  // (prctile: P has pct's orientation, only generated code follows A's; movmax: the fill 0
  // supplies the nonexisting elements, so the windows [0 0 4 8] .. [3 4 5 0] give 8 .. 5)
  assert.deepEqual(out.trim().split("\n"), ["[1 8.1]", "[7 7 7]", "[8 8 8 8 6 -1 3 4 5 5]", "47663 47663", "1 1", "-0.6250 -0.3750", "[NaN 1 NaN]", "1"]);
});

test("normest, Higham's power method for the 2-norm with MATLAB's documented stopping rule: its first estimate, agreement with the published examples' four digits, complex matrices, a matrix that annihilates the start", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "normest-"));
  writeFileSync(join(dir, "t.m"), [
    "[n, c] = normest(diag([10 1]), 1); fprintf('%.15g %d\\n', n, c);",
    "d = sqrt((1:6).*(6:-1:1)); S = diag(d,1) + diag(d,-1); fprintf('%.4f\\n', normest(S));",
    "fprintf('%.4f\\n', normest(sparse(1:5,1:5,1:5))); rng default; S = rand(1000); fprintf('%.4f\\n', normest(S, 1e-4));",
    "fprintf('%.6f %.4f %.4f\\n', normest([1 2i; 3 4]), normest(sparse([1 -1; 1 -1])), normest(zeros(3)));",
  ].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--matlab", join(dir, "t.m")], { encoding: "utf8", timeout: 120000 });
  // (||S x|| for x = [1 1]/sqrt(2), Higham's estimate: sqrt(101/2))
  assert.deepEqual(out.trim().split("\n"), ["7.10633520177595 1", "6.0000", "5.0000", "500.4856", "5.305935 2.0000 0.0000"]);
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

test("colon counts a range's second half back from its end, as MATLAB's output shows: (0:0.1:0.5)(4) is exactly 0.3", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c",
    "x = 0:0.1:0.5; fprintf('%d %d %d\\n', x(4) == 0.3, x(end) == 0.5, numel(x));"], { encoding: "utf8" });
  assert.equal(out.trim(), "1 1 6");
});

test("rank-deficient least squares: the published examples' tolerances and basic solutions", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "A = magic(8); A = A(:,1:6); lastwarn(''); x = A \\ (260*ones(8,1)); disp(lastwarn); disp(mat2str(round(x' * 1e4) / 1e4));",
    "C = [1 0; 2 0; 1 0]; D = [1 2]; lastwarn(''); x = D/C; disp(lastwarn); disp(mat2str(x));",
  ].join(" ")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), [
    "Rank deficient, rank = 3, tol =  1.882938e-13.", "[3 4 0 0 1 0]",
    "Rank deficient, rank = 1, tol =  1.332268e-15.", "[0 0.5 0]",
  ]);
});

test("linspace as MATLAB documents it: n <= 0, n = 1, a non-integer n, NaN, complex ends, single, and the published examples", () => {
  const { execFileSync } = require("node:child_process");
  const run = (e: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", `x = ${e}; disp(mat2str(x, 5))`], { encoding: "utf8" }).trim();
  assert.equal(run("linspace(1, 2, 0)"), "zeros(1,0)");
  assert.equal(run("linspace(1, 2, -3)"), "zeros(1,0)");
  assert.equal(run("linspace(1, 2, 1)"), "2");
  assert.equal(run("linspace(1, 2, 3.7)"), "[1 1.5 2]");
  assert.equal(run("linspace(1, 2, NaN)"), "NaN");
  assert.equal(run("size(linspace(0, 1))"), "[1 100]");
  assert.equal(run("linspace(-5, 5, 7)"), "[-5 -3.3333 -1.6667 0 1.6667 3.3333 5]");
  assert.equal(run("linspace(1+2i, 10+10i, 8)"), "[1+2i 2.2857+3.1429i 3.5714+4.2857i 4.8571+5.4286i 6.1429+6.5714i 7.4286+7.7143i 8.7143+8.8571i 10+10i]");
  assert.equal(run("class(linspace(single(0), 1, 3))"), "'single'");
});

test("the close-to-singular warning prints Higham's estimated RCOND, as the published magic(4) example shows", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c",
    "lastwarn(''); x = magic(4) \\ [34; 34; 34; 34]; disp(lastwarn)"], { encoding: "utf8" });
  // (two spaces before the value, as every published copy of the warning shows: RCOND =  1.30614...)
  assert.equal(out.trim(), "Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND =  1.306145e-17.");
});

test("deconv as documented: long division, least squares for each shape (the least-norm solution), regularization, orientation and the refusals", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "[x, r] = deconv([2 7 4 9], [1 0 1]); disp(mat2str(x)); disp(mat2str(r));",
    "[x, r] = deconv([2 7 4 9]', [1 0 1]); disp(mat2str(size(x))); disp(mat2str(size(r)));",
    "[x, r] = deconv([1 2], [1 2 3]); disp(mat2str(x)); disp(mat2str(r));",
    "y = conv([-1 2], [2 5], 'valid'); [x, r] = deconv(y, [2 5], 'valid', Method='least-squares'); disp(mat2str(x, 4)); disp(abs(r) < 1e-14);",
    "disp(mat2str(conv(x, [2 5]), 4));",
    "xin = [-1 2 3 -2 0 1 2]; h = [2 4 -1 1]; y = conv(xin, h, 'same'); [x, r] = deconv(y, h, 'same', Method='least-squares'); disp(max(abs(x - xin)) < 1e-12); disp(max(abs(r)) < 1e-12);",
    "y = conv([1 2 3], [1 -1 2]); x = deconv(y, [1 -1 2], Method='least-squares'); disp(max(abs(x - [1 2 3])) < 1e-12);",
    "x = deconv(y, [1 -1 2], Method='least-squares', RegularizationFactor=1); disp(norm(x) < norm([1 2 3]));",
    "disp(class(deconv(single([2 7 4 9]), [1 0 1])));",
    "try, deconv([1 2 3], [1 1], 'same'), catch e, disp(e.message), end",
    "try, deconv([1 2 3], [0 1]), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "[2 7]", "[0 0 2 2]", "[2 1]", "[4 1]", "0", "[1 2]",
    "[-0.1724 -0.06897]", "1", "[-0.3448 -1 -0.3448]", "1", "1", "1", "1", "single",
    "The shape must be \"full\" when Method is \"long-division\".", "First coefficient of h must be non-zero.",
  ]);
});

test("lu's 'vector' form gives P as a row, as the published whos output shows (1x1000 for a 1000-by-1000 A), and lu refuses the sparse-only forms", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "A = magic(4); [L, U, p] = lu(A, 'vector'); disp(mat2str(size(p))); disp(norm(A(p, :) - L*U) < 1e-12);",
    "[L, U, p] = lu(sparse(A), 'vector'); disp(mat2str(size(p))); disp(issparse(p));",
    "try, [L, U, P, Q] = lu(sparse(A)); catch e, disp(e.message), end",
    "try, [L, U, P] = lu(sparse(A), 0.5); catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), ["[1 4]", "1", "[1 4]", "0",
    "lu: the column permutation Q and the scaling D are not supported in Sagebrush.", "lu: pivoting thresholds are not supported in Sagebrush."]);
});

test("qr(S, B) gives C = Q'*B for least squares, as documented (the corpus's sparse example's identity t1 + t2 = 1), and qr refuses what it lacks", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "S = sprand(500, 20, 0.1); b = ones(500, 1); [C, R] = qr(S, b, 'econ'); x = R\\C;",
    "t1 = norm(S*x - b)^2/norm(b)^2; t2 = norm(C)^2/norm(b)^2; disp(abs(t1 + t2 - 1) < 1e-12); disp(norm(x - full(S)\\b) < 1e-10);",
    "try, [Q, R, P] = qr(magic(3)); catch e, disp(e.message), end",
    "try, C = qr(S, b); catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), ["1", "1",
    "qr: the column permutation P is not supported in Sagebrush.", "qr(S, B) returns C and R: call it with two outputs."]);
});

test("grouped bars by Sagebrush's rule (a group 0.8 of the spacing, BarWidth of each slot), and pie's labels as Octave's", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "f = figure('visible', 'off');",
    "b = bar(magic(3)); disp(mat2str(b(1).XEndPoints, 6)); disp(mat2str(b(3).XEndPoints, 6));",
    "Y = magic(3); b = bar([1 3 5], Y(:, 1:2), 1); disp(mat2str(b(2).XEndPoints, 6));",
    "pie([0.002 1 2]); t = findobj(gca, 'Type', 'text'); disp(strjoin(get(t, 'String')', ' ')); p = get(t(1), 'Position'); disp(norm(p(1:2)) == 1.2);",
    // (a total just below 1 is a partial pie, its values the slices' areas, as documented and as Octave draws it)
    "pie([0.004999999999999, 0.994999999999501]); t = findobj(gca, 'Type', 'text'); disp(strjoin(get(t, 'String')', ' '));",
    "close all",
  ].join(" ")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), ["[0.733333 1.73333 2.73333]", "[1.26667 2.26667 3.26667]", "[1.4 3.4 5.4]", "67% 33% 0%", "1", "99% 0%"]);
});

test("contour's automatic levels: round multiples of a step near a seventh of the span (the published fcontour example's 0.2:0.2:1.4), and a filled contour's minimum", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "f = figure('visible', 'off');",
    "v = linspace(-5, 5, 71); [X, Y] = meshgrid(v); Z = exp(-(X/3).^2-(Y/3).^2) + exp(-(X+2).^2-(Y+2).^2);",
    "[C, h] = contour(X, Y, Z); disp(mat2str(h.LevelList, 4));",
    "[C, h] = contour(peaks); disp(mat2str(h.LevelList));",
    "[C, h] = contour(magic(5)/3); disp(mat2str(h.LevelList));",
    "[C, h] = contourf(magic(4)); disp(mat2str(h.LevelList));",
    "[C, h] = contour(magic(4)); disp(mat2str(h.LevelList));",
    "[C, h] = contour(peaks, 3); disp(numel(h.LevelList));",
    "close all",
  ].join(" ")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "[0.2 0.4 0.6 0.8 1 1.2 1.4]", "[-6 -4 -2 0 2 4 6 8]", "[1 2 3 4 5 6 7 8]", "[1 2 4 6 8 10 12 14 16]", "[2 4 6 8 10 12 14 16]", "3",
  ]);
});

test("deconv and qr validate as documented: RegularizationFactor one real number, an empty h for 'same' and 'valid', qr's scalar B and refused outputForm", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "try, deconv([1 2 3], [1 1], Method='least-squares', RegularizationFactor=[1 2]), catch e, disp(e.message), end",
    "try, deconv([1 2 3], [1 1], Method='least-squares', RegularizationFactor=1i), catch e, disp(e.message), end",
    "[x, r] = deconv([1 2 3], [], 'valid', Method='least-squares'); disp(mat2str(x)); disp(mat2str(r));",
    "[x, r] = deconv([1 2 3], [], 'same', Method='least-squares'); disp(mat2str(x));",
    "S = sparse([2 3]); [C, R] = qr(S, 1, 'econ'); disp(mat2str([issparse(C) issparse(R)]));",
    "[Q, R] = qr(sparse([1 2; 3 4]), 0); disp(mat2str([issparse(Q) issparse(R)]));",
    // (a purely imaginary scalar is a right side, not the economy flag 0)
    "S = sparse([2 3]); [C, R] = qr(S, 2i); disp(mat2str([issparse(C) real(C) == 0 abs(abs(C) - 2) < 1e-14]));",
    "try, [Q, R] = qr([1 2; 3 4], 'vector'), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "RegularizationFactor must be a real number.", "RegularizationFactor must be a real number.",
    "[0 0 0]", "[1 2 3]", "[0 0 0]", "[false true]", "[true true]", "[false true true]",
    "qr: the outputForm argument needs the column permutation P, which is not supported in Sagebrush.",
  ]);
});

test("repelem takes a string scalar and string arrays, and only numeric scalar or vector factors, as documented", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "u = repelem(\"x\", 3); disp(class(u)); disp(mat2str(size(u))); disp(u(3));",
    "u = repelem([\"a\" \"b\"], [1 2]); disp(u(3));",
    "disp(mat2str(repelem([1 2], int8(2))));",
    "try, repelem([1 2 3 4], [1 1; 1 1]), catch e, disp(e.message), end",
    "try, repelem([8 9], 'a'), catch e, disp(e.message), end",
    "try, repelem([8 9], true), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), ["string", "[1 3]", "x", "b", "[1 1 2 2]",
    "Replication factors must be scalars or vectors.", "Replication factors must be numeric.", "Replication factors must be numeric."]);
});

test("optimset and optimget as documented: their pages' examples, solver defaults, partial names, merging and refusals", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "o = optimset('fzero'); disp(o.TolX == eps); disp(o.Display);",
    "disp(strjoin(fieldnames(optimset())', ','));",
    // (the page's merging examples, with MaxIter in place of PlotFcns, which Sagebrush refuses)
    "oldopts = optimset(TolFun=1e-6); options = optimset(oldopts, MaxIter=40, TolX=1e-6); disp(mat2str([options.TolFun options.TolX options.MaxIter]));",
    "oldopts = optimset(Display='iter', TolX=1e-6); newopts = optimset(MaxIter=40, Display='off'); options = optimset(oldopts, newopts); disp(options.Display); disp(options.TolX);",
    "o = optimset(@fminbnd); disp(mat2str([o.MaxFunEvals o.MaxIter o.TolX])); o = optimset('fminsearch'); disp(isempty(o.MaxIter)); disp(o.TolFun);",
    "disp(optimget(optimset('tolx', 3), 'TolX')); disp(optimget(optimset(), 'MaxIter', 7)); disp(optimget(optimset('Display', 'iter'), 'disp'));",
    "try, optimset('Bogus', 1), catch e, disp(e.message), end",
    "try, optimset('Max', 1), catch e, disp(e.message), end",
    "try, optimset('Display', 'loud'), catch e, disp(e.message), end",
    // (each value checked as the listing says, also from a structure; the words stored in lower case)
    "o = optimset('Display', 'ITER', 'FunValCheck', 'ON'); disp([o.Display ' ' o.FunValCheck]);",
    "try, optimset('MaxIter', 1.5), catch e, disp(e.message), end",
    "try, optimset('MaxIter', 1+2i), catch e, disp(e.message), end",
    "try, optimset('TolX', 1+2i), catch e, disp(e.message), end",
    "try, optimset('OutputFcn', 17), catch e, disp(e.message), end",
    "try, optimset('PlotFcns', 'optimplotfval'), catch e, disp(e.message), end",
    "s.MaxIter = 1.5; try, optimset(optimset(), s), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "1", "notify", "Display,FunValCheck,MaxFunEvals,MaxIter,OutputFcn,PlotFcns,TolFun,TolX",
    "[1e-06 1e-06 40]", "off", "1.0000e-06", "[500 500 0.0001]", "1", "1.0000e-04",
    "3", "7", "iter",
    "optimset: unrecognized parameter name 'Bogus'.", "optimset: ambiguous parameter name 'Max' (MaxFunEvals, MaxIter).",
    "optimset: Display must be 'notify', 'final', 'off', 'none' or 'iter'.",
    "iter on", "optimset: MaxIter must be a positive integer.", "optimset: MaxIter must be a positive integer.",
    "optimset: TolX must be a nonnegative real scalar.",
    "optimset: OutputFcn must be a function handle or a cell array of function handles.",
    "optimset: the PlotFcns option is not supported in Sagebrush.", "optimset: MaxIter must be a positive integer.",
  ]);
});

test("fzero reproduces its published examples: results, output structures and iterative displays", () => {
  const { execFileSync } = require("node:child_process");
  const run = (code: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code],
    { encoding: "utf8" }).split("\n").map((s: string) => s.trimEnd()).filter((s: string) => s !== "");
  // (the doc page's single, interval and double examples: counts and messages)
  const counts = run([
    "f = @(x)cosh(x)-2*sinh(x);",
    "[x,fval,exitflag,output] = fzero(f,single(1)); disp(class(x)); disp(class(exitflag)); fprintf('%.4f %d %d\\n', x, exitflag, output.intervaliterations); disp(output.message);",
    "[x2,fval2,exitflag2,output2] = fzero(f,single([-1,1])); fprintf('%.4f %d %d %d\\n', x2, output2.intervaliterations, output2.iterations, output2.funcCount); disp(output2.message);",
    "[x3,fval3,exitflag3,output3] = fzero(f,[-1,1]); fprintf('%.4f %.4e %d %d %d\\n', x3, fval3, output3.intervaliterations, output3.iterations, output3.funcCount); disp(output3.algorithm);",
    "fun = @(x) exp(-exp(-x)) - x; [x fval exitflag output] = fzero(fun,[0 1]); fprintf('%.4f %g %d %d %d\\n', x, fval, exitflag, output.iterations, output.funcCount);",
  ].join("\n"));
  assert.deepEqual(counts, ["single", "single", "0.5493 1 9", "Zero found in the interval [0.547452, 1.32]",
    "0.5493 0 5 7", "Zero found in the interval [-1, 1]",
    "0.5493 -2.2204e-16 0 7 9", "bisection, interpolation", "0.5671 0 1 5 7"]);
  // (the published displays of humps from an interval and from a point, to the digit)
  const humps = "h = @(x) 1./((x-0.3).^2+0.01) + 1./((x-0.9).^2+0.04) - 6; options = optimset('Display','iter');";
  assert.deepEqual(run(humps + " a = fzero(h,[-1 1],options);"), [
    " Func-count    x          f(x)             Procedure",
    "    2              -1      -5.13779        initial",
    "    3       -0.513876      -4.02235        interpolation",
    "    4       -0.513876      -4.02235        bisection",
    "    5       -0.473635      -3.83767        interpolation",
    "    6       -0.115287      0.414441        bisection",
    "    7       -0.115287      0.414441        interpolation",
    "    8       -0.132562    -0.0226907        interpolation",
    "    9       -0.131666    -0.0011492        interpolation",
    "   10       -0.131618   1.88371e-07        interpolation",
    "   11       -0.131618   -2.7935e-11        interpolation",
    "   12       -0.131618   8.88178e-16        interpolation",
    "   13       -0.131618   8.88178e-16        interpolation",
    "Zero found in the interval [-1, 1]"]);
  assert.deepEqual(run(humps + " a = fzero(h,-0.2,options);"), [
    "Search for an interval around -0.2 containing a sign change:",
    " Func-count    a          f(a)             b          f(b)                    Procedure",
    "    1            -0.2      -1.35385          -0.2      -1.35385               initial interval",
    "    3       -0.194343      -1.26077     -0.205657      -1.44411               search",
    "    5          -0.192      -1.22137        -0.208       -1.4807               search",
    "    7       -0.188686      -1.16477     -0.211314      -1.53167               search",
    "    9          -0.184      -1.08293        -0.216      -1.60224               search",
    "   11       -0.177373     -0.963455     -0.222627      -1.69911               search",
    "   13          -0.168     -0.786636        -0.232      -1.83055               search",
    "   15       -0.154745      -0.51962     -0.245255      -2.00602               search",
    "   17          -0.136     -0.104165        -0.264      -2.23521               search",
    "   18        -0.10949      0.572246        -0.264      -2.23521               search",
    "Search for a zero in the interval [-0.10949, -0.264]:",
    " Func-count    x          f(x)             Procedure",
    "   18        -0.10949      0.572246        initial",
    "   19       -0.140984     -0.219277        interpolation",
    "   20       -0.132259    -0.0154224        interpolation",
    "   21       -0.131617   3.40729e-05        interpolation",
    "   22       -0.131618  -6.79505e-08        interpolation",
    "   23       -0.131618  -2.98428e-13        interpolation",
    "   24       -0.131618   8.88178e-16        interpolation",
    "   25       -0.131618   8.88178e-16        interpolation",
    "Zero found in the interval [-0.10949, -0.264]"]);
  // (the problem structure, the Display levels and an output function)
  assert.deepEqual(run([
    "problem.objective = @(x)sin(cosh(x)); problem.x0 = 1; problem.solver = 'fzero'; problem.options = optimset(@fzero);",
    "fprintf('%.4f\\n', fzero(problem));",
    "x = fzero(@(x) x - 2, [0 4], optimset('Display', 'final')); x = fzero(@(x) x - 2, [0 4]); x = fzero(@(x) x - 2, [0 4], optimset('Display', 'off'));",
    "[x,f,e,o] = fzero(@cos, [1 2], optimset('OutputFcn', @(x, v, s) v.iteration >= 2, 'Display', 'off')); fprintf('%d %d\\n', e, o.iterations);",
  ].join("\n")), ["1.8115", "Zero found in the interval [0, 4]", "-1 2"]);
  // (from x0 = 0: Octave's scale for a zero start, 0.1, in the published step, dx = 0.1/50 times sqrt(2)^k)
  const zero = run("x = fzero(@(x) x - 1, 0, optimset('Display', 'iter'));");
  assert.ok(zero.includes("    3     -0.00282843      -1.00283    0.00282843     -0.997172               search"), zero.slice(0, 5).join("\n"));
  assert.ok(zero.includes("    5          -0.004        -1.004         0.004        -0.996               search"));
});

test("fzero's other exits: no sign change, overflow, a sign change at a pole (never -5), and its refusals", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "o = optimset('Display', 'off');",
    "[x,f,e] = fzero(@(x) sqrt(x) - 10, 1, o); disp(mat2str([x f e]));",
    "[x,f,e] = fzero(@(x) 1./x + 1, 0, o); disp(mat2str([x f e]));",
    "[x,f,e] = fzero(@(x) x.^2 + 1, 1, o); disp(mat2str([x f e]));",
    "[x,f,e] = fzero(@(x) 1 + 0*x, 1, o); disp(mat2str([x f e]));",
    "[x,f,e] = fzero(@tan, [1 2], o); disp(mat2str([abs(x - pi/2) < 1e-15 abs(f) > 1e14 e]));",
    "[x,f,e,out] = fzero(@(x) x.^2, 0, o); disp(mat2str([x f e out.funcCount]));",
    "try, fzero(@(x) x + 2, [0 4]), catch err, disp(err.message), end",
    "try, fzero(@(x) x + 2, [0 Inf]), catch err, disp(err.message), end",
    "try, fzero(@(x) x + 2, [0 1 2]), catch err, disp(err.message), end",
    "try, fzero(@(x) x + 2, 1i), catch err, disp(err.message), end",
    "p = optimset(); p.PlotFcns = @optimplotx; try, fzero(@(x) x + 2, 1, p), catch err, disp(err.message), end",
    "try, fzero(@(x) sqrt(x) - 10, 1, optimset('FunValCheck', 'on')), catch err, disp(err.message), end",
    "q = optimset(); q.FunValCheck = 'ON'; try, fzero(@(x) sqrt(x) - 10, 1, q), catch err, disp(err.message), end",
    "try, fzero(@(x) [x x], 1), catch err, disp(err.message), end",
    "try, p.objective = @sin; p.x0 = 3; fzero(p), catch err, disp(err.message), end",
    "try, fzero(@(x) x - 0.5 + 0 ./ (abs(x - 0.5) >= 0.1), [0 1]), catch err, disp(err.message), end",
    "x = fzero(@(x) x.^2 + 1, 1);",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "[NaN NaN -4]", "[NaN NaN -3]", "[NaN NaN -3]", "[NaN NaN -6]", "[1 1 1]", "[0 0 1 1]",
    "fzero: the function values at the interval endpoints must differ in sign.",
    "fzero: the interval x0 must be finite.",
    "fzero: x0 must be a real scalar or a two-element real vector.",
    "fzero: x0 must be real.",
    "fzero: the PlotFcns option is not supported in Sagebrush.",
    "fzero: the function returned a complex value at x = -0.28 (FunValCheck is on).",
    "fzero: the function returned a complex value at x = -0.28 (FunValCheck is on).",
    "fzero: the function must return a numeric scalar.",
    "fzero: the problem structure needs the field 'solver'.",
    "fzero: the function returned NaN at x = 0.5, inside the interval; fzero cannot continue.",
    "fzero stopped searching for an interval containing a sign change: the function value at x = -1.7162e+154 is Inf.",
  ]);
});

test("fminbnd reproduces its published examples, and its exits and refusals", () => {
  const { execFileSync } = require("node:child_process");
  const run = (code: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code],
    { encoding: "utf8" }).split("\n").map((s: string) => s.trimEnd()).filter((s: string) => s !== "");
  const done = ["Optimization terminated:", " the current x satisfies the termination criteria using OPTIONS.TolX of 1.000000e-04"];
  assert.deepEqual(run("options = optimset(Display=\"iter\"); x = fminbnd(@sin,0,2*pi,options);"), [
    " Func-count     x          f(x)         Procedure",
    "    1        2.39996      0.67549        initial",
    "    2        3.88322     -0.67549        golden",
    "    3        4.79993    -0.996171        golden",
    "    4        5.08984    -0.929607        parabolic",
    "    5        4.70582    -0.999978        parabolic",
    "    6         4.7118           -1        parabolic",
    "    7        4.71239           -1        parabolic",
    "    8        4.71236           -1        parabolic",
    "    9        4.71242           -1        parabolic", ...done]);
  assert.deepEqual(run("h = @(x) 1./((x-0.3).^2+0.01) + 1./((x-0.9).^2+0.04) - 6; x = fminbnd(h,0.3,1,optimset('Display','iter'));"), [
    " Func-count     x          f(x)         Procedure",
    "    1       0.567376      12.9098        initial",
    "    2       0.732624      13.7746        golden",
    "    3       0.465248      25.1714        golden",
    "    4       0.644416      11.2693        parabolic",
    "    5         0.6413      11.2583        parabolic",
    "    6       0.637618      11.2529        parabolic",
    "    7       0.636985      11.2528        parabolic",
    "    8       0.637019      11.2528        parabolic",
    "    9       0.637052      11.2528        parabolic", ...done]);
  assert.deepEqual(run([
    "[x,fval,exitflag,output] = fminbnd(@sin,0,2*pi); fprintf('%.4f %.4f %d %d %d\\n', x, fval, exitflag, output.iterations, output.funcCount); disp(output.algorithm); disp(output.message); disp(double(output.message(end)));",
    "fprintf('%.4f\\n', fminbnd(@(x)sin(x-9/7),1,2*pi)); [x fval] = fminbnd(@(x)-tan(cos(x)),3,8); fprintf('%.4f %.4f\\n', x, fval);",
    "o = optimset('Display', 'off');",
    "[x,f,e,o2] = fminbnd(@sin, 2, 1, o); disp(mat2str([x f e o2.funcCount]));",
    "[x,f,e,o2] = fminbnd(@sin, 0, 2*pi, optimset(o, 'MaxFunEvals', 4)); disp(mat2str([e o2.funcCount o2.iterations]));",
    "[x,f,e,o2] = fminbnd(@sin, 0, 2*pi, optimset(o, 'MaxIter', 4)); disp(mat2str([e o2.funcCount o2.iterations]));",
    "[x,f,e,o2] = fminbnd(@sin, 0, 2*pi, optimset(o, 'OutputFcn', @(x,v,s) v.iteration >= 3)); disp(mat2str([e o2.iterations]));",
    "p.objective = @sin; p.x1 = 0; p.x2 = 2*pi; p.solver = 'fminbnd'; fprintf('%.4f\\n', fminbnd(p));",
    "x = fminbnd(@sin, 0, 2*pi, optimset('MaxIter', 2));",
    "try, fminbnd(@(x) sqrt(x - 2), 0, 1), catch err, disp(err.message), end",
    "try, fminbnd(@(x) x, 0, Inf), catch err, disp(err.message), end",
    "try, fminbnd(@(x) x, single(0), 1), catch err, disp(err.message), end",
    "try, fminbnd(@(x) NaN, 0, 1, optimset('FunValCheck', 'on')), catch err, disp(err.message), end",
    "p = optimset(); p.PlotFcns = @optimplotfval; try, fminbnd(@sin, 0, 1, p), catch err, disp(err.message), end",
  ].join("\n")), [
    "4.7124 -1.0000 1 8 9", "golden section search, parabolic interpolation", ...done, "    32",
    "5.9981", "6.2832 -1.5574",
    "[NaN NaN -2 0]", "[0 4 3]", "[0 5 4]", "[-1 3]", "4.7124",
    "fminbnd stopped: it reached the MaxIter limit of 2 before meeting TolX.",
    "fminbnd: the objective function returned a complex value; only real values can be minimized.",
    "fminbnd: the bounds x1 and x2 must be finite.",
    "fminbnd: the bounds x1 and x2 must be double scalars.",
    "fminbnd: the objective function returned NaN (FunValCheck is on).",
    "fminbnd: the PlotFcns option is not supported in Sagebrush.",
  ]);
});

test("fminsearch reproduces its published examples: the iterative display, results, and an output function's history", () => {
  const { execFileSync } = require("node:child_process");
  const run = (code: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code],
    { encoding: "utf8" }).split("\n").map((s: string) => s.trimEnd()).filter((s: string) => s !== "");
  const objectivefcn1 = "\nfunction f = objectivefcn1(x)\nf = 0;\nfor k = -10:10\n    f = f + exp(-(x(1)-x(2))^2 - 2*x(1)^2)*cos(x(2))*sin(2*x(2));\nend\nend";
  const rows = [
    [0, 1, "-6.70447", ""], [1, 3, "-6.89837", "initial simplex"], [2, 5, "-7.34101", "expand"], [3, 7, "-7.91894", "expand"],
    [4, 9, "-9.07939", "expand"], [5, 11, "-10.5047", "expand"], [6, 13, "-12.4957", "expand"], [7, 15, "-12.6957", "reflect"],
    [8, 17, "-12.8052", "contract outside"], [9, 19, "-12.8052", "contract inside"], [10, 21, "-13.0189", "expand"],
    [11, 23, "-13.0189", "contract inside"], [12, 25, "-13.0374", "reflect"], [13, 27, "-13.122", "reflect"],
    [14, 28, "-13.122", "reflect"], [15, 29, "-13.122", "reflect"], [16, 31, "-13.122", "contract outside"],
    [17, 33, "-13.1279", "contract inside"], [18, 35, "-13.1279", "contract inside"], [19, 37, "-13.1296", "contract inside"],
    [20, 39, "-13.1301", "contract inside"], [21, 41, "-13.1305", "reflect"], [22, 43, "-13.1306", "contract inside"],
    [23, 45, "-13.1309", "contract inside"], [24, 47, "-13.1309", "contract inside"], [25, 49, "-13.131", "reflect"],
    [26, 51, "-13.131", "contract inside"], [27, 53, "-13.131", "contract inside"], [28, 55, "-13.131", "contract inside"],
    [29, 57, "-13.131", "contract outside"], [30, 59, "-13.131", "contract inside"], [31, 61, "-13.131", "contract inside"],
    [32, 63, "-13.131", "contract inside"], [33, 65, "-13.131", "contract outside"], [34, 67, "-13.131", "contract inside"],
    [35, 69, "-13.131", "contract inside"],
  ].map(([i, n, f, p]) => (String(i).padStart(6) + String(n).padStart(13) + String(f).padStart(17) + "         " + p).trimEnd());
  assert.deepEqual(run("options = optimset(Display=\"iter\"); [x,fval,exitflag,output] = fminsearch(@objectivefcn1,[0.25,-0.25],options);"
    + " fprintf('%.4f %.4f %.4f %d %d %d\\n', x, fval, exitflag, output.iterations, output.funcCount); disp(output.algorithm);" + objectivefcn1), [
    " Iteration   Func-count         f(x)         Procedure", ...rows,
    "Optimization terminated:",
    " the current x satisfies the termination criteria using OPTIONS.TolX of 1.000000e-04",
    " and F(X) satisfies the convergence criteria using OPTIONS.TolFun of 1.000000e-04",
    "-0.1696 -0.5086 -13.1310 1 35 69", "Nelder-Mead simplex direct search"]);
  assert.deepEqual(run([
    "fun = @(x)100*(x(2) - x(1)^2)^2 + (1 - x(1))^2; fprintf('%.4f %.4f\\n', fminsearch(fun,[-1.2,1]));",
    "f = @(x,a)100*(x(2) - x(1)^2)^2 + (a-x(1))^2; a = 3; fprintf('%.4f %.4f\\n', fminsearch(@(x)f(x,a),[-1,1.9]));",
    "x0 = [1,2,3]; fun = @(x)-norm(x+x0)^2*exp(-norm(x-x0)^2 + sum(x)); [x,fval] = fminsearch(fun,x0); fprintf('%.4f %.4f %.4f %.4e\\n', x, fval);",
    "a = fminsearch(@(v) v(1).^2 + 2.5*sin(v(2)) - v(3)^2*v(1)^2*v(2)^2, [-0.6,-1.2,0.135]); fprintf('%.4f %.4f %.4f\\n', abs(a(1)), a(2:3));",
    // (the nested output function's recorded history: its first four points and the solution)
    "o = optimset('OutputFcn', @(x,v,s) isequal(s, 'iter') && isempty(fprintf('%.4f %.4f\\n', x)));",
    "objfun = @(x) exp(x(1))*(4*x(1)^2+2*x(2)^2+x(1)*x(2)+2*x(2)); [x fval] = fminsearch(objfun, [-1 1], o); fprintf('= %.4f %.4f %.4f\\n', x, fval);",
  ].join("\n")).filter((s: string, i: number, all: string[]) => i < 8 || s.startsWith("=") || all[i + 1]?.startsWith("=")), [
    "1.0000 1.0000", "3.0000 9.0000", "1.5359 2.5645 3.5932 -5.9565e+04", "0.0000 -1.5708 0.1803",
    "-1.0000 1.0000", "-1.0000 1.0000", "-1.0750 0.9000", "-1.0125 0.8500", "0.1290 -0.5323", "= 0.1290 -0.5323 -0.5689"]);
});

test("fminsearch's limits, x0's shape, the problem structure and its refusals", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "r = @(x)100*(x(2) - x(1)^2)^2 + (1 - x(1))^2; o = optimset('Display', 'off');",
    "[x,f,e,s] = fminsearch(r, [-1.2 1], optimset(o, 'MaxIter', 10)); disp(mat2str([e s.iterations s.funcCount]));",
    "[x,f,e,s] = fminsearch(r, [-1.2 1], optimset(o, 'MaxFunEvals', 10)); disp(mat2str([e s.iterations s.funcCount]));",
    "[x,f,e,s] = fminsearch(r, [-1.2 1], optimset(o, 'OutputFcn', @(x,v,s) v.iteration >= 5)); disp(mat2str([e s.iterations]));",
    "x = fminsearch(@(x) sum((x - [1 2; 3 4]).^2, 'all'), zeros(2)); disp(mat2str(round(x * 1e3) / 1e3));",
    "x = fminsearch(@(x) abs(x(1)) + abs(x(2) - 1), [1; 3]); disp(mat2str(size(x)));",
    // (the initial simplex takes x0's components in linear-index order)
    "x = fminsearch(@(x) numel(fprintf('%s\\n', mat2str(x))), [1 2; 3 4], optimset(o, 'MaxFunEvals', 3));",
    "p.objective = @(x) (x-1)^2; p.x0 = 5; p.solver = 'fminsearch'; disp(round(fminsearch(p) * 1e3) / 1e3);",
    "x = fminsearch(r, [-1.2 1], optimset('MaxIter', 3));",
    "try, fminsearch(@(x) sqrt(x), -1), catch err, disp(err.message), end",
    "try, fminsearch(@(x) x, []), catch err, disp(err.message), end",
    "try, fminsearch(@(x) x, int8(1)), catch err, disp(err.message), end",
    "try, fminsearch(@(x) [x x], 1), catch err, disp(err.message), end",
    "try, fminsearch(@(x) NaN, 1, optimset('FunValCheck', 'on')), catch err, disp(err.message), end",
    "p = optimset(); p.PlotFcns = @optimplotfval; try, fminsearch(@(x) x, 1, p), catch err, disp(err.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "[0 10 21]", "[0 5 11]", "[-1 5]", "[1 2;3 4]", "[2 1]", "[1 2;3 4]", "[1.05 2;3 4]", "[1 2;3.15 4]", "[1 2.1;3 4]", "[1 2;3 4.2]", "1",
    "fminsearch stopped: it reached the MaxIter limit of 3 before meeting TolX and TolFun.",
    "fminsearch: the objective function returned a complex value; only real values can be minimized.",
    "fminsearch: x0 must be a nonempty double array.", "fminsearch: x0 must be a nonempty double array.",
    "fminsearch: the objective function must return a numeric scalar.",
    "fminsearch: the objective function returned NaN (FunValCheck is on).",
    "fminsearch: the PlotFcns option is not supported in Sagebrush.",
  ]);
});

test("lsqnonneg reproduces its published examples, and its limit, problem structure and refusals", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "C = [0.0372 0.2869; 0.6861 0.7071; 0.6233 0.6245; 0.6344 0.6170]; d = [0.8587; 0.1781; 0.0747; 0.8405];",
    "[x,resnorm,residual,exitflag,output,lambda] = lsqnonneg(C,d);",
    "fprintf('%.4f ', x, resnorm, residual, exitflag, output.iterations, lambda); fprintf('\\n'); disp(output.algorithm); disp(output.message);",
    "fprintf('%.4f %.4f\\n', norm(C*x - d), norm(residual)^2);",
    "x = lsqnonneg(C,d,optimset(Display='final'));",
    "x = lsqnonneg(C,d);",
    "[x,rn,res,e,out] = lsqnonneg(magic(5), [1; -1; 2; -2; 3], optimset('MaxIter', 1, 'Display', 'off')); disp(mat2str([e out.iterations all(x >= 0)]));",
    "x = lsqnonneg(magic(5), [1; -1; 2; -2; 3], optimset('MaxIter', 1));",
    "x = lsqnonneg(sparse([1 0; 0 1]), [1; 2]); disp(mat2str([issparse(x) x']));",
    "p.C = [1 0; 0 1]; p.d = [3; -1]; p.solver = 'lsqnonneg'; disp(mat2str(lsqnonneg(p)'));",
    "try, lsqnonneg([1 2; 3 4], [1; 2; 3]), catch err, disp(err.message), end",
    "try, lsqnonneg([1 2; 3 4], [1 2; 3 4]), catch err, disp(err.message), end",
    "try, lsqnonneg([1i 2; 3 4], [1; 2]), catch err, disp(err.message), end",
    "try, lsqnonneg(single([1 2; 3 4]), [1; 2]), catch err, disp(err.message), end",
    "try, lsqnonneg([1 2; 3 4], [1; 2], optimset('Display', 'iter')), catch err, disp(err.message), end",
    "try, lsqnonneg([1 NaN; 3 4], [1; 2]), catch err, disp(err.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "0.0000 0.6929 0.8315 0.6599 -0.3119 -0.3580 0.4130 1.0000 1.0000 -0.1506 -0.0000",
    "active-set", "Optimization terminated.", "0.9118 0.8315",
    "Optimization terminated.",
    "[0 1 1]", "lsqnonneg stopped: it reached the iteration limit of 1 before finishing.",
    "[0 1 2]", "[3 0]",
    "lsqnonneg: the length of d must equal the number of rows of C.",
    "lsqnonneg: d must be a vector.",
    "lsqnonneg: C must be real.",
    "lsqnonneg: C must be a real double matrix.",
    "lsqnonneg: Display 'iter' is not supported; use 'notify', 'final', 'off' or 'none'.",
    "lsqnonneg: C and d must be finite.",
  ]);
});

test("quad: its published example, the evaluation count, trace, warnings and refusals", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "myfun = @(x) 1./(x.^3-2*x-5); fprintf('%.4f\\n', quad(myfun,0,2));",
    // (Simpson's rule is exact for a cubic: the first step is accepted, after 5 values)
    "[q, n] = quad(@(x) x.^3 - x, 0, 2); disp(mat2str([q n]));",
    "q = quad(@(x) x.^2, 0, 1, [], 1);",
    "[q, n] = quad(@(x) exp(x), 0, 1); disp(abs(q - (exp(1) - 1)) < 1e-6 && n > 5);",
    "disp(quad(@(x) x, 2, 2)); fprintf('%.4f\\n', quad(@(x) x, 1, 0)); disp(class(quad(@(x) x, single(0), 1)));",
    "q = quad(@(x) exp(1i*x), 0, pi); fprintf('%.6f %.6f\\n', real(q), imag(q));",
    "lastwarn(''); q = quad(@(x) 1./sqrt(x), 0, 1); [msg, id] = lastwarn; disp(msg); disp(isnan(q));",
    "try, quad(@(x) 1, 0, 1), catch e, disp(e.message), end",
    "try, quad(@(x) x, 0, Inf), catch e, disp(e.message), end",
    "try, quad(@(x) x, 0, 1, -1), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "-0.4605", "[2 5]",
    "5                     0                     1      0.33333333333333",
    "1", "0", "-0.5000", "single", "0.000000 2.000000",
    "quad: the integrand is Inf or NaN in the interval, so the result is not finite.", "1",
    "quad: the integrand must return a vector of the same length as its input (use array operators such as .* and ./).",
    "quad: the limits a and b must be finite.",
    "quad: tol must be a nonnegative scalar.",
  ]);
});

test("integral and quadgk reproduce their published examples", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "fprintf('%.15f\\n', integral(@(x) log(x),0,1));",
    "fprintf('%.15f\\n', integral(@(x) log(x),0,1,AbsoluteTolerance=1e-12,RelativeTolerance=0));",
    // (published: -14.999999999998360; Sagebrush's last digits differ)
    "q = integral(@(x) x.^5.*exp(-x).*sin(x),0,Inf,AbsoluteTolerance=1e-13,RelativeTolerance=1e-8); fprintf('%.12f\\n', q);",
    "fprintf('%.4f\\n', integral(@(x) exp(-x.^2).*log(x).^2,0,Inf));",
    "fun = @(x,c) 1./(x.^3-2*x-c); fprintf('%.4f\\n', integral(@(x) fun(x,5),0,2));",
    "q = integral(@(z) 1./(2*z-1),0,0,Waypoints=[1+1i,1-1i]); fprintf('%.4f %.4f\\n', abs(real(q)), imag(q));",
    "fprintf('%.4f ', integral(@(x) sin((1:5)*x),0,1,ArrayValued=true)); fprintf('\\n');",
    "fprintf('%.4f\\n', integral(@(x) 2*x-x^2,0,1,Vectorized=false));",
    "fprintf('%.4f\\n', quadgk(@(x) exp(x).*log(x),0,1));",
    "q = quadgk(@(z) 1./(2.*z-1),1,1,'Waypoints',[1+1i 0+1i 0-1i 1-1i]); fprintf('%.4f %.4f\\n', abs(real(q)), imag(q));",
    "[Q,errbnd] = quadgk(@(x) sin(2e4*pi*x),0,pi); fprintf('%.4f %.4f\\n', Q, errbnd);",
    // (published: errbnd 2.6323e-12; Sagebrush's estimate is 2.5e-11, below the tolerance too)
    "[Q,errbnd] = quadgk(@(x) sin(2e4*pi*x),0,pi,'MaxIntervalCount',1e5); fprintf('%.4e %d\\n', Q, errbnd < 1e-10);",
  ].join("\n")], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  assert.deepEqual(out.trim().split("\n"), [
    "-1.000000010959678", "-1.000000000000010", "-14.999999999998", "1.9475", "-0.4605", "0.0000 -3.1416",
    "0.4597 0.7081 0.6633 0.4134 0.1433 ", "0.6667", "-1.3179", "0.0000 3.1416", "-0.0082 0.5723", "1.6656e-06 1"]);
});

test("integral: an array-valued integrand's components each meet their own tolerance; a large one does not hide a small one's error", () => {
  const out = require("node:child_process").execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "exact = (1 - cos(1000))/1000; q1 = integral(@(x) sin(1000*x), 0, 1);",
    "q = integral(@(x) [1e12; sin(1000*x)], 0, 1, 'ArrayValued', true); fprintf('%d %d\\n', abs(q(1)/1e12 - 1) < 1e-14, abs(q(2) - exact) < 1e-14);",
    "q = integral(@(x) [sin(1000*x); 1e12], 0, 1, 'ArrayValued', true); fprintf('%d %d\\n', abs(q(1) - exact) < 1e-14, abs(q(1) - q1) < 1e-14);",
    "q = integral(@(x) [1e-8*sin(x); x.^2], 0, pi, 'ArrayValued', true); fprintf('%d %d\\n', abs(q(1) - 2e-8) < 1e-20, abs(q(2) - pi^3/3) < 1e-12);",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), ["1 1", "1 1", "1 1"]);
});

test("integral and quadgk: infinite and reversed limits, waypoints, warnings and refusals", () => {
  const { execFileSync } = require("node:child_process");
  const r = require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "disp(abs(integral(@(x) exp(-x.^2), -Inf, Inf) - sqrt(pi)) < 1e-8);",
    "disp(abs(integral(@(x) exp(x), -Inf, 2, 'Waypoints', [-5 0]) - exp(2)) < 1e-9);",
    "disp(abs(integral(@(x) exp(x), 1, 0) + (exp(1) - 1)) < 1e-12);",
    "disp(integral(@(x) x, 2, 2)); disp(class(quadgk(@(x) x, single(0), 1)));",
    "lastwarn(''); [q, e] = quadgk(@(x) sin(2e4*pi*x), 0, pi); disp(lastwarn);",
    "lastwarn(''); q = integral(@(x) sin(2e4*pi*x), 0, pi); disp(lastwarn);",
    "try, integral(@(x) 1, 0, 1), catch err, disp(err.message), end",
    "try, integral(@(x) x, 0, 1, 'MaxIntervalCount', 10), catch err, disp(err.message), end",
    "try, quadgk(@(x) x, 0, 1, 'ArrayValued', true), catch err, disp(err.message), end",
    "try, integral(@(x) x, 0, 1, 'AbsTol', -1), catch err, disp(err.message), end",
    "try, integral(@(x) x, 0, 1, 'Waypoints', 2), catch err, disp(err.message), end",
    "try, integral(@(x) NaN*x, 0, 1), catch err, disp(err.message), end",
    "lastwarn(''); q = integral(@(x) 1./x, 0, 1); disp(lastwarn);",
    "try, integral(@(x) x, 0, Inf, 'Waypoints', 1i), catch err, disp(err.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(r.stdout.trim().split("\n").map((s: string) => s.trim()), [
    "1", "1", "1", "0", "single",
    "Reached the limit on the maximum number of intervals in use. Approximate bound on error is 5.7e-01.",
    "integral: Reached the limit on the maximum number of intervals in use. Approximate bound on error is 5.7e-01. The tolerances were not met.",
    "integral: the integrand must return an array the size of its input; use array operators (.*, ./, .^) or set ArrayValued.",
    "integral: unknown option 'MaxIntervalCount'.",
    "quadgk: unknown option 'ArrayValued'.",
    "integral: AbsTol must be a nonnegative real scalar.",
    "Waypoints must lie strictly between the limits of integration.",
    "integral: the integrand is Inf or NaN at the first points tried; no approximation of the integral is possible.",
    "integral: the integrand is Inf or NaN at some points; the last approximation is returned. Approximate bound on error is 2.4e+00.",
    "Contour integration requires all limits and waypoints to be finite.",
  ]);
});

test("ode45, ode23, odeset, odeget and deval: the pages' published examples, events, output functions and refusals", () => {
  const r = require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (deval's published example: ode23's cubic interpolant is exact for t^3/3)
    "sol = ode23(@(t,y) t^2, [0 3], 0); x = linspace(0,3,7); [y,yp] = deval(sol,x); disp(mat2str(round(y * 1e4) / 1e4)); disp(mat2str(round(yp * 1e4) / 1e4));",
    // (the solution structure's fields, as the ode45 page's example shows them)
    "vdp1 = @(t,y) [y(2); (1-y(1)^2)*y(2)-y(1)]; sol = ode45(vdp1,[0 20],[2 0]); disp(strjoin(fieldnames(sol)', ' ')); disp(mat2str(size(sol.y, 1)));",
    "y = deval(sol, [5 10], 1); disp(mat2str(size(y)));",
    // (odeset's published structure: its 23 fields in order, \"on\" stored as 'on')
    "o = odeset(RelTol=1e-8,AbsTol=1e-10); o = odeset(o,AbsTol=1e-9); f = fieldnames(o); disp(numel(f)); disp([f{1} ' ' f{end}]); disp(o.AbsTol); disp(o.RelTol);",
    "o = odeset(RelTol=1e-8,AbsTol=1e-9,Stats=\"on\"); disp(class(o.Stats)); disp(odeget(o, 'Stats')); disp(odeget(o, 'MaxStep', 0.5));",
    // (Refine: 4 by default for ode45, 1 for ode23, the points between each step's ends)
    "[t,y] = ode45(@(t,y) -y, [0 1], 1); [t1,y1] = ode45(@(t,y) -y, [0 1], 1, odeset('Refine', 1)); disp(numel(t) - 1 == 4 * (numel(t1) - 1));",
    "[t,y] = ode45(@(t,y) -y, [0 0.5 1], 1); disp(mat2str(t')); disp(max(abs(y - exp(-t))) < 1e-5);",
    // (a terminal event with a direction: a falling ball reaching the ground)
    "ev = @(t,y) deal(y(1), 1, -1); o = odeset('Events', ev, 'RelTol', 1e-8, 'AbsTol', 1e-10);",
    "[t,y,te,ye,ie] = ode45(@(t,y) [y(2); -9.8], [0 10], [10; 0], o); disp(abs(te - sqrt(20/9.8)) < 1e-8); disp(ie); disp(t(end) == te);",
    "opts = odeset('Stats','on'); [t,y] = ode23(@(t,y) -y, [0 1], 1, opts);",
    // (a pole at t = 1: the steps shrink to the smallest the precision allows,
    // and the integration ends there with a warning instead of stepping across)
    "lastwarn(''); [t,y] = ode45(@(t,y) 1/(1-t), [0 2], 0); disp(t(end) < 1 && t(end) > 1 - 1e-10); disp(~isempty(lastwarn));",
    "lastwarn(''); [t,y] = ode23(@(t,y) 1/(1-t), [0 2], 0); disp(t(end) < 1 && t(end) > 1 - 1e-10); disp(~isempty(lastwarn));",
    "try, ode45(@(t,y) -y, [0 1], 1, odeset('Mass', 1)), catch e, disp(e.message), end",
    "try, ode45(@(t,y) [y; y], [0 1], 1), catch e, disp(e.message), end",
    "try, ode45(@(t,y) -y, [0 1 0.5], 1), catch e, disp(e.message), end",
    "try, odeset('Bogus', 1), catch e, disp(e.message), end",
    "try, odeset('RelTol', -1), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  const lines = r.stdout.trim().split("\n").map((s: string) => s.trim());
  assert.deepEqual(lines.slice(0, 13), [
    "[0 0.0417 0.3333 1.125 2.6667 5.2083 9]", "[0 0.25 1 2.25 4 6.25 9]",
    "solver extdata x y stats idata", "2", "[1 2]",
    "23", "AbsTol InitialSlope", "1.0000e-09", "1.0000e-08", "char", "on", "0.5000", "1",
  ]);
  assert.deepEqual(lines.slice(13, 18), ["[0 0.5 1]", "1", "1", "1", "1"]);
  assert.match(lines[18], /^\d+ successful steps$/);
  assert.match(lines[19], /^\d+ failed attempts$/);
  assert.match(lines[20], /^\d+ function evaluations$/);
  assert.deepEqual(lines.slice(21, 25), ["1", "1", "1", "1"]);
  assert.match(r.stderr, /ode45: at t = 1 the step size fell below its minimum/);
  assert.deepEqual(lines.slice(25), [
    "ode45: the Mass option is not supported in Sagebrush.",
    "ode45: the ODE function must return a vector of length 1 (as y0).",
    "ode45: the entries of tspan must be strictly increasing or strictly decreasing.",
    "odeset: unrecognized property name 'Bogus'.",
    "odeset: RelTol must be a positive scalar.",
  ]);
});

test("integral2 and integral3 reproduce their published examples by the iterated method, and refuse the tiled one", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "fun = @(x,y) 1./(sqrt(x+y).*(1+x+y).^2); fprintf('%.4f\\n', integral2(fun,0,1,0,@(x) 1 - x));",
    "polarfun = @(theta,r) fun(r.*cos(theta),r.*sin(theta)).*r; fprintf('%.4f\\n', integral2(polarfun,0,pi/2,0,@(theta) 1./(sin(theta)+cos(theta))));",
    "a = 3; b = 5; fprintf('%.15e\\n', integral2(@(x,y) a*x.^2+b*y.^2,0,5,-5,0,Method=\"iterated\",AbsoluteTolerance=0,RelativeTolerance=1e-10));",
    "fprintf('%.4f\\n', integral2(@(x,y) log(x^2+y^2),0,2,0,2,Vectorized=false));",
    "fprintf('%.4f\\n', integral3(@(x,y,z) y.*sin(x)+z.*cos(x),0,pi,0,1,-1,1));",
    "fprintf('%.4f\\n', integral3(@(x,y,z) x.*cos(y)+x.^2.*cos(z),-1,1,@(x)-sqrt(1-x.^2),@(x) sqrt(1-x.^2),@(x,y)-sqrt(1-x.^2-y.^2),@(x,y) sqrt(1-x.^2-y.^2)));",
    "try, integral2(@(x,y) x.*y,0,1,0,1,Method=\"tiled\"), catch e, disp(e.message), end",
    "try, integral2(@(x,y) x.*y,0,1,0,1,Waypoints={0.5, 0.5}), catch e, disp(e.message), end",
    "try, integral2(@(x,y) 1,0,1,0,1), catch e, disp(e.message), end",
    "try, integral3(@(x,y,z) x,0,1,0,1,0,1,'Bogus',1), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "0.2854", "0.2854", "1.666666666666667e+03", "2.6010", "2.0000", "0.7796",
    "integral2: the \"tiled\" method is not supported in Sagebrush; use \"iterated\" (which \"auto\" uses).",
    "integral2: Waypoints are not supported in Sagebrush.",
    "integral2: the integrand and limit functions must return arrays the size of their inputs; use array operators (.*, ./, .^) or set Vectorized to false.",
    "integral3: unknown option 'Bogus'.",
  ]);
});

test("integral2 and integral3 refuse complex integrands and limits, and a Method that is not text, before integrating", () => {
  const out = require("node:child_process").execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "try, integral2(@(x,y) (1+2i)*ones(size(x)), 0, 1, 0, 1), catch e, disp(e.message), end",
    "try, integral3(@(x,y,z) (1+2i)*ones(size(x)), 0, 1, 0, 1, 0, 1), catch e, disp(e.message), end",
    "try, integral2(@(x,y) (1+2i), 0, 1, 0, 1, 'Vectorized', false), catch e, disp(e.message), end",
    "try, integral3(@(x,y,z) (1+2i), 0, 1, 0, 1, 0, 1, 'Vectorized', false), catch e, disp(e.message), end",
    "try, integral2(@(x,y) x.*y, 0, 1, @(x) 1i*x, 1), catch e, disp(e.message), end",
    "try, integral2(@(x,y) x.*y, 0, 1, 0, 1, 'Method', 17), catch e, disp(e.message), end",
    "try, integral3(@(x,y,z) x, 0, 1, 0, 1, 0, 1, 'Method', 17), catch e, disp(e.message), end",
    "fprintf('%.15g %.15g\\n', integral2(@(x,y) x.*y, 0, 1, 0, @(x) x), integral3(@(x,y,z) x + y + z, 0, 1, 0, 1, 0, 1, 'Method', 'iterated'));",
  ].join("\n")], { encoding: "utf8" });
  const no = (s: string) => s + ": complex integrands and limits are not supported in Sagebrush.";
  assert.deepEqual(out.trim().split("\n"), [no("integral2"), no("integral3"), no("integral2"), no("integral3"), no("integral2"),
    'integral2: Method must be "auto", "tiled" or "iterated".', 'integral3: Method must be "auto", "tiled" or "iterated".', "0.125 1.5"]);
});

test("ode45 and ode23: OutputFcn in the solution-structure form too; deval only on the solution's own interval", () => {
  const r = require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (a stop request ends the integration whatever the outputs, with OutputSel too)
    "for solver = {@ode45, @ode23}",
    "  o = odeset('OutputFcn', @(t,y,flag) isempty(flag), 'MaxStep', .2);",
    "  s = solver{1}(@(t,y) 1, [0 2], 0, o); [t, y] = solver{1}(@(t,y) 1, [0 2], 0, o);",
    "  o2 = odeset(o, 'OutputSel', 2); s2 = solver{1}(@(t,y) [1; 2], [0 2], [0; 0], o2);",
    "  fprintf('%.12g %.12g %.12g\\n', s.x(end), t(end), s2.x(end));",
    "end",
    // (a terminal event inside a step: deval at, just inside, and beyond the end; forward and backward)
    "s = ode45(@(t,y) 1, [0 2], 0, odeset('Events', @(t,y) deal(t - .35, 1, 1), 'MaxStep', .2));",
    "fprintf('%.12g %.12g %.12g\\n', s.x(end), deval(s, .35), deval(s, .3499)); try, deval(s, .36), catch e, disp(e.message), end",
    "s = ode45(@(t,y) -1, [2 0], 2, odeset('Events', @(t,y) deal(t - 1.65, 1, 0), 'MaxStep', .2));",
    "fprintf('%.12g %.12g %.12g\\n', s.x(end), deval(s, 1.65), deval(s, 1.6501)); try, deval(s, 1.64), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "0.0001 0.0001 0.0001", "0.0001 0.0001 0.0001",
    "0.35 0.35 0.3499", "deval: the points must lie in the interval of integration, [sol.x(1) sol.x(end)].",
    "1.65 2.35 2.3499", "deval: the points must lie in the interval of integration, [sol.x(1) sol.x(end)].",
  ]);
});

test("quad stops at GNU Octave's adaptive Simpson limit, 10001 evaluations exactly, with a warning", () => {
  const r = require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "[q, n] = quad(@(x) sin(1000*x), 0, 1, 1e-14); disp(n);",
    "[q, n] = quad(@(x) 1./(x + 1e-12), 0, 1, 1e-14); disp(n);",
    "[q, n] = quad(@(x) exp(x), 0, 1); disp(n < 10001);",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(r.stdout.trim().split("\n").map((s: string) => s.trim()), ["10001", "10001", "1"]);
  assert.equal((r.stderr.match(/Warning: quad: the limit of 10001 function evaluations was reached; the tolerance may not be met\./g) || []).length, 2);
});

test("lsqnonneg keeps a solution of any scale: positivity tested exactly, as Lawson and Hanson's steps 6 to 11", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (a scaled identity: TolX grows with C, but x = 1e-8 is a solution, not a zero)
    "[x,r,res,e,o,l] = lsqnonneg(1e8*eye(2), ones(2,1)); fprintf('%.15g %.15g %.15g %d %.15g %.15g\\n', x, r, e, l);",
    // (mixed active and passive variables, at two scales: the same x, the duals scaled, optimality held)
    "[x,r,res,e,o,l] = lsqnonneg(eye(2), [1;-2]); fprintf('%.15g %.15g %.15g %d %.15g %.15g\\n', x, r, e, l);",
    "[x,r,res,e,o,l] = lsqnonneg(1e8*eye(2), 1e8*[1;-2]); fprintf('%.15g %.15g %.15g %d %.15g %.15g\\n', x, r, e, l);",
    "C = [0.0372 0.2869; 0.6861 0.7071; 0.6233 0.6245; 0.6344 0.6170]; d = [0.8587; 0.1781; 0.0747; 0.8405];",
    "[x1,r1] = lsqnonneg(C, d); [x2,r2,~,e2,~,l2] = lsqnonneg(1e-6*C, d);",
    "fprintf('%d %d %d\\n', abs(x2(2)*1e-6 - x1(2)) < 1e-12, abs(r2 - r1) < 1e-12, e2); disp(all(x2 >= 0) && all(l2 <= 1e-10) && abs(l2(2)) < 1e-10);",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), ["1e-08 1e-08 0 1 0 0", "1 0 4 1 0 -2", "1 0 4e+16 1 0 -2e+16", "1 1 1", "   1"]);
});

test("eigs: the page's output orders, k beyond n, failure treatment and flag, option structures, a Cholesky B, and the refusals", () => {
  const r = require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "n = 100; e = ones(n,1); T = spdiags([-e 2*e -e], -1:1, n, n);",
    "disp(mat2str(round(eigs(T, 3, 'smallestabs')' * 1e6) / 1e6));",
    "disp(mat2str(round(eigs(T, 3, 'smallestreal')' * 1e6) / 1e6));",
    "disp(mat2str(round(eigs(diag(1:10), 5, 'bothendsreal')')));",
    "R = [0 -5; 5 0]; C = blkdiag(R, 2*R, diag(1:20));",
    "disp(mat2str(round(imag(eigs(C, 3, 'bothendsimag', 'SubspaceDimension', 12))')));",
    "disp(mat2str(round(imag(eigs(C, 2, 'largestimag', 'SubspaceDimension', 12))')));",
    "disp(mat2str(size(eigs(diag(1:5), 9))));",
    "d = eigs(T, 6, 'largestabs', 'MaxIterations', 1, 'SubspaceDimension', 8); disp(mat2str(isnan(d')));",
    "[V, D, flag] = eigs(T, 6, 'largestabs', 'MaxIterations', 1, 'SubspaceDimension', 8); disp(flag);",
    "d = eigs(T, 6, 'largestabs', 'MaxIterations', 1, 'SubspaceDimension', 8, 'FailureTreatment', 'drop'); disp(numel(d) < 6);",
    "d = eigs(T, 6, 'largestabs', 'MaxIterations', 1, 'SubspaceDimension', 8, 'FailureTreatment', 'keep'); disp(any(isnan(d)));",
    "opts.tol = 1e-10; opts.p = 30; disp(round(eigs(T, 1, 'largestabs', opts) * 1e6) / 1e6);",
    "B = spdiags([e 4*e e], -1:1, n, n); Rb = chol(full(B)); d1 = eigs(T, B, 3); d2 = eigs(T, Rb, 3, 'largestabs', 'IsCholesky', true); disp(max(abs(d1 - d2)) < 1e-10);",
    "disp(class(eigs(single(diag(1:30)), 2)));",
    "try, eigs(T, 3, 'bogus'), catch err, disp(err.message), end",
    "try, eigs(T, 3, 'si'), catch err, disp(err.message), end",
    "try, eigs(T, 10, 'largestabs', 'SubspaceDimension', 10), catch err, disp(err.message), end",
    "try, eigs(T + 1i*speye(n), 3), catch err, disp(err.message), end",
    "try, eigs(diag(1:20), 3, 4), catch err, disp(err.message), end",
    "try, eigs(T, 3, 'largestabs', 'Tolerance', -1), catch err, disp(err.message), end",
    // (the smallest subspace the page allows, k+1 (Hermitian) or k+2: the vectors returned match the values)
    "[V,D,flag] = eigs(T,6,'largestabs','SubspaceDimension',7,'FailureTreatment','keep'); disp(max(abs(diag(V'*T*V) - diag(D))) < 1e-10);",
    "N = spdiags([(1:60)' ones(60,1) -ones(60,1)], [0 1 -1], 60, 60); [V,D,flag] = eigs(N,3,'largestabs','SubspaceDimension',5,'FailureTreatment','keep');",
    "r = 0; for j = 1:3, r = max(r, norm(N*V(:,j) - D(j,j)*V(:,j))); end, disp(r < 1e-6 || flag == 1);",
    "try, eigs(diag(1:10),2,'largestimag'), catch err, disp(err.message), end",
    // (shift-invert needs no inverse of B, which may then be singular; tiny but nonsingular A - sigma*B is fine)
    "disp(eigs(diag([1 2 3 4]), diag([1 1 0 0]), 1, 0.5, 'IsSymmetricDefinite', true));",
    "disp(mat2str(eigs(diag([1 2 3 4]*1e-100), 2, 0)' * 1e100, 6));",
    // (a repeated eigenvalue: V is still B-orthonormal)
    "Bm = [2 1 0;1 2 1;0 1 2]; [V,D] = eigs(3*Bm, Bm, 3); disp(max(max(abs(V'*Bm*V - eye(3)))) < 1e-12);",
    // (single precision from A, B, StartVector or Afun's result only)
    "disp(class(eigs(diag(1:30), single(2)))); disp(class(eigs(diag(1:30), 2, 'largestabs', 'StartVector', single(ones(30,1)))));",
    "disp(class(eigs(@(x) single(diag(1:30))*x, 30, 2)));",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(r.stdout.trim().split("\n").map((s: string) => s.trim()), [
    "[0.000967 0.003869 0.008701]", "[0.000967 0.003869 0.008701]", "[1 2 8 9 10]", "[10 -10 5]", "[10 5]", "[5 1]",
    "[true true true true true true]", "1", "1", "0", "3.9990", "1", "single",
    "eigs: unknown sigma 'bogus'.",
    "eigs: unknown sigma 'si' (for a real A, 'si' is not one of the page's names).",
    "eigs: SubspaceDimension must be at least k+1 (k+2 when the problem is not Hermitian).",
    "eigs: complex matrices, shifts and start vectors are not supported in Sagebrush.",
    "eigs: the shifted operator A - sigma*B is singular; sigma may not be an eigenvalue. Use a sigma near the eigenvalue instead.",
    "eigs: Tolerance must be a positive number.",
    "1", "1", "eigs: 'largestimag' is for nonsymmetric problems; a symmetric (Hermitian) problem's eigenvalues are real.",
    "1", "[1 2]", "1", "double", "single", "single",
  ]);
  // (the warning when not every value converged and flag is not asked for)
  assert.equal((r.stderr.match(/Warning: eigs: 0 of the 6 requested eigenvalues converged\./g) || []).length, 3);
});

test("eigs: a complex Afun refused; complex pairs through real solves; CholeskyPermutation; FailureTreatment's values", () => {
  const r = require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (an operator with complex results: refused, in the dense and the iterative paths, never a wrong answer)
    "try, eigs(@(x) 1i*x, 4, 1), catch err, disp(err.message), end",
    "try, eigs(@(x) 1i*x, 40, 1), catch err, disp(err.message), end",
    "disp(eigs(@(x) [2 0; 0 3]*x, 2, 1));",
    // (generalized and shift-invert problems with a complex pair: the real LU keeps the Ritz vectors' imaginary parts)
    "A = blkdiag([0 -5; 5 0], diag(1:25)); [V,D,f] = eigs(A, eye(27), 2, 'LI', 'SubspaceDimension', 26, 'MaxIterations', 3, 'Tolerance', 1e-8);",
    "disp(f); disp(mat2str(round(sort(imag(diag(D)))'))); disp(norm(A*V - V*D, 'fro') < 1e-6);",
    "A = blkdiag([0 -1; 1 0], diag(5:29)); [V,D,f] = eigs(A, 2, 'SM', 'MaxIterations', 3);",
    "disp(f); disp(mat2str(round(sort(imag(diag(D)))'))); disp(norm(A*V - V*D, 'fro') < 1e-10);",
    "fn = @(x) A \\ x; [V,D,f] = eigs(fn, 27, 2, 'SM', 'MaxIterations', 3); disp(f); disp(mat2str(round(sort(imag(diag(D)))')));",
    // (CholeskyPermutation p: R'*R = B(p, p); a nonidentity factor and permutation give B's eigenvalues)
    "disp(mat2str(eigs(diag(1:4), eye(4), 2, 'LM', 'IsCholesky', true, 'CholeskyPermutation', [2 1 3 4])'));",
    "Bm = [4 1 0 0; 1 3 1 0; 0 1 5 2; 0 0 2 6]; Am = diag([1 2 3 4]) + 0.1*ones(4); p = [3 1 4 2]; R = chol(Bm(p,p));",
    "disp(max(abs(eigs(Am, Bm, 2) - eigs(Am, R, 2, 'largestabs', 'IsCholesky', true, 'CholeskyPermutation', p))) < 1e-12);",
    "try, eigs(diag(1:4), eye(4), 2, 'smallestabs', 'IsCholesky', true, 'CholeskyPermutation', [2 1 3 4]), catch err, disp(err.message), end",
    "try, eigs(diag(1:4), eye(4), 2, 'LM', 'IsCholesky', true, 'CholeskyPermutation', [1 1 3 4]), catch err, disp(err.message), end",
    "try, eigs(diag(1:4), eye(4), 2, 'LM', 'CholeskyPermutation', [2 1 3 4]), catch err, disp(err.message), end",
    // (FailureTreatment: one of the three words, as a name-value pair or a field)
    "try, eigs(diag(1:5), 2, 'LM', 'FailureTreatment', 17), catch err, disp(err.message), end",
    "o.fail = 17; try, eigs(diag(1:5), 2, 'LM', o), catch err, disp(err.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(r.stderr, "");
  assert.deepEqual(r.stdout.trim().split("\n").map((s: string) => s.trim()), [
    "eigs: Afun returned complex values: complex operators are not supported in Sagebrush.",
    "eigs: Afun returned complex values: complex operators are not supported in Sagebrush.",
    "3",
    "0", "[-5 5]", "1",
    "0", "[-1 1]", "1",
    "0", "[-1 1]",
    "[4 3]",
    "1",
    "eigs: CholeskyPermutation cannot be used with 'smallestabs' or a numeric sigma, as the documentation says.",
    "eigs: CholeskyPermutation must be a permutation of 1:n.",
    "eigs: CholeskyPermutation is for IsCholesky true (B given as its Cholesky factor).",
    "eigs: FailureTreatment must be 'replacenan', 'keep' or 'drop'.",
    "eigs: FailureTreatment must be 'replacenan', 'keep' or 'drop'.",
  ]);
});

test("numgrid and delsq reproduce the published L-shaped grids, counts and nonzeros, and refuse the regions nothing pins", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "g = numgrid('L',10); disp(mat2str(g(2:9, 2:9)));",
    "G = numgrid('L',32); disp(sum(G(:)>0));",
    "A = delsq(numgrid('L',65)); disp(mat2str(size(A))); disp(nnz(A)); disp(issparse(A));",
    "disp(size(delsq(numgrid('L',12)), 1)); disp(nnz(delsq(numgrid('S',200))));",
    "disp(mat2str(full(delsq(numgrid('S',4)))));",
    "try, numgrid('C', 10), catch e, disp(e.message), end",
    "try, numgrid('Q', 10), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "[1 5 9 13 17 25 33 41;2 6 10 14 18 26 34 42;3 7 11 15 19 27 35 43;4 8 12 16 20 28 36 44;0 0 0 0 21 29 37 45;0 0 0 0 22 30 38 46;0 0 0 0 23 31 39 47;0 0 0 0 24 32 40 48]",
    "675", "[2945 2945]", "14473", "1", "75", "195228",
    "[4 -1 -1 0;-1 4 0 -1;-1 0 4 -1;0 -1 -1 4]",
    "numgrid: the region 'C' is not supported in Sagebrush (only 'S' and 'L').",
    "numgrid: unknown region 'Q'.",
  ]);
});

test("eig uses B, its options and the left eigenvectors as documented, and refuses what it cannot do", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (the page's examples: left eigenvectors, a generalized pair with complex eigenvalues)
    "A = [1 7 3; 2 9 12; 5 22 7]; [V,D,W] = eig(A); disp(mat2str(round(sort(diag(D))' * 1e4) / 1e4)); disp(max(max(abs(W'*A - D*W'))) < 1e-12);",
    "A = [1/sqrt(2) 0; 0 1]; B = [0 1; -1/sqrt(2) 0]; [V,D] = eig(A,B); disp(mat2str(round(imag(diag(D))'))); disp(max(max(abs(A*V - B*V*D))) < 1e-12);",
    "T = [2 -1 0; -1 2 -1; 0 -1 2]; Bs = [4 1 0; 1 4 1; 0 1 4]; [V, D, W] = eig(T, Bs); disp(max(max(abs(V'*Bs*V - eye(3)))) < 1e-12); disp(isequal(V, W));",
    "disp(mat2str(size(eig(T, 'matrix')))); [V, D] = eig(T, 'vector'); disp(mat2str(size(D)));",
    "try, eig(eye(2), [3 6; 4 8]), catch e, disp(e.message), end",
    "try, eig(eye(2), eye(2), 'qz'), catch e, disp(e.message), end",
    "try, eig([1 1i; 2 3]), catch e, disp(e.message), end",
    "try, eig(eye(2), 'bogus'), catch e, disp(e.message), end",
    "try, eig(eye(2), 'chol'), catch e, disp(e.message), end",
    "try, eig([1 NaN; 0 1]), catch e, disp(e.message), end",
    "try, eig([1 2;3 4],[1 1;1 1+1e-12]), catch e, disp(e.message), end",
    // (single inputs give single outputs; a symmetric but indefinite pencil's W is not V)
    "disp(class(eig(single([1 2;3 4])))); disp(class(eig(single([1 0;0 2]), single(eye(2)))));",
    "[V,D,W] = eig(single([1 2;3 4])); disp([class(V) ' ' class(D) ' ' class(W)]);",
    "[V,D,W] = eig([0 1;1 0],[1 0;0 -1]); disp(isequal(V,W)); disp(max(max(abs(W'*[0 1;1 0] - D*W'*[1 0;0 -1]))) < 1e-12);",
    // ("chol" is refused, not replaced by B \\ A, when A is not symmetric or B not positive definite)
    "try, eig([1 2; 3 4], eye(2), 'chol'), catch e, disp(e.message), end",
    "try, eig(eye(2), diag([1 -1]), 'chol'), catch e, disp(e.message), end",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), [
    "[-7.9759 -0.5789 25.5548]", "1", "[1 -1]", "1", "1", "1", "[3 3]", "[3 1]",
    "eig: B is singular, so the pencil may have infinite eigenvalues, which need the QZ algorithm; it is not supported in Sagebrush.",
    "eig: the QZ algorithm is not supported in Sagebrush.",
    "eig: complex matrices are not supported in Sagebrush.",
    "eig: invalid option 'bogus'.", "eig: invalid option 'chol'.",
    "eig: the input must not contain Inf or NaN.",
    "eig: B is badly conditioned (cond(B)*eps > 1e-8, Sagebrush's limit for solving through B \\ A), and the QZ algorithm it needs is not supported in Sagebrush.",
    "single", "single", "single single single", "0", "1",
    ...Array(2).fill("eig: the \"chol\" algorithm needs a symmetric A and a symmetric positive definite B; Sagebrush does not fall back to another algorithm when it is asked for."),
  ]);
});

test("psi, beta, betaln, erfcx, erfinv, erfcinv and expint keep their documented domains and Sagebrush's choices", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (values where Octave's are less accurate: mpmath's are 26.2094699605161, 15.0655747025926, 6.60158062235514)
    "fprintf('%.14g %.14g %.14g\\n', erfcinv(1e-300), erfcinv(1e-100), erfcinv(1e-20));",
    "fprintf('%.16g %.16g\\n', -psi(1), psi(1, 2));",
    // (the right-hand limits at 0, and psi(Inf), where Octave gives NaN and -0.5772)
    "disp([psi(0) psi(1, 0) psi(2, 0) psi(Inf) psi(1, Inf)]);",
    "try, psi(-1), catch e, disp(e.message), end",
    "try, psi(1i), catch e, disp(e.message), end",
    "try, psi(1.5, 2), catch e, disp(e.message), end",
    "try, psi([1 2], 2), catch e, disp(e.message), end",
    "try, psi(101, 2), catch e, disp(e.message), end",
    "try, beta(-1, 2), catch e, disp(e.message), end",
    "try, betaln(2, -0.5), catch e, disp(e.message), end",
    "try, beta([1 2], [1 2 3]), catch e, disp(e.message), end",
    "try, erfinv(0.5i), catch e, disp(e.message), end",
    "try, erfcx(int8(3)), catch e, disp(e.message), end",
    "disp(class(expint(single(2)))); disp(isreal(expint(2))); disp(isreal(expint(-2)));",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim().replace(/\s+/g, " ")), [
    "26.209469960516 15.065574702593 6.6015806223551",
    "0.5772156649015329 0.6449340668482264",
    "-Inf Inf -Inf Inf 0",
    "psi: X must be real and nonnegative.",
    "psi: X must be real and nonnegative.",
    "psi: k must be a nonnegative integer scalar.",
    "psi: k must be a nonnegative integer scalar.",
    "psi: Sagebrush covers k <= 100.",
    "beta: Z must be real and nonnegative.",
    "betaln: W must be real and nonnegative.",
    "beta: Z and W must be the same size, or one of them a scalar.",
    "erfinv: x must be real.",
    "Undefined function 'erfcx' for input arguments of type 'int8'.",
    "single", "1", "0",
  ]);
});

test("ellipke, ellipj and legendre keep their documented domains", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    // (a high order next to 1, where Octave's value is less accurate: mpmath's is 4.83973510425242e-18)
    "Q = legendre(12, 0.999999); fprintf('%.14g\\n', Q(11));",
    "[K, E] = ellipke(1); disp([K E]);",
    "try, ellipke(-0.1), catch e, disp(e.message), end",
    "try, ellipke(2), catch e, disp(e.message), end",
    "try, ellipke(0.5, -1), catch e, disp(e.message), end",
    "try, ellipj(1, 1.5), catch e, disp(e.message), end",
    "try, ellipj(1i, 0.5), catch e, disp(e.message), end",
    "try, ellipj([1 2], [0.1 0.2 0.3]), catch e, disp(e.message), end",
    "try, legendre(2, 1.5), catch e, disp(e.message), end",
    "try, legendre(-1, 0.5), catch e, disp(e.message), end",
    "try, legendre(1.5, 0.5), catch e, disp(e.message), end",
    "try, legendre(2, 0.5, 'bogus'), catch e, disp(e.message), end",
    "try, ellipj(Inf, 0.5), catch e, disp(e.message), end",
    "disp(class(legendre(2, single(0.3)))); [s, c, d] = ellipj(single(1), 0.5); disp(class(d));",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim().replace(/\s+/g, " ")), [
    "4.8397351042524e-18",
    "Inf 1",
    "ellipke: M must be in the range 0 <= M <= 1.",
    "ellipke: M must be in the range 0 <= M <= 1.",
    "ellipke: tol must be a nonnegative real scalar.",
    "ellipj: M must be in the range 0 <= M <= 1.",
    "ellipj: U must be real.",
    "ellipj: U and M must be the same size, or one of them a scalar.",
    "legendre: X must be real and in the range -1 <= X <= 1.",
    "legendre: n must be a nonnegative integer scalar.",
    "legendre: n must be a nonnegative integer scalar.",
    "legendre: normalization must be 'unnorm', 'sch' or 'norm'.",
    "ellipj: U must be finite in Sagebrush.",
    "single", "single",
  ]);
});

test("a legend in 3-D axes is drawn: surfaces' swatches (colormapped at the middle of CLim), lines, markers, stems", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = [
    // (the colormap's middle color: row floor(m / 2) + 1 of m)
    // (close all: the session's figures are those earlier tests left)
    "close all; surf(peaks(20)); legend('peaks'); cm = colormap; fprintf('#%02x%02x%02x %d\\n', round(cm(floor(size(cm, 1) / 2) + 1, :) * 255), size(cm, 1))",
    "mesh(peaks(20)); legend('m')",
    "surf(peaks(5)); shading interp; legend('i')",
    "surf(peaks(5), 'FaceColor', 'r'); hold on; t = 0:0.1:5; plot3(t, t, t, 'k--'); scatter3([1 2], [1 2], [1 2], 'filled');\n" +
      "stem3([1 2], [2 1], [3 4]); legend('surface', 'line', 'points', 'stems', 'Location', 'northwest'); hold off",
    "plot3(1:3, 1:3, 1:3); legend('a'); legend('off')",
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  const legend = (id: number) => {
    const svg = msgs.find((m) => m.id === id && m.display)?.display["image/svg+xml"] ?? "";
    return svg.match(/<g class="sb-legend">.*?<\/g>/)?.[0] ?? null;
  };
  const swatch = (id: number) => legend(id)?.match(/<rect x="[^"]*" y="[^"]*" width="22" height="10"([^/]*)\/>/)?.[1].trim();
  const [mid, rows] = msgs.filter((m) => m.id === 1 && m.stream === "stdout").map((m) => m.text).join("").trim().split(" ");
  assert.match(mid, /^#[0-9a-f]{6}$/);
  assert.equal(rows, "256");
  assert.equal(swatch(1), `fill="${mid}" stroke="#000000" stroke-width="1"`);
  assert.match(legend(1)!, />peaks<\/text>/);
  assert.equal(swatch(2), `fill="#ffffff" stroke="${mid}" stroke-width="1"`);
  assert.equal(swatch(3), `fill="${mid}"`);
  const four = legend(4)!;
  assert.deepEqual([...four.matchAll(/>([a-z]+)<\/text>/g)].map((m) => m[1]), ["surface", "line", "points", "stems"]);
  assert.match(four, /<rect x="27" y="28" width="22" height="10" fill="#ff0000" stroke="#000000"/);
  assert.match(four, /stroke="#000000" stroke-width="[\d.]+" stroke-dasharray/);
  assert.equal((four.match(/<circle /g) ?? []).length, 2);
  assert.equal(legend(5), null);
});

test("titles are bold by default (TitleFontWeight), subtitles not, on a line under the title; title(t, s)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = [
    // (close all: the session's figures are those earlier tests left)
    "close all; plot(1:3); title('Two'); disp(get(get(gca, 'Title'), 'FontWeight')); disp(get(get(gca, 'Subtitle'), 'FontWeight'))",
    "surf(peaks(5)); title('Three')",
    "plot(1:3); title('Main'); subtitle('Sub')",
    "plot(1:3); title('Plain', 'FontWeight', 'normal')",
    "plot(1:3); subtitle('Only')",
    "plot(1:3); [t, s] = title('Top', 'Below', 'Color', 'r'); disp(t.String), disp(s.String), disp(t.Color), disp(s.Color)",
    "plot(1:3); title('Top')",
    "xlabel('a', 'b')",
    "surf(peaks(5)); title('Top', 'Below')",
    "surf(peaks(5)); [t, s] = title('Top', 'Below'); s.FontWeight = 'bold';",
    // (plain cla keeps the title's formatting; cla reset and a new plot reset it)
    "plot(1:3); t = title('Old', 'Color', 'r'); cla; disp(t.Color); cla reset; disp(t.Color); try, cla('again'), catch e, disp(e.message), end",
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  const title = (id: number) => {
    const svg = msgs.find((m) => m.id === id && m.display)?.display["image/svg+xml"] ?? "";
    return svg.match(/<text [^>]*text-anchor="middle" font-size="[^"]*"[^>]*>(?:(?!<\/text>).)*<\/text>/g)?.find((t: string) => !/rotate/.test(t))
      ?.replace(/^<text [^>]*?font-size="[^"]*"/, "<text");
  };
  assert.equal(msgs.filter((m) => m.id === 1 && m.stream === "stdout").map((m) => m.text).join(""), "bold\nnormal\n");
  assert.equal(title(1), '<text font-weight="bold">Two</text>');
  assert.equal(title(2), '<text font-weight="bold">Three</text>');
  // (the subtitle: a second line, under the title, which stays where it was; the axes one line shorter)
  const texts = (id: number) => {
    const svg = msgs.find((m) => m.id === id && m.display)?.display["image/svg+xml"] ?? "";
    return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="middle"[^>]*>([A-Za-z]+)<\/text>/g)].map((m) => [m[3], +m[2]]);
  };
  const [[t3, y3], [s3, ys3]] = texts(3);
  assert.deepEqual([t3, s3, ys3 > y3], ["Main", "Sub", true]);
  assert.equal(texts(7)[0][1], y3);
  assert.equal(title(3), '<text font-weight="bold">Main</text>');
  assert.match(msgs.find((m) => m.id === 3 && m.display).display["image/svg+xml"], /<text x="[\d.]+" y="[\d.]+" text-anchor="middle" font-size="[\d.]+">Sub<\/text>/);
  // (title(titletext, subtitletext, Name, Value): the properties are both lines', as the documented example's Color)
  assert.equal(msgs.filter((m) => m.id === 6 && m.stream === "stdout").map((m) => m.text).join(""), "Top\nBelow\n     1     0     0\n     1     0     0\n");
  assert.deepEqual(texts(6).map((t) => t[0]), ["Top", "Below"]);
  assert.match(msgs.filter((m) => m.id === 8 && m.stream === "stderr").map((m) => m.text).join(""), /Too many input arguments/);
  // (the interactive 3-D view: the subtitle a line of its own too; a new plot's title is bold
  // again, the axes reset as NextPlot 'replace' says)
  const scene = JSON.parse(msgs.find((m) => m.id === 9 && m.display).display["application/vnd.sagebrush.scene3d+json"]);
  assert.deepEqual([scene.title, scene.subtitle, scene.title_weight, scene.subtitle_weight], ["Top", "Below", "bold", "normal"]);
  const bolder = JSON.parse(msgs.find((m) => m.id === 10 && m.display).display["application/vnd.sagebrush.scene3d+json"]);
  assert.equal(bolder.subtitle_weight, "bold");
  assert.equal(msgs.filter((m) => m.id === 11 && m.stream).map((m) => m.text).join(""), "     1     0     0\n     0     0     0\ncla: the only option is 'reset'.\n");
  assert.equal(title(4), "<text>Plain</text>");
  assert.equal(title(5), "<text>Only</text>");
});

test("a newline in a struct's text field or a string array's element is displayed as ↵, as MATLAB's published displays show it", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "err = struct('message', sprintf('Error using average>check_inputs (line 11)\\nInput must be a vector.'), 'identifier', 'AVG:NotAVector')",
    "s = struct('n', \"x\" + newline)",
    "t = [\"This is line one.\" + newline; \"Here is line two.\" + newline]",
    // (a missing string in a struct: <missing>, as in a string array)
    "m = [\"a\", \"b\"]; m(4) = \"x\"; v = struct('a', m(3))",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.split("\n").filter((s: string) => s.trim() !== "" && !/=|with fields|string array/.test(s)), [
    "       message: 'Error using average>check_inputs (line 11)↵Input must be a vector.'",
    "    identifier: 'AVG:NotAVector'",
    "    n: \"x↵\"",
    "    \"This is line one.↵\"",
    "    \"Here is line two.↵\"",
    "    a: <missing>",
  ]);
});

test("clear: a cleared variable's name is the function again at the top level; in a function, clear undefines the names", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "upper = 7; clear; disp(upper('abc'))",
    "lower = 3; clear lower; disp(lower('XY'))",
    "max = [5 9 2]; disp(max(2)); clearvars max; disp(max([5 9 2]))",
    "try, clear; disp(nosuchthing), catch e, disp(e.message), end",
    "disp(f1()); disp(f2()); disp(f3())",
    "try, f4(), catch e, disp(e.message), end",
    // (an anonymous function's parameters are its own, even where a workspace variable has the name)
    "x = 5; g = @(x) x + 1; h = @(v) v(2); disp(g(2)); disp(h([4 5])); clear x; disp(g(3))",
    "function r = f1()\n a = 1; b = 2;\n clear a\n a = 10;\n r = a + b;\nend",
    "function r = f2()\n a = 5;\n clear\n r = exist('a', 'var');\nend",
    "function r = f3()\n abc = 1; xyz = 3;\n clear ab*\n r = xyz;\nend",
    "function f4()\n upper = 7;\n clear upper\n upper('fn')\nend",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((l: string) => l.trim()), [
    "ABC", "xy", "9", "9", "Unrecognized function or variable 'nosuchthing'.", "12", "0", "3",
    // (static resolution in a function: once cleared, upper is an undefined variable, not 7)
    "Unrecognized function or variable 'upper'.",
    "3", "5", "4",
  ]);
});

test("clear in a function: a variable named like an ItemType is the one cleared; clearvars' arguments are always names (CORR-8398-1)", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "disp(mat2str([f5() f6() f7() f8() f9() f10()]))",
    "function r = f5()\n a = 5; all = 9;\n clear all\n r = [exist('a', 'var') exist('all', 'var')];\nend",
    "function r = f6()\n a = 5;\n clear all\n r = exist('a', 'var');\nend",
    "function r = f7()\n a = 5;\n clearvars all\n r = exist('a', 'var');\nend",
    "function r = f8()\n a = 5; variables = 1;\n clear variables\n r = [exist('a', 'var') exist('variables', 'var')];\nend",
    "function r = f9()\n a = 5;\n clear functions\n r = exist('a', 'var');\nend",
    // (all is assigned only on a path not taken: at the clear it doesn't exist, so the keyword)
    "function r = f10()\n a = 5;\n if false, all = 1; end\n clear all\n r = exist('a', 'var');\nend",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(out.trim(), "[1 0 0 1 1 0 1 0]");
});

test("clear and clearvars at the top level look exact names up directly: 3000 names against 3000 variables is quick (HARD-282-1)", () => {
  const { execFileSync } = require("node:child_process");
  const code = [
    // (3000 variables v1 .. v3000, through a MAT-file: a structure's fields saved as variables, then loaded)
    "names = arrayfun(@(k) sprintf('v%d', k), 1:3000, 'UniformOutput', false);",
    "S = cell2struct(num2cell(1:3000), names, 2); f = [tempname '.mat']; save(f, '-struct', 'S'); clear S; load(f); delete(f)",
    "missing = arrayfun(@(k) sprintf('w%d', k), 1:3000, 'UniformOutput', false);",
    "keep1 = 1; v_keep = 2;",
    "clearvars(names{1:1500}); clear(names{1501:end}, missing{:})",
    "disp([exist('v1', 'var') exist('v3000', 'var') exist('keep1', 'var') exist('v_keep', 'var')])",
    "clear v_k* keep?",
    "disp([exist('keep1', 'var') exist('v_keep', 'var')])",
  ].join("\n");
  const t0 = Date.now();
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code], { encoding: "utf8", timeout: 60000 });
  const ms = Date.now() - t0;
  assert.deepEqual(out.trim().split("\n").map((l: string) => l.trim().split(/\s+/).join(" ")), ["0 0 1 1", "0 0"]);
  // (before: 3000 names took over 30 s; the eval loop that makes the variables is most of this)
  assert.ok(ms < 20000, `${ms} ms`);
});

test("cells and structures: orderfields takes only a permutation, cellfun and arrayfun equal sizes, cell2struct keeps the other dimensions, structfun a scalar structure (CSTRUCT-1016-1..4)", () => {
  const { execFileSync } = require("node:child_process");
  const run = (code: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code],
    { encoding: "utf8" }).split("\n").map((s: string) => s.trimEnd()).filter((s: string) => s !== "");
  const tryIt = (e: string) => `try, ${e}; disp('ran'), catch, disp('refused'), end`;
  const s = "struct('oak',2,'elm',5)";
  // (orderfields: an order that drops, repeats or invents a field is refused)
  assert.deepEqual(run([`[1]`, `[1 1]`, `[0 1]`, `[1.5 2]`, `{'elm'}`, `{'elm','elm'}`, `struct('elm',1)`].map((o) => tryIt(`orderfields(${s}, ${o})`)).join("\n")),
    Array(7).fill("refused"));
  assert.deepEqual(run(`disp(strjoin(fieldnames(orderfields(${s}, [2 1]))', ' ')); disp(strjoin(fieldnames(orderfields(${s}, {'elm','oak'}))', ' ')); disp(strjoin(fieldnames(orderfields(${s}, struct('elm',0,'oak',0)))', ' '))`),
    ["elm oak", "elm oak", "elm oak"]);
  // (cellfun and arrayfun: a row and a column of two are different sizes)
  assert.deepEqual(run([tryIt("cellfun(@plus, {2,5}, {7;11})"), tryIt("arrayfun(@plus, [2 5], [7;11])"),
    "disp(mat2str(cellfun(@plus, {2;5}, {7;11}))); disp(mat2str(arrayfun(@plus, [2 5], [7 11])))"].join("\n")),
    ["refused", "refused", "[9;16]", "[9 16]"]);
  // (cell2struct: the structure array has the cell array's other dimensions)
  assert.deepEqual(run([
    "C = reshape(num2cell(1:12), [2 3 2]);",
    "S = cell2struct(C, {'oak','elm'}, 1); disp(mat2str(size(S))); disp(mat2str([S(:).oak; S(:).elm]))",
    "S = cell2struct(C, {'a','b','c'}, 2); disp(mat2str(size(S))); disp(mat2str([S(:).a; S(:).b; S(:).c]))",
    "S = cell2struct(C, {'p','q'}, 3); disp(mat2str(size(S))); disp(mat2str([S(:).p; S(:).q]))",
    "S = cell2struct({1 2; 3 4}, {'u','v'}, 2); disp(mat2str(size(S))); disp(mat2str([S.u; S.v]))",
    tryIt("cell2struct({2 5;7 11}, {'oak','elm'}, 0)"), tryIt("cell2struct({2 5;7 11}, {'oak','elm','ash'}, 1)"),
  ].join("\n")), [
    "[3 2]", "[1 3 5 7 9 11;2 4 6 8 10 12]",
    "[2 2]", "[1 2 7 8;3 4 9 10;5 6 11 12]",
    "[2 3]", "[1 2 3 4 5 6;7 8 9 10 11 12]",
    "[2 1]", "[1 3;2 4]",
    "refused", "refused",
  ]);
  // (structfun: a structure array is refused; several outputs, each a structure)
  assert.deepEqual(run([tryIt("structfun(@numel, struct('x', {2, [7 11]}))"),
    "[a, b] = structfun(@(x) deal(x, x + 1), struct('oak', 2, 'elm', 5), 'UniformOutput', false); disp(mat2str([a.oak a.elm b.oak b.elm]))",
    "[m, n] = structfun(@size, struct('p', [1 2 3], 'q', [4; 5])); disp(mat2str([m n]))"].join("\n")),
    ["refused", "[2 5 3 6]", "[1 3;2 1]"]);
});

test("statistics as documented: moving windows padded by 'Endpoints', quantile in p's orientation, complex median by magnitude (astra2's STAT-1016-1..3)", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", [
    "x = [2 7 1 8 3];",
    // (the padded windows [0 2 7] and [8 3 0]; [2 2 7] and [8 3 2])
    "fprintf('%.6g ', movmean(x, 3, 'Endpoints', 0)); fprintf('\\n');",
    "f = {@movmean, @movmedian, @movmax, @movsum, @movprod, @movvar, @movstd};",
    "for k = 1:numel(f), y = f{k}(x, 3, 'Endpoints', 2); fprintf('%.6g %.6g|', y(1), y(end)); end; fprintf('\\n');",
    "y = movmin(x, 3, 'Endpoints', 99); fprintf('%g %g\\n', y(1), y(end));",
    "fprintf('%.6g ', movmean(x, 3, 'Endpoints', 'fill'), movmean(x, 3, 'Endpoints', 'fill', 'omitnan')); fprintf('\\n');",
    "fprintf('%g ', movsum([1 2; 3 4; 5 6], 2, 'Endpoints', true)); fprintf('\\n');",
    "fprintf('%d %d|', size(quantile([2 4 8], [0.25; 0.75])), size(quantile([2; 4; 8], [0.25 0.75])), size(prctile([2 4 8], [25; 75])), size(prctile([2; 4; 8], [25 75])), size(quantile(9, [0 0.5 1]))); fprintf('\\n');",
    "fprintf('%g ', quantile([1 2; 3 4; 5 6], [0.25 0.75])); fprintf('\\n');",
    "m = [median([1+2i 3-1i -2+4i]), median([1+2i 3-1i -2+4i 4]), median([1i -1i 1 -1 2]), median([1+2i NaN 3-1i], 'omitnan')];",
    "fprintf('%g%+gi ', [real(m); imag(m)]); fprintf('\\n');",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((l: string) => l.trim()), [
    "3 3.33333 5.33333 4 3.66667",
    "3.66667 4.33333|2 3|7 8|11 13|28 48|8.33333 10.3333|2.88675 3.21455|",
    "2 3",
    "NaN 3.33333 5.33333 4 NaN 4.5 3.33333 5.33333 4 5.5",
    "2 4 8 3 6 10",
    "2 1|1 2|2 1|1 2|1 3|",
    "1.5 4.5 2.5 5.5",
    // (sort's order for complex numbers: by magnitude, then phase angle)
    "3-1i 3.5-0.5i 0+1i 2+0.5i",
  ]);
});

test("moving statistics with a fill take the window's outside positions as the fill, no padded copy: as quick as 'shrink' (HARD-755-1)", () => {
  const { execFileSync } = require("node:child_process");
  const t0 = Date.now();
  // (one 1 and 10000 filled zeros: the mean 1/10001; the sum 1; the max 1; with a NaN fill and omitnan, 1)
  const out = execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c",
    "fprintf('%.12g %.12g %.12g %.12g\\n', movmean(1, [5000 5000], 'Endpoints', 0), movsum(2, [5000 5000], 'Endpoints', 0), movmax(-1, [5000 5000], 'Endpoints', 0), movmean(1, [5000 5000], 'Endpoints', 'fill', 'omitnan'))"],
    { encoding: "utf8", timeout: 60000 });
  const ms = Date.now() - t0;
  assert.equal(out.trim(), "9.99900009999e-05 2 0 1");
  assert.ok(ms < 15000, `${ms} ms`);
});

test("clearvars -except and -regexp, and clear with patterns or computed names in a function; globals and persistents there refused", () => {
  const { execFileSync } = require("node:child_process");
  const run = (code: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code],
    { encoding: "utf8" }).split("\n").map((s: string) => s.trimEnd()).filter((s: string) => s !== "");
  const ex = (ns: string) => `disp(mat2str([${ns.split(" ").map((n) => `exist('${n}', 'var')`).join(" ")}]))`;
  const tryIt = (e: string) => `try, ${e}; disp('ran'), catch, disp('refused'), end`;
  assert.deepEqual(run([
    // (top level: -except keeps what it names, exactly or by wildcard; function syntax too)
    "p = 1; q = 2; clearvars -except p", ex("p q"),
    "p = 1; px = 2; q = 3; clearvars p* -except px", ex("p px q"),
    "p = 1; q = 2; r = 3; clearvars('-except', 'q', 'r')", ex("p q r"),
    "kA = 1; kB = 2; m1 = 3; clearvars -regexp ^k -except kB", ex("kA kB m1"),
    "s1 = 1; s22 = 2; clear -regexp ^s\\d$", ex("s1 s22"),
    // (a variable named like clear's words: clearvars all is the variable; clear all too when it exists)
    "all = 9; a = 5; clearvars all", ex("a all"),
    "all = 9; a = 5; clear all", ex("a all"),
    "disp(mat2str([f1() f2() f3()]))",
    "function r = f1()\n abc = 5; xyz = 7;\n clear ab*\n r = [exist('abc', 'var') xyz];\nend",
    "function r = f2()\n a = 5; b = 7; n = 'a';\n clear(n)\n r = [exist('a', 'var') b];\nend",
    "function r = f3()\n a = 1; b = 2; c = 3;\n clearvars -except b\n r = [exist('a', 'var') exist('b', 'var') exist('c', 'var')];\nend",
  ].join("\n")), ["[1 0]", "[0 1 1]", "[0 1 1]", "[0 1 1]", "[0 1]", "[1 0]", "[1 0]", "[0 7 0 7 0 1 0]"]);
  // (refused, not done wrongly: a function's global or persistent, and options Sagebrush doesn't have)
  assert.deepEqual(run([
    tryIt("g1()"), tryIt("g2()"), tryIt("g3()"), tryIt("clearvars -global x"), tryIt("clear -bogus x"),
    // (clear global in a function with its own global: refused, in each form)
    tryIt("g4()"), tryIt("g5()"), tryIt("g6()"),
    // (a -regexp that could backtrack exponentially, here on a 31-character name, is refused, not run)
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab = 1;", tryIt("clear -regexp ^(a+)+$"), tryIt("clearvars -except -regexp (a|aa)*b"),
    // (a sequence's weight is the product of its repetitions' lengths, an alternation's the sum of
    // its branches': past 10^5, refused, whether unbounded, optional, bounded, or alternation groups)
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = 2;",
    tryIt("clear -regexp ^a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b$"), tryIt("clear -regexp a*a*a*a*"), tryIt("clear -regexp a*a*a*b"),
    tryIt("clear -regexp ^" + "a?".repeat(50) + "b$"), tryIt("clear('-regexp', '" + "a{0,31}".repeat(8) + "b')"),
    tryIt("clear -regexp " + "(a|b)".repeat(19) + "c"),
    "function g4()\n global G\n G = 7;\n clear global\nend",
    "function g5()\n global G\n G = 7;\n clear('global')\nend",
    "function g6()\n global G\n G = 7; n = 'global';\n clear(n)\nend",
    "function g1()\n global G\n G = 7;\n clear G\nend",
    "function g2()\n persistent P\n P = 7;\n clear\nend",
    "function g3()\n global G\n G = 1; ab = 2;\n clear a* G*\nend",
  ].join("\n")), Array(16).fill("refused"));
  // (up to the bound they're allowed, and quick even against a 63-character name that doesn't match;
  // simple selectors are far below it)
  const t0 = Date.now();
  assert.deepEqual(run(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = 1; q = 2;",
    "clear('-regexp', 'a*a*b', '" + "a?".repeat(16) + "b', '" + "a{0,31}".repeat(3) + "b', '(ab)+c', '^Mon\\d{3}$', '^q$')",
    "disp(mat2str([exist('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'var') exist('q', 'var')]))"].join("\n")), ["[1 0]"]);
  assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
  // (the expressions' weights times the workspace's names count against 4,000,000, -except's
  // with the targets': half the expressions run, all of them, or split by -except, are refused)
  const half = "p = repmat({'a*a*b'}, 1, 200); x1 = 1; x2 = 2;";
  assert.deepEqual(run([
    half, tryIt("clearvars('-regexp', p{:})"),
    half, tryIt("clearvars('-regexp', p{:}, p{:})"),
    half, tryIt("clearvars('-regexp', p{:}, '-except', '-regexp', p{:})"),
  ].join("\n")), ["ran", "refused", "refused"]);
  // (clear global in a function without globals of its own: the global store is cleared)
  assert.deepEqual(run([
    "global H\nH = 7; zap(); disp(readback())",
    "function zap()\n clear global\nend",
    "function r = readback()\n global H\n r = isempty(H);\nend",
  ].join("\n")), ["   1"]);
});

test("command syntax: a comma or semicolon inside a word's brackets is refused, pointing to function syntax; brackets without one stay text", () => {
  for (const code of ["clear -regexp a{0,31}", "clear -regexp ^x(1,2)$", "clear -regexp a[;]b"]) {
    assert.throws(() => matlabToPython(code), (e: any) => e instanceof MatlabSyntaxError && /use function syntax/.test(e.message), code);
  }
  assert.doesNotThrow(() => matlabToPython("clear -regexp a{2}b ^x(1)$, y = 1;"));
  assert.doesNotThrow(() => matlabToPython("disp 'a{0,31}'"));
});

test("coverage wrongs: exact int64 literals, std/var flags, integer classes kept, strfind's [], NaN in ismember and unique, c{:} displayed", () => {
  const { execFileSync } = require("node:child_process");
  const run = (code: string) => execFileSync(process.execPath, [require("node:path").join(__dirname, "..", "src", "cli.js"), "--matlab", "-c", code],
    { encoding: "utf8" }).split("\n").map((s: string) => s.trimEnd()).filter((s: string) => s !== "");
  const tryIt = (e: string) => `try, ${e}; disp('ran'), catch, disp('refused'), end`;
  assert.deepEqual(run([
    // (int64/uint64 of an integer literal: its exact value, not the nearest double's; 2^53 + 1 is odd)
    // (an integer literal's exact value up to 2^53, where Sagebrush's 64-bit integers stop
    // being exact: beyond it, refused rather than rounded, decimal or hex)
    "fprintf('%d %d\\n', int64(9007199254740992) == 2^53, mod(int64(-9007199254740991), int64(2)))",
    tryIt("int64(9007199254740993)"), tryIt("uint64(18446744073709551615)"), tryIt("x = 0x20000000000001s64"),
    // (std and var with only a flag: the flag is not the weight)
    "fprintf('%.4f ', std([2 NaN; NaN 3; 4 5], 'omitmissing'), std([7; NaN], 'omitnan'), var([NaN 1 3], 'omitnan')); fprintf('\\n')",
    // (median, factorial, nchoosek and primes keep an integer class)
    "m = median(int16([10 20 31 40])); fprintf('%s %d\\n', class(m), m); m = median(uint8([1 2])); fprintf('%s %d\\n', class(m), m)",
    "f = factorial(uint8([3 6])); fprintf('%s %d %d\\n', class(f), f)",
    "c = nchoosek(uint8([4 7 9]), 2); fprintf('%s %s\\n', class(c), mat2str(double(c)))",
    "p = primes(int32(10)); fprintf('%s %s\\n', class(p), mat2str(double(p)))",
    // (strfind with no match: [])
    "disp(mat2str(size(strfind('abc', 'z')))); disp(strfind('abc', 'b'))",
    // (NaN is never a member; unique keeps each NaN unless TreatMissingAsDistinct is false)
    "[tf, loc] = ismember([NaN 2 NaN], [2 NaN]); disp(mat2str(tf)); disp(mat2str(loc))",
    "disp(mat2str(unique([3 NaN 1 NaN]))); [u, ia, ic] = unique([3 NaN 1 NaN], 'TreatMissingAsDistinct', false); disp(mat2str(u)); disp(mat2str(ia')); disp(mat2str(ic'))",
    tryIt("unique([1 2], 'bogus')"),
    // (c{:} alone: each element displayed as ans)
    "c = {7, 'two'}; c{:}",
    "c{2:-1:1};", "disp(ans)",
  ].join("\n")), [
    "1 1", "refused", "refused", "refused",
    "1.4142 1.4142 0.0000 2.0000",
    "int16 26", "uint8 2",
    "uint8 6 255",
    "uint8 [4 7;4 9;7 9]",
    "int32 [2 3 5 7]",
    "[0 0]", "     2",
    "[false true false]", "[0 1 0]",
    "[1 3 NaN NaN]", "[1 3 NaN]", "[3 1 2]", "[2 3 1 3]",
    "refused",
    "ans =", "     7", "ans =", "    'two'",
    "     7",
  ]);
});
