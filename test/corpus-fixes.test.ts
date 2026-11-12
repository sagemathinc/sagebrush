import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Wrong answers found by replaying the Python Tutorial against CPython 3.14,
// fixed and compared with CPython line by line:
// - exception_group_cases.py: ExceptionGroup and BaseExceptionGroup;
// - docstring_clean_cases.py: docstrings cleaned as the 3.13+ compiler does;
// - text_file_repr_cases.py: a text file's repr names its encoding.
const TEST = __dirname + "/../../test/";
for (const name of ["exception_group_cases.py", "docstring_clean_cases.py", "text_file_repr_cases.py"]) {
  test(`as CPython's: ${name}`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}
