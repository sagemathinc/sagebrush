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

// A value off the real line, an infinity or a pole (Sage's is in
// ComplexField(p), the second part of the work, or a symbolic infinity or NaN)
// is refused, never a wrong number; a call of NaN stays as it is, as Sage's.
test("RealField(p) numbers in symbolic expressions: complex, infinite and undefined values refused", () => {
  const cases = [
    "arcsin(SR(R(2)))", "arccos(SR(R(-3)))", "arccosh(SR(R(0.5)))", "arctanh(SR(R(2)))", "log(SR(R(-2)))",
    "sqrt(SR(R(-2)))", "SR(R(-2))**(1/3)", "SR(R(2))*I", "log(SR(R(0)))", "log(SR(R(-0.0)))", "arctanh(SR(R(1)))",
    "arccosh(SR(R('inf')))", "tanh(SR(R('inf')))", "exp(SR(R('-inf')))", "gamma(SR(R(0)))", "factorial(SR(R(-2)))",
    "cot(SR(R(0)))", "csc(SR(R(0)))", "exp(SR(R(10)**40))", "exp(SR(-R(2)**70))",
  ];
  const src = ["R = RealField(100)", "for s in " + JSON.stringify(cases) + ":", "    try:", "        print(s, eval(s))",
    "    except NotImplementedError as _err:", "        print(s, 'refused:', _err)", "print(arcsin(SR(R('nan'))))"].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });
  const lines = out.trim().split("\n");
  assert.equal(lines.length, cases.length + 1, out);
  cases.forEach((c, i) => assert.ok(lines[i].startsWith(c + " refused: ") && lines[i].endsWith(" is not available in sagebrush yet"), lines[i]));
  assert.equal(lines[cases.length], "arcsin(NaN)");
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
