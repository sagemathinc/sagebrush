import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The runtime differences from CPython 3.14 that html's and importlib's
// cases found (S1 of the stdlib the curated PyPI packages need), compared
// with CPython: unpacking's count, `in` without __contains__, slice indices
// (_PyEval_SliceIndex) in slicing and in str's and bytes' find, count,
// index, startswith and endswith, re's subject (a str subclass by its
// payload), ImportError's keywords and attributes, keywords to an
// exception's constructor, and None in sys.modules.
const TEST = __dirname + "/../../test/";
test("runtime_s1_cases.py: CPython's output", () => {
  const want = execFileSync("python3", [TEST + "runtime_s1_cases.py"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "runtime_s1_cases.py"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `runtime_s1_cases.py line ${i + 1}`);
});
