import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A class as a container or a truth value: its metaclass's __iter__,
// __getitem__, __len__, __contains__, __reversed__ and __bool__ (classes are
// functions here, and iteration and truth used to skip them).
const CASES = __dirname + "/../../test/metaclass_protocols_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("a metaclass's container and truth methods apply to its classes, as in CPython", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
