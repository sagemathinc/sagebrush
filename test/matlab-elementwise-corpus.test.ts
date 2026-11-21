import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Element-wise functions where Sagebrush differed from MATLAB, each row as an observed MATLAB run printed it
// (MATLAB R2026b Update 2, MATLAB Online, 2026-11-21: values, signs of zero and warning or error identifiers only).
// A value is printed with %.17g, so a signed zero shows as 0 or -0, and complex values as their real and imaginary
// parts. Design note §1: these are exact-match items.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-elem-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

// [MATLAB expression, MATLAB's printed result: real values with %.17g, a complex one as "re im"]
const ROWS: [string, string][] = [
  // (cummax and cummin omit NaN by default)
  ["cummax([1 3 NaN 2])", "1 3 3 3"],
  ["cummin([5 NaN 1 2])", "5 5 1 1"],
  ["cummax([NaN 1 2])", "NaN 1 2"],
  ["cummax([1 3 NaN 2], 'includenan')", "1 3 NaN NaN"],
  // (nthroot exact where the root is)
  ["nthroot(64, 3)", "4"],
  ["nthroot(1e-300, 3)", "1e-100"],
  // (mod and rem with an infinite divisor)
  ["mod(5, Inf)", "5"],
  ["mod(-5, Inf)", "Inf"],
  ["mod(1, -Inf)", "-Inf"],
  ["rem(0, Inf)", "0"],
  ["rem(Inf, Inf)", "NaN"],
  // (a zero result of mod takes the divisor's sign)
  ["mod(-0, 1)", "0"],
  ["mod(-2, 2)", "0"],
  ["mod(-1, 0.5)", "0"],
  ["mod(0, -1)", "-0"],
  ["mod(2, -2)", "-0"],
  ["mod(0, -0)", "-0"],
  // (power: a negative base to a half-integer, a zero base, a NaN exponent)
  ["(-1)^0.5", "0 1"],
  ["power(-2, 0.5)", "0 1.4142135623730951"],
  ["power(-Inf, 0.5)", "0 Inf"],
  ["power(-0, 0.5)", "0"],
  ["power(-1, NaN)", "NaN"],
  ["power(-Inf, NaN)", "NaN"],
  // (hypot of a NaN and an infinity, atan2 of two zeros)
  ["hypot(Inf, NaN)", "NaN"],
  ["hypot(NaN, -Inf)", "NaN"],
  ["atan2(-0, 0)", "0"],
  // (gamma at -0 and -Inf)
  ["gamma(-0)", "Inf"],
  ["gamma(-Inf)", "Inf"],
];

const fmt = (e: string) =>
  `x = ${e}; if isreal(x), fprintf('%s\\n', strjoin(arrayfun(@(v) sprintf('%.17g', v), x, 'UniformOutput', false), ' ')); ` +
  `else, fprintf('%.17g %.17g\\n', real(x), imag(x)); end`;

test("element-wise results as MATLAB prints them: values and signs of zero", () => {
  const r = run(ROWS.map(([e]) => fmt(e)).join("\n"));
  assert.equal(r.status, 0, r.err);
  const got = r.out.trim().split("\n");
  assert.deepEqual(ROWS.map(([e], k) => `${e} -> ${got[k]}`), ROWS.map(([e, w]) => `${e} -> ${w}`));
});

test("a real NaN exponent stays real, and gammaln of a negative number is MATLAB's error", () => {
  const r = run([
    "disp(isreal(power(-1, NaN)))",
    "for v = [-1 -Inf -5e-324], try, gammaln(v); disp('no error'), catch e, disp(e.identifier), end, end",
    "disp(gammaln([0 1]))",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "   1\nMATLAB:gammaln:negativeVal\nMATLAB:gammaln:negativeVal\nMATLAB:gammaln:negativeVal\n   Inf     0\n");
});
