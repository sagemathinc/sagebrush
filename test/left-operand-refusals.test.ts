import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// An inexact number over a polynomial over QQ: Sage computes in the fraction
// field of the polynomials over the number's field, which sagebrush has not
// yet, so it says so rather than a bare TypeError; a Python float or complex
// is refused, as in Sage.
const TEST = __dirname + "/../../test/";
test("an inexact number over a polynomial: sagebrush's own refusal, not a TypeError", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "left_operand_refusals.sage"], { encoding: "utf8", timeout: 120000 });
  const frac = (F: string) => `NotImplementedError: the fraction field of Univariate Polynomial Ring in t over ${F} is not available in sagebrush yet`;
  assert.deepEqual(out.trim().split("\n"), [
    frac("Real Field with 53 bits of precision"),
    frac("Real Double Field"),
    frac("Complex Field with 53 bits of precision"),
    frac("Complex Double Field"),
    "TypeError: unsupported operand type(s) for /: 'float' and 'Polynomial'",
    "TypeError: unsupported operand type(s) for /: 'complex' and 'Polynomial'",
    "TypeError: unsupported operand type(s) for /: 'complex' and 'FFMatrix'",
  ]);
});
