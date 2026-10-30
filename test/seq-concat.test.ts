import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A sequence that can't add the other operand refuses in CPython's words,
// as PyNumber_Add's sequence concat does: str, list and tuple "can only
// concatenate", bytes and bytearray "can't concat", array "can only
// append"; a subclass with its own __add__, a right operand's __radd__, +=
// and every other pairing as in CPython.
const CASES = __dirname + "/../../test/seq_concat_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("a sequence's concat refuses as CPython's does", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
