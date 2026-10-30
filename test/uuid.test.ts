import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// CPython's uuid.py, copied unchanged into lib/, runs on pyjs (over enum and
// hashlib): parsing, fields, uuid3/uuid5/uuid8 values, the random and
// time-based versions' properties, comparison, pickling and the errors print
// what CPython's do.
const CASES = __dirname + "/../../test/uuid_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("CPython's uuid.py behaves as in CPython", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
