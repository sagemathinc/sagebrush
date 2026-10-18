import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// reversed() as CPython 3.14's (test/reversed_cases.py)
const TEST = __dirname + "/../../test/";
test("reversed() as CPython's reversed_next and reversed_len", () => {
  const name = "reversed_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
