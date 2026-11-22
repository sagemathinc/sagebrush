import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB's ode15s and ode23s in MATLAB mode (lib/_matlab_ode_stiff.py), against the rows an observed MATLAB R2026b
// run printed for the same script (values, identifiers and field names only, 2026-11-22): fields, error identifiers
// and messages, sizes, event indices and the located event values exactly; solutions within 1e-2 of each row's
// largest element, the default RelTol's global accuracy (1e-6 with RelTol 1e-8), since the steps are Sagebrush's
// own.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-ode-stiff-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const SCRIPT = "fmt = @(v) sprintf('%.17g ', v);\np = @(name, v) fprintf('%s|%s|%s\\n', name, mat2str(size(v)), fmt(double(v(:)')));\nt = @(name, s) fprintf('%s|TEXT|%s\\n', name, s);\ne = @(name, err) fprintf('%s|ERR|%s|%s\\n', name, err.identifier, strrep(err.message, newline, ' '));\nrob = @(t, y) [-0.04*y(1) + 1e4*y(2)*y(3); 0.04*y(1) - 1e4*y(2)*y(3) - 3e7*y(2)^2; 3e7*y(2)^2];\n[tt, y] = ode15s(rob, [0 40], [1; 0; 0]); p('rob15_yend', y(end, :)); p('rob15_t1', tt(1)); p('rob15_tend', tt(end)); p('rob15_ncols', size(y, 2));\n[tt, y] = ode23s(rob, [0 40], [1; 0; 0]); p('rob23_yend', y(end, :));\n[tt, y] = ode15s(rob, [0 1 10 40], [1; 0; 0]); p('rob15_tspan_t', tt); p('rob15_tspan_y', y);\nvdp = @(t, y) [y(2); 1000*(1 - y(1)^2)*y(2) - y(1)];\n[tt, y] = ode15s(vdp, [0 3000], [2; 0]); p('vdp15_yend', y(end, :));\n[tt, y] = ode23s(vdp, [0 3000], [2; 0]); p('vdp23_yend', y(end, :));\nA = [-1000 1; 0 -1]; lin = @(t, y) A*y;\n[tt, y] = ode15s(lin, [0 2], [1; 1]); p('lin15_yend', y(end, :)); p('lin_exact', expm(2*A)*[1; 1]);\n[tt, y] = ode15s(lin, [0 2], [1; 1], odeset('RelTol', 1e-8, 'AbsTol', 1e-10)); p('lin15_tight_yend', y(end, :));\n[tt, y] = ode15s(lin, [0 2], [1; 1], odeset('Jacobian', A)); p('lin15_jac_yend', y(end, :));\n[tt, y] = ode23s(lin, [0 2], [1; 1], odeset('Jacobian', @(t, y) A)); p('lin23_jacfun_yend', y(end, :));\nsol = ode15s(rob, [0 40], [1; 0; 0]); t('sol15_fields', strjoin(fieldnames(sol)', ',')); t('sol15_solver', sol.solver); p('sol15_deval', deval(sol, [1 10]));\nsol = ode23s(rob, [0 40], [1; 0; 0]); t('sol23_fields', strjoin(fieldnames(sol)', ',')); t('sol23_solver', sol.solver);\nM = [1 0; 0 0]; dae = @(t, y) [-y(1) + y(2); y(1) + y(2) - 1];\n[tt, y] = ode15s(dae, [0 1], [0; 1], odeset('Mass', M)); p('dae15_yend', y(end, :));\ntry, ode15s(@(t, y) [y; y], [0 1], 1), catch err, e('dim15', err); end\ntry, ode15s(rob, [0 0], [1; 0; 0]), catch err, e('tspan15', err); end\n[tt, y] = ode15s(@(t, y) -y, [1 0], 1); p('back15_yend', y(end)); p('back15_tend', tt(end));\n[tt, y] = ode15s(@(t, y) -y, [0 1], [1 2]); p('row15_size2', size(y, 2));\nfmt = @(v) sprintf('%.17g ', v);\np = @(name, v) fprintf('%s|%s|%s\\n', name, mat2str(size(v)), fmt(double(v(:)')));\nt = @(name, s) fprintf('%s|TEXT|%s\\n', name, s);\nopts = odeset('Events', @ev_half);\n[tt, y, te, ye, ie] = ode15s(@(t, y) -y, [0 5], 1, opts); p('ev15_te', te); p('ev15_ye', ye); p('ev15_ie', ie); p('ev15_tend', tt(end)); p('ev15_yend', y(end));\n[tt, y, te, ye, ie] = ode23s(@(t, y) -y, [0 5], 1, opts); p('ev23_te', te); p('ev23_ye', ye); p('ev23_ie', ie); p('ev23_tend', tt(end));\nsol = ode15s(@(t, y) -y, [0 5], 1, opts); t('evsol_fields', strjoin(fieldnames(sol)', ',')); p('evsol_xe', sol.xe); p('evsol_ie', sol.ie);\nopts2 = odeset('Events', @ev_nonterm);\n[tt, y, te, ye, ie] = ode15s(@(t, y) [y(2); -y(1)], [0 10], [1; 0], opts2); p('osc15_te', te); p('osc15_ie', ie); p('osc15_tend', tt(end));\nsol = ode15s(@(t, y) -y, [0 1], 1); t('stats_fields', strjoin(fieldnames(sol.stats)', ','));\nfunction [value, isterminal, direction] = ev_half(t, y)\nvalue = y(1) - 0.5; isterminal = 1; direction = -1;\nend\n\nfunction [value, isterminal, direction] = ev_nonterm(t, y)\nvalue = y(1); isterminal = 0; direction = 0;\nend\n";

// MATLAB R2026b's rows: [size, values], or ["TEXT", text] and ["ERR", "identifier|message"]
const MATLAB: Record<string, [string, string]> = {
  "rob15_yend": [
    "[1 3]",
    "0.71593110785562086 9.1895449095741494e-06 0.28405970259946983 "
  ],
  "rob15_t1": [
    "[1 1]",
    "0 "
  ],
  "rob15_tend": [
    "[1 1]",
    "40 "
  ],
  "rob15_ncols": [
    "[1 1]",
    "3 "
  ],
  "rob23_yend": [
    "[1 3]",
    "0.71577800000612812 9.1826519547407424e-06 0.28421281734191617 "
  ],
  "rob15_tspan_t": [
    "[4 1]",
    "0 1 10 40 "
  ],
  "rob15_tspan_y": [
    "[4 3]",
    "1 0.96646746636315883 0.84147866385115755 0.71593110785562086 0 3.0747852346782518e-05 1.6244132310124471e-05 9.1895449095741494e-06 0 0.033501785784494809 0.15850509201653273 0.28405970259946983 "
  ],
  "vdp15_yend": [
    "[1 2]",
    "-1.5022985336906771 0.0011950585442433734 "
  ],
  "vdp23_yend": [
    "[1 2]",
    "-1.513592689448148 0.0011724459782494294 "
  ],
  "lin15_yend": [
    "[1 2]",
    "0.00013537098133118737 0.13523561034987391 "
  ],
  "lin_exact": [
    "[2 1]",
    "0.0001354707539906033 0.1353352832366127 "
  ],
  "lin15_tight_yend": [
    "[1 2]",
    "0.0001354707657350513 0.13533529496931623 "
  ],
  "lin15_jac_yend": [
    "[1 2]",
    "0.00013537098133118737 0.13523561034987391 "
  ],
  "lin23_jacfun_yend": [
    "[1 2]",
    "0.00013505946969080733 0.13492441022111656 "
  ],
  "sol15_fields": [
    "TEXT",
    "solver,extdata,x,y,stats,idata"
  ],
  "sol15_solver": [
    "TEXT",
    "ode15s"
  ],
  "sol15_deval": [
    "[3 2]",
    "0.96646746636315883 3.0747852346782518e-05 0.033501785784494809 0.84147866385115755 1.6244132310124471e-05 0.15850509201653273 "
  ],
  "sol23_fields": [
    "TEXT",
    "solver,extdata,x,y,stats,idata"
  ],
  "sol23_solver": [
    "TEXT",
    "ode23s"
  ],
  "dae15_yend": [
    "[1 2]",
    "0.43224452221355963 0.56775547781347202 "
  ],
  "dim15": [
    "ERR",
    "MATLAB:odearguments:SizeIC|@(T,Y)[Y;Y] returns a vector of length 2, but the length of initial conditions vector is 1. The vector returned by @(T,Y)[Y;Y] and the initial conditions vector must have the same number of elements."
  ],
  "tspan15": [
    "ERR",
    "MATLAB:odearguments:TspanEndpointsNotDistinct|The last entry in tspan must be different from the first entry."
  ],
  "back15_yend": [
    "[1 1]",
    "2.7253639536336878 "
  ],
  "back15_tend": [
    "[1 1]",
    "0 "
  ],
  "row15_size2": [
    "[1 1]",
    "2 "
  ],
  "ev15_te": [
    "[1 1]",
    "0.69212255363503405 "
  ],
  "ev15_ye": [
    "[1 1]",
    "0.5 "
  ],
  "ev15_ie": [
    "[1 1]",
    "1 "
  ],
  "ev15_tend": [
    "[1 1]",
    "0.69212255363503405 "
  ],
  "ev15_yend": [
    "[1 1]",
    "0.5 "
  ],
  "ev23_te": [
    "[1 1]",
    "0.6918724041653076 "
  ],
  "ev23_ye": [
    "[1 1]",
    "0.5 "
  ],
  "ev23_ie": [
    "[1 1]",
    "1 "
  ],
  "ev23_tend": [
    "[1 1]",
    "0.6918724041653076 "
  ],
  "evsol_fields": [
    "TEXT",
    "solver,extdata,x,y,xe,ye,ie,stats,idata"
  ],
  "evsol_xe": [
    "[1 1]",
    "0.69212255363503405 "
  ],
  "evsol_ie": [
    "[1 1]",
    "1 "
  ],
  "osc15_te": [
    "[3 1]",
    "1.5712240473228649 4.713061851027871 7.8533047710305679 "
  ],
  "osc15_ie": [
    "[3 1]",
    "1 1 1 "
  ],
  "osc15_tend": [
    "[1 1]",
    "10 "
  ],
  "stats_fields": [
    "TEXT",
    "nsteps,nfailed,nfevals,npds,ndecomps,nsolves,tfinal"
  ]
};

const EXACT = new Set(["rob15_t1", "rob15_tend", "rob15_ncols", "rob15_tspan_t", "back15_tend", "row15_size2", "ev15_ye", "ev15_yend", "ev15_ie", "ev23_ye", "ev23_ie", "evsol_ie", "osc15_ie", "osc15_tend"]);
const TIGHT: Record<string, number> = {"lin15_tight_yend": 1e-06};

test("ode15s and ode23s: the rows of an observed MATLAB run", () => {
  const r = run(SCRIPT);
  assert.equal(r.status, 0, r.err);
  const got = new Map<string, [string, string]>();
  for (const line of r.out.trim().split("\n")) {
    const [name, size, ...rest] = line.split("|");
    got.set(name, [size, rest.join("|")]);
  }
  for (const [name, [size, values]] of Object.entries(MATLAB)) {
    const g = got.get(name);
    assert.ok(g, `${name}: not printed`);
    assert.equal(g[0], size, `${name}: size or kind`);
    if (size === "TEXT" || size === "ERR") {
      assert.equal(g[1], values, name);
      continue;
    }
    const want = values.trim().split(" ").map(Number), have = g[1].trim().split(" ").map(Number);
    assert.equal(have.length, want.length, `${name}: count`);
    if (EXACT.has(name)) {
      assert.deepEqual(have, want, `${name}: MATLAB's values exactly`);
      continue;
    }
    const scale = Math.max(...want.map(Math.abs), 1e-300), tol = TIGHT[name] ?? 1e-2;
    want.forEach((w, k) => assert.ok(Math.abs(w - have[k]) <= tol * scale, `${name}[${k}]: ${have[k]}, MATLAB ${w}`));
  }
});

test("ode23s and ode15s with a singular mass matrix: the index-1 DAE as MATLAB solves it", () => {
  // (MATLAB R2026b, observed 2026-11-22: ode23s [0.43252575797565845 0.56747415564519954], ode15s
  // [0.43224452221355963 0.56775547781347202]; the algebraic equation y1 + y2 = 1 holds at each step)
  const r = run([
    "M = [1 0; 0 0]; dae = @(t, y) [-y(1) + y(2); y(1) + y(2) - 1];",
    "[~, y] = ode23s(dae, [0 1], [0; 1], odeset('Mass', M)); a = y(end, :);",
    "[~, z] = ode15s(dae, [0 1], [0; 1], odeset('Mass', M)); b = z(end, :);",
    "fprintf('%d %d %d %d\\n', abs(a(1) - 0.43252575797565845) < 1e-3, abs(b(1) - 0.43224452221355963) < 1e-3, " +
      "max(abs(sum(y, 2) - 1)) < 1e-6, max(abs(sum(z, 2) - 1)) < 1e-6)",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "1 1 1 1\n");
});

test("ode15s's and ode23s's accuracy against exact solutions as RelTol tightens, BDF and MaxOrder, and Stats", () => {
  // (global errors: ode15s within 10 RelTol here; ode23s, of order 2, within 500 RelTol at the tightest)
  const r = run([
    "A = [-1000 1; 0 -1]; e = expm(2*A)*[1; 1];",
    "for tol = [1e-4 1e-6 1e-8]",
    "  o = odeset('RelTol', tol, 'AbsTol', tol/100);",
    "  [~, y] = ode15s(@(t, y) A*y, [0 2], [1; 1], o); [~, z] = ode23s(@(t, y) A*y, [0 2], [1; 1], o);",
    "  fprintf('%d %d\\n', norm(y(end, :)' - e) / norm(e) < 10*tol, norm(z(end, :)' - e) / norm(e) < 500*tol)",
    "end",
    "[~, y] = ode15s(@(t, y) -y, [0 1], 1, odeset('BDF', 'on', 'MaxOrder', 2, 'RelTol', 1e-6)); fprintf('%d\\n', abs(y(end) - exp(-1)) < 1e-4)",
    "sol = ode15s(@(t, y) -y, [0 1], 1); fprintf('%g %d\\n', sol.stats.tfinal, sol.stats.nsteps > 0)",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "1 1\n1 1\n1 1\n1\n1 1\n");
});

test("a singular Newton matrix at the starting step: the step shrinks and the zero solution comes out", () => {
  // (y' = y from y(0) = 0 is identically 0; with the starting step h, M - (h/alpha) J can be exactly singular,
  // which must shrink the step, with the numerical Jacobian and with a supplied one alike)
  const r = run([
    "for s = {@ode15s, @ode23s}",
    "  [t, y] = s{1}(@(t, y) y, [0 118.5], 0); [u, z] = s{1}(@(t, y) y, [0 118.5], 0, odeset('Jacobian', 1));",
    "  fprintf('%g %g %g %g\\n', max(abs(y)), t(end), max(abs(z)), u(end))",
    "end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "0 118.5 0 118.5\n0 118.5 0 118.5\n");
});

test("a complex Mass or Jacobian is refused, never its real part; real, singular and nonsymmetric ones work", () => {
  const r = run([
    "for s = {@ode15s, @ode23s}",
    "  try, s{1}(@(t, y) -y, [0 1], 1, odeset('Mass', 1 + 1i)), catch e, disp(e.message), end",
    "  try, s{1}(@(t, y) -y, [0 1], 1, odeset('Jacobian', -1i)), catch e, disp(e.message), end",
    "  try, s{1}(@(t, y) -y, [0 1], 1, odeset('Jacobian', @(t, y) -1 + 1i)), catch e, disp(e.message), end",
    "  [~, y] = s{1}(@(t, y) [-y(1) + y(2); -2*y(2)], [0 1], [1; 1], odeset('Mass', [2 1; 0 1], 'Jacobian', [-1 1; 0 -2]));",
    "  fprintf('%d\\n', all(isfinite(y(:))) && isreal(y))",
    "end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  const block = (name: string) => `${name}: The mass matrix is complex: complex values are not supported in Sagebrush.\n` +
    `${name}: The Jacobian is complex: complex values are not supported in Sagebrush.\n` +
    `${name}: The Jacobian is complex: complex values are not supported in Sagebrush.\n1\n`;
  assert.equal(r.out, block("ode15s") + block("ode23s"));
});

test("ode45's and ode23's solution structures: stats with tfinal, as MATLAB's", () => {
  // (MATLAB R2026b, observed 2026-11-22: nsteps, nfailed, nfevals, tfinal)
  const r = run([
    "for s = {@ode45, @ode23}",
    "  sol = s{1}(@(t, y) -y, [0 2], 1); fprintf('%s %g\\n', strjoin(fieldnames(sol.stats)', ','), sol.stats.tfinal)",
    "end",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "nsteps,nfailed,nfevals,tfinal 2\nnsteps,nfailed,nfevals,tfinal 2\n");
});
