import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// zscore, maxk and mink, divergence and curl, and writematrix (lib/_matlab_data.py), as MATLAB's documentation
// describes them; the functions a gallery of MATLAB examples needed that Sagebrush lacked.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-zmc-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status, dir };
}

test("zscore: n - 1 or n, a dimension or 'all', identical values give 0 with sigma 0, NaN gives NaN", () => {
  const r = run([
    "fprintf('%.4f ', zscore([2 4 4 4 5 5 7 9])), fprintf('\\n')",
    "fprintf('%.4f ', zscore([1 2 3 4], 1)), fprintf('\\n')",
    "[Z, mu, sigma] = zscore([1 2; 3 2; 5 2]); fprintf('%g ', Z, mu, sigma), fprintf('\\n')",
    "fprintf('%g ', zscore([1 2; 3 4], 0, 2)), fprintf('\\n')",
    "fprintf('%.4f ', zscore([1 2; 3 4], 0, 'all')), fprintf('\\n')",
    "fprintf('%g ', zscore([1 NaN 3])), fprintf('\\n')",
    "disp(class(zscore(single([1 2 3]))))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, [
    "-1.4031 -0.4677 -0.4677 -0.4677 0.0000 0.0000 0.9354 1.8708 ",
    "-1.3416 -0.4472 0.4472 1.3416 ",
    "-1 0 1 0 0 0 3 2 2 0 ",
    "-0.707107 -0.707107 0.707107 0.707107 ",
    "-1.1619 0.3873 -0.3873 1.1619 ",
    "NaN NaN NaN ",
    "single",
    "",
  ].join("\n"));
});

test("maxk and mink: in order, ties in their order in A, k past the length sorts it all, along a dimension, by magnitude for complex", () => {
  const r = run([
    "[B, I] = maxk([2 8 1 8 5], 3); fprintf('%g ', B, I), fprintf('\\n')",
    "[B, I] = mink([2 8 1 8 5], 3); fprintf('%g ', B, I), fprintf('\\n')",
    "fprintf('%g ', maxk([3 1 2], 5)), fprintf('\\n')",
    "fprintf('%g ', mink([4 1 3; 9 0 2], 2, 2)), fprintf('\\n')",
    "fprintf('%g ', maxk([4 1 3; 9 0 2], 1)), fprintf('\\n')",
    "[b, i] = maxk([2-2i 5+1i -7-3i -1+1i], 2); fprintf('%g ', real(b), imag(b), i), fprintf('\\n')",
    "disp(size(maxk([1 2 3], 0)))",
    "try, maxk([1 2], -1), catch e, disp(e.message), end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, [
    "8 8 5 2 4 5 ",
    "1 2 5 3 1 5 ",
    "3 2 1 ",
    "1 0 3 2 ",
    "9 1 3 ",
    "-7 5 -3 1 3 2 ",
    "     1     0",
    "maxk: k must be a nonnegative integer scalar.",
    "",
  ].join("\n"));
});

// (each row as MATLAB R2026b printed it, observed 2026-11-21: maxk puts NaN last, as mink does; 'ComparisonMethod',
// 'abs' orders real values by magnitude, then by angle, so 3 comes before -3 ascending; 'MissingPlacement' both ways)
const ORDER: [string, string][] = [
  ["[b,i] = maxk([1 NaN 3],2)", "3 1 3 1"],
  ["b = maxk([NaN NaN 1],3)", "1 NaN NaN"],
  ["[b,i] = maxk([NaN 2; 1 NaN; 3 4],2)", "3 1 4 2 3 2 3 1"],
  ["[b,i] = maxk([1+1i 2 NaN -3],2); b = real(b)", "-3 2 4 2"],
  ["[b,i] = mink([1 NaN 3],2)", "1 3 1 3"],
  ["b = maxk([-3 2 -5],2,'ComparisonMethod','abs')", "-5 -3"],
  ["[b,i] = maxk([-3 2 -5 3],2,'ComparisonMethod','abs')", "-5 -3 3 1"],
  ["[b,i] = mink([-3 2 -5 3 NaN],3,'ComparisonMethod','abs')", "2 3 -3 2 4 1"],
  ["[b,i] = sort([-3 2 -5],'descend','ComparisonMethod','abs')", "-5 -3 2 3 1 2"],
  ["[b,i] = sort([-3 2 -5 3],'ComparisonMethod','abs')", "2 3 -3 -5 2 4 1 3"],
  ["[b,i] = sort([NaN 1 3],'descend','MissingPlacement','last')", "3 1 NaN 3 2 1"],
  ["[b,i] = sort([NaN 1 3],'MissingPlacement','first')", "NaN 1 3 1 2 3"],
];

test("maxk's NaN last, 'ComparisonMethod' 'abs' for real input, 'MissingPlacement': as MATLAB orders them", () => {
  const show = (e: string) => `${e}; if exist('i', 'var'), v = [b(:); i(:)]; clear i, else, v = b(:); end, fprintf('%s\\n', strjoin(arrayfun(@(x) sprintf('%g', x), v', 'UniformOutput', false), ' '));`;
  const r = run(ORDER.map(([e]) => show(e)).join("\n"));
  assert.equal(r.status, 0, r.err);
  const got = r.out.trim().split("\n");
  assert.deepEqual(ORDER.map(([e], k) => `${e} -> ${got[k]}`), ORDER.map(([e, w]) => `${e} -> ${w}`));
});

test("divergence and curl: 2-D and 3-D, with coordinates or the default grid, uneven spacing; one output of curl is cav", () => {
  const r = run([
    "[X, Y] = meshgrid([0 1 3 6], [0 2 3]);",
    // (a linear field: every difference is exact, uneven spacing too)
    "d = divergence(X, Y, 2*X + Y, 3*Y - X); fprintf('%g ', unique(d)), fprintf('\\n')",
    "[cz, cav] = curl(X, Y, 2*X + Y, 3*Y - X); fprintf('%g ', unique(cz), unique(cav)), fprintf('\\n')",
    "c1 = curl(X, Y, 2*X + Y, 3*Y - X); disp(isequal(c1, cav))",
    // (the default grid: meshgrid(1:n, 1:m); one output of curl is cav, half of curlz's 2)
    "[U, V] = meshgrid(1:3, 1:4); fprintf('%g ', unique(divergence(U, V)), unique(curl(-V, U))), fprintf('\\n')",
    "[X3, Y3, Z3] = meshgrid(1:3, 1:4, 1:2);",
    "fprintf('%g ', unique(divergence(X3, Y3, Z3, X3, 2*Y3, 3*Z3))), fprintf('\\n')",
    "[cx, cy, cz3, cav3] = curl(X3, Y3, Z3, -Y3, X3, zeros(size(X3))); fprintf('%g ', unique(cx), unique(cy), unique(cz3)), fprintf('\\n')",
    "fprintf('%g ', cav3(2, 2, 1)), fprintf('\\n')",
    "try, divergence(1:3, 1:3), catch e, disp(e.message), end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, [
    "5 ",
    "-2 -1 ",
    "   1",
    "2 1 ",
    "6 ",
    "0 0 2 ",
    "0 ",
    "divergence: the arrays must be matrices, at least 2-by-2.",
    "",
  ].join("\n"));
});

test("writematrix: comma-separated long g, NaN empty, a delimiter, append, no extension adds .txt, N-d columns; spreadsheets refused", () => {
  const r = run([
    "writematrix([1 2.5 NaN; -Inf pi 1e20], 'm.csv')",
    "writematrix(int8([1 -2; 3 4]), 'i.txt', 'Delimiter', 'tab')",
    "writematrix([true false], 'i.txt', 'WriteMode', 'append')",
    "writematrix(single(1/3), 'noext')",
    "writematrix(reshape(1:8, 2, 2, 2), 'nd.dat', 'Delimiter', ';')",
    // (empty arrays, N-d too, are empty files)
    "writematrix(zeros(0, 2, 3), 'e1.csv'), writematrix(zeros(2, 0), 'e2.csv')",
    // (NaN and -0 as written, and long g's rounding, as MATLAB R2026b wrote them, observed 2026-11-21)
    "writematrix([pi 1e20 -0; NaN Inf -Inf; 1/3 123456789012345678 1e-5], 'o.csv')",
    "writematrix(single([NaN -0 1]), 'os.csv')",
    "try, writematrix(1, 'x.xlsx'), catch e, disp(e.message), end",
    "try, writematrix('ab', 'c.csv'), catch e, disp(e.message), end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "writematrix: spreadsheet files are not supported in Sagebrush; write a .csv file instead.\n" +
    "writematrix: only numeric and logical arrays are supported in Sagebrush, not char.\n");
  const f = (n: string) => readFileSync(join(r.dir, n), "utf8");
  assert.equal(f("m.csv"), "1,2.5,NaN\n-Inf,3.14159265358979,1e+20\n");
  assert.equal(f("i.txt"), "1\t-2\n3\t4\n1,0\n");
  assert.equal(f("noext.txt"), "0.3333333\n");
  assert.equal(f("nd.dat"), "1;3;5;7\n2;4;6;8\n");
  assert.equal(f("e1.csv") + f("e2.csv"), "");
  assert.equal(f("o.csv"), "3.14159265358979,1e+20,-0\nNaN,Inf,-Inf\n0.333333333333333,1.23456789012346e+17,1e-05\n");
  assert.equal(f("os.csv"), "NaN,-0,1\n");
});
