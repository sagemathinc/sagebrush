import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// CPython's enum.py, copied unchanged into lib/, runs on pyjs: Enum, IntEnum,
// StrEnum, Flag and IntFlag (with their boundaries), auto, unique, verify,
// member/nonmember, the functional API, pickling and the errors print what
// CPython's do.
const CASES = __dirname + "/../../test/enum_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("CPython's enum.py behaves as in CPython", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
