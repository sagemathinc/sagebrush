import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// astra3's A27, A28, A31, A32 and map's strict, compared with CPython 3.14
// (test/iter_fixes_cases.py)
const TEST = __dirname + "/../../test/";
test("iterators as CPython's: itertools constructors, deque iteration and searches, min and max, map strict (iter_fixes_cases.py)", () => {
  const name = "iter_fixes_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
