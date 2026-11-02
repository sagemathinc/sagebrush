import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// sys.float_info (src/runtime/modules.ts): every field CPython's type, so its
// max is a float (an integral JS number is an int in Sagebrush: max was one,
// and numpy refused it as an int64 beyond 2**53, daybreak3 on #489), and the
// values the IEEE double's.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("sys.float_info: each field of CPython's type and value, max a float", () => {
  const out = py(`
import sys, numpy as np
f = sys.float_info
print([type(v).__name__ for v in f])
print(f.max == 1.7976931348623157e308, f.max * 2 == float("inf"), f.min == 2.2250738585072014e-308, f.epsilon == 2.220446049250313e-16)
print(f.max_exp, f.max_10_exp, f.min_exp, f.min_10_exp, f.dig, f.mant_dig, f.radix, f.rounds)
print(float(np.asarray(f.max)) == f.max)
`);
  assert.equal(out, [
    "['float', 'int', 'int', 'float', 'int', 'int', 'int', 'int', 'float', 'int', 'int']",
    "True True True True",
    "1024 308 -1021 -307 15 53 2 1",
    "True",
    "",
  ].join("\n"));
});
