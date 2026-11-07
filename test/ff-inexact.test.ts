import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// An inexact number with a number field that has an embedding: Sage computes,
// sagebrush refuses rather than answer (L33); and Zmod(1), outside the class
// families probed in Sage, gets sagebrush's own refusal (lib/_sage_ff.py
// refuse_inexact; L34).
const TEST = __dirname + "/../../test/";
test("Zmod, finite fields and number fields refuse an embedded number field's mix and Zmod(1) with sagebrush's own errors, and never factor in a refusal", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "ff_inexact_cases.sage"], { encoding: "utf8", timeout: 120000 });
  const K = "Number Field in w with defining polynomial x^2 - 2 with w = 1.414213562373095?";
  const RR = "Real Field with 53 bits of precision";
  const Q = "sage.rings.number_field.number_field_element_quadratic.NumberFieldElement_quadratic";
  assert.deepEqual(out.trim().split("\n"), [
    `NotImplementedError: arithmetic with ${K} and ${RR} together is not available in sagebrush yet`,
    `NotImplementedError: arithmetic with ${RR} and Univariate Polynomial Ring in t over ${K} together is not available in sagebrush yet`,
    `NotImplementedError: arithmetic with ${K} and Real Double Field together is not available in sagebrush yet`,
    `NotImplementedError: arithmetic with ${K} and <class 'float'> together is not available in sagebrush yet`,
    "NotImplementedError: arithmetic with Cyclotomic Field of order 3 and degree 2 and Complex Field with 53 bits of precision together is not available in sagebrush yet",
    "TypeError: sagebrush does not compute + with Ring of integers modulo 1 and a Python float",
    "TypeError: sagebrush does not compute * with Univariate Polynomial Ring in u over Ring of integers modulo 1 and a Python float",
    // (with the factor backends made to fail: a refusal's class is chosen without factorization, REFUSAL-WORK-1)
    ...[Q + "_sqrt", Q + "_sqrt", Q, Q, Q + "_sqrt", Q + "_sqrt", Q + "_sqrt", Q + "_sqrt"].map((c) => `TypeError: unsupported operand type(s) for +: '${c}' and 'float'`),
  ]);
});
