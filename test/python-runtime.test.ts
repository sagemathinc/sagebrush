import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// print to a replaced sys.stdout, sum's compensated float and complex
// paths, round() of int and float subclasses, and math.gamma/lgamma as
// CPython computes them: test/python_runtime_cases.py prints the same under
// Sagebrush as under CPython (gamma of negative x, where CPython's sin and
// cos are glibc's, is not in it: there Sagebrush's may differ in the last
// digit).
const CASES = __dirname + "/../../test/python_runtime_cases.py";

test("print, sum, round and math.gamma as CPython", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", CASES], { encoding: "utf8" });
  assert.equal(got, want);
});
