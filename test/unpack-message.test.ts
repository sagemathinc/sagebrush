import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Unpacking's errors as CPython's: what CPython prints for test/unpack_cases.py
// (a non-iterable is "cannot unpack non-iterable X object", CPython's unpack_iterable).
const TEST = __dirname + "/../../test/";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("unpacking a non-iterable: CPython's message, in a, b = x, starred targets, for targets and nested ones", () => {
  const want = execFileSync("python3", [TEST + "unpack_cases.py"], { encoding: "utf8" });
  assert.equal(cli([TEST + "unpack_cases.py"]), want);
});
