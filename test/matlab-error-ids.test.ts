import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Error identifiers in MATLAB mode as real MATLAB printed them (MATLAB Online, Nov 19 2026): each case below was run
// there in try/catch and its err.identifier recorded ("OK" where MATLAB raised nothing). Only identifiers MATLAB
// printed are used; none is guessed. Where a case is not listed, Sagebrush's behavior differs from MATLAB's for a
// reason other than the identifier (fzero(@(x) NaN, 1) runs, linspace(1, 2, 'a') errors, validateattributes is absent).

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-mids-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

// [statement, the identifier MATLAB printed]
const CASES: [string, string][] = [
  ["[xq, fq] = fminsearch(@(q) NaN, 1, optimset('Display','off','FunValCheck','on'))", "MATLAB:fminsearch:checkfun:NaNFval"],
  ["[xq, fq] = fminsearch(@(q) 1i, 1, optimset('Display','off','FunValCheck','on'))", "MATLAB:fminsearch:checkfun:ComplexFval"],
  ["[xq, fq] = fminsearch(@(q) [q q], 1, optimset('Display','off','MaxIter',3))", "MATLAB:subsassigndimmismatch"],
  ["[tq, yq] = ode45(@(t,y) [y;y], [0 1], 1)", "MATLAB:odearguments:SizeIC"],
  ["[tq, yq] = ode45(@(t,y) -y, [0 1 0.5], 1)", "MATLAB:odearguments:TspanNotMonotonic"],
  ["[tq, yq] = ode45(@(t,y) -y, [0 1], 1, odeset('RelTol',-1))", "MATLAB:odearguments:RelTolNotPosScalar"],
  ["[xq, fq] = fzero(@(x) x.^2+1, [0 1])", "MATLAB:fzero:ValuesAtEndPtsSameSign"],
  ["[xq, fq] = fminbnd(@(x) x, 2, 1)", "OK"],
  ["optimset('Bogus', 1)", "MATLAB:optimset:InvalidParamNameWithLink"],
  ["odeset('Bogus', 1)", "MATLAB:odeset:InvalidPropName"],
  ["[tq, yq] = ode45(@(t,y) -y, [0 0], 1)", "MATLAB:odearguments:TspanEndpointsNotDistinct"],
  ["[tq, yq] = ode23(@(t,y) [y;y], [0 1], 1)", "MATLAB:odearguments:SizeIC"],
  ["[tq, yq] = ode45(@(t,y) -y, [0 1], 1, odeset('AbsTol',-1))", "MATLAB:odearguments:AbsTolNotPos"],
  ["interp1([1 2 3], [4 5 6], 2, 'bogus')", "MATLAB:interp1:InvalidMethod"],
  ["interp1([1 1 2], [4 5 6], 1.5)", "MATLAB:griddedInterpolant:NonUniqueCompVecsPtsErrId"],
  ["interp1([1 2], [1 2 3], 1.5)", "MATLAB:interp1:YVectorInvalidNumRows"],
  ["integral(@(x) x, 0, 1, 'Bogus', 1)", "MATLAB:TooManyInputs"],
  ["integral(@(x) ones(2,1), 0, 1)", "MATLAB:integral:FxNotSameSizeAsX"],
  ["reshape(1:6, 4, 2)", "MATLAB:getReshapeDims:notSameNumel"],
  ["reshape(1:6, [], 4)", "MATLAB:getReshapeDims:notDivisible"],
  ["cat(1, [1 2], [1 2 3])", "MATLAB:catenate:dimensionMismatch"],
  ["[[1;2], [1 2 3]]", "MATLAB:catenate:dimensionMismatch"],
  ["[1 2] + [1 2 3]", "MATLAB:sizeDimensionsMustMatch"],
  ["ones(2,3) \\ ones(3,1)", "MATLAB:dimagree"],
  ["inv(ones(2,3))", "MATLAB:square"],
  ["mat2cell(1:4, 1, [1 2])", "MATLAB:mat2cell:VectorSumMismatch"],
  ["xq22 = [1 2]; xq22(3)", "MATLAB:badsubscript"],
  ["xq22 = [1 2]; xq22(1.5)", "MATLAB:badsubscript"],
  ["sq22.a = 1; sq22.b", "MATLAB:nonExistentField"],
  ["cq22 = {1}; cq22{2}", "MATLAB:badsubscript"],
  ["fieldnames(5)", "MATLAB:fieldnames:InvalidInput"],
  ["struct('a', {1,2}, 'b', {1,2,3})", "MATLAB:StructConversion:DimensionMismatch"],
  ["cell2mat({1, 'a'})", "OK"],
  ["cellfun(@(x) [x x], {1, 2})", "MATLAB:cellfun:NotAScalarOutput"],
  ["arrayfun(@(x) [x x], [1 2])", "MATLAB:arrayfun:NotAScalarOutput"],
  ["str2func(42)", "MATLAB:string:MustBeStringScalarOrCharacterVector"],
  ["sprintf(42)", "MATLAB:badformat_mx"],
  ["feval('noSuchFunctionQ22')", "MATLAB:UndefinedFunction"],
  ["norm({1})", "MATLAB:norm:inputType"],
];

function ids(stmts: string[]) {
  const src = stmts.map((s, k) =>
    `try, ${s}; fprintf('@@%d|OK\\n', ${k}); catch e, fprintf('@@%d|%s\\n', ${k}, e.identifier); end`).join("\n");
  const r = run(src);
  assert.equal(r.status, 0, r.err);
  return r.out.split("\n").filter((l) => l.startsWith("@@")).map((l) => l.slice(l.indexOf("|") + 1));
}

test("each error carries the identifier MATLAB printed for it", () => {
  const got = ids(CASES.map((c) => c[0]));
  assert.deepEqual(CASES.map((c, k) => `${c[0]} -> ${got[k]}`), CASES.map((c) => `${c[0]} -> ${c[1]}`));
});

test("identifiers stay with the function MATLAB printed them for", () => {
  // the same checks in neighbors MATLAB was not asked about keep no identifier, and text arguments still work
  const got = ids([
    "fminbnd(@(x) [x x], 0, 1)",
    "structfun(@(x) [x x], struct('a', 1))",
    "quadgk(@(x) x, 0, 1, 'Bogus', 1)",
    "f = str2func([\"sin\"]); assert(f(0) == 0)",
  ]);
  assert.deepEqual(got, ["", "", "", "OK"]);
});
