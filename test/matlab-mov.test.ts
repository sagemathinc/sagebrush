import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The moving statistics with windows longer than the data. A window reaching past the data's ends adds nothing there
// under 'shrink', so it is cut at the data's length, the same result in time bounded by the data; under 'discard' no
// window lies inside the data, so the result is empty; with a fill value (Sagebrush's reading of the pages: the
// nonexisting elements read as the value, taking part in each window), the fill values outside the data are taken
// together. Each case is checked against the same statistic worked out here on the explicitly padded data.

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-mov-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 120000 });
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
// (MATLAB prints infinities as Inf and -Inf, which Number reads as NaN)
const nums = (s: string) => s.trim().split(/\s+/).filter((t) => t.length).map((t) => (t === "Inf" ? Infinity : t === "-Inf" ? -Infinity : Number(t)));
// (NaN and the infinities are matched exactly, before any tolerance: Infinity <= tol * Infinity would accept anything)
const close = (id: string, g: number[], want: number[], tol: number) => {
  assert.equal(g.length, want.length, `${id}: ${g} / ${want}`);
  g.forEach((v, k) => {
    if (Number.isNaN(want[k])) assert.ok(Number.isNaN(v), `${id}[${k}]: ${v}, expected NaN`);
    else if (!Number.isFinite(want[k])) assert.equal(v, want[k], `${id}[${k}]: ${v}, expected ${want[k]}`);
    else assert.ok(v === want[k] || Math.abs(v - want[k]) <= tol * Math.max(1, Math.abs(want[k])), `${id}[${k}]: ${v}, expected ${want[k]}`);
  });
};

test("the comparison itself: an infinity matches only itself, NaN only NaN, others within the tolerance", () => {
  close("inf", [Infinity, -Infinity, NaN, 1 + 1e-14], [Infinity, -Infinity, NaN, 1], 1e-13);
  for (const [g, want] of [[0, Infinity], [123, Infinity], [-Infinity, Infinity], [Infinity, -Infinity], [NaN, Infinity], [Infinity, NaN], [1.1, 1], [NaN, 1], [Infinity, 1]])
    assert.throws(() => close("control", [g], [want], 1e-13), assert.AssertionError, `${g} accepted for ${want}`);
});
const P = (name: string, expr: string) => `fprintf('${name}|%s\\n', sprintf('%.17g ', double(${expr})));`;

test("a window far longer than the data: the same as one cut at the data's length, at once", () => {
  const got = run([
    "x = [1 NaN 3 NaN NaN 6 7 NaN 2 NaN 4.5 -1 8];",
    ...["movsum", "movmean", "movprod", "movmax", "movmin", "movvar", "movstd", "movmedian"].flatMap((f) => [
      P(`${f}_big`, `${f}(x, 1e9)`), P(`${f}_cut`, `${f}(x, [12 12])`),
      P(`${f}_bigomit`, `${f}(x, 1e15, 'omitnan')`), P(`${f}_cutomit`, `${f}(x, [12 12], 'omitnan')`),
      P(`${f}_bigbf`, `${f}(x, [1e9 0], 'omitnan')`), P(`${f}_cutbf`, `${f}(x, [12 0], 'omitnan')`),
      P(`${f}_bigfb`, `${f}(x, [0 1e9], 'omitnan')`), P(`${f}_cutfb`, `${f}(x, [0 12], 'omitnan')`),
      `fprintf('${f}_discard|%s|%s\\n', mat2str(size(${f}(x, 1e9, 'Endpoints', 'discard'))), mat2str(size(${f}(x', [1e9 0], 'Endpoints', 'discard'))));`,
    ]),
    P("cols_big", "movmean(magic(4), 1e9)"),
    P("cols_cut", "movmean(magic(4), 7)"),
    P("rows_big", "movmedian(magic(4), 1e9, 2)"),
    P("rows_cut", "movmedian(magic(4), 7, 2)"),
    P("discard_fits", "movmean([1 2 3 4], [1 2], 'Endpoints', 'discard')"),
    P("dim_far", "movmean([1 NaN 3], 3, 1e15)"),
    "try, movmean([1 2 3], Inf), catch e, fprintf('inf|%s\\n', e.message), end",
    "try, movmean([1 2 3], [Inf 0]), catch e, fprintf('inf2|%s\\n', e.message), end",
  ]);
  for (const f of ["movsum", "movmean", "movprod", "movmax", "movmin", "movvar", "movstd", "movmedian"]) {
    for (const [big, cut] of [["big", "cut"], ["bigomit", "cutomit"], ["bigbf", "cutbf"], ["bigfb", "cutfb"]])
      assert.deepEqual(field(got, `${f}_${big}`), field(got, `${f}_${cut}`), `${f} ${big}`);
    // (no complete window: 1-by-0 along the row, 0-by-1 down the column)
    assert.deepEqual(field(got, `${f}_discard`), ["[1 0]", "[0 1]"], f);
  }
  assert.deepEqual(field(got, "cols_big"), field(got, "cols_cut"));
  assert.deepEqual(field(got, "rows_big"), field(got, "rows_cut"));
  // (the windows [i-1, i+2] wholly inside 1:4: only the first, mean 2.5)
  assert.deepEqual(nums(field(got, "discard_fits")[0]), [2.5]);
  // (along a dimension of length 1, each element is its own window)
  close("dim_far", nums(field(got, "dim_far")[0]), [1, NaN, 3], 0);
  assert.match(field(got, "inf")[0], /finite/);
  assert.match(field(got, "inf2")[0], /finite/);
});

test("a fill value with a window past the data: the statistic of the padded data, the fill values taken together", () => {
  // (each case against the statistic of the explicitly padded window, worked out in a loop: [b f] windows past the
  // data's ends on both sides, by 1 and by many, and on one side only, where the last (or first) element's window
  // holds the data and the fill values past the far end alone; the fill value 0, 2.5, NaN ('fill') and 9 and -9,
  // beyond the data's values, so that a maximum, a minimum or a median shows each fill value counted; with and
  // without 'omitnan'; a median's fill values outnumbering the data by fewer than two, by two and by many)
  const x = "[4 NaN 8 6 -1 2.5]";
  const lines = [`x = ${x};`];
  const cases: string[] = [];
  for (const [b, f] of [[1, 0], [0, 1], [3, 2], [6, 0], [7, 1], [9, 4], [20, 3], [3, 20], [20, 0], [0, 20], [21, 21]])
    for (const v of ["0", "2.5", "9", "-9", "NaN"])
      for (const omit of ["'includenan'", "'omitnan'"])
        for (const s of ["sum", "mean", "max", "min", "median", "var"]) {
          const id = `${s}_${b}_${f}_${v}_${omit.slice(1, 5)}`.replace(/[.-]/g, "m");
          cases.push(id);
          const ends = v === "NaN" ? "'fill'" : v;
          lines.push(
            `y = mov${s}(x, [${b} ${f}], ${omit}, 'Endpoints', ${ends}); p = [${v} * ones(1, ${b}) x ${v} * ones(1, ${f})]; z = zeros(1, 6);`,
            `for i = 1:6, w = p(i:i + ${b + f}); if strcmp(${omit}, 'omitnan'), w = w(~isnan(w)); elseif any(isnan(w)), w = NaN; end, if isempty(w), z(i) = NaN; else, z(i) = ${s === "sum" ? "sum(w)" : s === "var" ? "var(w)" : `${s}(w)`}; end, end`,
            `fprintf('${id}|%s|%s\\n', sprintf('%.17g ', y), sprintf('%.17g ', z));`,
          );
        }
  // (complex data's sums and products, with an infinite fill value, against the padded data's windows taken offset by
  // offset in order, each step a complex product written out by parts, (a + bi)(c + di) = (ac - bd) + (ad + bc)i, the
  // padded array being complex throughout: so an infinite factor meeting a zero part gives NaN parts, as one at a time)
  lines.push("c = [1+1i 2-1i 0.5i];");
  for (const [b, f] of [[3, 0], [0, 3], [0, 9], [9, 9]])
    for (const v of ["2", "Inf"])
      for (const s of ["sum", "prod"]) {
        const id = `c${s}_${b}_${f}_${v}`;
        cases.push(id);
        lines.push(
          `y = mov${s}(c, [${b} ${f}], 'Endpoints', ${v}); p = [${v} * ones(1, ${b}) c ${v} * ones(1, ${f})]; z = complex(zeros(1, 3));`,
          `zr = ${s === "sum" ? "zeros" : "ones"}(1, 3); zi = zeros(1, 3); pr = real(p); pq = imag(p);`,
          `for j = 1:${b + f + 1}, a = pr(j:j + 2); d = pq(j:j + 2); ${s === "sum" ? "zr = zr + a; zi = zi + d;" : "t = zr .* a - zi .* d; zi = zr .* d + zi .* a; zr = t;"} end, z = complex(zr, zi);`,
          `fprintf('${id}|%s|%s\\n', sprintf('%.17g ', [real(y); imag(y)]), sprintf('%.17g ', [real(z); imag(z)]));`,
        );
      }
  const got = run(lines);
  for (const id of cases) {
    const [y, z] = field(got, id).map(nums);
    // (a sum of the same values in another order: exact for max, min and median, within a few roundings else; an
    // empty sum is 0, as movsum's)
    const exact = /^(max|min|median)/.test(id);
    close(id, y, id.startsWith("sum") ? z.map((t, k) => (Number.isNaN(t) && !Number.isNaN(y[k]) && y[k] === 0 ? 0 : t)) : z, exact ? 0 : 1e-13);
  }
});

test("a fill value with a window of 1e9: counted, not walked; exact where the sums are", () => {
  const got = run([
    P("sum", "movsum([1 2 3], 1e9, 'Endpoints', 2)"),
    P("mean", "movmean([1 2 3], 1e9, 'Endpoints', 2)"),
    P("prod", "movprod([1 2 3], 1e9, 'Endpoints', 1)"),
    P("max", "movmax([1 2 3], 1e9, 'Endpoints', 100)"),
    P("min", "movmin([1 2 3], 1e9, 'Endpoints', -5)"),
    P("median", "movmedian([1 2 3], 1e9, 'Endpoints', 2.5)"),
    P("var", "movvar([1 2 3], 1e9, 'Endpoints', 2)"),
    P("nan", "movmean([1 2 3], 1e9, 'Endpoints', 'fill')"),
    P("nanomit", "movmean([1 2 3], 1e9, 'Endpoints', 'fill', 'omitnan')"),
    P("nanmedian", "movmedian([1 2 3], 1e9, 'Endpoints', 'fill', 'omitnan')"),
    P("nanback", "movmean([1 2 3], [5 0], 'Endpoints', 'fill')"),
    P("medback", "movmedian([1 2 3], [9 0], 'Endpoints', -9)"),
    P("medfront", "movmedian([1 2 3], [0 9], 'Endpoints', 9)"),
    P("prododd", "movprod([1 1], [1e16 0], 'Endpoints', -1)"),
    P("prododdf", "movprod([1 1], [0 1e16], 'Endpoints', -1)"),
    P("prodsmall", "movprod([1 1], [5 0], 'Endpoints', -1)"),
    P("prodnegzero", "movprod([1 1], [0 1e16], 'Endpoints', -0)"),
    P("prodhalf", "movprod([1 1], [1e16 0], 'Endpoints', -0.5)"),
    P("prodtwo", "movprod([1 1], [1e16 0], 'Endpoints', -2)"),
    P("prodtwof", "movprod([1 1], [0 1e16], 'Endpoints', -2)"),
    P("prodomit", "movprod([1 NaN], [1e16 0], 'omitnan', 'Endpoints', -1)"),
  ]);
  const f = (id: string) => nums(field(got, id)[0]);
  // (a window of 1e9 holds the 3 values and 1e9 - 3 fill values at every position)
  assert.deepEqual(f("sum"), [2e9, 2e9, 2e9]);
  close("mean", f("mean"), [2, 2, 2], 1e-15);
  assert.deepEqual(f("prod"), [6, 6, 6]);
  assert.deepEqual(f("max"), [100, 100, 100]);
  assert.deepEqual(f("min"), [-5, -5, -5]);
  assert.deepEqual(f("median"), [2.5, 2.5, 2.5]);
  // (the values' squared deviations from the mean 2 are 1, 0 and 1: 2 over 1e9 - 1)
  close("var", f("var"), [2 / (1e9 - 1), 2 / (1e9 - 1), 2 / (1e9 - 1)], 1e-12);
  close("nan", f("nan"), [NaN, NaN, NaN], 0);
  assert.deepEqual(f("nanomit"), [2, 2, 2]);
  assert.deepEqual(f("nanmedian"), [2, 2, 2]);
  // (the last element's window holds all the data and fill values past the start only: NaN, from those alone)
  close("nanback", f("nanback"), [NaN, NaN, NaN], 0);
  // (the last element's window: 7 fill values past the start and the 3 values, median -9; with only the 3 values'
  // count and two more of the fill value, 5, it would be (-9 + 1) / 2; the first's, past the end, the same at 9)
  assert.deepEqual(f("medback"), [-9, -9, -9]);
  assert.deepEqual(f("medfront"), [9, 9, 9]);
  // (a negative fill value's sign from the count's parity past 2^53, where a double holds only even integers: with
  // [1e16 0] on 2 elements, the first element's window holds 1e16 fill values (even) and the second's 1e16 - 1 (odd);
  // [0 1e16] the same the other way round; [5 0], a small control, 5 and 4; a -0 fill keeps its sign at an odd count,
  // and |-0.5| to such a power underflows to a zero of that sign)
  assert.deepEqual(f("prododd"), [1, -1]);
  assert.deepEqual(f("prododdf"), [-1, 1]);
  assert.deepEqual(f("prodsmall"), [-1, 1]);
  assert.ok(Object.is(f("prodnegzero")[0], -0) && Object.is(f("prodnegzero")[1], 0), `prodnegzero: ${f("prodnegzero")}`);
  assert.ok(Object.is(f("prodhalf")[0], 0) && Object.is(f("prodhalf")[1], -0), `prodhalf: ${f("prodhalf")}`);
  // (-2 to such a power overflows to an infinity of that sign; 'omitnan' leaves the NaN out and the sign the same)
  assert.deepEqual(f("prodtwo"), [Infinity, -Infinity]);
  assert.deepEqual(f("prodtwof"), [-Infinity, Infinity]);
  assert.deepEqual(f("prodomit"), [1, -1]);
});

test("the moving statistics admitted before their copies are made (test/matlab_mov_admit_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_mov_admit_cases.py")], { encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 3, r.stdout);
});
