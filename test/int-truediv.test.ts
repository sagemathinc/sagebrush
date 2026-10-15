import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// int / int against CPython 3.14 (test/int-truediv-cpython.json, from
// test/int_truediv_gen.py): big integers whose quotients are subnormal or
// tiny, exact ties at the subnormal precisions, quotients next to 2^1024, and
// ordinary ones.  CPython rounds a / b once to the nearest double, subnormals
// included, so the results must be its exactly, the sign of a zero too
// (compared as repr, which tells -0.0 from 0.0).
const cases: [string, string, string][] = JSON.parse(readFileSync(__dirname + "/../../test/int-truediv-cpython.json", "utf8"));

const program = `
import json, sys
from fractions import Fraction
out = []
for a, b in json.loads(sys.stdin.read()):
    a, b = int(a), int(b)
    try:
        v = a / b
        f = float(Fraction(a, b))
        out.append(repr(v) if f == v or v != v else "Fraction differs: %r %r" % (v, f))
    except OverflowError:
        out.append("!OverflowError")
print(json.dumps(out))
`;

test("int / int and float(Fraction) round once, as CPython does, subnormals included", () => {
  const got: string[] = JSON.parse(
    execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], {
      input: JSON.stringify(cases.map(([a, b]) => [a, b])),
      encoding: "utf8",
      maxBuffer: 1 << 26,
    }),
  );
  const bad = cases.filter((c, i) => got[i] !== c[2]).map((c, i) => `${c[0]} / ${c[1]}: ${got[cases.indexOf(c)]}, CPython ${c[2]}`);
  assert.deepEqual(bad.slice(0, 5), []);
});
