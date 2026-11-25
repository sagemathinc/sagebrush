import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A \ b for a sparse triangular A by substitution (lib/_matlab_lu.py triangular_solve): the results against the full
// matrix's solve, lower and upper, diagonal, complex, several right-hand sides or none, a sparse b, on both sides of
// the n = 4000 switch; a zero diagonal's warning and the infinities substitution carries; and the route, meter and
// admission cases (test/matlab_sparse_triangular_cases.py).

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): { rows: Map<string, string[]>; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "sb-tri-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 600000 });
  assert.equal(r.status, 0, r.stderr);
  const rows = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    const [id, ...rest] = line.split("|");
    if (rest.length && !rows.has(id)) rows.set(id, rest);
  }
  return { rows, out: r.stdout, err: r.stderr };
}

test("lower, upper, diagonal and complex sparse triangular solves agree with the full solve, n on both sides of 4000", () => {
  // (against the full matrix's solve at n = 7 and 300; at 4000 and 4001, where a full solve takes minutes, by the
  // normwise backward error norm(A*x - b)/(norm(A, 1)*norm(x) + norm(b)))
  const lines: string[] = [];
  const be = (A: string, x: string, b: string) => `norm(${A}*${x} - ${b}, 'fro')/(norm(${A}, 1)*norm(${x}, 'fro') + norm(${b}, 'fro'))`;
  for (const n of [7, 300, 4000, 4001]) {
    const full = n < 1000;
    lines.push(
      `n = ${n}; rng(${n});`,
      "L = tril(sprandn(n, n, 3/n)) + spdiags(2 + rand(n, 1), 0, n, n); U = L'; b = randn(n, 3);",
      "D = spdiags(1 + rand(n, 1), 0, n, n); Lc = L + 1i*tril(sprandn(n, n, 2/n), -1);",
      "xl = L\\b; xu = U\\b; xd = D\\b; xc = Lc\\b;",
      full
        ? `fprintf('L${n}|%.3g|%d\\n', norm(xl - full(L)\\b, 'fro')/norm(full(L)\\b, 'fro'), isequal(size(xl), [n 3]));`
        : `fprintf('L${n}|%.3g|%d\\n', ${be("L", "xl", "b")}, isequal(size(xl), [n 3]));`,
      full
        ? `fprintf('U${n}|%.3g\\n', norm(xu - full(U)\\b, 'fro')/norm(full(U)\\b, 'fro'));`
        : `fprintf('U${n}|%.3g\\n', ${be("U", "xu", "b")});`,
      `fprintf('D${n}|%.3g\\n', norm(xd - b./diag(D), 'fro')/norm(b./diag(D), 'fro'));`,
      full
        ? `fprintf('C${n}|%.3g\\n', norm(xc - full(Lc)\\b, 'fro')/norm(full(Lc)\\b, 'fro'));`
        : `fprintf('C${n}|%.3g\\n', ${be("Lc", "xc", "b")});`,
      `x0 = L\\zeros(n, 0); fprintf('K${n}|%s\\n', mat2str(size(x0)));`,
      `bs = sparse([1; zeros(n - 1, 1)]); xs = L\\bs; fprintf('S${n}|%d|%.3g\\n', issparse(xs), ${be("L", "full(xs)", "full(bs)")});`,
    );
  }
  const { rows } = run(lines);
  for (const n of [7, 300, 4000, 4001]) {
    for (const id of ["L", "U", "D", "C"]) assert.ok(Number(rows.get(id + n)![0]) < 1e-12, `${id}${n}: ${rows.get(id + n)}`);
    assert.equal(rows.get("L" + n)![1], "1");
    assert.deepEqual(rows.get("K" + n), [`[${n} 0]`]);
    assert.equal(rows.get("S" + n)![0], "1"); assert.ok(Number(rows.get("S" + n)![1]) < 1e-12);
  }
});

test("a zero diagonal: MATLAB's singular warning, and the infinities substitution carries on from it", () => {
  const { rows, err } = run([
    "e = ones(6, 1);",
    "S = tril(spdiags([e e], -1:0, 6, 6)); S(3, 3) = 0; x = S\\(1:6)'; fprintf('low|%s\\n', mat2str(x'));",
    "U = triu(spdiags([e 2*e], 0:1, 6, 6)); U(4, 4) = 0; y = U\\(1:6)'; fprintf('up|%s\\n', mat2str(y'));",
  ]);
  assert.deepEqual(rows.get("low"), ["[1 1 Inf -Inf Inf -Inf]"]);
  assert.deepEqual(rows.get("up"), ["[-Inf Inf -Inf Inf -7 6]"]);
  assert.equal(err.split("Warning: Matrix is singular to working precision.").length - 1, 2, err);
});

test("routes, meter, admission and kernel bounds (test/matlab_sparse_triangular_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_sparse_triangular_cases.py")], { encoding: "utf8", timeout: 600000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 11, r.stdout);
});
