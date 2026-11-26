import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// pcg, minres, gmres, bicgstab and lsqr. The first test runs the program whose outputs MATLAB R2026b printed
// (test/matlab-krylov-oracle.json) and compares each row: the flag, iter and resvec's length exactly, x, relres and
// resvec to rounding. The others check what MATLAB's pages and the solvers' algorithms fix without an oracle row:
// complex and sparse data, preconditioners as matrices and as handles, the flags for an ill-conditioned or indefinite
// preconditioner, the messages, the refusals and the admission of the work.

const cli = join(__dirname, "..", "src", "cli.js");
const oracle = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "matlab-krylov-oracle.json"), "utf8"));

function run(lines: string[]): { rows: Map<string, string[]>; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "sb-krylov-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, r.stderr);
  const rows = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    const [id, ...rest] = line.split("|");
    if (rest.length && !rows.has(id)) rows.set(id, rest);
  }
  return { rows, out: r.stdout, err: r.stderr };
}

// (MATLAB prints infinities as Inf and -Inf, which Number reads as NaN)
const nums = (s: string) =>
  s.trim().split(/\s+/).filter((t) => t.length).map((t) => (t === "Inf" ? Infinity : t === "-Inf" ? -Infinity : Number(t)));

// (each vector to rounding relative to its largest element: the solvers' operations in another order move the last
// digits, never more than 1e-10 of the scale on these systems)
function near(id: string, got: number[], want: number[], tol: number) {
  assert.equal(got.length, want.length, `${id}: ${got.length} values, expected ${want.length}`);
  const scale = Math.max(1e-300, ...want.map(Math.abs));
  got.forEach((v, k) => {
    assert.ok(Number.isFinite(v), `${id}[${k}]: ${v}`);
    assert.ok(Math.abs(v - want[k]) <= tol * scale, `${id}[${k}]: ${v}, expected ${want[k]}`);
  });
}

const SHOW = "show = @(name, x, flag, relres, iter, resvec) fprintf('%s|%s|%d|%.17g|%s|%s\\n', name, sprintf('%.17g ', x), flag, relres, sprintf('%.17g ', iter), sprintf('%.17g ', resvec));";
const SYSTEMS = [
  "n = 10; e = ones(n, 1);",
  "T = spdiags([-e 2*e -e], -1:1, n, n);",
  "b = (1:n)';",
  "N = spdiags([-e 3*e -2*e], -1:1, n, n);",
  "S = spdiags([e -2*e e], -1:1, n, n) + speye(n);",
];

test("each solver's flag, iter, resvec, x and relres on MATLAB's recorded systems (test/matlab-krylov-oracle.json)", () => {
  const calls: [string, string][] = [
    ["pcg_default", "pcg(T, b)"], ["pcg_tol", "pcg(T, b, 1e-10, 100)"], ["pcg_maxit", "pcg(T, b, 1e-10, 3)"],
    ["pcg_M", "pcg(T, b, 1e-10, 100, diag(diag(T)))"], ["pcg_x0", "pcg(T, b, 1e-10, 100, [], [], ones(n, 1))"],
    ["pcg_zero_b", "pcg(T, zeros(n, 1))"], ["pcg_handle", "pcg(@(v) T*v, b, 1e-10, 100)"],
    ["pcg_nonsym", "pcg(N, b, 1e-10, 100)"], ["pcg_negdef", "pcg(-T, b, 1e-10, 100)"],
    ["minres_indef", "minres(S, b, 1e-10, 100)"], ["minres_default", "minres(T, b)"],
    ["gmres_default", "gmres(N, b)"], ["gmres_restart", "gmres(N, b, 4, 1e-10, 20)"], ["gmres_maxit", "gmres(N, b, [], 1e-10, 3)"],
    ["gmres_restart_big", "gmres(N, b, 20)"],
    ["bicgstab", "bicgstab(N, b, 1e-10, 100)"],
    ["lsqr_ls", "lsqr([1 2; 3 4; 5 6; 7 8], [1; 2; 2; 3], 1e-12, 100)"], ["lsqr_square", "lsqr(T, b, 1e-10, 100)"],
  ];
  const { rows, out, err } = run([
    SHOW, ...SYSTEMS,
    ...calls.map(([id, call]) => `[x, f, r, it, rv] = ${call}; show('${id}', x, f, r, it, rv)`),
    "x = pcg(T, b, 1e-12, 2); fprintf('noflag|%s\\n', sprintf('%.17g ', x));",
    "try, pcg(T, b(1:5)), catch err, fprintf('badsize|%s|%s\\n', err.identifier, err.message), end",
    "lastwarn(''); [x, f] = gmres(N, b, 20); [w, id] = lastwarn; fprintf('warn|%s|%s\\n', id, w);",
  ]);
  for (const [id] of calls) {
    const want = oracle.rows[id];
    const got = rows.get(id);
    assert.ok(got, id + ": no row");
    assert.equal(Number(got[1]), want.flag, `${id} flag`);
    assert.deepEqual(nums(got[3]), want.iter, `${id} iter`);
    near(`${id} x`, nums(got[0]), want.x, 1e-10);
    near(`${id} resvec`, nums(got[4]), want.resvec, 1e-10);
    const r = Number(got[2]);
    assert.ok(Math.abs(r - want.relres) <= 1e-10 * Math.max(1, want.relres), `${id} relres ${r}, expected ${want.relres}`);
  }
  // (without a flag output, the message MATLAB printed, and the iterate with the least residual: x0)
  assert.ok(out.includes(oracle.pcg_noflag_message.join("\n") + "\n"), out);
  near("noflag", nums(rows.get("noflag")![0]), new Array(10).fill(0), 0);
  assert.deepEqual(rows.get("badsize"), oracle.pcg_badsize);
  assert.deepEqual(rows.get("warn"), oracle.gmres_restart_warning);
  assert.ok(err.includes("Warning: " + oracle.gmres_restart_warning[1]), err);
});

test("complex, sparse and full data, preconditioners as matrices and handles, lsqr's handle, the residual histories", () => {
  const { rows } = run([
    ...SYSTEMS,
    // (Hermitian positive definite: the imaginary off-diagonals alone would make it indefinite, hence the shift)
    "H = full(T) + 0.5*eye(n) + 0.3i*(diag(ones(n-1,1),1) - diag(ones(n-1,1),-1));",
    "[x, f, r, it] = pcg(H, b, 1e-12, 50); fprintf('herm|%d|%d|%.3g\\n', f, r <= 1e-12, norm(x - H\\b)/norm(H\\b));",
    "[x, f] = minres(H, b, 1e-12, 50); fprintf('hermmin|%d|%.3g\\n', f, norm(x - H\\b)/norm(H\\b));",
    "z = b + 2i*flipud(b); [x, f] = gmres(N + 1i*speye(n), z, [], 1e-12, 20); fprintf('cgmres|%d|%.3g\\n', f, norm((N + 1i*speye(n))*x - z)/norm(z));",
    "[x, f] = bicgstab(N + 1i*speye(n), z, 1e-12, 50); fprintf('cbicg|%d|%.3g\\n', f, norm((N + 1i*speye(n))*x - z)/norm(z));",
    // (sparse and full A: the same products, so the same iterates, bit for bit)
    "[x1, f1, r1, i1, v1] = gmres(N, b, 3, 1e-12, 30); [x2, f2, r2, i2, v2] = gmres(full(N), b, 3, 1e-12, 30); fprintf('spfull|%d|%d\\n', isequal(x1, x2), isequal(v1, v2));",
    // (a diagonal preconditioner divides, as M\\x does: the same iterates as a handle returning M\\x)
    "M = diag(1:n) + 0; [x1, f1, r1, i1, v1] = pcg(T, b, 1e-12, 50, M); [x2, f2, r2, i2, v2] = pcg(T, b, 1e-12, 50, @(v) M\\v); fprintf('diagM|%d|%d|%g\\n', isequal(x1, x2), isequal(v1, v2), i1);",
    "[x1, f1, r1, i1, v1] = pcg(T, b, 1e-12, 50, sparse(M)); fprintf('spdiagM|%d|%d\\n', isequal(x1, x2), isequal(v1, v2));",
    "L = tril(full(T)); [x1, f1, r1, i1] = gmres(N, b, [], 1e-12, 10, L); [x2, f2, r2, i2] = gmres(N, b, [], 1e-12, 10, @(v) L\\v); fprintf('triM|%d|%d|%d\\n', f1, isequal(x1, x2), isequal(i1, i2));",
    // (M = M1*M2: M\\x is M2\\(M1\\x), as one handle computes it)
    "[x1, f1, r1, i1] = bicgstab(N, b, 1e-12, 50, L, L'); [x2, f2, r2, i2] = bicgstab(N, b, 1e-12, 50, @(v) L'\\(L\\v)); fprintf('m1m2|%d|%d|%d\\n', f1, isequal(x1, x2), isequal(i1, i2));",
    "[x, f] = pcg(T, b, 1e-12, 50, L*L'); fprintf('pcgLL|%d|%.3g\\n', f, norm(x - T\\b)/norm(T\\b));",
    // (lsqr: the least-squares solution of an overdetermined system, from a matrix and from a handle; a preconditioner)
    "A = [1 2; 3 4; 5 6; 7 8]; c = [1; 2; 2; 3]; af = @(v, t) A*v*strcmp(t, 'notransp') + 0;",
    "[x1, f1, r1, i1, v1, l1] = lsqr(A, c, 1e-12, 10); fprintf('lsq|%d|%.3g|%s|%d\\n', f1, norm(x1 - A\\c), mat2str(size(l1)), numel(v1));",
    "[x2, f2] = lsqr(@lsqrfun, c, 1e-12, 10); fprintf('lsqh|%d|%.3g\\n', f2, norm(x2 - A\\c));",
    "[x3, f3] = lsqr(sparse(A), c, 1e-12, 10, diag([2 3])); fprintf('lsqM|%d|%.3g\\n', f3, norm(x3 - A\\c));",
    "Ac = A + 1i*[0 1; 1 0; 2 1; 0 3]; cc = c - 2i; [x4, f4] = lsqr(Ac, cc, 1e-12, 10); fprintf('lsqC|%d|%.3g\\n', f4, norm(x4 - Ac\\cc)/norm(Ac\\cc));",
    // (gmres restarted every 3 without maxit: min(ceil(10/3), 10) = 4 outer iterations, 12 inner at most)
    "[x, f, r, it, rv] = gmres(N, b, 3); fprintf('gdef|%d|%s|%d\\n', f, mat2str(it), numel(rv));",
    // (resvec: MINRES's and GMRES's residual norms never increase; bicgstab's has an entry each half iteration)
    "[x, f, r, it, rv] = minres(S, b, 1e-12, 100); fprintf('minmono|%d\\n', all(diff(rv) <= 1e-12*rv(1)));",
    "[x, f, r, it, rv] = gmres(N, b, 3, 1e-12, 30); fprintf('gmono|%d|%d\\n', all(diff(rv) <= 1e-12*rv(1)), numel(rv) == 1 + 3*(it(1)-1) + it(2));",
    "[x, f, r, it, rv] = bicgstab(T, b, 1e-12, 50); fprintf('bhalf|%d|%d\\n', numel(rv) == 1 + 2*it, f);",
    "function y = lsqrfun(v, t)",
    "  A = [1 2; 3 4; 5 6; 7 8];",
    "  if strcmp(t, 'notransp'), y = A*v; else, y = A'*v; end",
    "end",
  ]);
  const f = (id: string) => rows.get(id)!.map(Number);
  assert.equal(f("herm")[0], 0); assert.equal(f("herm")[1], 1); assert.ok(f("herm")[2] < 1e-12);
  assert.equal(f("hermmin")[0], 0); assert.ok(f("hermmin")[1] < 1e-11);
  assert.equal(f("cgmres")[0], 0); assert.ok(f("cgmres")[1] <= 1e-12);
  assert.equal(f("cbicg")[0], 0); assert.ok(f("cbicg")[1] <= 1e-12);
  assert.deepEqual(f("spfull"), [1, 1]);
  assert.deepEqual(f("diagM").slice(0, 2), [1, 1]);
  assert.deepEqual(f("spdiagM"), [1, 1]);
  assert.deepEqual(f("triM"), [0, 1, 1]);
  assert.deepEqual(f("m1m2"), [0, 1, 1]);
  assert.equal(f("pcgLL")[0], 0); assert.ok(f("pcgLL")[1] < 1e-10);
  assert.equal(f("lsq")[0], 0); assert.ok(f("lsq")[1] < 1e-12);
  assert.deepEqual(rows.get("lsq")!.slice(2), ["[2 1]", "3"]);
  assert.equal(f("lsqh")[0], 0); assert.ok(f("lsqh")[1] < 1e-12);
  assert.equal(f("lsqM")[0], 0); assert.ok(f("lsqM")[1] < 1e-12);
  assert.equal(f("lsqC")[0], 0); assert.ok(f("lsqC")[1] < 1e-12);
  // (not converged after 4 outer iterations of 3: the last, best iterate, and 1 + 12 residual norms)
  assert.deepEqual(rows.get("gdef"), ["1", "[4 3]", "13"]);
  assert.deepEqual(f("minmono"), [1]);
  assert.deepEqual(f("gmono"), [1, 1]);
  assert.deepEqual(f("bhalf"), [1, 0]);
});

test("the flags for a singular or indefinite preconditioner, maxit 0, the messages, and the refusals", () => {
  const { rows, out } = run([
    ...SYSTEMS,
    "warning('off', 'all');",
    "[x, f, r, it, rv] = pcg(T, b, 1e-10, 50, zeros(n)); fprintf('singM|%d|%g|%d|%d\\n', f, it, numel(rv), isequal(x, zeros(n, 1)));",
    "[x, f, r, it, rv] = pcg(T, b, 1e-10, 50, @(v) v ./ [0; ones(n-1, 1)]); fprintf('singH|%d|%g\\n', f, it);",
    "[x, f] = minres(T, b, 1e-10, 50, -eye(n)); fprintf('negM|%d\\n', f);",
    // (a non-finite preconditioner is computed with, not refused: its solve is not finite, so flag 2 and x0)
    "Mi = full(T); Mi(2, 5) = Inf; [x, f, r, it] = gmres(T, b, [], 1e-10, 10, Mi); fprintf('infM|%d|%s|%d\\n', f, mat2str(it), isequal(x, zeros(n, 1)));",
    "Mn = tril(T); Mn(4, 2) = NaN; [x, f, r, it] = bicgstab(T, b, 1e-10, 50, Mn); fprintf('nanM|%d|%g|%d\\n', f, it, isequal(x, zeros(n, 1)));",
    "[x, f, r, it, rv] = bicgstab(T, b, 1e-10, 0); fprintf('maxit0|%d|%g|%g|%d\\n', f, r, it, numel(rv));",
    "[x, f, r, it, rv] = gmres(T, b, [], 1e-10, 0, [], [], ones(n, 1)); fprintf('gmaxit0|%d|%s|%d|%d\\n', f, mat2str(it), numel(rv), isequal(x, ones(n, 1)));",
    "[x, f, r, it] = pcg(T, T*ones(n, 1), 1e-10, 50, [], [], ones(n, 1)); fprintf('x0exact|%d|%g|%g\\n', f, r, it);",
    "[x, f] = pcg(zeros(0), zeros(0, 1)); fprintf('empty|%d|%s\\n', f, mat2str(size(x)));",
    "x = minres(T, b); x = bicgstab(T, b, 1e-12, 2); x = gmres(N, b, [], 1e-12, 2); x = lsqr(T, b, 1e-12, 30); x = pcg(-T, b);",
    "try, pcg(T, b, 1e-6, 10, [], [], ones(3, 1)), catch err, fprintf('x0|%s|%s\\n', err.identifier, err.message), end",
    "try, pcg([1 2; 3 4; 5 6], [1; 2; 3]), catch err, fprintf('nonsq|%s\\n', err.identifier), end",
    "try, gmres(T, b', 2), catch err, fprintf('rowb|%s\\n', err.identifier), end",
    "try, pcg(single(T), b), catch err, fprintf('single|%s\\n', err.message), end",
    "try, [a1, a2, a3, a4, a5, a6] = minres(T, b); catch err, fprintf('m6|%s\\n', err.message), end",
    "try, pcg(T, b, 1e-6, 10, [], [], [], 5), catch err, fprintf('many|%s\\n', err.message), end",
    "try, pcg(T, b, 1e-6, -1), catch err, fprintf('maxitneg|%s\\n', err.message), end",
    "try, gmres(T, b, 0), catch err, fprintf('restart0|%s\\n', err.message), end",
    "try, pcg(T, b, 1e-6, 10, ones(3)), catch err, fprintf('Msize|%s\\n', err.message), end",
    "try, pcg(@(v) [v; 1], b), catch err, fprintf('hsize|%s\\n', err.message), end",
    "Ti = full(T); Ti(2, 2) = Inf; try, pcg(Ti, b), catch err, fprintf('infA|%s\\n', err.message), end",
    "try, gmres(sparse(Ti), b), catch err, fprintf('infS|%s\\n', err.message), end",
  ]);
  // (M\x not finite: flag 2 at the first step, x0 returned)
  assert.deepEqual(rows.get("singM"), ["2", "0", "1", "1"]);
  assert.deepEqual(rows.get("singH"), ["2", "0"]);
  assert.deepEqual(rows.get("negM"), ["5"]);
  assert.deepEqual(rows.get("infM"), ["2", "[0 0]", "1"]);
  assert.deepEqual(rows.get("nanM"), ["2", "0", "1"]);
  assert.deepEqual(rows.get("maxit0"), ["1", "1", "0", "1"]);
  assert.deepEqual(rows.get("gmaxit0"), ["1", "[0 0]", "1", "1"]);
  assert.deepEqual(rows.get("x0exact"), ["0", "0", "0"]);
  assert.deepEqual(rows.get("empty"), ["0", "[0 1]"]);
  // (the messages printed without a flag output: each solver's own name, its iteration and relative residual)
  assert.match(out, /^minres converged at iteration 10 to a solution with relative residual \d\.?\d?e-\d+\.$/m);
  assert.match(out, /^bicgstab stopped at iteration 2 without converging to the desired tolerance 1e-12\nbecause the maximum number of iterations was reached\.\nThe iterate returned \(number [\d.]+\) has relative residual [\d.e-]+\.$/m);
  assert.match(out, /^gmres stopped at outer iteration 1 \(inner iteration 2\) without converging to the desired tolerance 1e-12\nbecause the maximum number of iterations was reached\.\nThe iterate returned \(number 1\(2\)\) has relative residual [\d.e-]+\.$/m);
  assert.match(out, /^lsqr converged at iteration \d+ to a solution with relative residual \d\.?\d?e-\d+\.$/m);
  assert.match(out, /^pcg stopped at iteration 1 without converging to the desired tolerance 1e-06\nbecause a scalar quantity became too small or too large to continue computing\.\nThe iterate returned \(number 0\) has relative residual 1\.$/m);
  assert.deepEqual(rows.get("x0"), ["MATLAB:pcg:WrongInitGuessSize", "Initial guess must be a column vector of length 10 to match the problem size."]);
  assert.deepEqual(rows.get("nonsq"), ["MATLAB:pcg:NonSquareMatrix"]);
  assert.deepEqual(rows.get("rowb"), ["MATLAB:gmres:RSHsizeMatchCoeffMatrix"]);
  assert.match(rows.get("single")![0], /single precision is not supported/);
  assert.match(rows.get("m6")![0], /resveccg/);
  assert.match(rows.get("many")![0], /Too many input arguments/);
  assert.match(rows.get("maxitneg")![0], /nonnegative integer/);
  assert.match(rows.get("restart0")![0], /restart must be a positive integer/);
  assert.match(rows.get("Msize")![0], /M1 must be 10-by-10/);
  assert.match(rows.get("hsize")![0], /must return a vector of length 10/);
  // (A's Inf and NaN refused as mtimes refuses them, full or sparse)
  assert.match(rows.get("infA")![0], /Matrix multiplication of values that include Inf or NaN is not supported/);
  assert.match(rows.get("infS")![0], /Matrix multiplication of values that include Inf or NaN is not supported/);
});

test("lsqr's stop by Paige and Saunders's scaled test: b scaled by 1e-6 or 1e6 changes no iteration", () => {
  const { rows } = run([
    ...SYSTEMS,
    "A = [1 2; 3 4; 5 6; 7 8]; c = [1; 2; 2; 3]; xs = A\\c;",
    "for s = [1 1e-6 1e6], [x, f, r, it] = lsqr(A, s*c, 1e-6, 20); rr = s*c - A*x; " +
      "fprintf('lsq%g|%d|%g|%.3g|%.3g\\n', s, f, it, norm(x/s - xs)/norm(xs), norm(A'*rr)/(norm(A, 'fro')*norm(rr))); end",
    // (a handle returning complex values, and a complex preconditioner: complex iterates)
    "H = full(T) + 0.5*eye(n) + 0.3i*(diag(ones(n-1,1),1) - diag(ones(n-1,1),-1));",
    "[x, f] = pcg(@(v) H*v, b, 1e-12, 50); fprintf('hcplx|%d|%.3g\\n', f, norm(x - H\\b)/norm(H\\b));",
    "[x, f] = gmres(full(N), b, [], 1e-12, 10, (1+1i)*eye(n)); fprintf('mcplx|%d|%.3g\\n', f, norm(N*x - b)/norm(b));",
    "[x, f] = bicgstab(N, b, 1e-12, 50, full(N)); fprintf('mfull|%d|%.3g\\n', f, norm(N*x - b)/norm(b));",
    "[x, f] = lsqr(N, b, 1e-12, 50, sparse(tril(full(N)))); fprintf('msp|%d|%.3g\\n', f, norm(N*x - b)/norm(b));",
    // (a full M whose first column's largest entry is off the diagonal, so its factorization must pivot: N's rows
    // reversed, its (1,1) entry 0)
    "Mp = full(N); Mp = Mp(end:-1:1, :); [x, f] = gmres(N, b, [], 1e-12, 10, Mp); fprintf('mpiv|%d|%.3g\\n', f, norm(N*x - b)/norm(b));",
    // (complex lsqr: a full complex M, applied transposed with its conjugate; a sparse complex A, A'*r conjugated)
    "A = [1 2; 3 4; 5 6; 7 8]; Ac = A + 1i*[0 1; 1 0; 2 1; 0 3]; cc = [1; 2; 2; 3] - 2i;",
    "[x, f] = lsqr(Ac, cc, 1e-12, 20, [2 1i; 0.5 3]); fprintf('lsqMc|%d|%.3g\\n', f, norm(x - Ac\\cc)/norm(Ac\\cc));",
    "[x, f] = lsqr(sparse(Ac), cc, 1e-12, 20); fprintf('lsqSc|%d|%.3g\\n', f, norm(x - Ac\\cc)/norm(Ac\\cc));",
  ]);
  const f = (id: string) => rows.get(id)!.map(Number);
  for (const s of ["1", "1e-06", "1e+06"]) {
    const [flag, it, err, stat] = f("lsq" + s);
    // (the same two iterations at every scale, to the least-squares solution, stationary)
    assert.equal(flag, 0, s); assert.equal(it, 2, s); assert.ok(err < 1e-12, `${s}: ${err}`); assert.ok(stat < 1e-6, `${s}: ${stat}`);
  }
  assert.equal(f("hcplx")[0], 0); assert.ok(f("hcplx")[1] < 1e-11);
  for (const id of ["mcplx", "mfull", "msp", "mpiv"]) { assert.equal(f(id)[0], 0, id); assert.ok(f(id)[1] <= 1e-11, id); }
  for (const id of ["lsqMc", "lsqSc"]) { assert.equal(f(id)[0], 0, id); assert.ok(f(id)[1] <= 1e-10, `${id}: ${f(id)[1]}`); }
});

test("the solvers' work admitted before their first vector (test/matlab_krylov_admit_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_krylov_admit_cases.py")], { encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 10, r.stdout);
});

test("b with a NaN: each solver's flag, x, iter and resvec as MATLAB's (test/matlab-krylov-oracle.json nan_rhs_rows)", () => {
  // (pcg and minres run out of iterations on NaNs, gmres too (its resvec's last entry 0 where maxit passed size(A,1)
  // without restarts), bicgstab stops at iteration 2, lsqr at once with x0; a preconditioned pcg stops at iteration 1)
  const dir = mkdtempSync(join(tmpdir(), "sb-knan-"));
  writeFileSync(join(dir, "main.m"), [
    "T = spdiags([-ones(6,1) 2*ones(6,1) -ones(6,1)], -1:1, 6, 6);",
    "b = (1:6)'; b(3) = NaN; tol = 1e-8; x0 = ones(6,1); bn = NaN(6,1);",
    "[x, fl, rr, it, rv] = gmres(T, b, 3, tol, 2); krow('1 gmres(A,b,3,tol,2)', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = gmres(T, b, [], tol, 4); krow('2 gmres(A,b,[],tol,4)', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = bicgstab(T, b, tol, 20); krow('3 bicgstab maxit20', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = bicgstab(T, b, tol, 5); krow('3 bicgstab maxit5', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = pcg(T, b, tol, 20, [], [], x0); krow('4 pcg x0=ones', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = minres(T, b, tol, 20, [], [], x0); krow('4 minres x0=ones', x, fl, rr, it, rv);",
    "M = spdiags(diag(T), 0, 6, 6);",
    "[x, fl, rr, it, rv] = pcg(T, b, tol, 7, M); krow('5 pcg M=diag maxit7', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = pcg(T, bn, tol, 20); krow('6 allnan pcg', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = minres(T, bn, tol, 20); krow('6 allnan minres', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = gmres(T, bn, [], tol, 20); krow('6 allnan gmres', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = bicgstab(T, bn, tol, 20); krow('6 allnan bicgstab', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = lsqr(T, bn, tol, 20); krow('6 allnan lsqr', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = gmres(T, bn, 3, tol, 2); krow('6x allnan gmres(3,2)', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = gmres(T, b, [], tol, 20, [], [], x0); krow('7 gmres x0=ones', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = bicgstab(T, b, tol, 20, [], [], x0); krow('7 bicgstab x0=ones', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = lsqr(T, b, tol, 20, [], [], x0); krow('7 lsqr x0=ones', x, fl, rr, it, rv);",
    "function krow(tag, x, fl, rr, it, rv)",
    "  fprintf('%s|x=%s|fl=%d|relres=%.6g|iter=%s|numel(resvec)=%d|all(isnan(resvec))=%d|any(isnan(resvec))=%d|resvec=%s\\n', ...",
    "    tag, sprintf('%.6g ', x), fl, rr, sprintf('%g ', it), numel(rv), all(isnan(rv)), any(isnan(rv)), sprintf('%.4g ', rv));",
    "end",
  ].join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 600000 });
  assert.equal(r.status, 0, r.stderr);
  const got = r.stdout.split("\n").map((l: string) => l.trimEnd()).filter((l: string) => l);
  assert.deepEqual(got, oracle.nan_rhs_rows);
});

test("b with a NaN: the warnings' identifiers, the preconditioned solvers' flag 2 and the unrequested flags' messages", () => {
  // (gmres warns that its Hessenberg system is ill conditioned, once per outer cycle, and that maxit passed
  // size(A,1) without restarts; preconditioned, pcg, minres, gmres and bicgstab stop at the preconditioner's system;
  // test/matlab-krylov-oracle.json nan_rhs_rows2 and nan_rhs_messages)
  const dir = mkdtempSync(join(tmpdir(), "sb-knan2-"));
  writeFileSync(join(dir, "main.m"), [
    "T = spdiags([-ones(6,1) 2*ones(6,1) -ones(6,1)], -1:1, 6, 6);",
    "b = (1:6)'; b(3) = NaN; tol = 1e-8; bok = (1:6)';",
    "lastwarn('', ''); w0 = warning('off', 'all');",
    "[x, fl, rr, it, rv] = gmres(T, b, 3, tol, 2); [m, id] = lastwarn;",
    "warning(w0); fprintf('1a singular|id=%s|msg=%s\\n', id, m);",
    "lastwarn('', ''); w0 = warning('off', 'all');",
    "[x, fl, rr, it, rv] = gmres(T, bok, [], tol, 20); [m, id] = lastwarn;",
    "warning(w0); fprintf('1b outer|id=%s|msg=%s\\n', id, m);",
    "lastwarn('', ''); w0 = warning('off', 'all');",
    "[x, fl, rr, it, rv] = gmres(T, b, [], tol, 6); [m, id] = lastwarn; warning(w0);",
    "krow('1c gmres(A,b,[],tol,6)', x, fl, rr, it, rv); fprintf('1c lastwarn|id=%s|msg=%s\\n', id, m);",
    "lastwarn('', ''); w0 = warning('off', 'all');",
    "[x, fl, rr, it, rv] = gmres(T, b, [], tol, 7); [m, id] = lastwarn; warning(w0);",
    "krow('1c gmres(A,b,[],tol,7)', x, fl, rr, it, rv); fprintf('1c7 lastwarn|id=%s|msg=%s\\n', id, m);",
    "M = spdiags(diag(T), 0, 6, 6);",
    "[x, fl, rr, it, rv] = minres(T, b, tol, 7, M); krow('2 minres M maxit7', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = gmres(T, b, [], tol, 7, M); krow('2 gmres(A,b,[],tol,7,M)', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = bicgstab(T, b, tol, 7, M); krow('2 bicgstab M maxit7', x, fl, rr, it, rv);",
    "[x, fl, rr, it, rv] = pcg(T, b, tol, 7, M); krow('2 pcg M maxit7 (again)', x, fl, rr, it, rv);",
    "disp('MESSAGES'); pcg(T, b); gmres(T, b, 3, tol, 2);",
    "function krow(tag, x, fl, rr, it, rv)",
    "  fprintf('%s|x=%s|fl=%d|relres=%.6g|iter=%s|numel(resvec)=%d|resvec=%s\\n', ...",
    "    tag, sprintf('%.6g ', x), fl, rr, sprintf('%g ', it), numel(rv), sprintf('%.4g ', rv));",
    "end",
  ].join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 600000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").map((l: string) => l.trimEnd()).filter((l: string) => l);
  const at = lines.indexOf("MESSAGES");
  assert.deepEqual(lines.slice(0, at), oracle.nan_rhs_rows2);
  const msgs = oracle.nan_rhs_messages;
  assert.deepEqual(lines.slice(at + 1), [...msgs.pcg, ...msgs.gmres]);
  // (the two outer cycles' warnings, before gmres's message; and the outer-iterations warning of the gmres(.., 7, M) row)
  assert.equal(r.stderr.split(msgs.gmres_warning).length - 1, 2, r.stderr);
  assert.ok(r.stderr.includes("Warning: Maximum number of outer iterations is 7 but should be bounded by size(A,1). " +
    "Setting the maximum number of outer iterations to 6."), r.stderr);
});
