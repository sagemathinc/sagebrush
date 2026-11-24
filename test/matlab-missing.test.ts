import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// rmmissing and fillmissing on numeric data. MATLAB's own outputs for the cases its pages leave open aren't recorded
// yet (the oracle job is queued); these rows check the pages' examples and rules, each method against values worked
// out independently here, the ends, MaxGap, SamplePoints, the dimensions, classes, MissingLocations, TF and the
// refusals.

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-missing-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const id = line.split("|")[0];
    if (line.includes("|") && !got.has(id)) got.set(id, line);
  }
  return got;
}

const field = (got: Map<string, string>, id: string) => {
  const line = got.get(id);
  assert.ok(line, id + ": no row");
  return line.split("|").slice(1);
};
const nums = (s: string) => s.trim().split(/\s+/).filter((t) => t.length).map(Number);
const same = (got: Map<string, string>, id: string, want: number[], tol = 0) => {
  const g = nums(field(got, id)[0]);
  assert.equal(g.length, want.length, `${id}: ${g} / ${want}`);
  g.forEach((v, k) => {
    if (Number.isNaN(want[k])) assert.ok(Number.isNaN(v), `${id}[${k}]: ${v}, expected NaN`);
    else assert.ok(Math.abs(v - want[k]) <= tol * Math.max(1, Math.abs(want[k])), `${id}[${k}]: ${v}, expected ${want[k]}`);
  });
};
const P = (name: string, expr: string) => `fprintf('${name}|%s\\n', sprintf('%.17g ', double(${expr})));`;

test("rmmissing: entries of a vector, rows or columns of a matrix, MinNumMissing, MissingLocations, TF, classes", () => {
  const got = run([
    P("vec", "rmmissing([1 3 NaN 6 NaN])"),
    P("col", "rmmissing([1; NaN; 3])"),
    P("rows", "rmmissing([1 2; NaN 4; 5 6])"),
    P("cols", "rmmissing([1 NaN 3; 4 5 6], 2)"),
    "[R, TF] = rmmissing([1 NaN; NaN 2; 3 4]); fprintf('rtf|%s|%s|%s\\n', mat2str(R), mat2str(TF), class(TF));",
    "[R, TF] = rmmissing([1 NaN NaN; NaN 2 3; 3 NaN 4], 'MinNumMissing', 2); fprintf('min|%s|%s\\n', mat2str(R), mat2str(TF));",
    "[R, TF] = rmmissing([1 NaN 3], 'MinNumMissing', 0); fprintf('min0|%s|%s\\n', mat2str(size(R)), mat2str(TF));",
    "[R, TF] = rmmissing([1 2 3 4], 'MissingLocations', [false true false true]); fprintf('loc|%s|%s\\n', mat2str(R), mat2str(TF));",
    "fprintf('cls|%s|%s|%s|%s\\n', class(rmmissing(single([1 NaN 2]))), mat2str(rmmissing(int8([1 2 3]))), class(rmmissing(int8([1 2 3]))), mat2str(rmmissing([true false])));",
    "fprintf('cplx|%s\\n', mat2str(rmmissing([1+2i complex(1, NaN) 3])));",
    "fprintf('empty|%s|%s\\n', mat2str(size(rmmissing(zeros(0, 3)))), mat2str(size(rmmissing([NaN NaN]))));",
    "fprintf('nd|%s\\n', mat2str(size(rmmissing(cat(3, [1 NaN; 3 4], [5 6; 7 8])))));",
    "try, rmmissing([1 NaN], 'MinNumMissing', -1), catch e, fprintf('badmin|%s\\n', e.message), end",
    "try, rmmissing([1 NaN], 'Bogus', 1), catch e, fprintf('badname|%s\\n', e.message), end",
    "try, rmmissing([1 NaN], 'MissingLocations', [true false true]), catch e, fprintf('badloc|%s\\n', e.message), end",
  ]);
  same(got, "vec", [1, 3, 6]);
  same(got, "col", [1, 3]);
  same(got, "rows", [1, 5, 2, 6]);
  same(got, "cols", [1, 4, 3, 6]);
  assert.deepEqual(field(got, "rtf"), ["[3 4]", "[true;true;false]", "logical"]);
  // (row 1 holds two NaN, removed; rows 2 and 3 one each, kept with it)
  assert.deepEqual(field(got, "min"), ["[NaN 2 3;3 NaN 4]", "[true;false;false]"]);
  assert.deepEqual(field(got, "min0"), ["[1 0]", "[true true true]"]);
  assert.deepEqual(field(got, "loc"), ["[1 3]", "[false true false true]"]);
  assert.deepEqual(field(got, "cls"), ["single", "[1 2 3]", "int8", "[true false]"]);
  assert.deepEqual(field(got, "cplx"), ["[1+2i 3+0i]"]);
  assert.deepEqual(field(got, "empty"), ["[0 3]", "[1 0]"]);
  assert.deepEqual(field(got, "nd"), ["[1 2 2]"]);
  assert.match(field(got, "badmin")[0], /nonnegative integer/);
  assert.match(field(got, "badname")[0], /'MinNumMissing' and 'MissingLocations'/);
  assert.match(field(got, "badloc")[0], /same size/);
});

test("fillmissing: each method inside and at the ends, ties, a constant, moving windows, statistics", () => {
  const got = run([
    "x = [NaN 1 NaN NaN 4 NaN 7 NaN NaN];",
    P("previous", "fillmissing(x, 'previous')"),
    P("next", "fillmissing(x, 'next')"),
    P("nearest", "fillmissing(x, 'nearest')"),
    P("linear", "fillmissing(x, 'linear')"),
    P("spline", "fillmissing(x, 'spline')"),
    P("pchip", "fillmissing(x, 'pchip')"),
    P("ispline", "interp1([2 5 7], [1 4 7], 1:9, 'spline', 'extrap')"),
    P("ipchip", "interp1([2 5 7], [1 4 7], 1:9, 'pchip', 'extrap')"),
    P("mean", "fillmissing(x, 'mean')"),
    P("median", "fillmissing([NaN 1 2 NaN 10 4], 'median')"),
    P("mode", "fillmissing([NaN 2 1 2 NaN 1 3], 'mode')"),
    P("tie", "fillmissing([1 NaN 3], 'nearest')"),
    P("const", "fillmissing(x, 'constant', 0)"),
    P("constcols", "fillmissing([1 NaN; NaN 2], 'constant', [100 1000])"),
    P("movmean", "fillmissing([1 NaN 3 NaN NaN 6 7 NaN], 'movmean', 3)"),
    P("movmeanbf", "fillmissing([1 NaN 3 NaN NaN 6 7 NaN], 'movmean', [2 0])"),
    P("movmedian", "fillmissing([1 NaN 3 NaN NaN 6 7 NaN], 'movmedian', 3)"),
    P("movhuge", "fillmissing([1 NaN 3 NaN 10], 'movmedian', 1e9)"),
    P("movwhole", "fillmissing([1 NaN 3 NaN 10], 'movmedian', 9)"),
    P("page", "fillmissing([1 3 NaN 4 NaN NaN 5], 'previous')"),
    "[F, TF] = fillmissing(x, 'previous'); fprintf('tf|%s|%s\\n', mat2str(TF), class(TF));",
    "[F, TF] = fillmissing(x, 'linear', 'EndValues', 'none'); fprintf('tfnone|%s\\n', mat2str(TF));",
  ]);
  const N = NaN;
  same(got, "previous", [N, 1, 1, 1, 4, 4, 7, 7, 7]);
  same(got, "next", [1, 1, 4, 4, 4, 7, 7, N, N]);
  // (the nearest known value; 6 is midway between 5 and 7 and takes the next)
  same(got, "nearest", [1, 1, 1, 4, 4, 7, 7, 7, 7]);
  // (the line through (2, 1), (5, 4), slope 1, and through (5, 4), (7, 7), slope 1.5, extended at both ends)
  same(got, "linear", [0, 1, 2, 3, 4, 5.5, 7, 8.5, 10], 1e-15);
  // (spline and pchip: interp1's own, with its extrapolation, at every missing point)
  const ispline = nums(field(got, "ispline")[0]), ipchip = nums(field(got, "ipchip")[0]);
  same(got, "spline", ispline.map((v, k) => [1, 4, 6].includes(k) ? [1, 4, 7][[1, 4, 6].indexOf(k)] : v));
  same(got, "pchip", ipchip.map((v, k) => [1, 4, 6].includes(k) ? [1, 4, 7][[1, 4, 6].indexOf(k)] : v));
  same(got, "mean", [4, 1, 4, 4, 4, 4, 7, 4, 4]);
  // (the median of 1 2 10 4 is 3; the mode of 2 1 2 1 3 is 1, the least of the most frequent)
  same(got, "median", [3, 1, 2, 3, 10, 4]);
  same(got, "mode", [1, 2, 1, 2, 1, 1, 3]);
  same(got, "tie", [1, 3, 3]);
  same(got, "const", [0, 1, 0, 0, 4, 0, 7, 0, 0]);
  same(got, "constcols", [1, 100, 1000, 2]);
  // (windows of the known values: [1 NaN 3] 2; [3 NaN NaN] 3; [NaN NaN 6] 6; [7 NaN] 7)
  same(got, "movmean", [1, 2, 3, 3, 6, 6, 7, 7]);
  // ([b f] = [2 0]: the two before and this one)
  same(got, "movmeanbf", [1, 1, 3, 3, 3, 6, 7, 6.5]);
  same(got, "movmedian", [1, 2, 3, 3, 6, 6, 7, 7]);
  // (a window longer than the data is cut at its ends: every window holds all of it, median 3)
  same(got, "movhuge", [1, 3, 3, 3, 10]);
  same(got, "movwhole", [1, 3, 3, 3, 10]);
  same(got, "page", [1, 3, 3, 4, 4, 4, 5]);
  // (TF: the entries filled; the leading NaN, with nothing before it, stays and isn't marked)
  assert.deepEqual(field(got, "tf"), ["[false false true true false true false true true]", "logical"]);
  assert.deepEqual(field(got, "tfnone"), ["[false false true true false true false false false]"]);
});

test("fillmissing: EndValues, MaxGap, SamplePoints, dimensions, classes, complex data, MissingLocations, refusals", () => {
  const got = run([
    "x = [NaN 1 NaN NaN 4 NaN 7 NaN NaN];",
    P("evnone", "fillmissing(x, 'linear', 'EndValues', 'none')"),
    P("evprev", "fillmissing(x, 'linear', 'EndValues', 'previous')"),
    P("evnext", "fillmissing(x, 'linear', 'EndValues', 'next')"),
    P("evnear", "fillmissing(x, 'linear', 'EndValues', 'nearest')"),
    P("evval", "fillmissing(x, 'linear', 'EndValues', -1)"),
    P("gap2", "fillmissing([1 NaN 3 NaN NaN 6], 'linear', 'MaxGap', 2)"),
    P("gap3", "fillmissing([1 NaN 3 NaN NaN 6], 'linear', 'MaxGap', 3)"),
    P("gaplead", "fillmissing([NaN 2 NaN NaN NaN 6 NaN], 'linear', 'MaxGap', 1)"),
    P("sp", "fillmissing([1 NaN 4], 'linear', 'SamplePoints', [0 1 3])"),
    P("spnear", "fillmissing([1 NaN 4], 'nearest', 'SamplePoints', [0 1 3])"),
    P("dim1", "fillmissing([1 NaN; NaN 4; 5 6], 'linear')"),
    P("dim2", "fillmissing([1 NaN 3; NaN 5 7], 'linear', 2)"),
    P("dim3", "fillmissing(cat(3, [1 NaN], [NaN 4]), 'previous', 3)"),
    P("one", "fillmissing([NaN 5 NaN], 'linear')"),
    P("onenear", "fillmissing([NaN 5 NaN], 'nearest')"),
    "fprintf('cls|%s|%s\\n', class(fillmissing(single([1 NaN 3]), 'linear')), mat2str(double(fillmissing(single([1 NaN 3]), 'linear'))));",
    "fprintf('int|%s|%s\\n', class(fillmissing(int8([1 2 3]), 'linear')), mat2str(fillmissing(int8([10 0 30]), 'linear', 'MissingLocations', [false true false])));",
    "z = fillmissing([1+1i NaN 3+5i], 'linear'); fprintf('cplx|%.17g|%.17g\\n', real(z(2)), imag(z(2)));",
    P("loc", "fillmissing([1 2 3 4], 'linear', 'MissingLocations', [false true true false])"),
    "try, fillmissing([1 NaN], 'bogus'), catch e, fprintf('bad|%s\\n', e.message), end",
    "try, fillmissing([1 NaN], 'makima'), catch e, fprintf('makima|%s\\n', e.message), end",
    "try, fillmissing([1 NaN], 'constant'), catch e, fprintf('noconst|%s\\n', e.message), end",
    "try, fillmissing([1 NaN], 'movmean'), catch e, fprintf('nowin|%s\\n', e.message), end",
    "try, fillmissing([1 NaN 3], 'constant', [1 2]), catch e, fprintf('constsize|%s\\n', e.message), end",
    "try, fillmissing([1 NaN 3], 'linear', 'SamplePoints', [3 2 1]), catch e, fprintf('spbad|%s\\n', e.message), end",
    "try, fillmissing([1 NaN 3], 'linear', 'MaxGap', -1), catch e, fprintf('gapbad|%s\\n', e.message), end",
    "try, fillmissing([1 NaN 3], 'linear', 'EndValues', 'bogus'), catch e, fprintf('evbad|%s\\n', e.message), end",
    "try, fillmissing([1 NaN 3], 'linear', 'DataVariables', 'x'), catch e, fprintf('table|%s\\n', e.message), end",
  ]);
  const N = NaN;
  same(got, "evnone", [N, 1, 2, 3, 4, 5.5, 7, N, N], 1e-15);
  same(got, "evprev", [N, 1, 2, 3, 4, 5.5, 7, 7, 7], 1e-15);
  same(got, "evnext", [1, 1, 2, 3, 4, 5.5, 7, N, N], 1e-15);
  same(got, "evnear", [1, 1, 2, 3, 4, 5.5, 7, 7, 7], 1e-15);
  same(got, "evval", [-1, 1, 2, 3, 4, 5.5, 7, -1, -1], 1e-15);
  // (the gap between 1 and 3 spans 2, filled; between 3 and 6, 3, filled only when MaxGap is 3; leading and trailing
  // gaps count 0, always filled)
  same(got, "gap2", [1, 2, 3, N, N, 6], 1e-15);
  same(got, "gap3", [1, 2, 3, 4, 5, 6], 1e-15);
  same(got, "gaplead", [1, 2, N, N, N, 6, 7], 1e-15);
  // (at sample points 0, 1, 3: the line from (0, 1) to (3, 4) passes 2 at 1; the nearest of 0 and 3 to 1 is 0)
  same(got, "sp", [1, 2, 4], 1e-15);
  same(got, "spnear", [1, 1, 4]);
  // (each column on its own: 1 _ 5 gives 3; _ 4 6 extends its line back to 2)
  same(got, "dim1", [1, 3, 5, 2, 4, 6], 1e-15);
  // (each row on its own: 1 _ 3 gives 2; _ 5 7 extends its line back to 3)
  same(got, "dim2", [1, 3, 2, 5, 3, 7], 1e-15);
  // (along the pages: [1 NaN] fills to [1 1]; [NaN 4] has nothing before its NaN)
  same(got, "dim3", [1, NaN, 1, 4]);
  // (one known value: nothing to interpolate between, so 'linear' leaves NaN; 'nearest' takes it)
  same(got, "one", [N, 5, N]);
  same(got, "onenear", [5, 5, 5]);
  assert.deepEqual(field(got, "cls"), ["single", "[1 2 3]"]);
  assert.deepEqual(field(got, "int"), ["int8", "[10 20 30]"]);
  // (each part interpolated: 2 + 3i)
  assert.deepEqual(field(got, "cplx"), ["2", "3"]);
  same(got, "loc", [1, 2, 3, 4], 1e-15);
  assert.match(field(got, "bad")[0], /the method must be/);
  assert.match(field(got, "makima")[0], /'makima' method is not supported/);
  assert.match(field(got, "noconst")[0], /needs a value/);
  assert.match(field(got, "nowin")[0], /needs a window length/);
  assert.match(field(got, "constsize")[0], /one value for each vector/);
  assert.match(field(got, "spbad")[0], /sorted vector of unique values/);
  assert.match(field(got, "gapbad")[0], /MaxGap must be a positive/);
  assert.match(field(got, "evbad")[0], /EndValues must be/);
  assert.match(field(got, "table")[0], /tables/);
});

test("fillmissing on complex data: each part filled as that part alone, an infinite part never touching the other", () => {
  const got = run([
    "A = complex([1 NaN 3], [Inf NaN Inf]); [F, T] = fillmissing(A, 'linear');",
    "fprintf('a|%.17g|%.17g|%d\\n', real(F(2)), imag(F(2)), T(2));",
    "B = complex([1 NaN 3 5], [2 NaN 4 Inf]); C = complex([1 NaN Inf 5], [2 NaN 4 6]);",
    "for m = {'linear', 'spline', 'pchip', 'nearest', 'previous', 'next', 'mean'}",
    "  d = {B, C}; tag = 'BC';",
    "  for k = 1:2",
    "    X = d{k}; F = fillmissing(X, m{1}); L = isnan(X);",
    "    fprintf('%s_%s|%d|%d\\n', m{1}, tag(k), isequaln(real(F), fillmissing(real(X), m{1}, 'MissingLocations', L)), isequaln(imag(F), fillmissing(imag(X), m{1}, 'MissingLocations', L)));",
    "  end",
    "end",
    "F = fillmissing(B, 'movmean', 3); L = isnan(B); fprintf('movmean_B|%d|%d\\n', isequaln(real(F), fillmissing(real(B), 'movmean', 3, 'MissingLocations', L)), isequaln(imag(F), fillmissing(imag(B), 'movmean', 3, 'MissingLocations', L)));",
    "F = fillmissing(B, 'spline'); fprintf('splinevals|%.17g|%.17g\\n', real(F(2)), imag(F(2)));",
    "F = fillmissing(B, 'mean'); fprintf('meanvals|%.17g|%.17g\\n', real(F(2)), imag(F(2)));",
    "F = fillmissing(B, 'constant', 7 - 2i); fprintf('const|%.17g|%.17g\\n', real(F(2)), imag(F(2)));",
    "try, fillmissing(B, 'median'), catch e, fprintf('median|%s\\n', e.message), end",
  ]);
  // (the real parts 1 _ 3 give 2; the imaginary parts Inf _ Inf give Inf - Inf, NaN: still missing, so not marked)
  assert.deepEqual(field(got, "a"), ["2", "NaN", "0"]);
  // (every method, with an infinite imaginary part (B) and an infinite real part (C): each part as filled alone)
  for (const m of ["linear", "spline", "pchip", "nearest", "previous", "next", "mean"])
    for (const k of ["B", "C"]) assert.deepEqual(field(got, `${m}_${k}`), ["1", "1"], `${m}_${k}`);
  assert.deepEqual(field(got, "movmean_B"), ["1", "1"]);
  // (B's real parts 1 _ 3 5 are finite: the spline's 2 and the mean 3, whatever the imaginary part's Inf does)
  assert.ok(Number.isFinite(Number(field(got, "splinevals")[0])), "spline real part");
  assert.deepEqual(field(got, "meanvals"), ["3", "Inf"]);
  assert.deepEqual(field(got, "const"), ["7", "-2"]);
  assert.match(field(got, "median")[0], /complex data is not supported with 'median'/);
});

test("rmmissing and fillmissing admitted before their copies are made (test/matlab_missing_admit_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_missing_admit_cases.py")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 5, r.stdout);
});
