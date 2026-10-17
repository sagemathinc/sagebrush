import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// list(x)'s length hint (CPython's PyObject_LengthHint in list_extend),
// asked after x's iterator, with its errors; tuple(x) asks none. Compared
// with CPython 3.14.
const CASES = __dirname + "/../../test/list_length_hint_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("list() asks the length hint as CPython does, tuple() does not", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
