import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// astra3's sweep A15-A21 (and A29, A30), compared with CPython 3.14
// (test/collections_fixes_cases.py)
const TEST = __dirname + "/../../test/";
for (const name of ["collections_fixes_cases.py"]) {
  test(`collections and sequences as CPython's: ${name}`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}
