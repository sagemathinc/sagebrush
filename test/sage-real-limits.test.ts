import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Real fields against sizes that would start unbounded exact arithmetic:
// refused in words, before the work, in a 96 MiB heap.  HARD-RRQ-1: a
// RealField precision past 2^20 bits (rounding builds integers of that
// size); HARD-RRQ-2: a rational with a numerator or denominator past 2^20
// bits, converted to RR, RealField(p) or RDF (shifts and divisions of that
// size); HARD-RRQ-3: an RDF power with an integer exponent past 2^20 bits.

const CLI = __dirname + "/../src/cli.js";
const run = (src: string) =>
  spawnSync(process.execPath, ["--max-old-space-size=96", CLI, "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });

const probe = (cases: string[]) =>
  "def t(label, f):\n" +
  "    try:\n" +
  "        r = f()\n" +
  "        print(label, 'ok', type(r).__name__)\n" +
  "    except NotImplementedError as e:\n" +
  "        print(label, 'refused', str(e))\n" +
  cases.join("\n") + "\n";

test("a RealField precision past 2^20 bits is refused before the field is made (HARD-RRQ-1)", () => {
  const r = run(probe([
    "t('10^9', lambda: RealField(10^9))",
    "t('10^9 one', lambda: RealField(10^9)(1))",
    "t('2^20+1', lambda: RealField(2^20 + 1))",
    "t('CC', lambda: ComplexField(10^9))",
    "t('2^20', lambda: RealField(2^20)(1))",
  ]));
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.equal(r.stdout,
    "10^9 refused RealField(1000000000): a precision past the limit of 1048576 bits is not available in sagebrush yet\n" +
    "10^9 one refused RealField(1000000000): a precision past the limit of 1048576 bits is not available in sagebrush yet\n" +
    "2^20+1 refused RealField(1048577): a precision past the limit of 1048576 bits is not available in sagebrush yet\n" +
    "CC refused RealField(1000000000): a precision past the limit of 1048576 bits is not available in sagebrush yet\n" +
    "2^20 ok RealNumberMP\n");
});

test("a rational past 2^20 bits is refused by RR, RealField(p) and RDF (HARD-RRQ-2)", () => {
  const ops = ["*", "+", "/", "^"];
  const cases: string[] = ["big = (2^(2^21) + 1)/3", "tiny = 1/2^(2^21)", "ok = (2^(2^20 - 64) + 1)/3"];
  for (const [n, x] of [["RR", "RR(2)"], ["R100", "RealField(100)(2)"], ["RDF", "RDF(2)"]]) {
    for (const op of ops) {
      cases.push(`t('${n} ${op} big', lambda: ${x} ${op} big)`);
      cases.push(`t('big ${op} ${n}', lambda: big ${op} ${x})`);
      cases.push(`t('${n} ${op} tiny', lambda: ${x} ${op} tiny)`);
    }
  }
  cases.push("t('RR()', lambda: RR(big))", "t('R100()', lambda: RealField(100)(tiny))", "t('RDF()', lambda: RDF(tiny))");
  cases.push("t('RR ok', lambda: RR(2) * ok)", "t('RDF ok', lambda: RDF(2) * ok)", "t('R100 ok', lambda: RealField(100)(ok))");
  const r = run(probe(cases));
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3 * 4 * 3 + 6);
  for (const line of lines.slice(0, -3))
    assert.match(line, / refused a rational with more than 1048576 bits/, line);
  assert.deepEqual(lines.slice(-3), ["RR ok ok RealNumber", "RDF ok ok RealDoubleElement", "R100 ok ok RealNumberMP"]);
});

test("an RDF integer power with an exponent past 2^20 bits is refused (HARD-RRQ-3)", () => {
  const r = run(probe([
    "n = 2^(2^21)",
    "t('pos', lambda: RDF(1.5)^n)",
    "t('neg', lambda: RDF(1.5)^(-n))",
    "t('2^70', lambda: RDF(0.5)^(2^70))",
    "print(RDF(0.5)^(2^70), RDF(-1)^(2^(2^20 - 1) + 1), RDF(1.0000001)^(2^1000))",
  ]));
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.equal(r.stdout,
    "pos refused RDF power: an integer exponent of more than 1048576 bits is not available in sagebrush yet\n" +
    "neg refused RDF power: an integer exponent of more than 1048576 bits is not available in sagebrush yet\n" +
    "2^70 ok RealDoubleElement\n" +
    "0.0 -1.0 +infinity\n");
});
