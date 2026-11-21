import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB's A \ B for a real square A (lib/_matlab.py _solve, src/runtime/numpy_linalg.ts mldivide): on engine/nd,
// nd_solve's MATLAB mode (the structure pass, then rcond from the factors it solved with); without WebAssembly,
// LU and the same estimate (gecon). Both at every size: the nearly-singular check used to refactor A in Python
// and ran only up to 500 rows, so a nearly singular matrix with more rows never warned (design/numeric-track.md
// §3). Each test runs on both backends: rcond's estimate is each backend's own, the warning's decision is not.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string, noWasm: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "sb-mldiv-"));
  writeFileSync(join(dir, "main.m"), src);
  const env = { ...process.env, SAGEBRUSH_NO_WASM: noWasm ? "1" : "" };
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", env });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const BACKENDS: [string, boolean][] = [["engine/nd", false], ["TypeScript", true]];

for (const [name, noWasm] of BACKENDS) {
  test(`${name}: a nearly singular 600 x 600 matrix warns (the check no longer stops at 500 rows)`, () => {
    const r = run([
      "rng(7); A = rand(600); A(:, 600) = A(:, 1) + 1e-17 * rand(600, 1);",
      "lastwarn(''); x = A \\ ones(600, 1); [m, id] = lastwarn(); disp(id)",
      "rng(7); B = rand(600); [m, id] = lastwarn(''); y = B \\ ones(600, 1); [m, id] = lastwarn(); disp(isempty(id))",
    ].join("\n"), noWasm);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /Warning: Matrix is close to singular or badly scaled\. Results may be inaccurate\. RCOND = {2}\d\.\d{6}e-\d\d\./);
    assert.equal(r.out, "MATLAB:nearlySingularMatrix\n   1\n");
  });

  test(`${name}: singular, diagonal, triangular, symmetric positive definite and general solves`, () => {
    const r = run([
      // (singular: MATLAB's warning and the Inf and NaN its elimination gives, as an observed MATLAB run printed
      // magic(8) \\ ones(8, 1) on Nov 4 2026: the oracle engine/nd's magic(8) fixture pins, numerics P2b-2)
      "x = magic(8) \\ ones(8, 1); disp(isnan(x(1:5))'), disp(x(6:7)')",
      // (consistent singular systems, symmetric and not: LU's own result, as MATLAB prints it, NaN NaN)
      "x = [1 2; 2 4] \\ [1; 2]; disp(x')",
      "x = [1 2; 3 6] \\ [1; 3]; disp(x')",
      // (diagonal: rcond exactly min|d| / max|d|)
      "x = diag([1 1e-20 3]) \\ [1; 1; 1];",
      "rng(3); n = 300; b = rand(n, 2);",
      "L = tril(rand(n)) + n * eye(n); U = L'; S = rand(n); S = S' * S + n * eye(n); G = rand(n) + n * eye(n);",
      "r = @(A, X) norm(A * X - b, 1) / (norm(A, 1) * norm(X, 1) + norm(b, 1));",
      "fprintf('%d\\n', [r(L, L \\ b), r(U, U \\ b), r(S, S \\ b), r(G, G \\ b)] < 300 * eps)",
    ].join("\n"), noWasm);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "   1   1   1   1   1\n   Inf  -Inf\n   NaN   NaN\n   NaN   NaN\n1\n1\n1\n1\n");
    assert.equal(r.err, [
      "Warning: Matrix is singular to working precision.",
      "Warning: Matrix is singular to working precision.",
      "Warning: Matrix is singular to working precision.",
      "Warning: Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND =  3.333333e-21.",
      "",
    ].join("\n"));
  });

  test(`${name}: singular systems as an observed MATLAB run prints them, Inf, NaN and signs`, () => {
    // (MATLAB R2026b Update 2, MATLAB Online, 2026-11-21: values and warnings only. No step of the substitution
    // is skipped, so 0/0 and 0 * Inf are NaN; a diagonal A is forward-substituted; a -0 pivot flips the sign)
    const rows: [string, string, string][] = [
      ["[1 2;2 4]", "[1;2]", "[NaN NaN]"], ["[1 2;3 6]", "[1;3]", "[NaN NaN]"], ["[2 4;1 2]", "[1;2]", "[-Inf Inf]"],
      ["[1 2;0 0]", "[1;1]", "[-Inf Inf]"], ["[1 2;0 0]", "[1;0]", "[NaN NaN]"], ["[0 1;0 1]", "[1;1]", "[NaN 1]"],
      ["[0 0;0 0]", "[1;1]", "[Inf NaN]"], ["[0 0;0 0]", "[0;0]", "[NaN NaN]"], ["[-0 1;0 1]", "[0;1]", "[Inf 1]"],
      // (lower triangles, the corpus addendum of the same day: no zero step is skipped there either)
      ["[0 0;1 1]", "[0;1]", "[NaN NaN]"], ["[0 0;1 1]", "[1;1]", "[Inf -Inf]"], ["[1 0;1 0]", "[1;1]", "[1 NaN]"],
      ["[0 0 0;1 1 0;1 1 1]", "[0;1;1]", "[NaN NaN NaN]"],
    ];
    const src = rows.map(([a, b]) => `lastwarn(''); x = ${a} \\ ${b}; [~, id] = lastwarn(); fprintf('%s %s\\n', mat2str(x'), id);`).join("\n");
    const r = run(src, noWasm);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, rows.map(([, , x]) => `${x} MATLAB:singularMatrix\n`).join(""));
    // (the -0 pivot's +Inf, and a nonsingular diagonal's exact quotients and signed zero: [2 0;0 3] \\ [1;1] is
    // [0.5; 1/3] to the last bit (the correctly rounded quotients, 3fe0... and 3fd5...), [1 0;0 1] \\ [-0;0] is [-0; 0])
    const s = run("x = [-0 1;0 1] \\ [0;1]; disp(x(1) == Inf)\nx = [2 0;0 3] \\ [1;1]; disp([x(1) == 0.5, x(2) == 1/3])\nx = [1 0;0 1] \\ [-0;0]; disp(1./x')", noWasm);
    assert.equal(s.status, 0, s.err);
    assert.equal(s.out, "   1\n   1   1\n  -Inf   Inf\n");
  });

  // (a known gap against design §1, not the contract: MATLAB computes with an Inf or NaN and warns, RCOND = NaN;
  // Sagebrush refuses, as before this change. Pinned so the gap stays visible until it is closed: issue #1500.)
  test(`${name}: an Inf or NaN in A or B is still refused before the solve (a known gap)`, () => {
    const r = run("x = [1 2; 3 NaN] \\ [1; 1];", noWasm);
    assert.notEqual(r.status, 0);
    assert.ok((r.out + r.err).includes("of values that include Inf or NaN is not supported in Sagebrush"), r.out + r.err);
  });
}
