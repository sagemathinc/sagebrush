import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const CASES = __dirname + "/../../test/bytes_translate_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("bytes and bytearray's translate and maketrans are CPython's", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
