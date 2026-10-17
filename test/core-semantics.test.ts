import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// sage2's core-semantics findings, compared with CPython 3.14: a str
// subclass through str's own methods and as a dict key, __slots__ without
// a __dict__, pickles of methods, builtins, method descriptors and
// datetime's types byte for byte, the 3.14 messages, OSError's subclass
// by errno (test/core_*_cases.py)
const TEST = __dirname + "/../../test/";
for (const name of ["core_semantics_cases.py", "core_datetime_cases.py", "core_oserror_cases.py"]) {
  test(`core semantics as CPython's: ${name}`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}
