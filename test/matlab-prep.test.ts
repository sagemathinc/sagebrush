import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// rescale and normalize, against MATLAB R2026b's own outputs (recorded 2026-11-24, the oracle's p5 and p7 programs,
// whose rows are below), and the pages' formulas and examples, the identity N = (A - C) ./ S, NaN left out of the
// statistics, the dimensions, the classes, constant data, and the refusals.

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-prep-"));
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
const nums = (s: string) => s.trim().split(/\s+/).map(Number);
const close = (a: number[], b: number[], tol: number, what: string) => {
  assert.equal(a.length, b.length, what + ": lengths " + a + " / " + b);
  a.forEach((x, k) => {
    if (Number.isNaN(b[k])) assert.ok(Number.isNaN(x), `${what}[${k}]: ${x}, expected NaN`);
    else assert.ok(Math.abs(x - b[k]) <= tol * Math.max(1, Math.abs(b[k])), `${what}[${k}]: ${x}, expected ${b[k]}`);
  });
};
const P = (name: string, expr: string) => `fprintf('${name}|%s\\n', sprintf('%.17g ', ${expr}));`;

test("normalize: the page's examples, each method's statistics, and N = (A - C) ./ S", () => {
  const got = run([
    P("z", "normalize(1:5)"),
    P("magic", "normalize(magic(3))"),
    P("magic2", "normalize(magic(3), 2)"),
    P("scale", "normalize(1:5, 'scale')"),
    P("range", "normalize(1:5, 'range')"),
    P("range2", "normalize([1 2 3 4], 'range', [-1 1])"),
    P("norm1", "normalize(1:5, 'norm', 1)"),
    P("norminf", "normalize([1 -2 3], 'norm', Inf)"),
    P("center", "normalize(1:5, 'center', 'mean')"),
    P("cmedian", "normalize([1 2 10], 'center', 'median')"),
    P("cmedian4", "normalize([1 2 3 4], 'center', 'median')"),
    P("norm2", "normalize([3 4], 'norm')"),
    P("norm3", "normalize([1 2 2], 'norm', 3)"),
    P("robust", "normalize([1 2 3 10], 'zscore', 'robust')"),
    P("mad", "normalize([1 2 3 10], 'scale', 'mad')"),
    P("iqr", "normalize([1 2 3 10 7], 'scale', 'iqr')"),
    P("medianiqr", "normalize([1 2 3 10 7], 'medianiqr')"),
    P("first", "normalize([2 4 8], 'scale', 'first')"),
    P("cs", "normalize([1 2 10], 'center', 'median', 'scale', 'mad')"),
    P("snum", "normalize([2 4 8], 'scale', 4)"),
    P("cnum", "normalize([1 2; 3 4], 'center', [1 10])"),
    "A = [4 1 7; 2 9 3; 8 5 6; 1 1 2];",
    "e = 0; for m = {{'zscore'}, {'zscore', 'robust'}, {'norm', 3}, {'scale', 'iqr'}, {'center', 'median'}, {'medianiqr'}, {'center', 'mean', 'scale', 'mad'}}",
    "  [N, C, S] = normalize(A, m{1}{:}); e = max(e, max(max(abs(N - (A - C) ./ S)))); sz = [size(C) size(S)];",
    "end",
    "fprintf('identity|%.3g|%s\\n', e, mat2str(sz));",
    "[N, C, S] = normalize(A, 'range', [2 5]); fprintf('rangecs|%.3g\\n', max(max(abs(N - (A - C) ./ S))));",
    "[N, C, S] = normalize(A, 2); fprintf('dim2|%s|%s\\n', mat2str(size(C)), mat2str(size(S)));",
  ]);
  close(nums(field(got, "z")[0]), [-1.2649110640673518, -0.63245553203367588, 0, 0.63245553203367588, 1.2649110640673518], 1e-15, "z");
  // (magic(3) = [8 1 6; 3 5 7; 4 9 2]: its columns, each less 5, over the standard deviations sqrt(7), 4, sqrt(7);
  // its rows, each less 5, over sqrt(13), 2, sqrt(13); in column order)
  const s7 = Math.sqrt(7), s13 = Math.sqrt(13);
  close(nums(field(got, "magic")[0]), [3 / s7, -2 / s7, -1 / s7, -4 / 4, 0, 4 / 4, 1 / s7, 2 / s7, -3 / s7], 1e-15, "magic");
  close(nums(field(got, "magic2")[0]), [3 / s13, -1, -1 / s13, -4 / s13, 0, 4 / s13, 1 / s13, 1, -3 / s13], 1e-15, "magic2");
  const sd = Math.sqrt(2.5);
  close(nums(field(got, "scale")[0]), [1, 2, 3, 4, 5].map((x) => x / sd), 1e-15, "scale");
  close(nums(field(got, "range")[0]), [0, 0.25, 0.5, 0.75, 1], 0, "range");
  close(nums(field(got, "range2")[0]), [-1, -1 / 3, 1 / 3, 1], 1e-15, "range2");
  close(nums(field(got, "norm1")[0]), [1, 2, 3, 4, 5].map((x) => x / 15), 1e-15, "norm1");
  close(nums(field(got, "norminf")[0]), [1 / 3, -2 / 3, 1], 1e-15, "norminf");
  close(nums(field(got, "center")[0]), [-2, -1, 0, 1, 2], 0, "center");
  close(nums(field(got, "cmedian")[0]), [-1, 0, 8], 0, "cmedian");
  // (an even count: the median is the mean of the two middle values, 2.5)
  close(nums(field(got, "cmedian4")[0]), [-1.5, -0.5, 0.5, 1.5], 0, "cmedian4");
  close(nums(field(got, "norm2")[0]), [0.6, 0.8], 1e-15, "norm2");
  // (the 3-norm of [1 2 2] is 17^(1/3))
  close(nums(field(got, "norm3")[0]), [1, 2, 2].map((x) => x / Math.cbrt(17)), 1e-15, "norm3");
  // ('robust': the median 2.5 and the median absolute deviation median([1.5 0.5 0.5 7.5]) = 1, as MATLAB R2026b
  // computes it, where its page says the mean)
  close(nums(field(got, "robust")[0]), [-1.5, -0.5, 0.5, 7.5], 0, "robust");
  close(nums(field(got, "mad")[0]), [1, 2, 3, 10], 0, "mad");
  // (prctile's rule on 1 2 3 7 10: the 25th percentile 1.75, the 75th 7.75, so IQR 6; the median 3)
  close(nums(field(got, "iqr")[0]), [1, 2, 3, 10, 7].map((x) => x / 6), 1e-15, "iqr");
  close(nums(field(got, "medianiqr")[0]), [1, 2, 3, 10, 7].map((x) => (x - 3) / 6), 1e-15, "medianiqr");
  close(nums(field(got, "first")[0]), [1, 2, 4], 0, "first");
  close(nums(field(got, "cs")[0]), [-1, 0, 8], 0, "cs");
  close(nums(field(got, "snum")[0]), [0.5, 1, 2], 0, "snum");
  close(nums(field(got, "cnum")[0]), [0, 2, -8, -6], 0, "cnum");
  const [idErr, sizes] = field(got, "identity");
  assert.equal(Number(idErr), 0);
  assert.equal(sizes, "[1 3 1 3]");
  assert.ok(Number(field(got, "rangecs")[0]) <= 1e-15, "range's C and S");
  assert.deepEqual(field(got, "dim2"), ["[4 1]", "[4 1]"]);
});

test("normalize: NaN left out, dimensions, classes, constant data, empty, complex, refusals", () => {
  const got = run([
    P("nan", "normalize([1 NaN 3 4])"),
    P("nanrange", "normalize([NaN 2 4 6], 'range')"),
    P("dim3", "normalize(reshape(1:8, 2, 2, 2), 3)"),
    P("dim5", "normalize([1 2 3], 5, 'center')"),
    "fprintf('cls|%s\\n', class(normalize(single([1 2 4]))));",
    "try, normalize(int16([1 2 4])), catch e, fprintf('int|%s|%s\\n', e.identifier, e.message), end",
    "try, normalize([true false true]), catch e, fprintf('logical|%s|%s\\n', e.identifier, e.message), end",
    "try, normalize([1 -2 3], 'norm', -Inf), catch e, fprintf('ninf|%s|%s\\n', e.identifier, e.message), end",
    "[N, C, S] = normalize(single([1 2 4])); fprintf('clsCS|%s|%s\\n', class(C), class(S));",
    P("const", "normalize([3 3 3])"),
    P("constrange", "normalize([3 3 3], 'range', [2 5])"),
    "[N, C, S] = normalize([3 3 3], 'range', [2 5]); fprintf('constcs|%.17g|%.17g\\n', C, S);",
    "fprintf('empty|%s\\n', mat2str(size(normalize(zeros(0, 3)))));",
    "z = normalize([3+4i 6 0], 'norm', Inf); fprintf('complex|%.17g|%.17g\\n', max(abs(z)), angle(z(1)) - angle(3+4i));",
    "try, normalize([1 2i], 'center', 'median'), catch e, fprintf('cmplxmed|%s\\n', e.message), end",
    "try, normalize([1 2 3], 'bogus'), catch e, fprintf('badmethod|%s|%s\\n', e.identifier, e.message), end",
    "try, normalize([1 2 3], 'zscore', 'mad'), catch e, fprintf('badtype|%s|%s\\n', e.identifier, e.message), end",
    "try, normalize([1 2 3], 'norm', 0), catch e, fprintf('badnorm|%s|%s\\n', e.identifier, e.message), end",
    "try, normalize([1 2 3], 'range', [1 0]), catch e, fprintf('badrange|%s|%s\\n', e.identifier, e.message), end",
    "try, normalize([1 2 3], 'scale', [1 2]), catch e, fprintf('badscale|%s\\n', e.message), end",
    "try, normalize([1 2 3], 'DataVariables', 'x'), catch e, fprintf('table|%s\\n', e.message), end",
    "try, normalize([1 2 3], 'center', 'mean', 'center', 'median'), catch e, fprintf('twice|%s\\n', e.message), end",
  ]);
  // (mean of 1 3 4 is 8/3, their standard deviation sqrt(7/3); the NaN stays NaN)
  const m = 8 / 3, sd = Math.sqrt(7 / 3);
  close(nums(field(got, "nan")[0]), [(1 - m) / sd, NaN, (3 - m) / sd, (4 - m) / sd], 1e-15, "nan");
  close(nums(field(got, "nanrange")[0]), [NaN, 0, 0.5, 1], 0, "nanrange");
  const r = 1 / Math.SQRT2;
  close(nums(field(got, "dim3")[0]), [-r, -r, -r, -r, r, r, r, r], 1e-15, "dim3");
  close(nums(field(got, "dim5")[0]), [0, 0, 0], 0, "dim5");
  assert.deepEqual(field(got, "cls"), ["single"]);
  const notFloat = ["MATLAB:normalize:InvalidFirstInput", "Invalid data type. First argument must be of type double, single, table, or timetable."];
  assert.deepEqual(field(got, "int"), notFloat);
  assert.deepEqual(field(got, "logical"), notFloat);
  assert.deepEqual(field(got, "ninf"), ["MATLAB:normalize:InvalidNormType", "The norm must be a positive real scalar or Inf."]);
  assert.deepEqual(field(got, "clsCS"), ["single", "single"]);
  close(nums(field(got, "const")[0]), [NaN, NaN, NaN], 0, "const");
  close(nums(field(got, "constrange")[0]), [2, 2, 2], 0, "constrange");
  assert.deepEqual(field(got, "constcs"), ["1", "1"]);
  assert.deepEqual(field(got, "empty"), ["[0 3]"]);
  const [mx, phase] = field(got, "complex").map(Number);
  assert.ok(Math.abs(mx - 1) < 1e-15 && Math.abs(phase) < 1e-15, `complex ${mx} ${phase}`);
  assert.match(field(got, "cmplxmed")[0], /complex data is not supported/);
  // (MATLAB R2026b's identifiers and messages)
  assert.deepEqual(field(got, "badmethod"), ["MATLAB:normalize:InvalidMethod", "Normalization method must be 'zscore', 'norm', 'center', 'scale', 'range', or 'medianiqr'."]);
  assert.deepEqual(field(got, "badtype"), ["MATLAB:normalize:InvalidZscoreType", "The zscore type must be 'std' or 'robust'."]);
  assert.deepEqual(field(got, "badnorm"), ["MATLAB:normalize:InvalidNormType", "The norm must be a positive real scalar or Inf."]);
  assert.deepEqual(field(got, "badrange"), ["MATLAB:normalize:InvalidRangeType", "The range interval must be a real vector containing two elements with increasing values."]);
  assert.match(field(got, "badscale")[0], /one value for each vector/);
  assert.match(field(got, "table")[0], /tables/);
  assert.match(field(got, "twice")[0], /once each/);
});

test("rescale: the page's formula, clipping to InputMin and InputMax, bounds by row or column, NaN, constant data, classes, refusals", () => {
  const got = run([
    P("basic", "rescale([1 2 3 4 5])"),
    P("lu", "rescale([1 10; 3 20], -1, 1)"),
    P("clip", "rescale([1 2 3 4 5], 'InputMin', 2, 'InputMax', 4)"),
    P("cols", "rescale(magic(3), 'InputMin', min(magic(3)), 'InputMax', max(magic(3)))"),
    P("rows", "rescale(magic(3), [0 10 100], [1 20 200])"),
    P("nan", "rescale([1 NaN 3 5])"),
    P("const", "rescale([4 4 4], 2, 5)"),
    P("constinf", "rescale([4 4], -Inf, 5)"),
    P("int", "rescale(int8([-128 0 127]))"),
    "fprintf('cls|%s|%s|%s\\n', class(rescale(single([1 2]))), class(rescale(uint8([0 9]))), class(rescale([true false])));",
    "fprintf('empty|%s\\n', mat2str(size(rescale(zeros(0, 3)))));",
    "try, rescale([1 2 3], 2, 1), catch e, fprintf('badlu|%s|%s\\n', e.identifier, e.message), end",
    P("equal", "rescale([1 2 3], 5, 5)"),
    P("inf", "rescale([1 Inf 3])"),
    P("big", "rescale([-1e308 1e308 0])"),
    "try, rescale([1 2 3], 2), catch e, fprintf('oneb|%s\\n', e.message), end",
    "try, rescale([1 2i 3]), catch e, fprintf('complex|%s|%s\\n', e.identifier, e.message), end",
    "try, rescale([1 2 3], 'Bogus', 1), catch e, fprintf('badname|%s\\n', e.message), end",
    "try, rescale(magic(3), [0 1], [1 2]), catch e, fprintf('badsize|%s\\n', e.message), end",
  ]);
  close(nums(field(got, "basic")[0]), [0, 0.25, 0.5, 0.75, 1], 0, "basic");
  // (MATLAB's page: rescale scales by the whole array's extrema, 1 and 20; column order 1 3 10 20)
  close(nums(field(got, "lu")[0]), [-1, -1 + 4 / 19, -1 + 18 / 19, 1], 1e-15, "lu");
  close(nums(field(got, "clip")[0]), [0, 0, 0.5, 1, 1], 0, "clip");
  // (magic(3) = [8 1 6; 3 5 7; 4 9 2], each column by its own extrema)
  close(nums(field(got, "cols")[0]), [1, 0, 0.2, 0, 0.5, 1, 0.8, 1, 0], 1e-15, "cols");
  // (by the whole array's extrema 1 and 9, column k to [l(k), u(k)])
  close(nums(field(got, "rows")[0]), [7 / 8, 2 / 8, 3 / 8, 10, 10 + 40 / 8, 20, 100 + 500 / 8, 100 + 600 / 8, 100 + 100 / 8], 1e-15, "rows");
  close(nums(field(got, "nan")[0]), [0, NaN, 0.5, 1], 0, "nan");
  close(nums(field(got, "const")[0]), [2, 2, 2], 0, "const");
  close(nums(field(got, "constinf")[0]), [NaN, NaN], 0, "constinf");
  close(nums(field(got, "int")[0]), [0, 128 / 255, 1], 1e-15, "int");
  assert.deepEqual(field(got, "cls"), ["single", "double", "double"]);
  assert.deepEqual(field(got, "empty"), ["[0 3]"]);
  assert.deepEqual(field(got, "badlu"), ["MATLAB:rescale:OutMinGreaterThanOutMax", "Lower bound argument must be less than or equal to the upper bound argument."]);
  // (an empty interval is allowed; an infinite extremum makes every element NaN; a range that overflows is scaled first)
  close(nums(field(got, "equal")[0]), [5, 5, 5], 0, "equal");
  close(nums(field(got, "inf")[0]), [NaN, NaN, NaN], 0, "inf");
  close(nums(field(got, "big")[0]), [0, 1, 0.5], 1e-16, "big");
  assert.match(field(got, "oneb")[0], /give both the lower bound/);
  assert.deepEqual(field(got, "complex"), ["MATLAB:rescale:InvalidA", "First argument must be a real numeric or logical array."]);
  assert.match(field(got, "badname")[0], /'InputMin' and 'InputMax'/);
  assert.match(field(got, "badsize")[0], /compatible with the size of A/);
});

// (MATLAB R2026b's output for the program below, recorded 2026-11-24 on MATLAB Online, every row in its own try; the
// open cases of MATLAB's pages: NaN, Inf, empty, classes, constant data, C and S, refusals. All match to the digit but
// two of rescale's: r_round, with [l, u] = [-3, 7], and r_big at 1e308, within 1.15 eps max(|l|, |u|), the bound
// the catalog states (MATLAB's exact order of operations isn't known))
const PROGRAM_P5 = [
  "format long g",
  "show = @(name, x) fprintf('%s|%s|%s|%s|%s\\n', name, class(x), mat2str(size(x)), sprintf('%.17g ', real(double(x))), sprintf('%.17g ', imag(double(x))));",
  "try, show('r_nan', rescale([1 NaN 3 5])), catch e, fprintf('r_nan|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_inf', rescale([1 Inf 3])), catch e, fprintf('r_inf|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_ninf', rescale([-Inf 0 1])), catch e, fprintf('r_ninf|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_empty', rescale(zeros(0, 3))), catch e, fprintf('r_empty|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_int8', rescale(int8([-128 0 127]))), catch e, fprintf('r_int8|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_uint8_lu', rescale(uint8([0 100 255]), -1, 1)), catch e, fprintf('r_uint8_lu|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_logical', rescale([true false true])), catch e, fprintf('r_logical|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_const', rescale([4 4 4], 2, 5)), catch e, fprintf('r_const|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_const_inf', rescale([4 4 4], -Inf, 5)), catch e, fprintf('r_const_inf|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_round', rescale([0.1 0.7 0.3 0.2 1e-17], -3, 7)), catch e, fprintf('r_round|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_big', rescale([-1e308 1e308 0])), catch e, fprintf('r_big|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_clip', rescale([1 2 3 4 5], 'InputMin', 2, 'InputMax', 4)), catch e, fprintf('r_clip|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_cols', rescale(magic(3), 'InputMin', min(magic(3)), 'InputMax', max(magic(3)))), catch e, fprintf('r_cols|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('r_lu_row', rescale(magic(3), [0 10 100], [1 20 200])), catch e, fprintf('r_lu_row|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, rescale([1 2 3], 2, 1), catch e, fprintf('r_badlu|%s|%s\\n', e.identifier, e.message), end",
  "try, rescale([1 2i 3]), catch e, fprintf('r_complex|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_const', normalize([3 3 3])), catch e, fprintf('n_const|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_const_range', normalize([3 3 3], 'range')), catch e, fprintf('n_const_range|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_const_mad', normalize([3 3 3], 'zscore', 'robust')), catch e, fprintf('n_const_mad|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_nan', normalize([1 NaN 3 4])), catch e, fprintf('n_nan|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_nan_first', normalize([NaN 2 4], 'scale', 'first')), catch e, fprintf('n_nan_first|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_robust', normalize([1 2 3 10])), catch e, fprintf('n_robust|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_robust2', normalize([1 2 3 10], 'zscore', 'robust')), catch e, fprintf('n_robust2|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_mad', normalize([1 2 3 10], 'scale', 'mad')), catch e, fprintf('n_mad|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_iqr', normalize([1 2 3 10 7], 'scale', 'iqr')), catch e, fprintf('n_iqr|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_medianiqr', normalize([1 2 3 10 7], 'medianiqr')), catch e, fprintf('n_medianiqr|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_norm1', normalize([1 -2 3], 'norm', 1)), catch e, fprintf('n_norm1|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_normninf', normalize([1 -2 3], 'norm', -Inf)), catch e, fprintf('n_normninf|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_range', normalize([1 2 3 4], 'range', [-1 1])), catch e, fprintf('n_range|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_center_median', normalize([1 2 10], 'center', 'median')), catch e, fprintf('n_center_median|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_cs', normalize([1 2 10], 'center', 'median', 'scale', 'mad')), catch e, fprintf('n_cs|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, [N, C, S] = normalize(magic(3)); show('n_N', N), show('n_C', C), show('n_S', S), catch e, fprintf('n_N|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, [N, C, S] = normalize(magic(3), 'range'); show('n_rN', N), show('n_rC', C), show('n_rS', S), catch e, fprintf('n_rN|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, [N, C, S] = normalize([1 2 3], 'norm'); show('n_nC', C), show('n_nS', S), catch e, fprintf('n_nC|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_single', normalize(single([1 2 4]))), catch e, fprintf('n_single|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_int', normalize(int16([1 2 4]))), catch e, fprintf('n_int|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_empty', normalize(zeros(0, 3))), catch e, fprintf('n_empty|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_dim3', normalize(reshape(1:8, 2, 2, 2), 3)), catch e, fprintf('n_dim3|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('n_complex', normalize([1+1i 2 3-2i])), catch e, fprintf('n_complex|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, normalize([1 2 3], 'range', [1 0]), catch e, fprintf('n_badrange|%s|%s\\n', e.identifier, e.message), end",
  "try, normalize([1 2 3], 'norm', 0), catch e, fprintf('n_badnorm|%s|%s\\n', e.identifier, e.message), end",
  "try, normalize([1 2 3], 'zscore', 'mad'), catch e, fprintf('n_badtype|%s|%s\\n', e.identifier, e.message), end",
  "try, normalize([1 2 3], 'bogus'), catch e, fprintf('n_badmethod|%s|%s\\n', e.identifier, e.message), end"
];
const MATLAB_P5 = [
  "r_nan|double|[1 4]|0 NaN 0.5 1 |0 0 0 0",
  "r_inf|double|[1 3]|NaN NaN NaN |0 0 0",
  "r_ninf|double|[1 3]|NaN NaN NaN |0 0 0",
  "r_empty|double|[0 3]| |",
  "r_int8|double|[1 3]|0 0.50196078431372548 1 |0 0 0",
  "r_uint8_lu|double|[1 3]|-1 -0.21568627450980393 1 |0 0 0",
  "r_logical|double|[1 3]|1 0 1 |0 0 0",
  "r_const|double|[1 3]|2 2 2 |0 0 0",
  "r_const_inf|double|[1 3]|NaN NaN NaN |0 0 0",
  "r_round|double|[1 5]|-1.571428571428571 7 1.285714285714286 -0.14285714285714191 -2.9999999999999996 |0 0 0 0 0",
  "r_big|double|[1 3]|5.5511151231257827e-17 1 0.5 |0 0 0",
  "r_clip|double|[1 5]|0 0 0.5 1 1 |0 0 0 0 0",
  "r_cols|double|[3 3]|1 0 0.20000000000000001 0 0.5 1 0.80000000000000004 1 0 |0 0 0 0 0 0 0 0 0",
  "r_lu_row|double|[3 3]|0.875 0.25 0.375 10 15 20 162.5 175 112.5 |0 0 0 0 0 0 0 0 0",
  "r_badlu|MATLAB:rescale:OutMinGreaterThanOutMax|Lower bound argument must be less than or equal to the upper bound argument.",
  "r_complex|MATLAB:rescale:InvalidA|First argument must be a real numeric or logical array.",
  "n_const|double|[1 3]|NaN NaN NaN |0 0 0",
  "n_const_range|double|[1 3]|0 0 0 |0 0 0",
  "n_const_mad|double|[1 3]|NaN NaN NaN |0 0 0",
  "n_nan|double|[1 4]|-1.0910894511799618 NaN 0.2182178902359925 0.87287156094396967 |0 0 0 0",
  "n_nan_first|double|[1 3]|NaN NaN NaN |0 0 0",
  "n_robust|double|[1 4]|-0.73484692283495334 -0.4898979485566356 -0.2449489742783178 1.4696938456699067 |0 0 0 0",
  "n_robust2|double|[1 4]|-1.5 -0.5 0.5 7.5 |0 0 0 0",
  "n_mad|double|[1 4]|1 2 3 10 |0 0 0 0",
  "n_iqr|double|[1 5]|0.16666666666666666 0.33333333333333331 0.5 1.6666666666666667 1.1666666666666667 |0 0 0 0 0",
  "n_medianiqr|double|[1 5]|-0.33333333333333331 -0.16666666666666666 0 1.1666666666666667 0.66666666666666663 |0 0 0 0 0",
  "n_norm1|double|[1 3]|0.16666666666666666 -0.33333333333333331 0.5 |0 0 0",
  "n_normninf|ERROR|MATLAB:normalize:InvalidNormType|The norm must be a positive real scalar or Inf.",
  "n_range|double|[1 4]|-1 -0.33333333333333337 0.33333333333333326 1 |0 0 0 0",
  "n_center_median|double|[1 3]|-1 0 8 |0 0 0",
  "n_cs|double|[1 3]|-1 0 8 |0 0 0",
  "n_N|double|[3 3]|1.1338934190276817 -0.7559289460184544 -0.3779644730092272 -1 0 1 0.3779644730092272 0.7559289460184544 -1.1338934190276817 |0 0 0 0 0 0 0 0 0",
  "n_C|double|[1 3]|5 5 5 |0 0 0",
  "n_S|double|[1 3]|2.6457513110645907 4 2.6457513110645907 |0 0 0",
  "n_rN|double|[3 3]|1 0 0.20000000000000001 0 0.5 1 0.80000000000000004 1 0 |0 0 0 0 0 0 0 0 0",
  "n_rC|double|[1 3]|3 1 2 |0 0 0",
  "n_rS|double|[1 3]|5 8 5 |0 0 0",
  "n_nC|double|[1 1]|0 |0",
  "n_nS|double|[1 1]|3.7416573867739413 |0",
  "n_single|single|[1 3]|-0.87287145853042603 -0.21821783483028412 1.0910894870758057 |0 0 0",
  "n_int|ERROR|MATLAB:normalize:InvalidFirstInput|Invalid data type. First argument must be of type double, single, table, or timetable.",
  "n_empty|double|[0 3]| |",
  "n_dim3|double|[2 2 2]|-0.70710678118654746 -0.70710678118654746 -0.70710678118654746 -0.70710678118654746 0.70710678118654746 0.70710678118654746 0.70710678118654746 0.70710678118654746 |0 0 0 0 0 0 0 0",
  "n_complex|double|[1 3]|-0.54772255750516607 0 0.54772255750516607 |0.73029674334022143 0.18257418583505536 -0.9128709291752769",
  "n_badrange|MATLAB:normalize:InvalidRangeType|The range interval must be a real vector containing two elements with increasing values.",
  "n_badnorm|MATLAB:normalize:InvalidNormType|The norm must be a positive real scalar or Inf.",
  "n_badtype|MATLAB:normalize:InvalidZscoreType|The zscore type must be 'std' or 'robust'.",
  "n_badmethod|MATLAB:normalize:InvalidMethod|Normalization method must be 'zscore', 'norm', 'center', 'scale', 'range', or 'medianiqr'."
];
// (each row's interval's largest magnitude, max(|l|, |u|); the bound 1.15 eps times it, absolute)
const EPS = 2.220446049250313e-16;
const NEAR_P5: Record<string, number> = { r_round: 7, r_big: 1 };
const within = (g: number[], w: number[], scale: number, what: string) => {
  assert.equal(g.length, w.length, what);
  g.forEach((v, k) => assert.ok(Math.abs(v - w[k]) <= 1.15 * EPS * scale, `${what}[${k}]: ${v} against MATLAB's ${w[k]}`));
};

test("rescale and normalize against MATLAB R2026b's rows, to the digit", () => {
  const got = run(PROGRAM_P5);
  for (const want of MATLAB_P5) {
    const id = want.split("|")[0];
    const line = got.get(id);
    assert.ok(line, id + ": no row");
    const g = line.split("|").map((f) => f.trim()), w = want.split("|").map((f) => f.trim());
    if (id in NEAR_P5) {
      assert.deepEqual(g.slice(0, 3), w.slice(0, 3), id);
      within(nums(g[3]), nums(w[3]), NEAR_P5[id], id);
    } else assert.deepEqual(g, w, id);
  }
});

// (MATLAB R2026b's rescale on inputs that separate its steps, recorded 2026-11-24. Its exact order of operations isn't
// known: the rows marked here differ from MATLAB's by at most 1.15 eps max(|l|, |u|), absolute, the bound the catalog
// states; the rest match to the digit)
const PROGRAM_P7 = [
  "format long g",
  "show = @(name, x) fprintf('%s|%s|%s|%s\\n', name, class(x), mat2str(size(x)), sprintf('%.17g ', x));",
  "A = [0.1 0.7 0.3 0.2 1e-17];",
  "try, show('a01', rescale(A)), catch e, fprintf('a01|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('a_m3_7', rescale(A, -3, 7)), catch e, fprintf('a_m3_7|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('a_0_10', rescale(A, 0, 10)), catch e, fprintf('a_0_10|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('a_m3_0', rescale(A, -3, 0)), catch e, fprintf('a_m3_0|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('a_1_2', rescale(A, 1, 2)), catch e, fprintf('a_1_2|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('a_m1_1', rescale(A, -1, 1)), catch e, fprintf('a_m1_1|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('a_lu_dec', rescale(A, -3.3, 7.1)), catch e, fprintf('a_lu_dec|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "B = [0.1 0.7 0.3 0.2 0];",
  "try, show('b01', rescale(B)), catch e, fprintf('b01|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('b_m3_7', rescale(B, -3, 7)), catch e, fprintf('b_m3_7|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "C = [3 0.1 2.2 1.7 0.45 2.9];",
  "try, show('c01', rescale(C)), catch e, fprintf('c01|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('c_m3_7', rescale(C, -3, 7)), catch e, fprintf('c_m3_7|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('c_in', rescale(C, 'InputMin', 0.1, 'InputMax', 3)), catch e, fprintf('c_in|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('c_in2', rescale(C, -3, 7, 'InputMin', 0.1, 'InputMax', 3)), catch e, fprintf('c_in2|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('c_in3', rescale(C, -3, 7, 'InputMin', 0, 'InputMax', 4)), catch e, fprintf('c_in3|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "D = [-1e308 1e308 0 5e307 -3e307];",
  "try, show('d01', rescale(D)), catch e, fprintf('d01|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('d_m3_7', rescale(D, -3, 7)), catch e, fprintf('d_m3_7|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('d_half', rescale([-1e308 0 1e308]/2)), catch e, fprintf('d_half|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('e_neg', rescale([-0.7 -0.1 -0.3 -1e-17])), catch e, fprintf('e_neg|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('e_neg_lu', rescale([-0.7 -0.1 -0.3 -1e-17], -3, 7)), catch e, fprintf('e_neg_lu|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('f_big_lu', rescale([1 2 3], -1e308, 1e308)), catch e, fprintf('f_big_lu|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('g_tiny', rescale([1e-310 3e-310 2e-310])), catch e, fprintf('g_tiny|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('h_shift', rescale(1e15 + [0.1 0.7 0.3 0.2])), catch e, fprintf('h_shift|ERROR|%s|%s\\n', e.identifier, e.message), end",
  "try, show('i_eq_lu', rescale([1 2 3], 5, 5)), catch e, fprintf('i_eq_lu|ERROR|%s|%s\\n', e.identifier, e.message), end"
];
const MATLAB_P7 = [
  "a01|double|[1 5]|0.14285714285714285 1 0.42857142857142855 0.28571428571428575 0",
  "a_m3_7|double|[1 5]|-1.571428571428571 7 1.285714285714286 -0.14285714285714191 -2.9999999999999996",
  "a_0_10|double|[1 5]|1.4285714285714286 10 4.2857142857142856 2.8571428571428577 0",
  "a_m3_0|double|[1 5]|-2.5714285714285712 0 -1.714285714285714 -2.1428571428571423 -2.9999999999999996",
  "a_1_2|double|[1 5]|1.1428571428571428 2 1.4285714285714286 1.2857142857142858 1",
  "a_m1_1|double|[1 5]|-0.7142857142857143 1 -0.1428571428571429 -0.42857142857142849 -1",
  "a_lu_dec|double|[1 5]|-1.8142857142857143 7.0999999999999988 1.1571428571428566 -0.32857142857142829 -3.2999999999999998",
  "b01|double|[1 5]|0.14285714285714288 1 0.42857142857142855 0.28571428571428575 0",
  "b_m3_7|double|[1 5]|-1.5714285714285707 7 1.285714285714286 -0.14285714285714191 -2.9999999999999996",
  "c01|double|[1 6]|1 0 0.72413793103448287 0.55172413793103448 0.1206896551724138 0.96551724137931039",
  "c_m3_7|double|[1 6]|7 -3 4.2413793103448283 2.5172413793103443 -1.7931034482758621 6.6551724137931032",
  "c_in|double|[1 6]|1 0 0.72413793103448287 0.55172413793103448 0.1206896551724138 0.96551724137931039",
  "c_in2|double|[1 6]|7 -3 4.2413793103448283 2.5172413793103443 -1.7931034482758621 6.6551724137931032",
  "c_in3|double|[1 6]|4.5 -2.75 2.5 1.25 -1.875 4.25",
  "d01|double|[1 5]|5.5511151231257827e-17 1 0.5 0.75 0.35000000000000003",
  "d_m3_7|double|[1 5]|-2.9999999999999982 6.9999999999999982 2 4.4999999999999991 0.50000000000000044",
  "d_half|double|[1 3]|5.5511151231257827e-17 0.5 1",
  "e_neg|double|[1 4]|0 0.85714285714285721 0.5714285714285714 1",
  "e_neg_lu|double|[1 4]|-3 5.5714285714285712 2.7142857142857144 7",
  "f_big_lu|double|[1 3]|-1e+308 0 1e+308",
  "g_tiny|double|[1 3]|NaN 1 1",
  "h_shift|double|[1 4]|0 1 0.20000000000000001 0.20000000000000001",
  "i_eq_lu|double|[1 3]|5 5 5"
];
const NEAR_P7: Record<string, number> = { a_m3_7: 7, a_m3_0: 3, b_m3_7: 7, d01: 1, d_m3_7: 7, d_half: 1, e_neg: 1 };

test("rescale's arithmetic against MATLAB R2026b's rows", () => {
  const got = run(PROGRAM_P7);
  for (const want of MATLAB_P7) {
    const id = want.split("|")[0];
    const line = got.get(id);
    assert.ok(line, id + ": no row");
    const g = line.split("|").map((f) => f.trim()), w = want.split("|").map((f) => f.trim());
    if (id in NEAR_P7) {
      assert.deepEqual(g.slice(0, 3), w.slice(0, 3), id);
      within(nums(g[3]), nums(w[3]), NEAR_P7[id], id);
    } else assert.deepEqual(g, w, id);
  }
});

test("rescale and normalize admitted before their copies are made (test/matlab_prep_admit_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_prep_admit_cases.py")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 3, r.stdout);
});
