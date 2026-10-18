import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// proof=True for class groups (lib/_sage_nf.py _proven_bnf): which
// independent check runs, that a cached GRH result is never used for it,
// that a disagreement is a RuntimeError, and that refusals and failures of
// the certificate are NotImplementedError.
const sage = (src: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", "x = polygen(QQ, 'x')\n" + src], { encoding: "utf8" });
const err = (src: string) => sage("try:\n    " + src + "\nexcept Exception as e:\n    print(type(e).__name__ + ': ' + str(e))\n").trim();

test("proof=True: the independent check for each kind of quadratic field", () => {
  const out = sage(
    "for f in [x^2 - 10, x^2 - 1066, x^2 + 23, x^2 + 1067, x^3 - 11]:\n" +
    "    K = NumberField(f, 'a'); print(K.class_number(proof=True), K._bnf_proof_check)\n");
  assert.equal(out, "2 ('real forms',)\n4 ('quadratic',)\n3 ('reduced forms',)\n12 ('quadratic', 'reduced forms')\n2 ()\n");
});

test("proof=True: a cached GRH result is not the cross-check", () => {
  assert.equal(sage("K = NumberField(x^2 - 1066, 'a'); K._bnf = {'h': 8, 'cyc': [8], 'assumes': ['GRH']}\nprint(K.class_number(proof=True), K._bnf_proof_check)\n"),
    "4 ('quadratic',)\n");
});

test("proof=True: a disagreeing cross-check is a RuntimeError", () => {
  assert.equal(err("K = NumberField(x^2 - 1066, 'a'); K._quadratic_bnfdata = lambda: {'h': 4, 'cyc': [4]}; K.class_group(proof=True)"),
    "RuntimeError: the proven class group [2, 2] disagrees with the quadratic algorithms' [4]");
  assert.equal(err("import _sage_nf; _sage_nf._count_real_classes = lambda D: 5; NumberField(x^2 - 10, 'a').class_number(proof=True)"),
    "RuntimeError: the proven class number 2 is not the number of classes of reduced forms");
  assert.equal(err("import _sage_nf; _sage_nf._count_reduced_forms = lambda D: 5; NumberField(x^2 + 23, 'a').class_number(proof=True)"),
    "RuntimeError: the proven class number 3 is not the number of reduced forms");
});

test("proof=True: refusals and failures of the certificate are NotImplementedError", () => {
  assert.equal(err("NumberField(x^2 + 3*10^12 + 1, 'a').class_number(proof=True)"),
    "NotImplementedError: class_number with proof=True: beyond the limits of the unconditional certificate: the Minkowski bound for the norms of ideal class representatives is 2205315, above the limit 1000000 (2.205 times it)");
  assert.equal(err("K = NumberField(x^2 - 7, 'a'); K._bnf_proof = 'the certificate failed at l = 2: for this test'; K.regulator(proof=True)"),
    "NotImplementedError: regulator with proof=True: the certificate failed at l = 2: for this test");
  // the GRH answers stay available
  assert.equal(sage("K = NumberField(x^2 - 7, 'a'); K._bnf_proof = 'the certificate failed'\nprint(K.class_number(), K.class_number(proof=False))\n"), "1 1\n");
});

test("the quadratic algorithms failing: the general algorithm, and forms for proof=True", () => {
  // (realq.rs used to fail for many D, e.g. "no convergence" at 1004 and a
  // panic at 2077; any failure must fall back, not surface)
  const fail = "import _sage_nf; _sage_nf.NumberField_absolute._quadratic_bnfdata = lambda self: (_ for _ in ()).throw(ValueError('no convergence'))\n";
  assert.equal(sage(fail + "K = NumberField(x^2 - 1066, 'a'); print(K.class_number(), K.class_group().invariants())\n"), "4 (2, 2)\n");
  assert.equal(sage(fail + "K = NumberField(x^2 - 1066, 'a'); print(K.class_number(proof=True), K._bnf_proof_check)\n"), "4 ('real forms',)\n");
  assert.equal(sage(fail + "K = NumberField(x^2 + 1067, 'a'); print(K.class_number(proof=True), K._bnf_proof_check)\n"), "12 ('reduced forms',)\n");
});

test("real quadratic fields that used to fail (no convergence; a panic at 2077)", () => {
  // (class groups from Sage)
  assert.equal(sage("for D in [1004, 1013, 1021, 2077, 5945]:\n    K = QuadraticField(D); print(D, K.class_number(), K.class_group().invariants(), K.class_number(proof=True))\n"),
    "1004 1 () 1\n1013 1 () 1\n1021 1 () 1\n2077 1 () 1\n5945 4 (2, 2) 4\n");
});

test("proof=False: quadratic fields skip the analytic certificate, cached apart from the default data", () => {
  // proof=False first: uncertified and labelled; a default call after it still certifies, and proof=False then reuses that
  assert.equal(sage("K = NumberField(x^2 + 67128026883063, 'a')\nprint(K.class_group(proof=False).invariants(), K._bnf, K._bnf_uncertified['certified'], any('estimate' in a for a in K._bnf_uncertified['assumes']))\n" +
    "print(K.class_group().invariants(), K._bnf['certified'], K._bnf_checked(False) is K._bnf)\n"),
    "(327924, 2, 2, 2, 2) None False True\n(327924, 2, 2, 2, 2) True True\n");
  // certified first: proof=False reuses it and computes nothing uncertified
  assert.equal(sage("K = NumberField(x^2 + 67128026883063, 'a')\nprint(K.class_number(), K.class_number(proof=False), K._bnf_checked(False) is K._bnf, K._bnf_uncertified)\n"),
    "5246784 5246784 True None\n");
  // |d| < 1000: the default path
  assert.equal(sage("K = NumberField(x^2 + 23, 'a')\nprint(K.class_number(proof=False), K._bnf_uncertified, K._bnf is not None)\n"), "3 None True\n");
});
