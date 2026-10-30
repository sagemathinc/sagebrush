import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// int's, float's and str's methods and getsets read through a subclass are
// the base's own objects (J.__repr__ is int.__repr__), and take subclass
// instances as arguments when called explicitly, as in CPython.
const CASES = __dirname + "/../../test/builtin_method_identity_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("a builtin method read through a subclass is the base's own, as in CPython", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
