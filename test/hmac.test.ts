import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const CASES = __dirname + "/../../test/hmac_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("CPython's hmac.py (copied unchanged) over hashlib and _operator._compare_digest gives CPython's digests, interface and errors", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
