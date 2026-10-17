import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// str() and str.__str__ of a str subclass, compared with CPython 3.14
// (test/str_subclass_cases.py): an exact str copy from str's own __str__,
// the instance an overriding __str__ returns, a subclass's included
const TEST = __dirname + "/../../test/";
test("str() and str.__str__ of str subclasses: CPython's results", () => {
  const name = "str_subclass_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
