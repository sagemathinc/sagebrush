import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB's optimoptions, fsolve, fminunc, lsqcurvefit and linprog in MATLAB mode (lib/_matlab_optim.py), against
// the rows an observed MATLAB R2026b run printed for the same script (values, identifiers and display text only,
// 2026-11-22): exit flags, sizes, field names, error identifiers and messages and the default display texts
// exactly; solutions within 1e-5 (relative, or absolute below 1), the solvers' tolerances, since the iterates are
// Sagebrush's own.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-optim-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

// (the probe without its evalc rows: MATLAB mode has no evalc; the displays are checked below as printed)
const SCRIPT = [
  "fmt = @(v) sprintf('%.17g ', v);",
  "p = @(name, v) fprintf('%s|%s|%s\\n', name, mat2str(size(v)), fmt(double(v(:)')));",
  "t = @(name, s) fprintf('%s|TEXT|%s\\n', name, strrep(strrep(s, newline, '\\n'), '|', '/'));",
  "e = @(name, err) fprintf('%s|ERR|%s|%s\\n', name, err.identifier, strrep(err.message, newline, ' '));",
  "f1 = @(x) [x(1)^2 + x(2)^2 - 4; x(1) - x(2)];",
  "try, [x, fval, flag] = fsolve(f1, [1; 1], optimoptions('fsolve', 'Display', 'off')); catch err_, fprintf('line8|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, p('fs1_x', x); p('fs1_fval', fval); p('fs1_flag', flag); catch err_, fprintf('line9|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag, out] = fsolve(@(x) exp(x) - 2, 0, optimoptions('fsolve', 'Display', 'off')); p('fs2_x', x); p('fs2_flag', flag); t('fs2_out_fields', strjoin(fieldnames(out)', ',')); catch err_, fprintf('line11|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, ~, flag] = fsolve(@(x) x.^2 + 1, 1, optimoptions('fsolve', 'Display', 'off')); p('fs3_noroot_flag', flag); catch err_, fprintf('line12|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, ~, flag] = fsolve(@(x) [x(1) + x(2) - 3; x(1) - x(2) - 1], [0 0], optimset('Display', 'off')); p('fs4_row_x', x); p('fs4_flag', flag); catch err_, fprintf('line13|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, fsolve(@(x) x, 'a'), catch err, e('fs_badx0', err); end",
  "try, fsolve(1, 0), catch err, e('fs_badfun', err); end",
  "rosen = @(x) 100*(x(2) - x(1)^2)^2 + (1 - x(1))^2;",
  "try, [x, fval, flag] = fminunc(rosen, [-1.2; 1], optimoptions('fminunc', 'Display', 'off')); p('fu1_x', x); p('fu1_fval', fval); p('fu1_flag', flag); catch err_, fprintf('line18|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag, out, g] = fminunc(@(x) sum((x - [1 2 3]).^2), [0 0 0], optimoptions('fminunc', 'Display', 'off')); p('fu2_x', x); p('fu2_g', g); p('fu2_flag', flag); t('fu2_out_fields', strjoin(fieldnames(out)', ',')); catch err_, fprintf('line20|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag, out, g, H] = fminunc(@(x) x'*[2 1; 1 3]*x/2 - [1 1]*x, [0; 0], optimoptions('fminunc', 'Display', 'off')); p('fu3_x', x); p('fu3_H', H); catch err_, fprintf('line21|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "fg = @(x) deal(sum(x.^2), 2*x);",
  "try, [x, ~, flag] = fminunc(fg, [3; -4], optimoptions('fminunc', 'Display', 'off', 'SpecifyObjectiveGradient', true)); p('fu4_grad_x', x); p('fu4_flag', flag); catch err_, fprintf('line23|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, fminunc(@(x) [x; x], 1, optimoptions('fminunc', 'Display', 'off')), catch err, e('fu_vecobj', err); end",
  "xd = (0:0.5:4)'; yd = 3*exp(-0.7*xd) + 0.5;",
  "model = @(c, x) c(1)*exp(-c(2)*x) + c(3);",
  "try, [c, resnorm, residual, flag] = lsqcurvefit(model, [1 1 0], xd, yd, [], [], optimoptions('lsqcurvefit', 'Display', 'off')); catch err_, fprintf('line28|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, p('lc1_c', c); p('lc1_resnorm', resnorm); p('lc1_residual_size', size(residual)); p('lc1_flag', flag); catch err_, fprintf('line29|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [c, resnorm, ~, flag] = lsqcurvefit(model, [1 1 0], xd, yd, [0 0 0], [2 2 2], optimoptions('lsqcurvefit', 'Display', 'off')); p('lc2_bounded_c', c); p('lc2_flag', flag); catch err_, fprintf('line31|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [c, ~, ~, ~, out] = lsqcurvefit(@(c, x) c(1) + c(2)*x, [0; 0], [1; 2; 3], [2; 4; 6], [], [], optimoptions('lsqcurvefit', 'Display', 'off')); p('lc3_lin_c', c); t('lc3_out_fields', strjoin(fieldnames(out)', ',')); catch err_, fprintf('line32|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, lsqcurvefit(model, [1 1 0], xd, yd(1:3)), catch err, e('lc_sizes', err); end",
  "f = [-1; -2]; A = [1 1; 1 -1; -1 2]; b = [4; 2; 4];",
  "try, [x, fval, flag] = linprog(f, A, b, [], [], [0; 0], [], optimoptions('linprog', 'Display', 'off')); p('lp1_x', x); p('lp1_fval', fval); p('lp1_flag', flag); catch err_, fprintf('line36|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag, out, lambda] = linprog(f, A, b, [], [], [0; 0], [], optimoptions('linprog', 'Display', 'off')); p('lp2_ineqlin', lambda.ineqlin); p('lp2_lower', lambda.lower); t('lp2_out_fields', strjoin(fieldnames(out)', ',')); t('lp2_lambda_fields', strjoin(fieldnames(lambda)', ',')); catch err_, fprintf('line38|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag] = linprog([1 1], [], [], [1 2], 4, [0 0], [], optimoptions('linprog', 'Display', 'off')); p('lp3_eq_x', x); p('lp3_flag', flag); catch err_, fprintf('line39|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag] = linprog([-1; -1], [1 -1], 1, [], [], [0; 0], [], optimoptions('linprog', 'Display', 'off')); p('lp4_unbounded_flag', flag); p('lp4_x_size', size(x)); catch err_, fprintf('line40|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag] = linprog([1; 1], [1 1; -1 -1], [1; -3], [], [], [], [], optimoptions('linprog', 'Display', 'off')); p('lp5_infeasible_flag', flag); p('lp5_x_size', size(x)); catch err_, fprintf('line41|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, [x, fval, flag] = linprog([1; 2; 3], [], [], [1 1 1], 1, [0; 0; 0], [1; 1; 1], optimoptions('linprog', 'Display', 'off')); p('lp6_box_x', x); catch err_, fprintf('line42|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, linprog([1; 2], [1 2 3], 1), catch err, e('lp_sizes', err); end",
  "try, o = optimoptions('fsolve', 'TolFun', 1e-10); t('opt_fsolve_class', class(o)); p('opt_fsolve_ftol', o.FunctionTolerance); catch err_, fprintf('line45|ERR|%s|%s\\n', err_.identifier, strrep(err_.message, newline, ' ')); end",
  "try, optimoptions('fsolve', 'NoSuchOption', 1), catch err, e('opt_bad', err); end"
].join("\n");

// MATLAB R2026b's rows: [size, values], or ["TEXT", text] and ["ERR", "identifier|message"]
const MATLAB: Record<string, [string, string]> = {
  "fs1_x": [
    "[2 1]",
    "1.4142135623747034 1.4142135623747034 "
  ],
  "fs1_fval": [
    "[2 1]",
    "9.0984997314080829e-12 0 "
  ],
  "fs1_flag": [
    "[1 1]",
    "1 "
  ],
  "fs2_x": [
    "[1 1]",
    "0.69314718056002622 "
  ],
  "fs2_flag": [
    "[1 1]",
    "1 "
  ],
  "fs2_out_fields": [
    "TEXT",
    "iterations,funcCount,algorithm,firstorderopt,message"
  ],
  "fs3_noroot_flag": [
    "[1 1]",
    "-2 "
  ],
  "fs4_row_x": [
    "[1 2]",
    "1.9999999999999996 0.99999999999999978 "
  ],
  "fs4_flag": [
    "[1 1]",
    "1 "
  ],
  "fs_badx0": [
    "ERR",
    "optim:fsolve:NonDoubleInput|FSOLVE requires the following inputs to be of data type double: 'X0'."
  ],
  "fs_badfun": [
    "ERR",
    "MATLAB:fcnchk:invalidFunctionSpecifier|FUN must be a function, a valid character vector expression, or an inline function object."
  ],
  "fu1_x": [
    "[2 1]",
    "0.99999468915391021 0.9999894144697562 "
  ],
  "fu1_fval": [
    "[1 1]",
    "2.8335650838680855e-11 "
  ],
  "fu1_flag": [
    "[1 1]",
    "1 "
  ],
  "fu2_x": [
    "[1 3]",
    "1.0000000596046461 2.0000000298023233 3.0000000000000009 "
  ],
  "fu2_g": [
    "[3 1]",
    "1.341104542973424e-07 8.9406969383531921e-08 4.4703485357899795e-08 "
  ],
  "fu2_flag": [
    "[1 1]",
    "1 "
  ],
  "fu2_out_fields": [
    "TEXT",
    "iterations,funcCount,stepsize,lssteplength,firstorderopt,algorithm,message"
  ],
  "fu3_x": [
    "[2 1]",
    "0.4000000007523572 0.1999999896549447 "
  ],
  "fu3_H": [
    "[2 2]",
    "1.9999999962747097 1 1 3 "
  ],
  "fu4_grad_x": [
    "[2 1]",
    "0 8.8817841970012523e-16 "
  ],
  "fu4_flag": [
    "[1 1]",
    "1 "
  ],
  "fu_vecobj": [
    "ERR",
    "optimlib:fmincon:NonScalarObj|Supplied objective function must return a scalar value."
  ],
  "lc1_c": [
    "[1 3]",
    "2.9999999999988129 0.69999999999968099 0.50000000000110423 "
  ],
  "lc1_resnorm": [
    "[1 1]",
    "1.1128580770766117e-23 "
  ],
  "lc1_residual_size": [
    "[1 2]",
    "9 1 "
  ],
  "lc1_flag": [
    "[1 1]",
    "1 "
  ],
  "lc2_bounded_c": [
    "[1 3]",
    "1.9999999913948252 0.87831699833261201 0.96713595664363261 "
  ],
  "lc2_flag": [
    "[1 1]",
    "3 "
  ],
  "lc3_lin_c": [
    "[2 1]",
    "-1.7166135419079635e-14 2.000000000000008 "
  ],
  "lc3_out_fields": [
    "TEXT",
    "firstorderopt,iterations,funcCount,cgiterations,algorithm,stepsize,message,bestfeasible,constrviolation"
  ],
  "lc_sizes": [
    "ERR",
    "optimlib:lsqcurvefit:YdataSizeMismatchFunVal|Function value and YDATA sizes are not equal."
  ],
  "lp1_x": [
    "[2 1]",
    "1.3333333333333333 2.666666666666667 "
  ],
  "lp1_fval": [
    "[1 1]",
    "-6.666666666666667 "
  ],
  "lp1_flag": [
    "[1 1]",
    "1 "
  ],
  "lp2_ineqlin": [
    "[3 1]",
    "1.3333333333333335 0 0.33333333333333331 "
  ],
  "lp2_lower": [
    "[2 1]",
    "0 0 "
  ],
  "lp2_out_fields": [
    "TEXT",
    "iterations,constrviolation,message,algorithm,firstorderopt"
  ],
  "lp2_lambda_fields": [
    "TEXT",
    "lower,upper,eqlin,ineqlinLower,ineqlin"
  ],
  "lp3_eq_x": [
    "[2 1]",
    "0 2 "
  ],
  "lp3_flag": [
    "[1 1]",
    "1 "
  ],
  "lp4_unbounded_flag": [
    "[1 1]",
    "-3 "
  ],
  "lp4_x_size": [
    "[1 2]",
    "0 0 "
  ],
  "lp5_infeasible_flag": [
    "[1 1]",
    "-2 "
  ],
  "lp5_x_size": [
    "[1 2]",
    "0 0 "
  ],
  "lp6_box_x": [
    "[3 1]",
    "1 0 0 "
  ],
  "lp_sizes": [
    "ERR",
    "optim:linprog:SizeMismatchColsOfA|The number of columns in A must be the same as the number of elements of f."
  ],
  "opt_fsolve_class": [
    "TEXT",
    "optim.options.Fsolve"
  ],
  "opt_fsolve_ftol": [
    "[1 1]",
    "1e-10 "
  ],
  "opt_bad": [
    "ERR",
    "optimlib:optimoptions:UnmatchedParameter|'NoSuchOption' is not an option for FSOLVE. A list of options can be found on the FSOLVE documentation page."
  ]
};

// (rows compared otherwise: the bounded fit, where MATLAB stops on FunctionTolerance in a flat valley, checked as
// exitflag 3, c(1) held at its bound and a sum of squares no larger than MATLAB's; the quasi-Newton Hessian, an
// approximation, within 1e-6)
const SPECIAL = new Set(["lc2_bounded_c"]);
const LOOSE: Record<string, number> = { fu3_H: 1e-6 };

test("fsolve, fminunc, lsqcurvefit, linprog and optimoptions: the rows of an observed MATLAB run", () => {
  const r = run(SCRIPT);
  assert.equal(r.status, 0, r.err);
  const got = new Map<string, [string, string]>();
  for (const line of r.out.trim().split("\n")) {
    const [name, size, ...rest] = line.split("|");
    got.set(name, [size, rest.join("|")]);
  }
  for (const [name, [size, values]] of Object.entries(MATLAB)) {
    if (SPECIAL.has(name)) continue;
    const g = got.get(name);
    assert.ok(g, `${name}: not printed`);
    assert.equal(g[0], size, `${name}: size or kind`);
    if (size === "TEXT" || size === "ERR") {
      assert.equal(g[1], values, `${name}`);
      continue;
    }
    const want = values.trim().split(" ").map(Number), have = g[1].trim().split(" ").map(Number);
    assert.equal(have.length, want.length, `${name}: count`);
    const tol = LOOSE[name] ?? 1e-5;
    want.forEach((w, k) => assert.ok(Math.abs(w - have[k]) <= tol * Math.max(1, Math.abs(w)), `${name}[${k}]: ${have[k]}, MATLAB ${w}`));
  }
});

test("lsqcurvefit with bounds: exitflag 3, the bound held, a sum of squares no larger than MATLAB's", () => {
  const r = run([
    "xd = (0:0.5:4)'; yd = 3*exp(-0.7*xd) + 0.5; model = @(c, x) c(1)*exp(-c(2)*x) + c(3);",
    "[c, rn, ~, flag] = lsqcurvefit(model, [1 1 0], xd, yd, [0 0 0], [2 2 2], optimoptions('lsqcurvefit', 'Display', 'off'));",
    "cm = [1.9999999913948252 0.87831699833261201 0.96713595664363261];  % (MATLAB R2026b's)",
    "fprintf('%d %d %d %d\\n', flag, c(1) == 2, rn <= sum((model(cm, xd) - yd).^2), max(abs(c - cm)) < 1e-3)",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "3 1 1 1\n");
});

test("the default Display 'final' texts, as MATLAB prints them", () => {
  const r = run([
    "x = fsolve(@(x) [x(1)^2 + x(2)^2 - 4; x(1) - x(2)], [1; 1]); disp('==')",
    "x = fminunc(@(x) 100*(x(2) - x(1)^2)^2 + (1 - x(1))^2, [-1.2; 1]); disp('==')",
    "xd = (0:0.5:4)'; yd = 3*exp(-0.7*xd) + 0.5;",
    "c = lsqcurvefit(@(c, x) c(1)*exp(-c(2)*x) + c(3), [1 1 0], xd, yd); disp('==')",
    "x = linprog([-1; -2], [1 1; 1 -1; -1 2], [4; 2; 4]); disp('==')",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out.split("==\n").slice(0, 4), [
  "\nEquation solved.\n\nfsolve completed because the vector of function values is near zero\nas measured by the value of the function tolerance, and\nthe problem appears regular as measured by the gradient.\n\n<stopping criteria details>\n",
  "\nLocal minimum found.\n\nOptimization completed because the size of the gradient is less than\nthe value of the optimality tolerance.\n\n<stopping criteria details>\n",
  "\nLocal minimum found.\n\nOptimization completed because the size of the gradient is less than\nthe value of the optimality tolerance.\n\n<stopping criteria details>\n",
  "\nOptimal solution found.\n\n"
]);
});

test("optimoptions is a value: copies, struct fields and cell elements don't share it", () => {
  const r = run([
    "o = optimoptions('fsolve'); o2 = o; o2.Display = 'off'; disp(o.Display), disp(o2.Display)",
    "o3 = optimoptions(o2, 'MaxIterations', 50); fprintf('%g %g\\n', o3.MaxIterations, o2.MaxIterations)",
    "s.o = o; s.o.Display = 'iter'; disp(o.Display)",
    "c = {o}; c{1}.FunctionTolerance = 1; fprintf('%g\\n', o.FunctionTolerance)",
    "o4 = optimoptions(@fminunc, 'GradObj', 'on'); fprintf('%d %s\\n', o4.SpecifyObjectiveGradient, class(o4))",
    "x = fsolve(@(x) x - 2, 0, optimset('Display', 'off')); fprintf('%g\\n', x)",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "final\noff\n50 400\nfinal\n1e-06\n1 optim.options.Fminunc\n2\n");
});
