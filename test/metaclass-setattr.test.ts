import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A metaclass's __setattr__ and __delattr__ for its classes (setattr,
// delattr, statements, augmented assignment), type's and object's own
// called directly, compared with CPython 3.14 (test/metaclass_setattr_cases.py)
const TEST = __dirname + "/../../test/";
test("a metaclass's __setattr__ and __delattr__ as CPython's", () => {
  const name = "metaclass_setattr_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
