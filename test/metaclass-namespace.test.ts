import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The namespace a class body runs in is the one its metaclass is given,
// not a copy: a function metaclass, a type subclass and __classdict__,
// compared with CPython 3.14 (test/metaclass_namespace_cases.py)
const TEST = __dirname + "/../../test/";
test("a metaclass is given the class body's own namespace, as CPython's", () => {
  const name = "metaclass_namespace_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
