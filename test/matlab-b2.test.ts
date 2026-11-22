import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB functions and behaviors from the numeric track's findings: var of a logical, an if on a complex value,
// sinpi, cospi, reallog, realsqrt, num2hex, bsxfun, compose, readmatrix, binary fread and fwrite, containers.Map,
// sort's 'ComparisonMethod' 'real' on a complex matrix, num2str and mat2str of -0, and interp1's message. Values as
// an observed MATLAB run (R2026b, 2026-11-21) or MATLAB's documentation gives them.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-b2-"));
  writeFileSync(join(dir, "main.m"), src);
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status, dir };
}

test("var of a logical, an if on a complex value, num2str and mat2str of -0, interp1's duplicate points: MATLAB's", () => {
  const r = run([
    "fprintf('%.4f\\n', var([true false true true]))",
    "try, if [1+1i 2+2i], end, catch e, disp(e.identifier), disp(e.message), end",
    "if complex(1, 0), disp('a zero imaginary part decides by the real part'), end",
    "disp(num2str(-0, 17)), disp(mat2str(-0)), disp(mat2str([-0 1]))",
    "try, interp1([1 1 2], [1 2 3], 1.5), catch e, disp(e.identifier), disp(e.message), end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "0.2500\nMATLAB:nologicalcomplex\nComplex values cannot be converted to logicals.\n" +
    "a zero imaginary part decides by the real part\n0\n0\n[0 1]\n" +
    "MATLAB:griddedInterpolant:NonUniqueCompVecsPtsErrId\nSample points must be unique.\n");
});

test("sinpi, cospi, reallog and realsqrt: exact at the integers and half-integers, signed zeros, MATLAB's errors", () => {
  const r = run([
    "fprintf('%g ', 1 ./ sinpi([-0 0 2 -2]), sinpi([0.5 -0.5 2.5 1/6 Inf])), fprintf('\\n')",
    "fprintf('%g ', cospi([0 1 2 1/3 Inf]), 1 ./ cospi([0.5 1.5 -0.5])), fprintf('\\n')",
    "disp(class(sinpi(single(0.25))))",
    "fprintf('%g ', reallog([1 exp(2) 0]), realsqrt([4 0]), 1 / realsqrt(-0)), fprintf('\\n')",
    "try, reallog(-Inf), catch e, disp(e.identifier), end",
    "try, realsqrt([1 -4]), catch e, disp(e.identifier), end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "-Inf Inf Inf -Inf 1 -1 1 0.5 NaN \n1 -1 1 0.5 NaN Inf Inf Inf \nsingle\n0 2 -Inf 2 0 -Inf \n" +
    "MATLAB:reallog:complexResult\nMATLAB:realsqrt:complexResult\n");
});

test("num2hex, bsxfun and compose as their pages show them", () => {
  const r = run([
    "disp(num2hex([1 -2.5])), disp(num2hex(single(1)))",
    "disp(bsxfun(@minus, [1 2 3], [1; 2]))",
    "try, bsxfun(@plus, [1 2], [1 2 3]), catch e, disp(e.identifier), end",
    "disp(compose(\"%.8f\", pi))",
    "s = compose(\"%d.^2 = %d\", (1:5)', ((1:5).^2)'); disp(size(s)), disp(s(1)), disp(s(5))",
    "s = compose(\"The time is %d:%d\", [8 15 9 30; 10 20 11 50]); disp(size(s)), disp(s(1, 2))",
    "s = compose(\"Check-in time %d:%d; Check-out time %d:%d\", [12 27; 11 16]); disp(s(1))",
    "c = compose('%d apples', [1 2]); disp(class(c)), disp(c{2})",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "3ff0000000000000\nc004000000000000\n3f800000\n     0     1     2\n    -1     0     1\n" +
    "MATLAB:bsxfun:arrayDimensionsMustMatch\n3.14159265\n     5     1\n1.^2 = 1\n5.^2 = 25\n     2     2\nThe time is 9:30\n" +
    "Check-in time 12:27; Check-out time %d:%d\ncell\n2 apples\n");
});

test("readmatrix: header lines and the delimiter found, empty and non-numeric fields NaN, short rows padded", () => {
  const r = run([
    "disp(readmatrix('r.csv'))",
    "disp(readmatrix('s.txt'))",
    "disp(readmatrix('r.csv', 'NumHeaderLines', 2))",
    "A = readmatrix('r.csv', 'OutputType', 'int16'); disp(class(A)), disp(A(2, :))",
    "try, readmatrix('none.csv'), catch e, disp(e.identifier), end",
  ].join("\n"), { "r.csv": "a,b,c\n1,2,3\n4,,6\n7,x,9\n", "s.txt": "1 2\n3 4\n" });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "     1     2     3\n     4   NaN     6\n     7   NaN     9\n     1     2\n     3     4\n" +
    "     4   NaN     6\n     7   NaN     9\nint16\n   4   0   6\nMATLAB:textio:textio:FileNotFound\n");
});

test("fread and fwrite: binary in column order, precisions, rounding and saturation, sizes, big-endian, UTF-8 text", () => {
  const r = run([
    "f = fopen('b.bin', 'w'); n = fwrite(f, [1 2 3], 'double'); fwrite(f, [300 -5 2.5], 'uint8'); fclose(f); disp(n)",
    "f = fopen('b.bin'); x = fread(f, 3, 'double')'; y = fread(f, Inf, 'uint8')'; fclose(f); disp([x y])",
    "f = fopen('b.bin', 'r'); [z, c] = fread(f, [2 Inf], 'uint8'); fclose(f); disp([size(z) c])",
    "f = fopen('b.bin'); w = fread(f, 2, '*uint8'); fclose(f); disp(class(w))",
    "f = fopen('be.bin', 'w', 'ieee-be'); fwrite(f, 258, 'uint16'); fclose(f);",
    "f = fopen('be.bin'); disp(fread(f, 2, 'uint8')'), fclose(f);",
    "f = fopen('t.txt', 'w'); fprintf(f, 'h\\xe9llo\\nworld\\n'); fclose(f);",
    "f = fopen('t.txt'); disp(fgetl(f)), s = fread(f, '*char')'; fclose(f); disp(double(s))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "     3\n     1     2     3   255     0     3\n     2    14    27\nuint8\n     1     2\nhéllo\n" +
    "   119   111   114   108   100    10\n");
  assert.equal(readFileSync(join(r.dir, "t.txt"), "utf8"), "héllo\nworld\n");
});

test("containers.Map: keys in order, lookup and assignment, a handle shared by its copies, isKey, remove, values, errors", () => {
  const r = run([
    "m = containers.Map({'pears', 'apples'}, {5, 3});",
    "m('plums') = 2; disp(m('apples')), disp(keys(m)), disp(cell2mat(values(m)))",
    "m2 = m; m2('kiwis') = 9; disp([m.Count, length(m)])",
    "disp([isKey(m, 'kiwis'), isKey(m, 'figs')]), disp(isKey(m, {'apples', 'x'}))",
    "remove(m, 'kiwis'); disp(m.Count), disp(cell2mat(values(m, {'pears', 'apples'})))",
    "disp(class(m)), disp(m.KeyType), disp(m.ValueType)",
    "try, m('nope'), catch e, disp(e.identifier), end",
    "try, m(3), catch e, disp(e.identifier), end",
    "q = containers.Map('KeyType', 'double', 'ValueType', 'any'); q(3) = 'three'; q(1) = [1 2 3]; disp(cell2mat(keys(q))), disp(q(1))",
    "e = containers.Map(); disp([isempty(e), e.Count]), disp(e.KeyType)",
    "w = containers.Map([10 20], [1.5 2.5]); disp(w.ValueType), disp(w(20))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "     3\n    {'apples'}    {'pears'}    {'plums'}\n     3     5     2\n     4     4\n   1   0\n   1   0\n" +
    "     3\n     5     3\ncontainers.Map\nchar\ndouble\nMATLAB:Containers:Map:NoKey\nMATLAB:Containers:TypeMismatch\n" +
    "     1     3\n     1     2     3\n     1     0\nchar\ndouble\n    2.5000\n");
});

// (sort of a complex matrix by 'ComparisonMethod' 'real' along any dimension, NaN last, and maxk by it: m3 and m7 of
// the numeric review's probe, as MATLAB R2026b printed them)
test("sort and maxk of a complex matrix by 'ComparisonMethod', 'real'", () => {
  const show = "pc = @(v) fprintf('%s\\n', strtrim(sprintf('%g%+gi ', [real(v(:).'); imag(v(:).')]))); p = @(v) fprintf('%s\\n', strtrim(sprintf('%g ', v(:).')));";
  const r = run([
    show,
    "M = [1+1i -2 1i; 3 -1-1i 2; NaN 0 -1i];",
    "[s, i] = sort(M, 'ComparisonMethod', 'real'); pc(s), p(i)",
    "[b, i] = maxk(M, 2, 'ComparisonMethod', 'real'); pc(b), p(i)",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "1+1i 3+0i NaN+0i -2+0i -1-1i 0+0i -0-1i 0+1i 2+0i\n1 2 3 1 2 3 3 1 2\n3+0i 1+1i 0+0i -1-1i 2+0i 0+1i\n2 1 3 2 2 1\n");
});
