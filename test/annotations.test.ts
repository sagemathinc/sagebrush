import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Lazy annotations (PEP 649/749), compared with CPython 3.14
// (test/annotations_cases.py): functions', classes' and modules'
// __annotate__ and __annotations__, their evaluation when first read, the
// conditional ones, and the errors.
const TEST = __dirname + "/../../test/";
test("annotations: CPython's __annotate__ and __annotations__", () => {
  const name = "annotations_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
