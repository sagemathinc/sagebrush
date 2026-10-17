import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// types.GenericAlias, compared with CPython 3.14 (test/generic_alias_cases.py):
// list[int] and the other builtin generics, their repr, __origin__, __args__
// and __parameters__, equality, hash, calls, pickling, the isinstance errors,
// and "type 'int' is not subscriptable" for a type that is not generic.
const TEST = __dirname + "/../../test/";
test("generic alias: CPython's types.GenericAlias", () => {
  const name = "generic_alias_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
