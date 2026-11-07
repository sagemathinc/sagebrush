import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A polynomial over an inexact field with a polynomial over (or an element of) a
// number field with an embedding: Sage computes, sagebrush refuses rather than
// answer (L33); and Zmod(1)[u], outside the class families probed in Sage, gets
// sagebrush's own refusal (lib/_sage_rpoly.py _refuse_foreign; #784).
const TEST = __dirname + "/../../test/";
test("the inexact polynomials refuse an embedded number field and Zmod(1) with sagebrush's own errors", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "rpoly_mixed_cases.sage"], { encoding: "utf8", timeout: 120000 });
  const RR = "Real Field with 53 bits of precision";
  const K = "Number Field in w with defining polynomial x^2 - 2 with w = 1.414213562373095?";
  assert.deepEqual(out.trim().split("\n"), [
    `NotImplementedError: arithmetic with Univariate Polynomial Ring in t over ${RR} and Univariate Polynomial Ring in t over ${K} together is not available in sagebrush yet`,
    `NotImplementedError: arithmetic with Univariate Polynomial Ring in t over ${RR} and Univariate Polynomial Ring in t over ${K} together is not available in sagebrush yet`,
    `NotImplementedError: arithmetic with ${RR} and ${K} together is not available in sagebrush yet`,
    `NotImplementedError: arithmetic with ${K} and Univariate Polynomial Ring in t over ${RR} together is not available in sagebrush yet`,
    `TypeError: sagebrush does not divide polynomials over ${RR} and over Ring of integers modulo 1`,
  ]);
});
