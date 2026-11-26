import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// smoothdata against MATLAB R2026b's rows (test/matlab-smoothdata-oracle.json): each method's kernel at the data's
// ends and inside, windows of every shape, NaN, robust refits, degrees, classes and errors. The window MATLAB chooses
// from the data is refused in Sagebrush (its heuristic isn't documented), as is 'SamplePoints'.

const cli = join(__dirname, "..", "src", "cli.js");
const oracle = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "matlab-smoothdata-oracle.json"), "utf8"));

/** NAME -> the fields after it, for each row the program printed */
function run(program: string[]): Map<string, string[]> {
  const dir = mkdtempSync(join(tmpdir(), "sb-smooth-"));
  writeFileSync(join(dir, "main.m"), program.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 600000 });
  assert.equal(r.status, 0, r.stderr);
  const got = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    const f = line.split("|");
    // (a row: NAME|...; the display of the probe's own function handle isn't one)
    if (f.length >= 2 && /^[A-Za-z]\w*$/.test(f[0]) && !got.has(f[0])) got.set(f[0], f.slice(1));
  }
  return got;
}

const nums = (s: string) => s.trim().split(/\s+/).filter((t) => t.length).map((t) => (t === "Inf" ? Infinity : t === "-Inf" ? -Infinity : Number(t)));
// (the window MATLAB chooses from the data: refused)
const chosenWindow = (name: string) => /^A_|_def_|^sf_|^def_/.test(name);

function check(rows: string[], got: Map<string, string[]>): number {
  let compared = 0;
  const names = new Set(rows.map((r) => r.split("|")[0]));
  // (a row MATLAB didn't print: only a refused call's, which the probe's catch names by its line, as NAME_Lnn)
  for (const [name, g] of got) {
    if (!names.has(name)) assert.match(g.join("|"), /^ERROR\|.*the window MATLAB chooses from the data is not yet supported/, name);
  }
  for (const row of rows) {
    const [name, ...want] = row.split("|");
    const g = got.get(name);
    if (chosenWindow(name)) {
      // (refused: its row is the refusal, or under the catch's own name, checked above)
      if (g) assert.match(g.join("|"), /^ERROR\|.*the window MATLAB chooses from the data is not yet supported/, name);
      continue;
    }
    assert.ok(g, `${name}: no row`);
    if (name === "sp") {
      assert.match(g.join("|"), /^ERROR\|.*'SamplePoints' is not supported/, name);
      continue;
    }
    compared++;
    if (want[0] === "ERROR" || g[0] === "ERROR") {
      // (an error: MATLAB's identifier; the wording is MATLAB's where it is known)
      assert.deepEqual(g.slice(0, 2), want.slice(0, 2), `${name}: ${g}`);
      continue;
    }
    assert.equal(g.length, want.length, `${name}: ${g}`);
    want.forEach((w, k) => {
      if (!/\d|NaN|Inf/.test(w) || /[a-z]{2}/i.test(w.replace(/NaN|Inf/g, ""))) {
        assert.equal(g[k].trim(), w.trim(), `${name}[${k}]`);
        return;
      }
      const a = nums(g[k]), b = nums(w);
      assert.equal(a.length, b.length, `${name}[${k}]: ${g[k]} / ${w}`);
      // (within 1e-12 of the row's largest magnitude; B's rows, rounding noise near 1e-15, within 1e-12 absolutely)
      const scale = name.startsWith("B_") ? 1 : Math.max(1, ...b.filter(Number.isFinite).map(Math.abs));
      b.forEach((v, j) => {
        if (Number.isNaN(v)) assert.ok(Number.isNaN(a[j]), `${name}[${k}][${j}]: ${a[j]}, expected NaN`);
        else if (!Number.isFinite(v)) assert.equal(a[j], v, `${name}[${k}][${j}]`);
        else assert.ok(Math.abs(a[j] - v) <= 1e-12 * scale, `${name}[${k}][${j}]: ${a[j]}, expected ${v}`);
      });
    });
  }
  return compared;
}

test("smoothdata's kernels, ends, outliers, NaN, degrees, dimensions, classes and errors as MATLAB's (oracle p9)", () => {
  const n = check(oracle.p9.rows, run(oracle.p9.program));
  // (every row but the chosen window's and SamplePoints')
  assert.equal(n, 79);
});

test("smoothdata's robust refits near an exact fit, NaN inside windows, and small and long windows as MATLAB's (oracle p9b)", () => {
  const n = check(oracle.p9b.rows, run(oracle.p9b.program));
  assert.equal(n, 176);
});

test("smoothdata: the window and its second output, the refusals, and the class of the result", () => {
  const got = run([
    "[B, w] = smoothdata([1 4 2 8 5], 'gaussian', [2 1]); fprintf('w|%s|%s\\n', mat2str(size(w)), mat2str(w));",
    "[B, w] = smoothdata([1 4 2 8 5]', 'movmean', 2.5); fprintf('wcol|%s|%s|%s\\n', mat2str(size(B)), mat2str(w), mat2str(B', 6));",
    "try, smoothdata([1 2 3]), catch e, fprintf('def|%s\\n', e.message), end",
    "try, smoothdata([1 2 3], 'lowess', 0.5), catch e, fprintf('tiny|%s\\n', e.message), end",
    "try, smoothdata([1 2 3], 'lowess', 3, 'Degree', 1), catch e, fprintf('degsg|%s\\n', e.message), end",
    "fprintf('cls|%s|%s|%s\\n', class(smoothdata(single([1 2 3]), 'lowess', 3)), class(smoothdata(uint8([1 2 3]), 'gaussian', 3)), class(smoothdata(true(1, 3), 'sgolay', 3)));",
    "fprintf('empty|%s\\n', mat2str(size(smoothdata(zeros(0, 3), 'rloess', 5))));",
  ]);
  assert.deepEqual(got.get("w"), ["[1 2]", "[2 1]"]);
  // (a column: smoothed down it, the result a column; 2.5 takes the samples at offsets in [-1.25, 1.25))
  assert.deepEqual(got.get("wcol"), ["[5 1]", "2.5", "[2.5 2.33333 4.66667 5 6.5]"]);
  assert.match(got.get("def")!.join("|"), /window MATLAB chooses from the data is not yet supported/);
  assert.match(got.get("tiny")!.join("|"), /must hold at least one sample/);
  assert.match(got.get("degsg")!.join("|"), /'Degree' is supported only by the 'sgolay' method/);
  assert.deepEqual(got.get("cls"), ["single", "double", "double"]);
  assert.deepEqual(got.get("empty"), ["[0 3]"]);
});
