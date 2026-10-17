import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Builtins' argument checks and formatting, compared with CPython 3.14
// (test/builtin_args_cases.py): @sagebrush-astra3's sweep A01-A14 and the
// inputs around each.
const TEST = __dirname + "/../../test/";
test("builtin argument checks: CPython 3.14's (astra3 sweep A01-A14)", () => {
  const name = "builtin_args_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
