import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// int(), float() and complex() of a str read Unicode decimal digits and
// whitespace as CPython 3.14 does (test/unicode_digits_cases.py)
const TEST = __dirname + "/../../test/";
test("int(), float() and complex() of Unicode digits and whitespace: CPython's results", () => {
  const name = "unicode_digits_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
