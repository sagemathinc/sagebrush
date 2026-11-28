import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

  test(`${name}: small symmetric positive definite systems are solved by LU, exactly as MATLAB prints them`, () => {
    // (observed MATLAB R2026b, 2026-11-22, values only: MATLAB takes Cholesky only from n = 17, so these come out
    // exact, where Cholesky gives 0.99999999999999978, -2.0000000000000004, 3.0000000000000004)
    const r = run([
      "x = [4 -2 1; -2 4 -2; 1 -2 4] \\ [11; -16; 17]; fprintf('%.17g ', x); disp(isequal(x, [1; -2; 3]))",
      "x = [2 1; 1 2] \\ [3; 3]; fprintf('%.17g ', x); disp(isequal(x, [1; 1]))",
    ].join("\n"), noWasm);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "1 -2 3    1\n1 1    1\n");
  });

  test(`${name}: n I + ones(n) at n = 16 (LU) and n = 17 (Cholesky), near MATLAB's answer`, () => {
    // (MATLAB R2026b, observed 2026-11-22: x for b = A * (1:n)', exact b; its LAPACK sums in its own order, so the
    // bits differ by a few ulps, but the route shows: the other route is 21 (n = 16) and 55 (n = 17) ulps away)
    const matlab: Record<number, string> = {
      16: "3ff0000000000000 4000000000000000 4008000000000000 4010000000000001 4014000000000001 4018000000000001 " +
        "401c000000000001 4020000000000000 4022000000000001 4024000000000000 4025ffffffffffff 4027ffffffffffff " +
        "402a000000000000 402c000000000000 402e000000000000 4030000000000000",
      17: "3fefffffffffffef 3ffffffffffffffa 4007fffffffffffd 4010000000000003 4013ffffffffffff 4017fffffffffffd " +
        "401c000000000006 4020000000000000 4022000000000001 4023ffffffffffff 4026000000000000 4028000000000001 " +
        "402a000000000001 402c000000000002 402dffffffffffff 4030000000000000 4031000000000000",
    };
    const r = run("for n = [16 17], A = n*eye(n) + ones(n); x = A \\ (A*(1:n)'); fprintf('%d', n); " +
      "for k = 1:n, fprintf(' %s', num2hex(x(k))); end; fprintf('\\n'); end", noWasm);
    assert.equal(r.status, 0, r.err);
    for (const line of r.out.trim().split("\n")) {
      const [n, ...got] = line.split(" ");
      const want = matlab[Number(n)].split(" ");
      const d = got.map((h, k) => Number(BigInt("0x" + h) - BigInt("0x" + want[k]))).map(Math.abs);
      const total = d.reduce((s, v) => s + v, 0);
      assert.ok(total <= (n === "16" ? 1 : 6) && Math.max(...d) <= 4, `n = ${n}: ${total} ulps in all, ${Math.max(...d)} at most`);
    }
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

  // (an empty A: 0x0 \ 0x0 is 0x0 and 0x0 \ 0x5 is 0x5, with no warning; the square route once reshaped B to
  // (0, -1) and failed. The numbl corpus's linear_algebra/test_mldivide_empty.m checks the non-square cases too)
  test(`${name}: an empty square A gives an empty X of B's column count`, () => {
    const r = run("lastwarn(''); X = zeros(0,0) \\ zeros(0,0); Y = zeros(0,0) \\ zeros(0,5); [~, id] = lastwarn();\ndisp([size(X), size(Y), isempty(id)])", noWasm);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "     0     0     0     5     1\n");
    assert.equal(r.err, "");
  });

  // (a well-conditioned A scaled to the bottom of the range, A = 2^-1022 (I + P/8), P the cyclic shift: MATLAB
  // R2026b's rcond(A) is 0 there (LAPACK's dgecon stops at its scaling guard), yet A \ b gives no warning and the
  // finite solution, 2^1022 / 1.125 in every entry (observed 2026-11-28, n = 2 and n = 8). So the warning's
  // estimate is not rcond's: an rcond of 0 alone must not make A \ b warn)
  test(`${name}: A scaled by 2^-1022 solves without a warning, though MATLAB's rcond(A) is 0 there`, () => {
    const r = run([
      "for n = [2 8], A = 2^-1022 * (eye(n) + circshift(eye(n), 1, 2) / 8);",
      "  lastwarn(''); x = A \\ ones(n, 1); [~, id] = lastwarn(); fprintf('%d %d %s\\n', n, isempty(id), num2hex(x(1))); end",
    ].join("\n"), noWasm);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "2 1 7fcc71c71c71c71c\n8 1 7fcc71c71c71c71c\n");
    assert.equal(r.err, "");
  });

  // (a known gap against design §1, not the contract: MATLAB computes with an Inf or NaN and warns, RCOND = NaN;
  // Sagebrush refuses, as before this change. Pinned so the gap stays visible until it is closed: issue #1500.)
  test(`${name}: an Inf or NaN in A or B is still refused before the solve (a known gap)`, () => {
    const r = run("x = [1 2; 3 NaN] \\ [1; 1];", noWasm);
    assert.notEqual(r.status, 0);
    assert.ok((r.out + r.err).includes("of values that include Inf or NaN is not supported in Sagebrush"), r.out + r.err);
  });
}

test("the TypeScript path's Cholesky gives engine/nd's bits for a symmetric positive definite A with 17 <= n <= 64", () => {
  // (engine/nd factors up to 64 columns unblocked (dpotf2), and the TypeScript path follows its arithmetic order,
  // so the two backends agree bit for bit there; and a matrix that is not positive definite falls back to LU on both)
  const src = [
    "rng(5); for n = [17 30 64], M = rand(n); A = M' * M + n * eye(n); b = rand(n, 2); x = A \\ b;",
    "  fprintf('%s ', num2hex(x(:))'); fprintf('\\n'); end",
    "A = ones(17) + 0.5 * eye(17); A(1, 1) = 0.5; x = A \\ (1:17)'; fprintf('%.17g ', x); fprintf('\\n');",
    // (positive definite and exactly symmetric but nearly singular, R = triu(ones(n)) with R(n, n) = 1e-7 and
    // A = R' R: Cholesky succeeds ([~, p] = chol(A) is 0; MATLAB's decomposition(A).Type is 'chol') and rcond from
    // its factor is below eps, so A \\ b warns; MATLAB R2026b, observed 2026-11-22, prints the same warnings,
    // RCOND = 1.937844e-16 at n = 20 and 6.548781e-17 at n = 40, and x(1:2) = [1 0] exactly)
    "for n = [20 40], R = triu(ones(n)); R(n, n) = 1e-7; A = R' * R; A = (A + A') / 2;",
    "  [~, p] = chol(A); lastwarn(''); x = A \\ ones(n, 1); [~, id] = lastwarn();",
    "  fprintf('%d %d %s %s %s\\n', n, p, id, num2hex(x(1)), num2hex(x(2))); end",
  ].join("\n");
  const nd = run(src, false), ts = run(src, true);
  assert.equal(nd.status, 0, nd.err);
  assert.equal(ts.status, 0, ts.err);
  assert.equal(ts.out, nd.out);
  assert.match(nd.out, /\n20 0 MATLAB:nearlySingularMatrix 3ff0000000000000 0000000000000000\n40 0 MATLAB:nearlySingularMatrix 3ff0000000000000 0000000000000000\n$/);
  // (MATLAB's warnings, character for character, from the Cholesky factor's rcond on each backend)
  assert.equal(nd.err, "Warning: Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND =  1.937844e-16.\n" +
    "Warning: Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND =  6.548781e-17.\n");
  assert.equal(ts.err, nd.err);
});

test("the TypeScript path's estimate does not overflow on a finite sum near the largest double", () => {
  // (mldivide's fifth value is its rcond estimate. For A = 2^-1022 (I + P/8) at n = 2 the true rcond is 7/9; the
  // alternating vector's solved sum is finite but above half the largest double, so doubling it before the
  // division by 3n gave Infinity and an estimate of 0. The warning cannot show this, since 0 does not warn)
  const code = [
    "import numpy as np, _nplinalg",
    "A = 2.0 ** -1022 * (np.eye(2) + np.roll(np.eye(2), 1, axis=1) / 8)",
    "print(float(_nplinalg.mldivide(A, np.ones((2, 1)))[4]).hex())",
  ].join("\n");
  const out = execFileSync(process.execPath, [cli, "-c", code], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_WASM: "1" } });
  assert.equal(out.trim(), "0x1.8e38e38e38e39p-1");
});

test("the TypeScript path warns as MATLAB does where its estimate's extra term once overflowed", () => {
  // (A = 2^-968.5 [1 1; 1 1+2^-52], A \ [1; 2]: MATLAB R2026b, observed 2026-11-28, warns nearly singular with
  // RCOND = 3.925231e-17 in the message, although its rcond(A) is 0 there (LAPACK's scaling guard: the warning's
  // estimate is not rcond's), and x(1) is ffbfffffffffffff. With the extra term doubled before the division
  // by 3n, the estimate overflowed to 0 and the solve was silent)
  const r = run("lastwarn(''); x = 2^-968.5 * [1 1; 1 1+2^-52] \\ [1; 2]; [~, id] = lastwarn(); fprintf('%s %s\\n', id, num2hex(x(1)));", true);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "MATLAB:nearlySingularMatrix ffbfffffffffffff\n");
  assert.equal(r.err, "Warning: Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND =  3.925231e-17.\n");
});

test("the TypeScript path's rcond at the largest double is 1, not Infinity", () => {
  // (lower [realmax 0; 1 realmax]: ||A||_1 = realmax, ||A^-1||_1 = 1 / realmax + 1 / realmax^2, rcond 1 to
  // rounding; the estimate is a subnormal whose reciprocal overflows, and (1 / est) / anorm was Infinity.
  // mldivide's fifth value is the estimate)
  const code = [
    "import sys, numpy as np, _nplinalg",
    "M = sys.float_info.max",
    "r = _nplinalg.mldivide(np.array([[M, 0.0], [1.0, M]]), np.ones((2, 1)))",
    "print(abs(float(r[4]) - 1.0) <= 2 * 2.0 ** -52)",
  ].join("\n");
  const out = execFileSync(process.execPath, [cli, "-c", code], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_WASM: "1" } });
  assert.equal(out.trim(), "True");
});
