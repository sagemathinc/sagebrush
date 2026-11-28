import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Elements of RealField(p), p != 53, in symbolic expressions: each
// operation on numbers (sums, products, quotients, integer powers and
// functions, with numbers of other precisions, rationals, RR and RDF) gives
// exactly what RealNumberMP's own operation gives, the digits and the field
// (test/sym_mp_parity.sage); those past the exponents an expression holds
// are refused.  Against Sage itself: sage-tests/test_sym_realfield.sage.
const TEST = __dirname + "/../../test/";
test("RealField(p) numbers in symbolic expressions: parity with RealNumberMP", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "sym_mp_parity.sage"], { encoding: "utf8", timeout: 300000 });
  assert.equal(out, "checked 5153 refused 77 bad 0\n");
});

// ComplexField(p) numbers likewise: each sum, product, quotient and integer
// power with numbers of other precisions, reals, rationals and Gaussian
// rationals gives exactly ComplexNumberMP's (test/sym_mpc_parity.sage), Sage's
// ComplexNumber's operations, each step rounded (against Sage itself:
// sage-tests/test_sym_complexfield.sage and test_complexfield_ops.sage).
test("ComplexField(p) numbers in symbolic expressions: parity with ComplexNumberMP", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "sym_mpc_parity.sage"], { encoding: "utf8", timeout: 300000 });
  assert.equal(out, "checked 7473 refused 27 bad 0\n");
});

// A value Sage computes with what sagebrush doesn't have yet (the inverse
// functions off the real line, gamma at a pole), an infinity, or a value past
// the exponents an expression holds is refused, never a wrong number; a call
// of NaN stays as it is, as Sage's.  (The complex values of reals, log(-2),
// sqrt(-2), (-2)^(1/3), 2*I, and the functions at a zero, log(0) and cot(0)
// among them, are values now: sage-tests/test_sym_complexfield.sage.)
test("RealField(p) numbers in symbolic expressions: complex, infinite and undefined values refused", () => {
  const cases = [
    "arcsin(SR(R(2)))", "arccos(SR(R(-3)))", "arccosh(SR(R(0.5)))", "arctanh(SR(R(2)))", "arctanh(SR(R(1)))",
    "arccosh(SR(R('inf')))", "tanh(SR(R('inf')))", "exp(SR(R('-inf')))", "gamma(SR(R(0)))", "factorial(SR(R(-2)))",
    "exp(SR(R(10)**40))", "exp(SR(-R(2)**70))", "gamma(SR(ComplexField(100)(1, 2)))", "arcsin(SR(ComplexField(100)(1, 2)))",
    "SR(ComplexField(100)(1, 2))**(10**6)", "exp(SR(ComplexField(100)(10**40, 1)))",
    // (a ComplexField(p) number meeting a 53-bit one in CC, beyond the doubles: Sage's CC holds it, sagebrush's doesn't;
    // exact parts, as eval reads a literal 1e400 as Python's float)
    "ComplexField(100)(QQ(10)**400, 0) + RR(1)", "ComplexField(100)(QQ(10)**400, 0) * RR(1)", "ComplexField(100)(2**2000, 2**-2000) * CC(1, 1)",
    "ComplexField(100)(QQ(10)**-320, 1) + RR(1)", "ComplexField(100)(1, QQ(10)**-330) + RR(1)", "CC(1, 1) + ComplexField(100)(QQ(10)**400, 0)",
    "RDF(3) * ComplexField(100)(QQ(10)**-320, 1)", "RealField(100)(QQ(10)**400) * CC(1, 1)",
  ];
  const src = ["R = RealField(100)", "for s in " + JSON.stringify(cases) + ":", "    try:", "        print(s, eval(s))",
    "    except NotImplementedError as _err:", "        print(s, 'refused:', _err)", "print(arcsin(SR(R('nan'))))"].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });
  const lines = out.trim().split("\n");
  assert.equal(lines.length, cases.length + 1, out);
  cases.forEach((c, i) => assert.ok(lines[i].startsWith(c + " refused: ") && lines[i].endsWith(" is not available in sagebrush yet"), lines[i]));
  assert.equal(lines[cases.length], "arcsin(NaN)");
});

// A ComplexField(p) number meeting a 53-bit one in CC with a part past the doubles' normal range (rounded to 53 bits:
// 2^1024 and the tie that rounds to it, below the smallest normal, a subnormal, an underflow), in either part, either
// sign, either side, is refused: Sage's CC holds it (MPFR's exponents), sagebrush's CC of doubles doesn't, and a double
// would be infinite or lose bits.  The values just inside are Sage's: sage-tests/test_complexfield_range.sage.
test("ComplexField(p) numbers meeting CC beyond the doubles' range: refused", () => {
  const src = [
    "C = ComplexField(100)",
    "MAXD = (2 - QQ(2)^-52) * 2^1023",
    "vals = [MAXD + QQ(2)^970, QQ(2)^1024, QQ(2)^-1022 - QQ(2)^-1076 - QQ(2)^-1110, QQ(2)^-1074, QQ(2)^-1075, QQ(2)^-1100]",
    "n = r = 0",
    "for v in vals:",
    "    for sgn in [1, -1]:",
    "        for z in [C(sgn * v, 1), C(1, sgn * v)]:",
    "            for f in [lambda: z + RR(1), lambda: CC(1, 1) * z, lambda: RDF(1) + z, lambda: z * RDF(2), lambda: RR(1) - z]:",
    "                n += 1",
    "                try:",
    "                    print('NOT REFUSED', f())",
    "                except NotImplementedError as _err:",
    "                    r += 'beyond the double range' in str(_err) and str(_err).endswith('not available in sagebrush yet')",
    "print(n, r)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out, "120 120\n");
});

// The canonical order is total with NaN, -0 and +0 among the numbers (a sort of
// terms with NaN was inconsistent: a panic in the engine, or an order that
// depended on how the terms came in), for RealField(p) and RR alike.
test("RealField(p) and RR numbers: one canonical order with NaN and signed zeros", () => {
  const src = [
    "import random",
    "x = var('x')",
    "for F in (RealField(100), RR):",
    "    outs = set()",
    "    for seed in range(12):",
    "        random.seed(int(seed))",
    "        vals = [F('nan'), F(0), F(-0.0), F('inf'), F('-inf')] + [F(k)/7 for k in range(-12, 13) if k]",
    "        random.shuffle(vals)",
    "        outs.add(str(sum(x^SR(v) for v in vals) + sum(x^k for k in range(-5, 6))))",
    "    print(len(outs))",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out, "1\n1\n");
});
